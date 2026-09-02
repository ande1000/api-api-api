const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const webpush = require('web-push');
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

// Chaves para notificação push (permitem notificar mesmo com o app fechado/tela apagada).
// Em produção, o ideal é gerar seu próprio par e colocar nas variáveis de ambiente
// VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY (rode: npx web-push generate-vapid-keys).
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BB_vj2hyVfz0fdnymbv9cWbVf5oJmm7uEaVQz8-ZXy8kLJ11z8qX5zWQbAq5BqAve1kRKg-Kc3pJ34aMocCxO2g';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'J8ioJc-NL9r0sSCWplbz7KC6pE02L3zPYWOPyUUSYws';
webpush.setVapidDetails('mailto:contato@whatswebapp.exemplo', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

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
    avatar TEXT,
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

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    username TEXT PRIMARY KEY,
    subscription TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Se o banco já existia de uma versão anterior (sem a coluna avatar), adiciona agora.
try {
  db.exec(`ALTER TABLE users ADD COLUMN avatar TEXT`);
} catch (err) {
  // Coluna já existe — tudo bem, ignora.
}

const insertUser = db.prepare(`INSERT INTO users (username, password_hash, avatar) VALUES (?, ?, ?)`);
const findUser = db.prepare(`SELECT * FROM users WHERE username = ?`);
const updateAvatar = db.prepare(`UPDATE users SET avatar = ? WHERE username = ?`);

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
const deleteConversation = db.prepare(`
  DELETE FROM messages
  WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
`);

const savePushSubscription = db.prepare(`
  INSERT INTO push_subscriptions (username, subscription, updated_at)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(username) DO UPDATE SET subscription = excluded.subscription, updated_at = datetime('now')
`);
const getPushSubscription = db.prepare(`SELECT subscription FROM push_subscriptions WHERE username = ?`);
const deletePushSubscription = db.prepare(`DELETE FROM push_subscriptions WHERE username = ?`);

// Envia uma notificação push para um usuário, se ele tiver se inscrito.
// Isso funciona mesmo com o app fechado ou a tela do celular apagada.
async function sendPushToUser(username, payload) {
  const row = getPushSubscription.get(username);
  if (!row) return;
  try {
    const subscription = JSON.parse(row.subscription);
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (err) {
    // Inscrição expirada ou inválida — remove para não tentar de novo à toa.
    if (err.statusCode === 404 || err.statusCode === 410) {
      deletePushSubscription.run(username);
    } else {
      console.error('Erro ao enviar push para', username, err.message);
    }
  }
}

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
  const avatar = typeof req.body.avatar === 'string' ? req.body.avatar : null;
  if (!username) {
    return res.status(400).json({ error: 'Informe um nome de usuário' });
  }
  if (findUser.get(username)) {
    return res.status(409).json({ error: 'Esse nome de usuário já está em uso' });
  }

  // Senha aleatória interna só para satisfazer o banco — o usuário nunca a vê nem a usa.
  const randomPassword = Math.random().toString(36).slice(2) + Date.now();
  const passwordHash = bcrypt.hashSync(randomPassword, 10);
  insertUser.run(username, passwordHash, avatar);

  const token = createToken(username);
  res.status(201).json({ token, username, avatar });
});

// Verifica se um nome de usuário já existe no servidor — usado para validar
// contatos antes de salvar (evita adicionar alguém que nunca criou conta).
app.get('/api/exists/:username', (req, res) => {
  const username = normalizeUsername(req.params.username);
  const user = findUser.get(username);
  res.json({ exists: !!user });
});

// Devolve os dados públicos de um usuário: nome, foto de perfil e se está online agora.
// Usado para mostrar a foto/status na lista de contatos e no topo da conversa.
app.get('/api/user/:username', (req, res) => {
  const username = normalizeUsername(req.params.username);
  const user = findUser.get(username);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json({
    username: user.username,
    avatar: user.avatar || null,
    online: onlineUsers.has(username),
  });
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
  } else {
    // Ninguém com o app aberto agora — tenta acordar via notificação push,
    // que funciona mesmo com o app fechado ou a tela apagada.
    sendPushToUser(to, {
      type: 'message',
      title: from,
      body: content.startsWith('data:image') ? '📷 Foto' : content,
    });
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
  io.emit('presence', { username, online: true });

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
      io.emit('presence', { username, online: false });
    }
  });

  // --- Sinalização de chamada de voz (WebRTC) ---
  // O servidor só repassa as mensagens entre os dois usuários; o áudio em si
  // não passa por aqui, vai direto de um aparelho para o outro.
  function relayToUser(event, to, payload) {
    const targetSocketId = onlineUsers.get(normalizeUsername(to));
    if (targetSocketId) {
      io.to(targetSocketId).emit(event, { from: username, ...payload });
    } else {
      socket.emit('call:unavailable', { to: normalizeUsername(to) });
    }
  }

  socket.on('call:offer', ({ to, offer }) => {
    relayToUser('call:offer', to, { offer });
    // Se a pessoa não estiver com o app aberto, manda notificação push também.
    if (!onlineUsers.has(normalizeUsername(to))) {
      sendPushToUser(normalizeUsername(to), {
        type: 'call',
        title: username,
        body: 'Chamada de voz recebida',
      });
    }
  });
  socket.on('call:answer', ({ to, answer }) => relayToUser('call:answer', to, { answer }));
  socket.on('call:ice-candidate', ({ to, candidate }) => relayToUser('call:ice-candidate', to, { candidate }));
  socket.on('call:end', ({ to }) => relayToUser('call:end', to, {}));
  socket.on('call:reject', ({ to }) => relayToUser('call:reject', to, {}));

  // --- "Digitando..." em tempo real ---
  socket.on('typing', ({ to, isTyping }) => relayToUser('typing', to, { isTyping: !!isTyping }));
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

// Apaga o histórico de conversa com um contato (para os dois lados)
app.delete('/messages/:otherUser', requireAuth, (req, res) => {
  const otherUser = normalizeUsername(req.params.otherUser);
  deleteConversation.run(req.username, otherUser, otherUser, req.username);
  res.json({ ok: true });
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

// Chave pública usada pelo navegador para se inscrever nas notificações push
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// Salva a inscrição push do usuário logado (chamado pelo navegador dele)
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: 'Inscrição não enviada' });
  savePushSubscription.run(req.username, JSON.stringify(subscription));
  res.json({ ok: true });
});

// Remove a inscrição push do usuário logado (ex: ao sair da conta)
app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  deletePushSubscription.run(req.username);
  res.json({ ok: true });
});

// Qualquer rota que não seja da API cai na tela principal do whats web app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'whatsweb.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`API de mensagens rodando em http://localhost:${PORT}`);
});
