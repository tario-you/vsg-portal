const CATEGORY_STYLES = {
  spatial: { background: '#d4d4d4', text: '#1f2937', edge: '#9ca3af' },
  motion: { background: '#317ba6', text: '#f8fafc', edge: '#3b82f6' },
  functional: { background: '#153242', text: '#e2e8f0', edge: '#2563eb' },
  higher_order: { background: '#de4c64', text: '#0f172a', edge: '#ef4444' },
  social: { background: '#49cd98', text: '#0f172a', edge: '#10b981' },
  attentional: { background: '#f8d065', text: '#0f172a', edge: '#f59e0b' },
  default: { background: '#723bf3', text: '#f8fafc', edge: '#8b5cf6' },
};

const manifestUrl = '/public/manifest.json';

const KEY_BACKWARD = new Set(['arrowleft', 'a', 'j']);
const KEY_FORWARD = new Set(['arrowright', 'd', 'l']);
const CATEGORY_STORAGE_PREFIX = 'vsg-portal:categories:';

let urlSyncEnabled = false;
let suspendUrlSync = false;

const state = {
  manifest: null,
  videos: [],
  videoCache: new Map(),
  currentVideoId: null,
  currentVideoData: null,
  currentTime: 0,
  playing: false,
  speed: 0.0625,
  timer: null,
  enabledCategories: new Set(),
  network: null,
  nodesDataset: null,
  edgesDataset: null,
  edgeRelationMap: new Map(),
  relationEdgeMap: new Map(),
  suppressNetworkSelect: false,
  selectedRelationGroup: null,
  tableFocusPending: false,
  nodeCentroids: null,
  centroidFrameIndex: new Map(),
  imageSize: null,
  fallbackPositions: null,
  resizeHandler: null,
  baseFps: 24,
  lastFrameUrl: null,
  prefetch: { cache: new Map(), limit: 48 },
  renderStride: 6,
  lastRenderedFrame: null,
  debug: { enabled: false, overlay: null },
  selectedRelation: null,
  showDecisionColumns: false,
  mask: {
    enabled: false,
    store: new Map(),
    colorCache: new Map(),
    preferenceKey: 'vsg-portal:mask-enabled',
    lastRenderedFrame: null,
    previewVideoId: null,
    previewCanvas: null,
    previewContext: null,
    previewImageData: null,
    colorLookup: new Map(),
    objectLabelMap: new Map(),
    objectColorMap: new Map(),
    showAllLabels: false,
  },
};

function exposeStateForDebug() {
  try {
    if (typeof window !== 'undefined') {
      window.__VSG_STATE__ = state;
    }
  } catch (error) {
    console.debug('Unable to expose state globally:', error);
  }
}

exposeStateForDebug();

const dom = {
  videoSelect: document.getElementById('video-select'),
  prevVideo: document.getElementById('prev-video'),
  nextVideo: document.getElementById('next-video'),
  timeSlider: document.getElementById('time-slider'),
  timeValue: document.getElementById('time-value'),
  playToggle: document.getElementById('play-toggle'),
  stepBack: document.getElementById('step-back'),
  stepForward: document.getElementById('step-forward'),
  speedSelect: document.getElementById('speed-select'),
  renderRate: document.getElementById('render-rate'),
  videoCount: document.getElementById('video-count'),
  frameDisplay: document.getElementById('frame-display'),
  frameImage: document.getElementById('frame-image'),
  frameImageA: document.getElementById('frame-image-a'),
  frameImageB: document.getElementById('frame-image-b'),
  maskToggle: document.getElementById('mask-toggle'),
  maskLabelsToggle: document.getElementById('mask-labels-toggle'),
  maskCanvas: document.getElementById('frame-mask'),
  maskPreview: document.getElementById('mask-preview'),
  maskLabelsLayer: document.getElementById('mask-labels-layer'),
  network: document.getElementById('network'),
  frameViewport: document.querySelector('.frame-viewport'),
  maskPanel: document.getElementById('mask-panel'),
  maskObjectList: document.getElementById('mask-object-list'),
  maskTooltip: document.getElementById('mask-tooltip'),
  videoTitle: document.getElementById('video-title'),
  videoDescription: document.getElementById('video-description'),
  frameTemplate: document.getElementById('frame-template'),
  downloadJson: document.getElementById('download-json'),
  metaFrames: document.getElementById('meta-frames'),
  metaFps: document.getElementById('meta-fps'),
  categoryFilters: document.getElementById('category-filters'),
  activeRelations: document.getElementById('active-relations'),
  relationDetailsPanel: document.getElementById('relation-details-panel'),
  relationDetailsStatus: document.getElementById('relation-details-status'),
  relationDetailsTableWrapper: document.getElementById('relation-details-table-wrapper'),
  relationDetailsTable: document.getElementById('relation-details-table'),
  relationDetailsTableBody: document.getElementById('relation-details-tbody'),
  decisionColumnsToggle: document.getElementById('decision-columns-toggle'),
  decisionColumnsToggleContainer: document.querySelector('.decision-controls'),
};

