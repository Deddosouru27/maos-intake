/**
 * Unit tests for entity normalization — pure functions only, no external deps.
 * Pattern: replicate pure functions inline (from critical.test.ts).
 *
 * Mutation test: if pickCanonical is broken to return first-alphabetically,
 * the "highest mention_count wins" tests fail with a concrete name mismatch.
 */
import { describe, it, expect } from 'vitest';

// ── Pure functions replicated from entity-normalize/index.ts ──────────────────

function normalizeEntityName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function entityDedupeKey(name: string): string {
  return normalizeEntityName(name).toLowerCase();
}

interface EntityNode {
  id: string;
  name: string;
  type: string;
  mention_count: number;
  created_at: string;
}

interface DuplicateGroup {
  canonical: EntityNode;
  duplicates: EntityNode[];
  dedupeKey: string;
}

function pickCanonical(group: EntityNode[]): EntityNode {
  if (group.length === 0) throw new Error('pickCanonical: empty group');
  return group.slice().sort((a, b) => {
    const countDiff = b.mention_count - a.mention_count;
    if (countDiff !== 0) return countDiff;
    const timeDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    if (timeDiff !== 0) return timeDiff;
    return a.name.localeCompare(b.name);
  })[0];
}

function groupDuplicates(nodes: EntityNode[]): DuplicateGroup[] {
  const byKey = new Map<string, EntityNode[]>();
  for (const node of nodes) {
    const key = entityDedupeKey(node.name);
    if (!key) continue;
    const bucket = byKey.get(key) ?? [];
    bucket.push(node);
    byKey.set(key, bucket);
  }
  return Array.from(byKey.values())
    .filter((g) => g.length > 1)
    .map((g) => {
      const canonical = pickCanonical(g);
      return {
        canonical,
        duplicates: g.filter((n) => n.id !== canonical.id),
        dedupeKey: entityDedupeKey(canonical.name),
      };
    });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let _idCounter = 0;
function makeNode(overrides: Partial<EntityNode> = {}): EntityNode {
  _idCounter++;
  return {
    id: `node-${_idCounter}`,
    name: 'TestEntity',
    type: 'tool',
    mention_count: 1,
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

// ── 1. normalizeEntityName ────────────────────────────────────────────────────

describe('normalizeEntityName', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizeEntityName('  OpenAI  ')).toBe('OpenAI');
  });

  it('collapses multiple internal spaces to one', () => {
    expect(normalizeEntityName('Claude  AI')).toBe('Claude AI');
  });

  it('collapses tabs and newlines', () => {
    expect(normalizeEntityName('  Next\t.js\n')).toBe('Next .js');
  });

  it('preserves original casing', () => {
    expect(normalizeEntityName('OpenAI')).toBe('OpenAI');
    expect(normalizeEntityName('supabase')).toBe('supabase');
  });

  it('returns empty string for blank-only input', () => {
    expect(normalizeEntityName('   ')).toBe('');
    expect(normalizeEntityName('')).toBe('');
  });

  it('handles single character', () => {
    expect(normalizeEntityName('X')).toBe('X');
  });

  it('handles 200-character name', () => {
    const long = 'A'.repeat(200);
    expect(normalizeEntityName(long)).toBe(long);
    expect(normalizeEntityName('  ' + long + '  ')).toBe(long);
  });

  it('handles name with emoji', () => {
    expect(normalizeEntityName(' 🤖 AI ')).toBe('🤖 AI');
  });
});

// ── 2. entityDedupeKey ────────────────────────────────────────────────────────

describe('entityDedupeKey', () => {
  it('makes OpenAI and openai produce the same key', () => {
    expect(entityDedupeKey('OpenAI')).toBe(entityDedupeKey('openai'));
  });

  it('makes " OpenAI " and "openai" produce the same key', () => {
    expect(entityDedupeKey(' OpenAI ')).toBe(entityDedupeKey('openai'));
  });

  it('makes " openai " and " OpenAI " match', () => {
    expect(entityDedupeKey(' openai ')).toBe(entityDedupeKey(' OpenAI '));
  });

  it('returns empty string for blank input — not grouped', () => {
    expect(entityDedupeKey('')).toBe('');
    expect(entityDedupeKey('   ')).toBe('');
  });

  it('preserves meaningful differences (Supabase vs Superbase)', () => {
    expect(entityDedupeKey('Supabase')).not.toBe(entityDedupeKey('Superbase'));
  });

  it('collapses case differences with internal spaces', () => {
    expect(entityDedupeKey('Claude AI')).toBe(entityDedupeKey('claude ai'));
    expect(entityDedupeKey('Claude  AI')).toBe(entityDedupeKey('claude ai'));
  });
});

// ── 3. pickCanonical ──────────────────────────────────────────────────────────

