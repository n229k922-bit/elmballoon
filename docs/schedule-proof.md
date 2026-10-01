# 店休日変更の画像証跡

変更確定後に実ページをCloudflare Browser Renderingで読み込み、`.elm-calendar [data-date="YYYY-MM-DD"]` のdata-label・classを変更内容と照合する。一致した場合のみ`.elm-calendar`の範囲をPNG撮影し、店長LINEのreplyに文章・画像・確認URLを返す。生成した図ではない。

## 接続設定

- `BROWSER_RENDERING_TOKEN`: 対象アカウントのBrowser Rendering - Edit権限を持つAPI token。Worker secretとして登録しGitに保存しない。
- `CLOUDFLARE_ACCOUNT_ID`: 撮影サービスのアカウント。
- `SCHEDULE_PROOF_PAGE_URL`: この環境の営業日APIを参照する公開ページのHTTPS URL。店長や顧客のカルテページは指定しない。
- `MANAGER_APP_ORIGIN`: 画像取得用公開Worker origin。

通常HPは本番Workerの営業日APIを参照する。GitHub公開ページの `?schedule=test` はテストWorkerのAPIを読み込み、テスト表示の注意を出す。`schedule_date=YYYY-MM-DD` で変更日の月と詳細を表示する。撮影時は実ページの `data-schedule-source` がこのWorkerのAPIと一致することも照合する。テストWorkerの変更を通常HPで検証したと見なさない。

2026-10-01：テスト接続ページ https://n229k922-bit.github.io/elmballoon/?schedule=test を設定し、サイト変更だけをac985d7としてプッシュ。公開HTMLで接続スクリプト反映を確認。撮影secretは未設定。未設定、対象日が表示されない、変更内容不一致、撮影失敗は「営業日設定保存済み／HP反映・画像確認未完了」を返す。

PNGは公開カレンダーだけ。ランダムUUIDでアクセスしKVに7日間保存。期限後404。証跡URLには個人情報・credentialなし。スクリーンショット成功テストは模擬APIであり実サービスの撮影・LINE着信確認ではない。

API reference: https://developers.cloudflare.com/api/resources/browser_rendering/subresources/screenshot/methods/create/
