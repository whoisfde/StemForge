import asyncio
import logging
import math
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import separation as separation_module
from . import transform as transform_module
from .analysis import analyze_file
from .separation import DEFAULT_MODEL, SeparationError, separate_file
from .transform import transform_file
from .utils import (
    SEPARATED_DIR,
    TRANSFORMED_DIR,
    UPLOADS_DIR,
    WORK_DIR,
    save_upload,
    to_preview_url,
    trim_to_temp_if_needed,
)

log = logging.getLogger("uvicorn")

# Unset for local dev (server only reachable on localhost, no auth needed).
# The Modal deployment sets this via a Modal Secret, turning auth on for
# the public endpoint so a stranger with the URL can't run up GPU cost.
REQUIRED_API_KEY = os.environ.get("STEMFORGE_API_KEY")


def require_api_key(x_api_key: Optional[str] = Header(None)):
    if REQUIRED_API_KEY and x_api_key != REQUIRED_API_KEY:
        raise HTTPException(status_code=401, detail="Missing or invalid API key")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ASGI startup doesn't finish - and nothing, not even /health, gets
    # served - until this function yields. Demucs model loading and
    # librosa/numba JIT compilation are each a one-time, multi-minute-
    # worst-case cost, which used to be paid right here so it wouldn't
    # land on whichever request hit /separate or /transform first. On an
    # always-on local server that's a one-time startup delay; on Modal's
    # scale-to-zero, it reran on every cold start and made /health (and so
    # the plugin's "connected" indicator) hang for 30-40+ seconds. Warm-up
    # now runs in the background after yielding, so /health responds the
    # moment the container is up - the very first real /separate or
    # /transform request after a cold start still pays the cost directly
    # if it lands before background warm-up finishes.
    async def warm_up_in_background():
        loop = asyncio.get_event_loop()
        try:
            log.info("Warming up transform (librosa/numba)...")
            await loop.run_in_executor(None, transform_module.warm_up)
            log.info("Warming up separation (default Demucs model)...")
            await loop.run_in_executor(None, separation_module.warm_up)
            log.info("Warm-up complete.")
        except Exception:
            log.exception("Background warm-up failed")

    asyncio.create_task(warm_up_in_background())
    yield


app = FastAPI(title="StemForge Companion Service", lifespan=lifespan)

# UXP panels run on a file:// / uxp:// origin; CORS is relaxed here because
# this server only ever binds to localhost for a single local user.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Lets the panel's <audio> elements preview a stem/transform output over
# http://localhost:17890/files/... before the user decides to import it.
app.mount("/files", StaticFiles(directory=str(WORK_DIR)), name="files")

# Belt-and-suspenders: each route below already turns its own expected
# failure modes into an HTTPException with a real `detail` message. This
# catches anything that still gets through uncaught (a bug, a new failure
# mode nobody's hit yet) so the client always gets JSON with a `detail`
# string it can show - not FastAPI/Starlette's default plain-text 500,
# which broke api.js's error parsing and just showed a bare "Server
# returned 500 Internal Server Error" with no indication of what failed.
@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    log.exception("Unhandled error handling %s", request.url.path)
    return JSONResponse(status_code=500, content={"detail": f"Unexpected server error: {exc}"})

# /analyze, /separate, /transform are declared as plain `def`, not `async
# def`: they call fully synchronous, blocking code (subprocess.run,
# librosa.load). An `async def` route that blocks like that freezes
# FastAPI's single event loop for the whole request, so nothing else -
# not even /health - can be served until it finishes. Plain `def` routes
# are dispatched to a worker thread by Starlette automatically, keeping
# the server responsive while a multi-minute separation runs.


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/analyze", dependencies=[Depends(require_api_key)])
def analyze(
    file: UploadFile = File(...),
    trim_start: Optional[float] = Form(None),
    trim_end: Optional[float] = Form(None),
):
    src_path = save_upload(file, UPLOADS_DIR)
    try:
        working_path = trim_to_temp_if_needed(src_path, trim_start, trim_end)
        return analyze_file(working_path)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/separate", dependencies=[Depends(require_api_key)])
def separate(
    file: UploadFile = File(...),
    model: str = Form(DEFAULT_MODEL),
    trim_start: Optional[float] = Form(None),
    trim_end: Optional[float] = Form(None),
):
    src_path = save_upload(file, UPLOADS_DIR)
    job_out_dir = SEPARATED_DIR / src_path.parent.name
    try:
        working_path = trim_to_temp_if_needed(src_path, trim_start, trim_end)
        result = separate_file(working_path, job_out_dir, model=model)
    except SeparationError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        # Anything else - most commonly trim_to_temp_if_needed() failing to
        # decode the source (e.g. an AAC-in-MP4 file the default decoder
        # can't open) - used to propagate uncaught here (unlike /analyze
        # and /transform below, which already catch broadly) and surface
        # to the plugin as a bare "Server returned 500", no detail at all.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    result["stem_preview_urls"] = {
        name: to_preview_url(path) for name, path in result["stems"].items()
    }
    return result


@app.post("/transform", dependencies=[Depends(require_api_key)])
def transform(
    file: UploadFile = File(...),
    target_bpm: Optional[float] = Form(None),
    target_key: Optional[str] = Form(None),
    trim_start: Optional[float] = Form(None),
    trim_end: Optional[float] = Form(None),
):
    if not target_bpm and not target_key:
        raise HTTPException(status_code=400, detail="Provide target_bpm and/or target_key")
    # float("nan") parses without error, and `if not target_bpm` doesn't
    # catch it (NaN is truthy in Python) - reject it explicitly instead of
    # letting it reach librosa's time-stretch as a silent no-op/garbage rate.
    if target_bpm is not None and not math.isfinite(target_bpm):
        raise HTTPException(status_code=400, detail=f"target_bpm must be a finite number, got {target_bpm!r}")

    src_path = save_upload(file, UPLOADS_DIR)
    try:
        working_path = trim_to_temp_if_needed(src_path, trim_start, trim_end)
        # Always write .wav regardless of the source extension: sources can
        # be video files (e.g. a clip loaded from Premiere's timeline), and
        # soundfile can't write most video containers (.mp4, .mov, ...)
        # even though librosa can read the audio track out of them fine.
        out_path = TRANSFORMED_DIR / src_path.parent.name / f"Transformed - {working_path.stem}.wav"
        result = transform_file(working_path, out_path, target_bpm, target_key)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    result["preview_url"] = to_preview_url(result["output_path"])
    return result
