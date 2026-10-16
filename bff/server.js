#!/usr/bin/env node
"use strict";

// Equal Token C 端 BFF
// 浏览器 → 本服务（返回换算后的展示值）→ new-api（原始 quota 不出本服务）
//
// 路由：
//   GET /healthz               健康检查
//   GET /api/c/account/summary 账户摘要（按用户分组倍率换算后的展示值）
//   GET /api/c/usage/logs      调用明细（成本已换算）
//
// 鉴权：请求头 Authorization: Bearer <sk-...>，原样透传给 new-api 校验。

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// ---------- .env 加载（优先 .env，回退 .env.example；不覆盖已有环境变量） ----------

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
  return true;
}

loadEnvFile(path.join(__dirname, ".env")) || loadEnvFile(path.join(__dirname, ".env.example"));

// ---------- 配置 ----------

const PORT = Number(process.env.PORT) || 8787;
const NEW_API_BASE = (process.env.NEW_API_BASE || "").replace(/\/+$/, "");
const ADMIN_PAT = process.env.ADMIN_PAT || "";
const QUOTA_PER_UNIT = Number(process.env.QUOTA_PER_UNIT) || 500000;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 10000;
const GROUP_CACHE_TTL_MS = Number(process.env.GROUP_CACHE_TTL_MS) || 5 * 60 * 1000;
const DEFAULT_RATIO = positiveNumber(process.env.DEFAULT_RATIO, 1);
const GROUP_RATIOS = parseGroupRatios(process.env.GROUP_RATIOS || "");
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "").replace(/\/+$/, "");
// BFF 同时托管 C 端静态页面（默认 ../，即 C 端项目根目录）；设为空字符串可关闭
const STATIC_DIR = process.env.STATIC_DIR === "" ? "" : path.resolve(__dirname, process.env.STATIC_DIR || "..");

if (!NEW_API_BASE) {
  console.error("[bff] 缺少环境变量 NEW_API_BASE（new-api 站点根地址）");
  process.exit(1);
}
if (!ALLOWED_ORIGIN) {
  console.warn("[bff] 未配置 ALLOWED_ORIGIN：跨域请求将被拒绝（BFF 托管页面的同源访问不受影响）");
}

function positiveNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

// "default=2,vip=1.5" 或 "default:2,vip:1.5" → Map
function parseGroupRatios(raw) {
  const map = new Map();
  for (const part of raw.split(",")) {
    const item = part.trim();
    if (!item) continue;
    const sep = item.includes("=") ? "=" : ":";
    const idx = item.indexOf(sep);
    if (idx <= 0) continue;
    const group = item.slice(0, idx).trim();
    const ratio = Number(item.slice(idx + 1).trim());
    if (group && Number.isFinite(ratio) && ratio > 0) map.set(group, ratio);
  }
  return map;
}

// ---------- 工具 ----------

function maskKey(key) {
  if (!key || key.length < 12) return "****";
  return `${key.slice(0, 7)}****${key.slice(-4)}`;
}

function extractKey(header) {
  let key = String(header || "").trim();
  if (/^bearer /i.test(key)) key = key.slice(7).trim();
  return key.length >= 8 ? key : "";
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

// 简单的每 IP 限流：默认 120 次/分钟
const RATE_LIMIT = 120;
const rateBuckets = new Map(); // ip -> { count, resetAt }
function rateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT) return true;
  if (rateBuckets.size > 10_000) {
    for (const [k, v] of rateBuckets) {
      if (v.resetAt <= now) rateBuckets.delete(k);
    }
  }
  return false;
}

