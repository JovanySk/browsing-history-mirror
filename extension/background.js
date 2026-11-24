importScripts("db.js");

function isOwnExtensionUrl(url) {
  try { return String(url || "").startsWith(chrome.runtime.getURL("")); }
  catch { return false; }
}

function broadcast(payload) {
  try {
    chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
  } catch {}
}

async function getDeviceId() {
  const cur = await chrome.storage.local.get("mirrorDeviceId");
  if (cur.mirrorDeviceId) return cur.mirrorDeviceId;
  const id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await chrome.storage.local.set({ mirrorDeviceId: id });
  return id;
}

function isShareableWebUrl(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

function platformInfo() {
  const ua = navigator.userAgent || "";
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  let os = platform || "Desconocido";
  if (/Windows/i.test(ua + " " + platform)) os = "Windows";
  else if (/Mac/i.test(ua + " " + platform)) os = "macOS";
  else if (/CrOS/i.test(ua + " " + platform)) os = "ChromeOS";
  else if (/Linux/i.test(ua + " " + platform)) os = "Linux";
  const mobile = !!navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(ua);
  return {
    deviceType: mobile ? "Celular / tablet" : "Computadora",
    platform: os
  };
}

async function getPresenceSettings() {
  const s = await chrome.storage.local.get([
    "presenceShareEnabled",
    "presenceDeviceName",
    "presenceLocalState"
  ]);
  return {
    enabled: !!s.presenceShareEnabled,
    deviceName: String(s.presenceDeviceName || "").trim(),
    localState: s.presenceLocalState || null
  };
}

async function publishPresence(trigger = "heartbeat") {
  const settings = await getPresenceSettings();
  if (!settings.enabled) return;

  let win = null;
  try { win = await chrome.windows.getLastFocused(); } catch {}

  let tabs = [];
  try { tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); } catch {}

  const tab = tabs[0] || null;
  const now = Date.now();
  const currentUrl = tab?.url || "";
  const shareable = isShareableWebUrl(currentUrl);
  const focused = !!win?.focused;
  const prev = settings.localState || {};

  let since = now;
  if (shareable && focused && prev.url === currentUrl && prev.active === true && Number(prev.since || 0) > 0) {
    since = Number(prev.since);
  }

  const deviceId = await getDeviceId();
  const detected = platformInfo();
  let host = "";
  try { host = shareable ? new URL(currentUrl).hostname.replace(/^www\./, "") : ""; } catch {}

  const state = {
    active: !!(shareable && focused),
    browserFocused: focused,
    url: shareable ? currentUrl : "",
    title: shareable ? (tab?.title || "") : "",
    host,
    since: shareable && focused ? since : 0,
    lastSeenAt: now,
    trigger,
    deviceId,
    deviceName: settings.deviceName || `${detected.deviceType} · ${detected.platform}`,
    deviceType: detected.deviceType,
    platform: detected.platform
  };

  await chrome.storage.local.set({ presenceLocalState: state });
  try { await chrome.storage.sync.set({ sharedPresence: state }); } catch {}
  broadcast({ type: "presence-live", state });
}

async function disablePresenceShare() {
  await chrome.storage.local.set({
    presenceShareEnabled: false,
    presenceLocalState: {
      active: false,
      browserFocused: false,
      url: "",
      title: "",
      host: "",
      since: 0,
      lastSeenAt: Date.now()
    }
  });

  try {
    const deviceId = await getDeviceId();
    const detected = platformInfo();
    const settings = await getPresenceSettings();
    await chrome.storage.sync.set({
      sharedPresence: {
        active: false,
        browserFocused: false,
        url: "",
        title: "",
        host: "",
        since: 0,
        lastSeenAt: Date.now(),
        trigger: "sharing-disabled",
        deviceId,
        deviceName: settings.deviceName || `${detected.deviceType} · ${detected.platform}`,
        deviceType: detected.deviceType,
        platform: detected.platform
      }
    });
  } catch {}
}

async function ensurePresenceAlarm() {
  try {
    await chrome.alarms.clear("presence-heartbeat");
    chrome.alarms.create("presence-heartbeat", { periodInMinutes: 0.5 });
  } catch {}
}


chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === "presence-heartbeat") {
    publishPresence("alarm").catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(() => {
  publishPresence("tab-activated").catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.title || changeInfo.status === "complete") {
    publishPresence("tab-updated").catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener(() => {
  publishPresence("tab-removed").catch(() => {});
});

chrome.windows.onFocusChanged.addListener(() => {
  publishPresence("window-focus").catch(() => {});
});

chrome.history.onVisited.addListener(async (item) => {
  if (!item?.url || isOwnExtensionUrl(item.url)) return;

  try {
    const visits = await chrome.history.getVisits({ url: item.url });
    if(!visits.length)return;
    let latest = null;
    for (const v of visits) {
      if (!latest || Number(v.visitTime) > Number(latest.visitTime)) latest = v;
    }

    await putVisit({
      visitTime: latest?.visitTime || item.lastVisitTime || Date.now(),
      url: item.url,
      title: item.title || "",
      transition: latest?.transition || "",
      referringVisitId: latest?.referringVisitId ?? null,
      visitId: latest?.visitId ?? null,
      chromeHistoryId: item.id,
      isLocal: latest?.isLocal ?? null,
      source: "live"
    });

    broadcast({ type: "mirror-change", kind: "visit", url: item.url, time: Date.now() });
  } catch {}
});

chrome.history.onVisitRemoved.addListener(async (removed) => {
  const now = Date.now();

  try {
    await putEvent({
      type: "chrome_history_deleted",
      time: now,
      details: { allHistory: !!removed.allHistory, urls: removed.urls || [] }
    });

    if (removed.allHistory) {
      await markAllChromeDeleted(now);
    } else {
      for (const url of (removed.urls || [])) {
        try {
          const current = await chrome.history.getVisits({ url });
          await reconcileMirrorUrl(url, current, now);
        } catch {}
      }
    }

    broadcast({
      type: "mirror-change",
      kind: "delete",
      allHistory: !!removed.allHistory,
      urls: removed.urls || [],
      time: now
    });
  } catch {}
});



chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "presence_get_local_info") {
    (async () => {
      try {
        const deviceId = await getDeviceId();
        const settings = await getPresenceSettings();
        const detected = platformInfo();
        sendResponse({
          ok: true,
          deviceId,
          enabled: settings.enabled,
          deviceName: settings.deviceName,
          deviceType: detected.deviceType,
          platform: detected.platform
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg.type === "presence_enable") {
    (async () => {
      try {
        const name = String(msg.deviceName || "").trim();
        await chrome.storage.local.set({
          presenceShareEnabled: true,
          presenceDeviceName: name
        });
        await ensurePresenceAlarm();
        await publishPresence("enabled");
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg.type === "presence_disable") {
    (async () => {
      try {
        await disablePresenceShare();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg.type === "presence_refresh") {
    (async () => {
      try {
        await publishPresence("manual-refresh");
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    await ensurePresenceAlarm();
    await putEvent({
      type: details.reason === "update" ? "extension_updated" : "extension_installed",
      time: Date.now(),
      details: { version: chrome.runtime.getManifest().version }
    });
  } catch {}
});

ensurePresenceAlarm().catch(() => {});
publishPresence("worker-start").catch(() => {});

importScripts('web_sync.js');
