import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import {
  ALLOWED_ANNOTATION_TYPES,
  MARKUP_ANNOTATION_TYPES,
  TEXT_SPAN_ANNOTATION_TYPES,
  annotationTypeToSubtype,
  decodePdfText,
  findAnnotationById,
  matchesTypeFilter,
  pdfRectToRatios,
  quadPointsToRatioRects,
  ratiosToPdfRect,
  rectsToQuadPointsAndBounds,
  subtypeToAnnotationType,
  validatePdfPath,
  validateRatioRect,
  validateTextRects,
} from './annotation_geometry.mjs';

const MARKUP_PDF_SUBTYPES = new Set(['/Highlight', '/Underline', '/StrikeOut', '/Squiggly']);
const SUPPORTED_PDF_SUBTYPES = new Set([
  '/Highlight', '/Underline', '/StrikeOut', '/Squiggly', '/Text',
  '/FreeText', '/Square', '/Circle', '/Polygon', '/PolyLine',
  '/Line', '/Stamp', '/Ink',
]);

/**
 * Formats the ISO 32000 /Contents string for a comment or markup annotation.
 * @param {{comment?: string, replacement?: string | null}} entry
 * @returns {string}
 */
function formatAnnotationContents(entry) {
  if (entry.replacement) {
    return entry.comment
      ? `Replace with: "${entry.replacement}" | ${entry.comment}`
      : `Replace with: "${entry.replacement}"`;
  }
  return entry.comment || '';
}

/**
 * Computes PDF /C color and /CA opacity values for an annotation type and author.
 * @param {string} type
 * @param {string | null} author
 * @returns {{color: [number, number, number], opacity: number}}
 */
function getAnnotationAppearance(type, author) {
  const isAi = Boolean(author && /ai|llm|assistant|agent|antigravity/i.test(author));
  const colorMap = {
    area: [0.96, 0.62, 0.04],
    note: [0.98, 0.75, 0.12],
    strike: [0.92, 0.23, 0.23],
    strikethrough: [0.92, 0.23, 0.23],
    underline: [0.06, 0.73, 0.51],
    highlight: [0.98, 0.82, 0.08],
    text: [0.98, 0.82, 0.08],
  };
  const color = isAi ? [0.18, 0.55, 0.95] : (colorMap[type] || [0.98, 0.82, 0.08]);
  const opacity = type === 'note'
    ? 1.0
    : (['strike', 'strikethrough', 'underline'].includes(type) ? 0.9 : 0.45);
  return { color, opacity };
}

