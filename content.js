// Wrap the whole file in an IIFE so it can be re-injected by the popup when
// the manifest-injected content script becomes orphaned (e.g. after reloading
// the extension on an already-open tab). Without the IIFE, the second
// injection would throw on the top-level `const` redeclaration. Inside, each
// injection gets a fresh function scope; the old IIFE's locals get GC'd.
(function () {

// Long-running timer registry. Persisted on `window` (not just IIFE-local) so
// a fresh injection can clear timers leaked by the previous orphaned content
// script — which is the source of the "page gets slower over time" symptom.
const byebooksIntervals = window.__byebooks_intervals || new Map();
window.__byebooks_intervals = byebooksIntervals;
function setNamedInterval(name, fn, ms) {
    const prev = byebooksIntervals.get(name);
    if (prev !== undefined) clearInterval(prev);
    const id = setInterval(fn, ms);
    byebooksIntervals.set(name, id);
    return id;
}

function stopAll() {
    for (const id of byebooksIntervals.values()) {
        clearInterval(id);
    }
    byebooksIntervals.clear();
}

function solveAll() {
    solveAnimations();
    solveMultipleChoice();
    solveShortAnswer();
    solveMatch();
    solveBlocks();
}

function nextPage() {
    let nextBtn = document.getElementsByClassName('nav-text next');
    if (nextBtn.length > 0) {
        nextBtn[0].click();
    }
}

function getStatus() {
    let status = document.querySelectorAll('div.activity-title-bar > div.activity-description > div.title-bar-chevron-container > div');
    let res = true;
    for (const s of status) {
        let question = s.parentElement.parentElement.parentElement.parentElement;
        try
        {
            if (question.children[1].children[1].children[1].className.includes('draggable')) 
                continue;
        }
        catch (e) {}
        if (s.ariaLabel != 'Activity completed') {
            res = false;
            break;
        }
    }
    return res;
}

function enableDoubleSpeed() {
    // The 2x toggle is a checkbox, not a button: <input type="checkbox" class="zb-checkbox-input">
    // inside .speed-control, with the visible "2x speed" text living in a sibling <label>.
    // The previous selector `[aria-label="2x speed"]` matched nothing because the input uses
    // aria-labelledby, not aria-label.
    for (const cb of document.querySelectorAll('.speed-control input.zb-checkbox-input')) {
        if (cb.dataset.byebooksDoubled === '1') continue;
        if (!cb.checked) cb.click();
        cb.dataset.byebooksDoubled = '1';
    }
}

function solveAnimations() {
    enableDoubleSpeed();
    for (const startBtn of document.getElementsByClassName("start-button"))
        startBtn.click();

    setNamedInterval('animations', function () {
        // Re-apply on every tick: animation widgets sometimes mount lazily after
        // solveAnimations is first invoked, and new pages render new checkboxes.
        enableDoubleSpeed();
        if (document.getElementsByClassName("play-button").length > 0) {
            let playBtns = document.getElementsByClassName('play-button')
            for (let i = 0; i < playBtns.length; i++) {
                if (!playBtns[i]
                    .className
                    .replace(/\s+/g, ' ')
                    .split(' ')
                    .includes('rotate-180')) {
                    playBtns[i].click();
                }
            }
        }
    }, 1500);
}

function mcqQuestionCompleted(q) {
    // Question chevron flips to "Question completed" on a correct answer and
    // stays sticky, so it's also the gate for "should we touch this at all".
    const chev = q.querySelector('.question-chevron');
    return !!chev && chev.getAttribute('aria-label') === 'Question completed';
}

async function solveMultipleChoiceQuestion(q) {
    if (mcqQuestionCompleted(q)) return;
    // Participation-mode MCQs credit on any selection. No need to chase the
    // correct answer — pick the first option and move on.
    const radio = q.querySelector('input[type=radio]');
    if (radio) radio.click();
    // Pace within the framework's ~250ms submission queue debounce so rapid
    // multi-question pages don't have responses coalesced.
    await delay(150);
}

async function solveMultipleChoice() {
    const questions = document.querySelectorAll('.multiple-choice-question');
    for (const q of questions) {
        try {
            await solveMultipleChoiceQuestion(q);
        } catch (e) {
            console.warn('[ByeBooks] multiple choice failed:', e);
        }
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeout = 4000, interval = 80 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (predicate()) return true;
        await delay(interval);
    }
    return false;
}

function setNativeValue(el, value) {
    // ZyBooks inputs are React-controlled; assigning .value directly is ignored
    // by React's internal value tracker. We must use the native prototype setter
    // so React sees a real DOM change and accepts the input event.
    const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
}

function getExplanationState(question) {
    const e = question.querySelector('.zb-explanation');
    if (!e) return 'none';
    if (e.classList.contains('correct')) return 'correct';
    if (e.classList.contains('forfeit')) return 'forfeit';
    if (e.classList.contains('warn')) return 'warn';
    return 'unknown';
}

function isQuestionCompleted(question) {
    const chevron = question.querySelector('.question-chevron');
    if (chevron && chevron.getAttribute('aria-label') === 'Question completed') return true;
    return getExplanationState(question) === 'correct';
}

async function solveShortAnswerQuestion(question) {
    if (isQuestionCompleted(question)) return;

    const showBtn = question.querySelector('.show-answer-button');
    const checkBtn = question.querySelector('.check-button');
    const input = question.querySelector('input.zb-input, textarea.zb-text-area');
    if (!showBtn || !checkBtn || !input) return;

    // Click "Show answer" until the explanation reaches the `forfeit` state
    // (i.e. answer is revealed). Wait for an actual class transition between
    // clicks so the two clicks aren't coalesced into the same tick.
    for (let i = 0; i < 3 && getExplanationState(question) !== 'forfeit'; i++) {
        const before = getExplanationState(question);
        showBtn.click();
        await waitFor(() => {
            const now = getExplanationState(question);
            return now !== before && now !== 'unknown';
        });
        await delay(100);
    }

    const forfeitEl = question.querySelector('.forfeit-answer');
    if (!forfeitEl) return;
    const answer = forfeitEl.textContent.trim();
    if (!answer) return;

    input.focus();
    setNativeValue(input, answer);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await delay(120);
    checkBtn.click();

    await waitFor(() => getExplanationState(question) === 'correct', { timeout: 3000 });
}

async function solveShortAnswer() {
    const questions = document.querySelectorAll('.short-answer-question');
    for (const q of questions) {
        try {
            await solveShortAnswerQuestion(q);
        } catch (err) {
            console.warn('[ByeBooks] short answer failed:', err);
        }
    }
}

// --- Definition match (drag-and-drop) ---
//
// `zb-sortable` is HTML5-native drag-and-drop: locked correct tiles get
// `draggable="false"`, which is the dead giveaway. We drive it by dispatching
// real DragEvents with a shared DataTransfer; coordinates are filled in so
// listeners that gate on clientX/Y still accept the drop.
//
// Strategy: greedy. For each slot in order, try each unplaced bank item until
// the slot's `.definition-match-explanation` flips to `correct`. Wrong drops
// stay put (they don't bounce), so we drag the wrong tile back to the bank
// before trying the next candidate.

function findMatchActivities() {
    return document.querySelectorAll('.definition-match-payload .zb-sortable');
}

function matchBank(sortable) {
    return sortable.querySelector('.zb-sortable-container.term-bank');
}

function matchRows(sortable) {
    return Array.from(sortable.querySelectorAll('.definition-row'));
}

function rowSlot(row) {
    return row.querySelector('.zb-sortable-container.term-bucket');
}

function rowState(row) {
    const e = row.querySelector('.definition-match-explanation');
    if (!e) return 'empty';
    if (e.classList.contains('correct')) return 'correct';
    if (e.classList.contains('incorrect')) return 'incorrect';
    return 'empty';
}

function rowItem(row) {
    const slot = rowSlot(row);
    return slot ? slot.querySelector(':scope > .zb-sortable-item') : null;
}

function bankItems(bank) {
    return Array.from(bank.querySelectorAll(':scope > .zb-sortable-item'));
}

async function dispatchDrag(src, target) {
    // The widget toggles `draggable="true"` only after focus/mousedown — a real
    // drag in the probe showed mousedown → focus → dragstart. Synthetic events
    // skip that priming, so we replay it explicitly and force draggable=true.
    // The trailing delay is generous because the framework debounces submissions
    // at ~250ms (visible as `delay: 250` in its console logs); dropping faster
    // makes it silently coalesce.
    const dt = new DataTransfer();
    const sr = src.getBoundingClientRect();
    const tr = target.getBoundingClientRect();
    const sx = sr.left + sr.width / 2, sy = sr.top + sr.height / 2;
    const tx = tr.left + tr.width / 2, ty = tr.top + tr.height / 2;

    const fireDrag = (el, type, x, y) => {
        el.dispatchEvent(new DragEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            dataTransfer: dt, clientX: x, clientY: y,
        }));
    };
    const firePtr = (el, type, x, y) => {
        el.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            clientX: x, clientY: y, button: 0, buttons: 1, pointerType: 'mouse',
        }));
    };
    const fireMouse = (el, type, x, y) => {
        el.dispatchEvent(new MouseEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            clientX: x, clientY: y, button: 0, buttons: 1,
        }));
    };

    // Force draggable=true. The framework also sets draggable="false" on
    // tiles that aren't really committed (incorrectly-placed and even some
    // bank-resident tiles), so we can't trust that attribute as a "do not
    // touch" signal. The real authority on whether a tile is committed is
    // whether it's in a correct slot — the candidate pool already excludes
    // those, so anything reaching dispatchDrag is fair game.
    //
    // We *don't* restore the previous value afterward: that would clobber a
    // freshly-set draggable="false" lock on tiles the framework legitimately
    // committed via this drop.
    src.setAttribute('draggable', 'true');

    src.focus();
    firePtr(src, 'pointerdown', sx, sy);
    fireMouse(src, 'mousedown', sx, sy);
    await delay(80);

    fireDrag(src, 'dragstart', sx, sy);
    await delay(80);
    fireDrag(target, 'dragenter', tx, ty);
    fireDrag(target, 'dragover', tx, ty);
    await delay(80);
    fireDrag(target, 'drop', tx, ty);
    fireDrag(src, 'dragend', tx, ty);

    firePtr(src, 'pointerup', tx, ty);
    fireMouse(src, 'mouseup', tx, ty);

    // Generous tail to let the framework finish its submission queue (250ms
    // debounce visible in its own logs). Dropping faster causes coalesced
    // submissions where some operations get dropped on the floor.
    await delay(600);
}

