/**
 * Playwright MCP preflight -- verify that the Playwright MCP server can start
 * and that browsers are installed before attempting E2E tests.
 *
 * Sub-Plan 11: the retroboard3 failure was `Connection closed` with no
 * diagnostic retained. This preflight provides actionable errors.
 */
import { execSync } from 'child_process';
import { getLogger } from '../../utils/logger';
import {
    PLAYWRIGHT_MCP_STARTUP_TIMEOUT_MS,
    PLAYWRIGHT_MCP_CONNECT_RETRIES,
    PLAYWRIGHT_AUTO_INSTALL,
} from '../../config';
import { getPlaywrightMcpTools, closePlaywrightMcp } from './playwright-mcp';

const log = getLogger('[PlaywrightPreflight]', 118);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PlaywrightPreflight {
    available: boolean;
    reason?: string;
    toolCount: number;
    browsersInstalled: boolean;
}

// ─── Cache ──────────────────────────────────────────────────────────────────

let _cached: PlaywrightPreflight | null = null;

/**
 * Reset the cached preflight result -- tests only.
 */
export function _resetPreflightCache(): void {
    _cached = null;
}

// ─── Preflight ──────────────────────────────────────────────────────────────

/**
 * Check whether the Playwright MCP server can start and has browsers available.
 *
 * Cached: runs at most once per process. On failure, logs the captured stderr --
 * never just "Connection closed".
 */
export async function preflightPlaywright(): Promise<PlaywrightPreflight> {
    if (_cached) return _cached;

    // 1. Check if browsers are installed
    let browsersInstalled = false;
    try {
        // Probe the browsers path -- npx playwright install --dry-run is not a real flag,
        // so we check the registry path instead
        const result = execSync('npx playwright --version', {
            timeout: 15000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        browsersInstalled = true;
        log.info(`Playwright version: ${result.trim()}`);
    } catch (err: any) {
        log.warn(`Playwright not found or version check failed: ${err.message}`);
    }

    // 2. Auto-install browsers if missing and PLAYWRIGHT_AUTO_INSTALL is set
    if (!browsersInstalled && PLAYWRIGHT_AUTO_INSTALL) {
        log.info('Attempting to install Playwright chromium...');
        try {
            execSync('npx playwright install chromium --with-deps', {
                timeout: PLAYWRIGHT_MCP_STARTUP_TIMEOUT_MS,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            browsersInstalled = true;
            log.info('Playwright chromium installed successfully');
        } catch (err: any) {
            const stderr = err.stderr?.toString() ?? err.message;
            log.error(`Failed to install Playwright browsers: ${stderr.slice(-500)}`);
            _cached = {
                available: false,
                reason: `Failed to install Playwright browsers: ${stderr.slice(-200)}`,
                toolCount: 0,
                browsersInstalled: false,
            };
            return _cached;
        }
    }

    // 3. Try connecting to the MCP server with retries
    let lastError = '';
    for (let attempt = 0; attempt <= PLAYWRIGHT_MCP_CONNECT_RETRIES; attempt++) {
        try {
            const tools = await getPlaywrightMcpTools();
            const toolCount = tools.length;
            if (toolCount === 0) {
                lastError = 'MCP server connected but returned 0 tools';
                log.warn(lastError);
                await closePlaywrightMcp();
                continue;
            }
            log.info(`Playwright MCP preflight passed: ${toolCount} tools available`);
            log.debug?.(`Tool names: ${tools.map((t: any) => t.name).join(', ')}`);
            _cached = { available: true, toolCount, browsersInstalled };
            return _cached;
        } catch (err: any) {
            lastError = err.message ?? String(err);
            log.warn(`Playwright MCP connection attempt ${attempt + 1}/${PLAYWRIGHT_MCP_CONNECT_RETRIES + 1} failed: ${lastError}`);
            await closePlaywrightMcp();
            if (attempt < PLAYWRIGHT_MCP_CONNECT_RETRIES) {
                // Backoff: 2s, 4s, ...
                await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
            }
        }
    }

    _cached = {
        available: false,
        reason: `Playwright MCP connection failed after ${PLAYWRIGHT_MCP_CONNECT_RETRIES + 1} attempts: ${lastError}`,
        toolCount: 0,
        browsersInstalled,
    };
    return _cached;
}
