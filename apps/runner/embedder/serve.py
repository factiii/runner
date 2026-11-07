"""The Vault's embedder on the runner (.specs/runner-vault.md "Embedder").

The cloud's embedder (services/embedder/app.py) with the vault's two search
models only: bge-base-en-v1.5 (768-d text) and MobileCLIP2-B (512-d CLIP).
Everything that makes a vector is imported from app.py as it is, so a file
embedded here lands in the same space as the cloud's index and the two can be
ranked together. DINOv2 (meme grouping) is not loaded. On a Mac the models
are Core ML; on Linux they are ONNX on the CPU (onnx_backend.py, made by
convert_onnx.py), run through the same app.py functions.

Routes:
- POST /embed  {text} | {clipText} | {clipImage: base64} -> {vector}. The
  same body as the cloud embedder's, so a vector here and one there compare.
- POST /read   {file_b64, ext} -> {pages: [{text, source}]}. A PDF's text
  layer (PDFKit on a Mac, pdfium on Linux), else OCR (Apple Vision by
  app.ocr_pdf on a Mac, RapidOCR on Linux); a docx's paragraphs.
- GET /health

Started by the runner (vault/embedder.ts) on 127.0.0.1 with a key in
VAULT_EMBEDDER_KEY, from the folder that holds the models.
"""

import base64
import hmac
import importlib.util
import io
import os
import re
import sys
import threading
import zipfile
from contextlib import asynccontextmanager
from xml.etree import ElementTree

from fastapi import Depends, FastAPI, Header, HTTPException
from PIL import Image, ImageOps
from pydantic import BaseModel

# Linux has no Core ML: app.py imports with a stand-in and serves ONNX.
ONNX = sys.platform != "darwin"
if ONNX:
    from onnx_backend import OnnxModel, stub_coremltools

    stub_coremltools()

import app as cloud  # noqa: E402
from clip_tokenizer import ClipTokenizer
from text_tokenizer import TextTokenizer

KEY = os.environ.get("VAULT_EMBEDDER_KEY", "")


def require_key(authorization: str | None = Header(default=None)):
    sent = (authorization or "").removeprefix("Bearer ").strip()
    if not KEY or not hmac.compare_digest(sent, KEY):
        raise HTTPException(status_code=401, detail="invalid or missing key")


def _exit_with_runner():
    """The runner holds this process's stdin: when the runner goes, so does
    the embedder, even if the runner was killed and could not stop it."""
    try:
        while sys.stdin.buffer.read(65536):
            pass
    finally:
        os._exit(0)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if os.environ.get("VAULT_EMBEDDER_WATCH_STDIN") == "1":
        threading.Thread(target=_exit_with_runner, daemon=True).start()
    # app.py's own loader and state, so its embed_* functions find the models.
    load = (lambda name: OnnxModel(f"{name}.onnx")) if ONNX else cloud._load
    cloud.state["clip_image"] = load("clip_image")
    cloud.state["clip_text"] = load("clip_text")
    cloud.state["clip_tok"] = ClipTokenizer()
    cloud.state["text"] = load("text")
    cloud.state["text_tok"] = TextTokenizer()
    yield
    cloud.state.clear()


api = FastAPI(lifespan=lifespan)


class EmbedBody(BaseModel):
    text: str | None = None
    clipText: str | None = None
    clipImage: str | None = None


class ReadBody(BaseModel):
    file_b64: str
    ext: str


def _bytes(b64: str) -> bytes:
    try:
        return base64.b64decode(b64)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid base64")


def _upright(raw: bytes) -> bytes:
    """A photo turned the way its EXIF says, as the cloud's sharp().rotate()."""
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(raw)))
    out = io.BytesIO()
    img.convert("RGB").save(out, format="JPEG", quality=90)
    return out.getvalue()


@api.get("/health")
def health():
    return {
        "status": "ok",
        "text": "bge-base-en-v1.5",
        "text_dim": cloud.TEXT_DIM,
        "clip": "MobileCLIP2-B",
        "clip_dim": cloud.CLIP_DIM,
        "runtime": "onnx" if ONNX else "coreml",
        "ocr": _ocr_ok(),
        "loaded": "text" in cloud.state,
    }


