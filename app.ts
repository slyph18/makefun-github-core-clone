// github-core-clone-01 entry: app.ts — in-memory GitHub-compatible forge.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const sha1 = (b: Buffer | string) => createHash('sha1').update(b).digest('hex');
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');

type Json = Record<string, unknown>;
type Blob = { type: 'blob'; data: string; base64?: string };
type Tree = { type: 'tree'; entries: { mode: string; name: string; sha: string }[] };
type CommitObj = { type: 'commit'; tree: string; parents: string[]; message: string; ts: number };
type Obj = Blob | Tree | CommitObj;

const store = new Map<string, Obj>();
const repos = new Map<string, any>();
const users: Json = {};
let repoSeq = 1;

function gitCanonical(o: Obj): Buffer {
  let body: Buffer;
  if (o.type === 'blob') body = Buffer.from(o.data, 'utf8');
  else if (o.type === 'tree') {
    const sorted = [...o.entries].sort((a, b) => {
      const an = a.mode === '40000' ? a.name + '/' : a.name;
      const bn = b.mode === '40000' ? b.name + '/' : b.name;
      return Buffer.from(an).compare(Buffer.from(bn));
    });
    const parts: Buffer[] = [];
    for (const e of sorted) {
      parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
      parts.push(Buffer.from(e.sha, 'hex'));
    }
    body = Buffer.concat(parts);
  } else {
    const who = `Conformance <conformance@make.fun> ${o.ts} +0000`;
    const lines = [`tree ${o.tree}`];
    for (const p of o.parents) lines.push(`parent ${p}`);
    lines.push(`author ${who}`, `committer ${who}`, '');
    body = Buffer.from(`${lines.join('\n')}\n${o.message}`, 'utf8');
  }
  return Buffer.concat([Buffer.from(`${o.type} ${body.length}\0`, 'utf8'), body]);
}
const gitRaw = new Map<string, Buffer>();
const packObjectCache = new Map<string, Buffer>();
function putObj(o: Obj): string {
  const raw = gitCanonical(o);
  const id = sha1(raw);
  store.set(id, o);
  gitRaw.set(id, raw);
  return id;
}
function getObj(id: string): Obj | undefined { return store.get(id); }

type Ref = { sha: string };
function newRepo(name: string, priv: boolean, owner: string, desc: string | null = null) {
  const r = {
    name, private: priv, owner, description: desc,
    default_branch: 'main',
    refs: new Map<string, string>(),      // refs/heads/<b> -> commit sha
    issues: [] as any[], issueSeq: 0,
    labels: new Map<string, string>(),
    pulls: [] as any[], pullSeq: 0,
    id: ++REPO_SEQ,
    node_id: '',
  };
  r.node_id = 'R_' + owner + '_' + name;
  repos.set(`${owner}/${name}`, r);
  return r;
}

// token -> login
let REPO_SEQ = 1000;
const TOKENS = new Map<string, string>();
const VIEWER = process.env.MAKEFUN_SHOP_TOKEN ?? 'tok';
TOKENS.set(VIEWER, 'adaiversen');
let LOGIN = 'adaiversen';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': String(++reqSeq), ...headers });
  res.end(text);
}
let reqSeq = 0;

