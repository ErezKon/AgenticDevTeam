/**
 * Developer Agent Registry — declares every dev agent as data.
 *
 * Each entry defines the agent's rank, domain, languages, and LLM settings.
 * The agent-factory + persona builder use this to generate concrete agents.
 * To add a new specialty, add a row here and create its folder.
 */
import type { DevRank, DevDomain } from '../_shared/persona';

export interface DevAgentEntry {
    id: string;
    name: string;
    rank: DevRank;
    domain: DevDomain;
    languages: string[];
    tag: string;
    colorCode: number;
    temperature: number;
}

export const DEV_AGENTS: DevAgentEntry[] = [
    // ── Principals ───────────────────────────────────────────────────────
    {
        id: 'principal-frontend',
        name: 'Principal Frontend Developer',
        rank: 'principal',
        domain: 'frontend',
        languages: ['Angular', 'React', 'Vue', 'Svelte', 'TypeScript', 'HTML/CSS', 'Tailwind', 'SASS'],
        tag: '[Principal FE]',
        colorCode: 45,
        temperature: 0.2,
    },
    {
        id: 'principal-backend',
        name: 'Principal Backend Developer',
        rank: 'principal',
        domain: 'backend',
        languages: ['C#/.NET', 'Java/Spring', 'Go', 'Python/FastAPI/Django', 'Node.js/Express'],
        tag: '[Principal BE]',
        colorCode: 208,
        temperature: 0.2,
    },

    // ── Seniors ──────────────────────────────────────────────────────────
    {
        id: 'senior-frontend',
        name: 'Senior Frontend Developer',
        rank: 'senior',
        domain: 'frontend',
        languages: ['Angular', 'React', 'Vue'],
        tag: '[Senior FE]',
        colorCode: 51,
        temperature: 0.3,
    },
    {
        id: 'senior-backend',
        name: 'Senior Backend Developer',
        rank: 'senior',
        domain: 'backend',
        languages: ['C#/.NET', 'Java/Spring', 'Python', 'Go'],
        tag: '[Senior BE]',
        colorCode: 172,
        temperature: 0.3,
    },

    // ── Juniors (Frontend) ───────────────────────────────────────────────
    {
        id: 'junior-angular',
        name: 'Junior Angular Developer',
        rank: 'junior',
        domain: 'frontend',
        languages: ['Angular'],
        tag: '[Junior Angular]',
        colorCode: 160,
        temperature: 0.3,
    },
    {
        id: 'junior-react',
        name: 'Junior React Developer',
        rank: 'junior',
        domain: 'frontend',
        languages: ['React'],
        tag: '[Junior React]',
        colorCode: 81,
        temperature: 0.3,
    },
    {
        id: 'junior-vue',
        name: 'Junior Vue Developer',
        rank: 'junior',
        domain: 'frontend',
        languages: ['Vue.js'],
        tag: '[Junior Vue]',
        colorCode: 41,
        temperature: 0.3,
    },

    // ── Juniors (Backend) ────────────────────────────────────────────────
    {
        id: 'junior-csharp',
        name: 'Junior C# Developer',
        rank: 'junior',
        domain: 'backend',
        languages: ['C#/.NET'],
        tag: '[Junior C#]',
        colorCode: 129,
        temperature: 0.3,
    },
    {
        id: 'junior-java',
        name: 'Junior Java Developer',
        rank: 'junior',
        domain: 'backend',
        languages: ['Java/Spring'],
        tag: '[Junior Java]',
        colorCode: 130,
        temperature: 0.3,
    },
    {
        id: 'junior-go',
        name: 'Junior Go Developer',
        rank: 'junior',
        domain: 'backend',
        languages: ['Go'],
        tag: '[Junior Go]',
        colorCode: 37,
        temperature: 0.3,
    },
    {
        id: 'junior-python',
        name: 'Junior Python Developer',
        rank: 'junior',
        domain: 'backend',
        languages: ['Python'],
        tag: '[Junior Python]',
        colorCode: 220,
        temperature: 0.3,
    },
];

/** Lookup a dev agent entry by id. */
export function getDevAgent(id: string): DevAgentEntry | undefined {
    return DEV_AGENTS.find(a => a.id === id);
}
