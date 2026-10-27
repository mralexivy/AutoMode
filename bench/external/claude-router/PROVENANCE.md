# claude-router: provenance

- Repository: https://github.com/alexei-led/claude-router
- Commit: `168334f1bf2e409a3e5d59d43995af74bd25c9db` (committed 2026-10-22T07:36:58Z)
- License: MIT, `Copyright (c) 2026 Alexei Ledenev` (`upstream/LICENSE`)
- Fetched: 2026-10-26 with `gh api -H "Accept: application/vnd.github.raw" repos/alexei-led/claude-router/contents/<path>?ref=<commit>` (raw).
- Integrity: each file's `git hash-object` equals the blob SHA in `gh api repos/alexei-led/claude-router/git/trees/<commit>?recursive=1`, so the files are byte-identical to upstream.
- Scope: LICENSE, README, every test file, every benchmark, eval, fixture, golden, replay or probe file with its results, and the core policy source the tests exercise. Path separators are flattened to `_`. No file was over 2 MB.
- Skipped on purpose: PNG screenshots in `experiments/mod-router/results/`, docs other than `docs/evaluation.md`, and UI, pane and display source. `LICENSE` and `mode-probe.json` in this folder (vendored earlier) are byte-identical to `upstream/LICENSE` and `upstream/test_fixtures_mode-probe.json`.

