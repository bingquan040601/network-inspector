"use strict";

// ── State ──────────────────────────────────────────────────────────────────
let allRequests = [];
let mockRules = [];
let selectedRequestId = null;
let selectedMockId = null; // null = new rule being created
let captureTab = "reqHeaders";
let currentTabId = null; // filled by INIT; used so detach doesn't need a tab query

// ── DOM ────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const toggle = $("enableToggle");
const reqCount = $("reqCount");
const mockCount = $("mockCount");
const tabCapture = $("tabCapture");
const tabMocks = $("tabMocks");
const clearBtn = $("clearBtn");
const detachBtn = $("detachBtn");
const captureView = $("captureView");
const mocksView = $("mocksView");

// ── Window mode (opened via detach button) ─────────────────────────────────
if (new URLSearchParams(location.search).get("mode") === "window") {
  document.body.classList.add("windowed");
}

// Capture
const urlFilter = $("urlFilter");
const methodFilter = $("methodFilter");
const reloadPageBtn = $("reloadPageBtn");
const emptyState = $("emptyState");
const requestList = $("requestList");
const detailPanel = $("detailPanel");
const noDetail = $("noDetail");
const dMethod = $("dMethod");
const dUrl = $("dUrl");
const dStatus = $("dStatus");
const dDuration = $("dDuration");
const dKind = $("dKind");
const dTime = $("dTime");
const dMockedBadge = $("dMockedBadge");
const closeDetail = $("closeDetail");
const captureTabs = $("captureTabs");
const tabContent = $("tabContent");
const mockItBtn = $("mockItBtn");

// Mocks
const newMockBtn = $("newMockBtn");
const exportBtn = $("exportBtn");
const importInput = $("importInput");
const mockEmptyState = $("mockEmptyState");
const mockList = $("mockList");
const editorPlaceholder = $("editorPlaceholder");
const mockForm = $("mockForm");
const fName = $("fName");
const fUrlPattern = $("fUrlPattern");
const fMatchType = $("fMatchType");
const fMethod = $("fMethod");
const fDelay = $("fDelay");
const fStatus = $("fStatus");
const fStatusText = $("fStatusText");
const fRespHeaders = $("fRespHeaders");
const fRespBody = $("fRespBody");
const formatBodyBtn = $("formatBodyBtn");
const cancelMockBtn = $("cancelMockBtn");

// ── Background port ────────────────────────────────────────────────────────
// In windowed mode the tabId from the URL is encoded directly in the port name
// (popup-123) so background can extract it synchronously from onConnect —
// zero async operations, zero timing dependencies.
const _urlTabId = parseInt(new URLSearchParams(location.search).get("tabId"));
let port = createPort();

function createPort() {
  const p = chrome.runtime.connect({
    name: _urlTabId > 0 ? `popup-${_urlTabId}` : "popup",
  });

  // Send SET_TAB so background knows which tab to monitor (normal popup only).
  if (!(_urlTabId > 0)) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.find(
        (t) => t.id && t.url && !t.url.startsWith("chrome"),
      );
      console.log(
        "[NS popup] currentWindow tabs:",
        tabs?.map((t) => `${t.id}:${t.url?.slice(0, 40)}`),
      );
      if (tab) {
        console.log("[NS popup] SET_TAB", tab.id);
        p.postMessage({ type: "SET_TAB", tabId: tab.id });
      } else {
        chrome.tabs.query({ active: true }, (allTabs) => {
          const web = allTabs?.find(
            (t) => t.id && t.url && !t.url.startsWith("chrome"),
          );
          console.log(
            "[NS popup] fallback tab:",
            web?.id,
            web?.url?.slice(0, 40),
          );
          if (web) p.postMessage({ type: "SET_TAB", tabId: web.id });
        });
      }
    });
  }

  p.onMessage.addListener((msg) => {
    if (msg.type === "INIT") {
      currentTabId = msg.tabId;
      toggle.checked = msg.enabled;
      allRequests = [...msg.requests].reverse();
      mockRules = msg.mockRules || [];
      renderCaptureList();
      renderMockList();
      clearTimeout(_initTimeout);
      document.getElementById("connStatus").textContent = `tab:${msg.tabId}`;
    } else if (msg.type === "NEW_REQUEST") {
      allRequests.unshift(msg.data);
      renderCaptureList();
    } else if (msg.type === "CLEAR") {
      allRequests = [];
      selectedRequestId = null;
      renderCaptureList();
      showDetail(false);
    } else if (msg.type === "REPLACE_REQUEST") {
      // webRequest added a no-body entry first; interceptor now has full data.
      const idx = allRequests.findIndex(
        (r) => String(r.id) === String(msg.oldId),
      );
      if (idx >= 0) allRequests[idx] = msg.data;
      else allRequests.unshift(msg.data);
      renderCaptureList();
    } else if (msg.type === "RULES_UPDATED") {
      mockRules = msg.mockRules || [];
      renderMockList();
      if (selectedMockId) openEditor(selectedMockId);
    }
  });

  p.onDisconnect.addListener(() => {
    document.getElementById("connStatus").textContent = "🔄";
    setTimeout(() => {
      port = createPort();
    }, 400);
  });

  return p;
}

