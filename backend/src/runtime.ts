/**
 * Workers' fetch checks its receiver. `const send = fetch; send(url)` throws
 * "Illegal invocation" before any request is sent. Call the global directly.
 */
export function resolveFetch(fetchImpl?: typeof fetch): typeof fetch {
  if (fetchImpl) return fetchImpl;
  return (input, init) => fetch(input, init);
}
