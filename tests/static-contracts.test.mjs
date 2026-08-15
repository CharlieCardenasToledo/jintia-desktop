import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('Jintia es la identidad canónica en la aplicación y los instaladores', async () => {
  const [main, onboarding, html, tauriText, appPackageText, brandText, paths] = await Promise.all([
    readFile(new URL('src/main.js', root), 'utf8'),
    readFile(new URL('src/onboarding.js', root), 'utf8'),
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('src-tauri/tauri.conf.json', root), 'utf8'),
    readFile(new URL('package.json', root), 'utf8'),
    readFile(new URL('src/brand.json', root), 'utf8'),
    readFile(new URL('src-tauri/src/paths.rs', root), 'utf8'),
  ]);
  const tauri = JSON.parse(tauriText);
  const appPackage = JSON.parse(appPackageText);
  const brand = JSON.parse(brandText);

  assert.match(main, />Jintia</);
  assert.match(main, /Diseña el camino del aprendizaje/);
  assert.match(onboarding, />Jintia</);
  assert.match(onboarding, /Diseña el camino del aprendizaje/);
  assert.match(html, /<title>Jintia/);
  assert.equal(tauri.productName, 'Jintia Desktop');
  assert.equal(tauri.identifier, 'com.charliecardenas.jintia');
  assert.equal(appPackage.name, 'jintia-desktop');
  assert.equal(brand.brandName, 'Jintia');
  assert.match(paths, /\.join\("jintia-skill"\)/);
  assert.doesNotMatch(paths, /legacy_skill_dir|instructional-designer-skill/);
  assert.doesNotMatch(`${main}\n${onboarding}\n${tauriText}`, /legacy_skill_dir|instructional-designer-skill/);
});

test('la instalación de Jintia Skill usa únicamente la ruta canónica', async () => {
  const [paths] = await Promise.all([
    readFile(new URL('src-tauri/src/paths.rs', root), 'utf8'),
  ]);
  assert.match(paths, /pub fn skill_dir[\s\S]*\.join\("jintia-skill"\)/);
  const installedStart = paths.indexOf('pub fn installed_skill_dir()');
  const installedEnd = paths.indexOf('\npub fn ', installedStart + 1);
  const installedFn = paths.slice(installedStart, installedEnd < 0 ? paths.length : installedEnd);
  assert.match(installedFn, /skill_dir\(\)/);
  assert.doesNotMatch(installedFn, /SKILL\.md|legacy|instructional-designer/);
  assert.doesNotMatch(paths, /instructional-designer-skill/);
});

test('Desktop no conserva el manifest release legacy', async () => {
  await assert.rejects(
    access(new URL('src-tauri/resources/jintia-release-manifest.json', root)),
    error => error?.code === 'ENOENT'
  );
});

