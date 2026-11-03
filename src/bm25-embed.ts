/** BM25-inspired sparse embedding — deterministic, no model download.
 *  Extracted from auto-discover-mcp embed.ts; kept pure for skill-tools.
 */

export const EMBEDDING_DIMS = 384;

export function generateBM25Embedding(text: string): Float32Array {
    const embedding = new Float32Array(EMBEDDING_DIMS);
    const tokens = text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1);

    if (tokens.length === 0) return embedding;

    const freqs = new Map<string, number>();
    for (const t of tokens) freqs.set(t, (freqs.get(t) ?? 0) + 1);

    for (const [term, freq] of freqs) {
        const hash = djb2(term);
        const pos = Math.abs(hash) % EMBEDDING_DIMS;
        embedding[pos] += (hash > 0 ? 1 : -1) * (1 + Math.log(freq));
    }

    let norm = 0;
    for (let i = 0; i < EMBEDDING_DIMS; i++) norm += embedding[i] ** 2;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < EMBEDDING_DIMS; i++) embedding[i] /= norm;

    return embedding;
}

function djb2(str: string): number {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
    return h;
}
