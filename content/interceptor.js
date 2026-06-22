(function() {
  'use strict';

  let interceptRules = [];

  const OriginalFetch = window.fetch;
  const OriginalXHROpen = XMLHttpRequest.prototype.open;
  const OriginalXHRSend = XMLHttpRequest.prototype.send;
  const OriginalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.source === 'request-interceptor-content') {
      if (event.data.type === 'UPDATE_RULES') {
        interceptRules = event.data.rules || [];
      }
    }
  });

  function matchRule(url, method, rule) {
    if (rule.enabled === false) return false;

    let urlMatch = false;
    if (rule.matchType === 'regex') {
      try {
        const regex = new RegExp(rule.urlPattern);
        urlMatch = regex.test(url);
      } catch (e) {
        urlMatch = false;
      }
    } else if (rule.matchType === 'contains') {
      urlMatch = url.includes(rule.urlPattern);
    } else {
      urlMatch = url.includes(rule.urlPattern);
    }

    if (!urlMatch) return false;

    if (rule.methods && rule.methods.length > 0) {
      if (!rule.methods.includes(method.toUpperCase())) {
        return false;
      }
    }

    return true;
  }

  function getMatchingRule(url, method) {
    for (let i = 0; i < interceptRules.length; i++) {
      if (matchRule(url, method, interceptRules[i])) {
        return interceptRules[i];
      }
    }
    return null;
  }

  function getCustomHeaders(url, method, rule) {
    if (!rule || !rule.customHeaders) return {};
    const headers = {};
    for (const [key, value] of Object.entries(rule.customHeaders)) {
      headers[key] = value;
    }
    return headers;
  }

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

  function reportRequest(data) {
    window.postMessage({
      source: 'request-interceptor-main',
      type: 'REQUEST_INTERCEPTED',
      request: data
    }, '*');
  }

  window.fetch = async function(...args) {
    const startTime = performance.now();
    let url, options;

    if (args[0] instanceof Request) {
      url = args[0].url;
      options = args[1] || {};
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
      if (rule.redirectUrl) {
        modifiedUrl = rule.redirectUrl;
      }

      if (rule.action === 'mock') {
        const mockResponse = getMockResponse(rule);
        reportRequest({
          url,
          method,
          type: 'fetch',
          status: mockResponse.status,
          statusText: mockResponse.statusText,
          requestHeaders: options.headers || {},
          requestBody: options.body || null,
          responseHeaders: mockResponse.headers,
          responseBody: mockResponse.body,
          duration: 0,
          timestamp: new Date().toISOString(),
          intercepted: true,
          ruleId: rule.id
        });

        return new Response(mockResponse.body, {
          status: mockResponse.status,
          statusText: mockResponse.statusText,
          headers: mockResponse.headers
        });
      }

      if (rule.action === 'modify') {
        const customHeaders = getCustomHeaders(url, method, rule);
        modifiedOptions.headers = {
          ...(modifiedOptions.headers || {}),
          ...customHeaders
        };

        if (rule.modifyBody) {
          modifiedOptions.body = rule.modifyBody;
        }

        if (rule.modifyQuery) {
          try {
            const urlObj = new URL(modifiedUrl, window.location.origin);
            for (const [key, value] of Object.entries(rule.modifyQuery)) {
              urlObj.searchParams.set(key, value);
            }
            modifiedUrl = urlObj.toString();
          } catch (e) {}
        }
      }
    }

    try {
      const response = await OriginalFetch.apply(this, [modifiedUrl, modifiedOptions]);
      const endTime = performance.now();
      const duration = Math.round(endTime - startTime);

      const responseClone = response.clone();
      let responseBody = '';
      try {
        responseBody = await responseClone.text();
      } catch (e) {
        responseBody = '[Unable to read response body]';
      }

      const responseHeaders = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      reportRequest({
        url: modifiedUrl,
        method,
        type: 'fetch',
        status: response.status,
        statusText: response.statusText,
        requestHeaders: modifiedOptions.headers || {},
        requestBody: modifiedOptions.body || null,
        responseHeaders,
        responseBody,
        duration,
        timestamp: new Date().toISOString(),
        intercepted,
        ruleId: rule ? rule.id : null
      });

      return response;
    } catch (error) {
      const endTime = performance.now();
      const duration = Math.round(endTime - startTime);

      reportRequest({
        url: modifiedUrl,
        method,
        type: 'fetch',
        status: 0,
        statusText: 'Network Error',
        requestHeaders: modifiedOptions.headers || {},
        requestBody: modifiedOptions.body || null,
        responseHeaders: {},
        responseBody: error.message,
        duration,
        timestamp: new Date().toISOString(),
        intercepted,
        ruleId: rule ? rule.id : null
      });

      throw error;
    }
  };

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._interceptorMethod = method;
    this._interceptorUrl = url;
    this._interceptorStartTime = null;
    this._interceptorRule = getMatchingRule(url, method);
    this._interceptorIntercepted = !!this._interceptorRule;
    this._interceptorRequestHeaders = {};

    if (this._interceptorRule) {
      if (this._interceptorRule.redirectUrl) {
        url = this._interceptorRule.redirectUrl;
      }

      if (this._interceptorRule.action === 'modify' && this._interceptorRule.modifyQuery) {
        try {
          const urlObj = new URL(url, window.location.origin);
          for (const [key, value] of Object.entries(this._interceptorRule.modifyQuery)) {
            urlObj.searchParams.set(key, value);
          }
          url = urlObj.toString();
        } catch (e) {}
      }
    }

    return OriginalXHROpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (this._interceptorRule && this._interceptorRule.action === 'modify') {
      const customHeaders = this._interceptorRule.customHeaders || {};
      if (customHeaders[name] !== undefined) {
        value = customHeaders[name];
      }
    }

    this._interceptorRequestHeaders[name] = value;
    return OriginalXHRSetRequestHeader.apply(this, [name, value]);
  };

  XMLHttpRequest.prototype.send = function(body) {
    this._interceptorStartTime = performance.now();
    this._interceptorRequestBody = body;

    const rule = this._interceptorRule;
    if (rule && rule.action === 'mock') {
      const mockResponse = getMockResponse(rule);

      Object.defineProperty(this, 'readyState', { writable: true, value: 4 });
      Object.defineProperty(this, 'status', { writable: true, value: mockResponse.status });
      Object.defineProperty(this, 'statusText', { writable: true, value: mockResponse.statusText });
      Object.defineProperty(this, 'responseText', { writable: true, value: mockResponse.body });
      Object.defineProperty(this, 'response', { writable: true, value: mockResponse.body });

      reportRequest({
        url: this._interceptorUrl,
        method: this._interceptorMethod,
        type: 'xhr',
        status: mockResponse.status,
        statusText: mockResponse.statusText,
        requestHeaders: this._interceptorRequestHeaders,
        requestBody: body,
        responseHeaders: mockResponse.headers,
        responseBody: mockResponse.body,
        duration: 0,
        timestamp: new Date().toISOString(),
        intercepted: true,
        ruleId: rule.id
      });

      setTimeout(() => {
        if (this.onreadystatechange) this.onreadystatechange();
        if (this.onload) this.onload();
        this.dispatchEvent(new Event('load'));
        this.dispatchEvent(new Event('loadend'));
      }, 0);

      return;
    }

    if (rule && rule.action === 'modify') {
      if (rule.modifyBody) {
        body = rule.modifyBody;
      }

      const customHeaders = rule.customHeaders || {};
      for (const [name, value] of Object.entries(customHeaders)) {
        if (!(name in this._interceptorRequestHeaders)) {
          OriginalXHRSetRequestHeader.call(this, name, value);
          this._interceptorRequestHeaders[name] = value;
        }
      }
    }

    this.addEventListener('loadend', () => {
      const endTime = performance.now();
      const duration = Math.round(endTime - (this._interceptorStartTime || endTime));

      let responseBody = '';
      try {
        responseBody = this.responseText || this.response || '';
      } catch (e) {
        responseBody = '[Unable to read response]';
      }

      reportRequest({
        url: this._interceptorUrl,
        method: this._interceptorMethod,
        type: 'xhr',
        status: this.status,
        statusText: this.statusText,
        requestHeaders: this._interceptorRequestHeaders,
        requestBody: this._interceptorRequestBody,
        responseHeaders: {},
        responseBody,
        duration,
        timestamp: new Date().toISOString(),
        intercepted: this._interceptorIntercepted,
        ruleId: rule ? rule.id : null
      });
    });

    return OriginalXHRSend.apply(this, [body]);
  };
})();