/**
 * Lists all supported PDF annotations and markups, optionally filtered by page and type.
 * @param {string} pdfPath
 * @param {number} [page]
 * @param {{type?: string}} [options={}]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function listPdfComments(pdfPath, page, options = {}) {
  validatePdfPath(pdfPath);
  if (page !== undefined && page !== null) {
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) {
      throw new Error('CRITICAL: page must be a positive integer');
    }
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('CRITICAL: options must be a plain object');
  }
  const { type: filterType } = options;
  if (filterType !== undefined && filterType !== null) {
    if (typeof filterType !== 'string' || !ALLOWED_ANNOTATION_TYPES.includes(filterType)) {
      throw new Error(`CRITICAL: Invalid annotation type filter '${filterType}'`);
    }
  }

  const pdfBytes = readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();
  const comments = [];

  pages.forEach((p, pageIdx) => {
    const pageNum = pageIdx + 1;
    const { width, height } = p.getSize();
    const annots = p.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) return;

    for (let i = 0; i < annots.size(); i++) {
      const annotDict = annots.lookupMaybe(i, PDFDict);
      if (!annotDict) continue;

      const metaObj = annotDict.lookup(PDFName.of('AGYMeta'));
      if (metaObj) {
        try {
          const parsed = JSON.parse(decodePdfText(metaObj));
          parsed.page = pageNum;
          if (!parsed.author) {
            parsed.author = decodePdfText(annotDict.lookup(PDFName.of('T'))) || null;
          }
          parsed.comment = typeof parsed.comment === 'string' ? parsed.comment : '';
          comments.push(parsed);
          continue;
        } catch {}
      }

      const subtypeObj = annotDict.lookup(PDFName.of('Subtype'));
      const subtype = subtypeObj ? subtypeObj.toString() : '';
      if (!SUPPORTED_PDF_SUBTYPES.has(subtype)) continue;

      const isMarkupSubtype = MARKUP_PDF_SUBTYPES.has(subtype);
      const contents = decodePdfText(annotDict.lookup(PDFName.of('Contents'))).trim();
      if (!contents && !isMarkupSubtype) continue;

      const nm = decodePdfText(annotDict.lookup(PDFName.of('NM')));
      const id = nm || `ext_p${pageNum}_${i}`;
      const rectObj = annotDict.lookupMaybe(PDFName.of('Rect'), PDFArray);
      const ratioRect = pdfRectToRatios(rectObj, width, height);
      const quadRects = isMarkupSubtype
        ? quadPointsToRatioRects(annotDict.lookupMaybe(PDFName.of('QuadPoints'), PDFArray), width, height)
        : null;
      const authorText = decodePdfText(annotDict.lookup(PDFName.of('T'))) || null;
      const commentType = subtypeToAnnotationType(subtype);

      comments.push({
        id,
        type: commentType,
        author: authorText,
        page: pageNum,
        selectedText: null,
        replacement: null,
        imageB64: null,
        rect: ratioRect,
        textRects: isMarkupSubtype ? (quadRects || (ratioRect ? [ratioRect] : null)) : null,
        comment: contents,
        createdAt: decodePdfText(annotDict.lookup(PDFName.of('M'))) || new Date().toISOString(),
        status: 'open',
      });
    }
  });

  let filtered = (page !== undefined && page !== null) ? comments.filter((c) => c.page === page) : comments;
  if (filterType !== undefined && filterType !== null) {
    filtered = filtered.filter((c) => matchesTypeFilter(c.type, filterType));
  }
  return filtered;
}

/**
 * Embeds a native ISO 32000 annotation or text markup into a PDF document.
 * @param {string} pdfPath
 * @param {Record<string, unknown>} payload
 * @returns {Promise<{comment: Record<string, unknown>, mtime: number}>}
 */
