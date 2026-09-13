import re
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import quote

import librosa
import numpy as np
import soundfile as sf

WORK_DIR = Path(__file__).resolve().parent.parent / "work"
UPLOADS_DIR = WORK_DIR / "uploads"
SEPARATED_DIR = WORK_DIR / "separated"
TRANSFORMED_DIR = WORK_DIR / "transformed"

for d in (UPLOADS_DIR, SEPARATED_DIR, TRANSFORMED_DIR):
    d.mkdir(parents=True, exist_ok=True)

PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Alternate spellings a user might type for a target key.
ENHARMONIC_ALIASES = {
    "Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#",
}


def new_job_dir(base: Path) -> Path:
    job_dir = base / uuid.uuid4().hex
    job_dir.mkdir(parents=True, exist_ok=True)
    return job_dir


def sanitize_filename(name: str) -> str:
    """Strip characters that are unsafe in filenames, keep it human-readable."""
    cleaned = re.sub(r'[/\\:*?"<>|\x00-\x1f]', "-", name)
    cleaned = cleaned.strip(" .")
    return cleaned[:150] or "audio"


def save_upload(upload_file, dest_dir: Path) -> Path:
    """Save an upload under its own sanitized original name (not a generic
    "input.ext"), since the track name is later reused to build descriptive
    stem/output filenames like "<track> - Drums.wav"."""
    job_dir = new_job_dir(dest_dir)
    original_name = Path(upload_file.filename or "audio").name
    suffix = Path(original_name).suffix or ".wav"
    base = sanitize_filename(Path(original_name).stem)
    dest_path = job_dir / f"{base}{suffix}"
    with dest_path.open("wb") as f:
        shutil.copyfileobj(upload_file.file, f)
    return dest_path


class AudioDecodeError(RuntimeError):
    pass


def _ffmpeg_decode(
    path: Path, offset: float = 0.0, duration: Optional[float] = None, mono: bool = False
) -> tuple[np.ndarray, int]:
    """Decode audio via an `ffmpeg` subprocess, bypassing libsndfile entirely.

    librosa.load()'s only backend (soundfile/libsndfile) cannot open video
    containers at all when the audio track is AAC - which is the normal
    codec inside an .mp4/.mov grabbed from a "download this music video"
    source (h264 video + aac audio). That previously surfaced as a bare
    500 from /analyze, /transform, and /separate (only when trimming was
    requested, since separate's own Demucs/torchaudio loader handles AAC
    fine on the untrimmed path). ffmpeg decodes essentially any container,
    so it's the fallback of last resort - and does the trim itself via
    -ss/-t, which is faster than loading the whole file into memory first.
    """
    sr = 44100
    channels = 1 if mono else 2
    cmd = ["ffmpeg", "-v", "error", "-nostdin"]
    if offset:
        cmd += ["-ss", str(offset)]
    cmd += ["-i", str(path)]
    if duration is not None:
        cmd += ["-t", str(duration)]
    cmd += ["-vn", "-ac", str(channels), "-ar", str(sr), "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"]

    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError as exc:
        raise AudioDecodeError(
            "ffmpeg is required to read this file's audio but isn't installed "
            "(brew install ffmpeg), and the default audio decoder couldn't open it either."
        ) from exc

    if proc.returncode != 0 or not proc.stdout:
        stderr = proc.stderr.decode("utf-8", errors="replace").strip()
        raise AudioDecodeError(f"Could not decode audio from {path.name}: {stderr[-500:]}")

    y = np.frombuffer(proc.stdout, dtype=np.float32)
    if not mono:
        y = y.reshape(-1, channels).T  # (channels, samples), matching librosa's stereo shape
    return y, sr


