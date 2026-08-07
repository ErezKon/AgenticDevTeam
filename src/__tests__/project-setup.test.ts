import { promises as fs } from 'fs';
import path from 'path';

describe('Project setup files', () => {
  it('should have a valid tsconfig.json', async () => {
    const tsconfigPath = path.resolve(process.cwd(), 'tsconfig.json');
    const content = await fs.readFile(tsconfigPath, 'utf-8');
    const config = JSON.parse(content);
    expect(config).toHaveProperty('compilerOptions');
  });

  it('should have a valid ESLint config file', async () => {
    const eslintPath = path.resolve(process.cwd(), '.eslintrc.cjs');
    const content = await fs.readFile(eslintPath, 'utf-8');
    // Simple check that the file exports a config object
    expect(content).toContain('module.exports');
  });
});
