import base64
import io
import logging
import os
import threading
import time
from contextlib import asynccontextmanager

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from PIL import Image
from pydantic import BaseModel

import coremltools as ct
from clip_tokenizer import ClipTokenizer
from coremltools.models import CompiledMLModel
from text_tokenizer import TextTokenizer

# OCR for scanned PDFs (file-vault /extract) uses native macOS frameworks via
# pyobjc — CoreGraphics rasterizes each PDF page, Apple Vision recognizes text.
# Guarded so the embedder still serves embeddings if pyobjc isn't installed;
# /extract then returns 503 rather than crashing startup.
try:
    import Quartz
    import Vision
    from Foundation import NSData

    _VISION_OK = True
except Exception:  # noqa: BLE001 — any import failure disables OCR, not the service
    _VISION_OK = False

# Config comes from the environment only. start.sh copies this service's two
# keys out of the monorepo root .env (.specs/env.md). This file never opens a
# .env itself: the runner ships it in its npm package (apps/runner embedder/),
# and npm pulled runner 0.28.0 and 0.33.0 as malware while it read one.

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("embedder")

# Shared secret: the server sends it as `x-api-key`. When set, requests without
# it are rejected so only our server (which has the key) can use the embedder.
API_KEY = os.environ.get("EMBEDDER_API_KEY")
if not API_KEY:
    logger.warning("EMBEDDER_API_KEY not set — embedder is UNSECURED (open to anyone).")


def require_key(x_api_key: str | None = Header(default=None)):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="invalid or missing api key")

# Three models, all Core ML / Apple Neural Engine, torch-free (~0.5GB serving):
# DINOv2 (768-d) grouping, MobileCLIP2-B (512-d) text<->image, bge-base-en-v1.5 (768-d) text<->text.

DIM = 768
CLIP_DIM = 512
TEXT_DIM = 768

_UNITS = {
    "ne": ct.ComputeUnit.CPU_AND_NE,  # Neural Engine (default — fastest, leanest)
    "gpu": ct.ComputeUnit.CPU_AND_GPU,
    "cpu": ct.ComputeUnit.CPU_ONLY,
    "all": ct.ComputeUnit.ALL,
}
COMPUTE = os.environ.get("COREML_UNITS", "ne")

# DINOv2 preprocessing: resize shorter edge to 256 (bilinear), center-crop 224,
# scale to [0,1], ImageNet normalize.
_DINO_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_DINO_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
# CLIP preprocessing: 224 bilinear, center-crop, scale to [0,1]. MobileCLIP2-B/dfndr2b
# uses NO normalization (mean 0/std 1) — wrong values yield garbage image vectors.
_CLIP_MEAN = np.array([0.0, 0.0, 0.0], dtype=np.float32)
_CLIP_STD = np.array([1.0, 1.0, 1.0], dtype=np.float32)

state: dict = {}


def _load(name: str):
    units = _UNITS[COMPUTE]
    if os.path.isdir(f"{name}.mlmodelc"):
        return CompiledMLModel(f"{name}.mlmodelc", compute_units=units)
    # Fallback to the raw package (slow start; run convert*.py to precompile).
    return ct.models.MLModel(f"{name}.mlpackage", compute_units=units)


@asynccontextmanager
async def lifespan(_: FastAPI):
    state["dino"] = _load("model")
    state["clip_image"] = _load("clip_image")
    state["clip_text"] = _load("clip_text")
    state["clip_tok"] = ClipTokenizer()
    state["text"] = _load("text")
    state["text_tok"] = TextTokenizer()
    yield
    state.clear()


app = FastAPI(lifespan=lifespan)


# Log every request: method, path, status, latency.
@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.perf_counter()
    response = await call_next(request)
    took = (time.perf_counter() - start) * 1000
    logger.info(
        "%s %s -> %s %.0fms",
        request.method,
        request.url.path,
        response.status_code,
        took
    )
    return response


class EmbedRequest(BaseModel):
    image: str  # base64-encoded image bytes


