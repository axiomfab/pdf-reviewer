// PDF Reviewer: In-Document Comments, Popovers & Selection Subsystem
window.appState = {
  currentTarget: null,
  lastMtime: null,
  currentMode: 'text',
  pendingComment: null,
  loadedComments: [],
  undoStack: [],
  redoStack: [],
  showAllBoxes: false,
};

const MARKUP_TYPES = new Set(['highlight', 'underline', 'strikethrough', 'strike']);
const TEXT_SPAN_TYPES = new Set(['text', 'highlight', 'underline', 'strikethrough', 'strike']);

const commentsCount = document.getElementById('comments-count'), commentPopup = document.getElementById('comment-popup');
const popupTitle = document.getElementById('popup-title'), popupCloseBtn = document.getElementById('popup-close-btn');
const popupPreview = document.getElementById('popup-preview'), popupReplacementGroup = document.getElementById('popup-replacement-group');
const popupReplacementInput = document.getElementById('popup-replacement-input'), popupInput = document.getElementById('popup-input');
const popupPageBadge = document.getElementById('popup-page-badge'), popupSubmitBtn = document.getElementById('popup-submit-btn');

/**
 * Escapes HTML special characters for safe template insertion.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
window.escapeHtml = escapeHtml;

/**
 * Extracts normalized page ratios and selected text from a DOM Selection inside a page wrapper.
 * @param {Selection} selection
 * @param {HTMLElement} pageWrapper
 * @returns {{pageNum: number, selectedText: string, textRects: Array<{xRatio: number, yRatio: number, wRatio: number, hRatio: number}>} | null}
 */
function extractSelectionPayload(selection, pageWrapper) {
  if (!selection || typeof selection.toString !== 'function') {
    throw new Error('CRITICAL: Valid Selection object is required');
  }
  if (!pageWrapper || typeof pageWrapper.getBoundingClientRect !== 'function') {
    throw new Error('CRITICAL: Valid pageWrapper element is required');
  }
  const selectedText = selection.toString().trim();
  if (!selectedText || !selection.rangeCount) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const pageRect = pageWrapper.getBoundingClientRect();
  if (!pageRect || pageRect.width <= 0 || pageRect.height <= 0) {
    throw new Error('CRITICAL: pageWrapper must have positive bounding dimensions');
  }
  const rawRects = Array.from(range.getClientRects()).filter((r) => r && r.width > 1 && r.height > 1);
  if (rawRects.length === 0) {
    return null;
  }
  const textRects = rawRects
    .map((r) => ({
      xRatio: Math.max(0, Math.min(1, (r.left - pageRect.left) / pageRect.width)),
      yRatio: Math.max(0, Math.min(1, (r.top - pageRect.top) / pageRect.height)),
      wRatio: Math.max(0, Math.min(1, r.width / pageRect.width)),
      hRatio: Math.max(0, Math.min(1, r.height / pageRect.height)),
    }))
    .filter((r) => r.wRatio > 0 && r.hRatio > 0);
  if (textRects.length === 0) {
    return null;
  }
  const pageNum = parseInt(pageWrapper.dataset?.pageNum, 10) || 1;
  return { pageNum, selectedText, textRects };
}
window.extractSelectionPayload = extractSelectionPayload;

/**
 * Resolves normalized text bounding boxes from a PDF.js .textLayer for MCP-created markups without coordinates.
 * @param {HTMLElement} pageWrapper
 * @param {string} selectedText
 * @returns {Array<{xRatio: number, yRatio: number, wRatio: number, hRatio: number}> | null}
 */
