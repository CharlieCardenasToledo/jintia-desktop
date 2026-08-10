import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

const tempRoot = process.env.RUNNER_TEMP || process.env.TEMP || process.env.TMP || '.';
const jintiaPrefix = join(tempRoot, 'jintia-contract-smoke');
const mcpPrefix = join(tempRoot, 'jintia-mcp-contract-smoke');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const JINTIA_SPEC = '@charlie.act7/jintia@latest';
const opts = { stdio: 'inherit', shell: process.platform === 'win32' };
rmSync(jintiaPrefix, { recursive: true, force: true });
rmSync(mcpPrefix, { recursive: true, force: true });

function log(message) { console.log(`[notebooklm-smoke] ${message}`); }
function npmRun(prefix, args) {
  log(`npm ${args.join(' ')} en ${prefix}`);
  execFileSync(npm, [...args, '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund'], opts);
  log(`npm terminó correctamente: ${args.join(' ')}`);
}
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function exactVersion(value) { return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value); }
function sri(value) { return typeof value === 'string' && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value); }
function resolveBin(packageDir, manifest) {
  const value = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['gemini-notebook-mcp'];
  if (!value || isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error('El bin público no es seguro.');
  const root = realpathSync(packageDir);
  const bin = realpathSync(join(packageDir, value));
  const rel = relative(root, bin);
  if (!statSync(bin).isFile() || !rel || isAbsolute(rel) || rel.startsWith('..')) throw new Error('El bin público escapa del paquete.');
  return bin;
}
function browser(bin, action, managedRoot) {
  log(`iniciando MCP browser ${action} --json`);
  const started = Date.now();
  const result = spawnSync(process.execPath, [bin, 'browser', action, '--json'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`browser ${action} falló (status=${result.status}): ${result.stderr || result.stdout}`);
  log(`MCP browser ${action} terminó en ${((Date.now() - started) / 1000).toFixed(1)}s`);
  const status = JSON.parse(result.stdout);
  if (status.browser !== 'chromium' || status.installed !== true || status.hermetic !== true || !status.executablePath) throw new Error(`Estado browser inválido tras ${action}.`);
  const executable = realpathSync(status.executablePath);
  const rel = relative(realpathSync(managedRoot), executable);
  if (!statSync(executable).isFile() || !rel || isAbsolute(rel) || rel.startsWith('..')) throw new Error('Chromium queda fuera del entorno administrado.');
}

log(`prefijo Jintia: ${jintiaPrefix}`);
mkdirSync(jintiaPrefix, { recursive: true });
const [jintiaPackage, jintiaRange] = [JINTIA_SPEC.slice(0, JINTIA_SPEC.lastIndexOf('@')), JINTIA_SPEC.slice(JINTIA_SPEC.lastIndexOf('@') + 1)];
writeFileSync(join(jintiaPrefix, 'package.json'), JSON.stringify({ private: true, dependencies: { [jintiaPackage]: jintiaRange } }));
npmRun(jintiaPrefix, ['install']);
const jintiaRoot = join(jintiaPrefix, 'node_modules', '@charlie.act7', 'jintia');
const jintia = readJson(join(jintiaRoot, 'package.json'));
const contract = readJson(join(jintiaRoot, 'release', 'release-config.json'));
if (jintia.name !== '@charlie.act7/jintia' || !exactVersion(jintia.version)) throw new Error('Jintia instalado inválido.');
log(`Jintia instalado: ${jintia.name}@${jintia.version}`);
if (contract.$schemaVersion !== '1.0.0' || contract.repository !== 'CharlieCardenasToledo/jintia' || !exactVersion(contract.minimumDesktopVersion)) throw new Error('Contrato Jintia inválido.');
const mcp = contract.mcp;
if (mcp?.package !== '@charlie.act7/gemini-notebook-mcp' || !exactVersion(mcp.version) || typeof mcp.node !== 'string' || !mcp.node || !sri(mcp.npmIntegrity)) throw new Error('Contrato MCP inválido.');
log(`contrato distribuido: MCP ${mcp.package}@${mcp.version}`);

log(`creando prefijo MCP: ${mcpPrefix}`);
mkdirSync(mcpPrefix, { recursive: true });
writeFileSync(join(mcpPrefix, 'package.json'), JSON.stringify({ private: true, dependencies: { [mcp.package]: mcp.version } }));
npmRun(mcpPrefix, ['install', '--package-lock-only']);
npmRun(mcpPrefix, ['ci']);
const lock = readJson(join(mcpPrefix, 'package-lock.json'));
const entry = lock.packages?.[`node_modules/${mcp.package}`];
if (entry?.version !== mcp.version || entry?.integrity !== mcp.npmIntegrity) throw new Error('El lock MCP no coincide con el contrato instalado.');
log(`integrity del lock coincide con el contrato distribuido`);
const mcpRoot = join(mcpPrefix, 'node_modules', ...mcp.package.split('/'));
const bin = resolveBin(mcpRoot, readJson(join(mcpRoot, 'package.json')));
log(`bin público resuelto: ${bin}`);
browser(bin, 'install', join(mcpPrefix, 'node_modules'));
browser(bin, 'status', join(mcpPrefix, 'node_modules'));
console.log(`Jintia ${jintia.version} -> NotebookLM MCP ${mcp.version} browser contract OK`);
