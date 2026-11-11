# File System Access permission lifetime (Chromium extensions)

This note answers how long a `FileSystemDirectoryHandle` grant lasts for a
`chrome-extension://` origin, whether Chrome 122+ persistent permissions help,
and whether the offscreen engine can keep reading after the picker page closes.
It does **not** pick a product flow. A verified one-copy folder plus a no-click
experience after restart cannot be guaranteed for this architecture.

Environment for this write-up: Chromium `main` (permission context, tracker,
and request manager as fetched 2026-11-11), Google Chrome 156.0.8078.47 on
Linux. Grant lifetime is not platform-specific; the Windows/macOS/Linux
differences in this API are the well-known-path **blocklist**, already covered
in `shared-model-folder.md`. Real Windows Chrome (maintainer) already showed
the post-popup-close failure: the GGUF and sidecar were on disk, translation
was not.

Playwright e2e cannot prove this. `showDirectoryPicker` is mocked with OPFS
handles, which do not go through the local-file permission context. Planted
e2e GGUFs are sparse files with a sidecar pin; a real SHA-256 move does not
complete, so those tests also cannot assert that `sakutto/models` is empty.
One-copy-after-verify is covered by unit tests with real bytes.

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

## 4. Why the OPFS leftover was reverted

`f12eaaa` kept the OPFS file after a verified move because Chrome drops the
directory grant when the popup closes. That is two copies on disk, which the
owner rejected. The move path again deletes OPFS after size + SHA-256 succeed
in the engine host. That host often still has the grant (the popup is open
for the picker click), so “readable from the load context” is true at delete
time and false moments later. The confirmation is not durable.

## 5. Options (not chosen)

A single on-disk copy **and** a guaranteed no-click restart is not something
this extension can promise. Extended permission is the only no-click path, and
it is a user choice on a tab restore prompt that the popup path never shows.

| Option                                                                                                                         | One copy                   | After popup closes                                                                                                                  | After restart                                                                                                    | Cost                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **A. Keep OPFS as fallback** (reverted)                                                                                        | No                         | Works                                                                                                                               | Works                                                                                                            | Two copies. Owner rejected.                                                                                                      |
| **B. Rely on “Allow on every visit”**                                                                                          | Yes, after a verified move | Works only if extended is already on, or the picker tab is still open                                                               | No-click only after the user has accepted the restore prompt **from a tab**                                      | Cannot force it. Popup auto-grant skips the prompt forever if the user never opens Options as a tab. First visit never shows it. |
| **C. Re-grant click** (popup 「モデルフォルダへのアクセスを許可」, or Settings which already has `modelFolderPermissionGrant`) | Yes                        | Fails unless the model is already loaded in offscreen memory **before** the popup closes. A later lazy load cannot read the folder. | One click per session (popup auto-grants, usually no Chrome dialog). Then load the GGUF before the popup closes. | Honest. Breaks “click Translate on a page with no extension UI”. Offscreen idle-kill / browser restart needs the click again.    |
| **D. Read the GGUF from a page that holds the grant** (popup/options as engine host, or a sticky tab)                          | Yes                        | Works while that page stays open                                                                                                    | Dies when it closes, unless extended permission                                                                  | Popup is destroyed on close. A hidden tab is hostile UX and still needs extended permission for restart.                         |
| **E. Load into WASM while the grant is live, then drop the file handle**                                                       | Yes                        | Works until offscreen is discarded                                                                                                  | Needs a re-grant (C) to reload ~573 MB / 1.81 GB                                                                 | Session can survive popup close; restart cannot. Chrome may still kill the offscreen document.                                   |
| **F. Proposal 2 (native helper)**                                                                                              | Yes                        | Yes                                                                                                                                 | Yes                                                                                                              | Out of scope.                                                                                                                    |

Rules that any later choice still has to meet:

- Do not delete the OPFS original until the **engine** context has actually
  read the verified folder copy. That check is not a substitute for a grant
  that outlives the picker page.
- If permission is missing, show a restore path. Do not fail silently.
- Do not download the model again because the grant expired.

Settings already has `Allow folder access` (`requestFolderPermission` on the
stored handle). The popup currently only links to Settings. That is not a
chosen flow; it is leftover UI from the original design.

## 6. What to decide

Need a product pick among B–E (or F). Until then:

- Move is one copy on disk after verify (owner requirement).
- Translation after the picker page closes, and after restart, is **not**
  guaranteed for a shared folder. That matches real Chrome (Windows) after
  `d699eab`.
- e2e that mocks `showDirectoryPicker` with OPFS cannot catch this.
