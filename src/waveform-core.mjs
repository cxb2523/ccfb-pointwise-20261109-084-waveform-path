// Two-layer waveform engine.
//
// Layer 1 (statistics): PCM is mixed down to mono once and pre-aggregated into
// fixed GRANULARITY-sized granules holding min/max of the absolute samples.
// It is mode agnostic (linear and polar share it) and is kept in a WeakMap keyed
// by the AudioBuffer, so it lives exactly as long as the buffer itself and is
// never evicted while the caller keeps resizing / switching modes.
//
// Layer 2 (buckets + paths): per target `samples`, granules are assembled into
// buckets. Bucket boundaries usually cut through granules, so a bucket merges
// whole-granule stats and, for the cut edge granules only, scans the retained
// mono mix over the overlapping interval (the original AudioBuffer PCM is never
// rescanned). Bucket arrays and rendered path strings live in bounded LRU maps
// and can be evicted independently of the statistics layer.

export const GRANULARITY = 4096;
const PATH_CACHE_LIMIT = 32;
const BUCKET_CACHE_LIMIT = 8;

const statsCache = new WeakMap();

export const getAudioData = (url) => {
    window.AudioContext = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContext();
    return fetch(url)
    .then(response => response.arrayBuffer())
    .then(arrayBuffer => audioContext.decodeAudioData(arrayBuffer))
    .catch(error => {
        console.error(error);
    });
};

// Equal-weight downmix: for stereo this is the canonical 0.5*(L+R) mono rule.
// Mono buffers alias the existing channel array (the mix is never mutated), so
// the statistics layer does not double the PCM memory for the common case.
export const mixToMono = (audioBuffer) => {
    const length = audioBuffer.length;
    const numberOfChannels = audioBuffer.numberOfChannels || 1;
    if (numberOfChannels <= 1) {
        return audioBuffer.getChannelData(0);
    }
    const mono = new Float32Array(length);
    const channels = [];
    for (let c = 0; c < numberOfChannels; c++) {
        channels.push(audioBuffer.getChannelData(c));
    }
    for (let i = 0; i < length; i++) {
        let sum = 0;
        for (let c = 0; c < numberOfChannels; c++) {
            sum += channels[c][i];
        }
        mono[i] = sum / numberOfChannels;
    }
    return mono;
};

// Layer 1: fixed-granularity min/max aggregation. The trailing granule keeps
// the stats of its actual sample count; missing samples are never seen, so no
// zero padding is ever introduced.
const buildStatsEntry = (audioBuffer) => {
    const mono = mixToMono(audioBuffer);
    const length = mono.length;
    const granuleCount = Math.ceil(length / GRANULARITY);
    const granMin = new Float32Array(granuleCount);
    const granMax = new Float32Array(granuleCount);

    for (let g = 0; g < granuleCount; g++) {
        const granStart = g * GRANULARITY;
        const granEnd = Math.min(length, granStart + GRANULARITY);
        let min = Infinity;
        let max = -Infinity;
        for (let i = granStart; i < granEnd; i++) {
            const value = Math.abs(mono[i]);
            if (value < min) min = value;
            if (value > max) max = value;
        }
        // Empty granules cannot occur (the loop only covers real samples), but
        // keep a deterministic zero fallback instead of Infinity.
        if (min === Infinity) {
            min = 0;
            max = 0;
        }
        granMin[g] = min;
        granMax[g] = max;
    }

    return {
        length,
        mono,
        granMin,
        granMax,
        bucketCache: new Map(),
        pathCache: new Map(),
    };
};

export const getStatsEntry = (audioBuffer) => {
    let entry = statsCache.get(audioBuffer);
    if (!entry) {
        entry = buildStatsEntry(audioBuffer);
        statsCache.set(audioBuffer, entry);
    }
    return entry;
};

