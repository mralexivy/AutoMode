// Operations: what a command does, as opposed to what a prompt says about it. A force push, a dropped table or a
// `terraform apply` is hard evidence of consequence, because it acts on something a repair cannot get back. The caller
// reads this on each Bash command, and on a command the person put in backticks.
//
// A rule reads the tool at the start of a simple command, with quoted arguments gone: a commit message that says
// "kubectl delete" runs nothing. SQL is the one exception, because the statement is the quoted part or the piped part,
// so SQL rules read the raw line and need a SQL client on it.
//
// It classifies; it never blocks. Blocking stays in the tool guards (lib/guard.ts).
import { tools } from './shell.ts'

export type OperationKind = 'force-push' | 'remote-delete' | 'history-rewrite' | 'destructive-sql' | 'migration-reset' | 'infrastructure' | 'cluster' | 'cloud-delete' | 'data-store' | 'filesystem' | 'publish'
export interface Operation { kind: OperationKind; reason: string; production: boolean }

const GIT = String.raw`^git(?:\s+-\S+(?:=\S+|\s+[^-\s]\S*)?)*\s+`

const RULES: { kind: OperationKind; reason: string; re: RegExp }[] = [
  { kind: 'force-push', reason: 'force push', re: new RegExp(`${GIT}push\\b.*(\\s--force(-with-lease|-if-includes)?\\b|\\s-[a-zA-Z]*f\\b|\\s\\+\\S+)`) },
  { kind: 'remote-delete', reason: 'remote branch or tag deleted', re: new RegExp(`${GIT}push\\b.*(\\s--delete\\b|\\s-d\\b|\\s--mirror\\b|\\s:\\S+)`) },
  { kind: 'history-rewrite', reason: 'history rewrite', re: new RegExp(`${GIT}(filter-branch|filter-repo)\\b`) },
  { kind: 'destructive-sql', reason: 'database dropped', re: /^(dropdb\b|mysqladmin\b.*\bdrop\b)/ },
  { kind: 'migration-reset', reason: 'migration reset or rollback', re: /^prisma\s+(migrate\s+reset|db\s+push\b.*--accept-data-loss)|^(rails|rake)\s+db:(drop|reset|rollback|schema:load)\b|^alembic\s+downgrade\b|^flyway\s+clean\b|^(python[\d.]*\s+)?(\S+\/)?manage\.py\s+flush\b|^knex\s+migrate:rollback\b/ },
  { kind: 'infrastructure', reason: 'infrastructure change', re: /^(terraform|tofu|terragrunt)\b.*\s(apply|destroy|import|taint)\b|^pulumi\s+(up|destroy)\b|^cdk\s+(deploy|destroy)\b/ },
  { kind: 'cluster', reason: 'cluster change', re: /^kubectl\b.*\s(delete|drain|apply|replace|patch|rollout\s+undo|scale)\b|^helm\b.*\s(uninstall|delete|upgrade|rollback)\b/ },
  { kind: 'cloud-delete', reason: 'cloud resource deleted', re: /^aws\b.*\s(s3\s+(rm|rb)\b|[\w-]*delete-[\w-]+|terminate-instances\b)|^(gcloud|az)\b.*\s(delete|purge)\b|^gsutil\b.*\s(rm|rb)\b/ },
  { kind: 'data-store', reason: 'data store wiped', re: /^redis-cli\b.*\bflush(all|db)\b|^docker\s+volume\s+(rm|prune)\b|^docker\s+system\s+prune\b/i },
  { kind: 'filesystem', reason: 'disk destroyed', re: /^mkfs(\.\w+)?\s|^dd\b.*\bof=\/dev\// },
  { kind: 'publish', reason: 'package or release published', re: /^(npm|pnpm|yarn|cargo|gem)\s+publish\b|^twine\s+upload\b|^gh\s+release\s+create\b|^gh\s+repo\s+delete\b/ },
]

const SQL_CLIENT = /^(psql|mysql|mariadb|sqlite3|sqlcmd|clickhouse-client|cqlsh|bq\s+query)\b|^(docker(-compose)?|kubectl|ssh)\b.*\b(psql|mysql|mariadb|sqlite3)\b/
const DESTRUCTIVE_SQL = /\bdrop\s+(table|database|schema|column)\b|\btruncate\s+(table\s+)?[\w"`]|\balter\s+table\b.*\bdrop\b|\bdelete\s+from\s+[\w."`]+\s*(?:;|"|'|$)|\bupdate\s+[\w."`]+\s+set\b(?![^;]*\bwhere\b)/im
const MONGO_DROP = /^(mongo|mongosh)\b.*\bdropDatabase\s*\(/

const PRODUCTION_WORD = /\b(prod|prd|production)\b/i
const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g
const LONGEST_COMMAND = 8_000 // the rules read one line; a longer one is data, and capping it bounds the regex work

// rmDestroysRoot: `rm` with a recursive flag, in any spelling, on the bare root, a top-level directory, the home
// folder or the whole working directory. A path below those is ordinary cleanup.
const ROOT_TARGET = /^(\/|\/\*|~\/?|~\/\*|\$HOME\/?|\$\{HOME\}\/?|\*|\/(etc|usr|var|home|Users|opt|bin|sbin|lib|boot|root)\/?(\*)?)$/
function rmDestroysRoot(command: string): boolean {
  const [tool, ...args] = command.split(/\s+/)
  if (tool !== 'rm') return false
  const end = args.indexOf('--')
  const flags = (end < 0 ? args : args.slice(0, end)).filter((a) => a.startsWith('-'))
  const targets = end < 0 ? args.filter((a) => !a.startsWith('-')) : [...args.slice(0, end).filter((a) => !a.startsWith('-')), ...args.slice(end + 1)]
  const recursive = flags.some((f) => f === '--recursive' || /^-[a-zA-Z]*[rR]/.test(f))
  return recursive && targets.some((t) => ROOT_TARGET.test(t.replace(/^["']|["']$/g, '')))
}

// productionTarget: the text names something live as the thing acted on. "production-ready" or a "production build"
// names no target. The caller gates on intent: a question about prod changes nothing.
export function productionTarget(text: string): boolean {
  return /\bprod(uction)?[ -](database|db|cluster|servers?|environment|env|bucket|deployment|data|instance|infra\w*|secrets?|tables?)\b/i.test(text)
    || /\b(in|on|against|into|to|from)\s+(the\s+)?(live\s+)?prod(uction)?\b(?![- ](ready|build|grade|quality))/i.test(text)
}

// classifyOperation reads a Bash line. `sql: true`: the text is a command the person spelled out, so a bare statement
// needs no client on the line.
export function classifyOperation(command: string, o: { sql?: boolean } = {}): Operation | null {
  const line = command.slice(0, 200_000)
  const parts = tools(line).map((t) => t.slice(0, LONGEST_COMMAND))
  for (const t of parts) {
    const production = PRODUCTION_WORD.test(t)
    if (rmDestroysRoot(t)) return { kind: 'filesystem', reason: 'root files destroyed', production }
    if (MONGO_DROP.test(t)) return { kind: 'data-store', reason: 'data store wiped', production }
    const bare = t.replace(QUOTED, '""')
    for (const r of RULES) if (r.re.test(bare)) return { kind: r.kind, reason: r.reason, production }
  }
  if ((o.sql || parts.some((t) => SQL_CLIENT.test(t))) && DESTRUCTIVE_SQL.test(line)) return { kind: 'destructive-sql', reason: 'destructive SQL', production: PRODUCTION_WORD.test(line) }
  return null
}
