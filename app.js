(() => {
  "use strict";

  // new-api 站点根路径：/api/* 与 /v1/* 同源挂在根路径下，
  // 可通过 window.EQUAL_TOKEN_C_API_ORIGIN 单独覆盖。
  const apiOrigin = (
    window.EQUAL_TOKEN_C_API_ORIGIN ||
    (window.EQUAL_TOKEN_C_BASE_URL || "https://equaltoken.top").replace(/\/v1\/?$/, "")
  ).replace(/\/+$/, "");

  const CONFIG = {
    baseUrl: window.EQUAL_TOKEN_C_BASE_URL || "https://equaltoken.top",
    apiOrigin,
    // BFF 地址（推荐）：设置后查询走 BFF，服务端完成分组倍率换算，
    // 原始 quota 不会进入浏览器。未设置时回退为直连 new-api 模式。
    bffOrigin: (window.EQUAL_TOKEN_C_BFF_ORIGIN || "").replace(/\/+$/, ""),
    // 功能开关：本版本充值与申请 Key 暂不放开，部署时通过配置开启
    features: {
      recharge: Boolean(window.EQUAL_TOKEN_C_ENABLE_RECHARGE),
      apply: Boolean(window.EQUAL_TOKEN_C_ENABLE_APPLY)
    },
    defaultModel: window.EQUAL_TOKEN_C_MODEL || "gpt-5.6-sol",
    supportWeChat: window.EQUAL_TOKEN_C_SUPPORT_WECHAT || "equaltoken-support",
    // new-api 额度换算：QuotaPerUnit（默认 500000）= 1 美元
    quotaPerUnit: Number(window.EQUAL_TOKEN_C_QUOTA_PER_UNIT) || 500000,
    // 展示倍率：仅直连模式（未配置 BFF）时生效，所有展示金额统一除以该倍率。
    // BFF 模式下换算在服务端完成，前端不再做二次换算。
    displayRatio: (() => {
      const value = Number(window.EQUAL_TOKEN_C_DISPLAY_RATIO);
      return Number.isFinite(value) && value > 0 ? value : 1;
    })(),
    storageKey: "et_c_session_key",
    api: {
      // BFF 模式接口（推荐）
      bffSummary: "/api/c/account/summary",
      bffLogs: "/api/c/usage/logs",
      // 直连模式：sk- Key 可直调的只读接口（TokenAuthReadOnly，new-api 原生支持 CORS）
      tokenUsage: "/api/usage/token/",
      tokenLogs: "/api/log/token",
      models: "/v1/models",
      // 以下为充值/申请待接入的自建接口，功能放开后再启用
      keyApplications: "/api/c/key-applications",
      createOrder: "/api/c/recharge/orders",
      listOrders: "/api/c/recharge/orders",
      submitProof: (orderId) => `/api/c/recharge/orders/${encodeURIComponent(orderId)}/proof`
    }
  };

  const state = {
    view: "query",
    apiKey: "",
    tokenInfo: null,
    account: null,
    usage: [],
    usageError: "",
    orders: [],
    amount: 100,
    activeOrder: null,
    range: "today",
    model: "all",
    status: "all",
    search: "",
    guide: "codex",
    visibleKey: false
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const emptySummary = {
    balance: null,
    totalQuota: null,
    totalSpent: null,
    monthSpent: null,
    todaySpent: null,
    validUntil: "--",
    status: "未验证"
  };

  const mockOrders = [
    {
      id: "ET202610080001",
      amount: 100,
      createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      status: "已到账"
    },
    {
      id: "ET202610070014",
      amount: 50,
      createdAt: new Date(Date.now() - 28 * 60 * 60 * 1000).toISOString(),
      status: "已到账"
    },
    {
      id: "ET202610060009",
      amount: 200,
      createdAt: new Date(Date.now() - 52 * 60 * 60 * 1000).toISOString(),
      status: "已拒绝"
    }
  ];

  const GUIDE_ORDER = ["codex", "workbuddy", "claudecode", "openclaw", "hermes"];

  const GUIDE_META = {
    codex: {
      label: "Codex",
      title: "Codex 配置",
      summary: "通过 config.toml 指向 Equal Token 的 OpenAI 兼容接口，适合 Codex CLI 和桌面端。"
    },
    workbuddy: {
      label: "Workbuddy",
      title: "Workbuddy 配置",
      summary: "在模型服务中选择 OpenAI Compatible 或自定义服务，填入 Base URL、Key 和模型名。"
    },
    claudecode: {
      label: "Claude Code",
      title: "Claude Code 配置",
      summary: "Claude Code 原生使用 Anthropic Messages API；如果 Equal Token 只提供 OpenAI 兼容接口，需要用 router 转换协议。"
    },
    openclaw: {
      label: "OpenClaw",
      title: "OpenClaw 配置",
      summary: "在 OpenClaw 中新增 OpenAI Compatible Provider，然后把 Equal Token 设为默认模型服务。"
    },
    hermes: {
      label: "Hermes",
      title: "Hermes 配置",
      summary: "Hermes 使用本地 config.yaml。将 model.provider 设置为 custom，再填入 Base URL、Key 和默认模型。"
    }
  };

  let toastTimer = 0;
  let searchTimer = 0;

  // new-api 额度 → 展示金额：先按 QuotaPerUnit 换算成美元，再除以展示倍率。
  // 全站金额统一走此函数，保证「总额度 - 累计已用 = 余额」口径一致。
  function quotaToUsd(quota) {
    return Number(quota || 0) / CONFIG.quotaPerUnit / CONFIG.displayRatio;
  }

  // new-api 日志字段 → C 端展示字段。
  // type: 2 = 消费（成功），5 = 错误（失败），其余类型不展示。
  function mapLogRecord(log) {
    const input = Number(log.prompt_tokens || 0);
    const output = Number(log.completion_tokens || 0);
    const createdAt = Number(log.created_at || 0) * 1000;
    return {
      id: log.request_id || `log-${log.id}`,
      createdAt: Number.isFinite(createdAt) && createdAt > 0 ? new Date(createdAt).toISOString() : "",
      model: log.model_name || "--",
      input,
      output,
      total: input + output,
      cost: quotaToUsd(log.quota),
      status: log.type === 5 ? "failed" : "success"
    };
  }

  function sumSpentSince(records, sinceMs) {
    return records.reduce((sum, item) => {
      if (item.status !== "success") return sum;
      const ts = new Date(item.createdAt).getTime();
      if (!Number.isFinite(ts) || ts < sinceMs) return sum;
      return sum + Number(item.cost || 0);
    }, 0);
  }

  // 由 /api/usage/token/ 的返回 + 调用明细聚合出账户摘要。
  // 今日/本月消费基于最近 1000 条日志（new-api MaxRecentItems 上限）估算。
  function buildAccount(tokenInfo, usage) {
    const unlimited = Boolean(tokenInfo.unlimited_quota);
    const expiresAt = Number(tokenInfo.expires_at || 0);
    const nowSec = Math.floor(Date.now() / 1000);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    return {
      unlimited,
      balance: unlimited ? null : quotaToUsd(tokenInfo.total_available),
      totalQuota: unlimited ? null : quotaToUsd(tokenInfo.total_granted),
      totalSpent: quotaToUsd(tokenInfo.total_used),
      monthSpent: sumSpentSince(usage, monthStart),
      todaySpent: sumSpentSince(usage, todayStart),
      validUntil: expiresAt > 0 ? formatExpiry(expiresAt * 1000) : "永久有效",
      status: expiresAt > 0 && expiresAt < nowSec ? "已过期" : "正常"
    };
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatMoney(value) {
    return `$${Number(value || 0).toFixed(2)}`;
  }

  function displayMoney(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
    return formatMoney(value);
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("zh-CN").format(Number(value || 0));
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "--";
    return date.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }

  function formatExpiry(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "--";
    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }

  function maskKey(value) {
    if (!value) return "未配置 API Key";
    if (!isValidApiKey(value)) return "Key 格式异常";
    if (value.length <= 12) return "****";
    return `${value.slice(0, 7)}****${value.slice(-4)}`;
  }

  function isValidApiKey(value) {
    return /^sk-[A-Za-z0-9._-]{8,}$/.test(String(value || "").trim());
  }

  function statusLabel(status) {
    if (status === "success") return "成功";
    if (status === "failed") return "失败";
    if (status === "pending") return "待审核";
    if (status === "paid") return "已到账";
    if (status === "rejected") return "已拒绝";
    if (status === "unpaid") return "待支付";
    return status || "--";
  }

  function statusClass(status) {
    if (status === "success" || status === "paid") return "status-pill--success";
    if (status === "failed" || status === "rejected") return "status-pill--failed";
    if (status === "pending" || status === "unpaid") return "status-pill--pending";
    return "status-pill--info";
  }

  function authHeaders() {
    return state.apiKey ? { Authorization: `Bearer ${state.apiKey}` } : {};
  }

  async function apiRequest(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...authHeaders(),
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }

  function showToast(message) {
    const toast = $("#toast");
    if (!toast) return;
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("is-open");
    toastTimer = window.setTimeout(() => toast.classList.remove("is-open"), 2800);
  }

  async function copyText(value, message = "已复制") {
    const text = String(value || "").trim();
    if (!text) {
      showToast("没有可复制的内容");
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      showToast(message);
    } catch {
      showToast(text);
    }
  }

  // 功能开关控制的可见视图；充值/申请本版本默认隐藏
  function allowedViews() {
    return ["query", "recharge", "config", "apply"].filter((view) => {
      if (view === "recharge") return CONFIG.features.recharge;
      if (view === "apply") return CONFIG.features.apply;
      return true;
    });
  }

  function setView(view) {
    const next = allowedViews().includes(view) ? view : "query";
    state.view = next;
    window.location.hash = next;

    $$(".nav-tab").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.view === next);
    });

    $$("[data-view-panel]").forEach((panel) => {
      panel.classList.toggle("is-active", panel.dataset.viewPanel === next);
    });

    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function renderSession() {
    const hasKey = Boolean(state.apiKey);
    $("#sessionKey").textContent = hasKey ? maskKey(state.apiKey) : "未配置 API Key";
    $("#changeKeyBtn").setAttribute("aria-label", hasKey ? "输入 Key，当前已配置" : "输入 API Key");
    renderSummary();
    renderUsage();
    renderRecharge();
    renderCredentials();
    renderGuide();
  }

  function renderSummary() {
    const account = state.apiKey && state.account ? state.account : emptySummary;
    const hasBalance = account.balance !== null && account.balance !== undefined;
    const remainingRatio = hasBalance && account.totalQuota
      ? Math.max(0, Math.min(1, account.balance / account.totalQuota))
      : 0;

    if (account.unlimited) {
      $("#balanceValue").textContent = "不限量";
      $("#balanceCaption").textContent = `该 Key 未设置额度上限 · 已用 ${displayMoney(account.totalSpent)}`;
      $("#balanceMeter").style.transform = "scaleX(1)";
    } else {
      $("#balanceValue").textContent = displayMoney(account.balance);
      $("#balanceCaption").textContent = hasBalance
        ? `总额度 ${displayMoney(account.totalQuota)} · 剩余 ${Math.round(remainingRatio * 100)}%`
        : "总额度 -- · 剩余 --";
      $("#balanceMeter").style.transform = `scaleX(${remainingRatio})`;
    }
    $("#balanceStatus").textContent = account.status || (state.apiKey ? "正常" : "未验证");
    $("#balanceStatus").className = `status-pill ${state.apiKey ? "status-pill--ok" : "status-pill--neutral"}`;
    $("#totalSpent").textContent = displayMoney(account.totalSpent);
    $("#monthSpent").textContent = displayMoney(account.monthSpent);
    $("#todaySpent").textContent = displayMoney(account.todaySpent);
    $("#validUntil").textContent = account.validUntil || "--";
  }

  function filteredUsage() {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const query = state.search.trim().toLowerCase();

    return state.usage.filter((item) => {
      const timestamp = new Date(item.createdAt).getTime();
      if (state.range === "today" && timestamp < todayStart) return false;
      if (state.range === "month" && timestamp < monthStart) return false;
      if (state.model !== "all" && item.model !== state.model) return false;
      if (state.status !== "all" && item.status !== state.status) return false;
      if (query && !`${item.id} ${item.model}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }

  function renderUsage() {
    const records = filteredUsage();
    const rows = $("#usageRows");
    const empty = $("#usageEmpty");
    const modelFilter = $("#modelFilter");
    const models = Array.from(new Set(state.usage.map((item) => item.model))).sort();

    if (!state.apiKey) {
      modelFilter.innerHTML = '<option value="all">全部模型</option>';
      rows.innerHTML = "";
      empty.hidden = false;
      empty.innerHTML =
        '<strong>暂无调用明细</strong><span>输入 API Key 后，这里会显示余额和调用记录。</span>' +
        (CONFIG.features.apply
          ? '<button class="text-button" type="button" data-view="apply">还没有 Key？申请 Key</button>'
          : "");
      $("#usageMeta").textContent = "输入 API Key 后显示调用明细";
      return;
    }

    modelFilter.innerHTML = [
      '<option value="all">全部模型</option>',
      ...models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)
    ].join("");
    modelFilter.value = state.model;

    rows.innerHTML = records
      .map(
        (item) => `
          <tr>
            <td>${escapeHtml(formatDateTime(item.createdAt))}</td>
            <td class="mono">${escapeHtml(item.model)}</td>
            <td class="mono">${escapeHtml(item.id)}</td>
            <td class="num">${formatNumber(item.input)}</td>
            <td class="num">${formatNumber(item.output)}</td>
            <td class="num">${formatNumber(item.total)}</td>
            <td class="num">${formatMoney(item.cost)}</td>
            <td><span class="status-pill ${statusClass(item.status)}">${statusLabel(item.status)}</span></td>
          </tr>
        `
      )
      .join("");

    empty.hidden = records.length > 0;
    empty.innerHTML = "<strong>没有匹配的调用记录</strong><span>调整筛选条件或切换时间范围后再试。</span>";
    $("#usageMeta").textContent = state.usageError
      ? `加载失败：${state.usageError}（new-api 接口不可达）`
      : `${records.length} 条记录 · 数据来自当前 Key 的调用日志（最近 1000 条）`;
  }

  function renderRecharge() {
    const account = state.apiKey && state.account ? state.account : emptySummary;
    $("#rechargeBalance").textContent = state.apiKey ? `余额 ${displayMoney(account.balance)}` : "余额 --";
    renderOrderRows();

    const detail = $("#orderDetail");
    if (!state.activeOrder) {
      detail.hidden = true;
      return;
    }

    detail.hidden = false;
    $("#orderNumber").textContent = state.activeOrder.id;
    $("#orderAmount").textContent = `¥${Number(state.activeOrder.amount).toFixed(2)}`;
    $("#orderStatus").textContent = statusLabel(state.activeOrder.status);
  }

  function renderOrderRows() {
    const rows = $("#orderRows");
    if (!state.apiKey) {
      rows.innerHTML = '<tr><td class="empty-cell" colspan="3">输入 API Key 后显示充值记录</td></tr>';
      return;
    }
    if (!state.orders.length) {
      rows.innerHTML = '<tr><td class="empty-cell" colspan="3">暂无充值记录</td></tr>';
      return;
    }
    rows.innerHTML = state.orders
      .map(
        (order) => `
          <tr>
            <td>
              <span class="order-id">${escapeHtml(order.id)}</span>
              <span class="order-time">${escapeHtml(formatDateTime(order.createdAt))}</span>
            </td>
            <td class="num">¥${Number(order.amount).toFixed(2)}</td>
            <td><span class="status-pill ${statusClass(order.status)}">${statusLabel(order.status)}</span></td>
          </tr>
        `
      )
      .join("");
  }

  function renderCredentials() {
    $("#baseUrlText").textContent = CONFIG.baseUrl;
    $("#configKeyText").textContent = state.apiKey
      ? state.visibleKey
        ? state.apiKey
        : maskKey(state.apiKey)
      : "未设置";
    $("#toggleKeyVisibility").textContent = state.apiKey && state.visibleKey ? "隐藏" : "显示";
    $("#toggleKeyVisibility").disabled = !state.apiKey;
  }

  function guideCode(guide) {
    const baseUrl = CONFIG.baseUrl;
    const model = CONFIG.defaultModel;
    const key = state.apiKey || "";

    if (guide === "codex") {
      return `mkdir -p ~/.codex
cat > ~/.codex/config.toml <<'EOF'
model = "${model}"
model_provider = "equaltoken"

[model_providers.equaltoken]
name = "Equal Token"
base_url = "${baseUrl}"
env_key = "EQUAL_TOKEN_API_KEY"
wire_api = "responses"
EOF

export EQUAL_TOKEN_API_KEY="${key}"
codex --model ${model}`;
    }

    if (guide === "workbuddy") {
      return `服务类型：OpenAI Compatible / 自定义服务
Base URL：${baseUrl}
API Key：${key}
模型名称：${model}`;
    }

    if (guide === "claudecode") {
      return `# 方案 A：Equal Token 提供 Anthropic 兼容接口
export ANTHROPIC_BASE_URL="${baseUrl.replace(/\/v1$/, "")}"
export ANTHROPIC_AUTH_TOKEN="${key}"
export ANTHROPIC_MODEL="claude-sonnet-4-5"
claude

# 方案 B：Equal Token 只提供 OpenAI 兼容接口
npm install -g @musistudio/claude-code-router
# 编辑 ~/.claude-code-router/config.json
# api_base_url: ${baseUrl}/chat/completions
# api_key: ${key}
# models: ["claude-sonnet-4-5"]
ccr code`;
    }

    if (guide === "openclaw") {
      return `{
  "providers": {
    "equaltoken": {
      "type": "openai",
      "baseUrl": "${baseUrl}",
      "apiKey": "${key}",
      "model": "${model}"
    }
  }
}`;
    }

    return `model:
  provider: custom
  default: ${model}
  base_url: ${baseUrl}
  api_key: ${key}

# 或使用命令行
hermes config set model.provider custom
hermes config set model.base_url ${baseUrl}
hermes config set model.api_key ${key}
hermes config set model.default ${model}`;
  }

  function guideSteps(guide) {
    if (guide === "codex") {
      return [
        "打开终端，创建或编辑 ~/.codex/config.toml。",
        "把模型提供方设置为 equaltoken，并填入 Base URL 和 API Key 环境变量。",
        "重新启动 Codex，确认模型名与 /v1/models 返回一致。"
      ];
    }

    if (guide === "workbuddy") {
      return [
        "打开 Workbuddy 的设置或模型服务页面。",
        "新增 OpenAI Compatible / 自定义服务。",
        "填入 Base URL、API Key 和模型名称，保存后设为默认模型。"
      ];
    }

    if (guide === "claudecode") {
      return [
        "先确认 Equal Token 是否提供 Anthropic 兼容入口。",
        "如果是 Anthropic 兼容入口，设置 ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 和模型名。",
        "如果只有 OpenAI 兼容接口，使用 claude-code-router 做协议转换后再启动 Claude Code。"
      ];
    }

    if (guide === "openclaw") {
      return [
        "打开 OpenClaw 的 Provider 或模型设置。",
        "新增 OpenAI Compatible Provider，写入 Base URL、API Key 和模型。",
        "保存后把 Equal Token 设为默认 Provider，并发起一次测试请求。"
      ];
    }

    return [
      "运行 hermes config path，确认配置文件位置。",
      "编辑 config.yaml，将 model.provider 设为 custom。",
      "写入 base_url、api_key 和 default 模型，重启 Hermes 后测试。"
    ];
  }

  function guideNote(guide) {
    if (guide === "codex") {
      return "如果当前 Codex 版本要求 chat 协议，把 wire_api 改成 chat；模型名以实际 /v1/models 返回为准。";
    }

    if (guide === "workbuddy") {
      return "不同 Workbuddy 版本的字段名可能不同，核心是选择 OpenAI Compatible 并填写 Base URL、Key 和模型名。";
    }

    if (guide === "claudecode") {
      return "Claude Code 原生使用 Anthropic Messages API。只有 OpenAI 兼容接口时，不能直接把 OpenAI Key 当成 Anthropic Key 使用。";
    }

    if (guide === "openclaw") {
      return "优先使用 OpenClaw 设置界面中的 OpenAI Compatible 选项；JSON 字段名以当前版本为准。";
    }

    return "可以用 hermes config path 查看配置路径，修改 config.yaml 后重新启动 Hermes。";
  }

  function renderGuideTabs() {
    const tabs = $("#guideTabs");
    tabs.innerHTML = GUIDE_ORDER.map((guide) => {
      const meta = GUIDE_META[guide];
      return `<button type="button" class="${state.guide === guide ? "is-active" : ""}" data-guide="${guide}">${meta.label}</button>`;
    }).join("");
  }

  function renderGuide() {
    renderGuideTabs();

    const meta = GUIDE_META[state.guide];
    const code = guideCode(state.guide);
    const steps = guideSteps(state.guide);
    const note = guideNote(state.guide);

    $("#guidePanel").innerHTML = `
      <h2>${escapeHtml(meta.title)}</h2>
      <p>${escapeHtml(meta.summary)}</p>
      <ol class="steps">
        ${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}
      </ol>
      <div class="code-block">
        <div class="code-block__head">
          <span>${escapeHtml(meta.label)} · 配置示例</span>
          <button class="button button--small" type="button" data-copy-code>复制</button>
        </div>
        <pre>${escapeHtml(code)}</pre>
      </div>
      <p class="guide-note">${escapeHtml(note)}</p>
    `;
  }

  // GET /api/usage/token/：sk- Key 直调，返回 Key 维度的额度信息（直连模式）
  async function fetchTokenInfo() {
    const data = await apiRequest(`${CONFIG.apiOrigin}${CONFIG.api.tokenUsage}`, { method: "GET" });
    if (!data?.data) throw new Error("响应格式异常");
    return data.data;
  }

  // GET /api/log/token：sk- Key 直调，返回该 Key 最近 1000 条日志（直连模式）
  async function fetchUsage() {
    try {
      const data = await apiRequest(`${CONFIG.apiOrigin}${CONFIG.api.tokenLogs}`, { method: "GET" });
      const logs = Array.isArray(data?.data) ? data.data : [];
      state.usageError = "";
      return logs
        .filter((log) => log.type === 2 || log.type === 5)
        .map(mapLogRecord);
    } catch (error) {
      state.usageError = String(error.message || "网络错误");
      return [];
    }
  }

  // ---- BFF 模式：换算在服务端完成，前端只做字段映射 ----

  async function fetchAccountBff() {
    const data = await apiRequest(`${CONFIG.bffOrigin}${CONFIG.api.bffSummary}`, { method: "GET" });
    if (!data?.data) throw new Error("响应格式异常");
    return data.data;
  }

  async function fetchUsageBff() {
    try {
      const data = await apiRequest(`${CONFIG.bffOrigin}${CONFIG.api.bffLogs}`, { method: "GET" });
      const records = Array.isArray(data?.data?.records) ? data.data.records : [];
      state.usageError = "";
      return records.map((record) => ({
        id: record.id,
        createdAt: record.created_at || "",
        model: record.model || "--",
        input: Number(record.input || 0),
        output: Number(record.output || 0),
        total: Number(record.total ?? Number(record.input || 0) + Number(record.output || 0)),
        cost: Number(record.cost || 0),
        status: record.status === "failed" ? "failed" : "success"
      }));
    } catch (error) {
      state.usageError = String(error.message || "网络错误");
      return [];
    }
  }

  function normalizeBffAccount(data) {
    const expiresAt = Number(data.expires_at || 0);
    return {
      unlimited: Boolean(data.unlimited),
      balance: data.unlimited ? null : Number(data.balance || 0),
      totalQuota: data.unlimited ? null : Number(data.total_quota || 0),
      totalSpent: Number(data.total_spent || 0),
      monthSpent: Number(data.month_spent || 0),
      todaySpent: Number(data.today_spent || 0),
      validUntil: expiresAt > 0 ? formatExpiry(expiresAt * 1000) : "永久有效",
      status: data.status || "正常"
    };
  }

  // 统一的数据加载入口：优先 BFF，未配置 BFF 时回退直连 new-api
  async function loadAccountData() {
    if (CONFIG.bffOrigin) {
      const account = await fetchAccountBff();
      const usage = await fetchUsageBff();
      return { account: normalizeBffAccount(account), usage };
    }
    const tokenInfo = await fetchTokenInfo();
    const usage = await fetchUsage();
    return { account: buildAccount(tokenInfo, usage), usage };
  }

  async function fetchOrders() {
    try {
      const data = await apiRequest(CONFIG.api.listOrders, { method: "GET" });
      if (Array.isArray(data?.orders)) return data.orders;
      if (Array.isArray(data)) return data;
      return [...mockOrders];
    } catch {
      return [...mockOrders];
    }
  }

  async function verifyKey(key) {
    const trimmed = key.trim();
    if (!trimmed) {
      showToast("请输入 API Key");
      return false;
    }
    if (!isValidApiKey(trimmed)) {
      try {
        sessionStorage.removeItem(CONFIG.storageKey);
      } catch {
        // ignore
      }
      showToast("API Key 格式不正确：必须以 sk- 开头，只包含字母、数字、-、_、.");
      return false;
    }

    const submit = $("#keySubmit");
    submit.disabled = true;
    submit.textContent = "验证中";

    state.apiKey = trimmed;
    try {
      const { account, usage } = await loadAccountData();
      state.account = account;
      state.usage = usage;
    } catch (error) {
      state.apiKey = "";
      state.account = null;
      state.usage = [];
      try {
        sessionStorage.removeItem(CONFIG.storageKey);
      } catch {
        // ignore
      }
      submit.disabled = false;
      submit.textContent = "保存并刷新";
      const message = String(error.message || "");
      showToast(message.includes("401") || message.includes("403")
        ? "API Key 无效、已禁用或用户已被封禁"
        : `验证失败：${message}`);
      return false;
    }
    state.orders = await fetchOrders();
    state.activeOrder = null;
    state.visibleKey = false;

    try {
      sessionStorage.setItem(CONFIG.storageKey, trimmed);
    } catch {
      // sessionStorage may be blocked in some embedded browsers.
    }

    submit.disabled = false;
    submit.textContent = "保存并刷新";
    renderSession();
    loadTestModels();
    const dialog = $("#keyDialog");
    if (dialog.open) dialog.close();
    showToast("Key 验证通过，已加载余额与调用明细。");
    return true;
  }

  function clearKey() {
    state.apiKey = "";
    state.tokenInfo = null;
    state.account = null;
    state.usage = [];
    state.usageError = "";
    state.orders = [];
    state.activeOrder = null;
    state.visibleKey = false;
    try {
      sessionStorage.removeItem(CONFIG.storageKey);
    } catch {
      // ignore
    }
    $("#apiKeyInput").value = "";
    $("#testModel").innerHTML = '<option value="">加载模型列表...</option>';
    $("#testResult").textContent = "尚未测试。未选模型时仅验证接口连通；选择模型后会发送一次极小的真实请求。";
    $("#testResult").className = "";
    renderSession();
    setView("query");
    showToast("已清除当前 Key。");
  }

  function openKeyDialog() {
    const dialog = $("#keyDialog");
    $("#apiKeyInput").value = state.apiKey || "";
    if (!dialog.open) dialog.showModal();
    window.setTimeout(() => $("#apiKeyInput").focus(), 0);
  }

  function closeKeyDialog() {
    const dialog = $("#keyDialog");
    if (dialog.open) dialog.close();
  }

  async function submitKeyApplication(event) {
    event.preventDefault();
    const name = $("#applyName").value.trim();
    const contact = $("#applyContact").value.trim();

    if (!name) {
      showToast("请填写称呼");
      $("#applyName").focus();
      return;
    }
    if (!contact) {
      showToast("请填写联系方式");
      $("#applyContact").focus();
      return;
    }

    const payload = {
      name,
      contact,
      scene: $("#applyScene").value,
      usage: $("#applyUsage").value,
      note: $("#applyNote").value.trim(),
      source: "c-end",
      page: window.location.href,
      created_at: new Date().toISOString()
    };

    const submit = $("#applySubmit");
    submit.disabled = true;
    submit.textContent = "提交中";

    try {
      await apiRequest(CONFIG.api.keyApplications, {
        method: "POST",
        body: JSON.stringify(payload)
      });
    } catch {
      // The standalone prototype shows the success state when the backend is not present.
    }

    submit.disabled = false;
    submit.textContent = "提交申请";
    $("#keyApplicationForm").hidden = true;
    $("#applySuccess").hidden = false;
    showToast("申请已提交，运营会尽快联系你。");
  }

  function resetApplyForm() {
    $("#keyApplicationForm").reset();
    $("#keyApplicationForm").hidden = false;
    $("#applySuccess").hidden = true;
  }

  function selectAmount(amount) {
    state.amount = Number(amount);
    $("#customAmount").value = String(state.amount);
    $$("#amountGrid button").forEach((button) => {
      button.classList.toggle("is-active", Number(button.dataset.amount) === state.amount);
    });
  }

  async function createOrder() {
    if (!state.apiKey) {
      openKeyDialog();
      showToast("请先输入 API Key");
      return;
    }

    const amount = Number($("#customAmount").value || state.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      showToast("请输入大于 0 的充值金额");
      return;
    }

    const now = new Date();
    const datePart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    const order = {
      id: `ET${datePart}${String(Math.floor(Math.random() * 9000) + 1000)}`,
      amount,
      createdAt: now.toISOString(),
      status: "unpaid"
    };

    try {
      const data = await apiRequest(CONFIG.api.createOrder, {
        method: "POST",
        body: JSON.stringify({ amount, currency: "CNY" })
      });
      if (data?.order) Object.assign(order, data.order);
    } catch {
      // fallback to local order for standalone preview
    }

    state.orders.unshift(order);
    state.activeOrder = order;
    renderRecharge();
    showToast(`充值订单已生成：${order.id}`);
  }

  async function submitProof(event) {
    event.preventDefault();
    if (!state.apiKey) {
      openKeyDialog();
      showToast("请先输入 API Key");
      return;
    }
    if (!state.activeOrder) {
      showToast("请先生成充值订单");
      return;
    }

    const transactionId = $("#transactionId").value.trim();
    const proof = $("#paymentProof").files?.[0];
    if (!transactionId && !proof) {
      showToast("请填写交易单号或上传付款凭证");
      return;
    }

    state.activeOrder.status = "pending";
    state.activeOrder.transactionId = transactionId;
    state.activeOrder.proofName = proof?.name || "";

    try {
      await apiRequest(CONFIG.api.submitProof(state.activeOrder.id), {
        method: "POST",
        body: JSON.stringify({
          transaction_id: transactionId,
          proof_name: proof?.name || ""
        })
      });
    } catch {
      // fallback to local status for standalone preview
    }

    renderRecharge();
    showToast("付款信息已提交，等待运营确认到账。");
  }

  // 拉取当前 Key 可用的模型列表，填充连接测试下拉框
  async function loadTestModels() {
    if (!state.apiKey) return;
    const select = $("#testModel");
    try {
      const data = await apiRequest(`${CONFIG.apiOrigin}${CONFIG.api.models}`, { method: "GET" });
      const models = (Array.isArray(data?.data) ? data.data : [])
        .map((item) => item?.id)
        .filter(Boolean)
        .sort();
      if (!models.length) {
        select.innerHTML = '<option value="">当前 Key 无可用模型</option>';
        return;
      }
      const previous = select.value;
      select.innerHTML = [
        '<option value="">选择模型（可选）</option>',
        ...models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)
      ].join("");
      select.value = models.includes(previous) ? previous : "";
    } catch (error) {
      select.innerHTML = `<option value="">模型列表加载失败（${escapeHtml(error.message)}）</option>`;
    }
  }

  async function testConnection() {
    if (!state.apiKey) {
      openKeyDialog();
      showToast("请先输入 API Key");
      return;
    }

    const result = $("#testResult");
    const model = $("#testModel").value;
    result.textContent = "正在测试...";
    result.className = "is-loading";
    const startedAt = performance.now();

    // 选中模型：发送一次极小的真实请求，验证端到端可用（消耗极少额度）
    if (model) {
      try {
        await apiRequest(`${CONFIG.apiOrigin}/v1/chat/completions`, {
          method: "POST",
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 8,
            stream: false
          })
        });
        const latency = Math.round(performance.now() - startedAt);
        result.textContent = `连接成功 · ${model} · ${latency}ms`;
        result.className = "is-ok";
      } catch (error) {
        result.textContent = `模型 ${model} 测试失败：${error.message}。请检查该模型的可用性或余额。`;
        result.className = "is-error";
      }
      return;
    }

    // 未选模型：仅验证接口连通性（/v1/models 走严格 TokenAuth，Key 过期/额度耗尽会失败）
    try {
      const data = await apiRequest(`${CONFIG.apiOrigin}${CONFIG.api.models}`, { method: "GET" });
      const count = Array.isArray(data?.data) ? data.data.length : 0;
      result.textContent = count > 0
        ? `连接成功，当前 Key 可用模型 ${count} 个。可从下拉框选择模型做真实请求测试。`
        : "连接成功，接口可用。";
      result.className = "is-ok";
    } catch (error) {
      result.textContent = `连接失败：${error.message}。请检查 Key 状态、额度和 Base URL。`;
      result.className = "is-error";
    }
  }

  function exportUsage() {
    if (!state.apiKey) {
      openKeyDialog();
      showToast("请先输入 API Key");
      return;
    }

    const records = filteredUsage();
    if (!records.length) {
      showToast("当前筛选没有可导出的记录");
      return;
    }

    const header = ["时间", "模型", "请求ID", "输入Token", "输出Token", "总Token", "消耗金额", "状态"];
    const lines = records.map((item) => [
      formatDateTime(item.createdAt),
      item.model,
      item.id,
      item.input,
      item.output,
      item.total,
      item.cost,
      statusLabel(item.status)
    ]);
    const csv = [header, ...lines]
      .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `equaltoken-usage-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast(`已导出 ${records.length} 条调用记录。`);
  }

  function bindEvents() {
    $("#keyDialogForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      await verifyKey($("#apiKeyInput").value);
    });

    $("#keyApplicationForm").addEventListener("submit", submitKeyApplication);
    $("#resetApplyForm").addEventListener("click", resetApplyForm);
    $("#changeKeyBtn").addEventListener("click", openKeyDialog);
    $("#closeKeyDialog").addEventListener("click", closeKeyDialog);
    $("#clearKeyBtn").addEventListener("click", () => {
      clearKey();
      $("#apiKeyInput").focus();
    });
    $("#keyDialog").addEventListener("click", (event) => {
      if (event.target === $("#keyDialog")) closeKeyDialog();
    });

    $("#refreshQuery").addEventListener("click", async () => {
      if (!state.apiKey) {
        openKeyDialog();
        showToast("请先输入 API Key");
        return;
      }
      try {
        const { account, usage } = await loadAccountData();
        state.account = account;
        state.usage = usage;
      } catch (error) {
        showToast(`刷新失败：${error.message}`);
        return;
      }
      renderSummary();
      renderUsage();
      showToast("余额与调用明细已刷新。");
    });
    $("#exportUsage").addEventListener("click", exportUsage);

    $("#rangeFilter").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-range]");
      if (!button) return;
      state.range = button.dataset.range;
      $$("#rangeFilter button").forEach((item) => item.classList.toggle("is-active", item === button));
      renderUsage();
    });

    $("#modelFilter").addEventListener("change", (event) => {
      state.model = event.target.value;
      renderUsage();
    });

    $("#statusFilter").addEventListener("change", (event) => {
      state.status = event.target.value;
      renderUsage();
    });

    $("#searchFilter").addEventListener("input", (event) => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        state.search = event.target.value;
        renderUsage();
      }, 140);
    });

    $("#amountGrid").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-amount]");
      if (!button) return;
      selectAmount(button.dataset.amount);
    });

    $("#customAmount").addEventListener("input", (event) => {
      const amount = Number(event.target.value);
      if (!Number.isFinite(amount) || amount <= 0) return;
      state.amount = amount;
      $$("#amountGrid button").forEach((button) => {
        button.classList.toggle("is-active", Number(button.dataset.amount) === amount);
      });
    });

    $("#createOrder").addEventListener("click", createOrder);
    $("#proofForm").addEventListener("submit", submitProof);
    $("#testConnection").addEventListener("click", testConnection);
    $("#testModel").addEventListener("focus", () => {
      if (state.apiKey && $("#testModel").options.length <= 1) loadTestModels();
    });

    $("#toggleKeyVisibility").addEventListener("click", () => {
      state.visibleKey = !state.visibleKey;
      renderCredentials();
    });

    $("#guideTabs").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-guide]");
      if (!button) return;
      state.guide = button.dataset.guide;
      renderGuide();
    });

    document.addEventListener("click", (event) => {
      const viewTrigger = event.target.closest("[data-view]");
      if (viewTrigger) {
        setView(viewTrigger.dataset.view);
        return;
      }

      const codeButton = event.target.closest("[data-copy-code]");
      if (codeButton) {
        const pre = codeButton.closest(".code-block")?.querySelector("pre");
        copyText(pre?.textContent, "配置示例已复制。");
        return;
      }

      const copyButton = event.target.closest("[data-copy-target]");
      if (copyButton) {
        const target = document.querySelector(copyButton.dataset.copyTarget);
        copyText(target?.textContent, "已复制到剪贴板。");
      }
    });

    window.addEventListener("hashchange", () => {
      const target = window.location.hash.replace("#", "");
      setView(target);
    });
  }

  async function init() {
    bindEvents();
    selectAmount(100);
    $("#supportWeChat").textContent = CONFIG.supportWeChat;

    // 功能开关：隐藏未放开的导航入口（视图本体仍存在，但 setView 会拒绝跳转）
    if (!CONFIG.features.recharge) {
      $(".primary-nav [data-view='recharge']").hidden = true;
    }
    if (!CONFIG.features.apply) {
      $(".primary-nav [data-view='apply']").hidden = true;
    }

    const initialView = window.location.hash.replace("#", "");
    if (["query", "recharge", "config", "apply"].includes(initialView)) {
      setView(initialView);
    } else {
      setView("query");
    }

    let storedKey = "";
    try {
      storedKey = sessionStorage.getItem(CONFIG.storageKey) || "";
    } catch {
      storedKey = "";
    }

    if (storedKey) {
      $("#apiKeyInput").value = storedKey;
      const ok = await verifyKey(storedKey);
      if (!ok) renderSession();
    } else {
      renderSession();
    }
  }

  init();
})();
