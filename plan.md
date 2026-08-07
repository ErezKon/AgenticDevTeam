# Fix: AgenticDevTeam Missing Integration/Wiring Layer

The AgenticDevTeam pipeline decomposes projects into individual components but never generates an "integration" task that wires them together into a working application, resulting in apps that build but don't run.

---

## Root Cause Analysis

### What happened with Pac-Man

The pipeline produced 58 assignments across 12 branches, each implementing an isolated component:

| Branch | What was built | Files |
|--------|---------------|-------|
| `chore/scaffold` | Vite project, ESLint, CI, maze renderer | `main.ts` (stub), configs |
| `us-001-pacman-movement` | PacMan class, score, lives, level completion | `pacman.ts`, `score.ts`, `lives.ts` |
| `us-002-ghost-core` | Ghost base class, state machine, chase/scatter | `ghost.ts` |
| `us-003-input` | Keyboard, touch, on-screen controls | `keyboard.ts`, `touch.ts` |
| `us-004-ghost-personalities` | Blinky, Pinky, Inky, Clyde targeting | `ghosts/*.ts` |
| `us-005-audio` | Audio manager, asset loader, mute toggle | `audio-manager.ts` |
| `us-006-ui` | Start screen, countdown, HUD, pause, game over | `ui/*.tsx` |
| ...and more | HighScore, offline, accessibility, responsive, levels | Various |

**The critical missing piece:** No assignment was created to wire `main.ts` into a game loop that imports PacMan, Ghost, Input, Score, Lives, and renders them on a canvas with `requestAnimationFrame`. The scaffold (ASSIGN-005) created a minimal `main.ts` that only rendered the maze statically. Every subsequent story created components in isolation without modifying `main.ts` to use them.

### Why it happened — the systemic gap

The failure cascades through 3 pipeline agents:

1. **Product Manager** (`product-manager.prompt.ts`): Creates user stories per epic. Stories like US-001 say "Pac-Man moves through the maze, eats dots, gains points" — but the PM never creates an **integration story** like "Wire all components into a working game loop in main.ts." The PM prompt says to create stories that "deliver user-visible value" and tasks that are "independently buildable" — but has **no instruction to create an integration/assembly story** that composes everything.

2. **Team Leader** (`team-leader.prompt.ts`): Assigns tasks to developers. The TL prompt says "EVERY task MUST be assigned" and "Set dependencies" — but since no integration task exists, there's nothing to assign. The TL has no instruction to **detect missing integration work** and create it.

3. **Developer Agents** (`persona.ts`): The dev persona says "ONLY touch files relevant to YOUR assigned story" and "STAY IN YOUR LANE" — which actively **prevents** developers from wiring their work into `main.ts` since that file "belongs" to the scaffold.

### Supporting evidence from logs

- `main.ts` was modified 4+ times, but only to add/remove imports — never to add a game loop
- The lint bugfix (BUGFIX-1-ASSIGN-060) **removed** the unused imports (`CanvasManager`, `OnscreenControls`, `AudioManager`) instead of wiring them up — the correct "fix" to lint was adding the game loop code that uses them
- 6 separate "Recursion limit of 50 reached" errors show agents struggled with even their scoped tasks
- Traceability report: `verified: 0` out of 41 criteria, `coveragePct: 0` — nothing was actually verified to work end-to-end

### The pattern this reveals

This is a **decomposition without recomposition** problem. The pipeline:
1. Decomposes requirements into epics/stories/tasks (good)
2. Assigns isolated tasks to individual developers (good)
3. **Never plans or assigns the work of assembling components into a working whole** (the bug)

This affects ANY project with an entry point that must compose multiple components — web apps with `main.ts`/`App.tsx`, servers with `app.ts`, CLI tools with `index.ts`, etc.

---

## Implementation Plan

### Approach: Inject integration awareness at two levels

The fix should work at the PM level (planning) AND the TL level (assignment) to be robust:

### Step 1: Add integration story generation to the Product Manager prompt

**File:** `src/agents/product-manager/product-manager.prompt.ts`

Add a new `<integration_rule>` section to the PM's `<critical_rules>`:

```
- ALWAYS create a final "Integration" user story that wires all components into the 
  application entry point(s). This story must:
  * Compose the independently-built components into a working application
  * Set up the main application loop / bootstrap / entry point
  * Ensure the app is interactive and functional end-to-end, not just buildable
  * Depend on all other stories (it should be the LAST story implemented)
  * Have acceptance criteria that verify the app runs and is interactive
  * Example: "As a user, I want all game components (player, enemies, input, rendering, 
    audio, UI) to be wired together in the main game loop so the game is playable"
- Similarly, for web apps create a story for the root component/page that composes child 
  components; for APIs create a story for the router/server setup that mounts all routes; 
  for CLIs create a story for the command dispatcher that invokes subcommands.
```