export async function addPdfComment(pdfPath, payload) {
  validatePdfPath(pdfPath);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('CRITICAL: Comment payload is required');
  }
  const {
    id: customId,
    type = 'text',
    author = null,
    page,
    comment,
    replacement = null,
    selectedText = null,
    imageB64 = null,
    rect = null,
    textRects = null,
  } = payload;

  if (!page || typeof page !== 'number' || !Number.isInteger(page) || page < 1) {
    throw new Error('CRITICAL: Valid 1-based page number is required');
  }
  if (type !== undefined && type !== null && (typeof type !== 'string' || !ALLOWED_ANNOTATION_TYPES.includes(type))) {
    throw new Error(`CRITICAL: type must be one of: ${ALLOWED_ANNOTATION_TYPES.join(', ')}`);
  }
  if (author !== undefined && author !== null && (typeof author !== 'string' || !author.trim())) {
    throw new Error('CRITICAL: author must be a non-empty string if provided');
  }
  if (replacement !== undefined && replacement !== null && typeof replacement !== 'string') {
    throw new Error('CRITICAL: replacement must be a string if provided');
  }
  if (selectedText !== undefined && selectedText !== null && typeof selectedText !== 'string') {
    throw new Error('CRITICAL: selectedText must be a string if provided');
  }
  if (rect !== undefined && rect !== null) {
    validateRatioRect(rect);
  }
  if (textRects !== undefined && textRects !== null) {
    validateTextRects(textRects);
  }

  const resolvedType = type || (rect && !textRects ? 'area' : 'text');
  const isMarkup = MARKUP_ANNOTATION_TYPES.has(resolvedType);

  if (isMarkup) {
    if (comment !== undefined && comment !== null && typeof comment !== 'string') {
      throw new Error('CRITICAL: Comment text must be a string when provided');
    }
  } else if (!comment || typeof comment !== 'string' || !comment.trim()) {
    throw new Error('CRITICAL: Comment text must be a non-empty string');
  }

  const trimmedComment = typeof comment === 'string' ? comment.trim() : '';
  if (isMarkup) {
    const hasTarget = (Array.isArray(textRects) && textRects.length > 0)
      || rect !== null
      || (typeof selectedText === 'string' && selectedText.trim().length > 0)
      || trimmedComment.length > 0;
    if (!hasTarget) {
      throw new Error("CRITICAL: Markup annotation requires at least one of 'textRects', 'rect', 'selectedText', or 'comment'");
    }
  }

  const pdfBytes = readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();
  if (page > pages.length) {
    throw new Error(`CRITICAL: Page ${page} out of bounds (PDF has ${pages.length} pages)`);
  }

  const targetPage = pages[page - 1];
  const { width, height } = targetPage.getSize();
  const id = customId || `c_${Date.now()}`;
  const createdAt = payload.createdAt || new Date().toISOString();
  const resolvedAuthor = author && author.trim() ? author.trim() : 'User';

  let annots = targetPage.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  const existingCount = annots ? annots.size() : 0;

  let effectiveRect = rect ?? null;
  let effectiveTextRects = Array.isArray(textRects) && textRects.length > 0 ? textRects : null;
  if (resolvedType === 'note' && !effectiveRect) {
    const yOffset = Math.min(0.85, 0.08 + (existingCount * 0.05));
    effectiveRect = { xRatio: 0.88, yRatio: yOffset, wRatio: 0.04, hRatio: 0.03 };
  }

  let pdfRect = [50, height - 80, 200, height - 50];
  let quadPoints = [];

  if (resolvedType === 'note' && effectiveRect) {
    pdfRect = ratiosToPdfRect(effectiveRect, width, height);
  } else if (resolvedType === 'area' && effectiveRect) {
    pdfRect = ratiosToPdfRect(effectiveRect, width, height);
  } else if (effectiveTextRects) {
    const computed = rectsToQuadPointsAndBounds(effectiveTextRects, width, height);
    pdfRect = computed.pdfRect;
    quadPoints = computed.quadPoints;
    if (!effectiveRect) effectiveRect = computed.unionRatioRect;
  } else if (TEXT_SPAN_ANNOTATION_TYPES.has(resolvedType) && effectiveRect) {
    effectiveTextRects = [effectiveRect];
    const computed = rectsToQuadPointsAndBounds(effectiveTextRects, width, height);
    pdfRect = computed.pdfRect;
    quadPoints = computed.quadPoints;
  } else if (effectiveRect) {
    pdfRect = ratiosToPdfRect(effectiveRect, width, height);
  } else if (TEXT_SPAN_ANNOTATION_TYPES.has(resolvedType)) {
    quadPoints = [50, height - 50, 200, height - 50, 50, height - 80, 200, height - 80];
  }

  const newEntry = {
    id,
    type: resolvedType,
    author: resolvedAuthor,
    page,
    selectedText,
    replacement: replacement ? String(replacement).trim() : null,
    imageB64,
    rect: effectiveRect,
    textRects: effectiveTextRects,
    comment: trimmedComment,
    createdAt,
    status: 'open',
  };

  const { color, opacity } = getAnnotationAppearance(resolvedType, resolvedAuthor);
  const annotProps = {
    Type: 'Annot',
    Subtype: annotationTypeToSubtype(resolvedType),
    Rect: pdfRect,
    Contents: PDFHexString.fromText(formatAnnotationContents(newEntry)),
    T: PDFHexString.fromText(resolvedAuthor),
    NM: PDFString.of(id),
    M: PDFString.of(createdAt),
    F: 4,
    C: color,
    CA: opacity,
    AGYMeta: PDFHexString.fromText(JSON.stringify(newEntry)),
  };

  if (quadPoints.length > 0 && TEXT_SPAN_ANNOTATION_TYPES.has(resolvedType)) {
    annotProps.QuadPoints = quadPoints;
  }
  if (resolvedType === 'note') annotProps.Name = 'Comment';

  const annotRef = pdfDoc.context.register(pdfDoc.context.obj(annotProps));
  if (!annots) {
    annots = pdfDoc.context.obj([]);
    targetPage.node.set(PDFName.of('Annots'), annots);
  }
  annots.push(annotRef);

  const savedBytes = await pdfDoc.save();
  writeFileSync(pdfPath, savedBytes);
  return { comment: newEntry, mtime: statSync(pdfPath).mtimeMs };
}

/**
 * Modifies an existing annotation or markup entry inside a PDF document.
 * @param {string} pdfPath
 * @param {string} commentId
 * @param {Record<string, unknown>} updates
 * @returns {Promise<{comment: Record<string, unknown>, mtime: number}>}
 */
