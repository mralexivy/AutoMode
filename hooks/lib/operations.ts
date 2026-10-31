// Operations: what a command does, as opposed to what a prompt says about it. A force push, a dropped table or a
// `terraform apply` is hard evidence of consequence, because it acts on something a repair cannot get back. The caller
// reads this on each Bash command. It also reads a command the person spelled out in a prompt.
//
// It classifies; it never blocks. Blocking stays in the tool guards (lib/guard.ts).
import { simpleCommands, unwrapped } from './shell.ts'

export type OperationKind = 'force-push' | 'remote-delete' | 'history-rewrite' | 'destructive-sql' | 'migration-reset' | 'infrastructure' | 'cluster' | 'cloud-delete' | 'data-store' | 'filesystem' | 'publish'
export interface Operation { kind: OperationKind; reason: string; production: boolean }

const SQL_CLIENT = /\b(psql|mysql|mariadb|sqlite3|sqlcmd|clickhouse-client|cqlsh|bq\s+query)\b/

const RULES: { kind: OperationKind; reason: string; re: RegExp }[] = [
  { kind: 'force-push', reason: 'force push', re: /\bgit\b.*\bpush\b.*(\s--force(-with-lease|-if-includes)?\b|\s-[a-zA-Z]*f\b|\s\+\S+)/ },
  { kind: 'remote-delete', reason: 'remote branch or tag deleted', re: /\bgit\b.*\bpush\b.*(\s--delete\b|\s-d\b|\s--mirror\b|\s:\S+)/ },
  { kind: 'history-rewrite', reason: 'history rewrite', re: /\bgit\s+(filter-branch|filter-repo)\b/ },
  { kind: 'destructive-sql', reason: 'destructive SQL', re: /\bdrop\s+(table|database|schema|column)\b|\btruncate\s+table\b|\balter\s+table\b.*\bdrop\b/i },
  { kind: 'destructive-sql', reason: 'destructive SQL', re: /\bTRUNCATE\s+[A-Za-z_"`]|\bDELETE\s+FROM\s+[\w."`]+\s*(?:;|"|'|$)|\bUPDATE\s+[\w."`]+\s+SET\b(?![^;]*\bWHERE\b)/ },
  { kind: 'destructive-sql', reason: 'database dropped', re: /^(dropdb|mysqladmin\s+.*\bdrop)\b/ },
  { kind: 'migration-reset', reason: 'migration reset or rollback', re: /\bprisma\s+(migrate\s+reset|db\s+push\b.*--accept-data-loss)|\b(rails|rake)\s+db:(drop|reset|rollback|schema:load)\b|\balembic\s+downgrade\b|\bflyway\s+clean\b|\bmanage\.py\s+flush\b|\bknex\s+migrate:rollback\b/ },
  { kind: 'infrastructure', reason: 'infrastructure change', re: /\b(terraform|tofu|terragrunt)\b.*\s(apply|destroy|import|taint)\b|\bpulumi\s+(up|destroy)\b|\bcdk\s+(deploy|destroy)\b/ },
  { kind: 'cluster', reason: 'cluster change', re: /\bkubectl\b.*\s(delete|drain|apply|replace|patch|rollout\s+undo|scale)\b|\bhelm\b.*\s(uninstall|delete|upgrade|rollback)\b/ },
  { kind: 'cloud-delete', reason: 'cloud resource deleted', re: /\baws\b.*\s(s3\s+(rm|rb)\b|[\w-]*delete-[\w-]+|terminate-instances\b)|\b(gcloud|az)\b.*\s(delete|purge)\b|\bgsutil\b.*\s(rm|rb)\b/ },
  { kind: 'data-store', reason: 'data store wiped', re: /\bredis-cli\b.*\bflush(all|db)\b|\bdropDatabase\s*\(|\bdocker\s+volume\s+(rm|prune)\b|\bdocker\s+system\s+prune\b/i },
  { kind: 'filesystem', reason: 'disk or root files destroyed', re: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*f?[a-zA-Z]*\s+(--\s+)?("?\/(\s|"|\*|$)|"?\/(etc|usr|var|home|Users|opt|bin)\b|~|"?\$HOME|\*)|\bmkfs(\.\w+)?\s|\bdd\b.*\bof=\/dev\//i },
  { kind: 'publish', reason: 'package or release published', re: /\b(npm|pnpm|yarn|cargo|gem)\s+publish\b|\btwine\s+upload\b|\bgh\s+release\s+create\b|\bgh\s+repo\s+delete\b/ },
]

// A line that only prints, reads or searches text acts on nothing, whatever the text says.
const READS_ONLY = /^(echo|printf|cat|grep|egrep|rg|ag|less|more|head|tail|ls|man|which|git\s+(log|show|diff|grep|blame|status))\b/

const PRODUCTION_WORD = /\b(prod|prd|production)\b/i

// productionTarget: the text names something live as the thing acted on. "production-ready" or a "production build"
// names no target. The caller gates on intent: a question about prod changes nothing.
export function productionTarget(text: string): boolean {
  return /\bprod(uction)?[ -](database|db|cluster|servers?|environment|env|bucket|deployment|data|instance|infra\w*|secrets?|tables?)\b/i.test(text)
    || /\b(in|on|against|into|to|from)\s+(the\s+)?(live\s+)?prod(uction)?\b(?![- ](ready|build|grade|quality))/i.test(text)
}

export function classifyOperation(command: string): Operation | null {
  for (const part of simpleCommands(command)) {
    const s = unwrapped(part)
    if (READS_ONLY.test(s)) continue
    for (const r of RULES) if (r.re.test(s)) return { kind: r.kind, reason: r.reason, production: PRODUCTION_WORD.test(s) }
    // Lowercase SQL needs a SQL client on the same line: "delete from the list" in a prompt is English.
    if (SQL_CLIENT.test(s) && (/\bdelete\s+from\s+[\w."`]+\s*(?:;|"|'|$)/i.test(s) || /\bupdate\s+[\w."`]+\s+set\b(?![^;]*\bwhere\b)/i.test(s))) return { kind: 'destructive-sql', reason: 'destructive SQL', production: PRODUCTION_WORD.test(s) }
  }
  return null
}
