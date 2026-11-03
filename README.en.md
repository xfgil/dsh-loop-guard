# dsh-loop-guard

> Two brakes for a working agent loop: **stop when the same action keeps hitting the
> same wall**, and **narrate long-running work so the user knows it is still alive**.

## What it fixes

Two failure shapes that actually happened (measured, not imagined):

| Symptom | Measured |
|---|---|
| **Spinning in place**: `write script → run → tweak and write again → run`, a dozen times | 362 s, 16 tool calls, the user only saw "it is still thinking" |
| **Heads-down grind**: running tools back to back, never saying a word | 847 s, 59 tool calls, zero output in between |

Neither is a context-length problem. A context-compression plugin cannot fix this —
the loop stays in the same rut no matter how short the context is.

## What it does

### 1. Stop on repetition

Every tool call is booked before execution. If any limit is hit, the call is
**refused** and a message is fed back as the tool result:

- the same **target** touched N times (default 6) — the target is a file path or a
  command, **not** the full argument fingerprint. This matters: in a rewrite loop every
  version of the script has different content, so fingerprints never repeat, but the
  target does not change.
- the **identical** call repeated N times (default 3);
- N consecutive failures (default 5), even across different tools — that points at a
  dead end rather than a bad call;
- more than N tool calls in a single turn (default 40).

The stop message deliberately offers a way out:

> Stop: `file:D:/x.py` has been touched 12 times — this path is dead. Do not try
> another variant of the same thing. Reply to the user now and say three things:
> what you tried, where you are stuck, what you need them to decide. Say it cannot be
> done if it cannot — that beats spinning for another ten minutes.

That last line is deliberate: when stuck, a model's default is to keep trying,
assuming one more attempt will work. Without a "give up" option it just changes posture
and keeps hitting the wall.

### 2. Narrate long tasks

If a turn has been running longer than N seconds (default 180) without a single word of
visible text, a reminder is injected on the next step. The trigger is **time since the
turn started**, not "time since the last reminder" — the latter can be skipped entirely
by one very long tool call.

Once the agent has actually spoken, it is not nagged: it is already syncing progress,
and the plugin should stay quiet.

## Install

```bash
dsh plugin add dsh-loop-guard --profile <your profile>
```

Or manually: clone the repo anywhere, then in your profile's `package.json`:

```json
"dependencies": { "dsh-loop-guard": "link:D:/Plugins/dsh-loop-guard" }
```

and add `dsh-loop-guard` to `dsh.profile.bundles`.

Zero dependencies. It touches no QQ, persona, or channel-specific code — it hooks the
host's generic `agent/pre-step` and `ctx.tools.guard()`, so it applies to **every
session**: web, subagents, and any future channel.

## Configuration

All keys have defaults; nothing needs configuring.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `maxSameTarget` | `6` | same file/command touched this many times |
| `maxSameCall` | `3` | identical calls |
| `maxFailures` | `5` | consecutive failures |
| `maxCallsPerTurn` | `40` | hard cap on tool calls per turn |
| `muteAfterTrip` | `true` | trip once per turn, not once per step |
| `narrateAfterMs` | `180000` | silence before a nudge (`0` disables) |
| `narrateEveryMs` | `240000` | minimum gap between nudges |

## Observability

Read-only `GET /loop-guard` returns counters and the current turn's ledger. There is
deliberately **no** kill switch or restart button: the point is to stop leaving the user
hanging, not to hand them a remote control.

## Boundaries

- **Never rewrites the system prompt.** Injection appends a message via
  `agent/pre-step`, so prefix caching is unaffected.
- **No cross-turn grudges.** The ledger resets every turn.
- **Fails open.** If the guard itself throws, the call goes through — spinning a bit
  longer beats deadlocking the tool layer.
- **Does not judge whether the task is worth doing.** Only "you are going in circles"
  and "you have been silent too long".

## DSH compatibility

`>=0.2.1-rc.2`. The two hooks used (`agent/pre-step` waterfall with `{ global: true }`,
and `ctx.tools.guard()`) are both present in the 0.2.1 series.

## Development

```bash
node test/selftest.mjs
```

Tests cover the pure judging logic only. One group replays the real call sequence from
the 2026-10-26 turn 33, pinning down that such a loop is stopped within a dozen steps.