function findTextRectsInLayer(pageWrapper, selectedText) {
  if (!pageWrapper || !selectedText || typeof selectedText !== 'string') return null;
  const needle = selectedText.replace(/\s+/g, ' ').trim();
  if (!needle) return null;
  const textLayer = pageWrapper.querySelector('.textLayer');
  if (!textLayer) return null;
  const spans = Array.from(textLayer.querySelectorAll('span'));
  if (spans.length === 0) return null;

  let fullText = '';
  const segments = [];
  for (const span of spans) {
    const node = span.firstChild;
    const txt = node && node.nodeType === 3 ? node.nodeValue : span.textContent;
    if (!txt) continue;
    const start = fullText.length;
    fullText += txt;
    segments.push({ node: node || span, start, end: fullText.length });
  }

  const normalizedChars = [];
  const indexMap = [];
  let lastWasSpace = true;
  for (let i = 0; i < fullText.length; i++) {
    const ch = fullText[i];
    if (/\s/.test(ch)) {
      if (!lastWasSpace) {
        normalizedChars.push(' ');
        indexMap.push(i);
        lastWasSpace = true;
      }
    } else {
      normalizedChars.push(ch);
      indexMap.push(i);
      lastWasSpace = false;
    }
  }
  const normalizedText = normalizedChars.join('').trimEnd();
  const matchIdx = normalizedText.indexOf(needle);
  if (matchIdx === -1) return null;

  const rawStart = indexMap[matchIdx];
  const rawEnd = indexMap[matchIdx + needle.length - 1] + 1;
  const startSeg = segments.find((s) => rawStart >= s.start && rawStart < s.end);
  const endSeg = segments.find((s) => rawEnd > s.start && rawEnd <= s.end);
  if (!startSeg || !endSeg) return null;

  const startLen = startSeg.node.nodeValue ? startSeg.node.nodeValue.length : startSeg.node.textContent.length;
  const endLen = endSeg.node.nodeValue ? endSeg.node.nodeValue.length : endSeg.node.textContent.length;
  const startOffset = Math.max(0, Math.min(startLen, rawStart - startSeg.start));
  const endOffset = Math.max(0, Math.min(endLen, rawEnd - endSeg.start));

  const range = document.createRange();
  range.setStart(startSeg.node, startOffset);
  range.setEnd(endSeg.node, endOffset);
  const pageRect = pageWrapper.getBoundingClientRect();
  if (!pageRect || pageRect.width <= 0 || pageRect.height <= 0) return null;

  const rects = Array.from(range.getClientRects())
    .filter((r) => r && r.width > 1 && r.height > 1)
    .map((r) => ({
      xRatio: Math.max(0, Math.min(1, (r.left - pageRect.left) / pageRect.width)),
      yRatio: Math.max(0, Math.min(1, (r.top - pageRect.top) / pageRect.height)),
      wRatio: Math.max(0, Math.min(1, r.width / pageRect.width)),
      hRatio: Math.max(0, Math.min(1, r.height / pageRect.height)),
    }))
    .filter((r) => r.wRatio > 0 && r.hRatio > 0);
  return rects.length > 0 ? rects : null;
}

window.attachAreaSelectionHandlers = function (overlay, canvas, pageNum) {
  let isDrawing = false, startX = 0, startY = 0, marquee = null;
  overlay.addEventListener('mousedown', (e) => {
    if (window.appState.currentMode === 'note') {
      const rect = overlay.getBoundingClientRect();
      const xRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const yRatio = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      openCommentPopup({ type: 'note', page: pageNum, rect: { xRatio, yRatio, wRatio: 0.04, hRatio: 0.03 }, x: e.clientX, y: e.clientY });
      return;
    }
    if (window.appState.currentMode !== 'area') return;
    isDrawing = true;
    const rect = overlay.getBoundingClientRect();
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top;
    marquee = document.createElement('div');
    marquee.className = 'marquee-box';
    overlay.appendChild(marquee);
  });
  overlay.addEventListener('mousemove', (e) => {
    if (!isDrawing || !marquee) return;
    const curX = e.clientX - overlay.getBoundingClientRect().left, curY = e.clientY - overlay.getBoundingClientRect().top;
    marquee.style.left = `${Math.min(startX, curX)}px`;
    marquee.style.top = `${Math.min(startY, curY)}px`;
    marquee.style.width = `${Math.abs(curX - startX)}px`;
    marquee.style.height = `${Math.abs(curY - startY)}px`;
  });
  overlay.addEventListener('mouseup', (e) => {
    if (!isDrawing || !marquee) return;
    isDrawing = false;
    const curX = e.clientX - overlay.getBoundingClientRect().left, curY = e.clientY - overlay.getBoundingClientRect().top;
    const width = Math.abs(curX - startX), height = Math.abs(curY - startY);
    const left = Math.min(startX, curX), top = Math.min(startY, curY);
    if (width > 15 && height > 15) {
      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = width; cropCanvas.height = height;
      cropCanvas.getContext('2d').drawImage(canvas, left, top, width, height, 0, 0, width, height);
      openCommentPopup({
        type: 'area', page: pageNum, imageB64: cropCanvas.toDataURL('image/png'),
        rect: { xRatio: left / overlay.clientWidth, yRatio: top / overlay.clientHeight, wRatio: width / overlay.clientWidth, hRatio: height / overlay.clientHeight },
        x: e.clientX, y: e.clientY,
      });
    }
    marquee.remove(); marquee = null;
  });
};

