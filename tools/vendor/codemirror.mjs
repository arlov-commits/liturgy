// Entry for vendor/codemirror.min.js — the CodeMirror 6 pieces the editor uses, as one browser script
// (global `CM`). Rebuild with: npm run vendor
export { EditorView, keymap } from "@codemirror/view";
export { EditorState, Compartment } from "@codemirror/state";
export { basicSetup } from "codemirror";
export { StreamLanguage, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
export { tags } from "@lezer/highlight";
export { linter, lintGutter, forceLinting } from "@codemirror/lint";
