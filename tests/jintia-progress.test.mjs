// Progreso semántico de la skill en Ask Jintia (jintia-progress.js).
// La skill emite líneas ##JINTIA-EVENT##{...} a stderr desde
// scripts/progress-events.js (repo jintia) — estos tests verifican el
// parseo, el mapeo a fases humanas y el tracker de estado.
//
// Regla no negociable que ancla varios de estos tests: la interfaz nunca
// marca ✓ en una fase que la skill no haya confirmado explícitamente. Los
// tests marcados "regresión" reproducen bugs reales encontrados en una
// revisión de código de la primera versión de este módulo.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isJintiaCliCall,
  extractProgressEvents,
  interpretCoarseOutcome,
  PHASE_MAP,
  MACRO_PHASES,
  JintiaProgressTracker,
} from '../src/jintia-progress.js';

test('isJintiaCliCall reconoce jintia ready y jintia plan approve dentro del comando de shell', () => {
  assert.equal(isJintiaCliCall({ state: { input: { command: 'node bin/jintia.js ready guide.json --json' } } }), true);
  assert.equal(isJintiaCliCall({ state: { input: { command: 'jintia plan approve curso 3' } } }), true);
  assert.equal(isJintiaCliCall({ state: { input: { command: '  jintia   plan   approve  curso 3' } } }), true);
});

test('isJintiaCliCall también reconoce los comandos de una sola fase (plan save/check, evidence check, guide create/finalize, validate, render, preflight, compile)', () => {
  assert.equal(isJintiaCliCall({ state: { input: { command: 'jintia plan save curso 3' } } }), true);
  assert.equal(isJintiaCliCall({ state: { input: { command: 'jintia plan check curso 3' } } }), true);
  assert.equal(isJintiaCliCall({ state: { input: { command: 'jintia evidence check curso 3' } } }), true);
  assert.equal(isJintiaCliCall({ state: { input: { command: 'jintia guide create --input draft.json' } } }), true);
  assert.equal(isJintiaCliCall({ state: { input: { command: 'jintia guide finalize' } } }), true);
  assert.equal(isJintiaCliCall({ state: { input: { command: 'node bin/jintia.js validate guide.json' } } }), true);
  assert.equal(isJintiaCliCall({ state: { input: { command: 'jintia render guide.json --output guide.html' } } }), true);
  assert.equal(isJintiaCliCall({ state: { input: { command: 'jintia preflight guide.html' } } }), true);
  assert.equal(isJintiaCliCall({ state: { input: { command: 'jintia compile guide.json' } } }), true);
});

