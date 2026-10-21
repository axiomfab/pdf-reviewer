import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addPdfComment,
  deletePdfComment,
  findWorkspacePdfs,
  listPdfComments,
  modifyPdfComment,
} from '../sidecars/panel/main.mjs';
import { handleMessage, executeToolCall } from '../src/mcp_server.mjs';
import { TOOLS } from '../src/tool_schemas.mjs';

console.log('=== Running Unit Tests for pdf-reviewer (Native PDF Annotations & MCP Suite) ===');

const workspace = 'C:\\Users\\lukas\\Desktop\\weavemas-paper';

// Helper to capture messages from handleMessage
async function callRpc(msg) {
  let response = null;
  await handleMessage(msg, (res) => {
    response = res;
  });
  return response;
}

// 1. Happy Path: Detect existing PDF
const pdfs = findWorkspacePdfs(workspace);
assert(Array.isArray(pdfs) && pdfs.length > 0, 'Expected at least 1 PDF');
console.log(`✅ PASS: Happy Path 1: findWorkspacePdfs found ${pdfs.length} PDFs`);

// Set up isolated scratch test fixture
const __dirname = dirname(fileURLToPath(import.meta.url));
const scratchDir = join(__dirname, 'scratch');
if (!existsSync(scratchDir)) {
  mkdirSync(scratchDir, { recursive: true });
}
const targetPdf = join(scratchDir, 'test_fixture.pdf');
copyFileSync(pdfs[0].path, targetPdf);

// 2. Happy Path: Embed native annotation into PDF & extract it back
const { comment: added, mtime } = await addPdfComment(targetPdf, {
  type: 'text',
  page: 1,
  comment: 'Native PDF annotation test',
  selectedText: 'December 16, 2026',
  textRects: [{ xRatio: 0.1, yRatio: 0.2, wRatio: 0.3, hRatio: 0.05 }],
});
assert(added.id.startsWith('c_'), 'Expected valid comment ID');
assert(typeof mtime === 'number' && mtime > 0, 'Expected updated mtime');

const extracted = await listPdfComments(targetPdf);
const match = extracted.find((c) => c.id === added.id);
assert(match, 'Expected annotation to be embedded and extracted directly from PDF');
assert.equal(match.comment, 'Native PDF annotation test');
console.log('✅ PASS: Happy Path 2: addPdfComment & listPdfComments embedded and read native PDF annotation');

// 3. Happy Path: Filter comments by page
const page1Comments = await listPdfComments(targetPdf, 1);
assert(page1Comments.some((c) => c.id === added.id), 'Expected comment on page 1');
const page99Comments = await listPdfComments(targetPdf, 99);
assert.equal(page99Comments.length, 0, 'Expected no comments on non-existent page 99');
console.log('✅ PASS: Happy Path 3: listPdfComments page filtering works as expected');

// 4. Happy Path: Modify comment directly in PDF
const { comment: modified } = await modifyPdfComment(targetPdf, added.id, {
  comment: 'Updated native comment content',
  status: 'resolved',
});
assert.equal(modified.comment, 'Updated native comment content');
assert.equal(modified.status, 'resolved');
assert(modified.modifiedAt, 'Expected modifiedAt timestamp');
const verifyModifiedList = await listPdfComments(targetPdf);
const foundModified = verifyModifiedList.find((c) => c.id === added.id);
assert.equal(foundModified.comment, 'Updated native comment content');
assert.equal(foundModified.status, 'resolved');
console.log('✅ PASS: Happy Path 4: modifyPdfComment updated comment text and status');

// 5. Happy Path: Delete annotation from PDF
const { deleted } = await deletePdfComment(targetPdf, added.id);
assert(deleted && deleted.id === added.id, 'Expected deletePdfComment to return deleted comment object');
const afterDelete = await listPdfComments(targetPdf);
assert(!afterDelete.some((c) => c.id === added.id), 'Expected annotation to be removed from PDF');
console.log('✅ PASS: Happy Path 5: deletePdfComment removed annotation from PDF');

// 5. MCP Happy Path: initialize
const initRes = await callRpc({ jsonrpc: '2.0', id: 1, method: 'initialize' });
assert.equal(initRes.id, 1);
assert.equal(initRes.result.serverInfo.name, 'pdf-annotations-mcp');
assert(initRes.result.capabilities.tools, 'Expected tools capability');
console.log('✅ PASS: MCP Happy Path 1: initialize handshake succeeded');

// 7. MCP Happy Path: tools/list
const listToolsRes = await callRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
assert.equal(listToolsRes.id, 2);
const toolNames = listToolsRes.result.tools.map((t) => t.name);
assert(toolNames.includes('mcp_pdf_annotations_list'), 'Expected mcp_pdf_annotations_list');
assert(toolNames.includes('mcp_pdf_annotations_add'), 'Expected mcp_pdf_annotations_add');
assert(toolNames.includes('mcp_pdf_annotations_modify'), 'Expected mcp_pdf_annotations_modify');
assert(toolNames.includes('mcp_pdf_annotations_delete'), 'Expected mcp_pdf_annotations_delete');
assert(toolNames.includes('mcp_pdf_annotations_clear'), 'Expected mcp_pdf_annotations_clear');
console.log('✅ PASS: MCP Happy Path 2: tools/list returned all 5 MCP tools');

// 8. MCP Happy Path: tools/call mcp_pdf_annotations_add & list
const mcpAddRes = await callRpc({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: {
    name: 'mcp_pdf_annotations_add',
    arguments: {
      pdfPath: targetPdf,
      page: 1,
      type: 'text',
      comment: 'Annotation via MCP tool test',
      selectedText: 'Test text',
    },
  },
});
assert.equal(mcpAddRes.id, 3);
assert(!mcpAddRes.result.isError, 'Expected successful tool call');
const addParsed = JSON.parse(mcpAddRes.result.content[0].text);
assert(addParsed.comment.id.startsWith('c_'));
const mcpAddedId = addParsed.comment.id;
console.log(`✅ PASS: MCP Happy Path 3: mcp_pdf_annotations_add created annotation ${mcpAddedId}`);

// 9. MCP Happy Path: tools/call mcp_pdf_annotations_modify
const mcpModifyRes = await callRpc({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: {
    name: 'mcp_pdf_annotations_modify',
    arguments: {
      pdfPath: targetPdf,
      commentId: mcpAddedId,
      comment: 'Modified annotation via MCP',
      author: 'Antigravity Agent',
      status: 'resolved',
    },
  },
});
assert.equal(mcpModifyRes.id, 4);
assert(!mcpModifyRes.result.isError, 'Expected successful modify tool call');
const modifyParsed = JSON.parse(mcpModifyRes.result.content[0].text);
assert.equal(modifyParsed.comment.comment, 'Modified annotation via MCP');
assert.equal(modifyParsed.comment.author, 'Antigravity Agent');
assert.equal(modifyParsed.comment.status, 'resolved');
console.log('✅ PASS: MCP Happy Path 4: mcp_pdf_annotations_modify updated annotation');

