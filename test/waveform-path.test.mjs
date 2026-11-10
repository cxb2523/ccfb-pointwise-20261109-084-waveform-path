import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    GRANULARITY,
    getStatsEntry,
    rangeMinMax,
    mixToMono,
    getBuckets,
    linearPath,
    polarPath,
} from '../src/waveform-core.mjs';
import * as legacy from './legacy-waveform-path.mjs';

// ---------------------------------------------------------------------------
// Deterministic test doubles
// ---------------------------------------------------------------------------

class MockAudioBuffer {
    constructor(channelData, sampleRate = 44100) {
        this._channels = channelData.map((data) => Float32Array.from(data));
        this.numberOfChannels = this._channels.length;
        this.length = this._channels[0].length;
        this.sampleRate = sampleRate;
    }
    getChannelData(channel) {
        return this._channels[channel];
    }
}

// Deterministic PRNG so every "fixed buffer" is reproducible across runs.
const mulberry32 = (seed) => {
    let state = seed;
    return () => {
        state |= 0;
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const randomSignal = (length, seed, { silentRun = 0 } = {}) => {
    const rand = mulberry32(seed);
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        data[i] = rand() * 2 - 1;
    }
    if (silentRun > 0) {
        const silentStart = Math.floor(length / 2);
        for (let i = silentStart; i < Math.min(length, silentStart + silentRun); i++) {
            data[i] = 0;
        }
    }
    return data;
};

// Dyadic magnitudes: representable exactly in both Float32 and Float64, so a
// block filled with one magnitude has mean === min === max at the bit level.
const DYADIC = [0, 0.0625, 0.125, 0.25, 0.375, 0.5, 0.75, 1];

const legacyFrameRanges = (length, animation, animationframes, sampleRate) => {
    if (!animation) {
        return [{ start: 0, end: length }];
    }
    const frameSize = sampleRate / animationframes;
    const ranges = [];
    for (let index = 0; index < length; index += frameSize) {
        const start = Math.trunc(index);
        if (start >= length) break;
        ranges.push({ start, end: Math.min(length, Math.trunc(index + frameSize)) });
    }
    return ranges;
};

// Builds a signal that is constant (in magnitude) inside every block of every
// animation frame for the given `samples` partition. On such a signal the
// legacy block average equals the new block min/max exactly, which is what
// makes byte-identical d strings possible across the refactor.
const makeBlockConstantBuffer = (length, samples, {
    animation = false,
    animationframes = 10,
    sampleRate = 44100,
    seed = 1,
} = {}) => {
    const rand = mulberry32(seed);
    const data = new Float32Array(length);
    const ranges = legacyFrameRanges(length, animation, animationframes, sampleRate);
    for (const { start, end } of ranges) {
        const blockSize = Math.floor((end - start) / samples);
        for (let i = 0; i < samples; i++) {
            const magnitude = DYADIC[Math.floor(rand() * DYADIC.length)];
            const sign = rand() > 0.5 ? 1 : -1;
            const value = sign * magnitude;
            const blockStart = start + blockSize * i;
            for (let j = blockStart; j < blockStart + blockSize; j++) {
                data[j] = value;
            }
        }
        // The legacy partition ignores the trailing remainder; fill it with a
        // constant too so neither implementation can read uninitialized data.
        const remainder = DYADIC[Math.floor(rand() * DYADIC.length)];
        for (let j = start + blockSize * samples; j < end; j++) {
            data[j] = remainder;
        }
    }
    return new MockAudioBuffer([data], sampleRate);
};

const bruteRangeMinMax = (mono, start, end) => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = start; i < end; i++) {
        const value = Math.abs(mono[i]);
        if (value < min) min = value;
        if (value > max) max = value;
    }
    if (min === Infinity) {
        min = 0;
        max = 0;
    }
    return { min, max };
};

// Independent re-implementation of the legacy block partition, paired with
// brute-force min/max, used as the reference for the new bucket layer.
const bruteBuckets = (mono, frameRanges, samples) => {
    return frameRanges.map(({ start, end }) => {
        const blockSize = Math.floor((end - start) / samples);
        const min = new Float32Array(samples);
        const max = new Float32Array(samples);
        for (let i = 0; i < samples; i++) {
            const bucketStart = start + blockSize * i;
            const stats = bruteRangeMinMax(mono, bucketStart, bucketStart + blockSize);
            min[i] = stats.min;
            max[i] = stats.max;
        }
        return { min, max };
    });
};

