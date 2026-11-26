// Keep the render/transport window bounded; history remains in the session and persistence layers.
export const CHAT_MESSAGE_LIMIT = 20;
/** Scrolling up grows the window in CHAT_MESSAGE_LIMIT steps up to this many messages (the service's
 *  view cap); only beyond it does the transcript page and drop its newest messages. */
export const CHAT_HISTORY_LIMIT = 200;
export function messageWindow<T extends { id?: string; key?: string }>(messages: T[], limit: number, before?: string) {
  const boundary = before ? messages.findIndex(message => (message.id || message.key) === before) : -1;
  const end = boundary >= 0 ? boundary : messages.length;
  const start = Math.max(0, end - limit);
  return { messages: messages.slice(start, end), hasLoadedOlder: start > 0, hasNewer: end < messages.length };
}
