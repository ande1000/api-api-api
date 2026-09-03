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

  CREATE TABLE IF NOT EXISTS groups_table (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    avatar TEXT,
    created_by TEXT NOT NULL,
    permission TEXT DEFAULT 'participante',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    role TEXT DEFAULT 'participante',
    PRIMARY KEY (group_id, username)
  );

  CREATE TABLE IF NOT EXISTS group_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    from_user TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
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
const countMessagesBetween = db.prepare(`
  SELECT COUNT(*) AS total FROM messages
  WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
`);

const savePushSubscription = db.prepare(`
  INSERT INTO push_subscriptions (username, subscription, updated_at)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(username) DO UPDATE SET subscription = excluded.subscription, updated_at = datetime('now')
`);
const getPushSubscription = db.prepare(`SELECT subscription FROM push_subscriptions WHERE username = ?`);
const deletePushSubscription = db.prepare(`DELETE FROM push_subscriptions WHERE username = ?`);

// --- Configurações do usuário (mensagem de boas-vindas) ---
const getUserSettings = db.prepare(`SELECT * FROM user_settings WHERE username = ?`);
const upsertUserSettings = db.prepare(`
  INSERT INTO user_settings (username, welcome_enabled, welcome_message)
  VALUES (?, ?, ?)
  ON CONFLICT(username) DO UPDATE SET welcome_enabled = excluded.welcome_enabled, welcome_message = excluded.welcome_message
`);

// --- Bloqueio de usuários ---
const insertBlock = db.prepare(`INSERT OR IGNORE INTO blocked_users (blocker, blocked) VALUES (?, ?)`);
const getBlock = db.prepare(`SELECT 1 FROM blocked_users WHERE blocker = ? AND blocked = ?`);
const listBlocked = db.prepare(`SELECT blocked FROM blocked_users WHERE blocker = ? ORDER BY created_at DESC`);

// --- Mensagens agendadas ---
const insertScheduled = db.prepare(`
  INSERT INTO scheduled_messages (from_user, to_user, content, send_at) VALUES (?, ?, ?, ?)
`);
const listScheduled = db.prepare(`
  SELECT * FROM scheduled_messages WHERE from_user = ? AND sent = 0 ORDER BY send_at ASC
`);
const deleteScheduled = db.prepare(`DELETE FROM scheduled_messages WHERE id = ? AND from_user = ?`);
const getDueScheduled = db.prepare(`
  SELECT * FROM scheduled_messages WHERE sent = 0 AND send_at <= ?
`);
const markScheduledSent = db.prepare(`UPDATE scheduled_messages SET sent = 1 WHERE id = ?`);

// --- Grupos ---
const insertGroup = db.prepare(`
  INSERT INTO groups_table (name, description, avatar, created_by, permission) VALUES (?, ?, ?, ?, ?)
`);
const getGroup = db.prepare(`SELECT * FROM groups_table WHERE id = ?`);
const insertGroupMember = db.prepare(`INSERT OR IGNORE INTO group_members (group_id, username, role) VALUES (?, ?, ?)`);
const getGroupMember = db.prepare(`SELECT * FROM group_members WHERE group_id = ? AND username = ?`);
const listGroupMembers = db.prepare(`SELECT username, role FROM group_members WHERE group_id = ?`);
const listMyGroups = db.prepare(`
  SELECT g.* FROM groups_table g
  JOIN group_members m ON m.group_id = g.id
  WHERE m.username = ?
  ORDER BY g.created_at DESC
`);
const insertGroupMessage = db.prepare(`
  INSERT INTO group_messages (group_id, from_user, content) VALUES (?, ?, ?)
`);
const getGroupMessages = db.prepare(`
  SELECT * FROM group_messages WHERE group_id = ? ORDER BY created_at ASC
`);

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
// Se vier um token junto (opcional), também informa se VOCÊ bloqueou essa pessoa.
app.get('/api/user/:username', (req, res) => {
  const username = normalizeUsername(req.params.username);
  const user = findUser.get(username);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

  let blockedByMe = false;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      blockedByMe = !!getBlock.get(payload.username, username);
    } catch (err) { /* token inválido, apenas ignora o campo blockedByMe */ }
  }

  res.json({
    username: user.username,
    avatar: user.avatar || null,
    online: onlineUsers.has(username),
    blockedByMe,
  });
});

