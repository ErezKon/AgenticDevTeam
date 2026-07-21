const { execSync } = require('child_process');
try {
    const out = execSync('npm install', { cwd: __dirname, encoding: 'utf8', stdio: 'pipe' });
    console.log('STDOUT:', out);
} catch (e) {
    console.log('ERROR:', e.message);
    if (e.stderr) console.log('STDERR:', e.stderr.toString());
    if (e.stdout) console.log('STDOUT:', e.stdout.toString());
}
