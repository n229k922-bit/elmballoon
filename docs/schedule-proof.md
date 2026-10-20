# 店休日変更の画像証跡

変更保存後に実ページをCloudflare Browser Renderingで読み込み、`.elm-calendar [data-date="YYYY-MM-DD"]` のdata-label・classを変更内容と照合する。撮影側のページでも、正確なURL・参照API・対象日・ラベル・classを再照合する。その場で確認したカレンダーDOMを複製し、親要素のclassを維持しながら無関係な本文を除いて固定し、Cloudflareの`selector`撮影でPNG化する。別のページ読込みで取得した古い座標は使わない。確認できた場合のみ、同じPNGのURLをLINEの原寸画像・プレビューに指定する。

## 接続設定

- `BROWSER_RENDERING_TOKEN`: 対象アカウントのBrowser Rendering - Edit権限を持つAPI token。Worker secretとして登録しGitに保存しない。
- `CLOUDFLARE_ACCOUNT_ID`: 撮影サービスのアカウント。
- `SCHEDULE_PROOF_PAGE_URL`: この環境の営業日APIを参照する公開ホームページのHTTPS URL。パスは`/`、`/index.html`、`/elmballoon/`、`/elmballoon/index.html`だけ。クエリはテスト用の`?schedule=test`だけ。認証・顧客情報を含むURLは指定できない。
- `MANAGER_APP_ORIGIN`: 画像取得用公開Worker origin。

通常HPは本番Workerの営業日APIを参照する。GitHub公開ページの `?schedule=test` はテストWorkerのAPIを読み込み、テスト表示の注意を出す。`schedule_date=YYYY-MM-DD` で変更日の月と詳細を表示する。撮影時は実ページの `data-schedule-source` がこのWorkerのAPIと一致することも照合する。テストWorkerの変更を通常HPで検証したと見なさない。

2026-10-01：テスト接続ページ https://n229k922-bit.github.io/elmballoon/?schedule=test を設定し、サイト変更だけをac985d7としてプッシュ。公開HTMLで接続スクリプト反映を確認。撮影secretは未設定。未設定、対象日が表示されない、変更内容不一致、撮影失敗は「営業日設定保存済み／HP反映・画像確認未完了」を返す。

PNGは公開カレンダーだけ。ランダムUUIDでアクセスしKVに7日間保存。保存後の読戻しで原本と一致することを確認し、読めなければ完了扱いにしない。期限後404、KV障害・壊れた画像は503で画像を返さない。証跡URLには個人情報・credentialなし。

2026-10-20の強化では、実在しない日付・不正な営業時間・通常/休業/特別営業の取り違え・異なる環境のAPI・同じ日付が複数あるDOM・撮影中の差替えを拒否する。撮影APIはキャッシュを無効にし、Content-Type、PNG署名、IHDR/IDAT/IEND、各チャンクCRC、200〜2000pxの幅と100〜2000pxの高さ、90万byte以下、展開後の画素データ長と行フィルタを検査する。原本とプレビューは同一の検証済み画像となる。

`scheduleProofReadiness(env)`は不足する設定名と設定不備を返す。ネットワーク通信や秘密値の出力は行わない。実サービス受入れには、Browser Rendering tokenの登録、変更保存後に公開ホームページが同じ環境のAPIを参照していることの確認、実撮影画像の目視、LINEの原寸表示・プレビュー表示の確認が必要。撮影secretは未設定のため、これら実サービスの受入れは未完了。

検証: `node --test tools/test-schedule-proof.mjs` は22件合格（模擬API、実PNGデータと破損PNG、撮影スクリプトのDOM検証を含む）。模擬テストの合格を実サービスの撮影・LINE着信確認とは扱わない。`scheduleProofMessages`のフォールバックには保存済みという案内があるため、呼出し元はDB保存成功後にだけ呼び出すこと。

API reference: https://developers.cloudflare.com/api/resources/browser_rendering/subresources/screenshot/methods/create/

## 実サービスを試す前の具体的な操作

1. Cloudflareで対象アカウントのBrowser Rendering Write（画面によってEdit表記）のAPI tokenを用意する。token値はチャット・Git・文書へ貼らない。
2. テストWorkerだけに登録する場合は、リポジトリのルートから次を実行し、プロンプトにtokenを入力する。`--config`を省略しない。これは設定を書き込む操作なので、担当者がテスト環境への登録を承認した上で行う。

   ```powershell
   npx wrangler secret put BROWSER_RENDERING_TOKEN --config workers/admin-line-secretary/wrangler.test.toml
   ```

3. 設定の存在だけを確認する読取り用ツールは以下。操作用のCloudflare API tokenが`CLOUDFLARE_API_TOKEN`に設定されていることが前提。値をコマンド引数には書かない。固定されたテストWorkerのsettingsにGETを1回行い、必要なbinding名の有無だけ出力する。tokenや設定値は出力しない。本番環境への切替えオプションや書込み処理はない。

   ```powershell
   node tools/check-schedule-proof-preflight.mjs --remote-test
   ```

4. `ready:true`でも存在確認だけであり、画像撮影の受入れ合格ではない。設定のURL・origin・API接続先の一致は`captureScheduleProof`内で再照合する。テスト営業日を変更し、公開テストページのカレンダーが変わること、対象日が画像に写ること、原寸とプレビューが同じであることを担当者と確認する。7日後の期限切れ挙動はKV TTL設定の検査と模擬確認に加え、必要なら期限到達後に実画像URLの404を確認する。

2026-10-20: 実際のWorkerエンジン（workerd/Miniflare、compatibility date `2026-09-21`）で`DecompressionStream('deflate')`を実行した。2000×2000pxの正当なPNGを保存・読戻し・公開応答まで確認し、宣言寸法より64MiBに展開するPNGを5回連続で拒否した。ローカル測定は最大画像の初回起動込み約1100ms、過剰展開5回の拒否合計約331ms。本番の課金CPU時間や実撮影API速度を意味する数値ではない。

```powershell
node --test tools/test-schedule-proof.mjs tools/test-schedule-proof-preflight.mjs tools/test-schedule-proof-workerd.mjs tools/test-schedule-atomicity.mjs
```

workerdテストはインストール済みMiniflareを利用する。Windowsのnpm npxキャッシュから見つからない場合は`MINIFLARE_PACKAGE_JSON`にインストール済みパッケージのpackage.jsonを指定する。未導入ならskipとして表示し、Worker実行検証済みとは扱わない。依存を自動ダウンロードしたり、外部Workerに接続したりはしない。

署名付き営業日フローの原子性テストでは、監査INSERTを意図的に失敗させ、新規営業日の挿入・既存営業日の更新のどちらも変更と監査をまとめて取り消すこと、保存済み/完了/画像を返さないこと、同じ確定番号を再送しても変更を再実行しないことを確認する。SQLiteの実トランザクションでD1のbatch契約を再現するローカルテストであり、リモートD1障害を実際に発生させる試験ではない。

Worker compression API reference: https://developers.cloudflare.com/workers/runtime-apis/web-standards/