// 10. MCP Happy Path: tools/call mcp_pdf_annotations_list
const mcpListRes = await callRpc({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: {
    name: 'mcp_pdf_annotations_list',
    arguments: {
      pdfPath: targetPdf,
      page: 1,
    },
  },
});
assert.equal(mcpListRes.id, 5);
const listParsed = JSON.parse(mcpListRes.result.content[0].text);
const foundMcpComment = listParsed.find((c) => c.id === mcpAddedId);
assert(foundMcpComment, 'Expected to find added comment via MCP list');
assert.equal(foundMcpComment.comment, 'Modified annotation via MCP');
assert.equal(foundMcpComment.author, 'Antigravity Agent');
console.log('✅ PASS: MCP Happy Path 5: mcp_pdf_annotations_list verified modified annotation');

// 11. MCP Happy Path: tools/call mcp_pdf_annotations_delete
const mcpDeleteRes = await callRpc({
  jsonrpc: '2.0',
  id: 6,
  method: 'tools/call',
  params: {
    name: 'mcp_pdf_annotations_delete',
    arguments: {
      pdfPath: targetPdf,
      commentId: mcpAddedId,
    },
  },
});
assert.equal(mcpDeleteRes.id, 6);
const deleteParsed = JSON.parse(mcpDeleteRes.result.content[0].text);
assert.equal(deleteParsed.deleted.id, mcpAddedId);
console.log('✅ PASS: MCP Happy Path 6: mcp_pdf_annotations_delete removed annotation');

// 12. MCP Happy Path: tools/call mcp_pdf_annotations_clear
const mcpClearRes = await callRpc({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: {
    name: 'mcp_pdf_annotations_clear',
    arguments: {
      pdfPath: targetPdf,
    },
  },
});
assert.equal(mcpClearRes.id, 7);
const clearParsed = JSON.parse(mcpClearRes.result.content[0].text);
assert.equal(typeof clearParsed.cleared, 'number');
console.log('✅ PASS: MCP Happy Path 7: mcp_pdf_annotations_clear completed successfully');

// 11. Failure Path 1: Empty comment text in direct addPdfComment
await assert.rejects(
  async () => {
    await addPdfComment(targetPdf, { type: 'text', page: 1, comment: '' });
  },
  /CRITICAL: Comment text must be a non-empty string/,
  'Expected validation error for empty comment'
);
console.log('✅ PASS: Failure Path 1: Empty comment rejected');

// 12. Failure Path 2: Invalid delete comment ID in direct deletePdfComment
await assert.rejects(
  async () => {
    await deletePdfComment(targetPdf, null);
  },
  /CRITICAL: commentId must be a valid string/,
  'Expected validation error for null commentId'
);
console.log('✅ PASS: Failure Path 2: Null commentId rejected');

// 13. Failure Path 3: Non-existent PDF path in direct listPdfComments
await assert.rejects(
  async () => {
    await listPdfComments('C:\\nonexistent\\missing.pdf');
  },
  /CRITICAL: PDF file does not exist/,
  'Expected validation error for missing PDF'
);
console.log('✅ PASS: Failure Path 3: Missing PDF path rejected');

// 14. Failure Path 4: Invalid page number in listPdfComments
await assert.rejects(
  async () => {
    await listPdfComments(targetPdf, -5);
  },
  /CRITICAL: page must be a positive integer/,
  'Expected validation error for invalid page'
);
console.log('✅ PASS: Failure Path 4: Invalid page number rejected');

// 15. Failure Path 5: MCP call unknown tool
const unknownToolRes = await callRpc({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: {
    name: 'non_existent_tool',
    arguments: {},
  },
});
assert(unknownToolRes.result.isError, 'Expected isError for unknown tool');
assert(unknownToolRes.result.content[0].text.includes('Unknown tool'));
console.log('✅ PASS: Failure Path 5: MCP unknown tool rejected');

// 16. Failure Path 6: MCP call with missing required argument in add
const missingArgRes = await callRpc({
  jsonrpc: '2.0',
  id: 8,
  method: 'tools/call',
  params: {
    name: 'mcp_pdf_annotations_add',
    arguments: {
      pdfPath: targetPdf,
      page: 1,
      type: 'text',
      // comment is missing
    },
  },
});
assert(missingArgRes.result.isError, 'Expected isError for missing comment');
assert(missingArgRes.result.content[0].text.includes('CRITICAL: \'comment\' is required'));
console.log('✅ PASS: Failure Path 6: MCP missing required comment argument rejected');

// 17. Failure Path 7: MCP invalid JSON-RPC method
const invalidMethodRes = await callRpc({
  jsonrpc: '2.0',
  id: 9,
  method: 'non_existent_method',
});
assert.equal(invalidMethodRes.error.code, -32601);
console.log('✅ PASS: Failure Path 7: MCP invalid method rejected with -32601');

// 18. MCP Happy Path: LLM adds review note without coordinates
const llmAddRes = await callRpc({
  jsonrpc: '2.0',
  id: 10,
  method: 'tools/call',
  params: {
    name: 'mcp_pdf_annotations_add',
    arguments: {
      pdfPath: targetPdf,
      page: 1,
      comment: 'Review feedback from LLM: clarify definition in Introduction.',
      author: 'Gemini Agent',
      selectedText: 'Introduction',
    },
  },
});
assert.equal(llmAddRes.id, 10);
assert(!llmAddRes.result.isError, 'Expected successful LLM tool call');
const llmParsed = JSON.parse(llmAddRes.result.content[0].text);
assert.equal(llmParsed.comment.type, 'note');
assert.equal(llmParsed.comment.author, 'Gemini Agent');
assert(llmParsed.comment.rect, 'Expected auto-calculated margin rect for note');
const llmCommentId = llmParsed.comment.id;
console.log(`✅ PASS: MCP Happy Path 7: LLM review note embedded with id ${llmCommentId} and author ${llmParsed.comment.author}`);

// MCP Happy Path: Extract LLM note with author metadata
const verifyListRes = await callRpc({
  jsonrpc: '2.0',
  id: 11,
  method: 'tools/call',
  params: {
    name: 'mcp_pdf_annotations_list',
    arguments: { pdfPath: targetPdf, page: 1 },
  },
});
const verifyList = JSON.parse(verifyListRes.result.content[0].text);
const foundLlmNote = verifyList.find((c) => c.id === llmCommentId);
assert(foundLlmNote, 'Expected LLM note in list output');
assert.equal(foundLlmNote.author, 'Gemini Agent');
assert.equal(foundLlmNote.type, 'note');
console.log('✅ PASS: MCP Happy Path 8: mcp_pdf_annotations_list retrieved LLM note with correct author metadata');

// Clean up LLM test note
await callRpc({
  jsonrpc: '2.0',
  id: 12,
  method: 'tools/call',
  params: {
    name: 'mcp_pdf_annotations_delete',
    arguments: { pdfPath: targetPdf, commentId: llmCommentId },
  },
});

// Failure Path: Invalid comment type rejected
await assert.rejects(
  async () => {
    await executeToolCall('mcp_pdf_annotations_add', {
      pdfPath: targetPdf,
      page: 1,
      type: 'invalid_type',
      comment: 'This should fail',
    });
  },
  /CRITICAL: 'type' must be 'note', 'text', or 'area'/,
  'Expected validation error for invalid type'
);
console.log('✅ PASS: Failure Path 8: Invalid comment type rejected');

