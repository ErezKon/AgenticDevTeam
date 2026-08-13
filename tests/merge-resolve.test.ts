/**
 * Tests for deterministic merge conflict resolution (Sub-Plan 06 SS5c).
 */
import { compareSemverRange } from '../src/conductor/merge-resolve';

describe('compareSemverRange', () => {
    it('compares caret ranges numerically', () => {
        expect(compareSemverRange('^2.0.0', '^1.0.0')).toBeGreaterThan(0);
        expect(compareSemverRange('^1.0.0', '^2.0.0')).toBeLessThan(0);
        expect(compareSemverRange('^1.0.0', '^1.0.0')).toBe(0);
    });

    it('compares tilde ranges', () => {
        expect(compareSemverRange('~1.5.0', '~1.4.0')).toBeGreaterThan(0);
    });

    it('compares exact versions', () => {
        expect(compareSemverRange('3.0.0', '2.9.9')).toBeGreaterThan(0);
    });

    it('strips leading operators before comparing', () => {
        expect(compareSemverRange('>=2.0.0', '^1.0.0')).toBeGreaterThan(0);
        expect(compareSemverRange('~1.0.0', '>=1.0.0')).toBe(0);
    });

    it('handles patch-level differences', () => {
        expect(compareSemverRange('^1.0.3', '^1.0.2')).toBeGreaterThan(0);
        expect(compareSemverRange('^1.0.10', '^1.0.9')).toBeGreaterThan(0);
    });
});
