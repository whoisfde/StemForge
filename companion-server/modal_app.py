# NOTE (kept for reference only — not part of the current architecture):
# this Modal deployment was tried and shelved. See premiere-plugin/js/api.js's
# BASE_URL comment — both Modal and Hugging Face GPU hosting required ongoing
# payment for what the panel needs, so the shipping architecture went back to
# a local companion service (see companion-server/start_server.sh and the
# LaunchAgent-based auto-start). Revisit this only if/when a paid tier makes
# cloud GPU cost viable, or as an opt-in "cloud processing" mode for users on
# machines too slow to run Demucs locally.

# Deploys the exact same FastAPI app (app/main.py) that runs locally, onto
# Modal's serverless GPU infrastructure instead of this machine. All the
# torch/demucs/librosa dependencies get installed into a cloud-built image
# (nothing installed on this Mac), and the container scales to zero between
# requests, so there's no idle hardware being paid for or maintained.
#
# Deploy with:  modal deploy modal_app.py
import modal

app = modal.App("stemforge")


def _preload_default_model():
    # Runs once at image build time, not at container start. Without this,
    # demucs.api.Separator() downloads the model's weights from the
    # internet on every cold start (Modal containers don't persist
    # anything between scale-to-zero cycles), adding tens of seconds on
    # top of the torch-import/JIT cost. Baking it into the image here
    # means every cold start already has it on disk.
    import demucs.api

    demucs.api.Separator(model="htdemucs")


image = (
    modal.Image.debian_slim(python_version="3.11")
    # ffmpeg backs librosa/soundfile's decoding of non-wav formats (mp3,
    # m4a, video containers pulled in via Load Selected Clip).
    .apt_install("ffmpeg")
    .pip_install(
        "fastapi>=0.115",
        "python-multipart>=0.0.9",
        "torch>=2.2",
        "torchaudio>=2.2",
        "demucs>=4.0.1",
        "librosa>=0.10",
        "soundfile>=0.12",
        "numpy>=1.26",
    )
    .run_function(_preload_default_model)
    # Ships the local app/ package (main.py, separation.py, transform.py,
    # analysis.py, utils.py) into the image unchanged - this is the same
    # code the local server runs, not a rewrite. Kept last in the chain so
    # editing our own source doesn't invalidate the much slower pip-install/
    # model-download layers above on the next deploy.
    .add_local_python_source("app")
)


@app.function(
    image=image,
    gpu="T4",
    timeout=900,
    scaledown_window=300,
    secrets=[modal.Secret.from_name("stemforge-api-key")],
    # Each container has its own separate disk - output files written by
    # /transform or /separate only exist on whichever container handled
    # that request. The plugin polls /health every 10s in the background,
    # and that concurrent traffic during a slow /transform call was enough
    # for Modal to spin up a second container to serve it - which then had
    # no file when the immediate download-for-import request landed there
    # instead of back on the first one (404, confirmed by reproducing the
    # sequential case successfully but seeing it fail under real usage).
    # Capping at one container forces every request through the same
    # instance, so this can't happen - it still scales to zero when idle.
    max_containers=1,
)
@modal.asgi_app()
def fastapi_app():
    # Imported here, not at module top-level, so this file stays importable
    # locally (e.g. by `modal deploy`) without torch/demucs installed on
    # this machine - the actual import only happens inside the container.
    from app.main import app as web_app

    return web_app
