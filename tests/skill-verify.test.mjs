import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

function block(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `No se encontró ${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `No se encontró el límite de ${startMarker}`);
  return text.slice(start, end);
}

async function mustNotExist(relativePath) {
  await assert.rejects(
    access(path.join(root, relativePath), constants.F_OK),
    error => error?.code === "ENOENT",
    `${relativePath} no debe existir`,
  );
}

test("skill:verify protege la autoridad npm administrada de Jintia", async () => {
  const packageJson = JSON.parse(await source("package.json"));
  assert.equal(
    packageJson.scripts["skill:verify"],
    "node --test tests/skill-verify.test.mjs",
  );

  const paths = await source("src-tauri/src/paths.rs");
  assert.match(paths, /portable_skill_npm_package_dir_for/);
  assert.match(paths, /portable_skill_bin/);
  assert.match(paths, /@charlie\.act7/);
  assert.match(paths, /jintia/);
  assert.match(paths, /skill.*bin.*jintia\.js/s);

  const runtimes = await source("src-tauri/src/runtimes.rs");
  const resolveSkill = block(runtimes, "pub fn resolve_skill()", "pub fn global_skill_available");
  const installSkill = block(runtimes, "pub fn download_portable_skill", "pub fn visual_install_profiles");
  assert.match(resolveSkill, /portable_skill_bin/);
  assert.match(resolveSkill, /is_file/);
  assert.match(resolveSkill, /Some\(portable/);
  for (const forbidden of ["Command::new(\"jintia\")", "Command::new(\"npx\")", "Command::new(\"npx.cmd\")", "legacy_skill_dir", "instructional-designer-skill", "github.com", "api.github.com", "releases/download", "zipball", "tarball"]) {
    assert.doesNotMatch(resolveSkill, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `resolve_skill no debe usar ${forbidden}`);
  }
  for (const required of ["portable_node_exe", "portable_npm_cli", "managed_node_runtime_path", "managed_node_command(&node)", "npm_cli", "install", "--global", "--prefix", "@charlie.act7/jintia@latest", "portable_skill_npm_package_dir_for", "package.json", "@charlie.act7/jintia", "skill_md", "skill_js", "capabilities", "profiles", "managed_mcp_contract_from"]) {
    assert.match(installSkill, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `falta ${required}`);
  }
  for (const forbidden of ["npm_exe()", "var_os(\"PATH\")", "split_paths", "base_path", "patched_path", "Command::new(\"cmd\")", "Command::new(\"node\")", "Command::new(\"npm\")", "Command::new(\"npx\")", "jintia-skill-", "github.com", "api.github.com", "releases/download", "zipball", "tarball", "browser_download_url", "download_url", "dist.shasum", "SKILL_VERSION", "materialize_payload", "OUT_DIR", "legacy_skill_dir", "instructional-designer-skill"]) {
    assert.doesNotMatch(installSkill, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `el instalador no debe usar ${forbidden}`);
  }

  const engine = await source("src-tauri/src/engine.rs");
  const runJintia = block(engine, "pub fn run_jintia", "pub fn run_jintia_json");
  assert.match(runJintia, /managed_entrypoint/);
  assert.match(runJintia, /resolve_node/);
  assert.match(runJintia, /managed_node_command\(&node_bin\)/);
  assert.doesNotMatch(runJintia, /Command::new\(\"jintia\"\)/);

  for (const legacy of ["skill.lock.json", "scripts/check-skill-release.mjs", "src-tauri/resources/jintia-release-manifest.json", "src-tauri/src/payload.rs"]) {
    await mustNotExist(legacy);
  }
  for (const forbidden of ["check-skill-release", "skill.lock.json", "jintia-release-manifest"]) {
    assert.doesNotMatch(packageJson.scripts["skill:verify"], new RegExp(forbidden));
  }

  const ci = await source(".github/workflows/ci.yml");
  assert.match(ci, /os:\s*\[windows-latest, macos-latest\]/);
  const npmCi = ci.indexOf("- run: npm ci");
  const verify = ci.indexOf("- run: npm run skill:verify");
  const npmTest = ci.indexOf("- run: npm test");
  const build = ci.indexOf("- run: npm run build");
  const cargo = ci.indexOf("- run: cargo test --manifest-path src-tauri\/Cargo.toml");
  assert.ok(npmCi >= 0 && npmCi < verify);
  assert.ok(verify < npmTest && npmTest < build && build < cargo);
});
