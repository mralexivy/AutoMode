// Where a neutral-track agent's commands run. There is no fallback to the host: a model's shell must never reach the
// machine, its credentials or the harness's repository cache, so with no Docker the run fails.
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'

export interface ExecResult { status: number | null; stdout: string; stderr: string; timedOut: boolean }
export interface Sandbox { readonly image: string; exec(command: string, opts: { timeoutMs: number; network?: boolean }): Promise<ExecResult> }

export const DEFAULT_IMAGE = process.env.BENCH_SANDBOX_IMAGE ?? 'node:24-bookworm-slim'
export const imagePinned = (image: string) => /@sha256:[0-9a-f]{64}$/.test(image)

export function dockerAvailable() {
  return spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 20_000 }).status === 0
}

// dockerArgs is pure, so a test can hold the isolation flags in place. No secret is ever passed in.
export function dockerArgs(o: { name: string; workspace: string; image: string; network: boolean; command: string }) {
  return ['run', '--rm', '--name', o.name, '--init', '--network', o.network ? 'bridge' : 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '512', '--memory', '4g', '--cpus', '2', '--tmpfs', '/tmp', '--mount', `type=bind,src=${o.workspace},dst=/workspace`, '--workdir', '/workspace',
    o.image, 'sh', '-c', o.command]
}

export function dockerSandbox(workspace: string, image = DEFAULT_IMAGE): Sandbox {
  return {
    image,
    exec: (command, { timeoutMs, network = false }) => new Promise((resolve) => {
      const name = `am-bench-${crypto.randomUUID()}`
      const child = spawn('docker', dockerArgs({ name, workspace, image, network, command }), { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = '', timedOut = false
      child.stdout.on('data', (d) => { stdout += d })
      child.stderr.on('data', (d) => { stderr += d })
      const timer = setTimeout(() => { timedOut = true; spawnSync('docker', ['kill', name], { timeout: 20_000 }); child.kill('SIGKILL') }, timeoutMs)
      child.on('error', (e) => { clearTimeout(timer); resolve({ status: null, stdout, stderr: `${stderr}${e.message}`, timedOut: false }) })
      child.on('close', (status) => { clearTimeout(timer); resolve({ status: timedOut ? null : status, stdout, stderr, timedOut }) })
    }),
  }
}
