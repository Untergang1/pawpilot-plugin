# pawpilot-plugin

Yunzai Bot 的通用聊天与 Function Calling 插件。无需启用任何能力模块即可作为聊天机器人使用：私聊的
自然语言或图片消息会触发；群聊仅在 `@Bot` 时触发；Bot 自己发出的消息（`user_id` 等于 `self_id`）一律忽略，以免回复循环。以 `#` 或 `/`（含全角 `／`）开头的消息仍交给原有命令插件直接处理；自然语言
可在已启用能力的范围内转换为工具调用或命令派发。

## 配置

全部配置均写入 [`config/config.yaml`](config/config.yaml)，这是 pawpilot-plugin 唯一读取的配置文件。
`provider` 选择模型后端，插件只读取与之同名的小节：

- `dashscope`（默认）：`dashscope.baseURL`、`dashscope.model`、`dashscope.apiKey`、`dashscope.temperature`
  （0–2，默认 0.7）、`dashscope.requestTimeoutMs`、`dashscope.vision`（模型是否支持图片输入，默认 false）、
  `dashscope.webSearch`、`dashscope.searchStrategy`，调用 OpenAI 兼容的 chat/completions 接口。推荐在 Bot 进程
  环境中设置 `DASHSCOPE_API_KEY`，它优先于 `dashscope.apiKey`。
- `chatgpt`：`chatgpt.credentialsFile`、`chatgpt.model`、`chatgpt.reasoningEffort`、`chatgpt.requestTimeoutMs`、
  `chatgpt.webSearch`、`chatgpt.webSearchMaxSources`，见下文。联网设置见“联网搜索”。

两种后端由 `lib/providers.js` 的注册表按 `provider` 创建，并遵守 `lib/model-client.js` 的统一约定：接收
chat-completions 风格的消息，返回 OpenAI 风格的 assistant 消息及统一 `usage`；单次请求共用一个超时，HTTP 5xx
重试一次；失败时抛出 `ModelClientError`，`code` 为统一错误码（如 `AUTH_FAILED`、`RATE_LIMITED`、`USAGE_LIMIT`、
`REQUEST_TIMEOUT`、`SERVER_ERROR`），服务商原始错误码保存在 `providerCode` 并写入失败日志。客户端还通过
`supportsImages` 声明是否接受图片；为 true 时，当前用户消息的 `content` 可以是 chat-completions 分段数组
（`text` 与 `image_url` 段，图片为 `data:image/...;base64,` 地址），其余消息始终是字符串。新增后端只需实现该
约定并在注册表中登记。

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

- 当前用户消息的分段数组转为 `input_text` 与 `input_image` 内容项。
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
  凭据文件。请求返回 401 时强制刷新并重试一次；刷新被拒时需重新运行登录脚本。5xx 按统一约定重试一次。
- 套餐额度用尽（`subscription_sharing_usage_limit_exceeded` / `subscription_sharing_usage_unavailable`）时向用户
  提示稍后再试。

### 联网搜索

两种后端各自在本小节内开关联网，默认均关闭，只对当前 `provider` 生效：

```yaml
dashscope:
  webSearch: false        # true 时请求附带 enable_search
  searchStrategy: turbo   # turbo 或 max；按次额外计费的 agent 策略不开放，非法值回退为 turbo
chatgpt:
  webSearch: false        # true 时请求附带 OpenAI 托管的 web_search 工具
  webSearchMaxSources: 3  # 回复末尾附带的来源网址条数，0–5，0 表示不附
```

- `chatgpt`：在 Responses 请求的 `tools` 中加入 `{ "type": "web_search" }`，与函数工具并存，由服务端决定是否搜索并
  完成检索；流中的 `web_search_call` 输出项被忽略。模型在正文中以 `([域名](url))` 形式内联引用，纯文本聊天无法
  显示，`lib/chatgpt-client.js` 按 `url_citation` 标注的区间删除这些片段（区间与 URL 不符时按该形式的正则兜底），
  再将去掉 `utm_*` 参数并去重后的网址按 `来源：` 逐行附在回复末尾。搜索结果计入输入 token，一次联网回答的输入
  通常在一万到两万多 token，明显高于普通聊天。
