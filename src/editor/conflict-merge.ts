import type { EditorElement, EditorPage } from './model';

export type MergeConflict = {
  pageId: string;
  elementId?: string;
  field: string;
};

export type MergeResult = {
  pages: EditorPage[];
  conflicts: MergeConflict[];
};

function equal(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeField<T>(base: T, local: T, remote: T, field: string, pageId: string, elementId: string | undefined, conflicts: MergeConflict[]) {
  if (equal(local, base)) return remote;
  if (equal(remote, base) || equal(local, remote)) return local;
  conflicts.push({ pageId, elementId, field });
  return local;
}

function mergeElement(base: EditorElement | undefined, local: EditorElement, remote: EditorElement, conflicts: MergeConflict[]) {
  const merged = { ...local } as EditorElement;
  const fields = new Set([...Object.keys(base || {}), ...Object.keys(local), ...Object.keys(remote)]);
  for (const field of fields) {
    if (field === 'id') continue;
    (merged as unknown as Record<string, unknown>)[field] = mergeField(
      base ? (base as unknown as Record<string, unknown>)[field] : undefined,
      (local as unknown as Record<string, unknown>)[field],
      (remote as unknown as Record<string, unknown>)[field],
      field,
      '',
      local.id,
      conflicts,
    );
  }
  return merged;
}

function mergePage(base: EditorPage | undefined, local: EditorPage, remote: EditorPage, conflicts: MergeConflict[]) {
  const page = { ...local, elements: [] } as EditorPage;
  const pageFields = new Set([...Object.keys(base || {}), ...Object.keys(local), ...Object.keys(remote)]);
  for (const field of pageFields) {
    if (field === 'id' || field === 'elements') continue;
    (page as unknown as Record<string, unknown>)[field] = mergeField(
      base ? (base as unknown as Record<string, unknown>)[field] : undefined,
      (local as unknown as Record<string, unknown>)[field],
      (remote as unknown as Record<string, unknown>)[field],
      field,
      local.id,
      undefined,
      conflicts,
    );
  }
  const baseElements = new Map((base?.elements || []).map((element) => [element.id, element]));
  const localElements = new Map(local.elements.map((element) => [element.id, element]));
  const remoteElements = new Map(remote.elements.map((element) => [element.id, element]));
  const ids = [...new Set([...local.elements.map((element) => element.id), ...remote.elements.map((element) => element.id)])];
  page.elements = ids.flatMap((id) => {
    const localElement = localElements.get(id);
    const remoteElement = remoteElements.get(id);
    const baseElement = baseElements.get(id);
    if (localElement && remoteElement) return [mergeElement(baseElement, localElement, remoteElement, conflicts)];
    if (localElement && !remoteElement) return baseElement && equal(localElement, baseElement) ? [] : [localElement];
    if (remoteElement && !localElement) return baseElement && equal(remoteElement, baseElement) ? [] : [remoteElement];
    return [];
  });
  for (const conflict of conflicts) if (conflict.pageId === '') conflict.pageId = local.id;
  return page;
}

export function mergeEditorPages(base: EditorPage[], local: EditorPage[], remote: EditorPage[]): MergeResult {
  const conflicts: MergeConflict[] = [];
  const baseMap = new Map(base.map((page) => [page.id, page]));
  const localMap = new Map(local.map((page) => [page.id, page]));
  const remoteMap = new Map(remote.map((page) => [page.id, page]));
  const orderedIds = [...new Set([...local.map((page) => page.id), ...remote.map((page) => page.id)])];
  const pages = orderedIds.flatMap((id) => {
    const localPage = localMap.get(id);
    const remotePage = remoteMap.get(id);
    const basePage = baseMap.get(id);
    if (localPage && remotePage) {
      if (equal(localPage, basePage)) return [remotePage];
      if (equal(remotePage, basePage)) return [localPage];
      return [mergePage(basePage, localPage, remotePage, conflicts)];
    }
    if (localPage && !remotePage) return basePage && equal(localPage, basePage) ? [] : [localPage];
    if (remotePage && !localPage) return basePage && equal(remotePage, basePage) ? [] : [remotePage];
    return [];
  });
  return { pages, conflicts };
}
