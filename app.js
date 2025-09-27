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
  network: document.getElementById('network'),
  videoTitle: document.getElementById('video-title'),
  videoDescription: document.getElementById('video-description'),
  frameTemplate: document.getElementById('frame-template'),
  downloadJson: document.getElementById('download-json'),
  metaFrames: document.getElementById('meta-frames'),
  metaFps: document.getElementById('meta-fps'),
  categoryFilters: document.getElementById('category-filters'),
  activeRelations: document.getElementById('active-relations'),
};

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

function canonicalCategory(value) {
  if (!value) return 'default';
  return String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
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
}

function displayFrame(url) {
  const a = dom.frameImageA;
  const b = dom.frameImageB;
  if (!a || !b) return;

  // Keep current visible; load next into the back buffer and only swap when decoded
  const active = state.activeBuffer || 'A';
  const front = active === 'A' ? a : b;
  const back = active === 'A' ? b : a;

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
  const relationships = Array.isArray(rawData.relationships)
    ? rawData.relationships
    : Array.isArray(rawData.relations)
    ? rawData.relations
    : [];

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
    const predicate = rel[2];
    const intervalsRaw = rel[3];
    const categoryRaw = rel[4];
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
      index,
      from,
      fromLabel: labelMap.get(from) || `Object ${from}`,
      to,
      toLabel: labelMap.get(to) || `Object ${to}`,
      predicate,
      intervals,
      category,
    });
  });

  if (categories.size === 0) {
    categories.add('default');
  }

  const nodeArray = Array.from(nodes)
    .sort((a, b) => Number(a) - Number(b))
    .map((id) => ({
      id,
      label: labelMap.get(id) || `Object ${id}`,
    }));

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
  };
}

function destroyNetwork() {
  if (state.network) {
    state.network.destroy();
    state.network = null;
    state.nodesDataset = null;
    state.edgesDataset = null;
  }
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
        align: 'middle',
      },
    },
  };

  state.network = new vis.Network(container, data, options);
  state.nodesDataset = data.nodes;
  state.edgesDataset = data.edges;

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
  const active = getActiveRelations();

  const activeNodeIds = new Set();
  active.forEach((rel) => {
    activeNodeIds.add(rel.from);
    activeNodeIds.add(rel.to);
  });

  const grouped = new Map();
  active.forEach((rel) => {
    const key = `${rel.from}→${rel.to}`;
    if (!grouped.has(key)) {
      grouped.set(key, { from: rel.from, to: rel.to, relations: [] });
    }
    grouped.get(key).relations.push(rel);
  });

  const edges = Array.from(grouped.entries()).map(([key, group]) => {
    let style = CATEGORY_STYLES.default;
    if (group.relations.length === 1) {
      const only = group.relations[0];
      style = CATEGORY_STYLES[only.category] || CATEGORY_STYLES.default;
    }
    const label = group.relations.map((rel) => rel.predicate).join('\n');
    return {
      id: `edge-${key}`,
      from: group.from,
      to: group.to,
      label,
      color: { color: style.edge, highlight: style.edge },
      font: {
        color: '#0f172a',
        strokeColor: 'rgba(255,255,255,0.95)',
        strokeWidth: 4,
        face: 'Inter',
        size: 14,
      },
    };
  });

  state.edgesDataset.clear();
  if (edges.length) {
    state.edgesDataset.add(edges);
  }

  updateNodePositions(activeNodeIds);
}

function renderActiveRelations() {
  const container = dom.activeRelations;
  const active = getActiveRelations();
  if (!active.length) {
    container.innerHTML = '<p class="empty-state">No active relationships for this frame and category selection.</p>';
    return;
  }

  const html = active
    .map((rel) => {
      const style = CATEGORY_STYLES[rel.category] || CATEGORY_STYLES.default;
      const catLabel = formatCategoryLabel(rel.category);
      const ranges = rel.intervals
        .map(([start, end]) => `frames ${start}–${end}`)
        .join(', ');
      const from = rel.fromLabel || `Object ${rel.from}`;
      const to = rel.toLabel || `Object ${rel.to}`;
      const predicateColor = style.edge || style.text || 'var(--text)';
      return `
        <div class="relation-item" data-category="${rel.category}">
          <div class="relation-item__header">
            <span class="relation-item__label">
              <span class="relation-item__category" style="background:${style.background};color:${style.text}">${catLabel}</span>
              <span class="relation-item__predicate" style="color:${predicateColor}">${rel.predicate}</span>
            </span>
          </div>
          <div class="relation-item__entities">${from} → ${to}</div>
          <div class="relation-item__time">${ranges}</div>
        </div>
      `;
    })
    .join('');
  container.innerHTML = html;
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
