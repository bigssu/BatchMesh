#!/bin/sh
# BatchMesh 실행 (macOS / Linux)
cd "$(dirname "$0")" || exit 1

command -v node >/dev/null 2>&1 || {
  echo "Node.js가 필요합니다. https://nodejs.org 에서 LTS 버전을 설치하세요."
  exit 1
}

[ -d node_modules ] || {
  echo "처음 실행이라 필요한 라이브러리를 설치합니다..."
  npm install || exit 1
}

(sleep 3; (command -v open >/dev/null && open http://localhost:3838) || (command -v xdg-open >/dev/null && xdg-open http://localhost:3838)) &

echo "BatchMesh 실행 중 — http://localhost:3838  (Ctrl+C로 종료)"
exec node server.mjs
