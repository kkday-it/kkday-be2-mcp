# be2-MCP — Cloud-Ready Phase A Runbook

> 部署 be2-mcp 到 stage 內網的實務指南。phase A 涵蓋 Dockerfile / build 產物 / bind host / public URL / readyz probe / graceful shutdown——從單機 PoC（`127.0.0.1:8787` + SQLite）升級到可被 DevOps 部署為托管服務。

---

## 1. 環境變數設定

### 必設（擇一模式）

#### 推薦：用 `BE2_ENV` 快捷選環境

```bash
export BE2_ENV=stage
```

設 `BE2_ENV=stage` 後，config 自動帶入：
- `AUTHSVC_URL=https://auth.stage.kkday.com`
- `GATEWAY_URL=https://api-gateway.stage.kkday.com`
- `SIT_AUTHSVC_SERVICE_KEY` 改讀 `STAGE_AUTHSVC_SERVICE_KEY` 環境變數

| `BE2_ENV` 值 | authsvc host | gateway host | 讀取 service key 變數 | 預設 DB 路徑 |
|---|---|---|---|---|
| `sit` | `auth-220.sit.kkday.com` | `api-gateway-220.sit.kkday.com` | `SIT_AUTHSVC_SERVICE_KEY` | `./data/be2-mcp-sit.sqlite` |
| `sit-220` | `auth-220.sit.kkday.com` | `api-gateway-220.sit.kkday.com` | `SIT_AUTHSVC_SERVICE_KEY` | `./data/be2-mcp-sit-220.sqlite` |
| `stage` | `auth.stage.kkday.com` | `api-gateway.stage.kkday.com` | `STAGE_AUTHSVC_SERVICE_KEY` | `./data/be2-mcp-stage.sqlite` |
| `prod` | `auth.kkday.com` | `api-gateway.kkday.com` | `PRODUCTION_AUTHSVC_SERVICE_KEY` | `./data/be2-mcp-prod.sqlite` |

#### 或手動指定 host + key（legacy）

```bash
export AUTHSVC_URL=https://auth.stage.kkday.com
export GATEWAY_URL=https://api-gateway.stage.kkday.com
export SIT_AUTHSVC_SERVICE_KEY=<service-key-from-vault-or-secret>
```

### 機密：Service Key

**決不能**進 image、commit 或日誌。必須從 secrets 管理系統注入（k8s Secret / Vault）。

```bash
# 示例（實際走 Secret Manager）
export STAGE_AUTHSVC_SERVICE_KEY=<從 k8s Secret 或 Vault 注入>
```

### 部署必設

#### 綁定介面與暴露 URL

```bash
# 內網部署：綁可達的介面（不能再用 127.0.0.1）
export BE2_MCP_BIND_HOST=0.0.0.0

# 對外域名（用於 OAuth redirect_uri 確認、Host header guard 等）
# 通常由 ingress 或反代提供的域名
export BE2_MCP_PUBLIC_BASE_URL=https://be2-mcp.stage.kkday.com

# Host header 白名單（防 Host 注入）
# 填 ingress/反代對外的域名，多個用英文逗號分隔
export BE2_MCP_ALLOWED_HOSTS=be2-mcp.stage.kkday.com
```

#### 持久化存儲路徑

```bash
# SQLite 檔案路徑（單實例階段）
# 生產應掛 PVC；多實例或 prod 應改 Postgres 連線字串
export BE2_MCP_DB_PATH=/data/be2-mcp.sqlite
```

### 可選但建議

#### 可觀測性（OpenTelemetry）

```bash
# Trace 輸出模式
# off (預設)、console (stdout)、otlp (送 collector)
export OTEL_MODE=otlp

# 若設 otlp，需提供 OTLP HTTP exporter endpoint
export OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.monitoring:4318
```

### 務必不設（開發工具，prod 隱患）

```bash
# 禁止在生產設此項！dev panel 有未授權查看稽核 / 手動執行危險操作的風險
unset BE2_MCP_DEV_PANEL
```

---

## 2. 建置與執行

### 編譯

```bash
npm run build
```

