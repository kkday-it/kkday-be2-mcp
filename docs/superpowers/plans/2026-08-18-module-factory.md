# Module Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建一個 repo skill `.claude/skills/module-factory/`，把「新增一個 MCP 功能模組」變成三段闘關（探索/產/驗收）的可複製流程；用備援標的 `shelf_toggle_bundle` 首跑驗證 skill 能動。

**Architecture:** 依 spec `docs/superpowers/specs/2026-08-18-module-factory-design.md`（agy APPROVED rounds=3）。交付物是 **skill 本體**（SKILL.md + references 模板 + run-agy-batch.sh 機械編排腳本），不是 bundle module——bundle module 是 skill 跑起來後的產物驗證。skill 的三段之間用 `AskUserQuestion` gate；段② 的六格 module 實作由 skill 執行時派 agy，本 plan 不寫 module 程式碼。

**Tech Stack:** Bash（run-agy-batch.sh + 其 stub 測試）、Markdown（SKILL.md/references）、既有 TS 專案作為 factory 的操作對象。

## Global Constraints

- 交付物 = skill 定義檔，**不含任何 be2 module 的實作程式碼**（那是 factory 執行時的產物）。
- run-agy-batch.sh 職責邊界（spec §3.1）：腳本只做機械 spawn/wait/檔案非空檢查/OK-EMPTY 報告/keys 先跑/冪等；**fallback（EMPTY 格由 Claude 接手）與 gate（AskUserQuestion）不在腳本內**。
- 首發標的 = `shelf_toggle_bundle`（備援標的）；announcement 為真首發但欄位 TBD（`docs/be2-mcp/sit-announcement-contract.md` §6、memory `announcement-fields-tbd`），欄位補齊後切回——skill 文件須註明這個切換條件。
- GATE 1 兩種（spec §2.1）：授權 gate（executor-only PENDING）vs 欄位 gate（block 段②）——SKILL.md 的判定準則須逐字承載。
- agy headless 禁令模板（spec §4）：stage2 模板內建「只有唯讀 shell、檔案用內建編輯工具、產物路徑明確、不用『先 grep』誘導動詞、連兩次零產出 Claude 接手」。
- 不改 `src/core/`、不改任何現有 module——本 plan 只新增 `.claude/skills/module-factory/**`。
- Commit 訊息繁中、`feat(factory):`/`docs(factory):` 前綴，署名 Co-Authored-By。

## File Structure（交付物全貌）

```
.claude/skills/module-factory/
  SKILL.md                              主流程：三段 + 三 gate 執行順序、gate 判定準則、標的切換條件（Task 2）
  scripts/
    run-agy-batch.sh                    段② 機械編排：有界並行派 agy + 檔案非空檢查 + OK/EMPTY 報告（Task 1）
    test-run-agy-batch.sh               上者的 stub 測試（Task 1）
  references/
    stage1-explore.md                   三探索 agent 模板 + 契約報告格式（Task 3）
    stage2-produce.md                   六格 agy prompt 模板 + 禁令段 + 參考格對照（Task 4）
    stage3-verify.md                    ci/build-ui/dev-panel-e2e/PR 驗收步驟（Task 4）
    contract-report-template.md         契約報告骨架 = sit-announcement-contract.md 結構（Task 3）
```

---

### Task 1: run-agy-batch.sh 機械編排腳本 + stub 測試

**Files:**
- Create: `.claude/skills/module-factory/scripts/run-agy-batch.sh`
- Test: `.claude/skills/module-factory/scripts/test-run-agy-batch.sh`

**Interfaces:**
- Produces: 腳本 `run-agy-batch.sh MANIFEST_FILE`——`MANIFEST_FILE` 每行 `格名<TAB>prompt檔路徑<TAB>目標檔路徑`；腳本以 `AGY_CMD`（環境變數，預設 `agy --model gemini-3.1-pro-high --mode accept-edits --print-timeout 15m -p`）派工，最後印 `RESULT <格名> OK|EMPTY` 每格一行。keys 格（格名含 `keys`）先跑完才派其餘。`MAX_PARALLEL` 環境變數預設 3。已非空的目標檔跳過重派（印 `RESULT <格名> OK`，冪等）。

