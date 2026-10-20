# ホームページ画像差し替えの隔離変更案

LINEでは現在、写真差し替えの依頼と画像メッセージIDを受け付ける。素材の実取得・掲載許可・具体的な差し替え先の確認後、以下のツールで公開前に確認できる変更案を作る。現在のdistや本番サイトには書き込まない。

```powershell
node tools/stage-site-image-change.mjs --dist "C:/path/to/repository/dist" --page "index.html" --target-src "wp/wp-content/uploads/2026/09/example.png" --source "C:/private/replacement.png" --alt "赤とピンクの誕生日用バルーン" --staging-dir "C:/private/image-review-001"
```

`--page`はdist内のHTML相対パス、`--target-src`はそのHTML内で使っているsrcをそのまま指定する。対象のimgがちょうど1個でなければ停止する。推測による対象決定はしない。`--source`はdist外の非公開ファイル、`--staging-dir`はdist外の新規フォルダを指定する。既存の出力先は上書きしない。パスの逸脱、symlink・Windows junction、認証クエリ等の混入を拒否する。

現在扱う素材は、8-bit RGB/RGBA・非インターレースのPNG、幅200〜2000px、高さ100〜2000px、90万byte以下。PNGの構造・CRC・zlib展開後の画素長と行フィルタも検証する。SVGやPNGに偽装したSVG、JPEG/WebPなど未対応の素材は停止する。形式を自動変換して通す機能はない。未対応形式は、元画像を保持して別途対応を検証する。

変更案には次が入る。

- `site/`: 対象のHTMLと、新規のランダムファイル名を持つPNGだけ。元の画像ファイル名を上書きせず、その画像を参照する他ページへの意図しない影響を避ける。
- `rollback/`: 元の対象HTMLと元PNGの完全コピー。
- `manifest.json`: 新旧のsrc、SHA-256、寸法、新しいalt、公開未実施の状態、復旧元と削除候補の新規画像パス。

元HTMLにwidth/heightがある場合、新画像の実寸へ変更する。altは必須で、HTML特殊文字はエスケープする。srcset・lazy load用別src・picture内の画像は、一部だけ変えて別の画像が残る事故を避けるため停止する。これらは全サイズ/形式を明示した変更案の検証が別途必要。

出力は変更対象ファイルだけであり、サイト全体をコピーしたプレビューサーバーではない。公開前にmanifestとHTML差分をレビューし、現在の元HTML/画像のhashがbeforeと一致することを再確認してから、Git作業ブランチで新規画像とHTMLを取り込む。公開とロールバックの自動実行機能はない。ロールバック時は公開済みHTMLがmanifestのafter hashと一致することを確かめ、他の編集を巻き戻さない。

```powershell
node --test tools/test-stage-site-image-change.mjs
```

2026-10-20: 架空素材による16件が合格。新旧hash/寸法/alt/復旧用コピー、元dist不変、特殊文字、重複対象、srcset/lazy/picture、コメント/script/template内の偽対象、パス逸脱、SVG偽装、symlink/junctionを検証した。実際の店長LINE画像の取得と掲載後の目視確認は未実施。
