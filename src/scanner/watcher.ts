import { watch } from 'node:fs/promises';

export function startFileWatcher(file: string, onChange: () => void): () => void {
  const ac = new AbortController();

  void (async () => {
    while (!ac.signal.aborted) {
      try {
        const watcher = watch(file, { persistent: true, signal: ac.signal });
        for await (const _ of watcher) {
          if (ac.signal.aborted) return;
          onChange();
        }
      } catch (e: any) {
        if (ac.signal.aborted) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  })();

  return () => ac.abort();
}
