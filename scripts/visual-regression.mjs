import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const input = process.argv[2] || process.env.PDF_VISUAL_FILE || 'D:/acrobatt/Customer Support/Test Files/PDF13.pdf';
const outputDir = path.resolve(process.argv[3] || 'tmp/visual-regression');
const poppler = process.env.POPPLER_PDFTOPPM || 'pdftoppm';
await fs.mkdir(outputDir, { recursive: true });
const outputPrefix = path.join(outputDir, path.basename(input, path.extname(input)));
try {
  await execFileAsync(poppler, ['-f', '1', '-l', '1', '-r', '120', '-png', '-singlefile', input, outputPrefix], { windowsHide: true });
} catch (error) {
  if (error?.code === 'ENOENT') throw new Error('pdftoppm não encontrado. Configure POPPLER_PDFTOPPM para habilitar a regressão visual.');
  throw error;
}
const rendered = `${outputPrefix}.png`;
const png = await fs.readFile(rendered);
if (png.length < 100 || png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(16) === 0 || png.readUInt32BE(20) === 0) throw new Error('A renderização visual gerou um PNG inválido.');
console.log(`Visual regression passed: ${rendered} (${png.readUInt32BE(16)}x${png.readUInt32BE(20)}, ${png.length} bytes).`);
