import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

const lock = JSON.parse(readFileSync('skill.lock.json', 'utf8'));
const packageName = lock.mcp.package;
const packageVersion = lock.mcp.version;
const prefix = join(process.env.RUNNER_TEMP || process.env.TEMP || '.', 'jintia-notebooklm-browser-smoke');
const packageDir = join(prefix, 'node_modules', ...packageName.split('/'));
const nodeModulesRoot = join(prefix, 'node_modules');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

execFileSync(npm, ['install', '--prefix', prefix, '--package-lock-only', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', `${packageName}@${packageVersion}`], { stdio: 'inherit' });
execFileSync(npm, ['ci', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'inherit' });

const installedLock = JSON.parse(readFileSync(join(prefix, 'package-lock.json'), 'utf8'));
const entry = installedLock.packages?.[`node_modules/${packageName}`];
if (entry?.version !== packageVersion || entry?.integrity !== lock.mcp.npmIntegrity) {
  throw new Error('El package-lock publicado no coincide con el contrato MCP.');
}

const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
const binValue = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['gemini-notebook-mcp'];
if (!binValue || isAbsolute(binValue) || binValue.split(/[\\/]/).includes('..')) throw new Error('El bin público del MCP no es seguro.');
const bin = realpathSync(join(packageDir, binValue));
const root = realpathSync(nodeModulesRoot);
const binRelative = relative(root, bin);
if (!statSync(bin).isFile() || !binRelative || isAbsolute(binRelative) || binRelative.startsWith('..')) throw new Error('El bin público queda fuera de node_modules.');

function run(action) {
  const result = spawnSync(process.execPath, [bin, 'browser', action, '--json'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`browser ${action} falló: ${result.stderr}`);
  const status = JSON.parse(result.stdout);
  if (status.browser !== 'chromium' || status.installed !== true || status.hermetic !== true || !status.executablePath) throw new Error(`Estado browser inválido tras ${action}.`);
  const executable = realpathSync(status.executablePath);
  const executableRelative = relative(root, executable);
  if (!statSync(executable).isFile() || !executableRelative || isAbsolute(executableRelative) || executableRelative.startsWith('..')) throw new Error('Chromium queda fuera del node_modules administrado.');
}

run('install');
run('status');
console.log('NotebookLM MCP browser contract OK');
