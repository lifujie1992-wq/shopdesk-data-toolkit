#!/bin/bash
# 每日自动申诉：确保工作台运行 → 调用本机接口触发 auto_appeal_start
set -u
APP="/Users/zhaoxiaozhong/店铺工作台.app"
STATE="$HOME/Library/Application Support/shopdesk/agent-bridge.json"
REPORT_DIR="$HOME/Library/Application Support/shopdesk/appeal-reports"
LOG="$REPORT_DIR/daily.log"
mkdir -p "$REPORT_DIR"
say(){ echo "[$(date '+%F %T')] $*" >> "$LOG"; }

say "==== 每日自动申诉开始 ===="
# 同步云端：拉回人工确认（核对网页上确认的）并合并进本地队列
bash "$HOME/shopdesk-workbench-src/tools/sync-appeal-cloud.sh" >> "$LOG" 2>&1 || say "云端同步失败（忽略）"
if ! pgrep -f "店铺工作台.app/Contents/MacOS/店铺工作台" >/dev/null 2>&1; then
  say "工作台未运行，启动中…"
  open "$APP" 2>>"$LOG"
fi
for i in $(seq 1 30); do [ -f "$STATE" ] && break; sleep 2; done
if [ ! -f "$STATE" ]; then say "工作台未就绪，放弃本次"; exit 1; fi

port=$(/usr/bin/plutil -extract port raw -o - "$STATE" 2>/dev/null)
token=$(/usr/bin/plutil -extract token raw -o - "$STATE" 2>/dev/null)
case "$port" in ''|*[!0-9]*) say "端口无效"; exit 1;; esac
case "$token" in *[!0-9a-f]*|'') say "token 无效"; exit 1;; esac

payload="${SHOPDESK_APPEAL_PAYLOAD:-}"
# 全部进「人工核对」队列：每天定时获取+分析+填充，人工在核对页确认后下一轮才提交
if [ -z "$payload" ]; then payload='{"method":"auto_appeal_start","args":{"kinds":["quality","reviews"],"submit":true,"reviewQueue":true}}'; fi
resp=$(printf 'header = "Authorization: Bearer %s"\n' "$token" | \
  /usr/bin/curl --config - --silent --show-error --max-time 900 --noproxy '*' \
  --header 'Content-Type: application/json' --header 'X-ShopDesk-Client: cron' \
  --data-binary "$payload" \
  "http://127.0.0.1:$port/call" 2>>"$LOG")
say "触发申诉: $resp"
# 同步平台审核结果
resp2=$(printf 'header = "Authorization: Bearer %s"\n' "$token" | \
  /usr/bin/curl --config - --silent --show-error --max-time 900 --noproxy '*' \
  --header 'Content-Type: application/json' --header 'X-ShopDesk-Client: cron' \
  --data-binary '{"method":"appeal_sync_results","args":{"days":30}}' \
  "http://127.0.0.1:$port/call" 2>>"$LOG")
say "同步审核结果: $resp2"
say "（后台运行，结果见 appeal-reports/*.json；网页端 http://127.0.0.1 可看状态）"
# 评价明细采集（近30天全量，含好评/中评/差评），完成随数据一起上云
say "触发评价明细采集"
rjob=$(printf 'header = "Authorization: Bearer %s"\n' "$token" | \
  /usr/bin/curl --config - --silent --max-time 60 --noproxy '*' \
  --header 'Content-Type: application/json' \
  --data-binary '{"method":"start_collector","args":{"key":"builtin:review_details"}}' \
  "http://127.0.0.1:$port/call" 2>>"$LOG" | /usr/bin/python3 -c "import json,sys;print(json.load(sys.stdin).get('result',{}).get('id',''))" 2>>"$LOG" || true)
if [ -n "$rjob" ]; then
  for i in $(seq 1 60); do
    sleep 15
    st=$(printf 'header = "Authorization: Bearer %s"\n' "$token" | \
      /usr/bin/curl --config - --silent --max-time 60 --noproxy '*' \
      --header 'Content-Type: application/json' \
      --data-binary "{\"method\":\"get_collector_job\",\"args\":{\"id\":\"$rjob\"}}" \
      "http://127.0.0.1:$port/call" 2>>"$LOG" | /usr/bin/python3 -c "import json,sys;j=json.load(sys.stdin).get('result',{});print(j.get('status',''))" 2>>"$LOG" || true)
    [ "$st" = "done" ] || [ "$st" = "error" ] || [ "$st" = "failed" ] && { say "评价明细采集：$st"; break; }
  done
else
  say "评价明细采集触发失败"
fi

# 推送最新数据上云（核对网页立即可见）
bash "$HOME/shopdesk-workbench-src/tools/sync-appeal-cloud.sh" >> "$LOG" 2>&1 || say "云端推送失败（忽略）"
say "==== 触发完成 ===="
exit 0
