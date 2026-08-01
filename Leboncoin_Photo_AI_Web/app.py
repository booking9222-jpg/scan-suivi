# -*- coding: utf-8 -*-
"""Leboncoin Photo AI Web — site privé pour Android et PC.

Aucune dépendance Python externe n'est nécessaire.
Les secrets restent dans les variables d'environnement du serveur.
La publication finale sur Leboncoin reste manuelle.
"""
from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict, deque
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

APP_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", str(APP_DIR / "data"))).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)
HISTORY_FILE = DATA_DIR / "historique_annonces.csv"
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8080"))
APP_USERNAME = os.environ.get("APP_USERNAME", "admin").strip() or "admin"
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
SECRET_KEY = os.environ.get("SECRET_KEY", "").encode("utf-8") or secrets.token_bytes(32)
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.6-luna").strip() or "gpt-5.6-luna"
OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
COOKIE_NAME = "lbc_photo_session"
SESSION_SECONDS = int(os.environ.get("SESSION_SECONDS", str(7 * 24 * 3600)))
MAX_JSON_BODY = 22 * 1024 * 1024
MAX_IMAGE_BYTES = 15 * 1024 * 1024

SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "identification": {"type": "string"},
        "titre": {"type": "string"},
        "categorie": {"type": "string"},
        "sous_categorie": {"type": "string"},
        "marque": {"type": "string"},
        "modele": {"type": "string"},
        "etat": {
            "type": "string",
            "enum": ["Neuf", "Très bon état", "Bon état", "État satisfaisant", "Pour pièces", "À vérifier"],
        },
        "prix_conseille": {"type": "number"},
        "prix_min": {"type": "number"},
        "prix_max": {"type": "number"},
        "description": {"type": "string"},
        "caracteristiques": {"type": "array", "items": {"type": "string"}},
        "incertitudes": {"type": "array", "items": {"type": "string"}},
        "confiance": {"type": "integer", "minimum": 0, "maximum": 100},
        "conseils_photo": {"type": "array", "items": {"type": "string"}},
        "avertissement": {"type": "string"},
    },
    "required": [
        "identification", "titre", "categorie", "sous_categorie", "marque", "modele", "etat",
        "prix_conseille", "prix_min", "prix_max", "description", "caracteristiques", "incertitudes",
        "confiance", "conseils_photo", "avertissement",
    ],
}

LOGIN_HTML = r'''<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#ff6e14"><title>Connexion — Leboncoin Photo AI</title>
<style>
:root{--ink:#1d1b2e;--muted:#706b80;--accent:#ff6e14;--purple:#6b4eff;--border:#e7e1ef}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;font-family:Inter,Segoe UI,Arial,sans-serif;color:var(--ink);background:radial-gradient(circle at 0 0,#fff0e6,transparent 40%),radial-gradient(circle at 100% 0,#eee9ff,transparent 43%),#f6f4fb}.card{width:min(430px,100%);background:#fff;border:1px solid var(--border);border-radius:26px;padding:26px;box-shadow:0 25px 70px rgba(58,37,93,.13)}.logo{width:58px;height:58px;border-radius:19px;display:grid;place-items:center;background:linear-gradient(135deg,var(--accent),#ff9c4e);font-size:30px;box-shadow:0 12px 28px rgba(255,110,20,.25)}h1{font-size:27px;margin:18px 0 5px;letter-spacing:-.8px}p{color:var(--muted);margin:0 0 22px;line-height:1.45}label{display:block;font-weight:800;font-size:13px;margin:14px 0 7px}input{width:100%;border:1px solid var(--border);border-radius:14px;padding:13px;font:inherit;outline:none}input:focus{border-color:var(--purple);box-shadow:0 0 0 3px rgba(107,78,255,.1)}button{width:100%;margin-top:18px;border:0;border-radius:14px;padding:14px;color:#fff;background:linear-gradient(135deg,var(--purple),#8b70ff);font:inherit;font-weight:900;cursor:pointer}.msg{display:none;margin-top:14px;padding:11px;border-radius:12px;background:#fff0ef;color:#a52218;font-size:13px}.msg.show{display:block}.note{font-size:12px;color:var(--muted);margin-top:18px;text-align:center}</style></head>
<body><main class="card"><div class="logo">📸</div><h1>Leboncoin Photo AI</h1><p>Site privé : connecte-toi pour créer une annonce depuis une photo.</p>
<form id="login"><label>Identifiant</label><input id="username" autocomplete="username" value="admin" required><label>Mot de passe</label><input id="password" type="password" autocomplete="current-password" required><button>Se connecter</button><div id="msg" class="msg"></div></form>
<div class="note">La clé OpenAI reste uniquement sur le serveur.</div></main>
<script>document.querySelector('#login').addEventListener('submit',async e=>{e.preventDefault();const b=e.submitter,m=document.querySelector('#msg');m.className='msg';b.disabled=true;try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.querySelector('#username').value,password:document.querySelector('#password').value})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Connexion impossible');location.href='/';}catch(x){m.textContent=x.message;m.className='msg show'}finally{b.disabled=false}});</script></body></html>'''