document.addEventListener('mouseup', async (e) => {
  if (e.target?.closest?.('#comment-popup, .pin-tooltip, .pdf-comment-pin, header')) return;
  const mode = window.appState?.currentMode;
  if (!TEXT_SPAN_TYPES.has(mode)) return;
  const selection = window.getSelection ? window.getSelection() : null;
  if (!selection || !selection.rangeCount || !selection.toString().trim()) return;
  const range = selection.getRangeAt(0);
  const anchorEl = range.commonAncestorContainer?.nodeType === 1
    ? range.commonAncestorContainer
    : range.commonAncestorContainer?.parentElement;
  const pageWrapper = e.target?.closest?.('.page-wrapper') || anchorEl?.closest?.('.page-wrapper');
  if (!pageWrapper) return;

  const extracted = extractSelectionPayload(selection, pageWrapper);
  if (!extracted) return;

  if (MARKUP_TYPES.has(mode)) {
    selection.removeAllRanges();
    const normalizedType = mode === 'strike' ? 'strikethrough' : mode;
    const payload = {
      pdfPath: window.appState.currentTarget,
      page: extracted.pageNum,
      type: normalizedType,
      comment: '',
      selectedText: extracted.selectedText,
      textRects: extracted.textRects,
    };
    if (window.commentHistory?.executeAdd) {
      await window.commentHistory.executeAdd(payload);
    } else {
      const res = await window.apiRequest('/api/comments/add', 'POST', payload);
      if (res?.mtime) window.appState.lastMtime = res.mtime;
      await window.refreshComments();
    }
    return;
  }

  const clientRects = Array.from(range.getClientRects());
  const lastRect = clientRects[clientRects.length - 1];
  openCommentPopup({
    type: 'text',
    page: extracted.pageNum,
    selectedText: extracted.selectedText,
    textRects: extracted.textRects,
    x: e.clientX || (lastRect ? lastRect.right : 120),
    y: e.clientY || (lastRect ? lastRect.bottom : 120),
  });
});

function openCommentPopup(info) {
  window.appState.pendingComment = info;
  if (info.type === 'strike' || info.type === 'strikethrough') {
    popupTitle.textContent = 'Add Strikethrough Annotation';
    popupReplacementGroup.style.display = 'block';
    popupReplacementInput.value = '';
    popupPreview.innerHTML = `Strike: <span class="strike-text">"${escapeHtml(info.selectedText || '')}"</span>`;
  } else if (info.type === 'underline') {
    popupTitle.textContent = 'Add Underline Annotation';
    popupReplacementGroup.style.display = 'none';
    popupPreview.textContent = `"${info.selectedText || ''}"`;
  } else if (info.type === 'highlight') {
    popupTitle.textContent = 'Add Highlight Annotation';
    popupReplacementGroup.style.display = 'none';
    popupPreview.textContent = `"${info.selectedText || ''}"`;
  } else if (info.type === 'note') {
    popupTitle.textContent = 'Add Sticky Note';
    popupReplacementGroup.style.display = 'none';
    popupPreview.textContent = `Drop sticky note on page ${info.page}`;
  } else if (info.type === 'area') {
    popupTitle.textContent = 'Add Visual Snip Comment';
    popupReplacementGroup.style.display = 'none';
    popupPreview.innerHTML = `<img src="${info.imageB64}" alt="Snip Preview" />`;
  } else {
    popupTitle.textContent = 'Add Text Highlight Comment';
    popupReplacementGroup.style.display = 'none';
    popupPreview.textContent = `"${info.selectedText || ''}"`;
  }
  popupPageBadge.textContent = `Page ${info.page}`;
  popupInput.value = '';
  popupInput.placeholder = MARKUP_TYPES.has(info.type) ? 'Optional note for markup...' : 'Type instruction for Antigravity...';
  commentPopup.style.display = 'flex';
  const pad = 12;
  commentPopup.style.left = `${Math.min(window.innerWidth - 300 - pad, Math.max(pad, info.x + 10))}px`;
  commentPopup.style.top = `${Math.min(window.innerHeight - 250 - pad, Math.max(pad, info.y + 10))}px`;
  popupInput.focus();
}
window.openCommentPopup = openCommentPopup;

popupCloseBtn.addEventListener('click', () => {
  commentPopup.style.display = 'none';
  window.appState.pendingComment = null;
  window.getSelection?.()?.removeAllRanges();
});
popupSubmitBtn.addEventListener('click', async () => {
  const commentText = popupInput.value.trim(), info = window.appState.pendingComment;
  if (!info) return;
  if (!commentText && !MARKUP_TYPES.has(info.type)) return;
  popupSubmitBtn.disabled = true; popupSubmitBtn.textContent = 'Saving...';
  try {
    const isStrike = info.type === 'strike' || info.type === 'strikethrough';
    const payload = {
      pdfPath: window.appState.currentTarget, page: info.page, type: info.type || 'text',
      comment: commentText, selectedText: info.selectedText || null, textRects: info.textRects || null,
      rect: info.rect || null, imageB64: info.imageB64 || null,
      replacement: isStrike ? (popupReplacementInput.value.trim() || null) : null,
    };
    if (window.commentHistory?.executeAdd) await window.commentHistory.executeAdd(payload);
    else {
      const res = await window.apiRequest('/api/comments/add', 'POST', payload);
      if (res?.mtime) window.appState.lastMtime = res.mtime;
      await window.refreshComments();
    }
    commentPopup.style.display = 'none';
    window.appState.pendingComment = null;
    window.getSelection?.()?.removeAllRanges();
  } catch (err) { console.error('Failed to add comment:', err); }
  finally { popupSubmitBtn.disabled = false; popupSubmitBtn.textContent = 'Save to PDF'; }
});

