/**
 * Playwright Preflight — unit tests.
 * Sub-Plan 11 Work Item 4.
 */
import { _resetPreflightCache } from '../src/tools/mcp/playwright-preflight';

jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    })),
    setRunLogPath: jest.fn(),
}));

// Mock the MCP client so we don't need an actual Playwright server
jest.mock('../src/tools/mcp/playwright-mcp', () => ({
    getPlaywrightMcpTools: jest.fn(),
    closePlaywrightMcp: jest.fn(),
}));

// Mock child_process
jest.mock('child_process', () => ({
    execSync: jest.fn(),
}));

describe('preflightPlaywright', () => {
    beforeEach(() => {
        jest.resetModules();
        _resetPreflightCache();
    });

    it('returns available=false with reason when tool count is 0', async () => {
        const { execSync } = require('child_process');
        execSync.mockReturnValue('1.40.0');
        const { getPlaywrightMcpTools, closePlaywrightMcp } = require('../src/tools/mcp/playwright-mcp');
        getPlaywrightMcpTools.mockResolvedValue([]);
        closePlaywrightMcp.mockResolvedValue(undefined);

        const { preflightPlaywright, _resetPreflightCache: reset } = require('../src/tools/mcp/playwright-preflight');
        reset();
        const result = await preflightPlaywright();
        expect(result.available).toBe(false);
        expect(result.reason).toContain('0 tools');
    });

    it('returns available=false when PLAYWRIGHT_AUTO_INSTALL=false and browsers missing', async () => {
        // Set env before requiring the module
        process.env.PLAYWRIGHT_AUTO_INSTALL = 'false';

        jest.resetModules();
        // Re-mock after resetModules
        jest.mock('../src/utils/logger', () => ({
            getLogger: jest.fn(() => ({
                info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
            })),
            setRunLogPath: jest.fn(),
        }));
        jest.mock('../src/tools/mcp/playwright-mcp', () => ({
            getPlaywrightMcpTools: jest.fn().mockRejectedValue(new Error('Connection closed')),
            closePlaywrightMcp: jest.fn().mockResolvedValue(undefined),
        }));
        jest.mock('child_process', () => ({
            execSync: jest.fn().mockImplementation(() => { throw new Error('not found'); }),
        }));

        const { preflightPlaywright, _resetPreflightCache: reset } = require('../src/tools/mcp/playwright-preflight');
        reset();
        const result = await preflightPlaywright();
        expect(result.available).toBe(false);
        expect(result.browsersInstalled).toBe(false);

        delete process.env.PLAYWRIGHT_AUTO_INSTALL;
    });

    it('returns available=true with correct tool count when MCP connects', async () => {
        const { execSync } = require('child_process');
        execSync.mockReturnValue('1.40.0');
        const { getPlaywrightMcpTools, closePlaywrightMcp } = require('../src/tools/mcp/playwright-mcp');
        getPlaywrightMcpTools.mockResolvedValue([{ name: 'navigate' }, { name: 'screenshot' }, { name: 'click' }]);
        closePlaywrightMcp.mockResolvedValue(undefined);

        const { preflightPlaywright, _resetPreflightCache: reset } = require('../src/tools/mcp/playwright-preflight');
        reset();
        const result = await preflightPlaywright();
        expect(result.available).toBe(true);
        expect(result.toolCount).toBe(3);
    });
});
