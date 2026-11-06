# 品退举报规则

来源：运营 2026-11-06 定的四条规则。实现都在
`~/shopdesk-workbench-src/src/appeal.js`（工作台仓库）。

## 四条规则

| # | 条件 | 处理 |
|---|---|---|
| ① | 有填写售后说明 | **待人工审核** |
| ② | 有说明 + 有图片 | **待人工审核** |
| ③ | 有说明 + **无图** + 说明**非常主观** | **自动提交** |
| ④ | 无售后说明 | **直接过滤，不举报** |

判定顺序：先 ④ 过滤，再看 ② 有没有图片，最后交给 AI 判 ③ 的"非常主观"，剩下的走 ①。

## 代码位置

| 位置 | 作用 |
|---|---|
| `screen()` | 只过滤「无说明」，其余（有说明的）全部进流程 |
| `processShop()` 品退分支 | `has_media` → 人工；否则调大模型判定 |
| `llmClassifyQuality()` | 判断说明属于 `very_subjective` / `specific_defect` / `uncertain` |
| `appeal-llm-quality-samples.json` | 人工标注的样例，喂给大模型做参考 |

自动提交的门槛：`verdict === 'very_subjective'` 且 `confidence >= 0.6`。
其余（含 `uncertain`、大模型调用失败）一律进人工队列 —— **宁可交人工，不瞎报**。

## 样例库（运营维护）

路径：

```
~/Library/Application Support/shopdesk/appeal-llm-quality-samples.json
```

格式，直接加条目即可，**不需要改代码也不需要重新构建**：

```json
[
  { "desc": "颜色不喜欢 不是宣传图上的那种紫色", "label": "very_subjective" },
  { "desc": "洗了一次就起球了，袖口还开线",   "label": "specific_defect" },
  { "desc": "质量不好",                     "label": "uncertain" }
]
```

- `label` 只能是 `very_subjective`（纯主观）/ `specific_defect`（具体缺陷）/ `uncertain`（说不清）
- 最多取前 30 条进提示词，**优先放容易判错、有争议的**
- 改完下一次运行就生效（每轮开始时读一次）

当前样例 13 条。实测判定 6/6 正确：

```
「颜色不喜欢 不是宣传图上的那种紫色」 → very_subjective 0.95
「尺码不合适，请求退货退款。」        → very_subjective 0.98
「显胖，不好看」                     → very_subjective 0.98
「洗一次就起球，袖口开线」            → specific_defect 0.98
「收到有破洞，面料有异味」            → specific_defect 0.98
「质量不好」                        → uncertain     0.95
```

## 几个边界

- **「质量不好」这类笼统说法判 `uncertain`**，走人工。因为它既可能是主观抱怨，
  也可能买家懒得写细节。定了这一条之后如果运营觉得太保守，改样例即可调整。
- **大模型不可用时全部走人工**，不会因为调用失败就放行自动提交。
- **「不能举报」不再等于永久拉黑**：先回平台查举报记录，已报过的记成"已提交"。
  之前把已报过的单当成"不可报"写进排除名单，导致重复提交被平台拒。
- 品退举报**一单一报、不可撤回**，所以自动提交只放"无图 + 非常主观"这一档。

## 已验证

```
秀水清依服饰旗舰店 订单 6919075752120102040
→ {"errno":0,"st":0,"msg":"success","code":0,"data":{"id":"111860808"}}
```