- [ ] **Step 1: 寫 stub 測試** `test-run-agy-batch.sh`：用假 `AGY_CMD`（一個 stub：讀 prompt 檔末行的 `WRITE=1` 決定寫不寫目標檔）驗四件事——(a) 兩格都 WRITE → 兩行 `OK`；(b) 一格 WRITE 一格不寫 → 一 `OK` 一 `EMPTY`；(c) 目標檔預先存在且非空 → 該格印 `OK` 且 stub **未被呼叫**（冪等，用 stub 落一個 call-count 檔驗證）；(d) manifest 含 keys 格 → keys 格的 call 時間戳早於其餘格（keys-first）。

```bash
#!/usr/bin/env bash
# test-run-agy-batch.sh — self-contained, no real agy. 純 bash 斷言。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNNER="$HERE/run-agy-batch.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
CALLS="$TMP/calls.log"; : > "$CALLS"

# stub agy：接 `-p <promptfile内容>`，但我們改用 wrapper 傳 prompt 檔路徑於 env STUB_PROMPT
# runner 呼叫 $AGY_CMD "$(cat promptfile)"；stub 靠 prompt 內容的 marker 找目標檔與 WRITE 旗標
cat > "$TMP/stub-agy.sh" <<'STUB'
#!/usr/bin/env bash
# 最後一個參數 = prompt 內容；解出 TARGET= 與 WRITE=
prompt="${!#}"
target="$(printf '%s\n' "$prompt" | sed -n 's/^TARGET=//p')"
write="$(printf '%s\n' "$prompt" | sed -n 's/^WRITE=//p')"
name="$(printf '%s\n' "$prompt" | sed -n 's/^NAME=//p')"
echo "$name" >> "$CALLS_LOG"
[ "$write" = "1" ] && printf 'generated' > "$target"
exit 0
STUB
chmod +x "$TMP/stub-agy.sh"
export CALLS_LOG="$CALLS"
export AGY_CMD="$TMP/stub-agy.sh"

mkprompt() { # name write target -> prompt 檔
  local f="$TMP/p_$1.txt"
  printf 'NAME=%s\nTARGET=%s\nWRITE=%s\n' "$1" "$3" "$2" > "$f"; echo "$f"
}

# (a) 兩格都寫
: > "$CALLS"
MAN="$TMP/man_a.txt"
printf 'schema\t%s\t%s\n' "$(mkprompt schema 1 "$TMP/schema.ts")" "$TMP/schema.ts" > "$MAN"
printf 'diff\t%s\t%s\n' "$(mkprompt diff 1 "$TMP/diff.ts")" "$TMP/diff.ts" >> "$MAN"
out="$(bash "$RUNNER" "$MAN")"
echo "$out" | grep -q 'RESULT schema OK' || { echo "FAIL a1"; exit 1; }
echo "$out" | grep -q 'RESULT diff OK' || { echo "FAIL a2"; exit 1; }

# (b) 一寫一不寫
rm -f "$TMP"/*.ts; : > "$CALLS"
MAN="$TMP/man_b.txt"
printf 'schema\t%s\t%s\n' "$(mkprompt schema 1 "$TMP/schema.ts")" "$TMP/schema.ts" > "$MAN"
printf 'diff\t%s\t%s\n' "$(mkprompt diff 0 "$TMP/diff.ts")" "$TMP/diff.ts" >> "$MAN"
out="$(bash "$RUNNER" "$MAN")"
echo "$out" | grep -q 'RESULT schema OK' || { echo "FAIL b1"; exit 1; }
echo "$out" | grep -q 'RESULT diff EMPTY' || { echo "FAIL b2"; exit 1; }

# (c) 冪等：目標預先非空 → 不呼叫 stub
rm -f "$TMP"/*.ts; : > "$CALLS"
printf 'exists' > "$TMP/schema.ts"
MAN="$TMP/man_c.txt"
printf 'schema\t%s\t%s\n' "$(mkprompt schema 1 "$TMP/schema.ts")" "$TMP/schema.ts" > "$MAN"
out="$(bash "$RUNNER" "$MAN")"
echo "$out" | grep -q 'RESULT schema OK' || { echo "FAIL c1"; exit 1; }
grep -q 'schema' "$CALLS" && { echo "FAIL c2 (stub called for pre-filled target)"; exit 1; }

# (d) keys 先跑
rm -f "$TMP"/*.ts; : > "$CALLS"
MAN="$TMP/man_d.txt"
printf 'schema\t%s\t%s\n' "$(mkprompt schema 1 "$TMP/schema.ts")" "$TMP/schema.ts" > "$MAN"
printf 'keys\t%s\t%s\n' "$(mkprompt keys 1 "$TMP/keys.ts")" "$TMP/keys.ts" >> "$MAN"
bash "$RUNNER" "$MAN" >/dev/null
head -1 "$CALLS" | grep -q 'keys' || { echo "FAIL d (keys not first)"; exit 1; }

echo "ALL PASS"
```

