/**
 * Master Agent Registry — the single source of truth for all agents.
 *
 * Maps every agent id to its display tag, color code, and metadata.
 * Used by the logger, conductor, CLI menu, and dashboard.
 */
import { DEV_AGENTS } from './developers/registry';

export interface AgentRegistryEntry {
    id: string;
    name: string;
    tag: string;
    colorCode: number;
    category: 'management' | 'development' | 'quality' | 'operations';
}

// ── Non-developer agents ─────────────────────────────────────────────────

const MANAGEMENT_AGENTS: AgentRegistryEntry[] = [
    { id: 'architect',        name: 'Architect',               tag: '[Architect]',        colorCode: 39,  category: 'management' },
    { id: 'product-manager',  name: 'Product Manager',         tag: '[Product Manager]',  colorCode: 214, category: 'management' },
    { id: 'dba',              name: 'DBA',                     tag: '[DBA]',              colorCode: 100, category: 'management' },
    { id: 'team-leader',      name: 'Team Leader',             tag: '[Team Leader]',      colorCode: 213, category: 'management' },
];

const QA_AGENTS: AgentRegistryEntry[] = [
    { id: 'qa-lead',  name: 'QA Lead',                  tag: '[QA Lead]',  colorCode: 198, category: 'quality' },
    { id: 'qa-unit',  name: 'QA Unit/Integration',      tag: '[QA Unit]',  colorCode: 205, category: 'quality' },
    { id: 'qa-e2e',   name: 'QA E2E (Playwright)',      tag: '[QA E2E]',   colorCode: 118, category: 'quality' },
];

const OPS_AGENTS: AgentRegistryEntry[] = [
    { id: 'devops',   name: 'DevOps',                   tag: '[DevOps]',   colorCode: 33,  category: 'operations' },
];

// ── Developer agents (from developer registry) ──────────────────────────

const DEV_REGISTRY_ENTRIES: AgentRegistryEntry[] = DEV_AGENTS.map(d => ({
    id: d.id,
    name: d.name,
    tag: d.tag,
    colorCode: d.colorCode,
    category: 'development' as const,
}));

// ── Combined registry ───────────────────────────────────────────────────

export const AGENT_REGISTRY: AgentRegistryEntry[] = [
    ...MANAGEMENT_AGENTS,
    ...DEV_REGISTRY_ENTRIES,
    ...QA_AGENTS,
    ...OPS_AGENTS,
];

/** Lookup an agent entry by id. Returns undefined if not found. */
export function getAgentEntry(id: string): AgentRegistryEntry | undefined {
    return AGENT_REGISTRY.find(a => a.id === id);
}

/** Get all agents in a category. */
export function getAgentsByCategory(category: AgentRegistryEntry['category']): AgentRegistryEntry[] {
    return AGENT_REGISTRY.filter(a => a.category === category);
}
