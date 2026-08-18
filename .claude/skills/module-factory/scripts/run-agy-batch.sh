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
