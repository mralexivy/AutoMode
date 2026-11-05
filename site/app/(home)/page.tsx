import type { Metadata } from 'next';
import Link from 'next/link';
import { CopyCommand } from '@/components/copy-command';
import { Motion } from '@/components/motion';
import { videoObject } from '@/lib/seo';
import { basePath, repoUrl, siteUrl } from '@/lib/shared';

const title = 'AutoMode: Automatic Model and Effort Router for Claude Code';
const description =
  'Free, open source Claude Code router that picks the model and effort per prompt. Benchmarked at half the cost of Opus, same pass rate. No key.';

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: siteUrl },
  openGraph: {
    url: siteUrl,
    title: 'AutoMode for Claude Code',
    description: 'The right model and the right effort for every prompt. Half the cost of Claude Code on Opus, at the same pass rate. No key, no server.',
    images: [{ url: `${siteUrl}social.png`, alt: 'AutoMode for Claude Code: the right model and the right effort for every prompt' }],
  },
  twitter: { card: 'summary_large_image', images: `${siteUrl}social.png` },
};

// The mixed-session totals from bench/results/headline.json. tests/claims.test.mts checks that this page shows them.
const RESULTS = [
  { who: 'AutoMode', q: 0.08, t: 1.93, total: '$2.01', win: true },
  { who: 'Sonnet high', q: 0.24, t: 1.9, total: '$2.14' },
  { who: 'effortless', q: 0.43, t: 3.44, total: '$3.87' },
  { who: 'Opus (default)', q: 0.5, t: 3.64, total: '$4.14' },
];
const MAX = 4.14;

const FAQ = [
  {
    q: 'What is AutoMode?',
    a: 'AutoMode is a free, open source plugin for Claude Code. It picks the model and the effort for each prompt, sets a quality floor for risky work, and runs a plan, build, verify and review workflow for big jobs.',
  },
  {
    q: 'Is AutoMode the same as Claude Code auto mode?',
    a: 'No. Claude Code auto mode is a built-in permission mode from Anthropic. It decides whether an action runs without asking you. AutoMode is a community plugin that picks the model and effort.',
    link: ['/docs/guides/auto-mode-vs-automode', 'Read the full difference'],
  },
  {
    q: 'How do I stop switching Claude Code models by hand?',
    a: 'Install a model router such as AutoMode. It chooses Haiku, Sonnet or Opus for each prompt, so you do not touch the model picker. You can still override any prompt with am:opus or am:haiku.',
    link: ['/docs/concepts/routing', 'See how a route is decided'],
  },
  { q: 'Does AutoMode need an API key?', a: 'No. AutoMode runs on the Claude login you already have. There is no key, no server and no account to make.' },
  {
    q: 'Does AutoMode save money?',
    a: 'Yes, against Opus: 51% less in mixed coding sessions and 45% less on 30 coding tasks, at the same pass rate. Against Sonnet high it costs a little less in mixed sessions and about the same on long coding tasks.',
    link: ['/docs/benchmarks/results', 'See the benchmark'],
  },
  {
    q: 'Does AutoMode send my prompts anywhere?',
    a: 'AutoMode has no telemetry and no network code of its own. Judge and compaction calls go through Claude Code, on your own login. It stores local files in its own data folder.',
    link: ['/docs/security/privacy', 'Read the privacy page'],
  },
  {
    q: 'Does AutoMode work in VS Code?',
    a: 'Yes. Routing runs in the VS Code extension. Claude Code does not draw the bar there, so use the /automode command for the same facts.',
  },
  {
    q: 'How does AutoMode compare with other routers?',
    a: 'On the same mixed sessions, AutoMode cost $2.01 and effortless $3.87, both passing 20 of 20. AutoMode also adds risk floors and a review workflow, and it needs no key. jev-router also runs on Codex.',
    link: ['/docs/compare', 'Compare Claude Code routers'],
  },
];

