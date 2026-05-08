/**
 * interceptor.js — 运行在页面 MAIN world，劫持 window.fetch 和 XMLHttpRequest
 *
 * 通信机制：通过 window.postMessage 与 content.js（ISOLATED world）双向传递数据
 *   content.js → interceptor : { __ns: 'ctrl', enabled }   开关
 *   content.js → interceptor : { __ns: 'rules', rules }    Mock 规则列表
 *   interceptor → content.js : { __ns: 'req',  data  }     捕获到的请求数据
 *
 * 两路注入保障可靠性：
 *   1. manifest.json content_scripts world:MAIN —— 页面加载时同步注入
 *   2. background.js executeScript            —— popup 打开时再次保障注入
 *   window.__nsPatched 标志防止重复 patch
 */
(function () {
  'use strict';

  // 响应体最大保留 100 KB，超出截断避免内存暴涨
  const MAX_BODY = 100 * 1024;

  // 是否开启捕获（由 popup 开关控制，默认关闭）
  let enabled = false;

  // 当前生效的 Mock 规则列表，由 background.js 通过 postMessage 推送
  let mockRules = [];

  // ── 工具函数 ────────────────────────────────────────────────────────────────

  /** 生成唯一请求 ID（时间戳 + 随机数，Base36 压缩） */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  /** 超出限制时截断字符串，避免大响应体撑爆存储 */
  function truncate(str) {
    if (str == null) return null;
    return str.length > MAX_BODY ? str.slice(0, MAX_BODY) + '\n[truncated]' : str;
  }

  /**
   * 将各种格式的 Headers 转成普通对象
   * 兼容 Headers 实例、二维数组、普通对象三种形式
   */
  function headersToObj(headers) {
    const obj = {};
    if (!headers) return obj;
    if (headers instanceof Headers) {
      headers.forEach((v, k) => { obj[k] = v; });
    } else if (Array.isArray(headers)) {
      headers.forEach(([k, v]) => { obj[k] = v; });
    } else {
      Object.assign(obj, headers);
    }
    return obj;
  }

  /**
   * 将捕获到的请求数据发送给 content.js（ISOLATED world）
   * postMessage 能可靠穿越 ISOLATED ↔ MAIN world 边界
   */
  function dispatch(data) {
    window.postMessage({ __ns: 'req', data }, '*');
  }

  // ── 幂等注入守卫 ────────────────────────────────────────────────────────────
  // 防止 manifest 注入 + executeScript 双重注入导致 fetch/XHR 被 patch 两次
  if (window.__nsPatched) return;
  window.__nsPatched = true;

  // ── 接收 content.js 推送的控制指令 ──────────────────────────────────────────
  // e.source 检查在跨 world 场景下不可靠，只检查 __ns 命名空间
  window.addEventListener('message', (e) => {
    if (!e.data) return;
    if (e.data.__ns === 'ctrl')  enabled   = !!e.data.enabled;
    if (e.data.__ns === 'rules') mockRules = Array.isArray(e.data.rules) ? e.data.rules : [];
  });

  // ── Mock 规则匹配 ───────────────────────────────────────────────────────────

  /**
   * 在 mockRules 中寻找第一条匹配当前请求的规则
   * 支持三种 URL 匹配方式：contains（包含）/ exact（精确）/ regex（正则）
   * @returns 匹配的规则对象，或 null
   */
  function matchRule(url, method) {
    for (const rule of mockRules) {
      if (!rule.enabled) continue;
      // method 为 '*' 时匹配任意请求方式
      if (rule.method !== '*' && rule.method !== method) continue;
      switch (rule.matchType) {
        case 'exact':  if (url !== rule.urlPattern) continue; break;
        case 'regex':
          try { if (!new RegExp(rule.urlPattern).test(url)) continue; } catch (_) { continue; }
          break;
        default:       if (!url.includes(rule.urlPattern)) continue; // contains
      }
      return rule;
    }
    return null;
  }

  // ── window.fetch 劫持 ───────────────────────────────────────────────────────

  const origFetch = window.fetch.bind(window);

  window.fetch = async function (input, init) {
    // 未开启捕获，直接放行原始请求
    if (!enabled) return origFetch(input, init);

    const id  = uid();
    const t0  = Date.now();
    let url, method, reqHeaders = {}, reqBody = null;

    // 兼容两种 fetch 调用方式：fetch(Request) 和 fetch(url, init)
    if (input instanceof Request) {
      url    = input.url;
      method = (input.method || 'GET').toUpperCase();
      input.headers.forEach((v, k) => { reqHeaders[k] = v; });
      // clone() 防止 body stream 被提前消费
      try { reqBody = truncate(await input.clone().text()); } catch (_) {}
    } else {
      url        = String(input);
      const i    = init || {};
      method     = (i.method || 'GET').toUpperCase();
      reqHeaders = headersToObj(i.headers);
      reqBody    = i.body != null ? truncate(String(i.body)) : null;
    }

    // ── Mock 拦截：命中规则则返回合成响应，不发送真实网络请求 ──────────────────
    const rule = matchRule(url, method);
    if (rule) {
      const delay = rule.delay || 0;
      // 模拟网络延迟（用于测试 loading 态）
      if (delay > 0) await new Promise(r => setTimeout(r, delay));

      const res        = rule.response;
      const status     = res.status     || 200;
      const statusText = res.statusText || 'OK';
      const body       = res.body       || '';
      let respHeaders  = {};
      try {
        respHeaders = typeof res.headers === 'object'
          ? res.headers
          : JSON.parse(res.headers || '{}');
      } catch (_) {}

      // 上报给 popup（标记为 Mock 数据）
      dispatch({ id, url, method, reqHeaders, reqBody, status, statusText,
        respBody: truncate(body), duration: Date.now() - t0, ts: t0,
        kind: 'fetch', isMocked: true, mockName: rule.name || '' });

      // 返回合成的 Response，页面代码拿到的就是 Mock 数据
      return new Response(body, { status, statusText, headers: respHeaders });
    }

    // ── 真实请求：捕获响应体后透传给页面 ────────────────────────────────────────
    try {
      const resp = await origFetch(input, init);
      let respBody = null;
      // clone() 读取 body 不影响页面继续消费原始 Response
      try { respBody = truncate(await resp.clone().text()); } catch (_) {}
      dispatch({ id, url, method, reqHeaders, reqBody,
        status: resp.status, statusText: resp.statusText, respBody,
        duration: Date.now() - t0, ts: t0, kind: 'fetch' });
      return resp;
    } catch (err) {
      // 请求失败也上报，status 用 0 标识网络错误
      dispatch({ id, url, method, reqHeaders, reqBody,
        status: 0, statusText: err.message, respBody: null,
        duration: Date.now() - t0, ts: t0, kind: 'fetch', error: err.message });
      throw err;
    }
  };

  // ── XMLHttpRequest 劫持 ─────────────────────────────────────────────────────

  const OrigXHR = window.XMLHttpRequest;

  /**
   * 继承原生 XHR，在 open/setRequestHeader/send 三个关键方法中注入采集逻辑
   * 用 _ns 前缀的私有属性存储请求元信息，避免与页面代码冲突
   */
  class PatchedXHR extends OrigXHR {
    constructor() {
      super();
      this._nsId      = uid();   // 请求唯一 ID
      this._nsMethod  = 'GET';
      this._nsUrl     = '';
      this._nsHeaders = {};      // 收集 setRequestHeader 设置的请求头
      this._nsT0      = 0;       // 请求开始时间戳
    }

    open(method, url, ...rest) {
      this._nsMethod = (method || 'GET').toUpperCase();
      this._nsUrl    = String(url);
      return super.open(method, url, ...rest);
    }

    setRequestHeader(name, value) {
      // 收集请求头，同时不影响原生行为
      this._nsHeaders[name] = value;
      return super.setRequestHeader(name, value);
    }

    send(body) {
      if (!enabled) return super.send(body);

      this._nsT0 = Date.now();
      const reqBody = body != null ? truncate(String(body)) : null;
      const { _nsId: id, _nsMethod: method, _nsUrl: url, _nsHeaders } = this;

      // ── Mock 拦截（XHR） ────────────────────────────────────────────────────
      const rule = matchRule(url, method);
      if (rule) {
        const res    = rule.response;
        const delay  = Math.max(0, rule.delay || 0);
        const t0     = this._nsT0;
        const self   = this;

        setTimeout(() => {
          const rBody      = res.body       || '';
          const status     = res.status     || 200;
          const statusText = res.statusText || 'OK';

          // 通过 Object.defineProperty 覆盖只读的原生 XHR 属性
          // 让页面代码读到 Mock 的状态码和响应体
          for (const [k, v] of [
            ['readyState', 4], ['status', status], ['statusText', statusText],
            ['responseText', rBody], ['response', rBody],
          ]) {
            try { Object.defineProperty(self, k, { value: v, configurable: true, writable: true }); } catch (_) {}
          }

          // 触发标准 XHR 事件序列，页面的 onload/onreadystatechange 回调正常执行
          self.dispatchEvent(new Event('readystatechange'));
          self.dispatchEvent(new Event('load'));
          self.dispatchEvent(new Event('loadend'));

          dispatch({ id, url, method, reqHeaders: { ..._nsHeaders }, reqBody,
            status, statusText, respBody: truncate(rBody),
            duration: Date.now() - t0, ts: t0, kind: 'xhr',
            isMocked: true, mockName: rule.name || '' });
        }, delay);

        return; // 不调用 super.send()，阻止真实网络请求
      }

      // ── 真实 XHR：在 loadend 后采集响应数据 ────────────────────────────────
      this.addEventListener('loadend', () => {
        let respBody = null;
        try { respBody = truncate(this.responseText); } catch (_) {}
        dispatch({ id, url, method, reqHeaders: { ..._nsHeaders }, reqBody,
          status: this.status, statusText: this.statusText, respBody,
          duration: Date.now() - this._nsT0, ts: this._nsT0, kind: 'xhr' });
      });

      return super.send(body);
    }
  }

  // 用 PatchedXHR 替换全局 XMLHttpRequest，页面后续 new XMLHttpRequest() 均走此类
  window.XMLHttpRequest = PatchedXHR;
})();