// Wrap postMessage so port errors don't silently fail.
function send(msg) {
  try {
    port.postMessage(msg);
  } catch (_) {
    document.getElementById("connStatus").textContent = "⚠️ lost";
  }
}

// Show ❌ if INIT never arrives — helps diagnose connection failure.
const _initTimeout = setTimeout(() => {
  document.getElementById("connStatus").textContent = "❌ no INIT";
}, 3000);

// Tell background which tab to watch before it can send INIT.
// Popup has the correct browser-window context, background service worker does not.
// • Windowed mode: tabId is in the URL (written at detach time) — no query needed.
// • Normal mode:  query with lastFocusedWindow which is the browser window the
//                 user just clicked the extension icon in.

// ── View switching ─────────────────────────────────────────────────────────
tabCapture.addEventListener("click", () => switchView("capture"));
tabMocks.addEventListener("click", () => switchView("mocks"));

function switchView(v) {
  const isCap = v === "capture";
  tabCapture.classList.toggle("active", isCap);
  tabMocks.classList.toggle("active", !isCap);
  captureView.classList.toggle("hidden", !isCap);
  mocksView.classList.toggle("hidden", isCap);
}

// ── Detach to standalone window ────────────────────────────────────────────
detachBtn.addEventListener("click", () => {
  const tid = currentTabId;
  // Belt-and-suspenders: pass tabId both in the URL (synchronous, always arrives)
  // and in session storage (async backup in case URL param is lost somehow).
  if (tid) chrome.storage.session.set({ ns_detach_tabId: tid });

  chrome.windows.create({
    url:
      chrome.runtime.getURL("popup.html") +
      `?mode=window${tid ? `&tabId=${tid}` : ""}`,
    type: "popup",
    width: 980,
    height: 640,
  });
});

// ── Reload page ────────────────────────────────────────────────────────────
async function doReloadPage() {
  console.log("reloadPageBtn", reloadPageBtn);
  reloadPageBtn.classList.add("spinning");

  // Resolve the tab to reload: prefer currentTabId (from INIT), fall back to
  // querying the active tab in the current window.
  let tid = currentTabId;
  if (!tid) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tid = tabs[0]?.id;
  }

  if (tid) {
    // executeScript directly from popup context — no port/background needed.
    chrome.scripting
      .executeScript({ target: { tabId: tid }, func: () => location.reload() })
      .catch(() => chrome.tabs.reload(tid).catch(() => {}));
  }

  setTimeout(() => reloadPageBtn.classList.remove("spinning"), 900);
}

reloadPageBtn.addEventListener("click", doReloadPage);

