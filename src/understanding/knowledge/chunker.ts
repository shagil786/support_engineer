/**
 * Semantic chunking (rag-engineering skill): documents split on section
 * boundaries — never mid-sentence — so each chunk is a coherent unit with
 * full provenance for the citation system.
 *
 * A section starts at a Markdown heading (#{1,6}); the lines before the
 * first heading form a preamble (heading ''). Only oversized sections are
 * split further (word-aligned windows with overlap), so small sections stay
 * whole — semantic boundaries beat token counts.
 */
export interface IngestDoc {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface Chunk {
  docId: string;
  /** Dense, ordered position of this chunk within its document. */
  index: number;
  text: string;
  /** The document-provided metadata, shared by every chunk (citation source). */
  metadata?: Record<string, unknown>;
  /** The section heading this chunk belongs under ('' for the preamble). */
  heading: string;
}

export interface ChunkOptions {
  /** Hard cap for oversized sections; pieces stay at or under this size. */
  maxChars?: number;
  /** Word-aligned overlap between consecutive pieces of one section. */
  overlapChars?: number;
}

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_OVERLAP_CHARS = 150;

/** Normalize lines: drop empties and horizontal-rule boilerplate. */
function cleanLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^-{3,}$/.test(l));
}

interface Section {
  heading: string;
  lines: string[];
}

function toSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let current: Section = { heading: '', lines: [] };
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      // Push the finished section unless it is an empty preamble (no heading,
      // no lines). A non-empty heading with no body still counts: heading-only
      // documents are legitimate terse runbooks.
      if (current.lines.length > 0 || current.heading !== '') sections.push(current);
      current = { heading: (m[2] ?? '').trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length > 0 || current.heading !== '') sections.push(current);
  return sections;
}

/** Split one oversized section into word-aligned windows with overlap. */
function splitOversized(section: Section, maxChars: number, overlapChars: number): string[] {
  const words = section.lines.join(' ').split(/\s+/);
  const pieces: string[] = [];
  let buf: string[] = [];
  let len = 0;
  for (const w of words) {
    const add = w.length + (buf.length > 0 ? 1 : 0);
    if (len + add > maxChars && buf.length > 0) {
      pieces.push(buf.join(' '));
      // Keep the tail of the buffer as the overlap window.
      const tail: string[] = [];
      let tailLen = 0;
      for (let i = buf.length - 1; i >= 0; i--) {
        const bw = buf[i];
        if (bw === undefined) break;
        if (tailLen + bw.length + 1 > overlapChars) break;
        tail.unshift(bw);
        tailLen += bw.length + 1;
      }
      buf = tail;
      len = tailLen;
    }
    buf.push(w);
    len += add;
  }
  if (buf.length > 0) pieces.push(buf.join(' '));
  return pieces;
}

export function chunkDocument(doc: IngestDoc, opts: ChunkOptions = {}): Chunk[] {
  if (typeof doc.id !== 'string' || doc.id.length === 0) {
    throw new Error('chunkDocument: document id must be a non-empty string');
  }
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = Math.min(opts.overlapChars ?? DEFAULT_OVERLAP_CHARS, maxChars - 1);

  const lines = cleanLines(doc.text);
  if (lines.length === 0) throw new Error(`chunkDocument: document '${doc.id}' has no content`);

  const chunks: Chunk[] = [];
  for (const section of toSections(lines)) {
    const body = section.lines.join('\n');
    if (body.length <= maxChars) {
      // Heading-only sections keep the heading as their text so they remain
      // retrievable (the index also prepends the heading).
      const text = body.length > 0 ? body : section.heading;
      chunks.push({ docId: doc.id, index: 0, text, metadata: doc.metadata, heading: section.heading });
      continue;
    }
    for (const piece of splitOversized(section, maxChars, overlapChars)) {
      chunks.push({ docId: doc.id, index: 0, text: piece, metadata: doc.metadata, heading: section.heading });
    }
  }
  if (chunks.length === 0) throw new Error(`chunkDocument: document '${doc.id}' produced no chunks`);
  return chunks.map((c, i) => ({ ...c, index: i }));
}
