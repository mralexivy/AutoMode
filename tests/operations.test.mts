// Operations and hard evidence (lib/operations.ts, lib/consequence.ts): a high-recall corpus of irreversible commands,
// a corpus of look-alikes, and the audit's false positives and false negatives.
import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyOperation, productionTarget } from '../hooks/lib/operations.ts'
import { assess, textConsequence } from '../hooks/lib/consequence.ts'
import { prospectiveRisk, reviewerFamily, reviewNeeded } from '../hooks/lib/risk.ts'

const OPERATIONS: [string, string][] = [
  ['git push --force', 'force-push'], ['git push -f origin main', 'force-push'], ['git push --force-with-lease', 'force-push'], ['git push origin +main', 'force-push'], ['cd repo && git push -uf origin x', 'force-push'],
  ['git push origin --delete old', 'remote-delete'], ['git push origin :old', 'remote-delete'], ['git filter-repo --path x', 'history-rewrite'], ['git filter-branch --tree-filter x', 'history-rewrite'],
  ['psql -c "DROP TABLE users"', 'destructive-sql'], ['psql -c "drop table users"', 'destructive-sql'], ['mysql -e "DROP DATABASE app"', 'destructive-sql'], ['psql -c "TRUNCATE users"', 'destructive-sql'], ['psql -c "truncate table users"', 'destructive-sql'],
  ['psql -c "DELETE FROM users"', 'destructive-sql'], ['sqlite3 app.db "delete from users"', 'destructive-sql'], ['psql -c "UPDATE users SET admin = true"', 'destructive-sql'], ['psql -c "ALTER TABLE users DROP COLUMN email"', 'destructive-sql'], ['dropdb app', 'destructive-sql'],
  ['npx prisma migrate reset', 'migration-reset'], ['prisma db push --accept-data-loss', 'migration-reset'], ['rails db:drop', 'migration-reset'], ['bundle exec rake db:reset', 'migration-reset'], ['alembic downgrade -1', 'migration-reset'], ['python manage.py flush', 'migration-reset'],
  ['terraform apply', 'infrastructure'], ['terraform apply -auto-approve', 'infrastructure'], ['terraform destroy', 'infrastructure'], ['terraform -chdir=infra apply', 'infrastructure'], ['tofu apply', 'infrastructure'], ['terragrunt run-all apply', 'infrastructure'], ['pulumi up', 'infrastructure'], ['cdk deploy', 'infrastructure'],
  ['kubectl delete pod x', 'cluster'], ['kubectl -n prod delete deployment api', 'cluster'], ['kubectl apply -f x.yaml', 'cluster'], ['kubectl drain node-1', 'cluster'], ['kubectl rollout undo deploy/api', 'cluster'], ['kubectl scale deploy api --replicas=0', 'cluster'], ['helm uninstall api', 'cluster'], ['helm upgrade api ./chart', 'cluster'],
  ['aws s3 rm s3://b --recursive', 'cloud-delete'], ['aws s3 rb s3://b', 'cloud-delete'], ['aws rds delete-db-instance --x', 'cloud-delete'], ['aws ec2 terminate-instances --instance-ids i', 'cloud-delete'], ['gcloud sql instances delete x', 'cloud-delete'], ['az group delete -n x', 'cloud-delete'], ['gsutil rm -r gs://b', 'cloud-delete'],
  ['redis-cli FLUSHALL', 'data-store'], ['redis-cli -h x flushdb', 'data-store'], ['mongosh --eval "db.dropDatabase()"', 'data-store'], ['docker volume rm db', 'data-store'], ['docker system prune -a', 'data-store'],
  ['rm -rf /', 'filesystem'], ['rm -rf ~', 'filesystem'], ['rm -rf $HOME', 'filesystem'], ['rm -rf /etc/nginx', 'filesystem'], ['rm -fr *', 'filesystem'], ['dd if=/dev/zero of=/dev/sda', 'filesystem'], ['mkfs.ext4 /dev/sdb', 'filesystem'],
  ['npm publish', 'publish'], ['cargo publish', 'publish'], ['twine upload dist/*', 'publish'], ['gh release create v1', 'publish'], ['gh repo delete x', 'publish'],
  ['FOO=1 timeout 60 terraform apply', 'infrastructure'], ['bash -lc x; kubectl delete pod y', 'cluster'],
]
const SAFE = [
  'git push', 'git push origin main', 'git push -u origin feature/force', 'git log --force', 'git status', 'terraform plan', 'terraform validate', 'terraform fmt', 'kubectl get pods', 'kubectl describe pod x', 'kubectl logs api', 'helm list', 'helm template x',
  'psql -c "SELECT 1"', 'psql -c "DELETE FROM users WHERE id = 1"', 'psql -c "UPDATE users SET a = 1 WHERE id = 1"', 'aws s3 ls', 'aws s3 cp a s3://b', 'gcloud config list', 'rm -rf node_modules', 'rm -rf build dist', 'rm -f a.txt', 'docker ps', 'npm test', 'npm pack', 'go test ./...', 'alembic upgrade head', 'rails db:migrate',
  'grep "DROP TABLE" schema.sql', 'rg "terraform apply" docs', 'echo "git push --force"', 'cat drop_table.sql', 'git log --grep "force push"', 'git diff --stat', 'less kubectl-delete.md',
]

