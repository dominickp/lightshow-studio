import type { FixtureProfile } from '@dmxsim/show-model';

/**
 * Seed fixture library. Values are plausible rather than manufacturer-exact;
 * these are the profiles the spike and Phase 1 authoring UI draw from.
 */

export const MOVING_HEAD: FixtureProfile = {
  id: 'generic-moving-head',
  name: 'Generic 16ch Moving Head',
  kind: 'moving-head',
  manufacturer: 'Generic',
  channels: [
    'pan',
    'panFine',
    'tilt',
    'tiltFine',
    'dimmer',
    'red',
    'green',
    'blue',
    'white',
    'zoom',
    'focus',
    'strobe',
    'gobo',
    'prism',
    'rotation',
    null,
  ],
  capabilities: {
    dimmer: true,
    color: 'rgbw',
    panTilt: true,
    zoom: true,
    focus: true,
    strobe: true,
    gobo: true,
    prism: true,
    rotation: true,
  },
  limits: {
    panDeg: [-270, 270],
    tiltDeg: [-135, 135],
    strobeHz: [1, 25],
  },
  beam: { spreadDeg: [6, 42], apertureDiameterM: 0.12, throwM: 14 },
};

export const WASH: FixtureProfile = {
  id: 'generic-wash',
  name: 'Generic 10ch Wash',
  kind: 'wash',
  manufacturer: 'Generic',
  channels: ['pan', 'panFine', 'tilt', 'tiltFine', 'dimmer', 'red', 'green', 'blue', 'zoom', 'strobe'],
  capabilities: {
    dimmer: true,
    color: 'rgb',
    panTilt: true,
    zoom: true,
    focus: false,
    strobe: true,
    gobo: false,
    prism: false,
    rotation: false,
  },
  limits: {
    panDeg: [-180, 180],
    tiltDeg: [-120, 120],
    strobeHz: [1, 20],
  },
  beam: { spreadDeg: [24, 78], apertureDiameterM: 0.28, throwM: 10 },
};

export const STROBE: FixtureProfile = {
  id: 'generic-strobe',
  name: 'Generic Strobe',
  kind: 'strobe',
  manufacturer: 'Generic',
  channels: ['dimmer', 'strobe', 'red', 'green', 'blue', 'white'],
  capabilities: {
    dimmer: true,
    color: 'rgbw',
    panTilt: false,
    zoom: false,
    focus: false,
    strobe: true,
    gobo: false,
    prism: false,
    rotation: false,
  },
  limits: {
    panDeg: [0, 0],
    tiltDeg: [0, 0],
    strobeHz: [1, 30],
  },
  beam: { spreadDeg: [110, 120], apertureDiameterM: 0.48, throwM: 7 },
};

export const LASER: FixtureProfile = {
  id: 'generic-laser',
  name: 'Generic RGB Laser',
  kind: 'laser',
  manufacturer: 'Generic',
  channels: ['dimmer', 'red', 'green', 'blue', 'pan', 'tilt', 'rotation'],
  capabilities: {
    dimmer: true,
    color: 'rgb',
    panTilt: true,
    zoom: false,
    focus: false,
    strobe: false,
    gobo: false,
    prism: false,
    rotation: true,
  },
  limits: {
    panDeg: [-40, 40],
    tiltDeg: [-30, 30],
    strobeHz: [1, 30],
  },
  beam: { spreadDeg: [0.6, 1.8], apertureDiameterM: 0.006, throwM: 24 },
  laser: {
    maxBeams: 32,
    patterns: ['fan', 'sweep', 'tunnel', 'wave', 'lattice', 'dots'],
    fanDeg: [0, 120],
  },
};

export const PAR: FixtureProfile = {
  id: 'generic-par',
  name: 'Generic PAR Can',
  kind: 'par',
  manufacturer: 'Generic',
  channels: ['dimmer', 'red', 'green', 'blue', 'white', 'zoom'],
  capabilities: {
    dimmer: true,
    color: 'rgbw',
    panTilt: false,
    zoom: true,
    focus: false,
    strobe: false,
    gobo: false,
    prism: false,
    rotation: false,
  },
  limits: {
    panDeg: [0, 0],
    tiltDeg: [0, 0],
    strobeHz: [1, 20],
  },
  beam: { spreadDeg: [14, 38], apertureDiameterM: 0.18, throwM: 9 },
};

export const BLINDER: FixtureProfile = {
  id: 'generic-blinder',
  name: 'Generic Blinder',
  kind: 'blinder',
  manufacturer: 'Generic',
  channels: ['dimmer', 'white'],
  capabilities: {
    dimmer: true,
    color: false,
    panTilt: false,
    zoom: false,
    focus: false,
    strobe: false,
    gobo: false,
    prism: false,
    rotation: false,
  },
  limits: {
    panDeg: [0, 0],
    tiltDeg: [0, 0],
    strobeHz: [1, 20],
  },
  beam: { spreadDeg: [90, 110], apertureDiameterM: 0.52, throwM: 8 },
};

export const LED_STRIP: FixtureProfile = {
  id: 'generic-led-strip',
  name: 'Generic LED Strip',
  kind: 'led-strip',
  manufacturer: 'Generic',
  channels: ['dimmer', 'red', 'green', 'blue', 'white', 'strobe'],
  capabilities: {
    dimmer: true,
    color: 'rgbw',
    panTilt: false,
    zoom: false,
    focus: false,
    strobe: true,
    gobo: false,
    prism: false,
    rotation: false,
  },
  limits: {
    panDeg: [0, 0],
    tiltDeg: [0, 0],
    strobeHz: [1, 25],
  },
  beam: { spreadDeg: [120, 160], apertureDiameterM: 0.9, throwM: 4 },
};

export const PROFILE_LIBRARY: Record<string, FixtureProfile> = {
  [MOVING_HEAD.id]: MOVING_HEAD,
  [WASH.id]: WASH,
  [STROBE.id]: STROBE,
  [LASER.id]: LASER,
  [PAR.id]: PAR,
  [BLINDER.id]: BLINDER,
  [LED_STRIP.id]: LED_STRIP,
};
