# WebAssembly DSP Module

This directory contains the WebAssembly DSP computation module for the SF2 synthesizer.

## Overview

The DSP computation has been extracted to C code and compiled to WebAssembly for improved performance. The module includes:

- **Envelopes**: Volume and Modulation envelopes (ADSR)
- **Filters**: Two-pole low-pass filter (biquad implementation)
- **LFOs**: Low-frequency oscillators for modulation
- **Utilities**: Conversion functions (cents to ratio, attenuation to linear, etc.)

## Building the WebAssembly Module

### Prerequisites

- Docker (for reproducible builds with fixed Emscripten version)

### Build Instructions

#### Using Docker (Recommended)

```bash
# Build the Docker image
docker build -t gbk-wasm-builder .

# Compile C to WebAssembly
docker run --rm -v "$(pwd)/public:/host-output" gbk-wasm-builder sh -c "cp /output/dsp.js /output/dsp.wasm /host-output/"
```

Or use the convenience script:

```bash
npm run build:wasm
```

#### Using Local Emscripten

If you have Emscripten installed locally (version 3.1.51):

```bash
emcc src/dsp.c -O3 \
    -s WASM=1 \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","getValue","setValue"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="'DSPModule'" \
    -s ENVIRONMENT=web \
    -o public/dsp.js
```

## Output Files

The build process generates two files in the `public/` directory:

- `dsp.js` - JavaScript glue code for loading and interfacing with the WebAssembly module
- `dsp.wasm` - The compiled WebAssembly binary

## CI/CD Integration

The GitHub Actions workflow `.github/workflows/build-wasm.yml` automatically builds the WebAssembly module when changes are detected to:

- `src/dsp.c`
- `Dockerfile`
- The workflow file itself

The deploy workflow (`.github/workflows/deploy.yml`) includes a step to build the WebAssembly module before building the main application.

## Usage in Code

The WebAssembly module is used through the wrapper in `src/dsp-wasm-wrapper.js`, which provides:

1. **Automatic initialization**: `initDSP()` to load the WASM module
2. **Fallback support**: Falls back to JavaScript implementation if WASM fails to load
3. **Wrapper classes**: `VolEnvWasm`, `ModEnvWasm`, `LFOWasm`, `TwoPoleLPFWasm`
4. **Utility functions**: `centsToRatio()`, `cbAttenToLin()`, etc.

Example:

```javascript
import { initDSP, VolEnvWasm } from './dsp-wasm-wrapper.js';

// Initialize WASM module
await initDSP();

// Create envelope with WASM backend
const env = new VolEnvWasm(sampleRate);
env.setFromSf2({ attackTc: -1000, decayTc: -2000, sustainCb: 0, releaseTc: -3000 });
env.noteOn();

// Process samples
const sample = env.next();
```

## Performance

WebAssembly provides significant performance improvements for DSP operations:

- Faster envelope computation (no garbage collection overhead)
- More efficient filter processing
- Reduced CPU usage during audio rendering
- Better performance with many simultaneous voices

## Development

### Source Files

- `src/dsp.c` - C source code for DSP algorithms
- `src/dsp-wasm-wrapper.js` - JavaScript wrapper with fallback support
- `src/sf2-processor.js` - AudioWorklet processor (keeps JS implementation as reference)

### Testing

The JavaScript implementation in `sf2-processor.js` serves as both:
1. A fallback when WASM is not available
2. The reference implementation for testing WASM output

### Debugging

To debug the WebAssembly module:

1. Build with debug symbols: Add `-g` flag to emcc
2. Use browser DevTools to inspect WASM
3. Compare output with JavaScript implementation

## Version Pinning

The Dockerfile uses Emscripten version **3.1.51** for reproducible builds. This ensures consistent compilation results across different environments and over time.

To update the Emscripten version, modify the `FROM` line in the Dockerfile:

```dockerfile
FROM emscripten/emsdk:X.Y.Z
```

## License

Same as the parent project.