// Edita o próprio perfil (foto e/ou nome de usuário). Exige estar logado.
// Se o nome de usuário mudar, um novo token é devolvido (o antigo passa a
// não corresponder a ninguém, já que o nome dele não existe mais).
app.post('/api/profile', requireAuth, (req, res) => {
  const currentUsername = req.username;
  let finalUsername = currentUsername;

  if (req.body.username !== undefined) {
    const newUsername = normalizeUsername(req.body.username);
    if (!newUsername) {
      return res.status(400).json({ error: 'Nome de usuário inválido' });
    }
    if (newUsername !== currentUsername) {
      if (findUser.get(newUsername)) {
        return res.status(409).json({ error: 'Esse nome de usuário já está em uso' });
      }
      db.prepare(`UPDATE users SET username = ? WHERE username = ?`).run(newUsername, currentUsername);
      db.prepare(`UPDATE messages SET from_user = ? WHERE from_user = ?`).run(newUsername, currentUsername);
      db.prepare(`UPDATE messages SET to_user = ? WHERE to_user = ?`).run(newUsername, currentUsername);
      db.prepare(`UPDATE push_subscriptions SET username = ? WHERE username = ?`).run(newUsername, currentUsername);
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
    updateAvatar.run(req.body.avatar, finalUsername);
  }

  const updatedUser = findUser.get(finalUsername);
  const token = createToken(finalUsername);
  res.json({ token, username: finalUsername, avatar: updatedUser ? updatedUser.avatar : null });
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
  // Se o destinatário bloqueou quem está enviando, a mensagem nem chega a ser salva.
  if (getBlock.get(to, from)) {
    return null;
  }

  // Antes de inserir, verifica se essa é a primeira mensagem entre os dois
  // (para decidir se deve disparar a mensagem de boas-vindas do destinatário).
  const isFirstMessage = countMessagesBetween.get(from, to, to, from).total === 0;

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
      body: content.startsWith('data:image') ? '📷 Foto' : content.startsWith('data:audio') ? '🎤 Áudio' : content,
    });
  }

  // Mensagem de boas-vindas automática (só na primeira mensagem que a pessoa recebe de alguém)
  if (isFirstMessage) {
    const settings = getUserSettings.get(to);
    if (settings && settings.welcome_enabled && settings.welcome_message) {
      deliverMessage(to, from, settings.welcome_message);
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

  // Entra nas salas dos grupos que participa, pra receber mensagens em tempo real
  const myGroups = listMyGroups.all(username);
  myGroups.forEach((g) => socket.join(`group:${g.id}`));

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

  // Envio de mensagem em um grupo
  socket.on('sendGroupMessage', ({ groupId, content }) => {
    if (!groupId || !content) return;
    sendGroupMessage(Number(groupId), username, content);
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
      });
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
app.post('/messages', requireAuth, (req, res) => {
  const to = normalizeUsername(req.body.to);
  const { content } = req.body;
  if (!to || !content) {
    return res.status(400).json({ error: 'Campos obrigatórios: to, content' });
  }
  const message = deliverMessage(req.username, to, content);
  if (!message) {
    return res.status(403).json({ error: 'Não foi possível entregar a mensagem' });
  }
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

// ---------------------------------------------------------------------------
// Bloqueio de usuários
// ---------------------------------------------------------------------------

// Bloqueia um usuário permanentemente (você não pode mais adicioná-lo, e
// mensagens que ele mandar pra você deixam de ser entregues).
app.post('/api/block', requireAuth, (req, res) => {
  const target = normalizeUsername(req.body.username);
  if (!target) return res.status(400).json({ error: 'Informe um nome de usuário' });
  if (target === req.username) return res.status(400).json({ error: 'Você não pode bloquear a si mesmo' });
  insertBlock.run(req.username, target);
  res.json({ ok: true });
});

// Lista quem você já bloqueou
app.get('/api/blocked', requireAuth, (req, res) => {
  res.json(listBlocked.all(req.username).map((r) => r.blocked));
});

// ---------------------------------------------------------------------------
// Configurações do usuário: mensagem de boas-vindas
// ---------------------------------------------------------------------------

app.get('/api/settings', requireAuth, (req, res) => {
  const settings = getUserSettings.get(req.username);
  res.json({
    welcomeEnabled: settings ? !!settings.welcome_enabled : false,
    welcomeMessage: settings ? settings.welcome_message : '',
  });
});

app.post('/api/settings', requireAuth, (req, res) => {
  const welcomeEnabled = req.body.welcomeEnabled ? 1 : 0;
  const welcomeMessage = typeof req.body.welcomeMessage === 'string' ? req.body.welcomeMessage : '';
  upsertUserSettings.run(req.username, welcomeEnabled, welcomeMessage);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Agendamento de mensagens
// ---------------------------------------------------------------------------

// Cria uma mensagem agendada. sendAt deve vir no formato ISO (ex: "2026-09-10T14:30")
app.post('/api/scheduled-messages', requireAuth, (req, res) => {
  const to = normalizeUsername(req.body.to);
  const { content, sendAt } = req.body;
  if (!to || !content || !sendAt) {
    return res.status(400).json({ error: 'Campos obrigatórios: to, content, sendAt' });
  }
  const sendDate = new Date(sendAt);
  if (isNaN(sendDate.getTime())) {
    return res.status(400).json({ error: 'Data/hora inválida' });
  }
  const result = insertScheduled.run(req.username, to, content, sendDate.toISOString());
  res.status(201).json({ id: result.lastInsertRowid });
});

// Lista suas mensagens agendadas que ainda não foram enviadas
app.get('/api/scheduled-messages', requireAuth, (req, res) => {
  res.json(listScheduled.all(req.username));
});

// Cancela uma mensagem agendada
app.delete('/api/scheduled-messages/:id', requireAuth, (req, res) => {
  deleteScheduled.run(req.params.id, req.username);
  res.json({ ok: true });
});

// A cada 30 segundos, verifica se alguma mensagem agendada já venceu e envia
setInterval(() => {
  const due = getDueScheduled.all(new Date().toISOString());
  due.forEach((msg) => {
    deliverMessage(msg.from_user, msg.to_user, msg.content);
    markScheduledSent.run(msg.id);
  });
}, 30 * 1000);

// ---------------------------------------------------------------------------
// Grupos
// ---------------------------------------------------------------------------

function normalizeGroupMemberList(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((u) => normalizeUsername(u)).filter(Boolean))];
}

// Cria um grupo. Quem cria vira administrador automaticamente.
// body: { name, description, avatar, permission: 'adm'|'participante', members: [usernames] }
app.post('/api/groups', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  const avatar = typeof req.body.avatar === 'string' ? req.body.avatar : null;
  const permission = req.body.permission === 'adm' ? 'adm' : 'participante';

  if (!name) return res.status(400).json({ error: 'O grupo precisa de um nome' });

  const result = insertGroup.run(name, description, avatar, req.username, permission);
  const groupId = result.lastInsertRowid;

  insertGroupMember.run(groupId, req.username, 'adm');

  const members = normalizeGroupMemberList(req.body.members).filter((u) => u !== req.username);
  members.forEach((member) => {
    if (findUser.get(member)) {
      insertGroupMember.run(groupId, member, 'participante');
    }
  });

  // Coloca todo mundo que está com o app aberto agora na sala do grupo, pra
  // receber mensagens em tempo real imediatamente.
  const allMembers = listGroupMembers.all(groupId);
  allMembers.forEach((m) => {
    const socketId = onlineUsers.get(m.username);
    if (socketId) io.sockets.sockets.get(socketId)?.join(`group:${groupId}`);
  });

  res.status(201).json({ id: groupId, name, description, avatar, permission, members: allMembers });
});

// Lista os grupos que eu participo
app.get('/api/groups', requireAuth, (req, res) => {
  const groups = listMyGroups.all(req.username);
  res.json(groups.map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    avatar: g.avatar,
    permission: g.permission,
    createdBy: g.created_by,
  })));
});

