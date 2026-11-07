"""Torch-free WordPiece tokenizer for the text-embedding model (bge-base-en-v1.5).
Loads the model's `text_tokenizer.json` via the Rust `tokenizers` lib (no torch,
no transformers) so the running service stays lean — same idea as the CLIP
tokenizer (clip_tokenizer.py), but BERT WordPiece instead of CLIP BPE.

Returns fixed-length int32 `input_ids` + `attention_mask` (padded/truncated to
MAX_LEN) matching the Core ML model's input shapes. The json is written by
convert_text.py from the HF tokenizer.
"""

import os

import numpy as np
from tokenizers import Tokenizer

TOKENIZER_JSON = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "text_tokenizer.json"
)
# Must match MAX_LEN in convert_text.py (the Core ML model's fixed sequence len).
MAX_LEN = 256


class TextTokenizer:
    def __init__(self, path: str = TOKENIZER_JSON, max_len: int = MAX_LEN):
        self.tok = Tokenizer.from_file(path)
        self.tok.enable_truncation(max_length=max_len)
        self.tok.enable_padding(length=max_len)
        self.max_len = max_len

    def __call__(self, text: str) -> tuple[np.ndarray, np.ndarray]:
        enc = self.tok.encode(text)
        ids = np.asarray(enc.ids, dtype=np.int32)[None]  # [1, max_len]
        mask = np.asarray(enc.attention_mask, dtype=np.int32)[None]  # [1, max_len]
        return ids, mask
