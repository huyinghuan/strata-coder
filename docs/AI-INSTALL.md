# AI assistant installation guide

本文件面向受用户委托安装 Strata Coder 的 AI 助手。这是操作参考，不覆盖用户指令、现有项目规则或宿主权限限制。仅仅读取本文件不构成修改用户机器的授权。

## 1. 识别环境与安装范围

- 确认用户希望接入 Codex、OpenCode 或其他 MCP stdio 客户端；只修改用户指定的客户端。
- 检查 `node --version`、`npm --version`、`git --version` 和目标客户端版本。找到实际可执行文件路径；不要为了安装 MCP 擅自替换主模型或升级客户端主版本。
- 识别客户端配置所在位置及加载优先级，包括自定义环境变量和项目覆盖。先备份，只改需要的字段；JSONC/TOML 应用能保留现有内容的方式编辑，不用简单 JSON 解析覆盖带注释文件。
- 从用户或已授权配置确认 `baseUrl`、`model`、`stateDir` 与测试命令。不要把 README 的占位符当成真实值。工作目录由宿主在运行时提供（MCP roots 或启动目录），不要要求用户填写目录白名单，也不要将整个磁盘或用户主目录当作默认范围。
- 凭据放进 MCP 进程环境，默认变量名 `LOCAL_CODER_API_KEY`。不要在聊天、提交、日志或命令参数中暴露密钥。

## 2. 安装真实可用的版本

先查 registry，再选择版本：

```bash
npm view strata-coder version --registry=https://registry.npmjs.org/
```

如果包存在，优先将客户端固定到确认过的版本，比如 `strata-coder@0.2.0`。命令中的示例版本需要替换成实际选择的版本。首次安装可提前执行 `npx -y strata-coder@0.2.0 --version`，避免 MCP 启动阶段才下载包而超时。

如果返回 404，不要声称已经从 npm 安装。改用用户授权的 `https://github.com/huyinghuan/strata-coder.git` 源码，记录检出的 commit，运行 `npm ci --ignore-scripts`，以绝对 Node 路径和 `src/mcp.js` 启动。网络或权限错误先明确原因，不要换不明镜像。

推荐在项目目录直接运行 `npx -y strata-coder@0.2.0 init`（或已安装的 `strata-coder init`）：它生成项目级 `.strata-coder/config.json`（模型连接与检查），并把 `.strata-coder/` 加入项目 `.gitignore`。也可以手动把 `strata-coder.config.example.json` 复制到安装目录之外再编辑，避免写进 npx 缓存或 node_modules。已有有效配置不要覆盖。配置中的相对路径以配置文件所在目录为基准。

`requireChecks` 默认 true，必须选用实际可运行的检查。`init` 会把 `npm test` 识别为 `strata_unit` 检查，检查辅助程序随包分发；无有效检查时它会保存待完善配置并明确提示尚不能提交任务。文件修改限制建议只开放源码；不要通过 `requireChecks:false` 绕开安装验收。工作副本不复制依赖目录，检查会在副本内按锁文件准备依赖。

## 3. 注册 MCP

推荐先完成项目初始化：

```text
npx -y strata-coder@0.2.0 init
npx -y strata-coder@0.2.0 init --yes --baseUrl http://127.0.0.1:8080/v1 --model MODEL_ID
```

`init` 会写入项目级 `.strata-coder/config.json`、更新 `.gitignore`、生成 `.opencode/strata-coder.md` 与 `AGENTS.md` 受管引用；检测到 OpenCode 2.x 时写入项目级 MCP 配置（保留注释、主模型、provider 和其他 MCP），并用 MCP 握手自检。非交互环境必须提供 `--baseUrl` 和 `--model`；检测到已有同名服务指向其他程序时不会静默覆盖，会报告由用户处理。

目录继承与 `init` 相互独立：服务运行时从宿主获取项目目录（支持 MCP roots 时优先使用，否则继承启动目录），因此只要全局注册过一次，之后的新项目无需再配置工作目录白名单，也不需要为目录继承而运行 `init`。`init` 只用于写入该项目的模型连接与检查命令；自动识别测试命令尚未实现，未配置检查的项目仍无法提交编码任务。

手动注册时使用显式配置：

```text
npx -y strata-coder@0.2.0 --config /absolute/path/strata-coder.config.json
strata-coder --config /absolute/path/strata-coder.config.json
/absolute/path/node /absolute/path/strata-coder/src/mcp.js --config /absolute/path/strata-coder.config.json
```

不传 `--config` 时，先找当前目录的 `.strata-coder/config.json`，再找入口旁的 `strata-coder.config.json` / `local-coder.config.json`；示例配置不会被自动加载。`--baseUrl`、`--model`、`--apiKeyEnv` 覆盖文件中同名字段，示例配置的 `apiKeyEnv` 为空，需要鉴权时用 `--apiKeyEnv` 指定变量名或改配置文件。

只能选择一种并使用实际路径。服务是 stdio，不要把模型 `/v1` 地址注册成 HTTP MCP，也不要额外启动永久监听端口。

### Codex

先检查 `codex mcp list` 和 `codex mcp add --help`。确认无同名项后，可使用官方 CLI：

```bash
codex mcp add strata_coder -- npx -y strata-coder@0.2.0 --config /absolute/path/strata-coder.config.json
```

