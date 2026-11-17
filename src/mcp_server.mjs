import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from './tool_schemas.mjs';
import {
  ALLOWED_ANNOTATION_TYPES,
  MARKUP_ANNOTATION_TYPES,
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

const PROTOCOL_VERSION = '2024-11-05';

/**
 * Sends a single JSON-RPC response or notification to stdout.
 * @param {Record<string, unknown>} payload
 * @returns {void}
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
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('CRITICAL: Tool arguments must be an object');
  }

  const normalized = name.replace(/^mcp_/, '').replace(/^pdf_annotations_/, '');

  if (normalized === 'list') {
    const { pdfPath, page, type } = args;
    if (!pdfPath || typeof pdfPath !== 'string') {
      throw new Error("CRITICAL: 'pdfPath' is required and must be a string");
    }
    const parsedPage = page !== undefined && page !== null ? Number(page) : undefined;
    if (type !== undefined && type !== null && (typeof type !== 'string' || !ALLOWED_ANNOTATION_TYPES.includes(type))) {
      throw new Error(`CRITICAL: 'type' must be one of: ${ALLOWED_ANNOTATION_TYPES.join(', ')}`);
    }
    const options = type !== undefined && type !== null ? { type } : {};
    const comments = await listPdfComments(pdfPath, parsedPage, options);
    return JSON.stringify(comments, null, 2);
  }

  if (normalized === 'add') {
    const {
      pdfPath,
      page,
      type = 'note',
      author,
      comment,
      selectedText,
      replacement,
      imageB64,
      rect,
      textRects,
      id,
    } = args;
    if (!pdfPath || typeof pdfPath !== 'string') {
      throw new Error("CRITICAL: 'pdfPath' is required and must be a string");
    }
    if (page === undefined || page === null || typeof page !== 'number' || !Number.isInteger(page) || page < 1) {
      throw new Error("CRITICAL: 'page' is required and must be a positive integer");
    }
    const resolvedType = type || 'note';
    if (typeof resolvedType !== 'string' || !ALLOWED_ANNOTATION_TYPES.includes(resolvedType)) {
      throw new Error(`CRITICAL: 'type' must be one of: ${ALLOWED_ANNOTATION_TYPES.join(', ')}`);
    }
    const isMarkup = MARKUP_ANNOTATION_TYPES.has(resolvedType);
    if (isMarkup) {
      if (comment !== undefined && comment !== null && typeof comment !== 'string') {
        throw new Error("CRITICAL: 'comment' must be a string if provided");
      }
    } else if (!comment || typeof comment !== 'string' || !comment.trim()) {
      throw new Error("CRITICAL: 'comment' is required and must be a non-empty string");
    }
    if (author !== undefined && author !== null && (typeof author !== 'string' || !author.trim())) {
      throw new Error("CRITICAL: 'author' must be a non-empty string if provided");
    }
    if (replacement !== undefined && replacement !== null && typeof replacement !== 'string') {
      throw new Error("CRITICAL: 'replacement' must be a string if provided");
    }
    if (selectedText !== undefined && selectedText !== null && typeof selectedText !== 'string') {
      throw new Error("CRITICAL: 'selectedText' must be a string if provided");
    }
    if (rect !== undefined && rect !== null) {
      validateRatioRect(rect);
    }
    if (textRects !== undefined && textRects !== null) {
      validateTextRects(textRects);
    }
    const trimmedComment = typeof comment === 'string' ? comment.trim() : '';
    if (isMarkup) {
      const hasTarget = (Array.isArray(textRects) && textRects.length > 0)
        || (rect !== undefined && rect !== null)
        || (typeof selectedText === 'string' && selectedText.trim().length > 0)
        || trimmedComment.length > 0;
      if (!hasTarget) {
        throw new Error("CRITICAL: Markup annotation requires at least one of 'textRects', 'rect', 'selectedText', or 'comment'");
      }
    }

    const res = await addPdfComment(pdfPath, {
      id,
      type: resolvedType,
      author: (author && author.trim()) || 'AI Reviewer',
      page,
      comment: trimmedComment,
      replacement: replacement !== undefined && replacement !== null ? replacement : null,
      selectedText: selectedText || null,
      imageB64: imageB64 || null,
      rect: rect || null,
      textRects: Array.isArray(textRects) ? textRects : null,
    });
    return JSON.stringify(res, null, 2);
  }

  if (normalized === 'modify' || normalized === 'update') {
    const {
      pdfPath,
      commentId,
      id,
      comment,
      author,
      status,
      type,
      replacement,
      selectedText,
      rect,
      textRects,
    } = args;
    if (!pdfPath || typeof pdfPath !== 'string') {
      throw new Error("CRITICAL: 'pdfPath' is required and must be a string");
    }
    const targetId = commentId || id;
    if (!targetId || typeof targetId !== 'string') {
      throw new Error("CRITICAL: 'commentId' is required and must be a non-empty string");
    }
    if (
      comment === undefined &&
      author === undefined &&
      status === undefined &&
      type === undefined &&
      replacement === undefined &&
      selectedText === undefined &&
      rect === undefined &&
      textRects === undefined
    ) {
      throw new Error(
        "CRITICAL: At least one of 'comment', 'author', or 'status' must be provided to modify (or markup fields 'type', 'replacement', 'selectedText', 'rect', 'textRects')"
      );
    }
    if (comment !== undefined && comment !== null && (typeof comment !== 'string' || !comment.trim())) {
      throw new Error("CRITICAL: 'comment' must be a non-empty string if provided");
    }
    if (type !== undefined && (typeof type !== 'string' || !ALLOWED_ANNOTATION_TYPES.includes(type))) {
      throw new Error(`CRITICAL: 'type' must be one of: ${ALLOWED_ANNOTATION_TYPES.join(', ')}`);
    }
    if (author !== undefined && (typeof author !== 'string' || !author.trim())) {
      throw new Error("CRITICAL: 'author' must be a non-empty string if provided");
    }
    if (status !== undefined && (typeof status !== 'string' || !status.trim())) {
      throw new Error("CRITICAL: 'status' must be a non-empty string if provided");
    }
    if (replacement !== undefined && replacement !== null && typeof replacement !== 'string') {
      throw new Error("CRITICAL: 'replacement' must be a string or null if provided");
    }
    if (selectedText !== undefined && selectedText !== null && typeof selectedText !== 'string') {
      throw new Error("CRITICAL: 'selectedText' must be a string or null if provided");
    }
    if (rect !== undefined && rect !== null) {
      validateRatioRect(rect);
    }
    if (textRects !== undefined && textRects !== null) {
      validateTextRects(textRects);
    }

    const updates = {};
    if (comment !== undefined) updates.comment = comment === null ? null : comment.trim();
    if (author !== undefined) updates.author = author.trim();
    if (status !== undefined) updates.status = status.trim();
    if (type !== undefined) updates.type = type;
    if (replacement !== undefined) updates.replacement = replacement;
    if (selectedText !== undefined) updates.selectedText = selectedText;
    if (rect !== undefined) updates.rect = rect;
    if (textRects !== undefined) updates.textRects = textRects;

    const res = await modifyPdfComment(pdfPath, targetId, updates);
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
    const { pdfPath, type } = args;
    if (!pdfPath || typeof pdfPath !== 'string') {
      throw new Error("CRITICAL: 'pdfPath' is required and must be a string");
    }
    if (type !== undefined && type !== null && (typeof type !== 'string' || !ALLOWED_ANNOTATION_TYPES.includes(type))) {
      throw new Error(`CRITICAL: 'type' must be one of: ${ALLOWED_ANNOTATION_TYPES.join(', ')}`);
    }

    const options = type !== undefined && type !== null ? { type } : {};
    const res = await clearPdfComments(pdfPath, options);
    return JSON.stringify(res, null, 2);
  }

  throw new Error(`CRITICAL: Unknown tool '${name}'`);
}

/**
 * Handles incoming JSON-RPC 2.0 messages.
 * @param {Record<string, unknown>} msg
 * @param {(res: Record<string, unknown>) => void} [customSender]
 * @returns {Promise<void>}
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
