// Contratos estáticos del proveedor "Claude Code" de Ask Jintia.
// Complementa static-contracts.test.mjs (que ya cubre Codex/OpenCode) sin
// engordarlo más: este archivo se queda enfocado solo en Claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

async function readClaudeRs() {
  const parts = await Promise.all(
    ['mod.rs', 'models.rs', 'stream.rs'].map(
      f => readFile(new URL(`src-tauri/src/claude/${f}`, root), 'utf8')
    )
  );
  return parts.join('\n');
}

test('src-tauri/src/claude/{mod,models,stream}.rs existen', async () => {
  const claude = await readClaudeRs();
  assert.ok(claude.length > 0);
});

test('lib.rs declara el módulo claude y registra ClaudeManager', async () => {
  const lib = await readFile(new URL('src-tauri/src/lib.rs', root), 'utf8');
  assert.match(lib, /^mod claude;$/m);
  assert.match(lib, /\.manage\(claude::ClaudeManager::new\(\)\)/);
});

test('lib.rs registra los tres comandos Tauri de Claude en generate_handler!', async () => {
  const lib = await readFile(new URL('src-tauri/src/lib.rs', root), 'utf8');
  for (const cmd of ['claude_status', 'claude_submit_turn', 'claude_interrupt_turn']) {
    assert.match(lib, new RegExp(`fn ${cmd}\\(`));
    assert.match(lib, new RegExp(`\\n\\s*${cmd},`));
  }
});

test('lib.rs detiene los procesos de Claude al cerrar la ventana', async () => {
  const lib = await readFile(new URL('src-tauri/src/lib.rs', root), 'utf8');
  const destroyedBlock = lib.slice(lib.indexOf('WindowEvent::Destroyed'));
  assert.match(destroyedBlock, /claude::ClaudeManager[\s\S]*?mgr\.stop_all\(\)/);
});

test('ClaudeManager usa streaming NDJSON headless y conserva la sesión OAuth de la suscripción', async () => {
  const claude = await readClaudeRs();
  assert.match(claude, /--output-format/);
  assert.match(claude, /stream-json/);
  assert.match(claude, /--include-partial-messages/);
  assert.match(claude, /--resume/);
  // Nunca --bare (desactiva OAuth/skills/MCP/CLAUDE.md) ni
  // --dangerously-skip-permissions, y nunca una API key hardcodeada: la
  // sesión de suscripción del usuario es la única fuente de autenticación
  // que Jintia debe usar aquí. Se busca el literal Rust entre comillas
  // (cómo aparecería si de verdad se pasara como argumento), no cualquier
  // mención en prosa — los propios comentarios del código explican por qué
  // NO se usan, citándolos entre backticks, lo que daría falsos positivos.
  assert.doesNotMatch(claude, /"--?bare"/);
  assert.doesNotMatch(claude, /"--?dangerously-skip-permissions"/);
  assert.doesNotMatch(claude, /ANTHROPIC_API_KEY"\s*,\s*"/);
});

test('ClaudeManager restringe herramientas con --tools, no con --allowedTools', async () => {
  // Confirmado con el CLI real (incluso en una carpeta nunca vista antes):
  // en modo headless (-p, sin TTY) --allowedTools y --permission-mode no
  // bloquean nada, Claude ejecuta la herramienta igual sin denegarla ni
  // colgarse. --tools sí quita la herramienta del conjunto disponible para
  // el modelo. Ver el comentario de cabecera de src-tauri/src/claude/mod.rs.
  const claude = await readClaudeRs();
  assert.match(claude, /"--tools"/);
  assert.doesNotMatch(claude, /"--allowedTools"/);
});

