#!/usr/bin/env bash
# web-page-helper — 웹(IPv4) 바인딩으로 에디터 실행.
#
# 서버는 하나뿐이다: `tools/cli.mjs studio`. 이 스크립트는 그 서버를
# 0.0.0.0 에 묶어 LAN 에서 접속할 수 있게 하고, 접속 주소와 토큰을 보여준다.
#
#   ./run-web.sh                  현재 디렉터리, 빈 포트 자동 선택
#   ./run-web.sh ~/my-site        다른 프로젝트
#   ./run-web.sh -p 5000          포트 지정
#   ./run-web.sh --proxy http://127.0.0.1:8000
#   ./run-web.sh -t my-secret     토큰 고정
#
# 모든 인자는 `studio` 로 그대로 전달된다.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="0.0.0.0"
DEFAULT_PORT=4174
PORT=""
FORWARD=()

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -p|--port)   [[ -n "${2-}" ]] || { echo "✗ $1 값이 필요합니다" >&2; exit 2; }; PORT="$2"; shift 2 ;;
    -t|--token)  [[ -n "${2-}" ]] || { echo "✗ $1 값이 필요합니다" >&2; exit 2; }; FORWARD+=(--token "$2"); shift 2 ;;
    --proxy)     [[ -n "${2-}" ]] || { echo "✗ $1 값이 필요합니다" >&2; exit 2; }; FORWARD+=(--proxy "$2"); shift 2 ;;
    --browse-root) [[ -n "${2-}" ]] || { echo "✗ $1 값이 필요합니다" >&2; exit 2; }; FORWARD+=(--browse-root "$2"); shift 2 ;;
    -*)          echo "✗ 알 수 없는 옵션: $1" >&2; echo "  ./run-web.sh --help" >&2; exit 2 ;;
    *)           FORWARD+=(--root "$(cd "$1" 2>/dev/null && pwd || echo "$1")"); shift ;;
  esac
done

# 포트가 비어 있는지 확인한다. 점유되어 있으면 다음 번호로 넘어간다.
port_free() {
  ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

if [[ -z "$PORT" ]]; then
  for ((p = DEFAULT_PORT; p < DEFAULT_PORT + 50; p++)); do
    if port_free "$p"; then PORT="$p"; break; fi
  done
  if [[ -z "$PORT" ]]; then
    echo "✗ ${DEFAULT_PORT}~$((DEFAULT_PORT + 49)) 사이에 빈 포트가 없습니다" >&2
    exit 2
  fi
fi

# 접속 가능한 IPv4 주소를 모은다 (루프백 제외).
IPS=()
if command -v ip >/dev/null 2>&1; then
  while read -r ip; do [[ -n "$ip" ]] && IPS+=("$ip"); done \
    < <(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1)
elif command -v ifconfig >/dev/null 2>&1; then
  while read -r ip; do [[ -n "$ip" ]] && IPS+=("$ip"); done \
    < <(ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -v '^127\.')
fi

echo "· 프로젝트  ${FORWARD[*]:-현재 디렉터리}"
echo "· 바인딩    ${HOST}:${PORT} (IPv4)"
if [[ ${#IPS[@]} -gt 0 ]]; then
  echo "· 접속 가능 ${IPS[*]}"
else
  echo "! 외부 IPv4 인터페이스가 없습니다 — 이 PC에서만 접속됩니다"
fi

# 실제 서버는 하나뿐이다. 토큰 생성과 주소 출력은 CLI가 담당한다.
exec node "$ROOT/tools/cli.mjs" studio --host "$HOST" --port "$PORT" "${FORWARD[@]}"
