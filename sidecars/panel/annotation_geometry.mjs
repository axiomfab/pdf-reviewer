import { existsSync } from 'node:fs';
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from 'pdf-lib';

export const ALLOWED_ANNOTATION_TYPES = [
  'note',
  'text',
  'area',
  'highlight',
  'underline',
  'strikethrough',
  'strike',
];

export const MARKUP_ANNOTATION_TYPES = new Set([
  'highlight',
  'underline',
  'strikethrough',
  'strike',
]);

export const TEXT_SPAN_ANNOTATION_TYPES = new Set([
  'text',
  'highlight',
  'underline',
  'strikethrough',
  'strike',
]);

const SUBTYPE_TO_ANNOTATION_TYPE = {
  '/Highlight': 'highlight',
  '/Underline': 'underline',
  '/Squiggly': 'underline',
  '/StrikeOut': 'strikethrough',
  '/Text': 'note',
  '/FreeText': 'note',
  '/Square': 'area',
  '/Circle': 'area',
  '/Polygon': 'area',
  '/PolyLine': 'area',
  '/Line': 'area',
  '/Stamp': 'area',
  '/Ink': 'area',
};

const ANNOTATION_TYPE_TO_SUBTYPE = {
  area: 'Square',
  note: 'Text',
  text: 'Highlight',
  highlight: 'Highlight',
  underline: 'Underline',
  strike: 'StrikeOut',
  strikethrough: 'StrikeOut',
};

/**
 * Validates that a PDF file path is a non-empty string pointing to an existing file.
 * @param {string} pdfPath
 * @returns {void}
 */
export function validatePdfPath(pdfPath) {
  if (!pdfPath || typeof pdfPath !== 'string') {
    throw new Error('CRITICAL: pdfPath must be a non-empty string');
  }
  if (!existsSync(pdfPath)) {
    throw new Error(`CRITICAL: PDF file does not exist: ${pdfPath}`);
  }
}

/**
 * Decodes a PDFHexString, PDFString, or primitive object into a plain JS string.
 * @param {unknown} pdfObj
 * @returns {string}
 */
export function decodePdfText(pdfObj) {
  if (!pdfObj) return '';
  if (pdfObj instanceof PDFHexString || pdfObj instanceof PDFString) {
    return pdfObj.decodeText();
  }
  return String(pdfObj);
}

/**
 * Validates that a normalized ratio rectangle object has finite numeric dimensions.
 * @param {Record<string, unknown>} r
 * @param {string} [label='rect']
 * @returns {{xRatio: number, yRatio: number, wRatio: number, hRatio: number}}
 */
export function validateRatioRect(r, label = 'rect') {
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    throw new Error('CRITICAL: Valid ratio rectangle object required');
  }
  for (const key of ['xRatio', 'yRatio', 'wRatio', 'hRatio']) {
    if (typeof r[key] !== 'number' || !Number.isFinite(r[key])) {
      throw new Error(`CRITICAL: ${label}.${key} must be a finite number`);
    }
  }
  if (r.wRatio < 0 || r.hRatio < 0) {
    throw new Error(`CRITICAL: ${label}.wRatio and ${label}.hRatio must be non-negative`);
  }
  return r;
}

/**
 * Validates a non-empty array of normalized ratio rectangle objects.
 * @param {unknown[]} textRects
 * @returns {Array<{xRatio: number, yRatio: number, wRatio: number, hRatio: number}>}
 */
export function validateTextRects(textRects) {
  if (!Array.isArray(textRects) || textRects.length === 0) {
    throw new Error('CRITICAL: textRects must be a non-empty array of valid ratio rectangles');
  }
  return textRects.map((rect, idx) => validateRatioRect(rect, `textRects[${idx}]`));
}

/**
 * Validates positive finite page dimensions.
 * @param {number} pageWidth
 * @param {number} pageHeight
 * @returns {void}
 */
function validatePageDimensions(pageWidth, pageHeight) {
  if (
    typeof pageWidth !== 'number' ||
    !Number.isFinite(pageWidth) ||
    pageWidth <= 0 ||
    typeof pageHeight !== 'number' ||
    !Number.isFinite(pageHeight) ||
    pageHeight <= 0
  ) {
    throw new Error('CRITICAL: pageWidth and pageHeight must be positive numbers');
  }
}

/**
 * Converts a PDF /Rect array into normalized top-left page ratios.
 * @param {PDFArray | unknown} rectArray
 * @param {number} pageWidth
 * @param {number} pageHeight
 * @returns {{xRatio: number, yRatio: number, wRatio: number, hRatio: number} | null}
 */