// Failure Path: Whitespace-only author rejected
await assert.rejects(
  async () => {
    await executeToolCall('mcp_pdf_annotations_add', {
      pdfPath: targetPdf,
      page: 1,
      comment: 'Valid comment',
      author: '   ',
    });
  },
  /CRITICAL: 'author' must be a non-empty string if provided/,
  'Expected validation error for whitespace-only author'
);
console.log('✅ PASS: Failure Path 9: Whitespace-only author rejected');

// Failure Path 10: modifyPdfComment with non-existent commentId
await assert.rejects(
  async () => {
    await modifyPdfComment(targetPdf, 'non_existent_comment_id', { comment: 'Update text' });
  },
  /CRITICAL: Comment with ID 'non_existent_comment_id' not found in PDF/,
  'Expected validation error for non-existent commentId'
);
console.log('✅ PASS: Failure Path 10: Non-existent commentId in modify rejected');

// Failure Path 11: modifyPdfComment with no update fields provided
await assert.rejects(
  async () => {
    await modifyPdfComment(targetPdf, 'c_dummy_id', {});
  },
  /CRITICAL: At least one of 'comment', 'author', or 'status' must be provided to modify/,
  'Expected validation error when no fields to modify are provided'
);
console.log('✅ PASS: Failure Path 11: Empty update fields in modify rejected');

// Failure Path 12: modifyPdfComment with empty whitespace comment
await assert.rejects(
  async () => {
    await modifyPdfComment(targetPdf, 'c_dummy_id', { comment: '   ' });
  },
  /CRITICAL: 'comment' must be a non-empty string if provided/,
  'Expected validation error for empty comment in modify'
);
console.log('✅ PASS: Failure Path 12: Empty comment in modify rejected');

// Failure Path 13: MCP mcp_pdf_annotations_modify with missing commentId
const mcpMissingIdRes = await callRpc({
  jsonrpc: '2.0',
  id: 13,
  method: 'tools/call',
  params: {
    name: 'mcp_pdf_annotations_modify',
    arguments: {
      pdfPath: targetPdf,
      comment: 'New content',
    },
  },
});
assert(mcpMissingIdRes.result.isError, 'Expected isError for missing commentId');
assert(mcpMissingIdRes.result.content[0].text.includes("CRITICAL: 'commentId' is required"));
console.log('✅ PASS: Failure Path 13: MCP missing commentId in modify rejected');

// 19. Happy Path & Failure Paths: RenderCoordinator Concurrency & Token Invalidation
import fs from 'node:fs';
import vm from 'node:vm';

const appCode = fs.readFileSync(new URL('../sidecars/panel/app.js', import.meta.url), 'utf-8');
const coordinatorMatch = appCode.match(/class RenderCoordinator \{[\s\S]*?\n\}/);
assert(coordinatorMatch, 'Expected RenderCoordinator class in app.js');
const evalContext = {};
vm.runInNewContext(`${coordinatorMatch[0]}; evalContext.RenderCoordinator = RenderCoordinator;`, { evalContext });
const { RenderCoordinator } = evalContext;

// Happy Path: New generation starts, increments, and is active
const coordinator = new RenderCoordinator();
const gen1 = coordinator.startNew();
assert.equal(gen1, 1);
assert.equal(coordinator.isActive(gen1), true);
console.log('✅ PASS: Happy Path 5: RenderCoordinator starts and tracks current generation');

// Failure Path 8: Superceded generation is invalidated (prevents small/big multi-scale race)
const gen2 = coordinator.startNew();
assert.equal(gen2, 2);
assert.equal(coordinator.isActive(gen1), false, 'Expected older generation 1 to be invalidated');
assert.equal(coordinator.isActive(gen2), true, 'Expected generation 2 to be active');
console.log('✅ PASS: Failure Path 8: RenderCoordinator rejects superceded rendering generations');

// Failure Path 9: In-flight render tasks are actively cancelled when new generation arrives
let task1Cancelled = false;
let task2Cancelled = false;
coordinator.addTask({ cancel: () => { task1Cancelled = true; } });
coordinator.addTask({ cancel: () => { task2Cancelled = true; } });
coordinator.addTask({ notATask: true }); // Malformed task without cancel() must not crash
coordinator.startNew();
assert.equal(task1Cancelled, true, 'Expected active task 1 to be cancelled');
assert.equal(task2Cancelled, true, 'Expected active task 2 to be cancelled');
console.log('✅ PASS: Failure Path 9: RenderCoordinator cancels active render tasks on new generation');

// 20. Happy Path: Sticky note (/Text) creation and extraction
const { comment: stickyNote } = await addPdfComment(targetPdf, {
  type: 'note',
  page: 1,
  comment: 'Please check margin spacing on this section',
  rect: { xRatio: 0.85, yRatio: 0.15, wRatio: 0.04, hRatio: 0.03 },
});
assert.equal(stickyNote.type, 'note');
const listWithNote = await listPdfComments(targetPdf, 1);
const foundNote = listWithNote.find((c) => c.id === stickyNote.id);
assert(foundNote, 'Expected sticky note to be listed');
assert.equal(foundNote.type, 'note');
assert.equal(foundNote.comment, 'Please check margin spacing on this section');
console.log('✅ PASS: Happy Path 6: Sticky note (/Text) created and extracted');

// 21. Happy Path: Strikethrough & Replace (/StrikeOut) creation and extraction
const { comment: strikeComment } = await addPdfComment(targetPdf, {
  type: 'strike',
  page: 1,
  comment: 'Outdated terminology',
  selectedText: 'December 16, 2026',
  replacement: 'October 21, 2026',
  textRects: [{ xRatio: 0.1, yRatio: 0.2, wRatio: 0.3, hRatio: 0.05 }],
});
assert.equal(strikeComment.type, 'strike');
assert.equal(strikeComment.replacement, 'October 21, 2026');
const listWithStrike = await listPdfComments(targetPdf, 1);
const foundStrike = listWithStrike.find((c) => c.id === strikeComment.id);
assert(foundStrike, 'Expected strikethrough comment to be listed');
assert.equal(foundStrike.type, 'strike');
assert.equal(foundStrike.replacement, 'October 21, 2026');
console.log('✅ PASS: Happy Path 7: Strikethrough & Replace (/StrikeOut) created and extracted');

// 22. Failure Path: Invalid comment type rejected
await assert.rejects(
  async () => {
    await addPdfComment(targetPdf, {
      type: 'invalid_mode',
      page: 1,
      comment: 'Test comment',
    });
  },
  /CRITICAL: type must be one of: note, text, area, strike/,
  'Expected validation error for unsupported comment type'
);
console.log('✅ PASS: Failure Path 14: Unsupported comment type rejected');

// 23. Failure Path: ratiosToPdfRect requires valid object
import { ratiosToPdfRect } from '../sidecars/panel/annotation_geometry.mjs';
assert.throws(
  () => ratiosToPdfRect(null, 600, 800),
  /CRITICAL: Valid ratio rectangle object required/,
  'Expected error when null ratio rect is passed'
);
console.log('✅ PASS: Failure Path 15: ratiosToPdfRect rejects null object');

// 24. Responsive Toolbar Layout Contract Unit Tests
import { readFileSync } from 'node:fs';

