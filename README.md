# pawpilot-plugin

Yunzai Bot 的通用聊天与 Function Calling 插件。无需启用任何能力模块即可作为聊天机器人使用：私聊的
自然语言消息会触发；群聊仅在 `@Bot` 时触发；Bot 自己发出的消息（`user_id` 等于 `self_id`）一律忽略，以免回复循环。以 `#` 开头的消息仍交给原有命令插件直接处理；自然语言
可在已启用能力的范围内转换为工具调用或命令派发。

## 配置

全部配置均写入 [`config/config.yaml`](config/config.yaml)，这是 pawpilot-plugin 唯一读取的配置文件。
`provider` 选择模型后端，插件只读取与之同名的小节：

- `dashscope`（默认）：`dashscope.baseURL`、`dashscope.model`、`dashscope.apiKey`、`dashscope.requestTimeoutMs`，
  调用 OpenAI 兼容的 chat/completions 接口。推荐在 Bot 进程环境中设置 `DASHSCOPE_API_KEY`，它优先于
  `dashscope.apiKey`。
- `chatgpt`：`chatgpt.credentialsFile`、`chatgpt.model`、`chatgpt.reasoningEffort`、`chatgpt.requestTimeoutMs`，见下文。

其余顶层字段（能力模块、输入上限、工具轮数、限流、会话与历史恢复等）对两种后端都生效。缺失或非法的数值项
统一回退到 `lib/config.js` 中 `DEFAULTS` 的内置默认值；配置文件仅在修改时间变化时重新解析。

```powershell
$env:DASHSCOPE_API_KEY = 'sk-...'
pnpm app
```

配置中的 `capabilityModules` 是内置白名单模块 id；默认已启用 `phi` 和 `glory-of-kings`。模型发现已支持的
Phi 或王者荣耀意图时会调用对应工具，再交给目标插件的原有命令流程处理。移除这些模块后，pawpilot-plugin 仍可独立
聊天；若本地 `config/config.yaml` 已显式设置 `capabilityModules`，需自行将新模块 id 加入列表。修改模块配置或
集成提示词修改后，由主人发送 `#ai reload`。公共提示词及 `prompts/PRIVATE_SYSTEM_PROMPT.md`、
`prompts/GROUP_SYSTEM_PROMPT.md` 场景提示词会在每次 AI 请求时按需读取，修改后无需执行此命令。普通用户只看到
普通能力，`ownerOnly` 能力会在展示和调用两处拦截。

### 使用 ChatGPT 套餐额度

将 `provider` 设为 `chatgpt` 后，pawpilot-plugin 通过 OpenAI 面向开源与本地部署应用的
[Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) 流程获得 OAuth 凭据，直接调用公开的
`https://api.openai.com/v1/responses`，消耗所登录账号的 ChatGPT 套餐额度而非 API 计费。该能力仍处于预览阶段，账号是否具备套餐使用
资格以登录授权结果为准。

首次使用前在 Yunzai 根目录登录一次：

```bash
node plugins/pawpilot-plugin/scripts/chatgpt-login.js
```

脚本在 `127.0.0.1:1455` 监听回调并打印授权链接（`--port` 可改端口），在同一台机器的浏览器中打开并同意授权即可；
凭据以 600 权限写入 `chatgpt.credentialsFile`（默认 `~/.pawpilot-chatgpt/credentials.json`）。服务器没有浏览器时，
先在本地执行 `ssh -L 1455:127.0.0.1:1455 <服务器>` 转发端口再打开链接。首次登录会动态注册客户端，再次运行脚本时
复用凭据中的 client ID 与 host ID 重新授权。凭据文件每次请求都会重新读取，重新登录后无需重启 Bot。

请求按以下方式与 `runFunctionCalling` 的 chat-completions 约定互相转换（`lib/chatgpt-client.js`）：

- system 消息合并为 `instructions`；assistant 的 `tool_calls` 与 tool 消息分别转为 `function_call` 和
  `function_call_output` 输入项；工具定义转为 Responses 的 function 工具。群聊消息的 `name` 字段没有对应项，
  直接丢弃，发送者身份由正文中的群聊标签提供。
- 预览接口要求 `store: false` 与 `stream: true`，且拒绝 `temperature`、`max_output_tokens` 等采样字段；插件读取
  SSE 流，从 `response.output_item.done` 收集输出，只有收到 `response.completed` 才视为成功。
- 设置了 `reasoningEffort` 时请求附带 `include: ["reasoning.encrypted_content"]`。模型在发起工具调用的那一轮产生的
  加密推理项会挂在 assistant 消息的 `reasoning_items` 上，下一轮以不带 `id` 的 `reasoning` 输入项原样回传，避免
  `store: false` 下每个工具轮重新推理；这些推理项只存在于单次请求的工具循环中，不进入会话历史。
- 每个请求带 `prompt_cache_key`，取值为“机器人 + 群”或“机器人 + 私聊用户”的 SHA-256 摘要，使同一会话的请求
  落到同一前缀缓存，且不向服务商发送原始 QQ/微信号。
- 访问令牌有效期约 1 小时，距过期 5 分钟内自动刷新；refresh token 每次刷新都会轮换，进程内串行刷新并原子写回
  凭据文件。请求返回 401 时强制刷新并重试一次；刷新被拒时需重新运行登录脚本。返回 5xx 时视为临时故障再重试一次，
  两次请求共用同一超时。
- 套餐额度用尽（`subscription_sharing_usage_limit_exceeded` / `subscription_sharing_usage_unavailable`）时向用户
  提示稍后再试。