const countCommands = (pathString) => pathString.split(/\s*[MLHCQVAZ]\s*/).length - 1;

const EQUIV_BUFFER_LENGTH = GRANULARITY * 3 + 1777;

// ---------------------------------------------------------------------------
// Layer 1: granule statistics
// ---------------------------------------------------------------------------

test('granule layer: fixed 4096 granularity, tail granule uses real sample count', () => {
    const tail = 137;
    const length = GRANULARITY * 3 + tail;
    const buffer = new MockAudioBuffer([randomSignal(length, 1)]);
    const entry = getStatsEntry(buffer);

    assert.equal(entry.granMin.length, 4);
    assert.equal(entry.granMax.length, 4);

    for (let g = 0; g < 4; g++) {
        const start = g * GRANULARITY;
        const end = Math.min(length, start + GRANULARITY);
        const expected = bruteRangeMinMax(entry.mono, start, end);
        assert.equal(entry.granMin[g], expected.min, `granule ${g} min`);
        assert.equal(entry.granMax[g], expected.max, `granule ${g} max`);
    }

    // The tail granule must not have been zero-padded: its max is nonzero for
    // this signal and was computed over exactly `tail` samples.
    assert.notEqual(entry.granMax[3], 0);
});

test('granule layer: rangeMinMax matches brute force on cut and aligned ranges', () => {
    const length = GRANULARITY * 4 + 2501;
    const buffer = new MockAudioBuffer([randomSignal(length, 2, { silentRun: GRANULARITY })]);
    const entry = getStatsEntry(buffer);

    const ranges = [
        [0, GRANULARITY],                       // exactly one granule
        [GRANULARITY, GRANULARITY * 2],         // aligned full granule
        [0, GRANULARITY * 3],                   // several full granules
        [17, GRANULARITY + 331],                // cuts both edge granules
        [GRANULARITY - 5, GRANULARITY + 5],     // tiny range over a boundary
        [GRANULARITY * 2 + 1000, GRANULARITY * 2 + 1001], // single sample
        [GRANULARITY * 4, length],              // partial tail granule
        [GRANULARITY * 4 + 10, length - 3],     // inside the tail only
        [123, length - 7],                      // spans everything, both edges cut
    ];

    for (const [start, end] of ranges) {
        assert.deepEqual(
            rangeMinMax(entry, start, end),
            bruteRangeMinMax(entry.mono, start, end),
            `range [${start}, ${end})`
        );
    }
});

test('granule layer: all-zero silence yields min=max=0 and never NaN/Infinity', () => {
    const length = GRANULARITY + 500;
    const buffer = new MockAudioBuffer([new Float32Array(length)]);
    const entry = getStatsEntry(buffer);

    for (let g = 0; g < entry.granMin.length; g++) {
        assert.equal(entry.granMin[g], 0);
        assert.equal(entry.granMax[g], 0);
    }
    assert.deepEqual(rangeMinMax(entry, 0, length), { min: 0, max: 0 });
    assert.deepEqual(rangeMinMax(entry, 17, length - 50), { min: 0, max: 0 });
    // Out-of-range ends are clamped instead of stalling on the tail granule.
    assert.deepEqual(rangeMinMax(entry, 17, length * 3), { min: 0, max: 0 });
    assert.deepEqual(rangeMinMax(entry, length, length + 10), { min: 0, max: 0 });
});

test('granule layer: multichannel buffers are mixed to mono before aggregation', () => {
    const length = GRANULARITY + 888;
    const left = randomSignal(length, 3);
    const right = randomSignal(length, 4);
    const buffer = new MockAudioBuffer([left, right]);

    const mono = mixToMono(buffer);
    // The mix is stored in a Float32Array, so compare against the Float32
    // rounding of the Float64 average rather than the raw Float64 value.
    const expectedMono = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        expectedMono[i] = (left[i] + right[i]) / 2;
    }
    assert.deepEqual(Array.from(mono), Array.from(expectedMono));

    const entry = getStatsEntry(buffer);
    for (let g = 0; g < entry.granMin.length; g++) {
        const start = g * GRANULARITY;
        const end = Math.min(length, start + GRANULARITY);
        const expected = bruteRangeMinMax(mono, start, end);
        assert.equal(entry.granMin[g], expected.min);
        assert.equal(entry.granMax[g], expected.max);
    }
});

