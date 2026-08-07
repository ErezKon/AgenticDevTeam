import { promises as fs } from 'fs';
import path from 'path';

describe('Cypress configuration', () => {
  it('should have a cypress.config.ts file with baseUrl defined', async () => {
    const configPath = path.resolve(process.cwd(), 'cypress.config.ts');
    const content = await fs.readFile(configPath, 'utf-8');
    expect(content).toContain('baseUrl');
  });
});
