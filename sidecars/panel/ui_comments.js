window.appState = {
  currentTarget: null,
  lastMtime: null,
  currentMode: 'text',
  pendingComment: null,
  loadedComments: [],
  undoStack: [],
  redoStack: [],
};

const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');
const commentsCount = document.getElementById('comments-count');
const commentsDrawer = document.getElementById('comments-drawer');
const commentsList = document.getElementById('comments-list');
const commentPopup = document.getElementById('comment-popup');
const popupTitle = document.getElementById('popup-title');
const popupCloseBtn = document.getElementById('popup-close-btn');
const popupPreview = document.getElementById('popup-preview');
const popupInput = document.getElementById('popup-input');
const popupPageBadge = document.getElementById('popup-page-badge');
const popupSubmitBtn = document.getElementById('popup-submit-btn');

function updateHistoryButtons() {
  undoBtn.disabled = window.appState.undoStack.length === 0;
  redoBtn.disabled = window.appState.redoStack.length === 0;
}

async function deleteCommentWithHistory(id, recordHistory = true) {
  const pdfPath = window.appState.currentTarget;
  if (!pdfPath) return;
  const res = await window.apiRequest('/api/comments/delete', 'POST', { id, pdfPath });
  if (res?.mtime) window.appState.lastMtime = res.mtime;
  if (res?.success && recordHistory && res.comment) {
    window.appState.undoStack.push({ action: 'delete', pdfPath, comment: res.comment });
    window.appState.redoStack.length = 0;
    updateHistoryButtons();
  }
  await window.refreshComments();
}

async function addCommentWithHistory(commentData, recordHistory = true) {
  const pdfPath = window.appState.currentTarget;
  if (!pdfPath) return null;
  const res = await window.apiRequest('/api/comments/add', 'POST', { ...commentData, pdfPath });
  if (res?.mtime) window.appState.lastMtime = res.mtime;
  if (res?.success && recordHistory && res.comment) {
    window.appState.undoStack.push({ action: 'add', pdfPath, comment: res.comment });
    window.appState.redoStack.length = 0;
    updateHistoryButtons();
  }
  await window.refreshComments();
  return res?.comment;
}

async function handleUndo() {
  if (window.appState.undoStack.length === 0) return;
  const op = window.appState.undoStack.pop();
  const pdfPath = op.pdfPath || window.appState.currentTarget;
  let res = null;
  if (op.action === 'add') {
    res = await window.apiRequest('/api/comments/delete', 'POST', { id: op.comment.id, pdfPath });
    window.appState.redoStack.push(op);
  } else if (op.action === 'delete') {
    res = await window.apiRequest('/api/comments/add', 'POST', { ...op.comment, pdfPath });
    window.appState.redoStack.push(op);
  }
  if (res?.mtime) window.appState.lastMtime = res.mtime;
  updateHistoryButtons();
  await window.refreshComments();
}

async function handleRedo() {
  if (window.appState.redoStack.length === 0) return;
  const op = window.appState.redoStack.pop();
  const pdfPath = op.pdfPath || window.appState.currentTarget;
  let res = null;
  if (op.action === 'add') {
    res = await window.apiRequest('/api/comments/add', 'POST', { ...op.comment, pdfPath });
    window.appState.undoStack.push(op);
  } else if (op.action === 'delete') {
    res = await window.apiRequest('/api/comments/delete', 'POST', { id: op.comment.id, pdfPath });
    window.appState.undoStack.push(op);
  }
  if (res?.mtime) window.appState.lastMtime = res.mtime;
  updateHistoryButtons();
  await window.refreshComments();
}

