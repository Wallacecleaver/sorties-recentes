'use strict';
/*
 * Sorties récentes — addon Stremio (catalogues uniquement) — version Vercel
 * Films / séries / animés qui viennent VRAIMENT de sortir en torrent (API Torznab), validés par
 * les dates officielles TMDB. Priorité : zéro faux positif.
 *
 * Structure :   api/index.js                 entrée Vercel (une seule fonction pour toutes les routes)
 *               index.js                     moteur + routes (ce fichier)
 *               lib/storage.js               stockage Upstash Redis (ou fichiers en local)
 *               dashboard/dashboard.js|html  /admin (mot de passe) + API
 *               dashboard/configure.js|html  /configure (choix de la langue)
 *
 * Sur Vercel il n'y a pas de processus permanent : la mise à jour est un « cycle » déclenché par
 * GET /cron (Vercel Cron et/ou un service externe), qui s'arrête à temps et reprend au cycle suivant.
 *
 * Variables : ADMIN_PASSWORD (dashboard)  CRON_SECRET (protège /cron)  + Upstash (KV_REST_API_URL/TOKEN)
 * Optionnelles : CYCLE_BUDGET_S (50)  TRACKER_DELAY_MS (1500)  DVDS (0 = désactiver)  DVDS_URL  PORT (local)
 */
const http = require('http');
const crypto = require('crypto');
const { addonBuilder } = require('stremio-addon-sdk');
const kv = require('./lib/storage');

/* ------------------------------------------------------------------ constantes */
const HOUR = 3600e3, DAY = 24 * HOUR;
const PORT = +process.env.PORT || 7000;
const CYCLE_BUDGET_MS = (+process.env.CYCLE_BUDGET_S || 50) * 1000; // doit rester < maxDuration de vercel.json (60 s)
const SAVE_MARGIN_MS = 12000;   // temps réservé à la sauvegarde en fin de cycle
const TRACKER_DELAY_MS = process.env.TRACKER_DELAY_MS !== undefined ? +process.env.TRACKER_DELAY_MS : 1500; // politesse envers les trackers
const DVDS_ON = process.env.DVDS !== '0';
const DVDS_URL = process.env.DVDS_URL || 'https://www.dvdsreleasedates.com/digital-releases/';
const KEEP_MS = 30 * DAY;       // durée de conservation des titres validés
const SEEN_KEEP_MS = 30 * DAY;  // durée de conservation des infohash déjà traités
const PAGE = 50;
const UA = 'StremioSortiesRecentes/3.0';
const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342';
const MOVIE_CATS = '2000,2010,2030,2060,2070,2080,2090';
const SERIES_CATS = '5000,5070,5080';
const LANGS = ['all', 'vf', 'vff'];
const LANG_NAMES = { all: 'Toutes les versions', vf: 'VF (VFQ incluse)', vff: 'VFF / VF2 uniquement' };
const KEY = { config: 'sr:config', run: 'sr:run', lock: 'sr:lock', dvds: 'sr:dvds', items: l => 'sr:items:' + l, seen: l => 'sr:seen:' + l };

const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = t => new Date(t).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
const seenKey = h => h.slice(0, 20); // clé compacte pour rester loin de la limite de taille des valeurs

/* ------------------------------------------------------------------ configuration (dashboard) */
let cfgCache = null, cfgAt = 0;
async function getConfig(force) {
  if (!force && cfgCache && Date.now() - cfgAt < 30000) return cfgCache;
  const c = (await kv.get(KEY.config)) || {};
  cfgCache = { tmdbKey: c.tmdbKey || '', streamInfo: !!c.streamInfo, trackers: Array.isArray(c.trackers) ? c.trackers : [] };
  cfgAt = Date.now();
  return cfgCache;
}
async function saveConfig(c) { await kv.set(KEY.config, c); cfgCache = c; cfgAt = Date.now(); }

/* ------------------------------------------------------------------ cache mémoire (par instance) */
const cache = new Map();
async function cached(key, ttl, fn) {
  const c = cache.get(key);
  if (c && c.exp > Date.now()) return c.v;
  const v = await fn();
  if (cache.size > 3000) { const n = Date.now(); for (const [k, x] of cache) if (x.exp < n) cache.delete(k); if (cache.size > 3000) cache.clear(); }
  cache.set(key, { v, exp: Date.now() + ttl });
  return v;
}
async function pool(n, arr, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => { while (i < arr.length) await fn(arr[i++]); }));
}

