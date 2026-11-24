
const DB_NAME = "historial_espejo_db";
const DB_VERSION = 5;
const VISITS_STORE = "visits";
const EVENTS_STORE = "events";

function openMirrorDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      const tx = req.transaction;

      let visits;
      if (!db.objectStoreNames.contains(VISITS_STORE)) {
        visits = db.createObjectStore(VISITS_STORE, { keyPath: "fingerprint" });
      } else {
        visits = tx.objectStore(VISITS_STORE);
      }

      const visitIndexes = [
        ["visitTime", "visitTime"],
        ["lastSeenAt", "lastSeenAt"],
        ["lastVerifiedAt", "lastVerifiedAt"],
        ["url", "url"],
        ["title", "title"],
        ["source", "source"],
        ["chromeState", "chromeState"]
      ];
      for (const [name, key] of visitIndexes) {
        if (!visits.indexNames.contains(name))
          visits.createIndex(name, key, { unique: false });
      }

      let events;
      if (!db.objectStoreNames.contains(EVENTS_STORE)) {
        events = db.createObjectStore(EVENTS_STORE, { keyPath: "id", autoIncrement: true });
      } else {
        events = tx.objectStore(EVENTS_STORE);
      }
      if (!events.indexNames.contains("time"))
        events.createIndex("time", "time", { unique: false });
      if (!events.indexNames.contains("type"))
        events.createIndex("type", "type", { unique: false });
    };

    req.onsuccess = () => { const db = req.result; db.onversionchange = () => db.close(); resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function normalizeUrlForKey(url) {
  try {
    const u = new URL(url || "");
    u.hash = "";
    return u.toString();
  } catch {
    return url || "";
  }
}

function visitFingerprint(v) {
  const t = Math.round(Number(v.visitTime || v.lastVisitTime || Date.now()));
  const url = normalizeUrlForKey(v.url || "");
  const visitId = v.visitId ?? "";
  return `${t}|${url}|${visitId}`;
}

async function putVisit(v) {
  const db = await openMirrorDB();
  const now = Date.now();
  const key = visitFingerprint(v);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(VISITS_STORE, "readwrite");
    const store = tx.objectStore(VISITS_STORE);
    const getReq = store.get(key);

    getReq.onsuccess = () => {
      const old = getReq.result || {};
      store.put({
        ...old,
        fingerprint: key,
        visitTime: Number(v.visitTime || v.lastVisitTime || old.visitTime || now),
        url: v.url || old.url || "",
        title: v.title || old.title || "",
        transition: v.transition || old.transition || "",
        referringVisitId: v.referringVisitId ?? old.referringVisitId ?? null,
        visitId: v.visitId ?? old.visitId ?? null,
        chromeHistoryId: v.chromeHistoryId || v.id || old.chromeHistoryId || null,
        source: v.source || old.source || "live",
        isLocal: v.isLocal ?? old.isLocal ?? null,
        capturedAt: old.capturedAt || now,
        lastSeenAt: now,
        chromeState: "present",
        deletedAt: null,
        lastVerifiedAt: now
      });
    };

    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { const e = tx.error; db.close(); reject(e); };
  });
}

async function putEvent(evt) {
  const db = await openMirrorDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EVENTS_STORE, "readwrite");
    tx.objectStore(EVENTS_STORE).add({
      type: evt.type || "info",
      time: evt.time || Date.now(),
      details: evt.details || {}
    });
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { const e = tx.error; db.close(); reject(e); };
  });
}

async function markAllChromeDeleted(deletedAt = Date.now()) {
  const db = await openMirrorDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VISITS_STORE, "readwrite");
    const req = tx.objectStore(VISITS_STORE).openCursor();

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const v = cursor.value;
      if (v.chromeState !== "deleted") {
        v.chromeState = "deleted";
        v.deletedAt = deletedAt;
        v.lastVerifiedAt = deletedAt;
        cursor.update(v);
      }
      cursor.continue();
    };

    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { const e = tx.error; db.close(); reject(e); };
  });
}

