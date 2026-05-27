const ppro = require("premierepro");
const { localFileSystem, domains } = require("uxp").storage;

// How often (ms) to re-check the watched folder while watching is on.
const POLL_MS = 3000;
// How many times to retry a file that fails to import before giving up on it.
const MAX_IMPORT_ATTEMPTS = 3;

// Extensions Premiere can import. Anything else in the folder is ignored.
const ALLOWED_EXTENSIONS = new Set([
  // video
  "mov", "mp4", "m4v", "avi", "mxf", "mts", "m2ts", "m2t", "ts", "mpg",
  "mpeg", "m2v", "vob", "wmv", "f4v", "r3d", "braw", "mkv", "webm", "ogv",
  "3gp",
  // audio
  "wav", "aif", "aiff", "mp3", "aac", "m4a", "flac", "wma", "opus", "ogg",
  // images
  "jpg", "jpeg", "png", "tif", "tiff", "psd", "psb", "ai", "gif", "bmp",
  "exr", "dpx", "tga", "heic", "heif", "webp",
]);

let watchFolder = null; // UXP Folder entry chosen by the user
let timer = null; // setInterval handle while watching
let polling = false; // guard so two polls never overlap

// Identity of the project that was active when watching started. Imports only
// happen while this same project is active, so switching projects can't misfile.
let boundKey = null;
let boundName = null;
let mismatchWarned = false;

// path -> "size:mtime" signature seen on the previous poll (the "done copying?" check)
const lastSignature = new Map();
// paths we've already imported or baselined, so we never import twice
const handled = new Set();
// path -> failed import attempts so far
const importAttempts = new Map();

function log(message, isError) {
  const el = document.getElementById("log");
  const line = document.createElement("div");
  if (isError) line.className = "err";
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${message}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function setStatus(text) {
  document.getElementById("status").textContent = text;
}

function setProjectLabel(text) {
  document.getElementById("projectName").textContent = `Project: ${text}`;
}

function isWatching() {
  return timer !== null;
}

function projectKey(project) {
  // path is unique per saved project; fall back to name for unsaved projects.
  return project.path || project.name;
}

function displayPath(file) {
  return [...file.relParts, file.name].join("/");
}

function updateToggleButton() {
  const btn = document.getElementById("toggleBtn");
  const choose = document.getElementById("chooseBtn");
  const checkbox = document.getElementById("importExisting");
  btn.textContent = isWatching() ? "Stop Watching" : "Start Watching";
  choose.disabled = isWatching();
  checkbox.disabled = isWatching();
}

async function chooseFolder() {
  const folder = await localFileSystem.getFolder({
    initialDomain: domains.userDocuments,
  });
  if (!folder) return; // user cancelled
  watchFolder = folder;
  document.getElementById("folderPath").textContent = folder.nativePath;
  document.getElementById("toggleBtn").disabled = false;
  log(`Folder selected: ${folder.nativePath}`);
  try {
    const token = await localFileSystem.createPersistentToken(folder);
    localStorage.setItem("watchFolderToken", token);
  } catch (_) {
    // Persisting the folder is best-effort; ignore if unavailable.
  }
}

// Restore the last-used folder (if still accessible) so the editor doesn't
// have to re-pick it every launch. They still press Start to begin watching.
async function restoreLastFolder() {
  const token = localStorage.getItem("watchFolderToken");
  if (!token) return;
  try {
    const entry = await localFileSystem.getEntryForPersistentToken(token);
    if (entry && entry.isFolder) {
      watchFolder = entry;
      document.getElementById("folderPath").textContent = entry.nativePath;
      document.getElementById("toggleBtn").disabled = false;
      log(`Restored last folder: ${entry.nativePath}`);
    }
  } catch (_) {
    localStorage.removeItem("watchFolderToken"); // token no longer valid
  }
}

// Walk the folder tree, collecting importable files with their relative bin path.
// `relParts` is the chain of subfolder names from the watch root down to this folder.
// Already-handled files are skipped entirely so we don't re-stat them every poll.
// When `collectMeta` is false, file size/time isn't read (used for fast baselining).
async function gatherFiles(folder, relParts, out, collectMeta) {
  const entries = await folder.getEntries();
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // skip hidden / system files
    if (entry.isFolder) {
      await gatherFiles(entry, [...relParts, entry.name], out, collectMeta);
    } else if (entry.isFile) {
      if (handled.has(entry.nativePath)) continue;
      const ext = entry.name.split(".").pop().toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) continue;

      let signature = null;
      if (collectMeta) {
        try {
          const meta = await entry.getMetadata();
          const mtime = meta.dateModified ? meta.dateModified.getTime() : 0;
          signature = `${meta.size}:${mtime}`;
        } catch (_) {
          // Couldn't read metadata this round; skip until we can.
          continue;
        }
      }
      out.push({
        path: entry.nativePath,
        name: entry.name,
        relParts,
        signature,
      });
    }
  }
}

// Cast a project item to a bin (FolderItem) if it is one, else null.
// Wrapped so it works whether cast returns null or throws for non-folders.
function asBin(item) {
  try {
    return ppro.FolderItem.cast(item) || null;
  } catch (_) {
    return null;
  }
}

async function findChildBin(folderItem, name) {
  const items = await folderItem.getItems();
  for (const item of items) {
    const bin = asBin(item);
    if (bin && item.name === name) return bin;
  }
  return null;
}

