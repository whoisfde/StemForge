import threading
from pathlib import Path

import demucs.api

# htdemucs: 4 stems (drums, bass, other, vocals) - fast, great default.
# htdemucs_6s: 6 stems (drums, bass, other, vocals, guitar, piano) - slower.
# vocals_instrumental: not a real Demucs model - separates with htdemucs,
# then sums every non-vocal stem into one "instrumental" track, instead of
# returning drums/bass/other individually.
AVAILABLE_MODELS = {"htdemucs", "htdemucs_6s", "htdemucs_ft", "mdx_extra", "vocals_instrumental"}
DEFAULT_MODEL = "htdemucs"
TWO_STEMS_MODEL = "vocals_instrumental"
TWO_STEMS_BASE_MODEL = "htdemucs"

STEM_LABELS = {
    "drums": "Drums",
    "bass": "Bass",
    "vocals": "Vocals",
    "other": "Other",
    "guitar": "Guitar",
    "piano": "Piano",
    "instrumental": "Instrumental",
}

# Loading a model (demucs.api.Separator) is what pays the one-time,
# multi-minute PyTorch-import cost. Keyed by model name and reused across
# requests so only the *first* separation of a given model is slow -
# previously every request re-ran `python -m demucs` as a fresh subprocess,
# re-paying that cost every single time.
_separators: dict[str, demucs.api.Separator] = {}
_separators_lock = threading.Lock()

# Tracks the default model's warm-up progress so the desktop UI can show a
# "downloading the model" state on first launch instead of just looking
# stuck. "setting_up" until warm_up() finishes, then "ready" or "error".
_state_lock = threading.Lock()
_stage = "setting_up"
_error: str | None = None


class SeparationError(RuntimeError):
    pass


def get_state() -> dict:
    with _state_lock:
        return {"stage": _stage, "error": _error}


def set_stage(stage: str, error: str | None = None) -> None:
    global _stage, _error
    with _state_lock:
        _stage = stage
        _error = error


def _get_separator(model: str) -> demucs.api.Separator:
    with _separators_lock:
        separator = _separators.get(model)
        if separator is None:
            separator = demucs.api.Separator(model=model)
            _separators[model] = separator
        return separator


def warm_up(model: str = DEFAULT_MODEL) -> None:
    """Loads the default model at server startup instead of on whichever
    request calls /separate first."""
    set_stage("setting_up")
    try:
        _get_separator(model)
    except Exception as exc:  # noqa: BLE001
        set_stage("error", str(exc))
        raise
    else:
        set_stage("ready")


def separate_file(src_path: Path, out_dir: Path, model: str = DEFAULT_MODEL) -> dict:
    if model not in AVAILABLE_MODELS:
        raise ValueError(f"Unknown model {model!r}. Choose from {sorted(AVAILABLE_MODELS)}")

    two_stems = model == TWO_STEMS_MODEL
    real_model = TWO_STEMS_BASE_MODEL if two_stems else model

    try:
        separator = _get_separator(real_model)
        _original, stem_tensors = separator.separate_audio_file(src_path)
    except Exception as exc:  # noqa: BLE001
        raise SeparationError(str(exc)) from exc

    if two_stems:
        vocals = stem_tensors["vocals"]
        instrumental = sum(
            tensor for name, tensor in stem_tensors.items() if name != "vocals"
        )
        stem_tensors = {"vocals": vocals, "instrumental": instrumental}

    track_name = src_path.stem
    stems_dir = out_dir / real_model / track_name
    stems_dir.mkdir(parents=True, exist_ok=True)

    stems = {}
    # "<Stem> - <track name>.wav" - stem type leads so clips of the same
    # kind (e.g. all "Vocals - ...") are easy to spot at a glance, and
    # Premiere names an imported clip after the file's own basename.
    for name, tensor in stem_tensors.items():
        label = STEM_LABELS.get(name, name.title())
        out_path = stems_dir / f"{label} - {track_name}.wav"
        demucs.api.save_audio(tensor, out_path, samplerate=separator.samplerate)
        stems[name] = str(out_path)

    if not stems:
        raise SeparationError(f"No stem files produced in {stems_dir}")

    return {"model": model, "stems": stems}
