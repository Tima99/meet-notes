/** Toolbar badge: the always-visible "capture is active" signal for a tab. */
export async function setCaptureBadge(tabId: number, capturing: boolean): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: capturing ? 'REC' : '' });
    if (capturing) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93025' });
    await chrome.action.setTitle({ tabId, title: capturing ? 'MeetNotes — saving captions' : 'MeetNotes' });
  } catch {
    // Tab may have closed in the meantime; nothing to update.
  }
}
