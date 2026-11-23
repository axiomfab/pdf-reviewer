import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { PDFDocument, PDFName } from 'pdf-lib';
import {
  annotationTypeToSubtype,
  matchesTypeFilter,
  quadPointsToRatioRects,
  rectsToQuadPointsAndBounds,
  subtypeToAnnotationType,
  validateRatioRect,
  validateTextRects,
} from '../sidecars/panel/annotation_geometry.mjs';
import {
  addPdfComment,
  clearPdfComments,
  deletePdfComment,
  listPdfComments,
  modifyPdfComment,
} from '../sidecars/panel/pdf_annotations.mjs';
import { executeToolCall, handleMessage } from '../src/mcp_server.mjs';

console.log('=== Running Unit Tests for Highlights, Underlines, and Strikethroughs ===');

const __dirname = dirname(fileURLToPath(import.meta.url));
const scratchDir = join(__dirname, 'scratch');
if (!existsSync(scratchDir)) {
  mkdirSync(scratchDir, { recursive: true });
}
const markupPdf = join(scratchDir, 'markup_fixture.pdf');

const blankDoc = await PDFDocument.create();
blankDoc.addPage([600, 800]);
blankDoc.addPage([600, 800]);
writeFileSync(markupPdf, await blankDoc.save());

async function callRpc(msg) {
  let response = null;
  await handleMessage(msg, (res) => {
    response = res;
  });
  return response;
}

// 1. Geometry & Type Mapping Helpers (Happy Paths & Failure Paths)
const sampleRects = [
  { xRatio: 0.1, yRatio: 0.2, wRatio: 0.3, hRatio: 0.04 },
  { xRatio: 0.1, yRatio: 0.25, wRatio: 0.25, hRatio: 0.04 },
];
validateRatioRect(sampleRects[0]);
validateTextRects(sampleRects);

const { quadPoints, pdfRect, unionRatioRect } = rectsToQuadPointsAndBounds(sampleRects, 600, 800);
assert.equal(quadPoints.length, 16);
assert.deepEqual(pdfRect, [60, 568, 240, 640]);
assert(Math.abs(unionRatioRect.hRatio - 0.09) < 1e-9);

const tempDoc = await PDFDocument.create();
const quadPdfArray = tempDoc.context.obj(quadPoints);
const decodedQuads = quadPointsToRatioRects(quadPdfArray, 600, 800);
assert.equal(decodedQuads.length, 2);
assert(Math.abs(decodedQuads[0].xRatio - 0.1) < 1e-6);
assert(Math.abs(decodedQuads[1].yRatio - 0.25) < 1e-6);

assert.equal(annotationTypeToSubtype('highlight'), 'Highlight');
assert.equal(annotationTypeToSubtype('underline'), 'Underline');
assert.equal(annotationTypeToSubtype('strikethrough'), 'StrikeOut');
assert.equal(annotationTypeToSubtype('strike'), 'StrikeOut');
assert.equal(subtypeToAnnotationType('/Highlight'), 'highlight');
assert.equal(subtypeToAnnotationType('/Underline'), 'underline');
assert.equal(subtypeToAnnotationType('/Squiggly'), 'underline');
assert.equal(subtypeToAnnotationType('/StrikeOut'), 'strikethrough');
assert.equal(matchesTypeFilter('strikethrough', 'strike'), true);
assert.equal(matchesTypeFilter('text', 'highlight'), true);
assert.equal(matchesTypeFilter('underline', 'highlight'), false);
console.log('✅ PASS: Markup Happy Path 1: Geometry, QuadPoints, and subtype mappers work accurately');

