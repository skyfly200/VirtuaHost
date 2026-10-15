#!/usr/bin/env bash
# Tiny wrapper for RadioDJ's REST Server plugin (Windows localhost:8080). Password is read from a private file.
# Usage: radiodj_api.sh cmd <Command> [arg]    e.g. cmd EnableAutoDJ 1 | cmd PlayCartByNumber 5 | cmd ClearPlaylist
#        radiodj_api.sh np | npjson | playlist
set -euo pipefail
pw=$(cat "$HOME/.config/radiodj/rest-pass")
base="http://127.0.0.1:8080"
curl=/mnt/c/Windows/System32/curl.exe
case "${1:-}" in
  cmd) "$curl" -sS -m 10 --get "$base/opt" --data-urlencode "auth=$pw" --data-urlencode "command=${2:?command}" --data-urlencode "arg=${3:-}" ;;
  np) "$curl" -sS -m 10 "$base/np?auth=$pw" ;;
  npjson) "$curl" -sS -m 10 "$base/npjson?auth=$pw" ;;
  playlist) "$curl" -sS -m 10 "$base/p?auth=$pw" ;;
  *) echo "usage: $0 cmd <Command> [arg] | np | npjson | playlist" >&2; exit 2 ;;
esac
echo
