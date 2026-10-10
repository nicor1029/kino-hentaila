const BASE = "https://hentaila.com";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
const BLOCKED_GENRES = ["shota", "loli", "petit"];
const SERVERS = ["MP4Upload", "YourUpload"];
// Kino allows 60 requests per call: 3 blocked genres x 15 pages, plus the catalog and the call's own page, stay under it.
const MAX_GENRE_PAGES = 15;

function decode(s) {
  return String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function safeId(s) { return String(s).replace(/[^A-Za-z0-9._~-]/g, "-").slice(0, 128); }
function unquote(s) { try { return JSON.parse('"' + s + '"'); } catch (e) { return s; } }
function log(m) { try { kino.log(m); } catch (e) {} }

async function getText(url, headers) {
  const r = await kino.fetch(url, { headers: Object.assign({ "User-Agent": UA, "Accept-Language": "es" }, headers || {}) });
  if (!r.ok) {
    if (r.status === 404) throw kino.error("not_found", "HTTP 404");
    if (r.status === 429) throw kino.error("rate_limited", "HTTP 429");
    throw kino.error("unavailable", "HTTP " + r.status);
  }
  return r.text();
}

function parseCards(html) {
  const out = [];
  const seen = {};
  const re = /<h3[^>]*>([^<]+)<\/h3>[\s\S]*?href="\/media\/([^"\/?#]+)"[\s\S]*?src="(https:\/\/cdn\.hentaila\.com\/covers\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    if (seen[m[2]]) continue;
    seen[m[2]] = 1;
    out.push({ slug: m[2], title: decode(m[1]).trim(), poster: m[3] });
  }
  return out;
}
function toItem(c) {
  return { id: safeId(c.slug), ref: c.slug, title: c.title, kind: "series", poster: c.poster, adult: true };
}
function pagesOf(html) {
  // The site states its page count in the page data ("totalPages:5"); page 1 links to no other page.
  const t = /totalPages:(\d+)/.exec(html);
  if (t) return Math.max(1, Number(t[1]));
  let max = 1;
  const re = /[?&]page=(\d+)/g;
  let m;
  while ((m = re.exec(html))) max = Math.max(max, Number(m[1]));
  return max;
}

// Lista de títulos que se ocultan siempre (géneros shota y loli).
async function genreSlugs(genre, baseKey) {
  const first = await getText(BASE + "/catalogo?genre=" + genre);
  const list = parseCards(first).map((c) => c.slug);
  // Si la lista es igual al catálogo normal, el género no existe: se ignora.
  if (list.slice().sort().join(",") === baseKey) return [];
  const slugs = list.slice();
  const total = pagesOf(first);
  if (total > MAX_GENRE_PAGES) log("genero " + genre + ": " + total + " paginas, se leen " + MAX_GENRE_PAGES);
  const last = Math.min(total, MAX_GENRE_PAGES);
  for (let p = 2; p <= last; p += 3) {
    const batch = [];
    for (let q = p; q < p + 3 && q <= last; q++) batch.push(getText(BASE + "/catalogo?genre=" + genre + "&page=" + q));
    const pages = await Promise.all(batch);
    for (const h of pages) for (const c of parseCards(h)) slugs.push(c.slug);
  }
  return slugs;
}
async function blockedSet(baseText) {
  let slugs = null;
  try {
    const c = await kino.storage.get("blk:v3");
    const raw = c && typeof c === "object" && "value" in c ? c.value : c;
    if (typeof raw === "string") {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) slugs = arr;
    }
  } catch (e) {}
  if (!slugs) {
    const baseHtml = await (baseText || getText(BASE + "/catalogo"));
    const baseKey = parseCards(baseHtml).map((c) => c.slug).sort().join(",");
    const lists = await Promise.all(BLOCKED_GENRES.map((g) => genreSlugs(g, baseKey)));
    slugs = [].concat(...lists);
    try { await kino.storage.set("blk:v3", JSON.stringify(slugs), { ttlMs: 12 * 3600 * 1000 }); } catch (e) {}
  }
  const set = {};
  for (const x of slugs) set[x] = true;
  return set;
}

export async function search(query) {
  const q = String((query && query.q) || "").trim();
  const [html, blk] = await Promise.all([
    q ? getText(BASE + "/catalogo?search=" + encodeURIComponent(q)) : Promise.resolve(""),
    blockedSet(),
  ]);
  return parseCards(html).filter((c) => !blk[c.slug]).slice(0, 100).map(toItem);
}

