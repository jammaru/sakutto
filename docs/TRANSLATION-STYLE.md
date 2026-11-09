# Translation writing style

日本語: [TRANSLATION-STYLE.ja.md](TRANSLATION-STYLE.ja.md)

Sakutto can ask PLaMo 3 Translate for a writing style (Formal, Business, Casual, and so on) that is
separate from Japanese sentence endings (`form`: です・ます / だ・である). The default is
**Neutral**. Neutral builds the same PFML3 prompt the extension built before this setting existed.

This document records what PFN's model cards actually support, and how Sakutto uses that.

## What the model was trained on

Sources: the PLaMo 3 Translate model cards on Hugging Face (`pfnet/plamo-3-translate-2b` and
siblings, English and Japanese READMEs) and the official PFML3 prompt template.

PLaMo 3 Translate is a translation-only model. Production prompts are handwritten PFML3, not a
chat with a system message. PFN says to pass options as `apply_chat_template` / PFML3 fields, **not**
in a system message and **not** in the source text.

| Field           | Official values           | What it is for                                                                                                                                                                                                                                               |
| --------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `output` `lang` | Target language code      | Required.                                                                                                                                                                                                                                                    |
| `output` `form` | `plain` or `polite`       | Japanese sentence endings only (`target_lang=ja`). だ・である vs です・ます. No other `form` values are documented.                                                                                                                                          |
| `context`       | Free text                 | "Reference context for interpreting the source text, such as the surrounding text or the situation." PFN's examples are a situation that disambiguates かみ ("工作で折り紙を作っています。") and a page type ("プロジェクト管理ツールのヘルプページです。"). |
| `glossary`      | `source` / `target` pairs | Term translations.                                                                                                                                                                                                                                           |

The word "style" in the model card refers to `form` (plain / polite), not a general tone enum.
There is no `form=formal`, `form=casual`, or similar.

PLaMo 2 Translate used a different prompt (`<|plamo:op|>`) and did not document `form` or
`context`. Sakutto ships PLaMo 3 Translate only.

## How Sakutto encodes a style

- **Neutral** (default): no extra `context`. The prompt is byte-identical to the previous
  default, including `form=polite` or `form=plain` when the target is Japanese.
- **Other styles, target `ja` or `en` only**: a short situation / document-type sentence is
  written into the trained `context` field, in the source language when that source is Japanese
  or English, otherwise in the target language. Examples: `公式文書です。`, `This is a business
document.` These follow PFN's page-type / situation examples. They are not imperatives
  ("translate formally", "do not add content").
- **Other target languages**: no style list. The model has no documented style enum for them,
  and inventing `form` values or stuffing instructions into the source would not be a trained
  mechanism.
- **`form` and style stay independent.** A Japanese target can be です・ます and Casual, or だ・である
  and Formal, in one prompt.

What was not shipped:

- Putting style instructions in the source text or in a system message (PFN forbids both for
  production options).
- Extra `form` values the model was not trained on.
- A generic style list for Korean, Chinese, and the rest. `context` exists for every language,
  but there is no official per-language style menu, and a guessed list would still only be
  situation text.

Logical is the weakest mapping: PFN's `context` examples are situations and document types, not
"make the argument clearer." The situation used is "an explanation that states claims and
causes," not a rewrite instruction. It still needs a real-model check for meaning drift.

## Accuracy

Style must not change meaning, drop or add content, or break the glossary, placeholders, or
markup. Neutral exists so existing users see no prompt change. Non-neutral styles can still
nudge word choice the wrong way; that is why `pnpm style:eval` exists.

Page translation, selection translation, compose/typing translation, and the typed-text page
all pass the same saved `style` into the engine.

## Running the local eval

Unit tests cover prompt bytes only. They do not load PLaMo weights.

```sh
llama-server -m plamo-3-translate-0.8b-Q4_K_M.gguf -ngl 99 -c 4096 --port 11501
pnpm style:eval
```

`SAKUTTO_PLAMO_URL` overrides the default `http://127.0.0.1:11501`. Without a server, the script
still prints each style's prompt and confirms Neutral is unchanged, then exits 0. With a server
it translates fixed ja↔en samples, compares each style to Neutral, and flags length-ratio
swings, dropped numbers / entities / placeholders / glossary terms, and leakage of the
situation sentence into the translation. A flag is a heuristic, not a proof of a mistranslation.
Read the printed translations.

This cloud environment does not have PLaMo weights. The maintainer's machine does, if the
extension already runs there.