function pathOf(req: IncomingMessage): string {
  const u = req.url ?? '/';
  const q = u.indexOf('?');
  return q < 0 ? u : u.slice(0, q);
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
  try { return JSON.parse(buf.toString('utf8')) as Json; } catch { return null; }
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

function commitJson(r: any, sha: string) {
  const o = getObj(sha) as CommitObj;
  return { sha, commit: { message: o.message, author: { name: 'a', email: 'a@e.x', date: new Date(o.ts * 1000).toISOString() }, committer: { name: 'a', email: 'a@e.x', date: new Date(o.ts * 1000).toISOString() } }, html_url: '', url: '' };
}

function commitTree(r: any, treeEntries: { mode: string; name: string; sha: string }[], parents: string[], message: string): string {
  const treeSha = putObj({ type: 'tree', entries: treeEntries });
  const cSha = putObj({ type: 'commit', tree: treeSha, parents, message, ts: Math.floor(Date.now() / 1000) });
  return cSha;
}
function rootTreeFromCommit(sha: string): any {
  const c = getObj(sha) as CommitObj | undefined;
  if (!c) return { entries: [] };
  return getObj(c.tree) as Tree;
}
function rootTree(r: any, ref: string): any {
  const sha = r.refs.get(`refs/heads/${ref}`) ?? r.refs.get(ref);
  if (!sha) return { entries: [] };
  const c = getObj(sha) as CommitObj;
  return getObj(c.tree) as Tree;
}


function walkTreeFlat(tid: string, prefix: string, out: Map<string, string>) {
  const t = getObj(tid) as Tree | undefined;
  if (!t) return;
  for (const e of t.entries) {
    const o = getObj(e.sha) as any;
    if (o && o.type === 'tree') walkTreeFlat(e.sha, prefix + e.name + '/', out);
    else out.set(prefix + e.name, e.sha);
  }
}
function diffFiles(r: any, headSha: string, baseSha: string): string[] {
  const collect = (sha: string) => {
    const out = new Map<string, string>();
    const walk = (tid: string, prefix: string) => {
      const t = getObj(tid) as Tree | undefined;
      if (!t) return;
      for (const e of t.entries) {
        const nm = prefix + e.name;
        const o = getObj(e.sha) as any;
        if (o && o.type === 'tree') walk(e.sha, nm + '/');
        else out.set(nm, e.sha);
      }
    };
    let cur = sha;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const c = getObj(cur) as CommitObj;
      if (!c) break;
      walk(c.tree, '');
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
  const c = commitTree(r, mergedEntries.map((e: any) => ({ mode: e.mode ?? '100644', name: e.name, sha: e.sha })), parents, `Merge pull request #${pr.number}`);
  r.refs.set(`refs/heads/${pr.base_ref ?? pr.base?.ref}`, c.sha);
  pr.merged = true; pr.merged_at = new Date().toISOString(); pr.state = 'closed'; pr.merge_sha = c.sha; pr.merge_commit_sha = c.sha;
}


function storeObjFromGit(type: string, body: Buffer, oid?: string): string {
  const header = Buffer.from(`${type} ${body.length}\0`, 'utf8');
  const raw = Buffer.allocUnsafe(header.length + body.length);
  header.copy(raw, 0);
  body.copy(raw, header.length);
  const id = oid ?? createHash('sha1').update(raw).digest('hex');
  gitRaw.set(id, raw);
  if (type === 'blob') store.set(id, { type: 'blob', data: body.toString('utf8') });
  else if (type === 'tree') {
    const entries: { mode: string; name: string; sha: string }[] = [];
    let i = 0;
    while (i < body.length) {
      const sp = body.indexOf(0x20, i);
      if (sp < 0) break;
      const mode = body.subarray(i, sp).toString('utf8');
      const nul = body.indexOf(0, sp);
      if (nul < 0) break;
      const name = body.subarray(sp + 1, nul).toString('utf8');
      const sha = body.subarray(nul + 1, nul + 21).toString('hex');
      entries.push({ mode, name, sha });
      i = nul + 21;
    }
    store.set(id, { type: 'tree', entries });
  } else if (type === 'commit') {
    const text = body.toString('utf8');
    const blank = text.indexOf('\n\n');
    const header = blank < 0 ? text : text.slice(0, blank);
    const message = blank < 0 ? '' : text.slice(blank + 2);
    let tree = ''; const parents: string[] = []; const ts = 1700000000;
    const tsM = /committer .* (\d+) [-+]\d{4}/.exec(header);
    for (const line of header.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5);
      else if (line.startsWith('parent ')) parents.push(line.slice(7));
    }
    store.set(id, { type: 'commit', tree, parents, message, ts: tsM ? Number(tsM[1]) : ts });
  } else if (type === 'tag') {
    const text = body.toString('utf8');
    const objM = /^object ([0-9a-f]{40})/m.exec(text);
    const typeM = /^type (\S+)/m.exec(text);
    store.set(id, { type: 'tag', object: objM ? objM[1] : '', objectType: typeM ? typeM[1] : 'commit', tagText: text } as any);
  }
  return id;
}


async function inflateAt(buf: Buffer, off: number, expected: number): Promise<{ data: Buffer; consumed: number }> {
  const inflater = zlib.createInflate();
  inflater.end(buf.subarray(off));
  const chunks: Buffer[] = [];
  for await (const chunk of inflater) chunks.push(chunk as Buffer);
  const data = Buffer.concat(chunks);
  if (expected > 0 && data.length !== expected) throw new Error(`inflated ${data.length} bytes, expected ${expected}`);
  const available = Number((inflater as any)._writeState?.[1] ?? 0);
  return { data, consumed: buf.length - off - available };
}

function packObjectRecord(type: string, body: Buffer): Buffer {
  const typeNum = type === 'commit' ? 1 : type === 'tree' ? 2 : type === 'blob' ? 3 : type === 'tag' ? 4 : 4;
  let size = body.length;
  let first = (typeNum << 4) | (size & 0x0f);
  size >>= 4;
  const header: number[] = [];
  while (size) {
    header.push(first | 0x80);
    first = size & 0x7f;
    size >>= 7;
  }
  header.push(first);
  return Buffer.concat([Buffer.from(header), zlib.deflateSync(body)]);
}

function applyGitDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    while (p < delta.length) {
      const byte = delta[p++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta source size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let q = 0;
  while (p < delta.length) {
    const command = delta[p++];
    if (command & 0x80) {
      let offset = 0;
      let length = 0;
      if (command & 0x10) offset |= delta[p++] << 0;
      if (command & 0x20) offset |= delta[p++] << 8;
      if (command & 0x40) offset |= delta[p++] << 16;
      if (command & 0x01) length |= delta[p++] << 0;
      if (command & 0x02) length |= delta[p++] << 8;
      if (command & 0x04) length |= delta[p++] << 16;
      if (length === 0) length = 0x1000000;
      base.copy(out, q, offset, offset + length);
      q += length;
    } else {
      const length = command;
      delta.copy(out, q, p, p + length);
      p += length;
      q += length;
    }
  }
  if (q !== targetSize) throw new Error('delta target size mismatch');
  return out;
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



    // ---------- git smart HTTP ----------
    if (/^\/[^/]+\/[^/]+\.git(\/.*)?$/.test(path)) {
      const gm = /^\/([^/]+)\/([^/]+?)(?:\.git)?(\/.*)?$/.exec(path);
      const owner = gm[1]; const repoName = gm[2].replace(/\.git$/, ''); const gsub = gm[3] || '/';
      const gkey = `${owner}/${repoName}`;
      const gr = repos.get(gkey);
      const pkt = (payload: string | Buffer): Buffer => {
        const p = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
        const len = p.length + 4;
        return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), p]);
      };
      const FLUSH = Buffer.from('0000', 'ascii');
      const DELIM = Buffer.from('0001', 'ascii');
      const decodePkts = (buf: Buffer): Array<string | Buffer | 'flush' | 'delim'> => {
        const out: Array<string | Buffer | 'flush' | 'delim'> = [];
        let i = 0;
        while (i + 4 <= buf.length) {
          const hex = buf.subarray(i, i + 4).toString('ascii');
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
          const len = parseInt(hex, 16);
          if (len === 0) { out.push('flush'); i += 4; continue; }
          if (len === 1) { out.push('delim'); i += 4; continue; }
          if (len < 4 || i + len > buf.length) break;
          out.push(buf.subarray(i + 4, i + len));
          i += len;
        }
        return out;
      };
      const v2header = (): Buffer => pkt('version 2\n');
      const capsOf = (gr: any) => {
        const caps = ['agent=gitconf-forge/1.0', 'object-format=sha1'];
        return caps;
      };
      // advertisement
      if (gsub === '/info/refs') {
        if (!gr) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('repository not found'); return; }
        const service = String(q.get('service') ?? '');
        const protoV2 = String(req.headers['git-protocol'] ?? '').includes('version=2');
        const chunks: Buffer[] = [];
        if (service === 'git-upload-pack' && protoV2) {
          chunks.push(pkt('# service=git-upload-pack\n'), FLUSH, v2header());
          chunks.push(pkt(`agent=gitconf-forge/1.0\n`));
          chunks.push(pkt(`ls-refs=unborn\n`));
          chunks.push(pkt(`fetch=shallow filter\n`));
          chunks.push(pkt(`object-format=sha1\n`));
          chunks.push(FLUSH);
        } else if (service === 'git-upload-pack') {
          chunks.push(pkt(`# service=git-upload-pack\n`), FLUSH);
          const refs: Array<[string, string]> = [];
          for (const [name, sha] of gr.refs) refs.push([name, sha]);
          const head = gr.refs.get(`refs/heads/${gr.default_branch}`);
          if (head) refs.push(['HEAD', head]);
          if (!refs.length) refs.push(['capabilities^{}', '0'.repeat(40)]);
          refs.forEach(([name, sha], i) => {
            const caps = i === 0 ? '\u0000' + capsOf(gr).concat(['side-band-64k', 'ofs-delta', 'no-progress', 'report-status', 'report-status-v2', 'delete-refs', 'shallow', 'symref=HEAD:refs/heads/' + gr.default_branch]).join(' ') : '';
            chunks.push(pkt(`${sha} ${name}${caps}\n`));
          });
          chunks.push(FLUSH);
        } else if (service === 'git-receive-pack') {
          chunks.push(pkt(`# service=git-receive-pack\n`), FLUSH);
          const refs: Array<[string, string]> = [];
          for (const [name, sha] of gr.refs) refs.push([name, sha]);
          if (!refs.length) refs.push(['capabilities^{}', '0'.repeat(40)]);
          refs.forEach(([name, sha], i) => {
            const caps = i === 0 ? '\u0000' + capsOf(gr).concat(['report-status', 'report-status-v2', 'side-band-64k', 'delete-refs', 'atomic', 'quiet']).join(' ') : '';
            chunks.push(pkt(`${sha} ${name}${caps}\n`));
          });
          chunks.push(FLUSH);
        } else {
          res.writeHead(400, { 'content-type': 'text/plain' }); res.end('bad service'); return;
        }
        const body = Buffer.concat(chunks);
        res.writeHead(200, { 'content-type': `application/x-${service}-advertisement`, 'cache-control': 'no-cache' });
        res.end(body);
        return;
      }
      // POST upload-pack & receive-pack
      if (gsub === '/git-upload-pack' || gsub === '/git-receive-pack') {
        if (!gr) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('repository not found'); return; }
        const chunks2: Buffer[] = [];
        for await (const c of req) chunks2.push(c as Buffer);
        const body = Buffer.concat(chunks2);
        const packets = decodePkts(body);
        const protoV2 = String(req.headers['git-protocol'] ?? '').includes('version=2');
        if (gsub === '/git-upload-pack') {
          // first packet: command=ls-refs or command=fetch
          const first = String(packets[0] ?? '');
          const cmdMatch = /command=(\S+)/.exec(first);
          let cmd = cmdMatch ? cmdMatch[1] : '';
          if (!cmd && !protoV2) cmd = 'v0-fetch';
          if (cmd === 'ls-refs') {
                        let peel = false, symrefs = false;
            const prefixes: string[] = [];
            for (const p of packets.slice(1)) {
              if (p === 'flush' || p === 'delim') continue;
              const s = typeof p === 'string' ? p : (p as Buffer).toString('utf8');
              if (s.startsWith('peel')) peel = true;
              if (s.startsWith('symrefs')) symrefs = true;
              if (s.startsWith('ref-prefix ')) prefixes.push(s.slice('ref-prefix '.length).trim());
            }
            const matchPrefix = (name: string) => prefixes.length === 0 || prefixes.some(px => name.startsWith(px));
            const out: Buffer[] = [];
            for (const [name, sha] of gr.refs) {
              if (!matchPrefix(name)) continue;
              let peeled = '';
              if (peel) {
                let cur = sha;
                for (let hop = 0; hop < 10; hop++) {
                  const o2: any = store.get(cur);
                  if (!o2) break;
                  if (o2.type === 'tag') { cur = o2.object; } else break;
                }
                peeled = ` peeled:${cur}`;
              }
              out.push(pkt(`${sha} ${name}${peeled}\n`));
            }
            const head = gr.refs.get(`refs/heads/${gr.default_branch}`);
            if (head && matchPrefix('HEAD')) out.push(pkt(`${head} HEAD${symrefs ? ` symref-target:refs/heads/${gr.default_branch}` : ''}\n`));
            out.push(FLUSH);
            res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
            res.end(Buffer.concat(out));
            return;
          }
          if (cmd === 'fetch' || cmd === 'v0-fetch') {
            // collect wants; haves ignored (we send everything reachable)
            const wants: string[] = [];
            const haves: string[] = [];
            let depth: number | null = null;
            const shallowLines: string[] = [];
            for (const p of packets.slice(1)) {
              if (p === 'flush' || p === 'delim') continue;
              const s = typeof p === 'string' ? p : (p as Buffer).toString('utf8');
              if (s.startsWith('want ')) wants.push(s.slice(5).trim());
              if (s.startsWith('have ')) haves.push(s.slice(5).trim());
              if (s.startsWith('deepen ')) depth = Number(s.slice(7).trim());
              if (s.startsWith('shallow ')) shallowLines.push(s.slice(8).trim());
            }
            const clientHas = new Set<string>();
            const shallowSet = new Set<string>(shallowLines);
            const markHave = (oid: string, d: number) => {
              if (clientHas.has(oid)) return;
              clientHas.add(oid);
              const o2: any = store.get(oid);
              if (!o2) return;
              if (o2.type === 'commit') {
                markTree(o2.tree, d);
                if (shallowSet.has(oid)) return;
                if (depth != null && d >= depth) return;
                for (const p2 of o2.parents ?? []) markHave(p2, d + 1);
              }
            };
            const markTree = (tid: string, d: number) => {
              if (clientHas.has(tid)) return;
              clientHas.add(tid);
              const t2: any = store.get(tid);
              if (!t2 || t2.type !== 'tree') return;
              for (const e2 of t2.entries) {
                const o3: any = store.get(e2.sha);
                if (!o3) continue;
                if (o3.type === 'blob') clientHas.add(e2.sha);
                else if (o3.type === 'tree') markTree(e2.sha, d);
              }
            };
            for (const h2 of haves) markHave(h2, 0);
            // build pack: all reachable objects from wants (respect depth shallow cut)
            const sendObjs: Array<{ oid: string; type: string; body: Buffer }> = [];
            const seen = new Set<string>();
            const sendIfNew = (oid: string, type: string, raw: Buffer | undefined) => {
              if (clientHas.has(oid)) return;
              if (!seen.has(oid)) { seen.add(oid); if (raw) sendObjs.push({ oid, type, body: raw.subarray(raw.indexOf(0) + 1) }); }
            };
            const visit = (oid: string, d: number) => {
              if (seen.has(oid)) return;
              const o = store.get(oid) as Obj | undefined;
              const raw = gitRaw.get(oid);
              if (!o || !raw) { seen.add(oid); return; }
              if (o.type === 'commit' && depth != null && d >= depth) { seen.add(oid); return; }
              if (clientHas.has(oid)) { seen.add(oid); return; }
              sendIfNew(oid, o.type, raw);
              if (o.type === 'commit' && depth != null && ((o as any).parents ?? []).length && d + 1 >= depth) shallowLines.push(oid);
              if ((o as any).type === 'tag') { const tgt = (o as any).object; if (tgt) { const o4: any = store.get(tgt); const r4 = gitRaw.get(tgt); if (o4 && r4) sendIfNew(tgt, o4.type, r4); } }
              if (o.type === 'commit') {
                if (depth != null && d >= depth) return;
                for (const p of o.parents) visit(p, d + 1);
                const t = store.get(o.tree) as Tree | undefined;
                if (t) visitTree(o.tree, d);
              }
            };
            const visitTree = (tid: string, d: number) => {
              if (seen.has(tid)) return;
              const t = store.get(tid) as Tree | undefined;
              const tr = gitRaw.get(tid);
              if (!t || !tr) { seen.add(tid); return; }
              sendIfNew(tid, 'tree', tr);
              for (const e of t.entries) {
                const o = store.get(e.sha) as Obj | undefined;
                if (!o) continue;
                if (o.type === 'blob') {
                  sendIfNew(e.sha, 'blob', gitRaw.get(e.sha));
                } else if (o.type === 'tree') visitTree(e.sha, d);
              }
            };
                        for (const w of wants) {
              if (gr.refs.get('HEAD') !== w && ![...gr.refs.values()].includes(w) && !store.has(w)) continue;
              const c = store.get(w) as CommitObj | undefined;
              if (!c) continue;
              const plist = Array.isArray(c.parents) ? c.parents : [];
              const cw = gitRaw.get(w);
              sendIfNew(w, (c as any).type, cw);
              if (depth != null) {
                if (depth >= 1) { const t = store.get(c.tree) as Tree | undefined; if (t) visitTree(c.tree, 1); }
                if (plist.length) { if (depth === 1) shallowLines.push(w); else for (const p of plist) visit(p, 1); }
              } else {
                const t = store.get(c.tree) as Tree | undefined; if (t) visitTree(c.tree, 1);
                for (const p of plist) visit(p, 1);
              }
            }
            // pack
            const parts: Buffer[] = [];
            const header = Buffer.allocUnsafe(12);
            header.write('PACK', 0, 4, 'ascii'); header.writeUInt32BE(2, 4); header.writeUInt32BE(sendObjs.length, 8);
            parts.push(header);
            for (const ob of sendObjs) {
              let record = packObjectCache.get(ob.oid);
              if (!record) {
                record = packObjectRecord(ob.type, ob.body);
                packObjectCache.set(ob.oid, record);
              }
              parts.push(record);
            }
            const packBody = Buffer.concat(parts);
            const trailer = createHash('sha1').update(packBody).digest();
            const pack = Buffer.concat([packBody, trailer]);
            const out: Buffer[] = [];
            if (cmd === 'v0-fetch') {
              out.push(pkt('NAK\n'));
            } else if (cmd !== 'v0-fetch' && shallowLines.length) { out.push(pkt('shallow-info\n')); for (const s of shallowLines) out.push(pkt(`shallow ${s}\n`)); out.push(DELIM); }
            if (cmd !== 'v0-fetch') out.push(pkt('packfile\n'));
            // sideband 65519 max pkt
            const CH = 65515;
            for (let i = 0; i < pack.length; i += CH) out.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(i, i + CH)])));
            out.push(FLUSH);
            res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
            res.end(Buffer.concat(out));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
          res.end(FLUSH);
          return;
        }
        // receive-pack
        const cmds: Array<{ old: string; new: string; ref: string }> = [];
        let packStart = -1;
        let idx = 0;
        let sawFlush = false;
        for (const p of packets) {
          if (p === 'flush') { sawFlush = true; continue; }
          if (p === 'delim') continue;
          if (typeof p === 'string') { cmds.push({ old: '', new: '', ref: p }); continue; }
          const s = (p as Buffer).toString('utf8');
          const nul = s.indexOf('\u0000');
          const line = nul >= 0 ? s.slice(0, nul) : s;
          const m2 = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\u0000\s]+)\s*$/.exec(line);
          if (m2) cmds.push({ old: m2[1], new: m2[2], ref: m2[3] });
        }
        // packfile = after flush
        let packBuf: Buffer | null = null;
        let after = false; let acc: Buffer[] = [];
        let i2 = 0;
        // re-scan raw body to find flush position then pack
        {
          let pos = 0;
          while (pos + 4 <= body.length) {
            const hex = body.subarray(pos, pos + 4).toString('ascii');
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
            const len = parseInt(hex, 16);
            if (len === 0) { pos += 4; if (cmds.length) { packBuf = body.subarray(pos); } break; }
            if (len === 1) { pos += 4; continue; }
            pos += len;
          }
        }
        // apply pack
        const unpackErr: string[] = [];
        if (packBuf && packBuf.length > 20) {
          try {
            let p = 12;
            const count = packBuf.readUInt32BE(8);
            for (let n = 0; n < count; n++) {
              let b = packBuf[p]; p++;
              const typeNum = (b >> 4) & 7;
              let size = b & 0x0f; let shift = 4;
              while (b & 0x80) { b = packBuf[p]; p++; size |= (b & 0x7f) << shift; shift += 7; }
              if (typeNum === 6) { // ofs delta
                let c = packBuf[p]; p++;
                let off = c & 0x7f;
                while (c & 0x80) { c = packBuf[p]; p++; off = ((off + 1) << 7) | (c & 0x7f); }
                const inf0 = inflateAt(packBuf, p, 0);
                void inf0;
                unpackErr.push('ofs-delta-unsupported');
                continue;
              }
              const typeNames = ['', 'commit', 'tree', 'blob', 'tag', '', 'ofs-delta', 'ref-delta'];
              const tn = typeNames[typeNum];
              if (typeNum === 7) {
                const baseSha = packBuf.subarray(p, p + 20).toString('hex'); p += 20;
                void baseSha;
                unpackErr.push('ref-delta-unsupported');
                continue;
              }
              const inf = await inflateAt(packBuf, p, size); p += inf.consumed;
              const inflated = inf.data;
              const full = Buffer.concat([Buffer.from(`${tn} ${inflated.length}\0`, 'utf8'), inflated]);
              const oid = createHash('sha1').update(full).digest('hex');
              storeObjFromGit(tn, inflated, oid);
            }
          } catch (e: any) { unpackErr.push(String(e?.message ?? e)); }
        }
        // apply commands
        const report: Buffer[] = [];
        for (const c of cmds) {
          let ok = true; let reason = '';
          if (c.new === '0'.repeat(40)) {
            gr.refs.delete(c.ref);
          } else {
            const tip = gr.refs.get(c.ref) ?? '';
            const co = store.get(c.new) as any;
            if (!co) { ok = false; reason = 'missing objects'; }
            else if (c.old !== '0'.repeat(40)) {
              if (tip !== c.old) { ok = false; reason = 'non-fast-forward'; }
              else {
                // fast-forward only if tip is an ancestor of (or equal to) c.new
                let isFF = tip === c.new;
                const seenF = new Set<string>();
                const stack: string[] = (Array.isArray(co.parents) ? co.parents : []).slice();
                while (stack.length && !isFF) {
                  const p2 = stack.pop()!;
                  if (p2 === tip) { isFF = true; break; }
                  if (seenF.has(p2)) continue;
                  seenF.add(p2);
                  const po: any = store.get(p2);
                  if (po && Array.isArray(po.parents)) stack.push(...po.parents);
                }
                if (!isFF) { ok = false; reason = 'non-fast-forward'; }
                else gr.refs.set(c.ref, c.new);
              }
            } else gr.refs.set(c.ref, c.new);
          }
          report.push(pkt(ok ? `ok ${c.ref}\n` : `ng ${c.ref} ${reason || 'rejected'}\n`));
        }
        const firstCmd = cmds.length ? (packets[0] as Buffer) : Buffer.alloc(0);
        const capsStr = firstCmd.length ? (firstCmd.toString('utf8').split('\u0000')[1] ?? '') : '';
        let reportStream = Buffer.concat([pkt('unpack ok\n'), ...report, FLUSH]);
        if (capsStr.includes('side-band-64k')) {
          const sb: Buffer[] = [];
          const CH = 65515;
          for (let i = 0; i < reportStream.length; i += CH) sb.push(pkt(Buffer.concat([Buffer.from([1]), reportStream.subarray(i, i + CH)])));
          reportStream = Buffer.concat(sb);
        }
        res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
        res.end(reportStream);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
      return;
    }

    // ----- GraphQL endpoint -----
    if (path === '/api/graphql' || path === '/api/graphql/') {
      if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed: any;
      try { parsed = JSON.parse(raw); } catch { sendJson(res, 400, { message: 'invalid json' }); return; }
      const hasAuthGql = typeof req.headers['authorization'] === 'string' && req.headers['authorization'] !== '';
      const docs: any[] = Array.isArray(parsed) ? parsed : [parsed];
      if (!hasAuthGql) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
      const gqlLogin = login ?? 'octocat';
      const repoGlobalId = (key: string) => 'R_' + key.replace(/[^A-Za-z0-9_-]/g, '_');
      const issueGid = (key: string, n: number) => 'I_' + key.replace(/[^A-Za-z0-9_-]/g, '_') + '_' + n;
      const prGid = (key: string, n: number) => 'P_' + key.replace(/[^A-Za-z0-9_-]/g, '_') + '_' + n;
      const execOne = (doc: any): any => {
        const opName: string = String(doc.operationName ?? '');
        const vars: any = doc.variables ?? {};
        const q: string = String(doc.query ?? '');
        // detect operation name from query text if absent
        let name = opName;
        if (!name) {
          const m2 = /(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(q);
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
          let found: any = null; let fkey = '';
          for (const [k, r2] of repos) { if (repoGlobalId(k) === key) { found = r2; fkey = k; break; } }
          if (!found) return failField('Could not resolve to a node');
          found.issueSeq += 1;
          const n = found.issueSeq;
          found.issues.push({ number: n, title: String(vars.input?.title ?? ''), body: vars.input?.body ?? null, state: 'open', labels: [], comments: [] });
          return { data: { createIssue: { issue: { number: n, id: issueGid(fkey, n) } } } };
        }
        if (name === 'IssueClose') {
          let found: any = null; let fkey = '';
          for (const [k, r2] of repos) { if (issueGid(k, 0).split('_')[1] === String(vars.input?.issueId ?? '').split('_')[1]) { }
          }
          // simpler: scan all issues for gid match
          outer1: for (const [k, r2] of repos) { for (const i3 of r2.issues) { if (issueGid(k, i3.number) === String(vars.input?.issueId ?? '')) { found = r2; fkey = k; break outer1; } } }
          if (!found) return failField('Could not resolve to a node');
          const i3 = found.issues.find((x: any) => issueGid(fkey, x.number) === String(vars.input?.issueId ?? ''));
          if (i3) i3.state = 'closed';
          return { data: { closeIssue: { issue: i3 ? { number: i3.number, id: issueGid(fkey, i3.number), state: 'CLOSED' } : null } } };
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
          return { data: { repository: { pullRequest: { number: p3.number, files: { nodes: (p3.files ?? []).map((f3: any) => ({ path: typeof f3 === 'string' ? f3 : String(f3?.filename ?? f3?.path ?? '') })) } } } } };
        }
        if (name === 'PullRequestId') {
          const r2 = rep(String(vars.owner ?? ''), String(vars.name ?? ''));
          if (!r2) return failField('Could not resolve to a Repository');
          const p3 = r2.pulls.find((x: any) => x.number === Number(vars.number));
          if (!p3) return failField('Could not resolve to a PullRequest');
          return { data: { repository: { pullRequest: { id: prGid(`${vars.owner}/${vars.name}`, p3.number), number: p3.number } } } };
        }
        if (name === 'PullRequestCreate') {
          let found: any = null; let fkey = '';
          for (const [k, r2] of repos) { if (repoGlobalId(k) === String(vars.input?.repositoryId ?? '')) { found = r2; fkey = k; break; } }
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
          return { data: { createPullRequest: { pullRequest: { number: n, id: prGid(fkey, n), state: 'OPEN', headRefName: headRef, baseRefName: baseRef } } } };
        }
        if (name === 'MergePullRequest') {
          let found: any = null; let fkey = ''; let p3: any = null;
          for (const [k, r2] of repos) { const c = r2.pulls.find((x: any) => prGid(k, x.number) === String(vars.input?.pullRequestId ?? '')); if (c) { found = r2; fkey = k; p3 = c; break; } }
          if (!found || !p3) return failField('Could not resolve to a node');
          doMerge(found, p3);
          return { data: { mergePullRequest: { pullRequest: { number: p3.number, merged: p3.merged, state: p3.merged ? 'MERGED' : 'OPEN' } } } };
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
      const per = Math.min(30, Math.max(1, Number(q.get('per_page') ?? 30)));
      const page = Math.max(1, Number(q.get('page') ?? 1));
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
        out.push(commitJson(r, sha));
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
      sendJson(res, 200, commitJson(r, cM[1]));
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
        if (oldEntry && typeof body.sha === 'string' && body.sha !== oldEntry.sha) { sendJson(res, 409, { message: 'sha does not match' }); return; }
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
      const issue = (r.issues as any[])[Number(issM[1]) - 1];
      if (!issue || issue.number !== Number(issM[1])) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (method === 'GET') {
        (issue as any)._json = (issue as any)._json ?? JSON.stringify(issue);
        const text = (issue as any)._json + '\n';
        res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': String(++reqSeq) });
        res.end(text);
        return;
      }
      if (method === 'PATCH') {
        const body = parseJsonBody(await readBody(req));
        if (!body) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        (issue as any)._json = null;
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
      const headCommit = getObj(r.refs.get(`refs/heads/${headRef}`) ?? '') as CommitObj | undefined;
      const baseCommit = getObj(r.refs.get(`refs/heads/${baseRef}`) ?? '') as CommitObj | undefined;
      const hf = new Map<string, string>(); if (headCommit) walkTreeFlat(headCommit.tree, '', hf);
      const bf = new Map<string, string>(); if (baseCommit) walkTreeFlat(baseCommit.tree, '', bf);
      for (const [nm, sh] of hf) {
        const bsh = bf.get(nm);
        if (bsh !== sh) {
          const o = getObj(sh) as Blob | undefined;
          const before = bsh ? ((getObj(bsh) as Blob | undefined)?.data ?? '') : '';
          const after = o?.data ?? '';
          files.push({ filename: nm, status: bsh ? 'modified' : 'added', additions: after.split('\n').length, deletions: before.split('\n').length, changes: 0 });
        }
      }
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
        const bt = rootTree(r, pr.base_ref);
        const ht2 = rootTree(r, pr.head_ref);
        // merge base = nearest common ancestor commit
        const ancestry = (startSha: string) => {
          const set = new Set<string>();
          const st: string[] = [startSha];
          while (st.length) { const s = st.pop()!; if (!s || set.has(s)) continue; set.add(s); const c3: any = store.get(s); if (c3 && Array.isArray(c3.parents)) st.push(...c3.parents); }
          return set;
        };
        const baseSha2 = r.refs.get(`refs/heads/${pr.base_ref}`) ?? '';
        const headSha2 = r.refs.get(`refs/heads/${pr.head_ref}`) ?? '';
        const a1 = ancestry(baseSha2); const a2 = ancestry(headSha2);
        let mbSha = '';
        for (const s of a1) if (a2.has(s)) { mbSha = s; break; }
        const mbTree = mbSha ? rootTreeFromCommit(mbSha) : { entries: [] as any[] };
        const baseDiff = new Map((bt as Tree).entries.filter((e: any) => !((mbTree as Tree).entries.some((b: any) => b.name === e.name && b.sha === e.sha))).map((e: any) => [e.name, e.sha]));
        const headDiff = new Map((ht2 as Tree).entries.filter((e: any) => !((mbTree as Tree).entries.some((b: any) => b.name === e.name && b.sha === e.sha))).map((e: any) => [e.name, e.sha]));
        const isConflict = [...baseDiff.keys()].some(nm => headDiff.has(nm) && headDiff.get(nm) !== baseDiff.get(nm));
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