function setViewportBackground(url) {
  const viewport = dom.frameViewport;
  if (!viewport) return;
  if (url) {
    if (viewport.dataset.background === url) return;
    const safeUrl = String(url).replace(/[")\\]/g, '\\$&');
    viewport.style.backgroundImage = `url("${safeUrl}")`;
    viewport.style.backgroundSize = 'contain';
    viewport.style.backgroundRepeat = 'no-repeat';
    viewport.style.backgroundPosition = 'center';
    viewport.dataset.background = url;
  } else {
    viewport.style.backgroundImage = 'none';
    delete viewport.dataset.background;
  }
}

if (dom.maskPreview) {
  dom.maskPreview.addEventListener('load', () => {
    dom.maskPreview.dataset.loaded = 'true';
    if (dom.frameViewport && state.mask.enabled && dom.maskPreview.dataset.videoId === state.mask.previewVideoId) {
      dom.frameViewport.classList.add('mask-preview-active');
    }
    prepareMaskLegend();
    if (state.mask.showAllLabels) {
      updateMaskLabelsOverlay();
    }
  });
  dom.maskPreview.addEventListener('error', () => {
    dom.maskPreview.dataset.loaded = 'false';
    if (dom.maskPreview.dataset.videoId === state.mask.previewVideoId) {
      console.warn(`Mask preview failed to load for ${state.mask.previewVideoId}`);
      hideMaskPreview();
    }
  });
  dom.maskPreview.addEventListener('mousemove', handleMaskPreviewPointerMove, { passive: true });
  dom.maskPreview.addEventListener('mouseleave', () => {
    hideMaskTooltip();
  });
}

window.addEventListener('resize', () => {
  if (state.mask.showAllLabels) {
    updateMaskLabelsOverlay();
  }
});

if (dom.maskLabelsToggle) {
  dom.maskLabelsToggle.checked = state.mask.showAllLabels;
  dom.maskLabelsToggle.disabled = !state.mask.enabled;
  if (state.mask.enabled) {
    dom.maskLabelsToggle.removeAttribute('disabled');
  } else {
    dom.maskLabelsToggle.setAttribute('disabled', '');
  }
  dom.maskLabelsToggle.addEventListener('change', (event) => {
    const target = event.target;
    const desired = Boolean(target?.checked);
    setMaskLabelsVisible(desired);
  });
}

if (dom.decisionColumnsToggle) {
  dom.decisionColumnsToggle.checked = state.showDecisionColumns;
  dom.decisionColumnsToggle.addEventListener('change', (event) => {
    const target = event.target;
    state.showDecisionColumns = Boolean(target?.checked);
    renderRelationDetails();
  });
}

function detectDebugMode() {
  if (typeof window === 'undefined') return false;
  try {
    if (window.__VSG_DEBUG__ === true) return true;
  } catch (error) {
    console.debug('Debug flag inspection failed:', error);
  }
  try {
    const params = new URLSearchParams(window.location.search || '');
    if (params.has('debug')) {
      const value = params.get('debug');
      if (value === null || value === '' || value === '1' || value.toLowerCase() === 'true') {
        return true;
      }
      if (value.toLowerCase() === '0' || value.toLowerCase() === 'false') {
        return false;
      }
    }
  } catch (error) {
    console.debug('URLSearchParams unavailable for debug detect:', error);
  }
  try {
    const stored = window.localStorage?.getItem('vsg-debug');
    if (stored === '1') return true;
  } catch (error) {
    console.debug('LocalStorage debug read failed:', error);
  }
  return false;
}

function ensureDebugOverlay() {
  if (!state.debug.enabled || state.debug.overlay) return;
  const el = document.createElement('div');
  el.id = 'vsg-debug-overlay';
  el.style.position = 'fixed';
  el.style.bottom = '12px';
  el.style.right = '12px';
  el.style.maxWidth = '360px';
  el.style.fontFamily = "'JetBrains Mono', 'Roboto Mono', monospace";
  el.style.fontSize = '11px';
  el.style.lineHeight = '1.4';
  el.style.color = '#f8fafc';
  el.style.background = 'rgba(15, 23, 42, 0.82)';
  el.style.border = '1px solid rgba(148, 163, 184, 0.45)';
  el.style.borderRadius = '8px';
  el.style.padding = '8px 10px';
  el.style.pointerEvents = 'none';
  el.style.zIndex = '9999';
  el.style.whiteSpace = 'pre-wrap';
  el.style.backdropFilter = 'blur(6px)';
  document.body.appendChild(el);
  state.debug.overlay = el;
}

function formatDebugNumber(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function renderDebugOverlay(info) {
  if (!state.debug.enabled) return;
  ensureDebugOverlay();
  const el = state.debug.overlay;
  if (!el) return;

  const summary = [
    `frame: ${info.frame}`,
    `container: ${formatDebugNumber(info.containerWidth, 0)}×${formatDebugNumber(info.containerHeight, 0)} | img: ${formatDebugNumber(info.imgWidth, 0)}×${formatDebugNumber(info.imgHeight, 0)}`,
    `scale: ${formatDebugNumber(info.scale, 3)} offset: (${formatDebugNumber(info.offsetX, 1)}, ${formatDebugNumber(info.offsetY, 1)}) origin: (${formatDebugNumber(info.originX, 1)}, ${formatDebugNumber(info.originY, 1)}) centroids: ${info.centroidEnabled ? 'enabled' : 'fallback only'}`,
    `active: ${info.counts.active} | centroid: ${info.counts.centroid} | fallback: ${info.counts.fallback} | hidden: ${info.counts.hidden} | inactive: ${info.counts.inactive}`,
  ];

  if (info.bounds) {
    summary.push(
      `bounds: x[${formatDebugNumber(info.bounds.minX, 1)}, ${formatDebugNumber(info.bounds.maxX, 1)}] y[${formatDebugNumber(info.bounds.minY, 1)}, ${formatDebugNumber(info.bounds.maxY, 1)}]`
    );
  }

  if (info.samples && info.samples.length) {
    summary.push('samples:');
    info.samples.forEach((sample) => {
      summary.push(
        `  ${sample.id} → src=${sample.source} frame=${sample.frame} world=(${formatDebugNumber(sample.worldX, 1)}, ${formatDebugNumber(sample.worldY, 1)}) local=(${formatDebugNumber(sample.localX, 1)}, ${formatDebugNumber(sample.localY, 1)}) screen=(${formatDebugNumber(sample.screenX, 1)}, ${formatDebugNumber(sample.screenY, 1)})`
      );
    });
  } else {
    summary.push('samples: none (enable relations or check centroids)');
  }

  summary.push('— debug mode is active (toggle with ?debug=0)');
  el.textContent = summary.join('\n');

  try {
    window.__VSG_LAST_DEBUG__ = info;
  } catch (error) {
    console.debug('Unable to expose debug info globally:', error);
  }
}

function configureDebugMode() {
  const enabled = detectDebugMode();
  state.debug.enabled = enabled;
  if (enabled) {
    ensureDebugOverlay();
    console.info('VSG debug mode enabled. Append ?debug=0 to the URL to disable.');
  }
}

const MASK_ALPHA = 118;

function hslToRgb(h, s, l) {
  const hueToRgb = (p, q, t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };

  let r;
  let g;
  let b;

  if (s <= 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hueToRgb(p, q, h + 1 / 3);
    g = hueToRgb(p, q, h);
    b = hueToRgb(p, q, h - 1 / 3);
  }

  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

function maskColorForIndex(index) {
  const cache = state.mask?.colorCache;
  if (cache && cache.has(index)) {
    return cache.get(index);
  }

  const hue = ((index * 47) % 360) / 360;
  const tier = Math.floor(index / 12);
  const saturation = Math.max(0.55, 0.75 - tier * 0.04);
  const lightness = Math.max(0.38, 0.62 - tier * 0.05);
  const rgb = hslToRgb(hue, saturation, lightness);
  const color = { r: rgb.r, g: rgb.g, b: rgb.b, a: MASK_ALPHA };
  if (cache) {
    cache.set(index, color);
  }
  return color;
}

function hsvToRgb(h, s, v) {
  const hh = (h % 1 + 1) % 1;
  const i = Math.floor(hh * 6);
  const f = hh * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r;
  let g;
  let b;
  switch (i % 6) {
    case 0:
      r = v;
      g = t;
      b = p;
      break;
    case 1:
      r = q;
      g = v;
      b = p;
      break;
    case 2:
      r = p;
      g = v;
      b = t;
      break;
    case 3:
      r = p;
      g = q;
      b = v;
      break;
    case 4:
      r = t;
      g = p;
      b = v;
      break;
    default:
      r = v;
      g = p;
      b = q;
      break;
  }
  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

function generatePreviewPalette(count, alpha = 255) {
  const colours = [];
  if (!Number.isFinite(count) || count <= 0) {
    return colours;
  }
  for (let i = 0; i < count; i += 1) {
    const h = (i / Math.max(1, count)) % 1;
    const rgb = hsvToRgb(h, 0.75, 0.95);
    const colour = createColorStruct(rgb.r, rgb.g, rgb.b, alpha);
    colours.push(colour);
  }
  return colours;
}

const scheduleMicrotask = typeof queueMicrotask === 'function'
  ? (callback) => queueMicrotask(callback)
  : (callback) => Promise.resolve().then(callback).catch(() => {});

function persistMaskPreference(enabled) {
  if (typeof window === 'undefined') return;
  const key = state.mask?.preferenceKey;
  if (!key) return;
  try {
    window.localStorage?.setItem(key, enabled ? '1' : '0');
  } catch (error) {
    console.debug('Unable to persist mask preference:', error);
  }
}

function restoreMaskPreference() {
  if (typeof window === 'undefined') return false;
  const key = state.mask?.preferenceKey;
  if (!key) return false;
  try {
    const stored = window.localStorage?.getItem(key);
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch (error) {
    console.debug('Unable to restore mask preference:', error);
  }
  return false;
}

function canonicalCategory(value) {
  if (!value) return 'default';
  return String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function normaliseRelationType(value) {
  if (value === null || value === undefined) return 'default';
  const str = String(value).trim();
  return str || 'default';
}

function makeRelationFingerprint(subjectId, objectId, predicate, relationType) {
  const subj = subjectId === null || subjectId === undefined ? '' : String(subjectId).trim();
  const obj = objectId === null || objectId === undefined ? '' : String(objectId).trim();
  const pred = predicate === null || predicate === undefined ? '' : String(predicate).trim();
  const type = relationType === null || relationType === undefined ? '' : String(relationType).trim();
  return `${subj}→${obj}∣${pred}∣${type}`;
}

function createRelationUid(index, subjectId, objectId, predicate, relationType) {
  return `rel-${index}`;
}

function debugRelationEvent(event, payload) {
  try {
    console.debug(`[RelationDebug] ${event}`, payload);
  } catch (error) {
    // Ignore logging failures
  }
}

function detectFilteredRun(manifestEntry, rawData) {
  const relationsUrl = manifestEntry?.relations_url;
  const modelSlug = manifestEntry?.model_slug;
  const modelId = manifestEntry?.model_id;
  const strings = [relationsUrl, modelSlug, modelId].filter((value) => typeof value === 'string');
  const lowered = strings.map((value) => value.toLowerCase());
  const hasMetadata =
    Array.isArray(rawData?.relationship_filter_metadata) && rawData.relationship_filter_metadata.length > 0;
  if (!hasMetadata) {
    return {
      enabled: false,
      includeDropped: false,
      datasetKind: null,
    };
  }

  const includesFilteredToken = lowered.some((value) =>
    ['filtered', 'new-sav', 'flipped', 'dropped', 'drop'].some((token) => value.includes(token))
  );

  if (!includesFilteredToken) {
    return {
      enabled: false,
      includeDropped: false,
      datasetKind: null,
    };
  }

  const includesDropped = lowered.some((value) =>
    ['dropped', 'dropnontrivial', 'drop_only', 'drop-only', 'drop'].some((token) => value.includes(token))
  );
  const includesFlipped = lowered.some((value) => value.includes('flipped'));
  const includesFiltered = lowered.some((value) => value.includes('filtered'));

  let datasetKind = null;
  if (includesDropped) {
    datasetKind = 'dropped';
  } else if (includesFlipped) {
    datasetKind = 'flipped';
  } else if (includesFiltered) {
    datasetKind = 'filtered';
  } else {
    datasetKind = 'enriched';
  }

  return {
    enabled: true,
    includeDropped: includesDropped,
    datasetKind,
  };
}

function getCategoryStorageKey(videoId) {
  if (!videoId) return null;
  return `${CATEGORY_STORAGE_PREFIX}${videoId}`;
}

function restoreCategorySelection(videoId, availableCategories) {
  const available = Array.isArray(availableCategories)
    ? availableCategories
    : Array.from(availableCategories || []);
  const availableSet = new Set(available);
  const fallback = new Set(available);
  const key = getCategoryStorageKey(videoId);
  if (!key || typeof window === 'undefined') {
    return fallback;
  }

  try {
    const stored = window.localStorage?.getItem(key);
    if (!stored) {
      return fallback;
    }
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        return new Set();
      }
      const valid = parsed.filter((cat) => availableSet.has(cat));
      if (valid.length) {
        return new Set(valid);
      }
    }
  } catch (error) {
    console.debug('Unable to restore category selection:', error);
  }

  return fallback;
}

function persistCategorySelection(videoId, categories) {
  const key = getCategoryStorageKey(videoId);
  if (!key || typeof window === 'undefined') {
    return;
  }
  try {
    const payload = JSON.stringify(Array.from(categories));
    window.localStorage?.setItem(key, payload);
  } catch (error) {
    console.debug('Unable to persist category selection:', error);
  }
}

function canonicaliseCategorySet(selection) {
  if (!selection) return new Set();
  if (selection instanceof Set) {
    const next = new Set();
    selection.forEach((value) => {
      const canon = canonicalCategory(value);
      if (canon) next.add(canon);
    });
    return next;
  }
  if (Array.isArray(selection)) {
    return canonicaliseCategorySet(new Set(selection));
  }
  return new Set();
}

function normaliseCategorySelection(selection, availableCategories) {
  const available = Array.isArray(availableCategories) ? availableCategories : Array.from(availableCategories || []);
  const availableSet = new Set(available.map((value) => canonicalCategory(value)));
  const desired = canonicaliseCategorySet(selection);
  if (!desired.size) {
    return new Set();
  }
  const filtered = new Set();
  desired.forEach((cat) => {
    if (availableSet.has(cat)) {
      filtered.add(cat);
    }
  });
  return filtered;
}

function parseCategoryListParam(value) {
  if (value === undefined) return undefined;
  if (value === null) return undefined;
  if (value === '') return new Set();
  const parts = String(value)
    .split(',')
    .map((part) => canonicalCategory(part))
    .filter(Boolean);
  return new Set(parts);
}

function deriveCategorySelectionFromFilter(availableCategories, filter) {
  if (!filter || typeof filter !== 'object') return undefined;
  const available = Array.isArray(availableCategories) ? availableCategories : Array.from(availableCategories || []);
  const availableSet = new Set(available.map((value) => canonicalCategory(value)));

  if (Object.prototype.hasOwnProperty.call(filter, 'visible') && filter.visible !== undefined) {
    const requested = canonicaliseCategorySet(filter.visible);
    if (requested.size === 0) {
      return new Set();
    }
    const resolved = new Set();
    requested.forEach((cat) => {
      if (availableSet.has(cat)) {
        resolved.add(cat);
      }
    });
    return resolved;
  }

  if (Object.prototype.hasOwnProperty.call(filter, 'hidden') && filter.hidden !== undefined) {
    const hidden = canonicaliseCategorySet(filter.hidden);
    const resolved = new Set();
    available.forEach((cat) => {
      const canonical = canonicalCategory(cat);
      if (!hidden.has(canonical)) {
        resolved.add(canonical);
      }
    });
    return resolved;
  }

  return undefined;
}

function getCurrentStride() {
  const parsed = Number(state.renderStride);
  const valid = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
  return valid || 1;
}

function shouldRenderFrame(time) {
  const stride = getCurrentStride();
  if (!state.playing) return true;
  if (stride <= 1) return true;
  return (time % stride) === 0;
}

function getRenderFrame(time) {
  const stride = getCurrentStride();
  if (stride <= 1) return Math.round(time);
  return Math.floor(time / stride) * stride;
}

function snapToStride(time, upperBound = Infinity) {
  const stride = getCurrentStride();
  const bound = Number.isFinite(upperBound) ? upperBound : Infinity;
  const limited = Math.max(0, Math.min(time, bound));
  if (stride <= 1) {
    return Math.round(limited);
  }
  const snapped = Math.floor(limited / stride) * stride;
  if (!Number.isFinite(bound)) {
    return snapped;
  }
  if (snapped <= bound) {
    return snapped;
  }
  const fallback = Math.floor(bound / stride) * stride;
  return Math.max(0, fallback);
}

function updateTimeSliderStep() {
  if (!dom.timeSlider) return;
  const step = getCurrentStride();
  dom.timeSlider.step = step.toString();
}

function syncUrl(replace = true) {
  if (suspendUrlSync || !urlSyncEnabled) return;
  if (typeof window === 'undefined') return;

  let path = '/';
  const videoId = state.currentVideoId;
  if (videoId) {
    path = `/v/${encodeURIComponent(videoId)}`;
    const frame = Number.isFinite(state.currentTime) ? Math.max(0, Math.round(state.currentTime)) : null;
    if (frame !== null) {
      path += `/f/${padFrame(frame)}`;
    }
  }

  const params = new URLSearchParams();
  if (Number.isFinite(state.speed) && state.speed > 0) {
    params.set('speed', state.speed.toString());
  }
  if (Number.isFinite(state.renderStride) && state.renderStride > 0) {
    params.set('stride', state.renderStride.toString());
  }
  if (Number.isFinite(state.baseFps) && state.baseFps > 0) {
    params.set('fps', state.baseFps.toString());
  }

  if (state.currentVideoData && Array.isArray(state.currentVideoData.categories)) {
    const categories = state.currentVideoData.categories.map((cat) => canonicalCategory(cat));
    if (categories.length) {
      const visible = categories.filter((cat) => state.enabledCategories.has(cat));
      const hidden = categories.filter((cat) => !state.enabledCategories.has(cat));
      params.set('visible', visible.join(','));
      params.set('hidden', hidden.join(','));
    }
  }

  const query = params.toString();
  const url = query ? `${path}?${query}` : path;
  const method = replace ? 'replaceState' : 'pushState';
  if (typeof window.history?.[method] === 'function') {
    window.history[method]({}, '', url);
  }
}

function formatCategoryLabel(cat) {
  return cat.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function padFrame(frame) {
  return frame.toString().padStart(4, '0');
}

function parseRouteFromLocation() {
  if (typeof window === 'undefined') {
    return {
      videoId: null,
      frame: null,
      speed: undefined,
      stride: undefined,
      baseFps: undefined,
      categoryFilter: undefined,
    };
  }

  const { pathname, search } = window.location;
  const segments = pathname ? pathname.split('/').filter(Boolean) : [];
  let videoId = null;
  let frame = null;

  if (segments.length >= 2 && segments[0].toLowerCase() === 'v') {
    videoId = decodeURIComponent(segments[1]);
    if (segments.length >= 4 && segments[2].toLowerCase() === 'f') {
      const parsedFrame = parseInt(segments[3], 10);
      if (Number.isFinite(parsedFrame) && parsedFrame >= 0) {
        frame = parsedFrame;
      }
    }
  }

  const params = new URLSearchParams(search || '');
  const speedParam = params.has('speed') ? parseFloat(params.get('speed')) : undefined;
  const strideParam = params.has('stride') ? parseInt(params.get('stride'), 10) : undefined;
  const fpsParam = params.has('fps') ? parseFloat(params.get('fps')) : undefined;

  const categoryFilter = {};
  if (params.has('visible')) {
    categoryFilter.visible = parseCategoryListParam(params.get('visible'));
  }
  if (params.has('hidden')) {
    categoryFilter.hidden = parseCategoryListParam(params.get('hidden'));
  }

  const hasCategoryFilter =
    Object.prototype.hasOwnProperty.call(categoryFilter, 'visible') ||
    Object.prototype.hasOwnProperty.call(categoryFilter, 'hidden');

  return {
    videoId,
    frame,
    speed: Number.isFinite(speedParam) && speedParam > 0 ? speedParam : undefined,
    stride: Number.isFinite(strideParam) && strideParam >= 1 ? strideParam : undefined,
    baseFps: Number.isFinite(fpsParam) && fpsParam > 0 ? fpsParam : undefined,
    categoryFilter: hasCategoryFilter ? categoryFilter : undefined,
  };
}

async function applyRoute(route, options = {}) {
  if (!state.videos.length) return;

  const suppressHistory = options.suppressHistory ?? true;
  const availableIds = new Set(state.videos.map((entry) => entry.video_id));
  const fallbackVideo = state.videos[0]?.video_id || null;
  const targetVideoId = route.videoId && availableIds.has(route.videoId) ? route.videoId : fallbackVideo;
  if (!targetVideoId) return;

  const initialFrame = Number.isFinite(route.frame) && route.frame >= 0 ? route.frame : 0;

  const previousSuspend = suspendUrlSync;
  suspendUrlSync = true;
  try {
    if (state.currentVideoId !== targetVideoId) {
      await loadVideo(targetVideoId, {
        categoryFilter: route.categoryFilter,
        initialFrame,
        suppressUrlSync: true,
      });
    } else {
      if (route.categoryFilter && state.currentVideoData) {
        const derived = deriveCategorySelectionFromFilter(state.currentVideoData.categories, route.categoryFilter);
        if (derived !== undefined) {
          state.enabledCategories = derived;
          persistCategorySelection(state.currentVideoId, state.enabledCategories);
          updateCategoryFilters(state.currentVideoData.categories);
          updateNetwork();
          renderActiveRelations();
        }
      }
      if (Number.isFinite(route.frame) && route.frame >= 0) {
        setCurrentTime(route.frame);
      }
    }

    if (Number.isFinite(route.speed) && route.speed > 0) {
      setPlaybackSpeed(route.speed, { updateSelect: true, restartTimer: state.playing, sync: false });
    }
    if (Number.isFinite(route.stride) && route.stride >= 1) {
      setRenderStride(route.stride, { updateSelect: true, sync: false });
    }
  } finally {
    suspendUrlSync = previousSuspend;
  }

  if (!suppressHistory) {
    syncUrl(false);
  } else if (urlSyncEnabled) {
    syncUrl(true);
  }
}

function formatFrameUrl(template, frame) {
  if (!template) return '—';
  const frameValue = frame + 1; // assets are 1-indexed
  if (template.includes('{frame:04d}')) {
    return template.replace('{frame:04d}', padFrame(frameValue));
  }
  if (template.includes('{frame}')) {
    return template.replace('{frame}', frameValue.toString());
  }
  return template;
}

function parseFpsLabel(label, fallback = 24) {
  if (!label) return fallback;
  const str = String(label).trim();
  if (!str) return fallback;
  if (str.includes('/')) {
    const [num, denom] = str.split('/').map(Number);
    const value = Number.isFinite(num) && Number.isFinite(denom) && denom !== 0 ? num / denom : null;
    if (value && value > 0) return value;
  }
  const value = Number(str);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return fallback;
}

function extractObjectLabels(rawData, metadata) {
  const labels = new Map();

  const register = (idValue, labelValue) => {
    if (idValue === null || idValue === undefined) return;
    if (labelValue === null || labelValue === undefined) return;
    const id = String(idValue).trim();
    if (!id) return;
    const label = String(labelValue).trim();
    if (!label) return;
    if (!labels.has(id)) {
      labels.set(id, label);
    }
  };

  const consumeArray = (entries) => {
    if (!Array.isArray(entries)) return;
    entries.forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      const id = entry.object_id ?? entry.id;
      const label = entry.category ?? entry.label ?? entry.name;
      register(id, label);
    });
  };

  const consumeObjectMap = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    Object.entries(obj).forEach(([id, label]) => register(id, label));
  };

  if (rawData) {
    consumeArray(rawData.objects);
    consumeObjectMap(rawData.object_labels);
  }

  if (metadata) {
    consumeArray(metadata.objects);
    consumeObjectMap(metadata.object_labels);
  }

  return labels;
}

function normaliseCentroidPayload(payload, nodes) {
  if (!payload || typeof payload !== 'object') {
    return { centroids: null, imageWidth: null, imageHeight: null, maxFrame: null };
  }

  const nodeIdSet = new Set(nodes.map((node) => String(node.id)));
  const rawCentroids = payload.centroids;
  if (!rawCentroids || (typeof rawCentroids !== 'object' && !Array.isArray(rawCentroids))) {
    return { centroids: null, imageWidth: null, imageHeight: null, maxFrame: null };
  }

  const centroidMap = new Map();
  let maxFrame = -Infinity;
  let maxObservedX = -Infinity;
  let maxObservedY = -Infinity;
  let minObservedX = Infinity;
  let minObservedY = Infinity;
  let pointCount = 0;

  const registerPoint = (perFrame, frameKey, coordsLike) => {
    const frame = Number(frameKey);
    if (!Number.isFinite(frame) || frame < 0) return;

    let x = null;
    let y = null;

    if (Array.isArray(coordsLike)) {
      if (coordsLike.length >= 2) {
        x = Number(coordsLike[0]);
        y = Number(coordsLike[1]);
      }
    } else if (coordsLike && typeof coordsLike === 'object') {
      const candidateX = coordsLike.x ?? coordsLike.X ?? coordsLike[0];
      const candidateY = coordsLike.y ?? coordsLike.Y ?? coordsLike[1];
      x = Number(candidateX);
      y = Number(candidateY);
    }

    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    perFrame.set(frame, { x, y });
    if (frame > maxFrame) maxFrame = frame;
    if (x > maxObservedX) maxObservedX = x;
    if (y > maxObservedY) maxObservedY = y;
    if (x < minObservedX) minObservedX = x;
    if (y < minObservedY) minObservedY = y;
    pointCount += 1;
  };

  const ingestFrames = (perFrame, frames) => {
    if (!frames) return;
    if (Array.isArray(frames)) {
      frames.forEach((entry) => {
        if (Array.isArray(entry)) {
          if (entry.length >= 3) {
            registerPoint(perFrame, entry[0], [entry[1], entry[2]]);
          } else if (entry.length >= 2 && typeof entry[1] === 'object') {
            registerPoint(perFrame, entry[0], entry[1]);
          }
        } else if (entry && typeof entry === 'object') {
          const frameKey = entry.frame ?? entry.frame_index ?? entry.index ?? entry.time ?? entry.t ?? entry.f;
          if (frameKey != null) {
            registerPoint(perFrame, frameKey, entry);
          }
        }
      });
    } else if (typeof frames === 'object') {
      Object.entries(frames).forEach(([frameKey, coords]) => {
        registerPoint(perFrame, frameKey, coords);
      });
    }
  };

  const processNodeFrames = (nodeId, frames) => {
    const id = String(nodeId);
    if (!nodeIdSet.has(id)) return;

    const perFrame = new Map();
    ingestFrames(perFrame, frames);

    if (perFrame.size > 0) {
      centroidMap.set(id, perFrame);
    }
  };

  if (Array.isArray(rawCentroids)) {
    rawCentroids.forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      const nodeId = entry.node_id ?? entry.nodeId ?? entry.id ?? entry.object_id ?? entry.objectId ?? entry.key ?? null;
      if (nodeId == null) return;
      const frames =
        entry.frames ??
        entry.centroids ??
        entry.positions ??
        entry.points ??
        entry.coords ??
        entry.coordinates ??
        entry.values ??
        entry.data ??
        null;
      if (!frames) return;
      processNodeFrames(nodeId, frames);
    });
  } else {
    Object.entries(rawCentroids).forEach(([objectId, frames]) => {
      processNodeFrames(objectId, frames);
    });
  }

  const payloadMaxFrame = Number(payload.max_frame ?? payload.maxFrame);
  if (Number.isFinite(payloadMaxFrame) && payloadMaxFrame >= 0) {
    maxFrame = Math.max(maxFrame, payloadMaxFrame);
  }

  const imageWidthRaw = Number(payload.image_width ?? payload.imageWidth);
  const imageHeightRaw = Number(payload.image_height ?? payload.imageHeight);
  const hasImageWidth = Number.isFinite(imageWidthRaw) && imageWidthRaw > 0;
  const hasImageHeight = Number.isFinite(imageHeightRaw) && imageHeightRaw > 0;
  let imageWidth = hasImageWidth ? imageWidthRaw : null;
  let imageHeight = hasImageHeight ? imageHeightRaw : null;
  let originX = 0;
  let originY = 0;

  const looksFractional =
    pointCount > 0 &&
    minObservedX >= -0.01 &&
    minObservedY >= -0.01 &&
    maxObservedX <= 1.01 &&
    maxObservedY <= 1.01;

  const looksPercentage =
    !looksFractional &&
    pointCount > 0 &&
    minObservedX >= -0.5 &&
    minObservedY >= -0.5 &&
    maxObservedX <= 100.5 &&
    maxObservedY <= 100.5 &&
    Number.isFinite(imageWidthRaw) && imageWidthRaw > 200 &&
    Number.isFinite(imageHeightRaw) && imageHeightRaw > 200;

  const scaleCentroids = (scaleX, scaleY) => {
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return;
    centroidMap.forEach((frames) => {
      frames.forEach((point) => {
        point.x *= scaleX;
        point.y *= scaleY;
      });
    });
  };

  if (centroidMap.size > 0) {
    const validWidth = Number.isFinite(imageWidthRaw) && imageWidthRaw > 0;
    const validHeight = Number.isFinite(imageHeightRaw) && imageHeightRaw > 0;
    if (looksFractional && validWidth && validHeight) {
      scaleCentroids(imageWidthRaw, imageHeightRaw);
    } else if (looksPercentage && validWidth && validHeight) {
      scaleCentroids(imageWidthRaw / 100, imageHeightRaw / 100);
    }

    if (looksFractional) {
      if (!Number.isFinite(imageWidth) || imageWidth <= 0) imageWidth = validWidth ? imageWidthRaw : 1;
      if (!Number.isFinite(imageHeight) || imageHeight <= 0) imageHeight = validHeight ? imageHeightRaw : 1;
    } else if (looksPercentage) {
      if (!Number.isFinite(imageWidth) || imageWidth <= 0) imageWidth = validWidth ? imageWidthRaw : 100;
      if (!Number.isFinite(imageHeight) || imageHeight <= 0) imageHeight = validHeight ? imageHeightRaw : 100;
    }

    if ((!Number.isFinite(imageWidth) || imageWidth <= 0) && Number.isFinite(minObservedX) && Number.isFinite(maxObservedX)) {
      const spanX = maxObservedX - minObservedX;
      if (Number.isFinite(spanX) && spanX > 0) {
        originX = minObservedX;
        imageWidth = spanX;
      }
    }
    if ((!Number.isFinite(imageHeight) || imageHeight <= 0) && Number.isFinite(minObservedY) && Number.isFinite(maxObservedY)) {
      const spanY = maxObservedY - minObservedY;
      if (Number.isFinite(spanY) && spanY > 0) {
        originY = minObservedY;
        imageHeight = spanY;
      }
    }
  }

  const bounds =
    pointCount > 0 &&
    Number.isFinite(minObservedX) &&
    Number.isFinite(maxObservedX) &&
    Number.isFinite(minObservedY) &&
    Number.isFinite(maxObservedY)
      ? { minX: minObservedX, maxX: maxObservedX, minY: minObservedY, maxY: maxObservedY }
      : null;

  return {
    centroids: centroidMap.size ? centroidMap : null,
    imageWidth: Number.isFinite(imageWidth) && imageWidth > 0 ? imageWidth : null,
    imageHeight: Number.isFinite(imageHeight) && imageHeight > 0 ? imageHeight : null,
    originX: Number.isFinite(originX) ? originX : 0,
    originY: Number.isFinite(originY) ? originY : 0,
    bounds,
    maxFrame: Number.isFinite(maxFrame) && maxFrame >= 0 ? maxFrame : null,
  };
}

function computeCircularLayout(nodes, container) {
  const fallback = new Map();
  if (!container) return fallback;

  const width = Math.max(container.clientWidth, 1);
  const height = Math.max(container.clientHeight, 1);
  const total = Math.max(nodes.length, 1);
  const radius = Math.max(Math.min(width, height) / 2.6, 140);

  nodes.forEach((node, idx) => {
    const angle = (2 * Math.PI * idx) / total;
    fallback.set(String(node.id), {
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
    });
  });

  return fallback;
}

function prefetchNeighbors() {
  const data = state.currentVideoData;
  if (!data || !data.frameTemplate) return;
  const max = Number.isFinite(data.sliderMax) ? data.sliderMax : data.maxFrame;
  const center = getRenderFrame(state.currentTime || 0);
  const stride = Math.max(1, Number(state.renderStride) || 1);
  const aheadSteps = 20;
  const behindSteps = Math.min(4, aheadSteps);
  const frames = new Set();

  const addFrame = (frame) => {
    if (frame < 0 || frame > max) return;
    frames.add(frame);
  };

  // Always include immediate neighbours for smooth scrubbing.
  addFrame(center);
  addFrame(center + 1);
  addFrame(center - 1);

  for (let step = 1; step <= aheadSteps; step++) {
    const frame = center + step * stride;
    if (frame > max) break;
    addFrame(frame);
  }

  for (let step = 1; step <= behindSteps; step++) {
    const frame = center - step * stride;
    if (frame < 0) break;
    addFrame(frame);
  }

  const orderedFrames = Array.from(frames).sort((a, b) => a - b);
  const cache = state.prefetch.cache;
  const limit = state.prefetch.limit || 24;
  prefetchMaskFrames(orderedFrames);
  orderedFrames.forEach((f) => {
    const url = formatFrameUrl(data.frameTemplate, f);
    if (!url || url === '—' || cache.has(url)) return;
    const img = new Image();
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.src = url;
    cache.set(url, img);
    // trim cache if needed (FIFO)
    if (cache.size > limit) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
  });
}

function ensurePrefetch(url) {
  const cache = state.prefetch.cache;
  let img = cache.get(url);
  if (img && img.complete && img.naturalWidth) return Promise.resolve(img);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    cache.set(url, img);
  }
  return new Promise((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    if (!img.src) img.src = url;
  });
}