assert.throws(() => validateRatioRect([]), /CRITICAL: Valid ratio rectangle object required/);
assert.throws(
  () => validateRatioRect({ xRatio: 0.1, yRatio: 0.2, wRatio: -0.1, hRatio: 0.05 }),
  /CRITICAL: rect\.wRatio and rect\.hRatio must be non-negative/
);
assert.throws(
  () => validateTextRects([]),
  /CRITICAL: textRects must be a non-empty array of valid ratio rectangles/
);
assert.throws(
  () => validateTextRects([{ xRatio: 'bad', yRatio: 0, wRatio: 0.1, hRatio: 0.1 }]),
  /CRITICAL: textRects\[0\]\.xRatio must be a finite number/
);
assert.throws(
  () => quadPointsToRatioRects(quadPdfArray, 0, 800),
  /CRITICAL: pageWidth and pageHeight must be positive numbers/
);
assert.equal(quadPointsToRatioRects(tempDoc.context.obj([1, 2, 3, 4]), 600, 800), null);
assert.throws(
  () => rectsToQuadPointsAndBounds([], 600, 800),
  /CRITICAL: textRects must be a non-empty array/
);
assert.throws(() => annotationTypeToSubtype('squiggly_unknown'), /CRITICAL: Unsupported annotation type/);
assert.throws(() => subtypeToAnnotationType(''), /CRITICAL: PDF annotation subtype must be a non-empty string/);
assert.throws(() => subtypeToAnnotationType('/Link'), /CRITICAL: Unsupported PDF annotation subtype/);
assert.throws(() => matchesTypeFilter('highlight', 'bogus'), /CRITICAL: Invalid annotation type filter/);
assert.throws(() => matchesTypeFilter('bogus', 'highlight'), /CRITICAL: Invalid entry annotation type/);
console.log('✅ PASS: Markup Failure Path 1: Geometry and subtype validators fail fast on invalid inputs');

// 2. Core PDF CRUD for Highlight, Underline, and Strikethrough
const { comment: hlAdded } = await addPdfComment(markupPdf, {
  type: 'highlight',
  page: 1,
  selectedText: 'Important claim',
  textRects: [{ xRatio: 0.12, yRatio: 0.15, wRatio: 0.35, hRatio: 0.03 }],
});
assert.equal(hlAdded.type, 'highlight');
assert.equal(hlAdded.comment, '');

const { comment: ulAdded } = await addPdfComment(markupPdf, {
  type: 'underline',
  page: 1,
  selectedText: 'Key lemma',
  textRects: [{ xRatio: 0.12, yRatio: 0.25, wRatio: 0.25, hRatio: 0.03 }],
});
assert.equal(ulAdded.type, 'underline');

const { comment: stAdded } = await addPdfComment(markupPdf, {
  type: 'strikethrough',
  page: 1,
  selectedText: 'Deprecated phrase',
  replacement: 'Updated phrase',
  textRects: [{ xRatio: 0.12, yRatio: 0.35, wRatio: 0.3, hRatio: 0.03 }],
});
assert.equal(stAdded.type, 'strikethrough');

const loadedAfterAdd = await PDFDocument.load(readFileSync(markupPdf));
const p1Annots = loadedAfterAdd.getPages()[0].node.lookup(PDFName.of('Annots'));
assert.equal(p1Annots.size(), 3);
assert.equal(p1Annots.lookup(0).lookup(PDFName.of('Subtype')).toString(), '/Highlight');
assert.equal(p1Annots.lookup(1).lookup(PDFName.of('Subtype')).toString(), '/Underline');
assert.equal(p1Annots.lookup(2).lookup(PDFName.of('Subtype')).toString(), '/StrikeOut');

const onlyUnderlines = await listPdfComments(markupPdf, 1, { type: 'underline' });
assert.equal(onlyUnderlines.length, 1);
assert.equal(onlyUnderlines[0].id, ulAdded.id);

const onlyStrikes = await listPdfComments(markupPdf, 1, { type: 'strike' });
assert.equal(onlyStrikes.length, 1);
assert.equal(onlyStrikes[0].id, stAdded.id);
console.log('✅ PASS: Markup Happy Path 2: Native /Highlight, /Underline, /StrikeOut added and filtered');