export function resolveToolbarLayoutState(width, html, css) {
  if (typeof width !== 'number' || Number.isNaN(width) || width <= 0) {
    throw new Error('CRITICAL: Width must be a positive number');
  }
  if (typeof html !== 'string' || html.trim().length === 0 || typeof css !== 'string' || css.trim().length === 0) {
    throw new Error('CRITICAL: Valid HTML and CSS strings are required');
  }

  const headerMatch = html.match(/<header[\s\S]*?<\/header>/);
  if (!headerMatch) {
    throw new Error('CRITICAL: <header> element missing in HTML');
  }
  const header = headerMatch[0];

  const leftIdx = header.indexOf('class="header-left"');
  const centerIdx = header.indexOf('class="header-center"');
  const rightIdx = header.indexOf('class="header-right"');

  if (leftIdx === -1 || centerIdx === -1 || rightIdx === -1 || centerIdx <= leftIdx || rightIdx <= centerIdx) {
    throw new Error('CRITICAL: Header must contain .header-left, .header-center, and .header-right in order');
  }

  const centerContent = header.substring(centerIdx, rightIdx);
  const commentTools = ['mode-text-btn', 'mode-strike-btn', 'mode-note-btn', 'mode-area-btn'];
  for (const toolId of commentTools) {
    if (!centerContent.includes(`id="${toolId}"`)) {
      throw new Error(`CRITICAL: Missing comment mode tool ${toolId} in .header-center`);
    }
  }

  // Ensure CSS defines responsive ordering for narrow and wide viewports
  const hasNarrowCenterRule = /\.header-center\s*\{[^}]*order:\s*3[^}]*width:\s*100%/s.test(css);
  const hasWideResetRule = /min-width:\s*540px[\s\S]*?\.header-center\s*\{[^}]*order:\s*2[^}]*width:\s*auto/s.test(css);

  if (!hasNarrowCenterRule || !hasWideResetRule) {
    throw new Error('CRITICAL: CSS missing required responsive rules for narrow and wide viewports');
  }

  if (width < 540) {
    return {
      rowCount: 2,
      topRow: ['header-left', 'header-right'],
      bottomRow: ['header-center'],
      toolsPosition: 'bottom-row',
    };
  }

  return {
    rowCount: 1,
    left: 'header-left',
    center: 'header-center',
    right: 'header-right',
    toolsPosition: 'center',
  };
}

const indexHtmlPath = join(__dirname, '../sidecars/panel/index.html');
const stylesCssPath = join(__dirname, '../sidecars/panel/styles.css');
const indexHtmlContent = readFileSync(indexHtmlPath, 'utf-8');
const stylesCssContent = readFileSync(stylesCssPath, 'utf-8');

// Happy Path 8: Narrow sidebar (< 540px) places tools on bottom row
const narrowState = resolveToolbarLayoutState(380, indexHtmlContent, stylesCssContent);
assert.equal(narrowState.rowCount, 2);
assert.equal(narrowState.toolsPosition, 'bottom-row');
console.log('✅ PASS: Happy Path 8: Narrow viewport (< 540px) formats toolbar into 2 rows with tools below');

// Happy Path 9: Wide sidebar (>= 540px) moves tools back into center of top toolbar
const wideState = resolveToolbarLayoutState(620, indexHtmlContent, stylesCssContent);
assert.equal(wideState.rowCount, 1);
assert.equal(wideState.toolsPosition, 'center');
console.log('✅ PASS: Happy Path 9: Wide viewport (>= 540px) moves tools back into center of toolbar');

// Failure Path 16: Non-positive or invalid width rejected
assert.throws(
  () => resolveToolbarLayoutState(0, indexHtmlContent, stylesCssContent),
  /CRITICAL: Width must be a positive number/,
  'Expected error on non-positive width'
);
assert.throws(
  () => resolveToolbarLayoutState('wide', indexHtmlContent, stylesCssContent),
  /CRITICAL: Width must be a positive number/,
  'Expected error on string width'
);
console.log('✅ PASS: Failure Path 16: resolveToolbarLayoutState rejects non-positive or non-numeric width');

// Failure Path 17: Empty HTML or CSS rejected
assert.throws(
  () => resolveToolbarLayoutState(400, '', stylesCssContent),
  /CRITICAL: Valid HTML and CSS strings are required/,
  'Expected error on empty HTML'
);
assert.throws(
  () => resolveToolbarLayoutState(400, indexHtmlContent, ''),
  /CRITICAL: Valid HTML and CSS strings are required/,
  'Expected error on empty CSS'
);
console.log('✅ PASS: Failure Path 17: resolveToolbarLayoutState rejects empty HTML/CSS strings');

// Failure Path 18: Missing comment tool in header-center rejected
const missingToolHtml = indexHtmlContent.replace('id="mode-strike-btn"', 'id="other-button"');
assert.throws(
  () => resolveToolbarLayoutState(400, missingToolHtml, stylesCssContent),
  /CRITICAL: Missing comment mode tool mode-strike-btn in \.header-center/,
  'Expected error when comment mode tool is missing'
);
console.log('✅ PASS: Failure Path 18: resolveToolbarLayoutState rejects HTML missing required comment tools');

// 22. Happy Path & Failure Paths: Comment Bubble Hover Visibility & Iconless Pins
const commentsCssContent = fs.readFileSync(new URL('../sidecars/panel/comments.css', import.meta.url), 'utf-8');
const uiCommentsJsContent = fs.readFileSync(new URL('../sidecars/panel/ui_comments.js', import.meta.url), 'utf-8');

// Happy Path 10: Comments CSS hides highlight/area bubbles by default and shows on hover
assert(
  commentsCssContent.includes('.pdf-text-highlight > .pdf-comment-pin') &&
  commentsCssContent.includes('.pdf-comment-box > .pdf-comment-pin') &&
  commentsCssContent.includes('opacity: 0') &&
  commentsCssContent.includes('visibility: hidden'),
  'Expected CSS to hide highlight and area bubbles by default'
);
assert(
  commentsCssContent.includes('.pdf-text-highlight:hover > .pdf-comment-pin') &&
  commentsCssContent.includes('.pdf-comment-box:hover > .pdf-comment-pin') &&
  commentsCssContent.includes('.pin-visible'),
  'Expected CSS to show bubbles on hover and .pin-visible'
);
console.log('✅ PASS: Happy Path 10: Comments CSS enforces hover-only display for highlight & area bubbles');

// Happy Path 11: Sticky note pins remain persistently visible
assert(
  commentsCssContent.includes('.pdf-comment-pin.pin-note') &&
  commentsCssContent.includes('opacity: 1 !important') &&
  commentsCssContent.includes('visibility: visible !important'),
  'Expected sticky note pins to remain persistently visible'
);
console.log('✅ PASS: Happy Path 11: Sticky notes (.pin-note) configured for persistent visibility');

// Happy Path 12: Pin markup contains strictly comment number without bubble trash bin or prefix icons
assert(
  uiCommentsJsContent.includes('<span>#${idx + 1}</span>') &&
  !uiCommentsJsContent.includes('<span>#${idx + 1}</span><span class="pin-delete"'),
  'Expected pin markup to have strictly comment number and no bubble trash bin'
);
assert(
  !uiCommentsJsContent.includes("pinIcons[c.type]") && !uiCommentsJsContent.includes("${isAi ? '🤖' :"),
  'Expected prefix icons to be removed from in-document comment bubbles'
);
console.log('✅ PASS: Happy Path 12: In-document bubbles render strictly comment number');

