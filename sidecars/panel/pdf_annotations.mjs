import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from 'pdf-lib';

function validatePdfPath(pdfPath) {
  if (!pdfPath || typeof pdfPath !== 'string') {
    throw new Error('CRITICAL: pdfPath must be a non-empty string');
  }
  if (!existsSync(pdfPath)) {
    throw new Error(`CRITICAL: PDF file does not exist: ${pdfPath}`);
  }
}

function decodePdfText(pdfObj) {
  if (!pdfObj) return '';
  if (pdfObj instanceof PDFHexString || pdfObj instanceof PDFString) {
    return pdfObj.decodeText();
  }
  return String(pdfObj);
}

function pdfRectToRatios(rectArray, pageWidth, pageHeight) {
  if (!(rectArray instanceof PDFArray) || rectArray.size() < 4) return null;
  const nums = [];
  for (let i = 0; i < 4; i++) {
    const val = rectArray.lookup(i);
    nums.push(val instanceof PDFNumber ? val.asNumber() : 0);
  }
  const [x1, y1, x2, y2] = nums;
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const bottom = Math.min(y1, y2);
  const top = Math.max(y1, y2);

  return {
    xRatio: Math.max(0, left / pageWidth),
    yRatio: Math.max(0, (pageHeight - top) / pageHeight),
    wRatio: Math.min(1, (right - left) / pageWidth),
    hRatio: Math.min(1, (top - bottom) / pageHeight),
  };
}

function ratiosToPdfRect(r, pageWidth, pageHeight) {
  const x1 = r.xRatio * pageWidth;
  const x2 = (r.xRatio + r.wRatio) * pageWidth;
  const y2 = pageHeight - r.yRatio * pageHeight;
  const y1 = pageHeight - (r.yRatio + r.hRatio) * pageHeight;
  return [x1, y1, x2, y2];
}

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
    '/Highlight',
    '/Underline',
    '/StrikeOut',
    '/Squiggly',
    '/Text',
    '/FreeText',
    '/Square',
    '/Circle',
    '/Polygon',
    '/PolyLine',
    '/Line',
    '/Stamp',
    '/Ink',
  ]);

  pages.forEach((page, pageIdx) => {
    const pageNum = pageIdx + 1;
    const { width, height } = page.getSize();
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) return;

    for (let i = 0; i < annots.size(); i++) {
      const annotDict = annots.lookupMaybe(i, PDFDict);
      if (!annotDict) continue;

      const metaObj = annotDict.lookup(PDFName.of('AGYMeta'));
      if (metaObj) {
        try {
          const parsed = JSON.parse(decodePdfText(metaObj));
          parsed.page = pageNum;
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

      const isAreaType = ['/Square', '/Circle', '/Polygon', '/PolyLine', '/Line', '/Stamp', '/Ink'].includes(subtype);
      comments.push({
        id,
        type: isAreaType ? 'area' : 'text',
        page: pageNum,
        selectedText: null,
        imageB64: null,
        rect: isAreaType ? ratioRect : null,
        textRects: !isAreaType && ratioRect ? [ratioRect] : null,
        comment: contents,
        createdAt: decodePdfText(annotDict.lookup(PDFName.of('M'))) || new Date().toISOString(),
        status: 'open',
      });
    }
  });

  if (page !== undefined && page !== null) {
    return comments.filter((c) => c.page === page);
  }
  return comments;
}