async function upstream(path, key, usePat = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(`${NEW_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${usePat ? ADMIN_PAT : key}` },
      signal: controller.signal
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // 非 JSON 响应时保持 body 为 null
    }
    return {
      status: response.status,
      body,
      retryAfter: response.headers.get("retry-after")
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 分组倍率解析 ----------

// userId -> { userId, group, expiresAt }
const groupCache = new Map();

// new-api 后台的分组倍率（GET /api/option/ 的 group_ratio_setting.group_ratio），
// 定时同步，无需手工维护
let autoGroupRatios = new Map();

// 手动映射优先于后台配置，便于临时覆盖某个分组的展示倍率
function getRatioForGroup(group) {
  if (!group) return DEFAULT_RATIO;
  return GROUP_RATIOS.get(group) ?? autoGroupRatios.get(group) ?? DEFAULT_RATIO;
}

// 从 new-api 同步后台配置的分组倍率（root PAT）。
// 注意：后台「Group Pricing」页面保存的是 GroupRatio 选项（实时更新）；
// group_ratio_setting.group_ratio 只是进程启动时的快照，会滞后，仅作兜底。
async function refreshUpstreamGroupRatios() {
  if (!ADMIN_PAT) return;
  try {
    const { status, body } = await upstream("/api/option/", "", true);
    if (status !== 200 || !Array.isArray(body?.data)) {
      console.warn(`[bff] 同步分组倍率失败: HTTP ${status}`);
      return;
    }
    const byKey = new Map(body.data.map((option) => [option?.key, option?.value]));
    const raw = byKey.get("GroupRatio") || byKey.get("group_ratio_setting.group_ratio");
    if (!raw) {
      console.warn("[bff] 同步分组倍率失败: 响应中无 GroupRatio 配置");
      return;
    }
    const parsed = JSON.parse(raw);
    const map = new Map();
    for (const [group, ratio] of Object.entries(parsed)) {
      const num = Number(ratio);
      if (group && Number.isFinite(num) && num > 0) map.set(group, num);
    }
    autoGroupRatios = map;
    console.log(`[bff] 已从 new-api 同步分组倍率: ${[...map].map(([g, r]) => `${g}=${r}`).join(", ") || "(空)"}`);
  } catch (error) {
    console.warn(`[bff] 同步分组倍率失败: ${error.message}`);
  }
}

// 从日志记录中取 user_id，再通过管理接口查用户分组；
// 拿不到分组时回退默认倍率。
async function resolveGroupRatio(logs) {
  const userId = (Array.isArray(logs) ? logs : [])
    .map((log) => Number(log.user_id || 0))
    .find((id) => id > 0) || 0;

  if (!userId || !ADMIN_PAT) {
    return { userId: 0, group: null, ratio: DEFAULT_RATIO };
  }

  const cached = groupCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached, ratio: getRatioForGroup(cached.group) };
  }

  let group = null;
  try {
    const { status, body } = await upstream(`/api/user/${userId}`, "", true);
    if (status === 200 && body?.data?.group) group = String(body.data.group);
  } catch {
    // 查询失败时使用默认倍率
  }

  const entry = { userId, group, expiresAt: Date.now() + GROUP_CACHE_TTL_MS };
  groupCache.set(userId, entry);
  return { ...entry, ratio: getRatioForGroup(group) };
}

// ---------- 业务处理 ----------

function toDisplayMoney(quota, ratio) {
  return Number((Number(quota || 0) / QUOTA_PER_UNIT / ratio).toFixed(6));
}

function dayBoundaries() {
  const now = new Date();
  return {
    todayStart: new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(),
    monthStart: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
    nowSec: Math.floor(now.getTime() / 1000)
  };
}

// type: 2 = 消费（成功），5 = 错误（失败），其余类型不对外展示
function isDisplayLog(log) {
  return log.type === 2 || log.type === 5;
}

function mapLogRecord(log, ratio) {
  const input = Number(log.prompt_tokens || 0);
  const output = Number(log.completion_tokens || 0);
  const createdAt = Number(log.created_at || 0) * 1000;
  return {
    id: log.request_id || `log-${log.id}`,
    created_at: createdAt > 0 ? new Date(createdAt).toISOString() : "",
    model: log.model_name || "--",
    input,
    output,
    total: input + output,
    cost: toDisplayMoney(log.quota, ratio),
    status: log.type === 5 ? "failed" : "success"
  };
}