test('granule layer: entry is shared by linear and polar and never rebuilt', () => {
    const buffer = new MockAudioBuffer([randomSignal(GRANULARITY * 2 + 11, 5)]);
    const first = getStatsEntry(buffer);
    linearPath(buffer, { samples: 50 });
    polarPath(buffer, { samples: 40 });
    linearPath(buffer, { samples: 77 });
    const again = getStatsEntry(buffer);

    assert.equal(again, first);
    assert.equal(again.granMin, first.granMin);
    assert.equal(again.granMax, first.granMax);
});

// ---------------------------------------------------------------------------
// Layer 2: bucket assembly over granules
// ---------------------------------------------------------------------------

test('bucket layer: non-dividing samples cut granules without rescanning PCM', () => {
    const length = GRANULARITY * 3 + 2027;
    const buffer = new MockAudioBuffer([randomSignal(length, 6)]);
    const entry = getStatsEntry(buffer);

    for (const samples of [1, 7, 50, 75, 100, 513, 1000, 4097]) {
        const frames = getBuckets(entry, buffer, {
            samples,
            animation: false,
            animationframes: 10,
        });
        const expected = bruteBuckets(entry.mono, [{ start: 0, end: length }], samples);
        assert.equal(frames.length, 1);
        assert.equal(frames[0].min.length, samples);
        for (let i = 0; i < samples; i++) {
            assert.equal(frames[0].min[i], expected[0].min[i], `samples=${samples} bucket ${i} min`);
            assert.equal(frames[0].max[i], expected[0].max[i], `samples=${samples} bucket ${i} max`);
        }
    }
});

test('bucket layer: silence stays min=max=0 at every sample count', () => {
    const length = GRANULARITY * 2 + 600;
    const buffer = new MockAudioBuffer([new Float32Array(length)]);
    const entry = getStatsEntry(buffer);

    for (const samples of [1, 100, 4096, 5000]) {
        const [frame] = getBuckets(entry, buffer, { samples, animation: false, animationframes: 10 });
        for (let i = 0; i < samples; i++) {
            assert.equal(frame.min[i], 0);
            assert.equal(frame.max[i], 0);
        }
    }
});

test('bucket layer: animation frames use the same float-step slicing as legacy', () => {
    const sampleRate = 1000;
    const length = 2500;
    const buffer = new MockAudioBuffer([randomSignal(length, 7)], sampleRate);
    const entry = getStatsEntry(buffer);

    for (const animationframes of [10, 24, 7]) {
        const frames = getBuckets(entry, buffer, {
            samples: 33,
            animation: true,
            animationframes,
        });
        const ranges = legacyFrameRanges(length, true, animationframes, sampleRate);
        assert.equal(frames.length, ranges.length);
        const expected = bruteBuckets(entry.mono, ranges, 33);
        for (let f = 0; f < frames.length; f++) {
            for (let i = 0; i < 33; i++) {
                assert.equal(frames[f].min[i], expected[f].min[i], `frame ${f} bucket ${i} min`);
                assert.equal(frames[f].max[i], expected[f].max[i], `frame ${f} bucket ${i} max`);
            }
        }
    }
});

test('bucket layer: samples larger than length yields zero buckets instead of NaN', () => {
    const buffer = new MockAudioBuffer([randomSignal(50, 8)]);
    const entry = getStatsEntry(buffer);
    const [frame] = getBuckets(entry, buffer, { samples: 100, animation: false, animationframes: 10 });
    assert.equal(frame.min.length, 100);
    for (let i = 0; i < 100; i++) {
        assert.equal(frame.min[i], 0);
        assert.equal(frame.max[i], 0);
    }
});

// ---------------------------------------------------------------------------
// Pointwise path equivalence against the verbatim legacy implementation.
// Each buffer is block-constant for the option's `samples`, so every legacy
// block average equals the new block min/max and the rendered d strings must
// be byte-identical.
// ---------------------------------------------------------------------------

