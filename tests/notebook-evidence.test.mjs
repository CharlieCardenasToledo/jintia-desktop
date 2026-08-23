// Tarjetas de evidencia de NotebookLM en Ask Jintia (notebook-evidence.js).
// Estos fixtures reproducen la forma REAL de AskQuestionResult verificada
// contra el código fuente de gemini-notebooklm-mcp (src/types.ts,
// src/tools/handlers.ts, src/index.ts) — no son un shape inventado.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isNotebookAskQuestionTool,
  unwrapAskQuestionOutput,
  sourceLabel,
} from '../src/notebook-evidence.js';

test('isNotebookAskQuestionTool reconoce ask_question con o sin prefijo de servidor MCP', () => {
  assert.equal(isNotebookAskQuestionTool('ask_question'), true);
  assert.equal(isNotebookAskQuestionTool('notebooklm_ask_question'), true);
  assert.equal(isNotebookAskQuestionTool('notebooklm-ask_question'), true);
  assert.equal(isNotebookAskQuestionTool('mcp__notebooklm__ask_question'), true);
  assert.equal(isNotebookAskQuestionTool('ASK_QUESTION'), true);
});

test('isNotebookAskQuestionTool no confunde otras tools de NotebookLM ni tools nativas de OpenCode', () => {
  assert.equal(isNotebookAskQuestionTool('notebooklm_list_sources'), false);
  assert.equal(isNotebookAskQuestionTool('notebooklm_get_health'), false);
  assert.equal(isNotebookAskQuestionTool('bash'), false);
  assert.equal(isNotebookAskQuestionTool('edit'), false);
  assert.equal(isNotebookAskQuestionTool(undefined), false);
  assert.equal(isNotebookAskQuestionTool(null), false);
});

// Payload real: el handler devuelve `{ success: true, data: AskQuestionResult }`
// (handlers.ts) y el servidor MCP lo envía como
// `{ content: [{type:"text", text: JSON.stringify(...)}], structuredContent: payload }`
// (index.ts). No hay evidencia local de cuál de estas capas expone OpenCode
// como part.state.output, así que se prueban las variantes plausibles.
const REAL_ASK_QUESTION_RESULT = {
  status: 'success',
  question: '¿Cuáles son las diferencias fundamentales entre una base de datos y un sistema tradicional de archivos?',
  answer: 'Una base de datos centraliza el almacenamiento y reduce la redundancia frente al enfoque de archivos.',
  session_id: 'a1b2c3d4-0000-0000-0000-000000000000',
  notebook_url: 'https://notebook.google.com/notebook/xyz',
  session_info: { age_seconds: 12, message_count: 1, last_activity: 1700000000 },
  _provenance: {
    provider: 'google-notebooklm', model: 'google-managed', model_selection: 'managed-by-notebooklm',
    via: 'chrome-automation', grounding: 'user-uploaded-documents', ai_generated: true,
  },
  sources: [
    { marker: '[1]', number: 1, sourceName: 'Elmasri — Fundamentals of Database Systems', sourceText: '', source_id: null, source_name: 'Elmasri — Fundamentals of Database Systems', source_type: 'pdf', source_url: null, location: { page: 21 }, excerpt: 'texto…', extraction_status: 'complete' },
    { marker: '[2]', number: 2, sourceName: 'Silberschatz — Database System Concepts', sourceText: '', source_id: null, source_name: 'Silberschatz — Database System Concepts', source_type: 'pdf', source_url: null, location: null, excerpt: null, extraction_status: 'partial' },
  ],
  source_format: 'json',
};

test('unwrapAskQuestionOutput lee el ToolResult sin envolver ({success, data})', () => {
  const parsed = unwrapAskQuestionOutput({ success: true, data: REAL_ASK_QUESTION_RESULT });
  assert.equal(parsed._success, true);
  assert.equal(parsed.question, REAL_ASK_QUESTION_RESULT.question);
  assert.equal(parsed.answer, REAL_ASK_QUESTION_RESULT.answer);
  assert.equal(parsed.sources.length, 2);
});

