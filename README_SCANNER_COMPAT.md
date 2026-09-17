# Scanner Suivi → ASIN → M110 — V40.3.3 + VINE Tracking V3.3.7

Fichiers à publier ensemble :

- `Scanner-Suivi-M110-v12.html`
- `sw.js`

Cette build conserve le dernier Scanner V40 fourni et ajoute/corrige uniquement l'intégration VINE Tracking.

## V40.3.3

- `ORDER_HISTORY_URL` lecture seule, liée au Google Sheet par `s=` ;
- VINE live → cache VINE sûr → GitHub live → cache GitHub/local ;
- comparaison tracking exacte/tokenisée ;
- comparaison ASIN exacte/tokenisée ;
- cache VINE lié à sa source ;
- actualisation automatique ;
- avant un scan physique, si la base VINE live a plus de 2 minutes, le scan attend la tentative d'actualisation puis est rejoué une fois ;
- timeout de cette actualisation préalable : 12 s ;
- cooldown de secours : 30 s afin d'éviter de bloquer chaque colis pendant une panne ;
- auto-impression 1 produit compatible avec les cellules `AMZN_FR(FR...)`, `UPS(...)`, etc. grâce au même matcher exact que la recherche ;
- Service Worker `vine-m110-v40.3.3`, ressources API/Apps Script toujours réseau pur ;
- fallback Order History local/GitHub : conservation de `Order ID` et quarantaine de tout tracking réutilisé entre plusieurs commandes ;
- cellules multi-tracking, placeholders et lignes sans Order ID exploitable exclues du fallback physique.

Le correctif 40×20 (code-barres aligné à droite + marge de sécurité 1,5 mm), les profils M110, la caméra, le rangement, le catalogue, les autres formats et le fichier de correspondance restent présents.


## Sécurité du fallback historique

Le fallback n'est utilisé que si VINE live/cache n'est pas disponible. V40.3.3 ne considère comme sûres que les lignes ayant exactement un tracking plausible, un `Order ID` valide et un tracking qui n'apparaît dans **aucun autre Order ID** du fichier. Plusieurs ASIN du même Order ID restent valides.

Sur le fichier historique de référence de 26 551 lignes, cette règle conserve 6 817 lignes sûres et met 19 734 lignes ambiguës/inexploitables en quarantaine, dont 19 249 lignes appartenant à des tracking réutilisés entre commandes.
