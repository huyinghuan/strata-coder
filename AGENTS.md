# Strata Coder 开发指南

本仓库的 npm 包名和公开项目名是 `strata-coder`；本机目录可能仍叫 `local-coder`。它是供 OpenCode、Codex 和其他 MCP 客户端使用的本地编码 Worker。

## 开发与验证

- 使用 Node.js 22 或以上版本、npm 和 Git。代码采用 JavaScript ESM、Node 内置 API 和 `node:test`，保持现有风格，不引入无关框架或构建步骤。
- `npm ci --ignore-scripts`：按锁文件安装依赖。修改依赖时同步更新 `package.json` 和 `package-lock.json`。
- `npm test`：运行自动化测试，使用模拟模型，不需要真实模型服务。
- `npm run test:package`：验证打包内容、干净安装、入口和 MCP 握手。修改入口、依赖、包文件清单或发布配置时执行；需要可用的 npm registry/cache。
- `npm run smoke -- /absolute/path/config.json`：调用真实模型完成小任务。`npm run regression -- /absolute/path/config.json` 用于真实模型回归；运行前先阅读脚本参数与用例，不要把它们当作每次文档修改的默认检查。
- 修改行为时补充有意义的正常、边界和失败路径测试；纯文档修改核对内容和差异即可。不要删除断言、放宽验收或禁用检查来制造通过结果。
- 完成后说明改动、实际执行的检查及未验证部分。保留用户已有修改，不自动发布版本或修改客户端的主模型配置。

## 代码导航

- `src/mcp.js`、`src/server.js`：stdio 入口、MCP 工具与服务说明。
- `src/config.js`：配置校验、任务参数、目录与文件范围约束。
- `src/jobs.js`、`src/worker.js`：任务生命周期、独立 Worker、取消、最终验证与工件。
- `src/agent.js`、`src/model.js`：本地工具执行、模型请求。
- `src/workspace.js`：工作副本、文件排除和补丁生成。
- `src/endpoint.js`、`src/process.js`、`src/handoff.js`：模型端点串行调度、子进程与主模型接手。
- `test/`：自动化测试及模拟模型；`scripts/`：打包检查、冒烟、回归和宿主配置输出。
- `prompts/planner.md`：通用委派规则；`docs/AI-INSTALL.md`：跨客户端安装指引。工具或配置协议变化时同步相关文档和示例。

## 必须保持的行为

- MCP 只提供 stdio 服务入口，不恢复独立编码任务 CLI。服务名称与版本来自包元数据。
- Worker 只修改副本并返回补丁，不能自动写回原仓库。保持任务幂等、取消、超时、修复次数上限和明确的终态语义。
- 保持目录边界、符号链接限制、敏感文件排除、允许修改范围和检查命令白名单。检查以当前用户权限运行，工作副本不是操作系统沙箱。
- 缺少必要检查应在请求模型前拒绝；不能将模型自述“测试通过”当作执行结果。
- 保留同一模型端点的串行调度和排队取消。模型参数必须可配置；当前默认 `reasoningEffort: low`、`maxOutputTokens: 13000`。`maxContextChars` 是字符预算，不是 token 数，不可将模型的约 130k token 上下文直接填入该字段并宣称等价。
- 本地服务地址、工作目录和密钥属于用户配置，不硬编码进发布文件。不要提交本地配置、状态目录、报告、`.env`、`.npmrc` 或凭据。

## 可选开发工具

当客户端提供 Strata Coder MCP 工具时，先读取并遵循 [协作规则](.opencode/strata-coder.md)。工具不可用或用户要求主模型直接实现时，直接按本开发指南工作。移除协作指引时删除本节；停用 MCP 还需在客户端禁用或删除服务配置。
