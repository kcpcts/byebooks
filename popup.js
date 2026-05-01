// `chrome.tabs.sendMessage` rejects with "Could not establish connection" when
// the content script isn't loaded — typically because the extension was
// reloaded after the tab was opened, leaving the previous content script
// orphaned. We ping first; on failure, programmatically (re-)inject content.js
// and then send the real message. content.js is wrapped in an IIFE so a second
// injection doesn't blow up on redeclarations.
async function send(messageName) {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return;
        try {
            await chrome.tabs.sendMessage(tab.id, { message: 'ping' });
        } catch {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js'],
            });
        }
        await chrome.tabs.sendMessage(tab.id, { message: messageName });
    } catch (e) {
        console.error('[ByeBooks] send failed:', e);
    }
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
});
