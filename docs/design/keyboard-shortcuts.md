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

## Runtime content-script injection and the gated in-page fallback

The release manifest intentionally has no `host_permissions`. Content scripts use
`registration: 'runtime'`. By default they are injected only after the user invokes Sakutto
through its popup or another extension action, which grants `activeTab` access.

There is one optional, off-by-default all-sites choice in Settings
(`src/dom/all-sites.ts`). Its click requests the two already-declared optional origins
(`https://*/*`, `http://*/*`) with `permissions.request` as the first awaited call. After that
grant the background registers the same general bundle (`/content-scripts/content.js`,
`run_at: document_idle`, top frame only, `persistAcrossSessions: true`) with
`scripting.registerContentScripts`, sweeps already-open http/https tabs once through
`ensureContentScript`, and re-syncs on service-worker startup, `runtime.onInstalled`, and
`permissions.onAdded` / `onRemoved`. The live permission is the source of truth: a revoke from
the browser's extension settings unregisters, and no prompt appears on startup.

The grant also covers every later per-site optional-host request — always-translate, video
captions, the mail banner, a custom caption host, or the local server. Those clicks read a
synchronous snapshot of the grant and turn the feature on without calling
`permissions.request`, which Chrome would otherwise still prompt for even though
`permissions.contains` already reports the narrower origin as granted. Turning the control
off removes only the two broad origins: a narrower grant the user made earlier stays granted,
and a feature that only worked under the broad grant uses today's one-time prompt again on
its next explicit enable.

On a host whose site rule is `never`, this passive injection shows no selection button; an explicit popup,
context-menu, or assigned-command path keeps today's behavior.

With the all-sites grant on, the passive injection also restores the in-page defaults for commands
the browser has never assigned. A command whose live `commands.getAll()` binding is empty **and**
whose persisted `shortcutAssigned` flag is not `true` listens for the per-OS key on http/https
pages from page load, without waiting for a popup, context menu, or command gesture. The
background includes the grant state with the shortcut query because a content script cannot call
`permissions.contains` itself. The listeners follow the live grant and re-read the bindings on
focus or visibility changes, so turning the grant on or off takes effect without a reload.

A command the browser has assigned always belongs exclusively to `browser.commands.onCommand`;
the page listener is empty for it, so one physical press cannot run the command twice. A command
whose key the reader cleared after it was assigned has `assigned === true` and stays empty too.

Without the all-sites grant, behavior is unchanged from #118: page, bilingual, selection, and
compose commands run only through `browser.commands.onCommand` in the background after an
explicit activation. No page Alt+A/B/S/T translation listeners are installed, and there is no new
host permission beyond those two optional origins. The background still uses the existing
content-script bridge after activation, including the shared-folder grant gate.
Content scripts continue to handle local UI keys such as Escape and the compose panel's
Ctrl+Enter regardless of the grant.

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
