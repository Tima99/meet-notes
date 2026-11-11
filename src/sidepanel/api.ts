import { isResult, type PanelRequest, type PanelResponseMap } from '../shared/messages';

/** Typed request to the service worker; throws with the background's error message. */
export async function request<T extends PanelRequest['type']>(
  message: Extract<PanelRequest, { type: T }>,
): Promise<PanelResponseMap[T]> {
  const response: unknown = await chrome.runtime.sendMessage(message);
  if (!isResult(response)) throw new Error('MeetNotes background did not respond.');
  if (!response.ok) throw new Error(response.error);
  return response.data as PanelResponseMap[T];
}
