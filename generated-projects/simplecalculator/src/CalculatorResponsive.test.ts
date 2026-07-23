import fs from 'fs';
import path from 'path';

describe('Calculator responsive CSS', () => {
  it('includes media query to stack buttons vertically on small screens', () => {
    const cssPath = path.resolve(__dirname, 'Calculator.css');
    const cssContent = fs.readFileSync(cssPath, 'utf-8');
    expect(cssContent).toMatch(/@media\s*\(max-width:\s*599px\)\s*{[^}]*\.button-group\s*{[^}]*flex-direction:\s*column/);
  });
});