/**
 * Deletes an annotation or markup by ID and refreshes the rendered page markers.
 * @param {string} id
 * @returns {Promise<void>}
 */
async function deleteComment(id) {
  if (!id || typeof id !== 'string') throw new Error('CRITICAL: Valid commentId string required for deletion');
  const pdfPath = window.appState?.currentTarget;
  if (!pdfPath) throw new Error('CRITICAL: No active PDF selected for comment deletion');
  if (window.commentHistory?.executeDelete) await window.commentHistory.executeDelete(id, pdfPath);
  else {
    const res = await window.apiRequest('/api/comments/delete', 'POST', { id, pdfPath });
    if (res?.mtime) window.appState.lastMtime = res.mtime;
    await window.refreshComments();
  }
}
window.deleteComment = deleteComment;

function calculatePopoverPosition({ overlayWidth, overlayHeight, rects, boxWidth = 290, boxHeight = 125, padding = 12, viewportBounds = null }) {
  if (!overlayWidth || overlayWidth <= 0 || !overlayHeight || overlayHeight <= 0) throw new Error('CRITICAL: overlayWidth and overlayHeight must be positive numbers');
  if (!Array.isArray(rects) || rects.length === 0) throw new Error('CRITICAL: rects must be a non-empty array');
  if (viewportBounds !== null && typeof viewportBounds === 'object') {
    if (typeof viewportBounds.top !== 'number' || typeof viewportBounds.bottom !== 'number' || isNaN(viewportBounds.top) || isNaN(viewportBounds.bottom)) throw new Error('CRITICAL: viewportBounds must have numeric top and bottom');
    if (viewportBounds.top > viewportBounds.bottom) throw new Error('CRITICAL: viewportBounds.top cannot exceed viewportBounds.bottom');
  }
  let topY = Infinity, bottomY = -Infinity;
  const lastRect = rects[rects.length - 1];
  for (const r of rects) {
    if (!r || typeof r.yRatio !== 'number' || typeof r.hRatio !== 'number') throw new Error('CRITICAL: Each rect must have numeric yRatio and hRatio');
    const rTop = r.yRatio * overlayHeight, rBottom = (r.yRatio + r.hRatio) * overlayHeight;
    if (rTop < topY) topY = rTop;
    if (rBottom > bottomY) bottomY = rBottom;
  }
  const anchorX = ((lastRect.xRatio ?? 0) + (lastRect.wRatio ?? 0)) * overlayWidth, GAP = 8;
  const viewTop = (viewportBounds && typeof viewportBounds.top === 'number') ? Math.max(padding, viewportBounds.top + padding) : padding;
  const viewBottom = (viewportBounds && typeof viewportBounds.bottom === 'number') ? Math.min(overlayHeight - padding, viewportBounds.bottom - padding) : overlayHeight - padding;
  const spaceAbove = topY - viewTop, spaceBelow = viewBottom - bottomY, neededHeight = boxHeight + GAP;
  let placement = 'below', boxTop = bottomY + GAP;
  if (spaceBelow < neededHeight && spaceAbove >= neededHeight) { placement = 'above'; boxTop = topY - GAP - boxHeight; }
  else if (spaceAbove < neededHeight && spaceBelow >= neededHeight) { placement = 'below'; boxTop = bottomY + GAP; }
  else if (spaceBelow < neededHeight && spaceAbove < neededHeight) { placement = spaceAbove > spaceBelow ? 'above' : 'below'; boxTop = placement === 'above' ? topY - GAP - boxHeight : bottomY + GAP; }
  boxTop = Math.max(padding, Math.min(overlayHeight - boxHeight - padding, boxTop));
  const boxLeft = Math.max(padding, Math.min(overlayWidth - boxWidth - padding, anchorX - boxWidth / 2));
  const arrowX = Math.max(16, Math.min(boxWidth - 16, anchorX - boxLeft));
  return { placement, boxLeft, boxTop, arrowX };
}
window.calculatePopoverPosition = calculatePopoverPosition;

function activatePopover(pin, tooltip) {
  if (!pin || !tooltip) throw new Error('CRITICAL: pin and tooltip elements are required to activate popover');
  const commentId = pin.dataset?.commentId || tooltip.dataset?.commentId, isCurrentlyActive = tooltip.classList.contains('active');
  document.querySelectorAll('.pin-tooltip.active').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.pdf-comment-pin.pin-active').forEach((el) => el.classList.remove('pin-active'));
  document.querySelectorAll('.pin-parent-active').forEach((el) => el.classList.remove('pin-parent-active'));
  if (!isCurrentlyActive) {
    tooltip.classList.add('active', 'pin-visible'); pin.classList.add('pin-active', 'pin-visible');
    if (commentId) document.querySelectorAll(`.mark-${commentId}`).forEach((el) => el.classList.add('pin-parent-active', 'highlight'));
    const parentMark = pin.closest('.pdf-text-highlight, .pdf-text-underline, .pdf-comment-box, .pdf-text-strike');
    if (parentMark) parentMark.classList.add('pin-parent-active');
  }
}
window.activatePopover = activatePopover;

