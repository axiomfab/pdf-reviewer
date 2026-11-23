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
let availablePdfs = [];
let pickerOpen = false;

const pdfPicker = document.getElementById('pdf-picker');
const pdfPickerTrigger = document.getElementById('pdf-picker-trigger');
const pdfPickerFilename = document.getElementById('pdf-picker-filename');
const pdfPickerWtBadge = document.getElementById('pdf-picker-wt-badge');
const pdfPickerWtText = document.getElementById('pdf-picker-wt-text');
const pdfPickerMenu = document.getElementById('pdf-picker-menu');
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

const BRANCH_ICON_SVG = '<svg class="wt-branch-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';

function splitDisplayPath(pdf) {
  const raw = String(pdf?.displayPath || pdf?.relPath || pdf?.name || '').replace(/\\/g, '/');
  const slashIdx = raw.lastIndexOf('/');
  if (slashIdx === -1) return { dir: '', name: raw };
  return { dir: raw.slice(0, slashIdx + 1), name: raw.slice(slashIdx + 1) };
}

function formatShortWorktreeLabel(worktree) {
  if (!worktree || typeof worktree !== 'string') return '';
  return worktree.replace(/^(feat|feature|fix|chore|docs|refactor)\//i, '');
}

function setPickerOpen(open) {
  pickerOpen = Boolean(open);
  if (pdfPickerMenu) pdfPickerMenu.classList.toggle('hidden', !pickerOpen);
  if (pdfPickerTrigger) pdfPickerTrigger.setAttribute('aria-expanded', pickerOpen ? 'true' : 'false');
}

function updatePickerTrigger(pdf) {
  if (!pdfPickerFilename || !pdfPickerWtBadge || !pdfPickerWtText) return;
  if (!pdf) {
    pdfPickerFilename.textContent = 'No PDFs found';
    pdfPickerWtBadge.classList.add('hidden');
    pdfPickerWtBadge.title = '';
    if (pdfPickerTrigger) pdfPickerTrigger.title = 'No PDFs detected in workspace';
    return;
  }
  const { dir, name } = splitDisplayPath(pdf);
  pdfPickerFilename.textContent = name;
  if (pdf.worktree) {
    pdfPickerWtBadge.classList.remove('hidden');
    pdfPickerWtText.textContent = formatShortWorktreeLabel(pdf.worktree);
    pdfPickerWtBadge.title = `Git worktree: ${pdf.worktree}`;
    if (pdfPickerTrigger) pdfPickerTrigger.title = `${dir}${name} · worktree: ${pdf.worktree}`;
  } else {
    pdfPickerWtBadge.classList.add('hidden');
    pdfPickerWtText.textContent = '';
    pdfPickerWtBadge.title = '';
    if (pdfPickerTrigger) pdfPickerTrigger.title = `${dir}${name}`;
  }
}

function renderPickerMenu() {
  if (!pdfPickerMenu) return;
  if (!availablePdfs.length) {
    pdfPickerMenu.innerHTML = '<div class="pdf-picker-empty">No PDFs found in workspace</div>';
    return;
  }
  const esc = window.escapeHtml || ((s) => String(s || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));
  pdfPickerMenu.innerHTML = '';
  availablePdfs.forEach((pdf) => {
    const isSelected = pdf.path === window.appState.currentTarget;
    const { dir, name } = splitDisplayPath(pdf);
    const sizeKb = `${Math.max(1, Math.round((pdf.size || 0) / 1024))} KB`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `pdf-picker-option${isSelected ? ' selected' : ''}`;
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    btn.title = pdf.worktree ? `${dir}${name} (${pdf.worktree})` : `${dir}${name}`;
    const badgeHtml = pdf.worktree
      ? `<span class="wt-badge" title="Git worktree: ${esc(pdf.worktree)}">${BRANCH_ICON_SVG}<span class="wt-badge-text">${esc(pdf.worktree)}</span></span>`
      : '';
    btn.innerHTML = `
      <span class="pdf-option-left">
        <span class="pdf-option-dot"></span>
        <span class="pdf-option-path">${dir ? `<span class="pdf-option-dir">${esc(dir)}</span>` : ''}<span class="pdf-option-name">${esc(name)}</span></span>
        ${badgeHtml}
      </span>
      <span class="pdf-option-size">${esc(sizeKb)}</span>
    `;
    btn.addEventListener('click', async () => {
      setPickerOpen(false);
      if (pdf.path === window.appState.currentTarget) return;
      window.appState.currentTarget = pdf.path;
      window.appState.lastMtime = null;
      currentPdfDoc = null;
      updatePickerTrigger(pdf);
      renderPickerMenu();
      await loadAndRenderPdf(window.appState.currentTarget);
    });
    pdfPickerMenu.appendChild(btn);
  });
}

async function loadPdfList() {
  if (isLoadingList) {
    pendingListReload = true;
    return;
  }
  isLoadingList = true;
  const myGen = ++listLoadGeneration;
  try {
    if (availablePdfs.length === 0 && pdfPickerFilename) {
      pdfPickerFilename.textContent = 'Scanning...';
    }
    const wsUriBefore = await window.getWorkspaceUri();
    const data = await window.apiRequest('/api/list');
    if (myGen !== listLoadGeneration || (workspaceInitialized && wsUriBefore !== cachedWorkspaceUri)) {
      pendingListReload = true;
      return;
    }
    if (!data?.pdfs?.length) {
      availablePdfs = [];
      window.appState.currentTarget = null;
      window.appState.lastMtime = null;
      currentPdfDoc = null;
      updatePickerTrigger(null);
      renderPickerMenu();
      showEmpty();
      await window.refreshComments();
      return;
    }

    availablePdfs = data.pdfs;

    const currentMatch = availablePdfs.find((p) => p.path === window.appState.currentTarget);
    if (!currentMatch) {
      window.appState.currentTarget = availablePdfs[0].path;
      updatePickerTrigger(availablePdfs[0]);
      renderPickerMenu();
      await loadAndRenderPdf(window.appState.currentTarget);
    } else {
      updatePickerTrigger(currentMatch);
      renderPickerMenu();
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

if (pdfPickerTrigger) {
  pdfPickerTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    setPickerOpen(!pickerOpen);
  });
}

document.addEventListener('click', (e) => {
  if (pickerOpen && pdfPicker && !pdfPicker.contains(e.target)) {
    setPickerOpen(false);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pickerOpen) {
    setPickerOpen(false);
  }
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
