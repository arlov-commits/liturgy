// settings.js — the Settings tab. Builds one control per variable in css/settings.css (labels and hints come
// from the file's own comments), and turns the editor's changes into a small stylesheet that overrides it.
(function (root) {
  "use strict";

  // Fonts that may be picked for each kind of text. Pinyin must pass the tone-mark check (see CLAUDE.md).
  // No generic "serif" at the end: book.css adds "Liturgy Extra" after these for rare characters.
  const FONT_CHOICES = {
    "--pinyin-font": ['"Gentium Book Plus"'],
    "--chinese-font": ['"Noto Serif TC"'],
    default: ['"Lora"', '"Gentium Book Plus"'],
  };
  const WEIGHTS = { 400: "regular", 600: "semibold" };
  // Settings that are a choice between named options (value → what the editor sees)
  const CHOICES = {
    "--chapter-start": { page: "on a new page", right: "on a new right-hand page", auto: "straight after the chapter before" },
    "--border-style": { solid: "a single line", double: "a double line (needs thickness 2pt or more)", dashed: "dashes", dotted: "dots" },
    "--blank-page": { before: "just before the span", "chapter-end": "at the end of the chapter before" },
  };
  const STEP = { in: 0.05, pt: 0.1, em: 0.02, px: 1, mm: 1, cm: 0.1 };

  // Reads settings.css → [{ title, items: [{ name, value, hint }] }]
  function parse(css) {
    const groups = [];
    for (const line of css.split("\n")) {
      const head = line.match(/^\s*\/\*\s*-{2,}\s*(.*?)\s*-{2,}\s*\*\/\s*$/);
      if (head) { groups.push({ title: head[1], items: [] }); continue; }
      const v = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+?)\s*;\s*(?:\/\*\s*(.*?)\s*\*\/)?\s*$/);
      if (v) {
        if (!groups.length) groups.push({ title: "", items: [] });
        groups[groups.length - 1].items.push({ name: v[1], value: v[2], hint: v[3] || "" });
      }
    }
    return groups;
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

  // Builds the tab. `get()` → current changes {name: value}; `set(changes)` is called on every edit.
  function build(box, groups, get, set) {
    box.textContent = "";
    const intro = el("p", { className: "hint", textContent: "Changes show in the pages straight away. Use Save to keep them. Highlighted settings differ from the defaults; ↺ puts one back." });
    const resetAll = el("button", { type: "button", textContent: "Set everything back to the defaults", title: "Every setting goes back to the app's default (Save to keep that)", onclick: () => { set({}); build(box, groups, get, set); } });
    box.append(intro, resetAll);

    for (const g of groups) {
      const fs = el("fieldset", {}, el("legend", { textContent: g.title }));
      for (const item of g.items) fs.append(control(item));
      box.append(fs);
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
        input = el("select", { id }, ...[...new Set([current(), ...choices])].map((f) => el("option", { value: f, textContent: f.split(",")[0].replace(/"/g, "") })));
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
