/**
 * Playwright MCP client setup.
 *
 * Connects to a Playwright MCP server and loads its tools so
 * the QA E2E agent can drive a real browser.
 */
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { PLAYWRIGHT_MCP_CMD, PLAYWRIGHT_MCP_ARGS } from '../../config';
import { getLogger } from '../../utils/logger';

const log = getLogger('[PlaywrightMCP]', 118);

let clientInstance: MultiServerMCPClient | null = null;

/**
 * Connect to the Playwright MCP server and return the available tools.
 */
export async function getPlaywrightMcpTools(): Promise<any[]> {
    if (clientInstance) {
        return await clientInstance.getTools();
    }

    log.info(`Connecting to Playwright MCP: ${PLAYWRIGHT_MCP_CMD} ${PLAYWRIGHT_MCP_ARGS.join(' ')}`);

    const client = new MultiServerMCPClient({
        playwright: {
            transport: 'stdio',
            command: PLAYWRIGHT_MCP_CMD,
            args: PLAYWRIGHT_MCP_ARGS,
        },
    });

    const tools = await client.getTools();
    clientInstance = client;

    log.info(`Loaded ${tools.length} Playwright MCP tools`);
    return tools;
}

/**
 * Disconnect and clean up the MCP client.
 */
export async function closePlaywrightMcp(): Promise<void> {
    if (clientInstance) {
        await clientInstance.close();
        clientInstance = null;
        log.info('Playwright MCP client closed');
    }
}
