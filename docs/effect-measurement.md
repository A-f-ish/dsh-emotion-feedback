# Does the loop actually change the model's output?

This is a short summary of the local injection **ON/OFF ablation** that motivated the plugin's
"self-consistency" claim. The raw per-session, per-turn table lives in the development checkout
(`experiment/ablation-report.md`); it is not part of the published package.

## Design

- Same story-driven task, 11 turns per session, run by the same headless driver.
- **ON arm** (12 sessions, 132 turns): the plugin judges each turn and injects the state before the next one.
- **OFF arm** (12 sessions, 132 turns): identical code path — judging, blending, history — with a profile
  overlay that only sets `config.inject: false`.
- 264 assistant replies in total, 251 judge records (6 ON / 7 OFF turns lost their judgement — see Known
  issues; that loss rate is independent of injection).

Why this design isolates the effect: the judge is a **stateless single-turn call** that only ever sees the
assistant's own output (`lib/index.js:641-660`), and its system prompt is just `config.prompt` + the emotion
vocabulary (`lib/index.js:548-552`). It cannot observe the injected message. So any ON/OFF difference in
judged state must come from the **text the working model wrote**.

## Results

Session-level permutation tests (20,000 permutations):

| Signal | ON | OFF | Δ | p |
| --- | --- | --- | --- | --- |
| Adjacent turns judged the same emotion | 77.2% (88/114) | 54.0% (61/113) | +23.2 pp | < 0.01 |
| "Curious" (好奇) stickiness | 87.0% (80/92) | 67.9% (53/78) | +19.1 pp | — |
| Reply contains the currently injected emotion word | 11.4% (13/114) | 4.4% (5/113) | +7.0 pp | 0.07 |
| Reply mentions any emotion word | 12.9% | 6.1% | +6.8 pp | 0.09 |
| Reply mentions "emotion / mood / state" | 3.0% | 3.0% | 0.0 pp | 1.00 |
| Mean reply length (chars) | 177 | 208 | −31 | 0.43 |
| r(previous intensity, this turn's length), within session | −0.111 | −0.114 | +0.003 | 0.98 |

Mechanism checks: injection ⇄ recorded state agreed in 114/114 cross-checks, and judged intensity averaged
0.56 in both arms (so the arms differ in *where the trajectory goes*, not in how strongly it is judged).

## Reading

- **Established:** the injection measurably changes the emotion trajectory the judge reconstructs — the state
  is significantly more self-consistent when it is actually fed back.
- **Trend only:** an explicit lexical fingerprint in the reply (the current emotion word appears ~2.6× more
  often) is visible but not significant at this sample size.
- **Not supported:** an earlier offline probe's "intensity → reply length, r ≈ 0.30" correlation does not
  survive the ON/OFF control (pooled r ON 0.308 vs OFF 0.421; the within-session mean is ≈ −0.11 in both
  arms). The plugin's effect is on the state layer, not on verbosity.
- **Not measured:** task-level output quality; 12 sessions per arm on one story is a small sample; the judge
  and the working model come from the same provider.

Reproduce with `experiment/ablation.mjs` + `experiment/ablation-analyze.mjs` in the development checkout
(`experiment/patches/inject-off.yml` is the OFF overlay).