async function handleSummary(key) {
  const usage = await upstream("/api/usage/token/", key);
  if (usage.status === 401 || usage.status === 403) {
    return { status: 401, body: { success: false, message: "API Key 无效、已禁用或用户已被封禁" } };
  }
  if (usage.status === 429) {
    return { status: 429, retryAfter: usage.retryAfter, body: { success: false, message: "上游请求过于频繁，请稍后重试" } };
  }
  if (usage.status !== 200 || !usage.body?.data) {
    return { status: 502, body: { success: false, message: "new-api 接口异常" } };
  }
  const tokenInfo = usage.body.data;

  const logsResponse = await upstream("/api/log/token", key);
  if (logsResponse.status === 401 || logsResponse.status === 403) {
    return { status: 401, body: { success: false, message: "API Key 无效、已禁用或用户已被封禁" } };
  }
  if (logsResponse.status === 429) {
    return { status: 429, retryAfter: logsResponse.retryAfter, body: { success: false, message: "上游请求过于频繁，请稍后重试" } };
  }
  if (logsResponse.status !== 200) {
    return { status: 502, body: { success: false, message: "new-api 接口异常" } };
  }
  const logs = Array.isArray(logsResponse.body?.data) ? logsResponse.body.data : [];
  const { ratio } = await resolveGroupRatio(logs);

  const { todayStart, monthStart, nowSec } = dayBoundaries();
  const expiresAt = Number(tokenInfo.expires_at || 0);
  const unlimited = Boolean(tokenInfo.unlimited_quota);

  let monthSpent = 0;
  let todaySpent = 0;
  for (const log of logs) {
    if (log.type !== 2) continue;
    const ts = Number(log.created_at || 0) * 1000;
    if (!ts) continue;
    const cost = toDisplayMoney(log.quota, ratio);
    if (ts >= monthStart) monthSpent += cost;
    if (ts >= todayStart) todaySpent += cost;
  }
  const records = logs.filter(isDisplayLog).map((log) => mapLogRecord(log, ratio));

  return {
    status: 200,
    body: {
      success: true,
      data: {
        unlimited,
        balance: unlimited ? null : toDisplayMoney(tokenInfo.total_available, ratio),
        total_quota: unlimited ? null : toDisplayMoney(tokenInfo.total_granted, ratio),
        total_spent: toDisplayMoney(tokenInfo.total_used, ratio),
        month_spent: Number(monthSpent.toFixed(6)),
        today_spent: Number(todaySpent.toFixed(6)),
        expires_at: expiresAt,
        status: expiresAt > 0 && expiresAt < nowSec ? "已过期" : "正常",
        records
        // 注意：不返回 group / user_id / display_ratio —— 分组与倍率是内部信息，
        // 仅用于服务端换算，不向任何客户端暴露
      }
    }
  };
}

async function handleLogs(key) {
  const logsResponse = await upstream("/api/log/token", key);
  if (logsResponse.status === 401 || logsResponse.status === 403) {
    return { status: 401, body: { success: false, message: "API Key 无效、已禁用或用户已被封禁" } };
  }
  if (logsResponse.status === 429) {
    return { status: 429, retryAfter: logsResponse.retryAfter, body: { success: false, message: "上游请求过于频繁，请稍后重试" } };
  }
  if (logsResponse.status !== 200) {
    return { status: 502, body: { success: false, message: "new-api 接口异常" } };
  }
  const logs = Array.isArray(logsResponse.body?.data) ? logsResponse.body.data : [];
  const { ratio } = await resolveGroupRatio(logs);
  const records = logs.filter(isDisplayLog).map((log) => mapLogRecord(log, ratio));
  return { status: 200, body: { success: true, data: { records } } };
}

// ---------- 静态页面托管 ----------

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2"
};

