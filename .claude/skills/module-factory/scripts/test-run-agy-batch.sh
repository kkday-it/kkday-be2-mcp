#!/usr/bin/env bash
# test-run-agy-batch.sh — self-contained, no real agy. 純 bash 斷言。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNNER="$HERE/run-agy-batch.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
CALLS="$TMP/calls.log"; : > "$CALLS"

# stub agy：runner 呼叫 $AGY_CMD "$(cat promptfile)"，故最後一個參數 = prompt 內容；
# stub 靠 prompt 內容的 marker 找目標檔與 WRITE 旗標
cat > "$TMP/stub-agy.sh" <<'STUB'
#!/usr/bin/env bash
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

mkprompt() { # name write target -> prompt 檔路徑
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
