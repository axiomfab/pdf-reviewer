import { existsSync } from 'node:fs';
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from 'pdf-lib';

export function validatePdfPath(pdfPath) {
  if (!pdfPath || typeof pdfPath !== 'string') {
    throw new Error('CRITICAL: pdfPath must be a non-empty string');
  }
  if (!existsSync(pdfPath)) {
    throw new Error(`CRITICAL: PDF file does not exist: ${pdfPath}`);
  }
}

export function decodePdfText(pdfObj) {
  if (!pdfObj) return '';
  if (pdfObj instanceof PDFHexString || pdfObj instanceof PDFString) {
    return pdfObj.decodeText();
  }
  return String(pdfObj);
}

export function pdfRectToRatios(rectArray, pageWidth, pageHeight) {
  if (!(rectArray instanceof PDFArray) || rectArray.size() < 4) return null;
  const nums = [0, 1, 2, 3].map((i) => {
    const val = rectArray.lookup(i);
    return val instanceof PDFNumber ? val.asNumber() : 0;
  });
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

export function ratiosToPdfRect(r, pageWidth, pageHeight) {
  if (!r || typeof r !== 'object') {
    throw new Error('CRITICAL: Valid ratio rectangle object required');
  }
  const x1 = r.xRatio * pageWidth;
  const x2 = (r.xRatio + r.wRatio) * pageWidth;
  const y2 = pageHeight - r.yRatio * pageHeight;
  const y1 = pageHeight - (r.yRatio + r.hRatio) * pageHeight;
  return [x1, y1, x2, y2];
}

export function findAnnotationById(pages, commentId) {
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
        return { page, annots, annotIndex: i, annotDict, metaData, currentId, pageIndex: pIdx };
      }
    }
  }
  return null;
}
