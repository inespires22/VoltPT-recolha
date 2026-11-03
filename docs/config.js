// VoltPT — ligação ao Supabase.
// A chave pública (publishable/anon) pode estar aqui: sozinha não lê nada.
// Os dados só aparecem depois do login, para os e-mails autorizados no sql/06_app.sql.
window.VOLTPT_CONFIG = {
  supabaseUrl: "https://lpsrmhiwihzhprtoowwr.supabase.co",
  supabaseKey: "COLA_AQUI_A_CHAVE_PUBLICA",   // Supabase -> Project Settings -> API Keys -> Publishable key
};
