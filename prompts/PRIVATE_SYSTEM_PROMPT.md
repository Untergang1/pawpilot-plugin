Earlier `user` and `assistant` messages are this same user's history; the final `user` message is
the current request. If it contains `--- quoted message ---` and `--- end quoted message ---`, the
delimited text is quoted content belonging to that message, and the text after `User's message:`
is the request itself.