class EmbedResponse(BaseModel):
    vector: list[float]


class TextRequest(BaseModel):
    text: str


def preprocess(raw: bytes, resize: int, mean: np.ndarray, std: np.ndarray) -> np.ndarray:
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    w, h = img.size
    scale = resize / min(w, h)
    # Both image models (DINOv2 and MobileCLIP2-B) use bilinear resize.
    img = img.resize((round(w * scale), round(h * scale)), Image.BILINEAR)
    nw, nh = img.size
    crop = 224
    left, top = (nw - crop) // 2, (nh - crop) // 2
    img = img.crop((left, top, left + crop, top + crop))
    arr = (np.asarray(img, dtype=np.float32) / 255.0 - mean) / std  # HWC
    return arr.transpose(2, 0, 1)[None].astype(np.float32)  # 1,C,H,W


def l2(arr: np.ndarray) -> list[float]:
    vec = np.asarray(arr, dtype=np.float32).flatten()
    vec /= np.linalg.norm(vec) or 1.0
    return vec.tolist()


# Serialize ALL CoreML inference. Sync endpoints run in Starlette's threadpool, so
# concurrent requests would call .predict() on the shared MLModels from multiple
# threads at once — the ANE's MLE5 execution stream is not safe under that and
# segfaults during stream teardown (CoreML -[MLE5ExecutionStream resetAfterLingering]).
# One ANE serializes the real work anyway, so a single global lock costs ~nothing.
_INFER_LOCK = threading.Lock()


def embed_dino(raw: bytes) -> list[float]:
    batch = preprocess(raw, 256, _DINO_MEAN, _DINO_STD)
    with _INFER_LOCK:
        return l2(state["dino"].predict({"image": batch})["embedding"])


def embed_clip_image(raw: bytes) -> list[float]:
    batch = preprocess(raw, 224, _CLIP_MEAN, _CLIP_STD)
    with _INFER_LOCK:
        return l2(state["clip_image"].predict({"image": batch})["embedding"])


def embed_clip_text(text: str) -> list[float]:
    tokens = state["clip_tok"](text)
    with _INFER_LOCK:
        return l2(state["clip_text"].predict({"tokens": tokens})["embedding"])


def embed_text(text: str) -> list[float]:
    ids, mask = state["text_tok"](text)
    with _INFER_LOCK:
        out = state["text"].predict({"input_ids": ids, "attention_mask": mask})
    # The graph already CLS-pools + normalizes (bge); l2 is a harmless re-normalize.
    return l2(out["embedding"])


# --- OCR (Apple Vision) for scanned PDFs -------------------------------------
# Render at 200 DPI: enough resolution for Vision to read body text on a scan
# without ballooning bitmap memory (a US-Letter page is ~1700x2200 px here).
OCR_DPI = 200


def _render_pdf_page(page, scale: float):
    """CGPDFPage -> white-backed RGB CGImage at `scale`× its native size."""
    rect = Quartz.CGPDFPageGetBoxRect(page, Quartz.kCGPDFMediaBox)
    width = max(1, int(rect.size.width * scale))
    height = max(1, int(rect.size.height * scale))
    color_space = Quartz.CGColorSpaceCreateDeviceRGB()
    ctx = Quartz.CGBitmapContextCreate(
        None, width, height, 8, 0, color_space,
        Quartz.kCGImageAlphaPremultipliedLast,
    )
    # Scans assume paper: fill white first, else transparent areas read as black.
    Quartz.CGContextSetRGBFillColor(ctx, 1.0, 1.0, 1.0, 1.0)
    Quartz.CGContextFillRect(ctx, Quartz.CGRectMake(0, 0, width, height))
    Quartz.CGContextScaleCTM(ctx, scale, scale)
    Quartz.CGContextDrawPDFPage(ctx, page)
    return Quartz.CGBitmapContextCreateImage(ctx)