// Animation frame ranges, equivalent to the old getFramesData slicing (float
// step, truncation and end clamping included). Non-animated data is one frame.
const getFrameRanges = (entry, animation, animationframes, sampleRate) => {
    const length = entry.length;
    if (!animation) {
        return [{ start: 0, end: length }];
    }
    const frameSize = sampleRate / animationframes;
    const ranges = [];
    for (let index = 0; index < length; index += frameSize) {
        const start = Math.trunc(index);
        if (start >= length) break;
        const end = Math.min(length, Math.trunc(index + frameSize));
        ranges.push({ start, end: Math.max(start, end) });
    }
    return ranges;
};

// min/max over [start, end) of the mono mix, assembled from granules.
// Fully covered granules merge in O(1); only granules cut by the range edges
// are scanned directly, and only over the overlapping slice of the mono mix.
export const rangeMinMax = (entry, start, end) => {
    // Clamp to the retained mix so an out-of-range end cannot stall the walk
    // against the final partial granule.
    end = Math.min(end, entry.length);
    if (start >= end) {
        return { min: 0, max: 0 };
    }
    let min = Infinity;
    let max = -Infinity;
    let position = start;
    while (position < end) {
        const granuleIndex = Math.floor(position / GRANULARITY);
        const granuleStart = granuleIndex * GRANULARITY;
        const granuleEnd = Math.min(entry.length, granuleStart + GRANULARITY);
        const sliceEnd = Math.min(end, granuleEnd);

        if (position === granuleStart && sliceEnd === granuleEnd) {
            const granMin = entry.granMin[granuleIndex];
            const granMax = entry.granMax[granuleIndex];
            if (granMin < min) min = granMin;
            if (granMax > max) max = granMax;
        } else {
            const mono = entry.mono;
            for (let i = position; i < sliceEnd; i++) {
                const value = Math.abs(mono[i]);
                if (value < min) min = value;
                if (value > max) max = value;
            }
        }
        position = sliceEnd;
    }
    if (min === Infinity) {
        min = 0;
        max = 0;
    }
    return { min, max };
};

// Layer 2: split every animation frame into exactly `samples` buckets, using
// the same blockSize = floor(frameLength / samples) rule as the legacy filter,
// so the trailing samples past blockSize * samples stay unused.
export const buildBuckets = (entry, frameRanges, samples) => {
    const frames = [];
    const frameRangeCount = frameRanges.length;
    for (let f = 0; f < frameRangeCount; f++) {
        const { start, end } = frameRanges[f];
        const frameLength = end - start;
        const blockSize = Math.floor(frameLength / samples);
        const bucketMin = new Float32Array(samples);
        const bucketMax = new Float32Array(samples);

        if (blockSize > 0) {
            for (let i = 0; i < samples; i++) {
                const bucketStart = start + blockSize * i;
                const { min, max } = rangeMinMax(entry, bucketStart, bucketStart + blockSize);
                bucketMin[i] = min;
                bucketMax[i] = max;
            }
        }
        frames.push({ min: bucketMin, max: bucketMax });
    }
    return frames;
};

export const getBuckets = (entry, audioBuffer, options) => {
    const { samples, animation, animationframes } = options;
    const cacheKey = animation
        ? `a:${audioBuffer.sampleRate}:${animationframes}:${samples}`
        : `s:${samples}`;
    let buckets = entry.bucketCache.get(cacheKey);
    if (!buckets) {
        const frameRanges = getFrameRanges(entry, animation, animationframes, audioBuffer.sampleRate);
        buckets = buildBuckets(entry, frameRanges, samples);
        entry.bucketCache.set(cacheKey, buckets);
        evictLru(entry.bucketCache, BUCKET_CACHE_LIMIT);
    }
    return buckets;
};

// Same global normalization as the legacy code, but silence stays at zero
// instead of becoming NaN (1 / 0), which keeps muted segments cache stable.
const normalizeBuckets = (frames, normalize) => {
    if (!normalize) {
        return frames;
    }
    let peak = 0;
    for (const frame of frames) {
        const maxValues = frame.max;
        for (let i = 0; i < maxValues.length; i++) {
            if (maxValues[i] > peak) peak = maxValues[i];
        }
    }
    const multiplier = peak > 0 ? Math.pow(peak, -1) : 1;

    return frames.map((frame) => ({
        min: frame.min.map((value) => value * multiplier),
        max: frame.max.map((value) => value * multiplier),
    }));
};