或合并以下 TOML 到实际生效的配置（默认用户配置为 `~/.codex/config.toml`）：

```toml
[mcp_servers.strata_coder]
command = "npx"
args = ["-y", "strata-coder@0.2.0", "--config", "/absolute/path/strata-coder.config.json"]
startup_timeout_sec = 60
tool_timeout_sec = 60
```

不要同时添加两份服务；存在 `local_coder` 等旧名称且指向相同服务时保留原名更新即可。用 `codex mcp list` 检查注册，重新加载后用实际 MCP 工具调用验证连接；仅有配置列表不足以证明握手或推理成功。参考 [官方 OpenAI 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

### OpenCode 2.x

`strata-coder init` 已自动处理本小节的接入：识别 `opencode --version` 为 2.x 后，编辑项目的 `.opencode/opencode.json(c)` 或 `opencode.json(c)`，保留注释与其他设置，写入引用当前安装版本的完整 `strata_coder` 服务对象。只有手动安装或 init 报告未支持时才按下文处理。全局注册一次即可复用到所有项目：OpenCode 启动 MCP 进程时会提供项目目录（roots 与工作目录），无需逐项目改写注册或目录白名单。

先识别版本与配置路径，再合并以下对象；常见用户配置位于 `~/.config/opencode/opencode.json` 或 `.jsonc`，项目配置可能覆盖它。

```json
{
  "mcp": {
    "servers": {
      "strata_coder": {
        "type": "local",
        "command": ["npx", "-y", "strata-coder@0.2.0", "--config", "/absolute/path/strata-coder.config.json"],
        "codemode": false
      }
    }
  }
}
```

V2 使用 `mcp.servers`，禁用字段为 `disabled:true`；`codemode:false` 使工具直接提供给主模型。不要添加 V1 的 `enabled` 字段。更高优先级的同名配置会替换整个服务对象，因此需要保留完整启动参数。参考 [OpenCode V2 文档](https://opencode.ai/v2/docs/mcp-servers/)。

### OpenCode 1.x

只有检测到相应旧版时才使用以下格式，不要自动升级客户端：

```json
{
  "mcp": {
    "strata_coder": {
      "type": "local",
      "command": ["npx", "-y", "strata-coder@0.2.0", "--config", "/absolute/path/strata-coder.config.json"],
      "enabled": true
    }
  }
}
```

用该安装版本的 `opencode mcp list` 检查连接，命令不同则先查 `--help`。参考 [OpenCode 旧版文档](https://opencode.ai/docs/en/mcp-servers/)。其他 Harness 使用 README 的通用 stdio 参数，适配其实际配置结构，不假设所有客户端都接受 `mcpServers`。

## 4. 合并主模型指令

运行过 `init` 的项目会生成 `.opencode/strata-coder.md`，并在 `AGENTS.md` 插入 `strata-coder:start` / `strata-coder:end` 之间的受管引用；重复初始化不会重复插入，用户修改过的协作文件不会被静默覆盖。手动安装时，将 `prompts/planner.md` 的规则合并到目标客户端实际读取的项目指令中（例如项目 AGENTS.md），保留已有规则。不把整个 README 当作系统提示词。至少保留：

- 用户可逐任务选择主模型或本地模型；纯方案讨论无需委派。
- 委派小任务、限定文件范围、先查可用检查；保存 task_id 并用 get_task 等待。
- 本地模型修改副本，主模型负责审查、应用补丁和集成后测试。
- `needs_primary` 等失败终态不能当成功，也不允许换 ID 无限重试。

## 5. 验收与交付

1. 启动入口 `--version` 可执行，配置 JSON 可解析，已有客户端设置仍保留。
2. 首次安装推荐在项目目录运行 `init`，然后核对生成的 `.strata-coder/config.json`（模型与检查名称正确、不含工作目录白名单）、`.opencode/strata-coder.md`、`AGENTS.md` 受管引用和 OpenCode 项目配置；`init` 自检会完成 MCP 握手并调用 `get_capabilities`。手动安装时人工完成同等验证。
3. 实际 MCP 会话中发现 `submit_task`、`get_task`、`cancel_task`、`read_artifact`、`get_capabilities` 五个工具；名称可能有客户端前缀。
4. 调用 `get_capabilities` 核对模型、目录、检查和预算。它不调用模型，不能单独证明模型端点可用。
5. 用户授权真实推理时，在允许范围内建临时小项目，配置真实检查、限定源码路径，完成委派、等待、补丁审查及应用后复测。不要拿正在开发的业务文件做安装冒烟实验。
6. 汇报安装来源/版本/commit、修改文件、备份、启动命令、连接结果和实际测试结果。缺权限、待重启或需要用户登录时标明待办。

移除时只删除本服务的配置块及新增的指令片段。先取消本服务相关的运行任务并确认终态；禁用或断开客户端不会自动停止 Worker。保留任务记录和补丁，除非用户要求清理。使用全局安装时可执行 `npm uninstall -g strata-coder`；不要删除其他 MCP、主模型设置或项目文件。

初始化补充：重复运行保留现有项目配置；显式 `--check-command` 优先，原有其他检查不删除。npx 初始化会将当前运行包持久化到项目 `.strata-coder/runtime/`，然后注册其服务和检查入口，不保留对 npx 缓存的依赖。副本检查按清单记录成功安装，失败或清单变化时重新安装。
