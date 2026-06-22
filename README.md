# Vakao - 网页请求拦截与调试工具

一个零侵入的 Chrome 浏览器扩展，用于拦截、修改和 Mock 网络请求。基于 Manifest V3 构建，通过 Monkey Patch 技术透明拦截页面的 `fetch` 和 `XMLHttpRequest` 请求。

## 功能特性

- **请求捕获**：实时捕获页面所有网络请求（fetch / XHR），展示方法、URL、状态码、耗时等信息
- **请求过滤**：按 URL 关键字、HTTP 方法、状态码范围过滤请求列表
- **Mock 响应**：拦截匹配的请求，返回自定义的响应数据（状态码、响应头、响应体）
- **修改请求**：在请求发送前修改查询参数、请求头、请求体
- **请求重定向**：将匹配的请求重定向到指定 URL
- **规则管理**：支持创建、编辑、删除、启用/禁用拦截规则
- **导入导出**：规则以 JSON 格式导入/导出，方便团队共享
- **一键复制**：将请求转换为 cURL 命令或复制响应体
- **从请求创建规则**：基于已捕获的请求快速创建 Mock/Modify 规则
- **规则持久化**：规则保存在 `chrome.storage.local`，浏览器重启后不丢失

## 项目结构

```
request-interceptor-debugger/
├── manifest.json                    # Chrome 扩展配置文件（Manifest V3）
├── background/
│   └── service-worker.js            # 后台服务 Worker（规则管理、请求存储、消息广播）
├── content/
│   ├── content-script.js            # 内容脚本（background 与页面内脚本的通信桥梁）
│   └── interceptor.js              # 请求拦截器（注入页面主世界，Monkey Patch fetch/XHR）
├── sidepanel/
│   ├── sidepanel.html               # 侧边栏面板 HTML 结构
│   ├── sidepanel.css                # 侧边栏面板样式（CSS 自定义属性主题化）
│   └── sidepanel.js                 # 侧边栏面板交互逻辑（UI 渲染、事件处理）
├── icons/                           # 扩展图标（16/32/48/128px）
└── .gitignore
```

## 架构说明

### 通信架构

扩展采用 Chrome Extension 的消息通信机制，各组件间通过消息传递数据：

```
┌──────────────────┐    chrome.runtime    ┌──────────────────────┐
│  Side Panel UI   │ ◄══════════════════► │  Background Worker   │
│  (sidepanel.js)  │    .sendMessage()    │  (service-worker.js) │
└──────────────────┘                      └──────────┬───────────┘
                                                     │
                                          chrome.tabs.sendMessage
                                                     │
                                          ┌──────────▼───────────┐
                                          │  Content Script       │
                                          │  (content-script.js)  │
                                          └──────────┬───────────┘
                                                     │
                                           window.postMessage
                                                     │
                                          ┌──────────▼───────────┐
                                          │  Interceptor          │
                                          │  (interceptor.js)     │
                                          └──────────────────────┘
```

### 请求拦截流程

1. `interceptor.js` 注入页面主世界，替换 `window.fetch` 和 `XMLHttpRequest` 方法
2. 页面发起请求时，拦截器匹配规则并执行对应动作（Mock/Modify/Redirect）
3. 请求数据通过 `window.postMessage` 发送给 `content-script.js`
4. `content-script.js` 通过 `chrome.runtime.sendMessage` 转发给 `service-worker.js`
5. `service-worker.js` 存储请求数据并广播给 Side Panel 展示

### 规则匹配

规则支持两种匹配模式：
- **包含匹配（contains）**：URL 包含指定字符串即匹配
- **正则匹配（regex）**：使用正则表达式匹配 URL

每条规则可限制生效的 HTTP 方法（GET/POST/PUT/DELETE/PATCH），多选生效。

### 拦截动作

| 动作 | 说明 |
|------|------|
| **Mock** | 拦截请求，返回自定义响应，不发送真实请求 |
| **Modify** | 修改请求头、请求体、查询参数后发送真实请求 |
| **Redirect** | 将请求 URL 替换为指定地址后发送 |

## 安装使用

### 开发模式安装

1. 打开 Chrome 浏览器，访问 `chrome://extensions/`
2. 开启右上角的「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目根目录

### 使用方法

1. 点击浏览器工具栏中的 Vakao 图标，打开侧边栏面板
2. 在「请求列表」标签页查看所有捕获的网络请求
3. 点击任意请求查看详情（概览/请求头/请求体/响应）
4. 在「拦截规则」标签页创建和管理拦截规则
5. 使用「Mock 此请求」或「修改此请求」按钮快速从请求创建规则

## 技术栈

- **Chrome Extension Manifest V3**
- **原生 JavaScript**（无框架依赖）
- **CSS Custom Properties**（主题化设计系统）
- **Chrome APIs**：`storage`、`sidePanel`、`tabs`、`runtime`、`action`、`scripting`

## 浏览器兼容性

- Google Chrome 114+（Side Panel API 要求）
- Chromium 内核浏览器（Edge、Brave 等）

## 开发

本项目为纯静态文件，无需构建步骤。修改代码后在 `chrome://extensions/` 页面点击刷新按钮即可生效。

## License

MIT
