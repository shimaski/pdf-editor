# PDF Editor: matriz de funcionalidades

Esta matriz foi derivada somente da leitura das tabelas do instalador local em `D:\acrobatt\Adobe Acrobat 8 Professional\AcroPro.msi`. Nenhum executável ou instalador foi executado e nenhum código, recurso visual ou asset proprietário foi copiado.

## Capacidades identificadas

| Área | Evidência no instalador | Direção para o PDF Editor |
| --- | --- | --- |
| Visualização | AcrobatViewer, SinglePage, OneColumn, TwoPages, FitPage, FitWidth | Canvas PDF.js, miniaturas, zoom, ajuste de página e largura |
| Busca | SearchAndIndex, Find, FindSearch | Busca local por texto original e editado, navegação de resultados, substituição e filtros de maiúsculas/palavra inteira |
| OCR | PaperCapture | OCR local sob demanda com progresso e inserção dos blocos reconhecidos |
| Formulários | FormsDesigner, ShowHideFields | Detecção de widgets existentes, campos de texto, checkbox, grupos de rádio e lista com exportação AcroForm |
| Anotações | ShowHideAnnotManager, commenting toolbar | Comentários locais editáveis, respostas, destaques, sublinhado, tachado e carimbos exportados visualmente |
| Assinaturas | ShowHideSignatures, assinatura digital | Assinatura desenhada local e assinatura PKCS#7/CMS de campos Sig com certificado autoassinado; certificados confiáveis e múltiplas assinaturas ficam separados |
| Páginas | InsertPages, ExtractPages, ReplacePages, DeletePages, RotatePages, CropPages | Inserir antes/depois, inserir e substituir a partir de outro PDF, extrair, excluir, duplicar, girar, seleção múltipla, reordenar por arraste e recortar |
| Arquivos | AddFileAttachment, Portfolio | Anexos embutidos e exportação de um portfólio PDF local com índice |
| Produção | PreFlightPlugin, Distiller, PDFSettings | Verificação local da saída, preservação de páginas e indicação de páginas rasterizadas para redação |
| Lote | BatchSequences | Separação do documento, mesclagem local e extração de texto em lote para vários PDFs |
| Integrações | PDFMaker para Office, Visio, Project, Outlook, IE e AutoCAD | Fora do núcleo web; substituir por importação e exportação local de arquivos |
| Segurança | proteção, permissões e assinatura certificada | Abertura e exportação local com senha AES-256 e permissões; redação rasterizada segura; certificados seguem separados |

## Implementações recentes

- Exportação agora passa por uma etapa de validação do número de páginas e trata falhas sem deixar o estado preso em “Salvando...”.
- Inserção e substituição de páginas incorporam um PDF escolhido pelo usuário à versão local exportável atual.
- Respostas de comentários e carimbos são mantidos no modelo e incluídos na exportação.
- A integração Supabase está preparada com cliente opcional, autenticação explícita e envio manual da versão atual; sem variáveis de ambiente, nenhum upload é feito.
- Proteção de PDF usa `@cantoo/pdf-lib` com senha de usuário/dono, permissões explícitas e diálogo de senha dentro do editor; nenhuma senha é enviada ao servidor.
- Campos de assinatura digital existentes são identificados e exportados como campos Sig. O comando contextual “Assinar digitalmente” gera PKCS#7/CMS detached localmente com certificado autoassinado; leitores podem validar a integridade, mas exibem aviso de identidade não verificada. A assinatura desenhada continua sendo uma marca visual.
- Portfólio local com anexos embutidos e página-índice, além do comando “Verificar saída” para validar a quantidade de páginas antes de exportar.
- Opções criadas pelo editor são exportadas como `PDFRadioGroup` real, com opções mutuamente exclusivas e valor selecionável.
- Processamento em lote validado no navegador: dois PDFs selecionados geram TXT individuais e uma confirmação única do lote, sem upload.
- Colaboração em tempo real preparada com Broadcast/Presence: alterações do modelo local são registradas como operações versionadas e transmitidas apenas depois de uma sincronização explícita do documento.
- Assinatura confiável preparada por adaptador remoto: o navegador envia somente o digest e a referência do campo ao provedor configurado; chaves privadas e certificados permanecem no serviço de assinatura.
- Integrações Office e CAD ficam atrás de conectores configuráveis (`VITE_OFFICE_CONNECTOR_URL` e `VITE_CAD_CONNECTOR_URL`), mantendo a edição PDF local quando os conectores não existem.
- As chamadas externas passam pelas Edge Functions `request-signature` e `convert-document`; tokens de provedores devem existir apenas nos segredos do projeto Supabase.

## Limites que permanecem deliberadamente explícitos

- A assinatura local autoassinada agora preserva revisões incrementais e permite assinar campos sequenciais sem reconstruir o PDF anterior. Assinaturas com certificados de CA, carimbo TSA e LTV continuam dependendo de um provedor que suporte PAdES; o editor não recria silenciosamente um PDF já assinado.
- A colaboração utiliza operações do modelo do editor, não bytes inteiros do PDF. O esquema Supabase precisa ser aplicado e o canal Realtime precisa estar autorizado por RLS antes de ser usado em produção.
- As Edge Functions são adaptadores de contrato: ainda é necessário apontá-las para um provedor de CA/assinatura e para conversores Office/CAD compatíveis com o formato de resposta PDF.
- Inserção de página antes e depois validada no navegador, com contagem observável de 2 para 3 e depois 4 páginas.
- Busca avançada validada no navegador: os filtros `Aa` e `Ab` ficam ativos e a navegação retorna resultados numerados.
- Edição direta de texto recebe foco no primeiro clique e as mudanças de seleção, propriedades e arraste entram no histórico de undo/redo como operações reversíveis.

## Ordem de implementação

1. Busca, visualização e operações de página confiáveis.
2. Texto selecionável, formulários AcroForm e anotações interoperáveis.
3. OCR local em worker, substituição de texto, redaction rasterizada e marcadores.
4. Pré-impressão, presets, proteção e assinatura criptográfica.
5. Processamento em lote e integrações opcionais via backend ou conectores.

O princípio permanece local-first: o arquivo só deve sair do navegador quando o usuário pedir uma operação que realmente dependa de servidor.