// steps/mirror draw alternating down/up spikes: the downward half of each pair
// uses the bucket minimum, the upward half the peak. bars always use the peak.
const selectValue = (frame, index, type) => {
    if (type !== 'bars' && index % 2 === 0) {
        return frame.min[index];
    }
    return frame.max[index];
};

const touchLru = (map, key) => {
    const value = map.get(key);
    map.delete(key);
    map.set(key, value);
};

const evictLru = (map, limit) => {
    while (map.size > limit) {
        const oldestKey = map.keys().next().value;
        map.delete(oldestKey);
    }
};

// Stable JSON signature: object keys sorted, arrays kept ordered.
const stableSignature = (value) => {
    if (Array.isArray(value)) {
        return `[${value.map(stableSignature).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSignature(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
};

const buildPathCacheKey = (mode, options) => {
    const { samples, width, ...rest } = options;
    return `${mode}|${samples}|${width}|${stableSignature(rest)}`;
};

const resolvePathOptions = (options, defaults) => {
    const resolved = { ...defaults, ...options };
    // Clone the path commands so caller objects are never mutated and the
    // cache signature is built from the effective defaults. The nullish
    // fallback mirrors the legacy `paths[k].minshow ?? 0` assignments.
    resolved.paths = resolved.paths.map((pathCommand) => ({
        ...pathCommand,
        minshow: pathCommand.minshow ?? 0,
        maxshow: pathCommand.maxshow ?? 1,
        normalize: pathCommand.normalize ?? false,
    }));
    return resolved;
};

const getCachedPath = (entry, mode, options, render) => {
    const key = buildPathCacheKey(mode, options);
    if (entry.pathCache.has(key)) {
        touchLru(entry.pathCache, key);
        return entry.pathCache.get(key);
    }
    const path = render();
    entry.pathCache.set(key, path);
    evictLru(entry.pathCache, PATH_CACHE_LIMIT);
    return path;
};

export const linearPath = (audioBuffer, options) => {
    const resolved = resolvePathOptions(options, {
        channel: 0,
        samples: audioBuffer.length,
        height: 100,
        width: 800,
        top: 0,
        left: 0,
        type: 'steps',
        paths: [{d:'Q', sx: 0, sy:0, x: 50, y: 100, ex:100, ey:0}],
        animation: false,
        animationframes: 10,
        normalize: true,
    });

    const entry = getStatsEntry(audioBuffer);
    return getCachedPath(entry, 'linear', resolved, () => {
        const {
            samples,
            height,
            width,
            top,
            left,
            type,
            paths,
            normalize,
        } = resolved;

        const buckets = normalizeBuckets(getBuckets(entry, audioBuffer, resolved), normalize);

        let path = ``;

        const fixHeight = (type != 'bars' ?  (height+top*2) / 2 : height+top);
        const fixWidth = width / samples;
        const pathslength = paths.length;
        const fixpathslength =  (type == 'mirror' ? pathslength*2 : pathslength);

        const framesLength = buckets.length;

        for(let f = 0; f < framesLength; f++) {
            if(f>0) {
                const pathlength = path.length;
                const lastvalue = path.charAt(pathlength - 1);
                if(lastvalue == ";" || pathlength === 0) {
                    path+=' M 0 0 ;';
                } else {
                    path += ';';
                }
            }

            let last_pos_x = -9999;
            let last_pos_y = -9999;

            for (let i = 0; i < samples; i++) {
                const frameValue = selectValue(buckets[f], i, type);

                const positive =  (type != 'bars' ? (i % 2 ? 1: -1) : 1);
                let mirror = 1;
                for(let j = 0; j < fixpathslength; j++) {
                    let k = j;
                    if(j >= pathslength) {
                        k = j - pathslength;
                        mirror = -1;
                    }
                    const normalizeDataValue = (paths[k].normalize ? 1 : frameValue);
                    if(paths[k].minshow <= frameValue && paths[k].maxshow >= frameValue) {
                        switch (paths[k].d) {
                            // LineTo Commands
                            case 'L': {
                                const pos_x = (i * fixWidth)  + (fixWidth*paths[k].sx/100) + left;
                                const pos_y = fixHeight + (normalizeDataValue * paths[k].sy / 100 * (type != 'bars' ? height/2 : height) * -positive*mirror);

                                const end_pos_x = (i*fixWidth) + (fixWidth*paths[k].ex/100) + left;
                                const end_pos_y = fixHeight + (normalizeDataValue * paths[k].ey / 100 * (type != 'bars' ? height/2 : height) * -positive*mirror);

                                if(pos_x !== last_pos_x || pos_y !== last_pos_y) {
                                    path += `M ${pos_x} ${pos_y} `;
                                }

                                path += `L ${end_pos_x} ${end_pos_y} `;

                                last_pos_x = end_pos_x;
                                last_pos_y = end_pos_y;
                                break;
                            }

                            case 'H': {
                                const pos_x = (i * fixWidth)  + (fixWidth*paths[k].sx/100) + left;
                                const pos_y = fixHeight + (normalizeDataValue * paths[k].y / 100 * (type != 'bars' ? height/2 : height) * -positive*mirror);

                                const end_pos_x = (i*fixWidth) + (fixWidth*paths[k].ex/100) + left;
                                const end_pos_y = pos_y;

                                if(pos_x !== last_pos_x || pos_y !== last_pos_y) {
                                    path += `M ${pos_x} ${pos_y} `;
                                }

                                path += `H ${end_pos_x} `;

                                last_pos_x = end_pos_x;
                                last_pos_y = end_pos_y;
                                break;
                            }

                            case 'V': {
                                const pos_x = (i * fixWidth)  + (fixWidth*paths[k].x/100) + left;
                                const pos_y = fixHeight + (normalizeDataValue * paths[k].sy / 100 * (type != 'bars' ? height/2 : height) * -positive*mirror);

                                const end_pos_x = pos_x;
                                const end_pos_y = fixHeight + (normalizeDataValue * paths[k].ey / 100 * (type != 'bars' ? height/2 : height) * -positive*mirror);

                                if(pos_x !== last_pos_x || pos_y !== last_pos_y) {
                                    path += `M ${pos_x} ${pos_y} `;
                                }

                                path += `V ${end_pos_y} `;

                                last_pos_x = end_pos_x;
                                last_pos_y = end_pos_y;
                                break;
                            }

                            // Cubic Bézier Curve Commands
                            case 'C': {
                                const pos_x = (i * fixWidth)  + (fixWidth*paths[k].sx/100) + left;
                                const pos_y = fixHeight  - (fixHeight*paths[k].sy/100)*positive;

                                const center_pos_x = (i * fixWidth)  + (fixWidth*paths[k].x/100) + left;
                                const center_pos_y = fixHeight + (normalizeDataValue * paths[k].y / 100 * (type != 'bars' ? height : height*2) * -positive*mirror);

                                const end_pos_x = (i*fixWidth) + (fixWidth*paths[k].ex/100) + left;
                                const end_pos_y = fixHeight - (fixHeight*paths[k].ey/100)*positive;

                                if(pos_x !== last_pos_x || pos_y !== last_pos_y) {
                                    path += `M ${pos_x} ${pos_y} `;
                                }

                                path += `C ${pos_x} ${pos_y} ${center_pos_x} ${center_pos_y} ${end_pos_x} ${end_pos_y} `;

                                last_pos_x = end_pos_x;
                                last_pos_y = end_pos_y;
                                break;
                            }

                            // Quadratic Bézier Curve Commands
                            case 'Q': {
                                const pos_x = (i * fixWidth)  + (fixWidth*paths[k].sx/100) + left;
                                const pos_y = fixHeight + (normalizeDataValue * paths[k].sy / 100 * (type != 'bars' ? height/2 : height) * -positive*mirror);

                                const center_pos_x = (i * fixWidth)  + (fixWidth*paths[k].x/100) + left;
                                const center_pos_y = fixHeight + (normalizeDataValue * paths[k].y / 100 * (type != 'bars' ? height : height*2) * -positive*mirror);

                                const end_pos_x = (i*fixWidth) + (fixWidth*paths[k].ex/100) + left;
                                const end_pos_y = fixHeight + (normalizeDataValue * paths[k].ey / 100 * (type != 'bars' ? height/2 : height) * -positive*mirror);

                                if(pos_x !== last_pos_x || pos_y !== last_pos_y) {
                                    path += `M ${pos_x} ${pos_y} `;
                                }

                                path += `Q ${center_pos_x} ${center_pos_y} ${end_pos_x} ${end_pos_y} `;

                                last_pos_x = end_pos_x;
                                last_pos_y = end_pos_y;
                                break;
                            }

                            // Elliptical Arc Curve Commands
                            case 'A': {
                                const pos_x = (i * fixWidth)  + (fixWidth*paths[k].sx/100) + left;
                                const pos_y = fixHeight + (normalizeDataValue * paths[k].sy / 100 * (type != 'bars' ? height/2 : height) * -positive*mirror);

                                const end_pos_x = (i*fixWidth) + (fixWidth*paths[k].ex/100) + left;
                                const end_pos_y = fixHeight + (normalizeDataValue * paths[k].ey / 100 * (type != 'bars' ? height/2 : height) * -positive*mirror);

                                if(pos_x !== last_pos_x || pos_y !== last_pos_y) {
                                    path += `M ${pos_x} ${pos_y} `;
                                }
                                const rx = paths[k].rx * fixWidth/100;
                                const ry = paths[k].ry * fixWidth/100;
                                let sweep = paths[k].sweep;
                                if(positive == -1) {
                                    if(sweep == 1) {
                                        sweep = 0;
                                    } else {
                                        sweep = 1;
                                    }
                                }
                                if(mirror == -1) {
                                    if(sweep == 1) {
                                        sweep = 0;
                                    } else {
                                        sweep = 1;
                                    }
                                }
                                path += `A ${rx} ${ry} ${paths[k].angle} ${paths[k].arc} ${sweep} ${end_pos_x} ${end_pos_y} `;

                                last_pos_x = end_pos_x;
                                last_pos_y = end_pos_y;
                                break;
                            }

                            // ClosePath Commands
                            case 'Z':
                                path += 'Z ';
                                break;

                            default:
                                break;
                        }
                    }
                }
            }
        }
        return path;
    });
}

export const polarPath = (audioBuffer, options) => {
    const resolved = resolvePathOptions(options, {
        channel: 0,
        samples: audioBuffer.length,
        distance: 50,
        length: 100,
        top: 0,
        left: 0,
        type: 'steps',
        startdeg: 0,
        enddeg: 360,
        invertdeg: false,
        invertpath: false,
        paths: [{d:'Q', sdeg: 0, sr:0, deg: 50, r: 100, edeg:100, er:0}],
        animation: false,
        animationframes: 10,
        normalize: true,
    });

    const entry = getStatsEntry(audioBuffer);
    return getCachedPath(entry, 'polar', resolved, () => {
        const {
            samples,
            distance,
            length,
            top,
            left,
            type,
            startdeg,
            enddeg,
            invertdeg,
            invertpath,
            paths,
            normalize,
        } = resolved;

        const buckets = normalizeBuckets(getBuckets(entry, audioBuffer, resolved), normalize);

        let path = ``;
        const fixenddeg = (enddeg < startdeg ? enddeg+360 : enddeg);
        const deg = (!invertdeg ? (fixenddeg-startdeg) / samples : (startdeg-fixenddeg) / samples );
        const fixOrientation = (!invertdeg ? 90+startdeg : 90+startdeg+180 );
        const invert = (!invertpath ? 1 : -1);
        const pathslength = paths.length;
        const fixpathslength =  (type == 'mirror' ? pathslength*2 : pathslength);
        const pi180 = Math.PI / 180;

        const framesLength = buckets.length;

        for(let f = 0; f < framesLength; f++) {
            if(f>0) {
                const pathlength = path.length;
                const lastvalue = path.charAt(pathlength - 1);
                if(lastvalue == ";" || pathlength === 0) {
                    path+=' M 0 0 ;';
                } else {
                    path += ';';
                }
            }

            let last_pos_x = -9999;
            let last_pos_y = -9999;

            for (let i = 0; i < samples; i++) {
                const frameValue = selectValue(buckets[f], i, type);

                const positive =  (type != 'bars' ? (i % 2 ? 1: -1) : 1);
                let mirror = 1;
                for(let j = 0; j < fixpathslength; j++) {
                    let k = j;
                    if(j >= pathslength) {
                        k = j - pathslength;
                        mirror = -1;
                    }
                    const normalizeDataValue = (paths[k].normalize ? 1 : frameValue);
                    if(paths[k].minshow <= frameValue && paths[k].maxshow >= frameValue) {
                        switch (paths[k].d) {
                            // LineTo Commands
                            case 'L': {
                                const angleStart =  ((deg*(i+paths[k].sdeg/100)) - fixOrientation) * pi180;
                                const angleEnd =  ((deg*(i+paths[k].edeg/100)) - fixOrientation) * pi180;

                                const pos_x = left + ((length*(paths[k].sr/100)*normalizeDataValue)* positive*mirror*invert + distance) * Math.cos(angleStart);
                                const pos_y = top + ((length*(paths[k].sr/100)*normalizeDataValue)* positive*mirror*invert + distance) * Math.sin(angleStart);

                                const end_pos_x = left + ((length*(paths[k].er/100)*normalizeDataValue)* positive*mirror*invert + distance) * Math.cos(angleEnd);
                                const end_pos_y = top + ((length*(paths[k].er/100)*normalizeDataValue)* positive*mirror*invert + distance) * Math.sin(angleEnd);

                                if(pos_x !== last_pos_x || pos_y !== last_pos_y) {
                                    path += `M ${pos_x} ${pos_y} `;
                                }

                                path += `L ${end_pos_x} ${end_pos_y} `;

                                last_pos_x = end_pos_x;
                                last_pos_y = end_pos_y;
                                break;
                            }


                            // Cubic Bézier Curve Commands
                            case 'C': {
                                const angleStart =  ((deg*(i+paths[k].sdeg/100)) - fixOrientation) * pi180;
                                const angle =  ((deg*(i+paths[k].deg/100)) - fixOrientation) * pi180;
                                const angleEnd =  ((deg*(i+paths[k].edeg/100)) - fixOrientation) * pi180;

                                const pos_x = left + ((length*(paths[k].sr/100)*normalizeDataValue)* positive*mirror*invert + distance) * Math.cos(angleStart);
                                const pos_y = top + ((length*(paths[k].sr/100)*normalizeDataValue)* positive*mirror*invert + distance) * Math.sin(angleStart);

                                const center_pos_x = left + ((length*(paths[k].r/100)*normalizeDataValue)* positive*mirror*invert + distance) * Math.cos(angle);
                                const center_pos_y = top + ((length*(paths[k].r/100)*normalizeDataValue)* positive*mirror*invert + distance) * Math.sin(angle);

                                const end_pos_x = left + ((length*(paths[k].er/100)*normalizeDataValue)* positive*mirror*invert + distance) * Math.cos(angleEnd);
                                const end_pos_y = top + ((length*(paths[k].er/100)*normalizeDataValue)* positive*mirror*invert + distance) * Math.sin(angleEnd);

                                if(pos_x !== last_pos_x || pos_y !== last_pos_y) {
                                    path += `M ${pos_x} ${pos_y} `;
                                }

                                path += `C ${pos_x} ${pos_y} ${center_pos_x} ${center_pos_y} ${end_pos_x} ${end_pos_y} `;

                                last_pos_x = end_pos_x;
                                last_pos_y = end_pos_y;
                                break;
                            }

                            // Quadratic Bézier Curve Commands
                            case 'Q': {
                                const angleStart =  ((deg*(i+paths[k].sdeg/100)) - fixOrientation) * pi180;
                                const angle =  ((deg*(i+paths[k].deg/100)) - fixOrientation) * pi180;
                                const angleEnd =  ((deg*(i+paths[k].edeg/100)) - fixOrientation) * pi180;

                                const pos_x = left + ((length*(paths[k].sr/100)*normalizeDataValue)* positive*mirror*invert + distance) * Math.cos(angleStart);
                                const pos_y = top + ((length*(paths[k].sr/100)*normalizeDataValue)* positive*mirror*invert + distance) * Math.sin(angleStart);

                                const center_pos_x = left + ((length*(paths[k].r/100)*normalizeDataValue)* positive*mirror*invert + distance) * Math.cos(angle);
                                const center_pos_y = top + ((length*(paths[k].r/100)*normalizeDataValue)* positive*mirror*invert + distance) * Math.sin(angle);

                                const end_pos_x = left + ((length*(paths[k].er/100)*normalizeDataValue)* positive*mirror*invert + distance) * Math.cos(angleEnd);
                                const end_pos_y = top + ((length*(paths[k].er/100)*normalizeDataValue)* positive*mirror*invert + distance) * Math.sin(angleEnd);


                                if(pos_x !== last_pos_x || pos_y !== last_pos_y) {
                                    path += `M ${pos_x} ${pos_y} `;
                                }

                                path += `Q ${center_pos_x} ${center_pos_y} ${end_pos_x} ${end_pos_y} `;

                                last_pos_x = end_pos_x;
                                last_pos_y = end_pos_y;
                                break;
                            }

                            // Elliptical Arc Curve Commands
                            case 'A': {
                                const angleStart =  ((deg*(i+paths[k].sdeg/100)) - fixOrientation) * pi180;
                                const angleEnd =  ((deg*(i+paths[k].edeg/100)) - fixOrientation) * pi180;

                                const pos_x = left + ((length*(paths[k].sr/100)*normalizeDataValue)* positive*mirror*invert + distance) * Math.cos(angleStart);
                                const pos_y = top + ((length*(paths[k].sr/100)*normalizeDataValue)* positive*mirror*invert + distance) * Math.sin(angleStart);

                                const end_pos_x = left + ((length*(paths[k].er/100)*normalizeDataValue)* positive*mirror*invert + distance) * Math.cos(angleEnd);
                                const end_pos_y = top + ((length*(paths[k].er/100)*normalizeDataValue)* positive*mirror*invert + distance) * Math.sin(angleEnd);

                                if(pos_x !== last_pos_x || pos_y !== last_pos_y) {
                                    path += `M ${pos_x} ${pos_y} `;
                                }

                                const angle = deg * i * paths[k].angle / 100;
                                const rx = paths[k].rx * deg/100;
                                const ry = paths[k].ry * deg/100;

                                let sweep = paths[k].sweep;
                                if(positive == -1) {
                                    if(sweep == 1) {
                                        sweep = 0;
                                    } else {
                                        sweep = 1;
                                    }
                                }
                                if(mirror == -1) {
                                    if(sweep == 1) {
                                        sweep = 0;
                                    } else {
                                        sweep = 1;
                                    }
                                }
                                path += `A ${rx} ${ry} ${angle} ${paths[k].arc} ${sweep} ${end_pos_x} ${end_pos_y} `;

                                last_pos_x = end_pos_x;
                                last_pos_y = end_pos_y;
                                break;
                            }

                            // ClosePath Commands
                            case 'Z':
                                path += 'Z ';
                                break;

                            default:
                                break;
                        }
                    }
                }
            }
        }
        return path;
    });
}
