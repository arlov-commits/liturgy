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
    $("#print").disabled = !!info.error;
    if (info.error) setStatus("Problem: " + info.error, true);
    else setStatus(`${state.book.sections.length} sections · ${info.pages} pages` +
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

  // ---- saving ----
  // Every file the editor can change, as it is now in memory
  function currentFiles() {
    const files = { [LiturgySource.SETTINGS_FILE]: state.book.css };
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
    return path === LiturgySource.SETTINGS_FILE ? "Change booklet settings (from the editor)" : `Edit ${path.replace(/^text\//, "")} (from the editor)`;
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
    state.book = await LiturgySource.loadBook(state.source, state.bookName);
    await startSettings();
    state.saved = currentFiles();
    changed();
    $("#app").hidden = false;
    render();
  }

  window.Editor = { bookForPreview, previewDone, refresh, state };
  start().catch((e) => {
    setStatus("Problem: " + e.message, true);
    $("#forget").hidden = !LiturgySource.key.get();
  });
})();
