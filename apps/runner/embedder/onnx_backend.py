"""The Vault's embedder on Linux: ONNX Runtime on the CPU in place of Core ML.

The cloud's app.py (preprocessing, tokenizers, pooling) and its converters
(the torch wrappers) are used as they are. They import Core ML at the top,
which does not exist on Linux, so a stand-in is put in its place first; on
Linux nothing ever calls it.
"""

import sys
import types

import numpy as np


def stub_coremltools():
    """Lets app.py, convert_text.py and convert_clip.py import on Linux."""
    ct = types.ModuleType("coremltools")
    ct.ComputeUnit = types.SimpleNamespace(CPU_AND_NE=None, CPU_AND_GPU=None, CPU_ONLY=None, ALL=None)
    models = types.ModuleType("coremltools.models")
    models.CompiledMLModel = None
    utils = types.ModuleType("coremltools.models.utils")
    utils.compile_model = None
    models.utils = utils
    ct.models = models
    sys.modules.update({"coremltools": ct, "coremltools.models": models, "coremltools.models.utils": utils})


class OnnxModel:
    """A Core ML model's predict(): named arrays in, {"embedding"} out, so
    app.py's embed_* functions run on it unchanged."""

    def __init__(self, path: str):
        import onnxruntime as ort

        options = ort.SessionOptions()
        # No arena: it keeps the largest activations' memory after a call,
        # and an idle embedder should hold little more than its weights.
        options.enable_cpu_mem_arena = False
        self.session = ort.InferenceSession(path, options, providers=["CPUExecutionProvider"])
        # app.py's tokenizers hand int32 (Core ML's inputs); the export takes
        # torch's int64.
        self.inputs = {
            i.name: np.int64 if i.type == "tensor(int64)" else np.float32 for i in self.session.get_inputs()
        }

    def predict(self, feeds: dict) -> dict:
        args = {name: np.asarray(feeds[name]).astype(dtype, copy=False) for name, dtype in self.inputs.items()}
        return {"embedding": self.session.run(["embedding"], args)[0]}
