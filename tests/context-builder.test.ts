/**
 * Tests for src/conductor/context-builder.ts
 *
 * Pure tests — no LLM, no git, no network.
 */
import {
    summariseArchitecture,
    summariseTechStack,
    summariseDbDesign,
    summariseStories,
    storiesForIds,
    summariseTasks,
    summariseFileChanges,
    summariseCodebaseAnalysis,
    buildContext,
    recordContextChars,
    getContextStats,
    _resetContextStats,
} from '../src/conductor/context-builder';
import type { ContextSection } from '../src/conductor/context-builder';
import type {
    ArchitectureDoc, TechDecision, DbDesign, UserStory, Task,
    FileChange, CodebaseAnalysis,
} from '../src/agents/_shared/base-schemas';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const fixtureArch: ArchitectureDoc = {
    style: 'microservices',
    components: [
        { name: 'API Gateway', type: 'service', description: 'Routes requests to backend services and handles auth. Supports rate limiting and circuit breaking.', technology: 'Express.js', communicatesWith: ['User Service', 'Order Service'] },
        { name: 'User Service', type: 'service', description: 'Manages user accounts', technology: 'NestJS', communicatesWith: ['PostgreSQL'] },
        { name: 'PostgreSQL', type: 'database', description: 'Primary data store', technology: 'PostgreSQL 15', communicatesWith: [] },
    ],
    dataFlow: 'Client -> API Gateway -> Services -> Database',
    integrations: ['Stripe API', 'SendGrid'],
    nonFunctional: ['99.9% uptime', '<200ms p95 latency'],
    mermaidDiagram: 'graph TD; A-->B',
};

const fixtureTechStack: TechDecision[] = [
    { layer: 'frontend', choice: 'React', alternatives: ['Vue', 'Angular'], rationale: 'Large ecosystem. Good community support.' },
    { layer: 'backend', choice: 'NestJS', alternatives: ['Express'], rationale: 'Enterprise patterns. TypeScript first-class.' },
    { layer: 'database', choice: 'PostgreSQL', alternatives: ['MySQL'], rationale: 'ACID compliance.' },
];

const fixtureDbDesign: DbDesign = {
    engine: 'PostgreSQL',
    rationale: 'ACID compliance and rich indexing',
    entities: [
        { name: 'users', columns: [{ name: 'id', type: 'uuid', constraints: 'PRIMARY KEY' }, { name: 'email', type: 'varchar(255)', constraints: 'UNIQUE NOT NULL' }, { name: 'name', type: 'varchar(100)' }] },
        { name: 'orders', columns: [{ name: 'id', type: 'uuid', constraints: 'PRIMARY KEY' }, { name: 'user_id', type: 'uuid', constraints: 'REFERENCES users(id)' }, { name: 'total', type: 'decimal(10,2)' }] },
    ],
    relationships: [
        { from: 'users', to: 'orders', type: 'one-to-many', description: 'A user has many orders' },
    ],
    indexes: [{ table: 'orders', columns: ['user_id'], type: 'btree', rationale: 'Fast lookup by user' }],
    sampleQueries: [{ description: 'Get user orders', sql: 'SELECT * FROM orders WHERE user_id = $1' }],
    migrations: [{ filename: '001_init.sql', content: 'CREATE TABLE ...' }],
    erdMermaid: 'erDiagram\n  users ||--o{ orders : has',
};

const fixtureStories: UserStory[] = [
    { id: 'US-001', epicId: 'EPIC-001', asA: 'user', iWant: 'to register', soThat: 'I can access the system', acceptanceCriteria: ['Email required', 'Password min 8 chars', 'Confirmation email sent'] },
    { id: 'US-002', epicId: 'EPIC-001', asA: 'user', iWant: 'to login', soThat: 'I can use my account', acceptanceCriteria: ['Email + password', 'JWT token returned'] },
    { id: 'US-003', epicId: 'EPIC-002', asA: 'admin', iWant: 'to view orders', soThat: 'I can manage the business', acceptanceCriteria: ['Table view', 'Sortable columns'] },
];

const fixtureTasks: Task[] = [
    { id: 'TASK-001', storyId: 'US-001', title: 'Create registration API', description: 'POST /api/auth/register endpoint', layer: 'backend', suggestedTech: 'NestJS' },
    { id: 'TASK-002', storyId: 'US-001', title: 'Registration form', description: 'React registration form', layer: 'frontend', suggestedTech: 'React' },
    { id: 'TASK-003', storyId: 'US-002', title: 'Login endpoint', description: 'POST /api/auth/login', layer: 'backend', suggestedTech: 'NestJS' },
];