@api.post("/embed", dependencies=[Depends(require_key)])
def embed(body: EmbedBody):
    # The server route's order: clipImage, clipText, text.
    try:
        if body.clipImage:
            return {"vector": cloud.embed_clip_image(_upright(_bytes(body.clipImage)))}
        if body.clipText and body.clipText.strip():
            return {"vector": cloud.embed_clip_text(body.clipText)}
        if body.text and body.text.strip():
            return {"vector": cloud.embed_text(body.text)}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"could not embed: {exc}")
    raise HTTPException(status_code=400, detail="text, clipText, or clipImage required")


def _pdf_text_layer(raw: bytes) -> list[str]:
    if ONNX:
        import pypdfium2 as pdfium

        doc = pdfium.PdfDocument(raw)
        # pdfium ends lines with \r\n; PDFKit with \n.
        return [re.sub(r"\r\n?", "\n", page.get_textpage().get_text_bounded()).strip() for page in doc]
    from Foundation import NSData
    from Quartz import PDFDocument

    doc = PDFDocument.alloc().initWithData_(NSData.dataWithBytes_length_(raw, len(raw)))
    if doc is None:
        raise ValueError("not a valid PDF")
    pages = []
    for i in range(doc.pageCount()):
        text = doc.pageAtIndex_(i).string()
        pages.append(str(text).strip() if text else "")
    return pages


_rapid = None


def _ocr_ok() -> bool:
    if not ONNX:
        return cloud._VISION_OK
    return importlib.util.find_spec("rapidocr_onnxruntime") is not None


def _ocr_pdf(raw: bytes) -> list[str]:
    """Every page's text, as app.ocr_pdf: drawn at its 200 DPI, lines top to
    bottom. RapidOCR on Linux, loaded on the first scan only."""
    if not ONNX:
        return cloud.ocr_pdf(raw)
    global _rapid
    import numpy as np
    import pypdfium2 as pdfium

    if _rapid is None:
        from rapidocr_onnxruntime import RapidOCR

        _rapid = RapidOCR()
    pages = []
    for page in pdfium.PdfDocument(raw):
        image = page.render(scale=cloud.OCR_DPI / 72).to_pil()
        with cloud._INFER_LOCK:
            found, _ = _rapid(np.asarray(image.convert("RGB")))
        pages.append("\n".join(line[1] for line in found or []))
    return pages


_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _docx_text(raw: bytes) -> str:
    """Paragraph text, a blank line between paragraphs (mammoth's raw text)."""
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        root = ElementTree.fromstring(z.read("word/document.xml"))
    paragraphs = []
    for p in root.iter(f"{_W}p"):
        parts = []
        for node in p.iter():
            if node.tag == f"{_W}t" and node.text:
                parts.append(node.text)
            elif node.tag == f"{_W}tab":
                parts.append("\t")
            elif node.tag in (f"{_W}br", f"{_W}cr"):
                parts.append("\n")
        paragraphs.append("".join(parts))
    return re.sub(r"\n{3,}", "\n\n", "\n\n".join(paragraphs)).strip()


@api.post("/read", dependencies=[Depends(require_key)])
def read(body: ReadBody):
    ext = body.ext.lower().lstrip(".")
    raw = _bytes(body.file_b64)
    try:
        if ext == "pdf":
            pages = _pdf_text_layer(raw)
            if any(pages):
                return {"pages": [{"text": t, "source": "TEXT_LAYER"} for t in pages]}
            # No text layer: a scan. OCR reads every page, as the cloud does.
            if not _ocr_ok():
                raise HTTPException(status_code=422, detail="PDF has no text layer and OCR is unavailable")
            ocr = [t.strip() for t in _ocr_pdf(raw)]
            if not any(ocr):
                raise HTTPException(status_code=422, detail="PDF has no recoverable text (OCR found nothing)")
            return {"pages": [{"text": t, "source": "OCR"} for t in ocr]}
        if ext == "docx":
            text = _docx_text(raw)
            if not text:
                raise HTTPException(status_code=422, detail="docx contains no text")
            return {"pages": [{"text": text, "source": "TEXT_LAYER"}]}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"could not read {ext}: {exc}")
    raise HTTPException(status_code=415, detail=f"cannot read type: {ext}")