test('operations: the corpus of irreversible commands, through wrappers', () => {
  for (const [c, kind] of OPERATIONS) assert.equal(classifyOperation(c)?.kind, kind, c)
})

test('operations: look-alikes and read-only commands are none', () => {
  for (const c of SAFE) assert.equal(classifyOperation(c), null, c)
})

test('operations: a production word on the line is reported', () => {
  assert.equal(classifyOperation('kubectl -n prod delete deployment api').production, true)
  assert.equal(classifyOperation('kubectl -n staging delete deployment api').production, false)
})

test('production target: a live thing acted on, not the adjective', () => {
  for (const t of ['update the Terraform for the prod database', 'run the backfill against prod', 'apply it to production', 'restart the production cluster', 'change the prod-db config']) assert.equal(productionTarget(t), true, t)
  for (const t of ['make this production-ready', 'add a production build step', 'reproduce the bug', 'a production grade logger', 'improve the product page']) assert.equal(productionTarget(t), false, t)
})

// The audit's false negatives: each has hard evidence or a real change, and text alone used to score none.
test('consequence: a surface word covers only its own clause', () => {
  assert.equal(textConsequence('Fix the auth middleware so it rejects expired tokens; add a test for that').level, 'critical')
  assert.equal(textConsequence('Fix the auth middleware. Add a test for that.').level, 'critical')
  assert.equal(textConsequence('Add a test for the login flow.').level, 'none', 'all of it is the surface')
  assert.equal(textConsequence('Fix the typo in the login page heading, and update the README.').level, 'none')
})

test('consequence: an operation or a production target in the prompt is hard evidence', () => {
  for (const text of ['git push --force to main', 'Run terraform apply on the staging stack', 'update the Terraform for the prod database', 'Production login loops after the deploy; find the cause.']) {
    const a = assess({ text })
    assert.equal(a.level, 'critical', text)
    assert.equal(a.review, 'opus', text)
    assert.ok(a.hard.length, text)
  }
})

test('consequence: a question or a message about an operation changes nothing', () => {
  for (const text of ['What does terraform apply do?', 'How do I undo a git push --force?', 'Draft a slack message about the prod database move']) assert.equal(assess({ text }).level === 'critical', false, text)
})

test('consequence: a clause that only documents or tests an operation is not one', () => {
  for (const text of ['Fix the docs for kubectl delete', 'Update the README to mention terraform apply', 'Add a test that git push --force is rejected']) assert.equal(assess({ text }).hard.length, 0, text)
  assert.ok(assess({ text: 'Run terraform apply; add a test for the module' }).hard.length, 'the acting clause still counts')
})

test('consequence: the audit false positives cap at elevated without hard evidence', () => {
  assert.equal(assess({ text: 'add roles to the footer' }).level, 'elevated')
  assert.equal(assess({ text: 'apply all the fixes at once' }).level, 'elevated')
  assert.equal(assess({ text: 'add roles to the footer' }).review, null)
})

test('consequence: an edited path is hard evidence, and routing still reads the judge', () => {
  assert.equal(assess({ text: 'Rename a helper.', observedLevel: 'critical' }).review, 'opus')
  const judgeOnly = assess({ text: 'Rename a helper.', judge: { risk: 'critical' } })
  assert.deepEqual([judgeOnly.level, judgeOnly.routing, judgeOnly.review], ['elevated', 'critical', 'sonnet'])
  const named = assess({ text: 'Change the handler in src/auth/login.ts', pathLevel: 'critical' })
  assert.equal(named.level, 'elevated', 'a named path is not an edited one')
})

test('review: a judge-only critical task asks for a Sonnet reviewer; any other reason keeps Opus', () => {
  const judgeOnly = prospectiveRisk('rename a helper', { risk: 'critical', why: 'credentials' })
  const because = reviewNeeded(judgeOnly, null, 'none', false)
  assert.equal(because.length, 1)
  assert.equal(reviewerFamily(because), 'sonnet')
  assert.equal(reviewerFamily([...because, 'large change']), 'opus')
  assert.equal(reviewerFamily(reviewNeeded(prospectiveRisk('git push --force', null), null, 'none', false)), 'opus')
  assert.equal(reviewerFamily([]), 'opus')
  assert.deepEqual(reviewNeeded(prospectiveRisk('add roles to the footer', null), null, 'none', false), [], 'text alone buys no review')
})
