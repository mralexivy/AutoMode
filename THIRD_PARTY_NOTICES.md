# Third-party notices

AutoMode includes ideas and code from the open source projects below. All of them are MIT licensed. Each upstream copy, its source commit and its checksums are in [`bench/external/`](bench/external/), with a `PROVENANCE.md` for each.

| Project | Copyright | Where it is used |
|---|---|---|
| [effortless](https://github.com/HeyCubit/effortless) | Copyright (c) 2026 HeyCubit | The effort rules in `hooks/lib/effort.ts` and `hooks/lib/effortless.ts`, the bar techniques in `hooks/ui/`, and the labeled cases in `bench/judge-cases.json`. |
| [claude-router](https://github.com/alexei-led/claude-router) | Copyright (c) 2026 Alexei Ledenev | The classifier contract and the switch payback rule in `hooks/lib/classify.ts`, `hooks/lib/failures.ts` and `hooks/lib/policy.ts`. |
| [jev-router](https://github.com/gargpratyush/jev-router) | Copyright (c) 2026 Jev Router contributors | Stripping system reminders from the classifier input. |
| [claude-tier-router](https://github.com/alex-jb/claude-tier-router) | Copyright (c) 2026 alex-jb | Reference only: its methodology is compared in `bench/external/METHODOLOGY.md`. No code is used. |

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

The full license text of each project is in its `upstream/LICENSE` file under `bench/external/`.

## Contributor Covenant

The [code of conduct](CODE_OF_CONDUCT.md) is adapted from the Contributor Covenant 2.1, which is licensed under CC BY 4.0.
