// Entry for vendor/codemirror.min.js — the CodeMirror 6 pieces the editor uses, as one browser script
// (global `CM`). Rebuild with: npm run vendor
export { EditorView, keymap, Decoration, WidgetType, ViewPlugin, gutter, GutterMarker } from "@codemirror/view";
export { EditorState, Compartment, StateEffect, StateField, RangeSetBuilder, Prec, Transaction, Annotation } from "@codemirror/state";
export { basicSetup } from "codemirror";
export { StreamLanguage, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
export { tags } from "@lezer/highlight";
export { linter, lintGutter, forceLinting } from "@codemirror/lint";
export { undo, redo, undoDepth, redoDepth, isolateHistory } from "@codemirror/commands";
// which lines differ from the original text (the dots beside the line numbers)
export { Chunk } from "@codemirror/merge";
