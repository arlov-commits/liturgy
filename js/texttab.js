// texttab.js — the Text tab: one CodeMirror editor, one section file at a time, coloured by FORMAT.md's rules.
(function (root) {
  "use strict";
  const { EditorView, EditorState, basicSetup, StreamLanguage, HighlightStyle, syntaxHighlighting, tags, linter, lintGutter } = CM;

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

  // Problems (pinyin checks from parse.js, or whatever `check` gives) as underlines + gutter marks
  // (a problem may give from/to columns within its line; otherwise the whole line is marked)
  const problems = (check) => linter((view) => {
    const text = view.state.doc.toString();
    return [...check(text), ...(check === LiturgyParse.check || check.withSuggestions ? suggestions(text) : [])].map((p) => {
      const line = view.state.doc.line(Math.min(p.line, view.state.doc.lines));
      const from = p.from != null ? line.from + Math.min(p.from, line.length) : line.from;
      const to = p.to != null ? line.from + Math.min(p.to, line.length) : line.to;
      return { from, to, severity: p.severity, message: p.message };
    });
  }, { delay: 400, needsRefresh: (u) => u.transactions.some((t) => t.effects.some((e) => e.is(recheck))) });

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

  // One editor for several files. An entry = { name, label, text, check?(text) → problems }; the editor
  // writes edits back into entry.text. `onChange(entry)` after each edit; `onCursor(entry, line)` when the
  // cursor moves. Returns { setEntries(entries), show(name, line), setText(name, text), view, current() }.
  function build(box, select, onChange, onCursor = () => {}) {
    const states = {};
    let entries = [];
    let current = null;
    const view = new EditorView({ parent: box });
    const stateFor = (e) => states[e.name] || (states[e.name] = EditorState.create({
      doc: e.text,
      extensions: [
        basicSetup, EditorView.lineWrapping, liturgy, syntaxHighlighting(colours), theme, problems(e.check || LiturgyParse.check), lintGutter(),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) { e.text = u.state.doc.toString(); onChange(e); }
          if (u.docChanged || u.selectionSet) onCursor(e, u.state.doc.lineAt(u.state.selection.main.head).number);
        }),
      ],
    }));
    function show(name, line) {
      const e = entries.find((x) => x.name === name) || entries[0];
      if (e !== current) {
        if (current) states[current.name] = view.state;
        current = e;
        view.setState(stateFor(e));
        select.value = e.name;
      }
      if (line) {
        const l = view.state.doc.line(Math.min(line, view.state.doc.lines));
        view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
        view.focus();
      }
    }
    // Replace a file's whole text as one edit (so it can be undone)
    function setText(name, text) {
      const e = entries.find((x) => x.name === name);
      if (e === current) return view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      const st = stateFor(e);
      states[e.name] = st.update({ changes: { from: 0, to: st.doc.length, insert: text } }).state;
      e.text = text;
      onChange(e);
    }
    function setEntries(list) {
      entries = list;
      select.textContent = "";
      for (const e of entries) select.append(Object.assign(document.createElement("option"), { value: e.name, textContent: e.label || e.name }));
      if (current && entries.includes(current)) select.value = current.name;
      else if (entries.length) show(entries[0].name);
    }
    select.onchange = () => show(select.value);
    return { setEntries, show, setText, view, current: () => current };
  }

  root.LiturgyText = { build, setSuggesting };
})(window);
