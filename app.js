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
  if (template.includes('{frame:04d}')) {
    return template.replace('{frame:04d}', padFrame(frame));
  }
  if (template.includes('{frame}')) {
    return template.replace('{frame}', frame.toString());
  }
  return template;
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

function buildVideoData(manifestEntry, rawData, metadata) {
  const relationships = Array.isArray(rawData.relationships)
    ? rawData.relationships
    : Array.isArray(rawData.relations)
    ? rawData.relations
    : [];

  const processed = [];
  const categories = new Set();
  const nodes = new Set();
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
      to,
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
      label: `Object ${id}`,
    }));

  if (frameCount == null) {
    frameCount = maxFrame + 1;
  }

  return {
    manifest: manifestEntry,
    raw: rawData,
    relations: processed,
    categories: Array.from(categories).sort(),
    nodes: nodeArray,
    maxFrame,
    sliderMax: maxFrame,
    description: rawData.description || 'No description provided.',
    frameTemplate: manifestEntry.frame_template,
    metadataUrl: manifestEntry.metadata_url,
    metadata,
    frameCount,
    fpsLabel,
  };
}

function destroyNetwork() {
  if (state.network) {
    state.network.destroy();
    state.network = null;
    state.nodesDataset = null;
    state.edgesDataset = null;
  }
}

function initialiseNetwork(nodes) {
  destroyNetwork();
  const container = dom.network;
  container.innerHTML = '';

  const total = Math.max(nodes.length, 3);
  const radius = Math.max(220, Math.min(container.clientWidth, container.clientHeight) / 2.4);

  const nodeData = nodes.map((node, idx) => {
    const angle = (2 * Math.PI * idx) / total;
    return {
      id: node.id,
      label: node.label,
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
      physics: false,
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
      dragView: true,
      zoomView: true,
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

function updateNetwork() {
  if (!state.edgesDataset) return;
  const active = getActiveRelations();

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
      return `
        <div class="relation-item" data-category="${rel.category}">
          <div class="relation-item__header">
            <span class="relation-item__label" style="color:${style.text}">
              <span class="category-chip" style="background:${style.background};color:${style.text}">${catLabel}</span>
              ${rel.predicate}
            </span>
          </div>
          <div class="relation-item__entities">${rel.from} → ${rel.to}</div>
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
    return;
  }
  const urlExample = formatFrameUrl(data.frameTemplate, state.currentTime);
  if (urlExample && urlExample !== '—') {
    dom.frameDisplay.innerHTML = `Frame ${state.currentTime} — <a href="${urlExample}" target="_blank" rel="noopener">${urlExample}</a>`;
  } else {
    dom.frameDisplay.textContent = `Frame ${state.currentTime}`;
  }
}

function setCurrentTime(time) {
  if (!state.currentVideoData) return;
  const clamped = Math.max(0, Math.min(time, state.currentVideoData.maxFrame));
  state.currentTime = clamped;
  dom.timeSlider.value = clamped.toString();
  dom.timeValue.textContent = clamped.toString();
  renderFrameDisplay();
  updateNetwork();
  renderActiveRelations();
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

  const interval = Math.max(80, 400 / state.speed);
  state.timer = setInterval(() => {
    if (!state.currentVideoData) return;
    const next = state.currentTime >= state.currentVideoData.maxFrame ? 0 : state.currentTime + 1;
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
    const [raw, metadata] = await Promise.all([
      fetchRelations(manifestEntry.relations_url),
      fetchMetadata(manifestEntry.metadata_url),
    ]);
    cached = buildVideoData(manifestEntry, raw, metadata);
    state.videoCache.set(videoId, cached);
  }

  state.currentVideoId = videoId;
  state.currentVideoData = cached;
  state.enabledCategories = new Set(cached.categories);

  dom.videoSelect.value = videoId;
  dom.videoTitle.textContent = videoId;
  dom.videoDescription.textContent = cached.description;
  dom.frameTemplate.textContent = cached.frameTemplate;
  dom.downloadJson.href = manifestEntry.relations_url;

  const frameCount = cached.frameCount;
  const fpsRaw = cached.fpsLabel;
  dom.metaFrames.textContent = frameCount ? frameCount.toLocaleString() : '—';
  dom.metaFps.textContent = fpsRaw || '—';

  const sliderMax = Number.isFinite(cached.sliderMax) ? cached.sliderMax : cached.maxFrame;
  dom.timeSlider.max = sliderMax.toString();
  dom.timeSlider.value = '0';
  dom.timeSlider.disabled = sliderMax <= 0;

  updateCategoryFilters(cached.categories);
  initialiseNetwork(cached.nodes);
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
    const next = Math.min(state.currentVideoData.maxFrame, state.currentTime + 1);
    setCurrentTime(next);
  });

  dom.timeSlider.addEventListener('input', (event) => {
    const value = Number(event.target.value) || 0;
    setCurrentTime(value);
  });

  dom.speedSelect.addEventListener('change', (event) => {
    const value = Number(event.target.value) || 1;
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
