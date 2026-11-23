import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

console.log('=== Running Accessibility (a11y) Unit Tests ===');

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(__dirname, '../sidecars/panel/index.html'), 'utf-8');
const stylesCss = readFileSync(join(__dirname, '../sidecars/panel/styles.css'), 'utf-8');
const uiCommentsJs = readFileSync(join(__dirname, '../sidecars/panel/ui_comments.js'), 'utf-8');
const appJs = readFileSync(join(__dirname, '../sidecars/panel/app.js'), 'utf-8');

// 1. Static HTML & CSS ARIA Contract Checks
assert(
  indexHtml.includes('id="pdf-picker-trigger"') &&
    indexHtml.includes('aria-haspopup="listbox"') &&
    indexHtml.includes('aria-expanded="false"') &&
    indexHtml.includes('aria-controls="pdf-picker-menu"'),
  'Expected #pdf-picker-trigger to declare aria-haspopup, aria-expanded, and aria-controls="pdf-picker-menu"'
);
assert(
  indexHtml.includes('<span class="sr-only">git worktree </span><span id="pdf-picker-wt-text"'),
  'Expected #pdf-picker-wt-badge to include .sr-only git worktree context'
);
assert(
  stylesCss.includes('.sr-only') && stylesCss.includes('.pdf-picker-option:focus-visible'),
  'Expected styles.css to define .sr-only and .pdf-picker-option focus-visible styling'
);

const modeButtonChecks = [
  ['mode-text-btn', 'true'],
  ['mode-highlight-btn', 'false'],
  ['mode-underline-btn', 'false'],
  ['mode-strike-btn', 'false'],
  ['mode-note-btn', 'false'],
  ['mode-area-btn', 'false'],
];
for (const [id, expectedPressed] of modeButtonChecks) {
  const re = new RegExp(`id="${id}"[^>]*aria-pressed="${expectedPressed}"`);
  assert(re.test(indexHtml), `Expected #${id} in index.html to have aria-pressed="${expectedPressed}"`);
}

assert(
  /id="comments-toggle-btn"[^>]*aria-label="Show all 0 comments"[^>]*aria-pressed="false"/.test(indexHtml),
  'Expected #comments-toggle-btn in index.html to have aria-label="Show all 0 comments" and aria-pressed="false"'
);
assert(
  /id="comments-count"[^>]*aria-hidden="true"/.test(indexHtml),
  'Expected #comments-count badge to be aria-hidden="true" so accessible name is not duplicated'
);
console.log('✅ PASS: a11y Static 1: HTML ARIA attributes, .sr-only, and focus styles verified');

// 2. Behavioral DOM Harness for ui_comments.js + app.js
function createClassList(el) {
  const set = new Set();
  return {
    add(...cls) {
      cls.forEach((c) => set.add(c));
      el._syncClassName(set);
    },
    remove(...cls) {
      cls.forEach((c) => set.delete(c));
      el._syncClassName(set);
    },
    toggle(c, force) {
      const next = force === undefined ? !set.has(c) : Boolean(force);
      if (next) set.add(c);
      else set.delete(c);
      el._syncClassName(set);
      return next;
    },
    contains(c) {
      return set.has(c);
    },
    _replaceFromString(str) {
      set.clear();
      String(str || '')
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => set.add(c));
    },
  };
}

