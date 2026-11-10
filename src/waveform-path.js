// Public entry point: signatures are unchanged, the two-layer engine lives in
// waveform-core.mjs so it can also be exercised directly from Node tests.
export {
    getAudioData,
    linearPath,
    polarPath,
    GRANULARITY,
    getStatsEntry,
    rangeMinMax,
    mixToMono,
} from './waveform-core.mjs';
