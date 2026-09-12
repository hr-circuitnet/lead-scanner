/* ====================================================================
   CircuitNet Expo Lead Scanner - Application Logic
   Offline-first PWA for expo lead capture at Electronica 2026
   ==================================================================== */

const DB_NAME = 'CircuitNetDB';
const DB_VERSION = 2;
const APP_VERSION = 'circuitnet-v50';
const DEFAULT_CATEGORIES = ['PCB Manufacturing','Multilayer PCB','High-TG','RF/High Frequency','Flex','Rigid-Flex','HDI','Metal Core','Ceramic','PCB Assembly','Prototype','Volume Production','PCB Testing/Lab','Other'];
const DEFAULT_VOLUMES = ['Prototype','Small','Medium','High','Unknown'];
const DEFAULT_TIMELINES = ['Immediate','1 Month','1–3 Months','3–6 Months','>6 Months','Unknown'];
const DEFAULT_VISITOR_TYPES = ['Visitor','VIP','Exhibitor','Press','Delegate','Speaker','Other'];
const DEFAULT_PRIORITIES = ['Hot','Warm','Cold'];
const DEFAULT_FOLLOWUP_TYPES = ['Phone Call','Email','WhatsApp','Meeting','Site Visit'];
const DEFAULT_FOLLOWUP_STATUSES = ['Pending','In Progress','Completed','Cancelled'];
const FOLLOWUP_TYPES = ['Phone Call','Email','WhatsApp','Meeting','Site Visit'];

let db = null;
let currentUser = null;
let html5QrCode = null;
let editLeadId = null;

/* ========================= CLOUD-DIRECT DATA LAYER =========================
   NO local storage. Every read fetches live data from the central database;
   every write goes straight to it. A brief in-memory cache (5 seconds) only
   de-duplicates fetches within a single render pass. If the network fails,
   reads throw — the app keeps showing the last rendered content rather
   than pretending the data is empty. */
var _cloudCache = {};
var _cacheTTL = 5000;

function invalidateCache(table) {
  if (table) { delete _cloudCache[table]; }
  else { _cloudCache = {}; }
}

function openDB() {
  // No local database — all data lives in the central cloud database.
  return Promise.resolve();
}

/** Apply deletion/trash tombstones from the settings blob. The database
 *  tables may lack trashed/deleted columns (writes get stripped), but the
 *  settings blob is schema-independent and always syncs — so it is the
 *  source of truth for what was deleted or trashed on any device. */
function _applyTombstones(store, rows) {
  try {
    var st = App.settings || {};
    if (store === 'leads') {
      var delIds = st.deletedLeadIds || [];
      var trIds = st.trashedLeadIds || [];
      rows = rows.filter(function(l) {
        if (l.deleted) return false;
        if (delIds.indexOf(l.id) >= 0) return false;
        if (trIds.indexOf(l.id) >= 0) l.trashed = true;
        return true;
      });
    } else if (store === 'users') {
      var duIds = st.deletedUserIds || [];
      rows = rows.filter(function(u) { return duIds.indexOf(u.id) < 0; });
    } else if (store === 'categories') {
      var dcNames = (st.deletedCategoryNames || []).map(function(n){ return n.toLowerCase(); });
      rows = rows.filter(function(c) { return dcNames.indexOf((c.name || '').toLowerCase()) < 0; });
    } else if (store === 'events') {
      var deNames = (st.deletedEventNames || []).map(function(n){ return n.toLowerCase(); });
      rows = rows.filter(function(ev) { return deNames.indexOf((ev.name || '').toLowerCase()) < 0; });
    }
  } catch(e) {}
  return rows;
}

async function dbGetAll(store) {
  var now = Date.now();
  var entry = _cloudCache[store];
  var rows;
  if (entry && entry.expiry > now) {
    rows = entry.data.slice();
  } else {
    var orderCol = (store === 'settings') ? 'key' : 'id';
    rows = await Cloud.fetchAll(store, orderCol);
    _cloudCache[store] = { data: rows, expiry: now + _cacheTTL };
  }
  return _applyTombstones(store, rows);
}

async function dbGet(store, id) {
  var rows = await dbGetAll(store);
  for (var i = 0; i < rows.length; i++) {
    if (store === 'settings' ? rows[i].key === id : rows[i].id === id) return rows[i];
  }
  return null;
}

async function dbPut(store, obj) {
  invalidateCache(store);
  var conflictCol = (store === 'settings') ? 'key' : 'id';
  return await Cloud.upsert(store, obj, conflictCol);
}

async function dbDelete(store, id) {
  invalidateCache(store);
  await Cloud.deleteRow(store, id);
}

async function dbCount(store) {
  var rows = await dbGetAll(store);
  return rows.length;
}

/* ========================= CLOUD (SUPABASE) ========================= */
const SUPABASE_URL = 'https://iposzbpoacvqecggdwyy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_l7pVRY9SDCA-eroiow8zNA_kPBPKT3o';
const SB_REST    = SUPABASE_URL + '/rest/v1';

