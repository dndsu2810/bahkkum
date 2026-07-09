-- Migration 0009: 수학 전광판(수학야구) — 쏘이지 점수 표시 전용
-- 점수 계산·저장은 쏘이지가 하고, 키오스크(띵똥)는 읽어서 보여주기만 한다.
-- (코드에도 CREATE TABLE IF NOT EXISTS + ALTER ADD COLUMN 안전장치가 있어 마이그레이션 없이도 동작함)

CREATE TABLE IF NOT EXISTS math_board (
  student_name   TEXT PRIMARY KEY,            -- 학생 이름 (쏘이지/키오스크 매칭 키)
  strike         INTEGER NOT NULL DEFAULT 0,  -- 스트라이크 S 0~3 (3 → 아웃)
  ball           INTEGER NOT NULL DEFAULT 0,  -- 볼 B 0~4 (4 → 아웃 1 삭제)
  out_count      INTEGER NOT NULL DEFAULT 0,  -- 아웃 O 0~3 (3 → 보충 + 회차+1)
  goal           TEXT    NOT NULL DEFAULT '', -- 다음 목표 한 줄 (비우면 규칙으로 자동)
  supplement     INTEGER NOT NULL DEFAULT 0,  -- (구) 보충 여부 — pending_makeup 과 동일 의미
  class_label    TEXT    NOT NULL DEFAULT '', -- 예: "수학 화·목 7시반"
  records_json   TEXT    NOT NULL DEFAULT '[]', -- 최근 기록(recent) [{date,tone,label,delta,round}]
  active         INTEGER NOT NULL DEFAULT 1,  -- 0이면 칩 숨김(수학 안 듣는 학생)
  updated_at     TEXT    DEFAULT CURRENT_TIMESTAMP,
  -- 연동요청서(수학야구 board) 추가 필드 ──────────────────────────────
  student_id     TEXT    NOT NULL DEFAULT '', -- 띵똥 students.id (= 쏘이지 로스터ID, 공유)
  penalty_rounds INTEGER NOT NULL DEFAULT 0,  -- 누적 보충 횟수 (현재 회차 = penalty_rounds + 1)
  pending_makeup INTEGER NOT NULL DEFAULT 0,  -- 지금 보충 대상인지
  honey          INTEGER NOT NULL DEFAULT 0,  -- 볼4 → 꿀 전환 누적
  status         TEXT    NOT NULL DEFAULT '', -- clean | good | warn | makeup
  month_label    TEXT    NOT NULL DEFAULT '', -- "2026-06"
  history_json   TEXT    NOT NULL DEFAULT '[]', -- 전체 기록(최대 120) [{date,tone,label,delta,round}]
  photo          TEXT    NOT NULL DEFAULT ''  -- 학생 사진 URL
);

-- 진단 로그 (쏘이지가 보낸 요청 추적용, 최근 50건만 코드에서 유지)
CREATE TABLE IF NOT EXISTS math_board_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT DEFAULT CURRENT_TIMESTAMP,
  status INTEGER,
  auth   INTEGER,
  name   TEXT,
  note   TEXT,
  body   TEXT
);
