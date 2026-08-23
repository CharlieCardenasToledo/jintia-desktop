// Failover automático de modelos para el chat de OpenCode (opencode-failover.js).
// A diferencia del resto de tests/*.test.mjs (contratos estáticos sobre texto
// fuente), estos ejecutan la lógica real: es puro JS sin DOM/Tauri, así que
// se puede probar el comportamiento, no solo su presencia en el código.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FailureCategory,
  classifyFailure,
  isFailoverEligible,
  blockScope,
  cooldownMs,
  ModelHealthRegistry,
  pickNextModel,
  TurnSupervisor,
} from '../src/opencode-failover.js';

test('classifyFailure detecta rate limit, cuota, timeout, auth, servidor y MCP', () => {
  assert.equal(classifyFailure({ statusCode: 429, message: 'rate limited' }), FailureCategory.MODEL_RATE_LIMIT);
  assert.equal(classifyFailure({ message: 'quota exceeded for this billing period' }), FailureCategory.PROVIDER_QUOTA);
  assert.equal(classifyFailure({ message: 'request timed out' }), FailureCategory.PROVIDER_TIMEOUT);
  assert.equal(classifyFailure({ statusCode: 401, message: 'invalid api key' }), FailureCategory.AUTH_FAILURE);
  assert.equal(classifyFailure({ statusCode: 503, message: 'service unavailable' }), FailureCategory.PROVIDER_UNAVAILABLE);
  assert.equal(classifyFailure({ message: 'ECONNREFUSED 127.0.0.1:4096' }), FailureCategory.SERVER_UNAVAILABLE);
  assert.equal(classifyFailure({ message: 'NotebookLM ask_question tool failed' }), FailureCategory.MCP_FAILURE);
  assert.equal(classifyFailure({ message: 'jintia compile: bloqueado por incidencias JIN-SCH-001' }), FailureCategory.VALIDATION_ERROR);
  assert.equal(classifyFailure({}), FailureCategory.UNKNOWN);
});

test('isFailoverEligible excluye MCP y errores de validación de Jintia', () => {
  assert.equal(isFailoverEligible(FailureCategory.MODEL_RATE_LIMIT), true);
  assert.equal(isFailoverEligible(FailureCategory.PROVIDER_QUOTA), true);
  assert.equal(isFailoverEligible(FailureCategory.MCP_FAILURE), false, 'un timeout de NotebookLM no debe cambiar de modelo');
  assert.equal(isFailoverEligible(FailureCategory.VALIDATION_ERROR), false, 'un bloqueo de Jintia no se arregla cambiando de modelo');
  assert.equal(isFailoverEligible(FailureCategory.CONTEXT_OVERFLOW), false, 'el desbordamiento de contexto necesita compactar, no cambiar de modelo');
});

test('blockScope bloquea todo el proveedor en cuota/auth/servidor, solo el modelo en el resto', () => {
  assert.equal(blockScope(FailureCategory.PROVIDER_QUOTA), 'provider');
  assert.equal(blockScope(FailureCategory.AUTH_FAILURE), 'provider');
  assert.equal(blockScope(FailureCategory.SERVER_UNAVAILABLE), 'provider');
  assert.equal(blockScope(FailureCategory.MODEL_RATE_LIMIT), 'model');
  assert.equal(blockScope(FailureCategory.PROVIDER_TIMEOUT), 'model');
});

test('cooldownMs: auth es indefinido, cuota respeta retryAfterMs si viene del proveedor', () => {
  assert.equal(cooldownMs(FailureCategory.AUTH_FAILURE), Infinity);
  assert.equal(cooldownMs(FailureCategory.PROVIDER_QUOTA, { retryAfterMs: 5000 }), 5000);
  assert.ok(cooldownMs(FailureCategory.PROVIDER_QUOTA) > cooldownMs(FailureCategory.MODEL_RATE_LIMIT), 'cuota agotada debe durar más que un rate limit puntual');
});

test('ModelHealthRegistry: un modelo en cooldown no está disponible; otros modelos del mismo proveedor sí', () => {
  const registry = new ModelHealthRegistry();
  registry.recordFailure('anthropic', 'claude-sonnet', FailureCategory.MODEL_RATE_LIMIT);
  assert.equal(registry.isAvailable('anthropic', 'claude-sonnet'), false);
  assert.equal(registry.isAvailable('anthropic', 'claude-opus'), true, 'rate limit de un modelo no debe bloquear otros modelos del mismo proveedor');
});

test('ModelHealthRegistry: cuota agotada bloquea TODOS los modelos del proveedor', () => {
  const registry = new ModelHealthRegistry();
  registry.recordFailure('anthropic', 'claude-sonnet', FailureCategory.PROVIDER_QUOTA);
  assert.equal(registry.isAvailable('anthropic', 'claude-sonnet'), false);
  assert.equal(registry.isAvailable('anthropic', 'claude-opus'), false, 'cuota agotada del proveedor debe bloquear todos sus modelos, no solo el que falló');
  assert.equal(registry.isAvailable('openai', 'gpt-5'), true, 'no debe afectar a otros proveedores');
});

