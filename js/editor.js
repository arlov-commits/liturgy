// editor.js — wiring for the editor page (index.html): connect to the text, keep the book in memory,
// and show it as pages in preview.html. The preview re-renders in a hidden frame and swaps in when
// ready, so the pages never flash blank while you edit.
//   index.html?text=<folder of liturgy-text> or ?repo=<owner/name>, &book=<name>
(function () {
  "use strict";
  const q = new URLSearchParams(location.search);
  const $ = (sel) => document.querySelector(sel);

  const state = { source: null, bookName: q.get("book") || "test", book: null, saved: {}, settings: { groups: [], changes: {} } };
  let frame = null;     // the preview on show
  let pending = null;   // the preview being rendered
  let timer = null;

  function setStatus(text, isError) {
    $("#status").textContent = text;
    $("#status").classList.toggle("error", !!isError);
  }

  // ---- preview ----
  function refresh(delay = 0) {
    clearTimeout(timer);
    timer = setTimeout(render, delay);
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
    else setStatus(`${state.book.sections.length} section${state.book.sections.length === 1 ? "" : "s"} · ${info.pages} pages` +
      (info.problems ? ` · ${info.problems} pinyin problem(s) — marked in red` : ""));
  }
  function bookForPreview() {
    return { sections: state.book.sections.map((s) => ({ name: s.name, text: s.text })), css: state.book.css };
  }

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
    const text = `// ${title} — the section files of this booklet, in order, one per line\n`;
    if (!state.source.canSave) {
      download(path, text);
      return setStatus(`Downloaded ${name}.txt — put it in ${state.source.where}books/, then reload`);
    }
    await state.source.put(path, text, `Add booklet ${name} (from the editor)`);
    const u = new URLSearchParams(location.search);
    u.set("book", name);
    location.search = u;
  }

  // ---- text ----
  // The Text tab edits the booklet's sections plus its contents list (books/<name>.txt).
  const CONTENTS = "@contents";
  const labelOf = (name) => name.replace(/\.txt$/, "");
  async function startText() {
    state.textFiles = await state.source.list("text");   // [] when the source can't list folders
    state.known = {};   // every section loaded or made, by name — taking one out of the list and back keeps its edits
    for (const s of state.book.sections) { s.label = labelOf(s.name); state.known[s.name] = s; }
    state.contents = { name: CONTENTS, label: "☰ Booklet contents (list of sections)", text: state.book.listText, check: checkList };
    state.text = LiturgyText.build($("#cm"), $("#section"), (e) => {
      changed();
      if (e === state.contents) { clearTimeout(state.listTimer); state.listTimer = setTimeout(updateSections, 600); }
      else refresh(700);
    }, (e, line) => {
      if (e === state.contents) return;
      state.cursor = { file: e.name, line };
      clearTimeout(state.cursorTimer);
      state.cursorTimer = setTimeout(followCursor, 250);
    });
    state.text.setEntries([...state.book.sections, state.contents]);
  }
  // Problems in the contents list: names with no section file behind them
  function checkList(text) {
    const problems = [], seen = new Set();
    text.split("\n").forEach((raw, i) => {
      const name = raw.trim();
      if (!name || name.startsWith("//")) return;
      if (seen.has(name)) problems.push({ line: i + 1, severity: "warning", message: "This section is listed twice" });
      seen.add(name);
      if (!state.known[name] && state.textFiles.length && !state.textFiles.includes(name))
        problems.push({ line: i + 1, severity: "error", message: `There is no section file called “${name}”. Check the spelling, or use New section to make it.` });
    });
    return problems;
  }
  // The contents list changed: load any newly listed sections, then show the new set
  async function updateSections() {
    const sections = [];
    for (const name of LiturgySource.listNames(state.contents.text)) {
      if (!state.known[name]) {
        const text = await state.source.get("text/" + name, true).catch(() => null);
        if (text === null) continue;
        state.known[name] = { name, label: labelOf(name), text };
        state.saved["text/" + name] = text;
        if (!state.textFiles.includes(name)) state.textFiles.push(name);
      }
      if (!sections.includes(state.known[name])) sections.push(state.known[name]);
    }
    state.book.sections = sections;
    state.text.setEntries([...sections, state.contents]);
    changed();
    refresh();
  }
  async function newSection() {
    const title = (prompt("Name of the new section (for example: Meng Shan Offering)") || "").trim();
    if (!title) return;
    const base = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "section";
    const name = base + ".txt";
    if (state.known[name] || state.textFiles.includes(name)) return alert(`There is already a section called “${base}”. Pick another name, or add “${name}” to the booklet contents.`);
    state.known[name] = { name, label: base, text: `# ${title.toUpperCase()}\n\n` };
    state.text.setText(CONTENTS, state.contents.text.replace(/\n*$/, "\n") + name + "\n");
    clearTimeout(state.listTimer);
    await updateSections();
    state.text.show(name, 3);
  }
  $("#new-section").onclick = () => newSection().catch((e) => setStatus("Problem: " + e.message, true));
  // keep the verse being edited in view in the pages
  function followCursor() {
    if (frame && state.cursor && frame.contentWindow.showLine) frame.contentWindow.showLine(state.cursor.file, state.cursor.line);
  }
  // a click on a verse in the pages
  function jumpTo(file, line) {
    $('#tabs button[data-tab="text"]').click();
    state.text.show(file, line);
  }

  // ---- saving ----
  // Every file the editor can change, as it is now in memory
  function currentFiles() {
    const files = { [LiturgySource.SETTINGS_FILE]: state.book.css, [`books/${state.bookName}.txt`]: state.contents.text };
    for (const s of state.book.sections) files["text/" + s.name] = s.text;
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
    if (path.startsWith("books/")) return `Change the sections of booklet ${state.bookName} (from the editor)`;
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
      setStatus(state.source.canSave ? "Saved to GitHub" : `Downloaded ${paths.map((p) => p.split("/").pop()).join(", ")} — put ${paths.length > 1 ? "them" : "it"} in ${state.source.where}`);
    } catch (e) {
      setStatus("Not saved: " + e.message, true);
    }
    changed();
  }
  $("#save").onclick = save;
  window.addEventListener("beforeunload", (ev) => { if (state.book && unsaved().length) { ev.preventDefault(); ev.returnValue = ""; } });

  $("#forget").onclick = (ev) => { ev.preventDefault(); LiturgySource.key.forget(); location.reload(); };
  $("#print").onclick = () => frame && frame.contentWindow.print();

  async function start() {
    try {
      state.source = await LiturgySource.open(q, state.bookName);
    } catch (e) {
      if (!e.needKey) throw e;
      return askForKey(q.get("repo") || LiturgySource.DEFAULT_REPO, e.message);
    }
    $("#forget").hidden = !state.source.usesKey;
    startBookPicker();
    state.book = await LiturgySource.loadBook(state.source, state.bookName);
    await startSettings();
    await startText();
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