// Intercept F5 / Cmd+R / Ctrl+R so the keyboard shortcut reloads the
// monitored page instead of this popup window.
document.addEventListener(
  "keydown",
  (e) => {
    if (
      e.key === "F5" ||
      ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r")
    ) {
      e.preventDefault();
      e.stopImmediatePropagation();
      doReloadPage();
    }
  },
  true,
);

// ── Capture controls ───────────────────────────────────────────────────────
toggle.addEventListener("change", () =>
  send({ type: "SET_ENABLED", enabled: toggle.checked }),
);
clearBtn.addEventListener("click", () => send({ type: "CLEAR" }));
urlFilter.addEventListener("input", renderCaptureList);
methodFilter.addEventListener("change", renderCaptureList);
closeDetail.addEventListener("click", () => {
  selectedRequestId = null;
  showDetail(false);
});

// ── Capture rendering ──────────────────────────────────────────────────────
function filteredRequests() {
  const url = urlFilter.value.toLowerCase();
  const method = methodFilter.value;
  return allRequests.filter(
    (r) =>
      (!url || r.url.toLowerCase().includes(url)) &&
      (!method || r.method === method),
  );
}

function renderCaptureList() {
  const rows = filteredRequests();
  reqCount.textContent = allRequests.length;

  emptyState.style.display = rows.length ? "none" : "flex";
  requestList.style.display = rows.length ? "block" : "none";
  requestList.innerHTML = "";

  rows.forEach((req) => {
    const row = document.createElement("div");
    row.className =
      "req-row" + (req.id === selectedRequestId ? " selected" : "");
    row.dataset.id = req.id;

    row.innerHTML = `
      <span class="method-badge ${methodColor(req.method)}">${req.method}</span>
      <div class="req-info">
        <div class="req-url" title="${esc(req.url)}">${esc(shortUrl(req.url))}</div>
        <div class="req-meta">
          <span class="status-text ${statusColor(req.status)}">${req.status || "ERR"}</span>
          <span>${req.duration}ms</span>
          ${req.isMocked ? '<span class="mock-chip">MOCK</span>' : ""}
        </div>
      </div>`;

    row.addEventListener("click", () => selectRequest(req.id));
    requestList.appendChild(row);
  });
}

function selectRequest(id) {
  selectedRequestId = id;
  document
    .querySelectorAll("#requestList .req-row")
    .forEach((el) => el.classList.toggle("selected", el.dataset.id === id));

  const req = allRequests.find((r) => r.id === id);
  if (!req) return;

  dMethod.textContent = req.method;
  dMethod.className = `method-badge ${methodColor(req.method)}`;
  dUrl.textContent = req.url;
  dUrl.title = req.url;
  dStatus.textContent = req.status
    ? `${req.status} ${req.statusText}`
    : req.error || "Error";
  dStatus.className = `status-text ${statusColor(req.status)}`;
  dDuration.textContent = `${req.duration}ms`;
  dKind.textContent = req.kind;
  dTime.textContent = new Date(req.ts).toLocaleTimeString();
  dMockedBadge.classList.toggle("hidden", !req.isMocked);

  showDetail(true);
  renderCaptureTab();
}

function showDetail(show) {
  detailPanel.classList.toggle("hidden", !show);
  noDetail.classList.toggle("hidden", show);
}

captureTabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  captureTab = btn.dataset.tab;
  document
    .querySelectorAll("#captureTabs .tab")
    .forEach((t) => t.classList.toggle("active", t === btn));
  renderCaptureTab();
});

function renderCaptureTab() {
  const req = allRequests.find((r) => r.id === selectedRequestId);
  if (!req) return;
  if (captureTab === "reqHeaders")
    tabContent.innerHTML = renderKv(req.reqHeaders);
  else if (captureTab === "reqBody")
    tabContent.innerHTML = renderBody(req.reqBody);
  else tabContent.innerHTML = renderBody(req.respBody);
}

