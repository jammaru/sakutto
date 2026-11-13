# File System Access permission lifetime (Chromium extensions)

This note answers how long a `FileSystemDirectoryHandle` grant lasts for a
`chrome-extension://` origin, whether Chrome 122+ persistent permissions help,
and whether the offscreen engine can keep reading after the picker page closes.
The product flow is **B + C**: first grant from a real extension tab (so Chrome
can offer “Allow on every visit”), then a one-click restore whenever the grant
is not active. The verified folder copy is backed by the retained OPFS copy;
a no-click restart is still not something Sakutto can promise, because the UI
detects the live grant and never claims persistence.

Environment for this write-up: Chromium `main` (permission context, tracker,
and request manager as fetched 2026-11-11), Google Chrome 156.0.8078.47 on
Linux. Grant lifetime is not platform-specific; the Windows/macOS/Linux
differences in this API are the well-known-path **blocklist**, already covered
in `shared-model-folder.md`. Real Windows Chrome (maintainer) already showed
the post-popup-close failure: the GGUF and sidecar were on disk, translation
was not.

Playwright e2e cannot prove this. `showDirectoryPicker` is mocked with OPFS
handles, which do not go through the local-file permission context. Planted
e2e GGUFs are sparse files with a sidecar pin; a real SHA-256 copy does not
complete, so those tests cannot prove fallback retention. Copy verification,
OPFS retention, and fallback on a revoked grant are covered by unit tests
with real bytes.

## 1. When is an extension directory grant revoked?

Chrome keeps two models at once
([`chrome_file_system_access_permission_context.h`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/file_system_access/chrome_file_system_access_permission_context.h)):

1. **Active grants**, origin-wide. When the last tracked page of that origin
   goes away, they are revoked (`PermissionStatus::ASK`).
2. **Persisted objects** (dormant / shadow / extended). These can auto-grant
   later only in the cases in section 2.

The last-page signal is `OneTimePermissionsTracker::OnLastPageFromOriginClosed`
→ `ChromeFileSystemAccessPermissionContext::CleanupPermissions`.

```cc
void ChromeFileSystemAccessPermissionContext::CleanupPermissions(
    const url::Origin& origin) {
  if (/* persistent permissions enabled */) {
    if (!OriginHasExtendedPermission(origin) &&
        GetPersistedGrantStatus(origin) == PersistedGrantStatus::kLoaded) {
      RevokeObjectPermissions(origin);
    }
    SetPersistedGrantStatus(origin, PersistedGrantStatus::kLoaded);
  }
  RevokeActiveGrants(origin);  // in-memory grant → ASK
}
```

Source:
[`chrome_file_system_access_permission_context.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc)
(`OnLastPageFromOriginClosed`, `CleanupPermissions`).

Which pages count? `OneTimePermissionsTrackerHelper` is attached from
[`chrome/browser/ui/tab_helpers.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/ui/tab_helpers.cc).
It registers `NewActivePage(origin)` for that WebContents. The last-page
timeout in the tracker factory is **0 seconds**.