const linearOptionSets = [
    { samples: 100, type: 'steps', top: 20 },
    { samples: 75, type: 'steps', top: 20, normalize: false },
    { samples: 513, type: 'steps', width: 640, left: 12, top: 5 },
    {
        samples: 100, type: 'steps', top: 20,
        paths: [
            { d: 'L', sx: 0, sy: 0, ex: 50, ey: 100 },
            { d: 'L', sx: 50, sy: 100, ex: 100, ey: 0 },
        ],
    },
    {
        samples: 100, type: 'mirror', top: 20,
        paths: [{ d: 'V', sy: 0, x: 50, ey: 100 }],
    },
    {
        samples: 100, type: 'bars', top: 20,
        paths: [{ d: 'V', sy: 0, x: 50, ey: 100 }],
    },
    {
        samples: 137, type: 'mirror', top: 20,
        paths: [{ d: 'Q', sx: 20, sy: 0, x: 50, y: 100, ex: 80, ey: 0 }],
    },
    {
        samples: 64, type: 'steps', top: 10,
        paths: [{ d: 'H', sx: 10, y: 90, ex: 90 }],
    },
    {
        samples: 88, type: 'steps', top: 10,
        paths: [{ d: 'C', sx: 0, sy: 0, x: 100, y: 100, ex: 100, ey: 0 }],
    },
    {
        samples: 50, type: 'steps', top: 20,
        paths: [
            { d: 'V', sy: 0, x: 0, ey: 100 },
            { d: 'A', sx: 0, sy: 100, ex: 100, ey: 100, rx: 10, ry: 10, angle: 180, arc: 1, sweep: 1 },
        ],
    },
    {
        samples: 200, type: 'steps', normalize: false,
        paths: [{ d: 'Z' }],
    },
    {
        samples: 90, type: 'steps', top: 20,
        paths: [{ d: 'L', sx: 0, sy: 20, ex: 100, ey: -1.5, normalize: true, minshow: 0, maxshow: 1 }],
    },
    { samples: 100, type: 'steps', top: 20, animation: true },
    { samples: 100, type: 'bars', top: 20, animation: true, paths: [{ d: 'V', sy: 0, x: 50, ey: 100 }] },
];

test('linearPath: byte-identical d strings vs legacy on block-constant buffers', () => {
    linearOptionSets.forEach((options, index) => {
        const buffer = makeBlockConstantBuffer(EQUIV_BUFFER_LENGTH, options.samples, {
            animation: options.animation ?? false,
            seed: 100 + index,
        });
        assert.equal(
            linearPath(buffer, options),
            legacy.linearPath(buffer, options),
            `linear options ${JSON.stringify(options)}`
        );
    });
});

const polarOptionSets = [
    { samples: 90, type: 'steps', left: 200, top: 200, distance: 100, length: 50 },
    {
        samples: 90, type: 'bars', left: 200, top: 200, distance: 75, length: 75,
        paths: [{ d: 'L', sdeg: 50, sr: 0, edeg: 50, er: 100 }],
    },
    { samples: 90, type: 'mirror', left: 200, top: 200, distance: 100, length: 100 },
    {
        samples: 77, type: 'steps', left: 200, top: 200, distance: 100, length: 100,
        startdeg: 270, enddeg: 90, invertdeg: true, invertpath: true,
    },
    {
        samples: 128, type: 'steps', left: 100, top: 100, distance: 50, length: 80,
        paths: [
            { d: 'L', sdeg: 0, sr: 0, edeg: 0, er: 90 },
            { d: 'A', sdeg: 0, sr: 90, edeg: 100, er: 90, rx: 5, ry: 5, angle: 100, arc: 1, sweep: 1 },
            { d: 'L', sdeg: 100, sr: 90, edeg: 100, er: 0 },
        ],
    },
    {
        samples: 90, type: 'steps', left: 200, top: 200, distance: 100, length: 100,
        paths: [{ d: 'Q', sdeg: 0, sr: 0, deg: 50, r: 100, edeg: 100, er: 0 }],
    },
    {
        samples: 90, type: 'steps', left: 200, top: 200, distance: 100, length: 100,
        paths: [{ d: 'C', sdeg: 0, sr: 0, deg: 50, r: 100, edeg: 100, er: 0 }],
    },
    { samples: 90, type: 'steps', left: 200, top: 200, distance: 100, length: 100, animation: true },
];

