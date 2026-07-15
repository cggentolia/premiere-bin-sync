const ppro = require("premierepro");
const { localFileSystem, domains } = require("uxp").storage;

// How often (ms) to re-check the watched folder while watching is on.
const POLL_MS = 3000;
// How often (ms) to check which project is active in Premiere.
const PROJECT_CHECK_MS = 2000;
// Retry backoff for failed imports (e.g. files still syncing to LucidLink):
// first retry after RETRY_BASE_MS, doubling each time, capped at RETRY_MAX_MS.
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 60000;
// Stop retrying a file after this many failed attempts (~1.5+ hours at the cap).
const MAX_IMPORT_ATTEMPTS = 100;
// Only log every Nth retry so a slow upload doesn't flood the activity log.
const RETRY_LOG_EVERY = 5;

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

let watchFolder = null; // UXP Folder entry currently being watched
let assetsRoot = null; // parent folder that holds all "MP-xxxxx Project Assets" folders
let timer = null; // setInterval handle while watching
let polling = false; // guard so two polls never overlap

// Identity of the project that was active when watching started. Imports only
// happen while this same project is active, so switching projects can't misfile.
let boundKey = null;
let boundName = null;
let mismatchWarned = false;

// Active-project watcher state. `undefined` means "not checked yet" so the
// first check always fires the change handler.
let lastSeenProjectKey = undefined;
let checkingProject = false;

// True after a poll couldn't read the watched folder (e.g. LucidLink offline),
// so the "folder unreachable" warning is only logged once per outage.
let offlineWarned = false;

// path -> "size:mtime" signature seen on the previous poll (the "done copying?" check)
const lastSignature = new Map();
// paths we've already imported or baselined, so we never import twice
const handled = new Set();
// path -> { attempts, nextTry } retry/backoff state for failed imports
const retryState = new Map();

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
  document.getElementById("projectName").textContent = text;
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

function autoWatchEnabled() {
  return document.getElementById("autoWatch").checked;
}

function updateToggleButton() {
  const btn = document.getElementById("toggleBtn");
  const choose = document.getElementById("chooseBtn");
  const checkbox = document.getElementById("importExisting");
  const scan = document.getElementById("scanBtn");
  btn.textContent = isWatching() ? "Stop Watching" : "Start Watching";
  if (isWatching()) btn.classList.add("watching");
  else btn.classList.remove("watching");
  choose.disabled = isWatching();
  checkbox.disabled = isWatching();
  scan.disabled = !isWatching();
}

// Status line helper: reflects how many files are waiting out a retry backoff
// (usually files whose data is still syncing to LucidLink).
function setWatchingStatus() {
  const syncing = retryState.size;
  setStatus(syncing > 0
    ? `Watching — ${syncing} file(s) still syncing…`
    : "Watching — up to date.");
}

function setWatchFolder(folder) {
  watchFolder = folder;
  document.getElementById("folderPath").textContent = folder.nativePath;
  document.getElementById("toggleBtn").disabled = false;
}

async function chooseFolder() {
  const folder = await localFileSystem.getFolder({
    initialDomain: domains.userDocuments,
  });
  if (!folder) return; // user cancelled
  setWatchFolder(folder);
  log(`Folder selected: ${folder.nativePath}`);
  try {
    const token = await localFileSystem.createPersistentToken(folder);
    localStorage.setItem("watchFolderToken", token);
  } catch (_) {
    // Persisting the folder is best-effort; ignore if unavailable.
  }
}

// Pick the parent folder that contains all the per-project assets folders
// (e.g. the LucidLink folder holding every "MP-xxxxx Project Assets" folder).
async function chooseAssetsRoot() {
  const folder = await localFileSystem.getFolder({
    initialDomain: domains.userDocuments,
  });
  if (!folder) return; // user cancelled
  assetsRoot = folder;
  document.getElementById("rootPath").textContent = folder.nativePath;
  log(`Projects folder set: ${folder.nativePath}`);
  try {
    const token = await localFileSystem.createPersistentToken(folder);
    localStorage.setItem("assetsRootToken", token);
  } catch (_) {
    // Persisting is best-effort.
  }
  // Try to match the currently open project right away.
  lastSeenProjectKey = undefined;
  await checkActiveProject();
}

// Restore remembered folders (if still accessible) so the editor doesn't
// have to re-pick them every launch.
async function restoreTokens() {
  const rootToken = localStorage.getItem("assetsRootToken");
  if (rootToken) {
    try {
      const entry = await localFileSystem.getEntryForPersistentToken(rootToken);
      if (entry && entry.isFolder) {
        assetsRoot = entry;
        document.getElementById("rootPath").textContent = entry.nativePath;
        log(`Projects folder: ${entry.nativePath}`);
      }
    } catch (_) {
      localStorage.removeItem("assetsRootToken");
    }
  }

  const token = localStorage.getItem("watchFolderToken");
  if (token) {
    try {
      const entry = await localFileSystem.getEntryForPersistentToken(token);
      if (entry && entry.isFolder && !watchFolder) {
        setWatchFolder(entry);
        log(`Restored last folder: ${entry.nativePath}`);
      }
    } catch (_) {
      localStorage.removeItem("watchFolderToken"); // token no longer valid
    }
  }
}

