window.historyManager = (function () {
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');

  /**
   * Updates Undo/Redo toolbar button disabled states.
   * @returns {void}
   */
  function updateButtons() {
    if (undoBtn) undoBtn.disabled = window.appState.undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = window.appState.redoStack.length === 0;
  }

  /**
   * Builds a modification payload from a comment snapshot.
   * @param {string} id
   * @param {Record<string, unknown>} snapshot
   * @param {string} pdfPath
   * @returns {Record<string, unknown>}
   */
  function buildSnapshotUpdatePayload(id, snapshot, pdfPath) {
    return {
      id,
      pdfPath,
      comment: snapshot.comment === '' ? null : snapshot.comment,
      type: snapshot.type,
      replacement: snapshot.replacement ?? null,
      status: snapshot.status || 'open',
    };
  }

  /**
   * Deletes an annotation or markup and optionally pushes it onto the undo stack.
   * @param {string} id
   * @param {boolean} [recordHistory=true]
   * @param {string | null} [customPdfPath=null]
   * @returns {Promise<void>}
   */
  async function deleteWithHistory(id, recordHistory = true, customPdfPath = null) {
    if (!id || typeof id !== 'string') {
      throw new Error('CRITICAL: id must be a non-empty string');
    }
    const pdfPath = customPdfPath || window.appState.currentTarget;
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

  /**
   * Adds an annotation or markup and optionally pushes it onto the undo stack.
   * @param {Record<string, unknown>} commentData
   * @param {boolean} [recordHistory=true]
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function addWithHistory(commentData, recordHistory = true) {
    if (!commentData || typeof commentData !== 'object') {
      throw new Error('CRITICAL: commentData object is required');
    }
    const pdfPath = commentData.pdfPath || window.appState.currentTarget;
    if (!pdfPath) return null;
    const res = await window.apiRequest('/api/comments/add', 'POST', { ...commentData, pdfPath });
    if (res?.mtime) window.appState.lastMtime = res.mtime;
    if (res?.success && recordHistory && res.comment) {
      window.appState.undoStack.push({ action: 'add', pdfPath, comment: res.comment });
      window.appState.redoStack.length = 0;
      updateButtons();
    }
    await window.refreshComments();
    return res?.comment || null;
  }

  /**
   * Modifies an annotation or markup and optionally records before/after snapshots for undo/redo.
   * @param {string} id
   * @param {Record<string, unknown>} updates
   * @param {Record<string, unknown> | null} [previousSnapshot=null]
   * @param {boolean} [recordHistory=true]
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function modifyWithHistory(id, updates, previousSnapshot = null, recordHistory = true) {
    if (!id || typeof id !== 'string') {
      throw new Error('CRITICAL: id must be a non-empty string');
    }
    if (!updates || typeof updates !== 'object') {
      throw new Error('CRITICAL: updates object is required');
    }
    const pdfPath = updates.pdfPath || window.appState.currentTarget;
    if (!pdfPath) return null;
    const existing = previousSnapshot || window.appState.loadedComments?.find((c) => c.id === id) || null;
    const before = existing ? { ...existing } : null;
    const res = await window.apiRequest('/api/comments/modify', 'POST', { id, ...updates, pdfPath });
    if (res?.mtime) window.appState.lastMtime = res.mtime;
    if (res?.success && recordHistory && res.comment && before) {
      window.appState.undoStack.push({
        action: 'modify',
        pdfPath,
        id,
        before,
        after: { ...res.comment },
      });
      window.appState.redoStack.length = 0;
      updateButtons();
    }
    await window.refreshComments();
    return res?.comment || null;
  }

  /**
   * Reverts the most recent annotation or markup mutation.
   * @returns {Promise<void>}
   */
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
    } else if (op.action === 'modify') {
      res = await window.apiRequest('/api/comments/modify', 'POST', buildSnapshotUpdatePayload(op.id, op.before, pdfPath));
      window.appState.redoStack.push(op);
    }
    if (res?.mtime) window.appState.lastMtime = res.mtime;
    updateButtons();
    await window.refreshComments();
  }

  /**
   * Reapplies the most recently undone annotation or markup mutation.
   * @returns {Promise<void>}
   */
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
    } else if (op.action === 'modify') {
      res = await window.apiRequest('/api/comments/modify', 'POST', buildSnapshotUpdatePayload(op.id, op.after, pdfPath));
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

  const api = {
    deleteWithHistory,
    addWithHistory,
    modifyWithHistory,
    handleUndo,
    handleRedo,
    updateButtons,
  };

  window.commentHistory = {
    executeAdd: (payload, recordHistory = true) => addWithHistory(payload, recordHistory),
    executeDelete: (id, pdfPath = null, recordHistory = true) => deleteWithHistory(id, recordHistory, pdfPath),
    executeModify: (id, updates, previousSnapshot = null, recordHistory = true) =>
      modifyWithHistory(id, updates, previousSnapshot, recordHistory),
  };

  return api;
})();
