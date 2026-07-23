import fs from 'fs';
import path from 'path';

describe('Calculator responsive layout CSS', () => {
  test('includes media query for max-width 600px', () => {
    const cssPath = path.join(__dirname, 'Calculator.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');
    expect(cssContent).toMatch(/@media\s*\(\s*max-width:\s*600px\s*\)/);
  });
});