function hideBothFrames() {
  const a = dom.frameImageA;
  const b = dom.frameImageB;
  if (a) a.style.opacity = '0';
  if (b) b.style.opacity = '0';
  setViewportBackground(null);
}

function displayFrame(url) {
  const a = dom.frameImageA;
  const b = dom.frameImageB;
  if (!a || !b) return;

  // Keep current visible; load next into the back buffer and only swap when decoded
  const active = state.activeBuffer || 'A';
  const front = active === 'A' ? a : b;
  const back = active === 'A' ? b : a;
  const currentSrc = front.dataset?.url || front.currentSrc || front.src;
  if (currentSrc) {
    setViewportBackground(currentSrc);
  }

  // If the requested frame is already visible, ensure it's shown and bail
  if (front.dataset.url === url) {
    if (front.style.opacity !== '1') front.style.opacity = '1';
    return;
  }

  // Always keep the front visible until the back image has fully decoded
  back.style.opacity = '0';

  const swapIfCurrent = () => {
    // Guard against races if multiple displayFrame calls happen quickly
    if (back.dataset.url !== url) return;
    back.style.opacity = '1';
    front.style.opacity = '0';
    state.activeBuffer = active === 'A' ? 'B' : 'A';
    state.lastFrameUrl = url;
    setViewportBackground(url);
  };

  ensurePrefetch(url)
    .catch(() => null)
    .finally(() => {
      // Set source after prefetch attempt; keep front visible until decode completes
      back.dataset.url = url;
      if (back.src !== url) back.src = url;

      // If the image is already in cache and complete, try decode() to avoid flashing
      const tryDecode = back.decode ? back.decode().catch(() => null) : Promise.resolve();

      // If decode is supported, wait for it; otherwise rely on onload/complete
      tryDecode
        .then(() => {
          // After successful decode, swap immediately
          swapIfCurrent();
        })
        .catch(() => {
          // Last resort: swap on load
          back.onload = () => {
            back.onload = null;
            swapIfCurrent();
          };
        });
    });
}

// Mask overlay helpers -----------------------------------------------------

function decodeCompressedCounts(input) {
  if (input == null) return [];
  if (Array.isArray(input)) {
    return input.map((value) => Number(value) || 0);
  }
  const source = String(input);
  const out = [];
  let value = 0;
  let shift = 0;
  for (let i = 0; i < source.length; i += 1) {
    const charCode = source.charCodeAt(i) - 48;
    if (charCode < 0) {
      continue;
    }
    value |= (charCode & 0x1f) << shift;
    if ((charCode & 0x20) === 0) {
      out.push(value);
      value = 0;
      shift = 0;
    } else {
      shift += 5;
    }
  }
  if (value) {
    out.push(value);
  }
  return out;
}

function ensureMaskBuffers(entry) {
  if (!entry) return null;
  const total = Math.max(1, Math.trunc(Number(entry.width) || 0) * Math.trunc(Number(entry.height) || 0));
  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }
  if (!entry.colBuffer || entry.colBuffer.length !== total) {
    entry.colBuffer = new Uint8Array(total);
  }
  if (!entry.rowBuffer || entry.rowBuffer.length !== total) {
    entry.rowBuffer = new Uint8Array(total);
  }
  return { column: entry.colBuffer, row: entry.rowBuffer };
}

function normaliseMaskPayload(payload) {
  let framesRaw = null;
  if (Array.isArray(payload)) {
    framesRaw = payload;
  } else if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.frames)) {
      framesRaw = payload.frames;
    } else if (Array.isArray(payload.masks)) {
      framesRaw = payload.masks;
    }
  }

  if (!framesRaw) {
    return null;
  }

  const frames = framesRaw.map((frame) => {
    if (!Array.isArray(frame)) {
      return [];
    }
    return frame
      .map((mask) => {
        if (!mask) return null;
        if (Array.isArray(mask) && mask.length >= 2) {
          const candidate = mask.find((item) => item && typeof item === 'object' && 'counts' in item);
          if (candidate) {
            mask = candidate;
          }
        }
        if (typeof mask !== 'object') {
          return null;
        }
        const size = Array.isArray(mask.size) ? mask.size : Array.isArray(mask.Size) ? mask.Size : null;
        const counts = mask.counts ?? mask.Counts;
        const objectIdRaw =
          mask.object_id ??
          mask.objectId ??
          mask.id ??
          mask.ID ??
          (typeof mask.obj_id !== 'undefined' ? mask.obj_id : undefined);
        if (!size || size.length < 2 || counts == null) {
          return null;
        }
        return {
          size: [Number(size[0]), Number(size[1])],
          counts,
          objectId: objectIdRaw != null ? String(objectIdRaw) : null,
        };
      })
      .filter(Boolean);
  });

  let width = null;
  let height = null;
  for (const frame of frames) {
    for (const mask of frame) {
      const size = mask.size;
      if (!size || size.length < 2) continue;
      const w = Number(size[0]);
      const h = Number(size[1]);
      if (Number.isFinite(w) && w > 0 && !width) {
        width = w;
      }
      if (Number.isFinite(h) && h > 0 && !height) {
        height = h;
      }
      if (width && height) break;
    }
    if (width && height) break;
  }

  return { frames, width, height };
}

function applyMaskDimensionHints(entry, imageHint) {
  if (!entry) return;
  if (!Number.isFinite(entry.width) || entry.width <= 0 || !Number.isFinite(entry.height) || entry.height <= 0) {
    if (imageHint && Number.isFinite(imageHint.width) && Number.isFinite(imageHint.height)) {
      if (!Number.isFinite(entry.width) || entry.width <= 0) {
        entry.width = imageHint.width;
      }
      if (!Number.isFinite(entry.height) || entry.height <= 0) {
        entry.height = imageHint.height;
      }
    }
  }

  if (Number.isFinite(entry.width) && Number.isFinite(entry.height)) {
    return;
  }

  for (const frame of entry.frames || []) {
    for (const mask of frame) {
      const size = mask.size;
      if (!Array.isArray(size) || size.length < 2) continue;
      const w = Number(size[0]);
      const h = Number(size[1]);
      if (!Number.isFinite(entry.width) && Number.isFinite(w) && w > 0) {
        entry.width = w;
      }
      if (!Number.isFinite(entry.height) && Number.isFinite(h) && h > 0) {
        entry.height = h;
      }
      if (Number.isFinite(entry.width) && Number.isFinite(entry.height)) {
        return;
      }
    }
  }
}

function buildMaskImageData(entry, frameIndex) {
  if (!entry || !Array.isArray(entry.frames)) return null;
  const masks = entry.frames[frameIndex];
  if (!Array.isArray(masks) || masks.length === 0) {
    return null;
  }

  const width = Math.trunc(entry.width || 0);
  const height = Math.trunc(entry.height || 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  const totalPixels = width * height;
  const buffers = ensureMaskBuffers(entry);
  if (!buffers) {
    return null;
  }

  const surface = new Uint8ClampedArray(totalPixels * 4);

  for (let idx = 0; idx < masks.length; idx += 1) {
    const mask = masks[idx];
    const runs = decodeCompressedCounts(mask.counts);
    if (!runs.length) {
      continue;
    }

    buffers.column.fill(0);
    buffers.row.fill(0);

    let cursor = 0;
    let value = 0;
    for (let i = 0; i < runs.length && cursor < totalPixels; i += 1) {
      const runLength = runs[i];
      if (!Number.isFinite(runLength) || runLength <= 0) {
        value ^= 1;
        continue;
      }
      if (value === 1) {
        const end = Math.min(cursor + runLength, totalPixels);
        buffers.column.fill(1, cursor, end);
        cursor = end;
      } else {
        cursor = Math.min(cursor + runLength, totalPixels);
      }
      value ^= 1;
    }

    let dest = 0;
    for (let row = 0; row < height; row += 1) {
      const base = row;
      for (let col = 0; col < width; col += 1) {
        buffers.row[dest] = buffers.column[col * height + base];
        dest += 1;
      }
    }

    const colour = maskColorForIndex(idx);
    const r = colour.r;
    const g = colour.g;
    const b = colour.b;
    const a = colour.a;

    for (let pixel = 0; pixel < totalPixels; pixel += 1) {
      if (!buffers.row[pixel]) continue;
      const offset = pixel * 4;
      const existingAlpha = surface[offset + 3];
      if (existingAlpha === 0) {
        surface[offset] = r;
        surface[offset + 1] = g;
        surface[offset + 2] = b;
        surface[offset + 3] = a;
      } else {
        surface[offset] = Math.min(255, Math.round((surface[offset] + r) / 2));
        surface[offset + 1] = Math.min(255, Math.round((surface[offset + 1] + g) / 2));
        surface[offset + 2] = Math.min(255, Math.round((surface[offset + 2] + b) / 2));
        surface[offset + 3] = Math.max(existingAlpha, Math.round((existingAlpha + a) / 2));
      }
    }
  }

  if (typeof ImageData === 'function') {
    return new ImageData(surface, width, height);
  }

  const ctx = dom.maskCanvas ? dom.maskCanvas.getContext('2d') : null;
  if (ctx && typeof ctx.createImageData === 'function') {
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(surface);
    return imageData;
  }

  return null;
}

function getMaskImage(entry, frameIndex) {
  if (!entry) return null;
  if (!entry.cache) {
    entry.cache = new Map();
  }
  if (entry.cache.has(frameIndex)) {
    const cached = entry.cache.get(frameIndex);
    // Promote for basic LRU behaviour.
    entry.cache.delete(frameIndex);
    entry.cache.set(frameIndex, cached);
    return cached;
  }

  const imageData = buildMaskImageData(entry, frameIndex);
  if (!imageData) {
    return null;
  }

  entry.cache.set(frameIndex, imageData);
  const limit = entry.cacheLimit || 28;
  while (entry.cache.size > limit) {
    const oldest = entry.cache.keys().next().value;
    if (oldest === undefined || oldest === frameIndex) break;
    entry.cache.delete(oldest);
  }
  return imageData;
}

function clearMaskCanvas() {
  const canvas = dom.maskCanvas;
  if (canvas) {
    canvas.dataset.visible = 'false';
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
    }
  }
  hideMaskPreview();
}

function hideMaskPreview() {
  state.mask.previewVideoId = null;
  state.mask.previewImageData = null;
  state.mask.previewCanvas = null;
  state.mask.previewContext = null;
  if (state.mask.colorLookup) {
    state.mask.colorLookup.clear();
  } else {
    state.mask.colorLookup = new Map();
  }
  state.mask.objectLabelMap = new Map();
  state.mask.objectColorMap = new Map();
  const preview = dom.maskPreview;
  if (preview) {
    preview.dataset.loaded = 'false';
    preview.removeAttribute('data-video-id');
  }
  if (dom.frameViewport) {
    dom.frameViewport.classList.remove('mask-preview-active');
  }
  if (dom.maskObjectList) {
    dom.maskObjectList.innerHTML = '';
  }
  if (dom.maskPanel) {
    dom.maskPanel.hidden = true;
    dom.maskPanel.dataset.visible = 'false';
  }
  hideMaskTooltip();
}

function hideMaskTooltip() {
  const tooltip = dom.maskTooltip;
  if (!tooltip) return;
  tooltip.hidden = true;
  tooltip.dataset.visible = 'false';
}

function showMaskTooltip(text, clientX, clientY) {
  const tooltip = dom.maskTooltip;
  if (!tooltip) return;
  tooltip.textContent = text;
  tooltip.style.left = `${Math.round(clientX)}px`;
  tooltip.style.top = `${Math.round(clientY)}px`;
  tooltip.hidden = false;
  tooltip.dataset.visible = 'true';
}

