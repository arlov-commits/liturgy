// impose.js — booklet pages (a PDF saved from the preview) → letter sheets to print both sides and cut.
// Each letter sheet holds 4 booklet pages a side (2 × 2). Cut-and-stack order: cut every sheet into quarters,
// keep the four piles in sheet order, and pile top-left on top-right on bottom-left on bottom-right —
// the result is the book in page order, ready to glue. Works in the browser (window.LiturgyImpose) and in Node.
(function (root) {
  "use strict";

  const INCH = 72;
  // Quarter positions on a portrait letter sheet, in pile order: top-left, top-right, bottom-left, bottom-right
  const QUARTERS = [[0, 1], [1, 1], [0, 0], [1, 0]];   // [column, row from the bottom]
  // Printing both sides flipping on the long edge mirrors left and right: top-left on the front is
  // backed by top-right on the back
  const BACK_OF = [1, 0, 3, 2];

  // Which booklet page (1-based, or 0 = blank) goes where. Returns [{ front: [p, p, p, p], back: [...] }] per sheet.
  function layout(pageCount) {
    const leaves = Math.ceil(pageCount / 2);
    const sheets = Math.max(1, Math.ceil(leaves / 4));
    const page = (n) => (n <= pageCount ? n : 0);
    const out = [];
    for (let s = 0; s < sheets; s++) {
      const front = [], back = [];
      for (let q = 0; q < 4; q++) {
        const leaf = q * sheets + s;          // pile q holds leaves q·S … q·S+S−1, one per sheet
        front[q] = page(2 * leaf + 1);        // right-hand page (odd)
        back[BACK_OF[q]] = page(2 * leaf + 2); // its left-hand page (even), behind it
      }
      out.push({ front, back });
    }
    return out;
  }

  // pdfBytes: the booklet PDF (every page 4.25 × 5.5 in). Returns the sheets PDF as bytes.
  async function impose(PDFLib, pdfBytes) {
    const src = await PDFLib.PDFDocument.load(pdfBytes);
    const out = await PDFLib.PDFDocument.create();
    const count = src.getPageCount();
    const embedded = await out.embedPages(src.getPages());
    const { width, height } = src.getPage(0).getSize();
    const W = 8.5 * INCH, H = 11 * INCH, qw = W / 2, qh = H / 2;
    // centre each booklet page in its quarter (they're the same size unless the PDF was saved at another size)
    const scale = Math.min(qw / width, qh / height, 1);
    const dx = (qw - width * scale) / 2, dy = (qh - height * scale) / 2;
    for (const sheet of layout(count)) {
      for (const side of [sheet.front, sheet.back]) {
        const pg = out.addPage([W, H]);
        side.forEach((n, q) => {
          if (!n) return;
          const [col, row] = QUARTERS[q];
          pg.drawPage(embedded[n - 1], { x: col * qw + dx, y: row * qh + dy, xScale: scale, yScale: scale });
        });
      }
    }
    return { bytes: await out.save(), pages: count, sheets: layout(count).length, pageSize: [width / INCH, height / INCH] };
  }

  const api = { layout, impose };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LiturgyImpose = api;
})(typeof window !== "undefined" ? window : globalThis);
