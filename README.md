# Sorties annoncées — addon Stremio (Vercel)

Le flux, en cinq étapes :
1. un canal Telegram public publie une image d'annonce (le titre est dans l'image) ;
2. l'IA gratuite de Google (Gemini) lit l'image et donne le titre ;
3. l'addon cherche le titre sur TMDB : la sortie apparaît dans Stremio (catalogues « Annonces ») ;
4. l'addon vérifie sur vos trackers (API Torznab) si le torrent est sorti ;
5. dès que c'est le cas : badge ✅ dans Stremio (catalogues « Disponibles ») et notification Discord / Telegram.

Les cas incertains vont dans une file « À vérifier » du dashboard (`/admin`). Aucun lien de torrent n'est jamais fourni.

## Déploiement Vercel
1. Importez ce dépôt dans Vercel.
2. Projet > Storage > ajoutez **Upstash Redis** (Marketplace) : `KV_REST_API_URL` et `KV_REST_API_TOKEN` sont ajoutées seules.
3. Settings > Environment Variables : `ADMIN_PASSWORD` (obligatoire) et `CRON_SECRET`, puis redéployez.
4. `/admin` : clé TMDB (Réglages), canal + clé Gemini gratuite (onglet Telegram), trackers (onglet Trackers).
5. Installez depuis `/configure`.

## Mise à jour automatique
Quand Stremio ouvre un catalogue et que les données ont plus de N minutes (Réglages), l'addon lit le canal et vérifie
les trackers en arrière-plan. Pour une lecture même quand Stremio est fermé (annonces de nuit), programmez
`/cron?key=CRON_SECRET` toutes les 10 minutes sur cron-job.org (gratuit).

## En local
`npm install` puis `ADMIN_PASSWORD=xxx node index.js` (données dans ./data/kv).

## Historique
Le tag Git `v4-avant-nettoyage` conserve l'ancienne version (règles de date sur les torrents, nouveaux torrents, versions VF/VFF).
