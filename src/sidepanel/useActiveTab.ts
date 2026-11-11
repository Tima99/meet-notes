import { useEffect, useState } from 'react';

/** ID of the active tab in the window hosting this side panel. */
export function useActiveTab(): number | null {
  const [tabId, setTabId] = useState<number | null>(null);

  useEffect(() => {
    const refresh = (): void => {
      chrome.tabs
        .query({ active: true, currentWindow: true })
        .then(([tab]) => setTabId(tab?.id ?? null))
        .catch(() => setTabId(null));
    };
    refresh();
    chrome.tabs.onActivated.addListener(refresh);
    chrome.windows.onFocusChanged.addListener(refresh);
    return () => {
      chrome.tabs.onActivated.removeListener(refresh);
      chrome.windows.onFocusChanged.removeListener(refresh);
    };
  }, []);

  return tabId;
}
