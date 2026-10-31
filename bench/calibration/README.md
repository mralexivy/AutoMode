# Human calibration scores

Judge scores become a headline only after they agree with people. Put one JSON line per scored run in `human-scores.jsonl`:

```json
{"run_id": "the row's run_id", "scorer": "a nickname", "correctness": 4, "completeness": 4, "scope": 5, "tests": 3, "maintainability": 4}
```

- Scores use the 1 to 5 rubric in `bench/lib/grade-core.mts`.
- Score from the diff alone. Do not look at the arm, the cost, the hidden-test result or the judge's score.
- The target is 50 to 100 runs, spread across arms and cohorts.
- These scores must come from people. Never fill this file from a model.

Then compare:

```bash
node bench/calibration-report.mts --grades bench/results/your-run.grades.jsonl --human bench/calibration/human-scores.jsonl
```