- [ ] **Step 2: 跑測試確認失敗**（腳本不存在）：`bash .claude/skills/module-factory/scripts/test-run-agy-batch.sh` → 非 `ALL PASS`（runner 不存在報錯）。
- [ ] **Step 3: 實作 run-agy-batch.sh**（**bash 3.2 相容**——macOS 預設 bash 3.2，agy review round 1 抓到四個 3.2 bug，此版全避開：不用 array `${arr[@]:-}`、不用 `wait -n`、read 帶 `|| [ -n ]` 收無尾換行的末行、用 temp 檔避開 pipe-subshell 讓計數器持續）：

```bash
#!/usr/bin/env bash
# run-agy-batch.sh MANIFEST — 段② 機械編排（Module Factory spec §3.1）。bash 3.2 相容。
# MANIFEST 每行: 格名<TAB>prompt檔<TAB>目標檔
# 職責：keys 格先跑(序列)；其餘以 MAX_PARALLEL(預設3)為批、每批整批 wait；
# 每格完成後檢查目標檔存在且非空 -> 印 RESULT <格名> OK|EMPTY；
# 已非空的目標檔跳過重派(冪等)。fallback 與 gate 不在此腳本(交給 Claude)。
# ARG_MAX 註：$AGY_CMD "$(cat prompt)" 把整份 prompt 當單一引數傳——這是 agy CLI 的真實
# 介面(-p 收字串,非檔路徑;本專案全程如此呼叫)。macOS 單引數上限 ~256KB，factory 的
# prompt(禁令+模板+契約報告,數十 KB)遠低於此；若某格 prompt 逼近上限,代表模板過肥、該拆,
# 不是靠腳本繞。
set -u
MAN="${1:?usage: run-agy-batch.sh MANIFEST}"
MAX_PARALLEL="${MAX_PARALLEL:-3}"
AGY_CMD="${AGY_CMD:-agy --model gemini-3.1-pro-high --mode accept-edits --print-timeout 15m -p}"

run_one() {
  local name="$1" prompt="$2" target="$3"
  if [ -s "$target" ]; then echo "RESULT $name OK"; return; fi
  $AGY_CMD "$(cat "$prompt")" >/dev/null 2>&1 || true
  if [ -s "$target" ]; then echo "RESULT $name OK"; else echo "RESULT $name EMPTY"; fi
}

keys_f="$(mktemp)"; rest_f="$(mktemp)"; trap 'rm -f "$keys_f" "$rest_f"' EXIT
# `|| [ -n "$name" ]` 收沒有結尾換行的最後一行（bash read EOF 會丟末行）
while IFS=$'\t' read -r name prompt target || [ -n "${name:-}" ]; do
  [ -z "${name:-}" ] && { name=""; continue; }
  case "$name" in
    *keys*) printf '%s\t%s\t%s\n' "$name" "$prompt" "$target" >> "$keys_f" ;;
    *)      printf '%s\t%s\t%s\n' "$name" "$prompt" "$target" >> "$rest_f" ;;
  esac
  name=""
done < "$MAN"

# keys 先跑（序列）；`done < file` 在當前 shell 執行，非 subshell
while IFS=$'\t' read -r name prompt target; do
  [ -z "$name" ] && continue
  run_one "$name" "$prompt" "$target"
done < "$keys_f"

# 其餘：每 MAX_PARALLEL 個一批、整批 wait（bash 3.2 無 wait -n；整批 wait 正確簡單）
count=0
while IFS=$'\t' read -r name prompt target; do
  [ -z "$name" ] && continue
  run_one "$name" "$prompt" "$target" &
  count=$((count+1))
  if [ "$count" -ge "$MAX_PARALLEL" ]; then wait; count=0; fi
done < "$rest_f"
wait   # 收最後不足一批的殘餘
```

