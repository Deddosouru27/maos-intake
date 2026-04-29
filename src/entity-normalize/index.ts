/**
 * Entity normalization backfill.
 *
 * Root cause: entity_nodes accumulates duplicates because names are inserted without
 * case-insensitive dedup ('OpenAI' vs 'openai' vs ' OpenAI '). This script groups
 * nodes by lower(trim(name)), picks a canonical per group, rewires entity_edges and
 * extracted_knowledge.entity_objects to point at the canonical, then deletes the rest.
 *
 * SQL to audit duplicates before running:
 *   SELECT lower(trim(name)) AS dedup_key,
 *          array_agg(id ORDER BY mention_count DESC, created_at ASC) AS ids,
 *          array_agg(name ORDER BY mention_count DESC, created_at ASC) AS names,
 *          count(*) AS cnt
 *   FROM entity_nodes
 *   GROUP BY lower(trim(name))
 *   HAVING count(*) > 1
 *   ORDER BY cnt DESC;
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface EntityNode {
  id: string;
  name: string;
  type: string;
  mention_count: number;
  created_at: string;
}

export interface DuplicateGroup {
  canonical: EntityNode;
  duplicates: EntityNode[];
  dedupeKey: string;
}

export interface NormalizeReport {
  status: 'completed' | 'skipped' | 'error';
  entities_before: number;
  entities_after: number;
  deleted: number;
  edges_updated: number;
  knowledge_updated: number;
  groups_processed: number;
  error?: string;
}

// ── Pure functions ────────────────────────────────────────────────────────────

/** Trim + collapse internal whitespace. Preserves original casing for display. */
export function normalizeEntityName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** Case-insensitive key used for grouping duplicates. */
export function entityDedupeKey(name: string): string {
  return normalizeEntityName(name).toLowerCase();
}

/**
 * Pick canonical node from a duplicate group.
 * Priority: highest mention_count → oldest created_at → lexicographic ascending.
 */
export function pickCanonical(group: EntityNode[]): EntityNode {
  if (group.length === 0) throw new Error('pickCanonical: empty group');
  return group.slice().sort((a, b) => {
    const countDiff = b.mention_count - a.mention_count;
    if (countDiff !== 0) return countDiff;
    const timeDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    if (timeDiff !== 0) return timeDiff;
    return a.name.localeCompare(b.name);
  })[0];
}

/**
 * Group entity nodes by entityDedupeKey. Returns only groups with >1 member (actual duplicates).
 * Nodes with empty-string dedup keys (blank names) are silently skipped.
 */
