# PDF Editor

Editor de PDF para navegador, com processamento local por padrão. Os arquivos só são enviados a um serviço quando a pessoa aciona explicitamente uma integração configurada.

## Executar localmente

Requer Node.js 20 ou superior.

```bash
npm ci
npm run dev
```

## Verificar e compilar

```bash
npm run build
npm run test:pdf
```

## Publicação no GitHub Pages

O workflow em `.github/workflows/deploy-pages.yml` compila o aplicativo e publica `dist/` no GitHub Pages quando há um push para `main`. O endereço esperado é:

`https://shimaski.github.io/pdf-editor/`

Na primeira publicação, habilite GitHub Pages nas configurações do repositório e selecione **GitHub Actions** como origem de build/deploy.

## Supabase opcional

Para autenticação e sincronização, configure `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` no ambiente de build. Use apenas a chave pública/anon no frontend; nunca adicione service-role keys, certificados privados ou credenciais ao repositório.

Sem essa configuração, as operações locais do editor continuam disponíveis. PDFs não são enviados automaticamente.
