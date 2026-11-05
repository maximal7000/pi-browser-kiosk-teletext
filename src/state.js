// Persisted display state: what is shown, zoom, black, and saved pages.
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const FIRST_NUMBER = 101;
const LAST_NUMBER = 199;

export function validateUrl(input) {
  const message = 'Bitte eine Adresse mit http:// oder https:// eingeben.';
  if (typeof input !== 'string') throw new ValidationError(message);
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ValidationError(message);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ValidationError(message);
  return url.href;
}

export function normalizeZoom(z) {
  const n = typeof z === 'number' ? z : Number.NaN;
  const rounded = Math.round(n * 20) / 20;
  if (!Number.isFinite(rounded) || rounded < MIN_ZOOM || rounded > MAX_ZOOM) {
    throw new ValidationError('Zoom muss zwischen 25 % und 300 % liegen.');
  }
  return rounded;
}

function validateName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw new ValidationError('Bitte einen Namen eingeben.');
  if (trimmed.length > 60) throw new ValidationError('Der Name darf höchstens 60 Zeichen lang sein.');
  return trimmed;
}

function validateNumber(number) {
  if (!Number.isInteger(number) || number < FIRST_NUMBER || number > LAST_NUMBER) {
    throw new ValidationError('Seitennummern gehen von 101 bis 199.');
  }
  return number;
}

function emptyState() {
  return { current: { url: null, zoom: 1, pageId: null }, black: false, pages: [] };
}

function notFound() {
  return new ValidationError('Seite nicht gefunden.', 404);
}

async function load(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }
  try {
    const data = JSON.parse(text);
    return { ...emptyState(), ...data, current: { ...emptyState().current, ...data.current } };
  } catch {
    const aside = `${file}.broken-${Date.now()}`;
    await rename(file, aside);
    console.warn(`config file was corrupt, moved to ${aside}`);
    return emptyState();
  }
}

export async function createStore({ file }) {
  let state = await load(file);
  const emitter = new EventEmitter();
  let queue = Promise.resolve();

  const copy = () => structuredClone(state);

  async function persist() {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, file);
  }

  // Every mutation runs on one promise chain so writes never interleave.
  function write(mutate) {
    const run = queue.then(async () => {
      const draft = copy();
      const result = mutate(draft);
      state = draft;
      await persist();
      emitter.emit('change', copy());
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  const findPage = (draft, id) => {
    const page = draft.pages.find((p) => p.id === id);
    if (!page) throw notFound();
    return page;
  };

  return Object.assign(emitter, {
    get: copy,

    show({ url, zoom, pageId } = {}) {
      return write((draft) => {
        if (pageId !== undefined && pageId !== null) {
          const page = findPage(draft, pageId);
          draft.current = { url: page.url, zoom: page.zoom, pageId: page.id };
        } else {
          draft.current = {
            url: validateUrl(url),
            zoom: zoom === undefined ? 1 : normalizeZoom(zoom),
            pageId: null,
          };
        }
        return structuredClone(draft);
      });
    },

    setZoom(z) {
      const zoom = normalizeZoom(z);
      return write((draft) => {
        draft.current.zoom = zoom;
        return structuredClone(draft);
      });
    },

    setBlack(black) {
      if (typeof black !== 'boolean') return Promise.reject(new ValidationError('Ungültiger Wert für Schwarz.'));
      return write((draft) => {
        draft.black = black;
        return structuredClone(draft);
      });
    },

    addPage({ name, url, zoom, number } = {}) {
      return write((draft) => {
        const page = {
          id: randomUUID().slice(0, 8),
          number: 0,
          name: validateName(name),
          url: validateUrl(url),
          zoom: zoom === undefined ? 1 : normalizeZoom(zoom),
        };
        if (number === undefined) {
          const max = Math.max(FIRST_NUMBER - 1, ...draft.pages.map((p) => p.number));
          page.number = validateNumber(max + 1);
        } else {
          page.number = validateNumber(number);
          if (draft.pages.some((p) => p.number === page.number)) {
            throw new ValidationError('Seitennummer ist schon vergeben.');
          }
        }
        draft.pages.push(page);
        draft.pages.sort((a, b) => a.number - b.number);
        return { ...page };
      });
    },

    updatePage(id, patch = {}) {
      return write((draft) => {
        const page = findPage(draft, id);
        if (patch.name !== undefined) page.name = validateName(patch.name);
        if (patch.url !== undefined) page.url = validateUrl(patch.url);
        if (patch.zoom !== undefined) page.zoom = normalizeZoom(patch.zoom);
        if (patch.number !== undefined && patch.number !== page.number) {
          const number = validateNumber(patch.number);
          if (draft.pages.some((p) => p.number === number)) {
            throw new ValidationError('Seitennummer ist schon vergeben.');
          }
          page.number = number;
          draft.pages.sort((a, b) => a.number - b.number);
        }
        return { ...page };
      });
    },

    removePage(id) {
      return write((draft) => {
        findPage(draft, id);
        draft.pages = draft.pages.filter((p) => p.id !== id);
        if (draft.current.pageId === id) draft.current.pageId = null;
      });
    },
  });
}
