import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import {
  decodePdfText,
  findAnnotationById,
  pdfRectToRatios,
  ratiosToPdfRect,
  validatePdfPath,
} from './annotation_geometry.mjs';

export async function listPdfComments(pdfPath, page) {
  validatePdfPath(pdfPath);
  if (page !== undefined && page !== null) {
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) {
      throw new Error('CRITICAL: page must be a positive integer');
    }
  }
  const pdfBytes = readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();
  const comments = [];

  const supportedSubtypes = new Set([
    '/Highlight', '/Underline', '/StrikeOut', '/Squiggly', '/Text',
    '/FreeText', '/Square', '/Circle', '/Polygon', '/PolyLine',
    '/Line', '/Stamp', '/Ink',
  ]);

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
          comments.push(parsed);
          continue;
        } catch {}
      }

      const subtypeObj = annotDict.lookup(PDFName.of('Subtype'));
      const subtype = subtypeObj ? subtypeObj.toString() : '';
      if (!supportedSubtypes.has(subtype)) continue;

      const contents = decodePdfText(annotDict.lookup(PDFName.of('Contents'))).trim();
      if (!contents) continue;

      const nm = decodePdfText(annotDict.lookup(PDFName.of('NM')));
      const id = nm || `ext_p${pageNum}_${i}`;
      const rectObj = annotDict.lookupMaybe(PDFName.of('Rect'), PDFArray);
      const ratioRect = pdfRectToRatios(rectObj, width, height);
      const authorText = decodePdfText(annotDict.lookup(PDFName.of('T'))) || null;

      const isAreaType = ['/Square', '/Circle', '/Polygon', '/PolyLine', '/Line', '/Stamp', '/Ink'].includes(subtype);
      const isNoteType = subtype === '/Text';
      const isStrikeType = subtype === '/StrikeOut';
      const commentType = isAreaType ? 'area' : (isNoteType ? 'note' : (isStrikeType ? 'strike' : 'text'));

      comments.push({
        id,
        type: commentType,
        author: authorText,
        page: pageNum,
        selectedText: null,
        replacement: null,
        imageB64: null,
        rect: ratioRect,
        textRects: !isAreaType && !isNoteType && ratioRect ? [ratioRect] : null,
        comment: contents,
        createdAt: decodePdfText(annotDict.lookup(PDFName.of('M'))) || new Date().toISOString(),
        status: 'open',
      });
    }
  });

  return (page !== undefined && page !== null) ? comments.filter((c) => c.page === page) : comments;
}

