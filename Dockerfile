# Equal Token C 端（BFF + 静态页面单容器部署）
# 阶段 1：压缩前端 JS —— 仓库保留可读源码，镜像内只含压缩产物
FROM node:20-alpine AS minify
WORKDIR /src
COPY app.js .
RUN npm install --no-save terser@5.37.0 \
 && npx terser app.js -c -m -o app.min.js

# 阶段 2：运行镜像。布局保持 /app/bff/../ = 静态目录，
# BFF 默认从 .. 托管页面（STATIC_DIR 无需配置）
FROM node:20-alpine

COPY --from=minify /src/app.min.js /app/app.js
COPY bff/server.js bff/package.json /app/bff/
COPY index.html styles.css /app/
COPY assets /app/assets

WORKDIR /app/bff
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1

CMD ["node", "server.js"]
