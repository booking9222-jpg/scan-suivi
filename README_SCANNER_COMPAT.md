# Scanner Suivi → ASIN → M110 — V40.3.10 + VINE Tracking V3.3.7.11

Publier ensemble :
- `Scanner-Suivi-M110-v12.html`
- `sw.js`

Conserver le dossier existant `Dernier Fonctionnel_files`.

## Changements V40.3.10

- exige le build Apps Script **3.3.7.11** ;
- réessaie automatiquement une source Google temporairement occupée (`SOURCE_BUSY`) ;
- évite qu'un ancien cache VINE vide remplace une base courante fonctionnelle ;
- conserve VINE live → cache VINE sûr → GitHub/local en secours ;
- matcher tracking exact/tokenisé conservé (`FR...`, `LA_POSTE(FR...)`, `AMZN_FR(...)`, etc.) ;
- l'export live accepte les colis physiques Amazon partagés entre plusieurs Order ID lorsque le serveur les a validés comme temporellement cohérents ;
- l'ancien fichier Order History reste strict : un tracking historique réutilisé entre plusieurs Order ID est mis en quarantaine ;
- Service Worker `vine-m110-v40.3.10`, appels Apps Script/API/externe en réseau pur ;
- profils M110, caméra, impression, formats, catalogue et correctif 40×20 / marge droite 1,5 mm conservés.


V40.3.10 ne change pas le moteur d'impression/recherche M110 : seul le contrôle de compatibilité exige désormais le serveur V3.3.7.11.
