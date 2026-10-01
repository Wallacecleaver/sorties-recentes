# Sorties récentes — addon Stremio (Vercel)

Catalogues « Films récents », « Séries récentes », « Animés récents » : uniquement les vraies nouveautés
sorties en torrent (API Torznab), validées par les dates officielles TMDB. Aucun flux fourni.

## Déploiement Vercel
1. Importez ce dépôt dans Vercel.
2. Projet > Storage > ajoutez **Upstash Redis** (Marketplace) : `KV_REST_API_URL` et `KV_REST_API_TOKEN` sont ajoutées seules.
3. Settings > Environment Variables : `ADMIN_PASSWORD` (obligatoire), `CRON_SECRET` (optionnel), puis redéployez.
4. Ouvrez `/admin` : ajoutez la clé TMDB (Réglages) et vos trackers (Trackers), puis « Lancer un cycle ».
5. Installez depuis `/configure`.

## Mise à jour automatique
Rien à programmer : quand Stremio charge un catalogue et que les données ont plus de N minutes
(réglable dans Réglages, 30 min par défaut), l'addon cherche les nouveautés en arrière-plan.
`/cron?key=CRON_SECRET` reste disponible pour un déclencheur externe (facultatif).

## En local
`npm install` puis `ADMIN_PASSWORD=xxx node index.js` (données dans ./data/kv).
