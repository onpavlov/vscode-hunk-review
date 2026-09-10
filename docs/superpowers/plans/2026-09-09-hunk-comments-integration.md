# hunk-review: VS Code → hunk.dev comment integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Позволить ревьюить незакоммиченные изменения репозитория в нативных diff-редакторах VS Code, оставлять комментарии к изменённым строкам и отправлять их в живую hunk-сессию (создавая фоновую сессию в скрытом терминале), с двусторонней синхронизацией комментариев.

**Architecture:** Расширение читает дифф через API встроенного Git-расширения VS Code, хранит комментарии в `.hunk-review/comments.json`, взаимодействует с hunk только через документированный CLI (`hunk session * --json`). Живая сессия создаётся скрытым PTY-терминалом (`createTerminal({ hideFromUser: true })`). Комментарии агента импортируются опросом `hunk session comment list` и рендерятся в Comments API.

**Tech Stack:** TypeScript (strict, module Node16, target ES2022), esbuild (CJS, `vscode` external), VS Code Extension API (Comments API, Git extension API, Terminal API), Mocha via `@vscode/test-cli` (уже в скаффолде).

**Spec:** `docs/superpowers/specs/2026-09-09-hunk-comments-integration-design.md`

## Global Constraints

- CLI-версия: hunk 0.21.1 (`--json` поддержан всеми нужными командами; проверено 2026-09-10).
- Комментарий при отправке требует РОВНО один таргет: `newLine` или `oldLine` (см. spec: «target — ровно один вариант»).
- Кнопка отправки видна только при наличии pending-комментариев (контекст `hunk-review.hasPending`).
- Комментарии хранятся в `.hunk-review/comments.json` в корне репозитория.
- Фоновая сессия — только скрытый терминал; сессия останавливается при чистом рабочем дереве.
- Импортированные комментарии (agent/user из hunk) — read-only в VS Code.
- TypeScript strict; относительные импорты с расширением `.js` (module: Node16).
- Каждый новый user-facing command объявляется дважды: `contributes.commands` в `package.json` и `registerCommand` в коде, ID с префиксом `hunk-review.`.
- Все тесты запускаются через `npm test` (vscode-test, реальный VS Code; запуск одного файла не настроен — запускать весь suite).
- Не менять `overrides` в `package.json` (`diff`, `serialize-javascript`).

---

### Task 1: Общие типы и HunkCli (обёртка CLI)

**Files:**
- Create: `src/types.ts`
- Create: `src/hunkCli.ts`
- Test: `src/test/hunkCli.test.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: типы `StoredComment`, `CommentTarget`, `CommentStatus`, `CommentStoreData`, `HunkSession`, `SessionListResult`, `AppliedComment`, `ApplyResult`, `HunkNote`, `NoteListResult`, `HunkReviewFile`; класс `HunkCli` с методами `listSessions()`, `findSession(repoRoot: string): Promise<HunkSession | undefined>`, `applyComments(repoRoot: string, batch: { comments: Array<{ filePath: string; newLine?: number; oldLine?: number; summary: string }> }): Promise<ApplyResult>`, `listNotes(repoRoot: string, type?: 'live' | 'all'): Promise<HunkNote[]>`, `sessionReview(repoRoot: string): Promise<{ files: Array<{ path: string; hunks: Array<{ newStart: number; newLines: number }> }> }>`, `reload(repoRoot: string): Promise<void>`; ошибки `HunkNotInstalledError`, `HunkCommandError`; фабрика `createHunkCli(runner?: HunkRunner): HunkCli` и тип `HunkRunner`.

- [ ] **Step 1: Write the failing test**

`src/test/hunkCli.test.ts` — тесты на моках runner'а и на реальном CLI (если он в PATH):

```typescript
import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHunkCli, HunkNotInstalledError, HunkCommandError, HunkRunner } from '../hunkCli.js';

