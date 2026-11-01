# Integrações de produção

## Office

O navegador não é um conversor DOCX/XLSX/PPTX completo. O editor usa `VITE_OFFICE_CONNECTOR_URL` e a Edge Function `convert-document` para enviar explicitamente o arquivo escolhido, receber um PDF e só então importá-lo localmente.

O conector de produção deve executar LibreOffice headless ou um serviço Office compatível em ambiente isolado, definir limites de CPU/memória, remover macros por padrão, rejeitar caminhos externos e devolver `application/pdf` com status e metadados.

## AutoCAD

DWG é um formato proprietário e exige ODA/AutoCAD ou outro conversor licenciado. O editor já separa a rota `VITE_CAD_CONNECTOR_URL`; o backend deve converter em ambiente isolado, validar referências externas/XRefs, fontes e unidades, e devolver PDF com o perfil de plotagem informado.

## Compatibilidade PDF

Não existe uma garantia universal para PDFs que dependem de fontes proprietárias, JavaScript, criptografia ou extensões de um visualizador específico. O preflight identifica JavaScript e inconsistências estruturais, PDF.js usa CMaps locais e a exportação preserva o arquivo original sempre que a operação não exige rasterização.

## JavaScript PDF

Scripts embutidos são detectados, mas não executados automaticamente. Para oferecer automações compatíveis no futuro, a execução deve ocorrer em sandbox sem acesso ao DOM, rede, cookies, arquivos ou APIs de sistema, com lista de APIs PDF explicitamente permitidas e confirmação do usuário.
