// editor.js — wiring for the editor page (index.html): connect to the text, keep the book in memory,
// and show it as pages in preview.html. The preview re-renders in a hidden frame and swaps in when
// ready, so the pages never flash blank while you edit.
//   index.html?text=<folder of liturgy-text> or ?repo=<owner/name>, &book=<name>
(function () {
  "use strict";
  const q = new URLSearchParams(location.search);
  const $ = (sel) => document.querySelector(sel);

  // the booklet: the one in the address, else the one opened last in this browser (start() checks it's there)
  const LAST_BOOK = "liturgy.lastBook";
  const lastBook = () => { try { return localStorage.getItem(LAST_BOOK) || ""; } catch { return ""; } };
  const state = { source: null, bookName: q.get("book") || lastBook(), book: null, saved: {}, settings: { groups: [], changes: {} },
    layout: { pages: {}, flip: {}, hard: [], passes: 0 } };
  // Two preview frames take turns: one on show, the other lays the next version out hidden. Each keeps its
  // fonts loaded between layouts (a fresh frame spends up to ~2 s loading them), so redraws are quicker.
  let frame = null;     // the preview on show
  let pending = null;   // the frame laying out the next version
  let timer = null;

  function setStatus(text, isError) {
    $("#status").textContent = $("#status").title = text;   // (one line in the bar; the whole message on hover)
    $("#status").classList.toggle("error", !!isError);
  }

  // ---- preview ----
  // Every change starts the page layout afresh (see previewDone for the extra passes facing pages may need)
  // A small spinner at the bottom left of the pages shows while a change is still on its way (from the change itself
  // until its layout is fully in), so it's clear it hasn't been missed.
  let asked = 0, drawing = 0;
  const showBusy = () => { $("#busy").hidden = drawing === asked && !pending && !early; };
  function refresh(delay = 0) {
    asked++;
    $("#busy").hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => { state.layout = { pages: {}, flip: {}, hard: [], passes: 0 }; render(); }, delay);
  }
  let early = null;     // a frame shown before its layout was finished (the rest still coming)
  function render() {
    drawing = asked;
    $("#busy").hidden = false;
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
    if (view === "sheets") return Infinity;   // (the print layout is made from all the pages: shown when they're done)
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
    requestAnimationFrame(fitZoom);
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
    showBusy();
    requestAnimationFrame(fitZoom);   // (the finished layout — e.g. the print layout's sheets — may need another size)
    $("#print").disabled = !!info.error;
    state.pageCount = info.pages;
    state.pageMap = info.pageMap || {};
    state.text.setPages(state.pageMap);
    showBinding();
    // (a note about opening the booklet goes in front, the first time)
    const note = state.note ? state.note + " · " : "";
    state.note = "";
    if (info.error) setStatus("Problem: " + info.error, true);
    else setStatus(note + `${plural(state.book.sections.length, "chapter")} · ${plural(info.pages, "page")}` +
      (info.problems ? ` · ${info.problems} problem(s) — marked in red, and underlined in the text` : "") +
      (info.blanks ? ` · ${info.blanks} blank page(s) added for facing pages` : "") +
      (state.bindingWarning ? " · a signature is too thick to fold — see Settings → Format and binding" : ""));
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
  // a settings file → the changes it makes that the app knows (the older single "binding" setting read as the new ones:
  // pages in order → regular letter size; signatures → folio signatures)
  function readSettings(css) {
    const known = new Set(state.settings.groups.flatMap((g) => g.items.map((i) => i.name)));
    const c = Object.fromEntries(Object.entries(LiturgySettings.values(css)).filter(([k]) => known.has(k)));
    if (c["--binding"] === "in-order") { c["--format"] = "letter"; delete c["--binding"]; }
    else if (c["--binding"] === "signatures" && !c["--format"]) c["--format"] = "folio";
    return c;
  }
  async function startSettings() {
    const css = await (await fetch("css/settings.css", { cache: "no-cache" })).text();
    state.settings.groups = LiturgySettings.parse(css);
    state.settings.changes = readSettings(state.book.css);
    state.book.css = LiturgySettings.toCss(state.settings.changes, state.settings.groups);
    // which sections of the Settings panel are open: remembered for each booklet (in this browser)
    const openKey = "liturgy.openSettings." + state.bookName;
    const openList = () => { try { return JSON.parse(localStorage.getItem(openKey)) || []; } catch { return []; } };
    const sections = { isOpen: (t) => openList().includes(t),
      setOpen: (t, open) => { const l = openList().filter((x) => x !== t); if (open) l.push(t); try { localStorage.setItem(openKey, JSON.stringify(l)); } catch {} } };
    startSettings.rebuild = () => LiturgySettings.build($("#settings-book"), state.settings.groups, () => state.settings.changes, applySettings, sections);
    startSettings.rebuild();
    fillCopyFrom().catch(() => {});
  }

  // Copy all settings from another booklet (replacing this one's, after a warning)
  async function copySettings() {
    const pick = $("#copy-from"), from = pick.value;
    if (!from) return;
    if (!confirm(`Replace ALL the settings of the booklet “${state.bookName}” with those of “${from}”?\n\nThe settings it has now are overwritten (Undo won't bring them back; not saving and reloading the page does).`)) { pick.value = ""; return; }
    const css = await LiturgySource.loadSettings(state.source, from);
    applySettings(readSettings(css));
    startSettings.rebuild();
    setStatus(`Settings copied from “${from}”`);
  }
  async function fillCopyFrom() {
    const pick = $("#copy-from");
    pick.textContent = "";
    pick.append(Object.assign(document.createElement("option"), { value: "", textContent: "— choose a booklet —" }));
    for (const n of (await bookNames()).filter((n) => n !== state.bookName)) pick.append(Object.assign(document.createElement("option"), { value: n, textContent: n }));
    pick.onchange = () => copySettings().catch((e) => setStatus("Problem: " + e.message, true));
  }
  function applySettings(changes) {
    state.settings.changes = changes;
    state.book.css = LiturgySettings.toCss(changes, state.settings.groups);
    changed();
    refresh(150);
    showBinding();
  }

  // ---- booklets: books/<name>.txt, shown in the order kept in booklets.txt (others after, A–Z) ----
  const ORDER_FILE = LiturgySource.ORDER_FILE;
  const bookNames = () => LiturgySource.bookNames(state.source);
  const saveOrder = (names) => state.source.put(ORDER_FILE, "// The booklets, in the order the editor lists them (one per line)\n" + names.join("\n") + "\n", "Change the order of the booklets (from the editor)");
  const openBook = (name) => { const u = new URLSearchParams(location.search); u.set("book", name); location.search = u; };
  async function startBookPicker() {
    const names = await bookNames();
    if (!names.includes(state.bookName)) names.push(state.bookName);
    const pick = $("#book");
    pick.textContent = "";
    for (const n of names) pick.append(Object.assign(document.createElement("option"), { value: n, textContent: n }));
    pick.append(Object.assign(document.createElement("option"), { value: "@new", textContent: "New booklet…" }));
    pick.append(Object.assign(document.createElement("option"), { value: "@edit", textContent: "Edit booklets…" }));
    pick.value = state.bookName;
    pick.hidden = false;
    pick.onchange = () => {
      const v = pick.value;
      pick.value = state.bookName;
      if (v === "@new") return newBook(names).catch((e) => setStatus("Problem: " + e.message, true));
      if (v === "@edit") return editBooks().catch((e) => setStatus("Problem: " + e.message, true));
      openBook(v);   // the unsaved-changes question comes from beforeunload
    };
  }
  const slug = (title, fallback) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || fallback;

  async function newBook(existing) {
    const title = (prompt("Name of the new booklet (for example: Evening Ceremony)") || "").trim();
    if (!title) return;
    const name = slug(title, "booklet");
    if (existing.includes(name)) return alert(`There is already a booklet called “${name}”.`);
    const path = `books/${name}.txt`;
    const text = `// ${title} — the chapter files of this booklet, in order, one per line\n`;
    if (!state.source.canSave) {
      download(path, text);
      return setStatus(`Downloaded ${name}.txt — put it in ${state.source.where}books/, then reload`);
    }
    await state.source.put(path, text, `Add booklet ${name} (from the editor)`);
    // its own settings, from the app's defaults (letter-size pages)
    await state.source.put(LiturgySource.settingsFile(name), LiturgySettings.toCss({}, state.settings.groups), `Add booklet ${name} (from the editor)`);
    if (await state.source.get(ORDER_FILE, true) !== null) await saveOrder([...existing.filter((n) => n !== name), name]);
    openBook(name);
  }

  // Edit booklets: rename, move up/down, delete — each done straight away (your unsaved changes are saved first)
  async function editBooks() {
    const dialog = $("#books-dialog"), list = $("#books-list");
    const can = state.source.canSave;
    $("#books-note").hidden = can;
    $("#books-note").textContent = can ? "" : `Working from ${state.source.where}: booklets can't be changed from here — rename, move or delete the files in its books folder.`;
    let names = await bookNames();
    let moved = false;   // the current booklet renamed or deleted: open another when the dialog closes
    const busy = (on) => list.querySelectorAll("button").forEach((b) => (b.disabled = on || !can || b.dataset.off === "1"));
    async function saveFirst() {
      if (!unsaved().length) return true;
      await save();
      if (unsaved().length) { alert("Your changes couldn't be saved (see the message at the top), so the booklets were left as they are."); return false; }
      return true;
    }
    async function act(fn) {
      busy(true);
      try { if (await saveFirst()) await fn(); } catch (e) { alert("Problem: " + e.message); }
      names = await bookNames();
      draw();
    }
    const move = (i, d) => act(async () => { [names[i], names[i + d]] = [names[i + d], names[i]]; await saveOrder(names); setStatus("Booklet order saved"); });
    const rename = (old) => {
      const title = (prompt(`New name for the booklet “${old}”`, old) || "").trim();
      if (!title) return;
      const name = slug(title, old);
      if (name === old) return;
      if (names.includes(name)) return alert(`There is already a booklet called “${name}”.`);
      act(async () => {
        const msg = `Rename booklet ${old} to ${name} (from the editor)`;
        await state.source.put(`books/${name}.txt`, await state.source.get(`books/${old}.txt`), msg);
        for (const file of [LiturgySource.contentsFile, LiturgySource.settingsFile]) {   // its table of contents and settings go along
          const text = await state.source.get(file(old), true);
          if (text !== null) { await state.source.put(file(name), text, msg); await state.source.remove(file(old), msg); }
        }
        await state.source.remove(`books/${old}.txt`, msg);
        const i = names.indexOf(old);
        if (await state.source.get(ORDER_FILE, true) !== null) { names[i] = name; await saveOrder(names); }
        if (old === state.bookName) moved = name;
        setStatus(`Booklet “${old}” is now “${name}”`);
      });
    };
    const remove = (name) => {
      if (names.length < 2) return alert("This is the only booklet, so it can't be deleted.");
      if (!confirm(`Delete the booklet “${name}”?\n\nOnly the booklet (its list of chapters) goes. The chapters themselves stay, for other booklets.` +
        (state.source.usesKey ? " GitHub keeps the old version in its history." : ""))) return;
      act(async () => {
        const msg = `Delete booklet ${name} (from the editor)`;
        await state.source.remove(`books/${name}.txt`, msg);
        await state.source.remove(LiturgySource.contentsFile(name), msg);
        await state.source.remove(LiturgySource.settingsFile(name), msg);
        if (await state.source.get(ORDER_FILE, true) !== null) await saveOrder(names.filter((n) => n !== name));
        if (name === state.bookName) moved = names.find((n) => n !== name);
        setStatus(`Booklet “${name}” deleted`);
      });
    };
    function draw() {
      list.textContent = "";
      names.forEach((name, i) => {
        const btn = (text, title, fn, off) => {
          const b = Object.assign(document.createElement("button"), { type: "button", textContent: text, title, onclick: fn, disabled: off || !can });
          b.dataset.off = off ? "1" : "";
          return b;
        };
        const li = document.createElement("li");
        li.append(Object.assign(document.createElement("span"), { className: "title", textContent: name + (name === state.bookName ? " (open now)" : "") }),
          btn("↑", "Move up", () => move(i, -1), i === 0), btn("↓", "Move down", () => move(i, 1), i === names.length - 1),
          btn("Rename…", "Give this booklet another name", () => rename(name)), btn("Delete…", "Delete this booklet (its chapters stay)", () => remove(name)));
        list.append(li);
      });
    }
    draw();
    dialog.onclose = () => (moved ? openBook(moved) : startBookPicker());
    dialog.showModal();
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
      marked: (name) => !!state.known[name] && state.known[name].original != null,
      refused: (why) => setStatus(why, true),
    });
    updateContents(false);
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
    clearTimeout(state.contentsTimer);
    state.contentsTimer = setTimeout(() => updateContents(true), 800);
    if (flipped) { renderChapters(); state.text.refreshHeaders(); }
    clearTimeout(state.navTimer);
    state.navTimer = setTimeout(renderNav, 400);
  }
  // The chapter a line of the editor belongs to
  const chapterAt = (line) => [...(state.docMap || [])].reverse().find((m) => m.head <= line) || (state.docMap || [])[0];
  // A chapter's title bar in the editor
  function chapterHeader(name) {
    const s = state.known[name];
    // (the space around the bar is padding of an outer box: CodeMirror can't see a block widget's margins, and
    // clicks and the arrow keys would then land a line or two off)
    const el = document.createElement("div"), bar = document.createElement("div");
    el.className = "cm-chapter-head";
    el.dataset.name = name;
    bar.className = "bar";
    bar.append(Object.assign(document.createElement("span"), { className: "t", textContent: chapterAliases()[name] || (s ? s.label : name) }),
      Object.assign(document.createElement("span"), { className: "f", textContent: s && s.virtual ? "kept with this booklet" : labelOf(name) }));
    if (isEdited(s)) bar.append(Object.assign(document.createElement("span"), { className: "tag", textContent: "edited" }));
    el.append(bar);
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
  const navLabel = (name) => (state.contents && chapterAliases()[name]) || (name === LiturgySource.CONTENTS_ENTRY ? "Table of contents" : labelOf(name));
  function renderNav() {
    const nav = $("#toc-list");
    nav.textContent = "";
    nav.append(Object.assign(document.createElement("div"), { className: "nav-top", textContent: "Contents" }));
    for (const s of state.book.sections) {
      const m = (state.docMap || []).find((x) => x.name === s.name);
      const a = Object.assign(document.createElement("a"), { href: "#", className: "nav-l0", title: s.label });
      a.append(Object.assign(document.createElement("span"), { className: "label", textContent: navLabel(s.name) }));
      if (m) a.dataset.line = m.first;
      if (isEdited(s)) a.append(Object.assign(document.createElement("span"), { className: "tag", textContent: "edited" }));
      const pen = Object.assign(document.createElement("button"), { type: "button", className: "rename", textContent: "✎",
        title: "Rename in this booklet's contents list (double-click the name does it too)" });
      pen.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); renameChapter(s.name); };
      a.append(pen);
      a.ondblclick = (ev) => { ev.preventDefault(); renameChapter(s.name); };
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
      const box = $("#toc-list").getBoundingClientRect(), r = here.getBoundingClientRect();
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
    s.label = s.virtual ? "Table of contents" : titleOf(s.text, s.name);
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
      if (line.trim().startsWith("//")) return;
      for (const ref of LiturgyParse.pageRefs(line)) {
        if (!here.has(ref)) problems.push({ line: i + 1, severity: "error", message: `“${ref}” is not a chapter of this booklet, so its page can't be found. Add that chapter in the Chapters tab, or check the name.` });
      }
      // a page number typed by hand: warn, and offer the automatic one back
      for (const m of line.matchAll(LiturgyText.REF)) {
        if (!m[1]) continue;
        const auto = (state.pageMap || {})[LiturgyText.refKey(m[2], m[3])];
        problems.push({ line: i + 1, from: m.index, to: m.index + m[0].length, severity: "warning",
          message: `Page number ${m[1]} typed by hand — it stays ${m[1]} even when the pages move.${auto ? ` The automatic number is ${auto}.` : ""}`,
          fix: { name: "Use the automatic page number", insert: LiturgyText.refText(m[2], m[3]) } });
      }
    });
    return problems;
  }

  // ---- the table of contents, written out in the text: [contents], one line per entry, [/contents] ----
  // Each line is "title [page of chapter]" (or "chapter / part" for a [toc: part] partway through a chapter).
  // The lines follow the booklet: a new chapter gets a line, a removed one loses it, and a line whose title is still
  // the chapter's own follows a change of it; titles you've changed and numbers set by hand stay.
  const CONTENTS_OPEN = /^\[contents\]$/i, CONTENTS_CLOSE = /^\[\/contents\]$/i;
  function contentsEntries() {
    const out = [];
    for (const s of state.book.sections) {
      if (s.virtual) continue;
      const sec = new DOMParser().parseFromString(LiturgyParse.parse(s.text || "", s.name), "text/html").querySelector("section");
      // every chapter of the booklet has a line (its [toc: …] name, else its first # title), then a line for each of
      // its other # titles (and [toc: …] entries further down); "// " in front leaves one out
      const name = labelOf(s.name), own = sec && sec.dataset.toc, title = own || titleOf(s.text, s.name);
      out.push({ key: name, title, line: `${title} ${LiturgyText.refText(name)}` });
      const seen = new Set([name]);
      let first = !own;   // (no [toc: …] name: the first title is the chapter's own line)
      for (const e of sec ? sec.querySelectorAll("[data-toc-entry], [data-title]") : []) {
        if (e.dataset.title && !e.dataset.tocEntry && first) { first = false; continue; }
        first = false;
        const part = e.dataset.tocEntry || e.dataset.title, key = `${name} / ${part}`;
        if (part === "-" || seen.has(key)) continue;
        seen.add(key);
        out.push({ key, title: part, line: `  ${part} ${LiturgyText.refText(name, part)}` });
      }
    }
    return out;
  }
  // (a line left out with "//" still counts as that entry's line, so it isn't added again)
  const rowKey = (line) => { const m = [...line.matchAll(LiturgyText.REF)].pop(); return m ? LiturgyText.refKey(m[2], m[3]) : null; };
  const rowTitle = (line) => { const m = [...line.matchAll(LiturgyText.REF)].pop(); return (m ? line.slice(0, m.index) + line.slice(m.index + m[0].length) : line).replace(/^\s*(\/\/\s*)?/, "").replace(/[\s.·…]+$/, "").trim(); };
  // the contents chapter's text with its lines brought up to date (lastTitles: each entry's title before, to follow changes)
  function syncContents(text, entries, lastTitles = new Map()) {
    const lines = text.replace(/\n$/, "").split("\n");
    const start = lines.findIndex((l) => CONTENTS_OPEN.test(l.trim()));
    if (start < 0) return text;
    const end = lines.findIndex((l, i) => i > start && CONTENTS_CLOSE.test(l.trim()));
    const body = end < 0 ? [] : lines.slice(start + 1, end);
    // entry lines by key; any other line (a note, a heading, a name that matches no chapter) stays with the entry it
    // came before; a line is dropped only when its chapter was taken out of the booklet just now
    const keys = new Set(entries.map((e) => e.key)), gone = (k) => lastTitles.has(k) && !keys.has(k);
    const have = new Map(), before = new Map();
    let loose = [];
    for (const l of body) {
      const k = rowKey(l);
      if (k && keys.has(k) && !have.has(k)) { have.set(k, l); before.set(k, loose); loose = []; }
      else if (!(k && gone(k))) loose.push(l);
    }
    const out = [];
    for (const e of entries) {
      out.push(...(before.get(e.key) || []));
      let line = have.get(e.key) ?? e.line;
      const was = lastTitles.get(e.key);
      if (have.has(e.key) && was != null && was !== e.title && rowTitle(line) === was) line = line.replace(was, e.title);
      out.push(line);
    }
    out.push(...loose);
    return [...lines.slice(0, start + 1), ...out, "[/contents]", ...lines.slice(end < 0 ? start + 1 : end + 1)].join("\n") + "\n";
  }
  // Bring the table of contents up to date: before the editor is (re)built (text only), or after edits (in the editor)
  function updateContents(inEditor) {
    const toc = state.book.sections.find((s) => s.virtual);
    if (!toc) return;
    const entries = contentsEntries();
    const lastTitles = new Map((state.contentsEntries || []).map((e) => [e.key, e.title]));
    state.contentsEntries = entries;
    toc.original = syncContents(LiturgySource.CONTENTS_TEXT, entries);
    const text = syncContents(toc.text, entries, lastTitles);
    if (norm(text) === norm(toc.text)) return;
    const m = inEditor && (state.docMap || []).find((x) => x.name === toc.name);
    if (!m) { toc.text = text; return; }
    // only the lines that differ (so Undo of your own edits there still lines up)
    const doc = state.text.view.state.doc, want = text.replace(/\n$/, "").split("\n");
    const have = []; for (let i = m.first; i <= m.last; i++) have.push(doc.line(i).text);
    if (m.last === doc.lines && have[have.length - 1] === "") have.pop();
    let a = 0; while (a < have.length && a < want.length && have[a] === want[a]) a++;
    let b = 0; while (b < have.length - a && b < want.length - a && have[have.length - 1 - b] === want[want.length - 1 - b]) b++;
    const from = a < have.length - b ? doc.line(m.first + a).from : (a ? doc.line(m.first + a - 1).to : doc.line(m.first).from);
    const to = a < have.length - b ? doc.line(m.first + have.length - b - 1).to : from;
    const middle = want.slice(a, want.length - b).join("\n");
    const insert = a < have.length - b ? middle : (middle ? (a ? "\n" : "") + middle + (a ? "" : "\n") : "");
    state.text.replaceQuietly(from, to, insert);
  }

  // ---- the Chapters tab: which chapters, in which order ----
  const chapterNames = () => LiturgySource.listNames(state.contents.text);
  // Rewrites the list file: keeps its opening // comment lines, then one chapter per line
  async function setChapters(names, aliases = chapterAliases()) {
    const head = state.contents.text.split("\n").filter((l, i, all) => l.trim().startsWith("//") && all.slice(0, i).every((x) => x.trim().startsWith("//")));
    state.contents.text = [...head, ...names.map((n) => (aliases[n] ? `${n} = ${aliases[n]}` : n))].join("\n") + "\n";
    await updateSections();
  }
  // the names chapters are shown under in this booklet's contents list (kept in the booklet's list file)
  const chapterAliases = () => Object.fromEntries(LiturgySource.listEntries(state.contents.text).filter((e) => e.alias).map((e) => [e.name, e.alias]));
  function renameChapter(name) {
    const aliases = chapterAliases(), now = aliases[name] || "";
    const answer = prompt(`Name for “${labelOf(name)}” in this booklet's contents list (the chapter file keeps its name).\nLeave it empty to show the file name.`, now || labelOf(name));
    if (answer === null) return;
    const alias = answer.trim() === labelOf(name) ? "" : answer.trim().replace(/\s+/g, " ");
    if (alias === now) return;
    if (alias) aliases[name] = alias; else delete aliases[name];
    const head = state.contents.text.split("\n").filter((l, i, all) => l.trim().startsWith("//") && all.slice(0, i).every((x) => x.trim().startsWith("//")));
    state.contents.text = [...head, ...chapterNames().map((n) => (aliases[n] ? `${n} = ${aliases[n]}` : n))].join("\n") + "\n";
    changed();
    renderNav();
    state.text.refreshHeaders();
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
    updateContents(false);
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
  // New page: a [new page] line above the line with the cursor
  $("#new-page").onclick = () => {
    const v = state.text && state.text.view;
    if (!v) return;
    const line = v.state.doc.lineAt(v.state.selection.main.head);
    if (LiturgyText.isSep(line.text)) return;
    v.dispatch({ changes: { from: line.from, insert: "[new page]\n" }, annotations: state.text.label.of(`New page — ${navLabel(chapterAt(line.number).name)}, line ${line.number - chapterAt(line.number).first + 1}`) });
    v.focus();
  };

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
  // ---- how the pages are shown (per browser): the view (single pages, side by side, print layout), fitted to the
  // width of the pane unless zoomed by hand. The frames are scaled from outside; the page at the top stays in view. ----
  const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];
  const VIEWS = ["single", "spread", "sheets"];
  const stored = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  let view = VIEWS.includes(stored("liturgy.view", "single")) ? stored("liturgy.view", "single") : "single";
  let zoom = 1, fitting = stored("liturgy.zoom", "fit") === "fit";
  if (!fitting) zoom = +stored("liturgy.zoom", 1) || 1;
  function setZoom(z, fit = false) {
    const w = frame && frame.contentWindow, top = w && w.pageAtTop ? w.pageAtTop() : 0;
    zoom = z;
    fitting = fit;
    $("#preview").style.setProperty("--zoom", z);
    $("#zoom-reset").textContent = Math.round(z * 100) + "%";
    $("#zoom-reset").title = fit ? "Fitted to the width of the pane" : "Fit to the width of the pane";
    $("#zoom-reset").classList.toggle("fitting", fit);
    $("#zoom-out").disabled = z <= ZOOMS[0];
    $("#zoom-in").disabled = z >= ZOOMS[ZOOMS.length - 1];
    store("liturgy.zoom", fit ? "fit" : z);
    if (top && w.showPage) requestAnimationFrame(() => w.showPage(top));
  }
  // fit the view's width to the pane (a little room for the scroll bar)
  function fitZoom() {
    if (!fitting) return;
    const w = frame && frame.contentWindow, need = w && w.contentWidth ? w.contentWidth() : 0;
    if (!need) return;
    const z = Math.round(Math.min(3, Math.max(0.3, ($("#preview").clientWidth - 18) / need)) * 100) / 100;
    if (Math.abs(z - zoom) > 0.005) setZoom(z, true);
  }
  function setView(v) {
    view = v;
    store("liturgy.view", v);
    for (const b of document.querySelectorAll("#views button")) b.classList.toggle("on", b.dataset.view === v);
    for (const f of document.querySelectorAll("#preview iframe")) if (f.contentWindow && f.contentWindow.setView) f.contentWindow.setView(v);
    requestAnimationFrame(fitZoom);
  }
  $("#zoom-in").onclick = () => setZoom(ZOOMS.find((z) => z > zoom + 0.001) ?? zoom);
  $("#zoom-out").onclick = () => setZoom([...ZOOMS].reverse().find((z) => z < zoom - 0.001) ?? zoom);
  $("#zoom-reset").onclick = () => { fitting = true; fitZoom(); };
  for (const b of document.querySelectorAll("#views button")) b.onclick = () => { fitting = true; setView(b.dataset.view); };
  window.addEventListener("resize", () => fitZoom());
  setZoom(zoom, fitting);
  for (const b of document.querySelectorAll("#views button")) b.classList.toggle("on", b.dataset.view === view);

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
  // ---- Settings and Print: panels over the left side, reaching the right edge of the text panel (at least 420 px) ----
  const drawers = { settings: ["#settings", "#settings-btn"], print: ["#print-panel", "#print"], feedback: ["#feedback-panel", "#feedback-btn"] };
  function fitDrawers() {
    const w = Math.max(420, Math.round($("#panel").getBoundingClientRect().right - $("#app").getBoundingClientRect().left));
    for (const [panel] of Object.values(drawers)) $(panel).style.width = w + "px";
  }
  function showDrawer(which) {
    fitDrawers();
    for (const [name, [panel, button]] of Object.entries(drawers)) {
      $(panel).hidden = name !== which;
      $(button).classList.toggle("on", name === which);
    }
  }
  const openDrawer = () => Object.keys(drawers).find((n) => !$(drawers[n][0]).hidden);
  for (const [name, [panel, button]] of Object.entries(drawers)) {
    $(button).onclick = () => showDrawer(openDrawer() === name ? null : name);
    $(panel).querySelector(".drawer-close").onclick = () => showDrawer(null);
  }
  window.addEventListener("resize", fitDrawers);
  window.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && openDrawer()) showDrawer(null); });

  // ---- format and binding (Settings): the numbers under the choice, and the Print panel's steps (js/impose.js) ----
  const setting = (name) => state.settings.changes[name] ?? defaultSetting(name);
  const bindingMode = () => LiturgyImpose.mode({ format: setting("--format"), binding: setting("--binding"), sheets: setting("--signature-sheets") });
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  function showBinding() {
    const m = bindingMode();
    $("#print-inorder").hidden = m.format !== "letter";
    $("#print-folded").hidden = m.format !== "folio";
    $("#print-perfect").hidden = m.format !== "quarto";
    $("#folded-perfect-steps").hidden = m.binding !== "perfect";
    $("#folded-signature-steps").hidden = $("#folded-signature-fold").hidden = m.binding !== "signatures";
    // the pages are scaled to fit their space on the sheet
    const [w, h] = [setting("--page-width"), setting("--page-height")].map(parseFloat), [fw, fh] = LiturgyImpose.FORMATS[m.format].map(parseFloat);
    const scale = Math.round(Math.min(fw / w, fh / h) * 100);
    if (!state.pageCount) return;
    const p = LiturgyImpose.plan(m, state.pageCount);
    const thick = p.signatures > 0 && Math.max(...p.plan) > LiturgyImpose.MAX_SHEETS;
    // the three numbers: pages printed, sheets, signatures (one can be stapled; several are sewn and glued)
    const parts = [`Pages printed at <b>${scale}%</b> of their size (${w} × ${h} in into ${fw} × ${fh} in)`, `Pages printed: <b>${p.pagesPrinted}</b>` + (p.blanks && m.format !== "letter" ? ` (${state.pageCount} + ${plural(p.blanks, "blank")})` : ""),
      `Sheets (letter, both sides): <b>${p.sheets}</b>`];
    if (m.binding === "signatures") {
      const list = (xs) => (xs.length > 1 ? xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1] : String(xs[0]));
      parts.push(`Signatures: <b>${p.signatures}</b> — ${p.signatures === 1 ? "can be stapled" : `${list(p.plan)} sheets; sew and glue them`}`);
    } else if (m.format === "folio") parts.push(`Cut in half: ${p.sheets * 2} pieces, stacked and glued or stapled`);
    else if (m.format === "quarto") parts.push(`Cut in quarters: ${p.sheets * 4} pieces, stacked and glued or stapled`);
    else parts.push("No cutting; can be stapled");
    const html = parts.join("<br>") + (thick ? `<div class="warning">A signature of ${Math.max(...p.plan)} sheets (${Math.max(...p.plan) * 4} pages) is too thick to fold neatly — choose “automatic” to split it into several.</div>` : "");
    for (const box of document.querySelectorAll("#binding-metrics, #signature-plan")) box.innerHTML = html;
    $("#signature-warning").hidden = true;
    $("#signature-warning").textContent = thick ? "too thick" : "";
    state.bindingWarning = thick;
  }

  // ---- print ----
  // the letter sheets for the format (preview.html printSheets); "just the pages": each page at its own size
  const printSheets = () => frame && frame.contentWindow.printSheets();
  $("#print-sheets").onclick = printSheets;
  $("#print-pages").onclick = () => frame && frame.contentWindow.print();

  // ---- feedback: notes about the app, kept in FEEDBACK.md with the text (the same for every booklet) ----
  const FEEDBACK_FILE = "FEEDBACK.md", FEEDBACK_START = "# Feedback and notes about the app\n\nNewest first. Written in the editor's Feedback panel.\n";
  async function startFeedback() {
    state.feedback = (await state.source.get(FEEDBACK_FILE, true)) ?? "";
    state.saved[FEEDBACK_FILE] = state.feedback;
    $("#feedback-text").value = state.feedback || FEEDBACK_START;
    if (state.source.usesKey) $("#feedback-where").href = `https://github.com/${state.source.where}/blob/main/${FEEDBACK_FILE}`;
    else $("#feedback-where").removeAttribute("href");
  }
  $("#feedback-text").oninput = () => { state.feedback = $("#feedback-text").value; changed(); };
  $("#feedback-new").onclick = () => {
    const box = $("#feedback-text"), text = box.value || FEEDBACK_START;
    const heading = `## ${new Date().toISOString().slice(0, 10)} — ${state.bookName}\n\n\n`;
    // after the file's own opening lines, before the older entries
    const first = text.search(/^## /m), at = first >= 0 ? first : text.length;
    const before = text.slice(0, at).replace(/\n*$/, "\n\n");
    box.value = before + heading + text.slice(at);
    box.focus();
    box.selectionStart = box.selectionEnd = before.length + heading.length - 1;
    box.oninput();
  };

  // ---- saving ----
  // Every file the editor can change, as it is now in memory
  function currentFiles() {
    const files = { [LiturgySource.settingsFile(state.bookName)]: state.book.css, [`books/${state.bookName}.txt`]: state.contents.text };
    // chapters: the edition file holds the text when it differs from the original; null = no edition file
    for (const s of state.book.sections) files[s.virtual ? LiturgySource.contentsFile(state.bookName) : LiturgySource.EDITION + s.name] = isEdited(s) ? s.text : null;
    if (state.feedback !== undefined) files[FEEDBACK_FILE] = state.feedback;
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
    if (path === FEEDBACK_FILE) return "Feedback notes (from the editor)";
    if (path === LiturgySource.settingsFile(state.bookName)) return `Change the settings of booklet ${state.bookName} (from the editor)`;
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
      onDrag: () => { fitDrawers(); fitZoom(); },
      onDragEnd: (s) => { fitDrawers(); try { localStorage.setItem("liturgy.panelSizes", JSON.stringify(s)); } catch {} },
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
    // a booklet that isn't there (renamed, deleted, mistyped — or none asked for): the last one opened, else the first
    const names = await bookNames(), asked = state.bookName;
    if (names.length && !names.includes(asked)) {
      state.bookName = names.includes(lastBook()) ? lastBook() : names[0];
      const u = new URLSearchParams(location.search);
      u.set("book", state.bookName);
      history.replaceState(null, "", "?" + u);
    }
    if (!state.bookName) throw new Error(`No booklets found in ${state.source.where}.`);
    if (asked && asked !== state.bookName) state.note = `There is no booklet called “${asked}” — this is “${state.bookName}”`;
    startBookPicker();
    state.book = await LiturgySource.loadBook(state.source, state.bookName);
    try { localStorage.setItem(LAST_BOOK, state.bookName); } catch {}
    await startSettings();
    await startText();
    await startFeedback();
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

  window.Editor = { bookForPreview, previewDone, previewEarly, previewScrolled, pagesNeeded, refresh, jumpTo, state, view: () => view };
  start().catch((e) => {
    setStatus("Problem: " + e.message, true);
    $("#forget").hidden = !LiturgySource.key.get();
  });
})();