// Pull the MP job number out of a name like "MP-62325 Total Knee.prproj" or
// "MP62325 Project Assets". Returns the digits, or null if there's no MP number.
function extractMpNumber(name) {
  const match = /MP[-_ ]?(\d{3,})/i.exec(name || "");
  return match ? match[1] : null;
}

// Find the assets folder for a project by matching MP numbers inside the
// projects root. Prefers a folder whose name mentions "asset" if several match.
async function findAssetsFolderFor(projectName) {
  if (!assetsRoot) return null;
  const mp = extractMpNumber(projectName);
  if (!mp) return null;
  const matches = [];
  const entries = await assetsRoot.getEntries();
  for (const entry of entries) {
    if (entry.isFolder && extractMpNumber(entry.name) === mp) {
      matches.push(entry);
    }
  }
  if (matches.length === 0) return null;
  return matches.find((f) => /asset/i.test(f.name)) || matches[0];
}

// Runs on an interval: notices when the active Premiere project changes and,
// if auto-watch is on, switches watching to that project's assets folder.
async function checkActiveProject() {
  if (checkingProject) return;
  checkingProject = true;
  try {
    const project = await ppro.Project.getActiveProject();
    const key = project ? projectKey(project) : null;
    if (key === lastSeenProjectKey) return;
    lastSeenProjectKey = key;
    await handleProjectChange(project);
  } catch (_) {
    // Premiere can briefly refuse this call during project load; try next tick.
  } finally {
    checkingProject = false;
  }
}

