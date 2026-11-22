// Turnlight picture relay (Cloudflare Worker).
// Looks a board game up on BoardGameGeek by exact name and returns its picture.
// The BGG access token stays here as a secret named BGG_TOKEN and never reaches the page.
//
//   GET /?name=Amerigo  ->  { "found": true, "id": "137408", "name": "Amerigo", "image": "https://cf.geekdo-images.com/..." }
//   no confident match  ->  { "found": false }

const ALLOWED_ORIGINS = ['https://beffautomation.github.io'];
const BGG = 'https://boardgamegeek.com/xmlapi2/';

const unescapeXml = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const flat = s => String(s).toLowerCase().replace(/&/g, 'and').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');

async function bgg(path, env) {
  const r = await fetch(BGG + path, { headers: { Authorization: 'Bearer ' + env.BGG_TOKEN, Accept: 'application/xml' } });
  if (!r.ok) throw new Error('BGG answered ' + r.status);
  return r.text();
}

async function lookup(name, env) {
  const xml = await bgg('search?type=boardgame&exact=1&query=' + encodeURIComponent(name), env);
  const ids = [...xml.matchAll(/<item\b[^>]*\bid="(\d+)"/g)].map(m => m[1]).slice(0, 10);
  if (!ids.length) return { found: false };
  const things = await bgg('thing?stats=1&id=' + ids.join(','), env);
  let best = null;
  for (const m of things.matchAll(/<item\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/item>/g)) {
    const body = m[2];
    const image = (body.match(/<image>\s*([^<\s]+)\s*<\/image>/) || [])[1];
    const primary = (body.match(/<name\b[^>]*type="primary"[^>]*value="([^"]*)"/) || [])[1] || '';
    const names = [...body.matchAll(/<name\b[^>]*value="([^"]*)"/g)].map(n => flat(unescapeXml(n[1])));
    const rated = Number((body.match(/<usersrated\b[^>]*value="(\d+)"/) || [])[1] || 0);
    if (!image || !/^https:\/\/[a-z0-9.-]*geekdo-images\.com\//.test(image)) continue;
    if (!names.includes(flat(name))) continue;                 // must really be this title
    if (!best || rated > best.rated) best = { id: m[1], name: unescapeXml(primary), image, rated };
  }
  return best ? { found: true, id: best.id, name: best.name, image: best.image } : { found: false };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = { 'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0], Vary: 'Origin' };
    const json = (data, status, maxAge) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + maxAge } });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    if (request.method !== 'GET') return json({ error: 'GET only' }, 405, 0);
    if (!env.BGG_TOKEN) return json({ error: 'BGG_TOKEN secret is not set' }, 500, 0);

    const name = (new URL(request.url).searchParams.get('name') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (flat(name).length < 2) return json({ found: false }, 200, 3600);

    // One BGG lookup per game name per week, shared by everyone.
    const cache = typeof caches !== 'undefined' && caches.default;
    const key = new Request('https://turnlight-relay.cache/' + encodeURIComponent(flat(name)));
    if (cache) { const hit = await cache.match(key); if (hit) { const body = await hit.text(); return new Response(body, { status: 200, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' } }); } }

    try {
      const data = await lookup(name, env);
      const body = JSON.stringify(data);
      if (cache) ctx.waitUntil(cache.put(key, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + (data.found ? 604800 : 86400) } })));
      return json(data, 200, 86400);
    } catch (e) {
      return json({ found: false, error: String(e.message || e) }, 502, 0);
    }
  },
};
