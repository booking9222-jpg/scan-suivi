# Leboncoin Photo AI — site web privé

Ce projet permet d'utiliser l'outil depuis **Android, iPhone ou PC** :

1. connexion par identifiant et mot de passe ;
2. prise ou ajout d'une photo ;
3. génération du titre, de la description, de la catégorie et d'un prix indicatif ;
4. modification et copie des champs ;
5. ouverture du dépôt d'annonce Leboncoin.

La publication reste volontairement manuelle.

## Mise en ligne conseillée : Render + GitHub

### 1. Mettre le dossier sur GitHub

- Créer un dépôt GitHub privé.
- Envoyer tous les fichiers de ce dossier dans le dépôt.
- Ne jamais ajouter une vraie clé API dans les fichiers.

### 2. Créer le service sur Render

- Créer un nouveau **Web Service** depuis le dépôt GitHub.
- Runtime : `Python 3`.
- Build command : laisser vide ou utiliser `python -m py_compile app.py`.
- Start command : `python app.py`.
- Health check path : `/healthz`.

### 3. Ajouter les variables d'environnement

Dans les paramètres du service :

- `OPENAI_API_KEY` = ta clé API OpenAI
- `APP_USERNAME` = `admin` ou un autre identifiant
- `APP_PASSWORD` = un mot de passe long et unique
- `SECRET_KEY` = une longue suite aléatoire (au moins 32 caractères)
- `OPENAI_MODEL` = `gpt-5.6-luna`
- `FORCE_SECURE_COOKIE` = `1`

Redéployer ensuite le service.

## Installation sur Android

- Ouvrir l'adresse HTTPS du site dans Chrome.
- Se connecter.
- Appuyer sur le bouton **Installer** s'il apparaît, ou menu Chrome `⋮` → **Ajouter à l'écran d'accueil**.
- L'outil s'ouvrira ensuite comme une application.

## Test local facultatif

### Windows PowerShell

```powershell
$env:OPENAI_API_KEY="TA_CLE_API"
$env:APP_USERNAME="admin"
$env:APP_PASSWORD="TON_MOT_DE_PASSE"
$env:SECRET_KEY="UNE_LONGUE_CLE_ALEATOIRE_DE_32_CARACTERES_MINIMUM"
python app.py
```

Puis ouvrir `http://127.0.0.1:8080`.

## Sécurité

- La clé API n'est jamais envoyée au navigateur : elle reste dans les variables d'environnement du serveur.
- Le dépôt GitHub peut rester privé, mais ne doit quand même contenir aucun secret.
- Le site est protégé par un mot de passe, avec cookie de session signé, limitation des essais de connexion et limitation des analyses.
- Utiliser uniquement une adresse HTTPS pour la version hébergée.

## Historique

Le bouton **Historique CSV** télécharge les annonces générées. Sur certains hébergeurs, le disque local peut être réinitialisé lors d'un redéploiement. Pour un historique permanent, définir `DATA_DIR` vers un disque persistant fourni par l'hébergeur.
