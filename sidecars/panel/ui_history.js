window.historyManager = (function () {
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');

  function updateButtons() {
    if (undoBtn) undoBtn.disabled = window.appState.undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = window.appState.redoStack.length === 0;
  }

  async function deleteWithHistory(id, recordHistory = true) {
    const pdfPath = window.appState.currentTarget;
    if (!pdfPath) return;
    const res = await window.apiRequest('/api/comments/delete', 'POST', { id, pdfPath });
    if (res?.mtime) window.appState.lastMtime = res.mtime;
    if (res?.success && recordHistory && res.comment) {
      window.appState.undoStack.push({ action: 'delete', pdfPath, comment: res.comment });
      window.appState.redoStack.length = 0;
      updateButtons();
    }
    await window.refreshComments();
  }

  async function addWithHistory(commentData, recordHistory = true) {
    const pdfPath = window.appState.currentTarget;
    if (!pdfPath) return null;
    const res = await window.apiRequest('/api/comments/add', 'POST', { ...commentData, pdfPath });
    if (res?.mtime) window.appState.lastMtime = res.mtime;
    if (res?.success && recordHistory && res.comment) {
      window.appState.undoStack.push({ action: 'add', pdfPath, comment: res.comment });
      window.appState.redoStack.length = 0;
      updateButtons();
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
    updateButtons();
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
    updateButtons();
    await window.refreshComments();
  }

  if (undoBtn) undoBtn.addEventListener('click', handleUndo);
  if (redoBtn) redoBtn.addEventListener('click', handleRedo);

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

  return {
    deleteWithHistory,
    addWithHistory,
    handleUndo,
    handleRedo,
    updateButtons,
  };
})();
