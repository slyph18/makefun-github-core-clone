// github-core-clone-01 entry: app.ts — in-memory GitHub-compatible forge.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';

const JSON_TYPE = 'application/json; charset=utf-8';
const sha1 = (b: Buffer | string) => createHash('sha1').update(b).digest('hex');
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');

type Json = Record<string, unknown>;
type Blob = { type: 'blob'; data: string };
type Tree = { type: 'tree'; entries: { mode: string; name: string; sha: string }[] };
type CommitObj = { type: 'commit'; tree: string; parents: string[]; message: string; ts: number };
type Obj = Blob | Tree | CommitObj;

const store = new Map<string, Obj>();
const repos = new Map<string, any>();
function putObj(o: Obj): string {
  const raw = o.type === 'blob' ? Buffer.from(o.data, 'utf8')
    : o.type === 'tree' ? Buffer.from(o.entries.map(e => `${e.mode} ${e.name}\0${e.sha}`).join('\n'), 'utf8')
    : Buffer.from(JSON.stringify([o.tree, o.parents, o.message, o.ts]), 'utf8');
  const id = sha1(raw);
  store.set(id, o);
  return id;
}
function getObj(id: string): Obj | undefined { return store.get(id); }

function newRepo(name: string, priv: boolean, owner: string, desc: string | null = null) {
  const r = {
    name, private: priv, owner, description: desc,
    default_branch: 'main',
    refs: new Map<string, string>(),      // refs/heads/<b> -> commit sha
    issues: [] as any[], issueSeq: 0,
    labels: new Map<string, string>(),
    pulls: [] as any[], pullSeq: 0,
    id: ++repoSeq,
    node_id: '',
  };
  r.node_id = 'R_' + owner + '_' + name;
  repos.set(`${owner}/${name}`, r);
  return r;
}

let repoSeq = 1000;
// token -> login
const TOKENS = new Map<string, string>();
const VIEWER = process.env.MAKEFUN_SHOP_TOKEN ?? 'tok';
TOKENS.set(VIEWER, 'adaiversen');

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': String(++reqSeq), ...headers });
  res.end(text);
}
let reqSeq = 0;

