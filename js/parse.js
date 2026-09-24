// parse.js — turns a liturgy text file (see FORMAT.md) into HTML.
// Works in the browser (window.LiturgyParse) and in Node (require).
(function (root) {
  "use strict";

  const IDEOGRAPH = /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2ffff}]/u;
  const HAS_CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯\u{20000}-\u{2ffff}]/u;
  const REPEAT = /^x\d+$/i;
  // [keep together] … [/keep together] ([one page] is the older name)
  const KEEP_START = /^\[(keep together|one page)\]$/i, KEEP_END = /^\[\/(keep together|one page)\]$/i;
  const BLANK_PAGE = /^\[blank page\]$/i;
  const CONTENTS = /^\[contents\]$/i, TOC_TITLE = /^\[toc:\s*(.*?)\s*\]$/i;
  // ASCII punctuation inside a Chinese line is shown as its full-width form
  const FULL_WIDTH = { ",": "，", ".": "。", "!": "！", "?": "？", ":": "：", ";": "；" };

  // A section's anchor, from its file name: "05-meng-shan.txt" → "s-05-meng-shan"
  const anchor = (name) => "s-" + String(name).replace(/\.txt$/i, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  // [page of <section>] inside a line → the page that section starts on (filled in by the page engine)
  const PAGE_REF = /\[page of ([^\]]+)\]/gi;
  const inline = (html) => html.replace(PAGE_REF, (m, name) => `<a class="pageref" href="#${anchor(name.trim())}"></a>`);
  const pageRefs = (text) => [...text.matchAll(PAGE_REF)].map((m) => m[1].trim().replace(/\.txt$/i, ""));

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

  // pairs: list to add each Chinese line + its pinyin line to: { line, han, pinyinLine, pinyin } (pinyin untrimmed)
  function parse(text, name, problems = [], pairs = []) {
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
      // the section's name in a table of contents: its first title, unless [toc: …] says otherwise
      if (block.level === 1 && tocTitle === null && block.en.length) tocTitle = block.en.join(" ").replace(/[~\[\]]+/g, " ").replace(/\s+/g, " ").trim();
      block = null;
    };
    const open = (n) => (block = block || { html: [], en: [], level: 0, mantra: false, start: n + 1 });
    let tocTitle = null;

    let keepFrom = 0;   // line of an open [keep together]
    for (let n = 0; n < lines.length; n++) {
      const raw = lines[n];
      const line = raw.trim();
      if (line.startsWith("//")) continue;
      if (CONTENTS.test(line)) { close(); out.push('<nav class="toc"></nav>'); continue; }
      const toc = line.match(TOC_TITLE);
      if (toc) { tocTitle = toc[1]; continue; }
      if (KEEP_START.test(line)) {
        close();
        if (keepFrom) problems.push({ line: n + 1, severity: "error", message: "[keep together] inside another one — close the first with [/keep together]" });
        else { out.push(`<div class="keep" data-line="${n + 1}">`); keepFrom = n + 1; }
        continue;
      }
      if (KEEP_END.test(line)) {
        close();
        if (!keepFrom) problems.push({ line: n + 1, severity: "error", message: "[/keep together] without a [keep together] above it" });
        else { out.push("</div>"); keepFrom = 0; }
        continue;
      }
      if (!line) { close(); continue; }
      if (BLANK_PAGE.test(line)) { close(); out.push('<div class="blank-page"></div>'); continue; }
      if (line === "---") {
        // page breaks are automatic now
        problems.push({ line: n + 1, severity: "warning", message: "Page breaks are automatic — this line is ignored. To keep lines on one page (or on facing pages), use Keep together." });
        continue;
      }
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
        const hasPinyin = next && !HAS_CJK.test(next) && !/^[#>]/.test(next) && next !== "---" && !REPEAT.test(next);
        block.html.push(chineseLine(line, hasPinyin ? next : "", n + 1, problems));
        if (hasPinyin) pairs.push({ line: n + 1, han: line, pinyinLine: n + 2, pinyin: lines[n + 1] });
        if (hasPinyin) n++;
      } else if (line.startsWith(">")) {
        // small note line: leader instructions, Sanskrit equivalents
        block.html.push(`<p class="en note">${inline(esc(line.replace(/^>\s*/, "")))}</p>`);
      } else {
        const m = line.match(/^(#{1,2})\s*(.*)$/);
        if (m) block.level = block.level ? Math.min(block.level, m[1].length) : m[1].length;
        block.html.push(`<p class="en">${inline(esc(m ? m[2] : line))}</p>`);
        block.en.push((m ? m[2] : line).replace(PAGE_REF, ""));
      }
    }
    close();
    if (keepFrom) {
      problems.push({ line: keepFrom, severity: "warning", message: "This [keep together] is never closed — add [/keep together] after the last line to keep" });
      out.push("</div>");
    }
    const tocAttr = tocTitle && tocTitle !== "-" ? ` data-toc="${esc(tocTitle)}"` : "";
    return `<section class="sec" id="${anchor(name || "")}" data-file="${esc(name || "")}"${tocAttr}>${out.join("\n")}</section>`;
  }

  // Just the problems of a text file, for the editor
  function check(text) {
    const problems = [];
    parse(text, "", problems);
    return problems;
  }

  // Each Chinese line with its pinyin line, and which syllable belongs to which character
  function pairs(text) {
    const list = [];
    parse(text, "", [], list);
    return list.map((p) => {
      const syllables = [...p.pinyin.matchAll(/\S+/g)].map((m) => ({ text: m[0], at: m.index }));
      const chars = Array.from(p.han.trim());
      return { ...p, chars, ideographs: chars.map((c, i) => (IDEOGRAPH.test(c) ? i : -1)).filter((i) => i >= 0), syllables };
    });
  }

  const api = { parse, check, anchor, pageRefs, pairs };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LiturgyParse = api;
})(typeof window !== "undefined" ? window : globalThis);
