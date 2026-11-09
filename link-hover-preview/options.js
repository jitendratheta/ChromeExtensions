const DEFAULTS = {
  enabled: true,
  delay: 1000,
  width: 640,
  height: 420,
  allowBlocked: false
};
const LIMITS = {
  delay: [0, 5000],
  width: [200, 3000],
  height: [150, 2000]
};

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
let statusTimer = null;

function clamp(key, value) {
  const [min, max] = LIMITS[key];
  const n = Math.round(Number(value));
  if (Number.isNaN(n)) return DEFAULTS[key];
  return Math.min(max, Math.max(min, n));
}

function flash(text) {
  statusEl.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (statusEl.textContent = ''), 1200);
}

function save(patch) {
  chrome.storage.sync.set(patch, () => flash('Saved'));
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  $('enabled').checked = s.enabled;
  $('allowBlocked').checked = s.allowBlocked;
  $('delay').value = s.delay;
  $('width').value = s.width;
  $('height').value = s.height;
});

for (const key of ['enabled', 'allowBlocked']) {
  $(key).addEventListener('change', (e) => save({ [key]: e.target.checked }));
}

for (const key of ['delay', 'width', 'height']) {
  $(key).addEventListener('change', (e) => {
    const value = clamp(key, e.target.value);
    e.target.value = value;
    save({ [key]: value });
  });
}

document.querySelectorAll('.presets button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const width = Number(btn.dataset.w);
    const height = Number(btn.dataset.h);
    $('width').value = width;
    $('height').value = height;
    save({ width, height });
  });
});
