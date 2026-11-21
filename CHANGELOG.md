# Changelog

Release sections are added by `pnpm release`. Each section lists commit subjects since the previous `vX.Y.Z` tag.

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
