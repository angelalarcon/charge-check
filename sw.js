const CACHE = 'ev-v3';

// ── Icon generation via OffscreenCanvas ─────────────────────────────
// Same FA6 paths used on the page, pre-built once at parse time
const ICON_SPECS = {
  plug: { d: 'M96 0C78.3 0 64 14.3 64 32v96h64V32c0-17.7-14.3-32-32-32zM288 0c-17.7 0-32 14.3-32 32v96h64V32c0-17.7-14.3-32-32-32zM32 160c-17.7 0-32 14.3-32 32s14.3 32 32 32H48v32c0 77.4 55 142 128 156.8V480c0 17.7 14.3 32 32 32s32-14.3 32-32V412.8C313 398 368 333.4 368 256V224h16c17.7 0 32-14.3 32-32s-14.3-32-32-32H32z', vw: 384, vh: 512 },
  bolt: { d: 'M349.4 44.6c5.9-13.7 1.5-29.7-10.6-38.5s-28.6-8-39.9 1.8l-256 224c-10 8.8-13.6 22.9-8.9 35.3S50.7 288 64 288H175.5L98.6 467.4c-5.9 13.7-1.5 29.7 10.6 38.5s28.6 8 39.9-1.8l256-224c10-8.8 13.6-22.9 8.9-35.3s-16.6-20.7-29.9-20.7H272.5L349.4 44.6z', vw: 448, vh: 512 },
  ban:  { d: 'M367.2 412.5L99.5 144.8C77.1 176.1 64 214.5 64 256c0 106 86 192 192 192c41.5 0 79.9-13.1 111.2-35.5zm45.3-45.3C434.9 335.9 448 297.5 448 256c0-106-86-192-192-192c-41.5 0-79.9 13.1-111.2 35.5L412.5 367.2zM0 256a256 256 0 1 1 512 0A256 256 0 1 1 0 256z', vw: 512, vh: 512 },
  moon: { d: 'M223.5 32C100 32 0 132.3 0 256S100 480 223.5 480c60.6 0 115.5-24.2 155.8-63.4c5-4.9 6.3-12.5 3.1-18.7s-10.1-9.7-17-8.5c-9.8 1.7-19.8 2.6-30.1 2.6c-96.9 0-175.5-78.8-175.5-176c0-65.8 36-123.1 89.3-153.3c6.1-3.5 9.2-10.5 7.7-17.3s-7.3-11.9-14.3-12.2c-6.3-.3-12.6-.4-19-.4z', vw: 384, vh: 512 },
};
const PATHS = Object.fromEntries(
  Object.entries(ICON_SPECS).map(([k, v]) => [k, new Path2D(v.d)])
);

function iconForStatus(status, night) {
  if (night)                        return { bg: '#0f172a', name: 'moon', vw: 384, vh: 512, fg: '#94a3b8' };
  if (status === 0)                 return { bg: '#22c55e', name: 'plug', vw: 384, vh: 512, fg: '#ffffff' };
  if (status === 1 || status === 2) return { bg: '#3b82f6', name: 'bolt', vw: 448, vh: 512, fg: '#ffffff' };
  return                                   { bg: '#1c1917', name: 'ban',  vw: 512, vh: 512, fg: '#ffffff' };
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y,     x + w, y + r,     r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x,      y + h, x, y + h - r,    r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x,      y,     x + r, y,         r);
  ctx.closePath();
}

async function generateIconBlob(socketInfos) {
  const S = 512, GAP = 20, CELL = (S - GAP * 3) / 2, CR = 28;
  const canvas = new OffscreenCanvas(S, S);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#1e293b';
  rrect(ctx, 0, 0, S, S, 80);
  ctx.fill();

  socketInfos.forEach(({ status, night }, i) => {
    const x = GAP + (i % 2) * (CELL + GAP);
    const y = GAP + Math.floor(i / 2) * (CELL + GAP);
    const { bg, name, vw, vh, fg } = iconForStatus(status, night);

    ctx.fillStyle = bg;
    rrect(ctx, x, y, CELL, CELL, CR);
    ctx.fill();

    const maxIcon = CELL * 0.55;
    const scale = maxIcon / Math.max(vw, vh);
    const tx = x + (CELL - vw * scale) / 2;
    const ty = y + (CELL - vh * scale) / 2;
    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);
    ctx.fillStyle = fg;
    ctx.fill(PATHS[name]);
    ctx.restore();
  });

  return canvas.convertToBlob({ type: 'image/png' });
}

// Latest socket status posted from the page on every refresh
let latestSockets = null;

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'STATUS_UPDATE') {
    latestSockets = e.data.sockets;
  }
});
// ───────────────────────────────────────────────────────────────────

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.add('/')));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'Charger available', {
      body: data.body || '',
      icon: '/icon',
      badge: '/icon',
      tag: 'ev-charger',
      renotify: true,
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const open = list.find(c => 'focus' in c);
      return open ? open.focus() : clients.openWindow('/');
    })
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Serve /icon dynamically from OffscreenCanvas
  if (url.pathname === '/icon') {
    if (latestSockets) {
      e.respondWith(
        generateIconBlob(latestSockets).then(blob =>
          new Response(blob, {
            status: 200,
            headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
          })
        )
      );
    } else {
      // First load — SW hasn't received status yet, fall back to server function
      e.respondWith(fetch('/.netlify/functions/icon'));
    }
    return;
  }

  // Pass through external resources and Netlify function calls
  if (url.hostname !== self.location.hostname) return;
  if (url.pathname.startsWith('/.netlify/')) return;

  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r.ok) {
          const clone = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