test('Ask Jintia manda una lista de herramientas real (no vacía, sin Bash) al enviar un turno de Claude', async () => {
  // El bug que esto evita: antes claudeSubmitTurn() se llamaba sin segundo
  // argumento, así que ningún --tools llegaba al CLI y el turno corría sin
  // ninguna restricción real de herramientas. Decisión explícita: Claude
  // puede editar/crear archivos (Edit, Write) pero no ejecutar comandos
  // (Bash queda fuera) — allowlist cerrada, sin diálogo de aprobación por
  // acción (el broker de permisos con confirmación no es viable vía
  // subproceso del CLI).
  const chat = await readFile(new URL('src/pages/jintia-chat.js', root), 'utf8');
  assert.match(chat, /const CLAUDE_TOOLS\s*=\s*\[[^\]]+\]/);
  assert.match(chat, /claudeSubmitTurn\(\{[\s\S]*?\},\s*CLAUDE_TOOLS\)/);
  const toolsLine = chat.match(/const CLAUDE_TOOLS\s*=\s*(\[[^\]]+\])/)[1];
  assert.doesNotMatch(toolsLine, /"Bash"/);
  assert.match(toolsLine, /"Edit"/);
  assert.match(toolsLine, /"Write"/);
});

test('ClaudeStatus nunca declara un campo de token, solo el resumen de auth status', async () => {
  const models = await readFile(new URL('src-tauri/src/claude/models.rs', root), 'utf8');
  // Busca un CAMPO de struct llamado *token* (p. ej. "pub token: String,"), no
  // cualquier mención de la palabra — los comentarios explican a propósito
  // que este contrato NO incluye tokens, y esas frases sí contienen "token".
  assert.doesNotMatch(models, /pub\s+\w*token\w*\s*:/i);
});

test('api.js expone claudeStatus, claudeSubmitTurn y claudeInterruptTurn', async () => {
  const api = await readFile(new URL('src/api.js', root), 'utf8');
  assert.match(api, /export async function claudeStatus\(\)/);
  assert.match(api, /export async function claudeSubmitTurn\(/);
  assert.match(api, /export async function claudeInterruptTurn\(/);
  assert.match(api, /invoke\("claude_status"\)/);
  assert.match(api, /invoke\("claude_submit_turn"/);
  assert.match(api, /invoke\("claude_interrupt_turn"/);
});

test('src/ai/claudeRuntime.js expone el catálogo de modelos y el registro de listeners', async () => {
  const runtime = await readFile(new URL('src/ai/claudeRuntime.js', root), 'utf8');
  assert.match(runtime, /export const CLAUDE_MODELS/);
  assert.match(runtime, /export async function registerClaudeListeners/);
  for (const eventName of [
    'claude:session/started',
    'claude:message/delta',
    'claude:system/api_retry',
    'claude:turn/completed',
    'claude:error',
  ]) {
    assert.match(runtime, new RegExp(eventName.replace(/[/]/g, '\\/')));
  }
});

test('Ask Jintia acepta "claude" como proveedor y puede abortar un turno', async () => {
  const chat = await readFile(new URL('src/pages/jintia-chat.js', root), 'utf8');
  assert.match(chat, /<option value="claude"/);
  assert.match(chat, /async function sendMessageViaClaude/);
  assert.match(chat, /_provider === "claude"/);
  assert.match(chat, /claudeInterruptTurn\(_claudeRequestId\)/);
});

test('Ajustes muestra el estado de Claude Code (instalado/autenticado) sin credenciales', async () => {
  const settings = await readFile(new URL('src/pages/settings.js', root), 'utf8');
  assert.match(settings, /claude-status-label/);
  assert.match(settings, /async function loadClaudeStatus/);
  assert.doesNotMatch(settings, /ANTHROPIC_API_KEY\s*=/);
});

test('los mocks de Tauri simulan Claude sin dejar el chat "pensando" para siempre', async () => {
  const [core, event] = await Promise.all([
    readFile(new URL('src/mocks/tauri-core.mock.js', root), 'utf8'),
    readFile(new URL('src/mocks/tauri-event.mock.js', root), 'utf8'),
  ]);
  assert.match(core, /claude_status:/);
  assert.match(core, /claude_submit_turn:/);
  assert.match(core, /claude_interrupt_turn:/);
  assert.match(core, /emitMockEvent/);
  // El bug original: listen() no llamaba nunca al callback, así que cualquier
  // proveedor basado en eventos Tauri (Claude) se quedaba "pensando" para
  // siempre en modo mock.
  assert.match(event, /export function emitMockEvent/);
  assert.doesNotMatch(event, /return \(\) => \{\};\s*\n\}/);
});
