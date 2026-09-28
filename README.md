# 多语言内容制作平台（第一版）

源文更新时保留译文与上下文的双栏编辑平台：React 编辑页 + Python 内容版本服务。
支持段落拆分、合并、人工对应；术语库与审核流程为后续预留。

## 核心原则

- **段落身份不可变**：每个段落有稳定 `id`，拆分/合并后旧段落标记 `retired` 保留，新段落通过 `origin` 溯源；保存、撤销、导出全程携带身份。
- **挪动不废译文**：源文仅位置变化（文本相同）时标记“已挪动”，沿用原对应分组，译文原样保留。
- **实质改动报范围**：源文内容变化时标记“已改动”，报告受影响的译文段落；旧译文进入 `conflict` 对应组，不自动作废。
- **冲突人工裁决**：人工对应产生歧义时新组标记为冲突，用户选择“保留新对应”或“撤回（译文保留）”，系统绝不静默丢弃旧译文。
- **页面与导出一致**：编辑器行序与 JSON/TXT 导出都由同一份配对算法生成（后端 `mlcp/pairs.py` ↔ 前端 `src/lib/pairs.ts`）。

## 目录结构

```
backend/
  mlcp/
    model.py       # Document / Segment / LinkGroup / Revision 数据模型
    alignment.py   # 拆分、合并、人工对应、冲突处理、源文更新对齐
    pairs.py       # 唯一配对算法（页面与导出共用）
    history.py     # 版本快照与撤销（操作前固化快照）
    export.py      # JSON / TXT 导出
    store.py       # JSON 持久化
    server.py      # 标准库 HTTP API（零第三方依赖）
  tests/           # pytest 验收测试
frontend/
  src/
    lib/pairs.ts   # 与后端逐行对应的配对算法
    components/    # 双栏表格、工具栏、更新对话框、冲突操作
    store.ts       # zustand 状态
    api.ts         # API 封装
```

## 启动

```bash
# 后端（Python 3.10+，无第三方依赖；测试需要 pytest）
cd backend
PYTHONPATH=. python -m mlcp.server --port 8000

# 前端
cd frontend
npm install
npm run dev      # http://localhost:5173 ，/api 已代理到 8000
```

## 测试

```bash
cd backend && python -m pytest        # 8 个用例：挪动/改动/冲突/拆合回环/撤销/端到端
cd frontend && npx vitest run         # 配对算法拆合回环一致性
cd frontend && npx tsc --noEmit       # 类型检查
```

其中“拆段后再次合并”的文稿在 `test_split_then_merge_roundtrip_keeps_target`
与前端 `pairs.test.ts` 中检查：页面 `build_pairs` 与导出 `export_json`
对每一行的源段 id、译文 id、状态完全一致。

## 操作说明

- 勾选段落：点行首复选框（支持跨段多选）。
- 拆分：只勾选一侧一段 → “拆源段/拆译段”，按行输入片段；对侧译文整段保留为 1:N 对应。
- 合并：勾选同侧相邻多段 → “合源段/合译段”；拆后再合并时 `origin` 指回祖先。
- 人工对应：两侧各选至少一段 → “人工对应”；若覆盖到第三方段落则生成冲突组。
- 源文更新：工具栏“源文更新…”粘贴新文稿（每行一段）→ 顶部显示挪动/改动/新增/缺失范围与受影响译文。
- 撤销：每次修改前自动固化快照，撤销回到操作前，段落身份随之恢复。
- 导出：JSON 每行含 `source_ids` / `target_ids` / `group_id` / `state`；TXT 为同序双栏。

## 后续预留

- 术语库：按语言对挂载到 LinkGroup，改动段落自动标术语待确认。
- 审核流程：Revision 上增加提交/审校/发布状态，冲突组进入审核队列。
