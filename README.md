# Uno Néon

Uno multijoueur en ligne, entre potes, avec bots, interface néon et passe de combat.

- `server.mjs` : le serveur (Node 18+, aucune dépendance). Il sert le site et l'API `/api/*`, et garde les parties en mémoire.
- `public/index.html` : l'interface.
- `public/engine.js` : les règles du jeu, partagées par le serveur et le mode solo.

En local : `npm start`, puis ouvrir http://localhost:3000

Sur Render : le fichier `render.yaml` crée un service web gratuit (`npm install`, puis `npm start`).
Les parties en cours sont perdues quand le serveur redémarre ou s'endort.
