#include <math.h>
#include <emscripten.h>

// Constants
#define MIN_VOL_RELEASE_SEC 0.06
#define MIN_MOD_RELEASE_SEC 0.02
#define EPS 1e-5

// Utility functions
EMSCRIPTEN_KEEPALIVE
double timecentsToSeconds(double tc) {
    return pow(2.0, tc / 1200.0);
}

EMSCRIPTEN_KEEPALIVE
double centsToRatio(double c) {
    return pow(2.0, c / 1200.0);
}

EMSCRIPTEN_KEEPALIVE
double cbAttenToLin(double cb) {
    double db = -cb / 10.0;
    return pow(10.0, db / 20.0);
}

EMSCRIPTEN_KEEPALIVE
double velToLin(double vel, double curve) {
    double x = fmax(0.0, fmin(127.0, vel)) / 127.0;
    return pow(x, curve);
}

EMSCRIPTEN_KEEPALIVE
void panToGains(double pan, double* gL, double* gR) {
    double p = fmax(-500.0, fmin(500.0, pan)) / 500.0; // -1..+1
    double angle = (p + 1.0) * 0.25 * M_PI; // 0..pi/2
    *gL = cos(angle);
    *gR = sin(angle);
}

EMSCRIPTEN_KEEPALIVE
void balanceToGains(double balance, double* gL, double* gR) {
    double p = fmax(-1.0, fmin(1.0, balance));
    double angle = (p + 1.0) * 0.25 * M_PI;
    *gL = cos(angle);
    *gR = sin(angle);
}

EMSCRIPTEN_KEEPALIVE
double fcCentsToHz(double fcCents) {
    return 8.176 * pow(2.0, fcCents / 1200.0);
}

EMSCRIPTEN_KEEPALIVE
double lerp(double a, double b, double t) {
    return a + (b - a) * t;
}

// Volume Envelope structure and functions
typedef struct {
    double sr;
    int stage; // 0=idle, 1=delay, 2=attack, 3=hold, 4=decay, 5=sustain, 6=release
    double level;
    double t;
    double peak;
    
    double delay;
    double attack;
    double hold;
    double decay;
    double sustain;
    double release;
    
    double releaseStart;
} VolEnv;

EMSCRIPTEN_KEEPALIVE
VolEnv* volEnvCreate(double sr) {
    VolEnv* env = (VolEnv*)malloc(sizeof(VolEnv));
    env->sr = sr;
    env->stage = 0; // idle
    env->level = 0.0;
    env->t = 0.0;
    env->peak = 1.0;
    
    env->delay = 0.0;
    env->attack = 0.01;
    env->hold = 0.0;
    env->decay = 0.1;
    env->sustain = 0.5;
    env->release = 0.2;
    
    env->releaseStart = 0.0;
    return env;
}

EMSCRIPTEN_KEEPALIVE
void volEnvDestroy(VolEnv* env) {
    free(env);
}

EMSCRIPTEN_KEEPALIVE
void volEnvSetFromSf2(VolEnv* env, double delayTc, double attackTc, double holdTc, 
                      double decayTc, double sustainCb, double releaseTc) {
    env->delay = fmax(0.0, timecentsToSeconds(delayTc));
    env->attack = fmax(0.0, timecentsToSeconds(attackTc));
    env->hold = fmax(0.0, timecentsToSeconds(holdTc));
    env->decay = fmax(0.0, timecentsToSeconds(decayTc));
    double rel = timecentsToSeconds(releaseTc);
    env->release = fmax(MIN_VOL_RELEASE_SEC, rel);
    
    double sustainDb = -sustainCb / 10.0;
    env->sustain = fmin(1.0, fmax(0.0, pow(10.0, sustainDb / 20.0)));
}

EMSCRIPTEN_KEEPALIVE
void volEnvNoteOn(VolEnv* env) {
    env->stage = (env->delay > 0) ? 1 : 2; // delay or attack
    env->t = 0.0;
    env->level = 0.0;
}

EMSCRIPTEN_KEEPALIVE
void volEnvNoteOff(VolEnv* env) {
    if (env->stage == 0) return; // idle
    env->stage = 6; // release
    env->t = 0.0;
    env->releaseStart = env->level;
}

