declare module 'js-pdf-signer' {
  type SignatureField = { acroField: { dict: unknown } };
  export function addSignaturePlaceholder(options: { pdfLib: unknown; pdfDocLib: unknown; field: SignatureField; placeholderHexLen?: number }): void;
  export function signPdfBytes(pdfBytes: Uint8Array): Promise<Uint8Array>;
}

declare module 'js-pdf-signer/src/index.js' {
  type SignatureField = { acroField: { dict: unknown } };
  export function addSignaturePlaceholder(options: { pdfLib: unknown; pdfDocLib: unknown; field: SignatureField; placeholderHexLen?: number }): void;
  export function signPdfBytes(pdfBytes: Uint8Array): Promise<Uint8Array>;
  export function getOrCreateSigner(): Promise<{ cert: unknown; privateKey: CryptoKey }>;
  export function buildCmsSignature(cert: unknown, privateKey: CryptoKey, digestBytes: Uint8Array, signingTime: Date): Promise<Uint8Array>;
}
