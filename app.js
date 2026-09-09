/* ====================================================================
   CircuitNet Expo Lead Scanner - Application Logic
   Offline-first PWA for expo lead capture at Electronica 2026
   ==================================================================== */

const DB_NAME = 'CircuitNetDB';
const DB_VERSION = 2;
const APP_VERSION = 'circuitnet-v24';
const DEFAULT_CATEGORIES = ['PCB Manufacturing','Multilayer PCB','High-TG','RF/High Frequency','Flex','Rigid-Flex','HDI','Metal Core','Ceramic','PCB Assembly','Prototype','Volume Production','PCB Testing/Lab','Other'];
const DEFAULT_VOLUMES = ['Prototype','Small','Medium','High','Unknown'];
const DEFAULT_TIMELINES = ['Immediate','1 Month','1–3 Months','3–6 Months','>6 Months','Unknown'];
const FOLLOWUP_TYPES = ['Phone Call','Email','WhatsApp','Meeting','Site Visit'];

let db = null;
let currentUser = null;
let html5QrCode = null;
let editLeadId = null;

/* ========================= INDEXEDDB ========================= */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('leads')) {
        const s = d.createObjectStore('leads', { keyPath: 'id' });
        s.createIndex('badgeId', 'badgeId', { unique: false });
        s.createIndex('email', 'email', { unique: false });
        s.createIndex('phone', 'phone', { unique: false });
        s.createIndex('priority', 'priority', { unique: false });
        s.createIndex('syncStatus', 'syncStatus', { unique: false });
        s.createIndex('salesperson', 'salesperson', { unique: false });
        s.createIndex('date', 'date', { unique: false });
      }
      if (!d.objectStoreNames.contains('users')) {
        d.createObjectStore('users', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('categories')) {
        d.createObjectStore('categories', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('settings')) {
        d.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!d.objectStoreNames.contains('events')) {
        d.createObjectStore('events', { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

function tx(store, mode = 'readonly') {
  return db.transaction(store, mode).objectStore(store);
}

function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = tx(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(store, id) {
  return new Promise((resolve, reject) => {
    const req = tx(store).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(store, obj) {
  return new Promise((resolve, reject) => {
    const req = tx(store, 'readwrite').put(obj);
    req.onsuccess = () => resolve(obj);
    req.onerror = () => reject(req.error);
  });
}

function dbDelete(store, id) {
  return new Promise((resolve, reject) => {
    const req = tx(store, 'readwrite').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function dbCount(store) {
  return new Promise((resolve, reject) => {
    const req = tx(store).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ========================= CLOUD (SUPABASE) ========================= */
const SUPABASE_URL = 'https://iposzbpoacvqecggdwyy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_l7pVRY9SDCA-eroiow8zNA_kPBPKT3o';
const SB_REST    = SUPABASE_URL + '/rest/v1';

// PostgreSQL folds unquoted column names to lowercase (badgeId → badgeid).
// These functions convert between camelCase (app) and lowercase (Supabase).
var CAMEL_COLS = {
  'badgeid':'badgeId','eventid':'eventId','eventname':'eventName',
  'rawbadgedata':'rawBadgeData','visitortype':'visitorType',
  'leadsource':'leadSource','customerrequirement':'customerRequirement',
  'followup':'followUp','followupdate':'followUpDate',
  'followuptype':'followUpType','followupstatus':'followUpStatus',
  'createdat':'createdAt','updatedat':'updatedAt',
  'syncedat':'syncedAt','syncstatus':'syncStatus'
};

function toLowerKeys(obj) {
  var out = {};
  for (var k in obj) out[k.toLowerCase()] = obj[k];
  return out;
}

function toCamelKeys(obj) {
  var out = {};
  for (var k in obj) out[CAMEL_COLS[k] || k] = obj[k];
  return out;
}

function sbHeaders(extra) {
  var h = { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' };
  if (extra) for (var k in extra) h[k] = extra[k];
  return h;
}

const Cloud = {
  isSyncing: false,
  pollTimer: null,

  log(msg) {
    var ts = new Date().toLocaleTimeString();
    var line = '[' + ts + '] ' + msg;
    console.log('[Cloud]', line);
    var el = document.getElementById('syncDebugLog');
    if (el) {
      if (el.textContent === 'Sync log will appear here...') el.textContent = '';
      el.textContent = line + '\n' + el.textContent;
      // Keep last 30 lines
      var lines = el.textContent.split('\n');
      if (lines.length > 30) el.textContent = lines.slice(0, 30).join('\n');
    }
  },

  async testGet() {
    this.log('Testing GET /leads...');
    try {
      var resp = await fetch(SB_REST + '/leads?select=id,name&limit=5', {
        headers: sbHeaders()
      });
      var body = await resp.text();
      this.log('GET status: ' + resp.status + ' body: ' + body.substring(0, 200));
    } catch (e) {
      this.log('GET FAILED: ' + e.message);
    }
  },

  async testInsert() {
    var testLead = {
      id: 'test-' + Date.now(),
      name: 'TEST LEAD',
      company: 'Test Company',
      syncStatus: 'Synced',
      deleted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.log('Testing POST /leads (with lowercase key conversion)...');
    this.log('URL: ' + SB_REST + '/leads');
    var lowerLead = toLowerKeys(testLead);
    this.log('Body (lowercase keys): ' + JSON.stringify(lowerLead).substring(0, 300));
    try {
      var resp = await fetch(SB_REST + '/leads', {
        method: 'POST',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(lowerLead)
      });
      var body = await resp.text();
      this.log('POST result: ' + resp.status + ' ' + resp.statusText);
      this.log('POST body: ' + body.substring(0, 500));
      if (resp.ok) {
        this.log('✅ INSERT WORKS! Cleaning up...');
        await fetch(SB_REST + '/leads?id=eq.' + testLead.id, {
          method: 'DELETE',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
        });
        this.log('Test lead deleted.');
      } else {
        this.log('❌ INSERT FAILED with status ' + resp.status);
      }
    } catch (e) {
      this.log('❌ POST EXCEPTION: ' + e.message);
    }
  },

  async fetchAll(table, orderCol) {
    var col = orderCol || 'id';
    var resp = await fetch(SB_REST + '/' + table + '?order=' + col, {
      headers: sbHeaders()
    });
    if (!resp.ok) {
      var body = await resp.text();
      throw new Error('fetchAll ' + table + ': ' + resp.status + ' ' + body);
    }
    var rows = await resp.json();
    // Convert lowercase keys back to camelCase
    return rows.map(function(r){ return toCamelKeys(r); });
  },

  async upsert(table, row, conflictCol) {
    var col = conflictCol || 'id';
    var resp = await fetch(SB_REST + '/' + table + '?on_conflict=' + col, {
      method: 'POST',
      headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates' }),
      body: JSON.stringify(toLowerKeys(row))
    });
    if (!resp.ok) {
      var body = await resp.text();
      throw new Error('upsert ' + table + ': ' + resp.status + ' ' + body);
    }
    return true;
  },

  async upsertBatch(table, rows, conflictCol) {
    if (!rows || rows.length === 0) return;
    var col = conflictCol || 'id';
    var lowerRows = rows.map(function(r){ return toLowerKeys(r); });
    var resp = await fetch(SB_REST + '/' + table + '?on_conflict=' + col, {
      method: 'POST',
      headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates' }),
      body: JSON.stringify(lowerRows)
    });
    if (!resp.ok) {
      var body = await resp.text();
      throw new Error('upsertBatch ' + table + ': ' + resp.status + ' ' + body);
    }
    return true;
  },

  async update(table, id, patch) {
    var resp = await fetch(SB_REST + '/' + table + '?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: sbHeaders({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify(toLowerKeys(patch))
    });
    if (!resp.ok) {
      var body = await resp.text();
      throw new Error('update ' + table + ': ' + resp.status + ' ' + body);
    }
    return true;
  },

  async deleteRow(table, id) {
    var resp = await fetch(SB_REST + '/' + table + '?id=eq.' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: sbHeaders()
    });
    if (!resp.ok) {
      var body = await resp.text();
      throw new Error('delete ' + table + ': ' + resp.status + ' ' + body);
    }
    return true;
  },

  /**
   * Push pending leads to Supabase (fast — only leads that changed).
   * Called on every 15-second poll.
   */
  async syncUpLeads() {
    var leads = await dbGetAll('leads');
    var pendingLeads = leads.filter(function(l) { return l.syncStatus === 'Pending' || l.syncStatus === 'Failed' || !l.syncStatus; });
    if (pendingLeads.length > 0) {
      this.log('syncUpLeads: ' + pendingLeads.length + ' pending leads to push');
    }
    for (var i = 0; i < pendingLeads.length; i++) {
      var l = pendingLeads[i];
      l.syncStatus = 'Synced';
      l.syncedAt = new Date().toISOString();
      l.updatedAt = l.updatedAt || l.createdAt || new Date().toISOString();
      l.deleted = false;
      try {
        this.log('Pushing lead ' + l.id + ' (' + (l.name||'') + ')...');
        await this.upsert('leads', l);
        await dbPut('leads', l);
        this.log('✅ Lead ' + l.id + ' synced');
      } catch (e) {
        l.syncStatus = 'Failed';
        await dbPut('leads', l);
        this.log('❌ Lead ' + l.id + ' FAILED: ' + e.message);
      }
    }
  },

  /**
   * Push admin data (users, categories, events, settings) to Supabase.
   * Only called when admin makes changes — NOT on every poll.
   */
  async syncUpAdmin() {
    var users = await dbGetAll('users');
    if (users.length > 0) await this.upsertBatch('users', users).catch(function(e){ console.error('Sync users:', e); });
    var cats = await dbGetAll('categories');
    if (cats.length > 0) await this.upsertBatch('categories', cats).catch(function(e){ console.error('Sync cats:', e); });
    var events = await dbGetAll('events');
    if (events.length > 0) await this.upsertBatch('events', events).catch(function(e){ console.error('Sync events:', e); });
    var settings = await dbGetAll('settings');
    if (settings.length > 0) await this.upsertBatch('settings', settings, 'key').catch(function(e){ console.error('Sync settings:', e); });
  },

  /**
   * Pull all data from Supabase and merge into local IndexedDB.
   * - For leads: merge by comparing updatedAt (cloud wins if newer, unless local is Pending)
   * - For users/categories/events/settings: full replace (cloud is authoritative)
   */
  async syncDown() {
    this.log('syncDown: fetching from cloud...');

    // === LEADS ===
    try {
      var cloudLeads = await this.fetchAll('leads');
      this.log('syncDown: got ' + cloudLeads.length + ' leads from cloud');
      var localLeads = await dbGetAll('leads');
      var localMap = {};
      for (var i = 0; i < localLeads.length; i++) localMap[localLeads[i].id] = localLeads[i];
      for (var i = 0; i < cloudLeads.length; i++) {
        var cl = cloudLeads[i];
        var local = localMap[cl.id];
        if (cl.deleted) {
          if (local) await dbDelete('leads', cl.id);
          continue;
        }
        if (!local) {
          await dbPut('leads', cl);
        } else if (local.syncStatus === 'Pending' || local.syncStatus === 'Failed') {
          // Keep local
        } else {
          var cloudUpdated = cl.updatedAt || cl.createdAt || '';
          var localUpdated = local.updatedAt || local.createdAt || '';
          if (cloudUpdated > localUpdated) await dbPut('leads', cl);
        }
      }
    } catch (e) { this.log('❌ syncDown leads: ' + e.message); }

    // === USERS ===
    try {
      var cloudUsers = await this.fetchAll('users');
      for (var i = 0; i < cloudUsers.length; i++) await dbPut('users', cloudUsers[i]);
      this.log('syncDown: ' + cloudUsers.length + ' users');
    } catch (e) { this.log('❌ syncDown users: ' + e.message); }

    // === CATEGORIES ===
    try {
      var cloudCats = await this.fetchAll('categories');
      for (var i = 0; i < cloudCats.length; i++) await dbPut('categories', cloudCats[i]);
      this.log('syncDown: ' + cloudCats.length + ' categories');
    } catch (e) { this.log('❌ syncDown cats: ' + e.message); }

    // === EVENTS ===
    try {
      var cloudEvents = await this.fetchAll('events');
      for (var i = 0; i < cloudEvents.length; i++) await dbPut('events', cloudEvents[i]);
      this.log('syncDown: ' + cloudEvents.length + ' events');
    } catch (e) { this.log('❌ syncDown events: ' + e.message); }

    // === SETTINGS (uses 'key' column, not 'id') ===
    try {
      var cloudSettings = await this.fetchAll('settings', 'key');
      for (var i = 0; i < cloudSettings.length; i++) await dbPut('settings', cloudSettings[i]);
      this.log('syncDown: ' + cloudSettings.length + ' settings');
    } catch (e) { this.log('❌ syncDown settings: ' + e.message); }
  },

  /**
   * Full sync: push local changes, then pull cloud changes.
   */
  async sync() {
    if (this.isSyncing) return;
    this.isSyncing = true;
    this.log('Sync started...');
    try {
      await this.syncUpLeads();
      await this.syncDown();
      this.log('Sync complete.');
    } catch (e) {
      this.log('❌ Sync error: ' + e.message);
    } finally {
      this.isSyncing = false;
      // Refresh UI if app is visible
      if (typeof App !== 'undefined' && App.updateSyncBadge) App.updateSyncBadge();
      var dashView = document.getElementById('view-dashboard');
      if (dashView && dashView.classList.contains('active') && typeof Dashboard !== 'undefined') Dashboard.render();
      var leadsView = document.getElementById('view-leads');
      if (leadsView && leadsView.classList.contains('active') && typeof Leads !== 'undefined') Leads.render();
    }
  },

  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(function() { Cloud.sync(); }, 15000); // every 15 seconds
  },

  stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }
};

/* ========================= INIT ========================= */
const App = {
  async init() {
    // === FORCE UPDATE CHECK ===
    // If the app version changed (new release deployed), force clear
    // all caches, log out the user, and reload so they must re-login.
    if (!this.checkVersion()) return; // page is reloading, stop init

    await openDB();
    await this.seedDefaults();
    await this.loadSettings();
    await this.populateLoginUsers();
    this.initOnlineDetection();
    this.initServiceWorker();
    // Sync with cloud on startup (push local pending, pull cloud data)
    Cloud.sync();
    Cloud.startPolling();
    // Check if already logged in (persists across app restarts)
    const saved = localStorage.getItem('cn_user');
    if (saved) {
      currentUser = JSON.parse(saved);
      this.showApp();
    }
  },

  /**
   * Compare the current APP_VERSION with the one stored in localStorage.
   * If they differ (new release), wipe everything and reload.
   * Returns false if the page is about to reload (init should stop).
   */
  checkVersion() {
    var stored = localStorage.getItem('cn_app_version');
    if (stored && stored === APP_VERSION) {
      return true; // same version, continue normally
    }
    // New version detected (or first install)
    if (stored) {
      // This is an UPGRADE from an older version — force clear
      this.forceUpdate();
      return false; // page will reload
    }
    // First install (no stored version) — just record it
    localStorage.setItem('cn_app_version', APP_VERSION);
    return true;
  },

  /**
   * Force-clear all caches, unregister service worker, log out user,
   * then hard-reload the page. The user will see the login screen.
   */
  async forceUpdate() {
    // 1. Clear ALL Cache API entries
    if ('caches' in window) {
      var keys = await caches.keys();
      await Promise.all(keys.map(function(k){ return caches.delete(k); }));
    }
    // 2. Unregister the service worker (the new SW will re-register on reload)
    if ('serviceWorker' in navigator) {
      var regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(function(r){ return r.unregister(); }));
    }
    // 3. Clear localStorage — this logs out the user (cn_user, cn_current_event, cn_app_version)
    localStorage.removeItem('cn_user');
    localStorage.removeItem('cn_current_event');
    localStorage.removeItem('cn_app_version');
    // 4. Do NOT set cn_app_version here — on reload, the fresh app.js
    //    will have the new APP_VERSION, and checkVersion() will record it
    //    as a first-install. This prevents an infinite reload loop.
    // 5. Hard reload (bypass cache)
    window.location.reload();
  },

  async seedDefaults() {
    // Seed admin user
    const users = await dbGetAll('users');
    if (users.length === 0) {
      await dbPut('users', { id: 'u-admin', name: 'CircuitNet', username: 'admin', password: 'admin123', role: 'admin', active: true, created: new Date().toISOString() });
      await dbPut('users', { id: 'u-sales1', name: 'Rajesh Kumar', username: 'rajesh', password: 'pass123', role: 'salesperson', active: true, created: new Date().toISOString() });
      await dbPut('users', { id: 'u-sales2', name: 'Priya Sharma', username: 'priya', password: 'pass123', role: 'salesperson', active: true, created: new Date().toISOString() });
      await dbPut('users', { id: 'u-sales3', name: 'Arun Menon', username: 'arun', password: 'pass123', role: 'salesperson', active: true, created: new Date().toISOString() });
    }
    // Seed categories
    const cats = await dbGetAll('categories');
    if (cats.length === 0) {
      for (const c of DEFAULT_CATEGORIES) {
        await dbPut('categories', { id: 'cat-' + Date.now() + '-' + Math.random().toString(36).slice(2,8), name: c, active: true });
      }
    }
    // Seed default event
    const events = await dbGetAll('events');
    if (events.length === 0) {
      await dbPut('events', { id: 'evt-1', name: 'Electronica 2026', venue: 'BIEC Bengaluru, Hall 3, Stall D15', date: '2026-09-08', active: true, created: new Date().toISOString() });
    }
  },

  async loadSettings() {
    const s = await dbGet('settings', 'app');
    App.settings = s ? s.value : {
      companyName: 'CircuitNet Technologies',
      eventName: 'Electronica 2026',
      venue: 'BIEC Bengaluru, Hall 3, Stall D15',
      leadSource: 'Electronica 2026'
    };
    // Ensure OCR key is set (default if not already in settings)
    if (!App.settings.ocrApiKey) App.settings.ocrApiKey = 'K88604395188957';
    // Load current event from localStorage (persists across sessions)
    var savedEvent = localStorage.getItem('cn_current_event');
    if (savedEvent) {
      App.currentEvent = JSON.parse(savedEvent);
    } else {
      // Default to first event
      var events = await dbGetAll('events');
      if (events.length > 0) {
        App.currentEvent = { id: events[0].id, name: events[0].name };
        localStorage.setItem('cn_current_event', JSON.stringify(App.currentEvent));
      } else {
        App.currentEvent = { id: 'evt-1', name: 'Electronica 2026' };
      }
    }
  },

  async setCurrentEvent(eventId) {
    var evt = await dbGet('events', eventId);
    if (!evt) return;
    App.currentEvent = { id: evt.id, name: evt.name };
    localStorage.setItem('cn_current_event', JSON.stringify(App.currentEvent));
    // Update the event selector UI
    var sel = document.getElementById('eventSelector');
    if (sel) sel.value = eventId;
    // Refresh dashboard and leads
    Dashboard.render();
    Leads.render();
    App.toast('Event: ' + evt.name, 'success');
  },

  async populateEventSelector() {
    var events = await dbGetAll('events');
    var sel = document.getElementById('eventSelector');
    if (!sel) return;
    sel.innerHTML = '';
    var active = events.filter(function(e){ return e.active; });
    for (var i = 0; i < active.length; i++) {
      var opt = document.createElement('option');
      opt.value = active[i].id;
      opt.textContent = active[i].name;
      if (App.currentEvent && active[i].id === App.currentEvent.id) opt.selected = true;
      sel.appendChild(opt);
    }
  },

  async populateLoginUsers() {
    // No-op — login is now a text input, not a dropdown
    // Kept for backward compatibility with other code that calls it
  },

  async doLogin() {
    var username = document.getElementById('loginUser').value.trim();
    var pass = document.getElementById('loginPass').value;
    var errEl = document.getElementById('loginError');
    errEl.textContent = '';
    if (!username) { errEl.textContent = 'Enter username'; return; }
    // Look up user by username (case-insensitive)
    var users = await dbGetAll('users');
    var user = users.find(function(u){ return u.username && u.username.toLowerCase() === username.toLowerCase() && u.active; });
    if (!user) { errEl.textContent = 'Invalid username or password'; return; }
    if (user.password !== pass) { errEl.textContent = 'Invalid username or password'; return; }
    currentUser = user;
    localStorage.setItem('cn_user', JSON.stringify(user));
    this.showApp();
    this.toast('Welcome, ' + user.name, 'success');
  },

  /**
   * Check for updates — fetches version.json from the server (bypassing
   * cache) and compares with the current APP_VERSION. If a newer version
   * is found, triggers forceUpdate() which clears cache, logs out, and
   * reloads so the user gets the new version after re-login.
   */
  async checkForUpdates() {
    // Close the drawer
    this.toggleDrawer(false);
    // Show checking state
    var btn = document.getElementById('drawerCheckUpdate');
    if (btn) btn.innerHTML = '<span class="di-icon">⏳</span> Checking...';
    this.toast('Checking for updates...', 'info');

    try {
      // Fetch version.json from server with cache-busting query param
      var url = 'version.json?t=' + Date.now();
      var resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      var serverVersion = data.version || '';

      if (!serverVersion) {
        this.toast('Could not determine server version', 'error');
        if (btn) btn.innerHTML = '<span class="di-icon">🔄</span> Check for Updates';
        return;
      }

      if (serverVersion === APP_VERSION) {
        // Same version — already up to date
        this.toast('✓ You are on the latest version (' + APP_VERSION + ')', 'success');
        if (btn) btn.innerHTML = '<span class="di-icon">🔄</span> Check for Updates';
      } else {
        // New version found!
        this.toast('New version found! Updating to ' + serverVersion + '...', 'success');
        // Small delay so the toast is visible before reload
        var self = this;
        setTimeout(function() { self.forceUpdate(); }, 1500);
      }
    } catch (err) {
      // Network error — likely offline
      this.toast('Unable to check for updates. Please connect to internet.', 'error');
      if (btn) btn.innerHTML = '<span class="di-icon">🔄</span> Check for Updates';
    }
  },

  logout() {
    if (!confirm('Logout? Unsynced data is safely stored.')) return;
    localStorage.removeItem('cn_user');
    currentUser = null;
    if (html5QrCode) { try { html5QrCode.stop(); } catch(e){} html5QrCode = null; }
    document.getElementById('appScreen').style.display = 'none';
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('loginPass').value = '';
    this.populateLoginUsers();
  },

  showApp() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appScreen').style.display = 'block';
    document.getElementById('drawerUserName').textContent = currentUser.name;
    document.getElementById('drawerUserRole').textContent = currentUser.role === 'admin' ? 'Admin' : 'Salesperson';
    document.getElementById('hdrAvatar').textContent = currentUser.name.charAt(0).toUpperCase();
    // Show/hide admin items
    const adminItems = document.querySelectorAll('.admin-only');
    adminItems.forEach(el => el.style.display = currentUser.role === 'admin' ? '' : 'none');
    this.navigate('dashboard');
    Dashboard.render();
    this.updateSyncBadge();
    this.populateEventSelector();
  },

  async navigate(view) {
    // Stop scanner if leaving scan view — but keep the instance alive
    // so the browser doesn't re-ask for camera permission next time.
    // We only stop the camera STREAM (frees the hardware), not the object.
    if (view !== 'scan' && html5QrCode && Scanner.scanning) {
      try { await html5QrCode.stop(); } catch(e){}
      Scanner.scanning = false;
      document.getElementById('scanFrame').style.display = 'none';
      var btn = document.getElementById('btnStartScan'); if (btn) btn.textContent = '▶ Start Camera';
    }
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const el = document.getElementById('view-' + view);
    if (el) el.classList.add('active');
    // Update nav
    document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.nav === view));
    document.querySelectorAll('.drawer-item').forEach(d => d.classList.remove('active'));
    // Close drawer
    this.toggleDrawer(false);
    // View-specific renders
    if (view === 'dashboard') Dashboard.render();
    else if (view === 'scan') { Scanner.start(); }
    else if (view === 'leads') Leads.render();
    else if (view === 'manual') ManualForm.render();
    else if (view === 'export') Export.init();
    else if (view === 'users') Admin.renderUsers();
    else if (view === 'events') Admin.renderEvents();
    else if (view === 'categories') Admin.renderCategories();
    else if (view === 'settings') Admin.renderSettings();
    window.scrollTo(0, 0);
  },

  toggleDrawer(force) {
    const d = document.getElementById('drawer');
    const o = document.getElementById('drawerOverlay');
    if (force === false) { d.classList.remove('open'); o.classList.remove('open'); return; }
    d.classList.toggle('open');
    o.classList.toggle('open');
  },

  /* ===== ONLINE/OFFLINE ===== */
  initOnlineDetection() {
    window.addEventListener('online', () => this.onOnline());
    window.addEventListener('offline', () => this.onOffline());
    if (!navigator.onLine) this.onOffline();
  },

  onOnline() {
    this.updateSyncBadge();
    this.toast('Back online — syncing with cloud...', 'success');
    Cloud.sync();
    Cloud.startPolling();
  },

  onOffline() {
    this.updateSyncBadge();
    this.toast('Offline — data saved locally, will sync when online', 'error');
    // Don't stop polling — navigator.onLine is unreliable on mobile.
    // The sync will just fail gracefully if truly offline.
  },

  async updateSyncBadge() {
    const badge = document.getElementById('syncBadge');
    const icon = document.getElementById('syncIcon');
    const text = document.getElementById('syncText');
    if (!navigator.onLine) {
      badge.className = 'sync-badge sync-offline';
      text.textContent = 'Offline';
    } else {
      // Check if there are pending leads
      var leads = await dbGetAll('leads');
      var pending = leads.filter(function(l){ return l.syncStatus !== 'Synced'; }).length;
      if (pending > 0) {
        badge.className = 'sync-badge sync-offline';
        text.textContent = pending + ' pending';
      } else {
        badge.className = 'sync-badge sync-online';
        text.textContent = 'Cloud Sync';
      }
    }
  },

  async syncNow() {
    this.toast('Syncing with cloud...', 'info');
    await Cloud.syncUpLeads();
    await Cloud.syncUpAdmin();
    await Cloud.syncDown();
    const leads = await dbGetAll('leads');
    const pending = leads.filter(l => l.syncStatus !== 'Synced');
    if (pending.length === 0) {
      this.toast('All data synced to cloud', 'success');
    } else {
      this.toast(pending.length + ' lead(s) pending — will retry', 'error');
    }
    Dashboard.render();
    Leads.render();
  },

  showSyncInfo() {
    this.toast(navigator.onLine ? 'Cloud sync active — data syncs every 15 seconds' : 'Offline — data stored locally, will sync when online');
  },

  /* ===== SERVICE WORKER ===== */
  initServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW registration failed:', e));
      // Listen for force-update messages from the service worker.
      // Only trigger if the SW version DIFFERS from the current app version —
      // the SW posts FORCE_UPDATE on every activation, so without this guard
      // the app would loop: activate → message → forceUpdate → reload → activate → ...
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'FORCE_UPDATE') {
          var swVer = e.data.version || '';
          // Only force-update if the SW reports a version different from what we have
          if (swVer && swVer !== APP_VERSION) {
            this.forceUpdate();
          }
        }
      });
      // Do NOT listen for controllerchange — it fires on every SW registration
      // and causes reload loops. The FORCE_UPDATE message above handles updates.
    }
  },

  /* ===== DEMO DATA ===== */
  async loadDemoData() {
    if (!confirm('Load demo/test badge data? This adds sample leads for testing.')) return;
    const demoLeads = [
      { name:'Vikram Patel', company:'TechPCB India Pvt Ltd', designation:'Procurement Manager', phone:'+919876543210', email:'vikram@techpcb.in', country:'India', city:'Bengaluru', badgeId:'EL26-00001', rawBadge:'EL26|00001|Vikram Patel|TechPCB India Pvt Ltd|Procurement Manager|+919876543210|vikram@techpcb.in|India|Bengaluru', visitorType:'Visitor', priority:'Hot', interest:'Multilayer PCB', volume:'High', timeline:'1 Month', requirement:'50,000 multilayer PCBs per month, 6-layer', followUp:'Yes', followUpDate:this.futureDate(3), followUpType:'Phone Call', followUpStatus:'Pending', remarks:'Decision maker. Wants quote by next week.' },
      { name:'Sarah Johnson', company:'Euro Electronics GmbH', designation:'Head of Sourcing', phone:'+4915112345678', email:'s.johnson@euroelec.de', country:'Germany', city:'Munich', badgeId:'EL26-00002', rawBadge:'NAME:Sarah Johnson;COMP:Euro Electronics GmbH;DESIG:Head of Sourcing;TEL:+4915112345678;EMAIL:s.johnson@euroelec.de;COUNTRY:Germany;CITY:Munich;ID:EL26-00002', visitorType:'VIP', priority:'Hot', interest:'HDI', volume:'Medium', timeline:'Immediate', requirement:'HDI boards for new IoT product line', followUp:'Yes', followUpDate:this.futureDate(1), followUpType:'Email', followUpStatus:'Pending', remarks:'Urgent requirement. Samples needed ASAP.' },
      { name:'Chen Wei', company:'Shenzhen SmartTech', designation:'R&D Engineer', phone:'+8613800138000', email:'chenwei@smarttech.cn', country:'China', city:'Shenzhen', badgeId:'EL26-00003', rawBadge:'{"name":"Chen Wei","company":"Shenzhen SmartTech","designation":"R&D Engineer","phone":"+8613800138000","email":"chenwei@smarttech.cn","country":"China","city":"Shenzhen","badgeId":"EL26-00003"}', visitorType:'Visitor', priority:'Warm', interest:'Rigid-Flex', volume:'Prototype', timeline:'1–3 Months', requirement:'Rigid-flex prototypes for wearable', followUp:'Yes', followUpDate:this.futureDate(7), followUpType:'Meeting', followUpStatus:'Pending', remarks:'Interested in rigid-flex capabilities.' },
      { name:'Anita Desai', company:'InnovaTech Solutions', designation:'CTO', phone:'+919811001100', email:'anita@innovatech.in', country:'India', city:'Pune', badgeId:'EL26-00004', rawBadge:'V,Anita Desai,InnovaTech Solutions,CTO,+919811001100,anita@innovatech.in,India,Pune,EL26-00004', visitorType:'VIP', priority:'Hot', interest:'PCB Assembly', volume:'Medium', timeline:'1 Month', requirement:'Turnkey PCB assembly for 10K units', followUp:'Yes', followUpDate:this.futureDate(2), followUpType:'Site Visit', followUpStatus:'Pending', remarks:'Wants factory visit. Big opportunity.' },
      { name:'Mohammed Al Farsi', company:'Gulf Electronics LLC', designation:'Director', phone:'+971501234567', email:'m.alfarsi@gulfelec.ae', country:'UAE', city:'Dubai', badgeId:'EL26-00005', rawBadge:'N: Mohammed Al Farsi|C: Gulf Electronics LLC|D: Director|P: +971501234567|E: m.alfarsi@gulfelec.ae|CO: UAE|CI: Dubai|BID: EL26-00005', visitorType:'Visitor', priority:'Warm', interest:'Metal Core', volume:'High', timeline:'3–6 Months', requirement:'Metal core PCBs for LED lighting', followUp:'No', followUpDate:'', followUpType:'', followUpStatus:'', remarks:'Evaluating suppliers for Q1 2027 launch.' },
      { name:'Robert Smith', company:'Smith & Associates', designation:'Buyer', phone:'+447700900123', email:'r.smith@smithassoc.co.uk', country:'UK', city:'London', badgeId:'EL26-00006', rawBadge:'Robert Smith,Smith & Associates,Buyer,+447700900123,r.smith@smithassoc.co.uk,UK,London,EL26-00006', visitorType:'Visitor', priority:'Cold', interest:'Prototype', volume:'Small', timeline:'>6 Months', requirement:'Just exploring', followUp:'No', followUpDate:'', followUpType:'', followUpStatus:'', remarks:'General inquiry, not urgent.' },
      { name:'Lakshmi Nair', company:'Kerala Electronics Ltd', designation:'GM Operations', phone:'+919846012345', email:'lakshmi@keralaec.in', country:'India', city:'Kochi', badgeId:'EL26-00007', rawBadge:'NAME:Lakshmi Nair;COMP:Kerala Electronics Ltd;DESIG:GM Operations;PHONE:+919846012345;EMAIL:lakshmi@keralaec.in;COUNTRY:India;CITY:Kochi;BADGE:EL26-00007', visitorType:'Visitor', priority:'Hot', interest:'High-TG', volume:'High', timeline:'Immediate', requirement:'High-TG PCBs for automotive, 20K/month', followUp:'Yes', followUpDate:this.futureDate(0), followUpType:'Phone Call', followUpStatus:'Pending', remarks:'Existing customer looking to expand. Call today!' },
      { name:'Yuki Tanaka', company:'Osaka Precision Inc', designation:'Engineering Manager', phone:'+819012345678', email:'tanaka@osakaprec.jp', country:'Japan', city:'Osaka', badgeId:'EL26-00008', rawBadge:'Yuki Tanaka|Osaka Precision Inc|Engineering Manager|+819012345678|tanaka@osakaprec.jp|Japan|Osaka|EL26-00008', visitorType:'VIP', priority:'Warm', interest:'RF/High Frequency', volume:'Medium', timeline:'1–3 Months', requirement:'RF boards for 5G antenna, tight tolerances', followUp:'Yes', followUpDate:this.futureDate(5), followUpType:'Email', followUpStatus:'Pending', remarks:'Quality focused. Needs capability presentation.' },
    ];

    // Assign to different salespersons
    const salespersons = ['Rajesh Kumar', 'Priya Sharma', 'Arun Menon'];
    for (let i = 0; i < demoLeads.length; i++) {
      const d = demoLeads[i];
      const now = new Date();
      now.setHours(now.getHours() - Math.floor(Math.random() * 72));
      const lead = {
        id: 'lead-' + Date.now() + '-' + i + '-' + Math.random().toString(36).slice(2,6),
        date: this.dateStr(now),
        time: now.toTimeString().slice(0,5),
        salesperson: i < 3 ? currentUser.name : salespersons[i % 3],
        name: d.name, company: d.company, designation: d.designation,
        phone: d.phone, email: d.email, country: d.country, city: d.city,
        badgeId: d.badgeId, rawBadgeData: d.rawBadge,
        visitorType: d.visitorType, leadSource: App.settings.leadSource,
        eventId: App.currentEvent ? App.currentEvent.id : 'evt-1',
        eventName: App.currentEvent ? App.currentEvent.name : App.settings.eventName,
        priority: d.priority, interest: d.interest, volume: d.volume, timeline: d.timeline,
        customerRequirement: d.requirement,
        followUp: d.followUp, followUpDate: d.followUpDate, followUpType: d.followUpType,
        followUpStatus: d.followUpStatus || '', remarks: d.remarks,
        createdAt: now.toISOString(), updatedAt: now.toISOString(),
        syncedAt: '', syncStatus: 'Pending'
      };
      await dbPut('leads', lead);
    }
    this.toast(`${demoLeads.length} demo leads loaded`, 'success');
    Dashboard.render();
    Cloud.sync();
  },

  async clearAllData() {
    if (!confirm('⚠️ Delete ALL leads? This cannot be undone!')) return;
    if (!confirm('Are you absolutely sure? All lead data will be permanently lost!')) return;
    const leads = await dbGetAll('leads');
    // Mark all as deleted in cloud so other devices sync the deletion
    if (navigator.onLine) {
      var now = new Date().toISOString();
      for (const l of leads) {
        try { await Cloud.update('leads', l.id, { deleted: true, updatedAt: now }); } catch(e){}
      }
    }
    for (const l of leads) await dbDelete('leads', l.id);
    this.toast('All lead data cleared', 'success');
    Dashboard.render();
    Leads.render();
  },

  /* ===== HELPERS ===== */
  dateStr(d) {
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toISOString().slice(0,10);
  },

  timeStr() {
    return new Date().toTimeString().slice(0,5);
  },

  futureDate(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0,10);
  },

  toast(msg, type = '') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show ' + type;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
  },

  generateLeadId() {
    return 'lead-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
  }
};

/* ========================= BADGE PARSER ========================= */
const Parser = {
  /**
   * Flexible QR/barcode parser — tries multiple common formats:
   * 1. JSON object
   * 2. vCard (BEGIN:VCARD)
   * 3. Pipe-separated (field|value pairs or delimited)
   * 4. Semicolon-separated (key:value or key=value)
   * 5. Comma-separated values
   * 6. Key-Value with various delimiters (N:, NAME:, etc.)
   * 7. Plain text (try to detect name/email/phone)
   */
  parse(rawData) {
    if (!rawData || typeof rawData !== 'string') return { raw: '', fields: {} };
    const raw = rawData.trim();
    let fields = {};

    // 1. JSON
    if (raw.startsWith('{') || raw.startsWith('[')) {
      try {
        const obj = JSON.parse(raw);
        if (!Array.isArray(obj)) {
          fields = this.mapObject(obj);
          if (Object.keys(fields).length > 0) return { raw, fields };
        }
      } catch(e) {}
    }

    // 2. vCard
    if (raw.toUpperCase().includes('BEGIN:VCARD') || raw.toUpperCase().includes('BEGIN:MECARD')) {
      fields = this.parseVCard(raw);
      if (Object.keys(fields).length > 0) return { raw, fields };
    }

    // 3. Key-value with pipes: KEY|VALUE or KEY:VALUE separated by |
    if (raw.includes('|')) {
      fields = this.parseDelimited(raw, '|');
      if (Object.keys(fields).length >= 2) return { raw, fields };
      // Fallback: pipe-separated plain values (no keys)
      // e.g. EPC1130816|Anil Kumar KS|Director - Business Development|CircuitNet Technologies India Pvt Ltd|India
      fields = this.parsePipeValues(raw);
      if (Object.keys(fields).length >= 2) return { raw, fields };
    }

    // 4. Key-value with semicolons: KEY:VALUE;KEY:VALUE or KEY=VALUE;...
    if (raw.includes(';') && (raw.includes(':') || raw.includes('='))) {
      fields = this.parseDelimited(raw, ';');
      if (Object.keys(fields).length >= 2) return { raw, fields };
    }

    // 5. Key-value with newlines: KEY:VALUE\nKEY:VALUE
    if (raw.includes('\n') && (raw.includes(':') || raw.includes('='))) {
      fields = this.parseDelimited(raw, '\n');
      if (Object.keys(fields).length >= 2) return { raw, fields };
    }

    // 6. Key-value pairs with colons (N:Name, C:Company...)
    if (raw.includes(':')) {
      fields = this.parseKeyValue(raw);
      if (Object.keys(fields).length >= 2) return { raw, fields };
    }

    // 7. Comma-separated: Name,Company,Designation,Phone,Email,Country,City,BadgeID
    if (raw.includes(',')) {
      fields = this.parseCommaSeparated(raw);
      if (Object.keys(fields).length >= 2) return { raw, fields };
    }

    // 8. Fallback: try to extract email, phone, and treat rest as name
    fields = this.parseFreeText(raw);
    return { raw, fields };
  },

  mapObject(obj) {
    const f = {};
    // Build lowercase lookup of object keys
    const lowerObj = {};
    for (const k of Object.keys(obj)) lowerObj[k.toLowerCase()] = obj[k];
    const map = {
      name:['name','fullname','full_name','n','visitorname','visitor_name','pname'],
      company:['company','org','organization','organisation','companyname','company_name','c'],
      designation:['designation','title','role','position','desig','jobtitle','job_title','d'],
      phone:['phone','mobile','tel','telephone','cell','contact','ph','mob'],
      email:['email','e','mail','emailid','email_id'],
      country:['country','co','nation','ctry'],
      city:['city','ci','town','location'],
      badgeId:['badgeid','badge_id','badge','id','bid','uid','visitorid','visitor_id','qrid']
    };
    for (const [target, keys] of Object.entries(map)) {
      for (const k of keys) {
        const v = lowerObj[k];
        if (v !== undefined && v !== null && String(v).trim()) {
          f[target] = String(v).trim();
          break;
        }
      }
    }
    return f;
  },

  parseVCard(raw) {
    const f = {};
    const lines = raw.split(/[\r\n;]+/);
    for (let line of lines) {
      line = line.trim();
      const upper = line.toUpperCase();
      if (upper.startsWith('FN:') || upper.startsWith('N:')) {
        f.name = line.substring(line.indexOf(':') + 1).replace(/;/g, ' ').trim();
      } else if (upper.startsWith('ORG:') || upper.startsWith('ORG:')) {
        f.company = line.substring(line.indexOf(':') + 1).replace(/;/g, ' ').trim();
      } else if (upper.startsWith('TITLE:')) {
        f.designation = line.substring(6).trim();
      } else if (upper.startsWith('TEL') || upper.startsWith('CELL') || upper.startsWith('MOBILE')) {
        f.phone = line.substring(line.indexOf(':') + 1).trim();
      } else if (upper.startsWith('EMAIL')) {
        f.email = line.substring(line.indexOf(':') + 1).trim();
      } else if (upper.startsWith('ADR:')) {
        const parts = line.substring(4).split(';');
        if (parts.length >= 4) { f.city = parts[3].trim(); if (parts.length >= 5) f.country = parts[4].trim(); }
      }
    }
    return f;
  },

  parseDelimited(raw, delim) {
    const f = {};
    const parts = raw.split(delim);
    for (let part of parts) {
      part = part.trim();
      if (!part) continue;
      // Try key:value or key=value
      let kv = null;
      if (part.includes(':')) {
        const idx = part.indexOf(':');
        kv = [part.substring(0, idx).trim(), part.substring(idx + 1).trim()];
      } else if (part.includes('=')) {
        const idx = part.indexOf('=');
        kv = [part.substring(0, idx).trim(), part.substring(idx + 1).trim()];
      }
      if (kv && kv[0] && kv[1]) {
        const mapped = this.mapKey(kv[0]);
        if (mapped && !f[mapped]) f[mapped] = kv[1];
      }
    }
    return f;
  },

  parseKeyValue(raw) {
    const f = {};
    // Split by comma, semicolon, or newline
    const parts = raw.split(/[,;\n\r]+/);
    for (let part of parts) {
      part = part.trim();
      if (!part) continue;
      const idx = part.indexOf(':');
      if (idx > 0) {
        const key = part.substring(0, idx).trim().toUpperCase();
        const val = part.substring(idx + 1).trim();
        if (key && val) {
          const mapped = this.mapKey(key);
          if (mapped && !f[mapped]) f[mapped] = val;
        }
      }
    }
    return f;
  },

  parseCommaSeparated(raw) {
    const f = {};
    const parts = raw.split(',').map(p => p.trim()).filter(p => p);
    // Try to identify fields by pattern
    for (const part of parts) {
      if (!f.email && this.isEmail(part)) f.email = part;
      else if (!f.phone && this.isPhone(part)) f.phone = part;
      else if (!f.badgeId && this.isBadgeId(part)) f.badgeId = part;
      else if (!f.name && !this.isDesignation(part) && !this.isCompany(part)) f.name = part;
      else if (!f.designation && this.isDesignation(part)) f.designation = part;
      else if (!f.company && this.isCompany(part)) f.company = part;
      else if (!f.company) f.company = part;
      else if (!f.designation) f.designation = part;
      else if (!f.country) f.country = part;
      else if (!f.city) f.city = part;
    }
    return f;
  },

  /**
   * Parse pipe-separated plain values (no key names).
   * Handles formats like:
   *   EPC1130816|Anil Kumar KS|Director - Business Development|CircuitNet Technologies India Pvt Ltd|India
   *   Anil Kumar KS|CircuitNet Technologies|Director|+919876543210|anil@circuitnet.in|India|Bengaluru|EPC1130816
   *
   * Strategy: identify each value by pattern (badge ID, email, phone,
   * designation, company, country, city, name) using content heuristics.
   */
  parsePipeValues(raw) {
    const f = {};
    const parts = raw.split('|').map(p => p.trim()).filter(p => p);
    if (parts.length < 2) return f;

    // Known country names (common at expo)
    const countries = ['India','Germany','China','USA','UK','UAE','Japan','Singapore','South Korea','Taiwan','France','Italy','Switzerland','Netherlands','Sweden','Finland','Denmark','Israel','Canada','Australia','Brazil','South Africa','Mexico','Spain','Belgium','Ireland','Poland','Czech Republic','Hungary','Portugal','Austria','Norway','Malaysia','Thailand','Vietnam','Philippines','Indonesia','Turkey','Saudi Arabia','Oman','Qatar','Kuwait','Bahrain','Egypt','Nigeria','Kenya','Morocco','Russia','Ukraine','Romania','Bulgaria','Croatia','Slovakia','Slovenia','Lithuania','Latvia','Estonia','Greece','Iceland','Luxembourg','New Zealand','Hong Kong','Bangladesh','Sri Lanka','Nepal','Bhutan','Pakistan','Afghanistan','Myanmar','Cambodia','Laos','Mongolia','Kazakhstan'];

    // First pass: identify unambiguous fields by pattern
    const remaining = [];
    for (const part of parts) {
      if (!f.email && this.isEmail(part)) { f.email = part; continue; }
      if (!f.phone && this.isPhone(part)) { f.phone = part; continue; }
      if (!f.badgeId && this.isBadgeId(part)) { f.badgeId = part; continue; }
      // Check country (case-insensitive)
      if (!f.country && countries.some(c => c.toLowerCase() === part.toLowerCase())) { f.country = part; continue; }
      remaining.push(part);
    }

    // Second pass: classify remaining values as designation, company, name, city
    for (const part of remaining) {
      if (!f.designation && this.isDesignation(part)) { f.designation = part; continue; }
      if (!f.company && this.isCompany(part)) { f.company = part; continue; }
      if (!f.name && !this.isDesignation(part) && !this.isCompany(part)) { f.name = part; continue; }
      if (!f.company) { f.company = part; continue; }
      if (!f.designation) { f.designation = part; continue; }
      if (!f.city) { f.city = part; continue; }
      // Last resort: put in any empty field
      if (!f.country) { f.country = part; continue; }
    }

    // If name still not set but we have remaining values, take the first one
    if (!f.name) {
      const nameCandidate = remaining.find(p => !this.isDesignation(p) && !this.isCompany(p));
      if (nameCandidate) f.name = nameCandidate;
    }

    return f;
  },

  /**
   * Detect if a string looks like a job designation/title.
   */
  isDesignation(s) {
    const desigKeywords = ['director','manager','engineer','officer','executive','head','lead','specialist','analyst','consultant','developer','architect','designer','technician','supervisor','coordinator','administrator','president','vice president','vp','ceo','cto','cfo','coo','founder','co-founder','partner','owner','proprietor','general manager','gm','project','business development','sales','marketing','procurement','operations','quality','production','r&d','research','supply chain','sourcing','buyer','category','account','regional','national','global','chief','senior','junior','assistant','deputy','associate','intern','trainee'];
    const lower = (s || '').toLowerCase();
    // Must contain at least one keyword and be relatively short (not a company name)
    if (s.length > 80) return false;
    return desigKeywords.some(k => lower.includes(k));
  },

  /**
   * Detect if a string looks like a company name.
   */
  isCompany(s) {
    const companyKeywords = ['technologies','technology','pvt ltd','private limited','ltd','inc','corp','corporation','llc','llp','gmbh','solutions','systems','industries','enterprises','services','electronics','electric','tech','labs','lab','global','international','india','asia','group','holdings','trading','mfg','manufacturing','company','co.','s.a.','n.v.','b.v.','a.s.','oy','ab','spa','sas','srl','kg','ag','oyj','ans'];
    const lower = (s || '').toLowerCase();
    if (s.length > 120) return false;
    return companyKeywords.some(k => lower.includes(k));
  },

  parseFreeText(raw) {
    const f = {};
    // Extract email
    const emailMatch = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) f.email = emailMatch[0];
    // Extract phone (international or Indian format)
    const phoneMatch = raw.match(/(\+?\d[\d\s\-()]{8,})/);
    if (phoneMatch) f.phone = phoneMatch[0].trim();
    // Extract badge ID pattern (alphanumeric with dash)
    const badgeMatch = raw.match(/\b([A-Z]{2,4}[-_]?\d{4,})\b/);
    if (badgeMatch) f.badgeId = badgeMatch[0];
    // Name: first non-email, non-phone, non-number text
    const remaining = raw
      .replace(emailMatch ? emailMatch[0] : '', '')
      .replace(phoneMatch ? phoneMatch[0] : '', '')
      .replace(badgeMatch ? badgeMatch[0] : '', '')
      .trim();
    if (remaining) {
      const namePart = remaining.split(/[,;|]+/)[0].trim();
      if (namePart && namePart.length >= 2) f.name = namePart;
    }
    return f;
  },

  mapKey(key) {
    const k = key.toLowerCase().replace(/[^a-z]/g, '');
    const map = {
      name:['name','fullname','n','visitorname','pname','visitor'],
      company:['company','org','organization','c','companyname'],
      designation:['designation','title','role','position','desig','d','jobtitle'],
      phone:['phone','mobile','tel','telephone','cell','contact','ph','mob','p','t','mobilephone'],
      email:['email','e','mail','emailid'],
      country:['country','co','nation','ctry'],
      city:['city','ci','town','location'],
      badgeId:['badgeid','badge','id','bid','uid','visitorid','qrcode','qrid']
    };
    for (const [target, keys] of Object.entries(map)) {
      if (keys.includes(k)) return target;
    }
    return null;
  },

  isEmail(s) { return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(s); },
  isPhone(s) { return /^\+?\d[\d\s\-()]{8,}$/.test(s); },
  isBadgeId(s) { return /^[A-Z]{2,}\d*[-_]?\d{3,}$/.test(s); }
};

/* ========================= SCANNER ========================= */
const Scanner = {
  scanning: false,

  /**
   * Build the list of formats to support.
   * IMPORTANT: Fewer formats = faster detection.
   * Each format added makes the decoder try one more algorithm per frame.
   * We list only the 5 most common badge formats.
   */
  getFormats() {
    try {
      if (typeof Html5QrcodeSupportedFormats !== 'undefined') {
        return [
          Html5QrcodeSupportedFormats.QR_CODE,
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.PDF_417,
          Html5QrcodeSupportedFormats.DATA_MATRIX,
        ];
      }
    } catch(e) {}
    return undefined;
  },

  /**
   * Build the scanner config.
   * Key performance settings:
   *   - fps: 20  → 20 scan attempts per second (was 15)
   *   - qrbox: capped at 250×250 → smaller area = faster decode per frame
   *   - experimentalFeatures.useBarCodeDetectorIfSupported: true
   *       → uses the browser's NATIVE BarcodeDetector API on Chrome/Android,
 *         which is 5-10x faster than the JS-based decoder
   *   - disableFlip: false → handles mirrored cameras
   */
  buildConfig() {
    return {
      fps: 20,
      qrbox: function(viewfinderWidth, viewfinderHeight) {
        // Guard against invalid / zero dimensions during video init
        if (!viewfinderWidth || !viewfinderHeight ||
            viewfinderWidth < 10 || viewfinderHeight < 10) {
          return { width: 200, height: 200 };
        }
        var minEdge = Math.min(viewfinderWidth, viewfinderHeight);
        var size = Math.floor(minEdge * 0.6);
        // Cap at 250 — a very large scan area is slower to process per frame
        size = Math.min(size, 250);
        return { width: Math.max(150, size), height: Math.max(150, size) };
      },
      experimentalFeatures: {
        useBarCodeDetectorIfSupported: true
      },
      disableFlip: false,
    };
  },

  async start() {
    if (this.scanning) return;
    document.getElementById('scanResult').innerHTML = '';
    document.getElementById('scanStatus').textContent = 'Starting camera...';

    // Build config once so it can be reused in the fallback path
    var self = this;
    var config = this.buildConfig();
    var formats = this.getFormats();
    var constructorOpts = { verbose: false };
    if (formats) constructorOpts.formatsToSupport = formats;

    if (!html5QrCode) {
      html5QrCode = new Html5Qrcode('qrReader', constructorOpts);
    }

    // Simple no-op error callback — fires on every frame without a code.
    // Must be lightweight to avoid slowing down the scan loop.
    var noop = function() {};

    var onSuccess = function() {
      self.scanning = true;
      document.getElementById('scanStatus').textContent = 'Point camera at QR/barcode...';
      document.getElementById('scanFrame').style.display = 'block';
      var btn = document.getElementById('btnStartScan'); if (btn) btn.textContent = '✓ Scanning...';
    };

    var onError = function(msg) {
      var hint = 'Camera not available. Use Manual Entry or Scan from Image below.';
      if (msg && (msg.includes('Permission') || msg.includes('denied') || msg.includes('NotAllowed')))
        hint = 'Camera permission denied. Allow camera in browser settings.';
      else if (msg && (msg.includes('NotFound') || msg.includes('device')))
        hint = 'No camera found. Use Manual Entry or Scan from Image.';
      document.getElementById('scanStatus').textContent = 'Camera error: ' + msg;
      App.toast(hint, 'error');
    };

    // --- Attempt 1: facingMode 'environment' (fastest path, no enumeration) ---
    try {
      await html5QrCode.start(
        { facingMode: 'environment' },
        config,
        function(decodedText) { self.onScan(decodedText); },
        noop
      );
      onSuccess();
      return;
    } catch(e1) {
      console.log('facingMode failed, trying camera enumeration:', e1.message || e1);
    }

    // --- Attempt 2: enumerate cameras and pick the best one (fallback) ---
    try {
      var cameras = await Html5Qrcode.getCameras();
      if (!cameras || cameras.length === 0) throw new Error('No cameras found');

      // Prefer rear camera by label, else last camera (usually rear on phones)
      var cameraId = cameras[cameras.length - 1].id;
      for (var i = 0; i < cameras.length; i++) {
        if (/back|rear|environment/i.test(cameras[i].label)) {
          cameraId = cameras[i].id;
          break;
        }
      }

      // Recreate instance to avoid stale state
      try { await html5QrCode.stop(); } catch(e) {}
      html5QrCode = new Html5Qrcode('qrReader', constructorOpts);

      await html5QrCode.start(
        cameraId,
        config,
        function(decodedText) { self.onScan(decodedText); },
        noop
      );
      onSuccess();
    } catch(e2) {
      onError(e2.message || String(e2));
    }
  },

  async stop() {
    if (html5QrCode && this.scanning) {
      try { await html5QrCode.stop(); } catch(e){}
      this.scanning = false;
      document.getElementById('scanStatus').textContent = 'Scanner stopped';
      document.getElementById('scanFrame').style.display = 'none';
      var btn = document.getElementById('btnStartScan'); if (btn) btn.textContent = '▶ Start Camera';
    }
  },

  /**
   * Scan from an uploaded image file — great fallback when the live camera
   * doesn't work or the badge is a photo.
   */
  async scanFromFile(file) {
    if (!file) return;
    document.getElementById('scanStatus').textContent = 'Scanning image...';
    try {
      // Create a temporary Html5Qrcode instance if needed
      const tempScanner = html5QrCode || new Html5Qrcode('qrReader');
      const result = await tempScanner.scanFile(file, false /* =showImage */);
      document.getElementById('scanStatus').textContent = '✓ Code found in image!';
      await this.onScan(result);
    } catch(e) {
      document.getElementById('scanStatus').textContent = 'No QR/barcode found in image. Try Manual Entry.';
      App.toast('Could not read code from image. Try a clearer photo or use Manual Entry.', 'error');
    }
  },

  async onScan(decodedText) {
    // Stop scanning to process
    await this.stop();

    document.getElementById('scanStatus').textContent = '✓ Badge scanned! Parsing data...';

    // Parse the scanned data
    const result = Parser.parse(decodedText);
    const fields = result.fields;

    // Check for duplicates
    const dup = await this.checkDuplicate(fields);

    // Show parsed result
    this.showResult(decodedText, fields, dup);

    // Auto-fill the manual form with parsed data
    ManualForm.prefillFromScan(decodedText, fields, dup);
  },

  async checkDuplicate(fields) {
    const leads = await dbGetAll('leads');
    for (const lead of leads) {
      if (fields.badgeId && lead.badgeId && fields.badgeId.toLowerCase() === lead.badgeId.toLowerCase())
        return lead;
      if (fields.email && lead.email && fields.email.toLowerCase() === lead.email.toLowerCase())
        return lead;
      if (fields.phone && lead.phone && fields.phone.replace(/\D/g,'') === lead.phone.replace(/\D/g,''))
        return lead;
      if (fields.name && fields.company && lead.name && lead.company &&
          fields.name.toLowerCase() === lead.name.toLowerCase() &&
          fields.company.toLowerCase() === lead.company.toLowerCase())
        return lead;
    }
    return null;
  },

  showResult(raw, fields, dup) {
    const fieldLabels = {
      name:'Name', company:'Company', designation:'Designation',
      phone:'Phone', email:'Email', country:'Country', city:'City', badgeId:'Badge ID'
    };
    let html = '<div class="scan-result-card"><h4>✓ Parsed Badge Data</h4>';
    if (Object.keys(fields).length === 0) {
      html += '<p style="color:var(--text-muted);font-size:14px">No structured data detected. Raw data saved — you can fill details manually below.</p>';
    } else {
      for (const [key, label] of Object.entries(fieldLabels)) {
        if (fields[key]) {
          html += `<div class="parsed-field"><span class="pf-label">${label}</span><span class="pf-value">${this.escape(fields[key])}</span></div>`;
        }
      }
    }
    html += `<div class="parsed-field"><span class="pf-label">Raw Data</span><span class="pf-value" style="font-size:11px;color:var(--text-muted)">${this.escape(raw.substring(0,80))}${raw.length>80?'...':''}</span></div>`;
    html += '</div>';
    if (dup) {
      html += `<div class="dup-warning">⚠ DUPLICATE DETECTED: This badge was already scanned for ${this.escape(dup.name)} (${this.escape(dup.company)}). You can still review and save, or go back.</div>`;
    }
    document.getElementById('scanResult').innerHTML = html;
  },

  escape(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }
};

/* ========================= VISITING CARD SCANNER ========================= */
const CardScanner = {
  isProcessing: false,

  async scan(file) {
    if (!file || this.isProcessing) return;
    this.isProcessing = true;
    App.toggleDrawer(false);

    // Show processing overlay
    var overlay = document.createElement('div');
    overlay.id = 'cardScanOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;padding:20px';
    overlay.innerHTML = '<div style="font-size:48px;margin-bottom:16px">🪪</div>' +
      '<div style="font-size:18px;font-weight:600;margin-bottom:8px">Scanning Visiting Card...</div>' +
      '<div id="cardScanStatus" style="font-size:14px;color:#aaa;margin-bottom:20px">Loading...</div>' +
      '<div style="width:200px;height:6px;background:rgba(255,255,255,.15);border-radius:3px;overflow:hidden">' +
      '<div id="cardScanProgress" style="width:0%;height:100%;background:#0d6efd;transition:width .3s"></div></div>';
    document.body.appendChild(overlay);

    var statusEl = document.getElementById('cardScanStatus');
    var progEl = document.getElementById('cardScanProgress');
    var self = this;

    try {
      // Get API key from settings
      var apiKey = (App.settings && App.settings.ocrApiKey) ? App.settings.ocrApiKey : '';

      var rawText = '';
      var usedApi = false;

      // Try OCR.space API first (if key is available)
      if (apiKey) {
        try {
          statusEl.textContent = 'Uploading to OCR.space...';
          progEl.style.width = '30%';

          // Compress image to under 1MB for OCR.space free tier
          var compressedBlob = await this.compressImage(file);
          console.log('Card scan: compressed image size:', Math.round(compressedBlob.size / 1024), 'KB');

          statusEl.textContent = 'Recognizing text via OCR.space...';
          progEl.style.width = '60%';

          var formData = new FormData();
          formData.append('apikey', apiKey);
          formData.append('file', compressedBlob, 'card.jpg');
          formData.append('language', 'eng');
          formData.append('isOverlayRequired', 'false');
          formData.append('scale', 'true');
          formData.append('OCREngine', '2');

          var response = await fetch('https://api.ocr.space/parse/image', {
            method: 'POST',
            body: formData
          });

          var data = await response.json();
          console.log('OCR.space response:', data);

          if (data && !data.IsErroredOnProcessing && data.ParsedResults && data.ParsedResults.length > 0) {
            rawText = (data.ParsedResults[0].ParsedText || '').trim();
            usedApi = true;
            progEl.style.width = '100%';
            console.log('OCR.space raw text:', rawText);
          } else {
            console.warn('OCR.space error:', data ? data.ErrorMessage : 'no response');
          }
        } catch (apiErr) {
          console.warn('OCR.space failed, falling back to Tesseract:', apiErr.message);
        }
      }

      // If OCR.space didn't work, fall back to Tesseract (offline)
      if (!rawText) {
        statusEl.textContent = 'Using offline OCR engine...';
        if (typeof Tesseract === 'undefined') {
          await this.loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
        }

        var processedCanvas = await this.preprocessImage(file);
        var worker = await Tesseract.createWorker('eng', 1, {
          logger: function(m) {
            if (m.status === 'recognizing text') {
              var pct = Math.round(m.progress * 100);
              progEl.style.width = pct + '%';
              statusEl.textContent = 'Recognizing text... ' + pct + '%';
            } else if (m.status) {
              statusEl.textContent = m.status + '...';
            }
          }
        });
        var psm = (Tesseract.PSM && Tesseract.PSM.SINGLE_BLOCK) ? Tesseract.PSM.SINGLE_BLOCK : '6';
        await worker.setParameters({ tessedit_pageseg_mode: psm });
        var result = await worker.recognize(processedCanvas);
        await worker.terminate();
        rawText = (result.data.text || '').trim();
        console.log('Tesseract raw text:', rawText);
      }

      // Parse the extracted text
      var fields = self.parseCardText(rawText);
      fields.rawBadgeData = rawText;
      fields.ocrSource = usedApi ? 'OCR.space' : 'Tesseract (offline)';

      // Remove overlay
      overlay.remove();

      // Show what was extracted and let user confirm/edit
      self.showExtractedData(fields, rawText);

    } catch (e) {
      console.error('Card scan error:', e);
      overlay.remove();
      App.toast('Card scan failed: ' + e.message, 'error');
    } finally {
      this.isProcessing = false;
    }
  },

  /**
   * Compress image to under 1MB for OCR.space free tier limit
   * Resizes and converts to JPEG with quality adjustment
   */
  compressImage(file) {
    return new Promise(function(resolve, reject) {
      var img = new Image();
      img.onload = function() {
        var maxDim = 2000; // Max width/height
        var quality = 0.9;
        var w = img.width;
        var h = img.height;
        if (w > maxDim || h > maxDim) {
          var ratio = Math.min(maxDim / w, maxDim / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(function(blob) {
          if (blob.size > 900000) {
            // Still too big, reduce quality
            canvas.toBlob(function(blob2) {
              resolve(blob2);
            }, 'image/jpeg', 0.6);
          } else {
            resolve(blob);
          }
        }, 'image/jpeg', quality);
      };
      img.onerror = function() { reject(new Error('Failed to load image')); };
      img.src = URL.createObjectURL(file);
    });
  },

  /**
   * Preprocess image for Tesseract fallback (offline mode)
   */
  preprocessImage(file) {
    return new Promise(function(resolve, reject) {
      var img = new Image();
      img.onload = function() {
        var targetWidth = 2000;
        var scale = 1;
        if (img.width < targetWidth) {
          scale = targetWidth / img.width;
        }
        var w = Math.round(img.width * scale);
        var h = Math.round(img.height * scale);
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);
        var imageData = ctx.getImageData(0, 0, w, h);
        var data = imageData.data;
        var contrastFactor = 1.2;
        for (var i = 0; i < data.length; i += 4) {
          var gray = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
          gray = (gray - 128) * contrastFactor + 128;
          gray = Math.max(0, Math.min(255, gray));
          data[i] = gray;
          data[i+1] = gray;
          data[i+2] = gray;
        }
        ctx.putImageData(imageData, 0, 0);
        resolve(canvas);
      };
      img.onerror = function() { reject(new Error('Failed to load image')); };
      img.src = URL.createObjectURL(file);
    });
  },

  loadScript(src) {
    return new Promise(function(resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function() { reject(new Error('Failed to load OCR engine')); };
      document.head.appendChild(s);
    });
  },

  loadScript(src) {
    return new Promise(function(resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function() { reject(new Error('Failed to load OCR engine')); };
      document.head.appendChild(s);
    });
  },

  parseCardText(text) {
    // Clean up common OCR artifacts
    var cleaned = text
      .replace(/~/g, '')        // Remove tildes (common OCR noise)
      .replace(/\|/g, 'l')      // Pipes misread as 'l'
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n') // Collapse multiple blank lines
      .trim();

    var lines = cleaned.split(/\n/).map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 2; });
    // Further filter: remove lines that are mostly special chars or very short noise
    lines = lines.filter(function(l) {
      // Remove lines that are just special characters or single letters
      var letterCount = (l.match(/[a-zA-Z]/g) || []).length;
      if (letterCount < 2) return false;
      // Remove lines that are mostly non-alphanumeric
      var totalChars = l.length;
      if (letterCount / totalChars < 0.4) return false;
      return true;
    });
    var allText = lines.join(' ');
    var fields = {};

    // === EMAIL ===
    // Try to fix truncated emails — look for @ with at least some domain chars
    var emailMatch = allText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) {
      fields.email = emailMatch[0];
    } else {
      // Try to find partial email and reconstruct from website if available
      var partialEmail = allText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]{3,}/);
      if (partialEmail) {
        fields.email = partialEmail[0];
      }
    }

    // === PHONE ===
    // Match +91 with various spacing: +91 96324 77442, +91-96324-77442, etc.
    var phoneMatch = allText.match(/\+?91[-\s]?\d{5}[-\s]?\d{5}/);
    if (phoneMatch) {
      fields.phone = phoneMatch[0].trim();
    } else {
      // Indian mobile: 10 digits starting 6-9
      phoneMatch = allText.match(/(?:^|\s)([6-9]\d{9})(?:\s|$)/);
      if (phoneMatch) {
        fields.phone = phoneMatch[1];
      } else {
        // International: +XX XXX XXXX+
        phoneMatch = allText.match(/\+\d{1,3}[-\s]?\d{3,}[-\s]?\d{3,}/);
        if (phoneMatch) fields.phone = phoneMatch[0].trim();
      }
    }

    // === WEBSITE ===
    // Look for www. patterns first, then domain.com patterns
    var websiteMatch = allText.match(/(?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?(?:\/[a-zA-Z0-9._/-]*)?/);
    if (websiteMatch) {
      var url = websiteMatch[0];
      // Exclude if it's part of an email
      if (fields.email) {
        var emailDomain = fields.email.split('@')[1];
        if (emailDomain && url.indexOf(emailDomain) === 0) {
          // URL is just the email domain — skip
          url = null;
        }
      }
      if (url && url.indexOf('.') > 0 && url.length > 4) {
        fields.website = url;
      }
    }

    // === DESIGNATION ===
    var designationKeywords = [
      'Managing Director','General Manager','Vice President','Chief Executive','Chief Technology',
      'Chief Financial','Chief Operating','Manager','Director','CEO','CTO','CFO','COO','Founder',
      'Co-Founder','Proprietor','Engineer','Consultant','Architect','Designer','Analyst','Specialist',
      'Officer','Executive','President','VP','Head','Lead','Supervisor','Coordinator','Developer',
      'Programmer','Technician','Partner','Sr.','Senior','Junior'
    ];
    for (var i = 0; i < lines.length; i++) {
      var lineLower = lines[i].toLowerCase();
      // Skip lines that are clearly contact info
      if (lines[i].indexOf('@') >= 0) continue;
      if (lines[i].match(/\+?\d{5,}/)) continue;
      if (lines[i].match(/^(T|E|W|Ph|Phone|Email|Web|Mob|Mobile)[:\s]/i)) continue;
      for (var j = 0; j < designationKeywords.length; j++) {
        if (lineLower.indexOf(designationKeywords[j].toLowerCase()) >= 0 && lines[i].length < 60) {
          // Clean up: remove leading symbols
          fields.designation = lines[i].replace(/^[^a-zA-Z]+/, '').trim();
          break;
        }
      }
      if (fields.designation) break;
    }

    // === COMPANY ===
    var companyKeywords = ['Pvt Ltd','Private Limited','Pvt. Ltd.','Ltd','Limited','Inc','Corp','Corporation',
      'Technologies','Solutions','Systems','Enterprises','Industries','Group','Company','Co.',
      'LLP','LLC','GmbH','Sdn Bhd','Trading','Works','Labs','Tech','Electronics','Electricals'];
    for (var i = 0; i < lines.length; i++) {
      var lineUpper = lines[i].toUpperCase();
      // Skip lines that are clearly contact info
      if (lines[i].indexOf('@') >= 0) continue;
      if (lines[i].match(/\+?\d{5,}/)) continue;
      if (lines[i].match(/^(T|E|W|Ph|Phone|Email|Web|Mob|Mobile)[:\s]/i)) continue;
      if (fields.designation && lines[i] === fields.designation) continue;
      for (var j = 0; j < companyKeywords.length; j++) {
        if (lineUpper.indexOf(companyKeywords[j].toUpperCase()) >= 0 && lines[i].length < 80) {
          fields.company = lines[i].replace(/^[^a-zA-Z#]+/, '').trim();
          break;
        }
      }
      if (fields.company) break;
    }
    // If no company found via keywords, try lines that look like company names
    if (!fields.company) {
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        if (fields.email && l.indexOf('@') >= 0) continue;
        if (fields.phone && l.match(/\d{5,}/)) continue;
        if (fields.website && l === fields.website) continue;
        if (fields.designation && l === fields.designation) continue;
        if (l.match(/^(T|E|W|Ph|Phone|Email|Web|Mob|Mobile)[:\s]/i)) continue;
        if (l.length >= 3 && l.length <= 60 && /^[A-Z#]/.test(l) && !l.match(/^(Mr|Mrs|Ms|Dr)/i)) {
          fields.company = l;
          break;
        }
      }
    }

    // === NAME ===
    // Name is usually: first non-company, non-contact line with 2-4 words, mostly letters
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (fields.email && l.indexOf('@') >= 0) continue;
      if (fields.phone && l.match(/\d{5,}/)) continue;
      if (fields.website && l === fields.website) continue;
      if (fields.designation && l === fields.designation) continue;
      if (fields.company && l === fields.company) continue;
      if (l.match(/^(T|E|W|Ph|Phone|Email|Web|Mob|Mobile)[:\s]/i)) continue;
      if (l.match(/\d{3,}/)) continue;
      if (l.match(/[@#:;]/)) continue;
      if (l.match(/^[#\d]/)) continue; // Skip address lines starting with # or numbers
      // Name pattern: 2-4 words, mostly letters
      var words = l.split(/\s+/);
      if (words.length >= 2 && words.length <= 4) {
        var allAlpha = words.every(function(w) { return /^[A-Za-z.'-]+$/.test(w); });
        if (allAlpha) {
          // Skip if it looks like a company or slogan
          var isCompany = false;
          for (var j = 0; j < companyKeywords.length; j++) {
            if (l.toUpperCase().indexOf(companyKeywords[j].toUpperCase()) >= 0) { isCompany = true; break; }
          }
          // Also skip slogans (like "Idea | Profit | Future")
          if (l.indexOf('|') >= 0 || l.indexOf(' - ') >= 0) isCompany = true;
          if (!isCompany) {
            fields.name = l;
            break;
          }
        }
      }
    }

    // === CITY === (word-boundary matching to avoid "Agrahara" matching "Agra")
    var indianCities = ['Bengaluru','Bangalore','Mumbai','Delhi','New Delhi','Chennai','Hyderabad','Kolkata',
      'Pune','Ahmedabad','Gurugram','Gurgaon','Noida','Kochi','Cochin','Coimbatore','Jaipur','Lucknow',
      'Surat','Kanpur','Nagpur','Indore','Thane','Bhopal','Visakhapatnam','Vizag','Patna','Vadodara',
      'Ghaziabad','Ludhiana','Agra','Nashik','Faridabad','Meerut','Rajkot','Varanasi','Srinagar',
      'Aurangabad','Dhanbad','Amritsar','Allahabad','Ranchi','Howrah','Jabalpur','Gwalior',
      'Vijayawada','Jodhpur','Raipur','Kota','Guwahati','Chandigarh','Mysuru','Mysore','Shimla','Bhubaneswar'];
    for (var i = 0; i < lines.length; i++) {
      for (var j = 0; j < indianCities.length; j++) {
        // Use word-boundary regex: \b ensures "Agra" doesn't match inside "Agrahara"
        var cityRegex = new RegExp('\\b' + indianCities[j].replace(/\./g, '\\\\.') + '\\b', 'i');
        if (cityRegex.test(lines[i])) {
          fields.city = indianCities[j];
          break;
        }
      }
      if (fields.city) break;
    }

    // === COUNTRY ===
    if (allText.match(/\bindia\b/i)) {
      fields.country = 'India';
    } else {
      var countries = ['USA','United States','UK','United Kingdom','Singapore','Germany','China','Japan',
        'UAE','Dubai','Australia','Canada','France','Italy','South Korea','Taiwan','Hong Kong'];
      for (var i = 0; i < countries.length; i++) {
        if (allText.match(new RegExp('\\b' + countries[i].replace(/\./g, '\\\\.') + '\\b', 'i'))) {
          fields.country = countries[i];
          break;
        }
      }
    }

    return fields;
  },

  showExtractedData(fields, rawText) {
    // Navigate to manual entry with pre-filled data
    // Store raw OCR text separately for the debug preview
    this.lastRawOCR = rawText;
    ManualForm.currentScanData = {
      raw: '[Visiting Card OCR] ' + rawText.substring(0, 500),
      fields: fields
    };
    App.navigate('manual');
    App.toggleDrawer(false);

    // Show a toast about what was extracted
    var extracted = [];
    if (fields.name) extracted.push('Name');
    if (fields.company) extracted.push('Company');
    if (fields.designation) extracted.push('Designation');
    if (fields.phone) extracted.push('Phone');
    if (fields.email) extracted.push('Email');
    if (fields.website) extracted.push('Website');
    if (fields.city) extracted.push('City');

    if (extracted.length > 0) {
      App.toast('Extracted: ' + extracted.join(', ') + ' — please verify', 'success');
    } else {
      App.toast('Could not extract data — please enter manually', 'error');
    }

    // Add a collapsible raw OCR text preview after a short delay (after form renders)
    setTimeout(function() {
      var container = document.getElementById('manualFormContainer');
      if (!container) return;
      var existing = document.getElementById('ocrDebugPreview');
      if (existing) existing.remove();

      var debugDiv = document.createElement('div');
      debugDiv.id = 'ocrDebugPreview';
      debugDiv.style.cssText = 'margin-top:16px;padding:12px;background:#1a1a2e;border-radius:8px;border:1px solid #333';
      debugDiv.innerHTML =
        '<div style="color:#aaa;font-size:12px;font-weight:600;margin-bottom:6px;cursor:pointer" onclick="var d=document.getElementById(\'ocrRawText\');d.style.display=d.style.display===\'none\'?\'block\':\'none\'">📋 Raw OCR Text (tap to toggle)</div>' +
        '<pre id="ocrRawText" style="display:none;color:#0f0;font-size:11px;white-space:pre-wrap;word-wrap:break-word;margin:0;max-height:200px;overflow-y:auto">' +
        (rawText.replace(/</g, '<').replace(/>/g, '>') || '(empty)') +
        '</pre>';
      container.appendChild(debugDiv);
    }, 500);
  }
};

/* ========================= MANUAL FORM ========================= */
const ManualForm = {
  currentScanData: null,

  async render() {
    const cats = await dbGetAll('categories');
    const activeCats = cats.filter(c => c.active).map(c => c.name);
    const isEdit = !!editLeadId;
    let lead = null;
    if (isEdit) {
      lead = await dbGet('leads', editLeadId);
      if (!lead) { editLeadId = null; this.render(); return; }
    }

    const data = lead || (this.currentScanData ? this.currentScanData.fields : {});
    const raw = lead ? lead.rawBadgeData : (this.currentScanData ? this.currentScanData.raw : '');

    document.getElementById('manualFormContainer').innerHTML = `
      ${isEdit ? '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px"><button class="btn btn-outline" onclick="App.navigate(\'leads\')" style="padding:10px 14px">← Back</button><h2>Edit Lead</h2></div>' : '<h2 style="margin-bottom:16px">Manual Entry</h2>'}

      <div class="form-card">
        <h3>📋 Visitor Information</h3>
        <div class="form-group"><label>Visitor Name *</label><input type="text" id="f_name" value="${esc(data.name||'')}" placeholder="Full name"></div>
        <div class="field-row">
          <div class="form-group"><label>Company *</label><input type="text" id="f_company" value="${esc(data.company||'')}" placeholder="Company name"></div>
          <div class="form-group"><label>Designation</label><input type="text" id="f_designation" value="${esc(data.designation||'')}" placeholder="Job title"></div>
        </div>
        <div class="field-row">
          <div class="form-group"><label>Mobile / Phone</label><input type="tel" id="f_phone" value="${esc(data.phone||'')}" placeholder="+91..."></div>
          <div class="form-group"><label>Email</label><input type="email" id="f_email" value="${esc(data.email||'')}" placeholder="email@example.com"></div>
        </div>
        <div class="field-row">
          <div class="form-group"><label>Country</label><input type="text" id="f_country" value="${esc(data.country||'India')}" placeholder="Country"></div>
          <div class="form-group"><label>City</label><input type="text" id="f_city" value="${esc(data.city||'')}" placeholder="City"></div>
        </div>
        <div class="form-group"><label>Badge ID</label><input type="text" id="f_badgeId" value="${esc(data.badgeId||'')}" placeholder="Badge ID"></div>
        <div class="field-row">
          <div class="form-group">
            <label>LinkedIn URL / ID</label>
            <div style="position:relative">
              <input type="text" id="f_linkedin" value="${esc(data.linkedin||'')}" placeholder="linkedin.com/in/username" style="padding-right:36px" onblur="ManualForm.autoLinkedIn()">
              <span style="position:absolute;right:8px;top:50%;transform:translateY(-50%);cursor:pointer;font-size:16px" onclick="ManualForm.autoLinkedIn()">🔍</span>
            </div>
          </div>
          <div class="form-group">
            <label>Company Website</label>
            <div style="position:relative">
              <input type="text" id="f_website" value="${esc(data.website||'')}" placeholder="www.company.com" style="padding-right:36px" onblur="ManualForm.autoWebsite()">
              <span style="position:absolute;right:8px;top:50%;transform:translateY(-50%);cursor:pointer;font-size:16px" onclick="ManualForm.autoWebsite()">🔍</span>
            </div>
          </div>
        </div>
        <div class="form-group">
          <label>Visitor Type</label>
          <select id="f_visitorType">
            ${['Visitor','VIP','Exhibitor','Press','Delegate','Speaker','Other'].map(t => `<option ${data.visitorType===t?'selected':''}>${t}</option>`).join('')}
          </select>
        </div>
        ${raw ? `<div class="form-group"><label>Raw Badge Data (preserved)</label><textarea id="f_rawBadge" rows="2" style="background:#f8f9fa" readonly>${esc(raw)}</textarea></div>` : '<input type="hidden" id="f_rawBadge" value="">'}
      </div>

      <div class="form-card">
        <h3>🔥 Lead Qualification</h3>
        <div class="form-group">
          <label>Priority</label>
          <div class="chip-group priority-chips">
            <button class="chip hot ${data.priority==='Hot'?'active':''}" onclick="ManualForm.selectChip(this,'f_priority','Hot')">🔥 Hot</button>
            <button class="chip warm ${data.priority==='Warm'?'active':''}" onclick="ManualForm.selectChip(this,'f_priority','Warm')">☀️ Warm</button>
            <button class="chip cold ${data.priority==='Cold'?'active':''}" onclick="ManualForm.selectChip(this,'f_priority','Cold')">❄️ Cold</button>
          </div>
          <input type="hidden" id="f_priority" value="${esc(data.priority||'')}">
        </div>
        <div class="form-group">
          <label>Interest Area</label>
          <select id="f_interest">
            <option value="">Select interest...</option>
            ${activeCats.map(c => `<option ${data.interest===c?'selected':''}>${esc(c)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Requirement Volume</label>
          <select id="f_volume">
            <option value="">Select volume...</option>
            ${DEFAULT_VOLUMES.map(v => `<option ${data.volume===v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Timeline</label>
          <select id="f_timeline">
            <option value="">Select timeline...</option>
            ${DEFAULT_TIMELINES.map(t => `<option ${data.timeline===t?'selected':''}>${t}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Customer Requirement</label>
          <textarea id="f_customerRequirement" rows="3" placeholder="Describe the customer's requirement in detail...">${esc(data.customerRequirement||'')}</textarea>
        </div>
      </div>

      <div class="form-card">
        <h3>📞 Follow-up</h3>
        <div class="form-group">
          <label>Follow-up Required?</label>
          <div class="chip-group">
            <button class="chip ${data.followUp==='Yes'?'active':''}" onclick="ManualForm.selectChip(this,'f_followUp','Yes')">Yes</button>
            <button class="chip ${data.followUp==='No'?'active':''}" onclick="ManualForm.selectChip(this,'f_followUp','No')">No</button>
          </div>
          <input type="hidden" id="f_followUp" value="${esc(data.followUp||'No')}">
        </div>
        <div class="field-row">
          <div class="form-group"><label>Follow-up Date</label><input type="date" id="f_followUpDate" value="${esc(data.followUpDate||'')}"></div>
          <div class="form-group">
            <label>Follow-up Type</label>
            <select id="f_followUpType">
              <option value="">Select...</option>
              ${FOLLOWUP_TYPES.map(t => `<option ${data.followUpType===t?'selected':''}>${t}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Follow-up Status</label>
          <select id="f_followUpStatus">
            <option value="">Select...</option>
            ${['Pending','In Progress','Completed','Cancelled'].map(s => `<option ${data.followUpStatus===s?'selected':''}>${s}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Remarks</label>
          <textarea id="f_remarks" rows="3" placeholder="Internal notes and remarks...">${esc(data.remarks||'')}</textarea>
        </div>
      </div>

      <div class="form-actions">
        <button class="btn btn-outline" onclick="App.navigate('dashboard')">Cancel</button>
        <button class="btn btn-primary" onclick="ManualForm.save()">${isEdit ? '💾 Update Lead' : '💾 Save Lead'}</button>
      </div>
    `;
  },

  prefillFromScan(raw, fields, dup) {
    this.currentScanData = { raw, fields };
    // Switch to manual form view
    App.navigate('manual');
  },

  selectChip(btn, hiddenId, value) {
    const parent = btn.parentElement;
    parent.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(hiddenId).value = value;
  },

  /**
   * Auto-search LinkedIn when the user blurs the field.
   * Only opens a search if the field is empty — if the user already
   * typed a URL, we don't override it.
   */
  autoLinkedIn() {
    var current = val('f_linkedin').trim();
    if (current) return; // already has a value, don't override
    var name = val('f_name').trim();
    var company = val('f_company').trim();
    if (!name) return; // nothing to search with
    var query = name;
    if (company) query += ' ' + company;
    if (navigator.onLine) {
      var url = 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent(query);
      window.open(url, '_blank');
      App.toast('LinkedIn search opened — copy the profile URL and paste here', 'success');
    }
  },

  /**
   * Auto-search company website when the user blurs the field.
   * Only opens a search if the field is empty.
   */
  autoWebsite() {
    var current = val('f_website').trim();
    if (current) return; // already has a value
    var company = val('f_company').trim();
    if (!company) return;
    var email = val('f_email').trim();
    var query = company + ' official website';
    if (email && email.includes('@')) {
      var domain = email.split('@')[1];
      domain = domain.replace(/^(mail|smtp|webmail|email|contact|m\d+\.)\./i, '');
      query += ' site:' + domain;
    }
    if (navigator.onLine) {
      var url = 'https://www.google.com/search?q=' + encodeURIComponent(query);
      window.open(url, '_blank');
      App.toast('Website search opened — copy the URL and paste here', 'success');
    }
  },

  async save() {
    const name = val('f_name').trim();
    const company = val('f_company').trim();

    if (!name) { App.toast('Name is required', 'error'); return; }
    if (!company) { App.toast('Company is required', 'error'); return; }

    const now = new Date();
    const isEdit = !!editLeadId;

    // Check duplicates (only for new leads)
    if (!isEdit) {
      const dupCheck = {};
      dupCheck.badgeId = val('f_badgeId').trim();
      dupCheck.email = val('f_email').trim();
      dupCheck.phone = val('f_phone').trim();
      dupCheck.name = name;
      dupCheck.company = company;
      const leads = await dbGetAll('leads');
      for (const lead of leads) {
        if (dupCheck.badgeId && lead.badgeId && dupCheck.badgeId.toLowerCase() === lead.badgeId.toLowerCase()) {
          if (!confirm(`Duplicate Badge ID! "${lead.name}" already has this badge. Save anyway?`)) return;
          break;
        }
        if (dupCheck.email && lead.email && dupCheck.email.toLowerCase() === lead.email.toLowerCase()) {
          if (!confirm(`Duplicate Email! "${lead.name}" already has this email. Save anyway?`)) return;
          break;
        }
        if (dupCheck.phone && lead.phone && dupCheck.phone.replace(/\D/g,'') === lead.phone.replace(/\D/g,'')) {
          if (!confirm(`Duplicate Phone! "${lead.name}" already has this number. Save anyway?`)) return;
          break;
        }
        if (dupCheck.name.toLowerCase() === (lead.name||'').toLowerCase() &&
            dupCheck.company.toLowerCase() === (lead.company||'').toLowerCase()) {
          if (!confirm(`Possible duplicate! "${lead.name}" from "${lead.company}" already exists. Save anyway?`)) return;
          break;
        }
      }
    }

    const leadData = {
      name, company,
      designation: val('f_designation'),
      phone: val('f_phone'),
      email: val('f_email'),
      country: val('f_country'),
      city: val('f_city'),
      badgeId: val('f_badgeId'),
      linkedin: val('f_linkedin'),
      website: val('f_website'),
      rawBadgeData: val('f_rawBadge'),
      visitorType: val('f_visitorType'),
      leadSource: App.settings.leadSource,
      eventId: App.currentEvent ? App.currentEvent.id : '',
      eventName: App.currentEvent ? App.currentEvent.name : '',
      priority: val('f_priority'),
      interest: val('f_interest'),
      volume: val('f_volume'),
      timeline: val('f_timeline'),
      customerRequirement: val('f_customerRequirement'),
      followUp: val('f_followUp'),
      followUpDate: val('f_followUpDate'),
      followUpType: val('f_followUpType'),
      followUpStatus: val('f_followUpStatus'),
      remarks: val('f_remarks'),
    };

    if (isEdit) {
      const existing = await dbGet('leads', editLeadId);
      leadData.id = editLeadId;
      leadData.date = existing.date;
      leadData.time = existing.time;
      leadData.salesperson = existing.salesperson === 'Admin' ? 'CircuitNet' : existing.salesperson;
      leadData.createdAt = existing.createdAt;
      leadData.updatedAt = now.toISOString();
      leadData.syncStatus = 'Pending';
      leadData.syncedAt = '';
    } else {
      leadData.id = App.generateLeadId();
      leadData.date = App.dateStr(now);
      leadData.time = App.timeStr();
      leadData.salesperson = currentUser.name;
      leadData.createdAt = now.toISOString();
      leadData.updatedAt = now.toISOString();
      leadData.syncStatus = 'Pending';
      leadData.syncedAt = '';
    }

    await dbPut('leads', leadData);
    // Push to cloud immediately (will be queued if offline)
    Cloud.sync();

    // Clear scan data
    this.currentScanData = null;
    editLeadId = null;

    // Show success screen
    this.showSuccess(isEdit ? 'updated' : 'saved');
  },

  showSuccess(action) {
    document.getElementById('manualFormContainer').innerHTML = `
      <div class="save-success">
        <div class="ss-icon">✅</div>
        <h2>LEAD ${action.toUpperCase()}</h2>
        <p>The lead has been ${action} successfully.</p>
        <p style="margin-top:8px;font-size:13px;color:var(--text-muted)">
          ⏳ Saved — syncing to cloud in background
        </p>
      </div>
      <div class="form-actions" style="flex-direction:column;gap:10px">
        <button class="btn btn-primary btn-large" onclick="ManualForm.render()">📷 SCAN NEXT BADGE</button>
        <div style="display:flex;gap:10px;width:100%">
          <button class="btn btn-outline" style="flex:1" onclick="App.navigate('dashboard')">📊 Dashboard</button>
          <button class="btn btn-outline" style="flex:1" onclick="App.navigate('leads')">📋 View Leads</button>
        </div>
      </div>
    `;
    App.toast(`Lead ${action} successfully`, 'success');
  }
};

/* ========================= LEADS LIST ========================= */
const Leads = {
  currentFilter: '',
  searchQuery: '',

  async render() {
    const cats = await dbGetAll('categories');
    const activeCats = cats.filter(c => c.active).map(c => c.name);
    const users = await dbGetAll('users');

    // Render filter chips
    let chipsHtml = '<div class="filter-chip ' + (this.currentFilter === '' ? 'active' : '') + '" onclick="Leads.setFilter(\'\')">All</div>';
    ['Hot','Warm','Cold'].forEach(p => {
      chipsHtml += `<div class="filter-chip ${this.currentFilter==='priority:'+p?'active':''}" onclick="Leads.setFilter('priority:${p}')">${p}</div>`;
    });
    chipsHtml += `<div class="filter-chip ${this.currentFilter==='followup'?'active':''}" onclick="Leads.setFilter('followup')">📞 Follow-up</div>`;
    chipsHtml += `<div class="filter-chip ${this.currentFilter==='today'?'active':''}" onclick="Leads.setFilter('today')">📅 Today</div>`;
    activeCats.forEach(c => {
      chipsHtml += `<div class="filter-chip ${this.currentFilter==='interest:'+c?'active':''}" onclick="Leads.setFilter('interest:${esc(c)}')">${esc(c)}</div>`;
    });
    users.forEach(u => {
      chipsHtml += `<div class="filter-chip ${this.currentFilter==='salesperson:'+u.name?'active':''}" onclick="Leads.setFilter('salesperson:${esc(u.name)}')">${esc(u.name)}</div>`;
    });
    document.getElementById('filterChips').innerHTML = chipsHtml;

    this.searchQuery = document.getElementById('searchInput').value.toLowerCase();
    const leads = await this.getFiltered();
    const container = document.getElementById('leadsList');

    if (leads.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="es-icon">📋</div><p>No leads found. Scan a badge or add manually to get started.</p></div>`;
      return;
    }

    container.innerHTML = leads.map(l => `
      <div class="lead-item" onclick="Leads.showDetail('${l.id}')">
        <div class="li-top">
          <div>
            <div class="li-name">${esc(l.name)}</div>
            <div class="li-company">${esc(l.company)}${l.designation ? ' · ' + esc(l.designation) : ''}</div>
          </div>
          <div class="priority-dot ${(l.priority||'').toLowerCase()}"></div>
        </div>
        <div class="li-meta">
          ${l.priority ? `<span class="lead-tag" style="background:${l.priority==='Hot'?'#f8d7da':l.priority==='Warm'?'#fff3cd':'#cfe2ff'};color:${l.priority==='Hot'?'#dc3545':l.priority==='Warm'?'#fd7e14':'#0d6efd'}">${l.priority}</span>` : ''}
          ${l.interest ? `<span class="lead-tag interest">${esc(l.interest)}</span>` : ''}
          <span class="lead-tag sync ${(l.syncStatus||'pending').toLowerCase()}">${l.syncStatus||'Pending'}</span>
        </div>
        <div class="li-bottom">
          <span>${esc(l.date)} ${esc(l.time||'')} · ${esc(l.salesperson||'')}</span>
          ${l.followUp==='Yes' ? '<span style="color:var(--warning)">📞 Follow-up</span>' : ''}
        </div>
      </div>
    `).join('');
  },

  async getFiltered() {
    let leads = await dbGetAll('leads');
    // Filter by current event (leads without eventId belong to default event evt-1)
    var evtId = App.currentEvent ? App.currentEvent.id : 'evt-1';
    leads = leads.filter(function(l){ return l.eventId === evtId || (!l.eventId && evtId === 'evt-1'); });
    // Sort by created desc
    leads.sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||''));

    // Apply filter
    if (this.currentFilter) {
      if (this.currentFilter === 'followup') {
        leads = leads.filter(l => l.followUp === 'Yes');
      } else if (this.currentFilter === 'today') {
        const today = App.dateStr(new Date());
        leads = leads.filter(l => l.date === today);
      } else if (this.currentFilter.startsWith('priority:')) {
        const p = this.currentFilter.split(':')[1];
        leads = leads.filter(l => l.priority === p);
      } else if (this.currentFilter.startsWith('interest:')) {
        const i = this.currentFilter.substring('interest:'.length);
        leads = leads.filter(l => l.interest === i);
      } else if (this.currentFilter.startsWith('salesperson:')) {
        const s = this.currentFilter.substring('salesperson:'.length);
        leads = leads.filter(l => l.salesperson === s);
      }
    }

    // Apply search
    if (this.searchQuery) {
      leads = leads.filter(l =>
        (l.name||'').toLowerCase().includes(this.searchQuery) ||
        (l.company||'').toLowerCase().includes(this.searchQuery) ||
        (l.phone||'').toLowerCase().includes(this.searchQuery) ||
        (l.email||'').toLowerCase().includes(this.searchQuery) ||
        (l.badgeId||'').toLowerCase().includes(this.searchQuery) ||
        (l.designation||'').toLowerCase().includes(this.searchQuery) ||
        (l.city||'').toLowerCase().includes(this.searchQuery)
      );
    }
    return leads;
  },

  setFilter(f) {
    this.currentFilter = f;
    this.render();
  },

  async showDetail(id) {
    const lead = await dbGet('leads', id);
    if (!lead) { App.toast('Lead not found', 'error'); return; }

    document.getElementById('detailContainer').innerHTML = `
      <div class="detail-card">
        <div class="detail-header">
          <div class="detail-avatar">${esc(lead.name.charAt(0).toUpperCase())}</div>
          <div style="flex:1">
            <h3>${esc(lead.name)}</h3>
            <p>${esc(lead.company)}${lead.designation ? ' · ' + esc(lead.designation) : ''}</p>
          </div>
          ${lead.priority ? `<span class="lead-tag" style="background:${lead.priority==='Hot'?'#f8d7da':lead.priority==='Warm'?'#fff3cd':'#cfe2ff'};color:${lead.priority==='Hot'?'#dc3545':lead.priority==='Warm'?'#fd7e14':'#0d6efd'};font-size:13px;padding:4px 12px">${lead.priority}</span>` : ''}
        </div>
        <div class="action-row">
          <div class="action-circle" onclick="Leads.callLead('${esc(lead.phone||'')}')"><div class="ac-icon call">📞</div>Call</div>
          <div class="action-circle" onclick="Leads.emailLead('${esc(lead.email||'')}')"><div class="ac-icon email">✉️</div>Email</div>
          <div class="action-circle" onclick="Leads.whatsappLead('${esc(lead.phone||'')}')"><div class="ac-icon whatsapp">💬</div>WhatsApp</div>
          <div class="action-circle" onclick="Leads.linkedinLead('${esc(lead.linkedin||'')}')"><div class="ac-icon" style="background:#0a66c2">in</div>LinkedIn</div>
          <div class="action-circle" onclick="Leads.websiteLead('${esc(lead.website||'')}')"><div class="ac-icon" style="background:#6f42c1">🌐</div>Website</div>
          <div class="action-circle" onclick="Leads.editLead('${lead.id}')"><div class="ac-icon edit">✏️</div>Edit</div>
        </div>
      </div>

      <div class="detail-card">
        <h3 style="font-size:16px;font-weight:700;margin-bottom:14px;padding-bottom:10px;border-bottom:2px solid var(--border)">📋 Contact Details</h3>
        ${lead.eventName ? `<div class="detail-row"><span class="dr-label">Event</span><span class="dr-value">${esc(lead.eventName)}</span></div>` : ''}
        ${lead.phone ? `<div class="detail-row"><span class="dr-label">Phone</span><span class="dr-value">${esc(lead.phone)}</span></div>` : ''}
        ${lead.email ? `<div class="detail-row"><span class="dr-label">Email</span><span class="dr-value">${esc(lead.email)}</span></div>` : ''}
        ${lead.country ? `<div class="detail-row"><span class="dr-label">Country</span><span class="dr-value">${esc(lead.country)}</span></div>` : ''}
        ${lead.city ? `<div class="detail-row"><span class="dr-label">City</span><span class="dr-value">${esc(lead.city)}</span></div>` : ''}
        ${lead.badgeId ? `<div class="detail-row"><span class="dr-label">Badge ID</span><span class="dr-value">${esc(lead.badgeId)}</span></div>` : ''}
        ${lead.linkedin ? `<div class="detail-row"><span class="dr-label">LinkedIn</span><span class="dr-value">${esc(lead.linkedin)}</span></div>` : ''}
        ${lead.website ? `<div class="detail-row"><span class="dr-label">Website</span><span class="dr-value">${esc(lead.website)}</span></div>` : ''}
        ${lead.visitorType ? `<div class="detail-row"><span class="dr-label">Visitor Type</span><span class="dr-value">${esc(lead.visitorType)}</span></div>` : ''}
      </div>

      <div class="detail-card">
        <h3 style="font-size:16px;font-weight:700;margin-bottom:14px;padding-bottom:10px;border-bottom:2px solid var(--border)">🔥 Qualification</h3>
        ${lead.interest ? `<div class="detail-row"><span class="dr-label">Interest</span><span class="dr-value">${esc(lead.interest)}</span></div>` : ''}
        ${lead.volume ? `<div class="detail-row"><span class="dr-label">Volume</span><span class="dr-value">${esc(lead.volume)}</span></div>` : ''}
        ${lead.timeline ? `<div class="detail-row"><span class="dr-label">Timeline</span><span class="dr-value">${esc(lead.timeline)}</span></div>` : ''}
        ${lead.customerRequirement ? `<div class="detail-row"><span class="dr-label">Requirement</span><span class="dr-value">${esc(lead.customerRequirement)}</span></div>` : ''}
      </div>

      ${lead.followUp === 'Yes' ? `
      <div class="detail-card">
        <h3 style="font-size:16px;font-weight:700;margin-bottom:14px;padding-bottom:10px;border-bottom:2px solid var(--border)">📞 Follow-up</h3>
        ${lead.followUpDate ? `<div class="detail-row"><span class="dr-label">Date</span><span class="dr-value">${esc(lead.followUpDate)}</span></div>` : ''}
        ${lead.followUpType ? `<div class="detail-row"><span class="dr-label">Type</span><span class="dr-value">${esc(lead.followUpType)}</span></div>` : ''}
        ${lead.followUpStatus ? `<div class="detail-row"><span class="dr-label">Status</span><span class="dr-value">${esc(lead.followUpStatus)}</span></div>` : ''}
      </div>` : ''}

      ${lead.remarks ? `
      <div class="detail-card">
        <h3 style="font-size:16px;font-weight:700;margin-bottom:14px;padding-bottom:10px;border-bottom:2px solid var(--border)">📝 Remarks</h3>
        <p style="font-size:14px;line-height:1.6">${esc(lead.remarks)}</p>
      </div>` : ''}

      <div class="detail-card">
        <h3 style="font-size:16px;font-weight:700;margin-bottom:14px;padding-bottom:10px;border-bottom:2px solid var(--border)">📊 Meta</h3>
        <div class="detail-row"><span class="dr-label">Lead ID</span><span class="dr-value" style="font-size:11px">${esc(lead.id)}</span></div>
        <div class="detail-row"><span class="dr-label">Date</span><span class="dr-value">${esc(lead.date)} ${esc(lead.time||'')}</span></div>
        <div class="detail-row"><span class="dr-label">Salesperson</span><span class="dr-value">${esc(lead.salesperson||'')}</span></div>
        <div class="detail-row"><span class="dr-label">Lead Source</span><span class="dr-value">${esc(lead.leadSource||'')}</span></div>
        <div class="detail-row"><span class="dr-label">Sync Status</span><span class="dr-value"><span class="lead-tag sync ${(lead.syncStatus||'pending').toLowerCase()}">${lead.syncStatus||'Pending'}</span></span></div>
        ${lead.created_at ? `<div class="detail-row"><span class="dr-label">Created</span><span class="dr-value" style="font-size:12px">${esc(new Date(lead.createdAt).toLocaleString())}</span></div>` : ''}
        ${lead.updatedAt ? `<div class="detail-row"><span class="dr-label">Updated</span><span class="dr-value" style="font-size:12px">${esc(new Date(lead.updatedAt).toLocaleString())}</span></div>` : ''}
        ${lead.syncedAt ? `<div class="detail-row"><span class="dr-label">Synced</span><span class="dr-value" style="font-size:12px">${esc(new Date(lead.syncedAt).toLocaleString())}</span></div>` : ''}
      </div>

      ${lead.rawBadgeData ? `
      <div class="detail-card">
        <h3 style="font-size:16px;font-weight:700;margin-bottom:14px;padding-bottom:10px;border-bottom:2px solid var(--border)">🏷️ Raw Badge Data</h3>
        <p style="font-size:12px;color:var(--text-muted);word-break:break-all;font-family:monospace;background:#f8f9fa;padding:10px;border-radius:8px">${esc(lead.rawBadgeData)}</p>
      </div>` : ''}

      <div class="form-actions">
        <button class="btn btn-outline" onclick="Leads.editLead('${lead.id}')">✏️ Edit</button>
        <button class="btn btn-danger" onclick="Leads.deleteLead('${lead.id}')">🗑️ Delete</button>
      </div>
    `;
    App.navigate('detail');
  },

  callLead(phone) {
    if (!phone) { App.toast('No phone number', 'error'); return; }
    window.location.href = 'tel:' + phone;
  },

  emailLead(email) {
    if (!email) { App.toast('No email address', 'error'); return; }
    window.location.href = 'mailto:' + email;
  },

  whatsappLead(phone) {
    if (!phone) { App.toast('No phone number', 'error'); return; }
    const num = phone.replace(/\D/g, '');
    window.open('https://wa.me/' + num, '_blank');
  },

  linkedinLead(url) {
    if (!url) { App.toast('No LinkedIn URL saved', 'error'); return; }
    var link = url;
    if (!link.startsWith('http')) link = 'https://' + link;
    if (!link.includes('linkedin.com')) {
      // It's a name/id, not a URL — search LinkedIn
      link = 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent(url);
    }
    window.open(link, '_blank');
  },

  websiteLead(url) {
    if (!url) { App.toast('No website saved', 'error'); return; }
    var link = url;
    if (!link.startsWith('http')) link = 'https://' + link;
    window.open(link, '_blank');
  },

  editLead(id) {
    editLeadId = id;
    ManualForm.currentScanData = null;
    App.navigate('manual');
  },

  async deleteLead(id) {
    if (!confirm('Delete this lead permanently?')) return;
    // Mark as deleted in cloud so other devices sync the deletion
    if (navigator.onLine) {
      try { await Cloud.update('leads', id, { deleted: true, updatedAt: new Date().toISOString() }); }
      catch(e) { console.error('Cloud delete failed:', e); }
    }
    await dbDelete('leads', id);
    App.toast('Lead deleted', 'success');
    App.navigate('leads');
    Leads.render();
  }
};

/* ========================= DASHBOARD ========================= */
const Dashboard = {
  async render() {
    var allLeads = await dbGetAll('leads');
    // Filter by current event (leads without eventId belong to default event evt-1)
    var evtId = App.currentEvent ? App.currentEvent.id : 'evt-1';
    var leads = allLeads.filter(function(l){ return l.eventId === evtId || (!l.eventId && evtId === 'evt-1'); });
    const today = App.dateStr(new Date());

    document.getElementById('dashGreeting').textContent = `Hello, ${currentUser.name}`;
    document.getElementById('dashDate').textContent = new Date().toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

    document.getElementById('statTotal').textContent = leads.length;
    document.getElementById('statHot').textContent = leads.filter(l => l.priority === 'Hot').length;
    document.getElementById('statWarm').textContent = leads.filter(l => l.priority === 'Warm').length;
    document.getElementById('statCold').textContent = leads.filter(l => l.priority === 'Cold').length;
    document.getElementById('statToday').textContent = leads.filter(l => l.date === today).length;
    document.getElementById('statFollowup').textContent = leads.filter(l => l.followUp === 'Yes').length;

    this.renderPriorityChart(leads);
    this.renderInterestChart(leads);
    this.renderSalespersonChart(leads);
    this.renderDateChart(leads);
  },

  renderPriorityChart(leads) {
    const counts = { Hot:0, Warm:0, Cold:0 };
    leads.forEach(l => { if (l.priority) counts[l.priority] = (counts[l.priority]||0)+1; });
    const max = Math.max(...Object.values(counts), 1);
    const container = document.getElementById('priorityChart');
    container.innerHTML = Object.entries(counts).map(([k,v]) => `
      <div class="bar-row">
        <div class="bar-label">${k}</div>
        <div class="bar-track"><div class="bar-fill b-${k.toLowerCase()}" style="width:${(v/max*100)}%">${v}</div></div>
      </div>
    `).join('');
  },

  async renderInterestChart(leads) {
    const cats = await dbGetAll('categories');
    const activeCats = cats.filter(c => c.active).map(c => c.name);
    const counts = {};
    leads.forEach(l => { if (l.interest) counts[l.interest] = (counts[l.interest]||0)+1; });
    const sorted = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0, 8);
    const max = Math.max(...sorted.map(e=>e[1]), 1);
    const container = document.getElementById('interestChart');
    if (sorted.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:10px">No interest data yet</p>';
      return;
    }
    container.innerHTML = sorted.map(([k,v]) => `
      <div class="bar-row">
        <div class="bar-label" style="width:120px;font-size:11px">${esc(k)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(v/max*100)}%;background:var(--primary)">${v}</div></div>
      </div>
    `).join('');
  },

  renderSalespersonChart(leads) {
    const counts = {};
    leads.forEach(l => { if (l.salesperson) counts[l.salesperson] = (counts[l.salesperson]||0)+1; });
    const sorted = Object.entries(counts).sort((a,b) => b[1]-a[1]);
    const max = Math.max(...sorted.map(e=>e[1]), 1);
    const container = document.getElementById('salespersonChart');
    if (sorted.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:10px">No salesperson data yet</p>';
      return;
    }
    container.innerHTML = sorted.map(([k,v]) => `
      <div class="bar-row">
        <div class="bar-label" style="width:100px;font-size:11px">${esc(k)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(v/max*100)}%;background:var(--success)">${v}</div></div>
      </div>
    `).join('');
  },

  renderDateChart(leads) {
    const dates = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(App.dateStr(d));
    }
    const counts = {};
    dates.forEach(d => counts[d] = 0);
    leads.forEach(l => { if (counts.hasOwnProperty(l.date)) counts[l.date]++; });
    const max = Math.max(...Object.values(counts), 1);
    const container = document.getElementById('dateChart');
    container.innerHTML = dates.map(d => {
      const label = new Date(d).toLocaleDateString('en-IN', { day:'numeric', month:'short' });
      return `
        <div class="bar-row">
          <div class="bar-label" style="width:60px;font-size:11px">${label}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(counts[d]/max*100)}%;background:var(--primary)">${counts[d]}</div></div>
        </div>
      `;
    }).join('');
  }
};

/* ========================= EXPORT ========================= */
const Export = {
  async init() {
    const cats = await dbGetAll('categories');
    const activeCats = cats.filter(c => c.active).map(c => c.name);
    const users = await dbGetAll('users');

    const interestSel = document.getElementById('exportInterest');
    interestSel.innerHTML = '<option value="">All Interests</option>' + activeCats.map(c => `<option>${esc(c)}</option>`).join('');

    const spSel = document.getElementById('exportSalesperson');
    spSel.innerHTML = '<option value="">All Salespersons</option>' + users.map(u => `<option>${esc(u.name)}</option>`).join('');

    this.updateSummary();
    ['exportPriority','exportInterest','exportSalesperson','exportSync'].forEach(id => {
      document.getElementById(id).onchange = () => this.updateSummary();
    });
  },

  async getFiltered() {
    let leads = await dbGetAll('leads');
    const p = document.getElementById('exportPriority').value;
    const i = document.getElementById('exportInterest').value;
    const s = document.getElementById('exportSalesperson').value;
    const sync = document.getElementById('exportSync').value;
    // Filter by current event
    var evtId = App.currentEvent ? App.currentEvent.id : 'evt-1';
    leads = leads.filter(function(l){ return l.eventId === evtId || (!l.eventId && evtId === 'evt-1'); });
    if (p) leads = leads.filter(l => l.priority === p);
    if (i) leads = leads.filter(l => l.interest === i);
    if (s) leads = leads.filter(l => l.salesperson === s);
    if (sync) leads = leads.filter(l => l.syncStatus === sync);
    leads.sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||''));
    return leads;
  },

  async updateSummary() {
    const leads = await this.getFiltered();
    document.getElementById('exportSummary').innerHTML = `
      <div class="detail-row"><span class="dr-label">Total leads to export</span><span class="dr-value">${leads.length}</span></div>
      <div class="detail-row"><span class="dr-label">Hot</span><span class="dr-value">${leads.filter(l=>l.priority==='Hot').length}</span></div>
      <div class="detail-row"><span class="dr-label">Warm</span><span class="dr-value">${leads.filter(l=>l.priority==='Warm').length}</span></div>
      <div class="detail-row"><span class="dr-label">Cold</span><span class="dr-value">${leads.filter(l=>l.priority==='Cold').length}</span></div>
      <div class="detail-row"><span class="dr-label">Follow-ups</span><span class="dr-value">${leads.filter(l=>l.followUp==='Yes').length}</span></div>
    `;
  },

  async doExport(format) {
    const leads = await this.getFiltered();
    if (leads.length === 0) { App.toast('No leads to export with current filters', 'error'); return; }

    const headers = ['Lead ID','Date','Time','Salesperson','Event','Visitor Name','Company','Designation','Mobile','Email','Country','City','Badge ID','LinkedIn','Website','Raw Badge Data','Visitor Type','Lead Source','Priority','Interest','Volume','Timeline','Customer Requirement','Follow-up','Follow-up Date','Follow-up Type','Follow-up Status','Remarks','Created At','Updated At','Synced At','Sync Status'];

    const rows = leads.map(l => [
      l.id||'', l.date||'', l.time||'', l.salesperson||'',
      l.eventName||'',
      l.name||'', l.company||'', l.designation||'',
      l.phone||'', l.email||'', l.country||'', l.city||'',
      l.badgeId||'', l.linkedin||'', l.website||'', l.rawBadgeData||'', l.visitorType||'',
      l.leadSource||'', l.priority||'', l.interest||'',
      l.volume||'', l.timeline||'', l.customerRequirement||'',
      l.followUp||'', l.followUpDate||'', l.followUpType||'',
      l.followUpStatus||'', l.remarks||'',
      l.createdAt||'', l.updatedAt||'', l.syncedAt||'', l.syncStatus||''
    ]);

    const ts = new Date().toISOString().slice(0,16).replace(/[-:T]/g,'');
    const filename = `CircuitNet_Leads_${ts}`;

    if (format === 'csv') {
      const csv = [headers, ...rows].map(r => r.map(c => {
        const s = String(c||'');
        if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g,'""') + '"';
        return s;
      }).join(',')).join('\n');
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
      this.download(blob, filename + '.csv');
      App.toast(`Exported ${leads.length} leads to CSV`, 'success');
    } else if (format === 'xlsx') {
      const wsData = [headers, ...rows];
      const ws = XLSX.utils.aoa_to_sheet(wsData);
      // Set column widths
      ws['!cols'] = headers.map(h => ({ wch: Math.max(h.length, 15) }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Leads');
      const wbout = XLSX.write(wb, { bookType:'xlsx', type:'array' });
      const blob = new Blob([wbout], { type:'application/octet-stream' });
      this.download(blob, filename + '.xlsx');
      App.toast(`Exported ${leads.length} leads to Excel`, 'success');
    }
  },

  download(blob, filename) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
};

/* ========================= ADMIN ========================= */
const Admin = {
  async renderEvents() {
    var events = await dbGetAll('events');
    var html = '';
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      var isCurrent = App.currentEvent && e.id === App.currentEvent.id;
      var leadCount = await this.countLeadsForEvent(e.id);
      html += '<div class="card" style="margin-bottom:12px;padding:16px">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start">' +
        '<div>' +
        '<div style="font-size:17px;font-weight:700">' + esc(e.name) + (isCurrent ? ' <span style="font-size:10px;background:#0d6efd;color:#fff;padding:2px 8px;border-radius:10px;margin-left:6px">ACTIVE</span>' : '') + '</div>' +
        '<div style="font-size:13px;color:#666;margin-top:4px">' + esc(e.venue || '') + (e.date ? ' · ' + esc(e.date) : '') + '</div>' +
        '<div style="font-size:12px;color:#999;margin-top:4px">' + leadCount + ' leads saved</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px">' +
        (isCurrent ? '' : '<button class="btn btn-outline" style="padding:6px 12px;font-size:12px" onclick="App.setCurrentEvent(\'' + e.id + '\')">Set Active</button>') +
        '<button class="btn btn-danger" style="padding:6px 12px;font-size:12px" onclick="Admin.deleteEvent(\'' + e.id + '\')">🗑️</button>' +
        '</div>' +
        '</div></div>';
    }
    if (events.length === 0) html = '<div class="card" style="text-align:center;padding:40px;color:#999">No events yet. Tap "Add Event" to create one.</div>';
    document.getElementById('eventsList').innerHTML = html;
  },

  async countLeadsForEvent(eventId) {
    var leads = await dbGetAll('leads');
    return leads.filter(function(l){ return l.eventId === eventId || (!l.eventId && eventId === 'evt-1'); }).length;
  },

  async addEvent() {
    var name = prompt('Event name:', '');
    if (!name || !name.trim()) return;
    var venue = prompt('Venue / Stall:', '');
    var date = prompt('Event date (YYYY-MM-DD):', new Date().toISOString().slice(0,10));
    var id = 'evt-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
    await dbPut('events', { id: id, name: name.trim(), venue: venue || '', date: date || '', active: true, created: new Date().toISOString() });
    App.toast('Event created: ' + name, 'success');
    this.renderEvents();
    App.populateEventSelector();
    Cloud.syncUpAdmin();
  },

  async deleteEvent(id) {
    var count = await this.countLeadsForEvent(id);
    if (count > 0) {
      if (!confirm('This event has ' + count + ' leads. Delete event anyway? Leads will keep their data but lose event association.')) return;
    } else {
      if (!confirm('Delete this event?')) return;
    }
    await dbDelete('events', id);
    if (navigator.onLine) { try { await Cloud.deleteRow('events', id); } catch(e){} }
    // If current event was deleted, switch to first available
    if (App.currentEvent && App.currentEvent.id === id) {
      var events = await dbGetAll('events');
      if (events.length > 0) {
        await App.setCurrentEvent(events[0].id);
      }
    }
    App.toast('Event deleted', 'success');
    this.renderEvents();
    App.populateEventSelector();
  },

  async renderUsers() {
    const users = await dbGetAll('users');
    users.sort((a,b) => (a.name||'').localeCompare(b.name||''));
    const container = document.getElementById('userList');
    if (users.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>No users. Add one above.</p></div>';
      return;
    }
    container.innerHTML = users.map(u => `
      <div class="user-card">
        <div class="uc-info">
          <h4>${esc(u.name)} ${u.active ? '' : '<span style="color:var(--danger);font-size:12px">(Inactive)</span>'}</h4>
          <p>${esc(u.username)} · ${esc(u.role)}</p>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <div class="uc-role ${u.role}">${esc(u.role)}</div>
          <button class="btn btn-outline" style="padding:8px 12px;font-size:13px" onclick="Admin.showUserModal('${u.id}')">Edit</button>
          ${u.id !== 'u-admin' ? `<button class="btn btn-danger" style="padding:8px 12px;font-size:13px" onclick="Admin.deleteUser('${u.id}')">🗑️</button>` : ''}
        </div>
      </div>
    `).join('');
  },

  showUserModal(id) {
    const isEdit = !!id;
    let user = { name:'', username:'', password:'', role:'salesperson', active:true };
    if (isEdit) {
      // We need to load async, but for simplicity use a callback
      dbGet('users', id).then(u => {
        user = u;
        this._renderUserModal(user, isEdit);
      });
    } else {
      this._renderUserModal(user, isEdit);
    }
  },

  _renderUserModal(user, isEdit) {
    document.getElementById('modalContent').innerHTML = `
      <div class="modal-head">
        <h3>${isEdit ? 'Edit User' : 'Add User'}</h3>
        <button class="modal-close" onclick="Admin.closeModal()">×</button>
      </div>
      <div class="modal-body">
        <div class="form-group"><label>Name</label><input type="text" id="mu_name" value="${esc(user.name||'')}" placeholder="Full name"></div>
        <div class="form-group"><label>Username</label><input type="text" id="mu_username" value="${esc(user.username||'')}" placeholder="username"></div>
        <div class="form-group"><label>Password</label><input type="text" id="mu_password" value="${esc(user.password||'')}" placeholder="password"></div>
        <div class="form-group"><label>Role</label><select id="mu_role"><option value="salesperson" ${user.role==='salesperson'?'selected':''}>Salesperson</option><option value="admin" ${user.role==='admin'?'selected':''}>Admin</option></select></div>
        <div class="form-group"><label>Status</label><select id="mu_active"><option value="true" ${user.active?'selected':''}>Active</option><option value="false" ${!user.active?'selected':''}>Inactive</option></select></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-outline" style="flex:1" onclick="Admin.closeModal()">Cancel</button>
        <button class="btn btn-primary" style="flex:1" onclick="Admin.saveUser('${user.id||''}', ${isEdit})">Save</button>
      </div>
    `;
    document.getElementById('modalOverlay').classList.add('open');
  },

  async saveUser(id, isEdit) {
    const name = document.getElementById('mu_name').value.trim();
    const username = document.getElementById('mu_username').value.trim();
    const password = document.getElementById('mu_password').value.trim();
    const role = document.getElementById('mu_role').value;
    const active = document.getElementById('mu_active').value === 'true';
    if (!name || !username || !password) { App.toast('All fields required', 'error'); return; }
    // Check username uniqueness
    const users = await dbGetAll('users');
    if (users.some(u => u.username === username && u.id !== id)) { App.toast('Username already exists', 'error'); return; }
    const user = {
      id: id || ('u-' + Date.now() + '-' + Math.random().toString(36).slice(2,6)),
      name, username, password, role, active,
      created: isEdit ? (await dbGet('users', id)).created : new Date().toISOString()
    };
    await dbPut('users', user);
    this.closeModal();
    App.toast('User saved', 'success');
    this.renderUsers();
    App.populateLoginUsers();
    Cloud.syncUpAdmin();
  },

  async deleteUser(id) {
    const u = await dbGet('users', id);
    if (!confirm(`Delete user "${u.name}"?`)) return;
    await dbDelete('users', id);
    if (navigator.onLine) { try { await Cloud.deleteRow('users', id); } catch(e){} }
    App.toast('User deleted', 'success');
    this.renderUsers();
    App.populateLoginUsers();
  },

  /* ===== TEAM SYNC: Export / Import users + categories + settings ===== */

  async exportTeamConfig() {
    const users = await dbGetAll('users');
    const cats = await dbGetAll('categories');
    const settings = await dbGet('settings', 'app');

    const config = {
      type: 'CircuitNet-TeamConfig',
      version: 1,
      exportedAt: new Date().toISOString(),
      exportedBy: currentUser ? currentUser.name : 'admin',
      users: users.map(u => ({
        id: u.id, name: u.name, username: u.username,
        password: u.password, role: u.role, active: u.active,
        created: u.created
      })),
      categories: cats.map(c => ({ id: c.id, name: c.name, active: c.active })),
      settings: settings ? settings.value : null
    };

    const json = JSON.stringify(config, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const ts = new Date().toISOString().slice(0,16).replace(/[-:T]/g, '');
    const filename = 'CircuitNet_TeamConfig_' + ts + '.json';
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function(){ URL.revokeObjectURL(link.href); }, 2000);

    App.toast('Team config exported: ' + users.length + ' users, ' + cats.length + ' categories. Share this file with your team.', 'success');
  },

  async importTeamConfig(file, fromLogin) {
    if (!file) return;
    try {
      const text = await file.text();
      const config = JSON.parse(text);

      if (!config || config.type !== 'CircuitNet-TeamConfig') {
        App.toast('Invalid file: not a CircuitNet Team Config file', 'error');
        return;
      }

      var addedUsers = 0, updatedUsers = 0;
      var addedCats = 0, updatedCats = 0;

      // --- Merge users ---
      const localUsers = await dbGetAll('users');
      for (const impUser of (config.users || [])) {
        const existingById = localUsers.find(function(u){ return u.id === impUser.id; });
        const existingByUsername = localUsers.find(function(u){ return u.username === impUser.username; });

        if (existingById || existingByUsername) {
          var existing = existingById || existingByUsername;
          existing.name = impUser.name;
          existing.username = impUser.username;
          existing.password = impUser.password;
          existing.role = impUser.role;
          existing.active = impUser.active;
          await dbPut('users', existing);
          updatedUsers++;
        } else {
          await dbPut('users', {
            id: impUser.id || ('u-' + Date.now() + '-' + Math.random().toString(36).slice(2,6)),
            name: impUser.name,
            username: impUser.username,
            password: impUser.password,
            role: impUser.role,
            active: impUser.active !== false,
            created: impUser.created || new Date().toISOString()
          });
          addedUsers++;
        }
      }

      // --- Merge categories ---
      if (config.categories && config.categories.length > 0) {
        const localCats = await dbGetAll('categories');
        for (const impCat of config.categories) {
          const existingById = localCats.find(function(c){ return c.id === impCat.id; });
          const existingByName = localCats.find(function(c){ return c.name === impCat.name; });

          if (existingById || existingByName) {
            var existingCat = existingById || existingByName;
            existingCat.name = impCat.name;
            existingCat.active = impCat.active;
            await dbPut('categories', existingCat);
            updatedCats++;
          } else {
            await dbPut('categories', {
              id: impCat.id || ('cat-' + Date.now() + '-' + Math.random().toString(36).slice(2,6)),
              name: impCat.name,
              active: impCat.active !== false
            });
            addedCats++;
          }
        }
      }

      // --- Update settings ---
      if (config.settings) {
        await dbPut('settings', { key: 'app', value: config.settings });
        App.settings = config.settings;
      }

      // --- Refresh UI ---
      await App.populateLoginUsers();

      var msg = 'Import complete: ' + addedUsers + ' new user(s), ' + updatedUsers + ' updated, ' + addedCats + ' new category, ' + updatedCats + ' updated.';
      App.toast(msg, 'success');

      if (fromLogin) {
        var errEl = document.getElementById('loginError');
        errEl.textContent = '';
        errEl.style.color = 'var(--success)';
        errEl.textContent = msg + ' Select your name and login.';
        setTimeout(function(){ errEl.style.color = ''; }, 5000);
      } else {
        var usersView = document.getElementById('view-users');
        if (usersView && usersView.classList.contains('active')) this.renderUsers();
        var catView = document.getElementById('view-categories');
        if (catView && catView.classList.contains('active')) this.renderCategories();
        var setView = document.getElementById('view-settings');
        if (setView && setView.classList.contains('active')) this.renderSettings();
      }

    } catch(e) {
      App.toast('Error reading file: ' + e.message, 'error');
    }
  },

  async renderCategories() {
    const cats = await dbGetAll('categories');
    cats.sort((a,b) => (a.name||'').localeCompare(b.name||''));
    const container = document.getElementById('categoryList');
    if (cats.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>No categories. Add one above.</p></div>';
      return;
    }
    container.innerHTML = cats.map(c => `
      <div class="cat-card">
        <div>
          <div class="cc-name">${esc(c.name)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${c.active ? 'Active' : 'Inactive'}</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-outline" style="padding:6px 12px;font-size:13px" onclick="Admin.showCategoryModal('${c.id}')">Edit</button>
          <button class="btn btn-danger" style="padding:6px 12px;font-size:13px" onclick="Admin.deleteCategory('${c.id}')">🗑️</button>
        </div>
      </div>
    `).join('');
  },

  showCategoryModal(id) {
    const isEdit = !!id;
    if (isEdit) {
      dbGet('categories', id).then(c => this._renderCatModal(c, true));
    } else {
      this._renderCatModal({ name:'', active:true }, false);
    }
  },

  _renderCatModal(cat, isEdit) {
    document.getElementById('modalContent').innerHTML = `
      <div class="modal-head">
        <h3>${isEdit ? 'Edit Category' : 'Add Category'}</h3>
        <button class="modal-close" onclick="Admin.closeModal()">×</button>
      </div>
      <div class="modal-body">
        <div class="form-group"><label>Interest Category Name</label><input type="text" id="mc_name" value="${esc(cat.name||'')}" placeholder="e.g., Flexible PCB"></div>
        <div class="form-group"><label>Status</label><select id="mc_active"><option value="true" ${cat.active?'selected':''}>Active</option><option value="false" ${!cat.active?'selected':''}>Inactive</option></select></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-outline" style="flex:1" onclick="Admin.closeModal()">Cancel</button>
        <button class="btn btn-primary" style="flex:1" onclick="Admin.saveCategory('${cat.id||''}', ${isEdit})">Save</button>
      </div>
    `;
    document.getElementById('modalOverlay').classList.add('open');
  },

  async saveCategory(id, isEdit) {
    const name = document.getElementById('mc_name').value.trim();
    const active = document.getElementById('mc_active').value === 'true';
    if (!name) { App.toast('Name required', 'error'); return; }
    const cats = await dbGetAll('categories');
    if (cats.some(c => c.name === name && c.id !== id)) { App.toast('Category already exists', 'error'); return; }
    const cat = {
      id: id || ('cat-' + Date.now() + '-' + Math.random().toString(36).slice(2,6)),
      name, active
    };
    await dbPut('categories', cat);
    this.closeModal();
    App.toast('Category saved', 'success');
    this.renderCategories();
    Cloud.syncUpAdmin();
  },

  async deleteCategory(id) {
    const c = await dbGet('categories', id);
    if (!confirm(`Delete category "${c.name}"?`)) return;
    await dbDelete('categories', id);
    if (navigator.onLine) { try { await Cloud.deleteRow('categories', id); } catch(e){} }
    App.toast('Category deleted', 'success');
    this.renderCategories();
  },

  closeModal() {
    document.getElementById('modalOverlay').classList.remove('open');
  },

  renderSettings() {
    document.getElementById('setCompanyName').value = App.settings.companyName || '';
    document.getElementById('setEventName').value = App.settings.eventName || '';
    document.getElementById('setVenue').value = App.settings.venue || '';
    document.getElementById('setLeadSource').value = App.settings.leadSource || '';
    var ocrEl = document.getElementById('setOcrKey');
    if (ocrEl) ocrEl.value = App.settings.ocrApiKey || '';
  },

  async saveSettings() {
    var ocrEl = document.getElementById('setOcrKey');
    App.settings = {
      companyName: document.getElementById('setCompanyName').value,
      eventName: document.getElementById('setEventName').value,
      venue: document.getElementById('setVenue').value,
      leadSource: document.getElementById('setLeadSource').value,
      ocrApiKey: ocrEl ? ocrEl.value.trim() : (App.settings.ocrApiKey || '')
    };
    await dbPut('settings', { key: 'app', value: App.settings });
    App.toast('Settings saved', 'success');
    Cloud.syncUpAdmin();
  }
};

/* ========================= HELPERS ========================= */
function esc(s) {
  if (s === null || s === undefined) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}
function val(id) { const el = document.getElementById(id); return el ? el.value : ''; }

// Modal close on overlay click
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) Admin.closeModal();
});

// Enter key on login
document.getElementById('loginPass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') App.doLogin();
});

// Initialize app on load
window.addEventListener('DOMContentLoaded', () => App.init());