export async function addPdfComment(pdfPath, payload) {
  validatePdfPath(pdfPath);
  if (!payload || typeof payload !== 'object') {
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

  if (!comment || typeof comment !== 'string' || !comment.trim()) {
    throw new Error('CRITICAL: Comment text must be a non-empty string');
  }
  if (!page || typeof page !== 'number' || page < 1) {
    throw new Error('CRITICAL: Valid 1-based page number is required');
  }
  const allowedTypes = ['note', 'text', 'area', 'strike'];
  if (type && !allowedTypes.includes(type)) {
    throw new Error(`CRITICAL: type must be one of: ${allowedTypes.join(', ')}`);
  }
  if (author !== undefined && author !== null && (typeof author !== 'string' || !author.trim())) {
    throw new Error('CRITICAL: author must be a non-empty string if provided');
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
  const resolvedType = type || (rect && !textRects ? 'area' : 'text');

  let annots = targetPage.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  const existingCount = annots ? annots.size() : 0;

  let effectiveRect = rect;
  if (resolvedType === 'note' && !effectiveRect) {
    const yOffset = Math.min(0.85, 0.08 + (existingCount * 0.05));
    effectiveRect = { xRatio: 0.88, yRatio: yOffset, wRatio: 0.04, hRatio: 0.03 };
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
    textRects,
    comment: comment.trim(),
    createdAt,
    status: 'open',
  };

  let pdfRect = [50, height - 80, 200, height - 50];
  const quadPoints = [];

  if (resolvedType === 'note' && effectiveRect) {
    pdfRect = ratiosToPdfRect(effectiveRect, width, height);
  } else if (resolvedType === 'area' && rect) {
    pdfRect = ratiosToPdfRect(rect, width, height);
  } else if (Array.isArray(textRects) && textRects.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of textRects) {
      const [x1, y1, x2, y2] = ratiosToPdfRect(r, width, height);
      minX = Math.min(minX, x1); minY = Math.min(minY, y1);
      maxX = Math.max(maxX, x2); maxY = Math.max(maxY, y2);
      quadPoints.push(x1, y2, x2, y2, x1, y1, x2, y1);
    }
    pdfRect = [minX, minY, maxX, maxY];
  } else if (effectiveRect) {
    pdfRect = ratiosToPdfRect(effectiveRect, width, height);
  }

  const isAi = Boolean(resolvedAuthor && /ai|llm|assistant|agent|antigravity/i.test(resolvedAuthor));
  const subtypeMap = { area: 'Square', note: 'Text', strike: 'StrikeOut', text: 'Highlight' };
  const colorMap = {
    area: [0.96, 0.62, 0.04], note: [0.98, 0.75, 0.12], strike: [0.92, 0.23, 0.23], text: [0.98, 0.82, 0.08],
  };

  const annotProps = {
    Type: 'Annot',
    Subtype: subtypeMap[resolvedType] || 'Highlight',
    Rect: pdfRect,
    Contents: PDFHexString.fromText(newEntry.replacement ? `Replace with: "${newEntry.replacement}" | ${newEntry.comment}` : newEntry.comment),
    T: PDFHexString.fromText(resolvedAuthor),
    NM: PDFString.of(id),
    M: PDFString.of(createdAt),
    F: 4,
    C: isAi ? [0.18, 0.55, 0.95] : (colorMap[resolvedType] || [0.98, 0.82, 0.08]),
    CA: resolvedType === 'note' ? 1.0 : (resolvedType === 'strike' ? 0.9 : 0.45),
    AGYMeta: PDFHexString.fromText(JSON.stringify(newEntry)),
  };

  if (quadPoints.length > 0 && (resolvedType === 'text' || resolvedType === 'strike')) {
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

export async function modifyPdfComment(pdfPath, commentId, updates) {
  validatePdfPath(pdfPath);
  if (!commentId || typeof commentId !== 'string' || !commentId.trim()) {
    throw new Error('CRITICAL: commentId must be a valid non-empty string');
  }
  if (!updates || typeof updates !== 'object') {
    throw new Error('CRITICAL: updates object is required');
  }
  const { comment, author, status, replacement } = updates;
  if (comment === undefined && author === undefined && status === undefined && replacement === undefined) {
    throw new Error("CRITICAL: At least one of 'comment', 'author', or 'status' must be provided to modify");
  }
  if (comment !== undefined && (typeof comment !== 'string' || !comment.trim())) {
    throw new Error("CRITICAL: 'comment' must be a non-empty string if provided");
  }
  if (author !== undefined && (typeof author !== 'string' || !author.trim())) {
    throw new Error("CRITICAL: 'author' must be a non-empty string if provided");
  }
  if (status !== undefined && (typeof status !== 'string' || !status.trim())) {
    throw new Error("CRITICAL: 'status' must be a non-empty string if provided");
  }

  const pdfBytes = readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();
  const found = findAnnotationById(pages, commentId.trim());

  if (!found) {
    throw new Error(`CRITICAL: Comment with ID '${commentId}' not found in PDF`);
  }

  const { annotDict, metaData, pageIndex } = found;
  const currentComment = decodePdfText(annotDict.lookup(PDFName.of('Contents')));
  const currentAuthor = decodePdfText(annotDict.lookup(PDFName.of('T')));
  const nowIso = new Date().toISOString();

  const updatedEntry = {
    id: commentId.trim(),
    type: metaData?.type || 'text',
    author: author ? author.trim() : (metaData?.author || currentAuthor || 'User'),
    page: metaData?.page || (pageIndex + 1),
    selectedText: metaData?.selectedText || null,
    replacement: replacement !== undefined ? (replacement ? String(replacement).trim() : null) : (metaData?.replacement || null),
    imageB64: metaData?.imageB64 || null,
    rect: metaData?.rect || null,
    textRects: metaData?.textRects || null,
    comment: comment ? comment.trim() : (metaData?.comment || currentComment),
    createdAt: metaData?.createdAt || nowIso,
    modifiedAt: nowIso,
    status: status ? status.trim() : (metaData?.status || 'open'),
  };

  annotDict.set(PDFName.of('Contents'), PDFHexString.fromText(updatedEntry.comment));
  annotDict.set(PDFName.of('T'), PDFHexString.fromText(updatedEntry.author));
  annotDict.set(PDFName.of('M'), PDFString.of(nowIso));
  annotDict.set(PDFName.of('AGYMeta'), PDFHexString.fromText(JSON.stringify(updatedEntry)));

  const savedBytes = await pdfDoc.save();
  writeFileSync(pdfPath, savedBytes);
  return { comment: updatedEntry, mtime: statSync(pdfPath).mtimeMs };
}

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
  const deletedComment = metaData || {
    id: currentId,
    type: 'text',
    page: pageIndex + 1,
    comment: decodePdfText(annotDict.lookup(PDFName.of('Contents'))),
  };

  annots.remove(annotIndex);
  const savedBytes = await pdfDoc.save();
  writeFileSync(pdfPath, savedBytes);
  return { deleted: deletedComment, mtime: statSync(pdfPath).mtimeMs };
}

export async function clearPdfComments(pdfPath) {
  validatePdfPath(pdfPath);
  const comments = await listPdfComments(pdfPath);
  for (const c of comments) {
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
