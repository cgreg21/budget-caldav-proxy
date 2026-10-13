# budget-caldav-proxy

Proxy CORS pour exposer un serveur CalDAV hébergé (Infomaniak, Murena, Disroot, Mailo, Nextcloud…) à la
PWA Budget. Les navigateurs n'autorisent la PWA à parler qu'aux serveurs qui renvoient des en-têtes
CORS, ce qu'aucun hébergeur grand public ne fait. Ce Worker Cloudflare relaie les quelques méthodes
CalDAV utilisées par l'application (`OPTIONS`, `GET`, `PUT`, `DELETE`, `PROPFIND`, `REPORT`) et ajoute
les en-têtes. Il ne stocke rien, n'a aucun secret, et ne répond qu'aux origines listées.

Les applications mobile et bureau n'en ont pas besoin : elles parlent directement au serveur CalDAV.

## Sécurité

- Le proxy **voit passer les identifiants et les événements** (chiffrés en transit, jamais stockés).
  Déployez-le sur **votre propre compte** Cloudflare, pas sur un service tiers.
- `ALLOWED_ORIGINS` limite les origines acceptées : tout autre `Origin` (ou son absence) reçoit `403`,
  ce qui empêche l'usage comme proxy ouvert.
- `ALLOWED_PATHS` limite les chemins relayés au point d'accès DAV du serveur.
- Les méthodes hors liste reçoivent `405` ; les en-têtes transmis sont filtrés dans les deux sens
  (pas de cookies, uniquement `Authorization`, `Depth`, `Content-Type`, `If-Match`, `If-None-Match`,
  `Prefer` en entrée ; `ETag`, `Content-Type`, `DAV`, `Allow`, `Location` en sortie).

## Prérequis

- Node.js 22+ et un compte Cloudflare gratuit (<https://dash.cloudflare.com/sign-up>, sans carte
  bancaire). Le plan gratuit Workers autorise 100 000 requêtes par jour, largement suffisant.

## Configuration

Éditez `wrangler.toml` :

```toml
[vars]
UPSTREAM = "https://murena.io"                                      # origine du serveur CalDAV
ALLOWED_ORIGINS = "https://cgreg21.github.io,http://localhost:4200" # origines de la PWA
ALLOWED_PATHS = "/remote.php/dav/"                                  # Nextcloud ; Infomaniak : "/calendars/"
```

Quelques valeurs `UPSTREAM` / `ALLOWED_PATHS` :

| Fournisseur | `UPSTREAM` | `ALLOWED_PATHS` | URL de calendrier côté serveur |
| --- | --- | --- | --- |
| Murena, Disroot, Nextcloud | `https://murena.io` | `/remote.php/dav/` | `/remote.php/dav/calendars/<utilisateur>/<calendrier>/` |
| Infomaniak | `https://sync.infomaniak.com` | `/calendars/` | `/calendars/<DSxxxxx>/<id-calendrier>/` |
| Radicale / Baïkal | `https://dav.example.org` | `/` ou `/dav.php/` | selon l'installation |

## Déploiement

```bash
npm install
npm test
npx wrangler login      # ouvre le navigateur une seule fois
npm run deploy
```

Wrangler affiche l'adresse du Worker, de la forme `https://budget-caldav-proxy.<compte>.workers.dev`.

> Si `npx` est bloqué sur votre poste, lancez `node node_modules/wrangler/bin/wrangler.js login`
> puis `node node_modules/wrangler/bin/wrangler.js deploy`.

## Utilisation dans la PWA

Dans **Réglages → Calendrier** de la PWA, remplacez l'origine du serveur par celle du Worker en
gardant le même chemin :

| | Exemple |
| --- | --- |
| URL d'origine | `https://murena.io/remote.php/dav/calendars/alice/budget/` |
| URL dans la PWA | `https://budget-caldav-proxy.<compte>.workers.dev/remote.php/dav/calendars/alice/budget/` |
| Identifiant | `alice` |
| Mot de passe | mot de passe d'application du fournisseur |

Les applications mobile et bureau gardent l'URL d'origine. Le calendrier reste partagé normalement par
le fournisseur (invitations avec droit « peut modifier ») : chaque personne saisit ses propres
identifiants dans ses applications.

## Vérification

```bash
curl -i -X OPTIONS -H "Origin: https://cgreg21.github.io" \
  -H "Access-Control-Request-Method: PROPFIND" \
  https://budget-caldav-proxy.<compte>.workers.dev/remote.php/dav/calendars/alice/budget/
```

doit répondre `204` avec `Access-Control-Allow-Origin: https://cgreg21.github.io`. Sans en-tête
`Origin`, la réponse est `403`.

## Développement

- `npm test` : tests unitaires (Node, sans réseau).
- `npm run dev` : Worker local sur `http://localhost:8787`.
- `npm run tail` : journaux du Worker déployé (aucun identifiant n'y est écrit).
