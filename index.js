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
 * Mise à jour : automatique (déclenchée quand Stremio charge un catalogue et que les données ont plus de N min,
 * réglable dans le dashboard), plus /cron en option.
 * Variables : ADMIN_PASSWORD (dashboard)  CRON_SECRET (protège /cron, optionnel)  + Upstash (KV_REST_API_URL/TOKEN)
 * Optionnelles : CYCLE_BUDGET_S (50)  TRACKER_DELAY_MS (1500)  DVDS (0 = désactiver)  DVDS_URL  PORT (local)
 */
const http = require('http');
const crypto = require('crypto');
const { addonBuilder } = require('stremio-addon-sdk');
const kv = require('./lib/storage');
let waitUntil = null; // Vercel : permet de terminer un cycle après avoir répondu à Stremio
try { waitUntil = require('@vercel/functions').waitUntil; } catch { /* hors Vercel */ }

/* ------------------------------------------------------------------ constantes */
const HOUR = 3600e3, DAY = 24 * HOUR;
const PORT = +process.env.PORT || 7000;
const CYCLE_BUDGET_MS = (+process.env.CYCLE_BUDGET_S || 50) * 1000; // doit rester < maxDuration de vercel.json (60 s)
const SAVE_MARGIN_MS = 12000;   // temps réservé à la sauvegarde en fin de cycle
const TRACKER_DELAY_MS = process.env.TRACKER_DELAY_MS !== undefined ? +process.env.TRACKER_DELAY_MS : 1500; // politesse envers les trackers
const DVDS_ON = process.env.DVDS !== '0';
const DVDS_URL = process.env.DVDS_URL || 'https://www.dvdsreleasedates.com/digital-releases/';
const SEEN_KEEP_MS = 30 * DAY;  // durée de conservation des infohash déjà traités
const PAGE = 50;
const UA = 'StremioSortiesRecentes/3.0';
const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342';
const MOVIE_CATS = '2000,2010,2030,2060,2070,2080,2090';
const SERIES_CATS = '5000,5070,5080';
const LANGS = ['all', 'vf', 'vff'];
const LANG_NAMES = { all: 'Toutes les versions', vf: 'VF (VFQ incluse)', vff: 'VFF / VF2 uniquement' };
const KEY = { config: 'sr:config', run: 'sr:run', lock: 'sr:lock', dvds: 'sr:dvds', log: 'sr:log', auto: 'sr:auto', new: l => 'sr:new:' + l, newseen: 'sr:newseen', items: l => 'sr:items:' + l, seen: l => 'sr:seen:' + l };

const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = t => new Date(t).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
const seenKey = h => h.slice(0, 20); // clé compacte pour rester loin de la limite de taille des valeurs

