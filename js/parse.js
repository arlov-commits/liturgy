// parse.js — turns a liturgy text file (see FORMAT.md) into HTML.
// Works in the browser (window.LiturgyParse) and in Node (require).
(function (root) {
  "use strict";

  const IDEOGRAPH = /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2ffff}]/u;
  const HAS_CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯\u{20000}-\u{2ffff}]/u;
  const REPEAT = /^x\d+$/i;
  // ASCII punctuation inside a Chinese line is shown as its full-width form
  const FULL_WIDTH = { ",": "，", ".": "。", "!": "！", "?": "？", ":": "：", ";": "；" };

  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // problems: list to add { line, severity, message } to (line numbers start at 1)
  function chineseLine(han, pinyin, lineNo, problems) {
    const chars = Array.from(han.trim());
    const syl = pinyin.trim() ? pinyin.trim().split(/\s+/) : [];
    const need = chars.filter((c) => IDEOGRAPH.test(c)).length;
    const ok = need === syl.length;
    let i = 0;
    const cells = chars
      .filter((c) => c.trim())
      .map((c) => {
        if (IDEOGRAPH.test(c)) {
          const p = syl[i++] || "?";
          return `<span class="c"><ruby>${esc(c)}<rt>${esc(p)}</rt></ruby></span>`;
        }
        return `<span class="c p"><ruby>${esc(FULL_WIDTH[c] || c)}<rt>&#8203;</rt></ruby></span>`;
      })
      .join("");
    const flag = ok ? "" : ` data-problem="line ${lineNo}: ${need} characters, ${syl.length} pinyin"`;
    if (!ok) problems.push({ line: lineNo, severity: "error",
      message: syl.length ? `${need} characters but ${syl.length} pinyin syllables — each character needs one syllable` : "No pinyin line under this Chinese line" });
    if (syl.includes("_")) problems.push({ line: lineNo + 1, severity: "warning", message: "Missing pinyin: fill in each _" });
    return `<div class="zh${ok ? "" : " mismatch"}"${flag}>${cells}</div>`;
  }

  function parse(text, name, problems = []) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let block = null;

    const close = () => {
      if (!block) return;
      const cls = ["block"];
      if (block.level === 1) cls.push("title");
      if (block.level === 2) cls.push("subtitle");
      if (block.mantra) cls.push("mantra");
      out.push(`<div class="${cls.join(" ")}" data-line="${block.start}">${block.html.join("")}</div>`);
      block = null;
    };
    const open = (n) => (block = block || { html: [], level: 0, mantra: false, start: n + 1 });

    for (let n = 0; n < lines.length; n++) {
      const raw = lines[n];
      const line = raw.trim();
      if (line.startsWith("//")) continue;
      if (!line) { close(); continue; }
      if (line === "---") { close(); out.push('<div class="page-break"></div>'); continue; }
      open(n);
      if (REPEAT.test(line)) {
        block.html.push(`<div class="repeat">${esc(line)}</div>`);
      } else if (line.includes("|") && HAS_CJK.test(line)) {
        const [roman, han, rep] = line.split("|").map((s) => s.trim());
        block.mantra = true;
        block.html.push(
          `<div class="mline"><span class="roman">${esc(roman)}</span>` +
          `<span class="mzh">${esc(han || "")}</span>` +
          `<span class="repeat">${esc(rep || "")}</span></div>`
        );
      } else if (HAS_CJK.test(line)) {
        const next = (lines[n + 1] || "").trim();
        const hasPinyin = next && !HAS_CJK.test(next) && !next.startsWith("#") && next !== "---" && !REPEAT.test(next);
        block.html.push(chineseLine(line, hasPinyin ? next : "", n + 1, problems));
        if (hasPinyin) n++;
      } else {
        const m = line.match(/^(#{1,2})\s*(.*)$/);
        if (m) block.level = block.level ? Math.min(block.level, m[1].length) : m[1].length;
        block.html.push(`<p class="en">${esc(m ? m[2] : line)}</p>`);
      }
    }
    close();
    return `<section class="sec" data-file="${esc(name || "")}">${out.join("\n")}</section>`;
  }

  // Just the problems of a text file, for the editor
  function check(text) {
    const problems = [];
    parse(text, "", problems);
    return problems;
  }

  const api = { parse, check };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LiturgyParse = api;
})(typeof window !== "undefined" ? window : globalThis);
