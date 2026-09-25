// editor.js — wiring for the editor page (index.html): connect to the text, keep the book in memory,
// and show it as pages in preview.html. The preview re-renders in a hidden frame and swaps in when
// ready, so the pages never flash blank while you edit.
//   index.html?text=<folder of liturgy-text> or ?repo=<owner/name>, &book=<name>
(function () {
  "use strict";
  const q = new URLSearchParams(location.search);
  const $ = (sel) => document.querySelector(sel);

  const state = { source: null, bookName: q.get("book") || "test", book: null, saved: {}, settings: { groups: [], changes: {} },
    layout: { pages: {}, flip: {}, hard: [], passes: 0 } };
  // Two preview frames take turns: one on show, the other lays the next version out hidden. Each keeps its
  // fonts loaded between layouts (a fresh frame spends up to ~2 s loading them), so redraws are quicker.
  let frame = null;     // the preview on show
  let pending = null;   // the frame laying out the next version
  let timer = null;

  function setStatus(text, isError) {
    $("#status").textContent = text;
    $("#status").classList.toggle("error", !!isError);
  }

  // ---- preview ----
  // Every change starts the page layout afresh (see previewDone for the extra passes facing pages may need)
  function refresh(delay = 0) {
    clearTimeout(timer);
    timer = setTimeout(() => { state.layout = { pages: {}, flip: {}, hard: [], passes: 0 }; render(); }, delay);
  }
  let early = null;     // a frame shown before its layout was finished (the rest still coming)
  function render() {
    if (early && early === frame.contentWindow && early.stopLayout) early.stopLayout();   // outdated now
    early = null;
    if (!pending) {
      const spare = [...$("#preview").querySelectorAll("iframe")].find((f) => f !== frame);
      if (spare && spare.contentWindow && spare.contentWindow.rerender) pending = spare;
    }
    if (pending && pending.contentWindow && pending.contentWindow.rerender) pending.contentWindow.rerender();
    else {
      if (pending) pending.remove();
      pending = document.createElement("iframe");
      pending.className = "loading";
      pending.title = "Booklet pages";
      pending.src = "preview.html" + location.search;
      $("#preview").append(pending);
    }
    setStatus("Updating pages…");
  }
  // How many pages a new layout must have before it can be shown in place of the current one:
  // those in view, and a couple more
  function pagesNeeded() {
    const w = frame && frame.contentWindow;
    return w && w.pagesInView ? w.pagesInView() + 2 : Infinity;
  }
  function swapIn() {
    const old = frame;
    frame = pending;
    pending = null;
    if (old) {
      frame.contentWindow.scrollTo(old.contentWindow.scrollX, old.contentWindow.scrollY);
      old.classList.add("loading");   // kept (hidden) for the next layout
    }
    frame.classList.remove("loading");
    followCursor();
  }
  // called by preview.html as pages get laid out, once the pages in view are done (the rest is still coming).
  // Swaps in as soon as the new pages reach the place the current ones are scrolled to; returns true then.
  function previewEarly(win) {
    if (!pending || win !== pending.contentWindow) return true;
    const want = frame ? frame.contentWindow.scrollY + frame.contentWindow.innerHeight : 0;
    if (win.document.documentElement.scrollHeight < want) return false;   // (scrolled on since the layout began)
    swapIn();
    early = win;
    return true;
  }
  // called by preview.html when its pages are laid out
  function previewDone(win, info) {
    const wasEarly = early && win === early && frame && win === frame.contentWindow;
    if (!wasEarly && (!pending || win !== pending.contentWindow)) return;
    early = null;
    if (!info.error && improveLayout(info.spreads || [])) return void setTimeout(render);   // another pass, hidden
    if (!wasEarly) swapIn();
    $("#print").disabled = !!info.error;
    if (info.error) setStatus("Problem: " + info.error, true);
    else setStatus(`${state.book.sections.length} chapter${state.book.sections.length === 1 ? "" : "s"} · ${info.pages} pages` +
      (info.problems ? ` · ${info.problems} problem(s) — marked in red, and underlined in the text` : "") +
      (info.blanks ? ` · ${info.blanks} blank page(s) added for facing pages` : ""));
  }
  function bookForPreview() {
    return { sections: state.book.sections.map((s) => ({ name: s.name, text: s.text })), css: state.book.css, plan: state.layout };
  }
  // Kept-together spans that run over pages: after a layout, check where they landed and adjust the plan.
  // Returns true when another (hidden) pass is worth it.
  //  - a span took a different number of pages than measured → redo with the real count (even = facing)
  //  - "blank page: at the end of the chapter before": move the chapter start instead of a blank before the span
  //  - that didn't land it on a left-hand page (another span in the chapter wants the other side) → back to a blank before it
  function improveLayout(spreads) {
    const L = state.layout;
    if (!spreads.length || L.passes >= 4) return false;
    const chapterEnd = (state.settings.changes["--blank-page"] || defaultSetting("--blank-page")) === "chapter-end";
    let again = false;
    for (const sp of spreads) {
      if (sp.actual !== sp.planned && L.pages[sp.key] !== sp.actual) { L.pages[sp.key] = sp.actual; again = true; }
      else if (sp.actual % 2 === 0 && !sp.left && !L.hard.includes(sp.file)) { L.hard.push(sp.file); again = true; }
      else if (chapterEnd && sp.blankBefore && !L.flip[sp.file] && !L.hard.includes(sp.file)) {
        L.flip[sp.file] = sp.chapterStartsLeft ? "right" : "left";
        again = true;
      }
    }
    if (again) L.passes++;
    return again;
  }
  const defaultSetting = (name) => (state.settings.groups.flatMap((g) => g.items).find((i) => i.name === name) || {}).value;

  // ---- connecting ----
  function askForKey(repo, why) {
    const form = $("#signin");
    const [owner, name] = repo.split("/");
    form.querySelector(".why").textContent = why;
    form.querySelector(".owner").textContent = owner;
    form.querySelector(".repo").textContent = name;
    form.querySelector(".make-key").href = "https://github.com/settings/personal-access-tokens/new?" +
      new URLSearchParams({ name: "Liturgy booklet", description: `Read and save ${repo} from the booklet editor`, target_name: owner, contents: "write" });
    form.onsubmit = (ev) => {
      ev.preventDefault();
      LiturgySource.key.set(form.elements.key.value.trim());
      location.reload();
    };
    form.hidden = false;
    $("#folder-choice").hidden = !LiturgySource.pickedFolder.available();
    $("#use-folder").onclick = async () => {
      try { await LiturgySource.pickedFolder.pick(); location.reload(); }
      catch (e) { if (e.name !== "AbortError") form.querySelector(".why").textContent = e.message; }
    };
    setStatus("Not connected");
  }
  // a folder picked earlier: the browser asks again for permission, which needs a click
  function askForFolderAgain(handle) {
    const box = $("#refolder");
    box.querySelector(".name").textContent = handle.name;
    $("#refolder-ok").onclick = async () => { if ((await handle.requestPermission({ mode: "readwrite" })) === "granted") location.reload(); };
    $("#refolder-no").onclick = async (ev) => { ev.preventDefault(); await LiturgySource.pickedFolder.forget(); location.reload(); };
    box.hidden = false;
    setStatus("Not connected");
  }

  // ---- tabs ----
  for (const b of document.querySelectorAll("#tabs button")) {
    b.onclick = () => {
      document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
      document.querySelectorAll("#panel .tab").forEach((t) => (t.hidden = t.id !== "tab-" + b.dataset.tab));
    };
  }

  // ---- settings ----
  async function startSettings() {
    const css = await (await fetch("css/settings.css", { cache: "no-cache" })).text();
    state.settings.groups = LiturgySettings.parse(css);
    const known = new Set(state.settings.groups.flatMap((g) => g.items.map((i) => i.name)));
    state.settings.changes = Object.fromEntries(Object.entries(LiturgySettings.values(state.book.css)).filter(([k]) => known.has(k)));
    state.book.css = LiturgySettings.toCss(state.settings.changes, state.settings.groups);
    LiturgySettings.build($("#settings-book"), state.settings.groups, () => state.settings.changes, (changes) => {
      state.settings.changes = changes;
      state.book.css = LiturgySettings.toCss(changes, state.settings.groups);
      changed();
      refresh(150);
    });
  }

  // ---- booklets: books/<name>.txt ----
  async function startBookPicker() {
    const names = (await state.source.list("books")).filter((n) => n.endsWith(".txt")).map((n) => n.slice(0, -4));
    if (!names.includes(state.bookName)) names.push(state.bookName);
    const pick = $("#book");
    for (const n of names.sort()) pick.append(Object.assign(document.createElement("option"), { value: n, textContent: n }));
    pick.append(Object.assign(document.createElement("option"), { value: "@new", textContent: "New booklet…" }));
    pick.value = state.bookName;
    pick.hidden = false;
    pick.onchange = () => {
      if (pick.value === "@new") { pick.value = state.bookName; return newBook(names).catch((e) => setStatus("Problem: " + e.message, true)); }
      const u = new URLSearchParams(location.search);
      u.set("book", pick.value);
      location.search = u;   // the unsaved-changes question comes from beforeunload
      pick.value = state.bookName;
    };
  }

  async function newBook(existing) {
    const title = (prompt("Name of the new booklet (for example: Evening Ceremony)") || "").trim();
    if (!title) return;
    const name = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "booklet";
    if (existing.includes(name)) return alert(`There is already a booklet called “${name}”.`);
    const path = `books/${name}.txt`;
    const text = `// ${title} — the chapter files of this booklet, in order, one per line\n`;
    if (!state.source.canSave) {
      download(path, text);
      return setStatus(`Downloaded ${name}.txt — put it in ${state.source.where}books/, then reload`);
    }
    await state.source.put(path, text, `Add booklet ${name} (from the editor)`);
    const u = new URLSearchParams(location.search);
    u.set("book", name);
    location.search = u;
  }

  // ---- chapters (the Text tab) ----
  // A booklet is a list of chapter files (books/<name>.txt → text/*.txt). A chapter can be in several booklets;
  // editing it changes it in all of them.
  const labelOf = (name) => name.replace(/\.txt$/, "");
  // A chapter's title for lists: its [toc: …] name, else its first title
  // A chapter's title for lists: its [toc: …] name, else its first title line, else its file name
  const titleOf = (text, name) => {
    const m = LiturgyParse.parse(text || "", name).match(/data-toc="([^"]*)"/);
    if (m) return new DOMParser().parseFromString(m[1], "text/html").documentElement.textContent;
    const first = (text || "").split("\n").find((l) => /^#\s/.test(l.trim()));
    return first ? first.replace(/^#+\s*/, "").replace(/[~\[\]]+/g, " ").replace(/\s+/g, " ").trim() : labelOf(name);
  };
  async function startText() {
    // every chapter there is: originals and chapters made in the editor (which live only in the edition)
    // ([] when the source can't list folders)
    state.textFiles = [...new Set([...(await state.source.list("text")), ...(await state.source.list("edits"))])];
    state.known = {};   // every chapter loaded or made, by name — taking one out and back keeps its edits
    for (const s of state.book.sections) addKnown(s);
    state.contents = { text: state.book.listText };
    state.text = LiturgyText.build($("#cm"), {
      onChange: docChanged,
      onCursor: (line) => {
        state.cursorLine = line;
        clearTimeout(state.cursorTimer);
        state.cursorTimer = setTimeout(() => { followCursor(); markPlace(line); }, 200);
      },
      header: chapterHeader,
      check: checkDoc,
      where: (n) => { const m = chapterAt(n); return m ? `${navLabel(m.name)}, line ${n - m.first + 1}` : `line ${n}`; },
      onHistory: showHistory,
    });
    loadDoc();
    renderChapters();
    loadLibrary();
  }

  // ---- the whole booklet in one editor ----
  // The editor holds every chapter, each after a header line (LiturgyText.SEP + file name). After each edit the
  // text is split back into chapters by those lines, so every chapter still saves to its own file.
  const norm = (t) => (t || "").replace(/\s+$/, "") + "\n";
  function mapDoc(docText) {
    const lines = docText.split("\n"), map = [];
    lines.forEach((l, i) => { if (LiturgyText.isSep(l)) map.push({ name: l.slice(LiturgyText.SEP.length), head: i + 1, first: i + 2 }); });
    map.forEach((m, k) => { m.last = (k + 1 < map.length ? map[k + 1].head : lines.length + 1) - 1; });
    return { lines, map };
  }
  // (Re)build the editor from the chapters — after chapters are added, removed or moved
  function loadDoc() {
    const keep = state.docMap && chapterAt(state.cursorLine || 1);
    const doc = state.book.sections.map((s) => LiturgyText.SEP + s.name + "\n" + norm(s.text)).join("");
    // the same, as originally: the dots beside the lines mark the differences
    const original = state.book.sections.map((s) => LiturgyText.SEP + s.name + "\n" + norm(s.original ?? s.baseline)).join("");
    state.docMap = mapDoc(doc).map;
    state.text.setDoc(doc, original);
    const back = keep && state.docMap.find((m) => m.name === keep.name);
    if (back) state.text.goto(back.first, false);
    renderNav();
  }
  function docChanged(docText) {
    const { lines, map } = mapDoc(docText);
    state.docMap = map;
    let flipped = false;
    for (const m of map) {
      const s = state.known[m.name];
      if (!s) continue;
      s.text = norm(lines.slice(m.first - 1, m.last).join("\n"));
      if (isEdited(s) !== s.shownEdited) flipped = true;
    }
    changed();
    refresh(250);
    if (flipped) { renderChapters(); state.text.refreshHeaders(); }
    clearTimeout(state.navTimer);
    state.navTimer = setTimeout(renderNav, 400);
  }
  // The chapter a line of the editor belongs to
  const chapterAt = (line) => [...(state.docMap || [])].reverse().find((m) => m.head <= line) || (state.docMap || [])[0];
  // A chapter's title bar in the editor
  function chapterHeader(name) {
    const s = state.known[name];
    const el = document.createElement("div");
    el.className = "cm-chapter-head";
    el.append(Object.assign(document.createElement("span"), { className: "t", textContent: s ? s.label : name }),
      Object.assign(document.createElement("span"), { className: "f", textContent: s && s.virtual ? "kept with this booklet" : labelOf(name) }));
    if (isEdited(s)) el.append(Object.assign(document.createElement("span"), { className: "tag", textContent: "edited" }));
    return el;
  }
  // Problems in the whole editor: each chapter checked on its own, line numbers moved to where it sits
  function checkDoc(docText) {
    const { lines, map } = mapDoc(docText), out = [];
    for (const m of map) {
      const text = lines.slice(m.first - 1, m.last).join("\n");
      for (const p of checkSection(text)) out.push({ ...p, line: p.line + m.first - 1 });
    }
    return out;
  }

  // ---- the contents list (left): the chapters, by file name; click to go there (text and pages) ----
  const navLabel = (name) => (name === LiturgySource.CONTENTS_ENTRY ? "Table of contents" : labelOf(name));
  function renderNav() {
    const nav = $("#toc-nav");
    nav.textContent = "";
    nav.append(Object.assign(document.createElement("div"), { className: "nav-top", textContent: "Contents" }));
    for (const s of state.book.sections) {
      const m = (state.docMap || []).find((x) => x.name === s.name);
      const a = Object.assign(document.createElement("a"), { href: "#", className: "nav-l0", textContent: navLabel(s.name), title: s.label });
      if (m) a.dataset.line = m.first;
      if (isEdited(s)) a.append(Object.assign(document.createElement("span"), { className: "tag", textContent: "edited" }));
      a.onclick = (ev) => {
        ev.preventDefault();
        if (frame && frame.contentWindow.showChapter) frame.contentWindow.showChapter(s.name);
        if (!m) return;
        $('#tabs button[data-tab="text"]').click();
        state.text.goto(m.first);
        state.cursorLine = m.first;
        markPlace(m.first);
      };
      nav.append(a);
    }
    markPlace(state.cursorLine || 1, false);
  }
  // Show where you are (from the cursor, or from where the pages are scrolled) in the contents list
  function markPlace(line, scroll = true) {
    const links = [...document.querySelectorAll("#toc-nav a[data-line]")];
    let here = null;
    for (const a of links) if (+a.dataset.line <= line) here = a;
    links.forEach((a) => a.classList.toggle("here", a === here));
    if (here && scroll) {
      const box = $("#toc-nav").getBoundingClientRect(), r = here.getBoundingClientRect();
      if (r.top < box.top + 36 || r.bottom > box.bottom) here.scrollIntoView({ block: "nearest" });
    }
  }
  // the pages were scrolled (preview.html): mark the place of the first verse in view
  function previewScrolled(win, file, line) {
    if (!frame || win !== frame.contentWindow) return;
    const m = (state.docMap || []).find((x) => x.name === file);
    if (m) markPlace(m.first + line - 1);
  }

  // A chapter differs from its original (or has none: made in the editor). The table of contents: from the one made automatically.
  const isEdited = (s) => !!s && (s.original == null || norm(s.text) !== norm(s.original));
  // Put the original text back (one undoable edit; saved as removing the edition file)
  function revertChapter(name) {
    const s = state.known[name], m = (state.docMap || []).find((x) => x.name === name);
    if (!s || s.original == null || !m) return;
    const doc = state.text.view.state.doc;
    const from = doc.line(Math.min(m.first, doc.lines)).from, to = doc.line(Math.min(m.last, doc.lines)).to;
    state.text.replace(from, Math.max(from, to), norm(s.original).replace(/\n$/, m.last === doc.lines ? "\n" : ""), `${navLabel(name)} back to the original`);
  }
  function addKnown(s) {
    // a chapter made in the editor has no original: its changed lines are marked from how it was when opened
    if (s.original == null && s.baseline == null) s.baseline = s.text;
    s.label = s.virtual ? "Table of contents (made automatically)" : titleOf(s.text, s.name);
    s.check = checkSection;
    state.known[s.name] = s;
    return s;
  }
  // A chapter's problems: parse.js's pinyin checks + page references to chapters not in this booklet
  checkSection.withSuggestions = true;
  function checkSection(text) {
    const here = new Set(state.book.sections.map((s) => labelOf(s.name)));
    const problems = LiturgyParse.check(text);
    text.split("\n").forEach((line, i) => {
      for (const ref of LiturgyParse.pageRefs(line)) {
        if (!here.has(ref)) problems.push({ line: i + 1, severity: "error", message: `“${ref}” is not a chapter of this booklet, so its page can't be found. Add that chapter in the Chapters tab, or check the name.` });
      }
    });
    return problems;
  }

  // ---- the Chapters tab: which chapters, in which order ----
  const chapterNames = () => LiturgySource.listNames(state.contents.text);
  // Rewrites the list file: keeps its opening // comment lines, then one chapter per line
  async function setChapters(names) {
    const head = state.contents.text.split("\n").filter((l, i, all) => l.trim().startsWith("//") && all.slice(0, i).every((x) => x.trim().startsWith("//")));
    state.contents.text = [...head, ...names].join("\n") + "\n";
    await updateSections();
  }
  // Loads any newly listed chapters, then shows the new set
  async function updateSections() {
    const sections = [];
    for (const name of chapterNames()) {
      if (!state.known[name] && name === LiturgySource.CONTENTS_ENTRY) {
        const toc = await LiturgySource.loadContents(state.source, state.bookName);
        addKnown(toc);
        state.saved[LiturgySource.contentsFile(state.bookName)] = toc.edited ? toc.text : null;
      }
      if (!state.known[name]) {
        const ch = state.library[name] || await LiturgySource.loadChapter(state.source, name).catch(() => null);
        if (!ch) continue;
        addKnown({ ...ch });
        state.saved[LiturgySource.EDITION + name] = ch.edited ? ch.text : null;
        if (!state.textFiles.includes(name)) state.textFiles.push(name);
      }
      if (!sections.includes(state.known[name])) sections.push(state.known[name]);
    }
    state.book.sections = sections;
    loadDoc();
    renderChapters();
    changed();
    refresh();
  }
  // Every chapter file there is, with its title (read once, in the background) — for "Add a chapter"
  state.library = {};
  async function loadLibrary() {
    const names = state.textFiles.filter((n) => n.endsWith(".txt"));
    await Promise.all(names.map(async (n) => { state.library[n] = await LiturgySource.loadChapter(state.source, n).catch(() => null); }));
    renderChapters();
  }
  function renderChapters() {
    const list = $("#chapters"), names = chapterNames();
    for (const n of names) if (state.known[n]) state.known[n].shownEdited = isEdited(state.known[n]);
    list.textContent = "";
    names.forEach((name, i) => {
      const s = state.known[name];
      const li = document.createElement("li");
      const btn = (text, title, fn, disabled) => Object.assign(document.createElement("button"), { type: "button", textContent: text, title, onclick: fn, disabled });
      const move = (d) => { const n = [...names]; [n[i], n[i + d]] = [n[i + d], n[i]]; setChapters(n); };
      li.append(
        Object.assign(document.createElement("span"), { className: "title", textContent: s ? s.label : `${labelOf(name)} — missing: no chapter file with this name` }),
        ...(isEdited(s) ? [Object.assign(document.createElement("span"), { className: "tag", textContent: "edited", title: "Changed from the original text" }),
          btn("Original", "Put back the original text of this chapter (Save to keep that; Undo in the text to change your mind)", () => revertChapter(name))] : []),
        btn("↑", "Move up", () => move(-1), i === 0),
        btn("↓", "Move down", () => move(1), i === names.length - 1),
        btn("Remove", "Take this chapter out of the booklet (the chapter itself is kept)", () => setChapters(names.filter((_, j) => j !== i))),
      );
      if (!s) li.classList.add("missing");
      list.append(li);
    });
    $("#no-chapters").hidden = names.length > 0;
    $("#add-contents").hidden = names.includes(LiturgySource.CONTENTS_ENTRY);
    // "Add a chapter": every chapter file not already in this booklet, by title
    const pick = $("#add-chapter");
    pick.textContent = "";
    pick.append(Object.assign(document.createElement("option"), { value: "", textContent: "— choose a chapter —" }));
    const choices = Object.keys({ ...state.library, ...state.known }).filter((n) => !names.includes(n)).sort();
    for (const n of choices) {
      const text = state.known[n] ? state.known[n].text : state.library[n] && state.library[n].text;
      pick.append(Object.assign(document.createElement("option"), { value: n, textContent: `${titleOf(text, n)}  (${labelOf(n)})` }));
    }
    $("#add-chapter-btn").disabled = true;
  }
  $("#add-contents").onclick = () => setChapters([LiturgySource.CONTENTS_ENTRY, ...chapterNames()]);
  $("#add-chapter").onchange = () => { $("#add-chapter-btn").disabled = !$("#add-chapter").value; };
  $("#add-chapter-btn").onclick = async () => {
    const name = $("#add-chapter").value;
    if (!name) return;
    await setChapters([...chapterNames(), name]);
    setStatus(`Added “${state.known[name] ? state.known[name].label : name}” at the end`);
  };
  async function newSection() {
    const title = (prompt("Name of the new chapter (for example: Evening Transference)") || "").trim();
    if (!title) return;
    const base = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "chapter";
    const name = base + ".txt";
    if (state.known[name] || state.textFiles.includes(name) || name in state.library)
      return alert(`There is already a chapter called “${base}”. Pick another name, or add that chapter with “Add a chapter”.`);
    addKnown({ name, text: `# ${title.toUpperCase()}\n\n`, original: null, edited: true });
    await setChapters([...chapterNames(), name]);
    jumpTo(name, 3);
  }
  // Keep together / Border: wrap the selected lines in [keep together] … [/keep together] or [border] … [/border]
  function wrapSelection(mark, what) {
    const v = state.text && state.text.view;
    if (!v) return;
    const sel = v.state.selection.main, doc = v.state.doc;
    if (sel.empty) return setStatus(`Select the lines to ${what} first (drag over them in the text), then click again.`, true);
    const first = doc.lineAt(sel.from), last = doc.lineAt(doc.lineAt(sel.to).from === sel.to && sel.to > sel.from ? sel.to - 1 : sel.to);
    if (chapterAt(first.number) !== chapterAt(last.number)) return setStatus(`The lines to ${what} must be in one chapter.`, true);
    v.dispatch({ changes: [{ from: first.from, insert: `[${mark}]\n` }, { from: last.to, insert: `\n[/${mark}]` }],
      annotations: state.text.label.of(`${mark[0].toUpperCase() + mark.slice(1)} — ${navLabel(chapterAt(first.number).name)}, lines ${first.number - chapterAt(first.number).first + 1}–${last.number - chapterAt(first.number).first + 1}`) });
    v.focus();
  }
  $("#keep-together").onclick = () => wrapSelection("keep together", "keep together");
  $("#add-border").onclick = () => wrapSelection("border", "put in a border");

  // pinyin lined up under the characters in the text editor: off unless switched on (remembered per browser)
  try { $("#align-pinyin").checked = localStorage.getItem("liturgy.alignPinyin") === "1"; } catch {}
  $("#align-pinyin").onchange = () => {
    try { localStorage.setItem("liturgy.alignPinyin", $("#align-pinyin").checked ? "1" : "0"); } catch {}
    LiturgyText.setAligning($("#align-pinyin").checked, state.text && state.text.view);
  };
  $("#align-pinyin").onchange();
  // pinyin suggestions: remembered per browser
  try { $("#suggest").checked = localStorage.getItem("liturgy.suggestPinyin") === "1"; } catch {}
  $("#suggest").onchange = () => {
    try { localStorage.setItem("liturgy.suggestPinyin", $("#suggest").checked ? "1" : "0"); } catch {}
    LiturgyText.setSuggesting($("#suggest").checked, state.text && state.text.view).catch(() => setStatus("Couldn't load the pinyin suggestions", true));
  };
  if ($("#suggest").checked) $("#suggest").onchange();
  for (const b of document.querySelectorAll(".new-chapter")) b.onclick = () => newSection().catch((e) => setStatus("Problem: " + e.message, true));
  // keep the verse being edited in view in the pages
  function followCursor() {
    const m = state.cursorLine && chapterAt(state.cursorLine);
    if (frame && m && frame.contentWindow.showLine) frame.contentWindow.showLine(m.name, Math.max(1, state.cursorLine - m.first + 1));
  }
  // a click on a verse in the pages (line = the line within its chapter)
  function jumpTo(file, line) {
    const m = (state.docMap || []).find((x) => x.name === file);
    if (!m) return;
    $('#tabs button[data-tab="text"]').click();
    state.text.goto(m.first + line - 1);
    state.cursorLine = m.first + line - 1;
    markPlace(state.cursorLine);
  }

  // ---- menus in the top bar: native popovers, opened under their ▾ button ----
  for (const b of document.querySelectorAll("[popovertarget]")) {
    const menu = document.getElementById(b.getAttribute("popovertarget"));
    menu.addEventListener("beforetoggle", (ev) => {
      if (ev.newState !== "open") return;
      const r = b.getBoundingClientRect();
      menu.style.top = r.bottom + 4 + "px";
      menu.style.right = Math.max(8, innerWidth - r.right) + "px";
    });
  }
  // ---- Undo / Redo (top bar), each with a list of the next steps: pick one to undo (redo) up to there ----
  function showHistory() {
    if (!state.text) return;
    const h = state.text.history();
    for (const [kind, list] of [["undo", h.undo], ["redo", h.redo]]) {
      $("#" + kind).disabled = $(`#${kind}-more`).disabled = !list.length;
      $("#" + kind).title = list.length ? `${kind === "undo" ? "Undo" : "Redo"}: ${list[0]} (${kind === "undo" ? "Ctrl+Z" : "Ctrl+Y"})` : `Nothing to ${kind}`;
    }
  }
  $("#undo").onclick = () => state.text.undo();
  $("#redo").onclick = () => state.text.redo();
  for (const kind of ["undo", "redo"]) {
    const menu = $(`#${kind}-menu`);
    menu.addEventListener("beforetoggle", (ev) => {
      if (ev.newState !== "open") return;
      const list = state.text.history()[kind].slice(0, 20);
      menu.textContent = "";
      menu.append(Object.assign(document.createElement("div"), { className: "menu-head", textContent: kind === "undo" ? "Undo up to…" : "Redo up to…" }));
      list.forEach((text, i) => {
        const b = Object.assign(document.createElement("button"), { type: "button", className: "item step", textContent: `${i + 1}. ${text}` });
        b.onclick = () => { menu.hidePopover(); state.text[kind](i + 1); };
        menu.append(b);
      });
    });
  }

  // ---- settings: a drawer over the left side ----
  const showSettings = (on) => { $("#settings").hidden = !on; $("#settings-btn").classList.toggle("on", on); };
  $("#settings-btn").onclick = () => showSettings($("#settings").hidden);
  $("#settings-close").onclick = () => showSettings(false);
  window.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !$("#settings").hidden) showSettings(false); });

  // ---- print ----
  // Letter sheets, 4 pages a side (preview.html printSheets), or just the pages as shown
  const printSheets = () => frame && frame.contentWindow.printSheets();
  $("#print-sheets").onclick = () => { $("#print-menu").hidePopover(); printSheets(); };
  $("#print-pages").onclick = () => { $("#print-menu").hidePopover(); if (frame) frame.contentWindow.print(); };

  // ---- saving ----
  // Every file the editor can change, as it is now in memory
  function currentFiles() {
    const files = { [LiturgySource.SETTINGS_FILE]: state.book.css, [`books/${state.bookName}.txt`]: state.contents.text };
    // chapters: the edition file holds the text when it differs from the original; null = no edition file
    for (const s of state.book.sections) files[s.virtual ? LiturgySource.contentsFile(state.bookName) : LiturgySource.EDITION + s.name] = isEdited(s) ? s.text : null;
    return files;
  }
  const unsaved = () => { const f = currentFiles(); return Object.keys(f).filter((p) => f[p] !== state.saved[p]); };
  // edited: true when the change is yours (an edit, a setting, the chapter list) — that also lets autosave try
  // again after a save that failed
  function changed(edited = true) {
    const n = unsaved().length;
    $("#save").disabled = !n || saving;
    if (!saving) $("#save").textContent = n ? `Save (${n} file${n > 1 ? "s" : ""})` : "Saved";
    if (edited) autosavePaused = false;
    clearTimeout(autosaveTimer);
    if (n && autosaveOn() && !autosavePaused) autosaveTimer = setTimeout(() => save(true), AUTOSAVE_AFTER);
  }
  // ---- autosave: on unless switched off (per browser); only where Save writes straight to the text ----
  const AUTOSAVE_AFTER = 4000;
  let autosaveTimer = null, autosavePaused = false, saving = false;
  const autosaveOn = () => { try { return localStorage.getItem("liturgy.autosave") !== "0"; } catch { return true; } } ;
  function showAutosave() {
    const can = !state.source || state.source.canSave, on = autosaveOn() && can;
    $("#autosave").checked = on;
    $("#autosave").disabled = !can;
    $("#save-more").textContent = on ? "auto ▾" : "▾";
    $("#save-more").classList.toggle("on", on);
    $("#autosave-note").hidden = can;
    $("#autosave-note").textContent = can ? "" : `Working from ${state.source.where}: Save hands you the files to put there yourself, so it can't save automatically.`;
  }
  $("#autosave").onchange = () => {
    try { localStorage.setItem("liturgy.autosave", $("#autosave").checked ? "1" : "0"); } catch {}
    showAutosave();
    changed(false);
  };
  function commitMessage(path) {
    if (path === LiturgySource.SETTINGS_FILE) return "Change booklet settings (from the editor)";
    if (path === LiturgySource.contentsFile(state.bookName))
      return currentFiles()[path] === null ? `Back to the automatic table of contents of booklet ${state.bookName} (from the editor)` : `Edit the table of contents of booklet ${state.bookName} (from the editor)`;
    if (path.startsWith("books/")) return `Change the chapters of booklet ${state.bookName} (from the editor)`;
    const name = path.slice(LiturgySource.EDITION.length), s = state.known[name];
    if (currentFiles()[path] === null) return `Back to the original text of ${name} (from the editor)`;
    if (s && s.original === null) return `${state.saved[path] == null ? "Add" : "Edit"} new chapter ${name} (from the editor)`;
    return `Edit ${name} — edition, the original is kept (from the editor)`;
  }
  function download(path, text) {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: path.split("/").pop() });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function save(auto = false) {
    if (saving) return;
    if (auto && (!autosaveOn() || !state.source.canSave)) return;
    clearTimeout(autosaveTimer);
    const files = currentFiles();
    const paths = unsaved();
    if (!paths.length) return;
    saving = true;
    $("#save").disabled = true;
    try {
      for (const path of paths) {
        if (state.source.canSave) {
          $("#save").textContent = "Saving…";
          if (files[path] === null) await state.source.remove(path, commitMessage(path));
          else await state.source.put(path, files[path], commitMessage(path));
        } else if (files[path] === null) {
          continue;   // (nothing to hand over: the edition file just isn't needed any more)
        } else {
          // Working from a local folder: hand the file over to put in the folder by hand
          download(path, files[path]);
        }
        state.saved[path] = files[path];
      }
      // (an automatic save just shows "Saved" on the button, and leaves the status line to the pages)
      if (!auto) setStatus(state.source.canSave ? `Saved to ${state.source.usesKey ? "GitHub" : state.source.where}` : `Downloaded ${paths.map((p) => p.split("/").pop()).join(", ")} — put ${paths.length > 1 ? "them" : "it"} in ${state.source.where}`);
    } catch (e) {
      setStatus("Not saved: " + e.message, true);
      autosavePaused = true;   // (until you change something: no retrying every few seconds)
    }
    saving = false;
    changed(false);
  }
  $("#save").onclick = () => save();
  // Ctrl+S / Cmd+S saves (instead of the browser saving the web page)
  window.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
      ev.preventDefault();
      if (!$("#save").disabled) save();
    }
  });
  window.addEventListener("beforeunload", (ev) => { if (state.book && unsaved().length) { ev.preventDefault(); ev.returnValue = ""; } });

  $("#forget").onclick = async (ev) => {
    ev.preventDefault();
    LiturgySource.key.forget();
    await LiturgySource.pickedFolder.forget();
    location.reload();
  };
  $("#print").onclick = printSheets;

  // The contents list and the panel can be made wider or narrower by dragging the bars between them
  // (Split.js). Sizes are remembered in this browser. Not on narrow screens, where the panel sits above the pages.
  function startSplit() {
    if (typeof Split !== "function" || !matchMedia("(min-width: 901px)").matches) return;
    let sizes = null;
    try { sizes = JSON.parse(localStorage.getItem("liturgy.panelSizes")); } catch {}
    if (!Array.isArray(sizes) || sizes.length !== 3) {
      const w = $("#app").clientWidth, nav = (220 / w) * 100, panel = (470 / w) * 100;
      sizes = [nav, panel, 100 - nav - panel];
    }
    $("#app").classList.add("split");
    Split(["#toc-nav", "#panel", "#preview"], {
      sizes, minSize: [120, 300, 250], gutterSize: 7, snapOffset: 0,
      onDragEnd: (s) => { try { localStorage.setItem("liturgy.panelSizes", JSON.stringify(s)); } catch {} },
    });
  }

  async function start() {
    try {
      state.source = await LiturgySource.open(q, state.bookName);
    } catch (e) {
      if (e.needFolder) return askForFolderAgain(e.needFolder);
      if (!e.needKey) throw e;
      return askForKey(q.get("repo") || LiturgySource.DEFAULT_REPO, e.message);
    }
    $("#forget").hidden = !state.source.usesKey && !state.source.isPickedFolder;
    startBookPicker();
    state.book = await LiturgySource.loadBook(state.source, state.bookName);
    await startSettings();
    await startText();
    if (!state.book.sections.length) $('#tabs button[data-tab="book"]').click();
    state.saved = currentFiles();
    showAutosave();
    changed(false);
    $("#app").hidden = false;
    $("#settings-btn").hidden = false;
    $("#undo-group").hidden = $("#redo-group").hidden = false;
    startSplit();
    render();
  }

  window.Editor = { bookForPreview, previewDone, previewEarly, previewScrolled, pagesNeeded, refresh, jumpTo, state };
  start().catch((e) => {
    setStatus("Problem: " + e.message, true);
    $("#forget").hidden = !LiturgySource.key.get();
  });
})();
