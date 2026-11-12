# SQLQuay 的首发与维护

## 已确定的发行身份

- 展示名：SQLQuay。
- Marketplace Publisher：`TomMajor`，由所有者完成创建。
- 正式扩展 ID：`TomMajor.sqlquay`。
- 当前构建包：`artifacts/sqlquay-0.7.1.vsix`，标记 Preview。
- 许可证：MIT。外部 Java、Python、阿里云 CLI 与 Connector/J 不随包分发。
- GitHub：<https://github.com/POCO1010/sqlquay>，默认分支 `main`。

旧版身份改为正式身份时需要迁移。已有用户先按 [本机迁移步骤](MIGRATION.md) 操作；新用户无需迁移助手。

## 从源码生成可上传包

需要 Node.js 22+、JDK 8+ 和 Python 3.10+，在线策略目前支持 macOS / Linux。

市场 PNG 图标的宽、高均须在 128–1024 像素之间。当前图标等比缩放为 512 × 512；打包时先检查尺寸，超限直接报错。

```sh
npm ci --ignore-scripts
npm test
npm run test:jdbc
npm run test:dms
npm run check:public
npm run package
```

`npm run package` 调用官方 `@vscode/vsce`，先编译 Java 8 兼容桥接类；包含声明的源码、PNG 图标、桥接类、四个 Python 入口和附带策略。`.vscodeignore` 排除测试、原始分析材料、依赖、日志及其他安装包。按当前锁定依赖构建，不全局安装发布工具。

JDBC/DMS 的只读策略位于 `policy/`，没有真实连接、数据库 ID 或账号；设置留空即使用附带策略。组织批准的外置策略仍可显式指定，迁移旧安装时保留原策略路径和锁范围。独立 AccessKey 使用附带的隔离执行器；DMS 外置覆盖仅用于已有 CLI profile 方式。两种方式继续做目标核对、EXPLAIN、扫描阈值、单查询锁及超时不重试。

## 首次手动上传

1. 在独立 VS Code 配置中安装正式 VSIX，完成 Demo、两种通道的离线夹具与迁移验证。
2. 打开 [TomMajor 管理页](https://marketplace.visualstudio.com/manage/publishers/TomMajor)。
3. 新建 Visual Studio Code 扩展，只上传 `sqlquay-0.7.1.vsix`。不要上传 `sqlquay-legacy-migration-0.4.3.vsix`。
4. 根据平台返回的校验结果处理，核对展示名、Publisher、版本、MIT 许可和安装说明。
5. 从市场下载到独立配置验收，再安排已有用户迁移；不要删除旧版数据或唯一可用的旧 VSIX。

官方支持打包后手动上传：[发布指南](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)。本地打包不需要 Publisher Token。平台上传由所有者确认执行。

## GitHub CI 与后续自动发布

当前 CI 只检查、运行离线测试和打包，不连接真实数据库，也不发布 Marketplace。手动上传首发不依赖 GitHub Actions。

后续采用 GitHub Actions Trusted Publishing（OIDC），绑定 `POCO1010/sqlquay` 与单独的发布工作流，不保存长期发布令牌。需要发布时再配置策略与发布环境，不把发布混入普通 CI。[官方 Trusted Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing)

## 每次提交检查公开内容

不要提交真实连接、密码、业务 SQL、日志、驱动 JAR、个人策略目录、原插件包或反编译资源。截图只使用合成数据，并检查可见内容和元数据。保持 GitHub noreply 提交身份，按相关路径提交与普通推送，不改写远端历史。
