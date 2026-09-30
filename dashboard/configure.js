'use strict';
/*
 * Page /configure — choix de la version (langue) et lien d'installation.
 * Aucun secret ici : les trackers et la clé TMDB sont gérés dans le dashboard (/admin).
 * Interface : configure.html (même dossier).
 */
const fs = require('fs');
const path = require('path');

module.exports = function createConfigure(core) {
  return function serve(req, res, lang) {
    const page = fs.readFileSync(path.join(__dirname, 'configure.html'), 'utf8')
      .replace('/*LANGS*/', 'window.__LANGS=' + JSON.stringify(core.LANG_NAMES) + ';window.__LANG=' + JSON.stringify(lang) + ';');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page);
  };
};
