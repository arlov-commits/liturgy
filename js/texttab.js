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

  // options: onChange(docText), onCursor(line), header(name) → element for a chapter's title bar,
  // check(docText) → problems [{ line, from?, to?, severity, message }]
  // Returns { setDoc(text), replace(from, to, text), goto(line), refreshHeaders(), view }.
  function build(box, { onChange, onCursor = () => {}, header, check }) {
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
    // nothing may change a header line, or put text before the first one
    const guard = EditorState.transactionFilter.of((tr) => {
      if (!tr.docChanged) return tr;
      const ok = headerLines(tr.startState.doc) === headerLines(tr.newDoc) && (tr.newDoc.length === 0 || isSep(tr.newDoc.line(1).text));
      return ok ? tr : [];
    });
    const lint = linter((view) => {
      const text = view.state.doc.toString();
      return [...check(text), ...suggestions(text)].map((p) => {
        const line = view.state.doc.line(Math.min(p.line, view.state.doc.lines));
        const from = p.from != null ? line.from + Math.min(p.from, line.length) : line.from;
        const to = p.to != null ? line.from + Math.min(p.to, line.length) : line.to;
        return { from, to, severity: p.severity, message: p.message };
      });
    }, { delay: 500, needsRefresh: (u) => u.transactions.some((t) => t.effects.some((e) => e.is(recheck))) });
    const create = (doc) => EditorState.create({
      doc,
      extensions: [
        basicSetup, EditorView.lineWrapping, liturgy, syntaxHighlighting(colours), theme, headerField, guard, lint, lintGutter(),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange(u.state.doc.toString());
          if (u.docChanged || u.selectionSet) onCursor(u.state.doc.lineAt(u.state.selection.main.head).number);
        }),
      ],
    });
    const view = new EditorView({ parent: box, state: create("") });
    return {
      view,
      // a new document (e.g. chapters added or removed): starts a fresh undo history
      setDoc(text) { view.setState(create(text)); },
      // one undoable change (e.g. a chapter back to its original text)
      replace(from, to, text) { view.dispatch({ changes: { from, to, insert: text } }); },
      goto(line, focus = true) {
        const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
        view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "start", yMargin: 40 }) });
        if (focus) view.focus();
      },
      refreshHeaders() { version++; view.dispatch({ effects: redraw.of(null) }); },
    };
  }

  root.LiturgyText = { build, setSuggesting, SEP, isSep };
})(window);