export async function modifyPdfComment(pdfPath, commentId, updates) {
  validatePdfPath(pdfPath);
  if (!commentId || typeof commentId !== 'string' || !commentId.trim()) {
    throw new Error('CRITICAL: commentId must be a valid non-empty string');
  }
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new Error('CRITICAL: updates object is required');
  }

  const {
    comment,
    author,
    status,
    replacement,
    type,
    selectedText,
    rect,
    textRects,
  } = updates;

  if (
    comment === undefined &&
    author === undefined &&
    status === undefined &&
    replacement === undefined &&
    type === undefined &&
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
    throw new Error(`CRITICAL: type must be one of: ${ALLOWED_ANNOTATION_TYPES.join(', ')}`);
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

  const pdfBytes = readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();
  const found = findAnnotationById(pages, commentId.trim());

  if (!found) {
    throw new Error(`CRITICAL: Comment with ID '${commentId}' not found in PDF`);
  }

  const { annotDict, metaData, pageIndex } = found;
  const targetPage = pages[pageIndex];
  const { width, height } = targetPage.getSize();
  const currentComment = decodePdfText(annotDict.lookup(PDFName.of('Contents')));
  const currentAuthor = decodePdfText(annotDict.lookup(PDFName.of('T')));
  const nowIso = new Date().toISOString();

  const existingSubtypeObj = annotDict.lookup(PDFName.of('Subtype'));
  const existingSubtype = existingSubtypeObj ? existingSubtypeObj.toString() : '/Highlight';
  let inferredType = 'text';
  try {
    inferredType = subtypeToAnnotationType(existingSubtype);
  } catch {}

  const resolvedType = type !== undefined ? type : (metaData?.type || inferredType);
  if (comment === null && !MARKUP_ANNOTATION_TYPES.has(resolvedType)) {
    throw new Error("CRITICAL: Cannot clear 'comment' on non-markup annotation");
  }

  const updatedAuthor = author ? author.trim() : (metaData?.author || currentAuthor || 'User');
  const updatedComment = comment === null
    ? ''
    : (comment !== undefined
      ? comment.trim()
      : (metaData?.comment !== undefined ? metaData.comment : currentComment));

  const fallbackRect = pdfRectToRatios(annotDict.lookupMaybe(PDFName.of('Rect'), PDFArray), width, height);
  const fallbackQuadRects = quadPointsToRatioRects(annotDict.lookupMaybe(PDFName.of('QuadPoints'), PDFArray), width, height);
  let updatedRect = rect !== undefined ? rect : (metaData?.rect ?? fallbackRect);
  let updatedTextRects = textRects !== undefined ? textRects : (metaData?.textRects ?? fallbackQuadRects);

  if (textRects !== undefined || rect !== undefined || type !== undefined) {
    if (TEXT_SPAN_ANNOTATION_TYPES.has(resolvedType)) {
      if (Array.isArray(updatedTextRects) && updatedTextRects.length > 0) {
        const computed = rectsToQuadPointsAndBounds(updatedTextRects, width, height);
        annotDict.set(PDFName.of('Rect'), pdfDoc.context.obj(computed.pdfRect));
        annotDict.set(PDFName.of('QuadPoints'), pdfDoc.context.obj(computed.quadPoints));
        if (rect === undefined && (!updatedRect || textRects !== undefined)) {
          updatedRect = computed.unionRatioRect;
        }
      } else if (updatedRect) {
        updatedTextRects = [updatedRect];
        const computed = rectsToQuadPointsAndBounds(updatedTextRects, width, height);
        annotDict.set(PDFName.of('Rect'), pdfDoc.context.obj(computed.pdfRect));
        annotDict.set(PDFName.of('QuadPoints'), pdfDoc.context.obj(computed.quadPoints));
      }
    } else {
      if (updatedRect) {
        annotDict.set(PDFName.of('Rect'), pdfDoc.context.obj(ratiosToPdfRect(updatedRect, width, height)));
      }
      annotDict.delete(PDFName.of('QuadPoints'));
    }
  }

  const updatedEntry = {
    id: commentId.trim(),
    type: resolvedType,
    author: updatedAuthor,
    page: metaData?.page || (pageIndex + 1),
    selectedText: selectedText !== undefined
      ? (selectedText ? selectedText : null)
      : (metaData?.selectedText ?? null),
    replacement: replacement !== undefined
      ? (replacement ? String(replacement).trim() : null)
      : (metaData?.replacement ?? null),
    imageB64: metaData?.imageB64 || null,
    rect: updatedRect ?? null,
    textRects: updatedTextRects ?? null,
    comment: updatedComment,
    createdAt: metaData?.createdAt || nowIso,
    modifiedAt: nowIso,
    status: status ? status.trim() : (metaData?.status || 'open'),
  };

  const { color, opacity } = getAnnotationAppearance(resolvedType, updatedAuthor);
  annotDict.set(PDFName.of('Subtype'), PDFName.of(annotationTypeToSubtype(resolvedType)));
  if (resolvedType === 'note') annotDict.set(PDFName.of('Name'), PDFName.of('Comment'));
  else annotDict.delete(PDFName.of('Name'));

  annotDict.set(PDFName.of('C'), pdfDoc.context.obj(color));
  annotDict.set(PDFName.of('CA'), pdfDoc.context.obj(opacity));
  annotDict.set(PDFName.of('Contents'), PDFHexString.fromText(formatAnnotationContents(updatedEntry)));
  annotDict.set(PDFName.of('T'), PDFHexString.fromText(updatedEntry.author));
  annotDict.set(PDFName.of('M'), PDFString.of(nowIso));
  annotDict.set(PDFName.of('AGYMeta'), PDFHexString.fromText(JSON.stringify(updatedEntry)));

  const savedBytes = await pdfDoc.save();
  writeFileSync(pdfPath, savedBytes);
  return { comment: updatedEntry, mtime: statSync(pdfPath).mtimeMs };
}