function createMockElement(tagName, id = '', docRef) {
  const attrs = new Map();
  const listeners = new Map();
  const children = [];
  let _className = '';
  let _innerHTML = '';
  const el = {
    tagName: tagName.toUpperCase(),
    id,
    type: '',
    title: '',
    textContent: '',
    value: '',
    disabled: false,
    dataset: {},
    style: {},
    children,
    _syncClassName(set) {
      _className = Array.from(set).join(' ');
    },
    get className() {
      return _className;
    },
    set className(val) {
      _className = String(val || '');
      el.classList._replaceFromString(_className);
    },
    get innerHTML() {
      return _innerHTML;
    },
    set innerHTML(val) {
      _innerHTML = String(val || '');
      if (_innerHTML === '') children.length = 0;
    },
    setAttribute(k, v) {
      attrs.set(k, String(v));
    },
    getAttribute(k) {
      return attrs.has(k) ? attrs.get(k) : null;
    },
    appendChild(child) {
      children.push(child);
      return child;
    },
    contains(target) {
      if (target === el) return true;
      return children.some((c) => c === target || (typeof c.contains === 'function' && c.contains(target)));
    },
    querySelectorAll(selector) {
      if (selector === '.pdf-picker-option') {
        return children.filter((c) => c.classList.contains('pdf-picker-option'));
      }
      return [];
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(type, event = {}) {
      const ev = {
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {
          this.propagationStopped = true;
        },
        target: el,
        ...event,
      };
      for (const fn of listeners.get(type) || []) {
        fn(ev);
      }
      return ev;
    },
    focus() {
      docRef.activeElement = el;
    },
  };
  el.classList = createClassList(el);
  return el;
}

const docListeners = new Map();
const mockDocument = {
  activeElement: null,
  body: null,
  _elementsById: new Map(),
  getElementById(id) {
    return this._elementsById.get(id) || null;
  },
  createElement(tag) {
    return createMockElement(tag, '', mockDocument);
  },
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
  addEventListener(type, fn) {
    if (!docListeners.has(type)) docListeners.set(type, []);
    docListeners.get(type).push(fn);
  },
  dispatchEvent(type, event = {}) {
    const ev = {
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      ...event,
    };
    for (const fn of docListeners.get(type) || []) {
      fn(ev);
    }
    return ev;
  },
};
mockDocument.body = createMockElement('body', '', mockDocument);

const elementIds = [
  'pdf-picker',
  'pdf-picker-trigger',
  'pdf-picker-filename',
  'pdf-picker-wt-badge',
  'pdf-picker-wt-text',
  'pdf-picker-menu',
  'refresh-btn',
  'zoom-in-btn',
  'zoom-out-btn',
  'zoom-level',
  'pages-container',
  'empty-state',
  'viewer-container',
  'mode-text-btn',
  'mode-highlight-btn',
  'mode-underline-btn',
  'mode-strike-btn',
  'mode-note-btn',
  'mode-area-btn',
  'comments-toggle-btn',
  'comments-count',
  'comment-popup',
  'popup-title',
  'popup-close-btn',
  'popup-preview',
  'popup-replacement-group',
  'popup-replacement-input',
  'popup-input',
  'popup-page-badge',
  'popup-submit-btn',
];
for (const id of elementIds) {
  mockDocument._elementsById.set(id, createMockElement('div', id, mockDocument));
}
mockDocument.getElementById('pdf-picker-menu').classList.add('hidden');
mockDocument.getElementById('pdf-picker-wt-badge').classList.add('hidden');
mockDocument.getElementById('pdf-picker').appendChild(mockDocument.getElementById('pdf-picker-trigger'));
mockDocument.getElementById('pdf-picker').appendChild(mockDocument.getElementById('pdf-picker-menu'));

const samplePdfs = [
  {
    path: '/repo/docs/spec.pdf',
    displayPath: 'docs/spec.pdf',
    relPath: 'docs/spec.pdf',
    name: 'spec.pdf',
    worktree: null,
    size: 42 * 1024,
  },
  {
    path: '/repo/.solony/worktrees/issue-17/build/main.pdf',
    displayPath: 'build/main.pdf',
    relPath: '[feat/issue-17-a11y] build/main.pdf',
    name: 'main.pdf',
    worktree: 'feat/issue-17-a11y',
    size: 386 * 1024,
  },
  {
    path: '/repo/.solony/worktrees/fix-typo/paper.pdf',
    displayPath: 'paper.pdf',
    relPath: '[fix/typo] paper.pdf',
    name: 'paper.pdf',
    worktree: 'fix/typo',
    size: 120 * 1024,
  },
];

let mockedComments = Array.from({ length: 8 }, (_, i) => ({
  id: `c_${i + 1}`,
  page: 1,
  type: 'note',
  comment: `Comment ${i + 1}`,
}));

const mockWindow = {
  location: { search: '', reload() {} },
  innerWidth: 800,
  innerHeight: 600,
  addEventListener() {},
  fetch: async (url) => {
    if (String(url).startsWith('/api/list')) {
      return { ok: true, json: async () => ({ pdfs: samplePdfs }) };
    }
    if (String(url).startsWith('/api/comments/list')) {
      return { ok: true, json: async () => ({ comments: mockedComments }) };
    }
    if (String(url).startsWith('/api/status')) {
      return { ok: true, json: async () => ({ target: null }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  },
};

const sandbox = {
  window: mockWindow,
  document: mockDocument,
  URLSearchParams,
  console,
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
};
sandbox.globalThis = sandbox;

vm.runInNewContext(uiCommentsJs, sandbox);
vm.runInNewContext(appJs, sandbox);

// Allow initial loadPdfList() microtasks to settle
await new Promise((resolve) => setTimeout(resolve, 20));

const trigger = mockDocument.getElementById('pdf-picker-trigger');
const menu = mockDocument.getElementById('pdf-picker-menu');
const options = menu.querySelectorAll('.pdf-picker-option');

// 2a. Worktree chip & option accessible labels
assert.equal(options.length, 3, 'Expected 3 rendered picker options');
assert.equal(trigger.getAttribute('aria-label'), 'docs/spec.pdf');
assert.equal(options[0].getAttribute('aria-label'), 'docs/spec.pdf, 42 KB');
assert.equal(options[0].getAttribute('aria-selected'), 'true');
assert.equal(options[1].getAttribute('aria-label'), 'build/main.pdf, git worktree feat/issue-17-a11y, 386 KB');
assert.equal(options[1].getAttribute('aria-selected'), 'false');
assert(
  options[1].innerHTML.includes('<span class="sr-only">git worktree </span>'),
  'Expected worktree option badge to include .sr-only git worktree prefix'
);
assert.equal(options[2].getAttribute('aria-label'), 'paper.pdf, git worktree fix/typo, 120 KB');
console.log('✅ PASS: a11y Behavioral 1: Worktree trigger and option screen-reader labels verified');

// 2b. Listbox keyboard navigation & focus return
trigger.focus();
trigger.dispatchEvent('keydown', { key: 'ArrowDown' });
assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'ArrowDown on trigger should open listbox');
assert.equal(menu.classList.contains('hidden'), false, 'Menu should be visible when open');
assert.equal(mockDocument.activeElement, options[0], 'Opening via ArrowDown should focus currently selected option');

menu.dispatchEvent('keydown', { key: 'ArrowDown' });
assert.equal(mockDocument.activeElement, options[1], 'ArrowDown in menu should move focus to next option');

menu.dispatchEvent('keydown', { key: 'End' });
assert.equal(mockDocument.activeElement, options[2], 'End in menu should move focus to last option');

menu.dispatchEvent('keydown', { key: 'Home' });
assert.equal(mockDocument.activeElement, options[0], 'Home in menu should move focus to first option');

menu.dispatchEvent('keydown', { key: 'ArrowUp' });
assert.equal(mockDocument.activeElement, options[2], 'ArrowUp from first option should wrap focus to last option');

menu.dispatchEvent('keydown', { key: 'Escape' });
assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'Escape should close listbox');
assert.equal(menu.classList.contains('hidden'), true, 'Menu should be hidden after Escape');
assert.equal(mockDocument.activeElement, trigger, 'Escape should return focus to #pdf-picker-trigger');

trigger.dispatchEvent('keydown', { key: 'ArrowUp' });
assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'ArrowUp on closed trigger should open listbox');
assert.equal(mockDocument.activeElement, options[2], 'ArrowUp on closed trigger should focus last option');

// Selecting worktree option via click/Enter closes menu, updates trigger aria-label, and returns focus
await options[1].dispatchEvent('click');
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'Selecting option should close menu');
assert.equal(mockDocument.activeElement, trigger, 'Selecting option should return focus to trigger');
assert.equal(
  trigger.getAttribute('aria-label'),
  'build/main.pdf, git worktree feat/issue-17-a11y',
  'Trigger aria-label should announce full path and git worktree branch'
);
console.log('✅ PASS: a11y Behavioral 2: Listbox ArrowDown/ArrowUp/Home/End/Escape navigation and focus return verified');

