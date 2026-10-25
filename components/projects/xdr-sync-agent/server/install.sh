#!/bin/sh
set -eu
SRC=${1:-/tmp/xdr-sync-candidate}
id xdrsync >/dev/null 2>&1 || useradd --system --home-dir /var/lib/xdr-sync --shell /bin/bash xdrsync
install -d -m 0750 -o xdrsync -g xdrsync /var/lib/xdr-sync /var/lib/xdr-sync/queue /var/lib/xdr-sync/incoming /var/lib/xdr-sync/state /var/lib/xdr-sync/failed /var/lib/xdr-sync/logs /var/lib/xdr-sync/data
install -d -m 0755 -o root -g root /usr/local/lib/xdr-sync
install -d -m 0755 -o root -g root /usr/local/lib/xdr-sync/vendor
python3 -m pip install --disable-pip-version-check --target /usr/local/lib/xdr-sync/vendor \
  --upgrade -r "$SRC/requirements-warehouse.txt"
install -m 0755 -o root -g root "$SRC/server/xdr_sync_server.py" /usr/local/lib/xdr-sync/xdr_sync_server.py
install -m 0644 -o root -g root "$SRC/server/paid_orders_warehouse.py" /usr/local/lib/xdr-sync/paid_orders_warehouse.py
install -m 0644 -o root -g root "$SRC/server/paid_orders_duckdb.py" /usr/local/lib/xdr-sync/paid_orders_duckdb.py
install -m 0644 -o root -g root "$SRC/shared/datasets.json" /usr/local/lib/xdr-sync/datasets.json
install -m 0755 -o root -g root "$SRC/server/xdr-syncctl" /usr/local/bin/xdr-syncctl
install -m 0755 -o root -g root "$SRC/server/xdr-sync-ssh" /usr/local/bin/xdr-sync-ssh
install -m 0755 -o root -g root "$SRC/server/uninstall.sh" /usr/local/lib/xdr-sync/uninstall.sh
for unit in "$SRC"/server/systemd/*; do install -m 0644 -o root -g root "$unit" "/etc/systemd/system/$(basename "$unit")"; done
install -d -m 0755 -o root -g root /etc/systemd/system/xdr-api.service.d
install -m 0644 -o root -g root "$SRC/server/xdr-api-paid-orders-duckdb.conf" \
  /etc/systemd/system/xdr-api.service.d/paid-orders-duckdb.conf
chown -R xdrsync:xdrsync /var/lib/xdr-sync/state /var/lib/xdr-sync/queue /var/lib/xdr-sync/incoming /var/lib/xdr-sync/failed /var/lib/xdr-sync/logs /var/lib/xdr-sync/data
runuser -u xdrsync -- /usr/local/bin/xdr-syncctl status --json >/dev/null
systemctl daemon-reload
systemctl enable --now xdr-sync-web.service xdr-sync-hourly.timer xdr-sync-spu-live.timer xdr-sync-paid-orders.timer xdr-sync-orders-daily.timer xdr-sync-finalize-sales.timer xdr-sync-profit-analysis.timer xdr-sync-shop-products.timer
systemctl restart xdr-sync-web.service