const fixtureFileChanges: FileChange[] = Array.from({ length: 80 }, (_, i) => ({
    path: `src/file-${i.toString().padStart(3, '0')}.ts`,
    action: i % 3 === 0 ? 'created' as const : 'modified' as const,
    summary: `Change ${i}`,
    storyId: 'US-001',
    agentId: 'junior-react',
}));

const fixtureCodebaseAnalysis: CodebaseAnalysis = {
    projectName: 'MyApp',
    projectType: 'web-application',
    primaryLanguages: ['TypeScript', 'JavaScript'],
    frameworks: ['NestJS', 'React'],
    architecture: { style: 'monolith', description: 'Single deployable unit', mermaidDiagram: 'graph TD; A-->B' },
    modules: [
        { name: 'auth', path: 'src/auth', responsibility: 'Authentication and authorization', files: [{ path: 'src/auth/auth.service.ts', type: 'source' as const, language: 'TypeScript', summary: 'Auth service', linesOfCode: 120 }], dependencies: ['bcrypt', 'jsonwebtoken'], externalDependencies: ['bcrypt'] },
        { name: 'orders', path: 'src/orders', responsibility: 'Order management CRUD operations', files: [{ path: 'src/orders/orders.controller.ts', type: 'source' as const, language: 'TypeScript', summary: 'Orders controller', linesOfCode: 80 }], dependencies: ['typeorm'], externalDependencies: ['typeorm'] },
    ],
    database: { engine: 'PostgreSQL', ormOrDriver: 'TypeORM', hasExistingMigrations: true, schemaDescription: 'Users + Orders' },
    testing: { hasTests: true, frameworks: ['jest'], coverage: '45%' },
    buildAndDeploy: { buildTool: 'webpack', containerized: true, ciCd: 'GitHub Actions' },
    knownIssues: ['No test coverage for auth module', 'Outdated dependency: express@4.17.1'],
    entryPoints: [{ file: 'src/main.ts', description: 'Application bootstrap' }],
    lastAnalyzedAt: '2026-01-01T00:00:00Z',
    fileTree: 'src/\n  auth/\n  orders/',
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('summariseArchitecture', () => {
    it('produces compact output with component names, types, and clipped descriptions', () => {
        const result = summariseArchitecture(fixtureArch, 50);
        expect(result).toContain('Style: microservices');
        expect(result).toContain('API Gateway (service)');
        expect(result).toContain('User Service (service)');
        expect(result).toContain('PostgreSQL (database)');
        expect(result).toContain('Integrations: Stripe API, SendGrid');
        expect(result).toContain('NFRs:');
    });

    it('clips long descriptions at maxDescChars', () => {
        const result = summariseArchitecture(fixtureArch, 30);
        // 'Routes requests to backend services and handles auth...' should be clipped
        const lines = result.split('\n');
        const gatewayLine = lines.find(l => l.includes('API Gateway'));
        expect(gatewayLine).toBeDefined();
        // The description part should be at most 30 chars + '...'
        const descPart = gatewayLine!.split(': ').slice(1).join(': ');
        expect(descPart.length).toBeLessThanOrEqual(33); // 30 + '...'
    });

    it('returns fallback for null architecture', () => {
        expect(summariseArchitecture(null)).toBe('(no architecture available)');
    });

    it('is significantly smaller than JSON.stringify', () => {
        const compact = summariseArchitecture(fixtureArch);
        const verbose = JSON.stringify(fixtureArch, null, 2);
        expect(compact.length).toBeLessThan(verbose.length);
    });
});

describe('summariseTechStack', () => {
    it('produces layer: choice lines with rationale', () => {
        const result = summariseTechStack(fixtureTechStack);
        expect(result).toContain('frontend: React');
        expect(result).toContain('backend: NestJS');
        expect(result).toContain('database: PostgreSQL');
    });

    it('clips rationale to first sentence', () => {
        const result = summariseTechStack(fixtureTechStack);
        // 'Large ecosystem.' should be the first sentence
        expect(result).toContain('Large ecosystem.');
        // 'Good community support.' is the second sentence and should NOT appear
        expect(result).not.toContain('Good community support.');
    });

    it('returns fallback for empty stack', () => {
        expect(summariseTechStack([])).toBe('(no tech stack decisions)');
    });
});

describe('summariseDbDesign', () => {
    it('compact mode shows entity names and column names', () => {
        const result = summariseDbDesign(fixtureDbDesign, 'compact');
        expect(result).toContain('Engine: PostgreSQL');
        expect(result).toContain('users(id, email, name)');
        expect(result).toContain('orders(id, user_id, total)');
        expect(result).toContain('users one-to-many orders');
    });

    it('compact mode does NOT include rationale or ERD', () => {
        const result = summariseDbDesign(fixtureDbDesign, 'compact');
        expect(result).not.toContain('ACID compliance');
        expect(result).not.toContain('erDiagram');
    });

    it('full mode includes rationale, constraints, and ERD', () => {
        const result = summariseDbDesign(fixtureDbDesign, 'full');
        expect(result).toContain('Rationale: ACID compliance');
        expect(result).toContain('PRIMARY KEY');
        expect(result).toContain('erDiagram');
    });

    it('returns fallback for null dbDesign', () => {
        expect(summariseDbDesign(null)).toBe('(no database design)');
    });
});

describe('summariseStories', () => {
    it('produces US-id: role/want lines with AC count', () => {
        const result = summariseStories(fixtureStories);
        expect(result).toContain('US-001: As a user, I want to register (3 AC)');
        expect(result).toContain('US-002: As a user, I want to login (2 AC)');
        expect(result).toContain('US-003: As a admin, I want to view orders (2 AC)');
    });

    it('returns fallback for empty stories', () => {
        expect(summariseStories([])).toBe('(no user stories)');
    });
});

describe('storiesForIds', () => {
    it('returns only the requested stories with acceptance criteria', () => {
        const result = storiesForIds(fixtureStories, ['US-001', 'US-003']);
        expect(result).toContain('US-001');
        expect(result).toContain('Email required');
        expect(result).toContain('Password min 8 chars');
        expect(result).toContain('US-003');
        expect(result).toContain('Table view');
        // US-002 should NOT be present
        expect(result).not.toContain('US-002');
        expect(result).not.toContain('JWT token');
    });

    it('ignores unknown ids gracefully', () => {
        const result = storiesForIds(fixtureStories, ['US-001', 'US-999']);
        expect(result).toContain('US-001');
        expect(result).not.toContain('US-999');
    });

    it('returns fallback when no ids match', () => {
        const result = storiesForIds(fixtureStories, ['US-999']);
        expect(result).toBe('(no matching stories)');
    });

    it('returns fallback for empty inputs', () => {
        expect(storiesForIds([], ['US-001'])).toBe('(no stories)');
        expect(storiesForIds(fixtureStories, [])).toBe('(no stories)');
    });
});

describe('summariseTasks', () => {
    it('produces TASK-id [layer/tech] title lines', () => {
        const result = summariseTasks(fixtureTasks);
        expect(result).toContain('TASK-001 [backend/NestJS] Create registration API');
        expect(result).toContain('TASK-002 [frontend/React] Registration form');
    });

    it('returns fallback for empty tasks', () => {
        expect(summariseTasks([])).toBe('(no tasks)');
    });
});

describe('summariseFileChanges', () => {
    it('caps at the specified limit and keeps newest entries', () => {
        const result = summariseFileChanges(fixtureFileChanges, 10);
        expect(result).toContain('(80 total, showing last 10)');
        // Should contain the last file (index 79) but not the first (index 0)
        expect(result).toContain('src/file-079.ts');
        expect(result).not.toContain('src/file-000.ts');
    });

    it('shows all entries when under the limit', () => {
        const small = fixtureFileChanges.slice(0, 3);
        const result = summariseFileChanges(small, 10);
        expect(result).toContain('(3 total)');
    });

    it('returns fallback for empty changes', () => {
        expect(summariseFileChanges([], 10)).toBe('(no file changes)');
    });
});

describe('summariseCodebaseAnalysis', () => {
    it('includes project name, languages, modules, and known issues', () => {
        const result = summariseCodebaseAnalysis(fixtureCodebaseAnalysis);
        expect(result).toContain('Project: MyApp (web-application)');
        expect(result).toContain('Languages: TypeScript, JavaScript');
        expect(result).toContain('Frameworks: NestJS, React');
        expect(result).toContain('auth (src/auth)');
        expect(result).toContain('Known issues (2)');
    });

    it('does NOT include file trees or per-file detail', () => {
        const result = summariseCodebaseAnalysis(fixtureCodebaseAnalysis);
        expect(result).not.toContain('src/main.ts');
        expect(result).not.toContain('fileTree');
    });

    it('returns fallback for null analysis', () => {
        expect(summariseCodebaseAnalysis(null)).toBe('(no codebase analysis)');
    });

    it('is significantly smaller than JSON.stringify', () => {
        const compact = summariseCodebaseAnalysis(fixtureCodebaseAnalysis);
        const verbose = JSON.stringify(fixtureCodebaseAnalysis, null, 2);
        expect(compact.length).toBeLessThan(verbose.length);
    });
});

describe('buildContext', () => {
    const sections: ContextSection[] = [
        { title: 'Requirements', body: 'Build a calculator.', priority: 1 },
        { title: 'Architecture', body: 'A'.repeat(500), priority: 2 },
        { title: 'Analysis', body: 'B'.repeat(500), priority: 3 },
    ];

    it('returns all sections unchanged when under budget', () => {
        const result = buildContext(sections, 50000);
        expect(result).toContain('## Requirements');
        expect(result).toContain('## Architecture');
        expect(result).toContain('## Analysis');
        expect(result).toContain('Build a calculator.');
        expect(result).toContain('A'.repeat(500));
    });

    it('clips the lowest-priority section first when over budget', () => {
        // Budget that fits requirements + architecture but not analysis
        const result = buildContext(sections, 600);
        expect(result).toContain('## Requirements');
        expect(result).toContain('Build a calculator.');
        // Analysis (priority 3) should be clipped first
        expect(result).toContain('[clipped');
        // Requirements (priority 1) should never be clipped
        expect(result).toContain('Build a calculator.');
    });

    it('never clips priority-1 sections', () => {
        const tightSections: ContextSection[] = [
            { title: 'Must Keep', body: 'X'.repeat(300), priority: 1 },
            { title: 'Can Clip', body: 'Y'.repeat(300), priority: 3 },
        ];
        const result = buildContext(tightSections, 400);
        // Priority 1 section should be intact
        expect(result).toContain('X'.repeat(300));
        // Priority 3 should be clipped
        expect(result).toContain('[clipped');
    });

    it('result length is bounded by maxChars plus annotation overhead', () => {
        const bigSections: ContextSection[] = [
            { title: 'A', body: 'x'.repeat(5000), priority: 2 },
            { title: 'B', body: 'y'.repeat(5000), priority: 3 },
        ];
        const result = buildContext(bigSections, 2000);
        // The annotation text "[clipped N chars ...]" adds some overhead
        // but the result should be reasonably close to maxChars
        expect(result.length).toBeLessThan(3000); // generous overhead allowance
    });

    it('preserves section order in the output', () => {
        const result = buildContext(sections, 50000);
        const reqIdx = result.indexOf('## Requirements');
        const archIdx = result.indexOf('## Architecture');
        const anaIdx = result.indexOf('## Analysis');
        expect(reqIdx).toBeLessThan(archIdx);
        expect(archIdx).toBeLessThan(anaIdx);
    });
});

describe('golden-size assertion', () => {
    it('team-leader compact context is at least 50% smaller than verbose', () => {
        // Build the team-leader context in compact mode
        const compactSections: ContextSection[] = [
            { title: 'Architecture', body: summariseArchitecture(fixtureArch), priority: 2 },
            { title: 'Tech Stack', body: summariseTechStack(fixtureTechStack), priority: 2 },
            { title: 'DB Design', body: summariseDbDesign(fixtureDbDesign, 'compact'), priority: 3 },
            { title: 'User Stories', body: summariseStories(fixtureStories), priority: 1 },
            { title: 'Tasks', body: summariseTasks(fixtureTasks), priority: 1 },
            { title: 'Project Slug', body: 'my-project\nUse this slug...', priority: 1 },
        ];
        const compact = buildContext(compactSections, 100000); // no budget limit

        // Build the verbose version (old behaviour)
        const verbose = [
            `## Architecture\n\n${JSON.stringify(fixtureArch, null, 2)}`,
            `\n## Tech Stack\n\n${JSON.stringify(fixtureTechStack, null, 2)}`,
            `\n## DB Design\n\n${JSON.stringify(fixtureDbDesign, null, 2)}`,
            `\n## User Stories\n\n${JSON.stringify(fixtureStories, null, 2)}`,
            `\n## Tasks\n\n${JSON.stringify(fixtureTasks, null, 2)}`,
            `\n## Project Slug: my-project\nUse this slug...`,
        ].join('\n');

        expect(compact.length).toBeLessThan(verbose.length * 0.5);
    });
});

describe('context stats', () => {
    beforeEach(() => _resetContextStats());

    it('starts empty', () => {
        expect(getContextStats()).toEqual({});
    });

    it('records chars per phase', () => {
        recordContextChars('architect', 1000);
        recordContextChars('dba', 500);
        recordContextChars('architect', 200);
        const stats = getContextStats();
        expect(stats['architect']).toBe(1200);
        expect(stats['dba']).toBe(500);
    });

    it('returns a defensive copy', () => {
        recordContextChars('test', 100);
        const stats = getContextStats();
        stats['test'] = 999;
        expect(getContextStats()['test']).toBe(100);
    });

    it('reset clears all stats', () => {
        recordContextChars('x', 42);
        _resetContextStats();
        expect(getContextStats()).toEqual({});
    });
});