window.attachAreaSelectionHandlers = function (overlay, canvas, pageNum) {
  let isDrawing = false, startX = 0, startY = 0, marquee = null;

  overlay.addEventListener('mousedown', (e) => {
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
    const rect = overlay.getBoundingClientRect();
    const curX = e.clientX - rect.left, curY = e.clientY - rect.top;
    marquee.style.left = `${Math.min(startX, curX)}px`;
    marquee.style.top = `${Math.min(startY, curY)}px`;
    marquee.style.width = `${Math.abs(curX - startX)}px`;
    marquee.style.height = `${Math.abs(curY - startY)}px`;
  });

  overlay.addEventListener('mouseup', (e) => {
    if (!isDrawing || !marquee) return;
    isDrawing = false;
    const curX = e.clientX - overlay.getBoundingClientRect().left;
    const curY = e.clientY - overlay.getBoundingClientRect().top;
    const width = Math.abs(curX - startX), height = Math.abs(curY - startY);
    const left = Math.min(startX, curX), top = Math.min(startY, curY);

    if (width > 15 && height > 15) {
      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = width;
      cropCanvas.height = height;
      cropCanvas.getContext('2d').drawImage(canvas, left, top, width, height, 0, 0, width, height);

      openCommentPopup({
        type: 'area',
        page: pageNum,
        imageB64: cropCanvas.toDataURL('image/png'),
        rect: {
          xRatio: left / overlay.clientWidth,
          yRatio: top / overlay.clientHeight,
          wRatio: width / overlay.clientWidth,
          hRatio: height / overlay.clientHeight,
        },
        x: e.clientX,
        y: e.clientY,
      });
    }
    marquee.remove();
    marquee = null;
  });
};

document.addEventListener('mouseup', (e) => {
  if (window.appState.currentMode !== 'text') return;
  const selection = window.getSelection();
  const text = selection.toString().trim();
  if (text && text.length > 2 && selection.rangeCount > 0) {
    const pageWrapper = e.target.closest('.page-wrapper');
    if (!pageWrapper) return;
    const pageNum = parseInt(pageWrapper.dataset.pageNum, 10) || 1;
    const pageRect = pageWrapper.getBoundingClientRect();
    const range = selection.getRangeAt(0);

    const textRects = Array.from(range.getClientRects()).map((r) => ({
      xRatio: (r.left - pageRect.left) / pageRect.width,
      yRatio: (r.top - pageRect.top) / pageRect.height,
      wRatio: r.width / pageRect.width,
      hRatio: r.height / pageRect.height,
    }));

    openCommentPopup({ type: 'text', page: pageNum, selectedText: text, textRects, x: e.clientX, y: e.clientY });
  }
});

function openCommentPopup(data) {
  window.appState.pendingComment = data;
  popupTitle.textContent = data.type === 'area' ? 'Annotate Diagram/Image' : 'Annotate Text';
  popupPageBadge.textContent = `Page ${data.page}`;
  popupInput.value = '';
  popupPreview.innerHTML = data.type === 'area' && data.imageB64
    ? `<img src="${data.imageB64}" alt="Snippet">`
    : data.selectedText ? `"${data.selectedText}"` : '';
  commentPopup.style.display = 'flex';
  commentPopup.style.left = `${Math.max(Math.min(data.x, window.innerWidth - 300), 10)}px`;
  commentPopup.style.top = `${Math.max(Math.min(data.y + 10, window.innerHeight - 250), 10)}px`;
  popupInput.focus();
}

function closeCommentPopup() {
  commentPopup.style.display = 'none';
  window.appState.pendingComment = null;
  window.getSelection()?.removeAllRanges();
}

popupSubmitBtn.addEventListener('click', async () => {
  if (!window.appState.pendingComment) return;
  const text = popupInput.value.trim();
  if (!text) return;
  popupSubmitBtn.disabled = true;
  await addCommentWithHistory({ ...window.appState.pendingComment, comment: text });
  popupSubmitBtn.disabled = false;
  closeCommentPopup();
  commentsDrawer.classList.add('open');
});

popupCloseBtn.addEventListener('click', closeCommentPopup);
undoBtn.addEventListener('click', handleUndo);
redoBtn.addEventListener('click', handleRedo);

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) handleRedo(); else handleUndo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    handleRedo();
  }
});

