// source.js — where the liturgy text is read from.
// 1. ?text=<folder>, or a liturgy-text folder cloned next to this app (the dev setup).
// 2. A folder on this computer picked in the editor (Chrome/Edge folder access) — read and saved to directly.
// 3. Otherwise the private GitHub repo (?repo=owner/name), read (and saved to) with a key the editor pastes in once.
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
    constructor(message, needKey, needFolder) { super(message); this.needKey = needKey; this.needFolder = needFolder; }
  }

  // A folder picked on this computer, remembered between visits (the browser asks again before reuse)
  const FOLDER_KEY = "liturgy.folder";
  const pickedFolder = {
    available: () => typeof window.showDirectoryPicker === "function" && typeof idbKeyval !== "undefined",
    async get() { try { return (await idbKeyval.get(FOLDER_KEY)) || null; } catch { return null; } },
    async pick() {
      const handle = await window.showDirectoryPicker({ id: "liturgy-text", mode: "readwrite" });
      try { await handle.getDirectoryHandle("books"); } catch {
        throw new SourceError(`The folder “${handle.name}” has no “books” folder inside. Pick your liturgy-text folder (the one with “books” and “text” in it).`);
      }
      await idbKeyval.set(FOLDER_KEY, handle);
      return handle;
    },
    async forget() { try { await idbKeyval.del(FOLDER_KEY); } catch {} },
  };

  function directory(handle) {
    // "text/a.txt" → [folder handle of "text", "a.txt"]
    const walk = async (path, create) => {
      const parts = path.split("/").filter(Boolean);
      let dir = handle;
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
      return [dir, parts[parts.length - 1]];
    };
    return {
      where: `the folder “${handle.name}”`, usesKey: false, canSave: true, isPickedFolder: true,
      async get(path, optional) {
        try {
          const [dir, name] = await walk(path, false);
          return await (await (await dir.getFileHandle(name)).getFile()).text();
        } catch (e) {
          if (e.name !== "NotFoundError" && e.name !== "TypeMismatchError") throw e;
          if (optional) return null;
          throw new SourceError(`${path} is not in the folder ${handle.name}`);
        }
      },
      async list(path) {
        const names = [];
        try {
          const [dir, name] = await walk(path + "/x", false);
          void name;
          for await (const [n, h] of dir.entries()) if (h.kind === "file") names.push(n);
        } catch {}
        return names;
      },
      async put(path, text) {
        const [dir, name] = await walk(path, true);
        const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await w.write(text);
        await w.close();
      },
      async remove(path) {
        try { const [dir, name] = await walk(path, false); await dir.removeEntry(name); } catch (e) { if (e.name !== "NotFoundError") throw e; }
      },
    };
  }

  const parseJson = (text) => { try { return JSON.parse(text); } catch { return null; } };
  const b64decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
  const b64encode = (text) => {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };

  // A source reads files by path (e.g. "text/03-amitabha-sutra.txt"). get(path, true) returns null for a missing file;