// External native ISO 32000 markups without AGYMeta or /Contents
const extDoc = await PDFDocument.load(readFileSync(markupPdf));
const extPage = extDoc.getPages()[1];
const extAnnots = extDoc.context.obj([]);
for (const [subtype, quadY] of [
  ['Highlight', 680],
  ['Underline', 640],
  ['StrikeOut', 600],
  ['Squiggly', 560],
]) {
  const ref = extDoc.context.register(
    extDoc.context.obj({
      Type: 'Annot',
      Subtype: subtype,
      Rect: [60, quadY, 240, quadY + 20],
      QuadPoints: [60, quadY + 20, 240, quadY + 20, 60, quadY, 240, quadY],
    })
  );
  extAnnots.push(ref);
}
extPage.node.set(PDFName.of('Annots'), extAnnots);
writeFileSync(markupPdf, await extDoc.save());

const p2External = await listPdfComments(markupPdf, 2);
assert.equal(p2External.length, 4);
assert.deepEqual(
  p2External.map((c) => c.type),
  ['highlight', 'underline', 'strikethrough', 'underline']
);
assert.equal(p2External[0].comment, '');
assert.equal(p2External[1].textRects.length, 1);
console.log('✅ PASS: Markup Happy Path 3: External native ISO 32000 markups without AGYMeta/Contents extracted');

await assert.rejects(
  () => addPdfComment(markupPdf, { type: 'highlight', page: 1 }),
  /CRITICAL: Markup annotation requires at least one of 'textRects', 'rect', 'selectedText', or 'comment'/
);
await assert.rejects(
  () => addPdfComment(markupPdf, { type: 'underline', page: 1, comment: 123, selectedText: 'abc' }),
  /CRITICAL: Comment text must be a string when provided/
);
await assert.rejects(
  () => listPdfComments(markupPdf, 1, 'bad_options'),
  /CRITICAL: options must be a plain object/
);
await assert.rejects(
  () => listPdfComments(markupPdf, 1, { type: 'invalid_filter' }),
  /CRITICAL: Invalid annotation type filter/
);
console.log('✅ PASS: Markup Failure Path 2: Empty markup payloads and invalid list filters rejected');

// Modify markup: convert type, add/clear comment, update textRects
const { comment: converted } = await modifyPdfComment(markupPdf, hlAdded.id, {
  type: 'underline',
  comment: 'Converted to underline with note',
  textRects: [
    { xRatio: 0.15, yRatio: 0.15, wRatio: 0.4, hRatio: 0.03 },
    { xRatio: 0.15, yRatio: 0.19, wRatio: 0.2, hRatio: 0.03 },
  ],
});
assert.equal(converted.type, 'underline');
assert.equal(converted.comment, 'Converted to underline with note');
assert.equal(converted.textRects.length, 2);

const docAfterModify = await PDFDocument.load(readFileSync(markupPdf));
const modDict = docAfterModify.getPages()[0].node.lookup(PDFName.of('Annots')).lookup(0);
assert.equal(modDict.lookup(PDFName.of('Subtype')).toString(), '/Underline');
assert.equal(modDict.lookup(PDFName.of('QuadPoints')).size(), 16);

const { comment: clearedNoteMarkup } = await modifyPdfComment(markupPdf, hlAdded.id, {
  type: 'strikethrough',
  comment: null,
  replacement: 'Cleaner wording',
});
assert.equal(clearedNoteMarkup.type, 'strikethrough');
assert.equal(clearedNoteMarkup.comment, '');
assert.equal(clearedNoteMarkup.replacement, 'Cleaner wording');

