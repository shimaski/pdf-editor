# Implantação e hardening

## Frontend

- Servir somente por HTTPS em produção.
- Manter a política CSP de `index.html`; se o domínio do Supabase for diferente, adicionar apenas esse domínio em `connect-src`.
- Não colocar `VITE_SUPABASE_SERVICE_ROLE_KEY`, chaves privadas, certificados A1 ou credenciais de AutoCAD no frontend.
- Configurar limites de upload no proxy e manter o limite local de 200 MB/5.000 páginas.

## Supabase

- Usar somente a chave anônima no navegador.
- Ativar RLS para `documents`, `document_versions`, `document_operations`, `files`, `signing_profiles` e `signing_events`.
- Edge Functions devem validar JWT, tamanho, MIME real, quota e proprietário do documento antes de armazenar ou converter.
- Registrar somente metadados de auditoria; o PDF não deve ser enviado automaticamente.

## Conectores

`VITE_OFFICE_CONNECTOR_URL`, `VITE_CAD_CONNECTOR_URL` e `VITE_SIGNING_PROVIDER_URL` devem apontar para serviços isolados, com timeout, limite de memória, antivirus e limpeza de arquivos temporários. O frontend só envia o arquivo quando o usuário aciona a ação correspondente.

## Observabilidade

Registrar duração, tamanho do arquivo, quantidade de páginas, tipo de operação e resultado. Não registrar conteúdo do PDF, senhas, tokens, dados de formulário ou certificados.
