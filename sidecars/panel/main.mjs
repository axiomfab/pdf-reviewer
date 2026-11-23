import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addPdfComment,
  clearPdfComments,
  deletePdfComment,
  listPdfComments,
  modifyPdfComment,
} from './pdf_annotations.mjs';

export { addPdfComment, clearPdfComments, deletePdfComment, listPdfComments, modifyPdfComment };

const HERE = dirname(fileURLToPath(import.meta.url));
const readLocal = (rel) => readFileSync(join(HERE, rel), 'utf8');

const IGNORED_DIRS = new Set(['node_modules', '.git', '.vscode', '.idea']);

function normalizePathKey(p) {
  const resolved = resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function parseGitWorktreeList(porcelainOutput) {
  if (!porcelainOutput || typeof porcelainOutput !== 'string') return [];
  const worktrees = [];
  let current = null;

  for (const rawLine of porcelainOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (current?.path) worktrees.push(current);
      current = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (current?.path) worktrees.push(current);
      current = { path: resolve(line.slice('worktree '.length).trim()), branch: null };
    } else if (current && line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      current.branch = ref.replace(/^refs\/heads\//, '');
    }
  }
  if (current?.path) worktrees.push(current);
  return worktrees;
}

export function findGitWorktrees(workspaceRoot) {
  if (
    !workspaceRoot ||
    typeof workspaceRoot !== 'string' ||
    !existsSync(workspaceRoot) ||
    !existsSync(join(workspaceRoot, '.git'))
  ) {
    return [];
  }
  try {
    const out = execFileSync('git', ['-C', workspaceRoot, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseGitWorktreeList(out).filter((wt) => {
      try {
        return existsSync(wt.path) && statSync(wt.path).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export function findWorkspacePdfs(workspaceRoot) {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    throw new Error('CRITICAL: workspaceRoot must be a non-empty string');
  }
  if (!existsSync(workspaceRoot)) {
    throw new Error(`CRITICAL: Workspace directory does not exist: ${workspaceRoot}`);
  }

  const resolvedWorkspace = resolve(workspaceRoot);
  const workspaceKey = normalizePathKey(resolvedWorkspace);
  const roots = [{ path: resolvedWorkspace, label: null }];
  const seenRootKeys = new Set([workspaceKey]);

  for (const wt of findGitWorktrees(resolvedWorkspace)) {
    const key = normalizePathKey(wt.path);
    if (!seenRootKeys.has(key)) {
      seenRootKeys.add(key);
      roots.push({
        path: wt.path,
        label: wt.branch || basename(wt.path),
      });
    }
  }

  const results = [];
  const seenPdfKeys = new Set();

  function walk(rootPath, label, dir, depth = 0) {
    if (depth > 4 || !existsSync(dir)) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            walk(rootPath, label, fullPath, depth + 1);
          }
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
          const pdfKey = normalizePathKey(fullPath);
          if (seenPdfKeys.has(pdfKey)) continue;
          seenPdfKeys.add(pdfKey);
          try {
            const stat = statSync(fullPath);
            const relInsideRoot = relative(rootPath, fullPath) || basename(fullPath);
            results.push({
              name: entry.name,
              path: fullPath,
              relPath: label ? `[${label}] ${relInsideRoot}` : relInsideRoot,
              worktree: label || null,
              mtime: stat.mtimeMs,
              size: stat.size,
            });
          } catch {}
        }
      }
    } catch {}
  }

  for (const root of roots) {
    walk(root.path, root.label, root.path, 0);
  }
  return results.sort((a, b) => b.mtime - a.mtime);
}

export function isPathInsideWorkspace(workspaceRoot, candidatePath) {
  if (!workspaceRoot || typeof workspaceRoot !== 'string' || !candidatePath || typeof candidatePath !== 'string') {
    return false;
  }
  const resolvedRoot = resolve(workspaceRoot);
  const resolvedCandidate = resolve(candidatePath);
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function resolveWorkspaceRoot(data, fallbackDir = process.cwd()) {
  const rawCandidate =
    typeof data?.workspacePath === 'string' && data.workspacePath.trim()
      ? data.workspacePath.trim()
      : typeof data?.workspaceUri === 'string' && data.workspaceUri.trim()
        ? data.workspaceUri.trim()
        : '';

  if (rawCandidate) {
    try {
      const parsed = rawCandidate.startsWith('file:')
        ? fileURLToPath(rawCandidate)
        : resolve(rawCandidate);
      if (existsSync(parsed) && statSync(parsed).isDirectory()) {
        return resolve(parsed);
      }
    } catch {}
  }

  return resolve(fallbackDir);
}

export function resolveTargetPdf(workspaceRoot, requestedPath) {
  if (requestedPath) {
    const candidate = resolve(workspaceRoot, requestedPath);
    const inWorkspaceOrWorktree =
      isPathInsideWorkspace(workspaceRoot, candidate) ||
      findGitWorktrees(workspaceRoot).some((wt) => isPathInsideWorkspace(wt.path, candidate));
    if (
      inWorkspaceOrWorktree &&
      candidate.toLowerCase().endsWith('.pdf') &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
    ) {
      const stat = statSync(candidate);
      return {
        path: candidate,
        name: basename(candidate),
        mtime: stat.mtimeMs,
        size: stat.size,
      };
    }
    return null;
  }

  const all = findWorkspacePdfs(workspaceRoot);
  return all.length > 0 ? all[0] : null;
}

const isSidecar = Boolean(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);
if (isSidecar) {
  const { Response, SidecarApp } = await import('sidecar_sdk');
  const app = new SidecarApp();

  app.page('/', () => new Response(readLocal('index.html'), { contentType: 'text/html', headers: { 'Cache-Control': 'no-cache, no-store' } }));
  app.page('/app.js', () => new Response(readLocal('app.js'), { contentType: 'application/javascript', headers: { 'Cache-Control': 'no-cache, no-store' } }));
  app.page('/ui_history.js', () => new Response(readLocal('ui_history.js'), { contentType: 'application/javascript', headers: { 'Cache-Control': 'no-cache, no-store' } }));
  app.page('/ui_comments.js', () => new Response(readLocal('ui_comments.js'), { contentType: 'application/javascript', headers: { 'Cache-Control': 'no-cache, no-store' } }));
  app.page('/lib/pdf.min.js', () => readLocal('lib/pdf.min.js'));
  app.page('/lib/pdf.worker.min.js', () => readLocal('lib/pdf.worker.min.js'));
  app.api('/styles.css', () => new Response(readLocal('styles.css'), { contentType: 'text/css', headers: { 'Cache-Control': 'no-cache, no-store' } }), 'GET');
  app.api('/comments.css', () => new Response(readLocal('comments.css'), { contentType: 'text/css', headers: { 'Cache-Control': 'no-cache, no-store' } }), 'GET');

  const getWorkspace = (data) => resolveWorkspaceRoot(data, process.cwd());

  app.api('/api/list', (data) => {
    const ws = getWorkspace(data);
    const pdfs = findWorkspacePdfs(ws);
    return { workspace: ws, pdfs };
  }, 'GET');

  app.api('/api/status', (data) => {
    const ws = getWorkspace(data);
    const target = resolveTargetPdf(ws, data?.pdfPath);
    if (!target) {
      return new Response(JSON.stringify({ error: 'No PDF found', target: null }), {
        contentType: 'application/json',
        status: 404,
      });
    }
    return { target };
  }, 'GET');

  app.api('/api/pdf', (data) => {
    const ws = getWorkspace(data);
    const target = resolveTargetPdf(ws, data?.pdfPath);
    if (!target) {
      return new Response('PDF Not Found', { contentType: 'text/plain', status: 404 });
    }
    const pdfBuffer = readFileSync(target.path);
    return new Response(pdfBuffer, { contentType: 'application/pdf' });
  }, 'GET');

  app.api('/api/comments/list', async (data) => {
    const ws = getWorkspace(data);
    const target = resolveTargetPdf(ws, data?.pdfPath);
    if (!target) return { comments: [] };
    const comments = await listPdfComments(target.path);
    return { comments, pdfPath: target.path };
  }, 'GET');

  app.api('/api/comments/add', async (data) => {
    const ws = getWorkspace(data);
    const target = resolveTargetPdf(ws, data?.pdfPath);
    if (!target) {
      return new Response(JSON.stringify({ error: 'Target PDF not found' }), {
        contentType: 'application/json',
        status: 404,
      });
    }
    const { comment, mtime } = await addPdfComment(target.path, data);
    return { success: true, comment, mtime };
  }, 'POST');

  app.api('/api/comments/delete', async (data) => {
    const ws = getWorkspace(data);
    const target = resolveTargetPdf(ws, data?.pdfPath);
    if (!target) {
      return new Response(JSON.stringify({ error: 'Target PDF not found' }), {
        contentType: 'application/json',
        status: 404,
      });
    }
    const { deleted, mtime } = await deletePdfComment(target.path, data?.id);
    return { success: Boolean(deleted), comment: deleted, mtime };
  }, 'POST');

  app.api('/api/comments/modify', async (data) => {
    const ws = getWorkspace(data);
    const target = resolveTargetPdf(ws, data?.pdfPath);
    if (!target) {
      return new Response(JSON.stringify({ error: 'Target PDF not found' }), {
        contentType: 'application/json',
        status: 404,
      });
    }
    const { comment, mtime } = await modifyPdfComment(target.path, data?.id || data?.commentId, data);
    return { success: true, comment, mtime };
  }, 'POST');

  app.run();
}
