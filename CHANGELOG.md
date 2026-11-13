# Changelog

Release sections are added by `pnpm release`. Each section lists commit subjects since the previous `vX.Y.Z` tag.

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
