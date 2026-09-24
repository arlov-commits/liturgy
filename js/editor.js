// editor.js — wiring for the editor page (index.html): connect to the text, keep the book in memory,
// and show it as pages in preview.html. The preview re-renders in a hidden frame and swaps in when
// ready, so the pages never flash blank while you edit.
//   index.html?text=<folder of liturgy-text> or ?repo=<owner/name>, &book=<name>
(function () {
  "use strict";
  const q = new URLSearchParams(location.search);
  const $ = (sel) => document.querySelector(sel);

  const state = { source: null, bookName: q.get("book") || "test", book: null };
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
      new URLSearchParams({ name: "Liturgy booklet", description: `Read ${repo} for the booklet editor`, target_name: owner, contents: "read" });
    form.onsubmit = (ev) => {
      ev.preventDefault();
      LiturgySource.key.set(form.elements.key.value.trim());
      location.reload();
    };
    form.hidden = false;
    setStatus("Not connected");
  }

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
    $("#app").hidden = false;
    render();
  }

  window.Editor = { bookForPreview, previewDone, refresh, state };
  start().catch((e) => {
    setStatus("Problem: " + e.message, true);
    $("#forget").hidden = !LiturgySource.key.get();
  });
})();