async function findOrCreateChildBin(project, folderItem, name) {
  let bin = await findChildBin(folderItem, name);
  if (bin) return bin;

  await project.executeTransaction((compoundAction) => {
    const action = folderItem.createBinAction(name, false);
    compoundAction.addAction(action);
  }, `Create bin "${name}"`);

  bin = await findChildBin(folderItem, name);
  if (!bin) throw new Error(`Could not create bin "${name}"`);
  log(`Created bin: ${name}`);
  return bin;
}

// Ensure the bin chain (e.g. ["B-Roll", "City"]) exists under the project root,
// creating any missing bins, and return the FolderItem of the deepest bin.
async function ensureBin(project, relParts) {
  let folderItem = await project.getRootItem();
  for (const segment of relParts) {
    folderItem = await findOrCreateChildBin(project, folderItem, segment);
  }
  return folderItem;
}

async function importFile(project, file) {
  const targetBin = await ensureBin(project, file.relParts);
  const suppressUI = true;
  const asNumberedStills = false;
  return project.importFiles([file.path], suppressUI, targetBin, asNumberedStills);
}

function registerFailure(file, reason) {
  const attempts = (importAttempts.get(file.path) || 0) + 1;
  if (attempts >= MAX_IMPORT_ATTEMPTS) {
    handled.add(file.path); // give up so it doesn't retry forever
    importAttempts.delete(file.path);
    log(`Giving up on ${displayPath(file)} after ${MAX_IMPORT_ATTEMPTS} attempts (${reason}).`, true);
  } else {
    importAttempts.set(file.path, attempts);
    log(`Import failed for ${displayPath(file)} (${reason}); will retry (${attempts}/${MAX_IMPORT_ATTEMPTS}).`, true);
  }
}

async function poll() {
  if (polling || !watchFolder) return;
  polling = true;
  try {
    const files = [];
    await gatherFiles(watchFolder, [], files, true);
    const currentPaths = new Set(files.map((f) => f.path));

    // A file is ready to import once its signature held steady across two polls.
    const ready = [];
    for (const file of files) {
      const previous = lastSignature.get(file.path);
      if (previous !== undefined && previous === file.signature) {
        ready.push(file);
      } else {
        lastSignature.set(file.path, file.signature);
      }
    }

    if (ready.length > 0) {
      const activeProject = await ppro.Project.getActiveProject();
      if (!activeProject) {
        log("No active project open in Premiere — skipping this round.", true);
        setStatus("Paused — no active project.");
      } else if (projectKey(activeProject) !== boundKey) {
        if (!mismatchWarned) {
          log(`Active project is "${activeProject.name}", not the watched project "${boundName}". Imports paused until you switch back.`, true);
          mismatchWarned = true;
        }
        setStatus(`Paused — switch back to "${boundName}".`);
      } else {
        if (mismatchWarned) {
          log(`Back on "${boundName}". Resuming imports.`);
          mismatchWarned = false;
        }
        let done = 0;
        for (const file of ready) {
          setStatus(`Importing ${done + 1} of ${ready.length}…`);
          try {
            const ok = await importFile(activeProject, file);
            if (ok) {
              handled.add(file.path);
              importAttempts.delete(file.path);
              log(`Imported: ${displayPath(file)}`);
            } else {
              registerFailure(file, "import returned false");
            }
          } catch (err) {
            registerFailure(file, err.message);
          }
          done++;
        }
        setStatus("Watching — up to date.");
      }
    }

    // Forget signatures for files that have disappeared from the folder.
    for (const knownPath of [...lastSignature.keys()]) {
      if (!currentPaths.has(knownPath)) lastSignature.delete(knownPath);
    }
  } catch (err) {
    log(`Watch error: ${err.message}`, true);
  } finally {
    polling = false;
  }
}

async function startWatching() {
  if (!watchFolder || isWatching()) return;

  const project = await ppro.Project.getActiveProject();
  if (!project) {
    log("Open a project in Premiere before starting.", true);
    return;
  }
  boundKey = projectKey(project);
  boundName = project.name;
  mismatchWarned = false;
  setProjectLabel(boundName);

  lastSignature.clear();
  handled.clear();
  importAttempts.clear();

  const importExisting = document.getElementById("importExisting").checked;
  if (!importExisting) {
    // Baseline: treat everything already present as already handled.
    const existing = [];
    await gatherFiles(watchFolder, [], existing, false);
    for (const f of existing) handled.add(f.path);
    log(`Watching for "${boundName}". ${existing.length} existing file(s) ignored.`);
  } else {
    log(`Watching for "${boundName}". Existing files will be imported.`);
  }

  timer = setInterval(poll, POLL_MS);
  setStatus("Watching — up to date.");
  updateToggleButton();
}

function stopWatching() {
  if (timer) clearInterval(timer);
  timer = null;
  log("Watching stopped.");
  setStatus("");
  setProjectLabel("not watching");
  updateToggleButton();
}

function toggleWatching() {
  if (isWatching()) stopWatching();
  else startWatching();
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("chooseBtn").addEventListener("click", chooseFolder);
  document.getElementById("toggleBtn").addEventListener("click", toggleWatching);
  document.getElementById("clearLogBtn").addEventListener("click", () => {
    document.getElementById("log").textContent = "";
  });
  restoreLastFolder();
});
