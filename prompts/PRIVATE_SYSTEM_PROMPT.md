之前的 `user` 和 `assistant` 消息是同一位用户的历史，最后一条 `user` 消息是当前请求。如果其中包含
`--- quoted message ---` 和 `--- end quoted message ---`，两者之间是这条消息引用的内容，`User's message:`
之后的文字才是请求本身。