function createPopover({ comment, index, targetRects, overlay, isAi, isNote }) {
  if (!comment || typeof comment !== 'object') throw new Error('CRITICAL: comment object required for createPopover');
  if (!overlay) throw new Error('CRITICAL: overlay element required for createPopover');
  const idx = typeof index === 'number' ? index : 0, pin = document.createElement('div');
  if (isNote) { pin.className = `pdf-comment-pin pin-note ${isAi ? 'ai-pin' : ''}`; pin.innerHTML = `<span>#${idx + 1}</span>`; }
  else { pin.className = `pdf-comment-anchor mark-pin-${comment.id}`; }
  pin.dataset.commentId = comment.id;
  const authorText = comment.author || (isAi ? 'Antigravity AI' : 'User');
  const authorLabel = isAi ? `🤖 ${authorText}` : `👤 ${authorText}`;
  const isTextSpan = TEXT_SPAN_TYPES.has(comment.type || 'text');
  const typeSwitcherHtml = isTextSpan
    ? `<div class="pin-type-switcher" title="Change markup style">
        <button class="pin-type-btn ${['highlight', 'text'].includes(comment.type) ? 'active' : ''}" data-type="highlight" title="Highlight">H</button>
        <button class="pin-type-btn ${comment.type === 'underline' ? 'active' : ''}" data-type="underline" title="Underline">U</button>
        <button class="pin-type-btn ${['strikethrough', 'strike'].includes(comment.type) ? 'active' : ''}" data-type="strikethrough" title="Strikethrough">S</button>
      </div>`
    : '';
  const hasComment = Boolean(comment.comment && comment.comment.trim());
  const commentHtml = hasComment
    ? escapeHtml(comment.comment)
    : '<span class="pin-comment-placeholder">Click to add note...</span>';
  const replacementHtml = comment.replacement
    ? `<div class="pin-replacement-row">→ <span class="replacement-text">${escapeHtml(comment.replacement)}</span></div>`
    : '';

  const tooltip = document.createElement('div');
  tooltip.className = 'pin-tooltip'; tooltip.dataset.commentId = comment.id;
  tooltip.innerHTML = `
    <div class="pin-tooltip-header">
      <span class="pin-tooltip-author ${isAi ? 'ai-author' : 'user-author'}">${authorLabel}</span>
      <div class="pin-tooltip-header-actions">
        <span class="pin-tooltip-meta">Page ${comment.page} • ${(comment.type || 'text').toUpperCase()}</span>
        ${typeSwitcherHtml}
        <button class="pin-tooltip-delete" title="Delete from PDF">🗑️</button>
        <button class="pin-tooltip-close" title="Close">✕</button>
      </div>
    </div>
    <div class="pin-tooltip-body" title="Click to edit comment">
      ${replacementHtml}
      <div class="pin-comment-display"><span class="pin-comment-text">${commentHtml}</span><span class="pin-edit-icon" title="Edit">✏️</span></div>
    </div>
    <div class="pin-edit-form" style="display: none;">
      <textarea class="pin-edit-textarea" rows="2" placeholder="Update comment...">${escapeHtml(comment.comment || '')}</textarea>
      <div class="pin-edit-actions"><button class="pin-save-btn">Save</button><button class="pin-cancel-btn">Cancel</button></div>
    </div>`;
  tooltip.addEventListener('click', (e) => e.stopPropagation());
  const updatePosition = () => {
    let viewportBounds = null;
    try {
      const viewer = document.getElementById('viewer-container'), viewerRect = viewer ? viewer.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      const overlayRect = overlay.getBoundingClientRect(), visibleTop = Math.max(0, viewerRect.top - overlayRect.top), visibleBottom = Math.min(overlay.clientHeight, viewerRect.bottom - overlayRect.top);
      if (visibleBottom > visibleTop) viewportBounds = { top: visibleTop, bottom: visibleBottom };
    } catch {}
    const pos = calculatePopoverPosition({ overlayWidth: overlay.clientWidth, overlayHeight: overlay.clientHeight, rects: targetRects, boxWidth: 290, boxHeight: 125, viewportBounds });
    tooltip.style.left = `${pos.boxLeft}px`; tooltip.style.top = `${pos.boxTop}px`; tooltip.style.setProperty('--arrow-x', `${pos.arrowX}px`);
    tooltip.classList.toggle('tooltip-below', pos.placement === 'below'); tooltip.classList.toggle('tooltip-above', pos.placement === 'above');
    tooltip.classList.toggle('tooltip-left', pos.boxLeft <= 16); tooltip.classList.toggle('tooltip-right', pos.boxLeft >= overlay.clientWidth - 290 - 16);
  };
  tooltip._updatePosition = updatePosition; updatePosition();

  tooltip.querySelectorAll('.pin-type-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const nextType = btn.dataset.type;
      if (!nextType || nextType === comment.type) return;
      if (window.commentHistory?.executeModify) {
        await window.commentHistory.executeModify(comment.id, { type: nextType }, { ...comment });
      } else {
        const res = await window.apiRequest('/api/comments/modify', 'POST', {
          id: comment.id,
          type: nextType,
          pdfPath: window.appState?.currentTarget,
        });
        if (res?.mtime) window.appState.lastMtime = res.mtime;
        await window.refreshComments();
      }
    });
  });

  const delBtn = tooltip.querySelector('.pin-tooltip-delete');
  if (delBtn) delBtn.addEventListener('click', async (e) => { e.stopPropagation(); const c = comment; await deleteComment(c.id); });
  tooltip.querySelector('.pin-tooltip-close').addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.appState?.showAllBoxes) tooltip.classList.add('box-hidden');
    tooltip.classList.remove('active', 'pin-visible'); pin.classList.remove('pin-active');
    document.querySelectorAll(`.mark-${comment.id}`).forEach((el) => el.classList.remove('pin-parent-active', 'highlight'));
    if (!pin.matches(':hover') && !isNote) pin.classList.remove('pin-visible');
  });
  const bodyEl = tooltip.querySelector('.pin-tooltip-body'), formEl = tooltip.querySelector('.pin-edit-form'), textarea = tooltip.querySelector('.pin-edit-textarea'), textSpan = tooltip.querySelector('.pin-comment-text'), saveBtn = tooltip.querySelector('.pin-save-btn'), cancelBtn = tooltip.querySelector('.pin-cancel-btn');
  const enterEdit = () => { bodyEl.style.display = 'none'; formEl.style.display = 'flex'; textarea.value = comment.comment || ''; textarea.focus(); textarea.select(); };
  const exitEdit = () => { formEl.style.display = 'none'; bodyEl.style.display = 'block'; };
  bodyEl.addEventListener('click', (e) => { e.stopPropagation(); enterEdit(); });
  cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); exitEdit(); });
  const saveEdit = async () => {
    const newText = textarea.value.trim();
    const isMarkup = MARKUP_TYPES.has(comment.type);
    if (!newText && !isMarkup) { exitEdit(); return; }
    if (newText === (comment.comment || '')) { exitEdit(); return; }
    const commentUpdate = newText === '' ? null : newText;
    saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
    try {
      let updated = null;
      if (window.commentHistory?.executeModify) {
        updated = await window.commentHistory.executeModify(comment.id, { comment: commentUpdate }, { ...comment });
      } else {
        const res = await window.apiRequest('/api/comments/modify', 'POST', {
          id: comment.id,
          comment: commentUpdate,
          pdfPath: window.appState?.currentTarget,
        });
        if (res?.success && res.comment) {
          updated = res.comment;
          if (res.mtime) window.appState.lastMtime = res.mtime;
        }
      }
      if (updated) {
        comment.comment = updated.comment;
        if (textSpan) {
          textSpan.innerHTML = comment.comment
            ? escapeHtml(comment.comment)
            : '<span class="pin-comment-placeholder">Click to add note...</span>';
        }
      }
    } catch (err) { console.error('Failed to update comment:', err); }
    finally { saveBtn.disabled = false; saveBtn.textContent = 'Save'; exitEdit(); }
  };
  saveBtn.addEventListener('click', (e) => { e.stopPropagation(); saveEdit(); });
  textarea.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEdit(); }
    else if (e.key === 'Escape') { e.preventDefault(); exitEdit(); }
  });
  let hideTimer = null;
  const showPin = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } updatePosition(); tooltip.classList.add('pin-visible'); if (isNote) pin.classList.add('pin-visible'); document.querySelectorAll(`.mark-${comment.id}`).forEach((el) => el.classList.add('highlight')); };
  const hidePin = () => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!pin.matches(':hover') && !tooltip.matches(':hover') && !tooltip.classList.contains('active')) {
        const anyMark = Array.from(document.querySelectorAll(`.mark-${comment.id}`)).some((el) => el.matches(':hover'));
        if (!anyMark) { tooltip.classList.remove('pin-visible'); if (isNote && !pin.classList.contains('pin-active')) pin.classList.remove('pin-visible'); document.querySelectorAll(`.mark-${comment.id}`).forEach((el) => el.classList.remove('highlight')); }
      }
    }, 120);
  };
  const activate = () => { updatePosition(); activatePopover(pin, tooltip); };
  pin.addEventListener('mouseenter', showPin); pin.addEventListener('mouseleave', hidePin);
  tooltip.addEventListener('mouseenter', showPin); tooltip.addEventListener('mouseleave', hidePin);
  pin.addEventListener('click', (e) => { e.stopPropagation(); activate(); });
  return { pin, tooltip, showPin, hidePin, activate, updatePosition };
}
window.createPopover = createPopover;