產生物：
- `dist/src/index.js` — 應用主體
- `dist/scripts/oauth-purge.js` — 每日 cron job
- `dist/ui/*.html` — 確認頁面、SSO 登入、精靈面板等前端資源
- `dist/tests/` 與 `dist/eval/` **不**含入（`tsconfig.build.json` 排除）

### 本地開發執行

```bash
# 直接執行（開發）
npm run dev

# 編譯後執行（模擬生產）
npm run build && node dist/src/index.js
```

預期輸出示例：
```
be2-mcp listening on https://be2-mcp.stage.kkday.com/mcp (bind 0.0.0.0:8787, env: https://api-gateway.stage.kkday.com)
```

### Docker 構建與本地煙霧測試

#### 構建 image

```bash
docker build -t be2-mcp:latest .
```

Dockerfile 採雙層構建（builder + runtime），使用 `node:22-bookworm-slim` base image。

#### 本地煙霧測試（需 Docker daemon）

**注意**：目前開發環境 docker daemon 停用；以下命令供 CI 環境參考。

```bash
# 啟動容器
docker run -d \
  --name be2-mcp-test \
  -e BE2_ENV=sit \
  -e SIT_AUTHSVC_SERVICE_KEY=<test-key> \
  -e BE2_MCP_BIND_HOST=0.0.0.0 \
  -e BE2_MCP_PUBLIC_BASE_URL=http://localhost:8787 \
  -p 8787:8787 \
  be2-mcp:latest

# Liveness probe（應 200）
curl -f http://localhost:8787/healthz
# 預期：200 OK

# Readiness probe（應 200）
curl -f http://localhost:8787/readyz
# 預期：200 OK

# 檢驗 discovery 含 public base URL
curl http://localhost:8787/.well-known/oauth-protected-resource | jq '.issuer'
# 預期包含設定的 BE2_MCP_PUBLIC_BASE_URL

# 驗證 Host header guard（非白名單應 403）
curl -H "Host: evil.attacker.com" http://localhost:8787/healthz
# 預期：403 Forbidden

# SIGTERM 優雅退出（等待 25 秒內所有 in-flight 完成）
kill -TERM <container-pid>
# 日誌應出現 "graceful shutdown" 消息；無突兀終止

# 清理
docker rm -f be2-mcp-test
```

---

## 3. Kubernetes / DevOps 交付合約

### 部署模板與配置

be2-mcp phase A 為**單副本硬前提**（HA 與多實例是 phase C 工作）。

#### 最小可行部署（單實例 + SQLite）

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: be2-mcp
  namespace: be2  # 或適當的 namespace
spec:
  replicas: 1  # 硬要求：不超過 1（無分散式鎖/Redis）
  selector:
    matchLabels:
      app: be2-mcp
  template:
    metadata:
      labels:
        app: be2-mcp
    spec:
      terminationGracePeriodSeconds: 30  # ≥ app 內硬逾時 25s
      containers:
      - name: be2-mcp
        image: be2-mcp:latest  # 由 CI/CD 推送
        imagePullPolicy: IfNotPresent
        ports:
        - name: http
          containerPort: 8787
          protocol: TCP
        env:
        # 環境選擇
        - name: BE2_ENV
          value: "stage"
        
        # 機密（從 Secret 注入）
        - name: STAGE_AUTHSVC_SERVICE_KEY
          valueFrom:
            secretKeyRef:
              name: be2-mcp-secrets
              key: authsvc-service-key
        
        # 部署位置（綁非 loopback）
        - name: BE2_MCP_BIND_HOST
          value: "0.0.0.0"
        - name: BE2_MCP_PUBLIC_BASE_URL
          value: "https://be2-mcp.stage.kkday.com"
        - name: BE2_MCP_ALLOWED_HOSTS
          value: "be2-mcp.stage.kkday.com"
        
        # 持久化
        - name: BE2_MCP_DB_PATH
          value: "/data/be2-mcp.sqlite"
        
        # 可觀測（可選）
        - name: OTEL_MODE
          value: "otlp"
        - name: OTEL_EXPORTER_OTLP_ENDPOINT
          value: "http://otel-collector.monitoring:4318"
        
        # 禁用開發工具
        # BE2_MCP_DEV_PANEL 不設（unset）
        
        # 探針
        livenessProbe:
          httpGet:
            path: /healthz
            port: http
          initialDelaySeconds: 10
          periodSeconds: 10
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /readyz
            port: http
          initialDelaySeconds: 5
          periodSeconds: 5
          failureThreshold: 2
        
        # 資源需求（輕級服務）
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 1000m
            memory: 1Gi
        
        # 持久化掛載（SQLite）
        volumeMounts:
        - name: data
          mountPath: /data
      
      # 資料卷（RWO block，非 NFS）
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: be2-mcp-data
---
# 持久卷聲明（給 DevOps 佈建 PVC 用）
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: be2-mcp-data
  namespace: be2