- [ ] **Step 4: 跑測試確認通過**：`bash .claude/skills/module-factory/scripts/test-run-agy-batch.sh` → `ALL PASS`。此版在 bash 3.2 與 5.x 皆正確：keys 序列先跑（測試 d 的 head-1 恆為 keys）、rest 分批整批 wait、末行無換行也收得到、空 keys/rest 檔迴圈自然跳過（無 array unbound）。
- [ ] **Step 5: Commit**

```bash
git add .claude/skills/module-factory/scripts/
git commit -m "feat(factory): run-agy-batch.sh 機械編排（keys先跑/有界並行/檔案非空檢查/冪等）+ stub 測試"
```

---

### Task 2: SKILL.md 主流程

**Files:**
- Create: `.claude/skills/module-factory/SKILL.md`

**Interfaces:**
- Consumes: Task 1 的 `scripts/run-agy-batch.sh`（段② 呼叫）。
- Produces: skill 進入點，被 `Skill` tool 觸發。含 frontmatter（`name: module-factory`、`description:` 說明何時用——「把新增一個 be2 MCP action_type 自動化成三段流程」）。

- [ ] **Step 1: 寫 SKILL.md**——內容須涵蓋（每項都是 spec 的對應，不可省）：
  1. **frontmatter**：`name` + `description`（觸發語：新增 action_type / 接新 domain / module factory）。
  2. **三段流程圖**（= spec §2 的框圖，逐字搬）。
  3. **GATE 1 判定準則**（= spec §2.1，逐字）：授權 gate（executor-only PENDING、不 block 段②）vs 欄位 gate（item 欄位形狀未填實 → block 段②、絕不憑空補欄位）；判定看契約報告的「item 欄位形狀」欄是否填實。三個 gate 都用 `AskUserQuestion` 問人。
  4. **每段執行者分工表**（= spec §4）：段①Claude 探索+寫報告、段②agy 六格（Claude 編排 run-agy-batch.sh）+Claude subagent 對抗驗證、段③Claude ci/e2e/PR。
  5. **段② 呼叫方式**：組 manifest（六格 `名<TAB>prompt<TAB>目標檔`，各 prompt 由 references/stage2-produce.md 模板生成）→ `MAX_PARALLEL=3 bash scripts/run-agy-batch.sh manifest` → 讀 `RESULT ... OK|EMPTY` → 對 EMPTY 執行 fallback（重派一次帶強化禁令；仍 EMPTY 則 Claude 親自寫）→ conformance-verifier subagent → 一次 commit。
  6. **標的切換條件**：首發用 `shelf_toggle_bundle`（備援）；announcement 為真首發但欄位 TBD（指 `docs/be2-mcp/sit-announcement-contract.md` §6），欄位補齊即切回。
  7. 指向三個 references 檔（stage1/2/3）與契約報告模板。
- [ ] **Step 2: 結構檢查**：`grep -c 'GATE 1\|授權 gate\|欄位 gate\|run-agy-batch\|shelf_toggle_bundle\|AskUserQuestion' .claude/skills/module-factory/SKILL.md` → ≥ 6（六個關鍵詞都在）。
- [ ] **Step 3: Commit** `docs(factory): SKILL.md 主流程——三段三 gate、分工、標的切換`

---

### Task 3: stage1 探索模板 + 契約報告模板

**Files:**
- Create: `.claude/skills/module-factory/references/stage1-explore.md`
- Create: `.claude/skills/module-factory/references/contract-report-template.md`

