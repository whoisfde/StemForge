(function () {
  "use strict";

  // UXP host modules. `premierepro` is only available when running inside
  // Premiere Pro's UXP host; guarded so this file can also be opened in a
  // plain browser for quick UI iteration.
  let uxpStorage = null;
  let premierepro = null;
  try {
    uxpStorage = require("uxp").storage;
    premierepro = require("premierepro");
  } catch (e) {
    // Running outside the UXP host (e.g. browser preview) - UI-only mode.
  }

  const el = (id) => document.getElementById(id);

  const dropZone = el("drop-zone");
  const browseBtn = el("browse-btn");
  const loadSelectedBtn = el("load-selected-btn");
  const fileInfoSection = el("file-info");
  const fileNameLabel = el("file-name");
  const clearFileBtn = el("clear-file-btn");

  const analyzeSection = el("analyze-section");
  const analyzeBtn = el("analyze-btn");
  const detectedBpmLabel = el("detected-bpm");
  const detectedKeyLabel = el("detected-key");
  const confidenceMeter = el("confidence-meter");
  const confidenceSegs = confidenceMeter ? Array.from(confidenceMeter.querySelectorAll(".led-seg")) : [];

  // Lights up N of 10 LED segments for a 0-1 confidence score, from the
  // key-detection correlation score the server already computes.
  function setConfidenceMeter(confidence) {
    const lit = confidence == null ? 0 : Math.max(0, Math.min(10, Math.round(confidence * 10)));
    confidenceSegs.forEach((seg, i) => seg.classList.toggle("lit", i < lit));
  }

  const transformSection = el("transform-section");
  const targetBpmInput = el("target-bpm");
  const targetKeyInput = el("target-key");
  const transformBtn = el("transform-btn");
  const transformResultRow = el("transform-result");
  const transformResultLabel = el("transform-result-label");
  const importTransformBtn = el("import-transform-btn");

  // Mirrors the stem-color CSS in style.css, mapped onto Premiere's
  // built-in Project panel label colors so an imported clip's label
  // matches the color it was shown with in this panel.
  const STEM_COLOR_LABELS = {
    drums: "MANGO",
    bass: "PURPLE",
    vocals: "CERULEAN",
    other: "TEAL",
    guitar: "YELLOW",
    piano: "BLUE",
    instrumental: "FOREST",
  };

  const separateSection = el("separate-section");
  const stemModelSelect = el("stem-model");
  const separateBtn = el("separate-btn");
  const stemList = el("stem-list");
  const importAllStemsBtn = el("import-all-stems-btn");

  const serverStatus = el("server-status");
  const serverHelp = el("server-help");
  const statusBar = el("status-bar");

  // { arrayBuffer, name } for the currently loaded audio file.
  let currentFile = null;
  let lastAnalysis = null;
  // Result descriptors, not raw server paths: each carries the server's
  // /files/... download URL (previewUrl) plus the original path (serverPath)
  // kept only as a fallback for a UDT/developer-mode load. See stageForImport.
  let lastTransformResult = null; // { previewUrl, serverPath, fileName }
  let lastStemResults = [];       // [{ name, previewUrl, serverPath, fileName, colorLabel }]
  let lastTrackName = "StemForge Import";

  // Everything imported from one source track lands in a single Premiere
  // bin named after that track, e.g. "Song Name" containing "Song Name -
  // Drums.wav", "Song Name - Vocals.wav", etc.
  function deriveBinName(fileName) {
    return fileName.replace(/\.[^./\\]+$/, "") || fileName;
  }

  // --- Staging result files into the plugin's own sandbox --------------
  //
  // Premiere's importFiles() silently imports nothing when handed a path
  // the plugin has no permission to (anything outside its own storage or a
  // user-picked location). A plugin loaded through the UXP Developer Tool
  // is exempt, which is why importing "worked in UDT, did nothing once
  // installed". Fix: download each result from the server's /files mount
  // and re-write it into the plugin's persistent data folder, then import
  // THAT path. getDataFolder() (not a temp folder) so the imported media
  // stays online for the life of the Premiere project.

  function sanitizeForFs(name) {
    return (name || "")
      .replace(/[/\\:*?"<>|\x00-\x1f]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "StemForge";
  }

  // Premiere's importer also mishandles '#', '[', ']', '(', ')' in a
  // filename (frame-number / image-sequence tokens), even for an in-scope
  // path, so the staged copy gets a cleaned basename. The extension is
  // preserved so Premiere still recognizes it as audio.
  function safeImportName(fileName) {
    const dot = fileName.lastIndexOf(".");
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot > 0 ? fileName.slice(dot).toLowerCase() : "";
    const cleaned = stem
      .replace(/[#\[\]()]/g, "")
      .replace(/\s+/g, " ")
      .trim() || "audio";
    return cleaned + ext;
  }

  async function getOrCreateFolder(parent, name) {
    try {
      const existing = await parent.getEntry(name);
      if (existing && existing.isFolder) return existing;
    } catch (e) {
      // not found - fall through to create
    }
    return parent.createFolder(name);
  }

  // Returns an absolute nativePath the running plugin is allowed to import.
  async function stageForImport(item, binName) {
    // No UXP host (browser preview) or no download URL from the server:
    // fall back to the raw server path. That still works under a UDT load.
    if (!uxpStorage || !item.previewUrl) return item.serverPath;

    const bytes = await StemForgeAPI.fetchResultFile(item.previewUrl);

    const dataFolder = await uxpStorage.localFileSystem.getDataFolder();
    const importsRoot = await getOrCreateFolder(dataFolder, "imports");
    const trackFolder = await getOrCreateFolder(importsRoot, sanitizeForFs(binName || lastTrackName));

    const file = await trackFolder.createFile(safeImportName(item.fileName), { overwrite: true });
    await file.write(bytes, { format: uxpStorage.formats.binary });
    return file.nativePath;
  }

  // Stage every result descriptor, then import the local copies together,
  // carrying each color label across to its new staged path.
  async function importResults(items, binName) {
    if (!items || !items.length) return;
    if (!premierepro) {
      setStatus("Import only available inside Premiere Pro", true);
      return;
    }
    setStatus(`Preparing ${items.length} file(s) for import…`);
    const stagedPaths = [];
    const colorLabelsByPath = {};
    try {
      for (const item of items) {
        const nativePath = await stageForImport(item, binName);
        stagedPaths.push(nativePath);
        if (item.colorLabel) colorLabelsByPath[nativePath] = item.colorLabel;
      }
    } catch (err) {
      setStatus(`Import failed while preparing files: ${err.message}`, true);
      return;
    }
    await importPathsToProject(stagedPaths, { colorLabelsByPath, binName });
  }

  function setStatus(message, isError) {
    statusBar.textContent = message || "";
    statusBar.classList.toggle("error", !!isError);
  }

  // Confirmed (via the button's own label text updating correctly while
  // the spinner stayed invisible) that this UXP host does paint DOM
  // changes fine - the CSS @keyframes animation on the spinner element
  // specifically just never plays. Rather than trust another CSS effect
  // in a host that's already broken a pseudo-element and (apparently)
  // animations, the spin itself is driven from JS by cycling a plain
  // text character on an interval - no CSS animation involved at all.
  function createSpinner() {
    const frames = ["◐", "◓", "◑", "◒"];
    const spinner = document.createElement("span");
    spinner.className = "btn-spinner";
    let i = 0;
    spinner.textContent = frames[i];
    spinner._intervalId = setInterval(() => {
      i = (i + 1) % frames.length;
      spinner.textContent = frames[i];
    }, 150);
    return spinner;
  }

  function removeSpinner(button) {
    if (button._spinner) {
      clearInterval(button._spinner._intervalId);
      button._spinner = null;
    }
  }

  // Forces the browser to actually paint before continuing. Updating the
  // DOM (e.g. via setBusy) doesn't guarantee a repaint happens before the
  // next line of synchronous-ish JS runs - if the network call right
  // after it doesn't yield control back promptly, the busy state can be
  // set and unset without ever being drawn on screen, so the loading
  // indicator silently never appears even though the code ran correctly.
  function yieldToRender() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    });
  }

  function setBusy(button, busy, busyLabel) {
    button.disabled = busy;
    removeSpinner(button);
    if (busy) {
      button.dataset.originalLabel = button.textContent;
      button.textContent = "";
      button._spinner = createSpinner();
      button.appendChild(button._spinner);
      button.appendChild(document.createTextNode(" " + (busyLabel || "Working…")));
    } else if (button.dataset.originalLabel) {
      button.textContent = button.dataset.originalLabel;
    }
  }

  async function checkServer() {
    try {
      await StemForgeAPI.health();
      serverStatus.textContent = "connected";
      serverStatus.title = "Processing service connected";
      serverStatus.className = "server-status ok";
      serverHelp.classList.add("hidden");
    } catch (e) {
      serverStatus.textContent = "offline";
      serverStatus.title = "Processing service not running";
      serverStatus.className = "server-status error";
      serverHelp.classList.remove("hidden");
    }
  }

  function loadFile(arrayBuffer, name, trimStart, trimEnd) {
    currentFile = { arrayBuffer, name, trimStart: trimStart ?? null, trimEnd: trimEnd ?? null };
    lastAnalysis = null;
    lastTransformResult = null;
    lastStemResults = [];
    lastTrackName = deriveBinName(name);

    const trimSuffix = currentFile.trimStart != null && currentFile.trimEnd != null
      ? ` (${currentFile.trimStart.toFixed(1)}s–${currentFile.trimEnd.toFixed(1)}s)`
      : "";
    fileNameLabel.textContent = name + trimSuffix;
    fileNameLabel.title = name + trimSuffix;
    fileInfoSection.classList.remove("hidden");
    analyzeSection.classList.remove("hidden");
    transformSection.classList.remove("hidden");
    separateSection.classList.remove("hidden");

    detectedBpmLabel.textContent = "—";
    detectedKeyLabel.textContent = "—";
    setConfidenceMeter(null);
    // A stale target BPM/key from a *previous* file used to survive into
    // this one - most visibly as a leftover "NaN" sitting in Target BPM
    // (which analyze's `if (!targetBpmInput.value)` guard then never
    // overwrote, since a non-empty "NaN" string looks "already filled in").
    targetBpmInput.value = "";
    targetKeyInput.value = "";
    transformResultRow.classList.add("hidden");
    stemList.innerHTML = "";
    importAllStemsBtn.classList.add("hidden");
    setStatus(`Loaded ${name}`);
  }

  function clearFile() {
    currentFile = null;
    fileInfoSection.classList.add("hidden");
    analyzeSection.classList.add("hidden");
    transformSection.classList.add("hidden");
    separateSection.classList.add("hidden");
    setStatus("");
  }

  // --- Drag and drop -------------------------------------------------

  ["dragenter", "dragover"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.add("drag-over");
    });
  });

  ["dragleave", "drop"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.remove("drag-over");
    });
  });

  dropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        loadFile(arrayBuffer, file.name);
      } catch (err) {
        setStatus(`Could not read dropped file: ${err.message}`, true);
      }
      return;
    }

    // No OS file - this is likely a drag from Premiere's own Timeline or
    // Project panel, which doesn't hand over a plain File. There's no
    // documented UXP API for reading the dragged clip in that case, so
    // this is a best-effort attempt at whatever data types are present,
    // surfaced so we can see exactly what Premiere actually sends.
    const types = (e.dataTransfer && Array.from(e.dataTransfer.types || [])) || [];
    for (const type of types) {
      const data = e.dataTransfer.getData(type);
      if (data && /^(file:\/\/|\/|[A-Za-z]:\\)/.test(data.trim())) {
        setStatus(`Got a path from Premiere via "${type}" - trying to load it`);
        // Not yet wired to an actual reader since we don't have a confirmed
        // path format from Premiere; report it instead of failing silently.
        console.log("StemForge: candidate path from timeline drag:", type, data);
      }
    }
    setStatus(
      `Timeline/Project panel drag isn't supported yet (types seen: ${types.join(", ") || "none"}). ` +
      `Drag the original audio file from Finder, or use Browse…`,
      true
    );
  });

  // --- Browse via native file picker ---------------------------------

  browseBtn.addEventListener("click", async () => {
    if (!uxpStorage) {
      setStatus("File picker only available inside Premiere Pro", true);
      return;
    }
    try {
      const entry = await uxpStorage.localFileSystem.getFileForOpening({
        types: uxpStorage.fileTypes ? undefined : ["wav", "mp3", "aif", "aiff", "m4a", "flac"],
      });
      if (!entry) return; // user cancelled
      const arrayBuffer = await entry.read({ format: uxpStorage.formats.binary });
      loadFile(arrayBuffer, entry.name);
    } catch (err) {
      setStatus(`Could not open file: ${err.message}`, true);
    }
  });

  clearFileBtn.addEventListener("click", clearFile);

  // Repeatedly decodes until the string stops changing (or a sane
  // iteration cap), so a path that's been percent-encoded more than once
  // - confirmed to be what Premiere's getMediaFilePath() returns for some
  // media - fully unwinds instead of leaving one layer behind.
  function fullyDecodeUriComponent(segment) {
    let current = segment;
    for (let i = 0; i < 6; i++) {
      let next;
      try {
        next = decodeURIComponent(current);
      } catch (e) {
        break; // not validly encoded (any further) - stop here
      }
      if (next === current) break;
      current = next;
    }
    return current;
  }

  function toFileUrl(absolutePath) {
    if (absolutePath.startsWith("file://")) return absolutePath;
    // Paths from Premiere's own API (e.g. getMediaFilePath()) can already
    // be percent-encoded - sometimes more than once over. Paths we build
    // ourselves are plain. Fully decoding first (a no-op on a plain
    // segment) then encoding exactly once normalizes all of those cases
    // to the same, correctly singly-encoded result.
    const encoded = absolutePath
      .split(/[\\/]/)
      .map((segment) => {
        return encodeURIComponent(fullyDecodeUriComponent(segment));
      })
      .join("/");
    return "file://" + encoded;
  }

  // getEntryWithUrl() has repeatedly failed to find a real, confirmed-
  // existing file when given a carefully percent-encoded file:// URI - the
  // exact same category of mistake shell.openPath() turned out to have
  // (docs suggested a URI; a plain path was actually correct). Rather than
  // trust one "correct" format, this tries several, cheapest/most-literal
  // first, and reports every failure if all of them miss so the real
  // cause is visible instead of guessed at again.
  async function getEntryForPath(mediaPath) {
    const attempts = [
      ["raw path", mediaPath],
      ["file:// + raw path", "file://" + mediaPath],
      ["file:// + fully-decoded-then-encoded", toFileUrl(mediaPath)],
    ];
    const failures = [];
    for (const [label, candidate] of attempts) {
      try {
        const entry = await uxpStorage.localFileSystem.getEntryWithUrl(candidate);
        if (entry) return entry;
        failures.push(`${label}: no entry returned`);
      } catch (err) {
        failures.push(`${label}: ${err && err.message ? err.message : err}`);
      }
    }
    throw new Error(
      `all lookup strategies failed for raw path "${mediaPath}" - ${failures.join(" | ")}`
    );
  }

  // --- Load the clip currently selected in Premiere -------------------

  loadSelectedBtn.addEventListener("click", async () => {
    if (!premierepro || !uxpStorage) {
      setStatus("Only available inside Premiere Pro", true);
      return;
    }
    try {
      const project = await premierepro.Project.getActiveProject();
      if (!project) {
        setStatus("No active Premiere Pro project", true);
        return;
      }

      // Prefer whatever's selected on the Timeline; fall back to the
      // Project panel selection if nothing's selected there. Only a
      // Timeline track item has in/out trim points - a Project panel
      // item is the full source file, so trimStart/trimEnd stay null
      // for that fallback path. This fallback is easy to trigger by
      // accident (clicking the clip in the Project panel/bin instead of
      // on the track itself loads the whole file silently), so which
      // branch actually ran gets logged and reported below rather than
      // left ambiguous.
      let projectItem = null;
      let trimStart = null;
      let trimEnd = null;
      let source = null;
      const sequence = await project.getActiveSequence();
      if (sequence) {
        const trackItemSelection = await sequence.getSelection();
        const trackItems = await trackItemSelection.getTrackItems();
        if (trackItems.length > 0) {
          projectItem = await trackItems[0].getProjectItem();
          const inPoint = await trackItems[0].getInPoint();
          const outPoint = await trackItems[0].getOutPoint();
          trimStart = inPoint.seconds;
          trimEnd = outPoint.seconds;
          source = "timeline";
          console.log("StemForge: loaded from Timeline selection", { trimStart, trimEnd });
        }
      }
      if (!projectItem) {
        const projectSelection = await premierepro.ProjectUtils.getSelection(project);
        const items = await projectSelection.getItems();
        if (items.length > 0) {
          projectItem = items[0];
          source = "project-panel";
          console.log("StemForge: nothing selected on the Timeline - fell back to Project panel selection (whole file, no trim)");
        }
      }
      if (!projectItem) {
        setStatus("Nothing selected — select a clip in the Timeline or Project panel first", true);
        return;
      }

      const clip = premierepro.ClipProjectItem.cast(projectItem);
      if (!clip) {
        setStatus("Selected item isn't a media clip", true);
        return;
      }
      const mediaPath = await clip.getMediaFilePath();
      if (!mediaPath) {
        setStatus("Could not resolve a file path for the selected clip", true);
        return;
      }

      const fileName = mediaPath.split(/[\\/]/).pop();
      const entry = await getEntryForPath(mediaPath);
      const arrayBuffer = await entry.read({ format: uxpStorage.formats.binary });
      loadFile(arrayBuffer, fileName, trimStart, trimEnd);
      if (source === "timeline") {
        setStatus(`Loaded "${fileName}" — trimmed to Timeline selection (${trimStart.toFixed(1)}s–${trimEnd.toFixed(1)}s)`);
      } else {
        setStatus(`Loaded "${fileName}" — FULL file (nothing was selected on the Timeline; this came from the Project panel, which has no trim)`, true);
      }
    } catch (err) {
      setStatus(`Could not load selection: ${err.message}`, true);
    }
  });

  // --- Analyze ---------------------------------------------------------

  analyzeBtn.addEventListener("click", async () => {
    if (!currentFile) return;
    setBusy(analyzeBtn, true, "Analyzing…");
    setStatus("Detecting BPM and key…");
    await yieldToRender();
    try {
      const result = await StemForgeAPI.analyze(
        currentFile.arrayBuffer, currentFile.name, currentFile.trimStart, currentFile.trimEnd
      );
      lastAnalysis = result;
      // The server sends bpm/confidence as null (never NaN) when detection
      // fails, but guard here too rather than trust that across versions -
      // an un-finite value showing up in the target field is exactly the
      // stale "nan" bug this file previously had no defense against.
      const bpmIsFinite = Number.isFinite(result.bpm);
      detectedBpmLabel.textContent = bpmIsFinite ? result.bpm : "—";
      detectedKeyLabel.textContent = result.key || "—";
      setConfidenceMeter(result.confidence);
      if (!targetBpmInput.value && bpmIsFinite) targetBpmInput.value = result.bpm;
      if (!targetKeyInput.value && result.key) targetKeyInput.value = result.key;
      setStatus("Analysis complete");
    } catch (err) {
      setStatus(`Analysis failed: ${err.message}`, true);
    } finally {
      setBusy(analyzeBtn, false);
    }
  });

  // --- Transform (change BPM / key) ------------------------------------

  transformBtn.addEventListener("click", async () => {
    if (!currentFile) return;
    const targetBpm = targetBpmInput.value ? parseFloat(targetBpmInput.value) : null;
    const targetKey = targetKeyInput.value ? targetKeyInput.value.trim() : null;
    if (!targetBpm && !targetKey) {
      setStatus("Enter a target BPM and/or target key first", true);
      return;
    }
    // parseFloat("nan"/"NaN"/"-") all yield NaN, which is truthy - the
    // check above alone doesn't catch it, and a stale/garbage BPM value
    // sent as-is used to reach the server as a literal NaN.
    if (targetBpm != null && !Number.isFinite(targetBpm)) {
      setStatus(`Target BPM "${targetBpmInput.value}" isn't a valid number`, true);
      return;
    }
    setBusy(transformBtn, true, "Rendering…");
    setStatus("Rendering transformed audio…");
    await yieldToRender();
    try {
      const result = await StemForgeAPI.transform(
        currentFile.arrayBuffer, currentFile.name, targetBpm, targetKey,
        currentFile.trimStart, currentFile.trimEnd
      );
      const outFileName = result.output_path.split(/[\\/]/).pop();
      lastTransformResult = {
        previewUrl: result.preview_url || null,
        serverPath: result.output_path,
        fileName: outFileName,
      };
      transformResultLabel.textContent = outFileName;
      transformResultRow.classList.remove("hidden");
      setStatus("Transform complete");
    } catch (err) {
      setStatus(`Transform failed: ${err.message}`, true);
    } finally {
      setBusy(transformBtn, false);
    }
  });

  importTransformBtn.addEventListener("click", () => {
    if (lastTransformResult) {
      importResults([lastTransformResult], lastTrackName);
    }
  });

  // --- Separate stems ----------------------------------------------------

  separateBtn.addEventListener("click", async () => {
    if (!currentFile) return;
    setBusy(separateBtn, true, "Separating… this can take a while");
    setStatus("Separating stems (this can take a minute or two)…");
    await yieldToRender();
    try {
      const result = await StemForgeAPI.separate(
        currentFile.arrayBuffer, currentFile.name, stemModelSelect.value,
        currentFile.trimStart, currentFile.trimEnd
      );
      const previewUrls = result.stem_preview_urls || {};
      lastStemResults = Object.entries(result.stems).map(([name, serverPath]) => ({
        name,
        previewUrl: previewUrls[name] || null,
        serverPath,
        fileName: String(serverPath).split(/[\\/]/).pop(),
        colorLabel: STEM_COLOR_LABELS[name],
      }));
      renderStemList(lastStemResults);
      setStatus(`Separated into ${lastStemResults.length} stems`);
    } catch (err) {
      setStatus(`Separation failed: ${err.message}`, true);
    } finally {
      setBusy(separateBtn, false);
    }
  });

  function renderStemList(stemResults) {
    stemList.innerHTML = "";
    stemResults.forEach((stem) => {
      const li = document.createElement("li");
      li.className = `stem-item stem-${stem.name}`;

      const label = document.createElement("span");
      label.className = "stem-label";
      const dot = document.createElement("span");
      dot.className = "stem-dot";
      label.appendChild(dot);
      label.appendChild(document.createTextNode(stem.name));

      const actions = document.createElement("div");
      actions.className = "stem-actions";

      const btn = document.createElement("button");
      btn.className = "btn";
      btn.textContent = "Import";
      btn.addEventListener("click", () => importResults([stem], lastTrackName));
      actions.appendChild(btn);

      li.appendChild(label);
      li.appendChild(actions);
      stemList.appendChild(li);
    });
    importAllStemsBtn.classList.toggle("hidden", stemResults.length === 0);
  }

  importAllStemsBtn.addEventListener("click", () => {
    if (!lastStemResults.length) return;
    importResults(lastStemResults, lastTrackName);
  });

  // --- Premiere Pro project import ---------------------------------------

  const APP_BIN_NAME = "StemForge";

  // Finds an existing bin by name directly under `container` (the project
  // root, or another bin), or creates one there. Reusing the bin means
  // stems imported one at a time (or a transform result imported after
  // the stems) still land together instead of creating duplicate bins.
  async function getOrCreateBin(project, container, binName) {
    let items = await container.getItems();
    let bin = items.find((item) => item.name === binName);
    if (!bin) {
      await project.lockedAccess(() => {
        return project.executeTransaction((compoundAction) => {
          const action = container.createBinAction(binName, true);
          compoundAction.addAction(action);
        }, `Create bin ${binName}`);
      });
      items = await container.getItems();
      bin = items.find((item) => item.name === binName);
    }
    return bin;
  }

  // Every StemForge import lands under one top-level "StemForge" bin, with
  // a sub-bin per source track, so everything the plugin has ever created
  // stays grouped in one findable place in the Project panel.
  async function getOrCreateTrackBin(project, trackBinName) {
    const rootItem = await project.getRootItem();
    const appBin = await getOrCreateBin(project, rootItem, APP_BIN_NAME);
    const appBinFolder = premierepro.FolderItem.cast(appBin);
    return getOrCreateBin(project, appBinFolder, trackBinName);
  }

  async function importPathsToProject(paths, { colorLabelsByPath, binName } = {}) {
    if (!premierepro) {
      setStatus("Import only available inside Premiere Pro", true);
      return;
    }
    try {
      const project = await premierepro.Project.getActiveProject();
      if (!project) {
        setStatus("No active Premiere Pro project", true);
        return;
      }

      // ===== StemForge import diagnostics (temporary) =====
      console.error("StemForge: ===== importPathsToProject START =====");
      console.error("StemForge: paths =", JSON.stringify(paths));
      console.error("StemForge: binName =", JSON.stringify(binName));

      const targetBin = binName ? await getOrCreateTrackBin(project, binName) : undefined;
      const targetBinFolder = targetBin ? premierepro.FolderItem.cast(targetBin) : undefined;

      const describe = (o) => {
        if (!o) return String(o);
        let ctor = "?";
        try { ctor = o.constructor && o.constructor.name; } catch (e) {}
        return `ctor=${ctor} name=${(() => { try { return o.name; } catch (e) { return "<throw>"; } })()} type=${(() => { try { return o.type; } catch (e) { return "<throw>"; } })()}`;
      };
      console.error("StemForge: targetBin        ->", describe(targetBin));
      console.error("StemForge: targetBinFolder  ->", describe(targetBinFolder));
      const nodeFs = (() => { try { return require("fs"); } catch (e) { return null; } })();
      if (nodeFs) {
        for (const p of paths) {
          let stat = "<no fs>";
          try { const s = nodeFs.lstatSync(p); stat = `exists size=${s.size}`; } catch (e) { stat = `MISSING (${e.message})`; }
          console.error("StemForge: path check", JSON.stringify(p), "->", stat);
        }
      }

      const binBefore = targetBinFolder ? (await targetBinFolder.getItems()).map((i) => i.name) : null;
      console.error("StemForge: bin items  BEFORE  =", JSON.stringify(binBefore));

      const importedOk = await project.importFiles(paths, true, targetBinFolder, false);
      console.error("StemForge: importFiles() returned (literal) =", importedOk, "typeof =", typeof importedOk);

      const binAfter = targetBinFolder ? (await targetBinFolder.getItems()).map((i) => i.name) : null;
      console.error("StemForge: bin items  AFTER   =", JSON.stringify(binAfter), "length =", binAfter ? binAfter.length : "n/a");
      console.error("StemForge: ===== importPathsToProject END =====");
      // ===== end diagnostics =====

      // importFiles() has been seen to return a falsy value even on a
      // successful import in some Premiere builds, so trust the bin
      // contents over the return value: only treat it as failed if the
      // target bin genuinely gained nothing.
      const importedCount = binBefore && binAfter ? (binAfter.length - binBefore.length) : null;
      if (!importedOk && !(importedCount > 0)) {
        throw new Error("Premiere's importFiles() imported nothing - check that these paths still exist and are readable");
      }

      if (colorLabelsByPath && targetBinFolder) {
        // Search only inside the bin we imported into - importFiles()
        // doesn't return the created ProjectItems, and searching the
        // whole project root previously missed items entirely whenever
        // files landed somewhere other than the literal root (e.g. import
        // used to go wherever the Project panel's current selection was).
        const binItems = await targetBinFolder.getItems();
        for (const path of paths) {
          await setColorLabelForImportedFile(project, binItems, path, colorLabelsByPath[path]);
        }
      }
      setStatus(`Imported ${paths.length} file(s) into "${APP_BIN_NAME}/${binName}"`);
    } catch (err) {
      setStatus(`Import failed: ${err.message}`, true);
    }
  }

  // Matches an imported clip's Project panel label color to the color it
  // was shown with in this panel's stem list (e.g. drums -> Mango).
  // Best-effort: Premiere's importFiles() doesn't return the created
  // ProjectItem, so the newly imported item is located by filename among
  // the target bin's own items.
  async function setColorLabelForImportedFile(project, binItems, filePath, colorLabelName) {
    if (!colorLabelName) return;
    const colorLabel = premierepro.Constants.ProjectItemColorLabel[colorLabelName];
    if (colorLabel === undefined) return;
    try {
      const fileName = filePath.split(/[\\/]/).pop();
      const bareName = fileName.replace(/\.[^./\\]+$/, "");
      const target = binItems.find((item) => item.name === fileName || item.name === bareName);
      if (!target) return;
      await project.lockedAccess(() => {
        return project.executeTransaction((compoundAction) => {
          const action = target.createSetColorLabelAction(colorLabel);
          compoundAction.addAction(action);
        }, `Set color label for ${fileName}`);
      });
    } catch (err) {
      console.log("StemForge: could not set color label:", err);
    }
  }

  // --- Init --------------------------------------------------------------

  checkServer();
  setInterval(checkServer, 10000);
})();