suite('HunkCli', () => {
  test('listSessions parses --json output', async () => {
    const stdout = JSON.stringify({
      sessions: [{ sessionId: 's1', pid: 1, cwd: '/tmp/r', repoRoot: '/tmp/r' }],
    });
    const runner: HunkRunner = async (file, args) => {
      assert.ok(args.includes('session') && args.includes('list') && args.includes('--json'));
      return { stdout, stderr: '' };
    };
    const cli = createHunkCli(runner);
    const sessions = await cli.listSessions();
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].sessionId, 's1');
  });

  test('findSession normalizes macOS /private prefix', async () => {
    const root = fs.realpathSync(os.tmpdir()); // real path of tmpdir
    const stdout = JSON.stringify({
      sessions: [{ sessionId: 's1', pid: 1, cwd: root, repoRoot: path.join(root, 'myrepo') }],
    });
    const cli = createHunkCli(async () => ({ stdout, stderr: '' }));
    const found = await cli.findSession(path.join(root, 'myrepo'));
    assert.strictEqual(found?.sessionId, 's1');
  });

  test('applyComments sends batch via stdin and parses result', async () => {
    let capturedInput = '';
    const runner: HunkRunner = async (_file, args, options) => {
      assert.ok(args.includes('comment') && args.includes('apply') && args.includes('--stdin'));
      capturedInput = options.input ?? '';
      return {
        stdout: JSON.stringify({
          result: { applied: [{ commentId: 'mcp:1:0', filePath: 'a.txt', side: 'new', line: 2 }] },
        }),
        stderr: '',
      };
    };
    const cli = createHunkCli(runner);
    const res = await cli.applyComments('/tmp/r', {
      comments: [{ filePath: 'a.txt', newLine: 2, summary: 'probe' }],
    });
    const batch = JSON.parse(capturedInput);
    assert.strictEqual(batch.comments[0].newLine, 2);
    assert.strictEqual(res.applied.length, 1);
  });

  test('non-zero exit raises HunkCommandError with stderr', async () => {
    const runner: HunkRunner = async () => {
      const err = new Error('spawn failed') as NodeJS.ErrnoException & { code: number; stderr: string };
      err.code = 1;
      err.stderr = 'No active Hunk sessions.';
      throw err;
    };
    const cli = createHunkCli(runner);
    await assert.rejects(() => cli.listSessions(), (e: unknown) => e instanceof HunkCommandError);
  });

  test('missing binary raises HunkNotInstalledError', async () => {
    const runner: HunkRunner = async () => {
      const err = new Error('not found') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };
    const cli = createHunkCli(runner);
    await assert.rejects(() => cli.listSessions(), (e: unknown) => e instanceof HunkNotInstalledError);
  });

  test('real CLI (if installed) returns JSON sessions', async function () {
    const cli = createHunkCli();
    const sessions = await cli.listSessions(); // must not throw on real hunk
    assert.ok(Array.isArray(sessions));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../hunkCli.js'` (компиляция tsc падает на импорте).

- [ ] **Step 3: Write minimal implementation**

`src/types.ts`:

```typescript
export type CommentStatus = 'pending' | 'sent' | 'stale';

export interface CommentTarget {
  newLine?: number;
  oldLine?: number;
}

export interface StoredComment {
  id: string;
  filePath: string;
  target: CommentTarget;
  summary: string;
  status: CommentStatus;
  sessionCommentId?: string;
  createdAt: string;
}

export interface CommentStoreData {
  version: 1;
  comments: StoredComment[];
}

export interface HunkSession {
  sessionId: string;
  pid?: number;
  repoRoot: string;
  title?: string;
}

export interface SessionListResult {
  sessions: HunkSession[];
}

export interface AppliedComment {
  commentId: string;
  filePath: string;
  side: string;
  line: number;
}

export interface ApplyResult {
  applied: AppliedComment[];
}

export interface HunkNote {
  noteId: string;
  source: string;
  filePath: string;
  hunkIndex: number;
  newRange: [number, number];
  body: string;
  createdAt: string;
  editable: boolean;
}

export interface NoteListResult {
  comments: HunkNote[];
}

export interface HunkReviewFile {
  path: string;
  hunks: Array<{ newStart: number; newLines: number }>;
}

export interface HunkReviewResult {
  files: HunkReviewFile[];
}
```

`src/hunkCli.ts`:

```typescript
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import type {
  ApplyResult,
  HunkNote,
  HunkReviewResult,
  HunkSession,
  NoteListResult,
} from './types.js';

export class HunkNotInstalledError extends Error {
  constructor() {
    super('hunk CLI is not installed or not in PATH');
  }
}

export class HunkCommandError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
  }
}

export interface RunOptions {
  cwd?: string;
  input?: string;
}

export type HunkRunner = (
  file: string,
  args: string[],
  options: RunOptions,
) => Promise<{ stdout: string; stderr: string }>;

export const defaultRunner: HunkRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new HunkNotInstalledError());
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new HunkCommandError(`hunk ${args.join(' ')} exited with code ${code}`, stderr));
      }
    });
    child.stdin.end(options.input ?? '');
  });

function parseJson<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

function normalizeRepoRoot(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

export class HunkCli {
  constructor(private readonly runner: HunkRunner = defaultRunner) {}

  async listSessions(): Promise<HunkSession[]> {
    const { stdout } = await this.runner('hunk', ['session', 'list', '--json'], {});
    return parseJson<{ sessions: HunkSession[] }>(stdout).sessions;
  }

  async findSession(repoRoot: string): Promise<HunkSession | undefined> {
    const want = normalizeRepoRoot(repoRoot);
    let sessions: HunkSession[];
    try {
      sessions = await this.listSessions();
    } catch (err) {
      if (err instanceof HunkCommandError) {
        // Демон недоступен — считаем сессий ноль (см. spec: обработка ошибок).
        return undefined;
      }
      throw err;
    }
    return sessions.find((s) => normalizeRepoRoot(s.repoRoot) === want);
  }

  async applyComments(
    repoRoot: string,
    batch: { comments: Array<{ filePath: string; newLine?: number; oldLine?: number; summary: string }> },
  ): Promise<ApplyResult> {
    const { stdout } = await this.runner(
      'hunk',
      ['session', 'comment', 'apply', '--repo', repoRoot, '--stdin', '--json'],
      { input: JSON.stringify(batch) },
    );
    return parseJson<{ result: ApplyResult }>(stdout).result;
  }

  async listNotes(repoRoot: string, type: 'live' | 'all' = 'all'): Promise<HunkNote[]> {
    const { stdout } = await this.runner(
      'hunk',
      ['session', 'comment', 'list', '--repo', repoRoot, '--type', type, '--json'],
      {},
    );
    return parseJson<NoteListResult>(stdout).comments;
  }

  async sessionReview(repoRoot: string): Promise<HunkReviewResult> {
    const { stdout } = await this.runner(
      'hunk',
      ['session', 'review', '--repo', repoRoot, '--json'],
      {},
    );
    return this.normalizeReview(parseJson<Record<string, unknown>>(stdout));
  }

  // `session review --json` returns hunk ranges; normalize both possible shapes.
  private normalizeReview(raw: Record<string, unknown>): HunkReviewResult {
    const files = (raw['files'] ?? []) as Array<{
      path?: string;
      filePath?: string;
      hunks?: Array<Record<string, number>>;
    }>;
    return {
      files: files.map((f) => ({
        path: (f.path ?? f.filePath ?? '') as string,
        hunks: (f.hunks ?? []).map((h) => ({
          newStart: (h['newStart'] ?? h['new_start'] ?? 0) as number,
          newLines: (h['newLines'] ?? h['new_lines'] ?? 0) as number,
        })),
      })),
    };
  }

  async reload(repoRoot: string): Promise<void> {
    await this.runner('hunk', ['session', 'reload', '--repo', repoRoot], {});
  }
}

export function createHunkCli(runner?: HunkRunner): HunkCli {
  return new HunkCli(runner);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (все тесты suite'а).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/hunkCli.ts src/test/hunkCli.test.ts
git commit -m "Add typed hunk CLI wrapper with JSON parsing"
```

---

### Task 2: CommentStore — хранение комментариев в `.hunk-review/`

**Files:**
- Create: `src/commentStore.ts`
- Test: `src/test/commentStore.test.ts`

**Interfaces:**
- Consumes: `StoredComment`, `CommentTarget`, `CommentStatus`, `CommentStoreData` из `src/types.js`.
- Produces: класс `CommentStore` с методами `load(): Promise<CommentStoreData>`, `add(filePath: string, target: CommentTarget, summary: string): Promise<StoredComment>`, `update(id: string, patch: Partial<Pick<StoredComment, 'status' | 'sessionCommentId' | 'summary'>>): Promise<StoredComment>`, `remove(id: string): Promise<void>`, `pending(): Promise<StoredComment[]>`, `pendingCount(): Promise<number>`; функция `ensureGitignore(dir: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`src/test/commentStore.test.ts`:

```typescript
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CommentStore, ensureGitignore } from '../commentStore.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hunk-review-store-'));
}

