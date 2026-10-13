# budget-caldav-proxy

Proxy CORS pour exposer un serveur CalDAV hébergé (Infomaniak, Murena, Disroot, Mailo, Nextcloud…) à la
PWA Budget. Les navigateurs n'autorisent la PWA à parler qu'aux serveurs qui renvoient des en-têtes
CORS, ce qu'aucun hébergeur grand public ne fait. Ce Worker Cloudflare relaie les quelques méthodes
CalDAV utilisées par l'application (`OPTIONS`, `GET`, `PUT`, `DELETE`, `PROPFIND`, `REPORT`) et ajoute
les en-têtes. Il ne stocke rien et n'a aucun secret. Le serveur cible est indiqué par l'application à
chaque appel (en-tête `X-Upstream`), un même déploiement sert donc n'importe quel fournisseur.

Les applications mobile et bureau n'en ont pas besoin : elles parlent directement au serveur CalDAV.

## Fonctionnement

L'application envoie la requête au Worker avec le **même chemin** que sur le serveur et ajoute l'en-tête
`X-Upstream: https://<serveur>`. Le Worker la relaie vers `https://<serveur><chemin>` et renvoie la
réponse avec les en-têtes CORS. Garder le chemin intact permet aux `href` renvoyés par le serveur de
rester valides côté client.

```
PROPFIND https://budget-caldav-proxy.<compte>.workers.dev/remote.php/dav/calendars/alice/budget/
X-Upstream: https://cloud.example.org
Authorization: Basic …
```

## Sécurité

- Le proxy **voit passer les identifiants et les événements** (chiffrés en transit, jamais stockés).
  Déployez-le sur **votre propre compte** Cloudflare, pas sur un service tiers.
- Par défaut **toutes les origines** et **tout serveur https** sont acceptés. Le proxy ne fait que
  relayer avec les identifiants fournis par chaque requête : un tiers ne peut rien lire sans un compte
  valide sur le serveur visé. Pour restreindre : `ALLOWED_ORIGINS` (origines des applications) et
  `ALLOWED_UPSTREAMS` (serveurs acceptés dans `X-Upstream`) ; tout autre reçoit `403`.
- `ALLOWED_PATHS` limite les chemins relayés au point d'accès DAV du serveur.
- Les méthodes hors liste reçoivent `405` ; les en-têtes transmis sont filtrés dans les deux sens
  (pas de cookies, uniquement `Authorization`, `Depth`, `Content-Type`, `If-Match`, `If-None-Match`,
  `Prefer` en entrée ; `ETag`, `Content-Type`, `DAV`, `Allow`, `Location` en sortie).

## Prérequis

- Node.js 22+ et un compte Cloudflare gratuit (<https://dash.cloudflare.com/sign-up>, sans carte
  bancaire). Le plan gratuit Workers autorise 100 000 requêtes par jour, largement suffisant.

## Configuration

Aucune configuration n'est nécessaire : le déploiement par défaut accepte toutes les origines et tous
les serveurs https. Les variables de `wrangler.toml` (ou du tableau de bord Cloudflare) permettent de
restreindre ou de fixer une cible :

```toml
[vars]
UPSTREAM = ""            # serveur par défaut si l'appel n'a pas d'en-tête X-Upstream (https, sans chemin)
ALLOWED_UPSTREAMS = ""   # serveurs acceptés dans X-Upstream, vide = tous ; ex. "https://cloud.example.org"
ALLOWED_ORIGINS = ""     # origines des applications, vide ou "*" = toutes ; ex. "https://user.github.io"
ALLOWED_PATHS = ""       # préfixes de chemin autorisés, vide = tous ; ex. "/remote.php/dav/"
```

Quelques valeurs selon le logiciel du serveur :

| Serveur | Origine (`X-Upstream` / `UPSTREAM`) | `ALLOWED_PATHS` | URL de calendrier côté serveur |
| --- | --- | --- | --- |
| Nextcloud (ou hébergeur Nextcloud) | `https://<hôte>` | `/remote.php/dav/` | `/remote.php/dav/calendars/<utilisateur>/<calendrier>/` |
| Infomaniak | `https://sync.infomaniak.com` | `/calendars/` | `/calendars/<DSxxxxx>/<id-calendrier>/` |
| Radicale | `https://<hôte>` | `/` | `/<utilisateur>/<calendrier>/` |
| Baïkal | `https://<hôte>` | `/dav.php/` | `/dav.php/calendars/<utilisateur>/<calendrier>/` |

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

Dans **Réglages → Calendrier** de la PWA, laissez l'URL du calendrier telle quelle (celle du serveur) et
renseignez l'adresse du Worker dans le champ **Proxy CORS** :

| | Exemple |
| --- | --- |
| URL du calendrier | `https://cloud.example.org/remote.php/dav/calendars/alice/budget/` |
| Proxy CORS | `https://budget-caldav-proxy.<compte>.workers.dev` |
| Identifiant | `alice` |
| Mot de passe | mot de passe d'application du fournisseur |

La PWA envoie alors chaque requête au Worker avec l'en-tête `X-Upstream: https://cloud.example.org`.
Les applications mobile et bureau n'ont rien à configurer. Le calendrier reste partagé normalement par
le fournisseur (invitations avec droit « peut modifier ») : chaque personne saisit ses propres
identifiants dans ses applications.

## Vérification

```bash
curl -i -X OPTIONS -H "Origin: https://your-user.github.io" \
  -H "Access-Control-Request-Method: PROPFIND" \
  https://budget-caldav-proxy.<compte>.workers.dev/remote.php/dav/calendars/alice/budget/
```

doit répondre `204` avec `Access-Control-Allow-Origin: https://your-user.github.io`. Puis un relais réel :

```bash
curl -i -X PROPFIND -H "Origin: https://your-user.github.io" -H "Depth: 0" \
  -H "X-Upstream: https://cloud.example.org" -u alice:motdepasse \
  https://budget-caldav-proxy.<compte>.workers.dev/remote.php/dav/calendars/alice/budget/
```

doit renvoyer la réponse `207` du serveur. Sans `X-Upstream` ni `UPSTREAM`, la réponse est `400` ; si
`ALLOWED_ORIGINS` ou `ALLOWED_UPSTREAMS` sont renseignés, une valeur hors liste reçoit `403`.

## Développement

- `npm test` : tests unitaires (Node, sans réseau).
- `npm run dev` : Worker local sur `http://localhost:8787`.
- `npm run tail` : journaux du Worker déployé (aucun identifiant n'y est écrit).
