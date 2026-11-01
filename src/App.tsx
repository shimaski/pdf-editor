import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type * as PdfJs from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { clonePages, hexToRgb, uid, type EditorElement, type EditorPage, type FormKind, type ShapeKind, type Tool } from './editor/model';
import { mergeEditorPages } from './editor/conflict-merge';
import { clearRecoverySnapshot, loadRecoverySnapshot, saveRecoverySnapshot, type RecoverySnapshot } from './editor/recovery';
import { LruCache } from './editor/lru-cache';
import { cloudConfigurationMessage, supabase, supabaseConfigured } from './cloud/supabase';
import { createDocumentCollaboration, type CollaborationConflict, type CollaboratorPresence, type DocumentCollaboration } from './cloud/collaboration';
import { convertDocumentToPdf, integrationCapabilities, requestRemoteSignature } from './cloud/integrations';
import { appendSignaturePlaceholder, countPdfSignatures, signLastPlaceholder } from './pdf/incremental-signing';
import { disposePdfWorker, optimizePdfInWorker } from './pdf/worker-client';
import { applyNativeTextEdits } from './pdf/native-text-edit';
import { formatPreflightReport, runPdfPreflight } from './pdf/preflight';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bookmark,
  Bold,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Copy,
  Crop,
  Download,
  Eraser,
  FilePlus2,
  FileText,
  FormInput,
  FolderOpen,
  Fullscreen,
  Highlighter,
  ImagePlus,
  Italic,
  Layers2,
  LineChart,
  ListChecks,
  Menu,
  MessageSquare,
  MoreHorizontal,
  MousePointer2,
  Pencil,
  Plus,
  Redo2,
  RotateCw,
  Save,
  Search,
  ScanText,
  ShieldAlert,
  Stamp,
  Settings2,
  Square,
  Strikethrough,
  Sun,
  Trash2,
  Type,
  Underline,
  Undo2,
  Users,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

let pdfjsRuntime: typeof import('pdfjs-dist') | null = null;
let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;
let pdfLibRuntime: typeof import('pdf-lib') | null = null;
let pdfLibPromise: Promise<typeof import('pdf-lib')> | null = null;
let securePdfLibRuntime: typeof import('@cantoo/pdf-lib') | null = null;
let securePdfLibPromise: Promise<typeof import('@cantoo/pdf-lib')> | null = null;
const pdfJsTextOptions = { cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`, cMapPacked: true, useSystemFonts: true, stopAtErrors: false };
const textPlacementChanged = (element: EditorElement) => element.isExistingText && element.originalX !== undefined && (Math.abs(element.x - element.originalX) > 0.0005 || Math.abs(element.y - (element.originalY ?? element.y)) > 0.0005 || Math.abs(element.width - (element.originalWidth ?? element.width)) > 0.0005 || Math.abs(element.height - (element.originalHeight ?? element.height)) > 0.0005);

async function getPdfJs() {
  if (pdfjsRuntime) return pdfjsRuntime;
  pdfjsPromise ??= import('pdfjs-dist').then((module) => {
    module.GlobalWorkerOptions.workerSrc = pdfjsWorker;
    pdfjsRuntime = module;
    return module;
  });
  pdfjsRuntime = await pdfjsPromise;
  return pdfjsRuntime;
}

async function getPdfLib() {
  if (pdfLibRuntime) return pdfLibRuntime;
  pdfLibPromise ??= import('pdf-lib');
  pdfLibRuntime = await pdfLibPromise;
  return pdfLibRuntime;
}

async function getSecurePdfLib() {
  if (securePdfLibRuntime) return securePdfLibRuntime;
  securePdfLibPromise ??= import('@cantoo/pdf-lib');
  securePdfLibRuntime = await securePdfLibPromise;
  return securePdfLibRuntime;
}

async function getPdfSigner() {
  return import('js-pdf-signer/src/index.js');
}

type MenuKey = 'Arquivo' | 'Editar' | 'Exibir' | 'Documento' | 'Ferramentas' | null;
type PdfTextRun = { id: string; text: string; x: number; y: number; width: number; height: number; fontSize: number; fontFamily?: string; bold?: boolean; italic?: boolean };

function getTextCoverPadding(fontSize: number) {
  return { x: 1.25, top: 1.25, bottom: Math.max(2.5, Math.min(4.5, fontSize * 0.35)) };
}

function sampleTextRunBackground(canvas: HTMLCanvasElement | null, run: PdfTextRun, pageSize: { width: number; height: number }) {
  const context = canvas?.getContext('2d', { willReadFrequently: true });
  if (!canvas || !context) return '#ffffff';
  const x = run.x / pageSize.width * canvas.width;
  const y = run.y / pageSize.height * canvas.height;
  const width = run.width / pageSize.width * canvas.width;
  const height = run.height / pageSize.height * canvas.height;
  const points = [[x - 2, y - 2], [x + width + 2, y - 2], [x - 2, y + height + 2], [x + width + 2, y + height + 2]];
  const colors = points.map(([px, py]) => {
    const pixel = context.getImageData(Math.max(0, Math.min(canvas.width - 1, px)), Math.max(0, Math.min(canvas.height - 1, py)), 1, 1).data;
    return `#${[pixel[0], pixel[1], pixel[2]].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  });
  return colors.sort((a, b) => colors.filter((color) => color === b).length - colors.filter((color) => color === a).length)[0] || '#ffffff';
}
type PdfBookmark = { title: string; dest?: unknown; items?: PdfBookmark[] };
type PdfAnnotation = { subtype?: string; fieldType?: string; fieldName?: string; fieldValue?: unknown; fieldFlags?: number; rect?: number[] };

function annotationToElement(annotation: PdfAnnotation, pageWidth: number, pageHeight: number): EditorElement | null {
  if (annotation.subtype !== 'Widget' || !annotation.rect || annotation.rect.length < 4 || !annotation.fieldName) return null;
  const [x1, y1, x2, y2] = annotation.rect;
  const width = Math.max(0.02, (x2 - x1) / pageWidth);
  const height = Math.max(0.02, (y2 - y1) / pageHeight);
  const x = Math.max(0, x1 / pageWidth);
  const y = Math.max(0, 1 - y2 / pageHeight);
  const type = annotation.fieldType === 'Sig' ? 'signatureField' : annotation.fieldType === 'Tx' ? 'formText' : annotation.fieldType === 'Ch' ? 'select' : annotation.fieldFlags && (annotation.fieldFlags & 32768) !== 0 ? 'radio' : 'checkbox';
  return { id: uid(), type, x, y, width, height, formName: annotation.fieldName, formValue: annotation.fieldValue == null ? '' : String(annotation.fieldValue), checked: Boolean(annotation.fieldValue && annotation.fieldValue !== 'Off'), color: '#1d252d', stroke: '#66717b', fill: '#ffffff', opacity: 1 };
}

const initialZoom = 0.95;
const MAX_PDF_FILE_BYTES = 200 * 1024 * 1024;
const MAX_PDF_PAGES = 5000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const toolDefinitions: { id: Tool; label: string; icon: typeof MousePointer2; shortcut?: string }[] = [
  { id: 'select', label: 'Selecionar', icon: MousePointer2, shortcut: 'V' },
  { id: 'text', label: 'Texto', icon: Type, shortcut: 'T' },
  { id: 'image', label: 'Imagem', icon: ImagePlus },
  { id: 'draw', label: 'Desenhar', icon: Pencil },
  { id: 'shape', label: 'Forma', icon: Square },
  { id: 'highlight', label: 'Destaque', icon: Highlighter },
  { id: 'comment', label: 'Comentário', icon: MessageSquare },
  { id: 'stamp', label: 'Carimbo', icon: Stamp },
  { id: 'form', label: 'Formulário', icon: FormInput },
  { id: 'redact', label: 'Redação', icon: ShieldAlert },
  { id: 'crop', label: 'Recortar', icon: Crop },
  { id: 'signature', label: 'Assinar', icon: Pencil },
];
const primaryToolIds = new Set<Tool>(['select', 'text', 'image', 'draw', 'shape', 'highlight', 'signature']);
const secondaryToolDefinitions = toolDefinitions.filter(({ id }) => !primaryToolIds.has(id));

const menuItems: Record<Exclude<MenuKey, null>, { label: string; shortcut?: string; divider?: boolean }[]> = {
  Arquivo: [
    { label: 'Novo documento' }, { label: 'Abrir PDF', shortcut: 'Ctrl O' }, { label: 'Abrir recente' },
    { label: 'Salvar', shortcut: 'Ctrl S' }, { label: 'Salvar como' }, { label: 'Exportar' }, { label: 'Exportar PNG' }, { label: 'Exportar texto' }, { label: 'Extrair texto em lote' }, { label: 'Anexar arquivo' }, { label: 'Exportar portfólio' }, { label: 'Proteger documento' }, { label: 'Imprimir', divider: true }, { label: 'Fechar' },
    ...(integrationCapabilities.office ? [{ label: 'Importar Office' }] : []),
    ...(integrationCapabilities.cad ? [{ label: 'Converter DWG/DXF' }] : []),
  ],
  Editar: [
    { label: 'Desfazer', shortcut: 'Ctrl Z' }, { label: 'Refazer', shortcut: 'Ctrl Shift Z' }, { label: 'Copiar', shortcut: 'Ctrl C' },
    { label: 'Colar', shortcut: 'Ctrl V' }, { label: 'Recortar', shortcut: 'Ctrl X' }, { label: 'Buscar', shortcut: 'Ctrl F', divider: true }, { label: 'Excluir elemento', shortcut: 'Delete' },
  ],
  Exibir: [
    { label: 'Zoom +' }, { label: 'Zoom -' }, { label: 'Ajustar à largura' }, { label: 'Ajustar à página', divider: true },
    { label: 'Página única' }, { label: 'Rolagem contínua' }, { label: 'Tela cheia' },
  ],
  Documento: [
    { label: 'Inserir páginas' }, { label: 'Inserir página antes' }, { label: 'Inserir página depois' }, { label: 'Substituir página' }, { label: 'Excluir páginas' }, { label: 'Extrair páginas' }, { label: 'Duplicar páginas' },
    { label: 'Girar páginas' }, { label: 'Recortar página' }, { label: 'Reordenar páginas', divider: true }, { label: 'Mesclar documentos' }, { label: 'Dividir documento' }, { label: 'Comparar documento' }, { label: 'Verificar saída' }, { label: 'Preflight de produção' }, { label: 'Auditoria de acessibilidade' },
  ],
  Ferramentas: toolDefinitions.map((tool, index) => ({ label: tool.label, shortcut: tool.shortcut, divider: index === 0 })),
};

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatPdfDate(value: unknown) {
  if (!value) return 'Não informado';
  const date = value instanceof Date ? value : new Date(String(value).replace(/^D:/, '').replace(/'(\d{2})'$/, '$1'));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('pt-BR');
}

function makeSearchExpression(term: string, caseSensitive: boolean, wholeWord: boolean, global = false) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(wholeWord ? `\\b${escaped}\\b` : escaped, `${caseSensitive ? '' : 'i'}${global ? 'g' : ''}`);
}

function inferFontFamily(fontName: string | undefined, styleFamily: string | undefined) {
  const family = `${styleFamily || ''} ${fontName || ''}`.toLowerCase();
  if (family.includes('times') || family.includes('serif')) return 'Times';
  if (family.includes('courier') || family.includes('mono')) return 'Courier';
  return 'Helvetica';
}

function containsPdfEncryption(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const marker = [47, 69, 110, 99, 114, 121, 112, 116];
  for (let index = 0; index <= bytes.length - marker.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < marker.length; offset += 1) if (bytes[index + offset] !== marker[offset]) { matches = false; break; }
    if (matches) return true;
  }
  return false;
}

type PdfSecuritySettings = { userPassword: string; ownerPassword: string; printing: boolean; copying: boolean; modifying: boolean; annotating: boolean; fillingForms: boolean; contentAccessibility: boolean; documentAssembly: boolean };

