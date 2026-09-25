// settings.js — the Settings drawer (top bar). Builds one control per variable in css/settings.css (labels and hints come
// from the file's own comments), and turns the editor's changes into a small stylesheet that overrides it.
(function (root) {
  "use strict";

  // Fonts that may be picked for each kind of text. Pinyin must pass the tone-mark check (see CLAUDE.md).
  // No generic "serif" at the end: book.css adds "Liturgy Extra" after these for rare characters.
  const FONT_CHOICES = {
    "--pinyin-font": ['"Gentium Book Plus"'],
    "--chinese-font": ['"Noto Serif TC"'],
    // English and page numbers: fonts bundled in fonts/ that passed the tone-mark check
    default: ['"Lora"', '"Gentium Book Plus"', '"Crimson Pro"', '"Alegreya"', '"Libre Baskerville"', '"Merriweather"',
      '"Noto Serif"', '"Source Serif 4"', '"Noto Sans"', '"Source Sans 3"'],
  };
  const WEIGHTS = { 400: "regular", 600: "semibold" };
  // Format and binding: shown as one nested choice (formatControl)
  const BINDING_PARTS = ["--format", "--binding", "--signature-sheets"];
  const FORMAT_TEXT = {
    letter: ["Regular letter size", "pages 8.5 × 11 in, printed in order on both sides; no cutting; can be stapled"],
    folio: ["Folio", "letter sheets printed two pages a side — pages 5.5 × 8.5 in"],
    quarto: ["Quarto", "letter sheets printed four pages a side — pages 4.25 × 5.5 in"],
  };
  const BINDING_TEXT = {
    folio: { perfect: ["Perfect bound", "one cut per sheet (down the middle), the halves stacked in page order; glued, or can be stapled"],
      signatures: ["Signatures", "no cutting: sheets folded in half and nested; one signature can be stapled, several are sewn and glued"] },
    quarto: { perfect: ["Perfect bound", "two cuts per sheet (into quarters), the pieces stacked in page order; glued, or can be stapled"],
      signatures: ["Signatures", "one cut per sheet — coming soon", true] },
  };
  // Settings that are a choice between named options (value → what the editor sees)
  const CHOICES = {
    "--page-number-position": { outside: "outside corner (away from the binding)", inside: "inside corner (by the binding)", center: "centred" },
    "--page-number-edge": { bottom: "at the bottom", top: "at the top" },
    "--verse-order": { "en-zh-py": "English, Chinese, pinyin", "zh-py-en": "Chinese, pinyin, English",
      "py-zh-en": "pinyin, Chinese, English", "en-py-zh": "English, pinyin, Chinese" },
    "--title-start": { page: "on a new page", auto: "straight after the text before" },
    "--chapter-start": { page: "on a new page", right: "on a new right-hand page", auto: "straight after the chapter before" },
    "--border-style": { solid: "a single line", double: "a double line (needs thickness 2pt or more)", dashed: "dashes", dotted: "dots" },
    "--signature-sheets": { auto: "automatic — split evenly, at most 8 sheets (32 pages) each", all: "one signature (all sheets folded together)",
      2: "2 sheets (8 pages)", 3: "3 sheets (12 pages)", 4: "4 sheets (16 pages)", 5: "5 sheets (20 pages)", 6: "6 sheets (24 pages)", 7: "7 sheets (28 pages)", 8: "8 sheets (32 pages)" },
    "--blank-page": { before: "just before the span", "chapter-end": "at the end of the chapter before" },
  };
  const STEP = { in: 0.05, pt: 0.1, em: 0.02, px: 1, mm: 1, cm: 0.1 };

  // Reads settings.css → [{ section, title, items: [{ name, value, hint }] }]: sections are /* ==== Name ==== */ (shown
  // as panels that open and close), groups inside them /* ---- Name ---- */
  function parse(css) {
    const groups = [];
    let section = "";
    for (const line of css.split("\n")) {
      const sec = line.match(/^\s*\/\*\s*={2,}\s*(.*?)\s*={2,}\s*\*\/\s*$/);
      if (sec) { section = sec[1]; groups.push({ section, title: "", items: [] }); continue; }
      const head = line.match(/^\s*\/\*\s*-{2,}\s*(.*?)\s*-{2,}\s*\*\/\s*$/);
      if (head) { groups.push({ section, title: head[1], items: [] }); continue; }
      const v = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+?)\s*;\s*(?:\/\*\s*(.*?)\s*\*\/)?\s*$/);
      if (v) {
        if (!groups.length) groups.push({ section, title: "", items: [] });
        groups[groups.length - 1].items.push({ name: v[1], value: v[2], hint: v[3] || "" });
      }
    }
    return groups.filter((g) => g.items.length);
  }

  // Reads the variables out of a stylesheet like the one toCss() writes
  function values(css) {
    const out = {};
    for (const m of (css || "").matchAll(/(--[\w-]+)\s*:\s*([^;]+?)\s*;/g)) out[m[1]] = m[2];
    return out;
  }

  // Changed values → a stylesheet that goes after settings.css
  function toCss(changed, groups) {
    const hints = {};
    groups.forEach((g) => g.items.forEach((i) => (hints[i.name] = i.hint)));
    const lines = Object.entries(changed).map(([k, v]) => `  ${k}: ${v};` + (hints[k] ? `  /* ${hints[k]} */` : ""));
    return lines.length ? `/* Booklet settings changed in the editor. Anything not listed here uses the app's css/settings.css. */\n:root {\n${lines.join("\n")}\n}\n` : "";
  }

  const label = (name) => { const s = name.replace(/^--/, "").replace(/-/g, " "); return s[0].toUpperCase() + s.slice(1); };
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

  // Builds the panel. `get()` → current changes {name: value}; `set(changes)` is called on every edit.
  // opts.isOpen(section) / opts.setOpen(section, open): which sections are open (the editor keeps it per booklet).
  function build(box, groups, get, set, opts = {}) {
    const { isOpen = () => false, setOpen = () => {} } = opts;
    box.textContent = "";
    const intro = el("p", { className: "hint", textContent: "Changes show in the pages straight away. Settings shown with a yellow background are ones changed from the app's defaults; ↺ puts one back." });
    const resetAll = el("button", { type: "button", textContent: "Set everything back to the defaults", title: "Every setting goes back to the app's default (Save to keep that)", onclick: () => { set({}); build(box, groups, get, set, opts); } });
    box.append(intro, resetAll);

    const sections = new Map();
    for (const g of groups) {
      if (!sections.has(g.section)) {
        const d = el("details", { className: "section", open: isOpen(g.section) }, el("summary", { textContent: g.section || "Other" }));
        d.ontoggle = () => setOpen(g.section, d.open);
        sections.set(g.section, d);
        box.append(d);
      }
      const d = sections.get(g.section);
      const fs = el("fieldset", {}, ...(g.title ? [el("legend", { textContent: g.title })] : []));
      for (const item of g.items) {
        if (item.name === "--format") fs.append(formatControl(g.items));
        else if (!BINDING_PARTS.includes(item.name)) fs.append(control(item));
      }
      d.append(fs);
      // a section holding changed settings says so while closed
      if (g.items.some((i) => i.name in get())) d.classList.add("has-changes");
    }

    // Format and binding: one nested choice (format → binding → sheets per signature). Picking a format also sets
    // the page size. The numbers below it (pages printed, sheets, signatures) are filled in by the editor.
    function formatControl(items) {
      const dflt = Object.fromEntries(items.map((i) => [i.name, i.value]));
      const now = () => LiturgyImpose.mode({ format: get()["--format"] ?? dflt["--format"], binding: get()["--binding"] ?? dflt["--binding"], sheets: get()["--signature-sheets"] ?? dflt["--signature-sheets"] });
      const pageDefaults = Object.fromEntries(groups.flatMap((g) => g.items).filter((i) => /^--page-(width|height)$/.test(i.name)).map((i) => [i.name, i.value]));
      const apply = (m, sizeToo) => {
        const c = { ...get(), "--format": m.format, "--binding": m.binding, "--signature-sheets": m.sheets };
        if (sizeToo) [c["--page-width"], c["--page-height"]] = LiturgyImpose.FORMATS[m.format];
        for (const k of Object.keys(c)) if ((dflt[k] ?? pageDefaults[k]) === c[k] && (k in dflt || k in pageDefaults)) delete c[k];
        set(c);
        build(box, groups, get, set, opts);   // (the page size controls below show the new size)
      };
      const m = now(), wrap = el("div", { className: "format-choice" });
      const radio = (name, value, checked, title, hint, onpick, disabled) => el("label", { className: "choice" + (disabled ? " disabled" : "") },
        el("input", { type: "radio", name, value, checked, disabled, onchange: onpick }), el("b", { textContent: title }), el("span", { className: "hint", textContent: " — " + hint }));
      for (const [format, [title, hint]] of Object.entries(FORMAT_TEXT)) {
        const on = m.format === format;
        wrap.append(radio("format", format, on, title, hint, () => apply({ ...m, format, binding: "perfect" }, true)));
        if (!on || !BINDING_TEXT[format]) continue;
        const sub = el("div", { className: "sub" });
        for (const [binding, [t, h, soon]] of Object.entries(BINDING_TEXT[format])) {
          sub.append(radio("binding", binding, m.binding === binding, t, h, () => apply({ ...m, binding }), soon));
          if (binding === "signatures" && m.binding === "signatures") {
            const pick = el("select", { id: "set--signature-sheets" }, ...Object.entries(CHOICES["--signature-sheets"]).map(([v, n]) => el("option", { value: v, textContent: n })));
            pick.value = m.sheets;
            pick.onchange = () => apply({ ...m, sheets: pick.value });
            sub.append(el("label", { className: "sub sheets" }, el("span", { textContent: "Sheets per signature " }), pick));
          }
        }
        wrap.append(sub);
      }
      wrap.append(el("div", { id: "binding-metrics", className: "metrics" }));
      return wrap;
    }

    function control(item) {
      const current = () => get()[item.name] ?? item.value;
      const row = el("div", { className: "setting" });
      const id = "set" + item.name;
      const reset = el("button", { type: "button", className: "reset", title: `Back to ${item.value}`, textContent: "↺" });
      const update = (value) => {
        const changed = { ...get() };
        if (value === item.value || value === "") delete changed[item.name]; else changed[item.name] = value;
        set(changed);
        reset.hidden = !(item.name in changed);
        row.classList.toggle("changed", !reset.hidden);
      };
      let input;
      const num = current().match(/^(-?\d*\.?\d+)([a-z%]*)$/);
      if (/-font$/.test(item.name)) {
        const choices = FONT_CHOICES[item.name] || FONT_CHOICES.default;
        const SANS = ['"Noto Sans"', '"Source Sans 3"'];
        input = el("select", { id }, ...[...new Set([current(), ...choices])].map((f) => el("option", { value: f,
          textContent: f.split(",")[0].replace(/"/g, "") + (SANS.includes(f) ? " (plain, sans-serif)" : ""), style: `font-family: ${f}` })));
        input.value = current();
        input.onchange = () => update(input.value);
      } else if (CHOICES[item.name]) {
        input = el("select", { id }, ...Object.entries(CHOICES[item.name]).map(([v, n]) => el("option", { value: v, textContent: n })));
        input.value = current();
        input.onchange = () => update(input.value);
      } else if (/-weight$/.test(item.name)) {
        input = el("select", { id }, ...Object.entries(WEIGHTS).map(([w, n]) => el("option", { value: w, textContent: n })));
        input.value = current();
        input.onchange = () => update(input.value);
      } else if (/-color$/.test(item.name)) {
        input = el("input", { id, type: "color", value: current() });
        input.oninput = () => update(input.value);
      } else if (num) {
        const unit = num[2], dflt = parseFloat(item.value.match(/^-?\d*\.?\d+/)?.[0] || num[1]);
        const step = STEP[unit] || 0.05;
        const lo = Math.min(0, dflt * 2), hi = Math.max(dflt * 2.5, step * 20);
        const round = (x) => +(+x).toFixed(3);
        const range = el("input", { type: "range", min: lo, max: hi, step, value: num[1], ariaLabel: label(item.name) });
        const box = el("input", { id, type: "number", step, value: num[1], className: "num" });
        range.oninput = () => { box.value = round(range.value); update(round(range.value) + unit); };
        box.oninput = () => { if (box.value !== "") { range.value = box.value; update(round(box.value) + unit); } };
        input = el("span", { className: "numbox" }, range, box, el("span", { className: "unit", textContent: unit }));
        reset.onclick = () => { range.value = box.value = dflt; update(item.value); };
      } else if (/^".*"$/.test(item.value)) {
        // a piece of text: shown and typed without the quote marks CSS needs
        const unq = (v) => v.replace(/^"|"$/g, "").replace(/\\"/g, '"');
        input = el("input", { id, value: unq(current()) });
        input.oninput = () => update(`"${input.value.replace(/"/g, '\\"')}"`);
        reset.onclick = () => { input.value = unq(item.value); update(item.value); };
      } else {
        input = el("input", { id, value: current() });
        input.oninput = () => update(input.value.trim());
      }
      if (!reset.onclick) reset.onclick = () => { input.value = item.value; update(item.value); };
      reset.hidden = !(item.name in get());
      row.classList.toggle("changed", !reset.hidden);
      row.append(el("label", { htmlFor: id, textContent: label(item.name) }), input, reset);
      if (item.hint) row.append(el("div", { className: "hint", textContent: item.hint }));
      return row;
    }
  }

  root.LiturgySettings = { parse, values, toCss, build };
})(window);
