# WebAssembly DSP Implementation

WebAssembly-based DSP for SF2 synthesizer with Docker build system and CI/CD.

## Implementation

### C Source (`src/dsp.c`)
- Volume Envelope (ADSR with exponential curves)
- Modulation Envelope (Linear ADSR)
- Low Frequency Oscillator (Sine wave)
- Two-Pole Low-Pass Filter (Biquad)
- Utility functions (conversions, attenuation, pan)

### Docker Build
- Fixed Emscripten 3.1.51 for reproducibility
- Optimized with -O3
- Modularized output

### CI/CD
- `.github/workflows/build-wasm.yml` - Auto-builds on DSP changes
- `.github/workflows/deploy.yml` - Builds WASM before deployment

### JavaScript Integration
- `src/dsp-wasm-wrapper.js` - Initialization and module loading
- `src/sf2-processor.js` - AudioWorklet using WASM DSP

## Files

### New
- `src/dsp.c` - C source (662 lines)
- `Dockerfile` - Build container
- `scripts/build-wasm.sh` - Build script
- `src/dsp-wasm-wrapper.js` - Module loader
- `.github/workflows/build-wasm.yml` - CI workflow
- `WASM_README.md` - Documentation
- `test-wasm.html` - Test page
- `public/dsp.js` - WASM glue code (16KB)
- `public/dsp.wasm` - Binary (32KB)

### Modified
- `src/sf2-processor.js` - Uses WASM DSP
- `.github/workflows/deploy.yml` - WASM build step
- `package.json` - build:wasm script
- `README.md` - WASM section

## Build & Test

```bash
# Build WASM
npm run build:wasm

# Development
npm run dev

# Test
# Visit http://localhost:5173/gbk/test-wasm.html
```

## Performance

- Near-native C/WebAssembly speed
- No GC overhead
- Compiler optimizations
- Better CPU usage with many voices

## Security

✅ No vulnerabilities found
- NULL checks on malloc
- Proper headers included
- CodeQL: 0 alerts
