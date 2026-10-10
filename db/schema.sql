-- 文癖：みんなのキャラ用のテーブル（最初に1回だけ実行）

-- 登録されたキャラ。元の文章は保存しない。保存するのはキャラコードだけ。
CREATE TABLE IF NOT EXISTS beasts (
  id          TEXT PRIMARY KEY,           -- ランダムなID
  no          TEXT NOT NULL,              -- キャラ番号（同じ文章からは同じ番号。二重登録を防ぐ）
  code        TEXT NOT NULL,              -- キャラコード（名前・正体・技・ステータス・見た目）
  name        TEXT NOT NULL,              -- 管理画面で見やすいように名前だけ別に保存
  ip_hash     TEXT NOT NULL,              -- 登録数の制限用。IPそのものではなくハッシュ
  delete_hash TEXT NOT NULL,              -- 本人が取り消すときの合言葉のハッシュ
  reports     INTEGER NOT NULL DEFAULT 0, -- 通報された数
  hidden      INTEGER NOT NULL DEFAULT 0, -- 1なら非表示
  bk          INTEGER NOT NULL DEFAULT 0, -- 1ならボス級
  wins        INTEGER NOT NULL DEFAULT 0, -- ほかの人に挑まれて勝った数（通算）
  losses      INTEGER NOT NULL DEFAULT 0, -- ほかの人に挑まれて負けた数（通算）
  created_at  INTEGER NOT NULL            -- 登録日時（ミリ秒）
);
CREATE UNIQUE INDEX IF NOT EXISTS beasts_no ON beasts (no);
CREATE INDEX IF NOT EXISTS beasts_ip ON beasts (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS beasts_hidden ON beasts (hidden);

-- 通報。同じ人が同じキャラを何度も通報しても1件として数える。
CREATE TABLE IF NOT EXISTS reports (
  beast_id   TEXT NOT NULL,
  ip_hash    TEXT NOT NULL,
  reason     TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (beast_id, ip_hash)
);
CREATE INDEX IF NOT EXISTS reports_ip ON reports (ip_hash, created_at);

-- 対戦の記録（「昨日のボス」を決めるため）。同じ人が同じキャラと戦った結果は1日1件だけ数える。
CREATE TABLE IF NOT EXISTS battles (
  beast_id   TEXT NOT NULL,
  ip_hash    TEXT NOT NULL,
  day        TEXT NOT NULL,              -- 日本時間の日付 YYYY-MM-DD
  won        INTEGER NOT NULL,           -- 1ならキャラの勝ち
  created_at INTEGER NOT NULL,
  PRIMARY KEY (beast_id, ip_hash, day)
);
CREATE INDEX IF NOT EXISTS battles_day ON battles (day, beast_id);
CREATE INDEX IF NOT EXISTS battles_ip ON battles (ip_hash, day);

-- 短い対戦リンク（?b=ID）。キャラコードだけを保存する。ランダム対戦には出ない。
CREATE TABLE IF NOT EXISTS links (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  name       TEXT NOT NULL,              -- 管理用（サイトのプレビュー表示にも使う）
  ip_hash    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS links_hash ON links (code_hash);
CREATE INDEX IF NOT EXISTS links_ip ON links (ip_hash, created_at);