function formatCommentsToggleLabel(count, isShowing) {
  const n = Number.isFinite(Number(count)) ? Math.max(0, Math.floor(Number(count))) : 0;
  const noun = n === 1 ? 'comment' : 'comments';
  return isShowing ? `Hide all ${n} ${noun}` : `Show all ${n} ${noun}`;
}
window.formatCommentsToggleLabel = formatCommentsToggleLabel;

function updateCommentsToggleA11y() {
  const count = window.appState?.loadedComments?.length ?? 0;
  const isShowing = Boolean(window.appState?.showAllBoxes);
  const countEl = document.getElementById('comments-count') || commentsCount;
  if (countEl) countEl.textContent = String(count);
  const toggleBtn = document.getElementById('comments-toggle-btn');
  if (toggleBtn) {
    toggleBtn.classList.toggle('active', isShowing);
    toggleBtn.setAttribute('aria-pressed', isShowing ? 'true' : 'false');
    toggleBtn.setAttribute('aria-label', formatCommentsToggleLabel(count, isShowing));
    toggleBtn.title = isShowing ? 'Hide comment boxes (show on hover)' : 'Display all comment boxes on page';
  }
}
window.updateCommentsToggleA11y = updateCommentsToggleA11y;

window.refreshComments = async function () {
  const pdfPath = window.appState.currentTarget;
  if (!pdfPath) {
    window.appState.loadedComments = [];
    updateCommentsToggleA11y();
    window.renderCommentMarkersOnPages();
    return;
  }
  const data = await window.apiRequest(`/api/comments/list?pdfPath=${encodeURIComponent(pdfPath)}`);
  const comments = data?.comments || [];
  window.appState.loadedComments = comments;
  updateCommentsToggleA11y();
  window.renderCommentMarkersOnPages();
};

