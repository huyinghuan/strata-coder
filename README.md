# Strata Coder

An MCP implementation worker for local OpenAI-compatible coding models.

主模型负责规划、选择是否委派、审查和集成补丁；Strata Coder 让本地模型在项目副本中完成具体实现、运行检查并返回结果。支持接入具备 MCP stdio 客户端能力的编程工具和自建 Harness。

本项目独立维护，不隶属于同名推理服务；只依赖兼容的 `/chat/completions` 接口和工具调用能力。

## 安装

需要 Node.js 22+、Git，以及支持 `tools` / `tool_calls` 的模型端点。开发及真实推理测试在 macOS 上完成；CI 配置了 macOS/Linux 与 Node 22/24 的测试矩阵，Windows 尚未验证。

发布到 npm 后可以直接由 MCP 客户端启动固定版本：

```bash
npx -y strata-coder@0.1.0 --config /absolute/path/strata-coder.config.json
```

也可以全局安装，然后让客户端启动 `strata-coder`：

```bash
npm install -g strata-coder@0.1.0
strata-coder --config /absolute/path/strata-coder.config.json
```

服务通过 stdio 通信，由客户端管理进程；直接在终端启动会等待 MCP 消息。`strata-coder` 只是 MCP 启动入口，不提供独立的编码任务 CLI。

源码安装（也适用于尚未发布 npm 的版本）：

```bash
git clone https://github.com/huyinghuan/strata-coder.git
cd strata-coder
npm ci --ignore-scripts
cp strata-coder.config.example.json strata-coder.config.json
# 编辑配置，填写实际模型、项目路径和检查命令
node src/mcp.js --config "$PWD/strata-coder.config.json"
```

## 配置

配置文件存放在 npm 安装目录之外，升级包不会覆盖它。所有相对路径以配置文件所在目录为基准；推荐绝对路径。工作目录必须已经存在。

```json
{
  "baseUrl": "http://127.0.0.1:8080/v1",
  "model": "your-model-id",
  "workspaceRoots": ["/absolute/path/to/project"],
  "stateDir": "/absolute/path/to/strata-coder-state",
  "checks": {
    "unit": {
      "command": ["node", "--test", "test/unit.test.js"],
      "timeoutSeconds": 60
    }
  },
  "defaultChecks": ["unit"],
  "requireChecks": true,
  "reasoningEffort": "low",
  "maxOutputTokens": 13000,
  "requestTimeoutSeconds": 360,
  "maxRepairAttempts": 2,
  "temperature": 0
}
```

将示例检查替换为项目真实命令。命令在工作副本执行，不经过 shell。`node_modules`、虚拟环境和 Git 忽略文件不复制；需要额外依赖时，提供合适的准备/检查命令。默认未选择检查就拒绝任务；仅在需要未验证草稿时显式设置 `requireChecks: false`。

- `reasoningEffort` 支持 `low`、`medium`、`high`、`none` 或 `null`；`null` 省略该参数，适用于不支持它的服务。具体模型是否支持其他档位由服务决定。
- `maxContextChars` 默认 120,000，限制消息历史的 JSON 字符数，**不是 tokens**；不代表模型上下文容量，也不是精确 tokenizer 计数。扩大预算前需为工具定义、模板和输出预留空间。
- `maxOutputTokens` 是每次响应上限，`maxTurns` 默认 20，`maxTaskSeconds` 默认 900 秒。请按模型实际限制配置。
- `maxRepairAttempts` 从检查失败后的首次实际修改开始计数；耗尽时交回主模型。
- 多个客户端共用同一绝对 `stateDir` 可共享任务记录、提交去重和项目占用状态。
- 同一 OS 用户、相同规范化模型 URL 的请求通过共享端点锁串行执行。不同 URL 别名、不同机器或外部调用不受该锁控制。
- 模型需要鉴权时，在 MCP 进程环境中设置 `LOCAL_CODER_API_KEY`，或用 `apiKeyEnv` 指定另一个变量名。

`--config` 优先于 `STRATA_CODER_CONFIG`，后者优先于兼容保留的 `LOCAL_CODER_CONFIG`。旧配置文件名、`.local-coder-state` 状态目录和锁目录仍兼容，无需迁移已有任务。

