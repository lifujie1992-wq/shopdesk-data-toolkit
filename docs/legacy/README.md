# 旧资料（未迁移部分）

本目录只保留**文档**，不保留重复代码。

## 这里有什么

| 路径 | 内容 |
|---|---|
| `doudian-daily/README.md` | 抖店 11 步采集的完整说明（架构、字段状态分级、表结构） |
| `doudian-daily/docs/抖店接口清单.md` | 353 个抖店接口清单 |
| `doudian-daily/docs/抖店工作台-自建采集模块说明.md` | 工作台 GUI 采集模块说明 |
| `doudian-daily/metrics_contract.json` | 107 字段契约（状态/周期/来源/响应路径） |
| `profit-facts/README.md` `VALIDATION.md` | 利润事实库的口径与校验记录 |

## 代码去哪了

2026-10-25 那一版把 14 个组件的源码原样拷进了 `components/`，共 6.8 万行重复代码。
2026-11-06 的重构把它删掉了——聚水潭部分已经真正迁移到 `sources/jst/`，
抖店（Python）部分还没迁，代码仍在 git 历史里：

```bash
git show 1d1c7b0:components/doudian-daily/daily_collect.py
git show 1d1c7b0:components/projects/invoice-mac-agent/doc/      # 发票 V2 技术方案
git show 1d1c7b0:components/projects/douyin-settle-recon/doc/    # 月度账单实现方案
git ls-tree -r 1d1c7b0 --name-only | grep components/
```

阶段 5 迁移抖店侧时会把这些代码重新落地到 `sources/doudian/`，届时本目录逐步清空。
