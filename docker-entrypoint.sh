#!/bin/sh
set -e

DATA_DIR="${DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR"
  # Docker preserves the host render node's numeric group. Add that group to
  # the unprivileged app user before gosu drops privileges, so an Unraid host
  # does not need to have the same render-group name/GID as this image.
  if [ "$(printf '%s' "${STREAMBOT_VIDEO_ENCODER:-}" | tr '[:upper:]' '[:lower:]')" = vaapi ]; then
    for render_device in /dev/dri/renderD*; do
      [ -e "$render_device" ] || continue
      render_gid=$(stat -c '%g' "$render_device")
      render_group=$(getent group "$render_gid" | cut -d: -f1 || true)
      if [ -z "$render_group" ]; then
        render_group="host-render-$render_gid"
        groupadd -g "$render_gid" "$render_group"
      fi
      usermod -aG "$render_group" node
    done
  fi
  exec gosu node "$@"
fi

exec "$@"
