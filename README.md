# Scholar Shelf — 本地文献架

DeepSeek Harness **Host 插件（bundle）**：给学术工作流加一层**断网也活的有状态记忆**。

与 [`@local/scholar-kit`](../../ModernBox-Guide/dsh-scholar-kit) 的分工：

| | scholar-kit（无状态核验核） | **scholar-shelf（有状态记忆层）** |
|---|---|---|
| 职责 | 联网：检索 / 核验 / 引文图谱 / OA 全文 | 本地：入架沉淀 / 离线检索 / 统计 / 导出引用表 |
| 断网时 | 部分降级（OpenAlex 类不可达时如实报警） | **完全可用** |
| 数据 | 每次调用即弃 | JSONL 持久化，只写本地、绝不上传 |

典型工作流：`scholar_search` 找到 → `scholar_verify` 核验 → **`scholar_shelf add` 入架**（带 `status`/`tags`/`note`）→ 写笔记时 `scholar_shelf export` 直接贴 Markdown 引用表。

## 工具：`scholar_shelf`

| op | 作用 | 关键参数 |
|---|---|---|
| `add` | 入架（upsert：同 DOI 或同标题 = 更新而非重复） | `title`（必填）、`doi`、`authors[]`、`year`、`venue`、`note`、`tags[]`、`status`（scholar_verify 的状态值） |
| `search` | 离线检索（标题/作者/期刊/备注/标签/DOI 子串匹配，不区分大小写） | `q`、`tag`、`yearFrom`、`yearTo`、`limit`(≤50) |
| `stats` | 总量 / 按年 / 按标签 / 按核验状态分布 | — |
| `export` | 导出引用表：`table`=Markdown（DOI 自动变链接）或 `tsv` | `format`、`limit`(≤500) |

非法入参**抛错并说清"什么错了/期望什么/怎么改"**；损坏行跳过并计入 `warnings`；写入用临时文件 + rename 原子替换；工具声明 `isConcurrencySafe:false`（写文件，串行）。

## 存储

- 默认：vault 内 `文献架/shelf.jsonl`（每行一条 JSON 记录，首条 add 时自动建目录）
- 覆盖：环境变量 `SCHOLAR_SHELF_PATH`（**测试必须覆盖**，勿污染真实书架）
- 记录结构：`title, doi, year, authors[], venue, note, tags[](小写), status, addedAt, updatedAt`
- upsert 键：有 DOI 用归一化 DOI（去 `https://doi.org/`、`doi:` 前缀、转小写），否则用小写标题；"传了 DOI 但同名记录尚无 DOI"视为合并（补 DOI）
- 合并语义：**字段级合并**——只有本次传入的字段被覆盖，未传字段保留（也因此不能用 add 清空字段；同键重传 `tags`/`authors` 数组为整体替换）

## 安装 / 卸载

```
plugin_manager install_bundle  → target: C:\Users\15437\Desktop\工作\tools\scholar-shelf
plugin_manager remove_bundle    → target: @local/scholar-shelf
```

> 首装即生效（全新 bundle，无模块缓存问题——见 kit README 的"代码改动何时生效"）。

## 测试

```powershell
node tools\scholar-shelf\test\smoke.mjs
```

完全离线：注册形状、Harness schema 子集、upsert/统计、检索/年份过滤、损坏行容忍、双格式导出、8 例非法入参。

## 局限（v1）

- 纯本地记忆：不做网络丰富化（DOI 补全元数据请先用 `scholar_verify` 拿到结果再入架）
- 单文件 JSONL，全量重写式更新（5 万条内无压力；更大规模应换 SQLite）
- `search` 设年份过滤时，缺年份的记录会被排除（按年份限定的语义）
- 未做并发写锁（工具已声明并发不安全，harness 会串行调用）
