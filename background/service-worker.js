/**
 * background/service-worker.js
 *
 * Chrome 扩展后台服务 Worker（Manifest V3 Service Worker）。
 * 作为整个扩展的"中枢"，负责：
 *   1. 管理拦截规则的 CRUD（创建、读取、更新、删除）及持久化存储
 *   2. 接收 content script 上报的被拦截请求数据，并转发给 side panel 展示
 *   3. 将规则变更广播到所有已打开的标签页（content script）
 *   4. 更新浏览器图标上的徽标数字（显示当前启用的规则数量）
 */

/* ===== 全局状态 ===== */

/** @type {Array<Object>} 当前内存中的拦截规则列表，由 storage 持久化 */
let rules = [];

/** @type {Array<Object>} 已捕获的请求记录列表，最多保留 500 条 */
let capturedRequests = [];

/* ===== 启动时立即加载规则 ===== */

/**
 * Service Worker 可能被 Chrome 终止后重启，此时内存中的 rules 为空。
 * 在脚本顶层直接调用 loadRules()，确保处理第一条消息前规则已就绪。
 */
loadRules();

/* ===== 生命周期事件 ===== */

/**
 * 扩展安装/更新时触发。
 * - 启用 side panel 功能
 * - 从 chrome.storage 加载已保存的规则
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ enabled: true });
  loadRules();
});

/**
 * 用户点击扩展图标时打开 side panel。
 * sidePanel API 不会自动响应点击，需要手动调用 open()。
 */
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

/* ===== 消息通信处理 ===== */

/**
 * 监听来自 content script、side panel 等所有扩展组件的消息。
 * 通过 message.type 字段分发到对应的处理逻辑。
 *
 * 消息协议（type → 处理逻辑）：
 *   - GET_RULES          → 返回当前规则列表
 *   - UPDATE_RULES        → 整体替换规则列表
 *   - ADD_RULE            → 追加单条规则
 *   - DELETE_RULE         → 按 ID 删除单条规则
 *   - TOGGLE_RULE         → 切换规则的启用/禁用状态
 *   - IMPORT_RULES        → 导入外部规则列表（覆盖）
 *   - EXPORT_RULES        → 返回当前规则列表用于导出
 *   - REQUEST_INTERCEPTED → 接收被拦截的请求数据并存储
 *   - GET_CAPTURED_REQUESTS → 返回已捕获的请求列表
 *   - CLEAR_REQUESTS      → 清空已捕获的请求列表
 *
 * @returns {boolean} 返回 true 表示异步响应（sendResponse 会在稍后调用）
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    /* ---------- 规则管理 ---------- */

    /** 获取所有规则 */
    case 'GET_RULES':
      sendResponse({ rules });
      break;

    /** 整体替换规则列表（用于批量更新/导入） */
    case 'UPDATE_RULES':
      rules = message.rules;
      saveRules();
      broadcastRules();
      sendResponse({ success: true });
      break;

    /** 添加单条规则 */
    case 'ADD_RULE':
      rules.push(message.rule);
      saveRules();
      broadcastRules();
      updateBadge();
      sendResponse({ success: true, rules });
      break;

    /** 按规则 ID 删除 */
    case 'DELETE_RULE':
      rules = rules.filter(r => r.id !== message.ruleId);
      saveRules();
      broadcastRules();
      updateBadge();
      sendResponse({ success: true, rules });
      break;

    /** 切换规则启用/禁用状态 */
    case 'TOGGLE_RULE':
      const rule = rules.find(r => r.id === message.ruleId);
      if (rule) {
        rule.enabled = !rule.enabled;
        saveRules();
        broadcastRules();
        updateBadge();
      }
      sendResponse({ success: true, rules });
      break;

    /** 批量导入规则（覆盖现有规则） */
    case 'IMPORT_RULES':
      rules = message.rules;
      saveRules();
      broadcastRules();
      updateBadge();
      sendResponse({ success: true });
      break;

    /** 导出规则（仅返回，不修改状态） */
    case 'EXPORT_RULES':
      sendResponse({ rules });
      break;

    /* ---------- 请求捕获 ---------- */

    /**
     * 接收从 content script → interceptor.js 上报的被拦截请求数据。
     * 生成唯一 ID，插入到列表头部（最新请求在前），
     * 超过 500 条时截断最旧的记录，然后通知 side panel 更新。
     */
    case 'REQUEST_INTERCEPTED':
      const request = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2),
        url: message.data.url,
        finalUrl: message.data.finalUrl || message.data.url,
        method: message.data.method,
        type: message.data.type,
        status: message.data.status,
        statusText: message.data.statusText,
        requestHeaders: message.data.requestHeaders,
        requestBody: message.data.requestBody,
        responseHeaders: message.data.responseHeaders,
        responseBody: message.data.responseBody,
        duration: message.data.duration,
        timestamp: message.data.timestamp,
        intercepted: message.data.intercepted,
        ruleId: message.data.ruleId,
        action: message.data.action || null
      };
      capturedRequests.unshift(request);
      // 内存中最多保留 500 条请求记录，防止内存溢出
      if (capturedRequests.length > 500) {
        capturedRequests = capturedRequests.slice(0, 500);
      }
      broadcastToSidePanel({ type: 'NEW_REQUEST', request });
      break;

    /** 获取所有已捕获的请求 */
    case 'GET_CAPTURED_REQUESTS':
      sendResponse({ requests: capturedRequests });
      break;

    /** 清空所有已捕获的请求 */
    case 'CLEAR_REQUESTS':
      capturedRequests = [];
      broadcastToSidePanel({ type: 'REQUESTS_CLEARED' });
      sendResponse({ success: true });
      break;

    /**
     * 代理 fetch 请求（绕过页面 CORS 限制）。
     * service worker 的 fetch 不受页面的 CORS 策略约束。
     */
    case 'PROXY_FETCH':
      handleProxyFetch(message, sendResponse);
      return true; // 异步响应
  }
  // 返回 true 告知 Chrome：sendResponse 将异步调用（或已在同步阶段调用）
  return true;
});

