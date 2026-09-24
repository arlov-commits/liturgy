// impose.js — which booklet page goes where on the letter sheets (4 pages on each side, 2 × 2).
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

  const api = { layout, BACK_OF };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LiturgyImpose = api;
})(typeof window !== "undefined" ? window : globalThis);