## 接入 MCP 客户端

以下适用于使用 `mcpServers` 结构的客户端，其他客户端将同一命令映射到其 MCP stdio 设置中：

```json
{
  "mcpServers": {
    "strata_coder": {
      "command": "npx",
      "args": ["-y", "strata-coder@0.1.0", "--config", "/absolute/path/strata-coder.config.json"]
    }
  }
}
```

桌面客户端若找不到 `npx`，使用它的绝对路径，或者使用绝对 Node 路径加 `src/mcp.js`。不要用带启动横幅的 `npm start` 作为 MCP 通信入口。

源码安装可生成本机路径的配置参考：

```bash
npm run host-config -- /absolute/path/strata-coder.config.json
```

生成器只打印通用配置和已有客户端适配示例，不修改任何客户端配置。客户端各版本配置格式可能不同，应以实际版本为准。

把 [prompts/planner.md](prompts/planner.md) 合并到主模型指令中，告诉它何时委派、如何等待和审查。不要覆盖已有项目规则。用户可以说“这个任务用主模型，不调用本地模型”或“这个任务交给本地模型”。如果要接手正在执行的任务，先取消该任务并确认终态。

## 工作流与工具

1. `get_capabilities`：确认工作目录范围、检查名称和模型预算。
2. `submit_task`：提交一个边界明确的实现或修复任务，立即返回任务 ID。
3. `get_task`：优先使用 `wait_seconds: 20`，查看进度与终态。
4. `read_artifact`：按需分页读取补丁、检查或事件。
5. `cancel_task`：请求取消，再查询确认停止。

任务参数见 [examples/task.json](examples/task.json)。`allowed_paths` 为相对文件/目录前缀，不支持 glob。相同项目、相同 `request_id` 和相同参数的重试会返回同一任务；不要通过换 ID 无限重试失败任务。

终态包括 `ready_for_review`、`needs_primary`、`failed`、`cancelled`、`interrupted`。`ready_for_review` 仅表示完成了配置检查，仍需审查业务正确性。`needs_primary` 返回失败原因和部分补丁，供主模型接手或重新拆分任务。

修改发生在项目副本，原项目不会自动改变。审查完整补丁后，在原项目执行：

```bash
git apply --check /absolute/path/to/changes.patch
git apply /absolute/path/to/changes.patch
```

应用后再次运行项目检查。后台 Worker 在 MCP 断线后继续执行；禁用 MCP 不会取消任务。取消请求也不保证模型服务立即停止 GPU 计算。只有任务结束后才应清理对应状态目录。

## 验证与开发

```bash
npm test
npm run test:package
```

自动化测试使用模拟模型，覆盖 MCP 连接、真实 Worker、去重、取消、检查、失败交接和端点串行。打包测试会安装真实 tarball 并验证其启动入口和 MCP 握手，需要访问 npm registry，不调用本地模型。

可选真实推理测试：

```bash
npm run smoke -- /absolute/path/strata-coder.config.json
npm run regression -- /absolute/path/strata-coder.config.json /absolute/path/local-model-eval
```

回归脚本依赖外部评估数据及 macOS sandbox-exec，不包含在 npm 包内。真实任务记录、评估报告、本机配置和凭据不会随源码或 npm 包发布。

## 权限边界

工作副本隔离代码变更，**不是操作系统沙箱**。文件工具限制目录、修改范围和符号链接；配置的检查仍以宿主用户身份运行项目代码。仅对受信任项目配置检查，需要执行不可信仓库时，将整个 Worker 放入容器或 OS 沙箱。

默认排除 `.git`、依赖目录、`.env*`、`.pem`、`.key`、`.aws`、`.ssh` 等，但不是完整的敏感数据扫描。源码会按需发送到配置的模型端点；主模型读取的摘要、补丁和日志进入主模型上下文。token 统计仅属于本地服务，不代表主模型节省量。

## 发布与许可

仓库维护和 GitHub Actions → 公共 npm 的步骤见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。使用 MIT 许可证，见 [LICENSE](LICENSE)。