const { comment: noteForTest } = await addPdfComment(markupPdf, {
  type: 'note',
  page: 1,
  comment: 'Sticky note must stay non-empty',
});
await assert.rejects(
  () => modifyPdfComment(markupPdf, noteForTest.id, { comment: null }),
  /CRITICAL: Cannot clear 'comment' on non-markup annotation/
);
await assert.rejects(
  () => modifyPdfComment(markupPdf, hlAdded.id, { type: 'bad_type' }),
  /CRITICAL: type must be one of/
);
await assert.rejects(
  () => modifyPdfComment(markupPdf, hlAdded.id, { textRects: [] }),
  /CRITICAL: textRects must be a non-empty array/
);
console.log('✅ PASS: Markup Happy & Failure Path 3: modifyPdfComment converts markup types, clears markup note, rejects clearing note comment');

// Delete & selective clear
const extDeleteRes = await deletePdfComment(markupPdf, 'ext_p2_1');
assert.equal(extDeleteRes.deleted.type, 'underline');

const clearUlRes = await clearPdfComments(markupPdf, { type: 'underline' });
assert.equal(clearUlRes.cleared, 2);
const remainingAfterClear = await listPdfComments(markupPdf);
assert(!remainingAfterClear.some((c) => c.type === 'underline'));

await assert.rejects(() => deletePdfComment(markupPdf, '   '), /CRITICAL: commentId must be a valid string/);
await assert.rejects(() => clearPdfComments(markupPdf, 'bad'), /CRITICAL: options must be a plain object/);
await assert.rejects(() => clearPdfComments(markupPdf, { type: 'bad' }), /CRITICAL: Invalid annotation type filter/);
console.log('✅ PASS: Markup Happy & Failure Path 4: deletePdfComment and selective clearPdfComments verified');

// 3. MCP Server JSON-RPC Tests for Highlights, Underlines, and Strikethroughs
const toolsRes = await callRpc({ jsonrpc: '2.0', id: 101, method: 'tools/list' });
const addSchema = toolsRes.result.tools.find((t) => t.name === 'mcp_pdf_annotations_add');
assert(addSchema.inputSchema.properties.type.enum.includes('highlight'));
assert(addSchema.inputSchema.properties.type.enum.includes('underline'));
assert(addSchema.inputSchema.properties.type.enum.includes('strikethrough'));
assert.deepEqual(addSchema.inputSchema.required, ['pdfPath', 'page']);

const mcpHlRes = await callRpc({
  jsonrpc: '2.0',
  id: 102,
  method: 'tools/call',
  params: {
    name: 'mcp_pdf_annotations_add',
    arguments: {
      pdfPath: markupPdf,
      page: 1,
      type: 'highlight',
      selectedText: 'Theorem 1',
      textRects: [{ xRatio: 0.2, yRatio: 0.5, wRatio: 0.2, hRatio: 0.03 }],
    },
  },
});
assert(!mcpHlRes.result.isError);
const mcpHlId = JSON.parse(mcpHlRes.result.content[0].text).comment.id;

const mcpUlRes = await callRpc({
  jsonrpc: '2.0',
  id: 103,
  method: 'tools/call',
  params: {
    name: 'mcp_pdf_annotations_add',
    arguments: {
      pdfPath: markupPdf,
      page: 1,
      type: 'underline',
      selectedText: 'Lemma 2',
      rect: { xRatio: 0.2, yRatio: 0.6, wRatio: 0.2, hRatio: 0.03 },
    },
  },
});
assert(!mcpUlRes.result.isError);
const mcpUlId = JSON.parse(mcpUlRes.result.content[0].text).comment.id;

const mcpListHlRes = await callRpc({
  jsonrpc: '2.0',
  id: 104,
  method: 'tools/call',
  params: {
    name: 'mcp_pdf_annotations_list',
    arguments: { pdfPath: markupPdf, page: 1, type: 'underline' },
  },
});
const mcpUlList = JSON.parse(mcpListHlRes.result.content[0].text);
assert(mcpUlList.some((c) => c.id === mcpUlId));
assert(!mcpUlList.some((c) => c.id === mcpHlId));

