#!/usr/bin/env bash
# sekimori 検証ゲート — 全チェックを束ねて合否を返す
# 使い方: .claude/verify.sh  (exit 0 = 全緑)
set -u
cd "$(dirname "$0")/.."

fail=0
run() {
  local label="$1"; shift
  echo "=== $label ==="
  if ! "$@"; then
    echo "FAILED: $label"
    fail=1
  fi
}

# lockfile / package.json の drift は CI の最初のゲート — local verify でも先に止める。
run "install (frozen-lockfile)" pnpm install --frozen-lockfile
# build を最初に置く — workspace パッケージ間の import（doctor → sekimori/semconv 等）は
# dist 経由で解決するため、clean clone では build しないと type-check が通らない。
run "build"           pnpm run build
run "type-check"      pnpm run type-check
run "ci (biome)"      pnpm run ci
run "check-exports"   pnpm run check-exports
run "probe:synth"     pnpm run probe:synth
# coverage が unit test を兼ねるため `pnpm run test` は別途回さない（2 重実行の節約）。
run "test:coverage"   pnpm run test:coverage

if [ "$fail" -eq 0 ]; then
  echo "=== VERIFY: PASS ==="
else
  echo "=== VERIFY: FAIL ==="
fi
exit "$fail"