export function pdfRectToRatios(rectArray, pageWidth, pageHeight) {
  validatePageDimensions(pageWidth, pageHeight);
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

/**
 * Converts a normalized ratio rectangle into a PDF coordinate [x1, y1, x2, y2] array.
 * @param {{xRatio: number, yRatio: number, wRatio: number, hRatio: number}} r
 * @param {number} pageWidth
 * @param {number} pageHeight
 * @returns {[number, number, number, number]}
 */
export function ratiosToPdfRect(r, pageWidth, pageHeight) {
  validateRatioRect(r);
  validatePageDimensions(pageWidth, pageHeight);
  const x1 = r.xRatio * pageWidth;
  const x2 = (r.xRatio + r.wRatio) * pageWidth;
  const y2 = pageHeight - r.yRatio * pageHeight;
  const y1 = pageHeight - (r.yRatio + r.hRatio) * pageHeight;
  return [x1, y1, x2, y2];
}

/**
 * Converts ISO 32000 /QuadPoints array into normalized ratio rectangles.
 * @param {PDFArray | unknown} quadPointsArray
 * @param {number} pageWidth
 * @param {number} pageHeight
 * @returns {Array<{xRatio: number, yRatio: number, wRatio: number, hRatio: number}> | null}
 */
export function quadPointsToRatioRects(quadPointsArray, pageWidth, pageHeight) {
  validatePageDimensions(pageWidth, pageHeight);
  if (!(quadPointsArray instanceof PDFArray) || quadPointsArray.size() < 8 || quadPointsArray.size() % 8 !== 0) {
    return null;
  }

  const rects = [];
  for (let i = 0; i < quadPointsArray.size(); i += 8) {
    const coords = [];
    for (let j = 0; j < 8; j++) {
      const val = quadPointsArray.lookup(i + j);
      coords.push(val instanceof PDFNumber ? val.asNumber() : 0);
    }
    const xs = [coords[0], coords[2], coords[4], coords[6]];
    const ys = [coords[1], coords[3], coords[5], coords[7]];
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const bottom = Math.min(...ys);
    const top = Math.max(...ys);

    rects.push({
      xRatio: Math.max(0, Math.min(1, left / pageWidth)),
      yRatio: Math.max(0, Math.min(1, (pageHeight - top) / pageHeight)),
      wRatio: Math.max(0, Math.min(1, (right - left) / pageWidth)),
      hRatio: Math.max(0, Math.min(1, (top - bottom) / pageHeight)),
    });
  }

  return rects.length > 0 ? rects : null;
}

/**
 * Computes ISO 32000 /QuadPoints, bounding /Rect, and union ratio rect from ratio rectangles.
 * @param {Array<{xRatio: number, yRatio: number, wRatio: number, hRatio: number}>} ratioRects
 * @param {number} pageWidth
 * @param {number} pageHeight
 * @returns {{quadPoints: number[], pdfRect: [number, number, number, number], unionRatioRect: {xRatio: number, yRatio: number, wRatio: number, hRatio: number}}}
 */
export function rectsToQuadPointsAndBounds(ratioRects, pageWidth, pageHeight) {
  const validRects = validateTextRects(ratioRects);
  validatePageDimensions(pageWidth, pageHeight);

  const quadPoints = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minXR = Infinity;
  let minYR = Infinity;
  let maxXR = -Infinity;
  let maxYR = -Infinity;

  for (const r of validRects) {
    const [x1, y1, x2, y2] = ratiosToPdfRect(r, pageWidth, pageHeight);
    minX = Math.min(minX, x1);
    minY = Math.min(minY, y1);
    maxX = Math.max(maxX, x2);
    maxY = Math.max(maxY, y2);
    minXR = Math.min(minXR, r.xRatio);
    minYR = Math.min(minYR, r.yRatio);
    maxXR = Math.max(maxXR, r.xRatio + r.wRatio);
    maxYR = Math.max(maxYR, r.yRatio + r.hRatio);
    quadPoints.push(x1, y2, x2, y2, x1, y1, x2, y1);
  }

  return {
    quadPoints,
    pdfRect: [minX, minY, maxX, maxY],
    unionRatioRect: {
      xRatio: minXR,
      yRatio: minYR,
      wRatio: maxXR - minXR,
      hRatio: maxYR - minYR,
    },
  };
}

/**
 * Maps an annotation type string to its ISO 32000 PDF /Subtype name.
 * @param {string} type
 * @returns {string}
 */
export function annotationTypeToSubtype(type) {
  if (typeof type !== 'string' || !ALLOWED_ANNOTATION_TYPES.includes(type)) {
    throw new Error(`CRITICAL: Unsupported annotation type '${type}'`);
  }
  return ANNOTATION_TYPE_TO_SUBTYPE[type];
}

/**
 * Maps an ISO 32000 PDF /Subtype name to the plugin's canonical annotation type.
 * @param {string} subtype
 * @returns {string}
 */
export function subtypeToAnnotationType(subtype) {
  if (typeof subtype !== 'string' || !subtype.trim()) {
    throw new Error('CRITICAL: PDF annotation subtype must be a non-empty string');
  }
  const normalized = subtype.trim().startsWith('/') ? subtype.trim() : `/${subtype.trim()}`;
  const mapped = SUBTYPE_TO_ANNOTATION_TYPE[normalized];
  if (!mapped) {
    throw new Error(`CRITICAL: Unsupported PDF annotation subtype '${normalized}'`);
  }
  return mapped;
}

/**
 * Evaluates whether an annotation entry type matches a requested type filter.
 * @param {string} entryType
 * @param {string} filterType
 * @returns {boolean}
 */
export function matchesTypeFilter(entryType, filterType) {
  if (typeof filterType !== 'string' || !ALLOWED_ANNOTATION_TYPES.includes(filterType)) {
    throw new Error(`CRITICAL: Invalid annotation type filter '${filterType}'`);
  }
  if (typeof entryType !== 'string' || !ALLOWED_ANNOTATION_TYPES.includes(entryType)) {
    throw new Error(`CRITICAL: Invalid entry annotation type '${entryType}'`);
  }
  if (filterType === 'strikethrough' || filterType === 'strike') {
    return entryType === 'strikethrough' || entryType === 'strike';
  }
  if (filterType === 'highlight') {
    return entryType === 'highlight' || entryType === 'text';
  }
  return entryType === filterType;
}

/**
 * Locates an annotation dictionary across PDF pages by AGYMeta ID, /NM, or fallback index ID.
 * @param {import('pdf-lib').PDFPage[]} pages
 * @param {string} commentId
 * @returns {{page: import('pdf-lib').PDFPage, annots: PDFArray, annotIndex: number, annotDict: PDFDict, metaData: Record<string, unknown> | null, currentId: string, pageIndex: number} | null}
 */
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