async function protectPdfBytes(bytes: ArrayBuffer, settings: PdfSecuritySettings) {
  if (!settings.userPassword && !settings.ownerPassword) return bytes;
  const { PDFDocument } = await getSecurePdfLib();
  const document = await PDFDocument.load(bytes);
  document.encrypt({
    userPassword: settings.userPassword || undefined,
    ownerPassword: settings.ownerPassword || settings.userPassword || undefined,
    permissions: { printing: settings.printing ? 'highResolution' : false, copying: settings.copying, modifying: settings.modifying, annotating: settings.annotating, fillingForms: settings.fillingForms, contentAccessibility: settings.contentAccessibility, documentAssembly: settings.documentAssembly },
  });
  const secured = await document.save();
  return secured.buffer.slice(secured.byteOffset, secured.byteOffset + secured.byteLength) as ArrayBuffer;
}

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [documentInfo, setDocumentInfo] = useState({ title: '', author: '', subject: '' });
  const [documentDates, setDocumentDates] = useState({ created: 'Não informado', modified: 'Não informado' });
  const [attachments, setAttachments] = useState<File[]>([]);
  const [comparisonSummary, setComparisonSummary] = useState<string | null>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [pdf, setPdf] = useState<PdfJs.PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<EditorPage[]>([]);
  const [past, setPast] = useState<EditorPage[][]>([]);
  const [future, setFuture] = useState<EditorPage[][]>([]);
  const [currentPage, setCurrentPage] = useState(0);
  const [selectedPageIndexes, setSelectedPageIndexes] = useState<number[]>([0]);
  const [zoom, setZoom] = useState(initialZoom);
  const [viewMode, setViewMode] = useState<'single' | 'continuous'>('single');
  const [tool, setTool] = useState<Tool>('select');
  const [shapeKind, setShapeKind] = useState<ShapeKind>('rect');
  const [formKind, setFormKind] = useState<FormKind>('text');
  const [stampKind, setStampKind] = useState('APROVADO');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [menu, setMenu] = useState<MenuKey>(null);
  const [toolbarMoreOpen, setToolbarMoreOpen] = useState(false);
  const [dark, setDark] = useState(true);
  const [rightPanelMode, setRightPanelMode] = useState<'properties' | 'layers'>('properties');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [pageSize, setPageSize] = useState({ width: 612, height: 792 });
  const [textRuns, setTextRuns] = useState<PdfTextRun[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState({ x: 0, y: 0 });
  const [drawEnd, setDrawEnd] = useState({ x: 0, y: 0 });
  const [pageMenu, setPageMenu] = useState<number | null>(null);
  const [draggingPageIndex, setDraggingPageIndex] = useState<number | null>(null);
  const [recentFiles, setRecentFiles] = useState<File[]>([]);
  const [clipboardElement, setClipboardElement] = useState<EditorElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<number[]>([]);
  const [searchIndex, setSearchIndex] = useState(0);
  const [replaceTerm, setReplaceTerm] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const [leftPanelMode, setLeftPanelMode] = useState<'pages' | 'bookmarks'>('pages');
  const [bookmarks, setBookmarks] = useState<PdfBookmark[]>([]);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [signatureOpen, setSignatureOpen] = useState(false);
  const [signatureDrawing, setSignatureDrawing] = useState(false);
  const [pageImportMode, setPageImportMode] = useState<'insert' | 'replace'>('insert');
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountEmail, setAccountEmail] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [cloudDocumentId, setCloudDocumentId] = useState<string | null>(null);
  const [signatureRevisionBytes, setSignatureRevisionBytes] = useState<Uint8Array | null>(null);
  const [collaborators, setCollaborators] = useState<CollaboratorPresence[]>([]);
  const [collaborationStatus, setCollaborationStatus] = useState<'idle' | 'connecting' | 'connected' | 'closed' | 'error'>('idle');
  const [collaborationConflict, setCollaborationConflict] = useState<CollaborationConflict | null>(null);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [security, setSecurity] = useState({ userPassword: '', ownerPassword: '', printing: true, copying: false, modifying: false, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: false });
  const [passwordPrompt, setPasswordPrompt] = useState<{ message: string; callback: (password: string) => void } | null>(null);
  const [passwordValue, setPasswordValue] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const mergeInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const batchInputRef = useRef<HTMLInputElement>(null);
  const compareInputRef = useRef<HTMLInputElement>(null);
  const officeInputRef = useRef<HTMLInputElement>(null);
  const cadInputRef = useRef<HTMLInputElement>(null);
  const pageImportInputRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<PdfJs.PDFDocumentProxy | null>(null);
  const renderCanvasRef = useRef<HTMLCanvasElement>(null);
  const mainRenderTask = useRef<{ cancel: () => void; promise: Promise<void> } | null>(null);
  const thumbRenderTasks = useRef(new WeakMap<HTMLCanvasElement, { cancel: () => void; promise: Promise<void> }>());
  const mainRenderRequest = useRef(0);
  const thumbRenderRequests = useRef(new WeakMap<HTMLCanvasElement, number>());
  const workspaceRef = useRef<HTMLElement>(null);
  const renderVersion = useRef(0);
  const textLayerRequest = useRef(0);
  const textLayerCache = useRef(new LruCache<string, PdfTextRun[]>(8));
  const signatureCanvasRef = useRef<HTMLCanvasElement>(null);
  const sourcePasswordRef = useRef('');
  const collaborationRef = useRef<DocumentCollaboration | null>(null);
  const pagesRef = useRef<EditorPage[]>([]);
  const collaborationBasePagesRef = useRef<EditorPage[] | null>(null);
  const recoveryTimer = useRef<number | null>(null);
  const [recoverySnapshot, setRecoverySnapshot] = useState<RecoverySnapshot | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    void supabase.auth.getSession().then(({ data }) => { if (active) { setSessionEmail(data.session?.user.email || null); setSessionUserId(data.session?.user.id || null); } });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => { setSessionEmail(session?.user.email || null); setSessionUserId(session?.user.id || null); });
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, []);

  const activePage = pages[currentPage];
  const selectedElement = activePage?.elements.find((element) => element.id === selectedId) ?? null;

  useEffect(() => { pagesRef.current = pages; }, [pages]);

  const selectElement = useCallback((id: string, additive = false) => {
    setSelectedIds((current) => additive ? (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]) : [id]);
    setSelectedId(id);
    setTool('select');
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setSelectedIds([]);
  }, []);

  useEffect(() => {
    let mounted = true;
    void loadRecoverySnapshot().then((snapshot) => { if (mounted && snapshot?.bytes?.byteLength && snapshot.pages?.length) setRecoverySnapshot(snapshot); }).catch(() => undefined);
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!bytes || !file || !pages.length) return;
    if (recoveryTimer.current) window.clearTimeout(recoveryTimer.current);
    recoveryTimer.current = window.setTimeout(() => {
      void saveRecoverySnapshot({ fileName: file.name, bytes, pages: clonePages(pages), documentInfo, updatedAt: Date.now() }).catch(() => undefined);
    }, 1200);
    return () => { if (recoveryTimer.current) window.clearTimeout(recoveryTimer.current); };
  }, [bytes, file, pages, documentInfo]);

  useEffect(() => () => {
    mainRenderTask.current?.cancel();
    void pdfRef.current?.destroy();
    pdfRef.current = null;
    disposePdfWorker();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const search = async () => {
      if (!pdfRef.current || !searchTerm.trim()) { setSearchResults([]); setSearchIndex(0); return; }
      const found: number[] = [];
      const expression = makeSearchExpression(searchTerm.trim(), searchCaseSensitive, searchWholeWord);
      for (let pageIndex = 0; pageIndex < pdfRef.current.numPages; pageIndex += 1) {
        if (cancelled) return;
        const page = await pdfRef.current.getPage(pageIndex + 1);
        const content = await page.getTextContent();
        const extracted = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
        const edited = (pages[pageIndex]?.elements || []).map((element) => element.text || element.formValue || element.comment || '').join(' ');
        const text = `${extracted} ${edited}`;
        page.cleanup();
        if (expression.test(text)) found.push(pageIndex);
      }
      if (!cancelled) { setSearchResults(found); setSearchIndex(0); if (found.length) setCurrentPage(found[0]); }
    };
    const timer = window.setTimeout(() => void search(), searchTerm.trim() ? 180 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [searchTerm, searchCaseSensitive, searchWholeWord, pdf, pages]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2800);
  }, []);

  const requestPassword = useCallback((message: string) => new Promise<string>((resolve, reject) => {
    setPasswordPrompt({ message, callback: (password) => password ? resolve(password) : reject(new Error('Abertura cancelada.')) });
  }), []);

  const replacePages = useCallback((next: EditorPage[], withHistory = true, broadcast = true) => {
    setSignatureRevisionBytes(null);
    setPages((current) => {
      if (withHistory) setPast((history) => [...history.slice(-30), clonePages(current)]);
      return next;
    });
    setFuture([]);
    if (broadcast && collaborationRef.current) {
      const basePages = collaborationBasePagesRef.current || pagesRef.current;
      void collaborationRef.current.publishOperation({ type: 'replacePages', baseRevision: 0, basePages: clonePages(basePages), pages: clonePages(next) }).catch(() => setCollaborationStatus('error'));
    }
  }, []);

  const resolveCollaborationConflict = useCallback((strategy: 'local' | 'remote' | 'merge') => {
    if (!collaborationConflict) return;
    const base = collaborationConflict.incoming.basePages || collaborationBasePagesRef.current || [];
    const local = pagesRef.current;
    const remote = collaborationConflict.incoming.pages;
    if (strategy === 'local') {
      setCollaborationConflict(null);
      replacePages(clonePages(local), false, true);
      collaborationBasePagesRef.current = clonePages(local);
      showToast('Sua versão foi publicada como resolução do conflito.');
      return;
    }
    if (strategy === 'remote') {
      setCollaborationConflict(null);
      replacePages(clonePages(remote), false, true);
      collaborationBasePagesRef.current = clonePages(remote);
      showToast('A versão remota foi publicada como resolução do conflito.');
      return;
    }
    const merged = mergeEditorPages(base, local, remote);
    setCollaborationConflict(null);
    replacePages(merged.pages, false, true);
    collaborationBasePagesRef.current = clonePages(merged.pages);
    showToast(merged.conflicts.length ? `Merge concluído com ${merged.conflicts.length} conflito(s) mantido(s) localmente.` : 'Merge concluído sem conflitos de campo.');
  }, [collaborationConflict, replacePages, showToast]);

  useEffect(() => {
    let disposed = false;
    const previous = collaborationRef.current;
    collaborationRef.current = null;
    setCollaborators([]);
    if (previous) void previous.dispose();
    setCollaborationConflict(null);
    collaborationBasePagesRef.current = clonePages(pagesRef.current);
    if (!supabase || !cloudDocumentId || !sessionUserId) { setCollaborationStatus('idle'); collaborationBasePagesRef.current = null; return () => { disposed = true; }; }
    const collaboration = createDocumentCollaboration(supabase, cloudDocumentId, sessionUserId, sessionEmail || undefined, {
      onOperation: (operation) => { if (!disposed && operation.type === 'replacePages') { collaborationBasePagesRef.current = clonePages(operation.pages); replacePages(operation.pages, false, false); } },
      onConflict: (conflict) => { if (!disposed) { setCollaborationConflict(conflict); showToast('Conflito detectado: escolha qual versão manter.'); } },
      onPresence: (next) => { if (!disposed) setCollaborators(next); },
      onStatus: (next) => { if (!disposed) setCollaborationStatus(next); },
    });
    collaborationRef.current = collaboration;
    void collaboration.subscribe().catch(() => { if (!disposed) setCollaborationStatus('error'); });
    return () => { disposed = true; if (collaborationRef.current === collaboration) collaborationRef.current = null; collaborationBasePagesRef.current = null; void collaboration.dispose(); };
  }, [cloudDocumentId, sessionEmail, sessionUserId, replacePages, showToast]);

  useEffect(() => {
    if (collaborationRef.current) void collaborationRef.current.publishPresence({ page: currentPage, selection: selectedId });
  }, [currentPage, selectedId]);

  const renderThumb = useCallback(async (pageNumber: number, canvas: HTMLCanvasElement, sourcePage?: number | null, rotation = 0) => {
    const source = sourcePage === undefined ? pageNumber : sourcePage;
    if (!pdfRef.current || source === null) return;
    const pdfjsLib = await getPdfJs();
    const request = (thumbRenderRequests.current.get(canvas) || 0) + 1;
    thumbRenderRequests.current.set(canvas, request);
    thumbRenderTasks.current.get(canvas)?.cancel();
    thumbRenderTasks.current.delete(canvas);
    const page = await pdfRef.current.getPage(source + 1);
    if (thumbRenderRequests.current.get(canvas) !== request) return;
    const viewport = page.getViewport({ scale: 0.19, rotation: page.rotate + rotation });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const task = page.render({ canvasContext: canvas.getContext('2d')!, viewport });
    if (thumbRenderRequests.current.get(canvas) !== request) { task.cancel(); return; }
    thumbRenderTasks.current.set(canvas, task);
    try {
      await task.promise;
    } catch (error) {
      if ((error as Error).name !== 'RenderingCancelledException') throw error;
    } finally {
      if (thumbRenderTasks.current.get(canvas) === task) thumbRenderTasks.current.delete(canvas);
      page.cleanup();
    }
  }, []);

  const renderMainPage = useCallback(async (pageState: EditorPage | undefined, scale: number) => {
    const canvas = renderCanvasRef.current;
    if (!canvas || !pageState) return;
    const pdfjsLib = await getPdfJs();
    const request = ++mainRenderRequest.current;
    mainRenderTask.current?.cancel();
    mainRenderTask.current = null;
    const version = ++renderVersion.current;
    if (!pdfRef.current || pageState.sourcePage === null) {
      const width = 612 * scale;
      const height = 792 * scale;
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.getContext('2d')!.fillStyle = '#ffffff';
      canvas.getContext('2d')!.fillRect(0, 0, width, height);
      setPageSize({ width, height });
      return;
    }
    const page = await pdfRef.current.getPage(pageState.sourcePage + 1);
    if (mainRenderRequest.current !== request) return;
    const viewport = page.getViewport({ scale, rotation: page.rotate + pageState.rotation });
    if (version !== renderVersion.current) return;
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const task = page.render({ canvasContext: canvas.getContext('2d')!, viewport });
    mainRenderTask.current = task;
    try {
      await task.promise;
    } catch (error) {
      if ((error as Error).name !== 'RenderingCancelledException') throw error;
    } finally {
      if (mainRenderTask.current === task) mainRenderTask.current = null;
    }
    setPageSize({ width: viewport.width, height: viewport.height });
  }, []);

  const loadTextLayer = useCallback(async (pageState: EditorPage | undefined, scale: number) => {
    const request = ++textLayerRequest.current;
    if (!pdfRef.current || !pageState || pageState.sourcePage === null) { setTextRuns([]); return; }
    const pdfjsLib = await getPdfJs();
    const page = await pdfRef.current.getPage(pageState.sourcePage + 1);
    const rotation = (page.rotate + pageState.rotation) % 360;
    if (rotation !== 0 && rotation !== 180) { setTextRuns([]); page.cleanup(); return; }
    const viewport = page.getViewport({ scale, rotation });
    const cacheKey = `${pageState.sourcePage}:${pageState.rotation}:${scale.toFixed(3)}`;
    const cached = textLayerCache.current.get(cacheKey);
    if (cached) { setTextRuns(cached); page.cleanup(); return; }
    const content = await page.getTextContent();
    if (textLayerRequest.current !== request) { page.cleanup(); return; }
    const runs: PdfTextRun[] = [];
    const styles = (content as unknown as { styles?: Record<string, { fontFamily?: string }> }).styles || {};
    content.items.forEach((rawItem, index) => {
      const item = rawItem as { str?: string; width?: number; transform?: number[]; fontName?: string };
      if (!item.str?.trim() || !item.transform || !item.width) return;
      const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontSize = Math.max(6, Math.abs(transform[3] || transform[0] || 10));
      const height = Math.max(fontSize * 1.15, 8);
      const styleFamily = item.fontName ? styles[item.fontName]?.fontFamily : undefined;
      const fontFamily = inferFontFamily(item.fontName, styleFamily);
      const fontToken = `${item.fontName || ''} ${styleFamily || ''}`.toLowerCase();
      runs.push({ id: `text-run-${pageState.id}-${index}`, text: item.str, x: transform[4], y: transform[5] - height, width: Math.max(item.width * scale, 4), height, fontSize, fontFamily, bold: /bold|black|heavy/.test(fontToken), italic: /italic|oblique/.test(fontToken) });
    });
    textLayerCache.current.set(cacheKey, runs);
    setTextRuns(runs);
    page.cleanup();
  }, []);

  const runOcr = async () => {
    if (!pdfRef.current || !activePage || activePage.sourcePage === null) {
      showToast('Selecione uma página PDF para executar OCR.');
      return;
    }
    setOcrRunning(true);
    setOcrProgress(0);
    try {
      const pdfjsLib = await getPdfJs();
      const page = await pdfRef.current.getPage(activePage.sourcePage + 1);
      const viewport = page.getViewport({ scale: 1.5, rotation: page.rotate + activePage.rotation });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas indisponível');
      await page.render({ canvasContext: context, viewport }).promise;
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker('por+eng', 1, { logger: (message) => { if (message.status === 'recognizing text') setOcrProgress(Math.round((message.progress || 0) * 100)); } });
      let result;
      try {
        result = await worker.recognize(canvas);
      } finally {
        await worker.terminate();
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
      }
      const words = ((result.data as unknown as { words?: Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }> }).words || []).filter((word) => word.text.trim() && word.confidence >= 35).slice(0, 500);
      if (words.length) {
        const recognized = words.map((word) => ({ id: uid(), type: 'text' as const, x: word.bbox.x0 / viewport.width, y: word.bbox.y0 / viewport.height, width: Math.max(0.012, (word.bbox.x1 - word.bbox.x0) / viewport.width), height: Math.max(0.012, (word.bbox.y1 - word.bbox.y0) / viewport.height), text: word.text, color: '#1d252d', fontSize: Math.max(7, (word.bbox.y1 - word.bbox.y0) / 1.5), fontFamily: 'Helvetica', opacity: 1 }));
        updateActivePage((pageState) => ({ ...pageState, elements: [...pageState.elements, ...recognized] }));
        setSelectedId(recognized[0].id);
        setSelectedIds([recognized[0].id]);
        setTool('select');
        showToast(`${recognized.length} blocos de texto reconhecidos.`);
      } else if ((result.data as unknown as { text?: string }).text?.trim()) {
        const recognized = { id: uid(), type: 'text' as const, x: 0.05, y: 0.05, width: 0.9, height: 0.8, text: (result.data as unknown as { text: string }).text.trim(), color: '#1d252d', fontSize: 12, fontFamily: 'Helvetica', opacity: 1 };
        updateActivePage((pageState) => ({ ...pageState, elements: [...pageState.elements, recognized] }));
        setSelectedId(recognized.id);
        setSelectedIds([recognized.id]);
        setTool('select');
        showToast('Texto reconhecido e adicionado à página.');
      } else {
        showToast('Nenhum texto foi reconhecido nesta página.');
      }
    } catch {
      showToast('Não foi possível executar OCR local nesta página.');
    } finally {
      setOcrRunning(false);
      setOcrProgress(0);
    }
  };

  useEffect(() => { void renderMainPage(activePage, zoom); void loadTextLayer(activePage, zoom); }, [activePage, zoom, renderMainPage, loadTextLayer]);

  const openPdf = useCallback(async (incoming: File) => {
    if (incoming.type !== 'application/pdf' && !incoming.name.toLowerCase().endsWith('.pdf')) {
      showToast('Selecione um arquivo PDF.');
      return;
    }
    if (incoming.size > MAX_PDF_FILE_BYTES) {
      showToast('Este PDF excede o limite local de 200 MB.');
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const buffer = await incoming.arrayBuffer();
      let renderBuffer = buffer;
      if (containsPdfEncryption(buffer)) {
        const password = await requestPassword('Este PDF está protegido. Informe a senha para continuar.');
        const { PDFDocument } = await getSecurePdfLib();
        const decrypted = await PDFDocument.load(buffer, { password });
        const decryptedBytes = await decrypted.save();
        renderBuffer = decryptedBytes.buffer.slice(decryptedBytes.byteOffset, decryptedBytes.byteOffset + decryptedBytes.byteLength) as ArrayBuffer;
        sourcePasswordRef.current = password;
      }
      const pdfjsLib = await getPdfJs();
      const loadingTask = pdfjsLib.getDocument({ data: renderBuffer.slice(0), ...pdfJsTextOptions });
      loadingTask.onPassword = (callback: (password: string) => void, reason: number) => { setPasswordValue(''); setPasswordPrompt({ message: reason === 1 ? 'Este PDF exige uma senha para abrir.' : 'Senha incorreta. Tente novamente.', callback }); };
      const loaded = await loadingTask.promise;
      if (loaded.numPages > MAX_PDF_PAGES) {
        await loaded.destroy();
        throw new Error(`O PDF excede o limite local de ${MAX_PDF_PAGES} páginas.`);
      }
      const nextPages: EditorPage[] = [];
      for (let index = 0; index < loaded.numPages; index += 1) {
        const sourcePage = await loaded.getPage(index + 1);
        const view = sourcePage.view;
        const annotations = await sourcePage.getAnnotations({ intent: 'display' }) as unknown as PdfAnnotation[];
        const elements = annotations.map((annotation) => annotationToElement(annotation, view[2] - view[0], view[3] - view[1])).filter((element): element is EditorElement => Boolean(element));
        nextPages.push({ id: uid(), sourcePage: index, rotation: 0, elements });
        sourcePage.cleanup();
      }
      const outline = await loaded.getOutline();
      const metadata = await loaded.getMetadata().catch(() => null);
      const info = (metadata?.info || {}) as Record<string, unknown>;
      const previousPdf = pdfRef.current;
      pdfRef.current = loaded;
      if (previousPdf) void previousPdf.destroy();
      textLayerCache.current.clear();
      setPdf(loaded);
      setFile(incoming);
      setRecentFiles((current) => [incoming, ...current.filter((item) => item.name !== incoming.name)].slice(0, 5));
      setAttachments([]);
      setComparisonSummary(null);
      setDocumentInfo({ title: String(info.Title || incoming.name.replace(/\.pdf$/i, '')), author: String(info.Author || ''), subject: String(info.Subject || '') });
      setDocumentDates({ created: formatPdfDate(info.CreationDate), modified: formatPdfDate(info.ModDate) });
      setBytes(renderBuffer);
      setSignatureRevisionBytes(null);
      setSecurity((current) => ({ ...current, userPassword: '', ownerPassword: '' }));
      setPages(nextPages);
      setPast([]);
      setFuture([]);
      setBookmarks((outline || []) as PdfBookmark[]);
      setCurrentPage(0);
      setSelectedPageIndexes([0]);
      setSelectedId(null);
      setZoom(initialZoom);
      setStatus('saved');
      showToast(`${loaded.numPages} ${loaded.numPages === 1 ? 'página carregada' : 'páginas carregadas'}.`);
    } catch (error) {
      const detail = error instanceof Error && error.message ? ` ${error.message}` : '';
      setLoadError(`Não foi possível abrir este PDF. Verifique se o arquivo não está corrompido ou protegido.${detail}`);
      showToast('Falha ao abrir o PDF.');
    } finally {
      setLoading(false);
    }
  }, [requestPassword, showToast]);

  const clearDocument = () => {
    void pdfRef.current?.destroy();
    pdfRef.current = null;
    setPdf(null);
    setFile(null);
    setAttachments([]);
    setComparisonSummary(null);
    setDocumentInfo({ title: '', author: '', subject: '' });
    setDocumentDates({ created: 'Não informado', modified: 'Não informado' });
    setBytes(null);
    setSignatureRevisionBytes(null);
    setPages([]);
    setPast([]);
    setFuture([]);
    setBookmarks([]);
    setCurrentPage(0);
    setSelectedPageIndexes([]);
    clearSelection();
    setStatus('idle');
  };

  const restoreLocalRecovery = async () => {
    if (!recoverySnapshot) return;
    try {
      await openPdf(new File([recoverySnapshot.bytes], recoverySnapshot.fileName, { type: 'application/pdf' }));
      setBytes(recoverySnapshot.bytes);
      setPages(clonePages(recoverySnapshot.pages));
      setDocumentInfo(recoverySnapshot.documentInfo);
      setCurrentPage(0);
      setSelectedPageIndexes([0]);
      clearSelection();
      setRecoverySnapshot(null);
      await clearRecoverySnapshot();
      showToast('Sessão local recuperada.');
    } catch {
      showToast('Não foi possível recuperar a sessão local.');
    }
  };

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    if (selected) void openPdf(selected);
    event.target.value = '';
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setIsDraggingFile(false);
    const dropped = Array.from(event.dataTransfer.files);
    const pdfFile = dropped.find((candidate) => candidate.type === 'application/pdf' || candidate.name.endsWith('.pdf'));
    if (pdfFile) void openPdf(pdfFile);
    else if (dropped.length) showToast('Arraste um PDF para abrir o documento.');
  };

  const onConversionInput = async (event: ChangeEvent<HTMLInputElement>, kind: 'office' | 'cad') => {
    const candidate = event.target.files?.[0];
    event.target.value = '';
    if (!candidate) return;
    setLoading(true);
    try {
      const converted = await convertDocumentToPdf(candidate, kind);
      await openPdf(new File([converted], `${candidate.name.replace(/\.[^.]+$/, '')}.pdf`, { type: 'application/pdf' }));
      showToast(`${candidate.name} convertido para PDF pelo conector configurado.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Não foi possível converter o arquivo.');
    } finally {
      setLoading(false);
    }
  };

  const updateActivePage = (updater: (page: EditorPage) => EditorPage, history = true) => {
    if (!activePage) return;
    replacePages(pages.map((page, index) => index === currentPage ? updater(page) : page), history);
  };

  const addElement = (element: Omit<EditorElement, 'id'>) => {
    const created = { ...element, id: uid() };
    updateActivePage((page) => ({ ...page, elements: [...page.elements, created] }));
    setSelectedId(created.id);
    setSelectedIds([created.id]);
    return created.id;
  };

  const selectTool = (nextTool: Tool) => {
    setToolbarMoreOpen(false);
    if (nextTool === 'signature') {
      setSignatureOpen(true);
      window.requestAnimationFrame(clearSignatureCanvas);
      return;
    }
    setTool(nextTool);
    clearSelection();
    if (nextTool === 'image') imageInputRef.current?.click();
  };

  const onImageInput = (event: ChangeEvent<HTMLInputElement>) => {
    const image = event.target.files?.[0];
    if (!image || !activePage) return;
    if (image.size > MAX_IMAGE_BYTES) { showToast('A imagem excede o limite local de 20 MB.'); event.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => addElement({ type: 'image', x: 0.25, y: 0.25, width: 0.5, height: 0.28, dataUrl: String(reader.result), opacity: 1 });
    reader.readAsDataURL(image);
    event.target.value = '';
    setTool('select');
  };

  const onMergeInput = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []).filter((candidate) => candidate.type === 'application/pdf' || candidate.name.endsWith('.pdf'));
    event.target.value = '';
    if (files.length < 2) { showToast('Selecione ao menos dois PDFs para mesclar.'); return; }
    try {
      setLoading(true);
      const { PDFDocument } = await getPdfLib();
      const merged = await PDFDocument.create();
      for (const candidate of files) {
        const source = await PDFDocument.load(await candidate.arrayBuffer());
        const copied = await merged.copyPages(source, source.getPageIndices());
        copied.forEach((page) => merged.addPage(page));
      }
      const mergedBytes = await merged.save();
      const mergedBuffer = mergedBytes.buffer.slice(mergedBytes.byteOffset, mergedBytes.byteOffset + mergedBytes.byteLength) as ArrayBuffer;
      await openPdf(new File([mergedBuffer], 'documento-mesclado.pdf', { type: 'application/pdf' }));
    } catch {
      showToast('Não foi possível mesclar os PDFs selecionados.');
    } finally {
      setLoading(false);
    }
  };

  const choosePageImport = (mode: 'insert' | 'replace') => {
    setPageImportMode(mode);
    pageImportInputRef.current?.click();
  };

  const onPageImportInput = async (event: ChangeEvent<HTMLInputElement>) => {
    const candidate = event.target.files?.[0];
    event.target.value = '';
    if (!candidate || !bytes || !pages.length) return;
    try {
      setLoading(true);
      const { PDFDocument } = await getPdfLib();
      const currentBytes = await buildPdfBytes();
      const currentDocument = await PDFDocument.load(currentBytes);
      const importedDocument = await PDFDocument.load(await candidate.arrayBuffer());
      const output = await PDFDocument.create();
      const currentIndexes = currentDocument.getPageIndices();
      const importedIndexes = importedDocument.getPageIndices();
      const before = pageImportMode === 'replace' ? currentIndexes.slice(0, currentPage) : currentIndexes.slice(0, currentPage + 1);
      const after = pageImportMode === 'replace' ? currentIndexes.slice(currentPage + 1) : currentIndexes.slice(currentPage + 1);
      if (before.length) output.addPage((await output.copyPages(currentDocument, before))[0]);
      if (before.length > 1) {
        const beforePages = await output.copyPages(currentDocument, before.slice(1));
        beforePages.forEach((page) => output.addPage(page));
      }
      const importedPages = await output.copyPages(importedDocument, importedIndexes);
      importedPages.forEach((page) => output.addPage(page));
      const afterPages = await output.copyPages(currentDocument, after);
      afterPages.forEach((page) => output.addPage(page));
      const mergedBytes = await output.save();
      const mergedBuffer = mergedBytes.buffer.slice(mergedBytes.byteOffset, mergedBytes.byteOffset + mergedBytes.byteLength) as ArrayBuffer;
      const prefix = file?.name.replace(/\.pdf$/i, '') || 'documento';
      await openPdf(new File([mergedBuffer], `${prefix}-${pageImportMode === 'replace' ? 'pagina-substituida' : 'paginas-inseridas'}.pdf`, { type: 'application/pdf' }));
      setCurrentPage(pageImportMode === 'replace' ? currentPage : currentPage + 1);
      showToast(pageImportMode === 'replace' ? 'Página substituída pelo PDF selecionado.' : 'Páginas inseridas no documento.');
    } catch {
      showToast('Não foi possível importar as páginas selecionadas.');
    } finally {
      setLoading(false);
    }
  };

  const onAttachmentInput = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files || []);
    if (selected.length) {
      setAttachments((current) => [...current, ...selected]);
      showToast(`${selected.length} anexo${selected.length === 1 ? '' : 's'} adicionado${selected.length === 1 ? '' : 's'}.`);
    }
    event.target.value = '';
  };

  const authenticate = async (mode: 'signin' | 'signup') => {
    if (!supabase) { setAccountMessage(cloudConfigurationMessage()); return; }
    if (!accountEmail || !accountPassword) { setAccountMessage('Informe e-mail e senha.'); return; }
    setAccountBusy(true);
    setAccountMessage(null);
    const result = mode === 'signup'
      ? await supabase.auth.signUp({ email: accountEmail, password: accountPassword })
      : await supabase.auth.signInWithPassword({ email: accountEmail, password: accountPassword });
    setAccountBusy(false);
    if (result.error) setAccountMessage(result.error.message);
    else setAccountMessage(mode === 'signup' ? 'Conta criada. Verifique o e-mail se a confirmação estiver ativa.' : 'Sessão iniciada.');
  };

  const signOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    setCloudDocumentId(null);
    setSessionUserId(null);
    setCollaborators([]);
    setAccountMessage('Sessão encerrada.');
  };

  const requestTrustedSignature = async () => {
    if (!selectedElement || selectedElement.type !== 'signatureField' || !selectedElement.formName) {
      showToast('Selecione um campo de assinatura digital.');
      return;
    }
    if (!cloudDocumentId) {
      showToast('Sincronize explicitamente o documento antes de solicitar uma assinatura confiável.');
      return;
    }
    if (!integrationCapabilities.remoteSigning) {
      showToast('Configure um provedor de assinatura confiável para habilitar este fluxo.');
      return;
    }
    try {
      const currentBytes = signatureRevisionBytes ? signatureRevisionBytes.buffer.slice(signatureRevisionBytes.byteOffset, signatureRevisionBytes.byteOffset + signatureRevisionBytes.byteLength) as ArrayBuffer : await buildPdfBytes(true);
      const digestBuffer = await crypto.subtle.digest('SHA-256', currentBytes);
      const digest = btoa(String.fromCharCode(...new Uint8Array(digestBuffer)));
      const response = await requestRemoteSignature({ documentId: cloudDocumentId, fieldName: selectedElement.formName, digest });
      showToast(response.status === 'pending' ? 'Solicitação enviada para assinatura remota.' : 'Assinatura remota concluída.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Não foi possível solicitar a assinatura remota.');
    }
  };

  const syncCurrentDocument = async () => {
    if (!supabase) { setAccountMessage(cloudConfigurationMessage()); setAccountOpen(true); return; }
    if (!sessionEmail) { setAccountMessage('Entre na sua conta antes de sincronizar.'); setAccountOpen(true); return; }
    if (!file || !pages.length) return;
    setAccountBusy(true);
    setAccountMessage('Preparando a versão local para envio explícito...');
    try {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user) throw new Error('Sessão expirada. Entre novamente.');
      const currentBytes = signatureRevisionBytes ? signatureRevisionBytes.buffer.slice(signatureRevisionBytes.byteOffset, signatureRevisionBytes.byteOffset + signatureRevisionBytes.byteLength) as ArrayBuffer : await buildPdfBytes();
      const documentId = cloudDocumentId || crypto.randomUUID();
      const storagePath = `${userData.user.id}/${documentId}/${Date.now()}.pdf`;
      const upload = await supabase.storage.from('documents').upload(storagePath, new Blob([currentBytes], { type: 'application/pdf' }), { upsert: false, contentType: 'application/pdf' });
      if (upload.error) throw upload.error;
      if (!cloudDocumentId) {
        const created = await supabase.from('documents').insert({ id: documentId, owner_id: userData.user.id, name: file.name, mime_type: 'application/pdf', size_bytes: currentBytes.byteLength, page_count: pages.length }).select('id').single();
        if (created.error) throw created.error;
        setCloudDocumentId(created.data.id);
      } else {
        const updated = await supabase.from('documents').update({ name: file.name, size_bytes: currentBytes.byteLength, page_count: pages.length, updated_at: new Date().toISOString() }).eq('id', documentId);
        if (updated.error) throw updated.error;
      }
      const version = await supabase.from('document_versions').insert({ document_id: documentId, owner_id: userData.user.id, storage_path: storagePath, version_number: Date.now() }).select('id').single();
      if (version.error) throw version.error;
      const linked = await supabase.from('documents').update({ current_version_id: version.data.id }).eq('id', documentId);
      if (linked.error) throw linked.error;
      setAccountMessage('Versão enviada conscientemente para o Supabase.');
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : 'Não foi possível sincronizar o documento.');
    } finally {
      setAccountBusy(false);
    }
  };

  const compareDocument = async (candidate: File) => {
    if (!pdfRef.current) return;
    try {
      setLoading(true);
      const pdfjsLib = await getPdfJs();
      const other = await pdfjsLib.getDocument({ data: (await candidate.arrayBuffer()).slice(0), ...pdfJsTextOptions }).promise;
      const total = Math.max(pdfRef.current.numPages, other.numPages);
      let changed = 0;
      for (let index = 0; index < total; index += 1) {
        const readText = async (document: PdfJs.PDFDocumentProxy, pageIndex: number) => {
          if (pageIndex >= document.numPages) return '';
          const page = await document.getPage(pageIndex + 1);
          const content = await page.getTextContent();
          return content.items.map((item) => ('str' in item ? item.str : '')).join(' ').replace(/\s+/g, ' ').trim();
        };
        if ((await readText(pdfRef.current, index)) !== (await readText(other, index))) changed += 1;
      }
      await other.destroy();
      const summary = `${changed} de ${total} página${total === 1 ? '' : 's'} com conteúdo diferente em relação a ${candidate.name}.`;
      setComparisonSummary(summary);
      showToast('Comparação concluída.');
    } catch {
      showToast('Não foi possível comparar os documentos.');
    } finally {
      setLoading(false);
    }
  };

  const onCompareInput = (event: ChangeEvent<HTMLInputElement>) => {
    const candidate = event.target.files?.[0];
    if (candidate) void compareDocument(candidate);
    event.target.value = '';
  };

  const copySelected = () => {
    if (!selectedElement) { showToast('Selecione um elemento para copiar.'); return; }
    setClipboardElement({ ...selectedElement, id: uid() });
    showToast('Elemento copiado.');
  };

  const cutSelected = () => {
    if (!selectedElement) { showToast('Selecione um elemento para recortar.'); return; }
    setClipboardElement({ ...selectedElement, id: uid() });
    deleteSelected();
    showToast('Elemento recortado.');
  };

  const pasteSelected = () => {
    if (!clipboardElement) { showToast('A área de transferência está vazia.'); return; }
    addElement({ ...clipboardElement, x: Math.min(1 - clipboardElement.width, clipboardElement.x + 0.03), y: Math.min(1 - clipboardElement.height, clipboardElement.y + 0.03) });
    showToast('Elemento colado.');
  };

  const replaceCurrentText = () => {
    const query = searchTerm.trim();
    if (!query || !activePage) return;
    const expression = makeSearchExpression(query, searchCaseSensitive, searchWholeWord, true);
    const matcher = makeSearchExpression(query, searchCaseSensitive, searchWholeWord);
    const matches = textRuns.filter((run) => matcher.test(run.text));
    const editedMatches = activePage.elements.filter((element) => [element.text, element.formValue, element.comment].some((value) => value && matcher.test(value)));
    if (!matches.length && !editedMatches.length) { showToast('Nenhuma ocorrência nesta página.'); return; }
    const replacements = new Map(matches.map((run) => [run.id, run.text.replace(expression, replaceTerm)]));
    updateActivePage((pageState) => {
      const existingIds = new Set(pageState.elements.filter((element) => element.sourceTextId && replacements.has(element.sourceTextId)).map((element) => element.sourceTextId));
      const updated = pageState.elements.map((element) => {
        if (element.sourceTextId && replacements.has(element.sourceTextId)) return { ...element, text: replacements.get(element.sourceTextId) || '' };
        if (editedMatches.some((match) => match.id === element.id)) return { ...element, text: element.text ? element.text.replace(expression, replaceTerm) : element.text, formValue: element.formValue ? element.formValue.replace(expression, replaceTerm) : element.formValue, comment: element.comment ? element.comment.replace(expression, replaceTerm) : element.comment };
        return element;
      });
      const additions = matches.filter((run) => !existingIds.has(run.id)).map((run) => ({ id: uid(), sourceTextId: run.id, isExistingText: true, type: 'text' as const, x: run.x / pageSize.width, y: run.y / pageSize.height, width: run.width / pageSize.width, height: run.height / pageSize.height, text: replacements.get(run.id) || '', color: '#1d252d', fontSize: run.fontSize / zoom, fontFamily: 'Helvetica', opacity: 1 }));
      return { ...pageState, elements: [...updated, ...additions] };
    });
    const total = matches.length + editedMatches.length;
    showToast(`${total} ocorrência${total === 1 ? '' : 's'} substituída${total === 1 ? '' : 's'}.`);
  };

  const moveToSearchResult = (direction: 1 | -1) => {
    if (!searchResults.length) return;
    const nextIndex = (searchIndex + direction + searchResults.length) % searchResults.length;
    setSearchIndex(nextIndex);
    setCurrentPage(searchResults[nextIndex]);
  };

  const clearSignatureCanvas = () => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#315d86';
    context.lineWidth = 2;
    context.lineCap = 'round';
    context.lineJoin = 'round';
  };

  const placeSignature = () => {
    const canvas = signatureCanvasRef.current;
    if (!canvas || !activePage) return;
    addElement({ type: 'image', x: 0.28, y: 0.68, width: 0.34, height: 0.1, dataUrl: canvas.toDataURL('image/png'), opacity: 1 });
    setSignatureOpen(false);
    setTool('select');
  };

  const signaturePoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const bounds = canvas.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * (canvas.width / bounds.width), y: (event.clientY - bounds.top) * (canvas.height / bounds.height) };
  };

  const sampleTextBackground = (run: PdfTextRun) => {
    return sampleTextRunBackground(renderCanvasRef.current, run, pageSize);
  };

  const relativePoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
  };

  const editPdfText = (run: PdfTextRun) => {
    if (tool !== 'select') return;
    const existing = activePage?.elements.find((element) => element.sourceTextId === run.id);
    if (existing) { selectElement(existing.id); return; }
    const x = run.x / pageSize.width;
    const y = run.y / pageSize.height;
    const width = run.width / pageSize.width;
    const height = run.height / pageSize.height;
    const id = addElement({ isExistingText: true, originalText: run.text, sourceTextId: run.id, type: 'text', x, y, width, height, originalX: x, originalY: y, originalWidth: width, originalHeight: height, text: run.text, color: '#1d252d', backgroundColor: sampleTextBackground(run), fontSize: run.fontSize / zoom, fontFamily: run.fontFamily || 'Helvetica', bold: run.bold, italic: run.italic, opacity: 1 });
    window.requestAnimationFrame(() => {
      const editor = document.querySelector(`[data-element-id="${id}"] [contenteditable="true"]`) as HTMLElement | null;
      editor?.focus();
      if (editor) { const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(editor); selection?.removeAllRanges(); selection?.addRange(range); }
    });
  };

  const handlePagePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!activePage) return;
    const point = relativePoint(event);
    if (tool === 'text') {
      addElement({ type: 'text', x: point.x, y: point.y, width: 0.28, height: 0.06, text: 'Digite aqui', color: '#1d252d', fontSize: 16, fontFamily: 'Helvetica', opacity: 1 });
      setTool('select');
      return;
    }
    if (tool === 'signature') {
      addElement({ type: 'text', x: point.x, y: point.y, width: 0.3, height: 0.08, text: 'Assinatura', color: '#315d86', fontSize: 22, fontFamily: 'Times', italic: true, opacity: 1 });
      setTool('select');
      return;
    }
    if (tool === 'comment') {
      addElement({ type: 'comment', x: point.x, y: point.y, width: 0.24, height: 0.11, text: 'Comentário', comment: 'Comentário', replies: [], color: '#8a6512', fill: '#fff2b8', opacity: 1 });
      setTool('select');
      return;
    }
    if (tool === 'stamp') {
      addElement({ type: 'stamp', x: point.x, y: point.y, width: 0.24, height: 0.07, stampText: stampKind, text: stampKind, color: '#315d86', stroke: '#315d86', opacity: 1 });
      setTool('select');
      return;
    }
    if (tool === 'form') {
      const type = formKind === 'text' ? 'formText' : formKind;
      addElement({ type, x: point.x, y: point.y, width: formKind === 'text' ? 0.3 : 0.05, height: formKind === 'text' ? 0.055 : 0.05, formName: formKind === 'radio' ? `grupo_radio_${currentPage + 1}` : `campo_${uid()}`, formValue: formKind === 'radio' ? `opcao_${uid()}` : '', checked: false, color: '#1d252d', stroke: '#66717b', fill: '#ffffff', opacity: 1 });
      setTool('select');
      return;
    }
    if (tool === 'draw' || tool === 'shape' || tool === 'highlight' || tool === 'underline' || tool === 'strike' || tool === 'redact' || tool === 'crop') {
      setIsDrawing(true);
      setDrawStart(point);
      setDrawEnd(point);
    }
  };

  const handlePagePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isDrawing) setDrawEnd(relativePoint(event));
  };

  const handlePagePointerUp = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    const x = Math.min(drawStart.x, drawEnd.x);
    const y = Math.min(drawStart.y, drawEnd.y);
    const width = Math.max(Math.abs(drawEnd.x - drawStart.x), 0.008);
    const height = Math.max(Math.abs(drawEnd.y - drawStart.y), 0.008);
    const x1 = drawStart.x;
    const y1 = drawStart.y;
    const x2 = drawEnd.x;
    const y2 = drawEnd.y;
    if (tool === 'draw') addElement({ type: 'draw', x, y, width, height, color: '#315d86', stroke: '#315d86', opacity: 1 });
    if (tool === 'shape') addElement({ type: shapeKind, x, y, width, height, fill: 'transparent', stroke: '#315d86', color: '#315d86', opacity: 1 });
    if (tool === 'highlight') addElement({ type: 'highlight', x, y, width, height, fill: '#f4d34f', opacity: 0.38 });
    if (tool === 'underline') addElement({ type: 'underline', x: Math.min(x1, x2), y: Math.max(y1, y2) - 0.006, width: Math.abs(x2 - x1), height: 0.012, stroke: '#315d86', opacity: 1 });
    if (tool === 'strike') addElement({ type: 'strike', x: Math.min(x1, x2), y: Math.min(y1, y2) + Math.abs(y2 - y1) / 2, width: Math.abs(x2 - x1), height: 0.012, stroke: '#c04e4e', opacity: 1 });
    if (tool === 'redact') addElement({ type: 'redaction', x, y, width, height, fill: '#111820', stroke: '#111820', color: '#111820', opacity: 1 });
    if (tool === 'crop') updateActivePage((pageState) => ({ ...pageState, crop: { x, y, width, height } }));
    if (tool === 'signature') addElement({ type: 'text', x, y, width: 0.3, height: 0.08, text: 'Assinatura', color: '#315d86', fontSize: 22, fontFamily: 'Times', italic: true, opacity: 1 });
    setTool('select');
  };

  const updateSelected = (patch: Partial<EditorElement>, history = true) => {
    if (!selectedId) return;
    updateActivePage((page) => ({ ...page, elements: page.elements.map((element) => element.id === selectedId ? { ...element, ...patch } : element) }), history);
  };

  const updateElementById = (id: string, patch: Partial<EditorElement>, history = true) => {
    updateActivePage((page) => ({ ...page, elements: page.elements.map((element) => element.id === id ? { ...element, ...patch } : element) }), history);
  };

  const deleteSelected = () => {
    const ids = selectedIds.length ? selectedIds : selectedId ? [selectedId] : [];
    if (!ids.length) return;
    updateActivePage((page) => ({ ...page, elements: page.elements.flatMap((element) => {
      if (!ids.includes(element.id)) return [element];
      if (element.isExistingText) return [{ ...element, deleted: true, text: '' }];
      return [];
    }) }));
    clearSelection();
  };

  const alignSelected = (alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => {
    if (!activePage || selectedIds.length < 2) return;
    const selected = activePage.elements.filter((element) => selectedIds.includes(element.id));
    const left = Math.min(...selected.map((element) => element.x));
    const right = Math.max(...selected.map((element) => element.x + element.width));
    const top = Math.min(...selected.map((element) => element.y));
    const bottom = Math.max(...selected.map((element) => element.y + element.height));
    updateActivePage((page) => ({ ...page, elements: page.elements.map((element) => {
      if (!selectedIds.includes(element.id)) return element;
      if (alignment === 'left') return { ...element, x: left };
      if (alignment === 'center') return { ...element, x: Math.max(0, (left + right - element.width) / 2) };
      if (alignment === 'right') return { ...element, x: Math.max(0, right - element.width) };
      if (alignment === 'top') return { ...element, y: top };
      if (alignment === 'middle') return { ...element, y: Math.max(0, (top + bottom - element.height) / 2) };
      return { ...element, y: Math.max(0, bottom - element.height) };
    }) }));
    showToast('Elementos alinhados.');
  };

  const undo = () => {
    const previous = past[past.length - 1];
    if (!previous) return;
    setFuture((history) => [pages, ...history]);
    setPages(previous);
    setPast((history) => history.slice(0, -1));
    setSelectedId(null);
  };

  const redo = () => {
    const next = future[0];
    if (!next) return;
    setPast((history) => [...history, pages]);
    setPages(next);
    setFuture((history) => history.slice(1));
    setSelectedId(null);
  };

  const changePageOrder = (from: number, to: number) => {
    if (to < 0 || to >= pages.length) return;
    const next = [...pages];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    replacePages(next);
    setCurrentPage(to);
    setSelectedPageIndexes([to]);
  };

  const dropPageAt = (to: number) => {
    if (draggingPageIndex !== null && draggingPageIndex !== to) changePageOrder(draggingPageIndex, to);
    setDraggingPageIndex(null);
  };

  const selectPageAt = (index: number, extend = false) => {
    setCurrentPage(index);
    setSelectedId(null);
    setSelectedPageIndexes((current) => extend ? current.includes(index) ? current.filter((item) => item !== index) : [...current, index].sort((a, b) => a - b) : [index]);
  };

  const duplicatePage = (index = currentPage) => {
    const copy = { ...pages[index], id: uid(), elements: pages[index].elements.map((element) => ({ ...element, id: uid() })) };
    const next = [...pages]; next.splice(index + 1, 0, copy); replacePages(next); setCurrentPage(index + 1); showToast('Página duplicada.');
  };

  const insertBlankPage = (after = currentPage) => {
    const blank: EditorPage = { id: uid(), sourcePage: null, rotation: 0, elements: [] };
    const next = [...pages]; next.splice(after + 1, 0, blank); replacePages(next); setCurrentPage(after + 1); showToast('Página em branco inserida.');
  };

  const rotatePage = (index = currentPage) => {
    const indexes = selectedPageIndexes.length ? selectedPageIndexes : [index];
    replacePages(pages.map((page, pageIndex) => indexes.includes(pageIndex) ? { ...page, rotation: (page.rotation + 90) % 360 } : page));
  };

  const deleteSelectedPages = () => {
    const indexes = selectedPageIndexes.length > 1 ? selectedPageIndexes : [currentPage];
    if (pages.length - indexes.length < 1) { showToast('O documento precisa ter ao menos uma página.'); return; }
    const next = pages.filter((_, pageIndex) => !indexes.includes(pageIndex));
    replacePages(next);
    const nextIndex = Math.min(Math.min(...indexes), next.length - 1);
    setCurrentPage(nextIndex);
    setSelectedPageIndexes([nextIndex]);
    setSelectedId(null);
  };

  const deletePage = (index = currentPage) => {
    if (pages.length === 1) { showToast('O documento precisa ter ao menos uma página.'); return; }
    const next = pages.filter((_, pageIndex) => pageIndex !== index);
    replacePages(next);
    setCurrentPage(Math.min(index, next.length - 1));
    setSelectedId(null);
  };

  const fitZoom = (mode: 'width' | 'page') => {
    const workspace = workspaceRef.current;
    if (!workspace || !pageSize.width || !pageSize.height) return;
    const baseWidth = pageSize.width / zoom;
    const baseHeight = pageSize.height / zoom;
    const availableWidth = Math.max(240, workspace.clientWidth - 72);
    const availableHeight = Math.max(240, workspace.clientHeight - 92);
    const nextZoom = mode === 'width' ? availableWidth / baseWidth : Math.min(availableWidth / baseWidth, availableHeight / baseHeight);
    setZoom(Math.max(0.35, Math.min(2.5, Number(nextZoom.toFixed(2)))));
  };

  const openBookmark = async (bookmark: PdfBookmark) => {
    if (!pdfRef.current || bookmark.dest === undefined) return;
    try {
      const destination = typeof bookmark.dest === 'string' ? await pdfRef.current.getDestination(bookmark.dest) : bookmark.dest;
      const reference = Array.isArray(destination) ? destination[0] : null;
      if (!reference) return;
      const pageIndex = typeof reference === 'number' ? reference : await pdfRef.current.getPageIndex(reference as never);
      setCurrentPage(Math.max(0, Math.min(pages.length - 1, pageIndex)));
      setSelectedId(null);
    } catch {
      showToast('Não foi possível abrir este marcador.');
    }
  };

  const extractCurrentPage = async () => {
    if (!bytes || !activePage) return;
    const { PDFDocument } = await getPdfLib();
    const source = await PDFDocument.load(bytes);
    const output = await PDFDocument.create();
    if (activePage.sourcePage === null) output.addPage([612, 792]);
    else {
      const [page] = await output.copyPages(source, [activePage.sourcePage]);
      output.addPage(page);
    }
    const outputBytes = await output.save();
    const pdfBytes = outputBytes.buffer.slice(outputBytes.byteOffset, outputBytes.byteOffset + outputBytes.byteLength) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([pdfBytes], { type: 'application/pdf' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `pagina-${currentPage + 1}.pdf`; anchor.click(); URL.revokeObjectURL(url);
    showToast('Página extraída.');
  };

  const splitDocument = async () => {
    if (!bytes || !pages.length) return;
    try {
      setLoading(true);
      const { PDFDocument } = await getPdfLib();
      const source = await PDFDocument.load(bytes);
      for (let index = 0; index < pages.length; index += 1) {
        const output = await PDFDocument.create();
        const sourcePageIndex = pages[index].sourcePage;
        if (sourcePageIndex === null) output.addPage([612, 792]);
        else {
          const [copied] = await output.copyPages(source, [sourcePageIndex]);
          output.addPage(copied);
        }
        const outputBytes = await output.save();
        const outputBuffer = outputBytes.buffer.slice(outputBytes.byteOffset, outputBytes.byteOffset + outputBytes.byteLength) as ArrayBuffer;
        const url = URL.createObjectURL(new Blob([outputBuffer], { type: 'application/pdf' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${file?.name.replace(/\.pdf$/i, '') || 'documento'}-pagina-${index + 1}.pdf`;
        anchor.click();
        URL.revokeObjectURL(url);
        await new Promise((resolve) => window.setTimeout(resolve, 80));
      }
      showToast(`${pages.length} arquivos foram separados.`);
    } catch {
      showToast('Não foi possível dividir o documento.');
    } finally {
      setLoading(false);
    }
  };

  const exportCurrentPagePng = async () => {
    if (!pdfRef.current || !activePage || activePage.sourcePage === null) return;
    try {
      const page = await pdfRef.current.getPage(activePage.sourcePage + 1);
      const viewport = page.getViewport({ scale: 2, rotation: page.rotate + activePage.rotation });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) return;
      await page.render({ canvasContext: context, viewport }).promise;
      const url = canvas.toDataURL('image/png');
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${file?.name.replace(/\.pdf$/i, '') || 'pagina'}-${currentPage + 1}.png`;
      anchor.click();
      showToast('Página exportada como PNG.');
    } catch {
      showToast('Não foi possível exportar a página como PNG.');
    }
  };

  const exportText = async () => {
    if (!pdfRef.current) return;
    try {
      const content: string[] = [];
      for (let index = 0; index < pdfRef.current.numPages; index += 1) {
        const page = await pdfRef.current.getPage(index + 1);
        const text = await page.getTextContent();
        content.push(text.items.map((item) => ('str' in item ? item.str : '')).join(' '));
      }
      const blob = new Blob([content.join('\n\n')], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${file?.name.replace(/\.pdf$/i, '') || 'documento'}.txt`;
      anchor.click();
      URL.revokeObjectURL(url);
      showToast('Texto exportado.');
    } catch {
      showToast('Não foi possível exportar o texto.');
    }
  };

  const exportTextBatch = async (files: File[]) => {
    if (!files.length) return;
    setLoading(true);
    try {
      const pdfjsLib = await getPdfJs();
      for (const candidate of files) {
        const task = pdfjsLib.getDocument({ data: (await candidate.arrayBuffer()).slice(0), ...pdfJsTextOptions });
        const pdfDocument = await task.promise;
        const content: string[] = [];
        for (let index = 0; index < pdfDocument.numPages; index += 1) {
          const page = await pdfDocument.getPage(index + 1);
          const text = await page.getTextContent();
          content.push(text.items.map((item) => ('str' in item ? item.str : '')).join(' '));
        }
        await pdfDocument.destroy();
        const blob = new Blob([content.join('\n\n')], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${candidate.name.replace(/\.pdf$/i, '')}-texto.txt`;
        anchor.click();
        URL.revokeObjectURL(url);
        await new Promise((resolve) => window.setTimeout(resolve, 80));
      }
      showToast(`${files.length} PDF${files.length === 1 ? '' : 's'} processado${files.length === 1 ? '' : 's'} em lote.`);
    } catch { showToast('Não foi possível processar todos os PDFs selecionados.'); }
    finally { setLoading(false); }
  };

  const onBatchInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []).filter((candidate) => candidate.type === 'application/pdf' || candidate.name.toLowerCase().endsWith('.pdf'));
    event.target.value = '';
    void exportTextBatch(files);
  };

  const exportPortfolio = async () => {
    if (!attachments.length) { showToast('Adicione pelo menos um anexo antes de exportar o portfólio.'); return; }
    try {
      const { PDFDocument, StandardFonts, rgb } = await getPdfLib();
      const portfolio = await PDFDocument.create();
      const page = portfolio.addPage([612, 792]);
      const font = await portfolio.embedFont(StandardFonts.Helvetica);
      const bold = await portfolio.embedFont(StandardFonts.HelveticaBold);
      page.drawText('Portfólio de documentos', { x: 54, y: 710, size: 22, font: bold, color: rgb(0.1, 0.14, 0.18) });
      page.drawText('Arquivos anexados localmente ao PDF.', { x: 54, y: 684, size: 10, font, color: rgb(0.35, 0.4, 0.45) });
      attachments.forEach((attachment, index) => page.drawText(`${index + 1}. ${attachment.name} — ${formatBytes(attachment.size)}`, { x: 64, y: 640 - index * 22, size: 11, font, color: rgb(0.15, 0.18, 0.21), maxWidth: 490 }));
      for (const attachment of attachments) await portfolio.attach(new Uint8Array(await attachment.arrayBuffer()), attachment.name);
      const output = await portfolio.save();
      const buffer = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([buffer], { type: 'application/pdf' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${file?.name.replace(/\.pdf$/i, '') || 'documento'}-portfolio.pdf`; anchor.click(); URL.revokeObjectURL(url);
      showToast('Portfólio PDF exportado com anexos embutidos.');
    } catch { showToast('Não foi possível exportar o portfólio.'); }
  };

  const validateExport = async () => {
    if (!bytes || !pages.length) return;
    setLoading(true);
    try {
      const output = signatureRevisionBytes ? signatureRevisionBytes.buffer.slice(signatureRevisionBytes.byteOffset, signatureRevisionBytes.byteOffset + signatureRevisionBytes.byteLength) as ArrayBuffer : await buildPdfBytes();
      const pdfjsLib = await getPdfJs();
      const task = pdfjsLib.getDocument({ data: output.slice(0), password: security.userPassword || security.ownerPassword || undefined });
      const validation = await task.promise;
      const pageCount = validation.numPages;
      const redactionPages = pages.filter((page) => page.elements.some((element) => element.type === 'redaction')).length;
      const message = `${pageCount} páginas válidas${redactionPages ? `; ${redactionPages} página${redactionPages === 1 ? '' : 's'} rasterizada${redactionPages === 1 ? '' : 's'} para redação segura` : ''}.`;
      await validation.destroy();
      if (pageCount !== pages.length) throw new Error('A quantidade de páginas não foi preservada.');
      if (redactionPages && pdfRef.current) {
        const outputDocument = await pdfjsLib.getDocument({ data: output.slice(0) }).promise;
        try {
          for (const editorPage of pages.filter((page) => page.elements.some((element) => element.type === 'redaction'))) {
            if (editorPage.sourcePage === null) continue;
            const sourcePage = await pdfRef.current.getPage(editorPage.sourcePage + 1);
            const sourceContent = await sourcePage.getTextContent();
            const sourceWords = sourceContent.items.map((item) => ('str' in item ? item.str : '')).join(' ').split(/\s+/).filter((word) => word.length >= 4);
            sourcePage.cleanup();
            const outputPage = await outputDocument.getPage(pages.indexOf(editorPage) + 1);
            const outputContent = await outputPage.getTextContent();
            const outputText = outputContent.items.map((item) => ('str' in item ? item.str : '')).join(' ');
            outputPage.cleanup();
            if (sourceWords.some((word) => outputText.includes(word))) throw new Error('A redação não removeu todo o texto original.');
          }
        } finally {
          await outputDocument.destroy();
        }
      }
      showToast(`Verificação concluída: ${message}`);
    } catch { showToast('A verificação encontrou um problema na saída.'); }
    finally { setLoading(false); }
  };

  const buildPdfBytes = async (skipSecurity = false): Promise<ArrayBuffer> => {
    if (!bytes || !pages.length) throw new Error('Nenhum documento aberto.');
    const canTryNativeEdits = pages.some((page) => page.elements.some((element) => element.isExistingText && element.type === 'text' && element.originalText && element.text !== element.originalText));
    const nativeEditResult = canTryNativeEdits
      ? await applyNativeTextEdits(bytes, pages).catch((error) => {
        console.warn('[PDF Editor] edição nativa de texto indisponível; exportação segura será usada.', error);
        showToast(error instanceof Error ? `Texto preservado com fallback: ${error.message}` : 'Texto preservado com fallback tipográfico.');
        return { bytes, appliedElementIds: new Set<string>() };
      })
      : { bytes, appliedElementIds: new Set<string>() };
    const nativeEditedIds = nativeEditResult.appliedElementIds;
    const { PDFDocument, rgb, degrees, StandardFonts, PDFName, PDFHexString, PDFAcroSignature, PDFWidgetAnnotation } = await getPdfLib();
    const source = await PDFDocument.load(nativeEditResult.bytes);
    const output = await PDFDocument.create();
    output.setTitle(documentInfo.title || file?.name || 'Documento PDF');
    if (documentInfo.author) output.setAuthor(documentInfo.author);
    if (documentInfo.subject) output.setSubject(documentInfo.subject);
    for (const attachment of attachments) await output.attach(new Uint8Array(await attachment.arrayBuffer()), attachment.name);
    output.setProducer('PDF Editor');
    const form = output.getForm();
    const createdFormFields = new Set<string>();
    const createdSignatureFields = new Set<string>();
    const radioGroups = new Map<string, ReturnType<typeof form.createRadioGroup>>();
    const radioOptions = new Map<string, Set<string>>();
    for (const editorPage of pages) {
      let page;
      const redactions = editorPage.elements.filter((element) => element.type === 'redaction');
      const editedText = editorPage.elements.filter((element) => element.isExistingText && element.type === 'text');
      // Text fallback stays as vector text so an unsupported font subset never
      // converts the whole page into a bitmap. Redactions still rasterize to
      // guarantee that the removed pixels cannot be recovered.
      const rasterized = editorPage.sourcePage !== null && redactions.length > 0;
      if (editorPage.sourcePage === null) {
        page = output.addPage([612, 792]);
      } else if (rasterized && pdfRef.current) {
        const pdfjsLib = await getPdfJs();
        const sourcePage = await pdfRef.current.getPage(editorPage.sourcePage + 1);
        const viewport = sourcePage.getViewport({ scale: 2, rotation: sourcePage.rotate + editorPage.rotation });
        const rasterCanvas = document.createElement('canvas');
        rasterCanvas.width = Math.ceil(viewport.width);
        rasterCanvas.height = Math.ceil(viewport.height);
        const rasterContext = rasterCanvas.getContext('2d');
        if (!rasterContext) throw new Error('Canvas indisponível para redaction.');
        await sourcePage.render({ canvasContext: rasterContext, viewport }).promise;
        rasterContext.fillStyle = '#111820';
        redactions.forEach((element) => rasterContext.fillRect(element.x * viewport.width, element.y * viewport.height, element.width * viewport.width, element.height * viewport.height));
        if (editedText.length) {
          rasterContext.fillStyle = '#ffffff';
          editedText.forEach((element) => rasterContext.fillRect(element.x * viewport.width, element.y * viewport.height, element.width * viewport.width, element.height * viewport.height));
        }
        const image = await output.embedPng(rasterCanvas.toDataURL('image/png'));
        rasterCanvas.width = 0;
        rasterCanvas.height = 0;
        sourcePage.cleanup();
        page = output.addPage([viewport.width / 2, viewport.height / 2]);
        page.drawImage(image, { x: 0, y: 0, width: viewport.width / 2, height: viewport.height / 2 });
      } else {
        const [copied] = await output.copyPages(source, [editorPage.sourcePage]);
        page = output.addPage(copied);
        page.setRotation(degrees(editorPage.rotation));
      }
      if (editorPage.crop && !rasterized) {
        const fullWidth = page.getWidth();
        const fullHeight = page.getHeight();
        page.setCropBox(editorPage.crop.x * fullWidth, fullHeight - (editorPage.crop.y + editorPage.crop.height) * fullHeight, editorPage.crop.width * fullWidth, editorPage.crop.height * fullHeight);
      }
      for (const element of editorPage.elements) {
        if (['formText', 'checkbox', 'select'].includes(element.type) && element.formName) {
          if (createdFormFields.has(element.formName)) continue;
          createdFormFields.add(element.formName);
        }
        const width = page.getWidth();
        const height = page.getHeight();
        const x = element.x * width;
        const y = height - (element.y + element.height) * height;
        const color = hexToRgb(element.color || element.stroke || '#315d86');
        const opacity = element.opacity ?? 1;
        if (element.type === 'signatureField') {
          const fieldName = element.formName || `assinatura_${element.id}`;
          if (!createdSignatureFields.has(fieldName)) {
            const fieldDictionary = output.context.obj({ FT: PDFName.of('Sig'), T: PDFHexString.fromText(fieldName), Kids: [] });
            const fieldRef = output.context.register(fieldDictionary);
            const signatureField = PDFAcroSignature.fromDict(fieldDictionary, fieldRef);
            const formInternals = form as unknown as { acroForm: { addField: (ref: typeof fieldRef) => void } };
            formInternals.acroForm.addField(fieldRef);
            const widget = PDFWidgetAnnotation.create(output.context, fieldRef);
            widget.setRectangle({ x, y, width: element.width * width, height: element.height * height });
            widget.setP(page.ref);
            const widgetRef = output.context.register(widget.dict);
            signatureField.addWidget(widgetRef);
            page.node.addAnnot(widgetRef);
            createdSignatureFields.add(fieldName);
          }
          continue;
        }
        if (element.isExistingText && !rasterized && (!nativeEditedIds.has(element.id) || textPlacementChanged(element))) {
          const background = hexToRgb(element.backgroundColor || '#ffffff');
          const originalX = (element.originalX ?? element.x) * width;
          const originalY = (element.originalY ?? element.y) * height;
          const originalWidth = (element.originalWidth ?? element.width) * width;
          const originalHeight = (element.originalHeight ?? element.height) * height;
          const padding = getTextCoverPadding(element.fontSize || 12);
          const coverX = originalX - padding.x;
          const coverY = height - (originalY + originalHeight) - padding.bottom;
          page.drawRectangle({ x: coverX, y: coverY, width: originalWidth + padding.x * 2, height: originalHeight + padding.top + padding.bottom, color: rgb(background.r, background.g, background.b), opacity: 1, borderWidth: 0 });
        }
        if (element.type === 'text' && element.text && !element.deleted && (rasterized || !nativeEditedIds.has(element.id) || textPlacementChanged(element))) {
          const baseFont = element.fontFamily === 'Times' ? (element.bold ? StandardFonts.TimesRomanBold : StandardFonts.TimesRoman) : element.fontFamily === 'Courier' ? (element.bold ? StandardFonts.CourierBold : StandardFonts.Courier) : (element.bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
          const font = await output.embedFont(baseFont);
          const size = element.fontSize || 16;
          const textWidth = font.widthOfTextAtSize(element.text, size);
          const availableWidth = element.width * width;
          const alignedX = element.align === 'center' ? x + Math.max(0, (availableWidth - textWidth) / 2) : element.align === 'right' ? x + Math.max(0, availableWidth - textWidth) : x;
          page.drawText(element.text, { x: alignedX, y, size, font, color: rgb(color.r, color.g, color.b), opacity, maxWidth: Math.max(12, availableWidth), lineHeight: size * 1.2 });
        } else if (element.type === 'image' && element.dataUrl) {
          const image = element.dataUrl.includes('image/png') ? await output.embedPng(element.dataUrl) : await output.embedJpg(element.dataUrl);
          page.drawImage(image, { x, y, width: element.width * width, height: element.height * height, opacity });
        } else if (element.type === 'highlight') {
          page.drawRectangle({ x, y, width: element.width * width, height: element.height * height, color: rgb(0.96, 0.83, 0.18), opacity: 0.35, borderWidth: 0 });
        } else if (element.type === 'comment') {
          page.drawRectangle({ x, y, width: element.width * width, height: element.height * height, color: rgb(1, 0.95, 0.63), borderColor: rgb(0.55, 0.4, 0.08), borderWidth: 0.8, opacity });
          const font = await output.embedFont(StandardFonts.Helvetica);
          page.drawText(element.comment || element.text || 'Comentário', { x: x + 4, y: y + element.height * height - 14, size: 9, font, color: rgb(0.2, 0.17, 0.08), maxWidth: Math.max(20, element.width * width - 8), lineHeight: 11 });
        } else if (element.type === 'stamp') {
          page.drawRectangle({ x, y, width: element.width * width, height: element.height * height, borderColor: rgb(0.19, 0.36, 0.53), borderWidth: 1.2, color: rgb(0.9, 0.94, 0.98), opacity });
          const font = await output.embedFont(StandardFonts.HelveticaBold);
          page.drawText(element.stampText || 'CARIMBO', { x: x + 5, y: y + element.height * height / 2 - 4, size: 9, font, color: rgb(0.19, 0.36, 0.53), maxWidth: Math.max(20, element.width * width - 10) });
        } else if (element.type === 'redaction' && !rasterized) {
          page.drawRectangle({ x, y, width: element.width * width, height: element.height * height, color: rgb(0.05, 0.07, 0.09), borderWidth: 0, opacity: 1 });
        } else if (element.type === 'formText') {
          const field = form.createTextField(element.formName || `campo_${element.id}`);
          if (element.formValue) field.setText(element.formValue);
          field.addToPage(page, { x, y, width: element.width * width, height: element.height * height, borderWidth: 1, borderColor: rgb(0.4, 0.45, 0.5), backgroundColor: rgb(1, 1, 1), textColor: rgb(0.1, 0.12, 0.14) });
        } else if (element.type === 'checkbox') {
          const field = form.createCheckBox(element.formName || `campo_${element.id}`);
          if (element.checked) field.check(); else field.uncheck();
          field.addToPage(page, { x, y, width: element.width * width, height: element.height * height, borderWidth: 1, borderColor: rgb(0.4, 0.45, 0.5), backgroundColor: rgb(1, 1, 1) });
        } else if (element.type === 'select') {
          const field = form.createDropdown(element.formName || `campo_${element.id}`);
          field.addOptions(['Opção 1', 'Opção 2', 'Opção 3']);
          if (element.formValue) field.select(element.formValue);
          field.addToPage(page, { x, y, width: element.width * width, height: element.height * height, borderWidth: 1, borderColor: rgb(0.4, 0.45, 0.5), backgroundColor: rgb(1, 1, 1), textColor: rgb(0.1, 0.12, 0.14) });
        } else if (element.type === 'radio') {
          const groupName = element.formName || `grupo_radio_${editorPage.id}`;
          const group = radioGroups.get(groupName) || form.createRadioGroup(groupName);
          radioGroups.set(groupName, group);
          const options = radioOptions.get(groupName) || new Set<string>();
          const baseOption = element.formValue || `opcao_${element.id}`;
          let option = baseOption;
          while (options.has(option)) option = `${baseOption}_${options.size + 1}`;
          options.add(option);
          radioOptions.set(groupName, options);
          group.addOptionToPage(option, page, { x, y, width: element.width * width, height: element.height * height, borderWidth: 1, borderColor: rgb(0.4, 0.45, 0.5), backgroundColor: rgb(1, 1, 1) });
          if (element.checked) group.select(option);
        } else if (element.type === 'rect') {
          page.drawRectangle({ x, y, width: element.width * width, height: element.height * height, borderColor: rgb(color.r, color.g, color.b), borderWidth: 1.2, opacity });
        } else if (element.type === 'ellipse') {
          page.drawEllipse({ x: x + element.width * width / 2, y: y + element.height * height / 2, xScale: element.width * width / 2, yScale: element.height * height / 2, borderColor: rgb(color.r, color.g, color.b), borderWidth: 1.2, opacity });
        } else if (element.type === 'draw' || element.type === 'line' || element.type === 'underline' || element.type === 'strike') {
          page.drawLine({ start: { x, y }, end: { x: x + element.width * width, y: y + element.height * height }, color: rgb(color.r, color.g, color.b), thickness: element.type === 'draw' ? 2 : 1.3, opacity });
        }
      }
    }
    const outputBytes = await output.save();
    const rawBytes = outputBytes.buffer.slice(outputBytes.byteOffset, outputBytes.byteOffset + outputBytes.byteLength) as ArrayBuffer;
    return skipSecurity ? rawBytes : protectPdfBytes(rawBytes, security);
  };

  const digitallySignSelectedField = async () => {
    if (!selectedElement || selectedElement.type !== 'signatureField' || !selectedElement.formName) {
      showToast('Selecione um campo de assinatura digital do documento.');
      return;
    }
    if (security.userPassword || security.ownerPassword) {
      showToast('Remova a proteção antes de assinar digitalmente.');
      return;
    }
    setStatus('saving');
    try {
      const baseBytes = signatureRevisionBytes || new Uint8Array(await buildPdfBytes(true));
      const pdfLib = await getPdfLib();
      const { PDFDocument } = pdfLib;
      const signerModule = await getPdfSigner();
      let withPlaceholder: Uint8Array;
      if (signatureRevisionBytes) {
        withPlaceholder = appendSignaturePlaceholder(baseBytes, selectedElement.formName);
      } else {
        const pdfDocument = await PDFDocument.load(baseBytes);
        const field = pdfDocument.getForm().getSignature(selectedElement.formName);
        signerModule.addSignaturePlaceholder({ pdfLib, pdfDocLib: pdfDocument, field });
        withPlaceholder = await pdfDocument.save({ useObjectStreams: false });
      }
      const signedBytes = await signLastPlaceholder(withPlaceholder, { getOrCreateSigner: signerModule.getOrCreateSigner, buildCmsSignature: signerModule.buildCmsSignature });
      const pdfjsLib = await getPdfJs();
      const validationTask = pdfjsLib.getDocument({ data: signedBytes.slice(0) });
      const validation = await validationTask.promise;
      const validPageCount = validation.numPages === pages.length;
      await validation.destroy();
      if (!validPageCount) throw new Error('A assinatura alterou a quantidade de páginas.');
      const signedArrayBuffer = signedBytes.buffer.slice(signedBytes.byteOffset, signedBytes.byteOffset + signedBytes.byteLength) as ArrayBuffer;
      setSignatureRevisionBytes(signedBytes);
      const blob = new Blob([signedArrayBuffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${file?.name.replace(/\.pdf$/i, '') || 'documento'}-assinado.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus('saved');
      showToast(`Revisão ${countPdfSignatures(signedBytes)} assinada. Certificado autoassinado.`);
    } catch (error) {
      setStatus('idle');
      console.error('[PDF Editor] Falha na assinatura digital', error);
      showToast(error instanceof Error && error.message.includes('signature') ? 'Este campo não pode receber uma assinatura digital.' : 'Não foi possível assinar o PDF.');
    }
  };

  const savePdf = async () => {
    if (!bytes || !pages.length) return;
    setStatus('saving');
    try {
      const generatedBytes = signatureRevisionBytes ? signatureRevisionBytes.buffer.slice(signatureRevisionBytes.byteOffset, signatureRevisionBytes.byteOffset + signatureRevisionBytes.byteLength) as ArrayBuffer : await buildPdfBytes();
      const pdfBytes = signatureRevisionBytes || security.userPassword || security.ownerPassword ? generatedBytes : await optimizePdfInWorker(generatedBytes).catch(() => generatedBytes);
      const pdfjsLib = await getPdfJs();
      const validationTask = pdfjsLib.getDocument({ data: pdfBytes.slice(0), password: security.userPassword || security.ownerPassword || undefined });
      const validation = await validationTask.promise;
      const validPageCount = validation.numPages === pages.length;
      await validation.destroy();
      if (!validPageCount) throw new Error('A exportação não preservou todas as páginas.');
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = file?.name.replace(/\.pdf$/i, '') + '-editado.pdf' || 'documento-editado.pdf'; anchor.click();
    URL.revokeObjectURL(url);
    setStatus('saved');
    setRecoverySnapshot(null);
    void clearRecoverySnapshot();
    showToast('PDF exportado localmente.');
    } catch (error) {
      setStatus('idle');
      showToast(error instanceof Error && error.message.includes('preservou') ? error.message : 'Não foi possível exportar o PDF.');
    }
  };

  const runPreflightAudit = async (accessibilityOnly = false) => {
    if (!bytes || !pages.length) { showToast('Abra um documento antes de executar a auditoria.'); return; }
    setLoading(true);
    try {
      const candidate = accessibilityOnly ? bytes : await buildPdfBytes(true);
      const report = await runPdfPreflight(candidate, pages);
      const issues = accessibilityOnly ? report.issues.filter((issue) => ['alt-text', 'duplicate-field', 'metadata', 'javascript'].includes(issue.code)) : report.issues;
      const summary = formatPreflightReport({ ...report, issues });
      setComparisonSummary(`${summary} ${issues.slice(0, 3).map((issue) => issue.message).join(' ')}`);
      showToast(summary);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Não foi possível executar a auditoria.');
    } finally {
      setLoading(false);
    }
  };

  const runMenuAction = (label: string) => {
    setMenu(null);
    if (label === 'Novo documento' || label === 'Fechar') clearDocument();
    else if (label === 'Abrir PDF') fileInputRef.current?.click();
    else if (label === 'Abrir recente') { if (recentFiles[0]) void openPdf(recentFiles[0]); else showToast('Nenhum PDF foi aberto nesta sessão.'); }
    else if (label === 'Salvar' || label === 'Exportar' || label === 'Salvar como') void savePdf();
    else if (label === 'Exportar PNG') void exportCurrentPagePng();
    else if (label === 'Exportar texto') void exportText();
    else if (label === 'Extrair texto em lote') batchInputRef.current?.click();
    else if (label === 'Anexar arquivo') attachmentInputRef.current?.click();
    else if (label === 'Exportar portfólio') void exportPortfolio();
    else if (label === 'Proteger documento') setSecurityOpen(true);
    else if (label === 'Importar Office') officeInputRef.current?.click();
    else if (label === 'Converter DWG/DXF') cadInputRef.current?.click();
    else if (label === 'Desfazer') undo();
    else if (label === 'Refazer') redo();
    else if (label === 'Copiar') copySelected();
    else if (label === 'Colar') pasteSelected();
    else if (label === 'Recortar') cutSelected();
    else if (label === 'Excluir elemento') deleteSelected();
    else if (label === 'Zoom +') setZoom((value) => Math.min(2.5, value + 0.1));
    else if (label === 'Zoom -') setZoom((value) => Math.max(0.35, value - 0.1));
    else if (label === 'Ajustar à largura') fitZoom('width');
    else if (label === 'Ajustar à página') fitZoom('page');
    else if (label === 'Página única') setViewMode('single');
    else if (label === 'Rolagem contínua') setViewMode('continuous');
    else if (label === 'Tela cheia') document.documentElement.requestFullscreen?.();
    else if (label === 'Inserir páginas') choosePageImport('insert');
    else if (label === 'Inserir página antes') insertBlankPage(currentPage - 1);
    else if (label === 'Inserir página depois') insertBlankPage(currentPage);
    else if (label === 'Substituir página') choosePageImport('replace');
    else if (label === 'Excluir páginas') deleteSelectedPages();
    else if (label === 'Extrair páginas') void extractCurrentPage();
    else if (label === 'Duplicar páginas') duplicatePage();
    else if (label === 'Girar páginas') rotatePage();
    else if (label === 'Recortar página') selectTool('crop');
    else if (label === 'Reordenar páginas') { setShowLeft(true); setLeftPanelMode('pages'); showToast('Arraste uma miniatura para reordenar as páginas.'); }
    else if (label === 'Mesclar documentos') mergeInputRef.current?.click();
    else if (label === 'Dividir documento') void splitDocument();
    else if (label === 'Comparar documento') compareInputRef.current?.click();
    else if (label === 'Verificar saída') void validateExport();
    else if (label === 'Preflight de produção') void runPreflightAudit();
    else if (label === 'Auditoria de acessibilidade') void runPreflightAudit(true);
    else if (label === 'Imprimir') window.print();
    else if (label === 'Buscar') setSearchOpen(true);
    else {
      const matchingTool = toolDefinitions.find((item) => item.label === label);
      if (matchingTool) selectTool(matchingTool.id);
      else showToast('Este comando ainda não está disponível nesta versão.');
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 'o') { event.preventDefault(); fileInputRef.current?.click(); }
      if (modifier && event.key.toLowerCase() === 's') { event.preventDefault(); void savePdf(); }
      if (modifier && event.key.toLowerCase() === 'c') { event.preventDefault(); copySelected(); }
      if (modifier && event.key.toLowerCase() === 'v') { event.preventDefault(); pasteSelected(); }
      if (modifier && event.key.toLowerCase() === 'x') { event.preventDefault(); cutSelected(); }
      if (modifier && event.key.toLowerCase() === 'f') { event.preventDefault(); setSearchOpen(true); }
      if (modifier && event.key.toLowerCase() === 'z' && event.shiftKey) { event.preventDefault(); redo(); }
      else if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); }
      if (modifier && event.key === '=') { event.preventDefault(); setZoom((value) => Math.min(2.5, value + 0.1)); }
      if (modifier && event.key === '-') { event.preventDefault(); setZoom((value) => Math.max(0.35, value - 0.1)); }
      if (event.key === 'Delete') deleteSelected();
      if (event.key === 'Escape') { clearSelection(); setTool('select'); }
      if (event.key.toLowerCase() === 'v' && !modifier) selectTool('select');
      if (event.key.toLowerCase() === 't' && !modifier) selectTool('text');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const documentMeta = useMemo(() => ({ name: file?.name || 'Sem documento', size: file ? formatBytes(file.size) : '0 KB', pages: pages.length, attachments: attachments.length, comparison: comparisonSummary, title: documentInfo.title, author: documentInfo.author, subject: documentInfo.subject, created: documentDates.created, modified: documentDates.modified }), [file, pages.length, attachments.length, comparisonSummary, documentInfo, documentDates]);
  const setSecurityFlag = (key: 'printing' | 'copying' | 'modifying' | 'annotating' | 'fillingForms' | 'contentAccessibility' | 'documentAssembly') => (event: ChangeEvent<HTMLInputElement>) => setSecurity((current) => ({ ...current, [key]: event.target.checked }));
  const submitPassword = () => { if (!passwordPrompt || !passwordValue) return; sourcePasswordRef.current = passwordValue; passwordPrompt.callback(passwordValue); setPasswordPrompt(null); setPasswordValue(''); };
  const cancelPassword = () => { passwordPrompt?.callback(''); setPasswordPrompt(null); setPasswordValue(''); };

  if (!pdf) {
    return (
      <div className={`empty-app ${dark ? 'dark' : ''}`} onDragOver={(event) => { event.preventDefault(); setIsDraggingFile(true); }} onDragLeave={() => setIsDraggingFile(false)} onDrop={onDrop}>
        <div className="empty-topbar"><div className="brand"><span className="brand-mark"><FileText size={17} /></span><span>PDF Editor</span></div><button className="icon-button quiet" onClick={() => setDark((value) => !value)} title="Alternar tema">{dark ? <Sun size={16} /> : <Settings2 size={16} />}</button></div>
        <main className={`empty-state ${isDraggingFile ? 'is-dragging' : ''}`}>
          <div className="empty-mark"><FileText size={28} strokeWidth={1.5} /></div>
          <h1>Abra um documento para começar.</h1>
          <p>{loadError || 'Todo o processamento acontece neste navegador.'}</p>
          <button className="primary-button" onClick={() => fileInputRef.current?.click()}><FolderOpen size={16} /> Abrir PDF</button>
          <span className="drop-caption">ou arraste um PDF para esta área</span>
          {recoverySnapshot && <div className="recovery-prompt"><span>Uma sessão local foi encontrada ({recoverySnapshot.fileName}).</span><button className="secondary-button" onClick={() => void restoreLocalRecovery()}>Recuperar sessão</button></div>}
          {loading && <span className="loading-caption">Abrindo documento...</span>}
        </main>
        <input ref={fileInputRef} type="file" accept="application/pdf,.pdf" hidden onChange={onFileInput} />
        {passwordPrompt && <div className="modal-backdrop"><section className="password-modal" role="dialog" aria-modal="true" aria-label="Senha do PDF"><div className="signature-modal-head"><div><h2>PDF protegido</h2><p>{passwordPrompt.message}</p></div><button className="icon-button" onClick={cancelPassword}><X size={16} /></button></div><input autoFocus type="password" value={passwordValue} onChange={(event) => setPasswordValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitPassword(); }} placeholder="Digite a senha" /><div className="account-actions"><button className="secondary-button" onClick={cancelPassword}>Cancelar</button><button className="primary-button" onClick={submitPassword}>Abrir PDF</button></div></section></div>}
      </div>
    );
  }

  return (
    <div className={`editor-app ${dark ? 'dark' : ''}`} onDragOver={(event) => { event.preventDefault(); setIsDraggingFile(true); }} onDragLeave={() => setIsDraggingFile(false)} onDrop={onDrop}>
      <input ref={fileInputRef} type="file" accept="application/pdf,.pdf" hidden onChange={onFileInput} />
      <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onImageInput} />
      <input ref={mergeInputRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={onMergeInput} />
      <input ref={pageImportInputRef} type="file" accept="application/pdf,.pdf" hidden onChange={onPageImportInput} />
      <input ref={attachmentInputRef} type="file" multiple hidden onChange={onAttachmentInput} />
      <input ref={batchInputRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={onBatchInput} />
      <input ref={compareInputRef} type="file" accept="application/pdf,.pdf" hidden onChange={onCompareInput} />
      <input ref={officeInputRef} type="file" accept=".doc,.docx,.xls,.xlsx,.ppt,.pptx" hidden onChange={(event) => void onConversionInput(event, 'office')} />
      <input ref={cadInputRef} type="file" accept=".dwg,.dxf" hidden onChange={(event) => void onConversionInput(event, 'cad')} />
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><FileText size={16} /></span><span>PDF Editor</span></div>
        <nav className="menu-bar">
          {(['Arquivo', 'Editar', 'Exibir', 'Documento', 'Ferramentas'] as Exclude<MenuKey, null>[]).map((item) => (
            <div className="menu-wrap" key={item}><button className={`menu-trigger ${menu === item ? 'active' : ''}`} onClick={() => setMenu(menu === item ? null : item)}>{item}</button>{menu === item && <div className="dropdown">{menuItems[item].map((menuItem) => <button key={menuItem.label} className={menuItem.divider ? 'has-divider' : ''} onClick={() => runMenuAction(menuItem.label)}><span>{menuItem.label}</span>{menuItem.shortcut && <kbd>{menuItem.shortcut}</kbd>}</button>)}</div>}</div>
          ))}
        </nav>
        <div className="top-actions"><span className={`save-indicator ${status === 'saving' ? 'saving' : ''}`}><span className="status-dot" />{status === 'saving' ? 'Salvando...' : 'Salvo'}</span>{collaborationStatus === 'connected' && <span className="collaboration-indicator" title={`${collaborators.length} colaborador${collaborators.length === 1 ? '' : 'es'} conectado${collaborators.length === 1 ? '' : 's'}`}><Users size={13} />{collaborators.length + 1}</span>}{collaborationConflict && <button className="conflict-indicator" onClick={() => undefined} title="Conflito de colaboração pendente"><AlertTriangle size={13} />Conflito</button>}<button className="save-button" onClick={() => void savePdf()}><Save size={14} /> Salvar</button>{supabaseConfigured && sessionEmail && <button className="save-button cloud-button" onClick={() => void syncCurrentDocument()}>Sincronizar</button>}<button className="icon-button quiet" onClick={() => setDark((value) => !value)} title="Alternar tema">{dark ? <Sun size={15} /> : <Settings2 size={15} />}</button><button className="user-badge" title="Conta e sincronização" onClick={() => { setAccountOpen(true); setAccountMessage(null); }}>{sessionEmail ? sessionEmail.slice(0, 2).toUpperCase() : 'AD'}</button></div>
      </header>

      <section className="context-toolbar">
        <div className="tool-group primary-tools">
          {toolDefinitions.filter(({ id }) => primaryToolIds.has(id)).map(({ id, label, icon: Icon }) => <button key={id} className={`tool-button ${tool === id ? 'selected' : ''}`} onClick={() => selectTool(id)} title={label} aria-label={label} aria-pressed={tool === id}><Icon size={16} /><span>{label}</span></button>)}
          <div className="toolbar-more-wrap" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setToolbarMoreOpen(false); }} onKeyDown={(event) => { if (event.key === 'Escape') { setToolbarMoreOpen(false); (event.currentTarget.querySelector('.toolbar-more-trigger') as HTMLButtonElement | null)?.focus(); } }}>
            <button className={`tool-button toolbar-more-trigger ${toolbarMoreOpen || secondaryToolDefinitions.some(({ id }) => tool === id) ? 'selected' : ''}`} onClick={() => setToolbarMoreOpen((open) => !open)} title="Mais ferramentas" aria-label="Mais ferramentas" aria-haspopup="menu" aria-expanded={toolbarMoreOpen}><MoreHorizontal size={16} /><span>{secondaryToolDefinitions.find(({ id }) => id === tool)?.label || 'Anotar'}</span><ChevronDown size={12} /></button>
            {toolbarMoreOpen && <div className="toolbar-more-menu" role="menu" aria-label="Mais ferramentas">{secondaryToolDefinitions.map(({ id, label, icon: Icon }) => <button key={id} role="menuitem" className={tool === id ? 'active' : ''} onClick={() => selectTool(id)}><Icon size={15} /><span>{label}</span>{tool === id && <Check size={13} />}</button>)}<div className="toolbar-menu-divider" /><button role="menuitem" onClick={() => { setToolbarMoreOpen(false); void runOcr(); }} disabled={ocrRunning}><ScanText size={15} /><span>{ocrRunning ? `OCR ${ocrProgress}%` : 'Reconhecer texto (OCR)'}</span></button></div>}
          </div>
        </div>
        <div className="toolbar-divider" />
        {selectedIds.length > 1 ? <div className="selection-toolbar"><span className="toolbar-context-label">{selectedIds.length} elementos</span><button className="shape-option" onClick={() => alignSelected('left')}>Esq.</button><button className="shape-option" onClick={() => alignSelected('center')}>Centro</button><button className="shape-option" onClick={() => alignSelected('right')}>Dir.</button><button className="shape-option" onClick={() => alignSelected('top')}>Topo</button><button className="shape-option" onClick={() => alignSelected('middle')}>Meio</button><button className="shape-option" onClick={() => alignSelected('bottom')}>Base</button></div> : tool === 'text' || selectedElement?.type === 'text' ? <TextToolbar element={selectedElement} onChange={updateSelected} /> : tool === 'shape' ? <ShapeToolbar value={shapeKind} onChange={setShapeKind} /> : tool === 'form' ? <FormToolbar value={formKind} onChange={setFormKind} /> : tool === 'stamp' ? <StampToolbar value={stampKind} onChange={setStampKind} /> : selectedElement ? <div className="toolbar-context-label">{selectedElement.type === 'image' ? 'Imagem selecionada' : 'Elemento selecionado'}</div> : null}
        {searchOpen && <div className="search-bar"><Search size={14} /><input autoFocus value={searchTerm} placeholder="Buscar no documento" onChange={(event) => setSearchTerm(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') moveToSearchResult(event.shiftKey ? -1 : 1); if (event.key === 'Escape') { setSearchOpen(false); setSearchTerm(''); } }} /><span>{searchTerm ? `${searchResults.length ? searchIndex + 1 : 0}/${searchResults.length}` : 'Digite para buscar'}</span><button className="icon-button tiny" onClick={() => moveToSearchResult(-1)} disabled={!searchResults.length}><ChevronLeft size={14} /></button><button className="icon-button tiny" onClick={() => moveToSearchResult(1)} disabled={!searchResults.length}><ChevronRight size={14} /></button><input className="replace-input" value={replaceTerm} placeholder="Substituir por" onChange={(event) => setReplaceTerm(event.target.value)} /><button className="replace-button" onClick={replaceCurrentText} disabled={!searchResults.length}>Substituir</button><button className="icon-button tiny" onClick={() => { setSearchOpen(false); setSearchTerm(''); setReplaceTerm(''); }}><X size={14} /></button></div>}
        {selectedElement?.type === 'signatureField' && <button className="primary-button signature-toolbar-action" onClick={() => void digitallySignSelectedField()}><Pencil size={14} /> Assinar localmente</button>}
        {selectedElement?.type === 'signatureField' && integrationCapabilities.remoteSigning && <button className="secondary-button signature-toolbar-action" onClick={() => void requestTrustedSignature()}><ShieldAlert size={14} /> Solicitar assinatura confiável</button>}
        {searchOpen && <div className="search-options"><button className={`search-option ${searchCaseSensitive ? 'active' : ''}`} onClick={() => setSearchCaseSensitive((value) => !value)} title="Diferenciar maiúsculas e minúsculas">Aa</button><button className={`search-option ${searchWholeWord ? 'active' : ''}`} onClick={() => setSearchWholeWord((value) => !value)} title="Buscar palavra inteira">Ab</button></div>}
        <div className="toolbar-spacer" />
        <button className="icon-button" onClick={undo} disabled={!past.length} title="Desfazer" aria-label="Desfazer"><Undo2 size={16} /></button><button className="icon-button" onClick={redo} disabled={!future.length} title="Refazer" aria-label="Refazer"><Redo2 size={16} /></button>
      </section>

      <div className="workspace-shell">
        {showLeft && <aside className="left-panel"><div className="left-rail"><button className={leftPanelMode === 'pages' ? 'active' : ''} onClick={() => setLeftPanelMode('pages')} title="Páginas"><Layers2 size={18} /></button><button className={leftPanelMode === 'bookmarks' ? 'active' : ''} onClick={() => setLeftPanelMode('bookmarks')} title="Marcadores"><Bookmark size={18} /></button><button onClick={() => setSearchOpen(true)} title="Pesquisar"><Search size={18} /></button><button onClick={() => selectTool('comment')} title="Anotações"><MessageSquare size={18} /></button><button onClick={() => selectTool('form')} title="Formulários"><FormInput size={18} /></button></div><div className="panel-tabs"><button className={leftPanelMode === 'pages' ? 'active' : ''} onClick={() => setLeftPanelMode('pages')}><Layers2 size={13} /> Páginas</button><button className={leftPanelMode === 'bookmarks' ? 'active' : ''} onClick={() => setLeftPanelMode('bookmarks')}><Bookmark size={13} /> Marcadores</button></div>{leftPanelMode === 'pages' ? <><div className="panel-heading"><span>Páginas</span><div className="panel-heading-actions"><button className="icon-button tiny" onClick={() => insertBlankPage()} title="Inserir página"><Plus size={14} /></button><button className="icon-button tiny" onClick={() => setPageMenu(pageMenu === -1 ? null : -1)}><MoreHorizontal size={15} /></button></div></div><div className="thumbnails">{pages.map((page, index) => <Thumbnail key={page.id} page={page} index={index} active={index === currentPage} multi={selectedPageIndexes.includes(index)} renderThumb={renderThumb} onClick={(extend) => selectPageAt(index, extend)} onMenu={() => setPageMenu(pageMenu === index ? null : index)} pageMenu={pageMenu} onDelete={() => deletePage(index)} onDuplicate={() => duplicatePage(index)} onRotate={() => rotatePage(index)} onMoveUp={() => changePageOrder(index, index - 1)} onMoveDown={() => changePageOrder(index, index + 1)} onDragStart={() => setDraggingPageIndex(index)} onDrop={() => dropPageAt(index)} />)}</div><div className="panel-footer"><button className="text-button" onClick={() => insertBlankPage()}><FilePlus2 size={14} /> Inserir página</button></div></> : <BookmarkTree items={bookmarks} onOpen={openBookmark} />}</aside>}
        <main ref={workspaceRef} className="document-workspace"><div className="workspace-topline"><span>{file?.name}</span><span className="workspace-hint">{isDraggingFile ? 'Solte para abrir outro documento' : loading ? 'Processando...' : viewMode === 'continuous' ? 'Rolagem contínua' : 'Processamento local'}</span></div><div className="page-scroll">{viewMode === 'continuous' ? <ContinuousDocument pdf={pdf} pages={pages} zoom={zoom} currentPage={currentPage} onSelectPage={(index) => { setCurrentPage(index); setViewMode('single'); clearSelection(); }} /> : <SinglePageSurface pageSize={pageSize} activePage={activePage} renderCanvasRef={renderCanvasRef} textRuns={textRuns} tool={tool} zoom={zoom} selectedIds={selectedIds} isDrawing={isDrawing} drawStart={drawStart} drawEnd={drawEnd} currentPage={currentPage} onPagePointerDown={handlePagePointerDown} onPagePointerMove={handlePagePointerMove} onPagePointerUp={handlePagePointerUp} onEditText={editPdfText} onSelectElement={selectElement} onChangeElement={updateElementById} />}</div></main>
        {showRight && <aside className="right-panel"><div className="right-panel-tabs"><button className={rightPanelMode === 'properties' ? 'active' : ''} onClick={() => setRightPanelMode('properties')}>Propriedades</button><button className={rightPanelMode === 'layers' ? 'active' : ''} onClick={() => setRightPanelMode('layers')}>Camadas</button></div>{rightPanelMode === 'properties' ? <PropertiesPanel selected={selectedElement} documentMeta={documentMeta} onChange={updateSelected} onDocumentInfoChange={setDocumentInfo} onDelete={deleteSelected} /> : <LayersPanel page={activePage} selectedId={selectedId} onSelect={(id) => selectElement(id)} />}</aside>}
      </div>

      <footer className="bottom-bar"><div className="bottom-left"><button className="panel-toggle" onClick={() => setShowLeft((value) => !value)}><Layers2 size={15} /> <span>{showLeft ? 'Ocultar páginas' : 'Mostrar páginas'}</span></button><span className="page-location">Página <strong>{currentPage + 1}</strong> de {pages.length}</span></div><div className="zoom-controls"><button className="icon-button tiny" onClick={() => setZoom((value) => Math.max(0.35, value - 0.1))} title="Reduzir zoom" aria-label="Reduzir zoom"><ZoomOut size={15} /></button><button className="zoom-value" onClick={() => setZoom(1)} title="Redefinir para 100%">{Math.round(zoom * 100)}%</button><button className="icon-button tiny" onClick={() => setZoom((value) => Math.min(2.5, value + 0.1))} title="Aumentar zoom" aria-label="Aumentar zoom"><ZoomIn size={15} /></button><button className="fit-button" onClick={() => fitZoom('width')}>Ajustar largura</button><button className="fit-button" onClick={() => fitZoom('page')}>Ajustar página</button><button className="fit-button" onClick={() => setViewMode((value) => value === 'single' ? 'continuous' : 'single')}>{viewMode === 'single' ? 'Rolagem contínua' : 'Página única'}</button></div><div className="bottom-right"><button className="panel-toggle" onClick={() => setShowRight((value) => !value)}>{showRight ? 'Ocultar propriedades' : 'Mostrar propriedades'} <Settings2 size={14} /></button><button className="icon-button tiny" onClick={() => document.documentElement.requestFullscreen?.()} title="Tela cheia"><Fullscreen size={15} /></button><span className="bottom-status"><span className="status-dot" />{status === 'saving' ? 'Salvando...' : 'Salvo'}</span></div></footer>
      {signatureOpen && <div className="modal-backdrop"><section className="signature-modal" role="dialog" aria-modal="true" aria-label="Assinar documento"><div className="signature-modal-head"><div><h2>Assinatura</h2><p>Desenhe sua assinatura. Ela será inserida somente neste documento local.</p></div><button className="icon-button" onClick={() => setSignatureOpen(false)}><X size={16} /></button></div><canvas ref={signatureCanvasRef} width={640} height={220} className="signature-pad" onPointerDown={(event) => { const point = signaturePoint(event); const context = event.currentTarget.getContext('2d'); if (!context) return; setSignatureDrawing(true); context.beginPath(); context.moveTo(point.x, point.y); }} onPointerMove={(event) => { if (!signatureDrawing) return; const point = signaturePoint(event); const context = event.currentTarget.getContext('2d'); if (!context) return; context.lineTo(point.x, point.y); context.stroke(); }} onPointerUp={() => setSignatureDrawing(false)} onPointerLeave={() => setSignatureDrawing(false)} /><div className="signature-actions"><button className="text-button" onClick={clearSignatureCanvas}><Eraser size={14} /> Limpar</button><div><button className="secondary-button" onClick={() => setSignatureOpen(false)}>Cancelar</button><button className="primary-button" onClick={placeSignature}><Check size={14} /> Inserir assinatura</button></div></div></section></div>}
      {accountOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAccountOpen(false); }}><section className="account-modal" role="dialog" aria-modal="true" aria-label="Conta e sincronização"><div className="signature-modal-head"><div><h2>Conta e sincronização</h2><p>O documento só é enviado quando você aciona a sincronização.</p></div><button className="icon-button" onClick={() => setAccountOpen(false)}><X size={16} /></button></div>{sessionEmail ? <><p className="account-session">Sessão ativa: {sessionEmail}</p><button className="secondary-button" onClick={() => void signOut()}>Encerrar sessão</button><button className="primary-button account-sync" onClick={() => void syncCurrentDocument()} disabled={accountBusy}>{accountBusy ? 'Enviando...' : 'Enviar versão atual'}</button></> : <>{!supabaseConfigured && <p className="property-note">{cloudConfigurationMessage()}</p>}<label className="account-field">E-mail<input type="email" value={accountEmail} onChange={(event) => setAccountEmail(event.target.value)} autoComplete="email" /></label><label className="account-field">Senha<input type="password" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} autoComplete="current-password" /></label><div className="account-actions"><button className="secondary-button" onClick={() => void authenticate('signup')} disabled={accountBusy || !supabaseConfigured}>Criar conta</button><button className="primary-button" onClick={() => void authenticate('signin')} disabled={accountBusy || !supabaseConfigured}>Entrar</button></div></>}{accountMessage && <p className="account-message">{accountMessage}</p>}</section></div>}
      {securityOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSecurityOpen(false); }}><section className="security-modal" role="dialog" aria-modal="true" aria-label="Proteger documento"><div className="signature-modal-head"><div><h2>Proteger documento</h2><p>A proteção é aplicada somente no próximo PDF exportado.</p></div><button className="icon-button" onClick={() => setSecurityOpen(false)}><X size={16} /></button></div><label className="account-field">Senha para abrir<input type="password" value={security.userPassword} onChange={(event) => setSecurity((current) => ({ ...current, userPassword: event.target.value }))} autoComplete="new-password" /></label><label className="account-field">Senha do proprietário<input type="password" value={security.ownerPassword} onChange={(event) => setSecurity((current) => ({ ...current, ownerPassword: event.target.value }))} autoComplete="new-password" /></label><p className="security-kicker">Permissões para quem abrir com a senha de usuário</p><div className="security-grid"><label><input type="checkbox" checked={security.printing} onChange={setSecurityFlag('printing')} /> Imprimir</label><label><input type="checkbox" checked={security.copying} onChange={setSecurityFlag('copying')} /> Copiar conteúdo</label><label><input type="checkbox" checked={security.modifying} onChange={setSecurityFlag('modifying')} /> Modificar conteúdo</label><label><input type="checkbox" checked={security.annotating} onChange={setSecurityFlag('annotating')} /> Anotar</label><label><input type="checkbox" checked={security.fillingForms} onChange={setSecurityFlag('fillingForms')} /> Preencher formulários</label><label><input type="checkbox" checked={security.contentAccessibility} onChange={setSecurityFlag('contentAccessibility')} /> Acessibilidade</label><label><input type="checkbox" checked={security.documentAssembly} onChange={setSecurityFlag('documentAssembly')} /> Montar páginas</label></div><div className="account-actions"><button className="secondary-button" onClick={() => setSecurity((current) => ({ ...current, userPassword: '', ownerPassword: '' }))}>Remover proteção</button><button className="primary-button" onClick={() => setSecurityOpen(false)}>Aplicar na exportação</button></div></section></div>}
      {passwordPrompt && <div className="modal-backdrop"><section className="password-modal" role="dialog" aria-modal="true" aria-label="Senha do PDF"><div className="signature-modal-head"><div><h2>PDF protegido</h2><p>{passwordPrompt.message}</p></div><button className="icon-button" onClick={cancelPassword}><X size={16} /></button></div><input autoFocus type="password" value={passwordValue} onChange={(event) => setPasswordValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitPassword(); }} placeholder="Digite a senha" /><div className="account-actions"><button className="secondary-button" onClick={cancelPassword}>Cancelar</button><button className="primary-button" onClick={submitPassword}>Abrir PDF</button></div></section></div>}
      {collaborationConflict && <div className="modal-backdrop"><section className="conflict-modal" role="dialog" aria-modal="true" aria-label="Conflito de colaboração"><div className="signature-modal-head"><div><h2>Conflito de colaboração</h2><p>Outra pessoa editou o documento a partir de uma versão anterior. Nada foi sobrescrito automaticamente.</p></div><AlertTriangle size={18} /></div><p className="property-note">Versão remota: {collaborationConflict.incoming.pages.length} página(s). O merge compara páginas e elementos por ID, preservando alterações independentes.</p><div className="account-actions"><button className="secondary-button" onClick={() => resolveCollaborationConflict('local')}>Manter minha versão</button><button className="secondary-button" onClick={() => resolveCollaborationConflict('merge')}>Mesclar por elemento</button><button className="primary-button" onClick={() => resolveCollaborationConflict('remote')}>Usar versão remota</button></div></section></div>}
      {toast && <div className="toast"><Check size={15} />{toast}</div>}
    </div>
  );
}