An MV3 offscreen document is `mojom::ViewType::kOffscreenDocument`
([`extensions/browser/offscreen_document_host.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/browser/offscreen_document_host.cc)).
It is not a tab, so it does not keep the origin “visited”. Closing the popup
or onboarding tab is enough for `CleanupPermissions` even if offscreen is
still running.

Also revoked without closing the last page: all tabs of the origin backgrounded
for the long one-time-permission lifetime
(`OnAllTabsInBackgroundTimerExpired` → `RevokeActiveGrants`). Chrome’s own
FSA docs still describe the older wording: access lasts until every tab of
the origin is closed
([File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access#stored_file_or_directory_handles_and_permissions)).

After revocation, a handle loaded from IndexedDB typically reports
`queryPermission() === 'prompt'`. Reads throw `NotAllowedError` /
`SecurityError`. `requestPermission()` is required to restore an active grant.

## 2. Do Chrome 122+ persistent permissions apply to `chrome-extension://`?

The API exists for every origin, including extensions. It is **not** on by
default for extensions.

`OriginHasExtendedPermission(origin)` is true only when
([same `.cc` file](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc)):

- content setting `FILE_SYSTEM_ACCESS_EXTENDED_PERMISSION` is `ALLOW`, or
- the origin is an installed PWA with OS integration (and the user has not
  blocked extended permission).

A Chrome extension is not a PWA. Installing the extension does **not** take
the “installed app, persist automatically” path from
[Persistent permissions for the File System Access API](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api).

The `ALLOW` content setting is set when the user picks **Allow on every visit**
on the restore prompt (`OnRestorePermissionAllowedEveryTime`), or from the
site’s File System Access page-info UI.

That restore prompt is **not** shown from a popup, side panel, or offscreen
document. `FileSystemAccessPermissionRequestManager::FromWebContents` looks up
`tabs::TabInterface::MaybeGetFromContents`
([`file_system_access_permission_request_manager.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/file_system_access/file_system_access_permission_request_manager.cc)).
No tab → no manager. For `chrome-extension://` in that situation Chrome
**auto-grants** and writes a persisted object, without the three-way prompt:

```cc
// Extension contexts (popup, side panel) may not have a permission
// request manager attached. ... auto-grant ... without showing an
// additional prompt.
if (origin.scheme() == "chrome-extension") {
  SetStatus(GRANTED, kUpdatePersistedPermission);
  return;
}
```

So:

| Surface                      | Restore prompt (“Allow on every visit”)                                      | After popup/tab closes           | After restart, no click                                                            |
| ---------------------------- | ---------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| Popup / side panel           | Never. Auto-grant for this visit only.                                       | Active grant revoked.            | `queryPermission` is `prompt`.                                                     |
| Options / onboarding **tab** | Yes, on a later visit, if grants are dormant and `requestPermission()` runs. | Same revocation unless extended. | Auto-grant from offscreen only if the user already chose **Allow on every visit**. |
| Offscreen                    | Cannot prompt.                                                               | Does not keep the origin alive.  | Cannot call `requestPermission` (below).                                           |

`IsEligibleToUpgradePermissionRequestToRestorePrompt` excludes Chrome Apps
(`is_platform_app()`), not MV3 extensions. A **tab** can therefore show the
three-way prompt. A popup never will.

Shadow grants (current visit, no extended permission) can auto-grant without a
prompt. Dormant grants (after last page closed / after restart) cannot:
`CanAutoGrantViaPersistentPermission` allows only `kExtended` and `kShadow`,
not `kDormant`.

## 3. Can a grant survive into offscreen with no user gesture?

**Same visit, picker page still open:** yes. Permissions are origin-scoped.
While the popup or options tab holds an active grant, offscreen
(`chrome-extension://<id>/…`) can `queryPermission` → `granted` and
`getFile()` without a gesture.

**After that page closes, without extended permission:** no. Active grants are
gone. Offscreen is a `Window`, but `FileSystemHandle.requestPermission()`
requires **transient user activation**
([WICG File System Access](https://wicg.github.io/file-system-access/#api-filesystemhandle-requestpermission),
[MDN](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemHandle/requestPermission)).
Offscreen documents cannot be focused and have no user input
([chrome.offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)),
so the call throws `SecurityError` in Blink before Chrome’s extension
auto-grant path runs.

**After restart, with extended permission:** yes, in principle. Offscreen can
open the IndexedDB handle; `CanAutoGrantViaPersistentPermission` upgrades the
grant without a gesture. That state is only reached if the user previously
chose **Allow on every visit** from a **tab**. Sakutto cannot set that content
setting itself.

## 4. Why the OPFS copy is retained

Chrome drops an ordinary directory grant when the last tracked page of the
origin closes. A successful read in the engine host right after the copy only
proves that the grant is active _now_; it does not prove that Chrome stored
`FILE_SYSTEM_ACCESS_EXTENDED_PERMISSION` for the origin. Deleting OPFS on that
evidence left users with no fallback moments later.

Sakutto therefore keeps the verified OPFS copy after the shared-folder copy
succeeds. It is deleted only when the user presses **Delete browser copy** in
Settings. This is the deliberate fallback for a revoked folder grant. We do
not claim that the folder permission is persistent: Chrome exposes no API that
tells an extension whether the user chose **Allow on every visit**.

## 5. Chosen flow: B + C, with an OPFS fallback

A verified shared-folder copy and the OPFS fallback can coexist. Missing
permission never starts a network download: the engine uses the retained OPFS
file if it is present, otherwise it stops with `model-folder-permission` and
shows the one-click restore control. The manual delete control lets a user
reclaim the duplicate space once they are satisfied with the folder grant.

**B — first grant from a tab.** `showDirectoryPicker` and
`requestPermission({ mode: 'readwrite' })` run on onboarding or Settings
(`options.html`), which are real tabs. Chrome _may_ later show **Allow on every
visit** on a tab restore prompt. The popup does not offer a move to a shared
folder. Opt-in is Settings only. Copy does not say the user will never
need to click again. Persistence is detected at runtime
(`queryPermission === 'granted'` and a successful open), not assumed.

**C — one-click restore.** Whenever `queryPermission !== 'granted'`, or a read
throws `NotAllowedError` / `SecurityError`, the engine stops with
`model-folder-permission` (not `model-missing`). Popup and Settings show
「フォルダへのアクセスを許可」. The in-page / sample overlay points at that
button. One click runs `requestPermission` in that document, reloads the
folder session, warms the engine, and retries empty page blocks. No
notifications, badges, or tabs opened by themselves.

**D, cheap only.** While any extension page of this origin still holds an
active grant, offscreen can read the same handle. The engine tries to open
the stored handle even when `queryPermission` is `prompt`. There is no hidden
always-open document.

| After last tab/popup closes                                                         | After restart, no click                                                     | After one restore click                                                |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Fails unless a tab is still open or the model is already loaded in offscreen memory | Works only if the user previously chose **Allow on every visit** from a tab | Popup auto-grants this visit; Settings tab can show the restore prompt |

## 6. What to retest on a real PC

Playwright cannot prove FSA grant lifetime (the picker is mocked with OPFS
handles). Use a real GGUF (not the e2e sparse plant).

1. **Chrome, new profile.** Install the unpacked build. First-run keeps
   browser storage preselected. To try the folder, opt in on onboarding or
   pick `Documents\Sakutto` from the Settings tab. Watch whether Chrome
   offers **Allow on every visit** (Japanese Chrome:
   「サイトアクセス時は常に許可」; the three options are
   「今回のみ許可」 / 「サイトアクセス時は常に許可」 / 「許可しない」);
   it may not. Translate a page. Close
   every Sakutto tab and the popup. Translate again. If it stops, the popup
   must show 「フォルダへのアクセスを許可」 (no download). One click should
   resume. Restart Chrome. Same: no silent failure, no re-download, one
   click if needed. If Chrome did persist, translation may work with no
   click — that is detected, not promised.
2. **Existing-user migration.** Profile that already has the model in OPFS
   (browser storage). After update, the popup must **not** ask to move.
   Choose `Documents\Sakutto` from Settings if the user wants a shared
   folder. After the copy finishes, the shared GGUF must verify and the OPFS
   `sakutto/models` copy must still be there as a fallback. Settings offers
   **Delete browser copy** once the folder copy is ready. Then the same
   close/restart checks as (1).
3. **Edge.** Repeat (1) from a **Settings tab**, not the popup. If Edge
   shows the three-way prompt, pick **Allow on every visit** in English or
   「常に許可」 in Japanese Edge. Japanese Chrome labels the same choice
   「サイトアクセス時は常に許可」. If Edge does not offer it, or it does
   not persist, the popup must show 「フォルダへのアクセスを許可」 after
   restart (no download card). One click is enough for that visit, and the
   retained OPFS copy can translate without the folder. See §8.

4. **Second Chrome profile.** Profile A has a persistent grant on
   `Documents\Sakutto`. Profile B picks the same folder. Profile A must not
   be asked again after a restart. If it is, note whether B recopied the
   GGUF (mtime change) or A’s extension reloaded.

Never: notifications, badges, or a tab that opens by itself. Never delete the
OPFS fallback merely because a folder read succeeded once. Never a download
when the GGUF is already in the folder or OPFS and only folder permission is
missing.

## 7. Second Chrome profile, same `Documents\Sakutto`

Findings (code + Chromium, not a guess about the maintainer’s machine):

**What our code could do.** `copyOneFallback` used to treat a pin-sized
folder file with a stale sidecar (`needs-hash`) as an empty slot and copy
from OPFS on top of it. `ModelFileStore.move` deletes the destination first
(`removeEntry`) then writes a new GGUF. Chromium revokes the **writing
origin’s** file-path grant on `removeEntry`
([NotifyEntryRemoved / `FileSystemAccessRevokeReadOnRemove`](https://github.com/marklove5102/supermium/commit/d9b1ba060eb32ee690fc5c9f2b8ab5c0e6a5a73d);
parent directory grants stay). Sidecar writes used `remove` then `append`.
A second profile that hashed a lastModified mismatch would rewrite
`.verified.json` and, before this change, could replace the GGUF.

**What our code now does.** A folder file that is not `missing` is never
replaced. Sidecar writes overwrite in place (`createWriter` at offset 0).
`adoptPresentModels` may still hash a `needs-hash` file and refresh the
sidecar; it does not delete or rewrite the GGUF. Recorded model ids are
stored on the IndexedDB handle so a missing grant can say “the model is in
the folder” without reading it. Restore UI tries a silent directory read
before showing the button (`probeStoredFolderReadable`);
`queryPermission === 'prompt'` alone is not enough.

**What we cannot control (per-profile Chromium).**
`HostContentSettingsMap` / `FILE_SYSTEM_ACCESS_EXTENDED_PERMISSION` is
**per Profile**. Profile B granting the same path cannot flip profile A’s
content setting. Directory grants are keyed by **path**, not inode
([`PathAsPermissionKey`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc)).
Documented cases that _do_ clear an origin’s persisted FSA objects in the
same profile: last page of the origin closed without extended permission
(`CleanupPermissions` → `RevokeObjectPermissions`); user reset in site
settings; extension update/reload (Chromium-extensions thread: file
permissions “auto-remove on each update”). Loading the same unpacked
directory in profile B can reload that unpacked extension for other
profiles that pointed at the same files — that is Chrome, not Sakutto.

## 8. Edge: can an extension FSA grant persist across restarts?

Sources only. Current stable Edge is Chromium-based; there is no
Edge-only File System Access API.

**Chrome 122 persistent permissions** (“Allow this time” / “Allow on every
visit” / site-settings file list) are documented for Chrome, not as an
Edge feature page:
[Persistent permissions for the File System Access API](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api).
The flag `kFileSystemAccessPersistentPermissions` is
**enabled by default** in Chromium
([`file_system_access_features.cc`](https://chromium.googlesource.com/chromium/src/+/5f26a56181d7bb9e2ead30b4cdd9d12b6e7ac58a/chrome/browser/file_system_access/file_system_access_features.cc)).
A Chromium Edge **extension** did get “Allow on every visit” in 122+:
[Kiwix JS, r/Kiwix, 2024-03-03](https://www.reddit.com/r/Kiwix/comments/1b5n2qc/new_you_can_now_automatically_reopen_a_zim_in_the/)
(author: works in Chrome, Edge, Brave > 122 if the user picks that option;
often on the second or third restore). Electron’s tracker treats
“Chrome/Edge 122+” as the browsers where persisted handles need no
gesture: [electron#41957](https://github.com/electron/electron/issues/41957).

**Ordinary user, realistically**

1. Grant from a **tab** (Settings / onboarding), not the popup. Chromium
   auto-grants popup/side-panel `requestPermission` for
   `chrome-extension://` without the three-way prompt (same as Chrome;
   `FileSystemAccessPermissionRequestManager` needs
   `tabs::TabInterface`). A popup click is this-visit only.
2. If Edge shows **Allow on every visit**, pick it (Japanese Edge:
   「常に許可」). Japanese Chrome’s matching prompt is
   「今回のみ許可」 / 「サイトアクセス時は常に許可」 / 「許可しない」.
   That sets
   `FILE_SYSTEM_ACCESS_EXTENDED_PERMISSION` ALLOW. After restart,
   offscreen can auto-grant with no click. This is the only no-click
   restart path. It does not always appear (same as Chrome).
3. Site settings: `edge://settings/content/fileEditing` (File editing —
   “Ask when a site wants to edit files or folders”) exists in Edge since
   83 ([Tech Community, 2020-04-07](https://techcommunity.microsoft.com/discussions/edgeinsiderdiscussions/new-option-file-editing-permission-in-edge/1289541)).
   Chromium’s launch icon next to File editing that lists granted
   files/folders is the Chrome 122 UI; Edge’s page is the older Ask/Block
   toggle. There is no documented `edge://settings/content` control that
   forces persistence for `chrome-extension://`.
4. **Enterprise policies** (Microsoft Learn):
   [`FileSystemReadAskForUrls`](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/filesystemreadaskforurls),
   `FileSystemReadBlockedForUrls`,
   [`FileSystemWriteAskForUrls`](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/filesystemwriteaskforurls),
   `FileSystemWriteBlockedForUrls`,
   [`DefaultFileSystemWriteGuardSetting`](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/defaultfilesystemwriteguardsetting)
   (2 = block, 3 = ask). Official Edge and Chrome enterprise lists have
   **no** `FileSystemReadAllowedForUrls` / `FileSystemWriteAllowedForUrls`
   that silently allow. Ask-for-URLs only lets the origin **prompt**; it
   does not persist a grant across restarts.
5. **Flags.** Chrome 120–121 used
   `chrome://flags/#file-system-access-persistent-permission`. The feature
   is default-on in current Chromium. Edge does not publish a matching
   `edge://flags` article. An ordinary user should not need a flag.
6. Installing the extension is **not** the PWA “installed app, persist
   automatically” path (same Chromium `OriginHasExtendedPermission` as
   Chrome).

**Default is browser storage for everyone.** First-run on Chrome and Edge
preselects OPFS (`defaultOnboardingStoreChoice`). The shared folder is
opt-in for people who use both browsers (one GGUF). Existing folder users
keep the folder; there is no forced migration. Grant from a Settings tab
and pick **Allow on every visit**. Japanese Chrome labels it
「サイトアクセス時は常に許可」; Japanese Edge labels it 「常に許可」 when
the prompt is offered. Edge 122+ can persist if that tab prompt appears.
After restart Sakutto uses the retained OPFS copy if the grant is gone, or
shows one-click restore when neither store is readable. A re-grant may
sometimes be needed; copy says so. `isMicrosoftEdge()` is still used for
runtime labels, not for a different storage default.
