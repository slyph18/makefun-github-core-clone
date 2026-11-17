import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { createHash } from "node:crypto";

type GitBlob = { type: "blob"; data: Buffer };
type GitTree = { type: "tree"; entries: TreeEntry[] };
type GitCommit = {
  type: "commit";
  tree: string;
  parents: string[];
  message: string;
  ts: number;
};
type GitObject = GitBlob | GitTree | GitCommit;
type TreeEntry = { mode: string; name: string; sha: string };

type IssueComment = {
  id: number;
  body: string;
  user: string;
  created_at: string;
  updated_at: string;
};

type Label = {
  id: number;
  name: string;
  color: string;
  created_at: string;
  updated_at: string;
};

type Issue = {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  author: string;
  comments: IssueComment[];
  labels: number[];
};

type PullRequest = {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  headRefName: string;
  baseRefName: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  author: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged: boolean;
  merged_at: string | null;
  merge_sha: string | null;
  merge_commit_sha: string | null;
  conflicted: boolean;
  files: string[];
};

type Repository = {
  id: number;
  owner: string;
  ownerId: number;
  name: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  objects: Map<string, GitObject>;
  branches: Map<string, string>;
  issues: Issue[];
  pulls: PullRequest[];
  labels: Label[];
};

const TOKENS = new Map<string, string>([["tok", "adaiversen"]]);
const REPOS = new Map<string, Repository>();
let requestIdCounter = 0;
let repositoryIdCounter = 0;
let labelIdCounter = 0;

const viewerToken = process.env.MAKEFUN_SHOP_TOKEN || "tok";
TOKENS.set(viewerToken, "adaiversen");

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  requestIdCounter += 1;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-github-request-id": String(requestIdCounter),
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendNoContent(res: ServerResponse): void {
  requestIdCounter += 1;
  res.writeHead(204, {
    "x-github-request-id": String(requestIdCounter),
  });
  res.end();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const body = await readBody(req);
  if (!body.trim()) return null;
  return JSON.parse(body) as Record<string, unknown>;
}

function authenticate(req: IncomingMessage): string | null {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header) || /^token\s+(.+)$/i.exec(header);
  if (!match) return null;
  return TOKENS.get(match[1].trim()) || null;
}

