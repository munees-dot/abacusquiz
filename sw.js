// Abacus Quiz – minimal service worker.
// Needed so Android Chrome lets students "Install app" with the Abacus icon.
// It does NOT cache anything: every page/file always comes fresh from the internet,
// so new uploads to GitHub show up immediately.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network only – let the browser handle it normally */ });
