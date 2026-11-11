# 第一阶段：Database Client 9.0.2 交互分析与独立实现（历史记录）

对照目标是 Marketplace 发布的 `cweijan.vscode-database-client2` 9.0.2。新项目采用独立的 VS Code 扩展 ID `local-workbench.database-workbench`，自行编写扩展宿主、JDBC 桥接、表单与结果页。原版代码、资源和授权逻辑不进入项目或 VSIX。

## REA 发现和采用方式

| 链路 | 原版观察 | 第一阶段的实现 |
| --- | --- | --- |
| 连接 | Webview 发 `init`；提交 `connecting` 携带配置与 `saveOnly`。保存和测试连接是两个动作。离线重放可见名称、分组、类型选择、主表单和操作按钮。 | 保留这套表单布局与 Save / Connect 区分；只放已支持的 MySQL、Doris / SelectDB 类型。 |
| 对象树 | 原版使用原生 `createTreeView`，Provider 区分根连接与节点子项，节点展开状态由宿主维护。 | 使用原生 TreeView 的连接分组、连接、数据库、Tables、表与字段。真实表和字段由用户明确触发加载。 |
| SQL 执行 | 优先使用编辑器绑定；支持选区、光标语句及全文。请求经宿主处理后调用驱动，再分发结果。 | 保留选区、光标执行和快捷键；执行前确认绑定未被编辑或删除。为只读预检，每次只执行一条。 |
| 结果 | 同一面板可复用。顶部是 SQL 和工具栏，`RUN`、`DATA`、`ERROR` 驱动状态；原版的下一页与总数操作能再查库。 | 复用面板，保留 SQL、工具栏、状态和紧凑表格。筛选、排序和翻页只处理已返回的行；不重新发 SQL。 |

原版 Webview 以公开包中的原文件离线渲染，宿主 `DATA` 用合成行重放。原版连接时序和对象树调用来自静态包分析，未在原版桌面扩展中连接数据库。SQL 链复用上一轮有效的 REA 静态证据，这次补查连接表单和树：

原始分析记录、重放脚本和原插件资源仅保留在本机分析环境，不随仓库和 VSIX 分发。

## 验收

- 用打包产物在独立 VS Code 扩展宿主启动：打开连接窗口，从离线 Demo 打开绑定 SQL 编辑器；运行光标语句和选区并验证结果数据；读取 Demo 表结构；复用同一个结果面板。
- 用实际生成的 Webview 页面验证连接表单、错误反馈、结果过滤、排序、翻页、复制、重跑和陈旧结果隔离；检查宽窗口深色与窄窗口浅色的渲染。[连接表单](previews/connect.png) · [深色结果页](previews/result.png) · [浅色结果页](previews/result-light.png)
- 通过不联网的 JDBC 测试驱动验证真实 Java/Python 桥接、TLS 配置参数、前导索引与 EXPLAIN 阻断、Doris 内部扫描识别、重复列名、长整数、NULL 和超时状态。真实端点连通性和耗时尚未测试。

`npm test` 跑轻量测试；`node test/jdbc-fixture.cjs` 跑离线 JDBC 链（需要 JDK、Python 和本机共享预检脚本）。`test/extension-host.cjs` 是 VS Code `--extensionTestsPath` 入口，结果写入 `DBW_HOST_RESULT`。Webview 回归脚本 `test/webview-fixture.cjs` 需要 Playwright，可通过 `DBW_PLAYWRIGHT` 与 `DBW_CHROME` 指向已有安装。

阶段二在宿主查询入口增加 DMS 后端，沿用连接选择、绑定和结果协议。第一阶段不做生产写入、导出、服务端分页、多数据库驱动或 SSH/代理配置。
