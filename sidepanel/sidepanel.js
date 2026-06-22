/**
 * sidepanel/sidepanel.js (jQuery 4.0.0)
 *
 * Side Panel（侧边栏面板）的 UI 交互逻辑 - jQuery重构版。
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
$(function () {
  "use strict";

  /* ===== 全局状态 ===== */

  /** @type {Array<Object>} 已捕获的请求列表 */
  let capturedRequests = [];

  /** @type {Array<Object>} 拦截规则列表 */
  let rules = [];

  /** @type {Object|null} 当前在详情弹窗中查看的请求对象 */
  let currentDetailRequest = null;

  /** @type {string} 当前详情弹窗中激活的标签页（overview/headers/body/response） */
  let currentDetailTab = "overview";

  let bodyViewMode = "parsed";
  let responseViewMode = "parsed";

  /* ===== 初始化 ===== */

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

  init();

  /* ===== Tab 切换 ===== */

  /**
   * 设置主 Tab 切换逻辑（请求列表 / 拦截规则）。
   * 点击 Tab 时切换对应 Panel 的显示/隐藏。
   */
  function setupTabs() {
    $(".tab").on("click", function () {
      const $tab = $(this);
      $(".tab").removeClass("active");
      $(".panel").removeClass("active");
      $tab.addClass("active");
      $("#" + $tab.data("tab") + "Panel").addClass("active");
    });
  }

  /* ===== 过滤栏 ===== */

  /**
   * 设置请求列表的过滤功能。
   * 支持按 URL 关键字、HTTP 方法、状态码范围进行过滤。
   * 任何过滤条件变化时自动重新渲染请求列表。
   */
  function setupFilterBar() {
    const applyFilters = () => renderRequests();

    $("#filterUrl").on("input", applyFilters);
    $("#filterMethod").on("change", applyFilters);
    $("#filterStatus").on("change", applyFilters);
  }

  /* ===== 弹窗管理 ===== */

  /**
   * 设置所有 Modal 弹窗的关闭逻辑。
   * - 点击关闭按钮（.modal-close）关闭弹窗
   * - 点击弹窗背景遮罩层关闭弹窗
   */
  function setupModals() {
    $(document).on("click", ".modal-close", function () {
      $(this).closest(".modal").addClass("hidden");
    });

    $(".modal").on("click", function (e) {
      if (e.target === this) {
        $(this).addClass("hidden");
      }
    });
  }

  /* ===== 规则表单 ===== */

  /**
   * 设置规则编辑表单的交互逻辑。
   */
  function setupRuleForm() {
    const $ruleAction = $("#ruleAction");

    // 拦截动作切换时，显示/隐藏对应的配置区域
    $ruleAction.on("change", function () {
      const val = $(this).val();
      $("#mockSection").toggleClass("hidden", val !== "mock");
      $("#modifySection").toggleClass("hidden", val !== "modify");
      $("#redirectSection").toggleClass("hidden", val !== "redirect");
    });

    // 添加规则按钮：重置表单并打开弹窗
    $("#addRule").on("click", function () {
      $("#ruleModalTitle").text("添加规则");
      $("#ruleForm")[0].reset();
      $("#ruleId").val("");
      $ruleAction.val("mock").trigger("change");
      $("#ruleModal").removeClass("hidden");
    });

    // 保存规则按钮
    $("#saveRule").on("click", saveRule);

    // 导入规则按钮：触发隐藏的文件选择器
    $("#importRules").on("click", function () {
      $("#importFileInput").click();
    });

    // 文件选择器变化时处理导入
    $("#importFileInput").on("change", handleImport);

    // 导出规则按钮
    $("#exportRules").on("click", handleExport);
  }

  /* ===== 操作按钮 ===== */

  /**
   * 设置各个操作按钮的事件处理。
   */
  function setupActions() {
    // 清空请求列表
    $("#clearRequests").on("click", function () {
      capturedRequests = [];
      renderRequests();
      chrome.runtime.sendMessage({ type: "CLEAR_REQUESTS" });
    });

    // 快捷跳转到规则管理面板
    $("#openRules").on("click", function () {
      $(".tab").removeClass("active");
      $(".panel").removeClass("active");
      $('[data-tab="rules"]').addClass("active");
      $("#rulesPanel").addClass("active");
    });

    // 详情弹窗内的 Tab 切换（概览/请求头/请求体/响应）
    $(document).on("click", ".detail-tab", function () {
      const $tab = $(this);
      $(".detail-tab").removeClass("active");
      $tab.addClass("active");
      currentDetailTab = $tab.data("detail-tab");
      renderDetailContent();
    });

    // 复制 cURL 命令
    $("#copyCurl").on("click", copyAsCurl);
    // 复制响应体
    $("#copyResponse").on("click", copyResponse);
    // 从当前请求创建 Mock 规则
    $("#mockFromRequest").on("click", () => createRuleFromRequest("mock"));
    // 从当前请求创建 Modify 规则
    $("#modifyFromRequest").on("click", () => createRuleFromRequest("modify"));
  }

  /* ===== 数据加载 ===== */

  /**
   * 从 background 加载初始数据。
   */
  function loadInitialData() {
    chrome.runtime.sendMessage({ type: "GET_CAPTURED_REQUESTS" }, response => {
      if (response && response.requests) {
        capturedRequests = response.requests;
        renderRequests();
      }
    });

    chrome.runtime.sendMessage({ type: "GET_RULES" }, response => {
      if (response && response.rules) {
        rules = response.rules;
        renderRules();
      }
    });
  }

  /* ===== 实时更新监听 ===== */

  /**
   * 监听来自 background 的实时消息。
   */
  function listenForUpdates() {
    chrome.runtime.onMessage.addListener(message => {
      if (message.type === "NEW_REQUEST") {
        capturedRequests.unshift(message.request);
        if (capturedRequests.length > 500) {
          capturedRequests = capturedRequests.slice(0, 500);
        }
        renderRequests();
      }
      if (message.type === "REQUESTS_CLEARED") {
        capturedRequests = [];
        renderRequests();
      }
      if (message.type === "RULES_UPDATED") {
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
    const $container = $("#requestList");
    const filtered = getFilteredRequests();

    if (filtered.length === 0) {
      $container.html('<div class="empty-state">暂无匹配的请求</div>');
      return;
    }

    const html = filtered
      .map(req => {
        const methodClass = "method-" + req.method.toLowerCase();
        const statusClass = getStatusClass(req.status);
        return `
        <div class="request-item ${req.intercepted ? "intercepted" : ""}" data-id="${req.id}">
          <div class="request-item-header">
            <span class="request-method ${methodClass}">${req.method}</span>
            <span class="request-url" title="${escapeHtml(req.url)}">${escapeHtml(truncateUrl(req.url))}</span>
            <span class="request-status ${statusClass}">${req.status}</span>
            <span class="request-duration">${req.duration}ms</span>
          </div>
          <div class="request-time">${formatTime(req.timestamp)}</div>
        </div>
      `;
      })
      .join("");

    $container.html(html);

    // 使用事件委托绑定点击事件
    $container
      .off("click", ".request-item")
      .on("click", ".request-item", function () {
        const id = $(this).data("id");
        const req = capturedRequests.find(r => r.id === id);
        if (req) showRequestDetail(req);
      });
  }

  /**
   * 根据过滤条件筛选请求列表。
   */
  function getFilteredRequests() {
    const filterUrl = $("#filterUrl").val().toLowerCase();
    const filterMethod = $("#filterMethod").val();
    const filterStatus = $("#filterStatus").val();

    return capturedRequests.filter(req => {
      if (filterUrl && !req.url.toLowerCase().includes(filterUrl)) return false;
      if (filterMethod && req.method !== filterMethod) return false;
      if (filterStatus) {
        const status = req.status.toString();
        if (filterStatus === "2xx" && !status.startsWith("2")) return false;
        if (filterStatus === "3xx" && !status.startsWith("3")) return false;
        if (filterStatus === "4xx" && !status.startsWith("4")) return false;
        if (filterStatus === "5xx" && !status.startsWith("5")) return false;
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
    const $container = $("#ruleList");

    if (rules.length === 0) {
      $container.html('<div class="empty-state">暂无拦截规则</div>');
      return;
    }

    const html = rules
      .map(
        rule => `
      <div class="rule-item ${rule.enabled === false ? "disabled" : ""}" data-id="${rule.id}">
        <div class="rule-item-header">
          <span class="rule-name">${escapeHtml(rule.name)}</span>
          <div class="rule-actions">
            <div class="toggle-switch ${rule.enabled !== false ? "active" : ""}" data-rule-id="${rule.id}"></div>
            <button class="btn btn-secondary btn-edit" data-rule-id="${rule.id}">编辑</button>
            <button class="btn btn-secondary btn-delete" data-rule-id="${rule.id}">删除</button>
          </div>
        </div>
        <div class="rule-info">
          <span class="rule-tag">${rule.matchType === "regex" ? "正则" : "包含"}</span>
          <span class="rule-tag">${escapeHtml(rule.urlPattern)}</span>
          <span class="rule-tag">${rule.action === "mock" ? "Mock" : rule.action === "modify" ? "修改" : "重定向"}</span>
        </div>
      </div>
    `,
      )
      .join("");

    $container.html(html);

    // 使用事件委托处理动态元素的事件
    $container
      .off("click", ".toggle-switch")
      .on("click", ".toggle-switch", function () {
        const ruleId = $(this).data("rule-id");
        chrome.runtime.sendMessage(
          {
            type: "TOGGLE_RULE",
            ruleId: ruleId,
          },
          response => {
            if (response && response.rules) {
              rules = response.rules;
              renderRules();
            }
          },
        );
      });

    $container.off("click", ".btn-edit").on("click", ".btn-edit", function (e) {
      e.stopPropagation();
      const ruleId = $(this).data("rule-id");
      const rule = rules.find(r => r.id === ruleId);
      if (rule) editRule(rule);
    });

    $container
      .off("click", ".btn-delete")
      .on("click", ".btn-delete", function (e) {
        e.stopPropagation();
        if (confirm("确定要删除这条规则吗？")) {
          const ruleId = $(this).data("rule-id");
          chrome.runtime.sendMessage(
            {
              type: "DELETE_RULE",
              ruleId: ruleId,
            },
            response => {
              if (response && response.rules) {
                rules = response.rules;
                renderRules();
              }
            },
          );
        }
      });
  }

  /* ===== 规则编辑 ===== */

  /**
   * 打开规则编辑弹窗，填充已有规则的数据。
   */
  function editRule(rule) {
    $("#ruleModalTitle").text("编辑规则");
    $("#ruleId").val(rule.id);
    $("#ruleName").val(rule.name);
    $("#ruleUrlPattern").val(rule.urlPattern);
    $("#ruleMatchType").val(rule.matchType || "contains");
    $("#ruleAction").val(rule.action);

    // 勾选规则中指定的 HTTP 方法
    $('input[name="method"]').each(function () {
      $(this).prop(
        "checked",
        rule.methods && rule.methods.includes($(this).val()),
      );
    });

    // 根据动作类型填充对应的配置字段
    if (rule.action === "mock") {
      $("#mockStatus").val(rule.mockStatus || 200);
      $("#mockBody").val(rule.mockBody || "");
      $("#mockHeaders").val(
        rule.mockHeaders ? JSON.stringify(rule.mockHeaders, null, 2) : "",
      );
    } else if (rule.action === "modify") {
      $("#modifyQuery").val(
        rule.modifyQuery ? JSON.stringify(rule.modifyQuery, null, 2) : "",
      );
      $("#modifyBody").val(rule.modifyBody || "");
      $("#customHeaders").val(
        rule.customHeaders ? JSON.stringify(rule.customHeaders, null, 2) : "",
      );
    } else if (rule.action === "redirect") {
      $("#redirectUrl").val(rule.redirectUrl || "");
    }

    // 触发 action 切换事件，显示对应的配置区域
    $("#ruleAction").trigger("change");
    $("#ruleModal").removeClass("hidden");
  }

  /**
   * 保存规则（新建或更新）。
   */
  function saveRule() {
    const ruleId = $("#ruleId").val();
    const name = $("#ruleName").val().trim();
    const urlPattern = $("#ruleUrlPattern").val().trim();
    const matchType = $("#ruleMatchType").val();
    const action = $("#ruleAction").val();

    // 收集勾选的 HTTP 方法
    const methods = [];
    $('input[name="method"]:checked').each(function () {
      methods.push($(this).val());
    });

    // 表单验证
    if (!name || !urlPattern) {
      alert("请填写规则名称和URL匹配模式");
      return;
    }

    // 构建规则对象
    const rule = {
      id:
        ruleId ||
        Date.now().toString(36) + Math.random().toString(36).substr(2),
      name,
      urlPattern,
      matchType,
      methods,
      action,
      enabled: true,
    };

    // 根据动作类型添加对应的配置字段
    if (action === "mock") {
      rule.mockStatus = parseInt($("#mockStatus").val()) || 200;
      rule.mockBody = $("#mockBody").val();
      try {
        rule.mockHeaders = JSON.parse($("#mockHeaders").val() || "{}");
      } catch (e) {
        rule.mockHeaders = { "Content-Type": "application/json" };
      }
    } else if (action === "modify") {
      try {
        rule.modifyQuery = JSON.parse($("#modifyQuery").val() || "{}");
      } catch (e) {
        rule.modifyQuery = {};
      }
      rule.modifyBody = $("#modifyBody").val();
      try {
        rule.customHeaders = JSON.parse($("#customHeaders").val() || "{}");
      } catch (e) {
        rule.customHeaders = {};
      }
    } else if (action === "redirect") {
      rule.redirectUrl = $("#redirectUrl").val();
    }

    // 发送到 background
    if (ruleId) {
      const index = rules.findIndex(r => r.id === ruleId);
      if (index !== -1) {
        rule.enabled = rules[index].enabled;
        rules[index] = rule;
      }
      chrome.runtime.sendMessage({ type: "UPDATE_RULES", rules });
    } else {
      chrome.runtime.sendMessage({ type: "ADD_RULE", rule });
    }

    // 关闭弹窗
    $("#ruleModal").addClass("hidden");
  }

  /* ===== 导入/导出 ===== */

  /**
   * 处理规则文件导入。
   */
  function handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = event => {
      try {
        const importedRules = JSON.parse(event.target.result);
        if (Array.isArray(importedRules)) {
          chrome.runtime.sendMessage(
            { type: "IMPORT_RULES", rules: importedRules },
            response => {
              if (response && response.success) {
                rules = importedRules;
                renderRules();
                showToast("导入成功");
              }
            },
          );
        }
      } catch (err) {
        alert("导入失败：文件格式不正确");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  /**
   * 处理规则导出。
   */
  function handleExport() {
    const data = JSON.stringify(rules, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download =
      "interceptor-rules-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ===== JSON 视图（简洁版） ===== */

  /**
   * 语法高亮：将JSON字符串转换为带颜色的HTML
   */
  function syntaxHighlight(json) {
    if (typeof json !== "string") {
      json = JSON.stringify(json, null, 2);
    }
    json = escapeHtml(json);
    // 高亮不同类型的值
    return json.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      function (match) {
        let cls = "json-number";
        if (/^"/.test(match)) {
          if (/:$/.test(match)) {
            cls = "json-key";
          } else {
            cls = "json-string";
          }
        } else if (/true|false/.test(match)) {
          cls = "json-bool";
        } else if (/null/.test(match)) {
          cls = "json-null";
        }
        return '<span class="' + cls + '">' + match + "</span>";
      },
    );
  }

  /**
   * 渲染JSON树形视图（使用details/summary实现折叠）
   */
  function renderJsonTree(data, depth = 0) {
    if (data === null) return '<span class="json-null">null</span>';
    if (data === undefined) return '<span class="json-null">undefined</span>';
    if (typeof data !== "object") return syntaxHighlight(JSON.stringify(data));

    const isArray = Array.isArray(data);
    const entries = isArray ? data.map((v, i) => [i, v]) : Object.entries(data);
    const count = entries.length;

    if (count === 0) {
      return (
        '<span class="json-bracket">' + (isArray ? "[]" : "{}") + "</span>"
      );
    }

    const openBracket = isArray ? "[" : "{";
    const closeBracket = isArray ? "]" : "}";

    // 第一级始终展开，超过10个元素且深度>=1时折叠
    const shouldCollapse = depth >= 1 && count > 10;

    const items = entries
      .map(([key, value]) => {
        const isComplex = value !== null && typeof value === "object";
        const prefix = isArray
          ? '<span class="json-index">[' + key + "]</span>"
          : '<span class="json-key">"' + escapeHtml(String(key)) + '"</span>';

        if (isComplex) {
          const childCount = Array.isArray(value)
            ? value.length
            : Object.keys(value).length;
          if (childCount === 0) {
            const emptyBracket = Array.isArray(value) ? "[]" : "{}";
            return (
              '<div class="json-line">' +
              prefix +
              '<span class="json-colon">: </span><span class="json-bracket">' +
              emptyBracket +
              "</span></div>"
            );
          }
          return (
            '<div class="json-line">' +
            prefix +
            '<span class="json-colon">: </span>' +
            renderJsonTree(value, depth + 1) +
            "</div>"
          );
        } else {
          return (
            '<div class="json-line">' +
            prefix +
            '<span class="json-colon">: </span>' +
            syntaxHighlight(JSON.stringify(value)) +
            "</div>"
          );
        }
      })
      .join("");

    if (shouldCollapse) {
      return (
        '<details class="json-details' +
        (depth < 2 ? " open" : "") +
        '"><summary class="json-summary">' +
        openBracket +
        " ... " +
        count +
        " items " +
        closeBracket +
        '</summary><div class="json-children">' +
        items +
        "</div></details>"
      );
    }

    return (
      '<span class="json-bracket">' +
      openBracket +
      '</span><div class="json-children">' +
      items +
      '</div><span class="json-bracket">' +
      closeBracket +
      "</span>"
    );
  }

  /**
   * 渲染请求体内容，支持 parsed（层级树）和 raw（原始文本）两种视图。
   */
  function renderBodyContent($container, body) {
    if (!body) {
      $container.html('<div class="empty-state">无请求体</div>');
      return;
    }

    const toggleHtml =
      '<div class="body-toggle"><button class="body-toggle-btn ' +
      (bodyViewMode === "parsed" ? "active" : "") +
      '" data-view="parsed">解析</button><button class="body-toggle-btn ' +
      (bodyViewMode === "raw" ? "active" : "") +
      '" data-view="raw">原始</button></div>';

    if (bodyViewMode === "raw") {
      let rawContent = body;
      try {
        const parsed = JSON.parse(body);
        rawContent = JSON.stringify(parsed, null, 2);
      } catch (e) {}
      $container.html(
        toggleHtml +
          '<div class="body-raw">' +
          escapeHtml(rawContent) +
          "</div>",
      );
    } else {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {}

      if (parsed !== undefined) {
        $container.html(toggleHtml + renderJsonTree(parsed));
      } else {
        const entries = parseUrlEncoded(body);
        if (entries.length > 0) {
          $container.html(
            toggleHtml +
              entries
                .map(
                  ([key, value]) =>
                    '<div class="detail-row"><span class="detail-label">' +
                    escapeHtml(key) +
                    '</span><span class="detail-value">' +
                    escapeHtml(value) +
                    "</span></div>",
                )
                .join(""),
          );
        } else {
          $container.html(
            toggleHtml + '<div class="body-raw">' + escapeHtml(body) + "</div>",
          );
        }
      }
    }

    $container.find(".body-toggle-btn").on("click", function () {
      bodyViewMode = $(this).data("view");
      renderBodyContent($container, body);
    });
  }

  /**
   * 渲染响应体内容，支持 parsed（层级树）和 raw（原始文本）两种视图。
   */
  function renderResponseContent($container, body) {
    if (!body) {
      $container.html('<div class="empty-state">无响应体</div>');
      return;
    }

    const toggleHtml =
      '<div class="body-toggle"><button class="body-toggle-btn ' +
      (responseViewMode === "parsed" ? "active" : "") +
      '" data-view="parsed">解析</button><button class="body-toggle-btn ' +
      (responseViewMode === "raw" ? "active" : "") +
      '" data-view="raw">原始</button></div>';

    if (responseViewMode === "raw") {
      let rawContent = body;
      try {
        const parsed = JSON.parse(body);
        rawContent = JSON.stringify(parsed, null, 2);
      } catch (e) {}
      $container.html(
        toggleHtml +
          '<div class="body-raw">' +
          escapeHtml(rawContent) +
          "</div>",
      );
    } else {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {}

      if (parsed !== undefined) {
        $container.html(toggleHtml + renderJsonTree(parsed));
      } else {
        $container.html(
          toggleHtml + '<div class="body-raw">' + escapeHtml(body) + "</div>",
        );
      }
    }

    $container.find(".body-toggle-btn").on("click", function () {
      responseViewMode = $(this).data("view");
      renderResponseContent($container, body);
    });
  }

  /**
   * 解析 URL-encoded 字符串为 [key, value] 数组。
   */
  function parseUrlEncoded(body) {
    if (!body || !body.includes("=") || body.includes("{")) return [];
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
   */
  function showRequestDetail(request) {
    currentDetailRequest = request;
    currentDetailTab = "overview";

    $(".detail-tab").removeClass("active");
    $('[data-detail-tab="overview"]').addClass("active");

    renderDetailContent();
    $("#requestDetail").removeClass("hidden");
  }

  /**
   * 根据当前激活的详情 Tab 渲染对应内容。
   */
  function renderDetailContent() {
    if (!currentDetailRequest) return;

    const $container = $("#detailContent");
    const req = currentDetailRequest;

    switch (currentDetailTab) {
      case "overview":
        let overviewHtml = "";
        // 重定向标注重置在URL行下方，如果有重定向则显示
        const hasRedirect = req.finalUrl && req.finalUrl !== req.url;
        const isRedirectAction = req.action === "redirect";

        overviewHtml +=
          '<div class="detail-row"><span class="detail-label">方法</span><span class="detail-value">' +
          req.method +
          "</span></div>";

        if (hasRedirect) {
          // 有重定向时，显示原始URL和重定向目标
          overviewHtml +=
            '<div class="detail-row"><span class="detail-label">原始 URL</span><span class="detail-value" style="color: var(--text-secondary); text-decoration: line-through;">' +
            escapeHtml(req.url) +
            "</span></div>";
          overviewHtml +=
            '<div class="detail-row"><span class="detail-label">重定向到</span><span class="detail-value" style="color: var(--primary); font-weight: 500;">' +
            escapeHtml(req.finalUrl) +
            "</span></div>";
        } else {
          overviewHtml +=
            '<div class="detail-row"><span class="detail-label">URL</span><span class="detail-value">' +
            escapeHtml(req.url) +
            "</span></div>";
        }

        overviewHtml +=
          '<div class="detail-row"><span class="detail-label">状态</span><span class="detail-value">' +
          req.status +
          " " +
          req.statusText +
          "</span></div>";
        overviewHtml +=
          '<div class="detail-row"><span class="detail-label">耗时</span><span class="detail-value">' +
          req.duration +
          "ms</span></div>";
        overviewHtml +=
          '<div class="detail-row"><span class="detail-label">类型</span><span class="detail-value">' +
          req.type +
          "</span></div>";
        overviewHtml +=
          '<div class="detail-row"><span class="detail-label">拦截</span><span class="detail-value">' +
          (req.intercepted ? "是" : "否") +
          "</span></div>";

        // 显示拦截动作类型
        if (isRedirectAction) {
          overviewHtml +=
            '<div class="detail-row"><span class="detail-label">动作</span><span class="detail-value" style="color: var(--primary);">🔀 重定向 (通过代理)</span></div>';
        } else if (req.action === "mock") {
          overviewHtml +=
            '<div class="detail-row"><span class="detail-label">动作</span><span class="detail-value" style="color: var(--warning);">🎭 Mock 模拟</span></div>';
        } else if (req.action === "modify") {
          overviewHtml +=
            '<div class="detail-row"><span class="detail-label">动作</span><span class="detail-value" style="color: var(--info);">✏️ 修改请求</span></div>';
        }

        overviewHtml +=
          '<div class="detail-row"><span class="detail-label">时间</span><span class="detail-value">' +
          formatTime(req.timestamp) +
          "</span></div>";

        $container.html(overviewHtml);
        break;

      case "headers":
        const headers = req.requestHeaders || {};
        const headersHtml =
          Object.entries(headers)
            .map(
              ([key, value]) =>
                '<div class="detail-row"><span class="detail-label">' +
                escapeHtml(key) +
                '</span><span class="detail-value">' +
                escapeHtml(String(value)) +
                "</span></div>",
            )
            .join("") || '<div class="empty-state">无请求头</div>';
        $container.html(headersHtml);
        break;

      case "body":
        renderBodyContent($container, req.requestBody);
        break;

      case "response":
        renderResponseContent($container, req.responseBody);
        break;
    }
  }

  /* ===== 复制功能 ===== */

  /**
   * 将当前请求转换为 cURL 命令并复制到剪贴板。
   */
  function copyAsCurl() {
    if (!currentDetailRequest) return;

    const req = currentDetailRequest;
    let curl = "curl -X " + req.method + " '" + req.url + "'";

    const headers = req.requestHeaders || {};
    for (const [key, value] of Object.entries(headers)) {
      curl += " \\\n  -H '" + key + ": " + value + "'";
    }

    if (req.requestBody) {
      curl += " \\\n  -d '" + req.requestBody + "'";
    }

    navigator.clipboard.writeText(curl).then(() => {
      showToast("cURL 命令已复制");
    });
  }

  /**
   * 复制当前请求的响应体到剪贴板。
   */
  function copyResponse() {
    if (!currentDetailRequest) return;

    navigator.clipboard
      .writeText(currentDetailRequest.responseBody || "")
      .then(() => {
        showToast("响应体已复制");
      });
  }

  /* ===== 从请求创建规则 ===== */

  /**
   * 从当前查看的请求快速创建拦截规则。
   */
  function createRuleFromRequest(action) {
    if (!currentDetailRequest) return;
    const req = currentDetailRequest;

    // 关闭详情弹窗
    $("#requestDetail").addClass("hidden");

    // 打开规则编辑弹窗
    $("#ruleModalTitle").text("添加规则");
    $("#ruleId").val("");
    $("#ruleName").val("");

    // 自动填充请求 URL 作为匹配模式
    $("#ruleUrlPattern").val(req.url);
    $("#ruleMatchType").val("contains");

    // 自动勾选请求的 HTTP 方法
    $('input[name="method"]').each(function () {
      $(this).prop("checked", $(this).val() === req.method);
    });

    // 设置动作类型并触发切换
    $("#ruleAction").val(action).trigger("change");

    // 根据动作类型预填充数据
    if (action === "mock") {
      $("#mockStatus").val(req.status || 200);
      try {
        const parsed = JSON.parse(req.responseBody);
        $("#mockBody").val(JSON.stringify(parsed, null, 2));
      } catch (e) {
        $("#mockBody").val(req.responseBody || "");
      }
      try {
        $("#mockHeaders").val(
          JSON.stringify(req.responseHeaders || {}, null, 2),
        );
      } catch (e) {
        $("#mockHeaders").val("{}");
      }
    } else if (action === "modify") {
      try {
        const headers =
          typeof req.requestHeaders === "object" ? req.requestHeaders : {};
        $("#customHeaders").val(JSON.stringify(headers, null, 2));
      } catch (e) {
        $("#customHeaders").val("{}");
      }
      $("#modifyBody").val(req.requestBody || "");
      $("#modifyQuery").val("{}");
    }

    $("#ruleModal").removeClass("hidden");
  }

  /* ===== 工具函数 ===== */

  /**
   * 根据 HTTP 状态码返回对应的 CSS 类名。
   */
  function getStatusClass(status) {
    if (status >= 200 && status < 300) return "status-2xx";
    if (status >= 300 && status < 400) return "status-3xx";
    if (status >= 400 && status < 500) return "status-4xx";
    if (status >= 500) return "status-5xx";
    return "";
  }

  /**
   * 截断过长的 URL，只显示域名和路径的前 50 个字符。
   */
  function truncateUrl(url) {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname + urlObj.search;
      if (path.length > 50) {
        return urlObj.hostname + path.substring(0, 50) + "...";
      }
      return urlObj.hostname + path;
    } catch (e) {
      return url.length > 60 ? url.substring(0, 60) + "..." : url;
    }
  }

  /**
   * 格式化 ISO 时间戳为中文时间格式（HH:MM:SS）。
   */
  function formatTime(timestamp) {
    try {
      const date = new Date(timestamp);
      return date.toLocaleTimeString("zh-CN", { hour12: false });
    } catch (e) {
      return timestamp;
    }
  }

  /**
   * HTML 实体转义，防止 XSS 攻击。
   */
  function escapeHtml(str) {
    if (typeof str !== "string") str = String(str);
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /**
   * 显示一个临时的 Toast 提示消息。
   */
  function showToast(message) {
    const $toast = $("<div>").text(message).css({
      position: "fixed",
      bottom: "20px",
      right: "20px",
      background: "#18a058",
      color: "white",
      padding: "10px 18px",
      borderRadius: "8px",
      fontSize: "13px",
      fontWeight: "500",
      zIndex: 9999,
      boxShadow: "0 4px 12px rgba(24,160,88,0.3)",
      animation: "toastIn 0.2s ease",
    });

    $("body").append($toast);

    setTimeout(() => {
      $toast.css({ opacity: "0", transition: "opacity 0.2s ease" });
      setTimeout(() => $toast.remove(), 200);
    }, 2000);
  }
});
