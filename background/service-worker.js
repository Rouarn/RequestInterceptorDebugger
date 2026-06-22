let rules = [];
let capturedRequests = [];

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ enabled: true });
  loadRules();
});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_RULES':
      sendResponse({ rules });
      break;

    case 'UPDATE_RULES':
      rules = message.rules;
      saveRules();
      broadcastRules();
      sendResponse({ success: true });
      break;

    case 'ADD_RULE':
      rules.push(message.rule);
      saveRules();
      broadcastRules();
      updateBadge();
      sendResponse({ success: true, rules });
      break;

    case 'DELETE_RULE':
      rules = rules.filter(r => r.id !== message.ruleId);
      saveRules();
      broadcastRules();
      updateBadge();
      sendResponse({ success: true, rules });
      break;

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

    case 'IMPORT_RULES':
      rules = message.rules;
      saveRules();
      broadcastRules();
      updateBadge();
      sendResponse({ success: true });
      break;

    case 'EXPORT_RULES':
      sendResponse({ rules });
      break;

    case 'REQUEST_INTERCEPTED':
      const request = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2),
        url: message.data.url,
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
        ruleId: message.data.ruleId
      };
      capturedRequests.unshift(request);
      if (capturedRequests.length > 500) {
        capturedRequests = capturedRequests.slice(0, 500);
      }
      broadcastToSidePanel({ type: 'NEW_REQUEST', request });
      break;

    case 'GET_CAPTURED_REQUESTS':
      sendResponse({ requests: capturedRequests });
      break;

    case 'CLEAR_REQUESTS':
      capturedRequests = [];
      broadcastToSidePanel({ type: 'REQUESTS_CLEARED' });
      sendResponse({ success: true });
      break;
  }
  return true;
});

function saveRules() {
  chrome.storage.local.set({ interceptRules: rules });
}

function loadRules() {
  chrome.storage.local.get(['interceptRules'], (result) => {
    rules = result.interceptRules || [];
    broadcastRules();
    updateBadge();
  });
}

function broadcastRules() {
  const message = { type: 'RULES_UPDATED', rules: rules };
  chrome.runtime.sendMessage(message).catch(() => {});
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    });
  });
}

function broadcastToSidePanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    });
  });
}

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
