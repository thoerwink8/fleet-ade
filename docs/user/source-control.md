# Source control

Fleet ADE integrates with GitHub to clone and publish repositories, create PRs, and review
changes.

## Review turn changes

A turn's changed files and diff show only the turn's own work. When a turn pulls, merges, or
rebases, the files Git brought in are left out. A file stays in the list when the turn edited it,
committed it, or fixed a conflict in it. Use the branch comparison to review everything that changed
against your base branch. Restore still returns the saved file snapshot.

On web and desktop, open the Diff pane source picker and choose **Commits** to review one local
commit at a time. The list shows the newest 100 commits in the branch comparison. A merge commit
shows its changes against its first parent.

A commit link from a supported code host opens in the Diff pane when the thread's repository has
that commit locally, on any branch. Otherwise a PR commit link opens the PR. Other
commit links follow your **Open links in** setting; on web, when that opens a new tab, Fleet ADE first
shows an **Open link** button. Command/Ctrl+Click always opens the link in your browser. Commit links follow the **Open PRs in Fleet ADE**
setting in **Settings → Appearance → Diffs**.

## Connect an account

Install Git and configure authentication on the computer running your Fleet ADE background service. For a remote
computer, do this on the remote computer. After signing in, open **Settings → Code → Source control**
and choose **Rescan**.

### GitHub

Fleet ADE talks to GitHub's API directly and only needs a token. Any of these works, in this
order of precedence:

1. A token saved in **Settings → Code → Source control → GitHub**. It is kept in the server's secret
   store, and works without the GitHub CLI.
2. `GH_TOKEN` (`GH_ENTERPRISE_TOKEN` with `GH_HOST` for GitHub Enterprise Server) in the
   server's environment.