/* ===== 持久化存储 ===== */

/**
 * 将当前规则列表持久化到 chrome.storage.local。
 * 扩展关闭/浏览器重启后规则不会丢失。
 */
function saveRules() {
  chrome.storage.local.set({ interceptRules: rules });
}

/**
 * 从 chrome.storage.local 加载规则列表。
 * 在扩展安装时调用，将存储中的规则恢复到内存。
 */
function loadRules() {
  chrome.storage.local.get(['interceptRules'], (result) => {
    rules = result.interceptRules || [];
    broadcastRules();
    updateBadge();
  });
}

/* ===== 广播机制 ===== */

/**
 * 将规则更新广播到所有通信对象：
 *   1. chrome.runtime.sendMessage → 通知 side panel（通过 runtime 消息）
 *   2. chrome.tabs.sendMessage → 通知每个标签页的 content script
 *
 * .catch(() => {}) 用于忽略无接收者时的错误（如 side panel 未打开）。
 */
function broadcastRules() {
  const message = { type: 'RULES_UPDATED', rules: rules };
  // 广播给 runtime（side panel 通过此通道接收）
  chrome.runtime.sendMessage(message).catch(() => {});
  // 广播给所有标签页的 content script
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    });
  });
}

/**
 * 将消息广播到 side panel。
 * 与 broadcastRules 类似，但用于请求数据相关的通知。
 */
function broadcastToSidePanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    });
  });
}

/* ===== 徽标更新 ===== */

/**
 * 更新浏览器扩展图标右下角的徽标数字。
 * 显示当前启用的规则数量；无启用规则时清空徽标。
 * 背景色使用绿色（#4CAF50）以突出显示。
 */
function updateBadge() {
  const activeRules = rules.filter(r => r.enabled);
  const count = activeRules.length;
  if (count > 0) {
    chrome.action.setBadgeText({ text: count.toString() });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

/* ===== 代理请求处理 ===== */

/**
 * 处理代理 fetch 请求。
 * service worker 运行在扩展上下文中，其 fetch 请求不受页面 CORS 策略限制。
 *
 * @param {Object} message - 消息对象 {url, options}
 * @param {Function} sendResponse - 响应回调
 */
async function handleProxyFetch(message, sendResponse) {
  const { url, options } = message;
  try {
    const fetchOptions = {
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    if (options.body && options.method !== 'GET' && options.method !== 'HEAD') {
      fetchOptions.body = options.body;
    }
    const response = await fetch(url, fetchOptions);
    const headers = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    let body = '';
    try { body = await response.text(); } catch (e) { body = ''; }
    sendResponse({
      success: true,
      data: {
        status: response.status,
        statusText: response.statusText,
        headers,
        body
      }
    });
  } catch (error) {
    sendResponse({
      success: false,
      error: error.message || 'Proxy fetch failed'
    });
  }
}