function createColorStruct(r, g, b, a) {
  const alpha = Math.max(0, Math.min(255, a));
  const key = `${r},${g},${b},${alpha}`;
  const hex = `#${[r, g, b]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
  return {
    r,
    g,
    b,
    a: alpha,
    key,
    hex,
    rgba: `rgba(${r}, ${g}, ${b}, ${(alpha / 255).toFixed(2)})`,
  };
}

function colorDistanceSquared(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

function resolveMaskEntriesForColor(color) {
  if (!color) return [];
  const lookup = state.mask.colorLookup;
  if (!lookup) {
    return [];
  }

  const direct = lookup.get(color.key);
  if (direct) {
    return [direct];
  }

  const candidates = [];
  lookup.forEach((entry) => {
    if (!entry || !entry.color) return;
    const distance = colorDistanceSquared(entry.color, color);
    if (!Number.isFinite(distance)) return;
    candidates.push({ entry, distance });
  });

  if (!candidates.length) {
    return [];
  }

  candidates.sort((a, b) => a.distance - b.distance);
  const best = candidates[0];
  if (!best) {
    return [];
  }

  const tolerance = 45 * 45;
  if (best.distance > tolerance) {
    return [];
  }

  const similar = candidates.filter((item) => item.distance <= best.distance * 1.1 && item.distance <= tolerance);
  return similar.map((item) => item.entry);
}

function sampleMaskColorAt(x, y) {
  const imageData = state.mask.previewImageData;
  if (!imageData) return null;
  const { width, height, data } = imageData;
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return null;
  }
  const idx = (y * width + x) * 4;
  const r = data[idx];
  const g = data[idx + 1];
  const b = data[idx + 2];
  const a = data[idx + 3];
  if (a < 32) {
    return null;
  }
  return createColorStruct(r, g, b, a);
}

function sampleNearestMaskColor(x, y, radius = 3) {
  let color = sampleMaskColorAt(x, y);
  if (color) return color;
  for (let r = 1; r <= radius; r += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      const left = x + dx;
      const top = y - r;
      const bottom = y + r;
      color = sampleMaskColorAt(left, top) || sampleMaskColorAt(left, bottom);
      if (color) return color;
    }
    for (let dy = -r + 1; dy <= r - 1; dy += 1) {
      const right = x + r;
      const left = x - r;
      const ny = y + dy;
      color = sampleMaskColorAt(right, ny) || sampleMaskColorAt(left, ny);
      if (color) return color;
    }
  }
  return null;
}

function resolveMaskDimensions(mask, entry) {
  if (!mask) return null;
  const size = Array.isArray(mask.size) ? mask.size : null;
  let height = size && Number(size[0]);
  let width = size && Number(size[1]);

  if (!Number.isFinite(height) || height <= 0) {
    height = Number(entry?.height);
  }
  if (!Number.isFinite(width) || width <= 0) {
    width = Number(entry?.width);
  }

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return {
    width: Math.trunc(width),
    height: Math.trunc(height),
  };
}

function sampleMaskPreviewColorForMask(mask, entry, imageData) {
  if (!mask || !imageData) return null;
  const dimensions = resolveMaskDimensions(mask, entry);
  if (!dimensions) {
    return null;
  }

  const { width: previewWidth, height: previewHeight, data } = imageData;
  if (!Number.isFinite(previewWidth) || !Number.isFinite(previewHeight) || previewWidth <= 0 || previewHeight <= 0) {
    return null;
  }

  const maskWidth = dimensions.width;
  const maskHeight = dimensions.height;
  if (!Number.isFinite(maskWidth) || !Number.isFinite(maskHeight) || maskWidth <= 0 || maskHeight <= 0) {
    return null;
  }

  const scaleX = previewWidth / maskWidth;
  const scaleY = previewHeight / maskHeight;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
    return null;
  }

  const runs = decodeCompressedCounts(mask.counts);
  if (!runs.length) {
    return null;
  }

  const totalPixels = maskWidth * maskHeight;
  const maxX = previewWidth - 1;
  const maxY = previewHeight - 1;

  const sampleAtIndex = (index) => {
    if (!Number.isFinite(index) || index < 0 || index >= totalPixels) {
      return null;
    }
    const row = index % maskHeight;
    const col = Math.floor(index / maskHeight);
    const floatX = col * scaleX;
    const floatY = row * scaleY;
    const xCandidates = new Set([Math.floor(floatX), Math.round(floatX), Math.ceil(floatX)]);
    const yCandidates = new Set([Math.floor(floatY), Math.round(floatY), Math.ceil(floatY)]);
    for (const xCandidate of xCandidates) {
      const clampedX = Math.min(Math.max(xCandidate, 0), maxX);
      for (const yCandidate of yCandidates) {
        const clampedY = Math.min(Math.max(yCandidate, 0), maxY);
        const offset = (clampedY * previewWidth + clampedX) * 4;
        const alpha = data[offset + 3];
        if (alpha < 32) {
          continue;
        }
        const r = data[offset];
        const g = data[offset + 1];
        const b = data[offset + 2];
        return createColorStruct(r, g, b, alpha);
      }
    }
    return null;
  };

  let cursor = 0;
  let value = 0;
  for (let i = 0; i < runs.length && cursor < totalPixels; i += 1) {
    const runLength = runs[i];
    if (!Number.isFinite(runLength) || runLength <= 0) {
      value ^= 1;
      continue;
    }
    const end = Math.min(cursor + runLength, totalPixels);
    if (value === 1) {
      const startIndex = cursor;
      const midIndex = startIndex + Math.floor(Math.max(0, end - startIndex - 1) / 2);
      const endIndex = end - 1;
      const candidates = [startIndex, midIndex, endIndex];
      for (const candidate of candidates) {
        const color = sampleAtIndex(candidate);
        if (color) {
          return color;
        }
      }
      const stride = Math.max(1, Math.floor(runLength / 12));
      for (let offset = 0; offset < runLength; offset += stride) {
        const color = sampleAtIndex(startIndex + offset);
        if (color) {
          return color;
        }
      }
    }
    cursor = end;
    value ^= 1;
  }

  return null;
}

function deriveMaskDisplayLabel(labelsArray, objectIds, data, extraLabels = []) {
  const result = [];
  const seen = new Set();
  const pushUnique = (value) => {
    if (value == null) return;
    const trimmed = String(value).trim();
    if (!trimmed || /^(unknown object|mask region)$/i.test(trimmed)) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(trimmed);
  };

  const sources = [];
  if (Array.isArray(labelsArray)) {
    sources.push(...labelsArray);
  }
  if (Array.isArray(extraLabels)) {
    sources.push(...extraLabels);
  }
  sources.forEach(pushUnique);

  if (Array.isArray(objectIds) && objectIds.length) {
    objectIds.forEach((objectId) => {
      if (objectId == null) return;
      const key = String(objectId).trim();
      if (!key) return;
      let descriptorAdded = false;
      if (data) {
        const descriptor = getObjectDisplayDescriptor(data, key);
        if (descriptor) {
          const descriptorCandidates = [
            descriptor.displayLabel,
            descriptor.combinedLabel,
            descriptor.objectLabel,
            descriptor.shortLabel,
            descriptor.compactLabel,
          ];
          for (const candidate of descriptorCandidates) {
            const before = result.length;
            pushUnique(candidate);
            if (result.length > before) {
              descriptorAdded = true;
              break;
            }
          }
        }
      }
      if (!descriptorAdded) {
        const numeric = Number(key);
        const fallbackLabel = Number.isFinite(numeric) ? `Object ${numeric}` : `Object ${key}`;
        pushUnique(fallbackLabel);
      }
    });
  }

  if (!result.length && Array.isArray(labelsArray)) {
    labelsArray
      .map((value) => (value == null ? '' : String(value).trim()))
      .filter(Boolean)
      .forEach(pushUnique);
  }

  return result.join(', ');
}

function getPreviewGeometry(preview) {
  if (!preview) return null;
  const rect = preview.getBoundingClientRect();
  const naturalWidth = preview.naturalWidth || preview.width;
  const naturalHeight = preview.naturalHeight || preview.height;
  if (!naturalWidth || !naturalHeight) {
    return null;
  }
  const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
  if (!Number.isFinite(scale) || scale <= 0) {
    return null;
  }
  const displayWidth = naturalWidth * scale;
  const displayHeight = naturalHeight * scale;
  const offsetX = (rect.width - displayWidth) / 2;
  const offsetY = (rect.height - displayHeight) / 2;
  return {
    rect,
    naturalWidth,
    naturalHeight,
    scale,
    displayWidth,
    displayHeight,
    offsetX,
    offsetY,
  };
}

function prepareMaskLegend() {
  if (!state.mask.enabled) {
    hideMaskPreview();
    return;
  }
  const preview = dom.maskPreview;
  if (!preview || preview.dataset.loaded !== 'true') {
    return;
  }
  const width = preview.naturalWidth || preview.width;
  const height = preview.naturalHeight || preview.height;
  if (!width || !height) {
    return;
  }

  const canvas = state.mask.previewCanvas || document.createElement('canvas');
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return;
  }
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(preview, 0, 0, width, height);
  state.mask.previewCanvas = canvas;
  state.mask.previewContext = ctx;
  state.mask.previewImageData = ctx.getImageData(0, 0, width, height);

  buildMaskLegend();
}

function buildMaskLegend() {
  const preview = dom.maskPreview;
  const list = dom.maskObjectList;
  const panel = dom.maskPanel;
  const imageData = state.mask.previewImageData;
  const videoId = state.currentVideoId;
  const maskEntry = videoId ? state.mask.store.get(videoId) : null;
  const firstFrameMasks = Array.isArray(maskEntry?.frames?.[0]) ? maskEntry.frames[0] : [];
  if (!preview || !list || !panel || !imageData || !state.currentVideoData) {
    if (panel) {
      panel.hidden = true;
      panel.dataset.visible = 'false';
    }
    if (list) {
      list.innerHTML = '';
    }
    return;
  }

  const colorLookup = new Map();
  const objectLabelMap = new Map();
  const objectColorMap = new Map();
  const data = state.currentVideoData;
  const labels = data.objectLabels || {};
  const ensureEntry = (color) => {
    if (!color) return null;
    const existing = colorLookup.get(color.key);
    if (existing) {
      return existing;
    }
    const entry = {
      color,
      objectIds: [],
      labelSet: new Set(),
    };
    colorLookup.set(color.key, entry);
    return entry;
  };

  firstFrameMasks.forEach((mask, idx) => {
    if (!mask) return;
    const color = sampleMaskPreviewColorForMask(mask, maskEntry, imageData);
    if (!color) return;

    const entry = ensureEntry(color);
    if (!entry) return;

    const rawObjectId = mask.objectId;
    const objectId = rawObjectId != null && rawObjectId !== 'null' ? String(rawObjectId) : null;
    const fallbackId = String(idx);
    const resolvedId = objectId ?? fallbackId;
    const descriptor = getObjectDisplayDescriptor(data, resolvedId);
    const label =
      descriptor?.displayLabel ||
      descriptor?.combinedLabel ||
      labels?.[resolvedId] ||
      labels?.[fallbackId] ||
      `Object ${resolvedId}`;

    entry.labelSet.add(label);

    if (!entry.objectIds.includes(resolvedId)) {
      entry.objectIds.push(resolvedId);
    }
    if (!objectLabelMap.has(resolvedId)) {
      objectLabelMap.set(
        resolvedId,
        descriptor?.displayLabel || descriptor?.combinedLabel || label || `Object ${resolvedId}`
      );
    }
    if (!objectColorMap.has(resolvedId)) {
      objectColorMap.set(resolvedId, color);
    }
  });

  if (imageData?.data) {
    const { data: pixels } = imageData;
    const seen = new Set(colorLookup.keys());
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3];
      if (alpha < 32) continue;
      const color = createColorStruct(pixels[i], pixels[i + 1], pixels[i + 2], alpha);
      if (seen.has(color.key)) {
        continue;
      }
      seen.add(color.key);
      ensureEntry(color);
    }
  }

  state.mask.colorLookup = colorLookup;

  const items = Array.from(colorLookup.values()).map((entry) => {
    const objectIds = entry.objectIds.slice().sort((a, b) => Number(a) - Number(b));
    const labelsArray = Array.isArray(entry.labelSet)
      ? Array.from(new Set(entry.labelSet))
      : entry.labelSet instanceof Set
      ? Array.from(entry.labelSet)
      : [];
    labelsArray.sort((a, b) => a.localeCompare(b));
    const fallbackFromLabels = labelsArray
      .map((value) => (value == null ? '' : String(value).trim()))
      .filter(Boolean)
      .join(', ');
    const fallbackFromIds = objectIds
      .map((objectId) => {
        const descriptor = getObjectDisplayDescriptor(data, objectId);
        if (descriptor?.displayLabel) return descriptor.displayLabel;
        if (descriptor?.combinedLabel) return descriptor.combinedLabel;
        if (descriptor?.objectLabel) return descriptor.objectLabel;
        if (descriptor?.shortLabel) return descriptor.shortLabel;
        const labelFromData = labels?.[objectId];
        if (labelFromData) return String(labelFromData).trim();
        return `Object ${objectId}`;
      })
      .filter(Boolean)
      .join(', ');
    const label = deriveMaskDisplayLabel(labelsArray, objectIds, data) || fallbackFromLabels || fallbackFromIds;
    objectIds.forEach((objectId) => {
      if (!objectLabelMap.has(objectId)) {
        const fallback = getObjectDisplayDescriptor(data, objectId)?.displayLabel || labels?.[objectId] || formatObjectLabel(data, objectId);
        objectLabelMap.set(objectId, label || fallback || `Object ${objectId}`);
      }
      if (!objectColorMap.has(objectId)) {
        objectColorMap.set(objectId, entry.color);
      }
    });
    return {
      color: entry.color,
      objectIds,
      label,
    };
  });

  items.sort((a, b) => {
    if (a.objectIds.length && b.objectIds.length) {
      return Number(a.objectIds[0]) - Number(b.objectIds[0]);
    }
    if (a.objectIds.length) return -1;
    if (b.objectIds.length) return 1;
    return a.label.localeCompare(b.label);
  });

  state.mask.objectLabelMap = objectLabelMap;
  state.mask.objectColorMap = objectColorMap;

  panel.hidden = false;
  panel.dataset.visible = 'true';

  if (!items.length) {
    list.innerHTML = '<p class="panel__note">No mask labels available.</p>';
    if (state.mask.showAllLabels) {
      clearMaskLabelsOverlay();
    }
    return;
  }

  if (state.mask.showAllLabels) {
    updateMaskLabelsOverlay();
  } else {
    clearMaskLabelsOverlay();
  }

  const frag = document.createDocumentFragment();
  items.forEach((item) => {
    const entry = document.createElement('div');
    entry.className = 'mask-object-item';

    const swatch = document.createElement('span');
    swatch.className = 'mask-object-swatch';
    swatch.style.background = item.color.rgba;
    swatch.title = item.color.hex;
    entry.appendChild(swatch);

    const labelSpan = document.createElement('span');
    labelSpan.className = 'mask-object-label';
    const mapLabels = item.objectIds
      .map((objectId) => objectLabelMap.get(objectId))
      .filter((value) => typeof value === 'string' && value.trim().length > 0);
    const displayLabel = deriveMaskDisplayLabel(
      item.label && !/^mask region$/i.test(item.label) ? [item.label] : [],
      item.objectIds,
      data,
      mapLabels
    );
    const resolvedListLabel = displayLabel || 'Mask region';
    labelSpan.textContent = resolvedListLabel;
    item.label = resolvedListLabel;
    entry.appendChild(labelSpan);

    if (item.objectIds.length) {
      const idSpan = document.createElement('span');
      idSpan.className = 'mask-object-id';
      idSpan.textContent = `Obj ${item.objectIds.join(', ')}`;
      entry.appendChild(idSpan);
    }

    frag.appendChild(entry);
  });

  list.innerHTML = '';
  list.appendChild(frag);
}

function getPreviewCoordinates(event) {
  const preview = dom.maskPreview;
  if (!preview || preview.dataset.loaded !== 'true') {
    return null;
  }
  const geometry = getPreviewGeometry(preview);
  if (!geometry) {
    return null;
  }

  const relativeX = event.clientX - geometry.rect.left - geometry.offsetX;
  const relativeY = event.clientY - geometry.rect.top - geometry.offsetY;
  if (relativeX < 0 || relativeY < 0 || relativeX > geometry.displayWidth || relativeY > geometry.displayHeight) {
    return null;
  }

  const imageX = Math.floor(relativeX / geometry.scale);
  const imageY = Math.floor(relativeY / geometry.scale);
  return { x: imageX, y: imageY };
}

function formatMaskTooltipEntry(entry) {
  if (!entry) return '';
  const normalizeValue = (value) => (value == null ? '' : String(value).trim());
  const isGenericLabel = (value) => {
    const normalized = normalizeValue(value);
    if (!normalized) return true;
    if (/^(unknown object|mask region)$/i.test(normalized)) return true;
    const withoutIdSuffix = normalized.replace(/\s*\(ID\s*[^)]+\)\s*$/i, '').trim();
    if (!withoutIdSuffix) return true;
    const compact = withoutIdSuffix.replace(/\s+/g, '').toLowerCase();
    if (/^(id|object|obj)\d+$/.test(compact)) return true;
    return false;
  };

  const data = state.currentVideoData;
  const objectLabelMap = state.mask.objectLabelMap;

  const objectInfos = [];
  const seenIdDisplays = new Set();
  if (Array.isArray(entry.objectIds)) {
    entry.objectIds.forEach((rawId) => {
      const str = normalizeValue(rawId);
      if (!str) return;
      const numeric = Number(str);
      const display = Number.isFinite(numeric) ? String(numeric) : str;
      if (seenIdDisplays.has(display)) return;
      seenIdDisplays.add(display);
      objectInfos.push({
        raw: rawId,
        str,
        numeric,
        display,
      });
    });
  }

  const describeObject = (info) => {
    const lookupKeys = [];
    const keySet = new Set();
    const addKey = (candidate) => {
      if (candidate == null) return;
      const dedupeKey = `${typeof candidate}:${String(candidate)}`;
      if (keySet.has(dedupeKey)) return;
      keySet.add(dedupeKey);
      lookupKeys.push(candidate);
    };

    addKey(info.raw);
    addKey(info.str);
    addKey(info.display);
    if (Number.isFinite(info.numeric)) {
      addKey(info.numeric);
    }

    let label = '';
    if (objectLabelMap) {
      for (const key of lookupKeys) {
        if (objectLabelMap.has(key)) {
          const candidate = normalizeValue(objectLabelMap.get(key));
          if (!candidate || isGenericLabel(candidate)) {
            continue;
          }
          label = candidate;
          break;
        }
      }
    }

    if (!label && data) {
      const descriptor = getObjectDisplayDescriptor(data, info.str);
      if (descriptor) {
        const descriptorCandidates = [
          descriptor.rawLabel,
          descriptor.objectLabel,
          descriptor.displayLabel,
          descriptor.combinedLabel,
          descriptor.shortLabel,
          descriptor.compactLabel,
        ];
        for (const candidate of descriptorCandidates) {
          const normalized = normalizeValue(candidate);
          if (!normalized || isGenericLabel(normalized)) {
            continue;
          }
          label = normalized;
          break;
        }
      }
    }

    if (label) {
      label = label.replace(/\s*\(ID\s*[^)]+\)\s*$/i, '').replace(/^ID\s+/i, '').trim();
      const compactLabel = label.replace(/\s+/g, '').toLowerCase();
      const compactId = info.display.replace(/\s+/g, '').toLowerCase();
      if (
        compactLabel === compactId ||
        compactLabel === `object${compactId}` ||
        compactLabel === `obj${compactId}` ||
        compactLabel === `id${compactId}`
      ) {
        label = '';
      }
    }

    if (label) {
      return `Obj ${info.display}: ${label}`;
    }
    return `Obj ${info.display}`;
  };

  const seenDescriptions = new Set();
  const objectParts = [];
  objectInfos.forEach((info) => {
    const description = normalizeValue(describeObject(info));
    if (!description) return;
    const key = description.toLowerCase();
    if (seenDescriptions.has(key)) return;
    seenDescriptions.add(key);
    objectParts.push(description);
  });

  const rawLabel = normalizeValue(entry.label);
  const finalParts = [];
  if (rawLabel && !isGenericLabel(rawLabel)) {
    const cleanedLabel = rawLabel.replace(/\s*\(ID\s*[^)]+\)\s*$/i, '').trim();
    const normalizedLabel = cleanedLabel.toLowerCase();
    const coveredByObject = objectParts.some((part) => {
      const partLower = part.toLowerCase();
      return partLower === normalizedLabel || partLower.includes(`: ${normalizedLabel}`);
    });
    if (!coveredByObject) {
      finalParts.push(rawLabel);
    }
  }
  finalParts.push(...objectParts);

  if (finalParts.length) {
    return finalParts.join(', ');
  }

  if (data && objectInfos.length) {
    const derived = deriveMaskDisplayLabel([], objectInfos.map((info) => info.display), data);
    if (derived && !isGenericLabel(derived)) {
      return derived;
    }
  }

  if (objectInfos.length) {
    return objectInfos.map((info) => `Obj ${info.display}`).join(', ');
  }

  return 'Mask (no object metadata)';
}

function clearMaskLabelsOverlay() {
  const layer = dom.maskLabelsLayer;
  if (!layer) return;
  layer.innerHTML = '';
  layer.dataset.visible = 'false';
}

function updateMaskLabelsOverlay() {
  const layer = dom.maskLabelsLayer;
  const preview = dom.maskPreview;
  if (!layer || !preview) return;
  if (!state.mask.enabled || !state.mask.showAllLabels || preview.dataset.loaded !== 'true') {
    clearMaskLabelsOverlay();
    return;
  }
  const geometry = getPreviewGeometry(preview);
  if (!geometry) {
    clearMaskLabelsOverlay();
    return;
  }
  const data = state.currentVideoData;
  if (!data || !state.mask.objectLabelMap) {
    clearMaskLabelsOverlay();
    return;
  }

  const originX = Number.isFinite(state.imageSize?.originX) ? state.imageSize.originX : 0;
  const originY = Number.isFinite(state.imageSize?.originY) ? state.imageSize.originY : 0;
  const objectLabelMap = state.mask.objectLabelMap;
  const objectColorMap = state.mask.objectColorMap || new Map();

  const frag = document.createDocumentFragment();
  const seen = new Set();
  const placed = [];

  const offsets = [
    [0, 0],
    [0, 18],
    [0, -18],
    [18, 0],
    [-18, 0],
    [18, 18],
    [-18, 18],
    [18, -18],
    [-18, -18],
    [0, 36],
    [0, -36],
    [36, 0],
    [-36, 0],
  ];

  const isFarEnough = (x, y) => {
    const threshold = 20;
    return placed.every((pos) => {
      const dx = pos.x - x;
      const dy = pos.y - y;
      return Math.hypot(dx, dy) >= threshold;
    });
  };

  const choosePosition = (baseX, baseY) => {
    for (const [dx, dy] of offsets) {
      const x = Math.min(Math.max(baseX + dx, 0), geometry.rect.width);
      const y = Math.min(Math.max(baseY + dy, 0), geometry.rect.height);
      if (isFarEnough(x, y)) {
        return { x, y };
      }
    }
    return {
      x: Math.min(Math.max(baseX, 0), geometry.rect.width),
      y: Math.min(Math.max(baseY + 48, 0), geometry.rect.height),
    };
  };

  data.nodes.forEach((node) => {
    const objectId = String(node.id);
    if (seen.has(objectId)) return;
    const point = getCentroidPoint(node.id, 0);
    if (!point) return;
    const imgX = point.x - originX;
    const imgY = point.y - originY;
    if (!Number.isFinite(imgX) || !Number.isFinite(imgY)) return;

    const displayX = geometry.offsetX + imgX * geometry.scale;
    const displayY = geometry.offsetY + imgY * geometry.scale;

    const target = choosePosition(displayX, displayY);

    const label =
      objectLabelMap.get(objectId) ||
      getObjectDisplayDescriptor(data, objectId)?.displayLabel ||
      formatObjectLabel(data, objectId);
    if (!label) return;

    const chip = document.createElement('div');
    chip.className = 'mask-label-chip';
    chip.textContent = label;
    chip.style.left = `${target.x}px`;
    chip.style.top = `${target.y}px`;

    const colorStruct = objectColorMap.get(objectId);
    if (colorStruct) {
      chip.dataset.color = colorStruct.hex;
      chip.style.setProperty('--mask-swatch-color', colorStruct.rgba);
    } else {
      chip.removeAttribute('data-color');
      chip.style.removeProperty('--mask-swatch-color');
    }

    frag.appendChild(chip);
    seen.add(objectId);
    placed.push({ x: target.x, y: target.y });
  });

  layer.innerHTML = '';
  layer.appendChild(frag);
  layer.dataset.visible = layer.childElementCount > 0 ? 'true' : 'false';
}

function setMaskLabelsVisible(nextValue) {
  const desired = Boolean(nextValue);
  if (state.mask.showAllLabels === desired) {
    if (desired) {
      updateMaskLabelsOverlay();
    }
    return;
  }
  state.mask.showAllLabels = desired;
  if (dom.maskLabelsToggle) {
    dom.maskLabelsToggle.checked = desired;
  }
  if (!desired) {
    clearMaskLabelsOverlay();
    return;
  }
  if (!state.mask.enabled) {
    clearMaskLabelsOverlay();
    return;
  }
  updateMaskLabelsOverlay();
}

function handleMaskPreviewPointerMove(event) {
  if (!state.mask.enabled || !state.mask.previewImageData || !state.mask.colorLookup) {
    hideMaskTooltip();
    return;
  }
  const coords = getPreviewCoordinates(event);
  if (!coords) {
    hideMaskTooltip();
    return;
  }
  const color = sampleNearestMaskColor(coords.x, coords.y, 6);
  if (!color) {
    hideMaskTooltip();
    return;
  }
  const entries = resolveMaskEntriesForColor(color);
  if (!entries.length) {
    hideMaskTooltip();
    return;
  }
  const labelSet = new Set();
  const objectIdsSet = new Set();
  entries.forEach((entry) => {
    const labelsRaw = entry?.labelSet;
    if (Array.isArray(labelsRaw)) {
      labelsRaw.forEach((value) => {
        if (value) {
          labelSet.add(String(value));
        }
      });
    } else if (labelsRaw instanceof Set) {
      labelsRaw.forEach((value) => {
        if (value) {
          labelSet.add(String(value));
        }
      });
    }
    if (Array.isArray(entry?.objectIds)) {
      entry.objectIds.forEach((id) => {
        if (id != null) {
          objectIdsSet.add(String(id));
        }
      });
    }
  });
  const labelsArray = Array.from(labelSet).sort((a, b) => a.localeCompare(b));
  const objectIds = Array.from(objectIdsSet).sort((a, b) => Number(a) - Number(b));
  const mapLabels = objectIds
    .map((objectId) => state.mask.objectLabelMap?.get(objectId))
    .filter((value) => typeof value === 'string' && value.trim().length > 0);
  const derivedLabel = deriveMaskDisplayLabel(labelsArray, objectIds, state.currentVideoData, mapLabels);
  const label = formatMaskTooltipEntry({
    label: derivedLabel,
    objectIds,
  });
  if (!label) {
    hideMaskTooltip();
    return;
  }
  showMaskTooltip(label, event.clientX, event.clientY);
}

async function fetchMaskPayload(videoId, manifestEntry) {
  const baseHref = typeof window !== 'undefined' && window.location ? window.location.href : 'http://localhost/';
  const candidates = [];
  const seen = new Set();

  const pushCandidate = (value) => {
    if (value == null) return;
    const str = String(value).trim();
    if (!str || seen.has(str)) return;
    seen.add(str);
    candidates.push(str);
    try {
      const absolute = new URL(str, baseHref).href;
      if (!seen.has(absolute)) {
        seen.add(absolute);
        candidates.push(absolute);
      }
    } catch (error) {
      // ignore resolution errors
    }
  };

  if (manifestEntry?.mask_url) {
    pushCandidate(manifestEntry.mask_url);
  }

  if (manifestEntry?.relations_url) {
    const relUrl = manifestEntry.relations_url;
    pushCandidate(relUrl.replace(/sav_rels/gi, 'masks'));
    pushCandidate(relUrl.replace(/sav_rels\/([^/]+)\.json/gi, 'masks/$1_merged.json'));
    pushCandidate(relUrl.replace(/sav_rels\//gi, 'masks/').replace(/\.json$/i, '_merged.json'));
    pushCandidate(relUrl.replace(/\bpublic\//gi, '').replace(/sav_rels\//gi, 'masks/').replace(/\.json$/i, '_merged.json'));
  }

  const slug = videoId;
  [
    `public/masks/${slug}_merged.json`,
    `/public/masks/${slug}_merged.json`,
    `./public/masks/${slug}_merged.json`,
    `masks/${slug}_merged.json`,
    `/masks/${slug}_merged.json`,
    `./masks/${slug}_merged.json`,
    `public/masks/${slug}.json`,
    `/public/masks/${slug}.json`,
    `./public/masks/${slug}.json`,
  ].forEach(pushCandidate);

  for (const url of candidates) {
    try {
      const response = await fetch(url, { cache: 'no-cache' });
      if (!response.ok) continue;
      const data = await response.json();
      if (data) {
        return { data, source: url };
      }
    } catch (error) {
      console.debug(`Mask fetch failed for ${url}:`, error);
    }
  }

  return null;
}

function ensureMaskEntry(videoId, manifestEntry) {
  if (!videoId) {
    return Promise.resolve(null);
  }

  const sourceVideoId = getSourceVideoId(manifestEntry, videoId) || videoId;

  let entry = state.mask.store.get(videoId);
  if (entry && entry.frames && entry.frames.length) {
    return Promise.resolve(entry);
  }
  if (entry?.promise) {
    return entry.promise;
  }

  entry = entry || { videoId, sourceVideoId, cache: new Map(), cacheLimit: 28 };
  const promise = fetchMaskPayload(sourceVideoId, manifestEntry)
    .then((result) => {
      if (!result) {
        entry.error = 'not_found';
        entry.frames = [];
        return entry;
      }
      const normalised = normaliseMaskPayload(result.data);
      if (!normalised) {
        entry.error = 'invalid_data';
        entry.frames = [];
        return entry;
      }
      entry.frames = normalised.frames;
      entry.width = Number.isFinite(normalised.width) ? normalised.width : entry.width;
      entry.height = Number.isFinite(normalised.height) ? normalised.height : entry.height;
      entry.source = result.source;
      entry.error = null;
      return entry;
    })
    .catch((error) => {
      entry.error = error;
      entry.frames = [];
      return entry;
    })
    .finally(() => {
      entry.promise = null;
    });

  entry.promise = promise;
  state.mask.store.set(videoId, entry);
  return promise;
}

function renderMaskOverlay() {
  const preview = dom.maskPreview;
  const viewport = dom.frameViewport;
  const enabled = Boolean(state.mask.enabled);
  const videoId = state.currentVideoId;
  const baseVideoId = getSourceVideoId(state.currentVideoData?.manifest, videoId) || videoId;

  if (!preview || !viewport || !enabled || !videoId) {
    state.mask.lastRenderedFrame = null;
    hideMaskPreview();
    return;
  }

  if (state.mask.previewVideoId !== videoId) {
    state.mask.previewVideoId = videoId;
    preview.dataset.loaded = 'false';
    preview.dataset.videoId = videoId;
    preview.dataset.sourceVideoId = baseVideoId;
    preview.src = `/public/mask_previews/${encodeURIComponent(baseVideoId)}_frame0_multi.png`;
  }

  viewport.classList.add('mask-preview-active');
  if (preview.dataset.loaded === 'true') {
    prepareMaskLegend();
  }
}

function prefetchMaskFrames() {
  // Mask previews are static images, so there is nothing to prefetch per frame.
}

function setMaskEnabled(nextValue) {
  const enabled = Boolean(nextValue);
  state.mask.enabled = enabled;
  persistMaskPreference(enabled);
  if (dom.maskToggle) {
    dom.maskToggle.checked = enabled;
  }
  if (dom.maskLabelsToggle) {
    dom.maskLabelsToggle.disabled = !enabled;
    if (enabled) {
      dom.maskLabelsToggle.removeAttribute('disabled');
    } else {
      dom.maskLabelsToggle.setAttribute('disabled', '');
    }
  }
  if (!enabled) {
    state.mask.lastRenderedFrame = null;
    clearMaskCanvas();
    clearMaskLabelsOverlay();
    return;
  }

  renderMaskOverlay();
  if (state.mask.showAllLabels) {
    updateMaskLabelsOverlay();
  }
}

async function fetchManifest() {
  const response = await fetch(manifestUrl, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Failed to load manifest (status ${response.status})`);
  }
  return response.json();
}