spec:
  accessModes:
  - ReadWriteOnce  # RWO 單副本，SQLite 需 block volume 非 NFS
  storageClassName: standard-encrypted  # 須支持加密（承載明文 token store）
  resources:
    requests:
      storage: 10Gi  # 單實例起始，audit_log 與 token store 共用
```

#### Secret（機密，由 DevOps 佈建）

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: be2-mcp-secrets
  namespace: be2
type: Opaque
data:
  authsvc-service-key: <base64-encoded-stage-service-key>
```

### 依賴與網路

#### Egress 放行（防火牆 / SG 規則）

be2-mcp pod 必須能連出到：

| 目標 | 用途 | Stage 參考 host |
|---|---|---|
| auth-service | S2S 換碼、`/verify`、`/refresh-token` | `auth.stage.kkday.com:443` |
| be2 API gateway | be2 商品讀寫（`/be2/api/v1`）、product-service（`/product/api/v1`） | `api-gateway.stage.kkday.com:443` |
| OTLP collector（若啟用） | Trace 匯出 | 視環境而定，通常同內網 |

**禁止**其他外網連線（不連 Anthropic、不連公網 DNS 等）。

#### Ingress

內網 TLS ingress 終結 HTTPS，反代到 pod 的 `:8787`（HTTP）。

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: be2-mcp
  namespace: be2
spec:
  ingressClassName: nginx  # 或適當的 ingress controller
  tls:
  - hosts:
    - be2-mcp.stage.kkday.com
    secretName: be2-mcp-tls
  rules:
  - host: be2-mcp.stage.kkday.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: be2-mcp
            port:
              number: 8787
---
apiVersion: v1
kind: Service
metadata:
  name: be2-mcp
  namespace: be2
spec:
  type: ClusterIP
  selector:
    app: be2-mcp
  ports:
  - name: http
    port: 8787
    targetPort: http
```

### 每日 Cron Job：Token 清理

OAuth 中的過期 authorization code、refresh token 和孤立 DCR client 須每日清理（防洩漏、防存儲爆炸）。

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: be2-mcp-oauth-purge
  namespace: be2
spec:
  schedule: "0 2 * * *"  # 每日凌晨 2 點（調整為適合的時間）
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: be2-mcp  # 或適當的 SA
          restartPolicy: OnFailure
          containers:
          - name: purge
            image: be2-mcp:latest
            command:
            - node
            - dist/scripts/oauth-purge.js
            env:
            - name: BE2_ENV
              value: "stage"
            - name: STAGE_AUTHSVC_SERVICE_KEY
              valueFrom:
                secretKeyRef:
                  name: be2-mcp-secrets
                  key: authsvc-service-key
            - name: BE2_MCP_DB_PATH
              value: "/data/be2-mcp.sqlite"
            volumeMounts:
            - name: data
              mountPath: /data
          volumes:
          - name: data
            persistentVolumeClaim:
              claimName: be2-mcp-data
```

### Health & Readiness Probes

| 端點 | 用途 | 認證 | 用途 |
|---|---|---|---|
| `GET /healthz` | Liveness | 無（豁免） | k8s liveness probe；無認證、無效驗證 |
| `GET /readyz` | Readiness | 無（豁免） | k8s readiness probe；只查 DB（`SELECT 1`），不查下游（auth/gateway 短斷是 per-request 暫時錯，不該把 pod 拉出 rotation） |

