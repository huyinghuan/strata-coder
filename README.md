# Strata Coder

An MCP implementation worker for local OpenAI-compatible coding models.

主模型负责规划、选择是否委派、审查和集成补丁；Strata Coder 让本地模型在项目副本中完成具体实现、运行检查并返回结果。支持接入具备 MCP stdio 客户端能力的编程工具和自建 Harness。

本项目独立维护，不隶属于同名推理服务；只依赖兼容的 `/chat/completions` 接口和工具调用能力。

## 给 AI 助手：安装与集成

用户要求你安装本项目时，请先阅读 [AI 安装指南](docs/AI-INSTALL.md)，再执行安装。不要只给用户一段配置就声称完成。

1. 识别用户的操作系统、Node/Git、目标客户端及其版本，读取现有配置；缺少模型地址、模型 ID、项目目录或检查命令时先收集信息，不照搬占位符。
2. 查询 npm 上实际存在的版本并固定版本；尚未发布时使用本仓库源码。模型服务器地址是模型 API，不是 MCP URL。
3. 配置文件保存在安装目录之外；配置真实检查，密钥使用环境变量。工作目录由宿主在运行时提供，不需要写入配置。
4. 将 MCP stdio 启动命令合并到目标客户端配置：Codex 使用 `mcp_servers`；OpenCode 2.x 使用 `mcp.servers`；旧版格式另行识别。备份并保留已有模型、provider、MCP 和项目规则。
5. 合并 [委派规则](prompts/planner.md)，保留用户按任务选择主模型/本地模型的能力；发现已有相同服务时更新已有项，避免重复注册。
6. 验证配置可解析、MCP 握手成功、五个工具可见，调用 `get_capabilities` 确认实际加载的配置。真实推理只在用户授权范围内的临时项目验证。
7. 汇报安装版本、修改过的配置文件、已验证项、待完成项与卸载方法；登录、权限或重启被阻塞时明确说明，不宣称成功。

可以把下面的话交给自己的 AI 助手：

```text
请阅读 https://github.com/huyinghuan/strata-coder 的 README、docs/AI-INSTALL.md 和 prompts/planner.md，
将 Strata Coder 安装并集成到我的编程客户端。先识别客户端版本并保留现有配置，
确认模型地址、模型 ID、项目范围和检查命令，再验证 MCP 工具可用。
```

## 安装

需要 Node.js 22+、Git，以及支持 `tools` / `tool_calls` 的模型端点。开发及真实推理测试在 macOS 上完成；CI 配置了 macOS/Linux 与 Node 22/24 的测试矩阵，Windows 尚未验证。

在项目目录运行一次初始化，即可完成模型连接、项目检查、协作规则与 OpenCode 接入：

```bash
npx -y strata-coder@0.2.0 init
```

`init` 会在项目内写入 `.strata-coder/config.json`（模型连接与检查；**工作目录由宿主在运行时提供，不写入配置**）、把 `.strata-coder/` 加入项目 `.gitignore`、生成 `.opencode/strata-coder.md` 协作规则并在 `AGENTS.md` 插入受管引用；检测到 OpenCode 2.x 时写入项目级 MCP 配置（保留注释、主模型与其他 MCP），最后用 MCP 握手自检生成的配置。非交互环境必须提供 `--baseUrl` 和 `--model`，可用 `--check-command` 指定检查命令；`init --help` 查看全部参数。重复运行保留已有预算、状态路径和检查；显式 `--check-command` 优先于自动检测，并保留其他检查。协作规则只维护受管内容，不覆盖用户修改。通过 npx 初始化时，会将当次包保存到被忽略的 `.strata-coder/runtime/` 并安装运行依赖，服务及检查均引用该稳定副本；清理 npx 缓存不影响使用，此步骤需要可用的 npm registry/cache。