/**
 * Deletes a specific annotation or markup entry from a PDF document by ID.
 * @param {string} pdfPath
 * @param {string} commentId
 * @returns {Promise<{deleted: Record<string, unknown> | null, mtime: number}>}
 */
export async function deletePdfComment(pdfPath, commentId) {
  validatePdfPath(pdfPath);
  if (!commentId || typeof commentId !== 'string' || !commentId.trim()) {
    throw new Error('CRITICAL: commentId must be a valid string');
  }

  const pdfBytes = readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();
  const found = findAnnotationById(pages, commentId.trim());

  if (!found) return { deleted: null, mtime: statSync(pdfPath).mtimeMs };

  const { annots, annotIndex, annotDict, metaData, currentId, pageIndex } = found;
  let fallbackType = 'text';
  const subtypeObj = annotDict.lookup(PDFName.of('Subtype'));
  if (subtypeObj) {
    try {
      fallbackType = subtypeToAnnotationType(subtypeObj.toString());
    } catch {}
  }

  const deletedComment = metaData || {
    id: currentId,
    type: fallbackType,
    page: pageIndex + 1,
    comment: decodePdfText(annotDict.lookup(PDFName.of('Contents'))),
  };

  annots.remove(annotIndex);
  const savedBytes = await pdfDoc.save();
  writeFileSync(pdfPath, savedBytes);
  return { deleted: deletedComment, mtime: statSync(pdfPath).mtimeMs };
}

/**
 * Clears all matching annotations or markups from a PDF document.
 * @param {string} pdfPath
 * @param {{type?: string}} [options={}]
 * @returns {Promise<{cleared: number, mtime: number}>}
 */
export async function clearPdfComments(pdfPath, options = {}) {
  validatePdfPath(pdfPath);
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('CRITICAL: options must be a plain object');
  }
  const comments = await listPdfComments(pdfPath, undefined, options);
  for (const c of [...comments].reverse()) {
    await deletePdfComment(pdfPath, c.id);
  }
  return { cleared: comments.length, mtime: statSync(pdfPath).mtimeMs };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , cmd, targetPdf, argId, argComment] = process.argv;
  if (cmd === 'list') {
    listPdfComments(targetPdf).then((res) => console.log(JSON.stringify(res, null, 2)));
  } else if (cmd === 'modify') {
    modifyPdfComment(targetPdf, argId, { comment: argComment }).then((res) => console.log(JSON.stringify(res, null, 2)));
  } else if (cmd === 'delete') {
    deletePdfComment(targetPdf, argId).then((res) => console.log(JSON.stringify(res, null, 2)));
  } else if (cmd === 'clear') {
    clearPdfComments(targetPdf).then((res) => console.log(JSON.stringify(res, null, 2)));
  } else {
    console.error('Usage: node pdf_annotations.mjs <list|delete|modify|clear> <pdfPath> [commentId] [newComment]');
    process.exit(1);
  }
}