function SinglePageSurface({ pageSize, activePage, renderCanvasRef, textRuns, tool, zoom, selectedIds, isDrawing, drawStart, drawEnd, currentPage, onPagePointerDown, onPagePointerMove, onPagePointerUp, onEditText, onSelectElement, onChangeElement }: { pageSize: { width: number; height: number }; activePage: EditorPage | undefined; renderCanvasRef: RefObject<HTMLCanvasElement>; textRuns: PdfTextRun[]; tool: Tool; zoom: number; selectedIds: string[]; isDrawing: boolean; drawStart: { x: number; y: number }; drawEnd: { x: number; y: number }; currentPage: number; onPagePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void; onPagePointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void; onPagePointerUp: () => void; onEditText: (run: PdfTextRun) => void; onSelectElement: (id: string, additive?: boolean) => void; onChangeElement: (id: string, patch: Partial<EditorElement>, history?: boolean) => void }) {
  const textCovers = activePage?.elements.flatMap((element) => {
    if (!element.isExistingText || (!element.sourceTextId && element.originalX === undefined)) return [];
    const sourceRun = textRuns.find((run) => run.id === element.sourceTextId);
    const originalX = element.originalX ?? (sourceRun ? sourceRun.x / pageSize.width : undefined);
    const originalY = element.originalY ?? (sourceRun ? sourceRun.y / pageSize.height : undefined);
    const originalWidth = element.originalWidth ?? (sourceRun ? sourceRun.width / pageSize.width : undefined);
    const originalHeight = element.originalHeight ?? (sourceRun ? sourceRun.height / pageSize.height : undefined);
    if (originalX === undefined || originalY === undefined || originalWidth === undefined || originalHeight === undefined) return [];
    const moved = Math.abs(element.x - originalX) > 0.0005 || Math.abs(element.y - originalY) > 0.0005 || Math.abs(element.width - originalWidth) > 0.0005 || Math.abs(element.height - originalHeight) > 0.0005;
    const sourceText = element.originalText ?? sourceRun?.text;
    const changed = sourceText !== undefined && element.text !== sourceText;
    if (!element.deleted && !moved && !changed) return [];
    const background = element.backgroundColor || (sourceRun ? sampleTextRunBackground(renderCanvasRef.current, sourceRun, pageSize) : '#ffffff');
    const padding = getTextCoverPadding(sourceRun?.fontSize ?? (element.fontSize || 12) * zoom);
    const left = Math.max(0, originalX * pageSize.width - padding.x);
    const top = Math.max(0, originalY * pageSize.height - padding.top);
    const right = Math.min(pageSize.width, (originalX + originalWidth) * pageSize.width + padding.x);
    const bottom = Math.min(pageSize.height, (originalY + originalHeight) * pageSize.height + padding.bottom);
    return [<div key={`cover-${element.id}`} className="original-text-cover" style={{ left, top, width: right - left, height: bottom - top, background }} />];
  }) ?? [];
  return <><div className="page-stage" style={{ width: pageSize.width, minHeight: pageSize.height }}><div className="page-surface" style={{ width: pageSize.width, height: pageSize.height }} onPointerDown={onPagePointerDown} onPointerMove={onPagePointerMove} onPointerUp={onPagePointerUp} onPointerLeave={onPagePointerUp}><canvas ref={renderCanvasRef} className="pdf-canvas" /><div className="pdf-text-layer">{textRuns.map((run) => <span key={run.id} className="pdf-text-run" style={{ left: run.x, top: run.y, width: run.width, height: run.height, fontSize: run.fontSize }} onPointerDown={(event) => { if (tool === 'select') { event.stopPropagation(); onEditText(run); } }}>{run.text}</span>)}</div>{textCovers}{activePage?.elements.filter((element) => !element.deleted).map((element) => <ElementOverlay key={element.id} element={element} selected={selectedIds.includes(element.id)} scale={zoom} interactive={tool === 'select'} onSelect={(additive) => onSelectElement(element.id, additive)} onChange={(patch, history) => onChangeElement(element.id, patch, history)} />)}{activePage?.crop && <div className="crop-frame" style={{ left: `${activePage.crop.x * 100}%`, top: `${activePage.crop.y * 100}%`, width: `${activePage.crop.width * 100}%`, height: `${activePage.crop.height * 100}%` }} />}{isDrawing && <div className={`draw-preview ${tool}`} style={{ left: `${Math.min(drawStart.x, drawEnd.x) * 100}%`, top: `${Math.min(drawStart.y, drawEnd.y) * 100}%`, width: `${Math.abs(drawEnd.x - drawStart.x) * 100}%`, height: `${Math.abs(drawEnd.y - drawStart.y) * 100}%` }} />}</div></div><div className="page-footnote">Página {currentPage + 1}</div></>;
}