**Interfaces:**
- Consumes: 既有 `docs/be2-mcp/sit-announcement-contract.md`（當契約報告的真實範本）。
- Produces: 段① 的三個探索 agent 指引 + 契約報告骨架。

- [ ] **Step 1: 寫 stage1-explore.md**——含：
  1. **輸入複製動作**（spec §1）：段① 第一步把外部輸入文件（如 `~/Downloads/ENDPOINTS.md`）複製進 `docs/be2-mcp/factory-input-<domain>.md`，之後引用指 repo 內副本。
  2. **三個探索 agent 的做法**（Claude 執行，非派 agy——spec §4：agy 跑不了 shell/瀏覽器）：
     - endpoint-prober：playwright 登入 SIT be2-220 → 開目標功能頁 → `browser_network_requests` 攔真實請求 → 抽 host/path/header/envelope。**憑證只落 `.env`、密碼經瀏覽器不進對話**（本 session 實證的 x-api-key 攔法）。
     - bundle-miner：curl 抓前端 bundle → grep businessKey/授權碼。
     - reference-reader：讀 `src/modules/product/*/` 四個現成 module → 判定新標的「最像哪個」→ 寫進契約報告的「參考格對照」。
  3. **GATE 1 產出**：契約報告；報告的「item 欄位形狀」欄與「未解 gate 項」欄決定 GATE 1 走向（引 contract-report-template.md）。
- [ ] **Step 2: 寫 contract-report-template.md**——骨架照 `docs/be2-mcp/sit-announcement-contract.md` 的七節結構（摘要/Host-Endpoint-Envelope/必要 header/businessList 碼/**item 欄位形狀**/未解 gate 項/onboarding 對應），每節留填空指引。**「item 欄位形狀」節**明列：list row 欄位、create body 必填、merge-vs-replace——這節填實與否是欄位 gate 的判定依據。
- [ ] **Step 3: 結構檢查**：`test -f` 兩檔且 `grep -q 'item 欄位形狀' contract-report-template.md` 且 `grep -q 'factory-input' stage1-explore.md`。
- [ ] **Step 4: Commit** `docs(factory): stage1 探索模板 + 契約報告模板（含欄位 gate 判定依據）`

---

### Task 4: stage2 六格模板 + stage3 驗收模板

**Files:**
- Create: `.claude/skills/module-factory/references/stage2-produce.md`
- Create: `.claude/skills/module-factory/references/stage3-verify.md`

**Interfaces:**
- Consumes: Task 1 run-agy-batch.sh、既有 `src/modules/product/shelfToggle/*`（六格參考範本）、`tests/core/moduleConformance.test.ts`（對抗驗證的檢查來源）。
- Produces: 段② 的六格 agy prompt 模板 + 段③ 驗收步驟。

- [ ] **Step 1: 寫 stage2-produce.md**——含：
  1. **禁令段（agy headless）**（spec §4，逐字）：只有唯讀 cat/ls/head/tail/grep/rg/find/wc/git status|log|diff|show；禁 mkdir/mv/cp/sed/npm/npx/tsc/vitest/git add|commit；檔案一律用內建編輯工具；prompt 不用「先 grep」誘導動詞；產物路徑明確；連兩次零產出該格 Claude 接手。
  2. **六格 prompt 模板**，每格註明**參考哪個現成格**（照 reference-reader 的判定；bundle 標的 → 全指 `shelfToggle/<同名檔>`）：
     - keys（先跑）、module（schema/authz/isItem/scopeOids/validate 組裝）、diff、executor、renderer、ui。
     - 每格模板留 `{{contract_report}}`、`{{reference_file}}`、`{{action_type}}` 佔位，由 SKILL.md 執行時填。
  3. **manifest 組法** + `run-agy-batch.sh` 呼叫 + EMPTY 格 fallback 流程（重派→Claude 接手）。
  4. **對抗驗證**：conformance-verifier subagent 的檢查清單（= 模組化歷次 review 抓的：hash 恆定、itemKey server/ui 同源、diff fall-through、per-type 判別一致），跑 `npm run ci` + 逐格挑「會不會騙過測試」。
  5. **授權 gate 的 executor 處理**：若 GATE 1 是授權 gate，executor 格產出骨架 + 標 `PENDING`（不對 SIT 跑真 200，同 3a）。
