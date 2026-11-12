# Token efficiency ledger — RPG Pixel Art

This ledger tracks model-token impact for process and architecture changes. Values are estimates until application-level token telemetry is available.

## Measurement rules

- Count only tokens sent to and returned by AI models; image bytes, GitHub traffic, browser storage and deterministic CPU work are not model tokens.
- Prefer exact counts from provider usage metadata when available. Otherwise estimate with a tokenizer for the model actually used and label the estimate.
- Compare the same task, same image/reference, same output requirements and same model.
- Record both per-operation delta and expected monthly delta: `delta × expected operations`.
- Negative delta means tokens saved; positive delta means extra tokens.
- Never claim savings from code size alone. Savings must come from fewer model calls, smaller context, shorter payloads or less rework.

## Change register

| ID | Change | Baseline | New flow | Token delta | Confidence |
|---|---|---|---|---:|---|
| TOK-001 | Keep editor reference out of draft exports | A draft could include the visible reference, causing Claude to receive/re-analyse source pixels along with edits | Draft contains only the editable layer; reference is read separately only when needed | Expected saving: reference-image payload tokens per draft review; exact amount depends on image encoding and model vision tokenizer | Medium |
| TOK-002 | Preserve layer on resize | Resizing could erase work and require re-drawing/re-sending the draft | Resize preserves overlapping editable pixels | Avoided rework tokens per resize incident; not yet measurable | Medium |
| TOK-003 | Interpolate pointer strokes | Gaps could require manual correction and another AI review | Deterministic Bresenham interpolation fills sampled gaps | Avoided correction/review tokens per affected draft; not yet measurable | Medium |
| TOK-004 | Editor regression checks | Regressions could cause repeated debugging exchanges | Fast local CI checks catch three known editor regressions before review | No direct per-call saving; expected reduction in debugging/rework turns | Low |
| TOK-005 | Align pipeline documentation with implemented behavior | Stale instructions could cause Claude to re-investigate or propose already completed work | Docs now distinguish implemented durable staging/atomic publication from pending slicing, atlas and map export | Direct token delta: 0 measured; potential avoided context/rework is unmeasured and not claimed | Low |

## Current measurement status

No reliable model-usage telemetry is wired into this repository. Therefore no numeric token totals or guaranteed savings are claimed yet. The next instrumentation step is to record per-stage provider usage metadata (input, output, cached input, model, task ID) without storing prompts, secrets, or image contents.

## Required entry for future changes

For each process or attachment change, record: problem, before/after flow, input/output token delta per operation, operation frequency, cumulative expected delta, measurement method, confidence, and any new token cost.