function ContinuousDocument({ pdf, pages, zoom, currentPage, onSelectPage }: { pdf: PdfJs.PDFDocumentProxy; pages: EditorPage[]; zoom: number; currentPage: number; onSelectPage: (index: number) => void }) {
  return <div className="continuous-document">{pages.map((page, index) => Math.abs(index - currentPage) <= 2 ? <ContinuousPage key={page.id} pdf={pdf} page={page} index={index} zoom={zoom} active={index === currentPage} onSelect={() => onSelectPage(index)} /> : <button key={page.id} className="continuous-page virtualized-page" style={{ width: 612 * zoom, height: 792 * zoom }} onClick={() => onSelectPage(index)}><div className="continuous-page-label">Página {index + 1}</div></button>)}</div>;
}

function ContinuousPage({ pdf, page, index, zoom, active, onSelect }: { pdf: PdfJs.PDFDocumentProxy; page: EditorPage; index: number; zoom: number; active: boolean; onSelect: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    let sourcePage: PdfJs.PDFPageProxy | null = null;
    const render = async () => {
      if (page.sourcePage === null || !canvasRef.current) return;
      sourcePage = await pdf.getPage(page.sourcePage + 1);
      if (cancelled || !canvasRef.current) return;
      const viewport = sourcePage.getViewport({ scale: zoom, rotation: sourcePage.rotate + page.rotation });
      canvasRef.current.width = viewport.width;
      canvasRef.current.height = viewport.height;
      task = sourcePage.render({ canvasContext: canvasRef.current.getContext('2d')!, viewport });
      try { await task.promise; } catch (error) { if ((error as Error).name !== 'RenderingCancelledException') throw error; }
    };
    void render();
    return () => { cancelled = true; task?.cancel(); if (canvasRef.current) { canvasRef.current.width = 0; canvasRef.current.height = 0; } sourcePage?.cleanup(); };
  }, [pdf, page.sourcePage, page.rotation, zoom]);
  return <button className={`continuous-page ${active ? 'active' : ''}`} onClick={onSelect}><div className="continuous-page-label">Página {index + 1}</div>{page.sourcePage === null ? <div className="continuous-blank" /> : <canvas ref={canvasRef} />}</button>;
}

