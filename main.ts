// mend: applies edits that AI models write to a tree of text files.
//
// One command, four patch formats: unified diffs (often with wrong line
// numbers), SEARCH/REPLACE blocks, V4A patches, and JSON tool calls. The
// behaviour is exactly what SPEC.md says: every file is changed or nothing
// is, a failed edit is reported and the rest still run, and the output is
// one line per changed path plus a summary line.
//
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
//
// When MAKEFUN_ENV_URL is set this file hands over to runner.ts, which runs
// it on each check of a trial: keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: the single line it prints. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Section 3: a path is safe when it is not empty, not absolute, holds no backslash, and no segment is empty, . or .. */
function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const byteCompare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** The tree as the edits leave it: paths changed so far live in `now` (null means deleted), the rest are read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** State shared by a run: strict matching, and the moves that succeeded (for the R output lines). */
interface RunCtx {
  strict: boolean;
  moves: Array<[string, string]>;
}

/** A file as lines plus its own line break and whether it ends with one. */
interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    parts.pop();
    final = true;
  }
  return { lines: parts, br, final };
}

function renderDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** How a line compares at a tier: 0 exact, 1 trailing spaces/tabs ignored, 2 both ends ignored. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where oldLines occur in fileLines at this tier. */
function occurrencesAt(fileLines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  const n = oldLines.length;
  if (n === 0 || n > fileLines.length) return out;
  const want = oldLines.map((l) => normLine(l, tier));
  for (let i = 0; i + n <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (normLine(fileLines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** One line of a replacement: a context line is written as the file's own matched line (fileIndex into O), a new line as written. */
interface NLine {
  text: string;
  fileIndex: number | null;
}

/** Replace O at position pos by N. At tier 2 the new lines are re-indented from O's first line to the file's first matched line. */
function applyReplace(doc: Doc, oldLines: string[], nLines: NLine[], pos: number, tier: number): string[] {
  const fileLines = doc.lines;
  const f = pos < fileLines.length ? leadingWs(fileLines[pos]!) : '';
  const p = oldLines.length > 0 ? leadingWs(oldLines[0]!) : '';
  const out: string[] = [];
  for (const item of nLines) {
    if (item.fileIndex !== null) {
      out.push(fileLines[pos + item.fileIndex]!);
    } else {
      let t = item.text;
      if (tier === 2 && oldLines.length > 0 && t !== '' && t.trim() !== '' && t.startsWith(p)) {
        t = f + t.slice(p.length);
      }
      out.push(t);
    }
  }
  return [...fileLines.slice(0, pos), ...out, ...fileLines.slice(pos + oldLines.length)];
}

/** Section 4: which format a patch is, or null when none holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

type BodyKind = 'ctx' | 'old' | 'new' | 'bs';
interface BodyLine {
  kind: BodyKind;
  text: string;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface Section {
  dashOld: string | undefined;
  dashNew: string | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffA: string | undefined;
  diffB: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
  hasDashPair: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;

function isBodyLine(l: string): boolean {
  return l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');
}

function parseBodyLine(l: string): BodyLine {
  if (l.startsWith(' ')) return { kind: 'ctx', text: l.slice(1) };
  if (l.startsWith('-')) return { kind: 'old', text: l.slice(1) };
  if (l.startsWith('+')) return { kind: 'new', text: l.slice(1) };
  if (l.startsWith('\\')) return { kind: 'bs', text: l.slice(1) };
  return { kind: 'ctx', text: l };
}

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, surrounding spaces removed. */
function headerPath(l: string): string {
  const rest = l.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function parseUnified(lines: string[], ctx: RunCtx): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let state: 'outside' | 'header' | 'body' | 'between' = 'outside';
  let hunk: Hunk | null = null;

  const finishHunk = (): void => {
    if (hunk !== null && cur !== null) {
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
      hunk = null;
    }
    state = 'between';
  };

  const newSection = (diffA?: string, diffB?: string): Section => {
    const s: Section = {
      dashOld: undefined,
      dashNew: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      diffA,
      diffB,
      newFile: false,
      deletedFile: false,
      hunks: [],
      hasDashPair: false,
    };
    sections.push(s);
    cur = s;
    state = 'header';
    return s;
  };

  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (state === 'body') {
      // A `--- ` line followed by a `+++ ` line ends the body and starts a
      // new section, even though both lines start with a body marker.
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        finishHunk();
        continue;
      }
      if (isBodyLine(l)) {
        hunk!.body.push(parseBodyLine(l));
        i++;
        continue;
      }
      finishHunk();
      continue;
    }
    if (l === 'diff --git' || l.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(l.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      newSection(m[1], m[2]);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (state === 'header' && cur !== null && !cur.hasDashPair) {
        cur.dashOld = headerPath(l);
        cur.dashNew = headerPath(lines[i + 1]!);
        cur.hasDashPair = true;
      } else {
        const s = newSection();
        s.dashOld = headerPath(l);
        s.dashNew = headerPath(lines[i + 1]!);
        s.hasDashPair = true;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (state === 'header') throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: parseInt(m[1]!, 10), body: [] };
      state = 'body';
      i++;
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i++;
  }
  if (state === 'body') finishHunk();
  return sections.map((s) => unifiedEdit(s, ctx));
}

/** Apply a section's hunks in order to a document. */
function applyUnifiedHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): Doc {
  let cur = doc;
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const N: NLine[] = [];
    let lastMark = -1;
    for (let bi = 0; bi < h.body.length; bi++) {
      const bl = h.body[bi]!;
      if (bl.kind === 'ctx') {
        O.push(bl.text);
        N.push({ text: bl.text, fileIndex: O.length - 1 });
        lastMark = bi;
      } else if (bl.kind === 'old') {
        O.push(bl.text);
      } else if (bl.kind === 'new') {
        N.push({ text: bl.text, fileIndex: null });
        lastMark = bi;
      }
    }
    const bsAfter = lastMark >= 0 && h.body[lastMark + 1]?.kind === 'bs';
    if (O.length > 0) {
      let found: { tier: number; positions: number[] } | null = null;
      for (const t of tiers(strict)) {
        const positions = occurrencesAt(cur.lines, O, t);
        if (positions.length > 0) {
          found = { tier: t, positions };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + O.length === cur.lines.length;
      const lines = applyReplace(cur, O, N, best, found.tier);
      cur = { lines, br: cur.br, final: atEnd ? !bsAfter : cur.final };
      d += N.length - O.length;
    } else {
      const idx = Math.min(Math.max(h.a + d, 0), cur.lines.length);
      const atEnd = idx === cur.lines.length;
      const added = N.map((x) => x.text);
      const lines = [...cur.lines.slice(0, idx), ...added, ...cur.lines.slice(idx)];
      cur = { lines, br: cur.br, final: atEnd ? !bsAfter : cur.final };
      d += N.length;
    }
  }
  return cur;
}

/** The file a creation section makes: every `+` line, ended by a line break unless a `\` line follows the last `+` line. */
function creationContent(hunks: Hunk[]): string {
  const plus: string[] = [];
  let bsAfterLastPlus = false;
  for (const h of hunks) {
    for (let bi = 0; bi < h.body.length; bi++) {
      const bl = h.body[bi]!;
      if (bl.kind === 'new') {
        plus.push(bl.text);
        bsAfterLastPlus = h.body[bi + 1]?.kind === 'bs';
      }
    }
  }
  if (plus.length === 0) return '';
  return plus.join('\n') + (bsAfterLastPlus ? '' : '\n');
}

function unifiedEdit(sec: Section, ctx: RunCtx): Edit {
  const resolvePath = (dash: string | undefined, rename: string | undefined, diff: string | undefined): string | null => {
    if (dash !== undefined) return dash === '/dev/null' ? null : stripAB(dash);
    if (rename !== undefined) return rename;
    if (diff !== undefined) return diff;
    return null;
  };
  const oldPath = resolvePath(sec.dashOld, sec.renameFrom, sec.diffA);
  const newPath = resolvePath(sec.dashNew, sec.renameTo, sec.diffB);
  const isCreate = sec.newFile || sec.dashOld === '/dev/null';
  const isDelete = !isCreate && (sec.deletedFile || sec.dashNew === '/dev/null');
  const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;
  return (tree) => {
    if (oldPath !== null && !safePath(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safePath(newPath)) throw new Fail('unsafe', newPath);
    if (isCreate) {
      if (newPath === null) throw new Fail('unsafe', '');
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      tree.now.set(newPath, creationContent(sec.hunks));
      return;
    }
    if (isDelete) {
      if (oldPath === null) throw new Fail('unsafe', '');
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (isMove) {
      const before = tree.get(oldPath!);
      if (before === null) throw new Fail('missing', oldPath!);
      if (tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
      const result = applyUnifiedHunks(parseDoc(before), sec.hunks, ctx.strict, oldPath!);
      tree.now.set(oldPath!, null);
      tree.now.set(newPath!, renderDoc(result));
      ctx.moves.push([oldPath!, newPath!]);
      return;
    }
    const p = oldPath ?? newPath;
    if (p === null) throw new Fail('unsafe', '');
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const result = applyUnifiedHunks(parseDoc(before), sec.hunks, ctx.strict, p);
    tree.now.set(p, renderDoc(result));
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], ctx: RunCtx): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, ctx.strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = parseDoc(before);
    let found: { tier: number; positions: number[] } | null = null;
    for (const t of tiers(strict)) {
      const positions = occurrencesAt(doc.lines, oldLines, t);
      if (positions.length > 0) {
        found = { tier: t, positions };
        break;
      }
    }
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const N: NLine[] = newLines.map((t) => ({ text: t, fileIndex: null }));
    const lines = applyReplace(doc, oldLines, N, found.positions[0]!, found.tier);
    tree.now.set(path, renderDoc({ lines, br: doc.br, final: doc.final }));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function parseV4a(lines: string[], ctx: RunCtx): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const start = i + 1;
      let j = start;
      while (j < last && !isV4aSectionStart(lines[j]!)) j++;
      let end = j;
      while (end > start && blank(lines[end - 1]!)) end--;
      const content: string[] = [];
      for (let k = start; k < end; k++) {
        const sl = lines[k]!;
        if (sl === '') content.push('');
        else if (sl.startsWith('+')) content.push(sl.slice(1));
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push(v4aAddEdit(path, content));
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      const start = i + 1;
      let j = start;
      while (j < last && !isV4aSectionStart(lines[j]!)) j++;
      let end = j;
      while (end > start && blank(lines[end - 1]!)) end--;
      for (let k = start; k < end; k++) throw new Exit2(`error: parse ${k + 1}`);
      edits.push(v4aDeleteEdit(path));
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const headerLine = i;
      const start = i + 1;
      let j = start;
      while (j < last && !isV4aSectionStart(lines[j]!)) j++;
      let end = j;
      while (end > start && blank(lines[end - 1]!)) end--;
      let k = start;
      let moveTo: string | null = null;
      if (k < end && lines[k]!.startsWith('*** Move to: ')) {
        moveTo = lines[k]!.slice('*** Move to: '.length).trim();
        k++;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (k < end) {
        const l = lines[k]!;
        if (l.startsWith('@@')) {
          closeChunk();
          cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
          k++;
        } else if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${k + 1}`);
          cur.eof = true;
          closeChunk();
          k++;
        } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${k + 1}`);
            cur = { anchor: null, eof: false, body: [] };
          }
          cur.body.push(parseBodyLine(l));
          k++;
        } else {
          throw new Exit2(`error: parse ${k + 1}`);
        }
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, ctx));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aAddEdit(path: string, content: string[]): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, content.length === 0 ? '' : `${content.join('\n')}\n`);
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], ctx: RunCtx): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safePath(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let doc = parseDoc(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        let at: number | null = null;
        for (const t of tiers(ctx.strict)) {
          const ps = occurrencesAt(doc.lines, [ch.anchor], t).filter((p) => p >= cursor);
          if (ps.length > 0) {
            at = ps[0]!;
            break;
          }
        }
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const O: string[] = [];
      const N: NLine[] = [];
      for (const bl of ch.body) {
        if (bl.kind === 'ctx') {
          O.push(bl.text);
          N.push({ text: bl.text, fileIndex: O.length - 1 });
        } else if (bl.kind === 'old') {
          O.push(bl.text);
        } else if (bl.kind === 'new') {
          N.push({ text: bl.text, fileIndex: null });
        }
      }
      if (O.length > 0) {
        let found: { tier: number; pos: number } | null = null;
        for (const t of tiers(ctx.strict)) {
          const ps = occurrencesAt(doc.lines, O, t).filter((p) => p >= cursor && (!ch.eof || p + O.length === doc.lines.length));
          if (ps.length > 0) {
            found = { tier: t, pos: ps[0]! };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', path);
        const lines = applyReplace(doc, O, N, found.pos, found.tier);
        doc = { lines, br: doc.br, final: doc.final };
        cursor = found.pos + N.length;
      } else {
        const idx = ch.eof ? doc.lines.length : cursor;
        const added = N.map((x) => x.text);
        const lines = [...doc.lines.slice(0, idx), ...added, ...doc.lines.slice(idx)];
        doc = { lines, br: doc.br, final: doc.final };
        cursor = idx + N.length;
      }
    }
    const out = renderDoc(doc);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      ctx.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits
// ---------------------------------------------------------------------------

/** One JSON edit object (section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const needExisting = (tree: Tree): string => {
    if (!safePath(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needExisting(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = needExisting(tree);
      const doc = parseDoc(before);
      if (lineNo < 0 || lineNo > doc.lines.length) throw new Fail('no-match', p);
      const lines = [...doc.lines];
      lines.splice(lineNo, 0, ...add);
      tree.now.set(p, renderDoc({ lines, br: doc.br, final: doc.final }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 1, 2 and 10: invocation, output, order and atomicity
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const ctx: RunCtx = { strict, moves: [] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, ctx)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, ctx)
            : parseV4a(lines, ctx);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: Array<{ key: string; text: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of ctx.moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCompare)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  const outRows = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCompare)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
