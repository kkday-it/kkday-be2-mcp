# --- builder ---
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- runtime ---
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# 上雲硬阻斷 1：容器內必須綁 0.0.0.0，否則 k8s probe 打 pod IP 永遠 not Ready。
# 保底預設，避免部署漏設 APP_BIND_HOST 導致 pod 起不來（仍可被 env 覆蓋）。
ENV APP_BIND_HOST=0.0.0.0
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
USER node
EXPOSE 8787
CMD ["node", "dist/src/index.js"]
