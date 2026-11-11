# Changelog

## 0.5.0

- 首个 Marketplace 发行身份：TomMajor.sqlquay；MIT 许可，新增 PNG 品牌图标。
- 使用官方 vsce 和锁定开发依赖打包，附带可公开安装的只读查询策略；已有外置策略入口保留。
- 新增用户主动触发的本机旧版迁移：连接、SecretStorage 与当前工作区绑定；支持取消、回滚和分工作区导入，不执行查询或生成凭据文件。
- 随包策略在 AI Mode 部分启用失败时也尝试关闭；无法核实前导索引序号时拒绝查询。

## 0.4.0 — 2026-11-11

- Rename the visible product to **SQLQuay** and the VSIX artifact to `sqlquay`.
- Keep the installed extension ID, commands, settings keys and connection storage namespace.
- Use generic local policy paths; machine-specific policy packages stay outside the repository.
- Add a public-content check and GitHub CI for unit tests and Java 8-compatible packaging.
- Document Marketplace prerequisites and publishing steps.

## 0.3.1

- Preserve unexecuted SQL edits when pinning or updating an existing result.
- Resolve aliases inside functions and correlated subqueries; scope nested CTEs correctly.
- Complete fields when an alias has the same name as the database.
- Exclude JS/TS regular expressions from embedded SQL detection.

## 0.3.0

- Add independent result panels, pinning and in-memory session history.
- Add cached table and alias-field completion and table search.
- Show measured connection, preflight and execution timings.
- Support static SQL blocks in common host languages and selected pure SQL text.
