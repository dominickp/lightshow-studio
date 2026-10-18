import * as THREE from 'three/webgpu';
import { evaluateFixtureStates, timeToBeat } from '@dmxsim/show-model';
import { createDemoShow } from './demo-show';
import { AudioClock } from './audio-clock';
import { loopEndSec, loopLengthSec, loopStartSec, TRACK, TRACK_URL } from './track';
import { computePeaks, WaveformStrip } from './waveform';
import { Stage } from './stage';
import { Post } from './post';

const show = createDemoShow(loopStartSec, TRACK.bpm);
const counts = [10, 16, 22, 26, 32].filter((n) => n <= show.fixtures.length);

const container = document.getElementById('app');
if (container === null) throw new Error('missing #app element');

const renderer = new THREE.WebGPURenderer({ antialias: true });
const baseRatio = Math.min(window.devicePixelRatio || 1, 1.5);
renderer.setPixelRatio(baseRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.info.autoReset = false;
container.appendChild(renderer.domElement);

await renderer.init();

const stage = new Stage(renderer.domElement, show);
const post = new Post(renderer, stage.scene, stage.camera);
const clock = new AudioClock();
clock.setLoop({ startSec: loopStartSec, endSec: loopEndSec }, true);

let volumetrics = true;
let bloomOn = true;
let shadowsOn = true;
let lofi = false;
let strobesOn = false;
let countIndex = counts.length - 1;
let activeCount = counts[countIndex] ?? show.fixtures.length;

stage.setActiveCount(activeCount);

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing #${id}`);
  return found as T;
};

const ui = {
  fps: element('stat-fps'),
  ms: element('stat-ms'),
  calls: element('stat-calls'),
  tris: element('stat-tris'),
  res: element('stat-res'),
  backend: element('stat-backend'),
  fixtures: element('stat-fixtures'),
  time: element('stat-time'),
  latency: element('stat-latency'),
  loop: element('stat-loop'),
  transportTime: element('transport-time'),
  play: element<HTMLButtonElement>('btn-play'),
  vol: element<HTMLButtonElement>('btn-vol'),
  bloom: element<HTMLButtonElement>('btn-bloom'),
  shadow: element<HTMLButtonElement>('btn-shadow'),
  lofi: element<HTMLButtonElement>('btn-lofi'),
  strobe: element<HTMLButtonElement>('btn-strobe'),
  strobeStatus: element('strobe-status'),
  view: element<HTMLButtonElement>('btn-view'),
  count: element<HTMLButtonElement>('btn-count'),
  waveform: element<HTMLCanvasElement>('waveform'),
  loading: element('loading'),
};

const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
ui.backend.textContent = backend;
ui.loop.textContent = `${TRACK.loopStartBar}–${TRACK.loopStartBar + TRACK.loopBars - 1}`;

const waveform = new WaveformStrip(ui.waveform, (songSec) => clock.seek(songSec));

/** Choreography stays on the loop's bar grid even when the audio is not looping. */
const showTime = (songSec: number): number =>
  loopStartSec + (((songSec - loopStartSec) % loopLengthSec) + loopLengthSec) % loopLengthSec;