APP_HTML = r'''<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#ff6e14"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon-192.png"><title>Leboncoin Photo AI</title>
<style>
:root{--bg:#f5f3ff;--card:#fff;--ink:#1d1b2e;--muted:#6d6880;--accent:#ff6e14;--accent2:#6b4eff;--border:#e6e0f0;--ok:#147d50;--warn:#a45400;--danger:#b42318;--shadow:0 18px 50px rgba(54,35,97,.10)}
*{box-sizing:border-box}html{min-height:100%}body{margin:0;font-family:Inter,Segoe UI,Arial,sans-serif;background:radial-gradient(circle at 5% 0%,#fff0e7 0,transparent 33%),radial-gradient(circle at 95% 5%,#ece7ff 0,transparent 38%),var(--bg);color:var(--ink);min-height:100vh}.wrap{max-width:1120px;margin:auto;padding:20px 15px calc(45px + env(safe-area-inset-bottom))}.hero{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.brand{display:flex;align-items:center;gap:12px}.logo{width:52px;height:52px;border-radius:17px;background:linear-gradient(135deg,var(--accent),#ff9d4f);display:grid;place-items:center;box-shadow:0 10px 28px rgba(255,110,20,.28);font-size:27px}.hero h1{font-size:clamp(23px,5vw,37px);margin:0;letter-spacing:-1.2px}.hero p{margin:4px 0 0;color:var(--muted);font-size:14px}.top-actions{display:flex;gap:8px;align-items:center}.status{font-size:12px;padding:8px 10px;border:1px solid var(--border);border-radius:999px;background:rgba(255,255,255,.86);white-space:nowrap}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:#aaa}.dot.ok{background:#20a46b}.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px}.card{background:rgba(255,255,255,.97);border:1px solid rgba(230,224,240,.95);border-radius:23px;padding:20px;box-shadow:var(--shadow)}.card h2{font-size:19px;margin:0 0 15px}.field{margin-bottom:13px}.field label{display:block;font-weight:800;font-size:13px;margin-bottom:7px}.hint{font-weight:400;color:var(--muted)}input,textarea,select{width:100%;border:1px solid var(--border);background:#fff;border-radius:13px;padding:12px 13px;font:inherit;color:var(--ink);outline:none}input:focus,textarea:focus,select:focus{border-color:#8f7aff;box-shadow:0 0 0 3px rgba(107,78,255,.10)}textarea{resize:vertical;min-height:90px}.drop{border:2px dashed #cfc5e9;border-radius:19px;padding:18px;text-align:center;cursor:pointer;transition:.2s;background:#fbfaff;position:relative;overflow:hidden;min-height:230px;display:grid;place-items:center}.drop:hover,.drop.drag{border-color:var(--accent2);background:#f6f2ff}.drop input{position:absolute;inset:0;opacity:0;cursor:pointer}.preview{display:none;max-height:330px;max-width:100%;border-radius:15px;margin:auto}.drop.has-image .empty{display:none}.drop.has-image .preview{display:block}.empty .big{font-size:43px}.empty strong{display:block;margin-top:8px}.empty small{display:block;color:var(--muted);margin-top:5px;line-height:1.35}.row{display:grid;grid-template-columns:1fr 1fr;gap:11px}.check{display:flex;gap:9px;align-items:flex-start;font-size:13px;color:var(--muted)}.check input{width:auto;margin-top:3px}.btn{border:0;border-radius:14px;padding:13px 16px;font:inherit;font-weight:900;cursor:pointer;transition:.15s;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}.btn:active{transform:translateY(1px)}.primary{width:100%;color:#fff;background:linear-gradient(135deg,var(--accent2),#8a6cff);box-shadow:0 10px 24px rgba(107,78,255,.22)}.primary:disabled{opacity:.55;cursor:not-allowed}.secondary{background:#f3effb;color:#443966}.orange{background:var(--accent);color:#fff}.ghost{background:#fff;border:1px solid var(--border);color:var(--ink)}.small{padding:9px 11px;font-size:12px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.actions .btn{font-size:13px;padding:10px 12px}.msg{display:none;margin-top:13px;border-radius:13px;padding:12px 13px;font-size:14px}.msg.show{display:block}.msg.error{background:#fff0ef;color:var(--danger);border:1px solid #ffd2cd}.msg.info{background:#f1efff;color:#4935a8;border:1px solid #dcd4ff}.loader{display:none;text-align:center;padding:36px 8px;color:var(--muted)}.loader.show{display:block}.spinner{width:42px;height:42px;border:4px solid #e8e1fa;border-top-color:var(--accent2);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 13px}@keyframes spin{to{transform:rotate(360deg)}}.results{display:none}.results.show{display:block}.result-head{display:flex;justify-content:space-between;align-items:center;gap:12px}.score{font-size:12px;font-weight:900;border-radius:999px;padding:7px 10px;background:#eee}.score.high{background:#e9f8f1;color:var(--ok)}.score.mid{background:#fff5df;color:var(--warn)}.score.low{background:#fff0ef;color:var(--danger)}.output{border:1px solid var(--border);border-radius:15px;padding:13px;margin-bottom:11px;background:#fdfcff}.output .label{font-size:11px;text-transform:uppercase;letter-spacing:.7px;font-weight:900;color:var(--muted);margin-bottom:6px}.output textarea{min-height:165px;line-height:1.48}.price-line{display:grid;grid-template-columns:130px 1fr;gap:10px;align-items:center}.price-line input{font-size:23px;font-weight:900;color:var(--accent)}.chips{display:flex;gap:7px;flex-wrap:wrap}.chip{font-size:12px;padding:6px 9px;border-radius:999px;background:#f0ecfa}.alert{border-radius:14px;padding:11px 13px;margin:10px 0;font-size:13px;line-height:1.45}.alert.warn{background:#fff7e6;color:#865000}.alert.safe{background:#edf9f3;color:#11663f}.placeholder{display:grid;place-items:center;text-align:center;min-height:410px;color:var(--muted)}.placeholder .big{font-size:55px}.footer{text-align:center;color:var(--muted);font-size:12px;margin-top:20px;line-height:1.4}.hidden{display:none!important}.install{display:none}
@media(max-width:820px){.grid{grid-template-columns:1fr}.hero{align-items:flex-start}.status{display:none}.hero p{max-width:240px}.card{padding:17px}.drop{min-height:205px}.placeholder{min-height:180px}.top-actions{flex-direction:column;align-items:stretch}.top-actions .btn{padding:8px 10px}.row{grid-template-columns:1fr}.price-line{grid-template-columns:105px 1fr}.actions .btn{flex:1 1 calc(50% - 8px)}}
</style></head><body><div class="wrap">
<header class="hero"><div class="brand"><div class="logo">📸</div><div><h1>Leboncoin Photo AI</h1><p>Une photo → un brouillon d’annonce prêt à vérifier.</p></div></div><div class="top-actions"><div class="status"><span id="statusDot" class="dot"></span><span id="statusText">Vérification…</span></div><button id="installBtn" class="btn ghost small install">Installer</button><button id="logout" class="btn ghost small">Déconnexion</button></div></header>
<main class="grid"><section class="card"><h2>1. Ajouter le produit</h2><div id="drop" class="drop"><input id="photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment"><div class="empty"><div class="big">🖼️</div><strong>Prendre ou choisir une photo</strong><small>Une photo nette de face, avec marque ou étiquette visible, améliore le résultat.</small></div><img id="preview" class="preview" alt="Aperçu"></div>
<div class="field" style="margin-top:15px"><label>Informations facultatives <span class="hint">(défaut, dimensions, accessoires…)</span></label><textarea id="notes" placeholder="Exemple : testé et fonctionnel, petite rayure au dos, vendu avec chargeur."></textarea></div>
<div class="row"><div class="field"><label>État indiqué par toi</label><select id="etat"><option value="">Laisser l’IA proposer</option><option>Neuf</option><option>Très bon état</option><option>Bon état</option><option>État satisfaisant</option><option>Pour pièces</option></select></div><div class="field"><label>Ton prix minimum (€)</label><input id="prixMinUser" type="number" min="0" step="1" inputmode="decimal" placeholder="Facultatif"></div></div>
<label class="check"><input id="webSearch" type="checkbox"><span>Rechercher des prix comparables sur le web pour améliorer l’estimation.</span></label><button id="generate" class="btn primary" style="margin-top:15px">Générer l’annonce</button><div id="message" class="msg"></div></section>
<section class="card"><div id="placeholder" class="placeholder"><div><div class="big">✨</div><h2>L’annonce apparaîtra ici</h2><div>Tu pourras modifier tous les champs avant de les copier.</div></div></div><div id="loader" class="loader"><div class="spinner"></div><strong>Analyse de la photo…</strong><div style="margin-top:5px">Identification, titre, description et prix.</div></div>
<div id="results" class="results"><div class="result-head"><h2>2. Vérifier l’annonce</h2><span id="score" class="score"></span></div>
<div class="output"><div class="label">Titre</div><input id="outTitre" maxlength="70"></div><div class="row"><div class="output"><div class="label">Catégorie</div><input id="outCategorie"></div><div class="output"><div class="label">Sous-catégorie</div><input id="outSousCategorie"></div></div><div class="row"><div class="output"><div class="label">État</div><input id="outEtat"></div><div class="output"><div class="label">Marque / modèle</div><input id="outModele"></div></div>
<div class="output"><div class="label">Prix conseillé</div><div class="price-line"><input id="outPrix" type="number" min="0" step="1" inputmode="decimal"><div id="fourchette" style="color:var(--muted);font-size:13px"></div></div></div><div class="output"><div class="label">Description</div><textarea id="outDescription"></textarea></div><div class="output"><div class="label">Caractéristiques détectées</div><div id="caracs" class="chips"></div></div><div id="warning" class="alert warn hidden"></div><div id="uncertainties" class="alert warn hidden"></div><div id="photoAdvice" class="alert safe hidden"></div>
<div class="actions"><button id="copyTitle" class="btn secondary">Copier le titre</button><button id="copyDesc" class="btn secondary">Copier la description</button><button id="copyAll" class="btn secondary">Copier tout</button><button id="newPhoto" class="btn ghost">Nouvelle photo</button><button id="openLbc" class="btn orange">Ouvrir Leboncoin</button><a class="btn ghost" href="/historique.csv">Historique CSV</a></div></div></section></main><div class="footer">Toujours vérifier le modèle exact, l’état, l’authenticité, les accessoires, le prix et les règles de la catégorie avant publication.</div></div>
<script>
const $=s=>document.querySelector(s);let imageData=null,result=null,deferredPrompt=null;
async function api(path,options={}){const r=await fetch(path,{headers:{'Content-Type':'application/json',...(options.headers||{})},...options});let d={};try{d=await r.json()}catch(e){}if(r.status===401){location.href='/login';throw new Error('Session expirée')}if(!r.ok)throw new Error(d.error||`Erreur ${r.status}`);return d}
function showMsg(text,type='error'){const e=$('#message');e.textContent=text;e.className=`msg show ${type}`}function clearMsg(){$('#message').className='msg'}
async function status(){try{const s=await api('/api/status');$('#statusDot').className='dot '+(s.api_configured?'ok':'');$('#statusText').textContent=s.api_configured?`API prête — ${s.model}`:'Clé OpenAI manquante';if(!s.api_configured)showMsg('Le serveur doit recevoir la variable OPENAI_API_KEY.')}catch(e){}}
async function compress(file){return new Promise((resolve,reject)=>{const img=new Image(),url=URL.createObjectURL(file);img.onload=()=>{let w=img.width,h=img.height,max=1800;if(Math.max(w,h)>max){const k=max/Math.max(w,h);w=Math.round(w*k);h=Math.round(h*k)}const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);URL.revokeObjectURL(url);resolve(c.toDataURL('image/jpeg',.84))};img.onerror=()=>reject(new Error('Image illisible'));img.src=url})}
async function loadFile(file){if(!file)return;if(!file.type.startsWith('image/'))return showMsg('Choisis une image JPG, PNG ou WebP.');if(file.size>20*1024*1024)return showMsg('La photo dépasse 20 Mo.');clearMsg();try{imageData=await compress(file);$('#preview').src=imageData;$('#drop').classList.add('has-image')}catch(e){showMsg(e.message)}}
$('#photo').addEventListener('change',e=>loadFile(e.target.files[0]));const drop=$('#drop');['dragenter','dragover'].forEach(n=>drop.addEventListener(n,e=>{e.preventDefault();drop.classList.add('drag')}));['dragleave','drop'].forEach(n=>drop.addEventListener(n,e=>{e.preventDefault();drop.classList.remove('drag')}));drop.addEventListener('drop',e=>loadFile(e.dataTransfer.files[0]));
$('#generate').onclick=async()=>{if(!imageData)return showMsg('Ajoute d’abord une photo.');clearMsg();$('#placeholder').classList.add('hidden');$('#results').classList.remove('show');$('#loader').classList.add('show');$('#generate').disabled=true;try{result=await api('/api/analyze',{method:'POST',body:JSON.stringify({image_data_url:imageData,notes:$('#notes').value.trim(),etat:$('#etat').value,prix_min_utilisateur:$('#prixMinUser').value,web_search:$('#webSearch').checked})});render(result)}catch(e){showMsg(e.message);$('#placeholder').classList.remove('hidden')}finally{$('#loader').classList.remove('show');$('#generate').disabled=false}};
function euro(n){return Number(n)>0?new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(n):'À vérifier'}function val(id,v){$(id).value=v??''}
function render(r){$('#results').classList.add('show');val('#outTitre',r.titre);val('#outCategorie',r.categorie);val('#outSousCategorie',r.sous_categorie);val('#outEtat',r.etat);val('#outModele',[r.marque,r.modele].filter(Boolean).join(' '));val('#outPrix',r.prix_conseille||'');val('#outDescription',r.description);$('#fourchette').textContent=(r.prix_min>0||r.prix_max>0)?`Fourchette : ${euro(r.prix_min)} à ${euro(r.prix_max)}`:'Prix à vérifier';$('#caracs').innerHTML='';(r.caracteristiques||[]).forEach(x=>{const e=document.createElement('span');e.className='chip';e.textContent=x;$('#caracs').appendChild(e)});const c=Number(r.confiance||0),s=$('#score');s.textContent=`Confiance ${c}%`;s.className='score '+(c>=75?'high':c>=50?'mid':'low');box('#warning',r.avertissement);box('#uncertainties',(r.incertitudes||[]).length?'À vérifier : '+r.incertitudes.join(' • '):'');box('#photoAdvice',(r.conseils_photo||[]).length?'Photos conseillées : '+r.conseils_photo.join(' • '):'')}
function box(sel,text){const e=$(sel);e.textContent=text||'';e.classList.toggle('hidden',!text)}async function copy(text){try{await navigator.clipboard.writeText(text);showMsg('Copié dans le presse-papiers.','info')}catch(e){showMsg('Copie impossible : maintiens le doigt sur le texte pour le copier.')}}
$('#copyTitle').onclick=()=>copy($('#outTitre').value);$('#copyDesc').onclick=()=>copy($('#outDescription').value);$('#copyAll').onclick=()=>copy(`${$('#outTitre').value}\n\nCatégorie : ${$('#outCategorie').value}${$('#outSousCategorie').value?' > '+$('#outSousCategorie').value:''}\nÉtat : ${$('#outEtat').value}\nPrix : ${$('#outPrix').value||'à vérifier'} €\n\n${$('#outDescription').value}`);$('#openLbc').onclick=()=>window.open('https://www.leboncoin.fr/deposer-une-annonce','_blank','noopener');$('#newPhoto').onclick=()=>{imageData=null;result=null;$('#photo').value='';$('#preview').src='';$('#drop').classList.remove('has-image');$('#results').classList.remove('show');$('#placeholder').classList.remove('hidden');window.scrollTo({top:0,behavior:'smooth'})};$('#logout').onclick=async()=>{try{await api('/api/logout',{method:'POST',body:'{}'})}catch(e){}location.href='/login'};
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;$('#installBtn').classList.remove('install')});$('#installBtn').onclick=async()=>{if(deferredPrompt){deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;$('#installBtn').classList.add('install')}};if('serviceWorker'in navigator)navigator.serviceWorker.register('/service-worker.js').catch(()=>{});status();
</script></body></html>'''

