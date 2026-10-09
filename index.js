'use strict';
/*
 * Sorties annoncées — addon Stremio (catalogues uniquement) — version Vercel
 *
 *   1. un canal Telegram public publie une image d'annonce (le titre est dans l'image)
 *   2. l'IA gratuite de Google (Gemini) lit l'image et donne le titre
 *   3. l'addon cherche le titre sur TMDB (affiche, ID IMDb, date) -> la sortie apparaît dans Stremio
 *   4. l'addon vérifie régulièrement sur vos trackers (API Torznab) si le torrent est sorti
 *   5. dès que c'est le cas : badge ✅ dans Stremio + notification Discord / Telegram
 *
 * Les cas incertains (titre ambigu, texte mal lu) vont dans une file « À vérifier » du dashboard.
 *
 * Fichiers :   api/index.js              entrée Vercel (une seule fonction pour toutes les routes)
 *              index.js                  moteur + routes (ce fichier)
 *              lib/telegram.js           lecture du canal, images, Gemini, ressemblance de titres
 *              lib/storage.js            stockage Upstash Redis (ou fichiers en local)
 *              dashboard/*               /admin (mot de passe) et /configure
 *
 * Vercel n'a pas de processus permanent : un « cycle » est déclenché quand Stremio ouvre un catalogue
 * (si les données ont plus de N minutes) et/ou par GET /cron?key=CRON_SECRET (cron-job.org, gratuit).
 *
 * Variables : ADMIN_PASSWORD (dashboard)  CRON_SECRET (protège /cron)  KV_REST_API_URL / KV_REST_API_TOKEN (Upstash)
 * Optionnelles : CYCLE_BUDGET_S (50)  TRACKER_DELAY_MS (1500)  PORT (local)
 */
const http = require('http');
const crypto = require('crypto');
const kv = require('./lib/storage');
const tgm = require('./lib/telegram');
let waitUntil = null; // Vercel : permet de terminer un cycle après avoir répondu à Stremio
try { waitUntil = require('@vercel/functions').waitUntil; } catch { /* hors Vercel */ }

/* ------------------------------------------------------------------ constantes */
const HOUR = 3600e3, DAY = 24 * HOUR;
const PORT = +process.env.PORT || 7000;
const CYCLE_BUDGET_MS = (+process.env.CYCLE_BUDGET_S || 50) * 1000; // doit rester < maxDuration de vercel.json (60 s)
const TRACKER_DELAY_MS = process.env.TRACKER_DELAY_MS !== undefined ? +process.env.TRACKER_DELAY_MS : 1500; // politesse envers les trackers
const UA = 'StremioSortiesAnnoncees/5.0';
const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342';
const MOVIE_CATS = '2000,2010,2030,2060,2070,2080,2090';
const SERIES_CATS = '5000,5070,5080';
const PAGE = 50;
const LEGACY_LANGS = ['all', 'vf', 'vff']; // anciennes URL d'installation (/all/manifest.json…) : toujours acceptées
const TITLE_FORMATS = ['plain', 'episode', 'episode_date', 'date_only'];
const LISTS = { autoRefreshMin: [0, 15, 30, 60, 120, 360], keepDays: [3, 7, 14, 30], minRes: [0, 480, 720, 1080, 2160] };
const KEY = { config: 'sr:config', run: 'sr:run', runs: 'sr:runs', lock: 'sr:lock', auto: 'sr:auto', notified: 'sr:notified',
  tg: 'sr:tg', items: 'sr:tgitems', review: 'sr:tgreview', log: 'sr:tglog' };

const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = t => new Date(t).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
const shortDate = t => new Date(t).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit' });
const pad2 = n => String(n).padStart(2, '0');
const pick = (list, v, def) => list.includes(+v) ? +v : def;
const mask = k => k ? '••••' + k.slice(-4) : '';

/* ------------------------------------------------------------------ configuration (dashboard) */
let cfgCache = null, cfgAt = 0;
async function getConfig(force) {
  if (!force && cfgCache && Date.now() - cfgAt < 30000) return cfgCache;
  const c = (await kv.get(KEY.config)) || {}, tg = c.tg || {}, n = c.notify || {};
  cfgCache = {
    tmdbKey: c.tmdbKey || '',
    trackers: Array.isArray(c.trackers) ? c.trackers : [],
    streamInfo: !!c.streamInfo,                                                        // ligne d'info dans la liste des flux
    titleFormat: TITLE_FORMATS.includes(c.titleFormat) ? c.titleFormat : 'episode_date',
    autoRefreshMin: pick(LISTS.autoRefreshMin, c.autoRefreshMin, 30),                  // 0 = désactivé
    keepDays: pick(LISTS.keepDays, c.keepDays !== undefined ? c.keepDays : tg.keepDays, 7),
    minRes: pick(LISTS.minRes, c.minRes, 0),                                           // qualité minimale d'un torrent « disponible »
    hideCam: c.hideCam !== undefined ? !!c.hideCam : c.newHideCam !== false,           // ignorer les CAM / TS
    blocked: Array.isArray(c.blocked) ? c.blocked.slice(0, 300) : [],                  // titres masqués définitivement
    tg: { enabled: !!tg.enabled, channel: tgm.CHANNEL_RE.test(tg.channel || '') ? tg.channel : 'APPROTV', geminiKey: String(tg.geminiKey || ''),
      model: /^[\w.\-]{3,60}$/.test(tg.model || '') ? tg.model : 'gemini-flash-latest' },
    notify: { discord: String(n.discord || ''), telegramToken: String(n.telegramToken || ''), telegramChat: String(n.telegramChat || ''),
      onAnnounce: !!n.onAnnounce, onAvailable: n.onAvailable !== false },
    bot: { token: String((c.bot || {}).token || ''), owner: String((c.bot || {}).owner || ''), code: String((c.bot || {}).code || ''), secret: String((c.bot || {}).secret || ''), username: String((c.bot || {}).username || '') },
    legacyPurged: !!c.legacyPurged,
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
  if (cache.size > 2000) { const n = Date.now(); for (const [k, x] of cache) if (x.exp < n) cache.delete(k); if (cache.size > 2000) cache.clear(); }
  cache.set(key, { v, exp: Date.now() + ttl });
  return v;
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

/* ------------------------------------------------------------------ Torznab (vérification des trackers) */
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
    const attrs = {};
    const ar = /<(?:torznab|newznab):attr\s+name="([^"]+)"\s+value="([^"]*)"/g;
    let a;
    while ((a = ar.exec(b))) if (a[1] !== 'category') attrs[a[1]] = unxml(a[2]);
    const title = tag('title');
    if (!title) continue;
    const guid = tag('guid'), link = tag('link');
    const bt = (attrs.magneturl || link || guid).match(/btih:([0-9a-zA-Z]{32,40})/i);
    const hash = (attrs.infohash || (bt && bt[1]) || crypto.createHash('sha1').update(guid || link || title).digest('hex')).toLowerCase();
    items.push({ hash, title, pub: Date.parse(tag('pubDate')) });
  }
  return items;
}

