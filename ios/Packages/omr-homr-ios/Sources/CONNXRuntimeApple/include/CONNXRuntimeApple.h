// CONNXRuntimeApple: exposes the ONNX Runtime C API + CoreML EP factory to Swift on iOS / macOS.
// Headers come from the `onnxruntime.xcframework` binary target of
// microsoft/onnxruntime-swift-package-manager (pod-archive-onnxruntime-c-<ver>.zip), included
// framework-style. Apple platforms only; Linux uses the `CONNXRuntime` system library instead.
#ifndef CONNXRUNTIME_APPLE_H
#define CONNXRUNTIME_APPLE_H

#if __has_include(<onnxruntime/onnxruntime_c_api.h>)
#include <onnxruntime/onnxruntime_c_api.h>
#include <onnxruntime/coreml_provider_factory.h>
#endif

#endif /* CONNXRUNTIME_APPLE_H */
