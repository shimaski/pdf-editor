# PDF Editor - checklist de beta

## Abertura e navegação

- [ ] Abrir PDF comum, escaneado, protegido e com muitas páginas.
- [ ] Arrastar um PDF para a janela.
- [ ] Navegar por miniaturas, marcadores, busca e rolagem contínua.
- [ ] Confirmar que a memória não cresce indefinidamente ao alternar páginas.

## Edição

- [ ] Clicar duas vezes em texto existente e editar.
- [ ] Editar textos com fontes serifadas, monoespaçadas, negrito e itálico.
- [ ] Inserir texto, imagem, desenho, forma e comentário.
- [ ] Selecionar múltiplos elementos e alinhar.
- [ ] Desfazer e refazer depois de mover, redimensionar e excluir.

## Documento

- [ ] Inserir, excluir, duplicar, girar e reordenar páginas.
- [ ] Mesclar, dividir, extrair e substituir páginas.
- [ ] Preencher campos de formulário e preservar widgets.
- [ ] Executar OCR em uma página escaneada.
- [ ] Aplicar redação e confirmar que o texto original não pode ser pesquisado.
- [ ] Inserir assinatura e validar a exportação.

## Exportação

- [ ] Exportar sem alterações.
- [ ] Exportar com texto e imagens adicionados.
- [ ] Exportar documento protegido por senha.
- [ ] Reabrir o PDF exportado no editor e em um visualizador externo.
- [ ] Executar “Verificar saída” antes da entrega.

## Acessibilidade e estabilidade

- [ ] Completar o fluxo principal apenas com teclado.
- [ ] Confirmar foco visível em menus, diálogos e ferramentas.
- [ ] Testar em 1280x720, 1366x768, 1440x900 e 1920x1080.
- [ ] Interromper OCR/exportação e confirmar que a interface continua responsiva.
- [ ] Fechar e reabrir o navegador para testar a recuperação local.
- [ ] Executar Preflight de produção e corrigir erros antes de exportar.
- [ ] Executar Auditoria de acessibilidade e preencher texto alternativo das imagens.
- [ ] Abrir um PDF com JavaScript e confirmar que o script é apenas sinalizado, nunca executado automaticamente.
- [ ] Rodar `npm run test:pdf:scale` e registrar o pico RSS para a máquina-alvo.
- [ ] Simular conflito colaborativo e testar merge por elemento, versão local e versão remota.
