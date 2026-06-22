(function() {
  'use strict';

  let capturedRequests = [];
  let rules = [];
  let currentDetailRequest = null;
  let currentDetailTab = 'overview';

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    setupTabs();
    setupFilterBar();
    setupModals();
    setupRuleForm();
    setupActions();
    loadInitialData();
    listenForUpdates();
  }

  function setupTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(tab.dataset.tab + 'Panel').classList.add('active');
      });
    });
  }

  function setupFilterBar() {
    const filterUrl = document.getElementById('filterUrl');
    const filterMethod = document.getElementById('filterMethod');
    const filterStatus = document.getElementById('filterStatus');

    const applyFilters = () => {
      renderRequests();
    };

    filterUrl.addEventListener('input', applyFilters);
    filterMethod.addEventListener('change', applyFilters);
    filterStatus.addEventListener('change', applyFilters);
  }

  function setupModals() {
    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.modal').classList.add('hidden');
      });
    });

    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.classList.add('hidden');
        }
      });
    });
  }

  function setupRuleForm() {
    const ruleForm = document.getElementById('ruleForm');
    const ruleAction = document.getElementById('ruleAction');

    ruleAction.addEventListener('change', () => {
      document.getElementById('mockSection').classList.toggle('hidden', ruleAction.value !== 'mock');
      document.getElementById('modifySection').classList.toggle('hidden', ruleAction.value !== 'modify');
      document.getElementById('redirectSection').classList.toggle('hidden', ruleAction.value !== 'redirect');
    });

    document.getElementById('addRule').addEventListener('click', () => {
      document.getElementById('ruleModalTitle').textContent = '添加规则';
      ruleForm.reset();
      document.getElementById('ruleId').value = '';
      ruleAction.value = 'mock';
      ruleAction.dispatchEvent(new Event('change'));
      document.getElementById('ruleModal').classList.remove('hidden');
    });

    document.getElementById('saveRule').addEventListener('click', saveRule);

    document.getElementById('importRules').addEventListener('click', () => {
      document.getElementById('importFileInput').click();
    });

    document.getElementById('importFileInput').addEventListener('change', handleImport);

    document.getElementById('exportRules').addEventListener('click', handleExport);
  }

  function setupActions() {
    document.getElementById('clearRequests').addEventListener('click', () => {
      capturedRequests = [];
      renderRequests();
      chrome.runtime.sendMessage({ type: 'CLEAR_REQUESTS' });
    });

    document.getElementById('openRules').addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.querySelector('[data-tab="rules"]').classList.add('active');
      document.getElementById('rulesPanel').classList.add('active');
    });

    document.querySelectorAll('.detail-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentDetailTab = tab.dataset.detailTab;
        renderDetailContent();
      });
    });

    document.getElementById('copyCurl').addEventListener('click', copyAsCurl);
    document.getElementById('copyResponse').addEventListener('click', copyResponse);
    document.getElementById('mockFromRequest').addEventListener('click', () => createRuleFromRequest('mock'));
    document.getElementById('modifyFromRequest').addEventListener('click', () => createRuleFromRequest('modify'));
  }

  function loadInitialData() {
    chrome.runtime.sendMessage({ type: 'GET_CAPTURED_REQUESTS' }, (response) => {
      if (response && response.requests) {
        capturedRequests = response.requests;
        renderRequests();
      }
    });

    chrome.runtime.sendMessage({ type: 'GET_RULES' }, (response) => {
      if (response && response.rules) {
        rules = response.rules;
        renderRules();
      }
    });
  }

  function listenForUpdates() {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'NEW_REQUEST') {
        capturedRequests.unshift(message.request);
        if (capturedRequests.length > 500) {
          capturedRequests = capturedRequests.slice(0, 500);
        }
        renderRequests();
      }
      if (message.type === 'REQUESTS_CLEARED') {
        capturedRequests = [];
        renderRequests();
      }
      if (message.type === 'RULES_UPDATED') {
        rules = message.rules;
        renderRules();
      }
    });
  }

  function renderRequests() {
    const container = document.getElementById('requestList');
    const filtered = getFilteredRequests();

    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty-state">暂无匹配的请求</div>';
      return;
    }

    container.innerHTML = filtered.map(req => {
      const methodClass = `method-${req.method.toLowerCase()}`;
      const statusClass = getStatusClass(req.status);
      return `
        <div class="request-item ${req.intercepted ? 'intercepted' : ''}" data-id="${req.id}">
          <div class="request-item-header">
            <span class="request-method ${methodClass}">${req.method}</span>
            <span class="request-url" title="${escapeHtml(req.url)}">${escapeHtml(truncateUrl(req.url))}</span>
            <span class="request-status ${statusClass}">${req.status}</span>
            <span class="request-duration">${req.duration}ms</span>
          </div>
          <div class="request-time">${formatTime(req.timestamp)}</div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.request-item').forEach(item => {
      item.addEventListener('click', () => {
        const req = capturedRequests.find(r => r.id === item.dataset.id);
        if (req) showRequestDetail(req);
      });
    });
  }

  function getFilteredRequests() {
    const filterUrl = document.getElementById('filterUrl').value.toLowerCase();
    const filterMethod = document.getElementById('filterMethod').value;
    const filterStatus = document.getElementById('filterStatus').value;

    return capturedRequests.filter(req => {
      if (filterUrl && !req.url.toLowerCase().includes(filterUrl)) return false;
      if (filterMethod && req.method !== filterMethod) return false;
      if (filterStatus) {
        const status = req.status.toString();
        if (filterStatus === '2xx' && !status.startsWith('2')) return false;
        if (filterStatus === '3xx' && !status.startsWith('3')) return false;
        if (filterStatus === '4xx' && !status.startsWith('4')) return false;
        if (filterStatus === '5xx' && !status.startsWith('5')) return false;
      }
      return true;
    });
  }

  function renderRules() {
    const container = document.getElementById('ruleList');

    if (rules.length === 0) {
      container.innerHTML = '<div class="empty-state">暂无拦截规则</div>';
      return;
    }

    container.innerHTML = rules.map(rule => `
      <div class="rule-item ${rule.enabled === false ? 'disabled' : ''}" data-id="${rule.id}">
        <div class="rule-item-header">
          <span class="rule-name">${escapeHtml(rule.name)}</span>
          <div class="rule-actions">
            <div class="toggle-switch ${rule.enabled !== false ? 'active' : ''}" data-rule-id="${rule.id}"></div>
            <button class="btn btn-secondary btn-edit" data-rule-id="${rule.id}">编辑</button>
            <button class="btn btn-secondary btn-delete" data-rule-id="${rule.id}">删除</button>
          </div>
        </div>
        <div class="rule-info">
          <span class="rule-tag">${rule.matchType === 'regex' ? '正则' : '包含'}</span>
          <span class="rule-tag">${escapeHtml(rule.urlPattern)}</span>
          <span class="rule-tag">${rule.action === 'mock' ? 'Mock' : rule.action === 'modify' ? '修改' : '重定向'}</span>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.toggle-switch').forEach(toggle => {
      toggle.addEventListener('click', () => {
        chrome.runtime.sendMessage({
          type: 'TOGGLE_RULE',
          ruleId: toggle.dataset.ruleId
        }, (response) => {
          if (response && response.rules) {
            rules = response.rules;
            renderRules();
          }
        });
      });
    });

    container.querySelectorAll('.btn-edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const rule = rules.find(r => r.id === btn.dataset.ruleId);
        if (rule) editRule(rule);
      });
    });

    container.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('确定要删除这条规则吗？')) {
          chrome.runtime.sendMessage({
            type: 'DELETE_RULE',
            ruleId: btn.dataset.ruleId
          }, (response) => {
            if (response && response.rules) {
              rules = response.rules;
              renderRules();
            }
          });
        }
      });
    });
  }

  function editRule(rule) {
    document.getElementById('ruleModalTitle').textContent = '编辑规则';
    document.getElementById('ruleId').value = rule.id;
    document.getElementById('ruleName').value = rule.name;
    document.getElementById('ruleUrlPattern').value = rule.urlPattern;
    document.getElementById('ruleMatchType').value = rule.matchType || 'contains';
    document.getElementById('ruleAction').value = rule.action;

    document.querySelectorAll('input[name="method"]').forEach(cb => {
      cb.checked = rule.methods && rule.methods.includes(cb.value);
    });

    if (rule.action === 'mock') {
      document.getElementById('mockStatus').value = rule.mockStatus || 200;
      document.getElementById('mockBody').value = rule.mockBody || '';
      document.getElementById('mockHeaders').value = rule.mockHeaders ? JSON.stringify(rule.mockHeaders, null, 2) : '';
    } else if (rule.action === 'modify') {
      document.getElementById('modifyQuery').value = rule.modifyQuery ? JSON.stringify(rule.modifyQuery, null, 2) : '';
      document.getElementById('modifyBody').value = rule.modifyBody || '';
      document.getElementById('customHeaders').value = rule.customHeaders ? JSON.stringify(rule.customHeaders, null, 2) : '';
    } else if (rule.action === 'redirect') {
      document.getElementById('redirectUrl').value = rule.redirectUrl || '';
    }

    document.getElementById('ruleAction').dispatchEvent(new Event('change'));
    document.getElementById('ruleModal').classList.remove('hidden');
  }

  function saveRule() {
    const ruleId = document.getElementById('ruleId').value;
    const name = document.getElementById('ruleName').value.trim();
    const urlPattern = document.getElementById('ruleUrlPattern').value.trim();
    const matchType = document.getElementById('ruleMatchType').value;
    const action = document.getElementById('ruleAction').value;

    const methods = [];
    document.querySelectorAll('input[name="method"]:checked').forEach(cb => {
      methods.push(cb.value);
    });

    if (!name || !urlPattern) {
      alert('请填写规则名称和URL匹配模式');
      return;
    }

    const rule = {
      id: ruleId || Date.now().toString(36) + Math.random().toString(36).substr(2),
      name,
      urlPattern,
      matchType,
      methods,
      action,
      enabled: true
    };

    if (action === 'mock') {
      rule.mockStatus = parseInt(document.getElementById('mockStatus').value) || 200;
      rule.mockBody = document.getElementById('mockBody').value;
      try {
        rule.mockHeaders = JSON.parse(document.getElementById('mockHeaders').value || '{}');
      } catch (e) {
        rule.mockHeaders = { 'Content-Type': 'application/json' };
      }
    } else if (action === 'modify') {
      try {
        rule.modifyQuery = JSON.parse(document.getElementById('modifyQuery').value || '{}');
      } catch (e) {
        rule.modifyQuery = {};
      }
      rule.modifyBody = document.getElementById('modifyBody').value;
      try {
        rule.customHeaders = JSON.parse(document.getElementById('customHeaders').value || '{}');
      } catch (e) {
        rule.customHeaders = {};
      }
    } else if (action === 'redirect') {
      rule.redirectUrl = document.getElementById('redirectUrl').value;
    }

    if (ruleId) {
      const index = rules.findIndex(r => r.id === ruleId);
      if (index !== -1) {
        rule.enabled = rules[index].enabled;
        rules[index] = rule;
      }
      chrome.runtime.sendMessage({ type: 'UPDATE_RULES', rules });
    } else {
      chrome.runtime.sendMessage({ type: 'ADD_RULE', rule });
    }

    document.getElementById('ruleModal').classList.add('hidden');
  }

  function handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const importedRules = JSON.parse(event.target.result);
        if (Array.isArray(importedRules)) {
          chrome.runtime.sendMessage({ type: 'IMPORT_RULES', rules: importedRules }, (response) => {
            if (response && response.success) {
              rules = importedRules;
              renderRules();
              showToast('导入成功');
            }
          });
        }
      } catch (err) {
        alert('导入失败：文件格式不正确');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function handleExport() {
    const data = JSON.stringify(rules, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `interceptor-rules-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function showRequestDetail(request) {
    currentDetailRequest = request;
    currentDetailTab = 'overview';

    document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('[data-detail-tab="overview"]').classList.add('active');

    renderDetailContent();
    document.getElementById('requestDetail').classList.remove('hidden');
  }

  function renderDetailContent() {
    if (!currentDetailRequest) return;

    const container = document.getElementById('detailContent');
    const req = currentDetailRequest;

    switch (currentDetailTab) {
      case 'overview':
        container.innerHTML = `
          <div class="detail-row"><span class="detail-label">方法</span><span class="detail-value">${req.method}</span></div>
          <div class="detail-row"><span class="detail-label">URL</span><span class="detail-value">${escapeHtml(req.url)}</span></div>
          <div class="detail-row"><span class="detail-label">状态</span><span class="detail-value">${req.status} ${req.statusText}</span></div>
          <div class="detail-row"><span class="detail-label">耗时</span><span class="detail-value">${req.duration}ms</span></div>
          <div class="detail-row"><span class="detail-label">类型</span><span class="detail-value">${req.type}</span></div>
          <div class="detail-row"><span class="detail-label">拦截</span><span class="detail-value">${req.intercepted ? '是' : '否'}</span></div>
          <div class="detail-row"><span class="detail-label">时间</span><span class="detail-value">${formatTime(req.timestamp)}</span></div>
        `;
        break;

      case 'headers':
        const headers = req.requestHeaders || {};
        container.innerHTML = Object.entries(headers).map(([key, value]) =>
          `<div class="detail-row"><span class="detail-label">${escapeHtml(key)}</span><span class="detail-value">${escapeHtml(String(value))}</span></div>`
        ).join('') || '<div class="empty-state">无请求头</div>';
        break;

      case 'body':
        container.innerHTML = `<div class="detail-value">${escapeHtml(req.requestBody || '无请求体')}</div>`;
        break;

      case 'response':
        let responseContent = '';
        try {
          const parsed = JSON.parse(req.responseBody);
          responseContent = JSON.stringify(parsed, null, 2);
        } catch (e) {
          responseContent = req.responseBody || '无响应体';
        }
        container.innerHTML = `<div class="detail-value">${escapeHtml(responseContent)}</div>`;
        break;
    }
  }

  function copyAsCurl() {
    if (!currentDetailRequest) return;

    const req = currentDetailRequest;
    let curl = `curl -X ${req.method} '${req.url}'`;

    const headers = req.requestHeaders || {};
    for (const [key, value] of Object.entries(headers)) {
      curl += ` \\\n  -H '${key}: ${value}'`;
    }

    if (req.requestBody) {
      curl += ` \\\n  -d '${req.requestBody}'`;
    }

    navigator.clipboard.writeText(curl).then(() => {
      showToast('cURL 命令已复制');
    });
  }

  function copyResponse() {
    if (!currentDetailRequest) return;

    navigator.clipboard.writeText(currentDetailRequest.responseBody || '').then(() => {
      showToast('响应体已复制');
    });
  }

  function createRuleFromRequest(action) {
    if (!currentDetailRequest) return;
    const req = currentDetailRequest;

    document.getElementById('requestDetail').classList.add('hidden');

    document.getElementById('ruleModalTitle').textContent = '添加规则';
    document.getElementById('ruleId').value = '';
    document.getElementById('ruleName').value = '';
    document.getElementById('ruleUrlPattern').value = req.url;
    document.getElementById('ruleMatchType').value = 'contains';

    document.querySelectorAll('input[name="method"]').forEach(cb => {
      cb.checked = cb.value === req.method;
    });

    const ruleAction = document.getElementById('ruleAction');
    ruleAction.value = action;
    ruleAction.dispatchEvent(new Event('change'));

    if (action === 'mock') {
      document.getElementById('mockStatus').value = req.status || 200;
      try {
        const parsed = JSON.parse(req.responseBody);
        document.getElementById('mockBody').value = JSON.stringify(parsed, null, 2);
      } catch (e) {
        document.getElementById('mockBody').value = req.responseBody || '';
      }
      try {
        document.getElementById('mockHeaders').value = JSON.stringify(req.responseHeaders || {}, null, 2);
      } catch (e) {
        document.getElementById('mockHeaders').value = '{}';
      }
    } else if (action === 'modify') {
      try {
        const headers = typeof req.requestHeaders === 'object' ? req.requestHeaders : {};
        document.getElementById('customHeaders').value = JSON.stringify(headers, null, 2);
      } catch (e) {
        document.getElementById('customHeaders').value = '{}';
      }
      document.getElementById('modifyBody').value = req.requestBody || '';
      document.getElementById('modifyQuery').value = '{}';
    }

    document.getElementById('ruleModal').classList.remove('hidden');
  }

  function getStatusClass(status) {
    if (status >= 200 && status < 300) return 'status-2xx';
    if (status >= 300 && status < 400) return 'status-3xx';
    if (status >= 400 && status < 500) return 'status-4xx';
    if (status >= 500) return 'status-5xx';
    return '';
  }

  function truncateUrl(url) {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname + urlObj.search;
      if (path.length > 50) {
        return urlObj.hostname + path.substring(0, 50) + '...';
      }
      return urlObj.hostname + path;
    } catch (e) {
      return url.length > 60 ? url.substring(0, 60) + '...' : url;
    }
  }

  function formatTime(timestamp) {
    try {
      const date = new Date(timestamp);
      return date.toLocaleTimeString('zh-CN', { hour12: false });
    } catch (e) {
      return timestamp;
    }
  }

  function escapeHtml(str) {
    if (typeof str !== 'string') str = String(str);
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#18a058;color:white;padding:10px 18px;border-radius:8px;font-size:13px;font-weight:500;z-index:9999;box-shadow:0 4px 12px rgba(24,160,88,0.3);animation:toastIn 0.2s ease;';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.2s ease';
      setTimeout(() => toast.remove(), 200);
    }, 2000);
  }
})();