// Detalhes de um grupo (exige ser membro)
app.get('/api/groups/:id', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  const group = getGroup.get(groupId);
  if (!group) return res.status(404).json({ error: 'Grupo não encontrado' });
  if (!getGroupMember.get(groupId, req.username)) {
    return res.status(403).json({ error: 'Você não é membro desse grupo' });
  }
  const members = listGroupMembers.all(groupId);
  res.json({
    id: group.id,
    name: group.name,
    description: group.description,
    avatar: group.avatar,
    permission: group.permission,
    createdBy: group.created_by,
    members,
  });
});

// Histórico de mensagens do grupo (exige ser membro)
app.get('/api/groups/:id/messages', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  if (!getGroupMember.get(groupId, req.username)) {
    return res.status(403).json({ error: 'Você não é membro desse grupo' });
  }
  res.json(getGroupMessages.all(groupId));
});

function sendGroupMessage(groupId, fromUser, content) {
  const group = getGroup.get(groupId);
  if (!group) return { error: 'Grupo não encontrado' };

  const member = getGroupMember.get(groupId, fromUser);
  if (!member) return { error: 'Você não é membro desse grupo' };

  if (group.permission === 'adm' && member.role !== 'adm') {
    return { error: 'Só administradores podem enviar mensagens nesse grupo' };
  }

  const result = insertGroupMessage.run(groupId, fromUser, content);
  const message = {
    id: result.lastInsertRowid,
    group_id: groupId,
    from_user: fromUser,
    content,
    created_at: new Date().toISOString(),
  };
  io.to(`group:${groupId}`).emit('groupMessage', message);

  // Notifica por push quem não está com o app aberto
  const members = listGroupMembers.all(groupId);
  members.forEach((m) => {
    if (m.username !== fromUser && !onlineUsers.has(m.username)) {
      sendPushToUser(m.username, {
        type: 'message',
        title: `${group.name} (grupo)`,
        body: `${fromUser}: ${content.startsWith('data:image') ? '📷 Foto' : content.startsWith('data:audio') ? '🎤 Áudio' : content}`,
      });
    }
  });

  return { message };
}

// Envio de mensagem em grupo via REST (alternativa ao socket)
app.post('/api/groups/:id/messages', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'Campo obrigatório: content' });

  const result = sendGroupMessage(groupId, req.username, content);
  if (result.error) return res.status(403).json({ error: result.error });
  res.status(201).json(result.message);
});

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
server.listen(PORT, () => {
  console.log(`API de mensagens rodando em http://localhost:${PORT}`);
});