async function fetchRelations(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Failed to fetch relations: ${url}`);
  }
  return response.json();
}

async function fetchObjectLabels(url) {
  if (!url) return null;
  try {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
    const data = await response.json();
    return data && typeof data === 'object' ? data : null;
  } catch (error) {
    console.warn(`Object labels fetch failed for ${url}:`, error);
    return null;
  }
}

async function fetchMetadata(url) {
  try {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
    return response.json();
  } catch (error) {
    console.warn(`Metadata fetch failed for ${url}:`, error);
    return null;
  }
}

async function fetchCentroids(videoId, manifestEntry) {
  const baseHref = typeof window !== 'undefined' && window.location ? window.location.href : 'http://localhost/';
  const candidates = [];
  const seen = new Set();

  const addCandidate = (value) => {
    if (!value && value !== '') return;
    const str = String(value).trim();
    if (!str) return;

    const pushVariant = (candidate) => {
      if (!candidate) return;
      if (seen.has(candidate)) return;
      seen.add(candidate);
      candidates.push(candidate);
    };

    pushVariant(str);

    try {
      const absolute = new URL(str, baseHref).href;
      pushVariant(absolute);
    } catch (error) {
      // Ignore resolution errors for malformed URLs
    }
  };

  if (manifestEntry?.centroids_url) {
    addCandidate(manifestEntry.centroids_url);
  }

  if (manifestEntry?.relations_url) {
    const relUrl = manifestEntry.relations_url;
    const swapped = relUrl.replace(/sav_rels/gi, 'centroids');
    if (swapped !== relUrl) {
      addCandidate(swapped);
    }
    const trimmed = swapped.replace(/\bpublic\//gi, '');
    if (trimmed !== swapped) {
      addCandidate(trimmed);
    }
  }

  if (manifestEntry?.metadata_url) {
    const metaUrl = manifestEntry.metadata_url;
    const swapped = metaUrl.replace(/metadata\.json/gi, 'centroids.json');
    if (swapped !== metaUrl) {
      addCandidate(swapped);
    }
  }

  [
    `public/centroids/${videoId}.json`,
    `/public/centroids/${videoId}.json`,
    `./public/centroids/${videoId}.json`,
    `centroids/${videoId}.json`,
    `/centroids/${videoId}.json`,
    `./centroids/${videoId}.json`,
    `${videoId}.json`,
    `./${videoId}.json`,
  ].forEach(addCandidate);

  for (const url of candidates) {
    try {
      const response = await fetch(url, { cache: 'no-cache' });
      if (!response.ok) {
        continue;
      }
      const data = await response.json();
      if (data && typeof data === 'object') {
        return data;
      }
    } catch (error) {
      console.debug(`Centroid fetch failed for ${url}:`, error);
    }
  }

  console.warn(`Centroid data not found for video ${videoId}`);
  return null;
}

function buildVideoData(manifestEntry, rawData, metadata, centroidsPayload, objectLabelsPayload) {
  const baseVideoId = getSourceVideoId(manifestEntry);
  const relationships = Array.isArray(rawData.relationships)
    ? rawData.relationships
    : Array.isArray(rawData.relations)
    ? rawData.relations
    : [];

  const filterConfig = detectFilteredRun(manifestEntry, rawData);
  const rawFilterMetadata = Array.isArray(rawData.relationship_filter_metadata)
    ? rawData.relationship_filter_metadata
    : [];
  const filterRecords = [];
  rawFilterMetadata.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const subjectId = entry.subject_id;
    const objectId = entry.object_id;
    const predicate = entry.predicate;
    const decisionRaw = typeof entry.decision === 'string' ? entry.decision.trim() : null;
    const labelRaw = typeof entry.label === 'string' ? entry.label.trim() : null;
    const explanationRaw = typeof entry.explanation === 'string' ? entry.explanation.trim() : null;
    filterRecords.push({
      index,
      decision: decisionRaw,
      label: labelRaw,
      explanation: explanationRaw,
      predicate: predicate === null || predicate === undefined ? null : String(predicate),
      relationType: normaliseRelationType(entry.relation_type),
      subjectId: subjectId === null || subjectId === undefined ? null : String(subjectId),
      objectId: objectId === null || objectId === undefined ? null : String(objectId),
    });
  });

  const hasFilterMetadata = filterRecords.length > 0;
  const includeDropDecisions =
    filterConfig.includeDropped || (!filterConfig.enabled && hasFilterMetadata);
  const filterDatasetKind = filterConfig.datasetKind || (hasFilterMetadata ? 'raw' : null);
  const isFilterDataset = filterConfig.enabled || hasFilterMetadata;

  const filterBuckets = new Map();
  if (hasFilterMetadata) {
    filterRecords.forEach((record) => {
      if (!record.predicate || !record.subjectId || !record.objectId) return;
      if (!includeDropDecisions && record.decision === 'drop') return;
      const effectiveSubject = record.decision === 'flip' ? record.objectId : record.subjectId;
      const effectiveObject = record.decision === 'flip' ? record.subjectId : record.objectId;
      const fingerprint = makeRelationFingerprint(
        effectiveSubject,
        effectiveObject,
        record.predicate,
        record.relationType
      );
      const existing = filterBuckets.get(fingerprint);
      if (existing) {
        existing.push(record);
      } else {
        filterBuckets.set(fingerprint, [record]);
      }
    });
  }

  const processed = [];
  const categories = new Set();
  const nodes = new Set();
  const labelMap = extractObjectLabels(rawData, metadata);
  if (objectLabelsPayload && typeof objectLabelsPayload === "object") {
    Object.entries(objectLabelsPayload).forEach(([key, value]) => {
      if (key === null || key === undefined) return;
      const id = String(key).trim();
      if (!id) return;
      if (value === null || value === undefined) return;
      const label = String(value).trim();
      if (!label) return;
      labelMap.set(id, label);
    });
  }
  let maxFrame = 0;
  let frameCount = null;
  let fpsLabel = null;

  if (metadata) {
    if (metadata.frames) {
      const parsedFrames = Number(metadata.frames);
      if (Number.isFinite(parsedFrames) && parsedFrames > 0) {
        frameCount = parsedFrames;
        maxFrame = Math.max(maxFrame, parsedFrames - 1);
      }
    }
    if (metadata.fps) {
      fpsLabel = String(metadata.fps);
    }
  }

  relationships.forEach((rel, index) => {
    if (!Array.isArray(rel) || rel.length < 4) return;
    const from = String(rel[0]);
    const to = String(rel[1]);
    const predicateRaw = rel[2];
    const predicate = predicateRaw === null || predicateRaw === undefined ? '' : String(predicateRaw);
    const intervalsRaw = rel[3];
    const categoryRaw = rel[4];
    const relationType = normaliseRelationType(categoryRaw);
    const category = canonicalCategory(categoryRaw);

    nodes.add(from);
    nodes.add(to);
    categories.add(category);

    const intervals = Array.isArray(intervalsRaw)
      ? intervalsRaw
          .map((iv) => {
            if (!Array.isArray(iv) || iv.length < 2) return null;
            const start = Math.max(0, Number(iv[0]) || 0);
            const end = Math.max(0, Number(iv[1]) || 0);
            maxFrame = Math.max(maxFrame, start, end);
            return [Math.min(start, end), Math.max(start, end)];
          })
          .filter(Boolean)
      : [];

    processed.push({
      uid: createRelationUid(index, from, to, predicate, relationType),
      index,
      from,
      to,
      predicate,
      relationType,
      intervals,
      category,
      filterMeta: null,
    });
  });

  if (categories.size === 0) {
    categories.add('default');
  }

  const sortNodeIds = (a, b) => {
    const aNum = Number(a);
    const bNum = Number(b);
    const aIsFinite = Number.isFinite(aNum);
    const bIsFinite = Number.isFinite(bNum);
    if (aIsFinite && bIsFinite) {
      return aNum - bNum;
    }
    if (aIsFinite) return -1;
    if (bIsFinite) return 1;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  };

  const descriptorMap = new Map();
  const sortedNodeIds = Array.from(nodes).sort(sortNodeIds);
  const nodeArray = sortedNodeIds.map((id, index) => {
    const ordinal = index + 1;
    const rawLabel = labelMap.get(id) || null;
    const ordinalSuffix = Number.isFinite(ordinal) ? ordinal : Number.isFinite(Number(id)) ? Number(id) : id;
    const safeSuffix = ordinalSuffix != null ? ordinalSuffix : id;
    const baseName = rawLabel && rawLabel.trim() ? rawLabel.trim() : null;
    const compactBase = baseName ? baseName.replace(/\s+/g, '') || baseName : 'Object';
    const compactLabel = `${compactBase}${safeSuffix}`;
    const displayLabel = baseName ? `${baseName} (ID ${id})` : `Object ${safeSuffix} (ID ${id})`;
    const combinedLabel = displayLabel;
    const objectLabel = baseName ? baseName : `Object ${safeSuffix}`;
    const shortLabel = compactLabel;
    const idLabel = compactLabel;
    const tooltipParts = [];
    if (baseName) {
      tooltipParts.push(baseName);
    } else {
      tooltipParts.push(`Object ${safeSuffix}`);
    }
    tooltipParts.push(`ID ${id}`);
    const tooltip = tooltipParts.join(' | ');
    const descriptor = {
      id,
      ordinal,
      rawLabel,
      objectLabel,
      combinedLabel,
      displayLabel,
      shortLabel,
      compactLabel,
      tooltip,
      idLabel,
    };
    descriptorMap.set(id, descriptor);
    return {
      id,
      ordinal,
      label: compactLabel,
      title: displayLabel,
      displayLabel,
      combinedLabel,
      rawLabel,
      tooltip,
      idLabel,
      compactLabel,
    };
  });

  const getCompactLabel = (id) => {
    const key = String(id);
    const descriptor = descriptorMap.get(key);
    if (descriptor?.compactLabel) return descriptor.compactLabel;
    const numeric = Number.isFinite(Number(key)) ? Number(key) : key;
    return `Object${numeric}`;
  };

  const getDisplayLabel = (id) => {
    const key = String(id);
    const descriptor = descriptorMap.get(key);
    if (descriptor?.displayLabel) return descriptor.displayLabel;
    const numeric = Number.isFinite(Number(key)) ? Number(key) : key;
    return `Object ${numeric}`;
  };

  if (filterRecords.length) {
    const describeId = (id) => {
      if (!id) {
        return { name: null, idLabel: null, compact: null };
      }
      const descriptor = descriptorMap.get(id);
      const fallbackName = `Object ${id}`;
      const name = descriptor?.displayLabel || descriptor?.combinedLabel || fallbackName;
      const compact = descriptor?.compactLabel || getCompactLabel(id);
      const idLabel = descriptor?.idLabel || compact || `${id}`;
      return { name, idLabel, compact };
    };
    filterRecords.forEach((record) => {
      const subjectInfo = describeId(record.subjectId);
      const objectInfo = describeId(record.objectId);
      record.subjectName = subjectInfo.name;
      record.objectName = objectInfo.name;
      record.subjectDisplay = subjectInfo.idLabel;
      record.objectDisplay = objectInfo.idLabel;
      record.subjectCompact = subjectInfo.compact;
      record.objectCompact = objectInfo.compact;
    });
  }

  const relationsById = new Map();
  processed.forEach((entry) => {
    const fromInfo = descriptorMap.get(entry.from);
    const toInfo = descriptorMap.get(entry.to);
    entry.fromOrdinal = fromInfo?.ordinal ?? null;
    entry.toOrdinal = toInfo?.ordinal ?? null;
    entry.fromLabel = fromInfo?.compactLabel || getCompactLabel(entry.from);
    entry.toLabel = toInfo?.compactLabel || getCompactLabel(entry.to);
    entry.fromShortLabel = fromInfo?.compactLabel || entry.fromLabel;
    entry.toShortLabel = toInfo?.compactLabel || entry.toLabel;
    entry.fromCombinedLabel = fromInfo?.displayLabel || getDisplayLabel(entry.from);
    entry.toCombinedLabel = toInfo?.displayLabel || getDisplayLabel(entry.to);
    if (filterRecords.length) {
      const fingerprint = makeRelationFingerprint(entry.from, entry.to, entry.predicate, entry.relationType);
      const bucket = filterBuckets.get(fingerprint);
      if (bucket && bucket.length) {
        entry.filterMeta = bucket.shift();
      }
    }
    relationsById.set(entry.uid, entry);
  });

  const descriptorObject = Object.fromEntries(descriptorMap);

  const centroidInfo = normaliseCentroidPayload(centroidsPayload, nodeArray);
  if (centroidInfo.maxFrame != null) {
    maxFrame = Math.max(maxFrame, centroidInfo.maxFrame);
  }

  if (frameCount == null) {
    frameCount = maxFrame + 1;
  }

  const fpsValue = parseFpsLabel(fpsLabel, 24);

  if (centroidsPayload) {
    if (!centroidInfo.centroids) {
      console.warn(`Centroid payload for ${manifestEntry.video_id} did not match any nodes or frames.`, {
        availableKeys: Object.keys(centroidsPayload.centroids || {}),
      });
    } else if (!Number.isFinite(centroidInfo.imageWidth) || !Number.isFinite(centroidInfo.imageHeight)) {
      console.warn(`Centroid payload for ${manifestEntry.video_id} missing dimension metadata; using observed bounds fallback.`, {
        bounds: centroidInfo.bounds,
      });
    }
  }

  return {
    manifest: manifestEntry,
    raw: rawData,
    relations: processed,
    categories: Array.from(categories).sort(),
    nodes: nodeArray,
    objectDisplay: descriptorObject,
    maxFrame,
    sliderMax: Math.max(maxFrame, Number.isFinite(frameCount) ? frameCount - 1 : maxFrame),
    description: rawData.description || 'No description provided.',
    frameTemplate: manifestEntry.frame_template,
    metadataUrl: manifestEntry.metadata_url,
    metadata,
    frameCount,
    fpsLabel,
    objectLabels: Object.fromEntries(labelMap),
    centroids: centroidInfo.centroids,
    imageWidth: centroidInfo.imageWidth,
    imageHeight: centroidInfo.imageHeight,
    centroidOriginX: centroidInfo.originX,
    centroidOriginY: centroidInfo.originY,
    centroidBounds: centroidInfo.bounds,
    fpsValue,
    baseVideoId,
    isFiltered: isFilterDataset,
    filterDatasetKind,
    includeDroppedDecisions: includeDropDecisions,
    filterEvaluationCount: filterRecords.length,
    hasFilterMetadata,
    relationMap: relationsById,
  };
}

function getObjectDisplayDescriptor(data, objectId) {
  if (!data || objectId == null) return null;
  const key = String(objectId);
  const fromMap = data.objectDisplay;
  if (fromMap && Object.prototype.hasOwnProperty.call(fromMap, key)) {
    return fromMap[key];
  }

  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const node = nodes.find((entry) => String(entry.id) === key) || null;
  const ordinalCandidate = Number(node?.ordinal);
  const ordinal = Number.isFinite(ordinalCandidate) && ordinalCandidate > 0 ? ordinalCandidate : null;
  const rawLabel = data.objectLabels?.[key] || null;
  const suffix = Number.isFinite(ordinalCandidate) && ordinalCandidate > 0 ? ordinalCandidate : Number.isFinite(Number(key)) ? Number(key) : key;
  const baseName = rawLabel && rawLabel.trim() ? rawLabel.trim() : null;
  const compactBase = baseName ? baseName.replace(/\s+/g, '') || baseName : 'Object';
  const compactLabel = `${compactBase}${suffix}`;
  const objectLabel = baseName ? `${baseName}` : `Object ${suffix}`;
  const displayLabel = baseName ? `${baseName} (ID ${key})` : `Object ${suffix} (ID ${key})`;
  const combinedLabel = displayLabel;
  const shortLabel = compactLabel;
  const tooltipParts = [];
  if (baseName) {
    tooltipParts.push(baseName);
  } else {
    tooltipParts.push(`Object ${suffix}`);
  }
  tooltipParts.push(`ID ${key}`);
  const tooltip = tooltipParts.join(' | ');
  return {
    id: key,
    ordinal,
    rawLabel,
    objectLabel,
    combinedLabel,
    displayLabel,
    shortLabel,
    compactLabel,
    tooltip,
    idLabel: compactLabel,
  };
}

function formatObjectLabel(data, objectId, variant = 'display') {
  const descriptor = getObjectDisplayDescriptor(data, objectId);
  if (!descriptor) {
    const key = String(objectId);
    if (variant === 'compact') {
      return Number.isFinite(Number(key)) ? `Object${Number(key)}` : `Object${key}`;
    }
    if (variant === 'short') {
      return key;
    }
    if (variant === 'tooltip') {
      return `ID ${key}`;
    }
    if (variant === 'combined') {
      return `Object ${key}`;
    }
    return `Object ${key}`;
  }

  if (variant === 'compact') {
    return descriptor.compactLabel || descriptor.shortLabel || descriptor.idLabel || descriptor.displayLabel || `Object ${descriptor.id}`;
  }
  if (variant === 'short') {
    return descriptor.shortLabel || descriptor.compactLabel || descriptor.idLabel || `Object ${descriptor.id}`;
  }
  if (variant === 'combined') {
    return descriptor.combinedLabel || descriptor.displayLabel || `Object ${descriptor.id}`;
  }
  if (variant === 'tooltip') {
    return descriptor.tooltip || descriptor.displayLabel || descriptor.combinedLabel || `ID ${descriptor.id}`;
  }
  return descriptor.displayLabel || descriptor.combinedLabel || `Object ${descriptor.id}`;
}

function destroyNetwork() {
  if (state.network) {
    state.network.destroy();
    state.network = null;
    state.nodesDataset = null;
    state.edgesDataset = null;
  }
  state.edgeRelationMap = new Map();
  state.relationEdgeMap = new Map();
  state.suppressNetworkSelect = false;
  state.selectedRelationGroup = null;
  state.tableFocusPending = false;
  state.nodeCentroids = null;
  state.centroidFrameIndex = new Map();
  state.imageSize = null;
  state.fallbackPositions = null;
  if (state.resizeHandler) {
    window.removeEventListener('resize', state.resizeHandler);
    state.resizeHandler = null;
  }
}

function initialiseNetwork(nodes) {
  destroyNetwork();
  const container = dom.network;
  container.innerHTML = '';
  if (!container.dataset.lockedScroll) {
    container.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
      },
      { passive: false }
    );
    container.dataset.lockedScroll = 'true';
  }

  const fallback = computeCircularLayout(nodes, container);
  state.fallbackPositions = fallback;

  const nodeData = nodes.map((node) => {
    const fallbackPos = fallback.get(String(node.id)) || { x: 0, y: 0 };
    return {
      id: node.id,
      label: node.label,
      x: fallbackPos.x,
      y: fallbackPos.y,
      physics: false,
      hidden: true,
    };
  });

  const data = {
    nodes: new vis.DataSet(nodeData),
    edges: new vis.DataSet([]),
  };

  const options = {
    physics: false,
    interaction: {
      hover: true,
      dragNodes: true,
      dragView: false,
      zoomView: false,
      navigationButtons: false,
      keyboard: false,
    },
    nodes: {
      shape: 'dot',
      size: 14,
      borderWidth: 2,
      color: {
        background: '#3b82f6',
        border: '#1d4ed8',
        highlight: { background: '#f97316', border: '#ea580c' },
        hover: { background: '#f97316', border: '#ea580c' },
      },
      font: {
        color: '#ffffff',
        face: 'Inter',
        size: 16,
        align: 'horizontal',
        background: '#000000',
        strokeWidth: 0,
      },
    },
    edges: {
      width: 2,
      smooth: {
        type: 'cubicBezier',
        roundness: 0.25,
      },
      arrows: {
        to: { enabled: true, scaleFactor: 1.35, type: 'arrow' },
      },
      arrowStrikethrough: false,
      shadow: {
        enabled: true,
        color: 'rgba(15, 23, 42, 0.35)',
        size: 6,
        x: 2,
        y: 2,
      },
      font: {
        face: 'Inter',
        size: 14,
        align: 'horizontal',
      },
    },
  };

  state.network = new vis.Network(container, data, options);
  state.nodesDataset = data.nodes;
  state.edgesDataset = data.edges;

  if (state.network) {
    state.network.on('selectEdge', handleNetworkEdgeSelection);
    state.network.on('deselectEdge', handleNetworkEdgeDeselection);
  }

  const handleResize = () => {
    if (!state.network || !state.nodesDataset) return;
    state.fallbackPositions = computeCircularLayout(nodes, container);
    updateNetwork();
  };
  window.addEventListener('resize', handleResize);
  state.resizeHandler = handleResize;
}

function getActiveRelations() {
  const data = state.currentVideoData;
  if (!data) return [];
  const time = getRenderFrame(state.currentTime);
  const enabled = state.enabledCategories;
  return data.relations.filter((rel) => {
    if (!enabled.has(rel.category)) return false;
    return rel.intervals.some(([start, end]) => time >= start && time <= end);
  });
}

// Locate or interpolate a centroid for the requested frame so sparse data still renders smoothly.
function getCentroidPoint(nodeId, frame) {
  const centroids = state.nodeCentroids;
  if (!(centroids instanceof Map) || centroids.size === 0) return null;

  const id = String(nodeId);
  const frameMap = centroids.get(id);
  if (!(frameMap instanceof Map) || frameMap.size === 0) return null;

  const direct = frameMap.get(frame);
  if (direct) return direct;

  let frameIndex = state.centroidFrameIndex.get(id);
  if (!frameIndex) {
    frameIndex = Array.from(frameMap.keys()).sort((a, b) => a - b);
    state.centroidFrameIndex.set(id, frameIndex);
  }

  if (!frameIndex.length) return null;

  let left = 0;
  let right = frameIndex.length - 1;

  while (left <= right) {
    const mid = (left + right) >> 1;
    const value = frameIndex[mid];
    if (value === frame) {
      const match = frameMap.get(value);
      if (match) return match;
      break;
    }
    if (value < frame) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  const nextIdx = left;
  const prevIdx = right;
  const prevFrame = prevIdx >= 0 ? frameIndex[prevIdx] : null;
  const nextFrame = nextIdx < frameIndex.length ? frameIndex[nextIdx] : null;

  if (prevFrame == null && nextFrame == null) {
    return null;
  }

  if (nextFrame == null) {
    return frameMap.get(prevFrame) || null;
  }

  if (prevFrame == null) {
    return frameMap.get(nextFrame) || null;
  }

  const prevPoint = frameMap.get(prevFrame);
  const nextPoint = frameMap.get(nextFrame);
  if (!prevPoint || !nextPoint) {
    return prevPoint || nextPoint || null;
  }

  const span = nextFrame - prevFrame;
  if (!Number.isFinite(span) || span === 0) {
    return prevPoint;
  }

  const alpha = (frame - prevFrame) / span;
  return {
    x: prevPoint.x + (nextPoint.x - prevPoint.x) * alpha,
    y: prevPoint.y + (nextPoint.y - prevPoint.y) * alpha,
  };
}

function synchroniseNetworkSelection(relationId) {
  if (!state.network) return;
  const edgeMap = state.relationEdgeMap;
  const edgeId = relationId && edgeMap instanceof Map ? edgeMap.get(relationId) : null;
  state.suppressNetworkSelect = true;
  try {
    if (edgeId) {
      state.network.selectNodes([]);
      state.network.selectEdges([edgeId]);
    } else {
      state.network.unselectAll();
    }
  } catch (error) {
    console.debug('Network selection sync failed:', error);
  } finally {
    scheduleMicrotask(() => {
      state.suppressNetworkSelect = false;
    });
  }
}

function selectRelationByEdgeId(edgeId, options = {}) {
  if (!edgeId) return;
  const { scrollIntoView = true } = options;
  const edgeInfo = state.edgeRelationMap instanceof Map ? state.edgeRelationMap.get(edgeId) : null;
  if (!edgeInfo) {
    state.selectedRelationGroup = null;
    debugRelationEvent('select:edge-missing', {
      edgeId,
      datasetKind: state.currentVideoData?.filterDatasetKind || null,
    });
    return;
  }
  const relations = Array.isArray(edgeInfo.relations) ? edgeInfo.relations : [];
  const primary = edgeInfo.primary || relations.find((rel) => Boolean(rel?.filterMeta)) || relations[0] || null;
  if (!primary) {
    state.selectedRelationGroup = null;
    debugRelationEvent('select:edge-empty', {
      edgeId,
      datasetKind: state.currentVideoData?.filterDatasetKind || null,
      relationCount: relations.length,
    });
    return;
  }
  debugRelationEvent('select:edge', {
    edgeId,
    relationId: primary.uid || null,
    datasetKind: state.currentVideoData?.filterDatasetKind || null,
  });
  setSelectedRelationId(primary.uid, { focus: false, scrollIntoView });
}

function handleNetworkEdgeSelection(params) {
  if (state.suppressNetworkSelect) return;
  if (!state.currentVideoData?.isFiltered) return;
  const edges = Array.isArray(params?.edges) ? params.edges : [];
  if (!edges.length) {
    setSelectedRelationId(null);
    return;
  }
  selectRelationByEdgeId(edges[0], { scrollIntoView: true });
}

function handleNetworkEdgeDeselection() {
  if (state.suppressNetworkSelect) return;
  if (!state.currentVideoData?.isFiltered) return;
  setSelectedRelationId(null);
}

function updateNodePositions(activeNodeIds) {
  if (!state.nodesDataset || !state.currentVideoData) return;
  const container = dom.network;
  if (!container) return;

  const centroids = state.nodeCentroids;
  const hasCentroids = centroids instanceof Map && centroids.size > 0;
  const imgWidth = state.imageSize?.width;
  const imgHeight = state.imageSize?.height;
  const originX = Number.isFinite(state.imageSize?.originX) ? state.imageSize.originX : 0;
  const originY = Number.isFinite(state.imageSize?.originY) ? state.imageSize.originY : 0;
  const allowCentroidPlacement = hasCentroids && Number.isFinite(imgWidth) && Number.isFinite(imgHeight) && imgWidth > 0 && imgHeight > 0;
  const fallback = state.fallbackPositions instanceof Map ? state.fallbackPositions : new Map();

  let activeSet = activeNodeIds instanceof Set ? activeNodeIds : null;
  if (!activeSet) {
    activeSet = new Set();
    getActiveRelations().forEach((rel) => {
      activeSet.add(rel.from);
      activeSet.add(rel.to);
    });
  }

  const frame = getRenderFrame(state.currentTime);
  const containerWidth = Math.max(container.clientWidth, 1);
  const containerHeight = Math.max(container.clientHeight, 1);
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  if (allowCentroidPlacement) {
    const s1 = containerWidth / imgWidth;
    const s2 = containerHeight / imgHeight;
    scale = Math.min(s1, s2);
    const dispW = imgWidth * scale;
    const dispH = imgHeight * scale;
    offsetX = (containerWidth - dispW) / 2;
    offsetY = (containerHeight - dispH) / 2;
  }

  const updates = [];
  const debugInfo = state.debug.enabled
    ? {
        frame,
        containerWidth,
        containerHeight,
        imgWidth,
        imgHeight,
        originX,
        originY,
        bounds: state.imageSize?.bounds || null,
        scale,
        offsetX,
        offsetY,
        centroidEnabled: allowCentroidPlacement,
        counts: { centroid: 0, fallback: 0, hidden: 0, inactive: 0, active: 0 },
        samples: [],
      }
    : null;
  const debugSampleLimit = 6;

  state.currentVideoData.nodes.forEach((node) => {
    const id = String(node.id);
    const isActive = activeSet.size === 0 ? false : activeSet.has(id);
    let hidden = true;
    let x = 0;
    let y = 0;

    let point = null;
    if (isActive && allowCentroidPlacement) {
      point = getCentroidPoint(id, frame);
    }

    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      const baseX = point.x - originX;
      const baseY = point.y - originY;
      const screenX = offsetX + baseX * scale;
      const screenY = offsetY + baseY * scale;
      x = screenX - containerWidth / 2;
      y = screenY - containerHeight / 2;
      hidden = false;
      if (debugInfo) {
        debugInfo.counts.centroid += 1;
        debugInfo.counts.active += 1;
        if (debugInfo.samples.length < debugSampleLimit) {
          debugInfo.samples.push({
            id,
            source: 'centroid',
            frame,
            worldX: point.x,
            worldY: point.y,
            localX: baseX,
            localY: baseY,
            screenX,
            screenY,
          });
        }
      }
    } else if (isActive) {
      if (debugInfo) {
        debugInfo.counts.active += 1;
      }
      const fallbackPos = fallback.get(id);
      if (fallbackPos) {
        x = fallbackPos.x;
        y = fallbackPos.y;
        hidden = false;
        if (debugInfo) {
          debugInfo.counts.fallback += 1;
          if (debugInfo.samples.length < debugSampleLimit) {
            debugInfo.samples.push({
              id,
              source: 'fallback',
              frame,
              worldX: fallbackPos.x,
              worldY: fallbackPos.y,
              localX: fallbackPos.x,
              localY: fallbackPos.y,
              screenX: fallbackPos.x,
              screenY: fallbackPos.y,
            });
          }
        }
      } else if (debugInfo) {
        debugInfo.counts.hidden += 1;
      }
    }

    if (!isActive) {
      if (debugInfo) {
        debugInfo.counts.inactive += 1;
      }
      if (allowCentroidPlacement) {
        hidden = true;
      } else {
        const fallbackPos = fallback.get(id);
        if (fallbackPos) {
          x = fallbackPos.x;
          y = fallbackPos.y;
        }
      }
      if (debugInfo && hidden) {
        debugInfo.counts.hidden += 1;
      }
    }

    updates.push({ id: node.id, x, y, hidden });
  });

  if (updates.length) {
    state.nodesDataset.update(updates);
  }
  if (state.network) {
    state.network.redraw();
  }
  if (debugInfo) {
    renderDebugOverlay(debugInfo);
  }
}

function updateNetwork() {
  if (!state.edgesDataset) return;
  const data = state.currentVideoData;
  const active = getActiveRelations();

  const activeNodeIds = new Set();
  active.forEach((rel) => {
    activeNodeIds.add(rel.from);
    activeNodeIds.add(rel.to);
  });

  const pairs = new Map();
  active.forEach((rel) => {
    const fromKey = String(rel.from);
    const toKey = String(rel.to);
    const sameNode = fromKey === toKey;

    if (sameNode) {
      const key = `self:${fromKey}`;
      if (!pairs.has(key)) {
        pairs.set(key, {
          self: true,
          node: rel.from,
          nodeLabel: rel.fromLabel || formatObjectLabel(data, rel.from, 'compact'),
          relations: [],
        });
      }
      const entry = pairs.get(key);
      if (!entry.nodeLabel && rel.fromLabel) {
        entry.nodeLabel = rel.fromLabel;
      }
      entry.relations.push(rel);
      return;
    }

    const order = fromKey < toKey;
    const key = order ? `${fromKey}↔${toKey}` : `${toKey}↔${fromKey}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        self: false,
        nodeA: order ? rel.from : rel.to,
        nodeB: order ? rel.to : rel.from,
        nodeALabel: null,
        nodeBLabel: null,
        forward: [],
        reverse: [],
      });
    }
    const entry = pairs.get(key);
    const fromLabel = rel.fromLabel || formatObjectLabel(data, rel.from, 'compact');
    const toLabel = rel.toLabel || formatObjectLabel(data, rel.to, 'compact');

    if (!entry.nodeALabel) {
      if (rel.from === entry.nodeA) {
        entry.nodeALabel = fromLabel;
      } else if (rel.to === entry.nodeA) {
        entry.nodeALabel = toLabel;
      }
    }
    if (!entry.nodeBLabel) {
      if (rel.from === entry.nodeB) {
        entry.nodeBLabel = fromLabel;
      } else if (rel.to === entry.nodeB) {
        entry.nodeBLabel = toLabel;
      }
    }

    if (rel.from === entry.nodeA && rel.to === entry.nodeB) {
      entry.forward.push(rel);
    } else {
      entry.reverse.push(rel);
    }
  });

  const edges = [];
  const edgeRelationMap = new Map();
  const relationEdgeMap = new Map();

  pairs.forEach((entry, key) => {
    const edgeId = `edge-${key}`;
    const relationsList = entry.self
      ? entry.relations.slice()
      : entry.forward.concat(entry.reverse);
    const primaryRelation =
      relationsList.find((rel) => rel?.filterMeta) || relationsList[0] || null;

    if (relationsList.length) {
      edgeRelationMap.set(edgeId, {
        relations: relationsList,
        primary: primaryRelation,
        self: entry.self,
      });
      relationsList.forEach((rel) => {
        if (rel?.uid) {
          relationEdgeMap.set(rel.uid, edgeId);
        }
      });
    } else {
      edgeRelationMap.set(edgeId, {
        relations: [],
        primary: null,
        self: entry.self,
      });
    }

    let style = CATEGORY_STYLES.default;
    if (primaryRelation && relationsList.length === 1) {
      style = CATEGORY_STYLES[primaryRelation.category] || CATEGORY_STYLES.default;
    }

    const lines = [];

    if (entry.self) {
      const label = entry.nodeLabel || formatObjectLabel(data, entry.node, 'compact');
      lines.push(`${label} -> ${label}:`);
      entry.relations.forEach((rel) => {
        const predicate = rel.predicate ? String(rel.predicate) : '—';
        lines.push(`- ${predicate}`);
      });

      edges.push({
        id: edgeId,
        from: entry.node,
        to: entry.node,
        label: lines.join('\n'),
        color: { color: style.edge, highlight: style.edge },
        font: {
          color: '#0f172a',
          strokeColor: 'rgba(255,255,255,0.95)',
          strokeWidth: 4,
          face: 'Inter',
          size: 14,
          align: 'horizontal',
        },
        arrows: { to: { enabled: true, scaleFactor: 1.35, type: 'arrow' } },
      });
      return;
    }

    const labelA = entry.nodeALabel || formatObjectLabel(data, entry.nodeA, 'compact');
    const labelB = entry.nodeBLabel || formatObjectLabel(data, entry.nodeB, 'compact');

    if (entry.forward.length) {
      lines.push(`${labelA} -> ${labelB}:`);
      entry.forward.forEach((rel) => {
        const predicate = rel.predicate ? String(rel.predicate) : '—';
        lines.push(`- ${predicate}`);
      });
    }
    if (entry.forward.length && entry.reverse.length) {
      lines.push('');
    }
    if (entry.reverse.length) {
      lines.push(`${labelB} -> ${labelA}:`);
      entry.reverse.forEach((rel) => {
        const predicate = rel.predicate ? String(rel.predicate) : '—';
        lines.push(`- ${predicate}`);
      });
    }

    const hasForward = entry.forward.length > 0;
    const hasReverse = entry.reverse.length > 0;

    let edgeFrom = entry.nodeA;
    let edgeTo = entry.nodeB;
    const arrows = { to: { enabled: true, scaleFactor: 1.35, type: 'arrow' } };

    if (hasForward && hasReverse) {
      arrows.from = { enabled: true, scaleFactor: 1.35, type: 'arrow' };
    } else if (!hasForward && hasReverse) {
      edgeFrom = entry.nodeB;
      edgeTo = entry.nodeA;
    }

    edges.push({
      id: edgeId,
      from: edgeFrom,
      to: edgeTo,
      label: lines.join('\n'),
      color: { color: style.edge, highlight: style.edge },
      font: {
        color: '#0f172a',
        strokeColor: 'rgba(255,255,255,0.95)',
        strokeWidth: 4,
        face: 'Inter',
        size: 14,
        align: 'horizontal',
      },
      arrows,
    });
  });

  state.edgeRelationMap = edgeRelationMap;
  state.relationEdgeMap = relationEdgeMap;

  state.edgesDataset.clear();
  if (edges.length) {
    state.edgesDataset.add(edges);
  }

  updateNodePositions(activeNodeIds);
}