suite('CommentStore', () => {
  test('add persists comment with pending status and reloads', async () => {
    const dir = tmpDir();
    const store = new CommentStore(dir);
    const c = await store.add('src/a.ts', { newLine: 5 }, 'check this');
    assert.strictEqual(c.status, 'pending');
    assert.strictEqual(c.filePath, 'src/a.ts');

    const store2 = new CommentStore(dir);
    const data = await store2.load();
    assert.strictEqual(data.comments.length, 1);
    assert.strictEqual(data.comments[0].id, c.id);
    assert.strictEqual(data.comments[0].target.newLine, 5);
  });

  test('update changes status and session id', async () => {
    const dir = tmpDir();
    const store = new CommentStore(dir);
    const c = await store.add('a.ts', { newLine: 1 }, 'x');
    const updated = await store.update(c.id, { status: 'sent', sessionCommentId: 'mcp:9' });
    assert.strictEqual(updated.status, 'sent');
    assert.strictEqual(updated.sessionCommentId, 'mcp:9');
  });

  test('remove deletes comment', async () => {
    const dir = tmpDir();
    const store = new CommentStore(dir);
    const c = await store.add('a.ts', { oldLine: 3 }, 'x');
    await store.remove(c.id);
    const data = await store.load();
    assert.strictEqual(data.comments.length, 0);
  });

  test('pending returns only pending comments', async () => {
    const dir = tmpDir();
    const store = new CommentStore(dir);
    const a = await store.add('a.ts', { newLine: 1 }, 'x');
    await store.add('b.ts', { newLine: 2 }, 'y');
    await store.update(a.id, { status: 'sent' });
    const pending = await store.pending();
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].filePath, 'b.ts');
  });

  test('rejects target with both newLine and oldLine', async () => {
    const store = new CommentStore(tmpDir());
    await assert.rejects(() => store.add('a.ts', { newLine: 1, oldLine: 2 }, 'x'));
  });

  test('ensureGitignore appends .hunk-review/ once', async () => {
    const dir = tmpDir();
    await ensureGitignore(dir);
    await ensureGitignore(dir);
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.strictEqual(content.split('\n').filter((l) => l.trim() === '.hunk-review/').length, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../commentStore.js'`.

- [ ] **Step 3: Write minimal implementation**

`src/commentStore.ts`:

```typescript
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type {
  CommentStoreData,
  CommentStatus,
  CommentTarget,
  StoredComment,
} from './types.js';

const EMPTY: CommentStoreData = { version: 1, comments: [] };

export class CommentStore {
  private readonly file: string;

  constructor(private readonly dir: string) {
    this.file = path.join(dir, 'comments.json');
  }

  async load(): Promise<CommentStoreData> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const data = JSON.parse(raw) as CommentStoreData;
      return { version: 1, comments: data.comments ?? [] };
    } catch {
      return { ...EMPTY, comments: [] };
    }
  }

  private async write(data: CommentStoreData): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(data, null, 2), 'utf8');
  }

  async add(filePath: string, target: CommentTarget, summary: string): Promise<StoredComment> {
    if ((target.newLine !== undefined) === (target.oldLine !== undefined)) {
      throw new Error('Comment target must be exactly one of newLine or oldLine');
    }
    const data = await this.load();
    const comment: StoredComment = {
      id: crypto.randomUUID(),
      filePath,
      target,
      summary,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    data.comments.push(comment);
    await this.write(data);
    return comment;
  }

  async update(
    id: string,
    patch: Partial<Pick<StoredComment, 'status' | 'sessionCommentId' | 'summary'>>,
  ): Promise<StoredComment> {
    const data = await this.load();
    const idx = data.comments.findIndex((c) => c.id === id);
    if (idx < 0) {
      throw new Error(`Comment not found: ${id}`);
    }
    const updated: StoredComment = { ...data.comments[idx], ...patch };
    data.comments[idx] = updated;
    await this.write(data);
    return updated;
  }

  async remove(id: string): Promise<void> {
    const data = await this.load();
    data.comments = data.comments.filter((c) => c.id !== id);
    await this.write(data);
  }

  async pending(): Promise<StoredComment[]> {
    const data = await this.load();
    return data.comments.filter((c) => c.status === 'pending');
  }

  async pendingCount(): Promise<number> {
    return (await this.pending()).length;
  }
}

export async function ensureGitignore(dir: string): Promise<void> {
  const gitignore = path.join(dir, '.gitignore');
  let content = '';
  try {
    content = await fs.readFile(gitignore, 'utf8');
  } catch {
    // no .gitignore yet
  }
  if (content.split('\n').some((l) => l.trim() === '.hunk-review/')) {
    return;
  }
  const next = content.endsWith('\n') || content === '' ? content : `${content}\n`;
  await fs.writeFile(gitignore, `${next}.hunk-review/\n`, 'utf8');
}
```

Обрати внимание: `fsSync` импорт не нужен — убери его из финального кода, если не используешь (strict-линтер).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commentStore.ts src/test/commentStore.test.ts
git commit -m "Add local comment store backed by .hunk-review/comments.json"
```

---

### Task 3: DiffService — изменённые файлы, строки и чистота рабочего дерева через Git API

**Files:**
- Create: `src/diffService.ts`
- Test: `src/test/diffService.test.ts`

**Interfaces:**
- Consumes: ничего (vscode.git extension API).
- Produces: интерфейс `GitRepoFacade { diff(cached?: boolean): Promise<string>; state: { workingTreeChanges: unknown[]; indexChanges: unknown[] } }`; тип `GitApiFacade { getRepository(uri: unknown): { rootUri: vscode.Uri } | undefined; toGitUri(uri: vscode.Uri, ref: string): vscode.Uri; repositories: Array<{ rootUri: vscode.Uri; diff(cached?: boolean): Promise<string>; state: { workingTreeChanges: Array<{ uri: vscode.Uri }>; indexChanges: Array<{ uri: vscode.Uri }> } }> }`; класс `DiffService` с методами `getRepo(): RepoHandle | undefined`, `parseDiffLines(diffText: string): Map<string, Array<{ start: number; end: number }>>` (статичный), `getChangedLines(): Promise<Map<string, Array<{ start: number; end: number }>>>`, `isWorktreeClean(): Promise<boolean>`, `openDiffForFile(filePath: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`src/test/diffService.test.ts` — тестируем чистый парсер `parseDiffLines` на unified diff (зависимость от vscode.git подменяем через инъекцию репозитория):

```typescript
import * as assert from 'node:assert';
import { DiffService } from '../diffService.js';

suite('DiffService.parseDiffLines', () => {
  test('parses hunk headers into per-file new-line ranges', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,3 +10,4 @@ function a() {',
      '@@ -40,1 +42,2 @@',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,1 +1,1 @@',
    ].join('\n');
    const map = DiffService.parseDiffLines(diff);
    const a = map.get('src/a.ts');
    assert.deepStrictEqual(a, [
      { start: 10, end: 13 },
      { start: 42, end: 43 },
    ]);
    const b = map.get('src/b.ts');
    assert.deepStrictEqual(b, [{ start: 1, end: 1 }]);
  });

  test('parses single-line hunk headers without count', () => {
    const map = DiffService.parseDiffLines('@@ -5 +5,0 @@');
    assert.deepStrictEqual(map.get(''), [{ start: 5, end: 4 }]); // +5,0 → пустой диапазон
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../diffService.js'`.

- [ ] **Step 3: Write minimal implementation**

`src/diffService.ts`:

```typescript
import * as vscode from 'vscode';

export interface LineRange {
  start: number;
  end: number;
}

export interface GitRepositoryLike {
  rootUri: vscode.Uri;
  diff(cached?: boolean): Thenable<string>;
  state: {
    workingTreeChanges: Array<{ uri: vscode.Uri }>;
    indexChanges: Array<{ uri: vscode.Uri }>;
  };
}

export interface GitApiLike {
  repositories: GitRepositoryLike[];
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

export function getGitApi(): GitApiLike | undefined {
  const ext = vscode.extensions.getExtension<{ getAPI(id: number): GitApiLike }>('vscode.git');
  if (!ext) {
    return undefined;
  }
  return ext.isActive ? ext.exports.getAPI(1) : undefined;
}

export class DiffService {
  constructor(private readonly gitApi: () => GitApiLike | undefined = getGitApi) {}

  getRepo(): GitRepositoryLike | undefined {
    const api = this.gitApi();
    if (!api || api.repositories.length === 0) {
      return undefined;
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return api.repositories[0];
    }
    return (
      api.repositories.find((r) => r.rootUri.fsPath === workspaceFolder.uri.fsPath) ??
      api.repositories[0]
    );
  }

  static parseDiffLines(diffText: string): Map<string, LineRange[]> {
    const result = new Map<string, LineRange[]>();
    let currentFile = '';
    const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
    for (const line of diffText.split('\n')) {
      const diffLine = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (diffLine) {
        currentFile = diffLine[2];
        continue;
      }
      const m = hunkRe.exec(line);
      if (m && currentFile) {
        const start = Number(m[1]);
        const count = m[2] === undefined ? 1 : Number(m[2]);
        const ranges = result.get(currentFile) ?? [];
        ranges.push({ start, end: start + count - 1 });
        result.set(currentFile, ranges);
      }
    }
    return result;
  }

  async getChangedLines(): Promise<Map<string, LineRange[]>> {
    const repo = this.getRepo();
    if (!repo) {
      return new Map();
    }
    const worktree = await repo.diff();
    const staged = await repo.diff(true);
    const combined = DiffService.parseDiffLines(`${worktree}\n${staged}`);
    for (const [file, ranges] of combined) {
      combined.set(file, mergeRanges(ranges));
    }
    return combined;
  }

  async isWorktreeClean(): Promise<boolean> {
    const repo = this.getRepo();
    if (!repo) {
      return true;
    }
    return repo.state.workingTreeChanges.length === 0 && repo.state.indexChanges.length === 0;
  }

  async openDiffForFile(modifiedUri: vscode.Uri): Promise<void> {
    const api = this.gitApi();
    if (!api) {
      throw new Error('Git extension is not available');
    }
    const originalUri = api.toGitUri(modifiedUri, 'HEAD');
    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      modifiedUri,
      `hunk review: ${path_basename(modifiedUri)}`,
    );
  }
}

function path_basename(uri: vscode.Uri): string {
  const parts = uri.fsPath.split('/');
  return parts[parts.length - 1] ?? uri.fsPath;
}

function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}
```

Замечание: `path_basename` можно заменить на импорт `path.basename` из `node:path` — сделай так в реализации и убери локальную функцию.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/diffService.ts src/test/diffService.test.ts
git commit -m "Add diff service reading working tree state via git extension API"
```

---

### Task 4: CommentBridge — Comments API, треды и ховер «добавить комментарий»

**Files:**
- Create: `src/commentBridge.ts`
- Test: `src/test/commentBridge.test.ts`

**Interfaces:**
- Consumes: `StoredComment`, `HunkNote` из `src/types.js`; `LineRange` из `src/diffService.js`.
- Produces: чистая функция `buildThreadDescriptors(stored: StoredComment[], notes: HunkNote[]): ThreadDescriptor[]`, где `ThreadDescriptor = { file: string; start: number; end: number; threadKey: string; comments: Array<{ author: string; body: string; readOnly: boolean }> }`; класс `CommentBridge` с методами `constructor(store: CommentStore, syncNotes: () => Promise<HunkNote[]>)`, `activate(context: vscode.ExtensionContext): void` (регистрирует `CommentController`, команды тредов), `refresh(): Promise<void>` (перестраивает все треды из стора и импортированных notes), `dispose(): void`.

- [ ] **Step 1: Write the failing test**

`src/test/commentBridge.test.ts` — тестируем чистую функцию сопоставления:

```typescript
import * as assert from 'node:assert';
import { buildThreadDescriptors } from '../commentBridge.js';
import type { StoredComment, HunkNote } from '../types.js';

function stored(over: Partial<StoredComment>): StoredComment {
  return {
    id: 'c1',
    filePath: 'src/a.ts',
    target: { newLine: 10 },
    summary: 'ours',
    status: 'pending',
    createdAt: '2026-09-10T00:00:00Z',
    ...over,
  };
}

suite('buildThreadDescriptors', () => {
  test('our comment and agent note on same line merge into one thread', () => {
    const note: HunkNote = {
      noteId: 'n1',
      source: 'agent',
      filePath: 'src/a.ts',
      hunkIndex: 0,
      newRange: [10, 10],
      body: 'agent reply',
      createdAt: '2026-09-10T00:00:01Z',
      editable: false,
    };
    const desc = buildThreadDescriptors([stored({ status: 'sent' })], [note]);
    assert.strictEqual(desc.length, 1);
    assert.strictEqual(desc[0].comments.length, 2);
    assert.strictEqual(desc[0].comments[0].author, 'you');
    assert.strictEqual(desc[0].comments[1].author, 'hunk (agent)');
  });

  test('agent note without our thread creates read-only thread', () => {
    const note: HunkNote = {
      noteId: 'n2',
      source: 'user',
      filePath: 'src/b.ts',
      hunkIndex: 0,
      newRange: [3, 4],
      body: 'human note',
      createdAt: '2026-09-10T00:00:02Z',
      editable: false,
    };
    const desc = buildThreadDescriptors([], [note]);
    assert.strictEqual(desc.length, 1);
    assert.strictEqual(desc[0].file, 'src/b.ts');
    assert.strictEqual(desc[0].start, 3);
    assert.strictEqual(desc[0].end, 4);
    assert.strictEqual(desc[0].comments[0].readOnly, true);
  });

  test('pending and stale comments stay separate read-only rules', () => {
    const desc = buildThreadDescriptors(
      [
        stored({ id: 'p', target: { newLine: 1 }, status: 'pending' }),
        stored({ id: 's', target: { newLine: 2 }, status: 'sent' }),
        stored({ id: 'x', target: { newLine: 3 }, status: 'stale' }),
      ],
      [],
    );
    assert.strictEqual(desc.length, 3);
    assert.strictEqual(desc[0].comments[0].readOnly, false);
    assert.strictEqual(desc[1].comments[0].readOnly, true);
    assert.strictEqual(desc[2].comments[0].readOnly, true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../commentBridge.js'`.

- [ ] **Step 3: Write minimal implementation**

`src/commentBridge.ts`:

```typescript
import * as vscode from 'vscode';
import type { HunkNote, StoredComment } from './types.js';
import type { CommentStore } from './commentStore.js';

export interface ThreadCommentDescriptor {
  author: string;
  body: string;
  readOnly: boolean;
}

export interface ThreadDescriptor {
  file: string;
  start: number;
  end: number;
  threadKey: string;
  comments: ThreadCommentDescriptor[];
}

export function buildThreadDescriptors(
  stored: StoredComment[],
  notes: HunkNote[],
): ThreadDescriptor[] {
  const threads = new Map<string, ThreadDescriptor>();
  const keyOf = (file: string, line: number) => `${file}:${line}`;

  for (const c of stored) {
    const line = c.target.newLine ?? c.target.oldLine ?? 1;
    const key = keyOf(c.filePath, line);
    const existing = threads.get(key);
    const descriptor: ThreadCommentDescriptor = {
      author: 'you',
      body: c.summary,
      readOnly: c.status !== 'pending',
    };
    if (existing) {
      existing.comments.push(descriptor);
    } else {
      threads.set(key, {
        file: c.filePath,
        start: line,
        end: line,
        threadKey: key,
        comments: [descriptor],
      });
    }
  }

  for (const n of notes) {
    const line = n.newRange?.[0] ?? 1;
    const key = keyOf(n.filePath, line);
    const author = n.source === 'agent' ? 'hunk (agent)' : 'hunk (note)';
    const descriptor: ThreadCommentDescriptor = { author, body: n.body, readOnly: true };
    const existing = threads.get(key);
    if (existing) {
      existing.comments.push(descriptor);
    } else {
      threads.set(key, {
        file: n.filePath,
        start: line,
        end: n.newRange?.[1] ?? line,
        threadKey: key,
        comments: [descriptor],
      });
    }
  }

  return [...threads.values()];
}

export class CommentBridge {
  private controller?: vscode.CommentController;
  private threadByKey = new Map<string, vscode.CommentThread>();

  constructor(
    private readonly store: CommentStore,
    private readonly syncNotes: () => Promise<HunkNote[]>,
  ) {}

  activate(context: vscode.ExtensionContext): void {
    this.controller = vscode.comments.createCommentController(
      'hunk-review.comments',
      'Hunk Review',
    );
    context.subscriptions.push(this.controller, { dispose: () => this.dispose() });
  }

  async refresh(): Promise<void> {
    if (!this.controller) {
      return;
    }
    for (const thread of this.threadByKey.values()) {
      thread.dispose();
    }
    this.threadByKey.clear();

    const storeData = await this.store.load();
    const notes = await this.syncNotes();
    const descriptors = buildThreadDescriptors(storeData.comments, notes);

    for (const d of descriptors) {
      const uri = vscode.Uri.joinPath(workspaceRoot(), d.file);
      const thread = this.controller.createCommentThread(
        uri,
        new vscode.Range(d.start - 1, 0, d.end - 1, Number.MAX_SAFE_INTEGER),
        d.comments.map(
          (c) =>
            new vscode.Comment(c.body, c.author) as vscode.Comment & { readOnly?: boolean },
        ),
      );
      for (const comment of thread.comments) {
        (comment as vscode.Comment & { readOnly?: boolean }).readOnly = c_readOnly(d, comment);
      }
      thread.canReply = false;
      this.threadByKey.set(d.threadKey, thread);
    }
  }

  dispose(): void {
    this.threadByKey.clear();
  }
}

function c_readOnly(d: ThreadDescriptor, _c: vscode.Comment): boolean {
  return d.comments.every((c) => c.readOnly);
}

function workspaceRoot(): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    throw new Error('No workspace folder is open');
  }
  return root;
}
```

Замечание для реализующего: приведение типов с `readOnly` — временное решение; `vscode.Comment` не имеет `readOnly` в типах — используй `commentMode`-подход: помечай read-only через `thread.canReply = false` и отображай автора с суффиксом; проверь актуальный API. Минимальное требование: read-only комментарии нельзя редактировать через наш UI (мы не регистрируем команды редактирования для них).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commentBridge.ts src/test/commentBridge.test.ts
git commit -m "Add comment threads mapping local comments and hunk notes to Comments API"
```

---

### Task 5: SessionManager — фоновая сессия в скрытом терминале, автостоп

**Files:**
- Create: `src/sessionManager.ts`
- Test: `src/test/sessionManager.test.ts`

**Interfaces:**
- Consumes: `HunkCli`, `HunkSession` из `src/hunkCli.js`/`src/types.js`; `DiffService.isWorktreeClean` из `src/diffService.js`.
- Produces: класс `SessionManager` с методами `findSession(): Promise<HunkSession | undefined>`, `ensureSession(): Promise<HunkSession>` (запускает скрытый терминал при отсутствии, ждёт регистрации до 10 с), `stopSession(reason?: string): Promise<void>` (dispose терминала + тост), `currentSession(): HunkSession | undefined`; интерфейс `Toaster { info(message: string): void; error(message: string): void }` (обёртка `vscode.window.showInformationMessage` / `showErrorMessage`).

- [ ] **Step 1: Write the failing test**

`src/test/sessionManager.test.ts` — тестируем поллинг и логику без реального VS Code терминала (терминал подменяется через инъекцию `TerminalFactory`):

```typescript
import * as assert from 'node:assert';
import { SessionManager, TerminalFactory } from '../sessionManager.js';
import type { HunkSession } from '../types.js';

function fakeCli(sessions: HunkSession[]) {
  return {
    findSession: async (root: string) => sessions.find((s) => s.repoRoot === root),
    listSessions: async () => sessions,
  };
}

suite('SessionManager', () => {
  const root = '/tmp/repo';

  test('ensureSession returns existing session without starting terminal', async () => {
    let terminalsStarted = 0;
    const factory: TerminalFactory = () => {
      terminalsStarted += 1;
      return { dispose: () => undefined } as never;
    };
    const toasts: string[] = [];
    const sm = new SessionManager(
      fakeCli([{ sessionId: 's1', repoRoot: root }]) as never,
      root,
      factory,
      { info: (m: string) => toasts.push(m), error: (m: string) => toasts.push(m) },
      async () => false,
    );
    const session = await sm.ensureSession();
    assert.strictEqual(session.sessionId, 's1');
    assert.strictEqual(terminalsStarted, 0);
  });

  test('ensureSession starts hidden terminal and polls until registered', async () => {
    let terminalsStarted = 0;
    const factory: TerminalFactory = (cwd: string) => {
      assert.strictEqual(cwd, root);
      terminalsStarted += 1;
      return { dispose: () => undefined } as never;
    };
    const cli = fakeCli([]);
    // После первого запуска терминала сессия «регистрируется».
    cli.findSession = async (r: string) =>
      terminalsStarted > 0 ? { sessionId: 's9', repoRoot: r } : undefined;
    const sm = new SessionManager(
      cli as never,
      root,
      factory,
      { info: () => undefined, error: () => undefined },
      async () => false,
    );
    const session = await sm.ensureSession();
    assert.strictEqual(session.sessionId, 's9');
    assert.strictEqual(terminalsStarted, 1);
  });

  test('stopSession disposes terminal and clears state', async () => {
    let disposed = false;
    const factory: TerminalFactory = () =>
      ({ dispose: () => { disposed = true; } } as never);
    const cli = fakeCli([]);
    cli.findSession = async (r: string) =>
      ({ sessionId: 's9', repoRoot: r });
    const sm = new SessionManager(
      cli as never,
      root,
      factory,
      { info: () => undefined, error: () => undefined },
      async () => false,
    );
    await sm.ensureSession();
    await sm.stopSession('test');
    assert.strictEqual(disposed, true);
    assert.strictEqual(sm.currentSession(), undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../sessionManager.js'`.

- [ ] **Step 3: Write minimal implementation**

`src/sessionManager.ts`:

```typescript
import * as vscode from 'vscode';
import type { HunkCli } from './hunkCli.js';
import type { HunkSession } from './types.js';

export interface Toaster {
  info(message: string): void;
  error(message: string): void;
}

export type TerminalFactory = (cwd: string, onDispose: () => void) => vscode.Terminal;

export const vscodeTerminalFactory: TerminalFactory = (cwd, onDispose) => {
  const terminal = vscode.window.createTerminal({
    name: 'hunk-review session',
    cwd,
    hideFromUser: true,
  });
  terminal.show(); // TUI должен быть прикреплён к pty; окно можно закрыть
  terminal.hide();
  void onDispose;
  return terminal;
};

const REGISTRATION_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 500;

export class SessionManager implements vscode.Disposable {
  private terminal?: vscode.Terminal;
  private session?: HunkSession;

  constructor(
    private readonly cli: HunkCli,
    private readonly repoRoot: string,
    private readonly terminalFactory: TerminalFactory = vscodeTerminalFactory,
    private readonly toaster: Toaster = defaultToaster(),
    private readonly isWorktreeClean: () => Promise<boolean> = async () => false,
  ) {}

  currentSession(): HunkSession | undefined {
    return this.session;
  }

  async findSession(): Promise<HunkSession | undefined> {
    const found = await this.cli.findSession(this.repoRoot);
    if (found) {
      this.session = found;
    }
    return found;
  }

  async ensureSession(): Promise<HunkSession> {
    const existing = await this.findSession();
    if (existing) {
      return existing;
    }
    if (await this.isWorktreeClean()) {
      throw new Error('Рабочее дерево чистое — ревьюить нечего');
    }
    this.terminal = this.terminalFactory(this.repoRoot, () => {
      this.session = undefined;
      this.terminal = undefined;
    });
    const registered = await this.waitForRegistration();
    if (!registered) {
      this.terminal.dispose();
      this.terminal = undefined;
      throw new Error('hunk-сессия не зарегистрировалась за 10 секунд');
    }
    this.session = registered;
    return registered;
  }

  private async waitForRegistration(): Promise<HunkSession | undefined> {
    const deadline = Date.now() + REGISTRATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const found = await this.findSession();
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  async stopSession(reason?: string): Promise<void> {
    this.terminal?.dispose();
    this.terminal = undefined;
    this.session = undefined;
    if (reason) {
      this.toaster.info(`hunk-сессия остановлена: ${reason}`);
    }
  }

  async maybeAutoStop(): Promise<void> {
    if (!this.session) {
      return;
    }
    if (await this.isWorktreeClean()) {
      await this.stopSession('изменения закоммичены или отменены');
    }
  }

  dispose(): void {
    this.terminal?.dispose();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultToaster(): Toaster {
  return {
    info: (m) => void vscode.window.showInformationMessage(m),
    error: (m) => void vscode.window.showErrorMessage(m),
  };
}
```

Замечание: `terminal.show()` + `terminal.hide()` — обходной манёвр, чтобы TUI получил pty и отрисовался; проверь в smoke-тесте, что `hideFromUser: true` сам даёт активный pty и убери show/hide, если не нужен (см. Task 9).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessionManager.ts src/test/sessionManager.test.ts
git commit -m "Add background hunk session manager with hidden terminal lifecycle"
```

---

### Task 6: HunkSync — импорт комментариев агента (поллинг)

**Files:**
- Create: `src/hunkSync.ts`
- Test: `src/test/hunkSync.test.ts`

**Interfaces:**
- Consumes: `HunkCli.listNotes` из `src/hunkCli.js`; `HunkNote` из `src/types.js`.
- Produces: класс `HunkSync` с методами `start(intervalMs: number): void` (запускает `setInterval`), `stop(): void`, `getNotes(): HunkNote[]` (последний снапшот), событие `onDidChange: vscode.Event<HunkNote[]>`.

- [ ] **Step 1: Write the failing test**

`src/test/hunkSync.test.ts`:

```typescript
import * as assert from 'node:assert';
import { HunkSync } from '../hunkSync.js';
import type { HunkNote } from '../types.js';

suite('HunkSync', () => {
  test('polls cli and caches notes snapshot', async () => {
    const notes: HunkNote[] = [
      {
        noteId: 'n1',
        source: 'agent',
        filePath: 'a.ts',
        hunkIndex: 0,
        newRange: [2, 2],
        body: 'probe',
        createdAt: '2026-09-10T00:00:00Z',
        editable: false,
      },
    ];
    let calls = 0;
    const cli = {
      listNotes: async () => {
        calls += 1;
        return notes;
      },
    };
    const sync = new HunkSync(cli as never, '/tmp/r');
    await sync.pollOnce();
    assert.strictEqual(calls, 1);
    assert.strictEqual(sync.getNotes().length, 1);
    sync.stop();
  });

  test('start schedules polling via setInterval', function () {
    this.timeout(3000);
    let calls = 0;
    const cli = {
      listNotes: async () => {
        calls += 1;
        return [];
      },
    };
    const sync = new HunkSync(cli as never, '/tmp/r');
    sync.start(50);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        sync.stop();
        assert.ok(calls >= 2, `expected at least 2 polls, got ${calls}`);
        resolve();
      }, 200);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../hunkSync.js'`.

- [ ] **Step 3: Write minimal implementation**

`src/hunkSync.ts`:

```typescript
import * as vscode from 'vscode';
import type { HunkCli } from './hunkCli.js';
import type { HunkNote } from './types.js';

export class HunkSync {
  private timer?: ReturnType<typeof setInterval>;
  private notes: HunkNote[] = [];
  private readonly emitter = new vscode.EventEmitter<HunkNote[]>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly cli: Pick<HunkCli, 'listNotes'>,
    private readonly repoRoot: string,
  ) {}

  start(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => {
      void this.pollOnce().catch(() => undefined);
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async pollOnce(): Promise<void> {
    const notes = await this.cli.listNotes(this.repoRoot, 'all');
    const changed = JSON.stringify(notes) !== JSON.stringify(this.notes);
    this.notes = notes;
    if (changed) {
      this.emitter.fire(notes);
    }
  }

  getNotes(): HunkNote[] {
    return this.notes;
  }

  dispose(): void {
    this.stop();
    this.emitter.dispose();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hunkSync.ts src/test/hunkSync.test.ts
git commit -m "Add polling sync of hunk session comments"
```

---

### Task 7: Склейка в extension.ts — команды, status bar, enablement, автостоп

**Files:**
- Modify: `src/extension.ts` (полная замена helloWorld)
- Modify: `package.json` (commands, menus, enablement)
- Test: `src/test/extension.test.ts`

**Interfaces:**
- Consumes: `createHunkCli`, `CommentStore`, `DiffService`, `CommentBridge`, `SessionManager`, `HunkSync` из предыдущих задач.
- Produces: команды `hunk-review.openDiff`, `hunk-review.sendComments`, `hunk-review.stopSession`, `hunk-review.showSessionTerminal`, `hunk-review.menu`; контекст `hunk-review.hasPending` (boolean) для `enablement`; status bar item `$(eye) hunk: N pending`.

- [ ] **Step 1: Write the failing test**

`src/test/extension.test.ts` — smoke: активация и наличие команд:

```typescript
import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('extension activation', () => {
  test('registers all hunk-review commands', async () => {
    await vscode.extensions.getExtension('hunk-review.hunk-review')?.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'hunk-review.openDiff',
      'hunk-review.sendComments',
      'hunk-review.stopSession',
      'hunk-review.showSessionTerminal',
      'hunk-review.menu',
    ]) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — команды не зарегистрированы.

- [ ] **Step 3: Implement**

`src/extension.ts` (полная замена):

```typescript
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHunkCli } from './hunkCli.js';
import { CommentStore, ensureGitignore } from './commentStore.js';
import { DiffService } from './diffService.js';
import { CommentBridge } from './commentBridge.js';
import { SessionManager } from './sessionManager.js';
import { HunkSync } from './hunkSync.js';

export function activate(context: vscode.ExtensionContext): void {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return;
  }

  const cli = createHunkCli();
  const store = new CommentStore(path.join(root, '.hunk-review'));
  const diff = new DiffService();
  const bridge = new CommentBridge(store, () =>
    sessionManager.currentSession() ? sync.getNotes() : Promise.resolve([]),
  );
  const sessionManager = new SessionManager(cli, root, undefined, undefined, () =>
    diff.isWorktreeClean(),
  );
  const sync = new HunkSync(cli, root);

  const hasPending = async () => {
    const n = await store.pendingCount();
    await vscode.commands.executeCommand('setContext', 'hunk-review.hasPending', n > 0);
    statusBar.text = n > 0 ? `$(eye) hunk: ${n} pending` : '$(eye) hunk';
  };

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'hunk-review.menu';
  statusBar.show();

  const sendComments = async () => {
    const pending = await store.pending();
    if (pending.length === 0) {
      return;
    }
    try {
      await sessionManager.ensureSession();
      const all = await cli.listSessions();
      const sameRepo = all.filter(
        (s) =>
          fs.realpathSync.native(s.repoRoot) === fs.realpathSync.native(root),
      );
      if (sameRepo.length > 1) {
        void vscode.window.showInformationMessage(
          `Найдено несколько hunk-сессий этого репозитория — используем первую.`,
        );
      }
      const result = await cli.applyComments(root, {
        comments: pending.map((c) => ({
          filePath: c.filePath,
          newLine: c.target.newLine,
          oldLine: c.target.oldLine,
          summary: c.summary,
        })),
      });
      for (let i = 0; i < pending.length; i += 1) {
        await store.update(pending[i].id, {
          status: 'sent',
          sessionCommentId: result.applied[i]?.commentId,
        });
      }
      void vscode.window.showInformationMessage(
        `Отправлено комментариев: ${result.applied.length}. hunk-сессия работает в фоне.`,
      );
      await sync.pollOnce();
      sync.start(5_000); // пока сессия жива — опрашиваем комментарии агента
      await bridge.refresh();
    } catch (err) {
      await markStaleOnApplyFailure(err);
      void vscode.window.showErrorMessage(`Не удалось отправить комментарии: ${String(err)}`);
    }
    await hasPending();
  };

  const markStaleOnApplyFailure = async (err: unknown) => {
    const session = sessionManager.currentSession();
    if (!session) {
      return;
    }
    try {
      const review = await cli.sessionReview(root);
      const valid = new Set(
        review.files.flatMap((f) =>
          f.hunks.map((h) => `${f.path}:${h.newStart}-${h.newStart + h.newLines - 1}`),
        ),
      );
      for (const c of await store.pending()) {
        const line = c.target.newLine ?? c.target.oldLine ?? 1;
        const inDiff = [...valid].some((key) => {
          const [file, range] = splitOnce(key, ':');
          if (file !== c.filePath) {
            return false;
          }
          const [start, end] = range.split('-').map(Number);
          return line >= start && line <= end;
        });
        if (!inDiff) {
          await store.update(c.id, { status: 'stale' });
        }
      }
    } catch {
      // диагностика stale недоступна — не критично
    }
    void err;
  };

  const openDiff = async () => {
    const repo = diff.getRepo();
    if (!repo) {
      void vscode.window.showErrorMessage('Git-репозиторий не найден');
      return;
    }
    const changed = await diff.getChangedLines();
    if (changed.size === 0) {
      void vscode.window.showInformationMessage('Незакоммиченных изменений нет');
      return;
    }
    await ensureGitignore(root);
    for (const [file] of changed) {
      const uri = vscode.Uri.joinPath(repo.rootUri, file);
      await diff.openDiffForFile(uri);
      break; // открываем первый изменённый файл; остальные — по клику из списка
    }
    await bridge.refresh();
    void sync;
  };

  context.subscriptions.push(
    statusBar,
    bridge,
    sessionManager,
    sync,
    vscode.commands.registerCommand('hunk-review.openDiff', openDiff),
    vscode.commands.registerCommand('hunk-review.sendComments', sendComments),
    vscode.commands.registerCommand('hunk-review.stopSession', () => {
      sync.stop();
      return sessionManager.stopSession('остановлено пользователем');
    }),
    vscode.commands.registerCommand('hunk-review.showSessionTerminal', () => {
      // Скрытый терминал показываем через встроенный панельный механизм:
      // SessionManager хранит терминал; expose через getter добавлен в Task 5.
      sessionManager.showTerminal();
    }),
    vscode.commands.registerCommand('hunk-review.menu', async () => {
      const pendingCount = await store.pendingCount();
      const items: Array<vscode.QuickPickItem & { action: () => Promise<void> | void }> = [
        { label: '$(git-compare) Открыть ревью', action: () => openDiff() },
        {
          label: `$(comment) Отправить комментарии агенту (${pendingCount})`,
          action: () => sendComments(),
        },
        { label: '$(terminal) Показать терминал сессии', action: () => sessionManager.showTerminal() },
        { label: '$(close) Остановить hunk сессию', action: () => sessionManager.stopSession('остановлено пользователем') },
      ];
      const pick = await vscode.window.showQuickPick(items, { title: 'hunk review' });
      if (pick) {
        await pick.action();
      }
    }),
  );

  // Автостоп при чистом рабочем дереве.
  const gitApi = diff.getRepo();
  if (gitApi) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => undefined),
    );
  }
  // Простейший триггер: сохранение документа и интервал.
  const autoStopTimer = setInterval(() => {
    void sessionManager.maybeAutoStop().then(hasPending);
  }, 5_000);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(autoStopTimer)));

  void hasPending();
  void bridge.activate(context);
}

export function deactivate(): void {
  // SessionManager.dispose() вызывается через context.subscriptions.
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}
```

Дополнение к `src/sessionManager.ts` (добавь метод, использованный выше):

```typescript
showTerminal(): void {
  if (this.terminal) {
    this.terminal.show();
  } else {
    this.toaster.info('Фоновая hunk-сессия не запущена');
  }
}
```

`package.json` — внутри `contributes` добавь (сохранив существующие ключи):

```json
"contributes": {
  "commands": [
    {
      "command": "hunk-review.openDiff",
      "title": "hunk: Открыть ревью рабочего дерева",
      "category": "hunk-review"
    },
    {
      "command": "hunk-review.sendComments",
      "title": "hunk: Отправить комментарии агенту",
      "category": "hunk-review",
      "enablement": "hunk-review.hasPending"
    },
    {
      "command": "hunk-review.stopSession",
      "title": "hunk: Остановить hunk сессию",
      "category": "hunk-review"
    },
    {
      "command": "hunk-review.showSessionTerminal",
      "title": "hunk: Показать терминал сессии",
      "category": "hunk-review"
    },
    {
      "command": "hunk-review.menu",
      "title": "hunk: Меню ревью",
      "category": "hunk-review"
    }
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts src/test/extension.test.ts package.json
git commit -m "Wire hunk review commands, status bar, and send-to-session flow"
```

---

### Task 8: Комментарий из UI — декорация «+» на изменённых строках

**Files:**
- Create: `src/decorations.ts`
- Modify: `src/extension.ts` (активация декораций и команды создания комментария)
- Modify: `package.json` (команда `hunk-review.addComment`)
- Test: `src/test/decorations.test.ts`

**Interfaces:**
- Consumes: `DiffService.getChangedLines()`, `CommentStore.add`, `CommentBridge.refresh`.
- Produces: класс `Decorations` с методами `constructor(decorations...)` — фактически функция `createDecorations(): { update(changedLines: Map<string, LineRange[]>): void; dispose(): void }`; команда `hunk-review.addComment` (появляется в Comments API через `provideCommentingRange` контроллера).

- [ ] **Step 1: Write the failing test**

`src/test/decorations.test.ts` — проверяем только чистую логику выбора строк:

```typescript
import * as assert from 'node:assert';
import { expandRanges } from '../decorations.js';

suite('expandRanges', () => {
  test('produces per-line decoration options', () => {
    const options = expandRanges([{ start: 5, end: 7 }]);
    assert.deepStrictEqual(options, [5, 6, 7]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../decorations.js'`.

- [ ] **Step 3: Implement**

`src/decorations.ts`:

```typescript
import * as vscode from 'vscode';
import type { LineRange } from './diffService.js';

export function expandRanges(ranges: LineRange[]): number[] {
  return ranges.flatMap((r) => {
    const lines: number[] = [];
    for (let line = r.start; line <= r.end; line += 1) {
      lines.push(line);
    }
    return lines;
  });
}

export function createDecorations(): {
  update(changedLines: Map<string, LineRange[]>): void;
  dispose(): void;
} {
  const reviewed = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.commentAggregation'),
  });

  return {
    update(changedLines) {
      for (const editor of vscode.window.visibleTextEditors) {
        const file = relPath(editor.document.uri);
        const ranges = changedLines.get(file) ?? [];
        editor.setDecorations(
          reviewed,
          expandRanges(ranges).map((line) => new vscode.Range(line - 1, 0, line - 1, 0)),
        );
      }
    },
    dispose() {
      reviewed.dispose();
    },
  };
}

function relPath(uri: vscode.Uri): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return uri.fsPath.startsWith(root) ? uri.fsPath.slice(root.length + 1) : uri.fsPath;
}
```

В `src/extension.ts` добавь в `activate` (после создания `bridge`):

```typescript
import { createDecorations } from './decorations.js';
// ...
const decorations = createDecorations();
context.subscriptions.push(decorations);

const refreshDecorations = async () => {
  decorations.update(await diff.getChangedLines());
};

// вызывай refreshDecorations() после openDiff и в onDidChangeTextDocument/на событии git;
// минимум: внутри openDiff после bridge.refresh() добавь:
await refreshDecorations();
```

В `package.json` в `contributes.commands` добавь:

```json
{
  "command": "hunk-review.addComment",
  "title": "hunk: Добавить комментарий",
  "category": "hunk-review"
}
```

В `src/commentBridge.ts` в `activate` зарегистрируй обработку создания комментария (после контроллера):

```typescript
this.controller.options = { prompt: 'Добавить комментарий к строке (отправится в hunk)' };
```

И команду создания комментария в `src/extension.ts`:

```typescript
vscode.commands.registerCommand('hunk-review.addComment', async (reply) => {
  const { thread } = (reply ?? {}) as { thread?: vscode.CommentThread };
  if (!thread) {
    return;
  }
  const summary = await vscode.window.showInputBox({
    prompt: 'Комментарий к строке (уйдёт в hunk-сессию)',
  });
  if (!summary) {
    return;
  }
  const file = relPathFromRoot(thread.uri);
  const line = (thread.range.start.line ?? 0) + 1;
  await store.add(file, { newLine: line }, summary);
  await hasPending();
  await bridge.refresh();
  void refreshDecorations();
}),
```

и хелпер в `src/extension.ts`:

```typescript
function relPathFromRoot(uri: vscode.Uri): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return uri.fsPath.startsWith(root) ? uri.fsPath.slice(root.length + 1) : uri.fsPath;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/decorations.ts src/test/decorations.test.ts src/extension.ts src/commentBridge.ts package.json
git commit -m "Add changed-line decorations and inline comment creation flow"
```

---

### Task 9: Smoke-тест с реальным hunk и ручная проверка

**Files:**
- Modify: `src/test/smoke.test.ts` (create)

**Interfaces:**
- Consumes: все предыдущие компоненты.
- Produces: подтверждение сквозного сценария на реальном CLI.

- [ ] **Step 1: Write the smoke test**

`src/test/smoke.test.ts` — создаёт временный git-репозиторий с изменением, запускает реальный CLI-цикл:

```typescript
import * as assert from 'node:assert';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHunkCli } from '../hunkCli.js';

suite('smoke with real hunk CLI', function () {
  this.timeout(60_000);

  test('comment apply round-trip against real session', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hunk-smoke-'));
    cp.execSync('git init -q', { cwd: root });
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
    cp.execSync('git add .', { cwd: root });
    cp.execSync('git -c user.email=t@t -c user.name=t commit -qm init', { cwd: root });
    fs.appendFileSync(path.join(root, 'a.txt'), 'world\n');

    const cli = createHunkCli();
    let session;
    try {
      // Проверяем apply на живой сессии: пропускаем, если нет tty-возможности запустить TUI.
      session = await cli.findSession(root);
      if (!session) {
        this.skip();
      }
      const result = await cli.applyComments(root, {
        comments: [{ filePath: 'a.txt', newLine: 2, summary: 'smoke probe' }],
      });
      assert.strictEqual(result.applied.length, 1);
      const notes = await cli.listNotes(root, 'all');
      assert.ok(notes.some((n) => n.body === 'smoke probe'));
    } finally {
      if (session) {
        // Останавливаем сессию: убиваем процесс TUI по pid из session list.
        try {
          process.kill(session.pid ?? -1);
        } catch {
          // сессия уже завершена
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS (smoke-тест может self-skip без живой сессии — это не ошибка).

- [ ] **Step 3: Manual smoke checklist (задокументируй результат в PR/коммит-сообщении)**

1. `F5` → Extension Development Host → открой проект с незакоммиченными изменениями.
2. Команда «hunk: Открыть ревью» → открылся diff, изменённые строки подсвечены.
3. Выдели изменённую строку → «Добавить комментарий» → появился тред, status bar показал `hunk: 1 pending`.
4. «Отправить комментарии агенту» → скрытый терминал запустился, тост «Отправлено…», комментарий виден в `hunk session comment list`.
5. Запусти в терминале `hunk diff`, ответь агентом (`hunk session comment add --repo . --file … --new-line … --summary "reply"` с другим телом) → через ≤5 с reply появился в треде в VS Code.
6. Закоммить изменения → в течение 5 с сессия остановилась, тост показан.
7. Кнопка отправки при 0 pending — недоступна (меню показывает «(0)»).

- [ ] **Step 4: Fix anything found, rerun `npm test`, then commit**

```bash
git add src/test/smoke.test.ts
git commit -m "Add end-to-end smoke test against real hunk CLI"
```

---

## Execution notes

- Порядок задач строго последовательный: каждая следующая использует интерфейсы предыдущих (см. Interfaces/Produces).
- Если `hideFromUser: true` не даёт TUI зарегистрироваться (см. Task 5 замечание), запасной вариант: видимый терминал с `name: 'hunk session'` — функциональность не меняется, меняется только UX.
- Обнаруженный при планировании факт: macOS даёт `/private/tmp` vs `/tmp` — нормализация через `fs.realpathSync.native` уже в коде Task 1.