const mcpModRes = await callRpc({
  jsonrpc: '2.0',
  id: 105,
  method: 'tools/call',
  params: {
    name: 'mcp_pdf_annotations_modify',
    arguments: {
      pdfPath: markupPdf,
      commentId: mcpHlId,
      type: 'strikethrough',
      replacement: 'Theorem 1a',
      comment: null,
    },
  },
});
assert(!mcpModRes.result.isError);
assert.equal(JSON.parse(mcpModRes.result.content[0].text).comment.type, 'strikethrough');

const mcpClearUlRes = await callRpc({
  jsonrpc: '2.0',
  id: 106,
  method: 'tools/call',
  params: {
    name: 'mcp_pdf_annotations_clear',
    arguments: { pdfPath: markupPdf, type: 'underline' },
  },
});
assert.equal(JSON.parse(mcpClearUlRes.result.content[0].text).cleared, 1);

const mcpDelStRes = await callRpc({
  jsonrpc: '2.0',
  id: 107,
  method: 'tools/call',
  params: {
    name: 'mcp_pdf_annotations_delete',
    arguments: { pdfPath: markupPdf, commentId: mcpHlId },
  },
});
assert.equal(JSON.parse(mcpDelStRes.result.content[0].text).deleted.id, mcpHlId);

await assert.rejects(
  () => executeToolCall('mcp_pdf_annotations_add', { pdfPath: markupPdf, page: 1, type: 'highlight' }),
  /CRITICAL: Markup annotation requires at least one of/
);
await assert.rejects(
  () => executeToolCall('mcp_pdf_annotations_list', { pdfPath: markupPdf, type: 'not_valid' }),
  /CRITICAL: 'type' must be one of/
);
await assert.rejects(
  () => executeToolCall('mcp_pdf_annotations_clear', { pdfPath: markupPdf, type: 'not_valid' }),
  /CRITICAL: 'type' must be one of/
);
await assert.rejects(
  () => executeToolCall('mcp_pdf_annotations_modify', { pdfPath: markupPdf, commentId: noteForTest.id, rect: { xRatio: 0 } }),
  /CRITICAL: rect\.yRatio must be a finite number/
);
console.log('✅ PASS: Markup Happy & Failure Path 5: MCP JSON-RPC CRUD & validation verified for highlights, underlines, strikethroughs');

// 3b. Same-page Repositioning & Cross-page Relocation Tests
const modifySchema = toolsRes.result.tools.find((t) => t.name === 'mcp_pdf_annotations_modify');
assert.equal(modifySchema.inputSchema.properties.page.type, 'integer');
assert.equal(modifySchema.inputSchema.properties.page.minimum, 1);

const relocatePdf = join(scratchDir, 'relocate_fixture.pdf');
const relocateDoc = await PDFDocument.create();
relocateDoc.addPage([600, 800]);
relocateDoc.addPage([1200, 1000]);
writeFileSync(relocatePdf, await relocateDoc.save());

const { comment: relocHl } = await addPdfComment(relocatePdf, {
  type: 'highlight',
  page: 1,
  comment: 'Relocatable highlight',
  textRects: [{ xRatio: 0.1, yRatio: 0.2, wRatio: 0.25, hRatio: 0.05 }],
});

// Same-page repositioning via rect on highlight (updates both /Rect and /QuadPoints)
const { comment: movedSamePage } = await modifyPdfComment(relocatePdf, relocHl.id, {
  rect: { xRatio: 0.3, yRatio: 0.4, wRatio: 0.2, hRatio: 0.05 },
});
assert.equal(movedSamePage.page, 1);
assert.deepEqual(movedSamePage.rect, { xRatio: 0.3, yRatio: 0.4, wRatio: 0.2, hRatio: 0.05 });
assert.deepEqual(movedSamePage.textRects, [{ xRatio: 0.3, yRatio: 0.4, wRatio: 0.2, hRatio: 0.05 }]);

