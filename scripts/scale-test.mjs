import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const fileCount = Number(process.env.PDF_SCALE_FILES || 25);
const pageCount = Number(process.env.PDF_SCALE_PAGES || 250);
assert.ok(fileCount > 0 && fileCount <= 5000, 'PDF_SCALE_FILES deve estar entre 1 e 5000');
assert.ok(pageCount > 0 && pageCount <= 5000, 'PDF_SCALE_PAGES deve estar entre 1 e 5000');

let peakRss = process.memoryUsage().rss;
for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const page = document.addPage([612, 792]);
    page.drawText(`Scale test ${fileIndex + 1}/${fileCount} - page ${pageIndex + 1}/${pageCount}`, { x: 36, y: 744, size: 10, font });
  }
  const bytes = await document.save({ useObjectStreams: true, addDefaultPage: false });
  const loaded = await getDocument({ data: new Uint8Array(bytes), disableWorker: true, useSystemFonts: true, stopAtErrors: false }).promise;
  assert.equal(loaded.numPages, pageCount, 'o total de páginas deve sobreviver à reabertura');
  for (const index of [...new Set([0, Math.floor(pageCount / 2), pageCount - 1])]) {
    const page = await loaded.getPage(index + 1);
    const text = await page.getTextContent();
    assert.ok(text.items.length > 0, 'cada página amostrada deve manter texto pesquisável');
    page.cleanup();
  }
  await loaded.destroy();
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  if (global.gc) global.gc();
  if ((fileIndex + 1) % 5 === 0 || fileIndex === fileCount - 1) console.log(`Escala: ${fileIndex + 1}/${fileCount} documentos de ${pageCount} páginas`);
}

console.log(`PDF scale test passed: ${fileCount} documentos, ${pageCount} páginas cada, pico RSS ${Math.round(peakRss / 1024 / 1024)} MB.`);
