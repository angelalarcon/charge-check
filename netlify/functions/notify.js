const webpush = require('web-push');
const { getStore } = require('@netlify/blobs');

const TARGETS       = ['IMESAPI - SELBA EdRSR 12', 'IMESAPI - SELBA EdRSR 16'];
const NIGHT_STATION = 'IMESAPI - SELBA EdRSR 16';

webpush.setVapidDetails(
  'mailto:angel@retention.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

async function fetchStatus() {
  const r = await fetch('https://etecnic.net/api/v1/chargers/index.json', {
    headers: { Origin: 'https://etecnic.es', Referer: 'https://etecnic.es/mapa-de-recarga/' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  const all = await r.json();
  return TARGETS.flatMap(name => {
    const st = all.find(s => s.name === name);
    if (!st) return [];
    return st.charger_sockets
      .sort((a, b) => a.socket_number - b.socket_number)
      .slice(0, 2)
      .map(sk => ({ station: name, socket: sk.socket_number, status: sk.status }));
  });
}

async function isNightNow() {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const r = await fetch(
      `https://api.sunrise-sunset.org/json?lat=28.4636&lng=-16.2518&date=${date}&formatted=0`,
      { signal: AbortSignal.timeout(8000) }
    );
    const { results, status } = await r.json();
    if (status !== 'OK') return false;
    const now = new Date();
    return now < new Date(results.sunrise) || now > new Date(results.sunset);
  } catch {
    return false;
  }
}

exports.handler = async function () {
  let current, night;
  try {
    [current, night] = await Promise.all([fetchStatus(), isNightNow()]);
  } catch (e) {
    // API down — don't update stored state, skip silently
    return { statusCode: 200, body: `fetch failed: ${e.message}` };
  }

  const statusStore = getStore('ev-status');
  const subStore    = getStore('ev-subscriptions');

  const lastRaw = await statusStore.get('last');
  const last    = lastRaw ? JSON.parse(lastRaw) : null;

  // Always update stored state
  await statusStore.set('last', JSON.stringify(current));

  // First run — no previous state to compare against
  if (!last) return { statusCode: 200, body: 'initial run, state stored' };

  // Find sockets that just became available
  const newlyAvailable = current.filter(cur => {
    if (night && cur.station === NIGHT_STATION) return false;
    const prev = last.find(p => p.station === cur.station && p.socket === cur.socket);
    return cur.status === 0 && (!prev || prev.status !== 0);
  });

  if (!newlyAvailable.length) return { statusCode: 200, body: 'no change' };

  // Build notification payload
  const shortNames = newlyAvailable.map(s =>
    `${s.station.replace('IMESAPI - SELBA ', '')} · socket ${s.socket}`
  );
  const payload = JSON.stringify({
    title: `${newlyAvailable.length === 1 ? 'Charger' : `${newlyAvailable.length} chargers`} available 🔌`,
    body: shortNames.join('\n'),
    url: 'https://charge-check.netlify.app',
  });

  // Send to all subscribers, prune expired ones
  const { blobs } = await subStore.list();
  await Promise.allSettled(
    blobs.map(async ({ key }) => {
      const raw = await subStore.get(key);
      if (!raw) return;
      try {
        await webpush.sendNotification(JSON.parse(raw), payload);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await subStore.delete(key);
        }
      }
    })
  );

  return { statusCode: 200, body: `notified ${blobs.length} subscribers` };
};