function getRelationById(relationId) {
  if (!relationId) return null;
  const data = state.currentVideoData;
  if (!data) return null;
  const id = String(relationId);
  if (data.relationMap instanceof Map && data.relationMap.size > 0) {
    const fromMap = data.relationMap.get(id);
    if (fromMap) return fromMap;
  }
  const relations = Array.isArray(data.relations) ? data.relations : [];
  return relations.find((entry) => entry.uid === id) || null;
}

function setSelectedRelationId(relationId, options = {}) {
  const { focus = false, scrollIntoView = false, focusTable = false } = options;
  const data = state.currentVideoData;
  state.tableFocusPending = Boolean(focusTable);
  if (!data || !data.isFiltered) {
    if (state.selectedRelation) {
      state.selectedRelation = null;
      renderRelationDetails();
    }
    state.selectedRelationGroup = null;
    state.tableFocusPending = false;
    debugRelationEvent('select:cleared', {
      reason: 'not-filter-dataset',
      datasetKind: data?.filterDatasetKind || null,
    });
    synchroniseNetworkSelection(null);
    return;
  }
  if (!relationId) {
    if (state.selectedRelation) {
      state.selectedRelation = null;
      renderActiveRelations();
    }
    state.selectedRelationGroup = null;
    state.tableFocusPending = false;
    debugRelationEvent('select:cleared', {
      reason: 'empty-id',
      datasetKind: data.filterDatasetKind || null,
    });
    synchroniseNetworkSelection(null);
    return;
  }
  const relation = getRelationById(relationId);
  if (!relation) {
    debugRelationEvent('select:missing', {
      relationId,
      datasetKind: data.filterDatasetKind || null,
      reason: 'relation-not-found',
    });
    if (state.selectedRelation) {
      state.selectedRelation = null;
      renderActiveRelations();
    }
    state.selectedRelationGroup = null;
    state.tableFocusPending = false;
    synchroniseNetworkSelection(null);
    return;
  }
  let shouldFocus = false;
  const isDeselection = state.selectedRelation?.id === relation.uid;
  debugRelationEvent('select:request', {
    relationId: relation.uid,
    datasetKind: data.filterDatasetKind || null,
    hasMeta: Boolean(relation.filterMeta),
    decision: relation.filterMeta?.decision || null,
    action: isDeselection ? 'deselect' : 'select',
    subject: relation.from,
    object: relation.to,
    predicate: relation.predicate,
  });
  if (isDeselection) {
    state.selectedRelation = null;
    state.selectedRelationGroup = null;
    state.tableFocusPending = false;
  } else {
    state.selectedRelation = {
      id: relation.uid,
      relation,
      meta: relation.filterMeta || null,
    };
    shouldFocus = focus;
    let groupEdgeId = null;
    let groupRelations = [];
    if (state.relationEdgeMap instanceof Map) {
      groupEdgeId = state.relationEdgeMap.get(relation.uid) || null;
    }
    if (groupEdgeId && state.edgeRelationMap instanceof Map) {
      const groupEntry = state.edgeRelationMap.get(groupEdgeId);
      if (Array.isArray(groupEntry?.relations) && groupEntry.relations.length) {
        groupRelations = groupEntry.relations;
      }
    }
    if (!groupRelations.length && data?.relations) {
      groupRelations = data.relations.filter(
        (candidate) => candidate.from === relation.from && candidate.to === relation.to
      );
    }
    if (!groupRelations.length) {
      groupRelations = [relation];
    }
    state.selectedRelationGroup = {
      edgeId: groupEdgeId,
      relations: groupRelations,
    };
  }
  debugRelationEvent('select:result', {
    relationId: state.selectedRelation?.id || null,
   hasSelection: Boolean(state.selectedRelation),
    hasMeta: Boolean(state.selectedRelation?.meta),
    datasetKind: data.filterDatasetKind || null,
    decision: state.selectedRelation?.meta?.decision || null,
  });
  renderActiveRelations();
  synchroniseNetworkSelection(state.selectedRelation?.id || null);
  if (shouldFocus && typeof window !== 'undefined') {
    scheduleMicrotask(() => {
      const selector = `[data-rel-id="${relation.uid}"]`;
      const element = dom.activeRelations?.querySelector(selector);
      if (element && typeof element.focus === 'function') {
        element.focus();
      }
    });
  }
}

