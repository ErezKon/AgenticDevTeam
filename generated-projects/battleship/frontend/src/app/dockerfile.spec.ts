import * as fs from 'fs';
import * as path from 'path';

describe('Dockerfile for Angular frontend', () => {
  it('[US-005#1] Dockerfile exists and contains required stages', () => {
    const dockerPath = path.resolve(__dirname, '../../Dockerfile');
    const exists = fs.existsSync(dockerPath);
    expect(exists).toBeTrue();
    const content = exists ? fs.readFileSync(dockerPath, 'utf8') : '';
    expect(content).toMatch(/FROM\s+node/);
    expect(content).toMatch(/npm run build --prod/);
    expect(content).toMatch(/FROM\s+nginx/);
  });
});
