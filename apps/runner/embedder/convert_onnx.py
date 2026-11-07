"""Export the Vault's two search models to ONNX, for the runner on Linux.

The Linux twin of the cloud's convert_text.py / convert_clip.py: the same
torch wrappers (imported from them), the same checkpoints and the same parity
bar (cosine with torch above 0.99, printed as theirs are), so a vector made
on Linux is in the same space as the Mac's and the cloud's. Kept in fp32, so
parity is near 1; fp16 or int8 would move vectors off the cloud's.

    python convert_onnx.py text   # text.onnx + text_tokenizer.json
    python convert_onnx.py clip   # clip_image.onnx + clip_text.onnx + clip_vocab.txt.gz
"""

import os
import shutil
import sys
import types

from onnx_backend import OnnxModel, stub_coremltools

stub_coremltools()

import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402

import convert_clip  # noqa: E402
import convert_text  # noqa: E402

MIN_PARITY = 0.99


def export(wrapper, example: tuple, names: list[str], path: str):
    with torch.no_grad():
        # dynamo=False: the TorchScript tracer, as convert_text.py uses for
        # bge (torch.export trips on BERT's new_ones).
        torch.onnx.export(
            wrapper,
            example,
            path,
            input_names=names,
            output_names=["embedding"],
            opset_version=17,
            dynamo=False,
        )


def parity(path: str, feeds: dict, ref: torch.Tensor, name: str) -> bool:
    vec = torch.tensor(OnnxModel(path).predict(feeds)["embedding"]).flatten().float()
    cos = F.cosine_similarity(vec, ref.flatten().float(), dim=0).item()
    print(f"{name}: cosine(onnx, torch) = {cos:.5f}  (dim={vec.numel()})", flush=True)
    return cos > MIN_PARITY


def text() -> bool:
    from transformers import AutoModel, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(convert_text.MODEL)
    model = AutoModel.from_pretrained(convert_text.MODEL, attn_implementation="eager").float().eval()

    # convert_text.py's padding mask (-1e4), so the graph is the Mac's.
    def _safe_ext_mask(self, attention_mask, input_shape, device=None, dtype=None):
        if dtype is None:
            dtype = self.dtype
        ext = attention_mask[:, None, None, :].to(dtype=dtype)
        return (1.0 - ext) * -1.0e4

    model.get_extended_attention_mask = types.MethodType(_safe_ext_mask, model)
    wrapper = convert_text.TextEncoder(model, convert_text.MAX_LEN).eval()

    def enc(sentence: str):
        e = tok(sentence, padding="max_length", truncation=True, max_length=convert_text.MAX_LEN, return_tensors="pt")
        return e["input_ids"], e["attention_mask"]

    print("exporting text encoder...", flush=True)
    export(wrapper, enc("a short example sentence"), ["input_ids", "attention_mask"], "text.onnx")
    ok = True
    # convert_text.py's sentence, then a longer one with less padding.
    for sentence in ("a short example sentence", "Quarterly report: revenue rose 12% on strong subscription sales. " * 6):
        ids, mask = enc(sentence)
        with torch.no_grad():
            ref = wrapper(ids, mask)
        feeds = {"input_ids": ids.numpy(), "attention_mask": mask.numpy()}
        ok = parity("text.onnx", feeds, ref, "text") and ok
        if ref.numel() != convert_text.DIM:
            ok = False
    if ok:
        tok.backend_tokenizer.save("text_tokenizer.json")
    return ok


def clip() -> bool:
    import open_clip
    from open_clip import tokenizer as _tk

    model, _, _ = open_clip.create_model_and_transforms(convert_clip.MODEL, pretrained=convert_clip.PRETRAINED)
    model.eval()
    tok = open_clip.get_tokenizer(convert_clip.MODEL)
    shutil.copy(_tk.default_bpe(), "clip_vocab.txt.gz")

    torch.manual_seed(0)
    img_ex = torch.randn(1, 3, 224, 224)
    txt_ex = tok(["a photo of a dog"])  # int64 [1, 77]
    with torch.no_grad():
        img_ref = model.encode_image(img_ex)
        txt_ref = model.encode_text(txt_ex)

    print("exporting CLIP image encoder...", flush=True)
    export(convert_clip.ImageEncoder(model).eval(), (img_ex,), ["image"], "clip_image.onnx")
    ok_i = parity("clip_image.onnx", {"image": img_ex.numpy()}, img_ref, "image")
    print("exporting CLIP text encoder...", flush=True)
    export(convert_clip.TextEncoder(model).eval(), (txt_ex,), ["tokens"], "clip_text.onnx")
    ok_t = parity("clip_text.onnx", {"tokens": txt_ex.numpy()}, txt_ref, "text")
    return ok_i and ok_t


def main() -> int:
    which = sys.argv[1] if len(sys.argv) > 1 else ""
    if which not in ("text", "clip"):
        print("usage: convert_onnx.py text|clip")
        return 2
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    if not (text() if which == "text" else clip()):
        print("PARITY FAILED")
        return 1
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