const formatClock = (seconds: number): string => {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${(safe - minutes * 60).toFixed(1).padStart(4, '0')}`;
};

const syncButtons = (): void => {
  ui.play.classList.toggle('on', clock.playing);
  ui.play.textContent = clock.playing ? '❚❚ Pause' : '▶ Play';
  ui.vol.classList.toggle('on', volumetrics);
  ui.bloom.classList.toggle('on', bloomOn);
  ui.shadow.classList.toggle('on', shadowsOn);
  ui.lofi.classList.toggle('on', lofi);
  ui.strobe.classList.toggle('on', strobesOn);
  ui.strobeStatus.textContent = strobesOn ? 'on' : 'off';
  ui.count.querySelector('em')!.textContent = String(activeCount);
};

const applyShadows = (): void => {
  stage.setShadows(shadowsOn);
  renderer.shadowMap.enabled = shadowsOn;
  stage.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.material === undefined) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) material.needsUpdate = true;
  });
};

const setActiveCount = (count: number): void => {
  activeCount = count;
  stage.setActiveCount(count);
  syncButtons();
};

const togglePlay = (): void => {
  void clock.toggle().then(syncButtons);
};

ui.play.addEventListener('click', togglePlay);
ui.vol.addEventListener('click', () => {
  volumetrics = !volumetrics;
  syncButtons();
});
ui.bloom.addEventListener('click', () => {
  bloomOn = !bloomOn;
  post.setBloom(bloomOn);
  syncButtons();
});
ui.shadow.addEventListener('click', () => {
  shadowsOn = !shadowsOn;
  applyShadows();
  syncButtons();
});
ui.lofi.addEventListener('click', () => {
  lofi = !lofi;
  post.setLofi(lofi);
  syncButtons();
});
ui.strobe.addEventListener('click', () => {
  strobesOn = !strobesOn;
  syncButtons();
});
ui.view.addEventListener('click', () => stage.nextView());
ui.count.addEventListener('click', () => {
  countIndex = (countIndex + 1) % counts.length;
  setActiveCount(counts[countIndex] ?? show.fixtures.length);
});

window.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    event.preventDefault();
    togglePlay();
  } else if (event.key === '1') {
    volumetrics = !volumetrics;
  } else if (event.key === '2') {
    bloomOn = !bloomOn;
    post.setBloom(bloomOn);
  } else if (event.key === '3') {
    shadowsOn = !shadowsOn;
    applyShadows();
  } else if (event.key === '4') {
    lofi = !lofi;
    post.setLofi(lofi);
  } else if (event.key === '5') {
    strobesOn = !strobesOn;
  } else if (event.key === 'l' || event.key === 'L') {
    clock.setLoopEnabled(!clock.loopEnabled);
  } else if (event.key === 'c' || event.key === 'C') {
    stage.nextView();
  } else if (event.key === '[' || event.key === ']') {
    const step = event.key === ']' ? 1 : -1;
    countIndex = (countIndex + step + counts.length) % counts.length;
    setActiveCount(counts[countIndex] ?? show.fixtures.length);
  }
  syncButtons();
});

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  stage.camera.aspect = window.innerWidth / window.innerHeight;
  stage.camera.updateProjectionMatrix();
});

let resolutionScale = 1;
let smoothedFrameMs = 16.7;
let framesSinceAdjust = 0;
let lastFrame = performance.now();
let lastStats = 0;

const adjustResolution = (): void => {
  if (framesSinceAdjust < 45) return;
  framesSinceAdjust = 0;

  if (smoothedFrameMs > 20.5 && resolutionScale > 0.55) {
    resolutionScale = Math.max(0.55, resolutionScale - 0.08);
    renderer.setPixelRatio(baseRatio * resolutionScale);
    renderer.setSize(window.innerWidth, window.innerHeight);
  } else if (smoothedFrameMs < 13.2 && resolutionScale < 1) {
    resolutionScale = Math.min(1, resolutionScale + 0.05);
    renderer.setPixelRatio(baseRatio * resolutionScale);
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
};

const updateStats = (now: number, states: ReturnType<typeof evaluateFixtureStates>, songTime: number): void => {
  if (now - lastStats < 250) return;
  lastStats = now;

  const info = renderer.info.render;
  ui.fps.textContent = (1000 / smoothedFrameMs).toFixed(0);
  ui.ms.textContent = `${smoothedFrameMs.toFixed(1)} ms`;
  ui.calls.textContent = String(info.drawCalls);
  ui.tris.textContent = info.triangles.toLocaleString('en-US');
  ui.res.textContent = `${(resolutionScale * 100).toFixed(0)}%`;
  ui.latency.textContent = `${(clock.latencySec * 1000).toFixed(1)} ms`;

  const active = states.slice(0, activeCount).filter((state) => state.active).length;
  ui.fixtures.textContent = `${active} active / ${activeCount} shown`;

  const { beatsPerBar } = show.beatGrid;
  const beat = timeToBeat(show.beatGrid, showTime(songTime));
  const bar = Math.floor(beat / beatsPerBar) + 1;
  const beatInBar = Math.floor(((beat % beatsPerBar) + beatsPerBar) % beatsPerBar) + 1;
  ui.time.textContent = `${bar}.${beatInBar}`;
  ui.transportTime.textContent = `${formatClock(songTime)} / ${formatClock(clock.duration)}`;
};

const frame = (now: number): void => {
  const delta = now - lastFrame;
  lastFrame = now;
  smoothedFrameMs += (Math.min(delta, 100) - smoothedFrameMs) * 0.08;
  framesSinceAdjust += 1;

  const songTime = clock.time;
  const showAt = showTime(songTime);
  const states = evaluateFixtureStates(show, showAt).map((state) =>
    state.kind === 'strobe' && !strobesOn
      ? { ...state, intensity: 0, active: false, strobeHz: 0 }
      : state,
  );

  stage.update(states, showAt, { volumetrics });
  post.setTime(showAt);
  renderer.info.reset();
  post.render();

  waveform.render(songTime);
  adjustResolution();
  updateStats(now, states, songTime);

  requestAnimationFrame(frame);
};

ui.loading.textContent = 'loading audio…';

try {
  const response = await fetch(TRACK_URL);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const buffer = await clock.decode(await response.arrayBuffer());
  clock.load(buffer);
  clock.seek(loopStartSec);

  waveform.setTimeline({
    durationSec: buffer.duration,
    loopStartSec,
    loopEndSec,
    firstBeatSec: TRACK.firstBeatSec,
    bpm: TRACK.bpm,
    beatsPerBar: TRACK.beatsPerBar,
  });
  waveform.setPeaks(computePeaks(buffer, 1600));
  ui.transportTime.textContent = `${formatClock(loopStartSec)} / ${formatClock(buffer.duration)}`;
} catch (error) {
  console.error(error);
  ui.loading.textContent = `could not load ${TRACK.title}`;
  ui.loading.hidden = false;
  await new Promise((resolve) => setTimeout(resolve, 2500));
}

ui.loading.hidden = true;
syncButtons();
requestAnimationFrame(frame);
