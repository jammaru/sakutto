# Shared model folder (Chromium File System Access)

Optional shared storage for official PFN GGUF files on Chromium, via
`showDirectoryPicker`. Chromium first-run (Chrome and Edge alike) preselects
the shared folder when the picker exists. Browser storage (OPFS) remains a
one-click choice. The shared folder gives people who use more than one
Chromium browser one GGUF copy shared between them. A profile that already
uses a folder keeps it; there is no forced migration. Firefox and pages
without a picker keep OPFS and show no folder choice; Firefox users can
copy official models from a shared folder into browser storage instead.
Proposal 2 (a native helper) is out of scope.

This note names no issue authors. The picker copy and the Chromium blocklist
below are the reason Documents itself is not an advertised choice.

## What the user selects

The picker opens in Documents (`startIn: 'documents'`, id `sakutto-models`).
Copy on onboarding and Settings tells the user to create or choose a folder
named `Sakutto` there (for example `Documents/Sakutto`), or any folder they
can write to. Selecting Documents itself cannot work in real Chrome.
On Chromium onboarding, the shared folder is first, labelled recommended,
and preselected. Browser storage is second and remains one click away. The
shared-folder option is described for Chromium browsers such as Chrome and
Edge; the picker steps and the persistence hint sit under it. The popup
never asks an OPFS user to move. Settings keeps the folder option available
for people who chose browser storage (“Share the model folder across
Chromium browsers” / 「Chromiumブラウザ間でモデルフォルダを共有する」).
Grant from the Settings tab. In Edge, pick “Ask every time I access”
(Japanese Edge: 「アクセスするたびに確認する」; equivalent to Chrome’s “Allow on every visit”; despite the name, no later prompts). In Chrome, pick “Allow on every
visit” (Japanese Chrome: 「サイトアクセス時は常に許可」). The prompt may not
appear. A one-click re-grant may sometimes be needed. After the folder copy verifies, the OPFS copy is removed (a move). Cancel or Chrome's block dialog stays on the screen with the same
one-line hint and does not download.

A Settings pick runs `showDirectoryPicker` and
`requestPermission({ mode: 'readwrite' })` on that tab, so Chromium can offer
its persistent choice: “Allow on every visit” in Chrome (Japanese Chrome:
「サイトアクセス時は常に許可」) or “Ask every time I access” in Edge (Japanese
Edge: 「アクセスするたびに確認する」; equivalent to Chrome’s “Allow on every visit”; despite the name, no later prompts). A popup click is this-visit only, and
offscreen never calls `requestPermission`. The copy into the folder verifies size and
SHA-256. The verified OPFS copy is removed after that copy verifies, so the
folder becomes the single copy. Switching back to browser storage copies the
verified folder files into OPFS and never deletes the files in the user's
folder; another profile may still use them. Folder reload drops the previous
runtime so the next request reopens the chosen store.

Chrome can drop the directory grant when the last tracked page of the origin
closes. Offscreen cannot call `requestPermission`. The product flow is B + C:
grant from a tab, then a one-click restore in the popup or Settings when the
grant is gone. Details and Chromium sources are in
`docs/design/fsa-permission-lifetime.md`. Persistence is detected, not claimed.

Layout after a successful pick:

`<chosen>/sakutto-models/<official GGUF>`

The usual chosen folder is `Documents/Sakutto`. The Settings copy names this
path as an example rather than a Windows-only requirement. Integrity sidecars
are `<official name>.verified.json`. In-flight copies and downloads use
`.part`.

## Copy from a shared folder (Firefox)

Firefox cannot keep a persistent File System Access handle, so its Settings and
onboarding offer a one-time **Copy from shared folder** choice next to browser
storage. A hidden `<input type="file" webkitdirectory multiple>` reads the
chosen parent folder or the inner `sakutto-models` folder. Sakutto matches the
official PFN filenames, then streams each file into
`OpfsModelFileStore` at `sakutto/models/<modelId>/model.gguf`. It writes a
`.part` file while hashing the chunks, then checks the pinned size and SHA-256
from `catalog.ts`. A wrong file is rejected and the `.part` is removed;
progress and cancel stay available, and the whole file is never loaded into
memory. No network request is made, and other matching models are still tried
when one file fails. This one-time copy is the only model-file chooser; there
is no separate import or export screen.

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
