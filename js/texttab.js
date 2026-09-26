// texttab.js — the Text tab: one CodeMirror editor holding the whole booklet, coloured by FORMAT.md's rules.
(function (root) {
  "use strict";
  const { EditorView, EditorState, basicSetup, StreamLanguage, HighlightStyle, syntaxHighlighting, tags, linter } = CM;
  const { lintGutter } = CM;

  // Same line rules as js/parse.js (see FORMAT.md)
  const HAS_CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]|[\u{20000}-\u{2ffff}]/u;
  const REPEAT = /^x\d+$/i;
  const PAGE_REF = /\[page(?:\s+\d+)?\s+of\s+[^\]]+\]/i, PAGE_REF_AT = /^\[page(?:\s+\d+)?\s+of\s+[^\]]+\]/i;
  function lineKind(line, state) {
    const afterChinese = state.afterChinese;
    state.afterChinese = false;
    if (line.startsWith("//")) return "comment";
    if (line === "---" || /^\[(\/?one page|\/?keep together|\/?border|blank page|new page|\/?contents|toc:.*)\]$/i.test(line)) return "pageBreak";
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
    // (a see-through background: a selection over a tag must show)
    { tag: tags.processingInstruction, color: "#b00", fontWeight: "bold", backgroundColor: "rgba(210, 40, 40, 0.09)" },
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
    ".cm-tag-pair": { outline: "2px solid rgba(190, 30, 30, 0.8)", outlineOffset: "-2px", borderRadius: "3px", backgroundColor: "rgba(210, 40, 40, 0.12)" },
    ".cm-pagenum": { margin: "0 4px", padding: "0 5px", borderRadius: "8px", background: "#e7f0f3", color: "#0a6b8a",
      font: "11px system-ui, sans-serif", cursor: "pointer", whiteSpace: "nowrap" },
    ".cm-pagenum.fixed": { background: "#fff0c2", color: "#8a5a00" },
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

  // ---- groups: the lines of a [keep together] or [border] span (markers included) get a shaded background: amber for
  // keep together, blue for a border, their midpoint where both apply; a shade darker for each span they're inside.
  // Spans end with their chapter (the header line). Only the lines in view are shaded; the nesting is worked out from
  // the chapter's start.
  const SPAN_LINE = /^\[(\/?)(keep together|one page|border)\]$/i;
  const KEEP_RGB = [138, 90, 0], BORDER_RGB = [30, 100, 170], SHADE = 0.07;
  const groupLine = new Map();   // "keeps,borders" → line decoration
  function groupDeco(keeps, borders) {
    const key = keeps + "," + borders;
    if (!groupLine.has(key)) {
      const rgb = keeps && borders ? KEEP_RGB.map((c, i) => Math.round((c + BORDER_RGB[i]) / 2)) : keeps ? KEEP_RGB : BORDER_RGB;
      const alpha = Math.min(0.35, SHADE * (keeps + borders));
      groupLine.set(key, CM.Decoration.line({ class: `cm-group cm-group-${keeps && borders ? "both" : keeps ? "keep" : "border"}`,
        attributes: { style: `background-color: rgba(${rgb.join(", ")}, ${alpha})`, "data-depth": String(keeps + borders) } }));
    }
    return groupLine.get(key);
  }
  function groupDecos(view) {
    const doc = view.state.doc, b = new CM.RangeSetBuilder();
    for (const { from, to } of view.visibleRanges) {
      let n = doc.lineAt(from).number;
      while (n > 1 && !isSep(doc.line(n).text)) n--;   // back to the chapter's header line
      const last = doc.lineAt(to).number, open = [];   // kinds of the spans open: "keep" / "border"
      for (; n <= last; n++) {
        const text = doc.line(n).text, m = text.trim().match(SPAN_LINE);
        if (isSep(text)) open.length = 0;
        const kind = m && (m[2].toLowerCase() === "border" ? "border" : "keep");
        if (m && !m[1]) open.push(kind);                 // an opening marker: the span starts with it
        const count = (k) => open.filter((x) => x === k).length;
        const keeps = count("keep"), borders = count("border");
        if (m && m[1] && open.length) open.pop();        // a closing marker: the span ends with it (shaded as inside)
        const line = doc.line(n);
        if (keeps + borders && line.from >= from && line.from <= to) b.add(line.from, line.from, groupDeco(keeps, borders));
      }
    }
    return b.finish();
  }
  const groupShading = CM.ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = groupDecos(view); }
    update(u) { if (u.docChanged || u.viewportChanged) this.decorations = groupDecos(u.view); }
  }, { decorations: (p) => p.decorations });

  // ---- span tags come in pairs: [keep together] … [/keep together], [border] … [/border], [contents] … [/contents].
  // Deleting into one (Backspace, Delete, a selection over part of it) removes both tags of the pair, leaving the lines
  // between; typing next to one goes on a line of its own. With the cursor on a tag, it and its partner are marked.
  const TAG = /^\[(\/?)(keep together|one page|border|contents)\]$/i;
  const tagAt = (doc, n) => { const m = doc.line(n).text.trim().match(TAG); return m && { close: !!m[1], kind: m[2].toLowerCase() === "one page" ? "keep together" : m[2].toLowerCase() }; };
  // the line of the other tag of the pair (within the chapter), or null
  function partnerOf(doc, n) {
    const me = tagAt(doc, n);
    if (!me) return null;
    const step = me.close ? -1 : 1;
    let depth = 0;
    for (let i = n + step; i >= 1 && i <= doc.lines && !isSep(doc.line(i).text); i += step) {
      const t = tagAt(doc, i);
      if (!t) continue;
      if (t.close === me.close) depth++;
      else if (depth) depth--;
      else return t.kind === me.kind ? i : null;
    }
    return null;
  }
  const lineRange = (doc, n) => { const l = doc.line(n); return l.to < doc.length ? [l.from, l.to + 1] : [Math.max(0, l.from - 1), l.to]; };
  const pairGuard = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || tr.annotation(CM.Transaction.addToHistory) === false) return tr;
    const doc = tr.startState.doc, tags = new Set();
    tr.changes.iterChangedRanges((from, to) => {
      const a = doc.lineAt(Math.max(0, from - 1)).number, b = doc.lineAt(Math.min(doc.length, to + 1)).number;
      for (let n = a; n <= b; n++) if (tagAt(doc, n)) tags.add(n);
    });
    if (!tags.size) return tr;
    // typing next to (or inside) a tag: on a line of its own
    let changes = [], cursorAfter = null;   // (typing moved to a line of its own: the cursor goes after it)
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      let text = inserted.toString(), at = fromA;
      if (fromA === toA && text) {
        const line = doc.lineAt(fromA);
        if (tags.has(line.number)) {
          if (fromA === line.from && !text.endsWith("\n")) { text += "\n"; cursorAfter = [at, text.length - 1]; }
          else if (fromA > line.from && !(fromA === line.to && text.startsWith("\n"))) {
            at = line.to;
            if (!text.startsWith("\n")) text = "\n" + text;
            cursorAfter = [at, text.length];
          }
        }
      }
      changes.push({ from: at, to: at === fromA ? toA : at, insert: text });
    });
    // a tag no longer whole on its line afterwards (or gone): remove it and its partner, whole lines
    const test = tr.startState.update({ changes, filter: false });
    const extra = [];
    for (const n of tags) {
      const l = doc.line(n), pos = test.changes.mapPos(l.from, 1), nl = test.newDoc.lineAt(pos);
      if (nl.from === pos && nl.text === l.text) continue;
      extra.push(lineRange(doc, n));
      const p = partnerOf(doc, n);
      if (p) extra.push(lineRange(doc, p));
    }
    if (!extra.length && test.newDoc.eq(tr.newDoc)) return tr;
    // merge the deletions with the edit's own changes (ranges in one spec must not overlap)
    const all = [...changes, ...extra.map(([from, to]) => ({ from, to, insert: "" }))].sort((x, y) => x.from - y.from || x.to - y.to);
    const merged = [];
    for (const c of all) {
      const last = merged[merged.length - 1];
      if (last && c.from < last.to) { last.to = Math.max(last.to, c.to); last.insert += c.insert; } else merged.push({ ...c });
    }
    const annotations = [];
    const ev = tr.annotation(CM.Transaction.userEvent);
    if (ev) annotations.push(CM.Transaction.userEvent.of(ev));
    if (extra.length) annotations.push(label.of(`Tags taken out — ${[...tags].map((n) => doc.line(n).text.trim()).filter((t) => !t.startsWith("[/")).join(", ") || [...tags].map((n) => doc.line(n).text.trim()).join(", ")}`));
    const spec = { changes: merged, annotations };
    if (cursorAfter && !extra.length) {
      const [at, len] = cursorAfter, cs = tr.startState.update({ changes: merged, filter: false }).changes;
      spec.selection = { anchor: cs.mapPos(at, -1) + len };
    }
    return spec;
  });
  // In a written-out table of contents ([contents] … [/contents]) each entry's page reference stays: deleting whole
  // entry lines leaves them out instead ("// " in front, which also keeps them from being added back); deleting just
  // a reference is refused (onRefused says why). Edits reaching outside the block (Select All …) are left alone.
  // the [contents] … [/contents] block around line n: { open, close } (line numbers of the two tags), or null
  const contentsBlock = (doc, n) => {
    let open = 0, close = 0;
    for (let i = n - 1; i >= 1 && !open; i--) {
      const t = doc.line(i).text.trim();
      if (isSep(doc.line(i).text) || /^\[\/contents\]$/i.test(t)) return null;
      if (/^\[contents\]$/i.test(t)) open = i;
    }
    for (let i = n + 1; i <= doc.lines && !close; i++) {
      const t = doc.line(i).text.trim();
      if (isSep(doc.line(i).text) || /^\[contents\]$/i.test(t)) break;
      if (/^\[\/contents\]$/i.test(t)) close = i;
    }
    return open ? { open, close: close || doc.lines + 1 } : null;
  };
  let onRefused = () => {};
  const refGuard = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || tr.annotation(CM.Transaction.addToHistory) === false) return tr;
    const doc = tr.startState.doc;
    let rows = [], refused = false, outside = false;
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      if (fromA === toA || /\[page(?:\s+\d+)?\s+of\s+[^\]]+\]/i.test(inserted.toString())) return;   // (a reference swapped for another: fine)
      const first = doc.lineAt(fromA).number, last = doc.lineAt(toA).number;
      for (let n = first; n <= last; n++) {
        const line = doc.line(n);
        const refs = [...line.text.matchAll(REF)].filter((m) => fromA < line.from + m.index + m[0].length && toA > line.from + m.index);
        if (!refs.length) continue;
        // (an edit that reaches a tag of the block, or past it — Select All … — isn't one of these)
        const block = contentsBlock(doc, n);
        if (!block || first <= block.open || last >= block.close) { outside = true; continue; }
        const whole = fromA <= line.from && toA >= line.to;
        if (whole) rows.push(n); else refused = true;
      }
    });
    if (outside || (!rows.length && !refused)) return tr;
    if (refused) { onRefused("The page references in the table of contents stay. To leave an entry out, delete its whole line (or put // in front)."); return []; }
    // whole entry lines deleted: left out instead
    const changes = [...new Set(rows)].filter((n) => !doc.line(n).text.trim().startsWith("//")).map((n) => ({ from: doc.line(n).from, insert: "// " }));
    return changes.length ? { changes, annotations: [label.of("Left out of the table of contents"), CM.Transaction.userEvent.of("delete")] } : [];
  });

  // Search and replace (Ctrl+F) leaves alone what it mustn't change — a chapter's title bar, a [tag] line of a pair, part
  // of a page reference — and replaces everywhere else. (One of those among the matches used to stop a whole
  // "replace all", or with a tag, take the tag pair out.)
  const replaceGuard = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !tr.isUserEvent("input.replace")) return tr;
    const doc = tr.startState.doc, keep = [];
    let skipped = 0;
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      let bad = false;
      for (let n = doc.lineAt(fromA).number; n <= doc.lineAt(toA).number && !bad; n++) {
        const line = doc.line(n);
        if (isSep(line.text) || tagAt(doc, n)) bad = true;
        else for (const m of line.text.matchAll(REF)) if (fromA < line.from + m.index + m[0].length && toA > line.from + m.index) bad = true;
      }
      if (bad) skipped++; else keep.push({ from: fromA, to: toA, insert: inserted });
    });
    if (!skipped) return tr;
    onRefused(`${skipped} of the matches left as they are: in a chapter's title bar, a [tag] line or a page reference.`);
    return keep.length ? { changes: keep, annotations: [CM.Transaction.userEvent.of(tr.annotation(CM.Transaction.userEvent))] } : [];
  });

  // the tag at the cursor and its partner: marked
  const tagPairLine = CM.Decoration.line({ class: "cm-tag-pair" });
  const tagPairs = CM.ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.find(view.state); }
    update(u) { if (u.docChanged || u.selectionSet) this.decorations = this.find(u.state); }
    find(state) {
      const doc = state.doc, n = doc.lineAt(state.selection.main.head).number;
      if (!tagAt(doc, n)) return CM.Decoration.none;
      const lines = [n, partnerOf(doc, n)].filter(Boolean).sort((a, b) => a - b);
      return CM.Decoration.set(lines.map((i) => tagPairLine.range(doc.line(i).from)));
    }
  }, { decorations: (p) => p.decorations });

  // ---- page references: the page number each one prints, shown after it (from the last layout of the pages).
  // A click sets a number by hand ([page 12 of …]) or, left empty, goes back to the automatic one. ----
  const REF = /\[page(?:\s+(\d+))?\s+of\s+([^\]\/]+?)(?:\s*\/\s*([^\]]+?))?\s*\]/gi;
  const refKey = (name, entry) => name.trim().replace(/\.txt$/i, "") + (entry ? " / " + entry.trim() : "");
  const refText = (name, entry, fixed) => `[page${fixed ? " " + fixed : ""} of ${name.trim()}${entry ? " / " + entry.trim() : ""}]`;
  let pageNumbers = {};
  const newPages = CM.StateEffect.define();
  // A page reference is shown as one chip in place of its tag ("11-3-three-refuges · p. 9"): it can't be typed into
  // (a changed name would point nowhere), Backspace takes it out whole, and a click sets the number by hand.
  class PageNum extends CM.WidgetType {
    constructor(key, auto, fixed) { super(); this.key = key; this.auto = auto; this.fixed = fixed; }
    eq(o) { return o.key === this.key && o.auto === this.auto && o.fixed === this.fixed; }
    toDOM(view) {
      const auto = this.auto ?? "?";
      const el = Object.assign(document.createElement("span"), { className: "cm-pagenum" + (this.fixed ? " fixed" : ""),
        textContent: `${this.key} · ` + (this.fixed ? `p. ${this.fixed} set by hand (automatic ${auto})` : `p. ${auto}`),
        title: `The page of “${this.key}” — click to type a number by hand, or to go back to the automatic one` });
      el.onmousedown = (ev) => {
        ev.preventDefault();
        const pos = view.posAtDOM(el), line = view.state.doc.lineAt(pos);
        const m = [...line.text.matchAll(REF)].find((r) => line.from + r.index <= pos && pos <= line.from + r.index + r[0].length);
        if (!m) return;
        const start = line.from + m.index;
        const answer = prompt(`Page number to print here (the automatic one is ${auto}).\nLeave it empty to use the automatic number, which follows any changes.`, this.fixed || "");
        if (answer === null) return;
        const n = answer.trim();
        if (n && !/^\d+$/.test(n)) return alert("Please type a page number (digits only), or leave it empty.");
        view.dispatch({ changes: { from: start, to: start + m[0].length, insert: refText(m[2], m[3], n) },
          annotations: label.of(n ? `Page number ${n} set by hand` : "Back to the automatic page number") });
      };
      return el;
    }
    ignoreEvent() { return true; }
  }
  function pageDecos(view) {
    const b = new CM.RangeSetBuilder(), doc = view.state.doc;
    for (const { from, to } of view.visibleRanges) {
      for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
        const line = doc.line(n);
        if (line.text.trim().startsWith("//")) continue;
        for (const m of line.text.matchAll(REF)) {
          const key = refKey(m[2], m[3]);
          b.add(line.from + m.index, line.from + m.index + m[0].length, CM.Decoration.replace({ widget: new PageNum(key, pageNumbers[key], m[1]) }));
        }
      }
    }
    return b.finish();
  }
  const pageNums = CM.ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = pageDecos(view); }
    update(u) { if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(newPages)))) this.decorations = pageDecos(u.view); }
  }, { decorations: (p) => p.decorations, provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations || CM.Decoration.none) });

  // ---- changed lines: a dot beside each line that differs from the original text ----
  // The original is a second document (same chapter header lines); @codemirror/merge's Chunk works out which lines
  // differ and keeps that up to date as you type. Clicking a dot puts that line (or, where lines were added or
  // removed, that group of lines) back to the original; a hollow "ghost" dot stays, and clicking it puts your
  // change back. Both are ordinary edits, so Undo/Redo work on them too.
  const label = CM.Annotation.define();   // a description of an edit for the Undo/Redo lists
  const addGhost = CM.StateEffect.define(), dropGhost = CM.StateEffect.define();
  const newOriginal = CM.StateEffect.define();   // the original text changed (the table of contents following the chapters)
  const diffField = CM.StateField.define({
    create: (state) => ({ original: state.doc, chunks: [] }),
    update: (v, tr) => {
      for (const e of tr.effects) if (e.is(newOriginal)) return { original: e.value, chunks: CM.Chunk.build(e.value, tr.newDoc) };
      return tr.docChanged ? { original: v.original, chunks: CM.Chunk.updateB(v.chunks, v.original, tr.newDoc, tr.changes) } : v;
    },
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
  function build(box, { onChange, onCursor = () => {}, header, check, where = (n) => "line " + n, onHistory = () => {}, marked = () => true, refused = () => {} }) {
    onRefused = refused;
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
        const actions = p.fix ? [{ name: p.fix.name, apply: (v, a, b) => v.dispatch({ changes: { from: a, to: b, insert: p.fix.insert } }) }] : undefined;
        return { from, to, severity: p.severity, message: p.message, actions };
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
        // (transaction filters run last-listed first: replaceGuard before refGuard, pairGuard, guard)
        changeGutter, basicSetup, EditorView.lineWrapping, liturgy, syntaxHighlighting(colours), theme, headerField, guard, pairGuard, refGuard, replaceGuard, tagPairs, clipboard, lint, lintGutter(),
        alignSlot.of(alignExt()), groupShading, pageNums,
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
      // the page numbers from the latest layout ({ "chapter": 3, "chapter / part": 7 }): shown after page references
      setPages(map) { pageNumbers = map || {}; view.dispatch({ effects: [newPages.of(null), recheck.of(null)] }); CM.forceLinting(view); },
      // a change that isn't a step of its own in Undo (the table of contents following the chapters); original: the
      // whole document as it would be originally now, if that changed too (so the lines that follow aren't marked)
      replaceQuietly(from, to, text, original) {
        view.dispatch({ changes: { from, to, insert: text }, annotations: CM.Transaction.addToHistory.of(false),
          effects: original != null ? newOriginal.of(CM.EditorState.create({ doc: original }).doc) : [] });
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

  root.LiturgyText = { build, setSuggesting, setAligning, SEP, isSep, REF, refKey, refText };
})(window);