describe('pickCanonical', () => {
  it('throws on empty group', () => {
    expect(() => pickCanonical([])).toThrow('empty group');
  });

  it('returns the only node for a singleton group', () => {
    const node = makeNode({ name: 'OpenAI', mention_count: 5 });
    expect(pickCanonical([node])).toBe(node);
  });

  // MUTATION TEST: if pickCanonical returns first-alphabetically instead of
  // highest mention_count, this fails: "expected 'zzzzz' to be 'aaaaa'"
  it('MUTATION: prefers highest mention_count over alphabetical order', () => {
    const low = makeNode({ name: 'aaaa_low', mention_count: 1, created_at: '2024-01-01T00:00:00Z' });
    const high = makeNode({ name: 'zzzz_high', mention_count: 100, created_at: '2024-06-01T00:00:00Z' });
    const canonical = pickCanonical([low, high]);
    expect(canonical.name).toBe('zzzz_high');
    expect(canonical.mention_count).toBe(100);
  });

  it('prefers highest mention_count', () => {
    const nodes = [
      makeNode({ name: 'OpenAI', mention_count: 10, created_at: '2024-06-01T00:00:00Z' }),
      makeNode({ name: 'openai', mention_count: 1, created_at: '2024-01-01T00:00:00Z' }),
    ];
    expect(pickCanonical(nodes).name).toBe('OpenAI');
  });

  it('tiebreak: oldest created_at when mention_count equal', () => {
    const nodes = [
      makeNode({ name: 'openai', mention_count: 5, created_at: '2024-06-01T00:00:00Z' }),
      makeNode({ name: 'OpenAI', mention_count: 5, created_at: '2024-01-01T00:00:00Z' }),
    ];
    expect(pickCanonical(nodes).name).toBe('OpenAI'); // older
  });

  it('tiebreak: lexicographic when mention_count and created_at equal', () => {
    const ts = '2024-01-01T00:00:00Z';
    const nodes = [
      makeNode({ name: 'openai', mention_count: 5, created_at: ts }),
      makeNode({ name: 'OpenAI', mention_count: 5, created_at: ts }),
    ];
    const canonical = pickCanonical(nodes);
    // localeCompare: 'O' < 'o' in most locales → 'OpenAI' first
    expect(typeof canonical.name).toBe('string');
    // The key property: result is deterministic (same input → same output)
    expect(pickCanonical(nodes).name).toBe(pickCanonical([...nodes].reverse()).name);
  });

  it('is stable: same result regardless of input order', () => {
    const nodes = [
      makeNode({ name: 'C', mention_count: 3, created_at: '2024-03-01T00:00:00Z' }),
      makeNode({ name: 'A', mention_count: 5, created_at: '2024-01-01T00:00:00Z' }),
      makeNode({ name: 'B', mention_count: 5, created_at: '2024-02-01T00:00:00Z' }),
    ];
    const r1 = pickCanonical(nodes);
    const r2 = pickCanonical([nodes[2], nodes[0], nodes[1]]);
    expect(r1.name).toBe(r2.name);
    expect(r1.name).toBe('A'); // oldest among count-5 nodes
  });
});

// ── 4. groupDuplicates ────────────────────────────────────────────────────────

describe('groupDuplicates', () => {
  it('returns no groups when all names are unique', () => {
    const nodes = [makeNode({ name: 'OpenAI' }), makeNode({ name: 'Supabase' }), makeNode({ name: 'Vercel' })];
    expect(groupDuplicates(nodes)).toHaveLength(0);
  });

  it('groups OpenAI / openai / " OpenAI " into one group', () => {
    const nodes = [
      makeNode({ name: 'OpenAI', mention_count: 10 }),
      makeNode({ name: 'openai', mention_count: 1 }),
      makeNode({ name: ' OpenAI ', mention_count: 2 }),
    ];
    const groups = groupDuplicates(nodes);
    expect(groups).toHaveLength(1);
    expect(groups[0].duplicates).toHaveLength(2);
    expect(groups[0].canonical.name).toBe('OpenAI'); // highest count
  });

  it('canonical is not in duplicates list', () => {
    const nodes = [makeNode({ name: 'Claude', mention_count: 5 }), makeNode({ name: 'claude', mention_count: 1 })];
    const [group] = groupDuplicates(nodes);
    const dupIds = group.duplicates.map((d) => d.id);
    expect(dupIds).not.toContain(group.canonical.id);
  });

  it('skips nodes with empty-string name', () => {
    const nodes = [makeNode({ name: '' }), makeNode({ name: '   ' }), makeNode({ name: 'OpenAI' })];
    expect(groupDuplicates(nodes)).toHaveLength(0);
  });

  it('skips single-character names that are unique', () => {
    const nodes = [makeNode({ name: 'A' }), makeNode({ name: 'B' })];
    expect(groupDuplicates(nodes)).toHaveLength(0);
  });

  it('finds multiple independent duplicate groups', () => {
    const nodes = [
      makeNode({ name: 'OpenAI', mention_count: 5 }),
      makeNode({ name: 'openai', mention_count: 1 }),
      makeNode({ name: 'Supabase', mention_count: 8 }),
      makeNode({ name: 'supabase', mention_count: 2 }),
      makeNode({ name: 'Vercel' }), // unique
    ];
    expect(groupDuplicates(nodes)).toHaveLength(2);
  });

  it('dedupeKey on the group matches lower(trim(canonical.name))', () => {
    const nodes = [makeNode({ name: ' Supabase ', mention_count: 3 }), makeNode({ name: 'supabase', mention_count: 1 })];
    const [group] = groupDuplicates(nodes);
    expect(group.dedupeKey).toBe('supabase');
  });
});

