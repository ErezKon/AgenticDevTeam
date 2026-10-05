/**
 * Plan 30-01 regression — the claudeopus5 dispatch plan.
 *
 * The fixture is the 27 assignments the Team Leader produced in the failed
 * claudeopus5 run (`failed run/state.json`). With the old dispatcher this plan:
 *  - put ASSIGN-001..005 and ASSIGN-027 on the scaffold branch (story-id canonicalisation);
 *  - classified us-027 as a scaffold branch in round 2 because ASSIGN-026 is typed `chore`;
 *  - made every feature wait for ASSIGN-027 (bootstrap barrier on the word "wiring") while
 *    ASSIGN-027 waited for every feature — "topoSort: 23 assignment(s) have cyclic
 *    dependencies — dispatching in one parallel batch";
 *  - ran us-027 before the branches it depends on, and halted everything when it failed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { AssignmentSchema } from '../src/agents/_shared/schemas/assignment.schema';
import { buildDispatchPlan, onBranchNotMerged, topoSort } from '../src/agents/developers/dispatch-plan';

const FIXTURE = path.join(__dirname, 'fixtures', 'plan30', 'claudeopus5-assignments.json');
const assignments = z.array(AssignmentSchema).parse(JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')));

const SCAFFOLD = 'claudeopus5/chore/scaffold';
const US001 = 'claudeopus5/feature/us-001-engine-rendering-core';
const US006 = 'claudeopus5/feature/us-006-ghost-ai-behavior';
const US009 = 'claudeopus5/feature/us-009-collision-scoring-hud';
const US016 = 'claudeopus5/feature/us-016-fruit-level-progression';
const US019 = 'claudeopus5/feature/us-019-screen-flow';
const US024 = 'claudeopus5/feature/us-024-audio-system';
const US027 = 'claudeopus5/feature/us-027-storage-accessibility-integration';

const ids = (...n: number[]) => n.map(i => `ASSIGN-${String(i).padStart(3, '0')}`);

describe('Plan 30-01 regression: claudeopus5 dispatch plan', () => {
    const plan = buildDispatchPlan(assignments, { projectSlug: 'claudeopus5' });
    const branchIds = (name: string) => plan.branches.get(name)!.assignments.map(a => a.id);

    it('loads the 27 assignments of the failed run', () => {
        expect(assignments).toHaveLength(27);
        expect(plan.branches.size).toBe(8);
    });

    it('puts only the scaffold assignments on the scaffold', () => {
        expect(branchIds(SCAFFOLD)).toEqual(ids(1, 2, 3));
        expect([...plan.branches.values()].filter(b => b.kind === 'scaffold').map(b => b.name)).toEqual([SCAFFOLD]);
    });

    it("honours the Team Leader's explicit branches", () => {
        expect(branchIds(US001)).toEqual(ids(4, 5, 6));
        expect([...branchIds(US027)].sort()).toEqual(ids(21, 22, 23, 24, 25, 26, 27));
    });

    it('treats ASSIGN-026 (a chore) as feature work and ASSIGN-027 (FINAL INTEGRATION) as a finalizer', () => {
        expect(plan.assignmentKinds.get('ASSIGN-026')).toBe('feature');
        expect(plan.assignmentKinds.get('ASSIGN-027')).toBe('finalizer');
        expect(plan.branches.get(US027)!.kind).toBe('finalizer');
        expect(plan.branches.get(US027)!.reason).toContain('depends on 23 feature assignment(s)');
    });

    it('dispatches us-027 last and us-024 after us-009 and us-016', () => {
        const order = plan.branchOrder;
        expect(order).toEqual([SCAFFOLD, US001, US006, US009, US016, US019, US024, US027]);
        expect(order.indexOf(US024)).toBeGreaterThan(order.indexOf(US009));
        expect(order.indexOf(US024)).toBeGreaterThan(order.indexOf(US016));
        expect(plan.branches.get(US024)!.dependsOnBranches).toEqual(expect.arrayContaining([SCAFFOLD, US009, US016]));
        expect(plan.branches.get(US027)!.dependsOnBranches).toEqual([SCAFFOLD, US001, US006, US009, US016, US019, US024]);
    });

    it('runs ASSIGN-027 last on its branch', () => {
        expect(branchIds(US027)[branchIds(US027).length - 1]).toBe('ASSIGN-027');
    });

    it('injects no edge that waits for the finalizer, so there is no cycle to break', () => {
        for (const branch of plan.branches.values()) {
            for (const a of branch.assignments) expect(a.dependsOn).not.toContain('ASSIGN-027');
        }
        expect(plan.brokenEdges).toEqual([]);
        expect(plan.skippedEdges).toEqual([]);
        expect(plan.warnings.filter(w => /cycle|parallel batch/i.test(w))).toEqual([]);

        const { layers, brokenEdges } = topoSort(plan.branchOrder.flatMap(b => plan.branches.get(b)!.assignments));
        expect(brokenEdges).toEqual([]);
        expect(layers.flat()).toHaveLength(27);
    });

    it('a failed branch blocks only the branches that depend on it', () => {
        expect(onBranchNotMerged(plan, US009, 'dependents')).toEqual({ halt: false, skip: [US016, US019, US024, US027] });
        expect(onBranchNotMerged(plan, US019, 'dependents').skip).toEqual([US027]);
        expect(onBranchNotMerged(plan, US027, 'dependents').skip).toEqual([]);
        expect(onBranchNotMerged(plan, SCAFFOLD, 'dependents').skip).toEqual([US001, US006, US009, US016, US019, US024, US027]);
    });
});
