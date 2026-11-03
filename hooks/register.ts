// Generated from hooks/ at commit c13d44f77e970b4af030b31884735ef4356122d1 by tools/release.mts. The readable source is hooks/ on the main branch.
// hooks/lib/io.ts
function sid($) {
  return $.session.id();
}
function sessionModel($) {
  return $.session.model();
}
function fsRead($, ...args) {
  return $.fs.read(...args);
}
function fsWrite($, ...args) {
  return $.fs.write(...args);
}
function sessionUsage($) {
  return $.session.usage();
}
function fsExists($, ...args) {
  return $.fs.exists(...args);
}
function fork($, ...args) {
  return $.model.fork(...args);
}

// hooks/register.ts
import { COMPACT_SYSTEM as COMPACT_SYSTEM2, transcriptOf as transcriptOf2 } from "./lib/compact.ts";

// hooks/lib/prices.ts
var ANTHROPIC = {
  provider: "anthropic",
  source: "platform.claude.com pricing (Opus 5.5, Sonnet 5.5, Haiku 5.5 list prices)",
  checkedAt: "2026-10-17",
  rates: {
    opus: { input: 4, output: 20, cacheReadX: 0.05 },
    sonnet: { input: 2, output: 10, cacheReadX: 0.05 },
    haiku: { input: 0.1, output: 0.5, cacheReadX: 0.1, longContext: { above: 1e5, multiplier: 5 } }
  }
};
function rateAt(rate, promptTokens) {
  if (!rate.longContext || promptTokens <= rate.longContext.above) return rate;
  const m = rate.longContext.multiplier;
  return { ...rate, input: rate.input * m, output: rate.output * m };
}
var cacheWriteX = (ttlMs2) => ttlMs2 >= 36e5 ? 2 : 1.25;

// hooks/lib/guardian.ts
var MODE_RANK = { off: 0, observe: 1, recommend: 2, assist: 3, auto: 4 };
function modeOf(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "shadow") return "observe";
  if (s === "on") return "assist";
  return s in MODE_RANK ? s : "observe";
}
var atLeast = (m, floor) => MODE_RANK[m] >= MODE_RANK[floor];
var GUARDIAN_DEFAULTS = {
  mode: "observe",
  everySession: false,
  warnRequests: 55,
  warnUsd: 4.5,
  pauseFactor: 2,
  repeatCalls: 3,
  weakOutcomes: true,
  turnBudgetUsd: null,
  hardPause: false,
  minContextTokens: 15e4,
  handoffTokens: 4e3,
  rebuildTokens: 2e4,
  summaryTokens: 1e4,
  margin: 0.2,
  compactStaleShare: 0.5,
  horizon: 8,
  coldReturnRate: 0.09,
  autoCompact: false,
  reduceOutputs: false,
  reduceAboveChars: 12e3
};
var newTurn = (turnId, at2, authorized = 0) => ({
  turnId,
  startedAt: at2,
  requests: 0,
  usd: 0,
  sinceOutcome: { requests: 0, usd: 0 },
  outcomes: [],
  calls: {},
  failures: {},
  editsSinceCheck: 0,
  newFiles: [],
  filesSinceOutcome: 0,
  authorized,
  noted: "normal",
  writesInFlight: false
});
var CHECK = /\b(go (test|vet|build)|npm (run )?(test|build|lint|typecheck)|pnpm (test|build)|yarn (test|build)|node --test|pytest|jest|vitest|make (test|check|build|lint)|claude plugin (test|validate)|tsc|cargo (test|build|check)|xcodebuild|swift (test|build)|mvn (test|verify)|gradlew? (test|build))\b/;
var FAILED = /\b(FAIL(ED)?|error TS\d+|Error:|failed|panic:|Traceback|exit code [1-9]|✗|ERR!)/i;
var ZERO_FAILURES = /\b(fail(?:ed|ures?|ing)?|errors?)\s*[:=]?\s*0\b|\b0\s+(fail(?:ed|ures?|ing)?|errors?)\b/gi;
var failedOutput = (isError, text) => isError || FAILED.test(text.replace(ZERO_FAILURES, ""));
var COMMIT = /\bgit commit\b/;
var TRANSACTIONAL = /\bgit (rebase|merge|cherry-pick|am|revert|stash pop)\b|\b(migrate|terraform apply|kubectl apply|helm (install|upgrade)|npm publish|docker push)\b/;
var WRITE_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
var WRITE_CMD = /(^|[^<>&0-9])>{1,2}\s*(?!&|\/dev\/)[\w./~-]|\b(sed|perl)\s+-[a-z]*i|\btee\b|\b(mv|cp|rm|mkdir|touch|ln|truncate|install)\s|\bgit\s+(apply|am|checkout\s+--|restore|mv|rm)\b|\b(npm|pnpm|yarn)\s+(install|add|remove)\b|\bpatch\b/;
function fingerprint(tool, input) {
  if (tool === "Bash") return `Bash:${String(input.command ?? "").replace(/\s+/g, " ").trim()}`;
  if (tool === "Read") return `Read:${input.file_path}:${input.offset ?? 0}:${input.limit ?? ""}`;
  if (tool === "Grep" || tool === "Glob") return `${tool}:${input.pattern}:${input.path ?? ""}:${input.glob ?? ""}`;
  if (WRITE_TOOLS.has(tool)) return `${tool}:${input.file_path ?? input.notebook_path}:${hash(String(input.new_string ?? input.content ?? JSON.stringify(input.edits ?? "")))}`;
  return `${tool}:${hash(JSON.stringify(input))}`;
}
function hash(s) {
  let h2 = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h2 ^= s.charCodeAt(i);
    h2 = Math.imul(h2, 16777619);
  }
  return (h2 >>> 0).toString(16);
}
var failureHash = (text) => hash(text.replace(/\b0x[0-9a-f]+\b|\b\d+(\.\d+)?(ms|s)?\b/gi, "#").replace(/\s+/g, " ").trim().slice(-4e3));
function observeTool(t, o, weak = true) {
  const fp = fingerprint(o.tool, o.input);
  const command = o.tool === "Bash" ? String(o.input.command ?? "") : "";
  if (!(command && CHECK.test(command) && t.editsSinceCheck > 0)) t.calls[fp] = (t.calls[fp] ?? 0) + 1;
  const bashWrite = !!command && command.split(/&&|\|\||;|\n/).some((seg) => WRITE_CMD.test(seg) && !CHECK.test(seg));
  t.writesInFlight = WRITE_TOOLS.has(o.tool) || TRANSACTIONAL.test(command) || bashWrite;
  if (bashWrite && !o.isError) t.editsSinceCheck += 1;
  let outcome = null;
  if (WRITE_TOOLS.has(o.tool) && !o.isError) {
    t.editsSinceCheck += 1;
    const file = String(o.input.file_path ?? o.input.notebook_path ?? "");
    if (file && !t.newFiles.includes(file)) {
      if (t.newFiles.length < 500) t.newFiles.push(file);
      t.filesSinceOutcome += 1;
    }
    if (weak && t.filesSinceOutcome >= 3) outcome = "files-changed";
  }
  if (o.tool === "ExitPlanMode" && !o.isError) outcome = "plan-approved";
  if (command && COMMIT.test(command) && !failedOutput(o.isError, o.text)) outcome = "commit";
  if (command && CHECK.test(command)) {
    const failed = failedOutput(o.isError, o.text);
    if (failed) {
      const h2 = failureHash(o.text);
      const prev = t.failures[fp];
      t.failures[fp] = { hash: h2, repeats: prev && prev.hash === h2 && t.editsSinceCheck > 0 ? prev.repeats + 1 : prev && prev.hash === h2 ? prev.repeats : 1 };
    } else {
      if (t.editsSinceCheck > 0 || t.failures[fp]) outcome = "check-passed";
      delete t.failures[fp];
    }
    t.editsSinceCheck = 0;
  }
  return outcome;
}
function observeOutcome(t, kind, at2) {
  t.outcomes.push({ kind, at: at2, request: t.requests });
  t.sinceOutcome = { requests: 0, usd: 0 };
  t.filesSinceOutcome = 0;
  t.noted = "normal";
}
function observeRequest(t, usd) {
  t.requests += 1;
  t.usd += usd;
  t.sinceOutcome.requests += 1;
  t.sinceOutcome.usd += usd;
}
function assess(t, c) {
  const reasons = [];
  const repeats = Object.values(t.calls).filter((n) => n >= c.repeatCalls).length;
  const sameFailures = Math.max(0, ...Object.values(t.failures).map((f) => f.repeats));
  const scale = 1 + t.authorized;
  const R = c.warnRequests * scale, U2 = c.warnUsd * scale;
  const s = t.sinceOutcome;
  const overBudget = c.turnBudgetUsd !== null && t.usd >= c.turnBudgetUsd * scale;
  if (overBudget) reasons.push(`turn budget $${c.turnBudgetUsd} reached`);
  if (sameFailures >= 3) reasons.push(`the same check failed ${sameFailures} times with changes in between`);
  if (s.requests >= R * c.pauseFactor && s.usd >= U2 * c.pauseFactor) reasons.push(`${s.requests} requests and $${s.usd.toFixed(2)} since the last outcome`);
  if (reasons.length) return { level: "pause", reasons, repeats, sameFailures };
  if (s.requests >= R && s.usd >= U2) reasons.push(`${s.requests} requests and $${s.usd.toFixed(2)} since the last outcome`);
  if (sameFailures >= 2 && s.requests >= R / 2) reasons.push(`the same check failed ${sameFailures} times`);
  if (repeats >= 2 && s.requests >= R / 2) reasons.push(`${repeats} calls repeated ${c.repeatCalls}+ times`);
  if (reasons.length) return { level: "warning", reasons, repeats, sameFailures };
  if (s.requests >= R / 2 || repeats >= 1) return { level: "optimize", reasons: [repeats ? "a call was repeated" : "long stretch without an outcome"], repeats, sameFailures };
  return { level: "normal", reasons, repeats, sameFailures };
}
var RANK = { normal: 0, optimize: 1, warning: 2, pause: 3 };
function noteFor(t, a) {
  if (RANK[a.level] < RANK.warning || RANK[a.level] <= RANK[t.noted]) return null;
  t.noted = a.level;
  const done = t.outcomes.length ? t.outcomes.map((o) => o.kind).join(", ") : "no verified outcome yet";
  if (a.level === "warning") return `AutoMode checkpoint: ${a.reasons.join("; ")}. Outcomes this turn: ${done}. Before the next step, state in one or two lines what is done, what blocks, and whether the current approach is working; change the approach if it is not. A focused check beats a full suite, and a bounded subagent beats more reads in this context.`;
  return `AutoMode pause: ${a.reasons.join("; ")}. Outcomes this turn: ${done}. Finish the step in progress so nothing is left half-written, then stop and report: what was accomplished, what remains, why the current approach is not converging, and the next concrete action. Do not start another attempt in this turn. The person can reply "am:continue" to allow more work.`;
}
var safeToAbort = (t) => !t.writesInFlight;
function lifecycleCosts(i, c) {
  const r = ANTHROPIC.rates[i.family];
  const inp = r.input / 1e6, read2 = inp * r.cacheReadX, write = inp * cacheWriteX(i.ttlMs);
  const cold = i.idleMs > i.ttlMs;
  const keep = (tokens, warm) => (warm ? tokens * read2 : tokens * write) + Math.max(0, i.horizon - 1) * tokens * read2;
  const p = cold ? 1 : i.pCold ?? 0;
  const cont = (1 - p) * keep(i.contextTokens, true) + p * keep(i.contextTokens, false);
  const summarize = (cold ? i.contextTokens * write : i.contextTokens * read2) + c.summaryTokens * r.output / 1e6;
  const compacted = i.baseTokens + c.summaryTokens + Math.max(0, i.contextTokens - i.staleTokens - i.baseTokens) * 0.25;
  const compact = summarize + keep(compacted, false);
  const fresh2 = i.baseTokens + c.handoffTokens + c.rebuildTokens;
  const clear = keep(fresh2, false);
  return { continue: cont, compact, clear };
}
function lifecycle(i, c) {
  const costs = lifecycleCosts(i, c);
  if (i.contextTokens < c.minContextTokens) return { action: "continue", costs, why: `context ${Math.round(i.contextTokens / 1e3)}k is below ${c.minContextTokens / 1e3}k` };
  if (i.openFailures > 0) return { action: "continue", costs, why: "open failures: a reset would drop their diagnostics" };
  const beats = (x) => x < costs.continue * (1 - c.margin);
  if (i.taskClosed && beats(costs.clear) && costs.clear <= costs.compact) return { action: "clear", costs, why: "the task ended on an outcome and a fresh session with a handoff is cheaper" };
  if (beats(costs.compact) && i.staleTokens > c.compactStaleShare * i.contextTokens) return { action: "compact", costs, why: "most of the context predates this task and a summary is cheaper" };
  return { action: "continue", costs, why: "continuing is the cheapest option" };
}
var LIFECYCLE_PRIORS = { regrowthTokens: 3e3, pLoss: 0.2, basis: "prior" };
function expectedLifecycle(i, c, p = LIFECYCLE_PRIORS) {
  const r = ANTHROPIC.rates[i.family];
  const inp = r.input / 1e6, read2 = inp * r.cacheReadX, write = inp * cacheWriteX(i.ttlMs);
  const cold = i.idleMs > i.ttlMs;
  const pCold = cold ? 1 : i.pCold ?? 0;
  const n = Math.max(1, i.horizon);
  const later = (base) => {
    let t = 0;
    for (let k = 1; k < n; k++) t += (base + k * p.regrowthTokens) * read2 + p.regrowthTokens * write;
    return t;
  };
  const firstKeep = (1 - pCold) * i.contextTokens * read2 + pCold * i.contextTokens * write;
  const laterKeep = later(i.contextTokens);
  const summarize = (cold ? i.contextTokens * write : i.contextTokens * read2) + c.summaryTokens * r.output / 1e6;
  const compacted = i.baseTokens + c.summaryTokens + Math.max(0, i.contextTokens - i.staleTokens - i.baseTokens) * 0.25;
  const firstCompact = compacted * write;
  const laterCompact = later(compacted);
  const recovery = p.pLoss * c.rebuildTokens * (write + Math.max(0, n - 2) * read2);
  const keep = firstKeep + laterKeep;
  const compact = summarize + firstCompact + laterCompact + recovery;
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  return { keep: r6(keep), compact: r6(compact), delta: r6(keep - compact), parts: { firstKeep: r6(firstKeep), laterKeep: r6(laterKeep), summarize: r6(summarize), firstCompact: r6(firstCompact), laterCompact: r6(laterCompact), recovery: r6(recovery) }, basis: "prior" };
}
function shouldOffer(last2, action, contextTokens, knownCold = false) {
  if (action === "continue") return false;
  if (!last2 || last2.action !== action || knownCold) return true;
  return contextTokens >= last2.contextTokens * 1.25;
}
var KEEP_LINE = /error|fail|exception|traceback|panic|warn|denied|forbidden|fatal|assert|expected|✗|×|\bat .+:\d+/i;
function reduceOutput(text, aboveChars, savedAt) {
  if (text.length <= aboveChars) return { text, reduced: false, keptLines: 0, droppedLines: 0 };
  const lines = text.split("\n");
  const keep = /* @__PURE__ */ new Set();
  for (let i = 0; i < Math.min(40, lines.length); i++) keep.add(i);
  for (let i = Math.max(0, lines.length - 40); i < lines.length; i++) keep.add(i);
  for (let i = 0; i < lines.length; i++) if (KEEP_LINE.test(lines[i])) {
    for (let j = i - 1; j <= i + 1; j++) if (j >= 0 && j < lines.length) keep.add(j);
  }
  const out = [];
  let gap = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      if (gap) out.push(`… ${gap} lines omitted …`);
      gap = 0;
      out.push(lines[i].length > 2e3 ? `${lines[i].slice(0, 2e3)} …` : lines[i]);
    } else gap += 1;
  }
  if (gap) out.push(`… ${gap} lines omitted …`);
  const note = savedAt ? `[AutoMode shortened this output from ${text.length} characters; every error and warning line is kept. The full output is at ${savedAt}: Read it if you need the rest.]` : `[AutoMode shortened this output from ${text.length} characters; every error and warning line is kept.]`;
  const body = out.join("\n");
  if (body.length > text.length * 0.7) return { text, reduced: false, keptLines: lines.length, droppedLines: 0 };
  return { text: `${note}
${body}`, reduced: true, keptLines: keep.size, droppedLines: lines.length - keep.size };
}
var DOCUMENT_READ = /^mcp__.*(read_document|fetch|get_document|read_file|get_page)/i;
var reducible = (tool) => tool === "Bash" || /^mcp__.*(search|snapshot|list|query|logs?)/i.test(tool) && !DOCUMENT_READ.test(tool);
var SECRET = /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b|((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)\S+/gi;
var scrub = (s) => s.replace(SECRET, (m, _k, assign) => assign ? `${assign}[redacted]` : "[redacted]");
var RESTRICTION = /\b(?:do not|don't|never|no need to|without)\b[^.\n]{0,80}?\b(?:commit|push|merge|deploy|delete|remove|modify|change|touch|edit|run|install|publish|rebase)\b[^.\n]{0,60}/gi;
var restrictionsIn = (text) => [...new Set((text.match(RESTRICTION) ?? []).map((r) => scrub(r.trim().slice(0, 160))))];
function buildCheckpoint(i) {
  const failing = i.checks.filter((c) => !c.passed).map((c) => c.command);
  const open = Object.keys(i.turn.failures).map((f) => scrub(f.replace(/^Bash:/, "").slice(0, 160)));
  return {
    v: 1,
    sessionId: i.sessionId,
    cwd: i.cwd,
    at: i.at,
    objective: scrub(i.objective),
    acceptance: [],
    stage: i.closed ? "done" : "in progress",
    status: i.closed && !open.length && !failing.length ? "closed" : "open",
    outcomes: i.turn.outcomes.map((o) => o.kind),
    filesChanged: [...i.turn.newFiles],
    filesRead: i.filesRead.slice(-20),
    checks: i.checks.map((c) => ({ command: scrub(c.command), passed: c.passed })),
    openFailures: [.../* @__PURE__ */ new Set([...open, ...failing.map(scrub)])],
    git: i.git,
    approvals: [...i.approvals, ...i.restrictions.map((r) => `restriction: ${r}`)],
    next: scrub(i.next)
  };
}
function verifyRestore(cp, now3) {
  const problems = [];
  if (cp.git.branch !== now3.branch) problems.push(`branch is ${now3.branch ?? "none"}, the checkpoint was on ${cp.git.branch ?? "none"}`);
  const gone = cp.git.dirty.filter((f) => !now3.dirty.includes(f));
  if (gone.length) problems.push(`no longer uncommitted: ${gone.slice(0, 5).join(", ")}${gone.length > 5 ? " …" : ""}`);
  return { ok: problems.length === 0, problems };
}
function validateCheckpoint(cp, now3, cwd, maxAgeMs = 24 * 36e5) {
  const missing = [];
  if (!cp) return { ok: false, missing: ["checkpoint"] };
  if (cp.v !== 1) missing.push("version");
  if (!cp.objective?.trim()) missing.push("objective");
  if (!cp.next?.trim()) missing.push("next action");
  if (!cp.git || cp.git.branch === void 0) missing.push("git state");
  if (cp.cwd !== cwd) missing.push("same project");
  if (typeof cp.at !== "number" || now3 - cp.at > maxAgeMs) missing.push("fresh (24 h)");
  if (cp.status === "open" && !cp.filesChanged?.length && !cp.checks?.length && !cp.outcomes?.length) missing.push("work state of an open task");
  return { ok: missing.length === 0, missing };
}
function sealCheckpoint(cp) {
  const { sum: _drop, ...body } = cp;
  return JSON.stringify({ ...body, sum: hash(JSON.stringify(body)) });
}
var checkpointSum = (cp) => hash(JSON.stringify(cp));
function openCheckpoint(text) {
  if (!text) return { cp: null, problem: "missing" };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { cp: null, problem: "unreadable" };
  }
  if (parsed?.v !== 1) return { cp: null, problem: "unknown version" };
  const { sum, ...body } = parsed;
  if (typeof sum !== "string" || sum !== hash(JSON.stringify(body))) return { cp: null, problem: "checksum mismatch" };
  return { cp: body, problem: null };
}
function reduceMcp(result, aboveChars, savedAt) {
  const bare = Array.isArray(result);
  const r = bare ? { content: result } : result;
  if (!r || !Array.isArray(r.content) || r.isError || r.structuredContent !== void 0) return null;
  const texts = r.content.filter((b2) => b2?.type === "text" && typeof b2.text === "string");
  const total = texts.reduce((a, b2) => a + b2.text.length, 0);
  if (total <= aboveChars) return null;
  const joined = texts.map((b2) => b2.text).join("\n");
  const red = reduceOutput(joined, aboveChars, savedAt);
  if (!red.reduced) return null;
  const content = [{ type: "text", text: red.text }, ...r.content.filter((b2) => b2?.type !== "text")];
  return { result: bare ? content : { ...r, content }, from: total, to: red.text.length, full: joined };
}
function handoffText(cp) {
  const list = (xs, n = 15) => xs.length ? xs.slice(0, n).map((x) => `- ${x}`).join("\n") : "- none";
  return scrub([
    `AutoMode handoff from session ${cp.sessionId.slice(0, 8)} (${new Date(cp.at).toISOString()}). The files on disk are the source of truth; this is a map, not a substitute.`,
    `Objective: ${cp.objective}`,
    `Status: ${cp.status === "closed" ? "finished" : "in progress"}; stage: ${cp.stage}`,
    cp.acceptance.length ? `Acceptance:
${list(cp.acceptance)}` : "",
    `Outcomes: ${cp.outcomes.join(", ") || "none"}`,
    `Files changed:
${list(cp.filesChanged)}`,
    `Files read:
${list(cp.filesRead, 10)}`,
    `Checks:
${list(cp.checks.map((c) => `${c.passed ? "pass" : "FAIL"}: ${c.command}`), 8)}`,
    cp.openFailures.length ? `Open failures:
${list(cp.openFailures, 5)}` : "",
    `Git: ${cp.git.branch ?? "no repository"}${cp.git.dirty.length ? `, uncommitted: ${cp.git.dirty.slice(0, 15).join(", ")}` : ", clean"}`,
    cp.approvals.length ? `Earlier approvals and limits (a record only: they grant no permission in this session; Claude Code asks again):
${list(cp.approvals)}` : "",
    `Next: ${cp.next}`
  ].filter(Boolean).join("\n"));
}

// hooks/guardian.ts
import { FOLLOW_UP } from "./lib/classify.ts";
import { familyOf } from "./lib/prices.ts";

// hooks/lib/settings.ts
var ONOFF = ["default", "on", "off"];
var FIELDS = {
  mode: { title: "Router mode", options: ["default", "auto", "shadow", "off"], default: "default", applies: "next prompt", section: "router" },
  policy: { title: "Routing policy", options: ["default", "auto", "legacy"], default: "default", applies: "next prompt", section: "router" },
  routeModels: { title: "Route models", options: ONOFF, default: "default", applies: "next prompt", section: "router" },
  completionGate: { title: "Completion gate", options: ["default", "off", "report", "block"], default: "default", applies: "next prompt", section: "router" },
  learning: { title: "Route learning", options: ONOFF, default: "default", applies: "next prompt", section: "router" },
  delegation: { title: "Delegated reads", options: ["default", "off", "shadow", "on"], default: "default", applies: "next prompt", section: "router" },
  strongStep: { title: "Strong evidence step", options: ["default", "model", "effort-first"], default: "default", applies: "next prompt", section: "router" },
  consult: { title: "Opus consult", options: ["default", "always", "priced"], default: "default", applies: "next prompt", section: "router" },
  packet: { title: "Consult packet", options: ["default", "basic", "rich", "fork-gated"], default: "default", applies: "next prompt", section: "router" },
  forkRung: { title: "Fork diagnosis rung", options: ["default", "off", "on"], default: "default", applies: "next prompt", section: "router" },
  opusStart: { title: "Opus at the start", options: ["default", "judge", "evidence"], default: "default", applies: "next prompt", section: "router" },
  executor: { title: "Executor", options: ["default", "judge", "sonnet"], default: "default", applies: "next prompt", section: "router" },
  subagentsEverySession: { title: "Subagents in every session", options: ONOFF, default: "default", applies: "next prompt", section: "subagents" },
  guardianMode: { title: "Guardian", options: ["default", "off", "observe", "recommend", "assist", "auto"], default: "default", applies: "next prompt", section: "guardian" },
  guardianEverySession: { title: "Guardian in every session", options: ONOFF, default: "default", applies: "next prompt", section: "guardian" },
  hardPause: { title: "Hard pause", options: ONOFF, default: "default", applies: "next prompt", section: "guardian" },
  autoCompact: { title: "Auto compact", options: ONOFF, default: "default", applies: "next prompt", section: "guardian" },
  reduceOutputs: { title: "Reduce long outputs", options: ONOFF, default: "default", applies: "next prompt", section: "guardian" },
  layout: { title: "Layout", options: ["expanded", "minimal"], default: "expanded", applies: "now", section: "appearance" },
  theme: { title: "Theme", options: ["native", "automode", "mono", "contrast"], default: "native", applies: "now", section: "appearance" },
  appearance: { title: "Appearance", options: ["auto", "dark", "light"], default: "auto", applies: "now", section: "appearance" },
  metrics: { title: "Bar metrics", options: [], default: "pending,context,cache,cost,guardian,stage", applies: "now", section: "appearance" }
};
var FIELD_NAMES = Object.keys(FIELDS);
function valueOf(field, options2, stored2 = {}) {
  const spec = FIELDS[field];
  const ok = (v) => typeof v === "string" && (spec.options.length === 0 || spec.options.includes(v));
  const given = options2[field];
  if (ok(given) && given !== "default" && !(given === spec.default && ok(stored2[field]) && stored2[field] !== spec.default)) return given;
  if (ok(stored2[field])) return stored2[field];
  return ok(given) ? given : spec.default;
}
var bool = (v) => v === "on" ? true : v === "off" ? false : void 0;
function routerOverrides(options2, stored2 = {}) {
  const out = {};
  const mode = valueOf("mode", options2, stored2);
  if (mode !== "default") out.mode = mode;
  const policy = valueOf("policy", options2, stored2);
  if (policy !== "default") out.policy = policy;
  const rm = bool(valueOf("routeModels", options2, stored2));
  if (rm !== void 0) out.routeModels = rm;
  const gate = valueOf("completionGate", options2, stored2);
  if (gate !== "default") out.completionGate = gate;
  const learning = bool(valueOf("learning", options2, stored2));
  if (learning !== void 0) out.learning = learning;
  const delegation2 = valueOf("delegation", options2, stored2);
  if (delegation2 !== "default") out.delegation = delegation2;
  const executor = valueOf("executor", options2, stored2);
  if (executor !== "default") out.executor = executor;
  const opusStart = valueOf("opusStart", options2, stored2);
  if (opusStart !== "default") out.opusStart = opusStart;
  const forkRung = valueOf("forkRung", options2, stored2);
  if (forkRung !== "default") out.forkRung = forkRung;
  const packet = valueOf("packet", options2, stored2);
  if (packet !== "default") out.packet = packet;
  const consult = valueOf("consult", options2, stored2);
  if (consult !== "default") out.consult = consult;
  const strongStep = valueOf("strongStep", options2, stored2);
  if (strongStep !== "default") out.strongStep = strongStep;
  const sub = bool(valueOf("subagentsEverySession", options2, stored2));
  if (sub !== void 0) out.subagentsEverySession = sub;
  return out;
}
function guardianOverrides(options2, stored2 = {}) {
  const out = {};
  const mode = valueOf("guardianMode", options2, stored2);
  if (mode !== "default") out.mode = mode;
  for (const [field, key] of [["guardianEverySession", "everySession"], ["hardPause", "hardPause"], ["autoCompact", "autoCompact"], ["reduceOutputs", "reduceOutputs"]]) {
    const b2 = bool(valueOf(field, options2, stored2));
    if (b2 !== void 0) out[key] = b2;
  }
  return out;
}
function uiOptions(options2, stored2 = {}) {
  return {
    layout: valueOf("layout", options2, stored2),
    theme: valueOf("theme", options2, stored2),
    appearance: valueOf("appearance", options2, stored2),
    metrics: valueOf("metrics", options2, stored2).split(",").map((s) => s.trim()).filter(Boolean)
  };
}

// hooks/options.ts
var options = {};
var stored = {};
var setOptions = (o) => {
  options = o && typeof o === "object" ? { ...o } : {};
};
var currentOptions = () => options;
var storedOptions = () => stored;

// hooks/ui/publish.ts
import { atom, update } from "claude-code";

// hooks/ui/view.ts
var FAMILY_NAME = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus", fable: "Fable" };
function modelName(model) {
  if (!model) return "—";
  const m = /(haiku|sonnet|opus|fable)[-_ ]?(\d+)(?:[-.](\d+))?/i.exec(model);
  if (!m) return model.replace(/^claude-/, "").slice(0, 18);
  return `${FAMILY_NAME[m[1].toLowerCase()]} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}
function familyOfModel(model) {
  const m = /(haiku|sonnet|opus)/i.exec(model ?? "");
  return m ? m[1].toLowerCase() : null;
}
var EFFORT_NAME = { low: "Low", medium: "Medium", high: "High", xhigh: "X-High", max: "Max" };
var effortName = (e) => e ? EFFORT_NAME[e] : "—";
function usdText(v) {
  if (v === null || v === void 0 || !Number.isFinite(v)) return "—";
  if (v < 5e-3) return "$0.00";
  if (v < 10) return `$${v.toFixed(2)}`;
  if (v < 100) return `$${v.toFixed(1)}`;
  return `$${Math.round(v)}`;
}
function tokensText(n) {
  if (n === null || n === void 0 || !Number.isFinite(n)) return "—";
  if (n < 1e3) return String(Math.round(n));
  if (n < 1e6) return `${Math.round(n / 1e3)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}
function cacheText(until, now3) {
  if (until === null) return "—";
  const ms = until - now3;
  if (ms <= 0) return "cold";
  const min = Math.ceil(ms / 6e4);
  return min <= 1 ? "<1m" : `${min - 1}m`;
}
var CONTEXT_HIGH = 60;
var CONTEXT_FULL = 85;
var COLD_MIN_TOKENS = 6e4;
var LIMIT_ALERT = 90;
var ROLE_STAGE = {
  "automode:explorer": "Discover",
  Explore: "Discover",
  "automode:architect": "Plan",
  "automode:planner": "Plan",
  Plan: "Plan",
  "automode:implementer": "Build",
  "automode:verifier": "Verify",
  "automode:diagnoser": "Verify",
  "automode:reviewer": "Review"
};
var MAIN_STAGE = {
  lookup: "Discover",
  explore: "Discover",
  analyze: "Discover",
  plan: "Plan",
  "plan-approved": "Plan",
  implement: "Build",
  verify: "Verify",
  debug: "Verify",
  reconsider: "Plan",
  review: "Review"
};
var STAGE_ORDER = ["Discover", "Plan", "Build", "Verify", "Review"];
var stageOfRole = (type) => ROLE_STAGE[type] ?? null;
function workflowOf(r) {
  const runs = r.agents.filter((a) => a.workflow);
  const lastRun = runs.length ? runs[runs.length - 1].workflow.runId : null;
  const agents = lastRun ? r.agents.filter((a) => a.workflow?.runId === lastRun) : r.agents.filter((a) => stageOfRole(a.type));
  const byStage = /* @__PURE__ */ new Map();
  for (const a of agents) {
    const s = stageOfRole(a.type);
    if (s) byStage.set(s, [...byStage.get(s) ?? [], a]);
  }
  const quiet = !byStage.size && ["lookup", "implement", "repo-op", "complete"].includes(r.stage);
  const main = lastRun || quiet ? null : MAIN_STAGE[r.stage] ?? null;
  if (!byStage.size && !main && !r.review.required) return [];
  const out = [];
  for (const name of STAGE_ORDER) {
    const list = byStage.get(name) ?? [];
    let state = null;
    if (list.some((a) => a.status === "running")) state = "active";
    else if (list.some((a) => a.status === "failed" || a.result === "failed")) state = "failed";
    else if (list.length) state = "done";
    if (name === main) state = state === "failed" ? "failed" : "active";
    if (name === "Verify" && !list.length && r.lastCheck && main !== "Verify" && STAGE_ORDER.indexOf(main ?? "Discover") >= STAGE_ORDER.indexOf("Verify")) state = r.lastCheck.passed ? "done" : "failed";
    if (name === "Review" && !state && r.review.required) state = "required";
    if (state) out.push({ name, state, agents: list });
  }
  return out;
}
function routingOf(r) {
  if (r.killed) return { label: "ROUTER OFF", tone: "dim", note: "AUTOMODE_ROUTER=off", selectable: false };
  if (!r.enabled) return { label: "ROUTER OFF", tone: "dim", note: "config.json router is not v4", selectable: false };
  if (!r.active) return { label: "NOT ROUTING", tone: "dim", note: `your model runs every prompt${r.subagentsEverySession ? "; subagents are still routed" : ""}`, selectable: false };
  if (r.mode === "off") return { label: "OFF", tone: "dim", note: r.sessionMode === "off" ? "off for this session" : "mode off in settings", selectable: true };
  if (r.mode === "shadow") return { label: "SHADOW", tone: "dim", note: r.providerGuard ? `observing only: auto is unverified on ${r.provider}` : r.sessionMode === "shadow" ? "records only, this session" : "records only", selectable: true };
  return { label: r.policy === "legacy" ? "AUTO · LEGACY" : "AUTO", tone: "route", note: r.sessionMode === "auto" && r.configMode !== "auto" ? "auto for this session" : null, selectable: true };
}
function guardianOf(g) {
  if (g.killed) return { glyph: "–", tone: "dim", label: "Guardian off", state: "off (AUTOMODE_GUARDIAN=off)", on: false };
  if (!g.enabled) return { glyph: "–", tone: "dim", label: "Guardian off", state: g.mode === "off" ? "off" : "not in this session", on: false };
  if (g.paused && !g.continued) return { glyph: "■", tone: "warn", label: "Paused", state: "paused", on: true };
  if (g.continued) return { glyph: "▶", tone: "guard", label: "Continuing", state: "continue approved", on: true };
  if (g.level === "pause" || g.level === "warning") return { glyph: "▲", tone: "warn", label: "Guardian", state: g.level === "pause" ? "not converging" : "cost without progress", on: true };
  if (g.level === "optimize") return { glyph: "◐", tone: "warn", label: "Guardian", state: "watch cost", on: true };
  if (g.offer) return { glyph: "▲", tone: "warn", label: "Guardian", state: g.offer.action === "clear" ? "handoff advised" : "compact advised", on: true };
  return { glyph: "✓", tone: "guard", label: "Guardian", state: g.outcomes ? `healthy · ${g.outcomes} outcome${g.outcomes === 1 ? "" : "s"}` : "healthy", on: true };
}
function alertOf(r, g, u, cache, now3) {
  if (g.enabled && g.paused && !g.continued) {
    return { kind: "paused", key: `paused:${g.paused.at}`, tone: "warn", title: "Guardian paused the turn", line: `${g.paused.reasons.join("; ") || "not converging"}. ${g.outcomes} outcome${g.outcomes === 1 ? "" : "s"} recorded; the checkpoint is saved.`, actions: ["continue", "compact", "handoff"] };
  }
  if (r.active && r.mode === "auto" && r.judgeDown.length && r.judgeDown.length >= 2) {
    return { kind: "judge", key: `judge:${r.judgeDown.join(",")}`, tone: "error", title: "Judges not answering", line: "Routing holds the last route and the effort fallback. No verdict is shown until a judge answers.", actions: ["details"] };
  }
  const open = r.breakers.filter((b2) => b2.until > now3);
  if (r.active && r.mode === "auto" && open.length) {
    const b2 = open[0];
    return { kind: "judge", key: `breaker:${b2.model}:${b2.until}`, tone: "error", title: `${modelName(b2.model)} not answering`, line: `Routing without it for ${Math.max(1, Math.ceil((b2.until - now3) / 6e4))} min${b2.cls ? ` (${b2.cls})` : ""}.`, actions: ["details"] };
  }
  if (g.enabled && g.offer) {
    const k = Math.round(g.offer.contextTokens / 1e3);
    return g.offer.action === "clear" ? { kind: "handoff", key: `offer:clear:${g.offer.at}`, tone: "warn", title: "Handoff advised", line: `Task looks done at ${k}k tokens.${g.offer.saves ? ` A fresh session saves ${g.offer.saves}.` : ""} The checkpoint carries the task over.`, actions: ["handoff", "compact"] } : { kind: "compact", key: `offer:compact:${g.offer.at}`, tone: "warn", title: "Compact advised", line: `Most of the ${k}k context is older than this task.${g.offer.saves ? ` Compacting saves ${g.offer.saves}.` : ""}`, actions: ["compact", "handoff"] };
  }
  if (g.enabled && (g.level === "warning" || g.level === "pause")) {
    return { kind: "warning", key: `level:${g.level}:${g.outcomes}`, tone: "warn", title: g.level === "pause" ? "Not converging" : "Cost without progress", line: `${g.sinceOutcome.requests} requests and ${usdText(g.sinceOutcome.usd)} since the last outcome (gate ${g.gates.requests} / ${usdText(g.gates.usd)}).${g.reasons.length ? ` ${g.reasons[0]}.` : ""}`, actions: ["details", "compact"] };
  }
  if (g.restored) return { kind: "restored", key: `restored:${g.restored.at}`, tone: "guard", title: "Checkpoint restored", line: `The task from session ${g.restored.from.slice(0, 8)} carries on here.`, actions: ["details"] };
  if (cache.state === "cold" && (u.contextTokens ?? 0) >= COLD_MIN_TOKENS) {
    return { kind: "cold", key: `cold:${cache.until}`, tone: "cyan", title: "Cache went cold", line: `The next message rereads ${tokensText(u.contextTokens)} tokens at full price. Compact or hand off first if the task is done.`, actions: ["compact", "handoff"] };
  }
  const limit = u.limits.filter((l) => l.percent >= LIMIT_ALERT).sort((a, b2) => b2.percent - a.percent)[0];
  if (limit) return { kind: "limit", key: `limit:${limit.name}:${Math.floor(limit.percent)}`, tone: "warn", title: "Usage limit close", line: `${Math.floor(limit.percent)}% of the ${limit.name.replace("_", "-")} limit is used.`, actions: ["details"] };
  return null;
}
function buildView(r, g, u, now3, facts2 = { outputStyle: null }) {
  const routing = routingOf(r);
  const routes = r.active && r.mode === "auto" && !r.killed && r.enabled;
  let model;
  let effort;
  if (routes && r.effective.model) model = { name: modelName(r.effective.model), family: familyOfModel(r.effective.model), source: "effective" };
  else if (routes && r.requested) model = { name: modelName(r.requested.model), family: r.requested.family, source: "next" };
  else if (r.effective.model) model = { name: modelName(r.effective.model), family: familyOfModel(r.effective.model), source: "effective" };
  else model = r.sessionModel ? { name: modelName(r.sessionModel), family: familyOfModel(r.sessionModel), source: "app" } : { name: "—", family: null, source: "unknown" };
  const override = !!r.requested && r.requested.owner === "user-override";
  if (routes && r.effective.effort) effort = { name: effortName(r.effective.effort), level: r.effective.effort, source: "effective", override };
  else if (routes && r.requested) effort = { name: effortName(r.requested.effort), level: r.requested.effort, source: "next", override };
  else effort = r.effective.effort ? { name: effortName(r.effective.effort), level: r.effective.effort, source: "effective", override: false } : { name: "—", level: null, source: "unknown", override: false };
  let pending = null;
  if (routes && r.requested && model.source === "effective") {
    if (r.requested.family !== model.family) pending = `→ ${FAMILY_NAME[r.requested.family]} next`;
    else if (r.requested.effort !== effort.level) pending = `→ ${effortName(r.requested.effort)} next`;
  }
  if (routes && r.held) pending = `→ ${FAMILY_NAME[r.held.family]} ${effortName(r.held.effort)} next turn`;
  if (routes && !pending && r.deferredEffort && r.deferredEffort !== effort.level) pending = `→ ${effortName(r.deferredEffort)} at next input`;
  const owner = r.requested?.owner ?? "";
  const hold = routes && /cache/.test(owner + " " + (r.requested?.reason ?? "")) && !/escalat/.test(owner) ? "held: cache warm" : null;
  const escalation2 = routes && /quality-escalation|escalat/.test(owner) ? `↑ ${r.requested?.reason || "quality floor"}` : routes && r.inadequate ? `↑ needs more than ${r.inadequate.route}` : routes && r.consult?.state === "open" ? "↑ asking an Opus architect" : null;
  const percent = u.percent ?? (u.contextTokens !== null && u.window ? Math.round(u.contextTokens / u.window * 100) : null);
  const context = { percent, tokens: u.contextTokens, window: u.window, level: percent === null ? "ok" : percent >= CONTEXT_FULL ? "full" : percent >= CONTEXT_HIGH ? "high" : "ok" };
  const fam = model.family;
  const w = fam ? r.warm[fam] : void 0;
  const cache = { state: !w ? "unknown" : w.until > now3 ? "warm" : "cold", until: w?.until ?? null, ttlMs: r.ttlMs, family: fam };
  const verdictLine = r.verdict ? `${r.verdict.by === "user" || r.verdict.by === "named" ? "You" : r.verdict.by}: ${r.verdict.why}` : null;
  const judge2 = r.judging ? { state: "routing", line: "Routing…" } : r.judgeDown.length ? { state: "down", line: `${r.judgeDown.join(" and ")} judge paused` } : { state: "idle", line: verdictLine };
  const workflow = workflowOf(r);
  const active2 = workflow.find((s) => s.state === "active");
  return {
    at: now3,
    routing,
    model,
    effort,
    pending,
    hold,
    escalation: escalation2,
    context,
    cache,
    cost: { session: u.costUsd, turn: g.turnUsd },
    guardian: guardianOf(g),
    stage: r.planMode ? "Plan mode" : active2 ? active2.name : null,
    judge: judge2,
    alert: alertOf(r, g, u, cache, now3),
    why: whyOf(r, routes, judge2),
    tip: tipOf(r, g, context, facts2),
    workflow,
    router: r,
    guard: g,
    usage: u
  };
}
function whyOf(r, routes, judge2) {
  if (!routes) return null;
  if (judge2.state === "down") return "judges paused, fallback route";
  const o = r.requested?.owner ?? "";
  let w = "";
  if (o === "user-override") w = "your choice";
  else if (/quality-escalation/.test(o)) w = r.requested?.reason || "quality floor";
  else if (/cache/.test(o + " " + (r.requested?.reason ?? ""))) w = "cache is warm, no switch";
  else w = r.verdict?.why || r.requested?.reason || "";
  w = w.replace(/\s+/g, " ").trim();
  return w ? w.length > 52 ? `${w.slice(0, 51)}…` : w : null;
}
var STYLE = "automode:Concise";
function tipOf(r, g, ctx, facts2) {
  const t = (key, text) => ({ key, text, until: 0 });
  if (r.enabled && !r.killed && !r.active) return t("unrouted", "Pick AutoMode in /model to route model and effort automatically.");
  if (r.requested?.owner === "user-override") return t("override", "Your choice is fixed. am:reset returns to automatic.");
  if (ctx.percent !== null && ctx.percent >= 70) return t("ctx", "Context is filling. /compact keeps the task and cuts cost.");
  if (r.active && r.ledger.requests === 0 && !r.verdict) return t("first", "AutoMode picks the model and effort for each prompt. /automode help lists commands.");
  if (facts2.outputStyle !== null && !new RegExp(`${STYLE}|^Concise$`).test(facts2.outputStyle)) return t("style", `Shorter replies: /output-style ${STYLE}`);
  if (r.active && r.ledger.requests >= 3) return t("hm", "am:opus, am:high, am:direct set the route for one prompt. /automode help");
  void g;
  return null;
}
var METRICS = ["pending", "context", "cache", "cost", "guardian", "stage"];
function barSegments(v, columns, now3, shown = METRICS) {
  const has = (m) => shown.includes(m);
  const all = [];
  if (v.routing.label !== "AUTO") all.push({ key: "mode", text: v.routing.label.toLowerCase().replace(" · ", " "), tone: v.routing.tone, drop: 99 });
  all.push({ key: "model", text: `✦ ${v.model.name}`, tone: v.model.source === "effective" ? "text" : "dim", bold: v.model.source === "effective", drop: 99 });
  all.push({ key: "effort", text: v.effort.override ? `${v.effort.name} (yours)` : v.effort.name, tone: v.effort.source === "effective" ? "text" : "dim", drop: 99 });
  if (has("pending") && (v.pending || v.escalation)) all.push({ key: "pending", text: v.pending ?? "↑", tone: v.pending ? "dim" : "warn", drop: 5 });
  if (has("context")) all.push({ key: "context", text: v.context.percent === null ? "—" : `${Math.round(v.context.percent)}%`, tone: v.context.level === "ok" ? "text" : "warn", drop: 4 });
  if (has("cache") && v.cache.state !== "unknown") all.push({ key: "cache", text: cacheText(v.cache.until, now3), tone: v.cache.state === "cold" ? "dim" : "dim", drop: 3 });
  if (has("cost")) all.push({ key: "cost", text: usdText(v.cost.session), tone: v.cost.session === null ? "dim" : "text", drop: 2 });
  if (has("guardian") && v.guardian.on && v.guardian.tone === "warn") all.push({ key: "guardian", text: `${v.guardian.glyph} ${v.guardian.state}`, tone: "warn", drop: 98 });
  if (has("stage") && v.stage) all.push({ key: "stage", text: v.stage, tone: "dim", drop: 1 });
  if (v.why) all.push({ key: "why", text: v.why, tone: "dim", sep: " — ", drop: 0 });
  const width = (list2) => list2.reduce((n, s, i) => n + [...s.text].length + (i ? [...s.sep ?? " · "].length : 0), 0);
  let list = all;
  const steps = [
    (l) => l.filter((s) => s.drop !== 0),
    (l) => l.filter((s) => s.drop !== 1),
    (l) => l.filter((s) => s.drop !== 2),
    (l) => l.filter((s) => s.drop !== 3),
    (l) => l.map((s) => s.key === "pending" ? { ...s, text: s.text.replace(/ (next turn|next|at next input)$/, "") } : s),
    (l) => l.filter((s) => s.drop !== 5),
    (l) => l.filter((s) => s.drop !== 4)
  ];
  for (const step of steps) {
    if (width(list) <= columns) break;
    list = step(list);
  }
  return list.map(({ drop: _d, ...s }) => s);
}
var barText = (segs) => segs.map((s, i) => (i ? s.sep ?? " · " : "") + s.text).join("");

// hooks/ui/publish.ts
var viewAtom = atom({ plugin: "automode", key: "view" }, null);
var sources = null;
var setSources = (s) => {
  sources = s;
};
var uiOff = null;
async function uiDisabled($) {
  if (uiOff === null) {
    try {
      uiOff = ["off", "0", "false"].includes(String(await $.env.get("AUTOMODE_UI") ?? "").trim().toLowerCase());
    } catch {
      uiOff = false;
    }
  }
  return uiOff;
}
var facts = { outputStyle: null };
async function loadFacts($) {
  try {
    const home2 = await $.env.get("CLAUDE_CONFIG_DIR") || `${await $.env.get("HOME")}/.claude`;
    const style = JSON.parse(await fsRead($, `${home2}/settings.json`))?.outputStyle;
    facts = { outputStyle: typeof style === "string" && style ? style : "default" };
  } catch {
    facts = { outputStyle: null };
  }
}
var TIP_MS = 9e4;
var TIP_MAX = 3;
var TIPS_KEY = "automode-tips";
var tipNow = { key: "", until: 0 };
var tipCounts = null;
async function gateTip($, v, now3) {
  const cand = v.tip;
  if (!cand) {
    tipNow = { key: "", until: 0 };
    return v;
  }
  if (tipNow.key !== cand.key) {
    if (tipCounts === null) {
      try {
        tipCounts = await $.store.get(TIPS_KEY) ?? {};
      } catch {
        tipCounts = {};
      }
    }
    const n = tipCounts[cand.key] ?? 0;
    if (n >= TIP_MAX) tipNow = { key: cand.key, until: 0 };
    else {
      tipNow = { key: cand.key, until: now3 + TIP_MS };
      tipCounts = { ...tipCounts, [cand.key]: n + 1 };
      try {
        await $.store.set(TIPS_KEY, tipCounts);
      } catch {
      }
    }
  }
  return { ...v, tip: tipNow.until > 0 ? { ...cand, until: tipNow.until } : null };
}
async function usageSnap($) {
  try {
    const u = await sessionUsage($);
    const limits = Array.isArray(u?.rateLimits) ? u.rateLimits.filter((r) => Number.isFinite(r?.percentUsed)).map((r) => ({ name: String(r.window ?? r.name ?? "usage"), percent: Number(r.percentUsed) })) : [];
    return {
      costUsd: typeof u?.cost?.usd === "number" ? u.cost.usd : null,
      contextTokens: typeof u?.context?.tokens === "number" ? u.context.tokens : null,
      window: typeof u?.context?.window === "number" && u.context.window > 0 ? u.context.window : null,
      percent: typeof u?.context?.percent === "number" ? u.context.percent : null,
      limits
    };
  } catch {
    return { costUsd: null, contextTokens: null, window: null, percent: null, limits: [] };
  }
}
async function snapshotView($) {
  if (!sources) return null;
  let now3 = Date.now();
  try {
    now3 = await $.clock.now();
  } catch {
  }
  let model = null;
  try {
    model = await sessionModel($) ?? null;
  } catch {
  }
  return gateTip($, buildView(sources.router(model, now3), sources.guardian(), await usageSnap($), now3, facts), now3);
}
var last = "";
var keyOf = (session, v) => `${session}|${JSON.stringify({ ...v, at: 0 })}`;
async function publish($) {
  try {
    if (await uiDisabled($)) return;
    const v = await snapshotView($);
    if (!v) return;
    let session = "";
    try {
      session = await sid($);
    } catch {
    }
    const k = keyOf(session, v);
    if (k === last) return;
    last = k;
    await update($, viewAtom, () => v);
  } catch {
  }
}

// hooks/guardian.ts
var MAX_FILES_READ = 200;
var RECORDS_ROTATE_BYTES = 1e6;
var RETENTION_MS = { checkpoints: 7 * 864e5, outputs: 3 * 864e5, guardian: 30 * 864e5 };
var CLEANUP_EVERY_MS = 6 * 36e5;
var freshView = () => ({ assess: null, offer: null, paused: null, checkpoint: null, restored: null, continued: false, last: null });
var fresh = () => ({
  loaded: false,
  cfg: GUARDIAN_DEFAULTS,
  picker: "claude-sonnet-5-5[1m]",
  sessionId: "unknown",
  cwd: "",
  turn: null,
  lastUsd: null,
  contextTokens: 0,
  lastRequestAt: null,
  model: "",
  objective: null,
  taskStartTokens: 0,
  baseTokens: 0,
  closed: false,
  filesRead: [],
  checks: [],
  authorizeNext: false,
  restrictions: [],
  approvals: [],
  lastOffer: null,
  handoff: null,
  handoffSuccessor: false,
  pendingChecked: false,
  records: [],
  recordsPart: 0,
  recordsBytes: 0,
  view: freshView()
});
var G = fresh();
var lastCleanup = 0;
var killedByEnv = false;
var lastEnabled = false;
async function now($) {
  try {
    return await $.clock.now();
  } catch {
    return Date.now();
  }
}
async function dataDir($) {
  let dir;
  try {
    dir = await $.env.get("CLAUDE_PLUGIN_DATA");
  } catch {
  }
  if (dir) return dir;
  let home2;
  try {
    home2 = await $.env.get("CLAUDE_CONFIG_DIR") ?? `${await $.env.get("HOME")}/.claude`;
  } catch {
  }
  return `${home2 ?? "."}/plugins/data/automode`;
}
var safeName = (s) => s.replace(/[^\w.-]/g, "_");
var projectDir = (dir, cwd) => `${dir}/checkpoints/${safeName(cwd).slice(-120)}`;
var sessionFile = (dir, cwd, id) => `${projectDir(dir, cwd)}/${safeName(id)}.json`;
var pendingFile = (dir, cwd) => `${projectDir(dir, cwd)}/pending.json`;
async function load($, again = false) {
  if (G.loaded && !again) return;
  G.loaded = true;
  let cfg2 = { ...GUARDIAN_DEFAULTS };
  try {
    const raw = JSON.parse(await fsRead($, `${$.plugin.root}/config.json`));
    cfg2 = { ...GUARDIAN_DEFAULTS, ...raw.guardian ?? {}, mode: modeOf(raw.guardian?.mode ?? GUARDIAN_DEFAULTS.mode) };
    if (raw.pickerModel) G.picker = raw.pickerModel;
  } catch {
  }
  const over = guardianOverrides(currentOptions(), storedOptions());
  if (Object.keys(over).length) cfg2 = { ...cfg2, ...over, mode: modeOf(over.mode ?? cfg2.mode) };
  try {
    const raw = (await $.env.get("AUTOMODE_GUARDIAN_CONFIG"))?.trim();
    if (raw) {
      const over2 = JSON.parse(raw);
      for (const [k, v] of Object.entries(over2 ?? {})) {
        if (!(k in GUARDIAN_DEFAULTS)) continue;
        const want = typeof GUARDIAN_DEFAULTS[k];
        if (k === "mode") cfg2.mode = modeOf(v);
        else if (k === "turnBudgetUsd" ? v === null || typeof v === "number" : typeof v === want) cfg2[k] = v;
      }
    }
  } catch {
  }
  killedByEnv = false;
  try {
    const env = (await $.env.get("AUTOMODE_GUARDIAN"))?.trim();
    if (env) {
      cfg2 = { ...cfg2, mode: modeOf(env) };
      killedByEnv = cfg2.mode === "off";
    }
  } catch {
  }
  G.cfg = cfg2;
}
async function enabled($) {
  lastEnabled = await isEnabled($);
  return lastEnabled;
}
async function isEnabled($) {
  await load($);
  if (G.cfg.mode === "off") return false;
  let id = G.sessionId;
  try {
    id = await sid($);
  } catch {
  }
  if (id !== G.sessionId) {
    if (G.sessionId !== "unknown") {
      await flushRecords($);
      const keep = { loaded: G.loaded, cfg: G.cfg, picker: G.picker, cwd: G.cwd };
      G = { ...fresh(), ...keep };
    }
    G.sessionId = id;
    await restore($);
  }
  if (G.cfg.everySession) return true;
  try {
    return (await sessionModel($)).trim() === G.picker;
  } catch {
    return false;
  }
}
var PERSISTED = ["objective", "taskStartTokens", "baseTokens", "closed", "filesRead", "checks", "restrictions", "approvals", "lastOffer", "contextTokens", "lastRequestAt", "model", "recordsPart", "cwd"];
async function stateFile($) {
  return `${await dataDir($)}/guardian/${safeName(G.sessionId)}.state.json`;
}
async function persist($) {
  const snap = { v: 1 };
  for (const k of PERSISTED) snap[k] = G[k];
  snap.filesRead = G.filesRead.slice(-50);
  await writeDurable($, await stateFile($), JSON.stringify(snap));
}
async function restore($) {
  try {
    const snap = JSON.parse(await fsRead($, await stateFile($)));
    if (snap?.v !== 1) return;
    for (const k of PERSISTED) if (snap[k] !== void 0 && !(k === "cwd" && G.cwd)) G[k] = snap[k];
  } catch {
  }
}
var notifying = () => atLeast(G.cfg.mode, "recommend");
var assisting = () => atLeast(G.cfg.mode, "assist");
var automatic = () => atLeast(G.cfg.mode, "auto");
async function tighten($, path, mode) {
  try {
    await $.process.run(["chmod", mode, path], { timeoutMs: 3e3 });
  } catch {
  }
}
async function writeDurable($, path, text) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fsWrite($, path, text);
      if (await fsRead($, path) === text) {
        await tighten($, path, "600");
        return true;
      }
    } catch {
    }
  }
  return false;
}
async function record($, r) {
  if (G.sessionId === "unknown") {
    try {
      G.sessionId = await sid($);
    } catch {
    }
  }
  G.records.push({ v: 1, kind: "guardian", at: await now($), sessionId: G.sessionId, ...r });
}
async function flushRecords($) {
  if (!G.records.length) return;
  try {
    const base = `${await dataDir($)}/guardian/${safeName(G.sessionId)}`;
    const file = G.recordsPart ? `${base}.${G.recordsPart}.jsonl` : `${base}.jsonl`;
    let prev = "";
    try {
      prev = await fsRead($, file);
    } catch {
    }
    const add = G.records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await fsWrite($, file, prev + add);
    await tighten($, file, "600");
    G.recordsBytes = prev.length + add.length;
    if (G.recordsBytes > RECORDS_ROTATE_BYTES) {
      G.recordsPart += 1;
      G.recordsBytes = 0;
    }
    G.records = [];
  } catch {
  }
}
async function readCheckpoint($, dir, id) {
  const file = sessionFile(dir, G.cwd, id);
  let text = null;
  try {
    text = await fsRead($, file);
  } catch {
  }
  const main = openCheckpoint(text);
  if (main.cp) return { cp: main.cp, problem: null, usedPrevious: false };
  let prevText = null;
  try {
    prevText = await fsRead($, file.replace(/\.json$/, ".prev.json"));
  } catch {
  }
  const prev = openCheckpoint(prevText);
  return { cp: prev.cp, problem: main.problem, usedPrevious: !!prev.cp };
}
async function cleanup($) {
  const t = await now($);
  if (t - lastCleanup < CLEANUP_EVERY_MS) return;
  lastCleanup = t;
  const dir = await dataDir($);
  const old = [];
  const walk = async (path, maxAge, depth) => {
    let entries = [];
    try {
      entries = await $.fs.list(path);
    } catch {
      return;
    }
    for (const en of entries) {
      const p = `${path}/${en.name}`;
      if (en.kind === "directory" && depth > 0) await walk(p, maxAge, depth - 1);
      else if (en.kind === "file" && en.name !== "pending.json" && en.mtimeMs && t - en.mtimeMs > maxAge && !p.includes(safeName(G.sessionId))) old.push(p);
    }
  };
  await walk(`${dir}/checkpoints`, RETENTION_MS.checkpoints, 1);
  await walk(`${dir}/outputs`, RETENTION_MS.outputs, 1);
  await walk(`${dir}/guardian`, RETENTION_MS.guardian, 0);
  const safe = old.filter((p) => p.startsWith(`${dir}/checkpoints/`) || p.startsWith(`${dir}/outputs/`) || p.startsWith(`${dir}/guardian/`)).slice(0, 200);
  if (!safe.length) return;
  try {
    await $.process.run(["rm", "-f", "--", ...safe], { timeoutMs: 1e4 });
    await record($, { event: "cleanup", removed: safe.length });
  } catch {
  }
}
async function readUsage($) {
  try {
    const u = await sessionUsage($);
    return { usd: u.cost?.usd ?? null, tokens: u.context?.tokens ?? 0 };
  } catch {
    return { usd: null, tokens: 0 };
  }
}
async function guardianSessionStart($, e, next) {
  const res = await next(e);
  try {
    await afterStart($, e, res);
  } catch {
  }
  return res;
}
async function afterStart($, e, res) {
  if (!await enabled($)) return;
  try {
    G.sessionId = await sid($);
  } catch {
  }
  G.cwd = res?.cwd ?? e.cwd ?? G.cwd;
  await loadPending($);
  if (assisting()) await cleanup($);
  await flushRecords($);
}
async function loadPending($) {
  if (G.pendingChecked || !G.cwd) return;
  G.pendingChecked = true;
  try {
    const dir = await dataDir($);
    const pending = JSON.parse(await fsRead($, pendingFile(dir, G.cwd)));
    if (!pending?.sessionId || pending.sessionId === G.sessionId) return;
    const read2 = await readCheckpoint($, dir, pending.sessionId);
    if (read2.problem) await record($, { event: "checkpoint-corrupt", problem: read2.problem, usedPrevious: read2.usedPrevious });
    const v = validateCheckpoint(read2.cp, await now($), G.cwd);
    if (v.ok && pending.cwd !== void 0 && pending.cwd !== G.cwd) v.missing.push("the folder named by the clear");
    if (v.ok && pending.sum !== void 0 && read2.cp && pending.sum !== checkpointSum(read2.cp)) v.missing.push("the checkpoint named by the clear");
    v.ok = v.missing.length === 0;
    if (v.ok) {
      G.handoff = read2.cp;
      G.handoffSuccessor = typeof pending.at === "number" && await now($) - pending.at <= 12e4;
    } else {
      await record($, { event: "handoff-rejected", missing: v.missing });
      await fsWrite($, pendingFile(dir, G.cwd), "{}");
    }
  } catch {
  }
}
async function guardianSessionEnd($, e, next) {
  try {
    if (await enabled($) && e.reason === "clear") {
      const dir = await dataDir($);
      const left = assisting() ? (await readCheckpoint($, dir, G.sessionId)).cp : null;
      if (left) await writeDurable($, pendingFile(dir, G.cwd), JSON.stringify({ sessionId: G.sessionId, at: await now($), cwd: G.cwd, sum: checkpointSum(left) }));
      await record($, { event: "cleared" });
      await flushRecords($);
    }
  } catch {
  }
  return next(e);
}
async function guardianPromptSubmit($, e, next) {
  try {
    await load($, true);
  } catch {
  }
  let ctx = [];
  try {
    if (await enabled($)) ctx = await beforePrompt($, e);
  } catch {
  }
  return next(ctx.length ? { ...e, context: [...e.context ?? [], ...ctx] } : e);
}
async function beforePrompt($, e) {
  const byPerson = e.origin?.kind === "composer" || e.origin?.kind === "bridge" || e.origin?.kind === "sdk";
  const text = String(e.text ?? "").trim();
  if (!byPerson || e.command || e.isMeta || text.startsWith("/")) return [];
  G.authorizeNext = /\bam:continue\b/i.test(text);
  G.view.paused = null;
  G.view.continued = G.authorizeNext;
  G.view.restored = null;
  if (G.authorizeNext) G.approvals.push("am:continue: more work allowed in this turn");
  if (!G.objective || G.closed && !FOLLOW_UP.test(text)) {
    G.objective = scrub(text.replace(/\s+/g, " ").slice(0, 500));
    G.closed = false;
    G.filesRead = [];
    G.checks = [];
    G.taskStartTokens = G.contextTokens;
    G.restrictions = [];
    G.approvals = [];
  }
  G.restrictions = [.../* @__PURE__ */ new Set([...G.restrictions, ...restrictionsIn(text)])].slice(-20);
  const context = [];
  if (!G.cwd) {
    try {
      G.cwd = await $.env.get("PWD") ?? "";
    } catch {
    }
  }
  await loadPending($);
  if (G.handoff) {
    const forced = /\bam:handoff\b/i.test(text);
    const mine = G.handoffSuccessor || forced;
    const leans = mine && (G.handoff.status === "open" || FOLLOW_UP.test(text) || forced);
    const check = verifyRestore(G.handoff, await git($));
    let consumed = true;
    if (!mine) {
      consumed = false;
      await record($, { event: "handoff-foreign", from: G.handoff.sessionId });
    } else if (leans && !assisting()) await record($, { event: "handoff-would-restore", from: G.handoff.sessionId, problems: check.problems });
    else if (leans && !check.ok && !forced) {
      consumed = false;
      await record($, { event: "handoff-held", from: G.handoff.sessionId, problems: check.problems });
      if (notifying()) $.ui.toast(`AutoMode: the task checkpoint was not restored: ${check.problems.join("; ")}. Say "am:handoff" to restore it anyway.`);
    } else if (leans) {
      context.push(handoffText(G.handoff) + (check.ok ? "" : `
Warning: ${check.problems.join("; ")}. Check the working tree before you continue.`));
      G.objective = G.handoff.objective;
      G.restrictions = G.handoff.approvals.filter((a) => a.startsWith("restriction: ")).map((a) => a.slice(13));
      await record($, { event: "handoff-restored", from: G.handoff.sessionId, status: G.handoff.status, verified: check.ok });
      G.view.restored = { from: G.handoff.sessionId, at: await now($) };
      if (notifying()) $.ui.toast("AutoMode: restored the task checkpoint from the cleared session.");
    } else {
      consumed = G.handoffSuccessor;
      await record($, { event: "handoff-not-needed", from: G.handoff.sessionId, successor: G.handoffSuccessor });
    }
    G.handoff = null;
    if (consumed) {
      try {
        await fsWrite($, pendingFile(await dataDir($), G.cwd), "{}");
      } catch {
      }
    }
    await flushRecords($);
  }
  const t = await now($);
  if (G.lastRequestAt !== null && G.contextTokens >= G.cfg.minContextTokens && G.model && t - G.lastRequestAt > 36e5) {
    const d = lifecycle({ family: familyOf(G.model) ?? "opus", contextTokens: G.contextTokens, baseTokens: G.baseTokens || 4e4, staleTokens: Math.max(0, G.contextTokens - (G.baseTokens || 4e4)), idleMs: t - G.lastRequestAt, ttlMs: 36e5, horizon: G.cfg.horizon, taskClosed: G.closed, openFailures: 0 }, G.cfg);
    await record($, { event: "cold-prompt", contextTokens: G.contextTokens, decision: d.action, costs: d.costs });
  }
  await publish($);
  return context;
}
async function guardianTurnStart($, e, next) {
  try {
    if (e.agentId === void 0 && await enabled($) && G.turn?.turnId !== e.turnId) {
      G.turn = newTurn(e.turnId, await now($), G.authorizeNext ? 1 : 0);
      G.authorizeNext = false;
      G.view.assess = null;
      G.lastUsd = (await readUsage($)).usd;
    }
  } catch {
  }
  return next(e);
}
async function guardianStep($, e) {
  if (e.agentId !== void 0 || !await enabled($)) return;
  if (!G.turn || G.turn.turnId !== e.turnId) {
    G.turn = newTurn(e.turnId, await now($), G.authorizeNext ? 1 : 0);
    G.authorizeNext = false;
    if (G.lastUsd === null) G.lastUsd = (await readUsage($)).usd;
  }
  G.model = e.model ?? G.model;
  const u = await readUsage($);
  const delta = u.usd !== null && G.lastUsd !== null ? Math.max(0, u.usd - G.lastUsd) : 0;
  if (u.usd !== null) G.lastUsd = u.usd;
  observeRequest(G.turn, delta);
  G.contextTokens = u.tokens || G.contextTokens;
  if (u.tokens > 5e3 && (!G.baseTokens || u.tokens < G.baseTokens)) G.baseTokens = u.tokens;
  G.lastRequestAt = await now($);
  const a = assess(G.turn, G.cfg);
  G.view.assess = { level: a.level, reasons: a.reasons };
  if (a.level === "pause" && automatic() && G.cfg.hardPause && safeToAbort(G.turn) && G.turn.noted === "pause") {
    await record($, { event: "hard-pause", turnId: e.turnId, reasons: a.reasons, requests: G.turn.requests, usd: G.turn.usd });
    await writeCheckpoint($, "open", `The guardian paused a turn that was not converging (${a.reasons.join("; ")}): reassess the approach before continuing.`);
    await flushRecords($);
    const at2 = await now($);
    try {
      await $.turn.abort({ turnId: e.turnId });
      G.view.paused = { at: at2, reasons: a.reasons };
      G.view.last = { kind: "pause", at: at2, why: a.reasons[0] ?? "not converging" };
    } catch (err) {
      await record($, { event: "hard-pause-unavailable", error: String(err?.message ?? err).slice(0, 120) });
      G.view.last = { kind: "pause not possible here", at: at2, why: "the turn could not be ended; the guardian only advises" };
    }
    await publish($);
  }
}
async function guardianToolCall($, e, next) {
  let watching = false;
  try {
    watching = e.agentId === void 0 && await enabled($);
  } catch {
  }
  if (!watching) return next(e);
  const res = await next(e);
  try {
    return await afterTool($, e, res);
  } catch {
    return res;
  }
}
async function afterTool($, e, res) {
  if (!G.turn || !res || res.deny) return res;
  const input = e.input ?? e;
  const text = typeof res.text === "string" ? res.text : "";
  const outcome = observeTool(G.turn, { tool: e.tool, input, isError: !!res.isError, text }, G.cfg.weakOutcomes);
  if (e.tool === "Read" && input.file_path && !G.filesRead.includes(input.file_path)) G.filesRead = [...G.filesRead, String(input.file_path)].slice(-MAX_FILES_READ);
  if (e.tool === "Bash" && /\b(test|build|tsc|check|lint|vet)\b/.test(String(input.command ?? ""))) {
    G.checks = [...G.checks, { command: scrub(String(input.command).slice(0, 160)), passed: !failedOutput(!!res.isError, text) }].slice(-8);
  }
  if (outcome) {
    observeOutcome(G.turn, outcome, await now($));
    await record($, { event: "outcome", outcome, turnId: G.turn.turnId, requests: G.turn.requests });
  }
  if (outcome === "plan-approved") G.approvals.push("plan approved");
  const a = assess(G.turn, G.cfg);
  const note = noteFor(G.turn, a);
  const before = G.view.assess?.level;
  G.view.assess = { level: a.level, reasons: a.reasons };
  if (note) await record($, { event: a.level, turnId: G.turn.turnId, reasons: a.reasons, requests: G.turn.requests, usd: G.turn.usd, delivered: notifying() });
  if (note) G.view.last = { kind: a.level, at: await now($), why: a.reasons[0] ?? a.level };
  if (outcome || note || before !== a.level) await publish($);
  let out = res;
  if (automatic() && G.cfg.reduceOutputs && reducible(e.tool) && !res.isError) out = await reduce($, e, res);
  if (note && notifying()) out = { ...out, context: [...out.context ?? [], note] };
  return out;
}
async function reduce($, e, res) {
  const id = safeName(String(e.toolUseId ?? e.tool_use_id ?? `${Date.now()}`));
  const path = `${await dataDir($)}/outputs/${safeName(G.sessionId)}/${id}.txt`;
  if (e.tool === "Bash" && res.result && typeof res.result.stdout === "string") {
    const total = res.result.stdout.length + (res.result.stderr ?? "").length;
    if (total <= G.cfg.reduceAboveChars) return res;
    if (!await writeDurable($, path, `${res.result.stdout}
--- stderr ---
${res.result.stderr ?? ""}`)) return res;
    const r = reduceOutput(res.result.stdout, G.cfg.reduceAboveChars, path);
    if (!r.reduced) return res;
    await record($, { event: "reduced", tool: e.tool, from: total, to: r.text.length, path });
    return { result: { ...res.result, stdout: r.text } };
  }
  if (/^mcp__/.test(e.tool)) {
    const probe = reduceMcp(res.result, G.cfg.reduceAboveChars, path);
    if (!probe) return res;
    if (!await writeDurable($, path, probe.full)) return res;
    await record($, { event: "reduced", tool: e.tool, from: probe.from, to: probe.to, path });
    return { result: probe.result };
  }
  return res;
}
async function guardianTurnComplete($, e, next) {
  const res = await next(e);
  try {
    await afterTurn($, e);
  } catch {
  }
  return res;
}
async function afterTurn($, e) {
  if (e.agentId !== void 0 || !G.turn || !await enabled($)) return;
  const t = G.turn;
  const last2 = t.outcomes.at(-1);
  G.closed = !!last2 && last2.request >= t.requests - 5 && Object.keys(t.failures).length === 0;
  await record($, { event: "turn", turnId: t.turnId, requests: t.requests, usd: t.usd, outcomes: t.outcomes.map((o) => o.kind), closed: G.closed });
  const u = await readUsage($);
  G.contextTokens = u.tokens || G.contextTokens;
  const nextStep = String(e.answer ?? "").replace(/\s+/g, " ").slice(-400) || "continue from the last step";
  if (G.contextTokens >= G.cfg.minContextTokens) {
    const li = { family: familyOf(G.model) ?? "opus", contextTokens: G.contextTokens, baseTokens: G.baseTokens || 4e4, staleTokens: Math.max(0, Math.min(G.taskStartTokens, G.contextTokens) - (G.baseTokens || 4e4)), idleMs: 0, pCold: G.cfg.coldReturnRate, ttlMs: 36e5, horizon: G.cfg.horizon, taskClosed: G.closed, openFailures: Object.keys(t.failures).length };
    const d = lifecycle(li, G.cfg);
    await record($, { event: "lifecycle", action: d.action, why: d.why, costs: d.costs, contextTokens: G.contextTokens, expected: expectedLifecycle(li, G.cfg) });
    if (d.action !== "continue") {
      const cp = await writeCheckpoint($, G.closed ? "closed" : "open", nextStep);
      const allowed = d.action === "compact" || !!cp;
      if (allowed && notifying() && shouldOffer(G.lastOffer, d.action, G.contextTokens)) {
        await offer($, d.action, d.costs, G.objective ?? "");
        G.lastOffer = { action: d.action, contextTokens: G.contextTokens };
      }
      await persist($);
      await flushRecords($);
      G.view.continued = false;
      await publish($);
      return;
    }
  }
  if (G.contextTokens >= G.cfg.minContextTokens || G.closed) await writeCheckpoint($, G.closed ? "closed" : "open", nextStep);
  await persist($);
  await flushRecords($);
  G.view.continued = false;
  await publish($);
}
async function offer($, action, costs, objective) {
  const save = `about $${(costs.continue - costs[action]).toFixed(2)} over the next requests`;
  G.view.offer = { action, at: await now($), contextTokens: G.contextTokens, saves: save };
  G.view.last = { kind: action === "clear" ? "handoff advised" : "compact advised", at: G.view.offer.at, why: action === "clear" ? "the task looks done on a large context" : "most of the context is older than the task" };
  if (action === "compact" && G.cfg.autoCompact && automatic()) {
    try {
      const r = await $.session.compact({ instructions: `Keep the objective, the decisions, the files changed, the failing and passing checks, the restrictions, and the next step. Objective: ${objective}` });
      if (!r?.skip) {
        const before = G.contextTokens;
        await record($, { event: "compacted", contextBefore: before, saves: save });
        G.taskStartTokens = 0;
        G.lastOffer = null;
        G.view.offer = null;
        G.contextTokens = (await readUsage($)).tokens || G.contextTokens;
        if (notifying()) $.ui.toast(`AutoMode: compacted a ${Math.round(before / 1e3)}k-token context after this turn (saves ${save}). Set guardian.autoCompact false to stop this.`);
        return;
      }
      await record($, { event: "compact-vetoed", skip: r.skip });
    } catch (err) {
      await record($, { event: "compact-unavailable", error: String(err?.message ?? err).slice(0, 300) });
    }
  }
  if (assisting()) {
    try {
      const shown = await $.prompt.suggest({ text: action === "clear" ? "/clear" : `/compact keep: ${objective.slice(0, 120)}` });
      await record($, { event: "suggested", action, shown: shown?.isShown ?? null });
    } catch (err) {
      await record($, { event: "suggest-unavailable", action, error: String(err?.message ?? err).slice(0, 200) });
    }
  }
  $.ui.toast(action === "clear" ? `AutoMode: this task looks done and the context is ${Math.round(G.contextTokens / 1e3)}k tokens. A fresh session saves ${save}; the checkpoint is saved and restored if you continue the task. ${assisting() ? "Tab, Enter to clear." : "Run /clear to start fresh."}` : `AutoMode: most of this ${Math.round(G.contextTokens / 1e3)}k context is old. Compacting saves ${save}. ${assisting() ? "Tab, Enter to compact." : "Run /compact to shrink it."}`);
}
async function git($) {
  try {
    const b2 = await $.process.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 5e3 });
    if (b2.exitCode !== 0) return { branch: null, dirty: [] };
    const s = await $.process.run(["git", "status", "--porcelain"], { timeoutMs: 5e3 });
    return { branch: b2.stdout.trim(), dirty: s.stdout.split("\n").map((l) => l.slice(3).trim()).filter(Boolean).slice(0, 40) };
  } catch {
    return { branch: null, dirty: [] };
  }
}
async function writeCheckpoint($, status, nextStep) {
  if (!G.turn) return null;
  const cp = buildCheckpoint({
    sessionId: G.sessionId,
    cwd: G.cwd,
    at: await now($),
    objective: G.objective ?? "",
    closed: status === "closed",
    turn: G.turn,
    filesRead: G.filesRead,
    checks: G.checks,
    approvals: G.approvals,
    restrictions: G.restrictions,
    git: await git($),
    next: nextStep
  });
  const v = validateCheckpoint(cp, cp.at, G.cwd);
  if (!v.ok) {
    await record($, { event: "checkpoint-invalid", missing: v.missing });
    return null;
  }
  if (!assisting()) {
    await record($, { event: "checkpoint-would-write", status: cp.status });
    G.view.checkpoint = { at: cp.at, status: cp.status, sum: checkpointSum(cp).slice(0, 8), written: false };
    return cp;
  }
  const dir = await dataDir($);
  const file = sessionFile(dir, G.cwd, G.sessionId);
  try {
    const prev = await fsRead($, file);
    if (openCheckpoint(prev).cp) await writeDurable($, file.replace(/\.json$/, ".prev.json"), prev);
  } catch {
  }
  if (!await writeDurable($, file, sealCheckpoint(cp))) {
    await record($, { event: "checkpoint-write-failed" });
    return null;
  }
  await tighten($, projectDir(dir, G.cwd), "700");
  await record($, { event: "checkpoint", status: cp.status });
  G.view.checkpoint = { at: cp.at, status: cp.status, sum: checkpointSum(cp).slice(0, 8), written: true };
  return cp;
}
function guardianSnapshot() {
  const enabledNow = lastEnabled;
  const a = G.view.assess;
  const offer2 = G.view.offer && G.contextTokens >= G.view.offer.contextTokens * 0.8 ? G.view.offer : null;
  return {
    enabled: enabledNow,
    killed: killedByEnv,
    mode: G.cfg.mode,
    everySession: G.cfg.everySession,
    level: a?.level ?? "normal",
    reasons: a?.reasons ?? [],
    outcomes: G.turn?.outcomes.length ?? 0,
    sinceOutcome: { requests: G.turn?.sinceOutcome.requests ?? 0, usd: G.turn?.sinceOutcome.usd ?? 0 },
    gates: { requests: G.cfg.warnRequests, usd: G.cfg.warnUsd },
    turnUsd: G.turn ? G.turn.usd : null,
    checkpoint: G.view.checkpoint,
    offer: offer2,
    restored: G.view.restored,
    paused: G.view.paused,
    continued: G.view.continued,
    last: G.view.last,
    hardPause: G.cfg.hardPause,
    autoCompact: G.cfg.autoCompact,
    reduceOutputs: G.cfg.reduceOutputs
  };
}

// hooks/v4.ts
import { EFFORTS as EFFORTS3, maxRisk, tierRank as tierRank2 } from "./lib/types.ts";
import { ANTHROPIC as ANTHROPIC2, familyOf as familyOf2, rowFor, usageUsd } from "./lib/prices.ts";
import { isTask, JUDGE_SYSTEM, JUDGE_SYSTEM_V3, JUDGE_SYSTEM_V4, judgePrompt, parseJudge, parseOverride } from "./lib/classify.ts";
import { transitionOf } from "./lib/transition.ts";
import { classifyError, UNCLASSIFIED } from "./lib/errors.ts";
import { stageOf } from "./lib/stage.ts";
import { BAND_OF as BAND_OF2, bandOf, demandBand as demandBand2, ladderStep, nextEffort, TIER_BAND as TIER_BAND2 } from "./lib/bands.ts";
import { DEFAULT_LARGE, interfaceChanges, observedRisk, prospectiveRisk, reviewerFamily } from "./lib/risk.ts";
import { textConsequence } from "./lib/consequence.ts";
import { DEFAULT_PARAMS as DEFAULT_PARAMS2 } from "./lib/policy.ts";
import { continuity as continuity2, noteDrop, observedDrop } from "./lib/continuity.ts";
import { accrueRent } from "./lib/rent.ts";
import { DEFAULT_LADDER as DEFAULT_LADDER2, resolve as resolve2, routeFor as routeFor2 } from "./lib/authority.ts";
import { choose, consultOrSwitch as consultOrSwitch2, workFromFiles, workflowValue } from "./lib/strategy.ts";
import { compactInstructions, injection, isBoundary, newEnvelope, observe, requireReview, summaryOf, withReview } from "./lib/envelope.ts";
import { assessCompletion, blockReason, extractObligations, observeRun, publicObligations, reopen } from "./lib/completion.ts";
import { checkKey, checkPassed, EMPTY_LADDER, escalation, evidencePacket, failureOf, failureStep, fnv1a as fnv1a2, isCheck, isRevert, markFlaky, reviewerBlocked, scopeGrew, withPipefail, writesFiles } from "./lib/failures.ts";
import { classifyOperation } from "./lib/operations.ts";
import { applyPins, commandChoice, readAppChoice, turnAxes } from "./lib/pins.ts";
import { guardTool, READ_ONLY_AGENTS, subagentBlocked } from "./lib/guard.ts";
import { BUDGET_STOP, clampGrep, clampRead, diagnosePrompt, DISCOVERY_REPORT, HAIKU_BUDGET, priorCoverage, validateReport } from "./lib/workers.ts";
import { decisionRecord, needRecord, nextSignal, outcomeRecord, requestRecord, shouldRotate } from "./lib/records.ts";
import { adequacy, attemptCost, CAPABILITY as CAPABILITY2, DEFAULT_PRIORS as DEFAULT_PRIORS2, demandOf, FLOOR_CAPABILITY as FLOOR_CAPABILITY2, mid as mid2, optimize, TASK_STEPS as TASK_STEPS2, tierOf as tierOf2 } from "./lib/optimizer.ts";
import { trigger } from "./lib/triggers.ts";
import { workflowArgs } from "./lib/stages.ts";
import { subagentEffort, subagentRoute } from "./lib/subagents.ts";
import { effortFor, helperEffort, takesEffort, looksLikeRedo as looksLikeRedo2, midTurnNote, REDO_STAY_PROMPTS as REDO_STAY_PROMPTS2, thinkingOf } from "./lib/effort.ts";
import { effortSharesCache, modeOf as modeOf2, providerOf, thinkingRisk, ttlMs } from "./lib/mode.ts";
import { bounded as bounded2, helperFloor, helperQuestion, JUDGE_CALL, JUDGE_SYSTEM as EFFORTLESS_SYSTEM, keepsEffort, parseVerdict } from "./lib/effortless.ts";

// hooks/lib/effortless.ts
var EFFORTS = ["low", "medium", "high", "xhigh", "max"];
function contextFrom(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastAssistant = lastAssistantText(messages);
  return [lastUser ? `user: ${lastUser.text.slice(0, 400)}` : "", lastAssistant ? `assistant: ${lastAssistant.slice(-2e3)}` : ""].filter(Boolean).join("\n");
}
function lastAssistantText(messages) {
  return [...messages].reverse().find((m) => m.role === "assistant" && m.text.trim())?.text ?? "";
}
function withAttachments(text, attachments) {
  if (!attachments?.length) return text;
  const counts = /* @__PURE__ */ new Map();
  for (const a of attachments) counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
  const said = [...counts].map(([type, n]) => `${n} ${type}${n > 1 ? "s" : ""}`).join(", ");
  return `${text}

[The message comes with ${said} to look at.]`;
}
function withMidTurn(text, effort) {
  return `${text}

[Sent while the assistant was still working on the last task at ${effort} effort. If it adds to, corrects or steers that task, keep ${effort}; judge it on its own only if it is a separate new request.]`;
}
function judgeQuestion(prompt, current2, context) {
  return [
    current2 ? `Current: ${current2.model} / ${current2.effort}` : "Current: none",
    context ? `Recent conversation:
${context}` : "",
    `Next message:
${prompt.slice(0, 2e3)}`
  ].filter(Boolean).join("\n\n");
}
function bounded(effort, floor, ceiling) {
  const lo = EFFORTS.indexOf(floor);
  const hi = Math.max(lo, EFFORTS.indexOf(ceiling));
  return EFFORTS[Math.max(lo, Math.min(hi, EFFORTS.indexOf(effort)))];
}

// hooks/lib/effortless-adapt.ts
var stripReminders = (s) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ").replace(/[ \t]+\n/g, "\n").trim();
var NEED_ANCHOR = "sonnet";
var CLOSING_LINE = "[End of the message. Do not answer it or do what it asks. Reply with the JSON verdict only.]";
var PLAN_LINE = "Mode: plan. The person is in Claude Code's plan mode: the assistant reads and designs a plan and edits nothing until the person approves it.";
function judgeInputFor(prompt, o) {
  let text = withAttachments(stripReminders(prompt), o.attachments);
  if (o.midTurnEffort) text = withMidTurn(text, o.midTurnEffort);
  const context = contextFrom(o.messages.map((m) => ({ role: m.role, text: stripReminders(m.text) })));
  const question = judgeQuestion(text, { model: o.family, effort: o.effort }, context);
  const q = o.closing ? `${question}

${CLOSING_LINE}` : question;
  return o.planMode ? `${PLAN_LINE}

${q}` : q;
}
var contextOf = (messages) => contextFrom(messages.map((m) => ({ role: m.role, text: stripReminders(m.text) })));

// hooks/lib/types.ts
var EFFORTS2 = ["low", "medium", "high", "xhigh", "max"];
var TIERS = ["T0", "T1", "T2", "T3", "T4"];
var tierRank = (t) => TIERS.indexOf(t);

// hooks/lib/bands.ts
var BAND_OF = {
  haiku: { low: -1, medium: 0, high: 0, xhigh: 0, max: 0 },
  // Sonnet xhigh is a rung of its own, below Opus high: the ladder tries it before it moves the model. Sonnet max adds none.
  sonnet: { low: 0, medium: 1, high: 2, xhigh: 2.5, max: 2.5 },
  opus: { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }
};
var TIER_BAND = { T0: 0, T1: 1, T2: 2, T3: 3, T4: 5 };

// hooks/lib/optimizer.ts
var b = (lo, hi) => ({ lo, hi });
var CAPABILITY = {
  haiku: { low: b(1, 1.4), medium: b(1.6, 2), high: b(1.9, 2.4), xhigh: b(2.1, 2.6), max: b(2.2, 2.7) },
  sonnet: { low: b(2, 2.4), medium: b(2.7, 3.1), high: b(3.1, 3.5), xhigh: b(3.3, 3.8), max: b(3.4, 4) },
  opus: { low: b(2.7, 3.1), medium: b(3.2, 3.6), high: b(3.8, 4.2), xhigh: b(4, 4.5), max: b(4.2, 4.7) }
};
var mid = (x) => (x.lo + x.hi) / 2;
var RETRY = { sufficient: b(0.05, 0.15), likely: b(0.15, 0.35), uncertain: b(0.35, 0.65), insufficient: b(0.65, 0.95) };
var REMAINING = [
  { k: 0, n: 1369, p25: 2, median: 6, p75: 19 },
  { k: 1, n: 1060, p25: 3, median: 8, p75: 26 },
  { k: 2, n: 935, p25: 4, median: 9, p75: 30 },
  { k: 4, n: 784, p25: 4, median: 11, p75: 39 },
  { k: 8, n: 553, p25: 6, median: 18, p75: 54 },
  { k: 16, n: 377, p25: 9, median: 29, p75: 79 },
  { k: 32, n: 231, p25: 18, median: 45, p75: 88 }
];
function remainingWork(k, table = REMAINING) {
  let row = table[0];
  for (const r of table) if (r.k <= k) row = r;
  return row;
}
var TASK_STEPS = { trivial: REMAINING[0].p25, standard: REMAINING[0].median, complex: REMAINING[0].p75 };
var DEFAULT_PRIORS = {
  outputPerStep: { haiku: 344, sonnet: 616, opus: 688 },
  effortOutput: { low: 0.6, medium: 1, high: 1.36, xhigh: 1.5, max: 1.8 },
  effortSteps: { low: 0.85, medium: 1, high: 1.1, xhigh: 1.2, max: 1.25 },
  newInputPerStep: 983,
  remainingRequests: REMAINING[0].median,
  basis: "estimate",
  source: "bench/calibrate.mts on the author transcripts, 2026-10-21; effort ratios uncontrolled"
};
function tierOf(family, effort) {
  if (family === "haiku") return "T0";
  if (family === "sonnet") return effort === "low" || effort === "medium" ? "T1" : "T2";
  return effort === "max" ? "T4" : "T3";
}
var FLOOR_CAPABILITY = { T0: 0, T1: mid(CAPABILITY.sonnet.medium), T2: mid(CAPABILITY.sonnet.high), T3: mid(CAPABILITY.opus.high), T4: mid(CAPABILITY.opus.max) };

// hooks/lib/continuity.ts
var MODEL = /(opus|sonnet|haiku)-5-5/i;
var STRENGTH = { haiku: 0, sonnet: 1, opus: 2 };
var READS_WEAKER = ["anthropic", "vertex"];
function continuity(from, to, provider) {
  if (from === to) return "kept";
  const f = MODEL.exec(from)?.[1].toLowerCase();
  const t = MODEL.exec(to)?.[1].toLowerCase();
  if (!f || !t) return "lost";
  if (f === t) return "kept";
  return STRENGTH[t] > STRENGTH[f] && READS_WEAKER.includes(provider) ? "kept" : "lost";
}
function addedSince(prefix, held, dropped = 0) {
  return Math.max(0, prefix + dropped - held);
}

// hooks/lib/policy.ts
var DEFAULT_PARAMS = {
  upgradeVotes: 2,
  downgradeConfidence: 0.85,
  minDwellRequests: 8,
  paybackFactor: 1.5,
  remainingRequests: 6,
  maxSwitches: 3,
  contextReserve: 0.2,
  haikuMaxContext: 15e4,
  smallContext: 2e4,
  calibrated: false
};
var WINDOW = { haiku: 1e6, sonnet: 1e6, opus: 1e6 };
function lowPenaltyPoint(cache, now3, resetSinceLastRequest) {
  if (resetSinceLastRequest || cache.lastRequestAt === null || cache.prefixTokens === 0) return true;
  return now3 - cache.lastRequestAt > cache.ttlMs;
}
function switchCostUsd(cache, from, to, prices2, warm) {
  if (!warm || cache.prefixTokens === 0) return 0;
  const tokens = cache.prefixTokens;
  const t = rateAt(prices2.rates[to.family], tokens);
  const write = tokens * t.input * cacheWriteX(cache.ttlMs);
  if (!from) return write / 1e6;
  const f = rateAt(prices2.rates[from.family], tokens);
  return Math.max(0, write - tokens * f.input * f.cacheReadX) / 1e6;
}
function returnCostUsd(cache, heldTokens, addedTokens, from, to, prices2, warm) {
  if (!warm || cache.prefixTokens === 0) return 0;
  const t = rateAt(prices2.rates[to.family], heldTokens + addedTokens);
  const cost = heldTokens * t.input * t.cacheReadX + addedTokens * t.input * cacheWriteX(cache.ttlMs);
  if (!from) return cost / 1e6;
  const f = rateAt(prices2.rates[from.family], cache.prefixTokens);
  return Math.max(0, cost - cache.prefixTokens * f.input * f.cacheReadX) / 1e6;
}
function lowPointUsd(tokens, heldTokens, addedTokens, from, to, prices2, ttlMs2) {
  if (!from || tokens === 0) return 0;
  const x = cacheWriteX(ttlMs2);
  const t = rateAt(prices2.rates[to.family], heldTokens + addedTokens);
  const f = rateAt(prices2.rates[from.family], tokens);
  return (heldTokens * t.input * t.cacheReadX + addedTokens * t.input * x - tokens * f.input * x) / 1e6;
}
function transitionUsd(x) {
  const held = x.cache.prefixTokens;
  const after = held - (x.droppedTokens ?? 0) + x.addedTokens;
  const retWarmUsd = returnCostUsd({ ...x.cache, prefixTokens: after }, held, x.addedTokens, x.to, x.from, x.prices, true);
  const m = rateAt(x.prices.rates[x.from.family], held + x.addedTokens);
  const n = rateAt(x.prices.rates[x.to.family], after);
  const retExpiredUsd = Math.max(0, (held + x.addedTokens) * m.input * cacheWriteX(x.cache.ttlMs) - after * n.input * n.cacheReadX) / 1e6;
  const pi = x.sameTask ? 1 : 0.5;
  return { hiUsd: x.hiUsd, retWarmUsd, retExpiredUsd, pi, totalUsd: x.hiUsd + pi * (x.expired ? retExpiredUsd : retWarmUsd) };
}
function boundaryOf(i, low) {
  if (i.compacted) return "compaction";
  if (!i.sameTask) return "new-task";
  if (low) return "cold";
  return i.verifiedSinceSwitch ? "checkpoint" : "none";
}
function perRequestSavingUsd(prefix, out, from, to, prices2) {
  const f = rateAt(prices2.rates[from.family], prefix);
  const t = rateAt(prices2.rates[to.family], prefix);
  return (prefix * (f.input * f.cacheReadX - t.input * t.cacheReadX) + out * (f.output - t.output)) / 1e6;
}
var capability = (r) => mid(CAPABILITY[r.family][r.effort]);
function perRequestCostUsd(prefix, out, route, prices2) {
  const r = rateAt(prices2.rates[route.family], prefix);
  return (prefix * r.input * r.cacheReadX + out * r.output) / 1e6;
}
function fits(route, tokens, params) {
  if (route.family === "haiku" && tokens > params.haikuMaxContext) return false;
  return tokens <= (WINDOW[route.family] ?? 2e5) * (1 - params.contextReserve);
}
function remainingFor(i) {
  if (i.newTaskSteps !== void 0) {
    const s = i.newTaskSteps;
    return { k: 0, n: REMAINING[0].n, p25: Math.max(1, Math.round(s / 3)), median: s, p75: s * 3 };
  }
  return remainingWork(i.requestsInPrompt ?? 0, i.remainingTable);
}
function switchCheck(i, resetSinceLastRequest = false) {
  const p = i.params ?? DEFAULT_PARAMS;
  const basis = p.calibrated ? "calibrated" : "estimate";
  const warmByTime = i.cache.lastRequestAt !== null && i.now - i.cache.lastRequestAt <= i.cache.ttlMs;
  const partialReset = resetSinceLastRequest && warmByTime && (i.resetPrefixTokens ?? 0) > 0;
  if (partialReset) i = { ...i, cache: { ...i.cache, prefixTokens: i.resetPrefixTokens } };
  const low = partialReset ? false : lowPenaltyPoint(i.cache, i.now, resetSinceLastRequest);
  const warm = !low;
  const sameRoute = i.current && i.current.model === i.target.model;
  const effortOnly = sameRoute && i.current.effort !== i.target.effort;
  const held = i.targetWarm ? i.targetWarmPrefix ?? i.cache.prefixTokens : 0;
  const added = i.targetWarm ? addedSince(i.cache.prefixTokens, held, i.dropped?.[i.target.family]) : i.cache.prefixTokens;
  const lowTokens = resetSinceLastRequest ? i.resetPrefixTokens ?? 0 : i.cache.prefixTokens;
  const cost = sameRoute ? 0 : low ? lowPointUsd(lowTokens, held, i.targetWarm ? added : lowTokens, i.current, i.target, i.prices, i.cache.ttlMs) : i.targetWarm ? returnCostUsd(i.cache, held, added, i.current, i.target, i.prices, warm) : switchCostUsd(i.cache, i.current, i.target, i.prices, warm);
  const rem = remainingFor(i);
  const per = !i.current || sameRoute ? 0 : i.targetOutputTokens !== void 0 ? perRequestCostUsd(i.cache.prefixTokens, i.expectedOutputTokens, i.current, i.prices) - (i.targetStepRatio ?? 1) * perRequestCostUsd(i.cache.prefixTokens, i.targetOutputTokens, i.target, i.prices) : perRequestSavingUsd(i.cache.prefixTokens, i.expectedOutputTokens, i.current, i.target, i.prices);
  const economics = {
    current: i.current ? `${i.current.model}/${i.current.effort}` : null,
    candidate: `${i.target.model}/${i.target.effort}`,
    prefixTokens: i.cache.prefixTokens,
    writePenaltyUsd: round(cost),
    ttlMs: i.cache.ttlMs,
    effortSharesCache: i.cache.effortSharesCache,
    remaining: { k: rem.k, p25: rem.p25, median: rem.median, p75: rem.p75, n: rem.n },
    savingUsd: { p25: round(per * rem.p25), median: round(per * rem.median), p75: round(per * rem.p75) },
    ...i.reworkUsd !== void 0 ? { reworkUsd: round(i.reworkUsd) } : {},
    basis
  };
  const modelChange = !!i.current && !sameRoute;
  const pair = modelChange ? continuity(i.current.model, i.target.model, i.provider ?? "anthropic") : null;
  const flag = pair === "lost" && i.compacted ? "cleared" : pair;
  const lostHere = flag === "lost" && i.sameTask;
  const rentFor = (verdict, gate) => {
    if (!modelChange || i.mandatory) return void 0;
    const boundary = boundaryOf(i, low);
    const growth = rem.p25 * (DEFAULT_PRIORS.newInputPerStep + i.expectedOutputTokens);
    const transition = transitionUsd({ cache: i.cache, from: i.current, to: i.target, prices: i.prices, hiUsd: cost, addedTokens: growth, sameTask: i.sameTask, expired: low });
    const rentUsd = i.rent && i.rent.from === i.current.family && i.rent.to === i.target.family ? i.rent.usd : 0;
    const heldBy = verdict === "hold" && gate !== "votes" && gate !== "payback" ? gate : void 0;
    const pays = low && !i.sameTask || boundary !== "none" && rentUsd >= transition.totalUsd;
    return { verdict: !heldBy && pays ? "switch" : "hold", to: i.target.family, boundary, rentUsd: round(rentUsd), stepRatio: i.targetStepRatio ?? 1, transition, ...heldBy ? { heldBy } : {} };
  };
  const out = (verdict, reason, gate) => {
    const rent = rentFor(verdict, gate);
    return { verdict, ...gate ? { gate } : {}, estUsd: cost, basis, lowPenaltyPoint: low, reason, economics, ...flag ? { continuity: flag } : {}, ...rent ? { rent } : {} };
  };
  const sameWindow = !!i.current && i.target.family !== "haiku" && (WINDOW[i.target.family] ?? 0) >= (WINDOW[i.current.family] ?? Infinity);
  if (!fits(i.target, i.cache.prefixTokens, p) && !sameWindow) return out("hold", "the target cannot hold this context", "context");
  if (!i.current) return out("switch", "first route");
  if (sameRoute && !effortOnly) return out("switch", "same route");
  if (effortOnly) return !i.cache.effortSharesCache && warm && !i.mandatory ? out("hold", "provider splits the cache by effort", "provider-effort") : out("switch", "effort change on the same model");
  if (i.mandatory) return out("switch", "mandatory quality floor");
  if ((i.switchesThisTask ?? 0) >= p.maxSwitches) return out("hold", `${p.maxSwitches} discretionary switches already in this task`, "oscillation");
  const lost = `${i.target.family} cannot read ${i.current.family} thinking, and this task still needs it`;
  if (low && !i.sameTask) return out("switch", "low-switch-penalty point");
  const up = capability(i.target) > capability(i.current) && STRENGTH[i.target.family] >= STRENGTH[i.current.family];
  if (up) {
    if (lostHere) return out("hold", lost, "continuity");
    if (low) return out("switch", "low-switch-penalty point");
    return i.votes >= p.upgradeVotes || i.cache.prefixTokens < p.smallContext ? out("switch", "upgrade confirmed") : out("hold", `upgrade needs ${p.upgradeVotes} votes`, "votes");
  }
  if (i.risk !== "none" || i.candidate.confidence < p.downgradeConfidence) return out("hold", "risk or confidence too high for a downgrade", "quality");
  if (i.sameTask && (i.requestsSinceSwitch < p.minDwellRequests || !i.verifiedSinceSwitch)) return out("hold", "dwell: too soon after the last switch, or no passed check yet", "dwell");
  if (lostHere) return out("hold", lost, "continuity");
  if (low) return out("switch", "low-switch-penalty point");
  if (i.cache.prefixTokens >= p.smallContext) {
    const q = p.paybackQuantile ?? "p25";
    const saving = per * rem[q] - Math.max(0, i.reworkUsd ?? 0);
    if (saving <= p.paybackFactor * cost) return out("hold", `${q} saving $${saving.toFixed(4)} does not pay back ${p.paybackFactor}x the $${cost.toFixed(4)} rewrite`, "payback");
  }
  return out("switch", "downgrade pays back");
}
var round = (n) => Math.round(n * 1e6) / 1e6;
var tierAtLeast = (t, floor) => tierRank(t) >= tierRank(floor.tier) ? t : floor.tier;

// hooks/lib/authority.ts
var DEFAULT_LADDER = {
  models: { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" },
  tiers: {
    T0: { family: "haiku", effort: "low" },
    T1: { family: "sonnet", effort: "medium" },
    T2: { family: "sonnet", effort: "high" },
    T3: { family: "opus", effort: "high" },
    T4: { family: "opus", effort: "max" }
  }
};
function routeFor(tier, ladder = DEFAULT_LADDER, effort) {
  const t = ladder.tiers[tier];
  return { tier, family: t.family, model: ladder.models[t.family], effort: effort ?? t.effort };
}
function resolve(i, resetSinceLastRequest = false) {
  const ladder = i.ladder ?? DEFAULT_LADDER;
  const overridden = [];
  if (i.override?.tier || i.override?.effort) {
    const tier = i.override.tier ?? i.current?.tier ?? i.candidate.tier;
    const r = routeFor(tier, ladder, i.override.effort);
    if (tierRank(tier) < tierRank(i.floor.tier)) overridden.push({ owner: "quality-escalation", reason: `floor ${i.floor.tier} (${i.floor.because.join("; ")}) kept as a pending requirement` });
    return { ...r, owner: "user-override", reason: i.override.reason, floor: i.floor, candidate: i.candidate, overridden };
  }
  if (i.workflowRole) {
    return { ...routeFor(i.workflowRole.tier, ladder), owner: "workflow-role", reason: i.workflowRole.reason, floor: i.floor, candidate: i.candidate, overridden };
  }
  const lifted = tierAtLeast(i.candidate.tier, i.floor);
  const floorMandatory = tierRank(i.floor.tier) > 0 && tierRank(lifted) === tierRank(i.floor.tier) && (!i.current || tierRank(i.current.tier) < tierRank(i.floor.tier));
  const mandatory = floorMandatory || !!i.currentInadequate;
  if (lifted !== i.candidate.tier) overridden.push({ owner: i.candidate.source === "judge" ? "judge" : i.candidate.source, reason: `${i.candidate.tier} lifted to floor ${i.floor.tier}` });
  const tierEffort = lifted === i.floor.tier && i.floor.effort ? i.floor.effort : ladder.tiers[lifted].effort;
  const effort = lifted !== i.candidate.tier ? tierEffort : i.effortHint ?? tierEffort;
  const target = routeFor(lifted, ladder, effort);
  const priced = i.effortCost && i.current ? { expectedOutputTokens: i.effortCost.output(i.current), targetOutputTokens: i.effortCost.output(target), targetStepRatio: i.effortCost.steps(target) / i.effortCost.steps(i.current) } : {};
  const check = switchCheck({ ...i.switchInput, ...priced, current: i.current, candidate: i.candidate, target, floor: i.floor, mandatory }, resetSinceLastRequest);
  if (check.verdict === "switch") {
    const owner = mandatory ? "quality-escalation" : i.candidate.source === "judge" ? "judge" : i.candidate.source;
    const reason = floorMandatory ? `floor ${i.floor.tier}: ${i.floor.because.join("; ")}` : mandatory ? `the running route is below the need: ${i.candidate.reason}` : i.candidate.reason;
    return { ...target, owner, reason, floor: i.floor, candidate: i.candidate, check, overridden };
  }
  const keep = i.current ?? target;
  const heldAt = i.current && i.heldEffort && check.gate !== "provider-effort" ? i.heldEffort : keep.effort;
  overridden.push({ owner: i.candidate.source === "judge" ? "judge" : i.candidate.source, reason: `held by ${check.gate}: ${target.tier}/${target.effort}` });
  return { ...keep, tier: heldAt !== keep.effort ? tierOf(keep.family, heldAt) : keep.tier, effort: heldAt, owner: "cache-policy", reason: `hold (${check.gate})${heldAt !== keep.effort ? `, effort ${heldAt}` : ""}`, floor: i.floor, candidate: i.candidate, check, overridden };
}

// hooks/lib/strategy.ts
var DEFAULT_STRATEGY = {
  remainingRequests: 10,
  retryRate: 0.2,
  workerSetupTokens: { haiku: 18e3, sonnet: 18e3, opus: 18e3 },
  reportTokens: 2500,
  isolationMargin: 0.8,
  minConfidence: 0.6,
  calibrated: false
};
var M = 1e6;
function consultOrSwitch(i, margin = 0.7) {
  const o = rateAt(i.prices.rates.opus, i.prefixTokens);
  const m = rateAt(i.prices.rates[i.main], i.prefixTokens);
  const R = i.remainingRequests;
  const switchUsd = (i.prefixTokens * o.input * cacheWriteX(i.ttlMs) + R * (i.prefixTokens * o.input * o.cacheReadX + i.outPerRequest * o.output)) / M;
  const stayUsd = R * (i.prefixTokens * m.input * m.cacheReadX + i.outPerRequest * m.output) / M;
  const setup = i.setupTokens ?? DEFAULT_STRATEGY.workerSetupTokens.opus;
  const oc = rateAt(i.prices.rates.opus, setup + i.packetTokens);
  const consultUsd = stayUsd + ((setup + i.packetTokens) * oc.input * 1.25 + i.planTokens * oc.output) / M + i.planTokens * m.input * cacheWriteX(i.ttlMs) / M;
  const choice = consultUsd < margin * switchUsd ? "consult" : "switch";
  return { choice, consultUsd, switchUsd, why: `consult $${consultUsd.toFixed(3)} vs switch $${switchUsd.toFixed(3)} (estimate, R=${R})` };
}

// hooks/lib/executor.ts
var rank = (e) => EFFORTS2.indexOf(e);
function executorEffort(judged, taskEffort) {
  const verdict = judged ?? "medium";
  const clamped = rank(verdict) <= rank("medium") ? "medium" : "high";
  return taskEffort && rank(taskEffort) > rank(clamped) ? taskEffort : clamped;
}

// hooks/lib/effort.ts
var effortRank = (e) => EFFORTS2.indexOf(e);
var maxEffort = (a, b2) => effortRank(a) >= effortRank(b2) ? a : b2;

// hooks/lib/learn.ts
var WINDOW_MS = 30 * 864e5;
var bucketOf = (tier, need) => `${tier}/${need ?? "none"}`;

// hooks/lib/failures.ts
var PM_FLAGS = String.raw`(?:\s+--?\w[\w-]*(?:=\S+|\s+[^-\s]\S*)?)*`;
var CHECKS = [
  String.raw`go (test|vet|build)\b`,
  String.raw`npm${PM_FLAGS}\s+(t|test|run${PM_FLAGS}\s+(test|lint|build|typecheck|check))\b`,
  String.raw`pnpm${PM_FLAGS}\s+(test|lint|build|typecheck|run${PM_FLAGS}\s+\w+)\b`,
  String.raw`yarn${PM_FLAGS}\s+(test|lint|build|typecheck|run\s+(test|lint|build|typecheck|check))\b`,
  String.raw`bun\s+(test|run\s+(test|lint|build|typecheck|check))\b`,
  String.raw`deno (test|lint|check)\b`,
  String.raw`(tsc|eslint|vitest|jest|mocha|ava|pytest|py\.test|unittest|nose2|tox|nox|ruff|mypy|pyright|flake8|pylint|rspec|phpunit|ctest|shellcheck|golangci-lint)\b`,
  String.raw`(black|prettier)\b.*\s--check\b`,
  String.raw`biome (check|ci|lint)\b`,
  String.raw`playwright test\b`,
  String.raw`cypress run\b`,
  String.raw`cargo(\s+\+\S+)?\s+(test|build|clippy|check|nextest)\b`,
  String.raw`mvnw?\b.*\s(test|verify)\b`,
  String.raw`gradle\w*\b.*\s(test|check|build)\b`,
  String.raw`make\b(\s+-\S+(\s+[^-\s]\S*)?)*\s+(test|lint|check|build)\b`,
  String.raw`rake (test|spec)\b`,
  String.raw`(dotnet|swift) (test|build)\b`,
  String.raw`(mix|flutter) test\b`,
  String.raw`node\b.*\s--test\b`,
  String.raw`python[\d.]*\s+(\S+/)?manage\.py test\b`
];
var CHECK_COMMAND = new RegExp(`^(?:${CHECKS.join("|")})`);
function fnv1a(s) {
  let h2 = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h2 ^= s.charCodeAt(i);
    h2 = Math.imul(h2, 16777619) >>> 0;
  }
  return h2.toString(16).padStart(8, "0");
}

// hooks/lib/auto.ts
var RANK2 = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };
var FAMILIES = ["haiku", "sonnet", "opus"];
var at = (e) => EFFORTS2.indexOf(e);
var maxEffort2 = (a, b2) => at(a) >= at(b2) ? a : b2;
var hmModel = (t) => t === "T0" ? "haiku" : t === "T1" || t === "T2" ? "sonnet" : "opus";
var effortlessFloor = (need) => need ? RANK2[need.model] : null;
function effortMinFor(family, i) {
  const floor = i.floors.effortMin?.[family];
  const hard = i.hm?.tier === "T4" || effortlessFloor(i.need) === RANK2.fable;
  if (family === "opus" && hard) return maxEffort2(floor ?? "low", "high");
  if (family === "sonnet" && i.opusOnEvidence && i.hm?.tier === "T3") return maxEffort2(floor ?? "low", "high");
  return floor;
}
function opusRequired(i) {
  const tier = i.hm?.tier;
  if (tier === "T4") return "T4: a focused attempt already failed";
  if (i.need?.model === "fable") return "a fable verdict: opus carries it";
  if (i.opusOnEvidence) return null;
  if (tier === "T3" && i.consequence === "critical") return "T3 on critical work";
  if (tier === "T3" && i.need?.model === "opus") return "T3 and the need names opus";
  if (i.reachHaiku && tier === "T2" && i.need?.model === "opus") return "T2 and the need names opus";
  if (!i.hm && i.need?.model === "opus") return "the need names opus and the automode judge did not answer";
  return null;
}
function eligibilityOf(family, i) {
  if (!i.need) {
    const missing = family === "opus" ? null : opusRequired(i);
    return missing ? { eligibility: "ineligible", why: ["no effortless answer yet", missing] } : { eligibility: "needs-verdict", why: ["no effortless answer yet"] };
  }
  const why = [`effortless: the need names ${i.need.model}`];
  if (i.hm) why.push(`automode: ${i.hm.tier} (${hmModel(i.hm.tier)})`);
  if (family === "opus") return { eligibility: "eligible", why: [...why, "opus: the strongest model"] };
  const required = opusRequired(i);
  if (required) return { eligibility: "ineligible", why: [...why, required] };
  if (family === "sonnet") return { eligibility: "eligible", why: [...why, "sonnet: no rule requires opus"] };
  if (!i.hm) return { eligibility: "ineligible", why: [...why, "haiku needs both judges; the automode judge did not answer"] };
  if (i.reachHaiku && tierRank(i.hm.tier) <= 2 && i.need.model !== "opus" && i.consequence !== "critical") return { eligibility: "eligible", why: [...why, "haiku: low tier, no critical risk"] };
  return i.need.model === "haiku" && i.hm.tier === "T0" ? { eligibility: "eligible", why: [...why, "both judges name haiku"] } : { eligibility: "ineligible", why: [...why, "haiku needs both judges"] };
}
function firstCalls(fixedFamily, running) {
  if (fixedFamily) return [fixedFamily];
  return running && running !== NEED_ANCHOR ? [NEED_ANCHOR, running] : [NEED_ANCHOR];
}
function secondCall(i, anchor) {
  if (i.floors.fixedFamily) return null;
  const ok = (f) => i.allowed.includes(f) && !i.floors.exclude?.[f];
  const st = (f) => eligibilityOf(f, i).eligibility;
  const anchorOk = ok(anchor) && st(anchor) === "eligible";
  for (const f of FAMILIES) {
    if (f === anchor || i.verdicts[f] !== void 0 || !ok(f)) continue;
    const e = st(f);
    if (e !== "eligible" && e !== "needs-verdict") continue;
    if (!anchorOk || RANK2[f] < RANK2[anchor]) return f;
  }
  return null;
}
function runningRuledOut(family, choice, floors, hm) {
  const own = family ? choice.candidates.find((c) => c.family === family) : void 0;
  if (!own) return false;
  if (own.eligibility === "unavailable") return true;
  return own.eligibility === "ineligible" && (!!floors.exclude?.[own.family] || hm?.tier === "T4" || own.family === "haiku");
}
function ownEffort(own) {
  return own && (own.verdictEffort || own.eligibility === "eligible" && Number.isFinite(own.attemptUsd)) ? own.effort : void 0;
}
function optimizeAuto(i) {
  const families = i.floors.fixedFamily ? [i.floors.fixedFamily] : FAMILIES;
  const candidates = families.map((family) => {
    const v = i.verdicts[family];
    if (!i.allowed.includes(family)) return { family, effort: v?.effort ?? "medium", eligibility: "unavailable", why: ["not available now (breaker or Haiku guard)"], attemptUsd: Infinity };
    const excludedBy = i.floors.exclude?.[family];
    if (excludedBy && !i.floors.fixedFamily) return { family, effort: v?.effort ?? "medium", eligibility: "ineligible", why: [excludedBy], attemptUsd: Infinity };
    const e = i.floors.fixedFamily ? { eligibility: "eligible", why: ["the model is fixed (a command, routeModels false, or a failed judge)"] } : eligibilityOf(family, i);
    if (!v && !i.floors.fixedEffort) return { family, effort: "medium", eligibility: e.eligibility === "eligible" ? "needs-verdict" : e.eligibility, why: [...e.why, "no effort verdict for this model"], attemptUsd: Infinity };
    let effort2 = v ? v.effort : i.floors.fixedEffort;
    const notes = [...e.why];
    const min = effortMinFor(family, i);
    if (min && at(effort2) < at(min)) {
      effort2 = bounded(effort2, min, "max");
      notes.push(`floor ${min}`);
    }
    if (v && i.hm && tierRank(i.hm.tier) >= 3 && effort2 === "low") {
      effort2 = "medium";
      notes.push("judges disagree (T3/T4 task, low effort): medium");
    }
    if (i.floors.fixedEffort) {
      if (effort2 !== i.floors.fixedEffort) notes.push(`user effort ${i.floors.fixedEffort}`);
      effort2 = i.floors.fixedEffort;
    }
    return { family, effort: effort2, ...v ? { verdictEffort: v.effort } : {}, eligibility: e.eligibility, why: notes, attemptUsd: e.eligibility === "eligible" ? i.cost(family, effort2) : Infinity };
  });
  const usable = candidates.filter((c) => c.eligibility === "eligible" && Number.isFinite(c.attemptUsd));
  const weaker = usable.filter((c) => c.family !== "opus");
  const field = weaker.length ? weaker : usable;
  const order = (a, b2) => a.attemptUsd - b2.attemptUsd || Number(b2.family === i.current?.family) - Number(a.family === i.current?.family) || at(a.effort) - at(b2.effort);
  if (field.length) return { best: field.sort(order)[0], candidates, inadequate: false, rule: field.length > 1 ? "cheapest eligible pair" : "the weakest eligible model" };
  const pool = candidates.filter((c) => c.eligibility !== "unavailable");
  const waiting = i.need ? void 0 : pool.find((c) => c.family === "sonnet" && c.eligibility === "needs-verdict");
  const strongest = waiting ?? (pool.length ? pool : candidates).slice().sort((a, b2) => RANK2[b2.family] - RANK2[a.family])[0];
  const floored = maxEffort2(i.verdicts[strongest.family]?.effort ?? i.current?.effort ?? "high", effortMinFor(strongest.family, i) ?? "low");
  const effort = i.floors.fixedEffort ?? (i.hm && tierRank(i.hm.tier) >= 3 ? maxEffort2(floored, "medium") : floored);
  const best = { ...strongest, effort, attemptUsd: i.cost(strongest.family, effort) };
  const inadequate = strongest.eligibility !== "eligible" && strongest.eligibility !== "needs-verdict";
  return { best, candidates, inadequate, rule: inadequate ? "no eligible model: the strongest available, labeled inadequate" : waiting ? "no need: sonnet at its known or running effort" : "no effort verdict for an eligible model: the strongest available at its known or running effort" };
}
function fallbackModel(keep, hm, allowed, consequence, minConfidence = 0) {
  if (!hm) return { family: keep, why: "both judges failed: the model stays" };
  let need = hmModel(hm.tier);
  if (need === "haiku" && consequence === "critical") need = "sonnet";
  const down = RANK2[need] < RANK2[keep];
  if (down && (hm.confidence ?? 1) < minConfidence) return { family: keep, why: `the AutoMode judge names ${need} with low confidence: the ${keep} model stays` };
  if (need !== keep && allowed.includes(need)) return { family: need, effort: hm.effort, why: `the effortless judge failed: the AutoMode judge decides (${hm.tier}: ${need})` };
  return { family: keep, why: `the effortless judge failed; the AutoMode judge names ${need}: the ${keep} model stays` };
}
function decisionRequired(t) {
  const why = Object.keys(t).filter((k) => t[k]);
  return { required: why.length > 0, why };
}
var NOT_STEERING = /^(?:ok(?:ay)?|thanks?(?: you)?|thx|great|nice|perfect|cool|good|done|hello|hi|hey|commit|push|merge|rebase)[.!\s]*$/i;
function shortcutApplies(keeps, text, required) {
  return keeps && !required.required && !NOT_STEERING.test(text.trim());
}
function fallbackEffort(i) {
  if (i.escalation) return { effort: i.escalation.effort, source: "escalation applies without a judge" };
  const floor = i.effortMin ?? "low";
  if (i.previous && i.sameTask && i.sameStage && !i.riskChanged && !i.planBoundary && i.previousAdequate)
    return { effort: maxEffort2(i.previous.effort, floor), source: "judge failed: same task and stage, previous effort kept (upstream)" };
  const app = i.appEffort ?? "medium";
  return { effort: maxEffort2(app, floor), source: i.previous ? "judge failed on a changed task or stage: the app effort within the floors" : "judge failed with no previous decision: the app effort within the floors" };
}
function legalEffort(i) {
  if (!i.perMessage) return { effective: i.requested, legalAt: "top-level effort: applies to this request", deferred: false };
  if (i.modelChanged) return { effective: i.requested, legalAt: "model change: the new model starts at this effort", deferred: false };
  if (i.lastEffective === null || i.requested === i.lastEffective) return { effective: i.requested, legalAt: "no change", deferred: false };
  if (i.index === 0) return { effective: i.requested, legalAt: "first step of the turn: new user input", deferred: false };
  if (i.newInput) return { effective: i.requested, legalAt: "step after new input in the turn", deferred: false };
  return { effective: i.lastEffective, legalAt: "tool-result continuation: takes effect at the next new input", deferred: true };
}

// hooks/lib/auto-route.ts
var AUTO_ROUTE_SCHEMA = 1;
var LOW_CONFIDENCE = 0.3;
var FAMILIES2 = ["haiku", "sonnet", "opus"];
var CHEAPER = { haiku: [], sonnet: ["haiku"], opus: ["haiku", "sonnet"] };
function escalationStep(floor, allowed) {
  return floor && (!allowed.length || allowed.includes(floor.family)) ? floor : null;
}
function autoFloors(f, complexity, allowed, stage) {
  const effortMin = {};
  const exclude = {};
  const because = [];
  let tier = { tier: "T0", because: [] };
  if (f.risk === "critical" && complexity !== "trivial") {
    const why = `critical consequence: ${f.riskReasons.slice(0, 2).join("; ") || "observed"}`;
    exclude.haiku = why;
    effortMin.sonnet = "high";
    effortMin.opus = "medium";
    because.push(why);
    tier = { tier: "T2", because: [why] };
  }
  const step = escalationStep(f.ladderFloor, allowed);
  if (step) {
    for (const x of FAMILIES2) {
      const e = EFFORTS2.find((y) => BAND_OF[x][y] >= step.band);
      if (!e) exclude[x] = step.because;
      else effortMin[x] = maxEffort(effortMin[x] ?? "low", e);
    }
    because.push(step.because);
    const t = tierOf(step.family, step.effort);
    if (tierRank(t) >= tierRank(tier.tier)) tier = { tier: t, effort: step.effort, band: step.band, because: [step.because] };
  }
  const td = f.taskDecision && f.taskDecision.taskId === f.taskId ? f.taskDecision : null;
  if (stage === "reconsider" && td) {
    const band = BAND_OF[td.family][td.effort];
    const why = `a challenge keeps the work's ${td.family} ${td.effort}`;
    for (const x of FAMILIES2) {
      const e = EFFORTS2.find((y) => BAND_OF[x][y] >= band);
      if (!e) exclude[x] ??= why;
      else effortMin[x] = maxEffort(effortMin[x] ?? "low", e);
    }
    because.push(why);
  }
  if (f.stayUp > 0 && f.currentFamily) for (const x of CHEAPER[f.currentFamily]) exclude[x] ??= `a redo keeps the model for ${f.stayUp} more prompts`;
  return { floors: { effortMin, exclude, because }, tier, escalated: step ? { family: step.family, effort: step.effort } : null };
}
function executorInput(on, verdicts, floors, taskRoute) {
  if (!on || floors.fixedFamily || floors.exclude?.sonnet) return null;
  const effort = executorEffort(verdicts.sonnet?.effort, taskRoute?.family === "sonnet" ? taskRoute.effort : void 0);
  return { verdicts: { ...verdicts, sonnet: { model: "sonnet", effort, why: "executor" } }, floors: { ...floors, fixedFamily: "sonnet" } };
}
var costOf = (attempt) => (family, effort) => attempt[family][effort] ?? Infinity;
function planAuto(i) {
  const reasons = [];
  const cur = i.current?.route ?? null;
  const mq = autoFloors(i.floor, i.complexity, i.allowed, i.stage);
  if (mq.floors.because.length) reasons.push(`floors: ${mq.floors.because.join("; ")}`);
  const floors = { ...mq.floors, ...i.fixedFamily ? { fixedFamily: i.fixedFamily } : {}, ...i.fixedEffort ? { fixedEffort: i.fixedEffort } : {} };
  let verdicts = { ...i.verdicts };
  const notes = [];
  const askedNeed = i.verdicts[i.anchor] ?? null;
  const answer = i.judge;
  let fallback;
  let ownFallback;
  if (!i.shortcut) {
    if (cur && !verdicts[cur.family] && (!i.fixedFamily || i.fixedFamily === cur.family)) {
      const fb = fallbackEffort({ sameTask: !i.boundary, sameStage: i.stage === i.previousStage, riskChanged: i.riskChanged, planBoundary: i.planBoundary, previous: { family: cur.family, effort: i.current.running }, previousAdequate: true, appEffort: i.appEffort, escalation: mq.escalated, effortMin: mq.floors.effortMin?.[cur.family] });
      verdicts = { ...verdicts, [cur.family]: { model: cur.family, effort: fb.effort, why: "fallback" } };
      notes.push({ family: cur.family, effort: fb.effort, fallback: fb.source });
      if (askedNeed) {
        ownFallback = fb.source;
        reasons.push(`own verdict failed: ${fb.source}`);
      } else fallback = fb.source;
    }
    if (cur && !askedNeed && !i.fixedFamily && !fallback) fallback = "the need call failed: no model switch";
    if (!cur && !Object.values(verdicts).some(Boolean)) {
      const f = i.fixedFamily ?? (i.allowed.includes(i.appFamily) ? i.appFamily : i.allowed[i.allowed.length - 1]);
      const fb = fallbackEffort({ sameTask: false, sameStage: false, riskChanged: false, planBoundary: false, previous: null, previousAdequate: false, appEffort: i.appEffort, escalation: null, effortMin: mq.floors.effortMin?.[f] });
      verdicts = { [f]: { model: f, effort: fb.effort, why: "fallback" } };
      floors.fixedFamily = f;
      fallback = fb.source;
    }
    if ((!answer || fallback) && cur && !i.fixedFamily && i.allowed.includes(cur.family)) {
      floors.fixedFamily = cur.family;
      fallback = fallback ?? "automode judge failed: no model switch";
    }
    if (!answer && !cur && !i.fixedFamily && !floors.fixedFamily) {
      floors.fixedFamily = i.allowed.includes(i.appFamily) ? i.appFamily : i.allowed[i.allowed.length - 1];
      fallback = fallback ?? "automode judge failed on the first prompt: the app model";
    }
    if (fallback && answer && floors.fixedFamily && !i.fixedFamily && !i.executor.on) {
      const fm = fallbackModel(floors.fixedFamily, { tier: answer.tier, effort: answer.effort, confidence: answer.confidence }, i.allowed, i.floor.risk, i.policy.lowConfidence);
      if (fm.family !== floors.fixedFamily) {
        floors.fixedFamily = fm.family;
        verdicts = { ...verdicts, [fm.family]: { model: fm.family, effort: maxEffort(fm.effort ?? "high", mq.floors.effortMin?.[fm.family] ?? "low"), why: "fallback" } };
        notes.push({ family: fm.family, effort: verdicts[fm.family].effort, fallback: fm.why });
      }
      fallback = `${fallback}; ${fm.why}`;
    }
    if (fallback) reasons.push(`fallback: ${fallback}`);
  }
  if (answer && cur && answer.confidence < i.policy.lowConfidence && !floors.fixedFamily) {
    const rankF = { haiku: 0, sonnet: 1, opus: 2 };
    for (const f of FAMILIES2) if (rankF[f] < rankF[cur.family]) floors.exclude = { ...floors.exclude ?? {}, [f]: `low judge confidence (${answer.confidence}): no downgrade` };
    reasons.push("low confidence: no downgrade (jev-router)");
  }
  const taught = i.learned.on && answer && askedNeed && !floors.fixedFamily && i.allowed.includes("opus") ? bucketOf(answer.tier, askedNeed.model) : null;
  let learnedBucket;
  if (taught && i.learned.opusBuckets.includes(taught)) {
    floors.exclude = { ...floors.exclude ?? {}, haiku: `learned: ${taught} needed rescue in this project`, sonnet: `learned: ${taught} needed rescue in this project` };
    reasons.push(`learned: ${taught} starts on opus`);
    learnedBucket = taught;
  }
  const secondJudge = !i.shortcut && !fallback && !i.judgeCached && !i.executor.on ? secondCall({ allowed: i.allowed, verdicts, need: askedNeed, hm: answer ? { tier: answer.tier, complexity: answer.complexity } : null, consequence: i.floor.risk, reachHaiku: i.reachHaiku, opusOnEvidence: i.opusOnEvidence, floors, current: null, cost: () => 0 }, i.anchor) : null;
  return { floors, tier: mq.tier, escalated: mq.escalated, verdicts, notes, ...fallback ? { fallback } : {}, ...ownFallback ? { ownFallback } : {}, ...learnedBucket ? { learnedBucket } : {}, secondJudge, reasons };
}
function routeAuto(i) {
  const { secondJudge: _, ...plan } = planAuto(i);
  const reasons = [...plan.reasons];
  const { floors, verdicts, fallback } = plan;
  const cur = i.current?.route ?? null;
  const answer = i.judge;
  const hm = answer ? { tier: answer.tier, complexity: answer.complexity } : null;
  if (i.second) {
    const v = i.verdicts[i.second];
    reasons.push(`second effortless call: ${i.second}${v ? ` -> ${v.model}/${v.effort}` : " failed"}`);
  }
  const cost = costOf(i.economics.attempt);
  const current2 = cur ? { family: cur.family, effort: i.current.running } : null;
  const askedNeed = i.verdicts[i.anchor] ?? null;
  const need = askedNeed ?? (floors.fixedFamily ? verdicts[floors.fixedFamily] ?? null : null);
  const kept = i.shortcut && i.kept ? { model: i.kept.family, effort: i.kept.effort, why: "kept" } : null;
  const executed = kept ? null : executorInput(i.executor.on, verdicts, floors, i.executor.taskRoute);
  if (executed) reasons.push(`executor: sonnet ${executed.verdicts.sonnet.effort}`);
  const consequence = i.floor.risk;
  const choice = kept ? optimizeAuto({ allowed: i.allowed, verdicts: { [kept.model]: kept }, need: kept, hm: null, floors: { ...floors, fixedFamily: i.allowed.includes(i.kept.family) ? i.kept.family : void 0 }, current: current2, cost }) : optimizeAuto({ allowed: i.allowed, ...executed ?? { verdicts, floors }, need, hm, consequence, reachHaiku: i.reachHaiku, opusOnEvidence: i.opusOnEvidence, current: current2, cost });
  const shadow = executed ? optimizeAuto({ allowed: i.allowed, verdicts, need, hm, consequence, reachHaiku: i.reachHaiku, opusOnEvidence: i.opusOnEvidence, floors, current: current2, cost }).best : null;
  reasons.push(`optimizer: ${choice.rule} -> ${choice.best.family}/${choice.best.effort}`);
  const own = cur ? choice.candidates.find((c) => c.family === cur.family) : void 0;
  const ownVerdict = cur ? verdicts[cur.family] : null;
  const heldEffort = ownEffort(own) ?? (cur && ownVerdict ? maxEffort(ownVerdict.effort, plan.floors.effortMin?.[cur.family] ?? "low") : void 0);
  const currentInadequate = runningRuledOut(cur?.family, choice, floors, hm);
  const candidate = { tier: tierOf(choice.best.family, choice.best.effort), source: i.shortcut ? "continuation" : fallback ? "fallback" : "judge", confidence: answer?.confidence ?? 0.5, reason: `${i.shortcut ? "short go-ahead keeps the task" : answer?.why || "judges"}; ${choice.best.family} ${choice.best.effort} ${choice.best.eligibility}${choice.inadequate ? " (inadequate)" : ""}` };
  const votes = i.votes.tier === candidate.tier ? { tier: candidate.tier, n: i.votes.n + 1 } : { tier: candidate.tier, n: 1 };
  let tier = plan.tier;
  if (currentInadequate && cur && tierRank(tierOf(choice.best.family, choice.best.effort)) > tierRank(tier.tier))
    tier = { tier: tierOf(choice.best.family, choice.best.effort), effort: choice.best.effort, because: [`${cur.family} ${i.current.running} is ruled out for this task (${own.eligibility})`] };
  const commandRoute = i.command ? { tier: tierOf(choice.best.family, choice.best.effort), effort: choice.best.effort, reason: `user: ${i.command.label}` } : void 0;
  const e = i.economics;
  const sw = i.switching;
  const effortCost2 = { output: (r) => e.outputPerStep[r.family] * e.effortOutput[r.effort], steps: (r) => e.effortSteps[r.effort] };
  const resolved = resolve({
    override: commandRoute,
    floor: tier,
    candidate,
    effortHint: choice.best.effort,
    heldEffort,
    ...currentInadequate ? { currentInadequate } : {},
    effortCost: effortCost2,
    current: i.usable,
    switchInput: {
      cache: sw.cache,
      now: i.now,
      votes: votes.n,
      requestsSinceSwitch: sw.requestsSinceSwitch,
      verifiedSinceSwitch: sw.verifiedSinceSwitch,
      sameTask: !i.boundary && !i.planExited,
      risk: i.floor.risk,
      expectedOutputTokens: e.outputPerStep[cur?.family ?? "sonnet"],
      prices: e.prices,
      params: { ...DEFAULT_PARAMS, calibrated: e.calibrated },
      requestsInPrompt: 0,
      newTaskSteps: i.boundary ? TASK_STEPS[i.complexity] : void 0,
      remainingTable: sw.remainingTable,
      switchesThisTask: sw.switchesThisTask,
      targetWarm: sw.warm[choice.best.family],
      targetWarmPrefix: sw.warmPrefix[choice.best.family],
      resetPrefixTokens: sw.resetPrefixTokens,
      ...sw.continuity
    }
  }, sw.reset);
  reasons.push(`authority: ${resolved.owner} ${resolved.family}/${resolved.effort}${resolved.check?.gate ? ` (${resolved.check.gate})` : ""}`);
  let route = resolved;
  let consult = null;
  const lastWorkBand = hm ? i.stage === "reconsider" ? i.consult.lastWorkBand : TIER_BAND[hm.tier] : i.consult.lastWorkBand;
  const key = `stage:${i.floor.taskId}:${lastWorkBand ?? 0}`;
  if (i.stage === "reconsider" && cur && cur.family !== "opus" && (resolved.family === "opus" || choice.best.family === "opus") && sw.cache.prefixTokens >= DEFAULT_PARAMS.smallContext && !i.consult.consulted.includes(key)) {
    const c = consultOrSwitch({ prefixTokens: sw.cache.prefixTokens, remainingRequests: remainingFor({ requestsInPrompt: 0, remainingTable: sw.remainingTable }).median, outPerRequest: e.outputPerStep.opus, packetTokens: i.consult.packetTokens, planTokens: 2e3, main: cur.family, ttlMs: i.consult.ttlMs, prices: e.prices });
    consult = { key, ...c };
    if (c.choice === "consult") {
      const effort = own?.effort ?? cur.effort;
      route = { ...cur, tier: tierOf(cur.family, effort), effort, owner: "quality-escalation", reason: `consult Opus instead of a switch: ${c.why}`, floor: tier, candidate: resolved.candidate, overridden: [...resolved.overridden, { owner: resolved.owner, reason: "opus switch replaced by a consult" }] };
      reasons.push("consult: Opus architect instead of a switch");
    }
  }
  return { ...plan, tier, reasons, need, kept, choice, shadow, own, votes, resolved, route, lastWorkBand, consult };
}
var outcomeOf = (r) => ({ route: `${r.route.family}/${r.route.effort}`, owner: r.route.owner, ...r.resolved.check?.gate ? { gate: r.resolved.check.gate } : {}, ...r.consult ? { consult: r.consult.choice } : {}, ...r.fallback ? { fallback: true } : {} });
var fingerprint2;
function routeFingerprint() {
  fingerprint2 ??= fnv1a([routeAuto, planAuto, autoFloors, executorInput, escalationStep, optimizeAuto, eligibilityOf, secondCall, fallbackEffort, fallbackModel, ownEffort, runningRuledOut, resolve, switchCheck, consultOrSwitch, executorEffort].map((f) => f.toString()).join("\n"));
  return fingerprint2;
}
function replayOf(input, result, priceBook, flags) {
  return { input: JSON.parse(JSON.stringify(input)), outcome: outcomeOf(result), provenance: { schema: AUTO_ROUTE_SCHEMA, fingerprint: routeFingerprint(), priceBook, flags } };
}

// hooks/v4.ts
import { COMPACT_SYSTEM, transcriptOf } from "./lib/compact.ts";
import { FORK_PROMPT, buildHandoff, completeness, forkWorth, parseForkFacts, renderHandoff, withFork } from "./lib/handoff.ts";
import { cacheNote, closeEpisodes, consultOutcome, durationsFrom, effortFirst, episodeBase, openEpisode, patchEpisode, influence, planFiles, priceConsult, RECUR_PRIOR } from "./lib/rescue.ts";
import { EMPTY_LEARNED, bucketOf as bucketOf2, noteTask, opusBuckets, parseLearned } from "./lib/learn.ts";
import { EXTRACT_MAX_TOKENS, EXTRACT_REPLY_TOKENS, EXTRACT_SYSTEM, EXTRACT_TOOL, GATE_TOKENS, extractPrompt, gateNote, gateRead, gateable, outlineOf, parseEvidence, renderEvidence, tokensOf, verifyEvidence } from "./lib/delegation.ts";
var V4_DEFAULTS = {
  router: "classic",
  mode: "shadow",
  activation: "always",
  pickerModel: "claude-sonnet-5-5[1m]",
  workflowName: "automode:run",
  // Automatic workflow entry stays off until a benchmark shows value. am:run always works.
  autoWorkflow: false,
  standardMode: "discover",
  reviewPolicy: "risk",
  maxConcurrency: 1,
  judgeModel: "haiku",
  judgeVersion: 2,
  judgeTimeoutMs: 8e3,
  compactWith: "haiku",
  compactModel: "claude-haiku-5-5",
  redirectExplore: true,
  workerTools: true,
  workerDeadlineMs: 18e4,
  // Opt-in: route built-in subagents (lib/subagents.ts) in every session, not only while AutoMode is the model. Needs no
  // judge. bench/retro-replay.mts measures what this saves on your own transcripts.
  subagentsEverySession: false,
  blockGitWritesWhenActive: true,
  recordDecisions: true,
  signals: true,
  // Decision semantics. `legacy` is the interval optimizer; `auto` is AutoMode Auto (lib/auto.ts: the effortless
  // judge per model and the AutoMode judge, one joint choice). Under `auto` the legacy route is recorded beside it,
  // never applied. AUTOMODE_POLICY overrides this. Any other value (the retired `v4.1` too) runs `legacy`.
  policy: "legacy",
  // Policy auto: false keeps the app's model and routes the effort only (benchmark arm 4, a safe first rollout).
  routeModels: true,
  // Completion evidence (lib/completion.ts). `report` records the state. `block` also sends the model back, once per task.
  completionGate: "report",
  // Route learning (lib/learn.ts): repeated rescues in a kind of task start that kind on Opus, per project.
  learning: false,
  // Low-tier work without critical risk can run on Haiku (lib/auto.ts). config.json turns it on.
  reachHaiku: false,
  // Delegated reads (lib/delegation.ts). `shadow` records what the gate would do and changes nothing.
  delegation: "off",
  delegationGateTokens: GATE_TOKENS,
  // Policy auto: `sonnet` makes Sonnet the task's model and keeps the judge's pick as a shadow route (lib/executor.ts).
  executor: "judge",
  // Policy auto: `effort-first` raises effort once per failure episode on strong evidence before the model moves (lib/rescue.ts).
  strongStep: "model",
  // Policy auto: `priced` asks the architect only when that costs less than moving the session (lib/rescue.ts priceConsult).
  consult: "always",
  // Policy auto: what an Opus consult gets (lib/handoff.ts). `fork-gated` adds a same-model fork only for a gap the conversation holds.
  packet: "basic",
  // Policy auto: `on` puts a same-model fork agent before the Opus consult: full context, warm cache, read only.
  forkRung: "off",
  // Policy auto: `evidence` starts T3 work on Sonnet high and leaves Opus to the escalation ladder (lib/auto.ts). `judge`
  // is the old rule: a T3 rating with critical risk or an Opus need starts on Opus. config.json ships `evidence`.
  opusStart: "judge",
  effortJudgeTimeoutMs: JUDGE_CALL.timeoutMs
};
var BREAKER_FAILURES = UNCLASSIFIED.kind === "breaker" ? UNCLASSIFIED.threshold : 3;
var BREAKER_COOLDOWN_MS = UNCLASSIFIED.kind === "breaker" ? UNCLASSIFIED.cooldownMs : 3e5;
var ERROR_MATCH_MS = 6e4;
var emptyLedger = () => ({ requests: 0, byModel: {}, cacheRead: 0, cacheWrite: 0, judgeUsd: 0, judgeCalls: 0, subagentUsd: 0 });
var S = {
  cfg: V4_DEFAULTS,
  loaded: false,
  mode: "off",
  provider: "anthropic",
  effortShared: true,
  ttl: 3e5,
  current: null,
  pending: null,
  envelope: null,
  lastSummary: "",
  resetPending: true,
  votes: { tier: null, n: 0 },
  requestsSinceSwitch: 0,
  verifiedSinceSwitch: false,
  cache: null,
  lastReply: "",
  lastPromptText: "",
  turnPrompt: /* @__PURE__ */ new Map(),
  workers: /* @__PURE__ */ new Map(),
  lastCheck: null,
  editedSinceCheck: false,
  records: [],
  toldJudgeDown: false,
  taskSeq: 0,
  // Completion evidence for the task in obligationsTask (lib/completion.ts).
  obligations: [],
  obligationsTask: null,
  obligationEdited: false,
  completionBlocks: 0,
  completionState: "none",
  lastOutcome: null,
  sessionId: "unknown",
  restored: false,
  expectWorker: 0,
  // Per-model warm cache (effortless markWarm): until when each model's prefix stays cached, and at which effort.
  warm: {},
  turnRequests: /* @__PURE__ */ new Map(),
  // main requests per turn, for outcome records
  stayUp: 0,
  redoFloor: null,
  // effortless stay-up after a redo
  heldRoute: null,
  // a lower route picked mid-turn waits for the turn to end
  planMode: false,
  planExited: false,
  editLog: [],
  agents: /* @__PURE__ */ new Map(),
  // every subagent seen, for the ledger
  // Provider errors are scoped to provider and model, and bounded: a model that did not answer BREAKER_FAILURES requests in
  // a row (and was not interrupted by the person) is skipped for BREAKER_COOLDOWN_MS, then tried again.
  breakers: {},
  lastNoResponse: null,
  failures: [],
  // recent no-response requests, awaiting a class
  pendingErrors: [],
  // StopFailure words not yet matched to a request
  signalErrorAt: 0,
  signalMode: "",
  compactionPricedAt: 0,
  // the compaction a prompt's own decision already priced: its trigger does not route again
  haikuOutUntilCompaction: false,
  // a context overflow on Haiku: Haiku is skipped until the next compaction
  thinkingRisk: false,
  // the configured thinking mode may reject a per-message effort change (lib/mode.ts)
  effortUnsupported: false,
  // an invalid_request after a rewrite: effort changes are not sent for the rest of the session
  toldErrorClass: "",
  toldBreaker: false,
  inadequate: null,
  // the running route is below the need (policy auto)
  toldInadequateTask: "",
  policy: "legacy",
  // Policy auto (lib/auto.ts).
  penv: {},
  // provider environment: the effort cache rule is decided per model
  lastAuto: null,
  verdictCache: {},
  // unchanged task state: the same verdicts
  taskDecision: null,
  // the unfinished task's last judged route, for "continue"
  decidedPlanMode: false,
  // the plan mode the last decision saw
  lastRisk: "none",
  newInput: false,
  // the next main request carries new input: a message typed mid-turn, or a note this mod added
  lastEffective: null,
  // the effort in effect at the API (per-message changes wait for new input)
  appEffort: void 0,
  // the effort the app itself asks for on main requests
  appModel: void 0,
  // the model the app itself asks for on main requests
  sessionModel: void 0,
  // the session's model before the first request
  pinFamily: void 0,
  // set by /model: routing keeps this model until am:reset
  pinEffort: void 0,
  // set by /effort: routing keeps this effort until am:reset
  turnOverride: null,
  // what an am: command fixed for this turn: it beats a pin
  unroutable: false,
  // the app's model is not one this router runs: requests pass through unrewritten
  appPlan: false,
  // plan mode at the last main request: leaving it changes the app's model too
  ladderNote: null,
  // an escalation note for the next main tool result or prompt
  judgeRiskTask: void 0,
  // the task whose risk a failed judge raised, until a judge answers
  toldPolicy: false,
  judgeBreaker: {},
  cwd: void 0,
  // the session's working directory, for the per-project first-request size
  prefixSource: null,
  preflight: void 0,
  // the first request's raw size from the composed prompt and tools; undefined until computed
  prefixEstimate: null,
  // the median first-request prompt size of earlier sessions, measured
  firstPrefixSaved: false,
  workflowPending: null,
  // this turn's prompt chose the workflow
  workflowRanTask: void 0,
  // the task the workflow last ran on
  learned: EMPTY_LEARNED,
  learnedTold: void 0,
  // the task the learned route was last announced for
  gatedReads: [],
  // task:path of each large read the gate has seen: the next one runs
  consulted: [],
  // failure fingerprints an Opus consult already answered: the next repeat switches
  consultCounts: {},
  // failures of that fingerprint when the consult ran
  consultMs: [],
  // how long each architect consult ran in this session, for the consult price
  consultLog: [],
  // this task's ladder consults and what came of them (lib/rescue.ts)
  taskPrompts: [],
  // the person's messages in this task after the first, for the consult packet
  bashEdits: 0,
  // edits made through Bash in this task (writesFiles): an edit for the completion gate too
  forkRuns: /* @__PURE__ */ new Map(),
  // fork agents the ladder asked for
  resolvedCounts: {},
  // policy auto: failures of that fingerprint when its command passed again
  switchesThisTask: 0,
  // discretionary model switches in this task (anti-oscillation)
  dropped: {},
  // thinking tokens dropped since each family last ran (lib/continuity.ts)
  rent: null,
  // shadow only: the rent rule's running total (lib/rent.ts); it never picks a route
  lastDemand: null,
  // the demand the last judgment gave; triggers re-optimize on it
  stage: "implement",
  lastWorkBand: void 0,
  // the band of the last real work, kept through a challenge so a second one keeps its floor
  workStage: "implement",
  // what the agent is doing now (lib/stage.ts); recorded and shown, and it shapes plan and challenge routes
  verifiedAfterPlan: false,
  judgedThisStage: false,
  compactedPending: false,
  requestsInPrompt: 0,
  basePrefixMeasured: false,
  lastMessageCount: 0,
  basePrefix: 0,
  // tokens that stay cached across a compaction (system prompt and tools), measured per session
  compactedAt: 0,
  // User tier: the signals file (external) stands in for hooks the engine skips.
  signalsOn: true,
  signalSeq: 0,
  signalCompactAt: 0,
  compactHookSeen: false,
  toldUserTier: false,
  upgradeVotesFor(tier) {
    this.votes = this.votes.tier === tier ? { tier, n: this.votes.n + 1 } : { tier, n: 1 };
    return this.votes.n;
  },
  priors: DEFAULT_PRIORS2,
  providerGuard: false,
  toldGuard: false,
  // The bar's mode selector (hooks/ui): this session only, never written to config. loadV4 applies it over config.json
  // and userConfig and under AUTOMODE_ROUTER; it is in the snapshot, so a settings reload keeps it.
  sessionMode: null,
  // The request ledger for the UI: running sums of the prices pushRequest and the judges already compute.
  ledger: emptyLedger()
};
var U = {
  killed: false,
  configMode: "off",
  judging: false,
  deferred: null,
  verdict: null,
  candidates: [],
  agents: /* @__PURE__ */ new Map()
};
var resetU = () => {
  U.judging = false;
  U.deferred = null;
  U.verdict = null;
  U.candidates = [];
  U.agents.clear();
};
async function loadV4($) {
  S.loaded = true;
  try {
    S.cfg = { ...V4_DEFAULTS, ...JSON.parse(await fsRead($, `${$.plugin.root}/config.json`)) };
  } catch {
    S.cfg = V4_DEFAULTS;
  }
  S.cfg = { ...S.cfg, ...routerOverrides(currentOptions(), storedOptions()) };
  const safe = async (p) => {
    try {
      return await p;
    } catch {
      return void 0;
    }
  };
  const routerEnv = await safe($.env.get("AUTOMODE_ROUTER"));
  U.killed = ["off", "0", "false"].includes(String(routerEnv ?? "").trim().toLowerCase());
  U.configMode = S.cfg.router === "v4" ? modeOf2(S.cfg, { AUTOMODE_ROUTER: routerEnv }) : "off";
  S.mode = S.cfg.router === "v4" ? modeOf2(S.sessionMode ? { ...S.cfg, mode: S.sessionMode } : S.cfg, { AUTOMODE_ROUTER: routerEnv }) : "off";
  const penv = {
    CLAUDE_CODE_USE_VERTEX: await safe($.env.get("CLAUDE_CODE_USE_VERTEX")),
    CLAUDE_CODE_USE_BEDROCK: await safe($.env.get("CLAUDE_CODE_USE_BEDROCK")),
    CLAUDE_CODE_USE_FOUNDRY: await safe($.env.get("CLAUDE_CODE_USE_FOUNDRY")),
    ANTHROPIC_BASE_URL: await safe($.env.get("ANTHROPIC_BASE_URL")),
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: await safe($.env.get("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"))
  };
  S.provider = providerOf(penv);
  const signalsEnv = String(await safe($.env.get("AUTOMODE_SIGNALS")) ?? "").trim().toLowerCase();
  S.signalsOn = S.cfg.signals !== false && !["off", "0", "false"].includes(signalsEnv);
  S.providerGuard = S.mode === "auto" && S.provider !== "anthropic" && !S.cfg.allowUnverifiedProviders;
  if (S.providerGuard) S.mode = "shadow";
  S.penv = penv;
  S.effortShared = effortSharesCache(penv, "claude-sonnet-5-5");
  const onPlan = !await safe($.env.get("ANTHROPIC_API_KEY"));
  S.ttl = ttlMs({ CLAUDE_CODE_PROMPT_CACHE_TTL: await safe($.env.get("CLAUDE_CODE_PROMPT_CACHE_TTL")), FORCE_PROMPT_CACHING_5M: await safe($.env.get("FORCE_PROMPT_CACHING_5M")), ENABLE_PROMPT_CACHING_1H: await safe($.env.get("ENABLE_PROMPT_CACHING_1H")) }, S.provider, onPlan);
  S.priors = await loadPriors($);
  if (S.cfg.learning) S.learned = await loadLearned($);
  const policyEnv = String(await safe($.env.get("AUTOMODE_POLICY")) ?? "").trim().toLowerCase();
  const wanted = policyEnv || String(S.cfg.policy ?? "legacy").trim().toLowerCase();
  S.policy = wanted === "auto" ? "auto" : "legacy";
  if (wanted !== "auto" && wanted !== "legacy" && !S.toldPolicy) {
    S.toldPolicy = true;
    S.records.push({ v: 1, kind: "policy-note", at: Date.now(), sessionId: S.sessionId, asked: wanted.slice(0, 20), running: "legacy", why: wanted === "v4.1" ? "v4.1 was replaced by auto" : "unknown policy" });
    try {
      $.ui.toast(`AutoMode: policy "${wanted.slice(0, 20)}" is not available${wanted === "v4.1" ? ' (replaced by "auto")' : ""}; running "legacy".`);
    } catch {
    }
  }
  S.prefixEstimate = await loadPrefixEstimate($);
  let settings = {};
  try {
    const home2 = await safe($.env.get("CLAUDE_CONFIG_DIR")) || `${await safe($.env.get("HOME"))}/.claude`;
    settings = JSON.parse(await fsRead($, `${home2}/settings.json`));
  } catch {
  }
  S.thinkingRisk = thinkingRisk({ MAX_THINKING_TOKENS: await safe($.env.get("MAX_THINKING_TOKENS")), AUTOMODE_THINKING_GUARD: await safe($.env.get("AUTOMODE_THINKING_GUARD")) }, settings);
}
var FIRST_PREFIX_KEEP = 20;
var projectKey = (cwd) => cwd ? fnv1a2(cwd) : "unknown";
var nums = (v) => (Array.isArray(v) ? v : []).filter((x) => typeof x === "number" && Number.isFinite(x) && x > 0);
async function firstFile($) {
  try {
    const file = `${await dataDir2($)}/first-prefix.json`;
    if (!await fsExists($, file)) return { byProject: {}, ratios: [] };
    const j = JSON.parse(await fsRead($, file));
    return { byProject: Object.fromEntries(Object.entries(j.byProject ?? {}).map(([k, v]) => [k, nums(v)])), ratios: nums(j.ratios) };
  } catch {
    return { byProject: {}, ratios: [] };
  }
}
var CHARS_PER_TOKEN = 3.5;
var PER_TOOL_TOKENS = 150;
var PREFLIGHT_MIN_RATIOS = 3;
async function preflight($) {
  try {
    const [composed, tools2] = await Promise.all([$.prompt.compose(), $.tool.list()]);
    const sys = composed.sections.reduce((a, s) => a + s.text.length, 0);
    if (!sys) return null;
    const toolChars = tools2.reduce((a, t) => a + t.name.length + (t.description?.length ?? 0), 0);
    return Math.round((sys + toolChars) / CHARS_PER_TOKEN + tools2.length * PER_TOOL_TOKENS);
  } catch {
    return null;
  }
}
var FIRST_PREFIX_HEADROOM = 4e3;
async function loadPrefixEstimate($) {
  const { byProject: by, ratios } = await firstFile($);
  if (!S.cache && S.preflight === void 0) S.preflight = await preflight($);
  const median = (xs) => [...xs].sort((a, b2) => a - b2)[Math.floor((xs.length - 1) / 2)];
  if (!S.cache && S.preflight && ratios.length >= PREFLIGHT_MIN_RATIOS) {
    S.prefixSource = "preflight (calibrated)";
    return Math.round(S.preflight * median(ratios)) + FIRST_PREFIX_HEADROOM;
  }
  const own = (by[projectKey(S.cwd)] ?? []).sort((a, b2) => a - b2);
  if (own.length) {
    S.prefixSource = "project median";
    return own[Math.floor(own.length / 2)] + FIRST_PREFIX_HEADROOM;
  }
  const all = Object.values(by).flat().sort((a, b2) => a - b2);
  if (all.length) {
    S.prefixSource = "machine p75";
    return all[Math.floor(0.75 * (all.length - 1))] + FIRST_PREFIX_HEADROOM;
  }
  if (!S.cache && S.preflight && S.preflight + FIRST_PREFIX_HEADROOM > DEFAULT_PARAMS2.haikuMaxContext) {
    S.prefixSource = "preflight (lower bound)";
    return S.preflight + FIRST_PREFIX_HEADROOM;
  }
  S.prefixSource = null;
  return null;
}
async function saveFirstPrefix($, tokens) {
  try {
    const { byProject: by, ratios } = await firstFile($);
    const k = projectKey(S.cwd);
    const ratio = S.preflight ? tokens / S.preflight : null;
    const nextRatios = ratio && ratio >= 0.5 && ratio <= 20 ? [...ratios, Math.round(ratio * 1e3) / 1e3].slice(-FIRST_PREFIX_KEEP) : ratios;
    await fsWrite($, `${await dataDir2($)}/first-prefix.json`, JSON.stringify({ byProject: { ...by, [k]: [...by[k] ?? [], tokens].slice(-FIRST_PREFIX_KEEP) }, ratios: nextRatios }));
  } catch {
  }
}
var prefixUnknown = () => !S.cache && S.prefixEstimate === null;
function routingCache() {
  const c = cacheState();
  return !S.cache && S.prefixEstimate ? { ...c, prefixTokens: S.prefixEstimate } : c;
}
async function loadPriors($) {
  try {
    const file = `${await dataDir2($)}/calibration.json`;
    if (!await fsExists($, file)) return DEFAULT_PRIORS2;
    const c = JSON.parse(await fsRead($, file));
    const p = c.priors ?? c;
    const num = (v, d) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d;
    return {
      ...DEFAULT_PRIORS2,
      outputPerStep: { haiku: num(p.outputPerStep?.haiku, DEFAULT_PRIORS2.outputPerStep.haiku), sonnet: num(p.outputPerStep?.sonnet, DEFAULT_PRIORS2.outputPerStep.sonnet), opus: num(p.outputPerStep?.opus, DEFAULT_PRIORS2.outputPerStep.opus) },
      effortOutput: Object.fromEntries(EFFORTS3.map((x) => [x, num(p.effortOutput?.[x], DEFAULT_PRIORS2.effortOutput[x])])),
      newInputPerStep: num(p.newInputPerStep, DEFAULT_PRIORS2.newInputPerStep),
      remainingRequests: num(p.remainingRequests, DEFAULT_PRIORS2.remainingRequests),
      remaining: Array.isArray(p.remaining) && p.remaining.every((r) => [r.k, r.n, r.p25, r.median, r.p75].every((x) => typeof x === "number")) && p.remaining.length ? p.remaining : void 0,
      remainingByStage: p.remainingByStage && typeof p.remainingByStage === "object" ? Object.fromEntries(Object.entries(p.remainingByStage).filter(([, t]) => Array.isArray(t) && t.length && t.every((r) => [r.k, r.n, r.p25, r.median, r.p75].every((x) => typeof x === "number")))) : void 0,
      basis: p.basis === "calibrated" ? "calibrated" : "estimate",
      source: String(p.source ?? "calibration.json")
    };
  } catch {
    return DEFAULT_PRIORS2;
  }
}
async function activeV4($) {
  let id = S.sessionId;
  try {
    id = await sid($);
  } catch {
  }
  if (S.restored && id !== S.sessionId) {
    Object.assign(S, freshSession());
    resetU();
    S.loaded = false;
  }
  if (!S.loaded) await loadV4($);
  if (S.mode === "off") return false;
  let live = S.cfg.activation !== "picker";
  if (!live) {
    try {
      live = (await sessionModel($)).trim() === S.cfg.pickerModel;
    } catch {
      return false;
    }
  }
  if (live && !S.restored) {
    await restore2($);
    if (S.sessionMode) {
      await loadV4($);
      if (S.mode === "off") return false;
    }
  }
  return live;
}
async function spawnOutsideAutoMode($, e, next) {
  let parent = e.parentModel ?? "";
  if (!parent) {
    try {
      parent = await sessionModel($);
    } catch {
      return next(e);
    }
  }
  const sr = subagentRoute({ type: e.subagentType, explicitModel: e.model, parentFamily: familyOf2(parent), demand: null });
  const res = sr ? await next({ ...e, model: sr.model }) : await next(e);
  noteAgent(res, e, sr?.model, !!sr);
  return res;
}
var SNAPSHOT_KEYS = ["sessionMode", "ledger", "lastAuto", "taskDecision", "decidedPlanMode", "lastRisk", "lastEffective", "appEffort", "appModel", "sessionModel", "pinFamily", "pinEffort", "judgeRiskTask", "inadequate", "haikuOutUntilCompaction", "planExited", "signalMode", "lastWorkBand", "workStage", "breakers", "failures", "signalErrorAt", "effortUnsupported", "current", "cache", "envelope", "votes", "requestsSinceSwitch", "verifiedSinceSwitch", "lastSummary", "taskSeq", "warm", "stayUp", "redoFloor", "planMode", "switchesThisTask", "dropped", "rent", "lastDemand", "stage", "consulted", "pending", "compactedPending", "basePrefix", "compactedAt", "lastMessageCount", "consultCounts", "resolvedCounts", "signalSeq", "signalCompactAt", "compactHookSeen", "toldUserTier", "editedSinceCheck", "lastCheck", "obligations", "obligationsTask", "completionBlocks", "completionState"];
async function restore2($) {
  S.restored = true;
  try {
    S.sessionId = await sid($);
  } catch {
  }
  try {
    const snap = await $.store.get(`hm4:${S.sessionId}`);
    if (!snap || typeof snap !== "object") return;
    for (const k of SNAPSHOT_KEYS) if (k in snap) S[k] = snap[k];
    S.lastReply = String(snap.lastReply ?? "");
    S.resetPending = snap.compactedPending === true;
  } catch {
  }
}
async function persist2($) {
  if (S.sessionId === "unknown") return;
  const snap = { lastReply: S.lastReply.slice(0, 600) };
  for (const k of SNAPSHOT_KEYS) snap[k] = S[k];
  try {
    await $.store.set(`hm4:${S.sessionId}`, snap);
  } catch {
  }
}
async function now2($) {
  try {
    return await $.clock.now();
  } catch {
    return Date.now();
  }
}
function cacheState() {
  return S.cache ?? { model: null, effort: null, prefixTokens: 0, lastRequestAt: null, ttlMs: S.ttl, effortSharesCache: S.effortShared };
}
function prices() {
  return rowFor(S.provider);
}
async function learnedFile($) {
  return `${await dataDir2($)}/learned-${projectKey(S.cwd)}.json`;
}
async function loadLearned($) {
  try {
    return parseLearned(await fsRead($, await learnedFile($)));
  } catch {
    return EMPTY_LEARNED;
  }
}
async function noteLearned($, corrected) {
  const env = S.envelope, a = S.lastAuto;
  if (!S.cfg.learning || S.mode !== "auto" || !env || !S.current || !a?.hm || a.taskId !== env.taskId) return;
  const seen = S.learned.tasks.find((t) => t.id === env.taskId);
  const start = seen?.family ?? S.current.family;
  const rescued = start !== "opus" && S.current.family === "opus" && env.escalations > 0;
  const outcome = corrected || rescued ? "bad" : env.verified ? "ok" : "open";
  S.learned = noteTask(S.learned, { id: env.taskId, bucket: bucketOf2(a.hm.tier, a.need?.model), family: start, outcome, at: await now2($) });
  await fsWrite($, await learnedFile($), JSON.stringify(S.learned)).catch(() => {
  });
}
async function dataDir2($) {
  let dir;
  try {
    dir = await $.env.get("CLAUDE_PLUGIN_DATA");
  } catch {
  }
  if (!dir) {
    let home2;
    try {
      home2 = await $.env.get("CLAUDE_CONFIG_DIR") ?? `${await $.env.get("HOME")}/.claude`;
    } catch {
    }
    dir = `${home2 ?? "."}/plugins/data/automode`;
  }
  return dir;
}
async function recordsFile($) {
  const id = S.sessionId === "unknown" ? "no-session" : S.sessionId.replace(/[^\w.-]/g, "_");
  return `${await dataDir2($)}/records/${id}.jsonl`;
}
var flushing = Promise.resolve();
function flush($) {
  flushing = flushing.then(() => flushNow($)).catch(() => {
  });
  return flushing;
}
async function flushNow($) {
  if (!S.cfg.recordDecisions || !S.records.length) return;
  const lines = S.records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  S.records = [];
  try {
    const file = await recordsFile($);
    let before = "";
    if (await fsExists($, file)) {
      before = await fsRead($, file);
      if (shouldRotate(before.length + lines.length)) {
        await fsWrite($, `${file}.1`, before);
        before = "";
      }
    }
    await fsWrite($, file, before + lines);
  } catch {
  }
}
async function judge($, text, midTurn, attachments) {
  const t0 = await now2($);
  if (S.policy === "auto" && judgePaused("automode", t0)) {
    S.records.push({ v: 1, kind: "model-call", purpose: "judge", at: t0, sessionId: S.sessionId, ok: false, ms: 0, error: "paused" });
    return { answer: null, ms: 0 };
  }
  const r = await $.model.complete({
    model: S.cfg.judgeModel,
    system: S.cfg.judgeVersion >= 4 ? JUDGE_SYSTEM_V4 : S.cfg.judgeVersion === 3 ? JUDGE_SYSTEM_V3 : JUDGE_SYSTEM,
    maxTokens: 240,
    effort: "low",
    timeoutMs: S.cfg.judgeTimeoutMs,
    // Contract v4 does not show the current route: a judge that sees "T3 opus xhigh" echoes it for a one-line steer.
    prompt: judgePrompt(text, { lastReply: S.lastReply, current: S.current && S.cfg.judgeVersion < 4 ? `${S.current.tier} ${S.current.model} ${S.current.effort}` : void 0, midTurn, attachments, stripReminders: S.cfg.judgeVersion >= 4 })
  }).catch(() => null);
  const ms = await now2($) - t0;
  if (!r || !r.isAnswered) {
    if (S.policy === "auto") judgeOutcome("automode", false, t0 + ms);
    S.records.push({ v: 1, kind: "model-call", purpose: "judge", at: t0, sessionId: S.sessionId, ok: false, ms });
    return { answer: null, ms };
  }
  const u = r.usage;
  const tokens = usageOf(u);
  const usd = usageUsd(tokens, ANTHROPIC2.rates.haiku);
  noteJudge(usd);
  S.records.push({ v: 1, kind: "model-call", purpose: "judge", at: t0, sessionId: S.sessionId, ok: true, ms, model: u.model ?? S.cfg.judgeModel, usage: tokens, usd: { value: round6(usd), basis: "measured", source: `${ANTHROPIC2.provider} ${ANTHROPIC2.checkedAt}` } });
  const answer = parseJudge(r.text);
  if (S.policy === "auto") judgeOutcome("automode", !!answer, t0 + ms);
  return { answer, ms, usd };
}
function raiseForFailedJudge() {
  if (!S.envelope) return;
  if (S.envelope.risk.effective === "none") S.judgeRiskTask = S.envelope.taskId;
  S.envelope = { ...S.envelope, risk: { ...S.envelope.risk, effective: maxRisk(S.envelope.risk.effective, "elevated") } };
}
function taskBoundary($, text, answer, override, followUp, at2) {
  const boundary = isBoundary({ explicitNew: !!override?.newTask, cleared: false, judgeNewTask: !!answer?.newTask, judgeConfidence: answer?.confidence ?? 0, followUp, envelope: S.envelope });
  let reason = S.resetPending ? "reset" : "none";
  if (boundary) {
    if (S.envelope && S.envelope.status === "open" && S.envelope.reviewRequired.value && !S.envelope.verified && S.mode === "auto")
      $.ui.toast(`AutoMode: the previous task still had a required review (${S.envelope.reviewRequired.because[0]}).`);
    settleConsults(at2, { taskEnded: true, verified: S.completionState === "verified" });
    const risk = prospectiveRisk(text, answer ? { risk: maxRisk(answer.risk, answer.consequence ?? "none"), why: answer.riskWhy } : null);
    S.taskSeq += 1;
    S.envelope = newEnvelope(`task-${at2}-${S.taskSeq}`, `turn-${at2}`, text, at2, answer?.complexity ?? "standard", risk);
    S.editLog = [];
    S.consulted = [];
    S.consultLog = [];
    S.taskPrompts = [];
    S.bashEdits = 0;
    S.consultCounts = {};
    S.resolvedCounts = {};
    S.switchesThisTask = 0;
    S.verifiedAfterPlan = false;
    S.judgedThisStage = false;
    reason = "new-task";
  } else if (S.envelope) {
    S.taskPrompts = [...S.taskPrompts, text.slice(0, 2e3)].slice(-10);
    const judged = answer ? maxRisk(answer.risk, answer.consequence ?? "none") : "none";
    const risk = prospectiveRisk(text, answer && judged !== "none" ? { risk: judged, why: answer.riskWhy } : null);
    const routing = risk.routing ?? risk.level;
    if (judged !== "none" || routing === "critical") S.envelope = withReview({ ...S.envelope, risk: { ...S.envelope.risk, prospective: risk, effective: routing === "critical" ? "critical" : S.envelope.risk.effective } }, "none", false);
  }
  if (answer && S.envelope && S.judgeRiskTask === S.envelope.taskId) {
    if (S.envelope.risk.effective === "elevated") S.envelope = { ...S.envelope, risk: { ...S.envelope.risk, effective: maxRisk(S.envelope.risk.prospective.level, S.envelope.risk.observed?.level ?? "none") } };
    S.judgeRiskTask = void 0;
  }
  return { boundary, reason };
}
async function decide($, text, midTurn, attachments, at2, attachList = []) {
  if (S.policy === "auto") return decideAuto($, text, midTurn, attachList.length ? attachList : Array.from({ length: attachments }, () => ({ type: "file" })), at2);
  const override = parseOverride(text);
  const tr = attachments ? null : transitionOf(text, S.lastReply);
  const redo = !!S.current && looksLikeRedo2(text);
  if (override?.reset) {
    S.stayUp = 0;
    S.redoFloor = null;
    S.pinFamily = void 0;
    S.pinEffort = void 0;
  }
  const followUp = !!tr && tr.bypassJudge && !!S.envelope && !redo && !override?.reset;
  if (redo) {
    S.stayUp = REDO_STAY_PROMPTS2;
    S.redoFloor = TIER_ORDER[Math.min(4, tierRank2(S.current.tier) + 1)];
  } else if (S.stayUp > 0) S.stayUp -= 1;
  if (S.stayUp === 0) S.redoFloor = null;
  let answer = null;
  let method = "judge";
  let judgeInfo = { called: false };
  if (followUp) method = tr.kind === "continue" ? "continuation" : "transition";
  else if (override?.tier && override.strategy === void 0 && !override.newTask && S.envelope) method = "override";
  else {
    const j = await judge($, midTurn && S.current ? `${text}

${midTurnNote(S.current.effort)}` : text, midTurn, attachments);
    answer = j.answer;
    judgeInfo = { called: true, ms: j.ms, ok: !!j.answer, usd: j.usd };
    if (!answer) {
      method = "fallback";
      if (!S.toldJudgeDown && S.mode === "auto") {
        S.toldJudgeDown = true;
        $.ui.toast("AutoMode: the Haiku judge did not answer, so routing keeps the current model until it does.");
      }
    }
  }
  await syncSignals($);
  const { boundary, reason } = taskBoundary($, text, answer, override, followUp, at2);
  const env = S.envelope;
  const complexity = answer?.complexity ?? env.complexity;
  let floor = floorFor(env, complexity);
  const stage = stageOf({
    planMode: S.planMode,
    planJustExited: S.planExited,
    transition: tr?.kind,
    tier: answer?.tier,
    complexity: answer?.complexity,
    strategy: override?.strategy ?? answer?.strategy,
    text,
    previous: S.workStage,
    repeatedFailure: substantiveFailures(env) > 0,
    hasEdits: env.editedPaths.length > 0
  });
  const stageMin = 0;
  S.workStage = stage;
  let opt = null;
  let used = null;
  let heldEffort;
  let currentInadequate = false;
  let candidate;
  if (answer) {
    const demand = demandOf({ ...answer, consequence: env.risk.effective }, S.planMode, substantiveFailures(env));
    S.lastDemand = demand;
    used = demand;
    if (stage !== "reconsider") S.lastWorkBand = demand.band;
    opt = pick(S.policy, demand, floor, at2, void 0, false, stageMin);
    candidate = { tier: tierOf2(opt.best.family, opt.best.effort), source: "judge", confidence: answer.confidence, reason: `${answer.why || "judge"}; ${opt.best.family} ${opt.best.effort} ${opt.best.adequacy}${opt.inadequate ? " (inadequate)" : ""}` };
    currentInadequate = false;
    floor = inadequateFloor(floor, opt);
    heldEffort = heldEffortFor(demand, floor, at2, opt, stageMin);
  } else if (S.current && (method === "continuation" || method === "transition")) {
    candidate = { tier: S.current.tier, source: "continuation", confidence: 1, reason: method === "transition" ? tr.why : "follow-up keeps the task route" };
  } else {
    if (method === "fallback") raiseForFailedJudge();
    const demand = demandOf({ tier: "T2", complexity: env.complexity, risk: S.envelope.risk.effective, confidence: 0.5 }, S.planMode, substantiveFailures(env));
    S.lastDemand = demand;
    used = demand;
    opt = pick(S.policy, demand, floor, at2, void 0, true);
    candidate = { tier: tierOf2(opt.best.family, opt.best.effort), source: "fallback", confidence: 0.5, reason: `judge unavailable: conservative ${opt.best.family} ${opt.best.effort}` };
  }
  S.votes = S.votes.tier === candidate.tier ? { tier: candidate.tier, n: S.votes.n + 1 } : { tier: candidate.tier, n: 1 };
  const route = resolve2({
    override: override?.tier || override?.effort ? { tier: override.tier, effort: override.effort, reason: `user: ${text.trim().split(/\s/)[0]}` } : void 0,
    floor,
    candidate,
    effortHint: opt ? opt.best.effort : method === "continuation" ? S.current?.effort : method === "transition" ? tr.effort ?? S.current?.effort : void 0,
    heldEffort,
    ...currentInadequate ? { currentInadequate } : {},
    current: usableCurrent(at2),
    switchInput: {
      cache: cacheState(),
      now: at2,
      votes: S.votes.n,
      requestsSinceSwitch: S.requestsSinceSwitch,
      verifiedSinceSwitch: S.verifiedSinceSwitch,
      // Leaving plan mode is a designed hand-off: a downgrade from planning skips the dwell gate.
      sameTask: !boundary && !S.planExited,
      risk: env.risk.effective,
      expectedOutputTokens: S.priors.outputPerStep[S.current?.family ?? "sonnet"],
      prices: prices(),
      params: { ...DEFAULT_PARAMS2, calibrated: S.priors.basis === "calibrated" },
      requestsInPrompt: 0,
      newTaskSteps: boundary ? S.lastDemand?.steps : void 0,
      remainingTable: remainingTable(),
      switchesThisTask: S.switchesThisTask,
      targetWarm: opt ? warmFor(opt.best.family, at2) : false,
      targetWarmPrefix: opt ? S.warm[opt.best.family]?.prefixTokens : void 0,
      resetPrefixTokens: S.compactedAt ? S.basePrefix : void 0,
      ...continuityInput(S.compactedPending)
    }
  }, S.resetPending);
  S.planExited = false;
  const consult = void 0;
  const routed = route;
  const hint = S.planMode ? "direct" : override?.strategy ?? answer?.strategy ?? null;
  const work = hint === "isolated-worker" ? { p50: 4e4, p75: 8e4, source: "estimate: judge marked large exploration" } : workFromFiles([], text.length);
  const entry = entryValue(answer, env);
  const strategy = choose({ hint, workflowPurpose: entry.purpose, risk: env.risk.effective, designDecision: routed.tier === "T3" && answer?.complexity === "complex", main: routed.family, worker: "haiku", cache: cacheState(), work, outputTokens: 1500, prices: prices() }, answer?.confidence ?? 0.5);
  const injected = injection(env, reason, S.lastSummary);
  const chosen = override?.strategy ?? strategy.chosen;
  S.inadequate = null;
  const costTotal = opt ? {
    mainUsd: round6(opt.ranked.find((x) => x.family === routed.family && x.effort === routed.effort)?.attemptUsd ?? opt.best.attemptUsd),
    switchUsd: round6(routed.check?.estUsd ?? 0),
    judgeUsd: round6(judgeInfo?.usd ?? 0),
    reviewRequired: env.reviewRequired.value,
    consult: !!consult,
    basis: "estimate",
    excluded: "retries and rework (no outcome data); subagents and reviews are route-independent"
  } : void 0;
  return {
    route: routed,
    strategy: chosen,
    strategyChoice: strategy,
    method,
    judge: judgeInfo,
    answer,
    newTask: boundary,
    contextNote: injected,
    optimizer: opt,
    redo,
    ...consult ? { consult } : {},
    ...entry.reasons.length ? { workflow: entry } : {},
    ...costTotal ? { costTotal } : {},
    ...override ? { override: { source: /^am:/i.test(text) ? "am-command" : "typed-command", scope: "turn" } } : {},
    ...tr && tr.kind !== "ambiguous" ? { transition: tr.kind } : {},
    stage,
    ...!S.cache && S.prefixEstimate ? { firstRequest: { tokens: S.prefixEstimate, source: S.prefixSource ?? "unknown" } } : {}
  };
}
var DEFAULT_EFFORT = { haiku: "medium", sonnet: "high", opus: "medium" };
var JUDGE_RETRY_MODEL = "haiku";
var JUDGE_FAILURES_TO_PAUSE = 3;
var JUDGE_PAUSE_MS = 6e4;
function judgePaused(kind, t) {
  return (S.judgeBreaker[kind]?.until ?? 0) > t;
}
function judgeOutcome(kind, ok, t) {
  const b2 = S.judgeBreaker[kind] ?? { failures: 0, until: 0 };
  const failures = ok ? 0 : Math.min(b2.failures + 1, JUDGE_FAILURES_TO_PAUSE);
  const until = !ok && failures >= JUDGE_FAILURES_TO_PAUSE ? t + JUDGE_PAUSE_MS : ok ? 0 : b2.until;
  if (!ok && until > t && b2.until <= t) S.records.push({ v: 1, kind: "judge-pause", at: t, sessionId: S.sessionId, judge: kind, untilMs: JUDGE_PAUSE_MS });
  S.judgeBreaker = { ...S.judgeBreaker, [kind]: { failures, until } };
}
var effortSharedFor = (model) => effortSharesCache(S.penv, model);
var runningEffort = () => S.current ? S.lastEffective ?? S.current.effort : void 0;
async function sessionMessages($) {
  try {
    return (await $.session.messages()).map((m) => ({ role: String(m.role), text: String(m.text ?? "") }));
  } catch {
    return [];
  }
}
async function effortlessJudge($, family, prompt, o) {
  const t0 = await now2($);
  if (judgePaused("effortless", t0)) {
    S.records.push({ v: 1, kind: "model-call", purpose: o.purpose ?? "effortless-judge", family, at: t0, sessionId: S.sessionId, ok: false, ms: 0, attempts: 0, error: "paused" });
    return { verdict: null, ms: 0 };
  }
  const fresh2 = !!S.cache?.lastRequestAt && await now2($) - S.cache.lastRequestAt <= S.ttl && !o.newTask;
  const effort = S.current?.family === family && fresh2 ? runningEffort() : DEFAULT_EFFORT[family];
  const inputFor = (closing) => judgeInputFor(prompt, { family, effort, messages: o.messages, midTurnEffort: o.midTurnEffort, attachments: o.attachments, planMode: S.planMode, closing });
  const ask = (model, closing = false) => $.model.complete({ model, system: EFFORTLESS_SYSTEM, prompt: inputFor(closing), maxTokens: JUDGE_CALL.maxTokens, effort: JUDGE_CALL.effort, timeoutMs: S.cfg.effortJudgeTimeoutMs ?? JUDGE_CALL.timeoutMs }).catch(() => null);
  let r = await ask(JUDGE_CALL.model);
  let attempts = 1;
  if (r && !r.isAnswered && r.reason === "api-error" && r.status != null) {
    r = await ask(JUDGE_RETRY_MODEL);
    attempts = 2;
  }
  let ms = await now2($) - t0;
  const purpose = o.purpose ?? "effortless-judge";
  if (!r || !r.isAnswered) {
    judgeOutcome("effortless", false, t0 + ms);
    S.records.push({ v: 1, kind: "model-call", purpose, family, plan: S.planMode, at: t0, sessionId: S.sessionId, ok: false, ms, attempts, error: r?.error ?? (r ? r.reason : "threw") });
    return { verdict: null, ms };
  }
  let tokens = usageOf(r.usage);
  let usd = usageUsd(tokens, ANTHROPIC2.rates.haiku);
  noteJudge(usd);
  let v = parseVerdict(r.text);
  if (!v) {
    const again = await ask(JUDGE_CALL.model, true);
    attempts += 1;
    if (again?.isAnswered) {
      tokens = usageOf(again.usage);
      const more = usageUsd(tokens, ANTHROPIC2.rates.haiku);
      noteJudge(more);
      usd += more;
      v = parseVerdict(again.text);
    }
  }
  ms = await now2($) - t0;
  judgeOutcome("effortless", !!v, t0 + ms);
  S.records.push({ v: 1, kind: "model-call", purpose, family, plan: S.planMode, at: t0, sessionId: S.sessionId, ok: !!v, ...v ? {} : { error: "unparsed reply" }, attempts, ms, model: r.usage?.model ?? JUDGE_CALL.model, usage: tokens, usd: { value: round6(usd), basis: "measured", source: `${ANTHROPIC2.provider} ${ANTHROPIC2.checkedAt}` } });
  return { verdict: v ? { model: v.model, effort: v.effort, why: v.why, ...v.sure !== void 0 ? { sure: v.sure } : {} } : null, ms, usd };
}
var normalizeText = (t) => t.trim().toLowerCase().replace(/\s+/g, " ");
function floorFacts(env) {
  return { taskId: env.taskId, risk: env.risk.effective, riskReasons: env.risk.prospective.reasons, ladderFloor: env.ladder?.floor ?? null, taskDecision: S.taskDecision ?? null, stayUp: S.stayUp, currentFamily: S.current?.family ?? null };
}
var executorOn = () => S.cfg.executor === "sonnet" && S.cfg.routeModels !== false;
var cacheFresh = (at2) => !!S.cache?.lastRequestAt && at2 - S.cache.lastRequestAt <= S.ttl;
function attemptTable(complexity, at2) {
  const x = { cache: routingCache(), warm: S.warm, now: at2, prices: prices(), priors: S.priors, neutral: true };
  const cell = (family, effort) => {
    const usd = attemptCost({ family, effort, cap: { lo: 0, hi: 0 } }, { steps: TASK_STEPS2[complexity] }, x).usd;
    return Number.isFinite(usd) ? usd : null;
  };
  return Object.fromEntries(["haiku", "sonnet", "opus"].map((f) => [f, Object.fromEntries(EFFORTS3.map((e) => [e, cell(f, e)]))]));
}
var autoCost = (complexity, at2) => costOf(attemptTable(complexity, at2));
var appFamily = () => familyOf2(S.appModel ?? "") ?? familyOf2(S.sessionModel ?? "") ?? familyOf2(S.current?.model ?? "") ?? "sonnet";
async function noteAppChoice($, e, at2) {
  const c = readAppChoice({ model: S.appModel, effort: S.appEffort }, e, { family: S.pinFamily, effort: S.pinEffort }, S.planMode || S.appPlan !== S.planMode);
  S.appPlan = S.planMode;
  const from = { model: S.appModel ?? null, effort: S.appEffort ?? null };
  const fallback = !!c.family && familyOf2(await sessionModel($).catch(() => "")) !== c.family;
  if (!fallback) {
    if (typeof e.model === "string") S.appModel = e.model;
    if (typeof e.effort === "string") S.appEffort = e.effort;
  }
  const record2 = (axis, action, why, extra = {}) => S.records.push({ v: 1, kind: "pin", at: at2, sessionId: S.sessionId, axis, action, why, via: "request", from, to: { model: e.model ?? null, effort: e.effort ?? null }, route: S.current ? `${S.current.family}/${S.current.effort}` : null, plan: S.planMode, ...extra });
  if (c.unroutable !== S.unroutable) {
    S.unroutable = c.unroutable;
    record2("model", c.unroutable ? "unroutable" : "routable", c.unroutable ? "the app model is outside the routed families" : "the app model is routable again");
    if (c.unroutable) $.ui.toast(`AutoMode: routing does not run ${String(e.model).slice(0, 40)}, so routing is off. Choose Haiku, Sonnet or Opus to turn it back on.`);
  }
  if (c.unroutable && !S.turnOverride?.family) {
    S.pending = null;
    S.heldRoute = null;
    S.current = null;
  }
  for (const why of c.skipped) record2(why.split(":")[0], "skipped", why);
  if (fallback) {
    record2("model", "skipped", "model: the session did not move");
    return;
  }
  if (c.family) {
    record2("model", "pinned", "the app model changed", { echo: c.family === S.current?.family });
    S.pinFamily = c.family;
    $.ui.toast(`AutoMode: you chose ${c.family}, so model routing is off. Type am:reset to turn it back on.`);
  }
  if (c.effort) {
    record2("effort", "pinned", "the app effort changed", { echo: c.effort === S.lastEffective });
    S.pinEffort = c.effort;
    $.ui.toast(`AutoMode: you set effort to ${c.effort}, so effort routing is off. Type am:reset to turn it back on.`);
  }
}
async function v4CommandRun($, e, next) {
  const out = await next(e);
  try {
    const byPerson = e.origin?.kind === "composer" || e.origin?.kind === "bridge" || e.origin?.kind === "sdk";
    const c = byPerson ? commandChoice(e.command, e.args) : null;
    if (!c || !await useV4($) || !await activeV4($) || S.mode !== "auto") return out;
    if (e.command === "model") {
      S.pinFamily = c.family;
      S.appModel = void 0;
      S.appEffort = void 0;
    } else {
      S.pinEffort = c.effort;
      S.appEffort = void 0;
    }
    S.records.push({ v: 1, kind: "pin", at: await now2($), sessionId: S.sessionId, axis: e.command, action: c.release ? "released" : "pinned", why: `/${e.command}`, via: "command", to: c.family ?? c.effort ?? null, route: S.current ? `${S.current.family}/${S.current.effort}` : null, plan: S.planMode });
    await persist2($);
    if (!c.release) $.ui.toast(e.command === "model" ? `AutoMode: you chose ${c.family}, so model routing is off. Type am:reset to turn it back on.` : `AutoMode: you set effort to ${c.effort}, so effort routing is off. Type am:reset to turn it back on.`);
  } catch {
  }
  return out;
}
function pinned(r, appModel) {
  return applyPins(r, { family: S.pinFamily, effort: S.pinEffort }, S.turnOverride ?? {}, appModel, DEFAULT_LADDER2.models);
}
var pinnedEffort = () => S.turnOverride?.effort ?? S.pinEffort;
function allowedAuto(at2) {
  const ok = allowedFamilies(at2).filter((f) => !(f === "haiku" && routingCache().prefixTokens > DEFAULT_PARAMS2.haikuMaxContext));
  return ok.length ? ok : ["sonnet"];
}
function autoRecord(choice, verdicts, hm, steps, required, fallback, need, replay) {
  return {
    verdicts,
    need,
    hm,
    rule: choice.rule,
    steps,
    required,
    ...fallback ? { fallback } : {},
    routeModels: S.cfg.routeModels !== false,
    ...replay ? { replay } : {},
    candidates: choice.candidates.map((c) => ({ route: `${c.family}/${c.effort}`, ...c.verdictEffort ? { verdict: c.verdictEffort } : {}, eligibility: c.eligibility, usd: round6(Number.isFinite(c.attemptUsd) ? c.attemptUsd : -1), why: c.why.slice(0, 6) }))
  };
}
async function decideAuto($, text, midTurn, attachList, at2) {
  const steps = [];
  await syncSignals($);
  const override = parseOverride(text);
  const redo = !!S.current && looksLikeRedo2(text);
  if (override?.reset) {
    S.stayUp = 0;
    S.pinFamily = void 0;
    S.pinEffort = void 0;
  }
  if (!S.appModel && !S.sessionModel) S.sessionModel = await sessionModel($).then((m) => m.trim() || void 0).catch(() => void 0);
  if (redo) S.stayUp = REDO_STAY_PROMPTS2;
  else if (S.stayUp > 0) S.stayUp -= 1;
  S.redoFloor = null;
  const tr = attachList.length ? null : transitionOf(text, S.lastReply);
  const messages = await sessionMessages($);
  const ctx = messages.length ? contextOf(messages) : S.lastReply ? `assistant: ${S.lastReply}` : "";
  const routeModels = S.cfg.routeModels !== false;
  const allowed = allowedAuto(at2);
  const fixedFamily = !routeModels ? appFamily() : override?.tier ? DEFAULT_LADDER2.tiers[override.tier].family : override?.effort && S.current ? S.current.family : S.pinFamily;
  const fixedEffort = override?.effort ?? (override?.tier === "T4" ? "max" : S.pinEffort);
  if (!routeModels) steps.push("routeModels false: the app model is kept");
  if (override?.tier || override?.effort) steps.push(`command: ${fixedFamily ?? "model by policy"}${fixedEffort ? ` at ${fixedEffort}` : ""}`);
  const pendingEscalation = S.envelope ? escalationStep(S.envelope.ladder?.floor ?? null, allowed) : null;
  const belowFloor = !!pendingEscalation && !!S.current && bandOf(S.current.family, runningEffort()) < pendingEscalation.band;
  const req = decisionRequired({ planEntered: S.planMode && !S.decidedPlanMode, planExited: S.planExited, escalation: belowFloor, command: !!override, compacted: S.compactedPending });
  const td = S.taskDecision && S.envelope && S.taskDecision.taskId === S.envelope.taskId ? S.taskDecision : null;
  const approves = tr?.kind === "begin-approved";
  const followUp = keepsEffort(text, ctx);
  const shortcut = !!td && !redo && !approves && !attachList.length && shortcutApplies(followUp, text, req) && textConsequence(text).level !== "critical";
  let answer = null;
  let anchor = NEED_ANCHOR;
  let cacheKey = "";
  let verdicts = {};
  const verdictRec = {};
  let judgeInfo = { called: false };
  let method = "judge";
  let hmCached = false;
  if (shortcut) {
    method = "continuation";
    steps.push("shortcut: upstream keepsEffort keeps the unfinished task");
  } else {
    const families = firstCalls(fixedFamily, S.current && allowed.includes(S.current.family) ? S.current.family : void 0);
    anchor = families[0];
    const key = fnv1a2([S.envelope?.taskId ?? "none", S.workStage, String(S.planMode), normalizeText(text), fnv1a2(S.lastReply.slice(-600)), S.envelope?.risk.effective ?? "none", families.join(","), String(midTurn)].join("|"));
    cacheKey = key;
    const hit = S.verdictCache[key];
    if (hit) {
      answer = hit.answer;
      verdicts = hit.verdicts;
      hmCached = true;
      for (const [f, v] of Object.entries(verdicts)) if (v) verdictRec[f] = { ...v, ok: true, cached: true };
      steps.push("verdict cache: unchanged task state, no new judge call");
    } else {
      const midEffort = midTurn && S.current ? runningEffort() : void 0;
      const [hmj, ...els] = await Promise.all([
        judge($, midTurn && S.current ? `${text}

${midTurnNote(runningEffort())}` : text, midTurn, attachList.length),
        ...families.map((f) => effortlessJudge($, f, text, { messages, midTurnEffort: midEffort, attachments: attachList }))
      ]);
      answer = hmj.answer;
      let usd = hmj.usd ?? 0;
      families.forEach((f, i) => {
        verdicts[f] = els[i].verdict;
        usd += els[i].usd ?? 0;
        verdictRec[f] = els[i].verdict ? { ...els[i].verdict, ms: els[i].ms, usd: round6(els[i].usd ?? 0), ok: true, cached: false } : { model: "-", effort: "-", why: "", ms: els[i].ms, ok: false, cached: false };
      });
      judgeInfo = { called: true, ms: Math.max(hmj.ms, ...els.map((x) => x.ms)), ok: !!answer, usd: round6(usd) };
    }
  }
  const askedNeed = verdicts[anchor] ?? null;
  const { boundary, reason } = taskBoundary($, text, answer, override, followUp && !!S.envelope, at2);
  if (!answer && method === "judge") raiseForFailedJudge();
  const env = S.envelope;
  const riskChanged = env.risk.effective !== S.lastRisk && !boundary;
  const complexity = answer?.complexity ?? env.complexity;
  const stage = stageOf({
    planMode: S.planMode,
    planJustExited: S.planExited,
    transition: tr?.kind,
    tier: answer?.tier,
    complexity: answer?.complexity,
    strategy: override?.strategy ?? answer?.strategy,
    text,
    previous: S.workStage,
    repeatedFailure: substantiveFailures(env) > 0,
    hasEdits: env.editedPaths.length > 0
  });
  const required = decisionRequired({ ...req.required ? Object.fromEntries(req.why.map((w) => [w, true])) : {}, newTask: boundary, riskChanged, stageChanged: stage !== S.workStage });
  const previousStage = S.workStage;
  S.workStage = stage;
  const hm = answer ? { tier: answer.tier, complexity: answer.complexity } : null;
  const packet = `Goal: ${env.spec.text.slice(0, 1500)}

The person now asks: ${text.slice(0, 600)}

Acceptance: ${env.acceptance.map((a) => a.text).join("; ").slice(0, 400) || "none stated"}

Files edited so far: ${env.editedPaths.slice(0, 30).join(", ") || "none"}`;
  const inputFor = (v, second2) => ({
    schemaVersion: AUTO_ROUTE_SCHEMA,
    now: at2,
    allowed,
    appFamily: appFamily(),
    ...fixedFamily ? { fixedFamily } : {},
    ...fixedEffort ? { fixedEffort } : {},
    ...override?.tier || override?.effort ? { command: { label: text.trim().split(/\s/)[0] } } : {},
    shortcut,
    kept: shortcut ? { family: td.family, effort: td.effort } : null,
    judge: answer ? { tier: answer.tier, complexity: answer.complexity, effort: answer.effort, confidence: answer.confidence, why: answer.why } : null,
    judgeCached: hmCached,
    anchor,
    verdicts: v,
    ...second2 ? { second: second2 } : {},
    complexity,
    stage,
    previousStage,
    boundary,
    riskChanged,
    planBoundary: req.why.includes("planExited") || req.why.includes("planEntered"),
    planExited: S.planExited,
    floor: floorFacts(env),
    current: S.current ? { route: S.current, running: runningEffort() } : null,
    usable: usableCurrent(at2),
    appEffort: S.appEffort,
    executor: { on: executorOn(), taskRoute: td && !boundary && !S.compactedPending && cacheFresh(at2) ? td : null },
    reachHaiku: S.cfg.reachHaiku,
    opusOnEvidence: S.cfg.opusStart === "evidence",
    learned: { on: !!S.cfg.learning, opusBuckets: S.cfg.learning ? opusBuckets(S.learned, at2) : [] },
    votes: S.votes,
    switching: {
      cache: cacheState(),
      reset: S.resetPending,
      requestsSinceSwitch: S.requestsSinceSwitch,
      verifiedSinceSwitch: S.verifiedSinceSwitch,
      switchesThisTask: S.switchesThisTask,
      remainingTable: remainingTable(),
      warm: { haiku: warmFor("haiku", at2), sonnet: warmFor("sonnet", at2), opus: warmFor("opus", at2) },
      warmPrefix: { haiku: S.warm.haiku?.prefixTokens, sonnet: S.warm.sonnet?.prefixTokens, opus: S.warm.opus?.prefixTokens },
      resetPrefixTokens: S.compactedAt ? S.basePrefix : void 0,
      continuity: continuityInput(S.compactedPending)
    },
    economics: { attempt: attemptTable(complexity, at2), outputPerStep: S.priors.outputPerStep, effortOutput: S.priors.effortOutput, effortSteps: DEFAULT_PRIORS2.effortSteps, prices: prices(), calibrated: S.priors.basis === "calibrated" },
    consult: { lastWorkBand: S.lastWorkBand, consulted: S.consulted, packetTokens: Math.ceil(packet.length / 3.5), ttlMs: S.ttl },
    policy: { lowConfidence: LOW_CONFIDENCE }
  });
  const plan = planAuto(inputFor(verdicts));
  for (const n of plan.notes) verdictRec[n.family] = { model: n.family, effort: n.effort, why: "", ok: false, cached: false, fallback: n.fallback };
  if (plan.fallback) method = "fallback";
  if (plan.fallback && !S.toldJudgeDown && S.mode === "auto") {
    S.toldJudgeDown = true;
    $.ui.toast("AutoMode: a judge did not answer, so routing keeps the current model until it does.");
  }
  if (plan.learnedBucket && S.learnedTold !== env.taskId) {
    S.learnedTold = env.taskId;
    S.records.push({ v: 1, kind: "learned", at: at2, sessionId: S.sessionId, taskId: env.taskId, bucket: plan.learnedBucket });
    $.ui.toast(`AutoMode: tasks like this needed Opus here before, so this one starts on Opus.`);
  }
  const second = plan.secondJudge;
  if (second) {
    const j2 = await effortlessJudge($, second, text, { messages, midTurnEffort: midTurn && S.current ? runningEffort() : void 0, attachments: attachList, purpose: "effortless-judge:second" });
    verdicts = { ...verdicts, [second]: j2.verdict };
    verdictRec[second] = j2.verdict ? { ...j2.verdict, ms: j2.ms, usd: round6(j2.usd ?? 0), ok: true, cached: false } : { model: "-", effort: "-", why: "", ms: j2.ms, ok: false, cached: false };
    judgeInfo = { ...judgeInfo, called: true, ms: (judgeInfo?.ms ?? 0) + j2.ms, usd: round6((judgeInfo?.usd ?? 0) + (j2.usd ?? 0)) };
  }
  const routeInput = inputFor(verdicts, second ?? void 0);
  const r = routeAuto(routeInput);
  steps.push(...r.reasons);
  const { choice, shadow, own, need, kept, fallback, ownFallback } = r;
  verdicts = r.verdicts;
  if (cacheKey && answer && Object.values(verdicts).every(Boolean) && !fallback && !ownFallback) S.verdictCache = Object.fromEntries([...Object.entries(S.verdictCache).slice(-40), [cacheKey, { verdicts, answer }]]);
  S.votes = r.votes;
  S.planExited = false;
  if (hm) S.lastWorkBand = r.lastWorkBand;
  let consult;
  const routed = r.route;
  if (r.consult) {
    const c = r.consult;
    S.records.push({ v: 1, kind: "escalation", at: at2, sessionId: S.sessionId, taskId: env.taskId, floor: null, action: c.choice === "consult" ? "consult-opus" : "switch", via: c.choice === "consult" ? "architect" : "switch", because: "challenge to finished hard work", estimate: { consultUsd: round6(c.consultUsd), switchUsd: round6(c.switchUsd), basis: S.priors.basis } });
    if (c.choice === "consult") {
      S.consulted = [...S.consulted, c.key].slice(-20);
      consult = packet;
    }
  }
  const heldBelow = own?.eligibility === "ineligible" && routed.owner === "cache-policy";
  const decided = heldBelow ? choice.best : routed;
  if (!shortcut && stage !== "complete" && stage !== "repo-op" && stage !== "reconsider") S.taskDecision = { taskId: env.taskId, family: decided.family, effort: decided.effort };
  S.lastAuto = shortcut ? S.lastAuto : { verdicts, need, hm, taskId: env.taskId };
  S.decidedPlanMode = S.planMode;
  S.lastRisk = env.risk.effective;
  if (answer) S.lastDemand = demandOf({ ...answer, consequence: env.risk.effective }, S.planMode, substantiveFailures(env));
  const hint = S.planMode ? "direct" : override?.strategy ?? answer?.strategy ?? null;
  const work = hint === "isolated-worker" ? { p50: 4e4, p75: 8e4, source: "estimate: judge marked large exploration" } : workFromFiles([], text.length);
  const entry = entryValue(answer, env);
  const strategy = choose({ hint, workflowPurpose: entry.purpose, risk: env.risk.effective, designDecision: routed.tier === "T3" && answer?.complexity === "complex", main: routed.family, worker: "haiku", cache: cacheState(), work, outputTokens: 1500, prices: prices() }, answer?.confidence ?? 0.5);
  const injected = injection(env, reason, S.lastSummary);
  const chosen = override?.strategy ?? strategy.chosen;
  const needBand = hm ? TIER_BAND2[hm.tier] : 0;
  if (!shortcut) S.inadequate = choice.inadequate && routed.owner !== "user-override" ? { need: needBand, shortfall: Math.max(0, needBand - BAND_OF2[routed.family][routed.effort]), route: `${routed.family}/${routed.effort}` } : null;
  const legacy = S.lastDemand && answer ? pick("legacy", S.lastDemand, { tier: r.tier.tier }, at2) : null;
  const mainUsd = choice.candidates.find((c) => c.family === routed.family)?.attemptUsd;
  return {
    route: routed,
    strategy: chosen,
    strategyChoice: strategy,
    method,
    judge: judgeInfo,
    answer,
    newTask: boundary,
    contextNote: injected,
    optimizer: null,
    redo,
    ...consult ? { consult } : {},
    ...entry.reasons.length ? { workflow: entry } : {},
    costTotal: { mainUsd: round6(mainUsd !== void 0 && Number.isFinite(mainUsd) ? mainUsd : choice.best.attemptUsd), switchUsd: round6(routed.check?.estUsd ?? 0), judgeUsd: round6(judgeInfo?.usd ?? 0), reviewRequired: env.reviewRequired.value, consult: !!consult, basis: "estimate", excluded: "retries and rework (no outcome data); subagents and reviews are route-independent" },
    ...override ? { override: { source: /^am:/i.test(text) ? "am-command" : "typed-command", scope: "turn" } } : {},
    ...tr && tr.kind !== "ambiguous" ? { transition: tr.kind } : {},
    stage,
    ...!S.cache && S.prefixEstimate ? { firstRequest: { tokens: S.prefixEstimate, source: S.prefixSource ?? "unknown" } } : {},
    ...legacy ? { compare: { policy: "legacy", route: `${legacy.best.family}/${legacy.best.effort}` } } : {},
    ...shadow ? { shadowRoute: `${shadow.family}/${shadow.effort}` } : {},
    ...S.inadequate ? { inadequate: S.inadequate } : {},
    routing: { cheapestAdequate: `${choice.best.family}/${choice.best.effort}`, chosen: `${routed.family}/${routed.effort}`, overRouted: routed.family !== choice.best.family || routed.effort !== choice.best.effort ? (choice.candidates.find((c) => c.family === routed.family)?.attemptUsd ?? 0) > choice.best.attemptUsd || EFFORTS3.indexOf(routed.effort) > EFFORTS3.indexOf(choice.best.effort) ? routed.owner : null : null, underRouted: own && S.current && routed.family === S.current.family && own.eligibility !== "eligible" && own.eligibility !== "needs-verdict" ? routed.owner : null },
    auto: autoRecord(choice, verdictRec, hm ? { ...hm, ok: true, cached: hmCached } : shortcut ? null : { tier: "-", complexity: "-", ok: false, cached: false }, steps, required.why, fallback ?? ownFallback, needRecord(anchor, shortcut ? kept : askedNeed), replayOf(routeInput, r, `${prices().provider} ${prices().checkedAt}`, { executor: executorOn(), learning: !!S.cfg.learning, reachHaiku: !!S.cfg.reachHaiku, routeModels: S.cfg.routeModels !== false }))
  };
}
function reoptimizeAuto(t, event, at2, turnId, reset = false) {
  if (!S.lastAuto || !S.envelope) return;
  const env = S.envelope;
  const complexity = S.lastAuto.hm?.complexity ?? env.complexity;
  const allowed = allowedAuto(at2);
  const mq = autoFloors(floorFacts(env), complexity, allowed, S.workStage);
  const routeModels = S.cfg.routeModels !== false;
  const current2 = S.current ? { family: S.current.family, effort: runningEffort() } : null;
  const baseFloors = { ...mq.floors, ...!routeModels ? { fixedFamily: appFamily() } : {} };
  const td = S.taskDecision && S.taskDecision.taskId === env.taskId ? S.taskDecision : null;
  const executed = executorInput(executorOn(), S.lastAuto.verdicts, baseFloors, !reset && td && cacheFresh(at2) ? td : null);
  const floors = executed?.floors ?? baseFloors;
  const choice = optimizeAuto({ allowed, verdicts: executed?.verdicts ?? S.lastAuto.verdicts, need: S.lastAuto.need, hm: S.lastAuto.hm, consequence: env.risk.effective, reachHaiku: S.cfg.reachHaiku, opusOnEvidence: S.cfg.opusStart === "evidence", floors, current: current2, cost: autoCost(complexity, at2) });
  let floor = mq.tier;
  if (t.mandatory) {
    const lift = tierOf2(choice.best.family, choice.best.effort);
    if (tierRank2(lift) > tierRank2(floor.tier)) floor = { tier: lift, effort: choice.best.effort, because: [t.reason] };
  }
  const own = S.current ? choice.candidates.find((c) => c.family === S.current.family) : void 0;
  const heldEffort = ownEffort(own) ?? (executed && S.current ? runningEffort() : void 0);
  const currentInadequate = runningRuledOut(S.current?.family, choice, floors, S.lastAuto.hm);
  const candidate = { tier: tierOf2(choice.best.family, choice.best.effort), source: "rules", confidence: 0.9, reason: `${t.reason}; ${choice.best.family} ${choice.best.effort} ${choice.best.eligibility}` };
  const route = resolve2({
    floor,
    candidate,
    effortHint: choice.best.effort,
    heldEffort,
    ...currentInadequate ? { currentInadequate } : {},
    effortCost,
    current: usableCurrent(at2),
    switchInput: {
      cache: cacheState(),
      now: at2,
      votes: S.upgradeVotesFor(candidate.tier),
      requestsSinceSwitch: S.requestsSinceSwitch,
      verifiedSinceSwitch: S.verifiedSinceSwitch,
      sameTask: event !== "plan-exit",
      risk: env.risk.effective,
      expectedOutputTokens: S.priors.outputPerStep[S.current?.family ?? "sonnet"],
      prices: prices(),
      params: { ...DEFAULT_PARAMS2, calibrated: S.priors.basis === "calibrated" },
      requestsInPrompt: S.requestsInPrompt,
      remainingTable: remainingTable(),
      switchesThisTask: S.switchesThisTask,
      targetWarm: warmFor(choice.best.family, at2),
      targetWarmPrefix: S.warm[choice.best.family]?.prefixTokens,
      resetPrefixTokens: S.compactedAt ? S.basePrefix : void 0,
      ...continuityInput(reset)
    }
  }, reset);
  S.pending = route;
  S.inadequate = choice.inadequate ? { need: S.lastAuto.hm ? TIER_BAND2[S.lastAuto.hm.tier] : 0, shortfall: 0, route: `${route.family}/${route.effort}` } : null;
  pushDecision("trigger", { route, strategy: "direct", strategyChoice: null, method: `trigger:${event}`, answer: null, newTask: false, contextNote: null, optimizer: null, redo: false, stage: S.workStage, auto: autoRecord(choice, {}, null, [`trigger ${event}: stored verdicts, no judge call`, `optimizer: ${choice.rule}`], [event], void 0, needRecord(NEED_ANCHOR, S.lastAuto.need)) }, true, at2, turnId, void 0, { event, reason: t.reason, mandatory: t.mandatory });
}
async function rejudgeAuto($, note, t, event, turnId) {
  const env = S.envelope;
  if (!env || !S.lastAuto) return;
  const prompt = `${env.spec.text.slice(0, 3e3)}

${note}`;
  const allowed = S.cfg.routeModels !== false ? allowedAuto(await now2($)) : [appFamily()];
  const messages = await sessionMessages($);
  const routeModels = S.cfg.routeModels !== false;
  const families = firstCalls(routeModels ? void 0 : appFamily(), S.current && allowed.includes(S.current.family) ? S.current.family : void 0);
  const anchor = families[0];
  const [hmj, ...first] = await Promise.all([judge($, prompt, true, 0), ...families.map((f) => effortlessJudge($, f, prompt, { messages, purpose: `effortless-judge:${event}` }))]);
  const verdicts = Object.fromEntries(families.map((f, i) => [f, first[i].verdict]));
  const need = verdicts[anchor] ?? S.lastAuto.need;
  const hmNow = hmj.answer ? { tier: hmj.answer.tier, complexity: hmj.answer.complexity } : S.lastAuto.hm;
  const second = routeModels ? secondCall({ allowed, verdicts, need, hm: hmNow, consequence: env.risk.effective, reachHaiku: S.cfg.reachHaiku, floors: { because: [] }, current: null, cost: () => 0 }, anchor) : null;
  if (second) verdicts[second] = (await effortlessJudge($, second, prompt, { messages, purpose: `effortless-judge:${event}:second` })).verdict;
  for (const f of [...families, second].filter(Boolean)) if (!verdicts[f] && S.lastAuto.verdicts[f]) verdicts[f] = S.lastAuto.verdicts[f];
  S.lastAuto = { verdicts, need, hm: hmNow, taskId: env.taskId };
  if (hmj.answer) S.lastDemand = demandOf({ ...hmj.answer, consequence: env.risk.effective }, S.planMode, substantiveFailures(env));
  S.records.push({ v: 1, kind: "rejudge", at: await now2($), sessionId: S.sessionId, taskId: env.taskId, event, hm: S.lastAuto.hm, verdicts: Object.fromEntries(Object.entries(verdicts).map(([f, v]) => [f, v ? `${v.model}/${v.effort}` : null])) });
  reoptimizeAuto(t, event, await now2($), turnId);
}
async function helperPick($, e, model) {
  if (e.fork || e.isTeammate || e.workflow || e.resume) return null;
  const family = familyOf2(model ?? "") ?? familyOf2(e.parentModel ?? "") ?? null;
  if (!family) return null;
  const fixed = pinnedEffort();
  if (fixed) return { effort: fixed, why: `the person set ${fixed}` };
  const floor = helperFloor("low", "max");
  const j = await effortlessJudge($, family, helperQuestion(String(e.prompt ?? ""), String(e.subagentType ?? "subagent")), { messages: await sessionMessages($), purpose: "effortless-helper" });
  if (!j.verdict) return { effort: floor, why: "helper judge failed: helper floor medium" };
  const effort = bounded2(j.verdict.effort, floor, "max");
  return { effort, why: `helper judge ${family}: ${j.verdict.effort}${effort !== j.verdict.effort ? " (helpers start at medium)" : ""}` };
}
function pick(_policy, demand, floor, at2, family, keepRunning = false, _stageMin = 0) {
  const x = { cache: routingCache(), warm: S.warm, now: at2, prices: prices(), priors: S.priors, neutral: true };
  const common = { haikuMaxContext: DEFAULT_PARAMS2.haikuMaxContext, allowed: allowedFamilies(at2), ...family ? { family } : {} };
  return optimize(demand, x, { ...common, minCap: Math.max(FLOOR_CAPABILITY2[floor.tier], keepRunning && S.current ? capOf(S.current) : 0) });
}
function heldEffortFor(demand, floor, at2, opt, stageMin = 0) {
  if (!S.current || S.current.family === opt.best.family || !allowedFamilies(at2).includes(S.current.family)) return void 0;
  const held = pick(S.policy, demand, floor, at2, S.current.family, false, stageMin);
  return held.best.feasible ? held.best.effort : void 0;
}
function entryValue(answer, env) {
  return workflowValue({
    autoWorkflow: S.cfg.autoWorkflow,
    alreadyRan: S.workflowRanTask === env.taskId,
    judged: answer?.strategy,
    complexity: answer?.complexity,
    risk: env.risk.effective,
    confidence: answer?.confidence ?? 0,
    failures: substantiveFailures(env),
    editedPaths: env.editedPaths,
    root: S.cwd
  });
}
function noteWorkflowCall() {
  if (S.workflowPending) S.workflowPending.called = true;
  S.workflowRanTask = S.envelope?.taskId;
}
function needsGuidance(d, env) {
  if (d.strategy !== "direct") return true;
  if (d.inadequate || d.consult) return true;
  if (env.reviewRequired.value || env.risk.effective !== "none") return true;
  if (env.failures.length && failureStep(env.failures, d.route.tier).action !== "none") return true;
  return d.route.owner === "user-override" || d.route.owner === "quality-escalation";
}
function routeHeader(d, env) {
  const r = d.route;
  const lines = [`[AutoMode: ${r.tier} ${r.family} ${r.effort} · ${r.owner}: ${r.reason}]`];
  if (d.consult) lines.push(`The person challenged finished hard work. Before you answer or change code, call the Agent tool with subagent_type "automode:architect" (Opus, read-only) and wait for it, with this evidence:
${d.consult}
Ask it whether the work is right, what is missing, and the fix plan. Apply its findings, run the checks, and answer the person.`);
  if (d.inadequate) lines.push(`No available model meets this task's need (band ${d.inadequate.need}; ${d.inadequate.route} is ${d.inadequate.shortfall} band${d.inadequate.shortfall === 1 ? "" : "s"} short). Treat the result as unverified: run the checks and get the independent review before you call it done, and tell the user about this limit.`);
  if (d.strategy === "isolated-worker" && S.cfg.workerTools) lines.push(delegation("discover", env));
  if (d.strategy === "engineering-workflow") {
    const args = workflowArgs({
      demand: S.lastDemand,
      userAsked: d.method === "override" || /^am:run\b/i.test(env.spec.text.trim()),
      risk: env.risk.effective,
      complexity: env.complexity,
      reviewRequired: env.reviewRequired.value,
      mode: S.cfg.standardMode,
      reviewPolicy: S.cfg.reviewPolicy,
      maxConcurrency: S.cfg.maxConcurrency
    });
    lines.push(`This is open-ended multi-module work. Run Workflow({ name: "${S.cfg.workflowName}", args: ${JSON.stringify(args)} }) and do not implement it yourself until it returns. Then follow its next_action: report the result, and change code only if next_action says the checks failed.`);
  }
  if (d.strategy !== "engineering-workflow" && (env.complexity !== "trivial" || env.risk.effective !== "none")) lines.push("Before you call a change done, run the relevant tests or build and show that they pass.");
  if (env.reviewRequired.value && d.strategy !== "engineering-workflow") lines.push(`After your checks pass, call the Agent tool with subagent_type "automode:reviewer" (${reviewerFamily(env.reviewRequired.because) === "sonnet" ? "Sonnet" : "Opus"}, read-only) and wait for it. Give it the original request, the acceptance criteria, each check with its output, and the changed files. Fix every blocker, run the checks again, and do not call it a second time.`);
  if (env.failures.length && failureStep(env.failures, r.tier).action === "report") lines.push(`The last check failed for an environment reason (${env.failures[env.failures.length - 1].command}). Tell the user what is missing instead of changing code.`);
  if (failureStep(env.failures, r.tier).action === "diagnose") lines.push(delegation("diagnose", env));
  lines.push("Commit or push only when the user asks you to.");
  return lines.join("\n");
}
var round6 = (n) => Math.round(n * 1e6) / 1e6;
function optimizerRecord(o) {
  const dm = S.lastDemand;
  return {
    required: round6(o.required),
    acceptable: o.acceptable,
    basis: o.basis,
    capabilitySource: o.capabilitySource,
    best: `${o.best.family}/${o.best.effort}`,
    demand: dm ? { difficulty: dm.difficulty, reasoning: dm.reasoning, steps: dm.steps, consequence: dm.consequence, verification: dm.verification, confidence: dm.confidence, planning: !!dm.planning, failures: dm.failures ?? 0, ...dm.band !== void 0 ? { band: dm.band, unsure: !!dm.unsure, bandWhy: dm.bandWhy ?? [] } : {} } : null,
    policy: S.policy,
    ...o.inadequate ? { inadequate: true, shortfall: o.shortfall ?? 0 } : {},
    top: o.ranked.slice(0, 4).map((x) => ({ route: `${x.family}/${x.effort}`, adequacy: x.adequacy, retry: x.retry, usd: round6(x.expectedUsd), usdRange: { lo: round6(x.expectedUsdRange.lo), hi: round6(x.expectedUsdRange.hi) }, feasible: x.feasible }))
  };
}
function floorFor(env, complexity) {
  let esc = failureStep(env.failures, S.current?.tier ?? "T1");
  const last2 = env.failures[env.failures.length - 1];
  if (esc.floor && last2 && S.consultCounts[last2.fingerprint] !== void 0 && env.failures.filter((f) => f.fingerprint === last2.fingerprint).length <= S.consultCounts[last2.fingerprint]) esc = { ...esc, floor: null };
  if (S.policy === "auto" && esc.floor && last2 && S.resolvedCounts[last2.fingerprint] !== void 0 && env.failures.filter((f) => f.fingerprint === last2.fingerprint).length <= S.resolvedCounts[last2.fingerprint]) esc = { ...esc, floor: null };
  const escBand = null;
  const riskFloor = env.risk.effective === "critical" && complexity !== "trivial" ? "T2" : "T0";
  const floors = [{ tier: riskFloor, because: `critical consequence: ${env.risk.prospective.reasons.slice(0, 2).join("; ") || "observed"}` }];
  if (esc.floor) floors.push({ tier: esc.floor, ...escBand ? { band: escBand.band } : {}, because: esc.because });
  if (S.redoFloor) floors.push({ tier: S.redoFloor, because: `a redo asked for better (${S.stayUp} prompts left)` });
  const top = floors.reduce((a, b2) => tierRank2(b2.tier) > tierRank2(a.tier) ? b2 : a);
  return { tier: top.tier, ...top.band !== void 0 ? { band: top.band } : {}, because: top.tier === "T0" ? [] : [top.because] };
}
function reoptimize(t, event, at2, turnId, reset = false) {
  if (S.policy === "auto") return reoptimizeAuto(t, event, at2, turnId, reset);
  if (!S.lastDemand || !S.envelope) return;
  const env = S.envelope;
  const failures = substantiveFailures(env);
  const b2 = S.lastDemand.tier ? demandBand2({ tier: S.lastDemand.tier, unsure: S.lastDemand.unsure, planning: S.planMode, failures, complexity: S.lastDemand.complexity }) : null;
  const demand = { ...S.lastDemand, planning: S.planMode, failures, consequence: env.risk.effective, ...b2 ? { band: b2.band, bandWhy: b2.why } : {} };
  S.lastDemand = demand;
  let floor = floorFor(env, env.complexity);
  const opt = pick(S.policy, demand, floor, at2);
  const lift = t.mandatory ? tierOf2(opt.best.family, opt.best.effort) : floor.tier;
  if (tierRank2(lift) > tierRank2(floor.tier)) {
    floor.tier = lift;
    floor.because = [t.reason];
  }
  const currentInadequate = false;
  floor = inadequateFloor(floor, opt);
  const heldEffort = heldEffortFor(demand, floor, at2, opt);
  const candidate = { tier: tierOf2(opt.best.family, opt.best.effort), source: "rules", confidence: demand.confidence, reason: `${t.reason}; ${opt.best.family} ${opt.best.effort} ${opt.best.adequacy}${opt.inadequate ? " (inadequate)" : ""}` };
  const route = resolve2({
    floor,
    candidate,
    effortHint: opt.best.effort,
    heldEffort,
    ...currentInadequate ? { currentInadequate } : {},
    current: usableCurrent(at2),
    switchInput: {
      cache: cacheState(),
      now: at2,
      votes: S.upgradeVotesFor(candidate.tier),
      requestsSinceSwitch: S.requestsSinceSwitch,
      verifiedSinceSwitch: S.verifiedSinceSwitch,
      sameTask: event !== "plan-exit",
      risk: env.risk.effective,
      expectedOutputTokens: S.priors.outputPerStep[S.current?.family ?? "sonnet"],
      prices: prices(),
      params: { ...DEFAULT_PARAMS2, calibrated: S.priors.basis === "calibrated" },
      requestsInPrompt: S.requestsInPrompt,
      remainingTable: remainingTable(),
      switchesThisTask: S.switchesThisTask,
      targetWarm: warmFor(opt.best.family, at2),
      targetWarmPrefix: S.warm[opt.best.family]?.prefixTokens,
      resetPrefixTokens: S.compactedAt ? S.basePrefix : void 0,
      ...continuityInput(reset)
    }
  }, reset);
  S.pending = route;
  pushDecision("trigger", { route, strategy: "direct", strategyChoice: null, method: `trigger:${event}`, answer: null, newTask: false, contextNote: null, optimizer: opt, redo: false, stage: S.workStage }, true, at2, turnId, void 0, { event, reason: t.reason, mandatory: t.mandatory });
}
async function rejudge($, t, at2) {
  if (!S.envelope) return;
  S.judgedThisStage = true;
  const env = S.envelope;
  const note = `[The task grew: ${t.reason}. Files edited so far: ${env.editedPaths.length}.]`;
  if (S.policy === "auto") return rejudgeAuto($, note, t, "scope-change", void 0);
  const j = await judge($, `${env.spec.text.slice(0, 3e3)}

${note}`, true, 0);
  if (!j.answer) return;
  S.lastDemand = demandOf({ ...j.answer, consequence: env.risk.effective }, S.planMode, substantiveFailures(env));
  reoptimize(t, "scope-change", at2, void 0);
}
function undoFailure(key, _why) {
  const b2 = S.breakers[key];
  if (!b2) return;
  const failures = Math.max(0, b2.failures - 1);
  S.breakers = { ...S.breakers, [key]: { ...b2, failures, openUntil: failures < (b2.threshold ?? BREAKER_FAILURES) ? 0 : b2.openUntil } };
}
async function reconcileErrors($, t) {
  const left = [];
  for (const err of S.pendingErrors) {
    const f = [...S.failures].reverse().find((x) => x.cls === "pending" && x.at <= err.at + 5e3 && err.at - x.at < ERROR_MATCH_MS);
    if (!f) {
      if (t - err.at < ERROR_MATCH_MS) left.push(err);
      continue;
    }
    const act = classifyError(err.error, err.detail);
    S.failures = S.failures.map((x) => x === f ? { ...x, cls: err.error } : x);
    if (f.effortOnly) {
      if (act.kind === "effort-unsupported") S.effortUnsupported = true;
      if (act.kind === "effort-unsupported" && S.toldErrorClass !== err.error) {
        S.toldErrorClass = err.error;
        $.ui.toast("AutoMode: the API refused a request with a rewritten effort. Effort changes are off for this session; the model route still applies.");
      }
    } else if (act.kind === "breaker") {
      const b2 = S.breakers[f.key];
      if (b2) S.breakers = { ...S.breakers, [f.key]: { ...b2, class: err.error, threshold: act.threshold, cooldownMs: act.cooldownMs, openUntil: b2.failures >= act.threshold ? f.at + act.cooldownMs : 0 } };
    } else {
      undoFailure(f.key, act.kind);
      if (act.kind === "context" && familyOf2(f.model) === "haiku") S.haikuOutUntilCompaction = true;
      if (S.lastNoResponse?.key === f.key) S.lastNoResponse = null;
      if (act.kind === "effort-unsupported") S.effortUnsupported = true;
      if (act.kind === "notify" && S.toldErrorClass !== err.error) {
        S.toldErrorClass = err.error;
        $.ui.toast(act.toast);
      }
      if (act.kind === "effort-unsupported" && S.toldErrorClass !== err.error) {
        S.toldErrorClass = err.error;
        $.ui.toast("AutoMode: the API refused a rerouted request. Effort changes are off for this session; the model route still applies.");
      }
    }
    S.records.push({ v: 1, kind: "provider-error", at: t, sessionId: S.sessionId, model: f.model, class: err.error, action: act.kind, why: act.why });
  }
  S.pendingErrors = left;
}
function allowedFamilies(at2) {
  const all = ["haiku", "sonnet", "opus"];
  const open = (f) => Object.entries(S.breakers).some(([k, b2]) => b2.openUntil > at2 && familyOf2(k.slice(k.indexOf(":") + 1)) === f);
  const ok = all.filter((f) => !open(f) && !(f === "haiku" && (prefixUnknown() || S.haikuOutUntilCompaction)));
  return ok.length ? ok : all.filter((f) => !(f === "haiku" && prefixUnknown()));
}
function warmFor(f, at2) {
  const w = S.warm[f];
  return !!w && w.until > at2 && familyOf2(S.cache?.model ?? "") !== f;
}
var continuityInput = (compacted) => ({ provider: S.provider, compacted, dropped: S.dropped, rent: S.rent });
async function hashFiles($, paths) {
  const out = {};
  for (const p of paths.slice(0, 40)) {
    try {
      const text = await fsRead($, p);
      if (text.length <= 4e5) out[p] = fnv1a2(text);
    } catch {
    }
  }
  return out;
}
function routingRecord(d) {
  const best = d.optimizer.best;
  const bands = false;
  const chosen = bands ? bandOf(d.route.family, d.route.effort) : mid2(CAPABILITY2[d.route.family][d.route.effort]);
  const target = bands ? bandOf(best.family, best.effort) : mid2(best.cap);
  const tol = bands ? 0 : 0.05;
  const heldPricier = d.route.owner === "cache-policy" && d.route.family !== best.family;
  const over = chosen > target + tol || heldPricier;
  const under = chosen < target - tol;
  return { cheapestAdequate: `${best.family}/${best.effort}`, chosen: `${d.route.family}/${d.route.effort}`, overRouted: over ? d.route.owner : null, underRouted: under ? d.route.owner : null };
}
function inadequateFloor(floor, opt) {
  if (!S.current || currentAdequate(opt)) return floor;
  const tier = tierOf2(opt.best.family, opt.best.effort);
  const why = false ? `${S.current.family} ${S.current.effort} is below band ${opt.required} for this task` : `${S.current.family} ${S.current.effort} is ${adequacy(CAPABILITY2[S.current.family][S.current.effort], opt.required)} for this task (need ${opt.required.toFixed(2)})`;
  return tierRank2(tier) > tierRank2(floor.tier) ? { tier, because: [why] } : floor;
}
var effortCost = {
  output: (r) => S.priors.outputPerStep[r.family] * S.priors.effortOutput[r.effort],
  steps: (r) => DEFAULT_PRIORS2.effortSteps[r.effort]
};
var remainingTable = () => S.policy === "auto" ? S.priors.remainingByStage?.[S.workStage] ?? S.priors.remaining : S.priors.remaining;
function usableCurrent(at2) {
  return S.current && allowedFamilies(at2).includes(S.current.family) ? S.current : null;
}
function currentAdequate(opt) {
  if (!S.current) return true;
  return opt.acceptable.includes(adequacy(CAPABILITY2[S.current.family][S.current.effort], opt.required));
}
function substantiveFailures(env) {
  const defects = env.failures.filter((f) => f.class === "defect" && f.editedSince);
  return Math.max(0, defects.length - 1);
}
function pushDecision(point, d, applied, at2, turnId, actual, trig) {
  const env = S.envelope;
  const c = cacheState();
  S.records.push(decisionRecord({
    at: at2,
    sessionId: S.sessionId,
    turnId,
    taskId: env?.taskId ?? "none",
    point,
    mode: S.mode,
    applied,
    method: d?.method ?? point,
    effective: d ? { tier: d.route.tier, model: d.route.model, effort: d.route.effort, owner: d.route.owner, reason: d.route.reason, floor: d.route.floor.tier, check: d.route.check, overridden: d.route.overridden } : { tier: S.current?.tier ?? "T1", model: S.current?.model ?? "", effort: S.current?.effort ?? "medium", owner: "fallback", reason: point, floor: "T0", overridden: [] },
    candidate: d?.route.candidate ? { tier: d.route.candidate.tier, source: d.route.candidate.source, confidence: d.route.candidate.confidence } : void 0,
    risk: env ? { prospective: env.risk.prospective.level, effective: env.risk.effective, reviewRequired: env.reviewRequired.value } : void 0,
    strategy: d ? {
      chosen: d.strategy,
      reason: d.strategyChoice?.reason ?? "",
      confidence: d.answer?.confidence ?? 0,
      basis: d.strategyChoice?.basis ?? "estimate",
      estimates: (d.strategyChoice?.estimates ?? []).map((x) => ({ strategy: x.strategy, p50: round6(x.usd.p50), p75: round6(x.usd.p75) }))
    } : void 0,
    optimizer: d?.optimizer ? optimizerRecord(d.optimizer) : void 0,
    ...d?.override ? { override: d.override } : {},
    ...d?.transition ? { transition: d.transition } : {},
    ...d?.stage ? { stage: d.stage } : {},
    ...d?.workflow ? { workflow: d.workflow } : {},
    ...d?.firstRequest ? { firstRequest: d.firstRequest } : {},
    ...d?.costTotal ? { costTotal: d.costTotal } : {},
    ...d?.compare ? { compare: d.compare } : {},
    ...d?.shadowRoute ? { shadowRoute: d.shadowRoute } : {},
    ...d?.inadequate ? { inadequate: d.inadequate } : {},
    ...d?.auto ? { auto: d.auto } : {},
    policy: S.policy,
    // Over-routing: the route that runs is stronger than the cheapest adequate one, and why (a floor,
    // the cache policy holding a warm stronger model, or an override). Measured per decision, not hidden.
    routing: d?.optimizer ? routingRecord(d) : d?.routing,
    judge: d?.judge ? { ...d.judge, basis: "measured" } : void 0,
    cache: { model: c.model, effort: c.effort, prefixTokens: c.prefixTokens, effortSharesCache: c.effortSharesCache, warm: c.lastRequestAt !== null && at2 - c.lastRequestAt <= c.ttlMs },
    actual,
    ...trig ? { trigger: trig } : {}
  }));
}
var WORKERS = { "automode:explorer": "discovery", "automode:diagnoser": "diagnosis" };
function delegation(kind, env) {
  if (kind === "diagnose") {
    const last2 = env.failures[env.failures.length - 1];
    const prompt = diagnosePrompt(last2?.command ?? "", last2?.evidence ?? "", env.editedPaths);
    return `Before changing more code, call the Agent tool with subagent_type "automode:diagnoser" and wait for it, with this prompt:
<<<
${prompt}
>>>
Use its cause and fix plan.`;
  }
  return `Before reading many files yourself, call the Agent tool once with subagent_type "automode:explorer" (read-only, Haiku) and wait for it. Give it the scope (a directory or area), the question, and ask for this report:
${DISCOVERY_REPORT.replace(/\n/g, " ")}
Then use the report: read a file yourself only for what it did not cover or listed under omitted.`;
}
async function v4SessionStart($, e, next) {
  if (typeof e?.cwd === "string") S.cwd = e.cwd;
  await loadV4($);
  S.resetPending = true;
  if (S.cfg.delegation === "on") {
    await $.tool.register({
      name: "extract",
      description: "Ask a cheap model one question about whole files, without loading them into this conversation. Returns findings with line numbers and quotes that were checked against the files. Use it for facts and locations in large files. Read the cited lines yourself before an edit or a decision that depends on exact behavior.",
      inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, description: "Absolute file paths" }, question: { type: "string", description: "One specific question" } }, required: ["paths", "question"] },
      isDeferred: false
    }).catch(() => {
    });
  }
  return next(e);
}
async function v4PromptSubmit($, e, next) {
  if (!isTask(e.text, e)) return next(e);
  const byPerson = e.origin?.kind === "composer" || e.origin?.kind === "bridge" || e.origin?.kind === "sdk";
  if (byPerson) S.loaded = false;
  if (!byPerson || !await activeV4($)) {
    if (byPerson) await publish($);
    return next(e);
  }
  const at2 = await now2($);
  const text = e.text.trim();
  if (S.lastOutcome) {
    const signal = nextSignal(text);
    if (signal !== "moved-on" && S.envelope?.taskId === S.lastOutcome.taskId) await noteLearned($, true);
    S.records.push({ v: 1, kind: "signal", at: at2, sessionId: S.sessionId, turnId: S.lastOutcome.turnId, taskId: S.lastOutcome.taskId, next: signal, route: S.current ? `${S.current.family}/${S.current.effort}` : null, underRouting: signal !== "moved-on" });
    S.lastOutcome = null;
  }
  if (S.providerGuard && !S.toldGuard) {
    S.toldGuard = true;
    S.records.push({ v: 1, kind: "guard", at: at2, sessionId: S.sessionId, provider: S.provider, reason: "auto mode is unverified on this provider: observing only (shadow)" });
    $.ui.toast(`AutoMode: auto routing is not verified on ${S.provider}; observing only. Claude Code runs as usual.`);
  }
  if (S.mode === "shadow") {
    S.lastPromptText = text;
    S.turnPrompt.set("next", { text, at: at2 });
    await publish($);
    return next(e);
  }
  const typed = parseOverride(text);
  if (S.unroutable && !typed?.tier && !typed?.effort && !typed?.reset) {
    await publish($);
    return next(e);
  }
  await syncSignals($);
  const midTurn = e.turnId !== void 0;
  if (!midTurn) S.requestsInPrompt = 0;
  const attachList = Array.isArray(e.attachments) ? e.attachments.map((a) => ({ type: String(a?.type ?? "file") })) : [];
  U.judging = true;
  await publish($);
  const d = await decide($, text, midTurn, attachList.length, at2, attachList).finally(() => {
    U.judging = false;
  });
  if (midTurn) S.newInput = true;
  if (!midTurn && S.compactedPending) S.compactionPricedAt = S.compactedAt;
  if (midTurn && S.pending && capOf(d.route) < capOf(S.pending)) S.heldRoute = d.route;
  else {
    S.pending = d.route;
    S.heldRoute = null;
    S.turnOverride = turnAxes(typed, d.route) ?? (midTurn ? S.turnOverride : null);
  }
  if (d.inadequate && S.envelope && !S.envelope.reviewRequired.because.includes(INADEQUATE_REVIEW)) S.envelope = { ...S.envelope, reviewRequired: { value: true, because: [...S.envelope.reviewRequired.because, INADEQUATE_REVIEW] }, revision: S.envelope.revision + 1 };
  const env = S.envelope;
  const guide = needsGuidance(d, env);
  const header = guide ? routeHeader(d, env) : null;
  const state = d.contextNote && (guide || !d.newTask) ? d.contextNote : null;
  const parts = [header, state, S.ladderNote].filter(Boolean);
  S.ladderNote = null;
  if (state) {
    S.lastSummary = summaryOf(env);
    S.envelope = { ...env, injectedRevision: env.revision };
    S.records.push({ v: 1, kind: "envelope", at: at2, sessionId: S.sessionId, taskId: env.taskId, reason: d.newTask ? "new-task" : "reset", acceptance: env.acceptance.length, reviewRequired: env.reviewRequired.value });
  }
  S.resetPending = false;
  if (d.inadequate && S.toldInadequateTask !== env.taskId) {
    S.toldInadequateTask = env.taskId;
    $.ui.toast(`AutoMode: no available model fully meets this task (${d.inadequate.shortfall} band short). Running ${d.inadequate.route}. Checks and review stay required.`);
  }
  barLine($, d.route);
  if (d.strategy === "engineering-workflow") S.workflowPending = { taskId: env.taskId, source: d.override ? "user" : "auto", called: false };
  pushDecision("prompt", d, true, at2, e.turnId);
  noteVerdict(d);
  await publish($);
  return next({ ...e, context: [...e.context ?? [], ...parts] });
}
var INADEQUATE_REVIEW = "no available model met the need for this task";
function barLine($, r) {
  $.ui.status(`AutoMode · ${r.family} ${r.effort}${S.planMode ? " · plan" : S.policy === "auto" && S.workStage !== "implement" ? ` · ${S.workStage === "plan-approved" ? "approved" : S.workStage}` : ""}${S.envelope?.reviewRequired.value ? " · review pending" : ""}${S.completionState === "none" ? "" : ` · ${S.completionState.replace("_", " ")}`}`);
}
var capOf = (r) => S.policy === "auto" ? bandOf(r.family, r.effort) + EFFORT_ORDER.indexOf(r.effort) / 10 : mid2(CAPABILITY2[r.family][r.effort]);
var EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
function trigState() {
  return { haikuMaxContext: DEFAULT_PARAMS2.haikuMaxContext, longContextAt: 1e5, scopeThreshold: 4, judgedThisStage: S.judgedThisStage, verifiedAfterPlan: S.verifiedAfterPlan };
}
function usageOf(u, subagent = false) {
  const total = u.cache_creation_input_tokens ?? 0;
  const split = u.cache_creation;
  const w1h = split ? split.ephemeral_1h_input_tokens ?? 0 : !subagent && S.ttl >= 36e5 ? total : 0;
  const w5m = split ? split.ephemeral_5m_input_tokens ?? Math.max(0, total - w1h) : total - w1h;
  return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite5m: w5m, cacheWrite1h: w1h };
}
function usdOf(model, u) {
  const fam = familyOf2(model) ?? "sonnet";
  return { value: round6(usageUsd(u, prices().rates[fam])), basis: "measured", source: `${prices().provider} ${prices().checkedAt}` };
}
function pushRequest(e, sent, owner, applied, why, res, at2, application) {
  const u = res?.usage ? usageOf(res.usage, e.agentId !== void 0) : null;
  const answered = res?.usage?.model ?? null;
  const price = u ? usdOf(answered ?? sent.model, u) : null;
  if (u && price) noteLedger(answered ?? sent.model, u, price.value, e.agentId);
  S.records.push(requestRecord({
    at: at2,
    sessionId: S.sessionId,
    turnId: e.turnId,
    index: e.index,
    agentId: e.agentId,
    taskId: S.envelope?.taskId ?? "none",
    app: { model: e.model, effort: e.effort ?? null },
    sent: { model: sent.model, effort: sent.effort ?? null },
    owner,
    effortApplied: applied,
    effortWhy: why,
    answered: { model: answered, thinking: thinkingOf(res?.usage) },
    usage: u,
    usd: price,
    ...application ? { application } : {}
  }));
}
async function* v4TurnStep($, e, next) {
  if (e.agentId !== void 0) {
    const w2 = S.workers.get(e.agentId);
    const a = S.agents.get(e.agentId);
    if (!w2 || S.mode !== "auto") {
      const routedEffort = S.mode === "auto" && (a?.routed || a?.judged) && a.effort && takesEffort(e.model) ? pinnedEffort() ?? a.effort : void 0;
      const res3 = yield* next(routedEffort ? { ...e, effort: routedEffort } : e);
      if (S.mode !== "off" && (w2 || a || await activeV4($))) {
        pushRequest(e, { model: e.model, effort: routedEffort ?? e.effort }, a?.routed ? "subagent-policy" : "app", !!routedEffort, a ? `subagent ${a.type}` : "subagent", res3, await now2($));
        if (res3?.stopReason && res3.stopReason !== "tool_use") await flush($);
        await publish($);
      }
      return res3;
    }
    const judged = S.agents.get(e.agentId);
    const effort = takesEffort(e.model) ? pinnedEffort() ?? (judged?.judged && judged.effort ? judged.effort : helperEffort(void 0, typeof e.effort === "string" ? e.effort : void 0)) : e.effort;
    const res2 = yield* next({ ...e, ...effort !== void 0 ? { effort } : {} });
    if (res2?.usage) w2.tokens = (res2.usage.input_tokens ?? 0) + (res2.usage.cache_read_input_tokens ?? 0) + (res2.usage.cache_creation_input_tokens ?? 0);
    if (w2.tokens >= HAIKU_BUDGET.stopAt) w2.stop = true;
    pushRequest(e, { model: e.model, effort }, "worker", effort !== e.effort, "worker effort floor medium", res2, await now2($));
    if (res2?.stopReason && res2.stopReason !== "tool_use") await flush($);
    await publish($);
    return res2;
  }
  if (S.mode === "off" || !await activeV4($)) return yield* next(e);
  const t = await now2($);
  if (e.index === 0) await syncSignals($, { turnId: e.turnId });
  S.turnRequests.set(e.turnId, (S.turnRequests.get(e.turnId) ?? 0) + 1);
  if (S.mode === "auto") await noteAppChoice($, e, t);
  if (S.mode === "shadow" || !S.pending) {
    const res2 = yield* next(e);
    pushRequest(e, { model: e.model, effort: e.effort }, "app", false, S.mode === "shadow" ? "shadow: app route" : "no route yet", res2, t);
    if (res2?.stopReason && res2.stopReason !== "tool_use") await flush($);
    markWarm(familyOf2(res2?.usage?.model ?? e.model), typeof e.effort === "string" ? e.effort : null, res2, t);
    await publish($);
    return res2;
  }
  S.requestsInPrompt += 1;
  if (S.lastMessageCount && typeof e.messageCount === "number" && e.messageCount + 2 < S.lastMessageCount) await noteCompaction($, `message count ${S.lastMessageCount} -> ${e.messageCount}`);
  if (typeof e.messageCount === "number") S.lastMessageCount = e.messageCount;
  if (S.compactedPending) {
    S.compactedPending = false;
    if (S.compactionPricedAt !== S.compactedAt) reoptimize(trigger(trigState(), { kind: "compacted" }), "compacted", t, e.turnId, true);
  } else if (e.index > 0 && S.cache?.lastRequestAt) {
    const tr = trigger(trigState(), { kind: "step-start", idleMs: t - S.cache.lastRequestAt, ttlMs: S.ttl });
    if (tr.action === "reoptimize") reoptimize(tr, "cache-expired", t, e.turnId);
  }
  const r = pinned(S.pending, e.model);
  S.pending = r;
  const sameFamily = familyOf2(e.model) === r.family;
  const model = sameFamily ? e.model : r.model;
  const w = S.warm[r.family];
  const ef = effortFor({ model, appEffort: e.effort, routeEffort: r.effort, owner: r.owner, effortShared: effortSharedFor(model), cacheEffort: w?.effort ?? null, resetPending: S.resetPending, warm: !!w && w.until > t, ...S.effortUnsupported ? { off: "effort changes are off: the API refused a rerouted request" } : S.thinkingRisk ? { off: "effort changes are off: the thinking mode may reject a per-message effort change" } : {} });
  const requested = typeof ef.sent === "string" ? ef.sent : null;
  const modelChanged = !!S.cache?.model && familyOf2(S.cache.model) !== familyOf2(model);
  const lg = requested ? legalEffort({ index: e.index, newInput: S.newInput, perMessage: effortSharedFor(model), requested, lastEffective: S.lastEffective, modelChanged }) : null;
  S.newInput = false;
  const application = lg ? { requested, effective: lg.effective, legalAt: lg.legalAt, deferred: lg.deferred } : null;
  const res = yield* next({ ...e, model, ...ef.sent !== void 0 ? { effort: ef.sent } : {} });
  if (lg && (res?.usage || res?.stopReason != null)) S.lastEffective = lg.effective;
  U.deferred = lg?.deferred ? requested : null;
  const effortOnlyRewrite = sameFamily && ef.applied && typeof ef.sent === "string" && ef.sent !== e.effort;
  if ((!sameFamily || effortOnlyRewrite) && !res?.usage && res?.stopReason == null) {
    const key = `${S.provider}:${model}`;
    const tEnd = await now2($);
    if (effortOnlyRewrite) {
      S.failures = [...S.failures, { key, model, at: tEnd, turnId: e.turnId, cls: "pending", effortOnly: true }].slice(-10);
      S.lastNoResponse = null;
      S.records.push({ v: 1, kind: "provider-failure", at: tEnd, sessionId: S.sessionId, turnId: e.turnId, model, family: r.family, provider: S.provider, class: "no-response", breaker: "not-counted", rewrote: "effort" });
      try {
        await reconcileErrors($, tEnd);
      } catch {
      }
      pushRequest(e, { model, effort: ef.sent }, r.owner, ef.applied, ef.why, res, tEnd, application);
      return res;
    }
    const b2 = { ...S.breakers[key] ?? { failures: 0, openUntil: 0 } };
    if (b2.lastAt !== void 0 && tEnd - b2.lastAt > 3 * (b2.cooldownMs ?? BREAKER_COOLDOWN_MS)) b2.failures = 0;
    const threshold = b2.threshold ?? BREAKER_FAILURES;
    if (b2.failures >= threshold && b2.openUntil <= tEnd) b2.failures = threshold - 1;
    b2.lastAt = tEnd;
    b2.failures += 1;
    b2.turnId = e.turnId;
    if (b2.failures >= threshold) b2.openUntil = tEnd + (b2.cooldownMs ?? BREAKER_COOLDOWN_MS);
    S.breakers = { ...S.breakers, [key]: b2 };
    S.lastNoResponse = { key, turnId: e.turnId, at: tEnd };
    S.failures = [...S.failures, { key, model, at: tEnd, turnId: e.turnId, cls: "pending" }].slice(-10);
    S.records.push({ v: 1, kind: "provider-failure", at: tEnd, sessionId: S.sessionId, turnId: e.turnId, model, family: r.family, provider: S.provider, class: "no-response", consecutive: b2.failures, breaker: b2.openUntil > tEnd ? "open" : "counting" });
    try {
      await reconcileErrors($, tEnd);
    } catch {
    }
    const open = S.breakers[key];
    if (open.openUntil > tEnd && !S.toldBreaker) {
      S.toldBreaker = true;
      $.ui.toast(`AutoMode: ${model} did not answer ${open.failures} request${open.failures === 1 ? "" : "s"} in a row (${open.class ?? "unclassified"}). Routing without it for ${Math.round((open.cooldownMs ?? BREAKER_COOLDOWN_MS) / 6e4)} minutes.`);
    }
    const back = familyOf2(e.model) ?? "sonnet";
    S.pending = { ...routeFor2(back === "haiku" ? "T0" : back === "opus" ? "T3" : "T1"), model: e.model, owner: "fallback", reason: `${r.family} did not answer`, floor: { tier: "T0", because: [] }, overridden: [] };
    pushRequest(e, { model, effort: ef.sent }, r.owner, ef.applied, ef.why, res, tEnd, application);
    return res;
  }
  if (res?.usage) S.lastNoResponse = null;
  if (res?.usage && S.breakers[`${S.provider}:${model}`]) {
    S.breakers = { ...S.breakers, [`${S.provider}:${model}`]: { failures: 0, openUntil: 0 } };
    S.toldBreaker = false;
    S.failures = S.failures.filter((f) => f.key !== `${S.provider}:${model}`);
  }
  const sentEffort = typeof ef.sent === "string" ? ef.sent : null;
  const prevModel = S.current?.model;
  const effortOff = S.effortUnsupported || S.thinkingRisk;
  S.current = { tier: r.tier, family: r.family, model: r.model, effort: sentEffort ?? (effortOff ? S.current?.effort ?? "medium" : r.effort) };
  if (prevModel && prevModel !== r.model) {
    S.requestsSinceSwitch = 0;
    S.verifiedSinceSwitch = false;
    if (r.owner !== "quality-escalation" && r.owner !== "user-override") S.switchesThisTask += 1;
  } else S.requestsSinceSwitch += 1;
  let shrank = false;
  let compactedHere = false;
  if (res?.usage) {
    const u = res.usage;
    const prefix = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    shrank = !!S.cache && S.cache.prefixTokens > 2e4 && prefix < S.cache.prefixTokens / 2;
    compactedHere = !!S.cache && !!S.compactedAt && S.compactedAt >= (S.cache.lastRequestAt ?? 0);
    if (S.compactedAt && !S.basePrefixMeasured) {
      S.basePrefix = u.cache_read_input_tokens ?? S.basePrefix;
      S.basePrefixMeasured = true;
    } else if (!S.basePrefix) S.basePrefix = Math.round(prefix * 0.75);
    noteSwitch(r.family, u.model ?? model, prefix, shrank, t);
    S.rent = accrueRent(S.rent, r.family, r.check?.rent, usdOf(u.model ?? model, usageOf(u)).value, prices().rates);
    if (!S.cache && !S.firstPrefixSaved) {
      S.firstPrefixSaved = true;
      await saveFirstPrefix($, prefix);
    }
    S.cache = { model: u.model ?? model, effort: sentEffort, prefixTokens: prefix, lastRequestAt: t, ttlMs: S.ttl, effortSharesCache: S.effortShared, outputTokens: u.output_tokens ?? 0 };
  }
  markWarm(r.family, sentEffort, res, t);
  pushRequest(e, { model, effort: ef.sent }, r.owner, ef.applied, ef.why, res, t, application);
  if (res?.stopReason && res.stopReason !== "tool_use") await flush($);
  const ctx = trigger(trigState(), { kind: "context", prefixTokens: S.cache?.prefixTokens ?? 0, family: r.family });
  if (ctx.action === "reoptimize") reoptimize(ctx, "context-growth", t, e.turnId);
  else if (shrank) reoptimize(trigger(trigState(), { kind: "compacted" }), "compacted", t, e.turnId, compactedHere);
  if (res?.answer) S.lastReply = res.answer;
  await publish($);
  return res;
}
function noteSwitch(family, model, prefix, shrank, t) {
  const was = S.cache;
  const moved = !!was?.model && familyOf2(was.model) !== familyOf2(model);
  const known = moved && !shrank && !(S.compactedAt && S.compactedAt >= (was.lastRequestAt ?? 0));
  const drop = known ? observedDrop(was.prefixTokens, was.outputTokens ?? 0, prefix) : 0;
  S.dropped = noteDrop(S.dropped, family, drop);
  if (moved) S.records.push({ v: 1, kind: "model-switch", at: t, sessionId: S.sessionId, taskId: S.envelope?.taskId ?? "none", from: was.model, to: model, continuity: continuity2(was.model, model, S.provider), prefixBefore: was.prefixTokens, prefixAfter: prefix, droppedTokens: known ? drop : null });
}
function markWarm(fam, effort, res, t) {
  if (!fam || !res?.usage) return;
  const u = res.usage;
  S.warm = { ...S.warm, [fam]: { effort, until: t + S.ttl, prefixTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) } };
}
async function v4TurnComplete($, e, next) {
  const out = await next(e);
  if (e.agentId !== void 0) {
    const ua = U.agents.get(e.agentId);
    if (ua) {
      U.agents.set(e.agentId, { ...ua, status: e.isAborted || e.reason === "aborted" ? "failed" : "done" });
      await publish($);
    }
    const w = S.workers.get(e.agentId);
    if (w?.type === "automode:reviewer" && !w.workflow && S.mode === "auto" && S.envelope && reviewerBlocked(String(e.answer ?? ""))) {
      const l = S.envelope.ladder ?? EMPTY_LADDER;
      S.envelope = { ...S.envelope, ladder: { ...l, reviewerBlockers: l.reviewerBlockers + 1 } };
      await runLadder($, await now2($));
    } else if (w?.type === "automode:reviewer" && !w.workflow && S.envelope?.ladder?.episodes && !e.isAborted) {
      S.envelope = { ...S.envelope, ladder: { ...S.envelope.ladder, episodes: closeEpisodes(S.envelope.ladder.episodes, (x) => x.base === "reviewer", await now2($)).episodes } };
    }
    if (w?.type === "automode:reviewer" && !w.workflow && S.envelope && !e.isAborted && !reviewerBlocked(String(e.answer ?? ""))) {
      S.consultLog = S.consultLog.map((c) => !c.outcome && c.episode.startsWith("reviewer") ? { ...c, checkPassed: true } : c);
      if (settleConsults(await now2($), { verified: true })) await flush($);
    }
    if (w?.type === "automode:architect" && !w.workflow) await noteConsultRun($, e, w);
    if (S.forkRuns.has(e.agentId)) await noteForkRun($, e);
    const kind = w && w.validate !== false ? WORKERS[w.type] : void 0;
    if (S.cfg.debugLog) {
      S.records.push({ v: 1, kind: "debug-sub-complete", agentId: e.agentId, known: !!w, type: w?.type, answerLen: String(e.answer ?? "").length, mode: S.mode, env: !!S.envelope });
      await flush($);
    }
    if (!kind || S.mode !== "auto" || !S.envelope) return out;
    const v = validateReport(String(e.answer ?? ""), kind);
    const at3 = await now2($);
    const vr = U.agents.get(e.agentId);
    if (vr) U.agents.set(e.agentId, { ...vr, result: v.status === "ok" ? "ok" : v.report ? "partial" : "failed" });
    if (kind === "discovery" && v.report) {
      const files = Array.isArray(v.report.relevant_files) ? v.report.relevant_files.map(String) : [];
      S.envelope = { ...S.envelope, discovery: [...S.envelope.discovery, { scope: w.type, paths: files, complete: v.status === "ok", omitted: v.omitted, head: null, hashes: await hashFiles($, files), at: at3, agentId: e.agentId }].slice(-10) };
    }
    S.records.push({ v: 1, kind: "worker", at: at3, sessionId: S.sessionId, taskId: S.envelope.taskId, agent: w.type, agentId: e.agentId, status: v.status, omitted: v.omitted.length, tokens: w.tokens, stopped: w.stop });
    return out;
  }
  if (S.mode === "off" || !await activeV4($)) {
    await publish($);
    return out;
  }
  const at2 = await now2($);
  const requests = S.turnRequests.get(e.turnId) ?? 0;
  S.turnRequests.delete(e.turnId);
  if (S.workflowPending) {
    S.records.push({ v: 1, kind: "workflow-entry", at: at2, sessionId: S.sessionId, turnId: e.turnId, ...S.workflowPending });
    S.workflowPending = null;
  }
  if ((e.isAborted || e.reason === "aborted") && S.lastNoResponse && S.lastNoResponse.turnId === e.turnId) {
    const k = S.lastNoResponse.key;
    undoFailure(k, "cancel");
    S.failures = S.failures.map((f) => f.key === k && f.cls === "pending" && f.turnId === e.turnId ? { ...f, cls: "cancel" } : f);
    S.records.push({ v: 1, kind: "interrupt", at: at2, sessionId: S.sessionId, turnId: e.turnId, model: k.slice(k.indexOf(":") + 1), undone: true });
    S.lastNoResponse = null;
  }
  S.turnOverride = null;
  if (S.heldRoute) {
    S.pending = S.heldRoute;
    S.heldRoute = null;
  }
  if (S.mode === "shadow") {
    const p = S.turnPrompt.get("next");
    S.turnPrompt.delete("next");
    if (e.usage) S.cache = { model: e.usage.model, effort: null, prefixTokens: (e.usage.input_tokens ?? 0) + (e.usage.cache_read_input_tokens ?? 0) + (e.usage.cache_creation_input_tokens ?? 0), lastRequestAt: at2, ttlMs: S.ttl, effortSharesCache: S.effortShared };
    if (p) {
      const d = await decide($, p.text, false, 0, p.at).catch(() => null);
      S.resetPending = false;
      if (d) {
        S.current = routeFor2(d.route.tier, DEFAULT_LADDER2, d.route.effort);
        pushDecision("prompt", d, false, at2, e.turnId, e.usage ? { model: e.usage.model } : void 0);
      }
    }
  } else if (e.usage) {
    const u = e.usage;
    const tokens = usageOf(u);
    S.records.push(outcomeRecord({
      at: at2,
      sessionId: S.sessionId,
      turnId: e.turnId,
      taskId: S.envelope?.taskId ?? "none",
      reason: e.isAborted || e.reason === "aborted" ? "aborted" : "answer",
      requests,
      ...typeof e.durationMs === "number" ? { durationMs: e.durationMs } : {},
      usage: { [u.model ?? "unknown"]: tokens },
      usd: usdOf(u.model ?? "unknown", tokens),
      checks: { pass: S.lastCheck?.passed ? 1 : 0, fail: S.lastCheck && !S.lastCheck.passed ? 1 : 0 },
      ...S.current ? { route: `${S.current.family}/${runningEffort()}` } : {},
      ...S.lastAuto?.hm ? { tier: S.lastAuto.hm.tier } : {}
    }));
    S.lastOutcome = { turnId: e.turnId, taskId: S.envelope?.taskId ?? "none" };
    await noteLearned($, false);
  }
  await flush($);
  await persist2($);
  await publish($);
  return out;
}
async function v4AgentSpawn($, e, next) {
  if (e.workflow && String(e.subagentType).startsWith(`${S.cfg.workflowName.split(":")[0]}:`)) noteWorkflowCall();
  if (S.mode === "off") return next(e);
  if (!await activeV4($)) return S.cfg.subagentsEverySession && S.mode === "auto" ? spawnOutsideAutoMode($, e, next) : next(e);
  if (S.mode === "shadow") {
    const res2 = await next(e);
    if (res2?.agentId) S.agents.set(res2.agentId, { type: e.subagentType, routed: false });
    noteAgent(res2, e, e.model, false);
    return res2;
  }
  if (S.cfg.redirectExplore && e.subagentType === "Explore" && !e.model) {
    const hp2 = S.policy === "auto" ? await helperPick($, e, "claude-haiku-5-5") : null;
    const res2 = await next({ ...e, subagentType: "automode:explorer", model: "haiku" });
    if (res2 && "agentId" in res2 && res2.agentId) {
      S.workers.set(res2.agentId, { type: "automode:explorer", tokens: 0, stop: false, validate: false });
      S.agents.set(res2.agentId, { type: "automode:explorer", effort: hp2?.effort ?? "medium", routed: true, judged: !!hp2 });
      noteAgent(res2, { ...e, subagentType: "automode:explorer" }, "haiku", true, hp2?.effort ?? "medium");
      if (hp2) S.records.push({ v: 1, kind: "spawn", at: await now2($), sessionId: S.sessionId, taskId: S.envelope?.taskId ?? "none", type: "automode:explorer", to: "haiku", effort: hp2.effort, why: hp2.why, agentId: res2.agentId });
    }
    return res2;
  }
  const sr = subagentRoute({ type: e.subagentType, explicitModel: e.model, parentFamily: familyOf2(e.parentModel ?? S.current?.model ?? ""), demand: S.lastDemand, risk: S.envelope?.risk.effective, prompt: String(e.prompt ?? "") });
  if (sr && !WORKERS[e.subagentType]) {
    const hp2 = S.policy === "auto" ? await helperPick($, e, sr.model === "haiku" ? "claude-haiku-5-5" : "claude-sonnet-5-5") : null;
    const effort = subagentEffort(sr.effort, hp2?.effort);
    const res2 = await next({ ...e, model: sr.model });
    if (res2?.agentId) S.agents.set(res2.agentId, { type: e.subagentType, effort, routed: true, judged: !!hp2 });
    noteAgent(res2, e, sr.model, true, effort);
    S.records.push({ v: 1, kind: "spawn", at: await now2($), sessionId: S.sessionId, taskId: S.envelope?.taskId ?? "none", type: e.subagentType, from: e.parentModel ?? null, to: sr.model, effort, why: effort === sr.effort ? sr.why : hp2?.why ?? sr.why, agentId: res2?.agentId });
    return res2;
  }
  const sonnetReview = e.subagentType === "automode:reviewer" && !e.model && !e.workflow && S.envelope?.reviewRequired.value && reviewerFamily(S.envelope.reviewRequired.because) === "sonnet";
  const model = sr?.model ?? (sonnetReview ? "sonnet" : e.model);
  const hp = S.policy === "auto" ? await helperPick($, e, model) : null;
  const res = await next(sr || sonnetReview ? { ...e, model } : e);
  if (res?.agentId) S.agents.set(res.agentId, { type: e.subagentType, routed: !!sr, ...hp ? { effort: hp.effort, judged: true } : {} });
  noteAgent(res, e, model, !!sr, hp?.effort);
  if (hp && res?.agentId) S.records.push({ v: 1, kind: "spawn", at: await now2($), sessionId: S.sessionId, taskId: S.envelope?.taskId ?? "none", type: e.subagentType, to: model ?? null, effort: hp.effort, why: hp.why, agentId: res.agentId });
  if (res?.agentId) S.records.push({ v: 1, kind: "agent", at: await now2($), sessionId: S.sessionId, taskId: S.envelope?.taskId ?? "none", type: e.subagentType, agentId: res.agentId });
  const forkAsk = e.subagentType === "fork" && res?.agentId ? [...S.consultLog].reverse().find((c) => c.via === "fork" && !c.agentId && !c.outcome) : void 0;
  if (forkAsk) {
    S.forkRuns.set(res.agentId, { at: await now2($), episode: forkAsk.episode });
    S.consultLog = S.consultLog.map((c) => c === forkAsk ? { ...c, agentId: res.agentId } : c);
  }
  if (S.cfg.debugLog) S.records.push({ v: 1, kind: "debug-spawn", type: e.subagentType, model: e.model, resKeys: res ? Object.keys(res) : null, agentId: res?.agentId });
  if (res && "agentId" in res && res.agentId && READ_ONLY_AGENTS.includes(e.subagentType)) {
    const mainWorker = S.expectWorker > 0 && e.agentId === void 0;
    if (mainWorker) S.expectWorker -= 1;
    S.workers.set(res.agentId, { type: e.subagentType, tokens: 0, stop: false, validate: mainWorker, workflow: !!e.workflow, at: await now2($) });
  }
  return res;
}
async function v4ToolCall($, e, next) {
  const out = await guarded($, e, next);
  if (S.mode !== "auto") return out;
  await noteToolResult($, e, out);
  if (e.agentId !== void 0 || !S.ladderNote || out?.deny) return out;
  const note = S.ladderNote;
  S.ladderNote = null;
  S.newInput = true;
  return { ...out, context: [...out.context ?? [], note] };
}
async function noteToolResult($, e, out) {
  if (!S.envelope || !out || out.deny || e.tool === "Agent" || e.tool === "Bash" && isCheck(String(e.command ?? ""))) return;
  const l = S.envelope.ladder ?? EMPTY_LADDER;
  const toolErrors = out.isError === true ? l.toolErrors + 1 : 0;
  if (toolErrors === l.toolErrors) return;
  S.envelope = { ...S.envelope, ladder: { ...l, toolErrors } };
  if (toolErrors < 3) return;
  await runLadder($, await now2($));
  S.envelope = { ...S.envelope, ladder: { ...S.envelope.ladder ?? EMPTY_LADDER, toolErrors: 0 } };
}
function settleConsults(at2, ev) {
  let changed = false;
  S.consultLog = S.consultLog.map((c) => {
    if (c.outcome || ev.episode !== void 0 && c.episode !== ev.episode) return c;
    const outcome = consultOutcome({ switched: !!ev.switched, recurred: !!ev.recurred, checkPassed: !!c.checkPassed, independentlyVerified: !!ev.verified, taskEnded: !!ev.taskEnded });
    if (!outcome) return c;
    changed = true;
    const edits = S.editLog.slice(c.edits).map((x) => x.path);
    S.records.push({ v: 1, kind: "consult-outcome", at: at2, sessionId: S.sessionId, taskId: S.envelope?.taskId ?? "none", episode: c.episode, via: c.via ?? "architect", agentId: c.agentId ?? null, consultAt: c.at, outcome, influence: c.agentId ? influence(c.plan ?? [], edits) : "unknown", editsAfter: edits.length });
    return { ...c, outcome };
  });
  return changed;
}
async function consultPacket($, env, because, openedAt, episode, cache, advisorUsd) {
  const paths = [...new Set(env.editedPaths)].slice(0, 8);
  const diffStat = paths.length ? await git2($, ["git", "diff", "--stat", "--", ...paths]) : "";
  const diffHunks = diffStat ? await git2($, ["git", "diff", "-U2", "--", ...paths]) : "";
  let h2 = buildHandoff({ spec: env.spec.text, prompts: S.taskPrompts, acceptance: env.acceptance, failures: env.failures, edited: env.editedPaths, editsSinceOpen: S.editLog.filter((x) => x.at >= openedAt).map((x) => x.path), diffStat, diffHunks, because });
  const gaps = completeness(h2, env.editedPaths);
  let source = "rich";
  let forked = null;
  if (S.cfg.packet === "fork-gated" && S.current) {
    const advisor = advisorUsd ?? priceConsult({ cache, remainingRequests: 0, outPerRequest: 0, packetTokens: 2e3, planTokens: 2e3, main: S.current.family, prices: prices(), durations: durationsFrom(S.consultMs), pRecur: RECUR_PRIOR }).parts.advisor;
    const worth = forkWorth({ conversational: gaps.conversational.length, prefixTokens: cache.prefixTokens, warm: cache.warm, main: S.current.family, prices: prices(), ttlMs: S.ttl, advisorUsd: advisor });
    forked = { estimateUsd: worth.forkUsd, why: worth.why, ran: worth.run };
    if (worth.run) {
      const r = await fork($, { prompt: FORK_PROMPT }).catch(() => null);
      const facts2 = r?.isAnswered ? parseForkFacts(String(r.text)) : null;
      forked = { ...forked, ok: !!facts2, reason: r?.isAnswered ? facts2 ? "answered" : "unparsed" : r?.reason ?? "error", ...r?.usage ? { usage: usageOf(r.usage) } : {} };
      if (facts2) {
        h2 = withFork(h2, facts2);
        source = "fork";
      }
    }
  }
  const text = renderHandoff(h2, source === "fork" ? gaps.gaps.filter((g) => !gaps.conversational.includes(g)) : gaps.gaps);
  S.records.push({ v: 1, kind: "handoff", at: await now2($), sessionId: S.sessionId, taskId: env.taskId, episode, source, tokens: Math.ceil(text.length / 3.5), gaps: gaps.gaps.length, conversational: gaps.conversational.length, diff: !!diffStat, fork: forked });
  await flush($);
  return text;
}
async function git2($, argv) {
  try {
    const r = await $.process.run(argv, { timeoutMs: 5e3 });
    return r.exitCode === 0 ? String(r.stdout ?? "") : "";
  } catch {
    return "";
  }
}
var MAX_LADDER_STOPS = 4;
var rescueReview = () => S.cfg.strongStep === "effort-first" || S.cfg.consult === "priced";
async function noteConsultRun($, e, w) {
  const at2 = await now2($);
  const durationMs = w.at !== void 0 ? Math.max(0, at2 - w.at) : null;
  if (durationMs !== null) S.consultMs = [...S.consultMs, durationMs].slice(-50);
  const plan = planFiles(String(e.answer ?? ""));
  const open = [...S.consultLog].reverse().find((c) => !c.agentId && !c.outcome && c.via !== "fork");
  if (open) S.consultLog = S.consultLog.map((c) => c === open ? { ...c, agentId: e.agentId, plan } : c);
  S.records.push({ v: 1, kind: "consult-run", at: at2, sessionId: S.sessionId, taskId: S.envelope?.taskId ?? "none", agentId: e.agentId, episode: open?.episode ?? null, durationMs, usd: U.agents.get(e.agentId)?.usd ?? null, answerChars: String(e.answer ?? "").length, planFiles: plan.length, aborted: !!(e.isAborted || e.reason === "aborted") });
  await flush($);
}
async function noteForkRun($, e) {
  const f = S.forkRuns.get(e.agentId);
  const at2 = await now2($);
  const plan = planFiles(String(e.answer ?? ""));
  S.consultLog = S.consultLog.map((c) => c.agentId === e.agentId ? { ...c, plan } : c);
  S.records.push({ v: 1, kind: "fork-run", at: at2, sessionId: S.sessionId, taskId: S.envelope?.taskId ?? "none", agentId: e.agentId, episode: f.episode, durationMs: Math.max(0, at2 - f.at), usd: U.agents.get(e.agentId)?.usd ?? null, firstCacheRead: f.first?.cacheRead ?? null, firstPrompt: f.first?.prompt ?? null, planFiles: plan.length, aborted: !!(e.isAborted || e.reason === "aborted") });
  S.forkRuns.delete(e.agentId);
  await flush($);
}
async function runLadder($, at2) {
  const env = S.envelope;
  if (!env || !S.current || S.policy !== "auto") return;
  const l = env.ladder ?? EMPTY_LADDER;
  const running = { family: S.current.family, effort: runningEffort() };
  const editedSincePass = (since) => [...new Set(S.editLog.filter((x) => x.at > since).map((x) => x.path))];
  const esc = escalation(env.failures, { ...l, editedSincePass, effortCapped: !nextEffort(running.family, running.effort) });
  if (esc.level === "none") return;
  const count = esc.count ?? (esc.fingerprint ? env.failures.filter((f) => f.fingerprint === esc.fingerprint).length : 0);
  const lastFail = env.failures[env.failures.length - 1];
  const joined = esc.cause === "stop" && lastFail ? Object.values(l.episodes ?? {}).find((x) => x.closedAt === void 0 && (x.base === `check:${lastFail.fingerprint}` || x.base === `check:cmd:${fnv1a2(lastFail.command)}`))?.base : void 0;
  const opened = openEpisode(l.episodes ?? {}, joined ?? episodeBase(esc, l), at2);
  const episode = opened.id;
  const ep = opened.episodes[episode];
  const allowed = allowedFamilies(at2);
  const up = ladderStep(running, esc.level, allowed);
  const first = effortFirst({ enabled: S.cfg.strongStep === "effort-first", level: esc.level, episode: ep, critical: env.risk.effective === "critical", floorBand: l.floor?.band, modelBand: up?.kind === "model" ? up.band : void 0 });
  const step = first.use ? ladderStep(running, "strong", allowed, { effortFirst: true }) : up;
  const strongRaise = first.use && step?.kind === "effort";
  const episodes = strongRaise ? patchEpisode(opened.episodes, episode, { raised: ep.raised + 1 }) : opened.episodes;
  const spent = { ...l, fired: [...l.fired, esc.key], raised: esc.fingerprint ? { ...l.raised, [esc.fingerprint]: count } : l.raised, episodes };
  const cache = cacheNote(cacheState(), at2);
  const why = first.why ? { effortFirst: first.why } : {};
  if (!step) {
    S.envelope = { ...env, ladder: spent };
    if (ep.consulted || ep.forked) settleConsults(at2, { episode, recurred: true });
    S.records.push({ v: 1, kind: "escalation", at: at2, sessionId: S.sessionId, taskId: env.taskId, level: esc.level, floor: null, action: "none", via: "none", because: esc.because, cache, episode, ...why });
    return;
  }
  const packet = () => evidencePacket(env.spec.text.slice(0, 1500), env.acceptance.map((a) => a.text), env.failures, env.editedPaths, esc.because);
  const consultedBefore = S.cfg.strongStep === "effort-first" ? ep.consulted : S.consulted.includes(esc.cause);
  const toOpus = step.kind === "model" && step.family === "opus" && !consultedBefore;
  if (toOpus && S.cfg.forkRung === "on" && !ep.forked) {
    S.consultLog = [...S.consultLog, { episode, via: "fork", ...esc.fingerprint ? { fingerprint: esc.fingerprint } : {}, at: at2, edits: S.editLog.length }];
    S.envelope = { ...env, ladder: { ...spent, episodes: patchEpisode(episodes, episode, { forked: true }) }, escalations: env.escalations + 1 };
    S.records.push({ v: 1, kind: "escalation", at: at2, sessionId: S.sessionId, taskId: env.taskId, level: esc.level, floor: null, action: "fork-diagnose", via: "fork", because: esc.because, cache, episode, ...why });
    await flush($);
    $.ui.toast(`AutoMode: ${esc.because}. A fork of this session diagnoses it before an Opus consult.`);
    S.ladderNote = `[AutoMode: ${esc.because}. Before changing more code, call the Agent tool with subagent_type "fork" and wait for it. Its job: find the root cause of this failure and return the cause, the fix plan and the files to change. It must not edit files. It shares this conversation and its warm cache, so it costs little. Apply its plan, then run the check again. If the failure comes back, an Opus consult follows.]`;
    return;
  }
  const price = toOpus && S.cfg.consult === "priced" ? priceConsult({ cache, remainingRequests: S.priors.remainingRequests, outPerRequest: S.priors.outputPerStep.opus, packetTokens: Math.ceil(packet().length / 3.5), planTokens: 2e3, main: S.current.family, prices: prices(), durations: durationsFrom(S.consultMs) }, { recurredBefore: ep.consulted, floorRequiresSwitch: (l.floor?.band ?? -1) >= step.band }) : null;
  const estimate = price ? { estimate: { consultUsd: price.consultUsd, switchUsd: price.switchUsd, parts: price.parts, pExpire: price.pExpire, pRecur: price.pRecur, basis: { ...price.basis, priors: S.priors.basis }, why: price.why } } : {};
  if (toOpus && ep.forked) settleConsults(at2, { episode, recurred: true });
  if (toOpus && (!price || price.choice === "consult")) {
    S.consulted = [...S.consulted, esc.cause].slice(-20);
    S.consultLog = [...S.consultLog, { episode, ...esc.fingerprint ? { fingerprint: esc.fingerprint } : {}, at: at2, edits: S.editLog.length }];
    const consultEnv = { ...env, ladder: { ...spent, episodes: patchEpisode(episodes, episode, { consulted: true, consultAt: at2 }) }, escalations: env.escalations + 1 };
    S.envelope = rescueReview() ? requireReview(consultEnv, "an Opus consult ran on a failure") : consultEnv;
    S.records.push({ v: 1, kind: "escalation", at: at2, sessionId: S.sessionId, taskId: env.taskId, level: esc.level, floor: null, action: "consult-opus", via: "architect", because: esc.because, cache, episode, ...why, ...estimate });
    await flush($);
    $.ui.toast(`AutoMode: ${esc.because}. Asking an Opus architect before moving the session.`);
    const evidence = S.cfg.packet === "basic" ? packet() : await consultPacket($, env, esc.because, ep.openedAt, episode, cache, price?.parts.advisor);
    const missing = S.cfg.packet === "basic" ? "" : " If its answer lists missing evidence, find it, give it to the same architect, and ask once more.";
    S.ladderNote = `[AutoMode: ${esc.because}. Before changing more code, call the Agent tool with subagent_type "automode:architect" (Opus, read-only) and wait for it, with this evidence:
${evidence}
Ask it for the cause and a fix plan. Apply its plan, then run the check again.${missing}]`;
    return;
  }
  const tier = tierOf2(step.family, step.effort);
  const floor = { tier, band: step.band, effort: step.effort, because: [esc.because] };
  const target = { ...routeFor2(tier, DEFAULT_LADDER2, step.effort), owner: "quality-escalation", reason: strongRaise ? `${esc.because}; effort first` : esc.because, floor, overridden: [] };
  const applied = pinned(target, S.appModel ?? target.model);
  const moved = applied.family !== running.family || applied.effort !== running.effort;
  S.pending = applied;
  const moving = moved && step.kind === "model";
  const raised = { ...env, escalations: env.escalations + 1, ladder: { ...spent, ...moving ? { episodes: patchEpisode(episodes, episode, { switched: true }) } : {}, floor: { family: step.family, effort: step.effort, band: step.band, because: esc.because, ...esc.fingerprint ? { command: env.failures[env.failures.length - 1].command } : {} } } };
  const reviewed = esc.check ? withReview(raised, "fail", false) : raised;
  S.envelope = strongRaise && rescueReview() ? requireReview(reviewed, "effort rose on strong evidence") : reviewed;
  if (ep.consulted || ep.forked) settleConsults(at2, { episode, ...moving ? { switched: true } : { recurred: true } });
  S.records.push({ v: 1, kind: "escalation", at: at2, sessionId: S.sessionId, taskId: env.taskId, level: esc.level, floor: tier, band: step.band, route: `${step.family}/${step.effort}`, applied: `${applied.family}/${applied.effort}`, action: moved ? step.kind === "model" ? "switch" : "raise" : "held-by-pin", via: "switch", because: esc.because, cache, episode, ...why, ...estimate });
  await flush($);
  if (!moved) {
    $.ui.toast(`AutoMode: ${esc.because}. Your choice keeps ${applied.family} ${applied.effort}.`);
    S.ladderNote = `[AutoMode: ${esc.because}. The person chose ${applied.family} ${applied.effort}, so the route stays. Say so if the task needs more.]`;
    return;
  }
  const moveTo = `${applied.tier} (${applied.family} ${applied.effort})`;
  $.ui.toast(`AutoMode: ${esc.because}. Moving to ${moveTo}.`);
  const priced = price ? ` A consult would not pay here: ${price.why}.` : "";
  const consulted = consultedBefore ? " An Opus consult on this already ran; the session itself now moves to the stronger model." : "";
  const effortNote = strongRaise ? " Effort rises first on the same model, so its cache stays warm. If this failure comes back, an Opus consult and then the stronger model follow." : "";
  const review = esc.check ? " When the check passes, the independent review (automode:reviewer) is required before you call it done." : "";
  S.ladderNote = `[AutoMode: escalated to ${moveTo} after ${esc.because}.${effortNote}${priced}${consulted}${review}]${step.kind === "model" ? `

Evidence for the next step:
${packet()}` : ""}`;
}
async function guarded($, e, next) {
  if (S.mode !== "auto" || !await activeV4($)) return next(e);
  const input = e;
  if (e.agentId !== void 0) {
    if (S.cfg.blockGitWritesWhenActive && e.tool === "Bash" && subagentBlocked(String(input.command ?? ""))) {
      return { deny: `AutoMode agents do not run git writes or destructive commands. Leave the changes in the working tree for the user to review.` };
    }
    let w = S.workers.get(e.agentId);
    if (!w) {
      const info = (await $.agent.list().catch(() => [])).find((a) => a.id === e.agentId);
      if (info && READ_ONLY_AGENTS.includes(info.type)) {
        w = { type: info.type, tokens: 0, stop: false };
        S.workers.set(e.agentId, w);
      }
    }
    if (!w) return trackTool($, e, input, next);
    const g = guardTool(e.tool, input);
    if (!g.allow) return { deny: `AutoMode ${w.type} is read-only: ${g.why}.` };
    if (w.stop && ["Read", "Grep", "Glob"].includes(e.tool)) return { deny: BUDGET_STOP };
    if (w.type === "automode:explorer" || w.type === "automode:diagnoser") {
      if (e.tool === "Read") {
        const c = clampRead(input, HAIKU_BUDGET);
        if (c) return next({ ...e, ...c });
      }
      if (e.tool === "Grep") {
        const c = clampGrep(input, HAIKU_BUDGET);
        if (c) return next({ ...e, ...c });
      }
    }
    return trackTool($, e, input, next);
  }
  if (e.tool === "Workflow" && input.name === S.cfg.workflowName) noteWorkflowCall();
  const exploring = e.tool === "Agent" && (input.subagent_type === "Explore" || input.subagent_type === "automode:explorer") && S.envelope;
  const covered = exploring ? [...new Set(S.envelope.discovery.filter((d) => d.complete).flatMap((d) => d.paths))] : [];
  const reuse = exploring ? priorCoverage(S.envelope.discovery, S.editLog, await hashFiles($, covered)) : { paths: [], note: null };
  if (reuse.note) S.records.push({ v: 1, kind: "reuse", at: await now2($), sessionId: S.sessionId, taskId: S.envelope.taskId, paths: reuse.paths.length });
  const withReuse = reuse.note ? { prompt: `${String(input.prompt ?? "")}

${reuse.note}` } : {};
  if (e.tool === "Agent" && WORKERS[String(input.subagent_type)] && S.envelope) {
    const kind = WORKERS[String(input.subagent_type)];
    const taskId = S.envelope.taskId;
    S.expectWorker += 1;
    const workerModel = subagentRoute({ type: String(input.subagent_type), parentFamily: null, demand: null, risk: S.envelope.risk.effective })?.model ?? "haiku";
    const out = await next({ ...e, ...withReuse, model: workerModel, run_in_background: false });
    if (S.cfg.debugLog) S.records.push({ v: 1, kind: "debug-agent", keys: Object.keys(out), resultType: typeof out.result, sample: JSON.stringify(out.result ?? out.text ?? "").slice(0, 200) });
    if (out.deny) return out;
    const text = resultText(out);
    if (!S.envelope || S.envelope.taskId !== taskId) return { ...out, context: [...out.context ?? [], "[AutoMode: this worker report belongs to an earlier task; do not apply it.]"] };
    const v = validateReport(text, kind);
    const at2 = await now2($);
    if (kind === "discovery" && v.report) {
      const files = Array.isArray(v.report.relevant_files) ? v.report.relevant_files.map(String) : [];
      S.envelope = { ...S.envelope, discovery: [...S.envelope.discovery, { scope: String(input.description ?? "discovery"), paths: files, complete: v.status === "ok", omitted: v.omitted, head: null, hashes: await hashFiles($, files), at: at2 }].slice(-10) };
    }
    const note = v.status === "invalid" ? "[AutoMode: the worker did not return the report format; treat its answer as unverified notes and read what you need yourself.]" : v.status === "partial" ? `[AutoMode: the worker report is partial; these were not covered: ${v.omitted.slice(0, 10).join("; ")}]` : null;
    return note ? { ...out, context: [...out.context ?? [], note] } : out;
  }
  if (reuse.note) return next({ ...e, ...withReuse });
  if (e.tool === "Read") {
    const stop = await readGate($, input);
    if (stop) return stop;
  }
  return trackTool($, e, input, next);
}
async function readGate($, input) {
  const path = String(input.file_path ?? "");
  if (S.cfg.delegation === "off" || !S.envelope || !gateable(path, input)) return null;
  try {
    const chars = (await $.fs.stat(path)).size;
    const key = `${S.envelope.taskId}:${path}`;
    const tried = S.gatedReads.includes(key);
    const v = gateRead({ chars, tried, edited: S.envelope.editedPaths.includes(path), stage: S.stage, risk: S.envelope.risk.effective, gateTokens: S.cfg.delegationGateTokens });
    if (!v.gate && !tried) return null;
    const base = { v: 1, kind: "delegation", at: await now2($), sessionId: S.sessionId, taskId: S.envelope.taskId, mode: S.cfg.delegation, tokens: tokensOf(chars) };
    if (tried) {
      S.records.push({ ...base, action: "read-again" });
      return null;
    }
    S.gatedReads = [...S.gatedReads, key].slice(-200);
    S.records.push({ ...base, action: "gate", why: v.why });
    if (S.cfg.delegation !== "on") return null;
    const outline = chars <= 2e6 ? outlineOf(await fsRead($, path)) : "Too large for an outline.";
    return { deny: gateNote(path, chars, outline, EXTRACT_TOOL) };
  } catch {
    return null;
  }
}
var extractFailed = (why) => ({ result: why, isError: true, text: why });
async function v4Extract($, e) {
  if (S.cfg.delegation !== "on") return extractFailed("extract is off. Use Read.");
  const paths = Array.isArray(e.paths) ? [...new Set(e.paths.map(String))] : [];
  const question = String(e.question ?? "").trim();
  if (!paths.length || !question) return extractFailed("extract needs paths and a question.");
  const files = {};
  for (const path of paths) {
    const check = await $.tool.check({ tool: "Read", input: { file_path: path } }).catch(() => null);
    if (check?.decision !== "allow") return extractFailed(`extract may not read ${path}. Use Read, so the normal permission check runs.`);
    try {
      files[path] = await fsRead($, path);
    } catch {
      return extractFailed(`extract could not read ${path}.`);
    }
  }
  const tokens = tokensOf(Object.values(files).reduce((a, t) => a + t.length, 0));
  if (tokens > EXTRACT_MAX_TOKENS) return extractFailed(`These files are about ${tokens} tokens, over the ${EXTRACT_MAX_TOKENS} limit. Ask about fewer files.`);
  const t0 = await now2($);
  const r = await $.model.complete({ model: S.cfg.compactModel, system: EXTRACT_SYSTEM, prompt: extractPrompt(files, question), maxTokens: EXTRACT_REPLY_TOKENS, effort: "low", timeoutMs: 6e4 });
  const base = { v: 1, kind: "delegation", action: "extract", at: t0, sessionId: S.sessionId, taskId: S.envelope?.taskId ?? "none", mode: S.cfg.delegation, tokens, files: paths.length };
  if (!r?.isAnswered) {
    S.records.push({ ...base, ok: false });
    return extractFailed("extract got no answer. Read the lines you need with offset and limit.");
  }
  const usd = usageUsd(usageOf(r.usage), ANTHROPIC2.rates.haiku);
  noteJudge(usd);
  const evidence = parseEvidence(r.text);
  if (!evidence) {
    S.records.push({ ...base, ok: false, usd });
    return extractFailed("extract got an unreadable answer. Read the lines you need with offset and limit.");
  }
  const { kept, dropped } = verifyEvidence(evidence, files);
  S.records.push({ ...base, ok: true, usd, kept: kept.length, dropped });
  return { result: renderEvidence(kept, dropped, evidence.omitted) };
}
var EVIDENCE_CHARS = 2e4;
var gateOn = () => S.cfg.completionGate === "report" || S.cfg.completionGate === "block";
function syncObligations() {
  const env = S.envelope;
  if (!env || S.obligationsTask === env.taskId) return;
  S.obligationsTask = env.taskId;
  S.obligations = extractObligations(env.spec.text);
  S.obligationEdited = false;
  S.completionBlocks = 0;
  S.completionState = "none";
}
async function v4Stop($, e, next) {
  const out = await next(e);
  if (!gateOn() || S.mode === "off" || !S.envelope || !await activeV4($)) return out;
  syncObligations();
  const state = assessCompletion({ edited: S.envelope.editedPaths.length > 0 || S.bashEdits > 0, editedSinceCheck: S.editedSinceCheck, lastCheckPassed: S.lastCheck ? S.lastCheck.passed : null, obligations: S.obligations });
  S.completionState = state;
  if (state === "verified" && settleConsults(await now2($), { verified: true })) await flush($);
  if (state === "none") return out;
  const gate = S.mode === "auto" && !out?.block ? S.cfg.completionGate : "report";
  const ladderStops = rescueReview() && state === "failed";
  const blocks = ladderStops ? Math.max(0, S.completionBlocks - (MAX_LADDER_STOPS - 1)) : S.completionBlocks;
  let reason = blockReason(state, S.obligations, { gate, stopHookActive: e.stop_hook_active === true && !ladderStops, blocks, backgroundWork: Array.isArray(e.background_tasks) ? e.background_tasks.length : 0 });
  if (reason) S.completionBlocks += 1;
  if (reason && ladderStops && S.policy === "auto") {
    const l = S.envelope.ladder ?? EMPTY_LADDER;
    S.envelope = { ...S.envelope, ladder: { ...l, stops: (l.stops ?? 0) + 1 } };
    await runLadder($, await now2($));
    if (S.ladderNote) {
      reason = `${reason}

${S.ladderNote}`;
      S.ladderNote = null;
      S.newInput = true;
    }
  }
  S.records.push({ v: 1, kind: "completion", at: await now2($), sessionId: S.sessionId, taskId: S.envelope.taskId, state, blocked: !!reason, obligations: publicObligations(S.obligations) });
  await flush($);
  if (S.current) barLine($, S.current);
  return reason ? { ...out, block: reason } : out;
}
async function noteRun($, run, failureKnown) {
  if (!S.envelope || !gateOn()) return;
  syncObligations();
  const before = new Set(S.obligations.filter((o) => o.status === "contradicted").map((o) => o.id));
  S.obligations = observeRun(S.obligations, { ...run, output: run.output.slice(-EVIDENCE_CHARS) });
  if (failureKnown) return;
  const fresh2 = S.obligations.filter((o) => o.status === "contradicted" && !before.has(o.id));
  if (!fresh2.length) return;
  const at2 = await now2($);
  const failures = fresh2.flatMap((o) => {
    const f = failureOf(run.command, run.exit || 1, run.output.slice(-8e3), at2, S.obligationEdited);
    return f ? [{ ...f, fingerprint: o.id, class: "defect" }] : [];
  });
  S.obligationEdited = false;
  S.envelope = { ...S.envelope, failures: [...S.envelope.failures, ...failures].slice(-20), verified: false };
  if (S.policy === "auto") await runLadder($, at2);
}
async function noteCommand($, command) {
  if (!S.envelope) return;
  const op = classifyOperation(command);
  if (op) S.envelope = withReview(observe(S.envelope, { level: "critical", reasons: [`operation: ${op.reason}${op.production ? " in production" : ""}`], source: "diff" }), "none", false);
  if (S.envelope.editedPaths.length && isRevert(command)) {
    const l = S.envelope.ladder ?? EMPTY_LADDER;
    S.envelope = { ...S.envelope, ladder: { ...l, reverts: l.reverts + 1 } };
    await runLadder($, await now2($));
  }
}
async function trackTool($, e, input, next) {
  if ((e.tool === "Edit" || e.tool === "Write" || e.tool === "MultiEdit") && S.envelope) {
    const out = await next(e);
    const p = String(input.file_path ?? "");
    if (p && !out.deny) {
      S.editedSinceCheck = true;
      if (gateOn()) {
        syncObligations();
        S.obligations = reopen(S.obligations);
        S.obligationEdited = true;
      }
      S.editLog = [...S.editLog, { path: p, at: await now2($) }].slice(-200);
      const edited = [.../* @__PURE__ */ new Set([...S.envelope.editedPaths, p])];
      const lines = (S.envelope.changedLines ?? 0) + changedLines(e.tool, input);
      const ifaces = (S.envelope.interfacesChanged ?? 0) + interfacesOf(e.tool, input);
      S.envelope = observe({ ...S.envelope, editedPaths: edited, changedLines: lines, interfacesChanged: ifaces }, observedRisk({ editedPaths: edited, changedFiles: edited.length, changedLines: lines, verification: "none", interfacesChanged: ifaces }));
      S.envelope = withReview(S.envelope, "none", edited.length > 8 || lines > 400);
      const known = new Set(S.envelope.discovery.flatMap((d) => d.paths));
      if (known.size) {
        const tr = trigger(trigState(), { kind: "scope", outsidePaths: edited.filter((x) => !known.has(x)).length });
        if (tr.action === "judge") await rejudge($, tr, await now2($));
      }
      if (S.envelope && !S.envelope.ladder?.scopeGrew && scopeGrew(edited, known, trigState().scopeThreshold, DEFAULT_LARGE.files)) {
        S.envelope = { ...S.envelope, ladder: { ...S.envelope.ladder ?? EMPTY_LADDER, scopeGrew: true } };
        await runLadder($, await now2($));
      }
    }
    return out;
  }
  if (e.tool === "Bash" && S.envelope && isCheck(String(input.command ?? ""))) {
    const pf = withPipefail(String(input.command));
    const out = await next(pf ? { ...e, command: pf } : e);
    if (out.deny) return out;
    const command = pf ?? String(input.command);
    const key = checkKey(command);
    if (writesFiles(String(input.command))) {
      S.editedSinceCheck = true;
      S.bashEdits += 1;
    }
    await noteCommand($, String(input.command));
    if (S.cfg.debugLog) {
      const r = out.result;
      S.records.push({ v: 1, kind: "debug-bash", keys: Object.keys(out), resultType: typeof out.result, resultKeys: r && typeof r === "object" ? Object.keys(r) : null, isError: out.isError, sample: JSON.stringify(out.result ?? out.text ?? "").slice(0, 300) });
    }
    const text = resultText(out);
    const exit = text.match(/Exit code (\d+)/);
    const exitCode = exit ? Number(exit[1]) : out.isError === true ? 1 : 0;
    const passed = checkPassed(command, exitCode, out.isError === true, text);
    const at2 = await now2($);
    S.lastCheck = { command, passed };
    if (passed) {
      S.envelope = { ...S.envelope, failures: markFlaky(S.envelope.failures, key, true, S.editedSinceCheck), verified: true };
      const ladder = S.envelope.ladder ?? EMPTY_LADDER;
      const ended = ladder.floor && (!ladder.floor.command || ladder.floor.command === key);
      const bases = /* @__PURE__ */ new Set([...S.envelope.failures.filter((f) => f.command === key).map((f) => `check:${f.fingerprint}`), `check:cmd:${fnv1a2(key)}`]);
      const episodes = ladder.episodes ? closeEpisodes(ladder.episodes, (x) => bases.has(x.base), at2).episodes : void 0;
      S.consultLog = S.consultLog.map((c) => !c.outcome && c.fingerprint && bases.has(`check:${c.fingerprint}`) ? { ...c, checkPassed: true } : c);
      S.envelope = { ...S.envelope, ladder: { ...ladder, passed: { ...ladder.passed, [key]: at2 }, ...ended ? { floor: void 0 } : {}, ...episodes ? { episodes } : {} } };
      if (S.policy === "auto") {
        for (const f of S.envelope.failures) if (f.command === key) S.resolvedCounts = { ...S.resolvedCounts, [f.fingerprint]: S.envelope.failures.filter((x) => x.fingerprint === f.fingerprint).length };
      }
      S.verifiedSinceSwitch = true;
      const tr = trigger(trigState(), { kind: "check-pass", implementing: S.stage === "implement" && S.editedSinceCheck });
      S.verifiedAfterPlan = true;
      if (tr.action === "reoptimize") reoptimize(tr, "check-pass", at2, void 0);
    } else {
      const f = failureOf(key, exitCode || 1, text.slice(-8e3), at2, S.editedSinceCheck);
      if (f) {
        S.envelope = { ...S.envelope, failures: [...S.envelope.failures, f].slice(-20), verified: false };
        if (S.policy === "auto") await runLadder($, at2);
        else await legacyEscalation($, f.fingerprint, at2);
      }
    }
    await noteRun($, { command: String(input.command), output: text, exit: exitCode }, !passed);
    S.editedSinceCheck = false;
    return out;
  }
  if (e.tool === "Bash" && S.envelope) {
    const out = await next(e);
    if (!out.deny) {
      await noteCommand($, String(input.command ?? ""));
      if (writesFiles(String(input.command ?? ""))) {
        S.editedSinceCheck = true;
        S.bashEdits += 1;
      }
      const text = resultText(out);
      const exit = text.match(/Exit code (\d+)/);
      await noteRun($, { command: String(input.command ?? ""), output: text, exit: exit ? Number(exit[1]) : out.isError === true ? 1 : 0 }, false);
    }
    return out;
  }
  return next(e);
}
async function legacyEscalation($, fp, at2) {
  const env = S.envelope;
  const step = failureStep(env.failures, S.current?.tier ?? "T1");
  if (step.action === "consult-opus" && S.current && S.current.family !== "opus" && !S.consulted.includes(fp)) {
    const packet2 = evidencePacket(env.spec.text.slice(0, 1500), env.acceptance.map((a) => a.text), env.failures, env.editedPaths);
    const c = consultOrSwitch2({ prefixTokens: cacheState().prefixTokens, remainingRequests: S.priors.remainingRequests, outPerRequest: S.priors.outputPerStep.opus, packetTokens: Math.ceil(packet2.length / 3.5), planTokens: 2e3, main: S.current.family, ttlMs: S.ttl, prices: prices() });
    if (c.choice === "consult") {
      S.consulted = [...S.consulted, fp].slice(-20);
      S.consultCounts = { ...S.consultCounts, [fp]: env.failures.filter((x) => x.fingerprint === fp).length };
      S.envelope = { ...env, escalations: env.escalations + 1 };
      S.records.push({ v: 1, kind: "escalation", at: at2, sessionId: S.sessionId, taskId: env.taskId, floor: null, action: "consult-opus", via: "architect", because: step.because, estimate: { consultUsd: round6(c.consultUsd), switchUsd: round6(c.switchUsd), basis: S.priors.basis } });
      await flush($);
      $.ui.toast(`AutoMode: ${step.because}. Asking an Opus architect instead of moving the session.`);
      S.ladderNote = `[AutoMode: the same check failed twice after an edit. Before changing more code, call the Agent tool with subagent_type "automode:architect" (Opus, read-only) and wait for it, with this evidence:
${packet2}
Ask it for the cause and a fix plan. Apply its plan, then run the check again.]`;
      return;
    }
  }
  if (!step.floor || !S.current || TIER_ORDER.indexOf(step.floor) <= TIER_ORDER.indexOf(S.current.tier)) return;
  const target = routeFor2(step.floor);
  const applied = pinned(target, S.appModel ?? target.model);
  S.pending = { ...applied, owner: "quality-escalation", reason: step.because, floor: { tier: step.floor, because: [step.because] }, overridden: [] };
  S.envelope = withReview({ ...env, escalations: env.escalations + 1 }, "fail", false);
  const moved = applied.family !== S.current.family || applied.effort !== S.current.effort;
  S.records.push({ v: 1, kind: "escalation", at: at2, sessionId: S.sessionId, taskId: env.taskId, floor: step.floor, action: moved ? step.action : "held-by-pin", via: "switch", because: step.because });
  await flush($);
  if (!moved) {
    $.ui.toast(`AutoMode: ${step.because}. Your choice keeps ${applied.family} ${applied.effort}.`);
    return;
  }
  $.ui.toast(`AutoMode: ${step.because}. Moving to ${step.floor}.`);
  const packet = step.action === "consult-opus" ? `

Evidence for the next step:
${evidencePacket(env.spec.text.slice(0, 1500), env.acceptance.map((a) => a.text), S.envelope.failures, env.editedPaths)}` : "";
  const consulted = S.consulted.includes(fp) ? " An Opus consult on this defect already ran; the session itself now moves to the stronger model." : "";
  S.ladderNote = `[AutoMode: escalated to ${step.floor} after a repeated failing check.${consulted} When the check passes, the independent review (automode:reviewer) is required before you call it done.]${packet}`;
}
function resultText(out) {
  const r = out?.result;
  if (typeof r === "string") return r;
  if (r && typeof r === "object") {
    const parts = [r.stdout, r.stderr, r.output, r.content].filter((x) => typeof x === "string");
    if (parts.length) return parts.join("\n");
  }
  return typeof out?.text === "string" && out.text ? out.text : JSON.stringify(r ?? "");
}
function changedLines(tool, input) {
  const n = (v) => typeof v === "string" && v.length ? v.split("\n").length : 0;
  if (tool === "Write") return n(input.content);
  if (tool === "MultiEdit" && Array.isArray(input.edits)) return input.edits.reduce((a, x) => a + Math.max(n(x.old_string), n(x.new_string)), 0);
  return Math.max(n(input.old_string), n(input.new_string));
}
function interfacesOf(tool, input) {
  const str = (v) => typeof v === "string" ? v : "";
  if (tool === "MultiEdit" && Array.isArray(input.edits)) return input.edits.reduce((a, x) => a + interfaceChanges(str(x.old_string), str(x.new_string)), 0);
  if (tool === "Edit") return interfaceChanges(str(input.old_string), str(input.new_string));
  return 0;
}
var PLAN_EXIT_NOTE = (acceptance) => `[The plan was approved and implementation starts. Judge the IMPLEMENTATION work the plan starts, not the planning. Acceptance: ${acceptance}]`;
async function rejudgePlanExit($, turnId) {
  const env = S.envelope;
  if (!env || S.mode !== "auto") return;
  const acceptance = env.acceptance.map((a) => a.text).join("; ").slice(0, 400) || "none stated";
  await rejudgeAuto($, PLAN_EXIT_NOTE(acceptance), trigger(trigState(), { kind: "plan-exit" }), "plan-exit", turnId);
}
async function applyPlanMode($, entering, via, late) {
  if (entering !== S.planMode) S.records.push({ v: 1, kind: "plan-mode", at: await now2($), sessionId: S.sessionId, on: entering, via });
  const exiting = !entering && S.planMode;
  if (exiting) S.planExited = true;
  S.planMode = entering;
  S.stage = entering ? "plan" : "implement";
  S.workStage = entering ? "plan" : "plan-approved";
  if (entering) S.verifiedAfterPlan = false;
  S.judgedThisStage = false;
  if (exiting && (via === "attachment" || late)) {
    if (S.policy === "auto" && S.lastAuto) await rejudgePlanExit($, late?.turnId);
    else reoptimize(trigger(trigState(), { kind: "plan-exit" }), "plan-exit", await now2($), late?.turnId);
  }
  if (entering && late && S.pending && S.pending.owner !== "user-override") {
    if (S.policy === "auto" && S.lastAuto) await rejudgeAuto($, "", trigger(trigState(), { kind: "plan-enter" }), "plan-enter", late.turnId);
    else reoptimize(trigger(trigState(), { kind: "plan-enter" }), "plan-enter", await now2($), late.turnId);
  }
  if (late && S.pending) barLine($, S.pending);
}
async function v4Attachment($, e, next) {
  if (e.agentId === void 0 && (e.type === "plan_mode" || e.type === "plan_mode_reentry" || e.type === "plan_mode_exit") && S.mode !== "off" && await activeV4($)) {
    await applyPlanMode($, e.type !== "plan_mode_exit", "attachment");
  }
  return next(e);
}
async function signalsFile($) {
  let home2;
  try {
    home2 = await $.env.get("CLAUDE_CONFIG_DIR") || `${await $.env.get("HOME")}/.claude`;
  } catch {
  }
  return `${home2 ?? "."}/plugins/data/automode/signals/${S.sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;
}
async function syncSignals($, late) {
  if (S.mode !== "auto" || !S.signalsOn || S.sessionId === "unknown") return;
  try {
    const file = await signalsFile($);
    if (!await fsExists($, file)) return;
    const sig = JSON.parse(await fsRead($, file));
    if (!sig || typeof sig.seq !== "number" || sig.seq === S.signalSeq) return;
    S.signalSeq = sig.seq;
    if (typeof sig.permissionMode === "string" && sig.permissionMode !== S.signalMode) {
      S.signalMode = sig.permissionMode;
      const entering = sig.permissionMode === "plan";
      if (entering !== S.planMode) await applyPlanMode($, entering, "signal", late);
    }
    for (const er of Array.isArray(sig.errors) ? sig.errors : []) {
      if (typeof er?.at !== "number" || er.at <= S.signalErrorAt) continue;
      S.signalErrorAt = er.at;
      S.pendingErrors.push({ at: er.at, error: String(er.error ?? "unknown").slice(0, 40), detail: String(er.detail ?? "") });
    }
    if (S.pendingErrors.length) await reconcileErrors($, await now2($));
    for (const c of Array.isArray(sig.compactions) ? sig.compactions : []) {
      if (typeof c?.at !== "number" || c.at <= S.signalCompactAt) continue;
      S.signalCompactAt = c.at;
      if (!(S.compactedAt && Math.abs(c.at - S.compactedAt) < 6e4)) await noteCompaction($, `signal ${String(c.via ?? "unknown").slice(0, 40)}`);
      if (!S.compactHookSeen && !S.toldUserTier && S.cfg.compactWith === "haiku") {
        S.toldUserTier = true;
        $.ui.toast("AutoMode: this Mac runs AutoMode as a user plugin, so Claude's own model wrote the compaction summary. For Haiku summaries, ask IT to list it as an organization plugin (see the AutoMode README).");
      }
    }
    await persist2($);
  } catch {
  }
}
async function noteCompaction($, via) {
  if (S.compactedPending && S.compactedAt && await now2($) - S.compactedAt < 6e4) return;
  S.resetPending = true;
  S.compactedPending = true;
  S.compactedAt = await now2($);
  S.basePrefixMeasured = false;
  S.haikuOutUntilCompaction = false;
  S.warm = {};
  S.dropped = {};
  S.records.push({ v: 1, kind: "compaction", at: S.compactedAt, sessionId: S.sessionId, via });
  await persist2($);
  await flush($);
}
async function v4Append($, e, next) {
  const out = await next(e);
  const m = e.message;
  if (e.agentId === void 0 && (e.door === "compaction" || m?.type === "system" && m?.name === "compact_boundary") && S.mode === "auto" && await activeV4($)) await noteCompaction($, `session.append ${e.door}`);
  return out;
}
async function v4Compact($, e, next) {
  S.compactHookSeen = true;
  if (S.mode !== "off" && e.agentId === void 0 && await activeV4($)) {
    S.records.push({ v: 1, kind: "compact-hook", at: await now2($), sessionId: S.sessionId, trigger: e.trigger, mode: S.mode });
    await flush($);
  }
  if (e.agentId !== void 0 || S.mode !== "auto" || !await activeV4($)) return next(e);
  const instructions = [e.instructions?.trim(), S.envelope ? compactInstructions(S.envelope) : ""].filter(Boolean).join("\n\n");
  if (e.trigger !== "precompute") await noteCompaction($, `session.compact ${e.trigger}`);
  if (S.cfg.compactWith !== "haiku" || e.trigger === "precompute") return next({ ...e, instructions });
  const messages = Array.isArray(e.messages) && e.messages.length ? e.messages : await $.session.messages().catch(() => []);
  const r = await $.model.complete({
    model: S.cfg.compactModel,
    system: COMPACT_SYSTEM,
    maxTokens: 16e3,
    effort: "medium",
    timeoutMs: 24e4,
    prompt: `${transcriptOf(messages)}

---
Write the summary now.
${instructions}`
  }).catch(() => null);
  if (r?.usage) S.records.push({ v: 1, kind: "model-call", purpose: "compaction", at: await now2($), sessionId: S.sessionId, ok: !!r.isAnswered, model: r.usage.model ?? S.cfg.compactModel, usage: usageOf(r.usage), usd: { value: round6(usageUsd(usageOf(r.usage), ANTHROPIC2.rates.haiku)), basis: "measured", source: `${ANTHROPIC2.provider} ${ANTHROPIC2.checkedAt}` } });
  await flush($);
  if (!r || !r.isAnswered || r.text.trim().length < 200) return next({ ...e, instructions });
  return { messages: [{ role: "user", text: `This session continues from an earlier conversation that ran out of context. The summary below, written by Haiku for AutoMode, covers it.

${r.text.trim()}

Continue from where it left off without asking the user further questions.`, toolUses: [] }] };
}
var TIER_ORDER = ["T0", "T1", "T2", "T3", "T4"];
function noteJudge(usd) {
  S.ledger = { ...S.ledger, judgeUsd: round6(S.ledger.judgeUsd + usd), judgeCalls: S.ledger.judgeCalls + 1 };
}
function noteLedger(model, u, usd, agentId) {
  const fr = agentId !== void 0 ? S.forkRuns.get(agentId) : void 0;
  if (fr && !fr.first) fr.first = { cacheRead: u.cacheRead, prompt: u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h };
  const L = S.ledger;
  const row = L.byModel[model] ?? { usd: 0, requests: 0 };
  S.ledger = {
    ...L,
    requests: L.requests + 1,
    byModel: { ...L.byModel, [model]: { usd: round6(row.usd + usd), requests: row.requests + 1 } },
    cacheRead: L.cacheRead + u.cacheRead,
    cacheWrite: L.cacheWrite + u.cacheWrite5m + u.cacheWrite1h,
    subagentUsd: agentId !== void 0 ? round6(L.subagentUsd + usd) : L.subagentUsd
  };
  const a = agentId !== void 0 ? U.agents.get(agentId) : void 0;
  if (a) U.agents.set(agentId, { ...a, model, usd: round6((a.usd ?? 0) + usd) });
}
var MAX_UI_AGENTS = 40;
function noteAgent(res, e, model, routed, effort) {
  if (!res?.agentId) return;
  U.agents.set(res.agentId, {
    id: res.agentId,
    type: String(e.subagentType ?? "agent"),
    model: model ?? e.model ?? null,
    effort: effort ?? null,
    routed,
    explicit: !!e.model,
    status: "running",
    result: null,
    workflow: e.workflow?.runId ? { runId: String(e.workflow.runId), index: Number(e.workflow.agentIndex) || 0 } : null,
    label: typeof e.description === "string" ? e.description.slice(0, 60) : null,
    usd: null,
    startedAt: Date.now()
  });
  if (U.agents.size > MAX_UI_AGENTS) U.agents.delete(U.agents.keys().next().value);
}
function noteVerdict(d) {
  const chosen = d.auto?.verdicts?.[d.route.family];
  const by = d.route.owner === "user-override" || d.override ? "You" : chosen?.ok || d.answer ? "Judge" : "Rule";
  U.verdict = { by, why: chosen?.ok && chosen.why || d.route.reason || "", confidence: d.answer?.confidence ?? null };
  U.candidates = (d.auto?.candidates ?? []).slice(0, 6).map((c) => ({ route: c.route, eligibility: c.eligibility, usd: Number.isFinite(c.usd) ? c.usd : null, why: (c.why ?? []).join("; ") }));
}
function v4Snapshot(sessionModel2, now3) {
  const r = S.pending;
  return {
    enabled: S.cfg.router === "v4",
    killed: U.killed,
    activation: S.cfg.activation === "picker" ? "picker" : "always",
    active: S.cfg.activation !== "picker" || !!sessionModel2 && sessionModel2.trim() === S.cfg.pickerModel,
    mode: S.mode,
    configMode: U.configMode,
    sessionMode: S.sessionMode,
    policy: S.policy,
    providerGuard: S.providerGuard,
    provider: S.provider,
    learned: { tasks: S.learned.tasks.length, opusFirst: opusBuckets(S.learned, now3) },
    routeModels: S.cfg.routeModels !== false,
    subagentsEverySession: !!S.cfg.subagentsEverySession,
    sessionModel: sessionModel2,
    requested: r ? { family: r.family, model: r.model, effort: r.effort, owner: r.owner, reason: r.reason, floor: r.floor?.tier ?? "—" } : null,
    held: S.heldRoute ? { family: S.heldRoute.family, effort: S.heldRoute.effort } : null,
    effective: { model: S.cache?.model ?? null, effort: S.lastEffective ?? S.cache?.effort ?? null, at: S.cache?.lastRequestAt ?? null },
    deferredEffort: U.deferred,
    verdict: U.verdict,
    judging: U.judging,
    judgeDown: Object.entries(S.judgeBreaker).filter(([, b2]) => (b2?.until ?? 0) > now3).map(([k]) => k),
    breakers: Object.entries(S.breakers).filter(([, b2]) => b2.openUntil > now3).map(([k, b2]) => ({ model: k.slice(k.indexOf(":") + 1), until: b2.openUntil, cls: b2.class ?? null })),
    inadequate: S.inadequate ? { shortfall: S.inadequate.shortfall, route: S.inadequate.route } : null,
    stage: S.workStage,
    planMode: S.planMode,
    review: { required: !!S.envelope?.reviewRequired.value, because: [...S.envelope?.reviewRequired.because ?? []] },
    lastCheck: S.lastCheck,
    ttlMs: S.ttl,
    consult: S.consultLog.length ? { episode: S.consultLog.at(-1).episode, state: S.consultLog.at(-1).outcome ?? "open" } : null,
    warm: Object.fromEntries(Object.entries(S.warm).map(([f, w]) => [f, { until: w.until, effort: w.effort }])),
    candidates: U.candidates,
    agents: [...U.agents.values()],
    ledger: S.ledger
  };
}
async function setSessionMode($, m) {
  try {
    if (!S.restored) {
      S.sessionId = await sid($);
      await restore2($);
    }
  } catch {
  }
  S.sessionMode = m;
  S.loaded = false;
  await loadV4($);
  if (S.restored) await persist2($);
  await publish($);
}
function freshSession() {
  return {
    current: null,
    pending: null,
    envelope: null,
    lastSummary: "",
    resetPending: true,
    votes: { tier: null, n: 0 },
    requestsSinceSwitch: 0,
    verifiedSinceSwitch: false,
    cache: null,
    lastReply: "",
    lastPromptText: "",
    turnPrompt: /* @__PURE__ */ new Map(),
    workers: /* @__PURE__ */ new Map(),
    agents: /* @__PURE__ */ new Map(),
    lastCheck: null,
    editedSinceCheck: false,
    obligations: [],
    obligationsTask: null,
    obligationEdited: false,
    completionBlocks: 0,
    completionState: "none",
    toldJudgeDown: false,
    taskSeq: 0,
    lastOutcome: null,
    sessionId: "unknown",
    restored: false,
    expectWorker: 0,
    warm: {},
    turnRequests: /* @__PURE__ */ new Map(),
    stayUp: 0,
    redoFloor: null,
    heldRoute: null,
    planMode: false,
    planExited: false,
    editLog: [],
    learned: EMPTY_LEARNED,
    learnedTold: void 0,
    gatedReads: [],
    consulted: [],
    consultCounts: {},
    consultMs: [],
    consultLog: [],
    taskPrompts: [],
    forkRuns: /* @__PURE__ */ new Map(),
    bashEdits: 0,
    resolvedCounts: {},
    switchesThisTask: 0,
    dropped: {},
    rent: null,
    lastDemand: null,
    stage: "implement",
    workStage: "implement",
    verifiedAfterPlan: false,
    judgedThisStage: false,
    compactedPending: false,
    requestsInPrompt: 0,
    basePrefix: 0,
    compactedAt: 0,
    basePrefixMeasured: false,
    lastMessageCount: 0,
    workflowPending: null,
    workflowRanTask: void 0,
    signalSeq: 0,
    signalCompactAt: 0,
    compactHookSeen: false,
    toldUserTier: false,
    sessionMode: null,
    ledger: emptyLedger(),
    judgeBreaker: {},
    lastAuto: null,
    verdictCache: {},
    taskDecision: null,
    decidedPlanMode: false,
    lastRisk: "none",
    newInput: false,
    lastEffective: null,
    appEffort: void 0,
    appModel: void 0,
    sessionModel: void 0,
    pinFamily: void 0,
    pinEffort: void 0,
    turnOverride: null,
    unroutable: false,
    appPlan: false,
    ladderNote: null,
    judgeRiskTask: void 0,
    preflight: void 0,
    breakers: {},
    lastNoResponse: null,
    failures: [],
    pendingErrors: [],
    signalErrorAt: 0,
    signalMode: "",
    compactionPricedAt: 0,
    haikuOutUntilCompaction: false,
    lastWorkBand: void 0,
    effortUnsupported: false,
    thinkingRisk: false,
    toldErrorClass: "",
    toldBreaker: false,
    firstPrefixSaved: false,
    inadequate: null,
    toldInadequateTask: ""
  };
}
async function useV4($) {
  if (!S.loaded) await loadV4($);
  return S.cfg.router === "v4";
}

// hooks/ui/register-ui.tsx
import { atom as atom2, read } from "claude-code";

// hooks/ui/tokens.ts
var AUTOMODE = {
  dark: {
    appearance: "dark",
    theme: "automode",
    bg: "#10141c",
    raised: "#171c26",
    edge: "#2a3242",
    hover: "#1f2633",
    text: "#e8ebf2",
    dim: "#9aa4b5",
    route: "#4ea8ff",
    cyan: "#3fd6ec",
    effort: "#b39dff",
    guard: "#34d3bd",
    warn: "#f5b84a",
    error: "#ff7a7a",
    warnBg: "#1d1a12",
    errorBg: "#1f1316"
  },
  light: {
    appearance: "light",
    theme: "automode",
    bg: "#f7f9fc",
    raised: "#eef2f8",
    edge: "#d3dae6",
    hover: "#e6ebf3",
    text: "#141a26",
    dim: "#5a6476",
    route: "#0a62c9",
    cyan: "#0b7285",
    effort: "#6b3fd4",
    guard: "#0b7468",
    warn: "#9a5b00",
    error: "#c0262d",
    warnBg: "#fbf4e6",
    errorBg: "#fbeced"
  }
};
var VARIANTS = {
  mono: {
    dark: { route: "#d5dae3", cyan: "#c2c8d3", effort: "#e8ebf2", guard: "#c2c8d3" },
    light: { route: "#2a3242", cyan: "#3a4356", effort: "#141a26", guard: "#3a4356" }
  },
  contrast: {
    dark: { bg: "#05070b", raised: "#0d1118", edge: "#5b6880", text: "#ffffff", dim: "#c3cad6", route: "#7cc0ff", cyan: "#6fe6f5", effort: "#cdbdff", guard: "#5ee8d3", warn: "#ffcc66", error: "#ff9a9a" },
    light: { bg: "#ffffff", raised: "#f1f4f9", edge: "#8a96aa", text: "#000000", dim: "#3a4356", route: "#004fa8", cyan: "#005866", effort: "#4f22b0", guard: "#005a51", warn: "#7a4700", error: "#9e1a20" }
  }
};
var NATIVE = {
  appearance: "dark",
  theme: "native",
  bg: "",
  raised: "",
  edge: "promptBorder",
  hover: "",
  text: "text",
  dim: "subtle",
  route: "text",
  cyan: "subtle",
  effort: "text",
  guard: "success",
  warn: "warning",
  error: "error",
  warnBg: "",
  errorBg: ""
};
function tokensFor(appearance, theme = "native") {
  if (theme === "native") return { ...NATIVE, appearance };
  const base = AUTOMODE[appearance];
  return theme === "automode" ? base : { ...base, ...VARIANTS[theme][appearance], theme };
}
function appearanceOf(setting, configTheme2) {
  if (setting !== "auto") return setting;
  return /^light/i.test(String(configTheme2 ?? "")) ? "light" : "dark";
}

// hooks/ui/switch.ts
async function toggleRouting($) {
  const before = v4Snapshot(null, 0);
  const wantOn = before.mode === "off";
  await setSessionMode($, wantOn ? null : "off");
  const now3 = v4Snapshot(null, 0).mode;
  if (wantOn && now3 === "off") return "Still off: the configuration or AUTOMODE_ROUTER keeps routing off.";
  if (!wantOn && now3 !== "off") return `Not turned off: AUTOMODE_ROUTER keeps routing ${now3}.`;
  return wantOn ? "Routing is on for this session, from the next prompt." : "Routing is off for this session, from the next request. Your model and effort run as set.";
}

// hooks/ui/bar.tsx
var GLYPH = { paused: "■", judge: "●", handoff: "▲", compact: "▲", warning: "▲", cold: "❄", limit: "▲", restored: "✓" };
function drawAlert(c, a) {
  const { Text } = c.els;
  const tone = a.tone === "error" ? c.t.error : a.tone === "guard" ? c.t.guard : a.tone === "cyan" ? c.t.dim : c.t.warn;
  return /* @__PURE__ */ h(Text, { key: `alert-${a.kind}`, color: tone, wrap: "wrap" }, `${GLYPH[a.kind]} ${a.title}. ${a.line}`);
}
function drawTip(c, v) {
  const { Text } = c.els;
  if (!v.tip || c.now >= v.tip.until) return null;
  return /* @__PURE__ */ h(Text, { key: "hm-tip", color: c.t.dim, wrap: "wrap" }, `Tip: ${v.tip.text}`);
}
function drawSwitch($, c, v) {
  const { Button } = c.els;
  const r = v.router;
  if (!r.enabled || r.killed || !r.active) return null;
  const routing = r.mode !== "off";
  return /* @__PURE__ */ h(Button, { key: "hm-switch", plain: true, dimColor: !routing, hotkey: c.term ? "m" : void 0, label: routing ? "● on" : "○ off", onPress: () => toggleRouting($) });
}
function drawBar($, c, v, metrics, minimal) {
  const { Box, Text } = c.els;
  const t = c.t;
  const segs = barSegments(v, c.term ? Math.max(24, c.cols - 4) : 999, c.now, minimal ? ["context", "guardian"] : metrics);
  const tone = (s) => s.key === "model" ? s.tone === "dim" ? t.dim : t.text : s.key === "effort" ? s.tone === "dim" ? t.dim : t.text : t[s.tone];
  const item = (s, i) => /* @__PURE__ */ h(Box, { key: `item-${s.key}`, flexShrink: 0, flexDirection: "row" }, i ? /* @__PURE__ */ h(Text, { color: t.dim }, s.sep ?? " · ") : null, /* @__PURE__ */ h(Text, { color: tone(s), bold: !!s.bold, wrap: "truncate" }, s.text));
  return (
    // VS Code and desktop already frame the band; a second border inside it would double the line. Only the terminal,
    // which draws no frame of its own, gets one.
    /* @__PURE__ */ h(Box, { key: "hm-bar", flexDirection: "row", overflow: "hidden", ...c.term ? { paddingX: 1, borderStyle: "round", borderColor: t.edge } : { flexWrap: "wrap", height: 1 } }, segs.map(item), /* @__PURE__ */ h(Box, { flexGrow: 1 }), drawSwitch($, c, v))
  );
}

// hooks/ui/details.tsx
var STAGE_GLYPH = { done: "●", active: "◉", failed: "✕", required: "◇" };
function detailsText(v, now3) {
  const r = v.router, g = v.guard;
  const lines = [
    `Routing: ${v.routing.label}${v.routing.note ? ` (${v.routing.note})` : ""}`,
    `  running ${v.model.name} · ${v.effort.name}${v.pending ? ` · ${v.pending}` : ""}${v.hold ? ` · ${v.hold}` : ""}${v.escalation ? ` · ${v.escalation}` : ""}`,
    r.requested && r.active ? `  why: ${v.judge.state === "down" ? `${v.judge.line}; no verdict` : v.judge.line ?? r.requested.reason}` : null,
    `  context ${v.context.percent === null ? "—" : `${Math.round(v.context.percent)}% (${tokensText(v.context.tokens)})`} · cache ${v.cache.state === "unknown" ? "—" : cacheText(v.cache.until, now3)}`,
    r.learned?.tasks ? `Learned: ${r.learned.tasks} tasks in this project${r.learned.opusFirst.length ? ` · starts on Opus: ${r.learned.opusFirst.join(", ")}` : ""}` : null,
    v.workflow.length ? `Workflow: ${v.workflow.map((s) => `${STAGE_GLYPH[s.state]} ${s.name}`).join(" ─ ")}` : null,
    `Guardian: ${g.enabled ? `${v.guardian.glyph} ${v.guardian.state} (mode ${g.mode})` : "off"}${g.checkpoint ? ` · checkpoint ${g.checkpoint.sum}` : ""}`,
    `Usage: ${usdText(v.cost.session)} this session${r.ledger.requests ? ` · judges ${usdText(r.ledger.judgeUsd)} · subagents ${usdText(r.ledger.subagentUsd)} (measured)` : ""}`
  ];
  return lines.filter(Boolean).join("\n");
}

// hooks/ui/commands.ts
var SUBCOMMANDS = [
  { name: "status", aliases: [""], line: "the bar as text" },
  { name: "details", aliases: ["stats"], line: "routing, workflow, guardian and usage as text" },
  { name: "on", aliases: [], line: "turn routing on for this session" },
  { name: "off", aliases: [], line: "turn routing off for this session: your model and effort run as set" },
  { name: "setup", aliases: [], line: "check that AutoMode is on, and show the next step" },
  { name: "settings", aliases: [], line: "the effective settings and where each comes from" },
  { name: "debug", aliases: [], line: "a report to paste in a bug issue, with no prompt text" },
  { name: "help", aliases: ["tips", "commands"], line: "this list, the am: prompt commands and tips" }
];
function parse(args) {
  const s = String(args ?? "").trim();
  const i = s.search(/\s/);
  return i < 0 ? { sub: s.toLowerCase(), rest: "" } : { sub: s.slice(0, i).toLowerCase(), rest: s.slice(i + 1).trim() };
}
function resolve3(sub) {
  for (const c of SUBCOMMANDS) if (c.name === sub || c.aliases.includes(sub)) return c.name;
  return null;
}
function usageLine() {
  return `/automode [${SUBCOMMANDS.map((c) => c.name).join("|")}]`;
}
function helpRows() {
  const rows = [
    ...SUBCOMMANDS.map((c) => [`  /automode ${c.name === "status" ? "" : c.name}`.trimEnd(), c.line]),
    ["  /automode:usage [--trace]", "model calls, tokens, cache use and estimated API cost"]
  ];
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  return rows.map(([label, line]) => label.padEnd(width) + line);
}
function helpText() {
  return [
    "AutoMode picks the model and effort for each prompt.",
    "",
    "Commands:",
    ...helpRows(),
    "",
    "The bar: model · effort · context · cache time left · session cost, then why it was chosen.",
    "For one prompt, start it with: am:haiku | am:sonnet | am:opus, am:low | am:medium | am:high | am:xhigh | am:max,",
    "  am:direct (skip planning), am:run (full workflow), am:explore, am:new (new task), am:reset (back to automatic).",
    "If the guardian pauses a turn, reply am:continue. After /clear, am:handoff restores the task checkpoint.",
    "Shorter replies: /output-style automode:Concise. Your own /effort or /model always wins.",
    "Before a long break: /compact. Hide the bar: AUTOMODE_UI=off."
  ].join("\n");
}
function unknownText(sub) {
  return `Unknown subcommand "${sub.slice(0, 40)}". ${usageLine()}`;
}
var yes = (b2) => b2 ? "yes" : "no";
var home = (s, h2) => h2 && s.startsWith(h2) ? `~${s.slice(h2.length)}` : s;
function setupText(v, f) {
  const r = v.router;
  const picker = String(f.config.pickerModel ?? "claude-sonnet-5-5[1m]");
  const lines = ["AutoMode setup", "", `✓ The mod is loaded (version ${f.version}).`];
  if (!r.enabled) lines.push('✗ The router is off in config.json (router is not "v4"). AutoMode does not route.');
  else if (r.killed) lines.push("✗ AUTOMODE_ROUTER=off is set. Unset it to route.");
  else lines.push("✓ The router is enabled.");
  if (r.activation === "always") lines.push("✓ AutoMode starts with every session (activation: always).");
  else lines.push(r.active ? `✓ This session runs on the AutoMode model (${picker}).` : `✗ This session runs on ${r.sessionModel ?? "an unknown model"}, so AutoMode is idle (activation: picker).`);
  lines.push(r.mode === "off" ? "✗ Routing is off for this session. Run /automode on." : `✓ Routing mode: ${r.mode}.`);
  lines.push(f.env.AUTOMODE_UI === "off" ? "• The bar is hidden (AUTOMODE_UI=off)." : "✓ The bar is shown above the prompt.");
  lines.push("");
  if (!r.active) {
    lines.push(
      'Next step: set "activation": "always" in config.json so AutoMode starts with every session.',
      `Or start Claude Code on the AutoMode model (picker mode, needs a Claude Code build that keeps the suffix): claude --model '${picker}'`
    );
  } else if (r.mode === "off") {
    lines.push("Next step: /automode on");
  } else {
    lines.push("Nothing to do. Send a prompt, and the bar shows the route. /automode help lists the commands.");
  }
  lines.push("Optional: /output-style automode:Concise for shorter replies.");
  return lines.join("\n");
}
function settingsText(v, f) {
  const r = v.router, g = v.guard, c = f.config;
  const row = (k, val, how) => `  ${k.padEnd(27)}${String(val).padEnd(24)}${how}`;
  const modeHow = r.sessionMode ? "/automode on|off (this session)" : r.killed ? "AUTOMODE_ROUTER" : "config.json or /plugin configure";
  return [
    "AutoMode settings",
    "",
    row("routing mode", r.mode, modeHow),
    row("policy", r.policy, "config.json: policy"),
    row("route models", yes(r.routeModels), "config.json: routeModels"),
    row("subagents, every session", yes(r.subagentsEverySession), "config.json: subagentsEverySession"),
    row("activation", r.activation, "config.json: activation (always or picker)"),
    row("picker model", c.pickerModel ?? "claude-sonnet-5-5[1m]", "config.json: pickerModel (picker mode only)"),
    row("review policy", c.reviewPolicy ?? "risk", "config.json: reviewPolicy"),
    row("default path", c.defaultPath ?? "direct", "config.json: defaultPath"),
    row("max concurrency", c.maxConcurrency ?? 1, "config.json: maxConcurrency"),
    row("guardian", `${g.mode}${g.killed ? " (killed by env)" : ""}`, "config.json: guardian.mode, AUTOMODE_GUARDIAN"),
    row("hard pause", yes(g.hardPause), "config.json: guardian.hardPause"),
    row("auto compact", yes(g.autoCompact), "config.json: guardian.autoCompact"),
    row("bar", f.env.AUTOMODE_UI === "off" ? "hidden" : "shown", "AUTOMODE_UI=off hides it"),
    "",
    "To override a default for good, put a config.json in the plugin data directory, or run /plugin configure automode@automode."
  ].join("\n");
}
function debugText(v, f, now3) {
  const r = v.router, g = v.guard;
  const age = (t) => t ? `${Math.max(0, Math.round((now3 - t) / 1e3))}s ago` : "never";
  return [
    "AutoMode debug. Paste this in your issue. It holds no prompt text.",
    "",
    `version          ${f.version}`,
    `plugin root      ${home(f.root, f.home)}`,
    `session model    ${r.sessionModel ?? "unknown"}`,
    `active           ${yes(r.active)} (activation ${r.activation})`,
    `enabled / killed ${yes(r.enabled)} / ${yes(r.killed)}`,
    `mode             ${r.mode} (config ${r.configMode}, session ${r.sessionMode ?? "none"})`,
    `policy           ${r.policy}`,
    `provider         ${r.provider}${r.providerGuard ? " (guard on)" : ""}`,
    `route requested  ${r.requested ? `${r.requested.family}/${r.requested.effort} by ${r.requested.owner}: ${r.requested.reason}` : "none"}`,
    `route effective  ${r.effective.model ?? "unknown"} / ${r.effective.effort ?? "unknown"} (${age(r.effective.at)})`,
    `judge            ${v.judge.state}${r.judgeDown.length ? `, down: ${r.judgeDown.join(", ")}` : ""}`,
    `breakers         ${r.breakers.length ? r.breakers.map((b2) => `${b2.model}${b2.cls ? ` (${b2.cls})` : ""}`).join(", ") : "none"}`,
    `plan mode        ${yes(!!r.planMode)}`,
    `stage            ${r.active ? r.stage ?? "none" : "idle"}`,
    `guardian         ${g.mode}, level ${g.level}${g.paused ? ", PAUSED" : ""}${g.killed ? ", killed by env" : ""}`,
    `context          ${v.context.percent === null ? "unknown" : `${Math.round(v.context.percent)}%`} (${v.context.level})`,
    `cache            ${v.cache.state}`,
    `calls            ${r.ledger.requests}`,
    `env              ${Object.entries(f.env).filter(([, val]) => val !== null).map(([k, val]) => `${k}=${val}`).join(" ") || "none set"}`
  ].join("\n");
}

// hooks/ui/register-ui.tsx
var viewAtom2 = atom2({ plugin: "automode", key: "view" }, null);
var configTheme;
var tickDue = 0;
var lastUiError = null;
async function themeOf($) {
  if (configTheme !== void 0) return configTheme;
  try {
    configTheme = String((await $.config.list()).find((r) => r.key === "theme")?.value ?? "") || null;
  } catch {
    configTheme = null;
  }
  return configTheme;
}
async function uiSessionStart($) {
  try {
    configTheme = void 0;
    if (await uiDisabled($)) return;
    await $.command.register({ name: "automode", description: `AutoMode: ${usageLine()}` });
    await loadFacts($);
    await publish($);
  } catch {
  }
}
async function cmdFacts($) {
  const safe = async (p, fallback) => {
    try {
      return await p;
    } catch {
      return fallback;
    }
  };
  const json = async (file) => {
    try {
      return JSON.parse(await fsRead($, file));
    } catch {
      return {};
    }
  };
  const str = (v) => v ? String(v) : null;
  const root = String($.plugin.root);
  const manifest = await json(`${root}/.claude-plugin/plugin.json`);
  return {
    version: String(manifest.version ?? "unknown"),
    root,
    home: str(await safe($.env.get("HOME"), null)),
    config: await json(`${root}/config.json`),
    env: {
      AUTOMODE_ROUTER: str(await safe($.env.get("AUTOMODE_ROUTER"), null)),
      AUTOMODE_UI: str(await safe($.env.get("AUTOMODE_UI"), null)),
      AUTOMODE_GUARDIAN: str(await safe($.env.get("AUTOMODE_GUARDIAN"), null)),
      AUTOMODE_SIGNALS: str(await safe($.env.get("AUTOMODE_SIGNALS"), null))
    }
  };
}
function scheduleTick($, now3, v) {
  const due = [];
  if (v.cache.state === "warm" && v.cache.until !== null && v.cache.until > now3) due.push(now3 + ((v.cache.until - now3) % 6e4 || 6e4) + 20);
  if (v.tip && v.tip.until > now3) due.push(v.tip.until + 20);
  if (!due.length) return;
  const soonest = Math.min(...due);
  if (tickDue > now3 && tickDue <= soonest) return;
  tickDue = soonest;
  try {
    $.clock.after(Math.max(16, soonest - now3), () => {
      tickDue = 0;
      $.ui.invalidate("ui.render");
    });
  } catch {
  }
}
function registerUi(on) {
  on("config.set", ($, setting, proceed) => {
    try {
      if (setting.key === "theme") {
        configTheme = String(setting.value);
        $.ui.invalidate("ui.render");
      }
    } catch {
    }
    return proceed(setting);
  });
  on("command.run", { command: "automode" }, async ($, e) => {
    try {
      const v = await snapshotView($);
      if (!v) return { text: "AutoMode is starting." };
      const now3 = Date.now();
      const { sub } = parse(e.args);
      const name = resolve3(sub);
      if (!name) return { text: unknownText(sub) };
      const head = barText(barSegments(v, 200, now3));
      switch (name) {
        case "help":
          return { text: helpText() };
        case "details":
          return { text: `${head}
${detailsText(v, now3)}` };
        case "setup":
          return { text: setupText(v, await cmdFacts($)) };
        case "settings":
          return { text: settingsText(v, await cmdFacts($)) };
        case "debug":
          return { text: debugText(v, await cmdFacts($), now3) };
        case "on":
        case "off": {
          const wantOn = name === "on";
          if (wantOn !== (v.router.mode === "off")) return { text: `Routing is already ${wantOn ? "on" : "off"} for this session.` };
          return { text: await toggleRouting($) };
        }
        default:
          return { text: `${head}${v.alert ? `
${v.alert.title}. ${v.alert.line}` : ""}${lastUiError ? `
UI: the last drawing fell back to Claude Code's own (${lastUiError})` : ""}` };
      }
    } catch (err) {
      return { text: `AutoMode: ${String(err?.message ?? err).slice(0, 160)}` };
    }
  });
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    try {
      if (e.props.hasSurvey || await uiDisabled($)) return next(e);
      const v = await read($, viewAtom2);
      if (!v) {
        try {
          $.clock.after(20, () => {
            void publish($);
          });
        } catch {
        }
        ;
        return next(e);
      }
      const o = uiOptions(currentOptions(), storedOptions());
      let now3 = Date.now();
      try {
        now3 = await $.clock.now();
      } catch {
      }
      const c = {
        els: $.ui.resolve(e),
        t: tokensFor(appearanceOf(o.appearance, await themeOf($)), o.theme),
        now: now3,
        surface: String(e.surface),
        term: e.surface === "terminal",
        cols: Number(e.props?.bodyColumns ?? e.viewport?.columns ?? 80) || 80
      };
      const { Box } = c.els;
      scheduleTick($, now3, v);
      return /* @__PURE__ */ h(Box, { key: "hm-col", flexDirection: "column" }, v.alert ? drawAlert(c, v.alert) : drawTip(c, v), drawBar($, c, v, o.metrics, o.layout === "minimal"));
    } catch (err) {
      lastUiError = `band: ${String(err?.message ?? err).replace(/\s+/g, " ").slice(0, 200)}`;
      return next(e);
    }
  });
}

// hooks/register.ts
var DEFAULTS = {
  router: "judge",
  pickerModel: "claude-sonnet-5-5[1m]",
  workflowName: "automode:run",
  standardMode: "discover",
  reviewPolicy: "risk",
  maxConcurrency: 1,
  judgeModel: "haiku",
  judgeTimeoutMs: 4e3,
  fallbackEffort: "medium",
  compactWith: "haiku",
  compactModel: "claude-haiku-5-5",
  saveModePercent: 80,
  cacheTtlMinutes: 60,
  heavyChatTokens: 6e4,
  debugLog: false,
  blockGitWritesWhenActive: true
};
var PATHS = ["chat", "change", "review", "workflow"];
var JUDGE_EFFORTS = ["low", "medium", "high"];
var ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
var HIGH_RISK = [
  { reason: "security or credentials", text: /\b(security (review|fix|issue|vulnerabilit\w+)|cve-\d+|(oauth|auth\w*|login|sso|saml|jwts?|session) (flows?|logic|scopes?|tokens?|middleware|bypass|handling|checks?)|credentials? (handling|storage|rotation|leaks?)|(stor\w*|handl\w*|sav\w*|load\w*) (the |user |api )?credentials?|rotat\w* (the )?(\w+ )?(keys?|secrets?|credentials?|tokens?)|passwords? (hashing|storage|reset)|reset (the |user )?passwords?|(check\w*|enforc\w*|chang\w*) (the |user )?permissions?|verif\w* (the )?signatures?|refresh (the |access )?tokens?|encrypt\w*|decrypt\w*|permission (checks?|model)|rbac|acls?)\b/i },
  { reason: "data migration or destructive operation", text: /\b((data|schema|database|db) migrations?|migrat\w* (the )?(data|database|schema|users|tables?)|schema changes?|drop (tables?|columns?)|truncat\w* (the )?tables?|backfill\w*|delete (all|the) (data|records|rows))\b/i },
  { reason: "concurrency", text: /\b(race conditions?|deadlocks?|data races?|thread[- ]safe\w*|concurrent (access|writes?|calls?|requests)|mutex(es)?|from (several|multiple|many) goroutines|goroutines? (leaks?|safety)|lock ordering)\b/i },
  { reason: "externally visible contract", text: /\b(public apis?|breaking changes?|api contracts?|wire formats?|protocol changes?|sdk interfaces?)\b/i },
  { reason: "payments or sensitive data", text: /\b(payments?|billing (logic|calculation|code)|invoic\w+|pii|gdpr|personal data)\b/i }
];
var FOLLOW_UP2 = /^(go( ahead)?|ok(ay)?|yes( please)?|y|yep|sure|continue|proceed|do it|next|lgtm|sounds good|thanks?|thank you)[.!\s]*$/i;
var NAMED_EFFORT = /\b(?:(low|medium|high|xhigh|max)(?:imum)? effort|effort[:=]?\s*(low|medium|high|xhigh|max))\b/gi;
var BLOCKED = [
  /\bgit\s+(commit|push|merge|rebase|cherry-pick|revert|am|tag)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /\bgit\s+checkout\s+(--\s|\.\s*$|-f\b)/,
  /\bgit\s+restore\b(?!.*--staged)/,
  /\bgit\s+stash\s+(drop|clear)\b/,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+worktree\s+remove\b/,
  /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/
];
var JUDGE_SYSTEM2 = `You route one message in a coding assistant session. Pick the cheapest path and effort that still get it right.
Paths:
- chat: questions, explanations, research, and writing that is not saved in the repository (messages, MR text, plans). Editing any file in the repository, docs included, is a change.
- change: a code change with a clear goal (the files, the behavior, or the fix are clear). Sonnet does it alone.
- review: a clear code change that touches security, credentials, data migration, destructive operations, concurrency, a public contract, or payments. Sonnet does it, then Opus reviews it.
- workflow: open-ended work only: no clear spec, a design choice across several modules, or a large refactor. A multi-agent workflow plans it on Opus. It is the most expensive path; never pick it for a clear change, and never for a bug or a failing or flaky test, however hard: that is change with high effort.
Effort:
- low: lookups, renames, short answers, and small mechanical edits in one or two files (a constant, a config value, a typo, an import, a flag). When a small edit is clear, pick low.
- medium: normal features and fixes.
- high: hard debugging, subtle correctness, cross-module reasoning.
A message typed while a turn runs usually steers that task: keep its path unless it starts new work.
Reply with JSON only: {"path":"chat|change|review|workflow","effort":"low|medium|high","why":"at most 8 words"}`;
function risksOf(text) {
  const words = text.replace(/\S+\.[A-Za-z]{1,5}\b/g, " ");
  return HIGH_RISK.filter((r) => r.text.test(words)).map((r) => r.reason);
}
function namedEffort(text) {
  for (const m of text.matchAll(NAMED_EFFORT)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 20), m.index).toLowerCase();
    if (/\b(not|no|don'?t|never|without|instead of)\b/.test(before)) continue;
    return (m[1] ?? m[2]).toLowerCase();
  }
  return void 0;
}
function parseVerdict2(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (!PATHS.includes(j.path) || !JUDGE_EFFORTS.includes(j.effort)) return null;
    return { path: j.path, effort: j.effort, why: String(j.why ?? "").slice(0, 80) };
  } catch {
    return null;
  }
}
function applyRules(v, risks, cfg2) {
  if (cfg2.reviewPolicy === "never") return v.path === "review" ? { ...v, path: "change" } : v;
  let out = v;
  if (risks.length && out.path === "change") out = { ...out, path: "review", why: `${out.why}; risk: ${risks.join(", ")}` };
  if (cfg2.reviewPolicy === "always" && out.path === "change") out = { ...out, path: "review" };
  return out;
}
function capEffort(effort, limitPercent, cfg2) {
  if (limitPercent === null || limitPercent < cfg2.saveModePercent) return effort;
  return ALL_EFFORTS.indexOf(effort) > ALL_EFFORTS.indexOf("medium") ? "medium" : effort;
}
var REVIEW_CALL = 'After your checks pass, call the Agent tool with subagent_type "automode:reviewer" and run_in_background set to false (it runs on Opus; wait for it). Give it the original request, the acceptance criteria you used, each check command with its output, and the changed files. Fix every blocker it reports, run the checks again, and do not call the reviewer a second time. Do not act on non-blocking notes; list them in your reply.';
function contextFor(v, cfg2, risks, sourceVersion2) {
  const head = `[AutoMode: ${v.path}, effort ${v.effort}${v.why ? ` (${v.why})` : ""}]`;
  const checks = "Do it yourself and read only the code you need. Before you call it done, run the relevant tests or build and show that they pass. Never report a change as done without a passing check.";
  const commit = "Commit or push only when the user asks you to.";
  switch (v.path) {
    case "chat":
      return null;
    case "change":
      return `${head}
${checks}
${commit}`;
    case "review":
      return `${head}
${checks}
${REVIEW_CALL}
${commit}`;
    case "workflow": {
      const tier = risks.length ? "critical" : "complex";
      const call = `Workflow({ name: "${cfg2.workflowName}", args: { task: "<the full task with every constraint>", tier: "${tier}", mode: "${cfg2.standardMode}", reviewPolicy: "${cfg2.reviewPolicy}", maxConcurrency: ${Number(cfg2.maxConcurrency) || 1}, source_version: "${sourceVersion2}" } })`;
      return `${head}
This is open-ended work. Run ${call}
Until it returns, do not implement it yourself. Then report the changed files, the verification, the review findings, and open risks.
${commit}`;
    }
  }
}
var cacheSafe = (model) => /(sonnet|opus)-5-5/.test(model);
var cfg = DEFAULTS;
var sourceVersion = "unknown";
var current = null;
var loaded = false;
var autoEffort = true;
var appEffort;
var toldJudgeDown = false;
var toldSaveMode = false;
var lastAnswerAt = null;
var lastAnswerText = "";
var coldHintAt = 0;
async function load2($) {
  loaded = true;
  try {
    cfg = { ...DEFAULTS, ...JSON.parse(await fsRead($, `${$.plugin.root}/config.json`)) };
  } catch {
    cfg = DEFAULTS;
  }
  try {
    sourceVersion = JSON.parse(await fsRead($, `${$.plugin.root}/.claude-plugin/plugin.json`)).version || "unknown";
  } catch {
  }
}
async function active($) {
  if (!loaded) await load2($);
  if (cfg.router !== "judge") return false;
  try {
    return (await $.session.model()).trim() === cfg.pickerModel;
  } catch {
    return false;
  }
}
async function debug($, entry) {
  if (!cfg.debugLog) return;
  const file = `${$.plugin.root}/judge-log.jsonl`;
  try {
    let before = "";
    try {
      before = await fsRead($, file);
    } catch {
    }
    await fsWrite($, file, before + JSON.stringify({ at: await $.clock.now(), ...entry }) + "\n");
  } catch {
  }
}
async function limitShare($) {
  try {
    const shares = (await sessionUsage($)).rateLimits.map((r) => r.percentUsed).filter((n) => Number.isFinite(n));
    return shares.length ? Math.max(...shares) : null;
  } catch {
    return null;
  }
}
async function coldHint($) {
  if (lastAnswerAt === null) return null;
  try {
    const now3 = await $.clock.now();
    const idleMin = (now3 - lastAnswerAt) / 6e4;
    if (idleMin < cfg.cacheTtlMinutes || coldHintAt > lastAnswerAt) return null;
    const usage = await sessionUsage($);
    const tokens = usage.context.tokens ?? 0;
    if (tokens < cfg.heavyChatTokens) return null;
    const live = (await $.agent.list()).filter((a) => a.status === "pending" || a.status === "running" || a.status === "waiting");
    if (live.length) return null;
    coldHintAt = now3;
    return `AutoMode: the prompt cache went cold (${Math.round(idleMin)} min idle), so this message re-writes about ${Math.round(tokens / 1e3)}k tokens. Next time, /compact before a long break.`;
  } catch {
    return null;
  }
}
async function routePrompt($, e, next) {
  if (await useV4($)) return v4PromptSubmit($, e, next);
  const text = e.text.trim();
  const byPerson = e.origin.kind === "composer" || e.origin.kind === "bridge" || e.origin.kind === "sdk";
  if (!byPerson || e.command || e.isMeta || text.startsWith("/") || text.startsWith("!")) return next(e);
  if (!await active($)) return next(e);
  const hint = await coldHint($);
  if (hint) $.ui.toast(hint);
  const risks = risksOf(text);
  const named = namedEffort(text);
  const midTurn = e.turnId !== void 0;
  const attachments = e.attachments?.length ?? 0;
  let v;
  if (/^am:direct\b/i.test(text)) v = { path: "change", effort: named ?? cfg.fallbackEffort, why: "user asked: direct", by: "user" };
  else if (/^am:run\b/i.test(text)) v = { path: "workflow", effort: named ?? "high", why: "user asked: workflow", by: "user" };
  else if (current && !attachments && FOLLOW_UP2.test(text)) v = { ...current, by: "follow-up" };
  else {
    const recent = lastAnswerText ? `Last reply (start): ${lastAnswerText.slice(0, 600)}
` : "";
    const state = `${current ? `Previous verdict: ${current.path}, ${current.effort}.
` : ""}${midTurn ? "Typed while a turn is running.\n" : ""}${attachments ? `With ${attachments} attachment(s), such as a screenshot.
` : ""}`;
    const asked = `${recent}${state}Message:
${text.slice(0, 4e3)}`;
    const r = await $.model.complete({ model: cfg.judgeModel, system: JUDGE_SYSTEM2, prompt: asked, maxTokens: 120, effort: "low", timeoutMs: cfg.judgeTimeoutMs });
    const parsed = r.isAnswered ? parseVerdict2(r.text) : null;
    if (parsed) v = { ...parsed, by: "judge" };
    else {
      v = { path: "change", effort: cfg.fallbackEffort, why: "judge unavailable", by: "fallback" };
      if (!toldJudgeDown) {
        toldJudgeDown = true;
        $.ui.toast(`AutoMode: the Haiku judge did not answer (${r.isAnswered ? "unreadable reply" : "reason" in r ? r.reason : "no answer"}). Prompts run on Sonnet at ${cfg.fallbackEffort} effort until it does.`);
      }
    }
    if (named) v = { ...v, effort: named, by: "named" };
    await debug($, { ev: "judge", ok: Boolean(parsed), reply: r.isAnswered ? r.text.slice(0, 200) : null, usage: r.isAnswered ? r.usage : null });
  }
  if (v.by !== "user") v = applyRules(v, risks, cfg);
  const capped = capEffort(v.effort, await limitShare($), cfg);
  if (capped !== v.effort) {
    if (!toldSaveMode) {
      toldSaveMode = true;
      $.ui.toast(`AutoMode save mode: a usage limit is past ${cfg.saveModePercent}%, so effort is capped at medium.`);
    }
    v = { ...v, effort: capped };
  }
  current = v;
  $.ui.status(`AutoMode: ${v.path} · ${autoEffort ? v.effort : "your effort"}`);
  await debug($, { ev: "verdict", path: v.path, effort: v.effort, why: v.why, by: v.by, risks, midTurn, attachments });
  const context = contextFor(v, cfg, risks, sourceVersion);
  return next(context ? { ...e, context: [...e.context ?? [], context] } : e);
}
export const register = (on, options2) => {
  setOptions(options2);
  setSources({ router: v4Snapshot, guardian: guardianSnapshot });
  on("session.start", async ($, e, next) => guardianSessionStart($, e, async (e2) => {
    await load2($);
    return await useV4($) ? v4SessionStart($, e2, next) : next(e2);
  }).then(async (res) => {
    await uiSessionStart($);
    return res;
  }));
  on("prompt.submit", async ($, e, next) => guardianPromptSubmit($, e, (e2) => routePrompt($, e2, next))).catch(($, e, next) => next(e));
  on("turn.step", async function* ($, e, next) {
    try {
      await guardianStep($, e);
    } catch {
    }
    if (await useV4($)) return yield* v4TurnStep($, e, next);
    if (e.agentId !== void 0 || !await active($)) return yield* next(e);
    if (typeof e.effort === "string") {
      if (appEffort !== void 0 && e.effort !== appEffort && autoEffort) {
        autoEffort = false;
        $.ui.toast(`AutoMode: you set effort to ${e.effort}, so Auto effort is off for this session.`);
      }
      appEffort = e.effort;
    }
    const effort = autoEffort && current && cacheSafe(e.model) && e.effort !== void 0 ? current.effort : void 0;
    const answer = yield* next(effort ? { ...e, effort } : e);
    try {
      lastAnswerAt = await $.clock.now();
    } catch {
    }
    if (answer?.answer) lastAnswerText = answer.answer;
    return answer;
  });
  on("session.compact", async ($, e, next) => {
    if (await useV4($)) return v4Compact($, e, next);
    if (e.agentId !== void 0 || cfg.compactWith !== "haiku" || !await active($)) return next(e);
    if (e.trigger === "precompute") return { skip: "AutoMode compacts with Haiku when it is time" };
    const messages = Array.isArray(e.messages) && e.messages.length ? e.messages : await $.session.messages().catch(() => []);
    const transcript = transcriptOf2(messages);
    const r = await $.model.complete({
      model: cfg.compactModel,
      system: COMPACT_SYSTEM2,
      maxTokens: 16e3,
      effort: "medium",
      timeoutMs: 24e4,
      prompt: `${transcript}

---
Write the summary now.${e.instructions?.trim() ? `
The user asked the summary to keep or stress: ${e.instructions.trim()}` : ""}`
    }).catch(() => null);
    if (!r || !r.isAnswered || r.text.trim().length < 200) {
      $.ui.toast("AutoMode: Haiku could not write the summary, so the chat's own model compacts.");
      return next(e);
    }
    await debug($, { ev: "compact", chars: transcript.length, usage: r.usage });
    return {
      messages: [{
        role: "user",
        text: `This session continues from an earlier conversation that ran out of context. The summary below, written by Haiku for AutoMode, covers it.

${r.text.trim()}

Continue from where it left off without asking the user further questions.`,
        toolUses: []
      }]
    };
  }).catch(($, e, next) => next(e));
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    if (await useV4($)) return v4ToolCall($, e, next);
    if (!cfg.blockGitWritesWhenActive || e.agentId === void 0) return next(e);
    if (!await active($)) return next(e);
    if (!BLOCKED.some((re) => re.test(e.command))) return next(e);
    return { deny: "AutoMode agents do not run git writes or destructive commands. Leave the changes in the working tree for the user to review." };
  }).catch(($, e, next) => next.called ? next(e) : { deny: "AutoMode guard failed; the call was not run." });
  on("turn.complete", async ($, e, next) => guardianTurnComplete($, e, async (e2) => await useV4($) ? v4TurnComplete($, e2, next) : next(e2))).catch(($, e, next) => next(e));
  on("agent.spawn", async ($, e, next) => await useV4($) ? v4AgentSpawn($, e, next) : next(e)).catch(($, e, next) => next(e));
  on("prompt.attachment", async ($, e, next) => await useV4($) ? v4Attachment($, e, next) : next(e)).catch(($, e, next) => next(e));
  on("session.append", async ($, e, next) => await useV4($) ? v4Append($, e, next) : next(e)).catch(($, e, next) => next(e));
  on("command.run", { command: "model" }, ($, e, next) => v4CommandRun($, e, next));
  on("command.run", { command: "effort" }, ($, e, next) => v4CommandRun($, e, next));
  for (const tool of ["Agent", "Workflow", "Read", "Grep", "Glob", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch"]) {
    on("tool.call", { tool }, async ($, e, next) => await useV4($) ? v4ToolCall($, e, next) : next(e)).catch(($, e, next) => next.called ? next(e) : { deny: "AutoMode guard failed; the call was not run." });
  }
  on("tool.call", { tool: "mcp__automode__extract" }, ($, e) => v4Extract($, e)).catch(() => ({ deny: "AutoMode extract failed. Read the lines you need with offset and limit." }));
  on("classic.Stop", async ($, e, next) => await useV4($) ? v4Stop($, e, next) : next(e)).catch(($, e, next) => next(e));
  on("session.end", ($, e, next) => guardianSessionEnd($, e, next)).catch(($, e, next) => next(e));
  registerUi(on);
  on("turn.start", ($, e, next) => guardianTurnStart($, e, next)).catch(($, e, next) => next(e));
  on("tool.call", ($, e, next) => guardianToolCall($, e, next)).catch(($, e, next) => next.called ? { deny: "AutoMode guardian failed after the call; its result is lost. Run it again if needed." } : next(e));
};