// 返回 true 表示已响应（含 404）；拒绝 dotfile 与路径穿越，避免 .env 等敏感文件外泄
function serveStatic(pathname, res) {
  let filePath;
  try {
    filePath = decodeURIComponent(pathname);
  } catch {
    filePath = "";
  }
  const unsafe =
    !filePath ||
    filePath.includes("\0") ||
    filePath.split("/").some((segment) => segment.startsWith("."));
  if (unsafe) {
    json(res, 404, { success: false, message: "Not Found" });
    return true;
  }
  if (filePath === "/") filePath = "/index.html";
  const resolved = path.resolve(STATIC_DIR, `.${filePath}`);
  // BFF 自身代码目录不对外提供（URL 解析会预先规范化 ..，需按解析后路径再挡一次）
  if (resolved !== STATIC_DIR && !resolved.startsWith(STATIC_DIR + path.sep)) {
    json(res, 404, { success: false, message: "Not Found" });
    return true;
  }
  if (resolved.startsWith(__dirname + path.sep)) {
    json(res, 404, { success: false, message: "Not Found" });
    return true;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      json(res, 404, { success: false, message: "Not Found" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(resolved).toLowerCase()] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-cache"
    });
    res.end(data);
  });
  return true;
}

// ---------- HTTP 服务 ----------

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(origin === ALLOWED_ORIGIN ? 204 : 403);
    res.end();
    return;
  }
  if (req.method !== "GET") {
    json(res, 405, { success: false, message: "Method Not Allowed" });
    return;
  }

  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/healthz") {
    json(res, 200, { success: true, data: { status: "ok" } });
    return;
  }

  // C 端静态页面：BFF 托管，同源访问无需 CORS
  if (STATIC_DIR && !pathname.startsWith("/api/")) {
    if (serveStatic(pathname, res)) return;
  }

  const ip = req.socket.remoteAddress || "unknown";
  if (rateLimited(ip)) {
    json(res, 429, { success: false, message: "请求过于频繁，请稍后再试" });
    return;
  }

  const key = extractKey(req.headers.authorization);
  if (!key) {
    json(res, 401, { success: false, message: "缺少 API Key" });
    return;
  }

  try {
    let result;
    if (pathname === "/api/c/account/summary") {
      result = await handleSummary(key);
    } else if (pathname === "/api/c/usage/logs") {
      result = await handleLogs(key);
    } else {
      result = { status: 404, body: { success: false, message: "Not Found" } };
    }
    if (result.retryAfter) res.setHeader("Retry-After", result.retryAfter);
    json(res, result.status, result.body);
    console.log(`[bff] ${pathname} key=${maskKey(key)} → ${result.status}`);
  } catch (error) {
    console.error(`[bff] ${pathname} key=${maskKey(key)} 处理失败:`, error.message);
    json(res, 502, { success: false, message: "上游服务不可用" });
  }
});

server.listen(PORT, () => {
  console.log(`[bff] C 端 BFF 已启动: http://localhost:${PORT}`);
  console.log(`[bff] 上游: ${NEW_API_BASE}`);
  if (STATIC_DIR) {
    console.log(`[bff] 静态页面目录: ${STATIC_DIR}（本地测试直接访问 http://localhost:${PORT}）`);
  }
  console.log(`[bff] CORS 白名单: ${ALLOWED_ORIGIN || "(未配置，仅同源)"}`);
  console.log(`[bff] 手动倍率覆盖: ${GROUP_RATIOS.size ? [...GROUP_RATIOS].map(([g, r]) => `${g}=${r}`).join(", ") : "(无)"} · 默认倍率: ${DEFAULT_RATIO}`);
  if (!ADMIN_PAT) {
    console.warn("[bff] 未配置 ADMIN_PAT，无法识别用户分组，也无法同步后台分组倍率，所有用户将使用默认倍率");
  } else {
    refreshUpstreamGroupRatios();
    setInterval(refreshUpstreamGroupRatios, GROUP_CACHE_TTL_MS);
  }
});
