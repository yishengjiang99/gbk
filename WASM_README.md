# WebAssembly DSP Module

WebAssembly DSP module for SF2 synthesizer performance optimization.

## Components

- **Envelopes**: Volume and Modulation (ADSR)
- **Filters**: Two-pole low-pass filter
- **LFOs**: Low-frequency oscillators
- **Utilities**: Conversion functions

## Building

### Using Docker (Recommended)

```bash
npm run build:wasm
```

Or manually:

```bash
docker build -t gbk-wasm-builder .
docker run --rm -v "$(pwd)/public:/host-output" gbk-wasm-builder sh -c "cp /output/dsp.js /output/dsp.wasm /host-output/"
```

### Using Local Emscripten (v3.1.51)

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

- `public/dsp.js` - JavaScript glue code
- `public/dsp.wasm` - WebAssembly binary

## CI/CD

GitHub Actions automatically builds WASM on changes to:
- `src/dsp.c`
- `Dockerfile`
- `.github/workflows/build-wasm.yml`

## Usage

```javascript
import { initDSP } from './dsp-wasm-wrapper.js';

await initDSP();
// WASM module is now available globally
```

The module is loaded once and shared across the application.

## Performance Benefits

- Near-native execution speed
- No garbage collection overhead
- Optimized compilation (-O3)
- Efficient multi-voice rendering

## Development

- **Source**: `src/dsp.c`
- **Wrapper**: `src/dsp-wasm-wrapper.js`
- **Processor**: `src/sf2-processor.js`

## Version

Emscripten 3.1.51 (pinned for reproducible builds)
