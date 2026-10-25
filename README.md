# dsh-emotion-feedback

A [DSH](https://github.com/deepseek-ai/deepseek-harness) plugin that **judges the working model's *own* emotion
each turn and silently re-injects it before the next turn starts.**

> Opposite direction from the usual "sense the user's mood, then adapt the reply" plugins: what is judged and
> fed back here is the *assistant's* own state — a loop of **self-observation → state carry-over → behavior shift**.

- Host plugin (`dsh.bundle`) + browser panel (`dsh.client`) in one package, no build step.
- Zero model calls when the keyword layer hits; one lightweight call (temperature 0, single-line JSON) only otherwise.
- Judging itself never reaches the transcript — the user sees the *next* turn's tone, not the machinery.

## The loop

```
① turn ends      agent/turn-stopping   (serial, awaited)
   take the last assistant message of the turn
        ↓  local keyword layer first (a hit costs 0 model calls)
        ↓  otherwise, when useLlm=true → one lightweight llm.stream judge
           (temperature 0, one-line JSON, PROTOCOL: EMOTION_TONE_JUDGE v1)
   result updates this session's emotion state — no session event is appended,
   so the judging step stays invisible to the user

② next turn      agent/pre-step        ({ prepend: true })
   render the current state as one synthetic user message
   (source.kind = 'emotion-feedback') and append it to this request
        ↓
   the working model answers while carrying that state, and is told not to
   explain where it came from
```

Injection is idempotent per session per turn, and is skipped entirely below `minIntensity`.

## Emotion state

```js
{
  emotion: '愧疚',        // labels outside the vocabulary are kept as-is, flagged outOfList: true
  intensity: 0.62,        // 0-1
  reason: '关键词「抱歉」',
  source: 'rule',         // 'rule' | 'llm'
  outOfList: true,        // only when the label is not in config.emotions
  turn: 7,
  history: [{ turn: 7, emotion: '愧疚', intensity: 0.62 }, /* … */],
}
```

- **Labels are never rewritten.** An older revision mapped unknown labels to `平静` ("calm"), which erased
  every nuance the judge produced; now an out-of-vocabulary label is only flagged `outOfList: true`.
  The vocabulary is used for two things: the preferred options in the judge prompt and the legal label set
  of the keyword rules.
- **Negation guard.** A keyword hit is discarded when a negation word (`不 / 没 / 无 / 非 / 避免 / 规避 / 降低 /
  减少 / 最低 / 较低 / 可控`) appears near it — this blocks reverse hits such as "不确定" or "风险可控".
  Set `negations: []` to turn the guard off.
- **Blend, don't replace.** The old intensity is first decayed by `turnDecay ^ turns-elapsed`, then:
  same emotion → `max(old, new)`; emotion switch → `max(old × takeoverRetain, new)`.
- **Idle decay is disabled.** Reading a snapshot used to apply `0.5 ^ (idleMinutes / halfLifeMinutes)`; that
  module is commented out (the original implementation is kept in `rehydrate()` for reference and the
  `halfLifeMinutes` field still exists but has no effect). Intensity now only moves through `blend()`.

## Install

```powershell
# from npm (once published)
dsh plugin --profile <profile> add dsh-emotion-feedback

# from a local checkout — the path is recorded as a junction, so editing the
# checkout is the same as editing the installed plugin
dsh plugin --profile <profile> add "C:\path\to\dsh-emotion-feedback"
```

`dsh plugin add` runs `pnpm add`, verifies `dsh.bundle` in `package.json`, and merges `cordis.patch.yml`
into the profile. The single `insert` row in `cordis.patch.yml` is the whole wiring:

```yaml
- insert:
    - id: emotion-feedback
      name: 'dsh-emotion-feedback'
```

> **DSH must be fully restarted.** Installation only merges the bundle patch layer into the config graph;
> plugin module loading and `apply()` happen while the host assembles the plugin generation. The browser half
> is a static bundle with no HMR, so a new browser tab is not enough.
>
> You can also install it from inside a DSH session by asking the agent to call the `plugin_manager` tool's
> `install_bundle` action with this directory.

`INSTALL.md` is a longer Chinese handoff guide (unpack → install → 5 self-checks → troubleshooting).
A Chinese version of this README lives in `README.zh.md`.

## Configuration

Give the plugin row a `config:` block in a profile patch; every field has a default.

```yaml
- id: emotion-feedback
  config:
    minIntensity: 0.3     # injection threshold (default 0.2)
    judgeModel: ''        # judge model; empty = the session's default model
    judgeProvider: ''     # same, for the provider
    useLlm: true          # allow the model judge when keywords miss
    inject: true          # false = judge and keep state, never inject
    includeReason: false  # true = append the judge's reason to the injected text
    timeoutMs: 6000       # single judge timeout; on timeout the old state stays
    turnDecay: 0.9        # per-turn intensity decay
    takeoverRetain: 0.35  # retained fraction of the old intensity on emotion switch
    disabled: false       # emergency switch: true = silences everything (wins over enabled)
    debug: false          # true = print the judge result each turn
```

| Field | Default | Effect |
| --- | --- | --- |
| `enabled` / `inject` | `true` | master switch / whether to inject (off = judge only) |
| `disabled` | `false` | emergency switch, takes priority over `enabled`, no uninstall needed |
| `minIntensity` | `0.2` | injection threshold |
| `judgeProvider` / `judgeModel` | `''` | judge target; falls back to `agent.options` → session request header → session default model |
| `useLlm` | `true` | whether the model judge layer is allowed |
| `timeoutMs` | `6000` | single judge timeout |
| `turnDecay` / `takeoverRetain` | `0.9` / `0.35` | blend rules above |
| `halfLifeMinutes` | `10` | **inactive** (kept for reference only) |
| `injectPerStep` | `false` | also allow injection on later steps of the same turn |
| `emotions` / `rules` / `prompt` / `template` | built-in | vocabulary (15 labels) / keyword rules / judge prompt / injection text |
| `negations` | see above | negation word list; `[]` disables the guard |
| `panelEvent` / `panelRoute` / `statusTool` | `true` | session event / read-only HTTP route / `emotion_status` tool |
| `persistHistory` | `true` | write per-session history to disk (kept 30 days) |

The full schema is `Config` in `lib/types/index.d.ts`.

## Surfaces

### Browser panel

Docked above the composer at the `conversation.composer.dock` slot, labelled "情绪" (emotion). Collapsed it is
a coloured dot + emotion + intensity; expanded it shows the intensity bar, the latest judge (time, previous
emotion, reason, source `关键词`/`模型判定`, out-of-vocabulary flag, raw judge value and blend factor when the
host snapshot is reachable), a 40-point intensity curve, and the last 8 judgements.

The panel needs **no extra endpoint**: every injection is written into the session log as
`user/message` + `source.kind = 'emotion-feedback'` + `surfaceOp: 'append'`, and the browser half reads the
conversation nodes through the standard slot prop `useChat((s) => s.legacy.nodes)`. So the curve is literally
*what the model received*. The optional `GET /emotion-feedback/state?sessionId=…` route (Web deployments)
only adds host-side detail; when it is unreachable the panel degrades silently.

### `emotion_status` tool (read-only)

Lets the *model* read its own current state: emotion, intensity, reason, source (`rule` / `llm`) and the recent
trajectory. It reads the same in-process state as the panel. Registration is reactive
(`ctx.inject(['tools'], …)`), and `@deepseek-ai/dsh-tools` is imported lazily, so a host without that package
loses the tool and nothing else.

### History file

`<DSH_HOME>/emotion-feedback/history/<sessionId>.json` — per-turn judgement records, kept 30 days.
Disable with `persistHistory: false`.

## Does it actually work?

Measured locally with an injection **ON/OFF ablation**: 24 sessions × 11 turns per arm (264 replies) of the
same task, one arm with `inject: false`. Because the judge call is stateless and single-turn (it only ever sees
the assistant's own output), the judge cannot see the injection — any ON/OFF difference must come from the
text the working model wrote.

| Signal | ON | OFF | Δ |
| --- | --- | --- | --- |
| Adjacent turns judged the same emotion | 77.2% (88/114) | 54.0% (61/113) | **+23.2 pp** (session-level permutation, p < 0.01) |
| Reply contains the currently injected emotion word | 11.4% (13/114) | 4.4% (5/113) | +7.0 pp (p ≈ 0.07) |
| Reply mentions any emotion word | 12.9% | 6.1% | +6.8 pp (p ≈ 0.09) |
| Mean reply length (chars) | 177 | 208 | −31 (p ≈ 0.43) |

Read it as: the loop measurably changes **where the emotion trajectory goes** (self-consistency of the judged
state), while a direct lexical fingerprint in the answer is only a trend. Task-level output quality was not
shown to differ. Details, limitations and the raw per-turn table are in `docs/effect-measurement.md`.

## Design trade-offs

- **Judge the turn's final answer, not every tool step.** The signal is the visible stance at turn end;
  judging every step adds noise and latency.
- **Keyword layer first.** `agent/turn-stopping` is serial and awaited, so an unconditional model call would
  add visible latency to every turn. A keyword hit costs zero calls.
- **State lives in an in-process `Map`.** Emotion is transient, and "do not show it to the user" is a hard
  requirement; the host's `sessionProjections` / `storageDomain` would require zod record schemas *and*
  persist the state into the session store.
- **The judge call declares no `purpose`.** `purpose` is a closed `'compaction' | 'session-title'` union that
  third-party plugins cannot extend, so the call is identified by `source.kind` and by the
  `PROTOCOL: EMOTION_TONE_JUDGE v1` header in its prompt.
- **No self-judging loop.** The plugin does not listen to the `llm/stream` waterfall its own judge call
  travels through.

## Crash contract (hard guarantee)

`agent/pre-step` is a waterfall and the host reads `decision.kind` right after it
(`@deepseek-ai/dsh-agent-loop/lib/index.js:920`). A listener that returns `undefined` therefore fails the whole
turn at its first step. This plugin's listener obeys three rules:

1. `await next()` is always wrapped in `try/catch`; on a downstream throw it logs and returns its own valid
   `{ kind: 'enter', messages }`.
2. Every downstream value goes through `safeDecision()`; anything that is not a non-null object is replaced by
   a valid `enter` decision plus a forensic log line.
3. The injection logic is itself wrapped in `try/catch` and falls back to the downstream decision.

`enabledNow()` (`config.disabled !== true && config.enabled !== false`) is checked at both listener entries, so
`disabled: true` silences the plugin completely without uninstall or restart. On the browser side the panel
wraps itself in its own error boundary so a shape change in any of its three inputs turns into "panel
unavailable" instead of taking down the composer dock.

## Verification

```powershell
node scripts/validate.mjs   # manifest conformance (dsh.bundle / dsh.client / icon / locale / exports / files)
node test/all.mjs           # 4 suites, ~1300 assertions, no host needed
```

`validate.mjs` re-checks this package against the rules the DSH implementation actually enforces
(`dsh-package-manifest`, `dsh-client-modules`, `dsh-app-boot` display metadata, and the community registry's
hard requirements). Functional check after a restart: send "the previous interface design was wrong, reflect
on it" and then any follow-up — the follow-up's turn should contain one synthetic `user/message` with
`source.kind === 'emotion-feedback'` right after `step/start`, and the panel badge should show an emotion.

## Compatibility

- DSH `0.2.0-rc.2` (declared as an optional peer `>=0.2.0-rc.2 <0.3.0-0`).
- `@deepseek-ai/cordis` `>=4.0.4 <5.0.0`; `@deepseek-ai/schemastery ~3.18.4` is the only runtime dependency.
- Node `^22.19.0 || >=24.0.0`. No build step: `lib/index.js` (host) and `lib/client.js` (browser) ship as source.

## Known issues

- **A judgement can be silently dropped** (observed: 10 judgements across 11 turns, ~5%). That turn keeps the
  previous state; nothing errors and the conversation continues. Tracked in the optimization queue.
- State is in memory: right after a restart there is nothing to inject until the first judgement of the new
  process (the history file is only for display).
- The injected message *is* part of the session history — it is a synthetic user message, invisible as a
  "feedback" bubble in the UI, but visible in the raw session log. Set `inject: false` to keep it out.

## Development

```powershell
git clone https://github.com/A-f-ish/dsh-emotion-feedback
cd dsh-emotion-feedback
npm install          # only @deepseek-ai/schemastery (usually already present in a DSH profile)
node scripts/validate.mjs
node test/all.mjs
```

Both halves are hand-written ESM; there is no bundler, no TypeScript build and no transpile step. Please keep
it that way: the host loads `lib/index.js` directly and the browser half is injected as a plain classic script
that only calls `window.__ModuleLoader__.load({ id: 'dsh-emotion-feedback', factory })`.

## License

MIT — see `LICENSE`.