// Same-page repositioning via textRects
const { comment: movedTextRects } = await modifyPdfComment(relocatePdf, relocHl.id, {
  textRects: [
    { xRatio: 0.1, yRatio: 0.2, wRatio: 0.25, hRatio: 0.05 },
    { xRatio: 0.1, yRatio: 0.3, wRatio: 0.2, hRatio: 0.05 },
  ],
});
assert.equal(movedTextRects.textRects.length, 2);
assert(Math.abs(movedTextRects.rect.hRatio - 0.15) < 1e-9);

// Cross-page relocation from page 1 (600x800) to page 2 (1200x1000) without explicit rect
const { comment: relocatedPage2 } = await modifyPdfComment(relocatePdf, relocHl.id, { page: 2 });
assert.equal(relocatedPage2.page, 2);
assert.equal((await listPdfComments(relocatePdf, 1)).length, 0);
assert.equal((await listPdfComments(relocatePdf, 2)).length, 1);

const reloadedRelocDoc = await PDFDocument.load(readFileSync(relocatePdf));
const relocPages = reloadedRelocDoc.getPages();
const p1AnnotsArr = relocPages[0].node.get(PDFName.of('Annots')) ? relocPages[0].node.lookup(PDFName.of('Annots')) : null;
assert(!p1AnnotsArr || p1AnnotsArr.size() === 0, 'Source page Annots should be empty after cross-page move');
const p2AnnotsArr = relocPages[1].node.lookup(PDFName.of('Annots'));
assert.equal(p2AnnotsArr.size(), 1, 'Target page Annots should contain relocated annotation');
const p2AnnotDict = p2AnnotsArr.lookup(0);
const p2Rect = p2AnnotDict.lookup(PDFName.of('Rect'));
// Page 2 is 1200x1000; unionRatioRect is x:0.1..0.35 (120..420), y:0.2..0.35 -> pdf y: 650..800
assert.equal(p2Rect.lookup(0).asNumber(), 120);
assert.equal(p2Rect.lookup(1).asNumber(), 650);
assert.equal(p2Rect.lookup(2).asNumber(), 420);
assert.equal(p2Rect.lookup(3).asNumber(), 800);

// Cross-page relocation + rect update via MCP tool
const mcpRelocRes = await callRpc({
  jsonrpc: '2.0',
  id: 108,
  method: 'tools/call',
  params: {
    name: 'mcp_pdf_annotations_modify',
    arguments: {
      pdfPath: relocatePdf,
      commentId: relocHl.id,
      page: 1,
      rect: { xRatio: 0.5, yRatio: 0.5, wRatio: 0.1, hRatio: 0.05 },
    },
  },
});
assert(!mcpRelocRes.result.isError);
const mcpRelocComment = JSON.parse(mcpRelocRes.result.content[0].text).comment;
assert.equal(mcpRelocComment.page, 1);
assert.deepEqual(mcpRelocComment.rect, { xRatio: 0.5, yRatio: 0.5, wRatio: 0.1, hRatio: 0.05 });

// Failure paths for page relocation
await assert.rejects(() => modifyPdfComment(relocatePdf, relocHl.id, { page: 0 }), /CRITICAL: 'page' must be a positive integer/);
await assert.rejects(() => modifyPdfComment(relocatePdf, relocHl.id, { page: -1 }), /CRITICAL: 'page' must be a positive integer/);
await assert.rejects(() => modifyPdfComment(relocatePdf, relocHl.id, { page: 1.5 }), /CRITICAL: 'page' must be a positive integer/);
await assert.rejects(() => modifyPdfComment(relocatePdf, relocHl.id, { page: '2' }), /CRITICAL: 'page' must be a positive integer/);
await assert.rejects(() => modifyPdfComment(relocatePdf, relocHl.id, { page: 99 }), /CRITICAL: Page 99 out of bounds/);
await assert.rejects(
  () => executeToolCall('mcp_pdf_annotations_modify', { pdfPath: relocatePdf, commentId: relocHl.id, page: 99 }),
  /CRITICAL: Page 99 out of bounds/
);
await assert.rejects(
  () => executeToolCall('mcp_pdf_annotations_modify', { pdfPath: relocatePdf, commentId: relocHl.id, page: 0 }),
  /CRITICAL: 'page' must be a positive integer/
);