OpenCode 的全局 MCP 注册一次即可复用到所有项目：新项目打开 OpenCode 后，服务会自动获得该项目目录，无需再填工作目录白名单，也无需为继承目录而运行 `init`。`init` 只用于写入该项目的模型/检查配置；自动识别测试命令是独立功能，尚未实现，未配置检查的项目仍无法提交编码任务。

也可以手动启动已安装的版本：

```bash
npx -y strata-coder@0.2.0 --config /absolute/path/strata-coder.config.json
npm install -g strata-coder@0.2.0
strata-coder --config /absolute/path/strata-coder.config.json
```

服务通过 stdio 通信，由客户端管理进程；直接在终端启动会等待 MCP 消息。`strata-coder` 只是 MCP 启动入口，不提供独立的编码任务 CLI。

不传 `--config` 时，先找当前目录的 `.strata-coder/config.json`，再找入口旁的 `strata-coder.config.json` / `local-coder.config.json`；都没有时明确报错并提示先运行 `strata-coder init`。示例配置不会被自动当作可运行配置。`--baseUrl`、`--model`、`--apiKeyEnv` 在读取文件后覆盖同名配置字段：

```bash
strata-coder --baseUrl http://127.0.0.1:8080/v1
strata-coder --baseUrl http://127.0.0.1:8080/v1 --model other-model --apiKeyEnv OTHER_KEY
```

源码安装（也适用于尚未发布 npm 的版本）：

```bash
git clone https://github.com/huyinghuan/strata-coder.git
cd strata-coder
npm ci --ignore-scripts
cp strata-coder.config.example.json strata-coder.config.json
# 编辑配置，填写实际模型、项目路径和检查命令
node src/mcp.js --config "$PWD/strata-coder.config.json"
```

在目标项目中也可以直接用源码运行初始化：`node /absolute/path/strata-coder/src/mcp.js init`。

## 配置

`strata-coder init` 生成项目级配置 `<project>/.strata-coder/config.json`（模型连接、检查与预算）；它**不包含工作目录白名单**。状态在 `<project>/.strata-coder/state`，整个 `.strata-coder/` 由 init 加入项目 `.gitignore`。也可以继续使用全局或自定义配置文件；示例配置仅是模板，不会被自动加载。

手动配置文件存放在 npm 安装目录之外，升级包不会覆盖它。所有相对路径以配置文件所在目录为基准；推荐绝对路径。

