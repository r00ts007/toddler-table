// ============================================================
// PAGE-TO-PAGE READING FLOW (2026-10-19)
// ============================================================
// Reaching the end of a page used to mean going back to Home or Contents to
// find the next one. This adds Previous / Next links at the foot of every
// guide page and recipe card, so a parent can read straight through.
//
//   • Guide pages follow Contents order (appData.sections without recipes):
//     Cover → One Table · Three Ages → … → References. The last guide page
//     leads into the Recipes list.
//   • Recipes follow recipe-number order. If the Recipes list was last
//     narrowed to a group (Dinner, Emergency & no-cook, Favorites…) and the
//     open recipe is in it, Next stays inside that group. The allergen and
//     plant-based filters are respected, so Next never offers a recipe the
//     parent has filtered out.
//
// Kept in its own file so app_bundle.js stays byte-identical to the deployed
// build: it wraps renderMain() instead of editing it. Fold it into the
// render functions in app_bundle.js on the next full app pass.
(function () {
  'use strict';
  if (typeof renderMain !== 'function' || typeof AppState === 'undefined' || typeof appData === 'undefined') return;

  const GROUP_NAMES = {
    breakfast: 'Breakfast recipes',
    lunch: 'Lunch recipes',
    dinner: 'Dinner recipes',
    snack: 'Snack recipes',
    foundation: 'Foundation recipes',
    emergency: 'Emergency & no-cook recipes',
    favorites: 'Favorite recipes'
  };

  function recipeNumber(r) {
    return parseInt(String(r.id).replace(/\D/g, ''), 10) || 0;
  }

  function guideSequence() {
    return appData.sections.filter(s => !isRecipe(s));
  }

  // The recipes Next/Previous should step through, given where the parent
  // came from. The open recipe always stays in the list (it may have been
  // opened from search while a filter would hide it) so it has a position.
  function recipeSequence(current) {
    const st = AppState.getState();
    const excluded = st.excludedAllergens || [];
    const plantOnly = !!st.plantOnly;
    const favs = AppState.getFavorites();
    const group = typeof recipeListFilter === 'string' ? recipeListFilter : 'all';
    const inGroup = r => {
      if (group === 'emergency') return EMERGENCY_IDS.includes(r.id);
      if (group === 'favorites') return favs.includes(r.id);
      return group === 'all' || r.category === group;
    };
    const keep = r => r.id === current.id || passesDietFilters(r, excluded, plantOnly);
    const all = RECIPES.slice().sort((a, b) => recipeNumber(a) - recipeNumber(b));
    const filtersOn = excluded.length > 0 || plantOnly;
    if (group !== 'all' && inGroup(current)) {
      return { items: all.filter(r => inGroup(r) && keep(r)), group, filtersOn };
    }
    return { items: all.filter(keep), group: 'all', filtersOn };
  }

  // "Back to …" links return to a list, so the Next slot doesn't get a
  // forward arrow when it holds one (end of the recipes).
  function linkHTML(dir, label, title, attr) {
    const toAList = attr.indexOf('data-pager-list') === 0 && label === 'Back to';
    const arrowL = dir === 'prev' ? '‹ ' : '';
    const arrowR = dir === 'next' && !toAList ? ' ›' : '';
    return `<button type="button" class="pager-link pager-${dir}" ${attr}>` +
      `<span class="pager-dir">${arrowL}${DOM.escape(label)}${arrowR}</span>` +
      `<span class="pager-title">${DOM.escape(title)}</span></button>`;
  }
  const toSection = id => `data-pager-id="${DOM.escapeAttr(id)}"`;
  const toList = group => `data-pager-list="${DOM.escapeAttr(group)}"`;

  function pagerHTML(sec) {
    let prev = '', next = '', pos = '';
    if (isRecipe(sec)) {
      const { items, group, filtersOn } = recipeSequence(sec);
      const i = items.findIndex(r => r.id === sec.id);
      const listName = group === 'all' ? 'All recipes' : GROUP_NAMES[group] || 'All recipes';
      prev = i > 0
        ? linkHTML('prev', 'Previous recipe', items[i - 1].title, toSection(items[i - 1].id))
        : linkHTML('prev', 'Back to', listName, toList(group));
      next = i < items.length - 1
        ? linkHTML('next', 'Next recipe', items[i + 1].title, toSection(items[i + 1].id))
        : linkHTML('next', 'Back to', listName, toList(group));
      pos = `${group === 'all' ? 'Recipe' : listName + ' ·'} ${i + 1} of ${items.length}${filtersOn ? ' (your filters are on)' : ''}`;
    } else {
      const seq = guideSequence();
      const i = seq.findIndex(s => s.id === sec.id);
      if (i < 0) return '';
      if (i > 0) prev = linkHTML('prev', 'Previous', seq[i - 1].title, toSection(seq[i - 1].id));
      next = i < seq.length - 1
        ? linkHTML('next', 'Next', seq[i + 1].title, toSection(seq[i + 1].id))
        : linkHTML('next', 'Next', '🍳 Recipes', toList('all'));
      pos = `Page ${i + 1} of ${seq.length}`;
    }
    return `<nav class="page-pager no-print" aria-label="Page navigation">` +
      `<p class="pager-pos">${DOM.escape(pos)}</p>` +
      `<div class="pager-links">${prev}${next}</div></nav>`;
  }

  function appendPager() {
    const main = document.getElementById('main');
    if (!main) return;
    const sec = appData.sections.find(s => s.id === AppState.getState().sectionId);
    if (!sec) return;
    const html = pagerHTML(sec);
    if (html) main.insertAdjacentHTML('beforeend', html);
  }

  // renderMain() is called from many places (section change, age change,
  // favorites, household). Wrapping it keeps the pager on every redraw.
  const baseRenderMain = renderMain;
  renderMain = function () {
    const result = baseRenderMain.apply(this, arguments);
    try { appendPager(); } catch (e) { console.error('[Roots] page navigation:', e); }
    return result;
  };

  function goTo(id) {
    // setSection notifies the app: it re-renders #main, updates the
    // address bar and moves focus to the new page for screen readers.
    AppState.setSection(id);
    renderNav();
    scrollToTop();
  }

  // Delegated, because #main is re-rendered constantly.
  document.addEventListener('click', e => {
    const btn = e.target.closest('.page-pager [data-pager-id], .page-pager [data-pager-list]');
    if (!btn) return;
    if (btn.dataset.pagerList) renderRecipeList(btn.dataset.pagerList);
    else goTo(btn.dataset.pagerId);
  });

  const css = `
.page-pager { margin: 28px 0 8px; padding-top: 14px; border-top: 1px solid var(--rule); }
.pager-pos { margin: 0 0 10px; text-align: center; font: 600 13px Arial, Helvetica, sans-serif; color: var(--muted); }
.pager-links { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.pager-link {
  display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
  min-height: 56px; padding: 10px 14px; text-align: left;
  border: 1px solid var(--rule); border-radius: var(--radius);
  background: #fff; color: var(--ink); box-shadow: var(--card-shadow);
}
.pager-link:hover { background: var(--soft2); }
.pager-link:focus-visible { outline: 3px solid var(--accent-light); outline-offset: 2px; }
.pager-next { grid-column: 2; align-items: flex-end; text-align: right; background: var(--accent); border-color: var(--accent); }
.pager-next:hover { background: var(--accent-light); }
.pager-dir { font: 700 12px Arial, Helvetica, sans-serif; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.pager-title { font: 700 15px Arial, Helvetica, sans-serif; color: var(--accent); }
.pager-next .pager-dir, .pager-next .pager-title { color: #fff; }
@media (max-width: 480px) {
  .pager-links { grid-template-columns: 1fr; }
  .pager-next { grid-column: auto; }
}
@media print { .page-pager { display: none !important; } }
`;
  const style = document.createElement('style');
  style.id = 'page-pager-styles';
  style.textContent = css;
  document.head.appendChild(style);
})();
