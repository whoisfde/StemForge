from pathlib import Path

import librosa
import numpy as np

from .utils import PITCH_CLASSES, load_audio

# Krumhansl-Schmuckler key profiles (Krumhansl & Kessler, 1982).
MAJOR_PROFILE = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
)
MINOR_PROFILE = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
)


def detect_bpm(y: np.ndarray, sr: int) -> float | None:
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    bpm = float(np.atleast_1d(tempo)[0])
    # Guard against NaN/inf (e.g. near-silent input) - Python's json module
    # would emit a bare `NaN` token, which is invalid JSON and breaks
    # strict clients like the browser's fetch().json().
    return round(bpm, 2) if np.isfinite(bpm) else None


def detect_key(y: np.ndarray, sr: int) -> dict:
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = chroma.mean(axis=1)
    chroma_mean = chroma_mean / (np.linalg.norm(chroma_mean) + 1e-9)

    best = {"score": -np.inf, "pitch_class": None, "mode": None}
    for shift in range(12):
        major_corr = np.corrcoef(chroma_mean, np.roll(MAJOR_PROFILE, shift))[0, 1]
        minor_corr = np.corrcoef(chroma_mean, np.roll(MINOR_PROFILE, shift))[0, 1]
        if major_corr > best["score"]:
            best = {"score": major_corr, "pitch_class": PITCH_CLASSES[shift], "mode": "major"}
        if minor_corr > best["score"]:
            best = {"score": minor_corr, "pitch_class": PITCH_CLASSES[shift], "mode": "minor"}

    score = float(best["score"])
    return {
        "key": f"{best['pitch_class']} {best['mode']}",
        "pitch_class": best["pitch_class"],
        "mode": best["mode"],
        "confidence": round(score, 3) if np.isfinite(score) else None,
    }


def analyze_file(path: Path) -> dict:
    # load_audio falls back to ffmpeg for containers libsndfile can't open
    # at all (e.g. AAC audio in an .mp4/.mov "music video" download).
    y, sr = load_audio(path, sr=None, mono=True)
    bpm = detect_bpm(y, sr)
    key_info = detect_key(y, sr)
    duration = round(float(len(y) / sr), 3)
    return {
        "bpm": bpm,
        "duration_seconds": duration,
        **key_info,
    }