export function groupDuplicates(nodes: EntityNode[]): DuplicateGroup[] {
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

// ── Async orchestrator ────────────────────────────────────────────────────────

const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

async function fetchAllEntityNodes(supabase: SupabaseClient): Promise<EntityNode[]> {
  const all: EntityNode[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await supabase
      .from('entity_nodes')
      .select('id, name, type, mention_count, created_at')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`fetchAllEntityNodes page ${page}: ${error.message}`);
    const rows = (data ?? []) as EntityNode[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

async function rewireEdges(
  supabase: SupabaseClient,
  dupId: string,
  canonicalId: string,
): Promise<number> {
  // Fetch all edges touching the duplicate node
  const { data: sourceEdges, error: e1 } = await supabase
    .from('entity_edges')
    .select('source_id, target_id, relationship, weight')
    .eq('source_id', dupId);
  if (e1) console.warn(`[entity-normalize] fetch source edges for ${dupId}:`, e1.message);

  const { data: targetEdges, error: e2 } = await supabase
    .from('entity_edges')
    .select('source_id, target_id, relationship, weight')
    .eq('target_id', dupId);
  if (e2) console.warn(`[entity-normalize] fetch target edges for ${dupId}:`, e2.message);

  const allEdges = [...(sourceEdges ?? []), ...(targetEdges ?? [])] as {
    source_id: string;
    target_id: string;
    relationship: string;
    weight: number;
  }[];

  if (allEdges.length === 0) return 0;

  let updated = 0;
  for (const edge of allEdges) {
    const newSource = edge.source_id === dupId ? canonicalId : edge.source_id;
    const newTarget = edge.target_id === dupId ? canonicalId : edge.target_id;

    // Skip self-loops that would result from merging
    if (newSource === newTarget) continue;

    // Check if the target edge already exists (would be a conflict)
    const { data: existing } = await supabase
      .from('entity_edges')
      .select('weight')
      .eq('source_id', newSource)
      .eq('target_id', newTarget)
      .eq('relationship', edge.relationship)
      .maybeSingle();

    if (existing) {
      // Merge weights
      await supabase
        .from('entity_edges')
        .update({ weight: (existing.weight ?? 1) + (edge.weight ?? 1) })
        .eq('source_id', newSource)
        .eq('target_id', newTarget)
        .eq('relationship', edge.relationship);
    } else {
      await supabase.from('entity_edges').insert({
        source_id: newSource,
        target_id: newTarget,
        relationship: edge.relationship,
        weight: edge.weight ?? 1,
      });
    }
    updated++;
  }

  // Delete old edges for the duplicate node
  await supabase.from('entity_edges').delete().eq('source_id', dupId);
  await supabase.from('entity_edges').delete().eq('target_id', dupId);

  return updated;
}

async function rewireKnowledge(
  supabase: SupabaseClient,
  groups: DuplicateGroup[],
): Promise<number> {
  // Build a flat map: dupName (lowercase) → canonical name
  const dupKeyToCanonicalName = new Map<string, string>();
  for (const g of groups) {
    for (const dup of g.duplicates) {
      dupKeyToCanonicalName.set(entityDedupeKey(dup.name), g.canonical.name);
    }
  }

  if (dupKeyToCanonicalName.size === 0) return 0;

  let updated = 0;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('extracted_knowledge')
      .select('id, entity_objects')
      .not('entity_objects', 'is', null)
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.warn('[entity-normalize] rewireKnowledge fetch error:', error.message);
      break;
    }
    const rows = (data ?? []) as { id: string; entity_objects: { name: string; type: string }[] | null }[];
    if (rows.length === 0) break;

    for (const row of rows) {
      const objects = row.entity_objects;
      if (!objects || objects.length === 0) continue;

      let changed = false;
      const newObjects = objects.map((obj) => {
        const canonicalName = dupKeyToCanonicalName.get(entityDedupeKey(obj.name));
        if (canonicalName && canonicalName !== obj.name) {
          changed = true;
          return { ...obj, name: canonicalName };
        }
        return obj;
      });

      if (changed) {
        await supabase.from('extracted_knowledge').update({ entity_objects: newObjects }).eq('id', row.id);
        updated++;
      }
    }

    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return updated;
}

export async function runEntityNormalize(options?: {
  supabase?: SupabaseClient;
}): Promise<NormalizeReport> {
  const pitstopUrl = process.env.PITSTOP_SUPABASE_URL;
  const pitstopKey = process.env.PITSTOP_SUPABASE_ANON_KEY;
  if (!pitstopUrl || !pitstopKey) return { status: 'error', error: 'PITSTOP env not set', entities_before: 0, entities_after: 0, deleted: 0, edges_updated: 0, knowledge_updated: 0, groups_processed: 0 };

  const supabase = options?.supabase ?? createClient(pitstopUrl, pitstopKey);

  // 1. Count before
  const { count: beforeCount, error: countErr } = await supabase
    .from('entity_nodes')
    .select('id', { count: 'exact', head: true });
  if (countErr) return { status: 'error', error: `Count failed: ${countErr.message}`, entities_before: 0, entities_after: 0, deleted: 0, edges_updated: 0, knowledge_updated: 0, groups_processed: 0 };

  const entities_before = beforeCount ?? 0;

  // 2. Fetch all nodes and find duplicate groups
  let allNodes: EntityNode[];
  try {
    allNodes = await fetchAllEntityNodes(supabase);
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e), entities_before, entities_after: entities_before, deleted: 0, edges_updated: 0, knowledge_updated: 0, groups_processed: 0 };
  }

  const groups = groupDuplicates(allNodes);
  console.log(`[entity-normalize] Found ${groups.length} duplicate groups across ${allNodes.length} nodes`);

  if (groups.length === 0) {
    return { status: 'completed', entities_before, entities_after: entities_before, deleted: 0, edges_updated: 0, knowledge_updated: 0, groups_processed: 0 };
  }

  // 3. Rewire extracted_knowledge entity_objects
  const knowledge_updated = await rewireKnowledge(supabase, groups);
  console.log(`[entity-normalize] knowledge rows updated: ${knowledge_updated}`);

  // 4. Rewire edges and delete duplicates, group by group
  let edges_updated = 0;
  let deleted = 0;

  for (const group of groups) {
    for (const dup of group.duplicates) {
      const rewired = await rewireEdges(supabase, dup.id, group.canonical.id);
      edges_updated += rewired;

      const { error: delErr } = await supabase.from('entity_nodes').delete().eq('id', dup.id);
      if (delErr) {
        console.warn(`[entity-normalize] delete node ${dup.id} (${dup.name}) failed:`, delErr.message);
      } else {
        deleted++;
        console.log(`[entity-normalize] deleted node "${dup.name}" → canonical "${group.canonical.name}"`);
      }
    }
  }

  // 5. Count after
  const { count: afterCount } = await supabase
    .from('entity_nodes')
    .select('id', { count: 'exact', head: true });

  const entities_after = afterCount ?? entities_before - deleted;

  console.log(`[entity-normalize] Done. Before: ${entities_before}, After: ${entities_after}, Deleted: ${deleted}, Edges rewired: ${edges_updated}, Knowledge updated: ${knowledge_updated}`);

  return {
    status: 'completed',
    entities_before,
    entities_after,
    deleted,
    edges_updated,
    knowledge_updated,
    groups_processed: groups.length,
  };
}