test('NotebookLM MCP usa el bin público y provisiona su browser', async () => {
  const [paths, mcp, runtimes, smoke, release] = await Promise.all([
    readFile(new URL('src-tauri/src/paths.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/mcp.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/runtimes.rs', root), 'utf8'),
    readFile(new URL('scripts/smoke-notebooklm-browser.mjs', root), 'utf8'),
    readFile(new URL('src-tauri/src/release.rs', root), 'utf8'),
  ]);
  const testModuleMarker = '\n#[cfg(test)]';
  const testModuleStart = mcp.indexOf(testModuleMarker);
  assert.ok(testModuleStart >= 0, 'mcp.rs debe conservar un módulo #[cfg(test)] aislable');
  const mcpProduction = mcp.slice(0, testModuleStart);
  const mcpTests = mcp.slice(testModuleStart);
  assert.match(paths, /portable_node_exe/);
  assert.match(paths, /portable_npm_cli/);
  assert.match(paths, /portable_notebooklm_mcp_prefix/);
  assert.doesNotMatch(paths, /pub fn portable_notebooklm_mcp_package_dir\(\)/);
  assert.match(paths, /portable_notebooklm_mcp_lock/);
  const npxStart = paths.indexOf('pub fn portable_npm_cli()');
  const npxEnd = paths.indexOf('\npub fn', npxStart + 1);
  const npxFn = paths.slice(npxStart, npxEnd < 0 ? paths.length : npxEnd);
  assert.match(npxFn, /portable_node_prefix/);
  assert.match(npxFn, /node_modules/);
  assert.match(npxFn, /npm/);
  assert.match(npxFn, /bin/);
  assert.match(npxFn, /npm-cli\.js/);

  assert.match(mcpProduction, /fn managed_mcp/);
  assert.match(mcpProduction, /managed_mcp_contract/);
  assert.match(mcpProduction, /portable_notebooklm_mcp_installed_for/);
  assert.match(mcpProduction, /portable_notebooklm_mcp_package_dir_for\(&contract\.package\)/);
  assert.match(mcpProduction, /resolve_notebooklm_mcp_bin_for\(&package_dir,\s*&contract\)/);
  assert.match(mcpProduction, /server_matches_managed_mcp/);
  assert.match(mcpTests, /managed_mcp_contract/);
  assert.match(mcpTests, /portable_notebooklm_mcp_installed_for/);
  assert.doesNotMatch(mcpTests, /portable_notebooklm_mcp_installed\(\)/);
  assert.doesNotMatch(mcp, /portable_notebooklm_mcp_installed\(\)/);
  assert.doesNotMatch(mcp, /NOTEBOOKLM_MCP_/);
  assert.match(mcpProduction, /portable_node_exe/);
  assert.match(runtimes, /resolve_notebooklm_mcp_bin_for/);
  assert.match(runtimes, /portable_notebooklm_mcp_package_dir_for/);
  assert.doesNotMatch(runtimes, /pub fn resolve_notebooklm_mcp_bin\(/);
  assert.doesNotMatch(runtimes, /pub fn portable_notebooklm_mcp_installed\(\)/);
  assert.match(runtimes, /browser/);
  assert.match(runtimes, /install/);
  assert.match(runtimes, /status/);
  assert.match(runtimes, /rollback|backup/);
  assert.match(smoke, /@charlie\.act7\/jintia@latest/);
  assert.match(smoke, /release-config\.json/);
  assert.match(smoke, /package-lock\.json/);
  assert.match(smoke, /browser/);
  assert.match(smoke, /installed/);
  assert.match(smoke, /hermetic/);
  assert.match(smoke, /installedMcp\.name/);
  assert.match(smoke, /installedMcp\.version/);
  assert.match(smoke, /finally/);
  assert.match(smoke, /rmSync\(jintiaPrefix/);
  assert.match(smoke, /rmSync\(mcpPrefix/);
  assert.match(smoke, /const first = browser/);
  assert.match(smoke, /const second = browser/);
  assert.match(smoke, /firstStatus/);
  assert.match(release, /managed_mcp_contract/);
  assert.match(release, /portable_skill_npm_package_dir/);
  assert.match(release, /release["'].*release-config\.json|release-config\.json/);
  assert.match(mcp, /managed_mcp_contract/);
  assert.match(runtimes, /install_notebooklm_mcp/);
  assert.match(runtimes, /notebooklm_lock_entry/);
  assert.match(runtimes, /contract\.package/);
  assert.match(runtimes, /notebooklm_package_dir/);
  assert.match(runtimes, /notebooklm_package_matches_contract/);
  assert.match(runtimes, /get\("packages"\)/);
  assert.doesNotMatch(runtimes, /pointer\(\s*"\/packages\/node_modules\/@charlie\.act7\/gemini-notebook-mcp/s);
  assert.match(runtimes, /package-lock\.json/);
  assert.match(runtimes, /package-lock-only/);
  assert.match(runtimes, /managed_mcp_contract_from/);
  assert.match(runtimes, /contract\.npm_integrity/);
  assert.match(runtimes, /npm.*ci|\["ci"/);
  assert.match(runtimes, /--omit=dev/);
  assert.match(smoke, /ci', '--omit=dev/);
  assert.ok(smoke.indexOf('package-lock-only') < smoke.indexOf('integrity del lock'));
  assert.ok(smoke.indexOf('integrity del lock') < smoke.indexOf("['ci', '--omit=dev']"));
  assert.ok(smoke.indexOf("['ci', '--omit=dev']") < smoke.indexOf('installedMcp.name'));
  assert.match(mcp, /--version/);
  assert.match(mcp, /Version::parse/);
  assert.match(mcp, /VersionReq::parse/);
  assert.match(mcp, /matches/);
  assert.match(mcp, /is_file/);
  assert.match(mcp, /managed\.bin|resolve_notebooklm_mcp_bin_for/);
  assert.doesNotMatch(mcp, /ManagedNpx|managed_npx|portable_npx_cli|npx-cli\.js|Command::new\("node"\)|Command::new\("npx"\)|Command::new\("npx\.cmd"\)|toml_edit::value\("npx"\)/);

  for (const [name, marker] of [
    ['configure_mcp', 'pub fn configure_mcp(target: String)'],
    ['configure_codex_mcp', 'pub fn configure_codex_mcp()'],
  ]) {
    const start = mcp.indexOf(marker);
    const end = mcp.indexOf('\npub fn ', start + marker.length);
    const fn = mcp.slice(start, end < 0 ? mcp.length : end);
    assert.match(fn, /managed_mcp/);
    assert.match(fn, /managed\.node/);
    assert.match(fn, /managed\.bin/);
    assert.ok(fn.indexOf('managed_mcp') < fn.indexOf('backup_file'));
    assert.ok(fn.indexOf('managed_mcp') < fn.indexOf('atomic_write'));
    assert.ok(name);
  }

  const spawnStart = mcp.indexOf('fn spawn() -> Result<Self, String>');
  const spawnEnd = mcp.indexOf('\n    fn ', spawnStart + 1);
  const spawnFn = mcp.slice(spawnStart, spawnEnd < 0 ? mcp.length : spawnEnd);
  assert.match(spawnFn, /managed_mcp/);
  assert.match(spawnFn, /managed_node_runtime_path/);
  assert.match(spawnFn, /build_managed_mcp_server_command/);
  assert.doesNotMatch(`${paths}\n${runtimes}\n${mcp}`, /dist\/(?:index|cli)\.js|patchright|\.local-browsers|PLAYWRIGHT_BROWSERS_PATH/);
});

test('la arquitectura separa la app de escritorio y el paquete instalable de la skill', async () => {
  const [config, build, windowsWorkflow, macosWorkflow] = await Promise.all([
    readFile(new URL('src-tauri/src/config.rs', root), 'utf8'),
    readFile(new URL('src-tauri/build.rs', root), 'utf8'),
    readFile(new URL('.github/workflows/release-windows.yml', root), 'utf8'),
    readFile(new URL('.github/workflows/release-macos.yml', root), 'utf8'),
  ]);
  assert.doesNotMatch(config, /\$OUT_DIR\/jintia-skill/);
  assert.match(config, /portable_skill_source_dir/);
  assert.match(config, /themes/);
  assert.match(build, /tauri_build::build/);
  assert.doesNotMatch(build, /skill\.lock\.json|jintia-release-manifest|NOTEBOOKLM_MCP_|skill_release\.rs/);

  for (const source of [config, build, windowsWorkflow, macosWorkflow]) {
    assert.doesNotMatch(source, /\.\.\/\.\.\/\.\.\/skill|app\/desktop/);
  }
});

test('la configuración y el curso consumen el contrato MCP dinámico', async () => {
  const [config, course, mcp, runtimes, build] = await Promise.all([
    readFile(new URL('src-tauri/src/config.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/course.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/mcp.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/runtimes.rs', root), 'utf8'),
    readFile(new URL('src-tauri/build.rs', root), 'utf8'),
  ]);
  assert.match(config, /server_matches_managed_mcp/);
  assert.doesNotMatch(config, /NOTEBOOKLM_MCP_|managed_mcp_contract|npx|@latest/);
  assert.match(course, /managed_mcp_contract/);
  assert.match(course, /portable_notebooklm_mcp_installed_for/);
  assert.doesNotMatch(course, /NOTEBOOKLM_MCP_/);
  assert.doesNotMatch(course, /portable_notebooklm_mcp_installed\(\)[\s\S]*portable_notebooklm_mcp_installed\(\)/);
  assert.doesNotMatch(mcp, /NOTEBOOKLM_MCP_/);
  assert.doesNotMatch(runtimes, /NOTEBOOKLM_MCP_/);
  const installStart = runtimes.indexOf('pub fn install_notebooklm_mcp');
  const installEnd = runtimes.indexOf('\n#[cfg(test)]', installStart);
  const install = runtimes.slice(installStart, installEnd < 0 ? runtimes.length : installEnd);
  assert.match(install, /contract\.package/);
  assert.doesNotMatch(install, /\.join\("@charlie\.act7"\)\.join\("gemini-notebook-mcp"\)/);
});

test('el build Rust está desacoplado del contrato release legacy', async () => {
  const [build, cargo] = await Promise.all([
    readFile(new URL('src-tauri/build.rs', root), 'utf8'),
    readFile(new URL('src-tauri/Cargo.toml', root), 'utf8'),
  ]);
  const buildDeps = cargo.slice(cargo.indexOf('[build-dependencies]'), cargo.indexOf('[dependencies]'));
  const runtimeDeps = cargo.slice(cargo.indexOf('[dependencies]'));
  assert.match(build, /tauri_build::build/);
  assert.doesNotMatch(build, /skill\.lock\.json|jintia-release-manifest|NOTEBOOKLM_MCP_|skill_release\.rs|\/mcp\/|npmIntegrity|VersionReq|OUT_DIR|CARGO_MANIFEST_DIR|sha256/);
  assert.match(buildDeps, /tauri-build/);
  assert.doesNotMatch(buildDeps, /serde_json\s*=|sha2\s*=|semver\s*=|zip\s*=/);
  assert.match(runtimeDeps, /serde_json\s*=/);
  assert.match(runtimeDeps, /sha2\s*=/);
  assert.match(runtimeDeps, /semver\s*=/);
});

test('release.rs conserva sólo el contrato Jintia dinámico', async () => {
  const release = await readFile(new URL('src-tauri/src/release.rs', root), 'utf8');
  assert.match(release, /managed_mcp_contract/);
  assert.match(release, /release-config\.json/);
  assert.doesNotMatch(release, /skill_release\.rs|NOTEBOOKLM_MCP_|OUT_DIR/);
});

test('el smoke de CI ejecuta el engine publicado en npm', async () => {
  const workflow = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');
  const start = workflow.indexOf('- name: Engine contract smoke test');
  const end = workflow.indexOf('\n      - ', start + 1);
  const smoke = workflow.slice(start, end < 0 ? workflow.length : end);

  assert.ok(start >= 0);
  assert.match(smoke, /RUNNER_TEMP/);
  assert.match(smoke, /jintia-engine-smoke/);
  assert.match(smoke, /npm install/);
  assert.match(smoke, /--prefix/);
  assert.match(smoke, /--no-save/);
  assert.match(smoke, /--no-audit/);
  assert.match(smoke, /--no-fund/);
  assert.match(smoke, /@charlie\.act7\/jintia@latest/);
  assert.match(smoke, /node_modules\/\@charlie\.act7\/jintia\/skill\/bin\/jintia\.js/);
  assert.match(smoke, /doctor/);
  assert.match(smoke, /--json/);
  assert.doesNotMatch(smoke, /target\/debug\/build|OUT_DIR|out\/jintia-skill|if \[ -f|if test|\|\| true|npx|continue-on-error/);

  assert.doesNotMatch(workflow, /check-skill-release/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /cargo test --manifest-path src-tauri\/Cargo\.toml/);
  assert.match(workflow, /node-version: 22\.13\.0/);
});

test('Desktop no conserva estado release legacy de Jintia', async () => {
  const [pkgText, ci, windows, macos, scripts] = await Promise.all([
    readFile(new URL('package.json', root), 'utf8'),
    readFile(new URL('.github/workflows/ci.yml', root), 'utf8'),
    readFile(new URL('.github/workflows/release-windows.yml', root), 'utf8'),
    readFile(new URL('.github/workflows/release-macos.yml', root), 'utf8'),
    readdir(new URL('scripts/', root)),
  ]);
  const pkg = JSON.parse(pkgText);
  assert.equal(pkg.scripts['skill:sync'], undefined);
  for (const workflow of [windows, macos]) {
    assert.doesNotMatch(workflow, /skill:verify|check-skill-release/);
  }
  assert.ok(!scripts.includes('check-skill-release.mjs'));
  assert.ok(!scripts.includes('sync-skill-release.mjs'));
  for (const relativePath of [
    'scripts/check-skill-release.mjs',
    'scripts/sync-skill-release.mjs',
    'skill.lock.json',
    'src-tauri/resources/jintia-release-manifest.json',
    '.gitattributes',
  ]) {
    await assert.rejects(access(new URL(relativePath, root)), error => error?.code === 'ENOENT');
  }
  const release = await readFile(new URL('src-tauri/src/release.rs', root), 'utf8');
  const smoke = await readFile(new URL('scripts/smoke-notebooklm-browser.mjs', root), 'utf8');
  const appMeta = await readFile(new URL('src/appMeta.js', root), 'utf8');
  const about = await readFile(new URL('src/pages/about.js', root), 'utf8');
  assert.match(release, /managed_mcp_contract/);
  assert.match(release, /release-config\.json/);
  assert.match(smoke, /@charlie\.act7\/jintia@latest/);
  assert.match(smoke, /release-config\.json/);
  assert.match(appMeta, /skillName:\s*"Jintia Skill"/);
  assert.doesNotMatch(appMeta, /skillVersion|skillLock|skill\.lock\.json|administrada/);
  assert.doesNotMatch(about, /APP_META\.skillVersion|v\$\{APP_META\.skill/);
  assert.match(about, /APP_META\.skillName/);
});

test('la instalación Claude delega en Jintia y conserva sólo consumidores compartidos', async () => {
  const [toolchain, config, lib] = await Promise.all([
    readFile(new URL('src-tauri/src/toolchain.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/config.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/lib.rs', root), 'utf8'),
  ]);
  assert.doesNotMatch(`${toolchain}\n${config}`, /pub fn install_local_skill|fn portable_skill_src|fn installed_portable_matches/);
  assert.doesNotMatch(`${toolchain}\n${config}`, /\.jintia-skill\.stage-|jintia-skill\.backup-/);
  assert.match(config, /sync_user_config_to_install/);
  assert.match(toolchain, /pub fn claude_skill_status/);
  assert.match(toolchain, /claude_status_args/);
  assert.match(config, /toolchain::claude_skill_status/);
  assert.match(lib, /spawn_blocking\(\|\|/);
  assert.doesNotMatch(lib, /payload::installed_skill_path/);
  const helperStart = toolchain.indexOf('pub fn install_global_claude_skill()');
  const helperEnd = toolchain.indexOf('/// Gestiona harnesses', helperStart);
  const helper = toolchain.slice(helperStart, helperEnd);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.match(helper, /resolve_skill/);
  assert.match(helper, /run_jintia/);
  assert.match(helper, /--help/);
  assert.match(helper, /--adopt-existing/);
  assert.match(toolchain, /--providers=claude/);
  assert.match(toolchain, /--scope=global/);
  assert.match(toolchain, /--yes/);
  assert.match(toolchain, /--json/);
  assert.match(toolchain, /results/);
  assert.match(toolchain, /target/);
  assert.match(helper, /with_path/);
  assert.doesNotMatch(helper, /Command::new|--source|\.claude|skill_dir|\bnpx\b|\bnpm\b/);
  assert.match(lib, /spawn_blocking\(toolchain::install_global_claude_skill\)/);
});

test('el plugin ChatGPT Codex delega instalación y estado a Jintia', async () => {
  const [toolchain, config, lib] = await Promise.all([
    readFile(new URL('src-tauri/src/toolchain.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/config.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/lib.rs', root), 'utf8'),
  ]);
  assert.doesNotMatch(`${toolchain}\n${config}`, /materialize_openai_plugin_from_portable|openai_plugin_portable_matches|register_openai_marketplace|pub fn openai_plugin_is_installed|pub fn openai_plugin_is_current|pub fn openai_plugin_path|\.jintia-plugin\.stage-|jintia\.backup-/);
  for (const marker of ['plugin', 'status', 'install', '--yes', '--json', 'resolve_skill', 'run_jintia', 'tool', 'command', 'exitCode', 'marketplaceConfigured', 'target', 'data', 'operation', 'installed', 'current', 'errors', 'message']) assert.match(toolchain, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(toolchain, /ActionResult::error\(result\.stderr\)/);
  assert.match(toolchain, /plugin_report_error[\s\S]*status[^\n]*failed/);
  assert.match(toolchain, /plugin_command_failure_message\(&result\.stdout,\s*"plugin install"\)/);
  assert.match(config, /toolchain::openai_plugin_status/);
  assert.doesNotMatch(config, /openai_plugin_is_installed\(|openai_plugin_is_current\(|openai_plugin_path\(\)/);
  assert.match(lib, /spawn_blocking\(toolchain::install_openai_plugin\)/);
  assert.match(lib, /spawn_blocking\(config::setup_status\)/);
});

test('Desktop no reconstruye ni exporta el artefacto OpenAI', async () => {
  const files = await Promise.all([
    'src-tauri/src/lib.rs', 'src/api.js',
    'src/pages/settings.js', 'src/mocks/tauri-core.mock.js',
  ].map(file => readFile(new URL(file, root), 'utf8')));
  assert.doesNotMatch(files.join('\n'), /portable_openai_plugin_sources|export_openai_plugin_zip|exportOpenAIPluginZip|btn-export-openai-plugin|jintia-openai-plugin-|\.jintia-openai-/);
});

test('Desktop no conserva exportación manual de Skill', async () => {
  await assert.rejects(access(new URL('src-tauri/src/payload.rs', root)), error => error?.code === 'ENOENT');
  const sources = await Promise.all(['src-tauri/src/lib.rs','src/api.js','src/onboarding.js','src/pages/settings.js','src/pages/activate.js','src/mocks/tauri-core.mock.js'].map(path => readFile(new URL(path, root), 'utf8')));
  for (const source of sources) assert.doesNotMatch(source, /export_skill_zip|exportSkillZip|btn-export-skill|export-zip|lastSkillZip|last_export_path|record_export|portable_skill_export_source|claude-cowork/);
});
test('el modo mock no anuncia plantillas que el backend no incorpora', async () => {
  const mock = await readFile(new URL('src/mocks/tauri-core.mock.js', root), 'utf8');
  assert.match(mock, /id:\s*"elegantbook-clasico"/);
  assert.doesNotMatch(mock, /minimal-mono|ieee-tecnico|cuaderno-taller/);
});

test('la firma SignPath solo publica artifacts verificados cuando está activada', async () => {
  const workflow = await readFile(
    new URL('.github/workflows/release-windows.yml', root),
    'utf8',
  );
  assert.match(workflow, /id:\s*upload-unsigned-artifact/);
  assert.match(workflow, /signpath\/github-action-submit-signing-request@v2/);
  assert.match(workflow, /vars\.SIGNPATH_ENABLED == 'true'/);
  assert.match(workflow, /Get-AuthenticodeSignature/);
  assert.match(workflow, /signature\.Status -ne 'Valid'/);
  assert.match(workflow, /Publish signed GitHub Release assets/);
  assert.match(workflow, /Publish unsigned GitHub Release assets/);
  assert.match(workflow, /Windows artifacts in this release are not digitally signed/);
});

test('la configuración institucional generada conserva el contrato consumido por la skill', async () => {
  const configSource = await readFile(new URL('src-tauri/src/config.rs', root), 'utf8');
  assert.match(configSource, /"website": clean\(&config\.website\)/);
  assert.match(configSource, /"logoPath": ""/);
  assert.doesNotMatch(configSource, /"includeGradedActivities": config\.include_graded_activities/);
});

test('el único degradado CSS es el highlight refractivo del control Liquid', async () => {
  const css = await readFile(new URL('src/styles.css', root), 'utf8');
  assert.match(css, /\.liquid-control::before\s*\{[\s\S]*linear-gradient\s*\(/i);
  assert.equal((css.match(/gradient\s*\(/gi) || []).length, 1);
});

test('todo ícono usado con ic(name) está registrado en icons.js (si no, Lucide no dibuja nada)', async () => {
  const icons = await readFile(new URL('src/icons.js', root), 'utf8');
  const registered = new Set(
    [...icons.matchAll(/\b([A-Z][a-zA-Z0-9]*)\b/g)].map(m => m[1])
  );
  const kebabToPascal = kebab => kebab.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join('');

  const files = ['src/onboarding.js', 'src/main.js', 'src/pages/courses.js', 'src/pages/syllabus.js',
    'src/pages/templates.js', 'src/pages/settings.js', 'src/pages/docs.js'];
  const missing = [];
  for (const file of files) {
    const source = await readFile(new URL(file, root), 'utf8');
    for (const match of source.matchAll(/\bic\(\s*["'`]([a-z0-9-]+)["'`]/g)) {
      const pascal = kebabToPascal(match[1]);
      if (!registered.has(pascal)) missing.push(`${file}: ic("${match[1]}") -> ${pascal}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('el onboarding colapsó a cinco pasos y conserva la llamada de finalización', async () => {
  const source = await readFile(new URL('src/onboarding.js', root), 'utf8');
  assert.match(source, /TOTAL_STEPS\s*=\s*5/);
  assert.match(source, /completeOnboarding/);
  assert.match(source, /advanceOnboarding/);
  const metaStart = source.indexOf('const STEP_META');
  const metaEnd = source.indexOf('\n];', metaStart);
  const stepMeta = source.slice(metaStart, metaEnd);
  assert.equal((stepMeta.match(/\btitle:/g) || []).length, 5);
});

test('el onboarding no bloquea la carga inicial con NotebookLM', async () => {
  const source = await readFile(new URL('src/onboarding.js', root), 'utf8');
  const start = source.indexOf('export async function renderOnboarding');
  const end = source.indexOf('function stepNumber', start);
  const initialRender = source.slice(start, end);
  assert.match(initialRender, /await getOnboardingStatus\(\)/);
  assert.match(initialRender, /prepareOnboardingStep\(currentStep/);
  assert.doesNotMatch(initialRender, /await checkNotebookLMAuth\(\)/);
  // NotebookLM ahora vive en el paso 4 (fusionado con destino), no en un
  // paso dedicado -sigue sin calentarse por adelantado (ver warmOnboardingData).
  assert.match(source, /if \(step === 4\)[\s\S]*runtime\.auth = await checkNotebookLMAuth\(\)/);
  assert.doesNotMatch(source, /warmOnboardingData[\s\S]*?checkNotebookLMAuth/);
});

test('institución, perfil académico y plantilla viven en un solo paso fusionado', async () => {
  const source = await readFile(new URL('src/onboarding.js', root), 'utf8');
  const start = source.indexOf('function profileStep');
  const end = source.indexOf('function renderOnboardingSiteAnalysis', start);
  assert.ok(start >= 0, 'profileStep debe existir');
  const profile = source.slice(start, end);
  assert.match(profile, /onb-discipline/);
  assert.match(profile, /onb-institution/);
  assert.match(profile, /onb-faculty/);
  assert.match(profile, /onb-career/);
  assert.match(profile, /onb-author/);
  assert.doesNotMatch(profile, /onb-include-graded-activities/);
  // El campo de ecosistema digital se quitó del onboarding por redundante
  // para la primera configuración; sigue existiendo en Configuración.
  assert.doesNotMatch(profile, /onb-ecosystem/);
  assert.match(profile, /data-template-id/);
  assert.match(profile, /"save-profile-and-template"/);
  // Un único guardado combinado: ya no existen las acciones separadas.
  assert.doesNotMatch(source, /"save-institution-basics"|"save-institution"|"save-template"/);
});

test('el onboarding presenta el flujo de producción editorial aprobado', async () => {
  const source = await readFile(new URL('src/onboarding.js', root), 'utf8');
  assert.match(source, /Sílabo[\s\S]*Análisis[\s\S]*Fuentes[\s\S]*Estructura[\s\S]*Validación[\s\S]*Generación/);
  assert.match(source, /No diseña la guía ni reemplaza tu criterio docente/);
  assert.match(source, /Preparando la prueba/);
  // Labels del mini-stepper del self-test delegado a jintia self-test --json
  assert.match(source, /Validar[\s\S]*Renderizar[\s\S]*Vivliostyle[\s\S]*PDF[\s\S]*Listo/);
});

test('el copy del onboarding no repite jerga técnica ni referencias obsoletas al esquema de 10 pasos', async () => {
  const source = await readFile(new URL('src/onboarding.js', root), 'utf8');
  // Textos visibles: nada de "skill" expuesto al usuario final fuera de las
  // llamadas internas a la API (installSkill, getSkillPath, exportSkillZip).
  const stepMetaStart = source.indexOf('const STEP_META');
  const stepMetaEnd = source.indexOf('\n];', stepMetaStart);
  assert.doesNotMatch(source.slice(stepMetaStart, stepMetaEnd), /producción|publicar|sistema completo/i);
  assert.doesNotMatch(source, /los 10 pasos|10 pasos del onboarding/);
  assert.doesNotMatch(source, /dentro del paso 4/); // el mini-stepper de herramientas vive en el paso 2
  assert.doesNotMatch(source, /"Instalando la skill en Claude Code…"|"Conectando la skill con Claude/);
});

test('el copy visible no reintroduce jerga técnica ya eliminada por auditoría de UX', async () => {
  const [onboarding, settings] = await Promise.all([
    readFile(new URL('src/onboarding.js', root), 'utf8'),
    readFile(new URL('src/pages/settings.js', root), 'utf8'),
  ]);
  const banned = /Sistema editorial|motor de producción|perfil editorial|Zona peligrosa|Instalando skill/;
  assert.doesNotMatch(onboarding, banned);
  assert.doesNotMatch(settings, banned);
});

test('el stepper usa el nodo de camino Jintia y controles Liquid Glass', async () => {
  const [source, css] = await Promise.all([
    readFile(new URL('src/onboarding.js', root), 'utf8'),
    readFile(new URL('src/styles.css', root), 'utf8'),
  ]);
  const bottomNavStart = source.indexOf('function renderBottomNav');
  const bottomNavEnd = source.indexOf('function loadingStep', bottomNavStart);
  const bottomNav = source.slice(bottomNavStart, bottomNavEnd);
  assert.match(source, /function animateStepTransition/);
  assert.match(source, /function animateDotWorm/);
  assert.match(source, /onboarding-progress-node/);
  assert.match(source, /node\.animate\(keyframes/);
  assert.match(source, /function showPreparedStep/);
  assert.doesNotMatch(bottomNav, /data-tauri-drag-region/);
  assert.match(bottomNav, /onboarding-nav-arrow[\s\S]*liquid-control/);
  assert.match(bottomNav, /ui\.liquid\.group/);
  assert.match(css, /\.liquid-control/);
  assert.match(css, /\.onboarding-progress-node/);
  assert.match(css, /var\(--color-brand-600/);
});

test('el onboarding bloquea clics repetidos y explica la operación activa', async () => {
  const source = await readFile(new URL('src/onboarding.js', root), 'utf8');
  assert.match(source, /async function runOnboardingOperation/);
  assert.match(source, /if \(onboardingActionInFlight\) return/);
  assert.match(source, /root\.setAttribute\("aria-busy"/);
  assert.match(source, /id="onboarding-operation-status"/);
  assert.match(source, /data-disabled-by-operation|disabledByOperation/);
  assert.match(source, /Instalando \$\{name\}[\s\S]*performDependencyInstall/);
  assert.match(source, /Ejecutando la prueba final[\s\S]*animateFinalStep/);
});

test('instalar una dependencia siempre pide autorización explícita antes de tocar el sistema', async () => {
  const source = await readFile(new URL('src/onboarding.js', root), 'utf8');
  const fnStart = source.indexOf('async function requestDependencyInstall');
  const fnEnd = source.indexOf('\n}', fnStart);
  const fn = source.slice(fnStart, fnEnd);
  assert.match(fn, /await confirmInOnboarding\(dependencyInstallConfirmMessage\(name\)\)/);
  assert.match(fn, /if \(!confirmed\) return/);
  assert.match(source, /function dependencyInstallConfirmMessage/);
});

test('la confirmación de instalar dependencias es un modal propio, no un diálogo nativo del SO', async () => {
  const source = await readFile(new URL('src/onboarding.js', root), 'utf8');
  assert.doesNotMatch(source, /@tauri-apps\/plugin-dialog/);
  assert.match(source, /function confirmInOnboarding/);
  assert.match(source, /document\.getElementById\("onboarding-root"\)/);
});

test('el entorno base usa Node, Python, Jintia y Vivliostyle; LaTeX es opcional', async () => {
  const [onboarding, settings, course, onboardingRs] = await Promise.all([
    readFile(new URL('src/onboarding.js', root), 'utf8'),
    readFile(new URL('src/pages/settings.js', root), 'utf8'),
    readFile(new URL('src-tauri/src/course.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/onboarding.rs', root), 'utf8'),
  ]);

  // Docker y WSL no forman parte de la arquitectura administrada por Jintia.
  assert.doesNotMatch(onboarding, /Docker|WSL/);
  assert.doesNotMatch(settings, /Docker|WSL/);
  assert.doesNotMatch(
    course,
    /name:\s*"Docker"|name:\s*"WSL 2"|compile_via_docker|compile_via_wsl|docker_available|"TeX Live \(pdflatex\)"/
  );

  // Dependencias base obligatorias.
  assert.match(
    course,
    /name:\s*"Node\.js"[\s\S]{0,500}?required:\s*true/
  );
  assert.match(
    course,
    /name:\s*"Python"[\s\S]{0,500}?required:\s*true/
  );
  assert.match(
    course,
    /name:\s*"Jintia Skill"[\s\S]{0,500}?required:\s*true/
  );
  assert.match(
    course,
    /name:\s*"Vivliostyle CLI"[\s\S]{0,500}?required:\s*true/
  );

  // LaTeX puede detectarse como capacidad opcional, pero nunca bloquear onboarding.
  assert.match(
    course,
    /name:\s*"Compilador LaTeX"[\s\S]{0,500}?required:\s*false/
  );

  // validate_environment debe exigir el runtime editorial actual.
  assert.match(onboardingRs, /installed\("Node\.js"\)/);
  assert.match(onboardingRs, /installed\("Python"\)/);
  assert.match(onboardingRs, /installed\("Vivliostyle CLI"\)/);

  // LaTeX no debe formar parte de la validación obligatoria del onboarding.
  assert.doesNotMatch(
    onboardingRs,
    /installed\("Compilador LaTeX"\)/
  );

  // Se conserva el contrato actual del panel de herramientas.
  assert.doesNotMatch(settings, />Instalar todo</);
  assert.match(settings, /Instalar herramientas necesarias/);
  assert.match(settings, /BULK_INSTALL_TARGETS/);
});

test('Vivliostyle se resuelve únicamente desde el runtime portable administrado', async () => {
  const [paths, runtimes, course] = await Promise.all([
    readFile(new URL('src-tauri/src/paths.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/runtimes.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/course.rs', root), 'utf8'),
  ]);

  assert.match(
    paths,
    /pub fn portable_vivliostyle_bin\(\)/
  );

  assert.match(
    runtimes,
    /pub fn resolve_vivliostyle\(\)/
  );

  const resolverStart = runtimes.indexOf(
    'pub fn resolve_vivliostyle()'
  );

  const resolverEnd = runtimes.indexOf(
    'pub fn vivliostyle_version()',
    resolverStart
  );

  const resolver = runtimes.slice(
    resolverStart,
    resolverEnd
  );

  assert.match(
    resolver,
    /portable_vivliostyle_bin/
  );

  assert.doesNotMatch(
    resolver,
    /where\.exe|which/
  );

  assert.doesNotMatch(
    resolver,
    /\.arg\("vivliostyle"\)/
  );

  assert.match(
    course,
    /installed:\s*vivliostyle_ready/
  );

  assert.match(
    course,
    /version:\s*vivliostyle_version,/
  );

  assert.doesNotMatch(
    course,
    /installed:\s*command_exists\("vivliostyle"\)/
  );
});

test('Vivliostyle consulta su versión únicamente con el runtime Node administrado', async () => {
  const runtimes = await readFile(
    new URL('src-tauri/src/runtimes.rs', root),
    'utf8'
  );
  const versionStart = runtimes.indexOf(
    'pub fn vivliostyle_version()'
  );
  const versionEnd = runtimes.indexOf(
    'pub fn resolve_node_cli',
    versionStart
  );
  assert.ok(versionStart >= 0 && versionEnd > versionStart);
  const versionFn = runtimes.slice(versionStart, versionEnd);

  assert.match(versionFn, /resolve_vivliostyle\(\)/);
  assert.match(versionFn, /portable_node_exe\(\)/);
  assert.match(versionFn, /managed_node_runtime_path\(\)/);
  assert.match(
    versionFn,
    /build_managed_node_cli_version_command/
  );
  assert.match(versionFn, /\["--version"\]/);
  assert.doesNotMatch(
    versionFn,
    /var_os\("PATH"\)|split_paths|base_path|path_entries|patched_path|Command::new\(&executable\)|Command::new\("node"\)|Command::new\("cmd"\)|\.arg\("\/C"\)|where\.exe|which/
  );
});

test('CLIs Node administrados consultan su versión sin heredar NODE_OPTIONS del host', async () => {
  const runtimes = await readFile(
    new URL('src-tauri/src/runtimes.rs', root),
    'utf8'
  );

  const builderStart = runtimes.indexOf('fn build_managed_node_cli_version_command');
  const builderEnd = runtimes.indexOf('fn build_managed_npm_install_command', builderStart);
  assert.ok(builderStart >= 0 && builderEnd > builderStart);
  const builder = runtimes.slice(builderStart, builderEnd);

  // builder — positivos estructurales
  assert.match(builder, /cfg!\(target_os\s*=\s*"windows"\)/);
  assert.match(builder, /managed_node_command\("cmd"\)/);
  assert.match(builder, /managed_node_command\(node\)/);
  assert.match(builder, /\.arg\(executable\)/);
  assert.match(builder, /\.args\(args\)/);
  assert.match(builder, /\.env\("PATH",\s*managed_path\)/);

  // builder — negativos de aislamiento
  assert.doesNotMatch(builder, /env_clear|current_dir|NODE_PATH|split_paths|std::env::var(?:_os)?\(\s*"(?:NODE_OPTIONS|PATH)"|std::env::(?:set_var|remove_var)|\.env\(\s*"NODE_OPTIONS"|which|where\.exe|powershell|bash\s+-c|sh\s+-c|Command::new\("(?:node|npm|npx)"\)/);

  // la política no debe duplicarse en los consumidores
  const versionerStart = runtimes.indexOf('pub fn node_cli_version(');
  const versionerEnd = runtimes.indexOf('fn managed_node_runtime_path', versionerStart);
  assert.ok(versionerStart >= 0 && versionerEnd > versionerStart);
  const versioner = runtimes.slice(versionerStart, versionerEnd);
  assert.doesNotMatch(versioner, /env_remove\("NODE_OPTIONS"\)/);

  const vivliostyleStart = runtimes.indexOf('pub fn vivliostyle_version()');
  const vivliostyleEnd = runtimes.indexOf('pub fn resolve_node_cli', vivliostyleStart);
  assert.ok(vivliostyleStart >= 0 && vivliostyleEnd > vivliostyleStart);
  const vivliostyle = runtimes.slice(vivliostyleStart, vivliostyleEnd);
  assert.doesNotMatch(vivliostyle, /env_remove\("NODE_OPTIONS"\)/);
});

test('el onboarding delega la prueba final a jintia self-test --json', async () => {
  const source = await readFile(
    new URL('src/onboarding.js', root),
    'utf8'
  );

  const navigationStart = source.indexOf('function bindStepEvents');
  const navigationEnd = source.indexOf(
    'function hexToRgb',
    navigationStart
  );
  const navigation = source.slice(
    navigationStart,
    navigationEnd
  );

  // Se conservan los contratos de carga/caché del onboarding.
  assert.match(source, /existing\.status === "pending"/);
  assert.match(
    source,
    /rememberSuccessfulLoad\("notebooklm-auth"\)/
  );
  assert.match(
    source,
    /prepareOnboardingStep\(4, \{ force: true \}\)/
  );
  assert.doesNotMatch(
    navigation,
    /force:\s*(?:dest|destination|next)/
  );

  // La prueba editorial pertenece a Jintia Skill.
  assert.match(
    source,
    /runSkillSelfTest\(\)/
  );

  // Desktop interpreta los checks devueltos por la Skill.
  assert.match(
    source,
    /const checkNames = \["validate", "render", "vivliostyle", "pdf"\]/
  );

  // Desktop no debe reconstruir manualmente el pipeline de la Skill.
  assert.doesNotMatch(
    source,
    /initSelfTestCourse/
  );
  assert.doesNotMatch(
    source,
    /runSkillTool\("validate"/
  );
  assert.doesNotMatch(
    source,
    /runSkillTool\("render"/
  );

  // getSetupStatus continúa siendo parte del onboarding general.
  assert.match(source, /getSetupStatus/);
});

test('la barra inferior tiene un botón principal con texto visible y puntos con área de clic ampliada', async () => {
  const source = await readFile(new URL('src/onboarding.js', root), 'utf8');
  const start = source.indexOf('function renderBottomNav');
  const end = source.indexOf('function syncOnboardingBusyState', start);
  const bottomNav = source.slice(start, end);
  // El botón de avance ya no es solo un ícono con tooltip: el label de
  // footerConfig se ve como texto real dentro del botón (Ley de Fitts /
  // "qué puedo hacer ahora" de Norman), no solo en aria-label/title.
  assert.match(bottomNav, /<span>\$\{escapeHtml\(footerConfig\.label\)\}<\/span>/);
  const dotsStart = source.indexOf('function progressDots');
  const dotsEnd = source.indexOf('function actionButton', dotsStart);
  const dots = source.slice(dotsStart, dotsEnd);
  assert.match(dots, /onboarding-progress-dot-hit w-8 h-8/);
});

test('el paso de herramientas bloquea el avance nombrando la herramienta faltante', async () => {
  const source = await readFile(new URL('src/onboarding.js', root), 'utf8');
  const missing = source.indexOf("dep.required && !dep.installed");
  assert.ok(missing >= 0, 'dependenciesStep debe filtrar herramientas requeridas no instaladas');
  assert.match(source, /Falta instalar: \$\{missing\.map/);
});

test('Git no aparece como tarjeta en el onboarding (solo en Configuración > Entorno)', async () => {
  const source = await readFile(new URL('src/onboarding.js', root), 'utf8');
  const start = source.indexOf('function dependencySequence');
  const end = source.indexOf('\n}', start);
  const fn = source.slice(start, end);
  assert.match(fn, /runtime\.dependencies\.filter\(dep => dep\.required\)/);
});

test('los destinos distinguen Claude del plugin universal de ChatGPT y Codex', async () => {
  const source = await readFile(new URL('src/onboarding.js', root), 'utf8');
  const start = source.indexOf('function connectStep()');
  const end = source.indexOf('function finalStep()', start);
  assert.ok(start >= 0 && end > start);
  const connect = source.slice(start, end);
  assert.match(connect, /id: "claude-code"/); assert.match(connect, /id: "openai"/); assert.match(connect, /id: "both"/);
  assert.match(connect, /skill_installed && setup\.skill_current/);
  assert.match(connect, /skillReady && setup\.mcp_claude_code_configured/);
  assert.match(connect, /setup\.openai_plugin_current/);
  assert.match(connect, /skillReady && setup\.mcp_claude_code_configured && setup\.openai_plugin_current/);
  assert.doesNotMatch(connect, /claude-cowork|lastSkillZip|mcp_desktop_configured/);
});
test('Entorno detecta motores visuales opcionales sin instalarlos silenciosamente', async () => {
  const [course, models, setup, settings] = await Promise.all([
    readFile(new URL('src-tauri/src/course.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/models.rs', root), 'utf8'),
    readFile(new URL('src/pages/setup.js', root), 'utf8'),
    readFile(new URL('src/pages/settings.js', root), 'utf8'),
  ]);
  for (const tool of ['Graphviz', 'Mermaid CLI', 'PlantUML', 'D2', 'Vega-Lite CLI', 'WaveDrom', 'Inkscape', 'Google Chrome']) {
    assert.match(course, new RegExp(`"${tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  }
  assert.match(models, /pub installable: bool/);
  assert.match(course, /installable: false/);
  assert.match(setup, /dep\.installable !== false/);
  assert.match(settings, /dep\.installable !== false/);
  assert.doesNotMatch(course, /"Graphviz"\s*=>|"Mermaid CLI"\s*=>|"PlantUML"\s*=>/);
});

test('Entorno ofrece perfiles visuales desde el runtime npm sin instalación automática', async () => {
  const [api, settings, lib] = await Promise.all([
    readFile(new URL('src/api.js', root), 'utf8'),
    readFile(new URL('src/pages/settings.js', root), 'utf8'),
    readFile(new URL('src-tauri/src/lib.rs', root), 'utf8'),
  ]);
  assert.match(api, /getVisualInstallProfiles/);
  assert.match(lib, /get_visual_install_profiles/);
  assert.match(lib, /runtimes::visual_install_profiles/);
  assert.doesNotMatch(lib, /OUT_DIR[\s\S]{0,100}visual-install-profiles\.json/);
  assert.match(settings, /jintia\.visualProfile/);
  assert.match(settings, /Capacidades deshabilitadas/);
});

test('cambiar el destino mantiene sincronizada la selección visible del onboarding', async () => {
  const source = await readFile(new URL('src/onboarding.js', root), 'utf8');
  const start = source.indexOf('input[name=onboarding-target]');
  const end = source.indexOf('root.querySelectorAll("[data-onboarding-action]"', start);
  const handler = source.slice(start, end);
  assert.match(handler, /const selectedTarget = event\.currentTarget\.value/);
  assert.match(handler, /runtime\.status = \{[\s\S]*selectedTarget/);
});

test('el checklist final depende del destino elegido (no asume Skill instalada siempre)', async () => {
  const source = await readFile(new URL('src/onboarding.js', root), 'utf8');
  const start = source.indexOf('function finalStep');
  const end = source.indexOf('function animateFinalStep', start);
  const final = source.slice(start, end);
  assert.match(final, /const connectionChecks = \{/);
  assert.doesNotMatch(final, /claude-cowork|lastSkillZip|export-zip/);
  assert.doesNotMatch(final, /Archivo exportado|Paquete listo|Claude\/Cowork/);
});

test('el paso de perfil fusionado tiene divisores visuales numerados entre secciones', async () => {
  const source = await readFile(new URL('src/onboarding.js', root), 'utf8');
  const start = source.indexOf('function profileStep');
  const end = source.indexOf('function renderOnboardingSiteAnalysis', start);
  const profile = source.slice(start, end);
  assert.match(profile, /function sectionHeading|const sectionHeading/);
  assert.match(profile, /border-t border-gray-200/);
});

test('los botones de Conexiones en Settings usan los targets que el backend realmente acepta', async () => {
  const [settings, mcp] = await Promise.all([
    readFile(new URL('src/pages/settings.js', root), 'utf8'),
    readFile(new URL('src-tauri/src/mcp.rs', root), 'utf8'),
  ]);
  // configure_mcp() en mcp.rs solo reconoce "claude-code" y "desktop"; usar
  // "claude_code" (guion bajo), "cowork" o "all" hace que el botón siempre
  // falle con "Destino MCP no reconocido".
  assert.match(mcp, /"claude-code"\s*=>/);
  assert.match(mcp, /"desktop"\s*=>/);
  assert.doesNotMatch(settings, /data-target="claude_code"|data-target="cowork"|data-target="all"/);
  assert.match(settings, /data-target="claude-code"/);
  assert.match(settings, /data-target="desktop"/);
  assert.match(settings, /configureMcp\("claude-code"\)/);
  assert.match(settings, /configureMcp\("desktop"\)/);
});

// ELIMINADO: Test "el backend evita reescrituras, reinstalaciones y recompilaciones idénticas"
// Razón: Validaciones de PDF (.production-validation.json) fueron eliminadas en FASE 2
// La compilación ahora se delega a Skill CLI via Engine Adapter

test('el dashboard permite minimizar, maximizar, cerrar y arrastrar sin añadir maximizar al onboarding', async () => {
  const [capabilityText, main, onboarding, windowMock] = await Promise.all([
    readFile(new URL('src-tauri/capabilities/default.json', root), 'utf8'),
    readFile(new URL('src/main.js', root), 'utf8'),
    readFile(new URL('src/onboarding.js', root), 'utf8'),
    readFile(new URL('src/mocks/tauri-window.mock.js', root), 'utf8'),
  ]);
  const capability = JSON.parse(capabilityText);
  const permissions = new Set(capability.permissions);
  assert.ok(permissions.has('core:window:allow-minimize'));
  assert.ok(permissions.has('core:window:allow-toggle-maximize'));
  assert.ok(permissions.has('core:window:allow-close'));
  assert.ok(permissions.has('core:window:allow-start-dragging'));
  assert.match(main, /id="app-win-maximize"/);
  assert.match(main, /getCurrentWindow\(\)\.toggleMaximize\(\)/);
  assert.match(windowMock, /toggleMaximize/);
  assert.doesNotMatch(onboarding, /onb-win-maximize/);
});

test('la UI compartida usa recetas Tailwind v4 y no reintroduce componentes CSS legacy', async () => {
  const [css, recipes] = await Promise.all([
    readFile(new URL('src/styles.css', root), 'utf8'),
    readFile(new URL('src/uiClasses.js', root), 'utf8'),
  ]);
  assert.match(css, /@theme\s*\{/);
  assert.doesNotMatch(css, /^\.btn(?:-|\s|\{|\:)/m);
  assert.doesNotMatch(css, /^\.glass-(?:card|pane|input)\b/m);
  assert.doesNotMatch(css, /^\.form-(?:grid|group)\b/m);
  assert.doesNotMatch(css, /^\.(?:nav-item|nav-badge|courses-table|status-pill|syllabus-layout|tpl-layout|lp-|latex-)/m);
  assert.match(css, /prefers-reduced-transparency/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(recipes, /export const ui/);
  assert.match(recipes, /backdrop-blur-xl/);
  assert.match(recipes, /backdrop-saturate-150/);
  assert.match(recipes, /surface:\s*\{/);
});

test('Liquid Glass aparece solo en controles y el contenido principal permanece opaco', async () => {
  const files = ['main.js', 'pages/about.js', 'pages/courses.js', 'pages/settings.js', 'pages/syllabus.js', 'pages/templates.js', 'pages/docs.js', 'pages/institution.js', 'templatePreview.js'];
  const pageSources = (await Promise.all(files.map(file => readFile(new URL(`src/${file}`, root), 'utf8')))).join('\n');
  assert.doesNotMatch(pageSources, /(?:card|table)[^"`]*backdrop-blur/i);
  assert.doesNotMatch(pageSources, /panel[^"`]*backdrop-blur/i);
  assert.doesNotMatch(pageSources, /glass-(?:card|pane|input)/);
  assert.match(pageSources, /bg-white/);
});

test('Liquid Glass tiene fallbacks completos de accesibilidad', async () => {
  const css = await readFile(new URL('src/styles.css', root), 'utf8');
  assert.match(css, /prefers-reduced-transparency/);
  assert.match(css, /backdrop-filter:\s*none/);
  assert.match(css, /\.liquid-control::before,[\s\S]*display:\s*none\s*!important/);
  assert.match(css, /prefers-reduced-motion/);
  const onboarding = await readFile(new URL('src/onboarding.js', root), 'utf8');
  assert.match(onboarding, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
});

test('router y topbar usan atributos e IDs estables, no clases legacy', async () => {
  const [router, main] = await Promise.all([
    readFile(new URL('src/router.js', root), 'utf8'),
    readFile(new URL('src/main.js', root), 'utf8'),
  ]);
  assert.doesNotMatch(router, /querySelectorAll\(["']\.nav-item/);
  assert.match(router, /data-nav-item/);
  assert.match(main, /id="topbar-title"/);
  assert.match(main, /id="topbar-sub"/);
  assert.match(router, /getElementById\("topbar-title"\)/);
});

test('Acerca de Jintia está conectado al pie, Ayuda y metadatos de ejecución', async () => {
  const [main, router, docs, about, api, appMeta] = await Promise.all([
    readFile(new URL('src/main.js', root), 'utf8'),
    readFile(new URL('src/router.js', root), 'utf8'),
    readFile(new URL('src/pages/docs.js', root), 'utf8'),
    readFile(new URL('src/pages/about.js', root), 'utf8'),
    readFile(new URL('src/api.js', root), 'utf8'),
    readFile(new URL('src/appMeta.js', root), 'utf8'),
  ]);
  assert.match(router, /about:\s*\{\s*title:\s*"Acerca de Jintia"/);
  assert.match(main, /data-sidebar-page data-page="about"/);
  assert.doesNotMatch(main, /v10\.4 · jintia-skill/);
  assert.match(docs, /data-doc-nav="about"/);
  assert.match(about, /Creado y mantenido por/);
  assert.match(about, /about-origin/);
  assert.match(about, /Aarma jintia/);
  assert.match(about, /originDisclaimer/);
  assert.match(about, /Tauri[\s\S]*Rust[\s\S]*React[\s\S]*ElegantBook/);
  assert.match(api, /Promise\.all\(\[[\s\S]*getName\(\)[\s\S]*getVersion\(\)/);
  assert.match(appMeta, /creator:\s*"Charlie Cárdenas Toledo"/);
  assert.match(appMeta, /originName: brand\.linguisticForm/);
});

test('los enlaces externos de Acerca de usan opener con una lista cerrada', async () => {
  const [api, capabilityText] = await Promise.all([
    readFile(new URL('src/api.js', root), 'utf8'),
    readFile(new URL('src-tauri/capabilities/default.json', root), 'utf8'),
  ]);
  const capability = JSON.parse(capabilityText);
  assert.match(api, /ALLOWED_EXTERNAL_URLS\.includes\(url\)/);
  assert.match(api, /openUrl\(url\)/);
  const opener = capability.permissions.find(permission => permission?.identifier === 'opener:allow-open-url');
  assert.ok(opener);
  assert.ok(opener.allow.every(entry =>
    entry.url.startsWith('https://github.com/CharlieCardenasToledo') ||
    entry.url === 'claude://*' ||
    entry.url === 'codex://*' ||
    entry.url === 'https://notebook.google.com/'
  ));
});

test('el crédito opcional de Jintia no sustituye la autoría académica', async () => {
  const [settings, templates] = await Promise.all([
    readFile(new URL('src/pages/settings.js', root), 'utf8'),
    readFile(new URL('src/pages/templates.js', root), 'utf8'),
  ]);
  assert.match(settings, /id="cfg-include-jintia-credit"/);
  assert.match(settings, /Nunca sustituye ni modifica la autoría académica/);
  // El crédito se pasa cuando se genera el sílabo de vista previa en Plantillas
  assert.match(templates, /includeJintiaCredit:\s*state\.config\?\.includeJintiaCredit !== false/);
});

test('Configuración muestra una sola sección y conserva navegación accesible', async () => {
  const settings = await readFile(new URL('src/pages/settings.js', root), 'utf8');
  assert.match(settings, /let _settingsSection = "inst-profile"/);
  assert.match(settings, /data-settings-panel/);
  assert.match(settings, /sectionHidden\("inst-profile"\)/);
  assert.match(settings, /panel\.classList\.toggle\("hidden"/);
  assert.match(settings, /aria-current/);
});

test('Configuración muestra Notebooks como panel de solo lectura derivado de Cursos', async () => {
  const settings = await readFile(new URL('src/pages/settings.js', root), 'utf8');
  const courses = await readFile(new URL('src/pages/courses.js', root), 'utf8');
  assert.match(settings, /function renderNotebookList/);
  assert.match(settings, /state\.courses/);
  assert.match(settings, /btn-go-to-courses/);
  assert.doesNotMatch(settings, /nb-code|nb-course-name|nb-root|btn-add-notebook|async function addNotebook|async function syncNotebooks/);
  assert.doesNotMatch(settings, /getNotebooks|saveNotebooks\(/);
  assert.match(courses, /function syncNotebooksFromCourses/);
  assert.match(courses, /await saveNotebooksConfig\(entries\)/);
  assert.match(courses, /listNotebooksMcp/);
});

test('Configuración protege operaciones asíncronas y el reinicio no promete borrar datos', async () => {
  const settings = await readFile(new URL('src/pages/settings.js', root), 'utf8');
  assert.match(settings, /async function runSettingsOperation/);
  assert.match(settings, /aria-busy/);
  assert.match(settings, /No se eliminarán tu perfil, asignaturas, notebooks ni archivos/);
  assert.match(settings, /const r = await resetOnboarding\(\)/);
  assert.match(settings, /if \(!r\.success\)/);
  assert.match(settings, /window\.location\.reload\(\)/);
});

test('Configuración ejecuta el diagnóstico de la toolchain mediante un comando Tauri seguro', async () => {
  const settings = await readFile(new URL('src/pages/settings.js', root), 'utf8');
  const api = await readFile(new URL('src/api.js', root), 'utf8');
  const rust = await readFile(new URL('src-tauri/src/lib.rs', root), 'utf8');
  const toolchain = await readFile(new URL('src-tauri/src/toolchain.rs', root), 'utf8');
  assert.match(settings, /btn-run-toolchain-doctor/);
  assert.match(settings, /runSkillTool\("doctor"\)/);
  assert.match(settings, /btn-run-toolchain-operation/);
  assert.match(settings, /runSkillTool\(operation, target, strict\)/);
  assert.match(api, /invoke\("run_skill_tool"/);
  assert.match(rust, /run_skill_tool/);
  assert.match(toolchain, /engine::run_jintia/);
  assert.match(toolchain, /manage_harness/);
});

test('Plantillas separa selección, vista previa y activación confirmada', async () => {
  const templates = await readFile(new URL('src/pages/templates.js', root), 'utf8');
  // preview delega a generateSyllabus (Vivliostyle vía skill CLI)
  assert.match(templates, /generateSyllabus/);
  assert.match(templates, /convertFileSrc/);
  assert.match(templates, /<iframe/);
  assert.match(templates, /data-select-template/);
  assert.match(templates, /Usar esta plantilla/);
  assert.match(templates, /Plantilla activa/);
  assert.match(templates, /aria-pressed/);
  assert.match(templates, /aria-busy/);
  assert.doesNotMatch(templates, /Activa \/ Editar/);
  assert.doesNotMatch(templates, /renderTemplatePreview/);
});

// ELIMINADO: Test "el backend compila la vista previa sin cambiar la plantilla activa"
// Razón: preview_template fue eliminado en FASE 2, ahora la compilación se delega a skill CLI

// ELIMINADO: Test sobre manejo de pdflatex (ya no es relevante, compilación delegada a skill)

test('Plantillas muestra el catálogo completo sin cortar resultados', async () => {
  const templates = await readFile(new URL('src/pages/templates.js', root), 'utf8');
  assert.match(templates, /templates\.map\(templateCard\)/);
  assert.doesNotMatch(templates, /gridItems|templates\.filter\([^;]+slice\(0/);
  assert.match(templates, /btn-retry-templates/);
  assert.match(templates, /No hay plantillas en esta categoría/);
});

test('Plantillas comparten una guía semanal de demostración realista', async () => {
  const templates = await readFile(new URL('src/pages/templates.js', root), 'utf8');
  const sample = await readFile(new URL('src/sampleGuide.js', root), 'utf8');
  const course = await readFile(new URL('src-tauri/src/course.rs', root), 'utf8');

  // onboarding ya no usa muestra sintética: delega a `jintia init` para la prueba final real
  assert.match(templates, /buildSampleGuideData\(state\.config/);
  assert.match(sample, /Pensamiento crítico y decisiones profesionales/);
  assert.match(sample, /Facione, P\. A\./);
  assert.doesNotMatch(sample, /Apellido, [A-Z]\./);
  // El contenido de demostración ya no se genera desde Rust LaTeX;
  // Desktop ahora delega a `jintia init` que crea una estructura JSON pura
  assert.match(course, /build_syllabus_md/);
  assert.match(course, /Transferencia a cualquier profesión/);
  assert.match(course, /Autoevaluación/);
});

test('Configuración distingue una skill instalada de una skill actualizada', async () => {
  const [currentModels, currentConfig, currentToolchain] = await Promise.all(['src-tauri/src/models.rs','src-tauri/src/config.rs','src-tauri/src/toolchain.rs'].map(path => readFile(new URL(path, root), 'utf8')));
  assert.match(currentModels, /skill_installed[\s\S]*skill_current[\s\S]*skill_version[\s\S]*available_skill_version/);
  assert.match(currentConfig, /claude_skill_status/); assert.match(currentToolchain, /ClaudeSkillStatus[\s\S]*installed[\s\S]*current[\s\S]*version[\s\S]*available_version[\s\S]*target/);
  const setup = currentConfig.slice(currentConfig.indexOf('pub fn setup_status'), currentConfig.indexOf('\n}', currentConfig.indexOf('pub fn setup_status')) + 2);
  assert.match(setup, /skill_installed:\s*claude\.installed/); assert.match(setup, /skill_current:\s*claude\.current/);
  assert.match(setup, /skill_version:\s*claude\.version/); assert.match(setup, /available_skill_version:\s*claude\.available_version/); assert.match(setup, /skill_path:\s*claude\.target/);
});
test('Jintia se gestiona como plugin universal para ChatGPT y Codex', async () => {
  const [pluginToolchain, pluginOnboarding, pluginApi, pluginLib] = await Promise.all(['src-tauri/src/toolchain.rs','src/onboarding.js','src/api.js','src-tauri/src/lib.rs'].map(path => readFile(new URL(path, root), 'utf8')));
  const statusStart = pluginToolchain.indexOf('fn openai_plugin_status_args()');
  const installStart = pluginToolchain.indexOf('fn openai_plugin_install_args()');
  const statusBlock = pluginToolchain.slice(statusStart, installStart);
  const installBlock = pluginToolchain.slice(installStart, pluginToolchain.indexOf('const OPENAI_PLUGIN_CAPABILITY_ERROR', installStart));
  assert.ok(statusStart >= 0 && installStart > statusStart);
  assert.match(statusBlock, /\["plugin",\s*"status",\s*"--json"\]/);
  assert.doesNotMatch(statusBlock, /--yes/);
  assert.match(installBlock, /\["plugin",\s*"install",\s*"--yes",\s*"--json"\]/);
  assert.doesNotMatch(installBlock, /\["plugin",\s*"status"/);
  assert.match(pluginToolchain, /install_openai_plugin/); assert.match(pluginToolchain, /openai_plugin_status/); assert.match(pluginToolchain, /resolve_skill/); assert.match(pluginToolchain, /run_jintia/);
  assert.match(pluginOnboarding, /openai/); assert.match(pluginApi, /installOpenAIPlugin/); assert.match(pluginLib, /install_openai_plugin/);
});
test('Desktop no contiene payload de Skill embebido', async () => {
  await assert.rejects(access(new URL('src-tauri/src/payload.rs', root)), error => error?.code === 'ENOENT');
  const sources = await Promise.all(['src-tauri/src/lib.rs','src-tauri/src/config.rs','src-tauri/src/toolchain.rs'].map(path => readFile(new URL(path, root), 'utf8')));
  assert.doesNotMatch(sources.join('\n'), /\$OUT_DIR\/jintia-skill|SKILL_MD|SKILL_PACKAGE_JSON|materialize_payload|write_embedded_dir|embedded_dir_matches|installed_payload_matches/);
});
test('Ayuda cubre el flujo real del producto y ofrece FAQ local buscable', async () => {
  const docs = await readFile(new URL('src/pages/docs.js', root), 'utf8');
  assert.match(docs, /const FAQS = \[/);
  assert.match(docs, /help-search/);
  assert.match(docs, /filterHelp/);
  assert.match(docs, /Jintia Desktop y jintia-skill/);
  assert.match(docs, /NotebookLM/);
  assert.match(docs, /¿Necesito WSL para compilar\?/);
  assert.match(docs, /no tiene telemetría ni un backend propio/i);
  assert.match(docs, /No se eliminan el perfil, las asignaturas, los notebooks ni los archivos generados/);
});

test('Ayuda navega a la sección visible de Configuración, no a un panel oculto', async () => {
  const docs = await readFile(new URL('src/pages/docs.js', root), 'utf8');
  assert.match(docs, /data-settings-nav/);
  assert.match(docs, /nav\.click\(\)/);
  assert.match(docs, /section:\s*"environment"/);
  assert.match(docs, /"notebooks-section"/);
});

test('la prueba final transmite progreso y permite copiar un diagnóstico', async () => {
  const [onboarding, lib] = await Promise.all([
    readFile(new URL('src/onboarding.js', root), 'utf8'),
    readFile(new URL('src-tauri/src/lib.rs', root), 'utf8'),
  ]);
  // El mecanismo de progress events cambió: ya no usa emit_compile_progress
  // porque la compilación fue delegada a la skill CLI
  assert.match(onboarding, /Copiar diagnóstico/);
  assert.match(onboarding, /Reportar problema/);
  assert.match(lib, /run_migration/);
  assert.match(lib, /check_migration_needed/);
});

test('el editor de silabo protege borradores y usa estados editoriales explicitos', async () => {
  const syllabus = await readFile(new URL('src/pages/syllabus.js', root), 'utf8');
  assert.match(syllabus, /const AUTOSAVE_DELAY = 700/);
  assert.match(syllabus, /persistCurrentWeek\("draft", \{ silent: true \}\)/);
  assert.match(syllabus, /collectWeekFormData\(_activeWeek, "complete"\)/);
  assert.match(syllabus, /week\.status === "complete"/);
  assert.match(syllabus, /_activeWeek = clampWeek\(_activeWeek, count\)/);
  assert.doesNotMatch(syllabus, /course\.weeks = Math\.max/);
});

test('el formulario del silabo exige bibliografia y actividad con validacion accesible', async () => {
  const syllabus = await readFile(new URL('src/pages/syllabus.js', root), 'utf8');
  assert.match(syllabus, /\["bibliography", "Bibliografía \/ Recursos"\]/);
  assert.match(syllabus, /GRADED_ACTIVITY_FIELD = \["graded_activity", "Actividades calificadas"\]/);
  assert.match(syllabus, /id: "wf-activity"[\s\S]*textarea: true/);
  assert.match(syllabus, /include_graded_activities === true/);
  assert.match(syllabus, /<label for="\$\{id\}"/);
  assert.match(syllabus, /<fieldset[\s\S]*<legend/);
  assert.match(syllabus, /aria-invalid/);
  assert.match(syllabus, /id="syl-error-summary"/);
  assert.match(syllabus, /min-h-11/);
});

test('Courses muestra progreso real y protege sus operaciones', async () => {
  const [courses, api, main] = await Promise.all([
    readFile(new URL('src/pages/courses.js', root), 'utf8'),
    readFile(new URL('src/api.js', root), 'utf8'),
    readFile(new URL('src/main.js', root), 'utf8'),
  ]);
  assert.match(courses, /week\?\.status === "complete"/);
  assert.match(courses, /role="dialog" aria-modal="true"/);
  assert.match(courses, /id="course-settings-modal"/);
  assert.match(courses, /include_graded_activities/);
  assert.match(api, /save_course_settings/);
  assert.match(courses, /event\.key === "Escape"/);
  assert.match(courses, /step="1"/);
  assert.match(courses, /Number\.isInteger\(weeks\)/);
  assert.match(courses, /_folderBusy\.has\(index\)/);
  assert.match(courses, /persistCourseList/);
  assert.match(courses, /ui\.surface\.cardGlass,\s*'relative hidden min-h-0 overflow-visible lg:block'/);
  assert.match(courses, /top-12 z-50 min-w-\[205px\]/);
  assert.match(api, /initializeReadme = true/);
  assert.match(main, /data-create-course/);
  assert.match(main, /jintia:new-course/);
});

test('Courses incorpora el estado persistente de semanas sin reemplazar el progreso local', async () => {
  const courses = await readFile(new URL('src/pages/courses.js', root), 'utf8');
  const api = await readFile(new URL('src/api.js', root), 'utf8');
  const rust = await readFile(new URL('src-tauri/src/course_state.rs', root), 'utf8');
  assert.match(courses, /getCourseState/);
  assert.match(courses, /Desactualizado/);
  assert.match(courses, /_courseStates/);
  assert.match(api, /get_course_state/);
  assert.match(rust, /state\.json/);
});

test('Courses valida skill, conexión y dependencias antes de abrir una IA', async () => {
  const [courses, api] = await Promise.all([
    readFile(new URL('src/pages/courses.js', root), 'utf8'),
    readFile(new URL('src/api.js', root), 'utf8'),
  ]);
  assert.match(courses, /getSetupStatus/);
  assert.match(courses, /checkDependencies/);
  assert.match(courses, /validateAiReadiness/);
  assert.match(courses, /skill_current/);
  assert.match(courses, /mcp_claude_code_configured/);
  assert.match(courses, /openai_plugin_current/);
  assert.match(courses, /codex:\/\/threads\/new/);
  assert.equal(courses.includes("https://chatgpt.com/"), false);
  assert.match(courses, /navigate\("settings"\)/);
  assert.match(api, /export async function getSetupStatus/);
});

test('Desktop comparte la detección de harnesses con la CLI', async () => {
  const api = await readFile(new URL('src/api.js', root), 'utf8');
  const lib = await readFile(new URL('src-tauri/src/lib.rs', root), 'utf8');
  const backend = await readFile(new URL('src-tauri/src/harnesses.rs', root), 'utf8');
  const mock = await readFile(new URL('src/mocks/tauri-core.mock.js', root), 'utf8');
  const settings = await readFile(new URL('src/pages/settings.js', root), 'utf8');
  assert.match(api, /detect_harnesses/);
  assert.match(api, /manage_harnesses/);
  assert.match(lib, /detect_harnesses/);
  assert.match(lib, /manage_harnesses/);
  assert.match(backend, /detection_payload/);
  assert.match(mock, /detect_harnesses/);
  assert.match(mock, /manage_harnesses/);
  assert.match(settings, /btn-detect-harnesses/);
  assert.match(settings, /detectAgentHarnesses/);
  assert.match(settings, /data-harness-operation/);
  assert.doesNotMatch(settings, /claude,codex,cursor|id=["']harness-providers["']/);
  assert.match(settings, /result\.providers/);
  assert.match(settings, /data-harness-provider/);
  assert.match(settings, /provider\.id/);
  assert.match(settings, /provider\.name/);
  assert.match(settings, /:checked/);
  assert.match(settings, /manageHarnesses/);
  assert.match(settings, /new Set/);
  assert.doesNotMatch(settings, /SUPPORTED_HARNESSES|const PROVIDERS/);
  assert.doesNotMatch(settings, /ollama|lmstudio|lm-studio|llama\.cpp/i);
  assert.match(mock, /id: "claude"/);
  assert.match(mock, /id: "opencode"/);
});

test('las asignaturas usan Documentos por defecto y permiten cambiar la ubicación', async () => {
  const [courses, api, lib] = await Promise.all([
    readFile(new URL('src/pages/courses.js', root), 'utf8'),
    readFile(new URL('src/api.js', root), 'utf8'),
    readFile(new URL('src-tauri/src/lib.rs', root), 'utf8'),
  ]);
  assert.match(lib, /app\.path\(\)\.document_dir\(\)/);
  assert.match(lib, /path\.join\("Jintia"\)/);
  assert.match(api, /invoke\("get_default_course_root"\)/);
  assert.match(api, /dialogOpen\(\{ directory: true, title, defaultPath \}\)/);
  assert.match(courses, /id="m-change-root"/);
  assert.match(courses, /project_root: rootPath/);
  assert.match(courses, /Documentos\/Jintia\/codigo_nombre/);
  assert.match(courses, /El proyecto se preparará automáticamente/);
  assert.match(courses, /project_status: "preparing"/);
  assert.doesNotMatch(courses, /m-prepare-now|prepareNow|Registrar asignatura/);
  assert.match(await readFile(new URL('src-tauri/src/course.rs', root), 'utf8'), /course_folder_name/);
});

test('el sílabo reutiliza la ruta preparada antes de pedir otra carpeta', async () => {
  const syllabus = await readFile(new URL('src/pages/syllabus.js', root), 'utf8');
  assert.match(syllabus, /course\.project_root \|\| parentDirectory\(course\.project_path\)/);
  assert.match(syllabus, /if \(!coursePath\) \{[\s\S]*pickDirectory/);
  assert.match(syllabus, /course\.project_root = coursePath/);
});

test('la estructura del curso delega a jintia init via Engine Adapter', async () => {
  const [course, engine] = await Promise.all([
    readFile(new URL('src-tauri/src/course.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/engine.rs', root), 'utf8'),
  ]);
  assert.match(course, /engine::run_jintia/);
  assert.match(course, /init/);
  assert.match(course, /--code/);
  assert.match(course, /--name/);
  assert.match(engine, /pub fn run_jintia/);
});

test('la biblioteca muestra solo PDFs pertenecientes a proyectos registrados', async () => {
  const [page, api, main, router, backend, lib] = await Promise.all([
    readFile(new URL('src/pages/pdfs.js', root), 'utf8'),
    readFile(new URL('src/api.js', root), 'utf8'),
    readFile(new URL('src/main.js', root), 'utf8'),
    readFile(new URL('src/router.js', root), 'utf8'),
    readFile(new URL('src-tauri/src/pdfs.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/lib.rs', root), 'utf8'),
  ]);
  assert.match(main, /registerPage\("pdfs",\s+renderPdfs\)/);
  assert.match(main, /data-page="pdfs"/);
  assert.match(main, /id="p-pdfs"/);
  assert.match(router, /pdfs:\s*\{\s*title:\s*"PDFs generados"/);
  assert.match(api, /invoke\("list_generated_pdfs"/);
  assert.match(api, /invoke\("open_generated_pdf"/);
  assert.match(api, /invoke\("reveal_generated_pdf"/);
  assert.match(page, /Biblioteca de PDFs/);
  assert.match(page, /data-pdf-action="open"/);
  assert.match(page, /data-pdf-action="reveal"/);
  assert.match(backend, /eq_ignore_ascii_case\("pdf"\)/);
  assert.match(backend, /file_type\(\)\.is_symlink\(\)/);
  assert.match(backend, /candidate\.starts_with\(root\)/);
  assert.match(lib, /validated_pdf_path/);
});

test('cada proyecto conserva una identidad visual accesible dentro de Jintia', async () => {
  const courses = await readFile(new URL('src/pages/courses.js', root), 'utf8');
  const uiClasses = await readFile(new URL('src/uiClasses.js', root), 'utf8');
  assert.match(courses, /const PROJECT_COLORS = Object\.values\(projectColorMap\)/);
  assert.match(uiClasses, /export const projectColorMap = \{/);
  assert.match(courses, /const PROJECT_ICONS = \[/);
  assert.match(courses, /data-project-color/);
  assert.match(courses, /data-project-icon/);
  assert.match(courses, /aria-pressed/);
  assert.match(courses, /Personalizar en Jintia/);
  assert.match(courses, /No modifica el icono de la carpeta de Windows/);
  assert.match(courses, /project_color: _modalData\.projectColor/);
  assert.match(courses, /project_icon: _modalData\.projectIcon/);
});

test('eliminar una asignatura usa un modal propio de Jintia, no un diálogo nativo del SO', async () => {
  const courses = await readFile(new URL('src/pages/courses.js', root), 'utf8');
  assert.match(courses, /function openDeleteModal/);
  assert.match(courses, /id="course-delete-modal"/);
  assert.match(courses, /role="dialog" aria-modal="true" aria-labelledby="course-delete-title"/);
  assert.match(courses, /function handleDeleteKeydown/);
  assert.match(courses, /function confirmDelete/);
  assert.doesNotMatch(courses, /await confirm\(`¿Eliminar/);
});

test('el perfil disciplinar se instala después de guardar la disciplina', async () => {
  const source = await readFile(
    new URL('src/onboarding.js', root),
    'utf8'
  );

  const actionStart = source.indexOf(
    'if (action === "save-profile-and-template")'
  );

  const actionEnd = source.indexOf(
    'if (action === "install-local")',
    actionStart
  );

  assert.ok(
    actionStart >= 0,
    'save-profile-and-template debe existir'
  );

  assert.ok(
    actionEnd > actionStart,
    'debe poder aislarse el bloque save-profile-and-template'
  );

  const actionBlock = source.slice(
    actionStart,
    actionEnd
  );

  assert.match(
    actionBlock,
    /state\.config = config/
  );

  assert.match(
    actionBlock,
    /saveConfig\(\)/
  );

  assert.match(
    actionBlock,
    /installDisciplinePackages\(\)/
  );

  assert.match(
    actionBlock,
    /return advance\(current\)/
  );

  const saveIndex =
    actionBlock.indexOf('saveConfig()');

  const installIndex =
    actionBlock.indexOf(
      'installDisciplinePackages()'
    );

  const advanceIndex =
    actionBlock.indexOf(
      'return advance(current)'
    );

  assert.ok(
    saveIndex < installIndex,
    'la disciplina debe guardarse antes de instalar su perfil'
  );

  assert.ok(
    installIndex < advanceIndex,
    'las dependencias disciplinares deben intentarse antes de avanzar'
  );

  const fnStart = source.indexOf(
    'async function installDisciplinePackages()'
  );

  const fnEnd = source.indexOf(
    'async function handleAction',
    fnStart
  );

  const fn = source.slice(
    fnStart,
    fnEnd
  );

  assert.match(
    fn,
    /profile\?\.python\?\.packages/
  );

  assert.match(
    fn,
    /profile\?\.node\?\.packages/
  );

  assert.match(
    fn,
    /getCapabilitiesProfiles\(\)/
  );
});

test('los paquetes Node disciplinares usan exclusivamente Node npm CLI y PATH administrados', async () => {
  const runtimes = await readFile(
    new URL('src-tauri/src/runtimes.rs', root),
    'utf8'
  );

  const start = runtimes.indexOf(
    'pub fn install_npm_packages'
  );

  const end = runtimes.indexOf(
    '// ==================== CHECKSUM VERIFICATION',
    start
  );

  assert.ok(
    start >= 0,
    'install_npm_packages debe existir'
  );

  assert.ok(
    end > start,
    'debe poder aislarse install_npm_packages'
  );

  const fn = runtimes.slice(start, end);
  const builderStart = runtimes.indexOf(
    'fn build_managed_npm_install_command'
  );
  const builderEnd = runtimes.indexOf(
    'pub fn install_vivliostyle',
    builderStart
  );

  assert.ok(
    builderStart >= 0 && builderEnd > builderStart,
    'debe poder aislarse el builder del command npm administrado'
  );

  const builder = runtimes.slice(builderStart, builderEnd);

  assert.match(
    fn,
    /portable_node_exe\(\)/
  );

  assert.match(
    fn,
    /portable_node_prefix\(\)/
  );

  assert.match(
    fn,
    /portable_npm_cli\(\)/
  );

  assert.match(
    fn,
    /managed_node_runtime_path\(\)/
  );

  assert.match(
    fn,
    /build_managed_npm_install_command/
  );

  assert.match(
    builder,
    /managed_node_command\(node\)/
  );

  assert.match(
    builder,
    /\.args\(packages\)/
  );

  assert.match(
    builder,
    /\.arg\(npm_cli\)[\s\S]*\.arg\("install"\)[\s\S]*\.arg\("--global"\)[\s\S]*\.arg\("--prefix"\)[\s\S]*\.arg\(prefix\)[\s\S]*\.env\("PATH",\s*managed_path\)/
  );

  assert.doesNotMatch(
    fn,
    /var_os\("PATH"\)|split_paths|base_path|path_entries|patched_path|npm_exe|Command::new\("cmd"\)|npm\.cmd|cmd.*\/C|sh.*-c|bash.*-c|powershell/
  );

  assert.doesNotMatch(
    builder,
    /var_os\("PATH"\)|split_paths|base_path|path_entries|patched_path|Command::new\("cmd"\)|npm\.cmd|cmd.*\/C|sh.*-c|bash.*-c|powershell/
  );
});

test('los paquetes pip disciplinares usan exclusivamente Python y PATH administrados', async () => {
  const runtimes = await readFile(
    new URL('src-tauri/src/runtimes.rs', root),
    'utf8'
  );

  const installerStart = runtimes.indexOf(
    'pub fn install_pip_packages'
  );
  const installerEnd = runtimes.indexOf(
    '// ==================== NPM PACKAGES ====================',
    installerStart
  );
  assert.ok(installerStart >= 0 && installerEnd > installerStart);
  const pipInstaller = runtimes.slice(installerStart, installerEnd);

  const builderStart = runtimes.indexOf(
    'fn build_managed_pip_install_command'
  );
  const builderEnd = runtimes.indexOf(
    '// ==================== NPM PACKAGES ====================',
    builderStart
  );
  assert.ok(builderStart >= 0 && builderEnd > builderStart);
  const builder = runtimes.slice(builderStart, builderEnd);

  const pathStart = runtimes.indexOf(
    'fn managed_python_runtime_path'
  );
  const pathEnd = runtimes.indexOf(
    'fn build_managed_pip_install_command',
    pathStart
  );
  assert.ok(pathStart >= 0 && pathEnd > pathStart);
  const managedPath = runtimes.slice(pathStart, pathEnd);

  for (const required of [
    'portable_python_exe()',
    'managed_python_runtime_path()',
    'build_managed_pip_install_command',
    '.output()',
    'pip install falló',
  ]) {
    assert.match(
      pipInstaller,
      new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `falta ${required}`
    );
  }

  assert.match(builder, /managed_python_command\(python\)/);
  assert.match(builder, /\.args\(\["-m",\s*"pip",\s*"install",\s*"--quiet"\]\)/);
  assert.match(builder, /\.args\(packages\)/);
  assert.match(builder, /\.env\("PATH",\s*managed_path\)/);
  assert.match(managedPath, /portable_python_prefix\(\)/);
  assert.match(managedPath, /std::env::join_paths/);

  const forbidden = /var_os\("PATH"\)|std::env::var\("PATH"\)|split_paths|base_path|path_entries|patched_path|Command::new\("pip(?:3)?"\)|Command::new\("python(?:3)?"\)|Command::new\("cmd"\)|powershell|sh\s*-c|bash\s*-c|zsh\s*-c|\bwhich\b|where\.exe/;
  assert.doesNotMatch(pipInstaller, forbidden);
  assert.doesNotMatch(builder, forbidden);
  assert.doesNotMatch(builder, /packages\.join|format!\([^)]*packages/);
  assert.doesNotMatch(managedPath, /split_paths|HOME|USERPROFILE|var_os\("PATH"\)|std::env::var\("PATH"\)/);
});

test('Python administrado usa modo aislado en validación e instalación pip', async () => {
  const runtimes = await readFile(
    new URL('src-tauri/src/runtimes.rs', root),
    'utf8'
  );

  const validatorStart = runtimes.indexOf('fn validate_python_runtime');
  const validatorEnd = runtimes.indexOf(
    'fn python_version_text_matches_expected',
    validatorStart
  );
  assert.ok(validatorStart >= 0 && validatorEnd > validatorStart);
  const validator = runtimes.slice(validatorStart, validatorEnd);

  const builderStart = runtimes.indexOf('fn build_managed_pip_install_command');
  const builderEnd = runtimes.indexOf(
    '// ==================== NPM PACKAGES ====================',
    builderStart
  );
  assert.ok(builderStart >= 0 && builderEnd > builderStart);
  const builder = runtimes.slice(builderStart, builderEnd);

  assert.match(validator, /managed_python_command\(&python_exe\)/);
  assert.match(validator, /\.arg\("--version"\)/);
  assert.match(validator, /\.args\(\["-m",\s*"pip",\s*"--version"\]\)/);
  assert.doesNotMatch(validator, /Command::new\(&python_exe\)/);
  assert.doesNotMatch(validator, /"-I"/);

  assert.match(builder, /managed_python_command\(python\)/);
  assert.match(builder, /\.args\(\["-m",\s*"pip",\s*"install",\s*"--quiet"\]\)/);
  assert.match(builder, /\.args\(packages\)/);
  assert.match(builder, /\.env\("PATH",\s*managed_path\)/);
  assert.doesNotMatch(builder, /Command::new\(python\)/);
  assert.doesNotMatch(builder, /"-I"/);

  assert.doesNotMatch(runtimes.slice(validatorStart, validatorEnd), /env_clear|set_var|remove_var/);
});

test('Mermaid CLI se detecta únicamente desde el Node portable administrado', async () => {
  const [runtimes, course] =
    await Promise.all([
      readFile(
        new URL(
          'src-tauri/src/runtimes.rs',
          root
        ),
        'utf8'
      ),
      readFile(
        new URL(
          'src-tauri/src/course.rs',
          root
        ),
        'utf8'
      ),
    ]);

  const resolverStart =
    runtimes.indexOf(
      'pub fn resolve_node_cli'
    );

  const resolverEnd =
    runtimes.indexOf(
      'pub fn node_cli_version',
      resolverStart
    );

  assert.ok(
    resolverStart >= 0,
    'resolve_node_cli debe existir'
  );

  assert.ok(
    resolverEnd > resolverStart,
    'debe poder aislarse resolve_node_cli'
  );

  const resolver = runtimes.slice(
    resolverStart,
    resolverEnd
  );

  assert.match(
    resolver,
    /portable_node_bin_dir/
  );

  assert.doesNotMatch(
    resolver,
    /where\.exe|which/
  );

  assert.doesNotMatch(
    resolver,
    /Command::new\(checker\)/
  );

  const versionStart = runtimes.indexOf(
    'pub fn node_cli_version('
  );
  const versionEnd = runtimes.indexOf(
    'fn managed_node_runtime_path',
    versionStart
  );
  assert.ok(
    versionStart >= 0 && versionEnd > versionStart,
    'debe poder aislarse node_cli_version'
  );
  const versionFn = runtimes.slice(versionStart, versionEnd);
  const builderStart = runtimes.indexOf(
    'fn build_managed_node_cli_version_command'
  );
  const builderEnd = runtimes.indexOf(
    'fn build_managed_npm_install_command',
    builderStart
  );
  assert.ok(builderStart >= 0 && builderEnd > builderStart);
  const builder = runtimes.slice(builderStart, builderEnd);

  assert.match(
    versionFn,
    /managed_node_runtime_path\(\)/
  );
  assert.match(
    versionFn,
    /build_managed_node_cli_version_command/
  );
  assert.doesNotMatch(
    versionFn,
    /var_os\("PATH"\)|split_paths|base_path|path_entries|patched_path|which|where\.exe|global_node_available|Command::new\("node"\)|Command::new\("mmdc"\)/
  );
  assert.match(
    builder,
    /\.env\("PATH",\s*managed_path\)/
  );
  assert.doesNotMatch(
    builder,
    /var_os\("PATH"\)|split_paths|base_path|path_entries|patched_path|sh.*-c|bash.*-c|powershell/
  );

  assert.match(
    course,
    /resolve_node_cli\("mmdc"\)/
  );

  assert.match(
    course,
    /node_cli_version\(\s*"mmdc",\s*&\["--version"\]/
  );

  assert.doesNotMatch(
    course,
    /\(\s*"Mermaid CLI",\s*"mmdc",/
  );

  const mermaidStart =
    course.indexOf(
      'name: "Mermaid CLI".to_string()'
    );

  assert.ok(
    mermaidStart >= 0,
    'Mermaid CLI debe tener un DependencyStatus específico'
  );

  const mermaidBlock =
    course.slice(
      mermaidStart,
      mermaidStart + 1200
    );

  assert.match(
    mermaidBlock,
    /required:\s*false/
  );
});

test('Node portable nunca se activa sin checksum SHA-256 verificado', async () => {
  const runtimes = await readFile(
    new URL('src-tauri/src/runtimes.rs', root),
    'utf8'
  );

  const downloadStart = runtimes.indexOf(
    'pub fn download_portable_node('
  );
  const downloadEnd = runtimes.indexOf(
    '// ==================== PYTHON RUNTIME ====================',
    downloadStart
  );
  assert.ok(
    downloadStart >= 0 && downloadEnd > downloadStart,
    'debe poder aislarse download_portable_node'
  );
  const downloader = runtimes.slice(downloadStart, downloadEnd);

  for (const required of [
    'fetch_node_checksum()',
    'verify_sha256',
    'extract_zip',
    'extract_node_tar_gz',
  ]) {
    assert.match(
      downloader,
      new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `falta ${required}`
    );
  }

  assert.ok(
    downloader.indexOf('fetch_node_checksum()') <
      downloader.indexOf('verify_sha256'),
    'el checksum debe obtenerse antes de verificarlo'
  );
  assert.ok(
    downloader.indexOf('verify_sha256') <
      downloader.indexOf('extract_zip'),
    'la verificación debe ocurrir antes de extraer'
  );
  assert.doesNotMatch(
    downloader,
    /remove_dir_all\(&node_dir\)/,
    'el runtime anterior no debe eliminarse directamente'
  );

  assert.doesNotMatch(
    downloader,
    /fetch_node_checksum\(\)\.unwrap_or_default\(\)|if\s*!expected_checksum\.is_empty\(\)|unwrap_or_default\(\)/
  );

  const parserStart = runtimes.indexOf(
    'fn node_checksum_from_manifest'
  );
  const fetchStart = runtimes.indexOf(
    'fn fetch_node_checksum()'
  );
  const skillRuntimeStart = runtimes.indexOf(
    '// ==================== SKILL RUNTIME ===================='
  );
  assert.ok(
    parserStart >= 0 && fetchStart > parserStart,
    'debe existir un parser puro de checksum'
  );
  assert.ok(
    skillRuntimeStart > fetchStart,
    'debe poder aislarse fetch_node_checksum'
  );

  const parser = runtimes.slice(parserStart, fetchStart);
  const fetcher = runtimes.slice(fetchStart, skillRuntimeStart);
  assert.match(parser, /is_ascii_hexdigit/);
  assert.match(parser, /Checksum duplicado/);
  assert.match(parser, /Checksum no encontrado/);
  assert.match(fetcher, /node_checksum_from_manifest/);
  assert.match(fetcher, /error_for_status\(\)/);
});

test('Node portable valida staging y restaura el runtime anterior si falla la activación', async () => {
  const runtimes = await readFile(
    new URL('src-tauri/src/runtimes.rs', root),
    'utf8'
  );

  const downloadStart = runtimes.indexOf(
    'pub fn download_portable_node('
  );
  const downloadEnd = runtimes.indexOf(
    '// ==================== PYTHON RUNTIME ====================',
    downloadStart
  );
  assert.ok(downloadStart >= 0 && downloadEnd > downloadStart);
  const downloader = runtimes.slice(downloadStart, downloadEnd);

  for (const required of [
    'stage_dir',
    'extract_zip',
    'extract_node_tar_gz',
    'staged_node',
    'validate_node_runtime',
    'activate_staged_node_runtime',
  ]) {
    assert.match(
      downloader,
      new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `falta ${required}`
    );
  }

  assert.match(downloader, /extract_zip\(\s*&tmp_file,\s*&stage_dir\s*\)/);
  assert.match(downloader, /extract_node_tar_gz\(\s*&tmp_file,\s*&stage_dir\s*\)/);
  assert.doesNotMatch(
    downloader,
    /extract_(?:zip|tar)\(\s*&tmp_file,\s*&runtimes_dir\s*\)/
  );
  assert.doesNotMatch(downloader, /remove_dir_all\(&node_dir\)/);

  assert.ok(downloader.indexOf('verify_sha256') < downloader.indexOf('extract_'));
  assert.ok(downloader.indexOf('extract_') < downloader.indexOf('validate_node_runtime'));
  assert.ok(
    downloader.indexOf('validate_node_runtime') <
      downloader.indexOf('activate_staged_node_runtime')
  );

  const validatorStart = runtimes.indexOf('fn validate_node_runtime');
  const activationStart = runtimes.indexOf(
    'fn activate_staged_node_runtime',
    validatorStart
  );
  const extractionStart = runtimes.indexOf(
    'fn extract_zip',
    activationStart
  );
  assert.ok(validatorStart >= 0 && activationStart > validatorStart);
  assert.ok(extractionStart > activationStart);

  const validator = runtimes.slice(validatorStart, activationStart);
  const activation = runtimes.slice(activationStart, extractionStart);
  assert.match(validator, /node_exe/);
  assert.match(validator, /build_staged_node_version_command\(&node_exe\)/);
  assert.match(validator, /node_version_text_matches_expected/);
  assert.match(runtimes, /const NODE_VERSION:\s*&str\s*=\s*"22\.13\.0"/);
  assert.doesNotMatch(
    validator,
    /portable_node_exe\(\)|Command::new\("node"\)|which|where\.exe|global_node_available/
  );
  assert.match(activation, /rename\(node_dir,\s*backup_dir\)/);
  assert.match(activation, /rename\(staged_node,\s*node_dir\)/);
  assert.match(activation, /rename\(backup_dir,\s*node_dir\)/);
  assert.doesNotMatch(
    activation,
    /extract_|reqwest|verify_sha256|Command::new/
  );
});

test('Node portable valida el staging sin heredar NODE_OPTIONS del host', async () => {
  const runtimes = await readFile(
    new URL('src-tauri/src/runtimes.rs', root),
    'utf8'
  );

  const builderStart = runtimes.indexOf('fn build_staged_node_version_command');
  const validatorStart = runtimes.indexOf('fn validate_node_runtime', builderStart);
  const activationStart = runtimes.indexOf('fn activate_staged_node_runtime', validatorStart);
  assert.ok(builderStart >= 0 && validatorStart > builderStart && activationStart > validatorStart);
  const builder = runtimes.slice(builderStart, validatorStart);
  const validator = runtimes.slice(validatorStart, activationStart);

  assert.match(builder, /managed_node_command\(node\)/);
  assert.match(builder, /"--version"/);
  assert.doesNotMatch(builder, /\.output\(|\.spawn\(|\.status\(|env_clear|current_dir|std::env::var(?:_os)?\(\s*"NODE_OPTIONS"|std::env::(?:set_var|remove_var)|\.env\(\s*"NODE_OPTIONS"|NODE_PATH|split_paths|Command::new\("(?:node|npm|npx|sh|bash|powershell|cmd)"\)/);

  assert.match(validator, /node_exe\.is_file\(\)/);
  assert.match(validator, /build_staged_node_version_command\(&node_exe\)/);
  assert.match(validator, /\.output\(\)/);
  assert.match(validator, /output\.status\.success\(\)/);
  assert.match(validator, /node_version_text_matches_expected/);
  assert.doesNotMatch(validator, /Command::new\(&node_exe\)/);
  assert.ok(validator.indexOf('node_exe.is_file()') < validator.indexOf('build_staged_node_version_command'));
  assert.ok(validator.indexOf('build_staged_node_version_command') < validator.indexOf('.output()'));
  assert.ok(validator.indexOf('.output()') < validator.indexOf('output.status.success()'));
  assert.ok(validator.indexOf('output.status.success()') < validator.indexOf('node_version_text_matches_expected'));
});

test('Node portable informa su versión sin heredar NODE_OPTIONS del host', async () => {
  const runtimes = await readFile(
    new URL('src-tauri/src/runtimes.rs', root),
    'utf8'
  );

  const builderStart = runtimes.indexOf('fn build_portable_node_version_command');
  const versionerStart = runtimes.indexOf('pub fn node_version', builderStart);
  const downloaderStart = runtimes.indexOf('pub fn download_portable_node', versionerStart);
  assert.ok(builderStart >= 0 && versionerStart > builderStart && downloaderStart > versionerStart);
  const builder = runtimes.slice(builderStart, versionerStart);
  const versioner = runtimes.slice(versionerStart, downloaderStart);

  // builder — positivos
  assert.match(builder, /managed_node_command\(node\)/);
  assert.match(builder, /"--version"/);

  // builder — negativos
  assert.doesNotMatch(builder, /\.output\(|\.spawn\(|\.status\(|env_clear|current_dir|std::env::var(?:_os)?\(\s*"NODE_OPTIONS"|std::env::(?:set_var|remove_var)|\.env\(\s*"NODE_OPTIONS"|NODE_PATH|split_paths|Command::new\("(?:node|npm|npx|sh|bash|powershell|cmd)"\)/);

  // versioner — positivos
  assert.match(versioner, /resolve_node\(\)/);
  assert.match(versioner, /build_portable_node_version_command/);
  assert.match(versioner, /\.output\(\)/);
  assert.match(versioner, /\.ok\(\)/);
  assert.match(versioner, /output\.status\.success\(\)/);
  assert.match(versioner, /output\.stdout\.is_empty\(\)/);
  assert.match(versioner, /output\.stderr/);
  assert.match(versioner, /String::from_utf8\(raw\)/);
  assert.match(versioner, /\.trim\(\)/);

  // versioner — negativo: no Command directo
  assert.doesNotMatch(versioner, /Command::new\(&node_bin\)/);

  // orden en versioner
  assert.ok(versioner.indexOf('resolve_node()') < versioner.indexOf('build_portable_node_version_command'));
  assert.ok(versioner.indexOf('build_portable_node_version_command') < versioner.indexOf('.output()'));
  assert.ok(versioner.indexOf('.output()') < versioner.indexOf('output.status.success()'));
  assert.ok(versioner.indexOf('output.status.success()') < versioner.indexOf('String::from_utf8'));

  // resolve_node usa portable_node_exe y is_file — sin fallback global
  const resolverStart = runtimes.indexOf('pub fn resolve_node()');
  const resolverEnd = runtimes.indexOf('\npub fn portable_node_installed', resolverStart);
  assert.ok(resolverStart >= 0 && resolverEnd > resolverStart);
  const resolver = runtimes.slice(resolverStart, resolverEnd);
  assert.match(resolver, /paths::portable_node_exe\(\)/);
  assert.match(resolver, /\.is_file\(\)/);
  assert.doesNotMatch(resolver, /Command::new\("node"\)|which|where\.exe|nvm|fnm|volta|homebrew|scoop|chocolatey/i);
});

test('Node portable extrae tar.gz sin depender del tar anfitrión', async () => {
  const runtimes = await readFile(
    new URL('src-tauri/src/runtimes.rs', root),
    'utf8'
  );

  const extractorStart = runtimes.indexOf('fn extract_node_tar_gz');
  const extractorEnd = runtimes.indexOf('fn emit_progress', extractorStart);
  assert.ok(
    extractorStart >= 0 && extractorEnd > extractorStart,
    'debe poder aislarse el extractor tar.gz nativo'
  );
  const extractor = runtimes.slice(extractorStart, extractorEnd);

  assert.match(extractor, /GzDecoder/);
  assert.match(extractor, /tar::Archive/);
  assert.match(extractor, /entries\(\)/);
  assert.match(extractor, /unpack_in\(dest_dir\)/);
  assert.match(extractor, /node-v/);
  assert.match(extractor, /fs::rename/);
  assert.doesNotMatch(
    extractor,
    /Command::new\(["'](?:\/usr\/bin\/)?tar["']\)|Command::new\(["']gtar["']\)|Command::new\(["']bsdtar["']\)|sh\s*-c|bash\s*-c|zsh\s*-c|\bwhich\b|where\.exe/
  );

  const downloaderStart = runtimes.indexOf(
    'pub fn download_portable_node('
  );
  const downloaderEnd = runtimes.indexOf(
    '// ==================== PYTHON RUNTIME ====================',
    downloaderStart
  );
  const downloader = runtimes.slice(downloaderStart, downloaderEnd);
  assert.match(
    downloader,
    /extract_node_tar_gz\(\s*&tmp_file,\s*&stage_dir\s*\)/
  );
  assert.doesNotMatch(downloader, /Command::new\(["']tar["']\)/);

  const urlStart = runtimes.indexOf('fn node_download_url');
  const urlEnd = runtimes.indexOf('fn global_node_available', urlStart);
  const url = runtimes.slice(urlStart, urlEnd);
  assert.match(url, /node-v22\.13\.0-linux-x64\.tar\.gz/);
  assert.doesNotMatch(url, /node-v22\.13\.0-linux-x64\.tar\.xz/);
});

test('Python portable restaura explícitamente el runtime anterior si falla la activación', async () => {
  const runtimes = await readFile(
    new URL('src-tauri/src/runtimes.rs', root),
    'utf8'
  );

  const activationStart = runtimes.indexOf(
    'fn activate_staged_python_runtime'
  );
  const activationEnd = runtimes.indexOf(
    'fn global_python_command',
    activationStart
  );
  assert.ok(
    activationStart >= 0 && activationEnd > activationStart,
    'debe existir un helper único de activación Python'
  );
  const activation = runtimes.slice(activationStart, activationEnd);

  for (const required of [
    'python_dir.exists()',
    'fs::rename(python_dir, backup_dir)',
    'fs::rename(staged_python, python_dir)',
    'fs::rename(backup_dir, python_dir)',
    'restore_error',
    'Error activando Python',
    'no se pudo restaurar el runtime anterior',
  ]) {
    assert.match(
      activation,
      new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `falta ${required}`
    );
  }

  assert.doesNotMatch(
    activation,
    /let\s+_\s*=\s*fs::rename\(backup_dir,\s*python_dir\)/
  );
  assert.doesNotMatch(activation, /remove_dir_all\(python_dir\)/);
  assert.doesNotMatch(activation, /reqwest|verify_sha256|extract_|Command::new|workspace/);

  const downloadStart = runtimes.indexOf(
    'pub fn download_portable_python('
  );
  const downloadEnd = runtimes.indexOf(
    'fn emit_python_progress',
    downloadStart
  );
  assert.ok(downloadStart >= 0 && downloadEnd > downloadStart);
  const downloader = runtimes.slice(downloadStart, downloadEnd);
  assert.match(downloader, /validate_python_runtime\(&staged_python\)/);
  assert.match(downloader, /activate_staged_python_runtime\(/);
  assert.doesNotMatch(
    downloader,
    /match\s+fs::rename\(\s*&staged_python,\s*&python_dir\s*\)/
  );
});

test('NotebookLM MCP restaura explícitamente el runtime anterior si falla la activación', async () => {
  const runtimes = await readFile(
    new URL('src-tauri/src/runtimes.rs', root),
    'utf8'
  );

  const helperStart = runtimes.indexOf('fn activate_staged_notebooklm_mcp');
  const helperEnd = runtimes.indexOf('\npub fn portable_notebooklm_mcp_installed_for', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = runtimes.slice(helperStart, helperEnd);

  assert.match(helper, /active\.exists\(\)/);
  assert.match(helper, /fs::rename\(active, backup\)/);
  assert.match(helper, /fs::rename\(stage, active\)/);
  assert.match(helper, /validate_active\(active\)/);
  assert.match(helper, /fs::remove_dir_all\(active\)/);
  assert.match(helper, /fs::rename\(backup, active\)/);
  assert.match(helper, /restore_error/);
  assert.match(helper, /Error activando NotebookLM MCP/);
  assert.match(helper, /no se pudo restaurar el runtime anterior/);

  assert.doesNotMatch(helper, /let _\s*=\s*fs::rename\(backup, active\)/s);
  assert.doesNotMatch(helper, /let _\s*=\s*fs::remove_dir_all\(active\)/s);

  const installerStart = runtimes.indexOf('pub fn install_notebooklm_mcp');
  const installerEnd = runtimes.indexOf('\n#[cfg(test)]', installerStart);
  assert.ok(installerStart >= 0 && installerEnd > installerStart);
  const installer = runtimes.slice(installerStart, installerEnd);
  assert.match(installer, /activate_staged_notebooklm_mcp/);
  assert.match(installer, /validate_notebooklm_browser/);
  assert.match(installer, /"status"/);
  assert.doesNotMatch(installer, /fs::rename\(\s*&backup,\s*&active/s);
  assert.doesNotMatch(installer, /fs::rename\(\s*&stage,\s*&active/s);
});

test('NotebookLM MCP construye su staging npm sólo con Node y PATH administrados', async () => {
  const runtimes = await readFile(
    new URL('src-tauri/src/runtimes.rs', root),
    'utf8'
  );

  const builderStart = runtimes.indexOf('fn build_managed_notebooklm_npm_command');
  const builderEnd = runtimes.indexOf('\npub fn portable_notebooklm_mcp_installed_for', builderStart);
  assert.ok(builderStart >= 0 && builderEnd > builderStart);
  const builder = runtimes.slice(builderStart, builderEnd);

  assert.match(builder, /managed_node_command\(node\)/);
  assert.match(builder, /\.arg\(npm_cli\)/);
  assert.match(builder, /\.args\(args\)/);
  assert.match(builder, /\.current_dir\(stage\)/);
  assert.match(builder, /\.env\("PATH", managed_path\)/);
  assert.doesNotMatch(
    builder,
    /var_os\("PATH"\)|std::env::var\("PATH"\)|split_paths|Command::new\("(?:node|npm|npm\.cmd|npx)"\)|env_clear|cmd|powershell|sh\s+-c|bash\s+-c/
  );

  const installerStart = runtimes.indexOf('pub fn install_notebooklm_mcp');
  const installerEnd = runtimes.indexOf('\n#[cfg(test)]', installerStart);
  assert.ok(installerStart >= 0 && installerEnd > installerStart);
  const installer = runtimes.slice(installerStart, installerEnd);

  for (const required of [
    'portable_node_exe()',
    'portable_npm_cli()',
    'managed_node_runtime_path()?',
    'build_managed_notebooklm_npm_command',
    '--package-lock-only',
    'contract.npm_integrity',
    '"ci"',
    'activate_staged_notebooklm_mcp',
  ]) {
    assert.match(installer, new RegExp(required.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')));
  }

  assert.ok(installer.indexOf('managed_node_runtime_path()?') < installer.indexOf('build_managed_notebooklm_npm_command'));
  assert.ok(installer.indexOf('--package-lock-only') < installer.indexOf('contract.npm_integrity'));
  assert.ok(installer.indexOf('contract.npm_integrity') < installer.indexOf('"ci"'));
  assert.ok(installer.indexOf('"ci"') < installer.indexOf('activate_staged_notebooklm_mcp'));
  assert.doesNotMatch(installer, /Command::new\(&node\)\s*\.arg\(&npm\)/s);
  assert.doesNotMatch(installer, /var_os\("PATH"\)|std::env::var\("PATH"\)|split_paths|Command::new\("(?:node|npm|npm\.cmd|npx)"\)|env_clear|powershell|sh\s+-c|bash\s+-c/);
});

test('NotebookLM MCP staging npm no hereda NODE_OPTIONS del host', async () => {
  const runtimes = await readFile(
    new URL('src-tauri/src/runtimes.rs', root),
    'utf8'
  );

  const builderStart = runtimes.indexOf('fn build_managed_notebooklm_npm_command');
  const activateStart = runtimes.indexOf('\nfn activate_staged_notebooklm_mcp', builderStart);
  assert.ok(builderStart >= 0 && activateStart > builderStart);
  const builder = runtimes.slice(builderStart, activateStart);

  const installerStart = runtimes.indexOf('pub fn install_notebooklm_mcp');
  const installerEnd = runtimes.indexOf('\n#[cfg(test)]', installerStart);
  assert.ok(installerStart >= 0 && installerEnd > installerStart);
  const installer = runtimes.slice(installerStart, installerEnd);

  assert.match(builder, /managed_node_command\(node\)/);
  assert.match(builder, /\.arg\(npm_cli\)/);
  assert.match(builder, /\.args\(args\)/);
  assert.match(builder, /\.current_dir\(stage\)/);
  assert.match(builder, /\.env\("PATH", managed_path\)/);
  assert.doesNotMatch(builder, /env_clear|std::env::var(?:_os)?\(\s*"NODE_OPTIONS"|std::env::(?:set_var|remove_var)|\.env\(\s*"NODE_OPTIONS"|NODE_PATH|var_os\("PATH"\)|std::env::var\("PATH"\)|split_paths|Command::new\("(?:node|npm|npm\.cmd|npx)"\)|which|where\.exe|powershell|sh\s+-c|bash\s+-c/);

  assert.doesNotMatch(installer, /env_remove\("NODE_OPTIONS"\)/);
});

test('NotebookLM MCP ejecuta browser install y status sólo con Node y PATH administrados', async () => {
  const runtimes = await readFile(
    new URL('src-tauri/src/runtimes.rs', root),
    'utf8'
  );

  const builderStart = runtimes.indexOf('fn build_managed_notebooklm_browser_command');
  const runnerStart = runtimes.indexOf('fn run_notebooklm_browser_command');
  const validatorStart = runtimes.indexOf('fn validate_notebooklm_browser');
  assert.ok(builderStart >= 0 && runnerStart > builderStart && validatorStart > runnerStart);
  const builder = runtimes.slice(builderStart, runnerStart);
  const runner = runtimes.slice(runnerStart, validatorStart);
  const validator = runtimes.slice(validatorStart, runtimes.indexOf('\npub fn portable_notebooklm_mcp_installed_for', validatorStart));

  assert.match(builder, /managed_node_command\(node\)/);
  assert.match(builder, /\.arg\(bin\)/);
  assert.match(builder, /"browser"/);
  assert.match(builder, /action/);
  assert.match(builder, /"--json"/);
  assert.match(builder, /\.env\("PATH", managed_path\)/);
  assert.doesNotMatch(builder, /var_os\("PATH"\)|std::env::var\("PATH"\)|split_paths|env_clear|Command::new\("(?:node|npm|npx)"\)|current_dir|which|where\.exe|powershell|sh\s+-c|bash\s+-c/);

  assert.match(runner, /managed_node_runtime_path\(\)\?/);
  assert.match(runner, /build_managed_notebooklm_browser_command/);
  assert.match(runner, /\.output\(\)/);
  assert.match(runner, /output\.status\.success\(\)/);
  assert.match(runner, /String::from_utf8_lossy\(&output\.stderr\)/);
  assert.match(runner, /serde_json::from_slice\(&output\.stdout\)/);
  assert.doesNotMatch(runner, /Command::new\(node\)/);
  assert.doesNotMatch(runner, /var_os\("PATH"\)|std::env::var\("PATH"\)|split_paths|env_clear|PATH.*fallback/);

  assert.match(validator, /resolve_notebooklm_mcp_bin_for/);
  assert.match(validator, /run_notebooklm_browser_command/);
  assert.match(validator, /validate_browser_status/);
  assert.ok(validator.indexOf('resolve_notebooklm_mcp_bin_for') < validator.indexOf('run_notebooklm_browser_command'));
  assert.ok(validator.indexOf('run_notebooklm_browser_command') < validator.indexOf('validate_browser_status'));
});

test('NotebookLM MCP browser install y status no heredan NODE_OPTIONS del host', async () => {
  const runtimes = await readFile(
    new URL('src-tauri/src/runtimes.rs', root),
    'utf8'
  );
  const builderStart = runtimes.indexOf('fn build_managed_notebooklm_browser_command');
  const runnerStart = runtimes.indexOf('fn run_notebooklm_browser_command', builderStart);
  const validatorStart = runtimes.indexOf('fn validate_notebooklm_browser', runnerStart);
  assert.ok(builderStart >= 0 && runnerStart > builderStart && validatorStart > runnerStart);
  const builder = runtimes.slice(builderStart, runnerStart);
  const runner = runtimes.slice(runnerStart, validatorStart);
  const validatorEnd = runtimes.indexOf('\npub fn portable_notebooklm_mcp_installed_for', validatorStart);
  assert.ok(validatorEnd > validatorStart);
  const validator = runtimes.slice(validatorStart, validatorEnd);

  assert.match(builder, /managed_node_command\(node\)/);
  assert.match(builder, /\.arg\(bin\)/);
  assert.match(builder, /"browser"/);
  assert.match(builder, /action/);
  assert.match(builder, /"--json"/);
  assert.match(builder, /\.env\("PATH", managed_path\)/);
  assert.doesNotMatch(builder, /env_clear|std::env::var(?:_os)?\(\s*"NODE_OPTIONS"|std::env::(?:set_var|remove_var)|\.env\(\s*"NODE_OPTIONS"|NODE_PATH|var_os\("PATH"\)|std::env::var\("PATH"\)|split_paths|Command::new\("(?:node|npm|npx)"\)|current_dir|which|where\.exe|powershell|sh\s+-c|bash\s+-c/);

  assert.match(runner, /managed_node_runtime_path\(\)\?/);
  assert.match(runner, /build_managed_notebooklm_browser_command/);
  assert.match(runner, /\.output\(\)/);
  assert.match(runner, /output\.status\.success\(\)/);
  assert.match(runner, /String::from_utf8_lossy\(&output\.stderr\)/);
  assert.match(runner, /serde_json::from_slice\(&output\.stdout\)/);
  assert.doesNotMatch(runner, /env_remove\("NODE_OPTIONS"\)/);

  assert.match(validator, /resolve_notebooklm_mcp_bin_for/);
  assert.match(validator, /run_notebooklm_browser_command/);
  assert.match(validator, /validate_browser_status/);
  assert.ok(validator.indexOf('resolve_notebooklm_mcp_bin_for') < validator.indexOf('run_notebooklm_browser_command'));
  assert.ok(validator.indexOf('run_notebooklm_browser_command') < validator.indexOf('validate_browser_status'));
});

test('NotebookLM MCP persistente se inicia sólo con Node, bin y PATH administrados', async () => {
  const [mcp, runtimes] = await Promise.all([
    readFile(new URL('src-tauri/src/mcp.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/runtimes.rs', root), 'utf8'),
  ]);

  const pathStart = runtimes.indexOf('pub(crate) fn managed_node_runtime_path');
  const pathEnd = runtimes.indexOf('\nfn build_managed_node_cli_version_command', pathStart);
  assert.ok(pathStart >= 0 && pathEnd > pathStart);
  const managedPath = runtimes.slice(pathStart, pathEnd);
  assert.match(managedPath, /portable_node_bin_dir\(\)/);
  assert.doesNotMatch(managedPath, /var_os\("PATH"\)|std::env::var\("PATH"\)|split_paths|HOME|USERPROFILE/);

  const builderStart = mcp.indexOf('fn build_managed_mcp_server_command');
  const spawnStart = mcp.indexOf('fn spawn()', builderStart);
  const testsStart = mcp.indexOf('\n#[cfg(test)]', spawnStart);
  assert.ok(builderStart >= 0 && spawnStart > builderStart && testsStart > spawnStart);
  const builder = mcp.slice(builderStart, spawnStart);
  const spawn = mcp.slice(spawnStart, testsStart);

  assert.match(builder, /crate::runtimes::managed_node_command\(node\)/);
  assert.match(builder, /\.arg\(bin\)/);
  assert.match(builder, /\.env\("PATH", managed_path\)/);
  assert.doesNotMatch(builder, /var_os\("PATH"\)|std::env::var\("PATH"\)|split_paths|env_clear|current_dir|Command::new\("(?:node|npm|npx)"\)|which|where\.exe|powershell|sh\s+-c|bash\s+-c/);

  for (const required of [
    'managed_mcp()?',
    'crate::runtimes::managed_node_runtime_path()?',
    'build_managed_mcp_server_command',
    'Stdio::piped()',
    'Stdio::inherit()',
    '.spawn()',
  ]) {
    assert.match(spawn, new RegExp(required.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')));
  }
  assert.ok(spawn.indexOf('managed_mcp()?') < spawn.indexOf('managed_node_runtime_path()?'));
  assert.ok(spawn.indexOf('managed_node_runtime_path()?') < spawn.indexOf('build_managed_mcp_server_command'));
  assert.doesNotMatch(spawn, /Command::new\(\s*&managed\.node\s*\)/s);
  assert.doesNotMatch(spawn, /var_os\("PATH"\)|std::env::var\("PATH"\)|split_paths|env_clear|Command::new\("(?:node|npm|npx)"\)|powershell|sh\s+-c|bash\s+-c/);

  const retryStart = mcp.indexOf('fn spawn_connection()');
  const retryEnd = mcp.indexOf('\nfn call_tool', retryStart);
  assert.ok(retryStart >= 0 && retryEnd > retryStart);
  const retry = mcp.slice(retryStart, retryEnd);
  assert.match(retry, /McpConnection::spawn\(\)/);
  assert.ok((retry.match(/McpConnection::spawn\(\)/g) ?? []).length >= 2);
});

test('NotebookLM MCP persistente no hereda NODE_OPTIONS del host', async () => {
  const mcp = await readFile(new URL('src-tauri/src/mcp.rs', root), 'utf8');
  const builderStart = mcp.indexOf('fn build_managed_mcp_server_command');
  const builderEnd = mcp.indexOf('\nimpl McpConnection', builderStart);
  assert.ok(builderStart >= 0 && builderEnd > builderStart);
  const builder = mcp.slice(builderStart, builderEnd);

  assert.match(builder, /crate::runtimes::managed_node_command\(node\)/);
  assert.match(builder, /\.arg\(bin\)/);
  assert.match(builder, /\.env\("PATH", managed_path\)/);
  assert.doesNotMatch(builder, /env_clear|std::env::var(?:_os)?\(\s*"NODE_OPTIONS"|std::env::(?:set_var|remove_var)|Command::new\("(?:node|npm|npx)"\)|current_dir|which|where\.exe|powershell|sh\s+-c|bash\s+-c/);

  const spawnStart = mcp.indexOf('fn spawn() -> Result<Self, String>');
  const spawnEnd = mcp.indexOf('\n    fn ', spawnStart + 1);
  assert.ok(spawnStart >= 0 && spawnEnd > spawnStart);
  const spawn = mcp.slice(spawnStart, spawnEnd);
  assert.match(spawn, /managed_mcp\(\)\?/);
  assert.match(spawn, /managed_node_runtime_path\(\)\?/);
  assert.match(spawn, /build_managed_mcp_server_command/);
  assert.match(spawn, /Stdio::piped\(\)/);
  assert.match(spawn, /Stdio::inherit\(\)/);
  assert.match(spawn, /\.spawn\(\)/);
  assert.doesNotMatch(spawn, /env_remove\("NODE_OPTIONS"\)/);
});

test('Las configuraciones externas de NotebookLM MCP persisten el PATH Node administrado', async () => {
  const mcp = await readFile(new URL('src-tauri/src/mcp.rs', root), 'utf8');

  const jsonStart = mcp.indexOf('pub fn configure_mcp');
  const codexStart = mcp.indexOf('pub fn configure_codex_mcp');
  assert.ok(jsonStart >= 0 && codexStart > jsonStart);
  const jsonConfig = mcp.slice(jsonStart, codexStart);
  assert.match(jsonConfig, /managed_mcp/);
  assert.match(jsonConfig, /managed_node_runtime_path/);
  assert.match(jsonConfig, /managed_mcp_server_json/);
  assert.match(jsonConfig, /mcpServers/);
  assert.match(jsonConfig, /notebooklm/);
  assert.doesNotMatch(jsonConfig, /std::env::var(?:_os)?\(\s*"PATH"|split_paths/);

  const matcherStart = mcp.indexOf('fn server_matches_paths');
  const matcherEnd = mcp.indexOf('\npub(crate) fn server_matches_managed_mcp', matcherStart);
  assert.ok(matcherStart >= 0 && matcherEnd > matcherStart);
  const matcher = mcp.slice(matcherStart, matcherEnd);
  assert.match(matcher, /env/);
  assert.match(matcher, /PATH/);
  assert.match(matcher, /managed_path/);
  assert.match(matcher, /args/);

  const managedMatcherStart = mcp.indexOf('pub(crate) fn server_matches_managed_mcp');
  const managedMatcherEnd = mcp.indexOf('\nfn managed_node_version', managedMatcherStart);
  assert.ok(managedMatcherStart >= 0 && managedMatcherEnd > managedMatcherStart);
  const managedMatcher = mcp.slice(managedMatcherStart, managedMatcherEnd);
  assert.match(managedMatcher, /managed_mcp\(\)/);
  assert.match(managedMatcher, /managed_node_runtime_path/);
  assert.match(managedMatcher, /server_matches_paths/);

  const helperStart = mcp.indexOf('fn apply_managed_codex_mcp_server');
  const helperEnd = mcp.indexOf('\npub fn configure_codex_mcp', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = mcp.slice(helperStart, helperEnd);
  assert.match(helper, /DocumentMut/);
  assert.match(helper, /mcp_servers/);
  assert.match(helper, /notebooklm/);
  assert.match(helper, /command/);
  assert.match(helper, /args/);
  assert.match(helper, /env/);
  assert.match(helper, /PATH/);
  assert.match(helper, /is_table/);

  const codexEnd = mcp.indexOf('\nfn receive_json', codexStart);
  assert.ok(codexEnd > codexStart);
  const codexConfig = mcp.slice(codexStart, codexEnd);
  assert.match(codexConfig, /managed_mcp/);
  assert.match(codexConfig, /managed_node_runtime_path/);
  assert.match(codexConfig, /apply_managed_codex_mcp_server/);
  assert.match(codexConfig, /mcp_servers/);
  assert.match(codexConfig, /notebooklm/);
  assert.doesNotMatch(`${helper}\n${codexConfig}`, /env_vars/);
  assert.doesNotMatch(`${helper}\n${codexConfig}`, /std::env::var(?:_os)?\(\s*"PATH"|split_paths/);
});

test('La configuración JSON de NotebookLM MCP preserva campos y entorno ajenos al actualizar su identidad administrada', async () => {
  const mcp = await readFile(new URL('src-tauri/src/mcp.rs', root), 'utf8');

  const helperStart = mcp.indexOf('fn apply_managed_json_mcp_server');
  const helperEnd = mcp.indexOf('\nfn managed_node_runtime_path_text', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = mcp.slice(helperStart, helperEnd);
  assert.match(helper, /as_object/);
  assert.match(helper, /env/);
  assert.match(helper, /command/);
  assert.match(helper, /args/);
  assert.match(helper, /PATH/);
  assert.match(helper, /mcpServers\.notebooklm/);
  assert.match(helper, /mcpServers\.notebooklm\.env/);
  assert.doesNotMatch(helper, /\*server\s*=\s*managed\.clone\(\)|\*server\s*=\s*json!\(/);

  const configureStart = mcp.indexOf('pub fn configure_mcp');
  const configureEnd = mcp.indexOf('\nfn apply_managed_codex_mcp_server', configureStart);
  assert.ok(configureStart >= 0 && configureEnd > configureStart);
  const configure = mcp.slice(configureStart, configureEnd);
  assert.match(configure, /managed_mcp_server_json/);
  assert.match(configure, /apply_managed_json_mcp_server/);
  assert.match(configure, /let previous = root\.clone\(\)/);
  assert.match(configure, /root == previous/);
  assert.match(configure, /backup_file/);
  assert.match(configure, /atomic_write/);
  assert.ok(configure.indexOf('let previous = root.clone()') < configure.indexOf('apply_managed_json_mcp_server'));
  assert.ok(configure.indexOf('apply_managed_json_mcp_server') < configure.indexOf('root == previous'));
  assert.ok(configure.indexOf('root == previous') < configure.indexOf('backup_file'));
  assert.ok(configure.indexOf('backup_file') < configure.indexOf('atomic_write'));
  assert.doesNotMatch(configure, /root\["mcpServers"\]\["notebooklm"\]\s*=\s*managed_mcp_server_json/);
});

test('NotebookLM MCP valida la versión de Node sin heredar NODE_OPTIONS del host', async () => {
  const mcp = await readFile(new URL('src-tauri/src/mcp.rs', root), 'utf8');
  const builderStart = mcp.indexOf('fn build_managed_node_version_command');
  const builderEnd = mcp.indexOf('\nfn managed_node_version', builderStart);
  assert.ok(builderStart >= 0 && builderEnd > builderStart);
  const builder = mcp.slice(builderStart, builderEnd);
  assert.match(builder, /crate::runtimes::managed_node_command\(node\)/);
  assert.match(builder, /"--version"/);
  assert.doesNotMatch(builder, /env_clear|std::env::var(?:_os)?\(\s*"NODE_OPTIONS"|std::env::(?:set_var|remove_var)|Command::new\("(?:node|npm|npx)"\)|shell|current_dir|PATH/);

  const runnerStart = mcp.indexOf('fn managed_node_version');
  const runnerEnd = mcp.indexOf('\nfn parse_node_version', runnerStart);
  assert.ok(runnerStart >= 0 && runnerEnd > runnerStart);
  const runner = mcp.slice(runnerStart, runnerEnd);
  assert.match(runner, /build_managed_node_version_command/);
  assert.match(runner, /\.output\(\)/);
  assert.match(runner, /output\.status\.success\(\)/);
  assert.match(runner, /parse_node_version/);
  assert.match(runner, /stdout/);
  assert.doesNotMatch(runner, /Command::new\(node\)/);
  assert.ok(runner.indexOf('build_managed_node_version_command') < runner.indexOf('.output()'));
  assert.ok(runner.indexOf('.output()') < runner.indexOf('output.status.success()'));
  assert.ok(runner.indexOf('output.status.success()') < runner.indexOf('parse_node_version'));

  const validationStart = mcp.indexOf('fn validate_managed_node');
  const validationEnd = mcp.indexOf('\npub fn configure_mcp', validationStart);
  assert.ok(validationStart >= 0 && validationEnd > validationStart);
  const validation = mcp.slice(validationStart, validationEnd);
  assert.match(validation, /VersionReq::parse/);
  assert.match(validation, /managed_node_version/);
  assert.match(validation, /\.matches\(/);
  assert.ok(validation.indexOf('VersionReq::parse') < validation.indexOf('managed_node_version'));
  assert.ok(validation.indexOf('managed_node_version') < validation.indexOf('.matches('));
});

test('Jintia requiere su Node administrado aunque exista un Node global', async () => {
  const [runtimes, lib, course, onboarding] =
    await Promise.all([
      readFile(
        new URL(
          'src-tauri/src/runtimes.rs',
          root
        ),
        'utf8'
      ),
      readFile(
        new URL(
          'src-tauri/src/lib.rs',
          root
        ),
        'utf8'
      ),
      readFile(
        new URL(
          'src-tauri/src/course.rs',
          root
        ),
        'utf8'
      ),
      readFile(
        new URL(
          'src/onboarding.js',
          root
        ),
        'utf8'
      ),
    ]);

  const resolverStart =
    runtimes.indexOf(
      'pub fn resolve_node()'
    );

  const resolverEnd =
    runtimes.indexOf(
      'pub fn portable_node_installed',
      resolverStart
    );

  assert.ok(
    resolverStart >= 0,
    'resolve_node debe existir'
  );

  assert.ok(
    resolverEnd > resolverStart,
    'debe poder aislarse resolve_node'
  );

  const resolver = runtimes.slice(
    resolverStart,
    resolverEnd
  );

  assert.match(
    runtimes,
    /pub fn global_node_available\(\)/
  );

  assert.match(
    resolver,
    /portable_node_exe\(\)/
  );

  assert.doesNotMatch(
    resolver,
    /where\.exe/
  );

  assert.doesNotMatch(
    resolver,
    /\bwhich\b/
  );

  assert.doesNotMatch(
    resolver,
    /global_node_available\(\)/
  );

  assert.doesNotMatch(
    resolver,
    /Some\("node"\.to_string\(\)\)/
  );

  assert.match(
    lib,
    /"hasGlobal":\s*runtimes::global_node_available\(\)/
  );

  assert.match(
    lib,
    /"hasPortable":\s*runtimes::portable_node_installed\(\)/
  );

  assert.match(
    lib,
    /"resolvedPath":\s*runtimes::resolve_node\(\)/
  );

  assert.match(
    course,
    /let node_version\s*=\s*crate::runtimes::node_version\(\)/
  );

  assert.match(
    onboarding,
    /dep\.required\s*&&\s*!dep\.installed/
  );

  assert.match(
    onboarding,
    /downloadNodeRuntime\(\)/
  );
});

test('cada invoke() en api.js tiene su handler en generate_handler![] de lib.rs', async () => {
  const [api, lib] = await Promise.all([
    readFile(new URL('src/api.js', root), 'utf8'),
    readFile(new URL('src-tauri/src/lib.rs', root), 'utf8'),
  ]);

  // Extrae el bloque generate_handler![ ... ] de lib.rs
  const handlerBlockStart = lib.indexOf('tauri::generate_handler![');
  const handlerBlockEnd = lib.indexOf('])', handlerBlockStart);
  const handlerBlock = lib.slice(handlerBlockStart, handlerBlockEnd);
  const handlers = new Set(
    [...handlerBlock.matchAll(/^\s+(\w+),?\s*$/gm)].map(m => m[1])
  );

  // Extrae los nombres de comandos del primer argumento de cada invoke()
  const invokedCommands = [...api.matchAll(/\binvoke\(\s*"([^"]+)"/g)].map(m => m[1]);

  const missing = invokedCommands.filter(cmd => !handlers.has(cmd));
  assert.deepStrictEqual(
    missing,
    [],
    `invoke() en api.js sin handler en lib.rs: ${missing.join(', ')}`
  );
});

test('Python administrado está disponible en Windows y macOS sin instaladores globales', async () => {
  const [paths, runtimes, cargo] =
    await Promise.all([
      readFile(
        new URL(
          'src-tauri/src/paths.rs',
          root
        ),
        'utf8'
      ),
      readFile(
        new URL(
          'src-tauri/src/runtimes.rs',
          root
        ),
        'utf8'
      ),
      readFile(
        new URL(
          'src-tauri/Cargo.toml',
          root
        ),
        'utf8'
      ),
    ]);

  assert.match(
    paths,
    /pub fn portable_python_prefix\(\)/
  );

  assert.match(
    paths,
    /join\("bin"\)[\s\S]*join\("python3"\)/
  );

  assert.match(
    runtimes,
    /aarch64-apple-darwin/
  );

  assert.match(
    runtimes,
    /x86_64-apple-darwin/
  );

  assert.match(
    runtimes,
    /x86_64-pc-windows-msvc/
  );

  assert.match(
    runtimes,
    /install_only_stripped\.tar\.gz/
  );

  assert.match(
    runtimes,
    /PYTHON_STANDALONE_RELEASE/
  );

  assert.match(
    runtimes,
    /sha256:/
  );

  assert.match(
    runtimes,
    /GzDecoder/
  );

  assert.match(
    runtimes,
    /tar::Archive/
  );

  assert.doesNotMatch(
    runtimes,
    /Python portable solo está disponible en Windows/
  );

  assert.doesNotMatch(
    runtimes,
    /GET_PIP_URL/
  );

  assert.doesNotMatch(
    runtimes,
    /get-pip\.py/
  );

  assert.match(
    cargo,
    /^flate2\s*=/m
  );

  assert.match(
    cargo,
    /^tar\s*=/m
  );
});

test('Python staged exige exactamente la versión administrada antes de activarse', async () => {
  const runtimes = await readFile(
    new URL('src-tauri/src/runtimes.rs', root),
    'utf8'
  );

  const validatorStart = runtimes.indexOf('fn validate_python_runtime');
  const validatorEnd = runtimes.indexOf(
    'fn activate_staged_python_runtime',
    validatorStart
  );
  assert.ok(validatorStart >= 0 && validatorEnd > validatorStart);
  const validator = runtimes.slice(validatorStart, validatorEnd);

  const helperStart = runtimes.indexOf(
    'fn python_version_text_matches_expected'
  );
  const helperEnd = runtimes.indexOf(
    'fn activate_staged_python_runtime',
    helperStart
  );
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = runtimes.slice(helperStart, helperEnd);

  for (const required of [
    'managed_python_command(&python_exe)',
    '"--version"',
    'version_out.status.success()',
    'python_version_text_matches_expected',
    '["-m", "pip", "--version"]',
    'pip_out.status.success()',
  ]) {
    assert.match(
      validator,
      new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `falta ${required}`
    );
  }

  assert.match(helper, /PYTHON_VERSION/);
  assert.match(helper, /format!/);
  assert.match(helper, /\.trim\(\)/);
  assert.match(helper, /==/);
  assert.doesNotMatch(helper, /starts_with|contains|ends_with|Python 3\.13\./);
  assert.doesNotMatch(validator, /starts_with\("Python 3\.13\."\)/);

  assert.ok(
    validator.indexOf('version_out.status.success()') <
      validator.indexOf('python_version_text_matches_expected')
  );
  const pipProbeIndex = validator.indexOf(
    '.args(["-m", "pip", "--version"])'
  );
  assert.ok(pipProbeIndex >= 0);
  assert.ok(
    validator.indexOf('python_version_text_matches_expected') <
      pipProbeIndex
  );
});

test('el runtime Python pagina los assets de la release fija', async () => {
  const runtimes = await readFile(
    new URL(
      'src-tauri/src/runtimes.rs',
      root
    ),
    'utf8'
  );

  const start = runtimes.indexOf(
    'fn resolve_python_asset'
  );

  const end = runtimes.indexOf(
    'fn extract_python_tar_gz',
    start
  );

  assert.ok(
    start >= 0,
    'resolve_python_asset debe existir'
  );

  assert.ok(
    end > start,
    'debe poder aislarse resolve_python_asset'
  );

  const resolver = runtimes.slice(
    start,
    end
  );

  assert.match(
    resolver,
    /assets_url/
  );

  assert.match(
    resolver,
    /per_page=100/
  );

  assert.match(
    resolver,
    /page=\{page\}/
  );

  assert.match(
    resolver,
    /1\.\.=20/
  );

  assert.match(
    resolver,
    /error_for_status/
  );

  assert.doesNotMatch(
    resolver,
    /\["assets"\]\s*\.as_array/
  );

  assert.match(
    runtimes,
    /fn python_asset_from_values/
  );

  assert.match(
    runtimes,
    /strip_prefix\("sha256:"\)/
  );

  assert.match(
    runtimes,
    /is_ascii_hexdigit/
  );
});

test('Jintia requiere su Python administrado aunque exista Python global', async () => {
  const [runtimes, lib, course] =
    await Promise.all([
      readFile(
        new URL(
          'src-tauri/src/runtimes.rs',
          root
        ),
        'utf8'
      ),
      readFile(
        new URL(
          'src-tauri/src/lib.rs',
          root
        ),
        'utf8'
      ),
      readFile(
        new URL(
          'src-tauri/src/course.rs',
          root
        ),
        'utf8'
      ),
    ]);

  const start = runtimes.indexOf(
    'pub fn resolve_python()'
  );

  const end = runtimes.indexOf(
    'pub fn portable_python_installed',
    start
  );

  assert.ok(
    start >= 0,
    'resolve_python debe existir'
  );

  assert.ok(
    end > start,
    'debe poder aislarse resolve_python'
  );

  const resolver = runtimes.slice(start, end);

  assert.match(
    runtimes,
    /fn global_python_command\(\)/
  );

  assert.match(
    runtimes,
    /pub fn global_python_available\(\)/
  );

  assert.match(
    resolver,
    /portable_python_exe\(\)/
  );

  assert.doesNotMatch(
    resolver,
    /global_python_command\(\)/
  );

  assert.doesNotMatch(
    resolver,
    /where\.exe/
  );

  assert.doesNotMatch(
    resolver,
    /\bwhich\b/
  );

  assert.doesNotMatch(
    resolver,
    /"python3"/
  );

  assert.doesNotMatch(
    resolver,
    /"python"/
  );

  assert.match(
    lib,
    /"hasGlobal":\s*runtimes::global_python_available\(\)/
  );

  assert.match(
    lib,
    /"hasPortable":\s*runtimes::portable_python_installed\(\)/
  );

  assert.match(
    lib,
    /"resolvedPath":\s*runtimes::resolve_python\(\)/
  );

  assert.match(
    course,
    /let python_version\s*=\s*crate::runtimes::python_version\(\)/
  );

  assert.match(
    course,
    /installed:\s*python_ready/
  );
});

test('Vivliostyle puede repararse desde su propia dependencia', async () => {
  const [onboarding, api, lib, runtimes] =
    await Promise.all([
      readFile(
        new URL('src/onboarding.js', root),
        'utf8'
      ),
      readFile(
        new URL('src/api.js', root),
        'utf8'
      ),
      readFile(
        new URL('src-tauri/src/lib.rs', root),
        'utf8'
      ),
      readFile(
        new URL('src-tauri/src/runtimes.rs', root),
        'utf8'
      ),
    ]);

  const start = onboarding.indexOf(
    'async function performDependencyInstall'
  );

  const end = onboarding.indexOf(
    'async function installDisciplinePackages',
    start
  );

  assert.ok(
    start >= 0,
    'performDependencyInstall debe existir'
  );

  assert.ok(
    end > start,
    'debe poder aislarse performDependencyInstall'
  );

  const installer = onboarding.slice(start, end);

  assert.match(
    installer,
    /name\s*===\s*"Vivliostyle CLI"/
  );

  assert.match(
    installer,
    /result\s*=\s*await\s+installVivliostyleCli\(\)/
  );

  const vivliostyleIndex =
    installer.indexOf('name === "Vivliostyle CLI"');

  const fallbackIndex =
    installer.lastIndexOf('installDependency(');

  assert.ok(
    vivliostyleIndex >= 0,
    'debe existir rama dedicada para Vivliostyle'
  );

  assert.ok(
    fallbackIndex > vivliostyleIndex,
    'Vivliostyle debe resolverse antes del instalador genérico'
  );

  assert.match(
    api,
    /export async function installVivliostyleCli\(\)/
  );

  assert.match(
    api,
    /invoke\("install_vivliostyle_cli"\)/
  );

  assert.match(
    lib,
    /async fn install_vivliostyle_cli\(\)/
  );

  assert.match(
    lib,
    /runtimes::install_vivliostyle\(\)/
  );

  assert.match(
    runtimes,
    /pub fn install_vivliostyle\(\)/
  );

  assert.match(
    runtimes,
    /portable_node_prefix\(\)/
  );

  assert.match(
    runtimes,
    /portable_vivliostyle_bin\(\)/
  );
});

test('Vivliostyle global no satisface el runtime requerido por Jintia', async () => {
  const [runtimes, course, onboarding, engine] =
    await Promise.all([
      readFile(
        new URL('src-tauri/src/runtimes.rs', root),
        'utf8'
      ),
      readFile(
        new URL('src-tauri/src/course.rs', root),
        'utf8'
      ),
      readFile(
        new URL('src/onboarding.js', root),
        'utf8'
      ),
      readFile(
        new URL('src-tauri/src/engine.rs', root),
        'utf8'
      ),
    ]);

  const start = runtimes.indexOf(
    'pub fn resolve_vivliostyle()'
  );

  const end = runtimes.indexOf(
    'pub fn vivliostyle_version',
    start
  );

  assert.ok(
    start >= 0,
    'resolve_vivliostyle debe existir'
  );

  assert.ok(
    end > start,
    'debe poder aislarse resolve_vivliostyle'
  );

  const resolver = runtimes.slice(start, end);

  assert.match(
    resolver,
    /portable_vivliostyle_bin\(\)/
  );

  assert.doesNotMatch(
    resolver,
    /where\.exe/
  );

  assert.doesNotMatch(
    resolver,
    /\bwhich\b/
  );

  assert.doesNotMatch(
    resolver,
    /\.arg\("vivliostyle"\)/
  );

  assert.match(
    course,
    /name:\s*"Vivliostyle CLI"\.to_string\(\)[\s\S]*installed:\s*vivliostyle_ready/
  );

  assert.match(
    course,
    /name:\s*"Vivliostyle CLI"\.to_string\(\)[\s\S]*required:\s*true/
  );

  assert.match(
    course,
    /name:\s*"Vivliostyle CLI"\.to_string\(\)[\s\S]*installable:\s*true/
  );

  assert.match(
    onboarding,
    /name\s*===\s*"Vivliostyle CLI"[\s\S]*result\s*=\s*await\s+installVivliostyleCli\(\)/
  );

  assert.match(
    engine,
    /portable_node_bin_dir\(\)/
  );

  assert.match(
    engine,
    /\.env\("PATH",\s*managed_path\)/
  );
});

test('Vivliostyle instala npm con el Node portable de Jintia', async () => {
  const runtimes = await readFile(
    new URL('src-tauri/src/runtimes.rs', root),
    'utf8'
  );

  const start = runtimes.indexOf(
    'pub fn install_vivliostyle()'
  );

  const end = runtimes.indexOf(
    'pub fn install_npm_packages',
    start
  );

  assert.ok(
    start >= 0,
    'install_vivliostyle debe existir'
  );

  assert.ok(
    end > start,
    'debe poder aislarse install_vivliostyle'
  );

  const installer = runtimes.slice(start, end);
  const helperStart = runtimes.indexOf('fn managed_node_runtime_path()');
  const helperEnd = runtimes.indexOf('pub fn install_vivliostyle', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const managedPathHelper = runtimes.slice(helperStart, helperEnd);

  assert.match(
    installer,
    /portable_node_exe\(\)/
  );

  assert.match(
    installer,
    /portable_node_prefix\(\)/
  );

  assert.match(
    installer,
    /portable_npm_cli\(\)/
  );

  assert.match(managedPathHelper, /portable_node_bin_dir\(\)/);
  assert.match(managedPathHelper, /std::env::join_paths/);

  assert.match(
    installer,
    /\.env\("PATH",\s*managed_path\)/
  );

  assert.match(
    installer,
    /managed_node_command\(&node\)[\s\S]*\.arg\(&npm_cli\)/
  );

  assert.match(installer, /is_file\(\)/);
  assert.match(installer, /--global/);
  assert.match(installer, /--prefix/);
  assert.doesNotMatch(installer, /npm_exe\(\)|var_os\("PATH"\)|split_paths|base_path/);
  assert.doesNotMatch(installer, /Command::new\("cmd"\)|Command::new\("npm"\)|Command::new\("npx/);

  assert.match(
    installer,
    /@vivliostyle\/cli/
  );
});

test('download_portable_skill instala y prueba Jintia con PATH administrado', async () => {
  const runtimes = await readFile(new URL('src-tauri/src/runtimes.rs', root), 'utf8');
  const helperStart = runtimes.indexOf('fn managed_node_runtime_path()');
  const helperEnd = runtimes.indexOf('pub fn install_vivliostyle', helperStart);
  const installStart = runtimes.indexOf('pub fn download_portable_skill');
  const installEnd = runtimes.indexOf('pub fn visual_install_profiles', installStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.ok(installStart >= 0 && installEnd > installStart);
  const helper = runtimes.slice(helperStart, helperEnd);
  const installer = runtimes.slice(installStart, installEnd);

  assert.match(helper, /portable_node_bin_dir\(\)/);
  assert.match(helper, /join_paths/);
  for (const required of [
    'portable_node_exe()', 'portable_npm_cli()', 'managed_node_runtime_path()',
    'managed_node_command(&node)', '.arg(&npm_cli)', 'install', '--global', '--prefix',
    '@charlie.act7/jintia@latest', '--no-audit', '--no-fund',
    '.env("PATH", &managed_path)', 'portable_skill_npm_package_dir_for',
    'package.json', 'skill/bin/jintia.js', 'capabilities', 'profiles', '--json',
    'managed_mcp_contract_from', 'portable_skill_prefix', '.jintia-backup-',
  ]) {
    assert.match(installer, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `falta ${required}`);
  }
  for (const forbidden of [
    'npm_exe()', 'var_os("PATH")', 'split_paths', 'base_path', 'patched_path',
    'Command::new("cmd")', '.arg("/C")', 'Command::new("node")',
    'Command::new("npm")', 'Command::new("npm.cmd")', 'Command::new("npx")',
    'Command::new("npx.cmd")',
  ]) {
    assert.doesNotMatch(installer, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `sobran ${forbidden}`);
  }
  assert.ok(installer.indexOf('install') < installer.indexOf('capabilities'));
  assert.ok(installer.indexOf('capabilities') < installer.indexOf('managed_mcp_contract_from'));
  assert.ok(installer.indexOf('managed_mcp_contract_from') < installer.indexOf('portable_skill_prefix'));
});

test('Node CLI disciplinares usan exclusivamente el runtime administrado', async () => {
  const [runtimes, course] =
    await Promise.all([
      readFile(
        new URL('src-tauri/src/runtimes.rs', root),
        'utf8'
      ),
      readFile(
        new URL('src-tauri/src/course.rs', root),
        'utf8'
      ),
    ]);

  const resolverStart = runtimes.indexOf(
    'pub fn resolve_node_cli('
  );

  const resolverEnd = runtimes.indexOf(
    'pub fn node_cli_version(',
    resolverStart
  );

  assert.ok(
    resolverStart >= 0,
    'resolve_node_cli debe existir'
  );

  assert.ok(
    resolverEnd > resolverStart,
    'debe poder aislarse resolve_node_cli'
  );

  const resolver = runtimes.slice(resolverStart, resolverEnd);

  assert.match(
    resolver,
    /portable_node_bin_dir\(\)/
  );

  assert.doesNotMatch(
    resolver,
    /where\.exe/
  );

  assert.doesNotMatch(
    resolver,
    /\bwhich\b/
  );

  assert.doesNotMatch(
    resolver,
    /Command::new\(checker\)/
  );

  const versionStart = runtimes.indexOf(
    'pub fn node_cli_version('
  );

  const versionEnd = runtimes.indexOf(
    'pub fn install_vivliostyle',
    versionStart
  );

  assert.ok(versionEnd > versionStart);

  const versioner = runtimes.slice(versionStart, versionEnd);

  assert.match(
    versioner,
    /portable_node_exe\(\)/
  );

  assert.match(versioner, /managed_node_runtime_path\(\)/);
  assert.match(
    versioner,
    /build_managed_node_cli_version_command/
  );
  assert.doesNotMatch(
    versioner,
    /var_os\("PATH"\)|split_paths|base_path|path_entries|patched_path|which|where\.exe|global_node_available|Command::new\("node"\)|Command::new\("mmdc"\)/
  );

  const builderStart = runtimes.indexOf(
    'fn build_managed_node_cli_version_command'
  );
  const builderEnd = runtimes.indexOf(
    'fn build_managed_npm_install_command',
    builderStart
  );
  assert.ok(builderStart >= 0 && builderEnd > builderStart);
  const builder = runtimes.slice(builderStart, builderEnd);
  assert.match(builder, /\.env\("PATH",\s*managed_path\)/);
  assert.doesNotMatch(
    builder,
    /var_os\("PATH"\)|split_paths|base_path|path_entries|patched_path|sh.*-c|bash.*-c|powershell/
  );

  assert.doesNotMatch(
    course,
    /Mermaid CLI disponible en el sistema/
  );

  assert.match(
    course,
    /Usando Mermaid CLI administrado por Jintia/
  );
});

test('el onboarding no avanza si falla la instalación del perfil disciplinar', async () => {
  const source = await readFile(
    new URL('src/onboarding.js', root),
    'utf8'
  );

  const fnStart = source.indexOf(
    'async function installDisciplinePackages()'
  );

  const fnEnd = source.indexOf(
    'async function handleAction(',
    fnStart
  );

  assert.ok(fnStart >= 0, 'installDisciplinePackages debe existir');
  assert.ok(fnEnd > fnStart, 'debe poder aislarse installDisciplinePackages');

  const installer = source.slice(fnStart, fnEnd);

  assert.match(
    installer,
    /const pipResult\s*=\s*await installProfilePackages\(/,
    'pip ActionResult debe guardarse'
  );

  assert.match(
    installer,
    /!pipResult\?\.success/,
    'pip failure debe detectarse'
  );

  assert.match(
    installer,
    /const npmResult\s*=\s*await installNpmPackages\(/,
    'npm ActionResult debe guardarse'
  );

  assert.match(
    installer,
    /!npmResult\?\.success/,
    'npm failure debe detectarse'
  );

  assert.match(
    installer,
    /failedStage:\s*"python"/,
    'failedStage debe distinguir python'
  );

  assert.match(
    installer,
    /failedStage:\s*"node"/,
    'failedStage debe distinguir node'
  );

  const pipFailure = installer.indexOf('!pipResult?.success');
  const npmInstall = installer.indexOf('await installNpmPackages(');

  assert.ok(
    pipFailure >= 0 && npmInstall > pipFailure,
    'el fallo de pip debe aparecer antes de la llamada npm'
  );

  const segment = installer.slice(pipFailure, npmInstall);

  assert.match(
    segment,
    /return\b/,
    'debe haber return entre pip failure y la llamada npm (fail-fast)'
  );
});

test('el onboarding bloquea el avance cuando profileInstall tiene error', async () => {
  const source = await readFile(
    new URL('src/onboarding.js', root),
    'utf8'
  );

  const actionStart = source.indexOf(
    'if (action === "save-profile-and-template")'
  );

  const actionEnd = source.indexOf(
    'if (action === "install-local")',
    actionStart
  );

  assert.ok(actionStart >= 0, 'save-profile-and-template debe existir');
  assert.ok(actionEnd > actionStart, 'debe poder aislarse el bloque');

  const saveProfile = source.slice(actionStart, actionEnd);

  const errorIndex = saveProfile.indexOf('profileInstall?.error');
  const successIndex = saveProfile.indexOf(
    'Perfil ${profileInstall.profileId} preparado para'
  );
  const advanceIndex = saveProfile.indexOf('advance(current)');

  assert.ok(errorIndex >= 0, 'profileInstall?.error debe evaluarse');

  assert.ok(
    successIndex > errorIndex,
    'success toast debe ser posterior al check de error'
  );

  assert.ok(
    advanceIndex > errorIndex,
    'advance debe ser posterior al check de error'
  );

  const errorToAdvance = saveProfile.slice(errorIndex, advanceIndex);

  assert.match(
    errorToAdvance,
    /return;/,
    'el bloque de error debe hacer return sin avanzar'
  );
});

test('Jintia se instala mediante npm administrado, no mediante descarga manual de tarball', async () => {
  const runtimes = await readFile(
    new URL('src-tauri/src/runtimes.rs', root),
    'utf8'
  );

  assert.match(runtimes, /pub fn download_portable_skill/);

  const fnStart = runtimes.indexOf('pub fn download_portable_skill');
  const fnEnd = runtimes.indexOf('\nfn emit_skill_progress', fnStart);
  const fn_ = runtimes.slice(fnStart, fnEnd);

  // Usa npm administrado con prefijo de staging
  assert.match(fn_, /portable_npm_cli\(\)/);
  assert.match(fn_, /--global/);
  assert.match(fn_, /--prefix/);
  assert.match(fn_, /@charlie\.act7\/jintia@latest/);
  assert.match(fn_, /\.jintia-stage-/);

  // Valida artefactos antes de activar
  assert.match(fn_, /SKILL\.md/);
  assert.match(fn_, /skill\/bin\/jintia\.js/);

  // Smoke test capabilities profiles --json
  assert.match(fn_, /capabilities/);
  assert.match(fn_, /profiles/);
  assert.match(fn_, /--json/);

  // Activación atómica
  assert.match(fn_, /\.jintia-backup-/);
  assert.match(fn_, /fs::rename/);

  // Ya no descarga tarball ni verifica SHA1 manualmente
  assert.doesNotMatch(fn_, /registry\.npmjs\.org/);
  assert.doesNotMatch(fn_, /fetch_npm_package_info/);
  assert.doesNotMatch(fn_, /tarball_url/);
  assert.doesNotMatch(fn_, /expected_shasum/);
  assert.doesNotMatch(fn_, /verify_sha1/);
  assert.doesNotMatch(fn_, /extract_skill_tgz/);
  assert.doesNotMatch(fn_, /tar -xzf/);
});

test('resolve_skill usa exclusivamente Jintia portable administrado', async () => {
  const [runtimes, paths] = await Promise.all([
    readFile(new URL('src-tauri/src/runtimes.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/paths.rs', root), 'utf8'),
  ]);

  assert.match(runtimes, /pub fn resolve_skill\(\)/);

  const resolverStart = runtimes.indexOf('pub fn resolve_skill()');
  const resolverEnd = runtimes.indexOf('\npub fn global_skill_available', resolverStart);
  const resolver = runtimes.slice(resolverStart, resolverEnd);

  assert.match(resolver, /portable_skill_bin/);
  assert.doesNotMatch(resolver, /where\.exe/);
  assert.doesNotMatch(resolver, /"which"/);
  // No devuelve la cadena literal "jintia" como fallback global
  assert.doesNotMatch(resolver, /Some\("jintia"\)/);
  const legacyHelper = 'portable_skill_' + 'legacy_source_dir';
  assert.doesNotMatch(paths, new RegExp(legacyHelper));

  // global_skill_available sí puede usar detección, pero es función aparte
  assert.match(runtimes, /pub fn global_skill_available/);
});

test('Engine Adapter exige el archivo jintia.js resuelto por el runtime', async () => {
  const [engine, runtimes] = await Promise.all([
    readFile(new URL('src-tauri/src/engine.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/runtimes.rs', root), 'utf8'),
  ]);

  assert.match(engine, /managed_entrypoint/);
  assert.match(engine, /is_file\(\)/);
  assert.match(engine, /resolve_node/);
  assert.match(engine, /portable_node_bin_dir/);
  assert.match(engine, /managed_node_command\(&node_bin\)/);
  assert.doesNotMatch(engine, /compatibilidad legacy/);
  assert.doesNotMatch(engine, /skill_path\.join\("bin"\)\.join\("jintia\.js"\)/);

  const resolverStart = runtimes.indexOf('pub fn resolve_skill()');
  const resolverEnd = runtimes.indexOf('\npub fn global_skill_available', resolverStart);
  const resolver = runtimes.slice(resolverStart, resolverEnd);
  assert.match(resolver, /portable_skill_bin/);
  assert.match(resolver, /is_file\(\)/);
});

test('la detección de harnesses usa el runtime Jintia administrado', async () => {
  const [harnesses, toolchain, lib, settings] = await Promise.all([
    readFile(new URL('src-tauri/src/harnesses.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/toolchain.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/lib.rs', root), 'utf8'),
    readFile(new URL('src/pages/settings.js', root), 'utf8'),
  ]);
  const detectStart = harnesses.indexOf('pub fn detect(');
  const detectEnd = harnesses.indexOf('\n#[cfg(test)]', detectStart);
  const detect = harnesses.slice(detectStart, detectEnd);
  const manageStart = toolchain.indexOf('pub fn manage_harness(');
  const manageEnd = toolchain.indexOf('\n}', toolchain.indexOf('match engine::run_jintia', manageStart));
  const manage = toolchain.slice(manageStart, manageEnd);

  assert.ok(detectStart >= 0 && detectEnd > detectStart);
  assert.match(detect, /runtimes::resolve_skill/);
  assert.match(detect, /engine::run_jintia_json/);
  assert.match(harnesses, /get\("data"\)/);
  assert.match(harnesses, /get\("providers"\)/);
  assert.match(harnesses, /fn detection_payload/);
  assert.match(detect, /detect/);
  assert.match(detect, /--json/);
  assert.match(detect, /--providers=/);
  assert.doesNotMatch(harnesses, /fallback_detect|default_providers|Command::new/);
  assert.doesNotMatch(harnesses, /"\.claude"|"\.agents"|"\.cursor"|"\.gemini"|"\.grok"|"\.kiro"|"\.opencode"|"\.pi"|"\.qoder"|"\.trae"|"\.rovodev"|"\.vibe"/);
  assert.doesNotMatch(detect, /payload::installed_skill_path|installed_skill_path|skill_dir|legacy_skill_dir/);
  assert.doesNotMatch(harnesses, /use crate::payload;/);
  assert.match(manage, /runtimes::resolve_skill/);
  assert.match(lib, /async fn detect_harnesses[\s\S]*Result<serde_json::Value, String>/);
  assert.match(lib, /detect_harnesses[\s\S]*spawn_blocking[\s\S]*harnesses::detect/);
  assert.match(settings, /result\.providers/);
});

test('las plantillas provienen del runtime Jintia administrado', async () => {
  const config = await readFile(new URL('src-tauri/src/config.rs', root), 'utf8');
  const themeStart = config.indexOf('pub fn theme_exists(');
  const themeEnd = config.indexOf('\npub struct ActiveInstitution', themeStart);
  const themeFn = config.slice(themeStart, themeEnd);
  const listStart = config.indexOf('pub fn list_templates()');
  const listEnd = config.indexOf('\npub fn get_active_template()', listStart);
  const listFn = config.slice(listStart, listEnd);

  assert.match(config, /portable_skill_source_dir/);
  assert.match(config, /themes/);
  assert.match(config, /meta\.json/);
  assert.match(config, /fs::read_dir/);
  assert.match(config, /TemplateMeta/);
  assert.match(config, /theme_exists/);
  assert.doesNotMatch(config, /include_dir|\$OUT_DIR\/jintia-skill\/themes|static THEMES|THEMES\.(get_file|dirs)/);
  assert.match(themeFn, /themes/);
  assert.match(themeFn, /meta\.json/);
  assert.doesNotMatch(themeFn, /THEMES|OUT_DIR/);
  assert.match(listFn, /fs::read_dir/);
  assert.match(listFn, /meta\.json/);
  assert.match(listFn, /TemplateMeta/);
  assert.match(listFn, /theme_exists/);
  assert.match(listFn, /featured/);
  assert.match(listFn, /name/);
  assert.match(listFn, /sort/);
  assert.doesNotMatch(listFn, /jintia-clasico|jintia-cuaderno|jintia-tecnico/);
  assert.match(config, /DEFAULT_THEME:\s*&str\s*=\s*"jintia-clasico"/);
});

test('paths.rs resuelve Jintia exclusivamente desde el layout npm administrado', async () => {
  const paths = await readFile(
    new URL('src-tauri/src/paths.rs', root),
    'utf8'
  );

  assert.match(paths, /pub fn portable_skill_prefix\(\)/);
  assert.match(paths, /pub fn portable_skill_npm_package_dir_for/);
  assert.match(paths, /pub fn portable_skill_npm_source_dir\(\)/);
  assert.match(paths, /pub fn portable_skill_source_dir\(\)/);
  assert.doesNotMatch(paths, new RegExp('portable_skill_' + 'legacy_source_dir'));

  // Conoce las dos rutas de layout npm según plataforma
  assert.match(paths, /"node_modules"/);      // Windows
  assert.match(paths, /"lib"/);               // Unix
  assert.match(paths, /@charlie\.act7/);
  assert.match(paths, /"jintia"/);

  const sourceStart = paths.indexOf('pub fn portable_skill_source_dir()');
  const sourceEnd = paths.indexOf('\npub fn portable_skill_bin()', sourceStart);
  const sourceFn = paths.slice(sourceStart, sourceEnd);
  assert.match(sourceFn, /portable_skill_npm_source_dir/);
  assert.doesNotMatch(sourceFn, /is_file|exists|return npm/);

  // portable_skill_bin delega en portable_skill_source_dir
  const binStart = paths.indexOf('pub fn portable_skill_bin()');
  const binEnd = paths.indexOf('\npub fn migrate_runtimes', binStart);
  const binFn = paths.slice(binStart, binEnd);
  assert.match(binFn, /portable_skill_source_dir/);
  assert.match(binFn, /bin/);
  assert.match(binFn, /jintia\.js/);
  assert.doesNotMatch(binFn, /portable_runtimes_dir\(\)\.join\("jintia"\)/);
});

test('el estado Claude se resuelve mediante el contrato status de Jintia', async () => {
  const [statusToolchain, statusConfig, statusLib] = await Promise.all(['src-tauri/src/toolchain.rs','src-tauri/src/config.rs','src-tauri/src/lib.rs'].map(path => readFile(new URL(path, root), 'utf8')));
  assert.match(statusToolchain, /claude_skill_status[\s\S]*parse_claude_skill_status[\s\S]*resolve_skill[\s\S]*run_jintia/);
  assert.match(statusToolchain, /"status"[\s\S]*"--providers=claude"[\s\S]*"--scope=global"[\s\S]*"--json"/); assert.match(statusConfig, /crate::toolchain::claude_skill_status/); assert.match(statusLib, /claude_skill_status/);
  assert.doesNotMatch(`${statusToolchain}\n${statusConfig}\n${statusLib}`, /payload::installed_skill_path|pub fn installed_skill_path|pub fn skill_is_installed|pub fn installed_skill_version|pub fn portable_skill_version|pub fn skill_is_current/);
  const pathStart = statusLib.indexOf('async fn get_skill_path');
  const pathEnd = statusLib.indexOf('#[tauri::command]', pathStart + 1);
  const pathBody = statusLib.slice(pathStart, pathEnd > pathStart ? pathEnd : statusLib.length);
  assert.ok(pathStart >= 0); assert.match(pathBody, /spawn_blocking/); assert.match(pathBody, /claude_skill_status/);
});
test('la UI consume las fases actuales de instalación npm de Jintia', async () => {
  const settings = await readFile(
    new URL('src/pages/settings.js', root),
    'utf8'
  );

  // Aislar el bloque del listener de skill-download-progress
  const listenerStart = settings.indexOf('"skill-download-progress"');
  assert.ok(listenerStart >= 0, 'debe existir el listener skill-download-progress');
  const listenerEnd = settings.indexOf('});', listenerStart);
  const listenerBlock = settings.slice(listenerStart, listenerEnd);

  // Fases actuales del backend npm
  assert.match(listenerBlock, /phase === "installing"/);
  assert.match(listenerBlock, /phase === "validating"/);
  assert.match(listenerBlock, /phase === "testing"/);
  assert.match(listenerBlock, /phase === "activating"/);

  // Fases antiguas del tarball eliminadas
  assert.doesNotMatch(listenerBlock, /phase === "detecting"/);
  assert.doesNotMatch(listenerBlock, /phase === "downloading"/);
  assert.doesNotMatch(listenerBlock, /phase === "extracting"/);
  assert.doesNotMatch(listenerBlock, /phase === "configuring"/);

  // Aislar el bloque completo del handler de Jintia Skill
  const skillHandlerStart = settings.indexOf('[data-download-skill]');
  const skillHandlerEnd = settings.indexOf('\n    });', skillHandlerStart);
  const skillHandler = settings.slice(skillHandlerStart, skillHandlerEnd);

  // Etiqueta y estado del botón usan "Instalar", no "Descargar"
  assert.match(skillHandler, /Instalar Jintia Skill/);
  assert.match(skillHandler, /Instalando…/);
  assert.doesNotMatch(skillHandler, /Descargar Jintia Skill/);
  assert.doesNotMatch(skillHandler, /Descargando…/);
});

test('los perfiles visuales provienen del runtime npm administrado', async () => {
  const [runtimes, lib] = await Promise.all([
    readFile(new URL('src-tauri/src/runtimes.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/lib.rs', root), 'utf8'),
  ]);

  // El loader existe en runtimes.rs
  assert.match(runtimes, /pub fn visual_install_profiles\(\)/);

  // Aislar el cuerpo del loader
  const loaderStart = runtimes.indexOf('pub fn visual_install_profiles()');
  const loaderEnd = runtimes.indexOf('\npub fn portable_skill_installed', loaderStart) !== -1
    ? runtimes.indexOf('\npub fn portable_skill_installed', loaderStart)
    : runtimes.indexOf('\nfn emit_skill_progress', loaderStart);
  const loader = runtimes.slice(loaderStart, loaderEnd);

  // Lee desde el runtime administrado
  assert.match(loader, /portable_skill_source_dir/);
  assert.match(loader, /config/);
  assert.match(loader, /visual-install-profiles\.json/);

  // Valida contrato
  assert.match(loader, /version/);
  assert.match(loader, /profiles/);
  assert.match(loader, /disciplines/);
  assert.match(loader, /minimum/);
  assert.match(loader, /core/);
  assert.match(loader, /full/);

  // No lee fuentes embebidas
  assert.doesNotMatch(loader, /OUT_DIR/);
  assert.doesNotMatch(loader, /include_str!/);
  assert.doesNotMatch(loader, /skill\.lock\.json/);
  assert.doesNotMatch(loader, /resources/);
  assert.doesNotMatch(loader, /jintia-skill-11/);

  // La command de lib.rs consume el loader de runtimes
  const cmdStart = lib.indexOf('async fn get_visual_install_profiles()');
  const cmdEnd = lib.indexOf('\n#[tauri::command]', cmdStart);
  const cmd = lib.slice(cmdStart, cmdEnd);

  assert.match(cmd, /runtimes::visual_install_profiles/);
  assert.doesNotMatch(cmd, /include_str!/);
  assert.doesNotMatch(cmd, /OUT_DIR/);
  assert.doesNotMatch(cmd, /\/jintia-skill\//);

  // El fallback usa shape version 3 con disciplines y profiles vacíos
  assert.match(cmd, /"version":\s*3/);
  assert.match(cmd, /"disciplines"/);
  assert.match(cmd, /"profiles"/);
});

test('el estado de la Skill requiere el runtime npm administrado', async () => {
  const [runtimePaths, runtimeSources, runtimeToolchain] = await Promise.all(['src-tauri/src/paths.rs','src-tauri/src/runtimes.rs','src-tauri/src/toolchain.rs'].map(path => readFile(new URL(path, root), 'utf8')));
  const resolveStart = runtimeSources.indexOf('pub fn resolve_skill()');
  const resolveEnd = runtimeSources.indexOf('\npub fn download_portable_skill', resolveStart);
  const installStart = runtimeSources.indexOf('pub fn download_portable_skill');
  const installEnd = runtimeSources.indexOf('\npub fn visual_install_profiles', installStart);
  const resolveBlock = runtimeSources.slice(resolveStart, resolveEnd);
  const installBlock = runtimeSources.slice(installStart, installEnd);
  assert.ok(resolveStart >= 0 && resolveEnd > resolveStart && installStart >= 0 && installEnd > installStart);
  assert.match(resolveBlock, /portable_skill_bin/); assert.match(resolveBlock, /is_file/);
  assert.match(installBlock, /portable_node_exe[\s\S]*portable_npm_cli[\s\S]*managed_node_runtime_path[\s\S]*install[\s\S]*--global[\s\S]*--prefix/);
  assert.match(installBlock, /@charlie\.act7\/jintia@latest/); assert.match(installBlock, /portable_skill_npm_package_dir_for/); assert.match(installBlock, /package\.json/); assert.match(installBlock, /@charlie\.act7\/jintia/);
  assert.match(runtimePaths, /@charlie\.act7\/jintia|jintia\.js/); assert.match(runtimeToolchain, /resolve_skill/); assert.match(runtimeToolchain, /run_jintia/);
  assert.doesNotMatch(`${resolveBlock}\n${installBlock}\n${runtimePaths}\n${runtimeToolchain}`, /Command::new\("(?:jintia|npx|npx\.cmd)"\)|legacy_skill_dir|instructional-designer-skill/);
  const authority = `${resolveBlock}\n${installBlock}\n${runtimePaths}\n${runtimeToolchain}`;
  assert.doesNotMatch(authority, /jintia-skill-[^\s"']+\.(?:zip|tar\.gz)|github\.com\/[^\s"']+\/releases\/download|api\.github\.com[^\s"']+jintia|zipball|tarball|download_url/);
});
test('Plan 61A conserva el corte legacy y la extracción hermética de Node', async () => {
  const [activate, runtimes, cargo] = await Promise.all([
    readFile(new URL('src/pages/activate.js', root), 'utf8'),
    readFile(new URL('src-tauri/src/runtimes.rs', root), 'utf8'),
    readFile(new URL('src-tauri/Cargo.toml', root), 'utf8'),
  ]);
  assert.doesNotMatch(activate, /Claude\/Cowork usa el ZIP|exportSkillZip|export_skill_zip|lastSkillZip|claude-cowork/);
  assert.doesNotMatch(activate, /\[\s*"institution",\s*"zip"/);
  assert.match(activate, /institution[\s\S]*skill[\s\S]*mcp-desktop[\s\S]*mcp-code[\s\S]*auth/);
  const start = runtimes.indexOf('fn extract_zip(');
  const end = runtimes.indexOf('\nfn extract_node_tar_gz(', start);
  assert.ok(start >= 0 && end > start);
  const extractZip = runtimes.slice(start, end);
  assert.match(extractZip, /ZipArchive/);
  assert.match(extractZip, /enclosed_name\(\)/);
  assert.doesNotMatch(extractZip, /Command::new\("(?:tar|powershell|7z|unzip)"\)/);
  assert.match(cargo, /\[target\.'cfg\(target_os = "windows"\)'\.dependencies\][\s\S]*^zip\s*=/m);
  await assert.rejects(access(new URL('src-tauri/src/payload.rs', root)), error => error?.code === 'ENOENT');
});

test('Todo subprocess Node administrado de Desktop usa la política central de environment', async () => {
  const [runtimes, engine, mcp] = await Promise.all([
    readFile(new URL('src-tauri/src/runtimes.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/engine.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/mcp.rs', root), 'utf8'),
  ]);

  // helper central existe y es la única autoridad productiva
  const helperStart = runtimes.indexOf('pub(crate) fn managed_node_command(');
  const helperEnd = runtimes.indexOf('\nfn build_portable_node_version_command', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'managed_node_command debe existir');
  const helper = runtimes.slice(helperStart, helperEnd);
  assert.match(helper, /Command::new\(program\)/);
  assert.match(helper, /env_remove\("NODE_OPTIONS"\)/);
  assert.doesNotMatch(helper, /env_clear|\.env\("NODE_OPTIONS"|NODE_PATH|\.args\(|current_dir|\.output\(|\.spawn\(|std::env::(?:set_var|remove_var)|std::env::var/);

  // producción de runtimes: exactamente un env_remove (el del helper)
  const prodRuntimes = runtimes.slice(0, runtimes.indexOf('\n#[cfg(test)]'));
  const prodMatches = [...prodRuntimes.matchAll(/env_remove\("NODE_OPTIONS"\)/g)];
  assert.equal(prodMatches.length, 1, `runtimes.rs debe tener exactamente 1 env_remove productivo, encontrado: ${prodMatches.length}`);

  // producción de engine: cero env_remove
  const engineTestIdx = engine.indexOf('#[cfg(test)]');
  const prodEngine = engineTestIdx >= 0 ? engine.slice(0, engineTestIdx) : engine;
  assert.doesNotMatch(prodEngine, /env_remove\("NODE_OPTIONS"\)/, 'engine.rs no debe tener env_remove productivo');

  // producción de mcp: cero env_remove
  const mcpTestIdx = mcp.indexOf('#[cfg(test)]');
  const prodMcp = mcpTestIdx >= 0 ? mcp.slice(0, mcpTestIdx) : mcp;
  assert.doesNotMatch(prodMcp, /env_remove\("NODE_OPTIONS"\)/, 'mcp.rs no debe tener env_remove productivo');

  // consumers de runtimes usan managed_node_command
  for (const fn of [
    'fn build_portable_node_version_command',
    'fn build_staged_node_version_command',
    'fn build_managed_notebooklm_browser_command',
    'fn build_managed_notebooklm_npm_command',
    'fn build_managed_node_cli_version_command',
    'fn build_managed_npm_install_command',
  ]) {
    const idx = runtimes.indexOf(fn);
    assert.ok(idx >= 0, `${fn} debe existir`);
    // la función llama a managed_node_command antes de la siguiente función pública/privada
    const nextFn = runtimes.indexOf('\nfn ', idx + fn.length);
    const nextPubFn = runtimes.indexOf('\npub fn ', idx + fn.length);
    const fnEnd = Math.min(...[nextFn, nextPubFn].filter(i => i > idx));
    const fnBody = runtimes.slice(idx, fnEnd > idx ? fnEnd : idx + 500);
    assert.match(fnBody, /managed_node_command/, `${fn} debe usar managed_node_command`);
  }

  // install_vivliostyle y download_portable_skill también usan managed_node_command
  const vivStart = runtimes.indexOf('pub fn install_vivliostyle()');
  const skillStart = runtimes.indexOf('pub fn download_portable_skill(');
  assert.ok(vivStart >= 0, 'install_vivliostyle debe existir');
  assert.ok(skillStart >= 0, 'download_portable_skill debe existir');
  const vivEnd = runtimes.indexOf('pub fn install_npm_packages', vivStart);
  const skillEnd = runtimes.indexOf('pub fn visual_install_profiles', skillStart);
  const viv = runtimes.slice(vivStart, vivEnd);
  const skill = runtimes.slice(skillStart, skillEnd);
  assert.match(viv, /managed_node_command/, 'install_vivliostyle debe usar managed_node_command');
  const skillMatches = [...skill.matchAll(/managed_node_command/g)];
  assert.ok(skillMatches.length >= 2, `download_portable_skill debe usar managed_node_command al menos 2 veces (npm install + smoke), encontrado: ${skillMatches.length}`);

  // engine usa managed_node_command en run_jintia
  const runStart = engine.indexOf('pub fn run_jintia');
  assert.ok(runStart >= 0, 'run_jintia debe existir');
  const runEnd = engine.indexOf('\npub fn run_jintia_json', runStart);
  const run = engine.slice(runStart, runEnd > runStart ? runEnd : runStart + 500);
  assert.match(run, /crate::runtimes::managed_node_command/, 'run_jintia debe usar managed_node_command');
  assert.doesNotMatch(run, /Command::new\(&node_bin\)/, 'run_jintia no debe usar Command::new directo');

  // mcp usa managed_node_command en ambos builders
  assert.match(mcp, /crate::runtimes::managed_node_command/, 'mcp.rs debe usar managed_node_command');
  const mcpNodeVStart = mcp.indexOf('fn build_managed_node_version_command');
  const mcpServerStart = mcp.indexOf('fn build_managed_mcp_server_command');
  assert.ok(mcpNodeVStart >= 0 && mcpServerStart >= 0);
  const mcpNodeVEnd = mcp.indexOf('\nfn managed_node_version', mcpNodeVStart);
  const mcpServerEnd = mcp.indexOf('\nimpl McpConnection', mcpServerStart);
  const mcpNodeV = mcp.slice(mcpNodeVStart, mcpNodeVEnd);
  const mcpServer = mcp.slice(mcpServerStart, mcpServerEnd);
  assert.match(mcpNodeV, /crate::runtimes::managed_node_command/);
  assert.match(mcpServer, /crate::runtimes::managed_node_command/);
  assert.doesNotMatch(mcpNodeV, /Command::new\(node\)/);
  assert.doesNotMatch(mcpServer, /Command::new\(node\)/);
});

test('engine entrega a Jintia un PATH compuesto sólo por runtimes administrados', async () => {
  const source = await readFile(new URL('src-tauri/src/engine.rs', root), 'utf8');
  const start = source.indexOf('fn managed_runtime_path');
  const end = source.indexOf('\npub fn run_jintia', start);
  const helper = source.slice(start, end);
  const runStart = source.indexOf('pub fn run_jintia');
  const runEnd = source.indexOf('\n/// Ejecuta un comando Jintia y parsea', runStart);
  const run = source.slice(runStart, runEnd);
  assert.ok(start >= 0 && end > start && runStart >= 0 && runEnd > runStart);
  assert.match(helper, /portable_node_bin_dir/); assert.match(`${helper}\n${run}`, /resolve_python/);
  assert.match(helper, /join_paths/);
  assert.match(run, /managed_entrypoint/); assert.match(run, /resolve_node/); assert.match(run, /managed_node_command\(&node_bin\)/); assert.match(run, /\.env\("PATH", managed_path\)/);
  assert.doesNotMatch(`${helper}\n${run}`, /var_os\("PATH"\)|base_path|split_paths/);
  assert.doesNotMatch(`${helper}\n${run}`, /where\.exe|\bwhich\b|Command::new\("(?:node|npm|npx|python|python3|jintia)"\)/);
  assert.doesNotMatch(`${helper}\n${run}`, /env_clear/);
});

test('Git manual en macOS y Linux no recomienda instalar runtimes ajenos', async () => {
  const course = await readFile(new URL('src-tauri/src/course.rs', root), 'utf8');

  // install_dependency debe despachar Node.js, Python y Git explícitamente
  const installStart = course.indexOf('pub fn install_dependency');
  const installEnd = course.indexOf('\nfn slug_component', installStart);
  assert.ok(installStart >= 0 && installEnd > installStart, 'install_dependency no encontrada');
  const installFn = course.slice(installStart, installEnd);
  assert.match(installFn, /Node\.js/, 'falta rama Node.js');
  assert.match(installFn, /Python/, 'falta rama Python');
  assert.match(installFn, /"Git"/, 'falta rama Git');
  assert.match(installFn, /Dependencia desconocida/, 'falta rechazo de dependencia desconocida');

  // El helper manual_git_installation_instructions debe existir
  const helperStart = course.indexOf('fn manual_git_installation_instructions');
  const helperEnd = course.indexOf('\npub fn install_dependency', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'helper manual_git_installation_instructions no encontrado');
  const helper = course.slice(helperStart, helperEnd);

  // El helper debe guiar a instalar Git correctamente
  assert.match(helper, /brew install git/, 'falta instrucción macOS brew install git');
  assert.match(helper, /sudo apt install git/, 'falta ejemplo Linux sudo apt install git');
  assert.match(helper, /Debian\/Ubuntu/, 'falta referencia a Debian/Ubuntu en el ejemplo Linux');

  // El helper NO debe recomendar instalación global de Node o Python
  assert.doesNotMatch(helper, /brew install node/, 'helper no debe recomendar brew install node');
  assert.doesNotMatch(helper, /brew install node python/, 'helper no debe recomendar brew install node python');
  assert.doesNotMatch(helper, /apt install nodejs/, 'helper no debe recomendar apt install nodejs');
  assert.doesNotMatch(helper, /apt install npm/, 'helper no debe recomendar apt install npm');
  assert.doesNotMatch(helper, /apt install python/, 'helper no debe recomendar apt install python');
  assert.doesNotMatch(helper, /apt install python3/, 'helper no debe recomendar apt install python3');

  // El fallback no-Windows usa manual_git_installation_instructions y no el texto antiguo
  assert.doesNotMatch(installFn, /brew install node python/, 'install_dependency no debe recomendar brew install node python');
  assert.doesNotMatch(installFn, /apt install nodejs npm python3/, 'install_dependency no debe recomendar apt install nodejs npm python3');

  // Windows conserva Git.Git y winget
  assert.match(installFn, /Git\.Git/, 'falta Git.Git en rama Windows');
  assert.match(installFn, /winget\.exe/, 'falta winget.exe en rama Windows');

  // Node.js portable branch intacta
  assert.match(installFn, /Descargar Node\.js portable/, 'falta botón Node.js portable');
  // Python portable branch intacta
  assert.match(installFn, /Descargar Python portable/, 'falta botón Python portable');
});

test('Todo subprocess Python administrado de Desktop usa la política central de modo aislado', async () => {
  const runtimes = await readFile(new URL('src-tauri/src/runtimes.rs', root), 'utf8');

  // Separar producción de tests
  const testCfgIdx = runtimes.indexOf('#[cfg(test)]');
  const production = testCfgIdx >= 0 ? runtimes.slice(0, testCfgIdx) : runtimes;

  // El helper central debe existir con la política -I
  const helperStart = production.indexOf('pub(crate) fn managed_python_command(');
  const helperEnd = production.indexOf('\nfn build_portable_python_version_command', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'managed_python_command no encontrado');
  const helper = production.slice(helperStart, helperEnd);
  assert.match(helper, /Command::new\(python\)/, 'helper debe crear Command con el python recibido');
  assert.match(helper, /\.arg\("-I"\)/, 'helper debe añadir -I');
  assert.doesNotMatch(helper, /\.output\(|\.spawn\(|\.status\(/, 'helper no debe ejecutar subprocess');
  assert.doesNotMatch(helper, /\.current_dir\(/, 'helper no debe definir cwd');
  assert.doesNotMatch(helper, /\.env\(|\.env_remove\(|env_clear/, 'helper no debe modificar environment');
  assert.doesNotMatch(helper, /PATH|PYTHON/, 'helper no debe referenciar variables de entorno');
  assert.doesNotMatch(helper, /pip|--version|install/, 'helper no debe añadir argumentos de consumer');

  // El builder de versión portable debe existir y delegar al helper
  const versionBuilderStart = production.indexOf('fn build_portable_python_version_command(');
  const versionBuilderEnd = production.indexOf('\npub fn python_version', versionBuilderStart);
  assert.ok(versionBuilderStart >= 0 && versionBuilderEnd > versionBuilderStart, 'build_portable_python_version_command no encontrado');
  const versionBuilder = production.slice(versionBuilderStart, versionBuilderEnd);
  assert.match(versionBuilder, /managed_python_command\(python\)/, 'version builder debe usar helper central');
  assert.match(versionBuilder, /"--version"/, 'version builder debe añadir --version');
  assert.doesNotMatch(versionBuilder, /Command::new\(python\)/, 'version builder no debe crear Command directamente');
  assert.doesNotMatch(versionBuilder, /"-I"/, 'version builder no debe duplicar -I localmente');

  // python_version debe delegar al builder
  const pvStart = production.indexOf('pub fn python_version(');
  assert.ok(pvStart >= 0, 'python_version no encontrada');
  const pvEnd = production.indexOf('\npub fn download_portable_python', pvStart);
  const pv = production.slice(pvStart, pvEnd);
  assert.match(pv, /build_portable_python_version_command/, 'python_version debe usar el builder');
  assert.doesNotMatch(pv, /Command::new\(&python_bin\)/, 'python_version no debe construir Command directamente');
  assert.doesNotMatch(pv, /"-I"/, 'python_version no debe duplicar -I');

  // validate_python_runtime debe usar el helper central (mínimo 2 veces)
  const validatorStart = production.indexOf('fn validate_python_runtime(');
  const validatorEnd = production.indexOf('\nfn python_version_text_matches_expected', validatorStart);
  assert.ok(validatorStart >= 0 && validatorEnd > validatorStart);
  const validator = production.slice(validatorStart, validatorEnd);
  const validatorHelperUses = (validator.match(/managed_python_command\(&python_exe\)/g) || []).length;
  assert.ok(validatorHelperUses >= 2, `validate_python_runtime debe usar managed_python_command al menos 2 veces, encontrado: ${validatorHelperUses}`);
  assert.doesNotMatch(validator, /Command::new\(&python_exe\)/, 'validator no debe construir Command directamente');
  assert.doesNotMatch(validator, /"-I"/, 'validator no debe duplicar -I localmente');

  // build_managed_pip_install_command debe usar el helper central
  const pipStart = production.indexOf('fn build_managed_pip_install_command(');
  const pipEnd = production.indexOf('\n// ==================== NPM PACKAGES ====================', pipStart);
  assert.ok(pipStart >= 0 && pipEnd > pipStart);
  const pip = production.slice(pipStart, pipEnd);
  assert.match(pip, /managed_python_command\(python\)/, 'pip builder debe usar helper central');
  assert.match(pip, /\.args\(\["-m",\s*"pip",\s*"install",\s*"--quiet"\]\)/, 'pip builder debe añadir args pip');
  assert.match(pip, /\.args\(packages\)/);
  assert.match(pip, /\.env\("PATH",\s*managed_path\)/);
  assert.doesNotMatch(pip, /Command::new\(python\)/, 'pip builder no debe construir Command directamente');
  assert.doesNotMatch(pip, /"-I"/, 'pip builder no debe duplicar -I localmente');

  // En producción, "-I" como política Python aparece exactamente una vez: en el helper
  const isolatedModeMatches = (production.match(/\.arg\("-I"\)/g) || []).length;
  assert.equal(isolatedModeMatches, 1, `"-I" como política Python debe aparecer exactamente 1 vez en producción, encontrado: ${isolatedModeMatches}`);
});

test('Las descargas de runtimes rechazan HTTP de error antes de escribir artefactos', async () => {
  const runtimes = await readFile(new URL('src-tauri/src/runtimes.rs', root), 'utf8');

  // ── Node ────────────────────────────────────────────────────────────────────
  const nodeStart = runtimes.indexOf('pub fn download_portable_node(');
  const nodeEnd = runtimes.indexOf('\nfn node_version_text_matches_expected', nodeStart);
  assert.ok(nodeStart >= 0 && nodeEnd > nodeStart, 'download_portable_node no encontrada');
  const nodeDownloader = runtimes.slice(nodeStart, nodeEnd);

  const nodeGet = nodeDownloader.indexOf('reqwest::blocking::get(url)');
  const nodeStatus = nodeDownloader.indexOf('error_for_status()');
  const nodeLength = nodeDownloader.indexOf('content_length()');
  const nodeCreate = nodeDownloader.indexOf('fs::File::create(&tmp_file)');

  assert.ok(nodeGet >= 0, 'Node: falta reqwest::blocking::get(url)');
  assert.ok(nodeStatus >= 0, 'Node: falta error_for_status()');
  assert.ok(nodeLength >= 0, 'Node: falta content_length()');
  assert.ok(nodeCreate >= 0, 'Node: falta fs::File::create(&tmp_file)');
  assert.ok(nodeGet < nodeStatus, 'Node: get debe preceder a error_for_status');
  assert.ok(nodeStatus < nodeLength, 'Node: error_for_status debe preceder a content_length');
  assert.ok(nodeLength < nodeCreate, 'Node: content_length debe preceder a File::create');

  assert.match(nodeDownloader, /Error descargando Node\.js/, 'Node: mensaje de error de descarga ausente');
  assert.doesNotMatch(nodeDownloader, /status\(\)\.is_success\(\)|status\(\)\.as_u16\(\)|StatusCode::/, 'Node: no debe usar status manual');

  // ── Python ──────────────────────────────────────────────────────────────────
  const pyStart = runtimes.indexOf('pub fn download_portable_python(');
  const pyEnd = runtimes.indexOf('\nfn emit_python_progress', pyStart);
  assert.ok(pyStart >= 0 && pyEnd > pyStart, 'download_portable_python no encontrada');
  const pyDownloader = runtimes.slice(pyStart, pyEnd);

  const pyGet = pyDownloader.indexOf('reqwest::blocking::get(&asset.url)');
  const pyStatus = pyDownloader.indexOf('error_for_status()');
  const pyLength = pyDownloader.indexOf('content_length()');
  const pyCreate = pyDownloader.indexOf('fs::File::create(&tmp_archive)');

  assert.ok(pyGet >= 0, 'Python: falta reqwest::blocking::get(&asset.url)');
  assert.ok(pyStatus >= 0, 'Python: falta error_for_status()');
  assert.ok(pyLength >= 0, 'Python: falta content_length()');
  assert.ok(pyCreate >= 0, 'Python: falta fs::File::create(&tmp_archive)');
  assert.ok(pyGet < pyStatus, 'Python: get debe preceder a error_for_status');
  assert.ok(pyStatus < pyLength, 'Python: error_for_status debe preceder a content_length');
  assert.ok(pyLength < pyCreate, 'Python: content_length debe preceder a File::create');

  assert.match(pyDownloader, /Error descargando Python/, 'Python: mensaje de error de descarga ausente');
  assert.doesNotMatch(pyDownloader, /status\(\)\.is_success\(\)|status\(\)\.as_u16\(\)|StatusCode::/, 'Python: no debe usar status manual');

  // ── Precedentes existentes deben conservarse ─────────────────────────────
  const resolveAsset = runtimes.indexOf('fn resolve_python_asset(');
  assert.ok(resolveAsset >= 0, 'resolve_python_asset no encontrada');
  const resolveSlice = runtimes.slice(resolveAsset, runtimes.indexOf('\nfn extract_python_tar_gz', resolveAsset));
  assert.match(resolveSlice, /error_for_status\(\)/, 'resolve_python_asset debe conservar error_for_status');

  const checksumFn = runtimes.indexOf('fn fetch_node_checksum(');
  assert.ok(checksumFn >= 0, 'fetch_node_checksum no encontrada');
  const checksumSlice = runtimes.slice(checksumFn, runtimes.indexOf('\n}', checksumFn) + 2);
  assert.match(checksumSlice, /error_for_status\(\)/, 'fetch_node_checksum debe conservar error_for_status');
});

test('Node y Python rechazan instalaciones concurrentes antes de tocar staging', async () => {
  const runtimes = await readFile(new URL('src-tauri/src/runtimes.rs', root), 'utf8');
  const testCfgIdx = runtimes.indexOf('#[cfg(test)]');
  const production = testCfgIdx >= 0 ? runtimes.slice(0, testCfgIdx) : runtimes;

  // Imports requeridos
  assert.match(production, /use std::sync::\{[^}]*Mutex[^}]*\}/, 'falta import Mutex');
  assert.match(production, /MutexGuard/, 'falta MutexGuard');
  assert.match(production, /TryLockError/, 'falta TryLockError');

  // Locks separados por recurso
  assert.match(production, /NODE_RUNTIME_MUTATION_LOCK.*Mutex/, 'falta NODE_RUNTIME_MUTATION_LOCK');
  assert.match(production, /PYTHON_RUNTIME_MUTATION_LOCK.*Mutex/, 'falta PYTHON_RUNTIME_MUTATION_LOCK');
  assert.doesNotMatch(production, /static RUNTIME_MUTATION_LOCK[^_]/, 'no debe existir un lock compartido único');

  // Helper try_runtime_mutation_lock
  const helperStart = production.indexOf('fn try_runtime_mutation_lock');
  assert.ok(helperStart >= 0, 'helper try_runtime_mutation_lock no encontrado');
  const helperEnd = production.indexOf('\npub fn download_portable_node', helperStart);
  const helper = production.slice(helperStart, helperEnd);
  assert.match(helper, /lock\.try_lock\(\)/, 'helper debe usar try_lock');
  assert.match(helper, /TryLockError::WouldBlock/, 'helper debe manejar WouldBlock');
  assert.match(helper, /TryLockError::Poisoned/, 'helper debe manejar Poisoned');
  assert.match(helper, /Ya hay una operación sobre/, 'helper debe producir error WouldBlock claro');
  assert.doesNotMatch(helper, /lock\.lock\(\)/, 'helper no debe usar lock() bloqueante');
  assert.doesNotMatch(helper, /sleep|loop|into_inner|clear_poison/, 'helper no debe recuperar silenciosamente');
  assert.doesNotMatch(helper, /fs::|reqwest|Command|PATH/, 'helper no debe tener side effects');

  // Node — guard adquirido antes de side effects
  const nodeStart = production.indexOf('pub fn download_portable_node(');
  const nodeEnd = production.indexOf('\nfn node_version_text_matches_expected', nodeStart);
  assert.ok(nodeStart >= 0 && nodeEnd > nodeStart, 'download_portable_node no encontrada');
  const nodeDownloader = production.slice(nodeStart, nodeEnd);
  assert.match(nodeDownloader, /let _node_guard.*try_runtime_mutation_lock/, 'Node: guard debe asignarse a variable');
  assert.match(nodeDownloader, /NODE_RUNTIME_MUTATION_LOCK/, 'Node: debe usar su lock específico');
  assert.doesNotMatch(nodeDownloader, /PYTHON_RUNTIME_MUTATION_LOCK/, 'Node: no debe usar lock de Python');

  const nodeLockIdx = nodeDownloader.indexOf('try_runtime_mutation_lock');
  const nodePathsIdx = nodeDownloader.indexOf('paths::portable_runtimes_dir');
  const nodeCreateDirIdx = nodeDownloader.indexOf('fs::create_dir_all');
  const nodeHttpIdx = nodeDownloader.indexOf('reqwest::blocking::get');
  const nodeStageIdx = nodeDownloader.indexOf('.node-stage-');
  const nodeActivateIdx = nodeDownloader.indexOf('activate_staged_node_runtime');
  assert.ok(nodeLockIdx < nodePathsIdx, 'Node: lock antes de paths');
  assert.ok(nodePathsIdx < nodeCreateDirIdx, 'Node: paths antes de create_dir_all');
  assert.ok(nodeCreateDirIdx < nodeHttpIdx, 'Node: create_dir antes de HTTP');
  assert.ok(nodeHttpIdx < nodeStageIdx, 'Node: HTTP antes de stage');
  assert.ok(nodeStageIdx < nodeActivateIdx, 'Node: stage antes de activation');

  // Python — guard adquirido antes de side effects
  const pyStart = production.indexOf('pub fn download_portable_python(');
  const pyEnd = production.indexOf('\nfn emit_python_progress', pyStart);
  assert.ok(pyStart >= 0 && pyEnd > pyStart, 'download_portable_python no encontrada');
  const pyDownloader = production.slice(pyStart, pyEnd);
  assert.match(pyDownloader, /let _python_guard.*try_runtime_mutation_lock/, 'Python: guard debe asignarse a variable');
  assert.match(pyDownloader, /PYTHON_RUNTIME_MUTATION_LOCK/, 'Python: debe usar su lock específico');
  assert.doesNotMatch(pyDownloader, /NODE_RUNTIME_MUTATION_LOCK/, 'Python: no debe usar lock de Node');

  const pyLockIdx = pyDownloader.indexOf('try_runtime_mutation_lock');
  const pyPathsIdx = pyDownloader.indexOf('paths::portable_runtimes_dir');
  const pyCreateDirIdx = pyDownloader.indexOf('fs::create_dir_all');
  const pyResolveIdx = pyDownloader.indexOf('resolve_python_asset');
  const pyHttpIdx = pyDownloader.indexOf('reqwest::blocking::get');
  const pyStageIdx = pyDownloader.indexOf('.python-stage-');
  const pyActivateIdx = pyDownloader.indexOf('activate_staged_python_runtime');
  assert.ok(pyLockIdx < pyPathsIdx, 'Python: lock antes de paths');
  assert.ok(pyPathsIdx < pyCreateDirIdx, 'Python: paths antes de create_dir_all');
  assert.ok(pyCreateDirIdx < pyResolveIdx, 'Python: create_dir antes de resolve_python_asset');
  assert.ok(pyResolveIdx < pyHttpIdx, 'Python: resolve antes de HTTP');
  assert.ok(pyHttpIdx < pyStageIdx, 'Python: HTTP antes de stage');
  assert.ok(pyStageIdx < pyActivateIdx, 'Python: stage antes de activation');
});

test('Configuración instala Vivliostyle con su instalador administrado existente', async () => {
  const [settings, api, lib, runtimes, course] = await Promise.all([
    readFile(new URL('src/pages/settings.js', root), 'utf8'),
    readFile(new URL('src/api.js', root), 'utf8'),
    readFile(new URL('src-tauri/src/lib.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/runtimes.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/course.rs', root), 'utf8'),
  ]);

  // course.rs declara Vivliostyle como dependencia required e installable
  assert.match(course, /name:.*"Vivliostyle CLI"/, 'course: falta declaración Vivliostyle CLI');
  assert.match(course, /required.*true/, 'course: Vivliostyle debe ser required');
  assert.match(course, /installable.*true/, 'course: Vivliostyle debe ser installable');

  // course.rs no debe tener rama Vivliostyle en install_dependency (no duplicar autoridad)
  const installDepStart = course.indexOf('pub fn install_dependency(');
  const installDepEnd = course.indexOf('\nfn slug_component', installDepStart);
  const installDep = course.slice(installDepStart, installDepEnd);
  assert.doesNotMatch(installDep, /"Vivliostyle CLI"/, 'install_dependency no debe contener rama Vivliostyle');

  // api.js exporta installVivliostyleCli que invoca install_vivliostyle_cli
  assert.match(api, /export async function installVivliostyleCli/, 'api: falta export installVivliostyleCli');
  assert.match(api, /invoke\(["']install_vivliostyle_cli["']\)/, 'api: falta invoke install_vivliostyle_cli');

  // lib.rs registra el comando y delega en runtimes::install_vivliostyle
  assert.match(lib, /async fn install_vivliostyle_cli/, 'lib: falta comando install_vivliostyle_cli');
  assert.match(lib, /runtimes::install_vivliostyle\(\)/, 'lib: falta delegación a runtimes::install_vivliostyle');
  assert.match(lib, /install_vivliostyle_cli/, 'lib: falta en generate_handler');

  // runtimes.rs tiene el instalador con los elementos clave
  const installVStart = runtimes.indexOf('pub fn install_vivliostyle(');
  assert.ok(installVStart >= 0, 'runtimes: falta pub fn install_vivliostyle');
  const installVEnd = runtimes.indexOf('\npub fn ', installVStart + 1);
  const installV = runtimes.slice(installVStart, installVEnd > installVStart ? installVEnd : installVStart + 500);
  assert.match(installV, /@vivliostyle\/cli/, 'runtimes: falta @vivliostyle/cli');
  assert.match(installV, /portable_node_exe|portable_npm_cli|portable_vivliostyle_bin/, 'runtimes: falta uso de runtimes administrados');

  // settings.js importa installVivliostyleCli desde api.js
  assert.match(settings, /installVivliostyleCli/, 'settings: falta import de installVivliostyleCli');
  assert.doesNotMatch(settings, /invoke\(["']install_vivliostyle_cli["']\)/, 'settings: no debe llamar invoke directamente');

  // settings.js tiene la rama Vivliostyle antes del fallback genérico en el listener
  const listenerStart = settings.indexOf('querySelectorAll("[data-dep-name]")');
  assert.ok(listenerStart >= 0, 'settings: falta listener data-dep-name');
  const listenerEnd = settings.indexOf('[data-download-node]', listenerStart);
  const listener = settings.slice(listenerStart, listenerEnd > listenerStart ? listenerEnd : settings.length);

  assert.match(listener, /name\s*===\s*["']Vivliostyle CLI["']/, 'settings: falta branch Vivliostyle CLI');
  assert.match(listener, /installVivliostyleCli\(\)/, 'settings: falta llamada a installVivliostyleCli');
  assert.match(listener, /installDependency\(name,\s*true\)/, 'settings: falta fallback installDependency');

  const vivliostyleBranchIdx = listener.indexOf('Vivliostyle CLI');
  const genericFallbackIdx = listener.indexOf('installDependency(name');
  assert.ok(vivliostyleBranchIdx < genericFallbackIdx, 'settings: rama Vivliostyle debe preceder al fallback genérico');

  // El listener refresca estado tras éxito
  assert.match(listener, /if.*r\.success/, 'settings: falta comprobación de éxito');
  assert.match(listener, /loadDeps\(\)/, 'settings: falta loadDeps tras éxito');
  assert.match(listener, /loadSetupStatus\(\)/, 'settings: falta loadSetupStatus tras éxito');
});

test('Instalar herramientas necesarias incluye el renderer Vivliostyle administrado', async () => {
  const [settings, course] = await Promise.all([
    readFile(new URL('src/pages/settings.js', root), 'utf8'),
    readFile(new URL('src-tauri/src/course.rs', root), 'utf8'),
  ]);

  // course.rs declara Vivliostyle como renderer obligatorio
  const vivliostyleBlock = (() => {
    const nameIdx = course.indexOf('"Vivliostyle CLI"');
    assert.ok(nameIdx >= 0, 'course: falta declaración Vivliostyle CLI');
    return course.slice(nameIdx, nameIdx + 400);
  })();
  assert.match(vivliostyleBlock, /required.*true/, 'course: Vivliostyle CLI debe ser required: true');
  assert.match(vivliostyleBlock, /installable.*true/, 'course: Vivliostyle CLI debe ser installable: true');

  // BULK_INSTALL_TARGETS contiene exactamente cuatro targets obligatorios
  const bulkSetStart = settings.indexOf('const BULK_INSTALL_TARGETS');
  assert.ok(bulkSetStart >= 0, 'settings: falta BULK_INSTALL_TARGETS');
  const bulkSetEnd = settings.indexOf(';', bulkSetStart);
  const bulkSetSrc = settings.slice(bulkSetStart, bulkSetEnd + 1);

  assert.match(bulkSetSrc, /"Node\.js"/, 'bulk: falta Node.js');
  assert.match(bulkSetSrc, /"Python"/, 'bulk: falta Python');
  assert.match(bulkSetSrc, /"Jintia Skill"/, 'bulk: falta Jintia Skill');
  assert.match(bulkSetSrc, /"Vivliostyle CLI"/, 'bulk: falta Vivliostyle CLI');

  const bulkLiterals = [...bulkSetSrc.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.strictEqual(bulkLiterals.length, 4, `bulk: debe tener exactamente 4 targets, tiene ${bulkLiterals.length}: ${bulkLiterals.join(', ')}`);

  // Targets opcionales no deben aparecer en el Set
  const forbidden = ['Git', 'NotebookLM MCP', 'Compilador LaTeX', 'Graphviz', 'PlantUML', 'D2', 'Vega-Lite CLI', 'WaveDrom', 'Inkscape', 'Mermaid CLI', 'Google Chrome'];
  for (const f of forbidden) {
    assert.doesNotMatch(bulkSetSrc, new RegExp(`"${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), `bulk: "${f}" no debe pertenecer a BULK_INSTALL_TARGETS`);
  }

  // Listener bulk: filtrado correcto
  const bulkListenerStart = settings.indexOf('"#btn-install-all-deps"');
  assert.ok(bulkListenerStart >= 0, 'settings: falta listener #btn-install-all-deps');
  const bulkListenerEnd = settings.indexOf('\n    });', bulkListenerStart);
  const bulkListener = settings.slice(bulkListenerStart, bulkListenerEnd > bulkListenerStart ? bulkListenerEnd + 8 : settings.length);

  assert.match(bulkListener, /!d\.installed/, 'bulk: debe filtrar dependencias no instaladas');
  assert.match(bulkListener, /BULK_INSTALL_TARGETS\.has\(d\.name\)/, 'bulk: debe filtrar por BULK_INSTALL_TARGETS');
  assert.match(bulkListener, /for\s*\(const dep of targets\)/, 'bulk: debe usar bucle secuencial for-of');

  // Dispatch: runtimes conocidos usan sus instaladores dedicados
  assert.match(bulkListener, /downloadNodeRuntime\(\)/, 'bulk: falta downloadNodeRuntime');
  assert.match(bulkListener, /downloadPythonRuntime\(\)/, 'bulk: falta downloadPythonRuntime');
  assert.match(bulkListener, /downloadSkillRuntime\(\)/, 'bulk: falta downloadSkillRuntime');

  // Vivliostyle usa su instalador administrado y precede al fallback genérico
  assert.match(bulkListener, /dep\.name\s*===\s*["']Vivliostyle CLI["']/, 'bulk: falta rama dep.name === "Vivliostyle CLI"');
  assert.match(bulkListener, /installVivliostyleCli\(\)/, 'bulk: falta llamada a installVivliostyleCli');
  assert.match(bulkListener, /installDependency\(dep\.name,\s*true\)/, 'bulk: falta fallback genérico installDependency');

  const vivliostyleBranchIdx = bulkListener.indexOf('"Vivliostyle CLI"');
  const installVivIdx = bulkListener.indexOf('installVivliostyleCli()');
  const genericFallbackIdx = bulkListener.indexOf('installDependency(dep.name');
  assert.ok(vivliostyleBranchIdx < installVivIdx, 'bulk: rama Vivliostyle debe preceder a installVivliostyleCli');
  assert.ok(installVivIdx < genericFallbackIdx, 'bulk: installVivliostyleCli debe preceder al fallback genérico');

  // Sin paralelismo ni invoke directo
  assert.doesNotMatch(bulkListener, /Promise\.all|Promise\.allSettled/, 'bulk: no debe paralelizar instalaciones');
  assert.doesNotMatch(settings, /invoke\(["']install_vivliostyle_cli["']\)/, 'settings: no debe invocar install_vivliostyle_cli directamente');

  // Refresh final del estado tras el loop
  assert.match(bulkListener, /loadDeps\(\)/, 'bulk: falta loadDeps tras el loop');
  assert.match(bulkListener, /loadSetupStatus\(\)/, 'bulk: falta loadSetupStatus tras el loop');
});

test('El bulk respeta Node como prerrequisito sin bloquear Python independiente', async () => {
  const [settings, runtimes] = await Promise.all([
    readFile(new URL('src/pages/settings.js', root), 'utf8'),
    readFile(new URL('src-tauri/src/runtimes.rs', root), 'utf8'),
  ]);

  // runtimes.rs: download_portable_skill requiere Node portable
  const skillFnStart = runtimes.indexOf('pub fn download_portable_skill(');
  assert.ok(skillFnStart >= 0, 'runtimes: falta pub fn download_portable_skill');
  const skillFnEnd = runtimes.indexOf('\npub fn ', skillFnStart + 1);
  const skillFn = runtimes.slice(skillFnStart, skillFnEnd > skillFnStart ? skillFnEnd : skillFnStart + 600);
  assert.match(skillFn, /portable_node_exe/, 'runtimes: download_portable_skill debe requerir portable_node_exe');
  assert.match(skillFn, /Node portable no está disponible/, 'runtimes: download_portable_skill debe rechazar si Node falta');

  // runtimes.rs: install_vivliostyle requiere Node portable
  const vivFnStart = runtimes.indexOf('pub fn install_vivliostyle(');
  assert.ok(vivFnStart >= 0, 'runtimes: falta pub fn install_vivliostyle');
  const vivFnEnd = runtimes.indexOf('\npub fn ', vivFnStart + 1);
  const vivFn = runtimes.slice(vivFnStart, vivFnEnd > vivFnStart ? vivFnEnd : vivFnStart + 600);
  assert.match(vivFn, /portable_node_exe/, 'runtimes: install_vivliostyle debe requerir portable_node_exe');
  assert.match(vivFn, /Node portable no está disponible/, 'runtimes: install_vivliostyle debe rechazar si Node falta');

  // NODE_DEPENDENT_BULK_TARGETS contiene exactamente Jintia Skill y Vivliostyle CLI
  const ndbtStart = settings.indexOf('const NODE_DEPENDENT_BULK_TARGETS');
  assert.ok(ndbtStart >= 0, 'settings: falta NODE_DEPENDENT_BULK_TARGETS');
  const ndbtEnd = settings.indexOf(';', ndbtStart);
  const ndbtSrc = settings.slice(ndbtStart, ndbtEnd + 1);

  assert.match(ndbtSrc, /"Jintia Skill"/, 'NODE_DEPENDENT: falta "Jintia Skill"');
  assert.match(ndbtSrc, /"Vivliostyle CLI"/, 'NODE_DEPENDENT: falta "Vivliostyle CLI"');

  const ndbtLiterals = [...ndbtSrc.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.strictEqual(ndbtLiterals.length, 2, `NODE_DEPENDENT: debe tener exactamente 2 entradas, tiene ${ndbtLiterals.length}: ${ndbtLiterals.join(', ')}`);

  const forbidden = ['Node.js', 'Python', 'Git', 'NotebookLM MCP', 'Compilador LaTeX'];
  for (const f of forbidden) {
    assert.doesNotMatch(ndbtSrc, new RegExp(`"${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), `NODE_DEPENDENT: "${f}" no debe ser dependiente de Node`);
  }

  // Listener bulk: nodeReady se deriva del snapshot deps
  const bulkListenerStart = settings.indexOf('"#btn-install-all-deps"');
  assert.ok(bulkListenerStart >= 0, 'settings: falta listener #btn-install-all-deps');
  const bulkListenerEnd = settings.indexOf('\n    });', bulkListenerStart);
  const bulkListener = settings.slice(bulkListenerStart, bulkListenerEnd > bulkListenerStart ? bulkListenerEnd + 8 : settings.length);

  // nodeReady derivado del snapshot deps (no hardcodeado a false ni true)
  assert.match(bulkListener, /nodeReady\s*=\s*deps\.some/, 'bulk: nodeReady debe derivarse de deps.some(...)');
  assert.match(bulkListener, /name\s*===\s*["']Node\.js["'].*installed/, 'bulk: nodeReady debe filtrar por name===Node.js && installed');

  // Guard de prerrequisito: antes de instalar dependientes de Node
  assert.match(bulkListener, /NODE_DEPENDENT_BULK_TARGETS\.has\(dep\.name\)/, 'bulk: falta guard NODE_DEPENDENT_BULK_TARGETS.has');
  assert.match(bulkListener, /!nodeReady/, 'bulk: falta !nodeReady en guard');
  assert.match(bulkListener, /continue/, 'bulk: falta continue en guard');
  assert.match(bulkListener, /Node\.js portable/, 'bulk: mensaje de omisión debe mencionar Node.js portable');

  // El guard ocurre antes del toast "Instalando…"
  const guardIdx = bulkListener.indexOf('NODE_DEPENDENT_BULK_TARGETS.has(dep.name)');
  const installingToastIdx = bulkListener.indexOf('Instalando ${dep.name}');
  assert.ok(guardIdx < installingToastIdx, 'bulk: el guard debe preceder al toast "Instalando"');

  // Actualización de nodeReady desde el resultado de Node, no incondicional
  assert.match(bulkListener, /dep\.name\s*===\s*["']Node\.js["'][\s\S]{0,60}nodeReady\s*=\s*r\.success/, 'bulk: nodeReady debe actualizarse desde r.success tras instalar Node');
  assert.doesNotMatch(bulkListener, /nodeReady\s*=\s*true(?!\s*===)/, 'bulk: nodeReady no debe asignarse true incondicionalmente');

  // Excepción Node: nodeReady=false garantizado en catch
  assert.match(bulkListener, /dep\.name\s*===\s*["']Node\.js["'][\s\S]{0,30}nodeReady\s*=\s*false/, 'bulk: catch debe fijar nodeReady=false si Node lanza excepción');

  // Python no es dependiente de Node (no aparece en guard ni en condición nodeReady específica)
  assert.doesNotMatch(ndbtSrc, /"Python"/, 'NODE_DEPENDENT: Python no debe ser dependiente de Node');
  assert.match(bulkListener, /downloadPythonRuntime\(\)/, 'bulk: falta downloadPythonRuntime');

  // downloadPythonRuntime no está condicionado a nodeReady
  const pythonBranchIdx = bulkListener.indexOf('downloadPythonRuntime()');
  const guardEndIdx = bulkListener.indexOf('continue');
  assert.ok(pythonBranchIdx > guardEndIdx, 'bulk: downloadPythonRuntime debe estar fuera del bloque guard (después del continue)');

  // Jintia y Vivliostyle siguen presentes (se instalan cuando Node está listo)
  assert.match(bulkListener, /downloadSkillRuntime\(\)/, 'bulk: falta downloadSkillRuntime');
  assert.match(bulkListener, /installVivliostyleCli\(\)/, 'bulk: falta installVivliostyleCli');

  // Sin abort global: no break por fallo de instalación
  assert.doesNotMatch(bulkListener, /\bbreak\b/, 'bulk: no debe usar break para abortar el loop');

  // Sin paralelismo
  assert.doesNotMatch(bulkListener, /Promise\.all|Promise\.allSettled/, 'bulk: no debe paralelizar instalaciones');

  // Refresh final tras el loop
  assert.match(bulkListener, /loadDeps\(\)/, 'bulk: falta loadDeps tras el loop');
  assert.match(bulkListener, /loadSetupStatus\(\)/, 'bulk: falta loadSetupStatus tras el loop');
});

test('Toda mutación de runtimes administrados usa locks por recurso', async () => {
  const runtimes = await readFile(new URL('src-tauri/src/runtimes.rs', root), 'utf8');
  // runtimes.rs tiene código de producción en dos bloques: antes y después del módulo #[cfg(test)].
  // Para statics y helper usamos el bloque inicial; para funciones que aparecen tras el módulo tests
  // usamos el archivo completo pero acotamos cada función con delimitadores estables.
  const testCfgIdx = runtimes.indexOf('#[cfg(test)]');
  const earlyProd = testCfgIdx >= 0 ? runtimes.slice(0, testCfgIdx) : runtimes;

  // Cuatro locks separados por recurso, todos Mutex<()>
  assert.match(earlyProd, /static NODE_RUNTIME_MUTATION_LOCK:\s*Mutex<\(\)>/, 'falta NODE_RUNTIME_MUTATION_LOCK');
  assert.match(earlyProd, /static PYTHON_RUNTIME_MUTATION_LOCK:\s*Mutex<\(\)>/, 'falta PYTHON_RUNTIME_MUTATION_LOCK');
  assert.match(earlyProd, /static SKILL_RUNTIME_MUTATION_LOCK:\s*Mutex<\(\)>/, 'falta SKILL_RUNTIME_MUTATION_LOCK');
  assert.match(earlyProd, /static NOTEBOOKLM_RUNTIME_MUTATION_LOCK:\s*Mutex<\(\)>/, 'falta NOTEBOOKLM_RUNTIME_MUTATION_LOCK');
  assert.doesNotMatch(earlyProd, /static RUNTIME_MUTATION_LOCK[^_]/, 'no debe existir un lock global único');
  assert.doesNotMatch(earlyProd, /NOTEBOOKLM_MCP_/, 'el lock NotebookLM no debe estar en el namespace MCP legacy');

  // Helper: try_lock, mensajes por recurso, sin bloqueo ni side effects
  const helperStart = earlyProd.indexOf('fn try_runtime_mutation_lock');
  assert.ok(helperStart >= 0, 'falta fn try_runtime_mutation_lock');
  const helperEnd = earlyProd.indexOf('\npub fn download_portable_node', helperStart);
  const helper = earlyProd.slice(helperStart, helperEnd);
  assert.match(helper, /try_lock\(\)/, 'helper debe usar try_lock');
  assert.match(helper, /TryLockError::WouldBlock/, 'helper debe manejar WouldBlock');
  assert.match(helper, /TryLockError::Poisoned/, 'helper debe manejar Poisoned');
  assert.match(helper, /Ya hay una operación sobre/, 'mensaje WouldBlock debe describir el recurso');
  assert.match(helper, /bloqueo interno quedó invalidado/, 'mensaje Poisoned debe ser fail-closed');
  assert.doesNotMatch(helper, /\.lock\(\)/, 'helper no debe usar lock() bloqueante');
  assert.doesNotMatch(helper, /sleep|loop|into_inner|clear_poison/, 'helper no debe recuperar silenciosamente');

  // download_portable_node: NODE lock antes de paths/HTTP (en bloque inicial)
  const nodeStart = earlyProd.indexOf('pub fn download_portable_node(');
  const nodeEnd = earlyProd.indexOf('\nfn node_version_text_matches_expected', nodeStart);
  const nodeFn = earlyProd.slice(nodeStart, nodeEnd);
  assert.match(nodeFn, /NODE_RUNTIME_MUTATION_LOCK/, 'download_portable_node: falta NODE_RUNTIME_MUTATION_LOCK');
  assert.match(nodeFn, /try_runtime_mutation_lock/, 'download_portable_node: falta try_runtime_mutation_lock');
  const nodeLockIdx = nodeFn.indexOf('NODE_RUNTIME_MUTATION_LOCK');
  const nodePathsIdx = nodeFn.indexOf('portable_runtimes_dir');
  assert.ok(nodeLockIdx < nodePathsIdx, 'download_portable_node: lock debe preceder a paths');

  // download_portable_python: PYTHON lock antes de paths/HTTP (en bloque inicial)
  const pyStart = earlyProd.indexOf('pub fn download_portable_python(');
  const pyEnd = earlyProd.indexOf('\nfn emit_python_progress', pyStart);
  const pyFn = earlyProd.slice(pyStart, pyEnd);
  assert.match(pyFn, /PYTHON_RUNTIME_MUTATION_LOCK/, 'download_portable_python: falta PYTHON_RUNTIME_MUTATION_LOCK');
  assert.match(pyFn, /try_runtime_mutation_lock/, 'download_portable_python: falta try_runtime_mutation_lock');
  const pyLockIdx = pyFn.indexOf('PYTHON_RUNTIME_MUTATION_LOCK');
  const pyPathsIdx = pyFn.indexOf('portable_runtimes_dir');
  assert.ok(pyLockIdx < pyPathsIdx, 'download_portable_python: lock debe preceder a paths');
  assert.doesNotMatch(pyFn, /NODE_RUNTIME_MUTATION_LOCK/, 'download_portable_python: no debe usar NODE lock');

  // install_pip_packages: empty check antes del lock, PYTHON lock antes de python exe (en bloque inicial)
  const pipStart = earlyProd.indexOf('pub fn install_pip_packages(');
  assert.ok(pipStart >= 0, 'falta pub fn install_pip_packages');
  const pipEnd = earlyProd.indexOf('\nfn managed_python_runtime_path', pipStart);
  const pipFn = earlyProd.slice(pipStart, pipEnd > pipStart ? pipEnd : pipStart + 500);
  assert.match(pipFn, /packages\.is_empty\(\)/, 'install_pip_packages: falta early return si empty');
  assert.match(pipFn, /PYTHON_RUNTIME_MUTATION_LOCK/, 'install_pip_packages: falta PYTHON_RUNTIME_MUTATION_LOCK');
  const pipEmptyIdx = pipFn.indexOf('packages.is_empty()');
  const pipLockIdx = pipFn.indexOf('PYTHON_RUNTIME_MUTATION_LOCK');
  assert.ok(pipEmptyIdx < pipLockIdx, 'install_pip_packages: early-return empty debe preceder al lock');
  assert.doesNotMatch(pipFn, /NODE_RUNTIME_MUTATION_LOCK/, 'install_pip_packages: no debe usar NODE lock');

  // install_notebooklm_mcp: MCP lock + NODE lock, en ese orden, antes de managed_mcp_contract (en bloque inicial)
  const mcpStart = earlyProd.indexOf('pub fn install_notebooklm_mcp(');
  assert.ok(mcpStart >= 0, 'falta pub fn install_notebooklm_mcp');
  const mcpEnd = earlyProd.indexOf('\n#[cfg(test)]', mcpStart);
  const mcpFn = earlyProd.slice(mcpStart, mcpEnd > mcpStart ? mcpEnd : mcpStart + 800);
  assert.match(mcpFn, /NOTEBOOKLM_RUNTIME_MUTATION_LOCK/, 'install_notebooklm_mcp: falta NOTEBOOKLM_RUNTIME_MUTATION_LOCK');
  assert.match(mcpFn, /NODE_RUNTIME_MUTATION_LOCK/, 'install_notebooklm_mcp: falta NODE_RUNTIME_MUTATION_LOCK');
  const mcpLockIdx = mcpFn.indexOf('NOTEBOOKLM_RUNTIME_MUTATION_LOCK');
  const mcpNodeLockIdx = mcpFn.indexOf('NODE_RUNTIME_MUTATION_LOCK');
  const mcpContractIdx = mcpFn.indexOf('managed_mcp_contract');
  assert.ok(mcpLockIdx < mcpNodeLockIdx, 'install_notebooklm_mcp: MCP lock debe preceder a NODE lock');
  assert.ok(mcpNodeLockIdx < mcpContractIdx, 'install_notebooklm_mcp: NODE lock debe preceder a managed_mcp_contract');

  // Funciones en el bloque posterior al módulo tests (búsqueda en archivo completo)
  // install_vivliostyle: NODE lock antes de portable_node_exe
  const vivStart = runtimes.indexOf('pub fn install_vivliostyle(');
  assert.ok(vivStart >= 0, 'falta pub fn install_vivliostyle');
  const vivEnd = runtimes.indexOf('\npub fn install_npm_packages(', vivStart);
  const vivFn = runtimes.slice(vivStart, vivEnd > vivStart ? vivEnd : vivStart + 800);
  assert.match(vivFn, /NODE_RUNTIME_MUTATION_LOCK/, 'install_vivliostyle: falta NODE_RUNTIME_MUTATION_LOCK');
  assert.match(vivFn, /try_runtime_mutation_lock/, 'install_vivliostyle: falta try_runtime_mutation_lock');
  const vivLockIdx = vivFn.indexOf('NODE_RUNTIME_MUTATION_LOCK');
  const vivNodeIdx = vivFn.indexOf('portable_node_exe');
  assert.ok(vivLockIdx < vivNodeIdx, 'install_vivliostyle: lock Node debe preceder a portable_node_exe');

  // install_npm_packages: empty check antes del lock, NODE lock antes de node exe
  const npmStart = runtimes.indexOf('pub fn install_npm_packages(');
  assert.ok(npmStart >= 0, 'falta pub fn install_npm_packages');
  const npmEnd = runtimes.indexOf('\n// ==================== CHECKSUM', npmStart);
  const npmFn = runtimes.slice(npmStart, npmEnd > npmStart ? npmEnd : npmStart + 600);
  assert.match(npmFn, /packages\.is_empty\(\)/, 'install_npm_packages: falta early return si empty');
  assert.match(npmFn, /NODE_RUNTIME_MUTATION_LOCK/, 'install_npm_packages: falta NODE_RUNTIME_MUTATION_LOCK');
  const npmEmptyIdx = npmFn.indexOf('packages.is_empty()');
  const npmLockIdx = npmFn.indexOf('NODE_RUNTIME_MUTATION_LOCK');
  assert.ok(npmEmptyIdx < npmLockIdx, 'install_npm_packages: early-return empty debe preceder al lock');

  // download_portable_skill: SKILL lock + NODE lock, en ese orden, antes de portable_node_exe
  const skillStart = runtimes.indexOf('pub fn download_portable_skill(');
  assert.ok(skillStart >= 0, 'falta pub fn download_portable_skill');
  const skillEnd = runtimes.indexOf('\npub fn visual_install_profiles', skillStart);
  const skillFn = runtimes.slice(skillStart, skillEnd > skillStart ? skillEnd : skillStart + 1000);
  assert.match(skillFn, /SKILL_RUNTIME_MUTATION_LOCK/, 'download_portable_skill: falta SKILL_RUNTIME_MUTATION_LOCK');
  assert.match(skillFn, /NODE_RUNTIME_MUTATION_LOCK/, 'download_portable_skill: falta NODE_RUNTIME_MUTATION_LOCK');
  const skillLockIdx = skillFn.indexOf('SKILL_RUNTIME_MUTATION_LOCK');
  const skillNodeLockIdx = skillFn.indexOf('NODE_RUNTIME_MUTATION_LOCK');
  const skillNodeExeIdx = skillFn.indexOf('portable_node_exe');
  assert.ok(skillLockIdx < skillNodeLockIdx, 'download_portable_skill: SKILL lock debe preceder a NODE lock');
  assert.ok(skillNodeLockIdx < skillNodeExeIdx, 'download_portable_skill: NODE lock debe preceder a portable_node_exe');
});

test('Configuración descarga runtimes individuales exclusivamente mediante api.js', async () => {
  const [settings, api] = await Promise.all([
    readFile(new URL('src/pages/settings.js', root), 'utf8'),
    readFile(new URL('src/api.js', root), 'utf8'),
  ]);

  // api.js declara los tres wrappers con sus comandos Tauri
  assert.match(api, /export async function downloadNodeRuntime/, 'api: falta export downloadNodeRuntime');
  assert.match(api, /invoke\(["']download_node_runtime["']\)/, 'api: falta invoke download_node_runtime');
  assert.match(api, /export async function downloadPythonRuntime/, 'api: falta export downloadPythonRuntime');
  assert.match(api, /invoke\(["']download_python_runtime["']\)/, 'api: falta invoke download_python_runtime');
  assert.match(api, /export async function downloadSkillRuntime/, 'api: falta export downloadSkillRuntime');
  assert.match(api, /invoke\(["']download_skill_runtime["']\)/, 'api: falta invoke download_skill_runtime');

  // settings.js importa los tres wrappers (sin importar invoke directamente)
  assert.match(settings, /downloadNodeRuntime/, 'settings: falta referencia a downloadNodeRuntime');
  assert.match(settings, /downloadPythonRuntime/, 'settings: falta referencia a downloadPythonRuntime');
  assert.match(settings, /downloadSkillRuntime/, 'settings: falta referencia a downloadSkillRuntime');
  assert.doesNotMatch(settings, /@tauri-apps\/api\/core/, 'settings: no debe importar @tauri-apps/api/core directamente');

  // Listener Node individual: usa wrapper, conserva evento de progreso y refresh
  const nodeListenerStart = settings.indexOf('"[data-download-node]"');
  assert.ok(nodeListenerStart >= 0, 'settings: falta listener data-download-node');
  const nodeListenerEnd = settings.indexOf('"[data-download-python]"', nodeListenerStart);
  const nodeListener = settings.slice(nodeListenerStart, nodeListenerEnd > nodeListenerStart ? nodeListenerEnd : settings.length);

  assert.match(nodeListener, /downloadNodeRuntime\(\)/, 'node listener: debe usar downloadNodeRuntime()');
  assert.match(nodeListener, /node-download-progress/, 'node listener: falta node-download-progress');
  assert.match(nodeListener, /result\.success/, 'node listener: falta result.success');
  assert.match(nodeListener, /loadDeps\(\)/, 'node listener: falta loadDeps');
  assert.match(nodeListener, /loadSetupStatus\(\)/, 'node listener: falta loadSetupStatus');
  assert.doesNotMatch(nodeListener, /\.tauri\.invoke/, 'node listener: no debe usar .tauri.invoke');
  assert.doesNotMatch(nodeListener, /download_node_runtime/, 'node listener: nombre de comando no debe aparecer en settings');

  // Listener Python individual: usa wrapper, conserva evento de progreso y refresh
  const pythonListenerStart = settings.indexOf('"[data-download-python]"');
  assert.ok(pythonListenerStart >= 0, 'settings: falta listener data-download-python');
  const pythonListenerEnd = settings.indexOf('"[data-download-skill]"', pythonListenerStart);
  const pythonListener = settings.slice(pythonListenerStart, pythonListenerEnd > pythonListenerStart ? pythonListenerEnd : settings.length);

  assert.match(pythonListener, /downloadPythonRuntime\(\)/, 'python listener: debe usar downloadPythonRuntime()');
  assert.match(pythonListener, /python-download-progress/, 'python listener: falta python-download-progress');
  assert.match(pythonListener, /result\.success/, 'python listener: falta result.success');
  assert.doesNotMatch(pythonListener, /\.tauri\.invoke/, 'python listener: no debe usar .tauri.invoke');
  assert.doesNotMatch(pythonListener, /download_python_runtime/, 'python listener: nombre de comando no debe aparecer en settings');

  // Listener Skill individual: usa wrapper, conserva evento de progreso y refresh
  const skillListenerStart = settings.indexOf('"[data-download-skill]"');
  assert.ok(skillListenerStart >= 0, 'settings: falta listener data-download-skill');
  const skillListenerEnd = settings.indexOf('"#visual-install-profile"', skillListenerStart);
  const skillListener = settings.slice(skillListenerStart, skillListenerEnd > skillListenerStart ? skillListenerEnd : settings.length);

  assert.match(skillListener, /downloadSkillRuntime\(\)/, 'skill listener: debe usar downloadSkillRuntime()');
  assert.match(skillListener, /skill-download-progress/, 'skill listener: falta skill-download-progress');
  assert.match(skillListener, /result\.success/, 'skill listener: falta result.success');
  assert.doesNotMatch(skillListener, /\.tauri\.invoke/, 'skill listener: no debe usar .tauri.invoke');
  assert.doesNotMatch(skillListener, /download_skill_runtime/, 'skill listener: nombre de comando no debe aparecer en settings');

  // Cero invokes directos en todo settings.js
  assert.doesNotMatch(settings, /window\.__TAURI__\.tauri\.invoke/, 'settings: no debe contener window.__TAURI__.tauri.invoke');

  // Bulk también usa los wrappers (PLAN 95/96 intactos)
  const bulkListenerStart = settings.indexOf('"#btn-install-all-deps"');
  assert.ok(bulkListenerStart >= 0, 'settings: falta listener #btn-install-all-deps');
  const bulkListenerEnd = settings.indexOf('\n    });', bulkListenerStart);
  const bulkListener = settings.slice(bulkListenerStart, bulkListenerEnd > bulkListenerStart ? bulkListenerEnd + 8 : settings.length);

  assert.match(bulkListener, /downloadNodeRuntime\(\)/, 'bulk: falta downloadNodeRuntime');
  assert.match(bulkListener, /downloadPythonRuntime\(\)/, 'bulk: falta downloadPythonRuntime');
  assert.match(bulkListener, /downloadSkillRuntime\(\)/, 'bulk: falta downloadSkillRuntime');
  assert.match(bulkListener, /installVivliostyleCli\(\)/, 'bulk: falta installVivliostyleCli');
});

test('Las dependencias administradas sólo están listas si su probe operativo responde', async () => {
  const [runtimes, course, onboarding, settings] = await Promise.all([
    readFile(new URL('src-tauri/src/runtimes.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/course.rs', root), 'utf8'),
    readFile(new URL('src/onboarding.js', root), 'utf8'),
    readFile(new URL('src/pages/settings.js', root), 'utf8'),
  ]);

  // node_version() usa el matcher administrado, soporta stdout/stderr y no hardcodea la versión
  const nodeVerStart = runtimes.indexOf('pub fn node_version()');
  assert.ok(nodeVerStart >= 0, 'falta pub fn node_version()');
  const nodeVerEnd = runtimes.indexOf('\nstatic NODE_RUNTIME_MUTATION_LOCK', nodeVerStart);
  const nodeVerFn = runtimes.slice(nodeVerStart, nodeVerEnd > nodeVerStart ? nodeVerEnd : nodeVerStart + 600);
  assert.match(nodeVerFn, /resolve_node\(\)/, 'node_version: falta resolve_node()');
  assert.match(nodeVerFn, /build_portable_node_version_command/, 'node_version: falta build_portable_node_version_command');
  assert.match(nodeVerFn, /output\.status\.success\(\)/, 'node_version: falta output.status.success()');
  assert.match(nodeVerFn, /output\.stdout\.is_empty\(\)/, 'node_version: falta manejo de stdout vacío');
  assert.match(nodeVerFn, /output\.stderr/, 'node_version: falta fallback a stderr');
  assert.match(nodeVerFn, /node_version_text_matches_expected/, 'node_version: falta matcher de versión exacta');
  assert.doesNotMatch(nodeVerFn, /22\.13\.0/, 'node_version: no debe hardcodear la versión administrada');

  // python_version() usa el matcher administrado, soporta stdout/stderr y no hardcodea la versión
  const pyVerStart = runtimes.indexOf('pub fn python_version()');
  assert.ok(pyVerStart >= 0, 'falta pub fn python_version()');
  const pyVerEnd = runtimes.indexOf('\npub fn download_portable_python', pyVerStart);
  const pyVerFn = runtimes.slice(pyVerStart, pyVerEnd > pyVerStart ? pyVerEnd : pyVerStart + 600);
  assert.match(pyVerFn, /resolve_python\(\)/, 'python_version: falta resolve_python()');
  assert.match(pyVerFn, /build_portable_python_version_command/, 'python_version: falta build_portable_python_version_command');
  assert.match(pyVerFn, /output\.status\.success\(\)/, 'python_version: falta output.status.success()');
  assert.match(pyVerFn, /output\.stdout\.is_empty\(\)/, 'python_version: falta manejo de stdout vacío');
  assert.match(pyVerFn, /output\.stderr/, 'python_version: falta fallback a stderr');
  assert.match(pyVerFn, /python_version_text_matches_expected/, 'python_version: falta matcher de versión exacta');
  assert.doesNotMatch(pyVerFn, /3\.13\.15/, 'python_version: no debe hardcodear la versión administrada');

  // check_dependencies() usa exactamente un probe por runtime, derivando installed de readiness
  const depsStart = course.indexOf('pub fn check_dependencies()');
  assert.ok(depsStart >= 0, 'falta pub fn check_dependencies()');
  const depsEnd = course.indexOf('\npub fn check_dependencies_cached', depsStart);
  const depsFn = course.slice(depsStart, depsEnd > depsStart ? depsEnd : depsStart + 4000);

  // Node: un único probe, readiness, sin presence como autoridad
  const nodeVersionCalls = (depsFn.match(/crate::runtimes::node_version\(\)/g) || []).length;
  assert.strictEqual(nodeVersionCalls, 1, 'check_dependencies: exactamente un probe node_version()');
  assert.match(depsFn, /node_ready\s*=\s*node_version\.is_some\(\)/, 'check_dependencies: node_ready debe derivar de node_version.is_some()');
  assert.match(depsFn, /installed:\s*node_ready/, 'check_dependencies: Node installed debe ser node_ready');
  assert.match(depsFn, /version:\s*node_version,/, 'check_dependencies: Node version debe reutilizar el snapshot');
  assert.doesNotMatch(depsFn, /crate::runtimes::resolve_node\(\)/, 'check_dependencies: no debe usar resolve_node como autoridad de installed');

  // Python: un único probe, readiness, sin presence como autoridad
  const pyVersionCalls = (depsFn.match(/crate::runtimes::python_version\(\)/g) || []).length;
  assert.strictEqual(pyVersionCalls, 1, 'check_dependencies: exactamente un probe python_version()');
  assert.match(depsFn, /python_ready\s*=\s*python_version\.is_some\(\)/, 'check_dependencies: python_ready debe derivar de python_version.is_some()');
  assert.match(depsFn, /installed:\s*python_ready/, 'check_dependencies: Python installed debe ser python_ready');
  assert.match(depsFn, /version:\s*python_version,/, 'check_dependencies: Python version debe reutilizar el snapshot');
  assert.doesNotMatch(depsFn, /crate::runtimes::resolve_python\(\)/, 'check_dependencies: no debe usar resolve_python como autoridad de installed');

  // Vivliostyle: un único probe, readiness, sin presence como autoridad
  const vivVersionCalls = (depsFn.match(/crate::runtimes::vivliostyle_version\(\)/g) || []).length;
  assert.strictEqual(vivVersionCalls, 1, 'check_dependencies: exactamente un probe vivliostyle_version()');
  assert.match(depsFn, /vivliostyle_ready\s*=\s*vivliostyle_version\.is_some\(\)/, 'check_dependencies: vivliostyle_ready debe derivar de vivliostyle_version.is_some()');
  assert.match(depsFn, /installed:\s*vivliostyle_ready/, 'check_dependencies: Vivliostyle installed debe ser vivliostyle_ready');
  assert.match(depsFn, /version:\s*vivliostyle_version,/, 'check_dependencies: Vivliostyle version debe reutilizar el snapshot');
  assert.doesNotMatch(depsFn, /resolve_vivliostyle\(\)\.is_some\(\)/, 'check_dependencies: no debe usar resolve_vivliostyle como autoridad de installed');
  assert.doesNotMatch(depsFn, /portable_vivliostyle_bin\(\)\.is_file\(\)/, 'check_dependencies: no debe usar is_file como autoridad del note Vivliostyle');

  // Jintia Skill: probe operativo via engine (PLAN 101)
  const runJintiaJsonCalls = (depsFn.match(/run_jintia_json/g) || []).length;
  assert.strictEqual(runJintiaJsonCalls, 1, 'check_dependencies: exactamente una llamada a run_jintia_json para Jintia Skill');
  assert.match(depsFn, /skill_version/, 'check_dependencies: debe existir skill_version');
  assert.match(depsFn, /skill_ready\s*=\s*skill_version\.is_some\(\)/, 'check_dependencies: skill_ready debe derivar de skill_version.is_some()');
  assert.match(depsFn, /installed:\s*skill_ready/, 'check_dependencies: Jintia Skill installed debe ser skill_ready');
  assert.match(depsFn, /version:\s*skill_version/, 'check_dependencies: Jintia Skill version debe reutilizar skill_version');
  assert.doesNotMatch(depsFn, /resolve_skill\(\)\.is_some\(\)/, 'check_dependencies: no debe usar resolve_skill().is_some() como autoridad de installed');
  assert.doesNotMatch(depsFn, /note:\s*if crate::runtimes::portable_skill_installed/, 'check_dependencies: note no debe depender de portable_skill_installed()');

  // NotebookLM conserva portable_notebooklm_mcp_installed_for
  assert.match(depsFn, /portable_notebooklm_mcp_installed_for/, 'check_dependencies: NotebookLM debe seguir usando portable_notebooklm_mcp_installed_for');

  // Downstream: onboarding consume installed como autoridad
  assert.match(onboarding, /dep\.required\s*&&\s*!dep\.installed/, 'onboarding: debe filtrar por required && !installed');
  assert.match(onboarding, /\.every\([^)]*d\.installed/, 'onboarding: debe exigir d.installed en todos los required');

  // Downstream: bulk Settings consume !installed para selección de reparación
  assert.match(settings, /!d\.installed/, 'settings: bulk debe seleccionar por !installed');
  assert.match(settings, /BULK_INSTALL_TARGETS\.has\(d\.name\)/, 'settings: bulk debe filtrar por BULK_INSTALL_TARGETS');
});

test('Las descargas eliminan el temporal si falla lectura o escritura del streaming', async () => {
  const runtimes = await readFile(new URL('src-tauri/src/runtimes.rs', root), 'utf8');

  // ── Node ─────────────────────────────────────────────────────────────────────
  const nodeStart = runtimes.indexOf('pub fn download_portable_node(');
  const nodeEnd = runtimes.indexOf('\nfn node_version_text_matches_expected', nodeStart);
  assert.ok(nodeStart >= 0 && nodeEnd > nodeStart, 'download_portable_node no encontrada');
  const nodeDownloader = runtimes.slice(nodeStart, nodeEnd);

  assert.ok(nodeDownloader.includes('let tmp_file'), 'Node: falta let tmp_file');
  assert.ok(nodeDownloader.includes('fs::File::create(&tmp_file)'), 'Node: falta File::create(&tmp_file)');
  assert.ok(nodeDownloader.includes('response.read(&mut buffer)'), 'Node: falta response.read');
  assert.ok(nodeDownloader.includes('file.write_all(&buffer[..n])'), 'Node: falta file.write_all');

  // Write failure: debe existir rama explícita con if let Err (no propagación directa con ?)
  const nodeWFIdx = nodeDownloader.indexOf('if let Err(e) = file.write_all(');
  assert.ok(nodeWFIdx >= 0, 'Node write failure: debe existir if let Err para write_all');

  // Negativo: en el arm Ok(n) no debe existir write_all con propagación directa ?
  const nodeOkNIdx = nodeDownloader.indexOf('Ok(n) =>');
  const nodeReadErrIdx = nodeDownloader.indexOf('Err(e) =>', nodeOkNIdx);
  assert.ok(nodeOkNIdx >= 0, 'Node: falta Ok(n) => en el loop de streaming');
  assert.ok(nodeReadErrIdx > nodeOkNIdx, 'Node: falta Err(e) => en el loop de streaming');
  const nodeOkArm = nodeDownloader.slice(nodeOkNIdx, nodeReadErrIdx);
  assert.doesNotMatch(nodeOkArm, /file\.write_all[\s\S]{1,120}\.map_err[\s\S]{1,80}\?\s*;/, 'Node: write_all en Ok(n) no debe propagar con ? sin cleanup');

  // Write failure — orden obligatorio: drop(file) < remove_file(&tmp_file) < emit "error" < return Err
  const nodeWFSection = nodeDownloader.slice(nodeWFIdx, nodeWFIdx + 400);
  const nWDrop   = nodeWFSection.indexOf('drop(file)');
  const nWRemove = nodeWFSection.indexOf('remove_file(&tmp_file)');
  const nWEmit   = nodeWFSection.indexOf('"error"');
  const nWReturn = nodeWFSection.indexOf('return Err');
  assert.ok(nWDrop   >= 0, 'Node write failure: falta drop(file)');
  assert.ok(nWRemove >= 0, 'Node write failure: falta remove_file(&tmp_file)');
  assert.ok(nWEmit   >= 0, 'Node write failure: falta emit con phase "error"');
  assert.ok(nWReturn >= 0, 'Node write failure: falta return Err');
  assert.ok(nWDrop   < nWRemove, 'Node write failure: drop(file) debe preceder a remove_file');
  assert.ok(nWRemove < nWEmit,   'Node write failure: remove_file debe preceder a emit "error"');
  assert.ok(nWEmit   < nWReturn, 'Node write failure: emit "error" debe preceder a return Err');
  assert.match(nodeWFSection, /Error escribiendo descarga/, 'Node write failure: falta mensaje "Error escribiendo descarga"');

  // Read failure — orden obligatorio: drop(file) < remove_file(&tmp_file) < emit "error" < return Err
  const nodeRFSection = nodeDownloader.slice(nodeReadErrIdx, nodeReadErrIdx + 300);
  const nRDrop   = nodeRFSection.indexOf('drop(file)');
  const nRRemove = nodeRFSection.indexOf('remove_file(&tmp_file)');
  const nREmit   = nodeRFSection.indexOf('"error"');
  const nRReturn = nodeRFSection.indexOf('return Err');
  assert.ok(nRDrop   >= 0, 'Node read failure: falta drop(file)');
  assert.ok(nRRemove >= 0, 'Node read failure: falta remove_file(&tmp_file)');
  assert.ok(nREmit   >= 0, 'Node read failure: falta emit con phase "error"');
  assert.ok(nRReturn >= 0, 'Node read failure: falta return Err');
  assert.ok(nRDrop   < nRRemove, 'Node read failure: drop(file) debe preceder a remove_file');
  assert.ok(nRRemove < nREmit,   'Node read failure: remove_file debe preceder a emit "error"');
  assert.ok(nREmit   < nRReturn, 'Node read failure: emit "error" debe preceder a return Err');

  // ── Python ───────────────────────────────────────────────────────────────────
  const pyStart = runtimes.indexOf('pub fn download_portable_python(');
  const pyEnd = runtimes.indexOf('\nfn emit_python_progress', pyStart);
  assert.ok(pyStart >= 0 && pyEnd > pyStart, 'download_portable_python no encontrada');
  const pyDownloader = runtimes.slice(pyStart, pyEnd);

  assert.ok(pyDownloader.includes('let tmp_archive'), 'Python: falta let tmp_archive');
  assert.ok(pyDownloader.includes('fs::File::create(&tmp_archive)'), 'Python: falta File::create(&tmp_archive)');
  assert.ok(pyDownloader.includes('response.read(&mut buffer)'), 'Python: falta response.read');
  assert.ok(pyDownloader.includes('file.write_all(&buffer[..n])'), 'Python: falta file.write_all');

  // Write failure: debe existir rama explícita con if let Err (no propagación directa con ?)
  const pyWFIdx = pyDownloader.indexOf('if let Err(e) = file.write_all(');
  assert.ok(pyWFIdx >= 0, 'Python write failure: debe existir if let Err para write_all');

  // Negativo: en el arm Ok(n) no debe existir write_all con propagación directa ?
  const pyOkNIdx = pyDownloader.indexOf('Ok(n) =>');
  const pyReadErrIdx = pyDownloader.indexOf('Err(e) =>', pyOkNIdx);
  assert.ok(pyOkNIdx >= 0, 'Python: falta Ok(n) => en el loop de streaming');
  assert.ok(pyReadErrIdx > pyOkNIdx, 'Python: falta Err(e) => en el loop de streaming');
  const pyOkArm = pyDownloader.slice(pyOkNIdx, pyReadErrIdx);
  assert.doesNotMatch(pyOkArm, /file\.write_all[\s\S]{1,120}\.map_err[\s\S]{1,80}\?\s*;/, 'Python: write_all en Ok(n) no debe propagar con ? sin cleanup');

  // Write failure — orden obligatorio: drop(file) < remove_file(&tmp_archive) < emit "error" < return Err
  const pyWFSection = pyDownloader.slice(pyWFIdx, pyWFIdx + 400);
  const pWDrop   = pyWFSection.indexOf('drop(file)');
  const pWRemove = pyWFSection.indexOf('remove_file(&tmp_archive)');
  const pWEmit   = pyWFSection.indexOf('"error"');
  const pWReturn = pyWFSection.indexOf('return Err');
  assert.ok(pWDrop   >= 0, 'Python write failure: falta drop(file)');
  assert.ok(pWRemove >= 0, 'Python write failure: falta remove_file(&tmp_archive)');
  assert.ok(pWEmit   >= 0, 'Python write failure: falta emit con phase "error"');
  assert.ok(pWReturn >= 0, 'Python write failure: falta return Err');
  assert.ok(pWDrop   < pWRemove, 'Python write failure: drop(file) debe preceder a remove_file');
  assert.ok(pWRemove < pWEmit,   'Python write failure: remove_file debe preceder a emit "error"');
  assert.ok(pWEmit   < pWReturn, 'Python write failure: emit "error" debe preceder a return Err');
  assert.match(pyWFSection, /Error escribiendo descarga/, 'Python write failure: falta mensaje "Error escribiendo descarga"');

  // Read failure — orden obligatorio: drop(file) < remove_file(&tmp_archive) < emit "error" < return Err
  const pyRFSection = pyDownloader.slice(pyReadErrIdx, pyReadErrIdx + 300);
  const pRDrop   = pyRFSection.indexOf('drop(file)');
  const pRRemove = pyRFSection.indexOf('remove_file(&tmp_archive)');
  const pREmit   = pyRFSection.indexOf('"error"');
  const pRReturn = pyRFSection.indexOf('return Err');
  assert.ok(pRDrop   >= 0, 'Python read failure: falta drop(file)');
  assert.ok(pRRemove >= 0, 'Python read failure: falta remove_file(&tmp_archive)');
  assert.ok(pREmit   >= 0, 'Python read failure: falta emit con phase "error"');
  assert.ok(pRReturn >= 0, 'Python read failure: falta return Err');
  assert.ok(pRDrop   < pRRemove, 'Python read failure: drop(file) debe preceder a remove_file');
  assert.ok(pRRemove < pREmit,   'Python read failure: remove_file debe preceder a emit "error"');
  assert.ok(pREmit   < pRReturn, 'Python read failure: emit "error" debe preceder a return Err');
});

test('Jintia Skill sólo está lista si contrato instalado y smoke del engine responden', async () => {
  const [course, engine, runtimes, release, onboarding, settings] = await Promise.all([
    readFile(new URL('src-tauri/src/course.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/engine.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/runtimes.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/release.rs', root), 'utf8'),
    readFile(new URL('src/onboarding.js', root), 'utf8'),
    readFile(new URL('src/pages/settings.js', root), 'utf8'),
  ]);

  // ── check_dependencies: snapshot único de contrato ────────────────────────────
  const depsStart = course.indexOf('pub fn check_dependencies()');
  const depsEnd = course.indexOf('\npub fn check_dependencies_cached', depsStart);
  assert.ok(depsStart >= 0, 'falta pub fn check_dependencies()');
  const depsFn = course.slice(depsStart, depsEnd > depsStart ? depsEnd : depsStart + 5000);

  // Exactamente una llamada a managed_mcp_contract()
  const contractCalls = (depsFn.match(/managed_mcp_contract\(\)/g) || []).length;
  assert.strictEqual(contractCalls, 1, 'check_dependencies: debe existir exactamente una llamada a managed_mcp_contract()');

  // El snapshot se usa para Jintia y para NotebookLM
  assert.match(depsFn, /managed_contract/, 'check_dependencies: debe existir snapshot managed_contract');
  assert.match(depsFn, /managed_contract\.as_ref\(\)[\s\S]{0,200}resolve_skill/, 'check_dependencies: skill_version debe partir de managed_contract y resolve_skill');
  assert.match(depsFn, /mcp_installed\s*=\s*managed_contract[\s\S]{0,60}portable_notebooklm_mcp_installed_for/, 'check_dependencies: NotebookLM mcp_installed debe usar el mismo managed_contract');

  // ── Jintia Skill: cálculo de skill_version via engine smoke ──────────────────
  assert.match(depsFn, /skill_version/, 'check_dependencies: debe existir skill_version');
  assert.match(depsFn, /crate::runtimes::resolve_skill\(\)/, 'check_dependencies: skill_version debe usar resolve_skill()');
  assert.match(depsFn, /crate::engine::run_jintia_json/, 'check_dependencies: skill_version debe usar run_jintia_json');
  assert.match(depsFn, /"capabilities"/, 'check_dependencies: smoke debe pasar "capabilities"');
  assert.match(depsFn, /"profiles"/, 'check_dependencies: smoke debe pasar "profiles"');
  assert.match(depsFn, /"--json"/, 'check_dependencies: smoke debe pasar "--json"');
  assert.match(depsFn, /serde_json::Value/, 'check_dependencies: resultado del smoke debe parsearse como serde_json::Value');
  assert.match(depsFn, /jintia_version\.clone\(\)/, 'check_dependencies: versión debe proceder de contract.jintia_version');

  // run_jintia_json aparece exactamente una vez (un solo smoke)
  const smokeCount = (depsFn.match(/run_jintia_json/g) || []).length;
  assert.strictEqual(smokeCount, 1, 'check_dependencies: exactamente un smoke run_jintia_json para Jintia Skill');

  // skill_ready derivado de skill_version
  assert.match(depsFn, /skill_ready\s*=\s*skill_version\.is_some\(\)/, 'check_dependencies: skill_ready debe ser skill_version.is_some()');

  // ── Bloque DependencyStatus de Jintia Skill ───────────────────────────────────
  const jintiaBlockStart = depsFn.indexOf('"Jintia Skill"');
  const vivBlockStart = depsFn.indexOf('"Vivliostyle CLI"');
  assert.ok(jintiaBlockStart >= 0, 'check_dependencies: falta bloque "Jintia Skill"');
  assert.ok(vivBlockStart > jintiaBlockStart, 'check_dependencies: "Vivliostyle CLI" debe aparecer después de "Jintia Skill"');
  const jintiaBlock = depsFn.slice(jintiaBlockStart, vivBlockStart);

  assert.match(jintiaBlock, /installed:\s*skill_ready/, 'Jintia Skill: installed debe ser skill_ready');
  assert.match(jintiaBlock, /version:\s*skill_version/, 'Jintia Skill: version debe ser skill_version');
  assert.match(jintiaBlock, /note:\s*if skill_ready/, 'Jintia Skill: note debe condicionarse a skill_ready');
  assert.doesNotMatch(jintiaBlock, /resolve_skill\(\)\.is_some\(\)/, 'Jintia Skill: no debe usar resolve_skill().is_some() como autoridad de installed');
  assert.doesNotMatch(jintiaBlock, /portable_skill_installed\(\)/, 'Jintia Skill: no debe usar portable_skill_installed() como autoridad del note');
  assert.doesNotMatch(jintiaBlock, /version:\s*None/, 'Jintia Skill: no debe tener version: None');

  // ── No ejecución directa desde course.rs ──────────────────────────────────────
  assert.doesNotMatch(depsFn, /Command::new/, 'check_dependencies: no debe usar Command::new directamente');
  assert.doesNotMatch(depsFn, /managed_node_command/, 'check_dependencies: no debe llamar managed_node_command directamente');
  assert.doesNotMatch(depsFn, /portable_node_exe/, 'check_dependencies: no debe referenciar portable_node_exe');

  // ── Engine Adapter: run_jintia_json delega en run_jintia ─────────────────────
  const jsonFnStart = engine.indexOf('pub fn run_jintia_json');
  assert.ok(jsonFnStart >= 0, 'engine: falta pub fn run_jintia_json');
  const jsonFnEnd = engine.indexOf('\npub fn ', jsonFnStart + 1);
  const jsonFn = engine.slice(jsonFnStart, jsonFnEnd > jsonFnStart ? jsonFnEnd : jsonFnStart + 400);
  assert.match(jsonFn, /run_jintia\(/, 'engine: run_jintia_json debe delegar en run_jintia');
  assert.match(jsonFn, /result\.success/, 'engine: run_jintia_json debe verificar result.success');
  assert.match(jsonFn, /serde_json::from_str/, 'engine: run_jintia_json debe parsear JSON con serde_json::from_str');

  // run_jintia usa la infraestructura administrada (no crea ruta propia)
  const runFnStart = engine.indexOf('pub fn run_jintia(');
  assert.ok(runFnStart >= 0, 'engine: falta pub fn run_jintia');
  const runFnEnd = engine.indexOf('\npub fn ', runFnStart + 1);
  const runFn = engine.slice(runFnStart, runFnEnd > runFnStart ? runFnEnd : runFnStart + 600);
  assert.match(runFn, /runtimes::resolve_node/, 'engine: run_jintia debe usar runtimes::resolve_node');
  assert.match(runFn, /runtimes::managed_node_command/, 'engine: run_jintia debe usar runtimes::managed_node_command');
  assert.match(runFn, /managed_runtime_path/, 'engine: run_jintia debe usar managed_runtime_path');
  assert.match(runFn, /\.output\(\)/, 'engine: run_jintia debe usar .output()');

  // ── release.rs: managed_mcp_contract lee jintia_version del package.json ─────
  const contractFnStart = release.indexOf('pub fn managed_mcp_contract(');
  assert.ok(contractFnStart >= 0, 'release: falta pub fn managed_mcp_contract()');
  assert.match(release, /portable_skill_npm_package_dir\(\)/, 'release: debe usar portable_skill_npm_package_dir()');
  assert.match(release, /managed_mcp_contract_from/, 'release: debe usar managed_mcp_contract_from');

  // parse_managed_mcp_contract obtiene la versión del package y la expone como jintia_version
  const parseFnStart = release.indexOf('fn parse_managed_mcp_contract');
  assert.ok(parseFnStart >= 0, 'release: falta fn parse_managed_mcp_contract');
  const parseFnEnd = release.indexOf('\npub fn ', parseFnStart + 1);
  const parseFn = release.slice(parseFnStart, parseFnEnd > parseFnStart ? parseFnEnd : parseFnStart + 600);
  assert.match(parseFn, /"version"/, 'release: parse_managed_mcp_contract debe leer "version" del package');
  assert.match(parseFn, /jintia_version/, 'release: parse_managed_mcp_contract debe exponer jintia_version');

  // No versión hardcodeada en course.rs para Jintia
  assert.doesNotMatch(depsFn, /11\.\d+\.\d+/, 'check_dependencies: no debe hardcodear versión de Jintia Skill');

  // ── Downstream: una Skill no operativa vuelve al flujo de reparación ──────────
  assert.match(onboarding, /dep\.required\s*&&\s*!dep\.installed/, 'onboarding: filtra por required && !installed');
  assert.match(settings, /!d\.installed/, 'settings: bulk selecciona por !installed');
  assert.match(settings, /BULK_INSTALL_TARGETS\.has\(d\.name\)/, 'settings: bulk filtra por BULK_INSTALL_TARGETS');
});

// ── Tests del módulo onboardingProgress (importable porque no tiene imports Tauri) ──

import { normalizeProgressPayload, withDependencyProgress, DEPENDENCY_EVENTS, applyDependencyProgressPresentation } from '../src/onboardingProgress.js';

test('normaliza mensajes y porcentajes del progreso de dependencias', () => {
  // Fases conocidas → etiquetas en español
  assert.equal(normalizeProgressPayload({ phase: 'downloading', percent: 50 }).message, 'Descargando…');
  assert.equal(normalizeProgressPayload({ phase: 'verifying' }).message, 'Verificando…');
  assert.equal(normalizeProgressPayload({ phase: 'extracting' }).message, 'Extrayendo…');
  assert.equal(normalizeProgressPayload({ phase: 'validating' }).message, 'Validando…');
  assert.equal(normalizeProgressPayload({ phase: 'activating' }).message, 'Activando…');
  assert.equal(normalizeProgressPayload({ phase: 'done' }).message, 'Listo');
  assert.equal(normalizeProgressPayload({ phase: 'error' }).message, 'Error');

  // message explícito tiene prioridad sobre phase
  assert.equal(normalizeProgressPayload({ message: 'Texto custom', phase: 'downloading' }).message, 'Texto custom');

  // Porcentaje válido
  assert.equal(normalizeProgressPayload({ percent: 50 }).percent, 50);
  // Límite inferior: negativo → 0
  assert.equal(normalizeProgressPayload({ percent: -5 }).percent, 0);
  // Límite superior: mayor de 100 → 100
  assert.equal(normalizeProgressPayload({ percent: 150 }).percent, 100);
  // No numérico → null
  assert.equal(normalizeProgressPayload({ percent: 'rápido' }).percent, null);
  // NaN → null
  assert.equal(normalizeProgressPayload({ percent: NaN }).percent, null);
  // Infinito → null
  assert.equal(normalizeProgressPayload({ percent: Infinity }).percent, null);
  // Payload nulo → ambos null
  assert.deepEqual(normalizeProgressPayload(null), { message: null, percent: null });
  // Mensaje en blanco → null
  assert.equal(normalizeProgressPayload({ message: '   ' }).message, null);
});

test('DEPENDENCY_EVENTS mapea exactamente Node.js, Python y Jintia Skill', () => {
  assert.equal(DEPENDENCY_EVENTS['Node.js'], 'node-download-progress');
  assert.equal(DEPENDENCY_EVENTS['Python'], 'python-download-progress');
  assert.equal(DEPENDENCY_EVENTS['Jintia Skill'], 'skill-download-progress');
  // Vivliostyle y NotebookLM no tienen evento (feedback indeterminado)
  assert.equal(DEPENDENCY_EVENTS['Vivliostyle CLI'], undefined);
  assert.equal(DEPENDENCY_EVENTS['NotebookLM MCP'], undefined);
});

test('se suscribe antes de instalar y libera el listener al terminar (éxito)', async () => {
  const order = [];
  const fakeListen = async (event, _cb) => {
    order.push(`subscribed:${event}`);
    return () => order.push(`unsubscribed:${event}`);
  };
  const fakeOperation = async () => { order.push('operation'); return { success: true }; };

  await withDependencyProgress('Node.js', fakeListen, fakeOperation, () => {});

  assert.deepEqual(order, [
    'subscribed:node-download-progress',
    'operation',
    'unsubscribed:node-download-progress',
  ]);
});

test('se suscribe antes de instalar y libera el listener al terminar (excepción)', async () => {
  const order = [];
  const fakeListen = async (event, _cb) => {
    order.push(`subscribed:${event}`);
    return () => order.push(`unsubscribed:${event}`);
  };
  const fakeOperation = async () => { order.push('operation'); throw new Error('fallo de red'); };

  await assert.rejects(() => withDependencyProgress('Python', fakeListen, fakeOperation, () => {}));

  assert.deepEqual(order, [
    'subscribed:python-download-progress',
    'operation',
    'unsubscribed:python-download-progress',
  ]);
});

test('una dependencia sin evento conserva progreso indeterminado', async () => {
  let subscribed = false;
  const fakeListen = async () => { subscribed = true; return () => {}; };
  const fakeOperation = async () => ({ success: true });

  await withDependencyProgress('Vivliostyle CLI', fakeListen, fakeOperation, () => {});

  assert.equal(subscribed, false, 'no debe suscribirse para dependencias sin evento Tauri');
});

test('fallo al suscribirse: la instalación sigue con feedback genérico', async () => {
  let operationRan = false;
  const fakeListen = async () => { throw new Error('listen no disponible'); };
  const fakeOperation = async () => { operationRan = true; return { success: true }; };

  const result = await withDependencyProgress('Node.js', fakeListen, fakeOperation, () => {});

  assert.ok(operationRan, 'la operación debe ejecutarse aunque listen() falle');
  assert.equal(result.success, true);
});

test('el reporter recibe payload normalizado al dispararse el evento', async () => {
  const received = [];
  let capturedCallback;

  const fakeListen = async (_event, cb) => {
    capturedCallback = cb;
    return () => {};
  };
  const fakeOperation = async () => {
    capturedCallback({ payload: { phase: 'downloading', percent: 42 } });
    capturedCallback({ payload: { phase: 'extracting', percent: 'x' } });
    return { success: true };
  };

  await withDependencyProgress('Node.js', fakeListen, fakeOperation, (p) => received.push(p));

  assert.deepEqual(received[0], { message: 'Descargando…', percent: 42 });
  assert.deepEqual(received[1], { message: 'Extrayendo…', percent: null });
});

test('el onboarding presenta el error terminal y permite reintentar', async () => {
  const source = await readFile(new URL('src/onboarding.js', root), 'utf8');
  // Excepción capturada y convertida en resultado de error
  assert.match(source, /catch\s*\(e\)[\s\S]{0,120}?result\s*=\s*\{\s*success:\s*false/);
  // renderCurrentStep() restaura la acción de reintento tras el error
  const fnStart = source.indexOf('async function performDependencyInstall');
  const fnEnd = source.indexOf('\n}', fnStart);
  const fn = source.slice(fnStart, fnEnd);
  assert.match(fn, /renderCurrentStep\(\)/);
  assert.match(fn, /checkDependencies\(\)/);
});

test('el onboarding usa progreso real del backend: sin simulación de porcentajes', async () => {
  const [onboarding, progress] = await Promise.all([
    readFile(new URL('src/onboarding.js', root), 'utf8'),
    readFile(new URL('src/onboardingProgress.js', root), 'utf8'),
  ]);
  // Usa el módulo de progreso
  assert.match(onboarding, /withDependencyProgress/);
  assert.match(onboarding, /from.*onboardingProgress/);
  // No inventa porcentajes con temporizadores
  assert.doesNotMatch(onboarding, /setInterval[\s\S]{0,200}percent/);
  assert.doesNotMatch(progress, /setInterval/);
  assert.doesNotMatch(progress, /fakePercent|simulatedPercent/);
  // Suscripción anterior al comando
  assert.match(progress, /unlisten\s*=\s*await\s*listen/);
  assert.match(progress, /return\s*await\s*operation\(\)/);
  // Limpieza en finally
  assert.match(progress, /finally[\s\S]{0,60}?unlisten\?\.\(\)/);
});

// ── Tests de transición determinado ↔ indeterminado (función productiva) ─────

function makeFakeElements() {
  function fakeEl(initialDisplay = '') {
    return {
      style: { display: initialDisplay },
      _attrs: {},
      setAttribute(k, v) { this._attrs[k] = v; },
      removeAttribute(k) { delete this._attrs[k]; },
      getAttribute(k) { return this._attrs[k]; },
    };
  }
  return {
    track: fakeEl(''),
    barWrap: fakeEl('none'),
    barFill: fakeEl(''),
  };
}

test('la función productiva cambia de determinada a indeterminada', () => {
  const { track, barWrap, barFill } = makeFakeElements();

  // Primera llamada: modo determinado al 100 %
  applyDependencyProgressPresentation({ track, barWrap, barFill, message: 'Descargando…', percent: 100 });
  assert.equal(barWrap.style.display, '', 'barra debe ser visible al 100 %');
  assert.equal(barFill.style.width, '100%');
  assert.equal(track.style.display, 'none', 'indicador debe estar oculto al 100 %');
  assert.equal(barWrap.getAttribute('role'), 'progressbar');
  assert.equal(barWrap.getAttribute('aria-valuenow'), '100');
  assert.equal(track.getAttribute('aria-valuenow'), undefined, 'track no debe tener aria-valuenow en modo determinado');

  // Segunda llamada: modo indeterminado
  applyDependencyProgressPresentation({ track, barWrap, barFill, message: 'Instalando Vivliostyle CLI…', percent: null });
  assert.equal(barWrap.style.display, 'none', 'barra debe ocultarse');
  assert.equal(barFill.style.width, '0%', 'fill debe resetearse');
  assert.equal(track.style.display, '', 'indicador debe reaparecer');
  assert.equal(track.getAttribute('role'), 'status');
  assert.equal(barWrap.getAttribute('role'), undefined, 'barWrap no debe tener role en modo indeterminado');
  assert.equal(barWrap.getAttribute('aria-valuenow'), undefined, 'barWrap no debe tener aria-valuenow en indeterminado');
  assert.equal(track.getAttribute('aria-valuenow'), undefined, 'track no debe tener aria-valuenow en indeterminado');
});

test('cero por ciento sigue siendo progreso determinado', () => {
  const { track, barWrap, barFill } = makeFakeElements();

  applyDependencyProgressPresentation({ track, barWrap, barFill, message: 'Iniciando…', percent: 0 });
  assert.equal(barWrap.style.display, '', 'porcentaje 0 debe mostrar la barra (modo determinado)');
  assert.equal(barFill.style.width, '0%');
  assert.equal(track.style.display, 'none', 'indicador debe estar oculto');
  assert.equal(barWrap.getAttribute('role'), 'progressbar');
  assert.equal(barWrap.getAttribute('aria-valuenow'), '0');
});

test('los atributos determinados pertenecen únicamente a la barra visible', () => {
  const { track, barWrap, barFill } = makeFakeElements();

  applyDependencyProgressPresentation({ track, barWrap, barFill, message: 'Descargando…', percent: 42 });
  // aria-value* en barWrap
  assert.equal(barWrap.getAttribute('aria-valuemin'), '0');
  assert.equal(barWrap.getAttribute('aria-valuemax'), '100');
  assert.equal(barWrap.getAttribute('aria-valuenow'), '42');
  // track NO debe tener aria-value*
  assert.equal(track.getAttribute('aria-valuenow'), undefined);
  assert.equal(track.getAttribute('aria-valuemin'), undefined);
  assert.equal(track.getAttribute('aria-valuemax'), undefined);

  // Al volver a indeterminado, barWrap pierde sus atributos
  applyDependencyProgressPresentation({ track, barWrap, barFill, message: null, percent: null });
  assert.equal(barWrap.getAttribute('aria-valuenow'), undefined);
  assert.equal(barWrap.getAttribute('aria-valuemin'), undefined);
  assert.equal(barWrap.getAttribute('aria-valuemax'), undefined);
});

test('Node cambia a progreso indeterminado antes de instalar Vivliostyle', async () => {
  const source = await readFile(new URL('src/onboarding.js', root), 'utf8');
  const fnStart = source.indexOf('async function performDependencyInstall');
  const fnEnd = source.indexOf('\nasync function installDisciplinePackages', fnStart);
  const fn = source.slice(fnStart, fnEnd);

  // El reporter debe llamarse con percent: null antes de installVivliostyleCli
  const reporterCallIdx = fn.indexOf("reporter({ message:");
  const vivliostyleIdx = fn.indexOf('installVivliostyleCli');
  assert.ok(reporterCallIdx >= 0, 'debe existir llamada a reporter antes de Vivliostyle');
  assert.ok(reporterCallIdx < vivliostyleIdx, 'reporter(null) debe preceder a installVivliostyleCli');
  assert.match(fn, /reporter\(\{\s*message:[\s\S]{0,60}?percent:\s*null[\s\S]{0,10}?\}[\s\S]{0,250}?installVivliostyleCli/);
});

test('Python cambia a progreso indeterminado antes de instalar paquetes del perfil', async () => {
  const source = await readFile(new URL('src/onboarding.js', root), 'utf8');
  const fnStart = source.indexOf('async function performDependencyInstall');
  const fnEnd = source.indexOf('\nasync function installDisciplinePackages', fnStart);
  const fn = source.slice(fnStart, fnEnd);

  // La rama Python debe reportar percent: null antes de installDisciplinePackages
  assert.match(
    fn,
    /Python[\s\S]{0,300}?reporter\(\{\s*message:[\s\S]{0,80}?percent:\s*null[\s\S]{0,20}?\}[\s\S]{0,200}?installDisciplinePackages/,
    'Python debe reportar fase indeterminada antes de instalar paquetes del perfil'
  );
});

// ── Tests de propagación de fallos en instalaciones compuestas ────────────────

import { runSecondaryStage, normalizeProfileInstallResult } from '../src/onboardingInstall.js';
import { runOperationWithFeedback } from '../src/onboardingOperation.js';

test('no ejecuta la etapa secundaria cuando la primaria falla', async () => {
  let secondaryCalls = 0;
  const primary = { success: false, message: 'descarga falló' };
  const result = await runSecondaryStage(primary, async () => { secondaryCalls++; return { success: true, message: 'ok' }; });
  assert.equal(secondaryCalls, 0, 'la secundaria no debe ejecutarse si la primaria falló');
  assert.deepEqual(result, primary, 'el resultado debe ser exactamente el fallo primario');
});

test('propaga el ActionResult fallido de Vivliostyle', async () => {
  const primary = { success: true, message: 'Node instalado.' };
  const vivliostyleFailure = { success: false, message: 'Vivliostyle CLI: error al instalar' };
  const result = await runSecondaryStage(primary, async () => vivliostyleFailure);
  assert.equal(result.success, false);
  assert.equal(result.message, vivliostyleFailure.message, 'el mensaje del fallo secundario debe dominar');
});

test('conserva éxito únicamente cuando ambas etapas terminan correctamente', async () => {
  let secondaryCalls = 0;
  const primary = { success: true, message: 'Node instalado.' };
  const result = await runSecondaryStage(primary, async () => { secondaryCalls++; return { success: true, message: 'Vivliostyle ok.' }; });
  assert.equal(secondaryCalls, 1, 'la secundaria debe ejecutarse exactamente una vez');
  assert.equal(result.success, true);
  assert.deepEqual(result, primary, 'el resultado primario debe conservarse cuando ambas tienen éxito');
});

test('normaliza un error de paquetes del perfil', () => {
  const profileResultPython = {
    discipline: 'CS', profileId: 'cs-1',
    pythonPackages: ['pkg'], nodePackages: [],
    failedStage: 'python', error: 'pip salió con código 1',
  };
  const result = normalizeProfileInstallResult(profileResultPython);
  assert.equal(result.success, false);
  assert.ok(result.message.includes('python'), 'el mensaje debe identificar la etapa fallida');
  assert.ok(result.message.includes('pip salió con código 1'), 'el mensaje debe incluir el error original');

  const profileResultNode = {
    discipline: 'CS', profileId: 'cs-1',
    pythonPackages: [], nodePackages: ['pkg'],
    failedStage: 'node', error: 'npm error',
  };
  const result2 = normalizeProfileInstallResult(profileResultNode);
  assert.equal(result2.success, false);
  assert.ok(result2.message.includes('node'));

  // Resultado exitoso (sin error)
  const successProfile = { discipline: 'CS', profileId: 'cs-1', pythonPackages: [], nodePackages: [] };
  const ok = normalizeProfileInstallResult(successProfile);
  assert.equal(ok.success, true);
});

test('performDependencyInstall usa el resultado compuesto antes del toast terminal', async () => {
  const source = await readFile(new URL('src/onboarding.js', root), 'utf8');
  const fnStart = source.indexOf('async function performDependencyInstall');
  const fnEnd = source.indexOf('\nasync function installDisciplinePackages', fnStart);
  const fn = source.slice(fnStart, fnEnd);

  // runSecondaryStage aparece antes del toast terminal
  const secondaryIdx = fn.indexOf('runSecondaryStage');
  const toastTerminalIdx = fn.indexOf('toast(result.message');
  assert.ok(secondaryIdx >= 0, 'performDependencyInstall debe llamar a runSecondaryStage');
  assert.ok(secondaryIdx < toastTerminalIdx, 'runSecondaryStage debe preceder al toast terminal');

  // El resultado de la secundaria se asigna a result antes del toast
  assert.match(fn, /result\s*=\s*await\s*runSecondaryStage/);

  // Vivliostyle siempre asignado, nunca descartado
  const nodeBlock = fn.slice(fn.indexOf('"Node.js"'), fn.indexOf('"Python"'));
  assert.match(nodeBlock, /result\s*=\s*await\s*runSecondaryStage[\s\S]{0,100}?installVivliostyleCli/);

  // Paquetes del perfil siempre asignados, nunca descartados
  const pythonBlock = fn.slice(fn.indexOf('"Python"'), fn.indexOf('"Vivliostyle CLI"'));
  assert.match(pythonBlock, /result\s*=\s*await\s*runSecondaryStage[\s\S]{0,150}?installDisciplinePackages/);
});

// ── Tests del ejecutor con feedback para rechazos inesperados ─────────────────

test('devuelve sin cambios el resultado exitoso', async () => {
  let errorCalls = 0;
  let settledCalls = 0;
  const expected = { success: true, message: 'operación completada' };

  const result = await runOperationWithFeedback(
    async () => expected,
    { onError: () => errorCalls++, onSettled: () => settledCalls++ }
  );

  assert.deepEqual(result, expected);
  assert.equal(errorCalls, 0, 'onError no debe invocarse en el camino exitoso');
  assert.equal(settledCalls, 1, 'onSettled debe invocarse exactamente una vez');
});

test('convierte Error rechazado en feedback terminal', async () => {
  let errorMsg = null;
  let settledCalls = 0;

  const result = await runOperationWithFeedback(
    async () => { throw new Error('sin conexión'); },
    { onError: (m) => { errorMsg = m; }, onSettled: () => settledCalls++ }
  );

  assert.equal(result.success, false);
  assert.ok(errorMsg?.includes('sin conexión'), `onError debe recibir el mensaje del Error; recibió: ${errorMsg}`);
  assert.equal(settledCalls, 1, 'onSettled debe invocarse exactamente una vez');
});

test('normaliza strings, objetos y rechazos vacíos', async () => {
  const FALLBACK = 'No se pudo completar la operación.';

  async function collectBoth(throwValue) {
    let errorMsg = null;
    let settledCalls = 0;
    const result = await runOperationWithFeedback(
      async () => { throw throwValue; },
      { onError: (m) => { errorMsg = m; }, onSettled: () => settledCalls++ }
    );
    return { errorMsg, result, settledCalls };
  }

  // String rechazado → conservado
  assert.equal((await collectBoth('timeout de red')).errorMsg, 'timeout de red');
  // Objeto con message → conservado
  assert.equal((await collectBoth({ message: 'acceso denegado' })).errorMsg, 'acceso denegado');
  // null → fallback
  assert.equal((await collectBoth(null)).errorMsg, FALLBACK);
  // undefined → fallback
  assert.equal((await collectBoth(undefined)).errorMsg, FALLBACK);

  // Error con mensaje vacío → fallback
  assert.equal((await collectBoth(new Error(''))).errorMsg, FALLBACK, 'new Error("") debe usar el fallback');
  // Error con solo espacios → fallback
  assert.equal((await collectBoth(new Error('   '))).errorMsg, FALLBACK, 'new Error("   ") debe usar el fallback');
  // Error con mensaje con espacios extremos → trimado
  assert.equal((await collectBoth(new Error('  conexión perdida  '))).errorMsg, 'conexión perdida');
  // String vacío → fallback
  assert.equal((await collectBoth('')).errorMsg, FALLBACK);
  // String con solo espacios → fallback
  assert.equal((await collectBoth('   ')).errorMsg, FALLBACK);
  // Objeto con message vacía → fallback
  assert.equal((await collectBoth({ message: '' })).errorMsg, FALLBACK);
  // Objeto con message con solo espacios → fallback
  assert.equal((await collectBoth({ message: '   ' })).errorMsg, FALLBACK);

  // El mensaje en onError coincide con el de ActionResult
  const { errorMsg, result } = await collectBoth(new Error('fallo de red'));
  assert.equal(result.success, false);
  assert.equal(result.message, errorMsg, 'onError y ActionResult deben usar el mismo mensaje');

  // onSettled se ejecuta exactamente una vez en cada rechazo
  const { settledCalls } = await collectBoth(new Error('x'));
  assert.equal(settledCalls, 1);

  // Ningún mensaje debe contener stack
  const { errorMsg: msgWithStack } = await collectBoth(new Error('fallo'));
  assert.doesNotMatch(msgWithStack, /Error:|at\s+\w/, 'el mensaje no debe exponer el stack trace');
});

test('no confunde ActionResult fallido con una excepción', async () => {
  let errorCalls = 0;
  const actionResult = { success: false, message: 'credenciales inválidas' };

  const result = await runOperationWithFeedback(
    async () => actionResult,
    { onError: () => errorCalls++, onSettled: () => {} }
  );

  assert.deepEqual(result, actionResult, 'el ActionResult debe devolverse intacto');
  assert.equal(errorCalls, 0, 'onError no debe invocarse para un ActionResult fallido normal');
});

test('runOnboardingOperation integra error y restauración', async () => {
  const source = await readFile(new URL('src/onboarding.js', root), 'utf8');
  const fnStart = source.indexOf('async function runOnboardingOperation');
  const fnEnd = source.indexOf('\n}', fnStart);
  const fn = source.slice(fnStart, fnEnd);

  // Usa el ejecutor productivo
  assert.match(fn, /runOperationWithFeedback/);
  // onError dirige el mensaje a toast con "error"
  assert.match(fn, /onError[\s\S]{0,80}?toast[\s\S]{0,60}?["']error["']/);
  // onSettled restablece las tres variables/estados
  assert.match(fn, /onSettled[\s\S]{0,200}?onboardingActionInFlight\s*=\s*false/);
  assert.match(fn, /onSettled[\s\S]{0,200}?onboardingBusyMessage\s*=\s*["']["']/);
  assert.match(fn, /onSettled[\s\S]{0,200}?syncOnboardingBusyState/);
});
