# Marketing

This folder holds how AutoMode gets found: where it is listed, what is posted, and what each step did. The maintainer runs it from local Claude Code with the `growth` skill. Nothing here ships to users.

| Path | What it holds |
|---|---|
| `registry.json` | Every list, directory and community, with its rules, status and result. Read it before any submission. |
| `posts/<date>-<slug>.md` | One post per file, with its channel, status and assets. |
| `metrics/<date>.json` | GitHub snapshots: stars, views, clones, referrers, release downloads. |
| `tools/post.mts` | Checks posts. |
| `tools/metrics.mts` | Takes a snapshot. |
| `tools/buffer.mts` | Queues an approved post to Buffer. |

## Commands

```bash
node marketing/tools/metrics.mts              # a snapshot; run it at least every 13 days
node marketing/tools/post.mts                 # checks every post
node marketing/tools/buffer.mts channels      # needs BUFFER_API_KEY
node marketing/tools/buffer.mts queue marketing/posts/<file>.md          # dry run
node marketing/tools/buffer.mts queue marketing/posts/<file>.md --send   # queues it
```

## A post

```markdown
---
channel: x
status: draft
date: 2026-11-16
assets: [site/public/video/benchmark-race.mp4]
---
First part.
<!-- next -->
Second part of a thread.
```

- `channel` is one of `x`, `bluesky`, `linkedin`, `threads`, `mastodon`, `discord`, `reddit`, `hn`, `devto`, `hashnode`, `hackernoon`, `newsletter` or `listing`.
- `status` moves `draft`, then `approved`, then `queued`, then `sent`. Merging the weekly PR approves its posts. Only `buffer.mts` sets `queued`.
- `assets` are files under `site/public/` or `https://` URLs. Buffer fetches them from the live site.

## Rules

`npm test` runs `tests/marketing.test.mts`, which fails on any post that breaks them.

- Every dollar amount and percentage comes from the README benchmark section or `bench/results/headline.json`. A new result reaches posts through the `publish-results` skill.
- A comparison with Opus names the Sonnet high limit or links the benchmark. The saving is real for sessions that start on Opus. A reader on Sonnet high doing long tasks saves little.
- No claim against jev-router or claude-router. They were audited, not run.
- Costs are list-price equivalents. Never call them subscription savings.
- The maintainer posts from their own accounts and says they built AutoMode.
- Write external text by hand. Leave out any "Generated with" line.
- Never coordinate votes. Never post in old threads. Send one submission per list.
- Reddit, Hacker News, web forms and emails are posted by hand. Tools only prepare them.
- Do not put secrets, personal paths, private messages or anyone's email address in this folder. It is public.
