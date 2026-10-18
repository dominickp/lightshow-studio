import * as THREE from 'three/webgpu';
import { evaluateFixtureStates, secondsPerBar } from '@dmxsim/show-model';
import { createDemoShow, DEMO_LOOP_SEC } from './demo-show';
import { LoopClock } from './clock';
import { Stage } from './stage';
import { Post } from './post';
const show = createDemoShow();
const counts = [10, 16, 22, 26, 32].filter((n) => n <= show.fixtures.length);
const container = document.getElementById('app');
if (container === null)
    throw new Error('missing #app element');
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
const clock = new LoopClock(DEMO_LOOP_SEC);
const barSec = secondsPerBar(show.beatGrid);
let volumetrics = true;
let bloomOn = true;
let shadowsOn = true;
let lofi = false;
let strobesOn = false;
let countIndex = counts.length - 1;
let activeCount = counts[countIndex] ?? show.fixtures.length;
stage.setActiveCount(activeCount);
const element = (id) => {
    const found = document.getElementById(id);
    if (found === null)
        throw new Error(`missing #${id}`);
    return found;
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
    play: element('btn-play'),
    vol: element('btn-vol'),
    bloom: element('btn-bloom'),
    shadow: element('btn-shadow'),
    lofi: element('btn-lofi'),
    strobe: element('btn-strobe'),
    strobeStatus: element('strobe-status'),
    view: element('btn-view'),
    count: element('btn-count'),
    loading: element('loading'),
};
const backend = renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
ui.backend.textContent = backend;
const syncButtons = () => {
    ui.play.classList.toggle('on', clock.playing);
    ui.vol.classList.toggle('on', volumetrics);
    ui.bloom.classList.toggle('on', bloomOn);
    ui.shadow.classList.toggle('on', shadowsOn);
    ui.lofi.classList.toggle('on', lofi);
    ui.strobe.classList.toggle('on', strobesOn);
    ui.strobeStatus.textContent = strobesOn ? 'on' : 'off';
    ui.count.querySelector('em').textContent = String(activeCount);
};
const applyShadows = () => {
    stage.setShadows(shadowsOn);
    renderer.shadowMap.enabled = shadowsOn;
    stage.scene.traverse((object) => {
        const mesh = object;
        if (mesh.material === undefined)
            return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials)
            material.needsUpdate = true;
    });
};
const setActiveCount = (count) => {
    activeCount = count;
    stage.setActiveCount(count);
    syncButtons();
};
ui.play.addEventListener('click', () => {
    clock.toggle();
    syncButtons();
});
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
        clock.toggle();
    }
    else if (event.key === '1') {
        volumetrics = !volumetrics;
    }
    else if (event.key === '2') {
        bloomOn = !bloomOn;
        post.setBloom(bloomOn);
    }
    else if (event.key === '3') {
        shadowsOn = !shadowsOn;
        applyShadows();
    }
    else if (event.key === '4') {
        lofi = !lofi;
        post.setLofi(lofi);
    }
    else if (event.key === '5') {
        strobesOn = !strobesOn;
    }
    else if (event.key === 'c' || event.key === 'C') {
        stage.nextView();
    }
    else if (event.key === '[' || event.key === ']') {
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
const adjustResolution = () => {
    if (framesSinceAdjust < 45)
        return;
    framesSinceAdjust = 0;
    if (smoothedFrameMs > 20.5 && resolutionScale > 0.55) {
        resolutionScale = Math.max(0.55, resolutionScale - 0.08);
        renderer.setPixelRatio(baseRatio * resolutionScale);
        renderer.setSize(window.innerWidth, window.innerHeight);
    }
    else if (smoothedFrameMs < 13.2 && resolutionScale < 1) {
        resolutionScale = Math.min(1, resolutionScale + 0.05);
        renderer.setPixelRatio(baseRatio * resolutionScale);
        renderer.setSize(window.innerWidth, window.innerHeight);
    }
};
const updateStats = (now, states) => {
    if (now - lastStats < 250)
        return;
    lastStats = now;
    const info = renderer.info.render;
    ui.fps.textContent = (1000 / smoothedFrameMs).toFixed(0);
    ui.ms.textContent = `${smoothedFrameMs.toFixed(1)} ms`;
    ui.calls.textContent = String(info.drawCalls);
    ui.tris.textContent = info.triangles.toLocaleString('en-US');
    ui.res.textContent = `${(resolutionScale * 100).toFixed(0)}%`;
    const active = states.slice(0, activeCount).filter((state) => state.active).length;
    ui.fixtures.textContent = `${active} active / ${activeCount} shown`;
    const t = clock.time;
    const bar = Math.floor(t / barSec) + 1;
    const beat = Math.floor((t % barSec) / (barSec / show.beatGrid.beatsPerBar)) + 1;
    ui.time.textContent = `${bar}.${beat} · ${t.toFixed(1)}s`;
};
const frame = (now) => {
    const delta = now - lastFrame;
    lastFrame = now;
    smoothedFrameMs += (Math.min(delta, 100) - smoothedFrameMs) * 0.08;
    framesSinceAdjust += 1;
    const time = clock.time;
    const states = evaluateFixtureStates(show, time).map((state) => state.kind === 'strobe' && !strobesOn
        ? { ...state, intensity: 0, active: false, strobeHz: 0 }
        : state);
    stage.update(states, time, { volumetrics });
    post.setTime(time);
    renderer.info.reset();
    post.render();
    adjustResolution();
    updateStats(now, states);
    requestAnimationFrame(frame);
};
ui.loading.hidden = true;
syncButtons();
requestAnimationFrame(frame);
//# sourceMappingURL=main.js.map