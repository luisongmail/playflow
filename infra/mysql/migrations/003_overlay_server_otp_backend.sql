-- 003_overlay_server_otp_backend.sql
-- Scaffolding inicial del Overlay Server + backend OTP

ALTER TABLE otp_challenges
  ADD COLUMN email VARCHAR(255) NULL AFTER user_id,
  ADD COLUMN code_hash CHAR(64) NULL AFTER email,
  ADD COLUMN consumed_at DATETIME(3) NULL AFTER expires_at;

SET @drop_code_statement = (
  SELECT IF(
    COUNT(*) > 0,
    'ALTER TABLE otp_challenges DROP COLUMN code',
    'SELECT 1'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'otp_challenges'
    AND column_name = 'code'
);

PREPARE drop_code_statement FROM @drop_code_statement;
EXECUTE drop_code_statement;
DEALLOCATE PREPARE drop_code_statement;

CREATE INDEX idx_otp_email_status ON otp_challenges (email, status);

CREATE TABLE IF NOT EXISTS user_sessions (
  session_id VARCHAR(50) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  jwt TEXT NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_user_sessions_user (user_id),
  INDEX idx_user_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