- [ ] **Step 2: 寫 stage3-verify.md**——驗收步驟（Claude 執行）：`npm run ci` 全綠 → `node scripts/build-ui.mjs` → registry exhaustive（moduleConformance 自動涵蓋）→ dev panel e2e（`BE2_MCP_DEV_PANEL=1` + playwright 驅動非寫入面，同本 session 彩排法）→ error-handling agent 補 403/500/stale/併發 executor 測試 → 開 draft PR（含契約報告、六格產物、e2e 紀錄）→ GATE 3。
- [ ] **Step 3: 結構檢查**：兩檔存在；`grep -q '連兩次零產出' stage2-produce.md`、`grep -q 'BE2_MCP_DEV_PANEL' stage3-verify.md`。
- [ ] **Step 4: Commit** `docs(factory): stage2 六格模板（禁令+參考格+對抗驗證）+ stage3 驗收模板`

---

### Task 5: Factory 首發完整跑——bundle 標的走三段（真實 e2e 驗證）

**Files:**
- Create: `docs/be2-mcp/factory-input-bundle.md`（輸入副本，= ENDPOINTS.md bundle 段）
- Create: `docs/be2-mcp/sit-bundle-contract.md`（段① 產物）
- Create: `src/modules/product/shelfToggleBundle/{keys,module,diff,executor,renderer}.ts`（段② 六格產物；bundle 無面板 → 無 ui.ts）
- Create: `tests/modules/shelfToggleBundle*.test.ts`（段② 隨格附測試）
- Modify: `src/core/changeset/types.ts`（ActionType union 加 `shelf_toggle_bundle`）、`src/modules/index.ts`（registerModule）、`docs/be2-mcp/module-catalog.md`

**Interfaces:**
- Consumes: Task 2-4 的 skill 定義；ENDPOINTS.md bundle 段（`GET/PUT /products/{prodOid}/bundle-package-configs`）；`shelfToggle/*` 六格當參考範本。
- Produces: 一個真實可用的 `shelf_toggle_bundle` module + 完整三段執行紀錄，**證明 factory skill 端到端能動**（agy review round 1：Task 5 原本只跑段①、未證段②/③，是比 spec §6「跑完整三段」還少的缺口）。

這個 task 是 **factory 的真實 e2e 驗收**：照 SKILL.md 完整跑三段對 `shelf_toggle_bundle`（Claude 編排、段② 派真 agy、非模擬）。

**段①（探索）：**
- [ ] **Step 1:** 把 ENDPOINTS.md bundle 兩行複製進 `docs/be2-mcp/factory-input-bundle.md`（含 host 表 + envelope 契約 + bundle 端點），照 stage1-explore.md 的「輸入複製動作」。
- [ ] **Step 2:** endpoint-prober：用 `.env` SIT token 直打 `GET https://api-gateway-220.sit.kkday.com/product/api/v1/products/34133/bundle-package-configs`，記錄 HTTP 200 + envelope（`meta.status 100000`）+ bundle row 欄位（is_active 等）。reference-reader：判定最像 `shelfToggle`。
- [ ] **Step 3:** 產 `docs/be2-mcp/sit-bundle-contract.md`（contract-report-template.md 七節）：**item 欄位形狀填實**（bundle row + PUT body `{is_active, modify_user}` 類比 shelfToggle）→ GATE 1 **無欄位 gate、無授權 gate**（gateway 可達、非 svc-b2c）→ 判定「可全六格產」。**GATE 1（AskUserQuestion）觸發一次**，人確認契約報告無 block 項。
- [ ] **Step 4: Commit** `docs(factory): 段① bundle 契約探索（欄位填實、無 gate）`