function mirrorVisitExists(record,chromeVisits){
  const usable=(chromeVisits||[]).filter(visit=>visit.visitId!==undefined&&visit.visitId!==null);
  if(record.visitId!==undefined&&record.visitId!==null&&usable.length)
    return usable.some(visit=>String(visit.visitId)===String(record.visitId));
  const time=Math.round(Number(record.visitTime||0));
  return (chromeVisits||[]).some(visit=>Math.abs(Math.round(Number(visit.visitTime||0))-time)<=1);
}

async function reconcileMirrorUrl(url, chromeVisits, verifiedAt = Date.now()) {
  const db = await openMirrorDB();
  const changed=[];

  return new Promise((resolve, reject) => {
    const tx = db.transaction(VISITS_STORE, "readwrite");
    const index = tx.objectStore(VISITS_STORE).index("url");
    const req = index.openCursor(IDBKeyRange.only(url));

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;

      const v = cursor.value;
      const present = mirrorVisitExists(v,chromeVisits);
      const nextState = present ? "present" : "deleted";

      if (v.chromeState !== nextState || !v.lastVerifiedAt) {
        v.chromeState = nextState;
        v.lastVerifiedAt = verifiedAt;
        if (present) v.deletedAt = null;
        else if (!v.deletedAt) v.deletedAt = verifiedAt;
        cursor.update(v);
        changed.push(v.fingerprint);
      }
      cursor.continue();
    };

    tx.oncomplete = () => { db.close();for(const key of changed)globalThis.bridgeQueueRecord?.('visits',key);resolve(true); };
    tx.onerror = () => { const e = tx.error; db.close(); reject(e); };
  });
}

async function queryVisits(opts = {}) {
  const {
    limit = 100,
    q = "",
    from = -Infinity,
    to = Infinity,
    deletedOnly = false
  } = opts;

  const db = await openMirrorDB();
  const needle = String(q || "").trim().toLowerCase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(VISITS_STORE, "readonly");
    const index = tx.objectStore(VISITS_STORE).index("visitTime");

    let range = null;
    if (Number.isFinite(from) || Number.isFinite(to)) {
      range = IDBKeyRange.bound(
        Number.isFinite(from) ? from : 0,
        Number.isFinite(to) ? to : Number.MAX_SAFE_INTEGER
      );
    }

    const req = index.openCursor(range, "prev");
    const out = [];
    let finished = false;

    const done = () => {
      if (finished) return;
      finished = true;
      resolve(out);
    };

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) {
        done();
        return;
      }

      const v = cursor.value;
      let ok = true;

      if (deletedOnly && v.chromeState !== "deleted") ok = false;

      if (ok && needle) {
        const hay = `${v.title || ""} ${v.url || ""}`.toLowerCase();
        if (!hay.includes(needle)) ok = false;
      }

      if (ok) out.push(v);
      cursor.continue();
    };

    req.onerror = () => reject(req.error);
    tx.oncomplete = done;
    tx.onerror = () => reject(tx.error);
  });
}

async function countStore(storeName, indexName = null, key = null) {
  const db = await openMirrorDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const source = indexName ? tx.objectStore(storeName).index(indexName) : tx.objectStore(storeName);
    const req = key === null ? source.count() : source.count(IDBKeyRange.only(key));
    req.onsuccess = () => { const n = req.result || 0; db.close(); resolve(n); };
    req.onerror = () => { const e = req.error; db.close(); reject(e); };
  });
}

async function getRecentEvents(limit = 50) {
  const db = await openMirrorDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EVENTS_STORE, "readonly");
    const req = tx.objectStore(EVENTS_STORE).index("time").openCursor(null, "prev");
    const out = [];

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) {
        resolve(out);
        return;
      }
      out.push(cursor.value);
      cursor.continue();
    };

    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
  });
}

async function getAggregationSample(limit = 5000) {
  const db = await openMirrorDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VISITS_STORE, "readonly");
    const req = tx.objectStore(VISITS_STORE).index("visitTime").openCursor(null, "prev");
    const out = [];

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) {
        resolve(out);
        return;
      }
      out.push(cursor.value);
      cursor.continue();
    };

    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
  });
}
