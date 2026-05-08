/**
 * content.js — 运行在 ISOLATED world，作为 MAIN world 与 background.js 之间的桥梁
 *
 * 数据流向：
 *   background → content(sendMessage) → interceptor(postMessage)  下发控制指令
 *   interceptor(postMessage) → content(addEventListener) → background(sendMessage)  上报请求
 *
 * 注意：ISOLATED world 和 MAIN world 共享 DOM，但 JS 命名空间隔离
 * 两个 world 之间只能通过 window.postMessage 或 DOM 事件通信
 */

/**
 * 检查扩展上下文是否仍然有效
 * 扩展重载后，页面中的旧 content script 变成"孤儿"——
 * 调用任何 chrome.runtime.* API 会同步抛出 "Extension context invalidated"
 * .catch() 捕获不到同步异常，必须提前用 try/catch 判断
 */
function ctxOk() {
  try { return !!chrome.runtime?.id; } catch (_) { return false; }
}

// ── 向 MAIN world 注入 interceptor.js（manifest 注入的备用保障） ─────────────
// manifest.json 中已配置 world:MAIN 在 document_start 同步注入
// 这里用 script 标签再注入一次，应对 manifest 注入失败的场景（如 CSP 限制、时序问题）
// interceptor.js 内部的 window.__nsPatched 守卫确保不会被 patch 两次
if (ctxOk()) {
  const _script = document.createElement('script');
  _script.src = chrome.runtime.getURL('interceptor.js');
  (document.documentElement || document).appendChild(_script);
}

// ── 从 background 同步初始状态 ──────────────────────────────────────────────
// 页面加载时主动拉取当前的开关状态和 Mock 规则
// 确保 interceptor.js 从一开始就持有正确的配置
if (ctxOk()) {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (resp) => {
    if (chrome.runtime.lastError) return; // 扩展未准备好，静默忽略
    setEnabled(resp?.enabled ?? false);
  });

  chrome.runtime.sendMessage({ type: 'GET_RULES' }, (resp) => {
    if (chrome.runtime.lastError) return;
    setRules(resp?.rules ?? []);
  });
}

// ── 监听 background 推送的实时指令 ──────────────────────────────────────────
// popup 开关变化、规则更新时，background 会主动 sendMessage 通知
if (ctxOk()) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SET_ENABLED') setEnabled(msg.enabled);
    if (msg.type === 'UPDATE_RULES') setRules(msg.rules);
  });
}

/**
 * 将开关状态下发到 MAIN world 的 interceptor.js
 * interceptor 根据 enabled 决定是否捕获请求 / 是否拦截并返回 Mock 数据
 */
function setEnabled(val) {
  window.postMessage({ __ns: 'ctrl', enabled: val }, '*');
}

/**
 * 将 Mock 规则列表下发到 MAIN world 的 interceptor.js
 * interceptor 收到后更新内部 mockRules，后续请求匹配规则时使用
 */
function setRules(rules) {
  window.postMessage({ __ns: 'rules', rules }, '*');
}

// ── 将 interceptor 捕获的请求转发给 background ──────────────────────────────
// interceptor.js（MAIN world）通过 postMessage 把捕获到的请求数据发出来
// content.js 在这里接收并转发给 background.js 存储和展示
window.addEventListener('message', (e) => {
  if (!e.data || e.data.__ns !== 'req') return;

  // 扩展重载后停止转发，避免抛出 "Extension context invalidated"
  if (!ctxOk()) return;

  try {
    // 转发到 background；.catch() 处理 Promise 层面的错误
    chrome.runtime.sendMessage({ type: 'NEW_REQUEST', data: e.data.data }).catch(() => {});
  } catch (_) {
    // try/catch 处理 sendMessage 同步抛出的 context 失效错误
  }
});