window.toggleShowAllComments = function (forceState) {
  if (typeof forceState === 'boolean') window.appState.showAllBoxes = forceState;
  else if (forceState !== undefined) throw new Error('CRITICAL: forceState must be a boolean when provided');
  else window.appState.showAllBoxes = !window.appState.showAllBoxes;
  const isShowing = window.appState.showAllBoxes;
  document.body.classList.toggle('show-all-comments', isShowing);
  if (isShowing) {
    document.querySelectorAll('.pin-tooltip.box-hidden').forEach((el) => el.classList.remove('box-hidden'));
    document.querySelectorAll('.pin-tooltip').forEach((el) => { if (typeof el._updatePosition === 'function') el._updatePosition(); });
  }
  updateCommentsToggleA11y();
  return isShowing;
};

window.renderCommentMarkersOnPages = function () {
  document.querySelectorAll('.pdf-comment-box, .pdf-comment-pin, .pdf-comment-anchor, .pin-tooltip, .pdf-text-highlight, .pdf-text-strike, .pdf-text-underline, .pdf-comment-note').forEach((el) => el.remove());
  window.appState.loadedComments.forEach((c, idx) => {
    const pageWrapper = document.querySelector(`.page-wrapper[data-page-num="${c.page}"]`);
    if (!pageWrapper) return;
    const overlay = pageWrapper.querySelector('.selection-overlay');
    if (!overlay) return;
    const isAi = Boolean(c.author && /ai|llm|assistant|agent|antigravity/i.test(c.author));
    const isNote = c.type === 'note';
    const isTextSpan = TEXT_SPAN_TYPES.has(c.type || 'text');

    if (c.type === 'area' && c.rect) {
      const box = document.createElement('div');
      box.className = `pdf-comment-box mark-${c.id}`;
      box.style.left = `${c.rect.xRatio * overlay.clientWidth}px`; box.style.top = `${c.rect.yRatio * overlay.clientHeight}px`;
      box.style.width = `${c.rect.wRatio * overlay.clientWidth}px`; box.style.height = `${c.rect.hRatio * overlay.clientHeight}px`;
      const { pin, tooltip, showPin, hidePin, activate } = createPopover({ comment: c, index: idx, targetRects: [c.rect], overlay, isAi, isNote: false });
      pin.classList.add(`mark-pin-${c.id}`); pin.style.left = `${c.rect.xRatio * overlay.clientWidth}px`; pin.style.top = `${c.rect.yRatio * overlay.clientHeight}px`;
      box.addEventListener('mouseenter', showPin); box.addEventListener('mouseleave', hidePin); box.addEventListener('click', (e) => { e.stopPropagation(); activate(); });
      overlay.appendChild(box); overlay.appendChild(pin); overlay.appendChild(tooltip);
    } else if (isNote || (!isTextSpan && c.rect && !c.textRects?.length)) {
      const rawX = (c.rect?.xRatio ?? 0.88) * overlay.clientWidth, rawY = (c.rect?.yRatio ?? 0.08) * overlay.clientHeight;
      const x = Math.max(22, Math.min(overlay.clientWidth - 35, rawX)), y = Math.max(14, Math.min(overlay.clientHeight - 16, rawY));
      const noteRect = { xRatio: Math.max(0, (x - 12) / overlay.clientWidth), yRatio: Math.max(0, (y - 12) / overlay.clientHeight), wRatio: 24 / overlay.clientWidth, hRatio: 24 / overlay.clientHeight };
      const { pin, tooltip } = createPopover({ comment: c, index: idx, targetRects: [noteRect], overlay, isAi, isNote: true });
      pin.classList.add(`mark-${c.id}`, `mark-pin-${c.id}`); pin.style.left = `${x}px`; pin.style.top = `${y}px`;
      overlay.appendChild(pin); overlay.appendChild(tooltip);
    } else {
      const resolvedTextRects = c.textRects?.length
        ? c.textRects
        : (c.rect ? [c.rect] : findTextRectsInLayer(pageWrapper, c.selectedText));
      if (resolvedTextRects?.length) {
        const markClass = (c.type === 'strike' || c.type === 'strikethrough')
          ? 'pdf-text-strike'
          : (c.type === 'underline' ? 'pdf-text-underline' : 'pdf-text-highlight');
        const { pin, tooltip, showPin, hidePin, activate } = createPopover({
          comment: c,
          index: idx,
          targetRects: resolvedTextRects,
          overlay,
          isAi,
          isNote: false,
        });
        pin.classList.add(`mark-pin-${c.id}`);
        const lastRect = resolvedTextRects[resolvedTextRects.length - 1];
        pin.style.left = `${(lastRect.xRatio + lastRect.wRatio) * overlay.clientWidth}px`;
        pin.style.top = `${lastRect.yRatio * overlay.clientHeight}px`;
        resolvedTextRects.forEach((r) => {
          const mark = document.createElement('div');
          mark.className = `${markClass} mark-${c.id}`;
          mark.style.left = `${r.xRatio * overlay.clientWidth}px`; mark.style.top = `${r.yRatio * overlay.clientHeight}px`;
          mark.style.width = `${r.wRatio * overlay.clientWidth}px`; mark.style.height = `${r.hRatio * overlay.clientHeight}px`;
          mark.addEventListener('mouseenter', showPin); mark.addEventListener('mouseleave', hidePin); mark.addEventListener('click', (e) => { e.stopPropagation(); activate(); });
          overlay.appendChild(mark);
        });
        overlay.appendChild(pin); overlay.appendChild(tooltip);
      } else if (c.comment || c.selectedText) {
        const rawX = 0.88 * overlay.clientWidth, rawY = Math.min(0.9, 0.08 + (idx * 0.04)) * overlay.clientHeight;
        const x = Math.max(22, Math.min(overlay.clientWidth - 35, rawX)), y = Math.max(14, Math.min(overlay.clientHeight - 16, rawY));
        const fallbackRect = { xRatio: Math.max(0, (x - 12) / overlay.clientWidth), yRatio: Math.max(0, (y - 12) / overlay.clientHeight), wRatio: 24 / overlay.clientWidth, hRatio: 24 / overlay.clientHeight };
        const { pin, tooltip } = createPopover({ comment: c, index: idx, targetRects: [fallbackRect], overlay, isAi, isNote: true });
        pin.classList.add(`mark-${c.id}`, `mark-pin-${c.id}`); pin.style.left = `${x}px`; pin.style.top = `${y}px`;
        overlay.appendChild(pin); overlay.appendChild(tooltip);
      }
    }
  });
  if (window.appState.showAllBoxes) document.body.classList.add('show-all-comments');
};

document.addEventListener('click', (e) => {
  if (window.appState?.showAllBoxes) return;
  if (!e.target.closest('.pdf-comment-pin, .pdf-comment-anchor, .pdf-text-highlight, .pdf-text-underline, .pdf-comment-box, .pdf-text-strike, .pin-tooltip')) {
    document.querySelectorAll('.pin-tooltip.active, .pin-tooltip.pin-visible').forEach((el) => { if (!el.matches(':hover')) el.classList.remove('active', 'pin-visible'); });
    document.querySelectorAll('.pdf-comment-pin.pin-active').forEach((el) => el.classList.remove('pin-active'));
    document.querySelectorAll('.pin-parent-active').forEach((el) => el.classList.remove('pin-parent-active'));
    document.querySelectorAll('.pdf-comment-pin:not(.pin-note)').forEach((p) => { if (!p.matches(':hover')) p.classList.remove('pin-visible'); });
    document.querySelectorAll('.pdf-text-highlight.highlight, .pdf-text-underline.highlight, .pdf-text-strike.highlight, .pdf-comment-box.highlight').forEach((el) => { if (!el.matches(':hover')) el.classList.remove('highlight'); });
  }
});
