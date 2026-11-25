# Prompt links

A prompt link opens Fleet ADE with a prompt ready to send. Use one to share a prompt on social
media, or to put a one-click fix in a PR comment.

A link never runs anything. It opens a draft. You read the prompt, then press Send. A link cannot
change your permission mode, branch, or worktree. Your own defaults apply.

## Make a link

Open the command palette and choose **Copy prompt link**. It copies the draft in the composer.
When the project is on GitHub, **Copy prompt link with repo and model** also adds the repository
and the model you picked. Sent messages have a **Copy prompt link** button too.

You can also write a link by hand:

```
t3code://new?prompt=Rate%20my%20swearing
t3code://new?prompt=Fix%20the%20build&repo=owner/name&provider=codex&model=gpt-5.5
t3code://new?pr=owner/name/123&prompt=Fix%20the%20failing%20check
```

| Parameter  | Meaning                                                             |
| ---------- | ------------------------------------------------------------------- |
| `prompt`   | The prompt. Required, except on PR links. At most 8,000 characters. |
| `repo`     | A GitHub repository, as `owner/name` or its URL.                    |
| `provider` | An agent such as `codex` or `claude`.                               |
| `model`    | A model of that agent, by its id or name.                           |
| `pr`       | A GitHub PR, as `owner/name/123` or its URL.                        |

Encode the prompt for a URL. In JavaScript, use `encodeURIComponent`.

## Open a link

Open the link in the desktop app. A browser that is already connected to a computer can open the
same draft from the app's own address.

- **No `repo`**: the draft opens without a project, on the computer you used last.
- **`repo`**: the draft opens in your most recently used project for that repository. A fork
  counts only for its own owner. When you do not have the repository, choose **Clone** or **Use
  without project**.
- **`provider` and `model`**: used when you have that agent set up. Otherwise your default
  model is used, and Fleet ADE tells you.
- **`pr`**: opens the thread linked to that PR on any connected computer, with the prompt
  in its composer. When no thread is linked, the draft goes on the PR branch in a new
  worktree. Fleet ADE checks the code out only after you confirm, because the checkout runs your
  setup script on it.

A thread link with a prompt puts the prompt in that thread's composer. If you already typed a
draft there, Fleet ADE asks before it replaces it.

Fleet ADE removes characters you cannot see, such as zero-width and hidden tag characters, because
they can hide instructions for the agent. When a prompt had them, Fleet ADE warns you that it may be
malicious.

## Share a thread

**Copy thread** copies a link to that thread. Paste it anywhere, such as Slack, a GitHub comment,
or your notes. Opening it in the desktop app opens the thread. Only someone connected to the
computer that runs the thread can see it. In Fleet ADE, a thread link in a message opens the thread
in the app.
