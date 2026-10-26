'use strict';

// Only a public, self-contained recovery page is stored. App pages, API data,
// attachments and transaction requests always go to the server.
const OFFLINE_CACHE = 'tt-offline-app-v1';
const OFFLINE_URL = '/offline.html';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then(cache =>
    cache.add(new Request(OFFLINE_URL, { cache: 'reload' }))));
  // No skipWaiting: existing app windows must finish before a new worker activates.
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('tt-offline-app-') && key !== OFFLINE_CACHE)
      .map(key => caches.delete(key)))));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || request.mode !== 'navigate' ||
      url.origin !== self.location.origin ||
      !['/', '/index.html', '/app-shell.html'].includes(url.pathname)) return;
  event.respondWith(fetch(request).catch(async () => {
    const cache = await caches.open(OFFLINE_CACHE);
    return (await cache.match(OFFLINE_URL)) || Response.error();
  }));
});