3. [GitHub CLI](https://cli.github.com/) 2.81.0 or newer, signed in with `gh auth login`.

If `gh` is signed in to several accounts or hosts, expand **GitHub** in the same place to pick
the account each host uses or turn a host off. A saved token or `GH_TOKEN` takes precedence
over that choice; a host turned off stays off either way.

For GitHub Enterprise, sign in with `gh auth login --hostname YOUR_HOST`. Fleet ADE treats a
custom server name as GitHub once it has a credential for that host.

## Start, clone, or publish a project

To start from nothing, choose **New project** in the command palette (`Cmd/Ctrl+K`), or
**New project** under **Add Project** on any client, and type a name. Fleet ADE makes a Git
repository in `~/.t3/projects` (the `projects` folder of your T3 data directory) with a README,
an icon, and a first commit, then opens a new thread in it. Until the project has a thread, new
threads work in its folder, even when your default is a new worktree. The folder is named after the project,
like `pinball-stats` for "Pinball Stats". Turn on **Create private repository on GitHub** to also
publish it. If Git has no name or email on that computer, the project is created without the
first commit.

Use **Add Project** in the command palette (`Cmd/Ctrl+K`) to clone a repository. Paste the
repository's clone URL, then choose where to save it. The project opens right away while the
clone runs in the background: you can write your first prompt, and sending waits until the files
are in place. A toast tracks progress and lets you cancel; if the clone fails, retry it from the
toast or from the banner above the composer. When the host refuses that computer's SSH key, Fleet ADE
clones over HTTPS with Git's credentials for that host instead, and the project's remote uses the
HTTPS URL.

To lay clones out like [ghq](https://github.com/x-motemen/ghq), turn on **Clone into host folders**
under **Settings → Threads**. Clones then default to
`<host>/<owner>/<repo>` under **Add project starts in**, so set that to `~/ghq` to share ghq's
folders. You can still change the destination before cloning.

For a local Git repository without a remote, **Publish Repository** creates a hosted repository,
adds it as `origin`, and pushes your commits. If there are no commits yet, it creates the remote;
make your first commit before pushing.

## Create a PR

Use a thread's Git actions to commit, push, and create a PR. Fleet ADE can generate commit
messages, review titles, and descriptions from your changes. Descriptions also draw on the work in
the thread, including the checks it ran.

An existing fork PR can appear beside the branch even if you pushed without setting an upstream.
If its badge is missing because several remotes hold that branch, set the branch's upstream to
the intended remote with `git branch --set-upstream-to=<remote>/<branch>`.

Choose how commit messages and PR titles and descriptions are written in
**Settings → Code → Source control → Commits & PRs**. **Repository conventions** uses the
project's instructions and recent commit subjects. **Custom instructions** applies your own
instructions to commits and PRs.

## Review PRs

Open **PRs** to browse PRs, view their changed files, and inspect pipeline runs.
The page keeps the list, search, and links that open a PR's diff. PR creation
remains available from a thread's Git actions.

The diff view supports comparing all commits or one commit, loading large changes in pages, opening
the file tree, and changing the layout, wrapping, whitespace, and file visibility options.

The pipeline section shows the repository's runs grouped by status. Each run includes its status,
metrics when available, and a link to its logs or run details.

Agents can monitor a PR with `watch_pull_request`. The server continues checking the
PR and notifies the agent for failed or completed checks, review changes, conflicts, and
other watch events. See [Linked PRs](#linked-prs) for the monitoring rules.

PR sharing is off by default. In Settings → Connections → PR sharing,
choose **Read PRs** or **Read and act** for each
environment you trust to share its source control access.
Enable both the original environment and the environment answering its requests on this client.
**Read and act** can use broader permissions than the original environment's credential;
only enable it for environments you control and trust. Changing a saved endpoint or removing an
environment clears its permission.

Diffs, linked PR status, and permitted source-control reads can then use another connected
environment signed in to the same account on the same host. Each needs a project on that host.
A connected local environment is preferred for actions and can answer slow or failed reads.
Browsers need a paired environment to use its GitHub credentials.
Credentials stay on their machines. Previously verified credentials remain usable for routing
for ten minutes during a GitHub outage; new credentials must be verified first. Listings, diffs,
and checkout or PR creation from Git actions continue to use the project's environment.

## Troubleshooting

- **Not authenticated:** run `gh auth login` on the server, then rescan.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0, or save a token in Settings → Code → Source control.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS
  remotes can require separate setup from the Git host's API access.
- **A PR cannot load:** open it on the host website while resolving connectivity,
  permissions, or rate limits.

## Linked PRs

A thread can hold several PRs, including reviews from another repository on the same host.
Use **Link PR** in the command palette or **Linked PRs** panel, or right-click a
PR link in the conversation. Creating a PR from Git actions links it automatically,
and so does an agent creating one with `gh pr create`. Agents can link other
PRs with the `link_pull_request` tool.

Use **Link PR to thread** in the command palette to keep a PR with the thread. From a review
on the PRs page, **Link to thread** lets you search for an active thread. The review header
also lists the threads that link to it, including archived threads, so you can return to their context.

Thread badges show a stack's layer count or the current review number with a count of additional
links. Clicking a badge with more than one review opens the **Linked PRs** panel.

The **Linked PRs** panel lists every review and groups stacks. Unlink a review from its
row menu. An unlinked stack layer stays out of later syncs. Open linked reviews refresh on the server;
closed reviews refresh periodically so reopening one on the host is detected. Merged reviews refresh
when requested. Marking a thread complete refreshes its open and closed reviews once; after that they stop refreshing until you unmark it complete. With **Auto-complete merged threads** enabled, a thread can mark complete after every linked
review is terminal. An open or unsynced link keeps it active.

Ask the agent to watch, monitor, or babysit a PR and it calls `watch_pull_request`. While
the thread is active, the server checks the PR every two minutes and resumes the agent when a
check fails or waits for a maintainer's approval, the required checks pass, someone else comments or reviews, or the branch starts to
conflict. On github.com it also wakes the agent, with GitHub's reason, when the merge queue drops
the PR without merging it. Threads in a project that watch the same PR share one check. On GitHub, a check
first asks whether anything changed and reads the PR only when it did, which keeps
watching inside GitHub's rate limit. Comments from your own account do not wake it. Watching ends
when the PR merges or closes, after 10 resumes in a row that bring only comments, after 8
failed reads in a row, or when you press Stop on the thread. A rate limit only pauses watching.
Completing or archiving a thread also ends all its watches. Unmark the thread complete before starting a new
watch. Watching a PR again does not repeat check or conflict news its last
watch already reported; unlinking the PR clears that. Subagents cannot watch PRs; the thread that delegated to them does. To start or stop
it yourself, use the row menu in the **Linked PRs** panel. In the thread details card, a
watched PR shows an eye; click it to stop watching.

A watched thread counts as working while the PR still has checks running, so it stays in
the **Working** section, including after the agent pushes a fix. Once every check has finished,
including review bots that report as checks, the thread returns to the top of the list: what happens next is
up to a person. That includes a workflow waiting for a maintainer to approve it, which runs only
once someone does. The watch stays on and still resumes the agent on new comments, failed checks or
conflicts, and a watched thread never auto-completes.

Cross-repository links use a project on the same host.

## GitHub stacks

The PRs page shows each PR's position in its GitHub stack. Open the stack badge in a
review to navigate its layers. **Merge stack** submits the selected PR and every unmerged
layer below it to GitHub together, respecting branch rules and merge queues. The confirmation shows
the scope and merge strategy. GitHub rebases the remaining stack after merging.

**Rebase stack** updates remote branches from bottom to top without changing your local checkout.
It can rewrite history and restart checks. If a layer fails, earlier updates remain; resolve that
layer before retrying. GitHub may require manual conflict resolution after a lower layer is amended,
even when its changes look independent. Stack actions require an environment that supports them.