function parseIntInput(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function repositoryKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

function createRepository(owner: string, name: string, options: {
  private?: boolean;
  description?: string | null;
} = {}): Repository {
  const timestamp = nowIso();
  repositoryIdCounter += 1;
  const repo: Repository = {
    id: repositoryIdCounter,
    owner,
    ownerId: 1,
    name,
    private: Boolean(options.private),
    description: options.description ?? null,
    defaultBranch: "main",
    created_at: timestamp,
    updated_at: timestamp,
    pushed_at: timestamp,
    objects: new Map(),
    branches: new Map(),
    issues: [],
    pulls: [],
    labels: [],
  };
  const emptyTree = putObj(repo, { type: "tree", entries: [] }).sha;
  const commitSha = commitTree(repo, emptyTree, [], `Initial commit for ${owner}/${name}`);
  repo.branches.set(repo.defaultBranch, commitSha);
  REPOS.set(repositoryKey(owner, name), repo);
  return repo;
}

function findRepository(owner: string, name: string): Repository | undefined {
  return REPOS.get(repositoryKey(owner, name));
}

function repoJson(repo: Repository) {
  const timestamp = nowIso();
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    private: repo.private,
    owner: { login: repo.owner, id: repo.ownerId, type: "User" },
    description: repo.description,
    default_branch: repo.defaultBranch,
    full_name: `${repo.owner}/${repo.name}`,
    html_url: `https://example.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.created_at,
    updated_at: timestamp,
    pushed_at: timestamp,
  };
}

function repoGlobalId(repo: Repository): string {
  return `R_${repo.owner}_${repo.name}`;
}

function parseRepositoryGlobalId(value: unknown): Repository | undefined {
  const match = /^R_([^_]+)_(.+)$/.exec(String(value ?? ""));
  return match ? findRepository(match[1], match[2]) : undefined;
}

function putObj(repo: Repository, object: GitObject): { sha: string } {
  let serialized: Buffer;
  if (object.type === "blob") {
    serialized = object.data;
  } else if (object.type === "tree") {
    serialized = Buffer.from(
      object.entries
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => `${entry.mode} ${entry.name}\0${entry.sha}`)
        .join("\n"),
      "utf8",
    );
  } else {
    serialized = Buffer.from(JSON.stringify([object.tree, object.parents, object.message, object.ts]), "utf8");
  }
  const sha = createHash("sha1").update(serialized).digest("hex");
  repo.objects.set(sha, object);
  return { sha };
}

function getObject(repo: Repository, sha: string): GitObject | undefined {
  return repo.objects.get(sha);
}

function commitTree(repo: Repository, treeSha: string, parents: string[], message: string): string {
  const commit: GitCommit = {
    type: "commit",
    tree: treeSha,
    parents,
    message,
    ts: Date.now(),
  };
  return putObj(repo, commit).sha;
}

function rootTree(repo: Repository, ref: string): GitTree {
  const commitSha = repo.branches.get(ref) || ref;
  const commit = getObject(repo, commitSha);
  if (!commit || commit.type !== "commit") throw new Error("invalid ref");
  const tree = getObject(repo, commit.tree);
  if (!tree || tree.type !== "tree") throw new Error("invalid tree");
  return tree;
}

function rootTreeSha(repo: Repository, ref: string): string {
  const commitSha = repo.branches.get(ref) || ref;
  const commit = getObject(repo, commitSha);
  if (!commit || commit.type !== "commit") throw new Error("invalid ref");
  return commit.tree;
}

function rootEntries(repo: Repository, ref: string): TreeEntry[] {
  return flattenTree(repo, rootTreeSha(repo, ref));
}

function flattenTree(repo: Repository, treeSha: string, prefix = "", output: TreeEntry[] = []): TreeEntry[] {
  const object = getObject(repo, treeSha);
  if (!object || object.type !== "tree") return output;
  for (const entry of object.entries) {
    if (entry.mode === "40000") {
      flattenTree(repo, entry.sha, `${prefix}${entry.name}/`, output);
    } else {
      output.push({ ...entry, name: `${prefix}${entry.name}` });
    }
  }
  return output;
}

function diffFiles(repo: Repository, headSha: string, baseSha: string): string[] {
  const headCommit = getObject(repo, headSha);
  const baseCommit = getObject(repo, baseSha);
  if (!headCommit || headCommit.type !== "commit" || !baseCommit || baseCommit.type !== "commit") {
    return [];
  }
  const headFiles = flattenTree(repo, headCommit.tree);
  const baseFiles = flattenTree(repo, baseCommit.tree);
  const headMap = new Map(headFiles.map((entry) => [entry.name, entry.sha]));
  const baseMap = new Map(baseFiles.map((entry) => [entry.name, entry.sha]));
  const names = new Set<string>();
  for (const [name, sha] of headMap) if (baseMap.get(name) !== sha) names.add(name);
  for (const [name, sha] of baseMap) if (headMap.get(name) !== sha) names.add(name);
  return [...names].sort();
}

function hasTreeConflict(repo: Repository, headSha: string, baseSha: string): boolean {
  const headCommit = getObject(repo, headSha);
  const baseCommit = getObject(repo, baseSha);
  if (!headCommit || headCommit.type !== "commit" || !baseCommit || baseCommit.type !== "commit") return false;
  const headFiles = new Map(flattenTree(repo, headCommit.tree).map((entry) => [entry.name, entry.sha]));
  const baseFiles = new Map(flattenTree(repo, baseCommit.tree).map((entry) => [entry.name, entry.sha]));
  for (const [name, headFileSha] of headFiles) {
    const baseFileSha = baseFiles.get(name);
    if (baseFileSha && baseFileSha !== headFileSha) return true;
  }
  return false;
}

function createBlob(repo: Repository, data: Buffer): string {
  return putObj(repo, { type: "blob", data }).sha;
}

function createTree(repo: Repository, entries: TreeEntry[], baseTreeSha?: string): string {
  const baseEntries: Map<string, TreeEntry> = new Map();
  if (baseTreeSha) {
    for (const entry of flattenTree(repo, baseTreeSha)) baseEntries.set(entry.name, entry);
  }
  for (const entry of entries) {
    if (entry.sha === "") baseEntries.delete(entry.name);
    else baseEntries.set(entry.name, { mode: entry.mode || "100644", name: entry.name, sha: entry.sha });
  }
  return putObj(repo, { type: "tree", entries: [...baseEntries.values()] }).sha;
}

function updateRef(repo: Repository, branch: string, sha: string, force = true): boolean {
  const current = repo.branches.get(branch);
  if (!force && current) return false;
  repo.branches.set(branch, sha);
  return true;
}

function issueJson(repo: Repository, issue: Issue) {
  const labelObjects = issue.labels
    .map((labelId) => repo.labels.find((label) => label.id === labelId))
    .filter(Boolean)
    .map((label) => labelJson(label!));
  return {
    id: issue.id + 10000,
    node_id: issueGlobalId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toLowerCase(),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    user: { login: issue.author, id: 1, type: "User" },
    labels: labelObjects,
    comments: issue.comments.length,
    html_url: `https://example.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function issueGlobalId(repo: Repository, number: number): string {
  return `I_${repo.owner}_${repo.name}_${number}`;
}

function parseIssueGlobalId(value: unknown): { repo: Repository; issue?: Issue } | undefined {
  const match = /^I_([^_]+)_(.+)_(\d+)$/.exec(String(value ?? ""));
  if (!match) return undefined;
  const repo = findRepository(match[1], match[2]);
  if (!repo) return undefined;
  const number = Number(match[3]);
  return { repo, issue: repo.issues.find((candidate) => candidate.number === number) };
}

function pullRequestJson(repo: Repository, pull: PullRequest) {
  return {
    id: pull.id + 20000,
    node_id: pullGlobalId(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state.toLowerCase(),
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: !pull.conflicted && !pull.merged,
    mergeable_state: pull.conflicted ? "dirty" : pull.merged ? "merged" : "clean",
    conflicted: pull.conflicted,
    draft: false,
    user: { login: pull.author, id: 1, type: "User" },
    head: { ref: pull.headRefName, sha: pull.headSha, label: pull.headRefName, repo: repoJson(repo) },
    base: { ref: pull.baseRefName, sha: pull.baseSha, label: pull.baseRefName, repo: repoJson(repo) },
    labels: [] as unknown[],
    requested_reviewers: [] as unknown[],
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    html_url: `https://example.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function pullGlobalId(repo: Repository, number: number): string {
  return `P_${repo.owner}_${repo.name}_${number}`;
}

function parsePullGlobalId(value: unknown): { repo: Repository; pull?: PullRequest } | undefined {
  const match = /^P_([^_]+)_(.+?)_(\d+)$/.exec(String(value ?? ""));
  if (!match) return undefined;
  const repo = findRepository(match[1], match[2]);
  if (!repo) return undefined;
  const number = Number(match[3]);
  return { repo, pull: repo.pulls.find((candidate) => candidate.number === number) };
}

function labelJson(label: Label) {
  return {
    id: label.id,
    node_id: `L_${label.id}`,
    name: label.name,
    color: label.color,
    default: false,
    created_at: label.created_at,
    updated_at: label.updated_at,
    url: `/api/v3/repos/labels/${label.id}`,
  };
}

function commentJson(repo: Repository, issue: Issue, comment: IssueComment) {
  return {
    id: comment.id + 30000,
    node_id: `IC_${repo.owner}_${repo.name}_${issue.number}_${comment.id}`,
    body: comment.body,
    user: { login: comment.user, id: 1, type: "User" },
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    html_url: `https://example.com/${repo.owner}/${repo.name}/issues/${issue.number}#comment-${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id + 30000}`,
  };
}

function commitJson(repo: Repository, sha: string) {
  const commit = getObject(repo, sha);
  if (!commit || commit.type !== "commit") return null;
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      message: commit.message,
      author: { name: "adaiversen", email: "adaiversen@example.com", date: new Date(commit.ts).toISOString() },
      committer: { name: "adaiversen", email: "adaiversen@example.com", date: new Date(commit.ts).toISOString() },
      tree: { sha: commit.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
    },
    author: { login: "adaiversen", id: 1, type: "User" },
    committer: { login: "adaiversen", id: 1, type: "User" },
    parents: commit.parents.map((parent) => ({ sha: parent, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
    html_url: `https://example.com/${repo.owner}/${repo.name}/commit/${sha}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

function refJson(repo: Repository, branch: string) {
  const sha = repo.branches.get(branch);
  if (!sha) return null;
  return {
    ref: `refs/heads/${branch}`,
    node_id: `ref_${repo.owner}_${repo.name}_${branch}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/heads/${branch}`,
    object: { sha, type: "commit", url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
  };
}

function treeJson(repo: Repository, sha: string) {
  const tree = getObject(repo, sha);
  if (!tree || tree.type !== "tree") return null;
  return {
    sha,
    tree: tree.entries.map((entry) => {
      const child = getObject(repo, entry.sha);
      return {
        path: entry.name,
        mode: entry.mode,
        type: entry.mode === "40000" ? "tree" : "blob",
        sha: entry.sha,
        size: child?.type === "blob" ? child.data.length : 0,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${entry.mode === "40000" ? "trees" : "blobs"}/${entry.sha}`,
      };
    }),
    truncated: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${sha}`,
  };
}

function contentJson(repo: Repository, branch: string, entry: TreeEntry) {
  const object = getObject(repo, entry.sha);
  const data = object?.type === "blob" ? object.data : Buffer.alloc(0);
  const name = entry.name.split("/").at(-1) || entry.name;
  return {
    name,
    path: entry.name,
    sha: entry.sha,
    size: data.length,
    type: "file",
    encoding: "base64",
    content: data.toString("base64"),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${entry.name}?ref=${encodeURIComponent(branch)}`,
    html_url: `https://example.com/${repo.owner}/${repo.name}/blob/${branch}/${entry.name}`,
    download_url: `https://example.com/${repo.owner}/${repo.name}/raw/${branch}/${entry.name}`,
  };
}

function nextIssueNumber(repo: Repository): number {
  return repo.issues.reduce((max, issue) => Math.max(max, issue.number), 0) + 1;
}

function nextPullNumber(repo: Repository): number {
  return repo.pulls.reduce((max, pull) => Math.max(max, pull.number), 0) + 1;
}

function issueFromInput(repo: Repository, input: Record<string, unknown>, author: string): Issue {
  const timestamp = nowIso();
  const issue: Issue = {
    id: nextIssueNumber(repo),
    number: nextIssueNumber(repo),
    title: String(input.title ?? ""),
    body: String(input.body ?? ""),
    state: "OPEN",
    created_at: timestamp,
    updated_at: timestamp,
    closed_at: null,
    author,
    comments: [],
    labels: [],
  };
  repo.issues.push(issue);
  return issue;
}

function doMerge(repo: Repository, pull: PullRequest): boolean {
  if (pull.merged) return false;
  const baseCommit = getObject(repo, pull.baseSha);
  const headCommit = getObject(repo, pull.headSha);
  if (!baseCommit || baseCommit.type !== "commit" || !headCommit || headCommit.type !== "commit") {
    pull.conflicted = true;
    return false;
  }
  const headEntries = flattenTree(repo, headCommit.tree);
  const baseEntries = new Map(flattenTree(repo, baseCommit.tree).map((entry) => [entry.name, entry.sha]));
  if (hasTreeConflict(repo, pull.headSha, pull.baseSha)) {
    pull.conflicted = true;
    return false;
  }
  const mergedEntries: TreeEntry[] = [...baseEntries].map(([name, sha]) => ({ mode: "100644", name, sha }));
  const existing = new Set(mergedEntries.map((entry) => entry.name));
  for (const entry of headEntries) {
    if (!existing.has(entry.name)) mergedEntries.push(entry);
  }
  const treeSha = putObj(repo, { type: "tree", entries: mergedEntries }).sha;
  const mergeSha = commitTree(repo, treeSha, [pull.baseSha, pull.headSha], `Merge pull request #${pull.number} from ${pull.headRefName}`);
  updateRef(repo, pull.baseRefName, mergeSha);
  repo.pushed_at = nowIso();
  pull.merged = true;
  pull.merged_at = nowIso();
  pull.state = "CLOSED";
  pull.closed_at = pull.merged_at;
  pull.merge_sha = mergeSha;
  pull.merge_commit_sha = mergeSha;
  pull.conflicted = false;
  return true;
}

function issueNode(repo: Repository, issue: Issue) {
  return {
    id: issueGlobalId(repo, issue.number),
    databaseId: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    author: { login: issue.author },
    repository: {
      id: repoGlobalId(repo),
      databaseId: repo.id,
      name: repo.name,
      owner: { login: repo.owner },
    },
    labels: issue.labels
      .map((labelId) => repo.labels.find((label) => label.id === labelId))
      .filter(Boolean)
      .map((label) => ({ id: `L_${label!.id}`, name: label!.name, color: label!.color })),
    comments: { totalCount: issue.comments.length },
  };
}

function pullRequestNode(repo: Repository, pull: PullRequest) {
  return {
    id: pullGlobalId(repo, pull.number),
    databaseId: pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    conflicted: pull.conflicted,
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    closedAt: pull.closed_at,
    mergedAt: pull.merged_at,
    author: { login: pull.author },
    headRefName: pull.headRefName,
    baseRefName: pull.baseRefName,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    mergeable: !pull.conflicted,
    repository: {
      id: repoGlobalId(repo),
      databaseId: repo.id,
      name: repo.name,
      owner: { login: repo.owner },
    },
    files: { nodes: pull.files.map((path) => ({ path, additions: 1, deletions: 1, changedFiles: 1 })) },
  };
}

function repositoryNode(repo: Repository) {
  return {
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    owner: { login: repo.owner },
    viewerPermission: "WRITE",
    hasIssuesEnabled: true,
    defaultBranchRef: { name: repo.defaultBranch },
  };
}

function encodeCursor(number: number): string {
  return Buffer.from(`issue:${number}`, "utf8").toString("base64");
}

function decodeCursor(cursor: unknown): number | null {
  try {
    const decoded = Buffer.from(String(cursor ?? ""), "base64").toString("utf8");
    const match = /^issue:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function issuePage(repo: Repository, variables: Record<string, unknown>) {
  const first = parseIntInput(variables.first, 30);
  const after = decodeCursor(variables.after);
  const sorted = [...repo.issues].sort((left, right) => right.number - left.number);
  const filtered = after === null ? sorted : sorted.filter((issue) => issue.number < after);
  const nodes = filtered.slice(0, Math.max(0, first));
  const hasNextPage = filtered.length > nodes.length;
  return {
    nodes: nodes.map((issue) => issueNode(repo, issue)),
    edges: nodes.map((issue) => ({ cursor: encodeCursor(issue.number), node: issueNode(repo, issue) })),
    pageInfo: {
      hasNextPage,
      hasPreviousPage: false,
      endCursor: nodes.length ? encodeCursor(nodes.at(-1)!.number) : null,
      startCursor: nodes.length ? encodeCursor(nodes[0].number) : null,
    },
    totalCount: repo.issues.length,
  };
}

function operationDefinitions(document: string): Map<string, string> {
  const operations = new Map<string, string>();
  const pattern = /(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let match = pattern.exec(document);
  while (match) {
    const start = document.indexOf("{", match.index + match[0].length);
    if (start === -1) break;
    let depth = 0;
    let end = start;
    let insideString = false;
    let escaped = false;
    for (end = start; end < document.length; end += 1) {
      const character = document[end];
      if (insideString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') insideString = false;
        continue;
      }
      if (character === '"') insideString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    if (depth === 0) operations.set(match[1], document.slice(start, end));
    match = pattern.exec(document);
  }
  return operations;
}

function fragmentText(document: string, name: string): string {
  const pattern = new RegExp(`fragment\\s+${name}\\s+on\\s+[A-Za-z_][A-Za-z0-9_]*\\s*\\{`);
  const match = pattern.exec(document);
  if (!match) return "";
  const start = match.index + match[0].length - 1;
  let depth = 0;
  let insideString = false;
  let escaped = false;
  for (let index = start; index < document.length; index += 1) {
    const character = document[index];
    if (insideString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') insideString = false;
      continue;
    }
    if (character === '"') insideString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return document.slice(start, index + 1);
    }
  }
  return "";
}

function graphqlErrors(message: string) {
  return [{ message, path: undefined, extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }];
}

async function executeGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const viewer = authenticate(req);
  if (!viewer) {
    sendJson(res, 401, { message: "Requires authentication" });
    return;
  }
  let payload: Record<string, unknown>;
  try {
    payload = (await parseJsonBody(req)) || {};
  } catch {
    sendJson(res, 400, { message: "Problems parsing JSON" });
    return;
  }
  const query = String(payload.query ?? "");
  const variables = (payload.variables as Record<string, unknown> | undefined) || {};
  const operationName = payload.operationName ? String(payload.operationName) : undefined;
  const definitions = operationDefinitions(query);
  const selectedName = operationName && definitions.has(operationName)
    ? operationName
    : [...definitions.keys()][0];
  const body = selectedName ? definitions.get(selectedName)! : query;
  let data: Record<string, unknown> | null = null;
  let errors: ReturnType<typeof graphqlErrors> | undefined;

  switch (selectedName) {
    case "ViewerLogin":
      data = { viewer: { login: viewer } };
      break;
    case "Issue_fields":
      data = {};
      break;
    case "PullRequestAndRepositoryFields":
      data = {};
      break;
    case "SearchType_enumValues": {
      data = {
        __type: {
          enumValues: [
            { name: "ISSUE" },
            { name: "PULL_REQUEST" },
            { name: "REPOSITORY" },
            { name: "USER" },
          ],
        },
      };
      break;
    }
    case "RepositoryFields": {
      const repo = parseRepositoryGlobalId(variables.id) || [...REPOS.values()][0];
      data = repo ? { repository: repositoryNode(repo) } : null;
      if (!repo) errors = graphqlErrors("Repository not found");
      break;
    }
    case "OpenIssues": {
      const repo = findRepository(String(variables.owner ?? ""), String(variables.name ?? ""));
      const first = parseIntInput(variables.first, 10);
      const issues = repo
        ? [...repo.issues]
            .filter((issue) => issue.state === "OPEN")
            .sort((left, right) => right.number - left.number)
            .slice(0, Math.max(0, first))
            .map((issue) => issueNode(repo, issue))
        : [];
      data = repo ? { repository: { issues: { nodes: issues, totalCount: issues.length } } } : null;
      break;
    }
    case "IssueByNumber": {
      const repo = findRepository(String(variables.owner ?? ""), String(variables.name ?? ""));
      const number = parseIntInput(variables.number, 0);
      const issue = repo?.issues.find((candidate) => candidate.number === number);
      data = repo && issue ? { repository: { issue: issueNode(repo, issue) } } : null;
      break;
    }
    case "IssuesPage": {
      const repo = findRepository(String(variables.owner ?? ""), String(variables.name ?? ""));
      data = repo ? { repository: { issues: issuePage(repo, variables) } } : null;
      break;
    }
    case "IssueCreate": {
      const input = (variables.input as Record<string, unknown> | undefined) || {};
      const repo = parseRepositoryGlobalId(input.repositoryId);
      if (!repo) errors = graphqlErrors("Repository not found");
      else {
        const issue = issueFromInput(repo, input, viewer);
        repo.updated_at = nowIso();
        data = { createIssue: { issue: issueNode(repo, issue) } };
      }
      break;
    }
    case "IssueClose": {
      const input = (variables.input as Record<string, unknown> | undefined) || {};
      const parsed = parseIssueGlobalId(input.issueId);
      if (!parsed?.issue) errors = graphqlErrors("Issue not found");
      else {
        parsed.issue.state = "CLOSED";
        parsed.issue.closed_at = nowIso();
        parsed.issue.updated_at = nowIso();
        data = { closeIssue: { issue: issueNode(parsed.repo, parsed.issue) } };
      }
      break;
    }
    case "PullRequests": {
      const repo = findRepository(String(variables.owner ?? ""), String(variables.name ?? ""));
      const pulls = repo
        ? [...repo.pulls]
            .sort((left, right) => right.number - left.number)
            .map((pull) => pullRequestNode(repo, pull))
        : [];
      data = repo ? { repository: { pullRequests: { nodes: pulls, totalCount: pulls.length } } } : null;
      break;
    }
    case "PullRequestById": {
      const input = (variables.input as Record<string, unknown> | undefined) || {};
      const parsed = parsePullGlobalId(input.pullRequestId);
      data = parsed?.pull ? { node: pullRequestNode(parsed.repo, parsed.pull) } : null;
      if (!parsed?.pull) errors = graphqlErrors("Pull request not found");
      break;
    }
    case "PullRequestCreate": {
      const input = (variables.input as Record<string, unknown> | undefined) || {};
      const repo = parseRepositoryGlobalId(input.repositoryId);
      const headRefName = String(input.headRefName ?? "");
      const baseRefName = String(input.baseRefName ?? repo?.defaultBranch ?? "");
      const baseSha = repo?.branches.get(baseRefName);
      const headSha = repo?.branches.get(headRefName);
      if (!repo || !baseSha || !headSha) {
        errors = graphqlErrors("Repository or branch not found");
        break;
      }
      const timestamp = nowIso();
      const number = nextPullNumber(repo);
      const pull: PullRequest = {
        id: number,
        number,
        title: String(input.title ?? `Merge ${headRefName} into ${baseRefName}`),
        body: String(input.body ?? ""),
        state: "OPEN",
        headRefName,
        baseRefName,
        headSha,
        baseSha,
        mergeBaseSha: baseSha,
        author: viewer,
        created_at: timestamp,
        updated_at: timestamp,
        closed_at: null,
        merged: false,
        merged_at: null,
        merge_sha: null,
        merge_commit_sha: null,
        conflicted: hasTreeConflict(repo, headSha, baseSha),
        files: diffFiles(repo, headSha, baseSha),
      };
      repo.pulls.push(pull);
      data = { createPullRequest: { pullRequest: pullRequestNode(repo, pull) } };
      break;
    }
    case "MergePullRequest": {
      const input = (variables.input as Record<string, unknown> | undefined) || {};
      const parsed = parsePullGlobalId(input.pullRequestId);
      if (!parsed?.pull) {
        errors = graphqlErrors("Pull request not found");
        break;
      }
      const merged = doMerge(parsed.repo, parsed.pull);
      if (!merged && parsed.pull.conflicted) errors = graphqlErrors("Pull request has conflicts");
      else if (!merged) errors = graphqlErrors("Pull request was already merged");
      else data = { mergePullRequest: { pullRequest: pullRequestNode(parsed.repo, parsed.pull) } };
      break;
    }
    case "NodeRepository": {
      const input = (variables.input as Record<string, unknown> | undefined) || {};
      const repo = parseRepositoryGlobalId(input.id ?? variables.id);
      data = repo ? { node: repositoryNode(repo) } : null;
      if (!repo) errors = graphqlErrors("Repository not found");
      break;
    }
    case "ViewerInvalidField": {
      data = { viewer: { login: viewer } };
      errors = graphqlErrors("Cannot query field");
      break;
    }
    default:
      data = null;
      errors = graphqlErrors("Unsupported operation");
  }

  void fragmentText;
  sendJson(res, 200, { data, ...(errors ? { errors } : {}) });
}

type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  viewer: string;
  method: string;
  segments: string[];
  url: URL;
};

async function handleRepositoryRoute(context: RouteContext, owner: string, name: string): Promise<void> {
  const { req, res, method, segments, viewer } = context;
  const repo = findRepository(owner, name);
  if (!repo) {
    sendJson(res, 404, { message: "Not Found" });
    return;
  }
  const [resource, argument, leaf] = segments;
  let body: Record<string, unknown> | null = null;
  if (method !== "GET" && method !== "HEAD") {
    try {
      body = await parseJsonBody(req);
    } catch {
      sendJson(res, 400, { message: "Problems parsing JSON" });
      return;
    }
  }

  if (!resource) {
    if (method === "GET") sendJson(res, 200, repoJson(repo));
    else if (method === "PATCH") {
      if (body && Object.hasOwn(body, "description")) repo.description = body.description === null ? null : String(body.description);
      if (body && Object.hasOwn(body, "private")) repo.private = Boolean(body.private);
      repo.updated_at = nowIso();
      sendJson(res, 200, repoJson(repo));
    } else if (method === "DELETE") {
      REPOS.delete(repositoryKey(owner, name));
      sendNoContent(res);
    } else sendJson(res, 404, { message: "Not Found" });
    return;
  }

  if (resource === "branches" && method === "GET" && !argument) {
    sendJson(res, 200, [...repo.branches.entries()].map(([branch, sha]) => ({
      name: branch,
      commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
      protected: false,
    })));
    return;
  }

  if (resource === "contents") {
    console.log("CONTENTS DEBUG", method, segments, body);
    const path = segments.slice(1).map(decodeURIComponent).join("/");
    const branch = context.url.searchParams.get("ref") || repo.defaultBranch;
    if (method === "GET") {
      const entries = rootEntries(repo, branch);
      const entry = entries.find((candidate) => candidate.name === path);
      if (!entry) sendJson(res, 404, { message: "Not Found" });
      else sendJson(res, 200, contentJson(repo, branch, entry));
      return;
    }
    if (method === "PUT" && body) {
      try {
        const content = Buffer.from(String(body.content ?? ""), "base64");
        const blobSha = createBlob(repo, content);
        const treeSha = createTree(repo, [{ mode: "100644", name: path, sha: blobSha }], rootTreeSha(repo, branch));
        const parentSha = repo.branches.get(branch)!;
        const commitSha = commitTree(repo, treeSha, [parentSha], String(body.message ?? ""));
        updateRef(repo, branch, commitSha);
        repo.pushed_at = nowIso();
        sendJson(res, 200, {
          content: contentJson(repo, branch, { mode: "100644", name: path, sha: blobSha }),
          commit: commitJson(repo, commitSha),
        });
      } catch {
        console.error("PUT CONTENTS FAILURE", error);
        sendJson(res, 404, { message: "Not Found" });
      }
      return;
    }
    if (method === "DELETE" && body) {
      try {
        const entries = rootEntries(repo, branch);
        const existing = entries.find((entry) => entry.name === path);
        if (!existing) {
          sendJson(res, 404, { message: "Not Found" });
          return;
        }
        const treeSha = createTree(repo, [{ mode: "100644", name: path, sha: "" }], rootTreeSha(repo, branch));
        const commitSha = commitTree(repo, treeSha, [repo.branches.get(branch)!], String(body.message ?? ""));
        updateRef(repo, branch, commitSha);
        sendJson(res, 200, { commit: commitJson(repo, commitSha) });
      } catch {
        sendJson(res, 404, { message: "Not Found" });
      }
      return;
    }
    sendJson(res, 404, { message: "Not Found" });
    return;
  }

  if (resource === "commits" && method === "GET") {
    if (argument) {
      const commit = commitJson(repo, argument);
      if (commit) sendJson(res, 200, commit);
      else sendJson(res, 404, { message: "Not Found" });
      return;
    }
    const branch = context.url.searchParams.get("sha") || repo.defaultBranch;
    let sha = repo.branches.get(branch) || branch;
    const commits: unknown[] = [];
    while (sha && commits.length < 30) {
      const json = commitJson(repo, sha);
      if (!json) break;
      commits.push(json);
      const object = getObject(repo, sha);
      sha = object?.type === "commit" ? object.parents[0] ?? "" : "";
    }
    sendJson(res, 200, commits);
    return;
  }

  if (resource === "git" && argument === "refs") {
    if (leaf === "heads" && segments.length > 4) {
      const branch = segments.slice(4).join("/");
      const ref = refJson(repo, branch);
      if (ref) {
        if (method === "GET") sendJson(res, 200, ref);
        else if (method === "PATCH" && body) {
          const sha = String(body.sha ?? "");
          if (!getObject(repo, sha) || getObject(repo, sha)!.type !== "commit") sendJson(res, 422, { message: "Object does not exist" });
          else {
            updateRef(repo, branch, sha, body.force !== false);
            repo.pushed_at = nowIso();
            sendJson(res, 200, refJson(repo, branch));
          }
        } else sendJson(res, 404, { message: "Not Found" });
      } else if (method === "PATCH" || method === "GET") sendJson(res, 404, { message: "Not Found" });
      return;
    }
    if (method === "POST" && body) {
      const refName = String(body.ref ?? "");
      const branch = refName.replace(/^refs\/heads\//, "");
      const sha = String(body.sha ?? "");
      if (!branch || repo.branches.has(branch) || getObject(repo, sha)?.type !== "commit") {
        sendJson(res, 422, { message: "Reference already exists" });
        return;
      }
      updateRef(repo, branch, sha);
      sendJson(res, 201, refJson(repo, branch));
      return;
    }
    if (method === "GET") {
      sendJson(res, 200, [...repo.branches.keys()].map(refJson.bind(null, repo)).filter(Boolean));
      return;
    }
  }

  if (resource === "git" && argument === "trees") {
    if (method === "GET" && leaf) {
      const tree = treeJson(repo, leaf);
      if (tree) sendJson(res, 200, tree);
      else sendJson(res, 404, { message: "Not Found" });
      return;
    }
    if (method === "POST" && body) {
      const baseTree = body.base_tree ? String(body.base_tree) : undefined;
      const inputTree = Array.isArray(body.tree) ? body.tree as Record<string, unknown>[] : [];
      const entries = inputTree.map((item) => ({
        mode: String(item.mode ?? "100644"),
        name: String(item.path ?? ""),
        sha: item.content ? createBlob(repo, Buffer.from(String(item.content), "utf8")) : String(item.sha ?? ""),
      }));
      const baseCommit = baseTree ? getObject(repo, baseTree) : undefined;
      const baseTreeSha = baseCommit?.type === "commit" ? baseCommit.tree : baseTree;
      const treeSha = createTree(repo, entries, baseTreeSha);
      const tree = treeJson(repo, treeSha);
      if (tree) sendJson(res, 201, tree);
      else sendJson(res, 404, { message: "Not Found" });
      return;
    }
  }

  if (resource === "pulls") {
    if (!argument && method === "GET") {
      sendJson(res, 200, repo.pulls.map((pull) => pullRequestJson(repo, pull)));
      return;
    }
    if (!argument && method === "POST" && body) {
      const head = String(body.head ?? "");
      const base = String(body.base ?? "");
      const baseSha = repo.branches.get(base);
      const headSha = repo.branches.get(head.replace(/^.*:/, ""));
      if (!baseSha || !headSha) {
        sendJson(res, 422, { message: "Validation Failed" });
        return;
      }
      const timestamp = nowIso();
      const number = nextPullNumber(repo);
      const pull: PullRequest = {
        id: number,
        number,
        title: String(body.title ?? ""),
        body: String(body.body ?? ""),
        state: "OPEN",
        headRefName: head,
        baseRefName: base,
        headSha,
        baseSha,
        mergeBaseSha: baseSha,
        author: viewer,
        created_at: timestamp,
        updated_at: timestamp,
        closed_at: null,
        merged: false,
        merged_at: null,
        merge_sha: null,
        merge_commit_sha: null,
        conflicted: hasTreeConflict(repo, headSha, baseSha),
        files: diffFiles(repo, headSha, baseSha),
      };
      repo.pulls.push(pull);
      sendJson(res, 201, pullRequestJson(repo, pull));
      return;
    }
    const number = parseIntInput(argument, 0);
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (!pull) {
      sendJson(res, 404, { message: "Not Found" });
      return;
    }
    if (leaf === "files" && method === "GET") {
      const files = diffFiles(repo, pull.headSha, pull.baseSha).map((filename) => ({
        sha: filename,
        filename,
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        blob_url: `https://example.com/${repo.owner}/${repo.name}/blob/${pull.baseRefName}/${filename}`,
        raw_url: `https://example.com/${repo.owner}/${repo.name}/raw/${pull.baseRefName}/${filename}`,
        contents_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${filename}?ref=${pull.baseRefName}`,
      }));
      sendJson(res, 200, files);
      return;
    }
    if (leaf === "merge" && method === "PUT") {
      if (pull.merged) sendJson(res, 405, { message: "Pull Request is not mergeable" });
      else if (pull.conflicted) sendJson(res, 405, { message: "Pull Request is not mergeable" });
      else if (doMerge(repo, pull)) {
        sendJson(res, 200, {
          sha: pull.merge_commit_sha,
          merged: true,
          message: "Pull Request successfully merged",
        });
      } else sendJson(res, 405, { message: "Pull Request is not mergeable" });
      return;
    }
    if (!leaf && method === "GET") sendJson(res, 200, pullRequestJson(repo, pull));
    else sendJson(res, 404, { message: "Not Found" });
    return;
  }

  if (resource === "issues") {
    if (!argument && method === "GET") {
      const state = (context.url.searchParams.get("state") || "open").toLowerCase();
      sendJson(res, 200, repo.issues
        .filter((issue) => issue.state.toLowerCase() === state || state === "all")
        .map((issue) => issueJson(repo, issue)));
      return;
    }
    if (!argument && method === "POST" && body) {
      const issue = issueFromInput(repo, { ...body, labels: [] }, viewer);
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    const number = parseIntInput(argument, 0);
    const issue = repo.issues.find((candidate) => candidate.number === number);
    if (!issue) {
      sendJson(res, 404, { message: "Not Found" });
      return;
    }
    if (leaf === "comments") {
      if (method === "GET") sendJson(res, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
      else if (method === "POST" && body) {
        const comment: IssueComment = {
          id: issue.comments.length + 1,
          body: String(body.body ?? ""),
          user: viewer,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        issue.comments.push(comment);
        issue.updated_at = nowIso();
        sendJson(res, 201, commentJson(repo, issue, comment));
      } else sendJson(res, 404, { message: "Not Found" });
      return;
    }
    if (!leaf && method === "GET") sendJson(res, 200, issueJson(repo, issue));
    else if (!leaf && method === "PATCH" && body) {
      if (body.state === "close" || body.state === "closed") {
        issue.state = "CLOSED";
        issue.closed_at = nowIso();
      }
      if (body.title !== undefined) issue.title = String(body.title);
      if (body.body !== undefined) issue.body = String(body.body);
      issue.updated_at = nowIso();
      sendJson(res, 200, issueJson(repo, issue));
    } else sendJson(res, 404, { message: "Not Found" });
    return;
  }

  if (resource === "labels") {
    if (!argument && method === "GET") sendJson(res, 200, repo.labels.map(labelJson));
    else if (!argument && method === "POST" && body) {
      labelIdCounter += 1;
      const label: Label = {
        id: labelIdCounter,
        name: String(body.name ?? ""),
        color: String(body.color ?? "ededed"),
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      repo.labels.push(label);
      sendJson(res, 201, labelJson(label));
      return;
    } else if (argument && method === "DELETE") {
      const index = repo.labels.findIndex((label) => label.name === decodeURIComponent(argument));
      if (index === -1) sendJson(res, 404, { message: "Not Found" });
      else {
        repo.labels.splice(index, 1);
        sendNoContent(res);
      }
      return;
    }
    sendJson(res, 404, { message: "Not Found" });
    return;
  }

  void leaf;
  sendJson(res, 404, { message: "Not Found" });
}

function handleUserRepos(context: RouteContext): void {
  const page = Math.max(1, parseIntInput(context.url.searchParams.get("page"), 1));
  const perPage = Math.min(100, Math.max(1, parseIntInput(context.url.searchParams.get("per_page"), 30)));
  const repositories = [...REPOS.values()];
  const start = (page - 1) * perPage;
  const result = repositories.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < repositories.length) {
    const nextUrl = `/api/v3/user/repos?page=${page + 1}&per_page=${perPage}`;
    headers.link = `<${nextUrl}>; rel="next"`;
  }
  sendJson(context.res, 200, result.map(repoJson), headers);
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;
  const method = (req.method || "GET").toUpperCase();
  console.log("ROUTE DEBUG", method, pathname, pathname.startsWith("/api/v3/"));
  if (pathname === "/healthz" && method === "GET") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (pathname === "/api/graphql" || pathname === "/api/graphql/") {
    await executeGraphQL(req, res);
    return;
  }
  if (!pathname.startsWith("/api/v3/") && pathname !== "/api/v3") {
    sendJson(res, 404, { message: "Not Found" });
    return;
  }
  const viewer = authenticate(req);
  if (!viewer) {
    sendJson(res, 401, { message: "Requires authentication" });
    return;
  }
  const segments = pathname.replace(/^\/api\/v3\/?/, "").split("/").filter(Boolean);
  const context: RouteContext = { req, res, viewer, method, segments, url };
  if (segments[0] === "meta" && method === "GET") {
    sendJson(res, 200, { installed_version: "1.0.0" });
    return;
  }
  if (segments[0] === "user") {
    if (segments.length === 1 && method === "GET") {
      sendJson(res, 200, { login: viewer, id: 1, type: "User" });
      return;
    }
    if (segments[1] === "repos" && method === "GET") {
      handleUserRepos(context);
      return;
    }
    if (segments[1] === "repos" && method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = (await parseJsonBody(req)) || {};
      } catch {
        sendJson(res, 400, { message: "Problems parsing JSON" });
        return;
      }
      const name = String(body.name ?? "");
      if (!name || findRepository(viewer, name)) {
        sendJson(res, 422, { message: "Validation Failed" });
        return;
      }
      const repo = createRepository(viewer, name, {
        private: Boolean(body.private),
        description: body.description === undefined || body.description === null ? null : String(body.description),
      });
      sendJson(res, 201, repoJson(repo));
      return;
    }
    sendJson(res, 404, { message: "Not Found" });
    return;
  }
  if (segments[0] === "repos" && segments.length >= 3) {
    await handleRepositoryRoute(context, segments[1], segments[2]);
    return;
  }
  sendJson(res, 404, { message: "Not Found" });
}

export function createApp(): Server {
  return createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: "Internal Server Error" });
      else res.end();
    });
  });
}
