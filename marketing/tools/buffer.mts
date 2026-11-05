// Buffer client for approved posts in marketing/posts. Buffer's API is GraphQL at https://api.buffer.com, with a Bearer
// key. The key comes from BUFFER_API_KEY and is never written to a file.
//
//   node marketing/tools/buffer.mts channels                 lists the connected channels
//   node marketing/tools/buffer.mts queue <post> [--send]    adds one approved post to its channel's queue
//   node marketing/tools/buffer.mts stats                    prints the metrics of sent posts
//
// queue is a dry run unless --send is given: it prints the request and sends nothing. After a send it marks the post
// `queued` and records the Buffer post id. The functions at the top are pure.
import { parse, type Post } from './post.mts'

export const ENDPOINT = 'https://api.buffer.com'
export const SITE = 'https://mralexivy.github.io/AutoMode/'
// Our channel names and Buffer's service names.
export const SERVICE: Record<string, string> = { x: 'twitter', bluesky: 'bluesky', linkedin: 'linkedin', threads: 'threads', mastodon: 'mastodon' }

// A GraphQL string literal. JSON's escapes are valid GraphQL escapes.
export const str = (s: string) => JSON.stringify(s)

// A site file in site/public/ is served from the site root, so Buffer can fetch it by URL.
export function assetUrl(path: string): string {
  if (/^https:\/\//.test(path)) return path
  const m = /^site\/public\/(.+)$/.exec(path)
  if (!m) throw new Error(`${path} is not a public URL or a file under site/public/`)
  return SITE + m[1]
}

export function assetInput(path: string): string {
  const url = str(assetUrl(path))
  if (/\.(mp4|mov|webm)$/i.test(path)) return `{ video: { url: ${url} } }`
  if (/\.(png|jpe?g|gif|webp)$/i.test(path)) return `{ image: { url: ${url} } }`
  throw new Error(`${path} is not a video or an image`)
}

export const ORGANIZATIONS = 'query { account { organizations { id name } } }'
export const channelsQuery = (org: string) => `query { channels(input: { organizationId: ${str(org)} }) { id name service isQueuePaused } }`
export const sentPostsQuery = (org: string) =>
  `query { posts(first: 50, input: { organizationId: ${str(org)}, filter: { status: [sent] } }) { edges { node { id text dueAt channelId metrics { name value unit } } } } }`

// Reasons a post cannot be queued, or an empty list.
export function queueProblems(post: Post): string[] {
  const out: string[] = []
  if (post.meta.status !== 'approved') out.push(`status is "${post.meta.status ?? ''}". Only an approved post is queued.`)
  if (!SERVICE[String(post.meta.channel)]) out.push(`channel "${post.meta.channel ?? ''}" is not one Buffer posts to here`)
  if (post.parts.length > 1) out.push('the post is a thread. Queue its first part, then add the rest in the Buffer app.')
  return out
}

export function createPostMutation(post: Post, channelId: string): string {
  const assets = ([] as string[]).concat(post.meta.assets ?? [])
  const list = assets.length ? `\n    assets: [${assets.map(assetInput).join(', ')}]` : ''
  return `mutation {
  createPost(input: {
    text: ${str(post.parts[0])}
    channelId: ${str(channelId)}
    schedulingType: automatic
    mode: addToQueue${list}
  }) {
    ... on PostActionSuccess { post { id status } }
    ... on MutationError { message }
  }
}`
}

// Marks the post queued and keeps the Buffer id in its frontmatter.
export function markQueued(text: string, id: string): string {
  return text.replace(/^(---\n[\s\S]*?)status:\s*approved\n/, `$1status: queued\nbuffer_id: ${id}\n`)
}

async function call(query: string) {
  const key = process.env.BUFFER_API_KEY
  if (!key) throw new Error('Set BUFFER_API_KEY. Create a key at publish.buffer.com/settings/api.')
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query }),
  })
  const json: any = await res.json()
  if (!res.ok || json.errors) throw new Error(`Buffer answered ${res.status}: ${JSON.stringify(json.errors ?? json)}`)
  return json.data
}

const organization = async () => {
  const orgs = (await call(ORGANIZATIONS)).account.organizations
  if (!orgs.length) throw new Error('This Buffer account has no organization.')
  return orgs[0].id as string
}

async function main([cmd, file, ...rest]: string[]) {
  const { readFileSync, writeFileSync } = await import('node:fs')
  if (cmd === 'channels') {
    for (const c of (await call(channelsQuery(await organization()))).channels) console.log(`${c.service}\t${c.id}\t${c.name}${c.isQueuePaused ? '\t(paused)' : ''}`)
  } else if (cmd === 'stats') {
    for (const { node: p } of (await call(sentPostsQuery(await organization()))).posts.edges) {
      console.log(`${p.dueAt ?? ''}\t${p.channelId}\t${(p.metrics ?? []).map((m: any) => `${m.name} ${m.value}`).join(', ')}\t${p.text.slice(0, 60)}`)
    }
  } else if (cmd === 'queue' && file) {
    const text = readFileSync(file, 'utf8')
    const post = parse(text)
    const problems = queueProblems(post)
    if (problems.length) throw new Error(problems.join('\n'))
    if (!rest.includes('--send')) {
      console.log(createPostMutation(post, '<channel id>'))
      console.log('\nDry run. Nothing was sent. Add --send to queue it.')
      return
    }
    const service = SERVICE[String(post.meta.channel)]
    const channel = (await call(channelsQuery(await organization()))).channels.find((c: any) => c.service === service)
    if (!channel) throw new Error(`No ${service} channel is connected in Buffer.`)
    const out = (await call(createPostMutation(post, channel.id))).createPost
    if (!out.post) throw new Error(`Buffer refused the post: ${out.message}`)
    writeFileSync(file, markQueued(text, out.post.id))
    console.log(`queued ${file} on ${service} as ${out.post.id}`)
  } else {
    console.log('Usage: buffer.mts channels | queue <post> [--send] | stats')
    process.exitCode = 2
  }
}

const { pathToFileURL } = await import('node:url')
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1 })
}
