/**
 * sidepanel/sidepanel.js
 *
 * Side Panel（侧边栏面板）的 UI 交互逻辑。
 * 这是扩展的主界面，提供两大核心功能：
 *   1. 请求列表：实时展示所有捕获的网络请求（包括被拦截和未被拦截的）
 *   2. 规则管理：CRUD 操作拦截规则，支持导入/导出
 *
 * 通信架构：
 *   sidepanel.js ←→ background service-worker.js（通过 chrome.runtime.sendMessage）
 *   - 请求数据：background 广播 NEW_REQUEST → sidepanel 接收并渲染
 *   - 规则数据：background 广播 RULES_UPDATED → sidepanel 接收并渲染
 *
 * UI 组件结构：
 *   - Tab 切换（请求列表 / 拦截规则）
 *   - 过滤栏（URL、HTTP 方法、状态码）
 *   - 请求列表（点击查看详情）
 *   - 规则列表（启用/禁用、编辑、删除）
 *   - 请求详情弹窗（概览、请求头、请求体、响应）
 *   - 规则编辑弹窗（支持 mock/modify/redirect 三种动作）
 */
(function() {
  'use strict';

  /* ===== 全局状态 ===== */

  /** @type {Array<Object>} 已捕获的请求列表 */
  let capturedRequests = [];

  /** @type {Array<Object>} 拦截规则列表 */
  let rules = [];

  /** @type {Object|null} 当前在详情弹窗中查看的请求对象 */
  let currentDetailRequest = null;

  /** @type {string} 当前详情弹窗中激活的标签页（overview/headers/body/response） */
  let currentDetailTab = 'overview';

  /* ===== 初始化 ===== */

  /** DOM 加载完成后初始化所有 UI 模块 */
  document.addEventListener('DOMContentLoaded', init);

  /**
   * 主初始化函数，按顺序设置各个 UI 模块。
   */
  function init() {
    setupTabs();
    setupFilterBar();
    setupModals();
    setupRuleForm();
    setupActions();
    loadInitialData();
    listenForUpdates();
  }

  /* ===== Tab 切换 ===== */

  /**
   * 设置主 Tab 切换逻辑（请求列表 / 拦截规则）。
   * 点击 Tab 时切换对应 Panel 的显示/隐藏。
   */
  function setupTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        // 移除所有 Tab 和 Panel 的 active 状态
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        // 激活当前点击的 Tab 和对应的 Panel
        tab.classList.add('active');
        document.getElementById(tab.dataset.tab + 'Panel').classList.add('active');
      });
    });
  }

  /* ===== 过滤栏 ===== */

  /**
   * 设置请求列表的过滤功能。
   * 支持按 URL 关键字、HTTP 方法、状态码范围进行过滤。
   * 任何过滤条件变化时自动重新渲染请求列表。
   */
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

  /* ===== 弹窗管理 ===== */

  /**
   * 设置所有 Modal 弹窗的关闭逻辑。
   * - 点击关闭按钮（.modal-close）关闭弹窗
   * - 点击弹窗背景遮罩层关闭弹窗
   */
  function setupModals() {
    // 关闭按钮
    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.modal').classList.add('hidden');
      });
    });

    // 点击遮罩层关闭
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.classList.add('hidden');
        }
      });
    });
  }

  /* ===== 规则表单 ===== */

  /**
   * 设置规则编辑表单的交互逻辑。
   * - 拦截动作切换：根据选择的 action（mock/modify/redirect）显示对应的配置区域
   * - 添加规则：重置表单并打开弹窗
   * - 保存规则：收集表单数据并发送给 background
   * - 导入/导出：处理规则文件的导入导出
   */
  function setupRuleForm() {
    const ruleForm = document.getElementById('ruleForm');
    const ruleAction = document.getElementById('ruleAction');

    // 拦截动作切换时，显示/隐藏对应的配置区域
    ruleAction.addEventListener('change', () => {
      document.getElementById('mockSection').classList.toggle('hidden', ruleAction.value !== 'mock');
      document.getElementById('modifySection').classList.toggle('hidden', ruleAction.value !== 'modify');
      document.getElementById('redirectSection').classList.toggle('hidden', ruleAction.value !== 'redirect');
    });

    // 添加规则按钮：重置表单并打开弹窗
    document.getElementById('addRule').addEventListener('click', () => {
      document.getElementById('ruleModalTitle').textContent = '添加规则';
      ruleForm.reset();
      document.getElementById('ruleId').value = '';
      ruleAction.value = 'mock';
      ruleAction.dispatchEvent(new Event('change'));
      document.getElementById('ruleModal').classList.remove('hidden');
    });

    // 保存规则按钮
    document.getElementById('saveRule').addEventListener('click', saveRule);

    // 导入规则按钮：触发隐藏的文件选择器
    document.getElementById('importRules').addEventListener('click', () => {
      document.getElementById('importFileInput').click();
    });

    // 文件选择器变化时处理导入
    document.getElementById('importFileInput').addEventListener('change', handleImport);

    // 导出规则按钮
    document.getElementById('exportRules').addEventListener('click', handleExport);
  }

  /* ===== 操作按钮 ===== */

  /**
   * 设置各个操作按钮的事件处理。
   * - 清空请求列表
   * - 打开规则管理面板
   * - 详情弹窗内的 Tab 切换
   * - 复制 cURL / 复制响应
   * - 从请求创建规则
   */
  function setupActions() {
    // 清空请求列表
    document.getElementById('clearRequests').addEventListener('click', () => {
      capturedRequests = [];
      renderRequests();
      chrome.runtime.sendMessage({ type: 'CLEAR_REQUESTS' });
    });

    // 快捷跳转到规则管理面板
    document.getElementById('openRules').addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.querySelector('[data-tab="rules"]').classList.add('active');
      document.getElementById('rulesPanel').classList.add('active');
    });

    // 详情弹窗内的 Tab 切换（概览/请求头/请求体/响应）
    document.querySelectorAll('.detail-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentDetailTab = tab.dataset.detailTab;
        renderDetailContent();
      });
    });

    // 复制 cURL 命令
    document.getElementById('copyCurl').addEventListener('click', copyAsCurl);
    // 复制响应体
    document.getElementById('copyResponse').addEventListener('click', copyResponse);
    // 从当前请求创建 Mock 规则
    document.getElementById('mockFromRequest').addEventListener('click', () => createRuleFromRequest('mock'));
    // 从当前请求创建 Modify 规则
    document.getElementById('modifyFromRequest').addEventListener('click', () => createRuleFromRequest('modify'));
  }

  /* ===== 数据加载 ===== */

  /**
   * 从 background 加载初始数据。
   * - 获取已捕获的请求列表
   * - 获取当前的拦截规则列表
   */
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

  /* ===== 实时更新监听 ===== */

  /**
   * 监听来自 background 的实时消息。
   * - NEW_REQUEST：新请求到达，插入列表头部并渲染
   * - REQUESTS_CLEARED：请求列表被清空
   * - RULES_UPDATED：规则列表发生变更
   */
  function listenForUpdates() {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'NEW_REQUEST') {
        capturedRequests.unshift(message.request);
        // 内存中最多保留 500 条
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

  /* ===== 请求列表渲染 ===== */

  /**
   * 渲染请求列表。
   * 先应用过滤条件，然后生成 HTML 并绑定点击事件。
   * 每个请求项显示：HTTP 方法、URL、状态码、耗时、时间。
   */
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

    // 为每个请求项绑定点击事件，打开详情弹窗
    container.querySelectorAll('.request-item').forEach(item => {
      item.addEventListener('click', () => {
        const req = capturedRequests.find(r => r.id === item.dataset.id);
        if (req) showRequestDetail(req);
      });
    });
  }

  /**
   * 根据过滤条件筛选请求列表。
   *
   * @returns {Array<Object>} 过滤后的请求列表
   */
  function getFilteredRequests() {
    const filterUrl = document.getElementById('filterUrl').value.toLowerCase();
    const filterMethod = document.getElementById('filterMethod').value;
    const filterStatus = document.getElementById('filterStatus').value;

    return capturedRequests.filter(req => {
      // URL 关键字过滤（不区分大小写）
      if (filterUrl && !req.url.toLowerCase().includes(filterUrl)) return false;
      // HTTP 方法过滤
      if (filterMethod && req.method !== filterMethod) return false;
      // 状态码范围过滤（2xx/3xx/4xx/5xx）
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

  /* ===== 规则列表渲染 ===== */

  /**
   * 渲染拦截规则列表。
   * 每条规则显示：名称、匹配类型、URL 模式、动作类型。
   * 支持启用/禁用切换、编辑、删除操作。
   */
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

    // 启用/禁用切换
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

    // 编辑按钮
    container.querySelectorAll('.btn-edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const rule = rules.find(r => r.id === btn.dataset.ruleId);
        if (rule) editRule(rule);
      });
    });

    // 删除按钮
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

  /* ===== 规则编辑 ===== */

  /**
   * 打开规则编辑弹窗，填充已有规则的数据。
   *
   * @param {Object} rule - 要编辑的规则对象
   */
  function editRule(rule) {
    document.getElementById('ruleModalTitle').textContent = '编辑规则';
    document.getElementById('ruleId').value = rule.id;
    document.getElementById('ruleName').value = rule.name;
    document.getElementById('ruleUrlPattern').value = rule.urlPattern;
    document.getElementById('ruleMatchType').value = rule.matchType || 'contains';
    document.getElementById('ruleAction').value = rule.action;

    // 勾选规则中指定的 HTTP 方法
    document.querySelectorAll('input[name="method"]').forEach(cb => {
      cb.checked = rule.methods && rule.methods.includes(cb.value);
    });

    // 根据动作类型填充对应的配置字段
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

    // 触发 action 切换事件，显示对应的配置区域
    document.getElementById('ruleAction').dispatchEvent(new Event('change'));
    document.getElementById('ruleModal').classList.remove('hidden');
  }

  /**
   * 保存规则（新建或更新）。
   * 从表单收集数据，构建规则对象，发送给 background 处理。
   */
  function saveRule() {
    const ruleId = document.getElementById('ruleId').value;
    const name = document.getElementById('ruleName').value.trim();
    const urlPattern = document.getElementById('ruleUrlPattern').value.trim();
    const matchType = document.getElementById('ruleMatchType').value;
    const action = document.getElementById('ruleAction').value;

    // 收集勾选的 HTTP 方法
    const methods = [];
    document.querySelectorAll('input[name="method"]:checked').forEach(cb => {
      methods.push(cb.value);
    });

    // 表单验证
    if (!name || !urlPattern) {
      alert('请填写规则名称和URL匹配模式');
      return;
    }

    // 构建规则对象
    const rule = {
      /** 使用时间戳+随机数生成唯一 ID */
      id: ruleId || Date.now().toString(36) + Math.random().toString(36).substr(2),
      name,
      urlPattern,
      matchType,
      methods,
      action,
      enabled: true
    };

    // 根据动作类型添加对应的配置字段
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

    // 发送到 background：更新已有规则或添加新规则
    if (ruleId) {
      const index = rules.findIndex(r => r.id === ruleId);
      if (index !== -1) {
        rule.enabled = rules[index].enabled; // 保留原有的启用状态
        rules[index] = rule;
      }
      chrome.runtime.sendMessage({ type: 'UPDATE_RULES', rules });
    } else {
      chrome.runtime.sendMessage({ type: 'ADD_RULE', rule });
    }

    // 关闭弹窗
    document.getElementById('ruleModal').classList.add('hidden');
  }

  /* ===== 导入/导出 ===== */

  /**
   * 处理规则文件导入。
   * 读取用户选择的 JSON 文件，解析后发送给 background。
   *
   * @param {Event} e - 文件选择事件
   */
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
    e.target.value = ''; // 重置文件选择器，允许重复选择同一文件
  }

  /**
   * 处理规则导出。
   * 将当前规则列表序列化为 JSON 并触发文件下载。
   */
  function handleExport() {
    const data = JSON.stringify(rules, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `interceptor-rules-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url); // 释放 Blob URL
  }

  /* ===== 请求体渲染 ===== */

  let bodyViewMode = 'parsed';
  let responseViewMode = 'parsed';

  /**
   * 检查值是否包含嵌套的复杂结构（对象或数组）。
   */
  function hasNestedComplex(value) {
    if (value === null || typeof value !== 'object') return false;
    if (Array.isArray(value)) {
      return value.some(item => item !== null && typeof item === 'object');
    }
    return Object.values(value).some(v => v !== null && typeof v === 'object');
  }

  /**
   * 递归渲染 JSON 为带层级缩进的键值对 HTML。
   * - 空对象/数组直接显示 {} 或 []
   * - 数组只有一个对象时自动展开
   * - 无嵌套的对象默认展开
   */
  function renderJsonTree(data, depth = 0) {
    if (data === null) return '<span class="json-null">null</span>';
    if (data === undefined) return '<span class="json-null">undefined</span>';
    if (typeof data === 'boolean') return `<span class="json-bool">${data}</span>`;
    if (typeof data === 'number') return `<span class="json-number">${data}</span>`;
    if (typeof data === 'string') return `<span class="json-string">"${escapeHtml(data)}"</span>`;

    const isArray = Array.isArray(data);
    const entries = isArray ? data.map((v, i) => [i, v]) : Object.entries(data);
    const count = entries.length;

    if (count === 0) {
      return `<span class="json-bracket">${isArray ? '[]' : '{}'}</span>`;
    }

    const id = 'jn_' + Math.random().toString(36).slice(2, 8);
    const indent = depth * 16;
    const openBracket = isArray ? '[' : '{';
    const closeBracket = isArray ? ']' : '}';
    const shouldAutoExpand = depth === 0 || !hasNestedComplex(data) || (isArray && count === 1);

    const items = entries.map(([key, value]) => {
      const isComplex = value !== null && typeof value === 'object';
      const prefix = isArray ? `<span class="json-index">[${key}]</span>` : `<span class="json-key">"${escapeHtml(String(key))}"</span>`;
      const connector = isComplex ? '' : ': ';

      if (isComplex) {
        const childEntries = Array.isArray(value) ? value : Object.values(value);
        const childCount = childEntries.length;
        const childEmpty = childCount === 0;
        const childIsArray = Array.isArray(value);
        const childOpen = childIsArray ? '[' : '{';
        const childClose = childIsArray ? ']' : '}';
        const childAutoExpand = !hasNestedComplex(value) || (childIsArray && childCount === 1);

        if (childEmpty) {
          return `
            <div class="json-node">
              <span class="json-spacer"></span>
              ${prefix}<span class="json-colon">: </span><span class="json-bracket">${childIsArray ? '[]' : '{}'}</span>
            </div>`;
        }

        if (childAutoExpand) {
          return `
            <div class="json-node">
              <span class="json-spacer"></span>
              ${prefix}<span class="json-colon">: </span>${renderJsonTree(value, depth + 1)}
            </div>`;
        }

        return `
          <div class="json-collapsible">
            <div class="json-node json-collapsed-preview">
              <span class="json-toggle" data-target="${id}_${key}">▶</span>
              ${prefix}<span class="json-colon">: </span><span class="json-bracket">${childOpen}</span><span class="json-ellipsis">...${childCount} items</span><span class="json-bracket">${childClose}</span>
            </div>
            <div class="json-children" id="${id}_${key}" style="display:none;padding-left:16px;border-left:1px solid var(--border-base);margin-left:${indent + 7}px;">
              ${renderJsonTree(value, depth + 1)}
            </div>
          </div>`;
      } else {
        return `
          <div class="json-node">
            <span class="json-spacer"></span>
            ${prefix}<span class="json-colon">${connector}</span>${renderJsonTree(value, depth + 1)}
          </div>`;
      }
    }).join('');

    if (shouldAutoExpand) {
      return `
        <div class="json-group">
          <div class="json-node">
            <span class="json-spacer"></span><span class="json-bracket-root">${openBracket}</span>
          </div>
          <div class="json-children" style="padding-left:16px;border-left:1px solid var(--border-base);margin-left:${7}px;">
            ${items}
          </div>
          <div class="json-node"><span class="json-spacer"></span><span class="json-bracket-root">${closeBracket}</span></div>
        </div>`;
    }

    return `
      <div class="json-group">
        <div class="json-node json-root">
          <span class="json-toggle json-toggle-root" data-target="${id}_root">▶</span>
          <span class="json-bracket-root">${openBracket}</span>
          <span class="json-count">${count} items</span>
        </div>
        <div class="json-children" id="${id}_root" style="display:none;padding-left:16px;border-left:1px solid var(--border-base);margin-left:7px;">
          ${items}
        </div>
        <div class="json-node"><span class="json-spacer"></span><span class="json-bracket-root">${closeBracket}</span></div>
      </div>`;
  }

  /**
   * 渲染请求体内容，支持 parsed（层级树）和 raw（原始文本）两种视图。
   */
  function renderBodyContent(container, body) {
    if (!body) {
      container.innerHTML = '<div class="empty-state">无请求体</div>';
      return;
    }

    const toggleHtml = `
      <div class="body-toggle">
        <button class="body-toggle-btn ${bodyViewMode === 'parsed' ? 'active' : ''}" data-view="parsed">解析</button>
        <button class="body-toggle-btn ${bodyViewMode === 'raw' ? 'active' : ''}" data-view="raw">原始</button>
      </div>
    `;

    if (bodyViewMode === 'raw') {
      let rawContent = body;
      try {
        const parsed = JSON.parse(body);
        rawContent = JSON.stringify(parsed, null, 2);
      } catch (e) {}
      container.innerHTML = toggleHtml + `<div class="body-raw">${escapeHtml(rawContent)}</div>`;
    } else {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {}

      if (parsed !== undefined) {
        container.innerHTML = toggleHtml + renderJsonTree(parsed);
      } else {
        // URL-encoded
        const entries = parseUrlEncoded(body);
        if (entries.length > 0) {
          container.innerHTML = toggleHtml + entries.map(([key, value]) =>
            `<div class="detail-row"><span class="detail-label">${escapeHtml(key)}</span><span class="detail-value">${escapeHtml(value)}</span></div>`
          ).join('');
        } else {
          container.innerHTML = toggleHtml + `<div class="body-raw">${escapeHtml(body)}</div>`;
        }
      }
    }

    bindToggleEvents(container);

    container.querySelectorAll('.body-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        bodyViewMode = btn.dataset.view;
        renderBodyContent(container, body);
      });
    });
  }

  /**
   * 渲染响应体内容，支持 parsed（层级树）和 raw（原始文本）两种视图。
   */
  function renderResponseContent(container, body) {
    if (!body) {
      container.innerHTML = '<div class="empty-state">无响应体</div>';
      return;
    }

    const toggleHtml = `
      <div class="body-toggle">
        <button class="body-toggle-btn ${responseViewMode === 'parsed' ? 'active' : ''}" data-view="parsed">解析</button>
        <button class="body-toggle-btn ${responseViewMode === 'raw' ? 'active' : ''}" data-view="raw">原始</button>
      </div>
    `;

    if (responseViewMode === 'raw') {
      let rawContent = body;
      try {
        const parsed = JSON.parse(body);
        rawContent = JSON.stringify(parsed, null, 2);
      } catch (e) {}
      container.innerHTML = toggleHtml + `<div class="body-raw">${escapeHtml(rawContent)}</div>`;
    } else {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {}

      if (parsed !== undefined) {
        container.innerHTML = toggleHtml + renderJsonTree(parsed);
      } else {
        container.innerHTML = toggleHtml + `<div class="body-raw">${escapeHtml(body)}</div>`;
      }
    }

    bindToggleEvents(container);

    container.querySelectorAll('.body-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        responseViewMode = btn.dataset.view;
        renderResponseContent(container, body);
      });
    });
  }

  /**
   * 为容器内所有折叠按钮绑定展开/收起事件。
   */
  function bindToggleEvents(container) {
    container.querySelectorAll('.json-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = document.getElementById(btn.dataset.target);
        if (!target) return;
        const visible = target.style.display !== 'none';
        target.style.display = visible ? 'none' : '';
        btn.textContent = visible ? '▶' : '▼';
        const preview = btn.closest('.json-collapsible');
        if (preview) {
          const previewNode = preview.querySelector('.json-collapsed-preview');
          if (previewNode) previewNode.style.display = visible ? '' : 'none';
        }
      });
    });
  }

  /**
   * 解析 URL-encoded 字符串为 [key, value] 数组。
   */
  function parseUrlEncoded(body) {
    if (!body || !body.includes('=') || body.includes('{')) return [];
    try {
      const params = new URLSearchParams(body);
      const entries = [];
      for (const [k, v] of params) {
        entries.push([k, v]);
      }
      return entries;
    } catch (e) {
      return [];
    }
  }

  /* ===== 请求详情弹窗 ===== */

  /**
   * 显示请求详情弹窗。
   * 重置为"概览"标签页，渲染详情内容。
   *
   * @param {Object} request - 要查看详情的请求对象
   */
  function showRequestDetail(request) {
    currentDetailRequest = request;
    currentDetailTab = 'overview';

    // 重置详情弹窗的 Tab 状态
    document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('[data-detail-tab="overview"]').classList.add('active');

    renderDetailContent();
    document.getElementById('requestDetail').classList.remove('hidden');
  }

  /**
   * 根据当前激活的详情 Tab 渲染对应内容。
   * - overview：显示请求的基本信息（方法、URL、状态、耗时等）
   * - headers：显示请求头键值对
   * - body：显示请求体内容
   * - response：显示响应体（自动格式化 JSON）
   */
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
        renderBodyContent(container, req.requestBody);
        break;

      case 'response':
        renderResponseContent(container, req.responseBody);
        break;
    }
  }

  /* ===== 复制功能 ===== */

  /**
   * 将当前请求转换为 cURL 命令并复制到剪贴板。
   * 生成的 cURL 命令包含：HTTP 方法、URL、所有请求头、请求体。
   */
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

  /**
   * 复制当前请求的响应体到剪贴板。
   */
  function copyResponse() {
    if (!currentDetailRequest) return;

    navigator.clipboard.writeText(currentDetailRequest.responseBody || '').then(() => {
      showToast('响应体已复制');
    });
  }

  /* ===== 从请求创建规则 ===== */

  /**
   * 从当前查看的请求快速创建拦截规则。
   * 自动填充请求的 URL、方法、响应数据等信息，减少手动输入。
   *
   * @param {string} action - 规则动作类型：'mock' 或 'modify'
   */
  function createRuleFromRequest(action) {
    if (!currentDetailRequest) return;
    const req = currentDetailRequest;

    // 关闭详情弹窗
    document.getElementById('requestDetail').classList.add('hidden');

    // 打开规则编辑弹窗
    document.getElementById('ruleModalTitle').textContent = '添加规则';
    document.getElementById('ruleId').value = '';
    document.getElementById('ruleName').value = '';

    // 自动填充请求 URL 作为匹配模式
    document.getElementById('ruleUrlPattern').value = req.url;
    document.getElementById('ruleMatchType').value = 'contains';

    // 自动勾选请求的 HTTP 方法
    document.querySelectorAll('input[name="method"]').forEach(cb => {
      cb.checked = cb.value === req.method;
    });

    // 设置动作类型并触发切换
    const ruleAction = document.getElementById('ruleAction');
    ruleAction.value = action;
    ruleAction.dispatchEvent(new Event('change'));

    // 根据动作类型预填充数据
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

  /* ===== 工具函数 ===== */

  /**
   * 根据 HTTP 状态码返回对应的 CSS 类名。
   *
   * @param {number} status - HTTP 状态码
   * @returns {string} CSS 类名（status-2xx / status-3xx / status-4xx / status-5xx）
   */
  function getStatusClass(status) {
    if (status >= 200 && status < 300) return 'status-2xx';
    if (status >= 300 && status < 400) return 'status-3xx';
    if (status >= 400 && status < 500) return 'status-4xx';
    if (status >= 500) return 'status-5xx';
    return '';
  }

  /**
   * 截断过长的 URL，只显示域名和路径的前 50 个字符。
   *
   * @param {string} url - 完整 URL
   * @returns {string} 截断后的 URL 字符串
   */
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

  /**
   * 格式化 ISO 时间戳为中文时间格式（HH:MM:SS）。
   *
   * @param {string} timestamp - ISO 格式的时间戳
   * @returns {string} 格式化后的时间字符串
   */
  function formatTime(timestamp) {
    try {
      const date = new Date(timestamp);
      return date.toLocaleTimeString('zh-CN', { hour12: false });
    } catch (e) {
      return timestamp;
    }
  }

  /**
   * HTML 实体转义，防止 XSS 攻击。
   * 转义字符：& < > " '
   *
   * @param {string} str - 原始字符串
   * @returns {string} 转义后的安全字符串
   */
  function escapeHtml(str) {
    if (typeof str !== 'string') str = String(str);
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * 显示一个临时的 Toast 提示消息。
   * 2 秒后自动淡出并移除。
   *
   * @param {string} message - 要显示的消息文本
   */
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
