# 接入别的 agent

小鱼自己有两个可替换的部件，接别的 agent 就是替换或借用其中一个：

| 部件 | 在哪 | 换掉意味着 |
|---|---|---|
| **大脑**（谁在思考、谁决定说什么） | `src/dsh-client.js`：`session/create｜prompt｜cancel｜selectModel` + 一条事件流（`turn/start`、`assistant/message`、`tool/call`、`tool/result`、`turn/end`） | 换成别的 agent 运行时 |
| **手**（能做什么） | 84 个 QQ 工具，全是 MCP server（`src/mcp-*.js`） | 这一层**与 agent 无关**：任何支持 MCP 的 agent 都能直接用 |

所以有四个方向，成本从「改配置」到「改协议」：

---

## 方向 A：把某个 CLI agent 当成模型（改配置）

DSH 自带 `model-router` 插件，认得 12 个外部 CLI agent（`claude-code`、`codex`、`gemini`、`kimi-code`、
`opencode`、`pi`、`grok-build`、`minimax-code`、`mimo-code`、`opencode`、`stepcode`、`hermes`、`zcode`）。
它把这些 CLI 包装成「模型」，出现在 DSH 的模型目录里，控制台「配置 → 大脑」可以切，桥接的
`config.json` 里就是 `dsh.provider` / `dsh.model`。

- 要先装并登录那个 CLI（`~/.dsh/model-router/state.json` 的 `health.tools` 里能看到每个的安装/登录状态）；
- 优点：不用写代码；缺点：它们是**编码 agent**，说话习惯是「工作区、命令行、审批」，接聊天容易串味儿，
  而且**不一定支持 MCP**（不支持就用不了那 84 个工具，她连消息都发不出去）。

结论：适合「临时把脑子换成别人试试」，不适合长期当聊天大脑。

---

## 方向 B：她叫别的 agent 干活（已内置，默认关闭）

新工具 `qq_ask_agent`（`src/agent-delegate.js`）：

```jsonc
// config.json
"socialV2": {
  "tools": { "askAgent": true },          // 默认 false：不打开连工具描述都不发
  "agents": {
    "opencode": { "path": "C:\\path\\to\\opencode-cli.exe" },  // 可选，不填自动找
    "codex":    { "path": "C:\\Users\\你\\.local\\bin\\codex.cmd" }
  }
}
```

打开后要**重启 DSH**（工具清单在启动时读）。

调用示例（她自己会这么调）：

```
qq_ask_agent(agent="opencode", prompt="把下面这段 Node 代码改成读取 argv[2]：<代码>", timeoutSec=180)
```

约束（都在代码里，不是靠提示词）：

- **只在管理员私聊**（`private:主人QQ`）可用，群聊/别人私聊一律拒绝 —— 否则群里一句话就能借它动本机文件；
- prompt ≤ 4000 字，超时 10~600 秒（默认 120），输出截断到 4000 字；
- 不用 shell 启动，cwd 固定为程序目录，模型不能自己选路径；
- 只认白名单 agent（`opencode` / `codex`），不接受任意命令。

花的是**另一个账号的额度**，所以默认关闭。

---

## 方向 C：让它们用她的工具（改它们的配置）

OpenCode / Codex / WorkBuddy 都自带 `mcp` 管理（WorkBuddy 的 `app.asar` 里打包了
`@modelcontextprotocol/sdk`，是 MCP 客户端）。把她的 QQ 工具挂进去，它们就能以「她」的身份读消息、
发表情、看图片：

```powershell
# OpenCode（桌面版自带 CLI）
$cli = "$env:LOCALAPPDATA\Programs\@opencodedesktop\resources\opencode-cli.exe"
& $cli mcp add xiaoyu-qq -- node "<程序目录>\src\mcp-snowluma-safe.js"
& $cli mcp add xiaoyu-web -- node "<程序目录>\src\mcp-web-search-safe.js"

# Codex
codex mcp add xiaoyu-qq -- node "<程序目录>\src\mcp-snowluma-safe.js"
```

注意：她的发送类工具要 `key` + **会话令牌**，那个令牌是桥接每条唤醒临时下发的（见唤醒提示
`【会话令牌】`）。所以这类接入适合「读」和「在已知会话里发」，不适合长期无人值守；令牌轮换后就失效了。

---

## 方向 D：换掉 DSH 做 backend adapter（工作量大）

把 `dsh-client.js` 那几个接口抽成接口层，另写一个实现（自研循环 / 本地模型 / 别的 agent SDK）。
难点不在 `prompt`，在**事件语义**要逐个对齐：

| 事件 | 桥接拿它干什么 |
|---|---|
| `turn/start` / `turn/end` | 判回合边界、防并发唤醒、租约兜底 |
| `assistant/message` | 取回复正文 + token 用量（账本、花费页都靠它） |
| `tool/call` / `tool/result` | 判断「消息是否已由工具发出」、打转检测、工具日志 |
| `approval/requested` / `question/requested` | 转发成人话问管理员 |
| `session/snapshot` / `session/event` | 断线重连后补回进行中的回合 |

少一个，就会出现「重复回复」「回合永远不收尾」「token 记不上账」这类问题 —— 所以这条路是周级别，
不是一次改造。

---

## 本机现状（2026-10-27 实测）

| agent | 状态 |
|---|---|
| OpenCode | 桌面版自带 CLI **v2.0.32**，`opencode run "…"` 直接可用（默认模型 `flint-40b-free`），5 秒内返回 |
| Codex CLI | 已装：`C:\Users\best\.local\bin\codex.cmd`，支持 `codex exec` / `codex mcp` |
| WorkBuddy | 已装（`Programs\WorkBuddyAI`，37.10.3），Electron + MCP 客户端；**没有 CLI/HTTP 出口**，所以只能它调别人，不能被别人调 |
| Claude Code / Gemini / Kimi | 未安装（DSH 的 model-router 认得，装上就能出现在模型目录里） |

由此，当前能立刻用的组合是：**她 `qq_ask_agent` → OpenCode / Codex**，以及 **OpenCode / Codex → 她的 MCP 工具**。
WorkBuddy 只能在它自己的设置里加 MCP server（同上一条命令，换成 UI 填），拿不到「被她调用」的接口。
