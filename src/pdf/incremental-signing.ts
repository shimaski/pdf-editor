type Signer = { cert: unknown; privateKey: CryptoKey };

type CmsBuilder = (cert: unknown, privateKey: CryptoKey, digest: Uint8Array, signingTime: Date) => Promise<Uint8Array>;

export type IncrementalSigningApi = {
  getOrCreateSigner: () => Promise<Signer>;
  buildCmsSignature: CmsBuilder;
};

function latin1(bytes: Uint8Array) {
  let result = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) result += String.fromCharCode(...bytes.subarray(index, index + chunk));
  return result;
}

function bytes(text: string) {
  const result = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) result[index] = text.charCodeAt(index) & 0xff;
  return result;
}

function hex(input: Uint8Array) {
  let output = '';
  for (const value of input) output += value.toString(16).padStart(2, '0');
  return output;
}

function decodePdfText(value: string) {
  if (value.startsWith('<') && value.endsWith('>')) {
    const raw = value.slice(1, -1).replace(/\s/g, '');
    const result = new Uint8Array(raw.length / 2);
    for (let index = 0; index < result.length; index += 1) result[index] = Number.parseInt(raw.slice(index * 2, index * 2 + 2), 16);
    if (result.length >= 2 && result[0] === 0xfe && result[1] === 0xff) {
      let output = '';
      for (let index = 2; index + 1 < result.length; index += 2) output += String.fromCharCode((result[index] << 8) | result[index + 1]);
      return output;
    }
    return new TextDecoder().decode(result);
  }
  return value.slice(1, -1).replace(/\\([()\\])/g, '$1');
}

function findField(pdf: string, fieldName: string) {
  const objects = /(\d+)\s+(\d+)\s+obj\s*([\s\S]*?)\s*endobj/g;
  let found: { object: number; generation: number; body: string } | null = null;
  let match: RegExpExecArray | null;
  while ((match = objects.exec(pdf))) {
    const body = match[3];
    if (!/\/FT\s*\/Sig\b/.test(body)) continue;
    const nameMatch = body.match(/\/T\s*(<[^>]*>|\([^)]*\))/);
    if (!nameMatch || decodePdfText(nameMatch[1]) !== fieldName) continue;
    found = { object: Number(match[1]), generation: Number(match[2]), body };
  }
  if (found) return found;
  throw new Error(`Campo de assinatura não encontrado: ${fieldName}`);
}

function findTrailer(pdf: string) {
  const trailers = [...pdf.matchAll(/trailer\s*<<(.*?)>>/gs)];
  const trailer = trailers.at(-1)?.[1];
  const startxrefMatch = [...pdf.matchAll(/startxref\s*(\d+)/g)].at(-1);
  if (!trailer || !startxrefMatch) throw new Error('PDF sem trailer incremental compatível.');
  const root = trailer.match(/\/Root\s+(\d+\s+\d+\s+R)/)?.[1];
  const size = Number(trailer.match(/\/Size\s+(\d+)/)?.[1] || 0);
  if (!root || !size) throw new Error('Trailer do PDF sem Root ou Size.');
  return { trailer, root, size, previousXref: Number(startxrefMatch[1]) };
}

function replaceTrailerEntry(trailer: string, key: string, value: string) {
  const pattern = new RegExp(`/${key}\\s+[^/]+(?=\\s*/|\\s*$)`);
  return pattern.test(trailer) ? trailer.replace(pattern, `/${key} ${value}`) : `${trailer} /${key} ${value}`;
}

export function appendSignaturePlaceholder(input: Uint8Array, fieldName: string, placeholderHexLen = 8192) {
  const original = latin1(input);
  const field = findField(original, fieldName);
  if (/\/V\s+/.test(field.body)) throw new Error('Este campo já possui uma assinatura.');
  const trailer = findTrailer(original);
  const signatureObject = trailer.size;
  const updatedBody = field.body.replace(/>>\s*$/, `/V ${signatureObject} 0 R\n>>`);
  if (updatedBody === field.body) throw new Error('Não foi possível atualizar o campo de assinatura.');
  const signatureBody = `<<\n/Type /Sig\n/Filter /Adobe.PPKLite\n/SubFilter /adbe.pkcs7.detached\n/ByteRange [0 0000000000 0000000000 0000000000]\n/Contents <${'0'.repeat(placeholderHexLen)}>\n/M (D:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')})\n>>`;
  const fieldRecord = `${field.object} ${field.generation} obj\n${updatedBody}\nendobj\n`;
  const signatureRecord = `${signatureObject} 0 obj\n${signatureBody}\nendobj\n`;
  const objects = `\n${fieldRecord}${signatureRecord}`;
  const fieldOffset = original.length + 1;
  const signatureOffset = fieldOffset + fieldRecord.length;
  const xrefOffset = original.length + objects.length;
  const nextTrailer = replaceTrailerEntry(replaceTrailerEntry(trailer.trailer, 'Size', String(signatureObject + 1)), 'Prev', String(trailer.previousXref));
  const xref = `xref\n${field.object} 1\n${String(fieldOffset).padStart(10, '0')} ${String(field.generation).padStart(5, '0')} n \n${signatureObject} 1\n${String(signatureOffset).padStart(10, '0')} 00000 n \ntrailer\n<<${nextTrailer}>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return bytes(original + objects + xref);
}

export async function signLastPlaceholder(input: Uint8Array, api: IncrementalSigningApi) {
  const signer = await api.getOrCreateSigner();
  let pdf = latin1(input);
  const byteRangePositions = [...pdf.matchAll(/\/ByteRange/g)].map((match) => match.index || 0);
  const brPos = byteRangePositions.at(-1);
  if (brPos === undefined) throw new Error('Não foi encontrado um campo de assinatura pendente.');
  const brEnd = pdf.indexOf(']', brPos) + 1;
  const contentsPos = pdf.indexOf('/Contents ', brEnd);
  const placeholderPos = pdf.indexOf('<', contentsPos);
  const placeholderEnd = pdf.indexOf('>', placeholderPos);
  if (contentsPos < 0 || placeholderPos < 0 || placeholderEnd < 0) throw new Error('Placeholder de assinatura inválido.');
  const placeholderWithBrackets = placeholderEnd + 1 - placeholderPos;
  const placeholderHexLen = placeholderWithBrackets - 2;
  const range = [0, placeholderPos, placeholderPos + placeholderWithBrackets, pdf.length - (placeholderPos + placeholderWithBrackets)];
  const actualRange = `/ByteRange [${range.join(' ')}]`;
  pdf = pdf.slice(0, brPos) + actualRange.padEnd(brEnd - brPos, ' ') + pdf.slice(brEnd);
  pdf = pdf.slice(0, range[1]) + pdf.slice(range[2]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(pdf)));
  const cms = await api.buildCmsSignature(signer.cert, signer.privateKey, digest, new Date());
  const signatureHex = hex(cms);
  if (signatureHex.length > placeholderHexLen) throw new Error('O conteúdo criptográfico excede o espaço reservado.');
  return bytes(pdf.slice(0, range[1]) + `<${signatureHex.padEnd(placeholderHexLen, '0')}>` + pdf.slice(range[1]));
}

export function countPdfSignatures(input: Uint8Array) {
  return (latin1(input).match(/\/ByteRange\s*\[/g) || []).length;
}
