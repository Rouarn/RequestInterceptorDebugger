(function() {
  'use strict';

  let rules = [];

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('content/interceptor.js');
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'RULES_UPDATED') {
      rules = message.rules;
      window.postMessage({
        source: 'request-interceptor-content',
        type: 'UPDATE_RULES',
        rules: rules
      }, '*');
    }
    if (message.type === 'NEW_REQUEST' || message.type === 'REQUESTS_CLEARED') {
      sendResponse({ success: true });
    }
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.source === 'request-interceptor-main') {
      switch (event.data.type) {
        case 'REQUEST_INTERCEPTED':
          chrome.runtime.sendMessage({
            type: 'REQUEST_INTERCEPTED',
            data: event.data.request
          });
          break;

        case 'REQUESTS_CLEARED':
          chrome.runtime.sendMessage({
            type: 'CLEAR_REQUESTS'
          });
          break;
      }
    }
  });

  chrome.runtime.sendMessage({ type: 'GET_RULES' }, (response) => {
    if (response && response.rules) {
      rules = response.rules;
      window.postMessage({
        source: 'request-interceptor-content',
        type: 'UPDATE_RULES',
        rules: rules
      }, '*');
    }
  });
})();
