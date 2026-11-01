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
    const providerUrl = Deno.env.get('SIGNING_PROVIDER_URL');
    const providerToken = Deno.env.get('SIGNING_PROVIDER_TOKEN');
    if (!providerUrl || !providerToken) return json({ error: 'Provedor de assinatura não configurado.' }, 503);
    const payload = await request.json();
    const response = await fetch(providerUrl, { method: 'POST', headers: { authorization: `Bearer ${providerToken}`, 'content-type': 'application/json', 'x-pdf-editor-user': data.user.id }, body: JSON.stringify(payload) });
    const text = await response.text();
    return new Response(text, { status: response.status, headers: { ...cors, 'content-type': response.headers.get('content-type') || 'application/json' } });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Falha ao criar solicitação de assinatura.' }, 500);
  }
});
