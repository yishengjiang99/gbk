// dsp-wasm-wrapper.js
// Wrapper for WebAssembly DSP module

let dspModule = null;
let dspReady = false;

// Initialize the WebAssembly module
export async function initDSP() {
    if (dspReady) return dspModule;
    
    try {
        // Public assets in Vite cannot be imported from source directly.
        // Load /dsp.js at runtime and import via blob URL instead.
        const basePath = import.meta.env?.BASE_URL || '/';
        const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`;
        const assetRoot = new URL(normalizedBase, window.location.origin);
        const dspUrl = new URL('dsp.js', assetRoot).href;

        console.log(`Loading WASM module from: ${dspUrl}`);

        const dspSource = await fetch(dspUrl).then((res) => {
            if (!res.ok) {
                throw new Error(`Failed to fetch DSP loader (${res.status})`);
            }
            return res.text();
        });

        let dspFactory = null;
        const blobUrl = URL.createObjectURL(new Blob([dspSource], { type: 'text/javascript' }));
        try {
            const dspNs = await import(/* @vite-ignore */ blobUrl);
            if (typeof dspNs?.default === 'function') {
                dspFactory = dspNs.default;
            }
        } finally {
            URL.revokeObjectURL(blobUrl);
        }

        // Emscripten non-ESM output has no export; wrap it and export DSPModule.
        if (typeof dspFactory !== 'function') {
            const wrappedSource = `${dspSource}\nexport default (typeof DSPModule !== 'undefined' ? DSPModule : null);`;
            const wrappedBlobUrl = URL.createObjectURL(new Blob([wrappedSource], { type: 'text/javascript' }));
            try {
                const wrappedNs = await import(/* @vite-ignore */ wrappedBlobUrl);
                if (typeof wrappedNs?.default === 'function') {
                    dspFactory = wrappedNs.default;
                }
            } finally {
                URL.revokeObjectURL(wrappedBlobUrl);
            }
        }

        if (typeof dspFactory !== 'function') {
            throw new Error('DSP module loader did not expose a callable factory');
        }

        dspModule = await dspFactory({
            locateFile: (path) => new URL(path, assetRoot).href,
        });
        dspReady = true;
        console.log('WebAssembly DSP module initialized');
        return dspModule;
    } catch (error) {
        console.error('Failed to initialize WebAssembly DSP module:', error);
        throw error;
    }
}

// Check if DSP module is ready
export function isDSPReady() {
    return dspReady;
}

// Get the DSP module instance
export function getDSPModule() {
    if (!dspReady) {
        throw new Error('DSP module not initialized. Call initDSP() first.');
    }
    return dspModule;
}


