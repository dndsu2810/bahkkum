-- 앱 설정 저장 테이블 (관리자 메뉴/화폐 설정을 DB에 저장)
CREATE TABLE IF NOT EXISTS app_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
