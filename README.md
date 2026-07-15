# Folder Bin Sync — Premiere Pro UXP plugin

Watches a Finder folder and mirrors its structure into the active Premiere
project's bins, importing new files automatically.

- One-way: Finder → Premiere (new files only; renames/deletes are not synced).
- **Auto-watch:** set a "projects folder" once (the parent holding all the
  `MP-xxxxx Project Assets` folders) and the plugin matches the open project's
  MP number to its assets folder and starts watching automatically.
- Manual Choose Folder + Start/Stop still available as an override.
- Re-checks the folder every few seconds while watching (UXP has no instant
  file-system notification, so it polls).
- Failed imports (e.g. files still syncing to LucidLink) are retried with
  increasing delays until the file becomes importable; the status line shows
  how many files are still waiting.
- Files already in the project (imported by hand, etc.) are skipped, not
  duplicated.
- If the watched folder becomes unreachable (LucidLink offline), watching
  pauses with a clear status and resumes automatically when it's back.
- **Scan Now** button forces an immediate re-check while watching.
- UI styled to the Arthrex brand guidelines (dark charcoal, Arthrex Blue).

## Files

- `manifest.json` — plugin definition (panel + file-system permission)
- `index.html` / `styles.css` — the panel UI
- `index.js` — folder watching, bin mirroring, and import logic

## Install it (for editors)

Editors don't need the developer tool. Install the packaged plugin in two steps:

1. Double-click the `.ccx` file (e.g. `com.cggentolia.binsync_premierepro.ccx`).
2. The Creative Cloud Desktop app opens and warns that the plugin isn't from the
   Marketplace — click **Install**. Done.

Then open Premiere and find **Folder Bin Sync** under **Window → UXP Plugins**.

> A `.ccx` is just a zipped, ready-to-install plugin. No Adobe developer account,
> signing, or UXP Developer Tool required to install it.

### Building the `.ccx` (maintainer)

To produce the `.ccx` to share:

1. Add this folder in the **UXP Developer Tool** (see below).
2. Click the **•••** menu next to the plugin → **Package**.
3. UDT writes a file named `<plugin-id>_premierepro.ccx`. That's the file you
   hand to editors or attach to a GitHub Release.

## How to load it in Premiere (development)

1. Open **Premiere Pro** and open or create a project (the plugin imports into
   the *active* project).
2. Install the **UXP Developer Tool (UDT)** from the Creative Cloud desktop app
   if you don't have it.
3. In UDT, click **Add Plugin** and select this folder's `manifest.json`.
4. Find "Folder Bin Sync" in the list, click **•••  → Load**.
5. In Premiere, the panel appears under **Window → Extensions** (or
   **Window → UXP Plugins**). Dock it wherever you like.

> Note: Premiere **26.0.1** has had reports of UDT failing to connect
> ("No applications are connected to the service"). If that happens, fully quit
> and relaunch both Premiere and UDT, and make sure both are up to date.

## How to use it

### Auto-watch (recommended)

1. Click **Set Projects Folder…** once and pick the parent folder that contains
   all your `MP-xxxxx Project Assets` folders (e.g. on LucidLink).
2. Open any project whose name contains an MP number (e.g. `MP-62325 Total
   Knee.prproj`). The plugin finds the assets folder with the same MP number
   and starts watching it automatically. Switching projects re-matches
   automatically; closing the project stops watching.
3. Untick **Start watching automatically when a project opens** if you'd rather
   drive it manually.

### Manual

1. Click **Choose Folder…** and pick the Finder folder to watch (this overrides
   the auto-matched folder until the project changes).
2. (Optional) Tick **Import files already in the folder** if you want what's
   already there pulled in too. Leave it off to only catch *new* files.
3. Click **Start Watching**.
4. Drop assets into the folder (or its subfolders). Within a few seconds they
   appear in matching bins in your project. The **Activity** log shows what
   happened.
5. Click **Stop Watching** to pause.

## How it behaves (good to know)

- A file is only imported once its size **and** modification time hold steady
  across two checks, so large/slow copies aren't imported half-finished.
- Only common media extensions are imported; other files are ignored.
- Imports go only to the project that was active when you pressed **Start**. If
  you switch to a different project, importing pauses (with a note in the log)
  and resumes when you switch back — so files can't land in the wrong project.
- If an import fails (commonly a file whose data is still uploading/syncing to
  LucidLink), it's retried with increasing delays — 5s, 10s, 20s… capped at one
  minute — for up to ~100 attempts, and imports the moment the file becomes
  readable. Only after that does it give up with a log message. The status line
  shows "N file(s) still syncing…" while retries are pending.
- Before importing, the plugin checks what's already in the project and skips
  files whose media path is already there (logged as "Skipped").
- If the watched folder can't be read (network volume offline), the plugin
  pauses with a "folder unreachable" status, logs it once, and resumes on its
  own once the folder is reachable again.
- The projects folder, last-used folder, and the auto-watch preference are all
  remembered between sessions.

## Known limitations (please read before testing)

- **One-way, additions only.** New files in Finder appear in Premiere. Renaming
  or deleting files/folders in Finder is **not** mirrored.
- **Don't rename synced bins.** Bins are matched by name. If you rename a bin the
  plugin created (or rename/move the matching Finder folder), the next file for
  that folder will create a *new* bin with the original name instead of reusing
  yours — splitting clips across two bins.
- **Camera-card footage imports raw.** AVCHD/XDCAM/RED and similar formats store
  clips inside structured folders (`BPAV`, `CLIP`, `STREAM`, `.RDC`). Dropping a
  card folder in imports the underlying fragment files, not properly spanned
  clips. Import camera media the normal way; use this for loose media files.
- **Image sequences import as individual stills**, not as a single sequence clip.
- **Moving a file between watched subfolders re-imports it** into the new bin
  while the original import stays put (you'll have it in both).
- **"Import files already in the folder" is now duplicate-safe** — files whose
  media path is already in the project are skipped. The check matches on file
  path, so a clip imported from a *different* copy of the same file (e.g. a
  local download vs. the LucidLink path) will still come in again.
- **Large folders / network drives:** the folder is re-scanned every few seconds.
  Already-imported files are skipped from the size check, but a very large tree
  on slow shared storage may still feel sluggish.
