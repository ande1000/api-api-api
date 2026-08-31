const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }, // libera acesso de qualquer site/app
});

// ---------------------------------------------------------------------------
// Banco de dados (SQLite em arquivo -> messages.db)
// ---------------------------------------------------------------------------
// Em produção (Railway, Render, etc.) defina a variável de ambiente DB_PATH
// apontando para o volume persistente, ex: DB_PATH=/data/messages.db
const dbPath = process.env.DB_PATH || path.join(__dirname, 'messages.db');
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    content TEXT NOT NULL,
    delivered INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

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

  // Se o destinatário está online, entrega na hora via WebSocket
  if (delivered) {
    io.to(targetSocketId).emit('message', message);
  }

  return message;
}

// ---------------------------------------------------------------------------
// WebSocket (Socket.IO) — comunicação em tempo real
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  let currentUser = null;

  // O app do usuário deve chamar isso assim que conectar,
  // informando o nome/id do usuário logado.
  socket.on('register', (username) => {
    currentUser = username;
    onlineUsers.set(username, socket.id);
    console.log(`[online] ${username}`);

    // Entrega mensagens que chegaram enquanto ele estava offline
    const pending = getPending.all(username);
    pending.forEach((msg) => {
      socket.emit('message', msg);
      markDelivered.run(msg.id);
    });
  });

  // Envio de mensagem direto pelo WebSocket (alternativa ao POST /messages)
  socket.on('sendMessage', ({ from, to, content }) => {
    if (!from || !to || !content) return;
    deliverMessage(from, to, content);
  });

  socket.on('disconnect', () => {
    if (currentUser) {
      onlineUsers.delete(currentUser);
      console.log(`[offline] ${currentUser}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Rotas REST (HTTP) — sem chave de API, uso livre
// ---------------------------------------------------------------------------

// Envia uma mensagem: POST /messages  { from, to, content }
app.post('/messages', (req, res) => {
  const { from, to, content } = req.body;
  if (!from || !to || !content) {
    return res.status(400).json({ error: 'Campos obrigatórios: from, to, content' });
  }
  const message = deliverMessage(from, to, content);
  res.status(201).json(message);
});

// Histórico de conversa entre dois usuários: GET /messages/:userA/:userB
app.get('/messages/:userA/:userB', (req, res) => {
  const { userA, userB } = req.params;
  const history = getHistory.all(userA, userB, userB, userA);
  res.json(history);
});

// Lista quem está online agora: GET /online
app.get('/online', (req, res) => {
  res.json(Array.from(onlineUsers.keys()));
});

// Página de teste (public/client-test.html)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'client-test.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`API de mensagens rodando em http://localhost:${PORT}`);
});