| File in `upstream/` | Upstream path | sha256 |
|---|---|---|
| `LICENSE` | `LICENSE` | `aca59681d13c9ca4466f25d4f0b1eb301a4a757a2e62d1bc0b65ec0ef2e1b16f` |
| `README.md` | `README.md` | `0a6c377d575718bff829f865bcf63d91121df518a8b929bccbcfcff065a07bf5` |
| `docs_evaluation.md` | `docs/evaluation.md` | `f080ea8770b2b95d44d50c677a6a6238d9e282844bbda6bd1f7cbdd118b4cccb` |
| `experiments_mod-router_results_activity-live-acceptance.json` | `experiments/mod-router/results/activity-live-acceptance.json` | `66b05b511635fe15bbbad1bc80258995d3cec563249d6a2cf89d381f24dac421` |
| `experiments_mod-router_results_activity-probe-clef-flash.json` | `experiments/mod-router/results/activity-probe-clef-flash.json` | `56da7d96e6d5dabedf302333d6ba0f64e656736399e1b7d9c3290a31d1f0d42f` |
| `experiments_mod-router_results_activity-probe-clef.json` | `experiments/mod-router/results/activity-probe-clef.json` | `75f20700dfe2318ba902606fa80edddfa15598a22ead207b49f6d88b82bffb60` |
| `experiments_mod-router_results_activity-probe-jev.json` | `experiments/mod-router/results/activity-probe-jev.json` | `6f2ce6a40bd4c3b1c5a4891130c5c4b4e8d0a29f2509d5d261279f25fbb8f2d4` |
| `experiments_mod-router_results_activity-probe-ollama.json` | `experiments/mod-router/results/activity-probe-ollama.json` | `8831f3cca0cb841ca9586a577c20789ddd49fed7eb21c241562e1dffc28fcba7` |
| `experiments_mod-router_results_activity-probe-openai.json` | `experiments/mod-router/results/activity-probe-openai.json` | `4728baabe0a661097cada354cf6c8b5bb750fb413a133575cd473e760b04cdb3` |
| `experiments_mod-router_results_agent-spawn-probe.json` | `experiments/mod-router/results/agent-spawn-probe.json` | `9cbb56f313a254486be0a8ff3769193257de04c27123cded3d16f36016a7f213` |
| `experiments_mod-router_results_deferred-tool-output-gate.json` | `experiments/mod-router/results/deferred-tool-output-gate.json` | `7f5aad6863c4a72662d29b1d809bcf33fcc195e999b8d1d31c6683dbe909f374` |
| `experiments_mod-router_results_mode-live-acceptance.json` | `experiments/mod-router/results/mode-live-acceptance.json` | `afac597f60190f6da67a429b717c45df1bec58d8faf7cad8f6635a061e48e014` |
| `experiments_mod-router_results_mode-probe-jev.json` | `experiments/mod-router/results/mode-probe-jev.json` | `64eca4e8e35c027f237e87bb6bb8064e7eb7e2c3ec1b9e608d1b8eef28f713a7` |
| `experiments_mod-router_results_native-compat-acceptance.json` | `experiments/mod-router/results/native-compat-acceptance.json` | `ddc2b13d42836689cd95dfea5f81d19d69c596357e45c6af75bcdf0df67b731d` |
| `experiments_mod-router_results_native-fallback-acceptance.json` | `experiments/mod-router/results/native-fallback-acceptance.json` | `4b15646300b5ada1aa6a6a2a0f0e3b05542f4683e392dd68cd04ecb01fdfe5e1` |
| `experiments_mod-router_results_native-http-acceptance.json` | `experiments/mod-router/results/native-http-acceptance.json` | `68135d2f03a324fa43727b992aafef9ac32207f822c2b840afdf727d443da330` |
| `experiments_mod-router_results_native-interrupt-acceptance.json` | `experiments/mod-router/results/native-interrupt-acceptance.json` | `59357d191dba1d98e898048e2636126014d54d18fb657af8924e535365ca89d8` |
| `experiments_mod-router_results_native-live-compat-acceptance.json` | `experiments/mod-router/results/native-live-compat-acceptance.json` | `c11a562661837fed392551e7fab054a413608cfd5d7ba2ed742a89156cc3b2bc` |
| `experiments_mod-router_results_persistent-circuit-acceptance.json` | `experiments/mod-router/results/persistent-circuit-acceptance.json` | `c2a4f2996b40c52394c78793acf1394832eff9b960d85d28b34856b8b7f30db0` |
| `experiments_mod-router_results_persistent-clear-acceptance.json` | `experiments/mod-router/results/persistent-clear-acceptance.json` | `e1b52e0e867e56af872e8fae5f9095f2e77afea4fc832a4f311fa3ef58040471` |
| `experiments_mod-router_results_persistent-reload-acceptance.json` | `experiments/mod-router/results/persistent-reload-acceptance.json` | `a7775dab490dbfe2ef719ccda2520de9b27ad7a64cbc3be18edcf8debf228e33` |
| `experiments_mod-router_results_persistent-replace-acceptance.json` | `experiments/mod-router/results/persistent-replace-acceptance.json` | `a30f70c7102834d83245c947f5866603afcad486c79df0679effc7fdf2914ef7` |
| `experiments_mod-router_results_persistent-resume-acceptance.json` | `experiments/mod-router/results/persistent-resume-acceptance.json` | `1b327cdff5eed742de46da3d1b0f2e0d3f74c88539a307e6047a27228cc3a91e` |
| `experiments_mod-router_results_persistent-unload-acceptance.json` | `experiments/mod-router/results/persistent-unload-acceptance.json` | `6d5259919d4596d2b3643f90f904bef27344fd4ec5ce2e329e69c90729dd33c6` |
| `experiments_mod-router_results_runtime-gates.json` | `experiments/mod-router/results/runtime-gates.json` | `74a95323d5f60075edcb98c3b60ece172bb4c4a71d3f03a0bfa8c65a2ae31b3a` |
| `experiments_mod-router_results_subagent-routing-live.json` | `experiments/mod-router/results/subagent-routing-live.json` | `250c9ba1d3794a84381f40327e6e0a95c0ac843d76b4697df475fc6171675718` |
| `experiments_mod-router_results_team-canary.json` | `experiments/mod-router/results/team-canary.json` | `5661b7ef3459617fa663cb4da2dc61a7dd08485a22726e30ef126bb4ef5ab907` |
| `experiments_mod-router_results_team-rollback.json` | `experiments/mod-router/results/team-rollback.json` | `6450a4c6338d9b85349c431323516dc026e159bfcba76bed6b8e699ab8daa0d7` |
| `experiments_mod-router_results_trace-evaluation.json` | `experiments/mod-router/results/trace-evaluation.json` | `f666374d253be118c31de9aa8609e37c5547212e56fdbf77f006279ef839fded` |
| `experiments_mod-router_results_workflow-subagent-models.json` | `experiments/mod-router/results/workflow-subagent-models.json` | `f56f052b1bba13bf9ba5f48a656899b69443fa13ea79a40268f3e8beaa0f6da9` |
| `experiments_mod-router_scripts_native-candidate.mjs` | `experiments/mod-router/scripts/native-candidate.mjs` | `676e8b31122d3b5711b89f81ae8f3b235f17358b0402e2256f66f5b2fac26835` |
| `experiments_mod-router_scripts_native-candidate.test.mjs` | `experiments/mod-router/scripts/native-candidate.test.mjs` | `bff10f8c121b197ef02dfa63f11c6c615688a6dbc0ee3ba5c8d80fa194c9523d` |
| `experiments_mod-router_scripts_trace-eval.mjs` | `experiments/mod-router/scripts/trace-eval.mjs` | `a8b50188f86f85da443b3033016729ec18d4b422a45c250b376130cee510c841` |
| `experiments_mod-router_scripts_trace-eval.test.mjs` | `experiments/mod-router/scripts/trace-eval.test.mjs` | `7d8783d7c81528361ec5bf3995fa525fffbaf6afa4d7e0c74da89e2ffc78a5df` |
| `experiments_mod-router_tests_register.test.ts.txt` | `experiments/mod-router/tests/register.test.ts` | `716ee78a99e87df2b2b664df1842ce070a2edd9d48471a97cffd10546e5d8caa` |
| `lib_classifier-contract.mjs` | `lib/classifier-contract.mjs` | `56e0bf210497816523449c7a921ab9d210f71deb62609a38493067323b4f49cb` |
| `lib_cost.mjs` | `lib/cost.mjs` | `75b1e5b395eab7c54739139c1ae1cfa8308e9a032afe801257092da2954849fc` |
| `lib_modes.mjs` | `lib/modes.mjs` | `84138d3da7b88a3388c4836fce97e7e5fc33b54960625564f1e2efbe9e693fcd` |
| `lib_policy.mjs` | `lib/policy.mjs` | `f78077d03a77dd9020cd966e2678739dd8f66c387fc5381ed51f7b9ae6472fa3` |
| `lib_probe-results.mjs` | `lib/probe-results.mjs` | `01f4412fb8c176fdb01da82ae02729526f447fd015fbfe6bb003d0ede74f3105` |
| `lib_route.mjs` | `lib/route.mjs` | `c12d9b852adfc22a49a31b47a68f8cc465b96489578c21d8eaba85e6656e42bc` |
| `lib_savings.mjs` | `lib/savings.mjs` | `bca7776e1f57fa37e1997092597da629e50f3cb1574ecf19ed1e1cc94abee318` |
| `scripts_mode-matrix.mjs` | `scripts/mode-matrix.mjs` | `9dac17568de3a53129892f726edfd255ad86ac905153bbc58022c7c007cf66f0` |
| `scripts_probe-activity.mjs` | `scripts/probe-activity.mjs` | `50afe9975665c85e97b9de194e68877cdc9ce1f93beeea1d39e0a09cad27275a` |
| `scripts_probe-classifier.mjs` | `scripts/probe-classifier.mjs` | `057bbd2976809fbf85a90b8692b4f46aaf1f83f0d1ca635c1bdc37300e0cb8aa` |
| `scripts_probe-modes.mjs` | `scripts/probe-modes.mjs` | `5976d653361f296f4f5cf950819f85efea32a8ff89fbb589c62b13c674455627` |
| `scripts_probe-results.mjs` | `scripts/probe-results.mjs` | `01179300612148adb2bd9b40edc2b46561f9912d7b51a9fe39bcf919817876f5` |
| `test_activity-stats.test.mjs` | `test/activity-stats.test.mjs` | `044d851ec21228499c6693c539bea383b9942719beca403412ff19f1c2590e29` |
| `test_activity.test.mjs` | `test/activity.test.mjs` | `30f38750fe567470ff84026cdfdd7cae2c89c1f30ac2b77446483fc4039b77c8` |
| `test_band.test.mjs` | `test/band.test.mjs` | `e447ef50d0120d56b39c3219a7e29ab90e886d4ab821a2d5aa25bee1d655b0a2` |
| `test_classifier-apis.test.mjs` | `test/classifier-apis.test.mjs` | `8879c54f2c668e0808d90c151dd7e8bb6099a9fc01e7c0180a0064351736c887` |
| `test_classifier-client.test.mjs` | `test/classifier-client.test.mjs` | `35383806a0cd14216d1208f3830a10e0a879a20969fea84e9214375812da90ca` |
| `test_classifier-contract.test.mjs` | `test/classifier-contract.test.mjs` | `b6dfe2d10e8db28431c49440f8e8541186552c7f588044a296a990c505323d8e` |
| `test_config-file.test.mjs` | `test/config-file.test.mjs` | `fd96ab44611fb94c1aaeb7f377a240b2ad8a01bfcd870df9f820f7f00b1464c9` |
| `test_config.test.mjs` | `test/config.test.mjs` | `fc359a5e92d355a1eaf0c94525668ec39dcae888be62af4d472abf8c917c143b` |
| `test_cost.test.mjs` | `test/cost.test.mjs` | `cea67c59f37703052d7ffb3f1da4c3ce4f2fb3957cbb14b3885ac42b374f47b1` |
| `test_decision-golden.test.mjs` | `test/decision-golden.test.mjs` | `73f430efbc73ab1914140d8e630de078a9edbe28eedc87e8f2dc97fc08a09d6a` |
| `test_display.test.mjs` | `test/display.test.mjs` | `5e4ccf7d46ec9af9eac4acd85d97e2f0fd06e9cbf54644c8bc4fe2dbec13f7e0` |
| `test_facts.test.mjs` | `test/facts.test.mjs` | `575e2f9c00760ab8d8825a650d63f26fdcf6261c051ad8777e2b5f4819e971b5` |
| `test_fixtures_activity-off-requests.json` | `test/fixtures/activity-off-requests.json` | `91d50163452a24dbeadf870c7f3bbebb7015e9a52192076574afc558f4b61c07` |
| `test_fixtures_activity-probe.json` | `test/fixtures/activity-probe.json` | `e4569b6d49edab264cb930979019317525cc9e7d7afd3a7b84f1325b57894f04` |
| `test_fixtures_clef-flash-response.json` | `test/fixtures/clef-flash-response.json` | `b914b043afdfb8c30ede7f71dfdcc12b43ea5f9cf15042375984f08d89f6ec5d` |
| `test_fixtures_decision-golden.json` | `test/fixtures/decision-golden.json` | `2570ce3fde12f8e4956b12e82c0ee2ed25e5a4ced98bb6ea1514704504aefaac` |
| `test_fixtures_effort-support.json` | `test/fixtures/effort-support.json` | `515ed7c588dbe0e96eab2d4adc4a51fe943e1cfcd8a5037ca80c341034638cdb` |
| `test_fixtures_jev-activity-response.json` | `test/fixtures/jev-activity-response.json` | `4a44e3e8d24818d4cb11863db229963c76e461469e0c5b7fb6b2c19149522caf` |
| `test_fixtures_list-prices.json` | `test/fixtures/list-prices.json` | `47e56721d84a0be315f4aaebad3ba8e58fe5e52824854da5b4a01130b4234c3a` |
| `test_fixtures_mode-probe.json` | `test/fixtures/mode-probe.json` | `710cc04e06aaa47be44ea788724cd7c568d51e5fd0cd63b4df541ec24d056466` |
| `test_fixtures_model-features.json` | `test/fixtures/model-features.json` | `a45351312dea9e7c7a236674d167174832db7e60ce42cf9644d899da879c1828` |
| `test_fixtures_ollama-activity-response.json` | `test/fixtures/ollama-activity-response.json` | `f3a48bbad8fc58a04e413c8a75b5bcea156a9227d8ba3faefaf09dafc614ca9f` |
| `test_fixtures_ollama-route-response.json` | `test/fixtures/ollama-route-response.json` | `5bf8973cc57c2bc6ffdd88618d96c6b94cff579bf870ed932fde2b4373cda448` |
| `test_fixtures_openai-decisions-activity-response.json` | `test/fixtures/openai-decisions-activity-response.json` | `49b6ac15944778fd17e18a91f21924dd9a1c8709f1e354cc3302321f4ab1441d` |
| `test_fixtures_openai-decisions-response.json` | `test/fixtures/openai-decisions-response.json` | `d356518328674f2b83defb1d17d57ef4145dcdd58d15725480c60c159ed30987` |
| `test_harness.mjs` | `test/harness.mjs` | `1f47c4d3ec688b1d7041c1c44a745f98c877287692ed274eaf9dc8765966c773` |
| `test_helpers.mjs` | `test/helpers.mjs` | `0f408a51f5725c284e07bf010f2414dc007e9af565bb7a514efbf53f82042560` |
| `test_hook-band.test.mjs` | `test/hook-band.test.mjs` | `566fe1f8e80a8725d66db7c8127d6ae99f7399a9bbf1b3497acb8ef0d2663f0a` |
| `test_hook-credentials.test.mjs` | `test/hook-credentials.test.mjs` | `0a33a8b9ac39f3c585679ca5dcdd867be6cecfc0ecc112b03f5830e0336db8fd` |
| `test_hook-modes.test.mjs` | `test/hook-modes.test.mjs` | `159ee3020e82237a2bee0b231b08a007f3126cda7dbf9fe91385a2579d2d1453` |
| `test_hook-pane.test.mjs` | `test/hook-pane.test.mjs` | `3dcf54bc1fe32007dab5bff5da5321c665b3d21289ff13ab3a45d26ba662b303` |
| `test_hook-routing.test.mjs` | `test/hook-routing.test.mjs` | `b1b12c95dcd0d10e6ac25f7caa72ffc74e17b22b47c89304cc59abdd899e43d0` |
| `test_hook-subagents.test.mjs` | `test/hook-subagents.test.mjs` | `ac63350db9108360f3e8a0ce872bdea9ba62f9a81f2aff3330755044f8797950` |
| `test_migrate-config.test.mjs` | `test/migrate-config.test.mjs` | `24fab155e6059ea3d62b07fa328b7217f99304c6b7507128e1e025e03ea7d789` |
| `test_mode-matrix.test.mjs` | `test/mode-matrix.test.mjs` | `bfa839cbe924460e3543e399ca97aca5d78715a3f70afea38be143694e73df09` |
| `test_mode-routing.test.mjs` | `test/mode-routing.test.mjs` | `4c57b4da8224286962eeb6d34b2f7540f3ed2d3f925991fd6abd2e0be56b2809` |
| `test_modes.test.mjs` | `test/modes.test.mjs` | `82d16790d8ecc125353fd44bdc60afd610e3597630b60fe3d385241ef19fb9d0` |
| `test_native-mod.test.ts.txt` | `test/native-mod.test.ts` | `460aaaa3f13d56ee2a07df929cffc04c3e5b0da11633eb6c8e99a79809a88325` |
| `test_now-tab.test.mjs` | `test/now-tab.test.mjs` | `c2dcbe29a5806ae77503b39a6a3d50ea5f08e53ebf8862570f5bc82424951a76` |
| `test_panel.test.mjs` | `test/panel.test.mjs` | `1899aa047a05369b3f4330c8962d0de6b353dc00a99df10055589f9bde761bf0` |
| `test_plugin-root.test.mjs` | `test/plugin-root.test.mjs` | `366f31f728d7cc92acefa440dcd1e8f86ca1ad3c44602dd8456e7ebbac82d186` |
| `test_policy.test.mjs` | `test/policy.test.mjs` | `b0d94860c5104659bf3b0ec3219e8a79eecbf39a563743e42c6bbdef2268c8de` |
| `test_prices.test.mjs` | `test/prices.test.mjs` | `49eaa9da699ce8dc991849f1956843cedbc93e579fa9dedef4092b4e1e24c820` |
| `test_probe-results.test.mjs` | `test/probe-results.test.mjs` | `2494ba5fea9b8fec1946633bf369167dfac974751e68b46ac88bb0174c509dcd` |
| `test_route.test.mjs` | `test/route.test.mjs` | `fea18e8a3fb22b63e559726f19542ac3335f311018cfb984c51cfbf3e6ed5f31` |
| `test_savings-view.test.mjs` | `test/savings-view.test.mjs` | `d08d2b52017e0975891191875abe96aa825e1507fc315cdc1727c53568e11a02` |
| `test_savings.test.mjs` | `test/savings.test.mjs` | `2eac745d886f1f371d62f7d33ff947f9af312a6d00e8e07ef81d4e260393bc39` |
| `test_subagents.test.mjs` | `test/subagents.test.mjs` | `19a1720753d70e4764dfd98e455a002161117b566045edb35fcdd767df8304aa` |
| `test_usage-fixtures.mjs` | `test/usage-fixtures.mjs` | `58f9ad2dd464f7f124065a9e461a4d864e3dc65ab72b700e796891c048a013b1` |
| `test_usage-view.test.mjs` | `test/usage-view.test.mjs` | `f15e0a472fe5a768813570237b56f43139bccdcf44e3a521406ede8903b0243b` |
| `test_usage.test.mjs` | `test/usage.test.mjs` | `c73f80811520a505ced4262099baeeaeff588b9a95cd6a3e7fc182be4febfcfa` |
| `test_view.test.mjs` | `test/view.test.mjs` | `c760aae93a324298e67c932fc7bb1d228b9cf1ff3195c14095d8bd20174a2924` |

Note: test files are stored with a `.txt` suffix so that test runners such as `claude plugin test` do not run them. The content is unchanged and the sha256 values above still match.