/* ------------------------------------------------------------------ noms de release */
const QUAL_RE = /(?<![A-Za-z0-9])(\d{3,4}[pi]|4K|UHD|WEB[-.]?DL|WEB[-.]?RIP|WEB|BLU[-.]?RAY|BDRIP|BRRIP|HDRIP|DVDRIP|HDTV|REMUX|[xh]\.?26[45]|HEVC|HDCAM|CAM|TELESYNC|TS|TC)(?![A-Za-z0-9])/i;
const LANG_RE = /(?<![A-Za-z0-9])(TRUEFRENCH|SUBFRENCH|FRENCH|VFF|VFQ|VFI|VF2|VOF|MULTI|VOSTFR|VOSTA)(?![A-Za-z0-9])/i;
const EP_RE = /(?<![A-Za-z0-9])S(\d{1,2})[ .-]?E(\d{1,3})(?!\d)/i;
const SEASON_RE = /(?<![A-Za-z0-9])S(\d{1,2})(?![A-Za-z0-9])/i;
const YEAR_RE = /(?<![A-Za-z0-9])((?:19|20)\d{2})(?![A-Za-z0-9])/g;
const TAG_ORDER = ['TRUEFRENCH', 'VFF', 'VF2', 'VFI', 'VOF', 'VFQ', 'FRENCH', 'MULTI', 'VOSTFR'];
function parseRelease(raw) {
  const s = raw.replace(/_/g, '.');
  const cuts = [];
  const cut = re => { const m = re.exec(s); if (m && m.index > 0) cuts.push(m.index); };
  cut(LANG_RE); cut(QUAL_RE);
  let year = null, yi = -1;
  for (const m of s.matchAll(YEAR_RE)) if (m.index > 0) { year = +m[1]; yi = m.index; } // dernière année
  if (yi > 0) cuts.push(yi);
  const ep = s.match(EP_RE), se = ep ? null : s.match(SEASON_RE);
  if (ep && ep.index > 0) cuts.push(ep.index);
  if (se && se.index > 0) cuts.push(se.index);
  const end = cuts.length ? Math.min(...cuts) : s.length;
  const name = s.slice(0, end).replace(/\./g, ' ').replace(/[\s\-\[\(]+$/, '').trim();
  const tags = new Set();
  for (const m of s.matchAll(new RegExp(LANG_RE.source, 'gi'))) tags.add(m[1].toUpperCase());
  return {
    name, year, season: ep ? +ep[1] : se ? +se[1] : null, episode: ep ? +ep[2] : null,
    cam: /(?<![A-Za-z0-9])(CAM|HDCAM|TS|TC|TELESYNC|TELECINE)(?![A-Za-z0-9])/i.test(s),
    label: TAG_ORDER.filter(t => tags.has(t)).join(' '),
  };
}
function resOf(t) { // résolution annoncée dans le nom (null si inconnue)
  if (/(?<![A-Za-z0-9])(2160p|4K|UHD)(?![A-Za-z0-9])/i.test(t)) return 2160;
  if (/(?<![A-Za-z0-9])1080[pi](?![A-Za-z0-9])/i.test(t)) return 1080;
  if (/(?<![A-Za-z0-9])720p(?![A-Za-z0-9])/i.test(t)) return 720;
  if (/(?<![A-Za-z0-9])(480p|576p|DVDRIP|DVDSCR|SD)(?![A-Za-z0-9])/i.test(t)) return 480;
  return null;
}
function qualityOf(t) {
  const r = (t.match(/(?<![A-Za-z0-9])(2160p|4K|UHD|1080p|720p|480p)(?![A-Za-z0-9])/i) || [])[1];
  const q = (t.match(/(?<![A-Za-z0-9])(REMUX|BLU[-.]?RAY|BDRIP|WEB[-.]?DL|WEB[-.]?RIP|WEB|HDTV|HDCAM|CAM|TELESYNC|TS|TC)(?![A-Za-z0-9])/i) || [])[1];
  return [r ? (/p$/i.test(r) ? r.toLowerCase() : r.toUpperCase()) : '', q ? q.toUpperCase().replace('.', '-') : ''].filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ titres masqués */
const sourceOn = cfg => !!cfg.tg.geminiKey && (cfg.tg.enabled || !!cfg.bot.token); // canal public activé, ou bot relié
const blockedSet = cfg => new Set((cfg.blocked || []).map(b => b.type + ':' + b.id));
const unblocked = (cfg, list) => { if (!cfg.blocked.length) return list; const s = blockedSet(cfg); return list.filter(x => !s.has(x.type + ':' + x.id)); };

/* ------------------------------------------------------------------ notifications (Discord / Telegram) */
const DISCORD_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const TG_TOKEN_RE = /^\d{5,}:[\w-]{20,}$/, TG_CHAT_RE = /^(-?\d{5,20}|@[A-Za-z0-9_]{4,})$/;
async function sendDiscord(url, entries, title) {
  for (let i = 0; i < entries.length; i += 10) {
    const embeds = entries.slice(i, i + 10).map(e => ({ title: String(e.name).slice(0, 250), description: String(e.desc || '').slice(0, 500), color: e.status === 'available' ? 0x10b981 : 0xf97316,
      url: 'https://www.imdb.com/title/' + e.id + '/', thumbnail: e.poster ? { url: e.poster } : undefined, timestamp: new Date(e.ts || Date.now()).toISOString() }));
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ username: 'Sorties annoncées', content: i === 0 ? title : undefined, embeds }) });
    if (!r.ok) throw new Error('Discord : HTTP ' + r.status);
  }
}
async function sendTelegram(token, chat, entries, title) {
  const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const e of entries) {
    const caption = `${esc(title)}\n<b>${esc(e.name)}</b>\n${esc(e.desc || '')}\nhttps://www.imdb.com/title/${e.id}/`.slice(0, 1000);
    const photo = !!e.poster;
    const r = await fetch(`https://api.telegram.org/bot${token}/${photo ? 'sendPhoto' : 'sendMessage'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify(photo ? { chat_id: chat, photo: e.poster, caption, parse_mode: 'HTML' } : { chat_id: chat, text: caption, parse_mode: 'HTML' }) });
    if (!r.ok) throw new Error('Telegram : HTTP ' + r.status); // le jeton n'apparaît jamais dans les messages
  }
}
const channelsOf = n => ({ discord: DISCORD_RE.test(n.discord) ? n.discord : null, telegram: TG_TOKEN_RE.test(n.telegramToken) && TG_CHAT_RE.test(n.telegramChat) ? [n.telegramToken, n.telegramChat] : null });
// Un message par titre/épisode, jamais deux fois, au plus 10 par cycle. Retourne une erreur ou null.
async function runNotify(cfg, announced, available) {
  const n = cfg.notify, ch = channelsOf(n);
  if (!ch.discord && !ch.telegram) return null;
  const jobs = [];
  if (n.onAnnounce && announced.length) jobs.push(['announce', announced, '📣 Nouvelle sortie annoncée']);
  if (n.onAvailable && available.length) jobs.push(['available', available, '✅ Disponible en torrent']);
  if (!jobs.length) return null;
  const sent = (await kv.get(KEY.notified)) || {}, now = Date.now(), errs = [];
  for (const [kind, entries, title] of jobs) {
    const keyOf = e => kind + ':' + e.type + ':' + e.id + ':' + (e.type === 'series' ? e.season + 'x' + e.episode : '');
    const todo = entries.filter(e => !sent[keyOf(e)]).slice(0, 10);
    if (!todo.length) continue;
    let ok = false;
    if (ch.discord) { try { await sendDiscord(ch.discord, todo, title); ok = true; } catch (e) { errs.push(e.message); } }
    if (ch.telegram) { try { await sendTelegram(ch.telegram[0], ch.telegram[1], todo, title); ok = true; } catch (e) { errs.push(e.message); } }
    if (ok) for (const e of todo) sent[keyOf(e)] = Math.floor(now / 60000);
  }
  for (const [k, m] of Object.entries(sent)) if (m * 60000 < now - 30 * DAY) delete sent[k];
  await kv.set(KEY.notified, sent);
  return errs.length ? [...new Set(errs)].join(' ; ') : null;
}

/* ------------------------------------------------------------------ annonces : TMDB, catalogue */
const NOIMDB = "pas d'ID IMDb sur TMDB";
function entryDesc(e) { // texte affiché : épisode, date de sortie, état
  const st = e.status === 'available' ? 'torrent disponible' + (e.avail && e.avail.q ? ' (' + e.avail.q + (e.avail.label ? ' · ' + e.avail.label : '') + ')' : '') : 'annoncé';
  const label = e.type === 'series' && e.season != null ? 'S' + pad2(e.season) + (e.episode != null ? 'E' + pad2(e.episode) : '') : '';
  return label ? [label, 'sortie le ' + fmt(e.date), st].join(' · ') : ['Sortie le ' + fmt(e.date), st].join(' · ');
}
async function candidates(env, it) { // résultats TMDB pour un titre lu sur l'image, du plus proche au moins proche
  const kinds = it.season != null || it.type === 'series' ? ['tv'] : it.type === 'movie' ? ['movie'] : ['movie', 'tv'];
  const out = [];
  for (const k of kinds) {
    const r = await tmdb(env, '/search/' + k, { query: it.title, include_adult: 'false' });
    for (const x of ((r && r.results) || []).slice(0, 6)) {
      const name = x.title || x.name || '', orig = x.original_title || x.original_name || '';
      out.push({ kind: k, id: x.id, name, orig, year: (x.release_date || x.first_air_date || '').slice(0, 4), poster: x.poster_path ? IMG + x.poster_path : null,
        pop: x.popularity || 0, score: Math.max(tgm.sim(it.title, name), tgm.sim(it.title, orig)) });
    }
  }
  return out.sort((a, b) => b.score - a.score || b.pop - a.pop).slice(0, 5);
}
function decide(cands) { // zéro faux positif : au moindre doute, le titre part dans « À vérifier »
  const top = cands[0];
  if (!top) return { reason: 'aucun résultat sur TMDB' };
  if (top.score < 0.88) return { reason: 'titre proche mais incertain (' + Math.round(top.score * 100) + ' % de ressemblance avec « ' + top.name + ' »)' };
  const rivals = cands.filter(c => !(c.kind === top.kind && c.id === top.id) && c.score >= top.score - 0.06);
  if (!rivals.length) return { cand: top };
  const yr = new Date().getFullYear(), recent = [top, ...rivals].filter(c => +c.year >= yr - 1); // une annonce concerne un titre récent
  if (recent.length === 1) return { cand: recent[0] };
  return { reason: 'plusieurs titres possibles : ' + [top, ...rivals].slice(0, 3).map(c => c.name + ' (' + (c.year || '?') + ')').join(' / ') };
}
async function buildEntry(env, cand, it, dateMs, post, force) { // entrée de catalogue à partir d'un titre TMDB choisi
  const ts = Number.isFinite(post.date) ? post.date : Date.now();
  if (cand.kind === 'movie') {
    const d = await tmdb(env, '/movie/' + cand.id, { append_to_response: 'external_ids' });
    const imdb = d && (d.imdb_id || (d.external_ids && d.external_ids.imdb_id));
    if (!imdb) return { reason: NOIMDB };
    const e = { id: imdb, type: 'movie', anime: false, name: d.title || d.original_title, orig: d.original_title || '', poster: d.poster_path ? IMG + d.poster_path : undefined,
      year: (d.release_date || '').slice(0, 4), ts, date: dateMs, season: null, episode: null, status: 'announced', tmdb: cand.id, post: post.id };
    e.desc = entryDesc(e); return { entry: e };
  }
  const d = await tmdb(env, '/tv/' + cand.id, { append_to_response: 'external_ids' });
  const imdb = d && d.external_ids && d.external_ids.imdb_id;
  if (!imdb) return { reason: NOIMDB };
  if (!force && it.season != null && it.episode != null) { // l'épisode annoncé doit exister à une date cohérente
    const ep = await tmdb(env, `/tv/${cand.id}/season/${it.season}/episode/${it.episode}`);
    const air = ep && Date.parse(ep.air_date);
    if (air && Math.abs(air - dateMs) > 3 * DAY) return { reason: 'S' + pad2(it.season) + 'E' + pad2(it.episode) + ' diffusé le ' + fmt(air) + ' sur TMDB, mais annoncé le ' + fmt(dateMs) };
  }
  const anime = (d.genres || []).some(g => g.id === 16) && (d.original_language === 'ja' || (d.origin_country || []).includes('JP'));
  const e = { id: imdb, type: 'series', anime, name: d.name || d.original_name, orig: d.original_name || '', poster: d.poster_path ? IMG + d.poster_path : undefined,
    year: (d.first_air_date || '').slice(0, 4), ts, date: dateMs, season: it.season, episode: it.episode, status: 'announced', tmdb: cand.id, post: post.id };
  e.desc = entryDesc(e); return { entry: e };
}
function addEntry(list, e) { // un titre n'apparaît qu'une fois ; une série remonte avec son épisode le plus récent
  const i = list.findIndex(x => x.id === e.id && x.type === e.type);
  if (i >= 0) {
    const o = list[i];
    const newer = e.date > o.date || (e.date === o.date && ((e.season || 0) > (o.season || 0) || ((e.season || 0) === (o.season || 0) && (e.episode || 0) > (o.episode || 0))));
    if (!newer) return false;
    list.splice(i, 1);
  }
  list.push(e); list.sort((a, b) => b.date - a.date || b.ts - a.ts);
  return true;
}

/* ------------------------------------------------------------------ vérification des trackers : le torrent est-il sorti ? */
// Au plus 8 vérifications par cycle (les moins récemment testées d'abord). Retourne les entrées devenues « disponibles ».
async function checkTrackers(cfg, items, trackers, deadline, note) {
  const now = Date.now(), flipped = [];
  const todo = items.filter(e => e.status !== 'available' && e.date <= now + 18 * HOUR && (e.type === 'movie' || e.season != null))
    .sort((a, b) => (a.checked || 0) - (b.checked || 0)).slice(0, 8);
  for (const e of todo) {
    if (Date.now() > deadline) break;
    e.checked = Date.now();
    let best = null;
    for (const q of [...new Set([e.name, e.orig].filter(Boolean))]) {
      for (const tr of trackers) {
        try {
          const its = parseTorznab(await trackerGet(tzUrl(tr, { t: 'search', q, cat: e.type === 'movie' ? MOVIE_CATS : SERIES_CATS, limit: 50 })));
          for (const x of its) {
            const rel = parseRelease(x.title);
            if (rel.cam && cfg.hideCam) continue;
            const res = resOf(x.title);
            if (cfg.minRes && res != null && res < cfg.minRes) continue;
            if (Math.max(tgm.sim(rel.name, e.name), tgm.sim(rel.name, e.orig || '')) < 0.9) continue;
            if (e.type === 'series') { if (rel.season !== e.season || (e.episode != null && rel.episode !== e.episode)) continue; }
            else if (rel.year && e.year && Math.abs(rel.year - +e.year) > 1) continue;
            if (!best || (res || 0) > best.r) best = { r: res || 0, q: qualityOf(x.title), label: rel.label, tr: tr.name, pub: x.pub || null };
          }
        } catch (err) { note('err', 'Tracker « ' + tr.name + ' » : ' + err.message); }
      }
      if (best) break; // le premier titre qui correspond suffit
    }
    if (best) {
      e.status = 'available'; e.avail = { q: best.q, label: best.label, tr: best.tr, pub: best.pub, at: Date.now() }; e.desc = entryDesc(e);
      flipped.push(e); note('ok', '✅ « ' + e.name + ' » disponible sur ' + best.tr + ' (' + best.q + ')');
    }
  }
  return flipped;
}

/* ------------------------------------------------------------------ rapprochement des titres lus sur une image */
// Commun au canal public et au bot : TMDB, décision (zéro faux positif), catalogue ou file « À vérifier ».
async function ingestItems(ctx, read, post, imgRef) {
  const { env, now, items, review, blocked, note, out } = ctx, res = ctx.res || [];
  for (const it of read.items) {
    const dateStr = it.date || read.general || tgm.parisDate(Number.isFinite(post.date) ? post.date : now);
    const dateMs = Date.parse(dateStr + 'T00:00:00Z');
    if (isNaN(dateMs)) { note('err', 'Date illisible pour « ' + it.title + ' »', post.id); res.push({ k: 'err', title: it.title, text: 'date illisible' }); continue; }
    const cands = await candidates(env, it), dec = decide(cands);
    let reason = dec.reason, entry = null;
    if (dec.cand) { const b = await buildEntry(env, dec.cand, it, dateMs, post); if (b.entry) entry = b.entry; else reason = b.reason; }
    if (entry) {
      if (blocked.has(entry.type + ':' + entry.id)) { note('info', '« ' + entry.name + ' » est masqué', post.id); res.push({ k: 'skip', title: it.title, name: entry.name, text: 'masqué' }); continue; }
      const known = items.find(x => x.id === entry.id && x.type === entry.type && x.date === entry.date && x.season === entry.season && x.episode === entry.episode);
      if (known) { note('info', '« ' + entry.name + ' » déjà dans le catalogue', post.id); res.push({ k: 'known', title: it.title, name: entry.name }); continue; }
      if (addEntry(items, entry)) out.announced.push(entry);
      out.auto++; note('ok', '« ' + it.title + ' » → ' + entry.name + ' (' + entry.desc + ')', post.id); res.push({ k: 'ok', title: it.title, name: entry.name, text: entry.desc });
    } else if (reason === NOIMDB) { note('info', '« ' + it.title + ' » ignoré : ' + reason, post.id); res.push({ k: 'skip', title: it.title, text: reason }); }
    else {
      const rid = post.id + ':' + tgm.fold(it.title).slice(0, 40);
      if (!review.some(x => x.id === rid)) {
        review.unshift({ id: rid, post: post.id, ts: Number.isFinite(post.date) ? post.date : now, date: dateStr, read: it, reason: reason || 'incertain', image: imgRef || null,
          candidates: cands.slice(0, 4).map(c => ({ kind: c.kind, id: c.id, name: c.name, year: c.year, poster: c.poster, score: Math.round(c.score * 100) / 100 })) });
        out.review++;
      }
      note('review', '« ' + it.title + ' » à vérifier : ' + reason, post.id); res.push({ k: 'review', title: it.title, text: reason || 'incertain' });
    }
  }
}

/* ------------------------------------------------------------------ lecture du canal Telegram */
// Lit les nouvelles images, les fait analyser, rapproche les titres de TMDB, puis vérifie les trackers.
async function pipeline(cfg, trackers, deadline) {
  const tg = cfg.tg, out = { announced: [], flipped: [], posts: 0, read: 0, auto: 0, review: 0, found: 0, error: null };
  const now = Date.now(), logs = [], blocked = blockedSet(cfg);
  const st = (await kv.get(KEY.tg)) || { lastId: 0 };
  st.tries = st.tries || {};
  let items = (await kv.get(KEY.items)) || [], review = (await kv.get(KEY.review)) || [];
  const env = { m: cfg.tmdbKey };
  const note = (kind, text, post) => logs.push({ t: Date.now(), kind, text, post: post || null });
  const ctx = { env, now, items, review, blocked, note, out };
  const readDeadline = Math.min(deadline, now + 30000); // la vérification des trackers garde du temps
  try {
    const posts = tg.enabled ? await tgm.fetchChannel(tg.channel) : []; // canal désactivé : seules les images reçues par le bot comptent
    if (posts.length) st.lastSeen = posts[posts.length - 1].id;
    let todo = posts.filter(p => p.images.length && p.id > st.lastId);
    if (!st.lastId) todo = todo.filter(p => p.date > now - 3 * DAY).slice(-5); // premier passage : seulement le récent
    out.posts = todo.length;
    for (const p of todo) {
      if (Date.now() > readDeadline) break;
      let failed = null;
      for (const imgUrl of p.images.slice(0, 3)) {
        try {
          const img = await tgm.downloadImage(imgUrl);
          const read = await tgm.readImage(tg.geminiKey, tg.model, img, tgm.parisDate(now));
          out.read += read.items.length;
          if (!read.items.length) note('info', 'Aucun titre lisible sur l\'image', p.id);
          await ingestItems(ctx, read, p, imgUrl);
        } catch (e) { failed = e; if (e.quota) break; }
      }
      if (failed) {
        st.tries[p.id] = (st.tries[p.id] || 0) + 1; out.error = failed.message; note('err', failed.message, p.id);
        if (failed.quota || st.tries[p.id] < 3) break; // on réessaiera au prochain cycle
        note('err', 'Publication abandonnée après 3 essais', p.id);
      }
      st.lastId = p.id; delete st.tries[p.id];
    }
  } catch (e) { out.error = e.message; note('err', e.message); }
  items = items.filter(x => x.ts > now - cfg.keepDays * DAY);
  review = review.filter(x => x.ts > now - 14 * DAY).slice(0, 50);
  if (trackers.length) { try { out.flipped = await checkTrackers(cfg, items, trackers, deadline, note); out.found = out.flipped.length; } catch (e) { note('err', 'Trackers : ' + e.message); } }
  st.lastRun = Date.now(); st.lastError = out.error;
  await kv.set(KEY.tg, st); await kv.set(KEY.items, items); await kv.set(KEY.review, review);
  if (logs.length) await kv.set(KEY.log, logs.reverse().concat((await kv.get(KEY.log)) || []).slice(0, 80));
  return out;
}

/* ------------------------------------------------------------------ bot Telegram : images transférées à la main */
async function tgApi(token, method, body) { // le jeton n'apparaît jamais dans les erreurs
  const r = await fetch('https://api.telegram.org/bot' + token + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('Telegram : ' + (j.description || 'HTTP ' + r.status));
  return j.result;
}
const newCode = () => crypto.randomBytes(5).toString('hex');
const BOT_HELP = '👋 Transférez-moi les images d\'annonce du canal (vous pouvez en sélectionner plusieurs).\nJe lis les titres, je les cherche sur TMDB et je les ajoute à Stremio.';
async function withLock(fn) { // même verrou que le cycle : jamais deux écritures en même temps
  const until = Date.now() + 50000;
  while (!(await kv.setNx(KEY.lock, Date.now(), 45))) { if (Date.now() > until) throw new Error('le serveur est occupé, réessayez dans une minute'); await sleep(800); }
  try { return await fn(); } finally { await kv.del(KEY.lock).catch(() => {}); }
}
async function botUpdate(upd) {
  const cfg = await getConfig(true), b = cfg.bot, msg = upd && upd.message;
  if (!b.token || !msg || !msg.chat || msg.chat.type !== 'private') return;
  const chat = String(msg.chat.id), say = t => tgApi(b.token, 'sendMessage', { chat_id: msg.chat.id, text: String(t).slice(0, 3900), disable_web_page_preview: true }).catch(() => {});
  const text = String(msg.text || '').trim();
  if (/^\/start/i.test(text)) {
    const given = text.split(/\s+/)[1] || '';
    if (b.owner) { if (b.owner === chat) await say(BOT_HELP); return; }
    if (given && b.code && safeEq(given, b.code)) { b.owner = chat; b.code = ''; await saveConfig(cfg); await say('✅ Bot relié à votre compte.\n\n' + BOT_HELP); }
    else await say('Envoyez /start suivi du code affiché dans le dashboard (onglet Telegram).');
    return;
  }
  if (!b.owner || b.owner !== chat) return; // seul le propriétaire est écouté
  const doc = msg.document && /^image\//.test(msg.document.mime_type || '') ? msg.document : null;
  const fileId = msg.photo && msg.photo.length ? msg.photo[msg.photo.length - 1].file_id : doc ? doc.file_id : null;
  if (!fileId) { if (text && !text.startsWith('/')) await say('Je ne lis que les images : transférez-moi les affiches d\'annonce.'); else if (text) await say(BOT_HELP); return; }
  if (!(await kv.setNx('sr:bot:u:' + upd.update_id, 1, 6 * 3600))) return; // Telegram peut renvoyer la même mise à jour
  if (!cfg.tg.geminiKey) return say('⚠️ Clé Gemini manquante : ajoutez-la dans le dashboard (onglet Telegram).');
  if (!cfg.tmdbKey) return say('⚠️ Clé TMDB manquante : ajoutez-la dans le dashboard (onglet Réglages).');
  const now = Date.now(), post = { id: 'b' + msg.message_id, date: ((msg.forward_origin && msg.forward_origin.date) || msg.forward_date || msg.date) * 1000 };
  let read;
  try {
    const f = await tgApi(b.token, 'getFile', { file_id: fileId });
    if (!f.file_path) throw new Error('fichier introuvable');
    const r = await fetch('https://api.telegram.org/file/bot' + b.token + '/' + f.file_path, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('téléchargement impossible (HTTP ' + r.status + ')');
    const buf = Buffer.from(await r.arrayBuffer()), mime = tgm.sniffMime(buf);
    if (!mime || buf.length > 6e6) throw new Error('image illisible ou trop lourde');
    read = await tgm.readImage(cfg.tg.geminiKey, cfg.tg.model, { buf, mime }, tgm.parisDate(now));
  } catch (e) { return say('⚠️ ' + (e.quota ? 'Limite gratuite de Gemini atteinte : renvoyez cette image un peu plus tard.' : e.message)); }
  if (!read.items.length) return say('Je n\'ai lu aucun titre sur cette image.');
  const out = { announced: [], auto: 0, review: 0 }, res = [], logs = [];
  try {
    await withLock(async () => {
      const blocked = blockedSet(cfg), items = (await kv.get(KEY.items)) || [], review = (await kv.get(KEY.review)) || [];
      const note = (kind, text, p) => logs.push({ t: Date.now(), kind, text, post: p || null });
      await ingestItems({ env: { m: cfg.tmdbKey }, now, items, review, blocked, note, out, res }, read, post, null);
      await kv.set(KEY.items, items.filter(x => x.ts > now - cfg.keepDays * DAY)); await kv.set(KEY.review, review.filter(x => x.ts > now - 14 * DAY).slice(0, 50));
      if (logs.length) await kv.set(KEY.log, logs.reverse().concat((await kv.get(KEY.log)) || []).slice(0, 80));
    });
  } catch (e) { return say('⚠️ ' + e.message); }
  const line = x => x.k === 'ok' ? '✅ ' + x.name + ' — ' + x.text : x.k === 'review' ? '🔎 « ' + x.title + ' » à vérifier (' + x.text + ')' : x.k === 'known' ? 'ℹ️ ' + x.name + ' : déjà dans le catalogue' : 'ℹ️ « ' + x.title + ' » ignoré' + (x.text ? ' : ' + x.text : '');
  await say(res.map(line).join('\n') + (out.review ? '\n\nLes titres « à vérifier » se valident dans le dashboard, onglet Annonces.' : ''));
  if (out.announced.length) { try { await runNotify(cfg, out.announced, []); } catch { /* notification facultative */ } }
}

/* ------------------------------------------------------------------ cycle (borné dans le temps) */
const LEGACY_KEYS = ['sr:items:all', 'sr:items:vf', 'sr:items:vff', 'sr:seen:all', 'sr:seen:vf', 'sr:seen:vff', 'sr:new:all', 'sr:new:vf', 'sr:new:vff', 'sr:newseen', 'sr:log', 'sr:dvds'];
async function cycle(budgetMs = CYCLE_BUDGET_MS) {
  const t0 = Date.now(), deadline = t0 + budgetMs - 8000;
  if (!(await kv.setNx(KEY.lock, t0, Math.ceil(budgetMs / 1000) + 30))) return { skipped: true, message: 'Un cycle est déjà en cours' };
  try {
    const cfg = await getConfig(true);
    if (!cfg.tmdbKey) return { skipped: true, message: 'Clé TMDB manquante : ajoutez-la dans l\'onglet Réglages.' };
    if (!sourceOn(cfg)) return { skipped: true, message: 'Source Telegram non activée : ajoutez la clé Gemini, puis créez le bot (ou activez le canal) dans l\'onglet Telegram.' };
    if (!cfg.legacyPurged) { // nettoyage unique des données de l'ancien système
      for (const k of LEGACY_KEYS) await kv.del(k).catch(() => {});
      cfg.legacyPurged = true; await saveConfig(cfg);
    }
    const trackers = cfg.trackers.filter(t => t.enabled);
    const out = await pipeline(cfg, trackers, deadline);
    let notifyError = null;
    try { notifyError = await runNotify(cfg, out.announced, out.flipped); } catch (e) { notifyError = e.message; }
    const run = (await kv.get(KEY.run)) || {};
    Object.assign(run, { last: Date.now(), ms: Date.now() - t0, notifyError, tg: { posts: out.posts, read: out.read, auto: out.auto, review: out.review, found: out.found, error: out.error } });
    await kv.set(KEY.run, run);
    const hist = (await kv.get(KEY.runs)) || [];
    hist.unshift({ t: run.last, ms: run.ms, posts: out.posts, read: out.read, auto: out.auto, review: out.review, found: out.found, err: out.error ? 1 : 0 });
    await kv.set(KEY.runs, hist.slice(0, 20));
    const msg = `Telegram : ${out.read} titre(s) lu(s), ${out.auto} ajouté(s)` + (out.review ? `, ${out.review} à vérifier` : '') +
      (trackers.length ? `, ${out.found} devenu(s) disponible(s)` : '') + (out.error ? ` — ${out.error}` : '');
    log('cycle terminé en', Math.round(run.ms / 1000), 's :', msg);
    return { ok: !out.error, message: msg };
  } catch (e) {
    log('cycle :', e.message);
    return { ok: false, message: e.message };
  } finally { await kv.del(KEY.lock).catch(() => {}); }
}
// Mise à jour automatique : quand Stremio charge un catalogue et que le dernier essai date de plus de N minutes
async function maybeAutoRefresh() {
  try {
    const cfg = await getConfig();
    if (!cfg.autoRefreshMin || !cfg.tmdbKey || !sourceOn(cfg)) return;
    if (!(await kv.setNx(KEY.auto, Date.now(), cfg.autoRefreshMin * 60))) return; // déjà tenté récemment
    const p = cycle().catch(e => log('auto :', e.message));
    if (waitUntil) waitUntil(p);
  } catch (e) { log('auto :', e.message); }
}

/* ------------------------------------------------------------------ manifest, catalogues, flux d'info */
const CATALOGS = [
  { type: 'movie', id: 'sr-tg-films', name: 'Annonces · Films' },
  { type: 'series', id: 'sr-tg-series', name: 'Annonces · Séries' },
  { type: 'movie', id: 'sr-ok-films', name: 'Disponibles · Films' },
  { type: 'series', id: 'sr-ok-series', name: 'Disponibles · Séries' },
];
function buildManifest(cfg) {
  const m = {
    id: 'community.sorties.annoncees', version: '5.0.0', name: 'Sorties annoncées',
    description: 'Les sorties annoncées sur Telegram (lues par IA, identifiées sur TMDB) et leur disponibilité en torrent. Catalogues uniquement, aucun flux.',
    resources: cfg.streamInfo ? ['catalog', 'stream'] : ['catalog'], types: ['movie', 'series'],
    catalogs: CATALOGS.map(c => ({ ...c, extra: [{ name: 'skip' }] })),
    behaviorHints: { configurable: true },
  };
  if (cfg.streamInfo) m.idPrefixes = ['tt'];
  return m;
}
function displayName(x, format) { // texte sous l'affiche dans Stremio
  const ok = x.status === 'available' ? '✅ ' : '';
  const first = String(x.desc || '').split(' · ')[0];
  const label = x.type === 'series' && /^S\d\d/.test(first) ? first : '';
  const d = x.date ? shortDate(x.date) : '';
  if (format === 'plain') return ok + x.name;
  if (format === 'date_only') return ok + (label ? [label, d].filter(Boolean).join(' · ') : d ? 'Sortie ' + d : x.name);
  const extra = [label, format === 'episode_date' ? d : ''].filter(Boolean).join(' · ');
  return ok + (extra ? x.name + ' · ' + extra : x.name);
}
async function catalog(id, skip) {
  const cfg = await getConfig();
  const items = unblocked(cfg, (await kv.get(KEY.items)) || []).filter(x => x.ts > Date.now() - cfg.keepDays * DAY);
  const type = /films$/.test(id) ? 'movie' : /series$/.test(id) ? 'series' : null;
  if (!type || !/^sr-(tg|ok)-/.test(id)) return [];
  let list = items.filter(x => x.type === type);
  if (id.startsWith('sr-ok-')) list = list.filter(x => x.status === 'available').sort((a, b) => ((b.avail && b.avail.at) || 0) - ((a.avail && a.avail.at) || 0));
  return list.slice(skip, skip + PAGE).map(x => ({ id: x.id, type: x.type, name: displayName(x, cfg.titleFormat), poster: x.poster, releaseInfo: x.year || undefined, description: x.desc }));
}
async function streamsFor(type, id) { // ligne d'information (option du dashboard) : ce n'est pas un flux lisible
  const [imdb, s, e] = id.split(':');
  const en = ((await kv.get(KEY.items)) || []).find(x => x.id === imdb && x.type === type);
  if (!en) return [];
  if (type === 'series') {
    if (en.season != null && s != null && +s !== en.season) return [];
    if (en.episode != null && e != null && +e !== en.episode) return [];
  }
  return [{ name: en.status === 'available' ? '✅ Torrent disponible' : '📣 Sortie annoncée', description: en.desc, externalUrl: `stremio:///detail/${type}/${imdb}` }];
}

/* ------------------------------------------------------------------ fonctions exposées au dashboard */
function cleanUrl(u) {
  let x;
  try { x = new URL(String(u || '').trim()); } catch { throw new Error('URL invalide'); }
  if (!/^https?:$/.test(x.protocol)) throw new Error('L\'URL doit commencer par http:// ou https://');
  x.searchParams.delete('apikey');
  return x.toString();
}
const botInfo = cfg => ({ set: !!cfg.bot.token, username: cfg.bot.username, hint: mask(cfg.bot.token), bound: !!cfg.bot.owner, code: cfg.bot.owner ? '' : cfg.bot.code });
const core = {
  async getState() {
    const cfg = await getConfig(true), run = (await kv.get(KEY.run)) || {}, st = (await kv.get(KEY.tg)) || {};
    const items = unblocked(cfg, (await kv.get(KEY.items)) || []), review = (await kv.get(KEY.review)) || [];
    const autoAt = +(await kv.get(KEY.auto)) || 0, nf = cfg.notify, ch = channelsOf(nf);
    const latest = items.slice().sort((a, b) => ((b.avail && b.avail.at) || b.ts) - ((a.avail && a.avail.at) || a.ts)).slice(0, 8)
      .map(x => ({ id: x.id, type: x.type, anime: x.anime, name: x.name, desc: x.desc, ts: (x.avail && x.avail.at) || x.ts, poster: x.poster, status: x.status }));
    return {
      tmdb: { set: !!cfg.tmdbKey, hint: mask(cfg.tmdbKey) },
      trackers: cfg.trackers.map(t => ({ id: t.id, name: t.name, url: t.url, keyHint: mask(t.apikey), enabled: t.enabled, status: (run.trackerStatus || {})[t.id] || null })),
      settings: { streamInfo: cfg.streamInfo, autoRefreshMin: cfg.autoRefreshMin, titleFormat: cfg.titleFormat, keepDays: cfg.keepDays, minRes: cfg.minRes, hideCam: cfg.hideCam },
      notify: { discord: nf.discord ? mask(nf.discord) : '', discordOk: !!ch.discord, telegram: !!ch.telegram, telegramChat: nf.telegramChat, tokenHint: nf.telegramToken ? mask(nf.telegramToken) : '', onAnnounce: nf.onAnnounce, onAvailable: nf.onAvailable },
      blocked: cfg.blocked,
      tg: { enabled: cfg.tg.enabled, channel: cfg.tg.channel, keyHint: mask(cfg.tg.geminiKey), model: cfg.tg.model, count: items.length, available: items.filter(x => x.status === 'available').length,
        review: review.length, lastRun: st.lastRun || 0, lastError: st.lastError || null },
      bot: botInfo(cfg),
      run: { busy: !!(await kv.get(KEY.lock)), last: run.last || 0, ms: run.ms || 0, budgetS: CYCLE_BUDGET_MS / 1000, notifyError: run.notifyError || null },
      history: (await kv.get(KEY.runs)) || [], latest, autoNext: autoAt && cfg.autoRefreshMin ? autoAt + cfg.autoRefreshMin * 60000 : null,
    };
  },
  async setSettings(o) {
    const c = await getConfig(true);
    if ('streamInfo' in o) c.streamInfo = !!o.streamInfo;
    if ('hideCam' in o) c.hideCam = !!o.hideCam;
    for (const k of Object.keys(LISTS)) if (k in o) {
      const n = +o[k]; if (!LISTS[k].includes(n)) throw new Error('Valeur invalide (' + k + ')');
      c[k] = n; if (k === 'autoRefreshMin') await kv.del(KEY.auto);
    }
    if ('titleFormat' in o) { if (!TITLE_FORMATS.includes(o.titleFormat)) throw new Error('Format invalide'); c.titleFormat = o.titleFormat; }
    await saveConfig(c);
  },
  async setTmdb(key) { const c = await getConfig(true); c.tmdbKey = String(key || '').trim(); await saveConfig(c); },
  async testTmdb(key) {
    const k = String(key || '').trim() || (await getConfig(true)).tmdbKey;
    if (!k) return { ok: false, message: 'Aucune clé TMDB' };
    try { await tmdbFetch(k, '/configuration', new URLSearchParams()); return { ok: true, message: 'Clé TMDB valide' }; }
    catch (e) { return { ok: false, message: /401|403/.test(e.message) ? 'Clé TMDB refusée' : e.message }; }
  },
  async addTracker(o) {
    const apikey = String(o.apikey || '').trim();
    if (!apikey) throw new Error('Clé API du tracker manquante');
    const url = cleanUrl(o.url), c = await getConfig(true);
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
  async testTracker(id) {
    const t = (await getConfig(true)).trackers.find(x => x.id === id);
    if (!t) throw new Error('Tracker introuvable');
    try {
      const its = parseTorznab(await trackerGet(tzUrl(t, { t: 'search', q: '', cat: MOVIE_CATS, limit: 5 })));
      return { ok: true, message: `Connexion OK — ${its.length} résultat(s) reçu(s)` };
    } catch (e) { return { ok: false, message: e.message }; }
  },
  async setNotify(o) {
    const c = await getConfig(true), n = c.notify, v = x => String(x == null ? '' : x).trim();
    if (o.clearDiscord) n.discord = '';
    if (v(o.discord)) { if (!DISCORD_RE.test(v(o.discord))) throw new Error('URL de webhook Discord invalide (https://discord.com/api/webhooks/…)'); n.discord = v(o.discord); }
    if (o.clearTelegram) { n.telegramToken = ''; n.telegramChat = ''; }
    if (v(o.telegramToken)) { if (!TG_TOKEN_RE.test(v(o.telegramToken))) throw new Error('Jeton de bot Telegram invalide (forme 123456:ABC…)'); n.telegramToken = v(o.telegramToken); }
    if (v(o.telegramChat)) { if (!TG_CHAT_RE.test(v(o.telegramChat))) throw new Error('Identifiant de conversation Telegram invalide (nombre ou @canal)'); n.telegramChat = v(o.telegramChat); }
    if ('onAnnounce' in o) n.onAnnounce = !!o.onAnnounce;
    if ('onAvailable' in o) n.onAvailable = !!o.onAvailable;
    await saveConfig(c);
  },
  async testNotify() {
    const ch = channelsOf((await getConfig(true)).notify);
    if (!ch.discord && !ch.telegram) return { ok: false, message: 'Aucun canal configuré (webhook Discord ou bot Telegram + conversation).' };
    const sample = [{ id: 'tt0111161', type: 'movie', name: 'Message de test', desc: 'Les notifications de Sorties annoncées fonctionnent.', ts: Date.now() }];
    const res = [];
    if (ch.discord) { try { await sendDiscord(ch.discord, sample, '🧪 Test'); res.push('Discord OK'); } catch (e) { res.push(e.message); } }
    if (ch.telegram) { try { await sendTelegram(ch.telegram[0], ch.telegram[1], sample, '🧪 Test'); res.push('Telegram OK'); } catch (e) { res.push(e.message); } }
    return { ok: res.every(x => /OK$/.test(x)), message: res.join(' · ') };
  },
  async blockItem(o) { // masque définitivement un titre (et le retire du catalogue)
    const id = String((o && o.id) || ''), type = o && o.type;
    if (!/^tt\d+$/.test(id) || !['movie', 'series'].includes(type)) throw new Error('Titre invalide');
    const c = await getConfig(true);
    if (!c.blocked.some(b => b.id === id && b.type === type)) { if (c.blocked.length >= 300) throw new Error('Liste pleine (300 titres)'); c.blocked.push({ id, type, name: String(o.name || id).slice(0, 120) }); await saveConfig(c); }
    await core.removeItem(id, type).catch(() => {});
  },
  async unblockItem(type, id) {
    const c = await getConfig(true), n = c.blocked.length;
    c.blocked = c.blocked.filter(b => !(b.id === id && b.type === type));
    if (c.blocked.length === n) throw new Error('Titre introuvable dans la liste');
    await saveConfig(c);
  },
  async removeItem(id, type) {
    const items = (await kv.get(KEY.items)) || [], keep = items.filter(x => !(x.id === id && x.type === type));
    if (keep.length === items.length) throw new Error('Titre introuvable');
    await kv.set(KEY.items, keep);
  },
  guard: { // limitation des tentatives de connexion, partagée entre toutes les instances (8 échecs = 15 min)
    key: ip => 'sr:fail:' + crypto.createHash('sha1').update(String(ip)).digest('hex').slice(0, 16),
    async blocked(ip) { const f = await kv.get(this.key(ip)); return !!(f && f.n >= 8); },
    async fail(ip) { const f = (await kv.get(this.key(ip))) || { n: 0 }; f.n++; await kv.set(this.key(ip), f, 900); },
    async clear(ip) { await kv.del(this.key(ip)); },
  },
  async refreshNow() { return cycle(); }, // exécuté dans la requête (borné à CYCLE_BUDGET_S)

  /* --- source Telegram --- */
  async tgState() {
    const cfg = await getConfig(true), st = (await kv.get(KEY.tg)) || {}, t = cfg.tg;
    return {
      config: { enabled: t.enabled, channel: t.channel, keyHint: mask(t.geminiKey), model: t.model }, bot: botInfo(cfg),
      entries: unblocked(cfg, (await kv.get(KEY.items)) || []).map(x => ({ id: x.id, type: x.type, anime: x.anime, name: x.name, year: x.year, poster: x.poster, desc: x.desc, date: x.date, ts: x.ts, status: x.status })),
      review: (await kv.get(KEY.review)) || [], log: (await kv.get(KEY.log)) || [],
      st: { lastId: st.lastId || 0, lastSeen: st.lastSeen || 0, lastRun: st.lastRun || 0, lastError: st.lastError || null },
    };
  },
  async setTg(o) {
    const c = await getConfig(true), t = c.tg;
    if ('channel' in o) {
      const ch = String(o.channel || '').trim().replace(/^https?:\/\/t\.me\/(s\/)?/i, '').replace(/^@/, '').split(/[\/?#]/)[0];
      if (!tgm.CHANNEL_RE.test(ch)) throw new Error('Nom de canal invalide (ex : APPROTV ou https://t.me/APPROTV)');
      if (ch !== t.channel) { t.channel = ch; await kv.set(KEY.tg, { lastId: 0, tries: {} }); }
    }
    if (o.clearKey) { t.geminiKey = ''; t.enabled = false; }
    if (o.geminiKey && String(o.geminiKey).trim()) {
      const k = String(o.geminiKey).trim();
      if (!/^[\w.\-]{20,200}$/.test(k)) throw new Error('Clé Gemini invalide : copiez-la en entier depuis aistudio.google.com/apikey (lettres, chiffres, points et tirets)');
      t.geminiKey = k;
    }
    if ('model' in o) { const m = String(o.model || '').trim(); if (!/^[\w.\-]{3,60}$/.test(m)) throw new Error('Nom de modèle invalide'); t.model = m; }
    if ('enabled' in o) { if (o.enabled && !t.geminiKey) throw new Error('Ajoutez d\'abord la clé Gemini'); t.enabled = !!o.enabled; }
    await saveConfig(c);
  },
  async setBot(o, origin) {
    const c = await getConfig(true), b = c.bot;
    if (o.clear) {
      if (b.token) await tgApi(b.token, 'deleteWebhook', {}).catch(() => {});
      c.bot = { token: '', owner: '', code: '', secret: '', username: '' }; await saveConfig(c); return {};
    }
    if (o.resetOwner) { b.owner = ''; b.code = newCode(); await saveConfig(c); return {}; }
    const tok = String(o.token || '').trim();
    if (!TG_TOKEN_RE.test(tok)) throw new Error('Jeton invalide : collez-le en entier tel que donné par @BotFather (forme 123456:ABC…)');
    if (!/^https:\/\/[\w.\-]+(:\d+)?$/.test(origin || '')) throw new Error('Adresse du site introuvable (le bot nécessite le site en https)');
    const me = await tgApi(tok, 'getMe');
    if (b.token && b.token !== tok) await tgApi(b.token, 'deleteWebhook', {}).catch(() => {});
    b.token = tok; b.username = me.username || ''; b.secret = crypto.randomBytes(16).toString('hex'); if (!b.owner && !b.code) b.code = newCode();
    await tgApi(tok, 'setWebhook', { url: origin + '/tg/hook/' + b.secret, secret_token: b.secret, allowed_updates: ['message'], drop_pending_updates: true, max_connections: 2 });
    await saveConfig(c);
    return { username: b.username };
  },
  async tgTest() { // lit l'aperçu public du canal (sans Gemini)
    const cfg = await getConfig(true);
    try {
      const posts = await tgm.fetchChannel(cfg.tg.channel), withImg = posts.filter(p => p.images.length), last = withImg[withImg.length - 1];
      return { ok: true, message: `Aperçu lisible : ${posts.length} publication(s), dont ${withImg.length} avec image.`, latest: last ? { id: last.id, date: last.date, image: last.images[0] } : null };
    } catch (e) { return { ok: false, message: e.message }; }
  },
  async tgAnalyze() { // essai à blanc sur la dernière image : rien n'est enregistré
    const cfg = await getConfig(true);
    if (!cfg.tg.geminiKey) throw new Error('Ajoutez d\'abord la clé Gemini');
    if (!cfg.tmdbKey) throw new Error('Clé TMDB manquante');
    const posts = await tgm.fetchChannel(cfg.tg.channel), last = posts.filter(p => p.images.length).pop();
    if (!last) throw new Error('Aucune publication avec image dans l\'aperçu');
    const img = await tgm.downloadImage(last.images[0]);
    const read = await tgm.readImage(cfg.tg.geminiKey, cfg.tg.model, img, tgm.parisDate(Date.now()));
    const env = { m: cfg.tmdbKey }, rows = [];
    for (const it of read.items.slice(0, 12)) {
      const cands = await candidates(env, it), dec = decide(cands);
      rows.push({ read: it, auto: !!dec.cand, reason: dec.reason || null, chosen: dec.cand ? dec.cand.name + ' (' + (dec.cand.year || '?') + ')' : null,
        candidates: cands.slice(0, 3).map(c => ({ kind: c.kind, name: c.name, year: c.year, score: Math.round(c.score * 100) / 100 })) });
    }
    return { post: { id: last.id, date: last.date, image: last.images[0] }, general: read.general, rows };
  },
  async tgReview(o) { // valide, corrige ou ignore un titre de la file « À vérifier »
    const cfg = await getConfig(true), review = (await kv.get(KEY.review)) || [], r = review.find(x => x.id === o.id);
    if (!r) throw new Error('Élément introuvable');
    if (o.action !== 'ignore') {
      let cand;
      if (o.action === 'accept') cand = r.candidates[+o.index];
      else if (o.action === 'manual') cand = { kind: o.kind === 'movie' ? 'movie' : 'tv', id: parseInt(o.tmdbId, 10) };
      if (!cand || !(cand.id > 0)) throw new Error('Choix invalide');
      const built = await buildEntry({ m: cfg.tmdbKey }, cand, r.read, Date.parse(r.date + 'T00:00:00Z'), { id: r.post, date: r.ts }, true);
      if (!built.entry) throw new Error(built.reason);
      const items = (await kv.get(KEY.items)) || [];
      addEntry(items, built.entry); await kv.set(KEY.items, items);
    }
    await kv.set(KEY.review, review.filter(x => x.id !== o.id));
  },
  async tgReprocess() { const st = (await kv.get(KEY.tg)) || {}; await kv.set(KEY.tg, { ...st, lastId: 0, tries: {} }); }, // relire les images des 3 derniers jours
  async tgClear() { await kv.set(KEY.items, []); await kv.set(KEY.review, []); await kv.del(KEY.log); },
};

/* ------------------------------------------------------------------ routes HTTP */
const dashboard = require('./dashboard/dashboard')(core, { password: process.env.ADMIN_PASSWORD });
const configure = require('./dashboard/configure')();
const send = (res, code, type, body, extra = {}) => { res.writeHead(code, { 'Content-Type': type, ...extra }); res.end(body); };
const json = (res, o, extra) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(o), extra);
const safeEq = (a, b) => { const A = crypto.createHash('sha256').update(String(a)).digest(), B = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(A, B); };
const EDGE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600'; // cache du CDN Vercel pour Stremio

async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    let seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (seg[0] === 'admin') return await dashboard(req, res, seg);
    if (seg[0] === 'cron') { // Vercel Cron (en-tête Authorization) ou service externe (?key=)
      const secret = process.env.CRON_SECRET;
      const given = (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('key') || '';
      if (!secret || !safeEq(given, secret)) return send(res, 401, 'text/plain; charset=utf-8', 'Non autorisé (définissez CRON_SECRET)');
      return json(res, await cycle(), { 'Cache-Control': 'no-store' });
    }
    if (seg[0] === 'tg' && seg[1] === 'hook' && seg.length === 3 && req.method === 'POST') { // webhook du bot Telegram
      const cfg = await getConfig(true), b = cfg.bot, given = req.headers['x-telegram-bot-api-secret-token'] || '';
      if (!b.token || !b.secret || !safeEq(seg[2], b.secret) || !safeEq(given, b.secret)) return send(res, 403, 'text/plain; charset=utf-8', 'Refusé');
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 2e5) break; }
      let upd = null; try { upd = JSON.parse(raw); } catch { /* ignoré */ }
      const p = upd ? botUpdate(upd).catch(e => log('bot :', e.message)) : Promise.resolve();
      if (waitUntil) waitUntil(p);
      return send(res, 200, 'text/plain; charset=utf-8', 'ok'); // répond tout de suite ; la lecture se poursuit après
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (LEGACY_LANGS.includes(seg[0])) seg = seg.slice(1); // anciennes URL /all/manifest.json, /vf/…, /vff/…
    if (!seg.length || (seg.length === 1 && seg[0] === 'configure')) return configure(req, res);
    if (seg[0] === 'health') {
      let last = null; try { const r = await kv.get(KEY.run); last = (r && r.last) || null; } catch { /* stockage indisponible */ }
      return json(res, { ok: true, storage: kv.remote ? 'upstash' : 'fichiers', admin: !!process.env.ADMIN_PASSWORD, cron: !!process.env.CRON_SECRET, lastCycle: last, ageMin: last ? Math.round((Date.now() - last) / 60000) : null }, { 'Cache-Control': 'no-store' });
    }
    if (seg.length === 1 && seg[0] === 'manifest.json') return json(res, buildManifest(await getConfig()), { 'Cache-Control': 'public, s-maxage=60' });
    if (seg[0] === 'configure') return configure(req, res);
    if (seg.length) seg[seg.length - 1] = seg[seg.length - 1].replace(/\.json$/, '');
    if (seg[0] === 'catalog' && seg.length >= 3) {
      const skip = seg.length > 3 ? parseInt(new URLSearchParams(seg[3]).get('skip'), 10) || 0 : 0;
      await maybeAutoRefresh();
      return json(res, { metas: await catalog(seg[2], skip) }, { 'Cache-Control': EDGE });
    }
    if (seg[0] === 'stream' && seg.length >= 3) {
      const streams = (await getConfig()).streamInfo ? await streamsFor(seg[1], seg[2]) : [];
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
module.exports._t = { tgm, candidates, decide, pipeline, parseRelease, parseTorznab, core, cycle, KEY, kv, getConfig, buildManifest, displayName, catalog };

/* ------------------------------------------------------------------ exécution locale (node index.js) */
if (require.main === module) {
  http.createServer(handler).listen(PORT, () => {
    log(`Sorties annoncées en écoute sur http://localhost:${PORT}  (stockage : ${kv.remote ? 'Upstash' : 'fichiers ./data/kv'})`);
    log(`  installation : /configure   |   dashboard : /admin${process.env.ADMIN_PASSWORD ? '' : '  (ADMIN_PASSWORD non défini : désactivé)'}`);
    setTimeout(cycle, 5000);
    setInterval(cycle, 30 * 60e3);
  });
}