function parseRecent(html) {
  const start = html.indexOf(">Episodios<");
  if (start < 0) return [];
  const out = [];
  const seen = {};
  const parts = html.slice(start).split("<article");
  for (let i = 1; i < parts.length; i++) {
    const c = parts[i];
    const h = c.match(/href="\/media\/([a-z0-9-]+)\/(\d+)"/);
    const t = c.match(/text-subs font-bold uppercase">([^<]+)</);
    if (!h || !t || seen[h[1]]) continue;
    const img = c.match(/src="(https:\/\/cdn\.hentaila\.com\/[^"]+)"/);
    seen[h[1]] = 1;
    out.push({ slug: h[1], title: decode(t[1]).trim(), poster: img ? img[1] : "", ep: h[2] });
  }
  return out;
}
function toRecentItem(c) {
  return { id: safeId(c.slug), ref: c.slug, title: c.title, kind: "series", poster: c.poster, adult: true, badges: ["Ep " + c.ep] };
}
async function recentRow(blk) {
  try {
    const items = parseRecent(await getText(BASE + "/hub")).filter((c) => !blk[c.slug]).slice(0, 30).map(toRecentItem);
    return items.length ? { id: "recientes", title: "Recién agregados", items: items } : null;
  } catch (e) {
    log("recientes");
    return null;
  }
}

export async function home() {
  const catalog = getText(BASE + "/catalogo");
  const [html, blk] = await Promise.all([catalog, blockedSet(catalog)]);
  const rows = [];
  const recent = await recentRow(blk);
  if (recent) rows.push(recent);
  const items = parseCards(html).filter((c) => !blk[c.slug]).map(toItem);
  if (items.length) rows.push({ id: "nuevos", title: "Catálogo", ref: "nuevos", items: items });
  return rows;
}

const CATEGORIES = [
  ["vanilla", "Vanilla"], ["romance", "Romance"], ["ecchi", "Ecchi"], ["softcore", "Softcore"],
  ["harem", "Harem"], ["yuri", "Yuri"], ["yaoi", "Yaoi"], ["futanari", "Futanari"],
  ["3d", "3D"], ["milfs", "Milfs"], ["casadas", "Casadas"], ["maids", "Maids"],
  ["enfermeras", "Enfermeras"], ["teacher", "Teacher"], ["gal", "Gal"], ["elfas", "Elfas"],
  ["succubus", "Succubus"], ["tetonas", "Tetonas"], ["paizuri", "Paizuri"], ["threesome", "Threesome"],
  ["orgias", "Orgías"], ["hardcore", "Hardcore"], ["anal", "Anal"], ["bondage", "Bondage"],
];
const ART_KEY = "art:v1";
async function readArt() {
  try {
    const c = await kino.storage.get(ART_KEY);
    const raw = c && typeof c === "object" && "value" in c ? c.value : c;
    if (typeof raw === "string") {
      const o = JSON.parse(raw);
      if (o && typeof o === "object") return o;
    }
  } catch (e) {}
  return null;
}
async function genreArt(genre, blk) {
  try {
    const html = await getText(BASE + "/catalogo?genre=" + genre);
    const first = parseCards(html).find((c) => c.poster && !blk[c.slug]);
    return first ? first.poster : "";
  } catch (e) {
    log("arte " + genre);
    return "";
  }
}
export async function categories() {
  let art = await readArt();
  if (!art) {
    const blk = await blockedSet();
    art = {};
    for (let i = 0; i < CATEGORIES.length; i += 6) {
      const batch = CATEGORIES.slice(i, i + 6);
      const posters = await Promise.all(batch.map((c) => genreArt(c[0], blk)));
      batch.forEach((c, k) => { if (posters[k]) art[c[0]] = posters[k]; });
    }
    if (Object.keys(art).length) {
      try { await kino.storage.set(ART_KEY, JSON.stringify(art), { ttlMs: 6 * 3600 * 1000 }); } catch (e) {}
    }
  }
  return CATEGORIES.map((c) => {
    const tile = { id: "g-" + c[0], title: c[1], ref: "g:" + c[0], adult: true };
    if (art[c[0]]) tile.art = art[c[0]];
    return tile;
  });
}

export async function browse(ref, cursor) {
  const page = cursor ? Number(cursor) || 1 : 1;
  const r = String(ref);
  const genre = r.indexOf("g:") === 0 ? r.slice(2).replace(/[^a-z0-9-]/g, "") : "";
  const url = genre ? BASE + "/catalogo?genre=" + genre + "&page=" + page : BASE + "/catalogo?page=" + page;
  const [html, blk] = await Promise.all([getText(url), blockedSet()]);
  const items = parseCards(html).filter((c) => !blk[c.slug]).map(toItem);
  const more = page < pagesOf(html);
  return more ? { items: items, next: String(page + 1) } : { items: items };
}

const SECTION_TABS = [
  { id: "novedades", label: "Novedades" },
  { id: "generos1", label: "Géneros" },
  { id: "generos2", label: "Más géneros" },
];

async function rowFor(path, id, title, ref, blk) {
  try {
    const html = await getText(BASE + path);
    const items = parseCards(html).filter((c) => !blk[c.slug]).slice(0, 24).map(toItem);
    return items.length ? { id: id, title: title, ref: ref, items: items } : null;
  } catch (e) {
    log("fila " + id);
    return null;
  }
}