**煙霧測試**：
```bash
curl http://be2-mcp:8787/healthz
# 應 200 OK

curl http://be2-mcp:8787/readyz
# 應 200 OK；若 DB 不可達應 503
```

### Graceful Shutdown

app 內硬編逾時 `25_000` ms（25 秒）。必須設 `terminationGracePeriodSeconds ≥ 30` 以充分時間：
- 拒新 request
- 等現存 in-flight 完成（tool call、change-set 執行）
- 關閉 scheduler
- 同步 audit log
- 刪 DB 連線

```bash
# 模擬優雅退出測試
kubectl -n be2 delete pod be2-mcp-<pod-suffix>
# 日誌應見 "graceful shutdown" 消息；無衝突
```

---

## 4. 邊界與限制

### 必須滿足

1. **單副本硬前提**：phase A 暫只支持 1 個 pod。多實例（水平擴展）是 phase C 工作（需 Postgres + Redis）。
2. **SQLite + RWO block volume**：must 用 block-based PVC（不支持 NFS），理由：
   - SQLite WAL 模式需鎖定與順序寫保證
   - NFS 的 flock/fcntl 不可靠，會導致資料庫損毀
3. **存儲加密**：PV 的 storage class 須啟用加密，因為 token store 含明文 be2 token。
4. **Audit log 備份**：`audit_log` 表須定期備份（合規要求）；SQLite dump 或 Postgres 備份工具。

### 已知限制

- **Live stage e2e 驗證 = PENDING**：依下列外部條件：
  - DevOps 完成 stage EKS 部署 + 內網 DNS 配置
  - auth-service team 提供 `STAGE_AUTHSVC_SERVICE_KEY`
  - 測試帳號在 stage 環境具有目標商品的寫入權限
  
  一旦上述具備，執行 `npm run eval` 與手動 pilot 才能確認端對端寫入合約正確。

- **HA / 災備**：phase A 無冗餘。pod 掛掉 → 連線中斷、change-set 執行暫停。phase C 應加 Postgres + Redis 叢集以支持多副本。
- **OTLP collector**：若啟用 `OTEL_MODE=otlp`，需另行部署或復用既有 KKday OTel stack；app 本身不含。

### 版本與依賴

- **Node.js**：必須 22（LTS）；`package.json` 硬編 `"engines": {"node": ">=22 <23"}`
- **better-sqlite3**：native module，image build 時需能編譯（bookworm base 含必要工具）
- **MCP SDK**：`@modelcontextprotocol/sdk ^1.30`；Streamable HTTP 傳輸

---

## 5. 驗收檢查清單

部署前確認以下事項：

- [ ] `npm run build` 產出 `dist/src/index.js` 與 `dist/scripts/oauth-purge.js`
- [ ] `npm run ci` 全綠（無新測試失敗）
- [ ] `docker build` 成功，image 能啟動（若有 Docker 環境）
- [ ] 環境變數正確設定（特別是 `BE2_MCP_BIND_HOST=0.0.0.0` 與 `BE2_MCP_PUBLIC_BASE_URL`）
- [ ] `STAGE_AUTHSVC_SERVICE_KEY` 已從 Secret Manager 注入
- [ ] k8s Deployment / PVC / Ingress / CronJob 配置無誤
- [ ] 防火牆規則允許 pod → auth-service + gateway 的 443 egress
- [ ] PV storage class 啟用加密
- [ ] `terminationGracePeriodSeconds ≥ 30`
- [ ] Liveness/Readiness probe 端點 (`/healthz`, `/readyz`) 可達
- [ ] be2-auth POPUP 登入已在 auth-service 驗證通過
- [ ] `BE2_MCP_DEV_PANEL` **未設**（生產風險隔離）

---

## 相關文件

- 認證與 OAuth 設計：`be2-mcp-auth-design.md`、`oauth-runbook.md`
- 確認頁與 SSO：`phase2b-runbook.md`
- 服務架構與依賴：`deploy-architecture.md`
