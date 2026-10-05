# Composants tiers

## chirpstack-rest-api — MIT

Les fichiers de `internal/csapi/` sont copiés sans modification depuis
[chirpstack/chirpstack-rest-api](https://github.com/chirpstack/chirpstack-rest-api)
(dossier `api/`, commit `a70066721289ffe3647745476c04a5dfa4457389`).
Licence : `internal/csapi/LICENSE-chirpstack-rest-api`.

Pour les mettre à jour : recopier le dossier `api/` d'une version plus récente de
chirpstack-rest-api et mettre à jour `internal/csapi/SOURCE`.

## Polices IBM Plex Sans et JetBrains Mono — SIL Open Font License 1.1

`web/assets/fonts/` : sous-ensembles latins des versions variables (distribution Fontsource).
Licences : `web/assets/fonts/LICENSE-IBM-Plex-Sans.txt` et `web/assets/fonts/LICENSE-JetBrains-Mono.txt`.

## SheetJS Community Edition (xlsx 0.18.5) — Apache 2.0

`web/vendor/xlsx.full.min.js`, licence : `web/vendor/LICENSE-xlsx`.

## Bibliothèques Go

grpc-go, grpc-gateway, protobuf-go et genproto (Apache 2.0 / BSD-3-Clause),
ainsi que le module Go de l'API ChirpStack (MIT). Voir `go.mod`.
