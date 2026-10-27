---
description: AutoMode usage report. Shows actual model calls, tokens, cache use, and estimated API cost for this session. --trace adds per-stage cost; --routes shows the router's model and effort per request, checked against the transcript; --kpi shows cost per accepted task, rework, stage routes and fixed-model baselines.
allowed-tools: Bash(node:*)
---

Run this command and show its output to the user exactly as it is. Do not add an analysis unless the user asks for one.

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/am-usage.mjs" $ARGUMENTS`
