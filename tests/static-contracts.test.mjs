import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('Jintia es la identidad canónica en la aplicación y los instaladores', async () => {
  const [main, onboarding, html, tauriText, appPackageText, brandText, paths, payload] = await Promise.all([
    readFile(new URL('src/main.js', root), 'utf8'),
    readFile(new URL('src/onboarding.js', root), 'utf8'),
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('src-tauri/tauri.conf.json', root), 'utf8'),
    readFile(new URL('package.json', root), 'utf8'),
    readFile(new URL('src/brand.json', root), 'utf8'),
    readFile(new URL('src-tauri/src/paths.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/payload.rs', root), 'utf8'),
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
  assert.match(payload, /jintia-skill-\{managed_version\}\.zip/);
  assert.doesNotMatch(payload, /legacy_skill_dir|instructional-designer-skill/);
});

test('la instalación de Jintia Skill usa únicamente la ruta canónica', async () => {
  const [paths, payload] = await Promise.all([
    readFile(new URL('src-tauri/src/paths.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/payload.rs', root), 'utf8'),
  ]);
  assert.match(paths, /pub fn skill_dir[\s\S]*\.join\("jintia-skill"\)/);
  const installedStart = paths.indexOf('pub fn installed_skill_dir()');
  const installedEnd = paths.indexOf('\npub fn ', installedStart + 1);
  const installedFn = paths.slice(installedStart, installedEnd < 0 ? paths.length : installedEnd);
  assert.match(installedFn, /skill_dir\(\)/);
  assert.doesNotMatch(installedFn, /SKILL\.md|legacy|instructional-designer/);
  assert.doesNotMatch(`${paths}\n${payload}`, /instructional-designer-skill/);
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
  assert.match(spawnFn, /Command::new\(&managed\.node\)/);
  assert.match(spawnFn, /\.arg\(&managed\.bin\)/);
  assert.doesNotMatch(`${paths}\n${runtimes}\n${mcp}`, /dist\/(?:index|cli)\.js|patchright|\.local-browsers|PLAYWRIGHT_BROWSERS_PATH/);
});

test('la arquitectura separa la app de escritorio y el paquete instalable de la skill', async () => {
  const [payload, config, build, windowsWorkflow, macosWorkflow] = await Promise.all([
    readFile(new URL('src-tauri/src/payload.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/config.rs', root), 'utf8'),
    readFile(new URL('src-tauri/build.rs', root), 'utf8'),
    readFile(new URL('.github/workflows/release-windows.yml', root), 'utf8'),
    readFile(new URL('.github/workflows/release-macos.yml', root), 'utf8'),
  ]);
  assert.doesNotMatch(payload, /\$OUT_DIR\/jintia-skill/);
  assert.match(config, /portable_skill_source_dir/);
  assert.match(config, /themes/);
  assert.match(build, /tauri_build::build/);
  assert.doesNotMatch(build, /skill\.lock\.json|jintia-release-manifest|NOTEBOOKLM_MCP_|skill_release\.rs/);

  for (const source of [payload, config, build, windowsWorkflow, macosWorkflow]) {
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

  assert.doesNotMatch(workflow, /npm run skill:verify|check-skill-release/);
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
  assert.equal(pkg.scripts['skill:verify'], undefined);
  assert.equal(pkg.scripts['skill:sync'], undefined);
  for (const workflow of [ci, windows, macos]) {
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

test('la instalación Claude delega en Jintia y payload conserva sólo consumidores compartidos', async () => {
  const [payload, toolchain, lib] = await Promise.all([
    readFile(new URL('src-tauri/src/payload.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/toolchain.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/lib.rs', root), 'utf8'),
  ]);
  assert.doesNotMatch(payload, /pub fn install_local_skill|fn portable_skill_src|fn installed_portable_matches/);
  assert.doesNotMatch(payload, /\.jintia-skill\.stage-|jintia-skill\.backup-/);
  for (const symbol of ['read_skill_package_version', 'install_openai_plugin', 'export_skill_zip', 'export_openai_plugin_zip', 'installed_skill_version', 'sync_user_config_to_install']) {
    assert.match(payload, new RegExp(symbol));
  }
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

test('el plugin ChatGPT Codex se instala desde el paquete npm administrado', async () => {
  const payload = await readFile(new URL('src-tauri/src/payload.rs', root), 'utf8');
  const sourceStart = payload.indexOf('fn portable_openai_plugin_sources(');
  const sourceEnd = payload.indexOf('\nfn materialize_openai_plugin_from_portable(', sourceStart);
  const sourceFn = payload.slice(sourceStart, sourceEnd);
  const installStart = payload.indexOf('pub fn install_openai_plugin()');
  const installEnd = payload.indexOf('\nfn copy_dir_all(', installStart);
  const installFn = payload.slice(installStart, installEnd);
  const materializeStart = payload.indexOf('fn materialize_openai_plugin_from_portable(');
  const materializeEnd = payload.indexOf('\nfn openai_plugin_portable_matches(', materializeStart);
  const materializeFn = payload.slice(materializeStart, materializeEnd);
  const currentStart = payload.indexOf('pub fn openai_plugin_is_current()');
  const currentEnd = payload.indexOf('\npub fn openai_plugin_path()', currentStart);
  const currentFn = payload.slice(currentStart, currentEnd);
  const sourceIndex = installFn.indexOf('portable_openai_plugin_sources');
  const stageIndex = installFn.indexOf('.jintia-plugin.stage-');

  assert.match(sourceFn, /portable_skill_npm_package_dir/);
  assert.match(sourceFn, /openai-plugin/);
  assert.match(sourceFn, /skill/);
  assert.match(sourceFn, /\.codex-plugin/);
  assert.match(sourceFn, /plugin\.json/);
  assert.match(sourceFn, /\.mcp\.json/);
  assert.match(sourceFn, /README\.md/);
  assert.match(sourceFn, /package\.json/);
  assert.match(sourceFn, /version/);
  assert.match(installFn, /portable_openai_plugin_sources/);
  assert.match(installFn, /openai_plugin_portable_matches/);
  assert.match(installFn, /register_openai_marketplace/);
  assert.match(installFn, /\.jintia-plugin\.stage-/);
  assert.match(installFn, /jintia\.backup-/);
  assert.match(installFn, /fs::rename/);
  assert.match(installFn, /managed_version/);
  assert.doesNotMatch(installFn, /materialize_payload|OPENAI_PLUGIN_MANIFEST|OPENAI_PLUGIN_MCP|OPENAI_PLUGIN_README|SKILL_VERSION|openai_plugin_payload_matches/);
  assert.ok(sourceIndex >= 0 && sourceIndex < stageIndex);
  assert.match(installFn.slice(sourceIndex, stageIndex), /None\s*=>[\s\S]*return ActionResult::error/);
  assert.match(materializeFn, /copy_dir_all/);
  assert.match(materializeFn, /skills/);
  assert.match(materializeFn, /jintia-skill/);
  assert.match(materializeFn, /user_config/);
  assert.match(materializeFn, /institution\.json/);
  assert.match(materializeFn, /notebooks\.json/);
  assert.doesNotMatch(materializeFn, /materialize_payload|OPENAI_PLUGIN_/);
  assert.match(currentFn, /openai_plugin_portable_matches/);
  assert.doesNotMatch(currentFn, /openai_plugin_payload_matches|installed_payload_matches/);
  assert.match(payload, /"name": "jintia"/);
  assert.match(payload, /"source": "local"/);
  assert.match(payload, /\.\/\.codex\/plugins\/jintia/);
  assert.match(payload, /"installation": "AVAILABLE"/);
});

test('la exportación del plugin OpenAI usa Jintia npm administrado', async () => {
  const payload = await readFile(new URL('src-tauri/src/payload.rs', root), 'utf8');
  const start = payload.indexOf('pub fn export_openai_plugin_zip(');
  const end = payload.indexOf('\npub fn record_export(', start);
  const exportFn = payload.slice(start, end);
  const helperStart = payload.indexOf('fn add_fs_dir_to_zip(');
  const helperEnd = payload.indexOf('\nfn portable_skill_export_source(', helperStart);
  const helper = payload.slice(helperStart, helperEnd);

  assert.match(exportFn, /portable_openai_plugin_sources/);
  assert.match(exportFn, /wrapper_src/);
  assert.match(exportFn, /skill_src/);
  assert.match(exportFn, /managed_version/);
  assert.match(exportFn, /skills/);
  assert.match(exportFn, /jintia-skill/);
  assert.match(exportFn, /user_config/);
  assert.match(exportFn, /institution\.json/);
  assert.match(exportFn, /notebooks\.json/);
  assert.match(exportFn, /files_equal/);
  assert.doesNotMatch(exportFn, /SKILL_VERSION|OPENAI_PLUGIN_MANIFEST|OPENAI_PLUGIN_MCP|OPENAI_PLUGIN_README|SKILL_MD|SKILL_PACKAGE_JSON|REQUIREMENTS|REFERENCES|SCRIPTS|RUNTIME|THEMES|CONFIG|AGENTS|COMMANDS|BIN|RULES|SCHEMAS|add_dir_to_zip/);
  assert.match(exportFn, /jintia-openai-plugin-\{managed_version\}\.zip/);
  assert.match(helper, /fs::read_dir/);
  assert.match(helper, /file_type/);
  assert.match(helper, /sort/);
  assert.match(helper, /add_bytes/);
  assert.match(helper, /is_dir/);
  assert.match(helper, /is_file/);
  assert.match(helper, /is_symlink/);
  assert.doesNotMatch(payload, /OPENAI_PLUGIN_MANIFEST|OPENAI_PLUGIN_MCP|OPENAI_PLUGIN_README/);
});

test('la exportación manual de Skill usa Jintia npm administrado', async () => {
  const payload = await readFile(new URL('src-tauri/src/payload.rs', root), 'utf8');
  const sourceStart = payload.indexOf('fn portable_skill_export_source(');
  const sourceEnd = payload.indexOf('\nfn file_fingerprint(', sourceStart);
  const sourceFn = payload.slice(sourceStart, sourceEnd);
  const exportStart = payload.indexOf('pub fn export_skill_zip(');
  const exportEnd = payload.indexOf('\npub fn export_openai_plugin_zip(', exportStart);
  const exportFn = payload.slice(exportStart, exportEnd);
  const fingerprintStart = payload.indexOf('fn file_fingerprint(');
  const fingerprintEnd = payload.indexOf('\nfn files_equal(', fingerprintStart);
  const fingerprintFn = payload.slice(fingerprintStart, fingerprintEnd);

  assert.match(sourceFn, /portable_skill_npm_package_dir/);
  assert.match(sourceFn, /skill/);
  assert.match(sourceFn, /package\.json/);
  assert.match(sourceFn, /SKILL\.md/);
  assert.match(sourceFn, /bin/);
  assert.match(sourceFn, /jintia\.js/);
  assert.match(sourceFn, /read_skill_package_version/);
  assert.match(sourceFn, /package_version/);
  assert.match(sourceFn, /skill_version/);
  assert.match(exportFn, /portable_skill_export_source/);
  assert.match(exportFn, /skill_src/);
  assert.match(exportFn, /managed_version/);
  assert.match(exportFn, /add_fs_dir_to_zip/);
  assert.match(exportFn, /user_config/);
  assert.match(exportFn, /institution\.json/);
  assert.match(exportFn, /notebooks\.json/);
  assert.match(exportFn, /files_equal/);
  assert.match(exportFn, /file_fingerprint/);
  assert.match(exportFn, /record_export/);
  assert.doesNotMatch(exportFn, /SKILL_VERSION|SKILL_MD|LICENSE|REQUIREMENTS|SKILL_PACKAGE_JSON|REFERENCES|SCRIPTS|RUNTIME|THEMES|CONFIG|AGENTS|COMMANDS|BIN|RULES|SCHEMAS|add_dir_to_zip|payload_fingerprint|export_record_matches|"VERSION"/);
  assert.match(exportFn, /jintia-skill-\{managed_version\}\.zip/);
  assert.match(fingerprintFn, /fs::read/);
  assert.match(fingerprintFn, /DefaultHasher/);
  assert.match(fingerprintFn, /hash/);
  assert.match(fingerprintFn, /finish/);
  assert.doesNotMatch(fingerprintFn, /SKILL_VERSION|SKILL_MD|REFERENCES/);
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
    /installed:\s*crate::runtimes::resolve_vivliostyle\(\)\.is_some\(\)/
  );

  assert.match(
    course,
    /version:\s*crate::runtimes::vivliostyle_version\(\)/
  );

  assert.doesNotMatch(
    course,
    /installed:\s*command_exists\("vivliostyle"\)/
  );
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
  const start = source.indexOf('function connectStep');
  const end = source.indexOf('function finalStep', start);
  const connect = source.slice(start, end);
  assert.match(connect, /id: "claude-code",\s*title: "Usar con Claude"/);
  assert.match(connect, /id: "openai",\s*title: "Usar con ChatGPT y Codex"/);
  assert.match(connect, /id: "claude-cowork",\s*title: "Usar solo en la app de Claude"/);
  assert.match(connect, /id: "both",\s*title: "Usar en todos"/);
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
  assert.match(final, /"claude-cowork":\s*\[/);
  assert.match(final, /Archivo exportado/);
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
  const [payload, models, onboarding, settings] = await Promise.all([
    readFile(new URL("src-tauri/src/payload.rs", root), "utf8"),
    readFile(new URL("src-tauri/src/models.rs", root), "utf8"),
    readFile(new URL("src/onboarding.js", root), "utf8"),
    readFile(new URL("src/pages/settings.js", root), "utf8"),
  ]);
  assert.match(payload, /pub fn skill_is_current/);
  assert.match(payload, /portable_skill_source_dir/);
  assert.match(payload, /read_skill_package_version/);
  assert.match(models, /skill_current/);
  assert.match(onboarding, /Paquete listo para importar en Claude/);
  assert.match(settings, /Skill desactualizada/);
});

test('Jintia se empaqueta como plugin universal para ChatGPT y Codex', async () => {
  const [payload, paths, onboarding, api] = await Promise.all([
    readFile(new URL("src-tauri/src/payload.rs", root), "utf8"),
    readFile(new URL("src-tauri/src/paths.rs", root), "utf8"),
    readFile(new URL("src/onboarding.js", root), "utf8"),
    readFile(new URL("src/api.js", root), "utf8"),
  ]);
  assert.match(payload, /materialize_openai_plugin/);
  assert.match(payload, /register_openai_marketplace/);
  assert.match(paths, /\.codex.*plugins.*jintia/s);
  assert.match(onboarding, /id: "openai"/);
  assert.match(api, /installOpenAIPlugin/);
});

test('el paquete OpenAI conserva su fuente npm administrada', async () => {
  const payload = await readFile(new URL("src-tauri/src/payload.rs", root), "utf8");
  assert.match(payload, /portable_openai_plugin_sources/);
  assert.match(payload, /materialize_openai_plugin_from_portable/);
});

test('payload.rs no incorpora una Skill embebida', async () => {
  const payload = await readFile(new URL("src-tauri/src/payload.rs", root), "utf8");
  const cargo = await readFile(new URL("src-tauri/Cargo.toml", root), "utf8");
  assert.doesNotMatch(payload, /include_dir|include_bytes!|\$OUT_DIR\/jintia-skill/);
  assert.doesNotMatch(payload, /SKILL_MD|SKILL_PACKAGE_JSON|materialize_payload|write_embedded_dir|embedded_dir_matches|installed_payload_matches/);
  assert.doesNotMatch(cargo, /include_dir/);
  assert.match(payload, /portable_openai_plugin_sources/);
  assert.match(payload, /portable_skill_source_dir/);
  assert.match(payload, /read_skill_package_version/);
  assert.match(payload, /portable_skill_export_source/);
  assert.match(payload, /copy_dir_all/);
  assert.match(payload, /add_fs_dir_to_zip\(&mut zip, &skill_src/);
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
    'if (action === "export-zip")',
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

test('los paquetes Node disciplinares usan el runtime portable y su prefix', async () => {
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
    /portable_node_bin_dir\(\)/
  );

  assert.match(
    fn,
    /\.arg\("--prefix"\)/
  );

  assert.match(
    fn,
    /\.arg\(&prefix\)/
  );

  assert.match(
    fn,
    /\.env\("PATH",\s*&patched_path\)/
  );

  assert.match(
    fn,
    /Command::new\(&node\)/
  );

  assert.doesNotMatch(
    fn,
    /Command::new\(&npm\)/
  );
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
    /let node_bin\s*=\s*crate::runtimes::resolve_node\(\)/
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
    /let python_bin\s*=\s*crate::runtimes::resolve_python\(\)/
  );

  assert.match(
    course,
    /installed:\s*python/
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
    'async function performDependencyInstall(name)'
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
    /name:\s*"Vivliostyle CLI"\.to_string\(\)[\s\S]*installed:\s*crate::runtimes::resolve_vivliostyle\(\)\.is_some\(\)/
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
    /portable_node_exe\(\)[\s\S]*\.parent\(\)/
  );

  assert.match(
    engine,
    /\.env\("PATH",\s*patched_path\)/
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
    /portable_node_bin_dir\(\)/
  );

  assert.match(
    installer,
    /std::env::split_paths/
  );

  assert.match(
    installer,
    /std::env::join_paths/
  );

  assert.match(
    installer,
    /\.env\("PATH",\s*&patched_path\)/
  );

  assert.match(
    installer,
    /Command::new\(&node\)[\s\S]*\.arg\(&npm\)/
  );

  assert.match(
    installer,
    /Command::new\("cmd"\)[\s\S]*\.arg\("\/C"\)[\s\S]*\.arg\(&npm\)/
  );

  assert.match(
    installer,
    /@vivliostyle\/cli/
  );
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

  assert.match(
    versioner,
    /portable_node_bin_dir\(\)/
  );

  assert.match(
    versioner,
    /std::env::split_paths/
  );

  assert.match(
    versioner,
    /std::env::join_paths/
  );

  assert.match(
    versioner,
    /\.env\("PATH",\s*&patched_path\)/
  );

  assert.match(
    versioner,
    /Command::new\(&node\)[\s\S]*\.arg\(&executable\)/
  );

  assert.match(
    versioner,
    /Command::new\("cmd"\)[\s\S]*\.arg\("\/C"\)[\s\S]*\.arg\(&executable\)/
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
    'if (action === "export-zip")',
    actionStart
  );

  assert.ok(actionStart >= 0, 'save-profile-and-template debe existir');
  assert.ok(actionEnd > actionStart, 'debe poder aislarse el bloque');

  const saveProfile = source.slice(actionStart, actionEnd);

  const errorIndex = saveProfile.indexOf('profileInstall?.error');
  const successIndex = saveProfile.indexOf(
    'Perfil ${profileInstall.profileId} preparado'
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
  assert.match(fn_, /npm_exe\(\)/);
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
  assert.match(engine, /portable_node_exe/);
  assert.match(engine, /Command::new\(&node_bin\)/);
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

test('payload usa portable_skill_source_dir para localizar la skill portátil', async () => {
  const payload = await readFile(
    new URL('src-tauri/src/payload.rs', root),
    'utf8'
  );

  // portable_skill_version usa portable_skill_source_dir
  const verStart = payload.indexOf('pub fn portable_skill_version()');
  const verEnd = payload.indexOf('\npub fn skill_is_current', verStart);
  const verFn = payload.slice(verStart, verEnd);
  assert.match(verFn, /portable_skill_source_dir/);
  assert.doesNotMatch(verFn, /\.join\("jintia"\)[\s\S]{0,30}?\.join\("skill"\)/);
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
  const [payload, config] = await Promise.all([
    readFile(
    new URL('src-tauri/src/payload.rs', root),
    'utf8'
    ),
    readFile(new URL('src-tauri/src/config.rs', root), 'utf8')
  ]);

  // Helper centralizado existe y lee package.json
  assert.match(payload, /fn read_skill_package_version/);
  const helperStart = payload.indexOf('fn read_skill_package_version');
  const helperEnd = payload.indexOf('\npub fn installed_skill_version', helperStart);
  const helper = payload.slice(helperStart, helperEnd);
  assert.match(helper, /package\.json/);
  assert.match(helper, /version/);

  // installed_skill_version prioriza package.json; VERSION es solo fallback
  const verStart = payload.indexOf('pub fn installed_skill_version()');
  const verEnd = payload.indexOf('\npub fn portable_skill_version', verStart);
  const verFn = payload.slice(verStart, verEnd);
  assert.match(verFn, /read_skill_package_version/);
  assert.match(verFn, /VERSION/);
  // read_skill_package_version debe aparecer antes de VERSION
  assert.ok(
    verFn.indexOf('read_skill_package_version') < verFn.indexOf('VERSION'),
    'package.json debe tener prioridad sobre VERSION'
  );

  // skill_is_current solo acepta la autoridad npm administrada
  const curStart = payload.indexOf('pub fn skill_is_current()');
  const curEnd = payload.indexOf('\npub fn openai_plugin_is_installed', curStart);
  const curFn = payload.slice(curStart, curEnd);
  assert.match(curFn, /installed_skill_dir/);
  assert.match(curFn, /SKILL\.md/);
  assert.match(curFn, /portable_skill_source_dir/);
  assert.match(curFn, /read_skill_package_version/);
  assert.doesNotMatch(curFn, /installed_payload_matches|SKILL_VERSION|SKILL_PACKAGE_JSON/);

  const setupStart = config.indexOf('pub fn setup_status()');
  const setupEnd = config.indexOf('\n}', setupStart) + 2;
  const setupFn = config.slice(setupStart, setupEnd);
  assert.match(setupFn, /portable_skill_version/);
  assert.match(setupFn, /unwrap_or_default/);
  assert.doesNotMatch(setupFn, /SKILL_VERSION/);
  assert.doesNotMatch(config, /SKILL_VERSION/);
});
