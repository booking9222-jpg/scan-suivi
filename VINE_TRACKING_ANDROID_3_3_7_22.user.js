// ==UserScript==
// @name         VINE Tracking Android -> Google Sheets
// @namespace    vine-tracking-android
// @version      3.3.7.22
// @description  Amazon Vine Orders -> détails -> suivi -> Google Sheets, mode conservateur faible trafic.
// @author       OpenAI
// Exécution limitée à /vine/orders et aux pages Amazon nécessaires au suivi. Aucune injection sur le catalogue Vine, les fiches produit ou les avis.
// @match        https://www.amazon.fr/vine/orders*
// @match        https://www.amazon.fr/gp/your-account/order-history*
// @match        https://www.amazon.fr/gp/css/order-history*
// @match        https://www.amazon.fr/gp/your-account/order-details*
// @match        https://www.amazon.fr/gp/css/order-details*
// @match        https://www.amazon.fr/gp/css/summary*
// @match        https://www.amazon.fr/your-orders*
// @match        https://www.amazon.fr/progress-tracker/package*
// @match        https://www.amazon.fr/ship-track*
// @match        https://www.amazon.fr/track-package*
// @match        https://www.amazon.fr/package-tracking*
// @match        https://www.amazon.fr/tracking/package*
// @match        https://www.amazon.fr/gp/*ship-track*
// @match        https://track.amazon.fr/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      workers.dev
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '3.3.7';
  const BUILD_VERSION = '3.3.7.22';
  const VINE_ORDERS_URL = 'https://www.amazon.fr/vine/orders';
  const LEGACY_ORDERS_URL = 'https://www.amazon.fr/gp/your-account/order-history';
  const canonicalOrderDetailUrl = orderId => `https://www.amazon.fr/gp/your-account/order-details?ie=UTF8&orderID=${encodeURIComponent(orderId || '')}`;
  const STATE_KEY = 'VT_SCAN_STATE_V33720';
  const CONFIG_KEY = 'VT_CONFIG_V1';
  const CONFIG_POLICY_REV = 'V33722_MICRO_BATCH_1';
  const CACHE_PREFIX = 'VT_ORDER_CACHE_V33720_';
  const LEGACY_CACHE_PREFIXES = ['VT_ORDER_CACHE_V331_','VT_ORDER_CACHE_V332_','VT_ORDER_CACHE_V333_','VT_ORDER_CACHE_V334_','VT_ORDER_CACHE_V335_','VT_ORDER_CACHE_V336_','VT_ORDER_CACHE_V337_','VT_ORDER_CACHE_V3372_','VT_ORDER_CACHE_V3373_','VT_ORDER_CACHE_V3374_','VT_ORDER_CACHE_V3375_','VT_ORDER_CACHE_V3376_','VT_ORDER_CACHE_V3377_','VT_ORDER_CACHE_V3378_','VT_ORDER_CACHE_V3379_','VT_ORDER_CACHE_V33710_','VT_ORDER_CACHE_V33711_','VT_ORDER_CACHE_V33712_','VT_ORDER_CACHE_V33713_','VT_ORDER_CACHE_V33714_','VT_ORDER_CACHE_V33715_','VT_ORDER_CACHE_V33716_','VT_ORDER_CACHE_V33717_','VT_ORDER_CACHE_V33718_','VT_ORDER_CACHE_V33719_'];
  const PANEL_ID = 'vt-android-panel';
  const LOCK_PREFIX = 'VT_TAB_LOCK_V33720_';
  const TAB_ID_KEY = 'VT_TAB_ID_V33720';
  // Clé de programmation conservée de V3.3.7.11 pour ne pas perdre les programmations existantes lors de la mise à jour.
  const SCHEDULE_KEY_PREFIX = 'VT_SCAN_SCHEDULE_V33711_';
  const SCHEDULE_ATTEMPT_INTERVAL_MS = 5 * 60 * 1000;
  const SCAN_HISTORY_KEY_PREFIX = 'VT_SCAN_HISTORY_V1_';
  const SCAN_HISTORY_LIMIT = 5;
  const TRANSPORT_STATE_KEY_PREFIX = 'VT_API_TRANSPORT_V33720_';
  // V3.3.7.17 — présence réelle d'onglet. Un ancien verrou ne bloque plus 5 minutes
  // après fermeture/crash : chaque onglet publie un heartbeat local Tampermonkey.
  const HEARTBEAT_PREFIX = 'VT_TAB_HEARTBEAT_V33720_';
  const TAB_HEARTBEAT_INTERVAL_MS = 5000;
  const TAB_HEARTBEAT_STALE_MS = 75000;
  // V3.3.7.19 — Smart Cache : IndexedDB local indexé OrderID / TrackingID / ASIN.
  // Google Sheets reste la vérité centrale ; IndexedDB évite de rouvrir Amazon
  // quand une commande/colis/article a déjà été vérifié récemment.
  const SMART_DB_NAME = 'VINE_TRACKING_SMART_CACHE_V1';
  const SMART_DB_VERSION = 1;
  const SMART_FORCE_PREFIX = 'VT_SMART_FORCE_FULL_V1_';
  let smartDbPromise = null;
  let tabHeartbeatTimer = null;
  let schedulerTimer = null;
  let schedulerCheckBusy = false;
  let scanWatchdogTimer = null;
  let resumeInProgress = false;
  let navigationHandoffUntil = 0;
  let robustWakeLock = null;
  let robustWakeLockReason = '';
  let fleetHeartbeatTimer = null;
  let fleetLastSentAt = 0;
  let smartMaintenanceRunning = false;
  let googleFlushInFlight = false;
  let googleRetryTimer = null;
  const TAB_ID = (() => {
    try {
      let id = sessionStorage.getItem(TAB_ID_KEY);
      if (!id) { id = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`; sessionStorage.setItem(TAB_ID_KEY, id); }
      return id;
    } catch (_) { return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`; }
  })();

  const DEFAULT_CONFIG = {
    account: '',
    webAppUrl: '',
    apiSecret: '',
    // Relais Cloudflare facultatif. En mode AUTO il n'est utilisé que si la
    // connexion directe vers Apps Script échoue au niveau réseau/transport.
    relayUrl: '',
    relayToken: '',
    relayPreferMinutes: 30,
    // Mode conservateur : ces délais servent uniquement à limiter la fréquence des
    // navigations et à laisser Amazon finir son rendu. Ils ne cherchent pas à imiter
    // un comportement humain ni à contourner un contrôle du site.
    delayMinMs: 5000,
    delayMaxMs: 8500,
    maxHistoryPages7: 8,
    maxHistoryPages30: 24,
    maxHistoryPagesSearch: 8,
    maxVinePages7: 8,
    maxVinePages30: 16,
    maxVineScrollProbes: 6,
    vineStableMaxMs: 10000,
    maxHistoryExpandClicks: 6,
    maxDeliverySearchExpandClicks: 2,
    deliverySearchLookbackDays: 45,
    waitReadyMs: 10000,
    historyStablePollMs: 550,
    historyStableRounds: 4,
    historyStableMaxMs: 16000,
    maxHistoryScrollProbes: 8,
    pageStablePollMs: 500,
    pageStableRounds: 4,
    pageStableMinMs: 2200,
    pageStableMaxMs: 12000,
    priorityTrackingStableMinMs: 4000,
    priorityTrackingMaxMs: 9000,
    priorityTrackingPollMs: 400,
    trackingStableMinMs: 5200,
    trackingMaxMs: 12000,
    trackingPollMs: 450,
    incompleteRecheckMs: 2 * 60 * 60 * 1000,
    completeOpenRecheckMs: 8 * 60 * 60 * 1000,
    scanCooldownMs: 20 * 60 * 1000,
    // Une programmation est ponctuelle. Si Android suspend brièvement l'onglet,
    // elle peut encore démarrer dans cette fenêtre ; au-delà elle est marquée manquée.
    scheduleGraceMs: 30 * 60 * 1000,
    // Téléphones dédiés Vine : plus gros buffers locaux = moins d'appels Google, sans accélérer les requêtes Amazon.
    dedicatedDeviceMode: true,
    detailsBatchSize: 12,
    bufferShipmentLimit: 8,
    bufferItemLimit: 24,
    apiRetries: 2,
    pageRetries: 1,
    noTrackingFinalAfterDays: 14,
    // Anti-blocage V3.3.7.17 : borne les étapes longues et évite les faux "lecture suivi".
    trackingWatchdogMs: 45 * 1000,
    googleWatchdogMs: 90 * 1000,
    watchdogPollMs: 10 * 1000,
    watchdogMaxRecoveries: 2,
    priorityFlushShipmentLimit: 8,
    priorityFlushItemLimit: 16,
    priorityFlushMaxAgeMs: 120 * 1000,
    // Extension de période : un scan 30 j lancé peu après un 15 j réutilise la zone déjà vérifiée et parcourt quand même les jours 16→30.
    rangeExtensionReuseMs: 6 * 60 * 60 * 1000,
    // Mode nuit robuste : conçu pour les téléphones dédiés, branchés, avec l'onglet Vine ouvert.
    nightRobustScheduleDefault: true,
    nightRobustGraceMs: 4 * 60 * 60 * 1000,
    nightRobustOfflineRetryMs: 60 * 1000,
    nightRobustWakeLock: true,
    // Lecture DOM d'abord : si les balises utiles sont déjà présentes et stables,
    // on n'attend pas le timeout sémantique complet. Fallback inchangé si Amazon
    // injecte encore du contenu dynamiquement.
    domFastPollMs: 300,
    domFastStableRounds: 3,
    domFastMaxMs: 3200,
    domFastNonAuthoritativeMinMs: 2200,
    // Smart Cache : les états finaux ne sont pas rouverts en routine ; un suivi
    // vérifié mais non livré est rafraîchi à intervalle large ; une commande sans
    // suivi est revue plus souvent car son tracking peut apparaître plus tard.
    smartCacheEnabled: true,
    smartTrackingRefreshMs: 12 * 60 * 60 * 1000,
    smartPendingRefreshMs: 4 * 60 * 60 * 1000,
    smartDirectTracking: true,
    smartCacheMaxOrders: 4000,
    // V3.3.7.20 — queue prioritaire, reprise transactionnelle, quarantaine et supervision flotte.
    queuePriorityEnabled: true,
    quarantineEnabled: true,
    quarantineMaxAttempts: 2,
    quarantineRetryAtEnd: true,
    mutationObserverEnabled: true,
    fleetHeartbeatActiveMs: 2 * 60 * 1000,
    fleetHeartbeatIdleMs: 10 * 60 * 1000,
    smartDbMaintenanceMs: 24 * 60 * 60 * 1000,
    smartDbMaxAgeDays: 180,
    smartDbPruneBatch: 500,
    debug: false,
  };

  const MONTHS = {
    janvier: 0, janv: 0,
    fevrier: 1, 'février': 1, fevr: 1, 'févr': 1,
    mars: 2,
    avril: 3, avr: 3,
    mai: 4,
    juin: 5,
    juillet: 6, juil: 6,
    aout: 7, 'août': 7,
    septembre: 8, sept: 8,
    octobre: 9, oct: 9,
    novembre: 10, nov: 10,
    decembre: 11, 'décembre': 11, dec: 11, 'déc': 11,
  };

  const WEEKDAYS = {
    dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6,
  };

  const TRACKING_REJECT_WORDS = new Set([
    'INDISPONIBLE','INCONNU','INCONNUE','CONSULTEZ','CONSULTER','SUIVI','TRACKING','PACKAGE','COLIS','LIVRAISON',
    'EXPEDIE','EXPEDIEE','EXPEDITION','COMMANDE','ORDER','AMAZON','DETAILS','DETAIL','NUMERO','NUMBER','AUCUN','NONE',
    'PROCHAINEMENT','BIENTOT','PENDING','ATTENTE','STATUS','STATUT','TRANSPORTEUR','CARRIER'
  ]);

  const CARRIERS = [
    ['Amazon Logistics', /amazon\s*(logistics|shipping)|expédi[ée]\s+(?:par|avec)\s+amazon|livr[ée]\s+(?:par|avec)\s+amazon/i],
    ['Colissimo', /colissimo/i],
    ['La Poste', /la\s*poste/i],
    ['Chronopost', /chronopost/i],
    ['UPS', /\bups\b/i],
    ['DHL', /\bdhl\b/i],
    ['DPD', /\bdpd\b/i],
    ['GLS', /\bgls\b/i],
    ['Colis Privé', /colis\s*priv[ée]/i],
    ['Mondial Relay', /mondial\s*relay/i],
    ['Relais Colis', /relais\s*colis/i],
    ['FedEx', /fedex/i],
    ['Cainiao', /cainiao/i],
  ];

  function log(...args) {
    if (getConfig().debug) console.log('[VINE Tracking]', ...args);
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // V3.3.7.20 — MutationObserver : réveille les attentes dès que le DOM change,
  // avec timeout borné en secours. Aucune requête Amazon supplémentaire n'est créée.
  function waitForDomMutationOrTimeout(timeoutMs = 300) {
    const ms = Math.max(25, Number(timeoutMs || 300));
    if (getConfig().mutationObserverEnabled === false || typeof MutationObserver === 'undefined' || !document.documentElement) return sleep(ms);
    return new Promise(resolve => {
      let done=false, timer=null, obs=null;
      const finish=(reason)=>{ if(done)return; done=true; try{obs?.disconnect();}catch(_){} if(timer)clearTimeout(timer); resolve(reason); };
      try {
        obs=new MutationObserver(()=>finish('mutation'));
        obs.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true});
      } catch(_) { return resolve('observer-unavailable'); }
      timer=setTimeout(()=>finish('timeout'),ms);
    });
  }

  function randomDelay() {
    const c = getConfig();
    return Math.round(c.delayMinMs + Math.random() * Math.max(0, c.delayMaxMs - c.delayMinMs));
  }
  function nowIso() { return new Date().toISOString(); }
  function isoDate(d) {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function normalizeText(s) { return String(s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); }
  function normalizeKey(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function foldText(s) {
    return normalizeText(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’`´]/g, "'");
  }
  function localNoon(offsetDays = 0) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + Number(offsetDays || 0));
    return d;
  }
  function makeLocalDate(year, monthIndex, day) {
    const y = Number(year), m = Number(monthIndex), d = Number(day);
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
    const out = new Date(y, m, d, 12, 0, 0, 0);
    if (out.getFullYear() !== y || out.getMonth() !== m || out.getDate() !== d) return null;
    return out;
  }

  function dateForWeekday(name, mode = 'future') {
    const wd = WEEKDAYS[foldText(name)];
    if (wd == null) return null;
    const now = localNoon(0);
    const deltaFuture = (wd - now.getDay() + 7) % 7;
    const deltaPast = -((now.getDay() - wd + 7) % 7);
    if (mode === 'past') return localNoon(deltaPast);
    if (mode === 'future') return localNoon(deltaFuture);
    const a = localNoon(deltaPast), b = localNoon(deltaFuture);
    return Math.abs(a - now) <= Math.abs(b - now) ? a : b;
  }

  function searchTargetDate(query) {
    const q = foldText(query).trim();
    if (!q) return '';
    if (/^(?:aujourd'hui|aujourdhui|today)$/.test(q)) return isoDate(localNoon(0));
    if (/^(?:demain|tomorrow)$/.test(q)) return isoDate(localNoon(1));
    if (/^(?:hier|yesterday)$/.test(q)) return isoDate(localNoon(-1));
    if (Object.prototype.hasOwnProperty.call(WEEKDAYS, q)) return isoDate(dateForWeekday(q, 'future'));

    let m = q.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return isoDate(makeLocalDate(Number(m[1]), Number(m[2]) - 1, Number(m[3])));

    m = q.match(/^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2}|\d{4}))?$/);
    if (m) {
      let year = m[3] ? Number(m[3]) : new Date().getFullYear();
      if (year < 100) year += 2000;
      const month = Number(m[2]) - 1, day = Number(m[1]);
      if (m[3]) return isoDate(makeLocalDate(year, month, day));
      const now = localNoon(0);
      const candidates = [-1, 0, 1].map(delta => makeLocalDate(now.getFullYear() + delta, month, day)).filter(Boolean);
      if (!candidates.length) return '';
      return isoDate(candidates.sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0]);
    }

    const parsed = parseDateFromText(query, 'auto');
    return parsed ? isoDate(parsed) : '';
  }

  function isCarrierAttributionDeliveryPhrase(text) {
    const f = foldText(text);
    // « livré par Amazon / La Poste » ou « livré avec Amazon Logistics » peut
    // seulement décrire le transporteur. Sans autre preuve de remise, on reste
    // conservateur et on ne considère pas le colis comme livré.
    return /\blivre(?:e)?\s+(?:par|avec)\b/.test(f);
  }

  function hasDeliveredMarker(line) {
    const raw = normalizeText(line);
    const f = foldText(raw);
    if (!raw) return false;
    if (/livraison\s+prevue|sera\s+livre|devrait\s+etre\s+livre/.test(f)) return false;
    if (isCarrierAttributionDeliveryPhrase(raw)) return false;
    if (/(?:votre\s+(?:colis|commande)|le\s+colis).{0,90}(?:a\s+ete|est)\s+livre(?:e)?(?:\s|$|[.,;:!])/i.test(f)) return true;
    if (/remis(?:e)?\s+(?:a|à|au)\s+(?:(?:la\s+)?(?:reception|réception)|concierge|destinataire)/i.test(raw)) return true;
    if (!/^(?:livré(?:e)?|livree)(?:\s|:|\-|$)/i.test(raw)) return false;
    let rest = raw.replace(/^(?:livré(?:e)?|livree)\s*/i, '').trim().replace(/^[:\-]\s*/, '');
    if (!rest || /^(?:par|avec)\b/i.test(rest)) return false;
    // Exemples sûrs : « Livré aujourd'hui », « Livré hier », « Livré : 16 septembre ».
    if (/^(?:aujourd['’]?hui|aujourdhui|hier|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/i.test(foldText(rest))) return true;
    if (parseDateFromText(rest, 'past')) return true;
    return false;
  }

  function deliveryRelevantLines(text) {
    // Lignes strictement liées à la livraison/réception. Une date d'expédition
    // ne doit jamais faire correspondre une recherche de livraison. Amazon peut
    // couper « Livraison prévue » et sa date sur deux lignes.
    const lines = normalizeText(text).split('\n').map(x => x.trim()).filter(Boolean);
    const isDeliveryContext = line => {
      const raw = normalizeText(line);
      const f = foldText(raw);
      if (/livraison\s+(?:prevue|programmee)|arriv(?:e|ee|era)|sera\s+livre|devrait\s+etre\s+livre/.test(f)) return true;
      // Autorise l'étape nue uniquement comme CONTEXTE pour joindre la date de
      // la ligne suivante. hasDeliveredMarker('Livré') reste false.
      if (/^(?:livré(?:e)?|livree)$/i.test(raw)) return true;
      return hasDeliveredMarker(raw);
    };
    const hasDateToken = line => {
      const f = foldText(line);
      if (/\b(?:aujourd'hui|aujourdhui|demain|hier|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/.test(f)) return true;
      return !!parseDateFromText(line, 'auto');
    };
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!isDeliveryContext(line)) continue;
      let combined = line;
      if (!hasDateToken(line) && i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.length <= 100 && hasDateToken(next) && !/exp[ée]di|command[ée]|suivi|tracking/i.test(next)) combined = `${line} ${next}`;
      }
      out.push(combined);
    }
    return out;
  }

  function datesMentionedInDeliveryText(text) {
    const out = new Set();
    const addRange = (a, b) => {
      if (!(a instanceof Date) || !(b instanceof Date) || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return;
      let cur = new Date(Math.min(a.getTime(), b.getTime()));
      const end = Math.max(a.getTime(), b.getTime());
      let guard = 0;
      while (cur.getTime() <= end && guard++ < 32) { out.add(isoDate(cur)); cur.setDate(cur.getDate() + 1); }
    };
    for (const line of deliveryRelevantLines(text)) {
      const range = extractExpectedDeliveryRange(line);
      if (range.start && range.end) addRange(new Date(`${range.start}T12:00:00`), new Date(`${range.end}T12:00:00`));
      const f = foldText(line);
      const isPast = (hasDeliveredMarker(line) || /\bre[cç]ue\b/.test(f)) && !/livraison prevue|arriv/.test(f);
      const mode = isPast ? 'past' : 'future';
      if (/aujourd'hui|aujourdhui|today/.test(f)) out.add(isoDate(localNoon(0)));
      if (/\bdemain\b|\btomorrow\b/.test(f)) out.add(isoDate(localNoon(1)));
      if (/\bhier\b|\byesterday\b/.test(f)) out.add(isoDate(localNoon(-1)));
      for (const name of Object.keys(WEEKDAYS)) if (new RegExp(`\\b${name}\\b`, 'i').test(f)) { const d = dateForWeekday(name, mode); if (d) out.add(isoDate(d)); }
      const d = parseDateFromText(line, mode); if (d) out.add(isoDate(d));
    }
    return out;
  }

  function matchesDeliveryQuery(text, query) {
    const q = foldText(query).trim();
    if (!q) return false;
    const lines = deliveryRelevantLines(text);
    if (!lines.length) return false;
    const relevant = foldText(lines.join('\n'));
    if (relevant.includes(q)) return true;
    const target = searchTargetDate(query);
    return !!target && datesMentionedInDeliveryText(lines.join('\n')).has(target);
  }

  function absoluteUrl(href) {
    try { return new URL(href, location.origin).href; } catch (_) { return ''; }
  }
  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < String(str).length; i++) {
      h ^= String(str).charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }
  function uniqBy(arr, keyFn) {
    const out = [], seen = new Set();
    for (const x of arr) {
      const k = keyFn(x);
      if (!k || seen.has(k)) continue;
      seen.add(k); out.push(x);
    }
    return out;
  }

  function migrateConservativeConfig(stored) {
    const src = (stored && typeof stored === 'object' && !Array.isArray(stored)) ? { ...stored } : {};
    if (src.__policyRev === CONFIG_POLICY_REV) return src;
    const positive = (v, fallback) => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback;
    // Migration one-shot des anciennes valeurs V3.3.7.x : les identifiants/secrets
    // restent intacts, seuls les paramètres générateurs de trafic sont resserrés.
    src.delayMinMs = Math.max(5000, positive(src.delayMinMs, 5000));
    src.delayMaxMs = Math.max(src.delayMinMs, 8500, positive(src.delayMaxMs, 8500));
    src.maxHistoryPages7 = Math.min(8, positive(src.maxHistoryPages7, 8));
    src.maxHistoryPages30 = Math.min(24, positive(src.maxHistoryPages30, 24));
    src.maxHistoryPagesSearch = Math.min(8, positive(src.maxHistoryPagesSearch, 8));
    src.maxVinePages7 = Math.min(8, positive(src.maxVinePages7, 8));
    src.maxVinePages30 = Math.min(16, positive(src.maxVinePages30, 16));
    src.maxVineScrollProbes = Math.min(6, positive(src.maxVineScrollProbes, 6));
    src.vineStableMaxMs = Math.min(12000, Math.max(6000, positive(src.vineStableMaxMs, 10000)));
    src.maxHistoryExpandClicks = Math.min(6, positive(src.maxHistoryExpandClicks, 6));
    src.maxDeliverySearchExpandClicks = Math.min(3, positive(src.maxDeliverySearchExpandClicks, 2));
    src.deliverySearchLookbackDays = Math.min(60, Math.max(14, positive(src.deliverySearchLookbackDays, 45)));
    src.maxHistoryScrollProbes = Math.min(8, positive(src.maxHistoryScrollProbes, 8));
    src.apiRetries = Math.min(2, Math.max(1, Number.isFinite(Number(src.apiRetries)) ? Number(src.apiRetries) : 2));
    src.pageRetries = Math.min(1, Math.max(0, Number.isFinite(Number(src.pageRetries)) ? Number(src.pageRetries) : 1));
    src.priorityTrackingStableMinMs = Math.max(4000, positive(src.priorityTrackingStableMinMs, 4000));
    src.priorityTrackingMaxMs = Math.max(src.priorityTrackingStableMinMs + 1800, 9000, positive(src.priorityTrackingMaxMs, 9000));
    src.priorityTrackingPollMs = Math.max(400, positive(src.priorityTrackingPollMs, 400));
    src.trackingStableMinMs = Math.max(5200, positive(src.trackingStableMinMs, 5200));
    src.trackingMaxMs = Math.max(src.trackingStableMinMs + 1800, 12000, positive(src.trackingMaxMs, 12000));
    src.trackingPollMs = Math.max(450, positive(src.trackingPollMs, 450));
    src.incompleteRecheckMs = Math.max(2 * 60 * 60 * 1000, positive(src.incompleteRecheckMs, 2 * 60 * 60 * 1000));
    src.completeOpenRecheckMs = Math.max(8 * 60 * 60 * 1000, positive(src.completeOpenRecheckMs, 8 * 60 * 60 * 1000));
    src.scanCooldownMs = Math.max(20 * 60 * 1000, positive(src.scanCooldownMs, 20 * 60 * 1000));
    src.scheduleGraceMs = Math.min(2 * 60 * 60 * 1000, Math.max(10 * 60 * 1000, positive(src.scheduleGraceMs, 30 * 60 * 1000)));
    src.rangeExtensionReuseMs = Math.min(24 * 60 * 60 * 1000, Math.max(60 * 60 * 1000, positive(src.rangeExtensionReuseMs, 6 * 60 * 60 * 1000)));
    src.nightRobustGraceMs = Math.min(8 * 60 * 60 * 1000, Math.max(60 * 60 * 1000, positive(src.nightRobustGraceMs, 4 * 60 * 60 * 1000)));
    src.nightRobustOfflineRetryMs = Math.min(10 * 60 * 1000, Math.max(15 * 1000, positive(src.nightRobustOfflineRetryMs, 60 * 1000)));
    src.nightRobustScheduleDefault = src.nightRobustScheduleDefault !== false;
    src.nightRobustWakeLock = src.nightRobustWakeLock !== false;
    src.dedicatedDeviceMode = src.dedicatedDeviceMode !== false;
    // V3.3.7.19 : les téléphones sont dédiés à Vine. Si la configuration provient
    // d'une ancienne version et utilise encore les anciens petits buffers, on les
    // augmente automatiquement. Cela réduit les synchronisations Google sans
    // accélérer ni paralléliser les pages Amazon.
    if (src.dedicatedDeviceMode) {
      if (!Number.isFinite(Number(src.detailsBatchSize)) || Number(src.detailsBatchSize) <= 8) src.detailsBatchSize = 12;
      if (!Number.isFinite(Number(src.priorityFlushShipmentLimit)) || Number(src.priorityFlushShipmentLimit) <= 4) src.priorityFlushShipmentLimit = 8;
      if (!Number.isFinite(Number(src.priorityFlushItemLimit)) || Number(src.priorityFlushItemLimit) <= 8) src.priorityFlushItemLimit = 16;
      if (!Number.isFinite(Number(src.priorityFlushMaxAgeMs)) || Number(src.priorityFlushMaxAgeMs) <= 60000) src.priorityFlushMaxAgeMs = 120000;
    }
    src.trackingWatchdogMs = Math.min(2 * 60 * 1000, Math.max(30 * 1000, positive(src.trackingWatchdogMs, 45 * 1000)));
    src.googleWatchdogMs = Math.min(3 * 60 * 1000, Math.max(45 * 1000, positive(src.googleWatchdogMs, 90 * 1000)));
    src.watchdogPollMs = Math.min(30 * 1000, Math.max(5000, positive(src.watchdogPollMs, 10 * 1000)));
    src.watchdogMaxRecoveries = Math.min(3, Math.max(1, Number.isFinite(Number(src.watchdogMaxRecoveries)) ? Number(src.watchdogMaxRecoveries) : 2));
    src.priorityFlushShipmentLimit = Math.min(16, Math.max(2, positive(src.priorityFlushShipmentLimit, src.dedicatedDeviceMode ? 8 : 4)));
    src.priorityFlushItemLimit = Math.min(32, Math.max(4, positive(src.priorityFlushItemLimit, src.dedicatedDeviceMode ? 16 : 8)));
    src.priorityFlushMaxAgeMs = Math.min(5 * 60 * 1000, Math.max(30 * 1000, positive(src.priorityFlushMaxAgeMs, src.dedicatedDeviceMode ? 120 * 1000 : 60 * 1000)));
    src.domFastPollMs = Math.min(1000, Math.max(150, positive(src.domFastPollMs, 300)));
    src.domFastStableRounds = Math.min(5, Math.max(2, positive(src.domFastStableRounds, 3)));
    src.domFastMaxMs = Math.min(6000, Math.max(2400, positive(src.domFastMaxMs, 3200)));
    src.domFastNonAuthoritativeMinMs = Math.min(4000, Math.max(1800, positive(src.domFastNonAuthoritativeMinMs, 2200)));
    src.detailsBatchSize = Math.min(16, Math.max(4, positive(src.detailsBatchSize, src.dedicatedDeviceMode ? 12 : 8)));
    src.bufferShipmentLimit = 8;
    src.bufferItemLimit = 24;
    src.smartCacheEnabled = src.smartCacheEnabled !== false;
    src.smartDirectTracking = src.smartDirectTracking !== false;
    src.smartTrackingRefreshMs = Math.min(48 * 60 * 60 * 1000, Math.max(4 * 60 * 60 * 1000, positive(src.smartTrackingRefreshMs, 12 * 60 * 60 * 1000)));
    src.smartPendingRefreshMs = Math.min(24 * 60 * 60 * 1000, Math.max(60 * 60 * 1000, positive(src.smartPendingRefreshMs, 4 * 60 * 60 * 1000)));
    // Migration V3.3.7.19 -> V3.3.7.20 : les téléphones dédiés à Vine
    // passent automatiquement de l'ancien plafond 2500 à 4000 entrées.
    if (src.dedicatedDeviceMode && (!Number.isFinite(Number(src.smartCacheMaxOrders)) || Number(src.smartCacheMaxOrders) <= 2500)) src.smartCacheMaxOrders = 4000;
    src.smartCacheMaxOrders = Math.min(10000, Math.max(500, positive(src.smartCacheMaxOrders, 4000)));
    src.queuePriorityEnabled = src.queuePriorityEnabled !== false;
    src.quarantineEnabled = src.quarantineEnabled !== false;
    src.quarantineRetryAtEnd = src.quarantineRetryAtEnd !== false;
    src.mutationObserverEnabled = src.mutationObserverEnabled !== false;
    src.quarantineMaxAttempts = Math.min(4, Math.max(1, positive(src.quarantineMaxAttempts, 2)));
    src.fleetHeartbeatActiveMs = Math.min(10*60*1000, Math.max(60*1000, positive(src.fleetHeartbeatActiveMs, 2*60*1000)));
    src.fleetHeartbeatIdleMs = Math.min(30*60*1000, Math.max(3*60*1000, positive(src.fleetHeartbeatIdleMs, 10*60*1000)));
    src.smartDbMaintenanceMs = Math.min(7*24*60*60*1000, Math.max(6*60*60*1000, positive(src.smartDbMaintenanceMs, 24*60*60*1000)));
    src.smartDbMaxAgeDays = Math.min(730, Math.max(30, positive(src.smartDbMaxAgeDays, 180)));
    src.smartDbPruneBatch = Math.min(2000, Math.max(100, positive(src.smartDbPruneBatch, 500)));
    src.__policyRev = CONFIG_POLICY_REV;
    try { GM_setValue(CONFIG_KEY, src); } catch (_) {}
    return src;
  }
  function getConfig() {
    const stored = migrateConservativeConfig(GM_getValue(CONFIG_KEY, {}) || {});
    return { ...DEFAULT_CONFIG, ...stored };
  }
  function saveConfig(c) { GM_setValue(CONFIG_KEY, { ...DEFAULT_CONFIG, ...c, __policyRev: CONFIG_POLICY_REV }); }
  function normalizedWebAppEndpoint(url) {
    try { const u = new URL(String(url || '').trim()); return `${u.protocol}//${u.hostname}${u.pathname.replace(/\/+$/, '')}`; }
    catch (_) { return String(url || '').trim().replace(/\/+$/, ''); }
  }
  function validAccountName(value) { return /^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(String(value || '').trim().toUpperCase()); }
  function lockKey(account) { return LOCK_PREFIX + String(account || 'UNKNOWN').toUpperCase(); }
  function heartbeatKey(tabId) { return HEARTBEAT_PREFIX + String(tabId || 'UNKNOWN'); }
  function readTabHeartbeat(tabId) { return tabId ? GM_getValue(heartbeatKey(tabId), null) : null; }
  function heartbeatIsLive(hb, account = '') {
    if (!hb || typeof hb !== 'object') return false;
    const age = Date.now() - Number(hb.ts || 0);
    if (!(age >= 0 && age < TAB_HEARTBEAT_STALE_MS)) return false;
    if (account && String(hb.account || '').toUpperCase() !== String(account || '').toUpperCase()) return false;
    return hb.active === true;
  }
  function writeTabHeartbeat() {
    try {
      const state = getState();
      const account = scanAccount(state) || String(getConfig().account || '').trim().toUpperCase();
      GM_setValue(heartbeatKey(TAB_ID), {
        tabId:TAB_ID, account, scanId:String(state?.scanId || ''), active:state?.active === true,
        paused:state?.paused === true, visible:!document.hidden, ts:Date.now(), url:location.href
      });
    } catch (_) {}
  }
  function startTabHeartbeat() {
    if (tabHeartbeatTimer) return;
    writeTabHeartbeat();
    tabHeartbeatTimer = setInterval(writeTabHeartbeat, TAB_HEARTBEAT_INTERVAL_MS);
    try { document.addEventListener('visibilitychange', writeTabHeartbeat); } catch (_) {}
    try { window.addEventListener('focus', writeTabHeartbeat); } catch (_) {}
    try { window.addEventListener('pageshow', writeTabHeartbeat); } catch (_) {}
    try { window.addEventListener('pagehide', handlePageExit); } catch (_) {}
    try { window.addEventListener('beforeunload', handlePageExit); } catch (_) {}
  }
  function markTabHeartbeatInactive(reason = 'pagehide') {
    try {
      const state=getState();
      const account=scanAccount(state) || String(getConfig().account || '').trim().toUpperCase();
      GM_setValue(heartbeatKey(TAB_ID), { tabId:TAB_ID, account, scanId:String(state?.scanId||''), active:false, paused:state?.paused===true, visible:false, ts:Date.now(), reason, url:location.href });
      const cur=readTabLock(account);
      if (cur?.tabId===TAB_ID) GM_deleteValue(lockKey(account));
    } catch (_) {}
  }
  function prepareNavigationHandoff() {
    navigationHandoffUntil = Date.now() + 20000;
    writeTabHeartbeat();
  }
  function navigateTo(url) {
    prepareNavigationHandoff();
    location.href = url;
  }
  function handlePageExit() {
    if (Date.now() < navigationHandoffUntil) { writeTabHeartbeat(); return; }
    markTabHeartbeatInactive('page-exit');
  }
  async function requestRobustWakeLock(reason = 'robust-night') {
    try {
      const c=getConfig();
      if (!c.nightRobustWakeLock || typeof navigator==='undefined' || !navigator.wakeLock || document.hidden) return false;
      if (robustWakeLock && robustWakeLock.released !== true) return true;
      robustWakeLockReason=reason;
      const lock=await navigator.wakeLock.request('screen');
      robustWakeLock=lock;
      lock.addEventListener?.('release',()=>{ if(robustWakeLock===lock) robustWakeLock=null; });
      return true;
    } catch (_) { robustWakeLock=null; return false; }
  }
  async function releaseRobustWakeLockIfIdle() {
    try {
      const schedule=getScheduledScan(); const state=getState();
      const needed=(schedule?.enabled && schedule.robustNight===true) || (state?.active && state.robustNight===true);
      if (needed) return false;
      if (robustWakeLock && robustWakeLock.released !== true) await robustWakeLock.release();
    } catch (_) {}
    robustWakeLock=null; robustWakeLockReason=''; return true;
  }
  function confirmTabLock(stateOrAccount, scanId = '') {
    const account=typeof stateOrAccount==='string' ? String(stateOrAccount||'').toUpperCase() : scanAccount(stateOrAccount);
    const sid=typeof stateOrAccount==='string' ? String(scanId||'') : String(stateOrAccount?.scanId||'');
    const cur=readTabLock(account);
    return !!cur && cur.tabId===TAB_ID && (!sid || !cur.scanId || cur.scanId===sid) && !!cur.claimNonce;
  }
  function otherTabReallyOwnsLock(cur, account) {
    if (!cur?.tabId || cur.tabId === TAB_ID) return false;
    const hb = readTabHeartbeat(cur.tabId);
    return heartbeatIsLive(hb, account) && (!cur.scanId || !hb.scanId || cur.scanId === hb.scanId);
  }
  function scanCooldownKey(account) { return `VT_LAST_SCAN_START_V33713_${String(account || 'UNKNOWN').toUpperCase()}`; }
  function allowConservativeScanStart(account, label = 'scan', interactive = true) {
    const c = getConfig();
    const cooldown = Math.max(0, Number(c.scanCooldownMs || 0));
    if (!cooldown) return true;
    const key = scanCooldownKey(account);
    const last = Number(GM_getValue(key, 0) || 0);
    const elapsed = Date.now() - last;
    if (last > 0 && elapsed >= 0 && elapsed < cooldown) {
      const remaining = Math.max(1, Math.ceil((cooldown - elapsed) / 60000));
      if (!interactive) return false;
      if (!confirm(`Mode faible trafic : un scan de ${account} a déjà démarré récemment.
Attends encore environ ${remaining} min pour éviter un rescannage inutile.

Forcer quand même ${label} ?`)) return false;
    }
    GM_setValue(key, Date.now());
    return true;
  }
  function scanHistoryKey(account = getConfig().account) { return SCAN_HISTORY_KEY_PREFIX + String(account || 'UNKNOWN').trim().toUpperCase(); }
  function getScanHistory(account = getConfig().account) {
    const raw = GM_getValue(scanHistoryKey(account), []);
    return Array.isArray(raw) ? raw.filter(x => x && typeof x === 'object').slice(0, SCAN_HISTORY_LIMIT).map(x => ({...x})) : [];
  }
  function saveScanHistory(rows, account = getConfig().account) {
    const clean = Array.isArray(rows) ? rows.filter(x => x && typeof x === 'object').slice(0, SCAN_HISTORY_LIMIT) : [];
    GM_setValue(scanHistoryKey(account), clean);
  }
  function scanDurationMs(startedAt, finishedAt) {
    const a=Date.parse(String(startedAt||'')), b=Date.parse(String(finishedAt||''));
    return Number.isFinite(a) && Number.isFinite(b) && b>=a ? b-a : 0;
  }
  function formatDuration(ms) {
    const total=Math.max(0,Math.round(Number(ms||0)/1000));
    if (total < 60) return `${total}s`;
    const m=Math.floor(total/60), sec=total%60;
    if (m < 60) return sec ? `${m}min ${sec}s` : `${m}min`;
    const h=Math.floor(m/60), rem=m%60;
    return rem ? `${h}h ${rem}min` : `${h}h`;
  }
  function scanSummaryStatus(state, requestedStatus='') {
    const forced=String(requestedStatus||'').toUpperCase();
    if (['OK','PARTIEL','ERREUR','MANQUÉ'].includes(forced)) return forced;
    const st=state?.stats||{};
    if (state?.finalStatsVerified === false || Number(st.errors||0)>0 || Number(st.rangeUnknown||0)>0 || Number(st.uncertain||0)>0) return 'PARTIEL';
    return 'OK';
  }
  function buildScanSummary(state, requestedStatus='', note='') {
    const finishedAt=state?.finishedAt || nowIso();
    const account=String(state?.account || getConfig().account || '').trim().toUpperCase();
    const stats={...(state?.stats||{})};
    return {
      scanId:String(state?.scanId || `event-${Date.now().toString(36)}`),
      account,
      status:scanSummaryStatus(state,requestedStatus),
      mode:String(state?.mode||'range'),
      days:Number(state?.days||0),
      scheduled:state?.scheduled===true,
      scheduledId:String(state?.scheduledId||''),
      priorityTracking:state?.priorityTracking===true,
      startedAt:String(state?.startedAt||''),
      finishedAt:String(finishedAt),
      durationMs:scanDurationMs(state?.startedAt,finishedAt),
      stats,
      finalStatsVerified: state?.finalStatsVerified !== false,
      note:String(note || state?.lastMessage || '').slice(0,240),
      recordedAt:Date.now(),
    };
  }
  function upsertScanSummary(summary, account = summary?.account || getConfig().account) {
    if (!summary || typeof summary !== 'object') return null;
    const acct=String(account||'').trim().toUpperCase();
    const rows=getScanHistory(acct);
    const id=String(summary.scanId||'');
    const next=[{...summary,account:acct}, ...rows.filter(x => String(x.scanId||'') !== id)].slice(0,SCAN_HISTORY_LIMIT);
    saveScanHistory(next,acct); updatePanel(getState()); return next[0];
  }
  function recordScanSummary(state, status='', note='') { return upsertScanSummary(buildScanSummary(state,status,note), state?.account || getConfig().account); }
  function recordMissedSchedule(schedule, account = getConfig().account) {
    const acct=String(account||'').trim().toUpperCase();
    const when=new Date(Number(schedule?.scheduledAt||Date.now())).toISOString();
    return upsertScanSummary({
      scanId:String(schedule?.id||`missed-${Date.now().toString(36)}`), account:acct, status:'MANQUÉ', mode:'range', days:Number(schedule?.days||0), scheduled:true,
      scheduledId:String(schedule?.id||''), priorityTracking:schedule?.priorityTracking===true, startedAt:when, finishedAt:nowIso(), durationMs:0, stats:{orders:0,shipments:0,trackingFound:0,pending:0,delivered:0,uncertain:0,errors:0,rangeIncluded:0,rangeUnknown:0,rangeOutside:0},
      note:`Programmation manquée : ${formatScheduleDateTime(schedule?.scheduledAt)}`, recordedAt:Date.now()
    },acct);
  }
  function scanSummaryLabel(row) {
    if (!row) return 'Aucun scan terminé enregistré';
    const st=row.stats||{}; const when=row.finishedAt ? formatScheduleDateTime(Date.parse(row.finishedAt)) : '-';
    const kind=row.mode==='search'?'Livraison':row.mode==='missing'?'Suivis manquants':row.priorityTracking===true?`⚡ Suivis + ASIN ${row.days||'?'} j`:`${row.days||'?'} j`;
    // Les scans de période utilisent rangeIncluded (total de la période). Les modes
    // Livraison / Suivis manquants n'alimentent pas ce bucket et doivent afficher
    // le vrai nombre d'OrderID traités.
    const summaryOrders = (row.mode==='search' || row.mode==='missing')
      ? Number(st.orders||0)
      : Number(st.rangeIncluded ?? st.orders ?? 0);
    const verification = row.finalStatsVerified === false ? ' · Compteurs Google non vérifiés' : '';
    const smartSkip=Number(st.smartSkippedFinal||0)+Number(st.smartSkippedRecent||0)+Number(st.smartSkippedPending||0);
    const smartText=(smartSkip||Number(st.smartDirectTracking||0))?` · Smart skip ${smartSkip} / direct ${st.smartDirectTracking||0}`:'';
    return `${row.status||'?'} · ${kind} · ${when} · ${formatDuration(row.durationMs||0)}${verification}${smartText}
Commandes ${summaryOrders} · Colis ${st.shipments||0} · Suivis ${st.trackingFound||0} · Attente ${st.pending||0} · Livrés ${st.delivered||0} · Dates inconnues ${st.rangeUnknown||0} · À vérifier ${st.uncertain||0} · Erreurs ${st.errors||0}`;
  }
  function scheduleKey(account = getConfig().account) { return SCHEDULE_KEY_PREFIX + String(account || 'UNKNOWN').trim().toUpperCase(); }
  function twoDigits(v) { return String(v).padStart(2, '0'); }
  function parseLocalScheduleDateTime(dateStr, timeStr) {
    const dm = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const tm = String(timeStr || '').match(/^(\d{2}):(\d{2})$/);
    if (!dm || !tm) return null;
    const y=Number(dm[1]), m=Number(dm[2])-1, d=Number(dm[3]), h=Number(tm[1]), min=Number(tm[2]);
    if (h<0 || h>23 || min<0 || min>59) return null;
    const out = new Date(y,m,d,h,min,0,0);
    if (out.getFullYear()!==y || out.getMonth()!==m || out.getDate()!==d || out.getHours()!==h || out.getMinutes()!==min) return null;
    return out;
  }
  function schedulePartsFromDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return {date:'',time:''};
    return { date:`${d.getFullYear()}-${twoDigits(d.getMonth()+1)}-${twoDigits(d.getDate())}`, time:`${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}` };
  }
  function formatScheduleDateTime(ts) {
    const d = new Date(Number(ts || 0));
    if (Number.isNaN(d.getTime())) return '-';
    return `${twoDigits(d.getDate())}/${twoDigits(d.getMonth()+1)}/${d.getFullYear()} ${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}`;
  }
  function getScheduledScan(account = getConfig().account) {
    const raw = GM_getValue(scheduleKey(account), null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out={ ...raw };
    if (out.robustNight == null) out.robustNight = getConfig().nightRobustScheduleDefault !== false;
    return out;
  }
  function saveScheduledScan(schedule, account = getConfig().account) {
    if (!schedule || typeof schedule !== 'object') return;
    GM_setValue(scheduleKey(account), { ...schedule, account:String(account || '').trim().toUpperCase() });
  }
  function programScheduledScan(dateStr, timeStr, days, account = getConfig().account, priorityTracking = false, robustNight = getConfig().nightRobustScheduleDefault !== false) {
    const acct = String(account || '').trim().toUpperCase();
    if (!validAccountName(acct)) throw new Error('Compte VINE invalide. Configure d’abord le téléphone.');
    const when = parseLocalScheduleDateTime(dateStr, timeStr);
    if (!when) throw new Error('Date ou heure invalide.');
    if (![7,15,30].includes(Number(days))) throw new Error('Type de scan invalide.');
    if (when.getTime() <= Date.now() + 60000) throw new Error('Choisis une heure au moins 1 minute dans le futur.');
    const schedule = {
      id:`sched-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,
      account:acct, enabled:true, date:String(dateStr), time:String(timeStr), days:Number(days), priorityTracking:priorityTracking===true, robustNight:robustNight===true,
      scheduledAt:when.getTime(), createdAt:Date.now(), lastAttemptAt:0, status:'programmé', scanId:''
    };
    saveScheduledScan(schedule, acct);
    if (schedule.robustNight) setTimeout(()=>requestRobustWakeLock('programmation-nuit'),0);
    updatePanel(getState());
    return schedule;
  }
  function cancelScheduledScan(account = getConfig().account) {
    const s = getScheduledScan(account);
    if (!s) return false;
    s.enabled=false; s.status='annulé'; s.cancelledAt=Date.now();
    saveScheduledScan(s, account); releaseRobustWakeLockIfIdle(); updatePanel(getState()); return true;
  }
  function markScheduledScanLaunched(id, scanId, account = getConfig().account) {
    if (!id) return;
    const s = getScheduledScan(account);
    if (!s || s.id !== id || !s.enabled) return;
    s.enabled=false; s.status='lancé'; s.firedAt=Date.now(); s.scanId=String(scanId || '');
    saveScheduledScan(s, account); updatePanel(getState());
  }
  function setScheduledScanStatus(id, status, account = getConfig().account) {
    const s=getScheduledScan(account); if(!s || s.id!==id || !s.enabled) return;
    if (s.status !== status) { s.status=status; saveScheduledScan(s, account); updatePanel(getState()); }
  }
  function scheduledScanKind(schedule) {
    const days=Number(schedule?.days||0) || '?';
    const base=schedule?.priorityTracking===true ? `⚡ Suivis + ASIN · ${days} j` : `Scanner ${days} j`; return schedule?.robustNight===true ? `${base} · 🌙 robuste` : base;
  }
  function scheduleStatusText(account = getConfig().account) {
    const s = getScheduledScan(account);
    if (!s) return 'Aucun scan programmé';
    const when = formatScheduleDateTime(s.scheduledAt);
    if (s.enabled) {
      const suffix = s.status && s.status !== 'programmé' ? ` — ${s.status}` : '';
      return `⏰ ${when} · ${scheduledScanKind(s)}${suffix}`;
    }
    if (s.status === 'lancé') return `✅ Scan programmé lancé à ${formatScheduleDateTime(s.firedAt || s.scheduledAt)} · ${scheduledScanKind(s)}`;
    if (s.status === 'manqué') return `⚠️ Programmation manquée : ${when} · ${scheduledScanKind(s)}`;
    if (s.status === 'annulé') return `Programmation annulée : ${when}`;
    return `Dernière programmation : ${when} · ${scheduledScanKind(s)}`;
  }
  function defaultScheduleParts() {
    const d = new Date(Date.now() + 10 * 60 * 1000);
    d.setSeconds(0,0);
    d.setMinutes(Math.ceil(d.getMinutes()/5)*5);
    return schedulePartsFromDate(d);
  }
  async function checkScheduledScan() {
    if (schedulerCheckBusy) return;
    schedulerCheckBusy = true;
    try {
      const acct=String(getConfig().account || '').trim().toUpperCase();
      if (!validAccountName(acct)) return;
      const s=getScheduledScan(acct); if(!s || !s.enabled) return;
      const now=Date.now(), due=Number(s.scheduledAt||0), grace=s.robustNight===true ? Math.max(60*60*1000,Number(getConfig().nightRobustGraceMs||4*60*60*1000)) : Math.max(10*60*1000,Number(getConfig().scheduleGraceMs||30*60*1000));
      if (s.robustNight===true) requestRobustWakeLock('programmation-nuit');
      if (!due || now < due) return;
      if (now > due + grace) {
        s.enabled=false; s.status='manqué'; s.missedAt=now; saveScheduledScan(s,acct); recordMissedSchedule(s,acct); updatePanel(getState());
        toast(`Programmation manquée (${formatScheduleDateTime(due)}). Aucun scan tardif n’a été lancé.`, 'warn');
        return;
      }
      const current=getState();
      if (current?.active) { setScheduledScanStatus(s.id,'attente fin du scan actif',acct); return; }
      if (current?.paused) { setScheduledScanStatus(s.id,'bloqué : scan en pause',acct); return; }
      if (Number(s.lastAttemptAt||0) && now-Number(s.lastAttemptAt||0) < SCHEDULE_ATTEMPT_INTERVAL_MS) return;
      s.lastAttemptAt=now; s.status='démarrage…'; saveScheduledScan(s,acct); updatePanel(getState());
      if (s.robustNight===true && typeof navigator!=='undefined' && navigator.onLine===false) { s.status='attente réseau…'; saveScheduledScan(s,acct); updatePanel(getState()); return; }
      const launched = await startScan(Number(s.days||7),'range',{ scheduled:true, scheduledId:s.id, priorityTracking:s.priorityTracking===true, robustNight:s.robustNight===true });
      if (!launched) {
        const latest=getScheduledScan(acct);
        if(latest?.enabled && latest.id===s.id){ latest.status='nouvelle tentative dans 5 min'; saveScheduledScan(latest,acct); updatePanel(getState()); }
      }
    } catch (e) {
      const s=getScheduledScan();
      if(s?.enabled){ s.status=`erreur temporaire : ${String(e?.message||e).slice(0,80)}`; saveScheduledScan(s); updatePanel(getState()); }
    } finally { schedulerCheckBusy=false; }
  }
  function startSchedulerLoop() {
    if (schedulerTimer) return;
    schedulerTimer=setInterval(checkScheduledScan,15000);
    setTimeout(checkScheduledScan,1200);
    try { document.addEventListener('visibilitychange',()=>{ if(!document.hidden) checkScheduledScan(); }); } catch (_) {}
    // Les navigateurs mobiles peuvent ralentir ou suspendre les timers d'un onglet en arrière-plan.
    // Ces hooks ne contournent pas cette suspension : ils déclenchent un contrôle immédiat
    // quand la page redevient active, dans la fenêtre de grâce du programmateur.
    try { window.addEventListener('focus',()=>checkScheduledScan()); } catch (_) {}
    try { window.addEventListener('pageshow',()=>{ checkScheduledScan(); requestRobustWakeLock('pageshow'); }); } catch (_) {}
    try { window.addEventListener('online',()=>{ checkScheduledScan(); const st=getState(); if(st?.active&&st.robustNight===true) resumeScan(); }); } catch (_) {}
    try { document.addEventListener('visibilitychange',()=>{ if(!document.hidden) requestRobustWakeLock('visible'); }); } catch (_) {}
    const sc=getScheduledScan(); if(sc?.enabled&&sc.robustNight===true) requestRobustWakeLock('programmation-nuit');
  }

  function readTabLock(account) { return GM_getValue(lockKey(account), null); }
  function acquireTabLock(account, scanId, force = false) {
    const key = lockKey(account), now = Date.now(), cur = GM_getValue(key, null);
    const acct = String(account || '').toUpperCase();
    if (!force && cur?.tabId && cur.tabId !== TAB_ID && otherTabReallyOwnsLock(cur, acct)) return false;
    const claimNonce=`claim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
    GM_setValue(key, { tabId:TAB_ID, scanId:scanId||'', claimNonce, ts:now, url:location.href, recoveredFrom:cur?.tabId&&cur.tabId!==TAB_ID?cur.tabId:'' });
    writeTabHeartbeat();
    const confirm=GM_getValue(key,null);
    return !!confirm && confirm.tabId===TAB_ID && confirm.claimNonce===claimNonce;
  }
  function scanAccount(state) {
    return String(state?.account || '').trim().toUpperCase();
  }
  function refreshTabLock(state) {
    writeTabHeartbeat();
    if (!state?.active) return;
    const account = scanAccount(state); if (!account) return;
    const cur = readTabLock(account);
    if (!cur || cur.tabId === TAB_ID || !otherTabReallyOwnsLock(cur, account)) {
      GM_setValue(lockKey(account), { tabId:TAB_ID, scanId:state.scanId||'', claimNonce:(cur?.tabId===TAB_ID&&cur?.claimNonce)?cur.claimNonce:`refresh-${Date.now().toString(36)}`, ts:Date.now(), url:location.href });
    }
  }
  function releaseTabLock(account, scanId = '') {
    const key = lockKey(account), cur = GM_getValue(key, null);
    if (cur?.tabId === TAB_ID && (!scanId || !cur.scanId || cur.scanId === scanId)) GM_deleteValue(key);
    writeTabHeartbeat();
  }
  function ownsTabLock(state) {
    const account = scanAccount(state);
    if (!account) return false;
    const cur = readTabLock(account);
    if (!cur) return acquireTabLock(account, state?.scanId || '', true);
    if (cur.tabId === TAB_ID) return !state?.scanId || !cur.scanId || cur.scanId === state.scanId;
    // Un verrou étranger sans heartbeat actif est orphelin : reprise immédiate.
    if (!otherTabReallyOwnsLock(cur, account)) return acquireTabLock(account, state?.scanId || '', true);
    return false;
  }
  function stateAccountIsCurrent(state) {
    const cfg = getConfig();
    const stateAcct = scanAccount(state), configAcct = String(cfg.account || '').trim().toUpperCase();
    if (!stateAcct || !configAcct || stateAcct !== configAcct) return false;
    const stateEndpoint = normalizedWebAppEndpoint(state?.webAppUrl || '');
    const configEndpoint = normalizedWebAppEndpoint(cfg.webAppUrl || '');
    if (stateEndpoint && configEndpoint && stateEndpoint !== configEndpoint) return false;
    return true;
  }
  function pauseForAccountMismatch(state) {
    if (!state) return false;
    const cfg = getConfig();
    const stateAcct = scanAccount(state) || '?';
    const configAcct = String(cfg.account || '').trim().toUpperCase() || '?';
    const stateEndpoint = normalizedWebAppEndpoint(state?.webAppUrl || '');
    const configEndpoint = normalizedWebAppEndpoint(cfg.webAppUrl || '');
    if (stateAcct === configAcct && (!stateEndpoint || !configEndpoint || stateEndpoint === configEndpoint)) return true;
    state.active = false;
    state.paused = true;
    const endpointNote = stateEndpoint && configEndpoint && stateEndpoint !== configEndpoint ? ' Le déploiement Apps Script a aussi changé.' : '';
    state.lastMessage = `Pause sécurité : ce scan appartient à ${stateAcct}, mais la configuration courante est ${configAcct}.${endpointNote} Remets la configuration du scan ou réinitialise-le.`;
    GM_setValue(STATE_KEY, state);
    updatePanel(state);
    releaseTabLock(stateAcct, state.scanId || '');
    toast(state.lastMessage, 'error');
    return false;
  }

  function getState() {
    const st = GM_getValue(STATE_KEY, null);
    if (!st) return null;
    if (String(st.version || '') !== VERSION) { GM_deleteValue(STATE_KEY); return null; }
    return st;
  }

  function saveState(st) {
    if (st) { st.version = VERSION; refreshTabLock(st); }
    GM_setValue(STATE_KEY, st); updatePanel(st);
    if (st && st.active === false) setTimeout(()=>releaseRobustWakeLockIfIdle(),0);
  }


  function setScanOperation(state, kind, extra = {}) {
    if (!state) return;
    state.operation = {
      kind: String(kind || ''),
      startedAt: Date.now(),
      at: nowIso(),
      phase: state.phase || '',
      ...extra,
    };
    saveState(state);
  }

  function clearScanOperation(state) {
    if (!state) return;
    const key = watchdogKeyForState(state);
    if (state.watchdogRecoveries && key) delete state.watchdogRecoveries[key];
    delete state.operation;
    saveState(state);
  }

  function watchdogKeyForState(state) {
    if (!state) return 'none';
    if (state.phase === 'tracking') return `tracking:${state.currentTracking?.context?.shipmentKey || state.currentTracking?.context?.orderId || 'unknown'}`;
    if (state.phase === 'details') return `details:${state.currentOrder?.orderId || 'unknown'}`;
    return `${state.phase || 'phase'}:${location.pathname}`;
  }

  function operationTimeoutMs(state) {
    const c = getConfig();
    const kind = String(state?.operation?.kind || '');
    if (kind === 'tracking-probe' || kind === 'tracking-parse') return Math.max(30000, Number(c.trackingWatchdogMs || 45000));
    if (kind.startsWith('google-')) return Math.max(45000, Number(c.googleWatchdogMs || 90000));
    if (kind === 'details-wait') return Math.max(45000, Number(c.googleWatchdogMs || 90000));
    return Math.max(60000, Number(c.googleWatchdogMs || 90000));
  }

  function recoverStaleScan(trigger = 'watchdog') {
    const state = getState();
    if (!state?.active || state?.paused || !state.operation?.startedAt) return false;
    const age = Date.now() - Number(state.operation.startedAt || 0);
    const timeout = operationTimeoutMs(state);
    if (age < timeout) return false;

    const key = watchdogKeyForState(state);
    state.watchdogRecoveries ||= {};
    const count = Number(state.watchdogRecoveries[key] || 0) + 1;
    state.watchdogRecoveries[key] = count;
    const maxRecoveries = Math.max(1, Number(getConfig().watchdogMaxRecoveries || 2));

    // Cas le plus fréquent observé : page /progress-tracker correcte mais le probe
    // n'est jamais revenu (timer mobile suspendu / callback perdu). Au prochain reload,
    // on saute uniquement l'attente, puis on lit le DOM présent et on continue.
    if (String(state.operation.kind || '') === 'tracking-probe' && state.currentTracking?.context?.shipmentKey) {
      state.forceTrackingProbeSkip ||= {};
      state.forceTrackingProbeSkip[state.currentTracking.context.shipmentKey] = true;
    }

    if (count > maxRecoveries) {
      state.active = false;
      state.paused = true;
      state.lastMessage = `Pause anti-blocage après ${count - 1} reprise(s) automatiques : étape ${state.operation.kind || '?'} figée ${Math.round(age/1000)} s. Ouvre Diagnostic puis Reprendre.`;
      saveState(state);
      try { toast(state.lastMessage, 'error'); } catch (_) {}
      return true;
    }

    state.lastMessage = `Anti-blocage ${count}/${maxRecoveries} : reprise de ${state.operation.kind || state.phase} après ${Math.round(age/1000)} s (${trigger})…`;
    saveState(state);
    setTimeout(() => {
      try { prepareNavigationHandoff(); location.reload(); } catch (_) { try { navigateTo(location.href); } catch (_) {} }
    }, 250);
    return true;
  }

  function startScanWatchdog() {
    if (scanWatchdogTimer) return;
    const tick = () => {
      try { recoverStaleScan('timer'); } catch (e) { log('Watchdog scan', e); }
    };
    scanWatchdogTimer = setInterval(tick, Math.max(5000, Number(getConfig().watchdogPollMs || 10000)));
    try { document.addEventListener('visibilitychange', () => { if (!document.hidden) recoverStaleScan('visibility'); }); } catch (_) {}
    try { window.addEventListener('focus', () => recoverStaleScan('focus')); } catch (_) {}
    try { window.addEventListener('pageshow', () => recoverStaleScan('pageshow')); } catch (_) {}
  }

  function clearState() {
    const st = GM_getValue(STATE_KEY, null);
    GM_deleteValue(STATE_KEY);
    if (st) releaseTabLock(scanAccount(st) || getConfig().account, st.scanId || '');
    updatePanel(null);
  }

  function cacheKey(account) { return CACHE_PREFIX + (account || 'UNKNOWN'); }
  function getCache(account) {
    const acct = account || 'UNKNOWN';
    const current = GM_getValue(cacheKey(acct), null);
    if (current && typeof current === 'object' && !Array.isArray(current)) return current;
    // Migration non destructive vers le cache V3.3.7.17. On conserve les dates,
    // ASIN et trackings fiables. Les verdicts Delivered de V3376/V3377 sont déjà
    // issus de la logique corrigée et sont conservés afin d'éviter un rescannage massif.
    // Les caches plus anciens restent invalidés et seront recalculés.
    const merged = {};
    const trustedIds = new Set();
    for (const trustedPrefix of ['VT_ORDER_CACHE_V3376_','VT_ORDER_CACHE_V3377_']) {
      const trusted = GM_getValue(trustedPrefix + acct, null);
      if (trusted && typeof trusted === 'object' && !Array.isArray(trusted)) for (const oid of Object.keys(trusted)) trustedIds.add(oid);
    }
    for (const prefix of LEGACY_CACHE_PREFIXES) {
      const legacy = GM_getValue(prefix + acct, null);
      if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
        for (const [oid, row] of Object.entries(legacy)) merged[oid] = { ...(merged[oid] || {}), ...(row || {}) };
      }
    }
    if (Object.keys(merged).length) {
      for (const [oid, row] of Object.entries(merged)) {
        if (!row || typeof row !== 'object') continue;
        if (trustedIds.has(oid)) continue;
        row.delivered = false;
        row.lastChecked = '';
        if (row.shipments && typeof row.shipments === 'object') {
          for (const sh of Object.values(row.shipments)) {
            if (!sh || typeof sh !== 'object') continue;
            sh.delivered = false;
            sh.lastChecked = '';
          }
        }
      }
      GM_setValue(cacheKey(acct), merged);
    }
    return merged;
  }
  function saveCache(account, cache) {
    const cutoff = Date.now() - 400 * 86400000;
    for (const [k, v] of Object.entries(cache)) {
      const t = Date.parse(v.lastSeen || v.orderDate || 0) || 0;
      if (t && t < cutoff) delete cache[k];
    }
    GM_setValue(cacheKey(account), cache);
  }

  function smartForceKey(account = getConfig().account) { return SMART_FORCE_PREFIX + String(account || 'UNKNOWN').trim().toUpperCase(); }
  function armForceFullNext(account = getConfig().account) { GM_setValue(smartForceKey(account), true); updatePanel(getState()); }
  function consumeForceFullNext(account = getConfig().account) {
    const key=smartForceKey(account), value=GM_getValue(key,false)===true;
    if(value) GM_deleteValue(key);
    return value;
  }
  function smartForcePending(account = getConfig().account) { return GM_getValue(smartForceKey(account),false)===true; }
  function smartDbSupported() { return typeof indexedDB !== 'undefined'; }
  function smartOrderKey(account, orderId) { return `${String(account||'').trim().toUpperCase()}|${String(orderId||'').trim()}`; }
  function smartNormalizeOrderRecord(account, row) {
    if(!row || !/^\d{3}-\d{7}-\d{7}$/.test(String(row.orderId||''))) return null;
    const acct=String(account||row.account||'').trim().toUpperCase();
    const shipments=Array.isArray(row.shipments)?row.shipments.filter(Boolean).map(x=>({...x})):[];
    const items=Array.isArray(row.items)?row.items.filter(Boolean).map(x=>({...x})):[];
    const trackingIds=[...new Set(shipments.map(x=>normalizeKey(x.trackingId||'')).filter(Boolean))];
    const asins=[...new Set(items.map(x=>String(x.asin||'').toUpperCase()).filter(x=>/^[A-Z0-9]{10}$/.test(x)))];
    const lastChecked=String(row.lastChecked||row.lastSeen||'');
    return {...row,account:acct,key:smartOrderKey(acct,row.orderId),orderId:String(row.orderId),shipments,items,trackingIds,asins,lastChecked,lastCheckedTs:Date.parse(lastChecked)||0,updatedAt:Date.now()};
  }
  function smartDbOpen() {
    if(!smartDbSupported()) return Promise.resolve(null);
    if(smartDbPromise) return smartDbPromise;
    smartDbPromise=new Promise((resolve,reject)=>{
      let req; try{req=indexedDB.open(SMART_DB_NAME,SMART_DB_VERSION);}catch(e){reject(e);return;}
      req.onupgradeneeded=()=>{
        const db=req.result; let st;
        if(!db.objectStoreNames.contains('orders')) st=db.createObjectStore('orders',{keyPath:'key'}); else st=req.transaction.objectStore('orders');
        if(!st.indexNames.contains('account')) st.createIndex('account','account',{unique:false});
        if(!st.indexNames.contains('orderId')) st.createIndex('orderId','orderId',{unique:false});
        if(!st.indexNames.contains('trackingIds')) st.createIndex('trackingIds','trackingIds',{unique:false,multiEntry:true});
        if(!st.indexNames.contains('asins')) st.createIndex('asins','asins',{unique:false,multiEntry:true});
        if(!st.indexNames.contains('lastCheckedTs')) st.createIndex('lastCheckedTs','lastCheckedTs',{unique:false});
      };
      req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error||new Error('IndexedDB indisponible'));
    }).catch(e=>{smartDbPromise=null;log('Smart Cache IndexedDB indisponible',e);return null;});
    return smartDbPromise;
  }
  async function smartDbPutRecords(records) {
    const db=await smartDbOpen(); if(!db) return false;
    const clean=(records||[]).map(r=>smartNormalizeOrderRecord(r?.account,r)).filter(Boolean);
    if(!clean.length) return true;
    return new Promise((resolve,reject)=>{const tx=db.transaction('orders','readwrite'),st=tx.objectStore('orders');clean.forEach(r=>st.put(r));tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error||new Error('IndexedDB write'));tx.onabort=()=>reject(tx.error||new Error('IndexedDB abort'));});
  }
  async function smartDbGetOrders(account, orderIds) {
    const db=await smartDbOpen(); const out={}; if(!db) return out;
    const acct=String(account||'').trim().toUpperCase(); const ids=[...new Set((orderIds||[]).map(String).filter(x=>/^\d{3}-\d{7}-\d{7}$/.test(x)))];
    if(!ids.length) return out;
    return new Promise((resolve,reject)=>{const tx=db.transaction('orders','readonly'),st=tx.objectStore('orders');let left=ids.length;ids.forEach(id=>{const req=st.get(smartOrderKey(acct,id));req.onsuccess=()=>{if(req.result)out[id]=req.result;if(--left===0)resolve(out);};req.onerror=()=>reject(req.error||new Error('IndexedDB read'));});});
  }
  async function smartDbMergeOrder(account, patch) {
    if(!patch?.orderId) return false;
    const current=(await smartDbGetOrders(account,[patch.orderId]))[patch.orderId]||{};
    const mergeBy=(oldRows,newRows,keyFn)=>{const m=new Map();for(const x of oldRows||[]){const k=keyFn(x);if(k)m.set(k,{...x});}for(const x of newRows||[]){const k=keyFn(x);if(k)m.set(k,{...(m.get(k)||{}),...x});}return [...m.values()];};
    const shipments=mergeBy(current.shipments,patch.shipments,x=>String(x?.shipmentKey||''));
    const items=mergeBy(current.items,patch.items,x=>String(x?.itemKey||`${x?.shipmentKey||''}|${x?.asin||''}`));
    const row={...current,...patch,account:String(account||'').trim().toUpperCase(),shipments,items,lastChecked:patch.lastChecked||current.lastChecked||''};
    return smartDbPutRecords([row]);
  }
  async function smartDbMaintenance(account = getConfig().account, force = false) {
    if (smartMaintenanceRunning || !getConfig().smartCacheEnabled || !smartDbSupported()) return {ok:false,reason:'disabled-or-busy'};
    const acct=String(account||'').trim().toUpperCase(); if(!acct) return {ok:false,reason:'no-account'};
    const key=`VT_SMART_MAINT_V33720_${acct}`, now=Date.now(), cfg=getConfig();
    const last=Number(GM_getValue(key,0)||0);
    if(!force && now-last < Number(cfg.smartDbMaintenanceMs||24*3600000)) return {ok:true,skipped:true};
    smartMaintenanceRunning=true;
    try{
      const db=await smartDbOpen(); if(!db) return {ok:false,reason:'db'};
      const rows=await new Promise((resolve,reject)=>{
        const out=[]; const tx=db.transaction('orders','readonly'),st=tx.objectStore('orders'),idx=st.index('account');
        const req=idx.openCursor(IDBKeyRange.only(acct));
        req.onsuccess=()=>{const cur=req.result;if(!cur){resolve(out);return;}out.push(cur.value);cur.continue();};
        req.onerror=()=>reject(req.error||new Error('IndexedDB cursor'));
      });
      const max=Math.max(500,Number(cfg.smartCacheMaxOrders||4000)), maxAgeMs=Math.max(30,Number(cfg.smartDbMaxAgeDays||180))*86400000;
      rows.sort((a,b)=>(Number(b.lastCheckedTs||b.updatedAt||0))-(Number(a.lastCheckedTs||a.updatedAt||0)));
      const deletions=[];
      for(let i=0;i<rows.length;i++){
        const r=rows[i], age=now-Number(r.lastCheckedTs||r.updatedAt||0);
        const oldFinal=(r.delivered===true||r.terminalNoTracking===true) && age>maxAgeMs;
        if(i>=max || oldFinal) deletions.push(r.key);
      }
      const cap=Math.max(100,Number(cfg.smartDbPruneBatch||500)); const batch=deletions.slice(0,cap);
      if(batch.length) await new Promise((resolve,reject)=>{
        const tx=db.transaction('orders','readwrite'),st=tx.objectStore('orders');batch.forEach(k=>st.delete(k));
        tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error||new Error('IndexedDB maintenance'));tx.onabort=()=>reject(tx.error||new Error('IndexedDB maintenance abort'));
      });
      GM_setValue(key,now);
      return {ok:true,total:rows.length,deleted:batch.length,remaining:Math.max(0,rows.length-batch.length)};
    }catch(e){log('Maintenance IndexedDB',e);return {ok:false,error:String(e?.message||e)};}
    finally{smartMaintenanceRunning=false;}
  }

  async function smartDbMirrorLegacyCache(account, cache) {
    if(!getConfig().smartCacheEnabled || !smartDbSupported()) return false;
    const entries=Object.values(cache||{}).filter(x=>x&&x.orderId).sort((a,b)=>(Date.parse(b.lastChecked||b.lastSeen||b.orderDate||0)||0)-(Date.parse(a.lastChecked||a.lastSeen||a.orderDate||0)||0)).slice(0,Number(getConfig().smartCacheMaxOrders||4000));
    if(!entries.length) return true;
    const current=await smartDbGetOrders(account,entries.map(x=>x.orderId));
    const rows=[];
    for(const o of entries){
      const prev=current[o.orderId]||{}; const byKey=new Map((prev.shipments||[]).map(sh=>[String(sh.shipmentKey||''),{...sh}]));
      for(const [shipmentKey,sh] of Object.entries(o.shipments||{})){if(shipmentKey)byKey.set(shipmentKey,{...(byKey.get(shipmentKey)||{}),shipmentKey,...sh});}
      rows.push({...prev,account,orderId:o.orderId,orderDate:o.orderDate||prev.orderDate||'',lastChecked:o.lastChecked||o.lastSeen||prev.lastChecked||'',trackingComplete:o.trackingComplete===true,delivered:o.delivered===true,terminalNoTracking:o.terminalNoTracking===true,uncertain:prev.uncertain===true||Object.values(o.shipments||{}).some(sh=>sh?.conflict===true),shipments:[...byKey.values()],items:prev.items||[]});
    }
    return smartDbPutRecords(rows);
  }
  async function fetchKnownOrderState(orderIds) {
    const ids=[...new Set((orderIds||[]).filter(x=>/^\d{3}-\d{7}-\d{7}$/.test(String(x||''))))].slice(0,250);
    if(!ids.length) return {dates:{},orders:{},source:'none'};
    const acct=getConfig().account;
    if(getConfig().smartCacheEnabled){
      try{
        const r=await apiPost('getSmartCache',{orderIds:ids});
        const orders=(r&&r.orders&&typeof r.orders==='object')?r.orders:{};
        const dates=(r&&r.dates&&typeof r.dates==='object')?r.dates:{};
        const rows=Object.values(orders).map(x=>({...x,account:acct}));
        if(rows.length) await smartDbPutRecords(rows);
        return {dates,orders,source:'google'};
      }catch(e){log('Smart Cache Google indisponible, fallback dates + IndexedDB',e);}
    }
    const dates=await fetchKnownOrderDates(ids);
    let orders={}; try{orders=await smartDbGetOrders(acct,ids);}catch(_){}
    return {dates,orders,source:Object.keys(orders).length?'indexeddb':'dates'};
  }
  function smartRecordUncertain(row) {
    if(!row) return false;
    if(row.uncertain===true) return true;
    return (row.shipments||[]).some(x=>String(x?.dataQuality||'').toUpperCase()==='A_VERIFIER'||x?.conflict===true)
      || (row.items||[]).some(x=>String(x?.dataQuality||'').toUpperCase()==='A_VERIFIER'||['UNASSIGNED','UNKNOWN'].includes(String(x?.assignmentQuality||'').toUpperCase()));
  }
  function smartDirectTrackingReady(row) {
    if(!row || !Array.isArray(row.shipments) || !row.shipments.length || !Array.isArray(row.items) || !row.items.length) return false;
    const open=row.shipments.filter(sh=>sh&&sh.delivered!==true&&!sh.terminal);
    if(!open.length) return false;
    return open.every(sh=>sh.trackingVerified===true && normalizeKey(sh.trackingId||'') && isAmazonTrackingUrl(sh.trackingUrl||'') && row.items.some(it=>String(it.shipmentKey||'')===String(sh.shipmentKey||'')&&/^[A-Z0-9]{10}$/.test(String(it.asin||''))));
  }
  function smartCacheDecision(state,cached,row,{rangePending=false,serverHasOrder=false}={}) {
    const c=getConfig();
    if(!c.smartCacheEnabled || state?.forceFullScan===true) return {action:'FULL',reason:state?.forceFullScan?'force-full':'disabled'};
    if(rangePending) return {action:'FULL',reason:'date-unknown'};
    if(!cached && !row) return {action:'FULL',reason:'new'};
    if(!serverHasOrder && cached) return {action:'FULL',reason:'rehydrate-google'};
    if(smartRecordUncertain(row)) return {action:'FULL',reason:'uncertain'};
    // A summary flag alone cannot prove that every parcel has its ASINs.
    if (!row) return {action:'FULL',reason:'missing-central-record'};
    if (row.trackingComplete === true && !row.terminalNoTracking) {
      const sh = Array.isArray(row.shipments) ? row.shipments : [];
      const items = Array.isArray(row.items) ? row.items : [];
      const validItem = it => /^[A-Z0-9]{10}$/.test(String(it?.asin||'')) &&
        sh.some(x=>String(x.shipmentKey||'')===String(it.shipmentKey||''));
      if (!sh.length || !items.length || !items.every(validItem) ||
          !sh.every(x=>items.some(it=>String(it.shipmentKey||'')===String(x.shipmentKey||''))))
        return {action:'FULL',reason:'missing-items'};
    }
    const trackingComplete=row ? row.trackingComplete===true : cached?.trackingComplete===true;
    const delivered=row ? row.delivered===true : cached?.delivered===true;
    const terminal=row ? row.terminalNoTracking===true : cached?.terminalNoTracking===true;
    const last=Date.parse(row?.lastChecked||cached?.lastChecked||0)||0;
    const age=last?Math.max(0,Date.now()-last):Infinity;
    if(serverHasOrder && ((delivered&&trackingComplete)||terminal)) return {action:'SKIP_FINAL',reason:delivered?'delivered-final':'terminal-final',age};
    if(serverHasOrder && trackingComplete){
      if(age < Number(c.smartTrackingRefreshMs||12*3600000)) return {action:'SKIP_RECENT',reason:'tracking-recent',age};
      if(c.smartDirectTracking!==false && smartDirectTrackingReady(row)) return {action:'DIRECT_TRACKING',reason:'tracking-refresh-due',age};
      return {action:'FULL',reason:'tracking-refresh-needs-detail',age};
    }
    if(serverHasOrder && age < Number(c.smartPendingRefreshMs||4*3600000)) return {action:'SKIP_PENDING',reason:'pending-recent',age};
    return {action:'FULL',reason:'refresh-due',age};
  }
  function enqueueSmartDirectTracking(state,row,candidate,orderDate) {
    const open=(row?.shipments||[]).filter(sh=>sh&&sh.delivered!==true&&!sh.terminal&&sh.trackingVerified===true&&isAmazonTrackingUrl(sh.trackingUrl||''));
    let added=0;
    for(const sh of open){
      const items=(row.items||[]).filter(it=>String(it.shipmentKey||'')===String(sh.shipmentKey||'')&&it.asin).map(it=>({...it,assignmentQuality:it.assignmentQuality||'HIGH'}));
      if(!items.length) continue;
      const context={shipmentKey:sh.shipmentKey,account:getConfig().account,orderId:candidate.orderId,orderDate:orderDate||row.orderDate||'',shipmentNo:Number(sh.shipmentNo||1),trackingId:sh.trackingId||'',trackingConfidence:sh.trackingConfidence||'HIGH',trackingVerified:true,carrier:sh.carrier||'',status:sh.status||'',delivered:sh.delivered===true,deliveredDate:sh.deliveredDate||'',shipDate:sh.shipDate||'',expectedDelivery:sh.expectedDelivery||'',expectedDeliveryText:sh.expectedDeliveryText||'',expectedDeliveryStart:sh.expectedDeliveryStart||'',expectedDeliveryEnd:sh.expectedDeliveryEnd||'',trackingUrl:sh.trackingUrl||'',itemsCount:items.length,dataQuality:sh.dataQuality||'OK',warnings:sh.warnings||'',lastSeen:sh.lastSeen||nowIso(),source:'smart-cache-direct'};
      state.trackQueue.push({url:context.trackingUrl,context,items,queuePriority:40,queueReason:'smart-direct-tracking'}); added++;
    }
    if(added){state.trackQueue=uniqBy(state.trackQueue,x=>x.context.shipmentKey);state.stats.shipments=Number(state.stats.shipments||0)+added;}
    return added;
  }

  function queuePriorityFor(decision, cached, smartRow) {
    if (smartRecordUncertain(smartRow)) return 20;
    if (!cached && !smartRow) return 10; // nouvelle commande
    const r=String(decision?.reason||'');
    if (r==='date-unknown' || r==='rehydrate-google' || r==='uncertain') return 20;
    if (/pending|refresh-due/.test(r)) return 30;
    if (/tracking-refresh/.test(r)) return 40;
    return 50;
  }
  function sortQueuesByPriority(state) {
    if(!state || getConfig().queuePriorityEnabled===false) return;
    const sorter=(a,b)=>(Number(a?.queuePriority||50)-Number(b?.queuePriority||50)) ||
      String(b?.orderDate||b?.context?.orderDate||'').localeCompare(String(a?.orderDate||a?.context?.orderDate||''));
    state.orderQueue=(state.orderQueue||[]).sort(sorter);
    state.trackQueue=(state.trackQueue||[]).sort(sorter);
    state.stats ||= {}; state.stats.queuePrioritized=(state.orderQueue.length+state.trackQueue.length);
  }
  function journalCheckpoint(state, kind, payload) {
    if(!state)return;
    state.journal ||= {seq:0,current:null,lastCommitted:null,recoveries:0};
    state.journal.seq=Number(state.journal.seq||0)+1;
    const key=kind==='details'?String(payload?.orderId||''):String(payload?.context?.shipmentKey||'');
    state.journal.current={seq:state.journal.seq,kind,key,payload,phase:state.phase,at:nowIso(),url:location.href};
  }
  function journalCommit(state, kind, key, outcome='ok') {
    if(!state)return;
    state.journal ||= {seq:0,current:null,lastCommitted:null,recoveries:0};
    state.journal.lastCommitted={kind,key:String(key||''),outcome,at:nowIso(),seq:Number(state.journal.current?.seq||state.journal.seq||0)};
    if(state.journal.current && (!kind || state.journal.current.kind===kind) && (!key || state.journal.current.key===String(key))) state.journal.current=null;
  }
  function recoverExactJournal(state) {
    const j=state?.journal?.current; if(!j?.payload||!j.key)return false;
    if(j.kind==='details'){
      if(state.visitedOrders?.[j.key]){journalCommit(state,'details',j.key,'already-visited');return false;}
      const onPage=isOrderDetailPage() && parseOrderId(`${location.href}\n${document.body?.innerText||''}`)===j.key;
      const queued=(state.orderQueue||[]).some(x=>String(x?.orderId||'')===j.key);
      if(!onPage&&!queued){state.orderQueue.unshift(j.payload);state.currentOrder=null;state.phase='details';state.journal.recoveries=Number(state.journal.recoveries||0)+1;state.stats.resumeRecovered=Number(state.stats.resumeRecovered||0)+1;return true;}
    } else if(j.kind==='tracking'){
      if(state.visitedTracking?.[j.key]){journalCommit(state,'tracking',j.key,'already-visited');return false;}
      const onPage=isTrackingPage() && String(state.currentTracking?.context?.shipmentKey||'')===j.key;
      const queued=(state.trackQueue||[]).some(x=>String(x?.context?.shipmentKey||'')===j.key);
      if(!onPage&&!queued){state.trackQueue.unshift(j.payload);state.currentTracking=null;state.phase='tracking';state.journal.recoveries=Number(state.journal.recoveries||0)+1;state.stats.resumeRecovered=Number(state.stats.resumeRecovered||0)+1;return true;}
    }
    return false;
  }
  function quarantineCurrent(state, errorMessage='') {
    if(!state || getConfig().quarantineEnabled===false || !['details','tracking'].includes(state.phase)) return false;
    state.quarantine ||= []; state.quarantineFinal ||= [];
    const isTrack=state.phase==='tracking';
    const payload=isTrack?state.currentTracking:state.currentOrder;
    const key=isTrack?String(payload?.context?.shipmentKey||''):String(payload?.orderId||'');
    if(!payload||!key)return false;
    const entry={kind:isTrack?'tracking':'details',key,payload,reason:String(errorMessage||''),at:nowIso(),url:location.href,pass:state.quarantineRetryPass===true?2:1};
    if(state.quarantineRetryPass===true){
      state.quarantineFinal.push(entry);
    }else{
      const seen=state.quarantine.some(x=>x.kind===entry.kind&&x.key===entry.key);
      if(!seen)state.quarantine.push(entry);
    }
    state.stats.quarantined=Number(state.stats.quarantined||0)+1;
    journalCommit(state,entry.kind,key,'quarantine');
    if(isTrack) state.currentTracking=null; else state.currentOrder=null;
    return true;
  }
  function prepareQuarantineRetry(state) {
    if(!state || getConfig().quarantineRetryAtEnd===false || state.quarantineRetryPass===true || !(state.quarantine||[]).length)return false;
    state.orderQueue ||= []; state.trackQueue ||= [];
    const entries=state.quarantine.splice(0); state.quarantineRetryPass=true;
    for(const q of entries){
      const p={...q.payload,queuePriority:95,queueReason:'quarantine-retry',quarantineRetry:true};
      if(q.kind==='tracking')state.trackQueue.push(p);else state.orderQueue.push(p);
    }
    sortQueuesByPriority(state);
    state.lastMessage=`Quarantaine : nouvelle tentative finale de ${entries.length} élément(s)…`;
    return true;
  }

  function fleetHeartbeatPayload() {
    const state=getState(), st=state?.stats||{}, sched=getScheduledScan(getConfig().account);
    return {
      build:BUILD_VERSION, protocol:VERSION, tabId:TAB_ID,
      phase:state?.phase||'', active:state?.active===true, paused:state?.paused===true,
      mode:state?.mode||'', days:Number(state?.days||0), robustNight:state?.robustNight===true,
      transport:transportLabel(), currentOrder:state?.currentOrder?.orderId||'',
      currentTracking:state?.currentTracking?.context?.trackingId||state?.currentTracking?.context?.shipmentKey||'',
      orders:Number(st.orders||0), processed:Number(st.detailsProcessed||0), shipments:Number(st.shipments||0),
      trackingFound:Number(st.trackingFound||0), pending:Number(st.pending||0), delivered:Number(st.delivered||0),
      uncertain:Number(st.uncertain||0), errors:Number(st.errors||0),
      smartSkip:Number(st.smartSkippedFinal||0)+Number(st.smartSkippedRecent||0)+Number(st.smartSkippedPending||0),
      directTracking:Number(st.smartDirectTracking||0), queueOrders:Number(state?.orderQueue?.length||0), queueTracking:Number(state?.trackQueue?.length||0),
      quarantine:Number(state?.quarantine?.length||0)+Number(state?.quarantineFinal?.length||0),
      lastMessage:String(state?.lastMessage||'Prêt').slice(0,500), path:String(location.pathname||'').slice(0,200),
      nextSchedule:sched?.enabled?String(sched.scheduledAt||''):''
    };
  }
  async function sendFleetHeartbeat(force=false) {
    if(!configReady()) return false;
    const state=getState(), cfg=getConfig(), interval=state?.active?Number(cfg.fleetHeartbeatActiveMs||120000):Number(cfg.fleetHeartbeatIdleMs||600000);
    if(googleFlushInFlight || Date.now()<Number(state?.googleSync?.nextAttemptAt||0))return false;
    if(!force && Date.now()-fleetLastSentAt<interval)return false;
    fleetLastSentAt=Date.now();
    try{await apiPost('deviceHeartbeat',fleetHeartbeatPayload());return true;}catch(e){log('Fleet heartbeat',e);return false;}
  }
  function startFleetHeartbeat() {
    if(fleetHeartbeatTimer)return;
    void sendFleetHeartbeat(true);
    fleetHeartbeatTimer=setInterval(()=>void sendFleetHeartbeat(false),60000);
    try{window.addEventListener('online',()=>void sendFleetHeartbeat(true));document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void sendFleetHeartbeat(true);});}catch(_){}
  }

  function parseOrderId(text) {
    const m = String(text || '').match(/\b\d{3}-\d{7}-\d{7}\b/);
    return m ? m[0] : '';
  }

  function normalizedAmazonPath(url) {
    try {
      const u = new URL(url, location.href);
      if (!isAmazonFrUrl(u.href)) return '';
      return String(u.pathname || '/').replace(/\/{2,}/g, '/').replace(/\/$/, '').toLowerCase() || '/';
    } catch (_) { return ''; }
  }

  // V3.3.7 : Amazon place plusieurs actions (annulation, retour, remboursement…)
  // sous /progress-tracker/. Elles ne sont PAS des pages de suivi et ne doivent
  // jamais être visitées automatiquement par le scanner.
  function isUnsafeAmazonOrderActionUrl(url) {
    const p = normalizedAmazonPath(url);
    if (!p) return false;
    return /(?:^|\/)(?:cancel-items|cancel-order|cancel|return-items|returns?|refunds?|replace-items|replacement|exchange-items|exchange)(?:\/|$)/i.test(p);
  }

  function isAmazonTrackingUrl(url) {
    const p = normalizedAmazonPath(url);
    if (!p || isUnsafeAmazonOrderActionUrl(url)) return false;
    // L'URL réellement observée et documentée par nos captures est exactement
    // /progress-tracker/package avec ses paramètres en query string. Refuser ses
    // sous-pages évite /progress-tracker/package/preship/cancel-items.
    if (p === '/progress-tracker/package') return true;
    return /(?:^|\/)(?:ship-track|track-package|package-tracking)(?:\/|$)/i.test(p) || /(?:^|\/)tracking\/package(?:\/|$)/i.test(p);
  }

  function isAmazonOrderDetailUrl(url) {
    const p = normalizedAmazonPath(url);
    if (!p || isUnsafeAmazonOrderActionUrl(url)) return false;
    return p === '/gp/your-account/order-details' || p === '/gp/css/order-details' || p === '/gp/css/summary' || /(?:^|\/)your-orders\/order(?:-details)?(?:\/|$)/i.test(p);
  }

  function trackingUrlMatchesOrder(url, expectedOrderId) {
    if (isAmazonFrUrl(url) && !isAmazonTrackingUrl(url)) return false;
    const explicit = parseOrderId(url || '');
    return !explicit || !expectedOrderId || explicit === expectedOrderId;
  }

  function partitionTrackingLinksByOrder(tracks, expectedOrderId, contextVerified = false) {
    const valid = [], mismatched = [];
    for (const tr0 of (tracks || [])) {
      if (!tr0 || !tr0.url) continue;
      const explicit = parseOrderId(tr0.url);
      if ((isAmazonFrUrl(tr0.url) && !isAmazonTrackingUrl(tr0.url)) || (explicit && expectedOrderId && explicit !== expectedOrderId)) {
        mismatched.push({ ...tr0, explicitOrderId: explicit, rejectReason: (isAmazonFrUrl(tr0.url) && !isAmazonTrackingUrl(tr0.url)) ? 'not-tracking' : 'wrong-order' });
        continue;
      }
      valid.push({ ...tr0, orderContextVerified: contextVerified || (!!explicit && explicit === expectedOrderId) || tr0.orderContextVerified === true });
    }
    return { valid, mismatched };
  }

  function parseDateFromText(text, mode = 'auto') {
    const t = normalizeText(text).toLowerCase().replace(/[.,]/g, ' ');
    let m = t.match(/\b(\d{1,2})\s+(janvier|janv|février|fevrier|févr|fevr|mars|avril|avr|mai|juin|juillet|juil|août|aout|septembre|sept|octobre|oct|novembre|nov|décembre|decembre|déc|dec)\s+(\d{4})\b/i);
    if (!m) m = t.match(/\b(\d{1,2})\s+(janvier|janv|février|fevrier|févr|fevr|mars|avril|avr|mai|juin|juillet|juil|août|aout|septembre|sept|octobre|oct|novembre|nov|décembre|decembre|déc|dec)\b/i);
    if (m) {
      const month = MONTHS[m[2].toLowerCase()];
      if (month == null) return null;
      const now = localNoon(0);
      const day = Number(m[1]);
      let year = m[3] ? Number(m[3]) : now.getFullYear();
      let d = makeLocalDate(year, month, day);
      if (!d) return null;
      if (!m[3]) {
        if (mode === 'past' && d.getTime() > now.getTime() + 2 * 86400000) d = makeLocalDate(year - 1, month, day);
        else if (mode === 'future' && d.getTime() < now.getTime() - 45 * 86400000) d = makeLocalDate(year + 1, month, day);
        else if (mode === 'auto') {
          const candidates = [-1, 0, 1].map(delta => makeLocalDate(year + delta, month, day)).filter(Boolean);
          d = candidates.sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0] || null;
        }
      }
      return d || null;
    }
    m = t.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})\b/);
    if (m) return makeLocalDate(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    // Certaines variantes Amazon exposent les dates dans des attributs structurés ISO.
    m = t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (m) return makeLocalDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return null;
  }

  function extractOrderDate(text) {
    const lines = normalizeText(text).split('\n').map(x => x.trim()).filter(Boolean);
    const markerRe = /(?:commande\s+(?:passée|passee|effectuée|effectuee|placée|placee)|date\s+de\s+(?:la\s+)?commande|commandé(?:e)?(?:\s+(?:le|du))?|order\s+(?:placed|date))\b/i;
    const forbiddenRe = /livraison|livr[ée]|arriv|exp[ée]di|retard|colis/i;

    // Amazon mobile sépare souvent « Commande passée » et la date sur deux lignes.
    // On n'inspecte que la ligne du libellé et les deux lignes suivantes afin de ne
    // jamais récupérer par erreur une date de livraison/expédition plus loin.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (forbiddenRe.test(line) || !markerRe.test(line)) continue;
      for (let j = i; j <= Math.min(i + 2, lines.length - 1); j++) {
        const probe = lines[j];
        if (j > i && forbiddenRe.test(probe)) break;
        const d = parseDateFromText(probe, 'past');
        if (d) return isoDate(d);
      }
    }
    return '';
  }

  function extractOrderDateNearOrderId(text, orderId) {
    const oid = String(orderId || '').trim();
    if (!oid) return '';
    const lines = normalizeText(text).split('\n').map(x => x.trim()).filter(Boolean);
    const indexes = [];
    for (let i = 0; i < lines.length; i++) if (lines[i].includes(oid)) indexes.push(i);
    for (const i of indexes) {
      let lo = i, hi = i;
      // Remonte jusqu'au début logique de CETTE commande, sans franchir une autre commande.
      for (let k = i - 1; k >= Math.max(0, i - 24); k--) {
        const other = extractOrderIds(lines[k]).filter(x => x !== oid);
        if (other.length) break;
        lo = k;
      }
      // Quelques lignes après l'OrderID suffisent pour les variantes Amazon où le libellé est dessous.
      for (let k = i + 1; k <= Math.min(lines.length - 1, i + 8); k++) {
        const other = extractOrderIds(lines[k]).filter(x => x !== oid);
        if (other.length) break;
        hi = k;
      }
      const d = extractOrderDate(lines.slice(lo, hi + 1).join('\n'));
      if (d) return d;
    }
    return '';
  }

  function explicitOrderDateFromAttributes(node) {
    if (!node) return '';
    const nodes = [node];
    // Sélecteurs bornés : évite un querySelectorAll('*') coûteux sur les longues pages d'historique.
    try {
      nodes.push(...Array.from(node.querySelectorAll?.(
        '[data-order-date],[data-orderdate],[data-order-placed-date],[data-order-placement-date],[data-date-order],[data-commande-date],[data-date-commande]'
      ) || []).slice(0, 80));
    } catch (_) {}
    for (const el of nodes) {
      try {
        const attrs = Array.from(el?.attributes || []);
        for (const attr of attrs) {
          const name = String(attr?.name || '').toLowerCase();
          if (!/(?:order.*date|date.*order|placed.*date|date.*placed|commande.*date|date.*commande)/i.test(name)) continue;
          const d = parseDateFromText(String(attr?.value || ''), 'past');
          if (d) return isoDate(d);
        }
      } catch (_) {}
    }
    return '';
  }

  function dateTextVariants(node) {
    const out = [];
    const add = v => {
      const t = normalizeText(v || '');
      if (t && !out.includes(t)) out.push(t);
    };
    try { add(node?.innerText); } catch (_) {}
    try { add(node?.textContent); } catch (_) {}
    try { add(node?.getAttribute?.('aria-label')); } catch (_) {}
    try { add(node?.getAttribute?.('title')); } catch (_) {}
    return out;
  }

  function extractOrderDateFromAssociatedNode(node, orderId) {
    if (!node || !orderId) return '';
    const ids = orderIdsFromElement(node);
    if (!ids.includes(orderId)) return '';
    // Un conteneur qui contient plusieurs commandes est trop large : ne jamais y prendre
    // une date sans corrélation plus fine, sinon on peut attribuer la date du voisin.
    if (ids.some(x => x !== orderId)) return '';

    const structured = explicitOrderDateFromAttributes(node);
    if (structured) return structured;
    for (const txt of dateTextVariants(node)) {
      const d = extractOrderDate(txt);
      if (d) return d;
    }
    return '';
  }

  function extractOrderDateFromLiveCandidate(rec, root = document) {
    if (!rec?.orderId) return '';
    const oid = rec.orderId;

    // 1) Carte détectée par le scanner. Ne lire directement la date que si cette
    //    carte n'englobe pas plusieurs OrderID (protection contre la date du voisin).
    for (const card of (rec.cards || [])) {
      const cardIds = orderIdsFromElement(card);
      const cardUnique = !cardIds.length || (cardIds.includes(oid) && !cardIds.some(x => x !== oid));
      if (cardUnique) {
        for (const txt of dateTextVariants(card)) {
          const direct = extractOrderDate(txt);
          if (direct) return direct;
        }
        const attrDate = explicitOrderDateFromAttributes(card);
        if (attrDate) return attrDate;
      }

      // 2) Cas Amazon Android réel : l'OrderID peut n'exister QUE dans href/data-order-id
      //    et ne pas être visible dans innerText. La version précédente exigeait à tort l'OrderID dans
      //    le texte du parent, ce qui faisait classer toutes les commandes « date inconnue ».
      //    On remonte désormais les parents en vérifiant l'association STRUCTURELLE à l'OrderID.
      let n = card;
      for (let depth = 0; depth < 14 && n && n !== root?.body; depth++, n = n.parentElement) {
        const ids = orderIdsFromElement(n);
        if (ids.includes(oid)) {
          if (ids.some(x => x !== oid)) break; // parent englobant plusieurs commandes : stop anti-contamination
          const d = extractOrderDateFromAssociatedNode(n, oid);
          if (d) return d;
        }
      }
    }

    // 3) Fallback texte historique si l'OrderID est réellement visible dans la page.
    const bodyText = root?.body?.innerText || root?.body?.textContent || '';
    const byVisibleId = extractOrderDateNearOrderId(bodyText, oid);
    if (byVisibleId) return byVisibleId;

    return '';
  }

  function classifyOrderDateForRange(orderDate, cutoffTs, nowTs = Date.now(), rangeEndTs = null) {
    if (!orderDate) return 'UNKNOWN';
    const d = new Date(`${orderDate}T12:00:00`);
    if (Number.isNaN(d.getTime())) return 'UNKNOWN';
    const now = new Date(nowTs);
    const endToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
    if (d.getTime() > endToday) return 'UNKNOWN';
    const startTs = Number(cutoffTs || 0);
    const endTs = Number(rangeEndTs || endToday);
    if (d.getTime() < startTs || d.getTime() > endTs) return 'OUTSIDE';
    return 'IN_RANGE';
  }

  function parseScanRangeDatePart(raw, fallbackYear = new Date().getFullYear()) {
    const q = foldText(raw).trim();
    if (!q) return '';
    let m = q.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return isoDate(makeLocalDate(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    m = q.match(/^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2}|\d{4}))?$/);
    if (m) {
      let year = m[3] ? Number(m[3]) : Number(fallbackYear);
      if (year < 100) year += 2000;
      return isoDate(makeLocalDate(year, Number(m[2]) - 1, Number(m[1])));
    }
    return searchTargetDate(raw);
  }

  function parseCustomScanRange(input) {
    const raw = normalizeText(input).replace(/[–—]/g, '-').trim().replace(/^du\s+/i, '');
    if (!raw) return null;
    let parts = raw.split(/\s+(?:au|a|à|jusqu(?:'|’)au|->|→)\s+/i);
    if (parts.length !== 2) parts = raw.split(/\s+-\s+/);
    if (parts.length !== 2) return null;
    const now = new Date();
    const first = parseScanRangeDatePart(parts[0], now.getFullYear());
    const second = parseScanRangeDatePart(parts[1], first ? Number(first.slice(0,4)) : now.getFullYear());
    if (!first || !second) return null;
    const start = new Date(`${first}T00:00:00`), end = new Date(`${second}T23:59:59.999`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start.getTime() > end.getTime()) return null;
    const endToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    if (end.getTime() > endToday.getTime()) return { error: 'future' };
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    return { startIso: first, endIso: second, startTs: start.getTime(), endTs: end.getTime(), spanDays: Math.floor((end.getTime()-start.getTime())/86400000)+1, lookbackDays: Math.floor((todayStart.getTime()-start.getTime())/86400000)+1 };
  }

  function markRangeAudit(state, kind, orderId) {
    if (!state || !orderId) return;
    state.rangeAudit ||= { included: {}, unknown: {}, outside: {} };
    // Une commande peut d'abord être UNKNOWN sur l'historique, puis être datée sur
    // sa page détail. Elle doit alors CHANGER de bucket, pas être comptée deux fois.
    for (const name of ['included','unknown','outside']) {
      state.rangeAudit[name] ||= {};
      delete state.rangeAudit[name][orderId];
    }
    const bucket = kind === 'IN_RANGE' ? 'included' : kind === 'OUTSIDE' ? 'outside' : 'unknown';
    state.rangeAudit[bucket][orderId] = true;
    state.stats.rangeIncluded = Object.keys(state.rangeAudit.included || {}).length;
    state.stats.rangeUnknown = Object.keys(state.rangeAudit.unknown || {}).length;
    state.stats.rangeOutside = Object.keys(state.rangeAudit.outside || {}).length;
  }

  function validIsoOrderDate(value) {
    const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    const d = makeLocalDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d ? isoDate(d) : '';
  }

  function chooseKnownOrderDate(liveDate, cacheDate, serverDate) {
    return validIsoOrderDate(liveDate) || validIsoOrderDate(cacheDate) || validIsoOrderDate(serverDate) || '';
  }

  async function fetchKnownOrderDates(orderIds) {
    const ids = [...new Set((orderIds || []).filter(x => /^\d{3}-\d{7}-\d{7}$/.test(String(x || ''))))].slice(0, 250);
    if (!ids.length) return {};
    try {
      const r = await apiPost('getOrderDates', { orderIds: ids });
      return r && r.dates && typeof r.dates === 'object' ? r.dates : {};
    } catch (e) {
      log('Lookup dates Google indisponible, fallback pages détail', e);
      return {};
    }
  }

  function extractStatus(text) {
    const lines = normalizeText(text).split('\n').map(x => x.trim()).filter(Boolean);
    if (!lines.length) return '';

    // Phrases explicites décrivant l'état courant.
    for (const line of lines) {
      const f = foldText(line);
      if (isCarrierAttributionDeliveryPhrase(line)) continue;
      if (/(?:votre\s+(?:colis|commande)|le\s+colis).{0,90}(?:a ete|a été|est)\s+livre(?:e)?\b/.test(f)) return line.slice(0,220);
      if (/(?:votre\s+(?:colis|commande)|le\s+colis).{0,90}(?:a ete|a été|est)\s+expedie(?:e)?\b/.test(f)) return line.slice(0,220);
      if (/(?:votre\s+(?:colis|commande)|le\s+colis).{0,90}(?:est|sera)\s+en cours de livraison\b/.test(f)) return line.slice(0,220);
      if (/remis(?:e)?\s+(?:a|à|au)\s+(?:(?:la\s+)?(?:reception|réception)|concierge|destinataire)/i.test(line)) return line.slice(0,220);
    }

    const stageRe = /^(?:command[ée]|expédié|expédiée|en cours de livraison|(?:livré(?:e)?|livree)|pas encore expédié|pas encore expédiée|en préparation|commande reçue|annulé|annulée|retard|retardé|retardée)(?:\s|:|\-|$)/i;
    const exact = [];
    for (let i=0;i<lines.length;i++) {
      const line=lines[i];
      if (!stageRe.test(line) || /^command[ée](?:\s|$)/i.test(line)) continue;
      if (/^(?:livré(?:e)?|livree)\s+(?:par|avec)\s+amazon\b/i.test(line)) continue;
      // Amazon affiche parfois toute la progression (Commandé / Expédié / Livré).
      // Une étape nue « Livré » ne doit jamais devenir le statut courant.
      if (/^(?:livré(?:e)?|livree)(?:\s|:|-|$)/i.test(line) && !hasExplicitDeliveredEvidence(line)) continue;
      let descriptiveNeighbour=false;
      for (let j=i+1;j<Math.min(lines.length,i+3);j++) {
        const n=lines[j]; if(!n) continue;
        if (!stageRe.test(n) && n.length>=8 && !/^livraison prévue/i.test(n)) descriptiveNeighbour=true;
        break;
      }
      exact.push({line,i,descriptiveNeighbour});
    }
    const withDescription=exact.filter(x=>x.descriptiveNeighbour);
    if (withDescription.length) return withDescription[0].line.slice(0,220);
    if (exact.length===1) return exact[0].line.slice(0,220);
    const soft=lines.find(x=>/^(?:livraison prévue)(?:\s|$)|^(?:arriv(?:e|ée)e? aujourd)/i.test(x));
    return soft ? soft.slice(0,220) : '';
  }

  function hasExplicitDeliveredEvidence(text) {
    const raw = normalizeText(text);
    if (!raw) return false;
    const lines = raw.split('\n').map(x => x.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (hasDeliveredMarker(lines[i])) return true;
      // Amazon rend parfois « Livré » puis la date sur la ligne suivante.
      if (/^(?:livré(?:e)?|livree)$/i.test(lines[i]) && i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.length <= 70 && parseDateFromText(next, 'past') && !/livraison\s+prévue|exp[ée]di|command[ée]|suivi|tracking/i.test(next)) return true;
      }
    }
    return false;
  }

  function isDelivered(text) {
    return hasExplicitDeliveredEvidence(text);
  }

  function deliveredWithExpectedDateGuard(statusText, contextText = '', expectedDeliveryEnd = '') {
    const status = normalizeText(statusText || '');
    if (isExplicitNonDeliveredStatus(status)) return false;
    const evidenceText = normalizeText(`${status}\n${contextText || ''}`);
    return hasExplicitDeliveredEvidence(evidenceText);
  }

  function isExplicitNonDeliveredStatus(text) {
    const f = foldText(text);
    return /^(?:expedie|expediee|en cours de livraison|livraison prevue|pas encore expedie|pas encore expediee|en preparation|commande recue)(?:\s|$)/i.test(f);
  }

  function isCancelled(text) { return /(?:^|\n)\s*(?:annulé|annulée)(?:\s|$)|(?:commande|colis).{0,40}annul/i.test(normalizeText(text)); }
  function isPendingShipment(text) { return /pas encore expédi|en préparation|commande reçue|preparation de la commande/i.test(String(text || '')); }

  function deliveryDateFromLine(line, mode = 'future') {
    const f = foldText(line);
    if (/aujourd'hui|aujourdhui|today/.test(f)) return localNoon(0);
    if (/\bdemain\b|\btomorrow\b/.test(f)) return localNoon(1);
    if (/\bhier\b|\byesterday\b/.test(f)) return localNoon(-1);
    for (const name of Object.keys(WEEKDAYS)) {
      if (new RegExp(`\\b${name}\\b`, 'i').test(f)) return dateForWeekday(name, mode);
    }
    return parseDateFromText(line, mode);
  }

  function extractExpectedDeliveryRange(text) {
    const lines=deliveryRelevantLines(text), now=localNoon(0);
    const chooseFutureYear=(month,day)=>{ let y=now.getFullYear(); const d=makeLocalDate(y,month,day); if(d&&d.getTime()<now.getTime()-45*86400000)y++; return y; };
    const normalizeRangeYears=(aMonth,aDay,bMonth,bDay,explicitYear=null)=>{
      const y1=explicitYear||chooseFutureYear(aMonth,aDay); let y2=explicitYear||y1;
      const a=makeLocalDate(y1,aMonth,aDay); let b=makeLocalDate(y2,bMonth,bDay);
      if(!a||!b)return {a:null,b:null};
      if(b.getTime()<a.getTime()) b=makeLocalDate(y2+1,bMonth,bDay);
      return {a,b};
    };
    for(const line of lines){
      const f=foldText(line);
      if(!/livraison prevue|arriv|prevue|sera livre|devrait etre livre/.test(f))continue;
      // Plage avec année explicite de chaque côté, ex. 30 décembre 2026 au 2 janvier 2027.
      let m=f.match(/(?:du|entre\s+(?:le\s+)?)\s*(\d{1,2})\s+(janvier|janv|fevrier|fevr|mars|avril|avr|mai|juin|juillet|juil|aout|septembre|sept|octobre|oct|novembre|nov|decembre|dec)\s+(\d{4})\s+(?:au|et\s+(?:le\s+)?)\s*(\d{1,2})\s+(janvier|janv|fevrier|fevr|mars|avril|avr|mai|juin|juillet|juil|aout|septembre|sept|octobre|oct|novembre|nov|decembre|dec)\s+(\d{4})/i);
      if(m){const a=makeLocalDate(Number(m[3]),MONTHS[m[2]],Number(m[1])),b=makeLocalDate(Number(m[6]),MONTHS[m[5]],Number(m[4]));if(a&&b&&b.getTime()>=a.getTime())return {start:isoDate(a),end:isoDate(b),text:line.slice(0,180)};}
      m=f.match(/(?:entre\s+(?:le\s+)?|du\s+)(\d{1,2})\s+(?:et|au)\s+(?:le\s+)?(\d{1,2})\s+(janvier|janv|fevrier|fevr|mars|avril|avr|mai|juin|juillet|juil|aout|septembre|sept|octobre|oct|novembre|nov|decembre|dec)(?:\s+(\d{4}))?/i);
      if(m){ const {a,b}=normalizeRangeYears(MONTHS[m[3]],Number(m[1]),MONTHS[m[3]],Number(m[2]),m[4]?Number(m[4]):null); if(a&&b)return {start:isoDate(a),end:isoDate(b),text:line.slice(0,180)}; }
      m=f.match(/(?:du|entre\s+(?:le\s+)?)\s*(\d{1,2})\s+(janvier|janv|fevrier|fevr|mars|avril|avr|mai|juin|juillet|juil|aout|septembre|sept|octobre|oct|novembre|nov|decembre|dec)\s+(?:au|et\s+(?:le\s+)?)\s*(\d{1,2})\s+(janvier|janv|fevrier|fevr|mars|avril|avr|mai|juin|juillet|juil|aout|septembre|sept|octobre|oct|novembre|nov|decembre|dec)(?:\s+(\d{4}))?/i);
      if(m){ const {a,b}=normalizeRangeYears(MONTHS[m[2]],Number(m[1]),MONTHS[m[4]],Number(m[3]),m[5]?Number(m[5]):null); if(a&&b)return {start:isoDate(a),end:isoDate(b),text:line.slice(0,180)}; }
      const d=deliveryDateFromLine(line,'future'); if(d){const iso=isoDate(d);return {start:iso,end:iso,text:line.slice(0,180)};}
    }
    return {start:'',end:'',text:''};
  }

  function extractExpectedDelivery(text) { return extractExpectedDeliveryRange(text).start || ''; }

  function extractExpectedDeliveryText(text) { return extractExpectedDeliveryRange(text).text || ''; }

  function extractDeliveredDate(text) {
    // Réutilise les lignes contextualisées afin de gérer aussi
    // « Livré\n15 septembre » sans confondre une date d'expédition.
    for (const line of deliveryRelevantLines(text)) {
      if (!/(?:^|\b)(?:livré(?:e)?|livree)\s*[:\-]?|(?:votre\s+(?:colis|commande)|le\s+colis).{0,80}(?:a\s+été|a\s+ete|est)\s+(?:livré(?:e)?|livree?)/i.test(line)) continue;
      const d = deliveryDateFromLine(line, 'past');
      if (d) return isoDate(d);
    }
    return '';
  }

  function extractShipDate(text) {
    const s = normalizeText(text);
    const line = s.split('\n').find(x => /(?:expédié|expédiée)\s+(?:le|on)|date d['’]expédition/i.test(x));
    if (!line) return '';
    const d = parseDateFromText(line, 'past');
    return d ? isoDate(d) : '';
  }

  function detectCarrier(text, hrefs = []) {
    const all = `${text || ''}\n${hrefs.join('\n')}`;
    for (const [name, re] of CARRIERS) if (re.test(all)) return name;
    return '';
  }

  function cleanTrackingCandidate(v) {
    return String(v || '').trim().toUpperCase().replace(/^[#:\-\s]+|[#:\-\s]+$/g, '').replace(/\s+/g, '');
  }

  function isPlausibleTrackingId(value) {
    const v = cleanTrackingCandidate(value);
    if (!v || v.length < 8 || v.length > 40) return false;
    if (TRACKING_REJECT_WORDS.has(v)) return false;
    if (/^(?:INDISPONIBLE|INCONNU|CONSULTEZ|SUIVI|TRACKING|PACKAGE|COLIS|LIVRAISON|EXPEDIE|EXPEDITION|COMMANDE|ORDER|AMAZON|DETAIL|NUMERO|NUMBER|AUCUN|NONE|PROCHAINEMENT|BIENTOT|PENDING|ATTENTE|STATUS|STATUT|TRANSPORTEUR|CARRIER)/.test(v)) return false;
    if (/^\d{3}-?\d{7}-?\d{7}$/.test(v)) return false; // numéro de commande Amazon
    if (/^\d{4}[-/.]\d{2}[-/.]\d{2}$/.test(v)) return false;
    if (!/^[A-Z0-9-]+$/.test(v)) return false;
    if (!/\d/.test(v)) return false;
    // Des transporteurs français utilisent des références purement numériques de 8 chiffres (ex. Mondial Relay).
    if (/^\d+$/.test(v) && v.length < 8) return false;
    if (/^[A-Z]+$/.test(v)) return false;
    if (/^(\d)\1{7,}$/.test(v)) return false; // suites numériques manifestement factices (00000000…, 11111111…)
    return true;
  }

  function trackingCandidate(value, source, confidence) {
    const v = cleanTrackingCandidate(value);
    return isPlausibleTrackingId(v) ? { value: v, source, confidence } : null;
  }

  function isAuthoritativeTracking(trackingId, confidence, orderVerified = true, conflict = false) {
    return !!trackingCandidate(trackingId, 'verification', confidence || '')
      && String(confidence || '').toUpperCase() === 'HIGH'
      && orderVerified === true
      && conflict !== true;
  }

  function extractTrackingCandidate(root = document) {
    const bodyText=normalizeText(root.body?root.body.innerText:root.innerText||''), html=root.documentElement?root.documentElement.innerHTML:'';
    const labelPatterns=[/(?:num[ée]ro|n[°ºo]?|identifiant)\s*(?:de\s*)?suivi\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-]{6,40})/ig,/tracking\s*(?:id|number|no\.?)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-]{6,40})/ig];
    const labels=[]; for(const re of labelPatterns){let m;while((m=re.exec(bodyText))){const c=trackingCandidate(m[1],'label','HIGH');if(c)labels.push(c);}}
    const uniqueLabels=uniqBy(labels,x=>normalizeKey(x.value));
    if(uniqueLabels.length===1)return uniqueLabels[0];
    if(uniqueLabels.length>1)return {value:'',source:'multiple-labels',confidence:''};

    const urlCandidates=[];
    for(const a of Array.from(root.querySelectorAll?root.querySelectorAll('a[href]'):[])){if(!isKnownCarrierUrl(a.href))continue;const c=trackingCandidateFromUrl(a.href);if(c.value)urlCandidates.push(c);}
    const uniqueUrls=uniqBy(urlCandidates,x=>normalizeKey(x.value)); if(uniqueUrls.length===1)return uniqueUrls[0];

    const structured=[];
    const pats=[/["']tracking(?:Id|ID|Number)["']\s*:\s*["']([A-Z0-9-]{7,40})["']/ig,/tracking(?:Id|Number)%22?%3A%22([A-Z0-9-]{7,40})/ig];
    for(const re of pats){let m;while((m=re.exec(html))){const c=trackingCandidate(m[1],'structured','MEDIUM');if(c)structured.push(c);}}
    const uniqueStructured=uniqBy(structured,x=>normalizeKey(x.value)); if(uniqueStructured.length===1)return uniqueStructured[0];

    const knownRe=/\b(?:AZ[A-Z0-9]{8,28}|TBA\d{10,20}|1Z[A-Z0-9]{16}|[A-Z]{2}\d{9}[A-Z]{2}|FR\d{9,18})\b/i;
    const hit=bodyText.match(knownRe), c=hit?trackingCandidate(hit[0],'known-format-visible','MEDIUM'):null;
    return c||{value:'',source:'',confidence:''};
  }

  function extractTrackingId(root = document) {
    return extractTrackingCandidate(root).value || '';
  }

  function extractCarrierFromPage(root = document) {
    const text = normalizeText(root.body ? root.body.innerText : '');
    const hrefs = Array.from(root.querySelectorAll ? root.querySelectorAll('a[href]') : []).map(a => a.href);
    let carrier = detectCarrier(text, hrefs);
    if (carrier) return carrier;
    const html = root.documentElement ? root.documentElement.innerHTML : '';
    const m = html.match(/["']carrier(?:Name)?["']\s*:\s*["']([^"']{2,60})["']/i);
    return m ? normalizeText(m[1]) : '';
  }

  function asinFromUrl(url) {
    const m = String(url || '').match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    return m ? m[1].toUpperCase() : '';
  }

  function isExcludedProductNode(el) {
    if (!el?.closest) return false;
    return !!el.closest('#rhf, #navFooter, .a-carousel, [data-a-carousel-options], [cel_widget_id*="recommend" i], [data-csa-c-content-id*="recommend" i], .recommendations, .feed-carousel, .s-result-item');
  }

  function extractQuantityNear(el) {
    let n = el;
    for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
      const txt = normalizeText(n.innerText || '');
      const m = txt.match(/(?:quantit[ée]|qty|quantity)\s*[:x]?\s*(\d{1,3})/i);
      if (m) return Math.max(1, Number(m[1]) || 1);
      if (txt.length > 4000) break;
    }
    return 1;
  }

  function extractItems(root) {
    const byAsin = new Map();
    const nodes = Array.from(root?.querySelectorAll ? root.querySelectorAll('a[href], [data-asin]') : []);
    for (const el of nodes) {
      if (isExcludedProductNode(el)) continue;
      const href = el.href || el.getAttribute?.('href') || '';
      const asinRaw = (el.getAttribute && el.getAttribute('data-asin')) || asinFromUrl(href);
      const asin = String(asinRaw || '').toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) continue;
      let title = normalizeText(el.innerText || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '');
      if (!title && el.querySelector) {
        const img = el.querySelector('img[alt]');
        if (img) title = normalizeText(img.alt);
      }
      if (/^(acheter|voir|détails|details|image)$/i.test(title)) title = '';
      const productUrl = href ? absoluteUrl(href) : `https://www.amazon.fr/dp/${asin}`;
      const quantity = extractQuantityNear(el);
      const prev = byAsin.get(asin);
      const candidate = { asin, title: title.slice(0, 500), quantity, productUrl };
      if (!prev || candidate.title.length > prev.title.length || (!prev.productUrl && candidate.productUrl)) byAsin.set(asin, { ...(prev || {}), ...candidate });
      else if (quantity > (prev.quantity || 1)) prev.quantity = quantity;
    }
    return [...byAsin.values()];
  }

  function findOrderRoot(orderId) {
    if(!orderId)return document.querySelector('main')||document.body;
    const escaped=(window.CSS&&CSS.escape)?CSS.escape(orderId):orderId.replace(/"/g,'\\"');
    const direct=document.querySelector(`[data-order-id="${escaped}"]`); if(direct)return direct;
    const anchors=Array.from(document.querySelectorAll('a[href], [data-order-id], .order-card, .js-order-card')).filter(el=>parseOrderId(el.getAttribute?.('data-order-id')||'')===orderId||parseOrderId(urlFromElement(el))===orderId||normalizeText(el.innerText||'').includes(orderId));
    const candidates=[];
    for(const a of anchors){let n=a;for(let i=0;i<7&&n&&n!==document.body;i++,n=n.parentElement){const txt=normalizeText(n.innerText||'');if(!txt.includes(orderId)||txt.length<30||txt.length>60000)continue;const hasProduct=!!n.querySelector?.('a[href*="/dp/"], a[href*="/gp/product/"], [data-asin]');const hasTracking=trackLinks(n).length>0;if(hasProduct||hasTracking)candidates.push({el:n,len:txt.length});}}
    candidates.sort((a,b)=>a.len-b.len); return candidates[0]?.el||document.querySelector('main')||document.body;
  }

  function findMeaningfulContainer(el, orderId = '') {
    if (!el) return null;
    const preferred = el.closest?.('[data-shipment-id], .shipment, .a-box-group, .order, .order-card, .js-order-card, .a-box') || null;
    if (preferred && normalizeText(preferred.innerText).length < 80000) return preferred;
    let node = el;
    for (let i = 0; i < 8 && node && node !== document.body; i++, node = node.parentElement) {
      const txt = normalizeText(node.innerText), hasItem = !!node.querySelector?.('a[href*="/dp/"], a[href*="/gp/product/"]'), hasOrder = orderId ? txt.includes(orderId) : true;
      if (txt.length > 40 && txt.length < 50000 && (hasItem || hasOrder)) return node;
    }
    return null;
  }

  function urlFromElement(el) {
    if (!el) return '';
    const raw = el.href || el.getAttribute?.('href') || el.getAttribute?.('data-href') || el.getAttribute?.('data-url') || el.getAttribute?.('formaction') || '';
    if (!raw || /^javascript:/i.test(raw) || raw === '#') return '';
    return absoluteUrl(raw);
  }

  function isAmazonFrUrl(url) {
    try {
      const h = new URL(url, location.href).hostname.toLowerCase();
      return h === 'amazon.fr' || h.endsWith('.amazon.fr');
    } catch (_) { return false; }
  }

  function trackingCandidateFromUrl(url) {
    try {
      const u=new URL(url,location.href), knownCarrier=isKnownCarrierUrl(u.href), amazon=isAmazonFrUrl(u.href);
      const strong = ['trackingNumber','trackingId','trackingNo','piececode','parcelNumber','numeroExpedition','idColis','numeroColis','shipmentNumber'];
      const generic = ['parcel','parcelno','parcelId','number','numero','code','shipment','expedition'];
      const keys = amazon ? strong.slice(0,3) : knownCarrier ? [...strong, ...generic] : [];
      for (const key of keys) {
        const confidence = amazon || strong.includes(key) ? 'HIGH' : 'MEDIUM';
        const c=trackingCandidate(u.searchParams.get(key),`${amazon?'amazon':'carrier'}-url:${key}`,confidence);
        if(c)return c;
      }
    }catch(_){}
    return {value:'',source:'',confidence:''};
  }

  function isKnownCarrierUrl(url) {
    try {
      const h = new URL(url, location.href).hostname.toLowerCase();
      return /(?:laposte|colissimo|chronopost|ups\.|dhl\.|dpd\.|gls-|gls\.|colisprive|mondialrelay|relaiscolis|fedex|cainiao)/i.test(h);
    } catch (_) { return false; }
  }

  function trackLinks(root = document) {
    const out = [];
    const els = Array.from(root.querySelectorAll('a[href], [data-href], [data-url], button[formaction]'));
    for (const el of els) {
      const url = urlFromElement(el);
      const t = normalizeText(el.innerText || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '').toLowerCase();
      if (!url) continue;
      const labelled = /suivre (?:le|votre) colis|suivi (?:du )?colis|track package|tracking/i.test(t);
      const amazonTracking = isAmazonTrackingUrl(url);
      const externalTracking = !isAmazonFrUrl(url) && labelled && (isKnownCarrierUrl(url) || !!trackingCandidateFromUrl(url).value);
      // Un libellé ambigu sur Amazon ne suffit plus : l'URL Amazon doit appartenir
      // à l'allowlist de suivi. C'est ce qui interdit notamment cancel-items.
      if (!amazonTracking && !externalTracking) continue;
      const hint = trackingCandidateFromUrl(url);
      out.push({ el, url, external: !isAmazonFrUrl(url), trackingHint: hint.value || '', trackingHintSource: hint.source || '', trackingHintConfidence: hint.confidence || '' });
    }
    return uniqBy(out, x => {
      try {
        const u = new URL(x.url, location.href);
        const pkg = u.searchParams.get('packageIndex') || u.searchParams.get('package-index') || '';
        const sid = u.searchParams.get('shipmentId') || u.searchParams.get('shipmentID') || '';
        const item = u.searchParams.get('itemId') || u.searchParams.get('itemID') || '';
        // Ne pas fusionner deux liens progress-tracker distincts lorsque Amazon n'envoie que itemId.
        return `${u.hostname}|${u.pathname}|${pkg}|${sid}|${item}|${x.trackingHint || ''}`;
      } catch (_) { return x.url; }
    });
  }

  function unresolvedTrackControls(root = document) {
    const els = Array.from(root.querySelectorAll('a, button, [role="button"]'));
    return els.filter(el => {
      const t = normalizeText(el.innerText || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '').toLowerCase();
      if (!/suivre (?:le|votre) colis|suivi (?:du )?colis|track package/.test(t)) return false;
      return !urlFromElement(el);
    });
  }

  async function expandHistoryInPlace(maxClicksOverride = null) {
    const c = getConfig();
    const configured = maxClicksOverride == null ? c.maxHistoryExpandClicks : maxClicksOverride;
    const maxClicks = Math.max(0, Number(configured || 0));
    let clicks = 0;
    while (clicks < maxClicks) {
      const before = historyOrderCandidates(document).length;
      const controls = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const btn = controls.find(el => {
        const t = foldText(el.innerText || el.getAttribute?.('aria-label') || '');
        return /afficher plus|voir plus de commandes|charger plus|load more/.test(t) && !el.disabled;
      });
      if (!btn) break;
      try { btn.click(); } catch (_) { break; }
      clicks++;
      const changed = await waitUntil(() => historyOrderCandidates(document).length > before, 5000, 300);
      if (!changed) break;
      await sleep(500);
    }
    return clicks;
  }

  // V3.1 : Amazon Android peut rendre les cartes de commandes progressivement APRÈS
  // document.readyState=complete. On collecte donc l'union de plusieurs instantanés
  // et on n'analyse la page que lorsque le DOM est stable plusieurs fois de suite.
  function snapshotHistoryCandidates(candidates = historyOrderCandidates(document)) {
    return (candidates || []).map(rec => {
      const cardTexts = uniqBy((rec.cards || []).map(card => normalizeText(card?.innerText || '')).filter(Boolean), x => x);
      return {
        orderId: rec.orderId || '',
        url: rec.url || (rec.orderId ? canonicalOrderDetailUrl(rec.orderId) : ''),
        sourceUrl: rec.sourceUrl || '',
        historyTrackingUrls: uniqBy((rec.historyTrackingUrls || []).filter(Boolean), u => shipmentIdentityFromUrl(u, 1)),
        // V3.3.7.4 : conserver aussi les ASIN tant que la carte d'historique est
        // encore dans le DOM. Certaines pages /progress-tracker n'exposent ensuite
        // qu'une vignette produit sans href /dp/ ni data-asin, donc l'ASIN ne peut
        // plus être relu de manière fiable sur la page de suivi.
        historyItems: uniqBy((rec.cards || []).flatMap(card => extractItems(card)), x => x.asin || hashString(x.title)),
        cardTexts,
        // V3.3.6 : capture la date tant que nous avons encore le DOM vivant.
        // Les instantanés précédents ne conservaient que la sous-carte et perdaient
        // parfois l'en-tête de commande où Amazon affiche la date.
        orderDate: extractOrderDateFromLiveCandidate(rec, document),
      };
    }).filter(x => x.orderId);
  }

  function mergeHistoryCandidateSnapshots(targetMap, snapshots) {
    const map = targetMap instanceof Map ? targetMap : new Map();
    for (const rec of snapshots || []) {
      if (!rec?.orderId) continue;
      const old = map.get(rec.orderId) || {
        orderId: rec.orderId,
        url: canonicalOrderDetailUrl(rec.orderId),
        sourceUrl: '',
        historyTrackingUrls: [],
        historyItems: [],
        cardTexts: [],
        orderDate: '',
      };
      if (!old.sourceUrl && rec.sourceUrl) old.sourceUrl = rec.sourceUrl;
      if (rec.url) old.url = rec.url;
      old.historyTrackingUrls = uniqBy([...(old.historyTrackingUrls || []), ...(rec.historyTrackingUrls || [])].filter(Boolean), u => shipmentIdentityFromUrl(u, 1));
      old.historyItems = uniqBy([...(old.historyItems || []), ...(rec.historyItems || [])].filter(Boolean), x => x.asin || hashString(x.title));
      old.cardTexts = uniqBy([...(old.cardTexts || []), ...(rec.cardTexts || [])].filter(Boolean), x => x);
      if (!old.orderDate && rec.orderDate) old.orderDate = rec.orderDate;
      map.set(rec.orderId, old);
    }
    return map;
  }

  function historyDomHeight() {
    try {
      return Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
    } catch (_) { return 0; }
  }

  function historySnapshotSignature(snapshots, audit = null) {
    const ids = (snapshots || []).map(x => x.orderId).filter(Boolean).sort();
    const cards = Number(audit?.matchedCards || 0);
    const labels = Number(audit?.matchedLabels || 0);
    return `${ids.join('|')}::cards=${cards}::labels=${labels}::h=${historyDomHeight()}`;
  }

  function betterHistoryAudit(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    const score = x => [
      Number(x.resolvedOrders?.length || 0),
      Number(x.matchedCards || 0),
      Number(x.matchedLabels || 0),
      -Number(x.unresolvedCards || 0),
    ];
    const sa = score(a), sb = score(b);
    for (let i = 0; i < sa.length; i++) {
      if (sb[i] > sa[i]) return b;
      if (sb[i] < sa[i]) return a;
    }
    return a;
  }

  async function collectStableHistoryPage(searchQuery = '') {
    const c=getConfig(), pollMs=Math.max(250,Number(c.historyStablePollMs||450)), stableNeed=Math.max(2,Number(c.historyStableRounds||4)), maxMs=Math.max(7000,Number(c.historyStableMaxMs||18000));
    const maxProbes=Math.max(4,Number(c.maxHistoryScrollProbes||20));
    const start=Date.now(), union=new Map(); let lastSig='',stableRounds=0,samples=0,bestAudit=null,lastObservedCount=0,maxObservedCount=0,scrollProbeCount=0,noGrowthProbes=0;
    const initialY=Number(window.scrollY||0);
    while(Date.now()-start<maxMs){
      const live=historyOrderCandidates(document), snaps=snapshotHistoryCandidates(live); mergeHistoryCandidateSnapshots(union,snaps);
      const audit=searchQuery?searchAuditForCurrentHistoryPage(searchQuery,live):null; bestAudit=betterHistoryAudit(bestAudit,audit); samples++; lastObservedCount=snaps.length; maxObservedCount=Math.max(maxObservedCount,snaps.length);
      const sig=historySnapshotSignature(snaps,audit); if(sig===lastSig)stableRounds++;else{lastSig=sig;stableRounds=1;}

      if(stableRounds>=2&&scrollProbeCount<maxProbes){
        const beforeUnion=union.size,beforeHeight=historyDomHeight(); scrollProbeCount++;
        try{window.scrollTo(0,beforeHeight);}catch(_){}
        await sleep(Math.max(600,pollMs));
        const after=snapshotHistoryCandidates(historyOrderCandidates(document)); mergeHistoryCandidateSnapshots(union,after);
        const afterHeight=historyDomHeight(),grew=union.size>beforeUnion||afterHeight>beforeHeight;
        if(grew)noGrowthProbes=0;else noGrowthProbes++;
        lastSig='';stableRounds=0;
        if(noGrowthProbes>=3)break;
        continue;
      }
      if(scrollProbeCount>=1&&stableRounds>=stableNeed&&noGrowthProbes>=2)break;
      await sleep(pollMs);
    }
    try{window.scrollTo(0,initialY);}catch(_){}
    const candidates=[...union.values()];
    return {candidates,audit:bestAudit,diagnostics:{samples,stableRounds,elapsedMs:Date.now()-start,lastObservedCount,maxObservedCount,unionCount:candidates.length,scrollProbeCount,noGrowthProbes}};
  }

  function orderDetailLinks(root = document) {
    const links = [];
    const els = Array.from(root.querySelectorAll('a[href], [data-href], [data-url], button[formaction]'));
    for (const el of els) {
      const url = urlFromElement(el);
      if (!url || !isAmazonOrderDetailUrl(url)) continue;
      const orderId = parseOrderId(url) || parseOrderId(el.innerText) || parseOrderId(el.closest?.('.a-box, .order, .order-card, .js-order-card, [data-order-id]')?.innerText);
      if (orderId) links.push({ el, url, orderId });
    }
    return uniqBy(links, x => x.orderId);
  }

  function extractOrderIds(text) {
    const out = [];
    const re = /\b\d{3}-\d{7}-\d{7}\b/g;
    for (const m of String(text || '').matchAll(re)) out.push(m[0]);
    return [...new Set(out)];
  }

  function orderIdsFromElement(el) {
    if (!el) return [];
    const ids = new Set();
    const add = value => { for (const id of extractOrderIds(value)) ids.add(id); };
    try {
      add(el.innerText || '');
      add(urlFromElement(el)); // le nœud lui-même peut être le lien portant l'OrderID
      for (const attr of ['data-order-id','data-orderid','data-order-number','data-order-number-value']) add(el.getAttribute?.(attr) || '');
      const nodes = Array.from(el.querySelectorAll?.('[data-order-id],[data-orderid],[data-order-number],[data-order-number-value],a[href],[data-href],[data-url],button[formaction]') || []);
      for (const node of nodes) {
        for (const attr of ['data-order-id','data-orderid','data-order-number','data-order-number-value']) add(node.getAttribute?.(attr) || '');
        add(urlFromElement(node));
      }
    } catch (_) {}
    return [...ids];
  }

  function elementIsRendered(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      if (el.hidden || el.getAttribute?.('aria-hidden') === 'true') return false;
      // getClientRects() est le meilleur indicateur sur navigateur réel ; si indisponible, ne pas rejeter.
      if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0 && el.offsetParent === null && st.position !== 'fixed') return false;
    } catch (_) {}
    return true;
  }

  function findHistoryCardForElement(el, orderId = '') {
    if (!el) return null;
    const cardLike = /(?:^|\s)(?:order|order-card|js-order-card|shipment|package|delivery)(?:\s|$)/i;
    let fallback = null;
    let n = el.nodeType === 1 ? el : el.parentElement;
    for (let i = 0; i < 11 && n && n !== document.body; i++, n = n.parentElement) {
      const txt = normalizeText(n.innerText || '');
      if (!txt || txt.length > 18000) continue;
      const ids = orderIdsFromElement(n);
      const hasWanted = orderId ? ids.includes(orderId) : ids.length > 0;
      const hasTrackOrOrderLink = (() => {
        try {
          return Array.from(n.querySelectorAll('a[href],[data-href],[data-url],button[formaction]')).some(x => {
            const u = urlFromElement(x);
            return !!u && (isAmazonOrderDetailUrl(u) || isAmazonTrackingUrl(u));
          });
        } catch (_) { return false; }
      })();
      const cls = String(n.className || '');
      const looksCard = cardLike.test(cls) || /a-box(?:-group)?/i.test(cls) || /^(?:ARTICLE|LI)$/i.test(n.tagName || '') || n.getAttribute?.('role') === 'listitem';
      if (hasWanted && (hasTrackOrOrderLink || looksCard)) return n;
      if (!fallback && looksCard && (hasTrackOrOrderLink || deliveryRelevantLines(txt).length)) fallback = n;
    }
    return fallback || el.parentElement || el;
  }

  function historyOrderCandidates(root = document) {
    const map = new Map();
    const add = (orderId, el = null, sourceUrl = '', trackingUrl = '') => {
      if (!orderId) return;
      let rec = map.get(orderId);
      if (!rec) {
        rec = { orderId, url: canonicalOrderDetailUrl(orderId), sourceUrl: '', cards: [], historyTrackingUrls: [] };
        map.set(orderId, rec);
      }
      if (sourceUrl && !rec.sourceUrl) rec.sourceUrl = sourceUrl;
      if (trackingUrl) rec.historyTrackingUrls.push(trackingUrl);
      if (el) {
        const card = findHistoryCardForElement(el, orderId);
        if (card && !rec.cards.includes(card)) rec.cards.push(card);
      }
    };

    // 1) Liens de détail classiques.
    for (const link of orderDetailLinks(root)) add(link.orderId, link.el, link.url, '');

    // 2) Liens de suivi directs : ils contiennent souvent orderId même quand aucun lien détail n'est présent.
    for (const tr of trackLinks(root)) {
      const oid = parseOrderId(tr.url) || parseOrderId(tr.el?.innerText || '');
      if (oid) add(oid, tr.el, '', tr.url);
    }

    // 3) Attributs / URLs génériques contenant un OrderID.
    const els = Array.from(root.querySelectorAll?.('[data-order-id],[data-orderid],[data-order-number],[data-order-number-value],a[href],[data-href],[data-url],button[formaction]') || []);
    for (const el of els) {
      const ids = orderIdsFromElement(el);
      const u = urlFromElement(el);
      for (const oid of ids) add(oid, el, u, /ship-track|progress-tracker|track-package|package-tracking|tracking\/package/i.test(u || '') ? u : '');
    }

    for (const rec of map.values()) {
      rec.historyTrackingUrls = uniqBy(rec.historyTrackingUrls.filter(Boolean), u => shipmentIdentityFromUrl(u, 1));
      if (!rec.sourceUrl) rec.sourceUrl = rec.url;
    }
    return [...map.values()];
  }

  function searchAuditForCurrentHistoryPage(query, candidates = null) {
    const records = candidates || historyOrderCandidates(document);
    const orderCardMap = new Map();
    for (const rec of records) {
      for (const card of rec.cards || []) {
        const arr = orderCardMap.get(card) || new Set();
        arr.add(rec.orderId);
        orderCardMap.set(card, arr);
      }
    }

    const seedSelector = 'span, p, h1, h2, h3, h4, a, div';
    const rawSeeds = Array.from(document.querySelectorAll(seedSelector)).filter(el => {
      const txt = normalizeText(el.innerText || '');
      if (!txt || txt.length > 350) return false;
      if (!matchesDeliveryQuery(txt, query)) return false;
      // Le test de visibilité (getComputedStyle) est volontairement fait après le filtre texte,
      // pour ne pas ralentir les longues pages Amazon sur Android.
      return elementIsRendered(el);
    });
    // Ne garder que les éléments les plus profonds : évite de compter le même libellé dans un DIV parent + son SPAN enfant.
    const seeds = rawSeeds.filter(el => !rawSeeds.some(other => other !== el && el.contains?.(other)));

    const cards = [];
    const seenCards = new Set();
    for (const seed of seeds) {
      let card = findHistoryCardForElement(seed, '');
      if (!card) continue;
      // Si le premier conteneur ne donne aucun OrderID, élargir prudemment quelques niveaux.
      let ids = orderIdsFromElement(card);
      if (!ids.length) {
        let n = card.parentElement;
        for (let i = 0; i < 5 && n && n !== document.body; i++, n = n.parentElement) {
          const t = normalizeText(n.innerText || '');
          if (t.length > 22000) break;
          const widerIds = orderIdsFromElement(n);
          if (widerIds.length) { card = n; ids = widerIds; break; }
        }
      }
      if (seenCards.has(card)) continue;
      seenCards.add(card);
      const cardText = normalizeText(card.innerText || '');
      if (!matchesDeliveryQuery(cardText, query)) continue;
      cards.push({ card, orderIds: ids, text: cardText.slice(0, 700) });
    }

    // Inclure les cartes déjà identifiées par les candidats, même si le texte pertinent est dans un descendant inhabituel.
    for (const [card, idsSet] of orderCardMap.entries()) {
      if (seenCards.has(card)) continue;
      const txt = normalizeText(card.innerText || '');
      if (!matchesDeliveryQuery(txt, query)) continue;
      seenCards.add(card);
      cards.push({ card, orderIds: [...idsSet], text: txt.slice(0, 700) });
    }

    const resolvedOrders = new Set();
    const unresolved = [];
    for (const x of cards) {
      if (x.orderIds?.length) x.orderIds.forEach(id => resolvedOrders.add(id));
      else unresolved.push({ text: x.text });
    }
    return {
      matchedLabels: seeds.length,
      matchedCards: cards.length,
      resolvedCards: cards.length - unresolved.length,
      unresolvedCards: unresolved.length,
      resolvedOrders: [...resolvedOrders],
      unresolved: unresolved.slice(0, 12),
    };
  }

  function findOrderCard(link, orderId) {
    const selectors = ['[data-order-id]', '.order-card', '.js-order-card', '.order', '.a-box-group', '.a-box'];
    const p = link.el.closest?.(selectors.join(','));
    if (p && normalizeText(p.innerText).length < 70000) return p;
    let n = link.el;
    for (let i = 0; i < 8 && n && n !== document.body; i++, n = n.parentElement) {
      const txt = normalizeText(n.innerText);
      if (txt.includes(orderId) && txt.length < 70000) return n;
    }
    return link.el.parentElement || document.body;
  }


  function extractVineOrderDate(text) {
    const lines = normalizeText(text).split('\n').map(x => x.trim()).filter(Boolean);
    const marker = /(?:date\s+de\s+(?:la\s+)?commande|order\s+date)\b/i;
    for (let i = 0; i < lines.length; i++) {
      if (!marker.test(lines[i])) continue;
      for (let j = i; j <= Math.min(i + 2, lines.length - 1); j++) {
        const d = parseDateFromText(lines[j], 'past');
        if (d) return isoDate(d);
      }
    }
    return extractOrderDate(text);
  }

  function findVineOrderCardForElement(el, orderId = '') {
    if (!el) return null;
    let fallback = null;
    let n = el.nodeType === 1 ? el : el.parentElement;
    for (let i = 0; i < 12 && n && n !== document.body; i++, n = n.parentElement) {
      const txt = normalizeText(n.innerText || '');
      if (!txt || txt.length > 16000) continue;
      const ids = orderIdsFromElement(n);
      const hasWanted = !orderId || ids.includes(orderId);
      const hasOther = orderId && ids.some(x => x !== orderId);
      if (!hasWanted || hasOther) continue;
      const date = extractVineOrderDate(txt);
      if (date) return n;
      const cls = String(n.className || '');
      if (!fallback && (/(?:order|vvp|vine)/i.test(cls) || /^(?:ARTICLE|LI)$/i.test(n.tagName || '') || n.getAttribute?.('role') === 'listitem')) fallback = n;
    }
    return fallback || el.parentElement || el;
  }

  function vineOrderCandidates(root = document) {
    const map = new Map();
    for (const link of orderDetailLinks(root)) {
      const orderId = link.orderId;
      if (!orderId) continue;
      const card = findVineOrderCardForElement(link.el, orderId);
      const text = normalizeText(card?.innerText || link.el?.innerText || '');
      const orderDate = extractVineOrderDate(text);
      const rec = map.get(orderId) || {
        orderId,
        url: canonicalOrderDetailUrl(orderId),
        sourceUrl: link.url || canonicalOrderDetailUrl(orderId),
        orderDate: '',
        cardTexts: [],
        historyItems: [],
        historyTrackingUrls: [],
        card: null,
      };
      if (!rec.orderDate && orderDate) rec.orderDate = orderDate;
      if (text && !rec.cardTexts.includes(text)) rec.cardTexts.push(text);
      rec.historyItems = uniqBy([...(rec.historyItems || []), ...extractItems(card || link.el || root)], x => x.asin || hashString(x.title));
      if (!rec.card && card) rec.card = card;
      map.set(orderId, rec);
    }
    return [...map.values()];
  }

  function vineSnapshotSignature(candidates) {
    return (candidates || []).map(x => `${x.orderId}:${x.orderDate || '?'}`).join('|') + `::h=${historyDomHeight()}`;
  }

  async function collectStableVineOrdersPage() {
    const c = getConfig();
    const pollMs = Math.max(350, Number(c.historyStablePollMs || 550));
    const maxMs = Math.max(6000, Number(c.vineStableMaxMs || 10000));
    const maxProbes = Math.max(0, Math.min(8, Number(c.maxVineScrollProbes || 6)));
    const start = Date.now(), union = new Map();
    let lastSig = '', stableRounds = 0, samples = 0, scrollProbeCount = 0, noGrowthProbes = 0;
    const initialY = Number(window.scrollY || 0);
    while (Date.now() - start < maxMs) {
      const live = vineOrderCandidates(document); samples++;
      for (const rec of live) {
        const old = union.get(rec.orderId) || { ...rec, cardTexts: [], historyItems: [] };
        old.orderDate = old.orderDate || rec.orderDate || '';
        old.sourceUrl = old.sourceUrl || rec.sourceUrl || canonicalOrderDetailUrl(rec.orderId);
        old.cardTexts = uniqBy([...(old.cardTexts || []), ...(rec.cardTexts || [])], x => x);
        old.historyItems = uniqBy([...(old.historyItems || []), ...(rec.historyItems || [])], x => x.asin || hashString(x.title));
        union.set(rec.orderId, old);
      }
      const sig = vineSnapshotSignature(live);
      if (sig === lastSig) stableRounds++; else { lastSig = sig; stableRounds = 1; }
      if (stableRounds >= 2 && scrollProbeCount < maxProbes) {
        const beforeSize = union.size, beforeHeight = historyDomHeight();
        scrollProbeCount++;
        try { window.scrollTo(0, beforeHeight); } catch (_) {}
        await sleep(Math.max(650, pollMs));
        const after = vineOrderCandidates(document);
        for (const rec of after) if (!union.has(rec.orderId)) union.set(rec.orderId, rec);
        const grew = union.size > beforeSize || historyDomHeight() > beforeHeight;
        if (grew) noGrowthProbes = 0; else noGrowthProbes++;
        lastSig = ''; stableRounds = 0;
        if (noGrowthProbes >= 2) break;
        continue;
      }
      if (stableRounds >= 3 && (scrollProbeCount === 0 || noGrowthProbes >= 1)) break;
      await sleep(pollMs);
    }
    try { window.scrollTo(0, initialY); } catch (_) {}
    return { candidates: [...union.values()], diagnostics: { samples, elapsedMs: Date.now()-start, unionCount: union.size, scrollProbeCount, noGrowthProbes } };
  }

  function vineOrderDatesAreDescending(candidates) {
    const ts = (candidates || []).map(x => x.orderDate ? Date.parse(`${x.orderDate}T12:00:00`) : NaN).filter(Number.isFinite);
    if (ts.length < 2) return false;
    for (let i = 1; i < ts.length; i++) if (ts[i] > ts[i-1]) return false;
    return true;
  }

  function findNextVineOrdersUrl() {
    const candidates = Array.from(document.querySelectorAll('a[href]'));
    const next = candidates.find(a => {
      const t = foldText(a.innerText || a.getAttribute?.('aria-label') || '');
      const cls = `${a.className || ''} ${a.parentElement?.className || ''}`.toLowerCase();
      const url = absoluteUrl(a.href);
      if (!url || !isAmazonFrUrl(url)) return false;
      let u; try { u = new URL(url); } catch (_) { return false; }
      if (String(u.pathname || '').replace(/\/$/, '').toLowerCase() !== '/vine/orders') return false;
      if (a.getAttribute?.('aria-disabled') === 'true' || /a-disabled/.test(cls)) return false;
      return /^suivant$/.test(t) || /page suivante|next page/.test(t) || /(?:^|\s)a-last(?:\s|$)/.test(cls);
    });
    return next ? absoluteUrl(next.href) : '';
  }

  function vineOrdersNoOrdersMarker() {
    const txt = foldText(document.body?.innerText || '');
    return /aucune commande|vous n['’]?avez aucune commande|no orders|you have no orders/.test(txt);
  }

  function findNextHistoryUrl() {
    const candidates = Array.from(document.querySelectorAll('a[href]'));
    const next = candidates.find(a => {
      const t = normalizeText(a.innerText || a.getAttribute('aria-label') || '').toLowerCase();
      const cls = `${a.className || ''} ${a.parentElement?.className || ''}`.toLowerCase();
      const url = absoluteUrl(a.href);
      if (!url || !isAmazonFrUrl(url) || !/(?:order-history|your-orders|orderFilter|startIndex|pagination)/i.test(url)) return false;
      if (a.getAttribute?.('aria-disabled') === 'true' || /a-disabled/.test(cls)) return false;
      return /^suivant$/.test(t) || /page suivante|next page/.test(t) || /(?:^|\s)a-last(?:\s|$)/.test(cls);
    });
    return next ? absoluteUrl(next.href) : '';
  }

  function pageLooksLikeLoginOrChallenge() {
    const u = location.href.toLowerCase();
    const txt = normalizeText(document.body?.innerText || '').toLowerCase();
    return /\/ap\/signin|validatecaptcha|errors\/validatecaptcha/.test(u) || /saisissez les caractères|entrez les caractères|captcha|robot check|not a robot/.test(txt);
  }

  function pageLooksRateLimitedOrUnavailable() {
    const title = normalizeText(document.title || '').toLowerCase();
    const txt = normalizeText(document.body?.innerText || '').toLowerCase().slice(0, 6000);
    const probe = `${title}
${txt}`;
    return /too many requests|429 too many requests|service unavailable|503 service unavailable|temporarily unavailable|temporary unavailable|unusual traffic|trafic inhabituel|requêtes trop nombreuses|service temporairement indisponible/.test(probe);
  }

  function isRelevantAutomationPage() {
    return isHistoryPage() || isTrackingPage() || isOrderDetailPage();
  }

  function isVineOrdersPage() {
    try { return location.hostname.toLowerCase().endsWith('amazon.fr') && String(location.pathname || '').replace(/\/$/, '').toLowerCase() === '/vine/orders'; }
    catch (_) { return false; }
  }

  function isLegacyHistoryPage() {
    const u = location.href;
    return /(?:\/gp\/(?:your-account|css)\/order-history|\/your-orders(?:\/orders|\/order-history)?)(?:[?#/]|$)/i.test(u) && !/order-details|orderID=|orderId=/i.test(u);
  }

  function isHistoryPage() { return isVineOrdersPage() || isLegacyHistoryPage(); }
  function isTrackingPage() { return isAmazonTrackingUrl(location.href) || location.hostname.toLowerCase() === 'track.amazon.fr'; }
  function isOrderDetailPage() {
    return !isHistoryPage() && !isTrackingPage() && isAmazonOrderDetailUrl(location.href);
  }

  function extractOrderContextFromPage() {
    const text = normalizeText(document.body?.innerText || '');
    const orderId = parseOrderId(location.href) || parseOrderId(text);
    return { orderId, orderDate: extractOrderDate(text), status: extractStatus(text) };
  }

  function shipmentIdentityFromUrl(trackingUrl, index = 1) {
    try {
      const u = new URL(trackingUrl, location.href);
      const params = u.searchParams;
      const shipmentId = params.get('shipmentId') || params.get('shipmentID') || params.get('shipment-id');
      const packageIndex = params.get('packageIndex') || params.get('package-index');
      const itemId = params.get('itemId') || params.get('itemID') || params.get('item-id');
      // V3.3 : shipmentId est l'identité Amazon la plus stable disponible.
      // packageIndex n'est qu'un index d'affichage et peut se répéter.
      if (shipmentId) return `sid:${shipmentId}`;
      if (packageIndex !== null && packageIndex !== '') return `pkg:${packageIndex}`;
      if (itemId) return `item:${itemId}`;
      const clean = `${u.pathname}?${[...params.entries()].filter(([k]) => !/^(?:ref|ref_|tag|ascsubtag|linkcode|_encoding|vt|qid|source)$/i.test(k)).sort().map(([k,v]) => `${k}=${v}`).join('&')}`;
      return `url:${hashString(clean)}`;
    } catch (_) {
      return `idx:${index}`;
    }
  }

  function makeShipmentKey(account, orderId, trackingUrl, index) {
    return `${account}|${orderId || 'NOORDER'}|${shipmentIdentityFromUrl(trackingUrl, index)}`;
  }

  function resolvedShipmentIdentity(trackingUrl, trackingId, index = 1) {
    // Cette fonction n'est appelée avec trackingId que si le tracking est HIGH
    // et vérifié. Dans ce cas il devient la clé physique canonique.
    const tr = normalizeKey(trackingId || '');
    if (tr) return `trk:${tr}`;
    try {
      const u = new URL(trackingUrl, location.href);
      const sid = u.searchParams.get('shipmentId') || u.searchParams.get('shipmentID') || u.searchParams.get('shipment-id');
      const pkg = u.searchParams.get('packageIndex') || u.searchParams.get('package-index');
      const itemId = u.searchParams.get('itemId') || u.searchParams.get('itemID') || u.searchParams.get('item-id');
      if (sid) return `sid:${sid}`;
      if (pkg !== null && pkg !== '') return `pkg:${pkg}`;
      if (itemId) return `item:${itemId}`;
    } catch (_) {}
    return shipmentIdentityFromUrl(trackingUrl, index);
  }

  function makeResolvedShipmentKey(account, orderId, trackingUrl, trackingId, index) {
    return `${account}|${orderId || 'NOORDER'}|${resolvedShipmentIdentity(trackingUrl, trackingId, index)}`;
  }

  function cacheShipmentRank(key) {
    const k=String(key||'');
    if(/\|trk:/i.test(k))return 70;
    if(/\|sid:/i.test(k))return 60;
    if(/\|pkg:/i.test(k))return 50;
    if(/\|item:/i.test(k))return 30;
    if(/\|url:/i.test(k))return 20;
    return 10;
  }

  function canonicalizeCachedShipments(shipments = {}) {
    const groups=new Map();
    for(const [key,val0] of Object.entries(shipments||{})){
      const val={...(val0||{})};
      const tr=normalizeKey(val.trackingId||'');
      // Ne jamais fusionner le cache physique sur un tracking seulement probable.
      const mergeEligible = val.trackingVerified === true && tr;
      const gk=mergeEligible?`tracking:${tr}`:`key:${key}`;
      const arr=groups.get(gk)||[]; arr.push({key,val}); groups.set(gk,arr);
    }
    const out={};
    for(const arr of groups.values()){
      arr.sort((a,b)=>cacheShipmentRank(b.key)-cacheShipmentRank(a.key)||String(b.val.lastChecked||'').localeCompare(String(a.val.lastChecked||'')));
      const win=arr[0], merged={...win.val};
      for(const rec of arr.slice(1)){
        const v=rec.val||{};
        merged.trackingFound=merged.trackingFound===true||v.trackingFound===true;
        merged.trackingId=merged.trackingId||v.trackingId||'';
        merged.carrier=merged.carrier||v.carrier||'';
        merged.terminal=merged.terminal===true||v.terminal===true;
        const newer=!!v.lastChecked&&(!merged.lastChecked||String(v.lastChecked)>String(merged.lastChecked));
        if(newer){merged.lastChecked=v.lastChecked;merged.delivered=v.delivered===true;if(v.status)merged.status=v.status;}
      }
      out[win.key]=merged;
    }
    return out;
  }

  function canonicalShipmentCount(shipments = {}) { return Object.keys(canonicalizeCachedShipments(shipments)).length; }

  function validateWebAppUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && /script\.google\.com$/i.test(u.hostname) && /\/macros\/s\/.+\/exec$/i.test(u.pathname);
    } catch (_) { return false; }
  }

  function validateRelayUrl(url) {
    try {
      const u = new URL(String(url || '').trim());
      return u.protocol === 'https:' && (u.hostname === 'workers.dev' || u.hostname.endsWith('.workers.dev')) && /\/vine-tracking\/?$/i.test(u.pathname);
    } catch (_) { return false; }
  }

  function relayConfigured(c = getConfig()) {
    return !!(validateRelayUrl(c.relayUrl) && String(c.relayToken || '').trim());
  }

  function transportStateKey(account = getConfig().account) {
    return TRANSPORT_STATE_KEY_PREFIX + String(account || 'UNKNOWN').trim().toUpperCase();
  }

  function getTransportState(account = getConfig().account) {
    const raw = GM_getValue(transportStateKey(account), {});
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? { preferRelayUntil:0, lastUsed:'', lastDirectFailAt:0, lastRelayFailAt:0, lastOkAt:0, ...raw }
      : { preferRelayUntil:0, lastUsed:'', lastDirectFailAt:0, lastRelayFailAt:0, lastOkAt:0 };
  }

  function saveTransportState(state, account = getConfig().account) {
    GM_setValue(transportStateKey(account), { ...state });
  }

  function resetTransportState(account = getConfig().account) {
    GM_deleteValue(transportStateKey(account));
  }

  function transportLabel(transport = getTransportState().lastUsed) {
    return transport === 'relay' ? 'relais Cloudflare' : transport === 'direct' ? 'Google direct' : 'non testé';
  }

  function apiTimeoutForAction(action) {
    const a = String(action || '');
    // V3.3.7.17 : délais réseau plus courts. Le buffer local est persistant et les
    // écritures sont idempotentes, donc il vaut mieux reprendre que sembler figé.
    if (a === 'upsertBatch') return 25000;
    if (a === 'finalizeSync') return 20000;
    if (a === 'clientLog' || a === 'deviceHeartbeat') return 12000;
    if (a === 'ping' || a === 'getOrderDates' || a === 'getScanStats' || a === 'getSmartCache') return 15000;
    return 20000;
  }

  function makeApiError(message, { code = '', retryable = false, transport = '', transportFailure = false } = {}) {
    const err = new Error(String(message || 'Erreur API'));
    err.code = String(code || '');
    err.retryable = retryable === true;
    err.transport = transport;
    err.transportFailure = transportFailure === true;
    return err;
  }

  function apiPostTransport(action, data = {}, transport = 'direct') {
    const c = getConfig();
    if (!c.webAppUrl || !c.apiSecret) return Promise.reject(makeApiError('Google Apps Script non configuré'));
    if (!validateWebAppUrl(c.webAppUrl)) return Promise.reject(makeApiError('URL Apps Script invalide : utilise bien l’URL /exec du déploiement'));
    if (transport === 'relay' && !relayConfigured(c)) return Promise.reject(makeApiError('Relais Cloudflare non configuré', { code:'RELAY_NOT_CONFIGURED', transport:'relay' }));

    // En direct, le téléphone envoie l'API_SECRET à Apps Script. Via le relais,
    // le secret n'est PAS transmis par le téléphone : le Worker injecte son
    // secret VT_API_SECRET côté Cloudflare avant de joindre Apps Script.
    const payloadObj = { ...data, action, account: c.account, version: VERSION };
    if (transport === 'direct') payloadObj.secret = c.apiSecret;
    const url = transport === 'relay' ? String(c.relayUrl || '').trim() : c.webAppUrl;
    const headers = { 'Content-Type': 'text/plain;charset=UTF-8' };
    if (transport === 'relay') headers['X-VT-Relay-Token'] = String(c.relayToken || '').trim();

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers,
        data: JSON.stringify(payloadObj),
        timeout: apiTimeoutForAction(action),
        anonymous: transport === 'relay',
        onload: r => {
          let obj;
          try { obj = JSON.parse(r.responseText || '{}'); }
          catch (_) {
            reject(makeApiError(`${transport === 'relay' ? 'Réponse relais' : 'Réponse Apps Script'} illisible (HTTP ${r.status})`, { transport, transportFailure:true }));
            return;
          }
          if (r.status >= 200 && r.status < 300 && obj.ok !== false) {
            try { Object.defineProperty(obj, '__transport', { value:transport, enumerable:false, configurable:true }); } catch (_) { obj.__transport = transport; }
            resolve(obj);
            return;
          }
          const code = String(obj.code || (obj.error === 'SOURCE_BUSY' ? 'SOURCE_BUSY' : ''));
          const relayTransportFailure = transport === 'relay' && /^(?:RELAY_UPSTREAM_NETWORK|RELAY_UPSTREAM_TIMEOUT)$/i.test(code);
          reject(makeApiError(obj.error || `HTTP ${r.status}`, {
            code,
            retryable: obj.retryable === true || code === 'SOURCE_BUSY',
            transport,
            transportFailure: relayTransportFailure,
          }));
        },
        onerror: () => reject(makeApiError(transport === 'relay' ? 'Erreur réseau vers relais Cloudflare' : 'Erreur réseau vers Apps Script', { transport, transportFailure:true })),
        ontimeout: () => reject(makeApiError(transport === 'relay' ? 'Timeout relais Cloudflare' : 'Timeout Apps Script', { transport, transportFailure:true })),
      });
    });
  }

  async function apiPostOnce(action, data = {}) {
    const c = getConfig();
    const relayOk = relayConfigured(c);
    const ts = getTransportState(c.account);
    const preferRelay = relayOk && Number(ts.preferRelayUntil || 0) > Date.now();
    const first = preferRelay ? 'relay' : 'direct';
    const second = first === 'direct' ? 'relay' : 'direct';

    try {
      const result = await apiPostTransport(action, data, first);
      const next = { ...ts, lastUsed:first, lastOkAt:Date.now() };
      if (first === 'direct') next.preferRelayUntil = 0;
      saveTransportState(next, c.account);
      return result;
    } catch (firstErr) {
      const directFailed = first === 'direct' && firstErr?.transportFailure === true;
      const relayFailed = first === 'relay' && firstErr?.transportFailure === true;
      const relayConfigProblem = first === 'relay' && /^RELAY_/.test(String(firstErr?.code || '')) && String(firstErr?.code || '') !== 'RELAY_UPSTREAM_NETWORK';
      const next = { ...ts };
      if (directFailed) {
        next.lastDirectFailAt = Date.now();
        next.preferRelayUntil = Date.now() + Math.max(5, Number(c.relayPreferMinutes || 30)) * 60 * 1000;
      }
      if (relayFailed || relayConfigProblem) next.lastRelayFailAt = Date.now();
      saveTransportState(next, c.account);

      // Ne bascule vers l'autre transport que pour un problème de transport/réseau
      // (ou une erreur propre au relais). Une erreur métier Apps Script (secret,
      // version, validation, SOURCE_BUSY...) reste telle quelle et n'est pas doublée.
      const mayFallback = second === 'relay'
        ? (relayOk && directFailed)
        : (first === 'relay' && (relayFailed || relayConfigProblem));
      // A timed-out write may still be running on Google. Never duplicate it immediately.
      if (action === 'upsertBatch' || !mayFallback) throw firstErr;

      try {
        const result = await apiPostTransport(action, data, second);
        const finalState = getTransportState(c.account);
        finalState.lastUsed = second;
        finalState.lastOkAt = Date.now();
        if (second === 'direct') finalState.preferRelayUntil = 0;
        saveTransportState(finalState, c.account);
        return result;
      } catch (secondErr) {
        const finalState = getTransportState(c.account);
        if (second === 'direct' && secondErr?.transportFailure) finalState.lastDirectFailAt = Date.now();
        if (second === 'relay' && (secondErr?.transportFailure || /^RELAY_/.test(String(secondErr?.code || '')))) finalState.lastRelayFailAt = Date.now();
        saveTransportState(finalState, c.account);
        const combined = makeApiError(`${firstErr.message} ; secours ${second === 'relay' ? 'Cloudflare' : 'direct'}: ${secondErr.message}`, {
          code: secondErr.code || firstErr.code || '',
          retryable: secondErr.retryable === true || firstErr.retryable === true,
          transport: second,
          transportFailure: secondErr.transportFailure === true,
        });
        throw combined;
      }
    }
  }

  async function apiPost(action, data = {}) {
    if (action === 'upsertBatch') return apiPostOnce(action, data);
    const c = getConfig();
    const normalAttempts = Math.max(1, Math.min(2, Number(c.apiRetries || 2)));
    const busyAttempts = (action === 'upsertBatch' || action === 'finalizeSync') ? 4 : normalAttempts;
    let lastErr;
    for (let i = 1; i <= busyAttempts; i++) {
      try { return await apiPostOnce(action, data); }
      catch (e) {
        lastErr = e;
        const busy = String(e?.code || '') === 'SOURCE_BUSY';
        const allowedAttempts = busy ? busyAttempts : normalAttempts;
        log(`API tentative ${i}/${allowedAttempts} échouée`, e);
        if (i >= allowedAttempts) break;
        const waitMs = busy
          ? Math.min(7000, 1800 * i) + Math.floor(Math.random() * 500)
          : 900 * Math.pow(2, i - 1) + Math.floor(Math.random() * 500);
        await sleep(waitMs);
      }
    }
    throw lastErr || new Error('Échec Apps Script');
  }

  async function waitUntil(testFn, timeoutMs, stepMs = 350) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try { if (testFn()) return true; } catch (_) {}
      await sleep(stepMs);
    }
    try { return !!testFn(); } catch (_) { return false; }
  }

  async function waitForCurrentPageReady(kind, expectedOrderId = '') {
    const max = Math.max(2500, Number(getConfig().waitReadyMs || 10000));
    if (document.readyState !== 'complete') await waitUntil(() => document.readyState === 'complete', Math.min(5000, max));
    let ok = true;
    if (kind === 'history') ok = await waitUntil(() => (isVineOrdersPage() ? vineOrderCandidates(document).length > 0 || vineOrdersNoOrdersMarker() : historyOrderCandidates(document).length > 0 || /aucune commande|no orders/i.test(document.body?.innerText || '')), max);
    else if (kind === 'details') ok = await waitUntil(() => parseOrderId(location.href) || parseOrderId(document.body?.innerText || '') || trackLinks(document).length > 0, max);
    else if (kind === 'tracking') ok = await waitUntil(() => {
      const body = document.body?.innerText || '';
      const urlOid = parseOrderId(location.href);
      const validUrlContext = isTrackingPage() && (!expectedOrderId || !urlOid || urlOid === expectedOrderId);
      return validUrlContext || extractTrackingId(document) || extractStatus(body) || /suivi|tracking|colis|package/i.test(body);
    }, max);
    if (!ok) throw new Error(`Délai dépassé : page ${kind} incomplète/non reconnue après ${Math.round(max/1000)} s`);
    return true;
  }


  function domStructureSnapshot(kind, expectedOrderId = '') {
    const urlOrderId = parseOrderId(location.href);
    if (kind === 'details') {
      const root = findOrderRoot(expectedOrderId) || document;
      const tracks = trackLinks(root).filter(tr => trackingUrlMatchesOrder(tr.url, expectedOrderId));
      const items = extractItems(root).filter(it => !!it.asin);
      const unresolved = unresolvedTrackControls(root).length;
      const visibleOrderId = urlOrderId || parseOrderId(root?.innerText || '') || parseOrderId(document.body?.innerText || '');
      const orderVerified = !!expectedOrderId && visibleOrderId === expectedOrderId;
      const signature = JSON.stringify({ orderVerified, tracks:tracks.map(x=>shipmentIdentityFromUrl(x.url,1)).sort(), asins:items.map(x=>x.asin).sort(), unresolved });
      return { signature, useful:orderVerified && (tracks.length>0 || items.length>0 || unresolved>0), counts:{tracks:tracks.length,asins:items.length,unresolved}, orderVerified };
    }
    if (kind === 'tracking') {
      const candidate = extractTrackingCandidate(document);
      const body = document.body?.innerText || '';
      const ids = extractOrderIds(body);
      const orderVerified = urlOrderId === expectedOrderId || (!urlOrderId && ids.includes(expectedOrderId));
      const status = extractStatus(body);
      const range = extractExpectedDeliveryRange(body);
      const signature = JSON.stringify({ orderVerified, tracking:candidate.value||'', confidence:candidate.confidence||'', status:status||'', start:range.start||'', end:range.end||'' });
      // HIGH + OrderID vérifié suffit pour lire immédiatement le suivi. Un statut/date
      // structuré permet aussi de court-circuiter l'attente si le tracking n'existe pas.
      const authoritative = orderVerified && candidate.value && candidate.confidence === 'HIGH';
      const useful = authoritative || (orderVerified && (!!status || !!range.start));
      return { signature, useful, authoritative, orderVerified, counts:{tracking:candidate.value?1:0,status:status?1:0,delivery:range.start?1:0} };
    }
    return { signature:'', useful:false, counts:{} };
  }

  async function waitForFastDomStructure(kind, expectedOrderId = '') {
    const c = getConfig();
    const poll = Math.max(150, Number(c.domFastPollMs || 300));
    const rounds = Math.max(2, Number(c.domFastStableRounds || 3));
    const maxMs = Math.max(2400, Number(c.domFastMaxMs || 3200));
    const nonAuthoritativeMinMs = Math.max(1800, Number(c.domFastNonAuthoritativeMinMs || 2200));
    const start = Date.now();
    let last = domStructureSnapshot(kind, expectedOrderId), samples = 1;
    // Le fast-path ne doit jamais rallonger une page pauvre. S'il n'y a pas déjà
    // de balise utile au premier rendu, on bascule immédiatement vers le moteur
    // borné historique qui sait attendre le rendu JavaScript d'Amazon.
    if (!last.useful) return { ready:false, reason:'dom-insufficient-initial', samples, elapsedMs:0, counts:last.counts || {} };
    let lastSig = last.signature || '', stable = 1;
    while (Date.now() - start < maxMs) {
      const need = last.authoritative ? 2 : rounds;
      const elapsed=Date.now()-start;
      if (stable >= need && (last.authoritative || elapsed >= nonAuthoritativeMinMs)) return { ready:true, reason:last.authoritative?'dom-authoritative-tracking':'dom-structure-stable-minwait', samples, elapsedMs:elapsed, counts:last.counts };
      await waitForDomMutationOrTimeout(poll);
      last = domStructureSnapshot(kind, expectedOrderId); samples++;
      if (!last.useful) return { ready:false, reason:'dom-became-insufficient', samples, elapsedMs:Date.now()-start, counts:last.counts || {} };
      if (last.signature && last.signature === lastSig) stable++; else { lastSig=last.signature; stable=1; }
    }
    return { ready:false, reason:'dom-unstable', samples, elapsedMs:Date.now()-start, counts:last?.counts || {} };
  }

  function semanticPageSnapshot(kind, expectedOrderId = '') {
    const text = normalizeText(document.body?.innerText || '');
    if (kind === 'details') {
      const root = findOrderRoot(expectedOrderId) || document;
      const ids = extractOrderIds(`${location.href}\n${text}`).filter(Boolean).sort();
      const tracks = trackLinks(root).map(x => `${shipmentIdentityFromUrl(x.url, 1)}:${normalizeKey(x.trackingHint || '')}`).sort();
      const asins = extractItems(root).map(x => x.asin).filter(Boolean).sort();
      const unresolved = unresolvedTrackControls(root).length;
      const status = extractStatus(text);
      const orderDate = extractOrderDate(text);
      return {
        signature: JSON.stringify({ ids, tracks, asins, unresolved, status, orderDate }),
        meaningful: ids.includes(expectedOrderId) || tracks.length > 0 || asins.length > 0 || !!status,
        counts: { ids: ids.length, tracks: tracks.length, asins: asins.length, unresolved }
      };
    }
    if (kind === 'tracking') {
      const ids = extractOrderIds(`${location.href}\n${text}`).filter(Boolean).sort();
      const candidate = extractTrackingCandidate(document);
      const status = extractStatus(text);
      const carrier = extractCarrierFromPage(document);
      const range = extractExpectedDeliveryRange(text);
      // Ne pas inclure les recommandations produits de la page de suivi dans la
      // signature de stabilité: elles peuvent se charger en différé sans changer
      // le colis lui-même.
      return {
        signature: JSON.stringify({ ids, tracking: candidate.value || '', source: candidate.source || '', confidence: candidate.confidence || '', status, carrier, start: range.start || '', end: range.end || '' }),
        meaningful: ids.includes(expectedOrderId) || !!candidate.value || !!status || !!range.start,
        counts: { ids: ids.length, tracking: candidate.value ? 1 : 0 }
      };
    }
    return { signature: '', meaningful: true, counts: {} };
  }

  async function waitForStableSemanticPage(kind, expectedOrderId = '') {
    if (!['details','tracking'].includes(kind)) return { stable: true, samples: 0, elapsedMs: 0 };
    const c = getConfig();
    const poll = Math.max(250, Number(c.pageStablePollMs || 450));
    const need = Math.max(2, Number(c.pageStableRounds || 4));
    const minMs = Math.max(800, Number(c.pageStableMinMs || 1800));
    const maxMs = Math.max(minMs + 1500, Number(c.pageStableMaxMs || 18000));
    const start = Date.now();
    let lastSig = '', stable = 0, samples = 0, lastSnap = null, scrolled = false;
    const initialY = Number(window.scrollY || 0);
    while (Date.now() - start < maxMs) {
      const snap = semanticPageSnapshot(kind, expectedOrderId);
      lastSnap = snap; samples++;
      if (snap.signature && snap.signature === lastSig) stable++; else { lastSig = snap.signature; stable = 1; }
      const elapsed = Date.now() - start;
      if (!scrolled && elapsed >= Math.min(1200, Math.floor(minMs * 0.7))) {
        scrolled = true;
        try { window.scrollTo(0, Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0)); } catch (_) {}
        await waitForDomMutationOrTimeout(Math.max(350, poll));
        try { window.scrollTo(0, initialY); } catch (_) {}
        lastSig = ''; stable = 0;
        continue;
      }
      if (elapsed >= minMs && snap.meaningful && stable >= need) return { stable: true, samples, elapsedMs: elapsed, counts: snap.counts };
      await waitForDomMutationOrTimeout(poll);
    }
    try { window.scrollTo(0, initialY); } catch (_) {}
    throw new Error(`Page ${kind} non stabilisée après ${Math.round((Date.now()-start)/1000)} s (${samples} contrôles, ${JSON.stringify(lastSnap?.counts || {})})`);
  }

  async function waitForBoundedTrackingPage(expectedOrderId = '', priorityMode = false) {
    // Une URL de suivi Amazon correctement corrélée à l'OrderID est une page valide
    // même si Amazon n'affiche encore ni statut ni numéro de suivi. Dans ce cas on
    // attend un temps borné puis on passe au colis suivant SANS reload automatique.
    // Cela corrige le blocage observé sur itemId=onqmkpqtmirtoo en scan 7/15/30 normal.
    const c = getConfig();
    const poll = Math.max(300, Number(priorityMode ? (c.priorityTrackingPollMs || 400) : (c.trackingPollMs || 450)));
    const minNoTrackMs = Math.max(3000, Number(priorityMode ? (c.priorityTrackingStableMinMs || 4000) : (c.trackingStableMinMs || 5200)));
    const maxMs = Math.max(minNoTrackMs + 1800, Number(priorityMode ? (c.priorityTrackingMaxMs || 9000) : (c.trackingMaxMs || 12000)));
    const minFoundMs = priorityMode ? 1200 : 2800;
    const start = Date.now();
    let lastSig = '', stable = 0, samples = 0, lastSnap = null;
    while (Date.now() - start < maxMs) {
      if (pageLooksLikeLoginOrChallenge()) return { stable:false, priority:priorityMode, reason:'challenge', samples, elapsedMs:Date.now()-start, counts:lastSnap?.counts || {} };
      if (pageLooksRateLimitedOrUnavailable()) return { stable:false, priority:priorityMode, reason:'rate-limited', samples, elapsedMs:Date.now()-start, counts:lastSnap?.counts || {} };
      const snap = semanticPageSnapshot('tracking', expectedOrderId);
      const candidate = extractTrackingCandidate(document);
      const text = normalizeText(document.body?.innerText || '');
      const urlOrderId = parseOrderId(location.href);
      const ids = extractOrderIds(text);
      const orderVerified = urlOrderId === expectedOrderId || (!urlOrderId && ids.includes(expectedOrderId));
      lastSnap = snap; samples++;
      if (snap.signature && snap.signature === lastSig) stable++; else { lastSig = snap.signature; stable = 1; }
      const elapsed = Date.now() - start;
      if (candidate.value && orderVerified && elapsed >= minFoundMs && stable >= 2) {
        return { stable:true, priority:priorityMode, reason:'tracking-found', samples, elapsedMs:elapsed, counts:snap.counts };
      }
      // Aucune auto-navigation/scroll ici : le suivi et l'ASIN mémorisé suffisent.
      // Évite aussi de déclencher inutilement le chargement de recommandations.
      if (elapsed >= minNoTrackMs && orderVerified && stable >= 3) {
        return { stable:true, priority:priorityMode, reason:candidate.value?'tracking-stable':'no-tracking-stable', samples, elapsedMs:elapsed, counts:snap.counts };
      }
      await waitForDomMutationOrTimeout(poll);
    }
    const urlOrderId = parseOrderId(location.href);
    const orderVerified = urlOrderId === expectedOrderId || (!urlOrderId && extractOrderIds(document.body?.innerText || '').includes(expectedOrderId));
    return { stable:orderVerified, priority:priorityMode, reason:orderVerified?'timeout-valid-page':'timeout-unverified-order', samples, elapsedMs:Date.now()-start, counts:lastSnap?.counts || {} };
  }

  async function waitForPriorityTrackingPage(expectedOrderId = '') {
    return waitForBoundedTrackingPage(expectedOrderId, true);
  }

  function mergeBuffer(state, shipments = [], items = []) {
    state.buffer ||= { shipments: [], items: [] };
    const sm = new Map(state.buffer.shipments.map(x => [x.shipmentKey, x]));
    for (const x of shipments) sm.set(x.shipmentKey, { ...(sm.get(x.shipmentKey) || {}), ...x });
    state.buffer.shipments = [...sm.values()];
    const im = new Map(state.buffer.items.map(x => [x.itemKey, x]));
    for (const x of items) im.set(x.itemKey, { ...(im.get(x.itemKey) || {}), ...x });
    state.buffer.items = [...im.values()];
    saveState(state);
  }

  function nextMicroBatch(buffer) {
    const shipments = (buffer.shipments || []).slice(0, 8);
    const selected = new Set(shipments.map(x=>x.shipmentKey));
    const waiting = new Set((buffer.shipments || []).map(x=>x.shipmentKey));
    // Prioritize matching articles; never send articles ahead of their pending parent.
    const related = (buffer.items || []).filter(x=>selected.has(x.shipmentKey));
    const alreadySent = (buffer.items || []).filter(x=>!waiting.has(x.shipmentKey));
    return {shipments, items:[...related,...alreadySent].slice(0,24)};
  }
  function acknowledgeMicroBatch(buffer, batch) {
    const unchanged = (x, rows, key) => rows.some(y=>y[key]===x[key] && JSON.stringify(y)===JSON.stringify(x));
    buffer.shipments=(buffer.shipments||[]).filter(x=>!unchanged(x,batch.shipments,'shipmentKey'));
    buffer.items=(buffer.items||[]).filter(x=>!unchanged(x,batch.items,'itemKey'));
  }
  function deferGoogleSync(state, error) {
    const sync=state.googleSync ||= {};
    sync.failures=Number(sync.failures||0)+1;
    const delay=Math.min(600000,60000*Math.pow(2,Math.min(4,sync.failures-1)));
    sync.nextAttemptAt=Date.now()+delay;
    sync.lastError=String(error?.message||error||'Google indisponible');
    state.lastMessage=`Google temporairement indisponible — données conservées localement — ${state.phase==='done'?'collecte Amazon terminée':'scan Amazon continue'}. Réessai dans ${Math.round(delay/60000)} min (${sync.lastError}).`;
    delete state.operation;
    saveState(state);
  }
  function scheduleFinalGoogleRetry(state, delayMs) {
    if(googleRetryTimer) clearTimeout(googleRetryTimer);
    const scanId=state.scanId;
    // Short ticks survive foregrounding without a long blocking wait.
    googleRetryTimer=setTimeout(()=>{
      googleRetryTimer=null;
      const latest=getState();
      if(!latest?.active || latest.paused || latest.scanId!==scanId || latest.phase!=='done') return;
      const remaining=Number(latest.googleSync?.nextAttemptAt||0)-Date.now();
      if(remaining>0) { scheduleFinalGoogleRetry(latest,remaining); return; }
      void resumeScan();
    },Math.max(1000,Math.min(60000,delayMs||1000)));
  }
  async function flushBuffer(state, force = false) {
    state.buffer ||= {shipments:[],items:[]};
    if (!stateAccountIsCurrent(state)) { pauseForAccountMismatch(state); throw new Error('Contexte compte/serveur modifié pendant le scan'); }
    if(googleFlushInFlight || Date.now()<Number(state.googleSync?.nextAttemptAt||0)) return false;
    if(!force && state.buffer.shipments.length<8 && state.buffer.items.length<24) return false;
    if(!state.buffer.shipments.length&&!state.buffer.items.length) return false;
    const b=JSON.parse(JSON.stringify(nextMicroBatch(state.buffer)));
    googleFlushInFlight=true;
    const sync=state.googleSync ||= {};
    // Persist a grace period BEFORE dispatch, including if the page reloads mid-request.
    sync.nextAttemptAt=Date.now()+60000;
    sync.lots=Number(sync.lots||0)+1;
    state.lastMessage=`Google : micro-lot ${sync.lots} · ${b.shipments.length} colis / ${b.items.length} article(s)`;
    setScanOperation(state,'google-flush',{shipments:b.shipments.length,items:b.items.length});
    try {
      await apiPost('upsertBatch',b);
      acknowledgeMicroBatch(state.buffer,b);
      sync.failures=0; sync.nextAttemptAt=0; sync.lastError='';
      state.lastBufferFlushAt=nowIso();
      state.lastMessage=`Google OK · reste ${state.buffer.shipments.length}/${state.buffer.items.length}`;
      clearScanOperation(state);
      return true;
    } catch(e) {
      // Transport/API errors belong to the outbox, never to Amazon quarantine.
      deferGoogleSync(state,e);
      return false;
    } finally { googleFlushInFlight=false; }
  }

  async function configure() {
    const old = getConfig();
    const before = getState();
    if (before?.active) {
      toast(`Scan ${scanAccount(before) || '?'} actif : arrête-le avant de modifier la configuration.`, 'error');
      return false;
    }
    const account = prompt('Nom de ce compte/téléphone (ex: VINE01)', old.account || 'VINE01');
    if (account === null) return false;
    const webAppUrl = prompt('URL du Web App Google Apps Script (/exec)', old.webAppUrl || '');
    if (webAppUrl === null) return false;
    const apiSecret = prompt('API_SECRET affiché par setupVineTracking()', old.apiSecret || '');
    if (apiSecret === null) return false;
    const relayUrl = prompt('Relais Cloudflare facultatif — URL ...workers.dev/vine-tracking\nLaisse vide si Google direct fonctionne sur ce téléphone.', old.relayUrl || '');
    if (relayUrl === null) return false;
    let relayToken = old.relayToken || '';
    if (String(relayUrl || '').trim()) {
      const entered = prompt('VT_RELAY_TOKEN du Worker Cloudflare', relayToken);
      if (entered === null) return false;
      relayToken = entered;
    } else relayToken = '';
    const next = { ...old, account: account.trim().toUpperCase(), webAppUrl: webAppUrl.trim(), apiSecret: apiSecret.trim(), relayUrl: String(relayUrl||'').trim(), relayToken: String(relayToken||'').trim() };
    if (!next.account) { toast('Nom de compte obligatoire', 'error'); return false; }
    if (!validAccountName(next.account)) { toast('Nom de compte invalide : utilise lettres/chiffres/_/- sans espace (ex. VINE01).', 'error'); return false; }
    if (!validateWebAppUrl(next.webAppUrl)) { toast('URL invalide : copie bien l’URL /exec du Web App', 'error'); return false; }
    if (!next.apiSecret) { toast('API_SECRET obligatoire', 'error'); return false; }
    if (next.relayUrl && !validateRelayUrl(next.relayUrl)) { toast('URL relais invalide : utilise une URL HTTPS workers.dev terminant par /vine-tracking', 'error'); return false; }
    if (next.relayUrl && !next.relayToken) { toast('VT_RELAY_TOKEN obligatoire quand le relais est configuré', 'error'); return false; }
    const scanState = getState();
    const stateAcct = scanAccount(scanState);
    if (scanState?.paused && stateAcct && stateAcct !== next.account) {
      toast(`Scan ${stateAcct} en pause : réinitialise-le avant de configurer ${next.account}.`, 'error');
      return false;
    }
    const pausedEndpoint = normalizedWebAppEndpoint(scanState?.webAppUrl || '');
    const nextEndpoint = normalizedWebAppEndpoint(next.webAppUrl || '');
    if (scanState?.paused && pausedEndpoint && nextEndpoint && pausedEndpoint !== nextEndpoint) {
      toast('Ce scan en pause appartient à un autre déploiement Apps Script. Réinitialise le scan avant de changer WEB_APP_URL.', 'error');
      return false;
    }
    saveConfig(next);
    resetTransportState(next.account);
    try {
      const pong = await apiPost('ping');
      if (String(pong.version || '') !== VERSION) { toast(`Configuration enregistrée mais serveur v${pong.version || '?'} incompatible avec téléphone v${VERSION}`, 'error'); return false; }
      toast(`Configuration OK — serveur v${pong.build || pong.version || '?'} via ${transportLabel(pong.__transport)}`, 'ok');
      return true;
    } catch (e) {
      toast(`Configuration enregistrée mais test serveur échoué : ${e.message}`, 'error');
      return false;
    }
  }

  async function configureRelay() {
    const old = getConfig();
    if (!validAccountName(old.account) || !validateWebAppUrl(old.webAppUrl) || !old.apiSecret) {
      toast('Configure d’abord le compte et Apps Script avec ⚙ Config.', 'warn');
      return false;
    }
    const relayUrl = prompt('URL du relais Cloudflare\nEx: https://vine-tracking-relay.xxx.workers.dev/vine-tracking\nLaisse vide pour désactiver le relais.', old.relayUrl || '');
    if (relayUrl === null) return false;
    if (!String(relayUrl || '').trim()) {
      saveConfig({ ...old, relayUrl:'', relayToken:'' });
      resetTransportState(old.account);
      toast('Relais Cloudflare désactivé — Google direct uniquement.', 'ok');
      updatePanel(getState());
      return true;
    }
    if (!validateRelayUrl(relayUrl)) { toast('URL invalide : HTTPS workers.dev + /vine-tracking obligatoire.', 'error'); return false; }
    const relayToken = prompt('VT_RELAY_TOKEN configuré dans le Worker', old.relayToken || '');
    if (relayToken === null) return false;
    if (!String(relayToken || '').trim()) { toast('VT_RELAY_TOKEN obligatoire.', 'error'); return false; }
    saveConfig({ ...old, relayUrl:String(relayUrl).trim(), relayToken:String(relayToken).trim() });
    // Force un test par le relais : cela valide Worker -> Apps Script même si le direct marche.
    try {
      const r = await apiPostTransport('ping', {}, 'relay');
      if (String(r.version || '') !== VERSION || String(r.build || '') !== BUILD_VERSION) throw new Error(`Serveur derrière le relais incompatible : ${r.build || r.version || '?'}`);
      const ts=getTransportState(old.account); ts.lastUsed='relay'; ts.lastOkAt=Date.now(); saveTransportState(ts,old.account);
      toast(`Relais Cloudflare OK — Apps Script ${r.build || r.version}`, 'ok');
      updatePanel(getState());
      return true;
    } catch(e) {
      toast(`Relais Cloudflare KO : ${e.message}`, 'error');
      return false;
    }
  }

  async function testConnection() {
    if (!configReady()) return configure();
    try {
      const r = await apiPost('ping');
      if (String(r.version || '') !== VERSION) { toast(`Connexion Google OK mais version incompatible : serveur v${r.version || '?'}, téléphone v${VERSION}`, 'error'); return false; }
      toast(`Connexion Google OK — serveur ${r.build || ('v' + (r.version || '?'))} · protocole ${r.version || '?'} · via ${transportLabel(r.__transport)}`, 'ok');
      return true;
    } catch (e) {
      toast(`Connexion Google KO : ${e.message}`, 'error');
      return false;
    }
  }

  function configReady() {
    const c = getConfig();
    return !!(validAccountName(c.account) && validateWebAppUrl(c.webAppUrl) && c.apiSecret);
  }

  function majorVersion(v) { return String(v || '').split('.')[0] || ''; }
  async function ensureServerCompatible() {
    try {
      const r = await apiPost('ping');
      if (String(r.version || '') !== VERSION) {
        toast(`Version incompatible : téléphone protocole ${VERSION}, serveur ${r.version || '?'}. Mets à jour Code.gs avant de scanner.`, 'error');
        return false;
      }
      if (String(r.build || '') !== BUILD_VERSION) {
        toast(`Build serveur incompatible : téléphone ${BUILD_VERSION}, serveur ${r.build || 'ancien/inconnu'}. Mets à jour Code.gs et redéploie le même /exec avant de scanner.`, 'error');
        return false;
      }
      return true;
    } catch (e) {
      toast(`Serveur Google inaccessible : ${e.message}`, 'error');
      return false;
    }
  }

  async function startDeliverySearch() {
    if (!configReady() && !(await configure())) return;
    if (!(await ensureServerCompatible())) return;
    const previous = getState()?.searchQuery || '';
    const query = prompt("Recherche livraison : mot-clé ou date\nExemples : aujourd'hui, demain, mardi, 15 septembre, 29/09", previous);
    if (query === null) return;
    const clean = normalizeText(query);
    if (!clean) { toast('Entre un mot-clé ou une date.', 'warn'); return; }

    const current = getState();
    if (current?.active) { toast('Un scan est déjà actif. Arrête-le avant de lancer une recherche.', 'warn'); return; }
    if (current?.paused) {
      const pending = (current.buffer?.shipments?.length || 0) + (current.buffer?.items?.length || 0);
      const msg = pending
        ? `Un scan est en pause avec ${pending} donnée(s) non finalisée(s). Lancer la recherche abandonnera cette progression. Continuer ?`
        : 'Un scan est en pause. Lancer la recherche abandonnera sa progression. Continuer ?';
      if (!confirm(msg)) return;
    }
    if (!allowConservativeScanStart(getConfig().account, 'la recherche livraison')) return;

    const searchDays = Math.max(14, Math.min(60, Number(getConfig().deliverySearchLookbackDays || 45)));
    const state = baseState('search', searchDays);
    state.deliverySearchLookbackDays = searchDays;
    state.historySource = 'legacy';
    if (!acquireTabLock(getConfig().account, state.scanId)) { toast('Un autre onglet Amazon possède déjà le scan de ce compte.', 'error'); return; }
    state.searchQuery = clean;
    state.searchTargetDate = searchTargetDate(clean);
    state.lastMessage = `Recherche livraison : "${clean}"…`;
    saveState(state);
    if (!isLegacyHistoryPage()) {
      navigateTo(LEGACY_ORDERS_URL);
      return;
    }
    await resumeScan();
  }

  async function startCustomRangeScan(priorityTracking = false, presetInput = null) {
    if (!configReady() && !(await configure())) return;
    if (!(await ensureServerCompatible())) return;
    const previous = getState()?.customRangeLabel || '';
    const input = presetInput == null ? prompt('Scanner entre 2 dates (dates de COMMANDE)\nExemple : du 05/09 au 10/09\nTu peux aussi écrire 05/09/2026 au 10/09/2026', previous) : presetInput;
    if (input === null) return;
    const parsed = parseCustomScanRange(input);
    if (!parsed) { toast('Plage invalide. Exemple attendu : 05/09 au 10/09', 'error'); return; }
    if (parsed.error === 'future') { toast('La date de fin ne peut pas être dans le futur.', 'error'); return; }
    const c = getConfig();
    const current = getState();
    if (current?.active) { toast('Un scan est déjà actif. Utilise Stop ou attends sa fin.', 'warn'); return; }
    if (current?.paused && !confirm('Un scan est en pause. Démarrer cette plage abandonnera sa progression. Continuer ?')) return;
    if (!allowConservativeScanStart(c.account, 'ce scan personnalisé')) return;
    const state = baseState('range', Math.max(1, parsed.lookbackDays));
    if (!acquireTabLock(c.account, state.scanId)) { toast('Un autre onglet Amazon possède déjà le scan de ce compte.', 'error'); return; }
    state.cutoffTs = parsed.startTs;
    state.rangeEndTs = parsed.endTs;
    state.customRangeStart = parsed.startIso;
    state.customRangeEnd = parsed.endIso;
    state.customRangeLabel = `${parsed.startIso} → ${parsed.endIso}`;
    state.priorityTracking = priorityTracking === true;
    state.historySource = 'vine';
    state.phase = 'history';
    state.lastMessage = `${state.priorityTracking ? '⚡ Suivis + ASIN — ' : ''}Vine Orders : commandes du ${parsed.startIso} au ${parsed.endIso}`;
    saveState(state);
    if (!isVineOrdersPage()) { navigateTo(VINE_ORDERS_URL); return; }
    await resumeScan();
  }

  async function startPriorityTracking() {
    const previous = String(['VT_PRIORITY_PERIOD_V33718','VT_PRIORITY_PERIOD_V33717','VT_PRIORITY_PERIOD_V33715','VT_PRIORITY_PERIOD_V33714','VT_PRIORITY_PERIOD_V33713','VT_PRIORITY_PERIOD_V33712','VT_PRIORITY_PERIOD_V33711','VT_PRIORITY_PERIOD_V3379','VT_PRIORITY_PERIOD_V3378','VT_PRIORITY_PERIOD_V3377','VT_PRIORITY_PERIOD_V3376','VT_PRIORITY_PERIOD_V3374','VT_PRIORITY_PERIOD_V3373','VT_PRIORITY_PERIOD_V3372'].reduce((v,k)=>v!=null?v:GM_getValue(k,null),null) ?? '7');
    const input = prompt('⚡ Suivis + ASIN — période des COMMANDES\nTape 7, 15 ou 30, ou une plage comme : du 05/09 au 10/09', previous);
    if (input === null) return;
    const clean = normalizeText(input).trim();
    if (/^\d{1,3}$/.test(clean)) {
      const days = Number(clean);
      if (days < 1 || days > 366) { toast('Nombre de jours invalide (1 à 366).', 'error'); return; }
      GM_setValue('VT_PRIORITY_PERIOD_V33718', String(days));
      return startScan(days, 'range', { priorityTracking:true });
    }
    const parsed = parseCustomScanRange(clean);
    if (!parsed) { toast('Période invalide. Exemples : 7 ou du 05/09 au 10/09', 'error'); return; }
    if (parsed.error === 'future') { toast('La date de fin ne peut pas être dans le futur.', 'error'); return; }
    GM_setValue('VT_PRIORITY_PERIOD_V33718', clean);
    return startCustomRangeScan(true, clean);
  }

  function recentExtensionCoverage(days, account = getConfig().account) {
    const currentDays=Number(days||0), maxAge=Math.max(60*60*1000,Number(getConfig().rangeExtensionReuseMs||6*60*60*1000));
    if (!(currentDays>1)) return null;
    const now=Date.now();
    const rows=getScanHistory(account).filter(r=>r && r.mode==='range' && r.status==='OK' && Number(r.days||0)>0 && Number(r.days||0)<currentDays && r.finishedAt);
    for (const row of rows) {
      const finished=Date.parse(row.finishedAt||''); if(!Number.isFinite(finished)||now-finished>maxAge) continue;
      const prevDays=Number(row.days||0); const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-(prevDays-1));
      return { scanId:String(row.scanId||''), days:prevDays, startedAt:String(row.startedAt||''), finishedAt:String(row.finishedAt||''), cutoffTs:d.getTime() };
    }
    return null;
  }

  function canReuseCandidateFromExtension(state, cached, orderDate, serverHasOrder, rangePending) {
    const reuse=state?.extensionReuse;
    if (!reuse || !cached || rangePending || !serverHasOrder || !validIsoOrderDate(orderDate)) return false;
    const d=new Date(`${orderDate}T12:00:00`); if(Number.isNaN(d.getTime())) return false;
    const previousStart=Date.parse(reuse.startedAt||''); const lastChecked=Date.parse(cached.lastChecked||'');
    if (!Number.isFinite(previousStart) || !Number.isFinite(lastChecked) || lastChecked < previousStart) return false;
    return d.getTime() >= Number(reuse.cutoffTs||0);
  }

  async function startScan(days, mode = 'range', options = {}) {
    const scheduled = options?.scheduled === true;
    const scheduledId = String(options?.scheduledId || '');
    if (!configReady()) {
      if (scheduled) return false;
      if (!(await configure())) return false;
    }
    if (!(await ensureServerCompatible())) return false;
    const c = getConfig();
    const current = getState();
    if (current?.active) { if (!scheduled) toast('Un scan est déjà actif. Utilise Stop ou attends sa fin avant d’en lancer un autre.', 'warn'); return false; }
    if (current?.paused) {
      if (scheduled) return false;
      const pending = (current.buffer?.shipments?.length || 0) + (current.buffer?.items?.length || 0);
      const msg = pending
        ? `Un scan est en pause avec ${pending} donnée(s) potentiellement en attente. Démarrer un nouveau scan abandonnera cette progression. Continuer ?`
        : 'Un scan est en pause. Démarrer un nouveau scan abandonnera sa progression. Continuer ?';
      if (!confirm(msg)) return false;
    }
    if (!allowConservativeScanStart(c.account, mode === 'missing' ? 'les suivis manquants' : `le scan ${days} j`, !scheduled)) return false;

    if (mode === 'missing') {
      const cache = getCache(c.account);
      const queue = Object.values(cache)
        .filter(x => x && x.detailUrl && x.trackingComplete !== true)
        .sort((a, b) => String(b.orderDate || '').localeCompare(String(a.orderDate || '')))
        .map(x => ({ url: x.detailUrl, orderId: x.orderId, orderDate: x.orderDate || '' }));
      if (!queue.length) {
        toast('Aucun suivi manquant en cache. Je lance un scan 7 jours.', 'warn');
        return startScan(7, 'range');
      }
      const state = baseState('missing', 30);
      if (!acquireTabLock(c.account, state.scanId)) { toast('Un autre onglet Amazon possède déjà le scan de ce compte.', 'error'); return false; }
      await sleep(180 + Math.floor(Math.random()*180));
      if (!confirmTabLock(state)) { toast('Conflit de verrou détecté avec un autre onglet. Aucun scan lancé.', 'error'); return false; }
      state.phase = 'details';
      state.orderQueue = uniqBy(queue, x => x.orderId);
      state.stats.orders = state.orderQueue.length;
      saveState(state);
      return goNext(state);
    }

    const state = baseState('range', days);
    state.scheduled = scheduled;
    state.scheduledId = scheduledId;
    state.priorityTracking = options && options.priorityTracking === true;
    state.robustNight = options && options.robustNight === true;
    state.extensionReuse = recentExtensionCoverage(days, c.account);
    state.forceFullScan = consumeForceFullNext(c.account);
    state.smartCacheSource = '';
    state.historySource = 'vine';
    state.lastMessage = state.priorityTracking ? `⚡ Suivis + ASIN — Vine Orders ${days} jour(s)` : `Vine Orders — ${days} jour(s)`;
    if (!acquireTabLock(c.account, state.scanId)) { toast('Un autre onglet Amazon possède déjà le scan de ce compte.', 'error'); return false; }
    await sleep(180 + Math.floor(Math.random()*180));
    if (!confirmTabLock(state)) { toast('Conflit de verrou détecté avec un autre onglet. Aucun scan lancé.', 'error'); return false; }
    if (state.robustNight) requestRobustWakeLock('scan-nuit');
    state.phase = 'history';
    saveState(state);
    if (scheduledId) markScheduledScanLaunched(scheduledId, state.scanId, c.account);
    if (!isVineOrdersPage()) {
      navigateTo(VINE_ORDERS_URL);
      return true;
    }
    await resumeScan();
    return true;
  }

  function baseState(mode, days) {
    const now = new Date();
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1), 0, 0, 0);
    return {
      version: VERSION,
      account: String(getConfig().account || '').trim().toUpperCase(),
      webAppUrl: normalizedWebAppEndpoint(getConfig().webAppUrl || ''),
      scanId: `scan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,9)}`,
      active: true,
      mode,
      days,
      phase: 'history',
      historySource: mode === 'search' ? 'legacy' : 'vine',
      vineFallbackUsed: false,
      vineDiagnostics: [],
      cutoffTs: cutoff.getTime(),
      rangeEndTs: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime(),
      originUrl: location.href,
      startedAt: nowIso(),
      historyPages: 0,
      orderQueue: [],
      trackQueue: [],
      detailsSinceTracking: 0,
      visitedHistory: {},
      visitedOrders: {},
      visitedTracking: {},
      visitedPhysicalTracking: {},
      buffer: { shipments: [], items: [] },
      stats: { orders: 0, detailsProcessed: 0, shipments: 0, trackingFound: 0, pending: 0, delivered: 0, uncertain: 0, errors: 0, searchLabels: 0, searchCards: 0, searchResolvedCards: 0, searchUnresolvedCards: 0, rangeIncluded: 0, rangeUnknown: 0, rangeOutside: 0, rangeReused: 0, smartSkippedFinal:0, smartSkippedRecent:0, smartSkippedPending:0, smartDirectTracking:0, smartNew:0, queuePrioritized:0, quarantined:0, quarantineRecovered:0, resumeRecovered:0 },
      robustNight: false, extensionReuse: null,
      quarantine: [], quarantineFinal: [], quarantineRetryPass:false,
      journal: { seq:0, current:null, lastCommitted:null, recoveries:0 },
      rangeAudit: { included: {}, unknown: {}, outside: {} },
      lastMessage: 'Démarrage…',
    };
  }

  async function stopScan(reason = 'Arrêt manuel') {
    const s = getState();
    if (s) {
      s.active = false;
      s.paused = true;
      s.lastMessage = reason;
      try { await flushBuffer(s, true); } catch (e) { s.lastMessage += ` — données en attente: ${e.message}`; }
      saveState(s);
      releaseTabLock(scanAccount(s) || getConfig().account, s.scanId || '');
    }
    releaseRobustWakeLockIfIdle();
    void sendFleetHeartbeat(true);
    toast(reason, 'warn');
  }

  async function resumePausedScan() {
    const s = getState();
    if (!s) { toast('Aucun scan à reprendre', 'warn'); return; }
    if (!stateAccountIsCurrent(s)) { pauseForAccountMismatch(s); return; }
    if (!acquireTabLock(scanAccount(s), s.scanId || '', false)) { toast('Un autre onglet possède encore ce scan.', 'error'); return; }
    await sleep(180 + Math.floor(Math.random()*180));
    if (!confirmTabLock(s)) { toast('Conflit de verrou détecté avec un autre onglet. Reprise annulée.', 'error'); return; }
    s.active = true;
    s.paused = false;
    s.retryCounts = {};
    s.lastMessage = 'Reprise…';
    saveState(s);
    return resumeScan();
  }

  async function finishScan(state) {
    // Un scan qui trouve des commandes mais zéro colis signifie que les pages détail n'ont jamais été traitées.
    // Ne jamais annoncer un faux succès dans ce cas.
    if ((state.stats?.orders || 0) > 0 && (state.stats?.shipments || 0) === 0) {
      state.active = false;
      state.paused = true;
      state.lastMessage = `Pause diagnostic : ${state.stats.orders} commande(s) trouvée(s), mais aucune page détail n'a été traitée. Appuie sur Reprendre après avoir ouvert une commande, ou utilise Diagnostic.`;
      saveState(state);
      recordScanSummary(state, 'ERREUR', state.lastMessage);
      try { await apiPost('clientLog', { message: state.lastMessage, details: { url: location.href, phase: state.phase, currentOrder: state.currentOrder || null } }); } catch (_) {}
      toast(state.lastMessage, 'error');
      return;
    }
    state.phase='done';
    const remaining=Number(state.googleSync?.nextAttemptAt||0)-Date.now();
    if(remaining>0) { scheduleFinalGoogleRetry(state,remaining); return; }
    await flushBuffer(state,true);
    if(state.buffer.shipments.length || state.buffer.items.length) {
      saveState(state);
      scheduleFinalGoogleRetry(state,Math.max(1500,Number(state.googleSync?.nextAttemptAt||0)-Date.now()));
      return;
    }
    if (state.mode === 'search' && (state.stats.searchUnresolvedCards || 0) > 0) {
      try {
        await apiPost('clientLog', {
          message: `Recherche ${state.searchQuery}: ${state.stats.searchUnresolvedCards} carte(s) correspondante(s) sans OrderID exploitable`,
          details: { stats: state.stats, audit: state.searchAudit || [] }
        });
      } catch (_) {}
    }
    // Recalcule les compteurs physiques depuis COLIS après le dernier flush.
    // Le log final ne dépend ainsi plus des compteurs intermédiaires du navigateur.
    try {
      const ids = [...new Set([
        ...Object.keys(state.rangeAudit?.included || {}),
        ...Object.keys(state.visitedOrders || {})
      ])].filter(x => /^\d{3}-\d{7}-\d{7}$/.test(x));
      state.finalStatsVerified = true;
      if (ids.length) {
        setScanOperation(state, 'google-stats', { orderIds:ids.length });
      const r = await apiPost('getScanStats', { orderIds: ids });
      clearScanOperation(state);
        const fs = r?.stats || {};
        for (const k of ['shipments','trackingFound','pending','delivered','uncertain']) {
          if (Number.isFinite(Number(fs[k]))) state.stats[k] = Number(fs[k]);
        }
        state.lastMessage = 'Compteurs vérifiés depuis COLIS — finalisation…';
        saveState(state);
      }
    } catch (e) {
      state.finalStatsVerified = false;
      state.lastMessage = `Compteurs Google non vérifiés (${String(e?.message||e)}), finalisation des données…`;
      saveState(state);
      log('Recalcul final des compteurs indisponible', e);
    }
    try {
      setScanOperation(state, 'google-finalize', {});
      await apiPost('finalizeSync', { stats: state.stats, startedAt: state.startedAt, finishedAt: nowIso() });
      clearScanOperation(state);
    } catch (e) {
      deferGoogleSync(state,e);
      scheduleFinalGoogleRetry(state,Number(state.googleSync?.nextAttemptAt||0)-Date.now());
      return;
    }

    state.active = false;
    state.paused = false;
    releaseTabLock(scanAccount(state), state.scanId || '');
    state.finishedAt = nowIso();
    state.lastMessage = state.mode === 'search'
      ? `Recherche "${state.searchQuery}": ${state.stats.orders || 0} OrderID unique(s), ${state.stats.searchLabels || 0} résultat(s) livraison, ${state.stats.searchCards || 0} carte(s), ${state.stats.trackingFound || 0} suivi(s)${(state.stats.searchUnresolvedCards || 0) ? `, ${state.stats.searchUnresolvedCards} carte(s) sans OrderID` : ''}`
      : `Terminé : ${state.stats.trackingFound} suivis trouvés`;
    saveState(state);
    recordScanSummary(state, '', state.lastMessage);
    releaseRobustWakeLockIfIdle();
    void sendFleetHeartbeat(true);
    toast(state.lastMessage, 'ok');
    setTimeout(() => {
      const latest = getState();
      if (latest && latest.finishedAt === state.finishedAt && !latest.active && !latest.paused) clearState();
    }, 3500);
  }

  async function resumeScan() {
    if (resumeInProgress) return;
    resumeInProgress = true;
    try { return await resumeScanInner(); }
    finally { resumeInProgress = false; }
  }

  async function resumeScanInner() {
    const state = getState();
    if (!state?.active) return;
    if (!stateAccountIsCurrent(state)) { pauseForAccountMismatch(state); return; }
    if (!ownsTabLock(state)) { updatePanel(state); return; }
    if (recoverExactJournal(state)) { saveState(state); return goNext(state); }
    if (state.robustNight===true && typeof navigator!=='undefined' && navigator.onLine===false) {
      state.lastMessage='🌙 Mode nuit robuste : réseau indisponible, attente sans perdre la progression…'; saveState(state);
      setTimeout(()=>resumeScan(), Math.max(15000,Number(getConfig().nightRobustOfflineRetryMs||60000))); return;
    }
    if (pageLooksLikeLoginOrChallenge() || pageLooksRateLimitedOrUnavailable()) {
      state.active = false;
      state.paused = true;
      state.lastMessage = pageLooksLikeLoginOrChallenge()
        ? 'Pause : Amazon demande une connexion/CAPTCHA. Termine la vérification puis appuie sur Reprendre.'
        : 'Pause faible trafic : Amazon indique trop de requêtes ou une indisponibilité. Aucun reload automatique. Attends avant de reprendre.';
      saveState(state);
      toast(state.lastMessage, 'error');
      return;
    }
    try {
      if (state.phase === 'history') return processHistory(state);
      if (state.phase === 'details') return processDetails(state);
      if (state.phase === 'tracking') return processTracking(state);
      return finishScan(state);
    } catch (e) {
      console.error('[VINE Tracking] Erreur', e);
      state.stats.errors++;
      state.retryCounts ||= {};
      const retryKey = state.phase === 'history'
        ? `history:${location.href.split('#')[0]}`
        : state.phase === 'details'
          ? `order:${state.currentOrder?.orderId || parseOrderId(document.body?.innerText || '') || location.href}`
          : state.phase === 'tracking'
            ? `tracking:${state.currentTracking?.context?.shipmentKey || location.href}`
            : `phase:${state.phase}`;
      const tries = (state.retryCounts[retryKey] || 0) + 1;
      state.retryCounts[retryKey] = tries;
      const cfgNow = getConfig();
      // quarantineMaxAttempts compte la tentative initiale. 2 = 1 retry puis quarantaine.
      // Pour history, on conserve la politique faible trafic historique pageRetries.
      const maxAttempts = ['details','tracking'].includes(state.phase)
        ? Math.max(1, Number(cfgNow.quarantineMaxAttempts || 2))
        : Math.max(1, Number(cfgNow.pageRetries || 0) + 1);
      const maxRetries = Math.max(0, maxAttempts - 1);
      if (tries <= maxRetries) {
        state.lastMessage = `Erreur temporaire (${tries}/${maxRetries}) : ${e.message} — nouvelle tentative…`;
        saveState(state);
        await sleep(Math.max(1800, randomDelay()));
        location.reload();
        return;
      }
      // V3.3.7.20 : une commande/colis problématique ne bloque plus tout le téléphone.
      // Les phases details/tracking passent en quarantaine et sont retentées UNE fois à la fin.
      // La phase history reste stricte car elle détermine la période entière.
      if (['details','tracking'].includes(state.phase) && quarantineCurrent(state, e.message)) {
        const finalPass=state.quarantineRetryPass===true;
        state.lastMessage = finalPass
          ? `Quarantaine finale : élément isolé après ${tries} échecs (${e.message}) — le scan continue.`
          : `Quarantaine : élément mis de côté après ${tries} échecs (${e.message}) — le scan continue.`;
        delete state.retryCounts[retryKey];
        saveState(state);
        try { await apiPost('clientLog', { message: state.lastMessage, details: { phase: state.phase, url: location.href, quarantine:true, finalPass } }); } catch (_) {}
        await sleep(Math.min(1800,Math.max(500,Math.floor(randomDelay()/4))));
        return goNext(state);
      }
      state.active = false;
      state.paused = true;
      state.lastMessage = `Pause diagnostic après ${tries} échecs : ${e.message}. Ouvre 🧪 Diagnostic puis Reprendre après correction.`;
      saveState(state);
      try {
        await apiPost('clientLog', { message: state.lastMessage, details: { phase: state.phase, url: location.href, currentOrder: state.currentOrder || null, currentTracking: state.currentTracking?.context || null } });
      } catch (_) {}
      toast(state.lastMessage, 'error');
      return;
    }
  }


  async function processVineOrdersIndex(state) {
    if (!stateAccountIsCurrent(state)) { pauseForAccountMismatch(state); return; }
    if (!isVineOrdersPage()) {
      state.lastMessage = 'Ouverture Amazon Vine — Commandes…'; saveState(state);
      navigateTo(VINE_ORDERS_URL);
      return;
    }
    if (document.readyState !== 'complete') await waitUntil(() => document.readyState === 'complete', Math.min(5000, Number(getConfig().waitReadyMs || 10000)));
    const ready = await waitUntil(() => vineOrderCandidates(document).length > 0 || vineOrdersNoOrdersMarker(), Number(getConfig().waitReadyMs || 10000), 350);
    if (!ready) {
      if (!state.vineFallbackUsed) {
        state.vineFallbackUsed = true; state.historySource = 'legacy';
        state.lastMessage = 'Vine Orders non reconnue : fallback historique Amazon classique.'; saveState(state);
        await sleep(randomDelay()); navigateTo(LEGACY_ORDERS_URL); return;
      }
      throw new Error('Vine Orders ne contient aucune commande exploitable après attente.');
    }
    if (vineOrdersNoOrdersMarker()) {
      state.phase = 'details'; saveState(state); return goNext(state);
    }

    const stablePage = await collectStableVineOrdersPage();
    const candidates = stablePage.candidates || [];
    if (!candidates.length) {
      if (!state.vineFallbackUsed) {
        state.vineFallbackUsed = true; state.historySource = 'legacy';
        state.lastMessage = 'Vine Orders vide/non reconnue : fallback historique Amazon classique.'; saveState(state);
        await sleep(randomDelay()); navigateTo(LEGACY_ORDERS_URL); return;
      }
      throw new Error('Aucun OrderID exploitable sur Vine Orders.');
    }

    const urlKey = location.href.split('#')[0];
    if (state.visitedHistory[urlKey]) { state.phase = 'details'; saveState(state); return goNext(state); }
    state.historyPages++;
    const c = getConfig(), cache = getCache(c.account);
    state.lastMessage = `Smart Cache : vérification Google/IndexedDB de ${candidates.length} commande(s)…`;
    setScanOperation(state, 'google-smart-cache', { orders:candidates.length });
    const knownState = await fetchKnownOrderState(candidates.map(x => x.orderId));
    clearScanOperation(state);
    const serverDates = knownState.dates || {};
    const smartOrders = knownState.orders || {};
    state.smartCacheSource = knownState.source || '';
    let oldestTs = Infinity, knownDates = 0, unknownDates = 0;

    for (const candidate of candidates) {
      const cached = cache[candidate.orderId];
      const orderDate = chooseKnownOrderDate(candidate.orderDate || '', cached?.orderDate, serverDates[candidate.orderId]);
      const d = orderDate ? new Date(`${orderDate}T12:00:00`) : null;
      if (d && !Number.isNaN(d.getTime())) { oldestTs = Math.min(oldestTs, d.getTime()); knownDates++; } else unknownDates++;
      const rangeClass = classifyOrderDateForRange(orderDate, state.cutoffTs, Date.now(), state.rangeEndTs);
      markRangeAudit(state, rangeClass, candidate.orderId);
      if (rangeClass === 'OUTSIDE') continue;
      const rangePending = rangeClass === 'UNKNOWN';

      const serverHasOrder = !!validIsoOrderDate(serverDates[candidate.orderId]);
      const smartRow = smartOrders[candidate.orderId] || null;
      const decision=smartCacheDecision(state,cached,smartRow,{rangePending,serverHasOrder});
      if(!cached && !smartRow) state.stats.smartNew=(state.stats.smartNew||0)+1;
      if(decision.action==='SKIP_FINAL'){state.stats.smartSkippedFinal=(state.stats.smartSkippedFinal||0)+1;continue;}
      if(decision.action==='SKIP_RECENT'){state.stats.smartSkippedRecent=(state.stats.smartSkippedRecent||0)+1;continue;}
      if(decision.action==='SKIP_PENDING'){state.stats.smartSkippedPending=(state.stats.smartSkippedPending||0)+1;continue;}
      if(decision.action==='DIRECT_TRACKING'){
        const n=enqueueSmartDirectTracking(state,smartRow,candidate,orderDate);
        if(n>0){state.stats.smartDirectTracking=(state.stats.smartDirectTracking||0)+1;continue;}
      }

      state.orderQueue.push({
        url: canonicalOrderDetailUrl(candidate.orderId),
        sourceUrl: candidate.sourceUrl || canonicalOrderDetailUrl(candidate.orderId),
        historyTrackingUrls: candidate.historyTrackingUrls || [],
        historyItems: candidate.historyItems || [],
        orderId: candidate.orderId,
        orderDate,
        rangePending,
        discoveredFrom: 'vine-orders',
        queuePriority: queuePriorityFor(decision,cached,smartRow),
        queueReason: decision.reason || 'full'
      });
      cache[candidate.orderId] = { ...(cached || {}), orderId: candidate.orderId, detailUrl: candidate.sourceUrl || canonicalOrderDetailUrl(candidate.orderId), orderDate: orderDate || cached?.orderDate || '', lastSeen: nowIso(), trackingComplete: cached?.trackingComplete === true };
    }

    state.orderQueue = uniqBy(state.orderQueue, x => x.orderId);
    sortQueuesByPriority(state);
    state.stats.orders = state.orderQueue.length + new Set((state.trackQueue||[]).map(x=>x?.context?.orderId).filter(Boolean)).size;
    saveCache(c.account, cache);
    state.visitedHistory[urlKey] = true;
    state.vineDiagnostics ||= [];
    state.vineDiagnostics.push({ page: state.historyPages, url: location.href, knownDates, unknownDates, descending: vineOrderDatesAreDescending(candidates), ...(stablePage.diagnostics || {}) });
    state.vineDiagnostics = state.vineDiagnostics.slice(-20);

    const maxPages = state.days <= 7 ? Number(c.maxVinePages7 || 8) : Number(c.maxVinePages30 || 16);
    const chronological = vineOrderDatesAreDescending(candidates);
    const reachedCutoff = unknownDates === 0 && knownDates > 0 && oldestTs < state.cutoffTs && chronological;
    const next = findNextVineOrdersUrl();
    state.lastMessage = `Vine Orders ${state.historyPages}/${maxPages} — période ${state.stats.rangeIncluded || 0} · Smart skip ${Number(state.stats.smartSkippedFinal||0)+Number(state.stats.smartSkippedRecent||0)+Number(state.stats.smartSkippedPending||0)} · suivi direct ${state.stats.smartDirectTracking||0} · à traiter ${state.stats.orders||0}`;
    saveState(state);

    if (next && !reachedCutoff && state.historyPages >= maxPages && !state.visitedHistory[next]) throw new Error(`Limite Vine Orders atteinte (${maxPages} pages) avant la fin de la période.`);
    if (next && !reachedCutoff && state.historyPages < maxPages && !state.visitedHistory[next]) {
      await sleep(randomDelay()); navigateTo(next); return;
    }
    state.phase = 'details'; saveState(state); return goNext(state);
  }

  async function processHistory(state) {
    if (!stateAccountIsCurrent(state)) { pauseForAccountMismatch(state); return; }
    if (state.mode !== 'search' && state.historySource !== 'legacy') return processVineOrdersIndex(state);
    if (!isLegacyHistoryPage()) {
      state.lastMessage = 'Ouverture historique Amazon classique…'; saveState(state);
      navigateTo(LEGACY_ORDERS_URL);
      return;
    }
    await waitForCurrentPageReady('history');
    let stablePage = await collectStableHistoryPage(state.mode === 'search' ? (state.searchQuery || '') : '');
    const expandedClicks = await expandHistoryInPlace(state.mode === 'search' ? Number(getConfig().maxDeliverySearchExpandClicks || 2) : null);
    // Si Amazon a réellement ajouté des cartes via « Afficher plus », on refait une
    // stabilisation et on fusionne avec tout ce qui a déjà été observé.
    if (expandedClicks > 0) {
      const afterExpand = await collectStableHistoryPage(state.mode === 'search' ? (state.searchQuery || '') : '');
      const union = new Map();
      mergeHistoryCandidateSnapshots(union, stablePage.candidates);
      mergeHistoryCandidateSnapshots(union, afterExpand.candidates);
      stablePage = {
        candidates: [...union.values()],
        audit: betterHistoryAudit(stablePage.audit, afterExpand.audit),
        diagnostics: {
          ...(afterExpand.diagnostics || {}),
          expandedClicks,
          preExpandUnionCount: stablePage.candidates.length,
          unionCount: union.size,
        },
      };
    } else {
      stablePage.diagnostics = { ...(stablePage.diagnostics || {}), expandedClicks: 0 };
    }
    const urlKey = location.href.split('#')[0];
    if (state.visitedHistory[urlKey]) {
      state.phase = 'details'; saveState(state); return goNext(state);
    }
    state.historyPages++;
    if (!stateAccountIsCurrent(state)) { pauseForAccountMismatch(state); return; }

    const c = getConfig();
    const cache = getCache(c.account);
    // V3.1 : union exhaustive ET temporelle. On utilise toutes les commandes vues
    // pendant la stabilisation, pas seulement l'instantané du DOM au moment du traitement.
    const candidates = stablePage.candidates || [];
    state.historyDiagnostics ||= [];
    state.historyDiagnostics.push({ page: state.historyPages, url: location.href, ...(stablePage.diagnostics || {}) });
    state.historyDiagnostics = state.historyDiagnostics.slice(-30);
    if (state.mode === 'search') {
      const audit = stablePage.audit || searchAuditForCurrentHistoryPage(state.searchQuery || '', historyOrderCandidates(document));
      state.stats.searchLabels = (state.stats.searchLabels || 0) + audit.matchedLabels;
      state.stats.searchCards = (state.stats.searchCards || 0) + audit.matchedCards;
      state.stats.searchResolvedCards = (state.stats.searchResolvedCards || 0) + audit.resolvedCards;
      state.stats.searchUnresolvedCards = (state.stats.searchUnresolvedCards || 0) + audit.unresolvedCards;
      state.searchAudit ||= [];
      if (audit.unresolvedCards) {
        state.searchAudit.push({ page: state.historyPages, url: location.href, unresolved: audit.unresolved });
        state.searchAudit = state.searchAudit.slice(-20);
      }
    }
    let oldestTs = Infinity;
    let knownDates = 0;
    let unknownDates = 0;
    // Sur la page mobile Amazon observée le 17/09/2026, les cartes d'historique
    // affichent « Livraison prévue … » mais PAS la date de commande. On complète
    // donc les dates avec le cache local puis, en une seule requête, avec les dates
    // déjà connues dans Google Sheets. Seules les commandes encore inconnues seront
    // ouvertes en page détail pour obtenir leur date réelle.
    let serverDates = {}, smartOrders = {};
    if (state.mode !== 'search') {
      state.lastMessage = `Google : vérification des dates de ${candidates.length} commande(s)…`;
      setScanOperation(state, 'google-dates', { orders:candidates.length });
      const knownState = await fetchKnownOrderState(candidates.map(x => x.orderId));
      serverDates = knownState.dates || {};
      smartOrders = knownState.orders || {};
      state.smartCacheSource = knownState.source || '';
      clearScanOperation(state);
    }

    for (const candidate of candidates) {
      const cardTexts = candidate.cardTexts?.length ? candidate.cardTexts : (candidate.cards || []).map(card => normalizeText(card.innerText || '')).filter(Boolean);
      const cached = cache[candidate.orderId];
      const liveDate = candidate.orderDate || cardTexts.map(extractOrderDate).find(Boolean) || extractOrderDateNearOrderId(document.body?.innerText || '', candidate.orderId) || '';
      const orderDate = chooseKnownOrderDate(liveDate, cached?.orderDate, serverDates[candidate.orderId]);
      const d = orderDate ? new Date(`${orderDate}T12:00:00`) : null;
      if (d && !Number.isNaN(d.getTime())) { oldestTs = Math.min(oldestTs, d.getTime()); knownDates++; } else { unknownDates++; }

      let rangePending = false;
      if (state.mode !== 'search') {
        const rangeClass = classifyOrderDateForRange(orderDate, state.cutoffTs, Date.now(), state.rangeEndTs);
        markRangeAudit(state, rangeClass, candidate.orderId);
        if (rangeClass === 'OUTSIDE') continue;
        // UNKNOWN n'est jamais accepté comme « dans les 7/30 jours ». Il est mis
        // en file uniquement pour ouvrir la page détail et y lire OrderDate.
        rangePending = rangeClass === 'UNKNOWN';
      }

      if (state.mode === 'search' && !cardTexts.some(t => matchesDeliveryQuery(t, state.searchQuery || ''))) continue;

      const serverHasOrder = !!validIsoOrderDate(serverDates[candidate.orderId]);
      const smartRow = smartOrders[candidate.orderId] || null;
      if (state.mode === 'range') {
        const decision = smartCacheDecision(state,cached,smartRow,{rangePending,serverHasOrder});
        if (!cached && !smartRow) state.stats.smartNew=(state.stats.smartNew||0)+1;
        const counter = {SKIP_FINAL:'smartSkippedFinal',SKIP_RECENT:'smartSkippedRecent',SKIP_PENDING:'smartSkippedPending'}[decision.action];
        if (counter) { state.stats[counter]=(state.stats[counter]||0)+1; continue; }
        if (decision.action === 'DIRECT_TRACKING' && enqueueSmartDirectTracking(state,smartRow,candidate,orderDate)>0) {
          state.stats.smartDirectTracking=(state.stats.smartDirectTracking||0)+1;
          continue;
        }
      }

      state.orderQueue.push({
        url: canonicalOrderDetailUrl(candidate.orderId),
        sourceUrl: candidate.sourceUrl || candidate.url,
        historyTrackingUrls: candidate.historyTrackingUrls || [],
        historyItems: candidate.historyItems || [],
        orderId: candidate.orderId,
        orderDate,
        rangePending,
        searchMatched: state.mode === 'search' ? true : undefined,
        searchQuery: state.mode === 'search' ? state.searchQuery : undefined
      });
      cache[candidate.orderId] = { ...(cached || {}), orderId: candidate.orderId, detailUrl: candidate.sourceUrl || candidate.url, orderDate: orderDate || cached?.orderDate || '', lastSeen: nowIso(), trackingComplete: cached?.trackingComplete === true };
    }
    state.orderQueue = uniqBy(state.orderQueue, x => x.orderId);
    state.stats.orders = new Set([...state.orderQueue.map(x=>x.orderId),...(state.trackQueue||[]).map(x=>x?.context?.orderId)].filter(Boolean)).size;
    saveCache(c.account, cache);
    state.visitedHistory[urlKey] = true;
    delete state.retryCounts?.[`history:${urlKey}`];

    const maxPages = state.mode === 'search' ? c.maxHistoryPagesSearch : (state.customRangeStart ? c.maxHistoryPagesSearch : (state.days <= 7 ? c.maxHistoryPages7 : c.maxHistoryPages30));
    const reachedCutoff = state.mode !== 'search' && unknownDates === 0 && knownDates > 0 && oldestTs < state.cutoffTs;
    const next = findNextHistoryUrl();
    state.lastMessage = state.mode === 'search'
      ? `Recherche "${state.searchQuery}" (${state.deliverySearchLookbackDays || state.days} j max) — page ${state.historyPages}/${maxPages} — ${state.orderQueue.length} OrderID · ${state.stats.searchLabels || 0} résultat(s) · ${state.stats.searchUnresolvedCards || 0} sans OrderID · stable ${stablePage.diagnostics?.unionCount ?? candidates.length}`
      : `Historique ${state.historyPages}/${maxPages} — période ${state.stats.rangeIncluded || 0} · date inconnue ${state.stats.rangeUnknown || 0} · hors période ${state.stats.rangeOutside || 0} · à traiter ${state.orderQueue.length} · stable ${stablePage.diagnostics?.unionCount ?? candidates.length}`;
    saveState(state);

    if (next && !reachedCutoff && state.historyPages >= maxPages && !state.visitedHistory[next]) throw new Error(`Limite de sécurité historique atteinte (${maxPages} pages) avant la fin de la période.`);
    if (next && !reachedCutoff && state.historyPages < maxPages && !state.visitedHistory[next]) {
      await sleep(randomDelay()); navigateTo(next); return;
    }

    // Les dates absentes de l'historique mobile ne bloquent plus le scan : ces
    // commandes sont maintenant résolues une par une sur leur page détail.

    state.phase = 'details';
    saveState(state);
    return goNext(state);
  }

  async function fallbackToHistoryTrackingUrls(state, queued) {
    if (!stateAccountIsCurrent(state)) { pauseForAccountMismatch(state); return false; }
    const orderId = queued.orderId;
    const supplied = uniqBy((queued.historyTrackingUrls || []).filter(Boolean), u => shipmentIdentityFromUrl(u, 1));
    const mismatched = supplied.filter(u => !trackingUrlMatchesOrder(u, orderId));
    const urls = supplied.filter(u => trackingUrlMatchesOrder(u, orderId));
    if (!urls.length && mismatched.length) throw new Error(`Historique incohérent : ${mismatched.length} lien(s) de suivi appartiennent à une autre commande que ${orderId}`);
    if (!urls.length) return false;
    const c = getConfig();
    const orderDate = queued.orderDate || '';
    const pageTracks = trackLinks(document).filter(tr => parseOrderId(tr.url) === orderId);
    let shipmentNo = 0;
    const contexts = [];

    for (const url of urls) {
      shipmentNo++;
      const identity = shipmentIdentityFromUrl(url, shipmentNo);
      const pageTrack = pageTracks.find(tr => shipmentIdentityFromUrl(tr.url, shipmentNo) === identity) || null;
      const container = pageTrack?.el ? findMeaningfulContainer(pageTrack.el, orderId) : null;
      const text = container ? normalizeText(container.innerText || '') : '';
      let items = container ? extractItems(container) : [];
      // V3.3.7.4 : si le détail Amazon est indisponible mais qu'il n'y a qu'un
      // seul colis pour cette commande, les ASIN capturés sur la carte historique
      // peuvent être associés sans ambiguïté à ce colis.
      if (!items.length && urls.length === 1 && Array.isArray(queued.historyItems) && queued.historyItems.length) {
        items = uniqBy(queued.historyItems.filter(it => it && it.asin), x => x.asin);
      }
      const hint = trackingCandidateFromUrl(url);
      const rec = {
        shipmentKey: makeShipmentKey(c.account, orderId, url, shipmentNo), account: c.account, orderId, orderDate,
        shipmentNo, trackingId: hint.value || '', trackingConfidence: hint.confidence || '', trackingVerified: false, carrier: container ? detectCarrier(text, [url]) : '',
        status: container ? extractStatus(text) : '', delivered: container ? isDelivered(text) : false,
        deliveredDate: container ? extractDeliveredDate(text) : '', shipDate: container ? extractShipDate(text) : '',
        expectedDelivery: container ? extractExpectedDelivery(text) : '', expectedDeliveryText: container ? extractExpectedDeliveryText(text) : '', expectedDeliveryStart: container ? extractExpectedDeliveryRange(text).start : '', expectedDeliveryEnd: container ? extractExpectedDeliveryRange(text).end : '',
        trackingUrl: url, itemsCount: items.length, dataQuality: 'A_VERIFIER',
        warnings: 'detail_commande_indisponible_progress_tracker_direct', lastSeen: nowIso(), source: 'history-progress-tracker-fallback'
      };
      contexts.push(rec);
      state.trackQueue.push({ url, context: rec, items: items.map(it => ({ ...it, assignmentQuality: urls.length === 1 ? 'HIGH' : 'UNKNOWN' })) });
    }

    state.trackQueue = uniqBy(state.trackQueue, x => x.context.shipmentKey);
    state.stats.detailsProcessed = (state.stats.detailsProcessed || 0) + 1;
    state.stats.shipments += contexts.length;
    const cache = getCache(c.account);
    const old = cache[orderId] || {};
    const oldShipments = old.shipments || {};
    const nextShipments = { ...oldShipments };
    for (const rec of contexts) {
      nextShipments[rec.shipmentKey] = {
        ...(nextShipments[rec.shipmentKey] || {}),
        trackingFound: false,
        trackingId: rec.trackingId || nextShipments[rec.shipmentKey]?.trackingId || '',
        trackingConfidence: rec.trackingConfidence || nextShipments[rec.shipmentKey]?.trackingConfidence || '',
        trackingVerified: false,
        carrier: rec.carrier || nextShipments[rec.shipmentKey]?.carrier || '',
        terminal: false,
        delivered: rec.delivered === true || nextShipments[rec.shipmentKey]?.delivered === true
      };
    }
    cache[orderId] = {
      ...old, orderId, detailUrl: queued.url || old.detailUrl || '', sourceDetailUrl: queued.sourceUrl || old.sourceDetailUrl || '',
      orderDate: orderDate || old.orderDate || '', lastSeen: nowIso(), lastChecked: nowIso(), expectedShipments: contexts.length,
      shipments: nextShipments, trackingComplete: false, terminalNoTracking: false
    };
    saveCache(c.account, cache);
    void smartDbMergeOrder(c.account,{orderId,orderDate:cache[orderId]?.orderDate||orderDate||'',lastChecked:cache[orderId]?.lastChecked||nowIso(),trackingComplete:cache[orderId]?.trackingComplete===true,delivered:cache[orderId]?.delivered===true,terminalNoTracking:cache[orderId]?.terminalNoTracking===true,uncertain:shipments.some(x=>x.dataQuality==='A_VERIFIER')||itemsOut.some(x=>x.dataQuality==='A_VERIFIER'),shipments,items:itemsOut}).catch(e=>log('Smart Cache détail',e));
    state.visitedOrders[orderId] = true;
    state.lastMessage = `${orderId}: page détail indisponible — ${contexts.length} lien(s) progress-tracker récupéré(s) depuis l'historique`;
    saveState(state);
    return goNext(state);
  }

  async function processDetails(state) {
    if (!stateAccountIsCurrent(state)) { pauseForAccountMismatch(state); return; }
    const queued = state.currentOrder || {};
    if (!queued.orderId) throw new Error('Commande courante absente pendant la phase détail');

    if (isHistoryPage()) {
      // Si Amazon mobile renvoie le détail vers l'historique mais que l'historique contenait déjà
      // des liens /progress-tracker/package, on les utilise explicitement au lieu de perdre la commande.
      if ((queued.historyTrackingUrls || []).length) {
        return fallbackToHistoryTrackingUrls(state, queued);
      }
      state.detailFallbackTried ||= {};
      if (!state.detailFallbackTried[queued.orderId]) {
        state.detailFallbackTried[queued.orderId] = true;
        state.lastMessage = `${queued.orderId}: ouverture détail canonique…`;
        saveState(state);
        await sleep(randomDelay());
        navigateTo(canonicalOrderDetailUrl(queued.orderId));
        return;
      }
      throw new Error(`Amazon renvoie vers l'historique au lieu du détail pour ${queued.orderId}`);
    }

    setScanOperation(state, 'details-wait', { orderId: state.currentOrder?.orderId || parseOrderId(location.href) || '' });
    if (document.readyState !== 'complete') await waitUntil(() => document.readyState === 'complete', 4000, 250);
    const fastDom = await waitForFastDomStructure('details', queued.orderId);
    if (!fastDom.ready) {
      // Amazon injecte parfois le bouton de suivi / les ASIN après le premier rendu.
      // On garde le moteur sémantique comme filet de sécurité, mais ce n'est plus le
      // chemin normal lorsque les balises HTML utiles sont déjà présentes.
      await waitForCurrentPageReady('details');
      await waitForStableSemanticPage('details', queued.orderId);
    }
    state.lastDomFastPath = { kind:'details', orderId:queued.orderId, ...fastDom, at:nowIso(), url:location.href };
    clearScanOperation(state);
    if (!stateAccountIsCurrent(state)) { pauseForAccountMismatch(state); return; }
    if (isUnsafeAmazonOrderActionUrl(location.href)) {
      throw new Error(`Navigation refusée : page d'action Amazon interdite (${location.pathname})`);
    }
    const bodyTextBefore = normalizeText(document.body?.innerText || '');
    const visibleOrderId = parseOrderId(location.href) || parseOrderId(bodyTextBefore);
    if (!isOrderDetailPage() && !bodyTextBefore.includes(queued.orderId) && visibleOrderId !== queued.orderId) {
      throw new Error(`Page détail non reconnue (${location.pathname}) pour ${queued.orderId}`);
    }
    if (visibleOrderId && visibleOrderId !== queued.orderId) {
      throw new Error(`Mauvaise commande affichée: attendu ${queued.orderId}, reçu ${visibleOrderId}`);
    }

    const pageCtx = extractOrderContextFromPage();
    const orderId = pageCtx.orderId || queued.orderId;
    if (!orderId) throw new Error('Numéro de commande introuvable sur la page détail');
    if (state.visitedOrders[orderId]) return goNext(state);

    const c = getConfig();
    const cache = getCache(c.account);
    const fullText = normalizeText(document.body.innerText || '');
    // Ne jamais déduire OrderDate à partir d'une date de livraison. Si l'historique
    // mobile ne donnait aucune date, la page détail devient la source de vérité.
    const orderDate = chooseKnownOrderDate(queued.orderDate, pageCtx.orderDate, cache[orderId]?.orderDate);
    if (state.mode === 'range') {
      const rangeClass = classifyOrderDateForRange(orderDate, state.cutoffTs, Date.now(), state.rangeEndTs);
      markRangeAudit(state, rangeClass, orderId);
      if (rangeClass === 'UNKNOWN') {
        state.active = false;
        state.paused = true;
        state.lastMessage = `Pause diagnostic : la page détail de ${orderId} ne contient toujours aucune date de commande exploitable. Aucune donnée de cette commande n'a été écrite.`;
        saveState(state);
        toast('Date de commande absente même sur la page détail — diagnostic requis.', 'error');
        return;
      }
      // Sauvegarder la date résolue même pour une ancienne commande afin que les
      // scans suivants puissent la filtrer sans rouvrir sa page détail.
      const oldDateCache = cache[orderId] || {};
      cache[orderId] = { ...oldDateCache, orderId, detailUrl: queued.url || oldDateCache.detailUrl || '', sourceDetailUrl: queued.sourceUrl || oldDateCache.sourceDetailUrl || '', orderDate, lastSeen: nowIso() };
      saveCache(c.account, cache);
      if (rangeClass === 'OUTSIDE') {
        state.visitedOrders[orderId] = true;
        journalCommit(state,'details',orderId,'outside-range');
        state.stats.orders = Math.max(0, Number(state.stats.orders || 0) - 1);
        state.lastMessage = `${orderId}: date ${orderDate}, hors période — ignorée`;
        saveState(state);
        return goNext(state);
      }
    }
    const orderRoot = findOrderRoot(orderId);
    let allItems = extractItems(orderRoot);
    const rootPartition = partitionTrackingLinksByOrder(trackLinks(orderRoot), orderId, true);
    let rawTracks = rootPartition.valid;
    let rejectedOrderLinks = rootPartition.mismatched.length;
    if (!rawTracks.length && orderRoot !== document) {
      const docPartition = partitionTrackingLinksByOrder(trackLinks(document), orderId, false);
      rawTracks = docPartition.valid;
      rejectedOrderLinks += docPartition.mismatched.length;
    }
    // Filet de sécurité Amazon mobile : les cartes de l'historique peuvent déjà contenir les URLs progress-tracker
    // alors que la page détail canonique n'affiche aucun bouton de suivi. Les liens avec un OrderID explicite différent
    // sont toujours rejetés avant la création d'un ShipmentKey ou d'un tracking provisoire.
    const historyCandidateTracks = (queued.historyTrackingUrls || []).map(url => {
      const hint = trackingCandidateFromUrl(url);
      return { el: null, url, external: !isAmazonFrUrl(url), orderContextVerified: true, trackingHint: hint.value || '', trackingHintSource: hint.source || '', trackingHintConfidence: hint.confidence || '' };
    });
    const historyPartition = partitionTrackingLinksByOrder(historyCandidateTracks, orderId, true);
    const historyRawTracks = historyPartition.valid;
    rejectedOrderLinks += historyPartition.mismatched.length;
    if (historyRawTracks.length > rawTracks.length) rawTracks = historyRawTracks;
    rawTracks = uniqBy(rawTracks, tr => `${parseOrderId(tr.url) || orderId}|${shipmentIdentityFromUrl(tr.url, 1)}`);
    // Même principe que le fallback historique : pour une commande mono-colis,
    // réutiliser les ASIN sûrs capturés sur l'historique si le détail ne les rend
    // pas. En multi-colis on n'invente aucune attribution.
    if (!allItems.length && rawTracks.length === 1 && Array.isArray(queued.historyItems) && queued.historyItems.length) {
      allItems = uniqBy(queued.historyItems.filter(it => it && it.asin), x => x.asin);
    }
    if (!rawTracks.length && rejectedOrderLinks > 0) throw new Error(`Liens de suivi incohérents : ${rejectedOrderLinks} lien(s) appartiennent à une autre commande que ${orderId}`);
    const unresolvedControls = unresolvedTrackControls(orderRoot).length || (orderRoot !== document ? unresolvedTrackControls(document).length : 0);
    if (!rawTracks.length && unresolvedControls > 0) throw new Error(`Bouton de suivi détecté mais URL inaccessible (${unresolvedControls}) — diagnostic requis`);
    const shipmentGroups = new Map();

    rawTracks.forEach((tr, idx) => {
      const shipmentKey = makeShipmentKey(c.account, orderId, tr.url, idx + 1);
      const container = findMeaningfulContainer(tr.el, orderId);
      const containerText = container ? normalizeText(container.innerText || '') : '';
      let itsItems = container ? extractItems(container) : [];
      let assignmentQuality = itsItems.length ? 'HIGH' : 'UNKNOWN';
      const warnings = [];
      if (!orderDate) warnings.push('order_date_inconnue');
      if (!itsItems.length && rawTracks.length === 1) {
        itsItems = allItems;
        assignmentQuality = allItems.length ? 'HIGH' : 'UNKNOWN';
      } else if (!itsItems.length && rawTracks.length > 1) {
        warnings.push('items_non_associes_au_colis');
      }
      const status = extractStatus(containerText) || pageCtx.status;
      const existing = shipmentGroups.get(shipmentKey);
      const hint = trackingCandidate(tr.trackingHint || '', tr.trackingHintSource || 'url', tr.trackingHintConfidence || 'HIGH');
      if (!existing) {
        shipmentGroups.set(shipmentKey, {
          url: tr.url,
          external: !!tr.external,
          orderContextVerified: tr.orderContextVerified === true,
          container,
          items: itsItems,
          assignmentQuality,
          warnings,
          trackingHint: hint?.value || '',
          trackingHintConfidence: hint?.confidence || '',
          status,
          carrier: detectCarrier(containerText, [tr.url]),
          shipDate: extractShipDate(containerText),
          expectedDelivery: extractExpectedDelivery(containerText),
          expectedDeliveryText: extractExpectedDeliveryText(containerText),
          expectedDeliveryStart: extractExpectedDeliveryRange(containerText).start,
          expectedDeliveryEnd: extractExpectedDeliveryRange(containerText).end,
          deliveredDate: extractDeliveredDate(containerText)
        });
      } else {
        existing.items = uniqBy([...(existing.items || []), ...itsItems], x => x.asin || hashString(x.title));
        if (!existing.status && status) existing.status = status;
        existing.warnings = [...new Set([...(existing.warnings || []), ...warnings])];
      }
    });

    // Détecte les ASIN associés à plusieurs colis. On ne masque jamais l'ambiguïté.
    if (shipmentGroups.size > 1) {
      const owners = new Map(), ambiguousAsins = new Set();
      for (const [key, g] of shipmentGroups.entries()) {
        for (const it of (g.items || [])) {
          if (!it.asin) continue;
          const set = owners.get(it.asin) || new Set(); set.add(key); owners.set(it.asin, set);
        }
      }
      for (const [asin, keys] of owners.entries()) {
        if (keys.size <= 1) continue;
        ambiguousAsins.add(asin);
        for (const key of keys) {
          const g = shipmentGroups.get(key); g.assignmentQuality = 'AMBIGUOUS'; g.warnings = [...new Set([...(g.warnings || []), `asin_multi_colis:${asin}`])];
        }
      }
      // Ne jamais laisser un ASIN ambigu dans plusieurs colis physiques : il sera
      // conservé une seule fois sous ShipmentKey « unassigned » plus bas.
      if (ambiguousAsins.size) for (const g of shipmentGroups.values()) g.items = (g.items || []).filter(it => !it.asin || !ambiguousAsins.has(it.asin));
    }

    const shipments = [];
    const itemsOut = [];
    const confidentlyAssigned = new Set();
    let shipmentNo = 0;
    for (const [shipmentKey, g] of shipmentGroups.entries()) {
      shipmentNo++;
      const itsItems = g.items || [];
      const warnings = [...new Set(g.warnings || [])];
      const trackingId = g.trackingHint || '';
      const trackingConfidence = trackingId ? (g.trackingHintConfidence || 'HIGH') : '';
      // Un hint Amazon interne n'est jamais certifié physiquement avant d'avoir ouvert
      // la page de suivi et vérifié son OrderID. Un lien transporteur externe peut être
      // certifié ici seulement s'il provient d'un contexte de commande déjà corrélé.
      const trackingVerified = g.external === true && g.orderContextVerified === true && isAuthoritativeTracking(trackingId, trackingConfidence, true, false);
      if (trackingId && g.external === true && !trackingVerified) warnings.push(`tracking_source_${trackingConfidence || 'inconnue'}`);
      if (shipmentGroups.size > 1 && !g.expectedDeliveryStart) warnings.push('date_livraison_colis_inconnue');
      const quality = warnings.length ? 'A_VERIFIER' : 'OK';
      const status = g.status || pageCtx.status || '';
      const singleRange = shipmentGroups.size === 1 ? extractExpectedDeliveryRange(fullText) : {start:'', end:'', text:''};
      const expectedDelivery = g.expectedDelivery || singleRange.start || '';
      const expectedDeliveryText = g.expectedDeliveryText || singleRange.text || '';
      const expectedDeliveryStart = g.expectedDeliveryStart || singleRange.start || '';
      const expectedDeliveryEnd = g.expectedDeliveryEnd || singleRange.end || '';
      const deliveryEvidenceText = g.container ? normalizeText(g.container.innerText || '') : (shipmentGroups.size === 1 ? fullText : status);
      const deliveredDate = g.deliveredDate || extractDeliveredDate(deliveryEvidenceText) || extractDeliveredDate(status);
      const delivered = deliveredWithExpectedDateGuard(status, deliveryEvidenceText, expectedDeliveryEnd);
      const rec = {
        shipmentKey, account: c.account, orderId, orderDate,
        shipmentNo, trackingId, trackingConfidence, trackingVerified, carrier: g.carrier || '',
        status, delivered, deliveredDate, shipDate: g.shipDate || '',
        expectedDelivery, expectedDeliveryText, expectedDeliveryStart, expectedDeliveryEnd, trackingUrl: g.url,
        itemsCount: itsItems.length, dataQuality: quality, warnings: warnings.join(';'), lastSeen: nowIso(), source: g.external ? 'order-details-external-link' : 'order-details'
      };
      shipments.push(rec);
      itsItems.forEach(it => {
        if (g.assignmentQuality === 'HIGH' && it.asin) confidentlyAssigned.add(it.asin);
        itemsOut.push({
          itemKey: `${shipmentKey}|${it.asin || hashString(it.title)}`,
          shipmentKey, account: c.account, orderId, orderDate,
          asin: it.asin, title: it.title, quantity: it.quantity || 1, productUrl: it.productUrl,
          trackingId, carrier: rec.carrier, status: rec.status, delivered: rec.delivered,
          assignmentQuality: g.assignmentQuality || 'UNKNOWN', dataQuality: quality, warnings: warnings.join(';'), lastSeen: nowIso()
        });
      });

      // Les pages externes ne sont pas visitées par le userscript Amazon. Le tracking doit être présent dans l'URL pour être considéré trouvé.
      if (!g.external) {
        state.trackQueue.push({ url: g.url, context: rec, items: itsItems.map(it => ({ ...it, assignmentQuality: g.assignmentQuality || 'UNKNOWN' })), queuePriority:Math.max(12,Number(queued.queuePriority||50)-2), queueReason:'tracking-from-detail' });
      } else if (!trackingId) {
        rec.dataQuality = 'A_VERIFIER';
        rec.warnings = [...new Set([...(rec.warnings ? rec.warnings.split(';') : []), 'lien_transporteur_externe_sans_tracking'])].filter(Boolean).join(';');
        state.stats.pending++;
      } else if (trackingVerified) {
        state.stats.trackingFound++;
      } else {
        state.stats.uncertain++;
      }
    }

    // Articles non associables avec certitude à un colis : conservés à part, jamais attribués au hasard.
    if (shipmentGroups.size > 1) {
      for (const it of allItems) {
        if (!it.asin || confidentlyAssigned.has(it.asin)) continue;
        const unassignedKey = `${c.account}|${orderId}|unassigned`;
        itemsOut.push({
          itemKey: `${unassignedKey}|${it.asin || hashString(it.title)}`,
          shipmentKey: unassignedKey, account: c.account, orderId, orderDate,
          asin: it.asin, title: it.title, quantity: it.quantity || 1, productUrl: it.productUrl,
          trackingId: '', carrier: '', status: pageCtx.status || '', delivered: deliveredWithExpectedDateGuard(pageCtx.status || '', fullText, extractExpectedDeliveryRange(fullText).end),
          assignmentQuality: 'UNASSIGNED', dataQuality: 'A_VERIFIER', warnings: 'article_non_associe_a_un_colis', lastSeen: nowIso()
        });
      }
    }

    let terminalNoTracking = false;
    if (!shipments.length) {
      const pseudoUrl = `order:${orderId}:pending`;
      const shipmentKey = makeShipmentKey(c.account, orderId, pseudoUrl, 1);
      const status = pageCtx.status || extractStatus(fullText) || 'Pas encore expédié';
      const ageDays = orderDate ? Math.floor((Date.now() - new Date(`${orderDate}T12:00:00`).getTime()) / 86400000) : 0;
      terminalNoTracking = isCancelled(status) || (!!orderDate && ageDays >= Number(c.noTrackingFinalAfterDays || 14) && !isPendingShipment(status));
      const pendingRange = extractExpectedDeliveryRange(fullText);
      const pendingDeliveredDate = extractDeliveredDate(fullText) || extractDeliveredDate(status);
      const pendingDelivered = deliveredWithExpectedDateGuard(status, fullText, pendingRange.end);
      const rec = {
        shipmentKey, account: c.account, orderId, orderDate, shipmentNo: 1,
        trackingId: '', trackingConfidence: '', trackingVerified: false, carrier: '', status, delivered: pendingDelivered, deliveredDate: pendingDeliveredDate, shipDate: '',
        expectedDelivery: pendingRange.start || '', expectedDeliveryText: pendingRange.text || '', expectedDeliveryStart: pendingRange.start || '', expectedDeliveryEnd: pendingRange.end || '', trackingUrl: '',
        itemsCount: allItems.length, dataQuality: orderDate ? 'OK' : 'A_VERIFIER', warnings: orderDate ? '' : 'order_date_inconnue', lastSeen: nowIso(), source: terminalNoTracking ? 'order-details-no-tracking-final' : 'order-details-pending'
      };
      shipments.push(rec);
      allItems.forEach(it => itemsOut.push({
        itemKey: `${shipmentKey}|${it.asin || hashString(it.title)}`,
        shipmentKey, account: c.account, orderId, orderDate,
        asin: it.asin, title: it.title, quantity: it.quantity || 1, productUrl: it.productUrl,
        trackingId: '', carrier: '', status, delivered: rec.delivered,
        assignmentQuality: 'HIGH', dataQuality: orderDate ? 'OK' : 'A_VERIFIER', warnings: orderDate ? '' : 'order_date_inconnue', lastSeen: nowIso()
      }));
      state.stats.pending++;
    }

    state.stats.detailsProcessed = (state.stats.detailsProcessed || 0) + 1;
    state.stats.shipments += shipments.length;
    state.stats.delivered += shipments.filter(x => x.delivered).length;
    const queuedTrackingKeys = new Set(state.trackQueue.map(x => x.context.shipmentKey));
    state.stats.uncertain += shipments.filter(x => x.dataQuality === 'A_VERIFIER' && !queuedTrackingKeys.has(x.shipmentKey)).length;
    state.trackQueue = uniqBy(state.trackQueue, x => x.context.shipmentKey);
    mergeBuffer(state, shipments, itemsOut);
    const priorityExternalReady = state.priorityTracking === true && shipments.some(sh => sh.trackingVerified === true) && itemsOut.some(it => !!it.asin && !!it.trackingId);
    await flushBuffer(state, priorityExternalReady);

    const expected = shipmentGroups.size;
    const old = cache[orderId] || {};
    const previousShipments = old.shipments || {};
    const currentShipments = { ...previousShipments };
    for (const sh of shipments) {
      const previous = previousShipments[sh.shipmentKey] || {};
      const confirmedNow = sh.trackingVerified === true;
      const prevTr = normalizeKey(previous.trackingId || ''), newTr = normalizeKey(sh.trackingId || '');
      const cacheConflict = previous.trackingVerified === true && confirmedNow && prevTr && newTr && prevTr !== newTr;
      currentShipments[sh.shipmentKey] = {
        ...previous,
        trackingFound: cacheConflict ? false : (previous.trackingFound === true || confirmedNow),
        trackingId: cacheConflict ? (previous.trackingId || sh.trackingId || '') : (sh.trackingId || previous.trackingId || ''),
        trackingConfidence: cacheConflict ? (previous.trackingConfidence || sh.trackingConfidence || '') : (sh.trackingConfidence || previous.trackingConfidence || ''),
        trackingVerified: cacheConflict ? false : (previous.trackingVerified === true || confirmedNow),
        carrier: sh.carrier || previous.carrier || '',
        terminal: terminalNoTracking || previous.terminal === true,
        delivered: isExplicitNonDeliveredStatus(sh.status) ? false : (previous.delivered === true || sh.delivered === true),
        conflict: cacheConflict || previous.conflict === true
      };
    }
    const canonicalShipments = canonicalizeCachedShipments(currentShipments);
    const canonicalExpected = Object.keys(canonicalShipments).length;
    cache[orderId] = {
      ...old, orderId, detailUrl: location.href || queued.url, sourceDetailUrl: queued.sourceUrl || old.sourceDetailUrl || '', orderDate: orderDate || old.orderDate || '',
      lastSeen: nowIso(), lastChecked: nowIso(), expectedShipments: canonicalExpected,
      shipments: canonicalShipments,
      trackingComplete: canonicalExpected > 0 ? Object.values(canonicalShipments).every(x => x.trackingFound === true || x.terminal === true) : terminalNoTracking,
      terminalNoTracking: canonicalExpected === 0 && terminalNoTracking,
      delivered: canonicalExpected > 0 && Object.values(canonicalShipments).every(x => x.delivered === true)
    };
    saveCache(c.account, cache);
    state.visitedOrders[orderId] = true;
    journalCommit(state,'details',orderId,'ok');
    delete state.retryCounts?.[`order:${orderId}`];

    state.detailsSinceTracking = Number(state.detailsSinceTracking || 0) + 1;
    const batchSize = state.priorityTracking === true ? 1 : Math.max(1, Number(c.detailsBatchSize || 8));
    if (state.trackQueue.length && state.detailsSinceTracking >= batchSize) {
      state.phase = 'tracking';
      state.detailsSinceTracking = 0;
    }
    state.lastMessage = `${orderId}: ${shipments.length} colis détecté(s)${state.trackQueue.length ? ' — suivi à lire' : ''}${terminalNoTracking ? ' — suivi indisponible/final' : ''}`;
    saveState(state);
    return goNext(state);
  }

  function canIgnoreTrackingPageExtraAsins_(knownItems, orderVerified, trackingVerified) {
    const items = (knownItems || []).filter(it => it && it.asin);
    if (!orderVerified || !trackingVerified || !items.length) return false;
    return items.every(it => String(it.assignmentQuality || '').toUpperCase() === 'HIGH');
  }

  async function processTracking(state) {
    if (!stateAccountIsCurrent(state)) { pauseForAccountMismatch(state); return; }
    if (location.hostname.toLowerCase() !== 'track.amazon.fr' && !isAmazonTrackingUrl(location.href)) {
      throw new Error(`Navigation refusée : URL non autorisée comme suivi (${location.pathname})`);
    }
    const q=state.currentTracking;
    if(!q?.context?.shipmentKey)throw new Error('Contexte colis absent pendant la phase tracking');
    const provisionalKey=q.context.shipmentKey, expectedOrderId=q.context.orderId;
    if(state.visitedTracking[provisionalKey])return goNext(state);
    const initialText=normalizeText(document.body?.innerText||'');
    if(!isTrackingPage()&&!/suivi|tracking|colis|package|livraison/i.test(initialText))throw new Error(`Page de suivi non reconnue (${location.pathname}) pour ${expectedOrderId}`);
    // V3.3.7.7 : correction générale du progress-tracker vide. Le correctif V3.3.7.3
    // ne s'appliquait qu'au bouton ⚡. Un scan 7/15/30 normal pouvait donc encore
    // boucler sur waitForCurrentPageReady() lorsque l'URL était valide mais le DOM vide.
    // Désormais TOUS les modes utilisent un probe borné et une URL + OrderID valides
    // suffisent pour classer « suivi pas encore visible » puis continuer, sans reload.
    const maxProbeSec = state.priorityTracking === true ? 9 : 12;
    state.lastMessage = `${state.priorityTracking ? '⚡ ' : ''}${expectedOrderId}: lecture page suivi (${maxProbeSec} s max)…`;
    setScanOperation(state, 'tracking-probe', { orderId:expectedOrderId, shipmentKey:provisionalKey, expectedMaxSec:maxProbeSec });
    if (document.readyState !== 'complete') await waitUntil(() => document.readyState === 'complete', 4000, 300);
    let trackingProbe;
    if (state.forceTrackingProbeSkip?.[provisionalKey]) {
      delete state.forceTrackingProbeSkip[provisionalKey];
      trackingProbe = { stable:true, priority:state.priorityTracking===true, reason:'watchdog-probe-skip', samples:0, elapsedMs:0, counts:{} };
    } else {
      const fastDom = await waitForFastDomStructure('tracking', expectedOrderId);
      state.lastDomFastPath = { kind:'tracking', orderId:expectedOrderId, shipmentKey:provisionalKey, ...fastDom, at:nowIso(), url:location.href };
      trackingProbe = fastDom.ready
        ? { stable:true, priority:state.priorityTracking===true, reason:fastDom.reason, samples:fastDom.samples, elapsedMs:fastDom.elapsedMs, counts:fastDom.counts }
        : await waitForBoundedTrackingPage(expectedOrderId, state.priorityTracking === true);
    }
    state.lastTrackingProbe = {
      orderId: expectedOrderId,
      reason: trackingProbe?.reason || '',
      stable: trackingProbe?.stable === true,
      samples: Number(trackingProbe?.samples || 0),
      elapsedMs: Number(trackingProbe?.elapsedMs || 0),
      url: location.href,
      at: nowIso(),
    };
    state.lastMessage = `${state.priorityTracking ? '⚡ ' : ''}${expectedOrderId}: analyse du suivi…`;
    setScanOperation(state, 'tracking-parse', { orderId:expectedOrderId, shipmentKey:provisionalKey, probeReason:trackingProbe?.reason || '' });
    if (trackingProbe?.reason === 'challenge' || trackingProbe?.reason === 'rate-limited') {
      state.active = false;
      state.paused = true;
      state.lastMessage = trackingProbe.reason === 'challenge'
        ? 'Pause : contrôle Amazon détecté sur la page de suivi. Termine-le puis Reprendre.'
        : 'Pause faible trafic : limitation/indisponibilité Amazon détectée. Aucun reload automatique.';
      saveState(state);
      toast(state.lastMessage, 'error');
      return;
    }
    if (!stateAccountIsCurrent(state)) { pauseForAccountMismatch(state); return; }

    const c=getConfig(), text=normalizeText(document.body.innerText||'');
    const urlOrderId=parseOrderId(location.href), textOrderIds=extractOrderIds(text);
    // Si l'URL n'expose pas l'OrderID mais que la page contient plusieurs numéros
    // (ex. widgets annexes), privilégier explicitement celui attendu.
    const pageOrderId=urlOrderId || (textOrderIds.includes(expectedOrderId) ? expectedOrderId : (textOrderIds.length===1 ? textOrderIds[0] : ''));
    if(urlOrderId&&expectedOrderId&&urlOrderId!==expectedOrderId)throw new Error(`Mauvaise page de suivi: attendu ${expectedOrderId}, reçu ${urlOrderId}`);
    if(!urlOrderId&&textOrderIds.length&&!textOrderIds.includes(expectedOrderId))throw new Error(`Mauvaise page de suivi: attendu ${expectedOrderId}, trouvé ${textOrderIds.slice(0,3).join(', ')}`);

    const pageCandidate=extractTrackingCandidate(document), hintCandidate=trackingCandidate(q.context.trackingId||'','detail-hint',q.context.trackingConfidence||'HIGH');
    let trackingId=pageCandidate.value||hintCandidate?.value||'', trackingConfidence=pageCandidate.value?pageCandidate.confidence:(hintCandidate?.confidence||'');
    const warnings=String(q.context.warnings||'').split(';').map(x=>x.trim()).filter(Boolean);
    let dataQuality=q.context.dataQuality==='A_VERIFIER'?'A_VERIFIER':'OK', trackingConflict=false;
    const orderVerified = pageOrderId === expectedOrderId;
    if(!pageOrderId){warnings.push('orderid_page_suivi_non_verifiable');dataQuality='A_VERIFIER';}
    if(pageCandidate.source==='multiple-labels'){warnings.push('plusieurs_tracking_visibles');dataQuality='A_VERIFIER';}
    if(pageCandidate.value&&pageCandidate.confidence!=='HIGH'){warnings.push(`tracking_source_${pageCandidate.source||'moyenne'}`);dataQuality='A_VERIFIER';}
    if(pageCandidate.value&&hintCandidate?.value&&normalizeKey(pageCandidate.value)!==normalizeKey(hintCandidate.value)){
      warnings.push(`conflit_tracking:${hintCandidate.value}|${pageCandidate.value}`);trackingId='';trackingConfidence='';dataQuality='A_VERIFIER';trackingConflict=true;
    }
    if(!trackingId&&/num[ée]ro.{0,15}suivi|tracking\s*(?:id|number)/i.test(text)){warnings.push('tracking_affiche_mais_non_valide');dataQuality='A_VERIFIER';}
    const trackingVerified = isAuthoritativeTracking(trackingId, trackingConfidence, orderVerified, trackingConflict);
    // IMPORTANT: `confirmed` doit être défini avant tout compteur/branche qui l'utilise.
    // La V3.1 le déclarait plus bas, ce qui déclenchait une Temporal Dead Zone au runtime.
    const confirmed = trackingVerified === true;
    if(trackingId && !trackingVerified && !warnings.some(w=>/^tracking_source_|orderid_page_suivi_non_verifiable|conflit_tracking/.test(w))){warnings.push('tracking_non_verifie');dataQuality='A_VERIFIER';}

    const carrier=extractCarrierFromPage(document)||q.context.carrier||'', status=extractStatus(text)||q.context.status||'';
    const range=extractExpectedDeliveryRange(text), expectedDelivery=range.start||q.context.expectedDelivery||'', expectedDeliveryText=range.text||q.context.expectedDeliveryText||'';
    const expectedDeliveryStart=range.start||q.context.expectedDeliveryStart||expectedDelivery||'', expectedDeliveryEnd=range.end||q.context.expectedDeliveryEnd||expectedDelivery||'';
    const delivered=deliveredWithExpectedDateGuard(status,text,expectedDeliveryEnd), deliveredDate=extractDeliveredDate(text)||q.context.deliveredDate||'', shipDate=extractShipDate(text)||q.context.shipDate||'';
    const resolvedKey=makeResolvedShipmentKey(c.account,expectedOrderId,location.href,trackingVerified?trackingId:'',q.context.shipmentNo||1);
    const physicalKey=trackingVerified?`${c.account}|${expectedOrderId}|${normalizeKey(trackingId)}`:'';

    const knownItems=(q.items||[]).filter(it=>it&&it.asin), knownAsins=new Set(knownItems.map(it=>String(it.asin).toUpperCase()));
    const strongKnownItemAssociation = canIgnoreTrackingPageExtraAsins_(knownItems, orderVerified, trackingVerified);
    const pageRoot=document.querySelector('main')||document.body, rawPageItems=extractItems(pageRoot);
    let sourceItems=[], assignmentQuality='HIGH';
    if(knownAsins.size){
      const correlated=rawPageItems.filter(it=>knownAsins.has(String(it.asin||'').toUpperCase()));
      const extras=rawPageItems.filter(it=>it.asin&&!knownAsins.has(String(it.asin).toUpperCase()));
      if(extras.length){
        warnings.push(`asin_page_tracking_non_corréles:${extras.slice(0,5).map(x=>x.asin).join(',')}`);
        // Amazon peut injecter sur /progress-tracker des vignettes/recommandations sans
        // lien physique avec le colis. Elles restent visibles dans Warnings pour audit,
        // mais ne dégradent plus une association déjà prouvée HIGH + tracking HIGH/Verified.
        if(!strongKnownItemAssociation)dataQuality='A_VERIFIER';
      }
      sourceItems=correlated.length?correlated:knownItems;
      assignmentQuality='HIGH';
    }else if(pageOrderId===expectedOrderId&&rawPageItems.length){
      // Sans liste issue du détail, on conserve les produits visibles mais on les
      // signale comme à vérifier plutôt que de prétendre à une association certaine.
      sourceItems=rawPageItems; assignmentQuality='MEDIUM'; warnings.push('asin_tracking_sans_reference_detail'); dataQuality='A_VERIFIER';
    }

    const shipment={...q.context,shipmentKey:resolvedKey,previousShipmentKey:resolvedKey!==provisionalKey?provisionalKey:'',trackingId,trackingConfidence,trackingVerified,carrier,status,delivered,deliveredDate,shipDate,expectedDelivery,expectedDeliveryText,expectedDeliveryStart,expectedDeliveryEnd,dataQuality,warnings:[...new Set(warnings)].join(';'),trackingUrl:location.href,lastSeen:nowIso(),source:/progress-tracker/i.test(location.pathname)?'progress-tracker':'ship-track'};
    const items=sourceItems.map(it=>({itemKey:`${resolvedKey}|${it.asin||hashString(it.title)}`,shipmentKey:resolvedKey,account:c.account,orderId:expectedOrderId,orderDate:shipment.orderDate,asin:it.asin,title:it.title,quantity:it.quantity||1,productUrl:it.productUrl,trackingId,carrier,status,delivered,assignmentQuality:it.assignmentQuality||assignmentQuality,dataQuality,warnings:shipment.warnings,lastSeen:nowIso()}));
    mergeBuffer(state,[shipment],items);
    // En mode ⚡, la V3.3.7.17 forçait un appel Google après CHAQUE suivi confirmé.
    // Sur VPN/réseau instable cela donnait l'impression d'un blocage sur la page de
    // suivi alors que le script attendait Apps Script. V3.3.7.17 groupe quelques
    // colis, tout en gardant le buffer persistant pour ne rien perdre.
    let forcePriorityFlush = false;
    if (state.priorityTracking === true && confirmed && items.some(it => !!it.asin)) {
      const cfg=getConfig();
      const lastFlushTs=Date.parse(state.lastBufferFlushAt || state.startedAt || '') || 0;
      const age=lastFlushTs ? Date.now()-lastFlushTs : Number.MAX_SAFE_INTEGER;
      forcePriorityFlush = (state.buffer?.shipments?.length || 0) >= Number(cfg.priorityFlushShipmentLimit || 4)
        || (state.buffer?.items?.length || 0) >= Number(cfg.priorityFlushItemLimit || 8)
        || age >= Number(cfg.priorityFlushMaxAgeMs || 60000);
    }
    if (forcePriorityFlush) await flushBuffer(state, true);
    else await flushBuffer(state, false);

    const alreadyPhysical=physicalKey&&state.visitedPhysicalTracking?.[physicalKey];
    if(!alreadyPhysical){
      // Les compteurs utilisateur ne considèrent comme « suivi trouvé » qu'un
      // numéro HIGH réellement corrélé à la commande. Un numéro présent mais
      // non vérifié reste en attente / à vérifier au lieu de gonfler le total.
      if(confirmed)state.stats.trackingFound++;else state.stats.pending++;
      if(dataQuality==='A_VERIFIER')state.stats.uncertain++;
      if(delivered&&!q.context.delivered)state.stats.delivered++;
      else if(!delivered&&q.context.delivered&&isExplicitNonDeliveredStatus(status)) {
        // La page détail Amazon peut exposer la frise complète et faire croire à tort
        // que le colis est livré. Une page tracking fraîche explicitement non livrée
        // (Expédié / Livraison prévue / En cours de livraison) corrige immédiatement
        // le compteur local, sans attendre le recalcul serveur de fin de scan.
        state.stats.delivered=Math.max(0,Number(state.stats.delivered||0)-1);
      }
    } else {
      // Deux URLs/logiques Amazon (souvent itemId différents) viennent de se
      // résoudre vers le même tracking physique. Corriger aussi les compteurs
      // du panneau pour qu'ils reflètent le nombre de cartons, pas les alias.
      state.stats.shipments=Math.max(0,Number(state.stats.shipments||0)-1);
      if(q.context.delivered)state.stats.delivered=Math.max(0,Number(state.stats.delivered||0)-1);
    }

    const cache=getCache(c.account), o=cache[expectedOrderId]||{orderId:expectedOrderId,shipments:{}};o.shipments||={};
    const ageDays=shipment.orderDate?Math.floor((Date.now()-new Date(`${shipment.orderDate}T12:00:00`).getTime())/86400000):0;
    const terminal=!confirmed&&(isCancelled(status)||(delivered&&!!shipment.orderDate&&ageDays>=Number(c.noTrackingFinalAfterDays||14)));
    const a=o.shipments[provisionalKey]||{}, b=o.shipments[resolvedKey]||{};
    const previousVerified = b.trackingVerified===true ? b : (a.trackingVerified===true ? a : null);
    const previousTr = normalizeKey(previousVerified?.trackingId || ''), currentTr = normalizeKey(trackingId || '');
    const cacheConflict = trackingConflict || (!!previousVerified && confirmed && previousTr && currentTr && previousTr!==currentTr);
    o.shipments[resolvedKey]={...a,...b,trackingFound:cacheConflict?false:(a.trackingFound===true||b.trackingFound===true||confirmed),trackingId:cacheConflict?(previousVerified?.trackingId||trackingId||b.trackingId||a.trackingId||''):(trackingId||(b.trackingId||a.trackingId||'')),trackingConfidence:cacheConflict?(previousVerified?.trackingConfidence||trackingConfidence||''):(trackingConfidence||b.trackingConfidence||a.trackingConfidence||''),trackingVerified:cacheConflict?false:(a.trackingVerified===true||b.trackingVerified===true||confirmed),carrier:carrier||b.carrier||a.carrier||'',terminal:b.terminal===true||a.terminal===true||terminal,delivered:isExplicitNonDeliveredStatus(status)?false:delivered,lastChecked:nowIso(),status,conflict:cacheConflict||a.conflict===true||b.conflict===true};
    if(resolvedKey!==provisionalKey)delete o.shipments[provisionalKey];
    if(confirmed){
      const tr=normalizeKey(trackingId);
      for(const [k,v] of Object.entries(o.shipments)){if(k!==resolvedKey&&normalizeKey(v?.trackingId||'')===tr)delete o.shipments[k];}
    }
    o.shipments=canonicalizeCachedShipments(o.shipments);
    const vals=Object.values(o.shipments), expected=vals.length;
    o.expectedShipments=expected;o.trackingComplete=expected>0&&vals.every(x=>x.trackingFound||x.terminal);o.delivered=expected>0&&vals.every(x=>x.delivered===true);o.lastChecked=nowIso();o.lastSeen=nowIso();
    cache[expectedOrderId]=o;saveCache(c.account,cache);
    void smartDbMergeOrder(c.account,{orderId:expectedOrderId,orderDate:o.orderDate||shipment.orderDate||'',lastChecked:o.lastChecked||nowIso(),trackingComplete:o.trackingComplete===true,delivered:o.delivered===true,terminalNoTracking:o.terminalNoTracking===true,uncertain:dataQuality==='A_VERIFIER'||cacheConflict,shipments:[shipment],items}).catch(e=>log('Smart Cache suivi',e));
    state.visitedTracking[provisionalKey]=true;state.visitedTracking[resolvedKey]=true;state.visitedPhysicalTracking||={};if(physicalKey)state.visitedPhysicalTracking[physicalKey]=true;
    journalCommit(state,'tracking',provisionalKey,'ok');
    delete state.retryCounts?.[`tracking:${provisionalKey}`];
    state.lastMessage=confirmed?`${state.priorityTracking ? '⚡ ' : ''}${expectedOrderId}: ${trackingId}${state.priorityTracking ? ` → ${sourceItems.filter(x=>x.asin).length} ASIN mémorisé(s)` : ''}`:dataQuality==='A_VERIFIER'?`${expectedOrderId}: donnée à vérifier`:`${state.priorityTracking ? '⚡ ' : ''}${expectedOrderId}: suivi pas encore visible${trackingProbe ? ` (${Math.round((trackingProbe.elapsedMs||0)/1000)} s) — suivant` : ''}`;
    clearScanOperation(state);
    return goNext(state);
  }

  async function goNext(state, afterError = false) {
    if(!state?.active)return;
    if(!stateAccountIsCurrent(state)){pauseForAccountMismatch(state);return;}
    if(afterError)await sleep(randomDelay());
    if(state.phase==='history')return resumeScan();

    sortQueuesByPriority(state);

    if(state.phase==='details'){
      while(state.orderQueue.length){
        const next=state.orderQueue.shift(); if(state.visitedOrders[next.orderId])continue;
        state.currentOrder=next;
        journalCheckpoint(state,'details',next);
        state.lastMessage=`Commande ${next.orderId} · P${Number(next.queuePriority||50)}${next.queueReason?` · ${next.queueReason}`:''}`;
        saveState(state); void sendFleetHeartbeat(true);
        await sleep(randomDelay());navigateTo(next.url);return;
      }
      if(state.trackQueue.length){state.phase='tracking';state.currentOrder=null;saveState(state);}
      else if(prepareQuarantineRetry(state)){
        state.phase=state.orderQueue.length?'details':'tracking';saveState(state);return goNext(state);
      } else {state.phase='done';saveState(state);}
    }

    if(state.phase==='tracking'){
      while(state.trackQueue.length){
        const next=state.trackQueue.shift();if(state.visitedTracking[next.context.shipmentKey])continue;
        if (isAmazonFrUrl(next.url) && !isAmazonTrackingUrl(next.url)) {
          state.stats.uncertain = Number(state.stats.uncertain || 0) + 1;
          state.lastMessage = `Lien non-suivi ignoré pour ${next.context.orderId}: ${new URL(next.url, location.href).pathname}`;
          journalCommit(state,'tracking',next.context.shipmentKey,'invalid-url');
          saveState(state);
          continue;
        }
        state.currentTracking=next;
        journalCheckpoint(state,'tracking',next);
        state.lastMessage=`Suivi ${next.context.orderId} colis ${next.context.shipmentNo} · P${Number(next.queuePriority||50)}`;
        saveState(state); void sendFleetHeartbeat(true);
        await sleep(randomDelay());navigateTo(next.url);return;
      }
      state.currentTracking=null;
      if(state.orderQueue.length){state.phase='details';state.detailsSinceTracking=0;saveState(state);return goNext(state);}
      if(prepareQuarantineRetry(state)){
        state.phase=state.orderQueue.length?'details':'tracking';saveState(state);return goNext(state);
      }
      state.phase='done';saveState(state);
    }
    return finishScan(state);
  }

  function historyDateDiagnosticSamples(limit = 5) {
    if (!isHistoryPage()) return [];
    const out = [];
    try {
      for (const rec of historyOrderCandidates(document).slice(0, Math.max(1, Number(limit || 5)))) {
        const date = extractOrderDateFromLiveCandidate(rec, document) || '?';
        const cardText = normalizeText((rec.cards || [])[0]?.innerText || '').replace(/\n/g, ' | ').slice(0, 260);
        out.push(`${rec.orderId}:${date}${cardText ? ` [${cardText}]` : ''}`);
      }
    } catch (e) { out.push(`ERREUR:${e.message}`); }
    return out;
  }

  function buildDiagnosticText() {
    const ctx = extractOrderContextFromPage();
    const root = ctx.orderId ? findOrderRoot(ctx.orderId) : (document.querySelector('main') || document.body);
    const items = extractItems(root);
    const tracks = trackLinks(document);
    const detailLinks = orderDetailLinks(document);
    const trackingCandidateInfo = extractTrackingCandidate(document);
    const trackingId = trackingCandidateInfo.value || '';
    const unresolved = unresolvedTrackControls(document).length;
    const carrier = extractCarrierFromPage(document);
    const type = isHistoryPage() ? 'historique' : isTrackingPage() ? 'suivi' : isOrderDetailPage() ? 'détail commande' : 'autre';
    return [
      `VINE Tracking v${BUILD_VERSION} (protocole ${VERSION})`,
      `Page: ${type}`,
      `URL: ${location.href}`,
      `OrderID: ${ctx.orderId || '-'}`,
      `Date commande: ${ctx.orderDate || '-'}`,
      `Statut: ${ctx.status || '-'}`,
      `Liens commandes: ${detailLinks.length}`,
      `Liens suivi détectés: ${tracks.length} (externes: ${tracks.filter(x=>x.external).length})`,
      `Boutons suivi sans URL: ${unresolved}`, 
      `ASIN détectés: ${items.length}${items.length ? ' — ' + items.slice(0,8).map(x=>x.asin).join(', ') : ''}`,
      `ASIN mémorisés pour le colis: ${(getState()?.currentTracking?.items || []).filter(x=>x?.asin).length}${(getState()?.currentTracking?.items || []).some(x=>x?.asin) ? ' — ' + (getState()?.currentTracking?.items || []).filter(x=>x?.asin).slice(0,8).map(x=>x.asin).join(', ') : ''}`,
      `itemId URL: ${(() => { try { return new URL(location.href).searchParams.get('itemId') || '-'; } catch (_) { return '-'; } })()}`,
      `Tracking détecté: ${trackingId || '-'} (${trackingCandidateInfo.source || '-'} / ${trackingCandidateInfo.confidence || '-'})`,
      `Transporteur: ${carrier || '-'}`,
      `Recherche active: ${getState()?.mode === 'search' ? (getState()?.searchQuery || '-') : '-'}`,
      `État scan: phase=${getState()?.phase || '-'}, actif=${getState()?.active === true}, pause=${getState()?.paused === true}, priorité=${getState()?.priorityTracking === true}`,
      `Mode faible trafic: délai=${getConfig().delayMinMs}-${getConfig().delayMaxMs}ms, pages7=${getConfig().maxHistoryPages7}, pages30=${getConfig().maxHistoryPages30}, retries=${getConfig().pageRetries}`,
      `Mode dédié: ${getConfig().dedicatedDeviceMode===true} · nuit robuste=${getState()?.robustNight===true} · wakeLock=${!!robustWakeLock} · réutilisées=${getState()?.stats?.rangeReused||0}`,
      `Envoi Google: maximum=8/24 · reste=${getState()?.buffer?.shipments?.length||0}/${getState()?.buffer?.items?.length||0} · prochain=${getState()?.googleSync?.nextAttemptAt ? new Date(getState().googleSync.nextAttemptAt).toISOString() : '-'} · erreur=${getState()?.googleSync?.lastError||'-'}`,
      `Smart Cache: actif=${getConfig().smartCacheEnabled!==false} · source=${getState()?.smartCacheSource||'-'} · full=${getState()?.forceFullScan===true} · skipFinal=${getState()?.stats?.smartSkippedFinal||0} · skipRécent=${getState()?.stats?.smartSkippedRecent||0} · skipAttente=${getState()?.stats?.smartSkippedPending||0} · suiviDirect=${getState()?.stats?.smartDirectTracking||0}`,
      `Queue prioritaire: actif=${getConfig().queuePriorityEnabled!==false} · ordres=${getState()?.orderQueue?.length||0} · suivis=${getState()?.trackQueue?.length||0} · repriseExacte=${getState()?.stats?.resumeRecovered||0}`,
      `Quarantaine: attente=${getState()?.quarantine?.length||0} · finale=${getState()?.quarantineFinal?.length||0} · passFinal=${getState()?.quarantineRetryPass===true}`,
      `Journal reprise: ${JSON.stringify(getState()?.journal||null)}`,
      `Programmation: ${scheduleStatusText(getConfig().account)}`,
      `Transport Google: ${transportLabel()} · relais configuré=${relayConfigured()} · préférence relais jusqu'à=${getTransportState().preferRelayUntil ? new Date(getTransportState().preferRelayUntil).toLocaleString('fr-FR') : '-'}`,
      `Files: commandes=${getState()?.orderQueue?.length || 0}, suivis=${getState()?.trackQueue?.length || 0}, bufferColis=${getState()?.buffer?.shipments?.length || 0}, bufferArticles=${getState()?.buffer?.items?.length || 0}`,
      `Suivi courant: ${getState()?.currentTracking?.context?.orderId || '-'} / ${getState()?.currentTracking?.context?.shipmentKey || '-'}`,
      `Opération: ${JSON.stringify(getState()?.operation || null)}`,
      `Watchdog reprises: ${JSON.stringify(getState()?.watchdogRecoveries || {})}`,
      `Probe suivi: ${JSON.stringify(getState()?.lastTrackingProbe || null)}`,
      `Retries: ${JSON.stringify(getState()?.retryCounts || {})}`,
      `DOM rapide: ${JSON.stringify(getState()?.lastDomFastPath || null)}`,
      `Verrou onglet: ${JSON.stringify((()=>{ const st=getState(); const acct=scanAccount(st)||getConfig().account; const lk=readTabLock(acct); const hb=lk?.tabId?readTabHeartbeat(lk.tabId):null; return lk?{owner:lk.tabId===TAB_ID?'cet onglet':'autre onglet',live:lk.tabId===TAB_ID?true:heartbeatIsLive(hb,acct),ageMs:hb?Date.now()-Number(hb.ts||0):null,scanId:lk.scanId||''}:null; })())}`,
      `Audit recherche: résultats=${getState()?.stats?.searchLabels || 0}, cartes=${getState()?.stats?.searchCards || 0}, sans OrderID=${getState()?.stats?.searchUnresolvedCards || 0}, OrderID uniques=${getState()?.stats?.orders || 0}`,
      `Dates historique échantillon: ${historyDateDiagnosticSamples(5).join(' || ') || '-'}`,
      `Stabilisation historique: ${JSON.stringify((getState()?.historyDiagnostics || []).slice(-3))}`
    ].join('\n');
  }

  function showDiagnostic() {
    prompt('Diagnostic VINE Tracking — copie ce texte si tu dois me l’envoyer :', buildDiagnosticText());
  }

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const host = document.createElement('div');
    host.id = PANEL_ID;
    host.innerHTML = `
      <style>
        #${PANEL_ID}{position:fixed;right:8px;bottom:84px;z-index:2147483646;font-family:Arial,sans-serif;color:#111}
        #${PANEL_ID} .vt-box{width:min(310px,calc(100vw - 16px));background:#fff;border:2px solid #111;border-radius:14px;box-shadow:0 5px 18px #0005;overflow:hidden}
        #${PANEL_ID} .vt-head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#111;color:#fff;font-weight:700}
        #${PANEL_ID} .vt-body{padding:8px;display:none}
        #${PANEL_ID}.open .vt-body{display:block}
        #${PANEL_ID} button{border:0;border-radius:9px;padding:9px 10px;margin:3px;font-weight:700;background:#eee;color:#111}
        #${PANEL_ID} button.primary{background:#ffd814}
        #${PANEL_ID} button.stop{background:#f44336;color:white}
        #${PANEL_ID} .vt-grid{display:grid;grid-template-columns:1fr 1fr;gap:3px}
        #${PANEL_ID} .vt-stat{font-size:12px;background:#f5f5f5;border-radius:8px;padding:6px;margin:5px 0;line-height:1.4}
        #${PANEL_ID} .vt-msg{font-size:11px;max-height:40px;overflow:hidden;color:#444}
        #${PANEL_ID} .vt-mini{background:none;color:#fff;padding:0;margin:0;font-size:18px}
        #${PANEL_ID} button.wide{grid-column:1 / -1}
        #${PANEL_ID} .vt-scheduler{margin:6px 0;padding:7px;background:#fff8dc;border:1px solid #e2c968;border-radius:9px}
        #${PANEL_ID} .vt-scheduler[hidden]{display:none}
        #${PANEL_ID} .vt-srow{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin:5px 0}
        #${PANEL_ID} .vt-scheduler input,#${PANEL_ID} .vt-scheduler select{min-width:0;width:100%;box-sizing:border-box;border:1px solid #aaa;border-radius:7px;padding:7px;font-size:14px;background:#fff;color:#111}
        #${PANEL_ID} .vt-schedule-status{font-size:11px;background:#f5f5f5;border-radius:7px;padding:5px 7px;margin:5px 0;line-height:1.35}
        #${PANEL_ID} .vt-last-scan{font-size:11px;background:#eef7ee;border:1px solid #c6dec6;border-radius:7px;padding:6px 7px;margin:5px 0;line-height:1.35;white-space:pre-line}
        #${PANEL_ID} .vt-history{font-size:10px;background:#fafafa;border:1px solid #ddd;border-radius:7px;padding:5px 7px;margin:5px 0;line-height:1.35;white-space:pre-line;max-height:150px;overflow:auto}
        #${PANEL_ID} .vt-history[hidden]{display:none}
      </style>
      <div class="vt-box">
        <div class="vt-head"><span>📦 VINE Tracking <small>v${BUILD_VERSION}</small></span><button class="vt-mini" data-act="toggle">▾</button></div>
        <div class="vt-body">
          <div class="vt-stat" data-role="account"></div>
          <div class="vt-grid">
            <button class="primary" data-act="scan7">Scanner 7 j</button>
            <button class="primary" data-act="scan15">Scanner 15 j</button>
            <button class="primary" data-act="scan30">Scanner 30 j</button>
            <button class="primary" data-act="customRange">📅 Entre 2 dates</button>
            <button class="primary" data-act="priority">⚡ Suivis + ASIN</button>
            <button class="primary" data-act="search">🔎 Livraison</button>
            <button data-act="missing">Suivis manquants</button>
            <button data-act="resume">▶ Reprendre</button>
            <button data-act="test">✓ Test Google</button>
            <button data-act="diag">🧪 Diagnostic</button>
            <button data-act="config">⚙ Config</button>
            <button data-act="relay">☁ Relais</button>
            <button class="stop" data-act="stop">■ Stop</button>
            <button data-act="clear">↺ Reset scan</button>
            <button class="wide" data-act="forceFull">♻️ Forcer le prochain scan complet</button>
            <button class="wide" data-act="scheduleToggle">⏰ Programmer un scan</button>
          </div>
          <div class="vt-scheduler" data-role="schedulerEditor" hidden>
            <div style="font-size:12px;font-weight:700">Programmation ponctuelle — heure locale du téléphone</div>
            <div class="vt-srow"><input type="date" data-role="scheduleDate" aria-label="Date du scan"><input type="time" data-role="scheduleTime" aria-label="Heure du scan"></div>
            <div class="vt-srow"><select data-role="scheduleDays" aria-label="Type de scan"><option value="7">Scanner 7 jours</option><option value="15">Scanner 15 jours</option><option value="30">Scanner 30 jours</option><option value="p7">⚡ Suivis + ASIN — 7 jours</option><option value="p15">⚡ Suivis + ASIN — 15 jours</option><option value="p30">⚡ Suivis + ASIN — 30 jours</option></select><button class="primary" data-act="scheduleSave">Programmer</button></div>
            <label style="display:flex;align-items:center;gap:7px;font-size:11px;margin:5px 2px"><input type="checkbox" data-role="scheduleRobust" checked> 🌙 Mode nuit robuste (écran actif si possible + reprise réseau + grâce 4 h)</label>
            <button data-act="scheduleCancel" style="width:calc(100% - 6px)">Annuler la programmation</button>
          </div>
          <div class="vt-schedule-status" data-role="scheduleStatus"></div>
          <div class="vt-last-scan" data-role="lastScan"></div>
          <button class="wide" data-act="historyToggle">📋 Historique des 5 derniers scans</button>
          <div class="vt-history" data-role="scanHistory" hidden></div>
          <div class="vt-stat" data-role="stats"></div>
          <div class="vt-msg" data-role="msg"></div>
        </div>
      </div>`;
    document.documentElement.appendChild(host);
    host.querySelector('[data-act="toggle"]').onclick = () => host.classList.toggle('open');
    host.querySelector('[data-act="scan7"]').onclick = () => startScan(7);
    host.querySelector('[data-act="scan15"]').onclick = () => startScan(15);
    host.querySelector('[data-act="scan30"]').onclick = () => startScan(30);
    host.querySelector('[data-act="customRange"]').onclick = () => startCustomRangeScan(false);
    host.querySelector('[data-act="priority"]').onclick = startPriorityTracking;
    host.querySelector('[data-act="search"]').onclick = startDeliverySearch;
    host.querySelector('[data-act="missing"]').onclick = () => startScan(30, 'missing');
    host.querySelector('[data-act="resume"]').onclick = resumePausedScan;
    host.querySelector('[data-act="test"]').onclick = testConnection;
    host.querySelector('[data-act="diag"]').onclick = showDiagnostic;
    host.querySelector('[data-act="config"]').onclick = configure;
    host.querySelector('[data-act="relay"]').onclick = configureRelay;
    host.querySelector('[data-act="forceFull"]').onclick = () => { armForceFullNext(); toast('Le prochain scan de période ignorera le Smart Cache et relira Amazon.', 'warn'); };
    host.querySelector('[data-act="scheduleToggle"]').onclick = () => {
      const editor=host.querySelector('[data-role="schedulerEditor"]');
      const s=getScheduledScan(); const def=defaultScheduleParts();
      host.querySelector('[data-role="scheduleDate"]').value = s?.enabled ? (s.date || def.date) : def.date;
      host.querySelector('[data-role="scheduleTime"]').value = s?.enabled ? (s.time || def.time) : def.time;
      host.querySelector('[data-role="scheduleDays"]').value = s?.enabled ? `${s.priorityTracking===true?'p':''}${s.days||7}` : '7';
      host.querySelector('[data-role="scheduleRobust"]').checked = s?.enabled ? s.robustNight===true : getConfig().nightRobustScheduleDefault!==false;
      editor.hidden = !editor.hidden;
    };
    host.querySelector('[data-act="scheduleSave"]').onclick = () => {
      try {
        const rawType=String(host.querySelector('[data-role="scheduleDays"]').value||'7');
        const isPriority=rawType.startsWith('p');
        const days=Number(rawType.replace(/^p/,''))||7;
        const sc=programScheduledScan(host.querySelector('[data-role="scheduleDate"]').value,host.querySelector('[data-role="scheduleTime"]').value,days,undefined,isPriority,host.querySelector('[data-role="scheduleRobust"]').checked);
        host.querySelector('[data-role="schedulerEditor"]').hidden=true;
        toast(`${scheduledScanKind(sc)} programmé le ${formatScheduleDateTime(sc.scheduledAt)}`, 'ok');
      } catch(e) { toast(String(e?.message||e),'error'); }
    };
    host.querySelector('[data-act="scheduleCancel"]').onclick = () => {
      if(cancelScheduledScan()) toast('Programmation annulée','warn'); else toast('Aucune programmation active','warn');
      host.querySelector('[data-role="schedulerEditor"]').hidden=true;
    };
    host.querySelector('[data-act="historyToggle"]').onclick = () => {
      const box=host.querySelector('[data-role="scanHistory"]'); box.hidden=!box.hidden; updatePanel(getState());
    };
    host.querySelector('[data-act="stop"]').onclick = () => stopScan();
    host.querySelector('[data-act="clear"]').onclick = () => {
      const s = getState();
      const pending = (s?.buffer?.shipments?.length || 0) + (s?.buffer?.items?.length || 0);
      const warning = pending
        ? `Effacer le scan en cours ? ${pending} donnée(s) encore dans le tampon local seront perdues. Le cache des commandes sera conservé.`
        : 'Effacer uniquement le scan en cours ? Le cache des commandes sera conservé.';
      if (confirm(warning)) { clearState(); toast('Scan réinitialisé', 'ok'); }
    };
    if (getState()?.active) host.classList.add('open');
    updatePanel(getState());
  }

  function updatePanel(state) {
    const host = document.getElementById(PANEL_ID); if (!host) return;
    const c = getConfig();
    const finalizing = state?.active && /finalisation|Envoi final|Compteurs vérifiés/i.test(String(state?.lastMessage || ''));
    host.querySelector('[data-role="account"]').textContent = `Compte : ${c.account || 'NON CONFIGURÉ'}${finalizing ? ' — FINALISATION GOOGLE' : state?.active ? ' — SCAN ACTIF' : state?.paused ? ' — EN PAUSE' : ''}${state?.priorityTracking ? ' — ⚡ SUIVI/ASIN' : ''}${state?.robustNight ? ' — 🌙 ROBUSTE' : ''}${state?.forceFullScan ? ' — ♻️ FULL' : smartForcePending(c.account) ? ' — ♻️ FULL PROCHAIN' : ''} · API ${transportLabel()}`;
    const sch=host.querySelector('[data-role="scheduleStatus"]'); if(sch) sch.textContent=scheduleStatusText(c.account);
    const history=getScanHistory(c.account);
    const last=host.querySelector('[data-role="lastScan"]'); if(last) last.textContent=`Dernier scan : ${scanSummaryLabel(history[0])}`;
    const hist=host.querySelector('[data-role="scanHistory"]'); if(hist && !hist.hidden) hist.textContent=history.length ? history.map((x,i)=>`${i+1}. ${scanSummaryLabel(x)}`).join('\n\n') : 'Aucun historique enregistré.';
    const st = state?.stats || {};
    const priorityLine = state?.priorityTracking ? '⚡ <b>Priorité Tracking ↔ ASIN / M110</b><br>' : '';
    host.querySelector('[data-role="stats"]').innerHTML = state?.mode === 'search' ? `Résultats livraison: <b>${st.searchLabels || 0}</b> · OrderID uniques: <b>${st.orders || 0}</b><br>Cartes: <b>${st.searchCards || 0}</b> · Sans OrderID: <b>${st.searchUnresolvedCards || 0}</b><br>Colis: <b>${st.shipments || 0}</b> · Suivis: <b>${st.trackingFound || 0}</b> · Livrés: <b>${st.delivered || 0}</b> · À vérifier: <b>${st.uncertain || 0}</b>` : `${priorityLine}Commandes période: <b>${st.rangeIncluded || 0}</b> · À traiter: <b>${st.orders || 0}</b><br>Date inconnue: <b>${st.rangeUnknown || 0}</b> · Hors période: <b>${st.rangeOutside || 0}</b> · Réutilisées: <b>${st.rangeReused || 0}</b><br>Smart skip: <b>${Number(st.smartSkippedFinal||0)+Number(st.smartSkippedRecent||0)+Number(st.smartSkippedPending||0)}</b> · Suivi direct: <b>${st.smartDirectTracking||0}</b> · Nouvelles: <b>${st.smartNew||0}</b><br>Queue: <b>${(state?.orderQueue?.length||0)+(state?.trackQueue?.length||0)}</b> · Quarantaine: <b>${(state?.quarantine?.length||0)+(state?.quarantineFinal?.length||0)}</b> · Reprises exactes: <b>${st.resumeRecovered||0}</b><br>Colis: <b>${st.shipments || 0}</b> · Suivis: <b>${st.trackingFound || 0}</b> · Attente: <b>${st.pending || 0}</b> · Livrés: <b>${st.delivered || 0}</b> · À vérifier: <b>${st.uncertain || 0}</b>`;
    host.querySelector('[data-role="msg"]').textContent = (state?.lastMessage || 'Prêt') + (state?.googleSync?.lastError ? ` · Google indisponible : ${state.buffer?.shipments?.length||0}/${state.buffer?.items?.length||0} en attente locale, réessai dans ${Math.max(0,Math.ceil((state.googleSync.nextAttemptAt-Date.now())/60000))} min` : '');
  }

  function toast(message, type = 'ok') {
    const old = document.getElementById('vt-toast'); if (old) old.remove();
    const d = document.createElement('div'); d.id = 'vt-toast'; d.textContent = message;
    const bg = type === 'error' ? '#b00020' : type === 'warn' ? '#8a5700' : '#166534';
    d.style.cssText = `position:fixed;left:8px;right:8px;top:8px;z-index:2147483647;background:${bg};color:white;padding:12px;border-radius:10px;font:700 13px Arial;box-shadow:0 4px 14px #0006`;
    document.documentElement.appendChild(d); setTimeout(() => d.remove(), 5000);
  }

  if (typeof globalThis !== 'undefined' && globalThis.__VT_TEST_MODE__) {
    globalThis.__VT_TESTS__ = {
      VERSION, BUILD_VERSION, makeLocalDate, isoDate, foldText, dateForWeekday, searchTargetDate, isCarrierAttributionDeliveryPhrase, hasDeliveredMarker, deliveryRelevantLines, extractOrderDateNearOrderId, extractOrderDateFromLiveCandidate, validIsoOrderDate, chooseKnownOrderDate, markRangeAudit,
      datesMentionedInDeliveryText, matchesDeliveryQuery, parseDateFromText, extractOrderDate, classifyOrderDateForRange, parseScanRangeDatePart, parseCustomScanRange, markRangeAudit, hasExplicitDeliveredEvidence, isDelivered, deliveredWithExpectedDateGuard, isExplicitNonDeliveredStatus,
      extractExpectedDelivery, extractExpectedDeliveryRange, extractDeliveredDate, isPlausibleTrackingId, cleanTrackingCandidate,
      trackingCandidate, isAuthoritativeTracking, trackingCandidateFromUrl, extractTrackingCandidate, detectCarrier, extractCarrierFromPage, extractStatus, trackLinks, orderDetailLinks, extractVineOrderDate, vineOrderCandidates, vineOrderDatesAreDescending, findNextVineOrdersUrl, collectStableVineOrdersPage, processVineOrdersIndex, isVineOrdersPage, isLegacyHistoryPage, isTrackingPage, isOrderDetailPage, parseOrderId, normalizedAmazonPath, isUnsafeAmazonOrderActionUrl, isAmazonTrackingUrl, isAmazonOrderDetailUrl, trackingUrlMatchesOrder, partitionTrackingLinksByOrder, extractOrderIds, shipmentIdentityFromUrl, resolvedShipmentIdentity, makeResolvedShipmentKey, normalizeKey, cacheShipmentRank, canonicalizeCachedShipments, canonicalShipmentCount, getCache, snapshotHistoryCandidates, mergeHistoryCandidateSnapshots, domStructureSnapshot, waitForFastDomStructure, semanticPageSnapshot, waitForStableSemanticPage, waitForBoundedTrackingPage, waitForPriorityTrackingPage, waitForCurrentPageReady, pageLooksRateLimitedOrUnavailable, isRelevantAutomationPage, canIgnoreTrackingPageExtraAsins_, processDetails, processTracking, scanAccount, stateAccountIsCurrent, validAccountName, getConfig, migrateConservativeConfig, baseState, majorVersion, parseLocalScheduleDateTime, formatScheduleDateTime, getScheduledScan, programScheduledScan, cancelScheduledScan, scheduledScanKind, scheduleStatusText, getScanHistory, saveScanHistory, buildScanSummary, upsertScanSummary, recordScanSummary, recordMissedSchedule, scanSummaryLabel, scanSummaryStatus, scanDurationMs, formatDuration, validateRelayUrl, relayConfigured, getTransportState, resetTransportState, apiPostTransport, apiPostOnce, apiPost, configureRelay, transportLabel, setScanOperation, clearScanOperation, operationTimeoutMs, recoverStaleScan, startScanWatchdog, flushBuffer, nextMicroBatch, acknowledgeMicroBatch, deferGoogleSync, finishScan, heartbeatIsLive, otherTabReallyOwnsLock, acquireTabLock, ownsTabLock, readTabHeartbeat, writeTabHeartbeat, confirmTabLock, recentExtensionCoverage, canReuseCandidateFromExtension, requestRobustWakeLock, releaseRobustWakeLockIfIdle, smartCacheDecision, smartDirectTrackingReady, smartNormalizeOrderRecord, fetchKnownOrderState, smartDbGetOrders, smartDbPutRecords, smartDbMergeOrder, smartDbMaintenance, enqueueSmartDirectTracking, queuePriorityFor, sortQueuesByPriority, journalCheckpoint, journalCommit, recoverExactJournal, quarantineCurrent, prepareQuarantineRetry, waitForDomMutationOrTimeout, fleetHeartbeatPayload
    };
    return;
  }

  try {
    GM_registerMenuCommand('⚙️ Configurer VINE Tracking', configure);
    GM_registerMenuCommand('☁️ Configurer relais Cloudflare', configureRelay);
    GM_registerMenuCommand('📦 Scanner 7 jours', () => startScan(7));
    GM_registerMenuCommand('📦 Scanner 15 jours', () => startScan(15));
    GM_registerMenuCommand('📅 Scanner entre 2 dates', () => startCustomRangeScan(false));
    GM_registerMenuCommand('⚡ Suivis + ASIN / M110', startPriorityTracking);
    GM_registerMenuCommand('🔎 Rechercher une livraison', startDeliverySearch);
    GM_registerMenuCommand('📦 Suivis manquants', () => startScan(30, 'missing'));
    GM_registerMenuCommand('▶ Reprendre le scan', resumePausedScan);
    GM_registerMenuCommand('✓ Tester Google', testConnection);
    GM_registerMenuCommand('🧪 Diagnostic page', showDiagnostic);
    GM_registerMenuCommand('⏰ Programmer un scan', () => {
      const host=document.getElementById(PANEL_ID);
      if(host){
        host.classList.add('open');
        const editor=host.querySelector('[data-role="schedulerEditor"]');
        const sc=getScheduledScan(); const def=defaultScheduleParts();
        host.querySelector('[data-role="scheduleDate"]').value = sc?.enabled ? (sc.date || def.date) : def.date;
        host.querySelector('[data-role="scheduleTime"]').value = sc?.enabled ? (sc.time || def.time) : def.time;
        host.querySelector('[data-role="scheduleDays"]').value = sc?.enabled ? `${sc.priorityTracking===true?'p':''}${sc.days||7}` : '7';
        const robust=host.querySelector('[data-role="scheduleRobust"]'); if(robust) robust.checked=sc?.enabled ? sc.robustNight===true : getConfig().nightRobustScheduleDefault!==false;
        if(editor) editor.hidden=false;
      }
    });
    GM_registerMenuCommand('♻️ Forcer le prochain scan complet', () => { armForceFullNext(); toast('Prochain scan complet armé.', 'warn'); });
    GM_registerMenuCommand('■ Stop', () => stopScan());
  } catch (_) {}

  function showBootFailure(error) {
    try {
      const old=document.getElementById('vt-boot-failure'); if(old) old.remove();
      const d=document.createElement('div'); d.id='vt-boot-failure';
      d.textContent=`VINE Tracking ${BUILD_VERSION} — erreur démarrage : ${String(error?.message||error||'inconnue')}`;
      d.style.cssText='position:fixed;left:8px;right:8px;bottom:84px;z-index:2147483647;background:#b00020;color:#fff;padding:12px;border-radius:10px;font:700 12px Arial;box-shadow:0 4px 14px #0006';
      (document.documentElement||document.body).appendChild(d);
    } catch (_) {}
  }

  async function boot() {
    if (!isRelevantAutomationPage()) return;
    // BOOT FIX: le panneau est construit AVANT heartbeat/Fleet/IndexedDB.
    // Une panne d'un sous-système ne peut donc plus faire disparaître toute l'interface.
    buildPanel();
    try { startTabHeartbeat(); } catch (e) { log('Heartbeat onglet au démarrage', e); }
    try { startSchedulerLoop(); } catch (e) { log('Programmateur au démarrage', e); }
    try { startScanWatchdog(); } catch (e) { log('Watchdog au démarrage', e); }
    try { startFleetHeartbeat(); } catch (e) { log('Fleet au démarrage', e); }
    if(getConfig().smartCacheEnabled) {
      void smartDbMirrorLegacyCache(getConfig().account,getCache(getConfig().account)).catch(e=>log('Smart Cache migration',e));
      void smartDbMaintenance(getConfig().account,false).catch(e=>log('Smart Cache maintenance',e));
    }
    const scheduled=getScheduledScan(); if(scheduled?.enabled&&scheduled.robustNight===true) requestRobustWakeLock('boot-programmation');
    const state = getState();
    if (state?.active) {
      await sleep(1400);
      resumeScan();
    }
  }

  // Laisse le document-idle se stabiliser puis démarre avec diagnostic visible en cas d'échec.
  setTimeout(() => { void boot().catch(e => { try { log('BOOT', e); } catch (_) {} showBootFailure(e); }); }, 50);
})();
