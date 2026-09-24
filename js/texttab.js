// texttab.js — the Text tab: one CodeMirror editor, one section file at a time, coloured by FORMAT.md's rules.
(function (root) {
  "use strict";
  const { EditorView, EditorState, basicSetup, StreamLanguage, HighlightStyle, syntaxHighlighting, tags, linter, lintGutter } = CM;

  // Same line rules as js/parse.js (see FORMAT.md)
  const HAS_CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]|[\u{20000}-\u{2ffff}]/u;
  const REPEAT = /^x\d+$/i;
  const liturgy = StreamLanguage.define({
    name: "liturgy",
    startState: () => ({ afterChinese: false }),
    blankLine: (state) => { state.afterChinese = false; },
    token(stream, state) {
      const line = stream.string.trim();
      const afterChinese = state.afterChinese;
      state.afterChinese = false;
      stream.skipToEnd();
      if (line.startsWith("//")) return "comment";
      if (line === "---") return "pageBreak";
      if (REPEAT.test(line)) return "repeat";
      if (line.includes("|") && HAS_CJK.test(line)) return "mantra";
      if (HAS_CJK.test(line)) { state.afterChinese = true; return "chinese"; }
      if (/^#{1,2}(\s|$)/.test(line)) return "heading";
      return afterChinese ? "pinyin" : null;
    },
    tokenTable: { pageBreak: tags.processingInstruction, repeat: tags.keyword, mantra: tags.special(tags.string), chinese: tags.string, pinyin: tags.atom },
  });
  const colours = HighlightStyle.define([
    { tag: tags.comment, color: "#8a8a8a", fontStyle: "italic" },
    { tag: tags.processingInstruction, color: "#b00", fontWeight: "bold", backgroundColor: "#fde8e8" },
    { tag: tags.heading, color: "#8a5a00", fontWeight: "bold" },
    { tag: tags.keyword, color: "#0a6b8a", fontWeight: "bold" },
    { tag: tags.string, color: "#222" },
    { tag: tags.special(tags.string), color: "#6a3d9a" },
    { tag: tags.atom, color: "#2a7a3a" },
  ]);
  const theme = EditorView.theme({
    "&": { height: "100%", fontSize: "15px", backgroundColor: "#fff" },
    ".cm-scroller": { fontFamily: '"Gentium Book Plus", "Noto Serif TC", serif', lineHeight: "1.55" },
  });

  // Pinyin checks from parse.js, shown as underlines + gutter marks
  const pinyinCheck = linter((view) => LiturgyParse.check(view.state.doc.toString()).map((p) => {
    const line = view.state.doc.line(Math.min(p.line, view.state.doc.lines));
    return { from: line.from, to: line.to, severity: p.severity, message: p.message };
  }), { delay: 400 });

  // `sections` = [{ name, text }]; `onChange(section)` after each edit. Returns { show(name), view }.
  function build(box, select, sections, onChange, extensions = []) {
    const states = {};
    let current = null;
    const view = new EditorView({ parent: box });
    const stateFor = (s) => states[s.name] || (states[s.name] = EditorState.create({
      doc: s.text,
      extensions: [
        basicSetup, EditorView.lineWrapping, liturgy, syntaxHighlighting(colours), theme, pinyinCheck, lintGutter(), ...extensions,
        EditorView.updateListener.of((u) => { if (u.docChanged) { s.text = u.state.doc.toString(); onChange(s); } }),
      ],
    }));
    function show(name) {
      const s = sections.find((x) => x.name === name) || sections[0];
      if (current) states[current.name] = view.state;
      current = s;
      view.setState(stateFor(s));
      select.value = s.name;
    }
    select.textContent = "";
    for (const s of sections) select.append(Object.assign(document.createElement("option"), { value: s.name, textContent: s.name.replace(/\.txt$/, "") }));
    select.onchange = () => show(select.value);
    if (sections.length) show(sections[0].name);
    return { show, view, current: () => current };
  }

  root.LiturgyText = { build };
})(window);