// ── 5. Idempotency simulation ─────────────────────────────────────────────────

describe('idempotency', () => {
  it('groupDuplicates returns 0 groups when all nodes are already canonical (no dups)', () => {
    // Simulate post-backfill state: all names are unique normalized forms
    const nodes = [
      makeNode({ name: 'OpenAI' }),
      makeNode({ name: 'Supabase' }),
      makeNode({ name: 'Claude' }),
      makeNode({ name: 'Vercel' }),
      makeNode({ name: 'pgvector' }),
    ];
    const groups = groupDuplicates(nodes);
    expect(groups).toHaveLength(0);
    // Running again would delete 0 nodes → idempotent
  });

  it('groupDuplicates on already-normalized set always returns empty', () => {
    const normalized = ['Node.js', 'TypeScript', 'React', 'Express', 'Vitest'];
    const nodes = normalized.map((name) => makeNode({ name }));
    expect(groupDuplicates(nodes)).toHaveLength(0);
    expect(groupDuplicates(nodes)).toHaveLength(0); // second call
  });

  it('after picking canonical from a group, re-running with only canonical → 0 groups', () => {
    const dupes = [
      makeNode({ name: 'OpenAI', mention_count: 10 }),
      makeNode({ name: 'openai', mention_count: 1 }),
    ];
    const groups = groupDuplicates(dupes);
    expect(groups).toHaveLength(1);

    // Simulate post-normalization: only canonical remains
    const afterCleanup = [groups[0].canonical];
    expect(groupDuplicates(afterCleanup)).toHaveLength(0);
  });
});

// ── 6. Edge cases ─────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('1-character name: treated as unique entity, not skipped', () => {
    expect(normalizeEntityName('X')).toBe('X');
    expect(entityDedupeKey('X')).toBe('x');
    // Two 1-char nodes with same name → one duplicate group
    const nodes = [makeNode({ name: 'X', mention_count: 2 }), makeNode({ name: 'x', mention_count: 1 })];
    expect(groupDuplicates(nodes)).toHaveLength(1);
  });

  it('200-character name: fully processed without truncation', () => {
    const long = 'A'.repeat(200);
    const variant = 'a'.repeat(200);
    expect(entityDedupeKey(long)).toBe(entityDedupeKey(variant));
    const nodes = [makeNode({ name: long, mention_count: 5 }), makeNode({ name: variant, mention_count: 1 })];
    const groups = groupDuplicates(nodes);
    expect(groups).toHaveLength(1);
    expect(groups[0].canonical.name).toBe(long);
  });

  it('emoji name: treated as valid entity', () => {
    const nodes = [makeNode({ name: '🤖 AI', mention_count: 3 }), makeNode({ name: '🤖 ai', mention_count: 1 })];
    expect(groupDuplicates(nodes)).toHaveLength(1);
  });

  it('whitespace-only name: empty dedup key → silently skipped', () => {
    const nodes = [makeNode({ name: '   ' }), makeNode({ name: '\t' })];
    expect(groupDuplicates(nodes)).toHaveLength(0);
  });

  it('name with internal punctuation: normalized correctly', () => {
    expect(normalizeEntityName(' Next.js ')).toBe('Next.js');
    expect(entityDedupeKey('Next.js')).toBe('next.js');
  });

  it('name with comma: treated as regular character', () => {
    expect(normalizeEntityName('Foo, Bar')).toBe('Foo, Bar');
  });
});

// ── 7. Mutation test: broken pickCanonical → concrete failure ─────────────────

describe('MUTATION: pickCanonical correctness contract', () => {
  it('must NOT return lowest mention_count node', () => {
    const winner = makeNode({ name: 'winner', mention_count: 99 });
    const loser = makeNode({ name: 'loser', mention_count: 1 });
    const canonical = pickCanonical([winner, loser]);
    // A mutation returning lowest-count would pick loser → this fails
    expect(canonical.mention_count).not.toBe(1);
    expect(canonical.name).toBe('winner');
  });

  it('must NOT return newest node when counts tied', () => {
    const older = makeNode({ name: 'older_canonical', mention_count: 5, created_at: '2024-01-01T00:00:00Z' });
    const newer = makeNode({ name: 'newer_dup', mention_count: 5, created_at: '2024-12-01T00:00:00Z' });
    const canonical = pickCanonical([newer, older]);
    // A mutation returning newest would pick newer → this fails
    expect(canonical.name).toBe('older_canonical');
  });

  it('must NOT return a node that is in the duplicates list', () => {
    const nodes = [
      makeNode({ name: 'OpenAI', mention_count: 10 }),
      makeNode({ name: 'openai', mention_count: 2 }),
      makeNode({ name: ' OpenAI ', mention_count: 1 }),
    ];
    const [group] = groupDuplicates(nodes);
    const dupIds = new Set(group.duplicates.map((d) => d.id));
    // The canonical must not appear in duplicates
    expect(dupIds.has(group.canonical.id)).toBe(false);
  });
});
