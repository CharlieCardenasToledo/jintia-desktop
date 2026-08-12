import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const text = file => readFile(path.join(root, file), "utf8");

test("Desktop no empaqueta ni exporta la Skill de Jintia", async () => {
  await assert.rejects(access(path.join(root, "src-tauri/src/payload.rs"), constants.F_OK));
  const files = await Promise.all([
    "src-tauri/src/config.rs", "src-tauri/src/lib.rs", "src-tauri/src/onboarding.rs",
    "src/api.js", "src/onboarding.js", "src/pages/settings.js", "src/pages/activate.js",
    "src/mocks/tauri-core.mock.js", "src-tauri/Cargo.toml",
  ].map(text));
  const source = files.join("\n");
  for (const marker of ["export_skill_zip", "exportSkillZip", "btn-export-skill", "export-zip", "lastSkillZip", "last_export_path", "record_export", "portable_skill_export_source", "ZipWriter", ".jintia-skill-"]) {
    assert.doesNotMatch(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), marker);
  }
});

test("Desktop no conserva payload ni ZIP directo", async () => {
  const [lib, cargo, config] = await Promise.all(["src-tauri/src/lib.rs", "src-tauri/Cargo.toml", "src-tauri/src/config.rs"].map(text));
  assert.doesNotMatch(lib, /mod payload|payload::|crate::payload/);
  assert.match(cargo, /\[target\.'cfg\(target_os = "windows"\)'\.dependencies\][\s\S]*^zip\s*=/m);
  assert.doesNotMatch(config, /crate::payload/);
});

test("configuración mutable permanece en config.rs", async () => {
  const config = await text("src-tauri/src/config.rs");
  for (const marker of ["sync_user_config_to_install", "institution.json", "notebooks.json", "installed_skill_dir", "openai_plugin_dir", "atomic_write_if_changed"]) assert.match(config, new RegExp(marker));
});

test("instalaciones y estados siguen delegados a Jintia", async () => {
  const source = await text("src-tauri/src/toolchain.rs");
  for (const marker of ["install_global_claude_skill", "claude_skill_status", "install_openai_plugin", "openai_plugin_status", "resolve_skill", "run_jintia"]) assert.match(source, new RegExp(marker));
});

test("onboarding sólo ofrece destinos canónicos", async () => {
  const [backend, frontend, mock] = await Promise.all(["src-tauri/src/onboarding.rs", "src/onboarding.js", "src/mocks/tauri-core.mock.js"].map(text));
  for (const source of [backend, frontend, mock]) assert.doesNotMatch(source, /claude-cowork|lastSkillZip|export-zip/);
  assert.match(backend, /"claude-code"/);
  assert.match(backend, /"openai"/);
  assert.match(backend, /"both"/);
  assert.match(backend, /skill_current[\s\S]*mcp_claude_code_configured[\s\S]*openai_plugin_current/);
  assert.doesNotMatch(backend, /mcp_desktop_configured/);
});

test("Claude Desktop MCP permanece independiente", async () => {
  const source = (await Promise.all(["src-tauri/src/config.rs", "src-tauri/src/lib.rs", "src/pages/settings.js"].map(text))).join("\n");
  for (const marker of ["mcp_desktop_configured", "configure_mcp", "claude_desktop_config_path"]) assert.match(source, new RegExp(marker));
});

test("API y Settings conservan sólo acciones soportadas", async () => {
  const [api, settings, lib] = await Promise.all(["src/api.js", "src/pages/settings.js", "src-tauri/src/lib.rs"].map(text));
  assert.match(api, /installSkill/);
  assert.match(api, /installOpenAIPlugin/);
  assert.doesNotMatch(api, /exportSkillZip|export_skill_zip/);
  assert.doesNotMatch(settings, /exportSkillZip|btn-export-skill|Exportar ZIP/);
  assert.match(lib, /install_skill/);
  assert.match(lib, /install_openai_plugin/);
  assert.doesNotMatch(lib, /export_skill_zip/);
});

test("versiones y contrato de status Claude permanecen congelados", async () => {
  const [pkg, toolchain] = await Promise.all([text("package.json"), text("src-tauri/src/toolchain.rs")]);
  assert.match(pkg, /"version"\s*:\s*"1\.1\.1"/);
  assert.match(toolchain, /"status",\s*"--providers=claude",\s*"--scope=global",\s*"--json"/);
});

test("Activate no conserva el flujo ZIP legacy", async () => {
  const activate = await text("src/pages/activate.js");
  for (const marker of ["Claude/Cowork", "exportSkillZip", "export_skill_zip", "lastSkillZip", "claude-cowork"]) assert.doesNotMatch(activate, new RegExp(marker));
  assert.doesNotMatch(activate, /sequence\s*=\s*\[[^\]]*["']zip["']/);
  assert.match(activate, /institution/);
  assert.match(activate, /skill/);
  assert.match(activate, /mcp-desktop/);
  assert.match(activate, /mcp-code/);
  assert.match(activate, /auth/);
});

test("extract_zip usa ZIP hermético sólo en Windows", async () => {
  const [runtime, cargo] = await Promise.all([text("src-tauri/src/runtimes.rs"), text("src-tauri/Cargo.toml")]);
  const start = runtime.indexOf("fn extract_zip(");
  const end = runtime.indexOf("\n#[cfg", start + 1);
  const body = runtime.slice(start, end);
  assert.match(body, /ZipArchive/);
  assert.match(body, /enclosed_name/);
  assert.doesNotMatch(body, /Command::new\("tar"\)|Command::new\("powershell"\)|Command::new\("7z"\)|Command::new\("unzip"\)/);
  assert.match(cargo, /\[target\.'cfg\(target_os = "windows"\)'\.dependencies\][\s\S]*zip\s*=/);
});
