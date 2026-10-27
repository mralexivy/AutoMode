#!/usr/bin/env python3
# Interactive-terminal check of automatic compaction (guardian auto + autoCompact). Headless (-p) and the VS Code
# extension run Claude Code as an SDK session, where the runtime refuses $.session.compact; the interactive terminal is
# the remaining place it can run. This drives a real interactive `claude` in a pseudo-terminal: two short tasks on Claude
# Haiku 5.5 in the isolated test profile (~/.claude-ectest), then reads the guardian's records. Paid: about $0.03.
#   python3 bench/guardian-tty.py <plugin-dir> <workspace>
import json, os, pty, select, sys, time, glob

plugin, ws = sys.argv[1], sys.argv[2]
profile = os.path.expanduser('~/.claude-ectest')
data = os.path.join(profile, 'plugins', 'data', 'automode', 'guardian')
cfg = {'mode': 'auto', 'everySession': True, 'autoCompact': True, 'minContextTokens': 1, 'horizon': 1000, 'coldReturnRate': 0, 'margin': 0, 'compactStaleShare': 0.2}
env = {k: v for k, v in os.environ.items() if k not in ('CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT')}  # a child of this session would not save its transcript
env = dict(env, CLAUDE_CONFIG_DIR=profile, CLAUDE_CODE_USE_VERTEX='0', AUTOMODE_GUARDIAN_CONFIG=json.dumps(cfg), TERM='xterm-256color')
claude = os.path.expanduser('~/.local/bin/claude')
args = [claude, '--model', 'claude-haiku-5-5', '--plugin-dir', plugin, '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Read,Edit,Write', '--setting-sources', 'project', '--strict-mcp-config']
proj = os.path.join(profile, 'projects', os.path.realpath(ws).replace('/', '-').replace('.', '-'))

pid, fd = pty.fork()
if pid == 0:
    os.chdir(ws)
    os.execve(claude, args, env)
import fcntl, termios, struct
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))

buf = b''
def pump(seconds):
    global buf
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try: buf += os.read(fd, 65536)
            except OSError: return
def send(text):
    for ch in text: os.write(fd, ch.encode()); time.sleep(0.01)
    time.sleep(0.3); os.write(fd, b'\r')
def session_file():
    files = sorted(glob.glob(os.path.join(proj, '*.jsonl')), key=os.path.getmtime)
    return files[-1] if files else None
def turns_done():
    f = session_file()
    if not f: return 0
    n = 0
    for l in open(f):
        try: d = json.loads(l)
        except Exception: continue
        if d.get('type') == 'assistant' and (d.get('message') or {}).get('stop_reason') == 'end_turn': n += 1
    return n
def wait_turns(n, limit=180):
    end = time.time() + limit
    while time.time() < end and turns_done() < n: pump(1)
    pump(6)  # turn.complete hooks, including the compaction, finish after the last line

pump(8)
# The trust dialog defaults to "No, exit": this throwaway test folder is trusted with Down, then Enter.
if b'trust' in buf.lower(): os.write(fd, b'\x1b[B'); time.sleep(0.3); os.write(fd, b'\r'); pump(5)
send('Read big.txt in full with the Read tool, then append "a" to notes.txt and run `node --test` once. One word answer.')
wait_turns(1)
send('Now, separately: list the files here in one line.')
wait_turns(2)
pump(20)  # the compaction runs a model call
sid = os.path.basename(session_file() or '')[:-6]
open(os.environ.get('TTY_SCREEN', '/dev/null'), 'wb').write(buf[-20000:])
if not sid:
    print(json.dumps({'pass': False, 'error': 'no session transcript: the prompt never reached the model', 'screen': os.environ.get('TTY_SCREEN')})); sys.exit(0)
os.write(fd, b'\x03'); pump(1); os.write(fd, b'\x03'); pump(2)
records = []
for f in glob.glob(os.path.join(data, f'{sid}*.jsonl')):
    records += [json.loads(l) for l in open(f) if l.strip()]
text = open(session_file()).read() if session_file() else ''
ev = [r.get('event') for r in records]
out = {'session': sid, 'decided': any(r.get('event') == 'lifecycle' and r.get('action') == 'compact' for r in records),
       'compacted': ev.count('compacted'), 'unavailable': [r.get('error') for r in records if r.get('event') == 'compact-unavailable'],
       'compactBoundary': 'compact_boundary' in text, 'events': ev}
out['pass'] = out['decided'] and out['compacted'] > 0 and out['compactBoundary']
print(json.dumps(out))
