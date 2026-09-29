// ==UserScript==
// @name         Vine RFY - SAFE SERVER v7.10 Quota Saver
// @namespace    local.vine.safe.price
// @version      7.10.0
// @description  SAFE SERVER V7.2 : queue D1 + Bright Data + Auto-Reload RFY prudent avec ON/OFF, jitter, pause activité, limite quotidienne et backoff.
// @match        https://www.amazon.fr/vine/vine-items*
// @match        https://www.amazon.fr/checkout/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      *
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '7.10.0';
  const KEYS = {
    serverUrl: 'vpss_v4_server_url',
    apiKey: 'vpss_v4_api_key',
    paused: 'vpss_v4_paused',
    settings: 'vpss_v4_settings',
    cache: 'vpss_v4_cache',
    stateQueue: 'vpss_v4_state_queue',
    knownAsins: 'vpss_v4_known_asins',
    baselineDone: 'vpss_v4_baseline_done',
    pendingNew: 'vpss_v4_pending_new',
    autoReloadState: 'vpss_v72_auto_reload_state',
    autoReloadScrollY: 'vpss_v72_auto_reload_scroll_y',
    deviceId: 'vpss_v79_device_id',
  };

  // Les clés de stockage v4 sont volontairement conservées pour migrer sans perdre les réglages.
  const DEFAULTS = {
    priceFocus: 30,
    priceHot: 50,
    priceStar: 100,
    sortMode: 'price_desc',
    compactMode: false,
    columnsEnabled: false,
    columns: 3,
    fullTitles: false,
    zoomImages: true,
    colorblind: false,
    showHidden: false,
    highlightWords: '',
    notificationsEnabled: false,
    notificationMinPrice: 50,
    notificationKeywords: '',
    notifyBrowser: true,
    notifySound: true,
    notifyPushover: false,
    notifyDiscord: false,
    scoreEnabled: true,
    scorePriceReference: 100,
    scoreKeywords: '',
    notificationMinScore: 0,
    notificationMaxAgeMinutes: 30,
    notificationLogic: 'all',
    notificationIgnoreHidden: true,
    notificationImportantPrice: 75,
    notificationUrgentPrice: 150,
    notificationUrgentScore: 90,
    checkoutAlertsEnabled: true,
    showMetaBadges: true,
    filterMinPrice: 0,
    filterMinRating: 0,
    filterMinReviews: 0,
    filterMinScore: 0,
    filterAvailableOnly: false,
    filterCouponOnly: false,
    filterAmazonSellerOnly: false,
    filterFavoritesOnly: false,
    filterText: '',
    scoreWeightPrice: 20,
    scoreWeightFreshness: 15,
    scoreWeightDiscount: 10,
    scoreWeightRating: 10,
    scoreWeightReviews: 8,
    scoreWeightKeywords: 12,
    scoreWeightRank: 8,
    scoreWeightAvailability: 5,
    scoreWeightSeller: 4,
    scoreWeightHistory: 5,
    scoreWeightFavorite: 3,
    notificationChangesEnabled: true,
    notificationPriceDropPercent: 15,
    notificationAvailabilityReturn: true,
    notificationCouponAppears: true,

    deviceName: '',
    notificationSecondDevice: true,

    // V7.2 — Auto-Reload RFY.
    // Désactivé par défaut : l'utilisateur l'active explicitement via le bouton AUTO.
    autoReloadEnabled: false,
    autoReloadMode: 'safe',
    autoReloadSafeMinMinutes: 3,
    autoReloadSafeMaxMinutes: 6,
    autoReloadUltraMinMinutes: 5,
    autoReloadUltraMaxMinutes: 10,
    autoReloadDailyCap: 200,
    autoReloadActivityGraceMinutes: 2,
    autoReloadInitialJitterMinutes: 4,

    // V7.3 — Variantes / fiche produit Vine
    autoVariantEnabled: false,
    autoVariantMode: 'first_available',
    hideToolbarInProductModal: true,

    // V7.4 — mise en évidence des nouveaux RFY
    highlightNewProducts: true,
    highlightNewMinutes: 10,
  };

  const LOOP_MIN_MS = 2500;
  const LOOP_MAX_MS = 4000;
  const API_TIMEOUT_MS = 90000;
  const MAX_CACHE = 2000;
  const MAX_KNOWN = 5000;
  const KNOWN_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;
  const REAPPEAR_AS_NEW_MS = 48 * 60 * 60 * 1000;
  const PENDING_NEW_MAX_MS = 30 * 60 * 1000;
  const BASELINE_GRACE_MS = 8000;

  if (window.top !== window.self) return;

  // V5 fonctionne aussi sur le checkout, mais uniquement pour afficher des
  // avertissements locaux. Aucun appel au Worker n'y est effectué.
  const isCheckoutPage = /^\/checkout\/p\/p-/.test(location.pathname);
  if (isCheckoutPage) {
    initCheckoutAlerts();
    return;
  }

  const params = new URLSearchParams(location.search);
  const currentQueue = params.get('queue') || 'potluck';
  const isVineItemsPage = /^\/vine\/vine-items\/?$/.test(location.pathname);
  if (!isVineItemsPage || currentQueue !== 'potluck') return;

  let settings = loadSettings();
  let cache = loadObject(KEYS.cache, {});
  let stateQueue = loadObject(KEYS.stateQueue, {});
  let knownAsins = loadObject(KEYS.knownAsins, {});
  let pendingNew = loadObject(KEYS.pendingNew, {});
  let models = new Map();
  let running = false;
  let timer = null;
  let observerTimer = null;
  let sortGuard = false;
  let statusUi = null;
  let baselineMode = GM_getValue(KEYS.baselineDone, false) !== true;
  let baselineTimer = null;
  const notifying = new Set();
  const pendingChangeAlerts = [];
  const manualRetryPriority = new Set();
  let urgentSyncRequested = false;
  let originalSequence = 0;

  // V7.2 Auto-Reload SAFE
  let autoReloadState = loadAutoReloadState();
  let autoReloadTicker = null;
  let lastUserActivityAt = Date.now();
  let autoReloadWasEnabled = Boolean(settings.autoReloadEnabled);

  // V7.3 — sélection automatique de variante / gestion de la fiche Vine
  let autoVariantRunId = 0;
  let autoVariantRunning = false;

  // V7.8.1 — dernier transport API utilisé sur ce téléphone.
  let lastApiTransport = '—';

  injectStyles();
  applyInterfaceSettings();
  statusUi = createFloatingUi();
  installDelegatedHandlers();
  installMutationObserver();
  installMinuteTicker();
  installMenus();
  installAutoReload();

  if (baselineMode) {
    baselineTimer = setTimeout(() => {
      baselineMode = false;
      GM_setValue(KEYS.baselineDone, true);
      pruneAndSaveKnown();
    }, BASELINE_GRACE_MS);
  }

  processTiles();
  schedule(700);

  // ---------------------------------------------------------------------------
  // Configuration / stockage
  // ---------------------------------------------------------------------------

  function loadSettings() {
    const stored = GM_getValue(KEYS.settings, {});
    return { ...DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
  }

  function saveSettings(next) {
    settings = { ...DEFAULTS, ...next };
    GM_setValue(KEYS.settings, settings);
    applyInterfaceSettings();
    processTiles();
    applySort();
    updateFloatingUi();
    syncAutoReloadSettings();
  }

  function loadObject(key, fallback) {
    const value = GM_getValue(key, fallback);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  }

  function saveCache() {
    const entries = Object.entries(cache)
      .sort((a, b) => Number(b[1]?.saved_at || 0) - Number(a[1]?.saved_at || 0))
      .slice(0, MAX_CACHE);
    cache = Object.fromEntries(entries);
    GM_setValue(KEYS.cache, cache);
  }

  function saveStateQueue() {
    GM_setValue(KEYS.stateQueue, stateQueue);
  }

  function savePendingNew() {
    const now = Date.now();
    for (const [asin, at] of Object.entries(pendingNew)) {
      if (now - Number(at || 0) > PENDING_NEW_MAX_MS) delete pendingNew[asin];
    }
    GM_setValue(KEYS.pendingNew, pendingNew);
  }

  function pruneAndSaveKnown() {
    const now = Date.now();
    const entries = Object.entries(knownAsins)
      .filter(([, at]) => now - Number(at || 0) <= KNOWN_EXPIRE_MS)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, MAX_KNOWN);
    knownAsins = Object.fromEntries(entries);
    GM_setValue(KEYS.knownAsins, knownAsins);
  }

  function getServerUrl() {
    return String(GM_getValue(KEYS.serverUrl, '') || '').trim().replace(/\/+$/, '');
  }

  function getApiKey() {
    return String(GM_getValue(KEYS.apiKey, '') || '').trim();
  }

  function isPaused() {
    return GM_getValue(KEYS.paused, false) === true;
  }

  function setPaused(value) {
    GM_setValue(KEYS.paused, value === true);
    updateFloatingUi(value ? 'PAUSE' : 'PRÊT');
    if (!value) schedule(150);
  }


  // ---------------------------------------------------------------------------
  // V7.2 — Auto-Reload RFY SAFE
  // ---------------------------------------------------------------------------

  function localDayKey(timestamp = Date.now()) {
    const d = new Date(timestamp);
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    ].join('-');
  }

  function defaultAutoReloadState() {
    return {
      dayKey: localDayKey(),
      countToday: 0,
      nextAt: 0,
      lastReloadAt: 0,
      backoffLevel: 0,
      backoffReason: '',
      lastProblemAt: 0,
      initialized: false,
    };
  }

  function loadAutoReloadState() {
    const stored = GM_getValue(KEYS.autoReloadState, {});
    const state = {
      ...defaultAutoReloadState(),
      ...(stored && typeof stored === 'object' ? stored : {}),
    };

    if (state.dayKey !== localDayKey()) {
      state.dayKey = localDayKey();
      state.countToday = 0;
      state.backoffLevel = 0;
      state.backoffReason = '';
      state.lastProblemAt = 0;
      state.nextAt = 0;
      state.initialized = false;
    }

    return state;
  }

  function saveAutoReloadState() {
    autoReloadState.dayKey = localDayKey();
    GM_setValue(KEYS.autoReloadState, autoReloadState);
  }

  function autoReloadModeRangeMs() {
    const mode = settings.autoReloadMode === 'ultra' ? 'ultra' : 'safe';

    let minMinutes = mode === 'ultra'
      ? Number(settings.autoReloadUltraMinMinutes || 5)
      : Number(settings.autoReloadSafeMinMinutes || 3);

    let maxMinutes = mode === 'ultra'
      ? Number(settings.autoReloadUltraMaxMinutes || 10)
      : Number(settings.autoReloadSafeMaxMinutes || 6);

    minMinutes = Math.max(1, minMinutes);
    maxMinutes = Math.max(minMinutes, maxMinutes);

    return {
      minMs: Math.round(minMinutes * 60 * 1000),
      maxMs: Math.round(maxMinutes * 60 * 1000),
    };
  }

  function randomBetween(min, max) {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  function autoReloadRandomDelayMs() {
    const range = autoReloadModeRangeMs();
    return randomBetween(range.minMs, range.maxMs);
  }

  function autoReloadInitialJitterMs() {
    const maxMinutes = Math.max(0, Number(settings.autoReloadInitialJitterMinutes || 0));
    return randomBetween(0, Math.round(maxMinutes * 60 * 1000));
  }

  function autoReloadDailyCap() {
    return Math.max(1, Math.round(Number(settings.autoReloadDailyCap || 200)));
  }

  function autoReloadBackoffDelayMs(level = autoReloadState.backoffLevel) {
    const delays = [
      5 * 60 * 1000,
      10 * 60 * 1000,
      20 * 60 * 1000,
      60 * 60 * 1000,
    ];
    const index = Math.max(0, Math.min(delays.length - 1, Number(level || 1) - 1));
    return delays[index];
  }

  function detectAmazonProblemPage() {
    const title = String(document.title || '').toLowerCase();
    const body = String(document.body?.innerText || '').toLowerCase().slice(0, 120000);

    if (
      document.querySelector('#captchacharacters, form[action*="validateCaptcha"], input[name="amzn"]') &&
      /captcha|caractères|characters/.test(body)
    ) {
      return 'captcha';
    }

    const patterns = [
      ['automated_access', /automated access|accès automatisé|robot check|api-services-support@amazon\.com/],
      ['service_unavailable', /\b503\b|service unavailable|service indisponible/],
      ['too_many_requests', /\b429\b|too many requests|trop de requêtes/],
      ['amazon_error', /something went wrong|une erreur s['’]est produite|désolé.*problème|sorry.*problem/],
      ['signed_out', /identifiez-vous|se connecter à votre compte|sign in to your account/],
    ];

    for (const [reason, pattern] of patterns) {
      if (pattern.test(title) || pattern.test(body)) return reason;
    }

    return '';
  }

  function enterAutoReloadBackoff(reason) {
    autoReloadState.backoffLevel = Math.min(4, Number(autoReloadState.backoffLevel || 0) + 1);
    autoReloadState.backoffReason = String(reason || 'amazon_problem');
    autoReloadState.lastProblemAt = Date.now();
    autoReloadState.nextAt = Date.now() + autoReloadBackoffDelayMs(autoReloadState.backoffLevel);
    autoReloadState.initialized = true;
    saveAutoReloadState();
    updateAutoReloadButton();
  }

  function clearAutoReloadBackoffIfHealthy() {
    if (!autoReloadState.backoffLevel) return;

    // Une page RFY normale après le dernier incident remet le backoff à zéro.
    if (!detectAmazonProblemPage()) {
      autoReloadState.backoffLevel = 0;
      autoReloadState.backoffReason = '';
      autoReloadState.lastProblemAt = 0;
      saveAutoReloadState();
    }
  }

  function scheduleNextAutoReload({ initial = false, minDelayMs = 0 } = {}) {
    if (!settings.autoReloadEnabled) {
      autoReloadState.nextAt = 0;
      autoReloadState.initialized = false;
      saveAutoReloadState();
      updateAutoReloadButton();
      return;
    }

    if (autoReloadState.dayKey !== localDayKey()) {
      autoReloadState = defaultAutoReloadState();
    }

    if (autoReloadState.countToday >= autoReloadDailyCap()) {
      autoReloadState.nextAt = 0;
      autoReloadState.initialized = true;
      saveAutoReloadState();
      updateAutoReloadButton();
      return;
    }

    let delay = autoReloadRandomDelayMs();

    if (initial) {
      // Décale naturellement les téléphones les uns des autres.
      delay += autoReloadInitialJitterMs();
    }

    if (minDelayMs > 0) delay = Math.max(delay, minDelayMs);

    autoReloadState.nextAt = Date.now() + delay;
    autoReloadState.initialized = true;
    saveAutoReloadState();
    updateAutoReloadButton();
  }

  function autoReloadHasBlockingModal() {
    const localModal = document.querySelector('.vpss-modal-overlay');
    if (localModal) return true;

    const amazonDialog = [...document.querySelectorAll(
      '[role="dialog"], .a-popover-modal, .a-popover-wrapper, .vvp-product-details-modal'
    )].some(el => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 20 &&
        rect.height > 20;
    });

    return amazonDialog;
  }

  function autoReloadActivityGraceMs() {
    return Math.max(
      0,
      Number(settings.autoReloadActivityGraceMinutes || 2) * 60 * 1000
    );
  }

  function deferAutoReload(ms, reason = '') {
    autoReloadState.nextAt = Date.now() + Math.max(1000, Number(ms || 0));
    if (reason) autoReloadState.backoffReason = reason;
    saveAutoReloadState();
    updateAutoReloadButton();
  }

  function prepareAutoReloadScrollRestore() {
    GM_setValue(KEYS.autoReloadScrollY, {
      y: Math.max(0, Math.round(window.scrollY || 0)),
      at: Date.now(),
    });
  }

  function restoreScrollAfterAutoReload() {
    const saved = GM_getValue(KEYS.autoReloadScrollY, null);
    if (!saved || typeof saved !== 'object') return;

    GM_deleteValue(KEYS.autoReloadScrollY);

    const y = Number(saved.y || 0);
    const age = Date.now() - Number(saved.at || 0);

    if (age < 5 * 60 * 1000 && y > 0) {
      setTimeout(() => {
        try { window.scrollTo({ top: y, behavior: 'auto' }); } catch { window.scrollTo(0, y); }
      }, 1400);
    }
  }

  function performAutoReload() {
    if (!settings.autoReloadEnabled) return;

    const problem = detectAmazonProblemPage();
    if (problem) {
      enterAutoReloadBackoff(problem);
      return;
    }

    if (autoReloadState.countToday >= autoReloadDailyCap()) {
      autoReloadState.nextAt = 0;
      saveAutoReloadState();
      updateAutoReloadButton();
      return;
    }

    prepareAutoReloadScrollRestore();

    autoReloadState.countToday = Number(autoReloadState.countToday || 0) + 1;
    autoReloadState.lastReloadAt = Date.now();
    autoReloadState.nextAt = 0;
    autoReloadState.backoffReason = '';
    saveAutoReloadState();

    // Uniquement un rechargement de la page RFY. Aucun clic ni commande Vine.
    location.reload();
  }

  function autoReloadTick() {
    if (autoReloadState.dayKey !== localDayKey()) {
      autoReloadState = defaultAutoReloadState();
      if (settings.autoReloadEnabled) scheduleNextAutoReload({ initial: true });
    }

    updateAutoReloadButton();

    if (!settings.autoReloadEnabled) return;
    if (document.hidden) return;
    if (!autoReloadState.nextAt) {
      if (autoReloadState.countToday < autoReloadDailyCap()) {
        scheduleNextAutoReload({ initial: !autoReloadState.initialized });
      }
      return;
    }

    if (Date.now() < Number(autoReloadState.nextAt || 0)) return;

    // Ne jamais couper une synchronisation D1/Bright Data en cours.
    if (running) {
      deferAutoReload(randomBetween(15_000, 30_000), 'sync_in_progress');
      return;
    }

    // L'utilisateur vient de toucher/clavier/clic : on lui laisse du temps.
    const activityAge = Date.now() - lastUserActivityAt;
    if (activityAge < autoReloadActivityGraceMs()) {
      deferAutoReload(randomBetween(60_000, 120_000), 'user_active');
      return;
    }

    // Aucune fermeture sauvage d'une fiche produit / menu / réglage.
    if (autoReloadHasBlockingModal()) {
      deferAutoReload(randomBetween(60_000, 120_000), 'dialog_open');
      return;
    }

    performAutoReload();
  }

  function toggleAutoReload() {
    const enabled = !settings.autoReloadEnabled;
    saveSettings({ ...settings, autoReloadEnabled: enabled });

    if (enabled) {
      autoReloadState.backoffLevel = 0;
      autoReloadState.backoffReason = '';
      autoReloadState.initialized = false;
      scheduleNextAutoReload({ initial: true });
    } else {
      autoReloadState.nextAt = 0;
      autoReloadState.initialized = false;
      saveAutoReloadState();
    }

    updateAutoReloadButton();
  }

  function syncAutoReloadSettings() {
    const enabled = Boolean(settings.autoReloadEnabled);

    if (enabled && !autoReloadWasEnabled) {
      autoReloadState.initialized = false;
      scheduleNextAutoReload({ initial: true });
    } else if (!enabled && autoReloadWasEnabled) {
      autoReloadState.nextAt = 0;
      autoReloadState.initialized = false;
      saveAutoReloadState();
    } else if (enabled && !autoReloadState.nextAt && autoReloadState.countToday < autoReloadDailyCap()) {
      scheduleNextAutoReload({ initial: false });
    }

    autoReloadWasEnabled = enabled;
    updateAutoReloadButton();
  }

  function autoReloadCountdownText() {
    if (!settings.autoReloadEnabled) return 'AUTO OFF';

    const cap = autoReloadDailyCap();
    const count = Number(autoReloadState.countToday || 0);

    if (count >= cap) return `AUTO LIMITE ${count}/${cap}`;

    if (autoReloadState.backoffLevel > 0 && autoReloadState.nextAt) {
      const remaining = Math.max(0, autoReloadState.nextAt - Date.now());
      return `AUTO ⏸ ${formatDuration(remaining)}`;
    }

    if (!autoReloadState.nextAt) return 'AUTO…';

    const remaining = Math.max(0, autoReloadState.nextAt - Date.now());
    return `AUTO ${formatDuration(remaining)}`;
  }

  function updateAutoReloadButton() {
    if (!statusUi) return;

    const button = statusUi.querySelector('#vpss-autoreload');
    if (!button) return;

    const enabled = Boolean(settings.autoReloadEnabled);
    const count = Number(autoReloadState.countToday || 0);
    const cap = autoReloadDailyCap();
    const mode = settings.autoReloadMode === 'ultra' ? 'ULTRA SAFE' : 'SAFE';

    button.textContent = autoReloadCountdownText();
    button.classList.toggle('is-active', enabled);
    button.classList.toggle('is-paused', autoReloadState.backoffLevel > 0);

    const reason = autoReloadState.backoffReason
      ? `\nPause: ${autoReloadState.backoffReason}`
      : '';

    button.title =
      `${mode} · ${count}/${cap} rechargements aujourd’hui` +
      `\nClique pour ${enabled ? 'désactiver' : 'activer'} l’Auto-Reload.` +
      reason;
  }

  function installAutoReload() {
    restoreScrollAfterAutoReload();

    const problem = detectAmazonProblemPage();
    if (problem && settings.autoReloadEnabled) {
      enterAutoReloadBackoff(problem);
    } else {
      clearAutoReloadBackoffIfHealthy();

      if (settings.autoReloadEnabled && !autoReloadState.nextAt) {
        scheduleNextAutoReload({ initial: !autoReloadState.initialized });
      }
    }

    const activityEvents = ['pointerdown', 'touchstart', 'keydown', 'input', 'change'];
    for (const eventName of activityEvents) {
      window.addEventListener(eventName, () => {
        lastUserActivityAt = Date.now();
      }, { passive: true, capture: true });
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !settings.autoReloadEnabled) return;

      // Si le délai a expiré pendant que l'onglet était caché,
      // ne pas recharger immédiatement au moment où l'utilisateur revient.
      if (autoReloadState.nextAt && Date.now() >= autoReloadState.nextAt) {
        deferAutoReload(randomBetween(20_000, 45_000), 'returned_to_tab');
      }
    });

    clearInterval(autoReloadTicker);
    autoReloadTicker = setInterval(autoReloadTick, 1000);
    autoReloadTick();
  }


  // ---------------------------------------------------------------------------
  // V7.3 — Fiche produit Vine / sélection automatique de variante
  // ---------------------------------------------------------------------------

  function isVisibleElement(element) {
    if (!element) return false;

    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getOpenVineProductDetailsRoot() {
    const desktopMain = document.querySelector('#vvp-product-details-modal--main');
    if (isVisibleElement(desktopMain)) {
      return desktopMain.closest('.a-popover, [role="dialog"]') || desktopMain;
    }

    const mobileMain = document.querySelector('#product-details-sheet-main');
    if (isVisibleElement(mobileMain)) {
      return mobileMain.closest('.a-sheet, [role="dialog"]') || mobileMain;
    }

    // Le footer est un signal robuste sur mobile, y compris quand le conteneur
    // principal n'a pas encore sa hauteur définitive.
    const mobileFooter = document.querySelector('#product-details-sheet-footer');
    const mobileRequest = document.querySelector(
      '#product-details-sheet-request-btn-announce, #product-details-sheet-request-btn-disabled-announce'
    );
    if (isVisibleElement(mobileFooter) && mobileRequest) {
      return mobileFooter.closest('.a-sheet, [role="dialog"]') || mobileFooter.parentElement || mobileFooter;
    }

    const desktopRequest = document.querySelector(
      '#vvp-product-details-modal--request-btn, ' +
      'input[aria-labelledby="vvp-product-details-modal--request-btn-announce"]'
    );
    if (isVisibleElement(desktopRequest)) {
      return desktopRequest.closest('.a-popover, [role="dialog"]') || desktopRequest.parentElement;
    }

    return null;
  }

  function updateToolbarForVineProductModal() {
    const open = Boolean(getOpenVineProductDetailsRoot());
    const shouldHide = open && settings.hideToolbarInProductModal;

    document.documentElement.classList.toggle('vpss-vine-product-modal-open', shouldHide);
    return open;
  }

  function isVariantPlaceholderOption(option) {
    if (!option || option.disabled || option.hidden) return true;

    const value = String(option.value ?? '').trim();
    const text = String(option.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();

    if (!value || /^(?:-1|null|undefined|none)$/i.test(value)) return true;

    return /^(?:sélectionner|selectionner|sélectionnez|selectionnez|choisir|choisissez|choose|select|please select|veuillez sélectionner|veuillez selectionner)\b/i.test(text);
  }

  function getVariantSelects(root = document) {
    const selectors = [
      '#vvp-product-details-modal--variations-container .vvp-variation-dropdown select',
      '#product-details-sheet-main .vvp-variation-dropdown select',
      '.vvp-variation-dropdown .a-dropdown-container select',
    ];

    const result = [];
    const seen = new Set();

    for (const selector of selectors) {
      for (const select of root.querySelectorAll(selector)) {
        if (seen.has(select)) continue;
        if (!isVisibleElement(select)) continue;
        seen.add(select);
        result.push(select);
      }
    }

    return result;
  }

  function getUsableVariantOptions(select) {
    return [...select.options].filter(option => !isVariantPlaceholderOption(option));
  }

  function variantAlreadySelected(select) {
    const option = select.options[select.selectedIndex];
    return Boolean(option && !isVariantPlaceholderOption(option));
  }

  function setNativeSelectValue(select, value) {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value'
    );

    if (descriptor?.set) descriptor.set.call(select, value);
    else select.value = value;

    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function runAutoVariantSelection(expectedRunId) {
    if (!settings.autoVariantEnabled || autoVariantRunning) return;

    autoVariantRunning = true;

    try {
      // Plusieurs passes sont nécessaires parce qu'un premier choix peut
      // reconstruire le dropdown suivant côté Amazon.
      for (let pass = 0; pass < 8; pass++) {
        if (expectedRunId !== autoVariantRunId) return;

        const root = getOpenVineProductDetailsRoot();
        if (!root) return;

        const selects = getVariantSelects(root);
        if (!selects.length) return;

        let changed = false;

        for (const select of selects) {
          if (variantAlreadySelected(select)) continue;

          const candidates = getUsableVariantOptions(select);
          if (!candidates.length) continue;

          if (
            settings.autoVariantMode === 'single_only' &&
            candidates.length !== 1
          ) {
            continue;
          }

          // Mode "first_available" : première option disponible.
          // Aucun bouton "Demander un produit" n'est cliqué.
          const candidate = candidates[0];

          if (String(select.value) !== String(candidate.value)) {
            setNativeSelectValue(select, candidate.value);
            changed = true;

            // Une seule variation à la fois afin de laisser Amazon recalculer
            // les choix dépendants avant la passe suivante.
            break;
          }
        }

        if (!changed) return;

        await new Promise(resolve => setTimeout(resolve, 420));
      }
    } finally {
      autoVariantRunning = false;
    }
  }

  function scheduleAutoVariantSelection() {
    const root = getOpenVineProductDetailsRoot();
    if (!root || !settings.autoVariantEnabled) return;

    const runId = ++autoVariantRunId;

    // Laisse à Amazon le temps de remplir ses dropdowns.
    setTimeout(() => {
      runAutoVariantSelection(runId).catch(error => {
        console.warn('[VPS V7.3] Auto-variante:', error);
      });
    }, 220);
  }

  function handleVineProductModalState() {
    const open = updateToolbarForVineProductModal();

    if (!open) {
      // Invalide toute sélection différée d'une fiche déjà fermée.
      autoVariantRunId++;
      return;
    }

    scheduleAutoVariantSelection();
  }

  // ---------------------------------------------------------------------------
  // API Worker via GM_xmlhttpRequest (clé isolée du localStorage Amazon)
  // ---------------------------------------------------------------------------

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms || 0))));
  }

  function makeApiError(message, code, extra = {}) {
    const error = new Error(message);
    error.code = code || 'API_ERROR';
    Object.assign(error, extra);
    return error;
  }

  function isTransientNetworkError(error) {
    return ['NETWORK', 'TIMEOUT', 'OFFLINE'].includes(String(error?.code || ''));
  }

  function parseApiResponsePayload(text) {
    try { return JSON.parse(String(text || '{}')); } catch { return null; }
  }

  function apiRequestViaGM(path, body, timeout = API_TIMEOUT_MS) {
    const server = getServerUrl();
    const apiKey = getApiKey();

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: server + path,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        data: JSON.stringify(body || {}),
        timeout,
        anonymous: true,
        onload: response => {
          const data = parseApiResponsePayload(response.responseText);

          if (response.status < 200 || response.status >= 300 || !data?.ok) {
            const base = data?.error || `HTTP ${response.status}`;
            const detail = data?.message ? ` · ${data.message}` : '';
            reject(makeApiError(base + detail, 'HTTP', {
              httpStatus: Number(response.status || 0),
              transport: 'GM',
            }));
            return;
          }

          lastApiTransport = 'GM';
          resolve(data);
        },
        ontimeout: () => reject(makeApiError('TIMEOUT GM', 'TIMEOUT', { transport:'GM' })),
        onerror: response => {
          const status = Number(response?.status || 0);
          reject(makeApiError(
            status ? `ERREUR RÉSEAU GM · HTTP ${status}` : 'ERREUR RÉSEAU GM',
            'NETWORK',
            { httpStatus:status, transport:'GM' }
          ));
        },
      });
    });
  }

  async function apiRequestViaFetch(path, body, timeout = API_TIMEOUT_MS) {
    const server = getServerUrl();
    const apiKey = getApiKey();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(server + path, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'follow',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      });

      const text = await response.text();
      const data = parseApiResponsePayload(text);

      if (!response.ok || !data?.ok) {
        const base = data?.error || `HTTP ${response.status}`;
        const detail = data?.message ? ` · ${data.message}` : '';
        throw makeApiError(base + detail, 'HTTP', {
          httpStatus: Number(response.status || 0),
          transport: 'FETCH',
        });
      }

      lastApiTransport = 'FETCH';
      return data;
    } catch (error) {
      if (error?.code === 'HTTP') throw error;

      if (error?.name === 'AbortError') {
        throw makeApiError('TIMEOUT FETCH', 'TIMEOUT', { transport:'FETCH' });
      }

      throw makeApiError(
        `ERREUR RÉSEAU FETCH · ${String(error?.message || error).slice(0, 100)}`,
        'NETWORK',
        { transport:'FETCH' }
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function apiRequestOnce(path, body, timeout = API_TIMEOUT_MS) {
    const server = getServerUrl();
    const apiKey = getApiKey();

    if (!server || !apiKey) {
      throw makeApiError('Serveur non configuré', 'CONFIG');
    }

    if (navigator.onLine === false) {
      throw makeApiError('HORS LIGNE', 'OFFLINE');
    }

    // Transport principal: GM_xmlhttpRequest.
    // Sur certains téléphones/versions Android, GM peut retourner status 0 /
    // "network error" alors que le Worker est parfaitement joignable dans le navigateur.
    try {
      return await apiRequestViaGM(path, body, timeout);
    } catch (gmError) {
      if (!isTransientNetworkError(gmError)) throw gmError;

      // Fallback réseau natif. Le Worker autorise explicitement CORS depuis
      // https://www.amazon.fr et les headers Content-Type / X-API-Key.
      try {
        return await apiRequestViaFetch(path, body, timeout);
      } catch (fetchError) {
        if (!isTransientNetworkError(fetchError)) throw fetchError;

        throw makeApiError(
          `GM + FETCH en échec · ${String(fetchError?.message || fetchError)}`,
          'NETWORK',
          {
            gm_message: String(gmError?.message || gmError),
            fetch_message: String(fetchError?.message || fetchError),
            transport: 'GM+FETCH',
          }
        );
      }
    }
  }

  async function apiRequest(path, body, timeout = API_TIMEOUT_MS, options = {}) {
    const maxRetries = Math.max(0, Math.min(2, Number(options?.retries ?? 2)));
    const waits = [1800, 5500];
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await apiRequestOnce(path, body, timeout);
      } catch (error) {
        lastError = error;

        if (!isTransientNetworkError(error) || attempt >= maxRetries) {
          if (isTransientNetworkError(error) && attempt > 0) {
            error.message = `${error.message} · ${attempt + 1} essais`;
          }
          throw error;
        }

        if (navigator.onLine === false) throw makeApiError('HORS LIGNE', 'OFFLINE');
        await delay(waits[Math.min(attempt, waits.length - 1)]);
      }
    }

    throw lastError || makeApiError('ERREUR RÉSEAU', 'NETWORK');
  }

  async function testServer() {
    return apiRequest('/v1/prices', { asins: [], allow_fetch: false }, 12000);
  }

  // ---------------------------------------------------------------------------
  // Boucle principale
  // ---------------------------------------------------------------------------

  async function sync() {
    if (running || isPaused() || document.hidden) return;

    const server = getServerUrl();
    const apiKey = getApiKey();
    if (!server || !apiKey) {
      updateFloatingUi('À CONFIGURER');
      return;
    }

    processTiles();
    const asins = visibleAsins();
    if (!asins.length) {
      updateFloatingUi('AUCUN PRODUIT');
      schedule(30000);
      return;
    }

    running = true;
    updateFloatingUi('SYNCHRO…');

    try {
      await flushStateQueue();
      const data = await apiRequest('/v1/prices', {
        asins,
        allow_fetch: true,
        client_version: VERSION,
        priority: priorityHints(asins),
      });

      applyServerResults(data.results || {});

      for (const asin of data.fetched_asins || []) {
        manualRetryPriority.delete(asin);
      }

      await flushStateQueue();
      processTiles();
      applySort();
      applyFilters();
      maybeNotifyPending();
      await maybeNotifyChanges();

      const displayed = asins.filter(asin => models.get(asin)?.price).length;
      const cooldownUntil = Number(data?.server?.cooldown_until || 0);

      if (cooldownUntil > Date.now()) {
        updateFloatingUi(`PAUSE SERVEUR · ${formatDuration(cooldownUntil - Date.now())}`);
        schedule(Math.min(Math.max(cooldownUntil - Date.now(), 15 * 60 * 1000), 60 * 60 * 1000));
      } else if (hasPending(data.results || {}, asins)) {
        updateFloatingUi(`€ ${displayed}/${asins.length} · SNAPSHOT…`);
        schedule(3000);
      } else {
        const errorWait = nextErrorRetryDelay(data.results || {}, asins);

        if (errorWait != null) {
          updateFloatingUi(`€ ${displayed}/${asins.length} · RETRY ${formatDuration(errorWait)}`);
          schedule(Math.min(errorWait, 30 * 1000));
        } else if (hasMissingOrStale(data.results || {}, asins)) {
          const cap = Number(data?.remote_capacity?.max_products_per_wave || 20);
          updateFloatingUi(`€ ${displayed}/${asins.length} · FAST+ ≤${cap}`);
          schedule(randomLoopDelay());
        } else {
          updateFloatingUi(`€ ${displayed}/${asins.length} · CACHE OK`);
          schedule(5 * 60 * 1000);
        }
      }
    } catch (error) {
      const message = String(error?.message || error);
      const networkError = isTransientNetworkError(error);
      updateFloatingUi(networkError ? `RÉSEAU · ${message.slice(0, 24)}` : `ERREUR · ${message.slice(0, 28)}`);
      schedule(networkError ? 90 * 1000 : 20 * 1000);
    } finally {
      running = false;

      if (urgentSyncRequested) {
        urgentSyncRequested = false;
        schedule(100);
      }
    }
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(sync, Math.max(100, ms));
  }

  function randomLoopDelay() {
    return LOOP_MIN_MS + Math.floor(Math.random() * (LOOP_MAX_MS - LOOP_MIN_MS + 1));
  }

  function hasPending(results, asins) {
    return asins.some(asin => results?.[asin]?.state === 'pending');
  }

  function hasMissingOrStale(results, asins) {
    return asins.some(asin => ['missing', 'stale', 'expired'].includes(results?.[asin]?.state));
  }

  function applyServerResults(results) {
    const now = Date.now();

    for (const [asin, item] of Object.entries(results)) {
      const previous = cache[asin]?.item || null;
      const merged = {
        ...(previous || {}),
        ...item,
        meta: { ...(cache[asin]?.item?.meta || {}), ...(item?.meta || {}) },
      };

      // Une modification locale non encore synchronisée reste prioritaire sur
      // l'état serveur reçu pendant ce cycle.
      if (stateQueue[asin]) {
        merged.favorite = Boolean(stateQueue[asin].favorite);
        merged.hidden = Boolean(stateQueue[asin].hidden);
        merged.note = String(stateQueue[asin].note || '');
      }

      cache[asin] = { item: merged, saved_at: now };
      models.set(asin, merged);
      detectSignificantChange(asin, previous, merged);
    }

    saveCache();
  }

  function getModel(asin) {
    if (models.has(asin)) return models.get(asin);
    const cached = cache[asin]?.item;
    if (cached) {
      models.set(asin, cached);
      return cached;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Détection produits / âge / nouveautés
  // ---------------------------------------------------------------------------

  function getTiles() {
    return Array.from(document.querySelectorAll('.vvp-item-tile'));
  }

  function getAsin(tile) {
    const direct = String(tile?.getAttribute('data-asin') || '').trim().toUpperCase();
    if (/^[A-Z0-9]{10}$/.test(direct)) return direct;
    const input = tile?.querySelector('input[data-asin]');
    const nested = String(input?.getAttribute('data-asin') || '').trim().toUpperCase();
    return /^[A-Z0-9]{10}$/.test(nested) ? nested : null;
  }

  function visibleAsins() {
    const out = [];
    const seen = new Set();
    for (const tile of getTiles()) {
      const asin = getAsin(tile);
      if (!asin || seen.has(asin)) continue;
      seen.add(asin);
      out.push(asin);
      if (out.length >= 40) break;
    }
    return out;
  }

  function viewportAsins() {
    const out = [];
    const seen = new Set();
    const height = window.innerHeight || document.documentElement.clientHeight || 0;

    for (const tile of getTiles()) {
      const asin = getAsin(tile);
      if (!asin || seen.has(asin)) continue;

      const rect = tile.getBoundingClientRect();
      const visible = rect.bottom > 0 && rect.top < height;
      if (!visible) continue;

      seen.add(asin);
      out.push(asin);
    }

    return out;
  }

  function priorityHints(asins) {
    const allowed = new Set(asins);

    return {
      new_asins: Object.keys(pendingNew).filter(asin => allowed.has(asin)),
      viewport_asins: viewportAsins().filter(asin => allowed.has(asin)),
      forced_asins: [...manualRetryPriority].filter(asin => allowed.has(asin)),
    };
  }

  function nextErrorRetryDelay(results, asins) {
    const waits = [];

    for (const asin of asins) {
      const item = results?.[asin];
      if (item?.state !== 'error') continue;
      const wait = Number(item.retry_after_ms || 0);
      waits.push(Math.max(1000, wait));
    }

    return waits.length ? Math.min(...waits) : null;
  }

  function getVineTitle(tile) {
    return (
      tile?.querySelector('.a-truncate-full.a-offscreen')?.textContent ||
      tile?.querySelector('.a-truncate-cut')?.textContent ||
      tile?.querySelector('.vvp-item-product-title-container')?.textContent ||
      tile?.querySelector('img')?.alt ||
      ''
    ).replace(/\s+/g, ' ').trim();
  }

  function getVineImage(tile) {
    return tile?.querySelector('.vvp-item-tile-content img')?.src || '';
  }

  function registerSeenLocally(asin) {
    const now = Date.now();
    const previous = Number(knownAsins[asin] || 0);
    const isNew = !previous || now - previous > REAPPEAR_AS_NEW_MS;

    knownAsins[asin] = now;

    if (!baselineMode && isNew) {
      pendingNew[asin] = pendingNew[asin] || now;
      savePendingNew();
    }
  }

  function isNewProductForHighlight(asin, model, now = Date.now()) {
    if (!settings.highlightNewProducts) return false;

    const durationMs = Math.max(
      1,
      Number(settings.highlightNewMinutes || 10)
    ) * 60 * 1000;

    // Détection locale immédiate après apparition dans RFY.
    const localNewAt = Number(pendingNew[asin] || 0);
    if (localNewAt > 0 && now - localNewAt < durationMs) return true;

    // Synchronisation multi-appareils via la première apparition serveur.
    const firstSeen = Number(model?.first_seen || 0);
    if (firstSeen > 0 && now - firstSeen < durationMs) return true;

    return false;
  }

  function renderNewProductHighlight(tile, asin, model, now = Date.now()) {
    const isNew = isNewProductForHighlight(asin, model, now);
    tile.classList.toggle('vpss-new-product', isNew);

    if (isNew) {
      tile.dataset.vpssNewProduct = '1';
    } else {
      delete tile.dataset.vpssNewProduct;
    }
  }

  function processTiles() {
    const now = Date.now();
    for (const tile of getTiles()) {
      const asin = getAsin(tile);
      if (!asin) continue;

      if (!tile.dataset.vpssOriginalOrder) {
        tile.dataset.vpssOriginalOrder = String(++originalSequence);
      }

      registerSeenLocally(asin);
      ensureTileControls(tile, asin);

      const model = getModel(asin);
      if (model) renderTile(tile, asin, model, now);
      else renderCachedSkeleton(tile, asin);
    }

    pruneAndSaveKnown();
    savePendingNew();
    applySort();
    applyFilters();
  }

  function renderCachedSkeleton(tile, asin) {
    const cached = cache[asin]?.item;
    if (cached) {
      renderTile(tile, asin, cached, Date.now());
      return;
    }

    renderNewProductHighlight(tile, asin, null, Date.now());
  }

  // ---------------------------------------------------------------------------
  // Affichage produit
  // ---------------------------------------------------------------------------

  function ensureImageWrapper(tile) {
    const image = tile?.querySelector('.vvp-item-tile-content img');
    if (!image) return null;
    const wrapper = image.parentElement;
    if (!wrapper) return null;
    if (getComputedStyle(wrapper).position === 'static') wrapper.style.position = 'relative';
    return wrapper;
  }

  function ensureTileControls(tile, asin) {
    if (tile.querySelector(':scope .vpss-actions')) return;

    const host = tile.querySelector('.vvp-item-tile-content') || tile;
    const row = document.createElement('div');
    row.className = 'vpss-actions';
    row.innerHTML = `
      <button type="button" data-vpss-action="favorite" data-asin="${asin}" title="Favori synchronisé">♡</button>
      <button type="button" data-vpss-action="hidden" data-asin="${asin}" title="Cacher ce produit">🙈</button>
      <button type="button" data-vpss-action="info" data-asin="${asin}" title="Fiche détaillée">ⓘ</button>
      <span class="vpss-note-dot" title="Une note est enregistrée">📝</span>
    `;
    host.appendChild(row);
  }

  function renderTile(tile, asin, model, now) {
    const wrapper = ensureImageWrapper(tile);
    if (!wrapper) return;

    renderPriceBadge(tile, asin, model);
    renderAgeBadge(wrapper, model, now);
    renderScoreBadge(wrapper, asin, model, tile);
    renderMetaBadges(tile, model);
    renderState(tile, asin, model);
    renderNewProductHighlight(tile, asin, model, now);
    renderKeywordHighlight(tile);
  }

  function renderPriceBadge(tile, asin, model) {
    const host = tile.querySelector('.vvp-item-tile-content') || tile;

    let row = host.querySelector(':scope > .vpss-price-row');
    if (!row) {
      row = document.createElement('div');
      row.className = 'vpss-price-row';
      const actions = host.querySelector(':scope > .vpss-actions');
      if (actions) host.insertBefore(row, actions);
      else host.appendChild(row);
    }

    let badge = row.querySelector(':scope > .vpss-price-badge');
    if (!badge) {
      badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'vpss-price-badge';
      badge.dataset.vpssAction = 'info';
      badge.dataset.asin = asin;
      row.appendChild(badge);
    }

    let retry = row.querySelector(':scope > .vpss-price-retry');
    const retryable = ['no_price', 'error'].includes(String(model?.state || ''));

    if (retryable && !retry) {
      retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'vpss-price-retry';
      retry.dataset.vpssAction = 'retry';
      retry.dataset.asin = asin;
      retry.textContent = '↻';
      retry.title = 'Retenter ce produit maintenant';
      row.appendChild(retry);
    } else if (!retryable && retry) {
      retry.remove();
      retry = null;
    }

    const hasPrice = model?.price !== null && model?.price !== undefined && model?.price !== '';
    if (!hasPrice) {
      const state = String(model?.state || 'missing');
      badge.dataset.tier = 'unknown';
      badge.classList.add('vpss-price-pending');

      if (state === 'blocked') {
        badge.textContent = 'Prix · PAUSE';
        badge.title = 'Le serveur distant est temporairement en pause.';
      } else if (state === 'no_price') {
        badge.textContent = 'Prix · N/D';
        badge.title = 'Bright Data n’a pas fourni de prix exploitable. ↻ permet de forcer une nouvelle tentative.';
      } else if (state === 'error') {
        badge.textContent = 'Prix · ERREUR';
        badge.title = 'La dernière récupération Bright Data a échoué. ↻ permet de retenter immédiatement.';
      } else {
        badge.textContent = 'Prix · …';
        badge.title = 'Prix pas encore récupéré.';
      }
      return;
    }

    badge.classList.remove('vpss-price-pending');

    const price = Number(model.price);
    const tier = getPriceTier(price);
    badge.dataset.tier = tier.name;

    const approximatePrice = model?.meta?.price_approximate === true;
    const resolvedAsin = String(model?.meta?.resolved_asin || '');
    const matchMode = String(model?.meta?.price_match_mode || '');

    const delta = Number(model.delta_cents);
    let deltaText = '';
    if (Number.isFinite(delta) && delta !== 0) {
      deltaText = delta > 0
        ? ` ↗ +${formatEuros(Math.abs(delta) / 100)}`
        : ` ↘ -${formatEuros(Math.abs(delta) / 100)}`;
    }

    const discount = Number(model?.meta?.discount_percent || 0);
    const discountText = discount > 0 ? ` · -${discount}%` : '';
    const stalePrefix = model?.state === 'stale' ? '~' : '';
    const staleSuffix = model?.state === 'stale' ? ' · MAJ' : '';
    const variantPrefix = approximatePrice ? '≈ ' : '';
    badge.textContent = `${variantPrefix}${tier.icon}${stalePrefix}${formatEuros(price)}${deltaText}${discountText}${staleSuffix}`;
    badge.title = buildPriceTooltip(model) +
      (approximatePrice
        ? `\nPrix Bright Data obtenu après résolution vers une variante${resolvedAsin ? ` (${resolvedAsin})` : ''}.`
        : '') +
      (matchMode ? `\nCorrespondance : ${matchMode}` : '');
  }

  function renderMetaBadges(tile, model) {
    const host = tile.querySelector('.vvp-item-tile-content') || tile;
    let row = host.querySelector(':scope > .vpss-meta-badges');

    if (!settings.showMetaBadges) {
      if (row) row.remove();
      return;
    }

    if (!row) {
      row = document.createElement('div');
      row.className = 'vpss-meta-badges';
      const actions = host.querySelector(':scope > .vpss-actions');
      if (actions) host.insertBefore(row, actions);
      else host.appendChild(row);
    }

    const meta = model?.meta || {};
    const parts = [];
    const rating = Number(meta.rating);
    const reviews = Number(meta.review_count);
    const discount = Number(meta.discount_percent);
    const rank = Number(meta.bs_rank || meta.root_bs_rank);
    const stock = Number(meta.products_in_stock);

    if (Number.isFinite(rating) && rating > 0) parts.push(`⭐${rating.toFixed(1)}`);
    if (Number.isFinite(reviews) && reviews > 0) parts.push(`${reviews.toLocaleString('fr-FR')} avis`);
    if (Number.isFinite(discount) && discount > 0) parts.push(`-${Math.round(discount)}%`);
    if (Number.isFinite(rank) && rank > 0) parts.push(`#${Math.round(rank).toLocaleString('fr-FR')}`);
    if (Number.isFinite(stock) && stock >= 0) parts.push(`${Math.round(stock)} stock`);
    if (meta.is_amazon_as_seller === true) parts.push('Amazon');
    else if (Number(meta.fba_sellers_count || 0) > 0) parts.push('FBA');
    if (meta.coupon_text) parts.push('Coupon');

    row.textContent = parts.slice(0, 5).join(' · ') || 'Données Bright Data en attente';
    row.title = parts.join(' · ');
  }

  function buildPriceTooltip(model) {
    const parts = [`Prix: ${formatEuros(Number(model.price || 0))}`];
    if (model.previous_price) parts.push(`Précédent: ${formatEuros(Number(model.previous_price))}`);
    if (model.min_30d) parts.push(`Min 30j: ${formatEuros(Number(model.min_30d))}`);
    if (model.max_30d) parts.push(`Max 30j: ${formatEuros(Number(model.max_30d))}`);
    parts.push('Cliquer pour la fiche détaillée');
    return parts.join('\n');
  }

  function getPriceTier(price) {
    if (!Number.isFinite(price)) return { name: 'unknown', icon: '' };
    if (price >= Number(settings.priceStar || 100)) return { name: 'star', icon: '⭐ ' };
    if (price >= Number(settings.priceHot || 50)) return { name: 'hot', icon: '🔥 ' };
    if (price >= Number(settings.priceFocus || 30)) return { name: 'focus', icon: '● ' };
    return { name: 'normal', icon: '' };
  }


  function scoreWeights() {
    const raw = {
      price: Math.max(0, Number(settings.scoreWeightPrice || 0)),
      freshness: Math.max(0, Number(settings.scoreWeightFreshness || 0)),
      discount: Math.max(0, Number(settings.scoreWeightDiscount || 0)),
      rating: Math.max(0, Number(settings.scoreWeightRating || 0)),
      reviews: Math.max(0, Number(settings.scoreWeightReviews || 0)),
      keywords: Math.max(0, Number(settings.scoreWeightKeywords || 0)),
      rank: Math.max(0, Number(settings.scoreWeightRank || 0)),
      availability: Math.max(0, Number(settings.scoreWeightAvailability || 0)),
      seller: Math.max(0, Number(settings.scoreWeightSeller || 0)),
      history: Math.max(0, Number(settings.scoreWeightHistory || 0)),
      favorite: Math.max(0, Number(settings.scoreWeightFavorite || 0)),
    };
    const sum = Object.values(raw).reduce((a, b) => a + b, 0) || 100;
    const scale = 100 / sum;
    return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value * scale]));
  }

  function calculateInterestScoreDetails(model, title = '') {
    if (!settings.scoreEnabled) return { total: 0, parts: {}, weights: scoreWeights() };

    const meta = model?.meta || {};
    const price = Number(model?.price);
    const reference = Math.max(1, Number(settings.scorePriceReference || 100));
    const weights = scoreWeights();
    const ratio = {};

    ratio.price = Number.isFinite(price) && price > 0 ? Math.min(1, price / reference) : 0;

    const age = model?.first_seen ? Math.max(0, Date.now() - Number(model.first_seen)) : Infinity;
    ratio.freshness = age < 10 * 60 * 1000 ? 1
      : age < 60 * 60 * 1000 ? .8
      : age < 6 * 60 * 60 * 1000 ? .55
      : age < 24 * 60 * 60 * 1000 ? .33
      : age < 48 * 60 * 60 * 1000 ? .13 : 0;

    const discount = Number(meta.discount_percent || 0);
    ratio.discount = Math.min(1, (discount > 0 ? discount / 40 : 0) + (meta.coupon_text ? .2 : 0));

    const rating = Number(meta.rating);
    ratio.rating = Number.isFinite(rating) && rating > 0 ? Math.min(1, rating / 5) : 0;

    const reviews = Math.max(0, Number(meta.review_count || 0));
    ratio.reviews = reviews > 0 ? Math.min(1, Math.log10(reviews + 1) / 4) : 0;

    const words = parseWordList(settings.scoreKeywords || settings.highlightWords);
    const searchable = [title, meta.title, meta.brand, meta.category,
      ...(Array.isArray(meta.categories) ? meta.categories : []),
      ...(Array.isArray(meta.features) ? meta.features.slice(0, 5) : [])
    ].filter(Boolean).join(' ').toLowerCase();
    ratio.keywords = words.length && words.some(word => searchable.includes(word.toLowerCase())) ? 1 : 0;

    const ranks = [Number(meta.bs_rank), Number(meta.root_bs_rank)].filter(n => Number.isFinite(n) && n > 0);
    const rank = ranks.length ? Math.min(...ranks) : null;
    ratio.rank = rank == null ? 0 : rank <= 10 ? 1 : rank <= 100 ? .875 : rank <= 1000 ? .625 : rank <= 10000 ? .375 : rank <= 100000 ? .125 : 0;

    ratio.availability = meta.is_available === true || /disponible|en stock/i.test(String(meta.availability || '')) ? 1 : 0;

    const sellers = Number(meta.number_of_sellers);
    let sellerRatio = 0;
    if (meta.buybox_seller || meta.seller) sellerRatio += .5;
    if (meta.is_amazon_as_seller === true || Number(meta.fba_sellers_count || 0) > 0) sellerRatio += .5;
    else if (Number.isFinite(sellers) && sellers > 0) sellerRatio += sellers === 1 ? .5 : sellers <= 3 ? .25 : .125;
    ratio.seller = Math.min(1, sellerRatio);

    const previous = Number(model?.previous_price);
    ratio.history = Number.isFinite(price) && Number.isFinite(previous) && previous > 0 && price < previous
      ? Math.min(1, (((previous - price) / previous) * 100) / 20)
      : 0;

    ratio.favorite = model?.favorite ? 1 : 0;

    const parts = {};
    let total = 0;
    for (const key of Object.keys(weights)) {
      const value = Math.max(0, Math.min(1, Number(ratio[key] || 0))) * weights[key];
      parts[key] = Math.round(value);
      total += value;
    }

    return { total: Math.max(0, Math.min(100, Math.round(total))), parts, weights };
  }

  function calculateInterestScore(model, title = '') {
    return calculateInterestScoreDetails(model, title).total;
  }

  function renderScoreBadge(wrapper, asin, model, tile) {
    let badge = wrapper.querySelector(':scope > .vpss-score-badge');
    if (!settings.scoreEnabled) {
      badge?.remove();
      return;
    }

    if (!badge) {
      badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'vpss-score-badge';
      badge.dataset.vpssAction = 'info';
      badge.dataset.asin = asin;
      wrapper.appendChild(badge);
    }

    const hasPrice = model?.price !== null && model?.price !== undefined && model?.price !== '';
    const title = model?.meta?.title || getVineTitle(tile) || '';
    const score = calculateInterestScore(model, title);

    if (!hasPrice) {
      badge.textContent = `Score ${score}*`;
      badge.dataset.level = score >= 85 ? 'high' : (score >= 65 ? 'medium' : 'normal');
      badge.title = `Score provisoire : ${score}/100. Le prix n'est pas encore disponible, donc la partie liée au prix n'est pas comptée.`;
      return;
    }

    badge.textContent = `Score ${score}`;
    badge.dataset.level = score >= 85 ? 'high' : (score >= 65 ? 'medium' : 'normal');
    badge.title = `Score d'intérêt personnel : ${score}/100`;
  }

  function renderAgeBadge(wrapper, model, now) {
    let badge = wrapper.querySelector(':scope > .vpss-age-badge');
    if (!model?.first_seen) {
      if (badge) badge.remove();
      return;
    }

    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'vpss-age-badge';
      wrapper.appendChild(badge);
    }

    const age = Math.max(0, now - Number(model.first_seen));
    badge.textContent = age < 10 * 60 * 1000 ? `NOUV. · ${formatAge(age)}` : formatAge(age);
    badge.classList.toggle('is-new', age < 10 * 60 * 1000);
    badge.title = `Première apparition serveur : ${formatDateTime(model.first_seen)}`;
  }

  function renderState(tile, asin, model) {
    const fav = tile.querySelector('[data-vpss-action="favorite"]');
    const hidden = tile.querySelector('[data-vpss-action="hidden"]');
    const note = tile.querySelector('.vpss-note-dot');

    if (fav) {
      fav.textContent = model.favorite ? '♥' : '♡';
      fav.classList.toggle('is-active', Boolean(model.favorite));
    }
    if (hidden) {
      hidden.textContent = model.hidden ? '👁' : '🙈';
      hidden.title = model.hidden ? 'Réafficher ce produit' : 'Cacher ce produit';
      hidden.classList.toggle('is-active', Boolean(model.hidden));
    }
    if (note) note.style.display = model.note ? 'inline-flex' : 'none';

    tile.classList.toggle('vpss-favorite', Boolean(model.favorite));
    tile.classList.toggle('vpss-hidden-product', Boolean(model.hidden));
    tile.classList.toggle('vpss-show-hidden', Boolean(model.hidden && settings.showHidden));

    if (model.hidden && !settings.showHidden) {
      tile.style.display = 'none';
    } else {
      tile.style.removeProperty('display');
    }
  }

  function renderKeywordHighlight(tile) {
    const title = getVineTitle(tile).toLowerCase();
    const words = parseWordList(settings.highlightWords);
    const matched = words.some(word => title.includes(word.toLowerCase()));
    tile.classList.toggle('vpss-keyword-match', matched);
  }

  // ---------------------------------------------------------------------------
  // Favoris / cachés / notes synchronisés
  // ---------------------------------------------------------------------------

  function getStateForAsin(asin) {
    const model = getModel(asin) || {};
    return {
      favorite: Boolean(model.favorite),
      hidden: Boolean(model.hidden),
      note: String(model.note || ''),
    };
  }

  function updateLocalState(asin, patch) {
    const base = getModel(asin) || {};
    const next = { ...base, ...patch };
    models.set(asin, next);
    cache[asin] = { item: next, saved_at: Date.now() };
    saveCache();

    const tile = getTiles().find(t => getAsin(t) === asin);
    if (tile) renderState(tile, asin, next);
    applyFilters();
  }

  function queueStateUpdate(asin, nextState) {
    stateQueue[asin] = {
      asin,
      favorite: Boolean(nextState.favorite),
      hidden: Boolean(nextState.hidden),
      note: String(nextState.note || '').slice(0, 4000),
      queued_at: Date.now(),
    };
    saveStateQueue();
    schedule(150);
  }

  async function flushStateQueue() {
    const updates = Object.values(stateQueue).slice(0, 40);
    if (!updates.length || !getServerUrl() || !getApiKey()) return;

    try {
      const data = await apiRequest('/v1/state', { updates });
      for (const item of updates) delete stateQueue[item.asin];
      saveStateQueue();

      for (const [asin, state] of Object.entries(data.states || {})) {
        updateLocalState(asin, {
          favorite: Number(state.favorite || 0) === 1,
          hidden: Number(state.hidden || 0) === 1,
          note: state.note || '',
          state_updated_at: Number(state.updated_at || 0),
        });
      }
    } catch {
      // La file reste locale et sera renvoyée au prochain cycle.
    }
  }

  // ---------------------------------------------------------------------------
  // Tri
  // ---------------------------------------------------------------------------

  function applySort() {
    if (sortGuard) return;
    const container = document.getElementById('vvp-items-grid');
    if (!container) return;

    const tiles = Array.from(container.children).filter(el => el.classList?.contains('vvp-item-tile'));
    if (!tiles.length) return;

    const mode = settings.sortMode || 'price_desc';
    sortGuard = true;

    const score = tile => {
      const asin = getAsin(tile);
      const model = asin ? getModel(asin) : null;
      const original = Number(tile.dataset.vpssOriginalOrder || 999999);
      const price = Number(model?.price);
      const age = Number(model?.first_seen || 0);
      const favorite = model?.favorite ? 1 : 0;
      const interest = calculateInterestScore(model, model?.meta?.title || getVineTitle(tile));
      const rating = Number(model?.meta?.rating);
      const reviews = Number(model?.meta?.review_count);
      const discount = Number(model?.meta?.discount_percent);
      const rank = Number(model?.meta?.bs_rank || model?.meta?.root_bs_rank);
      return { original, price, age, favorite, interest, rating, reviews, discount, rank };
    };

    tiles.sort((a, b) => {
      const A = score(a);
      const B = score(b);

      if (mode === 'default') return A.original - B.original;
      if (mode === 'score_desc') return B.interest - A.interest || B.price - A.price || A.original - B.original;
      if (mode === 'favorites') {
        if (A.favorite !== B.favorite) return B.favorite - A.favorite;
        const ap = Number.isFinite(A.price) ? A.price : -Infinity;
        const bp = Number.isFinite(B.price) ? B.price : -Infinity;
        return bp - ap || A.original - B.original;
      }
      if (mode === 'newest') return B.age - A.age || A.original - B.original;
      if (mode === 'oldest') return A.age - B.age || A.original - B.original;
      if (mode === 'price_asc') {
        const ap = Number.isFinite(A.price) ? A.price : Infinity;
        const bp = Number.isFinite(B.price) ? B.price : Infinity;
        return ap - bp || A.original - B.original;
      }
      if (mode === 'rating_desc') return (Number.isFinite(B.rating) ? B.rating : -1) - (Number.isFinite(A.rating) ? A.rating : -1) || A.original - B.original;
      if (mode === 'reviews_desc') return (Number.isFinite(B.reviews) ? B.reviews : -1) - (Number.isFinite(A.reviews) ? A.reviews : -1) || A.original - B.original;
      if (mode === 'discount_desc') return (Number.isFinite(B.discount) ? B.discount : -1) - (Number.isFinite(A.discount) ? A.discount : -1) || A.original - B.original;
      if (mode === 'rank_asc') return (Number.isFinite(A.rank) ? A.rank : Infinity) - (Number.isFinite(B.rank) ? B.rank : Infinity) || A.original - B.original;

      // price_desc par défaut; prix inconnus à la fin.
      const ap = Number.isFinite(A.price) ? A.price : -Infinity;
      const bp = Number.isFinite(B.price) ? B.price : -Infinity;
      return bp - ap || A.original - B.original;
    });

    const fragment = document.createDocumentFragment();
    tiles.forEach(tile => fragment.appendChild(tile));
    container.appendChild(fragment);
    sortGuard = false;
  }

  function productMatchesFilters(tile, model) {
    const title = (model?.meta?.title || getVineTitle(tile) || '').toLowerCase();
    const brand = String(model?.meta?.brand || '').toLowerCase();
    const category = String(model?.meta?.category || '').toLowerCase();
    const text = String(settings.filterText || '').trim().toLowerCase();
    const price = Number(model?.price);
    const rating = Number(model?.meta?.rating);
    const reviews = Number(model?.meta?.review_count);
    const score = calculateInterestScore(model, model?.meta?.title || getVineTitle(tile));

    if (Number(settings.filterMinPrice || 0) > 0 && (!Number.isFinite(price) || price < Number(settings.filterMinPrice))) return false;
    if (Number(settings.filterMinRating || 0) > 0 && (!Number.isFinite(rating) || rating < Number(settings.filterMinRating))) return false;
    if (Number(settings.filterMinReviews || 0) > 0 && (!Number.isFinite(reviews) || reviews < Number(settings.filterMinReviews))) return false;
    if (Number(settings.filterMinScore || 0) > 0 && score < Number(settings.filterMinScore)) return false;
    if (settings.filterAvailableOnly && model?.meta?.is_available !== true) return false;
    if (settings.filterCouponOnly && !model?.meta?.coupon_text) return false;
    if (settings.filterAmazonSellerOnly && model?.meta?.is_amazon_as_seller !== true) return false;
    if (settings.filterFavoritesOnly && !model?.favorite) return false;
    if (text && !`${title} ${brand} ${category}`.includes(text)) return false;
    return true;
  }

  function applyFilters() {
    for (const tile of getTiles()) {
      const asin = getAsin(tile);
      const model = asin ? getModel(asin) : null;
      const hiddenByState = Boolean(model?.hidden && !settings.showHidden);
      const filtered = model ? !productMatchesFilters(tile, model) : false;
      tile.classList.toggle('vpss-filtered-product', filtered);
      tile.style.display = (hiddenByState || filtered) ? 'none' : '';
    }
    updateFilterButton();
  }

  function activeFilterCount() {
    return [
      Number(settings.filterMinPrice || 0) > 0,
      Number(settings.filterMinRating || 0) > 0,
      Number(settings.filterMinReviews || 0) > 0,
      Number(settings.filterMinScore || 0) > 0,
      Boolean(settings.filterAvailableOnly),
      Boolean(settings.filterCouponOnly),
      Boolean(settings.filterAmazonSellerOnly),
      Boolean(settings.filterFavoritesOnly),
      Boolean(String(settings.filterText || '').trim()),
    ].filter(Boolean).length;
  }

  function updateFilterButton() {
    const button = statusUi?.querySelector('#vpss-filters');
    if (!button) return;
    const count = activeFilterCount();
    button.textContent = count ? `🔎${count}` : '🔎';
    button.classList.toggle('is-active', count > 0);
  }

  function openFilters() {
    closePopup('vpss-filter-modal');
    const modal = document.createElement('div');
    modal.id = 'vpss-filter-modal';
    modal.className = 'vpss-modal-overlay';
    modal.innerHTML = `
      <div class="vpss-dialog">
        <div class="vpss-dialog-title"><strong>🔎 Filtres RFY</strong><button type="button" data-vpss-close>×</button></div>
        <div class="vpss-form-grid">
          <label>Prix minimum (€)<input data-f="filterMinPrice" type="number" min="0" step="1" value="${Number(settings.filterMinPrice || 0)}"></label>
          <label>Note minimum<input data-f="filterMinRating" type="number" min="0" max="5" step="0.1" value="${Number(settings.filterMinRating || 0)}"></label>
          <label>Avis minimum<input data-f="filterMinReviews" type="number" min="0" step="1" value="${Number(settings.filterMinReviews || 0)}"></label>
          <label>Score minimum<input data-f="filterMinScore" type="number" min="0" max="100" step="1" value="${Number(settings.filterMinScore || 0)}"></label>
          <label>Recherche<input data-f="filterText" type="text" value="${escapeHtml(String(settings.filterText || ''))}" placeholder="marque, titre, catégorie"></label>
        </div>
        <div class="vpss-check-row">
          <label class="vpss-check"><input data-f="filterAvailableOnly" type="checkbox" ${settings.filterAvailableOnly ? 'checked' : ''}> Disponible seulement</label>
          <label class="vpss-check"><input data-f="filterCouponOnly" type="checkbox" ${settings.filterCouponOnly ? 'checked' : ''}> Coupon</label>
          <label class="vpss-check"><input data-f="filterAmazonSellerOnly" type="checkbox" ${settings.filterAmazonSellerOnly ? 'checked' : ''}> Amazon vendeur</label>
          <label class="vpss-check"><input data-f="filterFavoritesOnly" type="checkbox" ${settings.filterFavoritesOnly ? 'checked' : ''}> Favoris</label>
        </div>
        <div class="vpss-settings-actions">
          <button type="button" data-filter-apply>Appliquer</button>
          <button type="button" data-filter-reset>Tout effacer</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    bindModalClose(modal);

    modal.querySelector('[data-filter-apply]').addEventListener('click', () => {
      const next = { ...settings };
      modal.querySelectorAll('[data-f]').forEach(input => {
        const key = input.dataset.f;
        next[key] = input.type === 'checkbox' ? input.checked : (input.type === 'number' ? Number(input.value || 0) : input.value);
      });
      saveSettings(next);
      modal.remove();
    });

    modal.querySelector('[data-filter-reset]').addEventListener('click', () => {
      saveSettings({ ...settings,
        filterMinPrice: 0, filterMinRating: 0, filterMinReviews: 0, filterMinScore: 0,
        filterAvailableOnly: false, filterCouponOnly: false, filterAmazonSellerOnly: false,
        filterFavoritesOnly: false, filterText: ''
      });
      modal.remove();
    });
  }

  function getOrCreateDeviceId() {
    let id = String(GM_getValue(KEYS.deviceId, '') || '').trim();

    if (/^[A-Za-z0-9._:-]{4,80}$/.test(id)) return id;

    try {
      id = `dev-${crypto.randomUUID()}`;
    } catch {
      id = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    GM_setValue(KEYS.deviceId, id);
    return id;
  }

  function effectiveDeviceName() {
    const configured = String(settings.deviceName || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);

    if (configured) return configured;

    const suffix = getOrCreateDeviceId()
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(-6)
      .toUpperCase();

    return `Vine-${suffix || 'TEL'}`;
  }

  function notificationDevicePayload() {
    return {
      device_id: getOrCreateDeviceId(),
      device_name: effectiveDeviceName(),
      allow_second_device_notification: Boolean(settings.notificationSecondDevice),
    };
  }

  // ---------------------------------------------------------------------------
  // Notifications intelligentes / déduplication serveur
  // ---------------------------------------------------------------------------

  function detectSignificantChange(asin, previous, next) {
    if (!settings.notificationsEnabled || !settings.notificationChangesEnabled) return;
    if (!previous || !next) return;

    const oldPrice = Number(previous.price);
    const newPrice = Number(next.price);
    if (Number.isFinite(oldPrice) && Number.isFinite(newPrice) && oldPrice > 0 && newPrice < oldPrice) {
      const drop = ((oldPrice - newPrice) / oldPrice) * 100;
      if (drop >= Number(settings.notificationPriceDropPercent || 15)) {
        pendingChangeAlerts.push({ asin, type: 'price_drop', signature: `drop:${newPrice.toFixed(2)}`, message: `Prix -${Math.round(drop)}%` });
      }
    }

    if (settings.notificationAvailabilityReturn && previous?.meta?.is_available === false && next?.meta?.is_available === true) {
      pendingChangeAlerts.push({ asin, type: 'availability', signature: `available:${next.price || ''}`, message: 'De nouveau disponible' });
    }

    if (settings.notificationCouponAppears && !previous?.meta?.coupon_text && next?.meta?.coupon_text) {
      pendingChangeAlerts.push({ asin, type: 'coupon', signature: `coupon:${String(next.meta.coupon_text).slice(0, 80)}`, message: 'Nouveau coupon' });
    }
  }

  async function maybeNotifyChanges() {
    if (!settings.notificationsEnabled || !settings.notificationChangesEnabled) return;
    const event = pendingChangeAlerts.shift();
    if (!event || notifying.has(event.asin)) return;

    const model = getModel(event.asin);
    if (!model || (settings.notificationIgnoreHidden && model.hidden)) return;

    const tile = getTiles().find(t => getAsin(t) === event.asin);
    const title = model?.meta?.title || getVineTitle(tile) || event.asin;
    const image = model?.meta?.image_url || getVineImage(tile) || '';
    const price = Number(model.price);
    const score = calculateInterestScore(model, title);

    notifying.add(event.asin);
    try {
      const response = await apiRequest('/v1/notify', {
        asin: event.asin,
        event_type: event.type,
        signature: event.signature,
        title: `${event.message} · ${title}`,
        price: Number.isFinite(price) ? price.toFixed(2) : '',
        score,
        priority: 'important',
        image_url: image,
        channels: {
          pushover: Boolean(settings.notifyPushover),
          discord: Boolean(settings.notifyDiscord),
        },
        ...notificationDevicePayload(),
      });
      if (response.claimed) {
        if (settings.notifyBrowser) sendBrowserNotification({ asin: event.asin, title: `${event.message} · ${title}`, price, image, score, priority: 'important' });
        if (settings.notifySound) playNotificationSound('important');
      }
    } catch {
      pendingChangeAlerts.unshift(event);
    } finally {
      notifying.delete(event.asin);
    }
  }

  async function maybeNotifyPending() {
    if (!settings.notificationsEnabled) return;
    const channelsEnabled = settings.notifyBrowser || settings.notifySound || settings.notifyPushover || settings.notifyDiscord;
    if (!channelsEnabled) return;

    const now = Date.now();
    const entries = Object.entries(pendingNew)
      .filter(([, at]) => now - Number(at || 0) <= PENDING_NEW_MAX_MS)
      .sort((a, b) => Number(a[1]) - Number(b[1]));

    for (const [asin] of entries) {
      if (notifying.has(asin)) continue;
      const model = getModel(asin);
      if (!model) continue;

      if (settings.notificationIgnoreHidden && model.hidden) {
        delete pendingNew[asin];
        savePendingNew();
        continue;
      }

      const tile = getTiles().find(t => getAsin(t) === asin);
      const title = model?.meta?.title || getVineTitle(tile) || asin;
      const image = model?.meta?.image_url || getVineImage(tile) || '';
      const price = Number(model.price);
      const score = calculateInterestScore(model, title);
      const ageMin = model?.first_seen ? Math.max(0, (now - Number(model.first_seen)) / 60000) : Infinity;
      const keywords = parseWordList(settings.notificationKeywords);

      // Si un prix minimum est configuré mais que le serveur ne connaît pas encore le prix,
      // on garde le candidat en attente plutôt que de le rejeter trop tôt.
      const minPrice = Number(settings.notificationMinPrice || 0);
      if (minPrice > 0 && !Number.isFinite(price)) continue;

      const criteria = [];
      if (minPrice > 0) criteria.push(Number.isFinite(price) && price >= minPrice);
      const minScore = Number(settings.notificationMinScore || 0);
      if (minScore > 0) criteria.push(score >= minScore);
      const maxAge = Number(settings.notificationMaxAgeMinutes || 0);
      if (maxAge > 0) criteria.push(ageMin <= maxAge);
      if (keywords.length) criteria.push(keywords.some(word => title.toLowerCase().includes(word.toLowerCase())));

      const logic = settings.notificationLogic === 'any' ? 'any' : 'all';
      const accepted = criteria.length === 0
        ? true
        : (logic === 'any' ? criteria.some(Boolean) : criteria.every(Boolean));

      if (!accepted) {
        // Une fois le prix connu / l'âge dépassé, ce produit ne remplit pas les règles.
        delete pendingNew[asin];
        savePendingNew();
        continue;
      }

      let priority = 'normal';
      if ((Number.isFinite(price) && price >= Number(settings.notificationUrgentPrice || 150)) ||
          score >= Number(settings.notificationUrgentScore || 90)) {
        priority = 'urgent';
      } else if (Number.isFinite(price) && price >= Number(settings.notificationImportantPrice || 75)) {
        priority = 'important';
      }

      notifying.add(asin);
      try {
        const response = await apiRequest('/v1/notify', {
          asin,
          event_type: 'new',
          signature: `new:${Number.isFinite(price) ? price.toFixed(2) : 'na'}:${score}`,
          title,
          price: Number.isFinite(price) ? price.toFixed(2) : '',
          score,
          priority,
          image_url: image,
          channels: {
            pushover: Boolean(settings.notifyPushover),
            discord: Boolean(settings.notifyDiscord),
          },
          ...notificationDevicePayload(),
        });

        if (response.claimed) {
          if (settings.notifyBrowser) sendBrowserNotification({ asin, title, price, image, score, priority });
          if (settings.notifySound) playNotificationSound(priority);
        }

        delete pendingNew[asin];
        savePendingNew();
      } catch {
        // On conserve le candidat pour le prochain cycle.
      } finally {
        notifying.delete(asin);
      }

      break;
    }
  }

  function sendBrowserNotification({ asin, title, price, image, score, priority }) {
    const level = priority === 'urgent' ? '🔴 URGENT' : (priority === 'important' ? '🟠 IMPORTANT' : '🟢 RFY');
    const text = `${level} · ${Number.isFinite(price) ? formatEuros(price) : 'prix N/C'} · score ${score}/100`;
    const url = `https://www.amazon.fr/dp/${asin}`;

    try {
      GM_notification({
        title: title.slice(0, 110),
        text,
        image: image || undefined,
        timeout: 12000,
        onclick: () => window.open(url, '_blank', 'noopener'),
      });
    } catch {
      if ('Notification' in window && Notification.permission === 'granted') {
        const notification = new Notification(title.slice(0, 110), { body: text, icon: image || undefined });
        notification.onclick = () => window.open(url, '_blank', 'noopener');
      }
    }
  }

  function playNotificationSound(priority = 'normal') {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const playTone = (freq, start, duration) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
        gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + duration);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + duration + 0.03);
      };
      playTone(740, 0, 0.16);
      playTone(980, 0.19, 0.20);
      setTimeout(() => ctx.close().catch(() => {}), 800);
    } catch {}
  }

  // ---------------------------------------------------------------------------
  // Fiche détaillée + historique + bloc-notes
  // ---------------------------------------------------------------------------

  async function openProductPopup(asin) {
    closePopup('vpss-product-modal');
    const model = getModel(asin) || {};
    const tile = getTiles().find(t => getAsin(t) === asin);

    const modal = document.createElement('div');
    modal.id = 'vpss-product-modal';
    modal.className = 'vpss-modal-overlay';
    modal.innerHTML = `
      <div class="vpss-dialog vpss-product-dialog">
        <div class="vpss-dialog-title">
          <strong>Fiche produit SAFE V7</strong>
          <button type="button" data-vpss-close>×</button>
        </div>
        <div class="vpss-loading">Chargement depuis le cache serveur…</div>
      </div>
    `;
    document.body.appendChild(modal);
    bindModalClose(modal);

    try {
      const data = await apiRequest('/v1/product', { asin });
      const item = data.item || model;
      if (item) {
        models.set(asin, { ...model, ...item, meta: { ...(model.meta || {}), ...(item.meta || {}) } });
      }
      renderProductPopup(modal, asin, models.get(asin) || item || {}, data.history || [], tile);
    } catch (error) {
      renderProductPopup(modal, asin, model, [], tile, String(error?.message || error));
    }
  }

  function renderProductPopup(modal, asin, item, history, tile, error = '') {
    const dialog = modal.querySelector('.vpss-dialog');
    if (!dialog) return;

    const meta = item?.meta || {};
    const title = meta.title || getVineTitle(tile) || asin;
    const image = meta.image_url || getVineImage(tile) || '';
    const currentPrice = item?.price ? formatEuros(Number(item.price)) : 'N/C';
    const listPrice = meta.list_price ? formatEuros(Number(meta.list_price)) : '—';
    const previous = item?.previous_price ? formatEuros(Number(item.previous_price)) : '—';
    const min30 = item?.min_30d ? formatEuros(Number(item.min_30d)) : '—';
    const max30 = item?.max_30d ? formatEuros(Number(item.max_30d)) : '—';
    const sparkline = buildSparkline(history);
    const interestScore = calculateInterestScore(item, title);

    dialog.innerHTML = `
      <div class="vpss-dialog-title">
        <strong>Fiche produit SAFE V7</strong>
        <button type="button" data-vpss-close>×</button>
      </div>
      ${error ? `<div class="vpss-error">${escapeHtml(error)}</div>` : ''}
      <div class="vpss-product-head">
        ${image ? `<img class="vpss-product-image" src="${escapeAttr(image)}" alt="">` : ''}
        <div>
          <div class="vpss-product-title">${escapeHtml(title)}</div>
          <div class="vpss-product-asin">${asin}</div>
          <div class="vpss-product-price">${currentPrice}</div>
          ${item?.delta ? `<div class="vpss-price-delta">Variation : ${escapeHtml(item.delta)} €</div>` : ''}
          ${meta.discount_percent ? `<div class="vpss-discount">-${Number(meta.discount_percent)}% vs prix de référence</div>` : ''}
        </div>
      </div>

      <div class="vpss-stats-grid">
        <div><span>Score intérêt</span><strong>🧠 ${interestScore}/100</strong></div>
        <div><span>Prix précédent</span><strong>${previous}</strong></div>
        <div><span>Minimum 30 j</span><strong>${min30}</strong></div>
        <div><span>Maximum 30 j</span><strong>${max30}</strong></div>
        <div><span>Prix de référence</span><strong>${listPrice}</strong></div>
        <div><span>Première apparition</span><strong>${item?.first_seen ? escapeHtml(formatDateTime(item.first_seen)) : '—'}</strong></div>
        <div><span>Âge</span><strong>${item?.first_seen ? escapeHtml(formatAge(Date.now() - item.first_seen)) : '—'}</strong></div>
        <div><span>Dernière apparition</span><strong>${item?.last_seen ? escapeHtml(formatDateTime(item.last_seen)) : '—'}</strong></div>
        <div><span>Sessions vues</span><strong>${Number(item?.seen_count || 0)}</strong></div>
      </div>

      ${(() => {
        const detail = calculateInterestScoreDetails(item, title);
        const p = detail.parts || {};
        return `<div class="vpss-note-box"><b>Détail score ${detail.total}/100 :</b><br>
          Prix ${p.price || 0} · Nouveau ${p.freshness || 0} · Remise ${p.discount || 0} ·
          Note ${p.rating || 0} · Avis ${p.reviews || 0} · Mots/marque/catégorie ${p.keywords || 0} ·
          Classement ${p.rank || 0} · Disponibilité ${p.availability || 0} ·
          Vendeur ${p.seller || 0} · Historique ${p.history || 0} · Favori ${p.favorite || 0}
        </div>`;
      })()}

      <div class="vpss-meta-grid">
        <div><b>Marque :</b> ${escapeHtml(meta.brand || '—')}</div>
        <div><b>Catégorie :</b> ${escapeHtml(meta.category || meta.department || '—')}</div>
        <div><b>Note :</b> ${meta.rating != null ? `${Number(meta.rating).toFixed(1)}/5` : '—'}</div>
        <div><b>Avis :</b> ${meta.review_count != null ? Number(meta.review_count).toLocaleString('fr-FR') : '—'}</div>
        <div><b>Disponibilité :</b> ${escapeHtml(meta.availability || '—')}</div>
        <div><b>Vendeur Buy Box :</b> ${escapeHtml(meta.buybox_seller || meta.seller || '—')}</div>
        <div><b>Nombre de vendeurs :</b> ${meta.number_of_sellers != null ? Number(meta.number_of_sellers) : '—'}</div>
        <div><b>Pays d'origine :</b> ${escapeHtml(meta.country_of_origin || '—')}</div>
        <div><b>Classement :</b> ${meta.bs_rank != null ? Number(meta.bs_rank).toLocaleString('fr-FR') : '—'} ${meta.bs_category ? `en ${escapeHtml(meta.bs_category)}` : ''}</div>
        <div><b>Stock indiqué :</b> ${meta.products_in_stock != null ? Number(meta.products_in_stock) : '—'}</div>
        <div><b>FBA / FBM :</b> ${Number(meta.fba_sellers_count || 0)} / ${Number(meta.fbm_sellers_count || 0)}</div>
        <div><b>Amazon vendeur :</b> ${meta.is_amazon_as_seller === true ? 'Oui' : (meta.is_amazon_as_seller === false ? 'Non' : '—')}</div>
        <div><b>Parent ASIN :</b> ${escapeHtml(meta.parent_asin || '—')}</div>
        <div><b>ASIN résolu :</b> ${escapeHtml(meta.resolved_asin || '—')}</div>
        <div><b>Correspondance prix :</b> ${
          meta.price_approximate
            ? `≈ variante (${escapeHtml(meta.price_match_mode || 'redirect')})`
            : escapeHtml(meta.price_match_mode || 'exacte')
        }</div>
        <div><b>Coupon :</b> ${escapeHtml(meta.coupon_text || '—')}</div>
        <div><b>Source :</b> ${escapeHtml(meta.data_source || '—')}</div>
        <div><b>MAJ Bright Data :</b> ${meta.updated_at ? escapeHtml(formatDateTime(meta.updated_at)) : '—'}</div>
      </div>

      <div class="vpss-history-block">
        <div class="vpss-section-title">Historique de prix</div>
        ${sparkline}
        ${buildHistoryTable(history)}
      </div>

      <div class="vpss-state-row">
        <button type="button" data-popup-favorite>${item?.favorite ? '♥ Retirer favori' : '♡ Ajouter favori'}</button>
        <button type="button" data-popup-hidden>${item?.hidden ? '◉ Réafficher' : '⊘ Cacher'}</button>
        <a href="https://www.amazon.fr/dp/${asin}" target="_blank" rel="noopener noreferrer">Ouvrir Amazon</a>
      </div>

      <label class="vpss-note-label">Bloc-notes synchronisé</label>
      <textarea data-popup-note maxlength="4000" placeholder="Note personnelle pour ce produit…">${escapeHtml(item?.note || '')}</textarea>
      <div class="vpss-popup-actions">
        <button type="button" data-popup-save-note>Enregistrer la note</button>
      </div>
    `;

    bindModalClose(modal);

    dialog.querySelector('[data-popup-favorite]')?.addEventListener('click', () => {
      const state = getStateForAsin(asin);
      state.favorite = !state.favorite;
      updateLocalState(asin, state);
      queueStateUpdate(asin, state);
      flushStateQueue().finally(() => openProductPopup(asin));
    });

    dialog.querySelector('[data-popup-hidden]')?.addEventListener('click', () => {
      const state = getStateForAsin(asin);
      state.hidden = !state.hidden;
      updateLocalState(asin, state);
      queueStateUpdate(asin, state);
      flushStateQueue().finally(() => openProductPopup(asin));
    });

    dialog.querySelector('[data-popup-save-note]')?.addEventListener('click', () => {
      const state = getStateForAsin(asin);
      state.note = dialog.querySelector('[data-popup-note]')?.value || '';
      updateLocalState(asin, state);
      queueStateUpdate(asin, state);
      const button = dialog.querySelector('[data-popup-save-note]');
      if (button) button.textContent = '✓ Note enregistrée localement';
    });
  }

  function buildSparkline(history) {
    const chronological = [...history].reverse().filter(x => Number.isFinite(Number(x.price_cents)));
    if (chronological.length < 2) return '<div class="vpss-empty">Pas encore assez de changements pour une courbe.</div>';

    const values = chronological.map(x => Number(x.price_cents));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const width = 520;
    const height = 100;
    const pad = 8;
    const range = Math.max(1, max - min);
    const points = values.map((value, index) => {
      const x = pad + (index / Math.max(1, values.length - 1)) * (width - pad * 2);
      const y = height - pad - ((value - min) / range) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

    return `
      <svg class="vpss-sparkline" viewBox="0 0 ${width} ${height}" role="img" aria-label="Historique de prix">
        <polyline points="${points}" fill="none" stroke="currentColor" stroke-width="3" vector-effect="non-scaling-stroke"></polyline>
      </svg>
    `;
  }

  function buildHistoryTable(history) {
    if (!history.length) return '<div class="vpss-empty">Aucun historique enregistré.</div>';
    const rows = history.slice(0, 12).map(point => `
      <tr><td>${escapeHtml(formatDateTime(point.fetched_at))}</td><td>${formatEuros(Number(point.price))}</td></tr>
    `).join('');
    return `<table class="vpss-history-table"><thead><tr><th>Date</th><th>Prix</th></tr></thead><tbody>${rows}</tbody></table>`;
  }


  let dashboardSelectedPeriod = 'today';

  async function openDashboard() {
    closePopup('vpss-dashboard-modal');
    const modal = document.createElement('div');
    modal.id = 'vpss-dashboard-modal';
    modal.className = 'vpss-modal-overlay';
    modal.innerHTML = `
      <div class="vpss-dialog vpss-dashboard-dialog">
        <div class="vpss-dialog-title"><strong>📊 Dashboard RFY · SAFE V7.10</strong><button type="button" data-vpss-close>×</button></div>
        <div class="vpss-loading">Lecture de D1…</div>
      </div>`;
    document.body.appendChild(modal);
    bindModalClose(modal);

    try {
      const data = await apiRequest('/v1/dashboard', {}, API_TIMEOUT_MS, { retries:1 });
      renderDashboard(modal, data, dashboardSelectedPeriod);
    } catch (error) {
      modal.querySelector('.vpss-dialog').innerHTML = `
        <div class="vpss-dialog-title"><strong>📊 Dashboard RFY</strong><button type="button" data-vpss-close>×</button></div>
        <div class="vpss-error">${escapeHtml(String(error?.message || error))}</div>`;
      bindModalClose(modal);
    }
  }

  function dashboardPeriodData(data, periodKey) {
    if (data?.periods?.[periodKey]) return data.periods[periodKey];

    if (periodKey === 'week') return {
      key:'week', label:'7 jours', days:7,
      stats:{ seen:Number(data?.last7?.seen_sum || 0), new:Number(data?.last7?.new_sum || 0) },
      daily:data?.last7?.daily || [], top:data?.top || []
    };

    if (periodKey === 'month') return {
      key:'month', label:'30 jours', days:30,
      stats:{ seen:Number(data?.last30?.seen_sum || 0), new:Number(data?.last30?.new_sum || 0) },
      daily:data?.last30?.daily || [], top:data?.top || []
    };

    return {
      key:'today', label:"Aujourd'hui", days:1,
      stats:data?.today || {},
      daily:(data?.last30?.daily || []).slice(-1),
      top:data?.top || []
    };
  }

  function renderDashboard(modal, data, periodKey = 'today') {
    const dialog = modal.querySelector('.vpss-dialog');
    dashboardSelectedPeriod = ['today','week','month'].includes(periodKey) ? periodKey : 'today';

    const period = dashboardPeriodData(data, dashboardSelectedPeriod);
    const stats = period?.stats || {};
    const daily = Array.isArray(period?.daily) ? period.daily : [];
    const maxSeen = Math.max(1, ...daily.map(x => Number(x.seen || 0)));

    const bars = daily.map(day => `
      <div class="vpss-day-row">
        <span>${escapeHtml(String(day.day || '').slice(5))}</span>
        <div class="vpss-day-bar"><i style="width:${Math.max(2, Math.round(Number(day.seen || 0) / maxSeen * 100))}%"></i></div>
        <b>${Number(day.seen || 0)}</b><em>+${Number(day.new || 0)}</em>
      </div>`).join('') || '<div class="vpss-empty">Pas encore de statistiques pour cette période.</div>';

    const topRows = (period?.top || []).map((item, index) => {
      const score = calculateInterestScore(item, item.title || '');
      return `<tr>
        <td>${index + 1}</td><td><b>${formatEuros(Number(item.price))}</b></td><td>🧠 ${score}</td>
        <td>${escapeHtml((item.title || item.asin).slice(0,100))}</td>
        <td><a href="https://www.amazon.fr/dp/${item.asin}" target="_blank" rel="noopener noreferrer">Ouvrir</a></td>
      </tr>`;
    }).join('') || '<tr><td colspan="5">Aucun prix disponible pour cette période.</td></tr>';

    const label = dashboardSelectedPeriod === 'today' ? "aujourd’hui"
      : dashboardSelectedPeriod === 'week' ? 'sur 7 jours' : 'sur 30 jours';

    dialog.innerHTML = `
      <div class="vpss-dialog-title"><strong>📊 Dashboard RFY · SAFE V7.10</strong><button type="button" data-vpss-close>×</button></div>

      <div class="vpss-dashboard-tabs">
        <button type="button" data-dashboard-period="today" class="${dashboardSelectedPeriod === 'today' ? 'is-active' : ''}">Aujourd’hui</button>
        <button type="button" data-dashboard-period="week" class="${dashboardSelectedPeriod === 'week' ? 'is-active' : ''}">7 jours</button>
        <button type="button" data-dashboard-period="month" class="${dashboardSelectedPeriod === 'month' ? 'is-active' : ''}">30 jours</button>
      </div>

      <div class="vpss-dashboard-cards">
        <div><span>Produits uniques ${label}</span><strong>${Number(stats.seen || 0)}</strong></div>
        <div><span>Nouveaux ${label}</span><strong>${Number(stats.new || 0)}</strong></div>
        <div><span>Prix moyen</span><strong>${stats.average_price ? formatEuros(Number(stats.average_price)) : '—'}</strong></div>
        <div><span>≥ 50 €</span><strong>${Number(stats.ge_50 || 0)}</strong></div>
        <div><span>≥ 100 €</span><strong>${Number(stats.ge_100 || 0)}</strong></div>
        <div><span>Favoris vus</span><strong>${Number(stats.favorites || 0)}</strong></div>
        <div><span>Quota Bright Data mois</span><strong>${Number(data?.budget?.records_used_month || 0)} / ${Number(data?.budget?.hard_cap || 5000)}</strong></div>
        <div><span>Bright Data aujourd'hui</span><strong>${Number(data?.budget?.records_used_today || 0)} / ${Number(data?.budget?.daily_cap || 165)}</strong></div>
        <div><span>Reste aujourd'hui</span><strong>${Number(data?.budget?.remaining_daily || 0)}</strong></div>
        <div><span>Reste crédits mois</span><strong>${Number(data?.budget?.remaining_hard || 0)}</strong></div>
        <div><span>Queue serveur</span><strong>${Number(data?.queue?.total || 0)}</strong></div>
        <div><span>Mode budget</span><strong>${escapeHtml(data?.budget?.mode || '—')}</strong></div>
      </div>

      <div class="vpss-section-title">${dashboardSelectedPeriod === 'today' ? 'Aujourd’hui' : dashboardSelectedPeriod === 'week' ? '7 derniers jours' : '30 derniers jours'}</div>
      <div class="vpss-day-chart">${bars}</div>

      <div class="vpss-section-title">Top prix ${label}</div>
      <div class="vpss-table-scroll"><table class="vpss-history-table"><thead><tr><th>#</th><th>Prix</th><th>Score</th><th>Produit</th><th></th></tr></thead><tbody>${topRows}</tbody></table></div>

      <div class="vpss-note-box">Le Dashboard lit uniquement D1. Les onglets ne relancent ni Amazon ni Bright Data.</div>`;

    bindModalClose(modal);

    for (const button of dialog.querySelectorAll('[data-dashboard-period]')) {
      button.addEventListener('click', () => renderDashboard(modal, data, button.dataset.dashboardPeriod || 'today'));
    }
  }


  async function openArchive() {
    closePopup('vpss-archive-modal');
    const modal = document.createElement('div');
    modal.id = 'vpss-archive-modal';
    modal.className = 'vpss-modal-overlay';
    modal.innerHTML = `
      <div class="vpss-dialog vpss-dialog-wide">
        <div class="vpss-dialog-title"><strong>🗂 Archive RFY</strong><button type="button" data-vpss-close>×</button></div>
        <div class="vpss-inline-actions">
          <select data-archive-days><option value="7">7 jours</option><option value="30" selected>30 jours</option><option value="90">90 jours</option><option value="180">180 jours</option></select>
          <input data-archive-search type="text" placeholder="ASIN, titre, marque, catégorie">
          <label class="vpss-check"><input data-archive-favorites type="checkbox"> Favoris</label>
          <button type="button" data-archive-load>Rechercher</button>
        </div>
        <div data-archive-result class="vpss-loading">Chargement…</div>
      </div>`;
    document.body.appendChild(modal);
    bindModalClose(modal);

    const load = async () => {
      const target = modal.querySelector('[data-archive-result]');
      target.innerHTML = '<div class="vpss-loading">Chargement…</div>';
      try {
        const data = await apiRequest('/v1/archive', {
          days: Number(modal.querySelector('[data-archive-days]').value || 30),
          search: modal.querySelector('[data-archive-search]').value || '',
          favorites_only: modal.querySelector('[data-archive-favorites]').checked,
          limit: 250,
        });
        const cards = (data.items || []).map(item => `
          <div class="vpss-archive-card">
            ${item.image_url ? `<img src="${escapeHtml(item.image_url)}" alt="">` : ''}
            <div>
              <b>${escapeHtml(item.title || item.asin)}</b><br>
              <span>${escapeHtml(item.asin)} · ${escapeHtml(item.day || '')}</span><br>
              <span>${item.price != null ? formatEuros(Number(item.price)) : 'Prix N/D'}${item.discount_percent ? ` · -${item.discount_percent}%` : ''}${item.rating ? ` · ⭐${Number(item.rating).toFixed(1)}` : ''}${item.reviews_count ? ` · ${Number(item.reviews_count).toLocaleString('fr-FR')} avis` : ''}</span><br>
              <span>${escapeHtml(item.brand || '')}${item.category ? ` · ${escapeHtml(item.category)}` : ''}${item.favorite ? ' · ♥' : ''}</span>
            </div>
          </div>`).join('');
        target.innerHTML = `<div class="vpss-note-box">${Number(data.count || 0)} résultat(s) · depuis ${escapeHtml(data.since_day || '')}</div>` + (cards || '<div class="vpss-note-box">Aucun résultat.</div>');
      } catch (error) {
        target.innerHTML = `<div class="vpss-error">${escapeHtml(String(error?.message || error))}</div>`;
      }
    };

    modal.querySelector('[data-archive-load]').addEventListener('click', load);
    modal.querySelector('[data-archive-search]').addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
    load();
  }

  async function openServerHealth() {
    closePopup('vpss-health-modal');
    const modal = document.createElement('div');
    modal.id = 'vpss-health-modal';
    modal.className = 'vpss-modal-overlay';
    modal.innerHTML = `<div class="vpss-dialog"><div class="vpss-dialog-title"><strong>🛡 Santé SAFE SERVER V7.1</strong><button type="button" data-vpss-close>×</button></div><div class="vpss-loading">Diagnostic complet D1 / Bright Data…</div></div>`;
    document.body.appendChild(modal);
    bindModalClose(modal);

    try {
      const data = await apiRequest('/v1/health-detail', {});
      const d = data.today || {};
      const remote = data.remote || {};
      const cooldown = Number(remote.cooldown_until || 0);

      let remoteLabel = '🟢 Disponible';
      if (!data.brightdata?.configured) remoteLabel = '🔴 Clé API absente';
      else if (remote.state === 'pending') remoteLabel = `🟡 ${Number(remote.pending_snapshots || 0)} collecte(s) en cours`;
      else if (cooldown > Date.now()) remoteLabel = `🟠 Pause jusqu’à ${formatDateTime(cooldown)}`;
      else if (remote.state === 'last_error') remoteLabel = '🟠 Dernière tentative en erreur';

      const last = remote.last_attempt;
      const monthUsed = Number(data.brightdata?.records_requested_month || 0);
      const freeLimit = Number(data.brightdata?.monthly_free_records || 5000);
      const remaining = Math.max(0, freeLimit - monthUsed);

      modal.querySelector('.vpss-dialog').innerHTML = `
        <div class="vpss-dialog-title"><strong>🛡 Santé SAFE SERVER V7.1</strong><button type="button" data-vpss-close>×</button></div>
        <div class="vpss-health-grid">
          <div><span>Worker</span><strong>✅ ${escapeHtml(data.worker || 'ok')} · v${escapeHtml(data.version || '?')}</strong></div>
          <div><span>D1</span><strong>${data.schema?.ok ? '✅' : '🔴'} ${escapeHtml(data.d1 || 'ok')}</strong></div>
          <div><span>Bright Data</span><strong>${remoteLabel}</strong></div>
          <div><span>Cache hit aujourd’hui</span><strong>${data.cache?.hit_rate_percent_today == null ? '—' : Number(data.cache.hit_rate_percent_today).toFixed(1) + '%'}</strong></div>
          <div><span>Produits avec prix</span><strong>${Number(data.cache?.products_with_price || 0).toLocaleString('fr-FR')}</strong></div>
          <div><span>ASIN connus</span><strong>${Number(data.cache?.known_products || 0).toLocaleString('fr-FR')}</strong></div>
          <div><span>Points historique</span><strong>${Number(data.cache?.history_points || 0).toLocaleString('fr-FR')}</strong></div>
          <div><span>Snapshots en cours</span><strong>${Number(remote.pending_snapshots || 0)}</strong></div>
          <div><span>Collectes aujourd’hui</span><strong>${Number(d.remote_fetches || 0)}</strong></div>
          <div><span>Succès Bright Data</span><strong>${Number(d.remote_ok || 0)}</strong></div>
          <div><span>N/D actifs</span><strong>${Number(data.current_states?.no_price || 0)}</strong></div>
          <div><span>Erreurs actives</span><strong>${Number(data.current_states?.errors || 0)}</strong></div>
          <div><span>N/D cumulés aujourd’hui</span><strong>${Number(d.remote_no_price || 0)}</strong></div>
          <div><span>Erreurs cumulées aujourd’hui</span><strong>${Number(d.remote_errors || 0)}</strong></div>
          <div><span>Quota mois (estimé)</span><strong>${monthUsed.toLocaleString('fr-FR')} / ${freeLimit.toLocaleString('fr-FR')}</strong></div>
        </div>

        <div class="vpss-meta-grid">
          <div><b>Schéma D1 :</b> ${escapeHtml(data.schema?.installed || '—')} / attendu ${escapeHtml(data.schema?.expected || '—')}</div>
          <div><b>Reste estimé :</b> ${remaining.toLocaleString('fr-FR')}</div>
          <div><b>Dataset :</b> ${escapeHtml(data.brightdata?.dataset_id || '—')}</div>
          <div><b>Mode :</b> ${escapeHtml(data.brightdata?.mode || '—')}</div>
          <div><b>Queue centrale :</b> ${Number(data.queue?.total || 0)} (${Number(data.queue?.queued || 0)} attente · ${Number(data.queue?.pending || 0)} snapshot · ${Number(data.queue?.error || 0)} erreur)</div>
          <div><b>Budget :</b> ${escapeHtml(data.budget?.mode || '—')} · ${Number(data.budget?.records_used_month || 0)} / ${Number(data.budget?.target || 4800)} cible</div>
          <div><b>Bright Data aujourd'hui :</b> ${Number(data.budget?.records_used_today || 0)} / ${Number(data.budget?.daily_cap || 165)} · reste ${Number(data.budget?.remaining_daily || 0)}</div>
          <div><b>Bright Data mois :</b> ${Number(data.budget?.records_used_month || 0)} / ${Number(data.budget?.hard_cap || 5000)} · reste ${Number(data.budget?.remaining_hard || 0)}</div>
          <div><b>Projection fin de mois :</b> ${Number(data.budget?.projected_month_end || 0)}</div>
          <div><b>Cache effectif :</b> ${Math.round(Number(data.budget?.effective_price_ttl_ms || data.policy?.effective_price_ttl_ms || data.policy?.price_ttl_ms || 0) / 3600000)} h</div>
          <div><b>Cron recommandé :</b> chaque minute (* * * * *)</div>
          <div><b>Cache positif de base :</b> ${Math.round(Number(data.policy?.price_ttl_ms || 0) / 3600000)} h</div>
          <div><b>Cache négatif :</b> ${Math.round(Number(data.policy?.negative_ttl_ms || 0) / 3600000)} h</div>
          <div><b>Retry erreurs :</b> 30 s → 2 min → 5 min → 15 min</div>
          <div><b>Appels API prix :</b> ${Number(d.api_price_calls || 0)}</div>
          <div><b>ASIN consultés :</b> ${Number(d.asin_lookups || 0)}</div>
          <div><b>Pushover :</b> ${data.integrations?.pushover ? '✅' : '—'}</div>
          <div><b>Discord :</b> ${data.integrations?.discord ? '✅' : '—'}</div>
          <div><b>Dernière source :</b> ${escapeHtml(data.diagnostic?.last_price_source || '—')}</div>
          <div><b>Dernier diagnostic :</b> ${escapeHtml(data.diagnostic?.last_no_price_reason || '—')}</div>
          <div><b>Format réponse :</b> ${escapeHtml(data.diagnostic?.last_brightdata_response_format || '—')}</div>
          <div><b>Content-Type :</b> ${escapeHtml(data.diagnostic?.last_brightdata_content_type || '—')}</div>
          <div><b>Dernière tentative :</b> ${last?.at ? escapeHtml(formatDateTime(last.at)) + ` · ${escapeHtml(last.status || '')}${last.http_status ? ` HTTP ${last.http_status}` : ''}` : '—'}</div>
        </div>

        ${data.diagnostic?.last_brightdata_response_preview
          ? `<div class="vpss-note-box"><b>Aperçu réponse diagnostic :</b><br>${escapeHtml(data.diagnostic.last_brightdata_response_preview)}</div>`
          : ''}

        <div class="vpss-inline-actions"><button type="button" data-health-refresh>↻ Actualiser</button></div>
        <div class="vpss-note-box">Ce panneau lit D1 uniquement. L’actualiser ne lance aucune nouvelle collecte Bright Data.</div>`;

      bindModalClose(modal);
      modal.querySelector('[data-health-refresh]')?.addEventListener('click', openServerHealth);
    } catch (error) {
      modal.querySelector('.vpss-dialog').innerHTML = `
        <div class="vpss-dialog-title"><strong>🛡 Santé serveur</strong><button type="button" data-vpss-close>×</button></div>
        <div class="vpss-error">${escapeHtml(String(error?.message || error))}</div>
        <div class="vpss-note-box">Le détail après “server_error” est maintenant affiché pour faciliter le diagnostic.</div>`;
      bindModalClose(modal);
    }
  }

  // ---------------------------------------------------------------------------
  // Zoom images V7.5
  // ---------------------------------------------------------------------------

  function amazonOriginalImageUrl(src) {
    const value = String(src || '').trim();
    if (!value) return '';

    try {
      const url = new URL(value, location.href);

      // Amazon sert souvent les vignettes sous:
      // XXXXX._AC_SX300_.jpg / ._SS400_.jpg / ._SL500_.jpg etc.
      // Supprimer ce suffixe redonne généralement l'image originale.
      if (
        /(?:media-amazon|images-amazon|ssl-images-amazon)\./i.test(url.hostname) ||
        /amazon\./i.test(url.hostname)
      ) {
        url.pathname = url.pathname.replace(
          /\._[^/]*_\.(jpg|jpeg|png|webp|gif)$/i,
          '.$1'
        );
      }

      return url.href;
    } catch {
      return value.replace(
        /\._[^/]*_\.(jpg|jpeg|png|webp|gif)(?:[?#].*)?$/i,
        '.$1'
      );
    }
  }

  function largestSrcsetUrl(img) {
    const srcset = String(img?.getAttribute('srcset') || '').trim();
    if (!srcset) return '';

    let best = '';
    let bestScore = -1;

    for (const entry of srcset.split(',')) {
      const part = entry.trim();
      if (!part) continue;

      const match = part.match(/^(\S+)(?:\s+([0-9.]+)(w|x))?$/i);
      if (!match) continue;

      const url = match[1];
      const value = Number(match[2] || 1);
      const unit = String(match[3] || 'x').toLowerCase();

      // Les descripteurs "w" sont directement comparables.
      // Pour "x", on donne un poids suffisamment haut au 2x/3x.
      const score = unit === 'w' ? value : value * 1000;

      if (score > bestScore) {
        bestScore = score;
        best = url;
      }
    }

    return best;
  }

  function bestZoomImageSource(img, tile) {
    const asin = getAsin(tile);
    const model = asin ? getModel(asin) : null;

    const candidates = [
      model?.meta?.image_url || '',
      largestSrcsetUrl(img),
      img?.currentSrc || '',
      img?.src || '',
    ]
      .map(amazonOriginalImageUrl)
      .filter(Boolean);

    return [...new Set(candidates)][0] || '';
  }

  function openImageZoom(src, alt, fallbackSrc = '') {
    closePopup('vpss-image-modal');

    const original = amazonOriginalImageUrl(src);
    const fallback = String(fallbackSrc || '').trim();

    const overlay = document.createElement('div');
    overlay.id = 'vpss-image-modal';
    overlay.className = 'vpss-modal-overlay vpss-image-overlay';

    overlay.innerHTML = `
      <button type="button" class="vpss-image-close" data-vpss-close aria-label="Fermer">×</button>
      <div class="vpss-image-stage">
        <img
          class="vpss-image-zoomed"
          src="${escapeAttr(original || fallback)}"
          alt="${escapeAttr(alt || '')}"
          draggable="false"
        >
      </div>
    `;

    document.body.appendChild(overlay);

    const zoomed = overlay.querySelector('.vpss-image-zoomed');

    if (zoomed && fallback && original && original !== fallback) {
      zoomed.addEventListener('error', () => {
        if (zoomed.dataset.vpssFallbackDone === '1') return;
        zoomed.dataset.vpssFallbackDone = '1';
        zoomed.src = fallback;
      });
    }

    bindModalClose(overlay);
  }

  // ---------------------------------------------------------------------------
  // Interface / paramètres
  // ---------------------------------------------------------------------------

  async function forceRetryAsins(asins, label = 'produit(s)') {
    const unique = [...new Set(asins)].filter(asin => /^[A-Z0-9]{10}$/.test(asin));
    if (!unique.length) return { retried: 0, skipped: 0 };

    updateFloatingUi(`↻ ${unique.length} RETRY…`);

    const data = await apiRequest('/v1/retry', { asins: unique });

    for (const asin of data.retried || []) {
      manualRetryPriority.add(asin);

      const current = getModel(asin) || {};
      const next = {
        ...current,
        state: 'missing',
        retry_after_ms: 0,
        fetch_attempt: null,
      };

      models.set(asin, next);
      cache[asin] = { item: next, saved_at: Date.now() };
    }

    saveCache();
    processTiles();

    urgentSyncRequested = true;
    if (!running) {
      urgentSyncRequested = false;
      schedule(100);
    }

    return {
      retried: (data.retried || []).length,
      skipped: (data.skipped_pending || []).length,
      label,
    };
  }

  async function retryOneAsin(asin) {
    try {
      await forceRetryAsins([asin], 'ce produit');
    } catch (error) {
      updateFloatingUi(`RETRY ERREUR · ${String(error?.message || error).slice(0, 22)}`);
    }
  }

  function openRetryMenu() {
    closePopup('vpss-retry-modal');

    const asins = visibleAsins();
    const byState = state => asins.filter(asin => getModel(asin)?.state === state);
    const errors = byState('error');
    const noPrice = byState('no_price');
    const allMissing = asins.filter(asin => {
      const model = getModel(asin);
      return !model?.price && model?.state !== 'pending';
    });

    const modal = document.createElement('div');
    modal.id = 'vpss-retry-modal';
    modal.className = 'vpss-modal-overlay';
    modal.innerHTML = `
      <div class="vpss-dialog">
        <div class="vpss-dialog-title">
          <strong>↻ Retenter les prix</strong>
          <button type="button" data-vpss-close>×</button>
        </div>

        <div class="vpss-note-box">
          Une relance forcée peut consommer un nouveau record Bright Data.
          Les snapshots déjà en cours ne sont jamais relancés.
        </div>

        <div class="vpss-retry-summary">
          <b>${errors.length}</b> erreur(s) ·
          <b>${noPrice.length}</b> N/D ·
          <b>${allMissing.length}</b> sans prix
        </div>

        <div class="vpss-inline-actions vpss-retry-actions">
          <button type="button" data-retry-errors ${errors.length ? '' : 'disabled'}>
            Retenter ERREUR (${errors.length})
          </button>
          <button type="button" data-retry-nd ${noPrice.length ? '' : 'disabled'}>
            Retenter N/D (${noPrice.length})
          </button>
          <button type="button" data-retry-all ${allMissing.length ? '' : 'disabled'}>
            Retenter tous sans prix (${allMissing.length})
          </button>
        </div>

        <div data-retry-result></div>
      </div>
    `;

    document.body.appendChild(modal);
    bindModalClose(modal);

    const result = modal.querySelector('[data-retry-result]');

    const run = async (targets, label) => {
      try {
        result.textContent = `↻ ${label}…`;
        const r = await forceRetryAsins(targets, label);
        result.textContent = `✓ ${r.retried} relancé(s)` +
          (r.skipped ? ` · ${r.skipped} snapshot(s) déjà en cours` : '');
        setTimeout(() => modal.remove(), 1200);
      } catch (error) {
        result.textContent = `Erreur : ${String(error?.message || error)}`;
      }
    };

    modal.querySelector('[data-retry-errors]')?.addEventListener('click', () => run(errors, 'erreurs'));
    modal.querySelector('[data-retry-nd]')?.addEventListener('click', () => run(noPrice, 'N/D'));
    modal.querySelector('[data-retry-all]')?.addEventListener('click', () => run(allMissing, 'sans prix'));
  }

  function createFloatingUi() {
    const root = document.createElement('div');
    root.id = 'vpss-ui';
    root.innerHTML = `
      <button type="button" id="vpss-status">SAFE V7.10</button>
      <button type="button" id="vpss-autoreload" title="Auto-Reload RFY">AUTO OFF</button>
      <select id="vpss-sort" title="Tri">
        <option value="score_desc">Score ↓</option>
        <option value="price_desc">Prix ↓</option>
        <option value="price_asc">Prix ↑</option>
        <option value="rating_desc">Note ↓</option>
        <option value="reviews_desc">Avis ↓</option>
        <option value="discount_desc">Remise ↓</option>
        <option value="rank_asc">Classement ↑</option>
        <option value="newest">Plus récents</option>
        <option value="oldest">Plus anciens</option>
        <option value="favorites">Favoris d'abord</option>
        <option value="default">Ordre Amazon</option>
      </select>
      <button type="button" id="vpss-dashboard" title="Tableau de bord RFY">📊</button>
      <button type="button" id="vpss-archive" title="Archive RFY">🗂</button>
      <button type="button" id="vpss-filters" title="Filtres">🔎</button>
      <button type="button" id="vpss-health" title="Santé du serveur">🛡</button>
      <button type="button" id="vpss-retry-global" title="Retenter N/D ou erreurs">↻</button>
      <button type="button" id="vpss-hidden-toggle" title="Afficher/masquer les produits cachés">👁</button>
      <button type="button" id="vpss-settings" title="Paramètres">⚙</button>
    `;
    document.body.appendChild(root);

    root.querySelector('#vpss-status').addEventListener('click', () => setPaused(!isPaused()));
    root.querySelector('#vpss-autoreload').addEventListener('click', toggleAutoReload);
    root.querySelector('#vpss-settings').addEventListener('click', openSettings);
    root.querySelector('#vpss-dashboard').addEventListener('click', openDashboard);
    root.querySelector('#vpss-archive').addEventListener('click', openArchive);
    root.querySelector('#vpss-filters').addEventListener('click', openFilters);
    root.querySelector('#vpss-health').addEventListener('click', openServerHealth);
    root.querySelector('#vpss-retry-global').addEventListener('click', openRetryMenu);
    root.querySelector('#vpss-hidden-toggle').addEventListener('click', () => {
      saveSettings({ ...settings, showHidden: !settings.showHidden });
    });
    root.querySelector('#vpss-sort').addEventListener('change', event => {
      saveSettings({ ...settings, sortMode: event.target.value });
    });

    updateFloatingUi();
    return root;
  }

  function updateFloatingUi(text) {
    if (!statusUi) return;
    const status = statusUi.querySelector('#vpss-status');
    const sort = statusUi.querySelector('#vpss-sort');
    const hidden = statusUi.querySelector('#vpss-hidden-toggle');

    updateAutoReloadButton();

    if (status) {
      if (text) status.textContent = text;
      else if (isPaused()) status.textContent = 'PAUSE';
      else if (!getServerUrl() || !getApiKey()) status.textContent = 'À CONFIGURER';
      else status.textContent = 'SAFE V7.10';
      status.classList.toggle('is-paused', isPaused());
    }
    if (sort) sort.value = settings.sortMode || 'price_desc';
    if (hidden) hidden.classList.toggle('is-active', Boolean(settings.showHidden));
  }

  function openSettings() {
    closePopup('vpss-settings-modal');
    const modal = document.createElement('div');
    modal.id = 'vpss-settings-modal';
    modal.className = 'vpss-modal-overlay';
    modal.innerHTML = `
      <div class="vpss-dialog vpss-settings-dialog">
        <div class="vpss-dialog-title">
          <strong>SAFE SERVER V7.10 · Paramètres</strong>
          <button type="button" data-vpss-close>×</button>
        </div>

        <details open>
          <summary>Serveur SAFE</summary>
          <label>URL du Worker Cloudflare</label>
          <input data-setting="serverUrl" type="url" placeholder="https://vine-prix-safe-server.xxxxx.workers.dev">
          <label>Clé API personnelle <small>(stockée dans l'espace Tampermonkey, pas dans Amazon)</small></label>
          <input data-setting="apiKey" type="password" placeholder="Votre API_KEY">
          <div class="vpss-inline-actions">
            <button type="button" data-test-server>Tester sans contacter Amazon</button>
            <span data-test-result></span>
          </div>
        </details>

        <details open>
          <summary>🔄 Auto-Reload RFY SAFE</summary>
          <label class="vpss-check">
            <input data-setting="autoReloadEnabled" type="checkbox">
            Activer l’Auto-Reload de « Recommandé pour vous »
          </label>

          <div class="vpss-form-grid">
            <label>Mode
              <select data-setting="autoReloadMode">
                <option value="safe">SAFE · 3–6 min par défaut</option>
                <option value="ultra">ULTRA SAFE · 5–10 min par défaut</option>
              </select>
            </label>
            <label>Limite / jour
              <input data-setting="autoReloadDailyCap" type="number" min="10" max="1000" step="10">
            </label>

            <label>SAFE minimum (min)
              <input data-setting="autoReloadSafeMinMinutes" type="number" min="1" max="60" step="0.5">
            </label>
            <label>SAFE maximum (min)
              <input data-setting="autoReloadSafeMaxMinutes" type="number" min="1" max="120" step="0.5">
            </label>

            <label>ULTRA minimum (min)
              <input data-setting="autoReloadUltraMinMinutes" type="number" min="1" max="120" step="0.5">
            </label>
            <label>ULTRA maximum (min)
              <input data-setting="autoReloadUltraMaxMinutes" type="number" min="1" max="180" step="0.5">
            </label>

            <label>Pause après activité utilisateur (min)
              <input data-setting="autoReloadActivityGraceMinutes" type="number" min="0" max="30" step="0.5">
            </label>
            <label>Décalage initial multi-appareils max. (min)
              <input data-setting="autoReloadInitialJitterMinutes" type="number" min="0" max="30" step="0.5">
            </label>
          </div>

          <div class="vpss-note-box">
            Le rechargement est aléatoire, uniquement sur RFY. Il est suspendu si l’onglet est caché,
            si une fenêtre est ouverte, pendant une synchro D1/Bright Data ou juste après ton activité.
            En cas de CAPTCHA / erreur Amazon détectée : backoff 5 → 10 → 20 → 60 min.
            Aucun clic « Voir les détails » et aucune commande n’est automatisé.
          </div>

          <div class="vpss-inline-actions">
            <button type="button" data-autoreload-now>Programmer un nouveau délai</button>
            <span data-autoreload-status></span>
          </div>
        </details>

        <details open>
          <summary>Prix, classement et historique</summary>
          <div class="vpss-form-grid">
            <label>● Mise en avant dès (€)<input data-setting="priceFocus" type="number" min="0" step="1"></label>
            <label>🔥 Prix chaud dès (€)<input data-setting="priceHot" type="number" min="0" step="1"></label>
            <label>⭐ Très cher dès (€)<input data-setting="priceStar" type="number" min="0" step="1"></label>
            <label>Tri
              <select data-setting="sortMode">
                <option value="score_desc">Score d’intérêt décroissant</option>
                <option value="price_desc">Prix décroissant</option>
                <option value="price_asc">Prix croissant</option>
                <option value="newest">Plus récents</option>
                <option value="oldest">Plus anciens</option>
                <option value="favorites">Favoris d'abord</option>
                <option value="default">Ordre Amazon</option>
              </select>
            </label>
          </div>
          <div class="vpss-note-box">L'historique est enregistré côté D1 seulement quand le prix change. La fiche produit affiche précédent / min 30 j / max 30 j et une courbe.</div>
        </details>

        <details open>
          <summary>🧠 Score d’intérêt personnalisable</summary>
          <label class="vpss-check"><input data-setting="scoreEnabled" type="checkbox"> Afficher le score /100</label>
          <div class="vpss-form-grid">
            <label>Prix de référence (€)<input data-setting="scorePriceReference" type="number" min="1" step="1"></label>
            <label>Mots d’intérêt<input data-setting="scoreKeywords" type="text" placeholder="SSD, Dyson, Makita"></label>
            <label>Poids prix<input data-setting="scoreWeightPrice" type="number" min="0" step="1"></label>
            <label>Poids nouveauté<input data-setting="scoreWeightFreshness" type="number" min="0" step="1"></label>
            <label>Poids remise/coupon<input data-setting="scoreWeightDiscount" type="number" min="0" step="1"></label>
            <label>Poids note<input data-setting="scoreWeightRating" type="number" min="0" step="1"></label>
            <label>Poids avis<input data-setting="scoreWeightReviews" type="number" min="0" step="1"></label>
            <label>Poids mots/marque/catégorie<input data-setting="scoreWeightKeywords" type="number" min="0" step="1"></label>
            <label>Poids classement<input data-setting="scoreWeightRank" type="number" min="0" step="1"></label>
            <label>Poids disponibilité<input data-setting="scoreWeightAvailability" type="number" min="0" step="1"></label>
            <label>Poids vendeur/FBA<input data-setting="scoreWeightSeller" type="number" min="0" step="1"></label>
            <label>Poids historique<input data-setting="scoreWeightHistory" type="number" min="0" step="1"></label>
            <label>Poids favori<input data-setting="scoreWeightFavorite" type="number" min="0" step="1"></label>
          </div>
          <div class="vpss-note-box">Les poids sont automatiquement normalisés pour produire un score final sur 100.</div>
        </details>

        <details open>
          <summary>Notifications nouveau RFY</summary>
          <label class="vpss-check"><input data-setting="notificationsEnabled" type="checkbox"> Activer les alertes intelligentes</label>
          <div class="vpss-form-grid">
            <label>Prix minimum (€)<input data-setting="notificationMinPrice" type="number" min="0" step="1"></label>
            <label>Score minimum /100<input data-setting="notificationMinScore" type="number" min="0" max="100" step="1"></label>
            <label>Âge maximum (minutes)<input data-setting="notificationMaxAgeMinutes" type="number" min="0" step="1"></label>
            <label>Mots-clés (optionnel)<input data-setting="notificationKeywords" type="text" placeholder="aspirateur, SSD, Bosch"></label>
            <label>Logique
              <select data-setting="notificationLogic"><option value="all">Toutes les règles actives (ET)</option><option value="any">Une règle suffit (OU)</option></select>
            </label>
            <label>🟠 Important dès (€)<input data-setting="notificationImportantPrice" type="number" min="0" step="1"></label>
            <label>🔴 Urgent dès (€)<input data-setting="notificationUrgentPrice" type="number" min="0" step="1"></label>
            <label>🔴 Urgent dès score<input data-setting="notificationUrgentScore" type="number" min="0" max="100" step="1"></label>
          </div>
          <div class="vpss-check-row">
            <label class="vpss-check"><input data-setting="notificationChangesEnabled" type="checkbox"> Alertes changements importants</label>
            <label class="vpss-check"><input data-setting="notificationAvailabilityReturn" type="checkbox"> Retour en stock</label>
            <label class="vpss-check"><input data-setting="notificationCouponAppears" type="checkbox"> Nouveau coupon</label>
          </div>
          <div class="vpss-form-grid"><label>Baisse de prix minimum (%)<input data-setting="notificationPriceDropPercent" type="number" min="1" max="90" step="1"></label></div>
          <label class="vpss-check"><input data-setting="notificationIgnoreHidden" type="checkbox"> Ne jamais notifier les produits cachés</label>
          <div class="vpss-check-row">
            <label class="vpss-check"><input data-setting="notifyBrowser" type="checkbox"> Notification appareil</label>
            <label class="vpss-check"><input data-setting="notifySound" type="checkbox"> Son</label>
            <label class="vpss-check"><input data-setting="notifyPushover" type="checkbox"> Pushover serveur</label>
            <label class="vpss-check"><input data-setting="notifyDiscord" type="checkbox"> Discord serveur</label>
          </div>

          <div class="vpss-form-grid">
            <label>Nom de ce téléphone
              <input data-setting="deviceName" type="text" maxlength="40" placeholder="Ex. Vine03">
            </label>
          </div>

          <label class="vpss-check">
            <input data-setting="notificationSecondDevice" type="checkbox">
            Autoriser une 2e alerte si un autre téléphone détecte le même nouveau RFY
          </label>

          <div class="vpss-inline-actions"><button type="button" data-test-sound>Tester le son</button></div>

          <div class="vpss-note-box">
            Pushover/Discord indiquent le téléphone qui a déclenché l'alerte.
            Pour un nouveau RFY : alerte 1 sur le premier téléphone, puis au maximum
            une alerte 2 si un autre téléphone distinct le détecte. Le même téléphone
            répété et les 3e/4e/etc. téléphones sont ignorés pendant 24 h.
          </div>
        </details>

        <details open>
          <summary>🟨 Nouveaux produits RFY</summary>

          <label class="vpss-check">
            <input data-setting="highlightNewProducts" type="checkbox">
            Entourer/surligner les nouveaux produits en jaune
          </label>

          <div class="vpss-form-grid">
            <label>Durée du surlignage (minutes)
              <input data-setting="highlightNewMinutes" type="number" min="1" max="120" step="1">
            </label>
          </div>

          <div class="vpss-note-box">
            Le surlignage utilise d'abord la détection locale immédiate, puis la première
            apparition enregistrée dans D1. Avec plusieurs téléphones, un nouveau produit
            peut donc rester identifiable sur tes autres appareils pendant la durée choisie.
          </div>
        </details>

        <details open>
          <summary>🎛 Variantes et fiche produit Vine</summary>

          <label class="vpss-check">
            <input data-setting="autoVariantEnabled" type="checkbox">
            Sélection automatique des variantes
          </label>

          <div class="vpss-form-grid">
            <label>Mode de sélection
              <select data-setting="autoVariantMode">
                <option value="first_available">Première variante disponible</option>
                <option value="single_only">Seulement s'il n'existe qu'un seul choix</option>
              </select>
            </label>
          </div>

          <label class="vpss-check">
            <input data-setting="hideToolbarInProductModal" type="checkbox">
            Masquer automatiquement la barre SAFE quand la fiche Vine est ouverte
          </label>

          <div class="vpss-note-box">
            La sélection automatique agit uniquement sur les menus de variantes.
            Elle ne clique jamais sur « Demander un produit », ne sélectionne pas
            d'adresse et ne valide aucune commande. Le mode « première variante »
            choisit le premier choix disponible dans chaque menu ; le mode
            « un seul choix » est plus conservateur.
          </div>
        </details>

        <details open>
          <summary>⚠ Alertes checkout Vine</summary>
          <label class="vpss-check"><input data-setting="checkoutAlertsEnabled" type="checkbox"> Activer les alertes locales au checkout</label>
          <div class="vpss-note-box">Détecte un risque de frais de douane et, lorsqu’on arrive depuis Vine, un reste à payer ou l’utilisation d’une carte cadeau. Lecture du DOM uniquement : aucun clic, aucune validation et aucun appel au Worker.</div>
        </details>

        <details open>
          <summary>Interface façon PickMe</summary>
          <div class="vpss-check-row">
            <label class="vpss-check"><input data-setting="compactMode" type="checkbox"> Affichage compact</label>
            <label class="vpss-check"><input data-setting="columnsEnabled" type="checkbox"> Colonnes fixes</label>
            <label class="vpss-check"><input data-setting="fullTitles" type="checkbox"> Titres complets</label>
            <label class="vpss-check"><input data-setting="zoomImages" type="checkbox"> Zoom image au clic</label>
            <label class="vpss-check"><input data-setting="colorblind" type="checkbox"> Mode daltonien</label>
            <label class="vpss-check"><input data-setting="showHidden" type="checkbox"> Afficher les cachés</label>
            <label class="vpss-check"><input data-setting="showMetaBadges" type="checkbox"> Badges Bright Data</label>
          </div>
          <div class="vpss-form-grid">
            <label>Nombre de colonnes<input data-setting="columns" type="number" min="1" max="8" step="1"></label>
            <label>Mots à surligner<input data-setting="highlightWords" type="text" placeholder="lego, ordinateur, makita"></label>
          </div>
          <div class="vpss-note-box">Favoris, produits cachés et bloc-notes sont synchronisés via ton serveur D1.</div>
        </details>

        <div class="vpss-settings-actions">
          <button type="button" data-save-settings>Enregistrer</button>
          <button type="button" data-toggle-pause>${isPaused() ? 'Reprendre' : 'Mettre en pause'}</button>
          <button type="button" data-clear-cache>Vider cache local</button>
          <button type="button" data-reset-baseline>Réinitialiser détection « nouveau »</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    bindModalClose(modal);

    const byKey = key => modal.querySelector(`[data-setting="${key}"]`);
    byKey('serverUrl').value = getServerUrl();
    byKey('apiKey').value = getApiKey();

    for (const [key, value] of Object.entries(settings)) {
      const input = byKey(key);
      if (!input) continue;
      if (input.type === 'checkbox') input.checked = Boolean(value);
      else input.value = String(value ?? '');
    }

    modal.querySelector('[data-test-server]').addEventListener('click', async () => {
      const result = modal.querySelector('[data-test-result]');
      const tempUrl = byKey('serverUrl').value.trim().replace(/\/+$/, '');
      const tempKey = byKey('apiKey').value.trim();
      GM_setValue(KEYS.serverUrl, tempUrl);
      GM_setValue(KEYS.apiKey, tempKey);
      result.textContent = 'Test…';
      try {
        await testServer();
        result.textContent = `✅ Serveur + D1 OK · transport ${lastApiTransport}, sans accès Amazon.`;
      } catch (error) {
        const network = isTransientNetworkError(error);
        result.textContent = network
          ? '❌ ' + String(error?.message || error) + ' · Vérifie VPN/SIM/DNS puis ouvre /health sur ce téléphone.'
          : '❌ ' + String(error?.message || error);
      }
    });

    modal.querySelector('[data-test-sound]').addEventListener('click', playNotificationSound);

    const autoStatus = modal.querySelector('[data-autoreload-status]');
    if (autoStatus) {
      autoStatus.textContent =
        `${autoReloadCountdownText()} · ${Number(autoReloadState.countToday || 0)}/${autoReloadDailyCap()} aujourd’hui`;
    }

    modal.querySelector('[data-autoreload-now]')?.addEventListener('click', () => {
      if (!settings.autoReloadEnabled) {
        if (autoStatus) autoStatus.textContent = 'Active d’abord l’Auto-Reload puis enregistre.';
        return;
      }

      scheduleNextAutoReload({ initial: false });
      if (autoStatus) autoStatus.textContent = `✓ Nouveau délai : ${autoReloadCountdownText()}`;
    });

    modal.querySelector('[data-save-settings]').addEventListener('click', () => {
      const next = { ...settings };
      for (const key of Object.keys(DEFAULTS)) {
        const input = byKey(key);
        if (!input) continue;
        if (input.type === 'checkbox') next[key] = input.checked;
        else if (input.type === 'number') next[key] = Number(input.value || 0);
        else next[key] = input.value;
      }
      GM_setValue(KEYS.serverUrl, byKey('serverUrl').value.trim().replace(/\/+$/, ''));
      GM_setValue(KEYS.apiKey, byKey('apiKey').value.trim());
      saveSettings(next);
      modal.remove();
      schedule(200);
    });

    modal.querySelector('[data-toggle-pause]').addEventListener('click', () => {
      setPaused(!isPaused());
      modal.remove();
    });

    modal.querySelector('[data-clear-cache]').addEventListener('click', () => {
      cache = {};
      models.clear();
      GM_deleteValue(KEYS.cache);
      document.querySelectorAll('.vpss-price-badge,.vpss-age-badge').forEach(el => el.remove());
      modal.querySelector('[data-clear-cache]').textContent = '✓ Cache local vidé';
      schedule(200);
    });

    modal.querySelector('[data-reset-baseline]').addEventListener('click', () => {
      knownAsins = {};
      pendingNew = {};
      GM_deleteValue(KEYS.knownAsins);
      GM_deleteValue(KEYS.pendingNew);
      GM_setValue(KEYS.baselineDone, false);
      baselineMode = true;
      clearTimeout(baselineTimer);
      baselineTimer = setTimeout(() => {
        baselineMode = false;
        GM_setValue(KEYS.baselineDone, true);
      }, BASELINE_GRACE_MS);
      modal.querySelector('[data-reset-baseline]').textContent = '✓ Baseline en cours (8 s)';
    });
  }

  function applyInterfaceSettings() {
    document.documentElement.classList.toggle('vpss-compact', Boolean(settings.compactMode));
    document.documentElement.classList.toggle('vpss-full-titles', Boolean(settings.fullTitles));
    document.documentElement.classList.toggle('vpss-colorblind', Boolean(settings.colorblind));
    document.documentElement.classList.toggle('vpss-columns-enabled', Boolean(settings.columnsEnabled));
    document.documentElement.style.setProperty('--vpss-columns', String(Math.max(1, Math.min(8, Number(settings.columns || 3)))));
  }


  // ---------------------------------------------------------------------------
  // Alertes checkout Vine — lecture DOM uniquement, zéro requête réseau
  // ---------------------------------------------------------------------------

  function initCheckoutAlerts() {
    const checkoutSettings = loadSettings();
    if (!checkoutSettings.checkoutAlertsEnabled) return;

    const fromVine = /\/vine\/vine-items/i.test(document.referrer || '');
    const normalize = text => String(text || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[’'"`]/g, ' ')
      .replace(/[^a-z0-9€.,-]+/g, ' ')
      .replace(/\s+/g, ' ').trim();

    const customsMarkers = [
      'frais d importation', 'droits d importation', 'dedouaner',
      'expedition a l international', 'vendu et expedie depuis l etranger',
      'expedie depuis l etranger'
    ];

    const parseAmount = text => {
      let s = String(text || '').replace(/\u00a0/g, '').replace(/\s/g, '').replace(/€/g, '');
      if (!s) return null;
      if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
      s = s.replace(/[^0-9.-]/g, '');
      const n = Number.parseFloat(s);
      return Number.isFinite(n) ? n : null;
    };

    const moneyText = value => Number(value).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

    function ensureCheckoutStyle() {
      if (document.getElementById('vpss-checkout-style')) return;
      const style = document.createElement('style');
      style.id = 'vpss-checkout-style';
      style.textContent = `
        .vpss-checkout-alert{margin:12px 10px;padding:12px 14px;border-radius:12px;display:flex;gap:10px;align-items:flex-start;font:14px/1.45 Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.12);color:#111}
        .vpss-checkout-alert strong{display:block;font-size:16px;margin-bottom:3px}.vpss-checkout-alert .vpss-ca-icon{font-size:24px}
        #vpss-customs-alert{background:#fff4d6;border:2px solid #d98b00}#vpss-balance-alert{background:#ffe8e6;border:2px solid #c5221f}
        #vpss-giftcard-alert{background:#fff0dc;border:2px solid #c66b00}
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    function banner(id, title, message, kind = 'balance') {
      ensureCheckoutStyle();
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement('div');
        el.id = id;
        el.className = 'vpss-checkout-alert';
        (document.querySelector('#a-page') || document.body || document.documentElement).prepend(el);
      }
      el.innerHTML = `<span class="vpss-ca-icon">⚠️</span><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div>`;
    }

    function findSummaryAmountByType(type) {
      const input = document.querySelector(`input[name="subtotalLineType"][value="${type}"]`);
      const grid = input?.closest('.order-summary-grid');
      const node = grid?.querySelector('.order-summary-line-definition');
      if (!node) return null;
      return { text: node.textContent?.trim() || '', value: parseAmount(node.textContent) };
    }

    function findFinalTotal() {
      const direct = document.querySelector('li.grand-total-cell .order-summary-line-definition');
      if (direct) return { text: direct.textContent?.trim() || '', value: parseAmount(direct.textContent) };
      for (const term of document.querySelectorAll('.order-summary-line-term, .order-summary-line-term .break-word')) {
        if (!/montant\s+total|total\s+de\s+la\s+commande/i.test(term.textContent || '')) continue;
        const grid = term.closest('.order-summary-grid');
        const value = grid?.querySelector('.order-summary-line-definition');
        if (value) return { text: value.textContent?.trim() || '', value: parseAmount(value.textContent) };
      }
      return null;
    }

    function scan() {
      const bodyText = normalize(document.body?.textContent || '');
      if (customsMarkers.some(marker => bodyText.includes(marker))) {
        banner('vpss-customs-alert', 'Attention : frais de douane possibles', 'Le checkout contient une mention d’expédition internationale, de dédouanement ou de frais d’importation. Vérifie les détails avant de valider.');
      }

      // On ne déclenche l'alerte de paiement que si le checkout vient de Vine.
      if (!fromVine) return;
      const total = findFinalTotal();
      if (!total || total.value == null) return;

      if (total.value > 0.009) {
        banner('vpss-balance-alert', 'Attention : reste à payer', `Cette commande Vine affiche un montant final de ${moneyText(total.value)}. Vérifie avant toute validation.`);
        return;
      }

      const before = findSummaryAmountByType('TOTAL_BEFORE_SPECIAL_PAYMENTS_TAX_INCLUSIVE');
      const gift = findSummaryAmountByType('SPECIAL_PAYMENTS_GIFT_CARD_BALANCE');
      if (before?.value > 0.009 && gift?.value < -0.009) {
        banner('vpss-giftcard-alert', 'Attention : carte cadeau utilisée', `Le coût avant moyens de paiement est ${moneyText(before.value)} et une carte cadeau semble couvrir tout ou partie du montant. Vérifie si tu veux vraiment l’utiliser.`);
      }
    }

    const start = () => {
      scan();
      const root = document.body || document.documentElement;
      if (!root) return;
      let timer = null;
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(scan, 150);
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      setTimeout(() => observer.disconnect(), 45000);
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }

  // ---------------------------------------------------------------------------
  // Événements DOM
  // ---------------------------------------------------------------------------

  function installDelegatedHandlers() {
    document.addEventListener('click', event => {
      const action = event.target.closest('[data-vpss-action]');
      if (action) {
        const asin = action.dataset.asin;
        const type = action.dataset.vpssAction;
        if (!asin) return;
        event.preventDefault();
        event.stopPropagation();

        if (type === 'info') {
          openProductPopup(asin);
          return;
        }

        if (type === 'retry') {
          retryOneAsin(asin);
          return;
        }

        const state = getStateForAsin(asin);
        if (type === 'favorite') state.favorite = !state.favorite;
        if (type === 'hidden') state.hidden = !state.hidden;
        updateLocalState(asin, state);
        queueStateUpdate(asin, state);
        applySort();
        return;
      }

      if (settings.zoomImages) {
        const img = event.target.closest('.vvp-item-tile-content img');
        const tile = img?.closest('.vvp-item-tile');

        if (img && tile) {
          event.preventDefault();
          event.stopPropagation();

          const fallback = img.currentSrc || img.src || '';
          const source = bestZoomImageSource(img, tile) || fallback;

          openImageZoom(source, img.alt, fallback);
        }
      }
    }, true);
  }

  function installMutationObserver() {
    const observer = new MutationObserver(() => {
      // Toujours traiter l'état de la fiche produit, même pendant un tri.
      handleVineProductModalState();

      if (sortGuard) return;
      clearTimeout(observerTimer);

      observerTimer = setTimeout(() => {
        handleVineProductModalState();
        processTiles();

        // IMPORTANT DATA SAVER:
        // Une mutation du DOM peut être provoquée par Amazon OU par notre propre
        // interface (prix, score, badge, surlignage, etc.). Avant V7.6, toute
        // mutation sans nouveau produit reprogrammait quand même sync() à 300 ms,
        // ce qui cassait le délai normal CACHE OK = 5 minutes.
        //
        // Désormais, on ne déclenche une synchro réseau urgente QUE s'il existe
        // réellement un ASIN visible encore inconnu/non récupéré.
        const hasNewUncached = visibleAsins().some(asin => {
          const item = getModel(asin);
          return !item || (!item.price && item.state === 'missing');
        });

        if (hasNewUncached) {
          urgentSyncRequested = true;

          if (!running) {
            urgentSyncRequested = false;
            schedule(100);
          }
        }

        // Sinon: aucune requête réseau.
        // Le timer déjà prévu par la boucle principale reste intact:
        // - CACHE OK: 5 minutes
        // - snapshot: 3 secondes
        // - erreur: backoff prévu
        // - nouveau produit: synchro urgente ci-dessus
      }, 180);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    handleVineProductModalState();
  }

  function installMinuteTicker() {
    setInterval(() => {
      const now = Date.now();
      for (const tile of getTiles()) {
        const asin = getAsin(tile);
        const model = asin ? getModel(asin) : null;
        const wrapper = ensureImageWrapper(tile);
        if (wrapper && model) renderAgeBadge(wrapper, model, now);
      }
    }, 60000);
  }

  function installMenus() {
    try {
      GM_registerMenuCommand('⚙ SAFE V7.10 — Paramètres', openSettings);
      GM_registerMenuCommand('🔄 SAFE V7.10 — Auto-Reload ON/OFF', toggleAutoReload);
      GM_registerMenuCommand('📊 SAFE V7.10 — Dashboard RFY', openDashboard);
      GM_registerMenuCommand('🛡 SAFE V7 — Santé serveur', openServerHealth);
      GM_registerMenuCommand('🗂 SAFE V7 — Archive RFY', openArchive);
      GM_registerMenuCommand('🔎 SAFE V7 — Filtres', openFilters);
      GM_registerMenuCommand('⏯ SAFE V7 — Pause/Reprendre', () => setPaused(!isPaused()));
      GM_registerMenuCommand('↻ SAFE V7 — Retenter N/D / erreurs', openRetryMenu);
      GM_registerMenuCommand('🧹 SAFE V7 — Vider cache local', () => {
        cache = {};
        models.clear();
        GM_deleteValue(KEYS.cache);
        schedule(100);
      });
    } catch {}
  }

  // ---------------------------------------------------------------------------
  // Utilitaires UI
  // ---------------------------------------------------------------------------

  function bindModalClose(modal) {
    modal.querySelectorAll('[data-vpss-close]').forEach(button => {
      button.addEventListener('click', () => modal.remove());
    });
    modal.addEventListener('click', event => {
      if (event.target === modal) modal.remove();
    });
  }

  function closePopup(id) {
    document.getElementById(id)?.remove();
  }

  function parseWordList(value) {
    return String(value || '')
      .split(/[,;\n]/)
      .map(x => x.trim())
      .filter(Boolean);
  }

  function formatEuros(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'N/C';
    return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  }

  function formatAge(ms) {
    const totalMinutes = Math.max(0, Math.floor(Number(ms || 0) / 60000));
    if (totalMinutes < 1) return '<1 min';
    if (totalMinutes < 60) return `${totalMinutes} min`;
    const totalHours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (totalHours < 24) return `${totalHours}h ${String(minutes).padStart(2, '0')}m`;
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return `${days}j ${hours}h`;
  }

  function formatDuration(ms) {
    const minutes = Math.max(1, Math.ceil(Number(ms || 0) / 60000));
    if (minutes < 60) return `${minutes} min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h} h ${m}` : `${h} h`;
  }

  function formatDateTime(timestamp) {
    const n = Number(timestamp);
    if (!n) return '—';
    try {
      return new Date(n).toLocaleString('fr-FR', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return '—';
    }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#096;');
  }

  // ---------------------------------------------------------------------------
  // CSS
  // ---------------------------------------------------------------------------

  function injectStyles() {
    const style = document.createElement('style');
    style.id = 'vpss-v5-style';
    style.textContent = `
      :root { --vpss-columns: 3; }

      .vpss-price-row {
        display: flex !important;
        justify-content: center !important;
        align-items: center !important;
        min-height: 23px !important;
        margin: 2px 0 1px !important;
        clear: both !important;
      }

      .vpss-price-badge {
        position: static !important;
        transform: none !important;
        max-width: calc(100% - 8px) !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        border: 1px solid rgba(0,0,0,.20) !important;
        border-radius: 6px !important;
        padding: 2px 6px !important;
        background: rgba(255,255,255,.97) !important;
        color: #111 !important;
        font: 700 11px/1.2 Arial,sans-serif !important;
        white-space: nowrap !important;
        cursor: pointer !important;
        box-shadow: 0 1px 3px rgba(0,0,0,.12) !important;
      }
      .vpss-price-badge.vpss-price-pending {
        opacity: .82 !important;
        font-weight: 600 !important;
        border-style: dashed !important;
      }
      .vpss-price-badge[data-tier="focus"] { border-width: 2px !important; }
      .vpss-price-badge[data-tier="hot"] { font-size: 12px !important; }
      .vpss-price-badge[data-tier="star"] { font-size: 12px !important; border-width: 2px !important; }
      .vpss-price-retry {
        min-width: 24px !important;
        height: 22px !important;
        margin-left: 3px !important;
        padding: 0 5px !important;
        border: 1px solid rgba(0,0,0,.25) !important;
        border-radius: 6px !important;
        background: #fff !important;
        color: #111 !important;
        font: 800 14px/1 Arial,sans-serif !important;
        cursor: pointer !important;
      }
      .vpss-price-retry:hover { transform: rotate(-20deg); }
      .vpss-meta-badges {
        margin: 1px 3px 2px !important;
        min-height: 16px !important;
        text-align: center !important;
        font: 600 9px/1.25 Arial,sans-serif !important;
        color: #444 !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
      }
      .vpss-archive-card {
        display:grid !important; grid-template-columns:64px 1fr !important; gap:9px !important;
        padding:8px !important; border-bottom:1px solid #ddd !important; font:12px/1.35 Arial,sans-serif !important;
      }
      .vpss-archive-card img { width:60px !important; height:60px !important; object-fit:contain !important; background:#fff !important; }
      .vpss-dialog-wide { width:min(760px,94vw) !important; max-height:88vh !important; }
      #vpss-filters.is-active { border-color:#007185 !important; font-weight:800 !important; }

      .vpss-retry-summary { margin: 10px 0 !important; font: 13px/1.4 Arial,sans-serif !important; }
      .vpss-retry-actions { display:flex !important; flex-wrap:wrap !important; gap:6px !important; }
      .vpss-retry-actions button { flex:1 1 140px !important; }
      #vpss-autoreload.is-active { background:#e8f7e8 !important; border-color:#65a765 !important; font-weight:800 !important; }
      #vpss-autoreload.is-paused { background:#fff3d6 !important; border-color:#d29c35 !important; }

      .vpss-age-badge {
        position: absolute !important;
        top: 2px !important;
        left: 2px !important;
        right: auto !important;
        transform: none !important;
        max-width: 44% !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        z-index: 58 !important;
        background: rgba(255,255,255,.90) !important;
        color: #111 !important;
        border-radius: 5px !important;
        padding: 1px 4px !important;
        font: 600 9px/1.2 Arial,sans-serif !important;
        white-space: nowrap !important;
        pointer-events: none !important;
      }
      .vpss-age-badge.is-new { font-weight: 800 !important; }

      .vpss-score-badge {
        position:absolute !important; right:2px !important; top:2px !important; z-index:61 !important;
        min-width:58px !important; max-width:48% !important;
        border:1px solid rgba(0,0,0,.35) !important; border-radius:6px !important; padding:2px 5px !important;
        background:#fff !important; color:#111 !important; font:800 10px/1.2 Arial,sans-serif !important; cursor:pointer !important;
        white-space:nowrap !important; overflow:visible !important; text-overflow:clip !important;
        box-shadow:0 1px 2px rgba(0,0,0,.12) !important;
      }
      .vpss-score-badge[data-level="medium"] { border-width:2px !important; }
      .vpss-score-badge[data-level="high"] { border-width:2px !important; font-size:11px !important; }

      .vpss-actions {
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 5px !important;
        margin: 4px 0 3px !important;
        min-height: 25px !important;
      }
      .vpss-actions button {
        min-width: 28px !important;
        height: 24px !important;
        border: 1px solid #aaa !important;
        border-radius: 6px !important;
        background: #fff !important;
        color: #222 !important;
        cursor: pointer !important;
        padding: 0 5px !important;
        font-size: 15px !important;
        line-height: 1 !important;
      }
      .vpss-actions button.is-active { font-weight: 800 !important; }
      .vpss-note-dot { display: none; font-size: 13px; }

      .vpss-favorite { outline: 2px solid rgba(210,0,45,.45) !important; outline-offset: -2px !important; }

      /* V7.4 : style inspiré de PickMe pour un RFY nouvellement apparu. */
      .vvp-item-tile.vpss-new-product {
        background: #fff59d !important;
        box-shadow:
          inset 0 0 0 3px #e2c800,
          0 0 0 1px rgba(0,0,0,.08) !important;
        border-radius: 6px !important;
      }
      .vvp-item-tile.vpss-new-product .vvp-item-tile-content {
        background: #fff59d !important;
      }
      .vvp-item-tile.vpss-new-product .vpss-age-badge.is-new {
        background: #ffe65a !important;
        border: 1px solid #d3b700 !important;
      }

      .vpss-keyword-match { box-shadow: inset 0 0 0 3px rgba(255,191,0,.50) !important; }
      .vpss-hidden-product.vpss-show-hidden { opacity: .38 !important; filter: grayscale(.55); }

      html.vpss-full-titles .vvp-item-tile .a-truncate {
        max-height: none !important;
        height: auto !important;
        overflow: visible !important;
        white-space: normal !important;
      }
      html.vpss-full-titles .vvp-item-product-title-container {
        height: auto !important;
        min-height: 0 !important;
      }

      html.vpss-compact .vvp-item-tile { padding: 4px !important; }
      html.vpss-compact .vvp-item-tile-content { padding: 3px !important; }
      html.vpss-compact .vpss-price-row { min-height: 20px !important; margin: 1px 0 !important; }
      html.vpss-compact .vpss-actions { margin: 1px 0 !important; gap: 2px !important; }
      html.vpss-compact .vpss-actions button { height: 21px !important; min-width: 24px !important; font-size: 13px !important; }

      html.vpss-columns-enabled #vvp-items-grid {
        display: grid !important;
        grid-template-columns: repeat(var(--vpss-columns), minmax(0, 1fr)) !important;
        gap: 8px !important;
      }
      html.vpss-columns-enabled #vvp-items-grid > .vvp-item-tile {
        width: auto !important;
        max-width: none !important;
        min-width: 0 !important;
      }

      html.vpss-colorblind .vpss-favorite { outline: 3px dashed #111 !important; }
      html.vpss-colorblind .vpss-new-product {
        background: #fff !important;
        box-shadow: inset 0 0 0 4px #111 !important;
      }
      html.vpss-colorblind .vpss-new-product .vvp-item-tile-content {
        background: #fff !important;
      }
      html.vpss-colorblind .vpss-keyword-match { box-shadow: inset 0 0 0 4px #111 !important; }
      html.vpss-colorblind .vpss-price-badge[data-tier="focus"] { border: 2px dashed #111 !important; }
      html.vpss-colorblind .vpss-price-badge[data-tier="hot"] { border: 3px double #111 !important; }
      html.vpss-colorblind .vpss-price-badge[data-tier="star"] { border: 3px solid #111 !important; }

      #vpss-ui {
        position: fixed;
        right: 9px;
        bottom: 9px;
        z-index: 2147483600;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        flex-wrap: wrap;
        max-width: calc(100vw - 8px);
        gap: 4px;
        padding: 4px;
        background: rgba(255,255,255,.94);
        border: 1px solid #aaa;
        border-radius: 10px;
        box-shadow: 0 3px 12px rgba(0,0,0,.22);
        font: 12px Arial,sans-serif;
      }
      #vpss-ui button, #vpss-ui select {
        border: 1px solid #999;
        background: #fff;
        color: #111;
        border-radius: 7px;
        min-height: 28px;
        padding: 4px 7px;
        font: 600 11px Arial,sans-serif;
      }
      #vpss-status { min-width: 86px; }
      #vpss-status.is-paused { opacity: .55; }
      #vpss-hidden-toggle.is-active { font-weight: 900; outline: 2px solid #111; }

      /* V7.3 : ne jamais masquer le bouton Amazon « Demander un produit ». */
      html.vpss-vine-product-modal-open #vpss-ui {
        display: none !important;
      }

      .vpss-modal-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        background: rgba(0,0,0,.62);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 15px;
        overflow: auto;
      }
      .vpss-dialog {
        width: min(760px, 96vw);
        max-height: 92vh;
        overflow: auto;
        background: #fff;
        color: #111;
        border-radius: 13px;
        padding: 16px;
        box-shadow: 0 15px 45px rgba(0,0,0,.4);
        font: 14px/1.45 Arial,sans-serif;
      }
      .vpss-dialog-title {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        font-size: 18px;
        margin-bottom: 12px;
      }
      .vpss-dialog-title button {
        border: 0;
        background: transparent;
        font-size: 26px;
        cursor: pointer;
      }
      .vpss-dialog details { border-top: 1px solid #ddd; padding: 9px 0; }
      .vpss-dialog summary { font-weight: 800; cursor: pointer; margin-bottom: 8px; }
      .vpss-dialog label:not(.vpss-check) { display: block; font-weight: 700; margin: 7px 0; }
      .vpss-dialog input[type="text"], .vpss-dialog input[type="url"], .vpss-dialog input[type="password"],
      .vpss-dialog input[type="number"], .vpss-dialog select, .vpss-dialog textarea {
        width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #aaa; border-radius: 7px; background: #fff; color: #111;
      }
      .vpss-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 8px 12px; }
      .vpss-check-row { display: flex; flex-wrap: wrap; gap: 8px 14px; margin: 7px 0; }
      .vpss-check { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
      .vpss-inline-actions, .vpss-settings-actions, .vpss-popup-actions, .vpss-state-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
      .vpss-dialog button, .vpss-state-row a {
        border: 1px solid #999; border-radius: 7px; background: #f7f7f7; color: #111; padding: 7px 10px; cursor: pointer; text-decoration: none;
      }
      .vpss-note-box { margin: 8px 0; padding: 8px; background: #f3f6f8; border-radius: 7px; font-size: 12px; }
      .vpss-error { background: #ffeaea; border: 1px solid #c33; border-radius: 7px; padding: 8px; margin-bottom: 9px; }

      .vpss-product-dialog { width: min(820px, 97vw); }
      .vpss-product-head { display: grid; grid-template-columns: 155px 1fr; gap: 15px; align-items: start; }
      .vpss-product-image { width: 150px; height: 150px; object-fit: contain; border: 1px solid #ddd; border-radius: 8px; }
      .vpss-product-title { font-weight: 800; font-size: 16px; }
      .vpss-product-asin { font-family: monospace; font-size: 12px; opacity: .72; margin-top: 4px; }
      .vpss-product-price { font-size: 25px; font-weight: 900; margin-top: 8px; }
      .vpss-price-delta, .vpss-discount { margin-top: 3px; font-weight: 700; }
      .vpss-stats-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 8px; margin-top: 14px; }
      .vpss-stats-grid > div { background: #f5f5f5; border-radius: 8px; padding: 8px; }
      .vpss-stats-grid span { display: block; font-size: 11px; opacity: .72; }
      .vpss-stats-grid strong { display: block; margin-top: 3px; }
      .vpss-meta-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 5px 14px; margin: 13px 0; }
      .vpss-section-title { font-weight: 800; margin: 10px 0 5px; }
      .vpss-sparkline { width: 100%; height: 100px; color: currentColor; background: #fafafa; border: 1px solid #ddd; border-radius: 7px; }
      .vpss-history-table { width: 100%; border-collapse: collapse; margin-top: 7px; font-size: 12px; }
      .vpss-history-table th, .vpss-history-table td { padding: 5px 7px; border-bottom: 1px solid #ddd; text-align: left; }
      .vpss-note-label { margin-top: 12px !important; }
      [data-popup-note] { min-height: 90px; resize: vertical; }
      .vpss-empty { padding: 9px; background: #f7f7f7; border-radius: 7px; }
      .vpss-dashboard-dialog { width:min(900px,97vw); }
      .vpss-dashboard-cards,.vpss-health-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; margin:10px 0 14px; }
      .vpss-dashboard-tabs { display:flex !important; gap:6px !important; margin:8px 0 10px !important; }
      .vpss-dashboard-tabs button {
        flex:1 1 0 !important;
        min-height:34px !important;
        border:1px solid #bbb !important;
        border-radius:8px !important;
        background:#f5f5f5 !important;
        font-weight:700 !important;
        cursor:pointer !important;
      }
      .vpss-dashboard-tabs button.is-active {
        background:#111 !important;
        color:#fff !important;
        border-color:#111 !important;
      }
      .vpss-dashboard-cards>div,.vpss-health-grid>div { background:#f5f5f5;border-radius:9px;padding:9px;min-width:0; }
      .vpss-dashboard-cards span,.vpss-health-grid span { display:block;font-size:11px;opacity:.72; }
      .vpss-dashboard-cards strong,.vpss-health-grid strong { display:block;margin-top:3px;font-size:16px;overflow-wrap:anywhere; }
      .vpss-day-chart { display:grid;gap:5px;margin:8px 0 14px; }
      .vpss-day-row { display:grid;grid-template-columns:44px 1fr 38px 34px;gap:6px;align-items:center;font-size:11px; }
      .vpss-day-row em { font-style:normal;opacity:.75; }
      .vpss-day-bar { height:9px;background:#eee;border-radius:999px;overflow:hidden; }
      .vpss-day-bar i { display:block;height:100%;background:currentColor;opacity:.45;border-radius:999px; }
      .vpss-table-scroll { overflow-x:auto; }

      .vpss-image-overlay {
        flex-direction: column;
        background: rgba(0,0,0,.84) !important;
        padding: 0 !important;
      }
      .vpss-image-stage {
        width: 100vw !important;
        height: 100vh !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        overflow: auto !important;
        overscroll-behavior: contain !important;
      }
      .vpss-image-zoomed {
        width: min(94vw, 1100px) !important;
        height: min(88vh, 1100px) !important;
        max-width: none !important;
        max-height: none !important;
        object-fit: contain !important;
        background: #fff !important;
        border-radius: 10px !important;
        box-shadow: 0 8px 40px rgba(0,0,0,.55) !important;
        touch-action: pinch-zoom !important;
        user-select: none !important;
        -webkit-user-drag: none !important;
      }
      .vpss-image-close {
        position: fixed;
        top: max(10px, env(safe-area-inset-top));
        right: max(15px, env(safe-area-inset-right));
        z-index: 2;
        border: 0;
        background: rgba(255,255,255,.95);
        border-radius: 50%;
        font-size: 30px;
        width: 42px;
        height: 42px;
        cursor: pointer;
      }
      .vvp-item-tile-content img { cursor: zoom-in; }

      @media (max-width: 650px) {
        #vpss-ui { right: 4px; bottom: 4px; gap: 2px; padding: 3px; }
        #vpss-ui select { max-width: 92px; }
        #vpss-status { min-width: 74px; }
        .vpss-form-grid, .vpss-meta-grid { grid-template-columns: 1fr; }
        .vpss-stats-grid,.vpss-dashboard-cards,.vpss-health-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }
        .vpss-product-head { grid-template-columns: 100px 1fr; gap: 9px; }
        .vpss-product-image { width: 96px; height: 96px; }
        .vpss-product-price { font-size: 21px; }
        .vpss-dialog { padding: 12px; }
      }
    `;
    document.head.appendChild(style);
  }
})();
