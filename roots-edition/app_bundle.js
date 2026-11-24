// ============================================================
// SERVICE WORKER REGISTRATION
// ============================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((registration) => {
        console.log('[SW] ServiceWorker registration successful with scope: ', registration.scope);
        registration.update();
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          console.log('[SW] Controller changed');
        });
      })
      .catch((error) => {
        console.log('[SW] ServiceWorker registration failed: ', error);
      });
  });

  // The service worker serves the app shell (HTML/JS/CSS) cache-first for
  // instant offline loads, then refreshes the cache in the background. If
  // that background refresh finds content that's genuinely different from
  // what was cached, it posts this message so the person can choose to
  // reload rather than silently running stale code for the rest of the
  // session — cache-first without this, a code fix or new recipe wouldn't
  // show up until their *next* visit.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'ROOTS_UPDATE_AVAILABLE') {
      const banner = document.getElementById('update-available');
      if (banner) {
        banner.hidden = false;
        banner.classList.add('visible');
      }
    }
  });
}

// ============================================================
// OFFLINE STATUS INDICATOR
// ============================================================
const offlineIndicator = document.getElementById('offline-indicator');
function updateOnlineStatus() {
  offlineIndicator.classList.toggle('visible', !navigator.onLine);
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

// ============================================================
// SAFE STORAGE ACCESS
// ============================================================
// localStorage.getItem/setItem can throw synchronously in some browser
// configurations (historically Safari private browsing, some hardened or
// enterprise-locked browsers). Several reads in this file used to call
// localStorage.getItem directly, unguarded, at module-init time — if that
// throws, the whole script fails before AppState even exists, and the app
// never renders. safeStorageGet() makes every read fail soft (returns null)
// instead of fail hard.
function safeStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

// Age keys follow the book's one primary framework (1–3 / 4–6 / 7+).
// Earlier builds stored "5" and "7"; map those forward so a returning
// parent keeps their selection instead of silently resetting.
// "family" (2026-10-06) shows one pot for every child at the table and is
// the default for a first visit; a returning parent keeps their saved age.
function normalizeAge(raw) {
  const legacy = { "5": "4-6", "7": "7+" };
  const v = legacy[raw] || raw;
  return ["1-3", "4-6", "7+", "family"].includes(v) ? v : "family";
}

// ============================================================
// FAMILY SCALING (2026-10-06)
// ============================================================
// Turns each recipe's 1–3 base into amounts for an older child, or one
// pot for the whole household, using only the book's standing rules:
//   • fish: Fish & Mercury serving guidance (1 oz at 1–3, 2 oz at 4–6,
//     2–3 oz at 7+ — the book's own Portion & Appetite Guide wording);
//   • other protein anchors (egg, tofu): ×2 (Growth Adjustments);
//   • legumes, grains, fats, vegetables/fruit: ×1.75 (midpoint of the
//     published ×1.5–2 range — Ras's approved default);
//   • cooking liquid travels with its grain (×1.75) so ratios hold.
// Lines written as a range ("½–1 sweet potato") or as a whole item
// ("½ banana") are deliberately NOT computed — they say "scale by eye".
// Seasonings are never scaled. Batch recipes don't scale by age.
const AGE_KEYS = ['1-3', '4-6', '7+'];
const AGE_SHORT = { '1-3': '1–3', '4-6': '4–6', '7+': '7+' };
const ROLE_MULT = { protein: [2, 2], legume: [1.75, 1.75], grain: [1.75, 1.75], liquid: [1.75, 1.75], fat: [1.75, 1.75], vegetable: [1.75, 1.75] };
const FISH_MULT = { '1-3': [1, 1], '4-6': [2, 2], '7+': [2, 3] };
const BATCH_RECIPES = new Set(['rec-26', 'rec-27', 'rec-28', 'rec-29', 'rec-30', 'rec-31', 'rec-32']);
const EMERGENCY_IDS = ['rec-33', 'rec-34', 'rec-35', 'rec-36', 'rec-37', 'rec-38', 'rec-39', 'rec-40', 'rec-41', 'rec-42'];

const ROLE_PATTERNS = [
  ['seasoning', /\b(salt|pepper|cinnamon|thyme|herbs?|parsley|cilantro|dill|lemon|lime|citrus|spices?|turmeric|cumin|ginger|vanilla|baking powder|paprika|maple syrup|dates)\b/i],
  ['fish', /\b(salmon|fish|sardines?|trout|tuna|haddock|sole|pollock|tilapia)\b/i],
  ['protein', /\b(eggs?|tofu)\b/i],
  ['legume', /\b(beans?|lentils?|chickpeas?|hummus)\b/i],
  ['liquid', /\b(water|liquid|beverage|broth)\b/i],
  ['grain', /\b(oats?|rice|millet|quinoa|pasta|flour|bread|toast|pita|tortilla)\b/i],
  ['fat', /\b(oil|tahini|avocado|butter|flax|flaxseed|chia)\b/i],
  ['vegetable', /\b(sweet potato|potato|greens|pumpkin|squash|peas|tomato|tomatoes|spinach|broccoli|bok choy|kale|collards?|carrots?|corn|plantain|bananas?|pear|mango|fruit|berries|applesauce|vegetables?|celery|onion)\b/i]
];
function ingredientRole(text) {
  for (const [role, re] of ROLE_PATTERNS) {
    if (!re.test(text)) continue;
    // "Carrot, celery, onion, parsley stems" is a vegetable line, not a
    // seasoning — the herb is incidental. Real seasonings never name a
    // vegetable, legume or grain alongside.
    if (role === 'seasoning') {
      const food = ROLE_PATTERNS.find(([r, re2]) => ['vegetable', 'legume', 'grain'].includes(r) && re2.test(text));
      if (food) return food[0];
    }
    return role;
  }
  return 'other';
}

const FRAC_CHARS = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875 };
const FRAC_RE = '[¼½¾⅓⅔⅛⅜⅝⅞]';
const NUM_RE = `(?:\\d+\\s*${FRAC_RE}|\\d+(?:\\.\\d+)?|${FRAC_RE})`;
const UNIT_RE = '(cups?|tsp|tbsp|oz|g|slices?|eggs?)';
function parseNumber(s) {
  s = s.trim();
  const m = s.match(new RegExp(`^(\\d+)?\\s*(${FRAC_RE})?$`));
  if (m && (m[1] || m[2])) return (m[1] ? Number(m[1]) : 0) + (m[2] ? FRAC_CHARS[m[2]] : 0);
  const n = Number(s);
  return isNaN(n) ? null : n;
}
// Splits one ingredient line into { qty, unit, rest } when it starts with a
// single clean quantity + unit. Ranges and whole items return qty: null.
function parseIngredient(text) {
  const t = text.trim().replace(/\.$/, '');
  const lead = t.replace(/^(~|about\s+)/i, '');
  if (new RegExp(`^${NUM_RE}\\s*[-–]\\s*${NUM_RE}`).test(lead)) return { qty: null, kind: 'range', text: t };
  const m = lead.match(new RegExp(`^(${NUM_RE})\\s*${UNIT_RE}\\b\\s*(.*)$`, 'i'));
  if (m) {
    const qty = parseNumber(m[1]);
    if (qty) {
      let unit = m[2].toLowerCase();
      unit = { cups: 'cup', slices: 'slice', eggs: 'egg' }[unit] || unit;
      return { qty, unit, rest: m[3].trim(), text: t };
    }
  }
  if (new RegExp(`^${NUM_RE}\\s+\\S`).test(lead)) return { qty: null, kind: 'whole', text: t };
  return { qty: null, kind: 'none', text: t };
}

const EIGHTHS = { 0.125: '⅛', 0.25: '¼', 0.375: '⅜', 0.5: '½', 0.625: '⅝', 0.75: '¾', 0.875: '⅞' };
function roundFor(unit, q) {
  const step = { cup: 0.125, tsp: 0.25, tbsp: 0.5, oz: 0.5, g: 5, slice: 0.5, egg: 1 }[unit] || 0.125;
  if (unit === 'egg') return Math.ceil(q - 1e-9);
  return Math.max(step, Math.round(q / step + 1e-9) * step);
}
function fmtNum(q) {
  const whole = Math.floor(q + 1e-9);
  const rem = Math.round((q - whole) * 1000) / 1000;
  const frac = EIGHTHS[rem] || (rem ? String(rem).replace(/^0/, '') : '');
  if (whole && frac) return EIGHTHS[rem] ? `${whole}${frac}` : String(Math.round(q * 100) / 100);
  return whole ? String(whole) : (frac || '0');
}
function fmtUnit(unit, q) {
  if (unit === 'tbsp') return 'Tbsp';
  if (unit === 'cup' || unit === 'slice' || unit === 'egg') return q > 1 ? unit + 's' : unit;
  return unit;
}
function fmtAmount(unit, lo, hi) {
  const a = roundFor(unit, lo), b = roundFor(unit, hi);
  const n = a === b ? fmtNum(a) : `${fmtNum(a)}–${fmtNum(b)}`;
  let s = `${n} ${fmtUnit(unit, b)}`;
  if (unit === 'tsp' && a >= 3) {
    const tl = Math.round(a / 3 * 2) / 2, th = Math.round(b / 3 * 2) / 2;
    s += ` (≈ ${tl === th ? fmtNum(tl) : fmtNum(tl) + '–' + fmtNum(th)} Tbsp)`;
  } else if (unit === 'tbsp' && a >= 4) {
    const cl = Math.round(a / 16 * 8) / 8, ch = Math.round(b / 16 * 8) / 8;
    s += ` (≈ ${cl === ch ? fmtNum(cl) : fmtNum(cl) + '–' + fmtNum(ch)} cup)`;
  }
  return s;
}

const DEFAULT_HOUSEHOLD = { '1-3': 1, '4-6': 1, '7+': 1 };
function householdLabel(h) {
  const parts = AGE_KEYS.filter(k => h[k] > 0).map(k => `${h[k]} × ${AGE_SHORT[k]}`);
  return parts.length ? parts.join(', ') : 'no children set';
}
// [lo, hi] multiplier of the 1–3 base for one age band, or the household total.
function scaleFactor(role, mode, household) {
  const one = (age) => {
    if (age === '1-3') return [1, 1];
    if (role === 'fish') return FISH_MULT[age];
    return ROLE_MULT[role] || [1, 1];
  };
  if (mode !== 'family') return one(mode);
  let lo = 0, hi = 0;
  AGE_KEYS.forEach(k => { const n = household[k] || 0; const [a, b] = one(k); lo += n * a; hi += n * b; });
  return [lo, hi];
}

function splitIngredients(str) {
  return String(str || '').split(';').map(s => s.trim().replace(/\.$/, '')).filter(Boolean);
}

// One display-ready line per ingredient for the given mode.
function scaleIngredientLines(recipeObj, mode, household) {
  const lines = splitIngredients(recipeObj.ingredients);
  const batch = BATCH_RECIPES.has(recipeObj.id);
  return lines.map(text => {
    const role = ingredientRole(text);
    const base = { text, role, scaled: false, byEye: false };
    if (mode === '1-3' || batch) return base;
    if (role === 'seasoning') return base;
    if (role === 'other') return { ...base, byEye: true };
    const p = parseIngredient(text);
    if (p.qty == null) return { ...base, byEye: true };
    const [lo, hi] = scaleFactor(role, mode, household);
    if (!lo && !hi) return { ...base, byEye: false };
    const rest = p.rest.replace(/\s*\([^)]*[\d¼½¾⅓⅔⅛⅜⅝⅞][^)]*\)/g, '').replace(/\s+for ages 1–3/i, '').trim();
    return { ...base, scaled: true, amount: fmtAmount(p.unit, p.qty * lo, p.qty * hi), rest, unit: p.unit, lo: p.qty * lo, hi: p.qty * hi };
  });
}

// ---------- Grocery items ----------
const GROCERY_SECTIONS = [
  ['produce', 'Produce'],
  ['fish-eggs', 'Fish & eggs'],
  ['fridge', 'Fridge & freezer'],
  ['beans', 'Beans & lentils'],
  ['grains', 'Grains & bread'],
  ['pantry', 'Pantry, oils & spices'],
  ['other', 'Other']
];
function grocerySection(name) {
  const n = name.toLowerCase();
  if (/salmon|fish|sardine|trout|egg/.test(n)) return 'fish-eggs';
  if (/yogurt|hummus|tofu|frozen|beverage|plant milk|soy milk/.test(n)) return 'fridge';
  if (/crushed tomato|tomato sauce|tomato pur|applesauce|coconut milk|broth|baking powder|vanilla|syrup/.test(n)) return 'pantry';
  if (/bean|lentil|chickpea/.test(n)) return 'beans';
  if (/oat|rice|millet|quinoa|pasta|flour|bread|toast|pita|tortilla/.test(n)) return 'grains';
  if (/oil|tahini|butter|cinnamon|cumin|turmeric|flax|chia|spice|salt|paprika/.test(n)) return 'pantry';
  if (/banana|plantain|avocado|potato|greens|spinach|broccoli|bok choy|kale|collard|carrot|pumpkin|squash|tomato|pear|mango|berr|fruit|lemon|lime|herb|thyme|parsley|cilantro|ginger|celery|onion|corn|peas|vegetable|dill|dates/.test(n)) return 'produce';
  return 'other';
}
function groceryName(text) {
  let t = text.replace(/\.$/, '').replace(/^optional:?\s*/i, '');
  t = t.replace(/^(~|about\s+)/i, '');
  t = t.replace(new RegExp(`^${NUM_RE}(\\s*[-–]\\s*${NUM_RE})?\\s*`), '');
  t = t.replace(new RegExp(`^${UNIT_RE}\\b\\s*`, 'i'), '');
  t = t.replace(/^(a few pieces of|a few|tiny amount|pinch of|pinch|a pinch of|small)\s+/i, '');
  t = t.replace(/\s*\([^)]*\)/g, '');
  t = t.replace(/,\s*(drained|rinsed|mashed|cut|cooked|chopped|sliced|thawed|warmed|hard|fully|chilled|diced|flaked|quartered|or)\b.*$/i, '');
  t = t.replace(/\s+for ages 1–3$/i, '').replace(/,?\s*optional$/i, '');
  t = t.replace(/,\s*for ages\b.*$/i, '');                 // "…, for ages 2+"
  t = t.replace(new RegExp(`\\s+or\\s+${NUM_RE}\\s+`, 'g'), ' or '); // "syrup or 2 mashed dates"
  t = t.replace(/^optional\s+/i, '');
  return t.trim().toLowerCase();
}
const GROCERY_SKIP = new Set(['water', 'liquid']);
// Grocery entries for one recipe at the current mode.
function groceryEntriesFor(recipeObj, mode, household) {
  const out = [];
  scaleIngredientLines(recipeObj, mode, household).forEach(line => {
    const name = (line.scaled && line.unit === 'egg') ? 'eggs' : groceryName(line.scaled ? line.rest || line.text : line.text);
    if (!name || GROCERY_SKIP.has(name)) return;
    if (line.scaled) {
      out.push({ name, unit: line.unit, lo: line.lo, hi: line.hi, note: '' });
    } else {
      const p = parseIngredient(line.text);
      const plain = (mode === '1-3' || BATCH_RECIPES.has(recipeObj.id) || !line.byEye) && p.qty != null;
      const nm = p.unit === 'egg' ? 'eggs' : name;
      if (plain) out.push({ name: nm, unit: p.unit, lo: p.qty, hi: p.qty, note: '' });
      else {
        let note;
        const isOptional = /\boptional\b/i.test(line.text);
        if (isOptional) note = 'optional — ' + line.text.replace(/^optional:?\s*/i, '').replace(/,?\s*optional$/i, '');
        else if (line.role === 'seasoning') note = 'to taste';
        else if (p.kind === 'none') note = 'amount not given';
        else note = line.byEye ? `scale by eye (toddler serving: ${line.text})` : line.text;
        out.push({ name, unit: '', lo: null, hi: null, note });
      }
    }
  });
  return out;
}
function groceryAmountText(item) {
  const bits = [];
  if (item.lo != null && item.unit) bits.push(fmtAmount(item.unit, item.lo, item.hi));
  (item.notes || []).forEach(n => bits.push(n));
  return bits.join(' + ');
}

// Grocery lists saved before 2026-10-06 were [{ text, source }] lines with
// index-keyed checks. Carry them forward as amount-less notes so nothing a
// parent already added disappears.
function migrateGrocery(g) {
  if (g && g.version === 2 && Array.isArray(g.items)) return { version: 2, items: g.items, checked: g.checked || {} };
  const out = { version: 2, items: [], checked: {} };
  ((g && g.items) || []).forEach((old, i) => {
    if (!old || !old.text) return;
    const text = String(old.text).replace(/\.$/, '');
    const name = groceryName(text) || text.toLowerCase();
    const key = name + '|';
    let item = out.items.find(x => x.key === key);
    if (!item) { item = { key, name, unit: '', lo: null, hi: null, notes: [], sources: [], section: grocerySection(name) }; out.items.push(item); }
    if (!item.notes.includes(text)) item.notes.push(text);
    if (old.source && !item.sources.includes(old.source)) item.sources.push(old.source);
    if (g.checked && g.checked[i]) out.checked[key] = true;
  });
  return out;
}

// ============================================================
// STATE MANAGEMENT
// ============================================================
const AppState = (function() {
  let _state = {
    sectionId: "cover",
    query: "",
    category: "all",
    age: normalizeAge(safeStorageGet('roots_age')),
    checked: {},
    excludedAllergens: [],
    plantOnly: false
  };
  let _grocery = { version: 2, items: [], checked: {} };
  let _household = { '1-3': 1, '4-6': 1, '7+': 1 };
  let _favorites = [];
  let _listeners = [];

  function loadPersisted() {
    try {
      const checks = localStorage.getItem('roots_offline_checks');
      if (checks) _state.checked = JSON.parse(checks);
      const grocery = localStorage.getItem('roots_grocery');
      if (grocery) _grocery = migrateGrocery(JSON.parse(grocery));
      const hh = localStorage.getItem('roots_household');
      if (hh) {
        const parsed = JSON.parse(hh);
        ['1-3', '4-6', '7+'].forEach(k => {
          const n = Number(parsed[k]);
          if (Number.isInteger(n) && n >= 0 && n <= 6) _household[k] = n;
        });
      }
      const favs = localStorage.getItem('roots_favorites');
      if (favs) _favorites = JSON.parse(favs);
      // 2026-10-15: Recipes 06, 11, 13, 39 and 42 were merged into 01, 15, 10,
      // 36 and 33, and their numbers reused for new recipes. Move favorites
      // saved before that to the recipe each one was merged into — once, so a
      // favorite on one of the new recipes is never moved later.
      try {
        if (safeStorageGet('roots_favorites_v') !== '2') {
          const MERGED_2026_10 = { 'rec-06': 'rec-01', 'rec-11': 'rec-15', 'rec-13': 'rec-10', 'rec-39': 'rec-36', 'rec-42': 'rec-33' };
          if (Array.isArray(_favorites)) _favorites = Array.from(new Set(_favorites.map(id => MERGED_2026_10[id] || id)));
          else _favorites = [];
          localStorage.setItem('roots_favorites', JSON.stringify(_favorites));
          localStorage.setItem('roots_favorites_v', '2');
        }
      } catch (e) { /* storage unavailable: keep the in-memory list */ }
      const af = localStorage.getItem('roots_allergen_filters');
      if (af) {
        const parsed = JSON.parse(af);
        if (Array.isArray(parsed.excluded)) _state.excludedAllergens = parsed.excluded;
        if (typeof parsed.plantOnly === 'boolean') _state.plantOnly = parsed.plantOnly;
      }
    } catch (e) { /* ignore */ }
  }
  loadPersisted();

  function storageWarning(msg) {
    try {
      let el = document.getElementById('storage-warning');
      if (!el) {
        el = document.createElement('div');
        el.id = 'storage-warning';
        el.setAttribute('role', 'status');
        el.style.cssText = 'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:#8b3a3a;color:#fff;padding:8px 14px;border-radius:6px;font:12px Arial,sans-serif;z-index:9999;box-shadow:0 2px 8px rgba(0,0,0,.2);max-width:90%;text-align:center';
        document.body.appendChild(el);
      }
      el.textContent = msg;
      el.style.display = 'block';
      clearTimeout(el._t);
      el._t = setTimeout(() => { el.style.display = 'none'; }, 4000);
    } catch (_) {}
  }
  function saveChecks() { try { localStorage.setItem('roots_offline_checks', JSON.stringify(_state.checked)); } catch (e) { storageWarning('Could not save checklist on this device.'); } }
  function saveGrocery() { try { localStorage.setItem('roots_grocery', JSON.stringify(_grocery)); } catch (e) { storageWarning('Could not save grocery list on this device.'); } }
  function saveHousehold() { try { localStorage.setItem('roots_household', JSON.stringify(_household)); } catch (e) { storageWarning('Could not save your table on this device.'); } }
  function saveFavorites() { try { localStorage.setItem('roots_favorites', JSON.stringify(_favorites)); } catch (e) { storageWarning('Could not save favorites on this device.'); } }
  function saveAllergenFilters() {
    try {
      localStorage.setItem('roots_allergen_filters', JSON.stringify({
        excluded: _state.excludedAllergens,
        plantOnly: _state.plantOnly
      }));
    } catch (e) { storageWarning('Could not save allergen filters on this device.'); }
  }
  function notify(changes) { _listeners.forEach(fn => fn(changes)); }

  // Restore age from localStorage
  const savedAge = normalizeAge(safeStorageGet('roots_age'));
  _state.age = savedAge;

  return {
    getState() { return { ..._state }; },
    getGrocery() { return { items: _grocery.items.map(i => ({ ...i, notes: [...(i.notes || [])], sources: [...(i.sources || [])] })), checked: { ..._grocery.checked } }; },
    getHousehold() { return { ..._household }; },
    changeHousehold(age, delta) {
      if (!(age in _household)) return;
      const next = Math.max(0, Math.min(6, _household[age] + delta));
      if (next === _household[age]) return;
      _household[age] = next;
      saveHousehold();
      notify({ type: 'household' });
    },
    getFavorites() { return [..._favorites]; },
    setSection(id) { if (_state.sectionId !== id) { _state.sectionId = id; notify({ type: 'section', id }); } },
    setQuery(q) { _state.query = q; notify({ type: 'search', query: q }); },
    setCategory(cat) { if (_state.category !== cat) { _state.category = cat; notify({ type: 'category', category: cat }); } },
    setAge(age) {
      if (_state.age !== age) {
        _state.age = age;
        try { localStorage.setItem('roots_age', age); } catch (e) { storageWarning('Could not save age preference.'); }
        notify({ type: 'age', age });
      }
    },
    toggleCheck(index) { _state.checked[index] = !_state.checked[index]; saveChecks(); notify({ type: 'checklist' }); },
    // Grocery list v2 (2026-10-06): entries carry a name, unit and amount
    // range. Same name + same unit from different recipes are added
    // together; anything without a clean amount keeps its note instead of
    // a guessed number, so the list never invents a quantity.
    addGroceryEntries(entries, source) {
      let changed = 0;
      (entries || []).forEach(e => {
        const key = e.name + '|' + (e.lo != null ? e.unit : '');
        let item = _grocery.items.find(i => i.key === key);
        if (!item) {
          item = { key, name: e.name, unit: e.lo != null ? e.unit : '', lo: null, hi: null, notes: [], sources: [], section: grocerySection(e.name) };
          _grocery.items.push(item);
        }
        if (e.lo != null) { item.lo = (item.lo || 0) + e.lo; item.hi = (item.hi || 0) + e.hi; }
        if (e.note && !item.notes.includes(e.note)) item.notes.push(e.note);
        if (source && !item.sources.includes(source)) item.sources.push(source);
        delete _grocery.checked[key];
        changed++;
      });
      if (changed) { saveGrocery(); notify({ type: 'grocery' }); }
      return changed;
    },
    toggleGroceryItem(key) { _grocery.checked[key] = !_grocery.checked[key]; saveGrocery(); notify({ type: 'grocery' }); },
    setAllGroceryChecked(checked) { _grocery.checked = {}; if (checked) _grocery.items.forEach(i => _grocery.checked[i.key] = true); saveGrocery(); notify({ type: 'grocery' }); },
    clearGrocery() { _grocery.items = []; _grocery.checked = {}; saveGrocery(); notify({ type: 'grocery' }); },
    toggleFavorite(id) {
      const idx = _favorites.indexOf(id);
      if (idx > -1) _favorites.splice(idx, 1);
      else _favorites.push(id);
      saveFavorites();
      notify({ type: 'favorites' });
      return _favorites.includes(id);
    },
    isFavorite(id) { return _favorites.includes(id); },
    subscribe(fn) { _listeners.push(fn); return () => { _listeners = _listeners.filter(f => f !== fn); }; },
    resetSearch() { _state.query = ""; notify({ type: 'search', query: '' }); },
    toggleExcludeAllergen(name) {
      const i = _state.excludedAllergens.indexOf(name);
      if (i > -1) _state.excludedAllergens.splice(i, 1);
      else _state.excludedAllergens.push(name);
      saveAllergenFilters();
      notify({ type: 'allergenFilter' });
    },
    setPlantOnly(on) {
      _state.plantOnly = !!on;
      saveAllergenFilters();
      notify({ type: 'allergenFilter' });
    },
    clearAllergenFilters() {
      _state.excludedAllergens = [];
      _state.plantOnly = false;
      saveAllergenFilters();
      notify({ type: 'allergenFilter' });
    }
  };
})();