test('pickNextModel salta modelos ya intentados y modelos en cooldown, respeta el orden dado', () => {
  const models = [
    { id: 'claude-sonnet', provider_id: 'anthropic', name: 'Claude Sonnet' },
    { id: 'gpt-5', provider_id: 'openai', name: 'GPT-5' },
    { id: 'gemini-pro', provider_id: 'google', name: 'Gemini Pro' },
  ];
  const registry = new ModelHealthRegistry();
  registry.recordFailure('openai', 'gpt-5', FailureCategory.PROVIDER_UNAVAILABLE);
  const attemptedKeys = new Set(['anthropic|claude-sonnet']);

  const next = pickNextModel(models, { attemptedKeys, registry });
  assert.equal(next?.id, 'gemini-pro', 'debe saltar el ya intentado (claude-sonnet) y el que está en cooldown (gpt-5)');
});

test('pickNextModel devuelve null cuando no queda ningún candidato', () => {
  const models = [{ id: 'a', provider_id: 'p', name: 'A' }];
  const next = pickNextModel(models, { attemptedKeys: new Set(['p|a']) });
  assert.equal(next, null);
});

test('TurnSupervisor.shouldInterceptRetry: deja pasar un primer retry corto, intercepta desde el segundo intento o si next está lejos', () => {
  const supervisor = new TurnSupervisor({ originalPrompt: 'x', initialModel: null, sessionId: 's1' });
  assert.equal(supervisor.shouldInterceptRetry({ attempt: 1, next: Date.now() + 5000 }), false, 'primer intento con espera corta: dejar el retry nativo');
  assert.equal(supervisor.shouldInterceptRetry({ attempt: 2, next: Date.now() + 2000 }), true, 'segundo intento: cambiar de modelo aunque la espera sea corta');
  assert.equal(supervisor.shouldInterceptRetry({ attempt: 1, next: Date.now() + 20000 }), true, 'espera larga (>15s) en el primer intento: no vale la pena esperar');
});

test('TurnSupervisor: sin efectos secundarios, el prompt de recuperación es el original', () => {
  const supervisor = new TurnSupervisor({
    originalPrompt: 'Genera la guía de la semana 1',
    initialModel: { id: 'claude-sonnet', providerID: 'anthropic', name: 'Claude Sonnet' },
    sessionId: 's1',
  });
  assert.equal(supervisor.buildRecoveryPrompt(), 'Genera la guía de la semana 1');
});

test('TurnSupervisor: con efectos secundarios (herramientas ya ejecutadas), pide continuar en vez de repetir', () => {
  const supervisor = new TurnSupervisor({
    originalPrompt: 'Genera la guía de la semana 1',
    initialModel: { id: 'claude-sonnet', providerID: 'anthropic', name: 'Claude Sonnet' },
    sessionId: 's1',
  });
  supervisor.noteToolActivity();
  const prompt = supervisor.buildRecoveryPrompt();
  assert.match(prompt, /Continúa el turno interrumpido/);
  assert.match(prompt, /No repitas operaciones/);
  assert.match(prompt, /Genera la guía de la semana 1/, 'debe conservar la instrucción original como referencia');
});

test('TurnSupervisor: flujo completo de failover — dos modelos fallan, el tercero se usa; el registry excluye a los caídos', () => {
  const models = [
    { id: 'claude-sonnet', provider_id: 'anthropic', name: 'Claude Sonnet' },
    { id: 'gpt-5', provider_id: 'openai', name: 'GPT-5' },
    { id: 'gemini-pro', provider_id: 'google', name: 'Gemini Pro' },
  ];
  const registry = new ModelHealthRegistry();
  const supervisor = new TurnSupervisor({
    originalPrompt: 'Genera la guía',
    initialModel: { id: 'claude-sonnet', providerID: 'anthropic', name: 'Claude Sonnet' },
    sessionId: 's1',
    registry,
  });

  supervisor.recordFailure(FailureCategory.PROVIDER_QUOTA, 'cuota agotada');
  let next = supervisor.nextCandidate(models);
  assert.equal(next?.provider_id, 'openai', 'debe saltar todo el proveedor anthropic (cuota agotada), no solo claude-sonnet');
  supervisor.advanceTo({ id: next.id, providerID: next.provider_id, name: next.name });

  supervisor.recordFailure(FailureCategory.PROVIDER_TIMEOUT, 'timeout');
  next = supervisor.nextCandidate(models);
  assert.equal(next?.provider_id, 'google');
  supervisor.advanceTo({ id: next.id, providerID: next.provider_id, name: next.name });

  assert.equal(supervisor.nextCandidate(models), null, 'sin más proveedores disponibles, no debe quedar ningún candidato');
  assert.deepEqual(supervisor.summary(), [
    'Claude Sonnet — cuota agotada',
    'GPT-5 — timeout',
  ]);
});
