/**
 * Fixed user-facing replies sent without the model, written in the default 猫猫 voice
 * so they match model replies. Owner-only operational replies stay plain.
 */
export const MESSAGES = Object.freeze({
  inputTooLong: maxChars => `这条消息有点长，猫猫一口吃不下喵~请控制在 ${maxChars} 个字以内再发给猫猫吧。`,
  rateLimited: '猫猫有点忙不过来啦，稍等一会儿再来找猫猫喵~',
  privateBusy: '猫猫还在处理你的上一条消息，等猫猫回完再说喵~',
  groupBusy: '群里找猫猫的人有点多，猫猫排不过来啦，稍后再试试喵~',
  emptyReply: '猫猫一下子不知道怎么回答，换个说法再问问猫猫吧喵~',
  emptyMessage: '猫猫在呢喵~想聊什么或者需要帮忙，直接告诉猫猫吧。',
  toolRoundLimit: '这件事步骤有点多，猫猫这次没能做完喵~把问题拆小一点再试试吧。',
  incomplete: '猫猫这次没能完成，稍后再试试喵~',
  resetPrivate: '好哒，猫猫已经开启新话题，之前聊的内容不会再带进来啦喵~',
  resetGroup: '好哒，猫猫已经为本群开启新话题，之前的群聊内容不会再带进来啦喵~',
  error: {
    apiKeyMissing: '猫猫暂时还不能说话喵~请主人设置 DASHSCOPE_API_KEY 或 pawpilot-plugin/config/config.yaml 中的 dashscope.apiKey。',
    chatgptReauth: '猫猫的 ChatGPT 登录已失效喵~请主人按 pawpilot-plugin 文档重新运行登录脚本。',
    usageLimit: '猫猫今天的额度暂时用完啦，晚点再来找猫猫喵~',
    rateLimited: '找猫猫的请求太多啦，稍后再试试喵~',
    unavailable: '猫猫这会儿有点迷糊，稍后再试试喵~'
  }
})
