import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigured = Boolean(url && anonKey);
export const supabase: SupabaseClient | null = supabaseConfigured && url && anonKey ? createClient(url, anonKey) : null;

export function cloudConfigurationMessage() {
  return 'Sincronização opcional: configure VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY para ativar a conta.';
}
