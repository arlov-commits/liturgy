// source.js — where the liturgy text is read from.
// 1. ?text=<folder>, or a liturgy-text folder cloned next to this app (the dev setup).
// 2. Otherwise the private GitHub repo (?repo=owner/name), read with a key the editor pastes in once.
(function (root) {
  "use strict";

  const DEFAULT_REPO = "arlov-commits/liturgy-text";
  const KEY_NAME = "liturgy.githubKey";

  // The key lives only in this browser. Storage can be blocked (private windows) — then it's just not remembered.
  const key = {
    get() { try { return localStorage.getItem(KEY_NAME) || ""; } catch { return ""; } },
    set(v) { try { localStorage.setItem(KEY_NAME, v); } catch {} },
    forget() { try { localStorage.removeItem(KEY_NAME); } catch {} },
  };

  class SourceError extends Error {
    constructor(message, needKey) { super(message); this.needKey = needKey; }
  }

  function folder(base) {
    base = base.replace(/\/?$/, "/");
    return async (path) => {
      const r = await fetch(base + path, { cache: "no-cache" });
      if (!r.ok) throw new SourceError(`${path} not found (${r.status})`);
      return r.text();
    };
  }

  // GitHub's REST API: GET /repos/{owner}/{repo}/contents/{path}, raw file body
  function github(repo, token) {
    const call = (url, accept) => fetch("https://api.github.com/repos/" + repo + url, {
      cache: "no-cache",
      headers: { Accept: accept, Authorization: "Bearer " + token, "X-GitHub-Api-Version": "2022-11-28" },
    });
    const get = async (path) => {
      const r = await call("/contents/" + path.split("/").map(encodeURIComponent).join("/"), "application/vnd.github.raw+json");
      if (r.status === 404) throw new SourceError(`${path} is not in ${repo}`);
      if (!r.ok) throw new SourceError(`GitHub said ${r.status} for ${path}`);
      return r.text();
    };
    // Check the key once up front, so a bad key gets a clear message instead of "file not found"
    get.check = async () => {
      const r = await call("", "application/vnd.github+json");
      if (r.status === 401) throw new SourceError("GitHub did not accept the saved key — it may be mistyped, expired or deleted.", true);
      if (r.status === 403 || r.status === 404) throw new SourceError(`The saved key cannot read ${repo}. Make a key that has access to that repository.`, true);
      if (!r.ok) throw new SourceError(`GitHub said ${r.status} — try again in a minute.`);
    };
    return get;
  }

  // Returns { get(path) → text, where, usesKey }. Throws SourceError with needKey = true when a key is needed.
  async function open(q, bookName) {
    if (q.get("text")) return { get: folder(q.get("text")), where: q.get("text"), usesKey: false };
    const local = "../liturgy-text/";
    const probe = await fetch(local + `books/${bookName}.txt`, { method: "HEAD", cache: "no-cache" }).catch(() => null);
    if (probe && probe.ok) return { get: folder(local), where: local, usesKey: false };

    const repo = q.get("repo") || DEFAULT_REPO;
    const token = key.get();
    if (!token) throw new SourceError("", true);
    const get = github(repo, token);
    await get.check();
    return { get, where: repo, usesKey: true };
  }

  root.LiturgySource = { open, key, DEFAULT_REPO };
})(window);
