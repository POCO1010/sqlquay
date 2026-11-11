# SQLQuay 的 GitHub 维护与 Marketplace 上架

## 先维护可复现的版本

仓库：<https://github.com/POCO1010/sqlquay>。默认分支为 `main`。功能分支按事项命名。

本地检查：

```sh
npm run check:public
npm test
npm run package
```

构建产物为 `artifacts/sqlquay-<version>.vsix`。不把构建目录、安装包、日志或本机配置提交到 Git；GitHub Actions 会保存本次 CI 构建的 VSIX。

CI 只运行公开内容检查、Node 单测和打包，不连接数据库，不读取本机策略脚本或凭据。完整 JDBC/DMS 离线夹具由维护者在已批准的本地策略环境运行。打包使用 Java 8，保持桥接类与 Java 8+ 的兼容性。

## 改名如何兼容已有安装

SQLQuay 0.4.0 改展示名称、命令分类、页面标题和 VSIX 文件名。扩展 ID `local-workbench.database-workbench`、命令 `dbw.*`、设置 `dbWorkbench.*` 和存储键保留，已有连接和文件绑定沿用原命名空间。

公开代码的策略默认目录为 `~/.sqlquay/policy/`：

- JDBC：`query_guard.py`。
- DMS：`execute_safe.py` 及它需要的同目录模块。

这些文件必须来自使用者批准的策略包。可通过机器设置指定路径；扩展不会下载或自动更换策略。已有安装可在本机用该通用目录映射到原批准策略，映射不进入仓库。

## 公开前检查的对象

- Git 跟踪文件：源码、文档和测试不包含私人用户名、个人主目录、真实连接地址、业务数据、令牌或密码。
- 图片：只保留 Demo 和合成测试截图；检查可见内容与文本元数据。
- 提交元数据：使用维护者 GitHub 的 noreply 邮箱，不使用私人邮箱。
- 安装包：只包含运行代码、桥接类和公开说明；不包含策略包、驱动 JAR、原插件包或反编译资源。
- Git 忽略规则：排除 `.env*`、日志、依赖目录、构建目录和 VSIX。`check:public` 在每次 CI 中复查常见文本泄漏。

## 上架前还缺什么

1. **正式 Publisher。** 当前 `local-workbench` 是本地发行标识，尚未核实 Marketplace 发布权限。先注册并确定 Publisher ID；它与 GitHub 账号是两套身份。
2. **最终扩展 ID 与迁移。** VS Code 的扩展 ID 为 `publisher.name`。若正式发布时更换其中任一字段，先完成连接、SecretStorage 和文件绑定的迁移与回归，再让已有用户升级。[Manifest 文档](https://code.visualstudio.com/api/references/extension-manifest)
3. **用户可安装的策略依赖。** 现有 JDBC/DMS 都需要外置批准脚本。首个通用版本应提供有明确许可、可独立安装的策略包，或明确面向自备策略的受控环境。不能把维护者的私人脚本目录当成用户安装条件。
4. **许可与发布资料。** 当前保持 `UNLICENSED`。由仓库所有者决定分发许可，补充适用的许可证、第三方声明、PNG 图标、当前版本截图和说明。活动栏 SVG 可继续使用；Marketplace 的 `icon` 不能使用 SVG。[官方发布指南](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
5. **官方打包验证。** 现有脚本生成的 VSIX 已用于本地安装；正式上传前用 `@vscode/vsce` 校验和打包，明确排除测试、内部材料和不需要的资源。

## 首次发布推荐手动上传，之后再接 OIDC

核对日期：2026-11-11。

1. 使用维护者自己的 Microsoft 身份登录 [Marketplace Publisher 管理页](https://marketplace.visualstudio.com/manage)，创建 Publisher；Publisher ID 创建后不可更改。
2. 确定最终 ID、许可和安装依赖，补齐上面的发布资料。
3. 用官方 `vsce` 构建正式 VSIX，完成独立 VS Code、JDBC/DMS 离线夹具及公开内容检查。
4. 在管理页上传 VSIX，核对扩展详情、名称、版本和下载后的安装结果。[官方首次发布流程](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)

持续发布优先用 GitHub Actions **Trusted Publishing（OIDC）**，不在仓库保存长期发布令牌。策略需绑定准确的仓库所有者、仓库名、工作流文件和可选 Environment；发布任务授予 `id-token: write` 后执行 `vsce publish --oidc`。当前 CI 不包含市场发布动作。[官方 Trusted Publishing 说明](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing)

官方公告指出 Azure DevOps 的全局 PAT 将于 2026-12-01 停用，新配置优先选联合身份。[PAT 停用公告](https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/)
