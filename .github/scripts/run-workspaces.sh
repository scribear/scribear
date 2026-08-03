#!/usr/bin/env bash
#
# Run an npm script across the affected workspaces, several at a time.
#
# The serial `for ws in ...; do npm run ... --workspace "$ws"; done` this
# replaces spent 151s on lint alone, because each of the 36 workspaces paid for
# its own ESLint process and its own type-aware TypeScript program while three
# of the runner's four cores sat idle. Peak RSS is ~1GB per workspace, so four
# at a time fits comfortably in the runner's 15.6GB.
#
# (Collapsing the whole thing into one root-level `eslint` invocation is the
# obvious alternative and does not work: holding 36 TS programs in a single
# process exhausts the V8 heap and dies with an OOM.)
#
# Output is captured per workspace and replayed in a stable order once
# everything finishes, so parallelism does not produce interleaved logs.
#
# Usage:  run-workspaces.sh <npm-script-name>
# Env:    WORKSPACES   JSON array of workspace paths (required)
#         IF_PRESENT   "true" to skip workspaces lacking the script
#         CONCURRENCY  how many to run at once (default: number of cores)

set -uo pipefail

SCRIPT_NAME="${1:?usage: run-workspaces.sh <npm-script-name>}"
CONCURRENCY="${CONCURRENCY:-$(nproc)}"
IF_PRESENT="${IF_PRESENT:-false}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

node -e "console.log(JSON.parse(process.env.WORKSPACES).join('\n'))" \
  > "$WORK_DIR/workspaces.txt"

if [ ! -s "$WORK_DIR/workspaces.txt" ]; then
  echo "No affected workspaces; nothing to do."
  exit 0
fi

run_one() {
  local ws="$1"
  local log="$WORK_DIR/${ws//\//__}.log"
  local -a args=(run "$SCRIPT_NAME" --workspace "$ws")
  [ "$IF_PRESENT" = "true" ] && args+=(--if-present)

  if npm "${args[@]}" > "$log" 2>&1; then
    return 0
  fi
  echo "$ws" >> "$WORK_DIR/failures.txt"
  return 1
}
export -f run_one
export WORK_DIR SCRIPT_NAME IF_PRESENT

echo "Running '$SCRIPT_NAME' across $(wc -l < "$WORK_DIR/workspaces.txt") workspace(s), ${CONCURRENCY} at a time"

xargs -a "$WORK_DIR/workspaces.txt" -P "$CONCURRENCY" -I {} \
  bash -c 'run_one "$@"' _ {}

# Replay the captured output in the order the workspaces were listed, so the
# log reads the same as it did when this ran serially.
while IFS= read -r ws; do
  echo "::group::$ws"
  cat "$WORK_DIR/${ws//\//__}.log" 2>/dev/null
  echo "::endgroup::"
done < "$WORK_DIR/workspaces.txt"

if [ -f "$WORK_DIR/failures.txt" ]; then
  echo "::error::'$SCRIPT_NAME' failed in: $(tr '\n' ' ' < "$WORK_DIR/failures.txt")"
  exit 1
fi
