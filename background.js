/**
 * background.js — MV3 Service Worker，插件的中枢
 *
 * 职责：
 *   1. 管理每个 Tab 的捕获状态（enabled / requests 列表）
 *   2. 维护 popup 的长连接端口，实时推送请求到 popup
 *   3. 存储和分发全局 Mock 规则
 *   4. 通过 webRequest API 在浏览器层兜底捕获请求
 *   5. 与 interceptor.js 去重，避免同一请求在 popup 出现两条
 *
 * 状态持久化：
 *   - Tab 状态（enabled、最近请求）→ chrome.storage.session（浏览器会话内持久）
 *   - Mock 规则 → chrome.storage.local（跨会话持久）
 */

// 每个 Tab 最多保留的请求条数（防止内存无限增长）
const MAX_REQUESTS = 500;

// tabId → { enabled: boolean, requests: object[] }
// 记录每个 Tab 是否开启捕获，以及捕获到的请求列表
const tabs = new Map();

// tabId → Port
// popup 打开时建立长连接，用于实时推送 NEW_REQUEST 等事件
const popupPorts = new Map();

// 全局 Mock 规则，所有 Tab 共享，持久化在 chrome.storage.local
let mockRules = [];

/**
 * 获取指定 Tab 的状态，不存在则自动初始化
 * 统一入口确保 tabs Map 中的对象结构一致
 */
function getTab(tabId) {
  if (!tabs.has(tabId)) tabs.set(tabId, { enabled: false, requests: [] });
  return tabs.get(tabId);
}

// ── SW 启动时从 session storage 恢复状态 ────────────────────────────────────
// MV3 的 Service Worker 会被 Chrome 随时终止再重启
// chrome.storage.session 在同一浏览器会话内跨 SW 重启保持，可用来恢复请求历史和开关状态
chrome.storage.session.get(null, (data) => {
  for (const [key, value] of Object.entries(data || {})) {
    if (key.startsWith('ns_tab_')) {
      const tabId = parseInt(key.slice(7));
      if (!isNaN(tabId)) {
        tabs.set(tabId, {
          enabled:  value.enabled  ?? false,
          requests: value.requests ?? [],
        });
      }
    }
  }
});

// ── 启动时从 local storage 加载 Mock 规则 ───────────────────────────────────
chrome.storage.local.get('mockRules', (data) => {
  mockRules = data.mockRules || [];
});

/**
 * 将指定 Tab 的状态持久化到 session storage
 * 只保留最近 100 条请求，控制存储体积
 */
function saveTabSession(tabId, tab) {
  chrome.storage.session.set({
    [`ns_tab_${tabId}`]: {
      enabled:  tab.enabled,
      requests: tab.requests.slice(-100),
    },
  });
}

/**
 * 防抖触发 session 保存
 * 请求高频时（如页面加载瞬间几十条请求）避免频繁写 storage
 */
const saveTimers = {};
function scheduleTabSave(tabId, tab) {
  clearTimeout(saveTimers[tabId]);
  saveTimers[tabId] = setTimeout(() => saveTabSession(tabId, tab), 400);
}

/**
 * 保存 Mock 规则到 local storage，并将最新规则推送到所有已知 Tab
 * 双路推送：content script（如果在运行）+ 直接注入 MAIN world（更可靠）
 */
function saveMockRules() {
  chrome.storage.local.set({ mockRules });
  for (const [tabId, tabState] of tabs) {
    chrome.tabs.sendMessage(tabId, { type: 'UPDATE_RULES', rules: mockRules }).catch(() => {});
    syncToMainWorld(tabId, tabState.enabled, mockRules);
  }
}

/**
 * 通知当前连接的 popup 规则已更新
 * popup 收到后刷新 Mock 规则列表
 */
function notifyPopup(port) {
  port.postMessage({ type: 'RULES_UPDATED', mockRules });
}

// ── webRequest 兜底捕获 ─────────────────────────────────────────────────────
//
// 工作原理：
//   interceptor.js（页面层）可以拿到完整的请求/响应 body
//   webRequest（浏览器层）可靠但拿不到 response body（MV3 限制）
//
// 双路去重策略：
//   Case A - interceptor 先到：_intercepted 标记 → webRequest 命中后直接跳过
//   Case B - webRequest 先到：_webReqs 存条目 ID → interceptor 来了发 REPLACE_REQUEST
//                             popup 原地替换那条无 body 的条目为有 body 的完整版
//
// 去重窗口 DEDUP_TTL：两路之间的时间差通常在数百毫秒内
const _reqStart    = {};         // requestId → 请求开始时间戳
const _intercepted = new Map();  // key → true（interceptor 已上报，webRequest 可跳过）
const _webReqs     = new Map();  // key → requestId（webRequest 先上报，等 interceptor 替换）
const DEDUP_TTL    = 2500;       // 去重窗口，超时自动清理，单位 ms

// 记录请求开始时间，用于后续计算耗时
chrome.webRequest.onBeforeRequest.addListener(
  (d) => { if (d.tabId > 0) _reqStart[d.requestId] = d.timeStamp; },
  { urls: ['<all_urls>'], types: ['xmlhttprequest'] }
);

