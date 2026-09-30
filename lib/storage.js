'use strict';
/*
 * Stockage clé/valeur (JSON).
 *  - Sur Vercel : Upstash Redis via son API REST (intégration du Marketplace Vercel).
 *    Variables lues : KV_REST_API_URL + KV_REST_API_TOKEN  (ou UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).
 *  - En local (sans ces variables) : simples fichiers dans DATA_DIR/kv, pour tester.
 */
const fs = require('fs');
const path = require('path');

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'kv');

async function cmd(args) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('Redis : ' + (j.error || 'HTTP ' + r.status));
  return j.result;
}

const file = key => path.join(DIR, key.replace(/[^A-Za-z0-9_.-]/g, '_') + '.json');
const readFile = key => {
  try {
    const o = JSON.parse(fs.readFileSync(file(key), 'utf8'));
    if (o.exp && o.exp < Date.now()) return undefined;
    return o;
  } catch { return undefined; }
};
const writeFile = (key, v, exSec) => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file(key), JSON.stringify({ v, exp: exSec ? Date.now() + exSec * 1000 : 0 }), { mode: 0o600 });
};

function check() {
  if (!URL_ && process.env.VERCEL) throw new Error('Stockage absent : ajoutez l\'intégration Upstash Redis à votre projet Vercel (Storage / Marketplace).');
}

module.exports = {
  remote: !!URL_,
  async get(key) {
    check();
    if (URL_) { const r = await cmd(['GET', key]); return r == null ? null : JSON.parse(r); }
    const o = readFile(key);
    return o ? o.v : null;
  },
  async set(key, value, exSec) {
    check();
    if (URL_) { await cmd(exSec ? ['SET', key, JSON.stringify(value), 'EX', String(exSec)] : ['SET', key, JSON.stringify(value)]); return; }
    writeFile(key, value, exSec);
  },
  async setNx(key, value, exSec) { // true si la clé a été créée (verrou obtenu)
    check();
    if (URL_) return (await cmd(['SET', key, JSON.stringify(value), 'NX', 'EX', String(exSec)])) === 'OK';
    if (readFile(key)) return false;
    writeFile(key, value, exSec);
    return true;
  },
  async del(key) {
    check();
    if (URL_) { await cmd(['DEL', key]); return; }
    try { fs.unlinkSync(file(key)); } catch {}
  },
};