test('isJintiaCliCall no confunde otros comandos jintia ni tools sin comando', () => {
  assert.equal(isJintiaCliCall({ state: { input: { command: 'jintia state update curso 1' } } }), false);
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

test('REGRESIÓN — "render" vive en fase 4 (calidad), no en fase 5 (documento)', () => {
  // render NO es el último paso antes de compile: le siguen html-lint,
  // render-consistency, html-content, bibliography-post y preflight, todos
  // fase 4. Ponerlo en fase 5 rompía la monotonía del tracker (ver test de
  // "toda la cadena de ready avanza sin quedarse pegada").
  assert.equal(PHASE_MAP.ready.render.phase, 4);
  assert.equal(PHASE_MAP.ready['compile (PDF)'].phase, 5);
});

test('REGRESIÓN — un evento de fase 4 (validate --publish) NO marca las fases 1-3 como completadas', () => {
  // Bug real: el tracker anterior rellenaba TODAS las fases anteriores como
  // "done" en cuanto llegaba cualquier evento de una fase posterior, aunque
  // nunca hubiera evidencia real de que esas fases ocurrieron en este turno.
  const tracker = new JintiaProgressTracker();
  tracker.ingest([{ event: 'work.progress', command: 'ready', step: 'validate --publish', status: 'running' }]);
  const markers = tracker.markers();
  assert.equal(markers[0], '○', 'fase 1 no debe fabricarse como completada');
  assert.equal(markers[1], '○', 'fase 2 no debe fabricarse como completada');
  assert.equal(markers[2], '○', 'fase 3 no debe fabricarse como completada');
  assert.equal(markers[3], '●', 'fase 4 (la que realmente recibió el evento) sí está activa');
});

test('REGRESIÓN — la cadena completa de ready avanza sin quedarse pegada en un paso intermedio', () => {
  // Con render en fase 5 (bug), un preflight/html-lint posterior de fase 4
  // se ignoraba porque el tracker no retrocede. Con todo en fase 4 salvo
  // compile, cada paso de la cadena debe reflejarse como "activo" en su
  // momento sin excepción.
  const tracker = new JintiaProgressTracker();
  const steps = ['validate --publish', 'evidence provenance', 'bibliography (pre-render)', 'assets (SVG)', 'render', 'html lint', 'render consistency', 'html content', 'bibliography (post-render)', 'preflight'];
  for (const step of steps) {
    tracker.ingest([{ event: 'work.progress', command: 'ready', step, status: 'ok' }]);
    assert.equal(tracker.currentLabel(), PHASE_MAP.ready[step].label, `el paso "${step}" debe reflejarse como la etiqueta activa`);
    assert.notEqual(tracker.markers()[3], '○', `la fase 4 debe seguir activa/visible en el paso "${step}"`);
  }
  tracker.ingest([{ event: 'work.progress', command: 'ready', step: 'compile (PDF)', status: 'ok' }]);
  assert.equal(tracker.markers()[4], '✓', 'compile (PDF) ok debe cerrar la fase 5');
});

test('REGRESIÓN — plan-approve cierra su fase (evidence=ok) en vez de quedarse "activo" para siempre', () => {
  const tracker = new JintiaProgressTracker();
  tracker.ingest([
    { event: 'work.progress', command: 'plan-approve', step: 'syllabus-hash', status: 'ok' },
    { event: 'work.progress', command: 'plan-approve', step: 'week', status: 'ok' },
    { event: 'work.progress', command: 'plan-approve', step: 'targets', status: 'ok' },
    { event: 'work.progress', command: 'plan-approve', step: 'alignment', status: 'ok' },
    { event: 'work.progress', command: 'plan-approve', step: 'workload', status: 'ok' },
    { event: 'work.progress', command: 'plan-approve', step: 'assessment', status: 'ok' },
    { event: 'work.progress', command: 'plan-approve', step: 'evidence', status: 'ok' },
  ]);
  assert.equal(tracker.markers()[1], '✓', 'evidence=ok es el paso terminal de plan-approve: la fase 2 debe quedar "done", no "active" para siempre');
});

test('REGRESIÓN — ready con --skip-pdf marca la fase final como "saltada", no como un ✓ engañoso', () => {
  // deterministicDecision queda en PRECHECK_READY, no READY, cuando se usa
  // --skip-pdf — un checkmark verde ahí sugeriría falsamente que el PDF se
  // generó.
  const tracker = new JintiaProgressTracker();
  tracker.ingest([{ event: 'work.progress', command: 'ready', step: 'compile (PDF)', status: 'skipped', detail: '--skip-pdf' }]);
  assert.equal(tracker.markers()[4], '–');
  assert.equal(tracker.skippedDetail(), '--skip-pdf');
});

test('JintiaProgressTracker: una fase completada nunca retrocede a pending/active ante un evento fuera de orden', () => {
  const tracker = new JintiaProgressTracker();
  tracker.ingest([{ event: 'work.progress', command: 'ready', step: 'compile (PDF)', status: 'ok' }]);
  const before = tracker.markers();
  tracker.ingest([{ event: 'work.progress', command: 'ready', step: 'compile (PDF)', status: 'running' }]);
  assert.deepEqual(tracker.markers(), before);
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

test('JintiaProgressTracker: un status "blocked"/"error" marca esa fase como bloqueada y expone el detalle', () => {
  const tracker = new JintiaProgressTracker();
  tracker.ingest([{ event: 'work.progress', command: 'ready', step: 'validate --publish', status: 'error', detail: '3 error(es)' }]);
  assert.equal(tracker.isBlocked(), true);
  assert.equal(tracker.blockedDetail(), '3 error(es)');
  assert.equal(tracker.markers()[3], '!');
});

test('ingestCoarse: "guide create" activa la fase 3 sin cerrarla; "guide finalize" ok sí la cierra', () => {
  const tracker = new JintiaProgressTracker();
  tracker.ingestCoarse('guide create', 'running');
  assert.equal(tracker.markers()[2], '●');
  assert.equal(tracker.currentLabel(), 'Registrando la guía redactada');
  tracker.ingestCoarse('guide create', 'ok');
  assert.equal(tracker.markers()[2], '●', '"guide create" no es terminal: debe seguir activa, no cerrarse');
  tracker.ingestCoarse('guide finalize', 'ok');
  assert.equal(tracker.markers()[2], '✓', '"guide finalize" es terminal: sí cierra la fase 3');
});

test('noteEvidenceActivity: una consulta a NotebookLM marca la fase 2 activa sin necesitar un evento de la skill', () => {
  const tracker = new JintiaProgressTracker();
  tracker.noteEvidenceActivity();
  assert.equal(tracker.markers()[1], '●');
  assert.equal(tracker.currentLabel(), 'Reuniendo evidencia');
});

test('noteEvidenceActivity no reabre la fase 2 si ya está cerrada (done/blocked)', () => {
  const tracker = new JintiaProgressTracker();
  tracker.ingest([{ event: 'work.progress', command: 'plan-approve', step: 'evidence', status: 'ok' }]);
  assert.equal(tracker.markers()[1], '✓');
  tracker.noteEvidenceActivity();
  assert.equal(tracker.markers()[1], '✓', 'una fase ya cerrada no debe volver a "active"');
});

test('REGRESIÓN — plan-approve cierra la fase 1 (interior) cuando la fase 2 (evidence) empieza a reportar, no solo cuando termina su propio paso terminal', () => {
  // plan-approve reparte sus pasos entre fase 1 (syllabus-hash..assessment)
  // y fase 2 (evidence, su único paso). El paso terminal declarado
  // ("evidence") solo cierra la fase 2 por sí mismo — sin la regla de
  // "fase posterior activa cierra fases anteriores con evidencia propia",
  // la fase 1 se quedaba "●" para siempre aunque el propio plan-approve ya
  // hubiera progresado más allá de ella.
  const tracker = new JintiaProgressTracker();
  tracker.ingest([
    { event: 'work.progress', command: 'plan-approve', step: 'syllabus-hash', status: 'ok' },
    { event: 'work.progress', command: 'plan-approve', step: 'week', status: 'ok' },
    { event: 'work.progress', command: 'plan-approve', step: 'targets', status: 'ok' },
    { event: 'work.progress', command: 'plan-approve', step: 'alignment', status: 'ok' },
    { event: 'work.progress', command: 'plan-approve', step: 'workload', status: 'ok' },
    { event: 'work.progress', command: 'plan-approve', step: 'assessment', status: 'ok' },
  ]);
  assert.equal(tracker.markers()[0], '●', 'fase 1 debe estar activa tras sus propios pasos, todavía no cerrada');
  tracker.ingest([{ event: 'work.progress', command: 'plan-approve', step: 'evidence', status: 'ok' }]);
  assert.equal(tracker.markers()[0], '✓', 'fase 1 debe cerrarse en cuanto la fase 2 (evidence) empieza a reportar — ya no puede seguir "en curso"');
  assert.equal(tracker.markers()[1], '✓', 'fase 2 se cierra por su propio paso terminal, como antes');
});

test('REGRESIÓN — ready cierra la fase 4 (interior) cuando compile (fase 5) reporta, incluso si se saltó con --skip-pdf', () => {
  const tracker = new JintiaProgressTracker();
  const qualitySteps = ['validate --publish', 'evidence provenance', 'bibliography (pre-render)', 'assets (SVG)', 'render', 'html lint', 'render consistency', 'html content', 'bibliography (post-render)', 'preflight'];
  for (const step of qualitySteps) tracker.ingest([{ event: 'work.progress', command: 'ready', step, status: 'ok' }]);
  assert.equal(tracker.markers()[3], '●', 'fase 4 activa tras preflight, todavía no cerrada por sí sola');
  tracker.ingest([{ event: 'work.progress', command: 'ready', step: 'compile (PDF)', status: 'skipped', detail: '--skip-pdf' }]);
  assert.equal(tracker.markers()[3], '✓', 'fase 4 debe cerrarse en cuanto compile (fase 5) reporta, sin importar si compile en sí se saltó');
  assert.equal(tracker.markers()[4], '–', 'fase 5 sigue distinguiendo "saltada" de "hecha"');
});

test('REGRESIÓN — la fase posterior nunca cierra una fase anterior que sigue en "pending" (sin evidencia propia) — no reintroduce el bug de fabricar ✓', () => {
  // Si un turno SOLO ejecuta `ready` (sin plan-approve, sin NotebookLM, sin
  // guide create en esta misma sesión de progreso), las fases 1-3 no tienen
  // ninguna evidencia real — deben quedarse en "pending", no "done".
  const tracker = new JintiaProgressTracker();
  tracker.ingest([{ event: 'work.progress', command: 'ready', step: 'validate --publish', status: 'ok' }]);
  assert.deepEqual(tracker.markers().slice(0, 3), ['○', '○', '○'], 'fases sin ningún evento propio deben seguir "pending", nunca "done" por la mera llegada de un evento de una fase posterior');
});

test('interpretCoarseOutcome reconoce éxito/fallo en las formas JSON reales usadas por la skill (report.js, plan save, ok booleano, exitCode)', () => {
  assert.equal(interpretCoarseOutcome(JSON.stringify({ status: 'success', exitCode: 0 })), 'ok');
  assert.equal(interpretCoarseOutcome(JSON.stringify({ status: 'failed', exitCode: 1 })), 'blocked');
  assert.equal(interpretCoarseOutcome(JSON.stringify({ status: 'saved', state: 'pending' })), 'ok');
  assert.equal(interpretCoarseOutcome(JSON.stringify({ status: 'error', message: 'x' })), 'blocked');
  assert.equal(interpretCoarseOutcome(JSON.stringify({ ok: true, message: 'Plan aprobado.' })), 'ok');
  assert.equal(interpretCoarseOutcome(JSON.stringify({ ok: false, message: 'x' })), 'blocked');
  assert.equal(interpretCoarseOutcome(JSON.stringify({ exitCode: 0 })), 'ok');
  assert.equal(interpretCoarseOutcome(JSON.stringify({ exitCode: 2 })), 'blocked');
});

test('interpretCoarseOutcome devuelve "unknown" (nunca "ok") cuando no hay señal reconocible — OpenCode no expone el exit code real', () => {
  assert.equal(interpretCoarseOutcome(''), 'unknown');
  assert.equal(interpretCoarseOutcome(undefined), 'unknown');
  assert.equal(interpretCoarseOutcome('✓ Plan guardado correctamente'), 'unknown', 'texto humano plano no debe interpretarse como éxito solo por no verse mal');
  assert.equal(interpretCoarseOutcome(JSON.stringify({ message: 'listo' })), 'unknown', 'un JSON sin ningún campo de estado reconocible no debe asumirse exitoso');
});

test('REGRESIÓN — un comando "coarse" que falla nunca se muestra como éxito (P0: OpenCode reporta "completed" incluso con exit code != 0)', () => {
  const tracker = new JintiaProgressTracker();
  const failedOutput = interpretCoarseOutcome(JSON.stringify({ status: 'failed', exitCode: 1, errors: [{ message: 'JIN-CNT-005' }] }));
  tracker.ingestCoarse('guide finalize', failedOutput);
  assert.equal(tracker.markers()[2], '!', 'un "guide finalize" fallido debe mostrarse bloqueado, nunca "✓"');
});

test('REGRESIÓN — un comando "coarse" cuyo resultado no se puede confirmar se queda activo, ni éxito ni bloqueo fabricados', () => {
  const tracker = new JintiaProgressTracker();
  const unknownOutcome = interpretCoarseOutcome('salida de texto plano sin campo de estado reconocible');
  tracker.ingestCoarse('compile', unknownOutcome);
  assert.equal(tracker.markers()[4], '●', 'sin poder confirmar el resultado, la fase se queda activa — ni "✓" ni "!" fabricados');
});