async function retryMove(sortable, dataId, target, maxAttempts = 3) {
    for (let i = 0; i < maxAttempts; i++) {
        if (await moveTile(sortable, dataId, target)) return true;
        await delay(400);
    }
    return false;
}

function tileById(sortable, dataId) {
    return sortable.querySelector(`.zb-sortable-item[data-id="${dataId}"]`);
}

async function moveTile(sortable, dataId, target) {
    // Re-query the tile each time: the framework can re-render it across
    // moves, invalidating any element reference we might be holding.
    const tile = tileById(sortable, dataId);
    if (!tile) return false;
    if (tile.parentElement === target) return true;
    await dispatchDrag(tile, target);
    return await waitFor(() => {
        const t = tileById(sortable, dataId);
        return !!t && t.parentElement === target;
    }, { timeout: 2000 });
}

async function solveDefinitionMatch(sortable) {
    const bank = matchBank(sortable);
    if (!bank) return;
    const rows = matchRows(sortable);

    for (let pass = 0; pass < 4; pass++) {
        if (rows.every(r => rowState(r) === 'correct')) break;
        let progressed = false;

        for (const row of rows) {
            if (rowState(row) === 'correct') continue;
            const slot = rowSlot(row);
            if (!slot) continue;

            // Defensive pre-clear: always start the slot empty. If a previous
            // pass or eviction left a wrong tile here, send it back to the
            // bank before trying anything new. Without this, the framework
            // refuses drops onto a populated slot, and we'd burn through
            // candidates without making progress.
            const stuck = rowItem(row);
            if (stuck) {
                if (!await retryMove(sortable, stuck.dataset.id, bank, 3)) continue;
            }

            const triedIds = new Set();
            while (rowState(row) !== 'correct') {
                const candId = bankItems(bank)
                    .map(t => t.dataset.id)
                    .find(id => !triedIds.has(id));
                if (!candId) break;
                triedIds.add(candId);

                if (!await moveTile(sortable, candId, slot)) continue;
                await waitFor(() => rowState(row) !== 'empty', { timeout: 2000 });

                if (rowState(row) === 'correct') { progressed = true; break; }

                // Wrong: evict back to bank with retries. Never park in
                // another slot — that would create a second visible wrong
                // answer and the framework refuses drops on populated slots,
                // cascading into silent drag failures.
                if (!await retryMove(sortable, candId, bank, 3)) break;
            }
        }

        if (!progressed) break;
    }

    const failed = rows.filter(r => rowState(r) !== 'correct').length;
    if (failed > 0) {
        console.warn(`[ByeBooks] match: ${failed} slot(s) could not be solved automatically`);
    }
}

