# Security policy

AutoMode is a Claude Code mod. A mod is code that runs with the permissions of the person who installs it, and it is not sandboxed. We take reports about it seriously.

## What AutoMode does

You can list what AutoMode does without running it:

```bash
claude plugin validate ./AutoMode
```

The README explains each call in [Review it before you install it](README.md#review-it-before-you-install-it). In short:

- It makes no network calls of its own. It has no `$.http.fetch` and no MCP calls.
- It writes only to its own data folder, `~/.claude/plugins/data/automode/`, and, with `debugLog` on, to a log in the plugin folder.
- It starts four commands: `chmod` and `rm -f` on its own data files, and the read-only `git rev-parse` and `git status`.
- It never stores or sends the value of `ANTHROPIC_API_KEY`. It only tests whether the variable is set.

## Report a vulnerability

Please do not open a public issue for a security problem.

1. Go to the **Security** tab of this repository and choose **Report a vulnerability**. This opens a private advisory that only the maintainers can read.
2. Say what you found, how to reproduce it, and which version you tested. Add the output of `/automode debug`.

We aim to reply within seven days. We will tell you when a fix is released, and we will credit you in the release notes if you want that.

## Supported versions

Only the latest release gets security fixes.

## What counts

Examples we want to hear about:

- A path where AutoMode writes outside its own folders.
- A way for a prompt, a tool result or a file to make the guardian store a secret in plain text.
- A way to make the git guard or the subagent guard allow a destructive command.
- A secret, a token or private data in this repository.

## Not in scope

- Claude Code's own behavior. Report that to Anthropic.
- A mod that you installed from another author.
- The fact that a mod runs with your permissions. That is how mods work.