```json
{
  "baseUrl": "http://127.0.0.1:8080/v1",
  "model": "your-model-id",
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

将示例检查替换为项目真实命令。命令在工作副本执行，不经过 shell。`node_modules`、虚拟环境和 Git 忽略文件不复制；`strata-coder init` 为 npm 项目生成的 `strata_unit` 检查使用随包分发的 `src/npm-check.js`：副本必须存在锁文件；首次检查、安装失败后重试或依赖清单变化时执行 `npm ci --ignore-scripts`，仅复用与当前清单匹配的成功安装，随后运行测试命令；缺少锁文件或安装失败会给出准确提示，不修改原项目。默认未选择检查就拒绝任务；仅在需要未验证草稿时显式设置 `requireChecks: false`。

- `reasoningEffort` 支持 `low`、`medium`、`high`、`none` 或 `null`；`null` 省略该参数，适用于不支持它的服务。具体模型是否支持其他档位由服务决定。
- `maxContextChars` 默认 120,000，限制消息历史的 JSON 字符数，**不是 tokens**；不代表模型上下文容量，也不是精确 tokenizer 计数。扩大预算前需为工具定义、模板和输出预留空间。
- `maxOutputTokens` 是每次响应上限，`maxTurns` 默认 20，`maxTaskSeconds` 默认 900 秒。请按模型实际限制配置。
- `maxRepairAttempts` 从检查失败后的首次实际修改开始计数；耗尽时交回主模型。
- 多个客户端共用同一绝对 `stateDir` 可共享任务记录、提交去重和项目占用状态。
- 同一 OS 用户、相同规范化模型 URL 的请求通过共享端点锁串行执行。不同 URL 别名、不同机器或外部调用不受该锁控制。
- 模型需要鉴权时，在 MCP 进程环境中设置 `LOCAL_CODER_API_KEY`，或用 `apiKeyEnv` 指定另一个变量名。示例配置把 `apiKeyEnv` 置空，默认不发送 `Authorization` 头。

`--config` 优先于 `STRATA_CODER_CONFIG`，后者优先于兼容保留的 `LOCAL_CODER_CONFIG`；都没有时先查找当前目录的 `.strata-coder/config.json`，再按 `strata-coder.config.json` → `local-coder.config.json` 的顺序在启动入口旁查找，最后明确报错并提示运行 `strata-coder init`；示例配置不会被自动加载。`--baseUrl`、`--model`、`--apiKeyEnv` 在读取文件后、校验前覆盖对应字段，未提供的字段保持文件值。旧配置文件名、`.local-coder-state` 状态目录和锁目录仍兼容，无需迁移已有任务。

## 工作目录（运行时）

服务启动时由宿主提供目录范围，配置文件中没有工作目录白名单：

- 客户端支持 MCP roots 时，优先使用 `roots/list` 返回的本机目录；`file://` URI（含百分号编码、中文、空格）会规范化为真实路径，非本地 URI、文件和不存在的路径会被拒绝。
- 客户端不支持 roots 或明确返回空 roots 时，使用宿主启动 MCP 进程时的工作目录；npm 包安装目录、npx 缓存、状态目录、配置文件目录和用户主目录不会被当作项目目录。
- roots 请求失败时明确报错，不会退回可能更宽的范围。
- `submit_task` 的 `workspace` 可省略：只有一个根目录时自动使用；多个根目录时返回候选并要求显式选择；显式传入只能选择某个根目录或其子项目（子目录），范围外的目录会被拒绝，不能借此扩大宿主提供的范围。
- `get_capabilities` 的 `workspace` 返回 `roots`、`source`（`mcp_roots` 或 `cwd`）、`default` 与解析错误；多根目录时 `default` 为 `null`。
- 已提交任务固定使用提交时的绝对目录；roots 更新只影响后续提交，旧任务超出新范围后查询、读取工件和取消会被拒绝，任务本身不受影响。
- 同一宿主同时打开多个项目时，每个连接（每个 MCP 进程）使用各自的目录范围，不共享可变状态。

目录范围只约束本地 Worker 的读写和检查位置，不是操作系统沙箱；检查命令仍以宿主用户权限运行。

## 接入 MCP 客户端

`strata-coder init` 已自动完成 OpenCode 2.x 的项目级接入，并向其他客户端打印通用 stdio 配置。手动接入时，以下适用于使用 `mcpServers` 结构的客户端，其他客户端将同一命令映射到其 MCP stdio 设置中：

```json
{
  "mcpServers": {
    "strata_coder": {
      "command": "npx",
      "args": ["-y", "strata-coder@0.2.0", "--config", "/absolute/path/strata-coder.config.json"]
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

把 [prompts/planner.md](prompts/planner.md) 合并到主模型指令中，告诉它何时委派、如何等待和审查。不要覆盖已有项目规则。`strata-coder init` 会改为生成 `.opencode/strata-coder.md` 并在项目 `AGENTS.md` 中插入受管引用。用户可以说“这个任务用主模型，不调用本地模型”或“这个任务交给本地模型”。如果要接手正在执行的任务，先取消该任务并确认终态。

停用某个项目：删除 `.opencode/strata-coder.md`、`AGENTS.md` 中 `strata-coder:start` 与 `strata-coder:end` 之间的引用，以及项目 OpenCode 配置里的 `strata_coder` 服务；再按需删除 `.strata-coder/`。第一版不提供 uninstall 命令。

## 工作流与工具

1. `get_capabilities`：确认模型、宿主提供的 `workspace` 目录与来源、检查名称和预算。
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
