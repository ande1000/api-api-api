// Service Worker do whats web app — roda em segundo plano, independente da
// página estar aberta. É isso que permite notificar mesmo com o app fechado
// ou a tela do celular apagada.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'whats web app', body: 'Nova notificação', type: 'message' };
  try {
    if (event.data) data = event.data.json();
  } catch (err) {
    if (event.data) data.body = event.data.text();
  }

  const isCall = data.type === 'call';

  const options = {
    body: data.body || '',
    tag: isCall ? 'whatsweb-call' : 'whatsweb-message',
    renotify: true,
    requireInteraction: isCall,
    vibrate: isCall ? [400, 200, 400, 200, 400, 200, 400] : [200, 100, 200],
  };

  event.waitUntil(self.registration.showNotification(data.title || 'whats web app', options));
});

// Ao tocar na notificação, abre (ou foca) o app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