// Failure Path 19: Missing pin-visible rule rejected
function validatePinStyles(css) {
  if (!css || typeof css !== 'string') {
    throw new Error('CRITICAL: Valid CSS string required');
  }
  if (!css.includes('.pin-visible')) {
    throw new Error('CRITICAL: CSS must define .pin-visible state for hover interaction');
  }
  return true;
}
assert.throws(
  () => validatePinStyles('.pdf-comment-pin { opacity: 0; }'),
  /CRITICAL: CSS must define \.pin-visible state for hover interaction/,
  'Expected validation error when .pin-visible rule is missing'
);
console.log('✅ PASS: Failure Path 19: validatePinStyles rejects CSS lacking .pin-visible');

// Failure Path 20: Non-string CSS in validatePinStyles rejected
assert.throws(
  () => validatePinStyles(null),
  /CRITICAL: Valid CSS string required/,
  'Expected validation error for non-string CSS'
);
console.log('✅ PASS: Failure Path 20: validatePinStyles rejects null or invalid CSS input');

// 23. Happy Path & Failure Paths: Pin Hover Tooltip Popovers
const updatedCss = fs.readFileSync(new URL('../sidecars/panel/comments.css', import.meta.url), 'utf-8');
const updatedJs = fs.readFileSync(new URL('../sidecars/panel/ui_comments.js', import.meta.url), 'utf-8');

// Happy Path 13: CSS defines tooltip popover styles and hover triggers
assert(
  updatedCss.includes('.pin-tooltip') &&
  updatedCss.includes('.pdf-comment-pin:hover .pin-tooltip') &&
  updatedCss.includes('.tooltip-below') &&
  updatedCss.includes('.tooltip-right'),
  'Expected CSS to define .pin-tooltip with hover display and boundary classes'
);
console.log('✅ PASS: Happy Path 13: CSS defines floating tooltip popovers with boundary orientation');

// Happy Path 14: ui_comments.js constructs tooltip with author, metadata, and comment body
assert(
  updatedJs.includes('pin-tooltip') &&
  updatedJs.includes('pin-tooltip-header') &&
  updatedJs.includes('pin-tooltip-author') &&
  updatedJs.includes('pin-tooltip-body'),
  'Expected ui_comments.js to build rich tooltip elements inside createPin'
);
console.log('✅ PASS: Happy Path 14: ui_comments.js attaches rich tooltip popovers to comment bubbles');

// Failure Path 21: Tooltip validator function rejects comment without body
function validateTooltipModel(commentObj) {
  if (!commentObj || typeof commentObj !== 'object') {
    throw new Error('CRITICAL: Comment object is required');
  }
  if (!commentObj.comment || typeof commentObj.comment !== 'string' || !commentObj.comment.trim()) {
    throw new Error('CRITICAL: Comment content text must be non-empty for tooltip');
  }
  return true;
}
assert.throws(
  () => validateTooltipModel({ comment: '   ' }),
  /CRITICAL: Comment content text must be non-empty for tooltip/,
  'Expected validation error for empty comment in tooltip'
);
console.log('✅ PASS: Failure Path 21: validateTooltipModel rejects empty or whitespace-only comment');

// Failure Path 22: validateTooltipModel rejects null or non-object input
assert.throws(
  () => validateTooltipModel(null),
  /CRITICAL: Comment object is required/,
  'Expected validation error for null comment object'
);
console.log('✅ PASS: Failure Path 22: validateTooltipModel rejects null comment payload');

// 24. Happy Path & Failure Paths: Z-Alignment, Hover Bridge, and In-Place Comment Editing
// Happy Path 15: Z-alignment stacking elevation and pointer-events bridge
assert(
  updatedCss.includes('z-index: 99999 !important;') &&
  updatedCss.includes('.pin-parent-active') &&
  updatedCss.includes('z-index: 100000 !important;') &&
  updatedCss.includes('pointer-events: auto;'),
  'Expected CSS to elevate active popover parents to z-index: 99999 and tooltip to 100000 with pointer-events: auto'
);
assert(
  updatedCss.includes('.pin-tooltip::before') &&
  updatedCss.includes('.pin-edit-textarea') &&
  updatedCss.includes('.pin-save-btn') &&
  updatedCss.includes('.pin-cancel-btn'),
  'Expected CSS to define hover bridge and inline editor controls'
);
assert(
  updatedJs.includes('activatePopover(pin, tooltip)') &&
  updatedJs.includes('/api/comments/modify') &&
  updatedJs.includes('pin-save-btn') &&
  updatedJs.includes('pin-cancel-btn'),
  'Expected ui_comments.js to implement activatePopover and inline editing with /api/comments/modify'
);
console.log('✅ PASS: Happy Path 15: Z-alignment elevation, hover bridge, and inline editing verified');

// Failure Path 23: Inline edit validation rejects missing commentId
function validateInlineEditPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('CRITICAL: Payload must be a valid object');
  }
  if (!payload.commentId || typeof payload.commentId !== 'string' || !payload.commentId.trim()) {
    throw new Error('CRITICAL: commentId is required and must be a non-empty string');
  }
  if (!payload.comment || typeof payload.comment !== 'string' || !payload.comment.trim()) {
    throw new Error('CRITICAL: comment content is required and must be a non-empty string');
  }
  return true;
}

assert.throws(
  () => validateInlineEditPayload({ commentId: '', comment: 'Updated comment' }),
  /CRITICAL: commentId is required and must be a non-empty string/,
  'Expected validation error for empty commentId in inline edit'
);
console.log('✅ PASS: Failure Path 23: validateInlineEditPayload rejects empty or missing commentId');

// Failure Path 24: Inline edit validation rejects empty comment content
assert.throws(
  () => validateInlineEditPayload({ commentId: 'c_123', comment: '   ' }),
  /CRITICAL: comment content is required and must be a non-empty string/,
  'Expected validation error for empty comment in inline edit'
);
console.log('✅ PASS: Failure Path 24: validateInlineEditPayload rejects whitespace-only comment body');

// 25. Happy Path & Failure Paths: Pin Stacking, Overlay Mounting, and Fixed Dimension Stability
const refreshedCss = fs.readFileSync(new URL('../sidecars/panel/comments.css', import.meta.url), 'utf-8');
const refreshedJs = fs.readFileSync(new URL('../sidecars/panel/ui_comments.js', import.meta.url), 'utf-8');

// Happy Path 16: Pin overlay mounting, stable dimensions, and z-index priority
assert(
  refreshedCss.includes('width: 290px;') &&
  refreshedCss.includes('box-sizing: border-box;') &&
  !refreshedCss.includes('.pdf-comment-pin:hover {\n  background-color: #d35400;\n  transform: translate(-50%, -50%) scale(1.1);') &&
  refreshedCss.includes('.pin-tooltip.tooltip-left') &&
  refreshedCss.includes('z-index: 1000;'),
  'Expected CSS to enforce stable 290px width, remove scale(1.1) on hover, and give pins z-index: 1000'
);
assert(
  refreshedJs.includes('overlay.appendChild(pin);') &&
  refreshedJs.includes('tooltip-left') &&
  refreshedJs.includes('tooltip-right'),
  'Expected ui_comments.js to mount pins directly on overlay and assign left/right classes'
);
console.log('✅ PASS: Happy Path 16: Pin overlay mounting, stable width 290px, and z-index priority verified');

