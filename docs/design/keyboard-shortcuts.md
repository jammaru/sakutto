# Keyboard shortcut assignment and fallback

## Root cause: a suggested key is not an assigned key

`wxt.config.ts` builds `commands` through `commandSuggestions()` in
`src/shared/manifest.ts`. The generated Chrome manifest is therefore the authoritative build
evidence, rather than the TypeScript defaults alone.

A WXT Chrome MV3 build (`.output/chrome-mv3/manifest.json`, version 1.6.3 at the time of this
investigation) contains:

| Command               | Generated `suggested_key`                |
| --------------------- | ---------------------------------------- |
| `translate-page`      | `{ "default": "Alt+A", "mac": "Alt+A" }` |
| `toggle-bilingual`    | `{ "default": "Alt+B", "mac": "Alt+B" }` |
| `translate-selection` | `{ "default": "Alt+S", "mac": "Alt+S" }` |
| `translate-compose`   | `{ "default": "Alt+T", "mac": "Alt+T" }` |
| `translate-pdf`       | absent                                   |

There is no `_execute_action` entry. Thus exactly four commands request a key. The fake-engine
WXT build used for this inspection changes fixture host permissions, not `commandSuggestions()`;
its command manifest is the same as the release configuration.

The following Chrome rules explain why users can nevertheless see **Not set / 未設定** in
`chrome://extensions/shortcuts`:

1. **Four-key limit.** Chrome accepts at most four commands with `suggested_key` per extension.
   The four page commands consume that allowance. Adding one to `translate-pdf` (or an explicit
   `_execute_action`) would make five.
2. **A fifth key invalidates the manifest.** This is not a warning or a command that merely stays
   unset. Chrome refuses to load the extension with
   `Too many shortcuts specified for 'commands': The maximum is 4`.
3. **Suggestions are not guaranteed assignments.** A browser or another extension can already own
   a suggested accelerator. Chrome can then leave the command empty, which the shortcut editor
   displays as 未設定. Reserved browser accelerators must not be used as defaults.
4. **Existing installs do not gain new suggestions on update.** Changing or adding a
   `suggested_key` in a later manifest does not reliably populate a command that is empty in an
   existing profile. Chrome retains the extension's current command preferences, including a key
   the user deliberately cleared. Consequently, shipping the four manifest keys alone cannot fix
   older installations.

## Assignment policy

The background reads `commands.getAll()` and persists an independent `shortcutAssigned` map:

- A non-empty browser binding is used only by `commands.onCommand`. The content script must not
  also listen for that default or customized key; one physical press must have one owner.
- An empty binding with `assigned: false` means the command has never been observed with a key
  (for example, an install conflict or an old install that stayed 未設定). Only then may a content
  script handle the platform default in a web page.
- An empty binding with `assigned: true` means the user cleared a previously assigned key. The
  command remains off; fallback must not undo that choice.
- Before the first `getAll()` answer there is no in-page listener. Optimistically listening for a
  default during startup could double-fire an already assigned browser command.

The worker caches the latest complete query result. It refreshes on worker startup, `onInstalled`,
and `onStartup`; popup/options/onboarding queries refresh when opened and after focus or visibility
changes. Content scripts may use the cached result at injection, then force a refresh on page
focus, visibility restoration, and BFCache return. Refreshes are serialized so an older read cannot
overwrite an install/update read.

In-page page, bilingual, and selection commands ignore editable targets. Compose is the exception:
it runs in an eligible editable field. All in-page commands ignore `event.isComposing` and
`event.repeat`.

## Shared command routing and PDF

Page, bilingual, selection, and compose fallback enter the same content dispatcher as browser
commands. Page/selection/bilingual therefore retain the shared-folder arm gate from #114 and keep
selection capture before asynchronous arming.

`translate-pdf` is different. Chrome's built-in PDF viewer has no page into which this fallback can
be injected, so there is intentionally no content-script PDF fallback. The command remains declared
without a suggested key. If the user assigns one, only the background handles it and calls
`runGatedPdfCommand`, preserving the same folder grant gate as the other background actions.

## Firefox

Firefox uses `Alt+Shift+A/B/S/T` suggestions to avoid Windows menu-bar access keys. On install and
update, `restoreEmptyCommandShortcuts()` calls `commands.update()` where available for empty,
never-assigned commands. It does not overwrite customized keys or restore a key the user cleared.
If Firefox refuses an update because of a conflict, the same never-assigned in-page fallback keeps
the command usable.
