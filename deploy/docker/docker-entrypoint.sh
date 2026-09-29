#!/bin/sh
set -eu
umask 077

if [ ! -e /data/config.json ]; then
  cp /opt/model-router/config.example.json /data/config.json
  echo 'Created /data/config.json; set public URLs and instance ID before exposing either listener.' >&2
fi

exec "$@"