async function handleProjectChange(project) {
  if (!project) {
    setProjectLabel("No project open");
    if (isWatching()) {
      log("Project closed — watching stopped.");
      stopWatching();
    }
    return;
  }

  setProjectLabel(project.name);

  if (!autoWatchEnabled() || !assetsRoot) return;
  if (isWatching() && projectKey(project) === boundKey) return; // already on it

  const folder = await findAssetsFolderFor(project.name);
  if (isWatching()) stopWatching();
  if (folder) {
    setWatchFolder(folder);
    log(`Auto-matched assets folder: ${folder.name}`);
    await startWatching();
  } else if (extractMpNumber(project.name)) {
    log(`No folder matching "${project.name}" found in the projects folder. Use Choose Folder… to pick one manually.`, true);
    setStatus("No matching assets folder found.");
  } else {
    log(`"${project.name}" has no MP number — auto-watch skipped. Use Choose Folder… if you want to watch a folder.`);
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

// Collect the file paths of all media already in the project so files the
// editor brought in some other way (drag & drop, media browser) are skipped
// instead of imported twice. Paths are lowercased for comparison.
async function getProjectMediaPaths(project) {
  const paths = new Set();
  async function walk(folderItem) {
    const items = await folderItem.getItems();
    for (const item of items) {
      const bin = asBin(item);
      if (bin) {
        await walk(bin);
        continue;
      }
      try {
        const clip = ppro.ClipProjectItem.cast(item);
        if (!clip) continue;
        const mediaPath = await clip.getMediaFilePath();
        if (mediaPath) paths.add(mediaPath.toLowerCase());
      } catch (_) {
        // Not a media-backed clip (sequence, etc.) — ignore.
      }
    }
  }
  try {
    await walk(await project.getRootItem());
  } catch (_) {
    // If the scan fails, return what we have; worst case is a duplicate import.
  }
  return paths;
}

// A failed import goes into retry-with-backoff rather than being dropped:
// files added to LucidLink can take minutes (or longer) to finish syncing,
// and Premiere can't import them until the data is actually there.
function registerFailure(file, reason) {
  const state = retryState.get(file.path) || { attempts: 0, nextTry: 0 };
  state.attempts += 1;

  if (state.attempts >= MAX_IMPORT_ATTEMPTS) {
    handled.add(file.path);
    retryState.delete(file.path);
    log(`Giving up on ${displayPath(file)} after ${MAX_IMPORT_ATTEMPTS} attempts (${reason}). Import it manually.`, true);
    return;
  }

  const delay = Math.min(RETRY_BASE_MS * 2 ** (state.attempts - 1), RETRY_MAX_MS);
  state.nextTry = Date.now() + delay;
  retryState.set(file.path, state);

  if (state.attempts === 1 || state.attempts % RETRY_LOG_EVERY === 0) {
    log(`Import failed for ${displayPath(file)} (${reason}). Retrying — the file may still be syncing (attempt ${state.attempts}).`, true);
  }
}

async function poll() {
  if (polling || !watchFolder) return;
  polling = true;
  let paused = false; // set when this round can't import (offline / wrong project)
  try {
    const files = [];
    try {
      await gatherFiles(watchFolder, [], files, true);
      if (offlineWarned) {
        log("Watched folder is reachable again — resuming.");
        offlineWarned = false;
      }
    } catch (err) {
      // Folder can't be read — most likely LucidLink is offline/unmounted.
      // Pause quietly (one log line per outage) and keep checking each poll.
      if (!offlineWarned) {
        log(`Can't read the watched folder (${err.message}). Paused until it's reachable again.`, true);
        offlineWarned = true;
      }
      setStatus("Paused — watched folder unreachable.");
      return;
    }
    const currentPaths = new Set(files.map((f) => f.path));

    // A file is ready to import once its signature held steady across two
    // polls and it isn't waiting out a retry backoff.
    const now = Date.now();
    const ready = [];
    for (const file of files) {
      const previous = lastSignature.get(file.path);
      if (previous !== undefined && previous === file.signature) {
        const retry = retryState.get(file.path);
        if (!retry || retry.nextTry <= now) ready.push(file);
      } else {
        lastSignature.set(file.path, file.signature);
      }
    }

    if (ready.length > 0) {
      const activeProject = await ppro.Project.getActiveProject();
      if (!activeProject) {
        log("No active project open in Premiere — skipping this round.", true);
        setStatus("Paused — no active project.");
        paused = true;
      } else if (projectKey(activeProject) !== boundKey) {
        if (!mismatchWarned) {
          log(`Active project is "${activeProject.name}", not the watched project "${boundName}". Imports paused until you switch back.`, true);
          mismatchWarned = true;
        }
        setStatus(`Paused — switch back to "${boundName}".`);
        paused = true;
      } else {
        if (mismatchWarned) {
          log(`Back on "${boundName}". Resuming imports.`);
          mismatchWarned = false;
        }
        // Skip anything the project already contains (imported by hand, etc.).
        const existingMedia = await getProjectMediaPaths(activeProject);
        let done = 0;
        for (const file of ready) {
          if (existingMedia.has(file.path.toLowerCase())) {
            handled.add(file.path);
            retryState.delete(file.path);
            log(`Skipped (already in project): ${displayPath(file)}`);
            done++;
            continue;
          }
          setStatus(`Importing ${done + 1} of ${ready.length}…`);
          try {
            const ok = await importFile(activeProject, file);
            if (ok) {
              const attempts = retryState.get(file.path)?.attempts || 0;
              handled.add(file.path);
              retryState.delete(file.path);
              log(attempts > 0
                ? `Imported after ${attempts + 1} attempts: ${displayPath(file)}`
                : `Imported: ${displayPath(file)}`);
            } else {
              registerFailure(file, "import returned false");
            }
          } catch (err) {
            registerFailure(file, err.message);
          }
          done++;
        }
      }
    }

    // Forget signatures for files that have disappeared from the folder.
    for (const knownPath of [...lastSignature.keys()]) {
      if (!currentPaths.has(knownPath)) {
        lastSignature.delete(knownPath);
        retryState.delete(knownPath);
      }
    }

    if (!paused && !mismatchWarned && isWatching()) setWatchingStatus();
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
  offlineWarned = false;
  setProjectLabel(boundName);

  lastSignature.clear();
  handled.clear();
  retryState.clear();

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
  setWatchingStatus();
  updateToggleButton();
}

function stopWatching() {
  if (timer) clearInterval(timer);
  timer = null;
  log("Watching stopped.");
  setStatus("");
  updateToggleButton();
}

function toggleWatching() {
  if (isWatching()) stopWatching();
  else startWatching();
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("chooseBtn").addEventListener("click", chooseFolder);
  document.getElementById("rootBtn").addEventListener("click", chooseAssetsRoot);
  document.getElementById("toggleBtn").addEventListener("click", toggleWatching);
  document.getElementById("scanBtn").addEventListener("click", () => {
    if (!isWatching() || polling) return;
    log("Scanning now…");
    poll();
  });
  document.getElementById("clearLogBtn").addEventListener("click", () => {
    document.getElementById("log").textContent = "";
  });

  // Remember the auto-watch preference between sessions (on by default).
  const autoWatch = document.getElementById("autoWatch");
  autoWatch.checked = localStorage.getItem("autoWatch") !== "off";
  autoWatch.addEventListener("change", () => {
    localStorage.setItem("autoWatch", autoWatch.checked ? "on" : "off");
  });

  restoreTokens().then(() => {
    // Watch for project open/switch/close so auto-watch can kick in.
    setInterval(checkActiveProject, PROJECT_CHECK_MS);
    checkActiveProject();
  });
});
