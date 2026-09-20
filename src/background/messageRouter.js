/**
 * runtime.onMessage dispatcher. Every handler returns a JSON-serialisable object; errors are
 * caught and returned as { error } so UI pages never hang on a rejected promise.
 */
export function createMessageRouter(handlers) {
  return (message, sender) => {
    const type = message?.type;
    const handler = handlers[type];
    if (!handler) return Promise.resolve({ error: `Unknown message type: ${type}` });
    return Promise.resolve()
      .then(() => handler(message.payload ?? {}, sender))
      .then((result) => (result === undefined ? { ok: true } : result))
      .catch((e) => {
        console.warn(`[GoalGuard] handler "${type}" failed`, e);
        return { error: String(e?.message ?? e) };
      });
  };
}