function renderRelationDetails() {
  const panel = dom.relationDetailsPanel;
  const status = dom.relationDetailsStatus;
  const tableWrapper = dom.relationDetailsTableWrapper;
  const tableBody = dom.relationDetailsTableBody;
  const table = dom.relationDetailsTable;
  const data = state.currentVideoData;
  const toggle = dom.decisionColumnsToggle;
  const toggleContainer = dom.decisionColumnsToggleContainer;

  if (!panel) return;

  if (table) {
    table.classList.toggle('decision-table--compact', !state.showDecisionColumns);
  }
  let toggleShouldBeVisible = false;
  let toggleShouldBeDisabled = true;
  const applyToggleState = () => {
    if (toggleContainer) {
      toggleContainer.hidden = !toggleShouldBeVisible;
    }
    if (toggle) {
      toggle.disabled = toggleShouldBeDisabled;
      toggle.checked = state.showDecisionColumns;
    }
  };

  if (!data || !data.isFiltered) {
    panel.hidden = true;
    if (status) {
      status.hidden = false;
      status.textContent = 'Filter metadata is available only for filtered runs.';
    }
    debugRelationEvent('details:hidden', {
      reason: 'not-filter-dataset',
      datasetKind: data?.filterDatasetKind || null,
    });
    if (tableWrapper) {
      tableWrapper.hidden = true;
    }
    if (tableBody) {
      tableBody.innerHTML = '';
    }
    applyToggleState();
    return;
  }

  panel.hidden = false;
  const hasEvaluations =
    (Number.isFinite(data.filterEvaluationCount) ? data.filterEvaluationCount > 0 : false) ||
    (Array.isArray(data.relations) && data.relations.some((entry) => entry.filterMeta));

  if (!hasEvaluations) {
    if (status) {
      status.hidden = false;
      status.textContent = 'No filter metadata found for this run.';
    }
    debugRelationEvent('details:hidden', {
      reason: 'no-evaluations',
      datasetKind: data.filterDatasetKind || null,
    });
    if (tableWrapper) {
      tableWrapper.hidden = true;
    }
    if (tableBody) {
      tableBody.innerHTML = '';
    }
    applyToggleState();
    return;
  }

  const selection = state.selectedRelation;
  const group = state.selectedRelationGroup;
  const relations = Array.isArray(group?.relations) && group.relations.length
    ? group.relations
    : selection
    ? [selection.relation]
    : [];

  if (!selection) {
    if (status) {
      status.hidden = false;
      status.textContent = 'Select a relationship to view filter reasoning.';
    }
    debugRelationEvent('details:hidden', {
      reason: 'no-selection',
      datasetKind: data.filterDatasetKind || null,
    });
    if (tableWrapper) {
      tableWrapper.hidden = true;
    }
    if (tableBody) {
      tableBody.innerHTML = '';
    }
    toggleShouldBeDisabled = false;
    applyToggleState();
    return;
  }

  if (!relations.length) {
    if (status) {
      status.hidden = false;
      status.textContent = 'No relationships found for this selection.';
    }
    if (tableWrapper) {
      tableWrapper.hidden = true;
    }
    if (tableBody) {
      tableBody.innerHTML = '';
    }
    debugRelationEvent('details:hidden', {
      reason: 'no-relations-for-edge',
      datasetKind: data.filterDatasetKind || null,
      relationId: selection.id,
    });
    toggleShouldBeDisabled = false;
    applyToggleState();
    return;
  }

  if (status) {
    status.hidden = true;
  }
  if (tableWrapper) {
    tableWrapper.hidden = false;
  }

  if (tableBody) {
    tableBody.innerHTML = '';
    const createCell = (value, className) => {
      const td = document.createElement('td');
      if (className) td.className = className;
      td.textContent = value != null && value !== '' ? String(value) : '—';
      return td;
    };
    let selectedRowElement = null;

    relations.forEach((rel) => {
      const meta = rel.filterMeta || {};
      const subjectId = rel.from;
      const objectId = rel.to;
      const fallbackSubjectCompact =
        subjectId != null ? formatObjectLabel(data, subjectId, 'compact') : null;
      const fallbackObjectCompact =
        objectId != null ? formatObjectLabel(data, objectId, 'compact') : null;
      const subjectCompact =
        meta.subjectCompact ||
        meta.subjectDisplay ||
        meta.subjectName ||
        meta.subject_name ||
        fallbackSubjectCompact;
      const objectCompact =
        meta.objectCompact ||
        meta.objectDisplay ||
        meta.objectName ||
        meta.object_name ||
        fallbackObjectCompact;

      const decision = meta.decision || (rel.filterMeta ? rel.filterMeta.decision : null) || '—';
      const label = meta.label || (rel.filterMeta ? rel.filterMeta.label : null) || '—';
      const explanation = meta.explanation || (rel.filterMeta ? rel.filterMeta.explanation : null) || '—';

      const row = document.createElement('tr');
      row.classList.add('decision-row');
      row.dataset.relId = rel.uid || '';
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      const ariaLabelParts = [
        decision,
        subjectCompact || subjectId || 'subject',
        rel.predicate || 'related to',
        objectCompact || objectId || 'object',
      ].filter(Boolean);
      row.setAttribute('aria-label', ariaLabelParts.join(' '));
      const isSelectedRow = Boolean(selection?.id && rel.uid === selection.id);
      if (isSelectedRow) {
        row.classList.add('decision-row--selected');
        selectedRowElement = row;
      }
      row.setAttribute('aria-pressed', isSelectedRow ? 'true' : 'false');

      row.appendChild(createCell(decision, 'decision-cell decision-cell--decision'));
      row.appendChild(createCell(label, 'decision-cell decision-cell--label'));
      row.appendChild(createCell(subjectId, 'decision-cell decision-cell--subject-id'));
      row.appendChild(createCell(subjectCompact, 'decision-cell decision-cell--subject-name'));
      row.appendChild(createCell(rel.predicate || '—', 'decision-cell decision-cell--predicate'));
      row.appendChild(createCell(objectId, 'decision-cell decision-cell--object-id'));
      row.appendChild(createCell(objectCompact, 'decision-cell decision-cell--object-name'));
      const explanationCell = createCell(explanation, 'decision-cell decision-cell--explanation');
      explanationCell.title = explanation || '';
      row.appendChild(explanationCell);

      tableBody.appendChild(row);
    });

    toggleShouldBeVisible = true;
    toggleShouldBeDisabled = false;
    if (selectedRowElement && tableWrapper && state.tableFocusPending) {
      scheduleMicrotask(() => {
        if (tableWrapper.contains(selectedRowElement)) {
          if (typeof selectedRowElement.focus === 'function') {
            try {
              selectedRowElement.focus({ preventScroll: true });
            } catch (error) {
              selectedRowElement.focus();
            }
          }
        }
        state.tableFocusPending = false;
      });
    } else {
      state.tableFocusPending = false;
    }
  }

  if (tableWrapper) {
    tableWrapper.hidden = false;
  }
  applyToggleState();
  debugRelationEvent('details:rendered', {
    relationId: selection.id,
    relationCount: relations.length,
    datasetKind: data.filterDatasetKind || null,
    edgeId: group?.edgeId || null,
  });
}

