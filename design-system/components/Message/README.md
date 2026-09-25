Transcript message with avatar, author and time, plus agent and IRC variants.

Provide the author, time and body. Agent messages get the `agent` role tag and a tinted bubble so they can never be mistaken for a person. Use `.ax-mention` for @names and `code` for commands. With IRC mode on, render each line as `.ax-irc` (`[hh:mm] <nick> text`), which is what the IRC bridge also shows. Luna drops the avatars and puts each message in a gradient bubble.
