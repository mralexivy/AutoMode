---
name: growth
description: The weekly growth routine for AutoMode: take a metrics snapshot, check every submission in marketing/registry.json, find new lists and directories, and draft the week's posts in one PR. Use it when asked to promote AutoMode, draft social posts, submit to awesome lists or mod catalogues, or report stars and traffic.
---

# Grow AutoMode

Run this once a week from local Claude Code. GitHub keeps traffic for 14 days only, so never skip two weeks. Follow `ship-change` for the PR: one issue and one branch per week, named `chore/growth-<yyyy>-w<nn>`.

## 1. Snapshot

```bash
node marketing/tools/metrics.mts
```

Report the stars, unique visitors and top referrers against last week. A new referrer shows which post or list worked. Write it into the `result` of its registry entry.

## 2. Check every submission

For each entry in `marketing/registry.json` with `open` submissions, read the PR or issue with `gh`. Update its status, and quote any maintainer request in `notes`. Answer a maintainer question in the next draft, and never with a bump comment.

## 3. Find new places

Search GitHub and the web for lists, catalogues and directories that mention effortless, jev-router, claude-router, or Claude Code plugins and mods.

```bash
gh search code "HeyCubit/effortless" --limit 50 --json repository
gh search repos "awesome claude code" --sort stars --limit 30
```

Add each new place to the registry with `reach` (stars), last activity, merge rate of its last 30 closed PRs, its rules and `tier`. Skip a place with no activity in 60 days, a merge rate under 10%, or a topic outside Claude Code and AI coding.

## 4. Draft

- Read new releases and merged PRs since the last week. Each user-visible change can be one post.
- Draft posts in `marketing/posts/` with `status: draft`. Write each one for its channel. Never paste the same text in two places.
- Draft each listing entry and PR body by the list's own rules. One line describes what AutoMode does, and the body leads with the benchmark result and its limit.
- Use the site videos in `site/public/video/` as assets.
- Run `node marketing/tools/post.mts` until every post passes.

## 5. PR

Open the week's PR with the snapshot, the registry changes and the drafts. Its body lists the outward actions the drafts need: which posts to queue, which PRs to open on other repos, which forms to fill in, and the planned dates.

## 6. After the user merges

- Queue the approved Buffer posts: `node marketing/tools/buffer.mts queue <post> --send`. Commit the `queued` status on the next week's branch.
- Open each approved listing PR on its list from the user's account, one per list. Only do this when the user approves that list in this session.
- Hand the user the Reddit, Hacker News, form and email texts to post themselves.

## Never

- Post to Reddit or Hacker News, fill in a web form, or send an email.
- Open a second PR on a list that already has one open.
- Add a number that `post.mts` rejects, or weaken `post.mts` to pass a post.
- Ask anyone for stars or votes.