function BookmarkTree({ items, onOpen }: { items: PdfBookmark[]; onOpen: (bookmark: PdfBookmark) => void }) {
  if (!items.length) return <div className="panel-empty"><Bookmark size={18} /><p>Este documento não possui marcadores.</p></div>;
  return <div className="bookmark-tree">{items.map((bookmark, index) => <div className="bookmark-item" key={`${bookmark.title}-${index}`}><button onClick={() => onOpen(bookmark)}><Bookmark size={13} /><span>{bookmark.title}</span></button>{bookmark.items?.length ? <BookmarkTree items={bookmark.items} onOpen={onOpen} /> : null}</div>)}</div>;
}

function Thumbnail({ page, index, active, multi, renderThumb, onClick, onMenu, pageMenu, onDelete, onDuplicate, onRotate, onMoveUp, onMoveDown, onDragStart, onDrop }: { page: EditorPage; index: number; active: boolean; multi: boolean; renderThumb: (pageNumber: number, canvas: HTMLCanvasElement, sourcePage?: number | null, rotation?: number) => Promise<void>; onClick: (extend: boolean) => void; onMenu: () => void; pageMenu: number | null; onDelete: () => void; onDuplicate: () => void; onRotate: () => void; onMoveUp: () => void; onMoveDown: () => void; onDragStart: () => void; onDrop: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(index < 8);
  useEffect(() => {
    if (visible || !wrapperRef.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '240px' });
    observer.observe(wrapperRef.current);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => { if (visible && page.sourcePage !== null && canvasRef.current) void renderThumb(index, canvasRef.current, page.sourcePage, page.rotation); }, [index, page.sourcePage, page.rotation, renderThumb, visible]);
  return <div ref={wrapperRef} className={`thumbnail-wrap ${active ? 'active' : ''} ${multi ? 'multi' : ''}`}><button className="thumbnail" aria-label={`Selecionar página ${index + 1}`} aria-current={active ? 'page' : undefined} draggable onDragStart={onDragStart} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); onDrop(); }} onClick={(event) => onClick(event.shiftKey)} onContextMenu={(event) => { event.preventDefault(); onMenu(); }}><div className="thumbnail-number">{String(index + 1).padStart(2, '0')}</div><div className="thumb-paper">{page.sourcePage === null ? <div className="blank-thumb" /> : visible ? <canvas ref={canvasRef} /> : <div className="thumbnail-placeholder" />}</div><span className="thumb-caption">Página {index + 1}</span></button><button className="thumb-menu-trigger" aria-label={`Mais ações da página ${index + 1}`} onClick={onMenu}><MoreHorizontal size={14} /></button>{pageMenu === index && <div className="thumb-menu"><button onClick={onMoveUp}><ArrowUp size={13} /> Mover para cima</button><button onClick={onMoveDown}><ArrowDown size={13} /> Mover para baixo</button><button onClick={onDuplicate}><Copy size={13} /> Duplicar</button><button onClick={onRotate}><RotateCw size={13} /> Girar 90°</button><button className="danger" onClick={onDelete}><Trash2 size={13} /> Excluir</button></div>}</div>;
}