const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'WebSite', '@id': `${siteUrl}#website`, name: 'AutoMode', url: siteUrl },
    {
      '@type': 'SoftwareApplication',
      '@id': `${siteUrl}#software`,
      name: 'AutoMode',
      alternateName: 'AutoMode for Claude Code',
      description: 'A free, open source Claude Code plugin that picks the model and the effort for each prompt.',
      applicationCategory: 'DeveloperApplication',
      applicationSubCategory: 'Claude Code plugin',
      operatingSystem: 'macOS, Linux, Windows',
      url: siteUrl,
      image: `${siteUrl}social.png`,
      license: 'https://opensource.org/licenses/MIT',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      author: { '@type': 'Person', name: 'Alex Ivy', url: 'https://github.com/mralexivy' },
      sameAs: [repoUrl],
    },
    ...(['route-demo', 'benchmark-race', 'workflow-flow', 'cache-check'] as const).map(videoObject),
    {
      '@type': 'FAQPage',
      mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    },
  ],
};

const card = 'rounded-2xl border bg-fd-card p-6';
const kicker = 'text-sm font-semibold uppercase tracking-wider text-fd-primary';
const h2 = 'mt-2 text-3xl font-bold tracking-tight md:text-4xl';
const sub = 'mt-3 max-w-3xl text-lg text-fd-muted-foreground';
const grad = 'bg-gradient-to-r from-violet-400 to-cyan-400 bg-clip-text text-transparent';

