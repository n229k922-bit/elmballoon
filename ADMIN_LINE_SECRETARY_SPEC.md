# 店主専用 LINE AI秘書 仕様（最小実装）

## 目的と分離
この文書は店主だけが使う運用管理用の仕様です。顧客からの注文・問い合わせ仕様は既存の `LINE_AUTOMATION_SPEC.md` に残し、混在させません。

## 対象操作
- 休業日を設定する（例: 「9月22日は休み」）
- 休業日を解除する
- 営業時間・受取可能時間・配達可能時間を変更する
- 現在の営業予定を照会する

変更は必ず「内容の復唱 → 店主の明示確認 → 保存」の順に行います。AIは確認前にデータを更新しません。

## 本人確認と権限
1. LINE Webhookの署名を検証する。
2. 許可済みのLINE userIdだけを管理者として扱う（環境変数 `ADMIN_LINE_USER_IDS`）。
3. 未登録ユーザーには情報を返さず、店主への登録依頼のみ案内する。
4. 管理コマンドには短時間有効の確認トークンを発行し、`はい` / `確定` などで消費する。
5. 破壊的操作は行わず、取消は新しい履歴レコードとして残す。

## 確認フロー
例: 店主「明日は休みにして」

1. AIが対象日を絶対日付に解決し、曖昧なら質問する。
2. 「2026-09-22 を終日休業にします。よろしいですか？」と復唱する。
3. 店主が確認トークン付きで承認する。
4. データを更新し、反映予定と変更IDを返す。
5. 失敗時は公開データを変更せず、理由と変更IDを返す。

## データモデル
`business_schedule`:
- `date` (YYYY-MM-DD, 主キー)
- `status` (open / closed / special_hours)
- `open_time`, `close_time`（必要時のみ）
- `pickup_window`, `delivery_window`（必要時のみ）
- `note`, `updated_at`, `updated_by`

`audit_log`:
- `id`, `timestamp`, `actor_line_user_id`, `request_id`
- `action`, `before_json`, `after_json`, `result`, `error_code`

`pending_confirmation`:
- `token`, `actor_line_user_id`, `proposed_change_json`, `expires_at`

## 第一候補の月額0円構成
- Cloudflare Workers: LINE Webhook、認可、確認フロー、公開API
- Cloudflare D1: 営業日・監査ログ
- Cloudflare KV: 短寿命の確認トークンとキャッシュ
- LINE Messaging API: 店主との会話
- GitHub Pages: 静的サイトの配信（公開リポジトリまたはPages対応プラン時）

Workersは `/api/business-schedule` で公開用JSONを返します。静的サイトはページ読込時にこのJSONを取得し、`dist/data/business-schedule.json` を初期フォールバックにします。これにより、営業情報の変更にサイト再ビルドは不要です。

## 安全要件
- LINEチャネルシークレット、アクセストークン、Cloudflare資格情報をGitへ保存しない。
- Webhook署名、時刻ずれ、リプレイを検証する。
- すべての書込みを監査ログに記録し、閲覧・復旧できるようにする。
- CORSは公開サイトのテストURLと本番ドメインだけを許可する。
- レート制限、障害時の読み取り専用フォールバック、定期バックアップを用意する。

## 導入順
1. Cloudflare側にD1/KV/Workerを作り、シークレットを設定する。
2. 管理者LINE userIdを登録し、Webhook検証だけを試験する。
3. 確認フローと監査ログを試験する。
4. 公開JSONを静的サイトのテスト環境へ接続する。
5. 店主が試験結果を確認後にのみ、本番ドメインを許可リストへ追加する。