def load_audio(
    path: Path, *, sr: Optional[int] = None, mono: bool = True,
    offset: float = 0.0, duration: Optional[float] = None,
) -> tuple[np.ndarray, int]:
    """Drop-in replacement for librosa.load() used everywhere in this app,
    so every caller (analyze, transform, trim) gets the ffmpeg fallback for
    free instead of each needing its own try/except around librosa.load().
    """
    try:
        return librosa.load(str(path), sr=sr, mono=mono, offset=offset, duration=duration)
    except Exception:
        y, native_sr = _ffmpeg_decode(path, offset=offset, duration=duration, mono=mono)
        if sr is not None and sr != native_sr:
            y = librosa.resample(y, orig_sr=native_sr, target_sr=sr)
            native_sr = sr
        return y, native_sr


def trim_to_temp_if_needed(
    src_path: Path, trim_start: Optional[float], trim_end: Optional[float]
) -> Path:
    """Loading a clip's *selection* from Premiere's Timeline hands us the
    full original source file plus the track item's in/out points, since
    Premiere has no API to export just the trimmed range. When trim points
    are given, this renders just that slice to a temp file, which analyze/
    transform/separate then treat as if it were the uploaded file all along.
    """
    if trim_start is None and trim_end is None:
        return src_path
    offset = trim_start or 0.0
    duration = (trim_end - offset) if trim_end is not None else None
    if duration is not None and duration <= 0:
        raise ValueError(f"Invalid trim range: start={trim_start} end={trim_end}")

    # mono=False preserves stereo - this trimmed file feeds straight into
    # analyze/transform/separate, and separate in particular (Demucs) is
    # trained on and expects stereo; flattening to mono here would have
    # degraded every downstream step for anything loaded via trim.
    y, sr = load_audio(src_path, sr=None, mono=False, offset=offset, duration=duration)
    # Always .wav regardless of the source extension: soundfile can't write
    # most video/compressed containers (.mp4, .mov, ...).
    trimmed_path = src_path.with_name(f"{src_path.stem} (trimmed).wav")
    # soundfile expects (samples, channels); librosa gives (channels, samples).
    sf.write(str(trimmed_path), y.T if y.ndim > 1 else y, sr)
    return trimmed_path


def to_preview_url(path: Path) -> str:
    """Map a file under WORK_DIR to the URL it's served at for <audio> preview.

    Percent-encoded per path segment (spaces, brackets, parens are common in
    track names) so the client can use the URL as-is, without depending on
    its own fetch/URL implementation to encode it consistently.
    """
    relative = Path(path).resolve().relative_to(WORK_DIR)
    return "/files/" + "/".join(quote(part) for part in relative.parts)


def parse_key_name(name: str) -> tuple[str, int]:
    """Parse a key label like 'F# minor', 'Bb', or 'C#m' into (pitch_class, mode).

    mode: 0 = major, 1 = minor. Defaults to major if unspecified.
    """
    stripped = name.strip()
    lower = stripped.lower()
    is_minor = "minor" in lower or "min" in lower or lower.endswith("m")
    mode = 1 if is_minor else 0

    root = stripped
    for token in ("minor", "major", "min", "maj"):
        idx = lower.find(token)
        if idx != -1:
            root = stripped[:idx]
            break
    root = root.strip()
    if root.endswith("m") and len(root) > 1:
        root = root[:-1]

    candidate = ENHARMONIC_ALIASES.get(root, root)
    if candidate in PITCH_CLASSES:
        return candidate, mode
    raise ValueError(f"Could not parse key name: {name!r}")


def semitone_shift_between(from_pitch_class: str, to_pitch_class: str) -> int:
    from_pitch_class = ENHARMONIC_ALIASES.get(from_pitch_class, from_pitch_class)
    to_pitch_class = ENHARMONIC_ALIASES.get(to_pitch_class, to_pitch_class)
    from_idx = PITCH_CLASSES.index(from_pitch_class)
    to_idx = PITCH_CLASSES.index(to_pitch_class)
    shift = (to_idx - from_idx) % 12
    if shift > 6:
        shift -= 12
    return shift
