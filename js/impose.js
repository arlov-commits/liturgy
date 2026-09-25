// impose.js — which booklet page goes where on the letter sheets.
// Perfect binding (cut and glued): 4 pages on each side, 2 × 2 — layout(). Folded signatures: signatures() below.
// Every sheet holds 8 pages in a row; printed both sides (flip on the long edge), each page lands behind its
// partner, and the front of each half shows a facing pair:
//               top left  top right  bottom left  bottom right
//   front          2         3           6            7
//   back           4         1           8            5
// Cut each sheet into four and stack the pieces in page order (1–2, 3–4, 5–6, 7–8, then the next sheet).
// Works in the browser (window.LiturgyImpose) and in Node.
(function (root) {
  "use strict";

  const FRONT = [2, 3, 6, 7], BACK = [4, 1, 8, 5];   // pages 1–8 of a sheet, in the order TL, TR, BL, BR
  // Printing both sides flipping on the long edge mirrors left and right: the back of front top-left is back top-right
  const BACK_OF = [1, 0, 3, 2];

  // [{ front: [TL, TR, BL, BR], back: [...] }] per sheet; page numbers start at 1, 0 = blank
  function layout(pageCount) {
    const sheets = Math.max(1, Math.ceil(pageCount / 8));
    const page = (n) => (n <= pageCount ? n : 0);
    return Array.from({ length: sheets }, (_, s) => ({ front: FRONT.map((p) => page(8 * s + p)), back: BACK.map((p) => page(8 * s + p)) }));
  }

  // ---- Signatures: letter sheets printed landscape, two pages a side, folded in half and nested ----
  // The sheets are split into signatures (groups folded together) as bookbinder-js does it: a size in sheets, and
  // when the sheets don't divide evenly, the signatures differ by at most one sheet (never one thin one at the end).
  // setting: "auto" (at most 8 sheets = 32 pages each, since thicker folds bulge), "all" (one signature) or a number.
  const MAX_SHEETS = 8;
  function signaturePlan(pageCount, setting = "auto") {
    const sheets = Math.max(1, Math.ceil(pageCount / 4));
    const most = setting === "all" ? sheets : +setting > 0 ? +setting : MAX_SHEETS;
    const n = Math.ceil(sheets / most), base = Math.floor(sheets / n), extra = sheets % n;
    return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));   // sheets in each signature
  }
  // [{ signature, sheet, front: [left, right], back: [left, right] }] in printing order (each signature from its
  // outermost sheet in); pages from 1, 0 = blank. Printed both sides flipping on the SHORT edge.
  //   signature of N pages, sheet k from the outside: front = N−2k | 1+2k, back = 2+2k | N−1−2k
  function signatures(pageCount, setting) {
    const out = [];
    let start = 0;
    signaturePlan(pageCount, setting).forEach((sheets, signature) => {
      const N = 4 * sheets, page = (i) => (start + i <= pageCount ? start + i : 0);
      for (let k = 0; k < sheets; k++) {
        out.push({ signature, sheet: k, front: [page(N - 2 * k), page(1 + 2 * k)], back: [page(2 + 2 * k), page(N - 1 - 2 * k)] });
      }
      start += N;
    });
    return out;
  }

  const api = { layout, BACK_OF, signaturePlan, signatures, MAX_SHEETS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LiturgyImpose = api;
})(typeof window !== "undefined" ? window : globalThis);
