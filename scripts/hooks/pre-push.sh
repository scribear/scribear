#!/usr/bin/env bash
set -euo pipefail

resolve_diff_base() {
  local upstream_ref=""
  if upstream_ref="$(git rev-parse --abbrev-ref --symbolic-full-name "@{upstream}" 2>/dev/null)"; then
    git merge-base HEAD "${upstream_ref}"
    return
  fi

  if git show-ref --verify --quiet refs/remotes/origin/main; then
    git merge-base HEAD refs/remotes/origin/main
    return
  fi

  git rev-list --max-parents=0 HEAD | tail -n 1
}

diff_base="$(resolve_diff_base)"
changed_files="$(git diff --name-only --diff-filter=ACMR "${diff_base}"...HEAD)"

if [[ -z "${changed_files}" ]]; then
  echo "pre-push: no changes to test"
  exit 0
fi

run_backend_node_tests=false
run_python_tests=false

while IFS= read -r file; do
  [[ -z "${file}" ]] && continue

  case "${file}" in
    apps/session-manager/*|libs/*|package.json|package-lock.json|tsconfig.base.json|eslint.config.js|prettier.config.js|vitest.config.ts|vitest.shared.ts|.npmrc|.editorconfig)
      run_backend_node_tests=true
      ;;
  esac

  case "${file}" in
    transcription_service/*)
      run_python_tests=true
      ;;
  esac
done <<< "${changed_files}"

if [[ "${run_backend_node_tests}" == "true" ]]; then
  echo "pre-push: running backend Node tests"
  npm run build --workspace @scribear/base-schema
  npm run build --workspace @scribear/session-manager-schema
  npm run build --workspace @scribear/base-fastify-server
  npm run build --workspace @scribear/session-manager
  npm run test --workspace @scribear/base-fastify-server
  npm run test --workspace @scribear/session-manager
fi

if [[ "${run_python_tests}" == "true" ]]; then
  echo "pre-push: running Python tests"
  (
    cd transcription_service
    make test
  )
fi

if [[ "${run_backend_node_tests}${run_python_tests}" == "falsefalse" ]]; then
  echo "pre-push: no matching tests for changed files"
fi