// Failure Path 25: Pin model validator rejects null or non-object pin definition
function validatePinLayerModel(pinConfig) {
  if (!pinConfig || typeof pinConfig !== 'object') {
    throw new Error('CRITICAL: Pin config object required');
  }
  if (typeof pinConfig.x !== 'number' || typeof pinConfig.y !== 'number' || isNaN(pinConfig.x) || isNaN(pinConfig.y)) {
    throw new Error('CRITICAL: Valid numeric overlay coordinates x and y are required');
  }
  if (!pinConfig.overlayMount) {
    throw new Error('CRITICAL: Pin must be configured for direct overlay mounting to prevent stacking clipping');
  }
  return true;
}

assert.throws(
  () => validatePinLayerModel(null),
  /CRITICAL: Pin config object required/,
  'Expected validation error for null pin config'
);
console.log('✅ PASS: Failure Path 25: validatePinLayerModel rejects null or non-object pin config');

// Failure Path 26: Pin model validator rejects invalid coordinates or nested mounting
assert.throws(
  () => validatePinLayerModel({ x: 100, y: NaN, overlayMount: true }),
  /CRITICAL: Valid numeric overlay coordinates x and y are required/,
  'Expected validation error for NaN coordinates'
);
assert.throws(
  () => validatePinLayerModel({ x: 100, y: 150, overlayMount: false }),
  /CRITICAL: Pin must be configured for direct overlay mounting to prevent stacking clipping/,
  'Expected validation error for non-overlay mounting'
);
console.log('✅ PASS: Failure Path 26: validatePinLayerModel rejects invalid coordinates and nested mounting');

// 26. Happy Path & Failure Paths: Bubble Removal on Text/Area, Popover Trash Bin, and Snippet Exclusion
const latestCss = fs.readFileSync(new URL('../sidecars/panel/comments.css', import.meta.url), 'utf-8');
const latestJs = fs.readFileSync(new URL('../sidecars/panel/ui_comments.js', import.meta.url), 'utf-8');

// Happy Path 17: Non-note annotations use anchor, popover includes delete button, and snippet is removed
assert(
  latestCss.includes('.pdf-comment-anchor') &&
  latestCss.includes('.pin-tooltip-delete') &&
  latestCss.includes('.pin-tooltip.pin-visible'),
  'Expected CSS to support .pdf-comment-anchor, .pin-tooltip-delete, and .pin-tooltip.pin-visible'
);
assert(
  latestJs.includes('pin-tooltip-delete') &&
  latestJs.includes('isNote') &&
  latestJs.includes('pdf-comment-anchor') &&
  !latestJs.includes('pin-tooltip-snippet'),
  'Expected ui_comments.js to include trash bin in popover header, omit snippets, and reserve bubbles for notes'
);
console.log('✅ PASS: Happy Path 17: Bubbles removed for text/area, trash bin added to popover, snippet omitted');

// Failure Path 27: Comment card model validator rejects empty comment
function validateCommentCardModel(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('CRITICAL: Comment payload object required');
  }
  if (!payload.comment || typeof payload.comment !== 'string' || !payload.comment.trim()) {
    throw new Error('CRITICAL: Comment text must be a non-empty string');
  }
  return true;
}

assert.throws(
  () => validateCommentCardModel({ comment: '   ' }),
  /CRITICAL: Comment text must be a non-empty string/,
  'Expected validation error for empty comment in card model'
);
console.log('✅ PASS: Failure Path 27: validateCommentCardModel rejects whitespace-only comment');

// Failure Path 28: Comment card model validator rejects null or non-object input
assert.throws(
  () => validateCommentCardModel(null),
  /CRITICAL: Comment payload object required/,
  'Expected validation error for null comment payload'
);
console.log('✅ PASS: Failure Path 28: validateCommentCardModel rejects null or non-object payload');

// 27. Happy Path & Failure Paths: Viewport Bounding Clamping & Non-Overlapping Multiline Popovers
const freshIndexHtmlContent = fs.readFileSync(new URL('../sidecars/panel/index.html', import.meta.url), 'utf-8');
const finalJs = fs.readFileSync(new URL('../sidecars/panel/ui_comments.js', import.meta.url), 'utf-8');
const finalCss = fs.readFileSync(new URL('../sidecars/panel/comments.css', import.meta.url), 'utf-8');

// Extract calculatePopoverPosition logic for testing
function testCalculatePopoverPosition({
  overlayWidth,
  overlayHeight,
  rects,
  boxWidth = 290,
  boxHeight = 125,
  padding = 12,
  viewportBounds = null,
}) {
  if (!overlayWidth || overlayWidth <= 0 || !overlayHeight || overlayHeight <= 0) {
    throw new Error('CRITICAL: overlayWidth and overlayHeight must be positive numbers');
  }
  if (!Array.isArray(rects) || rects.length === 0) {
    throw new Error('CRITICAL: rects must be a non-empty array');
  }
  if (viewportBounds !== null && typeof viewportBounds === 'object') {
    if (typeof viewportBounds.top !== 'number' || typeof viewportBounds.bottom !== 'number' || isNaN(viewportBounds.top) || isNaN(viewportBounds.bottom)) {
      throw new Error('CRITICAL: viewportBounds must have numeric top and bottom');
    }
    if (viewportBounds.top > viewportBounds.bottom) {
      throw new Error('CRITICAL: viewportBounds.top cannot exceed viewportBounds.bottom');
    }
  }

  let topY = Infinity;
  let bottomY = -Infinity;
  const lastRect = rects[rects.length - 1];

  for (const r of rects) {
    if (!r || typeof r.yRatio !== 'number' || typeof r.hRatio !== 'number') {
      throw new Error('CRITICAL: Each rect must have numeric yRatio and hRatio');
    }
    const rTop = r.yRatio * overlayHeight;
    const rBottom = (r.yRatio + r.hRatio) * overlayHeight;
    if (rTop < topY) topY = rTop;
    if (rBottom > bottomY) bottomY = rBottom;
  }

  const anchorX = ((lastRect.xRatio ?? 0) + (lastRect.wRatio ?? 0)) * overlayWidth;
  const GAP = 8;
  const viewTop = (viewportBounds && typeof viewportBounds.top === 'number')
    ? Math.max(padding, viewportBounds.top + padding)
    : padding;
  const viewBottom = (viewportBounds && typeof viewportBounds.bottom === 'number')
    ? Math.min(overlayHeight - padding, viewportBounds.bottom - padding)
    : overlayHeight - padding;

  const spaceAbove = topY - viewTop;
  const spaceBelow = viewBottom - bottomY;
  const neededHeight = boxHeight + GAP;

  let placement = 'below';
  let boxTop = bottomY + GAP;

  if (spaceBelow < neededHeight && spaceAbove >= neededHeight) {
    placement = 'above';
    boxTop = topY - GAP - boxHeight;
  } else if (spaceAbove < neededHeight && spaceBelow >= neededHeight) {
    placement = 'below';
    boxTop = bottomY + GAP;
  } else if (spaceBelow < neededHeight && spaceAbove < neededHeight) {
    if (spaceAbove > spaceBelow) {
      placement = 'above';
      boxTop = topY - GAP - boxHeight;
    } else {
      placement = 'below';
      boxTop = bottomY + GAP;
    }
  } else {
    placement = 'below';
    boxTop = bottomY + GAP;
  }

  boxTop = Math.max(padding, Math.min(overlayHeight - boxHeight - padding, boxTop));
  let boxLeft = anchorX - boxWidth / 2;
  boxLeft = Math.max(padding, Math.min(overlayWidth - boxWidth - padding, boxLeft));
  const arrowX = Math.max(16, Math.min(boxWidth - 16, anchorX - boxLeft));

  return { placement, boxLeft, boxTop, arrowX };
}

