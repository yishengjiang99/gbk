#!/bin/bash
set -e

echo "Building WebAssembly DSP module..."

# Check if Docker is available
if ! command -v docker &> /dev/null; then
    echo "Error: Docker is not installed or not in PATH"
    exit 1
fi

# Build Docker image
echo "Building Docker image..."
docker build -t gbk-wasm-builder .

# Run container and copy output files
echo "Compiling C to WebAssembly..."
docker run --rm -v "$(pwd)/public:/host-output" gbk-wasm-builder sh -c "cp /output/dsp.js /output/dsp.wasm /host-output/"

echo "WebAssembly module built successfully!"
echo "Output files: public/dsp.js, public/dsp.wasm"
