// dsp-wasm-wrapper.js
// Wrapper for WebAssembly DSP module

let dspModule = null;
let dspReady = false;

// Initialize the WebAssembly module
export async function initDSP() {
    if (dspReady) return dspModule;
    
    try {
        // Determine the base path dynamically
        // In dev mode: '/', in production (GitHub Pages): '/gbk/'
        const basePath = import.meta.env?.BASE_URL || '/';
        const dspPath = `${basePath}dsp.js`;
        
        console.log(`Loading WASM module from: ${dspPath}`);
        
        // Import the generated module
        const DSPModule = await import(/* @vite-ignore */ dspPath);
        dspModule = await DSPModule.default();
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

// Wrapper classes that use WebAssembly when available, fallback to JS

export class VolEnvWasm {
    constructor(sr, jsImplementation = null) {
        this.sr = sr;
        this.jsImpl = jsImplementation;
        this.ptr = null;
        
        if (dspReady && dspModule) {
            try {
                this.ptr = dspModule._volEnvCreate(sr);
            } catch (e) {
                console.warn('Failed to create WASM VolEnv, using JS fallback:', e);
            }
        }
    }
    
    setFromSf2(params) {
        if (this.ptr && dspModule) {
            const delayTc = params.delayTc ?? -12000;
            const attackTc = params.attackTc ?? -12000;
            const holdTc = params.holdTc ?? -12000;
            const decayTc = params.decayTc ?? -12000;
            const sustainCb = params.sustainCb ?? 0;
            const releaseTc = params.releaseTc ?? 0;
            
            dspModule._volEnvSetFromSf2(this.ptr, delayTc, attackTc, holdTc, decayTc, sustainCb, releaseTc);
        } else if (this.jsImpl) {
            this.jsImpl.setFromSf2(params);
        }
    }
    
    noteOn() {
        if (this.ptr && dspModule) {
            dspModule._volEnvNoteOn(this.ptr);
        } else if (this.jsImpl) {
            this.jsImpl.noteOn();
        }
    }
    
    noteOff() {
        if (this.ptr && dspModule) {
            dspModule._volEnvNoteOff(this.ptr);
        } else if (this.jsImpl) {
            this.jsImpl.noteOff();
        }
    }
    
    next() {
        if (this.ptr && dspModule) {
            return dspModule._volEnvNext(this.ptr);
        } else if (this.jsImpl) {
            return this.jsImpl.next();
        }
        return 0;
    }
    
    get level() {
        if (this.jsImpl) return this.jsImpl.level;
        return 0;
    }
    
    get stage() {
        if (this.jsImpl) return this.jsImpl.stage;
        return 'idle';
    }
    
    destroy() {
        if (this.ptr && dspModule) {
            dspModule._volEnvDestroy(this.ptr);
            this.ptr = null;
        }
    }
}

export class ModEnvWasm {
    constructor(sr, jsImplementation = null) {
        this.sr = sr;
        this.jsImpl = jsImplementation;
        this.ptr = null;
        
        if (dspReady && dspModule) {
            try {
                this.ptr = dspModule._modEnvCreate(sr);
            } catch (e) {
                console.warn('Failed to create WASM ModEnv, using JS fallback:', e);
            }
        }
    }
    
    setFromSf2(params) {
        if (this.ptr && dspModule) {
            const delayTc = params.delayTc ?? -12000;
            const attackTc = params.attackTc ?? -12000;
            const holdTc = params.holdTc ?? -12000;
            const decayTc = params.decayTc ?? -12000;
            const sustain = params.sustain ?? 0;
            const releaseTc = params.releaseTc ?? 0;
            
            dspModule._modEnvSetFromSf2(this.ptr, delayTc, attackTc, holdTc, decayTc, sustain, releaseTc);
        } else if (this.jsImpl) {
            this.jsImpl.setFromSf2(params);
        }
    }
    
    noteOn() {
        if (this.ptr && dspModule) {
            dspModule._modEnvNoteOn(this.ptr);
        } else if (this.jsImpl) {
            this.jsImpl.noteOn();
        }
    }
    
    noteOff() {
        if (this.ptr && dspModule) {
            dspModule._modEnvNoteOff(this.ptr);
        } else if (this.jsImpl) {
            this.jsImpl.noteOff();
        }
    }
    
    next() {
        if (this.ptr && dspModule) {
            return dspModule._modEnvNext(this.ptr);
        } else if (this.jsImpl) {
            return this.jsImpl.next();
        }
        return 0;
    }
    
    get level() {
        if (this.jsImpl) return this.jsImpl.level;
        return 0;
    }
    
    get stage() {
        if (this.jsImpl) return this.jsImpl.stage;
        return 'idle';
    }
    
    destroy() {
        if (this.ptr && dspModule) {
            dspModule._modEnvDestroy(this.ptr);
            this.ptr = null;
        }
    }
}

export class LFOWasm {
    constructor(sr, jsImplementation = null) {
        this.sr = sr;
        this.jsImpl = jsImplementation;
        this.ptr = null;
        
        if (dspReady && dspModule) {
            try {
                this.ptr = dspModule._lfoCreate(sr);
            } catch (e) {
                console.warn('Failed to create WASM LFO, using JS fallback:', e);
            }
        }
    }
    
    set(freqHz, delaySec) {
        if (this.ptr && dspModule) {
            dspModule._lfoSet(this.ptr, freqHz ?? 0, delaySec ?? 0);
        } else if (this.jsImpl) {
            this.jsImpl.set(freqHz, delaySec);
        }
    }
    
    next() {
        if (this.ptr && dspModule) {
            return dspModule._lfoNext(this.ptr);
        } else if (this.jsImpl) {
            return this.jsImpl.next();
        }
        return 0;
    }
    
    destroy() {
        if (this.ptr && dspModule) {
            dspModule._lfoDestroy(this.ptr);
            this.ptr = null;
        }
    }
}

export class TwoPoleLPFWasm {
    constructor(sr, jsImplementation = null) {
        this.sr = sr;
        this.jsImpl = jsImplementation;
        this.ptr = null;
        
        if (dspReady && dspModule) {
            try {
                this.ptr = dspModule._lpfCreate(sr);
            } catch (e) {
                console.warn('Failed to create WASM LPF, using JS fallback:', e);
            }
        }
    }
    
    setCutoffHz(hz) {
        if (this.ptr && dspModule) {
            dspModule._lpfSetCutoffHz(this.ptr, hz ?? 1000);
        } else if (this.jsImpl) {
            this.jsImpl.setCutoffHz(hz);
        }
    }
    
    processL(x) {
        if (this.ptr && dspModule) {
            return dspModule._lpfProcessL(this.ptr, x);
        } else if (this.jsImpl) {
            return this.jsImpl.processL(x);
        }
        return x;
    }
    
    processR(x) {
        if (this.ptr && dspModule) {
            return dspModule._lpfProcessR(this.ptr, x);
        } else if (this.jsImpl) {
            return this.jsImpl.processR(x);
        }
        return x;
    }
    
    destroy() {
        if (this.ptr && dspModule) {
            dspModule._lpfDestroy(this.ptr);
            this.ptr = null;
        }
    }
}

// Utility functions with WASM support
export function centsToRatio(c) {
    if (dspReady && dspModule) {
        return dspModule._centsToRatio(c ?? 0);
    }
    return Math.pow(2, (c ?? 0) / 1200);
}

export function cbAttenToLin(cb) {
    if (dspReady && dspModule) {
        return dspModule._cbAttenToLin(cb ?? 0);
    }
    const db = -(cb ?? 0) / 10;
    return Math.pow(10, db / 20);
}

export function velToLin(vel, curve = 2.0) {
    if (dspReady && dspModule) {
        return dspModule._velToLin(vel, curve);
    }
    const x = Math.max(0, Math.min(127, vel)) / 127;
    return Math.pow(x, curve);
}

export function fcCentsToHz(fcCents) {
    if (dspReady && dspModule) {
        return dspModule._fcCentsToHz(fcCents ?? 13500);
    }
    return 8.176 * Math.pow(2, (fcCents ?? 13500) / 1200);
}

export function timecentsToSeconds(tc) {
    if (dspReady && dspModule) {
        return dspModule._timecentsToSeconds(tc ?? 0);
    }
    return Math.pow(2, (tc ?? 0) / 1200);
}