chrome.webRequest.onCompleted.addListener(
  (d) => {
    if (d.tabId < 1) return;
    // OPTIONS 是浏览器自动发出的 CORS 预检，对用户透明，不需要展示
    if (d.method === 'OPTIONS') return;

    const tab = getTab(d.tabId);
    if (!tab.enabled) return; // 未开启捕获，忽略

    const key = `${d.tabId}|${d.url}|${d.method}`;

    // Case A：interceptor 已经用完整数据上报过，webRequest 无需重复
    if (_intercepted.has(key)) {
      _intercepted.delete(key);
      delete _reqStart[d.requestId];
      return;
    }

    const ts = _reqStart[d.requestId] ?? d.timeStamp;
    delete _reqStart[d.requestId];

    // 构建无 body 的基础条目（webRequest 拿不到响应体）
    const req = {
      id:         d.requestId,
      url:        d.url,
      method:     d.method,
      status:     d.statusCode,
      statusText: String(d.statusCode),
      duration:   Math.round(d.timeStamp - ts),
      ts:         Math.round(ts),
      kind:       'fetch',
      reqHeaders: {}, reqBody: null, respBody: null,
    };

    // Case B：webRequest 先到，记录此条目 ID，等 interceptor 来替换完整数据
    _webReqs.set(key, d.requestId);
    setTimeout(() => _webReqs.delete(key), DEDUP_TTL);

    tab.requests.push(req);
    if (tab.requests.length > MAX_REQUESTS) tab.requests.shift();
    popupPorts.get(d.tabId)?.postMessage({ type: 'NEW_REQUEST', data: req });
    scheduleTabSave(d.tabId, tab);
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest'] }
);

// 请求失败时清理开始时间记录，防止内存泄漏
chrome.webRequest.onErrorOccurred.addListener(
  (d) => { delete _reqStart[d.requestId]; },
  { urls: ['<all_urls>'], types: ['xmlhttprequest'] }
);

// ── 接收 content script 消息 ────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  // content script 页面加载时拉取当前开关状态
  if (msg.type === 'GET_STATUS') {
    sendResponse({ enabled: tabId ? getTab(tabId).enabled : false });
    return false;
  }

  // content script 页面加载时拉取当前 Mock 规则
  if (msg.type === 'GET_RULES') {
    sendResponse({ rules: mockRules });
    return false;
  }

  // interceptor.js 捕获到请求，由 content.js 转发过来
  if (msg.type === 'NEW_REQUEST' && tabId) {
    const tab = getTab(tabId);
    if (!tab.enabled) return false;

    const key = `${tabId}|${msg.data.url}|${msg.data.method}`;

    if (_webReqs.has(key)) {
      // Case B 处理：webRequest 已先建了无 body 的条目，interceptor 带着完整数据来了
      // 原地替换，popup 收到 REPLACE_REQUEST 后会找到旧条目并更新，不产生重复行
      const oldId = _webReqs.get(key);
      _webReqs.delete(key);
      const idx = tab.requests.findIndex(r => r.id === oldId);
      if (idx >= 0) {
        tab.requests[idx] = msg.data;
        popupPorts.get(tabId)?.postMessage({ type: 'REPLACE_REQUEST', oldId, data: msg.data });
        scheduleTabSave(tabId, tab);
        return false;
      }
    }

    // Case A 标记：interceptor 先到，通知后续 webRequest 可以跳过
    _intercepted.set(key, true);
    setTimeout(() => _intercepted.delete(key), DEDUP_TTL);

    tab.requests.push(msg.data);
    if (tab.requests.length > MAX_REQUESTS) tab.requests.shift();
    popupPorts.get(tabId)?.postMessage({ type: 'NEW_REQUEST', data: msg.data });
    scheduleTabSave(tabId, tab);
    return false;
  }
});

// ── popup 长连接管理 ────────────────────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  console.log('[NS] popup connected, port.name:', port.name);

  // 独立窗口模式：tabId 直接编码在 port name 里（popup-123）
  // 这样不需要任何异步查询，直接建连
  const m = port.name.match(/^popup-(\d+)$/);
  if (m) {
    console.log('[NS] windowed mode, tabId:', m[1]);
    attachPopup(port, parseInt(m[1]));
    return;
  }
  if (port.name !== 'popup') return;

  // 普通 popup 模式：等待 popup.js 发来 SET_TAB（包含当前 active tab 的 ID）
  // 由 popup.js 查询 currentWindow 的 tab，比在 background 里查更可靠
  port.onMessage.addListener(function onSetTab(msg) {
    if (msg.type !== 'SET_TAB' || !msg.tabId) return;
    port.onMessage.removeListener(onSetTab); // 一次性监听器
    console.log('[NS] SET_TAB received, tabId:', msg.tabId);
    attachPopup(port, msg.tabId);
  });
});