export async function addPdfComment(pdfPath, payload) {
  validatePdfPath(pdfPath);
  if (!payload || typeof payload !== 'object') {
    throw new Error('CRITICAL: Comment payload is required');
  }
  const {
    id: customId,
    type = 'text',
    page,
    comment,
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

  const newEntry = {
    id,
    type,
    page,
    selectedText,
    imageB64,
    rect,
    textRects,
    comment: comment.trim(),
    createdAt,
    status: 'open',
  };

  let pdfRect = [50, height - 80, 200, height - 50];
  const quadPoints = [];

  if (type === 'area' && rect) {
    pdfRect = ratiosToPdfRect(rect, width, height);
  } else if (Array.isArray(textRects) && textRects.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of textRects) {
      const [x1, y1, x2, y2] = ratiosToPdfRect(r, width, height);
      minX = Math.min(minX, x1);
      minY = Math.min(minY, y1);
      maxX = Math.max(maxX, x2);
      maxY = Math.max(maxY, y2);
      quadPoints.push(x1, y2, x2, y2, x1, y1, x2, y1);
    }
    pdfRect = [minX, minY, maxX, maxY];
  }

  const annotProps = {
    Type: 'Annot',
    Subtype: type === 'area' ? 'Square' : 'Highlight',
    Rect: pdfRect,
    Contents: PDFHexString.fromText(newEntry.comment),
    T: PDFHexString.fromText('PDF Preview'),
    NM: PDFString.of(id),
    M: PDFString.of(createdAt),
    F: 4,
    C: type === 'area' ? [0.96, 0.62, 0.04] : [0.98, 0.82, 0.08],
    CA: type === 'area' ? 0.85 : 0.45,
    AGYMeta: PDFHexString.fromText(JSON.stringify(newEntry)),
  };

  if (quadPoints.length > 0) {
    annotProps.QuadPoints = quadPoints;
  }

  const annotDict = pdfDoc.context.obj(annotProps);
  const annotRef = pdfDoc.context.register(annotDict);

  let annots = targetPage.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) {
    annots = pdfDoc.context.obj([]);
    targetPage.node.set(PDFName.of('Annots'), annots);
  }
  annots.push(annotRef);

  const savedBytes = await pdfDoc.save();
  writeFileSync(pdfPath, savedBytes);
  const stat = statSync(pdfPath);

  return { comment: newEntry, mtime: stat.mtimeMs };
}

export async function deletePdfComment(pdfPath, commentId) {
  validatePdfPath(pdfPath);
  if (!commentId || typeof commentId !== 'string') {
    throw new Error('CRITICAL: commentId must be a valid string');
  }

  const pdfBytes = readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();
  let deletedComment = null;

  for (let pIdx = 0; pIdx < pages.length; pIdx++) {
    const page = pages[pIdx];
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;

    for (let i = 0; i < annots.size(); i++) {
      const annotDict = annots.lookupMaybe(i, PDFDict);
      if (!annotDict) continue;

      const nm = decodePdfText(annotDict.lookup(PDFName.of('NM')));
      const metaObj = annotDict.lookup(PDFName.of('AGYMeta'));
      let metaData = null;
      if (metaObj) {
        try {
          metaData = JSON.parse(decodePdfText(metaObj));
        } catch {}
      }

      const fallbackId = `ext_p${pIdx + 1}_${i}`;
      const currentId = metaData?.id || nm || fallbackId;

      if (currentId === commentId) {
        deletedComment = metaData || {
          id: currentId,
          type: 'text',
          page: pIdx + 1,
          comment: decodePdfText(annotDict.lookup(PDFName.of('Contents'))),
        };
        annots.remove(i);
        break;
      }
    }
    if (deletedComment) break;
  }

  if (!deletedComment) return { deleted: null, mtime: statSync(pdfPath).mtimeMs };

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

// CLI interface for Antigravity agent extraction/cleanup
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , cmd, targetPdf, argId] = process.argv;
  if (cmd === 'list') {
    listPdfComments(targetPdf).then((res) => console.log(JSON.stringify(res, null, 2)));
  } else if (cmd === 'delete') {
    deletePdfComment(targetPdf, argId).then((res) => console.log(JSON.stringify(res, null, 2)));
  } else if (cmd === 'clear') {
    clearPdfComments(targetPdf).then((res) => console.log(JSON.stringify(res, null, 2)));
  } else {
    console.error('Usage: node pdf_annotations.mjs <list|delete|clear> <pdfPath> [commentId]');
    process.exit(1);
  }
}