// PostgreSQL folds unquoted column names to lowercase (badgeId → badgeid).
// These functions convert between camelCase (app) and lowercase (Supabase).
var CAMEL_COLS = {
  'badgeid':'badgeId','eventid':'eventId','eventname':'eventName',
  'rawbadgedata':'rawBadgeData','rawocrdata':'rawOcrData','capturedate':'captureDate',
  'phone2':'phone2','phone3':'phone3','phone4':'phone4','phone5':'phone5',
  'visitortype':'visitorType',
  'address':'address',
  'state':'state','pincode':'pincode',
  'department':'department',
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

  /** Serialized queue — every sync job runs one at a time. This kills the
   *  push/pull races where syncUpAdmin from one caller interleaved with a
   *  poll-driven sync() from another and reverted fresh changes. */
  enqueue(job) {
    var run = this._queue.then(job, job);
    this._queue = run.then(function(){}, function(){});
    return run;
  },
  _queue: Promise.resolve(),

  /** fetch with a hard timeout so a stalled network can never freeze
   *  isSyncing and kill the polling loop. */
  fetchT(url, opts, timeoutMs) {
    var ms = timeoutMs || 20000;
    if (!window.AbortController) return fetch(url, opts);
    return new Promise(function(resolve, reject) {
      var ctrl = new AbortController();
      var t = setTimeout(function() { ctrl.abort(); }, ms);
      opts = opts || {};
      opts.signal = ctrl.signal;
      fetch(url, opts).then(
        function(r) { clearTimeout(t); resolve(r); },
        function(e) { clearTimeout(t); reject(e && e.name === 'AbortError' ? new Error('Request timed out: ' + url) : e); });
    });
  },

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
      var resp = await this.fetchT(SB_REST + '/leads?select=id,name&limit=5', {
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
      var resp = await this.fetchT(SB_REST + '/leads', {
        method: 'POST',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(lowerLead)
      });
      var body = await resp.text();
      this.log('POST result: ' + resp.status + ' ' + resp.statusText);
      this.log('POST body: ' + body.substring(0, 500));
      if (resp.ok) {
        this.log('✅ INSERT WORKS! Cleaning up...');
        await this.fetchT(SB_REST + '/leads?id=eq.' + testLead.id, {
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

  async resetSyncStatus() {
    this.log('Resetting all lead sync statuses to Pending...');
    var leads = await dbGetAll('leads');
    var count = 0;
    for (var i = 0; i < leads.length; i++) {
      leads[i].syncStatus = 'Pending';
      leads[i].syncedAt = '';
      await dbPut('leads', leads[i]);
      count++;
    }
    this.log('Reset ' + count + ' leads to Pending. Syncing...');
    App.toast('Reset ' + count + ' leads. Syncing to cloud...', 'success');
    this.sync();
  },

  async fetchAll(table, orderCol) {
    var col = orderCol || 'id';
    var resp = await this.fetchT(SB_REST + '/' + table + '?order=' + col, {
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
    var payload = toLowerKeys(row);
    // Strip empty/null values to reduce chance of schema mismatch
    for (var k in payload) {
      if (payload[k] === null || payload[k] === undefined || payload[k] === '') delete payload[k];
    }
    // Pre-strip known potentially-missing columns to reduce 400 errors
    // These columns may not exist in older Supabase schemas
    var optionalCols = ['capturedate', 'rawocrdata', 'phone2', 'phone3', 'phone4', 'phone5',
      'address', 'state', 'pincode', 'department', 'email2', 'linkedin', 'capturedate'];
    // Try full payload first
    var maxRetries = 10;
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      var resp = await this.fetchT(SB_REST + '/' + table + '?on_conflict=' + col, {
        method: 'POST',
        headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates' }),
        body: JSON.stringify(payload)
      });
      if (resp.ok) {
        if (attempt > 0) this.log('✅ Upsert succeeded after stripping ' + attempt + ' missing column(s)');
        return true;
      }
      var body = await resp.text();
      if (resp.status !== 400 || body.indexOf('Could not find the') < 0) {
        throw new Error('upsert ' + table + ': ' + resp.status + ' ' + body);
      }
      // Extract missing column name and strip it
      var m = body.match(/'([a-z]+)' column/);
      if (!m) throw new Error('upsert ' + table + ': ' + resp.status + ' ' + body);
      this.log('⚠️ Column ' + m[1] + ' not in Supabase schema — retrying without it');
      delete payload[m[1]];
    }
    throw new Error('upsert ' + table + ': failed after ' + maxRetries + ' retries');
  },

  async upsertBatch(table, rows, conflictCol) {
    if (!rows || rows.length === 0) return;
    var col = conflictCol || 'id';
    // Strip empty values from all rows
    var lowerRows = rows.map(function(r){
      var lr = toLowerKeys(r);
      for (var k in lr) { if (lr[k] === null || lr[k] === undefined || lr[k] === '') delete lr[k]; }
      return lr;
    });
    // Retry loop for missing columns
    var maxRetries = 10;
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      var resp = await this.fetchT(SB_REST + '/' + table + '?on_conflict=' + col, {
        method: 'POST',
        headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates' }),
        body: JSON.stringify(lowerRows)
      });
      if (resp.ok) return true;
      var body = await resp.text();
      if (resp.status !== 400 || body.indexOf('Could not find the') < 0) {
        throw new Error('upsertBatch ' + table + ': ' + resp.status + ' ' + body);
      }
      var m = body.match(/'([a-z]+)' column/);
      if (!m) throw new Error('upsertBatch ' + table + ': ' + resp.status + ' ' + body);
      this.log('⚠️ Batch: Column ' + m[1] + ' not in schema — retrying without it');
      lowerRows.forEach(function(r){ delete r[m[1]]; });
    }
    throw new Error('upsertBatch ' + table + ': failed after retries');
  },

  async update(table, id, patch) {
    var resp = await this.fetchT(SB_REST + '/' + table + '?id=eq.' + encodeURIComponent(id), {
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
    var resp = await this.fetchT(SB_REST + '/' + table + '?id=eq.' + encodeURIComponent(id), {
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
  syncUpLeads() {
    // Cloud-direct mode: writes go straight to the database — nothing to push.
    return Promise.resolve();
  },

  async _workSyncUpLeads() {
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
  syncUpAdmin() {
    // Cloud-direct mode: writes go straight to the database — nothing to push.
    return Promise.resolve();
  },

  async _workSyncUpAdmin() {
    // NOTE: users are NOT mass-pushed here. A stale device pushing its full
    // local users list every 15s was overwriting fresh role/permission
    // changes made on another device. Each user is pushed individually via
    // syncUpUser() at the moment it is saved.
    // Never push categories on the deleted-names list — pushing them would
    // resurrect deleted categories in the cloud and on every other device
    var delCatNames = (App.settings.deletedCategoryNames || []).map(function(n){ return n.toLowerCase(); });
    var cats = (await dbGetAll('categories')).filter(function(c) {
      return delCatNames.indexOf((c.name || '').toLowerCase()) < 0;
    });
    if (cats.length > 0) await this.upsertBatch('categories', cats).catch(function(e){ console.error('Sync cats:', e); });
    var events = await dbGetAll('events');
    if (events.length > 0) await this.upsertBatch('events', events).catch(function(e){ console.error('Sync events:', e); });
    var settings = await dbGetAll('settings');
    if (settings.length > 0) await this.upsertBatch('settings', settings, 'key').catch(function(e){ console.error('Sync settings:', e); });
  },

  syncUpUser(user) {
    // Cloud-direct mode: writes go straight to the database — nothing to push.
    return Promise.resolve();
  },

  async _workSyncUpUser(user) {
    try {
      await this.upsert('users', user);
      this.log('syncUpUser: pushed user ' + user.username);
      return true;
    } catch(e) {
      console.error('Sync user:', e);
      this.log('syncUpUser failed: ' + e.message);
      return false;
    }
  },

  /**
   * Pull all data from Supabase and merge into local IndexedDB.
   * - For leads: merge by comparing updatedAt (cloud wins if newer, unless local is Pending)
   * - For users/categories/events/settings: full replace (cloud is authoritative)
   */
  async _workSyncDown() {
    this.log('syncDown: fetching from cloud...');

    // === LEADS (cloud-authoritative for synced leads; tombstones for
    // permanent deletes; trash state propagated via settings blob) ===
    try {
      var cloudLeads = await this.fetchAll('leads');
      this.log('syncDown: got ' + cloudLeads.length + ' leads from cloud');
      var localLeads = await dbGetAll('leads');
      var localMap = {};
      for (var i = 0; i < localLeads.length; i++) localMap[localLeads[i].id] = localLeads[i];
      var deletedLeadIds = App.settings.deletedLeadIds || [];
      var trashedLeadIds = App.settings.trashedLeadIds || [];
      // Apply trash state from the settings tombstone (schema-independent)
      for (var i = 0; i < localLeads.length; i++) {
        var tl = localLeads[i];
        if (!tl.trashed && trashedLeadIds.indexOf(tl.id) >= 0) {
          tl.trashed = true;
          tl.trashedAt = tl.trashedAt || new Date().toISOString();
          await dbPut('leads', tl);
        }
      }
      for (var i = 0; i < cloudLeads.length; i++) {
        var cl = cloudLeads[i];
        if (deletedLeadIds.indexOf(cl.id) >= 0) {
          // Tombstoned — purge from the cloud so it can't resurrect
          try { await this.deleteRow('leads', cl.id); } catch(e2) {}
          continue;
        }
        if (cl.deleted) {
          if (localMap[cl.id]) await dbDelete('leads', cl.id);
          continue;
        }
        var local = localMap[cl.id];
        if (!local) {
          // New from another device — add it
          await dbPut('leads', cl);
        } else if (local.syncStatus === 'Pending' || local.syncStatus === 'Failed') {
          // Keep local — it gets pushed on the next sync-up
        } else {
          // Already synced: accept the cloud version. Our own push ran
          // before this pull, so accepting cloud is what makes edits
          // converge across devices (no timestamp column required).
          await dbPut('leads', cl);
        }
      }
      // Remove tombstoned leads locally
      for (var i = 0; i < deletedLeadIds.length; i++) {
        if (localMap[deletedLeadIds[i]]) await dbDelete('leads', deletedLeadIds[i]);
      }
    } catch (e) { this.log('❌ syncDown leads: ' + e.message); }

    // === USERS (skip deleted IDs; newer updatedAt wins so local edits
    // are not reverted by stale cloud data) ===
    try {
      var cloudUsers = await this.fetchAll('users');
      var deletedUserIds = App.settings.deletedUserIds || [];
      for (var i = 0; i < cloudUsers.length; i++) {
        var cu = cloudUsers[i];
        if (deletedUserIds.indexOf(cu.id) >= 0) continue;
        var lu = await dbGet('users', cu.id);
        if (lu && lu.updatedAt && cu.updatedAt && lu.updatedAt > cu.updatedAt) continue; // local is newer
        await dbPut('users', cu);
      }
      this.log('syncDown: ' + cloudUsers.length + ' users');
    } catch (e) { this.log('❌ syncDown users: ' + e.message); }

    // === CATEGORIES (skip + purge deleted names, dedup by name) ===
    try {
      var cloudCats = await this.fetchAll('categories');
      var localCats = await dbGetAll('categories');
      var deletedCatNames = (App.settings.deletedCategoryNames || []).map(function(n){ return n.toLowerCase(); });
      var seenNames = {};
      // Remove any local categories that are on the deleted list
      for (var i = 0; i < localCats.length; i++) {
        var ln = (localCats[i].name || '').toLowerCase();
        if (deletedCatNames.indexOf(ln) >= 0) {
          await dbDelete('categories', localCats[i].id);
        } else {
          seenNames[ln] = true;
        }
      }
      var added = 0;
      for (var i = 0; i < cloudCats.length; i++) {
        var cn = (cloudCats[i].name || '').toLowerCase();
        if (!cn) continue;
        if (deletedCatNames.indexOf(cn) >= 0) {
          // Cleanup: remove the deleted-name row from the cloud itself
          try { await this.deleteRow('categories', cloudCats[i].id); } catch(e2) {}
          continue;
        }
        if (!seenNames[cn]) {
          await dbPut('categories', cloudCats[i]);
          seenNames[cn] = true;
          added++;
        }
      }
      this.log('syncDown: ' + cloudCats.length + ' categories from cloud, ' + added + ' new added');
      await App.dedupCategories();
    } catch (e) { this.log('❌ syncDown cats: ' + e.message); }

    // === EVENTS (add from cloud + dedup by name + skip deleted) ===
    try {
      var cloudEvents = await this.fetchAll('events');
      var deletedEventNames = (App.settings.deletedEventNames || []).map(function(n){ return n.toLowerCase(); });
      for (var i = 0; i < cloudEvents.length; i++) {
        var en = (cloudEvents[i].name || '').toLowerCase();
        if (en && deletedEventNames.indexOf(en) < 0) {
          await dbPut('events', cloudEvents[i]);
        }
      }
      // Dedup local events by name (keep first, delete rest)
      var allEvents = await dbGetAll('events');
      var seenEv = {};
      for (var i = 0; i < allEvents.length; i++) {
        var ek = (allEvents[i].name || '').toLowerCase();
        if (deletedEventNames.indexOf(ek) >= 0) {
          await dbDelete('events', allEvents[i].id);
        } else if (seenEv[ek]) {
          await dbDelete('events', allEvents[i].id);
        } else {
          seenEv[ek] = true;
        }
      }
      this.log('syncDown: ' + cloudEvents.length + ' events from cloud');
    } catch (e) { this.log('❌ syncDown events: ' + e.message); }

    // === SETTINGS (uses 'key' column, not 'id'; newer timestamp wins) ===
    try {
      var cloudSettings = await this.fetchAll('settings', 'key');
      var localRow = await dbGet('settings', 'app');
      var localTs = (localRow && localRow.value && localRow.value.settingsUpdatedAt) ? localRow.value.settingsUpdatedAt : 0;
      for (var i = 0; i < cloudSettings.length; i++) {
        var cs = cloudSettings[i];
        if (cs.key === 'app') {
          if (typeof cs.value === 'string') { try { cs.value = JSON.parse(cs.value); } catch(e){} }
          var cloudTs = (cs.value && cs.value.settingsUpdatedAt) ? cs.value.settingsUpdatedAt : 0;
          if (localTs > cloudTs) continue; // local is newer — keep local
          await dbPut('settings', cs);
          if (cs.value) App.settings = cs.value;
        } else {
          await dbPut('settings', cs);
        }
      }
      this.log('syncDown: ' + cloudSettings.length + ' settings');
      // If admin set a default event, apply it for non-admin users
      if (typeof currentUser !== 'undefined' && currentUser) {
        var sRow = await dbGet('settings', 'app');
        if (sRow && sRow.value && sRow.value.defaultEventId) {
          var defEvt = await dbGet('events', sRow.value.defaultEventId);
          if (defEvt) {
            App.currentEvent = { id: defEvt.id, name: defEvt.name };
            localStorage.setItem('cn_current_event', JSON.stringify(App.currentEvent));
            App.updateEventDisplay();
            var dispEl = document.getElementById('eventDisplayText');
            if (dispEl) dispEl.textContent = defEvt.name;
            Dashboard.render();
            Leads.render();
          }
        }
      }
    } catch (e) { this.log('❌ syncDown settings: ' + e.message); }
  },

  /**
   * Full sync: push local changes, then pull cloud changes.
   */
  sync() {
    // Cloud-direct mode: there is no sync engine. Drop the in-memory cache,
    // reload settings first (tombstones, default event), THEN re-render the
    // active view with fresh data.
    invalidateCache();
    var doRender = function() {
      try {
        var isActive = function(id) {
          var el = document.getElementById(id);
          return el && el.classList.contains('active');
        };
        if (isActive('view-dashboard')) Dashboard.render();
        if (isActive('view-leads')) Leads.render();
        if (isActive('view-trash')) Leads.renderTrash();
        if (isActive('view-users')) Admin.renderUsers();
        if (isActive('view-categories')) Admin.renderCategories();
        if (isActive('view-events')) Admin.renderEvents();
      } catch(e) {}
    };
    try {
      App.loadSettings().then(doRender, doRender);
    } catch(e) { doRender(); }
  },

  async _workSync() {
    if (this.isSyncing) return;
    this.isSyncing = true;
    this.log('Sync started...');
    try {
      await this._workSyncUpLeads();
      if (typeof currentUser !== 'undefined' && currentUser && currentUser.role === 'admin') {
        await this._workSyncUpAdmin();
      }
      await this._workSyncDown();
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
    this.updateEventDisplay();
    this.initOnlineDetection();
    this.initServiceWorker();
    // Pre-warm camera permission on first load so browser remembers it
    this.initCameraPermission();
    // Trap the browser Back button: stay in the app, go to Dashboard
    this.initBackButtonTrap();
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

  async initCameraPermission() {
    // If we already warmed up the permission, skip
    if (localStorage.getItem('cn_camera_ok')) return;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
      var stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      stream.getTracks().forEach(function(t) { t.stop(); });
      localStorage.setItem('cn_camera_ok', '1');
      console.log('Camera permission pre-warmed');
    } catch(e) {
      // Permission denied or no camera — will prompt again when scanner is used
      console.log('Camera pre-warm skipped:', e.message);
    }
  },

  initBackButtonTrap() {
    var self = this;
    window.addEventListener('popstate', function() {
      if (currentUser) {
        // Re-push a state so the Back button keeps working inside the app
        try { window.history.pushState({ cnApp: true }, ''); } catch(e) {}
        // If not on the dashboard, go back to the dashboard
        var dashEl = document.getElementById('view-dashboard');
        if (dashEl && !dashEl.classList.contains('active')) {
          self.navigate('dashboard');
        }
      }
    });
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
    localStorage.removeItem('cn_camera_ok');
    // 4. Do NOT set cn_app_version here — on reload, the fresh app.js
    //    will have the new APP_VERSION, and checkVersion() will record it
    //    as a first-install. This prevents an infinite reload loop.
    // 5. Hard reload (bypass cache)
    window.location.reload();
  },

  async seedDefaults() {
    // Seed ONLY when the cloud database is verifiably empty. If the network
    // is unavailable, skip seeding entirely — seeding on a network error
    // would resurrect users and categories the admin deleted.
    var users, cats, events;
    try {
      users = await dbGetAll('users');
      cats = await dbGetAll('categories');
      events = await dbGetAll('events');
    } catch (e) {
      console.warn('seedDefaults skipped — cloud unreachable:', e.message);
      return;
    }
    if (users.length === 0) {
      await dbPut('users', { id: 'u-admin', name: 'CircuitNet', username: 'admin', password: 'admin123', role: 'admin', active: true, canExport: true, created: new Date().toISOString() });
      await dbPut('users', { id: 'u-sales1', name: 'Rajesh Kumar', username: 'rajesh', password: 'pass123', role: 'salesperson', active: true, canExport: false, created: new Date().toISOString() });
      await dbPut('users', { id: 'u-sales2', name: 'Priya Sharma', username: 'priya', password: 'pass123', role: 'salesperson', active: true, canExport: false, created: new Date().toISOString() });
      await dbPut('users', { id: 'u-sales3', name: 'Arun Menon', username: 'arun', password: 'pass123', role: 'salesperson', active: true, canExport: false, created: new Date().toISOString() });
    }
    // Seed default categories ONLY on first install (when the store is empty).
    // We intentionally do NOT re-add categories the admin has deleted, so
    // deletions survive app restarts and version updates.
    if (cats.length === 0) {
      for (const c of DEFAULT_CATEGORIES) {
        await dbPut('categories', { id: 'cat-' + Date.now() + '-' + Math.random().toString(36).slice(2,8), name: c, active: true });
      }
    }
    // Clean up duplicate categories (keep first occurrence of each name)
    await this.dedupCategories();
    // Seed default event
    if (events.length === 0) {
      await dbPut('events', { id: 'evt-1', name: 'Electronica 2026', venue: 'BIEC Bengaluru, Hall 3, Stall D15', startDate: '2026-09-08', endDate: '2026-09-10', date: '2026-09-08', active: true, created: new Date().toISOString() });
    }
  },

  async dedupCategories() {
    var cats = await dbGetAll('categories');
    var seen = {};
    var dupes = [];
    for (var i = 0; i < cats.length; i++) {
      var key = (cats[i].name || '').toLowerCase();
      if (seen[key]) {
        dupes.push(cats[i].id);
      } else {
        seen[key] = true;
      }
    }
    for (var i = 0; i < dupes.length; i++) {
      await dbDelete('categories', dupes[i]);
      // Also delete from cloud
      try { await Cloud.deleteRow('categories', dupes[i]); } catch(e) {}
    }
    if (dupes.length > 0) {
      console.log('Cleaned up ' + dupes.length + ' duplicate categories');
      Cloud.log('🧹 Cleaned up ' + dupes.length + ' duplicate categories');
    }
  },

  async loadSettings() {
    var s = null;
    try { s = await dbGet('settings', 'app'); }
    catch (e) { console.warn('loadSettings: cloud unreachable, using defaults'); }
    App.settings = s ? s.value : {
      companyName: 'CircuitNet Technologies',
      eventName: 'Electronica 2026',
      venue: 'BIEC Bengaluru, Hall 3, Stall D15',
      leadSource: 'Electronica 2026'
    };
    if (!App.settings.userRoles) App.settings.userRoles = ['admin','salesperson'];
    // Ensure OCR key is set (default if not already in settings)
    if (!App.settings.ocrApiKey) App.settings.ocrApiKey = 'K88604395188957';
    // Load current event from localStorage or settings.defaultEventId
    var savedEvent = localStorage.getItem('cn_current_event');
    if (savedEvent) {
      App.currentEvent = JSON.parse(savedEvent);
    } else {
      var events = [];
      try { events = await dbGetAll('events'); } catch(e2) {}
      // If admin set a default event, use it
      if (App.settings.defaultEventId) {
        var defEvt = null;
        for (var i = 0; i < events.length; i++) {
          if (events[i].id === App.settings.defaultEventId) { defEvt = events[i]; break; }
        }
        if (defEvt) {
          App.currentEvent = { id: defEvt.id, name: defEvt.name };
        } else if (events.length > 0) {
          App.currentEvent = { id: events[0].id, name: events[0].name };
        } else {
          App.currentEvent = { id: 'evt-1', name: 'Electronica 2026' };
        }
        localStorage.setItem('cn_current_event', JSON.stringify(App.currentEvent));
      } else if (events.length > 0) {
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
    App.updateEventDisplay();
    var sel = document.getElementById('eventSelector');
    if (sel) sel.value = eventId;
    var dispEl = document.getElementById('eventDisplayText');
    if (dispEl) dispEl.textContent = evt.name;
    Dashboard.render();
    Leads.render();
    App.toast('Event: ' + evt.name, 'success');
  },

  async setDefaultEvent(eventId) {
    var evt = await dbGet('events', eventId);
    if (!evt) return;
    App.currentEvent = { id: evt.id, name: evt.name };
    localStorage.setItem('cn_current_event', JSON.stringify(App.currentEvent));
    App.settings.defaultEventId = eventId;
    await App.touchAndSaveSettings();
    App.updateEventDisplay();
    var sel = document.getElementById('eventSelector');
    if (sel) sel.value = eventId;
    var dispEl = document.getElementById('eventDisplayText');
    if (dispEl) dispEl.textContent = evt.name;
    Dashboard.render();
    Leads.render();
    App.toast('Default event set: ' + evt.name, 'success');
    Cloud.syncUpAdmin();
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
    var role = document.getElementById('loginRole').value;
    var errEl = document.getElementById('loginError');
    errEl.textContent = '';
    if (!username) { errEl.textContent = 'Enter username'; return; }
    // Look up user by username (case-insensitive)
    var users = [];
    try { users = await dbGetAll('users'); }
    catch (e) { errEl.textContent = 'Network error — check your connection and try again'; return; }
    var user = users.find(function(u){ return u.username && u.username.toLowerCase() === username.toLowerCase() && u.active; });
    if (!user) { errEl.textContent = 'Invalid User ID or password'; return; }
    if (user.password !== pass) { errEl.textContent = 'Invalid User ID or password'; return; }
    // If admin role selected, verify user is actually an admin
    if (role === 'admin' && user.role !== 'admin') {
      errEl.textContent = 'This user does not have admin access'; return;
    }
    currentUser = user;
    localStorage.setItem('cn_user', JSON.stringify(user));
    this.showApp();
    this.toast('Welcome, ' + user.name + (user.role === 'admin' ? ' (Admin)' : ''), 'success');
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
    if (html5QrCode) { try { html5QrCode.stop(); } catch(e){} }
    if (Scanner.scanning) Scanner.scanning = false;
    document.getElementById('appScreen').style.display = 'none';
    document.getElementById('loginScreen').style.display = 'flex';
    var lp = document.getElementById('loginPass'); if (lp) lp.value = '';
    var lap = document.getElementById('loginAdminPass'); if (lap) lap.value = '';
  },

  showProfileModal() {
    var u = currentUser;
    if (!u) return;
    document.getElementById('modalContent').innerHTML = `
      <div class="modal-head">
        <h3>👤 My Profile</h3>
        <button class="modal-close" onclick="Admin.closeModal()">×</button>
      </div>
      <div class="modal-body">
        <div class="form-group"><label>Name</label><input type="text" id="mp_name" value="${esc(u.name||'')}" readonly style="background:#f0f0f0"><div style="font-size:11px;color:#999;margin-top:3px">Display name — set by admin</div></div>
        <div class="form-group"><label>User ID</label><input type="text" id="mp_username" value="${esc(u.username||'')}" placeholder="Enter new User ID"></div>
        <div class="form-group"><label>New Password</label><input type="text" id="mp_password" value="${esc(u.password||'')}" placeholder="Enter new password"></div>
        <div class="form-group"><label>Role</label><input type="text" value="${esc(u.role.charAt(0).toUpperCase()+u.role.slice(1))}" readonly style="background:#f0f0f0"></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-outline" style="flex:1" onclick="Admin.closeModal()">Cancel</button>
        <button class="btn btn-primary" style="flex:1" onclick="App.saveProfile()">Save</button>
      </div>
    `;
    document.getElementById('modalOverlay').classList.add('open');
  },

  async saveProfile() {
    var username = document.getElementById('mp_username').value.trim();
    var password = document.getElementById('mp_password').value.trim();
    if (!username || !password) { App.toast('User ID and password are required', 'error'); return; }
    var uname = username.toLowerCase();
    // Uniqueness check against local users
    var users = await dbGetAll('users');
    if (users.some(function(u){ return (u.username||'').toLowerCase() === uname && u.id !== currentUser.id; })) {
      App.toast('User ID already exists — choose a different ID', 'error'); return;
    }
    // Also check cloud users (another device may have taken this ID)
    if (navigator.onLine) {
      try {
        var cloudUsers = await Cloud.fetchAll('users');
        for (var i = 0; i < cloudUsers.length; i++) {
          if ((cloudUsers[i].username||'').toLowerCase() === uname && cloudUsers[i].id !== currentUser.id) {
            App.toast('User ID already exists — choose a different ID', 'error'); return;
          }
        }
      } catch(e) { /* offline — local check only */ }
    }
    currentUser.username = username;
    currentUser.password = password;
    currentUser.updatedAt = new Date().toISOString();
    await dbPut('users', currentUser);
    localStorage.setItem('cn_user', JSON.stringify(currentUser));
    Admin.closeModal();
    document.getElementById('drawerUserName').textContent = currentUser.name;
    document.getElementById('drawerUserRole').textContent = currentUser.role === 'admin' ? 'Admin' : currentUser.role.charAt(0).toUpperCase() + currentUser.role.slice(1);
    document.getElementById('hdrAvatar').textContent = currentUser.name.charAt(0).toUpperCase();
    App.toast('Profile updated and synced to cloud', 'success');
    Cloud.syncUpUser(currentUser);
  },

  showApp() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appScreen').style.display = 'block';
    // Keep a history state so the browser Back button stays inside the app
    try { window.history.pushState({ cnApp: true }, ''); } catch(e) {}
    document.getElementById('drawerUserName').textContent = currentUser.name;
    document.getElementById('drawerUserRole').textContent = currentUser.role.replace(/\b\w/g, function(c){ return c.toUpperCase(); });
    document.getElementById('hdrAvatar').textContent = currentUser.name.charAt(0).toUpperCase();
    // Show/hide admin items
    const adminItems = document.querySelectorAll('.admin-only');
    adminItems.forEach(el => el.style.display = currentUser.role === 'admin' ? '' : 'none');
    // Update dynamic event name in drawer
    this.updateEventDisplay();
    var vEl = document.getElementById('drawerVersion');
    if (vEl) vEl.textContent = 'Version: ' + APP_VERSION;
    // Event selector: admin gets dropdown, non-admin gets read-only display
    var evSelWrap = document.getElementById('eventSelectorWrap');
    var evDispWrap = document.getElementById('eventDisplayWrap');
    if (currentUser.role === 'admin') {
      if (evSelWrap) evSelWrap.style.display = '';
      if (evDispWrap) evDispWrap.style.display = 'none';
      this.populateEventSelector();
    } else {
      if (evSelWrap) evSelWrap.style.display = 'none';
      if (evDispWrap) evDispWrap.style.display = '';
      var dispEl = document.getElementById('eventDisplayText');
      if (dispEl) dispEl.textContent = (App.currentEvent && App.currentEvent.name) ? App.currentEvent.name : (App.settings.eventName || 'Electronica 2026');
    }
    this.navigate('dashboard');
    Dashboard.render();
    this.updateSyncBadge();
  },

  updateEventDisplay() {
    var evtName = (App.currentEvent && App.currentEvent.name) ? App.currentEvent.name : (App.settings.eventName || 'Electronica 2026');
    var venue = (App.settings.venue || 'BIEC Bengaluru, Hall 3, Stall D15');
    var dEl = document.getElementById('drawerEventName');
    if (dEl) dEl.textContent = evtName + ' · ' + venue;
    var lEl = document.getElementById('loginEventTag');
    if (lEl) lEl.textContent = evtName.toUpperCase() + ' · ' + venue.toUpperCase();
  },

  getDropdownOptions(key) {
    var dd = App.settings.dropdownOptions;
    if (!dd) return null;
    var val = dd[key];
    if (!val) return null;
    // Parse newline-separated text into array
    var arr = val.split('\n').map(function(s){ return s.trim(); }).filter(function(s){ return s.length > 0; });
    return arr.length > 0 ? arr : null;
  },

  getPriorities() {
    return App.getDropdownOptions('priorities') || DEFAULT_PRIORITIES;
  },

  priorityColor(priority) {
    var pr = App.getPriorities();
    var idx = pr.indexOf(priority);
    var colors = ['var(--hot)', 'var(--warm)', 'var(--cold)'];
    if (idx >= 0 && idx < 3) return colors[idx];
    return '#adb5bd';
  },

  priorityStyle(priority) {
    var pr = App.getPriorities();
    var idx = pr.indexOf(priority);
    var bgs = ['#f8d7da', '#fff3cd', '#cfe2ff'];
    var fgs = ['#dc3545', '#fd7e14', '#0d6efd'];
    if (idx >= 0 && idx < 3) return 'background:' + bgs[idx] + ';color:' + fgs[idx];
    return 'background:#e2e3e5;color:#6c757d';
  },

  async touchAndSaveSettings() {
    App.settings.settingsUpdatedAt = Date.now();
    var sRow = { key: 'app', value: App.settings };
    await dbPut('settings', sRow);
  },

  async navigate(view) {
    // Block export access for users without permission — BEFORE switching view
    if (view === 'export' && currentUser && currentUser.role !== 'admin' && !currentUser.canExport) {
      App.toast('Contact your admin for exporting data', 'error');
      return;
    }
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
    else if (view === 'export') {
      Export.init();
    }
    else if (view === 'trash') Leads.renderTrash();
    else if (view === 'users') Admin.renderUsers();
    else if (view === 'events') Admin.renderEvents();
    else if (view === 'categories') Admin.renderCategories();
    else if (view === 'settings') Admin.renderSettings();
    else if (view === 'datasync') { /* rendered via HTML */ }
    else if (view === 'about') { var avEl = document.getElementById('aboutVersion'); if (avEl) avEl.textContent = APP_VERSION; }
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
      badge.className = 'sync-badge sync-online';
      text.textContent = 'Cloud';
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
    // Capture the camera frame FIRST (before stopping) so we can also
    // OCR any text printed on the badge alongside the QR/barcode
    var frameCanvas = this.captureFrame();

    // Stop scanning to process
    await this.stop();

    document.getElementById('scanStatus').textContent = '✓ Badge scanned! Parsing data...';

    // Parse the scanned data
    const result = Parser.parse(decodedText);
    const fields = result.fields;

    // Read printed text on the badge (name, company...) and merge it in.
    // Data from the QR code always wins over OCR text.
    if (frameCanvas && navigator.onLine) {
      try {
        document.getElementById('scanStatus').textContent = '✓ Badge scanned! Reading badge text...';
        var ocrText = await this.ocrFrame(frameCanvas);
        if (ocrText && ocrText.trim()) {
          var textFields = CardScanner.parseCardText(ocrText);
          ['name','company','designation','email','phone'].forEach(function(k) {
            if (!fields[k] && textFields[k]) fields[k] = textFields[k];
          });
        }
      } catch(e) {
        console.warn('Badge text OCR failed:', e);
      }
    }

    // Check for duplicates
    const dup = await this.checkDuplicate(fields);

    // Show parsed result
    this.showResult(decodedText, fields, dup);

    // Auto-fill the manual form with parsed data
    ManualForm.prefillFromScan(decodedText, fields, dup);
  },

  /** Grab the current camera frame from the scanner video element. */
  captureFrame() {
    try {
      var video = document.querySelector('#qrReader video');
      if (!video || !video.videoWidth) return null;
      var canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      return canvas;
    } catch(e) {
      return null;
    }
  },

  /** OCR a captured frame via OCR.space — with a timeout so the badge
   *  scan never stalls if the network is slow. */
  ocrFrame(canvas) {
    var apiKey = (App.settings && App.settings.ocrApiKey) ? App.settings.ocrApiKey : '';
    if (!apiKey) return Promise.resolve(null);
    return new Promise(function(resolve) {
      var settled = false;
      var done = function(v) { if (!settled) { settled = true; resolve(v); } };
      setTimeout(function() { done(null); }, 8000);
      try {
        canvas.toBlob(function(blob) {
          if (!blob) { done(null); return; }
          var formData = new FormData();
          formData.append('apikey', apiKey);
          formData.append('file', blob, 'badge-frame.jpg');
          formData.append('language', 'eng');
          formData.append('isOverlayRequired', 'false');
          formData.append('scale', 'true');
          formData.append('OCREngine', '2');
          fetch('https://api.ocr.space/parse/image', { method: 'POST', body: formData })
            .then(function(r) { return r.json(); })
            .then(function(data) {
              if (data && !data.IsErroredOnProcessing && data.ParsedResults && data.ParsedResults.length > 0) {
                done((data.ParsedResults[0].ParsedText || '').trim());
              } else {
                done(null);
              }
            })
            .catch(function() { done(null); });
        }, 'image/jpeg', 0.9);
      } catch(e) {
        done(null);
      }
    });
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

  // Captured card images awaiting the user's choice (front, and optionally back)
  pendingFiles: [],
  isBackSide: false,
  fromGallery: false,

  /** Ensure the picked image is decodable by this browser. If not
   *  (e.g. HEIC photos from some phones), convert it to JPEG via heic2any. */
  async normalizeImageFile(file) {
    if (!file) return file;
    var decodable = false;
    if (window.createImageBitmap) {
      try {
        var bmp = await createImageBitmap(file);
        if (bmp && bmp.close) bmp.close();
        decodable = true;
      } catch(e) {}
    } else {
      decodable = true; // cannot test — let later stages handle it
    }
    if (decodable) return file;
    // Browser cannot decode it — try HEIC/HEIF conversion
    try {
      if (typeof heic2any === 'undefined') {
        await this.loadScript('https://cdn.jsdelivr.net/npm/heic2any/dist/heic2any.min.js');
      }
      if (typeof heic2any === 'function') {
        var out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
        if (Array.isArray(out)) out = out[0];
        if (out && out.size > 0) {
          try {
            out = new File([out], (file.name || 'card').replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
          } catch(e2) {}
          return out;
        }
      }
    } catch(e) {
      console.warn('HEIC conversion failed:', e);
    }
    return file;
  },

  async scanFromFile(file) {
    if (!file) return;
    App.toggleDrawer(false);
    // Stop live camera scanner if running (scanFile can conflict with it)
    if (Scanner.scanning) { try { await Scanner.stop(); } catch(e){} }
    // First try QR/barcode decode (fast, offline) — badge images still work
    try {
      var ts = html5QrCode || new Html5Qrcode('qrReader');
      var qrResult = await ts.scanFile(file, false);
      await Scanner.onScan(qrResult);
      return;
    } catch(e) {
      // No QR/barcode found — treat as a visiting card photo
    }
    this.scan(file, true);
  },

  async scan(file, fromGallery) {
    if (!file) return;
    App.toggleDrawer(false);
    this.fromGallery = !!fromGallery;
    file = await this.normalizeImageFile(file);
    var url = URL.createObjectURL(file);
    if (this.isBackSide) {
      if (this.pendingFiles[1] && this.pendingFiles[1].url) { try { URL.revokeObjectURL(this.pendingFiles[1].url); } catch(e){} }
      this.pendingFiles[1] = { file: file, url: url };
    } else {
      this.clearPending();
      this.pendingFiles[0] = { file: file, url: url };
    }
    this.showCapturePreview();
  },

  clearPending() {
    if (this.pendingFiles) {
      this.pendingFiles.forEach(function(p){ if (p && p.url) { try { URL.revokeObjectURL(p.url); } catch(e){} } });
    }
    this.pendingFiles = [];
  },

  showCapturePreview() {
    var self = this;
    var existing = document.getElementById('cardCaptureScreen');
    if (existing) existing.remove();

    var front = this.pendingFiles[0];
    var back = this.pendingFiles[1];
    var hasBack = !!back;
    var sideLabel = hasBack ? 'Back side captured — review' : 'Front side captured — review';

    var previewHtml = '';
    if (front) previewHtml += '<div style="font-size:11px;color:#888;margin-bottom:4px">FRONT</div><img src="' + front.url + '" style="max-width:100%;max-height:30vh;border-radius:10px;margin-bottom:10px;border:2px solid #333;object-fit:contain">';
    if (back) previewHtml += '<div style="font-size:11px;color:#888;margin-bottom:4px">BACK</div><img src="' + back.url + '" style="max-width:100%;max-height:30vh;border-radius:10px;margin-bottom:10px;border:2px solid #333;object-fit:contain">';

    var pickMode = this.fromGallery;
    var retakeLabel = pickMode ? '🔄 Choose Again' : '🔄 Retake';
    var otherSideLabel = pickMode ? '🖼️ Add Other Side' : '📷 Take Other Side';
    var overlay = document.createElement('div');
    overlay.id = 'cardCaptureScreen';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.94);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;padding:20px;overflow-y:auto';
    overlay.innerHTML =
      '<div style="font-size:40px;margin-bottom:6px">🪪</div>' +
      '<div style="font-size:17px;font-weight:600;margin-bottom:4px">' + sideLabel + '</div>' +
      '<div style="font-size:12px;color:#888;margin-bottom:10px">Review the photo. Tap “Finish” to process it, or capture the other side.</div>' +
      '<div style="width:100%;max-width:340px">' + previewHtml + '</div>' +
      '<div style="display:flex;flex-direction:column;gap:10px;width:100%;max-width:340px;margin-top:6px">' +
        '<button id="ccBtnRetake" style="padding:14px;border:2px solid #555;background:transparent;color:#fff;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer">' + retakeLabel + (hasBack && !pickMode ? ' Back' : '') + '</button>' +
        (hasBack ? '' : '<button id="ccBtnOtherSide" style="padding:14px;border:2px solid #0d6efd;background:transparent;color:#0d6efd;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer">' + otherSideLabel + '</button>') +
        '<button id="ccBtnFinish" style="padding:14px;border:none;background:#0d6efd;color:#fff;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer">✅ Finish</button>' +
      '</div>';
    document.body.appendChild(overlay);

    document.getElementById('ccBtnRetake').onclick = function() {
      overlay.remove();
      if (hasBack) {
        if (back && back.url) URL.revokeObjectURL(back.url);
        self.pendingFiles[1] = null;
        self.isBackSide = true;
      } else {
        self.clearPending();
        self.isBackSide = false;
      }
      var input = document.getElementById(self.fromGallery ? 'scanFileInput' : 'cardScanInput');
      if (input) input.click();
    };
    if (!hasBack) {
      document.getElementById('ccBtnOtherSide').onclick = function() {
        overlay.remove();
        self.isBackSide = true;
        var input = document.getElementById(self.fromGallery ? 'scanFileInput' : 'cardScanInput');
        if (input) input.click();
      };
    }
    document.getElementById('ccBtnFinish').onclick = function() {
      overlay.remove();
      var files = self.pendingFiles.filter(function(p){ return p && p.file; }).map(function(p){ return p.file; });
      self.isBackSide = false;
      self.processImages(files);
    };
  },

  async processImages(files) {
    if (this.isProcessing) return;
    this.isProcessing = true;

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
      var combinedRaw = '';
      var usedApi = false;
      for (var i = 0; i < files.length; i++) {
        statusEl.textContent = 'Scanning side ' + (i + 1) + ' of ' + files.length + '...';
        var res = await self.ocrImage(files[i], statusEl, progEl, i, files.length);
        if (res.rawText) {
          if (combinedRaw) combinedRaw += String.fromCharCode(10) + '--- BACK SIDE ---' + String.fromCharCode(10);
          combinedRaw += res.rawText;
          if (res.usedApi) usedApi = true;
        }
      }

      var fields = self.parseCardText(combinedRaw);
      fields.rawBadgeData = combinedRaw;
      fields.ocrSource = usedApi ? 'OCR.space' : (combinedRaw ? 'Tesseract (offline)' : 'No OCR');

      overlay.remove();

      if (!combinedRaw.trim()) {
        App.toast('No text could be read from the card — please retake or enter manually', 'error');
        self.clearPending();
        return;
      }

      self.clearPending();
      self.showExtractedData(fields, combinedRaw);

    } catch (e) {
      console.error('Card scan error:', e);
      overlay.remove();
      var failMsg = (e.message && e.message.indexOf('Failed to load image') === 0)
        ? 'Could not read this image on this device — try the Scan Visiting Card camera option, or a different photo'
        : 'Card scan failed: ' + e.message;
      App.toast(failMsg, 'error');
    } finally {
      this.isProcessing = false;
    }
  },

  async ocrImage(file, statusEl, progEl, index, total) {
    var apiKey = (App.settings && App.settings.ocrApiKey) ? App.settings.ocrApiKey : '';
    var rawText = '';
    var usedApi = false;

    if (apiKey) {
      try {
        statusEl.textContent = 'Uploading side ' + (index + 1) + ' to OCR.space...';
        progEl.style.width = '30%';
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
        var response = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: formData });
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
    return { rawText: rawText, usedApi: usedApi };
  },

  /**
   * Compress image to under 1MB for OCR.space free tier limit
   * Resizes and converts to JPEG with quality adjustment
   */
  /** Decode an image file robustly: createImageBitmap first (better
   *  format and memory handling on phones), Image element as fallback. */
  loadImageFile(file) {
    return new Promise(function(resolve, reject) {
      var tryImgElement = function() {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function() { resolve(img); };
        img.onerror = function() { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
        img.src = url;
      };
      if (window.createImageBitmap) {
        createImageBitmap(file, { imageOrientation: 'from-image' }).then(function(bmp) {
          resolve(bmp);
        }).catch(function() {
          // Older browsers may reject the options — retry plain
          createImageBitmap(file).then(function(bmp) {
            resolve(bmp);
          }).catch(function() {
            tryImgElement();
          });
        });
      } else {
        tryImgElement();
      }
    });
  },

  compressImage(file) {
    var self = this;
    return self.loadImageFile(file).then(function(img) {
      return new Promise(function(resolve) {
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
      });
    });
  },

  /**
   * Preprocess image for Tesseract fallback (offline mode)
   */
  preprocessImage(file) {
    var self = this;
    return self.loadImageFile(file).then(function(img) {
      return new Promise(function(resolve) {
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
      });
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

  /**
   * PARSER RULES — what info goes to which field:
   *
   * EMAIL:      Line containing '@' and '.com/.org/.net/etc.' — always full email
   * PHONE:      Line starting with T:/Tel:/Telephone:/Mob:/Mobile:/Ph: → extract digits
   *             OR any line with +91 followed by 8-12 digits
   *             OR standalone 10-digit number starting 6-9
   * WEBSITE:    Line starting with 'www.' or 'http' → take first URL (split by |)
   *             OR line starting with W:/Web:/Website: → take value after label
   * DESIGNATION: First unused line (no @, no digits) containing keywords:
   *             Manager, Director, CEO, Analyst, Engineer, Consultant, Supply Chain, etc.
   *             Max 60 chars. Strip leading non-alpha chars.
   * COMPANY:    Lines containing: Ltd, Limited, Pvt, Technologies, Solutions, Systems,
   *             Enterprises, Industries, Electronics, etc. Merge adjacent company lines.
   *             Skip parenthetical lines like (A Division of...). Pick longest candidate.
   * NAME:       First unused line with 2-4 words, all alphabetic, Title Case
   *             (each word starts uppercase). Skip if contains company keywords.
   *             Skip lines with digits, |, -, #, @, :.
   * CITY:       Word-boundary match against list of 54 Indian cities
   * COUNTRY:    Word-boundary match for 'India', 'USA', 'Singapore', etc.
   */
  parseCardText(text) {
    var cleaned = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/~/g, '').replace(/\n{3,}/g, '\n\n').trim();
    var lines = cleaned.split(/\n/).map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 1; });
    // Keep lines with useful content
    lines = lines.filter(function(l) {
      if (/^(Telephone|Mob|Mobile|Cell|Phone|Tel|Email|E-mail|Mail|Website|URL|Web|Site|Fax|Address|Office|Registered|Branch|Corporate|LinkedIn|Linkedin|Ph|P|M|T|E|W|Pin|ZIP|Postal)\s*[:\-.]/i.test(l)) return true;
      if (l.indexOf('@') >= 0) return true;
      if (l.match(/\d{10,}/)) return true;
      if (l.match(/\+\d{1,3}[-\s]?\d{5,}/)) return true;
      if (/^www\./i.test(l) || /^https?:\/\//i.test(l)) return true;
      if (/linkedin\.com/i.test(l)) return true;
      if (/[\u2600-\u27BF\u2300-\u23FF\u25A0-\u25FF\u2B00-\u2BFF]/.test(l)) return true; // symbols
      var letterCount = (l.match(/[a-zA-Z]/g) || []).length;
      if (letterCount < 2) return false;
      if (letterCount / l.length < 0.35) return false;
      return true;
    });

    var fields = {};
    var usedLines = {};
    function hasKeyword(line, keywords) {
      var u = line.toUpperCase();
      for (var i = 0; i < keywords.length; i++) {
        var kw = keywords[i].toUpperCase();
        if (kw.length <= 4) {
          // Word-boundary match for short keywords (HR, MD, VP, CEO, R&D...)
          // so a name like "Shreya" does not match "HR" hidden inside it
          var kwRe = new RegExp('\\b' + kw + '\\b');
          if (kwRe.test(u)) return true;
        } else if (u.indexOf(kw) >= 0) return true;
      }
      return false;
    }
    function markUsed(idx) { usedLines[idx] = true; }
    function isUsedIdx(idx) { return !!usedLines[idx]; }

    // Check if a line is a known ID (GSTIN, PAN, CIN) that should not be treated as phone
    function isIdNumber(line) {
      var digits = line.replace(/\D/g, '');
      // GSTIN: 15 digits, pattern 2 digits + 5 letters + 4 digits + 1 letter + 1 alphanumeric + 1 digit
      if (/\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z]\d/i.test(line)) return true;
      // PAN: 5 letters + 4 digits + 1 letter
      if (/[A-Z]{5}\d{4}[A-Z]/i.test(line) && line.replace(/\s/g,'').length <= 10) return true;
      // CIN: 21 characters starting with U
      if (/^U\d{20}/.test(line.replace(/\s/g,''))) return true;
      // Employee ID patterns: EMP followed by digits
      if (/^EMP/i.test(line) || /^EID/i.test(line)) return true;
      return false;
    }

    function isExcluded(line) {
      if (line.indexOf('@') >= 0) return true;
      if (line.match(/\+\d{5,}/)) return true;
      if (line.match(/\d{10,}/)) return true;
      if (/^www\./i.test(line) || /^https?:\/\//i.test(line)) return true;
      if (/linkedin\.com/i.test(line)) return true;
      if (isIdNumber(line)) return true;
      return false;
    }

    // Helper: normalize phone number (remove spaces, hyphens, brackets for comparison)
    function normalizePhone(num) {
      return num.replace(/[\s\-()]/g, '');
    }

    // === EMAIL RULE ===
    // Labels: Email, E-mail, Mail, E:, Email Id, Electronic Mail
    // Must contain @, valid domain, valid extension
    // Fix OCR errors: .corn→.com, spaces around @, remove trailing punctuation
    // Support multiple emails
    var allEmails = [];
    for (var i = 0; i < lines.length; i++) {
      if (isUsedIdx(i)) continue;
      // Check labeled email lines first
      var emLabel = lines[i].match(/^(?:Email|E-mail|Mail|E)\s*[:\-]\s*(.+)/i);
      if (emLabel && emLabel[1]) {
        var em = emLabel[1].match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (em) {
          var email = em[0].replace(/\.corn$/i, '.com').replace(/\s+/g, '').replace(/[;,\s]+$/, '').toLowerCase();
          allEmails.push(email);
          markUsed(i);
          continue;
        }
      }
      // Raw email anywhere in line
      var ems = lines[i].match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
      if (ems) {
        ems.forEach(function(e) {
          allEmails.push(e.replace(/\.corn$/i, '.com').replace(/\s+/g, '').replace(/[;,\s]+$/, '').toLowerCase());
        });
        markUsed(i);
      }
    }
    if (allEmails.length > 0) {
      fields.email = allEmails[0];
      if (allEmails[1]) fields.email2 = allEmails[1];
    }

    // === PHONE/MOBILE/TELEPHONE RULE ===
    // Mobile labels: Mob, Mobile, M, Cell, WhatsApp, Whatsapp, Wa, M:
    // Telephone labels: Tel, Telephone, Phone, Ph, T, Landline, Office, O, T:, Ph:, D:
    // Symbols: 📞 ☎ 📱 (OCR may render these as text)
    // Exclude: PIN codes (6 digits 5XXXXX), GSTIN (15 digits), PAN (10 alphanumeric), CIN (21 chars), employee IDs
    // Normalize: remove spaces/hyphens/brackets for stored comparison, preserve original display value
    // Support +91, international numbers, 7-15 digits
    var allPhones = [];
    var seenPhoneDigits = {};
    function addPhone(num, isMobile) {
      var orig = num.trim();
      var digits = orig.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) return;
      // Exclude PIN codes (6 digits starting with 5-8)
      if (digits.length === 6 && /^[5-8]\d{5}$/.test(digits)) return;
      // Exclude GSTIN (15 digits that match GSTIN pattern)
      if (digits.length === 15) return;
      // Exclude CIN (starts with U + 20 digits)
      if (digits.length === 21 && orig.charAt(0) === 'U') return;
      // Dedup
      if (seenPhoneDigits[digits]) return;
      seenPhoneDigits[digits] = true;
      allPhones.push({ num: orig, isMobile: isMobile, digits: digits });
    }
    // First pass: labeled phones
    for (var i = 0; i < lines.length; i++) {
      if (isUsedIdx(i)) continue;
      if (isIdNumber(lines[i])) continue;
      // Mobile labels: Mob, Mobile, M, Cell, WhatsApp, Whatsapp, Wa
      var lm = lines[i].match(/^(?:Mob(?:ile)?|Cell|M|WhatsApp|Whatsapp|Wa)\s*[:\-.]?\s*(.+)/i);
      if (lm && lm[1]) {
        var pc = lm[1].match(/\+?[\d\s\-().]{8,}/);
        if (pc) { addPhone(pc[0], true); markUsed(i); continue; }
      }
      // Telephone labels: Tel, Telephone, Phone, Ph, T, Landline, Office, O, D (Direct)
      lm = lines[i].match(/^(?:Telephone|Tel|Phone|Ph|T|Landline|Office|O|D|Direct)\s*[:\-.]\s*(.+)/i);
      if (lm && lm[1]) {
        var pc = lm[1].match(/\+?[\d\s\-().]{8,}/);
        if (pc) { addPhone(pc[0], false); markUsed(i); continue; }
      }
      // Symbol-prefixed: 📞 ☎ 📱 followed by digits
      if (/^[📞☎📱]\s*(.+)/.test(lines[i])) {
        var sm = lines[i].match(/^[📞☎📱]\s*(.+)/);
        if (sm && sm[1]) {
          var pc = sm[1].match(/\+?[\d\s\-().]{8,}/);
          if (pc) { addPhone(pc[0], /📱/.test(lines[i])); markUsed(i); continue; }
        }
      }
    }
    // Second pass: raw phone numbers (unlabeled)
    for (var i = 0; i < lines.length; i++) {
      if (isUsedIdx(i)) continue;
      if (isIdNumber(lines[i])) continue;
      // +91 with flexible grouping
      var matches = lines[i].match(/\+91[\s-]?\d{2,4}[\s-]?\d{3,5}[\s-]?\d{2,5}/g);
      if (matches) { matches.forEach(function(m){ addPhone(m, true); }); continue; }
      // International +XX
      matches = lines[i].match(/\+\d{1,3}[\s-]?\d{2,4}[\s-]?\d{3,5}[\s-]?\d{2,5}/g);
      if (matches) { matches.forEach(function(m){ addPhone(m, false); }); continue; }
      // 10-digit Indian mobile (6-9 prefix)
      matches = lines[i].match(/\b[6-9]\d{9}\b/g);
      if (matches) { matches.forEach(function(m){ addPhone(m, true); }); continue; }
      // Landline: 0XX-XXXXXXX or 0XXX-XXXXXXX
      matches = lines[i].match(/\b0\d{2,4}[\s-]?\d{6,8}\b/g);
      if (matches) { matches.forEach(function(m){ addPhone(m, false); }); continue; }
      // Generic 7-15 digit with spaces/hyphens
      if (!allPhones.length) {
        matches = lines[i].match(/\b\d{3}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g);
        if (matches) { matches.forEach(function(m){ addPhone(m, false); }); }
      }
    }
    // Third pass: full text scan
    if (allPhones.length === 0) {
      var allText = lines.join(' ');
      var pm = allText.match(/\+91[\s-]?\d{2,4}[\s-]?\d{3,5}[\s-]?\d{2,5}/);
      if (pm) addPhone(pm[0], true);
      pm = allText.match(/\+\d{1,3}[\s-]?\d{2,4}[\s-]?\d{3,5}[\s-]?\d{2,5}/);
      if (pm) addPhone(pm[0], false);
      pm = allText.match(/\b[6-9]\d{9}\b/);
      if (pm) addPhone(pm[0], true);
      pm = allText.match(/\b0\d{2,4}[\s-]?\d{6,8}\b/);
      if (pm) addPhone(pm[0], false);
    }
    // Assign: prefer mobiles first, then landlines
    var mobiles = allPhones.filter(function(p){ return p.isMobile; });
    var landlines = allPhones.filter(function(p){ return !p.isMobile; });
    var ordered = mobiles.concat(landlines);
    if (ordered.length > 0) {
      fields.phone = ordered[0].num;
      if (ordered[1]) fields.phone2 = ordered[1].num;
      if (ordered[2]) fields.phone3 = ordered[2].num;
      if (ordered[3]) fields.phone4 = ordered[3].num;
      if (ordered[4]) fields.phone5 = ordered[4].num;
    }

    // === WEBSITE RULE ===
    // Labels: Website, Web, URL, Site, W:, Web:
    // Symbols: 🌐 🌍 🌏 (globe), 🔗 (link)
    // Patterns: www.xxx, http://, https://, bare domain xxx.com
    // TLDs: .com .in .co.in .net .org .ai .io .biz .co .uk .de .sg .us .eu .au .ca .fr .it .nl .se .ch .jp .cn .kr .tw .hk .ae .br .za .ru .pl .be .at .dk .no .fi .pt .ie .nz .my .th .id .ph .vn .tech .store .online .site .xyz .digital .info .club .design .dev .app .cloud .systems .electronics
    // Exclude: email addresses (contains @)
    // Remove trailing punctuation
    var tldPattern = '(?:com|in|co\\.in|co\\.uk|net|org|ai|io|biz|co|uk|de|sg|us|eu|au|ca|fr|it|nl|se|ch|jp|cn|kr|tw|hk|ae|br|za|ru|pl|be|at|dk|no|fi|pt|ie|nz|my|th|id|ph|vn|tech|store|online|site|xyz|digital|info|club|design|dev|app|cloud|systems|electronics|india|company)';
    for (var i = 0; i < lines.length; i++) {
      if (isUsedIdx(i)) continue;
      // Direct www or http
      if (/^www\./i.test(lines[i]) || /^https?:\/\//i.test(lines[i])) {
        var url = lines[i].split('|')[0].split(/\s+/)[0].replace(/[;,:)\s]+$/, '');
        fields.website = url;
        markUsed(i); break;
      }
    }
    // Labeled website: W:, Web:, Website:, URL:, Site:, 🌐, 🔗
    if (!fields.website) {
      for (var i = 0; i < lines.length; i++) {
        if (isUsedIdx(i)) continue;
        var lm = lines[i].match(/^(?:Website|URL|Web|Site|W)\s*[:\-.]\s*(.+)/i);
        if (lm && lm[1]) {
          var url = lm[1].split('|')[0].split(/\s+/)[0].replace(/[;,:)\s]+$/, '');
          if (url.indexOf('@') < 0 && url.length > 4) { fields.website = url; markUsed(i); break; }
        }
        // Globe/link symbol prefix
        var sym = lines[i].match(/^[🌐🌍🌏🔗]\s*(.+)/);
        if (sym && sym[1]) {
          var url = sym[1].split(/\s+/)[0].replace(/[;,:)\s]+$/, '');
          if (url.indexOf('@') < 0 && url.length > 4) { fields.website = url; markUsed(i); break; }
        }
      }
    }
    // Derive from email domain
    if (!fields.website && fields.email) {
      var domain = fields.email.split('@')[1];
      var freeDomains = ['gmail','yahoo','hotmail','outlook','rediffmail','zoho','protonmail','live','msn','aol','icloud'];
      var isFree = false;
      for (var d = 0; d < freeDomains.length; d++) { if (domain.indexOf(freeDomains[d]) >= 0) { isFree = true; break; } }
      if (!isFree && domain) fields.website = 'www.' + domain;
    }
    // Bare domain detection (company.com without www)
    if (!fields.website) {
      for (var i = 0; i < lines.length; i++) {
        if (isUsedIdx(i)) continue;
        var dm = lines[i].match(new RegExp('\\b([a-z0-9][-a-z0-9]+\\.' + tldPattern + ')\\b', 'i'));
        if (dm && dm[0].indexOf('@') < 0 && dm[0].length > 5 && !isIdNumber(lines[i])) {
          fields.website = 'www.' + dm[0].toLowerCase();
          break;
        }
      }
    }

    // === LINKEDIN RULE ===
    // Labels: LinkedIn, Linkedin, LI:, in:
    // Patterns: linkedin.com/in/xxx, linkedin.com/company/xxx
    // Preserve complete URL, remove trailing punctuation
    for (var i = 0; i < lines.length; i++) {
      if (isUsedIdx(i)) continue;
      if (/linkedin\.com/i.test(lines[i])) {
        fields.linkedin = lines[i].replace(/[;,\s]+$/, '').trim();
        markUsed(i); break;
      }
    }
    if (!fields.linkedin) {
      for (var i = 0; i < lines.length; i++) {
        if (isUsedIdx(i)) continue;
        var lm = lines[i].match(/^(?:LinkedIn|Linkedin|LI)\s*[:\-]\s*(.+)/i);
        if (lm && lm[1]) { fields.linkedin = lm[1].trim().replace(/[;,\s]+$/, ''); markUsed(i); break; }
        // "in" symbol prefix
        if (/^[in]\s*[:\-]\s*(.+)/i.test(lines[i]) && /linkedin/i.test(lines[i])) {
          fields.linkedin = lines[i].trim().replace(/[;,\s]+$/, ''); markUsed(i); break;
        }
      }
    }

    // === DESIGNATION RULE ===
    // Keywords: Director, Managing Director, MD, CEO, CTO, CFO, COO, CIO, VP, Vice President,
    //   President, General Manager, Manager, Senior Manager, Assistant Manager, Engineer,
    //   Senior Engineer, Executive, Senior Executive, Officer, Founder, Co-Founder, Partner,
    //   Proprietor, Owner, Head, Lead, Consultant, Specialist, Architect, Developer,
    //   Coordinator, Supervisor, Principal, Sr, Jr
    // Support abbreviations: MD, CEO, CTO, CFO, COO, CIO, VP, Sr, Jr
    // Support combined: "VP - Sales", "Head of Marketing", "Director & CEO"
    // Support with department: "Manager - Quality", "Head - R&D"
    // Max 80 chars, no @, no 3+ consecutive digits
    var designationKeywords = [
      'Managing Director','General Manager','Vice President','Chief Executive','Chief Technology',
      'Chief Financial','Chief Operating','Chief Information','Business Development',
      'Manager','Director','CEO','CTO','CFO','COO','CIO','MD','Founder','Co-Founder',
      'Proprietor','Owner','Engineer','Consultant','Architect','Designer','Analyst','Specialist',
      'Officer','Executive','President','VP','Head','Lead','Supervisor','Coordinator','Developer',
      'Programmer','Technician','Partner','Principal','Sr.','Senior','Junior','Associate',
      'Assistant','Deputy','Trainee','Intern','Sales','Marketing','Operations','Production',
      'Quality','Purchase','Procurement','R&D','Research','Accounts','Finance','HR',
      'Human Resources','Admin','Administration','Project','Product','Service','Support',
      'Technical','Training','Channel','Regional','National','Global','International',
      'Chairman','Managing Partner','Technical Director','Executive Director','Whole-time Director',
      'Additional Director','Independent Director','Non-Executive','Company Secretary','CFO',
      'Territory Manager','Area Manager','Zonal Manager','National Head','Regional Head',
      'Key Account Manager','Key Accounts','Strategic Accounts','Inside Sales','Field Sales',
      'Pre-Sales','Post-Sales','Customer Success','Customer Experience','Digital Marketing',
      'Brand Manager','Product Manager','Category Manager','Supply Chain','Logistics',
      'Warehouse','Sourcing','Vendor Development','NPD','New Product Development',
      'Embedded','Firmware','Hardware','Software','Testing','Validation','Quality Assurance',
      'Plant Head','Factory Manager','Production Head','Maintenance','Tooling','Process',
      'Industrial','Automation','Robotics','Sustainability','ESG','Compliance','Legal',
      'Treasury','Audit','Tax','Payroll','Procurement Head','Sourcing Head','Export Head',
      'Import','EMEA','APAC','North America','LATAM','Director Sales','Director Operations'
    ];
    for (var i = 0; i < lines.length; i++) {
      if (isUsedIdx(i)) continue;
      if (isExcluded(lines[i])) continue;
      if (lines[i].match(/\d{3,}/)) continue;
      if (hasKeyword(lines[i], designationKeywords) && lines[i].length < 80) {
        fields.designation = lines[i].replace(/^[^a-zA-Z]+/, '').replace(/[|]+/g, ' - ').trim();
        markUsed(i); break;
      }
    }

    // === DEPARTMENT RULE ===
    // Keywords: Sales, Marketing, Business Development, Technical, Engineering, Production,
    //   Manufacturing, Quality, Purchase, Procurement, Operations, Finance, HR, Human Resources,
    //   R&D, Research, Development, Administration, Service, Support, Export, Import
    // Allow abbreviations: BD (Business Dev), Mktg, Ops, HR, Fin, QA, QC, R&D
    // Allow with designation: "Manager - Quality", "Head - R&D"
    var departmentKeywords = ['Sales','Marketing','Business Development','Technical','Engineering',
      'Production','Manufacturing','Quality','Purchase','Procurement','Operations','Finance',
      'HR','Human Resources','R&D','Research','Development','Administration','Service','Support',
      'Export','Import','Quality Assurance','Quality Control','Supply Chain','Logistics',
      'Warehouse','Sourcing','Vendor Development','NPD','New Product Development',
      'Embedded','Firmware','Hardware','Software','Testing','Validation','Maintenance',
      'Tooling','Process','Industrial','Automation','Robotics','Customer Success',
      'Digital Marketing','Inside Sales','Field Sales','Pre-Sales','Post-Sales',
      'Strategic Accounts','Key Accounts','Compliance','Legal','Audit','Tax','Treasury',
      'Sustainability','ESG','BD','Mktg','Ops','QA','QC'];
    for (var i = 0; i < lines.length; i++) {
      if (isUsedIdx(i)) continue;
      if (isExcluded(lines[i])) continue;
      if (hasKeyword(lines[i], departmentKeywords) && lines[i].length < 60) {
        // Skip if it's the designation line
        if (fields.designation && fields.designation.toLowerCase().indexOf(lines[i].toLowerCase()) >= 0) continue;
        // If designation contains " - " with department, extract department
        if (fields.designation) {
          var dashParts = fields.designation.split(/\s[-–]\s/);
          if (dashParts.length > 1) {
            for (var dp = 1; dp < dashParts.length; dp++) {
              if (hasKeyword(dashParts[dp], departmentKeywords)) {
                fields.department = dashParts[dp].trim();
                break;
              }
            }
          }
        }
        if (!fields.department) {
          fields.department = lines[i].replace(/^[^a-zA-Z]+/, '').trim();
          markUsed(i); break;
        } else { break; }
      }
    }
    // Also extract department from designation if it has " - " separator
    if (!fields.department && fields.designation) {
      var dashParts = fields.designation.split(/\s[-–]\s/);
      if (dashParts.length > 1) {
        for (var dp = 1; dp < dashParts.length; dp++) {
          if (hasKeyword(dashParts[dp], departmentKeywords)) {
            fields.department = dashParts[dp].trim();
            fields.designation = dashParts[0].trim();
            break;
          }
        }
      }
    }

    // === COMPANY RULE ===
    // Keywords: Pvt Ltd, Private Limited, Ltd, Limited, LLP, LLC, Inc, Incorporated,
    //   Corporation, Corp, Co, Company, Industries, Technologies, Technology, Electronics,
    //   Engineering, Solutions, Systems, Enterprises, Associates, Group, International,
    //   Services, Labs, Laboratory, Works, Manufacturing, Trading
    // Exclude: person names, designation, email, phone numbers
    // Check email domain, website domain for company name derivation
    var companyKeywords = ['Pvt Ltd','Private Limited','Pvt. Ltd.','Ltd','Limited','LLP','LLC',
      'Inc','Incorporated','Corporation','Corp','Co.','Company','Industries','Technologies',
      'Technology','Electronics','Electricals','Engineering','Solutions','Systems','Enterprises',
      'Associates','Group','International','Services','Labs','Laboratory','Works','Manufacturing',
      'Trading','Motors','Auto','Steel','Power','Energy','Solar','Tex','Spinning',
      'Mills','Foods','Pharma','Healthcare','Hospital','Bank','Financial','Holdings',
      'Machineries','Controls','Components','Automation','Robotics','Electrical',
      'Plastics','Polymers','Rubber','Chemicals','Packaging','Logistics','Infotech',
      'Softwares','Software','Digital','Analytics','Consultancy','Consultants',
      'Constructions','Builders','Developers','Realty','Estates','Properties',
      'Petroleum','Refineries','Minerals','Minerals','Cement','Textiles','Garments',
      'Fashions','Retail','Wholesale','Distributors','Agencies','Traders',
      'Scientific','Instruments','Devices','Medical','Diagnostics','Biotech',
      'Agro','Farms','Foods','Beverages','Breweries','Distilleries'];
    var companyCandidates = [];
    for (var i = 0; i < lines.length; i++) {
      if (isUsedIdx(i)) continue;
      if (isExcluded(lines[i])) continue;
      if (lines[i].match(/\d{3,}/)) continue;
      if (/^\(.*\)$/.test(lines[i])) continue; // Skip (A Division of...)
      if (hasKeyword(lines[i], companyKeywords) && lines[i].length < 100) {
        var candidate = lines[i].replace(/^[^a-zA-Z#]+/, '').trim();
        // Merge with previous line if it looks like a brand name
        if (i > 0 && !isUsedIdx(i-1) && !isExcluded(lines[i-1]) && !/^\(.*\)$/.test(lines[i-1]) && lines[i-1].length < 50 && lines[i-1].length > 1 && !hasKeyword(lines[i-1], designationKeywords)) {
          candidate = lines[i-1].replace(/^[^a-zA-Z#]+/, '').trim() + ' ' + candidate;
          markUsed(i-1);
        }
        companyCandidates.push(candidate);
      }
    }
    if (companyCandidates.length > 0) {
      companyCandidates.sort(function(a, b) { return b.length - a.length; });
      fields.company = companyCandidates[0];
    }
    // Derive from email/website domain
    if (!fields.company && fields.email) {
      var domain = fields.email.split('@')[1];
      var freeDomains = ['gmail','yahoo','hotmail','outlook','rediffmail','zoho','protonmail','live','msn','aol','icloud'];
      var isFree = false;
      for (var d = 0; d < freeDomains.length; d++) { if (domain.indexOf(freeDomains[d]) >= 0) { isFree = true; break; } }
      if (!isFree && domain) {
        var baseDomain = domain.split('.')[0];
        fields.company = baseDomain.charAt(0).toUpperCase() + baseDomain.slice(1);
      }
    }

    // === NAME RULE ===
    // 2-5 words, alphabetic, allow initials (single letter with dot)
    // Allow prefixes: Mr, Mrs, Ms, Dr, Prof, Er, Sri, Shri, Smt, Kum
    // Allow suffixes: Jr, Sr, II, III
    // Ignore: numbers, emails, URLs, company suffixes, designations
    // Check proximity to designation (name usually appears just above designation)
    var namePrefixes = /^(Mr|Mrs|Ms|Dr|Prof|Er|Sri|Shri|Smt|Kum)\.?$/i;
    var nameSuffixes = /^(Jr|Sr|II|III|IV)$/i;
    // Strategy: look for name near designation (line above designation is often the name)
    var designationIdx = -1;
    for (var i = 0; i < lines.length; i++) {
      if (fields.designation && lines[i].indexOf(fields.designation) >= 0) { designationIdx = i; break; }
    }
    // Try line above designation first
    if (designationIdx > 0 && !isUsedIdx(designationIdx - 1)) {
      var nameCandidate = lines[designationIdx - 1];
      if (!isExcluded(nameCandidate) && !nameCandidate.match(/\d{3,}/) && !hasKeyword(nameCandidate, companyKeywords) && !hasKeyword(nameCandidate, designationKeywords)) {
        var nameWords = nameCandidate.replace(/^(Mr|Mrs|Ms|Dr|Prof|Er|Sri|Shri|Smt|Kum)\.?\s+/i, '').trim().split(/\s+/);
        if (nameWords.length >= 2 && nameWords.length <= 5) {
          var validName = nameWords.every(function(w) {
            return /^[A-Za-z.]+[-']?[A-Za-z.]*$/.test(w) || namePrefixes.test(w) || nameSuffixes.test(w);
          });
          if (validName) {
            fields.name = nameCandidate.replace(/^(Mr|Mrs|Ms|Dr|Prof|Er|Sri|Shri|Smt|Kum)\.?\s+/i, '').trim();
            markUsed(designationIdx - 1);
          }
        }
      }
    }
    // Fallback: scan all lines
    if (!fields.name) {
      for (var i = 0; i < lines.length; i++) {
        if (isUsedIdx(i)) continue;
        var l = lines[i];
        if (isExcluded(l)) continue;
        if (l.match(/\d{3,}/)) continue;
        if (l.match(/[@#:;]/)) continue;
        if (l.match(/^[#\d]/)) continue;
        if (l.indexOf('|') >= 0 || l.indexOf(' - ') >= 0) continue;
        if (hasKeyword(l, companyKeywords)) continue;
        if (hasKeyword(l, designationKeywords)) continue;
        if (hasKeyword(l, departmentKeywords) && l.length < 30) continue;
        var nameLine = l.replace(/^(Mr|Mrs|Ms|Dr|Prof|Er|Sri|Shri|Smt|Kum)\.?\s+/i, '').trim();
        var words = nameLine.split(/\s+/);
        if (words.length >= 2 && words.length <= 5) {
          var allAlpha = words.every(function(w) {
            return /^[A-Za-z.]+[-']?[A-Za-z.]*$/.test(w) || namePrefixes.test(w) || nameSuffixes.test(w);
          });
          if (allAlpha) {
            var isTitleCase = words.every(function(w) {
              return namePrefixes.test(w) || nameSuffixes.test(w) || /^[A-Z]/.test(w) || w.length <= 2;
            });
            if (isTitleCase) {
              fields.name = nameLine;
              markUsed(i); break;
            }
          }
        }
      }
    }

    // === PIN / ZIP CODE RULE ===
    // India: 6 digits. Labels: PIN, PIN Code, ZIP, ZIP Code, Postal Code, Postcode, Pincode
    // Distinguish from phone: 6 digits only, no + prefix, near address
    // Also support US ZIP (5 digits or 5-4 format)
    for (var i = 0; i < lines.length; i++) {
      if (isUsedIdx(i)) continue;
      if (isExcluded(lines[i])) continue;
      // Labeled PIN: PIN: 560001, PIN Code: 560001
      var pinLabel = lines[i].match(/^(?:PIN|PIN\s*Code|ZIP|ZIP\s*Code|Postal\s*Code|Postcode|Pincode)\s*[:\-]?\s*(\d{6})/i);
      if (pinLabel) { fields.pincode = pinLabel[1]; markUsed(i); break; }
      // US ZIP: ZIP: 12345 or 12345-6789
      var zipLabel = lines[i].match(/^(?:ZIP|ZIP\s*Code|Postal\s*Code|Postcode)\s*[:\-]?\s*(\d{5}(?:-\d{4})?)/i);
      if (zipLabel) { fields.pincode = zipLabel[1]; markUsed(i); break; }
    }
    // Unlabeled: look for 6-digit number in address-like context
    if (!fields.pincode) {
      for (var i = 0; i < lines.length; i++) {
        if (isUsedIdx(i)) continue;
        if (isExcluded(lines[i])) continue;
        // 6-digit India PIN (not starting with 0,1,2,9 typically)
        var pinM = lines[i].match(/\b([3-8]\d{5})\b/);
        if (pinM && !lines[i].match(/@/) && !lines[i].match(/\+91/) && !isIdNumber(lines[i])) {
          var fullDigits = lines[i].replace(/\D/g, '');
          if (fullDigits.length <= 7) {
            fields.pincode = pinM[1];
            markUsed(i); break;
          }
        }
        // US ZIP: 5 digits at end of address line
        var zipM = lines[i].match(/\b(\d{5}(?:-\d{4})?)\b\s*$/);
        if (zipM && !lines[i].match(/@/) && !lines[i].match(/\+91/) && !isIdNumber(lines[i])) {
          var zd = zipM[1].replace(/\D/g,'');
          if (zd.length === 5 || zd.length === 9) {
            fields.pincode = zipM[1];
            markUsed(i); break;
          }
        }
      }
    }

    // === ADDRESS RULE ===
    // Combine related OCR lines into full address
    // Labels: Address, Office, Registered Office, Branch, Corporate Office, Head Office, Works, Factory
    // Patterns: Road, Street, Lane, Avenue, Industrial Area, Phase, Block, Building, Floor,
    //   Suite, Unit, Plot, No, Sector, Nagar, Layout, Park, Estate, Complex
    // Include city, state, PIN if found in address lines
    var addressKeywords = ['Address','Office','Registered','Branch','Corporate','Head Office','Works','Factory',
      'Road','Street','Lane','Avenue','Industrial Area','Phase','Block','Building','Floor',
      'Suite','Unit','Plot','No.','Sector','Nagar','Layout','Park','Estate','Complex',
      'Survey','Sy No','Door No','TC','SF','TF','GF','FF','MIDC','KIADB','GIDC'];
    for (var i = 0; i < lines.length; i++) {
      if (isUsedIdx(i)) continue;
      if (isExcluded(lines[i])) continue;
      var am = lines[i].match(/^(Address|Addr|Office|Registered|Branch|Corporate|Head|Works|Factory)\s*[:\-]?\s*(.+)/i);
      if (am && am[2]) {
        var addrParts = [am[2].trim()];
        // Combine next 1-3 lines if they look like address continuation
        for (var j = i+1; j < Math.min(i+4, lines.length); j++) {
          if (isUsedIdx(j)) break;
          if (isExcluded(lines[j])) break;
          if (lines[j].length < 80 && !hasKeyword(lines[j], ['Pvt','Ltd','Technologies','Solutions','Industries'])) {
            addrParts.push(lines[j].trim());
            markUsed(j);
          }
        }
        fields.address = addrParts.join(', ');
        markUsed(i); break;
      }
      // Street patterns
      if (/\b(No\.?\s*\d|\d+th\s+(Cross|Main|Stage|Block)|Sector\s+\d|Phase\s+[IVX\d]|Survey\s+No|Plot\s+No|Building|Floor|Suite|Unit|Industrial|Road|Street|Lane|Avenue|Nagar|Layout|Estate|Complex|MIDC|KIADB|GIDC)\b/i.test(lines[i]) && lines[i].length < 120) {
        var addrParts2 = [lines[i]];
        for (var j = i+1; j < Math.min(i+4, lines.length); j++) {
          if (isUsedIdx(j)) break;
          if (isExcluded(lines[j])) break;
          if (lines[j].length < 80 && !hasKeyword(lines[j], ['Pvt','Ltd','Technologies','Solutions','Industries'])) {
            addrParts2.push(lines[j].trim());
            markUsed(j);
          }
        }
        fields.address = addrParts2.join(', ');
        markUsed(i); break;
      }
    }

    // === CITY RULE ===
    // Detect known city names, alternate spellings
    // Use address context, country context
    var cityMap = {
      'Bengaluru':'Bengaluru','Bangalore':'Bengaluru','Mumbai':'Mumbai','Bombay':'Mumbai',
      'Delhi':'Delhi','New Delhi':'Delhi','Chennai':'Chennai','Madras':'Chennai',
      'Hyderabad':'Hyderabad','Kolkata':'Kolkata','Calcutta':'Kolkata',
      'Pune':'Pune','Ahmedabad':'Ahmedabad','Gurugram':'Gurugram','Gurgaon':'Gurugram',
      'Noida':'Noida','Greater Noida':'Noida','Kochi':'Kochi','Cochin':'Kochi',
      'Coimbatore':'Coimbatore','Jaipur':'Jaipur','Lucknow':'Lucknow','Surat':'Surat',
      'Kanpur':'Kanpur','Nagpur':'Nagpur','Indore':'Indore','Thane':'Thane',
      'Bhopal':'Bhopal','Visakhapatnam':'Visakhapatnam','Vizag':'Visakhapatnam',
      'Patna':'Patna','Vadodara':'Vadodara','Baroda':'Vadodara','Ghaziabad':'Ghaziabad',
      'Ludhiana':'Ludhiana','Agra':'Agra','Nashik':'Nashik','Faridabad':'Faridabad',
      'Meerut':'Meerut','Rajkot':'Rajkot','Varanasi':'Varanasi','Srinagar':'Srinagar',
      'Aurangabad':'Aurangabad','Dhanbad':'Dhanbad','Amritsar':'Amritsar',
      'Allahabad':'Allahabad','Ranchi':'Ranchi','Howrah':'Howrah','Jabalpur':'Jabalpur',
      'Gwalior':'Gwalior','Vijayawada':'Vijayawada','Jodhpur':'Jodhpur',
      'Raipur':'Raipur','Kota':'Kota','Guwahati':'Guwahati','Chandigarh':'Chandigarh',
      'Mysuru':'Mysuru','Mysore':'Mysuru','Shimla':'Shimla','Bhubaneswar':'Bhubaneswar',
      ' Mangalore':'Mangaluru','Mangaluru':'Mangaluru','Belgaum':'Belagavi','Belagavi':'Belagavi',
      'Hubli':'Hubballi','Hubballi':'Hubballi','Gulbarga':'Kalaburagi','Kalaburagi':'Kalaburagi',
      'Mangaluru':'Mangaluru','Trivandrum':'Thiruvananthapuram','Thiruvananthapuram':'Thiruvananthapuram',
      'Cochin':'Kochi','Kozhikode':'Kozhikode','Calicut':'Kozhikode','Trichy':'Tiruchirappalli',
      'Tiruchirappalli':'Tiruchirappalli','Madurai':'Madurai','Salem':'Salem','Erode':'Erode',
      'Tirunelveli':'Tirunelveli','Vellore':'Vellore','Thoothukudi':'Thoothukudi','Tuticorin':'Thoothukudi',
      'Udaipur':'Udaipur','Ajmer':'Ajmer','Bikaner':'Bikaner','Jaisalmer':'Jaisalmer',
      'Dehradun':'Dehradun','Haridwar':'Haridwar','Roorkee':'Roorkee',
      'Siliguri':'Siliguri','Durgapur':'Durgapur','Asansol':'Asansol','Kharagpur':'Kharagpur',
      'Durg':'Durg','Bhilai':'Bhilai','Raigarh':'Raigarh','Bilaspur':'Bilaspur',
      'Jamshedpur':'Jamshedpur','Durgabhilai':'Durgabhilai','Warangal':'Warangal',
      'Karimnagar':'Karimnagar','Nizamabad':'Nizamabad','Khammam':'Khammam',
      'Tirupati':'Tirupati','Nellore':'Nellore','Kurnool':'Kurnool','Kakinada':'Kakinada',
      'Solapur':'Solapur','Kolhapur':'Kolhapur','Amravati':'Amravati','Sangli':'Sangli',
      'Jalgaon':'Jalgaon','Latur':'Latur','Nanded':'Nanded','Ahmednagar':'Ahmednagar',
      'Bharuch':'Bharuch','Anand':'Anand','Nadiad':'Nadiad','Mehsana':'Mehsana',
      'Bhavnagar':'Bhavnagar','Jamnagar':'Jamnagar','Junagadh':'Junagadh','Gandhinagar':'Gandhinagar',
      'Morbi':'Morbi','Surendranagar':'Surendranagar','Vapi':'Vapi','Valsad':'Valsad',
      'Navsari':'Navsari','Bhuj':'Bhuj','Gandhidham':'Gandhidham','Ankleshwar':'Ankleshwar',
      'Panipat':'Panipat','Ambala':'Ambala','Karnal':'Karnal','Hisar':'Hisar',
      'Yamunanagar':'Yamunanagar','Rohtak':'Rohtak','Rewari':'Rewari','Panchkula':'Panchkula'
    };
    var allTextForCity = lines.join(' ');
    for (var city in cityMap) {
      var cityRegex = new RegExp('\\b' + city.replace(/\./g, '\\.').replace(/\s/g, '\\s+') + '\\b', 'i');
      if (cityRegex.test(allTextForCity)) {
        fields.city = cityMap[city];
        break;
      }
    }
    // Also check near PIN code
    if (!fields.city && fields.pincode) {
      // Known PIN prefix to city mapping (major cities)
      var pinCityMap = {
        '560':'Bengaluru','561':'Bengaluru','562':'Bengaluru','110':'Delhi','400':'Mumbai',
        '600':'Chennai','500':'Hyderabad','700':'Kolkata','411':'Pune','380':'Ahmedabad',
        '122':'Gurugram','201':'Noida','682':'Kochi','641':'Coimbatore','302':'Jaipur',
        '226':'Lucknow','395':'Surat','208':'Kanpur','440':'Nagpur','452':'Indore',
        '4006':'Thane','462':'Bhopal','530':'Visakhapatnam','800':'Patna','390':'Vadodara',
        '141':'Ludhiana','282':'Agra','422':'Nashik','121':'Faridabad','250':'Meerut',
        '360':'Rajkot','221':'Varanasi','560':'Bengaluru','570':'Mysuru'
      };
      var pinPrefix = fields.pincode.substring(0, 3);
      if (pinCityMap[pinPrefix]) fields.city = pinCityMap[pinPrefix];
    }

    // === STATE RULE ===
    var stateList = ['Karnataka','Maharashtra','Tamil Nadu','Kerala','Telangana','Andhra Pradesh',
      'Gujarat','Delhi','Haryana','Punjab','Rajasthan','Uttar Pradesh','Madhya Pradesh',
      'West Bengal','Bihar','Jharkhand','Odisha','Assam','Goa','Uttarakhand','Himachal Pradesh',
      'Jammu and Kashmir','Chhattisgarh','Puducherry','Chandigarh','Tripura','Manipur',
      'Meghalaya','Nagaland','Sikkim','Mizoram','Arunachal Pradesh'];
    var stateAbbr = { 'KA':'Karnataka','MH':'Maharashtra','TN':'Tamil Nadu','KL':'Kerala',
      'TS':'Telangana','AP':'Andhra Pradesh','GJ':'Gujarat','DL':'Delhi','HR':'Haryana',
      'PB':'Punjab','RJ':'Rajasthan','UP':'Uttar Pradesh','MP':'Madhya Pradesh',
      'WB':'West Bengal','BR':'Bihar','JH':'Jharkhand','OD':'Odisha','OR':'Odisha',
      'AS':'Assam','GA':'Goa','UK':'Uttarakhand','HP':'Himachal Pradesh',
      'JK':'Jammu and Kashmir','CG':'Chhattisgarh','PY':'Puducherry',
      'CH':'Chandigarh','TR':'Tripura','MN':'Manipur','ML':'Meghalaya',
      'NL':'Nagaland','SK':'Sikkim','MZ':'Mizoram','AR':'Arunachal Pradesh' };
    for (var s = 0; s < stateList.length; s++) {
      if (new RegExp('\\b' + stateList[s].replace(/\s/g, '\\s+') + '\\b', 'i').test(allTextForCity)) {
        fields.state = stateList[s]; break;
      }
    }
    if (!fields.state) {
      // Check for "State:" label
      var stateLabel = allTextForCity.match(/(?:State)\s*[:\-]\s*([A-Za-z\s]+)/i);
      if (stateLabel && stateLabel[1]) {
        fields.state = stateLabel[1].trim().substring(0, 40);
      }
    }
    if (!fields.state) {
      for (var abbr in stateAbbr) {
        if (new RegExp('\\b' + abbr + '\\b').test(allTextForCity)) {
          fields.state = stateAbbr[abbr]; break;
        }
      }
    }
    // Derive state from city
    if (!fields.state && fields.city) {
      var cityStateMap = {
        'Bengaluru':'Karnataka','Mumbai':'Maharashtra','Delhi':'Delhi','Chennai':'Tamil Nadu',
        'Hyderabad':'Telangana','Kolkata':'West Bengal','Pune':'Maharashtra',
        'Ahmedabad':'Gujarat','Gurugram':'Haryana','Noida':'Uttar Pradesh',
        'Kochi':'Kerala','Coimbatore':'Tamil Nadu','Jaipur':'Rajasthan',
        'Lucknow':'Uttar Pradesh','Surat':'Gujarat','Kanpur':'Uttar Pradesh',
        'Nagpur':'Maharashtra','Indore':'Madhya Pradesh','Thane':'Maharashtra',
        'Bhopal':'Madhya Pradesh','Visakhapatnam':'Andhra Pradesh','Patna':'Bihar',
        'Vadodara':'Gujarat','Ghaziabad':'Uttar Pradesh','Ludhiana':'Punjab',
        'Mysuru':'Karnataka','Chandigarh':'Chandigarh','Guwahati':'Assam'
      };
      if (cityStateMap[fields.city]) fields.state = cityStateMap[fields.city];
    }

    // === COUNTRY RULE ===
    if (/\bindia\b/i.test(allTextForCity)) {
      fields.country = 'India';
    } else {
      var countries = { 'USA':'USA','United States':'USA','United States of America':'USA','US':'USA',
        'UK':'UK','United Kingdom':'UK','Britain':'UK','Great Britain':'UK',
        'Singapore':'Singapore','Germany':'Germany','Deutschland':'Germany',
        'China':'China','Japan':'Japan','Nippon':'Japan',
        'UAE':'UAE','United Arab Emirates':'UAE','Dubai':'UAE','Abu Dhabi':'UAE',
        'Australia':'Australia','Canada':'Canada','France':'France',
        'Italy':'Italy','Italia':'Italy','South Korea':'South Korea','Korea':'South Korea',
        'Taiwan':'Taiwan','Hong Kong':'Hong Kong','Thailand':'Thailand',
        'Malaysia':'Malaysia','Indonesia':'Indonesia','Vietnam':'Vietnam',
        'Switzerland':'Switzerland','Netherlands':'Netherlands','Sweden':'Sweden',
        'Spain':'Spain','Belgium':'Belgium','Austria':'Austria',
        'Brazil':'Brazil','Mexico':'Mexico','Russia':'Russia','Turkey':'Turkey',
        'Saudi Arabia':'Saudi Arabia','Qatar':'Qatar','Oman':'Oman',
        'Bahrain':'Bahrain','Kuwait':'Kuwait','Egypt':'Egypt','South Africa':'South Africa',
        'Nigeria':'Nigeria','Kenya':'Kenya','Israel':'Israel','Poland':'Poland' };
      for (var country in countries) {
        if (new RegExp('\\b' + country.replace(/\./g, '\\.') + '\\b', 'i').test(allTextForCity)) {
          fields.country = countries[country]; break;
        }
      }
      // Try country code from phone
      if (!fields.country && fields.phone) {
        var phoneDigits = fields.phone.replace(/\D/g, '');
        if (phoneDigits.indexOf('91') === 0 && phoneDigits.length >= 12) fields.country = 'India';
        else if (phoneDigits.indexOf('1') === 0 && phoneDigits.length === 11) fields.country = 'USA';
        else if (phoneDigits.indexOf('44') === 0 && phoneDigits.length >= 12) fields.country = 'UK';
        else if (phoneDigits.indexOf('65') === 0 && phoneDigits.length >= 10) fields.country = 'Singapore';
        else if (phoneDigits.indexOf('49') === 0 && phoneDigits.length >= 12) fields.country = 'Germany';
        else if (phoneDigits.indexOf('86') === 0 && phoneDigits.length >= 13) fields.country = 'China';
        else if (phoneDigits.indexOf('81') === 0 && phoneDigits.length >= 12) fields.country = 'Japan';
        else if (phoneDigits.indexOf('971') === 0 && phoneDigits.length >= 12) fields.country = 'UAE';
        else if (phoneDigits.indexOf('61') === 0 && phoneDigits.length >= 11) fields.country = 'Australia';
        else if (phoneDigits.indexOf('91') === 0) fields.country = 'India';
      }
    }

    return fields;
  },

  // Post-processing review: show what was extracted, then continue to the form
  showExtractedData(fields, rawText) {
    var now = new Date();
    var captureDate = now.toISOString().slice(0,10) + ' ' + now.toTimeString().slice(0,8);
    this.lastRawOCR = rawText;

    var existing = document.getElementById('cardCaptureScreen');
    if (existing) existing.remove();

    var summary = [];
    if (fields.name) summary.push('Name: ' + fields.name);
    if (fields.company) summary.push('Company: ' + fields.company);
    if (fields.designation) summary.push('Designation: ' + fields.designation);
    if (fields.phone) summary.push('Phone: ' + fields.phone);
    if (fields.email) summary.push('Email: ' + fields.email);
    if (fields.website) summary.push('Website: ' + fields.website);
    if (fields.linkedin) summary.push('LinkedIn: ' + fields.linkedin);
    if (fields.city) summary.push('City: ' + fields.city);
    var summaryHtml = summary.length > 0 ?
      '<div style="font-size:13px;color:#aaa;margin:12px 0;max-height:180px;overflow-y:auto;text-align:left">' +
      summary.map(function(s){ return '<div style="margin-bottom:4px">✓ ' + s + '</div>'; }).join('') +
      '</div>' : '<div style="font-size:13px;color:#f99;margin:12px 0">No fields detected — you can retake or enter manually</div>';

    var overlay = document.createElement('div');
    overlay.id = 'cardCaptureScreen';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;padding:24px;overflow-y:auto';
    overlay.innerHTML =
      '<div style="font-size:40px;margin-bottom:8px">🪪</div>' +
      '<div style="font-size:18px;font-weight:600;margin-bottom:4px">Card scanned</div>' +
      '<div style="font-size:13px;color:#888;margin-bottom:8px">OCR complete · ' + (fields.ocrSource || 'OCR') + '</div>' +
      summaryHtml +
      '<div style="display:flex;flex-direction:column;gap:10px;width:100%;max-width:300px">' +
        '<button id="ccBtnRetake" style="padding:14px;border:2px solid #555;background:transparent;color:#fff;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer">' + (this.fromGallery ? '🔄 Choose Again' : '🔄 Retake') + '</button>' +
        '<button id="ccBtnUse" style="padding:14px;border:none;background:#0d6efd;color:#fff;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer">✅ Continue to Form</button>' +
      '</div>';
    document.body.appendChild(overlay);

    var self = this;
    document.getElementById('ccBtnRetake').onclick = function() {
      overlay.remove();
      self.isBackSide = false;
      var input = document.getElementById(self.fromGallery ? 'scanFileInput' : 'cardScanInput');
      if (input) input.click();
    };
    document.getElementById('ccBtnUse').onclick = function() {
      overlay.remove();
      self.finalizeCardScan(fields, rawText, captureDate);
    };
  },

  finalizeCardScan(fields, rawText, captureDate) {
    ManualForm.currentScanData = {
      raw: '[Visiting Card OCR] ' + rawText.substring(0, 500),
      fields: fields,
      ocrText: rawText,
      captureDate: captureDate
    };
    App.navigate('manual');
    App.toggleDrawer(false);

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
  }
};

/* ========================= MANUAL FORM ========================= */
const ManualForm = {
  currentScanData: null,
  phoneFieldCount: 1,

  async render() {
    const cats = await dbGetAll('categories');
    const activeCats = cats.filter(c => c.active).map(c => c.name).sort((a,b) => a.localeCompare(b, undefined, {numeric: true}));
    const isEdit = !!editLeadId;
    let lead = null;
    if (isEdit) {
      lead = await dbGet('leads', editLeadId);
      if (!lead) { editLeadId = null; this.render(); return; }
    }

    const data = lead || (this.currentScanData ? this.currentScanData.fields : {});
    const raw = lead ? lead.rawBadgeData : (this.currentScanData ? this.currentScanData.raw : '');
    const ocrData = lead ? (lead.rawOcrData || '') : (this.currentScanData ? (this.currentScanData.ocrText || '') : '');
    const captureDate = lead ? (lead.captureDate || '') : (this.currentScanData ? (this.currentScanData.captureDate || '') : '');

    document.getElementById('manualFormContainer').innerHTML = `
      ${isEdit ? '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px"><button class="btn btn-outline" onclick="App.navigate(\'leads\')" style="padding:10px 14px">← Back</button><h2>Edit Lead</h2></div>' : '<h2 style="margin-bottom:16px">Manual Entry</h2>'}

      <div class="form-card">
        <h3>📋 Visitor Information</h3>
        <div class="form-group"><label>Visitor Name *</label><input type="text" id="f_name" value="${esc(data.name||'')}" placeholder="Full name"></div>
        <div class="form-group"><label>Designation</label><input type="text" id="f_designation" value="${esc(data.designation||'')}" placeholder="Job title"></div>
        <div class="form-group"><label>Department</label><input type="text" id="f_department" value="${esc(data.department||'')}" placeholder="Department"></div>
        <div class="form-group"><label>Company *</label><input type="text" id="f_company" value="${esc(data.company||'')}" placeholder="Company name"></div>
        <div class="form-group">
          <label>Mobile / Phone</label>
          <input type="tel" id="f_phone" value="${esc(data.phone||'')}" placeholder="+91...">
        </div>
        <div id="extraPhonesContainer"></div>
        <button type="button" class="add-phone-btn" onclick="ManualForm.addPhoneField()">+ Add Phone</button>
        <div class="form-group" style="margin-top:12px">
          <label>Email</label>
          <input type="email" id="f_email" value="${esc(data.email||'')}" placeholder="email@example.com">
        </div>
        <div class="field-row">
          <div class="form-group"><label>Country</label><input type="text" id="f_country" value="${esc(data.country||'India')}" placeholder="Country"></div>
          <div class="form-group"><label>City</label><input type="text" id="f_city" value="${esc(data.city||'')}" placeholder="City"></div>
        </div>
        <div class="field-row">
          <div class="form-group"><label>State</label><input type="text" id="f_state" value="${esc(data.state||'')}" placeholder="State"></div>
          <div class="form-group"><label>PIN / ZIP</label><input type="text" id="f_pincode" value="${esc(data.pincode||'')}" placeholder="PIN code"></div>
        </div>
        <div class="form-group"><label>Address</label><textarea id="f_address" rows="2" placeholder="Street address" style="resize:vertical">${esc(data.address||'')}</textarea></div>
        <div class="form-group"><label>Badge ID</label><input type="text" id="f_badgeId" value="${esc(data.badgeId||'')}" placeholder="Badge ID"></div>
        <div class="field-row">
          <div class="form-group">
            <label>LinkedIn URL / ID</label>
            <div style="position:relative">
              <textarea id="f_linkedin" rows="2" placeholder="linkedin.com/in/username" style="padding-right:36px;resize:vertical" onblur="ManualForm.autoLinkedIn()">${esc(data.linkedin||'')}</textarea>
              <span style="position:absolute;right:8px;top:12px;cursor:pointer;font-size:16px" onclick="ManualForm.autoLinkedIn()">🔍</span>
            </div>
          </div>
          <div class="form-group">
            <label>Company Website</label>
            <div style="position:relative">
              <textarea id="f_website" rows="2" placeholder="www.company.com" style="padding-right:36px;resize:vertical" onblur="ManualForm.autoWebsite()">${esc(data.website||'')}</textarea>
              <span style="position:absolute;right:8px;top:12px;cursor:pointer;font-size:16px" onclick="ManualForm.autoWebsite()">🔍</span>
            </div>
          </div>
        </div>
        <div class="form-group">
          <label>Visitor Type</label>
          <select id="f_visitorType">
            ${(App.getDropdownOptions('visitorTypes') || DEFAULT_VISITOR_TYPES).map(t => `<option ${data.visitorType===t?'selected':''}>${t}</option>`).join('')}
          </select>
        </div>
        ${raw ? `
        <div class="form-group" style="margin-top:16px">
          <label style="font-size:15px;font-weight:700;color:var(--primary);margin-bottom:8px">🎫 Raw Badge Data</label>
          <div class="ocr-collapse-header" id="badgeCollapseHeader" onclick="ManualForm.toggleBadgeCollapse()">
            <span>Tap to view / edit raw badge data</span>
            <span class="chevron">▼</span>
          </div>
          <div class="ocr-collapse-body" id="badgeCollapseBody">
            <textarea id="f_rawBadge" rows="4" placeholder="No badge data">${esc(raw)}</textarea>
          </div>
        </div>` : '<input type="hidden" id="f_rawBadge" value="">'}
        <input type="hidden" id="f_captureDate" value="${esc(captureDate)}">
        <div class="form-group">
          <label style="font-size:15px;font-weight:700;color:var(--primary);margin-bottom:8px">📋 Raw OCR Data — Visiting Card Scan</label>
          <div class="ocr-collapse-header" id="ocrCollapseHeader" onclick="ManualForm.toggleOcrCollapse()">
            <span>Tap to view / edit raw OCR text</span>
            <span class="chevron">▼</span>
          </div>
          <div class="ocr-collapse-body" id="ocrCollapseBody">
            <textarea id="f_rawOcrData" rows="8" placeholder="No OCR data captured">${esc(ocrData)}</textarea>
          </div>
        </div>
      </div>

      <div class="form-card">
        <h3>🔥 Lead Qualification</h3>
        <div class="form-group">
          <label>Priority</label>
          <div class="chip-group priority-chips">
            ${App.getPriorities().map((p, i) => {
              var cls = i === 0 ? 'hot' : i === 1 ? 'warm' : i === 2 ? 'cold' : '';
              var emoji = i === 0 ? '🔥' : i === 1 ? '☀️' : i === 2 ? '❄️' : '📌';
              return `<button class="chip ${cls} ${data.priority===p?'active':''}" onclick="ManualForm.selectChip(this,'f_priority','${esc(p)}')">${emoji} ${esc(p)}</button>`;
            }).join('')}
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
            ${(App.getDropdownOptions('volumes') || DEFAULT_VOLUMES).map(v => `<option ${data.volume===v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Timeline</label>
          <select id="f_timeline">
            <option value="">Select timeline...</option>
            ${(App.getDropdownOptions('timelines') || DEFAULT_TIMELINES).map(t => `<option ${data.timeline===t?'selected':''}>${t}</option>`).join('')}
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
              ${(App.getDropdownOptions('followUpTypes') || FOLLOWUP_TYPES).map(t => `<option ${data.followUpType===t?'selected':''}>${t}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Follow-up Status</label>
          <select id="f_followUpStatus">
            <option value="">Select...</option>
            ${(App.getDropdownOptions('followUpStatuses') || DEFAULT_FOLLOWUP_STATUSES).map(s => `<option ${data.followUpStatus===s?'selected':''}>${s}</option>`).join('')}
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

    // Restore extra phone fields if editing or from scan data
    if (isEdit && lead) {
      this.restoreExtraPhones(lead);
    } else if (this.currentScanData && this.currentScanData.fields) {
      var f = this.currentScanData.fields;
      if (f.phone2) this.addPhoneField(f.phone2);
      if (f.phone3) this.addPhoneField(f.phone3);
      if (f.phone4) this.addPhoneField(f.phone4);
      if (f.phone5) this.addPhoneField(f.phone5);    }
  },

  prefillFromScan(raw, fields, dup) {
    this.currentScanData = { raw, fields };
    // Switch to manual form view
    App.navigate('manual');
  },

  addPhoneField(value) {
    this.phoneFieldCount++;
    var num = this.phoneFieldCount;
    var container = document.getElementById('extraPhonesContainer');
    if (!container) return;
    var div = document.createElement('div');
    div.className = 'phone-extra-field';
    div.id = 'phoneExtra_' + num;
    div.innerHTML =
      '<input type="tel" id="f_phone' + num + '" value="' + esc(value || '') + '" placeholder="+91...">' +
      '<button type="button" class="phone-remove-btn" onclick="ManualForm.removePhoneField(' + num + ')" title="Remove">×</button>';
    container.appendChild(div);
  },

  removePhoneField(num) {
    var div = document.getElementById('phoneExtra_' + num);
    if (div) div.remove();
  },

  toggleOcrCollapse() {
    var header = document.getElementById('ocrCollapseHeader');
    var body = document.getElementById('ocrCollapseBody');
    if (!header || !body) return;
    header.classList.toggle('expanded');
    body.classList.toggle('expanded');
  },

  toggleBadgeCollapse() {
    var header = document.getElementById('badgeCollapseHeader');
    var body = document.getElementById('badgeCollapseBody');
    if (!header || !body) return;
    header.classList.toggle('expanded');
    body.classList.toggle('expanded');
  },

  restoreExtraPhones(lead) {
    // Restore phone2, phone3, etc. from saved lead data
    this.phoneFieldCount = 1;
    var container = document.getElementById('extraPhonesContainer');
    if (container) container.innerHTML = '';
    if (!lead) return;
    for (var i = 2; i <= 10; i++) {
      var key = 'phone' + i;
      if (lead[key]) {
        this.addPhoneField(lead[key]);
      }
    }
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
      department: val('f_department'),
      phone: val('f_phone'),
      phone2: val('f_phone2'),
      phone3: val('f_phone3'),
      phone4: val('f_phone4'),
      phone5: val('f_phone5'),
      email: val('f_email'),
      country: val('f_country'),
      city: val('f_city'),
      state: val('f_state'),
      pincode: val('f_pincode'),
      address: val('f_address'),
      badgeId: val('f_badgeId'),
      linkedin: val('f_linkedin'),
      website: val('f_website'),
      rawBadgeData: val('f_rawBadge'),
      rawOcrData: val('f_rawOcrData'),
      captureDate: val('f_captureDate'),
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
      // If no captureDate set (manual entry without scan), use current timestamp
      if (!leadData.captureDate) {
        leadData.captureDate = leadData.date + ' ' + leadData.time;
      }
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
    const activeCats = cats.filter(c => c.active).map(c => c.name).sort((a,b) => a.localeCompare(b, undefined, {numeric: true}));
    const users = await dbGetAll('users');

    // Render filter chips
    let chipsHtml = '<div class="filter-chip ' + (this.currentFilter === '' ? 'active' : '') + '" onclick="Leads.setFilter(\'\')">All</div>';
    var priList = App.getPriorities();
    priList.forEach(p => {
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
          <div class="priority-dot" style="background:${App.priorityColor(l.priority)}"></div>
        </div>
        <div class="li-meta">
          ${l.priority ? `<span class="lead-tag" style="${App.priorityStyle(l.priority)}">${l.priority}</span>` : ''}
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
    // Exclude trashed leads
    leads = leads.filter(function(l){ return !l.trashed; });
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
            <p>${esc(lead.company)}${lead.designation ? ' · ' + esc(lead.designation) : ''}${lead.department ? ' · ' + esc(lead.department) : ''}</p>
          </div>
          ${lead.priority ? `<span class="lead-tag" style="${App.priorityStyle(lead.priority)};font-size:13px;padding:4px 12px">${lead.priority}</span>` : ''}
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
        ${lead.phone2 ? `<div class="detail-row"><span class="dr-label">Phone 2</span><span class="dr-value">${esc(lead.phone2)}</span></div>` : ''}
        ${lead.phone3 ? `<div class="detail-row"><span class="dr-label">Phone 3</span><span class="dr-value">${esc(lead.phone3)}</span></div>` : ''}
        ${lead.phone4 ? `<div class="detail-row"><span class="dr-label">Phone 4</span><span class="dr-value">${esc(lead.phone4)}</span></div>` : ''}
        ${lead.phone5 ? `<div class="detail-row"><span class="dr-label">Phone 5</span><span class="dr-value">${esc(lead.phone5)}</span></div>` : ''}
        ${lead.email ? `<div class="detail-row"><span class="dr-label">Email</span><span class="dr-value">${esc(lead.email)}</span></div>` : ''}
        ${lead.country ? `<div class="detail-row"><span class="dr-label">Country</span><span class="dr-value">${esc(lead.country)}</span></div>` : ''}
        ${lead.city ? `<div class="detail-row"><span class="dr-label">City</span><span class="dr-value">${esc(lead.city)}</span></div>` : ''}
        ${lead.state ? `<div class="detail-row"><span class="dr-label">State</span><span class="dr-value">${esc(lead.state)}</span></div>` : ''}
        ${lead.pincode ? `<div class="detail-row"><span class="dr-label">PIN/ZIP</span><span class="dr-value">${esc(lead.pincode)}</span></div>` : ''}
        ${lead.address ? `<div class="detail-row"><span class="dr-label">Address</span><span class="dr-value">${esc(lead.address)}</span></div>` : ''}
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
        <button class="btn btn-danger" onclick="Leads.deleteLead('${lead.id}')">🗑️ Move to Trash</button>
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
    if (!confirm('Move this lead to trash?')) return;
    var lead = await dbGet('leads', id);
    if (!lead) return;
    lead.trashed = true;
    lead.trashedAt = new Date().toISOString();
    lead.updatedAt = new Date().toISOString();
    lead.syncStatus = 'Synced';
    lead.syncedAt = new Date().toISOString();
    try {
      await dbPut('leads', lead);
    } catch(e) {
      console.error('Cloud write failed:', e);
      App.toast('Could not reach the database — lead NOT deleted. Check your connection.', 'error');
      return;
    }
    // Tombstone the trash state in the settings blob — this is what makes
    // the deletion stick on every device (schema-independent)
    if (!App.settings.trashedLeadIds) App.settings.trashedLeadIds = [];
    if (App.settings.trashedLeadIds.indexOf(id) < 0) App.settings.trashedLeadIds.push(id);
    var settingsOk = true;
    try { await App.touchAndSaveSettings(); }
    catch(e) { settingsOk = false; }
    if (settingsOk) App.toast('Lead moved to trash', 'success');
    else App.toast('Deleted — but not synced to other devices yet (network issue)', 'error');
    App.navigate('leads');
    Leads.render();
  },

  async renderTrash() {
    var leads = await dbGetAll('leads');
    var evtId = App.currentEvent ? App.currentEvent.id : 'evt-1';
    var trashed = leads.filter(function(l){ return l.trashed && (l.eventId === evtId || (!l.eventId && evtId === 'evt-1')); });
    trashed.sort((a,b) => (b.trashedAt||'').localeCompare(a.trashedAt||''));
    var isAdmin = currentUser.role === 'admin';
    var container = document.getElementById('trashList');
    if (!container) return;
    var emptyBtn = document.getElementById('trashEmptyBtn');
    if (emptyBtn) emptyBtn.style.display = isAdmin ? '' : 'none';
    if (trashed.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="es-icon">🗑️</div><p>Trash is empty. Deleted leads will appear here.</p></div>';
      return;
    }
    container.innerHTML = trashed.map(function(l) {
      return '<div class="lead-item" style="opacity:.7">' +
        '<div class="li-top"><div>' +
        '<div class="li-name">' + esc(l.name) + '</div>' +
        '<div class="li-company">' + esc(l.company) + (l.designation ? ' · ' + esc(l.designation) : '') + '</div>' +
        '</div><div class="priority-dot" style="background:' + App.priorityColor(l.priority) + '"></div></div>' +
        '<div class="li-meta">' +
        (l.priority ? '<span class="lead-tag" style="' + App.priorityStyle(l.priority) + '">' + l.priority + '</span>' : '') +
        '<span style="font-size:11px;color:var(--text-muted)">Trashed: ' + esc(l.trashedAt ? new Date(l.trashedAt).toLocaleDateString('en-IN') : '') + '</span>' +
        '</div>' +
        '<div class="form-actions" style="margin-top:8px">' +
        '<button class="btn btn-outline" style="flex:1;padding:8px 12px;font-size:13px" onclick="Leads.restoreLead(\'' + l.id + '\')">♻️ Restore</button>' +
        (isAdmin ? '<button class="btn btn-danger" style="flex:1;padding:8px 12px;font-size:13px" onclick="Leads.permanentlyDeleteLead(\'' + l.id + '\')">🗑️ Delete</button>' : '') +
        '</div></div>';
    }).join('');
  },

  async restoreLead(id) {
    var lead = await dbGet('leads', id);
    if (!lead) return;
    lead.trashed = false;
    lead.trashedAt = '';
    lead.updatedAt = new Date().toISOString();
    lead.syncStatus = 'Synced';
    lead.syncedAt = new Date().toISOString();
    await dbPut('leads', lead);
    if (App.settings.trashedLeadIds) {
      App.settings.trashedLeadIds = App.settings.trashedLeadIds.filter(function(tid){ return tid !== id; });
      await App.touchAndSaveSettings();
    }
    if (navigator.onLine) {
      try { await Cloud.upsert('leads', lead); }
      catch(e) {}
    }
    App.toast('Lead restored', 'success');
    this.renderTrash();
  },

  async permanentlyDeleteLead(id) {
    if (!confirm('Permanently delete this lead? This cannot be undone.')) return;
    // Tombstone so every device deletes it (and it can never resurrect)
    if (!App.settings.deletedLeadIds) App.settings.deletedLeadIds = [];
    if (App.settings.deletedLeadIds.indexOf(id) < 0) App.settings.deletedLeadIds.push(id);
    if (App.settings.trashedLeadIds) App.settings.trashedLeadIds = App.settings.trashedLeadIds.filter(function(tid){ return tid !== id; });
    if (App.settings.deletedLeadIds.length > 500) App.settings.deletedLeadIds = App.settings.deletedLeadIds.slice(-500);
    await App.touchAndSaveSettings();
    if (navigator.onLine) { try { await Cloud.deleteRow('leads', id); } catch(e){} }
    await dbDelete('leads', id);
    App.toast('Lead permanently deleted', 'success');
    this.renderTrash();
  },

  async emptyTrash() {
    if (currentUser.role !== 'admin') { App.toast('Only admin can empty trash', 'error'); return; }
    var leads = await dbGetAll('leads');
    var trashed = leads.filter(function(l){ return l.trashed; });
    if (trashed.length === 0) { App.toast('Trash is already empty', 'info'); return; }
    if (!confirm('Permanently delete all ' + trashed.length + ' leads in trash? This cannot be undone.')) return;
    if (!App.settings.deletedLeadIds) App.settings.deletedLeadIds = [];
    for (var i = 0; i < trashed.length; i++) {
      if (App.settings.deletedLeadIds.indexOf(trashed[i].id) < 0) App.settings.deletedLeadIds.push(trashed[i].id);
    }
    if (App.settings.trashedLeadIds) {
      var tIds = trashed.map(function(l){ return l.id; });
      App.settings.trashedLeadIds = App.settings.trashedLeadIds.filter(function(tid){ return tIds.indexOf(tid) < 0; });
    }
    if (App.settings.deletedLeadIds.length > 500) App.settings.deletedLeadIds = App.settings.deletedLeadIds.slice(-500);
    await App.touchAndSaveSettings();
    if (navigator.onLine) {
      for (var i = 0; i < trashed.length; i++) {
        try { await Cloud.deleteRow('leads', trashed[i].id); } catch(e){}
      }
    }
    for (var i = 0; i < trashed.length; i++) await dbDelete('leads', trashed[i].id);
    App.toast('Trash emptied', 'success');
    this.renderTrash();
  },

  scrollFilters(dir) {
    var container = document.getElementById('filterChips');
    if (container) container.scrollBy({ left: dir * 200, behavior: 'smooth' });
  }
};

/* ========================= DASHBOARD ========================= */
const Dashboard = {
  async render() {
    var allLeads = await dbGetAll('leads');
    // Filter by current event (leads without eventId belong to default event evt-1)
    var evtId = App.currentEvent ? App.currentEvent.id : 'evt-1';
    var leads = allLeads.filter(function(l){ return l.eventId === evtId || (!l.eventId && evtId === 'evt-1'); });
    leads = leads.filter(function(l){ return !l.trashed; });
    const today = App.dateStr(new Date());

    document.getElementById('dashGreeting').textContent = `Hello, ${currentUser.name}`;
    document.getElementById('dashDate').textContent = new Date().toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

    document.getElementById('statTotal').textContent = leads.length;
    var priList = App.getPriorities();
    var p0 = priList[0] || 'Hot', p1 = priList[1] || 'Warm', p2 = priList[2] || 'Cold';
    var hotLbl = document.querySelector('.stat-card.hot .stat-label');
    var warmLbl = document.querySelector('.stat-card.warm .stat-label');
    var coldLbl = document.querySelector('.stat-card.cold .stat-label');
    if (hotLbl) hotLbl.textContent = p0;
    if (warmLbl) warmLbl.textContent = p1;
    if (coldLbl) coldLbl.textContent = p2;
    document.getElementById('statHot').textContent = leads.filter(l => l.priority === p0).length;
    document.getElementById('statWarm').textContent = leads.filter(l => l.priority === p1).length;
    document.getElementById('statCold').textContent = leads.filter(l => l.priority === p2).length;
    document.getElementById('statToday').textContent = leads.filter(l => l.date === today).length;
    document.getElementById('statFollowup').textContent = leads.filter(l => l.followUp === 'Yes').length;

    this.renderPriorityChart(leads);
    this.renderInterestChart(leads);
    this.renderSalespersonChart(leads);
    this.renderDateChart(leads);
  },

  renderPriorityChart(leads) {
    var pr = App.getPriorities();
    var counts = {};
    pr.forEach(function(p){ counts[p] = 0; });
    leads.forEach(function(l){ if (l.priority) counts[l.priority] = (counts[l.priority]||0)+1; });
    var max = Math.max.apply(null, Object.values(counts).concat([1]));
    var colors = ['var(--hot)', 'var(--warm)', 'var(--cold)'];
    const container = document.getElementById('priorityChart');
    container.innerHTML = Object.entries(counts).map(([k,v], i) => `
      <div class="bar-row">
        <div class="bar-label">${k}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(v/max*100)}%;background:${colors[i]||'var(--primary)'}">${v}</div></div>
      </div>
    `).join('');
  },

  async renderInterestChart(leads) {
    const cats = await dbGetAll('categories');
    const activeCats = cats.filter(c => c.active).map(c => c.name).sort((a,b) => a.localeCompare(b, undefined, {numeric: true}));
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
    const activeCats = cats.filter(c => c.active).map(c => c.name).sort((a,b) => a.localeCompare(b, undefined, {numeric: true}));
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
    leads = leads.filter(l => !l.trashed);
    if (p) leads = leads.filter(l => l.priority === p);
    if (i) leads = leads.filter(l => l.interest === i);
    if (s) leads = leads.filter(l => l.salesperson === s);
    if (sync) leads = leads.filter(l => l.syncStatus === sync);
    leads.sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||''));
    return leads;
  },

  async updateSummary() {
    const leads = await this.getFiltered();
    var pr = App.getPriorities();
    var prRows = pr.slice(0, 3).map(function(p) {
      return '<div class="detail-row"><span class="dr-label">' + esc(p) + '</span><span class="dr-value">' + leads.filter(function(l){ return l.priority === p; }).length + '</span></div>';
    }).join('');
    document.getElementById('exportSummary').innerHTML = `
      <div class="detail-row"><span class="dr-label">Total leads to export</span><span class="dr-value">${leads.length}</span></div>
      ${prRows}
      <div class="detail-row"><span class="dr-label">Follow-ups</span><span class="dr-value">${leads.filter(l=>l.followUp==='Yes').length}</span></div>
    `;
  },

  async doExport(format) {
    const leads = await this.getFiltered();
    if (leads.length === 0) { App.toast('No leads to export with current filters', 'error'); return; }

    const headers = ['Lead ID','Date','Time','Salesperson','Event','Visitor Name','Designation','Department','Company','Mobile','Mobile 2','Mobile 3','Mobile 4','Mobile 5','Email','Country','City','State','PIN/ZIP','Address','Badge ID','LinkedIn','Website','Raw Badge Data','Raw OCR Data','Date of Capture','Visitor Type','Lead Source','Priority','Interest','Volume','Timeline','Customer Requirement','Follow-up','Follow-up Date','Follow-up Type','Follow-up Status','Remarks','Created At','Updated At','Synced At','Sync Status'];

    const rows = leads.map(l => [
      l.id||'', l.date||'', l.time||'', l.salesperson||'',
      l.eventName||'',
      l.name||'', l.designation||'', l.department||'', l.company||'',
      l.phone||'', l.phone2||'', l.phone3||'', l.phone4||'', l.phone5||'',
      l.email||'', l.country||'', l.city||'', l.state||'', l.pincode||'', l.address||'',
      l.badgeId||'', l.linkedin||'', l.website||'', l.rawBadgeData||'',
      l.rawOcrData||'', l.captureDate||'',
      l.visitorType||'',
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
        '<div style="font-size:13px;color:#666;margin-top:4px">📍 ' + esc(e.venue || '—') + '</div>' +
        '<div style="font-size:12px;color:#999;margin-top:4px">📅 ' + esc(this.eventDateRange(e)) + '</div>' +
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

  eventDateRange(e) {
    var s = e.startDate || e.date || '';
    var en = e.endDate || '';
    if (s && en && s !== en) return s + ' → ' + en;
    if (s) return s;
    if (en) return en;
    return 'Dates not set';
  },

  showEventModal(id) {
    const isEdit = !!id;
    if (isEdit) {
      dbGet('events', id).then(e => this._renderEventModal(e || {}, true));
    } else {
      this._renderEventModal({ name:'', venue:'', startDate:'', endDate:'' }, false);
    }
  },

  _renderEventModal(evt, isEdit) {
    document.getElementById('modalContent').innerHTML = `
      <div class="modal-head">
        <h3>${isEdit ? 'Edit Event' : 'Add Event'}</h3>
        <button class="modal-close" onclick="Admin.closeModal()">×</button>
      </div>
      <div class="modal-body">
        <div class="form-group"><label>Event Name *</label><input type="text" id="me_name" value="${esc(evt.name||'')}" placeholder="e.g., Electronica 2026"></div>
        <div class="form-group"><label>Place / Venue</label><input type="text" id="me_venue" value="${esc(evt.venue||'')}" placeholder="e.g., BIEC Bengaluru, Hall 3, Stall D15"></div>
        <div class="field-row">
          <div class="form-group"><label>Start Date</label><input type="date" id="me_startDate" value="${esc(evt.startDate||evt.date||'')}"></div>
          <div class="form-group"><label>End Date</label><input type="date" id="me_endDate" value="${esc(evt.endDate||'')}"></div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-outline" style="flex:1" onclick="Admin.closeModal()">Cancel</button>
        <button class="btn btn-primary" style="flex:1" onclick="Admin.saveEvent('${evt.id||''}', ${isEdit})">Save</button>
      </div>
    `;
    document.getElementById('modalOverlay').classList.add('open');
  },

  async saveEvent(id, isEdit) {
    const name = document.getElementById('me_name').value.trim();
    const venue = document.getElementById('me_venue').value.trim();
    const startDate = document.getElementById('me_startDate').value;
    const endDate = document.getElementById('me_endDate').value;
    if (!name) { App.toast('Event name is required', 'error'); return; }
    const existing = isEdit ? await dbGet('events', id) : null;
    const evt = {
      id: id || ('evt-' + Date.now() + '-' + Math.random().toString(36).slice(2,8)),
      name, venue, startDate, endDate,
      date: startDate || '',
      active: true,
      created: existing ? existing.created : new Date().toISOString()
    };
    await dbPut('events', evt);
    this.closeModal();
    App.toast(isEdit ? 'Event updated' : 'Event created: ' + name, 'success');
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
    var evtData = await dbGet('events', id);
    if (evtData && evtData.name) {
      if (!App.settings.deletedEventNames) App.settings.deletedEventNames = [];
      if (App.settings.deletedEventNames.indexOf(evtData.name) < 0) App.settings.deletedEventNames.push(evtData.name);
      await App.touchAndSaveSettings();
    }
    await dbDelete('events', id);
    if (navigator.onLine) { try { await Cloud.deleteRow('events', id); } catch(e){ console.error('Cloud delete event:', e); } }
    // If current event was deleted, switch to first available
    if (App.currentEvent && App.currentEvent.id === id) {
      var events = await dbGetAll('events');
      if (events.length > 0) {
        await App.setCurrentEvent(events[0].id);
      }
    }
    // If deleted event was the default, pick a new one
    if (App.settings.defaultEventId === id) {
      var remaining = await dbGetAll('events');
      if (remaining.length > 0) {
        await this.setDefaultEvent(remaining[0].id);
      } else {
        delete App.settings.defaultEventId;
        await App.touchAndSaveSettings();
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
          <p>${esc(u.username)} · ${esc(u.role)}${currentUser && currentUser.role === 'admin' ? ' · 🔑 ' + esc(u.password||'') : ''}${u.canExport && u.role !== 'admin' ? ' · 📤 Export' : ''}</p>
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
        <div class="form-group"><label>User ID</label><input type="text" id="mu_username" value="${esc(user.username||'')}" placeholder="user ID"></div>
        <div class="form-group"><label>Password</label><div style="display:flex;gap:8px"><input type="text" id="mu_password" value="${esc(user.password||'')}" placeholder="password" style="flex:1"><button type="button" class="btn btn-outline" style="padding:8px 12px;font-size:13px;white-space:nowrap" onclick="Admin.resetPassword()">🔄 Reset</button></div></div>
        <div class="form-group"><label>Role</label><div style="display:flex;gap:8px"><select id="mu_role" style="flex:1">${Admin.getUserRoles().map(r => `<option value="${esc(r)}" ${user.role===r?'selected':''}>${esc(r.charAt(0).toUpperCase()+r.slice(1))}</option>`).join('')}</select><button type="button" class="btn btn-outline" style="padding:8px 12px;font-size:13px;white-space:nowrap" onclick="Admin.addRoleOption()">+ Add</button><button type="button" class="btn btn-outline" style="padding:8px 12px;font-size:13px;white-space:nowrap" onclick="Admin.deleteRoleOption()">🗑️</button></div></div>
        <div class="form-group"><label>Status</label><select id="mu_active"><option value="true" ${user.active?'selected':''}>Active</option><option value="false" ${!user.active?'selected':''}>Inactive</option></select></div>
        <div class="form-group"><label>Allow Export</label><select id="mu_canExport"><option value="false" ${!user.canExport?'selected':''}>No</option><option value="true" ${user.canExport?'selected':''}>Yes</option></select></div>
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
    const canExport = document.getElementById('mu_canExport') ? document.getElementById('mu_canExport').value === 'true' : false;
    if (!name || !username || !password) { App.toast('All fields required', 'error'); return; }
    // Check username uniqueness
    const users = await dbGetAll('users');
    if (users.some(u => (u.username||'').toLowerCase() === username.toLowerCase() && u.id !== id)) { App.toast('User ID already exists', 'error'); return; }
    const user = {
      id: id || ('u-' + Date.now() + '-' + Math.random().toString(36).slice(2,6)),
      name, username, password, role, active, canExport,
      created: isEdit ? (await dbGet('users', id)).created : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await dbPut('users', user);
    this.closeModal();
    App.toast('User saved', 'success');
    this.renderUsers();
    App.populateLoginUsers();
    Cloud.syncUpUser(user);
  },

  async deleteUser(id) {
    const u = await dbGet('users', id);
    if (!confirm(`Delete user "${u.name}"?`)) return;
    if (!App.settings.deletedUserIds) App.settings.deletedUserIds = [];
    if (App.settings.deletedUserIds.indexOf(id) < 0) App.settings.deletedUserIds.push(id);
    await App.touchAndSaveSettings();
    await dbDelete('users', id);
    if (navigator.onLine) { try { await Cloud.deleteRow('users', id); } catch(e){ console.error('Cloud delete user:', e); } }
    App.toast('User deleted', 'success');
    this.renderUsers();
    App.populateLoginUsers();
  },

  resetPassword() {
    var newPass = 'pass' + Math.floor(Math.random() * 9000 + 1000);
    var el = document.getElementById('mu_password');
    if (el) { el.value = newPass; el.focus(); }
    App.toast('Password generated: ' + newPass + ' — click Save to apply', 'success');
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
    cats.sort((a,b) => (a.name||'').localeCompare(b.name||'', undefined, {numeric: true}));
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
    if (App.settings.deletedCategoryNames) {
      App.settings.deletedCategoryNames = App.settings.deletedCategoryNames.filter(function(n){ return n !== name; });
      await App.touchAndSaveSettings();
    }
    await dbPut('categories', cat);
    this.closeModal();
    App.toast('Category saved', 'success');
    this.renderCategories();
    Cloud.syncUpAdmin();
  },

  async deleteCategory(id) {
    const c = await dbGet('categories', id);
    if (!confirm(`Delete category "${c.name}"?`)) return;
    if (!App.settings.deletedCategoryNames) App.settings.deletedCategoryNames = [];
    if (c.name && App.settings.deletedCategoryNames.indexOf(c.name) < 0) App.settings.deletedCategoryNames.push(c.name);
    await dbDelete('categories', id);
    if (navigator.onLine) {
      try { await Cloud.deleteRow('categories', id); } catch(e){ console.error('Cloud delete category:', e); }
      // Also delete any cloud rows with the same name (duplicates get new IDs)
      try {
        var cloudCats = await Cloud.fetchAll('categories');
        for (var ci = 0; ci < cloudCats.length; ci++) {
          if ((cloudCats[ci].name || '') === c.name) {
            try { await Cloud.deleteRow('categories', cloudCats[ci].id); } catch(e2){}
          }
        }
      } catch(e3){}
    }
    await App.touchAndSaveSettings();
    App.toast('Category deleted', 'success');
    this.renderCategories();
    Cloud.syncUpAdmin();
  },

  closeModal() {
    document.getElementById('modalOverlay').classList.remove('open');
  },

  getUserRoles() {
    return (App.settings && App.settings.userRoles && App.settings.userRoles.length)
      ? App.settings.userRoles.slice() : ['admin','salesperson'];
  },

  async addRoleOption() {
    var name = prompt('Enter new role name:', '');
    if (!name || !name.trim()) return;
    name = name.trim();
    var roles = this.getUserRoles();
    if (roles.map(function(r){ return r.toLowerCase(); }).indexOf(name.toLowerCase()) >= 0) {
      App.toast('Role already exists', 'error'); return;
    }
    roles.push(name);
    App.settings.userRoles = roles;
    await App.touchAndSaveSettings();
    var sel = document.getElementById('mu_role');
    if (sel) {
      var opt = document.createElement('option');
      opt.value = name; opt.textContent = name; opt.selected = true;
      sel.appendChild(opt);
    }
    App.toast('Role “' + name + '” added — it will appear in the dropdown', 'success');
    Cloud.syncUpAdmin();
  },

  async deleteRoleOption() {
    var sel = document.getElementById('mu_role');
    if (!sel || sel.selectedIndex < 0) { App.toast('Select a role to delete', 'error'); return; }
    var role = sel.value;
    var roles = this.getUserRoles();
    if (roles.length <= 1) { App.toast('At least one role must remain', 'error'); return; }
    var remaining = roles.filter(function(r){ return r !== role; });
    var reassignTo = remaining[0];
    // Find users currently on this role
    var users = await dbGetAll('users');
    var affected = users.filter(function(u){ return u.role === role; });
    var msg = 'Delete role "' + role + '"?';
    if (affected.length > 0) msg += '\n' + affected.length + ' user(s) with this role will be reassigned to "' + reassignTo + '".';
    if (role === 'admin' && currentUser && currentUser.role === 'admin') {
      msg += '\n\nWARNING: deleting the Admin role will remove your own admin access!';
    }
    if (!confirm(msg)) return;
    App.settings.userRoles = remaining;
    await App.touchAndSaveSettings();
    // Reassign affected users to the first remaining role
    for (var i = 0; i < affected.length; i++) {
      affected[i].role = reassignTo;
      affected[i].updatedAt = new Date().toISOString();
      await dbPut('users', affected[i]);
    }
    // Update current user if their own role was deleted
    if (currentUser && currentUser.role === role) {
      currentUser.role = reassignTo;
      localStorage.setItem('cn_user', JSON.stringify(currentUser));
      var roleEl = document.getElementById('drawerUserRole');
      if (roleEl) roleEl.textContent = reassignTo.charAt(0).toUpperCase() + reassignTo.slice(1);
    }
    // Rebuild the dropdown without the deleted role
    if (sel) {
      sel.innerHTML = '';
      remaining.forEach(function(r) {
        var o = document.createElement('option');
        o.value = r;
        o.textContent = r.charAt(0).toUpperCase() + r.slice(1);
        sel.appendChild(o);
      });
    }
    for (var ai = 0; ai < affected.length; ai++) {
      try { await Cloud.syncUpUser(affected[ai]); } catch(e){}
    }
    Cloud.syncUpAdmin();
    App.toast('Role "' + role + '" deleted', 'success');
  },

  renderSettings() {
    document.getElementById('setCompanyName').value = App.settings.companyName || '';
    document.getElementById('setEventName').value = App.settings.eventName || '';
    document.getElementById('setVenue').value = App.settings.venue || '';
    document.getElementById('setLeadSource').value = App.settings.leadSource || '';
    var ocrEl = document.getElementById('setOcrKey');
    if (ocrEl) ocrEl.value = App.settings.ocrApiKey || '';
    // Load dropdown options
    var dd = App.settings.dropdownOptions || {};
    var vtEl = document.getElementById('setVisitorTypes');
    if (vtEl) vtEl.value = dd.visitorTypes || DEFAULT_VISITOR_TYPES.join('\n');
    var prEl = document.getElementById('setPriorities');
    if (prEl) prEl.value = dd.priorities || DEFAULT_PRIORITIES.join('\n');
    var voEl = document.getElementById('setVolumes');
    if (voEl) voEl.value = dd.volumes || DEFAULT_VOLUMES.join('\n');
    var tlEl = document.getElementById('setTimelines');
    if (tlEl) tlEl.value = dd.timelines || DEFAULT_TIMELINES.join('\n');
    var futEl = document.getElementById('setFollowUpTypes');
    if (futEl) futEl.value = dd.followUpTypes || DEFAULT_FOLLOWUP_TYPES.join('\n');
    var fusEl = document.getElementById('setFollowUpStatuses');
    if (fusEl) fusEl.value = dd.followUpStatuses || DEFAULT_FOLLOWUP_STATUSES.join('\n');
  },

  async saveDropdownOptions() {
    App.settings.dropdownOptions = {
      visitorTypes: document.getElementById('setVisitorTypes').value,
      priorities: document.getElementById('setPriorities').value,
      volumes: document.getElementById('setVolumes').value,
      timelines: document.getElementById('setTimelines').value,
      followUpTypes: document.getElementById('setFollowUpTypes').value,
      followUpStatuses: document.getElementById('setFollowUpStatuses').value
    };
    await App.touchAndSaveSettings();
    App.toast('Dropdown options saved', 'success');
    Cloud.syncUpAdmin();
  },

  async saveSettings() {
    var ocrEl = document.getElementById('setOcrKey');
    App.settings.companyName = document.getElementById('setCompanyName').value;
    App.settings.eventName = document.getElementById('setEventName').value;
    App.settings.venue = document.getElementById('setVenue').value;
    App.settings.leadSource = document.getElementById('setLeadSource').value;
    App.settings.ocrApiKey = ocrEl ? ocrEl.value.trim() : (App.settings.ocrApiKey || '');
    await App.touchAndSaveSettings();
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
var lpEl = document.getElementById('loginPass');
if (lpEl) lpEl.addEventListener('keydown', function(e) { if (e.key === 'Enter') App.doLogin(); });

// Initialize app on load
window.addEventListener('DOMContentLoaded', () => App.init());
