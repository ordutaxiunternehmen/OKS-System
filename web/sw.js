// Cockpit Plus – macht die Seite installierbar. Speichert bewusst NICHTS zwischen
// (das Programm kommt immer frisch und nur mit gültigem Abo vom Server).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
