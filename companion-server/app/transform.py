import math
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

from .analysis import analyze_file
from .utils import load_audio, parse_key_name, semitone_shift_between


def warm_up() -> None:
    """Runs time_stretch/pitch_shift once on throwaway buffers so their
    underlying numba JIT compilation happens at server startup instead of
    silently costing minutes on whichever request calls /transform first.
    Both a mono and a stereo shape are warmed up, since numba compiles
    per-shape and most real music is stereo."""
    mono = np.zeros(4096, dtype=np.float32)
    librosa.effects.time_stretch(mono, rate=1.1)
    librosa.effects.pitch_shift(mono, sr=22050, n_steps=1)
    stereo = np.zeros((2, 4096), dtype=np.float32)
    librosa.effects.time_stretch(stereo, rate=1.1)
    librosa.effects.pitch_shift(stereo, sr=22050, n_steps=1)


def transform_file(
    src_path: Path,
    out_path: Path,
    target_bpm: float | None,
    target_key: str | None,
) -> dict:
    """Time-stretch to a target BPM and/or pitch-shift to a target key.

    Both operations are independent (time-stretch does not change pitch,
    pitch-shift does not change duration), so they can be combined freely.
    """
    # mono=False preserves stereo (shape (channels, samples)) - forcing
    # mono here was summing stereo down to one channel for the actual
    # audible output, which noticeably thins/muffles most music (lost
    # width, and any out-of-phase content between channels cancels out).
    # analyze_file separately loads its own mono copy internally, which is
    # fine since BPM/key detection doesn't need stereo.
    y, sr = load_audio(src_path, sr=None, mono=False)
    source_info = analyze_file(src_path)

    applied = {}

    # `if target_bpm:` alone would treat float('nan') as truthy (NaN is
    # truthy in Python) and silently run time_stretch(rate=nan) - this
    # happened whenever a stale/unvalidated value made it into the target
    # BPM field client-side. isfinite() guards it here too, in addition to
    # the request-level validation in main.py.
    if target_bpm and math.isfinite(target_bpm):
        if not source_info["bpm"]:
            raise ValueError("Could not detect a source BPM for this file, so it can't be retimed to a target BPM")
        rate = target_bpm / source_info["bpm"]
        y = librosa.effects.time_stretch(y, rate=rate)
        applied["bpm"] = {"from": source_info["bpm"], "to": target_bpm, "rate": round(rate, 4)}

    if target_key:
        target_pitch_class, _mode = parse_key_name(target_key)
        semitones = semitone_shift_between(source_info["pitch_class"], target_pitch_class)
        if semitones != 0:
            y = librosa.effects.pitch_shift(y, sr=sr, n_steps=semitones)
        applied["key"] = {
            "from": source_info["key"],
            "to": target_key,
            "semitones": semitones,
        }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    # soundfile expects (samples, channels) - the opposite axis order from
    # librosa's (channels, samples) - so a stereo array needs transposing;
    # a mono array is already the 1-D shape soundfile expects.
    sf.write(str(out_path), y.T if y.ndim > 1 else y, sr)

    return {
        "output_path": str(out_path),
        "source": source_info,
        "applied": applied,
    }
