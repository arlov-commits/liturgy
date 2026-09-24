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
  let frame = null;     // the preview on show
  let pending = null;   // the preview being rendered
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
  function render() {
    if (pending) pending.remove();
    pending = document.createElement("iframe");
    pending.className = "loading";
    pending.title = "Booklet pages";
    pending.src = "preview.html" + location.search;
    $("#preview").append(pending);
    setStatus("Updating pages…");
  }
  // called by preview.html when its pages are laid out
  function previewDone(win, info) {
    if (!pending || win !== pending.contentWindow) return;
    if (!info.error && improveLayout(info.spreads || [])) return void setTimeout(render);   // another pass, still hidden
    const old = frame;
    frame = pending;
    pending = null;
    if (old) {
      frame.contentWindow.scrollTo(old.contentWindow.scrollX, old.contentWindow.scrollY);
      old.remove();
    }
    frame.classList.remove("loading");
    followCursor();
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
    LiturgySettings.build($("#tab-settings"), state.settings.groups, () => state.settings.changes, (changes) => {
      state.settings.changes = changes;
      state.book.css = LiturgySettings.toCss(changes, state.settings.groups);
      changed();
      refresh(300);
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
    state.textFiles = await state.source.list("text");   // [] when the source can't list folders
    state.known = {};   // every chapter loaded or made, by name — taking one out and back keeps its edits
    for (const s of state.book.sections) addKnown(s);
    state.contents = { text: state.book.listText };
    state.text = LiturgyText.build($("#cm"), $("#section"), () => { changed(); refresh(700); }, (e, line) => {
      state.cursor = { file: e.name, line };
      clearTimeout(state.cursorTimer);
      state.cursorTimer = setTimeout(followCursor, 250);
    });
    state.text.setEntries(state.book.sections.filter((s) => !s.virtual));
    renderChapters();
    loadLibrary();
  }
  function addKnown(s) {
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
        if (!here.has(ref)) problems.push({ line: i + 1, severity: "error", message: `“${ref}” is not a chapter of this booklet, so its page can't be found. Add that chapter in the Booklet tab, or check the name.` });
      }
    });
    return problems;
  }

  // ---- the Booklet tab: which chapters, in which order ----
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
      if (!state.known[name] && name === LiturgySource.CONTENTS_ENTRY) addKnown(LiturgySource.contentsChapter());
      if (!state.known[name]) {
        const text = state.library[name] ?? await state.source.get("text/" + name, true).catch(() => null);
        if (text === null) continue;
        addKnown({ name, text });
        state.saved["text/" + name] = text;
        if (!state.textFiles.includes(name)) state.textFiles.push(name);
      }
      if (!sections.includes(state.known[name])) sections.push(state.known[name]);
    }
    state.book.sections = sections;
    state.text.setEntries(sections.filter((s) => !s.virtual));
    renderChapters();
    changed();
    refresh();
  }
  // Every chapter file there is, with its title (read once, in the background) — for "Add a chapter"
  state.library = {};
  async function loadLibrary() {
    const names = state.textFiles.filter((n) => n.endsWith(".txt"));
    await Promise.all(names.map(async (n) => { state.library[n] = await state.source.get("text/" + n, true).catch(() => null); }));
    renderChapters();
  }
  function renderChapters() {
    const list = $("#chapters"), names = chapterNames();
    list.textContent = "";
    names.forEach((name, i) => {
      const s = state.known[name];
      const li = document.createElement("li");
      const btn = (text, title, fn, disabled) => Object.assign(document.createElement("button"), { type: "button", textContent: text, title, onclick: fn, disabled });
      const move = (d) => { const n = [...names]; [n[i], n[i + d]] = [n[i + d], n[i]]; setChapters(n); };
      li.append(
        Object.assign(document.createElement("span"), { className: "title", textContent: s ? s.label : `${labelOf(name)} — missing: no chapter file with this name` }),
        btn("Edit", "Open this chapter in the Text tab", () => jumpTo(name, 1), !s || s.virtual),
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
      const text = state.known[n] ? state.known[n].text : state.library[n];
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
    addKnown({ name, text: `# ${title.toUpperCase()}\n\n` });
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
    v.dispatch({ changes: [{ from: first.from, insert: `[${mark}]\n` }, { from: last.to, insert: `\n[/${mark}]` }] });
    v.focus();
  }
  $("#keep-together").onclick = () => wrapSelection("keep together", "keep together");
  $("#add-border").onclick = () => wrapSelection("border", "put in a border");

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
    if (frame && state.cursor && frame.contentWindow.showLine) frame.contentWindow.showLine(state.cursor.file, state.cursor.line);
  }
  // a click on a verse in the pages
  function jumpTo(file, line) {
    $('#tabs button[data-tab="text"]').click();
    state.text.show(file, line);
  }

  // ---- print ----
  // Letter sheets, 4 pages a side (preview.html printSheets), or just the pages as shown
  const printSheets = () => frame && frame.contentWindow.printSheets();
  $("#print-sheets").onclick = printSheets;
  $("#print-pages").onclick = () => frame && frame.contentWindow.print();

  // ---- saving ----
  // Every file the editor can change, as it is now in memory
  function currentFiles() {
    const files = { [LiturgySource.SETTINGS_FILE]: state.book.css, [`books/${state.bookName}.txt`]: state.contents.text };
    for (const s of state.book.sections) if (!s.virtual) files["text/" + s.name] = s.text;
    return files;
  }
  const unsaved = () => { const f = currentFiles(); return Object.keys(f).filter((p) => f[p] !== state.saved[p]); };
  function changed() {
    const n = unsaved().length;
    $("#save").disabled = !n;
    $("#save").textContent = n ? `Save (${n} file${n > 1 ? "s" : ""})` : "Saved";
  }
  function commitMessage(path) {
    if (path === LiturgySource.SETTINGS_FILE) return "Change booklet settings (from the editor)";
    if (path.startsWith("books/")) return `Change the chapters of booklet ${state.bookName} (from the editor)`;
    return `${path in state.saved ? "Edit" : "Add"} ${path.replace(/^text\//, "")} (from the editor)`;
  }
  function download(path, text) {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: path.split("/").pop() });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function save() {
    const files = currentFiles();
    const paths = unsaved();
    $("#save").disabled = true;
    try {
      for (const path of paths) {
        if (state.source.canSave) {
          $("#save").textContent = "Saving…";
          await state.source.put(path, files[path], commitMessage(path));
        } else {
          // Working from a local folder: hand the file over to put in the folder by hand
          download(path, files[path]);
        }
        state.saved[path] = files[path];
      }
      setStatus(state.source.canSave ? `Saved to ${state.source.usesKey ? "GitHub" : state.source.where}` : `Downloaded ${paths.map((p) => p.split("/").pop()).join(", ")} — put ${paths.length > 1 ? "them" : "it"} in ${state.source.where}`);
    } catch (e) {
      setStatus("Not saved: " + e.message, true);
    }
    changed();
  }
  $("#save").onclick = save;
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
    changed();
    $("#app").hidden = false;
    render();
  }

  window.Editor = { bookForPreview, previewDone, refresh, jumpTo, state };
  start().catch((e) => {
    setStatus("Problem: " + e.message, true);
    $("#forget").hidden = !LiturgySource.key.get();
  });
})();
