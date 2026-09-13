// Thin client for the local StemForge companion service (see /companion-server).
//
// Note: this deliberately does NOT use FormData.append(name, blob, filename).
// In this UXP host, that call silently drops the file semantics and the
// field arrives at the server as a plain string ("Expected UploadFile,
// received: <class 'str'>"). Building the multipart/form-data body by hand
// avoids relying on FormData/Blob type-detection inside UXP's fetch shim.
const StemForgeAPI = (() => {
  // Cloud hosting (Modal, then Hugging Face) both turned out to require
  // payment for what this needs (a real GPU, or even CPU Docker hosting) -
  // back to the local companion service, now auto-started via a
  // LaunchAgent (see ~/Library/LaunchAgents/com.stemforge.companion.plist)
  // so it's always running without manually launching it each time.
  const BASE_URL = "http://localhost:17890";

  function randomBoundary() {
    return `StemForgeBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  }

  // UXP's JS environment has no global TextEncoder, so UTF-8 bytes are
  // built by hand here instead of relying on that browser API.
  function encodeUtf8(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      let code = str.codePointAt(i);
      if (code > 0xffff) i++; // consumed a surrogate pair
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0x10000) {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
      }
    }
    return new Uint8Array(bytes);
  }

  function buildMultipartBody(boundary, fileBytes, fileName, extraFields) {
    const CRLF = "\r\n";
    const parts = [];

    Object.entries(extraFields || {}).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      parts.push(encodeUtf8(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${key}"${CRLF}${CRLF}${value}${CRLF}`
      ));
    });

    parts.push(encodeUtf8(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}` +
      `Content-Type: application/octet-stream${CRLF}${CRLF}`
    ));
    parts.push(fileBytes instanceof ArrayBuffer ? new Uint8Array(fileBytes) : fileBytes);
    parts.push(encodeUtf8(`${CRLF}--${boundary}--${CRLF}`));

    return new Blob(parts);
  }

  async function health() {
    const res = await fetch(`${BASE_URL}/health`);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    return res.json();
  }

  // Stem/transform outputs are written to disk by the server AND served
  // back over its /files mount. The panel downloads them through here so
  // it can re-stage each one inside the plugin's own sandbox before
  // importing: an installed (non-UDT) plugin is only allowed to hand
  // Premiere paths it owns, not arbitrary paths inside the companion
  // server's working directory - which is why "Import" did nothing once
  // the plugin was installed as a real extension rather than loaded via
  // the UXP Developer Tool.
  async function fetchResultFile(fileUrlOrPath) {
    const url = /^https?:\/\//i.test(fileUrlOrPath)
      ? fileUrlOrPath
      : `${BASE_URL}${fileUrlOrPath.startsWith("/") ? "" : "/"}${fileUrlOrPath}`;
    let res;
    try {
      res = await fetch(url);
    } catch (networkErr) {
      console.log("StemForge: result-file download failed", url, networkErr);
      throw new Error("Could not download a result file from the StemForge service.");
    }
    if (!res.ok) throw new Error(`Result file download returned ${res.status}`);
    return res.arrayBuffer();
  }

  async function postFile(path, fileBytes, fileName, extraFields) {
    const boundary = randomBoundary();
    const body = buildMultipartBody(boundary, fileBytes, fileName, extraFields);

    let res;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body,
      });
    } catch (networkErr) {
      console.log("StemForge: network request failed", BASE_URL + path, networkErr);
      throw new Error("Could not reach the StemForge processing service. Make sure it's running and try again.");
    }
    if (!res.ok) {
      throw new Error(await extractErrorMessage(res));
    }
    return res.json();
  }

  // FastAPI returns either {"detail": "some string"} for our own HTTPExceptions,
  // or {"detail": [{"msg": "...", "loc": [...], ...}, ...]} for request-validation
  // errors (e.g. a malformed/missing file part) - normalize both into one string.
  async function extractErrorMessage(res) {
    let body;
    try {
      body = await res.json();
    } catch {
      return `Server returned ${res.status} ${res.statusText}`;
    }
    const detail = body && body.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((item) => (item && item.msg) ? `${(item.loc || []).join(".")}: ${item.msg}` : JSON.stringify(item))
        .join("; ");
    }
    if (detail) return JSON.stringify(detail);
    return `Server returned ${res.status} ${res.statusText}`;
  }

  function analyze(fileBytes, fileName, trimStart, trimEnd) {
    return postFile("/analyze", fileBytes, fileName, { trim_start: trimStart, trim_end: trimEnd });
  }

  function separate(fileBytes, fileName, model, trimStart, trimEnd) {
    return postFile("/separate", fileBytes, fileName, {
      model,
      trim_start: trimStart,
      trim_end: trimEnd,
    });
  }

  function transform(fileBytes, fileName, targetBpm, targetKey, trimStart, trimEnd) {
    return postFile("/transform", fileBytes, fileName, {
      target_bpm: targetBpm,
      target_key: targetKey,
      trim_start: trimStart,
      trim_end: trimEnd,
    });
  }

  return { BASE_URL, health, analyze, separate, transform, fetchResultFile };
})();
