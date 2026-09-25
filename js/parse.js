// parse.js — turns a liturgy text file (see FORMAT.md) into HTML.
// Works in the browser (window.LiturgyParse) and in Node (require).
(function (root) {
  "use strict";

  const IDEOGRAPH = /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2ffff}]/u;
  const HAS_CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯\u{20000}-\u{2ffff}]/u;
  const REPEAT = /^x\d+$/i;
  // Spans of lines: [keep together] … [/keep together] ([one page] is the older name), [border] … [/border].
  // They may be put inside one another (also the same kind), but must be closed in the reverse order.
  const SPANS = { "keep together": "keep", "one page": "keep", border: "bordered" };
  const SPAN_MARK = /^\[(\/?)(keep together|one page|border)\]$/i;
  const BLANK_PAGE = /^\[blank page\]$/i, NEW_PAGE = /^\[new page\]$/i;
  const CONTENTS = /^\[contents\]$/i, CONTENTS_END = /^\[\/contents\]$/i, TOC_TITLE = /^\[toc:\s*(.*?)\s*\]$/i;
  // ASCII punctuation inside a Chinese line is shown as its full-width form
  const FULL_WIDTH = { ",": "，", ".": "。", "!": "！", "?": "？", ":": "：", ";": "；" };

  // A section's anchor, from its file name: "05-meng-shan.txt" → "s-05-meng-shan"
  const anchor = (name) => "s-" + String(name).replace(/\.txt$/i, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  // [page of <section>] inside a line → the page that section starts on (filled in by the page engine)
  //   [page of <section> / <entry>] → the page of a [toc: <entry>] partway through that section
  //   [page 12 of <section>] → 12, typed by hand (the editor warns: it won't follow changes)
  const PAGE_REF = /\[page(?:\s+(\d+))?\s+of\s+([^\]\/]+?)(?:\s*\/\s*([^\]]+?))?\s*\]/gi;
  const pageLink = (cls, fixed, name, entry) => (fixed ? `<span class="${cls} fixed">${fixed}</span>`
    : `<a class="${cls}" href="#${anchor(name.trim())}"${entry ? ` data-entry="${entry}"` : ""}></a>`);
  const inline = (html) => html.replace(PAGE_REF, (m, fixed, name, entry) => pageLink("pageref", fixed, name, entry));
  const pageRefs = (text) => [...text.matchAll(PAGE_REF)].map((m) => m[2].trim().replace(/\.txt$/i, ""));
  // A line of a written-out table of contents: its text, then (usually) a page reference
  function contentsRow(line) {
    const refs = [...line.matchAll(PAGE_REF)];
    if (!refs.length) return `<div class="toc-entry toc-heading"><span class="toc-title">${esc(line)}</span></div>`;
    const ref = refs[refs.length - 1], [m, fixed, name, entry] = ref;
    const title = line.slice(0, ref.index) + line.slice(ref.index + m.length);
    return `<div class="toc-entry${entry ? " toc-sub" : ""}"><span class="toc-title">${esc(title.replace(/[\s.·…]+$/, "").trim())}</span>` +
      `<span class="toc-dots"></span>${pageLink("toc-page", fixed, name, entry && esc(entry))}</div>`;
  }

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
          return `<ruby class="c">${esc(c)}<rt>${esc(p)}</rt></ruby>`;
        }
        return `<ruby class="c p">${esc(FULL_WIDTH[c] || c)}<rt>&#8203;</rt></ruby>`;
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
      if (block.runOn) cls.push("run-on");
      // a # title further down a chapter starts a new page (setting "titles start") — not one right under another
      // title block, nor one that runs on from the text above it
      if (block.level === 1 && blocks > 0 && lastLevel !== 1 && !lastRunOn) cls.push("title-break");
      lastLevel = block.level; lastRunOn = !!block.runOn;
      // a [toc: …] partway through the chapter: an extra contents entry, pointing at this block
      const entry = pendingEntry ? ` id="${anchor(name || "")}-l${block.start}" data-toc-entry="${esc(pendingEntry)}"` : "";
      pendingEntry = null;
      blocks++;
      out.push(`<div class="${cls.join(" ")}" data-line="${block.start}"${entry}>${block.html.join("")}</div>`);
      // the section's name in a table of contents: its first title, unless [toc: …] says otherwise
      if (block.level === 1 && tocTitle === null && block.en.length) tocTitle = block.en.join(" ").replace(/[~\[\]]+/g, " ").replace(/\s+/g, " ").trim();
      block = null;
    };
    const open = (n) => (block = block || { html: [], en: [], level: 0, mantra: false, start: n + 1 });
    let tocTitle = null, pendingEntry = null, blocks = 0, lastLevel = 0, lastRunOn = false;

    const open_ = [];   // spans ([keep together], [border]) not closed yet
    let blankRun = 0, mostBlank = 0;   // blank lines in a row just before this one; the longest such row since the last text
    for (let n = 0; n < lines.length; n++) {
      const raw = lines[n];
      const line = raw.trim();
      // a blank line ends a block; each blank line more in a row adds a line of space (only between things, not at
      // the end; a // comment line in between breaks the row: blank, comment, blank is just a block break)
      if (line.startsWith("//")) { blankRun = 0; continue; }
      if (!line) { close(); blankRun++; mostBlank = Math.max(mostBlank, blankRun); continue; }
      if (mostBlank > 1 && out.length) for (let k = 1; k < mostBlank; k++) out.push('<div class="blank-line"></div>');
      blankRun = mostBlank = 0;
      // [contents] … [/contents]: the table of contents written out, one line per entry (see FORMAT.md);
      // [contents] alone: made automatically
      if (CONTENTS.test(line)) {
        close();
        const end = lines.findIndex((l, i) => i > n && CONTENTS_END.test(l.trim()));
        if (end < 0) { out.push('<nav class="toc auto"></nav>'); continue; }
        const rows = lines.slice(n + 1, end).map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
        out.push(`<nav class="toc">${rows.map(contentsRow).join("")}</nav>`);
        n = end;
        continue;
      }
      if (CONTENTS_END.test(line)) continue;
      const toc = line.match(TOC_TITLE);
      if (toc) {
        // at the top: the chapter's name in the contents; further down: an extra entry for the next block
        if (blocks === 0 && !block) tocTitle = toc[1]; else pendingEntry = toc[1];
        continue;
      }
      const mark = line.match(SPAN_MARK);
      if (mark) {
        close();
        const name = mark[2].toLowerCase(), cls = SPANS[name], shown = name === "one page" ? "keep together" : name;
        if (!mark[1]) {
          // spans may sit inside one another, even of the same kind (a verse group kept together inside a
          // longer kept-together span)
          out.push(`<div class="${cls}" data-line="${n + 1}">`);
          open_.push({ cls, shown, line: n + 1 });
        } else if (!open_.length || open_[open_.length - 1].cls !== cls) {
          const top = open_[open_.length - 1];
          problems.push({ line: n + 1, severity: "error", message: top
            ? `[/${shown}] here, but [${top.shown}] (line ${top.line}) must be closed first`
            : `[/${shown}] without a [${shown}] above it` });
        } else { out.push("</div>"); open_.pop(); }
        continue;
      }
      if (BLANK_PAGE.test(line)) { close(); out.push('<div class="blank-page"></div>'); continue; }
      if (NEW_PAGE.test(line)) { close(); out.push('<div class="page-break"></div>'); lastLevel = 0; continue; }
      if (line === "---") {
        // page breaks are automatic now
        problems.push({ line: n + 1, severity: "warning", message: "This line is ignored — for a page break of your own, use [new page] (the New page button). To keep lines on one page (or on facing pages), use Keep together." });
        continue;
      }
      // a title (#) right under other lines, with no blank line between: it starts a new block there (the lines
      // above keep their own style, with no gap before the title) — and the editor points it out
      const heading = /^#{1,2}(\s|$)/.test(line);
      if (heading && block && block.body) {
        problems.push({ line: n + 1, severity: "warning", message: "A title (#) right under other lines, with no blank line between them — the lines above stay as they are and the title starts here, with no space above it. Put a blank line above the title if it should stand apart." });
        block.runOn = true;
        close();
      }
      open(n);
      if (!heading) block.body = (block.body || 0) + 1;
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
    for (const o of open_.reverse()) {
      problems.push({ line: o.line, severity: "warning", message: `This [${o.shown}] is never closed — add [/${o.shown}] after its last line` });
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
