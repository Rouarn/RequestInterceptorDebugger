/**
 * content/content-script.js
 *
 * 内容脚本（Content Script）- 运行在网页的上下文中，但拥有 Chrome 扩展 API 的访问权限。
 * 它是 background service worker 与页面内注入的 interceptor.js 之间的"桥梁"。
 *
 * 核心职责：
 *   1. 将 interceptor.js 注入到页面的主世界（Main World）中执行，
 *      使其能拦截原生的 fetch / XMLHttpRequest
 *   2. 监听来自 background 的规则更新消息，转发给 interceptor.js
 *   3. 监听 interceptor.js 通过 postMessage 上报的被拦截请求，转发给 background
 *
 * 消息流（双向桥接）：
 *   background ──[chrome.runtime.onMessage]──→ content-script ──[window.postMessage]──→ interceptor.js
 *   interceptor.js ──[window.postMessage]──→ content-script ──[chrome.runtime.sendMessage]──→ background
 *
 * 注意：content script 运行在"隔离世界"中，无法直接访问页面的 JS 变量，
 * 因此需要通过 DOM 注入 <script> 标签的方式将 interceptor.js 注入到主世界。
 */
(function() {
  'use strict';

  /** @type {Array<Object>} 从 background 同步过来的拦截规则列表 */
  let rules = [];

  /**
   * 步骤 1：注入 interceptor.js 到页面主世界。
   * 通过创建 <script> 标签并设置 src 为扩展资源 URL，
   * 使 interceptor.js 在页面的 JS 上下文中执行（而非隔离世界）。
   * 脚本加载完成后立即移除 <script> 标签，保持 DOM 整洁。
   */
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('content/interceptor.js');
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);

  /**
   * 向 interceptor.js 发送当前规则。
   */
  function sendRulesToInterceptor() {
    window.postMessage({
      source: 'request-interceptor-content',
      type: 'UPDATE_RULES',
      rules: rules
    }, '*');
  }

  /**
   * 安全地向 background 发送消息。
   * 当扩展重新加载时，chrome.runtime 会失效，需要捕获异常避免报错。
   *
   * @param {Object} message - 要发送的消息
   * @param {Function} [callback] - 可选的回调函数
   */
  function safeSendMessage(message, callback) {
    try {
      if (chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage(message, callback);
      }
    } catch (e) {
      // 扩展上下文已失效（Extension context invalidated），静默忽略
    }
  }

  /**
   * 步骤 2：监听来自 background 的消息。
   * 当规则发生变化时（RULES_UPDATED），将最新的规则列表
   * 通过 window.postMessage 转发给页面内的 interceptor.js。
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'RULES_UPDATED') {
      rules = message.rules;
      // 通过 postMessage 发送到页面主世界
      // source 字段用于标识消息来源，interceptor.js 会过滤非本扩展的消息
      sendRulesToInterceptor();
    }
    // 对请求相关消息简单确认收到
    if (message.type === 'NEW_REQUEST' || message.type === 'REQUESTS_CLEARED') {
      sendResponse({ success: true });
    }
  });

  /**
   * 步骤 3：监听页面内 interceptor.js 通过 postMessage 发送的消息。
   * interceptor.js 拦截到请求后，会将请求数据通过 postMessage 发送给 content script，
   * content script 再通过 chrome.runtime.sendMessage 转发给 background service worker。
   *
   * 消息过滤：
   *   - event.source !== window：排除来自 iframe 的消息
   *   - event.data.source === 'request-interceptor-main'：只处理本扩展注入脚本的消息
   */
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.source === 'request-interceptor-main') {
      switch (event.data.type) {
        // interceptor.js 加载完成，发送当前规则
        case 'READY':
          sendRulesToInterceptor();
          break;

        // 页面内脚本上报了被拦截的请求
        case 'REQUEST_INTERCEPTED':
          safeSendMessage({
            type: 'REQUEST_INTERCEPTED',
            data: event.data.request
          });
          break;

        // 页面内脚本请求清空请求记录
        case 'REQUESTS_CLEARED':
          safeSendMessage({
            type: 'CLEAR_REQUESTS'
          });
          break;
      }
    }
  });

  /**
   * 步骤 4：初始化 - 向 background 请求当前规则列表。
   * 确保页面加载后 interceptor.js 能立即获得最新的规则。
   * 同时设置定时重试，防止 GET_RULES 响应在 interceptor.js 加载前到达导致丢失。
   */
  function fetchAndSendRules() {
    safeSendMessage({ type: 'GET_RULES' }, (response) => {
      if (response && response.rules) {
        rules = response.rules;
        sendRulesToInterceptor();
      }
    });
  }

  // 立即请求规则
  fetchAndSendRules();

  // 定时重试，确保规则最终同步到 interceptor.js
  // 即使首次 GET_RULES 的响应在 interceptor.js 加载前到达（消息丢失），
  // 后续重试也能成功发送规则
  let retryCount = 0;
  const maxRetries = 10;
  const retryInterval = setInterval(() => {
    retryCount++;
    sendRulesToInterceptor();
    if (retryCount >= maxRetries) {
      clearInterval(retryInterval);
    }
  }, 100);

  /**
   * 步骤 5：监听 chrome.storage 变化，加速规则同步。
   * 当 background 调用 saveRules() 将规则写入 storage 时，
   * 此监听器会立即检测到变化并转发给 interceptor.js，
   * 避免依赖 chrome.runtime.onMessage 异步回调导致的规则同步延迟。
   */
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.interceptRules) {
      rules = changes.interceptRules.newValue || [];
      sendRulesToInterceptor();
    }
  });
})();
