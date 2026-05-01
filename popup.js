// `chrome.tabs.sendMessage` rejects with "Could not establish connection" when
// the content script isn't loaded — typically because the extension was
// reloaded after the tab was opened, leaving the previous content script
// orphaned. We ping first; on failure, programmatically (re-)inject content.js
// and then send the real message. content.js is wrapped in an IIFE so a second
// injection doesn't blow up on redeclarations.
async function send(messageName) {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return null;
        try {
            await chrome.tabs.sendMessage(tab.id, { message: 'ping' });
        } catch {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js'],
            });
        }
        return await chrome.tabs.sendMessage(tab.id, { message: messageName });
    } catch (e) {
        console.error('[ByeBooks] send failed:', e);
        return null;
    }
}

const RING_CIRCUMFERENCE = 2 * Math.PI * 13; // r=13 on the popup ring

function renderProgress(data) {
    const ringFill = document.getElementById('ringFill');
    const ring = document.getElementById('progressRing');
    const pctEl = document.getElementById('progressPct');
    const status = document.getElementById('status');
    const statusText = document.getElementById('statusText');
    if (!ringFill || !ring || !pctEl || !status || !statusText) return;

    if (!data || typeof data.total !== 'number') {
        ringFill.setAttribute('stroke-dashoffset', RING_CIRCUMFERENCE);
        pctEl.textContent = '--';
        ring.classList.remove('complete');
        status.classList.remove('live');
        statusText.textContent = 'no page detected';
        return;
    }

    const { total, completed } = data;
    if (total === 0) {
        ringFill.setAttribute('stroke-dashoffset', RING_CIRCUMFERENCE);
        pctEl.textContent = '--';
        ring.classList.remove('complete');
        status.classList.remove('live');
        statusText.textContent = 'no activities on this page';
        return;
    }

    const fraction = completed / total;
    const pct = Math.round(fraction * 100);
    ringFill.setAttribute('stroke-dashoffset', RING_CIRCUMFERENCE * (1 - fraction));
    pctEl.textContent = pct + '%';
    ring.classList.toggle('complete', fraction >= 1);

    status.classList.add('live');
    statusText.textContent = fraction >= 1
        ? `complete · ${completed}/${total} activities`
        : `${completed}/${total} activities · ${total - completed} remaining`;
}

async function refreshProgress() {
    renderProgress(await send('getProgress'));
}

document.addEventListener('DOMContentLoaded', function () {
    const buttons = [
        'solveAuto',
        'solveAll',
        'solveAnimations',
        'solveMC',
        'solveSA',
        'solveMatch',
        'solveBlocks',
        'stopAll',
    ];
    for (const id of buttons) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', () => send(id));
    }

    refreshProgress();
    // Poll while the popup is open. Implicitly cleared when popup closes.
    setInterval(refreshProgress, 700);
});
