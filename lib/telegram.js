'use strict';
/*
 * Source « canal Telegram » : lit l'aperçu public d'un canal (t.me/s/<canal>, sans compte ni bot),
 * télécharge les images d'annonce, les fait lire par Gemini (offre gratuite) et fournit
 * les utilitaires de rapprochement de titres. Aucune dépendance.
 */
const UA = 'Mozilla/5.0 (compatible; SortiesRecentes/4.0; +https://vercel.com)';
const CHANNEL_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const IMG_HOST_RE = /(^|\.)(telesco\.pe|cdn-telegram\.org|telegram\.org|t\.me)$/i; // jamais d'autre hôte
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models/';

const unent = s => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
const stripTags = s => unent(String(s).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();

/* ---------- aperçu public ---------- */
function parsePreview(html, channel) {
  const posts = [];
  for (const part of String(html).split(/(?=<div class="tgme_widget_message_wrap)/)) {
    const m = part.match(/data-post="([^"\/]+)\/(\d+)"/);
    if (!m || (channel && m[1].toLowerCase() !== channel.toLowerCase())) continue;
    const t = part.match(/<time[^>]*datetime="([^"]+)"/);
    const body = part.replace(/<a[^>]*tgme_widget_message_link_preview[\s\S]*?<\/a>/g, ''); // pas les aperçus de liens
    const images = [];
    for (const tag of body.matchAll(/<a[^>]*tgme_widget_message_photo_wrap[^>]*>/g)) {
      const u = tag[0].match(/background-image:\s*url\((?:&quot;|["'])?([^"')&]+)/);
      if (u) images.push(unent(u[1]));
    }
    const tx = body.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    posts.push({ id: +m[2], date: t ? Date.parse(t[1]) : NaN, text: tx ? stripTags(tx[1]) : '', images });
  }
  return posts.sort((a, b) => a.id - b.id);
}
async function fetchChannel(channel) {
  if (!CHANNEL_RE.test(channel)) throw new Error('Nom de canal invalide (lettres, chiffres et _ uniquement)');
  const r = await fetch('https://t.me/s/' + channel, { headers: { 'User-Agent': UA, 'Accept-Language': 'fr,en;q=0.8' }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if (r.status >= 300 && r.status < 400) throw new Error('Aperçu public indisponible : Telegram redirige vers la page normale du canal (aperçu web désactivé pour ce canal, ou refusé à ce serveur).');
  if (!r.ok) throw new Error('Telegram : HTTP ' + r.status);
  const posts = parsePreview(await r.text(), channel);
  if (!posts.length) throw new Error('Aucune publication lisible dans l\'aperçu (canal vide, privé ou aperçu désactivé).');
  return posts;
}

/* ---------- images ---------- */
function sniffMime(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (b.slice(0, 3).toString() === 'GIF') return 'image/gif';
  return null;
}
async function downloadImage(url) {
  let u; try { u = new URL(url); } catch { throw new Error('URL d\'image invalide'); }
  if (u.protocol !== 'https:' || !IMG_HOST_RE.test(u.hostname)) throw new Error('Hôte d\'image non autorisé : ' + u.hostname);
  const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('Image : HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 6e6) throw new Error('Image trop lourde (' + Math.round(buf.length / 1e6) + ' Mo)');
  const mime = sniffMime(buf);
  if (!mime) throw new Error('Format d\'image non reconnu');
  return { buf, mime };
}

/* ---------- lecture par Gemini ---------- */
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const intIn = (v, max) => { const n = parseInt(v, 10); return n >= 0 && n <= max && !isNaN(n) ? n : null; };
function parseItems(txt) {
  let t = String(txt || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let o;
  try { o = JSON.parse(t); } catch { const m = t.match(/[\[{][\s\S]*[\]}]/); if (!m) throw new Error('Réponse de Gemini illisible'); try { o = JSON.parse(m[0]); } catch { throw new Error('Réponse de Gemini illisible'); } }
  const arr = Array.isArray(o) ? o : Array.isArray(o && o.items) ? o.items : [];
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const items = [];
  for (const x of arr.slice(0, 30)) {
    const title = clean(x && x.title, 120);
    if (!title) continue;
    const ty = String(x.type || '').toLowerCase();
    items.push({
      title, type: /^(movie|film)$/.test(ty) ? 'movie' : /^(series|serie|série|tv)$/.test(ty) ? 'series' : 'unknown',
      season: intIn(x.season, 99), episode: intIn(x.episode, 999), date: dateRe.test(String(x.date)) ? String(x.date) : null, note: clean(x.note, 80),
    });
  }
  return { general: o && dateRe.test(String(o.date)) ? String(o.date) : null, items };
}
async function readImage(key, model, img, today) {
  const prompt = `Tu es un lecteur d'images. Cette image est une annonce de sorties de films et de séries.
Lis TOUS les titres visibles et réponds UNIQUEMENT avec un objet JSON de cette forme :
{"date":"AAAA-MM-JJ ou null","items":[{"title":"titre exact tel qu'écrit sur l'image","type":"movie ou series ou unknown","season":nombre ou null,"episode":nombre ou null,"date":"AAAA-MM-JJ ou null","note":"information utile (plateforme, VF/VOSTFR…) ou vide"}]}
Règles : n'invente rien et n'inclus que ce qui est lisible ; "season" et "episode" seulement s'ils sont écrits ; si l'image donne une seule date pour toutes les sorties, mets-la dans "date" à la racine ; si une date n'a pas d'année, utilise l'année en cours. Aujourd'hui, nous sommes le ${today}.`;
  const r = await fetch(GEMINI + encodeURIComponent(model) + ':generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, signal: AbortSignal.timeout(45000),
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: img.mime, data: img.buf.toString('base64') } }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j.error && j.error.message) || '';
    if (r.status === 429) { const e = new Error('Gemini : quota gratuit atteint, nouvel essai au prochain cycle'); e.quota = true; throw e; }
    if (r.status === 400 && /API key/i.test(msg)) throw new Error('Gemini : clé API refusée');
    if (r.status === 403 || r.status === 401) throw new Error('Gemini : accès refusé (vérifiez la clé API)');
    if (r.status === 404) throw new Error('Gemini : modèle « ' + model + ' » introuvable (changez-le dans les options)');
    throw new Error('Gemini : HTTP ' + r.status + (msg ? ' — ' + msg.slice(0, 120) : ''));
  }
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const txt = parts.map(p => p.text || '').join('');
  if (!txt) throw new Error('Gemini n\'a rien renvoyé (image bloquée ou illisible)');
  return parseItems(txt);
}

/* ---------- rapprochement de titres ---------- */
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function sim(a, b) {
  a = fold(a); b = fold(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - lev(a, b) / Math.max(a.length, b.length);
}
const parisDate = t => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); // AAAA-MM-JJ

module.exports = { CHANNEL_RE, parsePreview, fetchChannel, downloadImage, sniffMime, readImage, parseItems, fold, sim, parisDate };
