// SPDX-License-Identifier: AGPL-3.0-or-later
#ifndef SF2_ATOMICS_H
#define SF2_ATOMICS_H
#include <stdint.h>
#include <string.h>

// Plain C11/GCC atomic builtins so Swift can do acquire/release on shared words from the
// real-time audio thread without locks, allocation or runtime calls (iOS 16: no Synchronization).
static inline int64_t sf2_atomic_load_i64(const int64_t *p) { return __atomic_load_n(p, __ATOMIC_ACQUIRE); }
static inline void sf2_atomic_store_i64(int64_t *p, int64_t v) { __atomic_store_n(p, v, __ATOMIC_RELEASE); }
static inline uint64_t sf2_atomic_load_u64(const uint64_t *p) { return __atomic_load_n(p, __ATOMIC_ACQUIRE); }
static inline void sf2_atomic_store_u64(uint64_t *p, uint64_t v) { __atomic_store_n(p, v, __ATOMIC_RELEASE); }

// Level meter shared between the audio thread (sf2_meter_add, once per render callback) and the
// UI thread (sf2_meter_take, ~30 Hz). Lock-free: peaks use a CAS max on the float bit pattern
// (non-negative IEEE floats order like their uint32 bits), sums a CAS add on double bits, and
// take() exchanges every field with 0 so nothing between two UI polls is missed.
typedef struct {
    uint32_t peak[2];
    uint64_t sumSq[2];
    uint64_t frames;
} sf2_meter;

static inline void sf2_meter_max_f32(uint32_t *p, float v) {
    if (!(v > 0.0f)) return;
    uint32_t bits; memcpy(&bits, &v, sizeof bits);
    uint32_t cur = __atomic_load_n(p, __ATOMIC_RELAXED);
    while (bits > cur && !__atomic_compare_exchange_n(p, &cur, bits, 1, __ATOMIC_RELAXED, __ATOMIC_RELAXED)) {}
}

static inline void sf2_meter_add_f64(uint64_t *p, double v) {
    uint64_t cur = __atomic_load_n(p, __ATOMIC_RELAXED), next;
    do {
        double d; memcpy(&d, &cur, sizeof d);
        d += v;
        memcpy(&next, &d, sizeof next);
    } while (!__atomic_compare_exchange_n(p, &cur, next, 1, __ATOMIC_RELAXED, __ATOMIC_RELAXED));
}

static inline void sf2_meter_add(sf2_meter *m, float peakL, float peakR, double sumSqL, double sumSqR, uint64_t frames) {
    sf2_meter_max_f32(&m->peak[0], peakL);
    sf2_meter_max_f32(&m->peak[1], peakR);
    sf2_meter_add_f64(&m->sumSq[0], sumSqL);
    sf2_meter_add_f64(&m->sumSq[1], sumSqR);
    __atomic_fetch_add(&m->frames, frames, __ATOMIC_RELEASE);
}

static inline void sf2_meter_take(sf2_meter *m, float *peakL, float *peakR, double *sumSqL, double *sumSqR, uint64_t *frames) {
    *frames = __atomic_exchange_n(&m->frames, 0, __ATOMIC_ACQUIRE);
    uint64_t sl = __atomic_exchange_n(&m->sumSq[0], 0, __ATOMIC_RELAXED);
    uint64_t sr = __atomic_exchange_n(&m->sumSq[1], 0, __ATOMIC_RELAXED);
    uint32_t pl = __atomic_exchange_n(&m->peak[0], 0, __ATOMIC_RELAXED);
    uint32_t pr = __atomic_exchange_n(&m->peak[1], 0, __ATOMIC_RELAXED);
    memcpy(sumSqL, &sl, sizeof sl); memcpy(sumSqR, &sr, sizeof sr);
    memcpy(peakL, &pl, sizeof pl); memcpy(peakR, &pr, sizeof pr);
}

#endif
