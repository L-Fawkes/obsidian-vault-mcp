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
| TOK-005 | Align pipeline documentation with implemented behavior | Stale instructions could cause Claude to re-investigate or propose already completed work | Docs now distinguish implemented durable staging/atomic publication from pending slicing, atlas and map export | Direct token delta: 0 measured; potential avoided context/rework is unmeasured and not claimed | Low |\n| TOK-006 | Deterministic crop/atlas/Tiled export primitives | Manual coordinate math and repeated explanations could cause rework; no measured baseline | Deterministic functions produce crop PNGs, atlas manifest, TSX and explicit-placement TMX; tests exercise behavior | Model-token delta: 0 measured; deterministic CPU operations add no model calls by themselves. Additional context to invoke them is not yet measured | Low |\n| TOK-007 | Expose crop/atlas/Tiled operations as MCP tools | Manual code-level orchestration would require extra setup/context; no baseline usage telemetry | Claude can call three bounded MCP tools; crop/atlas outputs remain staged and hash-checked | 0 measured direct token delta; expected reduction in setup/re-explanation is unmeasured. Tool results add structured response tokens per call | Low |\n| TOK-008 | Bound TMX resource use, validate GIDs and derive staged paths from IDs | Unbounded map dimensions could allocate excessive memory; trusting stored manifest paths or out-of-range GIDs could cause invalid exports | TMX grid/placements/GIDs are bounded; crop reads derive paths from validated IDs | Model-token delta: 0 measured; deterministic validation adds no model call. Tool error/success response token delta not measured | Medium |\n| TOK-009 | Add dry-run-first TTL cleanup for stale staging | Old intermediate files accumulate and require manual inspection; cleanup risk if based on incomplete listings | Default 30-day dry-run; explicit opt-in deletion only after validated metadata and complete Git tree listing | 0 measured direct model tokens; cleanup is deterministic. Structured listing response adds tokens proportional to stale candidates; unmeasured | Medium |

## Current measurement status

No reliable model-usage telemetry is wired into this repository. Therefore no numeric token totals or guaranteed savings are claimed yet. The next instrumentation step is to record per-stage provider usage metadata (input, output, cached input, model, task ID) without storing prompts, secrets, or image contents.

## Required entry for future changes

For each process or attachment change, record: problem, before/after flow, input/output token delta per operation, operation frequency, cumulative expected delta, measurement method, confidence, and any new token cost.

| TOK-010 | Retry atomic Git commits on recognized concurrent branch updates | Concurrent MCP calls could collide at branch ref update and require manual retry | Rebuild commit against newest HEAD, at most 3 attempts, no force push; unknown errors fail closed | 0 measured direct model tokens; avoids repeated user/Claude intervention in recognized conflicts, but actual savings unmeasured | Medium |


| TOK-011 | Especificação operacional do Módulo 01 e reconciliação do status da pipeline | Claude precisava deduzir etapas/gates e podia re-investigar funções já implementadas por documentação contraditória | Um roteiro único define cinco categorias, manifestos, gates e critérios; status da pipeline foi reconciliado | 0 tokens diretos medidos nesta edição; economia futura não mensurada. A leitura do novo roteiro acrescenta contexto: estimativa de +1.000 a +1.600 tokens por execução completa, dependendo do tokenizer/modelo e do quanto Claude já conhece; confiança baixa | Low |