if (existsSync(relocatePdf)) {
  rmSync(relocatePdf, { force: true });
}
console.log('✅ PASS: Markup Happy & Failure Path 5b: Same-page repositioning and cross-page relocation verified');

// 4. Sidecar UI & History Contracts
const html = readFileSync(new URL('../sidecars/panel/index.html', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../sidecars/panel/app.js', import.meta.url), 'utf8');
const uiCommentsJs = readFileSync(new URL('../sidecars/panel/ui_comments.js', import.meta.url), 'utf8');
const uiHistoryJs = readFileSync(new URL('../sidecars/panel/ui_history.js', import.meta.url), 'utf8');
const commentsCss = readFileSync(new URL('../sidecars/panel/comments.css', import.meta.url), 'utf8');

assert(html.includes('id="mode-highlight-btn"') && html.includes('id="mode-underline-btn"') && html.includes('id="mode-strike-btn"'));
assert(appJs.includes("setMode('highlight')") && appJs.includes("setMode('underline')") && appJs.includes("setMode('strikethrough')"));
assert(commentsCss.includes('.pdf-text-underline') && commentsCss.includes('.pin-type-btn'));
assert(uiCommentsJs.includes("document.addEventListener('mouseup'") && uiCommentsJs.includes('pdf-text-underline') && uiCommentsJs.includes('pin-type-btn'));
assert(uiHistoryJs.includes('window.commentHistory') && uiHistoryJs.includes('modifyWithHistory'));

const fnMatch = uiCommentsJs.match(/function extractSelectionPayload\(selection, pageWrapper\) \{[\s\S]*?\n\}/);
assert(fnMatch, 'Expected extractSelectionPayload in ui_comments.js');
const vmCtx = {};
vm.runInNewContext(`${fnMatch[0]}; vmCtx.extractSelectionPayload = extractSelectionPayload;`, { vmCtx });
const { extractSelectionPayload } = vmCtx;

const mockSelection = {
  rangeCount: 1,
  toString: () => '  highlighted phrase  ',
  getRangeAt: () => ({
    getClientRects: () => [{ left: 150, top: 200, width: 100, height: 20 }],
  }),
};
const mockPageWrapper = {
  dataset: { pageNum: '2' },
  getBoundingClientRect: () => ({ left: 100, top: 100, width: 500, height: 1000 }),
};
const extracted = extractSelectionPayload(mockSelection, mockPageWrapper);
assert.equal(extracted.pageNum, 2);
assert.equal(extracted.selectedText, 'highlighted phrase');
assert.equal(extracted.textRects.length, 1);
assert(Math.abs(extracted.textRects[0].xRatio - 0.1) < 1e-9);
assert(Math.abs(extracted.textRects[0].yRatio - 0.1) < 1e-9);
assert(Math.abs(extracted.textRects[0].wRatio - 0.2) < 1e-9);

assert.throws(() => extractSelectionPayload(null, mockPageWrapper), /CRITICAL: Valid Selection object is required/);
assert.throws(
  () => extractSelectionPayload(mockSelection, { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 100 }) }),
  /CRITICAL: pageWrapper must have positive bounding dimensions/
);
assert.equal(
  extractSelectionPayload({ rangeCount: 1, toString: () => '   ', getRangeAt: () => ({ getClientRects: () => [] }) }, mockPageWrapper),
  null
);
console.log('✅ PASS: Markup Happy & Failure Path 6: UI modes, styles, history, and extractSelectionPayload verified');

// Cleanup markup fixture (parent test_plugin.mjs also cleans scratchDir)
if (existsSync(markupPdf)) {
  rmSync(markupPdf, { force: true });
}