async function solveMatch() {
    for (const s of findMatchActivities()) {
        try {
            await solveDefinitionMatch(s);
        } catch (err) {
            console.warn('[ByeBooks] match activity failed:', err);
        }
    }
}

// --- Block ordering (sequential drag-and-drop) ---
//
// `.block-ordering-pa` activities have an "Unused blocks" source list and an
// "Algorithm trace" target list. The trick: ZyBooks bakes the answer order
// into the `data-block-id` attribute (sequential 0..N-1). So we just drag in
// ascending id order and the framework accepts each. Wrong drops would bounce
// back with `aria-invalid="true"`, but if the id-order theory holds we never
// see that. Same HTML5 DnD plumbing as the match solver — `dispatchDrag` is
// reused. A short retry loop covers silent drag failures from rate limiting.

function findBlockOrderingActivities() {
    return document.querySelectorAll('.block-ordering-pa');
}

function blockOrderingSource(activity) {
    return activity.querySelector('.sortable[data-list-name="unused"]');
}

function blockOrderingTarget(activity) {
    return activity.querySelector('.sortable[data-list-name="used"]');
}

function blockById(activity, id) {
    return activity.querySelector(`.block-container[data-block-id="${id}"]`);
}

async function dispatchClick(el) {
    // Full pointerdown→mousedown→pointerup→mouseup→click sequence on a single
    // element. The widget uses click-to-commit semantics (the
    // `move-above-block` / `move-below-block` overlay divs are click targets),
    // so this is what finalizes a pending move when dispatchDrag stalls.
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const opts = {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, button: 0, view: window,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, buttons: 1, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...opts, buttons: 1 }));
    await delay(30);
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    await delay(150);
}