function ElementOverlay({ element, selected, interactive = true, onSelect, onChange }: { element: EditorElement; selected: boolean; scale: number; interactive?: boolean; onSelect: (additive: boolean) => void; onChange: (patch: Partial<EditorElement>, history?: boolean) => void }) {
  const drag = useRef<{ x: number; y: number; originX: number; originY: number; originWidth: number; originHeight: number; mode: 'move' | 'resize'; moved: boolean } | null>(null);
  const style = { left: `${element.x * 100}%`, top: `${element.y * 100}%`, width: `${element.width * 100}%`, height: `${element.height * 100}%`, opacity: element.opacity ?? 1 };
  const common = {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!interactive) return;
      event.stopPropagation();
      onSelect(event.shiftKey || event.ctrlKey || event.metaKey);
      const isHandle = (event.target as HTMLElement).classList.contains('resize-handle');
      drag.current = { x: event.clientX, y: event.clientY, originX: element.x, originY: element.y, originWidth: element.width, originHeight: element.height, mode: isHandle ? 'resize' : 'move', moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!interactive || !drag.current) return;
      const parent = event.currentTarget.parentElement?.getBoundingClientRect();
      if (!parent) return;
      const deltaX = (event.clientX - drag.current.x) / parent.width;
      const deltaY = (event.clientY - drag.current.y) / parent.height;
      let patch: Partial<EditorElement>;
      if (drag.current.mode === 'resize') {
        patch = { width: Math.max(0.03, Math.min(1 - element.x, drag.current.originWidth + deltaX)), height: Math.max(0.02, Math.min(1 - element.y, drag.current.originHeight + deltaY)) };
      } else {
        const nextX = Math.max(0, Math.min(1 - element.width, drag.current.originX + deltaX));
        const nextY = Math.max(0, Math.min(1 - element.height, drag.current.originY + deltaY));
        patch = { x: nextX, y: nextY };
      }
      onChange(patch, !drag.current.moved);
      drag.current.moved = true;
    },
    onPointerUp: () => { drag.current = null; },
  };
  const content = element.type === 'text' ? <div className="text-content" contentEditable suppressContentEditableWarning onBlur={(event) => onChange({ text: event.currentTarget.textContent || '' }, true)} style={{ color: element.color, fontSize: `${element.fontSize || 16}px`, fontWeight: element.bold ? 700 : 400, fontStyle: element.italic ? 'italic' : 'normal', textDecoration: element.underline ? 'underline' : 'none', textAlign: element.align || 'left' }}>{element.text}</div> : element.type === 'image' ? <img src={element.dataUrl} alt="Imagem inserida" /> : element.type === 'formText' ? <input className="form-element-input" value={element.formValue || ''} placeholder="Campo de texto" onPointerDown={(event) => event.stopPropagation()} onChange={(event) => onChange({ formValue: event.target.value }, false)} onBlur={() => onChange({}, true)} /> : element.type === 'checkbox' ? <input className="form-element-check" type="checkbox" checked={Boolean(element.checked)} onPointerDown={(event) => event.stopPropagation()} onChange={(event) => onChange({ checked: event.target.checked }, true)} /> : element.type === 'radio' ? <input className="form-element-check" type="radio" checked={Boolean(element.checked)} onPointerDown={(event) => event.stopPropagation()} onChange={() => onChange({ checked: true }, true)} /> : element.type === 'select' ? <select className="form-element-select" value={element.formValue || ''} onPointerDown={(event) => event.stopPropagation()} onChange={(event) => onChange({ formValue: event.target.value }, true)}><option value="">Selecionar</option><option>Opção 1</option><option>Opção 2</option><option>Opção 3</option></select> : element.type === 'signatureField' ? <div className="signature-field-content"><Pencil size={13} /><span>{element.formValue || 'Campo de assinatura digital'}</span></div> : element.type === 'comment' ? <div className="comment-content"><MessageSquare size={13} /><span>{element.comment || 'Comentário'}</span></div> : element.type === 'stamp' ? <div className="stamp-content"><Stamp size={13} /><span>{element.stampText || 'CARIMBO'}</span></div> : null;
  return <div data-element-id={element.id} className={`element-overlay element-${element.type} ${selected ? 'selected' : ''}`} style={{ ...style, borderColor: element.stroke || undefined, background: element.isExistingText ? element.backgroundColor || 'transparent' : element.type === 'highlight' ? element.fill : element.type === 'redaction' ? '#111820' : element.type === 'comment' ? element.fill || '#fff2b8' : element.type === 'stamp' ? '#e7eef5' : undefined }} {...common}>{content}{selected && <><span className="resize-handle nw" /><span className="resize-handle ne" /><span className="resize-handle sw" /><span className="resize-handle se" /></>}</div>;
}

