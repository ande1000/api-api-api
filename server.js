const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const webpush = require('web-push');
const path = require('path');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  // Vídeos e arquivos viajam como base64 dentro da mensagem, então o buffer
  // padrão do Socket.IO (1MB) é pequeno demais. 25MB dá uma folga razoável.
  maxHttpBufferSize: 25 * 1024 * 1024,
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
// Banco de dados
// ---------------------------------------------------------------------------
// Se as variáveis TURSO_DATABASE_URL e TURSO_AUTH_TOKEN estiverem definidas
// (configuradas no painel do Render, por exemplo), o app usa o banco remoto
// do Turso — que não é apagado quando o servidor reinicia ou faz redeploy.
// Sem essas variáveis (ex: rodando no seu computador pra testar), ele cai de
// volta num arquivo SQLite local, só pra não travar o desenvolvimento.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'messages.db');
const usingTurso = !!process.env.TURSO_DATABASE_URL;
const db = createClient({
  url: usingTurso ? process.env.TURSO_DATABASE_URL : `file:${dbPath}`,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
console.log(usingTurso ? '[banco] Usando Turso (remoto, persistente)' : '[banco] Usando arquivo local (' + dbPath + ')');

// ---------------------------------------------------------------------------
// Helpers para falar com o banco (o @libsql/client é assíncrono)
// ---------------------------------------------------------------------------
async function dbRun(sql, args = []) {
  const result = await db.execute({ sql, args });
  return {
    lastInsertRowid: result.lastInsertRowid !== undefined ? Number(result.lastInsertRowid) : null,
    changes: result.rowsAffected,
  };
}
async function dbGet(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows[0];
}
async function dbAll(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows;
}

// Envolve uma rota assíncrona do Express, capturando erros e respondendo 500
// em vez de deixar a promessa quebrada travar a requisição sem resposta.
function asyncRoute(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('Erro na rota', req.method, req.path, err);
      if (!res.headersSent) res.status(500).json({ error: 'Erro interno do servidor' });
    });
  };
}

