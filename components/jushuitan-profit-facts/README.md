# jushuitan-profit-facts

Mac 端「单款实际利润」事实归一化器。当前阶段只生成本地 SQLite 并校验，尚未接入生产 xdr-sync-agent、历史回填或每日任务。

## 构建

```bash
python3 build_facts.py \
  --orders ~/jst-order-item-details.sqlite \
  --aftersales ~/jst-aftersales.sqlite \
  --inventory ~/jst-inventory-full-second.sqlite \
  --purple ~/jst-purple-orders.sqlite \
  --sales ~/jst-sales-performance.sqlite \
  --output ./jst-profit-facts.sqlite
```

窗口更新必须保留历史基线：

```bash
python3 build_facts.py ... \
  --output ./jst-profit-facts.sqlite \
  --merge-existing ./jst-profit-facts.sqlite
```

## 校验

```bash
python3 verify_facts.py \
  --facts ./jst-profit-facts.sqlite \
  --orders ~/jst-order-item-details.sqlite \
  --aftersales ~/jst-aftersales.sqlite \
  --schema ~/xiangduoer-profit-facts/contract/profit_facts.schema.json \
  --report ./VALIDATION.md
```

当前全量本地验收结果：31/31 checks 通过。

`bin/jst-profit-facts` 已提供 xdr-sync-agent 适配命令：`login-status`、`export-sqlite`。它只归一化已有本地快照，不负责重新打开聚水潭页面；生产任务接入后仍需先完成源快照的近 7 天采集验证。

- `order_profit_facts`: 30,706
- `shipment_package_items`: 30,583（`l_id` 骨架，`complete=false`）
- `aftersale_events`: 72,147（源 72,149，去除 2 行逐列全同重复）
- `order_fee_ledger`: 265（店铺×日聚合，`estimated`，非订单级流水）

关键口径：`base_amount`、`sku_cost`（0 输出 null）、`labels` 含“精选联盟”、售后 `asiId` 稳定键、申请/实际退款分离；商品退款不进入费用表。
