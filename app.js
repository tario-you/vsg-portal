const CATEGORY_STYLES = {
  spatial: { background: '#d4d4d4', text: '#1f2937', edge: '#9ca3af' },
  motion: { background: '#317ba6', text: '#f8fafc', edge: '#3b82f6' },
  functional: { background: '#153242', text: '#e2e8f0', edge: '#2563eb' },
  higher_order: { background: '#de4c64', text: '#0f172a', edge: '#ef4444' },
  social: { background: '#49cd98', text: '#0f172a', edge: '#10b981' },
  attentional: { background: '#f8d065', text: '#0f172a', edge: '#f59e0b' },
  default: { background: '#723bf3', text: '#f8fafc', edge: '#8b5cf6' },
};

const manifestUrl = 'public/manifest.json';

const state = {
  manifest: null,
  videos: [],
  videoCache: new Map(),
  currentVideoId: null,
  currentVideoData: null,
  currentTime: 0,
  playing: false,
  speed: 1,
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
  prefetch: { cache: new Map(), limit: 24 },
  renderStride: 6,
  debug: { enabled: false, overlay: null },
};

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
    `scale: ${formatDebugNumber(info.scale, 3)} offset: (${formatDebugNumber(info.offsetX, 1)}, ${formatDebugNumber(info.offsetY, 1)}` + ')',
    `active: ${info.counts.active} | centroid: ${info.counts.centroid} | fallback: ${info.counts.fallback} | hidden: ${info.counts.hidden} | inactive: ${info.counts.inactive}`,
  ];

  if (info.samples && info.samples.length) {
    summary.push('samples:');
    info.samples.forEach((sample) => {
      summary.push(
        `  ${sample.id} → src=${sample.source} frame=${sample.frame} world=(${formatDebugNumber(sample.worldX, 1)}, ${formatDebugNumber(sample.worldY, 1)}) screen=(${formatDebugNumber(sample.screenX, 1)}, ${formatDebugNumber(sample.screenY, 1)})`
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

function shouldRenderFrame(time) {
  const stride = Number(state.renderStride) || 1;
  if (!state.playing) return true;
  if (stride <= 1) return true;
  return (time % stride) === 0;
}

function formatCategoryLabel(cat) {
  return cat.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function padFrame(frame) {
  return frame.toString().padStart(4, '0');
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
  const imageWidth = Number.isFinite(imageWidthRaw) && imageWidthRaw > 0 ? imageWidthRaw : null;
  const imageHeight = Number.isFinite(imageHeightRaw) && imageHeightRaw > 0 ? imageHeightRaw : null;

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
  }

  return {
    centroids: centroidMap.size ? centroidMap : null,
    imageWidth,
    imageHeight,
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
  const center = state.currentTime || 0;
  const radius = 6; // prefetch +/- 6 frames
  const frames = [];
  for (let k = -radius; k <= radius; k++) {
    const f = center + k;
    if (f >= 0 && f <= max) frames.push(f);
  }
  const cache = state.prefetch.cache;
  const limit = state.prefetch.limit || 24;
  frames.forEach((f) => {
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

function buildVideoData(manifestEntry, rawData, metadata, centroidsPayload) {
  const relationships = Array.isArray(rawData.relationships)
    ? rawData.relationships
    : Array.isArray(rawData.relations)
    ? rawData.relations
    : [];

  const processed = [];
  const categories = new Set();
  const nodes = new Set();
  const labelMap = extractObjectLabels(rawData, metadata);
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
        color: '#0f172a',
        face: 'Inter',
        size: 16,
        align: 'horizontal',
      },
    },
    edges: {
      width: 2,
      smooth: {
        type: 'cubicBezier',
        roundness: 0.25,
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
  const time = state.currentTime;
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

  const frame = state.currentTime;
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
        scale,
        offsetX,
        offsetY,
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
      const screenX = offsetX + point.x * scale;
      const screenY = offsetY + point.y * scale;
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

  const edges = active.map((rel) => {
    const style = CATEGORY_STYLES[rel.category] || CATEGORY_STYLES.default;
    return {
      id: `edge-${rel.index}`,
      from: rel.from,
      to: rel.to,
      label: rel.predicate,
      color: { color: style.edge, highlight: style.edge },
      font: {
        color: style.text,
        background: 'rgba(255,255,255,0.85)',
        strokeWidth: 0,
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
      return `
        <div class="relation-item" data-category="${rel.category}">
          <div class="relation-item__header">
            <span class="relation-item__label" style="color:${style.text}">
              <span class="category-chip" style="background:${style.background};color:${style.text}">${catLabel}</span>
              ${rel.predicate}
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
  const urlExample = formatFrameUrl(data.frameTemplate, state.currentTime);
  if (urlExample && urlExample !== '—') {
    dom.frameDisplay.innerHTML = `Frame ${state.currentTime} — <a href="${urlExample}" target="_blank" rel="noopener">${urlExample}</a>`;
    if (shouldRenderFrame(state.currentTime)) {
      displayFrame(urlExample);
    }
  } else {
    dom.frameDisplay.textContent = `Frame ${state.currentTime}`;
    hideBothFrames();
  }
}

function setCurrentTime(time) {
  if (!state.currentVideoData) return;
  const upperBound = Number.isFinite(state.currentVideoData.sliderMax)
    ? state.currentVideoData.sliderMax
    : state.currentVideoData.maxFrame;
  const clamped = Math.max(0, Math.min(time, upperBound));
  state.currentTime = clamped;
  dom.timeSlider.value = clamped.toString();
  dom.timeValue.textContent = clamped.toString();
  renderFrameDisplay();
  if (shouldRenderFrame(clamped)) {
    updateNetwork();
    renderActiveRelations();
  }
  prefetchNeighbors();
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
  const effectiveFps = baseFps * speed;
  const interval = Math.max(16, 1000 / effectiveFps);
  state.timer = setInterval(() => {
    if (!state.currentVideoData) return;
    const upperBound = Number.isFinite(state.currentVideoData.sliderMax)
      ? state.currentVideoData.sliderMax
      : state.currentVideoData.maxFrame;
    const next = state.currentTime >= upperBound ? 0 : state.currentTime + 1;
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
    button.dataset.active = 'true';
    button.textContent = formatCategoryLabel(cat);
    button.style.background = style.background;
    button.style.color = style.text;
    button.addEventListener('click', () => {
      const isActive = state.enabledCategories.has(cat);
      if (isActive) {
        state.enabledCategories.delete(cat);
        button.dataset.active = 'false';
      } else {
        state.enabledCategories.add(cat);
        button.dataset.active = 'true';
      }
      updateNetwork();
      renderActiveRelations();
    });
    container.appendChild(button);
  });
}

async function loadVideo(videoId) {
  stopPlayback();
  dom.frameDisplay.textContent = 'Loading relationships…';
  dom.activeRelations.innerHTML = '';

  const manifestEntry = state.videos.find((v) => v.video_id === videoId);
  if (!manifestEntry) {
    throw new Error(`Video ${videoId} missing from manifest`);
  }

  let cached = state.videoCache.get(videoId);
  if (!cached) {
    const [raw, metadata, centroidPayload] = await Promise.all([
      fetchRelations(manifestEntry.relations_url),
      fetchMetadata(manifestEntry.metadata_url),
      fetchCentroids(videoId, manifestEntry),
    ]);
    cached = buildVideoData(manifestEntry, raw, metadata, centroidPayload);
    state.videoCache.set(videoId, cached);
  }

  state.currentVideoId = videoId;
  state.currentVideoData = cached;
  state.enabledCategories = new Set(cached.categories);
  state.nodeCentroids = cached.centroids;
  state.centroidFrameIndex = new Map();
  state.imageSize = {
    width: Number.isFinite(cached.imageWidth) ? cached.imageWidth : null,
    height: Number.isFinite(cached.imageHeight) ? cached.imageHeight : null,
  };

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
  dom.timeSlider.step = '1';

  updateCategoryFilters(cached.categories);
  initialiseNetwork(cached.nodes);
  if (Number.isFinite(fpsValue) && fpsValue > 0) {
    state.baseFps = fpsValue;
  } else {
    state.baseFps = 24;
  }
  setCurrentTime(0);
}

function handleVideoChange(e) {
  const videoId = e.target.value;
  if (videoId && videoId !== state.currentVideoId) {
    loadVideo(videoId).catch((error) => {
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
    loadVideo(nextVideo.video_id).catch((error) => {
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
    const next = Math.max(0, state.currentTime - 1);
    setCurrentTime(next);
  });
  dom.stepForward.addEventListener('click', () => {
    if (!state.currentVideoData) return;
    const upperBound = Number.isFinite(state.currentVideoData.sliderMax)
      ? state.currentVideoData.sliderMax
      : state.currentVideoData.maxFrame;
    const next = Math.min(upperBound, state.currentTime + 1);
    setCurrentTime(next);
  });

  dom.timeSlider.addEventListener('input', (event) => {
    const value = Number(event.target.value) || 0;
    setCurrentTime(value);
  });

  dom.speedSelect.addEventListener('change', (event) => {
    const parsed = parseFloat(event.target.value);
    const value = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    state.speed = value;
    if (state.playing) {
      stopPlayback();
      startPlayback();
    }
  });

  if (dom.renderRate) {
    // Initialize from current select value
    const initialStride = parseInt(dom.renderRate.value, 10);
    if (Number.isFinite(initialStride) && initialStride >= 1) {
      state.renderStride = initialStride;
    }
    dom.renderRate.addEventListener('change', (event) => {
      const parsed = parseInt(event.target.value, 10);
      state.renderStride = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
      // Nudge a render so the change is visible
      renderFrameDisplay();
      updateNetwork();
      renderActiveRelations();
    });
  }

  window.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPlayback();
    }
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

    await loadVideo(state.videos[0].video_id);
  } catch (error) {
    console.error(error);
    dom.frameDisplay.textContent = 'Unable to load manifest or relations. Check console for details.';
  }
}

configureDebugMode();
initialiseEventHandlers();
initialise();
