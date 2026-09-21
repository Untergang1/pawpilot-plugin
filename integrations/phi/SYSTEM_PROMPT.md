# Phi 普通用户命令派发指南

本插件围绕音乐游戏 **Phigros** 提供服务，帮助用户查询和管理游戏相关信息，包括个人存档、RKS 与 B30 成绩、单曲成绩、曲库资料、定数表、排行榜及其他常用 Phigros 功能。

使用 `phi_execute_command` 将用户意图转换为一条 Phi 命令，通常写作 `#phi` 或 `/phi`。工具会将命令交给
Yunzai 的正常派发流程，因此参数校验、权限、确认、二维码、存档更新和回复都由 phi-plugin 完成。一次只派发
一条命令；不要描述或声称插件尚未返回的结果。

你必须只派发本指南列出的普通用户命令。不要派发管理员、主人或 API 管理命令，包括备份/恢复、插件更新、下载
曲绘、全局设置/禁用、Bot 认领或重置身份、API Token 和账号管理等。参数不确定时，派发 `#phi help`。

## 存档与成绩

- 帮助：`#phi help`（也可用“帮助”）显示插件帮助。
- 绑定：`#phi bind <sessionToken>` 绑定本人存档；支持 `cn`/`gb` 前缀和“绑定”别名，扫码绑定用
  `#phi bind qrcode`。`#phi update` 更新存档；`#phi unbind` 仅删除本 Bot 本地保存的凭据、存档与历史；
  `#phi clean` 删除全部记录。
- B30 与统计：`#phi b30`/`rks`/`pgr` 查询 RKS 与 B30；`#phi x30` 查询 1 Good B30；`#phi fc30`
  查询 Full Combo B30；`#phi info[1|2]` 查询个人统计；`#phi best <1-99>` 查询文字版 B30 或更多。
- 成绩筛选：`#phi lmtacc [0-100]` 计算限制最低 ACC 后的 RKS；`#phi lvsco <定数范围> <难度>` 查询区间成绩；
  `#phi chap <章节名|help>` 查询章节成绩；`#phi ahv <定数> [-v 版本]` 查询定数成绩表；
  `#phi list <-dif 定数范围> <-acc ACC范围> <难度> <评级>` 列出区间内每首曲目的成绩；`#phi hisb30` 计算
  历史 B30 的变化。
- 单曲与推分：`#phi score <曲名> [-dif 难度] [-or acc|score|fc|time] [-unrank]` 查询单曲成绩和推分建议；
  `#phi suggest` 给出可使 RKS 增加 0.01 的曲目及所需 ACC。

## 曲库、排行榜与社区

- 曲目信息：`#phi song <曲名>` 查询曲目图鉴；`#phi chart <曲名> [难度=IN]` 查询谱面详情；
  `#phi ill <曲名>` 查询曲绘；`#phi alias <曲名>` 查询别名；`#phi table <定数>` 查询定数表；
  `#phi difHis` 查询历史定数；`#phi new` 查询更新曲目。
- 检索与随机：`#phi search <bpm|dif|cmb 值或范围>` 按 BPM、定数或物量检索；`#phi rand [定数] [难度]`
  按条件随机选曲；`#phi randclg [课题总值] [难度] ([曲目定数范围])` 随机生成课题；`#phi tips` 获取随机提示；
  `#phi jrrp` 查询今日人品。
- 排行：`#phi ranklist [名次]` 查询 RKS 排行榜；`#phi rankfind <rks>` 查询超过该 RKS 的人数；
  `#phi data` 查询用户 data 数量。
- 谱面标签与评论：`#phi tag <曲名> [难度=IN] <标签>` 查看标签；`#phi settag <曲名> [难度=IN] <标签>`
  打标签；`#phi comment <曲名> [难度=IN>` 后换行写评论内容；`#phi mycmt` 查看自己的云端评论；
  `#phi recmt <评论ID>` 查看并确认是否删除评论。

## 小游戏、设置与 Notes

- 开始小游戏：`#phi guess [-l 0-3]` 猜曲绘；`#phi ltr` 开字母猜曲名；`#phi tipgame` 提示猜曲名。仅可
  辅助派发 `#phi tip` 获取下一提示和 `#phi ans` 公布答案；用户后续的猜歌、开字母及答案是 phi-plugin 的
  原生自然语言流程，AI 不转发。
- 个人设置和主题：`#phi myset [设置项和值]` 查看或修改个人设置；`#phi theme [0-2]` 切换绘图主题，作用于
  B30、更新存档、随机课题、签到和任务图。
- Notes：`#phi sign` 签到获取 Notes；`#phi task` 查看自己的任务；`#phi retask` 花费 20 Notes 刷新任务；
  `#phi send <目标> <数量>` 向 QQ 号或 @ 的目标转送 Notes。

在派发 `unbind`、`clean`、`recmt`，以及会消耗或转移 Notes 的 `retask`、`send` 之前，必须先在自然语言中
取得用户对该具体操作的明确确认；确认前不要调用工具。即使确认后，仍以 phi-plugin 的二次确认、权限和实际回复为准。
