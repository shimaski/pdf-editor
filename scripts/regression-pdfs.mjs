import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const directory = process.argv[2] || process.env.PDF_TEST_DIR || 'D:/acrobatt/Customer Support/Test Files';
const cMapUrl = `${path.join(path.dirname(fileURLToPath(import.meta.url)), '../node_modules/pdfjs-dist/cmaps')}${path.sep}`;
const names = (await fs.readdir(directory)).filter((name) => name.toLowerCase().endsWith('.pdf')).sort();
if (!names.length) throw new Error(`Nenhum PDF encontrado em ${directory}`);

let failures = 0;
for (const name of names) {
  const filePath = path.join(directory, name);
  try {
    const bytes = new Uint8Array(await fs.readFile(filePath));
    const loadingTask = getDocument({ data: bytes, disableWorker: true, cMapUrl, cMapPacked: true, useSystemFonts: true, stopAtErrors: false });
    const document = await loadingTask.promise;
    const firstPage = await document.getPage(1);
    const pageCount = document.numPages;
    const viewport = firstPage.getViewport({ scale: 1 });
    const text = await firstPage.getTextContent();
    const annotations = await firstPage.getAnnotations({ intent: 'display' });
    firstPage.cleanup();
    await document.destroy();
    console.log(`${name}: ${pageCount} página(s), ${text.items.length} item(ns) de texto, ${annotations.length} anotação(ões), ${Math.round(viewport.width)}x${Math.round(viewport.height)} pt`);
  } catch (error) {
    failures += 1;
    console.error(`${name}: FALHA - ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures) process.exitCode = 1;
else console.log(`PDF regression passed: ${names.length} arquivo(s) analisado(s).`);
