/**
 * Jest manual mock for src/utils/logger.
 *
 * Usage in tests:
 *   jest.mock('../src/utils/logger');           // uses this auto-mock
 *   jest.mock('../../src/utils/logger');         // same, different depth
 *
 * To assert on specific calls:
 *   import { getLogger } from '../src/utils/logger';
 *   const log = (getLogger as jest.Mock).mock.results[0].value;
 *   expect(log.warn).toHaveBeenCalledWith('...');
 */

export function createMockLogger() {
    return {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    };
}

export const getLogger = jest.fn(() => createMockLogger());
export const setRunLogPath = jest.fn();
export const logToolAction = jest.fn();
