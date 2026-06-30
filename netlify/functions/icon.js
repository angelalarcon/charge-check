const TARGETS      = ['IMESAPI - SELBA EdRSR 12', 'IMESAPI - SELBA EdRSR 16'];
const NIGHT_STATION = 'IMESAPI - SELBA EdRSR 16';

// FontAwesome 6 Free Solid path data
const ICONS = {
  plug: { d: 'M96 0C78.3 0 64 14.3 64 32v96h64V32c0-17.7-14.3-32-32-32zM288 0c-17.7 0-32 14.3-32 32v96h64V32c0-17.7-14.3-32-32-32zM32 160c-17.7 0-32 14.3-32 32s14.3 32 32 32H48v32c0 77.4 55 142 128 156.8V480c0 17.7 14.3 32 32 32s32-14.3 32-32V412.8C313 398 368 333.4 368 256V224h16c17.7 0 32-14.3 32-32s-14.3-32-32-32H32z', vw: 384, vh: 512 },
  bolt: { d: 'M349.4 44.6c5.9-13.7 1.5-29.7-10.6-38.5s-28.6-8-39.9 1.8l-256 224c-10 8.8-13.6 22.9-8.9 35.3S50.7 288 64 288H175.5L98.6 467.4c-5.9 13.7-1.5 29.7 10.6 38.5s28.6 8 39.9-1.8l256-224c10-8.8 13.6-22.9 8.9-35.3s-16.6-20.7-29.9-20.7H272.5L349.4 44.6z', vw: 448, vh: 512 },
  ban:  { d: 'M367.2 412.5L99.5 144.8C77.1 176.1 64 214.5 64 256c0 106 86 192 192 192c41.5 0 79.9-13.1 111.2-35.5zm45.3-45.3C434.9 335.9 448 297.5 448 256c0-106-86-192-192-192c-41.5 0-79.9 13.1-111.2 35.5L412.5 367.2zM0 256a256 256 0 1 1 512 0A256 256 0 1 1 0 256z', vw: 512, vh: 512 },
  moon: { d: 'M223.5 32C100 32 0 132.3 0 256S100 480 223.5 480c60.6 0 115.5-24.2 155.8-63.4c5-4.9 6.3-12.5 3.1-18.7s-10.1-9.7-17-8.5c-9.8 1.7-19.8 2.6-30.1 2.6c-96.9 0-175.5-78.8-175.5-176c0-65.8 36-123.1 89.3-153.3c6.1-3.5 9.2-10.5 7.7-17.3s-7.3-11.9-14.3-12.2c-6.3-.3-12.6-.4-19-.4z', vw: 384, vh: 512 },
};

function iconForStatus(status, night) {
  if (night) return { bg: '#0f172a', icon: ICONS.moon, fg: '#94a3b8' };
  const m = {
    0: { bg: '#22c55e', icon: ICONS.plug, fg: '#fff' },
    1: { bg: '#3b82f6', icon: ICONS.bolt, fg: '#fff' },
    2: { bg: '#3b82f6', icon: ICONS.bolt, fg: '#fff' },
    3: { bg: '#1c1917', icon: ICONS.ban,  fg: '#fff' },
    9: { bg: '#1c1917', icon: ICONS.ban,  fg: '#fff' },
  };
  return m[status] ?? { bg: '#475569', icon: ICONS.ban, fg: '#fff' };
}

function cellSVG(x, y, size, r, info) {
  const { bg, icon: { d, vw, vh }, fg } = info;
  const iconMax = size * 0.55;
  const scale = iconMax / Math.max(vw, vh);
  const iw = vw * scale, ih = vh * scale;
  const tx = x + (size - iw) / 2;
  const ty = y + (size - ih) / 2;
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="${bg}"/>
<g transform="translate(${tx.toFixed(1)},${ty.toFixed(1)}) scale(${scale.toFixed(4)})"><path d="${d}" fill="${fg}"/></g>`;
}

async function getChargers() {
  const r = await fetch('https://etecnic.net/api/v1/chargers/index.json', {
    headers: { Origin: 'https://etecnic.es', Referer: 'https://etecnic.es/mapa-de-recarga/' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return r.json();
}

async function getSun() {
  const date = new Date().toISOString().slice(0, 10);
  const r = await fetch(
    `https://api.sunrise-sunset.org/json?lat=28.4636&lng=-16.2518&date=${date}&formatted=0`,
    { signal: AbortSignal.timeout(8000) }
  );
  const { results, status } = await r.json();
  if (status !== 'OK') throw new Error('sun api');
  return { sunrise: new Date(results.sunrise), sunset: new Date(results.sunset) };
}

exports.handler = async function () {
  let sockets = Array(4).fill({ status: 3, night: false });

  try {
    const [chargers, sun] = await Promise.all([getChargers(), getSun()]);
    const now = new Date();
    const nightNow = now < sun.sunrise || now > sun.sunset;

    sockets = TARGETS.flatMap(name => {
      const st = chargers.find(s => s.name === name);
      const nightOverride = nightNow && name === NIGHT_STATION;
      if (!st) return [{ status: 3, night: false }, { status: 3, night: false }];
      return st.charger_sockets
        .sort((a, b) => a.socket_number - b.socket_number)
        .slice(0, 2)
        .map(sk => ({ status: sk.status, night: nightOverride }));
    });
  } catch {}

  const S = 512, GAP = 16, CELL = (S - GAP * 3) / 2, R = 28;

  const cells = sockets.map((s, i) => {
    const x = GAP + (i % 2) * (CELL + GAP);
    const y = GAP + Math.floor(i / 2) * (CELL + GAP);
    return cellSVG(x, y, CELL, R, iconForStatus(s.status, s.night));
  }).join('\n');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">
<rect width="${S}" height="${S}" rx="80" fill="#1e293b"/>
${cells}
</svg>`;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
    body: svg,
  };
};
