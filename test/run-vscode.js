'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const executable = process.env.VSCODE_EXECUTABLE || (process.platform === 'darwin'
  ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : null);
if (!executable || !fs.existsSync(executable)) {
  console.error('Set VSCODE_EXECUTABLE to the installed VS Code application executable.');
  process.exit(1);
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'collabcode-test-'));
const report = path.join(temp, 'report.json');
const result = spawnSync(executable, [
  '--new-window', '--user-data-dir', path.join(temp, 'profile'),
  '--extensions-dir', path.join(temp, 'extensions'), '--skip-welcome',
  '--skip-release-notes', '--disable-workspace-trust', '--disable-updates',
  `--extensionDevelopmentPath=${path.resolve(__dirname, '../extension')}`,
  `--extensionTestsPath=${path.resolve(__dirname, 'vscode-suite.js')}`
], { encoding: 'utf8', timeout: 45000, env: { ...process.env, COLLAB_TEST_REPORT: report } });
const evidence = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null;
if (result.status !== 0 || !evidence?.passed) {
  console.error(result.error?.message || result.stderr || result.stdout);
  console.error(evidence || 'No extension-host test report was generated.');
  process.exitCode = 1;
} else {
  console.log(`VS Code extension-host checks passed: ${evidence.checks.length}`);
  for (const check of evidence.checks) console.log(`  ✓ ${check}`);
}
console.log(`Test report: ${report}`);
