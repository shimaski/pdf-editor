# Assinatura digital confiável A1/A3

O editor mantém duas rotas distintas:

- **Assinatura local desenhada:** serve como marca visual e não é uma assinatura ICP-Brasil.
- **Assinatura confiável:** o navegador calcula/entrega o pedido ao provedor configurado em `VITE_SIGNING_PROVIDER_URL`; o provedor devolve o PDF assinado ou uma URL de conclusão.

## A1

O certificado A1 (`.p12`/`.pfx`) deve ficar em um cofre ou em um agente de assinatura controlado pelo provedor. O arquivo não deve ser enviado automaticamente pelo navegador nem armazenado no Supabase sem consentimento explícito. O Edge Function deve validar a identidade, aplicar a assinatura CMS/PAdES no digest recebido e registrar `requestId`, certificado e cadeia usada em `signing_events`.

## A3

O certificado A3 depende de token, cartão ou middleware local. O browser não consegue acessar esse hardware de forma universal. O fluxo recomendado é um agente local/desktop autorizado ou um provedor remoto compatível com o middleware, que assina o digest e retorna o PDF final.

## Critério de validade

O PDF só deve ser apresentado como “assinado” depois de validar a cadeia, o período de validade, o uso de chave, a integridade do digest e o status de revogação (OCSP/CRL) no serviço de confiança. Sem esse conector, a interface deve dizer explicitamente que a assinatura confiável não está configurada.