/* ------------------------------------------------------------------ TMDB */
async function tmdbFetch(key, p, qs) {
  const u = new URL(TMDB + p);
  qs.forEach((v, k) => u.searchParams.set(k, v));
  const headers = { Accept: 'application/json' };
  if (key.length > 40) headers.Authorization = 'Bearer ' + key; // jeton v4
  else u.searchParams.set('api_key', key);                      // clé v3
  for (let a = 0; a < 3; a++) {
    const r = await fetch(u, { headers, signal: AbortSignal.timeout(15000) });
    if (r.status === 404) return null;
    if (r.status === 429) { await sleep(Math.min((+r.headers.get('retry-after') || 2), 5) * 1000); continue; }
    if (!r.ok) throw new Error('TMDB ' + r.status + ' ' + p);
    return r.json();
  }
  throw new Error('TMDB 429 ' + p);
}
function tmdb(env, p, params = {}) {
  const qs = new URLSearchParams({ language: 'fr-FR', ...params });
  return cached('tmdb:' + p + '?' + qs, 12 * HOUR, () => tmdbFetch(env.m, p, qs));
}

/* ------------------------------------------------------------------ Torznab */
let trackerChain = Promise.resolve();
function trackerGet(url) { // file d'attente : une requête à la fois, espacées
  const job = trackerChain.then(async () => {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('Tracker HTTP ' + r.status);
      return await r.text();
    } finally { if (TRACKER_DELAY_MS) await sleep(TRACKER_DELAY_MS); }
  });
  trackerChain = job.catch(() => {});
  return job;
}
function tzUrl(tr, params) {
  const u = new URL(tr.url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('apikey', tr.apikey);
  return u.toString();
}
const unxml = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
function parseTorznab(xml) {
  const err = xml.match(/<error\b[^>]*description="([^"]*)"/i);
  if (err) throw new Error('Torznab : ' + err[1]);
  const items = [];
  const re = /<item[\s>]([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const tag = n => { const r = b.match(new RegExp('<' + n + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + n + '>')); return r ? unxml(r[1]) : ''; };
    const attrs = {}, cats = [];
    const ar = /<(?:torznab|newznab):attr\s+name="([^"]+)"\s+value="([^"]*)"/g;
    let a;
    while ((a = ar.exec(b))) { if (a[1] === 'category') cats.push(+a[2]); else attrs[a[1]] = unxml(a[2]); }
    const title = tag('title');
    if (!title) continue;
    const guid = tag('guid'), link = tag('link');
    const bt = (attrs.magneturl || link || guid).match(/btih:([0-9a-zA-Z]{32,40})/i);
    const hash = (attrs.infohash || (bt && bt[1]) || crypto.createHash('sha1').update(guid || link || title).digest('hex')).toLowerCase();
    items.push({ hash, title, tmdbid: parseInt(attrs.tmdbid, 10) || 0, cats, pub: Date.parse(tag('pubDate')) });
  }
  return items;
}
// historique d'un tracker pour un film (cache mémoire 1 h)
const history = (tr, tmdbId) => cached('hist:' + tr.id + ':' + tmdbId, HOUR, async () =>
  parseTorznab(await trackerGet(tzUrl(tr, { t: 'movie', tmdbid: tmdbId, limit: 100 }))));

/* ------------------------------------------------------------------ analyse du nom de release */
const QUAL_RE = /(?<![A-Za-z0-9])(\d{3,4}[pi]|4K|UHD|WEB[-.]?DL|WEB[-.]?RIP|WEB|BLU[-.]?RAY|BDRIP|BRRIP|HDRIP|DVDRIP|HDTV|REMUX|[xh]\.?26[45]|HEVC|HDCAM|CAM|TELESYNC|TS|TC)(?![A-Za-z0-9])/i;
const LANG_RE = /(?<![A-Za-z0-9])(TRUEFRENCH|SUBFRENCH|FRENCH|VFF|VFQ|VFI|VF2|VOF|MULTI|VOSTFR|VOSTA)(?![A-Za-z0-9])/i;
const EP_RE = /(?<![A-Za-z0-9])S(\d{1,2})[ .-]?E(\d{1,3})(?!\d)/i;
const SEASON_RE = /(?<![A-Za-z0-9])S(\d{1,2})(?![A-Za-z0-9])/i;
const YEAR_RE = /(?<![A-Za-z0-9])((?:19|20)\d{2})(?![A-Za-z0-9])/g;
const TAG_ORDER = ['TRUEFRENCH', 'VFF', 'VF2', 'VFI', 'VOF', 'VFQ', 'FRENCH', 'MULTI', 'VOSTFR'];
const STRICT_VFF = ['VFF', 'VF2', 'VFI', 'TRUEFRENCH', 'VOF'];
const ANY_VF = ['FRENCH', 'TRUEFRENCH', 'VFF', 'VFQ', 'VFI', 'VF2', 'VOF', 'MULTI'];

function parseRelease(raw) {
  const s = raw.replace(/_/g, '.');
  const cuts = [];
  const cut = re => { const m = re.exec(s); if (m && m.index > 0) cuts.push(m.index); };
  cut(LANG_RE); cut(QUAL_RE);
  let year = null, yi = -1;
  for (const m of s.matchAll(YEAR_RE)) if (m.index > 0) { year = +m[1]; yi = m.index; } // dernière année
  if (yi > 0) cuts.push(yi);
  const ep = s.match(EP_RE);
  const se = ep ? null : s.match(SEASON_RE);
  if (ep && ep.index > 0) cuts.push(ep.index);
  if (se && se.index > 0) cuts.push(se.index);
  const end = cuts.length ? Math.min(...cuts) : s.length;
  const name = s.slice(0, end).replace(/\./g, ' ').replace(/[\s\-\[\(]+$/, '').trim();
  const tags = new Set();
  for (const m of s.matchAll(new RegExp(LANG_RE.source, 'gi'))) tags.add(m[1].toUpperCase());
  const web = /(?<![A-Za-z0-9])(WEB|WEB[-.]?DL|WEB[-.]?RIP|BLU[-.]?RAY|BDRIP|BRRIP|REMUX)(?![A-Za-z0-9])/i.test(s);
  const bad = /(?<![A-Za-z0-9])(HDTV|CAM|HDCAM|TS|TC|TELESYNC|TELECINE)(?![A-Za-z0-9])/i.test(s);
  return {
    name, year, tags,
    season: ep ? +ep[1] : se ? +se[1] : null,
    episode: ep ? +ep[2] : null,
    isVF: ANY_VF.some(t => tags.has(t)),
    strictVFF: STRICT_VFF.some(t => tags.has(t)),
    webOrBd: web && !bad,
    label: TAG_ORDER.filter(t => tags.has(t)).join(' '),
  };
}
function langOk(mode, rel, origLang, kind) { // la release correspond-elle à la langue demandée ?
  if (mode === 'vf') return rel.isVF;
  if (mode === 'vff') return rel.strictVFF || (kind === 'movie' && rel.tags.has('FRENCH') && origLang === 'fr');
  return true;
}

/* ------------------------------------------------------------------ dvdsreleasedates.com (US numérique, relu toutes les 6 h) */
let dvdsCount = 0;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function parseDvds(html) {
  const marks = [];
  for (const m of html.matchAll(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})/gi))
    marks.push({ i: m.index, t: Date.UTC(+m[3], MONTHS.indexOf(m[1].toLowerCase()), +m[2]) });
  for (const m of html.matchAll(/(20\d{2})-(\d{2})-(\d{2})/g)) marks.push({ i: m.index, t: Date.UTC(+m[1], +m[2] - 1, +m[3]) });
  marks.sort((a, b) => a.i - b.i);
  const map = new Map();
  for (const m of html.matchAll(/tt\d{7,9}/g)) {
    let best = null;
    for (const d of marks) { if (d.i < m.index) best = d; else break; }
    if (best && m.index - best.i < 2500 && !map.has(m[0])) map.set(m[0], best.t);
  }
  return map;
}
const dvds = () => !DVDS_ON ? Promise.resolve(new Map()) : cached('dvds', 30 * 60e3, async () => {
  const c = await kv.get(KEY.dvds);
  if (c && Date.now() - c.t < 6 * HOUR) { dvdsCount = Object.keys(c.map).length; return new Map(Object.entries(c.map)); }
  try {
    const r = await fetch(DVDS_URL, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const map = parseDvds(await r.text());
    dvdsCount = map.size;
    await kv.set(KEY.dvds, { t: Date.now(), map: Object.fromEntries(map) });
    log('dvdsreleasedates :', map.size, 'dates lues');
    return map;
  } catch (e) {
    log('dvdsreleasedates indisponible :', e.message);
    dvdsCount = c ? Object.keys(c.map).length : 0;
    return c ? new Map(Object.entries(c.map)) : new Map();
  }
});

/* ------------------------------------------------------------------ règles de validation */
// env = { l: langue du catalogue, m: clé TMDB, trackers: trackers actifs }   it.tr = tracker d'origine du torrent
const rej = reason => ({ reason });
const minOf = (...a) => { a = a.filter(x => x != null && !isNaN(x)); return a.length ? Math.min(...a) : null; };
function relDate(d, isos, types) { // plus ancienne date TMDB (pays x types)
  let m = null;
  for (const r of (d.release_dates && d.release_dates.results) || []) {
    if (!isos.includes(r.iso_3166_1)) continue;
    for (const x of r.release_dates || []) {
      if (!types.includes(x.type)) continue;
      const t = Date.parse(x.release_date);
      if (!isNaN(t) && (m === null || t < m)) m = t;
    }
  }
  return m;
}
async function resolveTmdb(env, it, rel, kind) {
  if (it.tmdbid > 0) return it.tmdbid; // ID fourni par le tracker : prioritaire
  if (!rel.name) return 0;
  const mt = kind === 'movie' ? 'movie' : 'tv';
  const yp = kind === 'movie' ? 'year' : 'first_air_date_year';
  const first = async extra => {
    const r = await tmdb(env, '/search/' + mt, { query: rel.name, include_adult: 'false', ...extra });
    return r && r.results && r.results[0];
  };
  let r = rel.year ? await first({ [yp]: rel.year }) : null;
  if (!r) r = await first({});
  if (!r) { const m = await tmdb(env, '/search/multi', { query: rel.name }); r = m && (m.results || []).find(x => x.media_type === mt); }
  return r ? r.id : 0;
}
// film sans date numérique/physique : « premier torrent »
async function premierTorrent(env, it, rel, d, tmdbId, cinema, now) {
  if (!rel.webOrBd) return false;
  const rd = Date.parse(d.release_date);
  if (isNaN(rd) || now - rd >= 365 * DAY || rd > now) return false;
  if (cinema == null) return false;
  const age = (now - cinema) / DAY;
  if (age < 30 || age > 183) return false;
  const h = await history(it.tr, tmdbId);
  if (!h.length || h.length >= 100 || !h.some(x => x.hash === it.hash)) return false;
  for (const tr of env.trackers) { // plusieurs trackers : aucun ne doit avoir de torrent de ce film de plus de 3 jours
    const hh = tr.id === it.tr.id ? h : await history(tr, tmdbId);
    if (hh.length >= 100 || !hh.every(x => x.pub > 0 && x.pub >= now - 3 * DAY)) return false;
  }
  return true;
}
// VF/VFF : premier torrent de cette langue (aucun torrent de la langue depuis plus de 3 jours)
async function firstOfLang(env, it, orig, tmdbId, now) {
  const all = new Map();
  for (const tr of env.trackers) {
    const h = await history(tr, tmdbId);
    if (h.length >= 100) return false; // historique tronqué : au moindre doute, non
    for (const x of h) all.set(x.hash, x);
  }
  if (!all.has(it.hash)) all.set(it.hash, it);
  for (const x of all.values()) {
    if (!langOk(env.l, parseRelease(x.title), orig, 'movie')) continue;
    if (!(x.pub > 0) || x.pub < now - 3 * DAY) return false;
  }
  return true;
}

async function evalMovie(env, it, rel) {
  const now = Date.now();
  const id = await resolveTmdb(env, it, rel, 'movie');
  if (!id) return rej('titre TMDB introuvable');
  const d = await tmdb(env, '/movie/' + id, { append_to_response: 'release_dates,external_ids' });
  if (!d) return rej('film TMDB introuvable');
  const imdb = d.imdb_id || (d.external_ids && d.external_ids.imdb_id);
  if (!imdb) return rej("pas d'ID IMDb");
  if (!langOk(env.l, rel, d.original_language, 'movie')) return rej('langue non demandée');
  const cinema = relDate(d, ['FR', 'US', 'CA'], [2, 3]);
  let date, dateLabel = 'Sortie le';
  if (env.l === 'all') {
    const dig = minOf(relDate(d, ['FR', 'US', 'CA'], [4, 5]), (await dvds()).get(imdb)); // la plus ancienne de toutes
    if (dig != null) {
      if (now - dig > 7 * DAY) return rej('sortie numérique trop ancienne');
      date = dig; // une date future passe aussi
    } else if (await premierTorrent(env, it, rel, d, id, cinema, now)) {
      date = it.pub > 0 ? it.pub : now; dateLabel = 'Torrent du';
    } else return rej('aucune date numérique et pas un premier torrent');
  } else {
    const ld = relDate(d, env.l === 'vf' ? ['FR', 'CA'] : ['FR'], [4, 5]);
    if (ld != null && now - ld <= 7 * DAY) date = ld;
    else {
      const lim = new Date(now); lim.setMonth(lim.getMonth() - 8);
      if (cinema == null || cinema > now || cinema < lim.getTime()) return rej('sortie cinéma hors fenêtre de 8 mois');
      if (!(await firstOfLang(env, it, d.original_language, id, now))) return rej('pas le premier torrent de cette langue');
      date = it.pub > 0 ? it.pub : now; dateLabel = 'Torrent du';
    }
  }
  return { entry: {
    id: imdb, type: 'movie', anime: false, name: d.title || d.original_title || rel.name,
    poster: d.poster_path ? IMG + d.poster_path : undefined, year: (d.release_date || '').slice(0, 4),
    ts: Math.min(now, it.pub > 0 ? it.pub : now), date,
    desc: [dateLabel + ' ' + fmt(date), rel.label].filter(Boolean).join(' · '),
  } };
}

async function evalSeries(env, it, rel) {
  const now = Date.now();
  if (rel.season == null) return rej('pas de numéro de saison');
  const id = await resolveTmdb(env, it, rel, 'series');
  if (!id) return rej('série TMDB introuvable');
  const d = await tmdb(env, '/tv/' + id, { append_to_response: 'external_ids' });
  if (!d) return rej('série TMDB introuvable');
  const imdb = d.external_ids && d.external_ids.imdb_id;
  if (!imdb) return rej("pas d'ID IMDb");
  if (!langOk(env.l, rel, d.original_language, 'series')) return rej('langue non demandée');
  let date, label;
  if (rel.episode != null) {
    const e = await tmdb(env, `/tv/${id}/season/${rel.season}/episode/${rel.episode}`);
    const air = e && Date.parse(e.air_date);
    if (!air) return rej("date de diffusion de l'épisode inconnue");
    if (now - air > 48 * HOUR) return rej('épisode diffusé il y a plus de 48 h');
    date = air; label = 'S' + String(rel.season).padStart(2, '0') + 'E' + String(rel.episode).padStart(2, '0');
  } else {
    const s = await tmdb(env, `/tv/${id}/season/${rel.season}`);
    const aired = ((s && s.episodes) || []).map(x => Date.parse(x.air_date)).filter(t => t && t <= now);
    if (!aired.length) return rej('aucun épisode diffusé dans la saison');
    date = Math.max(...aired);
    if (now - date > 7 * DAY) return rej('dernier épisode de la saison trop ancien');
    label = 'Saison ' + rel.season + ' complète';
  }
  const anime = (d.genres || []).some(g => g.id === 16) && (d.original_language === 'ja' || (d.origin_country || []).includes('JP'));
  return { entry: {
    id: imdb, type: 'series', anime, name: d.name || d.original_name || rel.name,
    poster: d.poster_path ? IMG + d.poster_path : undefined, year: (d.first_air_date || '').slice(0, 4),
    ts: Math.min(now, it.pub > 0 ? it.pub : now), date, season: rel.season, episode: rel.episode,
    desc: [label, 'diffusé le ' + fmt(date), rel.label].filter(Boolean).join(' · '),
  } };
}

/* ------------------------------------------------------------------ cycle de mise à jour (borné dans le temps) */
function addEntry(st, e) {
  const i = st.items.findIndex(x => x.id === e.id && x.type === e.type);
  if (i >= 0) {
    if (e.type === 'movie' || st.items[i].ts >= e.ts) return; // un film n'apparaît qu'une fois
    st.items.splice(i, 1);                                     // une série remonte en tête à chaque nouvel épisode
  }
  st.items.push(e);
  st.items.sort((a, b) => b.ts - a.ts);
}
async function cycle(budgetMs = CYCLE_BUDGET_MS) {
  const t0 = Date.now(), deadline = t0 + budgetMs - SAVE_MARGIN_MS;
  if (!(await kv.setNx(KEY.lock, t0, Math.ceil(budgetMs / 1000) + 30))) return { skipped: true, message: 'Un cycle est déjà en cours' };
  try {
    const cfg = await getConfig(true);
    const trackers = cfg.trackers.filter(t => t.enabled);
    if (!cfg.tmdbKey || !trackers.length) return { skipped: true, message: 'Ajoutez au moins un tracker actif et la clé TMDB dans /admin' };
    const run = (await kv.get(KEY.run)) || {};
    run.trackerStatus = {};
    const list = [];
    for (const tr of trackers) {
      const stt = run.trackerStatus[tr.id] = { last: Date.now(), ok: true, count: 0, error: null };
      for (const [kind, cats] of [['movie', MOVIE_CATS], ['series', SERIES_CATS]]) {
        try {
          const its = parseTorznab(await trackerGet(tzUrl(tr, { t: 'search', q: '', cat: cats, limit: 100 })));
          stt.count += its.length;
          for (const x of its) list.push({ ...x, kind, tr });
        } catch (e) { stt.ok = false; stt.error = e.message; log(`[${tr.name}] ${kind} : ${e.message}`); }
      }
    }
    const langs = {};
    for (const l of LANGS) langs[l] = { items: (await kv.get(KEY.items(l))) || [], seen: (await kv.get(KEY.seen(l))) || {} };
    const uniq = new Map();
    for (const x of list) if (!uniq.has(x.hash)) uniq.set(x.hash, x); // même infohash sur 2 trackers : traité une fois
    const todo = [...uniq.values()].filter(x => LANGS.some(l => !langs[l].seen[seenKey(x.hash)])).sort((a, b) => (b.pub || 0) - (a.pub || 0)); // les plus récents d'abord
    const stats = Object.fromEntries(LANGS.map(l => [l, { neuf: 0, ok: 0, ko: 0, err: 0 }]));
    const envs = Object.fromEntries(LANGS.map(l => [l, { l, m: cfg.tmdbKey, trackers }]));
    let postponed = 0;
    await pool(3, todo, async it => {
      if (Date.now() > deadline) { postponed++; return; } // plus le temps : reporté au cycle suivant
      const rel = parseRelease(it.title);
      for (const lang of LANGS) {
        const st = langs[lang], sk = seenKey(it.hash);
        if (st.seen[sk]) continue;
        stats[lang].neuf++;
        try {
          const r = it.kind === 'series' ? await evalSeries(envs[lang], it, rel) : await evalMovie(envs[lang], it, rel);
          st.seen[sk] = Math.floor(Date.now() / 60000); // traité : ne sera pas retraité
          if (r.entry) { addEntry(st, r.entry); stats[lang].ok++; log(`[${lang}] + ${r.entry.name} (${r.entry.desc})`); }
          else { stats[lang].ko++; if (process.env.DEBUG) log(`[${lang}] - ${it.title} : ${r.reason}`); }
        } catch (e) { stats[lang].err++; log(`[${lang}] erreur transitoire, sera retenté : ${it.title} : ${e.message}`); }
      }
    });
    const now = Date.now();
    for (const l of LANGS) {
      const st = langs[l];
      st.items = st.items.filter(x => x.ts > now - KEEP_MS);
      for (const [h, m] of Object.entries(st.seen)) if (m * 60000 < now - SEEN_KEEP_MS) delete st.seen[h];
      await kv.set(KEY.items(l), st.items);
      await kv.set(KEY.seen(l), st.seen);
    }
    Object.assign(run, { last: Date.now(), ms: Date.now() - t0, stats, postponed, dvds: dvdsCount });
    await kv.set(KEY.run, run);
    const msg = LANGS.map(l => `${l} +${stats[l].ok}`).join('  ') + (postponed ? `  (${postponed} torrent(s) reporté(s) au prochain cycle)` : '');
    log('cycle terminé en', Math.round(run.ms / 1000), 's :', msg);
    return { ok: true, message: 'Cycle terminé : ' + msg, postponed };
  } catch (e) {
    log('cycle :', e.message);
    return { ok: false, message: e.message };
  } finally { await kv.del(KEY.lock).catch(() => {}); }
}

/* ------------------------------------------------------------------ manifest, catalogues, flux d'info */
const CATALOGS = [
  { type: 'movie', id: 'sr-films', name: 'Films récents' },
  { type: 'series', id: 'sr-series', name: 'Séries récentes' },
  { type: 'series', id: 'sr-animes', name: 'Animés récents' },
];
function buildManifest(lang, streamInfo) {
  const m = {
    id: 'community.sorties.recentes', version: '3.0.0', name: 'Sorties récentes',
    description: 'Catalogues des films, séries et animés qui viennent de sortir en torrent — ' + LANG_NAMES[lang] + '.',
    resources: streamInfo ? ['catalog', 'stream'] : ['catalog'],
    types: ['movie', 'series'],
    catalogs: CATALOGS.map(c => ({ ...c, extra: [{ name: 'skip' }] })),
    behaviorHints: { configurable: true },
  };
  if (streamInfo) m.idPrefixes = ['tt'];
  const b = new addonBuilder(m); // valide le manifest avec le SDK officiel
  b.defineCatalogHandler(async () => ({ metas: [] }));
  if (streamInfo) b.defineStreamHandler(async () => ({ streams: [] }));
  return b.getInterface().manifest || m;
}
async function catalog(lang, id, skip) {
  const items = (await kv.get(KEY.items(lang))) || [];
  const list = items.filter(x => id === 'sr-films' ? x.type === 'movie'
    : id === 'sr-animes' ? x.type === 'series' && x.anime : x.type === 'series' && !x.anime);
  return list.slice(skip, skip + PAGE).map(x => ({
    id: x.id, type: x.type, name: x.name, poster: x.poster, releaseInfo: x.year || undefined, description: x.desc,
  }));
}
async function streamsFor(lang, type, id) { // ligne d'information (option du dashboard) : ce n'est pas un flux lisible
  const [imdb, s, e] = id.split(':');
  const en = ((await kv.get(KEY.items(lang))) || []).find(x => x.id === imdb && x.type === type);
  if (!en) return [];
  if (type === 'series') {
    if (en.season != null && s != null && +s !== en.season) return [];
    if (en.episode != null && e != null && +e !== en.episode) return [];
  }
  return [{ name: '🆕 Sortie récente', description: en.desc, externalUrl: `stremio:///detail/${type}/${imdb}` }];
}

/* ------------------------------------------------------------------ fonctions exposées au dashboard */
const mask = k => k ? '••••' + k.slice(-4) : '';
function cleanUrl(u) {
  let x;
  try { x = new URL(String(u || '').trim()); } catch { throw new Error('URL invalide'); }
  if (!/^https?:$/.test(x.protocol)) throw new Error('L\'URL doit commencer par http:// ou https://');
  x.searchParams.delete('apikey');
  return x.toString();
}
const core = {
  LANG_NAMES,
  async getState() {
    const cfg = await getConfig(true), run = (await kv.get(KEY.run)) || {}, counts = {};
    for (const l of LANGS) {
      const it = (await kv.get(KEY.items(l))) || [];
      counts[l] = { movies: it.filter(x => x.type === 'movie').length, series: it.filter(x => x.type === 'series' && !x.anime).length, anime: it.filter(x => x.anime).length };
    }
    return {
      langs: LANG_NAMES,
      trackers: cfg.trackers.map(t => ({ id: t.id, name: t.name, url: t.url, keyHint: mask(t.apikey), enabled: t.enabled, status: (run.trackerStatus || {})[t.id] || null })),
      tmdb: { set: !!cfg.tmdbKey, hint: mask(cfg.tmdbKey) },
      settings: { streamInfo: cfg.streamInfo },
      run: { busy: !!(await kv.get(KEY.lock)), last: run.last || 0, ms: run.ms || 0, stats: run.stats || {}, postponed: run.postponed || 0, budgetS: CYCLE_BUDGET_MS / 1000 },
      counts, dvds: run.dvds || 0, dvdsOn: DVDS_ON,
    };
  },
  async addTracker(o) {
    const apikey = String(o.apikey || '').trim();
    if (!apikey) throw new Error('Clé API du tracker manquante');
    const url = cleanUrl(o.url);
    const c = await getConfig(true);
    const t = { id: crypto.randomBytes(3).toString('hex'), name: String(o.name || '').trim() || new URL(url).hostname, url, apikey, enabled: o.enabled !== false };
    c.trackers.push(t); await saveConfig(c);
    return { id: t.id };
  },
  async updateTracker(id, o) {
    const c = await getConfig(true), t = c.trackers.find(x => x.id === id);
    if (!t) throw new Error('Tracker introuvable');
    if (o.name !== undefined && String(o.name).trim()) t.name = String(o.name).trim();
    if (o.url !== undefined) t.url = cleanUrl(o.url);
    if (o.apikey && String(o.apikey).trim()) t.apikey = String(o.apikey).trim();
    if (o.enabled !== undefined) t.enabled = !!o.enabled;
    await saveConfig(c);
  },
  async removeTracker(id) {
    const c = await getConfig(true), n = c.trackers.length;
    c.trackers = c.trackers.filter(x => x.id !== id);
    if (c.trackers.length === n) throw new Error('Tracker introuvable');
    await saveConfig(c);
  },
  async setTmdb(key) { const c = await getConfig(true); c.tmdbKey = String(key || '').trim(); await saveConfig(c); },
  async setSettings(o) { const c = await getConfig(true); if ('streamInfo' in o) c.streamInfo = !!o.streamInfo; await saveConfig(c); },
  async testTracker(id) {
    const t = (await getConfig(true)).trackers.find(x => x.id === id);
    if (!t) throw new Error('Tracker introuvable');
    try {
      const its = parseTorznab(await trackerGet(tzUrl(t, { t: 'search', q: '', cat: MOVIE_CATS, limit: 5 })));
      return { ok: true, message: `Connexion OK — ${its.length} résultat(s) reçu(s)` + (its.some(x => x.tmdbid) ? ', ID TMDB fournis par le tracker' : ', pas d\'ID TMDB dans les résultats (recherche par nom)') };
    } catch (e) { return { ok: false, message: e.message }; }
  },
  async testTmdb(key) {
    const k = String(key || '').trim() || (await getConfig(true)).tmdbKey;
    if (!k) return { ok: false, message: 'Aucune clé TMDB' };
    try { await tmdbFetch(k, '/configuration', new URLSearchParams()); return { ok: true, message: 'Clé TMDB valide' }; }
    catch (e) { return { ok: false, message: /401|403/.test(e.message) ? 'Clé TMDB refusée' : e.message }; }
  },
  async refreshNow() { return cycle(); }, // exécuté dans la requête (borné à CYCLE_BUDGET_S)
  async reset(what) {
    if (!['seen', 'items', 'all'].includes(what)) throw new Error('Action inconnue');
    for (const l of LANGS) {
      if (what !== 'seen') await kv.set(KEY.items(l), []); // vider les catalogues
      await kv.set(KEY.seen(l), {});                        // et/ou retraiter aussi les torrents rejetés
    }
  },
  async catalog(lang) {
    if (!LANGS.includes(lang)) throw new Error('Langue inconnue');
    return ((await kv.get(KEY.items(lang))) || []).map(x => ({ id: x.id, type: x.type, anime: x.anime, name: x.name, year: x.year, desc: x.desc, ts: x.ts }));
  },
};

/* ------------------------------------------------------------------ routes HTTP */
const dashboard = require('./dashboard/dashboard')(core, { password: process.env.ADMIN_PASSWORD });
const configure = require('./dashboard/configure')(core);
const send = (res, code, type, body, extra = {}) => { res.writeHead(code, { 'Content-Type': type, ...extra }); res.end(body); };
const json = (res, o, extra) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(o), extra);
const safeEq = (a, b) => { const A = crypto.createHash('sha256').update(String(a)).digest(), B = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(A, B); };
const EDGE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600'; // cache du CDN Vercel pour Stremio

async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (seg[0] === 'admin') return await dashboard(req, res, seg);
    if (seg[0] === 'cron') { // Vercel Cron (en-tête Authorization) ou service externe (?key=)
      const secret = process.env.CRON_SECRET;
      const given = (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('key') || '';
      if (!secret || !safeEq(given, secret)) return send(res, 401, 'text/plain; charset=utf-8', 'Non autorisé (définissez CRON_SECRET)');
      return json(res, await cycle(), { 'Cache-Control': 'no-store' });
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (!seg.length || (seg.length === 1 && seg[0] === 'configure')) return configure(req, res, 'all');
    if (seg[0] === 'health') return json(res, { ok: true, storage: kv.remote ? 'upstash' : 'fichiers', admin: !!process.env.ADMIN_PASSWORD, cron: !!process.env.CRON_SECRET }, { 'Cache-Control': 'no-store' });
    if (seg.length === 1 && seg[0] === 'manifest.json') return json(res, buildManifest('all', (await getConfig()).streamInfo), { 'Cache-Control': 'public, s-maxage=60' });
    const lang = seg[0], rest = seg.slice(1);
    if (!LANGS.includes(lang)) return send(res, 404, 'text/plain; charset=utf-8', 'Introuvable');
    if (rest[0] === 'configure') return configure(req, res, lang);
    if (rest[0] === 'manifest.json') return json(res, buildManifest(lang, (await getConfig()).streamInfo), { 'Cache-Control': 'public, s-maxage=60' });
    if (rest.length) rest[rest.length - 1] = rest[rest.length - 1].replace(/\.json$/, '');
    if (rest[0] === 'catalog' && rest.length >= 3) {
      const skip = rest.length > 3 ? parseInt(new URLSearchParams(rest[3]).get('skip'), 10) || 0 : 0;
      return json(res, { metas: await catalog(lang, rest[2], skip) }, { 'Cache-Control': EDGE });
    }
    if (rest[0] === 'stream' && rest.length >= 3) {
      const streams = (await getConfig()).streamInfo ? await streamsFor(lang, rest[1], rest[2]) : [];
      return json(res, { streams }, { 'Cache-Control': EDGE });
    }
    send(res, 404, 'text/plain; charset=utf-8', 'Introuvable');
  } catch (e) {
    console.error('requête :', e.message);
    if (!res.headersSent) send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: e.message }));
  }
}

module.exports = handler;
module.exports.handler = handler;
module.exports._t = { parseRelease, langOk, parseTorznab, parseDvds, evalMovie, evalSeries, addEntry, core, cycle, KEY, kv, getConfig };

/* ------------------------------------------------------------------ exécution locale (node index.js) */
if (require.main === module) {
  http.createServer(handler).listen(PORT, () => {
    log(`Sorties récentes en écoute sur http://localhost:${PORT}  (stockage : ${kv.remote ? 'Upstash' : 'fichiers ./data/kv'})`);
    log(`  installation : /configure   |   dashboard : /admin${process.env.ADMIN_PASSWORD ? '' : '  (ADMIN_PASSWORD non défini : désactivé)'}`);
    setTimeout(cycle, 5000);
    setInterval(cycle, 30 * 60e3);
  });
}
