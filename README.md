# Folder Bin Sync — Premiere Pro UXP plugin

Watches a Finder folder and mirrors its structure into the active Premiere
project's bins, importing new files automatically.

- One-way: Finder → Premiere (new files only; renames/deletes are not synced).
- Manual Start/Stop from the panel.
- Re-checks the folder every few seconds while watching (UXP has no instant
  file-system notification, so it polls).

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

1. Click **Choose Folder…** and pick the Finder folder to watch.
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
- If an import fails, it's retried a few times, then skipped with a log message
  so you know to add that file manually.
- The last-used folder is remembered between sessions, but watching does not
  auto-start — press **Start Watching** each time you reopen Premiere.

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
- **"Import files already in the folder" can create duplicates.** With that box
  checked, every Start re-imports everything present — including clips already in
  the project from a previous session (Premiere doesn't de-duplicate). Leave it
  unchecked (the default) unless you specifically want a full re-import.
- **Large folders / network drives:** the folder is re-scanned every few seconds.
  Already-imported files are skipped from the size check, but a very large tree
  on slow shared storage may still feel sluggish.
