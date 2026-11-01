import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const document = await PDFDocument.create();
document.setTitle('PDF Editor smoke test');
const page = document.addPage([612, 792]);
const font = await document.embedFont(StandardFonts.Helvetica);
page.drawText('PDF Editor integrity check', { x: 48, y: 730, size: 16, font, color: rgb(0.1, 0.15, 0.2) });
const bytes = await document.save({ useObjectStreams: true, addDefaultPage: false });
const reopened = await PDFDocument.load(bytes);

assert.equal(reopened.getPageCount(), 1, 'page count must survive save/reopen');
assert.equal(reopened.getTitle(), 'PDF Editor smoke test', 'metadata must survive save/reopen');
assert.ok(reopened.getPage(0).getWidth() > 0, 'page geometry must be valid');

console.log('PDF smoke test passed: 1 page, metadata and geometry preserved.');
