# Equal Token C 端（BFF + 静态页面单容器部署）
# 布局保持 /app/bff/../ = 静态目录，BFF 默认从 .. 托管页面（STATIC_DIR 无需配置）
FROM node:20-alpine

COPY bff/server.js bff/package.json /app/bff/
COPY index.html styles.css app.js /app/
COPY assets /app/assets

WORKDIR /app/bff
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1

CMD ["node", "server.js"]
