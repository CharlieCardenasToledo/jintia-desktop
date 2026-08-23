// Progreso semántico de la skill en Ask Jintia (jintia-progress.js).
// La skill emite líneas ##JINTIA-EVENT##{...} a stderr desde
// scripts/progress-events.js (repo jintia) — estos tests verifican que el
// parseo, el mapeo a fases humanas y el tracker de estado sean correctos,
// sin depender de si OpenCode entrega esa salida en vivo o solo al cerrar
// el tool call (riesgo documentado en el plan de esta feature).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isJintiaCliCall,
  extractProgressEvents,
  PHASE_MAP,
  MACRO_PHASES,
  JintiaProgressTracker,
} from '../src/jintia-progress.js';

test('isJintiaCliCall reconoce jintia ready y jintia plan approve dentro del comando de shell', () => {
  assert.equal(isJintiaCliCall({ state: { input: { command: 'node bin/jintia.js ready guide.json --json' } } }), true);
  assert.equal(isJintiaCliCall({ state: { input: { command: 'jintia plan approve curso 3' } } }), true);
  assert.equal(isJintiaCliCall({ state: { input: { command: '  jintia   plan   approve  curso 3' } } }), true);
});

test('isJintiaCliCall no confunde otros comandos jintia ni tools sin comando', () => {
  assert.equal(isJintiaCliCall({ state: { input: { command: 'jintia validate guide.json' } } }), false);
  assert.equal(isJintiaCliCall({ state: { input: { command: 'jintia plan save' } } }), false);
  assert.equal(isJintiaCliCall({ state: { input: { command: 'ls -la' } } }), false);
  assert.equal(isJintiaCliCall({}), false);
  assert.equal(isJintiaCliCall(undefined), false);
});

test('extractProgressEvents extrae líneas ##JINTIA-EVENT## de un blob de texto mixto', () => {
  const text = [
    'JINTIA READY',
    'Objetivo: guide.json',
    '##JINTIA-EVENT##{"event":"work.progress","command":"ready","step":"validate --publish","status":"running"}',
    '✓ validate --publish — 0 error(es)',
    '##JINTIA-EVENT##{"event":"work.progress","command":"ready","step":"validate --publish","status":"ok","detail":"0 error(es)"}',
  ].join('\n');
  const events = extractProgressEvents(text);
  assert.equal(events.length, 2);
  assert.equal(events[0].status, 'running');
  assert.equal(events[1].status, 'ok');
  assert.equal(events[1].detail, '0 error(es)');
});

test('extractProgressEvents devuelve vacío ante texto sin eventos, no-string, o línea corrupta', () => {
  assert.deepEqual(extractProgressEvents('solo texto humano, sin eventos'), []);
  assert.deepEqual(extractProgressEvents(undefined), []);
  assert.deepEqual(extractProgressEvents(null), []);
  assert.deepEqual(extractProgressEvents('##JINTIA-EVENT##{esto no es JSON válido'), []);
});

test('extractProgressEvents ignora eventos que no son event:"work.progress"', () => {
  const text = '##JINTIA-EVENT##{"event":"other.thing","command":"ready","step":"x","status":"ok"}';
  assert.deepEqual(extractProgressEvents(text), []);
});

test('PHASE_MAP cubre exactamente los steps que la skill emite (ready.js, plan-state.js)', () => {
  // Nombres literales tal como aparecen en record()/emitProgress() del lado
  // de la skill — si algún día cambian ahí, este test debe fallar aquí
  // primero, no en producción silenciosamente cayendo a "sin traducir".
  const readySteps = [
    'validate --publish', 'evidence provenance', 'bibliography (pre-render)', 'assets (SVG)',
    'render', 'html lint', 'render consistency', 'html content', 'bibliography (post-render)',
    'preflight', 'compile (PDF)',
  ];
  const planApproveSteps = ['syllabus-hash', 'week', 'targets', 'alignment', 'workload', 'assessment', 'evidence'];

  for (const step of readySteps) assert.ok(PHASE_MAP.ready[step], `falta mapeo para ready:${step}`);
  for (const step of planApproveSteps) assert.ok(PHASE_MAP['plan-approve'][step], `falta mapeo para plan-approve:${step}`);

  for (const mapping of [...Object.values(PHASE_MAP.ready), ...Object.values(PHASE_MAP['plan-approve'])]) {
    assert.ok(mapping.phase >= 1 && mapping.phase <= MACRO_PHASES.length, `fase fuera de rango: ${mapping.phase}`);
    assert.equal(typeof mapping.label, 'string');
  }
});

test('JintiaProgressTracker: una fase completada nunca retrocede a pending/active', () => {
  const tracker = new JintiaProgressTracker();
  tracker.ingest([{ event: 'work.progress', command: 'ready', step: 'render', status: 'ok' }]);
  const beforeMarkers = tracker.markers();
  // Un evento "viejo" (de una fase anterior) llega después, fuera de orden.
  tracker.ingest([{ event: 'work.progress', command: 'ready', step: 'validate --publish', status: 'running' }]);
  const afterMarkers = tracker.markers();
  assert.deepEqual(afterMarkers, beforeMarkers, 'un evento de una fase ya superada no debe revertir el estado');
});

test('JintiaProgressTracker: ignora eventos de un command/step desconocido sin lanzar', () => {
  const tracker = new JintiaProgressTracker();
  assert.doesNotThrow(() => tracker.ingest([
    { event: 'work.progress', command: 'unknown-command', step: 'x', status: 'ok' },
    { event: 'work.progress', command: 'ready', step: 'unknown-step', status: 'ok' },
    null,
    {},
  ]));
  assert.equal(tracker.hasProgress(), false);
});

test('JintiaProgressTracker: start→end de un paso refleja active y luego done al llegar a compile (PDF)', () => {
  const tracker = new JintiaProgressTracker();
  tracker.ingest([{ event: 'work.progress', command: 'ready', step: 'validate --publish', status: 'running' }]);
  assert.equal(tracker.hasProgress(), true);
  assert.equal(tracker.isBlocked(), false);
  assert.equal(tracker.currentLabel(), PHASE_MAP.ready['validate --publish'].label);

  tracker.ingest([{ event: 'work.progress', command: 'ready', step: 'compile (PDF)', status: 'ok' }]);
  const finalPhaseIdx = PHASE_MAP.ready['compile (PDF)'].phase - 1;
  assert.equal(tracker.markers()[finalPhaseIdx], '✓');
});

test('JintiaProgressTracker: un status "blocked" marca esa fase como bloqueada y expone el detalle', () => {
  const tracker = new JintiaProgressTracker();
  tracker.ingest([{ event: 'work.progress', command: 'ready', step: 'validate --publish', status: 'error', detail: '3 error(es)' }]);
  assert.equal(tracker.isBlocked(), true);
  assert.equal(tracker.blockedDetail(), '3 error(es)');
  const idx = PHASE_MAP.ready['validate --publish'].phase - 1;
  assert.equal(tracker.markers()[idx], '!');
});
