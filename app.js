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
  imageSize: null,
  fallbackPositions: null,
  resizeHandler: null,
  baseFps: 24,
  lastFrameUrl: null,
  prefetch: { cache: new Map(), limit: 24 },
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

function canonicalCategory(value) {
  if (!value) return 'default';
  return String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
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
  if (!rawCentroids || typeof rawCentroids !== 'object') {
    return { centroids: null, imageWidth: null, imageHeight: null, maxFrame: null };
  }

  const centroidMap = new Map();
  let maxFrame = -Infinity;

  Object.entries(rawCentroids).forEach(([objectId, frames]) => {
    const nodeId = String(objectId);
    if (!nodeIdSet.has(nodeId)) return;
    if (!frames || typeof frames !== 'object') return;

    const perFrame = new Map();
    Object.entries(frames).forEach(([frameKey, coords]) => {
      if (!coords || typeof coords !== 'object') return;
      const x = Number(coords.x);
      const y = Number(coords.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const frame = Number(frameKey);
      if (!Number.isFinite(frame) || frame < 0) return;
      perFrame.set(frame, { x, y });
      if (frame > maxFrame) {
        maxFrame = frame;
      }
    });

    if (perFrame.size > 0) {
      centroidMap.set(nodeId, perFrame);
    }
  });

  const imageWidth = Number(payload.image_width);
  const imageHeight = Number(payload.image_height);

  return {
    centroids: centroidMap.size ? centroidMap : null,
    imageWidth: Number.isFinite(imageWidth) && imageWidth > 0 ? imageWidth : null,
    imageHeight: Number.isFinite(imageHeight) && imageHeight > 0 ? imageHeight : null,
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

  // Keep current visible; load next into the back buffer and swap when ready
  const active = state.activeBuffer || 'A';
  const front = active === 'A' ? a : b;
  const back = active === 'A' ? b : a;

  if (front.dataset.url === url) {
    if (front.style.opacity !== '1') front.style.opacity = '1';
    return;
  }

  ensurePrefetch(url)
    .then(() => {
      back.dataset.url = url;
      if (back.src !== url) back.src = url;
      // show back, hide front
      back.style.opacity = '1';
      front.style.opacity = '0';
      state.activeBuffer = active === 'A' ? 'B' : 'A';
      state.lastFrameUrl = url;
    })
    .catch(() => {
      // fall back to direct set without blanking the front; swap after it loads
      back.dataset.url = url;
      back.onload = () => {
        back.style.opacity = '1';
        front.style.opacity = '0';
        state.activeBuffer = active === 'A' ? 'B' : 'A';
        state.lastFrameUrl = url;
      };
      if (back.src !== url) back.src = url;
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
  const candidates = [];
  if (manifestEntry?.centroids_url) {
    candidates.push(manifestEntry.centroids_url);
  }
  candidates.push(`public/centroids/${videoId}.json`);

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

  state.currentVideoData.nodes.forEach((node) => {
    const id = String(node.id);
    const isActive = activeSet.size === 0 ? false : activeSet.has(id);
    let hidden = !isActive;
    let x = 0;
    let y = 0;

    if (isActive && allowCentroidPlacement) {
      const frameMap = centroids.get(id);
      const point = frameMap?.get(frame);
      if (point) {
        const screenX = offsetX + point.x * scale;
        const screenY = offsetY + point.y * scale;
        x = screenX - containerWidth / 2;
        y = screenY - containerHeight / 2;
        hidden = false;
      }
    }

    if (isActive && hidden) {
      const fallbackPos = fallback.get(id);
      if (fallbackPos) {
        x = fallbackPos.x;
        y = fallbackPos.y;
        hidden = false;
      }
    }

    if (!isActive && allowCentroidPlacement) {
      // Keep centroid-capable nodes hidden when not in use
      hidden = true;
    } else if (!isActive) {
      const fallbackPos = fallback.get(id);
      if (fallbackPos) {
        x = fallbackPos.x;
        y = fallbackPos.y;
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
    displayFrame(urlExample);
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
  updateNetwork();
  renderActiveRelations();
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

initialiseEventHandlers();
initialise();
