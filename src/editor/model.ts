export type Tool = 'select' | 'text' | 'image' | 'draw' | 'shape' | 'highlight' | 'underline' | 'strike' | 'comment' | 'stamp' | 'form' | 'redact' | 'crop' | 'signature';
export type ElementType = 'text' | 'image' | 'draw' | 'rect' | 'ellipse' | 'line' | 'highlight' | 'underline' | 'strike' | 'comment' | 'stamp' | 'redaction' | 'formText' | 'checkbox' | 'radio' | 'select' | 'signatureField';
export type ShapeKind = 'rect' | 'ellipse' | 'line';
export type FormKind = 'text' | 'checkbox' | 'radio' | 'select';

export type EditorElement = {
  id: string;
  type: ElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  color?: string;
  fill?: string;
  stroke?: string;
  fontSize?: number;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: 'left' | 'center' | 'right';
  opacity?: number;
  dataUrl?: string;
  altText?: string;
  sourceTextId?: string;
  originalText?: string;
  isExistingText?: boolean;
  backgroundColor?: string;
  originalX?: number;
  originalY?: number;
  originalWidth?: number;
  originalHeight?: number;
  deleted?: boolean;
  formName?: string;
  formValue?: string;
  checked?: boolean;
  comment?: string;
  replies?: string[];
  stampText?: string;
  author?: string;
};

export type EditorPage = {
  id: string;
  sourcePage: number | null;
  rotation: number;
  elements: EditorElement[];
  label?: string;
  crop?: { x: number; y: number; width: number; height: number };
};

export const uid = () => Math.random().toString(36).slice(2, 9);

export function hexToRgb(hex: string) {
  const value = hex.replace('#', '');
  return {
    r: parseInt(value.slice(0, 2), 16) / 255,
    g: parseInt(value.slice(2, 4), 16) / 255,
    b: parseInt(value.slice(4, 6), 16) / 255,
  };
}

export function clonePage(page: EditorPage): EditorPage {
  return { ...page, elements: page.elements.map((element) => ({ ...element })) };
}

export function clonePages(pages: EditorPage[]): EditorPage[] {
  return pages.map(clonePage);
}
