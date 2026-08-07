# Token Reduction Plan — Sub-plan Index

**Parent plan:** `Plans/17.Token reduction plan - Opus 5 Medium.md`  
**Target:** 60-75% input-token reduction (Pacman4: ~31M → ~8-12M; ~$206 → ~$60-80)  
**Sub-plans:** 9 independent contexts, each designed for a 200k-context model

---

## Execution Order & Dependencies

```
17.1 Config Flags (foundation)
 │
 ├──► 17.2 Tool Result Truncation ──────────────────────────►┐
 ├──► 17.3 History Compaction ──────────────────────────────►│
 ├──► 17.4 Repair Loop + Conventions Digest ───────────────►│
 ├──► 17.5 Compact Personas & Schema Stripping ────────────►│
 ├──► 17.6 Agent Respawn System ──► 17.7 Git Tools/Ceilings►│
 └──► 17.8 State Slicing & CONTEXT_COMPACT Cleanup ────────►│
                                                             │
                                              17.9 Measurement & Verification
```

**Phase 1 — Foundation (must run first):**
- `17.1` Config Flags

**Phase 2 — Independent changes (can run in parallel after 17.1):**
- `17.2` Tool Result Truncation
- `17.3` History Compaction
- `17.4` Repair Loop + Conventions Digest
- `17.5` Compact Personas & Schema Stripping
- `17.6` Agent Respawn System
- `17.8` State Slicing & CONTEXT_COMPACT Cleanup

**Phase 3 — Depends on 17.6 (run after respawn is in place):**
- `17.7` Git Tools Removal & Ceiling Tuning

**Phase 4 — Final (run last, measures everything):**
- `17.9` Measurement, Reporting & Final Verification

---

## Sub-plan Summary

| # | Name | Original Step(s) | Complexity | Expected Saving | Key Files |
|---|---|---|---|---|---|
| 17.1 | Config Flags & Foundation | Step 1 | Low | N/A (enables others) | `config.ts`, `.env.example` |
| 17.2 | Tool Result Truncation | Step 2 | Medium | 15-20% | `truncate.ts` (new), `workspace-tools.ts`, `shell-tools.ts`, `git-tools.ts` |
| 17.3 | History Compaction | Step 3 | **High** | **25-35%** | `history-compactor.ts` (new), `agent-factory.ts` |
| 17.4 | Repair Loop + Conventions | Steps 4+6 | Medium | 10-16% | `nodes.ts`, `structured-output.ts`, `conventions-digest.ts` (new), `coding-conventions.ts` |
| 17.5 | Compact Personas & Schema | Step 5 | **High** | 10-15% | `persona.ts`, `agent-factory.ts`, `dev-agent.builder.ts`, `dispatcher.ts`, `pr-workflow.ts` |
| 17.6 | Agent Respawn System | Step 8 | **High** | 10-15% | `agent-respawn.ts` (new), `tool-loop-guard.ts`, `pr-workflow.ts`, `event-bus.ts` |
| 17.7 | Git Tools & Ceilings | Step 7 | Low | 8-12% | `dev-agent.builder.ts`, `config.ts` |
| 17.8 | State Slicing & Cleanup | Step 9 | Medium | <1% (quality fix) | `nodes.ts`, `pr-workflow.ts`, `config.ts` |
| 17.9 | Measurement & Reporting | Step 10 | Medium | N/A (measurement) | `token-tracker.ts`, `token-report.ts`, `nodes.ts` |

---

## File Conflict Matrix

Files touched by multiple sub-plans (run these sub-plans sequentially, not in parallel):

| File | Sub-plans | Risk |
|---|---|---|
| `src/config.ts` | 17.1, 17.7, 17.8 | Low — each touches different sections |
| `src/conductor/nodes.ts` | 17.4, 17.8, 17.9 | Medium — different functions but same large file |
| `src/conductor/pr-workflow.ts` | 17.5, 17.6, 17.8 | Medium — 17.5 threads isMaintainMode, 17.6 adds respawn loop, 17.8 removes CONTEXT_COMPACT |
| `src/agents/_shared/agent-factory.ts` | 17.3, 17.5 | Low — 17.3 adds preModelHook, 17.5 changes schema stripping |
| `src/agents/developers/dev-agent.builder.ts` | 17.5, 17.7 | Low — 17.5 threads isMaintainMode, 17.7 changes tools/ceilings |
| `tests/loop-guard.test.ts` | 17.6, 17.7 | Low — 17.6 changes API shape, 17.7 changes ceiling values |

**Recommended parallel groups (no file conflicts):**
- Group A: 17.2 + 17.3 (different tool files vs agent files)
- Group B: 17.4 (repair + conventions — unique files)
- Group C: 17.5 + 17.8 share `pr-workflow.ts` — run sequentially
- Group D: 17.6 then 17.7 (strict ordering required)

---

## New Files Created Across All Sub-plans

| File | Sub-plan | Purpose |
|---|---|---|
| `src/tools/_shared/truncate.ts` | 17.2 | Head/tail tool-result truncation |
| `tests/truncate.test.ts` | 17.2 | Truncation unit tests |
| `src/agents/_shared/history-compactor.ts` | 17.3 | ReAct history compaction |
| `tests/history-compactor.test.ts` | 17.3 | Compaction invariant tests |
| `src/utils/conventions-digest.ts` | 17.4 | Distilled in-prompt conventions |
| `tests/persona.test.ts` | 17.5 | Persona constraint tests |
| `src/conductor/agent-respawn.ts` | 17.6 | Deterministic handoff summary |
| `tests/agent-respawn.test.ts` | 17.6 | Handoff extraction tests |

---

## Per Sub-plan Context Budget Estimate

Each sub-plan is designed to fit within a 200k-context model session:

| Sub-plan | Files to read | Estimated input context | Headroom |
|---|---|---|---|
| 17.1 | 2 files (~630 lines) | ~5k tokens | ~195k |
| 17.2 | 4 files (~670 lines) + plan | ~15k tokens | ~185k |
| 17.3 | 2 files (~340 lines) + plan | ~12k tokens | ~188k |
| 17.4 | 4 files (~480 lines) + plan | ~15k tokens | ~185k |
| 17.5 | 5 files (~2,100 lines) + plan | ~25k tokens | ~175k |
| 17.6 | 5 files (~2,100 lines) + plan | ~25k tokens | ~175k |
| 17.7 | 3 files (~490 lines) + plan | ~8k tokens | ~192k |
| 17.8 | 4 files (~3,800 lines) + plan | ~35k tokens | ~165k |
| 17.9 | 5 files (~3,000 lines) + plan | ~30k tokens | ~170k |

All sub-plans have ample headroom for iterative editing, test output, and error resolution within a 200k context window.