// ============================================================
// DOM HELPERS
// ============================================================
const DOM = {
  // Escapes for safe use as HTML *text* (<, >, &). Quotes are left alone
  // here on purpose — see escapeAttr() for the attribute-safe version.
  escape(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },
  // Escapes for safe use inside a double-quoted HTML attribute. Builds on
  // escape() and additionally encodes " and ' so a stray quote in recipe
  // text (e.g. a 3" pan) can't break out of a data-* attribute.
  escapeAttr(str) {
    return DOM.escape(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
};

// ============================================================
// FOCUS MANAGEMENT
// ============================================================
// Focus trap is query-based (walks the modal's focusable elements on every
// Tab keypress) rather than sentinel-based. This handles dynamically
// rendered modal content (e.g. cooking mode's step list) without needing to
// keep sentinel divs in sync with content changes. Per-modal state (the
// element that had focus before the modal opened, and its keydown handler)
// is kept in a stack keyed by modal element, so nesting multiple modals
// (e.g. sidebar -> grocery panel) restores focus correctly at each level
// instead of only the outermost previous focus.
const FocusManager = {
  _stack: [], // [{ el, previousFocus, handler }, ...]
  trap(el) {
    if (!el) return;
    const previousFocus = document.activeElement;
    // aria-modal is only valid on dialog roles; the mobile Contents drawer is
    // an <aside role="navigation">, so it keeps the focus trap without it.
    const isDialog = /dialog/.test(el.getAttribute('role') || '');
    if (isDialog) el.setAttribute('aria-modal', 'true');
    const focusable = el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const first = focusable[0];
    if (first) first.focus();
    const handler = (e) => {
      if (e.key === 'Tab') {
        const focusableEls = el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!focusableEls.length) return;
        const firstEl = focusableEls[0];
        const lastEl = focusableEls[focusableEls.length - 1];
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    el.addEventListener('keydown', handler);
    this._stack.push({ el, previousFocus, handler });
  },
  release(el) {
    if (!el) return;
    const idx = this._stack.map(entry => entry.el).lastIndexOf(el);
    if (idx === -1) return;
    const [entry] = this._stack.splice(idx, 1);
    // Explicitly false, not absent — a dialog-role element should always
    // declare its modal state rather than leaving it unstated once closed.
    if (/dialog/.test(entry.el.getAttribute('role') || '')) entry.el.setAttribute('aria-modal', 'false');
    else entry.el.removeAttribute('aria-modal');
    entry.el.removeEventListener('keydown', entry.handler);
    if (entry.previousFocus && document.body.contains(entry.previousFocus)) {
      entry.previousFocus.focus();
    }
  },
  releaseAll() {
    // Unwind in reverse so each level's previous-focus restoration is at
    // least attempted, even though only the final focus() call sticks.
    while (this._stack.length) {
      const entry = this._stack.pop();
      if (/dialog/.test(entry.el.getAttribute('role') || '')) entry.el.setAttribute('aria-modal', 'false');
      else entry.el.removeAttribute('aria-modal');
      entry.el.removeEventListener('keydown', entry.handler);
      if (entry.previousFocus && document.body.contains(entry.previousFocus)) {
        entry.previousFocus.focus();
      }
    }
  }
};

// ============================================================
// OVERLAY LOCK (shared backdrop + scroll lock)
// ============================================================
// The mobile browse sidebar, the mobile tools dashboard, and the grocery
// panel are independent overlays that can be opened in any combination,
// but they all share one #backdrop element and one body-scroll lock.
// Each closer used to reset both unconditionally — so closing one overlay
// (e.g. collapsing the tools dashboard) could unlock page scroll and hide
// the backdrop out from under a different overlay (e.g. an open grocery
// panel) that was still relying on them. This reference-counts how many
// overlays currently hold the lock and only releases the shared resources
// once none remain.
const OverlayLock = {
  _count: 0,
  acquire() {
    this._count++;
    const bd = document.getElementById('backdrop');
    bd.classList.add('visible');
    bd.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  },
  release() {
    this._count = Math.max(0, this._count - 1);
    if (this._count === 0) {
      const bd = document.getElementById('backdrop');
      bd.classList.remove('visible');
      bd.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
    }
  }
};

// ============================================================
// AGE GUIDANCE
// ============================================================
const AGE_GUIDANCE = {
  // fish: shown only on recipes that contain fish (see getScaledContent)
  "1-3": { label: "Ages 1–3", note: "Softer textures, safer shapes, smaller starting portions, less added sodium.", fish: "For fish, about 1 oz cooked per serving is a useful starting point." },
  "4-6": { label: "Ages 4–6", note: "Same family food; larger portions, progressively broader textures and increasing participation.", fish: "For fish, about 2 oz per serving." },
  "7+": { label: "Ages 7+", note: "Same family meal; hunger-led portions and increasing independence with serving and preparation.", fish: "For fish, about 2–3 oz per serving." },
  "family": { label: "Whole family", note: "One pot for the children at your table: each child's portion added together.", fish: "Fish follows the Fish & Mercury guidance: about 1 oz at 1–3, 2 oz at 4–6, 2–3 oz at 7+." }
};


// ============================================================
// RECIPE FACTORY
// ============================================================
function recipe(id, title, cat, influence, role, ingredients, method, safety, variations, baseYield, metaOverrides) {
  const recipeObj = {
    id, title, category: cat, influence, role, ingredients, method, safety, variations, baseYield: baseYield || "1 toddler serving",
    prepTime: metaOverrides?.prepTime || '10 min',
    cookTime: metaOverrides?.cookTime || '15 min',
    difficulty: metaOverrides?.difficulty || 'Easy',
    dietary: metaOverrides?.dietary || ['Plant-forward'],
    allergens: metaOverrides?.allergens || ['Varies'],
    getScaledContent: function(ageKey) {
      const age = AGE_GUIDANCE[ageKey] || AGE_GUIDANCE["family"];
      const household = AppState.getHousehold();
      const isFav = AppState.isFavorite(this.id);
      const difficultyStars = { 'Easy': '⭐', 'Medium': '⭐⭐', 'Advanced': '⭐⭐⭐' }[this.difficulty] || '⭐';
      const batch = BATCH_RECIPES.has(this.id);
      const hasFish = (this.allergens || []).includes('Fish');

      const dietaryTags = (this.dietary || []).map(d => `<span class="badge-tag dietary">🌱 ${DOM.escape(d)}</span>`).join('');
      const allergenList = (this.allergens && this.allergens.length) ? this.allergens : [];
      const optional = this.allergenOptional || [];
      const allergenTags = allergenList.length
        ? allergenList.map(a => optional.includes(a)
            ? `<span class="badge-tag allergen optional">⚠️ ${DOM.escape(a)} (optional)</span>`
            : `<span class="badge-tag allergen">⚠️ ${DOM.escape(a)}</span>`).join('')
        : '<span class="badge-tag dietary">✓ No common allergens flagged</span>';
      const allergenNoteHtml = (this.allergenNotes && this.allergenNotes.length)
        ? `<div class="variations-note"><strong>Allergen notes:</strong> ${this.allergenNotes.map(n => DOM.escape(n)).join('; ')}</div>`
        : '';
      const lines = scaleIngredientLines(this, ageKey, household);
      const ingredientsItems = lines.map(l => {
        if (l.scaled) return `<li role="listitem"><strong class="scaled-qty">${DOM.escape(l.amount)}</strong> ${DOM.escape(l.rest)}<span class="base-qty">Toddler base: ${DOM.escape(l.text)}</span></li>`;
        if (l.byEye) return `<li role="listitem">${DOM.escape(l.text)} <span class="by-eye">per toddler · scale by eye</span></li>`;
        return `<li role="listitem">${DOM.escape(l.text)}</li>`;
      }).join('');
      const anyEye = lines.some(l => l.byEye);

      let ageNote;
      if (batch) {
        ageNote = `<strong>Batch recipe:</strong> these amounts make one shared batch, so they stay the same at every age. Serve hunger-led portions and adapt the texture for the youngest.`;
      } else if (ageKey === '1-3') {
        ageNote = `<strong>${DOM.escape(age.label)}:</strong> ${DOM.escape(age.note)}${hasFish ? ' ' + DOM.escape(age.fish) : ''}`;
      } else if (ageKey === 'family') {
        ageNote = `<strong>Whole family:</strong> the amounts add up one portion for each child at your table (${DOM.escape(householdLabel(household))}). Older children get about 2× the toddler protein and about 1¾× everything else${hasFish ? '; ' + DOM.escape(age.fish.charAt(0).toLowerCase() + age.fish.slice(1, -1)) : ''}. These are starting points, not targets. Adults aren't included, so add more for grown-ups.${anyEye ? ' Lines marked “scale by eye” are written as a range or a whole item, so they aren’t calculated.' : ''}` + householdEditorHTML(household);
      } else {
        ageNote = `<strong>${DOM.escape(age.label)}:</strong> ${DOM.escape(age.note)} Amounts are for one child this age: about 2× the toddler protein and about 1¾× everything else${hasFish ? '; ' + DOM.escape(age.fish.charAt(0).toLowerCase() + age.fish.slice(1, -1)) : ''}. Starting points, not targets.${anyEye ? ' Lines marked “scale by eye” aren’t calculated.' : ''}`;
      }

      return `
        <div class="recipe-card" role="article" data-recipe-id="${DOM.escapeAttr(this.id)}">
          <button type="button" class="back-to-list" data-open-list>‹ All recipes</button>
          <h2>${DOM.escape(this.title)}</h2>
          <div class="recipe-meta">
            <span class="influence">${DOM.escape(this.influence)}</span>
            <span class="role">${DOM.escape(this.role)}</span>
            <span>Yield: ${DOM.escape(this.baseYield)}${ageKey !== '1-3' && !batch ? ' (toddler base)' : ''}</span>
            <span class="badge-tag time">⏱️ ${DOM.escape(this.prepTime)} prep · ${DOM.escape(this.cookTime)} cook</span>
            <span class="badge-tag difficulty">${difficultyStars} ${DOM.escape(this.difficulty)}</span>
            ${dietaryTags}
            ${allergenTags}
          </div>
          <div class="recipe-age-switch" role="group" aria-label="Show amounts for">
            <span class="recipe-age-label">Cooking for</span>
            ${[['1-3','Ages 1–3'],['4-6','4–6'],['7+','7+'],['family','Whole family']].map(([k,l]) => `<button type="button" class="recipe-age-btn${k === ageKey ? ' active' : ''}" data-age="${k}" aria-pressed="${k === ageKey}">${l}</button>`).join('')}
          </div>
          <div class="age-adaptation">${ageNote}</div>
          <div class="recipe-actions">
            <button type="button" class="btn-cooking-mode" data-recipe-id="${DOM.escapeAttr(this.id)}">👨‍🍳 Cook Mode</button>
            <button type="button" class="btn-favorite ${isFav ? 'active' : ''}" data-recipe-id="${DOM.escapeAttr(this.id)}" aria-label="${isFav ? 'Remove from' : 'Add to'} favorites">
              ${isFav ? '⭐' : '☆'} Favorite
            </button>
            <button type="button" class="btn-grocery-add" data-recipe-id="${DOM.escapeAttr(this.id)}" data-title="${DOM.escapeAttr(this.title)}">
              🛒 Add to Grocery
            </button>
          </div>
          <div class="recipe-section"><strong>Ingredients</strong><ul class="ingredients-list" role="list">${ingredientsItems}</ul></div>
          <div class="recipe-section"><strong>Method</strong><div class="method-text">${DOM.escape(this.method)}</div></div>
          <div class="safety-note"><strong>🛡️ Toddler Safety:</strong> ${DOM.escape(this.safety)}</div>
          ${allergenNoteHtml}${this.variations ? `<div class="variations-note"><strong>Family variations:</strong> ${DOM.escape(this.variations)}</div>` : ''}
        </div>
      `;
    }
  };
  return recipeObj;
}

// "Who's at your table" editor — used on recipe cards (Whole family) and
// in the Plan panel. Buttons are handled by one delegated listener.
function householdEditorHTML(h) {
  return `<div class="household" role="group" aria-label="Children at your table">${AGE_KEYS.map(k => `<div class="hh-row"><span class="hh-label">Ages ${AGE_SHORT[k]}</span><button type="button" class="hh-btn" data-hh="${k}" data-d="-1" aria-label="One fewer child aged ${AGE_SHORT[k]}"${h[k] <= 0 ? ' disabled' : ''}>−</button><output class="hh-count">${h[k]}</output><button type="button" class="hh-btn" data-hh="${k}" data-d="1" aria-label="One more child aged ${AGE_SHORT[k]}"${h[k] >= 6 ? ' disabled' : ''}>+</button></div>`).join('')}</div>`;
}
function renderHouseholdPanel() {
  const box = document.getElementById('household-panel');
  if (box) box.innerHTML = `<p class="hint">Who's at your table? Used for “Whole family” amounts.</p>${householdEditorHTML(AppState.getHousehold())}`;
}

// ============================================================
// RECIPES — Phase 2: fetched at runtime from ./recipes.json
// (replaces the formerly-embedded RECIPE_DATA array; see loadRecipes())
// ============================================================
let RECIPE_DATA = [];
let RECIPES = [];

function buildRecipesFromData(dataArray) {
  return dataArray.map(d => {
    const r = recipe(
      d.id, d.title, d.category, d.influence, d.role,
      d.ingredients, d.method, d.safety, d.variations, d.baseYield,
      { prepTime: d.prepTime, cookTime: d.cookTime, difficulty: d.difficulty, dietary: d.dietary, allergens: d.allergens }
    );
    if (d.allergenNotes && d.allergenNotes.length) r.allergenNotes = d.allergenNotes;
    if (d.allergenOptional && d.allergenOptional.length) r.allergenOptional = d.allergenOptional;
    return r;
  });
}

async function loadRecipes() {
  const response = await fetch('./recipes.json');
  if (!response.ok) throw new Error('Failed to load recipes.json: ' + response.status);
  RECIPE_DATA = await response.json();
  RECIPES = buildRecipesFromData(RECIPE_DATA);
  appData.sections = appData.sections.filter(s => !(s.id && s.id.startsWith('rec-'))).concat(RECIPES);
}

// ============================================================
// DATA
// ============================================================
const appData = {
  sections: [
    {
      id: "cover",
      title: "🏠 Cover & Overview",
      category: "start",
      isQuickStart: true,
      icon: "🏠",
      description: "Welcome & philosophy",
      content: `
      <div class="cover-block">
        <div class="title">THE GLOBAL TODDLER TABLE</div>
        <div class="subtitle">ROOTS EDITION</div>
        <div class="tag">One family meal, adapted for ages 1–3, 4–6 and 7+.</div>
        <div class="tag">No dairy, and no beef, pork or poultry. Built on fish, eggs, beans and plants. Soy is optional.</div>
        <div class="tag">42 recipes, including 10 for nights with no time to cook.</div>
        <div class="motto">"Nourish the child. Honor the food. Share the table."</div>
      </div>

      <div class="home-reassure">
        <p class="home-reassure-lead">Some days dinner will be beautiful. Some days it will be toast and fruit.</p>
        <p>Both can belong at the table. Pick one family meal, adapt it for each child, and keep going.</p>
      </div>

      <div class="home-hero" role="navigation" aria-label="Start here">
        <div class="quick-start-card home-hero-card primary" data-nav="tonight" role="button" tabindex="0"><span class="icon">🌙</span><div class="label">Dinner tonight</div><div class="desc">Fastest dinners first — type what you have to find a match</div></div>
        <div class="quick-start-card home-hero-card" data-nav="emergency" role="button" tabindex="0"><span class="icon">🆘</span><div class="label">Day fell apart?</div><div class="desc">10 emergency &amp; no-cook meals from pantry and freezer staples</div></div>
      </div>

      <div class="quick-start-grid" role="navigation" aria-label="Quick start">
        <div class="quick-start-card" role="button" tabindex="0" data-nav="recipes"><span class="icon">🍳</span><div class="label">Browse Recipes</div><div class="desc">42 family recipes</div></div>
        <div class="quick-start-card" role="button" tabindex="0" data-nav="planner"><span class="icon">📅</span><div class="label">Plan the Week</div><div class="desc">7-day meal schedule</div></div>
        <div class="quick-start-card" role="button" tabindex="0" data-nav="formulas"><span class="icon">🧪</span><div class="label">Master Formulas</div><div class="desc">6 cooking patterns</div></div>
        <div class="quick-start-card" role="button" tabindex="0" data-nav="guides"><span class="icon">📖</span><div class="label">Guides & Resources</div><div class="desc">Nutrition & foodways</div></div>
      </div>
      <p class="home-offline">Once it has loaded, Roots keeps working offline — handy in a kitchen with weak Wi-Fi.</p>

      <h2>A Note to Conscientious Parents</h2>
      <p>You do not need to feed a perfect toddler. You need a steady pattern you can keep up. That means enough energy and protein, regular iron-rich foods, and calcium and vitamin D. It means B12 and iodine when needed, healthy fats, and a mix of fruits and vegetables. And it means food your children can eat safely and enjoy.</p>
      <p>This book is intentionally dairy-free as a family food pattern. It is not a claim that dairy is harmful. When dairy is removed, its nutritional jobs need to be replaced deliberately.</p>
      <p>This edition is land-based-meat-free: no beef, poultry or pork. Protein, iron and B12 are built through fish, eggs and plant foods such as lentils, beans, chickpeas and tofu.</p>
      <p>The central Roots principle is one meal, adapted—not three separate meals. The 1-year-old gets the same family food with appropriate texture, shape, seasoning and portion adjustments. Older children eat the same meal in larger, hunger-led portions.</p>
      <h2>Foodways Belong at the Table</h2>
      <p>Global and Indigenous food traditions are part of how this pattern is built—not garnish. Recipes draw on pantry ideas, ingredients, and flavor paths from many regions while staying practical for a family meal. Influence is not the same as claiming authenticity. When a family has its own traditions, those take priority; this book is a framework that can make room for them.</p>
      <p>The fuller Foodways section later in the book names regional and Indigenous references in more detail.</p>
      <div class="callout">This is a general planning resource, not medical advice. Review a fully dairy-free or highly restricted pattern with the child's pediatrician or pediatric dietitian if growth, allergy, feeding difficulty, or nutrient adequacy is a concern.</div>
      <h2>The Nutritional Architecture</h2>
      <ul>
        <li><strong>ANCHOR</strong> — protein and/or iron: fish, egg, lentils, beans, chickpeas, tofu.</li>
        <li><strong>ENERGY</strong> — grain or root: rice, oats, quinoa, potato, sweet potato, plantain, pasta.</li>
        <li><strong>COLOR</strong> — produce: greens, squash, peas, carrots, tomato, berries, mango, citrus.</li>
        <li><strong>FAT</strong> — avocado, olive oil, tahini, nut/seed butter, fatty fish.</li>
        <li><strong>COVER</strong> — calcium, vitamin D, B12 and iodine when needed.</li>
      </ul>
      <div class="callout"><strong>ENERGY DENSITY &amp; SMALLER APPETITES</strong><br>Toddlers often eat small volumes. When appetite is modest, prioritize energy-dense components: avocado, olive oil, tahini or thin seed/nut butter, fatty fish, and soft cooked grains or roots.<br><br>Add ½–1 tsp oil or a thin layer of tahini off heat to porridges, stews and mashes. Offer the energy-dense part of the meal first when useful.<br><br>Purées can temporarily increase intake during illness or texture refusal—add a little oil and return to textured food as skills return.<br><br>Growth, activity and individual needs vary. Persistent low intake, weight concerns or feeding difficulty warrant a conversation with the child's clinician.</div>
      <h2>Still Breastfeeding or on Formula?</h2>
      <p>This book's recipes and portions assume a child who is eating solids as the main event, which is the typical picture from around age one onward — but some one-year-olds are still nursing regularly, and some are still on formula. Neither changes how to use this book.</p>
      <p>If breastfeeding: the AAP supports continued breastfeeding, alongside solid foods, for as long as it's mutually wanted by parent and child — commonly two years or beyond. Keep offering the family table as written; nursing and solids work alongside each other rather than competing.</p>
      <p>If using formula past 12 months: standard infant formula is designed for the first year, and most toddlers eating a varied, fortified diet do not need a specialty "toddler formula" or "toddler milk" — the AAP notes these products aren't nutritionally complete or regulated the same way infant formula is, and typically offer nothing that a fortified plant milk and varied solid diet don't already cover. Whether and how long to continue any formula past 12 months is a conversation for your pediatrician, not something this book can resolve in general terms.</p>
      <p>Either way, breastmilk or formula intake is one more input alongside the food pattern in this book, not a competing plan — talk to your pediatrician or a lactation consultant about your specific situation, especially around how it affects appetite for solids or overall nutrient coverage.</p>
    `
    },
    {
      id: "one-table",
      title: "📊 One Table · Three Ages",
      category: "start",
      content: `
      <h1>One Table · Three Ages</h1>
      <table>
        <tr><th>Family meal</th><th>Age 1–3</th><th>Age 4–6</th><th>Age 7+</th></tr>
        <tr><td>Lentil-rice bowl</td><td>Mash/soften; low sodium</td><td>Family portion</td><td>Family portion</td></tr>
        <tr><td>Salmon + sweet potato + peas</td><td>Flake; bone-check; ~1 oz</td><td>~2 oz fish</td><td>~2–3 oz fish</td></tr>
        <tr><td>Bean + squash bowl</td><td>Mash beans; soft squash</td><td>Family portion</td><td>Family portion</td></tr>
        <tr><td>Chickpea patty</td><td>Soft pieces/strips</td><td>Whole/halved</td><td>Family portion</td></tr>
        <tr><td>Oatmeal</td><td>Soft, safe texture</td><td>Normal family texture</td><td>Normal family texture</td></tr>
      </table>
      <p class="meta">Starting portions are not targets. Caregiver decides what/when/where; child decides whether and how much.</p>
      <p class="meta">This book uses one primary age framework — 1–3, 4–6, 7+ — throughout, matching the texture-ladder logic in "Grow With the Table." Two tables in this book depart from it deliberately: the Fish &amp; Mercury table and the Growth Adjustments / Daily Reference Checkpoints tables use the FDA/EPA and NIH/AAP's own published age bands, because those figures are only accurate at the bands the source agencies defined them for. Both are flagged where they occur.</p>
      <h2>Growth Adjustments — Scaling the Same Recipe</h2>
      <p>Every core recipe is written at a base portion for ages 1–3. Scale the same recipe up in step with the texture progression above.</p>
      <table>
        <tr><th>Component</th><th>Age 1–3</th><th>Age 4–8</th><th>Age 9+</th></tr>
        <tr><td>Fish/protein</td><td>1 oz (base)</td><td>~2 oz (×2)</td><td>~3 oz (×3)</td></tr>
        <tr><td>Legumes</td><td>½ cup (base)</td><td>¾–1 cup</td><td>1–1¼ cup</td></tr>
        <tr><td>Grains</td><td>½ cup (base)</td><td>¾–1 cup</td><td>1 cup+</td></tr>
        <tr><td>Oil/fat</td><td>1 tsp (base)</td><td>1½–2 tsp</td><td>2 tsp+</td></tr>
        <tr><td>Vegetables</td><td>As written</td><td>1.5–2×</td><td>2–2.5×</td></tr>
      </table>
      <p class="meta">These multipliers are starting points, not targets—hunger-led eating still governs the amount actually served. Portion scaling and texture scaling move together: don't serve a 4-year-old portion in a 1-year-old's texture, or vice versa.</p>
      <p class="meta">Fish is the one exception: it uses its own, more finely graded age bands because of mercury limits — always read fish portions off the Fish &amp; Mercury table rather than this one.</p>
      <p class="meta">A note on the age bands in this table: 1–3, 4–8 and 9+ are the official NIH/AAP nutrient-reference bands, not this book's usual 1–3, 4–6, 7+ framework used elsewhere (see "One Table · Three Ages"). They're kept here as published, since re-bucketing them would misstate the underlying reference values.</p>
      <div class="callout">Zinc RDA rises to 5 mg/day at ages 4–8 and 8 mg/day at 9–13 — a bigger jump than the portion multiplier alone suggests. Keep the soak-and-pair habits (see Zinc &amp; Phytates) at every age, not just for the youngest eater.</div>
      <h2>Hydration &amp; Fiber</h2>
      <p>Water needs vary with body size, activity and climate, so treat any number here as a starting range, not a target to hit exactly. A commonly used guide for ages 1–3 is roughly 1–4 cups of plain water a day, on top of milk or fortified milk alternative and the fluid naturally in food, rising toward 1.5–5 cups by ages 4–5; offer more in hot weather, with activity, or during illness. Water, not juice, should do most of that work — the Roots pattern already keeps juice to at most 4 oz/day.</p>
      <p>This pattern's legumes, whole grains and vegetables make it naturally fiber-rich, which is a strength — but fiber without enough fluid can make constipation more likely, not less. If a toddler is uncomfortable, straining, or passing hard or infrequent stools, the usual first steps are: offer water steadily through the day (not just at meals), keep fruit and vegetables in the daily rotation, and support regular movement/play. Introduce fiber-rich foods gradually rather than all at once if a child isn't used to them, so digestion has time to adjust. Ongoing constipation, blood in the stool, or pain — see When to Call the Pediatrician in Toddler Safety at a Glance — warrant a clinician's input rather than home management alone.</p>
    `
    },
    {
      id: "feeding-routines",
      title: "🍽️ Feeding & Family Routines",
      category: "guide",
      content: `
      <h1>Feeding &amp; Family Routines</h1>
      <h2>Responsive Feeding — Who Does What</h2>
      <p>The Roots table works best when roles stay clear. Think of feeding your child like a road with a line down the middle: you stay in your lane, and your child stays in theirs.</p>
      <table>
        <tr><th>The caregiver's lane</th><th>The child's lane</th></tr>
        <tr><td>What food is offered</td><td>Whether to eat</td></tr>
        <tr><td>When it is offered</td><td>How much to eat</td></tr>
        <tr><td>Where eating happens</td><td></td></tr>
      </table>
      <p>This is sometimes called the division of responsibility, a feeding framework widely used by pediatric clinicians and dietitians. It protects both nourishment and trust: when you stay in your lane, you can trust your child to do their job with eating.</p>
      <p><strong>Practical habits:</strong></p>
      <ul><li>Offer the same family meal, adapted for texture and safety.</li><li>Include at least one food the child can usually manage.</li><li>Avoid pressure, bargaining, or short-order cooking.</li><li>Trust appetite across the day and week, not every single plate.</li><li>If growth, extreme restriction, or ongoing distress is a concern, check in with the child's clinician.</li></ul>
      <p>If mealtimes have involved pressure or bargaining up to now, expect a rough patch when you first stop: a child used to being coaxed or negotiated with may push back harder for a while before settling into the new pattern. That temporary uptick isn't a sign the approach is failing — it's usually part of adjusting to it. Hold the pattern gently and consistently rather than reading a hard week as a reason to go back to the old habits.</p>
      <p>A calm table teaches more than a perfect plate.</p>
      <h3>A Few Common Moments, and a Roots-Style Response</h3>
      <p><strong>The child rejects the whole meal.</strong> Stay calm rather than scrambling to make a substitute. You might say, "You don't have to eat the stew. This is dinner, and there will be another meal in the morning." Clear the plate without comment when the meal is over, and hold to water only until the next scheduled meal or snack.</p>
      <p><strong>The child eats only one food and wants more of it.</strong> It's fine to say the preferred food is finished for now, and point to what else is on the table. There's no need to withhold a preferred food as leverage, and no need to keep producing endless refills of a single item either.</p>
      <p><strong>The child plays with food, mashes it, or gets messy.</strong> Sensory exploration is a normal part of learning to eat through the toddler years. Supervision and a seated, safe setup still matter; if play turns into throwing or the meal clearly becomes playtime, it's fine to end it calmly: "Looks like you're done eating. Let's wash hands."</p>
      <p>Seek extra support from the child's clinician or a pediatric dietitian if growth stalls or drops, if entire food groups are being refused to the point nutrient adequacy is a real concern, or if meals are marked by ongoing crying, gagging, or distress.</p>
      <h2>Screen-Free Meals</h2>
      <p>See the full <strong>Screens, Attention & The Family Table</strong> guide in this book for evidence-based guidance on managing screens with young children. The short version: keep screens off during meals and seated snacks when possible, protect sleep by removing screens from the bedroom, and prioritize co-viewing and quality content when screens are used.</p>
      <h2>When Eating Feels Stuck</h2>
      <ul><li>Keep offering foods without pressure or commentary.</li><li>Serve unfamiliar foods in small amounts beside accepted foods.</li><li>Repeat exposure; acceptance often takes many tries.</li><li>Change the form, not necessarily the food: roasted rather than steamed, mashed rather than whole, warm rather than cold.</li><li>Do not use dessert or screens as a reward for eating.</li><li>When volume is low, protect energy density with the appropriate fats described in this guide.</li></ul>
      <p><strong>Introducing a New Food — A Simple Protocol</strong></p>
      <ul>
        <li>Serve a small amount — a spoonful or a few pieces, not a full portion — alongside at least one food the child already accepts.</li>
        <li>Offer it without comment, pressure or a "just try it." Let the child touch, smell, play with or refuse it; all of that is part of learning the food, not a failed attempt.</li>
        <li>Expect several tries before a real verdict. Research on toddlers and produce backs a similar pattern — repeated tasting across a stretch of separate days, not a single sitting, is what moves acceptance. Some toddlers take considerably longer, and that's normal too.</li>
        <li>Space attempts out — every few days rather than every meal — so the food stays a low-pressure presence rather than a recurring standoff.</li>
        <li>A food a child refuses today can go back on the shelf and return in a few weeks. Refusal now isn't a verdict; it's one data point.</li>
      </ul>
      <h2>Calcium Absorption — Practical Notes</h2>
      <p>Do not rely on spinach, Swiss chard, rhubarb, or beet greens as calcium anchors: their calcium is poorly absorbed because of oxalates. Prefer reliable fortified foods or calcium-set tofu, then use kale, bok choy, broccoli, collards, beans, tahini, and fish with soft bones as contributors. Vitamin D supports calcium absorption; keep added sodium modest.</p>
      <h2>Foodways Respect Line</h2>
      <p>Foodway influence is an invitation, not ownership. Recipe labels describe a pantry or flavor path, not a claim to represent a Nation, country, or household. Where a family has its own traditions or connection to a specific community, those foods and knowledge should lead.</p>
    `
    },
    {
      id: "organic",
      title: "🌱 Organic & Sourced",
      category: "start",
      content: `
      <h1>Organic &amp; Thoughtfully Sourced</h1>
      <p>Organic is a production standard, not a nutrient category. Buy organic when high-value and affordable; buy conventional when that keeps the table full.</p>
      <table>
        <tr><th>Buy organic first when it fits</th><th>Conventional is generally fine</th></tr>
        <tr><td>Berries; leafy greens; apples/peaches/grapes; eggs; frequent tomatoes/peppers; oats/corn/soy when preferred</td><td>Bananas; avocado; pineapple; mango; melon; onions; garlic; potatoes; frozen produce; rice/quinoa/pasta; fish by species/mercury/price</td></tr>
      </table>
      <p><strong>Pasture-Raised, Wild-Caught &amp; Local</strong> — Treat these as sourcing values, not automatic nutrition guarantees. For fish, species, mercury profile, local advisories, PFAS/environmental advisories, sourcing, preparation and affordability matter more than a wild/farmed label.</p>
      <h2>GMOs &amp; Bioengineered Foods</h2>
      <p>Genetically modified (GMO) and "bioengineered" mean the same thing in U.S. grocery aisles: a plant whose genetic material was modified using technology that could not otherwise be achieved through conventional breeding or found in nature. It's a production method, not a nutrient category—much like "organic"—and the two labels sit on opposite ends of a sourcing question, not a safety question.</p>
      <h3>The Roots GMO Take</h3>
      <p>Treat GMO status as a personal sourcing choice, not a required safety or nutrition upgrade. Currently approved bioengineered crops have been reviewed and found comparable to their conventional counterparts.</p>
      <ul>
        <li><strong>THE SCIENCE, BRIEFLY</strong> — Major scientific and regulatory bodies—including the National Academies of Sciences, Engineering, and Medicine, the World Health Organization, and the FDA—have reviewed the currently approved bioengineered crops and found no substantiated evidence of safety or nutritional differences compared to their conventional counterparts. Current FDA and USDA guidance should take precedence over a static book claim.</li>
        <li><strong>WHAT'S ACTUALLY GMO IN THE U.S.</strong> — A short list of crops accounts for nearly all bioengineered food in the American supply: corn, soybean, canola, cotton, sugar beet (most U.S. sugar comes from bioengineered sugar beets), alfalfa, and small-acreage crops such as certain papaya and potato varieties. Most of the whole grains, legumes, and fresh produce in this book's recipes—oats, quinoa, rice, lentils, chickpeas, beans, sweet potato, squash, greens, and most fruit—aren't commercially available as bioengineered crops in the first place.</li>
        <li><strong>READING THE LABEL</strong> — Since 2022, USDA's National Bioengineered Food Disclosure Standard requires qualifying packaged foods made with detectable modified genetic material to carry a "Bioengineered" or "Derived from Bioengineering" disclosure (text, a small green-and-white symbol, or a scannable code).</li>
        <li><strong>SOURCING CHOICE VS. QUALITY</strong> — Choosing GMO-free or Non-GMO Project Verified products is a legitimate personal or values-based sourcing decision—the same way choosing organic, local, or a particular fish species is. It is not, on current evidence, an automatic nutrition or safety upgrade over the conventional or bioengineered version of the same food.</li>
      </ul>
      <div class="callout"><strong>What Not to Do:</strong> Do not let GMO-avoidance quietly narrow the pantry—corn, soy, and canola oil show up in many affordable, nutritious staples. If avoiding bioengineered ingredients matters to your family, swap toward the many naturally non-GMO whole foods this book already leans on, rather than dropping a food group over sourcing alone.</div>
      <h2>4-Base Weekly Reset</h2>
      <ul>
        <li><strong>One grain/starch</strong> — rice, quinoa, oats, potato, sweet potato or plantain.</li>
        <li><strong>One big legume</strong> — lentils, black beans or chickpeas, cooked very soft.</li>
        <li><strong>One tray of vegetables</strong> — sweet potato, squash, carrots, broccoli.</li>
        <li><strong>One sauce/spread</strong> — hummus, mild tomato sauce or thin tahini-lemon.</li>
      </ul>
    `
    },
    {
      id: "planner",
      title: "📅 Plan the Week",
      category: "start",
      isQuickStart: true,
      icon: "📅",
      description: "7-day meal schedule",
      content: `
      <h1>Plan the Week</h1>
      <p>This seven-day map is a flexible pattern, not a rigid menu. Use it to see how anchors, energy foods, color, and fats can land across ordinary days—with two lower-mercury fish meals for the youngest child and room for leftovers, swaps, and emergency meals.</p>
      <p>Scale portions and texture to the child in front of you. Remove the toddler share before extra salt or heat. If a day falls apart, the 10-minute emergency meals and the same master formulas still hold the pattern together.</p>
      <table>
        <tr><th>Day</th><th>Breakfast</th><th>Lunch</th><th>Dinner</th><th>Snacks</th></tr>
        <tr id="planner-day-1"><td><strong>1</strong></td><td>Banana-tahini oats</td><td>Chickpea + sweet potato + greens</td><td>Lentil-rice bowl</td><td>Avocado toast; pear</td></tr>
        <tr id="planner-day-2"><td><strong>2</strong></td><td>Egg + plantain + avocado</td><td>Black bean + rice + pumpkin</td><td>Salmon + sweet potato + peas</td><td>Banana-chia; fortified DF yogurt</td></tr>
        <tr id="planner-day-3"><td><strong>3</strong></td><td>Pear-sesame oatmeal</td><td>Ginger tofu rice bowl</td><td>Chickpea patties + tomato pasta</td><td>Hummus + pita; mango</td></tr>
        <tr id="planner-day-4"><td><strong>4</strong></td><td>Tofu &amp; tomato scramble + toast</td><td>Chickpea-quinoa + lemon</td><td>Lentil vegetable stew</td><td>Mango + tahini; applesauce</td></tr>
        <tr id="planner-day-5"><td><strong>5</strong></td><td>Banana-flax oats</td><td>Lentil soup + toast</td><td>Three Sisters-style bean, corn &amp; squash</td><td>Avocado toast; fortified DF yogurt</td></tr>
        <tr id="planner-day-6"><td><strong>6</strong></td><td>Sweet-potato breakfast cakes + fruit</td><td>Black bean + sweet potato + avocado</td><td>Ginger trout + rice + bok choy</td><td>Banana + seed butter; pear</td></tr>
        <tr id="planner-day-7"><td><strong>7</strong></td><td>Millet-banana porridge</td><td>White bean + tomato bowl</td><td>Mediterranean chickpea &amp; herb bowl</td><td>Hummus + soft veg; berries</td></tr>
      </table>
      <p class="meta">Two principal fish meals for the youngest. FDA/EPA: ~1 oz ages 1–3, ~2 oz ages 4–7 from lower-mercury Best Choices.</p>
    `
    },
    {
      id: "grocery-list",
      title: "🛒 Grocery List & Sunday Prep",
      category: "start",
      content: `
      <h1>Roots Grocery List &amp; Sunday Prep Checklist</h1>
      <p>A shopping list mapped to the Seven-Day Global Meal Map, organized by department so a family trip stays quick.</p>
      <h2>Weekly Shopping List</h2>
      <h3>Produce (Colors &amp; Fats)</h3>
      <table>
        <tr><th>Item</th><th>Approx. quantity</th><th>Roots job</th></tr>
        <tr><td>Bananas</td><td>5–6 ripe</td><td>Porridge binder, snacks, natural sweetness</td></tr>
        <tr><td>Pears</td><td>3–4 ripe</td><td>Breakfast fruit, snack</td></tr>
        <tr><td>Mangoes</td><td>2–3 ripe</td><td>Snack; vitamin-C partner for chickpeas</td></tr>
        <tr><td>Berries (blueberry, raspberry)</td><td>2 clamshells</td><td>Vitamin-C partner, yogurt topper — quarter lengthwise if large</td></tr>
        <tr><td>Sweet potatoes</td><td>3–4 medium</td><td>Energy base, breakfast cakes</td></tr>
        <tr><td>Winter squash / pumpkin</td><td>1 medium (or 2 cans puree)</td><td>Vitamin A/C, color base</td></tr>
        <tr><td>Plantains</td><td>2 very ripe</td><td>High-energy breakfast starch</td></tr>
        <tr><td>Broccoli / carrots</td><td>1 bunch / 1 bag</td><td>Soft color base, vitamin-C partner for tofu</td></tr>
        <tr><td>Leafy greens (kale, collards or bok choy)</td><td>1 large tub or bunch</td><td>Lower-oxalate color; chop finely and cook soft for bowls (Recipes 07, 13, 31)</td></tr>
        <tr><td>Lemons &amp; limes</td><td>4–5</td><td>Vitamin-C partner for plant iron</td></tr>
        <tr><td>Avocados</td><td>4–5 ripe</td><td>Healthy fat, energy density</td></tr>
        <tr><td>Fresh ginger</td><td>1 small knob</td><td>Grated lightly for the tofu rice bowl</td></tr>
        <tr><td>Soft herbs (cilantro, parsley, thyme)</td><td>1 bunch each</td><td>Chop finely, add off-heat</td></tr>
        <tr><td>Celery</td><td>1 bunch</td><td>For the vegetable broth base</td></tr>
        <tr><td>Onion</td><td>2–3</td><td>For the vegetable broth base and family cooking</td></tr>
      </table>
      <h3>Grains, Legumes &amp; Dry Goods (Energy &amp; Anchors)</h3>
      <table>
        <tr><th>Item</th><th>Notes</th></tr>
        <tr><td>Rolled oats</td><td>Core porridge base, breakfast-cake binder</td></tr>
        <tr><td>Millet</td><td>Alternate energy base</td></tr>
        <tr><td>Quinoa</td><td>Protein-rich energy base for bowls</td></tr>
        <tr><td>Rice (brown or white)</td><td>Primary energy base</td></tr>
        <tr><td>Dry red lentils</td><td>No soak needed; iron and protein anchor</td></tr>
        <tr><td>Dry black beans</td><td>Iron, protein, calcium contributor</td></tr>
        <tr><td>Dry chickpeas</td><td>Core plant-iron anchor</td></tr>
        <tr><td>Dry white (navy) beans</td><td>Calcium contributor, protein anchor</td></tr>
        <tr><td>Oat flour</td><td>Binder for cakes and patties</td></tr>
        <tr><td>Short-cut pasta</td><td>Shells, fusilli or ditalini; cut short for safe chewing</td></tr>
        <tr><td>Whole-grain bread &amp; pita</td><td>Soft, easily compressible</td></tr>
        <tr><td>Ground flax &amp; chia</td><td>Plant ALA omega-3; never serve whole/dry</td></tr>
        <tr><td>Corn, canned or frozen</td><td>For the Three Sisters bowl; chop finely for safety</td></tr>
        <tr><td>Frozen peas</td><td>Convenient color and iron contributor</td></tr>
      </table>
      <h3>Refrigerated, Frozen &amp; Seafood (Cover, Anchors &amp; Fats)</h3>
      <table>
        <tr><th>Item</th><th>Sourcing note</th></tr>
        <tr><td>Eggs</td><td>Protein, choline and vitamin D</td></tr>
        <tr><td>Firm tofu</td><td>Calcium-set — check the label's coagulant</td></tr>
        <tr><td>Salmon fillets</td><td>Lower-mercury Best Choice</td></tr>
        <tr><td>Trout fillets</td><td>Lower-mercury Best Choice; fatty fish</td></tr>
        <tr><td>Fortified dairy-free yogurt</td><td>Unsweetened, fortified — calcium and vitamin D</td></tr>
        <tr><td>Fortified plant milk</td><td>Unsweetened, fortified — check calcium per label</td></tr>
        <tr><td>Smooth hummus</td><td>Plain, low-sodium</td></tr>
      </table>
      <h3>Oils, Condiments &amp; Fortifiers</h3>
      <ul>
        <li>Extra-virgin olive oil, for stirring into porridges and mashes off heat.</li>
        <li>Tahini and sunflower seed butter — always thin before serving, never a thick spoonful.</li>
        <li>No-added-sugar tomato purée or crushed tomatoes, for a vitamin-C partner.</li>
        <li>Mild spices (turmeric, cumin, cinnamon, thyme) — season the family portion after removing the toddler's share.</li>
        <li>Iodized salt for general family cooking; specialty salts are not automatically iodized.</li>
      </ul>
      <h2>The Roots Sunday Prep Checklist</h2>
      <p>A short list to knock out the 4-Base Weekly Reset ahead of a busy week.</p>
      <ul>
        <li><strong>Soak the beans.</strong> Submerge dry black beans and chickpeas separately in cold water for 8–12 hours (or overnight).</li>
        <li><strong>Cook and freeze base proteins.</strong> Drain, rinse, and simmer the soaked beans and chickpeas until soft; portion and freeze what won't be used within 3–4 days. Red lentils need no soaking — cook fresh during the week in about 15 minutes.</li>
        <li><strong>Batch the three grains.</strong> Cook rice, quinoa and oats; refrigerate 3–4 days or freeze for an instant energy base all week.</li>
        <li><strong>Soft-roast the colors.</strong> Toss sweet potato, squash and carrot with oil and roast until easily mashed between finger and thumb.</li>
        <li><strong>Simmer the mild tomato sauce.</strong> Remove the toddler's portion before salting the rest for the family.</li>
        <li><strong>Check the seed butters.</strong> Make sure tahini and seed butter are smooth and ready to thin — never serve a thick, sticky spoonful.</li>
        <li><strong>Set up the bone-check reminder.</strong> A sticky note on the baking dish — "flake by hand, check for bones" — keeps this front of mind on a tired weeknight.</li>
      </ul>
    `
    },
    {
      id: "formulas",
      title: "🧪 Master Formulas & Emergency",
      category: "formula",
      isQuickStart: true,
      icon: "🧪",
      description: "6 cooking patterns",
      content: `
      <h1>Master Formulas</h1>
      <p>Learn the pattern, then change the ingredients.</p>
      <table>
        <tr><th>Formula</th><th>Build it</th><th>Examples</th></tr>
        <tr><td><strong>Porridge</strong></td><td>Oats/millet + liquid + fruit + fat</td><td>Banana-tahini; pear-sesame; mango-flax</td></tr>
        <tr><td><strong>Bowl</strong></td><td>Anchor + grain/root + veg + fat (+ Vit-C if plant)</td><td>Chickpea + sweet potato + greens + lemon</td></tr>
        <tr><td><strong>Stew</strong></td><td>Legume/fish + soft veg + tomato/squash + grain + oil</td><td>Lentil-tomato; fish-pumpkin; red lentil dal</td></tr>
        <tr><td><strong>Spread</strong></td><td>Soft legume/veg + fat + thin liquid</td><td>Hummus; white-bean tomato; avocado-bean</td></tr>
        <tr><td><strong>Cake/Patty</strong></td><td>Soft protein + binder + veg/root; keep moist</td><td>Salmon-potato; chickpea-egg-oat</td></tr>
        <tr><td><strong>Leftover</strong></td><td>Yesterday's base + today's anchor + produce + fat</td><td>Rice + lentils + peas</td></tr>
      </table>
      <h2>Emergency & No-Cook Meals</h2>
      <p>When there's no time or energy to cook, ten full recipes built from pantry and freezer staples plus a few long-keeping fridge items (eggs, tofu, hummus, avocado, fruit) live in the <strong>Emergency &amp; No-Cook Meals</strong> chapter — five that come together in about ten minutes (Recipes 33, 34, 35, 37 and 42: Egg, Avocado &amp; Soft Toast Plate; Lentil, Rice &amp; Frozen Vegetable Bowl; Black Bean, Sweet Potato &amp; Avocado Bowl; Canned Salmon, Rice &amp; Pea Bowl; Tofu, Rice &amp; Frozen Vegetable Bowl), and five that need no stove — just leftovers or nothing at all (Recipes 36 and 38–41: Hummus &amp; Pita Plate with Dairy-Free Yogurt and Fruit; Dairy-Free Yogurt, Banana &amp; Oat Parfait; Sardine, White Bean &amp; Soft Bread Plate; Bean, Avocado &amp; Soft Bread Plate; Leftover Rice &amp; Bean Bowl). They also appear automatically under their usual Breakfast, Lunch, Dinner and Snack tabs — this is just the fast index for a hard night.</p>
    `
    },
    {
      id: "before-you-cook",
      title: "🔪 Before You Cook",
      category: "guide",
      content: `
      <h1>Before You Cook</h1>
      <h2>Roots Basics: Texture, Batch Cooking &amp; Safe Preparation</h2>
      <p>These quick standards apply throughout the recipes. They keep the family meal practical while making the toddler portion appropriately soft, low in added sodium, and easy to adapt.</p>
      <div class="callout"><strong>RECIPE SCAFFOLDING NOTE</strong><br>Recipes are written as practical frameworks, not rigid formulas. Quantities are oriented to a toddler-sized portion plus room to share or scale.<br><br>Approximate toddler yield is noted where helpful. Scale up freely for the rest of the family. Season the adult portion after removing the toddler share.<br><br>Cook times are guides—always judge by texture: soft enough for the child's current skills.</div>
      <h2>Legumes — Soak, Rinse, Then Cook</h2>
      <p>Black beans and chickpeas: soak separately in plenty of cold water for 8–12 hours (overnight is fine). Drain and rinse well, then cook in fresh water until completely soft and easily mashed. Red lentils do not require soaking; simmer 15–18 minutes until broken down. For the recipes that call for soaked legumes, the soak is part of the recipe—not an optional extra.</p>
      <h2>Grains &amp; Oats</h2>
      <p>Cook rice, quinoa, millet and oats fully according to the recipe or package directions. Toddler grains should be soft enough to mash easily. When batch-cooking, cool cooked grains promptly, portion, refrigerate for the short term or freeze for later use.</p>
      <h2>Vegetables &amp; Roots</h2>
      <p>Steam, simmer or roast until a toddler can easily mash the food between finger and thumb. Cut or mash according to the child's current texture skills. Frozen vegetables are a practical option; cook them until soft rather than relying on thawing alone.</p>
      <h2>Fish &amp; Eggs</h2>
      <p>Cook eggs until fully set. Cook fish until opaque and flaky; cool slightly and run fingers through every piece to check for bones. Use lower-mercury Best Choice fish and follow current FDA/EPA guidance.</p>
      <h2>Nut &amp; Seed Butters</h2>
      <p>Never offer a thick sticky spoonful. Thin nut or seed butter into porridge, yogurt, fruit, water or another moist food, or spread it in a very thin layer.</p>
      <h2>Toddler Portion First</h2>
      <p>For shared family dishes, remove the toddler portion before adding salt, hot spices or other adult-level seasoning. Keep the toddler portion moist and appropriately soft.</p>
      <h2>Purées Are a Tool, Not the Default</h2>
      <p>For illness, teething or temporary texture refusal, blend a finished Roots Stew or Roots Bowl with a little cooking liquid or fortified unsweetened soy beverage. Add about 1 tsp olive oil off heat when useful for energy density. As skills develop, return to progressively textured versions rather than making purées the permanent default.</p>
    `
    },
    {
      id: "storage-food-safety",
      title: "🧊 Storage & Food Safety",
      category: "guide",
      content: `
      <h1>Storage &amp; Food Safety</h1>
      <p>Refrigerate cooked food within 2 hours. Most cooked foundations keep about 3–4 days refrigerated; fish and egg dishes are best used sooner, generally within 1–2 days. Freeze in small portions and label with the date. Most frozen cooked components are best used within about 1–2 months for quality.</p>
      <p>Thaw preferably overnight in the refrigerator. Reheat leftovers thoroughly to steaming hot or 165°F / 74°C, then cool to lukewarm before serving. Reheat only once. Do not leave cooked food sitting at room temperature.</p>
      <p>For broth and cooked foundations, cool promptly before refrigerating or freezing. Use small containers or shallow portions to speed cooling.</p>
      <h2>Allergen Reminder</h2>
      <p>These recipes may contain egg, fish, peanut, sesame, sunflower, soy, coconut, wheat and oats (use certified gluten-free oats if avoiding gluten). Some variations suggest tree-nut butters or shellfish (the shrimp option in Recipe 13). Use them when the child has already been safely introduced to the relevant food. If an allergen is new, introduce it in an appropriate form and follow the family's pediatric guidance, particularly when allergy risk is elevated.</p>
    `
    },
    {
      id: "flex",
      title: "🔄 Flex the Table",
      category: "guide",
      content: `
      <h1>Flex the Table</h1>
      <h2>Dairy-Free &amp; Soy-Optional</h2>
      <p>For ages 12–23 months, USDA MyPlate recognizes calcium-fortified soy milk and yogurt as plant-based dairy-group alternatives. Other plant beverages vary—check labels.</p>
      <h2>Calcium Anchors vs Contributors</h2>
      <ul>
        <li><strong>Anchors:</strong> calcium-fortified soy beverage/yogurt, calcium-set tofu.</li>
        <li><strong>Contributors:</strong> tahini, beans, greens, fish with edible bones—helpful but secondary.</li>
      </ul>
      <h2>Soy-Free Calcium Sources</h2>
      <p>When soy is also avoided, reliable calcium anchors become fewer. Use these first:</p>
      <table>
        <tr><th>Source</th><th>Approx. calcium</th><th>Notes for toddlers</th></tr>
        <tr><td>Fortified pea milk (unsweetened)</td><td>~440–455 mg per cup</td><td>Highest-protein non-soy option; good daily base</td></tr>
        <tr><td>Fortified oat milk</td><td>~300–350+ mg per cup</td><td>Common and useful; lower in protein, pair with other foods</td></tr>
        <tr><td>Fortified almond, cashew or coconut beverage</td><td>Often ~450 mg per cup when fortified</td><td>Low in protein and energy — treat as a calcium source</td></tr>
        <tr><td>Fortified non-soy plant yogurt</td><td>120–250+ mg per ½ cup</td><td>Check the label; works well as a snack or porridge topper</td></tr>
        <tr><td>Canned sardines or salmon with soft bones</td><td>200–400 mg per 3 oz</td><td>Highly absorbable; mash carefully, check bones</td></tr>
        <tr><td>Tahini</td><td>~60–130 mg per Tbsp</td><td>Thin into porridge, hummus or sauces — never thick spoonfuls</td></tr>
        <tr><td>Cooked white beans</td><td>~60–100 mg per ½ cup</td><td>Already part of the Roots pattern</td></tr>
        <tr><td>Finely ground chia</td><td>~75 mg per Tbsp</td><td>Stir into yogurt alternative or banana mash</td></tr>
      </table>
      <div class="callout">Do not count greens, tahini or seeds as the main calcium strategy. Families following a fully soy-free and dairy-free pattern benefit from a short check-in with a pediatric dietitian.</div>
      <h2>Substitution Matrix</h2>
      <ul>
        <li><strong>Dairy-free</strong> → fortified soy (or careful alternatives); calcium-set tofu; verify Ca + D + protein.</li>
        <li><strong>Soy-free</strong> → beans/lentils; eggs/fish; fortified non-soy; check protein + Ca + D + B12.</li>
        <li><strong>Egg-free</strong> → beans, lentils, tofu, fish, seed butters.</li>
        <li><strong>Nut-free</strong> → sunflower/pumpkin seed butter; tahini; avocado; olive oil.</li>
        <li><strong>Fish-free</strong> → eggs, legumes, tofu; chia/flax for ALA; plan B12 + omega-3.</li>
        <li><strong>All animal foods avoided</strong> → deliberate planning + professional review for B12, iron, zinc, Ca, D, iodine, omega-3.</li>
      </ul>
      <h2>Purées: A Bridge, Not a Destination</h2>
      <p>By 12 months, most toddlers should be managing soft table-food textures — purées are properly a 4–8 month bridge, not the default past this window without a reason. They still earn a place on illness, teething or texture-refusal days.</p>
      <h2>Emerging Ingredients — Use With Caution</h2>
      <p>A couple of newer plant ingredients come up often enough in dairy-free/soy-free planning that they're worth a note, along with why they're not treated as core Roots staples yet.</p>
      <p><strong>Mankai duckweed</strong> (<em>Wolffia globosa</em>) is a water-grown plant protein studied in adult trials, where it's shown up as a complete protein with a naturally occurring, bioactive form of B12. That research has been conducted in adults, not toddlers, so treat it as an ingredient to watch rather than a primary B12 source for a young child — keep relying on eggs, low-mercury fish and reliably fortified foods for B12 instead.</p>
      <p><strong>Spirulina</strong> (blue-green algae) is a concentrated source of protein, iron and calcium by weight, but it's also prone to absorbing heavy metals and, in poorly regulated growing conditions, to cyanotoxin contamination — both of real concern for a small child. If a family wants to use it, buy only brands that are third-party tested for heavy metals and microcystins (look for USP, NSF or ConsumerLab verification), and use it as an occasional, small addition to a stew or purée rather than a daily staple.</p>
      <p>Neither ingredient is necessary — the core Roots pattern covers protein, iron, calcium and B12 without them. Treat both as optional, carefully sourced additions, not gap-fillers to reach for instead of a clinician conversation when a nutrient genuinely isn't being covered.</p>
      <h2>Portion &amp; Appetite Guide</h2>
      <p>Start small. Offer more without pressure. Portions below are starting points, not targets.</p>
      <ul>
        <li>Age 1–3: small portions of each component; fish about 1 oz at a fish meal.</li>
        <li>Age 4–6: same family foods with hunger-led portions; fish guidance about 2 oz per serving.</li>
        <li>Age 7+: same family foods with hunger-led portions; fish guidance about 2–3 oz per serving.</li>
      </ul>
      <p>Growth, appetite, activity and individual needs vary. See also the Energy Density notes on the cover page.</p>
      <h2>Allergens, Sodium &amp; Safety</h2>
      <p>Most recipes contain common allergens (egg, fish, peanut/sesame/sunflower, soy, wheat) and assume the toddler has already been safely introduced. Keep children seated and supervised. Avoid whole nuts, popcorn, thick nut-butter globs, whole grapes, hard raw vegetables, hard candy. Flake fish and remove bones every time.</p>
    `
    },
    {
      id: "safety",
      title: "🛡️ Toddler Safety at a Glance",
      category: "guide",
      content: `
      <h1>Toddler Safety at a Glance</h1>
      <p class="lead">Use this page as the quick safety reference; individual recipes add their own specific precautions.</p>
      <h2>Choking & Texture</h2>
      <ul>
        <li>Serve food soft enough to mash easily between fingers or with gentle pressure from a fork.</li>
        <li>Cut or prepare foods according to the child's developmental eating skills; avoid hard, round, sticky or rubbery pieces that can obstruct the airway.</li>
        <li>Nut and seed butters should be spread very thinly or thinned into another food—not served as a thick sticky spoonful.</li>
        <li>Children should eat seated and supervised; avoid eating while walking, riding or playing.</li>
      </ul>
      <h2>Fish, Eggs & Other Proteins</h2>
      <ul>
        <li>Cook fish and eggs thoroughly and use lower-mercury fish choices.</li>
        <li>For fish, flake carefully and check every portion for bones before serving.</li>
        <li>Keep fish portions age-appropriate; variety matters more than serving the same fish repeatedly.</li>
      </ul>
      <h2>Allergens & Ingredients</h2>
      <ul>
        <li>Introduce common allergens in forms appropriate to the child's development and follow your clinician's advice when there is a known allergy or elevated risk.</li>
        <li>Check labels on fortified foods, breads, spreads and packaged ingredients for allergens and added sodium.</li>
      </ul>
      <h2>Allergic Reaction — What To Do</h2>
      <ul>
        <li>Watch for hives or widespread redness, swelling of the lips, tongue or face, vomiting, wheezing, trouble breathing or swallowing, sudden paleness, or unusual sleepiness — especially when more than one of these appears together.</li>
        <li>If your child has a prescribed epinephrine auto-injector and any of these signs appear, use it right away, note the time, and call 911 immediately after. Don't wait to see if symptoms improve on their own — it's safer to give epinephrine and be wrong than to wait and be wrong.</li>
        <li>If no epinephrine has been prescribed and you see signs like these, call 911.</li>
        <li>For a single mild symptom only — a few hives, mild itching, mild stomach upset — stay with the child, watch closely, and call the child's clinician. If a second symptom appears, or symptoms progress, treat it as above.</li>
        <li>Any suspected reaction is worth a follow-up call to the child's clinician or allergist, even after it resolves on its own.</li>
      </ul>
      <p><em>This is general orientation, not an allergy action plan. Families with a known or suspected food allergy should get a written emergency plan and prescribed epinephrine from their child's clinician or allergist, and keep both wherever the child eats.</em></p>
      <h2>Storage & Reheating</h2>
      <ul>
        <li>Cool, refrigerate and reheat leftovers promptly using safe food-handling practices.</li>
        <li>Reheat foods thoroughly and cool them to a safe eating temperature before serving.</li>
      </ul>
      <h2>When to Call the Pediatrician</h2>
      <p>Consult a clinician promptly — rather than waiting for a routine visit — if you notice:</p>
      <ul>
        <li>Weight loss, or weight crossing two major growth-chart percentile lines</li>
        <li>Persistent gagging, coughing or choking during meals, beyond an occasional isolated moment</li>
        <li>Refusal of an entire food group for more than two weeks</li>
        <li>Blood in the stool</li>
        <li>Hives, swelling or breathing changes after eating (see Allergic Reaction, above)</li>
        <li>Signs of dehydration: notably fewer wet diapers, no tears when crying, dry mouth, or unusual sleepiness</li>
        <li>Ongoing vomiting or diarrhea</li>
        <li>Meals dominated by distress — crying, gagging or panic at most meals over an extended stretch</li>
      </ul>
      <p><em>None of these signs are diagnostic on their own — they're simply worth a clinician's input rather than a wait-and-see approach. Trust your own read of your child alongside this list.</em></p>
      <div class="callout"><strong>Roots rule:</strong> Safety should never be an afterthought. If a recipe's texture, shape or ingredient is not safe for your child's current skills, adapt it before serving.</div>
    `
    },
    {
      id: "fish",
      title: "🐟 Fish, Mercury & Iron Rule",
      category: "guide",
      content: `
      <h1>Fish &amp; Mercury</h1>
      <p>FDA/EPA: two servings per week from lower-mercury Best Choices. About 1 oz ages 1–3, 2 oz ages 4–7. Check current charts and local advisories.</p>
      <p>Examples: salmon, sardines, trout, pollock, haddock, sole, tilapia, shrimp, crab.</p>
      <h2>The Roots Iron Rule</h2>
      <p>Every day, choose one iron anchor. When plant-based, add a vitamin-C food.</p>
      <table>
        <tr><th>Iron anchor</th><th>Vitamin-C partner</th></tr>
        <tr><td>Lentils</td><td>Tomato or citrus</td></tr>
        <tr><td>Chickpeas</td><td>Lemon or mango</td></tr>
        <tr><td>Black beans</td><td>Mango or tomato</td></tr>
        <tr><td>Tofu</td><td>Broccoli or peppers</td></tr>
        <tr><td>Beans</td><td>Berries or citrus</td></tr>
      </table>
      <h2>Vitamin D Sources</h2>
      <p>Daily target: 15 mcg (600 IU). Strongest food sources: fatty fish such as salmon or trout (often 380–570 IU per 3 oz adult portion — even a toddler-sized ~1 oz serving helps), canned sardines with soft bones, egg yolk (~40–45 IU each), and fortified plant milks/yogurts (typically 100–240 IU per cup — check the label, since many organic versions aren't fortified).</p>
      <p>Very few foods naturally contain much vitamin D. Do the arithmetic on an ordinary day and it's easy to see why: a serving of fortified yogurt plus an egg yolk might add up to only about 130 IU — well short of the 600 IU target — and even a fish day rarely closes the whole gap. Many toddlers on any dietary pattern fall short of 600 IU from food alone, particularly with limited sun exposure. This calls for a conversation with the child's pediatrician rather than a fixed number from a book: a clinician-guided supplement is common and often appropriate.</p>
      <h2>Zinc &amp; Phytates</h2>
      <p>Legumes, grains and seeds contain phytate, which binds zinc. <strong>Vitamin C does not rescue zinc.</strong> Soak beans and chickpeas 8–12 hours in cold water before cooking.</p>
      <table>
        <tr><th>Zinc source</th><th>Pair with</th><th>Why</th></tr>
        <tr><td>Lentils, beans, chickpeas</td><td>Soak 8–12 hrs in cold water before cooking</td><td>Cuts phytate significantly</td></tr>
        <tr><td>Tofu</td><td>Egg or fish, same meal</td><td>Animal protein improves absorption</td></tr>
        <tr><td>Oats, quinoa, rice</td><td>Don't rely on grains alone</td><td>Not a major zinc source</td></tr>
      </table>
      <p>On fully plant-based days, repetition of soaked legumes matters more than variety—swapping between unsoaked beans, lentils and chickpeas doesn't fix a phytate problem. A plain cold-water soak, drained and rinsed, is the tool that matters; there's no need for a more elaborate ritual than that.</p>
      <h2>B12 &amp; Iodine</h2>
      <p>Fish and eggs ease B12. If limited, use fortified foods and discuss supplementation. Iodized salt and seafood support iodine—do not increase toddler salt.</p>
      <p>If sea vegetables come up as another iodine idea, they are not interchangeable. Roasted nori is comparatively mild — crumble or tear it into a hot stew rather than serving a whole sheet, which turns slick and sticky in a toddler's mouth and can pose a choking hazard. Kelp and kombu are a different matter: they can carry very large, unpredictable amounts of iodine, more than a young child's thyroid needs, and are best left out of the toddler portion. Check with the child's clinician before using seaweed as a regular iodine source.</p>
    `
    },
    {
      id: "pfas",
      title: "💧 PFAS — Practical Reduction",
      category: "guide",
      content: `
      <h1>PFAS / "Forever Chemicals" — Practical Exposure Reduction</h1>
      <p>PFAS (per- and polyfluoroalkyl substances) are a large family of persistent chemicals found in the environment and in some products. Exposure can occur through contaminated drinking water, certain foods, food packaging, dust and some consumer products. Young children can have additional exposure through frequent hand-to-mouth behavior. Current public-health guidance emphasizes reducing avoidable exposure rather than trying to eliminate every source, which is not currently possible.</p>
      <h2>The Roots Reduction Rule</h2>
      <p>Reduce the exposures that are easiest to control while protecting food variety, affordability and nutritional quality.</p>
      <ul>
        <li><strong>WATER FIRST</strong> — If your community or private well has a PFAS concern, follow local/state guidance. For a private well, testing can identify whether action is needed. Request your water utility's latest Consumer Confidence Report and check it for PFOA/PFOS/total PFAS results. The EPA's drinking-water limit for PFOA and PFOS is 4.0 parts per trillion (ppt) each; in 2026 the EPA proposed keeping that limit while giving utilities the option of a compliance extension to April 2031, with mandatory interim mitigation (such as filtration or an alternate supply) required once a system's sample results reach 12 ppt. When filtration is appropriate, use a system specifically demonstrated or certified to reduce PFAS (look for NSF/ANSI Standard 53 or 58 certification); use the treated water for drinking and food preparation.</li>
        <li><strong>PACKAGING</strong> — Prefer fresh, frozen or minimally packaged foods when practical. Reduce routine reliance on grease-resistant paper food packaging. In the U.S., manufacturers stopped selling PFAS-containing grease-proofing agents into the market in 2024, and FDA determined in a January 2025 Federal Register notice that the related food-contact notifications were no longer effective, with existing stock expected to clear by mid-2025. In the EU, the Packaging and Packaging Waste Regulation (PPWR) began applying PFAS limits to food-contact packaging on August 12, 2026 — 25 ppb for any single PFAS, 250 ppb for the sum of PFAS, and 50 ppm for total PFAS including polymeric forms — most relevant to imported goods, but a useful signal of where packaging standards are heading.</li>
        <li><strong>COOKWARE</strong> — PFAS chemistry is not one single exposure category. FDA distinguishes polymerized nonstick coatings from grease-proofing paper applications and reports negligible migration from authorized polymerized nonstick coatings under intended use. Families who prefer to minimize PFAS can choose PFAS-free cookware (cast iron, stainless steel or ceramic) when replacing worn or damaged pieces; there is no need to discard usable cookware solely from fear.</li>
        <li><strong>FISH</strong> — Do not remove fish from the Roots pattern simply because PFAS exist. Fish provides protein, B12 and omega-3s and remains nutritionally valuable. For locally caught fish, follow current state, tribal or local advisories because contamination can be waterway-specific. Also continue to follow current FDA/EPA mercury guidance.</li>
        <li><strong>HOUSEHOLD DUST & PRODUCTS</strong> — When there is a known PFAS source, practical measures can help: wet-dust or damp-mop rather than dry-sweeping, since this reduces how much settled dust gets stirred back into the air; and wash the child's hands regularly, especially before meals and snacks, given the frequent hand-to-mouth behavior noted above. Exposure from contaminated drinking water is generally a more important concern than exposure from many current consumer products.</li>
      </ul>
      <div class="callout"><strong>What Not to Do:</strong> Do not let PFAS avoidance shrink a toddler's diet so much that iron, calcium, B12, iodine, protein or omega-3 intake suffers. The Roots goal is lower unnecessary exposure—not a chemically "perfect" household. Variety remains protective and nutritionally important.</div>
      <p class="meta"><em>PFAS regulation moves quickly. Check current EPA, FDA, CDC/ATSDR and state/tribal guidance rather than treating any book as a permanent PFAS product list.</em></p>
    `
    },
    {
      id: "screens",
      title: "📱 Screens, Attention & Family Table",
      category: "guide",
      content: `
        <h1>Screens, Attention &amp; The Family Table</h1>
<p>Screens compete with hunger and fullness cues, reduce awareness of the food itself, and weaken the social part of the family table. Keeping them off during meals is one of the simplest, most durable supports for appetite regulation a family can put in place.</p>
        <p>The goal is not to ban screens from a child's life. It is to protect the table specifically, and to build a pattern rather than enforce a rule.</p>
        <h2>The Roots Screen Rule</h2>
        <ul>
        <li><strong>PROTECT THE TABLE</strong> — Keep screens off during meals and seated snacks when possible. Short, screen-free meals make it easier for a child to notice what they are eating and when they are full.</li>
        <li><strong>PHONES COUNT TOO</strong> — Adult phones at the table pull attention away just as effectively as a child's tablet. Children learn mealtime habits primarily by watching the adults around them.</li>
        <li><strong>BUILD IT AS A PATTERN</strong> — Aim for a dependable rhythm, not perfection. A sick day, a long travel day or a hard parenting moment does not undo a consistent pattern.</li>
        <li><strong>DO NOT WEAPONIZE IT</strong> — Avoid using screens as a reward for eating, a punishment for not eating, or a distraction to get more bites in. Each of these ties screens to food in ways that work against hunger-led eating.</li>
        </ul>
        <div class="callout"><strong>What Not to Do:</strong> Do not turn screen-free meals into a source of household conflict or comparison with other families. A calm, unhurried meal with a screen on occasionally is better than a tense, adversarial one without.</div>
        <p class="meta"><em>This book's scope is the table. For broader screen guidance by age—sleep, bedrooms, content quality and family media planning—see the appendix, and consult current AAP guidance at HealthyChildren.org, which is revised as evidence develops.</em></p>
      `
    },
    {
      id: "sweetness",
      title: "🍯 Sweetness, Sugars & Drinks",
      category: "guide",
      content: `
      <h1>Sweetness, Sugars &amp; Drinks</h1>
      <p>Sugar shows up under many names—glucose, fructose, lactose, sucrose, dextrose, corn syrup, cane sugar, syrups, molasses and honey are all forms of sugar. For a toddler, what matters is not the chemical name but whether the sugar occurs naturally in a whole food or is added during processing or at the table.</p>
      <h2>The Roots Sweetness Rule</h2>
      <p>Offer sweetness mostly through whole fruit; use unsweetened staples; treat added sugars as occasional rather than routine.</p>
      <p>For children under 2, avoid added sugars. From age 2 onward, keep them occasional rather than routine.</p>
      <p>One natural experiment followed children conceived around the end of Britain's postwar sugar rationing in 1953. Limited sugar exposure in the first 1,000 days was associated with lower rates of type 2 diabetes and high blood pressure in adulthood (Gracner et al., <em>Science</em>, 2024).</p>
      <ul>
        <li><strong>WHOLE FRUIT</strong> — Whole fruit carries natural fructose alongside fiber, vitamins and water, and is not treated the same as added sugar. Favor whole fruit over fruit juice.</li>
        <li><strong>DAIRY-FREE STAPLES</strong> — Dairy milk and yogurt naturally contain lactose. Plant milks and yogurts generally do not, but their total and added sugars vary by product. Choose unsweetened, fortified plant milks and yogurts, and check labels — "fortified" and "unsweetened" do not always come together.</li>
        <li><strong>NAME IT TO SPOT IT</strong> — Table sugar, cane sugar, glucose, fructose, dextrose, corn syrup/high-fructose corn syrup, syrups, molasses and honey all count as added sugar once they are added to a food or drink. Check the Added Sugars line on the Nutrition Facts label first, then scan the ingredient list for these alternate names.</li>
        <li><strong>HONEY</strong> — Never before 12 months: honey can carry <em>Clostridium botulinum</em> spores and cause infant botulism in babies under 1. After 12 months honey is safe from a botulism standpoint, but it is still an added sugar — use it the same way as any other added sugar, occasionally rather than routinely.</li>
        <li><strong>JUICE</strong> — No juice before 12 months. For ages 1–3, if juice is offered, limit 100% fruit juice to 4 oz (½ cup) a day and favor whole fruit instead. Fruit drinks, fruit-flavored drinks and "juice drinks" are not the same as 100% juice and are not a substitute.</li>
        <li><strong>EVERYDAY DEFAULTS</strong> — Treat sweetened drinks, sweetened yogurts, and dessert-style snacks as occasional rather than routine. Avoid low- and no-calorie sweeteners for infants and young children; they are not a nutritional substitute for unsweetened foods and drinks.</li>
      </ul>
      <div class="callout"><strong>What Not to Do:</strong> Do not chase a "zero sugar" household—whole fruit, starchy vegetables and unsweetened dairy-free staples already carry natural sugars, and that is not the target. The goal is keeping <em>added</em> sugar occasional and routing everyday sweetness through whole food.</div>
    `
    },
    {
      id: "processed-foods",
      title: "📦 Processed Foods, Snacks & Celebrations",
      category: "guide",
      content: `
      <h1>Processed Foods, Snacks &amp; Celebrations</h1>
      <p>This chapter is not a purity test. It's a practical way to think about packaged food, the snack drawer, dessert, and the days—birthdays most of all—when the Roots pattern should step aside on purpose.</p>
      <h2>Ultra-Processed Foods, Without the Panic</h2>
      <p>"Ultra-processed" is a real category (the NOVA classification system groups foods by degree and purpose of processing, not by a single ingredient), but it is not a reason to panic over every package in the pantry. The more useful question for a family table isn't "is this ultra-processed?"—plenty of ultra-processed foods, like fortified plant milk or whole-grain bread, still do real nutritional jobs—it's "what job is this food actually doing, and what is it crowding out?"</p>
      <p>Foods engineered for palatability (a precise mix of sugar, salt, fat and texture designed to be very easy to keep eating) can crowd out the Anchor, Energy, Color, Fat and Cover jobs this book builds meals around—not because they are "toxic," but because a small stomach that fills up on them has less room left for the foods that actually cover those jobs. That's the practical concern, not a moral one.</p>
      <h2>The Roots UPF Take</h2>
      <p>Judge packaged food by what it displaces, not by a label. A packaged food that still does a real nutritional job (fortified yogurt, whole-grain crackers, canned beans) is a tool, not a compromise. A packaged food that mainly displaces other foods without doing a job of its own is the one to make occasional.</p>
      <h2>The Snack-Drawer Problem</h2>
      <p>A toddler can't eat the cookies if the cookies aren't in the house. Most snack-time struggles are framed as a willpower problem—the child's, or the parent's, in the moment of saying no—when they are usually a household-default problem instead: whatever lives at kid-height in the pantry is what gets asked for and offered on tired days.</p>
      <ul>
        <li>Stock the snack drawer or shelf with foods you're comfortable saying yes to on autopilot, so "yes" doesn't require a decision every time.</li>
        <li>Keep occasional foods in the house if your family wants them, but out of default reach—a high shelf or a less-visited cabinet, not the eye-level snack bin.</li>
        <li>Let treats be genuinely occasional by keeping them genuinely less available, not by relying on a "no" you have to enforce every single day.</li>
      </ul>
      <h2>Real-Food Snacks, Fast</h2>
      <p>These lean on the same anchors, energy foods and fats already in the Roots pattern—no separate "snack aisle" required:</p>
      <ul>
        <li>Hummus or a soft-bean spread with pita, soft vegetable sticks or crackers.</li>
        <li>Thin seed or nut butter on soft toast (see the Snacks recipes for exact technique—never a thick sticky spoonful).</li>
        <li>Mashed or sliced avocado on toast, or with a spoon straight from the shell.</li>
        <li>Fortified unsweetened dairy-free yogurt with soft fruit.</li>
        <li>Leftover Roots Bowl or Roots Spread components, offered cold or gently rewarmed.</li>
      </ul>
      <h2>Dessert Psychology</h2>
      <p>How dessert is served changes what a child learns from it more than whether dessert is served at all. Serving a small dessert alongside the meal—on the plate, at the same time as everything else—treats it as one more food at the table. Holding it back as a reward for finishing vegetables, or withholding it as a consequence for not eating enough, teaches a different lesson: that the vegetables are the price of admission and the dessert is the food that actually matters. That framing tends to backfire, making the withheld food more desirable and the required food less appealing.</p>
      <p>Small, ordinary desserts—fruit-based, or a modest portion of something sweeter—served with the meal rather than dangled after it, fit the same division-of-responsibility approach used throughout this book: the caregiver decides what's offered, including dessert; the child decides how much of the whole meal to eat.</p>
      <h2>Birthdays &amp; Celebrations</h2>
      <p>Let go of the rules on birthdays and other celebrations, on purpose and without hovering. A toddler eating real birthday cake at a birthday party is not a Roots failure to manage—it's one meal, a handful of times a year, inside a pattern that holds steady the rest of the time. There's no need to swap in a "healthy" cake, ration the slice, or supervise the plate more closely than any other child's at the party.</p>
      <p>The Roots pattern is built to be dependable across a week and a season, not flawless on any single day. A pattern strong enough to need defending at a birthday party isn't actually working the way this book intends.</p>
      <p>That said, a family that wants a Roots-pattern cake for its own sake — for a home celebration, a first birthday smash cake, or simply because it's the dessert the family prefers — isn't contradicting the point above. The Celebration Smash Cake recipe in this book (Recipe 32, among the Snacks) exists for that reason: as one more option a family can reach for when they want it, alongside real birthday cake at a party, not as a "healthier" substitute that has to replace it.</p>
      <div class="callout"><strong>What Not to Do:</strong> Don't let "occasional" quietly become "constant" by keeping treat foods in default reach every day, and don't let "special occasion" quietly shrink to nothing by treating every birthday, holiday or celebration as another day to police. Both directions undercut the same goal: a pattern that's dependable most days and genuinely relaxed on the days that call for it.</div>
    `
    },
    {
      id: "quick-check",
      title: "✅ Quick Roots Recipe Check",
      category: "guide",
      isQuickStart: true,
      icon: "✅",
      description: "Best practices checklist",
      content: `
      <h1>Quick Roots Recipe Check</h1>
      <ul class="quick-check">
        <li>Soak non-red legumes 8–12 hours → drain/rinse → cook until mashable.</li>
        <li>Use vitamin-C foods to support plant-iron absorption; do not count them as a zinc strategy.</li>
        <li>Pair plant-forward days with deliberate zinc anchors such as legumes and tofu.</li>
        <li>Advance textures as skills develop; use purées as a temporary bridge when useful.</li>
        <li>Remove toddler portions before salting or adding hot family seasoning.</li>
        <li>Cool, refrigerate promptly, or freeze in small portions; reheat thoroughly once.</li>
        <li>Check allergens, fish bones and choking-sensitive shapes every time.</li>
      </ul>
    `
    },
    {
      id: "foodways",
      title: "🌍 Foodways",
      category: "guide",
      isQuickStart: true,
      icon: "🌍",
      description: "Global culinary influences",
      content: `
      <h1>Foodways</h1>
      <p>Global foodways are part of the food itself, not decoration. The recipes use pantry, ingredient, and flavor influences from African, Caribbean, Latin American, Mediterranean, South Asian, East Asian, and Indigenous North American traditions. <strong>Foodway influence is not the same thing as culinary authenticity.</strong> These notes explain the pantry logic behind recipe labels so families can cook with context—and adapt toward their own traditions when those take priority.</p>

      <h2>How to Read a Foodway Label</h2>
      <p>Each core recipe carries a short foodway line (for example, "Caribbean pantry-inspired" or "Mediterranean pantry-inspired"). That line means:</p>
      <ul>
        <li>The <strong>ingredients or flavor path</strong> draw from foods commonly used in that region's home cooking.</li>
        <li>The method is simplified for a shared family table and toddler texture safety.</li>
        <li>It is a <strong>starting point for pattern-building</strong>, not a claim to represent a specific Nation, country, or household's cuisine.</li>
      </ul>
      <p>When your family already cooks from a tradition, keep that center. Use this book's structure (anchor · energy · color · fat · cover) around the foods you already know.</p>

      <h2>First Nations & Indigenous Foodways</h2>
      <p>Indigenous North America is not one cuisine. Nations differ in territory, foods, harvesting practices, teachings, and traditions. The <strong>Three Sisters</strong> reference (corn, beans, and squash grown and eaten in relationship) is a broad foodway-inspired framework, not a substitute for Nation-specific knowledge.</p>
      <p>A Roots approach emphasizes land, season, locality, relationship, and respect. When a family has a connection to a particular Nation or community, local knowledge keepers and Nation-specific resources should take precedence over any general book.</p>
      <p><strong>Pantry ideas that appear in this book:</strong> corn, beans, squash, wild rice (when safely textured), berries, fish, and other locally specific foods. Recipe 17 (Three Sisters-style bowl) is written as a soft, toddler-safe mash of beans, corn, and squash—not as a ceremonial or Nation-specific dish.</p>
      <p><strong>Why this belongs here.</strong> Health Canada notes that traditional foods can improve diet quality among Indigenous Peoples and that traditional food is linked to culture, identity, way of life and health. Examples across Canada include fish, shellfish, berries, corn, squash, beans, wild rice and other wild plants. This edition's land-based-meat-free choice means traditional game sits outside its scope by the book's own dietary pattern—not by any judgment about the food itself; fish, berries and the Three Sisters remain natural points of connection within that pattern.</p>
      <p><strong>Harvested foods — safety is part of the tradition, not a footnote.</strong> Health Canada's food-safety guidance for First Nations emphasizes safe handling of harvested foods: cooling and storing promptly, cooking fish thoroughly, and avoiding berries or plants gathered near roads, construction sites or railways. For young children this matters especially with locally harvested fish—contaminants and pathogens are regional questions, not abstract ones. Check the current local advisory before serving frequently harvested fish, in addition to the general mercury guidance elsewhere in this book.</p>

      <div class="callout">
        <strong>A second meal idea: Salmon, Squash & Berry Plate</strong><br>
        <em>Inspired by • Pacific Northwest / broader Indigenous foodways</em><br><br>
        Ingredients: 1–2 oz fully cooked salmon; ¼–½ cup soft winter squash; 1–2 Tbsp mashed berries such as blueberry or raspberry.<br><br>
        Method: Cook and thoroughly flake salmon, checking carefully by hand for bones. Steam squash until soft and mash. Mash berries (or quarter lengthwise if they approach whole-grape size) and combine or serve alongside.<br><br>
        Toddler safety: Flake fish finely and bone-check every piece; mash squash and berries to the child's current texture skill.<br><br>
        Family table: Add lemon, herbs or a family sauce to the adult portion after removing the toddler serving.
      </div>
      <p>This is offered alongside Recipe 17 as a second, fish-based entry point into the same foodway—not a complete or definitive one. Do not substitute a generic "Native" label for local knowledge. If a family is connected to a particular Nation, that Nation's own food teachings, ingredients and names take precedence over anything in this book.</p>
      <p><strong>The respectful rule.</strong> Use Indigenous foods because they are good food—not as decorative "exotic" ingredients. Name a specific Nation or region when the foodway is specific; otherwise say "Indigenous foodways" rather than implying that one recipe represents all First Nations.</p>

      <h2>Regional Pantry Notes</h2>
      <p>These sketches show how regional pantries map onto the Roots pattern. They are orientation tools, not exhaustive lists.</p>
      <p><strong>Caribbean</strong> — Plantain, beans, pumpkin or squash, avocado, mango, greens, and fish. Soft plantain with egg and avocado (Recipe 02) and fish with pumpkin (Recipe 19) use this pantry logic: starchy fruit or squash for energy, beans or fish as anchor, avocado for fat, tropical fruit for color and vitamin C.</p>
      <p>Within Caribbean foodways, <strong>Ital cooking</strong>—the dietary practice rooted in Rastafari belief—offers a specific, naturally aligned model for this book's plant-forward pattern: whole, minimally processed plant foods and little to no added salt, with stricter forms avoiding animal foods (including fish) entirely. Recipe 08 (Black Bean, Rice & Pumpkin Bowl) is written salt-free and fully plant-based as it stands, so it sits comfortably within an Ital framework without changes. This book labels it "Caribbean pantry-inspired" rather than "Ital" outright, because Ital is a spiritual and cultural practice with its own standards, not a flavor profile a cookbook can borrow wholesale—but families who keep Ital should find the technique a natural fit, and can simply omit any pinch of salt from the toddler portion to match their own practice.</p>
      <p><strong>West and other African foodways</strong> — Legumes, greens, sweet potato, grains (including millet), peanut- or seed-based sauces, and vegetable stews. Millet-banana porridge (Recipe 04) and lentil- or peanut-adjacent stews reflect grain-and-legume foundations. Keep peanut as thin seed/nut butter only when already safely introduced; never thick globs.</p>
      <p><strong>Latin American</strong> — Beans, corn, avocado, squash, rice, plantain, and tomato. Black bean and rice bowls, avocado as everyday fat, and tomato as a vitamin-C partner for plant iron all sit comfortably in the Roots architecture.</p>
      <p><strong>Mediterranean / Levantine</strong> — Chickpeas, lentils, olive oil, tomatoes, greens, herbs, tahini, and fish. Hummus, chickpea patties, lemon as a vitamin-C partner, and olive oil off heat are repeated moves. Tahini is used thin—for calcium contribution and fat—not as a primary calcium strategy.</p>
      <p><strong>South Asian</strong> — Lentil dishes (dal), chickpeas, greens, sweet potato, cumin, turmeric, and ginger. Red lentil dal with rice is a classic Roots stew pattern: soft legume anchor, grain energy, mild spice, oil for density. Spice stays mild in the toddler portion; season the family share after dividing.</p>
      <p><strong>East Asian</strong> — Tofu, rice, fish, vegetables, sesame, and ginger. Soft tofu bowls, rice as energy, sesame (tahini or thin sesame butter) for fat, and ginger used lightly. Calcium-set tofu is a strong calcium anchor when soy is included; when soy is avoided, shift to the soy-free calcium path.</p>
      <p><strong>Indigenous North American</strong> — Corn, beans, squash, wild rice, berries, fish, and foods specific to place. Prioritize local and seasonal choices when you have them. Nation-specific traditions vary widely; this book does not replace them.</p>

      <h2>Practical Use at the Family Table</h2>
      <ul>
        <li>Pick one foodway lane for a week if you like a theme, or mix freely—the nutritional architecture matters more than geographic purity.</li>
        <li>Let recipe labels teach pantry patterns (beans + squash, lentils + rice, fish + greens) rather than lock you into a "cuisine night."</li>
        <li>Swap toward foods your family already buys and values; the formulas still hold.</li>
        <li>Teach children that many places nourish people with legumes, grains, vegetables, fish, and shared pots—the same jobs, different pantries.</li>
      </ul>

      <h2>Respect Line</h2>
      <p>Influence is invitation, not ownership. Where this book is thin, community cooks, family elders, and Nation-specific resources are the deeper teachers. The Roots goal is a workable global-inspired family table that stays humble about what it does not know.</p>
    `
    },
    {
      id: "sustainable",
      title: "♻️ Making It Sustainable",
      category: "guide",
      content: `
      <h1>Making It Sustainable</h1>
      <p>Treat Roots as a flexible pattern, not rigid rules—especially with more than one young child.</p>
      <ul>
        <li>Use high-quality low-sodium canned beans and pre-cooked frozen grains as valid shortcuts.</li>
        <li>Double or triple Three-Grain Batch and Master Lentils &amp; Beans weekly.</li>
        <li>Offer a simple "safe side" (extra avocado, fruit, soft toast) for picky older kids.</li>
        <li>Use Emergency and No-Cook meals proactively on known hard days.</li>
      </ul>
      <p><strong>If You Only Do Three Things This Week</strong></p>
      <p>For a week where full batch-cooking isn't realistic, these three habits carry most of the nutritional weight for the least effort:</p>
      <ol>
        <li>Keep one iron anchor + vitamin-C partner going daily, even from convenience staples like canned lentils and canned tomatoes — this is the single highest-leverage habit in the whole pattern (see The Roots Iron Rule).</li>
        <li>Keep a fortified plant milk or yogurt in the house for the Cover nutrients — calcium, vitamin D, B12, iodine. Almost everything else in this pattern can flex around a hard week; this one is worth protecting.</li>
        <li>Lean on the Emergency &amp; No-Cook Meals chapter without guilt. It's built to hold the pattern together on exactly this kind of week, not only for genuine emergencies.</li>
      </ol>
      <p>This isn't a replacement for the full pattern—it's the floor to stand on until a fuller week is possible again.</p>
    `
    },
    {
      id: "grow",
      title: "🪴 Grow with the Table",
      category: "guide",
      content: `
      <h1>Grow with the Table</h1>
      <h2>Texture Ladder — Growing With the Table</h2>
      <p>Advance texture as skills and confidence grow. Match the step to the child, not the calendar.</p>
      <table>
        <tr><th>Stage</th><th>What it looks like</th><th>Typical focus</th></tr>
        <tr><td><strong>1 · Smooth / finely mashed</strong></td><td>Soft, even texture; little to no lumps</td><td>Early practice, illness, or temporary preference</td></tr>
        <tr><td><strong>2 · Soft mashed with small soft pieces</strong></td><td>Fork-mashed foods with soft bits the child can manage</td><td>Building tolerance for mixed texture</td></tr>
        <tr><td><strong>3 · Soft finger foods &amp; easy chewables</strong></td><td>Soft strips, small soft pieces, easy-to-gum foods</td><td>Self-feeding practice; family foods softened</td></tr>
        <tr><td><strong>4 · Family textures, adapted</strong></td><td>Same meal as the table, with safer shapes and moisture as needed</td><td>Full participation in the family meal</td></tr>
      </table>
      <div class="callout"><strong>Move forward when:</strong> the child handles the current stage without distress, chews and swallows safely, and shows interest in more textured food.<br><strong>Step back temporarily when:</strong> teething, illness, fatigue, or stress makes harder textures overwhelming — then return to progression.<br><br>Purées remain a tool, not the permanent default. Supervision, safe shapes, and bone-checking for fish stay in place at every stage.</div>
      <table>
        <tr><th>Age</th><th>Roots approach</th></tr>
        <tr><td><strong>1–3</strong></td><td>Same family food; softer textures, safer shapes, smaller portions, less sodium, close supervision.</td></tr>
        <tr><td><strong>4–6</strong></td><td>Same family food; larger portions, broader textures, more participation.</td></tr>
        <tr><td><strong>7+</strong></td><td>Same family meal; hunger-led portions; increasing independence with serving and prep.</td></tr>
      </table>
    `
    },
    {
      id: "family-notes",
      title: "📝 Family Table Notes",
      category: "guide",
      content: `
      <h1>Family Table Notes</h1>
      <p><strong>Soy choice:</strong> regular / occasional / soy-free</p>
      <p><strong>Preferred fortified beverage/yogurt:</strong> ______________________________</p>
      <p><strong>Foods/allergens to avoid:</strong> ______________________________________</p>
      <p><strong>Traditional/local foods to include:</strong> ____________________________</p>
      <p><strong>Favorite family foods to adapt:</strong> ______________________________</p>
      <p><strong>Foods we are introducing:</strong> ____________________________________</p>
      <p><strong>Foods our children love:</strong> _____________________________________</p>
      <p><strong>Foods we are still working on:</strong> _______________________________</p>
    `
    },
    {
      id: "screens-appendix",
      title: "📎 Appendix: Screens Beyond the Table",
      category: "guide",
      content: `
        <h1>Appendix: Screens Beyond the Table</h1>
        <p>The Roots Screen Rule covers mealtimes only. This appendix summarizes broader pediatric screen guidance for families who want it in one place. It is reference material, not part of the book's feeding framework, and it is the section most likely to age: current AAP guidance at HealthyChildren.org should take precedence over anything printed here.</p>
        <p>Pediatric guidance has moved away from counting minutes toward examining content, context and the individual child. As of the AAP's 2026 policy update ("Digital Ecosystems, Children, and Adolescents"), the current framing is built around five considerations—<strong>Child, Content, Calm, Crowding Out and Communication</strong>—rather than a single hourly cap. Quality, co-viewing and balance matter more than a number.</p>
        <h2>Quick Age-Based Reference</h2>
        <div class="table-wrap"><table>
        <tr><th>Age</th><th>Core Guidance</th></tr>
        <tr><td><strong>Under 18 months</strong></td><td>Digital media isn't necessary at this age — infants don't learn from it the way older children do — but occasionally viewing brief, high-quality video (a family video chat, or a short, well-made program) is not considered harmful.</td></tr>
        <tr><td><strong>18&ndash;24 months</strong></td><td>If introduced, use very limited high-quality content, and watch together rather than handing over a device.</td></tr>
        <tr><td><strong>2&ndash;5 years</strong></td><td>Typically under an hour a day of high-quality, ad-free programming, ideally co-viewed. Treat this as a soft anchor rather than a hard cap.</td></tr>
        <tr><td><strong>6 years and older</strong></td><td>Consistent, family-agreed limits rather than a universal number. Prioritize sleep, physical activity and in-person interaction.</td></tr>
        </table></div>
        <p class="meta"><em>Across all ages, what matters most is what children watch, where, with whom, and whether screen use crowds out sleep, play and connection.</em></p>
        <h2>Beyond the Table</h2>
        <ul>
        <li><strong>PROTECT SLEEP</strong> — Keep screens out of the bedroom and off for at least an hour before bed. Screen light and content can interfere with sleep onset and quality, which in turn affects eating, behavior and growth.</li>
        <li><strong>PRIORITIZE QUALITY AND CO-VIEWING</strong> — Choose slow-paced, ad-free content. Watching alongside a child, narrating and asking questions turns passive viewing into shared, language-rich time.</li>
        <li><strong>CHOOSE AD-FREE CONTENT</strong> — Marketing aimed at young children increases desire for less nutritious foods and fragments attention.</li>
        <li><strong>PREFER INTERACTIVE OVER PASSIVE</strong> — Programs that invite singing, repeating or moving are more useful than pure entertainment.</li>
        <li><strong>MAKE TRANSITIONS PREDICTABLE</strong> — For older toddlers and preschoolers, a visual timer can make turning screens off less of a negotiation.</li>
        <li><strong>MAKE A FAMILY PLAN</strong> — A predictable, agreed-upon pattern works better than reactive rule-making. Adjust it as children grow.</li>
        </ul>
        <div class="callout"><strong>What Not to Do:</strong> Do not use screens as a pacifier, reward or punishment; this trains children to see them as emotionally charged rather than neutral. Do not treat screen guidance as a competition with other families.</div>
      `
    },
    {
      id: "glossary",
      title: "📖 Glossary",
      category: "guide",
      content: `
        <h1>Glossary</h1>
        <p>You'll see a handful of recurring terms throughout this book—some nutrition science, some Roots-specific vocabulary, some regulatory shorthand. None of them require a background in nutrition to use this book well, but this glossary is here if a term ever needs a quick refresher.</p>

                <p><strong>AAP</strong><br>
        The American Academy of Pediatrics, the U.S. pediatric medical organization whose guidance this book draws on for feeding, safety and screen recommendations.</p>
        <p><strong>ALA (alpha-linolenic acid)</strong><br>
        A plant-based omega-3 fat found in foods such as chia and flax. The body can convert some ALA into DHA and EPA, but the conversion is limited. ALA is valuable, but it is not the same as the DHA and EPA found directly in fatty fish.</p>
        <p><strong>Anchor</strong><br>
        The protein and/or iron-rich foundation of a Roots meal. Anchors include fish, eggs, lentils, beans, chickpeas and tofu.</p>
        <p><strong>B12 (vitamin B12)</strong><br>
        A nutrient important for neurological development and healthy blood cells. In the Roots pattern, reliable sources include fish, eggs and fortified foods. Families limiting animal foods need to plan B12 deliberately.</p>
        <p><strong>Bioengineered food / GMO</strong><br>
        A food or crop whose genetic material has been modified using technology that could not otherwise be achieved through conventional breeding or found in nature. "Bioengineered" is the term used in current USDA food-labeling regulation; "GMO" is the more common everyday term for the same thing.</p>
        <p><strong>Best Choices</strong><br>
        The FDA/EPA category for fish and seafood that are generally lower in mercury and appropriate choices for regular consumption. Examples commonly used in this book include salmon, sardines, trout, pollock, haddock, sole, tilapia, shrimp and crab. Current FDA/EPA guidance should always take precedence over a static list.</p>
        <p><strong>Calcium anchor</strong><br>
        A food that makes a meaningful, reliable contribution toward calcium needs. Examples include calcium-fortified soy beverages or yogurts, calcium-set tofu, and certain fish eaten with soft edible bones. Greens, tahini and beans contribute calcium but should not be assumed to carry the full requirement alone.</p>
        <p><strong>Calcium-set tofu</strong><br>
        Tofu made using a calcium salt as the coagulant. Because calcium content varies significantly by product, check the nutrition label rather than assuming all tofu is a strong calcium source.</p>
        <p><strong>Choking-sensitive shape</strong><br>
        A food shape or texture that requires modification for young children. Examples include whole nuts, whole grapes, hard raw vegetables, popcorn, whole round berries and thick globs of nut or seed butter.</p>
        <p><strong>Choline</strong><br>
        An essential nutrient that supports brain and nervous-system development. Eggs and fish are particularly useful sources within the Roots pattern.</p>
        <p><strong>Co-viewing</strong><br>
        Watching a screen together with a child rather than handing over a device to use alone. Narrating, asking questions and connecting what is on screen to real life turns passive watching into shared, language-rich time.</p>
        <p><strong>Color</strong><br>
        The Roots meal component that refers to fruits and vegetables. “Color” is shorthand for variety, fiber and the broad range of vitamins and plant compounds that come from produce.</p>
        <p><strong>Cover</strong><br>
        Nutrients that may require deliberate planning because they are not automatically supplied by every meal. In Roots, the primary “cover” nutrients are calcium, vitamin D, B12 and iodine.</p>
        <p><strong>DHA and EPA</strong><br>
        Long-chain omega-3 fats found primarily in fatty fish and seafood. DHA is especially important during periods of brain and nervous-system development. Unlike ALA from chia and flax, DHA and EPA are supplied directly by fish.</p>
        <p><strong>Division of responsibility</strong><br>
        A responsive-feeding framework in which the caregiver decides what, when and where food is offered, while the child decides whether and how much to eat.</p>
        <p><strong>Energy</strong><br>
        The grain, starch or root component of the Roots meal architecture. Examples include rice, oats, quinoa, potato, sweet potato, plantain and pasta.</p>
        <p><strong>Energy density</strong><br>
        The amount of energy (calories) contained in a given amount of food. Because toddlers often eat small volumes, adding foods such as avocado, olive oil, tahini, nut or seed butter, and fatty fish can help make modest portions more substantial.</p>
        <p><strong>Fat</strong><br>
        The Roots meal component that supports energy density and provides essential fats. Common Roots fats include avocado, olive oil, tahini, nut and seed butters, and fatty fish.</p>
        <p><strong>FDA/EPA (fish guidance)</strong><br>
        The U.S. Food and Drug Administration and Environmental Protection Agency jointly publish fish and mercury guidance, including the Best Choices list this book references. Current FDA/EPA guidance should always take precedence over a static book list. This EPA is the federal agency, not the omega-3 fat described under DHA and EPA.</p>
        <p><strong>Fish &amp; plant-forward</strong><br>
        A dietary pattern centered primarily on plant foods while using fish and seafood as important animal-food sources. In Roots, eggs may also play a supporting nutritional role.</p>
        <p><strong>Foodway</strong><br>
        The relationship between food, culture, place, history, ingredients, preparation and community. A foodway is broader than a recipe or cuisine. In this book, “foodway-inspired” signals influence and context rather than a claim of culinary authenticity.</p>
        <p><strong>Fortified food</strong><br>
        A food with nutrients added during production. Fortified plant beverages and yogurts may provide calcium, vitamin D and B12, but amounts vary by brand. Always check the label.</p>
        <p><strong>Hunger-led portions</strong><br>
        Serving based on a child's own appetite cues rather than a fixed amount the child is expected to finish. Portions in this book are starting points, not targets.</p>
        <p><strong>Iodine</strong><br>
        A nutrient essential for thyroid function and development. Seafood and iodized salt can contribute iodine. Specialty salts are not automatically iodized.</p>
        <p><strong>Iron anchor</strong><br>
        A food deliberately included to support iron intake. In Roots, common iron anchors include lentils, beans, chickpeas, tofu, eggs and fish.</p>
        <p><strong>Ital</strong><br>
        A dietary practice rooted in Rastafari belief that emphasizes natural, minimally processed foods and, in many forms, little or no added salt. Practices vary among individuals and communities. In Roots, Ital is discussed as a living spiritual and cultural food tradition—not as a generic flavor category.</p>
        <p><strong>Land-meat-free</strong><br>
        A family food-pattern choice that excludes beef, pork and poultry. In Roots, protein and key nutrients are instead built through fish, eggs, legumes, tofu and fortified foods where needed.</p>
        <p><strong>Lower-mercury fish</strong><br>
        Fish that generally contain lower levels of mercury and are more suitable for regular inclusion in children's diets. Species matters more than whether fish is wild-caught or farmed.</p>
        <p><strong>MyPlate</strong><br>
        The USDA's current dietary guidance framework, referenced here for its recognition of calcium-fortified soy beverages and yogurts as dairy-group equivalents for young children.</p>
        <p><strong>Nutritional architecture</strong><br>
        The central Roots framework for building meals around nutritional jobs rather than trying to make one “perfect” food do everything. The five jobs are: Anchor · Energy · Color · Fat · Cover.</p>
        <p><strong>Omega-3</strong><br>
        A family of essential fats. In Roots, plant foods such as chia and flax provide ALA, while fatty fish provide DHA and EPA directly.</p>
        <p><strong>Oxalate</strong><br>
        A naturally occurring compound found in high amounts in spinach, rhubarb, Swiss chard and beet greens. Oxalate binds calcium and reduces its absorption, so these greens should not be relied on as calcium anchors.</p>
        <p><strong>PFAS</strong><br>
        Per- and polyfluoroalkyl substances—a large family of persistent chemicals found in the environment and some consumer products. The Roots approach focuses on reducing practical, avoidable exposure without unnecessarily restricting nutritious foods.</p>
        <p><strong>Phytate</strong><br>
        A naturally occurring compound found in legumes, grains, nuts and seeds that can reduce absorption of minerals such as zinc and iron. Soaking, rinsing, cooking and, where culturally appropriate, fermentation can help reduce phytate.</p>
        <p><strong>Plant-forward</strong><br>
        A pattern in which plant foods form the foundation of most meals without requiring that every meal or every day be entirely plant-based.</p>
        <p><strong>Purée</strong><br>
        Food blended or mashed into a smooth consistency. In Roots, purées are a useful temporary tool during illness, teething or texture difficulty—not the default destination for a toddler who is able to progress toward soft table foods.</p>
        <p><strong>RDA (Recommended Dietary Allowance)</strong><br>
        The average daily intake level considered sufficient to meet the nutrient requirements of nearly all healthy people in a given life stage and sex group.</p>
        <p><strong>Responsive feeding</strong><br>
        A feeding approach that respects both the caregiver's role in providing food and the child's role in responding to hunger and fullness. It emphasizes structure without pressure.</p>
        <p><strong>Roots Bowl</strong><br>
        One of the book's master formulas: an anchor + grain or root + vegetables + fat, with a vitamin-C partner when the anchor is plant-based.</p>
        <p><strong>Roots Formula</strong><br>
        A flexible meal-building pattern that allows ingredients to change while the nutritional structure stays intact. The formulas are designed to reduce the need for rigid meal planning.</p>
        <p><strong>Roots Stew</strong><br>
        One of the book's master formulas: a legume or fish anchor + soft vegetable + tomato or squash base + grain or root + oil.</p>
        <p><strong>Soy-optional</strong><br>
        A pattern in which soy foods are available as useful nutritional tools but are not required. Calcium-set tofu and fortified soy foods can be particularly helpful; soy-free paths require more deliberate planning for calcium, protein, vitamin D and B12.</p>
        <p><strong>Texture ladder</strong><br>
        The gradual progression from smoother foods toward increasingly varied, chewable family textures. Progress should follow the child's skills and confidence rather than a rigid calendar.</p>
        <p><strong>Three Sisters</strong><br>
        A broad Indigenous North American food system in which corn, beans and squash are grown together in a mutually supportive relationship. The Three Sisters-Style Bowl in this book is a soft, toddler-safe mash inspired by that tradition rather than a ceremonial or Nation-specific dish.</p>
        <p><strong>Ultra-processed food (UPF)</strong><br>
        A food classified under the NOVA system as industrially formulated mainly from substances extracted or refined from foods plus additives, often engineered for palatability. The category is broad and includes some foods that still do a useful nutritional job (such as fortified plant milk); the Roots approach judges a packaged food by what it displaces from the diet rather than by the NOVA label alone.</p>
        <p><strong>Vitamin D</strong><br>
        A nutrient essential for calcium absorption and bone development. Few foods naturally contain large amounts, making fortified foods and clinician-guided supplementation important considerations for many dairy-free toddlers.</p>
        <p><strong>Vitamin-C partner</strong><br>
        A vitamin-C-rich food served alongside plant sources of iron to support iron absorption. Examples include tomato, citrus, mango, berries, broccoli and bell pepper.</p>
        <p><strong>Zinc anchor</strong><br>
        A food deliberately used to support zinc intake. In Roots, legumes, tofu, fish, eggs and finely ground pumpkin seeds are useful contributors. On heavily plant-based patterns, preparation and repetition matter because phytate can reduce zinc absorption. Zinc is often confused with iron because both appear in similar foods, but the absorption strategies differ: a vitamin-C partner helps iron absorption, not zinc.</p>
      `
    },
    {
      id: "references",
      title: "📚 References & Roots Standard",
      category: "guide",
      content: `
      <h1>References &amp; Evidence Notes</h1>
      <ul>
        <li>USDA MyPlate — toddler food-group and meal-pattern guidance, including fortified soy beverage/yogurt as a relevant plant-based dairy-group alternative for ages 12–23 months.</li>
        <li>FDA/EPA — Advice About Eating Fish for Children Ages 1–11 Years; Best Choices, serving guidance and recreational-fish advisories.</li>
        <li>NIH Office of Dietary Supplements — reference information for iron, calcium, vitamin D, vitamin B12, zinc, iodine and choline.</li>
        <li>American Academy of Pediatrics / HealthyChildren.org — toddler nutrition, beverages, allergens, choking prevention and screen-time guidance; Digital Ecosystems, Children, and Adolescents: Policy Statement (Pediatrics, Vol. 157, Issue 2, 2026) — the AAP's current screen-guidance framework (the "5 C's": Child, Content, Calm, Crowding Out, Communication), referenced in Screens, Attention &amp; The Family Table and Appendix: Screens Beyond the Table.</li>
        <li>CDC — feeding, food safety and choking-prevention guidance, including added-sugar, juice and infant-honey/botulism guidance referenced in Sweetness, Sugars &amp; Drinks.</li>
        <li>Gracner T, Boone C, Gertler PJ. Exposure to sugar rationing in the first 1000 days of life protected against chronic disease. <em>Science</em>. 2024;386(6725):1043–1048. doi:10.1126/science.adn5421 — natural-experiment evidence on early-life sugar exposure, referenced in Sweetness, Sugars &amp; Drinks.</li>
        <li>USDA Agricultural Marketing Service — National Organic Program standards; National Bioengineered Food Disclosure Standard and its List of Bioengineered Foods, referenced in GMOs &amp; Bioengineered Foods.</li>
        <li>EPA — National Primary Drinking Water Regulation for PFOA/PFOS (4.0 ppt MCL) and the 2026 proposed compliance-extension rule; FDA — 2025 Federal Register notice on grease-proofing PFAS food-contact substances; EU Packaging and Packaging Waste Regulation (PPWR, effective August 2026) — referenced in PFAS / "Forever Chemicals."</li>
        <li>National Academies of Sciences, Engineering, and Medicine — Genetically Engineered Crops: Experiences and Prospects (2016); World Health Organization and FDA food-safety assessments of currently approved bioengineered crops.</li>
        <li>NOVA food classification system (Monteiro et al.) — degree-of-processing framework referenced in Processed Foods, Snacks &amp; Celebrations; used here as a descriptive tool, not a standalone safety verdict on any food.</li>
        <li>National Academies of Sciences, Engineering, and Medicine — Dietary Reference Intakes for Sodium and Potassium (2019), including the age 1–3 chronic-disease-risk-reduction sodium value.</li>
        <li>Ellyn Satter Institute — the Division of Responsibility in feeding, referenced throughout Responsive Feeding and Processed Foods, Snacks &amp; Celebrations. Widely used and recommended by pediatric clinicians and dietitians; not the subject of a formal AAP, USDA or Academy of Nutrition and Dietetics policy endorsement.</li>
      </ul>
      <div class="callout">General planning resource, not individualized medical care. Restricted patterns should be reviewed with a pediatrician or pediatric dietitian when growth, allergy, feeding, or adequacy is a concern. PFAS, GMO/bioengineered and other regulatory guidance can change — check current EPA, FDA, CDC/ATSDR and USDA sources rather than treating this book as a permanent reference.</div>
      <h2>The Roots Standard</h2>
      <p>The point is not to raise a child who eats perfectly.</p>
      <p>It is to raise children who grow up at a table where food is varied, nourishing, culturally alive, safely prepared and shared with pleasure.</p>
      <p style="font-family:Arial,sans-serif;font-weight:700;color:var(--accent);letter-spacing:0.03em">ONE TABLE. ONE MEAL. MANY WAYS TO BELONG.</p>
    `
    }
  ],
  weeklyPlan: [
    {
      "day": "1",
      "dinner": "Lentil-rice bowl"
    },
    {
      "day": "2",
      "dinner": "Salmon + sweet potato + peas"
    },
    {
      "day": "3",
      "dinner": "Chickpea patties + tomato pasta"
    },
    {
      "day": "4",
      "dinner": "Lentil vegetable stew"
    },
    {
      "day": "5",
      "dinner": "Three Sisters-style bean, corn & squash"
    },
    {
      "day": "6",
      "dinner": "Ginger trout + rice + bok choy"
    },
    {
      "day": "7",
      "dinner": "Mediterranean chickpea & herb bowl"
    }
  ],
  checklist: [
    "An iron-rich food appeared daily.",
    "Plant iron was paired with a vitamin-C food when practical.",
    "A reliable calcium + vitamin D strategy was intentional.",
    "B12 was covered if animal foods were limited.",
    "Iodine had a dependable source without simply increasing toddler salt.",
    "Healthy fats and energy density appeared through the week.",
    "Fish was lower-mercury and safely prepared.",
    "Fish variety and age-appropriate portions were considered.",
    "Fruits and vegetables varied across the week.",
    "Textures were adapted to each child's current skills.",
    "Water was available; added sugar and excess sodium stayed low.",
    "Organic choices preserved food variety rather than shrinking it.",
    "GMO/bioengineered sourcing choices, if any, didn't crowd out food variety.",
    "PFAS exposure was reduced where practical without sacrificing food variety or nutritional quality.",
    "Sweetness came mostly from whole fruit; added sugar stayed occasional; no honey under 12 months; juice (if any) stayed within the daily limit.",
    "Packaged/processed foods were judged by the nutritional job they did, not treated as automatically off-limits.",
    "Dessert, when served, came with the meal rather than as a reward or bribe.",
    "At least one emergency meal was available for the hard nights."
  ]
};

// ============================================================
// AGE COPY
// ============================================================
const ageCopy = {
  "1-3": "<strong>Ages 1–3:</strong> Softer textures, safer shapes, smaller starting portions, less added sodium; about 1 oz cooked fish is a useful starting point.",
  "4-6": "<strong>Ages 4–6:</strong> Same family food; larger portions, progressively broader textures and increasing participation.",
  "7+": "<strong>Ages 7+:</strong> Same family meal; hunger-led portions and increasing independence with serving and preparation.",
  "family": "<strong>Whole family:</strong> recipe amounts add up one portion for each child at your table. Older children get about 2× the toddler protein and about 1¾× everything else; fish follows the Fish &amp; Mercury guidance."
};

// ============================================================
// HELPERS
// ============================================================
function isMobile() {
  return window.matchMedia("(max-width: 900px)").matches;
}

function getFirstSectionIdForCategory(cat) {
  const items = appData.sections.filter(s => {
    const catOk = cat === "all" || s.category === cat;
    return catOk;
  });
  if (items.length === 0) return null;
  return items[0].id;
}

function getSectionIdForNav(nav) {
  const map = {
    'home': 'cover',
    'recipes': getFirstSectionIdForCategory('breakfast'),
    'planner': 'planner',
    'guides': 'flex',
    'formulas': 'formulas'
  };
  return map[nav] || 'cover';
}

function syncHash() {
  const id = AppState.getState().sectionId;
  if (id && window.location.hash !== `#${id}`) {
    try { window.location.hash = id; } catch (e) { /* ignore */ }
  }
}

function isRecipe(section) {
  return section.id && section.id.startsWith('rec-');
}

function renderEmptyCategory(category) {
  const catNames = {
    'breakfast': 'Breakfast',
    'lunch': 'Lunch',
    'dinner': 'Dinner',
    'snack': 'Snack',
    'foundation': 'Foundation'
  };
  const name = DOM.escape(catNames[category] || category);
  return `
    <div class="empty-category-state">
      <span class="icon">🍽️</span>
      <h2>No ${name} Recipes Yet</h2>
      <p>Check back soon! New recipes are being added regularly.</p>
      <p class="suggestion">💡 Try browsing "All" recipes or check the "Start" section for foundational meals.</p>
    </div>
  `;
}

// ============================================================
// RENDER FUNCTIONS
// ============================================================
function syncAllergenChips() {
  const state = AppState.getState();
  const excluded = state.excludedAllergens || [];
  document.querySelectorAll('#allergen-filters .af-chip[data-allergen]').forEach(btn => {
    const on = excluded.includes(btn.getAttribute('data-allergen'));
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const plantBtn = document.querySelector('#allergen-filters .af-chip[data-filter="plant"]');
  if (plantBtn) {
    plantBtn.classList.toggle('active', !!state.plantOnly);
    plantBtn.setAttribute('aria-pressed', state.plantOnly ? 'true' : 'false');
  }
  const clearBtn = document.getElementById('af-clear');
  if (clearBtn) {
    const searchOn = !!(state.query && state.query.trim());
    clearBtn.hidden = !(excluded.length || state.plantOnly || searchOn);
  }
}

function setupAllergenFilters() {
  const root = document.getElementById('allergen-filters');
  if (!root || root.dataset.bound) return;
  root.dataset.bound = '1';
  root.addEventListener('click', e => {
    const chip = e.target.closest('.af-chip');
    if (chip && chip.dataset.allergen) {
      AppState.toggleExcludeAllergen(chip.dataset.allergen);
      syncAllergenChips();
      renderNav();
      return;
    }
    if (chip && chip.dataset.filter === 'plant') {
      AppState.setPlantOnly(!AppState.getState().plantOnly);
      syncAllergenChips();
      renderNav();
      return;
    }
    if (e.target.id === 'af-clear' || e.target.closest('#af-clear')) {
      AppState.clearAllergenFilters();
      AppState.resetSearch();
      const searchInput = document.getElementById('global-search');
      if (searchInput) searchInput.value = '';
      syncAllergenChips();
      renderNav();
      renderMain(); // leave any search results page
    }
  });
}

function updateCategoryCounts() {
  const sections = (typeof appData !== 'undefined' && appData.sections) ? appData.sections : [];
  const counts = { all: sections.length };
  sections.forEach(s => {
    const c = s.category || 'guide';
    counts[c] = (counts[c] || 0) + 1;
  });
  document.querySelectorAll('#cat-buttons .cat-btn[data-cat]').forEach(btn => {
    const cat = btn.getAttribute('data-cat');
    const span = btn.querySelector('.cat-count');
    if (span) span.textContent = String(counts[cat] != null ? counts[cat] : 0);
  });
}

// ============================================================
// SEARCH
// ============================================================
// Shared by the sidebar list and the main-area results page. Guide text is
// matched with its HTML tags stripped, so a search for "strong" or "table"
// doesn't hit markup.
function sectionMatches(s, q) {
  if (!q) return true;
  if (s.title.toLowerCase().includes(q)) return true;
  if (typeof s.getScaledContent === 'function') {
    return ((s.ingredients || '') + ' ' + (s.method || '') + ' ' + (s.influence || '')).toLowerCase().includes(q);
  }
  if (typeof s.content === 'string') {
    return s.content.replace(/<[^>]+>/g, ' ').toLowerCase().includes(q);
  }
  return false;
}

function passesDietFilters(s, excluded, plantOnly) {
  if (!isRecipe(s) || !(excluded.length || plantOnly)) return true;
  const allergens = s.allergens || [];
  // An allergen the recipe itself makes optional (e.g. "water works" instead
  // of soy beverage) doesn't hide the recipe; its card and list row say so.
  const optional = s.allergenOptional || [];
  if (excluded.some(ex => allergens.includes(ex) && !optional.includes(ex))) return false;
  if (plantOnly && !(s.dietary || []).includes('Plant-based')) return false;
  return true;
}

const CATEGORY_LABELS = {
  start: 'Start here', formula: 'Formulas', guide: 'Guide',
  breakfast: 'Breakfast recipe', lunch: 'Lunch recipe', dinner: 'Dinner recipe',
  snack: 'Snack recipe', foundation: 'Foundation recipe'
};

// The header search box used to filter only the sidebar list — which on a
// phone is off-screen, so typing appeared to do nothing. Results now render
// in the main area on every screen size; the sidebar still filters too.
function renderSearchResults(query) {
  const raw = (query || '').trim();
  const q = raw.toLowerCase();
  const state = AppState.getState();
  const excluded = state.excludedAllergens || [];
  const plantOnly = !!state.plantOnly;
  // Best matches first: title hits, then recipes, then guides that only
  // mention the word in passing. sort() is stable, so book order holds within each tier.
  const rank = s => (s.title.toLowerCase().includes(q) ? 0 : 2) + (isRecipe(s) ? 0 : 1);
  const hits = appData.sections
    .filter(s => sectionMatches(s, q) && passesDietFilters(s, excluded, plantOnly))
    .sort((a, b) => rank(a) - rank(b));
  const rows = hits.map(s => `<div class="tonight-result"><div><strong>${DOM.escape(s.title)}</strong><br><span class="meta">${DOM.escape(CATEGORY_LABELS[s.category] || 'Guide')}</span></div><button type="button" data-section-id="${DOM.escapeAttr(s.id)}">Open</button></div>`).join('');
  const filterNote = (excluded.length || plantOnly) ? ' (allergen filters on)' : '';
  const main = document.getElementById('main');
  main.innerHTML = `<h1>🔍 Search</h1><p class="meta" role="status">${hits.length} result${hits.length !== 1 ? 's' : ''} for “${DOM.escape(raw)}”${filterNote}</p><div id="search-results">${rows || '<p>No matches. Try a single ingredient, like “lentils” or “salmon”.</p>'}</div>`;
  main.querySelectorAll('#search-results button[data-section-id]').forEach(btn => btn.addEventListener('click', () => openFromSearch(btn.dataset.sectionId)));
  updateMobileNav('');
  scrollToTop();
}

function openFromSearch(id) {
  AppState.resetSearch();
  const gs = document.getElementById('global-search');
  if (gs) { gs.value = ''; gs.blur(); }
  AppState.setSection(id);
  renderNav();
  renderMain();
  syncHash();
  scrollToTop();
}

// Sidebar recipe groups. Under the "All" view, recipes are collapsed into one
// row per meal category so the 42 recipes don't bury the guides. A group opens
// when tapped, when it holds the recipe being viewed, or while a search or
// allergen filter is narrowing the list. Picking a single category chip still
// shows that category's recipes as a plain list.
const NAV_GROUPS = [
  ['breakfast', 'Breakfast'],
  ['lunch', 'Lunch'],
  ['dinner', 'Dinner'],
  ['snack', 'Snacks'],
  ['foundation', 'Foundations']
];
const navOpenGroups = new Set();
let navLastAutoOpenedId = null;

function renderNav() {
  const state = AppState.getState();
  syncAllergenChips();
  updateCategoryCounts();
  const list = document.getElementById("nav-list");
  list.innerHTML = "";
  const q = state.query.toLowerCase();
  const excluded = state.excludedAllergens || [];
  const plantOnly = !!state.plantOnly;
  const items = appData.sections.filter(s => {
    const catOk = state.category === "all" || s.category === state.category;
    return catOk && sectionMatches(s, q) && passesDietFilters(s, excluded, plantOnly);
  });

  const resultCount = document.getElementById("search-result-count");
  const filterActive = excluded.length > 0 || plantOnly;
  if ((q || filterActive) && items.length > 0) {
    const bits = [];
    if (q) bits.push('search');
    if (filterActive) bits.push('filters');
    resultCount.textContent = `${items.length} result${items.length !== 1 ? 's' : ''}` + (bits.length ? ` (${bits.join(' + ')})` : '');
    resultCount.style.display = 'block';
  } else if ((q || filterActive) && items.length === 0) {
    resultCount.textContent = filterActive && !q ? 'No recipes match these allergen filters' : 'No results found';
    resultCount.style.display = 'block';
  } else {
    resultCount.style.display = 'none';
  }

  if (!items.length) {
    list.innerHTML = `<div style="padding:10px;font-size:12px;color:var(--muted);font-style:italic">
      ${state.category !== 'all' ? `No ${state.category} recipes yet. Try "All" or another category.` : 'No matches found.'}
    </div>`;
    return;
  }

  const favorites = AppState.getFavorites();
  const currentId = state.sectionId;

  function makeNavItem(s) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-item" + (s.id === currentId ? " active" : "");

    // Escape all segments; highlight only already-escaped match parts
    let displayTitle;
    if (state.query) {
      const re = new RegExp(`(${state.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      const parts = s.title.split(re);
      displayTitle = parts.map((part, i) =>
        i % 2 === 1
          ? `<span class="match-highlight">${DOM.escape(part)}</span>`
          : DOM.escape(part)
      ).join('');
    } else {
      displayTitle = DOM.escape(s.title);
    }

    let badge = '';
    if (isRecipe(s) && favorites.includes(s.id)) {
      badge = '<span class="nav-badge">⭐</span>';
    }
    btn.innerHTML = displayTitle + badge;
    if (s.id === currentId) btn.setAttribute('aria-current', 'page');

    btn.addEventListener("click", () => {
      AppState.setSection(s.id);
      AppState.resetSearch();
      document.getElementById("global-search").value = "";
      renderNav();
      renderMain();
      document.getElementById("main").scrollTop = 0;
      syncHash();
      updateMobileNav(s.id);
      closeSidebar();
    });
    return btn;
  }

  // A single category chip is already a short list — keep it flat.
  if (state.category !== "all") {
    items.forEach(s => list.appendChild(makeNavItem(s)));
    return;
  }

  // Open the group holding the recipe being viewed, once per recipe, so the
  // parent can still collapse it afterwards if they want.
  const currentSection = appData.sections.find(s => s.id === currentId);
  if (currentSection && isRecipe(currentSection) && navLastAutoOpenedId !== currentId) {
    navOpenGroups.add(currentSection.category);
    navLastAutoOpenedId = currentId;
  }
  const narrowing = !!q || filterActive;

  items.filter(s => !isRecipe(s)).forEach(s => list.appendChild(makeNavItem(s)));

  const recipeItems = items.filter(isRecipe);
  if (!recipeItems.length) return;

  const heading = document.createElement("div");
  heading.className = "nav-group-heading";
  heading.textContent = "Recipes";
  list.appendChild(heading);

  const groupedCats = NAV_GROUPS.map(([cat]) => cat);
  const groups = NAV_GROUPS.slice();
  // Any recipe category not in the list above still gets its own group.
  recipeItems.forEach(s => {
    if (!groupedCats.includes(s.category)) {
      groupedCats.push(s.category);
      groups.push([s.category, s.category.charAt(0).toUpperCase() + s.category.slice(1)]);
    }
  });

  groups.forEach(([cat, label]) => {
    const groupItems = recipeItems.filter(s => s.category === cat);
    if (!groupItems.length) return;
    const open = narrowing || navOpenGroups.has(cat);
    const panelId = `nav-group-${cat}`;

    const wrap = document.createElement("div");
    wrap.className = "nav-group";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "nav-group-toggle";
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.setAttribute("aria-controls", panelId);
    toggle.innerHTML = `<span class="nav-group-caret" aria-hidden="true">▸</span><span class="nav-group-label">${DOM.escape(label)}</span><span class="nav-group-count">${groupItems.length}</span>`;

    const panel = document.createElement("div");
    panel.className = "nav-group-items";
    panel.id = panelId;
    panel.hidden = !open;
    groupItems.forEach(s => panel.appendChild(makeNavItem(s)));

    toggle.addEventListener("click", () => {
      const nowOpen = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", nowOpen ? "true" : "false");
      panel.hidden = !nowOpen;
      if (nowOpen) navOpenGroups.add(cat);
      else navOpenGroups.delete(cat);
    });

    wrap.appendChild(toggle);
    wrap.appendChild(panel);
    list.appendChild(wrap);
  });
}

function updateMobileNav(sectionId) {
  // Plan, Grocery and Contents open panels rather than pages, so they used to
  // fall through getSectionIdForNav() to "cover" and light up alongside Home.
  // Only Home and Recipes are page destinations; Plan lights up on the
  // 7-day plan page it leads to.
  const id = sectionId || '';
  document.querySelectorAll('.mobile-bottom-nav .nav-btn').forEach(btn => {
    const nav = btn.getAttribute('data-nav');
    let on = false;
    if (nav === 'home') on = id === 'cover';
    else if (nav === 'recipes') on = id.startsWith('rec-') || id === 'recipes';
    else if (nav === 'tools') on = id === 'planner';
    btn.classList.toggle('active', on);
  });
}

function renderMain() {
  const state = AppState.getState();
  const sec = appData.sections.find(s => s.id === state.sectionId);
  if (!sec) {
    document.getElementById("main").innerHTML = `<p>Section not found. <a href="#" onclick="AppState.setSection('cover');renderNav();renderMain();return false;">Return to home</a></p>`;
    return;
  }
  if (isRecipe(sec) && typeof sec.getScaledContent === 'function') {
    document.getElementById("main").innerHTML = sec.getScaledContent(state.age);
    attachRecipeActions();
  } else {
    document.getElementById("main").innerHTML = sec.content;
    if (sec.id === 'cover') renderInstallCard();
  }
  updateMobileNav(state.sectionId);
}

// ============================================================
// INSTALL ROOTS (add to home screen)
// ============================================================
// Chrome/Edge/Android fire beforeinstallprompt, which lets us offer a real
// Install button. iPhone/iPad Safari never does, so those visitors get the
// Share → Add to Home Screen steps instead. Nothing shows once Roots is
// already running as an installed app, or after the parent taps "Not now".
let deferredInstallPrompt = null;
function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIOSDevice() {
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}
function renderInstallCard() {
  const old = document.getElementById('install-card');
  if (old) old.remove();
  if (isStandaloneApp() || safeStorageGet('roots_install_dismissed') === '1') return;
  let body;
  if (deferredInstallPrompt) {
    body = `<p>Keep Roots one tap away and use it offline in the kitchen.</p><div class="install-actions"><button type="button" class="install-go" id="install-go">Install Roots</button><button type="button" class="install-later" id="install-later">Not now</button></div>`;
  } else if (isIOSDevice()) {
    body = `<p>Keep Roots one tap away and use it offline in the kitchen:</p><ol class="install-steps"><li>Open this page in <strong>Safari</strong>.</li><li>Tap the <strong>Share</strong> button.</li><li>Tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li></ol><div class="install-actions"><button type="button" class="install-later" id="install-later">Got it</button></div>`;
  } else {
    return; // browser can't install, or hasn't offered yet — say nothing
  }
  const card = document.createElement('div');
  card.className = 'install-card';
  card.id = 'install-card';
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Add Roots to your home screen');
  card.innerHTML = `<div class="install-title">📲 Add Roots to your home screen</div>${body}`;
  const anchor = document.querySelector('#main .home-hero');
  if (anchor) anchor.insertAdjacentElement('afterend', card);
  else document.getElementById('main').prepend(card);
  const later = document.getElementById('install-later');
  if (later) later.addEventListener('click', () => {
    try { localStorage.setItem('roots_install_dismissed', '1'); } catch (_) {}
    card.remove();
  });
  const go = document.getElementById('install-go');
  if (go) go.addEventListener('click', async () => {
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    if (!promptEvent) { card.remove(); return; }
    promptEvent.prompt();
    try { await promptEvent.userChoice; } catch (_) {}
    card.remove();
  });
}
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (AppState.getState().sectionId === 'cover' && document.querySelector('#main .home-hero')) renderInstallCard();
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  const card = document.getElementById('install-card');
  if (card) card.remove();
});

function attachRecipeActions() {
  document.querySelectorAll('.btn-favorite').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = btn.getAttribute('data-recipe-id');
      const isFav = AppState.toggleFavorite(id);
      btn.textContent = isFav ? '⭐ Favorite' : '☆ Favorite';
      btn.classList.toggle('active', isFav);
      renderNav();
    });
  });

  document.querySelectorAll('.btn-grocery-add').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = RECIPES.find(x => x.id === btn.getAttribute('data-recipe-id'));
      if (!r) return;
      const mode = AppState.getState().age;
      const added = AppState.addGroceryEntries(groceryEntriesFor(r, mode, AppState.getHousehold()), r.title.replace(/^\d+\s*/, ''));
      const who = mode === 'family' ? 'whole family' : (mode === '1-3' ? 'ages 1–3' : 'ages ' + AGE_SHORT[mode]);
      btn.textContent = added ? `✅ Added (${who} amounts)` : '✅ Added';
      btn.classList.add('added');
      setTimeout(() => { btn.textContent = '🛒 Add to Grocery'; btn.classList.remove('added'); }, 2200);
    });
  });
  document.querySelectorAll('.btn-cooking-mode').forEach(btn => btn.addEventListener('click', () => openCookingMode(btn.getAttribute('data-recipe-id'))));
}

// Emergency & No-Cook quick index — grouping follows the book's own
// Emergency & No-Cook Meals chapter (Recipes 33–35, 37 and 42 ~10 minutes; 36 and 38–41 no cooking).
function scrollToTop() {
  const main = document.getElementById('main');
  if (main) main.scrollTop = 0;
  window.scrollTo(0, 0);
}

// ============================================================
// RECIPE LIST (2026-10-06) — the Recipes tab's home
// ============================================================
let recipeListFilter = 'all';
const RECIPE_LIST_FILTERS = [['all', 'All'], ['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner'], ['snack', 'Snacks'], ['foundation', 'Foundations'], ['emergency', 'Emergency & no-cook'], ['favorites', '⭐ Favorites']];
const LIST_ALLERGENS = ['Egg', 'Fish', 'Soy', 'Gluten', 'Sesame', 'Peanut', 'Sunflower', 'Coconut'];
function modeLabel(mode) {
  if (mode === 'family') return `whole family — ${householdLabel(AppState.getHousehold())}`;
  return mode === '1-3' ? 'ages 1–3' : 'ages ' + AGE_SHORT[mode];
}
function renderRecipeList(filter) {
  if (filter) recipeListFilter = filter;
  const st = AppState.getState();
  const excluded = st.excludedAllergens || [];
  const plantOnly = !!st.plantOnly;
  const favs = AppState.getFavorites();
  const f = recipeListFilter;
  const items = RECIPES.filter(r => {
    if (f === 'emergency') return EMERGENCY_IDS.includes(r.id);
    if (f === 'favorites') return favs.includes(r.id);
    return f === 'all' || r.category === f;
  }).filter(r => passesDietFilters(r, excluded, plantOnly));
  const rows = items.map(r => {
    const optional = r.allergenOptional || [];
    const allergens = (r.allergens || []).map(a => optional.includes(a) ? `${a} (optional)` : a);
    const freeOptions = excluded.filter(ex => optional.includes(ex)).map(ex => `${ex.toLowerCase()}-free option`);
    const total = minutes(r.prepTime) + minutes(r.cookTime);
    const meta = [`⏱ ${total} min`, r.difficulty, allergens.length ? 'Contains ' + allergens.join(', ') : 'No common allergens flagged'].concat(freeOptions);
    return `<button type="button" class="recipe-row" data-recipe-id="${DOM.escapeAttr(r.id)}"><span class="recipe-row-title">${favs.includes(r.id) ? '⭐ ' : ''}${DOM.escape(r.title)}</span><span class="recipe-row-meta">${DOM.escape(meta.join(' · '))}</span></button>`;
  }).join('');
  const filterCount = excluded.length + (plantOnly ? 1 : 0);
  const chips = RECIPE_LIST_FILTERS.map(([k, l]) => `<button type="button" class="list-chip${k === f ? ' active' : ''}" data-list="${k}" aria-pressed="${k === f}">${DOM.escape(l)}</button>`).join('');
  const afChips = `<button type="button" class="list-af${plantOnly ? ' active' : ''}" data-filter="plant" aria-pressed="${plantOnly}">🌱 Plant-based only</button>` +
    LIST_ALLERGENS.map(a => `<button type="button" class="list-af${excluded.includes(a) ? ' active' : ''}" data-allergen="${a}" aria-pressed="${excluded.includes(a)}">No ${a.toLowerCase()}</button>`).join('') +
    (filterCount ? '<button type="button" class="list-af-clear" data-list-clear>Clear filters</button>' : '');
  const main = document.getElementById('main');
  main.innerHTML = `<div id="recipe-list-view"><h1>🍳 Recipes</h1><p class="meta">Tap a recipe to open it. Amounts follow your “Cooking for” setting (${DOM.escape(modeLabel(st.age))}).</p><div class="list-chips" role="group" aria-label="Show recipes">${chips}</div><details class="list-filters"${filterCount ? ' open' : ''}><summary>Allergen filters${filterCount ? ` (${filterCount} on)` : ''}</summary><div class="list-afs" role="group" aria-label="Allergen filters">${afChips}</div></details><p class="meta" role="status">${items.length} recipe${items.length !== 1 ? 's' : ''}</p><div class="recipe-rows">${rows || '<p>No recipes match. Try another group or clear the allergen filters.</p>'}</div></div>`;
  updateMobileNav('recipes');
  if (window.location.hash !== '#recipes') { try { history.pushState(null, '', '#recipes'); } catch (_) {} }
  scrollToTop();
  if (isMobile()) closeSidebar();
}
function isRecipeListShowing() { return !!document.getElementById('recipe-list-view'); }
function setupRecipeList() {
  document.getElementById('main').addEventListener('click', e => {
    const chip = e.target.closest('.list-chip');
    if (chip) { renderRecipeList(chip.dataset.list); return; }
    const af = e.target.closest('.list-af');
    if (af) {
      if (af.dataset.filter === 'plant') AppState.setPlantOnly(!AppState.getState().plantOnly);
      else AppState.toggleExcludeAllergen(af.dataset.allergen);
      return; // the allergenFilter subscription re-renders the list
    }
    if (e.target.closest('[data-list-clear]')) { AppState.clearAllergenFilters(); return; }
    const row = e.target.closest('.recipe-row');
    if (row) {
      AppState.setSection(row.dataset.recipeId);
      renderNav(); renderMain(); syncHash(); scrollToTop();
      return;
    }
    if (e.target.closest('[data-open-list]')) renderRecipeList();
  });
}

function renderEmergency() {
  const byId = id => RECIPES.find(r => r.id === id);
  const row = r => r ? `<div class="tonight-result"><div><strong>${DOM.escape(r.title.replace(/^\d+\s*/, ''))}</strong><br><span class="meta">${DOM.escape(r.prepTime)} prep · ${DOM.escape(r.cookTime)} cook</span></div><button type="button" data-recipe-id="${DOM.escapeAttr(r.id)}">Open recipe</button></div>` : '';
  const quick = ['rec-33','rec-34','rec-35','rec-37','rec-42'].map(byId).map(row).join('');
  const noCook = ['rec-36','rec-38','rec-39','rec-40','rec-41'].map(byId).map(row).join('');
  document.getElementById('main').innerHTML = `<h1>🆘 Day fell apart?</h1><p class="meta">Built from pantry and freezer staples plus a few long-keeping fridge items (eggs, tofu, hummus, avocado, fruit). Same safety rules as every Roots meal — safe shapes, soft textures, and fully cooked eggs and fish.</p><h2>About ten minutes</h2><div id="emergency-results">${quick}</div><h2>No stove needed</h2><div>${noCook}</div>`;
  document.querySelectorAll('#main .tonight-result button').forEach(btn => btn.addEventListener('click', () => { AppState.setSection(btn.dataset.recipeId); renderNav(); renderMain(); syncHash(); scrollToTop(); }));
  scrollToTop();
  updateMobileNav(''); // not a bottom-nav destination: clear any stale highlight
  if (isMobile()) closeSidebar();
}

function minutes(value) { const match = String(value).match(/\d+/); return match ? Number(match[0]) : 0; }
function renderTonight(limit = 30, pantry = '') {
  // Track whether the pantry input had focus before this re-render so we
  // can restore it afterward — renderTonight rebuilds #main's innerHTML,
  // which destroys and recreates the input, so without this the field
  // loses focus every time Enter is pressed.
  const hadFocus = document.activeElement && document.activeElement.id === 'pantry-search';
  updateMobileNav(''); // not a bottom-nav destination: clear any stale highlight
  const pantryTerms = pantry.toLowerCase().split(',').map(term => term.trim()).filter(Boolean);
  // Same allergen / plant-based filters as search and the sidebar — a parent
  // who has excluded fish or egg must not be offered those dinners here.
  const dietState = AppState.getState();
  const dietExcluded = dietState.excludedAllergens || [];
  const dietPlantOnly = !!dietState.plantOnly;
  const filtersOn = dietExcluded.length > 0 || dietPlantOnly;
  const dinnerRecipes = RECIPES.filter(r => r.category === 'dinner' && passesDietFilters(r, dietExcluded, dietPlantOnly));
  const timeMatch = r => limit === 'all' || minutes(r.prepTime) + minutes(r.cookTime) <= Number(limit);
  const scored = dinnerRecipes.map(r => ({ recipe: r, matches: pantryTerms.filter(term => r.ingredients.toLowerCase().includes(term)) })).filter(item => timeMatch(item.recipe) && (!pantryTerms.length || item.matches.length)).sort((a, b) => b.matches.length - a.matches.length || (minutes(a.recipe.prepTime) + minutes(a.recipe.cookTime)) - (minutes(b.recipe.prepTime) + minutes(b.recipe.cookTime)));
  document.getElementById('main').innerHTML = `<h1>🌙 Dinner tonight</h1><p class="meta">Dinner recipes only — fastest and best pantry matches first.${filtersOn ? ` Your recipe filters are on (${DOM.escape([dietPlantOnly ? 'plant-based only' : '', ...dietExcluded.map(a => 'no ' + a.toLowerCase())].filter(Boolean).join(', '))}).` : ''}</p><label for="pantry-search"><strong>What do you have?</strong></label><input class="pantry-input" id="pantry-search" type="search" value="${DOM.escapeAttr(pantry)}" placeholder="Try: lentils, rice, sweet potato"><p class="pantry-help">Separate ingredients with commas, then press Enter. Matching dinners rise to the top.</p><div class="tonight-filters" role="group" aria-label="Maximum dinner time">${[['15','15 min'],['30','30 min'],['45','45 min'],['all','All dinners']].map(([value,label]) => `<button type="button" data-limit="${value}" class="${String(value) === String(limit) ? 'active' : ''}">${label}</button>`).join('')}</div><div id="tonight-results">${scored.length ? scored.map(({recipe:r,matches}) => `<div class="tonight-result"><div><strong>${DOM.escape(r.title.replace(/^\d+\s*/, ''))}</strong><br><span class="meta">${DOM.escape(r.prepTime)} prep · ${DOM.escape(r.cookTime)} cook${matches.length ? ` · Pantry match: ${DOM.escape(matches.join(', '))}` : ''}</span></div><button type="button" data-recipe-id="${DOM.escapeAttr(r.id)}">Open recipe</button></div>`).join('') : `<p>No dinner matches that combination. Try a longer time or fewer pantry terms${filtersOn ? ', or loosen your recipe filters in Contents' : ''}.</p>`}</div>`;
  document.querySelectorAll('.tonight-filters button').forEach(btn => btn.addEventListener('click', () => renderTonight(btn.dataset.limit, document.getElementById('pantry-search').value)));
  document.getElementById('pantry-search').addEventListener('keydown', e => { if (e.key === 'Enter') renderTonight(limit, e.target.value); });
  document.querySelectorAll('#tonight-results button').forEach(btn => btn.addEventListener('click', () => { AppState.setSection(btn.dataset.recipeId); renderNav(); renderMain(); syncHash(); scrollToTop(); }));
  if (hadFocus) {
    const input = document.getElementById('pantry-search');
    if (input) {
      input.focus();
      const len = input.value.length;
      try { input.setSelectionRange(len, len); } catch (_) {}
    }
  }
}
let activeTimer = null;
function openCookingMode(id) {
  const item = RECIPES.find(r => r.id === id); if (!item) return;
  const steps = item.method.split(/\.\s+/).filter(Boolean);
  document.getElementById('cooking-content').innerHTML = `<h2>👨‍🍳 ${DOM.escape(item.title.replace(/^\d+\s*/, ''))}</h2><p><strong>Ingredients</strong><br>${scaleIngredientLines(item, AppState.getState().age, AppState.getHousehold()).map(l => l.scaled ? `<strong>${DOM.escape(l.amount)}</strong> ${DOM.escape(l.rest)}` : DOM.escape(l.text) + (l.byEye ? ' <em>(scale by eye)</em>' : '')).join('<br>')}</p><div>${steps.map((step, i) => `<div class="cooking-step"><span class="step-number">${i + 1}</span>${DOM.escape(step)}</div>`).join('')}</div><div class="timer-display" id="timer-display">00:00</div><div class="timer-controls"><button type="button" id="timer-start">Start timer</button><button type="button" id="timer-pause">Pause</button><button type="button" id="timer-reset">Reset</button></div>`;
  const seconds = Math.max(60, (minutes(item.prepTime) + minutes(item.cookTime)) * 60); let remaining = seconds;
  const display = () => document.getElementById('timer-display').textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  display(); clearInterval(activeTimer);
  document.getElementById('timer-start').onclick = () => { clearInterval(activeTimer); activeTimer = setInterval(() => { if (remaining > 0) { remaining--; display(); } else clearInterval(activeTimer); }, 1000); };
  document.getElementById('timer-pause').onclick = () => clearInterval(activeTimer);
  document.getElementById('timer-reset').onclick = () => { clearInterval(activeTimer); remaining = seconds; display(); };
  const cookOv = document.getElementById('cooking-overlay');
  if (!cookOv.classList.contains('open')) OverlayLock.acquire(); // lock page scroll behind the overlay; guarded so a re-open can't leak a count
  cookOv.classList.add('open');
  FocusManager.trap(cookOv);
}
function closeCookingMode() {
  clearInterval(activeTimer);
  const cookOv = document.getElementById('cooking-overlay');
  const cookWasOpen = cookOv.classList.contains('open');
  cookOv.classList.remove('open');
  if (cookWasOpen) OverlayLock.release();
  FocusManager.release(cookOv);
}

function renderMeals() {
  const box = document.getElementById("meal-plan");
  box.innerHTML = "";
  appData.weeklyPlan.forEach(d => {
    const el = document.createElement("div");
    el.className = "meal-day";
    el.innerHTML = `<span><strong>Day ${DOM.escape(String(d.day))}:</strong> ${DOM.escape(d.dinner)}</span><span style="font-size:10px;color:var(--muted)">Open</span>`;
    el.addEventListener("click", () => {
      AppState.setSection("planner");
      AppState.resetSearch();
      document.getElementById("global-search").value = "";
      renderNav();
      renderMain();
      requestAnimationFrame(() => {
        const row = document.getElementById(`planner-day-${d.day}`);
        if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      if (isMobile()) closeTools();
    });
    box.appendChild(el);
  });
}

function renderChecklist() {
  const state = AppState.getState();
  const box = document.getElementById("checklist");
  box.innerHTML = "";
  let n = 0;
  appData.checklist.forEach((text, i) => {
    const on = !!state.checked[i];
    if (on) n++;
    const label = document.createElement("label");
    label.className = "check-row" + (on ? " done" : "");
    label.innerHTML = `<input type="checkbox" ${on ? "checked" : ""}><span>${DOM.escape(text)}</span>`;
    label.querySelector("input").addEventListener("change", e => {
      AppState.toggleCheck(i);
      renderChecklist();
    });
    box.appendChild(label);
  });
  // No running score here on purpose: the Reset is a reflection list, not a tally.
}

function groceryLabel(name) { return name.charAt(0).toUpperCase() + name.slice(1); }
function renderGrocery() {
  const grocery = AppState.getGrocery();
  const body = document.getElementById('grocery-body');

  if (!grocery.items.length) {
    body.innerHTML = '<div class="empty-state">Add ingredients from recipes to build your shopping list.<br><br>📝 Tap "Add to Grocery" on any recipe. Amounts follow your “Cooking for” setting, and the same ingredient from different recipes is added together.</div>';
    updateGroceryBadge();
    return;
  }

  let html = '';
  GROCERY_SECTIONS.forEach(([sec, label]) => {
    const items = grocery.items.filter(i => (i.section || 'other') === sec);
    if (!items.length) return;
    html += `<h3 class="grocery-section">${DOM.escape(label)}</h3>`;
    items.forEach(item => {
      const checked = !!grocery.checked[item.key];
      const amount = groceryAmountText(item);
      html += `
      <label class="grocery-item">
        <input type="checkbox" data-key="${DOM.escapeAttr(item.key)}" ${checked ? 'checked' : ''}>
        <span class="grocery-main">
          <span class="grocery-text ${checked ? 'checked' : ''}">${DOM.escape(groceryLabel(item.name))}${amount ? ` <span class="grocery-amount">${DOM.escape(amount)}</span>` : ''}</span>
          <span class="grocery-source">${DOM.escape((item.sources || []).join(' · '))}</span>
        </span>
      </label>`;
    });
  });
  body.innerHTML = html;

  body.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', (e) => {
      AppState.toggleGroceryItem(e.target.getAttribute('data-key'));
    });
  });

  updateGroceryBadge();
}

function updateGroceryBadge() {
  const grocery = AppState.getGrocery();
  const btn = document.getElementById('toggle-grocery');
  const oldBadge = btn.querySelector('.grocery-count');
  if (oldBadge) oldBadge.remove();
  if (grocery.items.length) {
    const badge = document.createElement('span');
    badge.className = 'grocery-count';
    badge.style.cssText = 'background:var(--accent);color:#fff;border-radius:10px;padding:0 6px;font-size:9px;margin-left:2px;';
    badge.textContent = grocery.items.length;
    btn.appendChild(badge);
  }
  const navBtn = document.querySelector('.mobile-bottom-nav .nav-btn[data-nav="grocery"] .nav-icon-wrap');
  if (navBtn) {
    const oldNavBadge = navBtn.querySelector('.nav-badge');
    if (oldNavBadge) oldNavBadge.remove();
    if (grocery.items.length) {
      const b = document.createElement('span');
      b.className = 'nav-badge';
      b.textContent = grocery.items.length;
      navBtn.appendChild(b);
    }
  }
}

async function copyGroceryList() {
  const grocery = AppState.getGrocery();
  const parts = [];
  GROCERY_SECTIONS.forEach(([sec, label]) => {
    const items = grocery.items.filter(i => (i.section || 'other') === sec);
    if (!items.length) return;
    parts.push(label.toUpperCase());
    items.forEach(item => {
      const amount = groceryAmountText(item);
      parts.push(`• ${groceryLabel(item.name)}${amount ? ` — ${amount}` : ''}`);
    });
    parts.push('');
  });
  const text = parts.join('\n').trim();
  const button = document.getElementById('grocery-copy');
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied!';
  } catch (_) {
    button.textContent = 'Copy unavailable';
  }
  setTimeout(() => { button.textContent = 'Copy List'; }, 1500);
}

// ============================================================
// PANEL CONTROLS
// ============================================================
// The Contents drawer is moved off-screen with a CSS transform on mobile, which
// does not remove it from the accessibility tree or the Tab order. Mirror what
// the grocery panel already does: inert + aria-hidden while it is closed on
// mobile; on desktop it is the permanent sidebar and must stay reachable.
function syncSidebarAT() {
  const s = document.getElementById('sidebar');
  if (!s) return;
  const hide = isMobile() && !document.body.classList.contains('mobile-browse-open');
  s.inert = hide;
  if (hide) s.setAttribute('aria-hidden', 'true'); else s.removeAttribute('aria-hidden');
}

function openSidebar() {
  // Guard against double-open: this is called unconditionally from the
  // mobile bottom-nav "Browse" button (not routed through a toggle), so a
  // second call while already open must not acquire the lock twice — the
  // matching close only ever releases once.
  if (document.body.classList.contains('mobile-browse-open')) return;
  document.body.classList.add('mobile-browse-open');
  syncSidebarAT(); // un-inert before focus moves into it, below
  OverlayLock.acquire();
  const sidebar = document.getElementById('sidebar');
  const closeBtn = document.getElementById('close-sidebar');
  if (closeBtn) setTimeout(() => closeBtn.focus(), 100);
  FocusManager.trap(sidebar);
}

function closeSidebar() {
  // Guard on the sidebar's own open state — this is called defensively
  // from several places (backdrop click, Escape, resize) regardless of
  // whether the sidebar is actually open, so it must not release a lock
  // it never acquired.
  const wasOpen = document.body.classList.contains('mobile-browse-open');
  document.body.classList.remove('mobile-browse-open');
  if (wasOpen) OverlayLock.release();
  FocusManager.release(document.getElementById('sidebar')); // restore focus outside first
  syncSidebarAT();
}

function openTools() {
  const dash = document.getElementById("dashboard");
  if (isMobile()) {
    // Guard against double-open: called unconditionally from the mobile
    // bottom-nav "Tools" button (not routed through toggleTools()), so a
    // second call while already open must not acquire the lock twice.
    if (dash.classList.contains("open")) return;
    dash.classList.add("open");
    dash.classList.remove("collapsed");
    dash.setAttribute("aria-modal", "true");
    // role="dialog" only while genuinely acting as a mobile modal overlay —
    // otherwise the <aside> should keep its implicit "complementary" role.
    dash.setAttribute("role", "dialog");
    OverlayLock.acquire();
    FocusManager.trap(dash);
  } else {
    // On desktop the dashboard is a persistent, non-modal sidebar — the
    // rest of the page stays interactive, so aria-modal must stay false.
    dash.classList.remove("collapsed");
    dash.removeAttribute("aria-modal");
    dash.removeAttribute("role");
  }
  document.getElementById("toggle-tools").setAttribute("aria-expanded", "true");
}

function closeTools() {
  closeSidebar();
  const dash = document.getElementById("dashboard");
  if (isMobile()) {
    const wasOpen = dash.classList.contains("open");
    dash.classList.remove("open");
    if (wasOpen) OverlayLock.release();
    FocusManager.release(dash); // also sets aria-modal="false"
  } else {
    dash.classList.add("collapsed");
  }
  dash.removeAttribute("aria-modal");
  dash.removeAttribute("role");
  document.getElementById("toggle-tools").setAttribute("aria-expanded", "false");
}

function toggleTools() {
  const dash = document.getElementById("dashboard");
  if (isMobile()) {
    if (dash.classList.contains("open")) closeTools();
    else openTools();
  } else {
    if (dash.classList.contains("collapsed")) openTools();
    else closeTools();
  }
}

function toggleGroceryPanel() {
  const panel = document.getElementById('grocery-panel');
  const isOpen = panel.classList.contains('open');
  if (isOpen) {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    panel.inert = true;
    OverlayLock.release();
    FocusManager.release(panel); // also sets aria-modal="false"
  } else {
    panel.inert = false;
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    OverlayLock.acquire();
    FocusManager.trap(panel); // also sets aria-modal="true"
    const closeBtn = document.getElementById('close-grocery');
    if (closeBtn) setTimeout(() => closeBtn.focus(), 100);
  }
}

function openGroceryPanel() {
  if (!document.getElementById('grocery-panel').classList.contains('open')) toggleGroceryPanel();
}

function closeGroceryPanel() {
  const panel = document.getElementById('grocery-panel');
  const wasOpen = panel.classList.contains('open');
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  panel.inert = true;
  if (wasOpen) OverlayLock.release();
  FocusManager.release(panel); // also sets aria-modal="false"; no-op if not trapped
}

function printCurrentView() {
  const main = document.getElementById("main");
  if (!main) { window.print(); return; }
  const title = document.title || "Roots Edition";
  const w = window.open("", "_blank", "noopener,noreferrer");
  if (!w) {
    // Popup blocked — fall back to page print (CSS still hides chrome)
    window.print();
    return;
  }
  // The app's real styling lives in the external styles.css, not in inline
  // <style> tags, so it has to be <link>ed into the new window explicitly —
  // copying document.querySelectorAll('style') alone misses it entirely.
  const stylesheetLinks = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
    .map(l => `<link rel="stylesheet" href="${l.href}">`)
    .join("\n");
  const inlineStyles = Array.from(document.querySelectorAll("style"))
    .map(s => s.outerHTML)
    .join("\n");
  w.document.open();
  w.document.write(
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<title>" + title.replace(/</g, "") + "</title>" + stylesheetLinks + inlineStyles +
    "<style>" +
    "body{background:#fff!important;margin:0;padding:16px;}" +
    ".app-header,.sidebar,.dashboard,.no-print,.mobile-bottom-nav," +
    ".grocery-panel,.skip-link,.offline-indicator,.data-load-error,.update-available,.backdrop," +
    ".header-age,.cooking-overlay{display:none!important;}" +
    ".main{max-width:100%!important;max-height:none!important;overflow:visible!important;" +
    "padding:0!important;margin:0!important;}" +
    ".recipe-card{break-inside:avoid;}" +
    "</style></head><body><div class=\"main\">" +
    main.innerHTML +
    "</div></body></html>"
  );
  w.document.close();
  w.focus();
  // window.print() is asynchronous in some browsers (notably Safari) — it
  // returns immediately while the native print dialog is still open, so
  // closing the window right after print() can cancel that dialog. Prefer
  // the 'afterprint' event (fires once the dialog is dismissed, print or
  // cancel) and only fall back to a timed close if that event never fires.
  const triggerPrint = () => {
    let closed = false;
    const doClose = () => { if (!closed) { closed = true; try { w.close(); } catch (_) {} } };
    try { w.addEventListener('afterprint', doClose, { once: true }); } catch (_) {}
    try { w.print(); } catch (_) { doClose(); }
    // Safety net: some browsers/print-preview flows never fire afterprint.
    setTimeout(doClose, 60000);
  };
  const styleLinkEl = w.document.querySelector('link[rel="stylesheet"]');
  if (styleLinkEl) {
    let done = false;
    const finish = () => { if (!done) { done = true; triggerPrint(); } };
    styleLinkEl.addEventListener('load', finish, { once: true });
    styleLinkEl.addEventListener('error', finish, { once: true });
    setTimeout(finish, 800); // safety net if load/error never fires
  } else {
    setTimeout(triggerPrint, 300);
  }
}

// ============================================================
// QUICK START
// ============================================================
function setupRecipeAgeSwitch() {
  // Delegated: recipe cards are re-rendered on every age change.
  document.getElementById('main').addEventListener('click', e => {
    const btn = e.target.closest('.recipe-age-btn');
    if (!btn) return;
    const age = btn.getAttribute('data-age');
    AppState.setAge(age); // notify → re-renders the recipe and syncs the Tools panel
    if (typeof window.syncAgeUI === 'function') window.syncAgeUI(age);
    const again = document.querySelector(`.recipe-age-btn[data-age="${age}"]`);
    if (again) again.focus();
  });
}

function setupQuickStart() {
  // Delegated to #main: the home page is re-rendered (e.g. after recipes.json
  // loads), which replaces the card elements. Per-card listeners bound once at
  // startup were lost on that re-render, leaving every home card inert.
  const main = document.getElementById('main');
  function activate(card) {
    const nav = card.getAttribute('data-nav');
    if (nav === 'tonight') { renderTonight(); scrollToTop(); return; }
    if (nav === 'emergency') { renderEmergency(); return; }
    if (nav === 'recipes') { renderRecipeList('all'); return; }
    const targetId = getSectionIdForNav(nav);
    if (!targetId) {
      main.innerHTML = renderEmptyCategory(nav);
      return;
    }
    AppState.setSection(targetId);
    AppState.resetSearch();
    document.getElementById("global-search").value = "";
    AppState.setCategory("all");
    document.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("active"));
    document.querySelector('.cat-btn[data-cat="all"]').classList.add("active");
    renderNav();
    renderMain();
    scrollToTop();
    syncHash();
    if (isMobile()) closeSidebar();
    updateMobileNav(targetId);
  }
  main.addEventListener('click', e => {
    const card = e.target.closest('.quick-start-card');
    if (card && main.contains(card)) activate(card);
  });
  main.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.quick-start-card');
    if (card && main.contains(card)) { e.preventDefault(); activate(card); }
  });
}

// ============================================================
// MOBILE NAV
// ============================================================
function setupMobileNav() {
  document.querySelectorAll('.mobile-bottom-nav .nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const nav = btn.getAttribute('data-nav');
      if (nav === 'tools') {
        openTools();
        return;
      }
      if (nav === 'browse') {
        openSidebar();
        return;
      }
      if (nav === 'grocery') {
        openGroceryPanel();
        return;
      }
      if (nav === 'recipes') {
        renderRecipeList();
        if (isMobile() && document.getElementById("dashboard").classList.contains("open")) closeTools();
        return;
      }
      const targetId = getSectionIdForNav(nav);
      if (!targetId) {
        document.getElementById("main").innerHTML = renderEmptyCategory(nav);
        return;
      }
      AppState.setSection(targetId);
      AppState.resetSearch();
      document.getElementById("global-search").value = "";

      if (nav === 'recipes') {
        AppState.setCategory("all");
        document.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("active"));
        document.querySelector('.cat-btn[data-cat="all"]').classList.add("active");
      }

      renderNav();
      renderMain();
      document.getElementById("main").scrollTop = 0;
      syncHash();
      updateMobileNav(targetId);

      if (isMobile() && document.getElementById("dashboard").classList.contains("open")) {
        closeTools();
      }
    });
  });
}

// ============================================================
// STATE SUBSCRIPTION
// ============================================================
AppState.subscribe((changes) => {
  if (changes.type === 'grocery') renderGrocery();
  if (changes.type === 'checklist') renderChecklist();
  if (changes.type === 'allergenFilter') {
    syncAllergenChips();
    renderNav();
    if (isRecipeListShowing()) renderRecipeList();
    const q = AppState.getState().query;
    if (q && q.length >= 2) renderSearchResults(q); // keep an open results page in step with the filters
  }
  if (changes.type === 'favorites') {
    renderNav();
    if (isRecipeListShowing()) { renderRecipeList(); return; }
    const state = AppState.getState();
    const sec = appData.sections.find(s => s.id === state.sectionId);
    if (sec && isRecipe(sec)) renderMain();
  }
  if (changes.type === 'section') {
    renderMain();
    syncHash();
    // Move focus to the new content for keyboard/screen-reader users. Only
    // done here (on an actual section change), not on every renderMain()
    // call elsewhere, so typing in search or toggling a filter doesn't
    // steal focus away from the control being used.
    const main = document.getElementById('main');
    if (main) main.focus({ preventScroll: false });
  }
  if (changes.type === 'age') {
    const state = AppState.getState();
    if (typeof window.syncAgeUI === 'function') window.syncAgeUI(state.age);
    else {
      const note = document.getElementById("age-note");
      if (note) note.innerHTML = ageCopy[state.age];
    }
    if (isRecipeListShowing()) renderRecipeList();
    else {
      const sec = appData.sections.find(s => s.id === state.sectionId);
      if (sec && isRecipe(sec) && document.querySelector('#main .recipe-card')) renderMain();
    }
  }
  if (changes.type === 'household') {
    // Re-render, then put focus back on the same −/+ button so a keyboard or
    // screen-reader user can keep adjusting.
    const a = document.activeElement;
    const hh = a && a.classList && a.classList.contains('hh-btn') ? { age: a.dataset.hh, d: a.dataset.d, inPanel: !!a.closest('#household-panel') } : null;
    renderHouseholdPanel();
    if (isRecipeListShowing()) renderRecipeList();
    else if (document.querySelector('#main .recipe-card')) renderMain();
    if (hh) {
      const root = hh.inPanel ? document.getElementById('household-panel') : document.getElementById('main');
      const again = root && (root.querySelector(`.hh-btn[data-hh="${hh.age}"][data-d="${hh.d}"]:not([disabled])`) || root.querySelector(`.hh-btn[data-hh="${hh.age}"]:not([disabled])`));
      if (again) again.focus();
    }
  }
});

// ============================================================
// INIT
// ============================================================
document.addEventListener("DOMContentLoaded", async () => {
  // Restore age selection from localStorage
  const savedAge = normalizeAge(safeStorageGet('roots_age'));
  if (savedAge) {
    document.querySelectorAll('.age-tab').forEach(tab => {
      tab.classList.toggle('active', tab.getAttribute('data-age') === savedAge);
    });
    document.getElementById("age-note").innerHTML = ageCopy[savedAge];
  }

  // Phase 2: recipes are fetched at runtime from ./recipes.json rather than
  // embedded in this file. Load them before the first render so recipe
  // sections are present in appData.sections and RECIPES from the start.
  try {
    await loadRecipes();
  } catch (e) {
    console.error('[Roots] Could not load recipes.json:', e);
    const banner = document.getElementById('data-load-error');
    if (banner) {
      banner.hidden = false;
      banner.classList.add('visible');
    }
  }

  renderNav();
  renderMain();
  renderMeals();
  renderChecklist();
  renderGrocery();
  setupQuickStart();
  setupRecipeAgeSwitch();
  setupRecipeList();
  renderHouseholdPanel();
  document.addEventListener('click', e => {
    const b = e.target.closest('.hh-btn');
    if (b && !b.disabled) AppState.changeHousehold(b.dataset.hh, Number(b.dataset.d));
  });
  if (window.matchMedia('(max-width: 480px)').matches) {
    const gs = document.getElementById('global-search');
    if (gs) gs.placeholder = 'Search';
  }
  setupMobileNav();
  syncSidebarAT(); // initial state: closed drawer hidden from AT on mobile
  setupAllergenFilters();
  syncAllergenChips();

  let searchTimer = null;
  const searchInput = document.getElementById("global-search");
  searchInput.addEventListener("input", e => {
    const value = e.target.value;
    AppState.setQuery(value.trim());
    renderNav();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (value.trim().length >= 2) renderSearchResults(value);
      else if (!value.trim()) renderMain(); // cleared: back to the page you were on
    }, 150);
  });
  searchInput.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(searchTimer);
      if (e.target.value.trim()) {
        renderSearchResults(e.target.value);
        e.target.blur(); // closes the phone keyboard so results are visible
      }
    }
    if (e.key === "Escape" && e.target.value) {
      e.target.value = "";
      AppState.resetSearch();
      renderNav();
      renderMain();
    }
  });

  document.querySelectorAll(".cat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const cat = btn.getAttribute("data-cat");
      AppState.setCategory(cat);
      AppState.resetSearch();
      document.getElementById("global-search").value = "";
      const firstId = getFirstSectionIdForCategory(cat);
      if (!firstId) {
        document.getElementById("main").innerHTML = renderEmptyCategory(cat);
        return;
      }
      AppState.setSection(firstId);
      renderNav();
      renderMain();
      document.getElementById("main").scrollTop = 0;
      syncHash();
      updateMobileNav(firstId);
      if (isMobile()) closeSidebar();
    });
  });

  function syncAgeUI(age) {
    document.querySelectorAll(".age-tab").forEach(t => {
      const on = t.getAttribute("data-age") === age;
      t.classList.toggle("active", on);
    });
    document.querySelectorAll(".header-age-btn").forEach(t => {
      const on = t.getAttribute("data-age") === age;
      t.classList.toggle("active", on);
      t.setAttribute("aria-pressed", on ? "true" : "false");
    });
    const note = document.getElementById("age-note");
    if (note && typeof ageCopy !== "undefined" && ageCopy[age]) {
      note.innerHTML = ageCopy[age];
    }
  }
  window.syncAgeUI = syncAgeUI;
  function setAgeFromUI(age) {
    AppState.setAge(age);
    syncAgeUI(age);
  }
  document.querySelectorAll(".age-tab").forEach(tab => {
    tab.addEventListener("click", () => setAgeFromUI(tab.getAttribute("data-age")));
  });
  document.querySelectorAll(".header-age-btn").forEach(btn => {
    btn.addEventListener("click", () => setAgeFromUI(btn.getAttribute("data-age")));
  });
  // Reflect saved age on both header and tools panel
  syncAgeUI(AppState.getState().age || "family");

  document.getElementById("toggle-tools").addEventListener("click", toggleTools);
  document.getElementById("close-tools").addEventListener("click", closeTools);
  document.getElementById("close-sidebar").addEventListener("click", closeSidebar);

  const updateRefreshBtn = document.getElementById("update-refresh");
  if (updateRefreshBtn) updateRefreshBtn.addEventListener("click", () => window.location.reload());

  document.getElementById("backdrop").addEventListener("click", () => {
    closeTools();
    closeSidebar();
    closeGroceryPanel();
    FocusManager.releaseAll();
  });

  document.getElementById("print-btn").addEventListener("click", printCurrentView);
  document.getElementById('toggle-tonight').addEventListener('click', () => { renderTonight(); scrollToTop(); });
  document.getElementById('close-cooking').addEventListener('click', closeCookingMode);
  document.getElementById('cooking-overlay').addEventListener('click', e => { if (e.target.id === 'cooking-overlay') closeCookingMode(); });
  document.getElementById("toggle-grocery").addEventListener("click", toggleGroceryPanel);
  document.getElementById("close-grocery").addEventListener("click", closeGroceryPanel);

  document.getElementById("grocery-check-all").addEventListener("click", () => {
    AppState.setAllGroceryChecked(true);
    renderGrocery();
  });
  document.getElementById("grocery-uncheck-all").addEventListener("click", () => {
    AppState.setAllGroceryChecked(false);
    renderGrocery();
  });
  document.getElementById('grocery-copy').addEventListener('click', copyGroceryList);
  document.getElementById("grocery-clear").addEventListener("click", () => {
    if (confirm('Clear all items from your grocery list?')) {
      AppState.clearGrocery();
      renderGrocery();
    }
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      // Close only the topmost overlay, one per keypress (standard dialog
      // behaviour): cooking mode sits above everything, then the grocery
      // panel, then the mobile Tools / Contents drawers. Closing everything at
      // once would also drop the focus trap and scroll lock of overlays that
      // are still meant to be open underneath.
      const isOpen = id => document.getElementById(id).classList.contains('open');
      if (isOpen('cooking-overlay')) closeCookingMode();
      else if (isOpen('grocery-panel')) closeGroceryPanel();
      else if (isMobile() && isOpen('dashboard')) closeTools();
      else if (isMobile() && document.body.classList.contains('mobile-browse-open')) closeSidebar();
      else FocusManager.releaseAll(); // nothing open: safety net only
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "f") {
      e.preventDefault();
      document.getElementById("global-search").focus();
    }
  });

  window.addEventListener("resize", () => {
    if (!isMobile()) {
      const dash = document.getElementById("dashboard");
      // The dashboard may have been opened as a mobile modal (trapped
      // focus, locked scroll, aria-modal="true") before the viewport
      // crossed the breakpoint. Clear all of that state explicitly, gated
      // on whether it actually held the lock, rather than resetting the
      // shared backdrop/scroll-lock unconditionally (which could clobber
      // a different overlay, e.g. an open grocery panel, that's also
      // using them).
      const wasOpen = dash.classList.contains("open");
      if (wasOpen) {
        FocusManager.release(dash); // also sets aria-modal="false"
        OverlayLock.release();
      }
      dash.classList.remove("open");
      dash.removeAttribute("aria-modal");
      dash.removeAttribute("role");
      closeSidebar(); // no-op on the shared lock if the sidebar wasn't open
    }
    syncSidebarAT(); // both directions: crossing into mobile hides the closed drawer from AT
  });

  const openFullPlan = document.getElementById("open-full-plan");
  if (openFullPlan) openFullPlan.addEventListener("click", () => {
    AppState.setSection("planner");
    AppState.resetSearch();
    document.getElementById("global-search").value = "";
    renderNav();
    renderMain();
    syncHash();
    scrollToTop();
    if (isMobile()) closeTools();
  });

  // Views that aren't book sections but can be opened by link — used by the
  // home-screen shortcuts in manifest.webmanifest (#tonight, #emergency,
  // #grocery). Returns true when the hash was one of these.
  function openViewFromHash(id) {
    if (id === 'tonight') { renderTonight(); scrollToTop(); return true; }
    if (id === 'emergency') { renderEmergency(); return true; }
    if (id === 'grocery') { openGroceryPanel(); return true; }
    if (id === 'recipes') { renderRecipeList(); return true; }
    return false;
  }

  const hash = window.location.hash.replace('#', '');
  if (hash) {
    const section = appData.sections.find(s => s.id === hash);
    if (section) {
      AppState.setSection(hash);
      renderNav();
      renderMain();
    } else {
      openViewFromHash(hash);
    }
  }

  window.addEventListener("hashchange", () => {
    const id = window.location.hash.replace(/^#/, "");
    if (openViewFromHash(id)) return;
    if (!appData.sections.some(s => s.id === id)) return;
    AppState.setSection(id);
    renderNav();
    renderMain();
    scrollToTop();
  });

  if (!window.location.hash) syncHash();
  // A deep link (#rec-14, #recipes) should open at the top of the page,
  // not with its first lines tucked under the sticky header.
  requestAnimationFrame(() => scrollToTop());

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then((registration) => {
      setInterval(() => { registration.update(); }, 60 * 60 * 1000);
    });
  }
});