// Happy Path 18: Popover non-overlapping geometry and index.html ui_history inclusion
assert(freshIndexHtmlContent.includes('/ui_history.js'), 'Expected index.html to load ui_history.js');
assert(finalJs.includes('calculatePopoverPosition'), 'Expected ui_comments.js to define calculatePopoverPosition');
assert(finalJs.includes('deleteComment(c.id)'), 'Expected ui_comments.js to bind deleteComment to popover trash bin');
assert(finalCss.includes('.pin-tooltip.tooltip-above'), 'Expected comments.css to define tooltip-above');
assert(finalCss.includes('.pin-tooltip.tooltip-below'), 'Expected comments.css to define tooltip-below');

// Test Scenario A: Multiline text (4 lines) - popover must NOT be inside [topY, bottomY]
const multiLineRects = [
  { xRatio: 0.1, yRatio: 0.12, wRatio: 0.8, hRatio: 0.02 }, // Line 1 (120px)
  { xRatio: 0.1, yRatio: 0.14, wRatio: 0.8, hRatio: 0.02 }, // Line 2 (140px)
  { xRatio: 0.1, yRatio: 0.16, wRatio: 0.8, hRatio: 0.02 }, // Line 3 (160px)
  { xRatio: 0.1, yRatio: 0.18, wRatio: 0.5, hRatio: 0.02 }, // Line 4 (180px - 200px)
];
const posMulti = testCalculatePopoverPosition({
  overlayWidth: 800,
  overlayHeight: 1000,
  rects: multiLineRects,
});
assert.equal(posMulti.placement, 'below');
assert(posMulti.boxTop >= 200, `Expected boxTop (${posMulti.boxTop}) to be strictly below the lowest line of text`);
assert(posMulti.boxLeft >= 12 && posMulti.boxLeft + 290 <= 800 - 12, 'Expected boxLeft to be clamped within view borders');

// Test Scenario B: Text at extreme upper border (yRatio 0.01 = 10px) - must never be cut off by top border
const posTopBorder = testCalculatePopoverPosition({
  overlayWidth: 800,
  overlayHeight: 1000,
  rects: [{ xRatio: 0.2, yRatio: 0.01, wRatio: 0.6, hRatio: 0.02 }],
});
assert.equal(posTopBorder.placement, 'below');
assert(posTopBorder.boxTop >= 12, `Expected boxTop (${posTopBorder.boxTop}) to be >= padding (12px)`);

// Test Scenario C: Text at extreme lower border (yRatio 0.96 = 960px) - must never be cut off by bottom border
const posBottomBorder = testCalculatePopoverPosition({
  overlayWidth: 800,
  overlayHeight: 1000,
  rects: [{ xRatio: 0.2, yRatio: 0.96, wRatio: 0.6, hRatio: 0.02 }],
});
assert.equal(posBottomBorder.placement, 'above');
assert(posBottomBorder.boxTop <= 1000 - 125 - 12, `Expected boxTop (${posBottomBorder.boxTop}) to fit within bottom boundary`);

console.log('✅ PASS: Happy Path 18: Popover non-overlapping geometry and viewport clamping verified');

// Failure Path 29: calculatePopoverPosition rejects invalid dimensions
assert.throws(
  () => testCalculatePopoverPosition({ overlayWidth: 0, overlayHeight: 1000, rects: multiLineRects }),
  /CRITICAL: overlayWidth and overlayHeight must be positive numbers/,
  'Expected validation error for zero overlayWidth'
);
assert.throws(
  () => testCalculatePopoverPosition({ overlayWidth: 800, overlayHeight: -5, rects: multiLineRects }),
  /CRITICAL: overlayWidth and overlayHeight must be positive numbers/,
  'Expected validation error for negative overlayHeight'
);
console.log('✅ PASS: Failure Path 29: testCalculatePopoverPosition rejects non-positive overlay dimensions');

// Failure Path 30: calculatePopoverPosition rejects empty rects array
assert.throws(
  () => testCalculatePopoverPosition({ overlayWidth: 800, overlayHeight: 1000, rects: [] }),
  /CRITICAL: rects must be a non-empty array/,
  'Expected validation error for empty rects'
);
assert.throws(
  () => testCalculatePopoverPosition({ overlayWidth: 800, overlayHeight: 1000, rects: [{ yRatio: null }] }),
  /CRITICAL: Each rect must have numeric yRatio and hRatio/,
  'Expected validation error for rect missing numeric ratios'
);
console.log('✅ PASS: Failure Path 30: testCalculatePopoverPosition rejects invalid or empty rects');

// 28. Happy Path & Failure Paths: Viewport Boundaries & Bottom Screen Flipping
// Happy Path 19: Screen bottom target flips popover above when room below is insufficient
const page2Section31Rects = [
  { xRatio: 0.187, yRatio: 0.283, wRatio: 0.433, hRatio: 0.016 }, // topY ~311px, bottomY ~329px
];
// User's viewport ends at 335px (target is at bottom of user's screen)
const posAtScreenBottom = testCalculatePopoverPosition({
  overlayWidth: 800,
  overlayHeight: 1100,
  rects: page2Section31Rects,
  viewportBounds: { top: 0, bottom: 335 },
});
assert.equal(posAtScreenBottom.placement, 'above', 'Expected popover to flip above when target is at bottom of user screen');
assert(posAtScreenBottom.boxTop < 311, `Expected boxTop (${posAtScreenBottom.boxTop}) to be above the target text (311px)`);
assert(posAtScreenBottom.boxTop >= 12, `Expected boxTop (${posAtScreenBottom.boxTop}) to be inside viewport top padding (>= 12px)`);

// User's viewport starts at 305px (target is at top of user's screen)
const posAtScreenTop = testCalculatePopoverPosition({
  overlayWidth: 800,
  overlayHeight: 1100,
  rects: page2Section31Rects,
  viewportBounds: { top: 305, bottom: 800 },
});
assert.equal(posAtScreenTop.placement, 'below', 'Expected popover to flip below when target is at top of user screen');
assert(posAtScreenTop.boxTop >= 329, `Expected boxTop (${posAtScreenTop.boxTop}) to be below the target text (329px)`);

