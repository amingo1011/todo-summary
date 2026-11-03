// Supabase 連線設定
// 這把是「公開金鑰」(publishable key),本來就設計給網頁使用,可以放上 GitHub。
// 資料安全由「登入」加上資料庫的 RLS 規則保護。
// 絕對不要把 service_role / secret 金鑰放進這個檔案。
window.TODO_CONFIG = {
  supabaseUrl: 'https://tsomhvrmheinhmfehibm.supabase.co',
  supabaseKey: 'sb_publishable_QEcRdWSBaf1t-kcUcGq12w_9-EtZDFL',
};
