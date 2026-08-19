/**
 * Tests for the env helper functions exported from ../src/config.
 *
 * Because config.ts has many side effects at module level (reading all env
 * vars), we use jest.resetModules() + dynamic require() to get a fresh
 * import for each test.
 */

let envInt: typeof import('../src/config').envInt;
let envFloat: typeof import('../src/config').envFloat;
let envBool: typeof import('../src/config').envBool;
let envEnum: typeof import('../src/config').envEnum;

const savedEnv = { ...process.env };

beforeEach(() => {
    jest.resetModules();
    // Restore env to a clean baseline so side effects in config.ts don't
    // throw on missing/invalid vars from a previous test.
    process.env = { ...savedEnv };
    const config = require('../src/config');
    envInt = config.envInt;
    envFloat = config.envFloat;
    envBool = config.envBool;
    envEnum = config.envEnum;
});

afterEach(() => {
    process.env = { ...savedEnv };
});

// ---- envInt -----------------------------------------------------------------

describe('envInt', () => {
    it('returns default when env var is undefined', () => {
        delete process.env.TEST_INT;
        expect(envInt('TEST_INT', 42)).toBe(42);
    });

    it('returns default when env var is empty string', () => {
        process.env.TEST_INT = '';
        expect(envInt('TEST_INT', 42)).toBe(42);
    });

    it('parses a valid integer', () => {
        process.env.TEST_INT = '100';
        expect(envInt('TEST_INT', 0)).toBe(100);
    });

    it('throws on a non-numeric value', () => {
        process.env.TEST_INT = 'abc';
        expect(() => envInt('TEST_INT', 0)).toThrow(/Invalid integer.*TEST_INT.*"abc"/);
    });

    it('handles negative integers', () => {
        process.env.TEST_INT = '-7';
        expect(envInt('TEST_INT', 0)).toBe(-7);
    });
});

// ---- envFloat ---------------------------------------------------------------

describe('envFloat', () => {
    it('returns default when env var is undefined', () => {
        delete process.env.TEST_FLOAT;
        expect(envFloat('TEST_FLOAT', 1.5)).toBe(1.5);
    });

    it('parses a valid float', () => {
        process.env.TEST_FLOAT = '0.75';
        expect(envFloat('TEST_FLOAT', 0)).toBeCloseTo(0.75, 10);
    });

    it('throws on a non-numeric value', () => {
        process.env.TEST_FLOAT = 'xyz';
        expect(() => envFloat('TEST_FLOAT', 0)).toThrow(/Invalid float.*TEST_FLOAT.*"xyz"/);
    });

    it('handles integer strings as float', () => {
        process.env.TEST_FLOAT = '3';
        expect(envFloat('TEST_FLOAT', 0)).toBe(3);
    });
});

// ---- envBool ----------------------------------------------------------------

describe('envBool', () => {
    it('returns default when env var is undefined', () => {
        delete process.env.TEST_BOOL;
        expect(envBool('TEST_BOOL', true)).toBe(true);
    });

    it('returns true for "true"', () => {
        process.env.TEST_BOOL = 'true';
        expect(envBool('TEST_BOOL', false)).toBe(true);
    });

    it('returns false for "false"', () => {
        process.env.TEST_BOOL = 'false';
        expect(envBool('TEST_BOOL', true)).toBe(false);
    });

    it('throws on "yes"', () => {
        process.env.TEST_BOOL = 'yes';
        expect(() => envBool('TEST_BOOL', false)).toThrow(/Invalid boolean.*TEST_BOOL.*"yes"/);
    });

    it('throws on "1"', () => {
        process.env.TEST_BOOL = '1';
        expect(() => envBool('TEST_BOOL', false)).toThrow(/Invalid boolean.*TEST_BOOL.*"1"/);
    });

    it('throws on "0"', () => {
        process.env.TEST_BOOL = '0';
        expect(() => envBool('TEST_BOOL', false)).toThrow(/Invalid boolean.*TEST_BOOL.*"0"/);
    });

    it('throws on "TRUE" (case sensitive)', () => {
        process.env.TEST_BOOL = 'TRUE';
        expect(() => envBool('TEST_BOOL', false)).toThrow(/Invalid boolean.*TEST_BOOL.*"TRUE"/);
    });
});

// ---- envEnum ----------------------------------------------------------------

describe('envEnum', () => {
    const ALLOWED = ['alpha', 'beta', 'gamma'] as const;

    it('returns default when env var is undefined', () => {
        delete process.env.TEST_ENUM;
        expect(envEnum('TEST_ENUM', ALLOWED, 'beta')).toBe('beta');
    });

    it('returns a valid value from the allowed set', () => {
        process.env.TEST_ENUM = 'gamma';
        expect(envEnum('TEST_ENUM', ALLOWED, 'alpha')).toBe('gamma');
    });

    it('throws on a value not in the set and includes expected values', () => {
        process.env.TEST_ENUM = 'delta';
        expect(() => envEnum('TEST_ENUM', ALLOWED, 'alpha')).toThrow(
            /Invalid value.*TEST_ENUM.*"delta".*alpha.*beta.*gamma/,
        );
    });

    it('returns default when env var is empty string', () => {
        process.env.TEST_ENUM = '';
        expect(envEnum('TEST_ENUM', ALLOWED, 'beta')).toBe('beta');
    });
});