function renderActiveRelations() {
  const container = dom.activeRelations;
  const active = getActiveRelations();
  const data = state.currentVideoData;
  if (!active.length) {
    container.innerHTML = '<p class="empty-state">No active relationships for this frame and category selection.</p>';
    renderRelationDetails();
    return;
  }

  const selectedId = state.selectedRelation?.id || null;
  const isFiltered = Boolean(data?.isFiltered);

  const html = active
    .map((rel) => {
      const style = CATEGORY_STYLES[rel.category] || CATEGORY_STYLES.default;
      const catLabel = formatCategoryLabel(rel.category);
      const ranges = rel.intervals
        .map(([start, end]) => `frames ${start}–${end}`)
        .join(', ');
      const from = rel.fromLabel || formatObjectLabel(data, rel.from, 'compact');
      const to = rel.toLabel || formatObjectLabel(data, rel.to, 'compact');
      const predicateColor = style.edge || style.text || 'var(--text)';
      const isSelected = rel.uid === selectedId;
      const hasMeta = Boolean(rel.filterMeta);
      const interactiveAttrs = isFiltered
        ? ` role="button" tabindex="0" aria-pressed="${isSelected ? 'true' : 'false'}"`
        : '';
      const classes = [
        'relation-item',
        isSelected ? 'relation-item--selected' : '',
        isFiltered && !hasMeta ? 'relation-item--disabled' : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `
        <div class="${classes}" data-category="${rel.category}" data-rel-id="${rel.uid}" data-has-meta="${hasMeta ? 'true' : 'false'}"${interactiveAttrs}>
          <div class="relation-item__header">
            <span class="relation-item__label">
              <span class="relation-item__category" style="background:${style.background};color:${style.text}">${catLabel}</span>
              <span class="relation-item__predicate" style="color:${predicateColor}">${rel.predicate}</span>
            </span>
          </div>
          <div class="relation-item__entities">${from} -> ${to}</div>
          <div class="relation-item__time">${ranges}</div>
        </div>
      `;
    })
    .join('');
  container.innerHTML = html;
  renderRelationDetails();
}

function getRelationItemFromTarget(target) {
  if (!target || !(target instanceof Element)) return null;
  return target.closest('.relation-item');
}

function handleRelationListClick(event) {
  if (!state.currentVideoData?.isFiltered) return;
  const item = getRelationItemFromTarget(event.target);
  if (!item) return;
  const relationId = item.dataset.relId;
  if (!relationId) return;
  const relation = getRelationById(relationId);
  debugRelationEvent('click', {
    relationId,
    hasRelation: Boolean(relation),
    hasMeta: Boolean(relation?.filterMeta),
    datasetKind: state.currentVideoData.filterDatasetKind || null,
    subject: relation?.from || null,
    object: relation?.to || null,
    predicate: relation?.predicate || null,
  });
  event.preventDefault();
  setSelectedRelationId(relationId);
}

function handleRelationListKeydown(event) {
  if (!state.currentVideoData?.isFiltered) return;
  const key = event.key;
  if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return;
  const item = getRelationItemFromTarget(event.target);
  if (!item) return;
  const relationId = item.dataset.relId;
  if (!relationId) return;
  const relation = getRelationById(relationId);
  debugRelationEvent('keydown', {
    key,
    relationId,
    hasRelation: Boolean(relation),
    hasMeta: Boolean(relation?.filterMeta),
    datasetKind: state.currentVideoData.filterDatasetKind || null,
    subject: relation?.from || null,
    object: relation?.to || null,
    predicate: relation?.predicate || null,
  });
  event.preventDefault();
  setSelectedRelationId(relationId, { focus: true });
}

function getDecisionRowFromTarget(target) {
  if (!target || !(target instanceof Element)) return null;
  return target.closest('tr[data-rel-id]');
}

function handleDecisionTableClick(event) {
  if (!state.currentVideoData?.isFiltered) return;
  const row = getDecisionRowFromTarget(event.target);
  if (!row) return;
  const relationId = row.dataset.relId;
  if (!relationId) return;
  event.preventDefault();
  setSelectedRelationId(relationId, { focus: false, scrollIntoView: false, focusTable: true });
}

function handleDecisionTableKeydown(event) {
  if (!state.currentVideoData?.isFiltered) return;
  const key = event.key;
  if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return;
  const row = getDecisionRowFromTarget(event.target);
  if (!row) return;
  const relationId = row.dataset.relId;
  if (!relationId) return;
  event.preventDefault();
  setSelectedRelationId(relationId, { focus: false, scrollIntoView: false, focusTable: true });
}

function renderFrameDisplay() {
  const data = state.currentVideoData;
  if (!data) {
    dom.frameDisplay.textContent = 'Frame 0 — awaiting selection.';
    hideBothFrames();
    return;
  }
  const displayFrameIndex = getRenderFrame(state.currentTime);
  const urlExample = formatFrameUrl(data.frameTemplate, displayFrameIndex);
  if (urlExample && urlExample !== '—') {
    let linkLabel = urlExample;
    try {
      const parsed = new URL(urlExample);
      const parts = parsed.pathname.split('/').filter(Boolean);
      linkLabel = parts.pop() || parsed.hostname;
    } catch (error) {
      linkLabel = urlExample.split('/').pop() || urlExample;
    }
    dom.frameDisplay.title = urlExample;
    dom.frameDisplay.innerHTML = `
      <span class="frame-display__label">Frame ${displayFrameIndex}</span>
      <span class="frame-display__divider">·</span>
      <a class="frame-display__link" href="${urlExample}" target="_blank" rel="noopener">Open frame (${linkLabel})</a>
    `;
    displayFrame(urlExample);
  } else {
    dom.frameDisplay.removeAttribute('title');
    dom.frameDisplay.textContent = `Frame ${displayFrameIndex}`;
    hideBothFrames();
  }
  renderMaskOverlay();
}

function setPlaybackSpeed(value, options = {}) {
  const { updateSelect = true, restartTimer = true, sync = true } = options;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return state.speed;
  }
  const changed = state.speed !== parsed;
  state.speed = parsed;

  if (dom.speedSelect && updateSelect) {
    const targetValue = parsed.toString();
    const optionsArray = Array.from(dom.speedSelect.options || []);
    const hasOption = optionsArray.some((opt) => opt.value === targetValue);
    if (!hasOption) {
      const option = document.createElement('option');
      option.value = targetValue;
      option.textContent = `${targetValue}×`;
      dom.speedSelect.appendChild(option);
    }
    dom.speedSelect.value = targetValue;
  }

  if (changed && restartTimer && state.playing) {
    stopPlayback();
    startPlayback();
  }

  if (sync && changed) {
    syncUrl(true);
  }

  return state.speed;
}

function setCurrentTime(time) {
  if (!state.currentVideoData) return;
  const upperBound = Number.isFinite(state.currentVideoData.sliderMax)
    ? state.currentVideoData.sliderMax
    : state.currentVideoData.maxFrame;
  const snapped = snapToStride(time, upperBound);
  state.currentTime = snapped;
  dom.timeSlider.value = snapped.toString();
  dom.timeValue.textContent = snapped.toString();
  const changed = state.lastRenderedFrame !== snapped;
  if (changed) {
    state.lastRenderedFrame = snapped;
    renderFrameDisplay();
    updateNetwork();
    renderActiveRelations();
    syncUrl(true);
  }
  prefetchNeighbors();
}

function setRenderStride(value, options = {}) {
  const { updateSelect = true, sync = true } = options;
  const parsed = Math.max(1, Math.floor(Number(value) || 1));
  const changed = state.renderStride !== parsed;
  state.renderStride = parsed;

  if (dom.renderRate && updateSelect) {
    const targetValue = parsed.toString();
    const optionsArray = Array.from(dom.renderRate.options || []);
    const hasOption = optionsArray.some((opt) => opt.value === targetValue);
    if (!hasOption) {
      const option = document.createElement('option');
      option.value = targetValue;
      option.textContent = `Every ${parsed}th`;
      dom.renderRate.appendChild(option);
    }
    dom.renderRate.value = targetValue;
  }

  if (!changed) {
    updateTimeSliderStep();
    return state.renderStride;
  }

  updateTimeSliderStep();

  const previousSuspend = suspendUrlSync;
  if (!sync) {
    suspendUrlSync = true;
  }
  state.lastRenderedFrame = null;
  setCurrentTime(state.currentTime);
  suspendUrlSync = previousSuspend;

  return state.renderStride;
}

function nudgeCurrentTime(direction) {
  if (!state.currentVideoData) return;
  const stride = getCurrentStride();
  const step = stride > 0 ? stride : 1;
  const offset = step * direction;
  const upperBound = Number.isFinite(state.currentVideoData.sliderMax)
    ? state.currentVideoData.sliderMax
    : state.currentVideoData.maxFrame;
  const next = Math.max(0, Math.min(state.currentTime + offset, upperBound));
  setCurrentTime(next);
}

function isTypingContext(target) {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName;
  if (!tag) return false;
  const editable = target.isContentEditable;
  if (editable) return true;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function handleGlobalKeydown(event) {
  if (event.defaultPrevented) return;
  if (isTypingContext(event.target)) return;

  const key = event.key;
  if (!key) return;
  const lower = key.toLowerCase();
  const code = typeof event.code === 'string' ? event.code.toLowerCase() : '';

  if (event.shiftKey && (lower === 'arrowleft' || lower === 'arrowright')) {
    event.preventDefault();
    const offset = lower === 'arrowleft' ? -1 : 1;
    selectAdjacentVideo(offset);
    return;
  }

  if (key === ' ' || lower === 'spacebar' || lower === 'space' || code === 'space') {
    event.preventDefault();
    togglePlayback();
    return;
  }

  if (KEY_BACKWARD.has(lower)) {
    event.preventDefault();
    nudgeCurrentTime(-1);
    return;
  }

  if (KEY_FORWARD.has(lower)) {
    event.preventDefault();
    nudgeCurrentTime(1);
  }
}

function stopPlayback() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.playing = false;
  dom.playToggle.textContent = '▶';
  dom.playToggle.setAttribute('aria-label', 'Play');
}

function startPlayback() {
  if (!state.currentVideoData) return;
  if (state.playing) return;
  state.playing = true;
  dom.playToggle.textContent = '⏸';
  dom.playToggle.setAttribute('aria-label', 'Pause');

  const baseFps = Number.isFinite(state.baseFps) && state.baseFps > 0 ? state.baseFps : 24;
  const speed = Number.isFinite(state.speed) && state.speed > 0 ? state.speed : 1;
  const stride = Math.max(1, Number(state.renderStride) || 1);
  const effectiveFps = baseFps * speed;
  const interval = Math.max(16, 1000 / effectiveFps);
  state.timer = setInterval(() => {
    if (!state.currentVideoData) return;
    const upperBound = Number.isFinite(state.currentVideoData.sliderMax)
      ? state.currentVideoData.sliderMax
      : state.currentVideoData.maxFrame;
    let next = state.currentTime + stride;
    if (next > upperBound) {
      next = 0;
    }
    setCurrentTime(next);
  }, interval);
}

function togglePlayback() {
  if (state.playing) {
    stopPlayback();
  } else {
    startPlayback();
  }
}

function updateCategoryFilters(categories) {
  const container = dom.categoryFilters;
  container.innerHTML = '';
  categories.forEach((cat) => {
    const style = CATEGORY_STYLES[cat] || CATEGORY_STYLES.default;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'category-chip';
    button.dataset.category = cat;
    const isActive = state.enabledCategories.has(cat);
    button.dataset.active = isActive ? 'true' : 'false';
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    button.textContent = formatCategoryLabel(cat);
    button.style.background = style.background;
    button.style.color = style.text;
    button.addEventListener('click', () => {
      const isActive = state.enabledCategories.has(cat);
      if (isActive) {
        state.enabledCategories.delete(cat);
        button.dataset.active = 'false';
        button.setAttribute('aria-pressed', 'false');
      } else {
        state.enabledCategories.add(cat);
        button.dataset.active = 'true';
        button.setAttribute('aria-pressed', 'true');
      }
      persistCategorySelection(state.currentVideoId, state.enabledCategories);
      updateNetwork();
      renderActiveRelations();
      syncUrl(true);
    });
    container.appendChild(button);
  });
}

async function loadVideo(videoId, options = {}) {
  stopPlayback();
  dom.frameDisplay.textContent = 'Loading relationships…';
  dom.activeRelations.innerHTML = '';

  const manifestEntry = state.videos.find((v) => v.video_id === videoId);
  if (!manifestEntry) {
    throw new Error(`Video ${videoId} missing from manifest`);
  }

  let cached = state.videoCache.get(videoId);
  const expectCentroids = Boolean(manifestEntry.centroids_url);
  const expectLabels = Boolean(manifestEntry.object_labels_url);
  if (cached && expectCentroids) {
    const cachedCount =
      cached.centroids instanceof Map ? cached.centroids.size : cached.centroids ? Object.keys(cached.centroids).length : 0;
    if (!cachedCount) {
      state.videoCache.delete(videoId);
      cached = null;
    }
  }
  if (cached && expectLabels) {
    const labelCount = cached.objectLabels ? Object.keys(cached.objectLabels).length : 0;
    if (!labelCount) {
      state.videoCache.delete(videoId);
      cached = null;
    }
  }
  if (!cached) {
    const [raw, metadata, centroidPayload, objectLabelsPayload] = await Promise.all([
      fetchRelations(manifestEntry.relations_url),
      fetchMetadata(manifestEntry.metadata_url),
      fetchCentroids(videoId, manifestEntry),
      fetchObjectLabels(manifestEntry.object_labels_url),
    ]);
    cached = buildVideoData(manifestEntry, raw, metadata, centroidPayload, objectLabelsPayload);
    state.videoCache.set(videoId, cached);
  }

  state.currentVideoId = videoId;
  state.currentVideoData = cached;
  state.selectedRelation = null;
  state.selectedRelationGroup = null;
  state.tableFocusPending = false;
  renderRelationDetails();

  const restoredCategories = restoreCategorySelection(videoId, cached.categories);
  let categorySelection = restoredCategories;

  if (Object.prototype.hasOwnProperty.call(options, 'categorySelection')) {
    categorySelection = normaliseCategorySelection(options.categorySelection, cached.categories);
  } else {
    const derived = deriveCategorySelectionFromFilter(cached.categories, options.categoryFilter);
    if (derived !== undefined) {
      categorySelection = derived;
    }
  }

  if (!(categorySelection instanceof Set)) {
    categorySelection = restoredCategories;
  }

  state.enabledCategories = categorySelection;
  persistCategorySelection(videoId, state.enabledCategories);

  dom.videoSelect.value = videoId;
  dom.videoTitle.textContent = videoId;
  dom.videoDescription.textContent = cached.description;
  dom.frameTemplate.textContent = cached.frameTemplate;
  dom.downloadJson.href = manifestEntry.relations_url;

  const frameCount = cached.frameCount;
  const fpsRaw = cached.fpsLabel;
  const fpsValue = cached.fpsValue;
  dom.metaFrames.textContent = frameCount ? frameCount.toLocaleString() : '—';
  dom.metaFps.textContent = fpsRaw || (Number.isFinite(fpsValue) ? fpsValue.toString() : '—');

  const sliderMax = Number.isFinite(cached.sliderMax) ? cached.sliderMax : cached.maxFrame;
  dom.timeSlider.max = sliderMax.toString();
  dom.timeSlider.value = '0';
  dom.timeSlider.disabled = sliderMax <= 0;
  updateTimeSliderStep();

  updateCategoryFilters(cached.categories);
  initialiseNetwork(cached.nodes);
  state.nodeCentroids = cached.centroids;
  state.centroidFrameIndex = new Map();
  state.imageSize = {
    width: Number.isFinite(cached.imageWidth) ? cached.imageWidth : null,
    height: Number.isFinite(cached.imageHeight) ? cached.imageHeight : null,
    originX: Number.isFinite(cached.centroidOriginX) ? cached.centroidOriginX : 0,
    originY: Number.isFinite(cached.centroidOriginY) ? cached.centroidOriginY : 0,
    bounds: cached.centroidBounds || null,
  };
  exposeStateForDebug();

  state.mask.lastRenderedFrame = null;
  clearMaskCanvas();

  if (Number.isFinite(fpsValue) && fpsValue > 0) {
    state.baseFps = fpsValue;
  } else {
    state.baseFps = 24;
  }
  state.lastRenderedFrame = null;
  const hasInitialFrame = Object.prototype.hasOwnProperty.call(options, 'initialFrame');
  const initialTime = hasInitialFrame && Number.isFinite(options.initialFrame) && options.initialFrame >= 0 ? options.initialFrame : 0;
  const previousSuspend = suspendUrlSync;
  if (options.suppressUrlSync) {
    suspendUrlSync = true;
  }
  setCurrentTime(initialTime);
  suspendUrlSync = previousSuspend;
}

function handleVideoChange(e) {
  const videoId = e.target.value;
  if (videoId && videoId !== state.currentVideoId) {
    loadVideo(videoId, { suppressUrlSync: true })
      .then(() => {
        if (urlSyncEnabled) {
          syncUrl(false);
        }
      })
      .catch((error) => {
        console.error(error);
        dom.frameDisplay.textContent = 'Failed to load video data.';
      });
  }
}

function selectAdjacentVideo(offset) {
  if (!state.videos.length) return;
  const currentIndex = state.videos.findIndex((v) => v.video_id === state.currentVideoId);
  const nextIndex = (currentIndex + offset + state.videos.length) % state.videos.length;
  const nextVideo = state.videos[nextIndex];
  if (nextVideo) {
    loadVideo(nextVideo.video_id, { suppressUrlSync: true })
      .then(() => {
        if (urlSyncEnabled) {
          syncUrl(false);
        }
      })
      .catch((error) => {
        console.error(error);
        dom.frameDisplay.textContent = 'Failed to load video data.';
      });
  }
}

function initialiseEventHandlers() {
  dom.videoSelect.addEventListener('change', handleVideoChange);
  dom.prevVideo.addEventListener('click', () => selectAdjacentVideo(-1));
  dom.nextVideo.addEventListener('click', () => selectAdjacentVideo(1));

  dom.playToggle.addEventListener('click', togglePlayback);
  dom.stepBack.addEventListener('click', () => {
    if (!state.currentVideoData) return;
    const stride = Math.max(1, Number(state.renderStride) || 1);
    const next = Math.max(0, state.currentTime - stride);
    setCurrentTime(next);
  });
  dom.stepForward.addEventListener('click', () => {
    if (!state.currentVideoData) return;
    const stride = Math.max(1, Number(state.renderStride) || 1);
    const upperBound = Number.isFinite(state.currentVideoData.sliderMax)
      ? state.currentVideoData.sliderMax
      : state.currentVideoData.maxFrame;
    const next = Math.min(upperBound, state.currentTime + stride);
    setCurrentTime(next);
  });

  dom.timeSlider.addEventListener('input', (event) => {
    const value = Number(event.target.value) || 0;
    setCurrentTime(value);
  });

  dom.speedSelect.addEventListener('change', (event) => {
    const parsed = parseFloat(event.target.value);
    const value = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    setPlaybackSpeed(value, { updateSelect: false, restartTimer: true, sync: true });
  });

  if (dom.activeRelations) {
    dom.activeRelations.addEventListener('click', handleRelationListClick);
    dom.activeRelations.addEventListener('keydown', handleRelationListKeydown);
  }

  if (dom.relationDetailsTableBody) {
    dom.relationDetailsTableBody.addEventListener('click', handleDecisionTableClick);
    dom.relationDetailsTableBody.addEventListener('keydown', handleDecisionTableKeydown);
  }

  if (dom.renderRate) {
    // Initialize from current select value
    const initialStride = parseInt(dom.renderRate.value, 10);
    if (Number.isFinite(initialStride) && initialStride >= 1) {
      setRenderStride(initialStride, { updateSelect: false, sync: false });
    }
    updateTimeSliderStep();
    dom.renderRate.addEventListener('change', (event) => {
      const parsed = parseInt(event.target.value, 10);
      const strideValue = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
      setRenderStride(strideValue, { updateSelect: false, sync: true });
    });
  }

  if (dom.maskToggle) {
    const restored = restoreMaskPreference();
    state.mask.enabled = restored;
    dom.maskToggle.checked = restored;
    dom.maskToggle.addEventListener('change', (event) => {
      setMaskEnabled(event.target.checked);
    });
  }

  window.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPlayback();
    }
  });

  window.addEventListener('keydown', handleGlobalKeydown);
  window.addEventListener('popstate', () => {
    const route = parseRouteFromLocation();
    applyRoute(route, { suppressHistory: true }).catch((error) => {
      console.error('Failed to apply route from history navigation:', error);
    });
  });
}

async function initialise() {
  try {
    state.manifest = await fetchManifest();
    state.videos = Array.isArray(state.manifest.videos) ? state.manifest.videos : [];
    dom.videoCount.textContent = `${state.videos.length} videos`;

    if (!state.videos.length) {
      dom.videoSelect.innerHTML = '';
      dom.videoSelect.disabled = true;
      dom.frameDisplay.textContent = 'No relation files found in manifest.';
      return;
    }

    const fragment = document.createDocumentFragment();
    state.videos.forEach((entry) => {
      const option = document.createElement('option');
      option.value = entry.video_id;
      option.textContent = entry.video_id;
      fragment.appendChild(option);
    });
    dom.videoSelect.innerHTML = '';
    dom.videoSelect.appendChild(fragment);

    const route = parseRouteFromLocation();
    await applyRoute(route, { suppressHistory: true });

    urlSyncEnabled = true;
    syncUrl(true);
  } catch (error) {
    console.error(error);
    dom.frameDisplay.textContent = 'Unable to load manifest or relations. Check console for details.';
  }
}

configureDebugMode();
initialiseEventHandlers();
initialise();
function deriveBaseVideoId(value) {
  if (!value) return null;
  const match = String(value).match(/(sav_\d{6})/i);
  if (match && match[1]) {
    return match[1];
  }
  return String(value);
}

function getSourceVideoId(entry, fallbackValue) {
  if (entry && typeof entry.source_video_id === 'string' && entry.source_video_id.trim()) {
    return entry.source_video_id.trim();
  }
  if (entry && typeof entry.video_id === 'string') {
    const derived = deriveBaseVideoId(entry.video_id);
    if (derived) return derived;
  }
  if (fallbackValue) {
    return deriveBaseVideoId(fallbackValue);
  }
  return null;
}
