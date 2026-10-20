import assert from 'node:assert/strict';
import {
  addPdfComment,
  deletePdfComment,
  findWorkspacePdfs,
  listPdfComments,
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
const targetPdf = pdfs[0].path;
console.log(`✅ PASS: Happy Path 1: findWorkspacePdfs found ${targetPdf}`);

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

// 4. Happy Path: Delete annotation from PDF
const { deleted } = await deletePdfComment(targetPdf, added.id);
assert(deleted && deleted.id === added.id, 'Expected deletePdfComment to return deleted comment object');
const afterDelete = await listPdfComments(targetPdf);
assert(!afterDelete.some((c) => c.id === added.id), 'Expected annotation to be removed from PDF');
console.log('✅ PASS: Happy Path 4: deletePdfComment removed annotation from PDF');

// 5. MCP Happy Path: initialize
const initRes = await callRpc({ jsonrpc: '2.0', id: 1, method: 'initialize' });
assert.equal(initRes.id, 1);
assert.equal(initRes.result.serverInfo.name, 'pdf-annotations-mcp');
assert(initRes.result.capabilities.tools, 'Expected tools capability');
console.log('✅ PASS: MCP Happy Path 1: initialize handshake succeeded');

// 6. MCP Happy Path: tools/list
const listToolsRes = await callRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
assert.equal(listToolsRes.id, 2);
const toolNames = listToolsRes.result.tools.map((t) => t.name);
assert(toolNames.includes('mcp_pdf_annotations_list'), 'Expected mcp_pdf_annotations_list');
assert(toolNames.includes('mcp_pdf_annotations_add'), 'Expected mcp_pdf_annotations_add');
assert(toolNames.includes('mcp_pdf_annotations_delete'), 'Expected mcp_pdf_annotations_delete');
assert(toolNames.includes('mcp_pdf_annotations_clear'), 'Expected mcp_pdf_annotations_clear');
console.log('✅ PASS: MCP Happy Path 2: tools/list returned all 4 MCP tools');

// 7. MCP Happy Path: tools/call mcp_pdf_annotations_add & list
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

// 8. MCP Happy Path: tools/call mcp_pdf_annotations_list
const mcpListRes = await callRpc({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: {
    name: 'mcp_pdf_annotations_list',
    arguments: {
      pdfPath: targetPdf,
      page: 1,
    },
  },
});
assert.equal(mcpListRes.id, 4);
const listParsed = JSON.parse(mcpListRes.result.content[0].text);
assert(listParsed.some((c) => c.id === mcpAddedId), 'Expected to find added comment via MCP list');
console.log('✅ PASS: MCP Happy Path 4: mcp_pdf_annotations_list found added annotation');

// 9. MCP Happy Path: tools/call mcp_pdf_annotations_delete
const mcpDeleteRes = await callRpc({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: {
    name: 'mcp_pdf_annotations_delete',
    arguments: {
      pdfPath: targetPdf,
      commentId: mcpAddedId,
    },
  },
});
assert.equal(mcpDeleteRes.id, 5);
const deleteParsed = JSON.parse(mcpDeleteRes.result.content[0].text);
assert.equal(deleteParsed.deleted.id, mcpAddedId);
console.log('✅ PASS: MCP Happy Path 5: mcp_pdf_annotations_delete removed annotation');

// 10. MCP Happy Path: tools/call mcp_pdf_annotations_clear
const mcpClearRes = await callRpc({
  jsonrpc: '2.0',
  id: 6,
  method: 'tools/call',
  params: {
    name: 'mcp_pdf_annotations_clear',
    arguments: {
      pdfPath: targetPdf,
    },
  },
});
assert.equal(mcpClearRes.id, 6);
const clearParsed = JSON.parse(mcpClearRes.result.content[0].text);
assert.equal(typeof clearParsed.cleared, 'number');
console.log('✅ PASS: MCP Happy Path 6: mcp_pdf_annotations_clear completed successfully');

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

// 18. Happy Path & Failure Paths: RenderCoordinator Concurrency & Token Invalidation
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

console.log('\nAll unit tests passed successfully!');