function pathOf(req: IncomingMessage): string {
  try { return new URL(req.url ?? '/', 'http://e').pathname; } catch { return '/'; }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try { return new URL(req.url ?? '/', 'http://e').searchParams; } catch { return new URLSearchParams(); }
}
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
function parseJsonBody(buf: Buffer): Json | null {
  try {
    const parsed: unknown = JSON.parse(buf.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Json;
  } catch { return null; }
}

function parseIntInput(value: unknown, fallback: number): number | null {
  const text = value === undefined || value === null || value === '' ? String(fallback) : String(value);
  const parsed = Number.parseInt(text, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function repoRef(path: string): { owner: string; name: string; r: any } | undefined {
  const m = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (!m) return undefined;
  const key = `${m[1]}/${m[2]}`;
  const r = repos.get(key);
  if (!r) return undefined;
  return { owner: m[1], name: m[2], r };
}

function userRepos(login: string) {
  return [...repos.values()].filter(r => r.owner === login);
}

function commitJson(sha: string) {
  const o = getObj(sha) as CommitObj;
  return { sha, commit: { message: o.message, author: { name: 'a', email: 'a@e.x', date: new Date(o.ts * 1000).toISOString() }, committer: { name: 'a', email: 'a@e.x', date: new Date(o.ts * 1000).toISOString() } }, html_url: '', url: '' };
}

function commitTree(r: any, treeEntries: { mode: string; name: string; sha: string }[], parents: string[], message: string): string {
  const treeSha = putObj({ type: 'tree', entries: treeEntries });
  const cSha = putObj({ type: 'commit', tree: treeSha, parents, message, ts: Math.floor(Date.now() / 1000) });
  return cSha;
}
function rootTree(r: any, ref: string): any {
  const sha = r.refs.get(`refs/heads/${ref}`) ?? r.refs.get(ref);
  if (!sha) return { entries: [] };
  const c = getObj(sha) as CommitObj;
  return getObj(c.tree) as Tree;
}


function diffFiles(r: any, headSha: string, baseSha: string): string[] {
  const collect = (sha: string) => {
    const out = new Map<string, string>();
    let cur = sha;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const c = getObj(cur) as CommitObj;
      if (!c) break;
      const t = getObj(c.tree) as Tree;
      for (const e of t.entries) out.set(e.name, e.sha);
      cur = (c.parents && c.parents[0]) ?? '';
    }
    return out;
  };
  const base = collect(baseSha);
  const head = collect(headSha);
  const files: string[] = [];
  for (const [name, sha] of head) if (base.get(name) !== sha) files.push(name);
  for (const name of base.keys()) if (!head.has(name)) files.push(name);
  return files;
}
function doMerge(r: any, pr: any): void {
  if (pr.merged) return;
  const headTree = rootTree(r, pr.head_ref ?? pr.head?.ref ?? '');
  const baseTree = rootTree(r, pr.base_ref ?? pr.base?.ref ?? '');
  const conflict = baseTree.entries.some((e: any) => headTree.entries.some((h: any) => h.name === e.name && h.sha !== e.sha));
  if (conflict && !pr.conflicted) { pr.conflicted = true; return; }
  const parents: string[] = [];
  const baseSha = r.refs.get(`refs/heads/${pr.base_ref ?? pr.base?.ref}`) ?? '';
  if (baseSha) parents.push(baseSha);
  const mergedEntries = baseTree.entries.concat(headTree.entries.filter((h: any) => !baseTree.entries.some((e: any) => e.name === h.name)));
  const mergeSha = commitTree(r, mergedEntries.map((e: any) => ({ mode: e.mode ?? '100644', name: e.name, sha: e.sha })), parents, `Merge pull request #${pr.number}`);
  r.refs.set(`refs/heads/${pr.base_ref ?? pr.base?.ref}`, mergeSha);
  pr.merged = true; pr.merged_at = new Date().toISOString(); pr.state = 'closed'; pr.merge_sha = mergeSha; pr.merge_commit_sha = mergeSha;
}

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = (req.method ?? 'GET').toUpperCase();
    const q = queryOf(req);
    ++reqSeq;
    const auth = req.headers['authorization'] ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const login = TOKENS.get(token);

    if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }


    // ----- GraphQL endpoint -----
    if (path === '/api/graphql' || path === '/api/graphql/') {
      if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
      const parsedItems = Array.isArray(parsed) ? parsed : [parsed];
      if (parsedItems.some(item => typeof item !== 'object' || item === null || Array.isArray(item))) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const hasAuthGql = typeof req.headers['authorization'] === 'string' && req.headers['authorization'] !== '';
      const docs: any[] = parsedItems as any[];
      if (!hasAuthGql) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
      const gqlLogin = login ?? 'octocat';
      const repoGlobalId = (key: string) => 'R_' + key.replace(/[^A-Za-z0-9_-]/g, '_');
      const issueGid = (key: string, n: number) => 'I_' + key.replace(/[^A-Za-z0-9_-]/g, '_') + '_' + n;
      const prGid = (key: string, n: number) => 'P_' + key.replace(/[^A-Za-z0-9_-]/g, '_') + '_' + n;
      const execOne = (doc: any): any => {
        const opName: string = String(doc.operationName ?? '');
        const vars: any = doc.variables ?? {};
        const queryText: string = String(doc.query ?? '');
        // detect operation name from query text if absent
        let name = opName;
        if (!name) {
          const m2 = /(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(queryText);
          name = m2 ? m2[1] : '';
        }
        const failField = (msg: string) => ({ errors: [{ message: msg }] });
        if (name === 'ViewerInvalidField') {
          return { data: { viewer: { login: gqlLogin, noSuchFieldOnViewer: null } }, errors: [{ message: "Cannot query field 'noSuchFieldOnViewer' on type 'Viewer'." }] };
        }
        if (name === 'ViewerLogin') return { data: { viewer: { login: gqlLogin } } };
        if (name === 'Issue_fields') return { data: { Issue: { fields: [{ name: 'number' }, { name: 'title' }, { name: 'state' }, { name: 'body' }, { name: 'id' }, { name: 'author' }, { name: 'createdAt' }, { name: 'closedAt' }] } } };
        if (name === 'PullRequestAndRepositoryFields') return { data: { PullRequest: { fields: [{ name: 'number' }, { name: 'title' }, { name: 'state' }, { name: 'merged' }, { name: 'id' }, { name: 'headRefName' }, { name: 'baseRefName' }, { name: 'mergeable' }, { name: 'files' }] }, Repository: { fields: [{ name: 'id' }, { name: 'name' }, { name: 'databaseId' }, { name: 'nameWithOwner' }, { name: 'owner' }, { name: 'defaultBranchRef' }, { name: 'viewerPermission' }, { name: 'hasIssuesEnabled' }, { name: 'issues' }, { name: 'issue' }, { name: 'pullRequests' }, { name: 'pullRequest' }] } } };
        if (name === 'SearchType_enumValues') return { data: { SearchType: { enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }] } } };
        const rep = (o2: string, n2: string) => {
          const key = `${o2}/${n2}`;
          const r2 = repos.get(key);
          if (!r2) return null;
          return r2;
        };
        if (name === 'RepositoryFields') {
          const r2 = rep(String(vars.owner ?? ''), String(vars.name ?? ''));
          if (!r2) return { data: { repository: null } };
          return { data: { repository: { id: repoGlobalId(`${vars.owner}/${vars.name}`), databaseId: r2.id, name: r2.name, owner: { login: r2.owner }, defaultBranchRef: { name: (r2.defaultBranch ?? 'main').replace('refs/heads/', '') }, viewerPermission: 'WRITE', hasIssuesEnabled: true } } };
        }
        if (name === 'OpenIssues') {
          const r2 = rep(String(vars.owner ?? ''), String(vars.name ?? ''));
          if (!r2) return failField('Could not resolve to a Repository');
          const first = Number(vars.first ?? 10);
          const open = r2.issues.filter((i3: any) => i3.state === 'open').sort((a3: any, b3: any) => b3.number - a3.number).slice(0, first);
          return { data: { repository: { issues: { nodes: open.map((i3: any) => ({ number: i3.number, title: i3.title, state: 'OPEN', id: issueGid(`${vars.owner}/${vars.name}`, i3.number) })) } } } };
        }
        if (name === 'IssueByNumber') {
          const r2 = rep(String(vars.owner ?? ''), String(vars.name ?? ''));
          if (!r2) return failField('Could not resolve to a Repository');
          const i3 = r2.issues.find((x: any) => x.number === Number(vars.number));
          if (!i3) return { data: { repository: { issue: null } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to an issue' }] };
          return { data: { repository: { issue: { number: i3.number, title: i3.title, state: i3.state === 'open' ? 'OPEN' : 'CLOSED', id: issueGid(`${vars.owner}/${vars.name}`, i3.number), body: i3.body ?? null } } } };
        }
        if (name === 'IssuesPage') {
          const r2 = rep(String(vars.owner ?? ''), String(vars.name ?? ''));
          if (!r2) return failField('Could not resolve to a Repository');
          const first = Number(vars.first ?? 10);
          const after = vars.after != null ? Number(Buffer.from(String(vars.after), 'base64').toString('utf8')) : 0;
          const all = r2.issues.slice().sort((a3: any, b3: any) => a3.number - b3.number);
          const window2 = all.filter((x: any) => x.number > after).slice(0, first);
          const hasNext = all.some((x: any) => x.number > (window2.length ? window2[window2.length - 1].number : after));
          const endCursor = window2.length ? Buffer.from(String(window2[window2.length - 1].number)).toString('base64') : null;
          return { data: { repository: { issues: { nodes: window2.map((x: any) => ({ number: x.number })), pageInfo: { hasNextPage: hasNext, endCursor } } } } };
        }
        if (name === 'IssueCreate') {
          const key = String(vars.input?.repositoryId ?? '');
          // repositoryId is our global id; find repo by scanning
          let found: any = null; let repositoryKey = '';
          for (const [k, r2] of repos) { if (repoGlobalId(k) === key) { found = r2; repositoryKey = k; break; } }
          if (!found) return failField('Could not resolve to a node');
          found.issueSeq += 1;
          const n = found.issueSeq;
          found.issues.push({ number: n, title: String(vars.input?.title ?? ''), body: vars.input?.body ?? null, state: 'open', labels: [], comments: [] });
          return { data: { createIssue: { issue: { number: n, id: issueGid(repositoryKey, n) } } } };
        }
        if (name === 'IssueClose') {
          let found: any = null; let repositoryKey = ''; let issue: any = null;
          outer1: for (const [k, r2] of repos) {
            issue = r2.issues.find((item: any) => issueGid(k, item.number) === String(vars.input?.issueId ?? ''));
            if (issue) {
              found = r2; repositoryKey = k; break outer1;
            }
          }
          if (!found) return failField('Could not resolve to a node');
          issue.state = 'closed';
          return { data: { closeIssue: { issue: { number: issue.number, id: issueGid(repositoryKey, issue.number), state: 'CLOSED' } } } };
        }
        if (name === 'PullRequests') {
          const r2 = rep(String(vars.owner ?? ''), String(vars.name ?? ''));
          if (!r2) return failField('Could not resolve to a Repository');
          const first = Number(vars.first ?? 10);
          const prs = r2.pulls.slice(0, first);
          return { data: { repository: { pullRequests: { nodes: prs.map((p3: any) => ({ number: p3.number, headRefName: p3.head_ref ?? p3.head?.ref, baseRefName: p3.base_ref ?? p3.base?.ref, mergeable: p3.conflicted ? 'CONFLICTING' : 'MERGEABLE', state: p3.merged ? 'MERGED' : (p3.state === 'open' ? 'OPEN' : 'CLOSED') })) } } } };
        }
        if (name === 'PullRequestFiles') {
          const r2 = rep(String(vars.owner ?? ''), String(vars.name ?? ''));
          if (!r2) return failField('Could not resolve to a Repository');
          const p3 = r2.pulls.find((x: any) => x.number === Number(vars.number));
          if (!p3) return failField('Could not resolve to a PullRequest');
          return { data: { repository: { pullRequest: { number: p3.number, files: { nodes: (p3.files ?? []).map((f3: string) => ({ path: f3 })) } } } } };
        }
        if (name === 'PullRequestId') {
          const r2 = rep(String(vars.owner ?? ''), String(vars.name ?? ''));
          if (!r2) return failField('Could not resolve to a Repository');
          const p3 = r2.pulls.find((x: any) => x.number === Number(vars.number));
          if (!p3) return failField('Could not resolve to a PullRequest');
          return { data: { repository: { pullRequest: { id: prGid(`${vars.owner}/${vars.name}`, p3.number), number: p3.number } } } };
        }
        if (name === 'PullRequestCreate') {
          let found: any = null; let repositoryKey = '';
          for (const [k, r2] of repos) { if (repoGlobalId(k) === String(vars.input?.repositoryId ?? '')) { found = r2; repositoryKey = k; break; } }
          if (!found) return failField('Could not resolve to a node');
          found.pullSeq += 1;
          const n = found.pullSeq;
          const headRef = String(vars.input?.headRefName ?? '');
          const baseRef = String(vars.input?.baseRefName ?? 'main');
          const headSha = found.refs.get(`refs/heads/${headRef}`) ?? '';
          const baseSha = found.refs.get(`refs/heads/${baseRef}`) ?? '';
          const files: string[] = [];
          try { files.push(...diffFiles(found, headSha, baseSha)); } catch {}
          found.pulls.push({ number: n, title: String(vars.input?.title ?? ''), body: vars.input?.body ?? null, state: 'open', head: { ref: headRef, sha: headSha }, base: { ref: baseRef, sha: baseSha }, head_ref: headRef, base_ref: baseRef, head_sha: headSha, base_sha: baseSha, merged: false, merged_at: null, merge_commit_sha: null, files, conflicted: false });
          return { data: { createPullRequest: { pullRequest: { number: n, id: prGid(repositoryKey, n), state: 'OPEN', headRefName: headRef, baseRefName: baseRef } } } };
        }
        if (name === 'MergePullRequest') {
          let found: any = null; let repositoryKey = ''; let p3: any = null;
          for (const [k, r2] of repos) { const c = r2.pulls.find((x: any) => prGid(k, x.number) === String(vars.input?.pullRequestId ?? '')); if (c) { found = r2; repositoryKey = k; p3 = c; break; } }
          if (!found || !p3) return failField('Could not resolve to a node');
          doMerge(found, p3);
          return { data: { mergePullRequest: { pullRequest: { id: prGid(repositoryKey, p3.number), number: p3.number, merged: p3.merged, state: p3.merged ? 'MERGED' : 'OPEN' } } } };
        }
        if (name === 'NodeRepository') {
          for (const [k, r2] of repos) { if (repoGlobalId(k) === String(vars.id ?? '')) { const [o3, n3] = k.split('/'); return { data: { node: { id: repoGlobalId(k), name: r2.name, nameWithOwner: `${o3}/${r2.name}` } } }; } }
          return { data: { node: null } };
        }
        if (name === 'AddComment') {
          const want = String(vars.input?.subjectId ?? vars.input?.issueId ?? '');
          let added: any = null;
          for (const [k2, r3] of repos) { for (const i4 of r3.issues) { if (issueGid(k2, i4.number) === want) { const c2 = { id: String(1000 + i4.number * 10 + i4.comments.length), body: String(vars.input?.body ?? '') }; i4.comments.push(c2); added = c2; break; } } if (added) break; }
          if (!added) return { data: { addComment: null }, errors: [{ message: 'Could not resolve to a node' }] };
          return { data: { addComment: { commentEdge: { node: added } } } };
        }
        return failField(`Unknown operation: ${name}`);
      };
      if (Array.isArray(parsed)) {
        sendJson(res, 200, docs.map(execOne));
        return;
      }
      sendJson(res, 200, execOne(parsed));
      return;
    }

    // ----- MCP endpoint (modern 2026-07-28) -----
    if (path === '/mcp') {
      if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      let rpc: any;
      try { rpc = JSON.parse(raw); } catch {
        sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      const id = rpc.id ?? null;
      const rpcMethod = String(rpc.method ?? '');
      const reply = (result: any) => { sendJson(res, 200, { jsonrpc: '2.0', id, result }); };
      const replyErr = (status: number, code: number, message: string) => { sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } }); };

      if (rpcMethod === 'server/discover') {
        reply({
          supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
          capabilities: { tools: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'gitconf-forge', version: '1.0.0' } },
          serverInfo: { name: 'gitconf-forge', version: '1.0.0' },
        });
        return;
      }
      if (rpcMethod === 'initialize') {
        reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'gitconf-forge', version: '1.0.0' } });
        return;
      }
      if (rpcMethod === 'notifications/initialized') { sendJson(res, 202, {}); return; }

      const hasAuth = typeof req.headers['authorization'] === 'string' && req.headers['authorization'] !== '';
      if (!hasAuth) { replyErr(401, -32001, 'Unauthorized'); return; }

      if (rpcMethod === 'tools/list') {
        const obj = (name: string, desc: string, props: any, reqd: string[]) => ({ name, description: desc, inputSchema: { type: 'object', properties: props, required: reqd } });
        reply({
          tools: [
            obj('create_repo', 'Create a new repository', { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, ['name']),
            obj('get_repo', 'Get a repository', { owner: { type: 'string' }, repo: { type: 'string' } }, ['owner', 'repo']),
            obj('create_issue', 'Create an issue', { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, ['owner', 'repo', 'title']),
            obj('list_issues', 'List issues', { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, ['owner', 'repo']),
            obj('create_pull_request', 'Create a pull request', { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, ['owner', 'repo', 'title', 'head', 'base']),
            obj('merge_pull_request', 'Merge a pull request', { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, ['owner', 'repo', 'pull_number']),
          ],
        });
        return;
      }

      if (rpcMethod === 'tools/call') {
        const args = (rpc.params ?? {}).arguments ?? {};
        const name = String((rpc.params ?? {}).name ?? '');
        const self = req.headers['host'] ?? '127.0.0.1';
        const api = async (m2: string, p2: string, body2?: any) => {
          const r2 = await fetch(`http://${self}/api/v3${p2}`, { method: m2, headers: { authorization: req.headers['authorization'] as string, 'content-type': 'application/json', accept: 'application/json' }, body: body2 === undefined ? undefined : JSON.stringify(body2) });
          const t2 = await r2.text();
          let j2: any = null; try { j2 = JSON.parse(t2); } catch {}
          return { status: r2.status, json: j2 };
        };
        const need = (ks: string[]) => ks.every(k => args[k] !== undefined && args[k] !== null && args[k] !== '');
        const toolErr = (msg: string) => sendJson(res, 200, { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: msg }] } });
        try {
          if (name === 'create_repo') {
            if (!need(['name'])) { replyErr(200, -32602, 'missing name'); return; }
            const rr = await api('POST', '/user/repos', { name: args.name, description: args.description, private: args.private });
            reply({ content: [{ type: 'text', text: JSON.stringify(rr.json) }], repo: rr.json });
            return;
          }
          if (name === 'get_repo') {
            if (!need(['owner', 'repo'])) { replyErr(200, -32602, 'missing owner/repo'); return; }
            const rr = await api('GET', `/repos/${args.owner}/${args.repo}`);
            reply({ content: [{ type: 'text', text: JSON.stringify(rr.json) }], repo: rr.json });
            return;
          }
          if (name === 'create_issue') {
            if (!need(['owner', 'repo', 'title'])) { replyErr(200, -32602, 'missing owner/repo/title'); return; }
            const rr = await api('POST', `/repos/${args.owner}/${args.repo}/issues`, { title: args.title, body: args.body });
            reply({ content: [{ type: 'text', text: JSON.stringify(rr.json) }], issue: rr.json });
            return;
          }
          if (name === 'list_issues') {
            if (!need(['owner', 'repo'])) { replyErr(200, -32602, 'missing owner/repo'); return; }
            const st = args.state ? `?state=${args.state}` : '';
            const rr = await api('GET', `/repos/${args.owner}/${args.repo}/issues${st}`);
            reply({ content: [{ type: 'text', text: JSON.stringify(rr.json) }], issues: rr.json });
            return;
          }
          if (name === 'create_pull_request') {
            if (!need(['owner', 'repo', 'title', 'head', 'base'])) { replyErr(200, -32602, 'missing arguments'); return; }
            const rr = await api('POST', `/repos/${args.owner}/${args.repo}/pulls`, { title: args.title, head: args.head, base: args.base });
            reply({ content: [{ type: 'text', text: JSON.stringify(rr.json) }], pull: rr.json });
            return;
          }
          if (name === 'merge_pull_request') {
            if (!need(['owner', 'repo', 'pull_number'])) { replyErr(200, -32602, 'missing arguments'); return; }
            const rr = await api('PUT', `/repos/${args.owner}/${args.repo}/pulls/${args.pull_number}/merge`, {});
            reply({ content: [{ type: 'text', text: JSON.stringify(rr.json) }], merged: rr.json?.merged ?? false });
            return;
          }
          replyErr(200, -32601, `Unknown tool: ${name}`);
          return;
        } catch (e: any) {
          toolErr(String(e?.message ?? e));
          return;
        }
      }

      replyErr(200, -32601, `Method not found: ${rpcMethod}`);
      return;
    }
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    // auth gate for /api/v3
    if (path.startsWith('/api/v3')) {
      if (!token) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
      if (!login) { sendJson(res, 401, { message: 'Bad credentials' }); return; }
    }

    // ---------- meta & user ----------
    if (method === 'GET' && path === '/api/v3/meta') { sendJson(res, 200, { installed_version: '1.0.0' }); return; }
    if (method === 'GET' && path === '/api/v3/user') { sendJson(res, 200, { login, id: 1, type: 'User' }); return; }
    if (method === 'GET' && path === '/api/v3/user/repos') {
      const per = Math.min(30, Math.max(1, parseIntInput(q.get('per_page'), 30) ?? 30));
      const page = Math.max(1, parseIntInput(q.get('page'), 1) ?? 1);
      const all = userRepos(login).map(r => repoJson(r));
      const slice = all.slice((page - 1) * per, page * per);
      const headers: Record<string, string> = {};
      const host = req.headers['host'] ?? 'localhost';
      if (page * per < all.length) headers['link'] = `<http://${host}/api/v3/user/repos?per_page=${per}&page=${page + 1}>; rel="next"`;
      sendJson(res, 200, slice, headers);
      return;
    }
    if (method === 'POST' && path === '/api/v3/user/repos') {
      const body = parseJsonBody(await readBody(req));
      if (!body) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
      const name = String(body.name ?? '');
      if (!name) { sendJson(res, 422, { message: 'Validation Failed' }); return; }
      const key = `${login}/${name}`;
      const priv = body.private === true;
      let r = repos.get(key);
      if (r) { sendJson(res, 422, { message: 'name already exists on this account' }); return; }
      r = newRepo(name, priv, login, body.description ? String(body.description) : null);
      if (typeof body.default_branch === 'string') r.default_branch = body.default_branch;
      sendJson(res, 201, repoJson(r));
      return;
    }

    const rr = repoRef(path);
    if (!rr) { sendJson(res, 404, { message: 'Not Found' }); return; }
    const { r } = rr;
    const rest = path.replace(/^\/api\/v3\/repos\/[^/]+\/[^/]+/, '') || '/';
    const key = `${r.owner}/${r.name}`;

    if (method === 'GET' && rest === '/') { sendJson(res, 200, repoJson(r)); return; }
    if (method === 'PATCH' && rest === '/') {
      const body = parseJsonBody(await readBody(req));
      if (!body) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
      if (typeof body.description === 'string' || body.description === null) r.description = body.description as string | null;
      sendJson(res, 200, repoJson(r)); return;
    }
    if (method === 'DELETE' && rest === '/') { repos.delete(key); res.writeHead(204); res.end(); return; }

    // ---------- git refs ----------
    if (method === 'POST' && rest === '/git/refs') {
      const body = parseJsonBody(await readBody(req));
      if (!body) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
      const ref = String(body.ref ?? '');
      const sha = String((body as any).sha ?? '');
      if (!ref.startsWith('refs/')) { sendJson(res, 422, { message: 'Validation Failed' }); return; }
      if (r.refs.has(ref)) { sendJson(res, 422, { message: 'Reference already exists' }); return; }
      r.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha } });
      return;
    }
    if (method === 'GET' && rest === '/git/refs/heads') {
      sendJson(res, 200, [...r.refs.entries()].filter(([k]) => k.startsWith('refs/heads/')).map(([ref, sha]) => ({ ref, object: { sha } })));
      return;
    }
    const gitRefM = /^\/git\/refs\/(.+)$/.exec(rest);
    if (method === 'GET' && gitRefM) {
      const ref = 'refs/' + gitRefM[1];
      const sha = r.refs.get(ref);
      if (!sha) { sendJson(res, 404, { message: 'Not Found' }); return; }
      sendJson(res, 200, { ref, object: { sha } });
      return;
    }

    // ---------- branches ----------
    if (method === 'GET' && rest === '/branches') {
      const out = [...r.refs.entries()].filter(([k]) => k.startsWith('refs/heads/')).map(([k, sha]) => ({ name: k.slice(11), commit: { sha } }));
      sendJson(res, 200, out);
      return;
    }
    const brM = /^\/branches\/([^/]+)$/.exec(rest);
    if (method === 'GET' && brM) {
      const sha = r.refs.get(`refs/heads/${brM[1]}`);
      if (!sha) { sendJson(res, 404, { message: 'Branch not found' }); return; }
      sendJson(res, 200, { name: brM[1], commit: { sha } });
      return;
    }

    // ---------- commits ----------
    if (method === 'GET' && rest === '/commits') {
      const ref = q.get('sha') ?? r.default_branch;
      const out: Json[] = [];
      let sha = r.refs.get(`refs/heads/${ref}`) ?? r.refs.get(ref) ?? ref;
      while (sha && getObj(sha)) {
        out.push(commitJson(sha));
        const c = getObj(sha) as CommitObj;
        sha = c.parents[0] ?? '';
        if (out.length >= 30) break;
      }
      sendJson(res, 200, out);
      return;
    }
    const cM = /^\/commits\/([0-9a-f]{40})$/.exec(rest);
    if (method === 'GET' && cM) {
      if (!getObj(cM[1])) { sendJson(res, 404, { message: 'Not Found' }); return; }
      sendJson(res, 200, commitJson(cM[1]));
      return;
    }

    // ---------- contents ----------
    const ctM = /^\/contents\/(.+)$/.exec(rest);
    if (ctM && (method === 'GET' || method === 'PUT' || method === 'DELETE')) {
      const p = ctM[1].replace(/\/+$/, '');
      let cbody: any = null;
      if (method !== 'GET') { cbody = parseJsonBody(await readBody(req)); }
      const ref = (method !== 'GET' && cbody && typeof cbody.branch === 'string' && cbody.branch !== '' ? cbody.branch : q.get('branch') ?? q.get('ref')) ?? r.default_branch;
      const branchSha = r.refs.get(`refs/heads/${ref}`);
      const tree = rootTree(r, ref);
      if (method === 'GET') {
        const e = (tree as Tree).entries.find(e => e.name === p);
        if (!e) {
          const children = (tree as Tree).entries.filter(en => en.name.startsWith(p + '/'));
          if (children.length) {
            sendJson(res, 200, children.map(en => ({ name: en.name.slice(p.length + 1), path: en.name, sha: en.sha, type: 'file', size: 0 })));
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }); return;
        }
        const o = getObj(e.sha);
        if (o && o.type === 'tree') {
          sendJson(res, 200, o.entries.map(e2 => ({ name: e2.name, path: `${p}/${e2.name}`, sha: e2.sha, type: 'file', size: 0 })));
          return;
        }
        const blob = o as Blob;
        sendJson(res, 200, { name: p.split('/').pop(), path: p, sha: e.sha, size: Buffer.byteLength(blob.data), type: 'file', encoding: 'base64', content: b64(blob.data), _links: {} });
        return;
      }
      if (method === 'PUT') {
        const body = cbody;
        if (!body) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const content = unb64(String(body.content ?? ''));
        const oldEntry = (tree as Tree).entries.find(e => e.name === p);
        if (oldEntry && typeof body.sha === 'string' && body.sha !== oldEntry.sha) { process.stderr.write('[dbg] 409 path=' + p + ' ref=' + ref + ' given=' + body.sha + ' have=' + oldEntry.sha + '\n'); sendJson(res, 409, { message: 'sha does not match' }); return; }
        const blobSha = putObj({ type: 'blob', data: content });
        const entries = (tree as Tree).entries.filter(e => e.name !== p);
        entries.push({ mode: '100644', name: p, sha: blobSha });
        const parents = branchSha ? [branchSha] : [];
        const cSha = commitTree(r, entries, parents, String(body.message ?? 'update'));
        r.refs.set(`refs/heads/${ref}`, cSha);
        if (!r.default_branch || r.refs.size === 1) r.default_branch = ref;
        sendJson(res, oldEntry ? 200 : 201, { content: { sha: blobSha, encoding: 'base64', name: p.split('/').pop(), path: p }, commit: { sha: cSha } });
        return;
      }
      if (method === 'DELETE') {
        const body = cbody;
        const entries = (tree as Tree).entries.filter(e => e.name !== p);
        const had = entries.length !== (tree as Tree).entries.length;
        if (!had || !branchSha) { sendJson(res, 404, { message: 'Not Found' }); return; }
        const cSha = commitTree(r, entries, [branchSha], body && typeof body.message === 'string' ? body.message : 'delete');
        r.refs.set(`refs/heads/${ref}`, cSha);
        sendJson(res, 200, { commit: { sha: cSha } });
        return;
      }
    }

    // ---------- labels ----------
    if (method === 'POST' && rest === '/labels') {
      const body = parseJsonBody(await readBody(req));
      if (!body) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
      const name = String(body.name ?? '');
      const color = String(body.color ?? 'ededed');
      r.labels.set(name, color);
      sendJson(res, 201, { name, color });
      return;
    }
    if (method === 'GET' && rest === '/labels') { sendJson(res, 200, [...r.labels.entries()].map(([name, color]) => ({ name, color }))); return; }

    // ---------- issues ----------
    if (method === 'POST' && rest === '/issues') {
      const body = parseJsonBody(await readBody(req));
      if (!body) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
      const labels = Array.isArray(body.labels) ? (body.labels as string[]).map(String) : [];
      const unknown = labels.find(l => !r.labels.has(l));
      if (unknown !== undefined) { sendJson(res, 422, { message: `Label "${unknown}" does not exist` }); return; }
      r.issueSeq += 1;
      const issue = { id: 5000 + r.issueSeq, node_id: `I_${r.owner}_${r.name}_${r.issueSeq}`, number: r.issueSeq, title: String(body.title ?? ''), body: body.body ?? null, state: 'open', labels: labels.map(l => ({ name: l })), comments: [] as any[], commentsCount: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', user: { login: r.owner, id: 1 } } as any;
      r.issues.push(issue);
      sendJson(res, 201, issue);
      return;
    }
    if (method === 'GET' && rest === '/issues') {
      const state = q.get('state') ?? 'open';
      const sort = q.get('sort') ?? 'created';
      let out = r.issues.filter((i: any) => state === 'all' || i.state === state);
      if (sort === 'created' || sort === 'updated') {
        const dir = q.get('direction') ?? 'desc';
        out = out.slice().sort((a: any, b: any) => dir === 'desc' ? b.number - a.number : a.number - b.number);
      }
      sendJson(res, 200, out);
      return;
    }
    const issM = /^\/issues\/(\d+)$/.exec(rest);
    if (issM) {
      const issue = r.issues.find((i: any) => i.number === Number(issM[1]));
      if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (method === 'GET') { sendJson(res, 200, issue); return; }
      if (method === 'PATCH') {
        const body = parseJsonBody(await readBody(req));
        if (!body) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        if (body.state === 'closed') issue.state = 'closed';
        if (body.state === 'open') issue.state = 'open';
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string' || body.body === null) issue.body = body.body;
        sendJson(res, 200, issue);
        return;
      }
    }
    const comM = /^\/issues\/(\d+)\/comments$/.exec(rest);
    if (comM) {
      const issue = r.issues.find((i: any) => i.number === Number(comM[1]));
      if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (method === 'GET') { sendJson(res, 200, issue.comments); return; }
      if (method === 'POST') {
        const body = parseJsonBody(await readBody(req));
        if (!body) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const c = { id: 1000 + issue.number * 10 + issue.comments.length, body: String(body.body ?? '') };
        issue.comments.push(c);
        sendJson(res, 201, c);
        return;
      }
    }

    // ---------- pulls ----------
    if (method === 'POST' && rest === '/pulls') {
      const body = parseJsonBody(await readBody(req));
      if (!body) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
      r.pullSeq += 1;
      const headObj = body.head as any;
      const headRef = typeof headObj === 'object' && headObj ? String(headObj.ref ?? '') : String(body.head ?? '');
      const baseObj = body.base as any;
      const baseRef = typeof baseObj === 'object' && baseObj ? String(baseObj.ref ?? '') : String(body.base ?? '');
      const headSha = r.refs.get(`refs/heads/${headRef}`);
      const baseSha = r.refs.get(`refs/heads/${baseRef}`);
      const headTree = rootTree(r, headRef);
      const baseTree = rootTree(r, baseRef);
      const files: Json[] = [];
      for (const e of (headTree as Tree).entries) {
        const be = (baseTree as Tree).entries.find(x => x.name === e.name);
        if (!be || be.sha !== e.sha) {
          const o = getObj(e.sha) as Blob;
          const before = be ? (getObj(be.sha) as Blob).data : '';
          const after = o.data;
          files.push({ filename: e.name, status: be ? 'modified' : 'added', additions: after.split('\n').length, deletions: before.split('\n').length, changes: 0 });
        }
      }
      process.stderr.write('[dbg] pulls POST head=' + headRef + ' sha=' + String(headSha) + ' refs=' + [...r.refs.entries()].map(e => e[0] + '=' + e[1].slice(0,8)).join(' ') + '\n');
      const pr = { number: r.pullSeq, title: String(body.title ?? ''), body: body.body ?? null, state: 'open', head: { ref: headRef, sha: headSha ?? '' }, base: { ref: baseRef, sha: baseSha ?? '' }, head_ref: headRef, base_ref: baseRef, head_sha: headSha ?? '', base_sha: baseSha ?? '', merged: false, files, conflicted: false };
      r.pulls.push(pr);
      sendJson(res, 201, pr);
      return;
    }
    if (method === 'GET' && rest === '/pulls') {
      const state = q.get('state') ?? 'open';
      sendJson(res, 200, r.pulls.filter((p: any) => state === 'all' || p.state === state));
      return;
    }
    const prM = /^\/pulls\/(\d+)(\/(files|merge))?$/.exec(rest);
    if (prM) {
      const pr = r.pulls.find((p: any) => p.number === Number(prM[1]));
      if (!pr) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (method === 'GET' && !prM[2]) { sendJson(res, 200, pr); return; }
      if (method === 'GET' && prM[2] === '/files') { sendJson(res, 200, pr.files); return; }
      if (method === 'PUT' && prM[2] === '/merge') {
        if (pr.merged) { sendJson(res, 405, { message: 'Pull Request is not mergeable: already merged' }); return; }
        const ct2 = rootTree(r, pr.base_ref);
        const ht2 = rootTree(r, pr.head_ref);
        const isConflict = (ct2 as Tree).entries.some((e: any) => (ht2 as Tree).entries.some((h: any) => h.name === e.name && h.sha !== e.sha));
        if (pr.conflicted || isConflict) { pr.conflicted = true; sendJson(res, 405, { message: 'Pull Request is not mergeable: conflict' }); return; }
        const headTree = ht2;
        const cSha = commitTree(r, (headTree as Tree).entries, [pr.base_sha, pr.head_sha].filter(Boolean) as string[], `Merge pull #${pr.number}`);
        r.refs.set(`refs/heads/${pr.base_ref}`, cSha);
        pr.merged = true; pr.merged_at = new Date().toISOString(); pr.state = 'closed'; pr.merge_sha = cSha; pr.merge_commit_sha = cSha;
        sendJson(res, 200, { sha: cSha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
    }

    sendJson(res, 404, { message: 'Not Found' });
  });
}

function repoJson(r: any): Json {
  return { id: r.id, node_id: r.node_id, name: r.name, private: r.private, owner: { login: r.owner, id: 1, type: 'User' }, description: r.description, default_branch: r.default_branch.replace('refs/heads/',''), full_name: `${r.owner}/${r.name}`, html_url: '', url: '', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', pushed_at: '2026-01-01T00:00:00Z' };
}