function TextToolbar({ element, onChange }: { element: EditorElement | null; onChange: (patch: Partial<EditorElement>) => void }) {
  return <div className="text-toolbar"><select value={element?.fontFamily || 'Helvetica'} onChange={(event) => onChange({ fontFamily: event.target.value })}><option>Helvetica</option><option>Times</option><option>Courier</option></select><select value={element?.fontSize || 16} onChange={(event) => onChange({ fontSize: Number(event.target.value) })}><option value="10">10</option><option value="12">12</option><option value="14">14</option><option value="16">16</option><option value="18">18</option><option value="24">24</option></select><button className={`icon-button ${element?.bold ? 'active' : ''}`} onClick={() => onChange({ bold: !element?.bold })}><Bold size={15} /></button><button className={`icon-button ${element?.italic ? 'active' : ''}`} onClick={() => onChange({ italic: !element?.italic })}><Italic size={15} /></button><button className={`icon-button ${element?.underline ? 'active' : ''}`} onClick={() => onChange({ underline: !element?.underline })}><Underline size={15} /></button><div className="color-control"><span>A</span><input type="color" value={element?.color || '#1d252d'} onChange={(event) => onChange({ color: event.target.value })} /></div><button className={`icon-button ${element?.align === 'left' || !element?.align ? 'active' : ''}`} onClick={() => onChange({ align: 'left' })}><AlignLeft size={15} /></button><button className={`icon-button ${element?.align === 'center' ? 'active' : ''}`} onClick={() => onChange({ align: 'center' })}><AlignCenter size={15} /></button><button className={`icon-button ${element?.align === 'right' ? 'active' : ''}`} onClick={() => onChange({ align: 'right' })}><AlignRight size={15} /></button></div>;
}