test('unwrapAskQuestionOutput lee la forma MCP completa vía structuredContent', () => {
  const mcpResult = {
    content: [{ type: 'text', text: JSON.stringify({ success: true, data: REAL_ASK_QUESTION_RESULT }) }],
    structuredContent: { success: true, data: REAL_ASK_QUESTION_RESULT },
    isError: false,
  };
  const parsed = unwrapAskQuestionOutput(mcpResult);
  assert.equal(parsed._success, true);
  assert.equal(parsed.answer, REAL_ASK_QUESTION_RESULT.answer);
});

test('unwrapAskQuestionOutput lee la forma MCP sin structuredContent, solo el texto JSON', () => {
  const mcpResult = {
    content: [{ type: 'text', text: JSON.stringify({ success: true, data: REAL_ASK_QUESTION_RESULT }) }],
    isError: false,
  };
  const parsed = unwrapAskQuestionOutput(mcpResult);
  assert.equal(parsed._success, true);
  assert.equal(parsed.question, REAL_ASK_QUESTION_RESULT.question);
});

test('unwrapAskQuestionOutput acepta el output ya como string JSON (event.properties.part.state.output serializado)', () => {
  const parsed = unwrapAskQuestionOutput(JSON.stringify({ success: true, data: REAL_ASK_QUESTION_RESULT }));
  assert.equal(parsed._success, true);
  assert.equal(parsed.answer, REAL_ASK_QUESTION_RESULT.answer);
});

test('unwrapAskQuestionOutput acepta AskQuestionResult ya desenvuelto (sin wrapper success/data)', () => {
  const parsed = unwrapAskQuestionOutput(REAL_ASK_QUESTION_RESULT);
  assert.equal(parsed._success, true);
  assert.equal(parsed.question, REAL_ASK_QUESTION_RESULT.question);
});

test('unwrapAskQuestionOutput reconoce el error de status:"error" del propio AskQuestionResult', () => {
  const errorResult = { status: 'error', question: 'x', error: 'Algo falló', notebook_url: 'https://x' };
  const parsed = unwrapAskQuestionOutput(errorResult);
  assert.equal(parsed._success, false);
});

test('unwrapAskQuestionOutput reconoce el error de nivel ToolResult ({success:false, error})', () => {
  // Ver handlers.ts: el rate limit de NotebookLM responde así, sin `data`.
  const rateLimitResult = { success: false, error: 'NotebookLM reported a rate or quota limit.' };
  const parsed = unwrapAskQuestionOutput(rateLimitResult);
  assert.equal(parsed._success, false);
  assert.match(parsed.error, /rate/i);
});

test('unwrapAskQuestionOutput devuelve null ante basura irreconocible (nunca lanza)', () => {
  assert.equal(unwrapAskQuestionOutput(null), null);
  assert.equal(unwrapAskQuestionOutput(undefined), null);
  assert.equal(unwrapAskQuestionOutput(42), null);
  assert.equal(unwrapAskQuestionOutput('not json at all'), null);
  assert.equal(unwrapAskQuestionOutput({ unrelated: 'field' }), null);
});

test('sourceLabel combina nombre y ubicación cuando hay página/diapositiva', () => {
  assert.equal(
    sourceLabel({ sourceName: 'Elmasri', location: { page: 21 } }),
    'Elmasri · p. 21',
  );
  assert.equal(
    sourceLabel({ source_name: 'Video del curso', location: { slide: 4 } }),
    'Video del curso · diapositiva 4',
  );
});

test('sourceLabel usa solo el nombre cuando no hay ubicación', () => {
  assert.equal(sourceLabel({ sourceName: 'Silberschatz', location: null }), 'Silberschatz');
  assert.equal(sourceLabel({}), 'Fuente');
});
