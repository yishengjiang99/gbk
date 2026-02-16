# Dockerfile for building WebAssembly modules with Emscripten
# Using a fixed version for reproducible builds

FROM emscripten/emsdk:3.1.51

# Set working directory
WORKDIR /src

# Copy source files
COPY src/dsp.c .

# Compile C to WebAssembly
# -O3: Optimize for performance
# -s WASM=1: Output WebAssembly
# -s EXPORTED_FUNCTIONS: List of functions to export (all EMSCRIPTEN_KEEPALIVE functions)
# -s EXPORTED_RUNTIME_METHODS: Runtime methods to expose
# -s ALLOW_MEMORY_GROWTH=1: Allow memory to grow
# -s MODULARIZE=1: Create a module instead of global
# -s EXPORT_NAME: Name of the module
RUN emcc dsp.c -O3 \
    -s WASM=1 \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","getValue","setValue"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="'DSPModule'" \
    -s ENVIRONMENT=web \
    -o dsp.js

# Create output directory
RUN mkdir -p /output

# Copy output files
RUN cp dsp.js dsp.wasm /output/

# Default command to display files
CMD ["sh", "-c", "ls -la /output/"]
