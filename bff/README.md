# Equal Token C 端 BFF

薄服务层：浏览器 → 本服务 → new-api。在服务端完成**分组倍率换算**，只向 C 端下发展示值，原始 quota 不进入浏览器（DevTools 也看不到内部金额口径）。

零第三方依赖，需 Node.js >= 18。

## 部署

```bash
cd bff
cp .env.example .env   # 按注释填写后
set $(cat .env | xargs) # Linux/macOS 用 export 或 dotenv 工具；也可直接设环境变量
node server.js         # 或 npm start
```

生产建议用 systemd / Docker / pm2 托管，反代到 `https://c-api.equaltoken.com` 之类的域名并加 HTTPS。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `NEW_API_BASE` | ✅ | new-api 站点根地址，如 `https://equaltoken.top` |
| `ALLOWED_ORIGIN` | ✅ | C 端页面来源（CORS 白名单），如 `https://c.equaltoken.com` |
| `ADMIN_PAT` | 推荐 | 管理员的系统访问令牌（new-api 控制台 → 个人设置 → 生成），用于查询用户分组 |
| `GROUP_RATIOS` | 推荐 | 分组倍率映射，如 `default=2,vip=1.5`；展示值 = 内部值 ÷ 倍率 |
| `DEFAULT_RATIO` | | 拿不到分组时的兜底倍率，默认 `1` |
| `QUOTA_PER_UNIT` | | 额度换算单位，默认 `500000`（= 1 美元），需与网关一致 |
| `PORT` | | 默认 `8787` |
| `UPSTREAM_TIMEOUT_MS` | | 上游超时，默认 `10000` |
| `GROUP_CACHE_TTL_MS` | | 用户分组缓存时长，默认 `300000`（5 分钟） |

## 倍率解析链路

1. 用 sk- Key 调 new-api `GET /api/usage/token/` + `GET /api/log/token`
2. 从日志取 `user_id` → 用 `ADMIN_PAT` 调管理接口 `GET /api/user/{id}` 拿 `group`（有 5 分钟缓存）
3. 分组倍率**自动从 new-api 后台同步**（`GET /api/option/` 的 `group_ratio_setting.group_ratio`，启动时 + 定时刷新），无需手工维护
4. `ratio = GROUP_RATIOS[group]（手动覆盖） > 后台分组倍率 > DEFAULT_RATIO`
5. 所有金额 ÷ ratio 后返回；Key 无日志（新建）时使用默认倍率

## 接口

| 路由 | 说明 |
|---|---|
| `GET /healthz` | 健康检查 |
| `GET /api/c/account/summary` | 账户摘要（Bearer sk- Key），返回展示值余额/总额度/已用聚合/有效期 |
| `GET /api/c/usage/logs` | 调用明细（Bearer sk- Key），type 2/5，成本已换算 |

鉴权失败统一 401；内置每 IP 120 次/分钟限流；日志只输出掩码 Key，不落盘明文。

## C 端前端配置

```html
<script>
  window.EQUAL_TOKEN_C_BFF_ORIGIN = "https://c-api.equaltoken.com"; // BFF 地址
  // 可选：EQUAL_TOKEN_C_ENABLE_RECHARGE / EQUAL_TOKEN_C_ENABLE_APPLY 开放充值与申请页
</script>
<script src="./app.js"></script>
```

不配置 `EQUAL_TOKEN_C_BFF_ORIGIN` 时回退直连模式（浏览器直调 new-api，前端用 `EQUAL_TOKEN_C_DISPLAY_RATIO` 做全局换算）。
