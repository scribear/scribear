#!/usr/bin/env bash
set -euo pipefail
export CI=1

staged_files="$(git diff --cached --name-only --diff-filter=ACMR)"

if [[ -z "${staged_files}" ]]; then
  echo "pre-commit: no staged changes to check"
  exit 0
fi

node_changed=false
run_python=false
node_files=()
eslint_files=()

while IFS= read -r file; do
  [[ -z "${file}" ]] && continue

  case "${file}" in
    apps/webapp/*|apps/session-manager/*|infra/scribear-db/*|libs/*|package.json|package-lock.json|tsconfig.base.json|eslint.config.js|prettier.config.js|vitest.config.ts|vitest.shared.ts|.npmrc|.editorconfig)
      node_changed=true
      node_files+=("${file}")
      ;;
  esac

  case "${file}" in
    transcription_service/*)
      run_python=true
      ;;
  esac

  case "${file}" in
    *.js|*.jsx|*.mjs|*.cjs|*.ts|*.tsx)
      case "${file}" in
        apps/webapp/*|apps/session-manager/*|infra/scribear-db/*|libs/*|eslint.config.js|vitest.config.ts|vitest.shared.ts)
          eslint_files+=("${file}")
          ;;
      esac
      ;;
  esac
done <<< "${staged_files}"

if [[ "${node_changed}" == "true" ]]; then
  echo "pre-commit: running Node format checks on staged files"
  npx prettier --check --ignore-unknown "${node_files[@]}"

  if ((${#eslint_files[@]} > 0)); then
    echo "pre-commit: running Node lint checks on staged files"
    npx eslint "${eslint_files[@]}"
  fi
fi

if [[ "${run_python}" == "true" ]]; then
  echo "pre-commit: running Python format/lint checks"
  (
    cd transcription_service
    make format
    make lint
  )
fi

if [[ "${node_changed}${run_python}" == "falsefalse" ]]; then
  echo "pre-commit: no matching checks for staged files"
fi
