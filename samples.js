// samples.js — sampled instruments for Turkey Synth.
//
// Three kinds of instrument, all with the same interface:
//   inst.regionsFor(midi) -> [{ buffer, rootPitch, loop, loopStart, loopEnd, gain, pan }]
// so the synth can play any of them by pitch-shifting the nearest recording.
//
//  • General MIDI: the FluidR3 GM set (Frank Wen, CC BY 3.0) as pre-rendered MP3s from
//    github.com/gleitz/midi-js-soundfonts, loaded every 3 semitones and pitch-shifted in between.
//  • SoundFont 2 (.sf2) files: a small parser for presets, instruments, key ranges, tuning and loops.
//  • A single audio file: one recording, pitch-shifted across the keyboard.
(function (global) {
  'use strict';

  const GM_BASES = ['https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/', 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/'];
  const GM_NAMES = ['acoustic_grand_piano', 'bright_acoustic_piano', 'electric_grand_piano', 'honkytonk_piano', 'electric_piano_1', 'electric_piano_2', 'harpsichord', 'clavinet',
    'celesta', 'glockenspiel', 'music_box', 'vibraphone', 'marimba', 'xylophone', 'tubular_bells', 'dulcimer',
    'drawbar_organ', 'percussive_organ', 'rock_organ', 'church_organ', 'reed_organ', 'accordion', 'harmonica', 'tango_accordion',
    'acoustic_guitar_nylon', 'acoustic_guitar_steel', 'electric_guitar_jazz', 'electric_guitar_clean', 'electric_guitar_muted', 'overdriven_guitar', 'distortion_guitar', 'guitar_harmonics',
    'acoustic_bass', 'electric_bass_finger', 'electric_bass_pick', 'fretless_bass', 'slap_bass_1', 'slap_bass_2', 'synth_bass_1', 'synth_bass_2',
    'violin', 'viola', 'cello', 'contrabass', 'tremolo_strings', 'pizzicato_strings', 'orchestral_harp', 'timpani',
    'string_ensemble_1', 'string_ensemble_2', 'synth_strings_1', 'synth_strings_2', 'choir_aahs', 'voice_oohs', 'synth_choir', 'orchestra_hit',
    'trumpet', 'trombone', 'tuba', 'muted_trumpet', 'french_horn', 'brass_section', 'synth_brass_1', 'synth_brass_2',
    'soprano_sax', 'alto_sax', 'tenor_sax', 'baritone_sax', 'oboe', 'english_horn', 'bassoon', 'clarinet',
    'piccolo', 'flute', 'recorder', 'pan_flute', 'blown_bottle', 'shakuhachi', 'whistle', 'ocarina',
    'lead_1_square', 'lead_2_sawtooth', 'lead_3_calliope', 'lead_4_chiff', 'lead_5_charang', 'lead_6_voice', 'lead_7_fifths', 'lead_8_bass__lead',
    'pad_1_new_age', 'pad_2_warm', 'pad_3_polysynth', 'pad_4_choir', 'pad_5_bowed', 'pad_6_metallic', 'pad_7_halo', 'pad_8_sweep',
    'fx_1_rain', 'fx_2_soundtrack', 'fx_3_crystal', 'fx_4_atmosphere', 'fx_5_brightness', 'fx_6_goblins', 'fx_7_echoes', 'fx_8_scifi',
    'sitar', 'banjo', 'shamisen', 'koto', 'kalimba', 'bagpipe', 'fiddle', 'shanai',
    'tinkle_bell', 'agogo', 'steel_drums', 'woodblock', 'taiko_drum', 'melodic_tom', 'synth_drum', 'reverse_cymbal',
    'guitar_fret_noise', 'breath_noise', 'seashore', 'bird_tweet', 'telephone_ring', 'helicopter', 'applause', 'gunshot'];
  const GM_FAMILIES = ['Piano', 'Chromatic percussion', 'Organ', 'Guitar', 'Bass', 'Strings', 'Ensemble', 'Brass',
    'Reed', 'Pipe', 'Synth lead', 'Synth pad', 'Synth effects', 'Ethnic', 'Percussive', 'Sound effects'];
  const prettyName = (id) => {
    const s = id.replace('__', ' + ').replace(/_/g, ' ').replace(/(\d) /, '$1 ');
    return s[0].toUpperCase() + s.slice(1);
  };
  const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const noteFile = (m) => FLAT_NAMES[m % 12] + (Math.floor(m / 12) - 1);

  // Pick the region whose root is nearest (ties go to the recording below, which sounds better shifted up).
  function nearest(roots, m) {
    let best = null;
    for (const r of roots) if (best == null || Math.abs(r - m) < Math.abs(best - m) || (Math.abs(r - m) === Math.abs(best - m) && r < best)) best = r;
    return best;
  }

  // ---------- General MIDI (FluidR3) ----------
  function loadGM(ctx, id, onProgress) {
    const roots = [];
    for (let m = 21; m <= 108; m += 3) roots.push(m); // A0, C1, Eb1 ... every minor third
    if (roots[roots.length - 1] !== 108) roots.push(108);
    const buffers = new Map();
    let done = 0, failed = 0;
    const inst = {
      kind: 'gm', id, name: prettyName(id),
      get ready() { return buffers.size > 0; },
      regionsFor(m) {
        const r = nearest([...buffers.keys()], Math.round(m));
        return r == null ? [] : [{ buffer: buffers.get(r), rootPitch: r, loop: false, gain: 1, pan: 0 }];
      },
    };
    // load from the middle of the keyboard outwards so common notes are ready first
    const order = roots.slice().sort((a, b) => Math.abs(a - 60) - Math.abs(b - 60));
    inst.loaded = Promise.all(order.map(async (m) => {
      try {
        let res = null;
        for (const base of GM_BASES) { // the CDN refuses a few files; GitHub Pages has them all
          try { res = await fetch(`${base}${id}-mp3/${noteFile(m)}.mp3`); } catch { res = null; }
          if (res && res.ok) break;
        }
        if (!res || !res.ok) throw new Error('download failed');
        buffers.set(m, await ctx.decodeAudioData(await res.arrayBuffer()));
      } catch (e) {
        failed++;
      }
      done++;
      onProgress && onProgress(done, roots.length, failed);
    })).then(() => {
      if (!buffers.size) throw new Error('Couldn\'t download the samples (are you offline?)');
      return inst;
    });
    return inst;
  }

  // ---------- A single audio file ----------
  // Rough pitch detection by autocorrelation, to guess which note was recorded.
  function detectPitch(buffer) {
    const data = buffer.getChannelData(0), sr = buffer.sampleRate;
    // analyse a 4096-sample window at the loudest part
    const N = 4096;
    let bestStart = 0, bestEnergy = 0;
    for (let s = 0; s + N < data.length; s += 2048) {
      let e = 0;
      for (let i = s; i < s + N; i += 8) e += data[i] * data[i];
      if (e > bestEnergy) { bestEnergy = e; bestStart = s; }
    }
    const minLag = Math.floor(sr / 2000), maxLag = Math.min(N - 1, Math.floor(sr / 40));
    let bestLag = 0, bestCorr = 0;
    const corrAt = (lag) => {
      let c = 0, n1 = 0, n2 = 0;
      for (let i = 0; i + lag < N; i++) {
        const a = data[bestStart + i], b = data[bestStart + i + lag];
        c += a * b; n1 += a * a; n2 += b * b;
      }
      return c / Math.sqrt(n1 * n2 + 1e-12);
    };
    const corrs = [];
    for (let lag = minLag; lag <= maxLag; lag++) corrs[lag] = corrAt(lag);
    const top = Math.max(...corrs.filter(Number.isFinite));
    // the first strong peak (avoids picking an octave below)
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (corrs[lag] > 0.9 * top && corrs[lag] >= corrs[lag - 1] && corrs[lag] >= corrs[lag + 1]) { bestLag = lag; bestCorr = corrs[lag]; break; }
    }
    if (!bestLag || bestCorr < 0.5) return null;
    const hz = sr / bestLag;
    return 69 + 12 * Math.log2(hz / 440);
  }

  function sampleInstrument(name, buffer, rootPitch, loop) {
    return {
      kind: 'sample', name, buffer, rootPitch, loop, ready: true,
      regionsFor() {
        // loop a section from the body of the sound (skipping the attack)
        return [{ buffer: this.buffer, rootPitch: this.rootPitch, loop: this.loop, loopStart: this.buffer.duration * 0.3, loopEnd: this.buffer.duration * 0.9, gain: 1, pan: 0 }];
      },
    };
  }

  // ---------- SoundFont 2 ----------
  const GEN = { startAddrsOffset: 0, endAddrsOffset: 1, startloopAddrsOffset: 2, endloopAddrsOffset: 3, startAddrsCoarseOffset: 4, endAddrsCoarseOffset: 12,
    pan: 17, instrument: 41, keyRange: 43, velRange: 44, startloopAddrsCoarseOffset: 45, initialAttenuation: 48, endloopAddrsCoarseOffset: 50,
    coarseTune: 51, fineTune: 52, sampleID: 53, sampleModes: 54, overridingRootKey: 58 };

  function parseSF2(arrayBuffer, ctx) {
    const buf = arrayBuffer, dv = new DataView(buf);
    const str = (o, n) => { let s = ''; for (let i = 0; i < n; i++) { const c = dv.getUint8(o + i); if (!c) break; s += String.fromCharCode(c); } return s; };
    if (buf.byteLength < 12 || str(0, 4) !== 'RIFF' || str(8, 4) !== 'sfbk') throw new Error('That isn\'t a SoundFont 2 (.sf2) file.');
    let smpl = -1, version = 2;
    const pdta = {};
    for (let off = 12; off + 8 <= buf.byteLength;) {
      const id = str(off, 4), size = dv.getUint32(off + 4, true);
      if (id === 'LIST') {
        const type = str(off + 8, 4), end = Math.min(buf.byteLength, off + 8 + size);
        for (let o = off + 12; o + 8 <= end;) {
          const cid = str(o, 4), csz = dv.getUint32(o + 4, true);
          if (type === 'INFO' && cid === 'ifil') version = dv.getUint16(o + 8, true);
          if (type === 'sdta' && cid === 'smpl') smpl = o + 8;
          if (type === 'pdta') pdta[cid] = { off: o + 8, size: csz };
          o += 8 + csz + (csz & 1);
        }
      }
      off += 8 + size + (size & 1);
    }
    if (version >= 3) throw new Error('This is a compressed SoundFont 3 file, which isn\'t supported. Use an .sf2 file.');
    for (const c of ['phdr', 'pbag', 'pgen', 'inst', 'ibag', 'igen', 'shdr']) if (!pdta[c]) throw new Error('This SoundFont is missing its "' + c + '" section.');
    if (smpl < 0) throw new Error('This SoundFont has no sample data.');

    const records = (c, size, fn) => { const out = []; for (let o = pdta[c].off; o + size <= pdta[c].off + pdta[c].size; o += size) out.push(fn(o)); return out; };
    const phdr = records('phdr', 38, (o) => ({ name: str(o, 20), program: dv.getUint16(o + 20, true), bank: dv.getUint16(o + 22, true), bag: dv.getUint16(o + 24, true) }));
    const bag = (c) => records(c, 4, (o) => dv.getUint16(o, true));
    const gens = (c) => records(c, 4, (o) => ({ op: dv.getUint16(o, true), s: dv.getInt16(o + 2, true), lo: dv.getUint8(o + 2), hi: dv.getUint8(o + 3) }));
    const pbag = bag('pbag'), pgen = gens('pgen'), ibag = bag('ibag'), igen = gens('igen');
    const insts = records('inst', 22, (o) => ({ name: str(o, 20), bag: dv.getUint16(o + 20, true) }));
    const shdr = records('shdr', 46, (o) => ({ name: str(o, 20), start: dv.getUint32(o + 20, true), end: dv.getUint32(o + 24, true), loopStart: dv.getUint32(o + 28, true),
      loopEnd: dv.getUint32(o + 32, true), rate: dv.getUint32(o + 36, true), pitch: dv.getUint8(o + 40), correction: dv.getInt8(o + 41), type: dv.getUint16(o + 44, true) }));

    // zones: lists of generators, with the optional "global" zone separated out
    const zonesOf = (bags, genList, from, to, terminal) => {
      const zones = [];
      for (let b = from; b < to; b++) {
        const g = {};
        for (let i = bags[b]; i < bags[b + 1]; i++) g[genList[i].op] = genList[i];
        zones.push(g);
      }
      const global = zones.length && zones[0][terminal] == null ? zones.shift() : {};
      return { global, zones: zones.filter((z) => z[terminal] != null) };
    };
    const val = (z, gz, op, def = 0) => (z[op] ? z[op].s : gz[op] ? gz[op].s : def);
    const range = (z, gz, op) => (z[op] ? [z[op].lo, z[op].hi] : gz[op] ? [gz[op].lo, gz[op].hi] : [0, 127]);

    const bufferCache = new Map();
    function bufferFor(start, end, rate) {
      const key = start + ':' + end + ':' + rate;
      if (bufferCache.has(key)) return bufferCache.get(key);
      const len = Math.max(1, end - start);
      const b = ctx.createBuffer(1, len, Math.max(3000, Math.min(768000, rate)));
      const ch = b.getChannelData(0);
      const base = smpl + start * 2;
      for (let i = 0; i < len && base + i * 2 + 1 < buf.byteLength; i++) ch[i] = dv.getInt16(base + i * 2, true) / 32768;
      bufferCache.set(key, b);
      return b;
    }

    const presets = phdr.slice(0, -1).map((p, i) => ({ name: p.name || `Preset ${i + 1}`, bank: p.bank, program: p.program, bagFrom: p.bag, bagTo: phdr[i + 1].bag }));
    presets.sort((a, b) => a.bank - b.bank || a.program - b.program);

    function instrumentFor(preset) {
      const regions = [];
      const pz = zonesOf(pbag, pgen, preset.bagFrom, preset.bagTo, GEN.instrument);
      for (const z of pz.zones) {
        const ii = z[GEN.instrument].s;
        const inst = insts[ii], next = insts[ii + 1];
        if (!inst || !next) continue;
        const iz = zonesOf(ibag, igen, inst.bag, next.bag, GEN.sampleID);
        const pKeys = range(z, pz.global, GEN.keyRange), pVel = range(z, pz.global, GEN.velRange);
        for (const zz of iz.zones) {
          const s = shdr[zz[GEN.sampleID].s];
          if (!s || s.type & 0x8000) continue; // ROM samples aren't available
          const iKeys = range(zz, iz.global, GEN.keyRange), iVel = range(zz, iz.global, GEN.velRange);
          const keys = [Math.max(pKeys[0], iKeys[0]), Math.min(pKeys[1], iKeys[1])];
          const vel = [Math.max(pVel[0], iVel[0]), Math.min(pVel[1], iVel[1])];
          if (keys[0] > keys[1] || vel[0] > vel[1]) continue;
          // instrument generators set values; preset generators add to them
          const sum = (op) => val(zz, iz.global, op) + val(z, pz.global, op);
          const off = (fine, coarse) => val(zz, iz.global, fine) + 32768 * val(zz, iz.global, coarse);
          const rk = val(zz, iz.global, GEN.overridingRootKey, -1);
          const root = rk >= 0 ? rk : s.pitch <= 127 ? s.pitch : 60;
          const start = s.start + off(GEN.startAddrsOffset, GEN.startAddrsCoarseOffset);
          const end = s.end + off(GEN.endAddrsOffset, GEN.endAddrsCoarseOffset);
          const ls = s.loopStart + off(GEN.startloopAddrsOffset, GEN.startloopAddrsCoarseOffset);
          const le = s.loopEnd + off(GEN.endloopAddrsOffset, GEN.endloopAddrsCoarseOffset);
          const modes = val(zz, iz.global, GEN.sampleModes) & 3;
          regions.push({
            keys, vel, start, end, rate: s.rate,
            rootPitch: root - sum(GEN.coarseTune) - (sum(GEN.fineTune) + s.correction) / 100,
            loop: (modes === 1 || modes === 3) && le > ls,
            loopStart: (ls - start) / s.rate, loopEnd: (le - start) / s.rate,
            gain: Math.pow(10, -Math.max(0, sum(GEN.initialAttenuation)) / 200),
            pan: Math.max(-1, Math.min(1, sum(GEN.pan) / 500)),
          });
        }
      }
      return {
        kind: 'sf2', name: preset.name, ready: true, regionCount: regions.length,
        regionsFor(m) {
          const k = Math.round(m);
          let hits = regions.filter((r) => k >= r.keys[0] && k <= r.keys[1] && 100 >= r.vel[0] && 100 <= r.vel[1]);
          if (!hits.length) hits = regions.filter((r) => k >= r.keys[0] && k <= r.keys[1]);
          if (!hits.length && regions.length) { // outside every key range: stretch the nearest region
            const near = regions.reduce((a, r) => (Math.abs(r.rootPitch - m) < Math.abs(a.rootPitch - m) ? r : a));
            hits = [near];
          }
          return hits.map((r) => ({ ...r, buffer: bufferFor(r.start, r.end, r.rate) }));
        },
      };
    }
    return { presets, instrumentFor };
  }

  global.Samples = { GM_NAMES, GM_FAMILIES, prettyName, loadGM, parseSF2, detectPitch, sampleInstrument };
})(typeof window !== 'undefined' ? window : globalThis);
