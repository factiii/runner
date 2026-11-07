"""Convert CLIP (open_clip MobileCLIP2-B) image + text encoders to Core ML (fp16)
so the search path runs torch-free on the ANE, like DINOv2. Verifies parity vs
torch and precompiles/warms the .mlmodelc. MobileCLIP2-B is a drop-in for ViT-B-32
(same 512-d / 224px / BPE) but stronger; swapping it means re-embedding media.

    ./.venv/bin/python convert_clip.py
"""

import os
import shutil
import sys

import numpy as np
import torch
import torch.nn.functional as F

import coremltools as ct
import open_clip
from coremltools.models import CompiledMLModel
from coremltools.models.utils import compile_model

MODEL, PRETRAINED = "MobileCLIP2-B", "dfndr2b"
CTX = 77


class ImageEncoder(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        return self.m.encode_image(x)


class TextEncoder(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, t):
        return self.m.encode_text(t)


def to_coreml(wrapper, example, name, input_spec):
    exported = torch.export.export(wrapper, (example,)).run_decompositions({})
    mlmodel = ct.convert(
        exported,
        inputs=[input_spec],
        outputs=[ct.TensorType(name="embedding")],
        compute_units=ct.ComputeUnit.ALL,
        compute_precision=ct.precision.FLOAT16,
        minimum_deployment_target=ct.target.macOS14,
    )
    pkg = f"{name}.mlpackage"
    mlmodel.save(pkg)
    return mlmodel, pkg


def parity(mlmodel, input_np, ref, name):
    out = mlmodel.predict(
        {mlmodel.get_spec().description.input[0].name: input_np}
    )
    vec = torch.tensor(out["embedding"]).flatten().float()
    cos = F.cosine_similarity(vec, ref.flatten().float(), dim=0).item()
    print(f"{name}: cosine(coreml, torch) = {cos:.5f}")
    return cos


def warm(pkg, name):
    compiled = f"{name}.mlmodelc"
    if os.path.exists(compiled):
        shutil.rmtree(compiled)
    compile_model(pkg, compiled)
    CompiledMLModel(compiled, compute_units=ct.ComputeUnit.CPU_AND_NE)


def main() -> int:
    model, _, _ = open_clip.create_model_and_transforms(MODEL, pretrained=PRETRAINED)
    model.eval()
    tok = open_clip.get_tokenizer(MODEL)

    # Bundle the BPE vocab for the torch-free runtime tokenizer (clip_tokenizer.py).
    from open_clip import tokenizer as _tk

    shutil.copy(_tk.default_bpe(), "clip_vocab.txt.gz")

    img_ex = torch.randn(1, 3, 224, 224)
    txt_ex = tok(["a photo of a dog"])  # int64 [1, 77]

    with torch.no_grad():
        img_ref = model.encode_image(img_ex)
        txt_ref = model.encode_text(txt_ex)

    print("converting CLIP image encoder...")
    img_ml, img_pkg = to_coreml(
        ImageEncoder(model), img_ex, "clip_image",
        ct.TensorType(name="image", shape=(1, 3, 224, 224)),
    )
    ok_i = parity(img_ml, img_ex.numpy(), img_ref, "image") > 0.99

    print("converting CLIP text encoder...")
    txt_ml, txt_pkg = to_coreml(
        TextEncoder(model), txt_ex, "clip_text",
        ct.TensorType(name="tokens", shape=(1, CTX), dtype=np.int32),
    )
    ok_t = parity(txt_ml, txt_ex.numpy().astype(np.int32), txt_ref, "text") > 0.99

    if not (ok_i and ok_t):
        print("PARITY FAILED")
        return 1
    print("warming ANE caches...")
    warm(img_pkg, "clip_image")
    warm(txt_pkg, "clip_text")
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
