import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import {
  addPdfComment,
  clearPdfComments,
  deletePdfComment,
  listPdfComments,
} from './pdf_annotations.mjs';

export { addPdfComment, clearPdfComments, deletePdfComment, listPdfComments };

const HERE = dirname(fileURLToPath(import.meta.url));
const readLocal = (rel) => readFileSync(join(HERE, rel), 'utf8');

const IGNORED_DIRS = new Set(['node_modules', '.git', '.vscode', '.idea']);

export function findWorkspacePdfs(workspaceRoot) {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    throw new Error('CRITICAL: workspaceRoot must be a non-empty string');
  }
  if (!existsSync(workspaceRoot)) {
    throw new Error(`CRITICAL: Workspace directory does not exist: ${workspaceRoot}`);
  }

  const results = [];

  function walk(dir, depth = 0) {
    if (depth > 4 || !existsSync(dir)) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            walk(fullPath, depth + 1);
          }
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
          try {
            const stat = statSync(fullPath);
            results.push({
              name: entry.name,
              path: fullPath,
              relPath: fullPath.replace(workspaceRoot, '').replace(/^[\\/]/, ''),
              mtime: stat.mtimeMs,
              size: stat.size,
            });
          } catch {}
        }
      }
    } catch {}
  }

  walk(workspaceRoot);
  return results.sort((a, b) => b.mtime - a.mtime);
}

export function resolveTargetPdf(workspaceRoot, requestedPath) {
  if (requestedPath) {
    const candidate = resolve(workspaceRoot, requestedPath);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      const stat = statSync(candidate);
      return {
        path: candidate,
        name: basename(candidate),
        mtime: stat.mtimeMs,
        size: stat.size,
      };
    }
  }

  const all = findWorkspacePdfs(workspaceRoot);
  return all.length > 0 ? all[0] : null;
}

const isSidecar = Boolean(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);
if (isSidecar) {
  const app = new SidecarApp();

  app.page('/', () => new Response(readLocal('index.html'), { contentType: 'text/html', headers: { 'Cache-Control': 'no-cache, no-store' } }));
  app.page('/app.js', () => new Response(readLocal('app.js'), { contentType: 'application/javascript', headers: { 'Cache-Control': 'no-cache, no-store' } }));
  app.page('/ui_comments.js', () => new Response(readLocal('ui_comments.js'), { contentType: 'application/javascript', headers: { 'Cache-Control': 'no-cache, no-store' } }));
  app.page('/lib/pdf.min.js', () => readLocal('lib/pdf.min.js'));
  app.page('/lib/pdf.worker.min.js', () => readLocal('lib/pdf.worker.min.js'));
  app.api('/styles.css', () => new Response(readLocal('styles.css'), { contentType: 'text/css', headers: { 'Cache-Control': 'no-cache, no-store' } }), 'GET');
  app.api('/comments.css', () => new Response(readLocal('comments.css'), { contentType: 'text/css', headers: { 'Cache-Control': 'no-cache, no-store' } }), 'GET');

  app.api('/api/debug_log', (data) => {
    console.log('[BROWSER_LOG]', JSON.stringify(data));
    return { ok: true };
  }, 'POST');

  const getWorkspace = (data) => {
    if (data?.workspaceUri) {
      try {
        const parsed = fileURLToPath(data.workspaceUri);
        if (existsSync(parsed)) return parsed;
      } catch {}
    }
    const cwd = process.cwd();
    if (cwd.includes('plugins') || cwd.includes('sidecars')) {
      const defaultWs = 'C:\\Users\\lukas\\Desktop\\weavemas-paper';
      if (existsSync(defaultWs)) return defaultWs;
    }
    return cwd;
  };

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

  app.run();
}