window.refreshComments = async function () {
  const pdfPath = window.appState.currentTarget;
  if (!pdfPath) return;
  const data = await window.apiRequest(`/api/comments/list?pdfPath=${encodeURIComponent(pdfPath)}`);
  const comments = data?.comments || [];
  window.appState.loadedComments = comments;
  commentsCount.textContent = comments.length;

  if (comments.length === 0) {
    commentsList.innerHTML = '<div class="empty-drawer">No comments in this PDF.</div>';
    return window.renderCommentMarkersOnPages();
  }

  commentsList.innerHTML = '';
  comments.forEach((c, idx) => {
    const card = document.createElement('div');
    card.className = 'comment-card';
    card.id = `card-${c.id}`;

    card.innerHTML = `
      <div class="comment-card-header">
        <strong>#${idx + 1} (${(c.type || 'text').toUpperCase()}) - Page ${c.page}</strong>
        <button class="delete-btn" title="Remove annotation from PDF">🗑️</button>
      </div>
      ${c.selectedText ? `<div class="popup-preview">"${c.selectedText}"</div>` : ''}
      ${c.imageB64 ? `<div class="comment-card-snippet"><img src="${c.imageB64}" alt="Snippet"></div>` : ''}
      <div class="comment-card-body">${c.comment}</div>
    `;

    card.querySelector('.delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteCommentWithHistory(c.id);
    });

    card.addEventListener('click', () => {
      const pageEl = document.querySelector(`.page-wrapper[data-page-num="${c.page}"]`);
      if (pageEl) pageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      document.querySelectorAll(`.mark-${c.id}`).forEach((el) => {
        el.classList.add('highlight');
        setTimeout(() => el.classList.remove('highlight'), 1500);
      });
    });
    commentsList.appendChild(card);
  });

  window.renderCommentMarkersOnPages();
};

window.renderCommentMarkersOnPages = function () {
  document.querySelectorAll('.pdf-comment-box, .pdf-comment-pin, .pdf-text-highlight').forEach((el) => el.remove());

  window.appState.loadedComments.forEach((c, idx) => {
    const pageWrapper = document.querySelector(`.page-wrapper[data-page-num="${c.page}"]`);
    if (!pageWrapper) return;
    const overlay = pageWrapper.querySelector('.selection-overlay');
    if (!overlay) return;

    const createPin = () => {
      const pin = document.createElement('div');
      pin.className = 'pdf-comment-pin';
      pin.innerHTML = `<span>💬 #${idx + 1}</span><span class="pin-delete" title="Delete from PDF">🗑️</span>`;
      pin.querySelector('.pin-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteCommentWithHistory(c.id);
      });
      return pin;
    };

    if (c.type === 'area' && c.rect) {
      const box = document.createElement('div');
      box.className = `pdf-comment-box mark-${c.id}`;
      box.style.left = `${c.rect.xRatio * overlay.clientWidth}px`;
      box.style.top = `${c.rect.yRatio * overlay.clientHeight}px`;
      box.style.width = `${c.rect.wRatio * overlay.clientWidth}px`;
      box.style.height = `${c.rect.hRatio * overlay.clientHeight}px`;

      const pin = createPin();
      pin.style.left = '0';
      pin.style.top = '0';
      box.appendChild(pin);
      box.addEventListener('click', () => {
        commentsDrawer.classList.add('open');
        document.getElementById(`card-${c.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      overlay.appendChild(box);
    } else if (c.textRects?.length) {
      c.textRects.forEach((r, rIdx) => {
        const mark = document.createElement('div');
        mark.className = `pdf-text-highlight mark-${c.id}`;
        mark.style.left = `${r.xRatio * overlay.clientWidth}px`;
        mark.style.top = `${r.yRatio * overlay.clientHeight}px`;
        mark.style.width = `${r.wRatio * overlay.clientWidth}px`;
        mark.style.height = `${r.hRatio * overlay.clientHeight}px`;

        if (rIdx === c.textRects.length - 1) {
          const pin = createPin();
          pin.style.left = '100%';
          pin.style.top = '0';
          mark.appendChild(pin);
        }
        mark.addEventListener('click', () => {
          commentsDrawer.classList.add('open');
          document.getElementById(`card-${c.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        overlay.appendChild(mark);
      });
    }
  });
};
