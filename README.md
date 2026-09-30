# Sorties récentes — addon Stremio (Vercel)

Catalogues « Films récents », « Séries récentes », « Animés récents » : uniquement les vraies nouveautés
sorties en torrent (API Torznab), validées par les dates officielles TMDB. Aucun flux fourni.

## Déploiement Vercel
1. Poussez ce dossier sur GitHub puis importez le dépôt dans Vercel (ou `vercel` en ligne de commande).
2. Projet > Storage > ajoutez **Upstash Redis** (Marketplace) : `KV_REST_API_URL` et `KV_REST_API_TOKEN` sont ajoutées seules.
3. Settings > Environment Variables : `ADMIN_PASSWORD` et `CRON_SECRET`, puis redéployez.
4. Ouvrez `https://votre-projet.vercel.app/admin` : ajoutez vos trackers (URL Torznab + clé) et la clé TMDB.
5. Programmez `https://votre-projet.vercel.app/cron?key=VOTRE_CRON_SECRET` toutes les 30 min sur cron-job.org
   (le cron Vercel du plan Hobby ne passe qu'une fois par jour ; il est déjà configuré en secours).
6. Installez depuis `https://votre-projet.vercel.app/configure`.

## En local
`npm install` puis `ADMIN_PASSWORD=xxx node index.js` (données dans ./data/kv, cycle toutes les 30 min).
