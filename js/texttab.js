// texttab.js — the Text tab: one CodeMirror editor holding the whole booklet, coloured by FORMAT.md's rules.
(function (root) {
  "use strict";
  const { EditorView, EditorState, basicSetup, StreamLanguage, HighlightStyle, syntaxHighlighting, tags, linter } = CM;
  const { lintGutter } = CM;

  // Same line rules as js/parse.js (see FORMAT.md)
  const HAS_CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]|[\u{20000}-\u{2ffff}]/u;
  const REPEAT = /^x\d+$/i;
  const PAGE_REF = /\[page of [^\]]+\]/i, PAGE_REF_AT = /^\[page of [^\]]+\]/i;
  function lineKind(line, state) {
    const afterChinese = state.afterChinese;
    state.afterChinese = false;
    if (line.startsWith("//")) return "comment";
    if (line === "---" || /^\[(\/?one page|\/?keep together|\/?border|blank page|contents|toc:.*)\]$/i.test(line)) return "pageBreak";
    if (REPEAT.test(line)) return "repeat";
    if (line.includes("|") && HAS_CJK.test(line)) return "mantra";
    if (HAS_CJK.test(line)) { state.afterChinese = true; return "chinese"; }
    if (line.startsWith(">")) return "note";
    if (/^#{1,2}(\s|$)/.test(line)) return "heading";
    return afterChinese ? "pinyin" : null;
  }
  const liturgy = StreamLanguage.define({
    name: "liturgy",
    startState: () => ({ afterChinese: false, kind: null }),
    blankLine: (state) => { state.afterChinese = false; },
    token(stream, state) {
      if (stream.sol()) state.kind = lineKind(stream.string.trim(), state);
      if (state.kind !== "comment" && stream.match(PAGE_REF_AT)) return "pageRef";
      const next = stream.string.slice(stream.pos).search(PAGE_REF);
      if (next > 0 && state.kind !== "comment") stream.pos += next; else stream.skipToEnd();
      return state.kind;
    },
    tokenTable: { note: tags.quote, pageRef: tags.link, pageBreak: tags.processingInstruction, repeat: tags.keyword, mantra: tags.special(tags.string), chinese: tags.string, pinyin: tags.atom },
  });
  const colours = HighlightStyle.define([
    { tag: tags.comment, color: "#8a8a8a", fontStyle: "italic" },
    { tag: tags.processingInstruction, color: "#b00", fontWeight: "bold", backgroundColor: "#fde8e8" },
    { tag: tags.heading, color: "#8a5a00", fontWeight: "bold" },
    { tag: tags.keyword, color: "#0a6b8a", fontWeight: "bold" },
    { tag: tags.string, color: "#222" },
    { tag: tags.special(tags.string), color: "#6a3d9a" },
    { tag: tags.atom, color: "#2a7a3a" },
    { tag: tags.link, color: "#0a6b8a", textDecoration: "underline" },
    { tag: tags.quote, color: "#6b5a3a", fontStyle: "italic" },
  ]);
  const theme = EditorView.theme({
    "&": { height: "100%", fontSize: "15px", backgroundColor: "#fff" },
    // groups ([keep together], [border]): darker the deeper they're nested
    ".cm-group-1": { backgroundColor: "rgba(138, 90, 0, 0.07)" },
    ".cm-group-2": { backgroundColor: "rgba(138, 90, 0, 0.14)" },
    ".cm-group-3": { backgroundColor: "rgba(138, 90, 0, 0.21)" },
    ".cm-group-4": { backgroundColor: "rgba(138, 90, 0, 0.28)" },
    ".cm-scroller": { fontFamily: '"Gentium Book Plus", "Noto Serif TC", "Liturgy Extra", serif', lineHeight: "1.55" },
  });

  // Optional pinyin suggestions from pinyin-pro (loaded when switched on). Only shown where pinyin-pro reads a
  // character differently from the text — liturgical readings (nā mó, 土 dù, 般若 bō rě) are often deliberate.
  let suggesting = false;
  const recheck = CM.StateEffect.define();
  const clean = (syl) => syl.toLowerCase().normalize("NFC").replace(/[^\p{L}]/gu, "");
  function suggestions(text) {
    if (!suggesting || typeof pinyinPro === "undefined") return [];
    const out = [];
    for (const p of LiturgyParse.pairs(text)) {
      if (p.ideographs.length !== p.syllables.length) continue;   // counts differ: that's already an error
      const read = pinyinPro.pinyin(p.chars.join(""), { type: "array", toneSandhi: false });
      p.ideographs.forEach((ci, k) => {
        const written = p.syllables[k], ours = clean(written.text), theirs = clean(read[ci] || "");
        if (!ours || ours === "_" || !theirs || /\p{Script=Han}/u.test(theirs) || ours === theirs) return;   // (unknown characters come back as themselves)
        out.push({ line: p.pinyinLine, from: written.at, to: written.at + written.text.length, severity: "info",
          message: `pinyin-pro reads ${p.chars[ci]} as “${theirs}” (written “${ours}”). Only a suggestion — keep it if the reading is deliberate.` });
      });
    }
    return out;
  }
  async function setSuggesting(on, view) {
    if (on && typeof pinyinPro === "undefined") {
      await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "vendor/pinyin-pro.min.js"; s.onload = res; s.onerror = rej; document.head.append(s); });
    }
    suggesting = on;
    if (view) { view.dispatch({ effects: recheck.of(null) }); CM.forceLinting(view); }
  }

  // Line up pinyin under the characters (display only — the text itself keeps single spaces). Each character and
  // its syllable are drawn as columns of the same width (the wider of the two), punctuation gets an empty column in
  // the pinyin line, and spaces in the pinyin line take no room — so both lines wrap at the same places.
  const IDEO = /[㐀-䶿一-鿿豈-﫿]|[\u{20000}-\u{2ffff}]/u;
  let aligning = false;
  const alignSlot = new CM.Compartment(), remeasure = CM.StateEffect.define();
  const ruler = document.createElement("canvas").getContext("2d");
  let rulerFont = "", widths = new Map();
  const measure = (text) => { let w = widths.get(text); if (w == null) widths.set(text, (w = ruler.measureText(text).width)); return w; };
  const isPinyinLine = (t) => t && !HAS_CJK.test(t) && !/^(#|>|\/\/)/.test(t) && t !== "---" && !REPEAT.test(t) && !/^\[.*\]$/.test(t);
  function alignDecos(view) {
    const { Decoration, WidgetType } = CM;
    const cs = getComputedStyle(view.contentDOM), font = `${cs.fontSize} ${cs.fontFamily}`;
    if (font !== rulerFont) { rulerFont = ruler.font = font; widths = new Map(); }
    const gap = parseFloat(cs.fontSize) * 0.35;
    class Gap extends WidgetType {
      constructor(w) { super(); this.w = w; }
      eq(o) { return o.w === this.w; }
      toDOM() { const e = document.createElement("span"); e.className = "cm-py-gap"; e.style.width = this.w + "px"; return e; }
    }
    const col = (w) => Decoration.mark({ class: "cm-col", attributes: { style: `width:${w.toFixed(1)}px` } });
    const none = Decoration.mark({ class: "cm-py-space" });
    const out = [], doc = view.state.doc, seen = new Set();
    for (const { from, to } of view.visibleRanges) {
      // start a line early: a pinyin line at the top of the view needs its Chinese line
      for (let n = Math.max(1, doc.lineAt(from).number - 1); n <= doc.lineAt(to).number && n < doc.lines; n++) {
        if (seen.has(n)) continue;
        const zh = doc.line(n), py = doc.line(n + 1), zt = zh.text.trim();
        if (!HAS_CJK.test(zt) || zt.startsWith("//") || zt.includes("|") || isSep(zh.text) || !isPinyinLine(py.text.trim())) continue;
        seen.add(n); seen.add(n + 1);
        const syl = [...py.text.matchAll(/\S+/g)];
        for (const m of py.text.matchAll(/\s+/g)) out.push(none.range(py.from + m.index, py.from + m.index + m[0].length));
        let k = 0, at = 0;
        for (const ch of zh.text) {
          const pos = zh.from + at;
          at += ch.length;
          if (!ch.trim()) { out.push(none.range(pos, pos + ch.length)); continue; }
          if (IDEO.test(ch)) {
            const s = syl[k++];
            const w = Math.max(measure(ch), s ? measure(s[0]) : 0) + gap;
            out.push(col(w).range(pos, pos + ch.length));
            if (s) out.push(col(w).range(py.from + s.index, py.from + s.index + s[0].length));
          } else {
            // punctuation: its own column, and an empty one in the pinyin line
            const w = measure(ch) + gap, next = syl[k];
            out.push(col(w).range(pos, pos + ch.length));
            out.push(Decoration.widget({ widget: new Gap(w), side: next ? -1 : 1 }).range(next ? py.from + next.index : py.to));
          }
        }
      }
    }
    return Decoration.set(out, true);
  }
  const alignPlugin = CM.ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = alignDecos(view); }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(remeasure)))) this.decorations = alignDecos(u.view);
    }
  }, { decorations: (p) => p.decorations });
  const alignTheme = EditorView.baseTheme({
    ".cm-col": { display: "inline-block", textAlign: "center" },
    ".cm-py-gap": { display: "inline-block" },
    ".cm-py-space": { display: "inline-block", width: "0", overflow: "hidden", verticalAlign: "bottom" },
  });
  const alignExt = () => (aligning ? [alignPlugin, alignTheme] : []);
  function setAligning(on, view) {
    aligning = on;
    if (view) view.dispatch({ effects: alignSlot.reconfigure(alignExt()) });
  }
  // fonts arrive late (the rare-character font in pieces): measure again when they do
  if (document.fonts) document.fonts.addEventListener("loadingdone", () => {
    widths = new Map();
    for (const e of document.querySelectorAll(".cm-editor")) { const v = EditorView.findFromDOM(e); if (v) v.dispatch({ effects: remeasure.of(null) }); }
  });

  // The whole booklet in one editor: chapter after chapter, each starting with a header line (SEP + file name).
  // Header lines are drawn as a title bar and can't be edited, deleted or typed before, so every chapter's
  // text can always be told apart and saved to its own file.
  const SEP = "\u2063§ ";
  const isSep = (text) => text.startsWith(SEP);
  const headerLines = (doc) => {
    const out = [];
    for (let i = 1; i <= doc.lines; i++) { const t = doc.line(i).text; if (isSep(t)) out.push(t); }
    return out.join("\n");
  };

  // ---- groups: the lines of a [keep together] or [border] span (markers included) get a shaded background,
  // a shade darker for each span they're inside. Spans end with their chapter (the header line). Only the lines in
  // view are shaded; the depth is worked out from the chapter's start.
  const SPAN_LINE = /^\[(\/?)(keep together|one page|border)\]$/i;
  const groupLine = [1, 2, 3, 4].map((d) => CM.Decoration.line({ class: "cm-group cm-group-" + d }));
  function groupDecos(view) {
    const doc = view.state.doc, b = new CM.RangeSetBuilder();
    for (const { from, to } of view.visibleRanges) {
      let n = doc.lineAt(from).number;
      while (n > 1 && !isSep(doc.line(n).text)) n--;   // back to the chapter's header line
      const last = doc.lineAt(to).number;
      let depth = 0;
      for (; n <= last; n++) {
        const text = doc.line(n).text, m = text.trim().match(SPAN_LINE);
        if (isSep(text)) depth = 0;
        let here = depth;
        if (m && !m[1]) here = ++depth;          // an opening marker: the span starts with it
        else if (m && m[1] && depth) depth--;    // a closing marker: the span ends with it (shaded at its depth)
        const line = doc.line(n);
        if (here && line.from >= from && line.from <= to) b.add(line.from, line.from, groupLine[Math.min(here, 4) - 1]);
      }
    }
    return b.finish();
  }
  const groupShading = CM.ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = groupDecos(view); }
    update(u) { if (u.docChanged || u.viewportChanged) this.decorations = groupDecos(u.view); }
  }, { decorations: (p) => p.decorations });

  // ---- changed lines: a dot beside each line that differs from the original text ----
  // The original is a second document (same chapter header lines); @codemirror/merge's Chunk works out which lines
  // differ and keeps that up to date as you type. Clicking a dot puts that line (or, where lines were added or
  // removed, that group of lines) back to the original; a hollow "ghost" dot stays, and clicking it puts your
  // change back. Both are ordinary edits, so Undo/Redo work on them too.
  const label = CM.Annotation.define();   // a description of an edit for the Undo/Redo lists
  const addGhost = CM.StateEffect.define(), dropGhost = CM.StateEffect.define();
  const diffField = CM.StateField.define({
    create: (state) => ({ original: state.doc, chunks: [] }),
    update: (v, tr) => (tr.docChanged ? { original: v.original, chunks: CM.Chunk.updateB(v.chunks, v.original, tr.newDoc, tr.changes) } : v),
  });
  // ghosts: { from, to, text } — a reverted range (in the current text) and what was there before the revert
  const ghostField = CM.StateField.define({
    create: () => [],
    update(ghosts, tr) {
      let out = ghosts;
      if (tr.docChanged) {
        out = [];
        for (const g of ghosts) {
          let touched = false;
          tr.changes.iterChangedRanges((from, to) => { if (from <= g.to && to >= g.from) touched = true; });
          if (!touched) out.push({ ...g, from: tr.changes.mapPos(g.from, -1), to: tr.changes.mapPos(g.to, 1) });
        }
      }
      for (const e of tr.effects) {
        if (e.is(addGhost)) out = [...out, e.value];
        if (e.is(dropGhost)) out = out.filter((g) => g.from !== e.value.from || g.to !== e.value.to);
      }
      return out;
    },
  });
  class Dot extends CM.GutterMarker {
    constructor(kind, title) { super(); this.kind = kind; this.title = title; }
    eq(o) { return o.kind === this.kind; }
    toDOM() { return Object.assign(document.createElement("span"), { className: "cm-dot cm-dot-" + this.kind, title: this.title }); }
  }
  const DOTS = {
    changed: new Dot("changed", "Changed from the original text — click to put the original back"),
    removed: new Dot("removed", "Lines of the original text were taken out here — click to put them back"),
    ghost: new Dot("ghost", "Put back to the original — click to have your change again"),
    spacer: new Dot("spacer", ""),   // (only sets the column's width)
  };
  // lines in [from, to) — `to` one past the end of the last line, as in a Chunk
  const lineCount = (doc, from, to) => (from >= to ? 0 : doc.lineAt(Math.min(to - 1, doc.length)).number - doc.lineAt(from).number + 1);
  // the chapter a position is in (its header line's name)
  function chapterOf(doc, pos) {
    for (let n = doc.lineAt(Math.min(pos, doc.length)).number; n >= 1; n--) { const t = doc.line(n).text; if (isSep(t)) return t.slice(SEP.length); }
    return null;
  }
  function dotsOf(state, marked) {
    const doc = state.doc, kinds = new Map();
    for (const c of state.field(diffField).chunks) {
      if (!marked(chapterOf(doc, c.fromB))) continue;   // (a chapter with nothing to compare with: made in the editor)
      if (c.fromB === c.toB) { const at = doc.lineAt(Math.min(c.fromB, doc.length)).from; if (!kinds.has(at)) kinds.set(at, "removed"); continue; }
      for (let pos = c.fromB; pos < c.toB && pos <= doc.length;) { const l = doc.lineAt(pos); kinds.set(l.from, "changed"); pos = l.to + 1; }
    }
    for (const g of state.field(ghostField)) {
      for (let pos = g.from; pos <= Math.max(g.from, g.to - 1) && pos <= doc.length;) { const l = doc.lineAt(pos); if (!kinds.has(l.from)) kinds.set(l.from, "ghost"); pos = l.to + 1; }
    }
    const b = new CM.RangeSetBuilder();
    for (const at of [...kinds.keys()].sort((x, y) => x - y)) b.add(at, at, DOTS[kinds.get(at)]);
    return b.finish();
  }
  // a click on a dot
  function toggleLine(view, lineFrom, where, marked) {
    const state = view.state, doc = state.doc, orig = state.field(diffField).original;
    const chunk = state.field(diffField).chunks.find((c) => (c.fromB === c.toB ? doc.lineAt(Math.min(c.fromB, doc.length)).from === lineFrom : c.fromB <= lineFrom && lineFrom < c.toB)
      && marked(chapterOf(doc, c.fromB)));
    const n = doc.lineAt(lineFrom).number;
    if (chunk) {
      const aLines = lineCount(orig, chunk.fromA, chunk.toA), bLines = lineCount(doc, chunk.fromB, chunk.toB);
      let from, to, insert;
      if (aLines && aLines === bLines) {
        // lines changed one for one: just this line
        const line = doc.line(n), was = orig.line(orig.lineAt(chunk.fromA).number + n - doc.lineAt(chunk.fromB).number);
        [from, to, insert] = [line.from, line.to, was.text];
      } else {
        // lines added or taken out: the whole group (as @codemirror/merge's rejectChunk does)
        insert = orig.sliceString(chunk.fromA, Math.max(chunk.fromA, chunk.toA - 1));
        if (chunk.fromA !== chunk.toA && chunk.toB <= doc.length) insert += "\n";
        [from, to] = [chunk.fromB, Math.min(doc.length, chunk.toB)];
      }
      const text = doc.sliceString(from, to);
      view.dispatch({ changes: { from, to, insert }, effects: addGhost.of({ from, to: from + insert.length, text }),
        userEvent: "revert", annotations: [label.of(`Back to the original — ${where(n)}`), CM.isolateHistory.of("full")] });
      return true;
    }
    const g = state.field(ghostField).find((x) => x.from <= lineFrom && lineFrom <= Math.max(x.from, x.to - 1));
    if (g) {
      view.dispatch({ changes: { from: g.from, to: g.to, insert: g.text }, effects: dropGhost.of(g),
        userEvent: "reapply", annotations: [label.of(`Your change again — ${where(n)}`), CM.isolateHistory.of("full")] });
      return true;
    }
    return false;
  }

  // ---- Undo/Redo lists: a description of each step, kept in step with CodeMirror's own history ----
  const clip = (t) => { t = t.replace(/\n/g, " ⏎ ").trim(); return t.length > 32 ? t.slice(0, 30) + "…" : t; };
  function describeStep(tr, where) {
    const custom = tr.annotation(label);
    if (custom) return { text: custom };
    let typed = "", gone = "", at = 0;
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => { typed += inserted.toString(); gone += tr.startState.doc.sliceString(fromA, toA); at = fromB; });
    return { typed, gone, where: where(tr.newDoc.lineAt(at).number), paste: tr.isUserEvent("input.paste"), drop: tr.isUserEvent("input.drop") || tr.isUserEvent("move") };
  }
  const stepText = (s) => s.text || (s.paste ? `Paste “${clip(s.typed)}”` : s.drop ? "Move text" : s.typed ? `Typing “${clip(s.typed)}”` : s.gone ? `Delete “${clip(s.gone)}”` : "Change") + (s.where ? ` — ${s.where}` : "");

  // options: onChange(docText), onCursor(line), header(name) → element for a chapter's title bar,
  // check(docText) → problems [{ line, from?, to?, severity, message }], where(line) → "chapter, line n" (for the
  // Undo/Redo lists), onHistory() → the Undo/Redo lists changed
  // Returns { setDoc(text, original), replace(from, to, text, label), goto(line), refreshHeaders(), undo(n), redo(n),
  // history() → { undo: [text…], redo: [text…] } (next first), label, view }.
  // marked(name) → false for a chapter whose changed lines get no dots (one made in the editor: it has no original)
  function build(box, { onChange, onCursor = () => {}, header, check, where = (n) => "line " + n, onHistory = () => {}, marked = () => true }) {
    const { Decoration, WidgetType, StateField, StateEffect, RangeSetBuilder } = CM;
    const redraw = StateEffect.define();
    let version = 0;
    class Header extends WidgetType {
      constructor(name, v) { super(); this.name = name; this.v = v; }
      eq(other) { return other.name === this.name && other.v === this.v; }
      toDOM() { return header(this.name); }
      ignoreEvent() { return false; }
    }
    const heads = (state) => {
      const b = new RangeSetBuilder();
      for (let i = 1; i <= state.doc.lines; i++) {
        const l = state.doc.line(i);
        if (isSep(l.text)) b.add(l.from, l.to, Decoration.replace({ widget: new Header(l.text.slice(SEP.length), version), block: true }));
      }
      return b.finish();
    };
    const headerField = StateField.define({
      create: heads,
      update: (deco, tr) => (tr.docChanged || tr.effects.some((e) => e.is(redraw)) ? heads(tr.state) : deco),
      provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((v) => v.state.field(f))],
    });
    // Nothing may change a header line or put text before the first one. An edit that would (e.g. pasting over a
    // selection that runs from one chapter into the next, or over everything after Select All) is done around the
    // header lines instead: the text goes where the edit starts, and the parts of other chapters it covered are
    // deleted, their header lines kept.
    const headersKept = (tr) => headerLines(tr.startState.doc) === headerLines(tr.newDoc) && (tr.newDoc.length === 0 || isSep(tr.newDoc.line(1).text));
    const guard = EditorState.transactionFilter.of((tr) => {
      if (!tr.docChanged || headersKept(tr)) return tr;
      const doc = tr.startState.doc, spans = [];   // each header line with the line breaks on both sides
      for (let i = 1; i <= doc.lines; i++) { const l = doc.line(i); if (isSep(l.text)) spans.push([Math.max(0, l.from - 1), Math.min(doc.length, l.to + 1)]); }
      const changes = [];
      tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        const text = inserted.toString().split("\n").filter((l) => !isSep(l)).join("\n");   // (header lines copied along)
        let pieces = [[fromA, toA]];
        for (const [a, b] of spans) {
          pieces = pieces.flatMap(([f, t]) => {
            if (f === t) return [f > a && f < b || (f === 0 && a === 0) ? [b, b] : [f, t]];   // an insertion inside: just after
            return b <= f || a >= t ? [[f, t]] : [[f, Math.min(t, a)], [Math.max(f, b), t]].filter(([x, y]) => x < y);
          });
        }
        if (!pieces.length) pieces = [[Math.min(toA, doc.length), Math.min(toA, doc.length)]];
        pieces.forEach(([f, t], k) => changes.push({ from: f, to: t, insert: k ? "" : text }));
      });
      const spec = { changes, annotations: [] };
      const ev = tr.annotation(CM.Transaction.userEvent);
      if (ev) spec.annotations.push(CM.Transaction.userEvent.of(ev));
      const what = tr.annotation(label);
      if (what) spec.annotations.push(label.of(what));
      const fixed = tr.startState.update({ ...spec, filter: false });
      return headersKept(fixed) ? spec : [];
    });
    // copying leaves out the header lines; pasting drops any that came along
    const dropHeaders = (text) => text.split("\n").filter((l) => !isSep(l)).join("\n");
    const clipboard = [EditorView.clipboardOutputFilter.of(dropHeaders), EditorView.clipboardInputFilter.of(dropHeaders)];
    const lint = linter((view) => {
      const text = view.state.doc.toString();
      return [...check(text), ...suggestions(text)].map((p) => {
        const line = view.state.doc.line(Math.min(p.line, view.state.doc.lines));
        const from = p.from != null ? line.from + Math.min(p.from, line.length) : line.from;
        const to = p.to != null ? line.from + Math.min(p.to, line.length) : line.to;
        return { from, to, severity: p.severity, message: p.message };
      });
    }, { delay: 500, needsRefresh: (u) => u.transactions.some((t) => t.effects.some((e) => e.is(recheck))) });
    const changeGutter = CM.Prec.high(CM.gutter({
      class: "cm-changes",
      markers: (v) => dotsOf(v.state, marked),
      initialSpacer: () => DOTS.spacer,
      domEventHandlers: { mousedown: (v, line) => toggleLine(v, line.from, where, marked) },
    }));
    let steps = { undo: [], redo: [] };
    function track(u) {
      let moved = false;
      for (const tr of u.transactions) {
        if (tr.isUserEvent("undo")) { const s = steps.undo.pop(); if (s) steps.redo.push(s); moved = true; }
        else if (tr.isUserEvent("redo")) { const s = steps.redo.pop(); if (s) steps.undo.push(s); moved = true; }
      }
      const undoN = CM.undoDepth(u.state), redoN = CM.redoDepth(u.state);
      if (!moved && u.docChanged) {
        const tr = u.transactions.find((t) => t.docChanged), step = describeStep(tr, where);
        if (undoN > CM.undoDepth(u.startState) || !steps.undo.length) steps.undo.push(step);
        else {   // joined to the step before (typing on)
          const top = steps.undo[steps.undo.length - 1];
          if (!top.text) { top.typed = (top.typed || "") + (step.typed || ""); top.gone = (step.gone || "") + (top.gone || ""); }
        }
      }
      // in step with the real history (it forgets the oldest steps after a while)
      while (steps.undo.length > undoN) steps.undo.shift();
      while (steps.undo.length < undoN) steps.undo.unshift({ text: "An earlier change" });
      if (!redoN) steps.redo = [];
      while (steps.redo.length > redoN) steps.redo.shift();
      while (steps.redo.length < redoN) steps.redo.unshift({ text: "A change" });
      if (u.docChanged || moved) onHistory();
    }
    const create = (doc, original) => EditorState.create({
      doc,
      extensions: [
        changeGutter, basicSetup, EditorView.lineWrapping, liturgy, syntaxHighlighting(colours), theme, headerField, guard, clipboard, lint, lintGutter(),
        alignSlot.of(alignExt()), groupShading,
        diffField.init((st) => { const o = CM.EditorState.create({ doc: original ?? doc }).doc; return { original: o, chunks: CM.Chunk.build(o, st.doc) }; }),
        ghostField,
        EditorView.updateListener.of((u) => {
          track(u);
          if (u.docChanged) onChange(u.state.doc.toString());
          if (u.docChanged || u.selectionSet) onCursor(u.state.doc.lineAt(u.state.selection.main.head).number);
        }),
      ],
    });
    const view = new EditorView({ parent: box, state: create("") });
    return {
      view,
      label,
      // a new document (e.g. chapters added or removed): starts a fresh undo history.
      // original: the same document as it was originally (for the dots beside changed lines)
      setDoc(text, original) { view.setState(create(text, original)); steps = { undo: [], redo: [] }; onHistory(); },
      // one undoable change (e.g. a chapter back to its original text)
      replace(from, to, text, what) {
        view.dispatch({ changes: { from, to, insert: text }, annotations: what ? [label.of(what), CM.isolateHistory.of("full")] : [] });
      },
      undo(n = 1) { for (let i = 0; i < n; i++) CM.undo(view); },
      redo(n = 1) { for (let i = 0; i < n; i++) CM.redo(view); },
      history: () => ({ undo: steps.undo.map(stepText).reverse(), redo: steps.redo.map(stepText).reverse() }),
      goto(line, focus = true) {
        const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
        view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "start", yMargin: 40 }) });
        if (focus) view.focus();
      },
      refreshHeaders() { version++; view.dispatch({ effects: redraw.of(null) }); },
    };
  }

  root.LiturgyText = { build, setSuggesting, setAligning, SEP, isSep };
})(window);
