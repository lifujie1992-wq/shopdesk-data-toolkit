# profit_facts 本地验收报告

- facts: `jushuitan-profit-facts/jst-profit-facts.sqlite`
- 结果：**PASS**（37/37 checks）

## 表行数

- `batch_runs`: 4
- `order_profit_facts`: 30706
- `shipment_package_items`: 30706
- `aftersale_events`: 72147
- `order_fee_ledger`: 265

## 校验结果

| Check                                             | Result | Detail                                                                           |
| ------------------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| `schema.columns.batch_runs`                       | PASS   | expected=10, actual=10                                                           |
| `schema.pk.batch_runs`                            | PASS   | expected=['batch_id', 'dataset'], actual=['batch_id', 'dataset']                 |
| `schema.columns.order_profit_facts`               | PASS   | expected=44, actual=44                                                           |
| `schema.pk.order_profit_facts`                    | PASS   | expected=['order_item_id'], actual=['order_item_id']                             |
| `schema.columns.shipment_package_items`           | PASS   | expected=29, actual=29                                                           |
| `schema.pk.shipment_package_items`                | PASS   | expected=['package_id', 'order_item_id'], actual=['package_id', 'order_item_id'] |
| `schema.columns.aftersale_events`                 | PASS   | expected=40, actual=40                                                           |
| `schema.pk.aftersale_events`                      | PASS   | expected=['as_event_id'], actual=['as_event_id']                                 |
| `schema.columns.order_fee_ledger`                 | PASS   | expected=33, actual=33                                                           |
| `schema.pk.order_fee_ledger`                      | PASS   | expected=['fee_record_id'], actual=['fee_record_id']                             |
| `pk.unique.batch_runs`                            | PASS   | rows=4, distinct=4                                                               |
| `pk.unique.order_profit_facts`                    | PASS   | rows=30706, distinct=30706                                                       |
| `pk.unique.shipment_package_items`                | PASS   | rows=30706, distinct=30706                                                       |
| `pk.unique.aftersale_events`                      | PASS   | rows=72147, distinct=72147                                                       |
| `pk.unique.order_fee_ledger`                      | PASS   | rows=265, distinct=265                                                           |
| `orders.row_key.coverage`                         | PASS   | source=30706, facts=30706, missing=0, extra=0                                    |
| `orders.item_paid_amount=base_amount`             | PASS   | mismatch=0                                                                       |
| `orders.cost_amount=sku_cost`                     | PASS   | mismatch=0                                                                       |
| `orders.channel=labels`                           | PASS   | mismatch=0                                                                       |
| `source.freight_price_share=sum freight_cost`     | PASS   | matched=25669/25669                                                              |
| `facts.package_fee_alloc=sum package_fee_total`   | PASS   | matched=25643/25643                                                              |
| `shipments.no_fake_package_id`                    | PASS   | fake=0                                                                           |
| `shipments.unassigned_marked`                     | PASS   | bad=0                                                                            |
| `aftersales.only_full-row-duplicates-removed`     | PASS   | source=72149, duplicate_excess=2, facts=72147                                    |
| `aftersales.single_item_actual_equals_order`      | PASS   | mismatch=0                                                                       |
| `aftersales.refund_status.independent`            | PASS   | mismatch=0                                                                       |
| `aftersales.as_item_id.non_null_unique`           | PASS   | rows=72147, distinct=72147                                                       |
| `aftersales.as_item_id.faithful_to_source`        | PASS   | source=72147, facts=72147, missing=0, extra=0                                    |
| `aftersales.refund_actual_conserved`              | PASS   | mismatch=0                                                                       |
| `aftersales.refund_alloc_method.enumerated`       | PASS   | methods=['item_even', 'item_proportional', 'order_level_single']                 |
| `aftersales.refund_actual_order_amount.preserved` | PASS   | distinct_order_level_amounts=1439                                                |
| `fees.no_product_refund_rows`                     | PASS   | refund_like_rows=0                                                               |
| `fees.marked_estimated`                           | PASS   | sources=['jst_sales_performance(店铺×日聚合)']                                        |
| `fees.not_order_level_claim`                      | PASS   | all current fee rows are shop_date aggregates                                    |
| `shipment.complete=false`                         | PASS   | package source not independently collected                                       |
| `fees.complete=false`                             | PASS   | finance ledger not independently collected                                       |
| `batch_runs.one-per-dataset`                      | PASS   | rows=4, expected=4                                                               |

## 关键统计

```json
{
  "counts": {
    "batch_runs": 4,
    "order_profit_facts": 30706,
    "shipment_package_items": 30706,
    "aftersale_events": 72147,
    "order_fee_ledger": 265
  },
  "channel": {
    "creator": 7619,
    "normal": 20211,
    "unknown": 2876
  },
  "cost_non_null": 30352,
  "refund_status": {
    "pending": 61827,
    "settled": 9974,
    "unknown": 346
  },
  "actual_refund_non_null": 72147
}
```
