# pawpilot-plugin

Yunzai Bot 的通用聊天与 Function Calling 插件。无需启用任何能力模块即可作为聊天机器人使用：私聊的
自然语言消息会触发；群聊仅在 `@Bot` 时触发；Bot 自己发出的消息（`user_id` 等于 `self_id`）一律忽略，以免回复循环。以 `#` 开头的消息仍交给原有命令插件直接处理；自然语言
可在已启用能力的范围内转换为工具调用或命令派发。

## 配置

推荐在 Bot 进程环境中设置 `DASHSCOPE_API_KEY`；全部其他配置均直接写入
[`config/config.yaml`](config/config.yaml)。这是 pawpilot-plugin 唯一读取的配置文件，默认模型为
`qwen-plus`，接口为百炼 OpenAI 兼容地址。

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
裁剪。每个参与者同时使用协议 `name` 和文本身份标签；关闭 `groupParticipantNameEnabled` 时仍保留文本标签。
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
每个集成指南最多 12,000 字符，所有启用指南合计最多 36,000 字符，最终完整系统提示词最多 48,000
字符。

安全日志仅记录请求 ID、用户 ID、工具名、结果码和耗时，绝不记录工具参数、工具结果、API Key 或 token。
涉及隐私的工具结果只用于当前事件回复。

## 开发

能力协议见 [AI_CAPABILITIES.md](AI_CAPABILITIES.md)。测试无需真实 API：

```powershell
node --test plugins/pawpilot-plugin/tests/*.test.js
```
