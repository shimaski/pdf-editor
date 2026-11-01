let worker: Worker | null = null;
let sequence = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<number, { resolve: (bytes: ArrayBuffer) => void; reject: (error: Error) => void }>();

function getWorker() {
  if (worker) return worker;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<{ id: number; bytes?: ArrayBuffer; error?: string }>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (event.data.bytes) request.resolve(event.data.bytes);
    else request.reject(new Error(event.data.error || 'Falha ao processar o PDF.'));
    if (!pending.size) {
      idleTimer = setTimeout(() => {
        if (!pending.size) { worker?.terminate(); worker = null; idleTimer = null; }
      }, 30000);
    }
  };
  worker.onerror = () => {
    for (const request of pending.values()) request.reject(new Error('O worker de PDF foi interrompido.'));
    pending.clear();
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function optimizePdfInWorker(bytes: ArrayBuffer) {
  const id = ++sequence;
  return new Promise<ArrayBuffer>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const copy = bytes.slice(0);
    getWorker().postMessage({ id, bytes: copy }, [copy]);
  });
}

export function disposePdfWorker() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  for (const request of pending.values()) request.reject(new Error('O worker de PDF foi encerrado.'));
  pending.clear();
  worker?.terminate();
  worker = null;
}