MANIFEST = {
    "name": "Leboncoin Photo AI",
    "short_name": "Photo AI",
    "start_url": "/",
    "display": "standalone",
    "background_color": "#f5f3ff",
    "theme_color": "#ff6e14",
    "icons": [
        {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
        {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png"},
    ],
}
SERVICE_WORKER = r'''const C='lbc-photo-ai-v1';self.addEventListener('install',e=>e.waitUntil(caches.open(C).then(c=>c.addAll(['/manifest.webmanifest','/icon-192.png','/icon-512.png']))));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(u.pathname.startsWith('/api/')||u.pathname==='/'||u.pathname==='/login')return;e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));});'''

_rate_lock = threading.Lock()
_rate_data: dict[str, deque[float]] = defaultdict(deque)


def client_ip(headers: Any, address: tuple[str, int]) -> str:
    forwarded = headers.get("X-Forwarded-For", "")
    return forwarded.split(",", 1)[0].strip() if forwarded else address[0]


def rate_allowed(key: str, limit: int, window: int) -> bool:
    now = time.time()
    with _rate_lock:
        q = _rate_data[key]
        while q and q[0] <= now - window:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        return True


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def make_session(username: str) -> str:
    payload = json.dumps({"u": username, "exp": int(time.time()) + SESSION_SECONDS}, separators=(",", ":")).encode()
    signature = hmac.new(SECRET_KEY, payload, hashlib.sha256).digest()
    return f"{b64url(payload)}.{b64url(signature)}"


def verify_session(token: str) -> bool:
    try:
        raw_payload, raw_sig = token.split(".", 1)
        payload = b64url_decode(raw_payload)
        signature = b64url_decode(raw_sig)
        expected = hmac.new(SECRET_KEY, payload, hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected):
            return False
        data = json.loads(payload.decode())
        return data.get("u") == APP_USERNAME and int(data.get("exp", 0)) > int(time.time())
    except Exception:
        return False


def cookie_value(cookie_header: str, name: str) -> str:
    for part in cookie_header.split(";"):
        k, sep, v = part.strip().partition("=")
        if sep and k == name:
            return v
    return ""


def prompt_for(notes: str, etat: str, prix_min_user: str, web_search: bool) -> str:
    price_instruction = (
        "Une recherche web est autorisée. Pour le prix, cherche si possible des produits identiques ou très proches vendus d'occasion en France. "
        "Ne confonds pas prix neuf, prix affiché et valeur réaliste d'occasion."
        if web_search else
        "N'utilise aucune prétendue recherche de marché. Donne une fourchette prudente fondée sur l'identification visuelle, ou 0 si elle n'est pas raisonnablement estimable."
    )
    context: list[str] = []
    if notes:
        context.append(f"Informations du vendeur : {notes}")
    if etat:
        context.append(f"État déclaré : {etat}. Utilise cet état plutôt qu'une supposition visuelle.")
    if prix_min_user:
        context.append(f"Prix minimum souhaité : {prix_min_user} €. Le prix conseillé ne doit pas être inférieur sans avertissement explicite.")
    extra = "\n".join(context) if context else "Aucune information supplémentaire."
    return f"""Tu prépares en français un brouillon honnête d'annonce Leboncoin à partir d'UNE photo.

Règles impératives :
- Identifie uniquement ce qui est réellement visible. N'invente jamais marque, modèle, capacité, dimensions, compatibilité ou accessoires.
- Si le modèle exact est incertain, laisse modele vide et explique l'incertitude.
- Ne prétends jamais que le produit fonctionne, est authentique, complet ou sans défaut si le vendeur ne l'a pas affirmé.
- Titre naturel de 70 caractères maximum, sans emoji, téléphone, majuscules abusives ni mot trompeur.
- Description directement copiable, concise, structurée en petits paragraphes, sans téléphone ni adresse email.
- Propose catégorie et sous-catégorie probables, mais signale l'incertitude si nécessaire.
- L'état doit rester prudent : une photo seule ne confirme généralement pas le fonctionnement.
- {price_instruction}
- prix_conseille, prix_min et prix_max sont des nombres en euros sans symbole. Mets 0 si non estimable.
- Signale clairement un objet interdit, réglementé, dangereux ou potentiellement contrefait. Sinon avertissement est vide.
- Propose les photos supplémentaires les plus utiles : étiquette, défauts, accessoires, produit allumé, dimensions.
- Retourne strictement le JSON demandé.

{extra}"""


def extract_output_text(response: dict[str, Any]) -> str:
    output_text = response.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text.strip()
    texts: list[str] = []
    for item in response.get("output", []) or []:
        if not isinstance(item, dict):
            continue
        for content in item.get("content", []) or []:
            if isinstance(content, dict) and content.get("type") in {"output_text", "text"}:
                text = content.get("text")
                if isinstance(text, str):
                    texts.append(text)
    return "\n".join(texts).strip()


def normalize_result(data: dict[str, Any]) -> dict[str, Any]:
    for key in ["identification", "titre", "categorie", "sous_categorie", "marque", "modele", "etat", "description", "avertissement"]:
        data[key] = str(data.get(key, "") or "").strip()
    for key in ["prix_conseille", "prix_min", "prix_max"]:
        try:
            data[key] = max(0.0, float(data.get(key, 0) or 0))
        except (TypeError, ValueError):
            data[key] = 0.0
    try:
        data["confiance"] = max(0, min(100, int(data.get("confiance", 0) or 0)))
    except (TypeError, ValueError):
        data["confiance"] = 0
    for key in ["caracteristiques", "incertitudes", "conseils_photo"]:
        value = data.get(key, [])
        data[key] = [str(x).strip() for x in value if str(x).strip()] if isinstance(value, list) else []
    if not data["titre"]:
        data["titre"] = data["identification"] or "Produit à identifier"
    data["titre"] = data["titre"][:70]
    return data


def parse_json_text(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("La réponse de l’IA ne contient pas de JSON exploitable.")
        data = json.loads(text[start:end + 1])
    if not isinstance(data, dict):
        raise ValueError("Format de réponse inattendu.")
    return normalize_result(data)


def openai_request(image_data_url: str, prompt: str, web_search: bool) -> dict[str, Any]:
    match = re.match(r"^data:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$", image_data_url)
    if not match:
        raise ValueError("Format d’image non pris en charge.")
    try:
        raw_image = base64.b64decode(match.group(2), validate=True)
    except Exception as exc:
        raise ValueError("Image encodée incorrectement.") from exc
    if len(raw_image) > MAX_IMAGE_BYTES:
        raise ValueError("Image trop volumineuse après compression.")
    payload: dict[str, Any] = {
        "model": OPENAI_MODEL,
        "store": False,
        "input": [{"role": "user", "content": [
            {"type": "input_text", "text": prompt},
            {"type": "input_image", "image_url": image_data_url, "detail": "high"},
        ]}],
        "text": {"format": {
            "type": "json_schema", "name": "annonce_leboncoin",
            "description": "Brouillon structuré d'une annonce à contrôler par le vendeur.",
            "schema": SCHEMA, "strict": True,
        }},
        "max_output_tokens": 2000,
    }
    if web_search:
        payload["tools"] = [{"type": "web_search"}]
    request = urllib.request.Request(
        OPENAI_RESPONSES_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=150) as response:
            api_response = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(body).get("error", {}).get("message", body)
        except json.JSONDecodeError:
            detail = body
        if exc.code == 401:
            raise ValueError("Clé API OpenAI incorrecte ou inactive.") from exc
        if exc.code == 429:
            raise ValueError("Crédit ou limite API atteint. Vérifie la facturation du projet OpenAI.") from exc
        raise ValueError(f"Erreur OpenAI ({exc.code}) : {detail[:450]}") from exc
    except urllib.error.URLError as exc:
        raise ValueError("Connexion impossible à l’API OpenAI.") from exc
    except TimeoutError as exc:
        raise ValueError("L’analyse a dépassé le délai autorisé.") from exc
    if api_response.get("status") == "incomplete":
        reason = ((api_response.get("incomplete_details") or {}).get("reason") or "raison inconnue")
        raise ValueError(f"Réponse incomplète de l’IA : {reason}.")
    text = extract_output_text(api_response)
    if not text:
        raise ValueError("L’IA n’a pas renvoyé de résultat exploitable.")
    return parse_json_text(text)


def append_history(result: dict[str, Any]) -> None:
    exists = HISTORY_FILE.exists()
    with HISTORY_FILE.open("a", newline="", encoding="utf-8-sig") as file:
        writer = csv.writer(file, delimiter=";")
        if not exists:
            writer.writerow(["Date", "Titre", "Catégorie", "Sous-catégorie", "État", "Prix conseillé", "Prix min", "Prix max", "Confiance", "Description", "Incertitudes"])
        writer.writerow([
            datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S"),
            result.get("titre", ""), result.get("categorie", ""), result.get("sous_categorie", ""), result.get("etat", ""),
            result.get("prix_conseille", 0), result.get("prix_min", 0), result.get("prix_max", 0), result.get("confiance", 0),
            result.get("description", ""), " | ".join(result.get("incertitudes", [])),
        ])


class Handler(BaseHTTPRequestHandler):
    server_version = "LeboncoinPhotoAIWeb/2.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    @property
    def ip(self) -> str:
        return client_ip(self.headers, self.client_address)

    def secure_request(self) -> bool:
        return self.headers.get("X-Forwarded-Proto", "").lower() == "https" or os.environ.get("FORCE_SECURE_COOKIE") == "1"

    def authenticated(self) -> bool:
        token = cookie_value(self.headers.get("Cookie", ""), COOKIE_NAME)
        return bool(token and verify_session(token))

    def common_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")

    def send_bytes(self, status: int, content: bytes, content_type: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.common_headers()
        if extra:
            for key, value in extra.items():
                self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def send_json(self, status: int, data: dict[str, Any], extra: dict[str, str] | None = None) -> None:
        self.send_bytes(status, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", extra)

    def redirect(self, location: str) -> None:
        self.send_bytes(HTTPStatus.SEE_OTHER, b"", "text/plain", {"Location": location})

    def read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Taille de requête invalide.") from exc
        if length <= 0 or length > MAX_JSON_BODY:
            raise ValueError("Requête vide ou trop volumineuse.")
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Requête JSON invalide.") from exc
        if not isinstance(data, dict):
            raise ValueError("Objet JSON attendu.")
        return data

    def require_auth(self) -> bool:
        if self.authenticated():
            return True
        self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Connexion requise."})
        return False

    def do_GET(self) -> None:
        path = urllib.parse.urlsplit(self.path).path
        if path == "/healthz":
            self.send_json(HTTPStatus.OK, {"ok": True})
        elif path == "/login":
            if self.authenticated():
                self.redirect("/")
            else:
                self.send_bytes(HTTPStatus.OK, LOGIN_HTML.encode("utf-8"), "text/html; charset=utf-8")
        elif path == "/":
            if not self.authenticated():
                self.redirect("/login")
            else:
                self.send_bytes(HTTPStatus.OK, APP_HTML.encode("utf-8"), "text/html; charset=utf-8")
        elif path == "/api/status":
            if self.require_auth():
                self.send_json(HTTPStatus.OK, {"api_configured": bool(OPENAI_API_KEY), "model": OPENAI_MODEL, "username": APP_USERNAME})
        elif path == "/manifest.webmanifest":
            self.send_bytes(HTTPStatus.OK, json.dumps(MANIFEST, ensure_ascii=False).encode("utf-8"), "application/manifest+json")
        elif path == "/service-worker.js":
            self.send_bytes(HTTPStatus.OK, SERVICE_WORKER.encode("utf-8"), "application/javascript; charset=utf-8", {"Service-Worker-Allowed": "/"})
        elif path in {"/icon-192.png", "/icon-512.png"}:
            file = APP_DIR / path.lstrip("/")
            if file.exists():
                self.send_bytes(HTTPStatus.OK, file.read_bytes(), "image/png")
            else:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "Icône absente."})
        elif path == "/historique.csv":
            if not self.authenticated():
                self.redirect("/login")
            elif HISTORY_FILE.exists():
                self.send_bytes(HTTPStatus.OK, HISTORY_FILE.read_bytes(), "text/csv; charset=utf-8", {"Content-Disposition": 'attachment; filename="historique_annonces.csv"'})
            else:
                empty = "Date;Titre;Catégorie;Prix conseillé\r\n".encode("utf-8-sig")
                self.send_bytes(HTTPStatus.OK, empty, "text/csv; charset=utf-8", {"Content-Disposition": 'attachment; filename="historique_annonces.csv"'})
        elif path == "/favicon.ico":
            file = APP_DIR / "icon-192.png"
            self.send_bytes(HTTPStatus.OK, file.read_bytes() if file.exists() else b"", "image/png")
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Page introuvable."})

    def do_POST(self) -> None:
        path = urllib.parse.urlsplit(self.path).path
        try:
            if path == "/api/login":
                if not rate_allowed(f"login:{self.ip}", 8, 300):
                    self.send_json(HTTPStatus.TOO_MANY_REQUESTS, {"error": "Trop d’essais. Réessaie plus tard."})
                    return
                data = self.read_json()
                if not APP_PASSWORD:
                    raise ValueError("APP_PASSWORD n’est pas configuré sur le serveur.")
                username = str(data.get("username", ""))
                password = str(data.get("password", ""))
                valid_user = hmac.compare_digest(username.encode(), APP_USERNAME.encode())
                valid_pass = hmac.compare_digest(password.encode(), APP_PASSWORD.encode())
                if not (valid_user and valid_pass):
                    self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Identifiant ou mot de passe incorrect."})
                    return
                cookie = f"{COOKIE_NAME}={make_session(APP_USERNAME)}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_SECONDS}"
                if self.secure_request():
                    cookie += "; Secure"
                self.send_json(HTTPStatus.OK, {"ok": True}, {"Set-Cookie": cookie})
                return
            if path == "/api/logout":
                self.send_json(HTTPStatus.OK, {"ok": True}, {"Set-Cookie": f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"})
                return
            if not self.require_auth():
                return
            if path == "/api/analyze":
                if not rate_allowed(f"analyze:{self.ip}", 20, 3600):
                    self.send_json(HTTPStatus.TOO_MANY_REQUESTS, {"error": "Limite de 20 analyses par heure atteinte."})
                    return
                if not OPENAI_API_KEY:
                    raise ValueError("OPENAI_API_KEY n’est pas configurée sur le serveur.")
                data = self.read_json()
                image = str(data.get("image_data_url", ""))
                notes = str(data.get("notes", "")).strip()[:2000]
                etat = str(data.get("etat", "")).strip()[:80]
                prix_min_user = str(data.get("prix_min_utilisateur", "")).strip()[:30]
                web_search = bool(data.get("web_search", False))
                result = openai_request(image, prompt_for(notes, etat, prix_min_user, web_search), web_search)
                append_history(result)
                self.send_json(HTTPStatus.OK, result)
                return
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Action inconnue."})
        except ValueError as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except Exception as exc:
            print("Erreur interne :", repr(exc), file=sys.stderr)
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Erreur interne inattendue."})


def main() -> None:
    print("=" * 66)
    print(" LEBONCOIN PHOTO AI — SITE WEB PRIVÉ")
    print("=" * 66)
    print(f"Adresse locale : http://127.0.0.1:{PORT}")
    print(f"Modèle : {OPENAI_MODEL}")
    if not APP_PASSWORD:
        print("ATTENTION : APP_PASSWORD n’est pas défini, aucune connexion ne sera possible.")
    if not OPENAI_API_KEY:
        print("ATTENTION : OPENAI_API_KEY n’est pas définie, l’analyse sera indisponible.")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nArrêt.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