async function solveBlockOrdering(activity) {
    const source = blockOrderingSource(activity);
    const target = blockOrderingTarget(activity);
    if (!source || !target) return;

    const ids = Array.from(activity.querySelectorAll('.block-container[data-block-id]'))
        .map(b => b.dataset.blockId)
        .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

    for (const id of ids) {
        let block = blockById(activity, id);
        if (!block || block.parentElement === target) continue;

        let placed = false;
        for (let attempt = 0; attempt < 4 && !placed; attempt++) {
            block = blockById(activity, id);
            if (!block) break;
            if (block.parentElement === target) { placed = true; break; }

            await dispatchDrag(block, target);
            placed = await waitFor(() => {
                const b = blockById(activity, id);
                return !!b && b.parentElement === target;
            }, { timeout: 1200 });
            if (placed) break;

            // dispatchDrag selected the block but the drop didn't commit. The
            // widget uses click-to-commit semantics (the move-above/below
            // overlay divs), so a click on the drop zone finalizes a pending
            // move.
            const dropZone = target.querySelector('.move-here') || target;
            await dispatchClick(dropZone);
            placed = await waitFor(() => {
                const b = blockById(activity, id);
                return !!b && b.parentElement === target;
            }, { timeout: 1200 });
        }
    }
}

async function solveBlocks() {
    for (const a of findBlockOrderingActivities()) {
        try {
            await solveBlockOrdering(a);
        } catch (err) {
            console.warn('[ByeBooks] block ordering failed:', err);
        }
    }
}

// --- Page progress ---
//
// Counts the per-activity title-bar chevrons. Each chevron is one activity,
// labeled either "Activity completed" or "Activity not completed". Returns
// the totals for the popup UI and the on-page overlay.
function getPageProgress() {
    const chevrons = document.querySelectorAll('.title-bar-chevron');
    let total = 0, completed = 0;
    for (const c of chevrons) {
        const label = c.getAttribute('aria-label');
        if (label === 'Activity completed') { total++; completed++; }
        else if (label === 'Activity not completed') total++;
    }
    return { total, completed };
}

// --- On-page progress overlay ---
//
// A Shadow-DOM-isolated floating ring in the bottom-right corner of every
// learn.zybooks.com page, showing live activity progress. Always present
// while the content script is loaded (independent of the popup); fades
// itself out when the page has no activities to count.
const OVERLAY_HOST_ID = 'byebooks-overlay-host';

