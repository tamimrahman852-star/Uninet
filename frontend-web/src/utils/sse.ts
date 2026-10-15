export interface SSEMessage {
  event: string;
  data: string;
}

/** Parses a text/event-stream fetch Response into (event, data) messages. */
export async function* readSSE(response: Response): AsyncGenerator<SSEMessage> {
  if (!response.body) throw new Error('Response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        let event = 'message';
        const dataLines: string[] = [];
        for (const line of rawEvent.split('\n')) {
          if (line.startsWith(':')) continue; // comment / heartbeat
          const idx = line.indexOf(':');
          const field = idx === -1 ? line : line.slice(0, idx);
          const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
          if (field === 'event') event = value;
          else if (field === 'data') dataLines.push(value);
        }
        if (dataLines.length > 0) yield { event, data: dataLines.join('\n') };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
