/**
 * The full-screen `#loading` overlay from `index.html`.
 *
 * Startup is not instant on a hosted build: the demo project bundle is a few
 * megabytes, the renderer has to initialise a GPU pipeline, and the song has to
 * be decoded before the first frame. This keeps the overlay honest about which
 * of those is happening, and turns a startup failure into a readable message
 * instead of a permanently black page.
 */

const overlay = (): HTMLElement | null => document.getElementById('loading');

const formatMegabytes = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

/** Replace the overlay text. No-op once the overlay has been dismissed. */
export function setBootStatus(message: string): void {
  const element = overlay();
  if (element === null || element.hidden) return;
  element.textContent = message;
}

/** Overlay text with a download percentage, e.g. `Loading demo project 43%`. */
function setBootProgress(label: string, receivedBytes: number, totalBytes: number): void {
  if (totalBytes <= 0) {
    setBootStatus(`${label}…`);
    return;
  }
  const ratio = Math.min(1, receivedBytes / totalBytes);
  setBootStatus(
    `${label} ${Math.round(ratio * 100)}% · ${formatMegabytes(receivedBytes)} / ${formatMegabytes(totalBytes)} MB`,
  );
}

/**
 * Show a startup error in place of the spinner text. Keeps the overlay visible
 * so the message is actually readable.
 */
export function bootFailed(summary: string, detail?: unknown): void {
  const element = overlay();
  if (element === null || element.hidden) return;
  const reason = detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : '';
  element.textContent = '';
  element.dataset.state = 'error';

  const heading = document.createElement('strong');
  heading.textContent = summary;
  element.append(heading);

  if (reason !== '') {
    const body = document.createElement('span');
    body.textContent = reason;
    element.append(body);
  }
}

/**
 * Read a response body, reporting progress when the server sends a length.
 *
 * `Content-Length` is present for GitHub Pages static files, so a first visit
 * can show a real percentage. Without it (chunked responses, dev server
 * middleware) this falls back to a single `arrayBuffer()` read.
 */
export async function readWithProgress(
  response: Response,
  label: string,
): Promise<Uint8Array> {
  const total = Number(response.headers.get('content-length') ?? 0);
  if (response.body === null || !Number.isFinite(total) || total <= 0) {
    return new Uint8Array(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    setBootProgress(label, received, total);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
