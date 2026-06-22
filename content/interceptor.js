/**
 * content/interceptor.js
 *
 * 核心拦截器 - 注入到页面主世界（Main World）中执行。
 * 通过 Monkey Patch（猴子补丁）技术，替换浏览器原生的
 * window.fetch 和 XMLHttpRequest 方法，实现对所有网络请求的拦截。
 *
 * 关键设计：
 *   - 运行在页面主世界中，能直接访问页面的 JS 代码发起的请求
 *   - 保留原始方法引用，拦截逻辑在调用原始方法前后执行
 *   - 支持三种拦截动作：Mock（模拟响应）、Modify（修改请求）、Redirect（重定向）
 *   - 所有请求（无论是否被拦截）都会上报给 content script，用于调试面板展示
 *
 * 消息协议：
 *   入站：接收 content-script.js 通过 postMessage 发送的规则更新
 *   出站：通过 postMessage 向 content-script.js 上报被拦截的请求
 */
(function() {
  'use strict';

  /* ===== 当前生效的拦截规则列表 ===== */
  /** @type {Array<Object>} 由 content script 通过 postMessage 同步过来 */
  let interceptRules = [];

  /* ===== 保存原始浏览器 API 的引用 ===== */

  /** 原生 fetch 函数引用，用于在拦截逻辑中调用真实请求 */
  const OriginalFetch = window.fetch;

  /** 原生 XMLHttpRequest.prototype.open 引用 */
  const OriginalXHROpen = XMLHttpRequest.prototype.open;

  /** 原生 XMLHttpRequest.prototype.send 引用 */
  const OriginalXHRSend = XMLHttpRequest.prototype.send;

  /** 原生 XMLHttpRequest.prototype.setRequestHeader 引用 */
  const OriginalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  /* ===== 规则同步 ===== */

  /**
   * 监听来自 content script 的 postMessage，接收最新的拦截规则。
   * content script 运行在隔离世界，interceptor.js 运行在主世界，
   * 两者通过 window.postMessage 桥接通信。
   */
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.source === 'request-interceptor-content') {
      if (event.data.type === 'UPDATE_RULES') {
        interceptRules = event.data.rules || [];
      }
    }
  });

  /**
   * 加载完成后通知 content script 本拦截器已就绪，请求同步当前规则。
   * 解决页面刷新时的竞态条件：content script 的 GET_RULES 响应
   * 可能在 interceptor.js 加载完成前就到达，导致 UPDATE_RULES 消息丢失。
   */
  window.postMessage({
    source: 'request-interceptor-main',
    type: 'READY'
  }, '*');

  /* ===== 规则匹配引擎 ===== */

  /**
   * 判断单条规则是否匹配给定的 URL 和 HTTP 方法。
   *
   * 匹配逻辑：
   *   1. 规则未启用（enabled === false）→ 不匹配
   *   2. URL 匹配：
   *      - regex 模式：使用正则表达式.test() 匹配
   *      - contains 模式（默认）：使用字符串.includes() 匹配
   *   3. HTTP 方法匹配：如果规则指定了 methods 列表，请求方法必须在其中
   *
   * @param {string} url - 请求的完整 URL
   * @param {string} method - HTTP 方法（GET, POST 等）
   * @param {Object} rule - 拦截规则对象
   * @param {string} rule.matchType - 匹配类型：'regex' 或 'contains'
   * @param {string} rule.urlPattern - URL 匹配模式（正则表达式或子串）
   * @param {Array<string>} [rule.methods] - 限制的 HTTP 方法列表
   * @returns {boolean} 是否匹配
   */
  function matchRule(url, method, rule) {
    if (rule.enabled === false) return false;

    let urlMatch = false;
    if (rule.matchType === 'regex') {
      try {
        const regex = new RegExp(rule.urlPattern);
        urlMatch = regex.test(url);
      } catch (e) {
        // 正则表达式语法错误时视为不匹配
        urlMatch = false;
      }
    } else if (rule.matchType === 'contains') {
      urlMatch = url.includes(rule.urlPattern);
    } else {
      // 默认使用包含匹配
      urlMatch = url.includes(rule.urlPattern);
    }

    if (!urlMatch) return false;

    // 如果规则指定了 HTTP 方法限制，检查请求方法是否在允许列表中
    if (rule.methods && rule.methods.length > 0) {
      if (!rule.methods.includes(method.toUpperCase())) {
        return false;
      }
    }

    return true;
  }

  /**
   * 在规则列表中查找第一个匹配的规则。
   * 规则按数组顺序匹配，返回第一个命中的规则。
   *
   * @param {string} url - 请求 URL
   * @param {string} method - HTTP 方法
   * @returns {Object|null} 匹配的规则对象，无匹配返回 null
   */
  function getMatchingRule(url, method) {
    for (let i = 0; i < interceptRules.length; i++) {
      if (matchRule(url, method, interceptRules[i])) {
        return interceptRules[i];
      }
    }
    return null;
  }

  /* ===== 辅助函数 ===== */

  /**
   * 获取规则中定义的自定义请求头。
   *
   * @param {string} url - 请求 URL（预留参数，当前未使用）
   * @param {string} method - HTTP 方法（预留参数，当前未使用）
   * @param {Object} rule - 匹配的拦截规则
   * @returns {Object} 自定义请求头键值对
   */
  function getCustomHeaders(url, method, rule) {
    if (!rule || !rule.customHeaders) return {};
    const headers = {};
    for (const [key, value] of Object.entries(rule.customHeaders)) {
      headers[key] = value;
    }
    return headers;
  }

  /**
   * 根据规则生成 Mock 响应数据。
   *
   * @param {Object} rule - 拦截规则（action 必须为 'mock'）
   * @param {number} [rule.mockStatus=200] - 模拟的 HTTP 状态码
   * @param {string} [rule.mockStatusText='OK'] - 模拟的状态文本
   * @param {Object} [rule.mockHeaders] - 模拟的响应头
   * @param {string} [rule.mockBody='{}'] - 模拟的响应体（字符串）
   * @returns {Object|null} Mock 响应对象 { status, statusText, headers, body }
   */
  function getMockResponse(rule) {
    if (!rule) return null;
    if (rule.action === 'mock') {
      return {
        status: rule.mockStatus || 200,
        statusText: rule.mockStatusText || 'OK',
        headers: rule.mockHeaders || { 'Content-Type': 'application/json' },
        body: rule.mockBody || '{}'
      };
    }
    return null;
  }

  /**
   * 将拦截到的请求数据上报给 content script。
   * content script 收到后会通过 chrome.runtime.sendMessage 转发给 background。
   *
   * @param {Object} data - 请求数据对象，包含 url, method, status, responseBody 等字段
   */
  function reportRequest(data) {
    window.postMessage({
      source: 'request-interceptor-main',
      type: 'REQUEST_INTERCEPTED',
      request: data
    }, '*');
  }

  /* ===================================================================
   *  Background 代理请求（绕过 CORS）
   * =================================================================== */

  /** @type {Map<string, {resolve: Function, reject: Function}>} 代理请求 Promise 缓存 */
  const proxyPending = new Map();

  /**
   * 监听来自 content script 的代理请求响应
   */
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.source === 'request-interceptor-content') {
      if (event.data.type === 'PROXY_RESPONSE') {
        const { requestId, success, data, error } = event.data;
        const pending = proxyPending.get(requestId);
        if (pending) {
          proxyPending.delete(requestId);
          if (success) {
            pending.resolve(data);
          } else {
            pending.reject(new Error(error || 'Proxy request failed'));
          }
        }
      }
    }
  });

  /**
   * 通过 background 代理发送请求（绕过 CORS 限制）
   * service worker 的 fetch 不受页面 CORS 策略限制
   *
   * @param {string} url - 请求 URL
   * @param {Object} options - fetch 选项
   * @returns {Promise<Object>} 代理请求结果 {status, statusText, headers, body}
   */
  function proxyFetch(url, options) {
    return new Promise((resolve, reject) => {
      const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      proxyPending.set(requestId, { resolve, reject });

      // 超时处理
      setTimeout(() => {
        if (proxyPending.has(requestId)) {
          proxyPending.delete(requestId);
          reject(new Error('Proxy request timeout'));
        }
      }, 30000);

      window.postMessage({
        source: 'request-interceptor-main',
        type: 'PROXY_REQUEST',
        requestId,
        url,
        options: {
          method: options.method || 'GET',
          headers: options.headers || {},
          body: options.body || null
        }
      }, '*');
    });
  }

  /* ===================================================================
   *  Fetch API 拦截
   * =================================================================== */

  /**
   * 替换 window.fetch，实现对 Fetch API 请求的拦截。
   * 支持两种参数格式：
   *   - fetch(url, options)
   *   - fetch(request, options)  （Request 对象）
   *
   * 拦截流程：
   *   1. 解析参数，提取 URL 和请求选项
   *   2. 匹配规则，确定是否需要拦截
   *   3. 根据规则动作（mock/modify/redirect）修改请求
   *   4. 调用原始 fetch 发送请求
   *   5. 记录耗时，克隆响应体读取内容
   *   6. 上报完整的请求/响应数据
   */
  window.fetch = async function(...args) {
    const startTime = performance.now();
    let url, options;

    // 兼容 fetch(url, options) 和 fetch(Request, options) 两种调用方式
    if (args[0] instanceof Request) {
      const req = args[0];
      url = req.url;
      options = { method: req.method, headers: {}, body: null, ...args[1] };
      try { req.headers.forEach((v, k) => { options.headers[k] = v; }); } catch (e) {}
      if (req.body) {
        try { options.body = await req.clone().text(); } catch (e) {}
      }
    } else {
      url = args[0];
      options = args[1] || {};
    }

    const method = (options.method || 'GET').toUpperCase();
    const rule = getMatchingRule(url, method);
    const intercepted = !!rule;

    let modifiedUrl = url;
    let modifiedOptions = { ...options };

    if (rule) {
      if (rule.action === 'redirect' && rule.redirectUrl) {
        try { modifiedUrl = new URL(rule.redirectUrl, window.location.origin).href; } catch (e) { modifiedUrl = rule.redirectUrl; }
      }
      if (rule.action === 'mock') {
        const mockResponse = getMockResponse(rule);
        reportRequest({ url, finalUrl: url, method, type: 'fetch', status: mockResponse.status, statusText: mockResponse.statusText, requestHeaders: options.headers || {}, requestBody: options.body || null, responseHeaders: mockResponse.headers, responseBody: mockResponse.body, duration: 0, timestamp: new Date().toISOString(), intercepted: true, ruleId: rule.id, action: 'mock' });
        return new Response(mockResponse.body, { status: mockResponse.status, statusText: mockResponse.statusText, headers: mockResponse.headers });
      }
      if (rule.action === 'modify') {
        modifiedOptions.headers = { ...(modifiedOptions.headers || {}), ...getCustomHeaders(url, method, rule) };
        if (rule.modifyBody) modifiedOptions.body = rule.modifyBody;
        if (rule.modifyQuery) {
          try { const u = new URL(modifiedUrl, window.location.origin); Object.entries(rule.modifyQuery).forEach(([k, v]) => u.searchParams.set(k, v)); modifiedUrl = u.toString(); } catch (e) {}
        }
      }
    }

    const isRedirect = rule && rule.action === 'redirect';

    // 重定向请求通过 background 代理发送（绕过 CORS）
    if (isRedirect) {
      try {
        const proxyResult = await proxyFetch(modifiedUrl, modifiedOptions);
        const endTime = performance.now();
        const duration = Math.round(endTime - startTime);
        reportRequest({ url, finalUrl: modifiedUrl, method, type: 'fetch', status: proxyResult.status, statusText: proxyResult.statusText || '', requestHeaders: modifiedOptions.headers || {}, requestBody: modifiedOptions.body || null, responseHeaders: proxyResult.headers || {}, responseBody: proxyResult.body || '', duration, timestamp: new Date().toISOString(), intercepted: true, ruleId: rule.id, action: 'redirect' });
        return new Response(proxyResult.body || '', { status: proxyResult.status, statusText: proxyResult.statusText || '', headers: proxyResult.headers || {} });
      } catch (error) {
        const endTime = performance.now();
        const duration = Math.round(endTime - startTime);
        reportRequest({ url, finalUrl: modifiedUrl, method, type: 'fetch', status: 0, statusText: 'Proxy Error', requestHeaders: modifiedOptions.headers || {}, requestBody: modifiedOptions.body || null, responseHeaders: {}, responseBody: error.message, duration, timestamp: new Date().toISOString(), intercepted: true, ruleId: rule.id, action: 'redirect' });
        return new Response(error.message, { status: 0, statusText: 'Proxy Error' });
      }
    }

    // 非重定向请求直接发送
    try {
      const response = await OriginalFetch.apply(this, [modifiedUrl, modifiedOptions]);
      const endTime = performance.now();
      const duration = Math.round(endTime - startTime);
      const responseClone = response.clone();
      let responseBody = '';
      try { responseBody = await responseClone.text(); } catch (e) { responseBody = '[Unable to read response body]'; }
      const responseHeaders = {};
      try { response.headers.forEach((v, k) => { responseHeaders[k] = v; }); } catch (e) {}
      reportRequest({ url: modifiedUrl, finalUrl: modifiedUrl, method, type: 'fetch', status: response.status, statusText: response.statusText, requestHeaders: modifiedOptions.headers || {}, requestBody: modifiedOptions.body || null, responseHeaders, responseBody, duration, timestamp: new Date().toISOString(), intercepted, ruleId: rule ? rule.id : null, action: rule ? rule.action : null });
      return response;
    } catch (error) {
      const endTime = performance.now();
      const duration = Math.round(endTime - startTime);
      reportRequest({ url: modifiedUrl, finalUrl: modifiedUrl, method, type: 'fetch', status: 0, statusText: 'Network Error', requestHeaders: modifiedOptions.headers || {}, requestBody: modifiedOptions.body || null, responseHeaders: {}, responseBody: error.message || 'Request failed', duration, timestamp: new Date().toISOString(), intercepted, ruleId: rule ? rule.id : null });
      throw error;
    }
  };

  /* ===================================================================
   *  XMLHttpRequest 拦截
   * =================================================================== */

  /**
   * 替换 XMLHttpRequest.prototype.open，拦截请求的初始化阶段。
   *
   * 在 open() 中完成：
   *   1. 保存请求的 method 和 url 到实例属性（以 _interceptor 前缀避免冲突）
   *   2. 匹配拦截规则
   *   3. 应用 URL 重定向和查询参数修改
   *
   * @param {string} method - HTTP 方法
   * @param {string} url - 请求 URL
   * @param {...*} rest - 其他参数（async, username, password）
   */
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._interceptorMethod = method;
    this._interceptorOriginalUrl = url;
    this._interceptorUrl = url;
    this._interceptorStartTime = null;
    this._interceptorRule = getMatchingRule(url, method);
    this._interceptorIntercepted = !!this._interceptorRule;
    this._interceptorRequestHeaders = {};
    this._interceptorUseProxy = false;

    if (this._interceptorRule) {
      // 重定向动作：准备使用代理
      if (this._interceptorRule.action === 'redirect' && this._interceptorRule.redirectUrl) {
        try { this._interceptorUrl = new URL(this._interceptorRule.redirectUrl, window.location.origin).href; } catch (e) { this._interceptorUrl = this._interceptorRule.redirectUrl; }
        this._interceptorUseProxy = true;
        // 仍然调用原始open，但不发送实际请求（会在send中拦截）
        return OriginalXHROpen.apply(this, [method, url, ...rest]);
      }

      // Modify 动作：修改查询参数
      if (this._interceptorRule.action === 'modify' && this._interceptorRule.modifyQuery) {
        try {
          const urlObj = new URL(url, window.location.origin);
          for (const [key, value] of Object.entries(this._interceptorRule.modifyQuery)) {
            urlObj.searchParams.set(key, value);
          }
          url = urlObj.toString();
          this._interceptorUrl = url;
        } catch (e) {}
      }
    }

    return OriginalXHROpen.apply(this, [method, url, ...rest]);
  };

  /**
   * 替换 XMLHttpRequest.prototype.setRequestHeader，拦截请求头的设置。
   * 如果规则定义了同名的自定义请求头，使用规则中的值覆盖原始值。
   *
   * @param {string} name - 请求头名称
   * @param {string} value - 请求头值
   */
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    // 如果规则中定义了同名的自定义请求头，覆盖原始值
    if (this._interceptorRule && this._interceptorRule.action === 'modify') {
      const customHeaders = this._interceptorRule.customHeaders || {};
      if (customHeaders[name] !== undefined) {
        value = customHeaders[name];
      }
    }

    // 记录已设置的请求头（供上报时使用）
    this._interceptorRequestHeaders[name] = value;
    return OriginalXHRSetRequestHeader.apply(this, [name, value]);
  };

  /**
   * 替换 XMLHttpRequest.prototype.send，拦截请求的发送阶段。
   *
   * 在 send() 中完成：
   *   1. Mock 动作：伪造 XHR 的 readyState/status/responseText，
   *      触发 load/loadend 事件，不发送真实请求
   *   2. Modify 动作：应用请求体修改和额外的自定义请求头
   *   3. 监听 loadend 事件，记录耗时并上报请求数据
   *
   * @param {string|ArrayBuffer|null} body - 请求体
   */
  XMLHttpRequest.prototype.send = function(body) {
    this._interceptorStartTime = performance.now();
    this._interceptorRequestBody = body;
    const rule = this._interceptorRule;
    const self = this;

    /* --- Mock 动作：模拟响应，不发送真实请求 --- */
    if (rule && rule.action === 'mock') {
      const mockResponse = getMockResponse(rule);
      Object.defineProperty(this, 'readyState', { writable: true, value: 4 });
      Object.defineProperty(this, 'status', { writable: true, value: mockResponse.status });
      Object.defineProperty(this, 'statusText', { writable: true, value: mockResponse.statusText });
      Object.defineProperty(this, 'responseText', { writable: true, value: mockResponse.body });
      Object.defineProperty(this, 'response', { writable: true, value: mockResponse.body });
      reportRequest({ url: this._interceptorOriginalUrl, finalUrl: this._interceptorUrl, method: this._interceptorMethod, type: 'xhr', status: mockResponse.status, statusText: mockResponse.statusText, requestHeaders: this._interceptorRequestHeaders, requestBody: body, responseHeaders: mockResponse.headers, responseBody: mockResponse.body, duration: 0, timestamp: new Date().toISOString(), intercepted: true, ruleId: rule.id, action: 'mock' });
      setTimeout(() => { if (this.onreadystatechange) this.onreadystatechange(); if (this.onload) this.onload(); this.dispatchEvent(new Event('load')); this.dispatchEvent(new Event('loadend')); }, 0);
      return;
    }

    /* --- Redirect 动作：通过代理发送请求（绕过 CORS） --- */
    if (rule && rule.action === 'redirect' && this._interceptorUseProxy) {
      proxyFetch(this._interceptorUrl, {
        method: this._interceptorMethod,
        headers: this._interceptorRequestHeaders,
        body: body
      }).then((result) => {
        const duration = Math.round(performance.now() - (self._interceptorStartTime || performance.now()));
        // 模拟 XHR 完成状态
        Object.defineProperty(self, 'readyState', { writable: true, value: 4 });
        Object.defineProperty(self, 'status', { writable: true, value: result.status });
        Object.defineProperty(self, 'statusText', { writable: true, value: result.statusText || '' });
        Object.defineProperty(self, 'responseText', { writable: true, value: result.body || '' });
        Object.defineProperty(self, 'response', { writable: true, value: result.body || '' });
        self._interceptorResponseHeaders = result.headers || {};
        reportRequest({ url: self._interceptorOriginalUrl, finalUrl: self._interceptorUrl, method: self._interceptorMethod, type: 'xhr', status: result.status, statusText: result.statusText || '', requestHeaders: self._interceptorRequestHeaders, requestBody: body, responseHeaders: result.headers || {}, responseBody: result.body || '', duration, timestamp: new Date().toISOString(), intercepted: true, ruleId: rule.id, action: 'redirect' });
        // 触发事件
        if (self.onreadystatechange) self.onreadystatechange();
        if (self.onload) self.onload();
        self.dispatchEvent(new Event('load'));
        self.dispatchEvent(new Event('loadend'));
      }).catch((error) => {
        const duration = Math.round(performance.now() - (self._interceptorStartTime || performance.now()));
        Object.defineProperty(self, 'readyState', { writable: true, value: 4 });
        Object.defineProperty(self, 'status', { writable: true, value: 0 });
        Object.defineProperty(self, 'statusText', { writable: true, value: 'Proxy Error' });
        Object.defineProperty(self, 'responseText', { writable: true, value: error.message });
        Object.defineProperty(self, 'response', { writable: true, value: error.message });
        reportRequest({ url: self._interceptorOriginalUrl, finalUrl: self._interceptorUrl, method: self._interceptorMethod, type: 'xhr', status: 0, statusText: 'Proxy Error', requestHeaders: self._interceptorRequestHeaders, requestBody: body, responseHeaders: {}, responseBody: error.message, duration, timestamp: new Date().toISOString(), intercepted: true, ruleId: rule.id, action: 'redirect' });
        if (self.onreadystatechange) self.onreadystatechange();
        if (self.onerror) self.onerror();
        self.dispatchEvent(new Event('error'));
        self.dispatchEvent(new Event('loadend'));
      });
      return; // 不调用原始 send()
    }

    /* --- Modify 动作：修改请求体和请求头 --- */
    if (rule && rule.action === 'modify') {
      if (rule.modifyBody) body = rule.modifyBody;
      const customHeaders = rule.customHeaders || {};
      for (const [name, value] of Object.entries(customHeaders)) {
        if (!(name in this._interceptorRequestHeaders)) {
          OriginalXHRSetRequestHeader.call(this, name, value);
          this._interceptorRequestHeaders[name] = value;
        }
      }
    }

    /* --- 监听请求完成事件，上报数据 --- */
    this.addEventListener('loadend', function handler() {
      self.removeEventListener('loadend', handler);
      const duration = Math.round(performance.now() - (self._interceptorStartTime || performance.now()));
      let responseBody = '';
      try { responseBody = self.responseText || self.response || ''; } catch (e) {}
      reportRequest({ url: self._interceptorOriginalUrl, finalUrl: self._interceptorUrl, method: self._interceptorMethod, type: 'xhr', status: self.status, statusText: self.status === 0 ? 'Blocked' : self.statusText, requestHeaders: self._interceptorRequestHeaders, requestBody: self._interceptorRequestBody, responseHeaders: {}, responseBody, duration, timestamp: new Date().toISOString(), intercepted: self._interceptorIntercepted, ruleId: rule ? rule.id : null, action: rule ? rule.action : null });
    });

    return OriginalXHRSend.apply(this, [body]);
  };
})();