// list(dir) gives the file names in a folder.
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
      // File names in a folder — reads the dev server's folder listing; [] when there isn't one
      async list(dir) {
        const r = await fetch(base + dir.replace(/\/?$/, "/"), { cache: "no-cache" }).catch(() => null);
        if (!r || !r.ok) return [];
        const doc = new DOMParser().parseFromString(await r.text(), "text/html");
        return [...doc.querySelectorAll("a[href]")].map((a) => decodeURIComponent(a.getAttribute("href"))).filter((h) => !h.includes("/"));
      },
    };
  }

  // GitHub's REST API: /repos/{owner}/{repo}/contents/{path}. Remembers each file's version (sha) as read,
  // so a save can't silently overwrite a change someone else made in the meantime.
  // "no-store": the browser must never answer from its own cache — an older version of this app asked for the
  // same addresses as plain text, and a stored plain-text answer broke the JSON reading ("// Test bo… is not valid JSON").
  function github(repo, token) {
    const shas = {};
    const call = (url, init = {}) => fetch("https://api.github.com/repos/" + repo + url, {
      cache: "no-store", ...init,
      headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + token, "X-GitHub-Api-Version": "2022-11-28", ...init.headers },
    });
    const contents = (path) => "/contents/" + path.split("/").map(encodeURIComponent).join("/");
    // a file's version: known from reading it, else asked for (e.g. it was read as plain text, see get)
    async function version(path) {
      for (let tries = 0; !(path in shas) && tries < 2; tries++) {   // (a plain-text answer: ask once more)
        const r = await call(contents(path));
        const file = r.ok ? parseJson(await r.text()) : null;
        if (!r.ok || file) shas[path] = file && file.sha ? file.sha : null;
      }
      return shas[path] ?? null;
    }
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
        const body = await r.text();
        const file = parseJson(body);
        if (file && typeof file.content === "string") {
          shas[path] = file.sha;
          return b64decode(file.content);
        }
        // Got the file itself instead of GitHub's description of it: use it; its version is looked up when saving
        delete shas[path];
        return body;
      },
      async list(dir) {
        const r = await call(contents(dir));
        const files = r.ok ? parseJson(await r.text()) : null;
        return Array.isArray(files) ? files.filter((f) => f.type === "file").map((f) => f.name) : [];
      },
      // Saves one file as a commit on the repo's main branch
      async put(path, text, message) {
        const body = { message, content: b64encode(text) };
        if (await version(path)) body.sha = shas[path];
        const r = await call(contents(path), { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
        if (r.status === 409 || r.status === 422) throw new SourceError(`${path} was changed on GitHub by someone else since you opened it. Copy your changes somewhere, reload the page, and make them again.`);
        if (r.status === 403 || r.status === 404) throw new SourceError("Your key can only read. Make a new key with Contents set to “Read and write”, click “Disconnect” at the top, and connect with the new one.");
        if (r.status === 401) throw new SourceError("GitHub did not accept the key — it may have expired. Click “Disconnect” at the top and connect with a new one.");
        if (!r.ok) throw new SourceError(`GitHub said ${r.status} while saving ${path}`);
        shas[path] = (await r.json()).content.sha;
      },
      // Deletes one file as a commit (nothing to do if it isn't there)
      async remove(path, message) {
        if (!(await version(path))) return;
        const r = await call(contents(path), { method: "DELETE", body: JSON.stringify({ message, sha: shas[path] }), headers: { "Content-Type": "application/json" } });
        if (r.status === 409 || r.status === 422) throw new SourceError(`${path} was changed on GitHub by someone else since you opened it. Reload the page and try again.`);
        if (r.status === 403) throw new SourceError("Your key can only read. Make a new key with Contents set to “Read and write”, click “Disconnect” at the top, and connect with the new one.");
        if (!r.ok && r.status !== 404) throw new SourceError(`GitHub said ${r.status} while removing ${path}`);
        shas[path] = null;
      },
    };
  }

  // Returns a source (see above). Throws SourceError with needKey = true when a key is needed.
  async function open(q, bookName) {
    if (q.get("text")) return folder(q.get("text"));
    // the dev setup: its books folder answers (a dev server lists it) — or at least the booklet asked for
    const local = folder("../liturgy-text/");
    const answers = async (path) => { const r = await fetch(local.where + path, { method: "HEAD", cache: "no-cache" }).catch(() => null); return !!(r && r.ok); };
    if ((await answers("books/")) || (bookName && (await answers(`books/${bookName}.txt`)))) return local;

    if (pickedFolder.available()) {
      const handle = await pickedFolder.get();
      if (handle) {
        if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") return directory(handle);
        throw new SourceError("", false, handle);   // the browser must ask again, after a click
      }
    }

    const repo = q.get("repo") || DEFAULT_REPO;
    const token = key.get();
    if (!token) throw new SourceError("", true);
    const source = github(repo, token);
    await source.check();
    return source;
  }

  // The booklets there are (books/<name>.txt), in the order kept in booklets.txt (others after it, A–Z);
  // [] when the source can't list its folders
  const ORDER_FILE = "booklets.txt";
  async function bookNames(source) {
    const names = (await source.list("books")).filter((n) => n.endsWith(".txt")).map((n) => n.slice(0, -4)).sort();
    const order = listNames((await source.get(ORDER_FILE, true)) || "");
    return [...order.filter((n) => names.includes(n)), ...names.filter((n) => !order.includes(n))];
  }

  // A booklet = books/<name>.txt, a list of chapter files in order (// lines are comments)
  // A line may give the chapter a name for this booklet's contents list: "01-traditions.txt = Traditions"
  const listEntries = (listText) => listText.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("//"))
    .map((s) => { const i = s.indexOf(" = "); return i < 0 ? { name: s } : { name: s.slice(0, i).trim(), alias: s.slice(i + 3).trim() }; });
  const listNames = (listText) => listEntries(listText).map((e) => e.name);
  // "[contents]" in a booklet list = a table of contents made automatically. It can be edited like a chapter
  // (a title above the list, a note below…); the edited text is kept per booklet in books/contents/<booklet>.txt.
  const CONTENTS_ENTRY = "[contents]", CONTENTS_TEXT = "[toc: -]\n[contents]\n";
  const contentsFile = (bookName) => `books/contents/${bookName}.txt`;
  async function loadContents(source, bookName) {
    const saved = await source.get(contentsFile(bookName), true);
    return { name: CONTENTS_ENTRY, text: saved ?? CONTENTS_TEXT, original: CONTENTS_TEXT, edited: saved !== null, virtual: true };
  }
  // The original text (text/<name>) is never changed by the editor: edits are a parallel edition in
  // edits/<name>. A chapter reads as its edited version when there is one, else the original.
  const ORIGINAL = "text/", EDITION = "edits/";
  async function loadChapter(source, name) {
    const [original, edited] = await Promise.all([source.get(ORIGINAL + name, true), source.get(EDITION + name, true)]);
    if (original === null && edited === null) throw new SourceError(`There is no chapter called ${name}`);
    return { name, text: edited ?? original, original, edited: edited !== null };
  }
  // Each booklet's settings (only the ones changed from the app's defaults) are kept in books/settings/<booklet>.css.
  // A booklet without its own starts from the shared settings.css (where all booklets' settings used to be kept).
  const settingsFile = (bookName) => `books/settings/${bookName}.css`;
  // Settings saved before 2026-09-26 were for a 4.25 × 5.5 in page with the text sizes of that time. Since then the page
  // is designed at letter size (printing scales it to the format) and the defaults are twice as big. An older file
  // ("--settings-version: 2" missing) is read with the old defaults for anything it doesn't set, so it looks as before.
  const SETTINGS_VERSION = 2;
  const OLD_DEFAULTS = {
    "--page-width": "4.25in", "--page-height": "5.5in", "--margin-binding": "0.45in", "--margin-outside": "0.25in",
    "--margin-top": "0.3in", "--margin-bottom": "0.45in", "--page-number-size": "10pt", "--english-size": "8.2pt",
    "--chinese-size": "14.5pt", "--pinyin-size": "8.4pt", "--space-english-to-chinese": "1pt", "--space-chinese-to-pinyin": "-1pt",
    "--space-between-verses": "6pt", "--border-width": "0.75pt", "--border-padding": "5pt", "--border-space": "6pt",
    "--contents-size": "9pt", "--contents-spacing": "4pt",
  };
  function upgradeSettings(css) {
    if (!css.trim() || /--settings-version\s*:\s*2\b/.test(css)) return css;
    const set = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const add = Object.entries(OLD_DEFAULTS).filter(([k]) => !set.has(k)).map(([k, v]) => `  ${k}: ${v};  /* (from before 2026-09-26) */`);
    return css + `\n/* read as it was before 2026-09-26 */\n:root {\n${add.join("\n")}\n  --settings-version: ${SETTINGS_VERSION};\n}\n`;
  }
  const loadSettings = async (source, bookName) =>
    upgradeSettings((await source.get(settingsFile(bookName), true)) ?? (await source.get(SETTINGS_FILE, true)) ?? "");
  async function loadBook(source, bookName) {
    const listText = await source.get(`books/${bookName}.txt`);
    const sections = await Promise.all(listNames(listText).map((name) =>
      name === CONTENTS_ENTRY ? loadContents(source, bookName) : loadChapter(source, name)));
    // settings.css in the text repo = the settings saved from the editor (only the changed ones)
    const css = await loadSettings(source, bookName);
    return { listText, sections, css };
  }

  root.LiturgySource = { open, bookNames, ORDER_FILE, loadBook, loadChapter, ORIGINAL, EDITION, listNames, listEntries, key, pickedFolder, DEFAULT_REPO, SETTINGS_FILE, CONTENTS_ENTRY, CONTENTS_TEXT, loadContents, contentsFile, settingsFile, loadSettings, SETTINGS_VERSION };
})(window);