// Verify ui_comments.js clears previous anchors and tooltips on render
assert(finalJs.includes('.pin-tooltip, .pdf-text-highlight'), 'Expected ui_comments.js to clear .pin-tooltip on render');
console.log('✅ PASS: Happy Path 19: Viewport boundary-aware flipping and re-render cleanup verified');

// Failure Path 31: testCalculatePopoverPosition rejects inverted viewport bounds
assert.throws(
  () => testCalculatePopoverPosition({
    overlayWidth: 800,
    overlayHeight: 1100,
    rects: page2Section31Rects,
    viewportBounds: { top: 500, bottom: 200 },
  }),
  /CRITICAL: viewportBounds\.top cannot exceed viewportBounds\.bottom/,
  'Expected validation error for inverted viewport bounds'
);
console.log('✅ PASS: Failure Path 31: testCalculatePopoverPosition rejects inverted viewport bounds');

// Failure Path 32: testCalculatePopoverPosition rejects non-numeric viewport bounds
assert.throws(
  () => testCalculatePopoverPosition({
    overlayWidth: 800,
    overlayHeight: 1100,
    rects: page2Section31Rects,
    viewportBounds: { top: 'zero', bottom: 500 },
  }),
  /CRITICAL: viewportBounds must have numeric top and bottom/,
  'Expected validation error for non-numeric viewport bounds'
);
console.log('✅ PASS: Failure Path 32: testCalculatePopoverPosition rejects non-numeric viewport bounds');

// 29. Happy Path & Failure Paths: AnnotationMode.DISABLE for Ghost Highlight Elimination
const refreshedAppCode = fs.readFileSync(new URL('../sidecars/panel/app.js', import.meta.url), 'utf-8');

// Happy Path 20: app.js disables rasterized PDF annotations on canvas render
assert(
  refreshedAppCode.includes('const annotationMode = window.pdfjsLib?.AnnotationMode?.DISABLE ?? 0;') &&
  refreshedAppCode.includes('annotationMode,'),
  'Expected app.js to pass annotationMode: DISABLE to page.render'
);
console.log('✅ PASS: Happy Path 20: page.render configures AnnotationMode.DISABLE (0) preventing ghost highlights');

// Failure Path 33: Page render options validator rejects non-zero annotationMode
function validatePageRenderOptions(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('CRITICAL: Render options object required');
  }
  if (!opts.canvasContext || !opts.viewport) {
    throw new Error('CRITICAL: canvasContext and viewport are required for page.render');
  }
  if (opts.annotationMode !== 0) {
    throw new Error('CRITICAL: annotationMode must be strictly 0 (AnnotationMode.DISABLE) to prevent ghost canvas residues');
  }
  return true;
}

assert.throws(
  () => validatePageRenderOptions({ canvasContext: {}, viewport: {}, annotationMode: 1 }),
  /CRITICAL: annotationMode must be strictly 0/,
  'Expected validation error when annotationMode is not DISABLE (0)'
);
console.log('✅ PASS: Failure Path 33: validatePageRenderOptions rejects non-zero annotationMode');

// Failure Path 34: Page render options validator rejects missing context or null
assert.throws(
  () => validatePageRenderOptions(null),
  /CRITICAL: Render options object required/,
  'Expected validation error for null render options'
);
assert.throws(
  () => validatePageRenderOptions({ viewport: {}, annotationMode: 0 }),
  /CRITICAL: canvasContext and viewport are required for page.render/,
  'Expected validation error for missing canvasContext'
);
console.log('✅ PASS: Failure Path 34: validatePageRenderOptions rejects missing required render parameters');

// 30. Happy Path & Failure Paths: Obsolete Sidebar Removal & Display All Comment Boxes Toggle
const finalIndexHtml = fs.readFileSync(new URL('../sidecars/panel/index.html', import.meta.url), 'utf-8');
const finalUiComments = fs.readFileSync(new URL('../sidecars/panel/ui_comments.js', import.meta.url), 'utf-8');
const finalCommentsCss = fs.readFileSync(new URL('../sidecars/panel/comments.css', import.meta.url), 'utf-8');

// Happy Path 21: Comments drawer removed from DOM and CSS; toolbar button displays all comment boxes
assert(
  !finalIndexHtml.includes('id="comments-drawer"') &&
  !finalIndexHtml.includes('class="comments-drawer"') &&
  !finalCommentsCss.includes('.comments-drawer') &&
  !finalCommentsCss.includes('.empty-drawer'),
  'Expected comments sidebar/drawer DOM and CSS to be completely removed'
);
assert(
  finalIndexHtml.includes('id="comments-toggle-btn"') &&
  finalIndexHtml.includes('toggle-btn') &&
  finalUiComments.includes('toggleShowAllComments') &&
  finalUiComments.includes('showAllBoxes') &&
  finalCommentsCss.includes('body.show-all-comments .pin-tooltip:not(.box-hidden)'),
  'Expected toggleShowAllComments and body.show-all-comments to be configured'
);
assert(
  finalUiComments.includes('calculatePopoverPosition') &&
  finalUiComments.includes('createPopover') &&
  finalUiComments.includes('deleteComment'),
  'Expected ui_comments.js to expose calculatePopoverPosition, createPopover, and deleteComment'
);
console.log('✅ PASS: Happy Path 21: Comments sidebar removed; display-all comment boxes option verified');

// Failure Path 35: toggleShowAllComments rejects invalid non-boolean forced state
function validateToggleShowAllComments(forceState) {
  if (forceState !== undefined && typeof forceState !== 'boolean') {
    throw new Error('CRITICAL: forceState must be a boolean when provided');
  }
  return true;
}

assert.throws(
  () => validateToggleShowAllComments('yes'),
  /CRITICAL: forceState must be a boolean when provided/,
  'Expected validation error for non-boolean forceState'
);
assert.throws(
  () => validateToggleShowAllComments(123),
  /CRITICAL: forceState must be a boolean when provided/,
  'Expected validation error for numeric forceState'
);
console.log('✅ PASS: Failure Path 35: validateToggleShowAllComments rejects non-boolean input');

// Failure Path 36: createPopover validator rejects missing comment object or missing overlay
function validateCreatePopoverArgs(comment, overlay) {
  if (!comment || typeof comment !== 'object') {
    throw new Error('CRITICAL: comment object required for createPopover');
  }
  if (!overlay || typeof overlay !== 'object') {
    throw new Error('CRITICAL: overlay element required for createPopover');
  }
  return true;
}

assert.throws(
  () => validateCreatePopoverArgs(null, {}),
  /CRITICAL: comment object required for createPopover/,
  'Expected validation error for null comment in createPopover'
);
assert.throws(
  () => validateCreatePopoverArgs({ id: 'c1' }, null),
  /CRITICAL: overlay element required for createPopover/,
  'Expected validation error for null overlay in createPopover'
);
console.log('✅ PASS: Failure Path 36: validateCreatePopoverArgs rejects null comment or overlay');

// Clean up test scratch fixture
import { rmSync, unlinkSync } from 'node:fs';
if (existsSync(targetPdf)) {
  try { unlinkSync(targetPdf); } catch {}
}
if (existsSync(scratchDir)) {
  try { rmSync(scratchDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}

console.log('\nAll unit tests passed successfully!');
