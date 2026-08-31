# Message API

API própria de mensagens, **sem chave de API**, com entrega em tempo real via WebSocket
e histórico salvo em SQLite. Feita com Node.js + Express + Socket.IO.

## Como funciona

1. O app do usuário conecta no servidor via WebSocket e "se registra" com um nome de usuário.
2. Para enviar uma mensagem, o app chama `POST /messages` (ou emite `sendMessage` pelo socket).
3. O servidor salva a mensagem no banco (`messages.db`) e, se o destinatário estiver
   online, entrega na hora via WebSocket (evento `message`).
4. Se o destinatário estiver offline, a mensagem fica marcada como "não entregue" e é
   enviada automaticamente assim que ele se conectar de novo.

## Como rodar

```bash
npm install
npm start
```

O servidor sobe em `http://localhost:3000`. Abra essa URL no navegador para testar
com a página `public/client-test.html` (dá pra abrir em duas abas, uma como "joao" e
outra como "maria", e mandar mensagem de uma pra outra em tempo real).

Para rodar em produção, hospede em qualquer serviço que suporte Node.js (Railway,
Render, Fly.io, uma VPS, etc.) e troque `localhost:3000` pela URL pública.

## Rotas REST

### Enviar mensagem
```
POST /messages
Content-Type: application/json

{
  "from": "joao",
  "to": "maria",
  "content": "Oi Maria!"
}
```
Resposta:
```json
{
  "id": 1,
  "from_user": "joao",
  "to_user": "maria",
  "content": "Oi Maria!",
  "delivered": 1
}
```
`delivered: 1` significa que a mensagem já foi entregue em tempo real (destinatário
estava online). `delivered: 0` significa que ficou pendente, esperando o destinatário
conectar.

### Histórico de conversa entre dois usuários
```
GET /messages/joao/maria
```
Retorna a lista de mensagens trocadas entre `joao` e `maria`, em ordem cronológica.

### Ver quem está online agora
```
GET /online
```
Retorna um array com os nomes de usuário conectados no momento.

## WebSocket (tempo real)

Conecte usando a biblioteca [socket.io-client](https://socket.io/docs/v4/client-api/).

```html
<script src="https://SEU_SERVIDOR/socket.io/socket.io.js"></script>
<script>
  const socket = io("https://SEU_SERVIDOR");

  // 1. Registrar o usuário assim que conectar
  socket.on("connect", () => {
    socket.emit("register", "joao"); // nome do usuário logado no seu app
  });

  // 2. Ouvir mensagens que chegam (em tempo real ou pendentes ao reconectar)
  socket.on("message", (msg) => {
    console.log(`${msg.from_user}: ${msg.content}`);
  });

  // 3. (opcional) Enviar mensagem direto pelo socket, sem usar o POST /messages
  function enviar(to, content) {
    socket.emit("sendMessage", { from: "joao", to, content });
  }
</script>
```

## Usando no seu app (site, app mobile, etc.)

- **Site (React, Vue, HTML puro...)**: use `fetch()` para o `POST /messages` e
  `socket.io-client` (via npm ou CDN) para ouvir o evento `message` em tempo real.
- **App mobile (React Native, Flutter...)**: mesma lógica — chame a API REST para
  enviar mensagens e use uma lib de Socket.IO client (existe para RN e para Flutter)
  para receber em tempo real.
- **Sem WebSocket**: se preferir simplicidade, dá pra ignorar o socket e só usar as
  rotas REST, chamando `GET /messages/:userA/:userB` de tempos em tempos (polling)
  pra buscar mensagens novas.

## Próximos passos que você pode querer adicionar

- Autenticação (login/senha ou token) — hoje qualquer um pode enviar mensagem em
  nome de qualquer usuário, já que não tem chave de API nem verificação de identidade.
- Grupos/conversas com mais de 2 pessoas.
- Envio de imagens/arquivos.
- Confirmação de "lido" (read receipt).

⚠️ **Importante sobre segurança**: como pedido, essa API não usa chave de API nem
autenticação — qualquer pessoa que souber a URL pode enviar mensagens usando
qualquer `from`. Isso é ótimo pra prototipar rápido, mas antes de colocar em produção
com usuários reais, vale adicionar autenticação para impedir que alguém finja ser
outro usuário.
