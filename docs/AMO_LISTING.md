# AMO listing text

Draft for a listed add-on on addons.mozilla.org. The packaged name still comes from
`public/_locales/*/messages.json` (`extensionName` / `extensionShortName`). Confirm the gecko id
`sakutto@jammaru` in `src/shared/browser.ts` before the first listed upload. It cannot change
afterwards.

Do not paste Chrome Web Store speed numbers. Firefox GPU and CPU times must be measured on a
Windows Firefox 153+ machine before any claim is added.

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

Requires Firefox 153 or later on Windows. WebGPU is used when the GPU allows it; otherwise the model runs on the CPU with one thread. Firefox extension pages cannot use wasm threads.

Default shortcuts are Alt+Shift+A (page), Alt+Shift+B (bilingual), and Alt+Shift+S (selection), so they do not collide with the Windows menu bar.

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

Windows の Firefox 153 以降が必要です。GPU が使えるときは WebGPU を使い、使えないときは CPU の 1 スレッドで動かします。Firefox の拡張機能ページでは wasm のマルチスレッドは使えません。

初期ショートカットは Alt+Shift+A（ページ）、Alt+Shift+B（対訳）、Alt+Shift+S（選択）です。Windows のメニューと重ならないようにしてあります。

プライバシーポリシー: https://jammaru.com/sakutto/privacy/
```

## 日本語（このファイルについて）

AMO の listed 向けの掲載文案です。gecko id `sakutto@jammaru` は初回アップロードの前に所有者が確認してください。一度出すと変えられません。Chrome 版の速度は書かないでください。