def _ocr_cgimage(cgimage) -> str:
    """Recognize text in a CGImage; lines joined top-to-bottom (reading order)."""
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(
        cgimage, None
    )
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    request.setUsesLanguageCorrection_(True)
    # Serialize with CoreML inference — one ANE, and keeping Vision off the
    # MLModel threadpool avoids contending the same accelerator mid-embed.
    with _INFER_LOCK:
        ok, _ = handler.performRequests_error_([request], None)
    if not ok:
        return ""
    lines = []
    for obs in request.results() or []:
        candidate = obs.topCandidates_(1)
        if candidate and len(candidate):
            lines.append(candidate[0].string())
    return "\n".join(lines)


def ocr_pdf(raw: bytes, dpi: int = OCR_DPI) -> list[str]:
    """Rasterize + OCR every page of a PDF. Returns one text string per page."""
    data = NSData.dataWithBytes_length_(raw, len(raw))
    provider = Quartz.CGDataProviderCreateWithCFData(data)
    doc = Quartz.CGPDFDocumentCreateWithProvider(provider)
    if doc is None:
        raise ValueError("not a valid PDF")
    scale = dpi / 72.0  # PDF user space is 72 dpi
    pages: list[str] = []
    for i in range(1, Quartz.CGPDFDocumentGetNumberOfPages(doc) + 1):
        page = Quartz.CGPDFDocumentGetPage(doc, i)
        pages.append(_ocr_cgimage(_render_pdf_page(page, scale)))
    return pages


@app.get("/health")
def health():
    return {
        "status": "ok",
        "runtime": "coreml",
        "compute": COMPUTE,
        "model": "dinov2_vitb14",
        "dim": DIM,
        "clip": "MobileCLIP2-B",
        "clip_dim": CLIP_DIM,
        "text": "bge-base-en-v1.5",
        "text_dim": TEXT_DIM,
        "model_loaded": "dino" in state,
    }


def _decode(image: str) -> bytes:
    try:
        return base64.b64decode(image)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid base64")


@app.post("/embed", response_model=EmbedResponse, dependencies=[Depends(require_key)])
def embed(req: EmbedRequest):
    try:
        return EmbedResponse(vector=embed_dino(_decode(req.image)))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"could not embed image: {exc}")


@app.post("/clip/image", response_model=EmbedResponse, dependencies=[Depends(require_key)])
def clip_image(req: EmbedRequest):
    try:
        return EmbedResponse(vector=embed_clip_image(_decode(req.image)))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"could not embed image: {exc}")


@app.post("/clip/text", response_model=EmbedResponse, dependencies=[Depends(require_key)])
def clip_text(req: TextRequest):
    return EmbedResponse(vector=embed_clip_text(req.text))


@app.post("/text", response_model=EmbedResponse, dependencies=[Depends(require_key)])
def text(req: TextRequest):
    return EmbedResponse(vector=embed_text(req.text))


class ExtractRequest(BaseModel):
    file_b64: str  # base64-encoded file bytes
    ext: str  # file extension (lowercase, no dot) — "pdf" for now


class ExtractPage(BaseModel):
    text: str


class ExtractResponse(BaseModel):
    pages: list[ExtractPage]
    engine: str  # which OCR path produced the text ("vision")


@app.post("/extract", response_model=ExtractResponse, dependencies=[Depends(require_key)])
def extract(req: ExtractRequest):
    """OCR a document the server couldn't read a text layer from (scanned PDF)."""
    if not _VISION_OK:
        raise HTTPException(
            status_code=503,
            detail="OCR unavailable: pyobjc Vision/Quartz not installed",
        )
    ext = req.ext.lower().lstrip(".")
    if ext != "pdf":
        raise HTTPException(status_code=415, detail=f"cannot OCR type: {ext}")
    raw = _decode(req.file_b64)
    try:
        pages = ocr_pdf(raw)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"could not OCR pdf: {exc}")
    return ExtractResponse(
        pages=[ExtractPage(text=t) for t in pages], engine="vision"
    )