// ── "Mock It" — pre-fill editor from captured request ─────────────────────
mockItBtn.addEventListener("click", () => {
  const req = allRequests.find((r) => r.id === selectedRequestId);
  if (!req) return;
  switchView("mocks");
  openEditor(null, {
    name: "",
    urlPattern: shortUrl(req.url),
    matchType: "contains",
    method: req.method,
    delay: 0,
    response: {
      status: req.status || 200,
      statusText: req.statusText || "OK",
      headers: { "Content-Type": "application/json" },
      body: req.respBody || "",
    },
  });
});

// ── Mock list ──────────────────────────────────────────────────────────────
function renderMockList() {
  mockCount.textContent = mockRules.length;
  mockEmptyState.style.display = mockRules.length ? "none" : "flex";
  mockList.style.display = mockRules.length ? "block" : "none";
  mockList.innerHTML = "";

  mockRules.forEach((rule) => {
    const row = document.createElement("div");
    row.className =
      "mock-row" + (rule.id === selectedMockId ? " selected" : "");
    row.dataset.id = rule.id;

    const label = esc(rule.name || rule.urlPattern || "(unnamed)");
    const mc = methodColor(rule.method);
    const sc = statusColor(rule.response?.status || 200);

    row.innerHTML = `
      <label class="mock-toggle" title="开启/关闭">
        <input type="checkbox" ${rule.enabled ? "checked" : ""}>
        <span class="mini-slider"></span>
      </label>
      <div class="mock-row-info">
        <div class="mock-row-name" title="${label}">${label}</div>
        <div class="mock-row-meta">
          <span class="method-badge ${mc}">${rule.method}</span>
          <span class="status-text ${sc}">${rule.response?.status || 200}</span>
          ${rule.delay ? `<span>${rule.delay}ms</span>` : ""}
          <span style="opacity:.55">${rule.matchType}</span>
        </div>
      </div>
      <div class="mock-row-actions">
        <button class="mock-del-btn" title="删除">×</button>
      </div>`;

    row
      .querySelector("input[type=checkbox]")
      .addEventListener("change", (e) => {
        e.stopPropagation();
        send({ type: "TOGGLE_RULE", id: rule.id, enabled: e.target.checked });
      });

    row.querySelector(".mock-del-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const name = rule.name || rule.urlPattern || "this rule";
      if (!confirm(`Delete "${name}"?`)) return;
      send({ type: "DELETE_RULE", id: rule.id });
      if (selectedMockId === rule.id) closeEditor();
    });

    row.addEventListener("click", (e) => {
      if (e.target.closest(".mock-toggle") || e.target.closest(".mock-del-btn"))
        return;
      openEditor(rule.id);
    });

    mockList.appendChild(row);
  });
}

// ── Mock editor ────────────────────────────────────────────────────────────
newMockBtn.addEventListener("click", () => openEditor(null));
cancelMockBtn.addEventListener("click", closeEditor);

function doSaveRule() {
  if (!fUrlPattern.value.trim()) {
    fUrlPattern.style.outline = "2px solid var(--danger)";
    fUrlPattern.focus();
    setTimeout(() => {
      fUrlPattern.style.outline = "";
    }, 1500);
    return;
  }

  let respHeaders = {};
  try {
    respHeaders = JSON.parse(fRespHeaders.value || "{}");
  } catch (_) {}

  const rule = {
    id: selectedMockId || uid(),
    enabled: selectedMockId
      ? (mockRules.find((r) => r.id === selectedMockId)?.enabled ?? true)
      : true,
    name: fName.value.trim(),
    urlPattern: fUrlPattern.value.trim(),
    matchType: fMatchType.value,
    method: fMethod.value,
    delay: Math.max(0, parseInt(fDelay.value) || 0),
    response: {
      status: Math.min(599, Math.max(100, parseInt(fStatus.value) || 200)),
      statusText: fStatusText.value.trim() || "OK",
      headers: respHeaders,
      body: fRespBody.value,
    },
  };

  selectedMockId = rule.id;

  const btn = $("saveMockBtn");
  const orig = btn.textContent;
  try {
    send({ type: "SAVE_RULE", rule });
    btn.textContent = "✓ Saved";
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = orig;
      btn.disabled = false;
    }, 1200);
  } catch (err) {
    btn.textContent = "✗ Error";
    setTimeout(() => {
      btn.textContent = orig;
    }, 1500);
  }
}