## 聊天人格与短期上下文

一级提示词中的默认人格是稳定的通用聊天助手：可进行闲聊、解释、创作、角色扮演、学习辅助与建议。用户可在
对话中临时要求语气、角色、称呼、语言或详细程度；最新明确要求只在当前会话生效，说“恢复默认”即可取消。
临时风格不能改变安全、隐私、权限、事实标准或工具边界。

pawpilot-plugin 仅在进程内保存最近完成的文本对话，不写入磁盘，重启即清空。私聊按用户隔离，群聊按群共享；群内只有
完成的 `@Bot` 对话会进入内存上下文。群请求按机器人和群建立静默 FIFO，同群一次只生成一条回复，不显示排队
状态；不同群和私聊仍可并行。工具参数、工具结果、命令派发、失败请求和发送失败的回复不会被保存。可通过以下
配置调整：

```yaml
conversationHistoryTurns: 24
conversationTtlMinutes: 45
conversationMaxChars: 12000
conversationHistoryRecoveryEnabled: true
conversationHistoryRecoveryMaxMessages: 12
groupRequestQueueMaxOutstanding: 8
groupParticipantNameEnabled: true
groupHistoryRecoveryEnabled: true
groupHistoryRecoveryMaxMessages: 64
groupHistoryRecoveryMaxChars: 6000
```

When a private conversation has no in-memory context, such as after a restart,
pawpilot-plugin can recover the latest private messages through a compatible OneBot
adapter. This fallback is enabled by default, reads at most twelve messages, and
automatically falls back to an empty context when the adapter does not support
history retrieval.

群内有人提及机器人时，pawpilot-plugin 会读取该消息之前最多 64 条、合计不超过 6,000 字符的群历史。适配器历史与
TTL 内已完成的 AI 对话会按消息 ID 去重、合并为一条带发送者身份的事件流，再由 12,000 字符的会话预算统一
裁剪。每条消息以 `[<来源> #<引用号> from <昵称> (<用户 ID>)]` 开头，引用号是消息 ID 的 6 位 SHA-256 摘要，
跨请求保持不变，显式引用写作 `[Explicit reply to #<引用号> ...]`；标签中不含原始消息 ID 和 `message_seq`。
每个参与者同时使用协议 `name` 和文本身份标签；关闭 `groupParticipantNameEnabled` 时仍保留文本标签。
当前消息和普通历史中的适配器显式引用都属于各自消息本身，不会被构造成独立发言；历史引用只解析已有消息或
适配器预览，不逐条额外查询。适配器不支持群历史时会安全退化为仅使用内存中的已完成 AI 对话。
`rateLimitMaxConcurrent` 仅限制私聊；群聊并发由上述群级 FIFO 管理。

私聊和群聊中的引用继续使用中性的起止标记，以区分引用内容和当前正文；安全与可信度说明只存在于系统提示词，
不会由插件重复写入用户消息。群聊的历史、已完成交互、机器人回复和当前请求标签仍会保留，用于区分消息来源。

## 集中式集成与已接入能力

所有 AI 适配都由 `plugins/pawpilot-plugin/integrations/` 集中维护，目标插件无需维护
`ai-capabilities.js`。`phi` 与 `glory-of-kings` 集成都只维护已核实的公开命令说明，并将模型选择的命令交给
Yunzai。王者集成支持帮助、营地账号管理、个人扫码登录、主页、战绩、英雄战力和皮肤查询；绑定、切换、删除
营地 ID 与扫码登录须先取得用户对该具体操作的明确确认。全部业务逻辑、权限、确认与回复仍由原插件实现，
AI 不读取或保存 Phi 存档、王者营地数据或登录态。

`prompts/SYSTEM_PROMPT.md` 维护公共身份、行为、安全、隐私和回复规则；私聊与群聊独有规则分别维护在
`prompts/PRIVATE_SYSTEM_PROMPT.md` 和 `prompts/GROUP_SYSTEM_PROMPT.md`。每次请求按“公共规则、当前场景规则、
已启用集成指南”的顺序拼装，只读取当前场景文件。各集成的 `SYSTEM_PROMPT.md` 只能补充经核实的插件能力边界
和命令说明，不能覆盖公共或场景规则，也不能含用户原文、凭据、二维码原文或主人专属细节。Phi 的可用命令范围
由其系统指南约束，不在代码中重复维护命令白名单。公共与当前场景规则合计最多 12,000 字符；
每个集成指南最多 6,000 字符，所有启用指南合计最多 24,000 字符，最终完整系统提示词最多 36,000
字符。

安全日志仅记录请求 ID、用户 ID、工具名、结果码和耗时，绝不记录工具参数、工具结果、API Key 或 token。
涉及隐私的工具结果只用于当前事件回复。

每个成功完成的请求另记一行用量日志：`request=<id> usage provider=<后端> type=<private|group> calls=<模型调用次数>
input=<输入 token> cached=<命中缓存的输入 token> output=<输出 token> reasoning=<推理 token>`，为本次请求所有工具轮的合计。
两种客户端都把各自的 `usage` 字段转换为统一的 `{ inputTokens, cachedTokens, outputTokens, reasoningTokens }`，
后端未返回某项时记为 0。

## 开发

能力协议见 [AI_CAPABILITIES.md](AI_CAPABILITIES.md)。测试无需真实 API：

```powershell
node --test plugins/pawpilot-plugin/tests/*.test.js
```
