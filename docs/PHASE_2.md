# 第二阶段：JDBC 与 DMS 共用工作台

在同一张 **New Connection** 表单里选择 [JDBC](previews/connect-jdbc.png) 或 [DMS](previews/connect-dms.png)。两种方式共享表树、绑定 SQL 编辑器、结果面板和本地结果操作。0.1.0 已存 JDBC 连接没有方式字段，0.2.0 按 JDBC 读取，并沿用原连接 ID 和 SecretStorage 键。

DMS 仅调用已批准的 `execute_safe.py`；插件检查用 `aliyun plugin list`。固定 `dms-prod`、目标解析、AI Mode 生命周期、扫描预检和超时处理由封装器负责。现行封装器只接受 `product` 环境。连接配置没有 DMS 账号、密码或 profile 选择；没有原始 CLI SQL、浏览器、自动降级或额外的无条件表数据预览入口。

## 验收

- `npm test`：旧 JDBC 配置与 SecretStorage 键仍可用；DMS 新建、读结构、执行及 JDBC 切换复用同一结果面板；DMS 停止后无法切 JDBC 继续。
- `node test/dms-fixture.cjs`：以离线模拟的 Aliyun CLI 驱动本机批准封装器的副本，覆盖固定 profile、精确目标、产品/测试环境区分、预检拒绝、超时不重试及 AI Mode 关闭。未连接真实 DMS。
- `node test/jdbc-fixture.cjs`：验证原 JDBC 预检和桥接链路。
- Webview 离线验证两种表单、隐藏字段提交隔离、编辑回填与结果交互；VSIX 在隔离 VS Code 扩展宿主验证启动和 Demo。