export async function section(arg) {
  const want = arg && arg.tab;
  const tab = SECTION_TABS.some((t) => t.id === want) ? want : "novedades";
  const blk = await blockedSet();
  let rows = [];
  if (tab === "novedades") {
    rows = [await recentRow(blk), await rowFor("/catalogo", "nuevos", "Catálogo", "nuevos", blk)];
  } else {
    const list = tab === "generos1" ? CATEGORIES.slice(0, 12) : CATEGORIES.slice(12);
    for (let i = 0; i < list.length; i += 6) {
      const batch = list.slice(i, i + 6);
      const got = await Promise.all(batch.map((g) => rowFor("/catalogo?genre=" + g[0], "g-" + g[0], g[1], "g:" + g[0], blk)));
      rows = rows.concat(got);
    }
  }
  return { tabs: SECTION_TABS, tab: tab, rows: rows.filter(Boolean) };
}

export async function episodes(ref) {
  const slug = String(ref);
  const html = await getText(BASE + "/media/" + encodeURIComponent(slug));
  const gm = html.match(/genres:\[([\s\S]*?)\],synopsis:/);
  const gblock = gm ? gm[1] : "";
  const gslugs = (gblock.match(/slug:"([^"]+)"/g) || []).map((s) => s.slice(6, -1));
  if (gslugs.some((g) => BLOCKED_GENRES.indexOf(g) >= 0)) throw kino.error("not_found", "genero oculto");
  const names = (gblock.match(/name:"([^"]+)"/g) || []).map((s) => s.slice(6, -1));
  const tm = html.match(/media:\{id:(\d+),categoryId:\d+,title:"((?:[^"\\]|\\.)*)"/);
  const sm = html.match(/synopsis:"((?:[^"\\]|\\.)*)"/);
  const ym = html.match(/startDate:"(\d{4})/);
  const em = html.match(/episodes:\[([^\]]*)\]/);
  const nums = em ? (em[1].match(/number:(\d+)/g) || []).map((s) => Number(s.slice(7))).filter((n) => n > 0) : [];
  nums.sort((a, b) => a - b);
  const series = {};
  if (tm) { series.title = unquote(tm[2]); series.poster = "https://cdn.hentaila.com/covers/" + tm[1] + ".jpg"; }
  if (sm) series.overview = unquote(sm[1]).trim();
  if (ym) series.year = ym[1];
  if (names.length) series.genres = names;
  return {
    series: series,
    episodes: nums.map((n) => ({ season: 1, number: n, ref: slug + "|" + n, title: "Episodio " + n })),
  };
}

async function fromMp4upload(url) {
  const html = await getText(url, { Referer: BASE + "/" });
  const m = html.match(/player\.src\(\{[\s\S]*?src:\s*"([^"]+)"/);
  if (!m) return null;
  return { url: m[1], headers: { Referer: "https://www.mp4upload.com/", "User-Agent": UA } };
}
async function fromYourupload(url) {
  const html = await getText(url, { Referer: BASE + "/" });
  const m = html.match(/property="og:video"[^>]*content="([^"]+)"/) || html.match(/content="(https:\/\/[^"]+\/video\.mp4)"/);
  if (!m) return null;
  return { url: decode(m[1]), headers: { Referer: "https://www.yourupload.com/", "User-Agent": UA } };
}

export async function resolve(ref) {
  const parts = String(ref).split("|");
  const html = await getText(BASE + "/media/" + encodeURIComponent(parts[0]) + "/" + encodeURIComponent(parts[1] || "1"));
  const i = html.indexOf("embeds:");
  const j = html.indexOf("downloads:", i);
  const block = i >= 0 ? html.slice(i, j > i ? j : i + 4000) : "";
  const found = {};
  const re = /\{server:"([^"]+)",url:"([^"]+)"\}/g;
  let m;
  while ((m = re.exec(block))) found[m[1].toLowerCase()] = m[2].replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
  let names = SERVERS.filter((s) => found[s.toLowerCase()]);
  if (parts[2]) names = names.filter((s) => s.toLowerCase() === parts[2].toLowerCase());
  if (!names.length) throw kino.error("not_found", "sin servidores");
  for (let k = 0; k < names.length; k++) {
    const name = names[k];
    try {
      const r = name === "MP4Upload" ? await fromMp4upload(found[name.toLowerCase()]) : await fromYourupload(found[name.toLowerCase()]);
      if (!r) { log("sin video en " + name); continue; }
      const stream = { url: r.url, mime: "video/mp4", headers: r.headers, label: name };
      if (!parts[2]) {
        const rest = names.slice(k + 1).map((n) => ({ label: n, ref: parts[0] + "|" + (parts[1] || "1") + "|" + n }));
        if (rest.length) stream.alternatives = rest;
      }
      return stream;
    } catch (e) {
      log("fallo " + name);
    }
  }
  throw kino.error("unavailable", "ningun servidor respondio");
}