$("saveMockBtn").addEventListener("click", doSaveRule);
mockForm.addEventListener("submit", (e) => {
  e.preventDefault();
  doSaveRule();
});

function openEditor(id, prefill) {
  selectedMockId = id;
  document
    .querySelectorAll("#mockList .mock-row")
    .forEach((el) => el.classList.toggle("selected", el.dataset.id === id));

  const rule = id ? mockRules.find((r) => r.id === id) : null;
  const src = prefill || rule;

  editorPlaceholder.classList.add("hidden");
  mockForm.classList.remove("hidden");

  if (src) {
    fName.value = src.name || "";
    fUrlPattern.value = src.urlPattern || "";
    fMatchType.value = src.matchType || "contains";
    fMethod.value = src.method || "*";
    fDelay.value = src.delay || 0;
    fStatus.value = src.response?.status ?? 200;
    fStatusText.value = src.response?.statusText || "OK";
    const h = src.response?.headers;
    fRespHeaders.value =
      h && Object.keys(h).length ? JSON.stringify(h, null, 2) : "";
    fRespBody.value = src.response?.body || "";
  } else {
    mockForm.reset();
    fStatus.value = 200;
    fStatusText.value = "OK";
    fDelay.value = 0;
  }
}

function closeEditor() {
  selectedMockId = null;
  mockForm.classList.add("hidden");
  editorPlaceholder.classList.remove("hidden");
  document
    .querySelectorAll("#mockList .mock-row")
    .forEach((el) => el.classList.remove("selected"));
}

formatBodyBtn.addEventListener("click", () => {
  try {
    fRespBody.value = JSON.stringify(JSON.parse(fRespBody.value), null, 2);
  } catch (_) {
    const orig = fRespBody.style.outline;
    fRespBody.style.outline = "2px solid var(--danger)";
    setTimeout(() => {
      fRespBody.style.outline = orig;
    }, 800);
  }
});

// ── Export ─────────────────────────────────────────────────────────────────
exportBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(mockRules, null, 2)], {
    type: "application/json",
  });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: "network-sync-mocks.json",
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── Import ─────────────────────────────────────────────────────────────────
importInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const rules = JSON.parse(ev.target.result);
      if (!Array.isArray(rules)) throw new Error("Expected a JSON array");
      send({ type: "IMPORT_RULES", rules });
      closeEditor();
    } catch (err) {
      alert("Import failed: " + err.message);
    }
    importInput.value = "";
  };
  reader.readAsText(file);
});

// ── Helpers ────────────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search || url;
  } catch (_) {
    return url;
  }
}

function methodColor(m) {
  return (
    {
      GET: "m-GET",
      POST: "m-POST",
      PUT: "m-PUT",
      DELETE: "m-DELETE",
      PATCH: "m-PATCH",
      "*": "m-ANY",
      ANY: "m-ANY",
    }[m] || "m-OTHER"
  );
}

function statusColor(s) {
  if (!s) return "s-0";
  if (s < 300) return "s-2xx";
  if (s < 400) return "s-3xx";
  if (s < 500) return "s-4xx";
  return "s-5xx";
}

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderKv(obj) {
  if (!obj || !Object.keys(obj).length)
    return '<span class="empty-content">(no headers)</span>';
  const rows = Object.entries(obj)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
    .join("");
  return `<table class="kv-table"><tbody>${rows}</tbody></table>`;
}

function renderBody(body) {
  if (body == null || body === "")
    return '<span class="empty-content">(empty)</span>';
  try {
    return `<pre>${esc(JSON.stringify(JSON.parse(body), null, 2))}</pre>`;
  } catch (_) {}
  return `<pre>${esc(body)}</pre>`;
}

// ── Init ───────────────────────────────────────────────────────────────────
showDetail(false);
switchView("capture");
