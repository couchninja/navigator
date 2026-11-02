#!/usr/bin/env bash
set -uo pipefail

unit="navigator-wifi-restart-$(date +%s)"

sudo systemd-run \
  --unit="$unit" \
  --no-block \
  --description="Navigator WiFi off then on" \
  bash -c 'sleep 2; nmcli radio wifi off; sleep 2; nmcli radio wifi on'

echo "Scheduled WiFi restart ($unit). Expect this connection to drop in a few seconds."