EMSCRIPTEN_KEEPALIVE
double volEnvNext(VolEnv* env) {
    double dt = 1.0 / env->sr;
    
    switch (env->stage) {
        case 0: // idle
            env->level = 0.0;
            return 0.0;
            
        case 1: // delay
            env->t += dt;
            if (env->t >= env->delay) {
                env->stage = 2; // attack
                env->t = 0.0;
            }
            env->level = 0.0;
            return 0.0;
            
        case 2: { // attack
            if (env->attack <= 0.0) {
                env->level = env->peak;
                env->stage = (env->hold > 0) ? 3 : 4; // hold or decay
                env->t = 0.0;
                return env->level;
            }
            env->t += dt;
            double x = fmin(1.0, env->t / env->attack);
            double shaped = 1.0 - exp(-x * 6.0);
            env->level = env->peak * shaped;
            
            if (x >= 1.0) {
                env->level = env->peak;
                env->stage = (env->hold > 0) ? 3 : 4; // hold or decay
                env->t = 0.0;
            }
            return env->level;
        }
        
        case 3: // hold
            env->t += dt;
            env->level = env->peak;
            if (env->t >= env->hold) {
                env->stage = 4; // decay
                env->t = 0.0;
            }
            return env->level;
            
        case 4: { // decay
            if (env->decay <= 0.0) {
                env->level = env->sustain;
                env->stage = 5; // sustain
                env->t = 0.0;
                return env->level;
            }
            env->t += dt;
            double x = fmin(1.0, env->t / env->decay);
            
            double start = fmax(EPS, env->peak);
            double end = fmax(EPS, env->sustain);
            double y = exp(log(start) + (log(end) - log(start)) * x);
            env->level = y;
            
            if (x >= 1.0) {
                env->level = env->sustain;
                env->stage = 5; // sustain
                env->t = 0.0;
            }
            return env->level;
        }
        
        case 5: // sustain
            env->level = env->sustain;
            return env->level;
            
        case 6: { // release
            if (env->release <= 0.0) {
                env->level = 0.0;
                env->stage = 0; // idle
                return 0.0;
            }
            env->t += dt;
            double x = fmin(1.0, env->t / env->release);
            double start = fmax(EPS, env->releaseStart);
            double end = EPS;
            double y = exp(log(start) + (log(end) - log(start)) * x);
            env->level = y;
            
            if (x >= 1.0) {
                env->level = 0.0;
                env->stage = 0; // idle
            }
            return env->level;
        }
    }
    return 0.0;
}

// Mod Envelope
typedef struct {
    double sr;
    int stage;
    double level;
    double t;
    
    double delay;
    double attack;
    double hold;
    double decay;
    double sustain;
    double release;
    
    double releaseStart;
} ModEnv;

EMSCRIPTEN_KEEPALIVE
ModEnv* modEnvCreate(double sr) {
    ModEnv* env = (ModEnv*)malloc(sizeof(ModEnv));
    env->sr = sr;
    env->stage = 0; // idle
    env->level = 0.0;
    env->t = 0.0;
    
    env->delay = 0.0;
    env->attack = 0.01;
    env->hold = 0.0;
    env->decay = 0.1;
    env->sustain = 0.0;
    env->release = 0.2;
    
    env->releaseStart = 0.0;
    return env;
}

EMSCRIPTEN_KEEPALIVE
void modEnvDestroy(ModEnv* env) {
    free(env);
}

EMSCRIPTEN_KEEPALIVE
void modEnvSetFromSf2(ModEnv* env, double delayTc, double attackTc, double holdTc,
                      double decayTc, double sustain, double releaseTc) {
    env->delay = fmax(0.0, timecentsToSeconds(delayTc));
    env->attack = fmax(0.0, timecentsToSeconds(attackTc));
    env->hold = fmax(0.0, timecentsToSeconds(holdTc));
    env->decay = fmax(0.0, timecentsToSeconds(decayTc));
    double rel = timecentsToSeconds(releaseTc);
    env->release = fmax(MIN_MOD_RELEASE_SEC, rel);
    env->sustain = fmin(1.0, fmax(0.0, sustain));
}

EMSCRIPTEN_KEEPALIVE
void modEnvNoteOn(ModEnv* env) {
    env->stage = (env->delay > 0) ? 1 : 2;
    env->t = 0.0;
    env->level = 0.0;
}

EMSCRIPTEN_KEEPALIVE
void modEnvNoteOff(ModEnv* env) {
    if (env->stage == 0) return;
    env->stage = 6;
    env->t = 0.0;
    env->releaseStart = env->level;
}

EMSCRIPTEN_KEEPALIVE
double modEnvNext(ModEnv* env) {
    double dt = 1.0 / env->sr;
    
    switch (env->stage) {
        case 0: // idle
            env->level = 0.0;
            return 0.0;
            
        case 1: // delay
            env->t += dt;
            if (env->t >= env->delay) {
                env->stage = 2;
                env->t = 0.0;
            }
            env->level = 0.0;
            return 0.0;
            
        case 2: { // attack
            if (env->attack <= 0.0) {
                env->level = 1.0;
                env->stage = (env->hold > 0) ? 3 : 4;
                env->t = 0.0;
                return env->level;
            }
            env->t += dt;
            double x = fmin(1.0, env->t / env->attack);
            env->level = x;
            if (x >= 1.0) {
                env->level = 1.0;
                env->stage = (env->hold > 0) ? 3 : 4;
                env->t = 0.0;
            }
            return env->level;
        }
        
        case 3: // hold
            env->t += dt;
            env->level = 1.0;
            if (env->t >= env->hold) {
                env->stage = 4;
                env->t = 0.0;
            }
            return env->level;
            
        case 4: { // decay
            if (env->decay <= 0.0) {
                env->level = env->sustain;
                env->stage = 5;
                env->t = 0.0;
                return env->level;
            }
            env->t += dt;
            double x = fmin(1.0, env->t / env->decay);
            env->level = lerp(1.0, env->sustain, x);
            if (x >= 1.0) {
                env->level = env->sustain;
                env->stage = 5;
                env->t = 0.0;
            }
            return env->level;
        }
        
        case 5: // sustain
            env->level = env->sustain;
            return env->level;
            
        case 6: { // release
            if (env->release <= 0.0) {
                env->level = 0.0;
                env->stage = 0;
                return 0.0;
            }
            env->t += dt;
            double x = fmin(1.0, env->t / env->release);
            env->level = lerp(env->releaseStart, 0.0, x);
            if (x >= 1.0) {
                env->level = 0.0;
                env->stage = 0;
            }
            return env->level;
        }
    }
    return 0.0;
}

