# Keyboard shortcuts: browser commands and unset guidance

## Generated manifest evidence

`wxt.config.ts` builds `commands` through `commandSuggestions()` in `src/shared/manifest.ts`.
The generated Chrome manifest, rather than the TypeScript defaults alone, is the authoritative
build evidence.

A WXT Chrome MV3 build (`.output/chrome-mv3/manifest.json`, version 1.6.3 at the time of this
investigation) contains:

| Command               | Generated `suggested_key`                |
| --------------------- | ---------------------------------------- |
| `translate-page`      | `{ "default": "Alt+A", "mac": "Alt+A" }` |
| `toggle-bilingual`    | `{ "default": "Alt+B", "mac": "Alt+B" }` |
| `translate-selection` | `{ "default": "Alt+S", "mac": "Alt+S" }` |
| `translate-compose`   | `{ "default": "Alt+T", "mac": "Alt+T" }` |
| `translate-pdf`       | absent                                   |

There is no `_execute_action` entry. Exactly four commands request a key. The fake-engine WXT
build used for this inspection changes fixture host permissions, not `commandSuggestions()`;
its command manifest is the same as the release configuration.

Chrome accepts at most four commands with `suggested_key`. A fifth makes Chrome reject the whole
extension with `Too many shortcuts specified for 'commands': The maximum is 4`; it is not merely a
warning. The four page commands therefore keep their suggestions, while `translate-pdf` remains
available for an optional user assignment without one.

## Why a suggestion can be 未設定

A suggested key is not a guaranteed assignment:

- Chrome can skip a suggestion when another extension already owns the accelerator. In particular,
  a development install can lose Alt+A/B/S/T to a store build of Sakutto (or vice versa).
- Profiles installed before these commands existed do not reliably gain newly added suggestions on
  an extension update.
- Browser-reserved accelerators and user-cleared preferences can also leave a command empty.

`commands.getAll()` is the live source of truth. An explicitly empty `shortcut` means the browser
has not assigned that command. Adding a key in `chrome://extensions/shortcuts` is the only Chromium
fix; changing the manifest cannot repair an existing profile.

## Runtime content-script injection: no in-page fallback

The release manifest intentionally has no `host_permissions`. Content scripts use
`registration: 'runtime'` and are injected only after the user invokes Sakutto through its popup or
another extension action, which grants `activeTab` access. A page-owned keydown listener therefore
cannot provide dependable shortcut coverage: before that first invocation, no listener exists on
the page at all.

There is deliberately **no in-page keyboard fallback** and no new host permission. Page,
bilingual, selection, and compose commands run only through `browser.commands.onCommand` in the
background. The background uses the existing content-script bridge after activation, including the
shared-folder grant gate. Content scripts still handle local UI keys such as Escape and the compose
panel's Ctrl+Enter, but they do not translate in response to Alt+A/B/S/T keydown events.

`translate-pdf` is likewise background-only. Chrome's built-in PDF viewer has no page into which a
content script can be injected, so an assigned PDF command calls `runGatedPdfCommand` directly.

## Unset notice and current-key display

Popup and options read `commands.getAll()` when opened and again after focus or visibility changes.
When Chromium explicitly reports `translate-page` as empty, both surfaces show a small localized
**Shortcuts are not set / ショートカットが未設定です** notice. Its button calls `tabs.create()` for
`chrome://extensions/shortcuts`; this requires no additional permission. The notice is not
persistently dismissible and disappears automatically once a key is assigned.

The settings rows continue to display the current key for every command. Once a snapshot is
available, an empty or missing command displays **Not set / 未設定**, never a misleading default
that cannot run. Before the first answer, manifest suggestions are only temporary display
placeholders, not active in-page listeners.

Firefox uses its own editor through `commands.openShortcutSettings()` where available. The Chromium
notice and `chrome://` navigation are omitted on Firefox. On install and update,
`restoreEmptyCommandShortcuts()` uses `commands.update()` for empty, never-assigned commands when
Firefox permits it. It does not overwrite customized keys or restore a key the user cleared. If
Firefox refuses an update because of a conflict, the command remains unset; Firefox does not get an
in-page substitute either.

Firefox's manifest suggestions are Alt+Shift+A/B/S/T to avoid Windows menu-bar access keys. Its
generated manifest likewise has no suggested key for `translate-pdf`.