// 2c. Annotation mode buttons aria-pressed state transitions
const allModeIds = [
  'mode-text-btn',
  'mode-highlight-btn',
  'mode-underline-btn',
  'mode-strike-btn',
  'mode-note-btn',
  'mode-area-btn',
];
function assertActiveModePressed(expectedActiveId) {
  for (const id of allModeIds) {
    const btn = mockDocument.getElementById(id);
    assert.equal(
      btn.getAttribute('aria-pressed'),
      id === expectedActiveId ? 'true' : 'false',
      `Expected #${id} aria-pressed to be ${id === expectedActiveId ? 'true' : 'false'}`
    );
  }
}

mockWindow.setMode('highlight');
assertActiveModePressed('mode-highlight-btn');
mockWindow.setMode('strike');
assertActiveModePressed('mode-strike-btn');
mockWindow.setMode('area');
assertActiveModePressed('mode-area-btn');
mockWindow.setMode('text');
assertActiveModePressed('mode-text-btn');
console.log('✅ PASS: a11y Behavioral 3: All 6 mode buttons maintain accurate aria-pressed states');

// 2d. #comments-toggle-btn aria-pressed and live comment count accessible name
const commentsToggleBtn = mockDocument.getElementById('comments-toggle-btn');
await mockWindow.refreshComments();
assert.equal(commentsToggleBtn.getAttribute('aria-pressed'), 'false');
assert.equal(commentsToggleBtn.getAttribute('aria-label'), 'Show all 8 comments');

mockWindow.toggleShowAllComments(true);
assert.equal(commentsToggleBtn.getAttribute('aria-pressed'), 'true');
assert.equal(commentsToggleBtn.getAttribute('aria-label'), 'Hide all 8 comments');

mockWindow.toggleShowAllComments(false);
assert.equal(commentsToggleBtn.getAttribute('aria-pressed'), 'false');
assert.equal(commentsToggleBtn.getAttribute('aria-label'), 'Show all 8 comments');

// Singular & zero count labels
mockedComments = [{ id: 'c_1', page: 1, type: 'note', comment: 'Single' }];
await mockWindow.refreshComments();
assert.equal(commentsToggleBtn.getAttribute('aria-label'), 'Show all 1 comment');
mockWindow.toggleShowAllComments(true);
assert.equal(commentsToggleBtn.getAttribute('aria-label'), 'Hide all 1 comment');

mockedComments = [];
await mockWindow.refreshComments();
assert.equal(commentsToggleBtn.getAttribute('aria-label'), 'Hide all 0 comments');
mockWindow.toggleShowAllComments(false);
assert.equal(commentsToggleBtn.getAttribute('aria-label'), 'Show all 0 comments');
console.log('✅ PASS: a11y Behavioral 4: #comments-toggle-btn aria-pressed and live count accessible names verified');
