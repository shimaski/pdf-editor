import { PDFDocument } from 'pdf-lib';

type WorkerRequest = { id: number; bytes: ArrayBuffer };
type WorkerResponse = { id: number; bytes?: ArrayBuffer; error?: string };

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, bytes } = event.data;
  try {
    const document = await PDFDocument.load(bytes);
    const output = await document.save({ useObjectStreams: true, addDefaultPage: false });
    const result = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
    const response: WorkerResponse = { id, bytes: result };
    (self as unknown as Worker).postMessage(response, [result]);
  } catch (error) {
    const response: WorkerResponse = { id, error: error instanceof Error ? error.message : 'Falha ao otimizar o PDF.' };
    (self as unknown as Worker).postMessage(response);
  }
};