function Section({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mx-auto w-full max-w-6xl scroll-mt-20 px-6 py-16">
      {children}
    </section>
  );
}

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />

      <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-6 pb-12 pt-16 lg:grid-cols-[1fr_1.15fr]">
        <div>
          <p className="mb-4 inline-block rounded-full border px-3 py-1 text-xs text-fd-muted-foreground">
            Free · MIT · No key · No server
          </p>
          <h1 className="text-5xl font-bold leading-[1.04] tracking-tight md:text-6xl">
            AutoMode <span className={`block ${grad}`}>for Claude Code</span>
          </h1>
          <p className="mt-5 text-xl text-fd-muted-foreground">
            A free model router for Claude Code. The right model and the right effort for every prompt. Quick questions stay cheap. Hard jobs get the strongest
            model. Risky changes always get a review.
          </p>
          <p className="mt-4">
            <b>Half the cost of Claude Code on Opus.</b> Same pass rate, on real coding sessions.{' '}
            <Link href="#results" className="text-fd-primary underline">
              See the benchmark
            </Link>
            .
          </p>
          <div className="mt-6 flex flex-col gap-2">
            <CopyCommand command="/plugin marketplace add mralexivy/AutoMode" />
            <CopyCommand command="/plugin install automode@automode" />
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link href="/docs/getting-started/install" className="rounded-xl bg-gradient-to-r from-violet-400 to-cyan-400 px-5 py-3 font-bold text-[#0a0d1b]">
              Get started
            </Link>
            <Link href="/docs" className="rounded-xl border px-5 py-3 font-semibold">
              Read the docs
            </Link>
            <a href={repoUrl} className="rounded-xl border px-5 py-3 font-semibold">
              Star on GitHub
            </a>
          </div>
          <p className="mt-4 text-sm text-fd-muted-foreground">
            A community project, not made by Anthropic, and not Claude Code&apos;s built-in auto permission mode.
          </p>
        </div>
        <figure>
          <Motion id="route-demo" className="my-0" />
          <figcaption className="mt-2 text-center text-sm text-fd-muted-foreground">
            How a session routes. <Link href="#demo" className="text-fd-primary underline">Watch a real recording</Link>.
          </figcaption>
        </figure>
      </section>

      <Section id="results">
        <p className={kicker}>The benchmark</p>
        <h2 className={h2}>Half the cost of Opus. Every task still passes.</h2>
        <p className={sub}>
          Five real coding sessions, the way people use Claude Code: a quick question, a task, another question, then a harder task, all in one conversation on a
          real repository. Hidden tests grade every task.
        </p>
        <div className={`${card} mt-8 space-y-4`}>
          {RESULTS.map((r) => (
            <div key={r.who} className="grid grid-cols-[8rem_1fr_4rem_3rem] items-center gap-3 text-sm md:grid-cols-[10rem_1fr_5rem_4rem]">
              <span className={r.win ? 'font-bold' : ''}>{r.who}</span>
              <span className="flex h-3 overflow-hidden rounded-full bg-fd-secondary">
                <i className="bg-cyan-400" style={{ width: `${(r.q / MAX) * 100}%` }} />
                <i className={r.win ? 'bg-violet-400' : 'bg-violet-400/50'} style={{ width: `${(r.t / MAX) * 100}%` }} />
              </span>
              <span className={`text-right font-mono ${r.win ? 'font-bold text-fd-primary' : ''}`}>{r.total}</span>
              <span className="text-right text-fd-muted-foreground">20/20</span>
            </div>
          ))}
          <p className="text-xs text-fd-muted-foreground">
            <i className="mr-1 inline-block size-2 rounded-full bg-cyan-400" /> questions <i className="mx-1 inline-block size-2 rounded-full bg-violet-400" /> coding
            tasks · list-price cost of every request, judges and subagents included
          </p>
        </div>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {[
            ['−51%', 'against Claude Code on Opus, same 20/20'],
            ['−48%', 'against effortless, the closest open source router'],
            ['−84%', 'on questions: $0.08 for ten, against $0.50 on Opus'],
          ].map(([b, s]) => (
            <div key={b} className={card}>
              <b className={`text-4xl ${grad}`}>{b}</b>
              <p className="mt-1 text-sm text-fd-muted-foreground">{s}</p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-sm text-fd-muted-foreground">
          On 30 single coding tasks: 29 passed at $0.275 per pass, against 28 at $0.499 for plain Opus, 45% less. The ship rule, fixed before the run, cleared with a
          ratio of 0.551 (90% interval 0.511 to 0.591).{' '}
          <Link href="/docs/guides/calculator" className="text-fd-primary underline">
            Estimate your own saving
          </Link>
          .
        </p>
      </Section>

      <Section id="race">
        <Motion id="benchmark-race" />
      </Section>

      <Section id="fit">
        <p className={kicker}>Will it save you money?</p>
        <h2 className={h2}>It depends on how you work. Here is the honest answer.</h2>
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {[
            ['Big saving', 'You run Claude Code on Opus', 'That is the default, and it is where AutoMode shines: about half the cost, with every task still passing.'],
            ['Big saving', 'You ask questions between tasks', 'Questions are the cheapest win: 84% less than Opus and 67% less than Sonnet high.'],
            ['Saves', 'You already use Sonnet high', 'In mixed sessions AutoMode still costs less, $2.01 against $2.14, and adds risk floors and reviews.'],
            ['About even', 'Only long coding tasks, on Sonnet', 'AutoMode runs those on Sonnet too, so the cost is about the same, around 15% more. What you gain there is the guardrails.'],
          ].map(([badge, h, p]) => (
            <div key={h} className={card}>
              <span className="rounded-full bg-fd-secondary px-2.5 py-1 text-xs font-semibold text-fd-primary">{badge}</span>
              <h3 className="mt-3 text-lg font-semibold">{h}</h3>
              <p className="mt-1 text-fd-muted-foreground">{p}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section id="ladder">
        <p className={kicker}>How a route is chosen</p>
        <h2 className={h2}>One ladder. The cheapest rung that is still adequate.</h2>
        <p className={sub}>Code sets a floor for risky work, and the judge never lowers it.</p>
        <img src={`${basePath}/img/ladder.svg`} alt="The ladder: T0 Haiku low, T1 Sonnet medium, T2 Sonnet high, T3 Opus high, T4 Opus max" className="mt-8 w-full rounded-2xl border" />
        <div className="mt-6 grid gap-4 md:grid-cols-4">
          {[
            ['What does the -r flag do in cp?', 'Haiku · low', 'A fact with no tools.'],
            ['Rename this helper and update its tests', 'Sonnet · medium', 'A clear edit. It must show a passing test.'],
            ['Refactor the importer to stream rows', 'Sonnet · high', 'More steps, so effort goes up.'],
            ['Move sessions from cookies to signed JWTs', 'Opus · high', 'Security and migration: a floor and a review.'],
          ].map(([q, r, w]) => (
            <div key={q} className={card}>
              <p className="font-mono text-sm">{q}</p>
              <p className="mt-3 font-semibold text-fd-primary">{r}</p>
              <p className="mt-1 text-sm text-fd-muted-foreground">{w}</p>
            </div>
          ))}
        </div>
        <Link href="/docs/concepts/routing" className="mt-6 inline-block text-fd-primary underline">
          Read how a route is decided
        </Link>
      </Section>

      <Section id="workflow">
        <p className={kicker}>Big jobs</p>
        <h2 className={h2}>A real workflow, with six small agents</h2>
        <p className={sub}>Code, not a model, sets the risk band and decides pass or fail from exit codes.</p>
        <div className="mt-8 grid gap-4 md:grid-cols-5">
          {[
            ['Risk band', 'code', 'Sets S0 to S3. The band only goes up.'],
            ['Discover', 'Haiku', 'Finds files, interfaces and tests.'],
            ['Plan', 'Opus', 'Workstreams, criteria and risks.'],
            ['Build + verify', 'Sonnet', 'Runs the commands. Exit codes decide.'],
            ['Review', 'Sonnet or Opus', 'Mandatory for risky work. Opus when the diff shows critical risk.'],
          ].map(([h, m, p]) => (
            <div key={h} className={card}>
              <h3 className="font-semibold">{h}</h3>
              <p className="mt-1 font-mono text-xs text-fd-primary">{m}</p>
              <p className="mt-2 text-sm text-fd-muted-foreground">{p}</p>
            </div>
          ))}
        </div>
        <Motion id="workflow-flow" className="mt-8" />
        <Link href="/docs/concepts/workflow" className="mt-2 inline-block text-fd-primary underline">
          Read about the workflow
        </Link>
      </Section>

      <Section id="cache">
        <p className={kicker}>Prompt cache</p>
        <h2 className={h2}>No surprise bills from a model switch</h2>
        <p className={sub}>Each model keeps its own cache. AutoMode prices every switch against the cache rewrite, and holds the model when the switch does not pay.</p>
        <Motion id="cache-check" className="mt-8" />
      </Section>

      <Section id="demo">
        <p className={kicker}>A real recording</p>
        <h2 className={h2}>See a real session</h2>
        <p className={sub}>Claude Code 2.1.308, sped up 1.6 times. A quick question runs on Haiku at Low. A JWT migration moves up to Opus, because the risk floor rules out Haiku.</p>
        <img
          src={`${basePath}/img/demo.gif`}
          alt="A real session: a quick question runs on Haiku at Low, then a JWT migration moves up to Opus because the risk floor rules out Haiku"
          width={1240}
          height={680}
          loading="lazy"
          className="mt-8 w-full rounded-2xl border"
        />
      </Section>

      <Section id="trust">
        <p className={kicker}>Open source</p>
        <h2 className={h2}>Read it before you run it</h2>
        <p className={sub}>A mod runs with your permissions, and AutoMode sees every prompt and tool call, because that is how routing works. So all of it is open.</p>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {[
            ['What leaves your machine', 'No telemetry and no network code of its own. Judge and compaction calls go through Claude Code, on your own login.', '/docs/security/privacy'],
            ['What it stores', 'Local files in its own data folder, with retention limits.', '/docs/security/privacy'],
            ['What it can do', 'Run claude plugin validate on a clone to list every hook and API call.', '/docs/security/review'],
          ].map(([h, p, href]) => (
            <Link key={h} href={href} className={`${card} transition-colors hover:border-fd-primary/60`}>
              <h3 className="font-semibold">{h}</h3>
              <p className="mt-2 text-sm text-fd-muted-foreground">{p}</p>
            </Link>
          ))}
        </div>
      </Section>

      <Section id="faq">
        <h2 className={h2}>Questions people ask</h2>
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {FAQ.map((f) => (
            <div key={f.q} className={card}>
              <h3 className="font-semibold">{f.q}</h3>
              <p className="mt-2 text-sm text-fd-muted-foreground">{f.a}</p>
              {f.link ? (
                <Link href={f.link[0]} className="mt-2 inline-block text-sm text-fd-primary underline">
                  {f.link[1]}
                </Link>
              ) : null}
            </div>
          ))}
        </div>
      </Section>

      <Section>
        <div className="rounded-3xl border bg-gradient-to-br from-violet-500/15 to-cyan-500/10 p-10 text-center">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Stop touching the model picker</h2>
          <p className="mt-3 text-fd-muted-foreground">Two commands, one reload, and it starts on its own.</p>
          <div className="mx-auto mt-6 flex max-w-xl flex-col gap-2 text-left">
            <CopyCommand command="/plugin marketplace add mralexivy/AutoMode" />
            <CopyCommand command="/plugin install automode@automode" />
          </div>
        </div>
      </Section>

      <footer className="border-t">
        <div className="mx-auto grid max-w-6xl gap-8 px-6 py-12 text-sm md:grid-cols-4">
          {[
            ['Get started', [['Install', '/docs/getting-started/install'], ['Your first session', '/docs/getting-started/first-session'], ['Where it runs', '/docs/getting-started/where-it-runs'], ['Turn it off', '/docs/getting-started/turn-off']]],
            ['Learn', [['How a route is decided', '/docs/concepts/routing'], ['The workflow', '/docs/concepts/workflow'], ['The guardian', '/docs/concepts/guardian'], ['Prompt cache', '/docs/concepts/prompt-cache']]],
            ['Guides', [['Cost calculator', '/docs/guides/calculator'], ['Reduce Claude Code costs', '/docs/guides/reduce-claude-code-costs'], ['Effort levels', '/docs/guides/effort-levels'], ['Haiku vs Sonnet vs Opus', '/docs/guides/haiku-vs-sonnet-vs-opus']]],
            ['Compare', [['Benchmark', '/docs/benchmarks/results'], ['All routers', '/docs/compare'], ['AutoMode vs effortless', '/docs/guides/automode-vs-effortless'], ['AutoMode vs auto mode', '/docs/guides/auto-mode-vs-automode']]],
          ].map(([h, links]) => (
            <div key={h as string}>
              <p className="font-semibold">{h as string}</p>
              <ul className="mt-3 space-y-2 text-fd-muted-foreground">
                {(links as string[][]).map(([t, href]) => (
                  <li key={href}>
                    <Link href={href} className="hover:text-fd-foreground">
                      {t}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mx-auto max-w-6xl px-6 pb-10 text-xs text-fd-muted-foreground">
          MIT licensed. Effort rules and bar techniques ported from <a href="https://github.com/HeyCubit/effortless" className="underline">effortless</a>. Classifier
          contract and switch payback adapted from <a href="https://github.com/alexei-led/claude-router" className="underline">claude-router</a> and{' '}
          <a href="https://github.com/gargpratyush/jev-router" className="underline">jev-router</a>. AutoMode is a community project, not made by Anthropic. Claude and
          Claude Code are trademarks of Anthropic. <a href={repoUrl} className="underline">Source</a>.
        </p>
      </footer>
    </main>
  );
}