/**
 * 直接往页面 MAIN world 推送 enabled 和 rules
 * 通过 executeScript 在 MAIN world 执行 postMessage，绕过 content script 中间层
 * 在 content script 失效（扩展重载）或 postMessage 通信中断时仍然可靠
 */
function syncToMainWorld(tabId, enabled, rules) {
  chrome.scripting.executeScript({
    target: { tabId },
    world:  'MAIN',
    func:   (en, rls) => {
      window.postMessage({ __ns: 'ctrl',  enabled: en  }, '*');
      window.postMessage({ __ns: 'rules', rules:   rls }, '*');
    },
    args: [enabled, rules],
  }).catch(() => {});
}

/**
 * 将 popup 与指定 Tab 关联，完成初始化握手
 *
 * 步骤：
 *   1. await 注入 interceptor.js（确保监听器就绪再推状态）
 *   2. 直接向 MAIN world 推送 enabled + rules（最可靠路径）
 *   3. 同时通知 content script（belt-and-suspenders）
 *   4. 发送 INIT 消息给 popup（包含历史请求列表和 Mock 规则）
 *   5. 注册 popup 消息处理器（开关、清空、Mock CRUD 等）
 *   6. 断连时清理 popupPorts
 */
async function attachPopup(port, tabId) {
  if (!tabId || typeof tabId !== 'number') {
    console.error('[NS] attachPopup: invalid tabId', tabId);
    return;
  }
  console.log('[NS] attachPopup tabId:', tabId, 'prev:', port._tabId);

  // 如果 popup 切换了监控 Tab，先清理旧 Tab 的端口映射
  if (port._tabId && port._tabId !== tabId) popupPorts.delete(port._tabId);
  port._tabId = tabId;
  popupPorts.set(tabId, port);

  const tab = getTab(tabId);

  // 步骤 1：注入 interceptor.js 并等待完成
  // await 保证下一步 postMessage 时，interceptor 的 message 监听器已经注册好
  await chrome.scripting.executeScript({
    target: { tabId },
    files:  ['interceptor.js'],
    world:  'MAIN',
  }).catch(() => {});

  // 步骤 2：直接推送状态到 MAIN world（不依赖 content script）
  syncToMainWorld(tabId, tab.enabled, mockRules);

  // 步骤 3：同时通知 content script（兼容 content script 正常运行的场景）
  chrome.tabs.sendMessage(tabId, { type: 'SET_ENABLED', enabled: tab.enabled }).catch(() => {});

  // 步骤 4：发送初始化数据给 popup
  port.postMessage({
    type: 'INIT',
    tabId,
    enabled:  tab.enabled,
    requests: tab.requests,
    mockRules,
  });

  // 步骤 5：注册 popup 消息处理器
  port.onMessage.addListener((msg) => {

    if (msg.type === 'SET_ENABLED') {
      // 用户拨动开关
      tab.enabled = msg.enabled;
      chrome.tabs.sendMessage(tabId, { type: 'SET_ENABLED', enabled: msg.enabled }).catch(() => {});
      syncToMainWorld(tabId, msg.enabled, mockRules); // 直接通知 interceptor
      saveTabSession(tabId, tab);

    } else if (msg.type === 'RELOAD_TAB') {
      // 用户点击"刷新页面"按钮
      // executeScript 方式比 chrome.tabs.reload 在 SW 环境下更可靠
      chrome.scripting.executeScript({
        target: { tabId },
        func:   () => location.reload(),
      }).catch(() => {
        chrome.tabs.reload(tabId).catch(() => {}); // fallback
      });

    } else if (msg.type === 'CLEAR') {
      // 清空当前 Tab 的请求历史
      tab.requests = [];
      port.postMessage({ type: 'CLEAR' });
      saveTabSession(tabId, tab);

    } else if (msg.type === 'SAVE_RULE') {
      // 新增或更新一条 Mock 规则（通过 ID 判断是新增还是更新）
      const idx = mockRules.findIndex(r => r.id === msg.rule.id);
      if (idx >= 0) mockRules[idx] = msg.rule;
      else mockRules.push(msg.rule);
      saveMockRules();
      notifyPopup(port);

    } else if (msg.type === 'DELETE_RULE') {
      mockRules = mockRules.filter(r => r.id !== msg.id);
      saveMockRules();
      notifyPopup(port);

    } else if (msg.type === 'TOGGLE_RULE') {
      // 切换单条规则的启用/禁用状态
      const rule = mockRules.find(r => r.id === msg.id);
      if (rule) rule.enabled = msg.enabled;
      saveMockRules();
      notifyPopup(port);

    } else if (msg.type === 'IMPORT_RULES') {
      // 批量导入规则（覆盖现有）
      mockRules = msg.rules;
      saveMockRules();
      notifyPopup(port);
    }
  });

  // 步骤 6：popup 关闭时清理端口映射
  // 判断是否是当前注册的 port，避免误删新 popup 的映射（快速重连场景）
  port.onDisconnect.addListener(() => {
    if (popupPorts.get(tabId) === port) popupPorts.delete(tabId);
  });
}

// Tab 关闭时释放内存
chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  popupPorts.delete(tabId);
});