async function initDb() {
  await db.executeMultiple(`
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

    CREATE TABLE IF NOT EXISTS user_settings (
      username TEXT PRIMARY KEY,
      welcome_enabled INTEGER DEFAULT 0,
      welcome_message TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS blocked_users (
      blocker TEXT NOT NULL,
      blocked TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (blocker, blocked)
    );

    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user TEXT NOT NULL,
      to_user TEXT NOT NULL,
      content TEXT NOT NULL,
      send_at TEXT NOT NULL,
      sent INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Se o banco já existia de uma versão anterior (sem essas colunas), adiciona agora.
  const alters = [
    `ALTER TABLE users ADD COLUMN avatar TEXT`,
    `ALTER TABLE user_settings ADD COLUMN note TEXT DEFAULT ''`,
    `ALTER TABLE user_settings ADD COLUMN pix_key TEXT DEFAULT ''`,
  ];
  for (const sql of alters) {
    try {
      await db.execute(sql);
    } catch (err) {
      // Coluna já existe — tudo bem, ignora.
    }
  }
}

// Envia uma notificação push para um usuário, se ele tiver se inscrito.
// Isso funciona mesmo com o app fechado ou a tela do celular apagada.
async function sendPushToUser(username, payload) {
  const row = await dbGet('SELECT subscription FROM push_subscriptions WHERE username = ?', [username]);
  if (!row) return;
  try {
    const subscription = JSON.parse(row.subscription);
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (err) {
    // Inscrição expirada ou inválida — remove para não tentar de novo à toa.
    if (err.statusCode === 404 || err.statusCode === 410) {
      await dbRun('DELETE FROM push_subscriptions WHERE username = ?', [username]);
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
app.post('/api/register', asyncRoute(async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const { password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'A senha precisa ter pelo menos 4 caracteres' });
  }
  if (await dbGet('SELECT * FROM users WHERE username = ?', [username])) {
    return res.status(409).json({ error: 'Esse nome de usuário já está em uso' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  try {
    await dbRun('INSERT INTO users (username, password_hash, avatar) VALUES (?, ?, ?)', [username, passwordHash, null]);
  } catch (err) {
    // Corrida rara: outro pedido criou o mesmo usuário entre o SELECT e o INSERT acima.
    return res.status(409).json({ error: 'Esse nome de usuário já está em uso' });
  }

  const token = createToken(username);
  res.status(201).json({ token, username });
}));

// Cria um usuário simples, só com nome (sem senha) — usado pelo app "whats web app".
// Como não há senha, o app.get('/api/login') não deve ser usado com essas contas
// (não há como logar de novo num outro aparelho digitando a senha).
app.post('/api/claim', asyncRoute(async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const avatar = typeof req.body.avatar === 'string' ? req.body.avatar : null;
  if (!username) {
    return res.status(400).json({ error: 'Informe um nome de usuário' });
  }
  if (await dbGet('SELECT * FROM users WHERE username = ?', [username])) {
    return res.status(409).json({ error: 'Esse nome de usuário já está em uso' });
  }

  // Senha aleatória interna só para satisfazer o banco — o usuário nunca a vê nem a usa.
  const randomPassword = Math.random().toString(36).slice(2) + Date.now();
  const passwordHash = bcrypt.hashSync(randomPassword, 10);
  try {
    await dbRun('INSERT INTO users (username, password_hash, avatar) VALUES (?, ?, ?)', [username, passwordHash, avatar]);
  } catch (err) {
    // Corrida rara: outro pedido criou o mesmo usuário entre o SELECT e o INSERT acima.
    return res.status(409).json({ error: 'Esse nome de usuário já está em uso' });
  }

  const token = createToken(username);
  res.status(201).json({ token, username, avatar });
}));

// Verifica se um nome de usuário já existe no servidor — usado para validar
// contatos antes de salvar (evita adicionar alguém que nunca criou conta).
app.get('/api/exists/:username', asyncRoute(async (req, res) => {
  const username = normalizeUsername(req.params.username);
  const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
  res.json({ exists: !!user });
}));

// Devolve os dados públicos de um usuário: nome, foto de perfil e se está online agora.
// Usado para mostrar a foto/status na lista de contatos e no topo da conversa.
// Se vier um token junto (opcional), também informa se VOCÊ bloqueou essa pessoa.
app.get('/api/user/:username', asyncRoute(async (req, res) => {
  const username = normalizeUsername(req.params.username);
  const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

  let blockedByMe = false;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      blockedByMe = !!(await dbGet('SELECT 1 FROM blocked_users WHERE blocker = ? AND blocked = ?', [payload.username, username]));
    } catch (err) { /* token inválido, apenas ignora o campo blockedByMe */ }
  }

  res.json({
    username: user.username,
    avatar: user.avatar || null,
    online: onlineUsers.has(username),
    blockedByMe,
    createdAt: user.created_at || null,
  });
}));

// Edita o próprio perfil (foto e/ou nome de usuário). Exige estar logado.
// Se o nome de usuário mudar, um novo token é devolvido (o antigo passa a
// não corresponder a ninguém, já que o nome dele não existe mais).
app.post('/api/profile', requireAuth, asyncRoute(async (req, res) => {
  const currentUsername = req.username;
  let finalUsername = currentUsername;

  if (req.body.username !== undefined) {
    const newUsername = normalizeUsername(req.body.username);
    if (!newUsername) {
      return res.status(400).json({ error: 'Nome de usuário inválido' });
    }
    if (newUsername !== currentUsername) {
      if (await dbGet('SELECT * FROM users WHERE username = ?', [newUsername])) {
        return res.status(409).json({ error: 'Esse nome de usuário já está em uso' });
      }
      await dbRun('UPDATE users SET username = ? WHERE username = ?', [newUsername, currentUsername]);
      await dbRun('UPDATE messages SET from_user = ? WHERE from_user = ?', [newUsername, currentUsername]);
      await dbRun('UPDATE messages SET to_user = ? WHERE to_user = ?', [newUsername, currentUsername]);
      await dbRun('UPDATE push_subscriptions SET username = ? WHERE username = ?', [newUsername, currentUsername]);
      finalUsername = newUsername;

      // Se essa pessoa estiver com o app aberto agora, atualiza o registro de quem está online
      if (onlineUsers.has(currentUsername)) {
        const socketId = onlineUsers.get(currentUsername);
        onlineUsers.delete(currentUsername);
        onlineUsers.set(finalUsername, socketId);
      }
    }
  }

  if (typeof req.body.avatar === 'string') {
    await dbRun('UPDATE users SET avatar = ? WHERE username = ?', [req.body.avatar, finalUsername]);
  }

  const updatedUser = await dbGet('SELECT * FROM users WHERE username = ?', [finalUsername]);
  const token = createToken(finalUsername);
  res.json({ token, username: finalUsername, avatar: updatedUser ? updatedUser.avatar : null });
}));

// Login: POST /api/login  { username, password }
app.post('/api/login', asyncRoute(async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const { password } = req.body;

  const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  }

  const token = createToken(username);
  res.json({ token, username });
}));

// ---------------------------------------------------------------------------
// Usuários conectados agora (nome de usuário -> socket.id)
// ---------------------------------------------------------------------------
const onlineUsers = new Map();

async function deliverMessage(from, to, content) {
  // Se o destinatário bloqueou quem está enviando, a mensagem nem chega a ser salva.
  if (await dbGet('SELECT 1 FROM blocked_users WHERE blocker = ? AND blocked = ?', [to, from])) {
    return null;
  }

  // Antes de inserir, verifica se essa é a primeira mensagem entre os dois
  // (para decidir se deve disparar a mensagem de boas-vindas do destinatário).
  const countRow = await dbGet(
    `SELECT COUNT(*) AS total FROM messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)`,
    [from, to, to, from]
  );
  const isFirstMessage = Number(countRow.total) === 0;

  const targetSocketId = onlineUsers.get(to);
  const delivered = !!targetSocketId;

  const result = await dbRun(
    'INSERT INTO messages (from_user, to_user, content, delivered) VALUES (?, ?, ?, ?)',
    [from, to, content, delivered ? 1 : 0]
  );
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
      body: content.startsWith('data:image')
        ? '📷 Foto'
        : content.startsWith('data:audio')
        ? '🎤 Áudio'
        : (content.startsWith('data:') && content.includes('#filename='))
        ? '📄 Documento'
        : content,
    }).catch((err) => console.error('Erro ao enviar push:', err));
  }

  // Mensagem de boas-vindas automática (só na primeira mensagem que a pessoa recebe de alguém)
  if (isFirstMessage) {
    const settings = await dbGet('SELECT * FROM user_settings WHERE username = ?', [to]);
    if (settings && settings.welcome_enabled && settings.welcome_message) {
      await deliverMessage(to, from, settings.welcome_message);
    }
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
  (async () => {
    try {
      const pending = await dbAll('SELECT * FROM messages WHERE to_user = ? AND delivered = 0 ORDER BY created_at ASC', [username]);
      for (const msg of pending) {
        socket.emit('message', msg);
        await dbRun('UPDATE messages SET delivered = 1 WHERE id = ?', [msg.id]);
      }
    } catch (err) {
      console.error('Erro ao entregar mensagens pendentes:', err);
    }
  })();

  // Envio de mensagem pelo WebSocket
  socket.on('sendMessage', ({ to, content }) => {
    const toNormalized = normalizeUsername(to);
    if (!toNormalized || !content) return;
    deliverMessage(username, toNormalized, content).catch((err) => console.error('Erro ao entregar mensagem:', err));
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

  socket.on('call:offer', ({ to, offer, callType }) => {
    relayToUser('call:offer', to, { offer, callType });
    // Se a pessoa não estiver com o app aberto, manda notificação push também.
    if (!onlineUsers.has(normalizeUsername(to))) {
      sendPushToUser(normalizeUsername(to), {
        type: 'call',
        title: username,
        body: callType === 'video' ? 'Chamada de vídeo recebida' : 'Chamada de voz recebida',
      }).catch((err) => console.error('Erro ao enviar push:', err));
    }
  });
  socket.on('call:answer', ({ to, answer }) => relayToUser('call:answer', to, { answer }));
  socket.on('call:ice-candidate', ({ to, candidate }) => relayToUser('call:ice-candidate', to, { candidate }));
  socket.on('call:end', ({ to }) => relayToUser('call:end', to, {}));
  socket.on('call:reject', ({ to }) => relayToUser('call:reject', to, {}));

  // --- "Digitando..." em tempo real ---
  socket.on('typing', ({ to, isTyping }) => relayToUser('typing', to, { isTyping: !!isTyping }));

  // --- "Gravando áudio..." em tempo real ---
  socket.on('recording', ({ to, isRecording }) => relayToUser('recording', to, { isRecording: !!isRecording }));
});

// ---------------------------------------------------------------------------
// Rotas REST protegidas (exigem token de login)
// ---------------------------------------------------------------------------

// Envia uma mensagem: POST /messages  { to, content }
// O remetente (from) vem do token, não do que o cliente mandar — evita falsificação.
app.post('/messages', requireAuth, asyncRoute(async (req, res) => {
  const to = normalizeUsername(req.body.to);
  const { content } = req.body;
  if (!to || !content) {
    return res.status(400).json({ error: 'Campos obrigatórios: to, content' });
  }
  const message = await deliverMessage(req.username, to, content);
  if (!message) {
    return res.status(403).json({ error: 'Não foi possível entregar a mensagem' });
  }
  res.status(201).json(message);
}));

// Histórico de conversa com outro usuário: GET /messages/:otherUser
app.get('/messages/:otherUser', requireAuth, asyncRoute(async (req, res) => {
  const otherUser = normalizeUsername(req.params.otherUser);
  const history = await dbAll(
    `SELECT * FROM messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY created_at ASC`,
    [req.username, otherUser, otherUser, req.username]
  );
  res.json(history);
}));

// Apaga o histórico de conversa com um contato (para os dois lados)
app.delete('/messages/:otherUser', requireAuth, asyncRoute(async (req, res) => {
  const otherUser = normalizeUsername(req.params.otherUser);
  await dbRun(
    `DELETE FROM messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)`,
    [req.username, otherUser, otherUser, req.username]
  );
  res.json({ ok: true });
}));

// Lista de conversas do usuário logado: GET /conversations
app.get('/conversations', requireAuth, asyncRoute(async (req, res) => {
  const partners = await dbAll(
    `SELECT DISTINCT CASE WHEN from_user = ? THEN to_user ELSE from_user END AS other_user
     FROM messages WHERE from_user = ? OR to_user = ?`,
    [req.username, req.username, req.username]
  );
  res.json(partners.map((p) => p.other_user));
}));

// Lista quem está online agora: GET /online
app.get('/online', (req, res) => {
  res.json(Array.from(onlineUsers.keys()));
});

// Chave pública usada pelo navegador para se inscrever nas notificações push
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// Salva a inscrição push do usuário logado (chamado pelo navegador dele)
app.post('/api/push/subscribe', requireAuth, asyncRoute(async (req, res) => {
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: 'Inscrição não enviada' });
  await dbRun(
    `INSERT INTO push_subscriptions (username, subscription, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(username) DO UPDATE SET subscription = excluded.subscription, updated_at = datetime('now')`,
    [req.username, JSON.stringify(subscription)]
  );
  res.json({ ok: true });
}));

// Remove a inscrição push do usuário logado (ex: ao sair da conta)
app.post('/api/push/unsubscribe', requireAuth, asyncRoute(async (req, res) => {
  await dbRun('DELETE FROM push_subscriptions WHERE username = ?', [req.username]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Bloqueio de usuários
// ---------------------------------------------------------------------------

// Bloqueia um usuário permanentemente (você não pode mais adicioná-lo, e
// mensagens que ele mandar pra você deixam de ser entregues).
app.post('/api/block', requireAuth, asyncRoute(async (req, res) => {
  const target = normalizeUsername(req.body.username);
  if (!target) return res.status(400).json({ error: 'Informe um nome de usuário' });
  if (target === req.username) return res.status(400).json({ error: 'Você não pode bloquear a si mesmo' });
  await dbRun('INSERT OR IGNORE INTO blocked_users (blocker, blocked) VALUES (?, ?)', [req.username, target]);
  res.json({ ok: true });
}));

// Lista quem você já bloqueou
app.get('/api/blocked', requireAuth, asyncRoute(async (req, res) => {
  const rows = await dbAll('SELECT blocked FROM blocked_users WHERE blocker = ? ORDER BY created_at DESC', [req.username]);
  res.json(rows.map((r) => r.blocked));
}));

// ---------------------------------------------------------------------------
// Configurações do usuário: boas-vindas, bloco de nota, chave pix
// ---------------------------------------------------------------------------

app.get('/api/settings', requireAuth, asyncRoute(async (req, res) => {
  const settings = await dbGet('SELECT * FROM user_settings WHERE username = ?', [req.username]);
  res.json({
    welcomeEnabled: settings ? !!settings.welcome_enabled : false,
    welcomeMessage: settings ? settings.welcome_message : '',
    note: settings ? settings.note || '' : '',
    pixKey: settings ? settings.pix_key || '' : '',
  });
}));

// Salva só o(s) campo(s) enviado(s), mantendo os outros como estavam —
// assim cada tela (boas-vindas, bloco de nota, chave pix) pode salvar sem
// apagar o que as outras telas já tinham guardado.
app.post('/api/settings', requireAuth, asyncRoute(async (req, res) => {
  const current = (await dbGet('SELECT * FROM user_settings WHERE username = ?', [req.username])) || {
    welcome_enabled: 0,
    welcome_message: '',
    note: '',
    pix_key: '',
  };

  const welcomeEnabled = req.body.welcomeEnabled !== undefined ? (req.body.welcomeEnabled ? 1 : 0) : current.welcome_enabled;
  const welcomeMessage = req.body.welcomeMessage !== undefined ? req.body.welcomeMessage : current.welcome_message;
  const note = req.body.note !== undefined ? req.body.note : (current.note || '');
  const pixKey = req.body.pixKey !== undefined ? req.body.pixKey : (current.pix_key || '');

  await dbRun(
    `INSERT INTO user_settings (username, welcome_enabled, welcome_message, note, pix_key)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET
       welcome_enabled = excluded.welcome_enabled,
       welcome_message = excluded.welcome_message,
       note = excluded.note,
       pix_key = excluded.pix_key`,
    [req.username, welcomeEnabled, welcomeMessage, note, pixKey]
  );

  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Agendamento de mensagens
// ---------------------------------------------------------------------------

// Cria uma mensagem agendada. sendAt deve vir no formato ISO (ex: "2026-09-10T14:30")
app.post('/api/scheduled-messages', requireAuth, asyncRoute(async (req, res) => {
  const to = normalizeUsername(req.body.to);
  const { content, sendAt } = req.body;
  if (!to || !content || !sendAt) {
    return res.status(400).json({ error: 'Campos obrigatórios: to, content, sendAt' });
  }
  const sendDate = new Date(sendAt);
  if (isNaN(sendDate.getTime())) {
    return res.status(400).json({ error: 'Data/hora inválida' });
  }
  const result = await dbRun(
    'INSERT INTO scheduled_messages (from_user, to_user, content, send_at) VALUES (?, ?, ?, ?)',
    [req.username, to, content, sendDate.toISOString()]
  );
  res.status(201).json({ id: result.lastInsertRowid });
}));

// Lista suas mensagens agendadas que ainda não foram enviadas
app.get('/api/scheduled-messages', requireAuth, asyncRoute(async (req, res) => {
  const rows = await dbAll('SELECT * FROM scheduled_messages WHERE from_user = ? AND sent = 0 ORDER BY send_at ASC', [req.username]);
  res.json(rows);
}));

// Cancela uma mensagem agendada
app.delete('/api/scheduled-messages/:id', requireAuth, asyncRoute(async (req, res) => {
  await dbRun('DELETE FROM scheduled_messages WHERE id = ? AND from_user = ?', [req.params.id, req.username]);
  res.json({ ok: true });
}));

// A cada 30 segundos, verifica se alguma mensagem agendada já venceu e envia
setInterval(async () => {
  try {
    const due = await dbAll('SELECT * FROM scheduled_messages WHERE sent = 0 AND send_at <= ?', [new Date().toISOString()]);
    for (const msg of due) {
      await deliverMessage(msg.from_user, msg.to_user, msg.content);
      await dbRun('UPDATE scheduled_messages SET sent = 1 WHERE id = ?', [msg.id]);
    }
  } catch (err) {
    console.error('Erro ao processar mensagens agendadas:', err);
  }
}, 30 * 1000);

// ---------------------------------------------------------------------------
// Sobre o app
// ---------------------------------------------------------------------------
app.get('/api/about', (req, res) => {
  res.json({
    name: 'whats web app',
    version: '1.0',
    createdYear: 2026,
    createdBy: 'Eduardo Neves Costa',
  });
});

// Qualquer rota que não seja da API cai na tela principal do whats web app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'whatsweb.html'));
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`API de mensagens rodando em http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Erro ao preparar o banco de dados:', err);
    process.exit(1);
  });
