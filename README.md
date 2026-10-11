# NAKATA ATARU

nakata-ataru.com の静的サイト。Cloudflare Workers (static assets) で配信。

- /hitorigoto/ ひとりごとの周波数（紹介）、/hitorigoto/play/ ゲーム本体
- /linguist/ ファーストコンタクト・リンギスト（紹介）
- /wip/* 開発中タイトル

- /bunpeki/ 文癖（ブンペキ）。ランダム対戦などのAPI（/api/buntai/*）は worker/、データベース（Cloudflare D1）の定義は db/schema.sql
  - worker/ と db/ は公開されない（.assetsignore）
  - 必要な設定：D1 を作って wrangler.jsonc の database_id に貼る／Worker のシークレット IP_SALT を設定する
  - 運営用のSQLや調整できる値は worker/buntai-api.js の先頭を参照
