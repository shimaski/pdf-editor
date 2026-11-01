export type IntegrationCapabilities = {
  remoteSigning: boolean;
  office: boolean;
  cad: boolean;
};

const remoteSigningUrl = import.meta.env.VITE_SIGNING_PROVIDER_URL as string | undefined;
const officeUrl = import.meta.env.VITE_OFFICE_CONNECTOR_URL as string | undefined;
const cadUrl = import.meta.env.VITE_CAD_CONNECTOR_URL as string | undefined;

export const integrationCapabilities: IntegrationCapabilities = {
  remoteSigning: Boolean(remoteSigningUrl),
  office: Boolean(officeUrl),
  cad: Boolean(cadUrl),
};

export function integrationStatusLabel(capability: keyof IntegrationCapabilities) {
  return integrationCapabilities[capability] ? 'Conector configurado' : 'Requer conector';
}

export function integrationConfigurationMessage(capability: keyof IntegrationCapabilities) {
  if (integrationCapabilities[capability]) return 'O conector está configurado para este ambiente.';
  if (capability === 'remoteSigning') return 'Configure VITE_SIGNING_PROVIDER_URL para usar uma autoridade certificadora ou serviço de assinatura remota.';
  if (capability === 'office') return 'Configure VITE_OFFICE_CONNECTOR_URL para importar e converter arquivos Office.';
  return 'Configure VITE_CAD_CONNECTOR_URL para converter arquivos DWG/DXF com um serviço CAD autorizado.';
}

export async function requestRemoteSignature(input: { documentId: string; fieldName: string; digest: string; returnUrl?: string }) {
  if (!remoteSigningUrl) throw new Error(integrationConfigurationMessage('remoteSigning'));
  if (!supabase) throw new Error('Configure o Supabase para usar a assinatura remota com segurança.');
  const result = await supabase.functions.invoke('request-signature', { body: input });
  if (result.error) throw result.error;
  return result.data as { status: 'pending' | 'signed'; signingUrl?: string; signedPdfUrl?: string; requestId: string };
}

export async function convertDocumentToPdf(file: File, kind: 'office' | 'cad') {
  const endpoint = kind === 'office' ? officeUrl : cadUrl;
  if (!endpoint) throw new Error(integrationConfigurationMessage(kind));
  if (!supabase) throw new Error('Configure o Supabase para usar conversores externos com segurança.');
  const body = new FormData();
  body.append('file', file, file.name);
  body.append('sourceFormat', kind);
  const result = await supabase.functions.invoke('convert-document', { body });
  if (result.error) throw result.error;
  if (result.data instanceof Blob) return result.data;
  if (result.data instanceof ArrayBuffer) return new Blob([result.data], { type: 'application/pdf' });
  throw new Error('O conversor não devolveu um PDF.');
}
import { supabase } from './supabase';
