import type { EditorPage } from '../editor/model';

export type PreflightSeverity = 'error' | 'warning' | 'info';

export type PreflightIssue = {
  severity: PreflightSeverity;
  code: string;
  message: string;
};

export type PreflightReport = {
  issues: PreflightIssue[];
  pages: number;
  hasPdfJavaScript: boolean;
};

function add(issues: PreflightIssue[], severity: PreflightSeverity, code: string, message: string) {
  issues.push({ severity, code, message });
}

export async function runPdfPreflight(input: ArrayBuffer, pages: EditorPage[]): Promise<PreflightReport> {
  const issues: PreflightIssue[] = [];
  const raw = new TextDecoder('latin1').decode(new Uint8Array(input));
  if (!raw.startsWith('%PDF-')) add(issues, 'error', 'header', 'O arquivo não possui um cabeçalho PDF válido.');
  const hasPdfJavaScript = /\/JavaScript\b|\/JS\b/.test(raw);
  if (hasPdfJavaScript) add(issues, 'warning', 'javascript', 'O PDF contém JavaScript. A execução automática permanece bloqueada no navegador.');
  if (!/%%EOF\s*$/.test(raw)) add(issues, 'warning', 'eof', 'O arquivo não termina com %%EOF; alguns visualizadores podem fazer recuperação incremental.');

  const { PDFDocument } = await import('@cantoo/pdf-lib');
  let document;
  try {
    document = await PDFDocument.load(input);
  } catch {
    add(issues, 'error', 'parse', 'O PDF não pôde ser interpretado pelo mecanismo de validação.');
    return { issues, pages: pages.length, hasPdfJavaScript };
  }
  if (document.getPageCount() !== pages.length) add(issues, 'error', 'page-count', `A estrutura declara ${document.getPageCount()} páginas, mas o modelo possui ${pages.length}.`);
  const formNames = new Map<string, number>();
  pages.forEach((page, pageIndex) => {
    const source = document.getPage(pageIndex);
    const width = source.getWidth();
    const height = source.getHeight();
    if (width < 36 || height < 36) add(issues, 'warning', 'page-size', `A página ${pageIndex + 1} é menor que 12,7 mm em uma das dimensões.`);
    if (width > 14400 || height > 14400) add(issues, 'warning', 'page-size', `A página ${pageIndex + 1} excede o limite prático de produção de 200 polegadas.`);
    page.elements.forEach((element) => {
      if (element.x < 0 || element.y < 0 || element.x + element.width > 1.001 || element.y + element.height > 1.001) add(issues, 'warning', 'overflow', `O elemento ${element.id} ultrapassa os limites da página ${pageIndex + 1}.`);
      if (element.type === 'image' && !element.altText) add(issues, 'warning', 'alt-text', `A imagem ${element.id} não possui texto alternativo.`);
      if (element.formName) formNames.set(element.formName, (formNames.get(element.formName) || 0) + 1);
      if (element.type === 'redaction') add(issues, 'info', 'redaction', `A página ${pageIndex + 1} contém redação segura e será rasterizada na exportação.`);
    });
  });
  for (const [name, count] of formNames) if (count > 1 && !name.includes('radio')) add(issues, 'warning', 'duplicate-field', `O campo de formulário “${name}” aparece ${count} vezes.`);
  if (!pages.length) add(issues, 'error', 'empty', 'O documento não possui páginas.');
  if (!document.getTitle() && !document.getAuthor()) add(issues, 'info', 'metadata', 'O PDF não possui título nem autor nos metadados.');
  if (pages.length > 250) add(issues, 'info', 'scale', 'Documento grande: a exportação usa worker e renderização sob demanda.');
  return { issues, pages: pages.length, hasPdfJavaScript };
}

export function formatPreflightReport(report: PreflightReport) {
  const errors = report.issues.filter((issue) => issue.severity === 'error').length;
  const warnings = report.issues.filter((issue) => issue.severity === 'warning').length;
  const infos = report.issues.filter((issue) => issue.severity === 'info').length;
  return `Preflight: ${errors} erro(s), ${warnings} aviso(s), ${infos} informação(ões).`;
}
