# Changelog

Release sections are added by `pnpm release`. Each section lists commit subjects since the previous `vX.Y.Z` tag.

## [1.10.1] - 2026-11-26

### Bug Fixes

- **Fixed whole-page translation skipping comments on arca.live.** arca.live stores each comment in a bare `<pre>` element, which Sakutto treated as a code block and left out of page translation (selection translation was not affected). Text-only `<pre>` bodies inside a board's comment area are now translated and keep their line breaks, while real code blocks stay excluded as before. (#172)
- **Better PDF layout for staggered two-column papers and text wrapped around icons.** Two columns whose lines drift out of step with each other are now detected as separate columns, so the translation no longer runs across the gutter or merges neighboring paragraphs. Justified lines with wide word spacing stay in one piece, tight-leading prose is no longer mistaken for inline math, and a paragraph that wraps around a small icon in its top-left corner is translated with the same wrapping, both in the reader and in the downloaded PDF. (#169, for #162, thanks @kiyoka)

### Thanks

- @kiyoka — staggered two-column and icon-wrap PDF layout fix (#169)

### 日本語

- **arca.live のコメントがページ翻訳で訳されない問題を修正しました。** arca.live はコメント本文を単独の `<pre>` 要素に入れており、Sakutto がコードブロックとみなしてページ翻訳の対象から外していました（選択して翻訳は影響を受けていませんでした）。掲示板のコメント欄にある文字だけの `<pre>` は翻訳対象にし、改行も保ちます。本物のコードブロックはこれまでどおり対象外です。(#172)
- **段が互い違いの二段組の論文PDFと、アイコンを回り込む文章のレイアウトを改善しました。** 行の位置が左右でずれている二段組も別々の段として検出するので、訳文が段の間をまたいだり、隣の段落とつながったりしません。単語の間隔が広い両端揃えの行は分割せず、行間の詰まった文章を数式と誤認しないようにしました。左上の小さなアイコンを回り込む段落は、同じ回り込みのまま訳文を表示し、ダウンロードするPDFにも反映します。(#169、#162 への対応。@kiyoka さんの貢献)
- 謝辞: このリリースに貢献してくださった @kiyoka さん（#169）、ありがとうございました。

## [1.10.0] - 2026-11-24

### Features

- **Scanned PDFs are now translated with on-device OCR.** The PDF reader recognizes the text of image-only pages with PP-OCRv6 (ONNX Runtime Web, WebGPU when available, otherwise WASM) and translates it, entirely in your browser. PDFs that already have a text layer are translated directly, as before, and are never held back by OCR: on pages that mix text and images, the text is translated first and decorative images such as logos are skipped. The "recognizing scanned page" message only appears on image-only pages. (#160, building on the OCR work in #154)
- **Download the translated PDF.** A new button saves the translation exactly as it looks in the reader, rendered at high resolution with an invisible text layer so the result stays searchable. The export waits until every page is translated. (#160)
- **The OCR model (about 23 MB) is set up with the translation model.** New installs get it during onboarding, which now shows PLaMo and OCR progress on separate rows. Existing users who already have PLaMo are not sent a download on update; when OCR is first needed, the reader and image translation show an inline "Download OCR model" button with progress, and recognition resumes automatically once it finishes. (#160)
- **Redesigned YouTube caption translation.** On recorded videos, including auto-generated captions, Sakutto now reads the player's timed-text track, translates ahead of playback and shows each sentence in sync with the video, removing the multi-second lag and dropped lines. Sentences are no longer cut mid-word or inside numbers such as `5.5`, short captions stay on screen for at least about 1.2 s, and the original line is shown while a translation is still on its way. Live streams get a two-line original/translation overlay that translates the rolling captions incrementally. Pure sound tags such as `[Music]` are no longer translated. (#147)

### Improvements

- **Page translations no longer make the page jump.** Instead of rewriting a paragraph token by token, which kept pushing the text below it around, page translation now shows each sentence as soon as it is translated and keeps the block's height until the paragraph is done, so the first translated text appears as quickly as before while the layout stays calm. A new "How page translations appear" setting also offers swapping in each paragraph once it is finished, in one short motion, and the previous token-by-token display. Menus and tables still fill in line by line, and with reduced motion enabled, translations fade in without movement. (#159, with thanks to sabopura)
- **Better PDF layout for two-column papers.** Left and right columns are handled separately and translations wrap inside their own column, so they no longer overlap the neighboring column. Headings from the two columns are no longer merged, words like `3D` or `2024年度` are no longer mistaken for headings, figure labels stay inside their figures with the caption placed below as its own block, formula lines are kept as they are instead of being translated, and stray OCR fragments are merged into the previous paragraph or dropped. (#160)
- **Faster-feeling PDF reading.** The page you are looking at is loaded, recognized and translated first, translations appear as they arrive, and OCR results are cached and prefetched. (#160)
- The Japanese UI now writes "PDF" in half-width characters, and the new strings are translated into all 14 locales. (#160)

### Bug Fixes

- On X (x.com), bilingual translations no longer disappear right after a page translation finishes, line breaks and blank lines in logged-in timeline posts are preserved instead of being collapsed into one paragraph, and replies are translated too. (#165, fixes #161 — thanks to ninenine0425-commits for the report)
- Local server: streaming responses framed with CRLF or CR line endings (common on aiohttp/httpx-based OpenAI-compatible servers) now arrive token by token instead of all at once when the stream ends. (#107, closes #106, with thanks to Seyamalam)
- PDFs served with both `filename` and `filename*` in `Content-Disposition` now show the UTF-8 file name, following RFC 6266. (#164, fixes #151 — thanks to Seyamalam for the report)

### Maintenance

- Development dependencies were updated and the Svelte sources reformatted for the new Prettier plugin; no runtime, manifest or permission changes. (#166, follow-up to #163)

### Thanks

- Thank you to everyone who contributed to this release.
- @sabopura — calmer page translation reveal (#159)
- @Seyamalam — local server SSE line-ending fix (#107), and the reports behind #106 and #151
- @ninenine0425-commits — the X timeline bug report (#161)

### 日本語

- **スキャンPDFを端末内OCRで翻訳できるようになりました。** PDFリーダーが画像だけのページの文字を PP-OCRv6（ONNX Runtime Web。WebGPU が使えれば WebGPU、使えなければ WASM）で読み取り、ブラウザー内だけで翻訳します。テキスト層があるPDFは従来どおりそのまま翻訳し、OCRを待たせません。テキストと画像が混在するページではテキストを先に翻訳し、ロゴなどの装飾画像はOCRしません。「スキャンしたページを文字認識しています」の表示は画像だけのページでのみ出ます。(#160、#154 のOCR実装をもとにしています)
- **翻訳後のPDFをダウンロードできるようになりました。** リーダーに表示している訳文を見た目そのまま高解像度でPDFに書き出します。見えないテキスト層を重ねているので検索もできます。書き出しはすべてのページの翻訳完了を待ってから行います。(#160)
- **OCRモデル（約23 MB）を翻訳モデルと一緒にセットアップします。** 新規インストールではオンボーディングで入り、PLaMo とOCRモデルの進捗を別々の行で表示します。すでに PLaMo を入れている方は、アップデートしただけで自動ダウンロードされることはありません。OCRが必要になったとき、リーダーと画像翻訳に「OCRモデルをダウンロード」ボタンが出て、進捗を表示し、完了すると自動で認識を再開します。(#160)
- **YouTube 字幕翻訳を刷新しました。** 録画（自動生成字幕を含む）では、プレイヤーの字幕トラックを読み込んで再生より先に翻訳し、文ごとに動画と同期して表示します。数秒の遅れや字幕の欠落がなくなりました。単語の途中や `5.5` のような数値の中で文を切らず、短い字幕も約 1.2 秒は表示し、訳が間に合わない間は原文を表示します。ライブ配信では、流れる字幕を逐次翻訳し、原文・訳文の2行で表示します。`[Music]` のような効果音タグだけの行は翻訳しません。(#147)
- **ページ翻訳で画面ががたつかなくなりました。** 訳文をトークンごとに書き込んで下の文章を押し下げ続けるのをやめ、訳された文ごとにすぐ表示し、段落が終わるまでブロックの高さを保つようにしました。最初の訳が出る速さは従来と同等のまま、レイアウトが落ち着きます。新しい設定「ページの訳文の出し方」では、段落の訳ができてから短い動きで1回だけ入れ替える方式と、従来どおりできた分から表示する方式も選べます。メニューや表は1行ずつ表示し、視差効果を減らす設定のときは動かさずフェードだけにします。(#159、sabopura さんの貢献)
- **二段組の論文PDFのレイアウトを改善しました。** 左右の段を分けて扱い、訳文を段の中で折り返すので、隣の段に重なりません。左右の見出しがつながらないようにし、`3D` や `2024年度` のような語を見出しと誤認しないようにしました。図の中のラベルは枠内に収め、キャプションは図の下に独立したブロックとして表示します。数式の行は翻訳せずそのまま残し、OCRのちぎれた断片は直前の段落につなげるか削除します。(#160)
- **PDFの体感速度を上げました。** 表示中のページを優先して読み込み・OCR・翻訳し、訳文は届いた順に表示します。OCRの結果はキャッシュし、先読みもします。(#160)
- 日本語UIの「PDF」表記を半角に統一し、追加した文言を14ロケールに翻訳しました。(#160)
- X（x.com）で、ページ翻訳の完了直後に対訳が消えて原文に戻る問題を修正しました。ログイン時のタイムラインの投稿で改行や空行が1段落につながる問題も直し、返信も翻訳されるようになりました。(#165、#161 を解決。ninenine0425-commits さん、報告ありがとうございます)
- ローカルサーバー: CRLF や CR の改行で区切られたストリーミング応答（aiohttp/httpx 系の OpenAI 互換サーバーで一般的）が、ストリーム終了時にまとめてではなく、トークンごとに届くようになりました。(#107、#106 を解決。Seyamalam さんの貢献)
- `Content-Disposition` に `filename` と `filename*` の両方があるPDFで、RFC 6266 に従い UTF-8 のファイル名を表示するようにしました。(#164、#151 を解決。Seyamalam さん、報告ありがとうございます)
- 開発用の依存パッケージを更新し、新しい Prettier プラグインに合わせて Svelte のソースを整形しました。実行時の動作・manifest・権限に変更はありません。(#166、#163 の後継)

- 謝辞: このリリースに貢献してくださった @sabopura さん（#159）、@Seyamalam さん（#107、#106・#151 の報告）、@ninenine0425-commits さん（#161 の報告）、ありがとうございました。

## [1.9.1] - 2026-11-21

- オンボーディングのモデルダウンロード進捗が通知途絶後に止まったままになる不具合を修正 (#149) (#150)
- docs: add kiyoka to contributors (#152)
- docs: use dynamic GitHub release badge in READMEs (#153)
- 16 並列のとき、空いた枠にすぐ次の依頼を入れる (#133)
- Fix all-sites content-script registration race (#155)
- Remove the Brave Shields caption notice (#156)
- 公式PLaMo GGUFの複数リビジョンを検証し、未知版は更新を案内する（#157） (#158)

## [1.9.0] - 2026-11-20

### Features

- A new opt-in setting lets you grant access to all sites with a single choice. While enabled, the selection-translate button and in-page shortcuts work as soon as a page opens, without first activating Sakutto through its icon, the right-click menu, or another shortcut. YouTube subtitle translation, the mail translation banner, always-translate for a site, custom caption sites, and the local server also work without extra per-site permission prompts. Translation remains entirely on your device, and you can turn the setting off at any time to revoke access. Install-time permissions remain minimal and unchanged; with the setting off, Sakutto behaves exactly as before. (#146)

### Improvements

- The popup now explains the all-sites option near the top the first time you open it. On later opens, the hint moves below "Translate text" to keep it out of the way. (#148)

### 日本語

- 新しいオプトイン設定で、すべてのサイトへのアクセスを一度に許可できるようになりました。有効にすると、ページを開いた時点で選択翻訳ボタンとページ内ショートカットが機能します。事前にアイコンをクリックしたり、右クリックメニューや別のショートカットで Sakutto を有効化したりする必要はありません。YouTube の字幕翻訳、メール翻訳バナー、サイトの常時翻訳、カスタム字幕サイト、ローカルサーバーも、サイトごとの追加の権限プロンプトなしで動作します。翻訳は引き続きデバイス上でのみ行われます。設定をオフにすれば、いつでもアクセスを取り消せます。インストール時の権限は従来どおり最小限で変更はなく、設定がオフの場合の動作も従来と同じです。(#146)
- ポップアップを初めて開いたときは、全サイトへのアクセスに関するヒントを上部付近に表示します。2 回目以降は「Translate text」の下に表示されます。(#148)

## [1.8.1] - 2026-11-19

### Improvements

- Long selection translations now scroll inside the popup instead of covering the window. The popup header and Close control stay visible while you read, and short translations behave exactly as before. (#145, closes #144)
- Selection prefetch is faster and lighter on large pages. Small selections that are already translated are no longer re-translated in advance, scanning of large selections is bounded so it cannot stall the page, and the background prefetch that runs before you click the icon is preserved. (#141, with thanks to 4ltena; #142)

### Bug Fixes

- On AMD Vega/GCN graphics, WebGPU translation no longer produces broken output. Sakutto now disables the untested fast decode paths on these GPUs and uses the same safe path as v1.3.0; other GPUs are unaffected. (#140)
- When the WebGPU adapter is unavailable, the status message now suggests fully restarting the browser after driver updates and checking hardware acceleration / chrome://gpu. (#138)
- Unspaced text is no longer rescanned for email addresses. (#135)

### Performance

- Checking content script readiness no longer triggers a page scan, which removes avoidable work on every page. (#136)

### Docs

- The README now shows contributor avatars for Seyamalam, TKY-27, and 4ltena. (#139, #143)

### 日本語

- 選択翻訳ポップアップ: 長文翻訳はポップアップ内でスクロール表示され、ウィンドウを覆わなくなりました。ヘッダーと閉じるボタンは常に表示され、短い翻訳は従来どおりです。(#145、#144 を解決)
- 選択プレフェッチ: 大きなページで高速・軽量化。翻訳済みの短い選択範囲を事前に再翻訳しなくなり、大きな選択範囲の走査は上限付き、アイコンクリック前のバックグラウンド事前翻訳は維持されています。(#141、#142、#141 は 4ltena 氏の貢献)
- AMD Vega/GCN では、未検証の高速デコードパスを無効化し、v1.3.0 と同じ安全なパスを使用。出力が壊れる問題を修正しました。他の GPU への影響はありません。(#140)
- WebGPU アダプターが利用できない場合、ドライバー更新後はブラウザーを完全に再起動すること、ハードウェアアクセラレーションと chrome://gpu を確認するようステータスが案内します。(#138)
- スペースなしテキストのメールアドレス再走査を廃止。(#135)
- コンテンツスクリプト準備確認時にページ走査を行わなくなりました。(#136)
- README にコントリビューター（Seyamalam、TKY-27、4ltena）のアバターを追加しました。(#139、#143)

## [1.8.0] - 2026-11-19

### Improvements

- WebGPU translation now decodes much faster, so long articles finish noticeably sooner. The bundled wllama sizes its k-quant matrix–vector workgroups to fit the row on NVIDIA, takes a greedy-sampling fast path that finds the most likely token with an on-GPU argmax instead of sorting the whole vocabulary for every token, returns a result that is already ready without decoding one extra step, and lets flash attention skip KV tiles that every query row has masked out. On the test page decoding runs about 1.5× faster, a full long-article page drops from 3.9 s to 2.5 s, and average throughput rises from 377 to 572 tok/s. Translation quality is unchanged. (#111)
- The selection translation popup now has a one-click copy button beside its close control. It copies the exact text the popup is showing, line breaks included, so you can copy the finished portion of a streamed translation without waiting for the whole decode. (#129, #132)

### Bug Fixes

- On Brave, models recorded in the shared folder now show their Use and Remove actions in Settings even while the folder permission is still in the prompt state, and the list refreshes once you grant access. Deleting a model in shared-folder mode now removes only Sakutto's browser-side record — the GGUF file stays in the shared folder, and the Settings wording says so. (#130)

### Build

- Stylesheet links in the built HTML entries are now written in one deterministic order, so two package builds from the same source produce identical output and the shipped packages are reproducible. This is a build-level fix and does not change user-facing behavior. (#134)

## [1.7.3] - 2026-11-18

- docs: expand v1.7.2 changelog entries
- fix(captions): bound YouTube empty-track player-response polling (#128)

## [1.7.2] - 2026-11-18

### Bug Fixes

- Local-server translation no longer treats a missing in-browser model as a hard fault after you delete every downloaded model, and the shared-folder grant gate no longer misfires on local-server pages. Options can remove per-site rules. (#126)
- On Brave, YouTube captions can recover when timedtext tokens arrive late or Shields blocks the first fetch: polling keeps looking for a fresh `pot=` URL, document player data is used when needed, and a short notice explains when Shields may be blocking caption data. (#127)

## [1.7.1] - 2026-11-18

### Improvements

- The Settings option for line breaks in typed text, the selection popup, and compose preview is easier to use with OCR or pasted book text. “Blank line between paragraphs” now keeps real blank lines in copied translation text, and “Wider gap” shows break marks on the source field without changing how the translation string is stored. (#125)

### Bug Fixes

- On Edge, the Settings model-storage radio now stays on the shared folder after you reopen the page, even when folder permission is still in the prompt state. (#123)
- When the browser has no shared-folder picker (for example Brave with File System Access API off), Settings and onboarding show a short explanation instead of hiding model storage; Brave users see how to enable the feature flag. When the picker is available, shared-folder storage works like Chrome. (#123)
- Folder permission guidance now matches Edge’s dialog: choose “Ask every time I access” / 「アクセスするたびに確認する」, explained as the same persistent choice as Chrome’s “Allow on every visit” / 「サイトアクセス時は常に許可」 (despite the wording, no further prompts after restart). (#123, #124)

## [1.7.0] - 2026-11-18

### Features

- On Chromium-based browsers, one downloaded model can now be shared by Chrome, Edge, and multiple browser profiles, so you no longer need a separate copy for each one. Opt in during first-run onboarding or later from Settings > Model storage. When you switch, models already stored in the browser are moved into the shared folder rather than duplicated. (#66, #115, #116, #120)

### Improvements

- On Linux Chrome, diagnostics now show a clearer hint when WebGPU is unavailable, making GPU setup problems easier to understand. (#110)
- Firefox onboarding now provides clearer guidance for choosing a model storage folder. (#117)
- Success and error notices when switching model storage are now easier to see in Settings. (#122)

### Bug Fixes

- Downloading no longer stalls when you switch to shared model storage. (#117)
- After a browser restart, your keyboard shortcut can still open the permission tab for the shared folder. If no shortcut is set, Sakutto now shows a clear notice instead of a change link, and the unreliable in-page shortcut fallback has been removed. (#114, #118, #119)
- On Radeon and integrated GPUs, automatic mode no longer drops to the CPU immediately. Sakutto now retries WebGPU after a quiet GPU probe and uses clearer labels when it does fall back to the CPU. (#121)

## [1.6.3] - 2026-11-17

### Features

- Settings now has a Line breaks in the translation option for the typed-text page, the selection popup, and the compose preview. Do not add breaks is the default and produces the same joined output as before. Break between paragraphs keeps a line break at each paragraph boundary, Blank line between paragraphs adds an empty line, and Wider gap between paragraphs uses wider spacing. Breaks that OCR or pasted text left in the middle of a sentence move to the end of that sentence instead of cutting it. Page and PDF translation are unchanged. (#102)

### Bug Fixes

- Gmail and other mail bodies that use `<br>` line breaks instead of `<p>` paragraphs now keep their line and paragraph layout after translation. The translation is fitted back onto the message's existing lines, so blank lines, label lines, greetings, and signatures stay in place instead of collapsing into one block. The body is translated as one segment, and scanning the page does not split or change the message markup. (#103)

### Maintenance

- Updated three minor npm development dependencies in the npm-minor group (#99).
- Updated the TypeScript development dependency from 5.9.3 to 6.0.3 (#46).
- These updates are developer-only and do not change user-facing behavior.

## [1.6.2] - 2026-11-16

### Bug Fixes

- Gmail and Outlook message translate banners no longer appear twice or flicker after you reload the extension, restart the browser, or open several Gmail tabs at once (#101).
- In list or table cells with extra wrapping markup (for example `li > div > p`), inline identifiers such as version numbers are no longer sent to the model and rewritten (#94, thanks @Seyamalam).

## [1.6.1] - 2026-11-16

### Bug Fixes

- Gmail and Outlook message banners no longer ask for install-time host access (#98). The first time you use them, open the Sakutto popup on Gmail or Outlook and allow access once, the same way YouTube subtitles work; after that the banner appears automatically. The banner scripts run only on the mail sites you allow and are removed if you revoke access. Install-time permissions are back to the same set as 1.5.1.

## [1.6.0] - 2026-11-16

### Permissions

- The extension now asks at install for access to Gmail (mail.google.com) and Outlook on the web (outlook.live.com, outlook.office.com, outlook.office365.com, outlook.cloud.microsoft) so the mail translate banner can appear without opening the popup. Existing users may be asked to approve this on update. No other sites are added.

### Features

- Gmail messages get a Sakutto banner above the body when the message is written in a language other than the target (#88). It identifies the source language, translates only that message after a click, toggles back with Show original, and can be closed per message. Each expanded message in a thread has its own banner, and the setting can turn the feature off. The model loads only when Translate is clicked.
- After translating a Gmail message, the bar shows a Gmail-style "Translated" state with Show original / Show translation using the cached translation (#92). A gear menu offers Translate <language>, Always translate <language>, and Never translate <language> (mutually exclusive auto/never lists). The options page has a section to review and clear those lists.
- Outlook on the web gets the same per-message translate banner as Gmail (#96). It works on outlook.live.com, outlook.office.com, outlook.office365.com, and outlook.cloud.microsoft. The banner appears automatically when a message is in a language other than the target, and nothing is translated until Translate is clicked. It shares the Gmail auto/never language lists and the existing message-banner setting.
- While a Gmail or Outlook message is being translated, the banner shows progress as a percentage and replaces paragraphs as soon as each one is translated (#96).

### Bug Fixes

- On pages declared Japanese (e.g. Steam discussions in the Japanese UI), English posts that contain a Japanese quote label are now translated (#91). Language is detected on each block's own text, and kanji-only labels on Japanese pages are no longer sent for translation, so Japanese pages send far fewer blocks.
- Superscripts and subscripts are no longer lost in translations (#95). In the PDF reader, raised/lowered characters such as CH₄, 10³, m³, x², H₂O and reference markers stay in the translation as superscript/subscript instead of disappearing or turning into a wrong number like 103; on web pages `<sub>`/`<sup>` content is kept.
- Subscripts and superscripts that publishers mark up with styled spans (such as NLM sub/sup classes or vertical-align) are kept in full-page web translations, and an empty or dropped slot falls back to the original text (#97).

## [1.5.1] - 2026-11-14

### Bug Fixes

- WebGPU startup no longer hangs forever on some GPUs and drivers (for example Linux Wayland with NVIDIA). If the GPU does not respond in time, Sakutto falls back to the CPU automatically and says so. The popup no longer keeps showing "waiting for the model" after you switch between CPU and WebGPU when translation is already working. (#85)

## [1.5.0] - 2026-11-13

### Features

- When a PDF is open in the browser, the popup and right-click menu offer Translate this PDF. Sakutto fetches the file the tab is showing, opens it in its own reader tab, and translates each page in order starting from the first, including multi-column body text, figure captions, tables, lists, and rotated pages, with layout-aware placement so translations stay in the boxes their source text occupied. (#75)
- Settings has a slider for in-page translation popup text size (80–200%, default 100%) for hover tips, the selection popup, status toasts, and the typed-text preview; open tabs pick it up live. The selection popup can be widened or narrowed by dragging the left or right edge (minimum width 14em), double-clicking either edge returns automatic width, and arrow keys nudge the width when a handle is focused. (#81)
- Add Easy Japanese (やさしい日本語, `ja-easy`) as a PLaMo-only target language, so a page already in Japanese can still be translated into simpler Japanese. Chrome's built-in translator is not used for this target. (#79)

### Improvements

- Model download now verifies the pinned SHA-256 digest while bytes are still streaming in, using a background worker, so finishing setup after a large download is much faster and the progress bar shows verifying separately from downloading. (#78)

## [1.4.1] - 2026-11-13

### Bug Fixes

- Hidden characters in page text no longer break translation or fill the page with junk. Regional flag emoji now get enough space. If a translation is cut off because it ran out of room, Sakutto keeps the original text instead of showing a half-finished sentence. (#74)
- On Firefox, choosing Local server in Settings now switches the engine. If the browser does not grant access to that address, a message appears and Built-in stays selected. (#76)

## [1.4.0] - 2026-11-12

### Features

- Translate captions on YouTube (including live) and X while the video plays, on your device. A translated overlay sits on the player. Hover the player to show a Hide original caption button. Settings has a caption size slider, and you can press and hold a translated caption to drag it; YouTube and X remember their own spots, and Reset position puts them back. Auto-generated Japanese captions are translated to English. The setting is off until you turn it on in Settings or the popup. You can add other caption sites in Settings. (#69)

### Bug Fixes

- Translated captions no longer stay on screen through silence. After about 4 seconds of real silence the translation clears and the original captions come back. Short gaps still bridge. (#71)
- On a Mac, the default shortcuts are now Option+A, Option+B, Option+S, and Option+T. After an update, a command Chrome never assigned uses that default on web pages, without opening Chrome's shortcut page. A key you cleared in Chrome's editor stays off. You can still change shortcuts at chrome://extensions/shortcuts. A Chrome-assigned shortcut still translates the page even from a text field. If the default was never assigned, the keydown still reaches the field, including a textarea, and Sakutto leaves it unprevented so Option+letter can type. The in-page default does not run on chrome:// pages or in the PDF viewer. (#72)

## [1.3.0] - 2026-11-11

### Features

- Experimental: from Settings, you can send translation to a local OpenAI-compatible server on this computer, such as an MLX server on a Mac or LM Studio. Only PLaMo models are supported. The built-in engine stays the default. Accuracy is not guaranteed. (#60)

### Bug Fixes

- On some GPUs, if GPU translation output becomes garbled, Sakutto now detects it and redoes that part on the CPU instead of showing broken text. (#63)
- Switching models now drops the previous one, so translation uses the model you just chose. (#64)
- The model you selected is now saved, so the choice is still there after a restart. (#62)

## [1.2.1] - 2026-11-10

### Improvements

- After this update, per-site language overrides are reset once, and the global target language becomes the default on every site. You can set a language for one site again from the options site list. Changing the language in the popup now changes the global setting. (#58)

### Bug Fixes

- The target language no longer resets to English on each site when you had chosen another language globally, such as Japanese. (#58)
- The model you selected, such as High accuracy, is remembered after a restart. If Standard had been deleted, the selection was forgotten and translation often did not start. (#58)

## [1.2.0] - 2026-11-10

### Features

- Translate the text you are typing, on the device. Focus a message box and press Alt+T (Option+T on a Mac), click the あA button next to the field, or use the right-click menu. A live preview bar appears above the field; keep typing and it updates. Press the same shortcut again, or Ctrl+Enter (⌘+Enter on a Mac), to replace the draft; Restore original puts the previous text back. You can drag the bar, park it below the field, or move it to the bottom-right of the window. The preview has a language picker, and settings can skip the preview so one shortcut press translates and replaces. Japanese drafts go to English (or to your saved page-translation target if that is not Japanese); other drafts use that target until you pick another language. Password fields, card numbers, and sites set to never translate are left alone. You can hide the あA button. (#42)

### Improvements

- The repository now has a Firefox build target for desktop Firefox 153 and later. It is not listed on Firefox Add-ons in this GitHub release. (#50, #54, #55)

### Bug Fixes

- Page translation no longer stops partway after a download or a cancelled "leave this site?" prompt. When the tab is hidden, work already in progress is kept instead of being thrown away and redone. (#31)
- On AMD and Intel GPUs, WebGPU failures now fall back to CPU more reliably, and a correctness check disables a bad GPU setup instead of producing garbage text. This does not mean AMD Radeon WebGPU now works. (#49)
- A shortcut you clear on Chrome's shortcut page now stays off. Fresh installs still get Alt+A, Alt+B, Alt+S, and Alt+T. If you had already left a shortcut unassigned in Chrome before this update, the in-page default may still work until Chrome assigns a key or you turn that command off in Sakutto. (#52)

### Contributors

- Thanks to @sabopura for fixing translation that stopped partway, and for stopping wasted recomputation when the tab is hidden. (#31)

## [1.1.0] - 2026-11-09

### Features

- Faster GPU page translation — on a long, text-heavy web page translated with the GPU (WebGPU), the whole page finished about 3.7 times faster (14.6 seconds → 4.0 seconds), and the first translated paragraph appeared about 1.6 times sooner (0.5 seconds → 0.3 seconds). These numbers are from the project's long-article benchmark. They do not describe CPU translation. Times vary by page and by computer. (#27)
- The extension's screens are now available in 14 languages: English, Japanese, Korean, Simplified Chinese, Traditional Chinese, Spanish, Brazilian Portuguese, French, German, Italian, Russian, Vietnamese, Thai, and Indonesian. Anyone can contribute translations. (#30)
- Keyboard shortcuts can now be changed from Sakutto's own screens. (#32)

### Contributors

- Thanks to @sabopura for making GPU page translation faster. (#27)

## [1.0.2] - 2026-11-08

### Features

- Faster GPU page translation — the first translated paragraph appears sooner, and long pages finish faster. On the project's long-article WebGPU benchmark, the first paragraph appeared in about 0.5 seconds instead of 1.1, and the full page finished in about 14.6 seconds instead of 21.6. CPU translation is unchanged. (#25)

### Improvements

- The GitHub repository now has a Sponsor button and a Support section. Sakutto stays free and open source, with no ads or paid features. (#24)

## [1.0.1] - 2026-11-08

### Features

- Larger glossaries — each stored list (global or per site) now keeps up to 5,000 terms, up from 1,000. A translate run can carry the merged lists up to 10,000. Only terms that appear in the current text go into the model prompt. A user asked for a much larger glossary, and that seemed reasonable. (#23)
- Longer typed-text translation — paste up to 100,000 characters at once, up from 20,000. Long text is still split for the model. Surrounding page context stays at 20,000 characters. (#23)
- Faster GPU page translation — two paragraphs decode at once, each with its own cache, so long pages no longer slow down after paired paragraphs. The translated text is unchanged. CPU translation is untouched. (#22)

### Improvements

- Keyboard hints show Mac keys next to the Windows ones — Option+A, Option+B, and Option+S beside Alt+A/B/S, and ⌘+Enter beside Ctrl+Enter.
- Chrome Web Store listing matches the packaged locales — the name is "Sakutto - Local AI translation" (Japanese: "Sakutto - ローカルAI翻訳"). The short summary no longer repeats "Built with PLaMo"; that credit stays in the detailed description. (#17, #18)
- Clearer privacy policy for readers, in English and Japanese — translation runs on your device, there is no account, advertising, or analytics, and the only file the extension downloads is the model. (#21)

### Bug Fixes

- Text typed into a search box, message box, or form is no longer treated as page copy, including inputs wrapped in custom elements. Closed shadow roots stay out of reach. (#19, #20)
- A run of dots or asterisks in ordinary page text is no longer treated as a hidden password — only a real password field is masked that way. (#20)
- The on-page translation overlay is isolated from the host page, so a site script cannot read it, rewrite it, or turn on "always translate this site" for you.
- Model download remains the only network use — no page text, no credentials — and extension pages do not load remote scripts, styles, or fonts. The model file is kept only when its hash matches the pin. These surfaces are checked in tests. (#20)

## [1.0.0] - 2026-11-06

- No commits since the previous release.

## [0.1.1] - 2026-11-06

- Initial public source release
- Rename the public product to Sakutto.
- Format the store zip example after the package rename.
- Redraw the Sakutto mark as a folded strip.
- Ignore local video renders.
- Restore onboarding after the pinned GGUF commits moved.
- Add Chrome Web Store listing copy and review notes (#3)
- Show a selection icon that translates the highlight immediately (#5)
- Add a manual Chrome Web Store upload workflow. (#4)
- Keep long pages moving while PLaMo translates
- Keep translated text readable and translate whole pages
- Translate pages with PLaMo only, with no 簡易訳 badge or Chrome draft (#8)
- Add a durable page-translation speed bench with headline numbers (#9)
- Fix ranking-table layout collapse and pack short blocks into one request (#10)
- Make whole-page PLaMo translation continuous: one prompt per paragraph, headline first, held tok/s, WebGPU fallback detection (#11)
- Describe PLaMo license terms in onboarding and record consent honestly (#12)
- Serve bundled licences as UTF-8, cover special page prose, add typed translation, clarify licence onboarding (#13)
- Hide start controls until PLaMo can answer, and compare typed text side by side (#14)
- Drop the typed page's outer card and separate the panes with rules
- Keep the local launch-video renders out of git and the linter
