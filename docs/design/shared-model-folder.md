# Shared model folder (Chromium File System Access)

Opt-in storage for official PFN GGUF files on Chromium, via
`showDirectoryPicker`. Firefox and pages without a picker keep OPFS and show
no choice. Chromium first-run (Chrome and Edge alike) recommends browser
storage (OPFS). The shared folder is an opt-in for people who use both
Chrome and Edge, so one GGUF copy is shared between them. A profile that
already uses a folder keeps it; there is no forced migration. Proposal 2 (a
native helper) is out of scope.

This note names no issue authors. The picker copy and the Chromium blocklist
below are the reason Documents itself is not an advertised choice.

## What the user selects

The picker opens in Documents (`startIn: 'documents'`, id `sakutto-models`).
Copy on onboarding and Settings tells the user to create a folder named
`Sakutto` there (or open it if it already exists) and select
`Documents\Sakutto`. Selecting Documents itself cannot work in real Chrome.
On Chromium onboarding, save in this browser is first, labelled recommended,
and preselected. The shared-folder option is second, described as for Chrome
and Edge together; the picker steps and the persistence hint sit under it.
The popup never asks an OPFS user to move. After first-run browser storage,
the folder stays a quiet Settings option (“Share the model between Chrome
and Edge” / 「ChromeとEdgeでモデルを共有する」). Grant from the Settings
tab and pick “Allow on every visit” (Japanese Chrome:
「サイトアクセス時は常に許可」; Japanese Edge:
「アクセスするたびに確認する」). A one-click re-grant may sometimes be
needed. Cancel or Chrome's block dialog stays on the screen with the same
one-line hint and does not download.

A Settings pick runs `showDirectoryPicker` and `requestPermission` on that
tab (Chrome can offer “Allow on every visit”). The copy into the folder
still verifies size and SHA-256, then deletes the OPFS original so disk holds
one copy. Folder reload drops the previous runtime so the next request does
not keep reading a deleted OPFS blob.

Chrome can drop the directory grant when the last tracked page of the origin
closes. Offscreen cannot call `requestPermission`. The product flow is B + C:
grant from a tab, then a one-click restore in the popup or Settings when the
grant is gone. Details and Chromium sources are in
`docs/design/fsa-permission-lifetime.md`. Persistence is detected, not claimed.

Layout after a successful pick:

`<chosen>/sakutto-models/<official GGUF>`

The usual chosen folder is `Documents/Sakutto`. Integrity sidecars are
`<official name>.verified.json`. In-flight downloads use `.part`.

## Chromium will not grant well-known roots

Chrome's File System Access permission context keeps a hard-coded blocklist.
Selecting a blocked directory shows Chrome's own dialog (Japanese:
「このフォルダを開けません — システム ファイルが含まれているため…開くことができません」).
Dismissing that dialog rejects `showDirectoryPicker` with `AbortError`, the
same error as a normal cancel. Sakutto stays on the current screen, does not
download, and repeats the picker steps.

Source (Chromium `main` at `733d6da6f2a59e2c6f477736afc817967cf7c547`):

[`chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc`](https://chromium.googlesource.com/chromium/src/+/733d6da6f2a59e2c6f477736afc817967cf7c547/chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc)

`GenerateBlockPaths()` (`kBlockPaths`, around lines 486–644) and
`ShouldBlockAccessToPath()` (around lines 926–1084).

`BlockType::kDontBlockChildren` means **the directory itself is blocked**,
but children that are not otherwise blocked are allowed. The comment in
source is: do not allow sharing the entire home directory, entire desktop, or
entire documents folder, but do allow sharing anything inside those
directories not otherwise blocked.

Selecting the blocked directory itself is rejected because the path is the
same as (or a parent of) a block rule. A child such as `Documents/Sakutto`
has Documents as its nearest ancestor with `kDontBlockChildren`, so access
is granted.

### Blocked on every desktop Chromium (Win / Mac / Linux)

These well-known locations cannot be selected; a folder **inside** them can,
unless a more specific rule blocks it:

| Path key                             | Typical location | Type                 |
| ------------------------------------ | ---------------- | -------------------- |
| `base::DIR_HOME`                     | user home        | `kDontBlockChildren` |
| `base::DIR_USER_DESKTOP`             | Desktop          | `kDontBlockChildren` |
| `chrome::DIR_USER_DOCUMENTS`         | Documents        | `kDontBlockChildren` |
| `chrome::DIR_DEFAULT_DOWNLOADS`      | Downloads        | `kDontBlockChildren` |
| `chrome::DIR_DEFAULT_DOWNLOADS_SAFE` | safe Downloads   | `kDontBlockChildren` |

Also blocked on every platform (`kBlockAllChildren` unless noted): the Chrome
install (`DIR_EXE` / `DIR_MODULE` / `DIR_ASSETS`), the running profile
(`DIR_USER_DATA`), `~/.ssh`, `~/.gnupg`, `~/.config`, `~/.cache`, shell
startup files, Vim startup files. Write access to `*/.git` and `*/.mvn` is
restricted separately.

### Windows (`IS_WIN`)

`kBlockAllChildren`: Program Files (including x86 / 64-32), Windows,
Roaming / Local / Common AppData.

`kBlockNestedDirectories`: IE internet cache (files from MTP devices may open
there; whole directories may not).

### macOS (`IS_MAC`)

`kBlockAllChildren`: `/System/Volumes`, `/dev`, `DIR_APP_DATA`, the Chrome
outer bundle, `~/Applications`, `/Applications`, `~/Library`.

`kDontBlockChildren` exceptions under Library: `Library/CloudStorage`,
`Library/Containers`, `Library/Mobile Documents` (and
`Library/Mobile Documents/com~apple~CloudDocs`).

## Silent auto-create

If a handle named like Documents is granted, Sakutto still creates (or reuses)
a `Sakutto` child and persists that child. Real Chrome never grants Documents,
so this path is only a fallback (unit/e2e fake pickers, or a future policy
change). The UI does not tell the user to select Documents.

A picked folder that already is `Sakutto`, already contains `sakutto-models`,
or already contains an official GGUF is used as-is. Any other allowed folder
is used as-is; Sakutto does not nest a child under it.