/* ------------------------------------------------------------------ configuration (dashboard) */
const TITLE_FORMATS = ['plain', 'episode', 'episode_date', 'date_only'];
const LISTS = { autoRefreshMin: [0, 15, 30, 60, 120, 360], digitalDays: [3, 7, 14, 30], episodeHours: [24, 48, 72, 168], seasonDays: [3, 7, 14], keepDays: [7, 14, 30, 60], newHours: [12, 24, 48, 72, 168] };
const pick = (list, v, def) => list.includes(+v) ? +v : def;
let cfgCache = null, cfgAt = 0;
async function getConfig(force) {
  if (!force && cfgCache && Date.now() - cfgAt < 30000) return cfgCache;
  const c = (await kv.get(KEY.config)) || {};
  cfgCache = {
    tmdbKey: c.tmdbKey || '', streamInfo: !!c.streamInfo, trackers: Array.isArray(c.trackers) ? c.trackers : [],
    autoRefreshMin: pick(LISTS.autoRefreshMin, c.autoRefreshMin, 30), // 0 = désactivé
    titleFormat: TITLE_FORMATS.includes(c.titleFormat) ? c.titleFormat : 'episode',
    movieFirstTorrent: c.movieFirstTorrent === undefined ? true : !!c.movieFirstTorrent,
    digitalDays: pick(LISTS.digitalDays, c.digitalDays, 7), episodeHours: pick(LISTS.episodeHours, c.episodeHours, 48),
    seasonDays: pick(LISTS.seasonDays, c.seasonDays, 7), keepDays: pick(LISTS.keepDays, c.keepDays, 30),
    newTorrents: c.newTorrents === undefined ? true : !!c.newTorrents, // catalogues « Nouveaux torrents »
    newHours: pick(LISTS.newHours, c.newHours, 24), newHideCam: c.newHideCam === undefined ? true : !!c.newHideCam,
  };
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
  const cam = /(?<![A-Za-z0-9])(CAM|HDCAM|TS|TC|TELESYNC|TELECINE)(?![A-Za-z0-9])/i.test(s);
  return {
    name, year, tags,
    season: ep ? +ep[1] : se ? +se[1] : null,
    episode: ep ? +ep[2] : null,
    isVF: ANY_VF.some(t => tags.has(t)),
    strictVFF: STRICT_VFF.some(t => tags.has(t)),
    webOrBd: web && !bad, cam,
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
const daysAgo = t => Math.round((Date.now() - t) / DAY);
const R0 = { digitalDays: 7, episodeHours: 48, seasonDays: 7, movieFirstTorrent: true }; // règles d'origine
const rulesOf = c => ({ digitalDays: c.digitalDays, episodeHours: c.episodeHours, seasonDays: c.seasonDays, movieFirstTorrent: c.movieFirstTorrent });

// « Premier torrent » : retourne null si valide, sinon la raison du refus.
// strictCinema = film sans aucune date numérique/physique (règle d'origine : sortie cinéma il y a 30 à 183 jours).
async function premierTorrent(env, it, rel, d, tmdbId, cinema, now, strictCinema) {
  if (!rel.webOrBd) return 'release pas en WEB/BluRay (HDTV, CAM, TS… refusés)';
  const rd = Date.parse(d.release_date);
  if (isNaN(rd)) return 'date de sortie du film inconnue';
  if (rd > now) return 'film pas encore sorti';
  if (now - rd >= 365 * DAY) return 'film sorti le ' + fmt(rd) + ' (plus d\'un an)';
  if (strictCinema) {
    if (cinema == null) return 'aucune sortie cinéma connue';
    const age = (now - cinema) / DAY;
    if (age < 30 || age > 183) return 'sortie cinéma il y a ' + Math.round(age) + ' j (hors de 30–183 j)';
  }
  const h = await history(it.tr, tmdbId);
  if (h.length >= 100) return 'historique du tracker incomplet (' + h.length + ' résultats : le tracker ignore peut-être le filtre tmdbid)';
  if (!h.length) return 'historique du tracker vide';
  if (!h.some(x => x.hash === it.hash)) return 'ce torrent n\'apparaît pas dans l\'historique du tracker';
  for (const tr of env.trackers) { // plusieurs trackers : aucun ne doit avoir de torrent de ce film de plus de 3 jours
    const hh = tr.id === it.tr.id ? h : await history(tr, tmdbId);
    if (hh.length >= 100) return 'historique de ' + tr.name + ' incomplet (' + hh.length + ' résultats)';
    const old = hh.find(x => !(x.pub > 0) || x.pub < now - 3 * DAY);
    if (old) return 'un torrent de ce film existe déjà sur ' + tr.name + ' depuis plus de 3 jours (' + (old.pub > 0 ? fmt(old.pub) : 'date inconnue') + ')';
  }
  return null;
}
// VF/VFF : premier torrent de cette langue (aucun torrent de la langue depuis plus de 3 jours). null si valide.
async function firstOfLang(env, it, orig, tmdbId, now) {
  const all = new Map();
  for (const tr of env.trackers) {
    const h = await history(tr, tmdbId);
    if (h.length >= 100) return 'historique de ' + tr.name + ' incomplet (' + h.length + ' résultats)'; // au moindre doute, non
    for (const x of h) all.set(x.hash, x);
  }
  if (!all.has(it.hash)) all.set(it.hash, it);
  for (const x of all.values()) {
    if (!langOk(env.l, parseRelease(x.title), orig, 'movie')) continue;
    if (!(x.pub > 0) || x.pub < now - 3 * DAY) return 'un torrent dans cette langue existe déjà depuis plus de 3 jours (' + (x.pub > 0 ? fmt(x.pub) : 'date inconnue') + ')';
  }
  return null;
}

async function evalMovie(env, it, rel) {
  const now = Date.now(), R = env.rules || R0;
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
    if (dig != null && now - dig <= R.digitalDays * DAY) date = dig; // une date future passe aussi
    else if (dig != null) { // sortie numérique ancienne : accepté seulement si c'est le premier torrent d'un film récent
      const why = R.movieFirstTorrent ? await premierTorrent(env, it, rel, d, id, cinema, now, false) : 'option « premier torrent » désactivée';
      if (why) return rej('sortie numérique le ' + fmt(dig) + ' (il y a ' + daysAgo(dig) + ' j, au-delà de ' + R.digitalDays + ' j) ; premier torrent refusé : ' + why);
      date = it.pub > 0 ? it.pub : now; dateLabel = 'Torrent du';
    } else {
      const why = await premierTorrent(env, it, rel, d, id, cinema, now, true);
      if (why) return rej('aucune date numérique connue ; premier torrent refusé : ' + why);
      date = it.pub > 0 ? it.pub : now; dateLabel = 'Torrent du';
    }
  } else {
    const ld = relDate(d, env.l === 'vf' ? ['FR', 'CA'] : ['FR'], [4, 5]);
    if (ld != null && now - ld <= R.digitalDays * DAY) date = ld;
    else {
      const lab = env.l === 'vf' ? 'FR/CA' : 'FR';
      const base = ld != null ? 'sortie numérique ' + lab + ' le ' + fmt(ld) + ' (il y a ' + daysAgo(ld) + ' j)' : 'aucune sortie numérique ' + lab + ' connue';
      const lim = new Date(now); lim.setMonth(lim.getMonth() - 8);
      if (cinema == null || cinema > now || cinema < lim.getTime()) return rej(base + ' ; sortie cinéma ' + (cinema == null ? 'inconnue' : 'le ' + fmt(cinema)) + ' hors fenêtre de 8 mois');
      const why = await firstOfLang(env, it, d.original_language, id, now);
      if (why) return rej(base + ' ; premier torrent de cette langue refusé : ' + why);
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
  const now = Date.now(), R = env.rules || R0;
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
    if (!air) return rej("date de diffusion de l'épisode inconnue sur TMDB");
    if (now - air > R.episodeHours * HOUR) return rej('épisode diffusé le ' + fmt(air) + ' (il y a ' + Math.round((now - air) / HOUR) + ' h, au-delà de ' + R.episodeHours + ' h)');
    date = air; label = 'S' + String(rel.season).padStart(2, '0') + 'E' + String(rel.episode).padStart(2, '0');
  } else {
    const s = await tmdb(env, `/tv/${id}/season/${rel.season}`);
    const aired = ((s && s.episodes) || []).map(x => Date.parse(x.air_date)).filter(t => t && t <= now);
    if (!aired.length) return rej('aucun épisode diffusé dans cette saison sur TMDB');
    date = Math.max(...aired);
    if (now - date > R.seasonDays * DAY) return rej('dernier épisode de la saison diffusé le ' + fmt(date) + ' (il y a ' + daysAgo(date) + ' j, au-delà de ' + R.seasonDays + ' j)');
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

// Résumé des dates TMDB d'un titre (outil de diagnostic)
async function describe(env, it, rel, kind) {
  const id = await resolveTmdb(env, it, rel, kind);
  if (!id) return { error: 'titre introuvable sur TMDB' };
  const f = t => t == null ? '—' : fmt(t);
  if (kind === 'movie') {
    const d = await tmdb(env, '/movie/' + id, { append_to_response: 'release_dates,external_ids' });
    if (!d) return { error: 'film introuvable sur TMDB' };
    const imdb = d.imdb_id || (d.external_ids && d.external_ids.imdb_id);
    const dv = imdb ? (await dvds()).get(imdb) : null;
    return { tmdbId: id, title: d.title, year: (d.release_date || '').slice(0, 4), imdb: imdb || null, lines: [
      ['Sortie principale', d.release_date ? f(Date.parse(d.release_date)) : '—'], ['Cinéma (FR/US/CA)', f(relDate(d, ['FR', 'US', 'CA'], [2, 3]))],
      ['Numérique FR', f(relDate(d, ['FR'], [4]))], ['Numérique US', f(relDate(d, ['US'], [4]))], ['Numérique CA', f(relDate(d, ['CA'], [4]))],
      ['Physique FR/US/CA', f(relDate(d, ['FR', 'US', 'CA'], [5]))], ['dvdsreleasedates (US)', f(dv)],
    ] };
  }
  const d = await tmdb(env, '/tv/' + id, { append_to_response: 'external_ids' });
  if (!d) return { error: 'série introuvable sur TMDB' };
  const lines = [['Première diffusion', d.first_air_date ? f(Date.parse(d.first_air_date)) : '—']];
  if (rel.season != null && rel.episode != null) {
    const e = await tmdb(env, `/tv/${id}/season/${rel.season}/episode/${rel.episode}`);
    lines.push(['Épisode S' + String(rel.season).padStart(2, '0') + 'E' + String(rel.episode).padStart(2, '0') + ' diffusé le', e && e.air_date ? f(Date.parse(e.air_date)) : '—']);
  }
  return { tmdbId: id, title: d.name, year: (d.first_air_date || '').slice(0, 4), imdb: (d.external_ids && d.external_ids.imdb_id) || null, lines };
}

/* ------------------------------------------------------------------ « Nouveaux torrents » (sans règle de date) */
function qualityOf(t) {
  const r = (t.match(/(?<![A-Za-z0-9])(2160p|4K|UHD|1080p|720p|480p)(?![A-Za-z0-9])/i) || [])[1];
  const q = (t.match(/(?<![A-Za-z0-9])(REMUX|BLU[-.]?RAY|BDRIP|WEB[-.]?DL|WEB[-.]?RIP|WEB|HDTV|HDCAM|CAM|TELESYNC|TS|TC)(?![A-Za-z0-9])/i) || [])[1];
  return [r ? (/p$/i.test(r) ? r.toLowerCase() : r.toUpperCase()) : '', q ? q.toUpperCase().replace('.', '-') : ''].filter(Boolean).join(' ');
}
// Un torrent posté récemment devient une entrée du catalogue « Nouveaux torrents » : seule l'identification TMDB compte.
async function buildNew(env, it, rel) {
  if (it.kind === 'series' && rel.season == null) return null;
  const id = await resolveTmdb(env, it, rel, it.kind);
  if (!id) return null;
  const when = new Date(it.pub).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '');
  const tail = [qualityOf(it.title), rel.label].filter(Boolean);
  if (it.kind === 'movie') {
    const d = await tmdb(env, '/movie/' + id, { append_to_response: 'external_ids' });
    const imdb = d && (d.imdb_id || (d.external_ids && d.external_ids.imdb_id));
    if (!imdb) return null;
    return { orig: d.original_language, entry: { id: imdb, type: 'movie', anime: false, name: d.title || d.original_title || rel.name,
      poster: d.poster_path ? IMG + d.poster_path : undefined, year: (d.release_date || '').slice(0, 4), ts: it.pub, date: it.pub,
      desc: ['Torrent du ' + when, ...tail].join(' · ') } };
  }
  const d = await tmdb(env, '/tv/' + id, { append_to_response: 'external_ids' });
  const imdb = d && d.external_ids && d.external_ids.imdb_id;
  if (!imdb) return null;
  const label = rel.episode != null ? 'S' + String(rel.season).padStart(2, '0') + 'E' + String(rel.episode).padStart(2, '0') : 'Saison ' + rel.season + ' complète';
  const anime = (d.genres || []).some(g => g.id === 16) && (d.original_language === 'ja' || (d.origin_country || []).includes('JP'));
  return { orig: d.original_language, entry: { id: imdb, type: 'series', anime, name: d.name || d.original_name || rel.name,
    poster: d.poster_path ? IMG + d.poster_path : undefined, year: (d.first_air_date || '').slice(0, 4), ts: it.pub, date: it.pub,
    season: rel.season, episode: rel.episode, desc: [label, 'torrent du ' + when, ...tail].join(' · ') } };
}
function addNew(list, e) { // un titre n'apparaît qu'une fois (le torrent le plus récent l'emporte)
  const i = list.findIndex(x => x.id === e.id && x.type === e.type);
  if (i >= 0) { if (list[i].ts >= e.ts) return; list.splice(i, 1); }
  list.push(e); list.sort((a, b) => b.ts - a.ts);
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
    if (!cfg.tmdbKey) return { skipped: true, message: 'Clé TMDB manquante : ajoutez-la dans l\'onglet Réglages.' };
    if (!trackers.length) return { skipped: true, message: 'Aucun tracker actif : ajoutez-en un dans l\'onglet Trackers.' };
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
    const newWin = cfg.newHours * HOUR, newLists = {}, newSeen = cfg.newTorrents ? (await kv.get(KEY.newseen)) || {} : {};
    for (const l of LANGS) newLists[l] = cfg.newTorrents ? (await kv.get(KEY.new(l))) || [] : [];
    const needsNew = x => cfg.newTorrents && x.pub > 0 && Date.now() - x.pub <= newWin && !newSeen[seenKey(x.hash)];
    const todo = [...uniq.values()].filter(x => needsNew(x) || LANGS.some(l => !langs[l].seen[seenKey(x.hash)])).sort((a, b) => (b.pub || 0) - (a.pub || 0)); // les plus récents d'abord
    const stats = Object.fromEntries(LANGS.map(l => [l, { neuf: 0, ok: 0, ko: 0, err: 0 }]));
    const rules = rulesOf(cfg);
    const envs = Object.fromEntries(LANGS.map(l => [l, { l, m: cfg.tmdbKey, trackers, rules }]));
    let postponed = 0;
    const journal = []; // décisions de ce cycle (affichées dans l'onglet Journal)
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
          if (r.entry) { addEntry(st, r.entry); stats[lang].ok++; journal.push({ t: Date.now(), lang, title: it.title, kind: 'ok', reason: r.entry.name + ' — ' + r.entry.desc, tr: it.tr.name }); log(`[${lang}] + ${r.entry.name} (${r.entry.desc})`); }
          else { stats[lang].ko++; if (lang === 'all') journal.push({ t: Date.now(), lang, title: it.title, kind: 'ko', reason: r.reason, tr: it.tr.name }); if (process.env.DEBUG) log(`[${lang}] - ${it.title} : ${r.reason}`); }
        } catch (e) { stats[lang].err++; journal.push({ t: Date.now(), lang, title: it.title, kind: 'err', reason: e.message, tr: it.tr.name }); log(`[${lang}] erreur transitoire, sera retenté : ${it.title} : ${e.message}`); }
      }
      if (needsNew(it)) { // catalogue « Nouveaux torrents » : tout torrent posté récemment et identifiable
        try {
          const res = rel.cam && cfg.newHideCam ? null : await buildNew(envs.all, it, rel);
          if (res) for (const l of LANGS) if (langOk(l, rel, res.orig, it.kind)) addNew(newLists[l], { ...res.entry });
          newSeen[seenKey(it.hash)] = Math.floor(Date.now() / 60000);
          stats.all.nouveaux = (stats.all.nouveaux || 0) + (res ? 1 : 0);
        } catch (e) { log(`[nouveaux] erreur transitoire : ${it.title} : ${e.message}`); }
      }
    });
    const now = Date.now();
    for (const l of LANGS) {
      const st = langs[l];
      st.items = st.items.filter(x => x.ts > now - cfg.keepDays * DAY);
      for (const [h, m] of Object.entries(st.seen)) if (m * 60000 < now - SEEN_KEEP_MS) delete st.seen[h];
      await kv.set(KEY.items(l), st.items);
      await kv.set(KEY.seen(l), st.seen);
    }
    if (cfg.newTorrents) {
      for (const l of LANGS) { newLists[l] = newLists[l].filter(x => x.ts > now - newWin); await kv.set(KEY.new(l), newLists[l]); }
      for (const [h, m] of Object.entries(newSeen)) if (m * 60000 < now - 3 * DAY) delete newSeen[h];
      await kv.set(KEY.newseen, newSeen);
    }
    if (journal.length) { journal.sort((a, b) => b.t - a.t); await kv.set(KEY.log, journal.concat((await kv.get(KEY.log)) || []).slice(0, 400)); }
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
const NEW_CATALOGS = [
  { type: 'movie', id: 'sr-new-films', name: 'Nouveaux torrents · Films' },
  { type: 'series', id: 'sr-new-series', name: 'Nouveaux torrents · Séries' },
];
function buildManifest(lang, cfg) {
  const streamInfo = cfg.streamInfo;
  const m = {
    id: 'community.sorties.recentes', version: '3.0.0', name: 'Sorties récentes',
    description: 'Catalogues des films, séries et animés qui viennent de sortir en torrent — ' + LANG_NAMES[lang] + '.',
    resources: streamInfo ? ['catalog', 'stream'] : ['catalog'],
    types: ['movie', 'series'],
    catalogs: CATALOGS.concat(cfg.newTorrents ? NEW_CATALOGS : []).map(c => ({ ...c, extra: [{ name: 'skip' }] })),
    behaviorHints: { configurable: true },
  };
  if (streamInfo) m.idPrefixes = ['tt'];
  const b = new addonBuilder(m); // valide le manifest avec le SDK officiel
  b.defineCatalogHandler(async () => ({ metas: [] }));
  if (streamInfo) b.defineStreamHandler(async () => ({ streams: [] }));
  return b.getInterface().manifest || m;
}
const shortDate = t => new Date(t).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit' });
function displayName(x, format) { // titre affiché sous l'affiche dans Stremio
  if (format === 'plain') return x.name;
  if (format === 'date_only') { // sans le titre : l'affiche suffit
    const d = x.date ? shortDate(x.date) : '';
    if (x.type === 'series') return [String(x.desc || '').split(' · ')[0], d].filter(Boolean).join(' · ') || x.name;
    return d ? (String(x.desc || '').startsWith('Torrent') ? 'Torrent du ' : 'Sortie le ') + d : x.name;
  }
  const label = x.type === 'series' ? String(x.desc || '').split(' · ')[0] : '';
  const date = format === 'episode_date' && x.date ? shortDate(x.date) : '';
  const extra = [label, date].filter(Boolean).join(' · ');
  return extra ? x.name + ' · ' + extra : x.name;
}
async function catalog(lang, id, skip) {
  const cfg = await getConfig(), format = cfg.titleFormat;
  const fresh = id.startsWith('sr-new');
  if (fresh && !cfg.newTorrents) return [];
  const items = (await kv.get(fresh ? KEY.new(lang) : KEY.items(lang))) || [];
  const list = fresh ? items.filter(x => x.ts > Date.now() - cfg.newHours * HOUR && (id === 'sr-new-films' ? x.type === 'movie' : x.type === 'series'))
    : items.filter(x => id === 'sr-films' ? x.type === 'movie' : id === 'sr-animes' ? x.type === 'series' && x.anime : x.type === 'series' && !x.anime);
  return list.slice(skip, skip + PAGE).map(x => ({
    id: x.id, type: x.type, name: displayName(x, format), poster: x.poster, releaseInfo: x.year || undefined, description: x.desc,
  }));
}
async function streamsFor(lang, type, id) { // ligne d'information (option du dashboard) : ce n'est pas un flux lisible
  const [imdb, s, e] = id.split(':');
  let en = ((await kv.get(KEY.items(lang))) || []).find(x => x.id === imdb && x.type === type), nouveau = false;
  if (!en) { en = ((await kv.get(KEY.new(lang))) || []).find(x => x.id === imdb && x.type === type); nouveau = true; }
  if (!en) return [];
  if (type === 'series') {
    if (en.season != null && s != null && +s !== en.season) return [];
    if (en.episode != null && e != null && +e !== en.episode) return [];
  }
  return [{ name: nouveau ? '⏱ Nouveau torrent' : '🆕 Sortie récente', description: en.desc, externalUrl: `stremio:///detail/${type}/${imdb}` }];
}

