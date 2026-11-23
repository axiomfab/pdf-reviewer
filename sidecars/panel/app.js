if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/lib/pdf.worker.min.js';
}

class RenderCoordinator {
  constructor() {
    this.currentGeneration = 0;
    this.activeTasks = [];
  }
  startNew() {
    const gen = ++this.currentGeneration;
    for (const task of this.activeTasks) {
      try {
        if (task && typeof task.cancel === 'function') task.cancel();
      } catch {}
    }
    this.activeTasks = [];
    return gen;
  }
  isActive(gen) {
    return gen === this.currentGeneration;
  }
  addTask(task) {
    if (task) this.activeTasks.push(task);
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.RenderCoordinator = RenderCoordinator;
}

const renderCoordinator = new RenderCoordinator();
let currentPdfDoc = null;
let currentScale = 1.0;
let isFitWidth = true;
let isLoadingList = false;
let pendingListReload = false;
let listLoadGeneration = 0;
let loadPdfGeneration = 0;
let cachedWorkspaceUri = null;
let workspaceInitialized = false;
let resizeDebounceTimer = null;

const pdfSelect = document.getElementById('pdf-select');
const refreshBtn = document.getElementById('refresh-btn');
const zoomInBtn = document.getElementById('zoom-in-btn');
const zoomOutBtn = document.getElementById('zoom-out-btn');
const zoomLevelText = document.getElementById('zoom-level');
const pagesContainer = document.getElementById('pages-container');
const emptyState = document.getElementById('empty-state');
const viewerContainer = document.getElementById('viewer-container');
const modeTextBtn = document.getElementById('mode-text-btn');
const modeHighlightBtn = document.getElementById('mode-highlight-btn');
const modeUnderlineBtn = document.getElementById('mode-underline-btn');
const modeStrikeBtn = document.getElementById('mode-strike-btn');
const modeNoteBtn = document.getElementById('mode-note-btn');
const modeAreaBtn = document.getElementById('mode-area-btn');
const commentsToggleBtn = document.getElementById('comments-toggle-btn');

window.getWorkspaceUri = async function () {
  if (workspaceInitialized) return cachedWorkspaceUri;
  if (window.sidecar && typeof window.sidecar.getWorkspaceUris === 'function') {
    try {
      const uris = await window.sidecar.getWorkspaceUris();
      workspaceInitialized = true;
      cachedWorkspaceUri = uris && uris.length > 0 ? uris[0] : null;
      return cachedWorkspaceUri;
    } catch {}
  }
  return cachedWorkspaceUri;
};

if (window.sidecar && typeof window.sidecar.onWorkspaceChange === 'function') {
  window.sidecar.onWorkspaceChange((uris) => {
    const nextUri = uris && uris.length > 0 ? uris[0] : null;
    const changed = !workspaceInitialized || nextUri !== cachedWorkspaceUri;
    workspaceInitialized = true;
    if (changed) {
      cachedWorkspaceUri = nextUri;
      window.appState.currentTarget = null;
      window.appState.lastMtime = null;
      currentPdfDoc = null;
      renderCoordinator.startNew();
      loadPdfList();
    }
  });
}

window.apiRequest = async function (endpoint, method = 'GET', body = null) {
  try {
    const wsUri = await window.getWorkspaceUri();
    const params = new URLSearchParams();
    const pageToken = new URLSearchParams(window.location.search).get('token');
    if (pageToken) params.set('token', pageToken);
    if (wsUri) params.set('workspaceUri', wsUri);

    const delim = endpoint.includes('?') ? '&' : '?';
    const query = params.toString() ? `${delim}${params.toString()}` : '';
    const fullUrl = `${endpoint}${query}`;

    const options = { method, headers: {} };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify({ ...body, workspaceUri: wsUri });
    }
    const fetchFn = window.sidecar && typeof window.sidecar.fetch === 'function'
      ? window.sidecar.fetch.bind(window.sidecar)
      : window.fetch;
    const res = await fetchFn(fullUrl, options);
    if (!res.ok) {
      console.warn(`API ${endpoint} status: ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`API ${endpoint} error:`, err);
    return null;
  }
};

async function loadPdfList() {
  if (isLoadingList) {
    pendingListReload = true;
    return;
  }
  isLoadingList = true;
  const myGen = ++listLoadGeneration;
  try {
    if (pdfSelect.children.length === 0) {
      pdfSelect.innerHTML = '<option value="">Scanning...</option>';
    }
    const wsUriBefore = await window.getWorkspaceUri();
    const data = await window.apiRequest('/api/list');
    if (myGen !== listLoadGeneration || (workspaceInitialized && wsUriBefore !== cachedWorkspaceUri)) {
      pendingListReload = true;
      return;
    }
    if (!data?.pdfs?.length) {
      window.appState.currentTarget = null;
      window.appState.lastMtime = null;
      currentPdfDoc = null;
      pdfSelect.innerHTML = '<option value="">No PDFs found</option>';
      showEmpty();
      await window.refreshComments();
      return;
    }

    const existingPaths = Array.from(pdfSelect.options).map((o) => o.value).filter(Boolean);
    const newPaths = data.pdfs.map((p) => p.path);

    const isSameList = existingPaths.length === newPaths.length &&
      existingPaths.every((val, idx) => val === newPaths[idx]);

    if (!isSameList) {
      pdfSelect.innerHTML = '';
      data.pdfs.forEach((pdf) => {
        const opt = document.createElement('option');
        opt.value = pdf.path;
        opt.textContent = `${pdf.relPath || pdf.name} (${(pdf.size / 1024).toFixed(0)} KB)`;
        pdfSelect.appendChild(opt);
      });
    }

    if (!window.appState.currentTarget || !data.pdfs.some((p) => p.path === window.appState.currentTarget)) {
      window.appState.currentTarget = data.pdfs[0].path;
      pdfSelect.value = window.appState.currentTarget;
      await loadAndRenderPdf(window.appState.currentTarget);
    } else {
      pdfSelect.value = window.appState.currentTarget;
      await window.refreshComments();
    }
  } catch (err) {
    console.error('loadPdfList error:', err);
  } finally {
    isLoadingList = false;
    if (pendingListReload) {
      pendingListReload = false;
      loadPdfList();
    }
  }
}

async function loadAndRenderPdf(pdfPath) {
  if (!pdfPath) return;
  const thisLoadGen = ++loadPdfGeneration;
  renderCoordinator.startNew();
  try {
    const status = await window.apiRequest(`/api/status?pdfPath=${encodeURIComponent(pdfPath)}`);
    if (thisLoadGen !== loadPdfGeneration) return;
    if (!status?.target) return showEmpty();
    window.appState.lastMtime = status.target.mtime;

    const wsUri = await window.getWorkspaceUri();
    if (thisLoadGen !== loadPdfGeneration) return;
    const wsParam = wsUri ? `&workspaceUri=${encodeURIComponent(wsUri)}` : '';
    const pageToken = new URLSearchParams(window.location.search).get('token');
    const tokenParam = pageToken ? `&token=${encodeURIComponent(pageToken)}` : '';
    const pdfUrl = `/api/pdf?pdfPath=${encodeURIComponent(pdfPath)}${wsParam}${tokenParam}&t=${Date.now()}`;
    const fetchFn = window.sidecar && typeof window.sidecar.fetch === 'function'
      ? window.sidecar.fetch.bind(window.sidecar)
      : window.fetch;
    const res = await fetchFn(pdfUrl);
    if (thisLoadGen !== loadPdfGeneration) return;
    if (!res.ok) return showEmpty();

    const arrayBuffer = await res.arrayBuffer();
    if (thisLoadGen !== loadPdfGeneration) return;
    currentPdfDoc = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    if (thisLoadGen !== loadPdfGeneration) return;
    emptyState.style.display = 'none';
    pagesContainer.style.display = 'flex';
    await renderAllPages();
    if (thisLoadGen !== loadPdfGeneration) return;
    await window.refreshComments();
  } catch (err) {
    console.error('Render PDF error:', err);
  }
}

async function renderAllPages() {
  if (!currentPdfDoc) return;
  const thisGen = renderCoordinator.startNew();

  const rawWidth = viewerContainer.clientWidth;
  const containerWidth = rawWidth > 100
    ? rawWidth - 50
    : (window.innerWidth ? Math.max(window.innerWidth - 60, 250) : 400);

  pagesContainer.innerHTML = '';
  const numPages = currentPdfDoc.numPages;

  // Pre-allocate slots to strictly guarantee exactly one DOM container per page in order
  const pageWrappers = [];
  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    wrapper.dataset.pageNum = pageNum;
    pagesContainer.appendChild(wrapper);
    pageWrappers.push(wrapper);
  }

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    if (!renderCoordinator.isActive(thisGen)) return;

    const page = await currentPdfDoc.getPage(pageNum);
    if (!renderCoordinator.isActive(thisGen)) return;

    const unscaled = page.getViewport({ scale: 1.0 });
    const scale = isFitWidth ? Math.min(Math.max(containerWidth / unscaled.width, 0.4), 2.5) : currentScale;
    const viewport = page.getViewport({ scale });

    const wrapper = pageWrappers[pageNum - 1];
    if (!wrapper) return;
    wrapper.style.width = `${viewport.width}px`;
    wrapper.style.height = `${viewport.height}px`;

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page-canvas';
    canvas.height = viewport.height;
    canvas.width = viewport.width;

    const annotationMode = window.pdfjsLib?.AnnotationMode?.DISABLE ?? 0;
    const renderTask = page.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
      annotationMode,
    });
    renderCoordinator.addTask(renderTask);

    try {
      await renderTask.promise;
    } catch (err) {
      if (err?.name === 'RenderingCancelledException') return;
      throw err;
    }
    if (!renderCoordinator.isActive(thisGen)) return;

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    textLayerDiv.style.width = `${viewport.width}px`;
    textLayerDiv.style.height = `${viewport.height}px`;
    textLayerDiv.style.setProperty('--scale-factor', `${viewport.scale}`);

    const textContentSource = await page.getTextContent();
    if (!renderCoordinator.isActive(thisGen)) return;

    await window.pdfjsLib.renderTextLayer({
      textContentSource,
      container: textLayerDiv,
      viewport,
      textDivs: [],
    }).promise;
    if (!renderCoordinator.isActive(thisGen)) return;

    const overlay = document.createElement('div');
    overlay.className = 'selection-overlay';
    window.attachAreaSelectionHandlers(overlay, canvas, pageNum);

    wrapper.innerHTML = '';
    wrapper.appendChild(canvas);
    wrapper.appendChild(textLayerDiv);
    wrapper.appendChild(overlay);
  }

  if (!renderCoordinator.isActive(thisGen)) return;
  zoomLevelText.textContent = isFitWidth ? 'Fit' : `${Math.round(currentScale * 100)}%`;
  window.renderCommentMarkersOnPages();
}

function showEmpty() {
  emptyState.style.display = 'flex';
  pagesContainer.style.display = 'none';
  pagesContainer.innerHTML = '';
}

/**
 * Switches the active PDF annotation or markup interaction mode.
 * @param {string} mode
 * @returns {void}
 */
function setMode(mode) {
  const normalizedMode = mode === 'strike' ? 'strikethrough' : mode;
  window.appState.currentMode = normalizedMode;
  const activeBtnId = normalizedMode === 'strikethrough' ? 'mode-strike-btn' : `mode-${normalizedMode}-btn`;
  [modeTextBtn, modeHighlightBtn, modeUnderlineBtn, modeStrikeBtn, modeNoteBtn, modeAreaBtn].forEach((btn) => {
    if (btn) btn.classList.toggle('active', btn.id === activeBtnId);
  });
  viewerContainer.classList.toggle('snip-mode', normalizedMode === 'area');
  viewerContainer.classList.toggle('note-mode', normalizedMode === 'note');
}
window.setMode = setMode;

if (modeTextBtn) modeTextBtn.addEventListener('click', () => setMode('text'));
if (modeHighlightBtn) modeHighlightBtn.addEventListener('click', () => setMode('highlight'));
if (modeUnderlineBtn) modeUnderlineBtn.addEventListener('click', () => setMode('underline'));
if (modeStrikeBtn) modeStrikeBtn.addEventListener('click', () => setMode('strikethrough'));
if (modeNoteBtn) modeNoteBtn.addEventListener('click', () => setMode('note'));
if (modeAreaBtn) modeAreaBtn.addEventListener('click', () => setMode('area'));

pdfSelect.addEventListener('change', async (e) => {
  window.appState.currentTarget = e.target.value;
  window.appState.lastMtime = null;
  currentPdfDoc = null;
  await loadAndRenderPdf(window.appState.currentTarget);
});

if (commentsToggleBtn) {
  commentsToggleBtn.addEventListener('click', () => {
    if (typeof window.toggleShowAllComments === 'function') window.toggleShowAllComments();
  });
}

refreshBtn.addEventListener('click', () => {
  window.location.reload();
});

async function checkLiveUpdate() {
  if (!window.appState.currentTarget) return loadPdfList();
  const status = await window.apiRequest(`/api/status?pdfPath=${encodeURIComponent(window.appState.currentTarget)}`);
  if (status?.target) {
    if (window.appState.lastMtime && status.target.mtime > window.appState.lastMtime) {
      window.appState.lastMtime = status.target.mtime;
      await loadAndRenderPdf(window.appState.currentTarget);
    }
  } else {
    await loadPdfList();
  }
}

zoomInBtn.addEventListener('click', async () => {
  isFitWidth = false;
  currentScale = Math.min(currentScale + 0.15, 3.0);
  await renderAllPages();
});

zoomOutBtn.addEventListener('click', async () => {
  isFitWidth = false;
  currentScale = Math.max(currentScale - 0.15, 0.4);
  await renderAllPages();
});

window.addEventListener('resize', () => {
  if (!isFitWidth || !currentPdfDoc) return;
  clearTimeout(resizeDebounceTimer);
  resizeDebounceTimer = setTimeout(renderAllPages, 100);
});

loadPdfList();
setInterval(checkLiveUpdate, 1500);