test('polarPath: byte-identical d strings vs legacy on block-constant buffers', () => {
    polarOptionSets.forEach((options, index) => {
        const buffer = makeBlockConstantBuffer(EQUIV_BUFFER_LENGTH, options.samples, {
            animation: options.animation ?? false,
            seed: 200 + index,
        });
        assert.equal(
            polarPath(buffer, options),
            legacy.polarPath(buffer, options),
            `polar options ${JSON.stringify(options)}`
        );
    });
});

test('silence: renders finite, cache-stable output and matches legacy where defined', () => {
    // Legacy normalization of pure silence is undefined: every NaN value either
    // fails the minshow filter (empty frame, or just frame separators in
    // animation mode) or leaks NaN into coordinates.
    const legacyIsBrokenSilence = (output) => output
        .split(';')
        .every((frame) => frame.trim() === '' || frame.trim() === 'M 0 0' || frame.includes('NaN'));

    const silentBuffer = new MockAudioBuffer([new Float32Array(GRANULARITY + 909)]);
    for (const rawOptions of linearOptionSets) {
        const options = { ...rawOptions };
        const next = linearPath(silentBuffer, options);
        assert.ok(!next.includes('NaN'), `silent linear has NaN: ${JSON.stringify(options)}`);
        // Second render must hit the cache and return the same string.
        assert.equal(linearPath(silentBuffer, { ...options }), next);

        if (options.normalize === false) {
            // Legacy normalization is skipped, so outputs must match exactly.
            assert.equal(next, legacy.linearPath(silentBuffer, options), `silent linear ${JSON.stringify(options)}`);
        } else {
            assert.ok(legacyIsBrokenSilence(legacy.linearPath(silentBuffer, options)));
            assert.equal(next, linearPath(silentBuffer, { ...options, normalize: false }));
        }
    }
    for (const rawOptions of polarOptionSets) {
        const options = { ...rawOptions };
        const next = polarPath(silentBuffer, options);
        assert.ok(!next.includes('NaN'), `silent polar has NaN: ${JSON.stringify(options)}`);
        assert.equal(polarPath(silentBuffer, { ...options }), next);

        if (options.normalize === false) {
            assert.equal(next, legacy.polarPath(silentBuffer, options), `silent polar ${JSON.stringify(options)}`);
        } else {
            assert.ok(legacyIsBrokenSilence(legacy.polarPath(silentBuffer, options)));
            assert.equal(next, polarPath(silentBuffer, { ...options, normalize: false }));
        }
    }
});

test('random data: new path keeps the legacy command skeleton with min/max values', () => {
    const buffer = new MockAudioBuffer([randomSignal(GRANULARITY * 2 + 3003, 99)]);
    const options = {
        samples: 120, type: 'steps', top: 20,
        paths: [
            { d: 'L', sx: 0, sy: 0, ex: 50, ey: 100 },
            { d: 'Q', sx: 20, sy: 0, x: 50, y: 100, ex: 80, ey: 0 },
        ],
    };
    const next = linearPath(buffer, options);
    const old = legacy.linearPath(buffer, options);

    // M (pen moves) follow coordinate-based dedup and may differ with min/max
    // values; the draw-command skeleton and draw counts must stay identical.
    const countMoves = (d) => (d.match(/M/g) || []).length;
    const skeleton = (d) => d.match(/[LHCQVAZ]/g);
    assert.deepEqual(skeleton(next), skeleton(old));
    assert.equal(countCommands(next) - countMoves(next), countCommands(old) - countMoves(old));
});

// ---------------------------------------------------------------------------
// Caching: two layers with independent eviction
// ---------------------------------------------------------------------------

test('path cache: repeated identical calls return the cached string', () => {
    const buffer = new MockAudioBuffer([randomSignal(GRANULARITY + 50, 10)]);
    const options = { samples: 100, type: 'steps', top: 20 };
    const first = linearPath(buffer, options);
    const second = linearPath(buffer, { ...options });
    const entry = getStatsEntry(buffer);

    assert.equal(second, first);
    assert.equal(entry.pathCache.size, 1);
});

