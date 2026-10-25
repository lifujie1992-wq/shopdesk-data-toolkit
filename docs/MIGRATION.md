# 新机迁移与验收

## 1. 准备环境与复制源码

目标是 macOS。建议 Node.js 24（内置 SQLite）、Python 3.12、uv、SSH，以及已安装的店铺工作台。完整 App、登录会话和密钥不在 Git 中。

```sh
git clone <本仓库地址> shopdesk-data-toolkit
cd shopdesk-data-toolkit
python3 tools/toolkit.py verify
python3 tools/toolkit.py prepare          # 预览，任何同名目录/命令都阻止迁移
python3 tools/toolkit.py prepare --apply  # 只复制，不运行采集、不启用定时任务
export PATH="$HOME/.local/bin:$PATH"
```

也可 `--home /独立目录` 试装，适合检查文件布局。该选项只改变复制目标；Python/Node 的 `homedir()` 仍读当前登录用户目录，所以独立目录试装不等于已具备真实运行环境。

工具恢复 `~/doudian-daily`、`~/jushuitan-*`、`~/shopdesk-workbench-src`、`~/projects/*`，并建立 `~/xdr-sync-agent` 兼容链接和 `~/.local/bin/` 中的 CLI 链接。用户名硬编码路径会按目标目录替换。其他固定服务器地址保留原快照值，使用前检查。

## 2. 安装依赖

Node CLI 多数只用内置模块。店铺工作台如需重新构建，先在其目录执行 `npm install`，再 `bash build.sh --no-install`。完整 Electron App 底座仍需另行安装。`build.sh` 不带参数会部署并重启 App，应在安排好的维护时间执行。

```sh
# 独立采集脚本；执行它们时使用该虚拟环境的 Python
uv venv "$HOME/.venvs/shopdesk-legacy" --python 3.12
uv pip install --python "$HOME/.venvs/shopdesk-legacy/bin/python" -r requirements.txt

cd "$HOME/projects/xdr-sync-agent"
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python -r requirements-excel.txt -r requirements-warehouse.txt

cd "$HOME/projects/douyin-commission-rates"
uv sync --extra dev
cd "$HOME/projects/douyin-settle-recon"
uv sync --extra dev
```

退款 Excel 导入需要 `fastexcel`（见 XDR 的 Excel 依赖），利润事实构建也依赖相应 Python 数据处理库。旧定时任务使用 `/usr/bin/python3`，不会自动使用新虚拟环境；启用前须将任务的解释器换为安装依赖的 Python。不要仅安装到 `.venv` 就假定旧 plist 已能运行。

## 3. 登录与配置

1. 安装并打开店铺工作台，各店分别扫码登录。源码快照含 Bridge、探索池和财务扩展，但实际安装的 App 必须具备对应版本能力。财务扩展安装入口是月账单项目的 `tools/install_shopdesk_extension.py`；先看其 README。
2. 抖店脚本读取 `~/Library/Application Support/shopdesk/shops.json` 及各会话分区。Bridge 元数据为同目录 `agent-bridge.json`，它是 JSON 且包含令牌，不应复制进 Git。
3. 聚水潭需要 Chrome 中本人登录、OpenBridge daemon 和扩展可用；安装地址从原 OpenBridge 项目/安装渠道取得。按 `jst-inventory` README 导入 Keychain 登录态。需要真实页面的任务仍要求 Chrome + OpenBridge 运行。
4. 自行配置 SSH 身份文件及服务器账号。云端连接示例为仓库的 `config/xdr-config.example.json`，填好后保存到 `~/.config/xdr-sync-agent/config.json`，限制为 0600。若维护独立 profit-facts worker，也要给它设置独立状态目录及任务过滤；不要直接启动两个使用同一默认配置的 worker。
5. 飞鸽发布等项目会复用 XDR 的连接配置；它们可能需要额外云端写权限。按照各模块 README 配置，不要仅凭 SSH 可连接就认为所有数据集已授权。
6. 售后 HTTP API：复制组件的 `config/config.env.example` 到 `~/.config/aftersale/env`，填 URL、Token 等并设为 0600。发票代理的配置见 `invoice-mac-agent/config.example.json`，保存到 `~/.config/invoice-mac-agent/config.json`，先用 `dry-run`。
7. 中差评 MySQL：用 `config/mysql.env.example` 配置环境变量并在运行前加载。仓库版不再内置生产密码，缺少 `SHOPDESK_MYSQL_PASSWORD` 时拒绝写库。launchd 不读取交互 shell 的变量，须为该任务另行提供本机环境配置。
8. 佣金项目 `config/daily.json` 是部署配置，未收录。复制 `daily.example.json` 后填写目标与映射；真实 `data/shop-mappings.json` 应由本机重新规划和核实。不要拿空示例代替已核实的生产映射。
9. 月账单需要将获授权的原始空白模板放到 `~/projects/douyin-settle-recon/doc/【抖音】月度账单处理模版.xlsx`，并配置其上传账号与费用映射。模板和历史样例未进入仓库；不能用任意新建空 Excel 替代。
10. 如需飞书通知，按原模块要求在本机配置 `alert-webhook.json`。仓库只保留读取逻辑及测试用假地址。

## 4. 单模块验收

先做离线测试和文件检查，再按业务需要选一店进行真实验收。下列采集命令会访问实际平台，但不应在未经配置的新目录中盲目执行。

```sh
python3 tools/toolkit.py doctor
jst-inventory login-status
jst-orders login-status
jst-sales login-status
jst-order-page login-status
node "$HOME/projects/feige-customer-daily/collect.mjs" --list-shops
"$HOME/.venvs/shopdesk-legacy/bin/python" "$HOME/doudian-daily/daily_collect.py" --list
# 飞鸽单店采集，先只写本机
node "$HOME/projects/feige-customer-daily/collect.mjs" --shop-id '<店铺ID>' --local-only
```

确认原始行数、日期范围、业务身份、完整性状态及本地输出，再验证该模块的云端发布。飞鸽/XDR 的快照与ACK逻辑、月账单的归档与下游同步状态各有定义，进程退出0不等于所有数据已正确入云。

## 5. 定时任务

```sh
python3 tools/toolkit.py render-schedules --output /tmp/shopdesk-schedules
```

该命令只生成待审核 plist，不安装、不加载。`docs/schedules.json` 记录采集时看到的调度。模板不包含原任务的环境变量；需在本机补齐配置文件位置、Python路径、工作目录、权限和互斥关系。

先选需要的数据采集任务逐项部署。申诉提交、发票 PDF 回传、云端自动拉取作业及 autodeploy 会执行实际业务操作；开发机不应直接批量加载整套定义。尤其 autodeploy 沿用原仓库策略，可能重置其工作目录；启用前必须改好来源与分支。原生产机与新电脑不能未经协调同时消费相同提交队列。

`runtime-wrappers/` 在迁移时只复制到 `~/shopdesk-runtime-wrappers`。按需审核后再放入工作台数据目录；迁移工具不会覆盖工作台的当前运行脚本。
