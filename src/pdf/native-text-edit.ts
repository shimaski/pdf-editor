import type { EditorPage } from '../editor/model';
import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFDocument, StandardFonts, decodePDFRawStream } from 'pdf-lib';

const binary = (data: Uint8Array) => Array.from(data, byte => String.fromCharCode(byte)).join('');
type Token = { start: number; end: number; value: string; hex?: string };
// Tokenize strings separately so operator-like text inside a string is never executed.
function tokenize(source: string): Token[] {
  const result: Token[] = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source[i] === '%') { while (i < source.length && !/[\r\n]/.test(source[i])) i++; continue; }
    const start = i;
    let hex: string | undefined;
    if (source[i] === '(') {
      i++; let depth = 1; const codes: number[] = [];
      while (i < source.length && depth) {
        let c = source[i++];
        if (c === '\\') {
          c = source[i++];
          if (/[0-7]/.test(c)) {
            let octal = c;
            while (octal.length < 3 && /[0-7]/.test(source[i] || 'x')) octal += source[i++];
            codes.push(parseInt(octal, 8)); continue;
          }
          if (c === '\r' || c === '\n') { if (c === '\r' && source[i] === '\n') i++; continue; }
          codes.push(({ n: 10, r: 13, t: 9, b: 8, f: 12 } as Record<string, number>)[c] ?? c.charCodeAt(0));
        } else {
          if (c === '(') depth++;
          if (c === ')') depth--;
          if (depth) codes.push(c.charCodeAt(0));
        }
      }
      if (depth) throw new Error('String PDF incompleta.');
      hex = codes.map(c => c.toString(16).padStart(2, '0')).join('');
    } else if (source[i] === '<' && source[i + 1] === '<') {
      i += 2;
    } else if (source[i] === '<' && source[i + 1] !== '<') {
      i++; let value = '';
      while (i < source.length && source[i] !== '>') value += source[i++];
      if (source[i++] !== '>') throw new Error('String hexadecimal incompleta.');
      value = value.replace(/\s/g, '');
      if (!/^[a-f\d]*$/i.test(value)) throw new Error('String hexadecimal inválida.');
      hex = (value.length % 2 ? value + '0' : value).toLowerCase();
    } else if ('[]'.includes(source[i])) i++;
    else {
      i++;
      while (i < source.length && !/[\s()[\]<>/%]/.test(source[i])) i++;
    }
    result.push({ start, end: i, value: source.slice(start, i), hex });
  }
  return result;
}

function unicode(hex: string) {
  let value = '';
  for (let i = 0; i < hex.length; i += 4) value += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return value;
}

function fontMap(font: PDFDict): Map<string, string> {
  const map = new Map<string, string>();
  const cmap = font.lookup(PDFName.of('ToUnicode'));
  if (cmap instanceof PDFRawStream) {
    const source = binary(decodePDFRawStream(cmap).decode());
    for (const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of block[1].matchAll(/<([a-f\d]+)>\s*<([a-f\d]+)>/gi)) map.set(pair[1].toLowerCase(), unicode(pair[2]));
    }
    for (const block of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const range of block[1].matchAll(/<([a-f\d]+)>\s*<([a-f\d]+)>\s*(<([a-f\d]+)>|\[([^\]]*)\])/gi)) {
        const start = parseInt(range[1], 16), end = parseInt(range[2], 16);
        if (end - start > 65536) throw new Error('Mapa de fonte excede o limite.');
        const values = range[5] ? [...range[5].matchAll(/<([a-f\d]+)>/gi)].map(v => v[1]) : null;
        for (let n = start; n <= end; n++) {
          const value = values?.[n - start] ?? (parseInt(range[4], 16) + n - start).toString(16).padStart(range[4]?.length || 4, '0');
          map.set(n.toString(16).padStart(range[1].length, '0'), unicode(value));
        }
      }
    }
    return map;
  }
  const encoding = font.lookup(PDFName.of('Encoding'));
  const baseFont = font.lookup(PDFName.of('BaseFont'))?.toString() || '';
  const standard = /^\/(Helvetica|Times|Courier)(-|$)/.test(baseFont);
  if (encoding?.toString() === '/WinAnsiEncoding' || (!encoding && standard)) {
    const decoder = new TextDecoder('windows-1252');
    for (let n = 32; n < 256; n++) {
      if (!encoding && n > 126) break;
      map.set(n.toString(16).padStart(2, '0'), decoder.decode(new Uint8Array([n])));
    }
  }
  return map;
}

function decode(hex: string, map: Map<string, string>): string | null {
  const widths = [...new Set([...map.keys()].map(k => k.length))].sort((a, b) => b - a);
  let value = '', offset = 0;
  while (offset < hex.length) {
    const width = widths.find(w => map.has(hex.slice(offset, offset + w)));
    if (!width) return null;
    value += map.get(hex.slice(offset, offset + width));
    offset += width;
  }
  return value;
}

