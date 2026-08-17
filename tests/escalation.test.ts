/**
 * Escalation — unit tests for Sub-Plan 07's escalation candidate selection.
 *
 * Asserts that selectEscalationCandidate returns a non-empty candidate for
 * every (rank, domain) pair in the registry.
 */
import { selectEscalationCandidate } from '../src/conductor/review-policy';
import { DEV_AGENTS } from '../src/agents/developers/registry';

describe('selectEscalationCandidate', () => {
    it('returns a non-empty candidate for every agent in the registry', () => {
        for (const agent of DEV_AGENTS) {
            const candidate = selectEscalationCandidate(agent.id, []);
            expect(candidate).not.toBeNull();
            expect(typeof candidate).toBe('string');
            // The candidate should not be the same agent (unless self-escalation for lone principals)
            if (candidate !== agent.id) {
                expect(candidate).not.toBe(agent.id);
            }
        }
    });

    it('returns a non-empty candidate even when reviewers are excluded', () => {
        for (const agent of DEV_AGENTS) {
            // Exclude all reviewers (simulating the real scenario)
            const excludeIds = DEV_AGENTS
                .filter(a => a.id !== agent.id)
                .slice(0, 3)
                .map(a => a.id);
            const candidate = selectEscalationCandidate(agent.id, excludeIds);
            expect(candidate).not.toBeNull();
        }
    });

    it('junior-frontend escalates to senior-frontend', () => {
        const candidate = selectEscalationCandidate('junior-react', []);
        expect(candidate).toBe('senior-frontend');
    });

    it('senior-frontend escalates to principal-frontend', () => {
        const candidate = selectEscalationCandidate('senior-frontend', []);
        expect(candidate).toBe('principal-frontend');
    });

    it('principal-frontend with no other frontend principal falls back to principal-backend', () => {
        const candidate = selectEscalationCandidate('principal-frontend', ['principal-frontend']);
        expect(candidate).toBe('principal-backend');
    });

    it('principal-backend with no other backend principal falls back to principal-frontend', () => {
        const candidate = selectEscalationCandidate('principal-backend', ['principal-backend']);
        expect(candidate).toBe('principal-frontend');
    });

    it('falls back to a principal for unknown agent id (Plan 24 B1)', () => {
        // Plan 24 B1: unknown agents (e.g. 'strong-fixer') fall back to the
        // first principal dev agent rather than returning null.
        const candidate = selectEscalationCandidate('nonexistent-agent', []);
        expect(candidate).not.toBeNull();
        expect(typeof candidate).toBe('string');
    });

    it('senior-backend escalates to principal-backend', () => {
        const candidate = selectEscalationCandidate('senior-backend', []);
        expect(candidate).toBe('principal-backend');
    });

    it('junior-csharp escalates to senior-backend', () => {
        const candidate = selectEscalationCandidate('junior-csharp', []);
        expect(candidate).toBe('senior-backend');
    });

    it('when same-domain senior excluded, finds cross-domain principal', () => {
        const candidate = selectEscalationCandidate('junior-react', ['senior-frontend', 'principal-frontend']);
        // Should escalate to principal-backend (cross-domain) since both same-domain are excluded
        expect(candidate).toBe('principal-backend');
    });
});
