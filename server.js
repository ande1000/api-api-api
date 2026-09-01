const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// Em produção, defina a variável de ambiente JWT_SECRET com um valor único e secreto.
const JWT_SECRET = process.env.JWT_SECRET || 'troque-esse-segredo-em-producao';

// ---------------------------------------------------------------------------
// Banco de dados (SQLite em arquivo)
// ---------------------------------------------------------------------------
const dbPath = process.env.DB_PATH || path.join(__dirname, 'messages.db');
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    content TEXT NOT NULL,
    delivered INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

const insertUser = db.prepare(`INSERT INTO users (username, password_hash) VALUES (?, ?)`);
const findUser = db.prepare(`SELECT * FROM users WHERE username = ?`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_user, to_user, content, delivered)
  VALUES (?, ?, ?, ?)
`);
const markDelivered = db.prepare(`UPDATE messages SET delivered = 1 WHERE id = ?`);
const getHistory = db.prepare(`
  SELECT * FROM messages
  WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
  ORDER BY created_at ASC
`);
const getPending = db.prepare(`
  SELECT * FROM messages WHERE to_user = ? AND delivered = 0 ORDER BY created_at ASC
`);
const getConversationPartners = db.prepare(`
  SELECT DISTINCT CASE WHEN from_user = ? THEN to_user ELSE from_user END AS other_user
  FROM messages
  WHERE from_user = ? OR to_user = ?
`);

// ---------------------------------------------------------------------------
// Autenticação
// ---------------------------------------------------------------------------

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function createToken(username) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
}

// Middleware que exige um token válido (Authorization: Bearer <token>)
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.username = payload.username;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

// Cadastro: POST /api/register  { username, password }
app.post('/api/register', (req, res) => {
  const username = normalizeUsername(req.body.username);
  const { password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'A senha precisa ter pelo menos 4 caracteres' });
  }
  if (findUser.get(username)) {
    return res.status(409).json({ error: 'Esse nome de usuário já está em uso' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  insertUser.run(username, passwordHash);

  const token = createToken(username);
  res.status(201).json({ token, username });
});

// Cria um usuário simples, só com nome (sem senha) — usado pelo app "whats web app".
// Como não há senha, o app.get('/api/login') não deve ser usado com essas contas
// (não há como logar de novo num outro aparelho digitando a senha).
app.post('/api/claim', (req, res) => {
  const username = normalizeUsername(req.body.username);
  if (!username) {
    return res.status(400).json({ error: 'Informe um nome de usuário' });
  }
  if (findUser.get(username)) {
    return res.status(409).json({ error: 'Esse nome de usuário já está em uso' });
  }

  // Senha aleatória interna só para satisfazer o banco — o usuário nunca a vê nem a usa.
  const randomPassword = Math.random().toString(36).slice(2) + Date.now();
  const passwordHash = bcrypt.hashSync(randomPassword, 10);
  insertUser.run(username, passwordHash);

  const token = createToken(username);
  res.status(201).json({ token, username });
});

// Verifica se um nome de usuário já existe no servidor — usado para validar
// contatos antes de salvar (evita adicionar alguém que nunca criou conta).
app.get('/api/exists/:username', (req, res) => {
  const username = normalizeUsername(req.params.username);
  const user = findUser.get(username);
  res.json({ exists: !!user });
});

// Login: POST /api/login  { username, password }
app.post('/api/login', (req, res) => {
  const username = normalizeUsername(req.body.username);
  const { password } = req.body;

  const user = findUser.get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  }

  const token = createToken(username);
  res.json({ token, username });
});

// ---------------------------------------------------------------------------
// Usuários conectados agora (nome de usuário -> socket.id)
// ---------------------------------------------------------------------------
const onlineUsers = new Map();

function deliverMessage(from, to, content) {
  const targetSocketId = onlineUsers.get(to);
  const delivered = !!targetSocketId;

  const result = insertMessage.run(from, to, content, delivered ? 1 : 0);
  const message = {
    id: result.lastInsertRowid,
    from_user: from,
    to_user: to,
    content,
    delivered: delivered ? 1 : 0,
  };

  if (delivered) {
    io.to(targetSocketId).emit('message', message);
  }

  return message;
}

// ---------------------------------------------------------------------------
// WebSocket (Socket.IO) — autenticado por token, não confia em nome enviado à toa
// ---------------------------------------------------------------------------
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Token não fornecido'));

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.username = payload.username;
    next();
  } catch (err) {
    next(new Error('Token inválido'));
  }
});

io.on('connection', (socket) => {
  const username = socket.username;
  onlineUsers.set(username, socket.id);
  console.log(`[online] ${username}`);

  // Entrega mensagens que chegaram enquanto o usuário estava offline
  const pending = getPending.all(username);
  pending.forEach((msg) => {
    socket.emit('message', msg);
    markDelivered.run(msg.id);
  });

  // Envio de mensagem pelo WebSocket
  socket.on('sendMessage', ({ to, content }) => {
    const toNormalized = normalizeUsername(to);
    if (!toNormalized || !content) return;
    deliverMessage(username, toNormalized, content);
  });

  socket.on('disconnect', () => {
    if (onlineUsers.get(username) === socket.id) {
      onlineUsers.delete(username);
      console.log(`[offline] ${username}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Rotas REST protegidas (exigem token de login)
// ---------------------------------------------------------------------------

// Envia uma mensagem: POST /messages  { to, content }
// O remetente (from) vem do token, não do que o cliente mandar — evita falsificação.
app.post('/messages', requireAuth, (req, res) => {
  const to = normalizeUsername(req.body.to);
  const { content } = req.body;
  if (!to || !content) {
    return res.status(400).json({ error: 'Campos obrigatórios: to, content' });
  }
  const message = deliverMessage(req.username, to, content);
  res.status(201).json(message);
});

// Histórico de conversa com outro usuário: GET /messages/:otherUser
app.get('/messages/:otherUser', requireAuth, (req, res) => {
  const otherUser = normalizeUsername(req.params.otherUser);
  const history = getHistory.all(req.username, otherUser, otherUser, req.username);
  res.json(history);
});

// Lista de conversas do usuário logado: GET /conversations
app.get('/conversations', requireAuth, (req, res) => {
  const partners = getConversationPartners.all(req.username, req.username, req.username);
  res.json(partners.map((p) => p.other_user));
});

// Lista quem está online agora: GET /online
app.get('/online', (req, res) => {
  res.json(Array.from(onlineUsers.keys()));
});

// Qualquer rota que não seja da API cai na tela principal do whats web app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'whatsweb.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`API de mensagens rodando em http://localhost:${PORT}`);
});
