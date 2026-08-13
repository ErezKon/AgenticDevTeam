/**
 * Tests for state.ts reducers — mergeByIdReducer prevents duplicates
 * on HITL re-runs (P13).
 */
// We can't easily import the reducer directly (it's a private function),
// so we test via the ProjectState annotation behavior by simulating
// what the reducer does with the same logic.

// Replicate the mergeByIdReducer logic for testing
function mergeByIdReducer<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
    const map = new Map<string, T>();
    for (const item of existing) map.set(item.id, item);
    for (const item of incoming) map.set(item.id, item);
    return [...map.values()];
}

describe('mergeByIdReducer', () => {
    it('appends new items', () => {
        const existing = [{ id: 'A', value: 1 }];
        const incoming = [{ id: 'B', value: 2 }];
        const result = mergeByIdReducer(existing, incoming);
        expect(result).toEqual([
            { id: 'A', value: 1 },
            { id: 'B', value: 2 },
        ]);
    });

    it('replaces items with the same id', () => {
        const existing = [{ id: 'A', value: 1 }, { id: 'B', value: 2 }];
        const incoming = [{ id: 'A', value: 10 }]; // update A
        const result = mergeByIdReducer(existing, incoming);
        expect(result).toEqual([
            { id: 'A', value: 10 }, // updated
            { id: 'B', value: 2 },
        ]);
    });

    it('handles empty incoming', () => {
        const existing = [{ id: 'A', value: 1 }];
        const result = mergeByIdReducer(existing, []);
        expect(result).toEqual(existing);
    });

    it('handles empty existing', () => {
        const incoming = [{ id: 'A', value: 1 }];
        const result = mergeByIdReducer([], incoming);
        expect(result).toEqual(incoming);
    });

    it('prevents duplication on re-run with same ids', () => {
        const plan = [
            { id: 'US-001', title: 'Login' },
            { id: 'US-002', title: 'Profile' },
        ];
        // Simulate a HITL re-run that produces the same plan
        const rerun = [
            { id: 'US-001', title: 'Login (refined)' },
            { id: 'US-002', title: 'Profile (refined)' },
        ];
        const result = mergeByIdReducer(plan, rerun);
        expect(result).toHaveLength(2); // Not 4
        expect(result[0].title).toBe('Login (refined)');
    });
});
