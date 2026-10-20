import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from './tool_schemas.mjs';
import {
  addPdfComment,
  clearPdfComments,
  deletePdfComment,
  listPdfComments,
} from '../sidecars/panel/pdf_annotations.mjs';

const PROTOCOL_VERSION = '2024-11-05';

/**
 * Sends a single JSON-RPC response or notification to stdout.
 * @param {Record<string, unknown>} payload
 */
function sendLine(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

/**
 * Validates and executes tool call by name and arguments.
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {Promise<string>}
 */
export async function executeToolCall(name, args = {}) {
  if (!name || typeof name !== 'string') {
    throw new Error('CRITICAL: Tool name must be a non-empty string');
  }
  if (!args || typeof args !== 'object') {
    throw new Error('CRITICAL: Tool arguments must be an object');
  }

  const normalized = name.replace(/^mcp_/, '').replace(/^pdf_annotations_/, '');

  if (normalized === 'list') {
    const { pdfPath, page } = args;
    if (!pdfPath || typeof pdfPath !== 'string') {
      throw new Error("CRITICAL: 'pdfPath' is required and must be a string");
    }
    const parsedPage = page !== undefined && page !== null ? Number(page) : undefined;
    const comments = await listPdfComments(pdfPath, parsedPage);
    return JSON.stringify(comments, null, 2);
  }

  if (normalized === 'add') {
    const { pdfPath, page, type, comment, selectedText, imageB64, rect, textRects, id } = args;
    if (!pdfPath || typeof pdfPath !== 'string') {
      throw new Error("CRITICAL: 'pdfPath' is required and must be a string");
    }
    if (page === undefined || page === null || typeof page !== 'number' || page < 1) {
      throw new Error("CRITICAL: 'page' is required and must be a positive integer");
    }
    if (!type || typeof type !== 'string' || !['text', 'area'].includes(type)) {
      throw new Error("CRITICAL: 'type' is required and must be 'text' or 'area'");
    }
    if (!comment || typeof comment !== 'string' || !comment.trim()) {
      throw new Error("CRITICAL: 'comment' is required and must be a non-empty string");
    }

    const res = await addPdfComment(pdfPath, {
      id,
      type,
      page,
      comment: comment.trim(),
      selectedText: selectedText || null,
      imageB64: imageB64 || null,
      rect: rect || null,
      textRects: Array.isArray(textRects) ? textRects : null,
    });
    return JSON.stringify(res, null, 2);
  }

  if (normalized === 'delete') {
    const { pdfPath, commentId, id } = args;
    if (!pdfPath || typeof pdfPath !== 'string') {
      throw new Error("CRITICAL: 'pdfPath' is required and must be a string");
    }
    const targetId = commentId || id;
    if (!targetId || typeof targetId !== 'string') {
      throw new Error("CRITICAL: 'commentId' is required and must be a non-empty string");
    }

    const res = await deletePdfComment(pdfPath, targetId);
    return JSON.stringify(res, null, 2);
  }

  if (normalized === 'clear') {
    const { pdfPath } = args;
    if (!pdfPath || typeof pdfPath !== 'string') {
      throw new Error("CRITICAL: 'pdfPath' is required and must be a string");
    }

    const res = await clearPdfComments(pdfPath);
    return JSON.stringify(res, null, 2);
  }

  throw new Error(`CRITICAL: Unknown tool '${name}'`);
}

/**
 * Handles incoming JSON-RPC 2.0 messages.
 * @param {Record<string, unknown>} msg
 * @param {(res: Record<string, unknown>) => void} [customSender]
 */
export async function handleMessage(msg, customSender = sendLine) {
  if (!msg || typeof msg !== 'object') {
    return customSender({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request: payload must be a JSON object' },
    });
  }

  const { id, method, params } = msg;

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'ping') {
    return customSender({ jsonrpc: '2.0', id, result: {} });
  }

  if (method === 'initialize') {
    return customSender({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: 'pdf-annotations-mcp',
          version: '1.0.0',
        },
      },
    });
  }

  if (method === 'tools/list') {
    return customSender({
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS },
    });
  }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params || {};
    try {
      const resultText = await executeToolCall(name, args);
      return customSender({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: resultText }],
        },
      });
    } catch (err) {
      return customSender({
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: err.message }],
        },
      });
    }
  }

  if (id === undefined || id === null) {
    return;
  }

  return customSender({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
}

// Start stdio interface if executed directly
const isDirectExecution = Boolean(
  process.argv[1] &&
    (fileURLToPath(import.meta.url) === process.argv[1] ||
      path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
      path.basename(process.argv[1]) === 'mcp_server.mjs')
);

if (isDirectExecution) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      await handleMessage(parsed);
    } catch (err) {
      sendLine({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: `Parse error: ${err.message}` },
      });
    }
  });
}
