import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const authorization = request.headers.get('authorization');
    if (!authorization) return json({ error: 'Autenticação necessária.' }, 401);
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { authorization } } });
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return json({ error: 'Sessão inválida.' }, 401);
    const input = await request.formData();
    const sourceFormat = String(input.get('sourceFormat') || '');
    const file = input.get('file');
    if (!(file instanceof File) || !['office', 'cad'].includes(sourceFormat)) return json({ error: 'Arquivo ou formato inválido.' }, 400);
    const providerUrl = sourceFormat === 'office' ? Deno.env.get('OFFICE_CONNECTOR_URL') : Deno.env.get('CAD_CONNECTOR_URL');
    const providerToken = Deno.env.get(sourceFormat === 'office' ? 'OFFICE_CONNECTOR_TOKEN' : 'CAD_CONNECTOR_TOKEN');
    if (!providerUrl || !providerToken) return json({ error: 'Conector de conversão não configurado.' }, 503);
    const providerBody = new FormData();
    providerBody.append('file', file, file.name);
    providerBody.append('sourceFormat', sourceFormat);
    const response = await fetch(providerUrl, { method: 'POST', headers: { authorization: `Bearer ${providerToken}`, 'x-pdf-editor-user': data.user.id }, body: providerBody });
    if (!response.ok) return new Response(await response.text(), { status: response.status, headers: { ...cors, 'content-type': response.headers.get('content-type') || 'application/json' } });
    return new Response(await response.arrayBuffer(), { status: 200, headers: { ...cors, 'content-type': 'application/pdf', 'content-disposition': 'inline' } });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Falha ao converter o documento.' }, 500);
  }
});
