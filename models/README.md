# Bundled model: BGE-small-en-v1.5

| File | Purpose |
| --- | --- |
| `bge-small-en-v1.5/config.json` | BERT architecture config (384 hidden, 12 layers) |
| `bge-small-en-v1.5/tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json` | WordPiece tokenizer |
| `bge-small-en-v1.5/onnx/model_quantized.onnx` | int8 dynamically-quantised ONNX graph (~34 MB) |

Origin: `BAAI/bge-small-en-v1.5` (MIT licence), ONNX export from the `Xenova/bge-small-en-v1.5`
Transformers.js conversion. The int8 file was produced with
`onnxruntime.quantization.quantize_dynamic(weight_type=QUInt8)` from the fp32 export.

Because the files ship inside the extension, **no download happens at runtime** and the
extension works fully offline. To regenerate:

```bash
pip install onnxruntime onnx
python - <<'PY'
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic("model.onnx", "model_quantized.onnx", weight_type=QuantType.QUInt8)
PY
```

`vendor/transformers.min.js` is the unmodified `@xenova/transformers@2.17.2` browser build
(Apache-2.0); `vendor/ort/*.wasm` are the matching onnxruntime-web 1.14 WebAssembly binaries (MIT).