test('path cache: LRU bounded eviction leaves the statistics layer intact', () => {
    const buffer = new MockAudioBuffer([randomSignal(GRANULARITY * 2 + 5, 11)]);
    const entry = getStatsEntry(buffer);
    const granMinBefore = entry.granMin;

    for (let width = 0; width < 40; width++) {
        linearPath(buffer, { samples: 100, width: 100 + width, type: 'steps' });
    }
    assert.ok(entry.pathCache.size <= 32, `path cache size ${entry.pathCache.size}`);

    // Statistics layer is untouched no matter how hard the path LRU churns.
    assert.equal(entry.granMin, granMinBefore);
    assert.equal(getStatsEntry(buffer), entry);

    // Re-requesting an evicted key renders again correctly, not from stale data.
    const rerendered = linearPath(buffer, { samples: 100, width: 100, type: 'steps' });
    assert.equal(rerendered, linearPath(buffer, { samples: 100, width: 100, type: 'steps' }));
});

test('path cache: mode switch only adds path keys, statistics stay shared', () => {
    const buffer = new MockAudioBuffer([randomSignal(GRANULARITY * 2 + 77, 12)]);
    const entry = getStatsEntry(buffer);
    const granuleSnapshot = entry.granMax.slice();

    linearPath(buffer, { samples: 100 });
    const pathKeysAfterLinear = [...entry.pathCache.keys()];
    assert.ok(pathKeysAfterLinear.every((key) => key.startsWith('linear|')));

    polarPath(buffer, { samples: 100, left: 200, top: 200 });
    const pathKeysAfterPolar = [...entry.pathCache.keys()];
    assert.ok(pathKeysAfterPolar.some((key) => key.startsWith('polar|')));
    assert.ok(pathKeysAfterPolar.some((key) => key.startsWith('linear|')));

    assert.deepEqual(Array.from(entry.granMax), Array.from(granuleSnapshot));
});

test('bucket cache: bounded independently of the path cache and granule layer', () => {
    const buffer = new MockAudioBuffer([randomSignal(GRANULARITY * 4, 13)]);
    const entry = getStatsEntry(buffer);

    for (let samples = 10; samples < 30; samples++) {
        linearPath(buffer, { samples, width: 800 });
    }
    assert.ok(entry.bucketCache.size <= 8, `bucket cache size ${entry.bucketCache.size}`);
    assert.equal(entry.granMin.length, Math.ceil(buffer.length / GRANULARITY));

    // A re-request after bucket eviction rebuilds from granules, not raw PCM.
    const before = linearPath(buffer, { samples: 11, width: 800 });
    const again = linearPath(buffer, { samples: 11, width: 800 });
    assert.equal(again, before);
});

test('cache keying: separate buffers get separate statistics entries', () => {
    const bufferA = new MockAudioBuffer([randomSignal(GRANULARITY + 10, 14)]);
    const bufferB = new MockAudioBuffer([randomSignal(GRANULARITY + 10, 15)]);
    assert.notEqual(getStatsEntry(bufferA), getStatsEntry(bufferB));
    assert.equal(getStatsEntry(bufferA), getStatsEntry(bufferA));
});

test('caller path-command objects are not mutated by rendering', () => {
    const buffer = makeBlockConstantBuffer(GRANULARITY + 30, 100, { seed: 16 });
    const commands = [{ d: 'V', sy: 0, x: 50, ey: 100 }];
    const snapshot = JSON.parse(JSON.stringify(commands));
    linearPath(buffer, { samples: 100, type: 'bars', paths: commands });
    assert.deepEqual(commands, snapshot);
});

// ---------------------------------------------------------------------------
// Node count: output size tracks `samples`, not PCM length
// ---------------------------------------------------------------------------

test('rendered node count scales with samples, not buffer length', () => {
    const shortBuffer = new MockAudioBuffer([randomSignal(GRANULARITY * 2, 21)]);
    const longBuffer = new MockAudioBuffer([randomSignal(GRANULARITY * 8, 22)]);
    const options = (samples) => ({
        samples,
        type: 'steps',
        paths: [{ d: 'L', sx: 0, sy: 0, ex: 50, ey: 100 }],
    });

    const shortPath = linearPath(shortBuffer, options(100));
    const longPath = linearPath(longBuffer, options(100));
    assert.equal(countCommands(longPath), countCommands(shortPath));

    const doubled = linearPath(longBuffer, options(200));
    assert.equal(countCommands(doubled), countCommands(longPath) * 2);
});
