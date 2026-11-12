# Changelog

## 0.8.0

- 实库兼容 Tablestore 的表清单列顺序及原生 `ENGINE=Tablestore` DDL；仅已核实的 OTS 连接开放该定义，凭据和其它外部引擎检查保留。

- DMS 按实例 → 数据库 → 表组织；支持 MySQL/RDS、PolarDB MySQL、SelectDB/Doris、PolarDB-X/DRDS 和 Tablestore 的实例发现。生产、测试、开发、预发与其它 DMS 环境均可选择，实例和库列表可分页。
- DRDS 使用独立的单分片及底层扫描计划预检，保留源库 10 万行阈值、前导索引检查与受控超时。Tablestore 按确认范围只开放 SQL 映射表列表、字段和真实 DDL，数据查询与预览继续拒绝。
- AccessKey 表单的“保存并打开”仅保存已核实的配置，不再遍历所有库；展开当前库时加载表，缓存命中不重复读取，加载失败可显式刷新。JDBC 与高级 profile 的连接检查仍保留。
- 与受控 CLI 共用工作站查询锁，同时兼容 0.7 客户端的旧锁；独立 AK 认证保持隔离。新增元数据不改已有连接 ID、修订号和文件绑定，无自动迁移。

## 0.7.2

- 已添加的 DMS 库可通过右侧 × 或取消勾选移除，保存后生效，并提示受影响的文件绑定。
- 保留 AK 与其它库的身份及缓存；允许移除全部库后保留空连接，随后复用认证添加。重新添加使用新目标 ID，旧绑定不会自动恢复或切库。
- 原追加调用继续保留未明确移除的库；保存失败保持原配置。

## 0.7.1

- 修复 DMS 查找后 AK/Secret 输入框被清空的问题；连续搜索、多选、取消选择及保存失败时保留掩码，成功保存或关闭表单后释放临时输入。
- 相同 AK 的连续搜索与最终保存复用验证状态；更换 AK 仍清除旧验证，保留各库目标核对与只读安全检查。

## 0.7.0

- 一套 AccessKey 的 DMS 连接可搜索、多选并保存多个数据库；多次搜索保留选择，之后可从连接右侧或右键“添加数据库…”继续追加。
- AK 只保存一份，侧栏按连接和数据库展开；执行、DDL、补全、预览和历史仍绑定精确库及 Database ID，各库缓存独立。
- 追加保留已有目标 ID、修订号和文件绑定。原 JDBC、CLI profile 与单库 DMS 不自动改写；旧单库 AK 可主动追加。保存失败回滚凭据，全部只读预检与全机锁保持。

## 0.6.1

- DMS 的搜索与选库合并为一个“数据库”可搜索选择框，不再重复填写库名；支持回车查找和键盘选择，自动保留 Database ID。
- 移除连接页不可点击的“配置 / 基本”假页签，只读状态移至标题旁；中英文同步调整。
- 已有 CLI profile 的自定义查找名称收进高级匹配设置，原连接、凭据和文件绑定保持。

## 0.6.0

- 新建 DMS 默认使用独立 AccessKey：提供 RAM 控制台入口、密钥填写和搜索选库，自动带出 Database ID 与缺省连接名。
- AccessKey 仅保存到 VS Code SecretStorage；通过标准输入交给本地执行器，仅 CLI 子进程获得临时凭据环境，AI-Mode 状态使用独立临时目录。不复用既有 AI/CLI 凭据配置。
- 旧 profile 认证保留为高级方式，原连接及 JDBC 保持；普通查询、悬停、数据预览继续执行只读、扫描预检、单查询锁和超时不重试。

## 0.5.2

- 界面自动跟随 VS Code 显示语言，支持简体中文和英文；其他语言回退英文，无需独立语言设置。
- 统一连接表单、命令菜单、设置说明、DDL 悬停、结果表格、会话历史与常见提示文案；连接名称、SQL、查询数据及安全检查保持原样。

## 0.5.1

- DMS 支持选择本机已有的 CLI profile 和 region，提供本机认证指引；不收集 AccessKey、不自动执行认证或切换默认 profile。旧连接保留原身份。
- 旧版迁移支持选择并追加缺少的连接，不再要求新版连接清单为空；已有 DMS、凭据、绑定和查询锁保留。

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