**段②（產，方案 A 六格 + 對抗驗證）：**
- [ ] **Step 5:** 照 stage2-produce.md 為六格（keys/module/diff/executor/renderer——bundle 無面板故不含 ui）組 prompt，各引 `shelfToggle/<同名檔>` 當範本 + `sit-bundle-contract.md` 契約；組 manifest → `MAX_PARALLEL=3 bash .claude/skills/module-factory/scripts/run-agy-batch.sh manifest`。
- [ ] **Step 6:** 讀 `RESULT ... OK|EMPTY`；對 EMPTY 格執行 fallback（重派帶強化禁令；仍 EMPTY 則 Claude 親寫）。改 `types.ts` union + `src/modules/index.ts` 註冊。
- [ ] **Step 7:** conformance-verifier（Claude subagent，對抗式）：跑 `npm run ci`，逐格挑「itemKey server/ui 同源、diffVersion 非恆定、schema 互斥、無 fall-through」。DATA sample 加進 `tests/core/moduleConformance.test.ts` 的 SAMPLES/DIFF_SAMPLES。
- [ ] **Step 8: GATE 2（AskUserQuestion）**：Claude 攤六格 diff + conformance 結果，人點頭。
- [ ] **Step 9: Commit** `feat(factory): 段② bundle module 六格產出（factory 首發真實產物）`

**段③（驗收）：**
- [ ] **Step 10:** `npm run ci` 全綠（新增 shelf_toggle_bundle 測試 + conformance）→ `node scripts/build-ui.mjs` → dev panel e2e：`BE2_MCP_DEV_PANEL=1` 起 server + playwright 對 34133 驗 bundle 讀取面（同本 session 彩排法；bundle 寫入若要 live 則同 shelfToggle 的 403 前例、可標 PENDING）。error-handling：補 bundle executor 的 403/500 測試。
- [ ] **Step 11:** 更新 `module-catalog.md` 加 `shelf_toggle_bundle` 條目（key 形狀、authz、executor 形狀、factory 首發標記）。
- [ ] **Step 12: GATE 3（AskUserQuestion）**：Claude 報告三段完成 + e2e 結果，人決定 merge。
- [ ] **Step 13: Commit** `feat(factory): 段③ bundle 驗收（ci/e2e 綠）+ catalog 登記；factory 端到端驗證完成`

**首發驗收成功定義**：`shelf_toggle_bundle` 註冊進 registry、conformance 自動繼承通過、`npm run ci` 全綠、dev panel 讀取面 e2e 通過、三個 GATE 各觸發一次且人可介入——**證明 factory skill 三段端到端可動**。

---

## Self-Review 紀錄

1. **Spec coverage**：§1 目標/輸入複製（Task 3 Step1 + Task 5 Step1）、§2 三段（Task 2 流程圖 + Task 5 完整跑三段）、§2.1 兩種 GATE 1（Task 2 Step1.3 + Task 3 模板「item 欄位形狀」節 + Task 5 Step3 實證無 gate）、§3 方案 A/對抗驗證（Task 4 Step1.4 + Task 5 Step5-7）、§3.1 run-agy-batch 職責邊界（Task 1，bash 3.2 相容）、§4 分工/禁令（Task 2 Step1.4 + Task 4 Step1.1 + Task 5 段②派 agy）、§5 載體決策（skill 形式本身）、§6 首發跑完整三段（Task 5，用備援 bundle 因 announcement 欄位 TBD）、§7 風險（run-agy-batch 檔案隔離 Task 1、對抗驗證 Task 4/Task 5 Step7）。無缺。
2. **Placeholder 掃描**：run-agy-batch.sh 與其測試是完整 bash（非佔位、bash 3.2 相容）；references 模板內的 `{{...}}` 是**模板設計的一部分**（factory 執行時填），非 plan 佔位——Task 4 Step1.2 說明。announcement 欄位 TBD 是**外部依賴**（memory 已記、首發改用 bundle 繞開），非 plan 內未完成項。
3. **型別一致性**：`run-agy-batch.sh MANIFEST`（格名<TAB>prompt<TAB>目標檔、`RESULT <名> OK|EMPTY`）在 Task 1 定義、Task 2 Step5 / Task 4 Step1.3 / Task 5 Step5 引用一致；`AGY_CMD`/`MAX_PARALLEL` 環境變數名一致；`shelf_toggle_bundle` action_type 命名在 Task 5 全程一致。

<!-- agy-peer-reviewed: 2026-08-18T12:58:04Z rounds=2 verdict=approved -->