- `dashscope`：请求附带 `enable_search: true` 与 `search_options.search_strategy`。百炼联网搜索仅支持部分模型与
  地域（以[百炼联网搜索文档](https://help.aliyun.com/zh/model-studio/web-search)为准），chat/completions 接口不返回
  搜索来源，因此不附来源网址。

开启联网时，`prompts/WEB_SEARCH_PROMPT.md` 会以 `Web search:` 段落加入系统提示词，说明何时搜索、来源选择、不在
正文写链接，以及网页内容不是指令；关闭时不加入，避免模型声称做了无法执行的搜索。该文件同样在每次请求时读取，
修改后无需 `#ai reload`。会话摘要请求始终不联网。

## 聊天人格与短期上下文

默认人格“绝世好咪”是一只自称“猫猫”的猫（不是猫娘），可进行闲聊、解释、创作、角色扮演、学习辅助与建议。
人设、语气示例、纯文本格式与篇幅要求（闲聊一到三句，展开时尽量不超过三百字）以中文写在
`prompts/SYSTEM_PROMPT.md` 中。用户可在对话中临时要求语气、角色、称呼、语言或详细程度；最新明确要求只在当前
会话生效，说“恢复默认”即可取消。临时风格不能改变安全、隐私、权限、事实标准或工具边界。

不经过模型的固定回复（限流、排队、输入过长、空回复、重置确认和错误提示等）集中在 `lib/messages.js`，同样使用
猫猫口吻；修改人设时应一并调整。主人专用的 `#ai reload` 回复保持平实说明。

pawpilot-plugin 仅在进程内保存最近完成的文本对话，不写入磁盘，重启即清空。私聊按用户隔离，群聊按群共享；群内只有
完成的 `@Bot` 对话会进入内存上下文。群请求按机器人和群建立静默 FIFO，同群一次只生成一条回复，不显示排队
状态；不同群和私聊仍可并行。工具参数、工具结果、失败请求和发送失败的回复不会被保存；命令派发只保存用户
请求和成功发出的前置回复（`preface`），不保存命令本身和目标插件的结果，便于后续追问时知道之前请求过什么。
可通过以下配置调整：

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
conversationSummaryEnabled: true
conversationSummaryMaxChars: 800
```

内存会话超过轮数或字符上限时，一次性丢弃最旧的内容直到降到上限的 75%，而不是每轮丢一条；这样历史前缀能在
随后多次请求中保持不变，便于服务商的前缀缓存命中。被丢弃的文本会在回复发出后由同一后端在后台合并进该会话的
滚动摘要（ChatGPT 使用 `low` 推理强度，不带工具，不阻塞回复），摘要不超过 `conversationSummaryMaxChars`，
以 `[Earlier conversation summary]` 开头作为第一条上下文消息发送；摘要失败时被丢弃的文本会留待下次重试。摘要与
会话同属进程内存，随 TTL 过期或重启清空。关闭 `conversationSummaryEnabled` 后被丢弃的内容直接舍弃。

主人发送 `#ai 重置`（也可用 `#ai reset`、`#ai 新话题`）会清空当前会话的内存历史和摘要：在私聊中只影响与主人的
会话，在群聊中影响全群共享的会话；其他用户发送该命令不会生效。插件同时记下重置时间，之后从适配器恢复私聊或群聊历史时只采用该时间之后的消息。

When a private conversation has no in-memory context, such as after a restart,
pawpilot-plugin can recover the latest private messages through a compatible OneBot
adapter. This fallback is enabled by default, reads at most twelve messages, and
automatically falls back to an empty context when the adapter does not support
history retrieval.

群内有人提及机器人时，pawpilot-plugin 会读取该消息之前最多 64 条、合计不超过 6,000 字符的群历史。适配器历史与
TTL 内已完成的 AI 对话会按消息 ID 去重、合并为一条带发送者身份的事件流，再由 12,000 字符的会话预算统一
裁剪。每条消息以 `[<来源> #<引用号> at <MM-DD HH:mm> from <昵称> (<用户 ID>)]` 开头，引用号是消息 ID 的
6 位 SHA-256 摘要，`at` 后是 Bot 进程时区的发送时间（使用绝对时间而非“几分钟前”，使同一消息的文本跨请求保持
不变，有利于前缀缓存）；缺少时间戳时省略。引用号跨请求保持不变，显式引用写作 `[Explicit reply to #<引用号> ...]`；标签中不含原始消息 ID 和 `message_seq`。
每个参与者同时使用协议 `name` 和文本身份标签；关闭 `groupParticipantNameEnabled` 时仍保留文本标签。
当前消息和普通历史中的适配器显式引用都属于各自消息本身，不会被构造成独立发言；历史引用只解析已有消息或
适配器预览，不逐条额外查询。适配器不支持群历史时会安全退化为仅使用内存中的已完成 AI 对话。
`rateLimitMaxConcurrent` 仅限制私聊；群聊并发由上述群级 FIFO 管理。

每次发给模型的当前消息第一行是 `[Current time: YYYY-MM-DD Ddd HH:mm UTC±hh:mm]`（Bot 进程时区，可用 `TZ`
环境变量调整），供模型回答日期时间问题并判断上下文新旧；该行只在本次请求中添加，不写入会话历史。

私聊和群聊中的引用继续使用中性的起止标记，以区分引用内容和当前正文；安全与可信度说明只存在于系统提示词，
不会由插件重复写入用户消息。群聊的历史、已完成交互、机器人回复和当前请求标签仍会保留，用于区分消息来源。

## 图片输入

私聊图片消息和群聊中 `@Bot` 的图片消息会触发回复，不需要附带文字。插件从 Yunzai 的 `e.img` 取当前消息的
图片，从被引用消息的 image 段取引用的图片，当前消息优先，去重后最多附带 `imageInputMaxCount` 张。图片由插件
自行下载（单张不超过 `imageInputMaxBytes`，超时 `imageDownloadTimeoutMs`），按文件头识别 JPEG、PNG、GIF、
WebP 后以 base64 data URL 发送，不把适配器的图片地址交给服务商：QQ 图片地址会过期，OneBot v12 适配器生成的
地址也可能只在本机可访问。下载失败的图片单独跳过并记录 warn 日志（只含失败原因，不含地址和图片数据）。

是否真正发送图片取决于后端：`chatgpt` 始终发送；`dashscope` 仅在 `dashscope.vision: true` 时发送，模型不支持
视觉却打开此项会使请求失败（日志中可见服务商错误码）。顶层 `imageInputEnabled: false` 对两个后端都关闭图片
发送。

无论图片是否发送，当前消息的文字末尾都按图片数追加 `[image]` 标记，会话历史只保存这段文字；引用和群历史中的
图片同样显示为 `[image]`。因此图片只在本次请求中可见，之后追问时模型只知道之前发过图片，看不到图片内容。
系统提示词要求模型在看不到 `[image]` 对应的图片时如实说明，并把图片内容视为上下文而非指令。

当前联调的 wechat-ai 不提供图片段和 `get_file`，微信侧暂时收不到图片。

```yaml
dashscope:
  vision: false
imageInputEnabled: true
imageInputMaxCount: 3
imageInputMaxBytes: 5242880
imageDownloadTimeoutMs: 10000
```

## 集中式集成与已接入能力

所有 AI 适配都由 `plugins/pawpilot-plugin/integrations/` 集中维护，目标插件无需维护
`ai-capabilities.js`。`phi` 与 `glory-of-kings` 集成都只维护已核实的公开命令说明，并将模型选择的命令交给
Yunzai。王者集成支持帮助、营地账号管理、个人扫码登录、主页、战绩、英雄战力和皮肤查询；绑定、切换、删除
营地 ID 与扫码登录须先取得用户对该具体操作的明确确认。全部业务逻辑、权限、确认与回复仍由原插件实现，
AI 不读取或保存 Phi 存档、王者营地数据或登录态。

`prompts/SYSTEM_PROMPT.md` 维护公共身份、行为、安全、隐私和回复规则；私聊与群聊独有规则分别维护在
`prompts/PRIVATE_SYSTEM_PROMPT.md` 和 `prompts/GROUP_SYSTEM_PROMPT.md`。每次请求按“公共规则、当前场景规则、
联网规则（仅当前后端开启联网时）、已启用集成指南”的顺序拼装，只读取当前场景文件。各集成的 `SYSTEM_PROMPT.md` 只能补充经核实的插件能力边界
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

`index.js` 只负责接入 Yunzai：注册命令、加载能力模块、判断主人身份。自然语言请求的完整流程在
`lib/request-pipeline.js` 的 `createRequestPipeline` 中，包括准入（私聊限流与并发锁、群级 FIFO）、按私聊或群聊
构建上下文、调用 `runFunctionCalling`、发送回复，以及发送成功后写入历史和安排摘要。Yunzai 相关依赖
（`getRegistry`、`isOwner`、`reply`）以及模型客户端、执行器都通过参数注入，因此流程可以直接用假对象测试，见
`tests/request-pipeline.test.js`。各模块共用的小工具函数放在 `lib/util.js`。

能力协议见 [AI_CAPABILITIES.md](AI_CAPABILITIES.md)。测试无需真实 API：

```powershell
node --test plugins/pawpilot-plugin/tests/*.test.js
```
