'use strict';
/*
 * Dashboard /admin — protégé par ADMIN_PASSWORD.
 * Ne contient aucune logique métier : tout passe par l'objet `core` fourni par index.js.
 * Interface : dashboard.html (même dossier).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'sr_admin';
const TTL = 7 * 24 * 3600e3;

module.exports = function createDashboard(core, { password }) {
  const secret = crypto.createHash('sha256').update('sr-admin:' + password).digest();
  const sign = exp => crypto.createHmac('sha256', secret).update(String(exp)).digest('hex');
  const sha = s => crypto.createHash('sha256').update(String(s)).digest();
  const eq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
  const makeToken = () => { const exp = Date.now() + TTL; return exp + '.' + sign(exp); };
  const okToken = t => { const [exp, sig] = String(t || '').split('.'); return !!(exp && sig && +exp > Date.now() && eq(sig, sign(exp))); };
  const readCookie = req => { const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)')); return m && m[1]; };
  const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  const send = (res, code, type, body, h = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...h }); res.end(body); };
  const json = (res, o, code = 200, h) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(o), h);
  const readBody = req => new Promise((ok, ko) => {
    if (req.body !== undefined && req.body !== null) { // Vercel a déjà lu (et parsé) le corps
      try { const b = req.body; return ok(Buffer.isBuffer(b) ? JSON.parse(b.toString() || '{}') : typeof b === 'string' ? JSON.parse(b || '{}') : b); }
      catch { return ko(new Error('JSON invalide')); }
    }
    let n = 0; const b = [];
    req.on('data', c => { n += c.length; if (n > 1e5) { ko(new Error('Corps trop gros')); req.destroy(); } else b.push(c); });
    req.on('end', () => { try { ok(b.length ? JSON.parse(Buffer.concat(b).toString()) : {}); } catch { ko(new Error('JSON invalide')); } });
    req.on('error', ko);
  });
  const cookieHeader = (req, value, maxAge) => {
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return `${COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  };
  const OK = { ok: true };

  return async function handle(req, res, seg) { // seg[0] === 'admin'
    if (!password) return send(res, 503, 'text/plain; charset=utf-8', 'Dashboard désactivé : définissez la variable d\'environnement ADMIN_PASSWORD puis relancez.');
    try {
      const r = seg.slice(1), m = req.method;
      if (!r.length) {
        if (m !== 'GET') return send(res, 405, 'text/plain; charset=utf-8', 'Méthode non autorisée');
        return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8'));
      }
      if (r[0] !== 'api') return send(res, 404, 'text/plain; charset=utf-8', 'Introuvable');
      const a = r.slice(1), k = a[0];

      if (k === 'login' && m === 'POST') {
        const ip = ipOf(req);
        if (await core.guard.blocked(ip)) return json(res, { error: 'Trop de tentatives, réessayez dans 15 minutes' }, 429);
        const b = await readBody(req);
        if (!eq(b.password || '', password)) { await core.guard.fail(ip); return json(res, { error: 'Mot de passe incorrect' }, 401); }
        await core.guard.clear(ip);
        return json(res, OK, 200, { 'Set-Cookie': cookieHeader(req, makeToken(), TTL / 1000) });
      }
      if (k === 'logout' && m === 'POST') return json(res, OK, 200, { 'Set-Cookie': cookieHeader(req, '', 0) });

      if (!okToken(readCookie(req))) return json(res, { error: 'Non autorisé' }, 401);

      if (k === 'state' && m === 'GET') return json(res, await core.getState());
      if (k === 'refresh' && m === 'POST') return json(res, await core.refreshNow());
      if (k === 'settings' && m === 'PUT') { await core.setSettings(await readBody(req)); return json(res, OK); }
      if (k === 'trackers') {
        if (a.length === 1 && m === 'POST') return json(res, await core.addTracker(await readBody(req)));
        if (a.length === 2 && m === 'PUT') { await core.updateTracker(a[1], await readBody(req)); return json(res, OK); }
        if (a.length === 2 && m === 'DELETE') { await core.removeTracker(a[1]); return json(res, OK); }
        if (a.length === 3 && a[2] === 'test' && m === 'POST') return json(res, await core.testTracker(a[1]));
      }
      if (k === 'tmdb') {
        if (a.length === 1 && m === 'PUT') { await core.setTmdb((await readBody(req)).key); return json(res, OK); }
        if (a[1] === 'test' && m === 'POST') return json(res, await core.testTmdb((await readBody(req)).key));
      }
      if (k === 'notify') {
        if (a.length === 1 && m === 'PUT') { await core.setNotify(await readBody(req)); return json(res, OK); }
        if (a[1] === 'test' && m === 'POST') return json(res, await core.testNotify());
      }
      if (k === 'block') {
        if (a.length === 1 && m === 'POST') { await core.blockItem(await readBody(req)); return json(res, OK); }
        if (a.length === 3 && m === 'DELETE') { await core.unblockItem(a[1], decodeURIComponent(a[2])); return json(res, OK); }
      }
      if (k === 'item' && m === 'DELETE') { await core.removeItem(decodeURIComponent(a[1]), a[2]); return json(res, OK); }
      if (k === 'tg') {
        if (a.length === 1 && m === 'GET') return json(res, await core.tgState());
        const op = a[1];
        if (op === 'config' && m === 'PUT') { await core.setTg(await readBody(req)); return json(res, OK); }
        if (op === 'test' && m === 'POST') return json(res, await core.tgTest());
        if (op === 'analyze' && m === 'POST') return json(res, await core.tgAnalyze());
        if (op === 'review' && m === 'POST') { await core.tgReview(await readBody(req)); return json(res, OK); }
        if (op === 'reprocess' && m === 'POST') { await core.tgReprocess(); return json(res, OK); }
        if (op === 'clear' && m === 'POST') { await core.tgClear(); return json(res, OK); }
      }
      return json(res, { error: 'Introuvable' }, 404);
    } catch (e) {
      return json(res, { error: e.message }, 400);
    }
  };
};
