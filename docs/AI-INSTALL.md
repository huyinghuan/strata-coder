# AI assistant installation guide

本文件面向受用户委托安装 Strata Coder 的 AI 助手。这是操作参考，不覆盖用户指令、现有项目规则或宿主权限限制。仅仅读取本文件不构成修改用户机器的授权。

## 1. 识别环境与安装范围

- 确认用户希望接入 Codex、OpenCode 或其他 MCP stdio 客户端；只修改用户指定的客户端。
- 检查 `node --version`、`npm --version`、`git --version` 和目标客户端版本。找到实际可执行文件路径；不要为了安装 MCP 擅自替换主模型或升级客户端主版本。
- 识别客户端配置所在位置及加载优先级，包括自定义环境变量和项目覆盖。先备份，只改需要的字段；JSONC/TOML 应用能保留现有内容的方式编辑，不用简单 JSON 解析覆盖带注释文件。
- 从用户或已授权配置确认 `baseUrl`、`model`、`workspaceRoots`、`stateDir` 与测试命令。不要把 README 的占位符当成真实值，也不要将所有磁盘根目录加入允许范围。
- 凭据放进 MCP 进程环境，默认变量名 `LOCAL_CODER_API_KEY`。不要在聊天、提交、日志或命令参数中暴露密钥。

## 2. 安装真实可用的版本

先查 registry，再选择版本：

```bash
npm view strata-coder version --registry=https://registry.npmjs.org/
```

如果包存在，优先将客户端固定到确认过的版本，比如 `strata-coder@0.1.0`。命令中的示例版本需要替换成实际选择的版本。首次安装可提前执行 `npx -y strata-coder@0.1.0 --version`，避免 MCP 启动阶段才下载包而超时。

如果返回 404，不要声称已经从 npm 安装。改用用户授权的 `https://github.com/huyinghuan/strata-coder.git` 源码，记录检出的 commit，运行 `npm ci --ignore-scripts`，以绝对 Node 路径和 `src/mcp.js` 启动。网络或权限错误先明确原因，不要换不明镜像。

配置文件由 README 或 `strata-coder.config.example.json` 创建，保存在稳定路径，避免写进 npx 缓存或 node_modules。已有配置不覆盖。所有工作目录必须存在，配置中的相对路径以配置文件所在目录为基准。

`requireChecks` 默认 true，必须选用实际可运行的检查。文件修改限制建议只开放源码；不要通过 `requireChecks:false` 绕开安装验收。工作副本不复制依赖目录，先解决测试所需环境。

## 3. 注册 MCP

三种安装方式的等价启动命令：

```text
npx -y strata-coder@0.1.0 --config /absolute/path/strata-coder.config.json
strata-coder --config /absolute/path/strata-coder.config.json
/absolute/path/node /absolute/path/strata-coder/src/mcp.js --config /absolute/path/strata-coder.config.json
```

只能选择一种并使用实际路径。服务是 stdio，不要把模型 `/v1` 地址注册成 HTTP MCP，也不要额外启动永久监听端口。

### Codex

先检查 `codex mcp list` 和 `codex mcp add --help`。确认无同名项后，可使用官方 CLI：

```bash
codex mcp add strata_coder -- npx -y strata-coder@0.1.0 --config /absolute/path/strata-coder.config.json
```

或合并以下 TOML 到实际生效的配置（默认用户配置为 `~/.codex/config.toml`）：

```toml
[mcp_servers.strata_coder]
command = "npx"
args = ["-y", "strata-coder@0.1.0", "--config", "/absolute/path/strata-coder.config.json"]
startup_timeout_sec = 60
tool_timeout_sec = 60
```

不要同时添加两份服务；存在 `local_coder` 等旧名称且指向相同服务时保留原名更新即可。用 `codex mcp list` 检查注册，重新加载后用实际 MCP 工具调用验证连接；仅有配置列表不足以证明握手或推理成功。参考 [官方 OpenAI 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

### OpenCode 2.x

先识别版本与配置路径，再合并以下对象；常见用户配置位于 `~/.config/opencode/opencode.json` 或 `.jsonc`，项目配置可能覆盖它。

```json
{
  "mcp": {
    "servers": {
      "strata_coder": {
        "type": "local",
        "command": ["npx", "-y", "strata-coder@0.1.0", "--config", "/absolute/path/strata-coder.config.json"],
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
      "command": ["npx", "-y", "strata-coder@0.1.0", "--config", "/absolute/path/strata-coder.config.json"],
      "enabled": true
    }
  }
}
```

用该安装版本的 `opencode mcp list` 检查连接，命令不同则先查 `--help`。参考 [OpenCode 旧版文档](https://opencode.ai/docs/en/mcp-servers/)。其他 Harness 使用 README 的通用 stdio 参数，适配其实际配置结构，不假设所有客户端都接受 `mcpServers`。

## 4. 合并主模型指令

将 `prompts/planner.md` 的规则合并到目标客户端实际读取的项目指令中（例如项目 AGENTS.md），保留已有规则。不把整个 README 当作系统提示词。至少保留：

- 用户可逐任务选择主模型或本地模型；纯方案讨论无需委派。
- 委派小任务、限定文件范围、先查可用检查；保存 task_id 并用 get_task 等待。
- 本地模型修改副本，主模型负责审查、应用补丁和集成后测试。
- `needs_primary` 等失败终态不能当成功，也不允许换 ID 无限重试。

## 5. 验收与交付

1. 启动入口 `--version` 可执行，配置 JSON 可解析，已有客户端设置仍保留。
2. 实际 MCP 会话中发现 `submit_task`、`get_task`、`cancel_task`、`read_artifact`、`get_capabilities` 五个工具；名称可能有客户端前缀。
3. 调用 `get_capabilities` 核对模型、目录、检查和预算。它不调用模型，不能单独证明模型端点可用。
4. 用户授权真实推理时，在允许范围内建临时小项目，配置真实检查、限定源码路径，完成委派、等待、补丁审查及应用后复测。不要拿正在开发的业务文件做安装冒烟实验。
5. 汇报安装来源/版本/commit、修改文件、备份、启动命令、连接结果和实际测试结果。缺权限、待重启或需要用户登录时标明待办。

移除时只删除本服务的配置块及新增的指令片段。先取消本服务相关的运行任务并确认终态；禁用或断开客户端不会自动停止 Worker。保留任务记录和补丁，除非用户要求清理。使用全局安装时可执行 `npm uninstall -g strata-coder`；不要删除其他 MCP、主模型设置或项目文件。