// Mise à jour automatique : quand Stremio charge un catalogue et que le dernier essai date de plus de N minutes
async function maybeAutoRefresh() {
  try {
    const cfg = await getConfig();
    if (!cfg.autoRefreshMin || !cfg.tmdbKey || !cfg.trackers.some(t => t.enabled)) return;
    if (!(await kv.setNx(KEY.auto, Date.now(), cfg.autoRefreshMin * 60))) return; // déjà tenté récemment
    const p = cycle().catch(e => log('auto :', e.message));
    if (waitUntil) waitUntil(p);
  } catch (e) { log('auto :', e.message); }
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
    let latestAll = [];
    for (const l of LANGS) {
      const it = (await kv.get(KEY.items(l))) || [];
      if (l === 'all') latestAll = it;
      counts[l] = { movies: it.filter(x => x.type === 'movie').length, series: it.filter(x => x.type === 'series' && !x.anime).length, anime: it.filter(x => x.anime).length };
    }
    const activity = []; // titres validés par jour (version « Toutes »), 14 derniers jours
    for (let i = 13; i >= 0; i--) {
      const t0 = new Date(); t0.setUTCHours(0, 0, 0, 0); const a = t0.getTime() - i * DAY;
      activity.push({ d: new Date(a).toLocaleDateString('fr-FR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' }), n: latestAll.filter(x => x.ts >= a && x.ts < a + DAY).length });
    }
    const autoAt = +(await kv.get(KEY.auto)) || 0;
    const newAll = cfg.newTorrents ? ((await kv.get(KEY.new('all'))) || []).filter(x => x.ts > Date.now() - cfg.newHours * HOUR) : [];
    return {
      langs: LANG_NAMES,
      trackers: cfg.trackers.map(t => ({ id: t.id, name: t.name, url: t.url, keyHint: mask(t.apikey), enabled: t.enabled, status: (run.trackerStatus || {})[t.id] || null })),
      tmdb: { set: !!cfg.tmdbKey, hint: mask(cfg.tmdbKey) },
      settings: { streamInfo: cfg.streamInfo, autoRefreshMin: cfg.autoRefreshMin, titleFormat: cfg.titleFormat, newTorrents: cfg.newTorrents, newHours: cfg.newHours, newHideCam: cfg.newHideCam, movieFirstTorrent: cfg.movieFirstTorrent, digitalDays: cfg.digitalDays, episodeHours: cfg.episodeHours, seasonDays: cfg.seasonDays, keepDays: cfg.keepDays },
      latest: latestAll.slice(0, 8).map(x => ({ id: x.id, type: x.type, anime: x.anime, name: x.name, desc: x.desc, ts: x.ts, poster: x.poster })),
      newest: newAll.slice(0, 8).map(x => ({ id: x.id, type: x.type, anime: x.anime, name: x.name, desc: x.desc, ts: x.ts, poster: x.poster })), newCount: newAll.length,
      activity, autoNext: autoAt && cfg.autoRefreshMin ? autoAt + cfg.autoRefreshMin * 60000 : null,
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
  async setSettings(o) {
    const c = await getConfig(true);
    if ('streamInfo' in o) c.streamInfo = !!o.streamInfo;
    if ('movieFirstTorrent' in o) c.movieFirstTorrent = !!o.movieFirstTorrent;
    if ('newTorrents' in o) c.newTorrents = !!o.newTorrents;
    if ('newHideCam' in o) c.newHideCam = !!o.newHideCam;
    for (const k of Object.keys(LISTS)) if (k in o) {
      const n = +o[k]; if (!LISTS[k].includes(n)) throw new Error('Valeur invalide (' + k + ')');
      c[k] = n; if (k === 'autoRefreshMin') await kv.del(KEY.auto);
    }
    if ('titleFormat' in o) { if (!TITLE_FORMATS.includes(o.titleFormat)) throw new Error('Format invalide'); c.titleFormat = o.titleFormat; }
    await saveConfig(c);
  },
  async removeItem(id, type) { // retire un titre de tous les catalogues
    let n = 0;
    for (const l of LANGS) {
      const items = (await kv.get(KEY.items(l))) || [], keep = items.filter(x => !(x.id === id && x.type === type));
      if (keep.length !== items.length) { n++; await kv.set(KEY.items(l), keep); }
      const fr = (await kv.get(KEY.new(l))) || [], fk = fr.filter(x => !(x.id === id && x.type === type));
      if (fk.length !== fr.length) { n++; await kv.set(KEY.new(l), fk); }
    }
    if (!n) throw new Error('Titre introuvable');
  },
  async explain(q) { // cherche une release sur les trackers et explique la décision pour chaque version
    q = String(q || '').trim();
    if (q.length < 2) throw new Error('Saisissez au moins 2 caractères');
    const cfg = await getConfig(true), trackers = cfg.trackers.filter(t => t.enabled);
    if (!cfg.tmdbKey) throw new Error('Clé TMDB manquante');
    if (!trackers.length) throw new Error('Aucun tracker actif');
    const errors = [], found = new Map();
    for (const tr of trackers) {
      try { for (const x of parseTorznab(await trackerGet(tzUrl(tr, { t: 'search', q, limit: 20 })))) if (!found.has(x.hash)) found.set(x.hash, { ...x, tr }); }
      catch (e) { errors.push(tr.name + ' : ' + e.message); }
    }
    const list = [...found.values()].sort((a, b) => (b.pub || 0) - (a.pub || 0)).slice(0, 4);
    const rules = rulesOf(cfg), results = [];
    for (const it of list) {
      const rel = parseRelease(it.title);
      it.kind = it.cats.some(c => c >= 5000 && c < 6000) || rel.episode != null || (rel.season != null && !it.cats.some(c => c >= 2000 && c < 3000)) ? 'series' : 'movie';
      const row = { title: it.title, tracker: it.tr.name, pub: it.pub || null, kind: it.kind, cats: it.cats, tmdbid: it.tmdbid || null, info: null, verdicts: {} };
      try { row.info = await describe({ l: 'all', m: cfg.tmdbKey, trackers, rules }, it, rel, it.kind); } catch (e) { row.info = { error: e.message }; }
      for (const lang of LANGS) {
        try {
          const env = { l: lang, m: cfg.tmdbKey, trackers, rules };
          const r = it.kind === 'series' ? await evalSeries(env, it, rel) : await evalMovie(env, it, rel);
          row.verdicts[lang] = r.entry ? { ok: true, text: r.entry.name + ' — ' + r.entry.desc } : { ok: false, text: r.reason };
        } catch (e) { row.verdicts[lang] = { ok: false, err: true, text: 'Erreur : ' + e.message }; }
      }
      results.push(row);
    }
    return { query: q, errors, total: found.size, results };
  },
  async getLog() { return (await kv.get(KEY.log)) || []; },
  async clearLog() { await kv.del(KEY.log); },
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
      if (what !== 'seen') { await kv.set(KEY.items(l), []); await kv.set(KEY.new(l), []); } // vider les catalogues
      await kv.set(KEY.seen(l), {});                        // et/ou retraiter aussi les torrents rejetés
    }
    await kv.del(KEY.newseen);
  },
  async catalog(lang, fresh) {
    if (!LANGS.includes(lang)) throw new Error('Langue inconnue');
    const cfg = await getConfig();
    const src = fresh ? ((await kv.get(KEY.new(lang))) || []).filter(x => x.ts > Date.now() - cfg.newHours * HOUR) : (await kv.get(KEY.items(lang))) || [];
    return src.map(x => ({ id: x.id, type: x.type, anime: x.anime, name: x.name, year: x.year, desc: x.desc, ts: x.ts, poster: x.poster }));
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
    if (seg.length === 1 && seg[0] === 'manifest.json') return json(res, buildManifest('all', await getConfig()), { 'Cache-Control': 'public, s-maxage=60' });
    const lang = seg[0], rest = seg.slice(1);
    if (!LANGS.includes(lang)) return send(res, 404, 'text/plain; charset=utf-8', 'Introuvable');
    if (rest[0] === 'configure') return configure(req, res, lang);
    if (rest[0] === 'manifest.json') return json(res, buildManifest(lang, await getConfig()), { 'Cache-Control': 'public, s-maxage=60' });
    if (rest.length) rest[rest.length - 1] = rest[rest.length - 1].replace(/\.json$/, '');
    if (rest[0] === 'catalog' && rest.length >= 3) {
      const skip = rest.length > 3 ? parseInt(new URLSearchParams(rest[3]).get('skip'), 10) || 0 : 0;
      await maybeAutoRefresh();
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