function ensureOverlay() {
    if (document.getElementById(OVERLAY_HOST_ID)) return;
    const host = document.createElement('div');
    host.id = OVERLAY_HOST_ID;
    host.style.cssText = `
        position: fixed !important;
        bottom: 20px !important;
        right: 20px !important;
        width: auto !important;
        height: auto !important;
        z-index: 2147483647 !important;
        margin: 0 !important;
        padding: 0 !important;
        background: transparent !important;
        border: none !important;
        pointer-events: auto !important;
        display: block !important;
    `;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            .ring {
                position: relative;
                width: 64px; height: 64px;
                background: rgba(13, 17, 23, 0.92);
                border: 1px solid rgba(125, 133, 144, 0.18);
                border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
                color: #e6edf3;
                user-select: none;
                box-shadow: 0 4px 18px rgba(0,0,0,0.45);
                -webkit-backdrop-filter: blur(8px);
                backdrop-filter: blur(8px);
                transition: opacity 0.25s, transform 0.15s;
            }
            .ring:hover { transform: scale(1.04); }
            .ring.hidden { opacity: 0; pointer-events: none; transform: scale(0.9); }
            .ring.complete { color: #39d353; }
            .ring.complete .fill { stroke: #39d353 !important; }
            svg { position: absolute; inset: 0; width: 100%; height: 100%; }
            .pct {
                font-family: "JetBrains Mono", "SF Mono", ui-monospace, monospace;
                font-size: 13px;
                font-weight: 600;
                z-index: 1;
                letter-spacing: -0.02em;
            }
        </style>
        <div class="ring" id="ring" title="ByeBooks · page progress">
            <svg viewBox="0 0 64 64">
                <circle cx="32" cy="32" r="28" stroke="rgba(125,133,144,0.25)" stroke-width="3" fill="none"/>
                <circle class="fill" cx="32" cy="32" r="28" stroke="#e6edf3" stroke-width="3" fill="none"
                    stroke-dasharray="175.929" stroke-dashoffset="175.929"
                    transform="rotate(-90 32 32)" stroke-linecap="round"
                    style="transition: stroke-dashoffset 0.4s ease, stroke 0.25s;"/>
            </svg>
            <span class="pct" id="pct">--</span>
        </div>
    `;
    document.documentElement.appendChild(host);
}

function updateOverlay() {
    const host = document.getElementById(OVERLAY_HOST_ID);
    if (!host || !host.shadowRoot) return;
    const ring = host.shadowRoot.getElementById('ring');
    const pct = host.shadowRoot.getElementById('pct');
    const fill = host.shadowRoot.querySelector('.fill');
    if (!ring || !pct || !fill) return;

    const { total, completed } = getPageProgress();
    if (total === 0) {
        ring.classList.add('hidden');
        return;
    }
    ring.classList.remove('hidden');
    const fraction = completed / total;
    const circumference = 2 * Math.PI * 28;
    fill.setAttribute('stroke-dashoffset', circumference * (1 - fraction));
    pct.textContent = Math.round(fraction * 100) + '%';
    ring.classList.toggle('complete', fraction >= 1);
}

// Boot the overlay and keep it fresh. Stored on `window` so a re-injection
// of content.js cleans up the previous instance's interval.
function startOverlay() {
    ensureOverlay();
    updateOverlay();
    if (window.__byebooks_overlayInterval) clearInterval(window.__byebooks_overlayInterval);
    window.__byebooks_overlayInterval = setInterval(() => {
        ensureOverlay();
        updateOverlay();
    }, 600);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startOverlay);
} else {
    startOverlay();
}

chrome.runtime.onMessage.addListener(
    function (request, sender, sendResponse) {
        switch (request.message) {
            case "ping":
                sendResponse({ ok: true });
                break;
            case "getProgress":
                sendResponse(getPageProgress());
                break;
            case "solveAuto":
                solveAll();
                setNamedInterval('autoPager', () => {
                    if (!getStatus()) return;
                    // Throttle advances to once per ~1.2s. Reading-only pages
                    // (no activities → getStatus returns true immediately)
                    // would otherwise cascade through, overwhelming the
                    // framework's submission queue and tripping third-party
                    // MutationObservers.
                    const now = Date.now();
                    if (now - (window.__byebooks_lastAdvance || 0) < 1200) return;
                    window.__byebooks_lastAdvance = now;
                    const prevUrl = location.href;
                    nextPage();
                    // Wait for SPA navigation to actually commit (URL
                    // changes), then a short settle for Ember to render the
                    // new page's activities before running solvers.
                    const navStart = Date.now();
                    const waitForNav = () => {
                        if (location.href !== prevUrl) {
                            setTimeout(() => solveAll(), 400);
                            return;
                        }
                        if (Date.now() - navStart > 3000) {
                            // Stuck (last page, or nextPage didn't take).
                            // Run solveAll anyway in case state changed.
                            solveAll();
                            return;
                        }
                        setTimeout(waitForNav, 80);
                    };
                    waitForNav();
                }, 400);
                break;
            case "solveAll":
                solveAll();
                break;
            case "solveAnimations":
                solveAnimations();
                break;
            case "solveMC":
                solveMultipleChoice();
                break;
            case "solveSA":
                solveShortAnswer();
                break;
            case "solveMatch":
                solveMatch();
                break;
            case "solveBlocks":
                solveBlocks();
                break;
            case "stopAll":
                stopAll();
                break;
        }
    }
);

})();