function FormToolbar({ value, onChange }: { value: FormKind; onChange: (value: FormKind) => void }) {
  return <div className="form-toolbar"><button className={`shape-option ${value === 'text' ? 'active' : ''}`} onClick={() => onChange('text')}><Type size={15} /> Texto</button><button className={`shape-option ${value === 'checkbox' ? 'active' : ''}`} onClick={() => onChange('checkbox')}><ListChecks size={15} /> Caixa</button><button className={`shape-option ${value === 'radio' ? 'active' : ''}`} onClick={() => onChange('radio')}><Circle size={15} /> Opção</button><button className={`shape-option ${value === 'select' ? 'active' : ''}`} onClick={() => onChange('select')}><ChevronDown size={15} /> Lista</button></div>;
}

function StampToolbar({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <div className="form-toolbar"><span className="toolbar-context-label">Carimbo</span><select value={value} onChange={(event) => onChange(event.target.value)}><option>APROVADO</option><option>RASCUNHO</option><option>CONFIDENCIAL</option><option>REVISAR</option></select></div>;
}

function LayersPanel({ page, selectedId, onSelect }: { page: EditorPage | undefined; selectedId: string | null; onSelect: (id: string) => void }) {
  if (!page?.elements.length) return <div className="panel-empty"><Layers2 size={18} /><p>Nenhuma camada adicionada nesta página.</p></div>;
  return <div className="layers-list">{[...page.elements].reverse().map((element, index) => <button key={element.id} className={element.id === selectedId ? 'active' : ''} onClick={() => onSelect(element.id)}><span className="layer-index">{String(page.elements.length - index).padStart(2, '0')}</span><span>{element.type === 'formText' ? 'Campo de texto' : element.type === 'signatureField' ? 'Assinatura digital' : element.type === 'comment' ? 'Comentário' : element.type === 'image' ? 'Imagem' : element.type === 'text' ? (element.text || 'Texto') : element.type}</span></button>)}</div>;
}

function ShapeToolbar({ value, onChange }: { value: ShapeKind; onChange: (value: ShapeKind) => void }) {
  return <div className="shape-toolbar"><button className={`shape-option ${value === 'rect' ? 'active' : ''}`} onClick={() => onChange('rect')}><Square size={15} /> Retângulo</button><button className={`shape-option ${value === 'ellipse' ? 'active' : ''}`} onClick={() => onChange('ellipse')}><Circle size={15} /> Círculo</button><button className={`shape-option ${value === 'line' ? 'active' : ''}`} onClick={() => onChange('line')}><LineChart size={15} /> Linha</button><button className="shape-option" onClick={() => { onChange('line'); }}><ArrowRight size={15} /> Seta</button></div>;
}

function PropertiesPanel({ selected, documentMeta, onChange, onDocumentInfoChange, onDelete }: { selected: EditorElement | null; documentMeta: { name: string; size: string; pages: number; attachments: number; comparison: string | null; title: string; author: string; subject: string; created: string; modified: string }; onChange: (patch: Partial<EditorElement>) => void; onDocumentInfoChange: (info: { title: string; author: string; subject: string }) => void; onDelete: () => void }) {
  const numericField = (label: string, key: 'x' | 'y' | 'width' | 'height') => <PropertyField label={label}><input type="number" min="0" max="100" step="1" value={Math.round((selected?.[key] || 0) * 100)} onChange={(event) => onChange({ [key]: Number(event.target.value) / 100 })} /></PropertyField>;
  const [replyDraft, setReplyDraft] = useState('');
  const addReply = () => { if (selected?.type !== 'comment' || !replyDraft.trim()) return; onChange({ replies: [...(selected.replies || []), replyDraft.trim()] }); setReplyDraft(''); };
  const heading = selected?.type === 'text' ? 'Texto' : selected?.type === 'image' ? 'Imagem' : selected?.type === 'comment' ? 'Comentário' : selected?.type === 'stamp' ? 'Carimbo' : selected?.type === 'redaction' ? 'Redação segura' : selected?.type === 'signatureField' ? 'Assinatura digital' : selected && ['formText', 'checkbox', 'radio', 'select'].includes(selected.type) ? 'Campo de formulário' : 'Elemento';
  return <><div className="panel-heading properties-heading"><span>{selected ? heading : 'Propriedades'}</span>{selected && <button className="icon-button tiny" onClick={onDelete}><Trash2 size={14} /></button>}</div>{selected ? <div className="properties-content"><p className="property-kicker">Edição local</p><div className="property-grid">{numericField('Posição X', 'x')}{numericField('Posição Y', 'y')}{numericField('Largura', 'width')}{numericField('Altura', 'height')}</div>{selected.type === 'text' && <><PropertyField label="Fonte"><select value={selected.fontFamily || 'Helvetica'} onChange={(event) => onChange({ fontFamily: event.target.value })}><option>Helvetica</option><option>Times</option><option>Courier</option></select></PropertyField><PropertyField label="Tamanho"><input type="number" value={selected.fontSize || 16} onChange={(event) => onChange({ fontSize: Number(event.target.value) })} /></PropertyField><PropertyField label="Cor"><div className="color-field"><input type="color" value={selected.color || '#1d252d'} onChange={(event) => onChange({ color: event.target.value })} /><span>{selected.color || '#1d252d'}</span></div></PropertyField></>}{selected.type === 'image' && <PropertyField label="Texto alternativo"><input value={selected.altText || ''} placeholder="Descreva a imagem" onChange={(event) => onChange({ altText: event.target.value })} /></PropertyField>}{selected.type === 'formText' && <PropertyField label="Valor"><input value={selected.formValue || ''} onChange={(event) => onChange({ formValue: event.target.value })} /></PropertyField>}{selected.type === 'comment' && <><PropertyField label="Comentário"><textarea value={selected.comment || ''} onChange={(event) => onChange({ comment: event.target.value, text: event.target.value })} /></PropertyField><div className="comment-replies">{(selected.replies || []).map((reply, index) => <div key={index} className="comment-reply">{reply}</div>)}</div><div className="reply-composer"><input value={replyDraft} placeholder="Responder" onChange={(event) => setReplyDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addReply(); }} /><button onClick={addReply}>Responder</button></div></>}{selected.type === 'checkbox' || selected.type === 'radio' ? <PropertyField label="Marcado"><input type="checkbox" checked={Boolean(selected.checked)} onChange={(event) => onChange({ checked: event.target.checked })} /></PropertyField> : null}{selected.type !== 'text' && selected.type !== 'image' && selected.type !== 'formText' && selected.type !== 'checkbox' && selected.type !== 'radio' && selected.type !== 'select' && <PropertyField label="Cor"><div className="color-field"><input type="color" value={selected.stroke || selected.fill || '#315d86'} onChange={(event) => onChange({ stroke: event.target.value, color: event.target.value })} /><span>{selected.stroke || selected.fill || '#315d86'}</span></div></PropertyField>}<PropertyField label="Opacidade"><input type="range" min="0.1" max="1" step="0.05" value={selected.opacity ?? 1} onChange={(event) => onChange({ opacity: Number(event.target.value) })} /></PropertyField></div> : <div className="properties-content document-properties"><p className="property-kicker">Documento atual</p><PropertyRead label="Nome" value={documentMeta.name} /><PropertyRead label="Tamanho" value={documentMeta.size} /><PropertyRead label="Páginas" value={String(documentMeta.pages)} /><PropertyRead label="Anexos" value={String(documentMeta.attachments)} /><PropertyField label="Título"><input value={documentMeta.title} onChange={(event) => onDocumentInfoChange({ title: event.target.value, author: documentMeta.author, subject: documentMeta.subject })} /></PropertyField><PropertyField label="Autor"><input value={documentMeta.author} onChange={(event) => onDocumentInfoChange({ title: documentMeta.title, author: documentMeta.author, subject: documentMeta.subject })} /></PropertyField><PropertyField label="Assunto"><input value={documentMeta.subject} onChange={(event) => onDocumentInfoChange({ title: documentMeta.title, author: documentMeta.author, subject: event.target.value })} /></PropertyField><div className="property-separator" /><p className="property-kicker">Informações</p><p className="property-note">{documentMeta.comparison || 'O arquivo está sendo processado localmente. Nenhum upload automático foi realizado.'}</p><div className="local-status"><Check size={14} /> Privacidade local</div></div>}</>;
}

function PropertyField({ label, children }: { label: string; children: React.ReactNode }) { return <label className="property-field"><span>{label}</span>{children}</label>; }
function PropertyRead({ label, value }: { label: string; value: string }) { return <div className="property-read"><span>{label}</span><strong title={value}>{value}</strong></div>; }

export default App;
