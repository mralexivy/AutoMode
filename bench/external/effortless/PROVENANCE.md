# effortless: provenance

- Repository: https://github.com/HeyCubit/effortless
- Commit: `e5c590dfd9402244ea66a8bf795d1cb86d1df7b9` (committed 2026-10-23T14:30:07Z, plugin version 1.72.0)
- License: MIT, `Copyright (c) 2026 HeyCubit` (`upstream/LICENSE`)
- Fetched: 2026-10-25 with `gh api repos/HeyCubit/effortless/contents/<path>?ref=<commit>` (raw).

`LICENSE` and `judge-cases.json` in this folder are byte-identical to the files in `upstream/`.

| File in `upstream/` | Upstream path | sha256 |
|---|---|---|
| `LICENSE` | `LICENSE` | `7cba3e115c18f0bf97794504d1095596ea2d33c34f888dbc69e692c8527100e2` |
| `hooks_register.tsx` | `hooks/register.tsx` | `192666f3b0c00150e1c87231ae9a855168d1d709115925f26ac626589ec8dece` |
| `tests_effortless.test.ts.txt` | `tests/effortless.test.ts` | `21665339bc825f29b7239d423fd9171cd472728d6939ea424ec00e69ead1d206` |
| `bench_judge-cases.json` | `bench/judge-cases.json` | `b94a548fc5ec096fb717a65943a42175d0b1de34b01833e8407ca14ce2f95c4f` |
| `bench_agentic_run.sh` | `bench/agentic/run.sh` | `0bcd74dc425422316ea99f9cd814b0f0d1a146a744dca4c2ac5e62fadb600c1a` |
| `bench_agentic_score.cjs` | `bench/agentic/score.cjs` | `f67d8e82c766ca05c8fa1309fe25219c0e20f610d2cf545d4fadd4bf1736e755` |
| `bench_RESULTS.md` | `bench/RESULTS.md` | `c3bddc4212c66eba7abc46d8eddad9f2abd661b3088e4fbb982cfad05f7643eb` |
| `types_index.d.ts` | `types/index.d.ts` | `179cb2f0ab4c03624c98bf8077601676b23701590638a4c211e207951bf398d6` |
| `hooks_theme.ts` | `hooks/theme.ts` | `c29472b24c237452caaa69834dfb4b2827a6937a345663e602c39f03f047b5c0` |
| `hooks_progress.tsx` | `hooks/progress.tsx` | `971039a3de569e9eca53301b0f99bac429aa04e2b0bb5bd934cc32b340cdb960` |
| `hooks_agents.tsx` | `hooks/agents.tsx` | `2d1e53c3f13266554e9d8a430f398bc96a8364a3dc9816a83b167c6d156e4ad7` |
| `hooks_art.ts` | `hooks/art.ts` | `90a9ce715f5a18a0c55172a4f76f7508f1a9a94f8ea132e2ea51b244bf5bcbf6` |
| `hooks_brand-mark.ts` | `hooks/brand-mark.ts` | `fa90cfff1352eea6bc18c339974a51f6c7772df790c11370799a54e8081cfabf` |
| `tools_render-band_render.mjs` | `tools/render-band/render.mjs` | `945b64764530d96c7df0ed268e21591c90694a7f27ff1bdae46d14a4e3ed2b6c` |
| `tools_render-band_page.js` | `tools/render-band/page.js` | `9bea44a9797efa515d90aaed2adf448a60b31eeda1eba320b19d48d05f7edbb8` |
| `tools_render-band_dump.template.ts` | `tools/render-band/dump.template.ts` | `68d0333c53a86be443e3cf8d8fd6493d527920fc347cab725c2b809e8dbad3ce` |
| `tools_render-band_README.md` | `tools/render-band/README.md` | `beafb6d6951c4d303b1e6a1c7ab278e8c2e42365f0ea3e7034ac06f1e1080b96` |
| `textless_plugin_hooks_register.tsx` | `textless/plugin/hooks/register.tsx` | `83a8f9c7193448d42b7d266436c15039bb4d1401ef2a34a3efb3c97727981fa0` |
| `textless_plugin_.claude-plugin_plugin.json` | `textless/plugin/.claude-plugin/plugin.json` | `4a7a75285f60d4cbbe12f87f9defb67d96975f40d490450875c0a25fe85895ff` |

`tests/effortless-fidelity.test.mjs` checks these hashes, then compares each ported declaration in
`hooks/lib/effortless.ts` with the same declaration in `upstream/hooks_register.tsx`.

## The UI port (2026-10-27)

The UI files above were fetched on 2026-10-27 at the same commit, for the AutoMode UI (`hooks/ui/`).
AutoMode's UI is its own design; these parts are ported, each with a header comment naming its source:

| AutoMode | From | What changed |
|---|---|---|
| `hooks/ui/art.ts` `cacheClockSvg` | `register.tsx` 1255-1271 | colours from AutoMode's tokens; a separate colour for "cold" |
| `hooks/ui/art.ts` `inPhase` | `register.tsx` 271 | none in technique |
| `hooks/ui/kit.ts` `flashColor`, `mix` | `register.tsx` 2457-2472 | shorter hold and fewer steps; takes the flash and rest colours |
| `hooks/ui/view.ts` `cacheText` | `register.tsx` 1241-1246 (`cacheLabel`) | "cold" in place of "❄ Cold" |
| `hooks/ui/bar.tsx` wrapping tail | `register.tsx` 3431-3436 | the same one-row wrap that drops the last items first |
| `hooks/ui/cards.tsx` entrance | `register.tsx` 307 (`introLayer`) | a fade from the card's accent, alert cards only |
| `hooks/ui/focus.tsx` row replacement | `textless/plugin/hooks/register.tsx` 2729-2790 | AutoMode's own card and rules (never hides errors, text or the reply) |
| `hooks/ui/focus.tsx` `todosOf` | `hooks/progress.tsx` 42 (`stepsFromTodos`) | counted, not a percentage |
| `tools/ui-gallery` | `tools/render-band` | draws in the VS Code extension and terminal instead of rebuilding the Windows app's renderer |

Note: test files are stored with a `.txt` suffix so that test runners such as `claude plugin test` do not run them. The content is unchanged and the sha256 values above still match.