### Step 2: Add integration detection to the Team Leader prompt

**File:** `src/agents/team-leader/team-leader.prompt.ts`

Add an `<integration_check>` section:

```
<integration_check>
    Before finalizing assignments, verify that at least ONE assignment is responsible for:
    - Wiring ALL created components into the application entry point (e.g., main.ts, App.tsx, 
      index.ts, server.ts)
    - Creating the main application loop, bootstrap, or composition root
    - Ensuring the application is INTERACTIVE and FUNCTIONAL, not just compilable
    
    If no such assignment exists, CREATE ONE:
    - Assign it to a Principal developer (cross-cutting, architectural work)
    - Set it as the LAST assignment (depends on all component assignments)
    - Mark it as 'critical' priority
    - The description must list ALL components to import and wire together
    - It should reference the entry point file(s) that need modification
    
    Common integration patterns:
    - Games: game loop in main.ts using requestAnimationFrame, composing player/enemy/input/render
    - Web apps: root App component composing pages/routes/providers in App.tsx
    - APIs: server setup mounting all route handlers in app.ts/server.ts
    - CLIs: command dispatcher registering all subcommands in index.ts
</integration_check>
```

### Step 3: Relax the "stay in your lane" rule for integration assignments

**File:** `src/agents/_shared/persona.ts`

The current dev persona says:
```
- ONLY touch files relevant to YOUR assigned story. Do not modify files belonging to other assignments.
- STAY IN YOUR LANE.
```

Add an exception for integration work:
```
- ONLY touch files relevant to YOUR assigned story. Do not modify files belonging to 
  other assignments — UNLESS your assignment is explicitly about integrating/wiring 
  components into the application entry point, in which case you MUST import and use 
  the components from other assignments.
```

### Step 4: Add integration awareness to bugfix triage context

**File:** `src/conductor/nodes.ts` (bugfixTriageNode, ~line 1458)

The bugfix triage sends open bugs + architecture + existing assignments to the Team Leader to create BUGFIX assignments. When lint reports "unused imports" in entry point files, the TL creates assignments like "remove unused imports" — but the correct fix is "add the code that USES them."

Add an `Instructions` guidance section to the `userMsg` sent to the TL during bugfix triage (both the `CONTEXT_COMPACT` and non-compact branches). After the existing `'Please create NEW assignments to fix these bugs...'` line, add:

```
IMPORTANT: When triaging lint errors about "unused imports" or "defined but never used" 
in the application entry point file (main.ts, App.tsx, index.ts, server.ts, etc.):
- If the unused imports are core application components (services, managers, UI 
  components, controllers), the fix is NOT to remove them — it is to ADD the 
  integration code that uses them (game loop, app bootstrap, route mounting, etc.)
- Only remove imports that are genuinely extraneous (duplicates, wrong file, superseded).
```

This is a **secondary defense** — if Steps 1-3 work correctly, the integration story will prevent these lint errors from occurring in the first place.

---

## Files to Modify

| File | Change |
|------|--------|
| `src/agents/product-manager/product-manager.prompt.ts` | Add integration story rule to `<critical_rules>` |
| `src/agents/team-leader/team-leader.prompt.ts` | Add `<integration_check>` section |
| `src/agents/_shared/persona.ts` | Add integration exception to "stay in your lane" rule |
| `src/conductor/nodes.ts` | Add integration-aware guidance to bugfix triage prompt |

---

## Verification

- [ ] Run the Pac-Man project through the pipeline again and verify that:
  - The PM produces an integration user story
  - The TL assigns an integration task to a principal developer
  - The integration assignment creates a working `main.ts` game loop
  - The final app is interactive (not just a static maze)
- [ ] Run a simpler project (e.g., a todo app) to verify integration stories are generated for non-game projects too
- [ ] Verify that the traceability report shows `coveragePct > 0` after the fix

---

## Risks / Considerations

1. **Token budget**: An integration story adds one more PR workflow. For budget-constrained runs, this may push past limits. Mitigation: the integration assignment should be marked `critical` so it runs before lower-priority work if budget gets tight.

2. **Ordering**: The integration assignment must run LAST (after all components exist). The `dependsOn` chain ensures this, but if some component branches fail and their assignments aren't completed, the integration agent may try to wire up components that don't exist yet. The agent should be instructed to gracefully handle missing components.

3. **Over-integration**: For very simple projects (single-file calculator), an integration story may be unnecessary. The PM prompt should note that for trivially simple apps where all logic is in one file, a separate integration story is not needed.

4. **Prompt length**: Adding sections to 3 prompts increases token usage per invocation, but the additions are small (< 200 tokens each) relative to the context window.
