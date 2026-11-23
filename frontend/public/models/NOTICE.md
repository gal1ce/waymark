# Handwriting models

Used by the boards' "tidy handwriting" (frontend/src/inkclass.ts, inkmodel.ts) to read a written digit or sign.
Both run in the browser with onnxruntime-web; nothing is sent anywhere.

| File | Source | License |
|---|---|---|
| `symbols-cnn.onnx` | [altynbk/handwritten-math-recognition](https://github.com/altynbk/handwritten-math-recognition), `models/cnn_aug.keras`, converted to ONNX by [CalcInk](https://github.com/thenirbanghosh/CalcInk) | MIT, Copyright (c) 2026 Altynbek Kabiyev |
| `digits-mnist.onnx` | [ONNX Model Zoo, MNIST-12](https://github.com/onnx/models/tree/main/validated/vision/classification/mnist), batch dimension made dynamic by CalcInk | MIT |

The rasterising and the way the two models are combined follow CalcInk (MIT, Copyright (c) 2026 Nirban Ghosh).
