# AMO listing text

Draft for a listed add-on on addons.mozilla.org. The packaged name still comes from
`public/_locales/*/messages.json` (`extensionName` / `extensionShortName`). Confirm the gecko id
`sakutto@jammaru` in `src/shared/browser.ts` before the first listed upload. It cannot change
afterwards. `amo-metadata.json` is the file `web-ext sign` submits; keep these blocks in sync
with it. AMO summaries must stay at or under 250 characters.

Do not paste Chrome Web Store speed numbers. Firefox GPU and CPU times must be measured on the
target Firefox before any claim is added.

The manifest pins `strict_min_version` 153.0 and does not filter OS. `gecko_android` is not
set, so this is a desktop Firefox add-on (Windows, macOS, Linux), not Firefox for Android.

Character counts below are for the block contents, not including a trailing newline after the last
line.

## English

### Name

```text
Sakutto - Local AI translation
```

### Summary

```text
Local LLM translation on this device. Free, no account.
```

### Description

```text
Translate a whole page, a selection, or text you type. Replace the original or read a bilingual view.

No ads and no analytics. Page text is not sent to a translation server. Built with PLaMo.

Unofficial. Not affiliated with Preferred Networks.

Requires Firefox 153 or later on desktop (Windows, macOS, or Linux). Tested on Windows. On other desktop systems it should work; when WebGPU is unavailable the model runs on the CPU and may be slower.

Default shortcuts: Alt+Shift+A (page), Alt+Shift+B (bilingual), Alt+Shift+S (selection), Alt+Shift+T (typed text). Change them in Firefox's add-on shortcut settings.

Privacy policy: https://jammaru.com/sakutto/privacy/
```

### Categories

Privacy & Security. The add-on translates on the device and does not send page text to a server.

## Japanese

### Name

```text
Sakutto - ローカルAI翻訳
```

### Summary

```text
ローカルLLMが、この端末の中でページを翻訳します。アカウント不要の無料拡張機能です。
```

### Description

```text
ページ全体の翻訳、選択したテキストの翻訳、手元で入力して訳すことができます。原文を訳文に置き換える表示と、並べて読む対訳表示があります。

広告も分析もありません。本文は外部の翻訳サーバーへ送りません。Built with PLaMo。

非公式です。Preferred Networks とは無関係です。

デスクトップの Firefox 153 以降が必要です（Windows、macOS、Linux）。確認したのは Windows です。ほかのデスクトップでは動く想定です。WebGPU が使えないときは CPU で動き、その場合は遅くなることがあります。

初期ショートカットは Alt+Shift+A（ページ）、Alt+Shift+B（対訳）、Alt+Shift+S（選択）、Alt+Shift+T（入力中の翻訳）です。Firefox のアドオンのショートカット設定で変更できます。

プライバシーポリシー: https://jammaru.com/sakutto/privacy/
```

## 日本語（このファイルについて）

AMO の listed 向けの掲載文案です。gecko id `sakutto@jammaru` は初回アップロードの前に所有者が確認してください。一度出すと変えられません。Chrome 版の速度は書かないでください。対象はデスクトップの Firefox です。確認したのは Windows。macOS と Linux をマニフェストで除外してはいません。Android 向けの `gecko_android` は付けていません。