function encode(value: string, map: Map<string, string>): string | null {
  const inverse = new Map([...map].map(([code, text]) => [text, code]));
  const units = [...inverse.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  let result = '', offset = 0;
  while (offset < value.length) {
    const unit = units.find(u => value.startsWith(u, offset));
    if (!unit) return null;
    result += inverse.get(unit); offset += unit.length;
  }
  return result;
}

function winAnsiMap() {
  const map = new Map<string, string>();
  const decoder = new TextDecoder('windows-1252');
  for (let n = 32; n < 256; n++) map.set(n.toString(16).padStart(2, '0'), decoder.decode(new Uint8Array([n])));
  return map;
}

export async function applyNativeTextEdits(input: ArrayBuffer, pages: EditorPage[]) {
  const source = await PDFDocument.load(input);
  const appliedElementIds = new Set<string>();
  for (const editorPage of pages) {
    if (editorPage.sourcePage === null) continue;
    const edits = editorPage.elements.filter(e => e.isExistingText && e.type === 'text');
    for (const edit of edits) if (edit.originalText === edit.text && !edit.deleted && (edit.originalX === undefined || (Math.abs(edit.x - edit.originalX) <= 0.0005 && Math.abs(edit.y - (edit.originalY ?? edit.y)) <= 0.0005 && Math.abs(edit.width - (edit.originalWidth ?? edit.width)) <= 0.0005 && Math.abs(edit.height - (edit.originalHeight ?? edit.height)) <= 0.0005))) appliedElementIds.add(edit.id);
    const changed = edits.filter(e => e.originalText !== e.text);
    if (!changed.length) continue;
    // Duplicates share a source page: refuse to modify unrelated copies.
    if (pages.filter(p => p.sourcePage === editorPage.sourcePage).length > 1) throw new Error('Edite o texto antes de duplicar esta página; a fonte compartilhada exige exportação separada.');
    const page = source.getPage(editorPage.sourcePage);
    const fonts = page.node.Resources()?.lookup(PDFName.of('Font'));
    if (!(fonts instanceof PDFDict)) throw new Error('Os recursos da fonte original não estão disponíveis.');
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i)) : [contents];
    const candidates: { stream: number; start: number; end: number; text: string; map: Map<string, string>; fontName: string }[] = [];
    const decoded = streams.map(s => {
      if (!(s instanceof PDFRawStream)) throw new Error('Conteúdo PDF incompatível com edição tipográfica.');
      return binary(decodePDFRawStream(s).decode());
    });
    let map = new Map<string, string>();
    let fontName = '';
    decoded.forEach((content, stream) => {
      const tokens = tokenize(content);
      // Inline images need a binary-aware parser; never interpret their bytes as text.
      if (tokens.some(t => t.value === 'BI')) throw new Error('Esta página contém imagem inline; a edição nativa deste formato ainda não é suportada.');
      tokens.forEach((token, index) => {
        if (token.value === 'Tf') {
          fontName = tokens[index - 2]?.value.slice(1) || '';
          const font = fonts.lookup(PDFName.of(fontName));
          map = font instanceof PDFDict ? fontMap(font) : new Map();
        }
        if (token.value !== 'Tj' && token.value !== 'TJ') return;
        let first = index - 1;
        if (token.value === 'TJ') {
          while (first >= 0 && tokens[first].value !== '[') first--;
        }
        if (first < 0) return;
        const strings = tokens.slice(first, index).filter(t => t.hex !== undefined);
        if (!strings.length) return;
        const parts = strings.map(t => decode(t.hex!, map));
        if (parts.some(p => p === null)) return;
        candidates.push({ stream, start: tokens[first].start, end: token.end, text: parts.join(''), map, fontName });
      });
    });
    const replacements = new Map<number, { start: number; end: number; value: string }[]>();
    const fallbackMap = winAnsiMap();
    let fallbackFont: { ref: ReturnType<PDFDocument['embedFont']> extends Promise<infer T> ? T extends { ref: infer R } ? R : never : never } | null = null;
    for (const edit of changed) {
      const matches = candidates.filter(c => c.text === edit.originalText);
      if (matches.length !== 1) throw new Error('Não foi possível identificar unicamente este trecho na fonte original. A exportação foi interrompida para preservar o documento.');
      const match = matches[0];
      const value = encode(edit.text || '', match.map);
      let replacement = edit.text === '' ? '<> Tj' : value ? `<${value}> Tj` : null;
      if (!replacement) {
        const fallbackText = encode(edit.text || '', fallbackMap);
        if (!fallbackText) throw new Error('O texto contém caracteres sem glifo na fonte original e sem equivalente WinAnsi.');
        if (!fallbackFont) fallbackFont = await source.embedFont(StandardFonts.Helvetica);
        if (fonts instanceof PDFDict) fonts.set(PDFName.of('PDFEditorFallback'), fallbackFont.ref);
        replacement = `/PDFEditorFallback 1 Tf <${fallbackText}> Tj`;
      }
      const list = replacements.get(match.stream) || [];
      if (list.some(r => r.start === match.start)) throw new Error('Duas edições apontam para o mesmo trecho.');
      list.push({ start: match.start, end: match.end, value: replacement });
      replacements.set(match.stream, list);
      appliedElementIds.add(edit.id);
    }
    const newStreams = decoded.map((content, index) => {
      for (const replacement of (replacements.get(index) || []).sort((a, b) => b.start - a.start)) {
        content = content.slice(0, replacement.start) + replacement.value + content.slice(replacement.end);
      }
      return source.context.register(source.context.flateStream(Uint8Array.from(content, c => c.charCodeAt(0))));
    });
    page.node.set(PDFName.of('Contents'), source.context.obj(newStreams));
  }
  const output = await source.save();
  return { bytes: output.slice().buffer as ArrayBuffer, appliedElementIds };
}
