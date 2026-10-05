# ChirpStack Toolbox

**Les fonctions qui manquent à ChirpStack v4, en un seul fichier.**
Téléchargez, double-cliquez, collez votre clé API : c'est tout.

Pas de serveur à installer, pas de Docker, pas de Python, pas de compte à créer.
L'outil tourne sur votre poste et parle directement à votre ChirpStack.

---

## Ce que ça fait

| Outil | Description |
|---|---|
| **Import** | CSV ou Excel, reconnaissance automatique des colonnes, tags, validation DevEUI/AppKey, détection des doublons, annulation du dernier import |
| **Ajout manuel** | 1 à 5 devices sans fichier |
| **Export** | CSV ou XLSX de toute une application, filtres (profil, activité, tag), clés en option |
| **Suppression en masse** | Sélection, recherche, confirmation par saisie du nombre de devices |
| **Migration** | Déplacer des devices d'une application à une autre en gardant clés et tags |
| **Changement de Device Profile** | En masse |
| **Mise à jour des tags** | Depuis un fichier, en fusion ou en remplacement |
| **Recherche** | Un DevEUI (complet ou partiel) dans toutes les applications du tenant |
| **Analyse** | Actifs, inactifs, jamais vus, répartition par profil, métriques radio par device |
| **Modèle CSV** | Fichier prêt à remplir selon le profil choisi |
| **Tableau de bord tenant** | Devices actifs, inactifs, jamais vus, gateways |

## Démarrage en 1 minute

1. Téléchargez le fichier correspondant à votre système dans [Releases](../../releases/latest) :

   | Système | Fichier |
   |---|---|
   | Windows | `chirpstack-toolbox-windows-amd64.exe` |
   | macOS (Apple Silicon M1/M2/M3…) | `chirpstack-toolbox-macos-arm64` |
   | macOS (Intel) | `chirpstack-toolbox-macos-amd64` |
   | Linux | `chirpstack-toolbox-linux-amd64` (ou `-arm64`, par exemple pour un Raspberry Pi) |

2. Lancez-le. Votre navigateur s'ouvre tout seul sur l'outil.
3. Entrez **l'adresse de votre ChirpStack** (celle que vous tapez pour ouvrir son interface, par exemple `http://192.168.1.10:8080`) et **votre clé API**.

> **Où créer une clé API ?** Dans ChirpStack, menu **API Keys** (clé admin, accès à tous les tenants),
> ou dans un tenant, menu **API Keys** (clé limitée à ce tenant). Une fois connecté avec une clé tenant,
> l'outil vous demandera l'identifiant du tenant : il apparaît dans l'URL de ChirpStack
> (`/#/tenants/<ID>/...`).

Gardez la fenêtre noire (terminal) ouverte pendant l'utilisation ; fermez-la pour arrêter l'outil.

### Premier lancement : avertissements du système

Le fichier n'est pas signé numériquement (une signature coûte plusieurs centaines d'euros par an). Votre système va donc vous prévenir une première fois :

- **Windows** : « Windows a protégé votre ordinateur » → *Informations complémentaires* → *Exécuter quand même*.
- **macOS** : clic droit sur le fichier → *Ouvrir* → *Ouvrir*. Si macOS refuse toujours, dans un terminal :
  `xattr -d com.apple.quarantine chirpstack-toolbox-macos-*` puis `chmod +x chirpstack-toolbox-macos-*`.
- **Linux** : `chmod +x chirpstack-toolbox-linux-*` puis `./chirpstack-toolbox-linux-amd64`.

Le code source est entièrement disponible ici : vous pouvez le relire ou compiler l'outil vous-même (voir plus bas).

## Sécurité et confidentialité

- **Votre clé API reste sur votre poste.** Elle n'est jamais enregistrée sur le disque et n'est envoyée qu'à votre serveur ChirpStack.
- **Aucune donnée n'est envoyée ailleurs** : pas de statistiques, pas de télémétrie, aucun appel vers internet. L'outil fonctionne sans connexion internet.
- **Le relais local n'écoute que sur votre machine** (`127.0.0.1`) : il est inaccessible depuis le réseau. Il refuse aussi les requêtes venant d'autres sites web.
- **Les serveurs enregistrés et les profils d'import** sont gardés dans votre navigateur. Vous pouvez les exporter ou les importer en JSON depuis *Options avancées* pour les partager avec un collègue (les clés API n'en font jamais partie).

> Les opérations en masse (suppression, migration) sont **irréversibles**. Faites un essai sur une application de test.

## Compatibilité

- ChirpStack **v4** (toutes versions récentes).
- Fonctionne avec l'adresse de l'interface web de ChirpStack, en HTTP ou HTTPS, y compris derrière un reverse proxy (nginx, traefik…).
- Certificat auto-signé : cochez *Options avancées → Accepter un certificat HTTPS auto-signé*.
- Si vous utilisez déjà le composant `chirpstack-rest-api` (port 8090), choisissez *Options avancées → Type d'accès → API REST*.

## Options de lancement

```
chirpstack-toolbox --port 9000      # changer le port local (8765 par défaut)
chirpstack-toolbox --no-browser     # ne pas ouvrir le navigateur automatiquement
chirpstack-toolbox --version
```

## Comment ça marche

Un navigateur ne peut pas appeler directement l'API de ChirpStack depuis une autre page : ChirpStack n'autorise pas ce type de requête (règle CORS). L'exécutable sert donc deux choses à la fois, sur votre machine uniquement :

1. **l'interface web** (un seul fichier HTML, embarqué dans l'exécutable) ;
2. **un petit relais** qui traduit les appels de l'interface en appels **gRPC-web** vers ChirpStack. C'est le même protocole que celui de l'interface officielle de ChirpStack : partout où l'interface ChirpStack s'ouvre, l'outil fonctionne.

```
Navigateur ──HTTP local──▶ chirpstack-toolbox (127.0.0.1) ──gRPC-web──▶ votre ChirpStack
```

## Compiler soi-même

Il faut [Go](https://go.dev/dl/) (version indiquée dans `go.mod`).

```bash
go test ./...
go build -trimpath -ldflags "-s -w" -o chirpstack-toolbox .
```

Pour une autre plateforme : `GOOS=windows GOARCH=amd64 go build ...`

Pour publier une version : poussez un tag `vX.Y.Z`. GitHub Actions compile automatiquement les exécutables et crée la release.

### Organisation du code

```
main.go               lancement, ouverture du navigateur
server.go             serveur local : interface + relais /api/*
internal/grpcweb/     client gRPC-web minimal
internal/csapi/       définitions de l'API ChirpStack (reprises de chirpstack-rest-api)
web/index.html        l'interface complète
web/vendor/           SheetJS (lecture/écriture Excel), embarqué pour le hors-ligne
```

## Licence

MIT, voir [LICENSE](LICENSE). Composants tiers : voir [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Projet indépendant, non affilié à ChirpStack ni à ses auteurs.