// LFO
typedef struct {
    double sr;
    double phase;
    double freqHz;
    double delayLeft;
} LFO;

EMSCRIPTEN_KEEPALIVE
LFO* lfoCreate(double sr) {
    LFO* lfo = (LFO*)malloc(sizeof(LFO));
    lfo->sr = sr;
    lfo->phase = 0.0;
    lfo->freqHz = 5.0;
    lfo->delayLeft = 0.0;
    return lfo;
}

EMSCRIPTEN_KEEPALIVE
void lfoDestroy(LFO* lfo) {
    free(lfo);
}

EMSCRIPTEN_KEEPALIVE
void lfoSet(LFO* lfo, double freqHz, double delaySec) {
    lfo->freqHz = fmax(0.0, freqHz);
    lfo->delayLeft = fmax(0.0, delaySec);
}

EMSCRIPTEN_KEEPALIVE
double lfoNext(LFO* lfo) {
    if (lfo->delayLeft > 0.0) {
        lfo->delayLeft -= 1.0 / lfo->sr;
        return 0.0;
    }
    lfo->phase += 2.0 * M_PI * lfo->freqHz / lfo->sr;
    if (lfo->phase > 2.0 * M_PI) {
        lfo->phase -= 2.0 * M_PI;
    }
    return sin(lfo->phase);
}

// Two-Pole Low-Pass Filter (Biquad)
typedef struct {
    double sr;
    // State variables for left channel
    double z1L;
    double z2L;
    // State variables for right channel
    double z1R;
    double z2R;
    // Biquad coefficients
    double b0;
    double b1;
    double b2;
    double a1;
    double a2;
} TwoPoleLPF;

EMSCRIPTEN_KEEPALIVE
TwoPoleLPF* lpfCreate(double sr) {
    TwoPoleLPF* lpf = (TwoPoleLPF*)malloc(sizeof(TwoPoleLPF));
    lpf->sr = sr;
    lpf->z1L = 0.0;
    lpf->z2L = 0.0;
    lpf->z1R = 0.0;
    lpf->z2R = 0.0;
    lpf->b0 = 1.0;
    lpf->b1 = 0.0;
    lpf->b2 = 0.0;
    lpf->a1 = 0.0;
    lpf->a2 = 0.0;
    return lpf;
}

EMSCRIPTEN_KEEPALIVE
void lpfDestroy(TwoPoleLPF* lpf) {
    free(lpf);
}

EMSCRIPTEN_KEEPALIVE
void lpfSetCutoffHz(TwoPoleLPF* lpf, double hz) {
    double clamped = fmax(5.0, fmin(hz, lpf->sr * 0.45));
    double Q = 0.7071; // Butterworth response
    
    double w0 = 2.0 * M_PI * clamped / lpf->sr;
    double cosw0 = cos(w0);
    double sinw0 = sin(w0);
    double alpha = sinw0 / (2.0 * Q);
    
    double a0 = 1.0 + alpha;
    lpf->b0 = ((1.0 - cosw0) / 2.0) / a0;
    lpf->b1 = (1.0 - cosw0) / a0;
    lpf->b2 = ((1.0 - cosw0) / 2.0) / a0;
    lpf->a1 = (-2.0 * cosw0) / a0;
    lpf->a2 = (1.0 - alpha) / a0;
}

EMSCRIPTEN_KEEPALIVE
double lpfProcessL(TwoPoleLPF* lpf, double x) {
    double y = lpf->b0 * x + lpf->z1L;
    lpf->z1L = lpf->b1 * x - lpf->a1 * y + lpf->z2L;
    lpf->z2L = lpf->b2 * x - lpf->a2 * y;
    return y;
}

EMSCRIPTEN_KEEPALIVE
double lpfProcessR(TwoPoleLPF* lpf, double x) {
    double y = lpf->b0 * x + lpf->z1R;
    lpf->z1R = lpf->b1 * x - lpf->a1 * y + lpf->z2R;
    lpf->z2R = lpf->b2 * x - lpf->a2 * y;
    return y;
}

// Sample reading with linear interpolation
EMSCRIPTEN_KEEPALIVE
double readSampleMono(const float* data, int dataLen, double pos) {
    int i = (int)pos;
    if (i >= dataLen - 1) return 0.0;
    double f = pos - i;
    double a = (i >= 0 && i < dataLen) ? data[i] : 0.0;
    double b = (i + 1 >= 0 && i + 1 < dataLen) ? data[i + 1] : 0.0;
    return a + (b - a) * f;
}
