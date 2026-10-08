'use strict';
/*
 * Page /configure — lien d'installation de l'addon dans Stremio. Aucun secret ici.
 * Interface : configure.html (même dossier).
 */
const fs = require('fs');
const path = require('path');

module.exports = function createConfigure() {
  return function serve(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(path.join(__dirname, 'configure.html'), 'utf8'));
  };
};
