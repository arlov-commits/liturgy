// source.js — where the liturgy text is read from.
// 1. ?text=<folder>, or a liturgy-text folder cloned next to this app (the dev setup).
// 2. Otherwise the private GitHub repo (?repo=owner/name), read (and saved to) with a key the editor pastes in once.
(function (root) {
  "use strict";

  const DEFAULT_REPO = "arlov-commits/liturgy-text";
  const KEY_NAME = "liturgy.githubKey";
  const SETTINGS_FILE = "settings.css";

  // The key lives only in this browser. Storage can be blocked (private windows) — then it's just not remembered.
  const key = {
    get() { try { return localStorage.getItem(KEY_NAME) || ""; } catch { return ""; } },
    set(v) { try { localStorage.setItem(KEY_NAME, v); } catch {} },
    forget() { try { localStorage.removeItem(KEY_NAME); } catch {} },
  };

  class SourceError extends Error {
    constructor(message, needKey) { super(message); this.needKey = needKey; }
  }

  const b64decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
  const b64encode = (text) => {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };

  // A source reads files by path (e.g. "text/03-amitabha-sutra.txt"). get(path, true) returns null for a missing file.
  function folder(base) {
    base = base.replace(/\/?$/, "/");
    return {
      where: base, usesKey: false, canSave: false,
      async get(path, optional) {
        const r = await fetch(base + path, { cache: "no-cache" });
        if (r.status === 404 && optional) return null;
        if (!r.ok) throw new SourceError(`${path} not found (${r.status})`);
        return r.text();
      },
    };
  }

  // GitHub's REST API: /repos/{owner}/{repo}/contents/{path}. Remembers each file's version (sha) as read,
  // so a save can't silently overwrite a change someone else made in the meantime.
  function github(repo, token) {
    const shas = {};
    const call = (url, init = {}) => fetch("https://api.github.com/repos/" + repo + url, {
      cache: "no-cache", ...init,
      headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + token, "X-GitHub-Api-Version": "2022-11-28", ...init.headers },
    });
    const contents = (path) => "/contents/" + path.split("/").map(encodeURIComponent).join("/");
    return {
      where: repo, usesKey: true, canSave: true,
      // Check the key once up front, so a bad key gets a clear message instead of "file not found"
      async check() {
        const r = await call("");
        if (r.status === 401) throw new SourceError("GitHub did not accept the saved key — it may be mistyped, expired or deleted.", true);
        if (r.status === 403 || r.status === 404) throw new SourceError(`The saved key cannot read ${repo}. Make a key that has access to that repository.`, true);
        if (!r.ok) throw new SourceError(`GitHub said ${r.status} — try again in a minute.`);
      },
      async get(path, optional) {
        const r = await call(contents(path));
        if (r.status === 404) { if (optional) { shas[path] = null; return null; } throw new SourceError(`${path} is not in ${repo}`); }
        if (!r.ok) throw new SourceError(`GitHub said ${r.status} for ${path}`);
        const file = await r.json();
        shas[path] = file.sha;
        return b64decode(file.content);
      },
      // Saves one file as a commit on the repo's main branch
      async put(path, text, message) {
        const body = { message, content: b64encode(text) };
        if (shas[path]) body.sha = shas[path];
        const r = await call(contents(path), { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
        if (r.status === 409 || r.status === 422) throw new SourceError(`${path} was changed on GitHub by someone else since you opened it. Copy your changes somewhere, reload the page, and make them again.`);
        if (r.status === 403 || r.status === 404) throw new SourceError("Your key can only read. Make a new key with Contents set to “Read and write”, click “Forget key”, and connect with the new one.");
        if (r.status === 401) throw new SourceError("GitHub did not accept the key — it may have expired. Click “Forget key” and connect with a new one.");
        if (!r.ok) throw new SourceError(`GitHub said ${r.status} while saving ${path}`);
        shas[path] = (await r.json()).content.sha;
      },
    };
  }

  // Returns a source (see above). Throws SourceError with needKey = true when a key is needed.
  async function open(q, bookName) {
    if (q.get("text")) return folder(q.get("text"));
    const local = folder("../liturgy-text/");
    const probe = await fetch(local.where + `books/${bookName}.txt`, { method: "HEAD", cache: "no-cache" }).catch(() => null);
    if (probe && probe.ok) return local;

    const repo = q.get("repo") || DEFAULT_REPO;
    const token = key.get();
    if (!token) throw new SourceError("", true);
    const source = github(repo, token);
    await source.check();
    return source;
  }

  // A booklet = books/<name>.txt, a list of section files in order (// lines are comments)
  async function loadBook(source, bookName) {
    const list = (await source.get(`books/${bookName}.txt`)).split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("//"));
    const sections = await Promise.all(list.map(async (name) => ({ name, text: await source.get("text/" + name) })));
    // settings.css in the text repo = the settings saved from the editor (only the changed ones)
    const css = (await source.get(SETTINGS_FILE, true)) || "";
    return { sections, css };
  }

  root.LiturgySource = { open, loadBook, key, DEFAULT_REPO, SETTINGS_FILE };
})(window);
