"""Convert a text-embedding model (bge-base-en-v1.5, 768-d) to Core ML (fp16) so
the text↔text semantic search path runs torch-free on the ANE, like CLIP/DINOv2.

bge-base-en-v1.5 is a BERT encoder + CLS pooling — stronger discrimination than
gte-small (less anisotropic, better retrieval). We use it symmetrically (no query
prefix); the pooling + L2 normalize are baked into the graph, so the runtime just
feeds tokens (text_tokenizer.py) and reads a ready-to-compare unit vector.

Verifies parity vs torch and precompiles/warms text.mlmodelc. Also writes
text_tokenizer.json for the torch-free runtime tokenizer.

    ./.venv/bin/python convert_text.py
"""

import os
import shutil
import sys
import types

import numpy as np
import torch
import torch.nn.functional as F

import coremltools as ct
from coremltools.models import CompiledMLModel
from coremltools.models.utils import compile_model
from transformers import AutoModel, AutoTokenizer

# transformers pinned < 4.48 (see setup.sh): newer BERT attention emits ops the
# Core ML TorchScript frontend can't convert.

MODEL = "BAAI/bge-base-en-v1.5"
DIM = 768
# Fixed sequence length — must match MAX_LEN in text_tokenizer.py. Core ML runs a
# fixed shape (like CLIP's 77); 256 covers bios/descriptions and post snippets.
MAX_LEN = 256


class TextEncoder(torch.nn.Module):
    """BERT encoder + CLS pooling + L2 normalize.

    position_ids and token_type_ids are passed as fixed-length constant buffers so
    BERT's embeddings never compute them dynamically (those size()/expand paths are
    what emit the un-convertible aten::Int / new_ones ops). Combined with eager
    attention (no SDPA mask-prep), the graph stays Core ML convertible.

    BGE pools the [CLS] token (position 0), not the mean — using mean here would
    silently produce wrong embeddings.
    """

    def __init__(self, m, max_len):
        super().__init__()
        self.m = m
        self.register_buffer("position_ids", torch.arange(max_len).unsqueeze(0))
        self.register_buffer(
            "token_type_ids", torch.zeros((1, max_len), dtype=torch.long)
        )

    def forward(self, input_ids, attention_mask):
        hidden = self.m(
            input_ids=input_ids,
            attention_mask=attention_mask,
            token_type_ids=self.token_type_ids,
            position_ids=self.position_ids,
        )[0]
        return F.normalize(hidden[:, 0], p=2, dim=1)  # [CLS] pooling


def main() -> int:
    tok = AutoTokenizer.from_pretrained(MODEL)
    # Eager attention avoids SDPA ops the converter rejects; .float() forces fp32 weights
    # (the fp16 checkpoint trips a layer_norm dtype check at the frontend).
    model = AutoModel.from_pretrained(MODEL, attn_implementation="eager").float().eval()

    # Mask padding with -1e4, not fp32-min: the latter overflows to -inf under fp16 and
    # 0*-inf = nan poisons every token. softmax still drives masked positions to ~0.
    def _safe_ext_mask(self, attention_mask, input_shape, device=None, dtype=None):
        if dtype is None:
            dtype = self.dtype
        ext = attention_mask[:, None, None, :].to(dtype=dtype)
        return (1.0 - ext) * -1.0e4

    model.get_extended_attention_mask = types.MethodType(_safe_ext_mask, model)
    wrapper = TextEncoder(model, MAX_LEN).eval()

    enc = tok(
        "a short example sentence",
        padding="max_length",
        truncation=True,
        max_length=MAX_LEN,
        return_tensors="pt",
    )
    # Keep int64 for export (casting to int32 here makes jit.trace emit an aten::Int
    # coremltools can't lower); Core ML inputs are declared int32 below.
    ids_ex = enc["input_ids"]
    mask_ex = enc["attention_mask"]

    with torch.no_grad():
        ref = wrapper(ids_ex, mask_ex)

    print("tracing + converting text encoder...")
    # jit.trace (TorchScript frontend) tolerates new_ones, which the export frontend rejects.
    traced = torch.jit.trace(wrapper, (ids_ex, mask_ex))
    mlmodel = ct.convert(
        traced,
        inputs=[
            ct.TensorType(name="input_ids", shape=(1, MAX_LEN), dtype=np.int32),
            ct.TensorType(name="attention_mask", shape=(1, MAX_LEN), dtype=np.int32),
        ],
        outputs=[ct.TensorType(name="embedding")],
        compute_units=ct.ComputeUnit.ALL,
        # fp16 except layer_norm (its fp32 epsilon trips a dtype check); matmuls stay fp16.
        compute_precision=ct.transform.FP16ComputePrecision(
            op_selector=lambda op: op.op_type != "layer_norm"
        ),
        minimum_deployment_target=ct.target.macOS14,
    )
    pkg = "text.mlpackage"
    mlmodel.save(pkg)

    out = mlmodel.predict(
        {
            "input_ids": ids_ex.numpy().astype(np.int32),
            "attention_mask": mask_ex.numpy().astype(np.int32),
        }
    )
    vec = torch.tensor(out["embedding"]).flatten().float()
    cos = F.cosine_similarity(vec, ref.flatten().float(), dim=0).item()
    print(f"text: cosine(coreml, torch) = {cos:.5f}  (dim={vec.numel()})")
    if cos <= 0.99 or vec.numel() != DIM:
        print("PARITY FAILED")
        return 1

    # Bundle the WordPiece vocab/config for the torch-free runtime tokenizer.
    tok.backend_tokenizer.save("text_tokenizer.json")

    print("warming ANE caches...")
    compiled = "text.mlmodelc"
    if os.path.exists(compiled):
        shutil.rmtree(compiled)
    compile_model(pkg, compiled)
    CompiledMLModel(compiled, compute_units=ct.ComputeUnit.CPU_AND_NE)
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
