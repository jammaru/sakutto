# Translating the interface

Sakutto ships its UI strings as Chrome extension locales in `public/_locales/<lang>/messages.json`.
Adding a language is a copy-only change: no TypeScript, no build flag, and no new dependency.

日本語: [TRANSLATING.ja.md](TRANSLATING.ja.md)

## What is already translated

| Catalog | Language             | Source |
| ------- | -------------------- | ------ |
| `en`    | English              | base   |
| `ja`    | Japanese             | base   |
| `ko`    | Korean               | PLaMo  |
| `zh_CN` | Chinese, Simplified  | PLaMo  |
| `zh_TW` | Chinese, Traditional | PLaMo  |
| `es`    | Spanish              | PLaMo  |
| `pt_BR` | Portuguese (Brazil)  | manual |
| `fr`    | French               | PLaMo  |
| `de`    | German               | PLaMo  |
| `it`    | Italian              | PLaMo  |
| `ru`    | Russian              | PLaMo  |
| `vi`    | Vietnamese           | PLaMo  |
| `th`    | Thai                 | PLaMo  |
| `id`    | Indonesian           | PLaMo  |

`pt_BR` is written by hand because PLaMo 3 Translate does not support Portuguese. It translates
only the 53 languages in `SUPPORTED_LANGUAGES`, and `pt` is one of the Chrome-only languages in
`CHROME_ONLY_LANGUAGES`.

## Adding a language

1. Copy the English catalog:

   ```sh
   cp -r public/_locales/en public/_locales/<lang>
   ```

   Use the spelling Chrome uses for a `_locales` directory: a lowercase base tag, and an
   uppercase region when one is needed (`pt_BR`, `zh_CN`, `zh_TW`).

2. Translate the `message` values in the new `messages.json`. Leave every other field alone.

3. Register the directory in `UI_LOCALES` in `src/shared/locales.ts`. The suite fails until this
   matches the directory, so a catalog cannot land in a state Chrome will never pick.

4. Run the checks:

   ```sh
   pnpm test
   pnpm lint
   pnpm typecheck
   ```

## Rules the suite enforces

These are not style preferences. Each one is a bug that shipped or nearly shipped once.

**Keep every key.** A missing key means a raw `__MSG_<key>__` reaches the reader. `tests/locales.test.ts`
compares every catalog against English.

**Keep every `$TOKEN$`.** The text of a message may interpolate `$NAME$`. The `placeholders` block
declares each one and maps it to a positional argument, and the name in the text and the key in
the block have to match up to case.

> A message that interpolates a token its entry does not declare makes Chrome refuse to install
> the whole extension: `Failed to load extension … Variable $LANGUAGES$ used but not defined`.
> This happened once, and no unit test noticed, because the pages render from the JSON rather
> than through Chrome.

Copy the `placeholders` block from English verbatim for a message that has one. Do not add a
placeholder of your own, and do not drop one.

**Keep the brand and the product names.** `extensionName` starts with `Sakutto` in every catalog
and stays inside 75 characters, because the store title has a hard limit. `extensionShortName` is
`Sakutto` in every catalog. `PLaMo`, `PFN`, `Preferred Networks`, `Chrome`, `WebGPU`, `MIT`,
`NOTICE` and `CSV` stay as written.

**Keep the facts.** Three passages carry facts a reader needs before agreeing to the licence:

- the revenue cap in `onboardingCommercialRevenue`
- PFN's registration form in `plamoRegistrationLink`
- the default model size in `onboardingModelNote`, which comes from `src/engine/model/catalog.ts`

Translate them; do not round, soften, or restate the numbers.

## Tone

The UI says what happens, not how impressive it is. Match that.

- Describe the outcome: "The page keeps its original text until the model is ready."
- No exclamation marks, no marketing adjectives, no promises about speed.
- Use the second person the way the English does. Japanese uses です・ます.
- Chrome's built-in translation is only ever the real engine for a pair PLaMo cannot translate,
  and only in Chrome. Firefox hides those languages and that copy (`shortcutHelpFirefox`,
  `engineFirefoxSingleThread`, `tierCpu1`). Never describe the built-in translator as something a
  reader gets while the model loads, or as a faster stand-in.

`tests/locales.test.ts` checks the last point in English and Japanese. If you are adding a
language, read `onboardingUseNow` and `onboardingBridgeNote` carefully.

## Generating a draft with PLaMo

The existing PLaMo-sourced catalogs were produced by running the English strings through the same
model the extension ships, on one GPU, then reviewed. That gives consistent terminology across 13
languages and keeps `$TOKEN$` and brand names intact, which a general-purpose model does not.

Two things to know before you do the same:

- **PLaMo only covers its own 53 languages.** Point it at a language outside `SUPPORTED_LANGUAGES`
  and it silently translates into the nearest one it knows — a `pt` request once produced Polish.
  Check the output before you commit it.
- **Review, do not trust.** Machine output still needs a native reader for tone and for terms like
  "bilingual view". Treat it as a first draft, not as finished copy.

## What not to change

`licenses/` holds verbatim copies of the PLaMo Community License. Do not translate or reformat
them. The licence text is what the agreement is about, and the bundled English and Japanese copies
are the ones the first-run screen links to.
