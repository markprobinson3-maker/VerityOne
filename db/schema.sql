--
-- PostgreSQL database dump
--

\restrict CMn4gKY5NZQJJfWckgMkbYz1O83tRAuBTazGP0CGLeO57zK6n7m7N2fDmWIHHfz

-- Dumped from database version 17.9 (Homebrew)
-- Dumped by pg_dump version 17.9 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: apply_resonance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_resonance() RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  stale_seen_value TEXT;
  stale_seen_updated_at TIMESTAMPTZ;
  stale_seen_xmin TEXT;
BEGIN
  -- Cross-transaction serialization. Concurrent refresh callers queue here.
  PERFORM pg_advisory_xact_lock(1448301577, 1380140849);

  SELECT value, updated_at, xmin::text
    INTO stale_seen_value, stale_seen_updated_at, stale_seen_xmin
  FROM graph_state
  WHERE key = 'resonance_stale';

  -- Suppress only this function's own node UPDATE trigger. External mutations
  -- still mark stale=true; the conditional clear below preserves that signal.
  PERFORM set_config('verity.apply_resonance', '1', true);
  UPDATE nodes n SET
    resonance = r.new_resonance,
    resonance_structural = r.new_resonance,
    resonance_components = jsonb_build_object(
      'connectivity', r.connectivity,
      'layer_depth', r.layer_depth,
      'usage_signal', r.usage_signal,
      'confidence', r.confidence_score,
      'bridge_score', r.bridge_score,
      'source_backing', r.source_score
    ),
    resonance_at = now()
  FROM (
    SELECT addr, new_resonance,
      connectivity, layer_depth, usage_signal,
      confidence_score, bridge_score, source_score
    FROM compute_resonance()
  ) r
  WHERE n.addr = r.addr;
  PERFORM set_config('verity.apply_resonance', '0', true);

  -- Clear only if no external mutation changed the stale flag while this
  -- recompute ran. Do not lock graph_state before UPDATE nodes; that reverses
  -- the node-row -> trigger-row lock order used by ordinary writers.
  IF stale_seen_updated_at IS NULL THEN
    INSERT INTO graph_state (key, value, updated_at)
    VALUES ('resonance_stale', 'false', clock_timestamp())
    ON CONFLICT (key) DO NOTHING;
  ELSE
    UPDATE graph_state
    SET value = 'false', updated_at = clock_timestamp()
    WHERE key = 'resonance_stale'
      AND value IS NOT DISTINCT FROM stale_seen_value
      AND updated_at IS NOT DISTINCT FROM stale_seen_updated_at
      AND xmin::text IS NOT DISTINCT FROM stale_seen_xmin;
  END IF;
END;
$$;


--
-- Name: cleanup_agent_queries(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_agent_queries() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE deleted INT;
BEGIN
  WITH removed AS (
    DELETE FROM agent_queries WHERE created_at < now() - interval '7 days' RETURNING id
  ) SELECT COUNT(*) INTO deleted FROM removed;
  RETURN deleted;
END;
$$;


--
-- Name: cleanup_expired_stimuli(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_expired_stimuli() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  WITH expired AS (
    DELETE FROM stimuli
    WHERE processed = true
      AND created_at < now() - (decay_halflife_hours * 4 || ' hours')::INTERVAL
    RETURNING id
  )
  SELECT COUNT(*) INTO deleted_count FROM expired;

  -- Auto-resolve expired supersession candidates
  UPDATE supersession_candidates sc
  SET status = 'rejected', resolved_by = 'decay', resolved_at = now()
  WHERE status = 'pending'
    AND flagged_at < now() - INTERVAL '7 days';

  -- Auto-resolve expired conflicts
  UPDATE stimulus_conflicts
  SET resolved = true, resolution = 'expired'
  WHERE NOT resolved
    AND flagged_at < now() - INTERVAL '7 days';

  RETURN deleted_count;
END;
$$;


--
-- Name: close_feedback_loop(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.close_feedback_loop(p_agent_id text, p_outcome text) RETURNS TABLE(affected_addrs text[], boost real)
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_addrs TEXT[];
  v_boost REAL;
BEGIN
  -- Queries from this agent in the last 30 minutes that returned addrs.
  SELECT array_agg(DISTINCT addr) INTO v_addrs
  FROM (
    SELECT jsonb_array_elements_text(returned_addrs) AS addr
    FROM query_log
    WHERE agent_id = p_agent_id
      AND returned_addrs IS NOT NULL
      AND created_at > now() - interval '30 minutes'
    ORDER BY created_at DESC
    LIMIT 5
  ) sub;

  IF v_addrs IS NULL OR array_length(v_addrs, 1) IS NULL THEN
    affected_addrs := '{}';
    boost := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_outcome = 'success' THEN
    v_boost := 0.02;
  ELSE
    v_boost := -0.01;
  END IF;

  UPDATE nodes
    SET confidence = LEAST(0.95, GREATEST(0.05, confidence + v_boost))
    WHERE addr = ANY(v_addrs);

  affected_addrs := v_addrs;
  boost := v_boost;
  RETURN NEXT;
END;
$$;


--
-- Name: compute_decay(timestamp with time zone, numeric, numeric, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.compute_decay(p_created_at timestamp with time zone, p_peak_delay_hours numeric, p_halflife_hours numeric, p_base_contribution numeric) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  hours_elapsed NUMERIC;
  hours_since_peak NUMERIC;
  ramp_factor NUMERIC;
  decay_factor NUMERIC;
BEGIN
  hours_elapsed := EXTRACT(EPOCH FROM (now() - p_created_at)) / 3600.0;
  IF p_peak_delay_hours > 0 AND hours_elapsed < p_peak_delay_hours THEN
    ramp_factor := hours_elapsed / p_peak_delay_hours;
  ELSE
    ramp_factor := 1.0;
  END IF;
  hours_since_peak := GREATEST(0, hours_elapsed - p_peak_delay_hours);
  IF p_halflife_hours > 0 THEN
    decay_factor := EXP(-0.693 * hours_since_peak / p_halflife_hours);
  ELSE
    decay_factor := 1.0;
  END IF;
  RETURN p_base_contribution * ramp_factor * decay_factor;
END;
$$;


--
-- Name: compute_resonance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.compute_resonance() RETURNS TABLE(addr text, pyramid_id text, label text, old_resonance real, new_resonance real, connectivity real, layer_depth real, usage_signal real, confidence_score real, bridge_score real, source_score real)
    LANGUAGE plpgsql
    AS $$
DECLARE
  w_conn REAL; w_depth REAL; w_usage REAL; w_conf REAL; 
  w_bridge REAL; w_source REAL; w_subtree REAL; w_recency REAL;
  max_hits_global INT;
  max_children_global INT;
BEGIN
  SELECT weight INTO w_conn FROM resonance_weights WHERE key = 'connectivity';
  SELECT weight INTO w_depth FROM resonance_weights WHERE key = 'layer_depth';
  SELECT weight INTO w_usage FROM resonance_weights WHERE key = 'usage_signal';
  SELECT weight INTO w_conf FROM resonance_weights WHERE key = 'confidence';
  SELECT weight INTO w_bridge FROM resonance_weights WHERE key = 'bridge_score';
  SELECT weight INTO w_source FROM resonance_weights WHERE key = 'source_backing';
  SELECT weight INTO w_subtree FROM resonance_weights WHERE key = 'subtree_richness';
  SELECT weight INTO w_recency FROM resonance_weights WHERE key = 'recency';

  SELECT GREATEST(MAX(query_hits), 1) INTO max_hits_global FROM nodes;
  SELECT GREATEST(MAX(child_count), 1) INTO max_children_global
  FROM (SELECT parent_addr, COUNT(*) as child_count FROM nodes WHERE parent_addr IS NOT NULL GROUP BY parent_addr) sub;

  RETURN QUERY
  WITH edge_stats AS (
    SELECT n.addr, COUNT(e.*) as total_edges,
      COUNT(CASE WHEN SPLIT_PART(e.to_addr, '.', 1) != SPLIT_PART(n.addr, '.', 1)
        OR SPLIT_PART(e.from_addr, '.', 1) != SPLIT_PART(n.addr, '.', 1)
      THEN 1 END) as cross_pyramid_edges
    FROM nodes n LEFT JOIN edges e ON e.from_addr = n.addr OR e.to_addr = n.addr
    GROUP BY n.addr
  ),
  l1_children AS (
    SELECT n.addr, COUNT(DISTINCT e.from_addr) as l1_above
    FROM nodes n JOIN edges e ON e.to_addr = n.addr
    JOIN nodes ref ON ref.addr = e.from_addr AND ref.layer >= 1
    GROUP BY n.addr
  ),
  source_counts AS (
    SELECT n.addr,
      (CASE WHEN jsonb_typeof(n.source_refs) = 'array' THEN jsonb_array_length(n.source_refs) ELSE 0 END) + COUNT(fi.id) as total_sources
    FROM nodes n LEFT JOIN file_index fi ON fi.node_addr = n.addr
    GROUP BY n.addr, n.source_refs
  ),
  child_counts AS (
    SELECT parent_addr as addr, COUNT(*) as children
    FROM nodes WHERE parent_addr IS NOT NULL
    GROUP BY parent_addr
  )
  SELECT n.addr, n.pyramid_id, n.label, n.resonance as old_resonance,
    LEAST(1.0, (
      -- Connectivity: log-scale instead of linear (ln(edges+1) / ln(max+1))
      w_conn * (ln(es.total_edges + 1) / ln(16))::real +
      -- Layer depth: L2=0.8, L1=0.4, L0=0.1, plus L1-above bonus
      w_depth * (CASE n.layer WHEN 0 THEN 0.1 WHEN 1 THEN 0.4 ELSE 0.8 END + LEAST(COALESCE(lc.l1_above, 0) * 0.05, 0.2)) +
      -- Usage: log-scale
      w_usage * (ln(COALESCE(n.query_hits, 0) + 1) / ln(max_hits_global + 1)) +
      -- Confidence
      w_conf * n.confidence +
      -- Bridge score: cross-pyramid ratio
      w_bridge * (CASE WHEN es.total_edges > 0 THEN es.cross_pyramid_edges::real / es.total_edges ELSE 0 END) +
      -- Source backing
      w_source * LEAST(COALESCE(sc.total_sources, 0)::real / 3.0, 1.0) +
      -- Subtree richness: parents with many children
      w_subtree * (COALESCE(cc.children, 0)::real / max_children_global) +
      -- Recency: decays over 30 days (1.0 at creation → 0.0 after 30 days)
      w_recency * GREATEST(0, 1.0 - EXTRACT(EPOCH FROM (NOW() - COALESCE(n.updated_at, n.created_at))) / (30 * 86400))::real
    ))::real as new_resonance,
    -- Component scores (first 6 for backward compat)
    (ln(es.total_edges + 1) / ln(16))::real,
    (CASE n.layer WHEN 0 THEN 0.1 WHEN 1 THEN 0.4 ELSE 0.8 END + LEAST(COALESCE(lc.l1_above, 0) * 0.05, 0.2))::real,
    (ln(COALESCE(n.query_hits, 0) + 1) / ln(max_hits_global + 1))::real,
    n.confidence,
    (CASE WHEN es.total_edges > 0 THEN es.cross_pyramid_edges::real / es.total_edges ELSE 0 END)::real,
    LEAST(COALESCE(sc.total_sources, 0)::real / 3.0, 1.0)::real
  FROM nodes n
  JOIN edge_stats es ON es.addr = n.addr
  LEFT JOIN l1_children lc ON lc.addr = n.addr
  LEFT JOIN source_counts sc ON sc.addr = n.addr
  LEFT JOIN child_counts cc ON cc.addr = n.addr;
END;
$$;


--
-- Name: day_journal_jsonb_set_deep(jsonb, text[], jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.day_journal_jsonb_set_deep(target jsonb, path text[], value jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  result jsonb := COALESCE(target, '{}'::jsonb);
  depth int := COALESCE(array_length(path, 1), 0);
  i int;
  prefix text[];
BEGIN
  IF depth = 0 THEN
    RETURN result;
  END IF;
  IF array_position(path, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'day_journal_jsonb_set_deep path must not contain null segments';
  END IF;
  IF path[1] IS DISTINCT FROM 'journal' THEN
    RAISE EXCEPTION 'day_journal_jsonb_set_deep path must start with journal';
  END IF;

  FOR i IN 1..GREATEST(depth - 1, 0) LOOP
    prefix := path[1:i];
    IF result #> prefix IS NULL OR jsonb_typeof(result #> prefix) <> 'object' THEN
      result := jsonb_set(result, prefix, '{}'::jsonb, true);
    END IF;
  END LOOP;

  RETURN jsonb_set(result, path, value, true);
END;
$$;


--
-- Name: day_journal_source_refs_are_safe(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.day_journal_source_refs_are_safe(refs jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
DECLARE
  ref jsonb;
  ref_type text;
  ref_url text;
  ref_label text;
BEGIN
  IF refs IS NULL OR jsonb_typeof(refs) <> 'array' THEN
    RETURN false;
  END IF;

  FOR ref IN SELECT value FROM jsonb_array_elements(refs) AS value LOOP
    IF jsonb_typeof(ref) <> 'object' THEN
      RETURN false;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_object_keys(ref) AS key_name
      WHERE key_name NOT IN ('type', 'url', 'label')
    ) THEN
      RETURN false;
    END IF;

    ref_type := ref->>'type';
    IF ref_type IS NULL OR ref_type !~ '^[a-z][a-z0-9_]{0,63}$' OR ref_type IN ('prototype', 'constructor') THEN
      RETURN false;
    END IF;

    IF ref ? 'url' THEN
      IF jsonb_typeof(ref->'url') <> 'string' THEN
        RETURN false;
      END IF;
      ref_url := ref->>'url';
      IF ref_url IS NULL OR length(ref_url) > 2048 OR ref_url ~ '[[:cntrl:]]' OR ref_url ~ U&'[\007F-\009F]' THEN
        RETURN false;
      END IF;
      IF ref_url ~ '^https?://[^/?#@]*@' THEN
        RETURN false;
      END IF;
      IF ref_url ~* '(api[_-]?key|access[_-]?token|refresh[_-]?token|token=|authorization)' THEN
        RETURN false;
      END IF;
      IF NOT (
        ref_url ~ '^https://[^/?#@]+'
      ) THEN
        RETURN false;
      END IF;
    END IF;

    IF ref ? 'label' THEN
      IF jsonb_typeof(ref->'label') <> 'string' THEN
        RETURN false;
      END IF;
      ref_label := ref->>'label';
      IF ref_label IS NULL OR length(ref_label) > 256 OR ref_label ~ '[[:cntrl:]]' OR ref_label ~ U&'[\007F-\009F]' THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;

  RETURN true;
EXCEPTION
  WHEN data_exception OR invalid_text_representation THEN
    RETURN false;
  WHEN others THEN
    RAISE NOTICE 'source_refs validator hit unexpected error: %', SQLERRM;
  RETURN false;
END;
$_$;


--
-- Name: decay_confidence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.decay_confidence() RETURNS TABLE(decayed_count integer)
    LANGUAGE plpgsql
    AS $$
DECLARE
    l0_count INTEGER;
    l1_count INTEGER;
BEGIN
    -- Layer 0: full decay rate after 7 days
    UPDATE nodes
    SET confidence = GREATEST(0.05, confidence - decay_rate),
        updated_at = NOW()
    WHERE confidence > 0.05
    AND last_mined < NOW() - INTERVAL '7 days'
    AND layer = 0;
    GET DIAGNOSTICS l0_count = ROW_COUNT;

    -- Layer 1: half decay rate after 14 days
    UPDATE nodes
    SET confidence = GREATEST(0.05, confidence - (decay_rate * 0.5)),
        updated_at = NOW()
    WHERE confidence > 0.05
    AND last_mined < NOW() - INTERVAL '14 days'
    AND layer = 1;
    GET DIAGNOSTICS l1_count = ROW_COUNT;

    -- Layer 2: quarter decay rate after 30 days (meaning is more durable)
    UPDATE nodes
    SET confidence = GREATEST(0.05, confidence - (decay_rate * 0.25)),
        updated_at = NOW()
    WHERE confidence > 0.05
    AND last_mined < NOW() - INTERVAL '30 days'
    AND layer = 2;

    decayed_count := l0_count + l1_count;
    RETURN NEXT;
END;
$$;


--
-- Name: decay_confidence_usage_weighted(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.decay_confidence_usage_weighted() RETURNS TABLE(addr text, old_confidence real, new_confidence real, decay_factor text)
    LANGUAGE plpgsql
    AS $$
DECLARE
  r RECORD;
  base_decay REAL;
  actual_decay REAL;
  factor TEXT;
BEGIN
  FOR r IN 
    SELECT n.addr, n.confidence, n.layer, n.query_hits, n.last_queried,
           n.created_at
    FROM nodes n
    WHERE n.confidence > 0.05  -- floor
  LOOP
    -- Base decay rate by layer
    CASE r.layer
      WHEN 0 THEN base_decay := 0.005;  -- L0: 0.5%/day after 7 days
      WHEN 1 THEN base_decay := 0.0025; -- L1: 0.25%/day after 14 days
      WHEN 2 THEN base_decay := 0.00125; -- L2: 0.125%/day after 30 days
      ELSE base_decay := 0.005;
    END CASE;
    
    -- Check if node is past its grace period
    CASE r.layer
      WHEN 0 THEN 
        IF r.created_at > NOW() - INTERVAL '7 days' THEN CONTINUE; END IF;
      WHEN 1 THEN
        IF r.created_at > NOW() - INTERVAL '14 days' THEN CONTINUE; END IF;
      WHEN 2 THEN
        IF r.created_at > NOW() - INTERVAL '30 days' THEN CONTINUE; END IF;
      ELSE
        IF r.created_at > NOW() - INTERVAL '7 days' THEN CONTINUE; END IF;
    END CASE;
    
    -- Usage-weighted adjustment
    IF r.last_queried IS NOT NULL AND r.last_queried > NOW() - INTERVAL '7 days' THEN
      -- Recently queried: decay at half rate
      actual_decay := base_decay * 0.5;
      factor := 'active_half';
    ELSIF r.query_hits = 0 AND r.created_at < NOW() - INTERVAL '14 days' THEN
      -- Never queried and older than 2 weeks: decay at double rate
      actual_decay := base_decay * 2.0;
      factor := 'unused_double';
    ELSE
      actual_decay := base_decay;
      factor := 'standard';
    END IF;
    
    -- Apply decay with floor
    addr := r.addr;
    old_confidence := r.confidence;
    new_confidence := GREATEST(0.05, r.confidence - actual_decay);
    decay_factor := factor;
    
    IF new_confidence < r.confidence THEN
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;


--
-- Name: decay_wi_stimulus_energy(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.decay_wi_stimulus_energy() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- Only update rows where energy would change by > 1% (avoids needless row locks)
  UPDATE stimuli
  SET energy = EXP(-0.693 * EXTRACT(EPOCH FROM (now() - created_at)) / 3600.0 / decay_halflife_hours)
  WHERE energy IS NOT NULL
    AND energy > 0.01
    AND decay_halflife_hours > 0
    AND ABS(energy - EXP(-0.693 * EXTRACT(EPOCH FROM (now() - created_at)) / 3600.0 / decay_halflife_hours)) > 0.01;

  -- Delete spent stimuli (energy already delivered to nodes, must be processed)
  WITH spent AS (
    DELETE FROM stimuli
    WHERE energy < 0.01 AND energy IS NOT NULL
      AND is_orphan = false
      AND processed = true
    RETURNING id
  )
  SELECT COUNT(*) INTO deleted_count FROM spent;

  RETURN deleted_count;
END;
$$;


--
-- Name: default_edge_label(text, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.default_edge_label(from_label text, to_label text, edge_type text, from_addr text DEFAULT NULL::text, to_addr text DEFAULT NULL::text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  normalized_from text := COALESCE(NULLIF(btrim(from_label), ''), 'Unknown source');
  normalized_to text := COALESCE(NULLIF(btrim(to_label), ''), 'Unknown target');
  normalized_type text := lower(COALESCE(NULLIF(btrim(edge_type), ''), 'related_to'));
  rendered_from text := normalized_from;
  rendered_to text := normalized_to;
BEGIN
  IF normalized_from = normalized_to
     AND COALESCE(NULLIF(btrim(from_addr), ''), '') <> ''
     AND COALESCE(NULLIF(btrim(to_addr), ''), '') <> ''
     AND from_addr <> to_addr THEN
    rendered_from := normalized_from || ' [' || from_addr || ']';
    rendered_to := normalized_to || ' [' || to_addr || ']';
  END IF;

  RETURN CASE normalized_type
    WHEN 'contains' THEN rendered_from || ' contains ' || rendered_to
    WHEN 'child_of' THEN rendered_from || ' is a child of ' || rendered_to
    WHEN 'part_of' THEN rendered_from || ' is part of ' || rendered_to
    WHEN 'composes_with' THEN rendered_from || ' composes with ' || rendered_to
    WHEN 'related_to' THEN rendered_from || ' relates to ' || rendered_to
    WHEN 'extends' THEN rendered_from || ' extends ' || rendered_to
    WHEN 'implements' THEN rendered_from || ' implements ' || rendered_to
    WHEN 'mirrors' THEN rendered_from || ' mirrors ' || rendered_to
    WHEN 'feeds_into' THEN rendered_from || ' feeds into ' || rendered_to
    WHEN 'replaces' THEN rendered_from || ' replaces ' || rendered_to
    WHEN 'requires' THEN rendered_from || ' requires ' || rendered_to
    WHEN 'governs' THEN rendered_from || ' governs ' || rendered_to
    WHEN 'executes' THEN rendered_from || ' executes ' || rendered_to
    WHEN 'supports' THEN rendered_from || ' supports ' || rendered_to
    WHEN 'operationalizes' THEN rendered_from || ' operationalizes ' || rendered_to
    WHEN 'specializes' THEN rendered_from || ' specializes ' || rendered_to
    WHEN 'informs' THEN rendered_from || ' informs ' || rendered_to
    WHEN 'uses' THEN rendered_from || ' uses ' || rendered_to
    ELSE rendered_from || ' ' || replace(normalized_type, '_', ' ') || ' ' || rendered_to
  END;
END;
$$;


--
-- Name: detect_pyramid_gaps(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.detect_pyramid_gaps(target_pyramid text DEFAULT NULL::text, max_results integer DEFAULT 5) RETURNS TABLE(addr text, label text, pyramid_id text, gap_type text, gap_score numeric, detail text)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  WITH
  -- Orphan nodes (no edges at all)
  orphans AS (
    SELECT n.addr, n.label, n.pyramid_id, 
           'orphan'::TEXT as gap_type,
           3.0::NUMERIC as base_score,
           'No edges connecting this node to the graph'::TEXT as detail
    FROM nodes n
    WHERE NOT EXISTS (SELECT 1 FROM edges e WHERE e.from_addr = n.addr OR e.to_addr = n.addr)
      AND (target_pyramid IS NULL OR n.pyramid_id = target_pyramid)
  ),
  -- Sparse parents (< 2 children where depth allows more)
  sparse AS (
    SELECT n.addr, n.label, n.pyramid_id,
           'sparse_parent'::TEXT as gap_type,
           1.0::NUMERIC as base_score,
           'Parent with fewer than 2 children'::TEXT as detail
    FROM nodes n
    WHERE n.depth < 3
      AND (SELECT COUNT(*) FROM nodes c WHERE c.parent_addr = n.addr) < 2
      AND (SELECT COUNT(*) FROM nodes c WHERE c.parent_addr = n.addr) > 0
      AND (target_pyramid IS NULL OR n.pyramid_id = target_pyramid)
  ),
  -- L1 voids (clusters of 5+ L0 siblings with no L1 relations between them)
  l1_voids AS (
    SELECT n.addr, n.label, n.pyramid_id,
           'l1_void'::TEXT as gap_type,
           4.0::NUMERIC as base_score,
           'Area with many facts but no discovered relations'::TEXT as detail
    FROM nodes n
    WHERE n.layer = 0 AND n.depth = 1
      AND (SELECT COUNT(*) FROM nodes c WHERE c.parent_addr = n.addr) >= 5
      AND NOT EXISTS (
        SELECT 1 FROM edges e 
        JOIN nodes c1 ON e.from_addr = c1.addr
        JOIN nodes c2 ON e.to_addr = c2.addr
        WHERE c1.parent_addr = n.addr AND c2.parent_addr = n.addr
          AND e.layer >= 1
      )
      AND (target_pyramid IS NULL OR n.pyramid_id = target_pyramid)
  ),
  -- Query-driven gaps (nodes that InsightForge searches hit with low similarity)
  query_gaps AS (
    SELECT n.addr, n.label, n.pyramid_id,
           'query_gap'::TEXT as gap_type,
           2.5::NUMERIC as base_score,
           'Frequently queried area with weak coverage'::TEXT as detail
    FROM nodes n
    WHERE n.query_hits > 3
      AND n.confidence < 0.75
      AND (target_pyramid IS NULL OR n.pyramid_id = target_pyramid)
  ),
  all_gaps AS (
    SELECT * FROM orphans
    UNION ALL SELECT * FROM sparse
    UNION ALL SELECT * FROM l1_voids
    UNION ALL SELECT * FROM query_gaps
  )
  SELECT g.addr, g.label, g.pyramid_id, g.gap_type, g.base_score as gap_score, g.detail
  FROM all_gaps g
  ORDER BY g.base_score DESC, g.addr
  LIMIT max_results;
END;
$$;


--
-- Name: displace_lowest_priority(text, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.displace_lowest_priority(p_node_addr text, p_new_priority numeric) RETURNS integer
    LANGUAGE plpgsql
    AS $$ -- returns displaced stimulus_id or NULL
DECLARE
  budget NUMERIC;
  current_total NUMERIC;
  connectivity_val NUMERIC;
  high_conn_threshold NUMERIC;
  displaced_id INTEGER;
BEGIN
  -- F11: this function mutates stimulus_contributions. Take the same writer
  -- lock as reactor.ts so refresh_stimulus_heat() cannot snapshot mid-displace.
  PERFORM pg_advisory_xact_lock(1448301577, 1213744177);

  -- Get budget based on connectivity
  SELECT value::NUMERIC INTO high_conn_threshold FROM graph_state WHERE key = 'high_connectivity_threshold';

  SELECT COALESCE(
    (substance->>'connectivity')::NUMERIC, 0
  ) INTO connectivity_val FROM nodes WHERE addr = p_node_addr;

  IF connectivity_val > high_conn_threshold THEN
    SELECT value::NUMERIC INTO budget FROM graph_state WHERE key = 'heat_budget_high_connectivity';
  ELSE
    SELECT value::NUMERIC INTO budget FROM graph_state WHERE key = 'heat_budget_default';
  END IF;

  -- Check current total
  SELECT COALESCE(SUM(contribution), 0) INTO current_total
  FROM stimulus_contributions
  WHERE node_addr = p_node_addr AND contribution > 0.001;

  -- If under budget, no displacement needed
  IF current_total < budget THEN
    RETURN NULL;
  END IF;

  -- Find and displace lowest priority that's below new stimulus priority
  SELECT stimulus_id INTO displaced_id
  FROM stimulus_contributions
  WHERE node_addr = p_node_addr
    AND contribution > 0.001
    AND priority_score < p_new_priority
  ORDER BY priority_score ASC
  LIMIT 1;

  IF displaced_id IS NOT NULL THEN
    UPDATE stimulus_contributions
    SET contribution = 0
    WHERE stimulus_id = displaced_id AND node_addr = p_node_addr;
  END IF;

  RETURN displaced_id;
END;
$$;


--
-- Name: domain_confidence(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.domain_confidence(p_addr text, p_domain text DEFAULT NULL::text) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  domain_conf NUMERIC;
  base_conf NUMERIC;
BEGIN
  IF p_domain IS NULL THEN
    SELECT confidence INTO base_conf FROM nodes WHERE addr = p_addr;
    RETURN COALESCE(base_conf, 0.5);
  END IF;

  SELECT (confidence_by_domain->>p_domain)::NUMERIC INTO domain_conf
  FROM nodes
  WHERE addr = p_addr;

  IF domain_conf IS NOT NULL THEN
    RETURN domain_conf;
  END IF;

  SELECT confidence INTO base_conf FROM nodes WHERE addr = p_addr;
  RETURN COALESCE(base_conf, 0.5);
END;
$$;


--
-- Name: effective_confidence(real, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.effective_confidence(p_base real, p_agent_id text) RETURNS real
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_trust REAL;
BEGIN
  SELECT trust_score INTO v_trust FROM source_trust WHERE agent_id = p_agent_id;
  IF v_trust IS NULL THEN
    v_trust := 0.5;
  END IF;
  -- Scale: base * (0.7 + 0.3 * trust), capped at 0.65
  RETURN LEAST(0.65, p_base * (0.7 + 0.3 * v_trust));
END;
$$;


--
-- Name: fill_edge_label(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fill_edge_label() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  from_label text;
  to_label text;
BEGIN
  IF COALESCE(btrim(NEW.label), '') <> '' THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'edges' THEN
    SELECT COALESCE(nf.label, NEW.from_addr), COALESCE(nt.label, NEW.to_addr)
    INTO from_label, to_label
    FROM nodes nf
    JOIN nodes nt ON nt.addr = NEW.to_addr
    WHERE nf.addr = NEW.from_addr;
  ELSE
    SELECT
      COALESCE(
        (SELECT n.label FROM nodes n WHERE n.addr = NEW.from_addr LIMIT 1),
        (SELECT sn.label FROM staging_nodes sn WHERE sn.addr = NEW.from_addr ORDER BY sn.created_at DESC LIMIT 1),
        NEW.from_addr
      ),
      COALESCE(
        (SELECT n.label FROM nodes n WHERE n.addr = NEW.to_addr LIMIT 1),
        (SELECT sn.label FROM staging_nodes sn WHERE sn.addr = NEW.to_addr ORDER BY sn.created_at DESC LIMIT 1),
        NEW.to_addr
      )
    INTO from_label, to_label;
  END IF;

  NEW.label := default_edge_label(from_label, to_label, NEW.edge_type, NEW.from_addr, NEW.to_addr);
  RETURN NEW;
END;
$$;


--
-- Name: heat_weight(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.heat_weight() RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  total_processed INTEGER;
  mad_heat NUMERIC;
  mad_res NUMERIC;
  floor_val NUMERIC;
  ceiling_val NUMERIC;
  bootstrap_val NUMERIC;
  threshold_val INTEGER;
  result NUMERIC;
BEGIN
  -- Read config
  SELECT value::INTEGER INTO total_processed FROM graph_state WHERE key = 'total_stimuli_processed';
  SELECT value::NUMERIC INTO floor_val FROM graph_state WHERE key = 'heat_weight_floor';
  SELECT value::NUMERIC INTO ceiling_val FROM graph_state WHERE key = 'heat_weight_ceiling';
  SELECT value::NUMERIC INTO bootstrap_val FROM graph_state WHERE key = 'heat_weight_bootstrap_default';
  SELECT value::INTEGER INTO threshold_val FROM graph_state WHERE key = 'heat_weight_bootstrap_threshold';

  -- Cold start
  IF total_processed < threshold_val THEN
    RETURN bootstrap_val;
  END IF;

  -- Compute MAD for stimulus_heat
  SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(stimulus_heat - med.m))
  INTO mad_heat
  FROM nodes, (SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY stimulus_heat) AS m FROM nodes WHERE visibility != 'private') med
  WHERE visibility != 'private';

  -- Compute MAD for resonance
  SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(resonance - med.m))
  INTO mad_res
  FROM nodes, (SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY resonance) AS m FROM nodes WHERE visibility != 'private') med
  WHERE visibility != 'private';

  -- Avoid division by near-zero
  IF mad_res < 0.01 THEN
    RETURN bootstrap_val;
  END IF;

  result := mad_heat / mad_res;
  RETURN GREATEST(floor_val, LEAST(ceiling_val, result));
END;
$$;


--
-- Name: increment_query_hits(text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_query_hits(addrs text[]) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  previous_read_telemetry TEXT;
BEGIN
  previous_read_telemetry := current_setting('verity.read_telemetry', true);
  PERFORM set_config('verity.read_telemetry', '1', true);
  UPDATE nodes
  SET query_hits = query_hits + 1,
      last_queried = NOW()
  WHERE addr = ANY(addrs)
    AND addr <> 'AO.0.0.0';
  PERFORM set_config('verity.read_telemetry', COALESCE(previous_read_telemetry, '0'), true);
END;
$$;


--
-- Name: live_resonance(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.live_resonance(p_addr text) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  base_res NUMERIC;
  heat NUMERIC;
  hw NUMERIC;
BEGIN
  SELECT resonance, stimulus_heat INTO base_res, heat
  FROM nodes
  WHERE addr = p_addr;

  IF base_res IS NULL THEN
    RETURN 0;
  END IF;

  hw := heat_weight();
  RETURN base_res + (COALESCE(heat, 0) * hw);
END;
$$;


--
-- Name: live_resonance_batch(text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.live_resonance_batch(p_addrs text[]) RETURNS TABLE(addr text, base_resonance numeric, stimulus_heat numeric, live_res numeric)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  hw NUMERIC;
BEGIN
  hw := heat_weight();
  RETURN QUERY
    SELECT n.addr, n.resonance::numeric, n.stimulus_heat::numeric,
      (n.resonance::numeric + COALESCE(n.stimulus_heat, 0) * hw) AS live_res
    FROM nodes n
    WHERE n.addr = ANY(p_addrs);
END;
$$;


--
-- Name: live_stimulus_heat(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.live_stimulus_heat(p_addr text) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
  RETURN COALESCE((
    SELECT SUM(
      compute_decay(s.created_at, s.peak_delay_hours, s.decay_halflife_hours, sc.base_contribution)
    )
    FROM stimulus_contributions sc
    JOIN stimuli s ON s.id = sc.stimulus_id
    WHERE sc.node_addr = p_addr
      AND sc.base_contribution > 0.001
  ), 0);
END;
$$;


--
-- Name: log_node_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_node_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.substance IS DISTINCT FROM NEW.substance THEN
    INSERT INTO node_history (addr, field, old_value, new_value, changed_by, reason)
    VALUES (NEW.addr, 'substance', OLD.substance, NEW.substance,
            COALESCE(current_setting('app.agent', true), 'unknown'), 'auto-logged');
  END IF;
  IF OLD.confidence IS DISTINCT FROM NEW.confidence THEN
    INSERT INTO node_history (addr, field, old_value, new_value, changed_by, reason)
    VALUES (NEW.addr, 'confidence', to_jsonb(OLD.confidence), to_jsonb(NEW.confidence),
            COALESCE(current_setting('app.agent', true), 'unknown'), 'auto-logged');
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: log_node_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_node_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO graph_mutations (mutation_type, target_addr, target_label, new_value)
    VALUES (
      'node_create',
      NEW.addr,
      NEW.label,
      jsonb_build_object('confidence', NEW.confidence, 'node_type', NEW.node_type)
    );
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.label IS DISTINCT FROM NEW.label
      OR OLD.confidence IS DISTINCT FROM NEW.confidence
      OR OLD.substance IS DISTINCT FROM NEW.substance
    THEN
      INSERT INTO graph_mutations (mutation_type, target_addr, target_label, old_value, new_value)
      VALUES (
        'node_update',
        NEW.addr,
        NEW.label,
        jsonb_build_object('confidence', OLD.confidence, 'label', OLD.label),
        jsonb_build_object('confidence', NEW.confidence, 'label', NEW.label)
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: mark_dormant_nodes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_dormant_nodes() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  dormant_count INTEGER;
  conf_threshold NUMERIC;
  heat_threshold NUMERIC;
  age_days INTEGER;
BEGIN
  -- Read lifecycle params
  SELECT value::NUMERIC INTO conf_threshold FROM graph_state WHERE key = 'lifecycle_dormancy_confidence';
  SELECT value::NUMERIC INTO heat_threshold FROM graph_state WHERE key = 'lifecycle_dormancy_heat';
  SELECT value::INTEGER INTO age_days FROM graph_state WHERE key = 'lifecycle_dormancy_age_days';

  WITH candidates AS (
    SELECT n.addr, n.visibility
    FROM nodes n
    WHERE n.confidence < conf_threshold
      AND n.stimulus_heat < heat_threshold
      AND n.pinned = false
      AND n.visibility NOT IN ('dormant', 'merged', 'deleted')
      -- Memory lifecycle is owned exclusively by the audited memory-lifecycle helpers
      -- (dormancy/supersession/archival emit memory_events + a registry transition).
      -- This generic node-health sweep must NEVER touch a memory node. IS DISTINCT FROM
      -- (not <>) so NULL-typed nodes stay eligible — only true memory is excluded.
      AND n.node_type IS DISTINCT FROM 'memory'
      AND n.created_at < now() - (age_days || ' days')::INTERVAL
      -- No non-parent_child edges
      AND NOT EXISTS (
        SELECT 1 FROM edges e
        WHERE (e.from_addr = n.addr OR e.to_addr = n.addr)
          AND e.edge_type != 'parent_child'
      )
      -- No attached stimuli with significant energy
      AND NOT EXISTS (
        SELECT 1 FROM stimuli s
        WHERE s.node_addr = n.addr
          AND s.energy > 0.01
      )
  ),
  updated AS (
    UPDATE nodes n
    SET visibility = 'dormant',
        dormant_at = now(),
        substance = jsonb_set(
          COALESCE(substance, '{}'::jsonb),
          '{pre_dormant_visibility}',
          to_jsonb(c.visibility)
        )
    FROM candidates c
    WHERE n.addr = c.addr
    RETURNING n.addr
  )
  SELECT COUNT(*) INTO dormant_count FROM updated;

  RETURN dormant_count;
END;
$$;


--
-- Name: notify_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_notify('verity_changes', json_build_object(
        'id', NEW.id,
        'action', NEW.action,
        'target', NEW.target_addr,
        'details', NEW.details,
        'tier', NEW.agent_tier,
        'at', NEW.created_at
    )::text);
    RETURN NEW;
END;
$$;


--
-- Name: notify_staging_new(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_staging_new() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify('staging_new', TG_TABLE_NAME || ':' || NEW.id::text);
  RETURN NEW;
END;
$$;


--
-- Name: prevent_locked_hosted_tenant_slug_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_locked_hosted_tenant_slug_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.locked_at IS NOT NULL
    AND (
      NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.tenant_slug IS DISTINCT FROM OLD.tenant_slug
    )
  THEN
    RAISE EXCEPTION 'locked hosted tenant slug cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: provenance_weight(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.provenance_weight(p_provenance jsonb) RETURNS real
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  basis TEXT;
  has_evidence BOOLEAN;
  base_weight REAL;
BEGIN
  basis := COALESCE(p_provenance->>'basis', 'asserted');
  has_evidence := jsonb_array_length(COALESCE(p_provenance->'evidence_refs', '[]'::jsonb)) > 0;

  base_weight := CASE basis
    WHEN 'observed' THEN 1.0
    WHEN 'consensus' THEN 0.85
    WHEN 'inferred' THEN 0.65
    WHEN 'asserted' THEN 0.5
    ELSE 0.4
  END;

  IF has_evidence THEN
    base_weight := LEAST(base_weight + 0.1, 1.0);
  END IF;

  RETURN base_weight;
END;
$$;


--
-- Name: recompute_edge_usefulness_scores(integer, interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recompute_edge_usefulness_scores(p_batch_limit integer DEFAULT 5000, p_window interval DEFAULT '90 days'::interval) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  scored_count integer := 0;
  effective_batch_limit integer := GREATEST(1, LEAST(COALESCE(p_batch_limit, 5000), 50000));
  effective_window interval := LEAST(GREATEST(COALESCE(p_window, interval '90 days'), interval '1 day'), interval '365 days');
BEGIN
  PERFORM pg_advisory_xact_lock(0x564f4609, 0x52313301);

  WITH candidates AS (
    SELECT
      e.id,
      e.from_addr,
      e.to_addr,
      e.space_id,
      e.edge_type,
      e.provenance,
      COALESCE(e.provenance->>'discovered_by', e.provenance->>'agent', e.provenance->>'source') AS provenance_actor,
      COALESCE(e.created_at, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS created_at
    FROM edges e
    LEFT JOIN edge_usefulness_scores s ON s.edge_id = e.id
    ORDER BY s.last_computed_at NULLS FIRST, e.id
    LIMIT effective_batch_limit
  ),
  node_grounding AS (
    SELECT
      c.id AS edge_id,
      nf.addr IS NULL AS from_node_missing,
      nt.addr IS NULL AS to_node_missing,
      CASE WHEN jsonb_typeof(COALESCE(nf.source_refs, '[]'::jsonb)) = 'array'
        THEN jsonb_array_length(COALESCE(nf.source_refs, '[]'::jsonb))
        ELSE 0
      END AS from_source_refs,
      CASE WHEN jsonb_typeof(COALESCE(nt.source_refs, '[]'::jsonb)) = 'array'
        THEN jsonb_array_length(COALESCE(nt.source_refs, '[]'::jsonb))
        ELSE 0
      END AS to_source_refs
    FROM candidates c
    LEFT JOIN nodes nf ON nf.addr = c.from_addr
    LEFT JOIN nodes nt ON nt.addr = c.to_addr
  ),
  recall_signal AS (
    SELECT c.id AS edge_id, count(roe_limited.id)::int AS recall_traversal_count
    FROM candidates c
    JOIN LATERAL (
      SELECT DISTINCT roe.id
      FROM recall_outcome_events roe
      WHERE c.from_addr <> c.to_addr
        AND roe.outcome_score > 0
        AND roe.space_id = c.space_id
        AND roe.created_at >= now() - effective_window
        AND roe.created_at >= c.created_at
        AND roe.memory_addrs @> ARRAY[c.from_addr, c.to_addr]
      LIMIT 20
    ) roe_limited ON true
    GROUP BY c.id
  ),
  golden_signal AS (
    SELECT c.id AS edge_id, count(gqr_limited.id)::int AS golden_query_traversal_count
    FROM candidates c
    JOIN LATERAL (
      SELECT DISTINCT gqr.id
      FROM golden_query_expectations gqe_from
      JOIN golden_query_cases gqc
        ON gqc.id = gqe_from.case_id
       AND gqc.space_id = c.space_id
      JOIN golden_query_expectations gqe_to
        ON gqe_to.case_id = gqe_from.case_id
       AND gqe_to.expectation_revision = gqe_from.expectation_revision
       AND gqe_to.addr = c.to_addr
       AND gqe_to.expectation_type = 'expected'
      JOIN golden_query_runs gqr
       ON gqr.case_id = gqe_from.case_id
       AND gqr.expectation_revision = gqe_from.expectation_revision
       AND gqr.status = 'pass'
       AND gqr.created_at >= now() - effective_window
       AND gqr.created_at >= c.created_at
      WHERE c.from_addr <> c.to_addr
        AND gqe_from.addr = c.from_addr
        AND gqe_from.expectation_type = 'expected'
      LIMIT 10
    ) gqr_limited ON true
    GROUP BY c.id
  ),
  contradiction_signal AS (
    SELECT c.id AS edge_id, count(ce.id)::int AS contradiction_count
    FROM candidates c
    LEFT JOIN edges ce
      ON ce.edge_type IN ('contradicts', 'contradiction')
     AND COALESCE(ce.created_at, TIMESTAMPTZ '1970-01-01 00:00:00+00') >= now() - effective_window
     AND (
       ce.from_addr IN (c.from_addr, c.to_addr)
       OR ce.to_addr IN (c.from_addr, c.to_addr)
     )
    GROUP BY c.id
  ),
  components AS (
    SELECT
      c.id AS edge_id,
      CASE
        -- Trusted actors are human/operator surfaces and audited helper passes
        -- observed in the current ladder. Future audited helpers must be added
        -- here or moved to a tunable actor-score table before they write edges.
        WHEN c.provenance_actor IN
          (
            'human', 'operator',
            'qc-sentinel', 'audited_helper', 'ao-lock', 'system',
            'vo-truth-opus', 'vo-truth-audit', 'vo-truth-audit-opus',
            'vo-harvester-opus-qc', 'vo-resonance-opus', 'vo-resonance-opus-qc',
            'durable-alignment', 'heuristic-wiring',
            'supercron-tenant-supersession', 'supercron-registry-repair', 'supercron-recall-outcome',
            'supercron-applied-supersession', 'supercron-applied-registry-reconciliation'
          )
          OR c.provenance_actor LIKE 'supercron-pr9b-reconcile-%'
          THEN 1.0::numeric
        WHEN c.provenance_actor IN
          ('scanner', 'llm', 'inferred', 'supercron', 'auto', 'auto-discovery')
          THEN 0.45::numeric
        ELSE 0.60::numeric
      END AS provenance_strength,
      -- Six total source refs means both endpoint nodes carry several backing
      -- references; more refs should not dominate traversal/provenance signals.
      LEAST(1.0::numeric, ((COALESCE(ng.from_source_refs, 0) + COALESCE(ng.to_source_refs, 0))::numeric / 6.0)) AS source_grounding,
      CASE
        WHEN c.edge_type IN ('supersedes', 'frames', 'contradicts', 'contradiction') THEN 1.0::numeric
        WHEN c.edge_type IN ('grounds', 'governs', 'documents', 'tests', 'discovered_in', 'informs', 'requires', 'uses', 'part_of', 'contains') THEN 0.75::numeric
        WHEN c.edge_type IN ('related_to', 'relates_to', 'co_occurs', 'similar_to') THEN 0.35::numeric
        ELSE 0.50::numeric
      END AS edge_type_specificity,
      COALESCE(ng.from_node_missing, true) AS from_node_missing,
      COALESCE(ng.to_node_missing, true) AS to_node_missing,
      COALESCE(rs.recall_traversal_count, 0) AS recall_traversal_count,
      COALESCE(gs.golden_query_traversal_count, 0) AS golden_query_traversal_count,
      GREATEST(
        0.05::numeric,
        LEAST(1.0::numeric, exp(-GREATEST(0.0, extract(epoch FROM (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - c.created_at)) / 86400.0) / 365.0)::numeric)
      ) AS freshness_decay,
      (1.0 / (1.0 + COALESCE(cs.contradiction_count, 0)))::numeric AS contradiction_penalty
    FROM candidates c
    LEFT JOIN node_grounding ng ON ng.edge_id = c.id
    LEFT JOIN recall_signal rs ON rs.edge_id = c.id
    LEFT JOIN golden_signal gs ON gs.edge_id = c.id
    LEFT JOIN contradiction_signal cs ON cs.edge_id = c.id
  ),
  scored AS (
    SELECT
      edge_id,
      -- PR13 Slice A score weights are load-bearing and intentionally sum to
      -- 1.0. Keep component saturation caps visible when tuning this formula:
      -- recall saturates after 20 useful traversals, golden after 10 passing
      -- expected-address co-presence signals.
      round((
        provenance_strength * 0.20
        + source_grounding * 0.20
        + edge_type_specificity * 0.15
        + LEAST(recall_traversal_count, 20)::numeric / 20.0 * 0.20
        + LEAST(golden_query_traversal_count, 10)::numeric / 10.0 * 0.15
        + freshness_decay * 0.05
        + contradiction_penalty * 0.05
      ), 4) AS score,
      jsonb_build_object(
        'provenance_strength', provenance_strength,
        'source_grounding', source_grounding,
        'edge_type_specificity', edge_type_specificity,
        'from_node_missing', from_node_missing,
        'to_node_missing', to_node_missing,
        'recall_traversal_count', recall_traversal_count,
        'golden_query_traversal_count', golden_query_traversal_count,
        'freshness_decay', freshness_decay,
        'contradiction_penalty', contradiction_penalty
      ) AS components
    FROM components
  ),
  scored_with_existing AS (
    SELECT
      scored.edge_id,
      scored.score,
      scored.components,
      eus.edge_id IS NULL
        OR eus.score IS DISTINCT FROM scored.score
        OR eus.components IS DISTINCT FROM scored.components AS score_changed
    FROM scored
    LEFT JOIN edge_usefulness_scores eus ON eus.edge_id = scored.edge_id
  ),
  upserted AS (
    INSERT INTO edge_usefulness_scores (edge_id, score, components, last_computed_at)
    SELECT edge_id, score, components, now()
    FROM scored_with_existing
    ON CONFLICT (edge_id) DO UPDATE SET
      score = EXCLUDED.score,
      components = EXCLUDED.components,
      last_computed_at = EXCLUDED.last_computed_at
    RETURNING 1
  ),
  upsert_count AS (
    SELECT count(*)::int AS touched_count FROM upserted
  )
  SELECT count(*) FILTER (WHERE score_changed)::int
  INTO scored_count
  FROM scored_with_existing
  CROSS JOIN upsert_count;

  RETURN scored_count;
END;
$$;


--
-- Name: record_execution(text, boolean, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_execution(skill_addr text, success boolean DEFAULT true, agent_tier text DEFAULT 'single'::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  confidence_cap real;
  previous_read_telemetry text;
BEGIN
  CASE agent_tier
    WHEN 'human' THEN confidence_cap := 0.99;
    WHEN 'multi' THEN confidence_cap := 0.90;
    ELSE confidence_cap := 0.70;
  END CASE;

  -- Usage stats are read telemetry. Keep the trigger bypass scoped to these
  -- telemetry updates; the confidence update below must still mark resonance
  -- stale through trigger_mark_resonance_stale().
  previous_read_telemetry := current_setting('verity.read_telemetry', true);
  PERFORM set_config('verity.read_telemetry', '1', true);

  UPDATE nodes SET
    query_hits = query_hits + 1,
    last_queried = now()
  WHERE addr = skill_addr;

  UPDATE edges SET
    execution_count = execution_count + 1,
    success_count = success_count + CASE WHEN success THEN 1 ELSE 0 END,
    last_executed = now()
  WHERE from_addr = skill_addr
    AND edge_type IN ('requires', 'uses', 'composes_with');

  PERFORM set_config('verity.read_telemetry', '0', true);

  IF success THEN
    UPDATE nodes SET
      confidence = LEAST(confidence + 0.001, confidence_cap)
    WHERE addr IN (
      SELECT to_addr FROM edges
      WHERE from_addr = skill_addr AND edge_type = 'requires'
    );
  END IF;

  PERFORM set_config('verity.read_telemetry', COALESCE(previous_read_telemetry, '0'), true);
END;
$$;


--
-- Name: refresh_registry_counts(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_registry_counts(target_pyramid text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  WITH node_counts AS (
    SELECT n.pyramid_id, COUNT(*)::int AS n
    FROM nodes n
    GROUP BY n.pyramid_id
  ),
  edge_counts AS (
    SELECT ep.pyramid_id, COUNT(*)::int AS n
    FROM (
      SELECT e.id AS edge_id, nf.pyramid_id
      FROM edges e
      JOIN nodes nf ON nf.addr = e.from_addr
      UNION
      SELECT e.id, nt.pyramid_id
      FROM edges e
      JOIN nodes nt ON nt.addr = e.to_addr
    ) ep
    GROUP BY ep.pyramid_id
  )
  UPDATE registry r SET
    node_count = COALESCE(nc.n, 0),
    edge_count = COALESCE(ec.n, 0),
    updated_at = NOW()
  FROM registry r2
    LEFT JOIN node_counts nc ON nc.pyramid_id = r2.pyramid_id
    LEFT JOIN edge_counts ec ON ec.pyramid_id = r2.pyramid_id
  WHERE r.pyramid_id = r2.pyramid_id
    AND (target_pyramid IS NULL OR r.pyramid_id = target_pyramid);
END;
$$;


--
-- Name: refresh_resonance_if_stale(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_resonance_if_stale() RETURNS text
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF COALESCE((SELECT value FROM graph_state WHERE key = 'resonance_stale'), 'true') = 'true' THEN
    PERFORM apply_resonance();
    RETURN 'Resonance recomputed';
  ELSE
    RETURN 'Resonance is current';
  END IF;
END;
$$;


--
-- Name: refresh_space_pyramid_counts(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_space_pyramid_counts(target_space text DEFAULT NULL::text, target_pyramid text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  WITH node_counts AS (
    SELECT n.space_id, n.pyramid_id, COUNT(*)::int AS n
    FROM nodes n
    GROUP BY n.space_id, n.pyramid_id
  ),
  edge_counts AS (
    SELECT ep.space_id, ep.pyramid_id, COUNT(*)::int AS n
    FROM (
      SELECT e.id AS edge_id, e.space_id, nf.pyramid_id
      FROM edges e
      JOIN nodes nf ON nf.addr = e.from_addr
      UNION
      SELECT e.id, e.space_id, nt.pyramid_id
      FROM edges e
      JOIN nodes nt ON nt.addr = e.to_addr
    ) ep
    GROUP BY ep.space_id, ep.pyramid_id
  )
  UPDATE space_pyramids sp SET
    node_count = COALESCE(nc.n, 0),
    edge_count = COALESCE(ec.n, 0),
    updated_at = NOW()
  FROM space_pyramids sp2
    LEFT JOIN node_counts nc
      ON nc.space_id = sp2.space_id AND nc.pyramid_id = sp2.pyramid_id
    LEFT JOIN edge_counts ec
      ON ec.space_id = sp2.space_id AND ec.pyramid_id = sp2.pyramid_id
  WHERE sp.space_id = sp2.space_id
    AND sp.pyramid_id = sp2.pyramid_id
    AND (target_space   IS NULL OR sp.space_id    = target_space)
    AND (target_pyramid IS NULL OR sp.pyramid_id = target_pyramid);
END;
$$;


--
-- Name: refresh_stimulus_heat(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_stimulus_heat() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Skip if a writer (reactor --process-pending batch) is mid-flight.
  -- The next refresh cycle will catch up.
  -- 0x564f4609 ('VOF' + 9) + 0x48543031 ('HT01') as two 4-byte keys.
  IF NOT pg_try_advisory_xact_lock(1448301577, 1213744177) THEN
    RAISE NOTICE 'stimulus heat refresh skipped: F11 heat lock busy';
    RETURN;
  END IF;

  UPDATE stimulus_contributions sc
  SET contribution = compute_decay(
    s.created_at,
    COALESCE(sc.peak_delay_hours_override, s.peak_delay_hours),
    COALESCE(sc.decay_halflife_hours_override, s.decay_halflife_hours),
    sc.base_contribution
  )
  FROM stimuli s
  WHERE sc.stimulus_id = s.id
    AND sc.contribution > 0.001;

  UPDATE stimulus_contributions
  SET contribution = 0
  WHERE contribution <= 0.001;

  UPDATE nodes n
  SET stimulus_heat = COALESCE(agg.total, 0)
  FROM (
    SELECT node_addr, SUM(contribution) as total
    FROM stimulus_contributions
    WHERE contribution > 0.001
    GROUP BY node_addr
  ) agg
  WHERE n.addr = agg.node_addr;

  UPDATE nodes
  SET stimulus_heat = 0
  WHERE stimulus_heat > 0
    AND addr NOT IN (
      SELECT DISTINCT node_addr
      FROM stimulus_contributions
      WHERE contribution > 0.001
    );
END;
$$;


--
-- Name: snapshot_intended_apply_action(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.snapshot_intended_apply_action() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  intended_action TEXT;
BEGIN
  IF NEW.status = 'approved' THEN
    IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM 'approved' THEN
      RETURN NEW;
    END IF;

    intended_action := COALESCE(
      NULLIF(NEW.eligibility->>'intended_apply_action', ''),
      (
        SELECT value
        FROM tenant_settings
        WHERE tenant_id = NEW.tenant_id
          AND key = 'supercron_node_gc_apply_action'
        LIMIT 1
      ),
      'tombstone'
    );

    IF intended_action NOT IN ('tombstone', 'delete') THEN
      RAISE EXCEPTION 'invalid intended apply action for node GC receipt: %', intended_action;
    END IF;

    NEW.eligibility := COALESCE(NEW.eligibility, '{}'::jsonb)
      || jsonb_build_object('intended_apply_action', intended_action);
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: stimulus_opacity(real, real, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.stimulus_opacity(p_energy real, p_halflife real, p_created_at timestamp with time zone) RETURNS real
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
  RETURN p_energy * POWER(0.5, EXTRACT(EPOCH FROM (now() - p_created_at)) / 3600.0 / NULLIF(p_halflife, 0));
END;
$$;


--
-- Name: tension_meaning_boost(text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tension_meaning_boost(p_addrs text[]) RETURNS TABLE(addr text, meaning_boost real, tension_count integer, top_tension_type text)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
  RETURN QUERY
  WITH tension_data AS (
    SELECT et.from_addr AS node_addr, et.tension, et.tension_type
    FROM edge_tensions et
    JOIN nodes nf ON nf.addr = et.from_addr
    JOIN nodes nt ON nt.addr = et.to_addr
    WHERE et.from_addr = ANY(p_addrs)
      AND et.resolved_at IS NULL
      AND nf.visibility <> 'deleted'
      AND nt.visibility <> 'deleted'
    UNION ALL
    SELECT et.to_addr AS node_addr, et.tension, et.tension_type
    FROM edge_tensions et
    JOIN nodes nf ON nf.addr = et.from_addr
    JOIN nodes nt ON nt.addr = et.to_addr
    WHERE et.to_addr = ANY(p_addrs)
      AND et.resolved_at IS NULL
      AND nf.visibility <> 'deleted'
      AND nt.visibility <> 'deleted'
  ),
  typed_boosts AS (
    SELECT
      node_addr,
      tension * CASE tension_type
        WHEN 'tradeoff' THEN 1.0
        WHEN 'paradox' THEN 0.8
        WHEN 'complement' THEN 0.6
        WHEN 'constraint' THEN 0.3
        WHEN 'contradiction' THEN -0.5
        ELSE 0.0
      END AS typed_boost,
      tension,
      tension_type
    FROM tension_data
  ),
  aggregated AS (
    SELECT
      node_addr,
      LEAST(
        MAX(typed_boost) * (1 + 0.1 * LN(GREATEST(COUNT(*)::numeric, 1))),
        0.5
      )::real AS boost,
      COUNT(*)::integer AS cnt,
      (SELECT tension_type FROM typed_boosts tb2
       WHERE tb2.node_addr = typed_boosts.node_addr
       ORDER BY tb2.typed_boost DESC LIMIT 1) AS top_type
    FROM typed_boosts
    GROUP BY node_addr
  )
  SELECT
    a.node_addr,
    COALESCE(a.boost, 0)::real,
    COALESCE(a.cnt, 0),
    a.top_type
  FROM aggregated a;
END;
$$;


--
-- Name: touch_account_ui_preferences_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_account_ui_preferences_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: touch_agent(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_agent(p_tenant_id text, p_agent_id text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO agent_profiles (tenant_id, agent_id, last_seen, query_count)
  VALUES (p_tenant_id, p_agent_id, now(), 1)
  ON CONFLICT (tenant_id, agent_id) DO UPDATE SET
    last_seen = now(),
    query_count = agent_profiles.query_count + 1,
    updated_at = now();
END;
$$;


--
-- Name: touch_golden_query_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_golden_query_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: touch_tenant_day_journal_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_tenant_day_journal_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: trigger_mark_resonance_stale(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trigger_mark_resonance_stale() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_setting('verity.apply_resonance', true) = '1'
     OR current_setting('verity.read_telemetry', true) = '1' THEN
    RETURN NULL;
  END IF;

  INSERT INTO graph_state (key, value, updated_at)
  VALUES ('resonance_stale', 'true', clock_timestamp())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
  RETURN NULL;
END;
$$;


--
-- Name: update_domain_affinity(text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_domain_affinity(p_tenant_id text, p_agent_id text, p_domains jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  current_aff JSONB;
  domain_key TEXT;
  domain_val NUMERIC;
  total NUMERIC;
BEGIN
  SELECT domain_affinity INTO current_aff
    FROM agent_profiles WHERE tenant_id = p_tenant_id AND agent_id = p_agent_id;
  IF current_aff IS NULL THEN RETURN; END IF;

  FOR domain_key, domain_val IN SELECT * FROM jsonb_each_text(p_domains) LOOP
    current_aff := jsonb_set(
      current_aff,
      ARRAY[domain_key],
      to_jsonb(COALESCE((current_aff->>domain_key)::numeric, 0) * 0.9 + domain_val::numeric * 0.1)
    );
  END LOOP;

  SELECT SUM(v::numeric) INTO total FROM jsonb_each_text(current_aff) AS x(k, v);
  IF total > 0 THEN
    SELECT jsonb_object_agg(k, ROUND((v::numeric / total)::numeric, 3))
    INTO current_aff
    FROM jsonb_each_text(current_aff) AS x(k, v);
  END IF;

  UPDATE agent_profiles SET domain_affinity = current_aff, updated_at = now()
  WHERE tenant_id = p_tenant_id AND agent_id = p_agent_id;
END;
$$;


--
-- Name: update_search_vector(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_search_vector() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.label, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.substance->>'description', '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(
      array_to_string(ARRAY(SELECT jsonb_array_elements_text(NEW.substance->'provides')), ' '),
      ''
    )), 'A');
  RETURN NEW;
END;
$$;


--
-- Name: update_source_trust(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_source_trust(p_agent_id text, p_decision text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO source_trust (agent_id) VALUES (p_agent_id)
    ON CONFLICT (agent_id) DO NOTHING;

  IF p_decision = 'approved' THEN
    UPDATE source_trust SET approved_count = approved_count + 1 WHERE agent_id = p_agent_id;
  ELSIF p_decision = 'rejected' THEN
    UPDATE source_trust SET rejected_count = rejected_count + 1 WHERE agent_id = p_agent_id;
  ELSIF p_decision = 'revised' THEN
    UPDATE source_trust SET revised_count = revised_count + 1 WHERE agent_id = p_agent_id;
  END IF;

  -- Bayesian trust update: (approved + 2) / (approved + rejected + 0.5*revised + 4)
  UPDATE source_trust
    SET trust_score = (approved_count + 2.0) / (approved_count + rejected_count + 0.5 * revised_count + 4.0),
        updated_at = NOW()
    WHERE agent_id = p_agent_id;
END;
$$;


--
-- Name: update_token_weights_from_resonance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_token_weights_from_resonance() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE nodes SET token_weight = (
    CASE layer 
      WHEN 0 THEN 1.0 
      WHEN 1 THEN 3.0 
      ELSE 8.0 
    END * resonance * confidence
  )::numeric(10,4);
END;
$$;


--
-- Name: verity_assign_edge_spaces(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.verity_assign_edge_spaces() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.from_space_id IS NULL OR btrim(NEW.from_space_id) = '' THEN
    NEW.from_space_id := verity_default_space_for_addr(NEW.from_addr);
  END IF;
  IF NEW.to_space_id IS NULL OR btrim(NEW.to_space_id) = '' THEN
    NEW.to_space_id := verity_default_space_for_addr(NEW.to_addr);
  END IF;
  IF NEW.space_id IS NULL OR btrim(NEW.space_id) = '' THEN
    NEW.space_id := verity_owner_space_for_edge(NEW.from_addr, NEW.to_addr);
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: verity_assign_graph_mutation_space(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.verity_assign_graph_mutation_space() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.space_id IS NULL OR btrim(NEW.space_id) = '' THEN
    IF NEW.target_addr IS NULL OR btrim(NEW.target_addr) = '' THEN
      NEW.space_id := 'global';
    ELSIF position('→' in NEW.target_addr) > 0 THEN
      NEW.space_id := verity_owner_space_for_edge(
        split_part(NEW.target_addr, '→', 1),
        split_part(NEW.target_addr, '→', 2)
      );
    ELSE
      NEW.space_id := verity_default_space_for_addr(NEW.target_addr);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: verity_assign_node_space(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.verity_assign_node_space() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.space_id IS NULL OR btrim(NEW.space_id) = '' THEN
    NEW.space_id := verity_default_space_for_pyramid(NEW.pyramid_id);
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: verity_assign_stimulus_space(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.verity_assign_stimulus_space() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.space_id IS NULL OR btrim(NEW.space_id) = '' THEN
    NEW.space_id := CASE
      WHEN NEW.node_addr IS NOT NULL THEN verity_default_space_for_addr(NEW.node_addr)
      ELSE 'global'
    END;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: verity_assign_update_space(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.verity_assign_update_space() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.space_id IS NULL OR btrim(NEW.space_id) = '' THEN
    NEW.space_id := verity_default_space_for_addr(NEW.addr);
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: verity_default_space_for_addr(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.verity_default_space_for_addr(p_addr text) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  prefix text;
  routed text;
BEGIN
  IF p_addr IS NULL OR btrim(p_addr) = '' THEN
    RETURN 'global';
  END IF;

  prefix := upper(split_part(p_addr, '.', 1));

  SELECT value INTO routed
  FROM graph_state
  WHERE key = 'default_space.addr_prefix.' || prefix;
  IF routed IS NOT NULL AND routed <> '' THEN
    RETURN routed;
  END IF;

  RETURN 'global';
END;
$$;


--
-- Name: verity_default_space_for_pyramid(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.verity_default_space_for_pyramid(p_pyramid_id text) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  pyramid text;
  routed text;
BEGIN
  pyramid := upper(COALESCE(p_pyramid_id, ''));
  IF pyramid = '' THEN
    RETURN 'global';
  END IF;

  SELECT value INTO routed
  FROM graph_state
  WHERE key = 'default_space.pyramid.' || pyramid;
  IF routed IS NOT NULL AND routed <> '' THEN
    RETURN routed;
  END IF;

  RETURN 'global';
END;
$$;


--
-- Name: verity_owner_space_for_edge(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.verity_owner_space_for_edge(p_from_addr text, p_to_addr text) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  from_space text := verity_default_space_for_addr(p_from_addr);
  to_space text := verity_default_space_for_addr(p_to_addr);
BEGIN
  IF from_space <> 'global' THEN
    RETURN from_space;
  END IF;
  IF to_space <> 'global' THEN
    RETURN to_space;
  END IF;
  RETURN 'global';
END;
$$;


--
-- Name: vi_timeout_queue(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vi_timeout_queue() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  timed_out INTEGER;
BEGIN
  UPDATE intake_queue
  SET review_status = 'timeout',
      reviewed_at = now()
  WHERE review_status = 'pending'
    AND is_contradiction = false
    AND created_at < now() - INTERVAL '14 days';

  GET DIAGNOSTICS timed_out = ROW_COUNT;
  RETURN timed_out;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: absorbed_echoes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.absorbed_echoes (
    id integer NOT NULL,
    parent_addr text NOT NULL,
    original_addr text NOT NULL,
    original_label text NOT NULL,
    essence text NOT NULL,
    embedding public.halfvec(3072),
    absorbed_at timestamp with time zone DEFAULT now()
);


--
-- Name: absorbed_echoes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.absorbed_echoes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: absorbed_echoes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.absorbed_echoes_id_seq OWNED BY public.absorbed_echoes.id;


--
-- Name: account_link_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_link_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    code_hash text NOT NULL,
    redeemed boolean DEFAULT false NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: account_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_sessions (
    session_id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked boolean DEFAULT false NOT NULL,
    user_agent text,
    ip_address text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: account_tenant_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_tenant_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    tenant_id text NOT NULL,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    linked_by_node_id text,
    status text DEFAULT 'pending_confirmation'::text NOT NULL,
    CONSTRAINT account_tenant_links_status_check CHECK ((status = ANY (ARRAY['active'::text, 'pending_confirmation'::text, 'unlinked'::text])))
);


--
-- Name: account_ui_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_ui_preferences (
    account_id uuid NOT NULL,
    show_google_email boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    account_id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    display_name text DEFAULT ''::text NOT NULL,
    google_sub text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT accounts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text])))
);


--
-- Name: agent_path_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_path_events (
    id bigint NOT NULL,
    run_id text,
    agent_id text NOT NULL,
    seq integer DEFAULT 0 NOT NULL,
    endpoint text NOT NULL,
    query text,
    addr_selected text,
    returned_addrs text[] DEFAULT '{}'::text[],
    edge_followed text,
    latency_ms integer,
    relevance_score numeric(5,3),
    actionability text,
    confidence text,
    outcome text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    alpha_omega_present boolean DEFAULT false NOT NULL,
    alpha_omega_rank integer,
    CONSTRAINT agent_path_events_outcome_check CHECK ((outcome = ANY (ARRAY['useful'::text, 'dead_end'::text, 'redirect'::text, 'actionable'::text, 'noise'::text, 'unknown'::text])))
);


--
-- Name: agent_path_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_path_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_path_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_path_events_id_seq OWNED BY public.agent_path_events.id;


--
-- Name: agent_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_profiles (
    agent_id text NOT NULL,
    first_seen timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL,
    query_count integer DEFAULT 0 NOT NULL,
    signal_count integer DEFAULT 0 NOT NULL,
    success_count integer DEFAULT 0 NOT NULL,
    failure_count integer DEFAULT 0 NOT NULL,
    domain_affinity jsonb DEFAULT '{}'::jsonb NOT NULL,
    top_nodes jsonb DEFAULT '[]'::jsonb NOT NULL,
    capabilities text[] DEFAULT '{}'::text[],
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text NOT NULL
);


--
-- Name: agent_queries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_queries (
    id integer NOT NULL,
    agent_id text NOT NULL,
    query text NOT NULL,
    node_addrs_returned text[],
    domain_hits jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text NOT NULL
);


--
-- Name: agent_queries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_queries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_queries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_queries_id_seq OWNED BY public.agent_queries.id;


--
-- Name: agent_watches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_watches (
    id integer NOT NULL,
    agent_id text NOT NULL,
    filter text NOT NULL,
    watch_priority text DEFAULT 'standard'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_checked timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text NOT NULL,
    CONSTRAINT agent_watches_watch_priority_check CHECK ((watch_priority = ANY (ARRAY['standard'::text, 'critical'::text])))
);


--
-- Name: agent_watches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_watches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_watches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_watches_id_seq OWNED BY public.agent_watches.id;


--
-- Name: atom_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.atom_feedback (
    id integer NOT NULL,
    ingest_batch_id text NOT NULL,
    node_addr text,
    source_type text NOT NULL,
    score real NOT NULL,
    classification text NOT NULL,
    query_hits integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    action_hits integer DEFAULT 0
);


--
-- Name: atom_feedback_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.atom_feedback_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: atom_feedback_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.atom_feedback_id_seq OWNED BY public.atom_feedback.id;


--
-- Name: change_stream; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.change_stream (
    id bigint NOT NULL,
    action text NOT NULL,
    target_addr text,
    details jsonb,
    agent_tier text,
    created_at timestamp with time zone DEFAULT now(),
    space_id text DEFAULT 'global'::text NOT NULL,
    CONSTRAINT change_stream_action_check CHECK ((action = ANY (ARRAY['node_created'::text, 'node_updated'::text, 'node_pruned'::text, 'edge_discovered'::text, 'edge_updated'::text, 'edge_removed'::text, 'confidence_updated'::text, 'pyramid_created'::text, 'mining_run_completed'::text]))),
    CONSTRAINT change_stream_agent_tier_check CHECK ((agent_tier = ANY (ARRAY['cartographer'::text, 'architect'::text, 'oracle'::text, 'human'::text, 'system'::text])))
);


--
-- Name: change_stream_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.change_stream_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: change_stream_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.change_stream_id_seq OWNED BY public.change_stream.id;


--
-- Name: collapse_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collapse_events (
    id integer NOT NULL,
    node_addr text NOT NULL,
    variant_index integer NOT NULL,
    query_embedding_hash text,
    agent_id text,
    context_summary text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: collapse_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.collapse_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: collapse_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.collapse_events_id_seq OWNED BY public.collapse_events.id;


--
-- Name: confidence_deltas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.confidence_deltas (
    id integer NOT NULL,
    ingest_batch_id text NOT NULL,
    node_addr text NOT NULL,
    delta_type text NOT NULL,
    confidence_before real NOT NULL,
    confidence_after real NOT NULL,
    delta real NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: confidence_deltas_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.confidence_deltas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: confidence_deltas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.confidence_deltas_id_seq OWNED BY public.confidence_deltas.id;


--
-- Name: depth_multiplier; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.depth_multiplier (
    depth integer NOT NULL,
    multiplier numeric(6,3) NOT NULL,
    description text
);


--
-- Name: distill_clusters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.distill_clusters (
    id bigint NOT NULL,
    work_item_id bigint NOT NULL,
    scope_kind text NOT NULL,
    seed_ref text NOT NULL,
    cluster_hash text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    node_addrs jsonb DEFAULT '[]'::jsonb NOT NULL,
    edge_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    pressure_types jsonb DEFAULT '[]'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_built_at timestamp with time zone DEFAULT now() NOT NULL,
    defer_reason text,
    next_review_at timestamp with time zone,
    revisit_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT distill_clusters_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['node'::text, 'edge'::text]))),
    CONSTRAINT distill_clusters_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text, 'deferred'::text])))
);


--
-- Name: distill_clusters_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.distill_clusters_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: distill_clusters_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.distill_clusters_id_seq OWNED BY public.distill_clusters.id;


--
-- Name: distill_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.distill_cursors (
    cursor_kind text NOT NULL,
    last_node_addr text,
    last_edge_id bigint,
    cycle_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT distill_cursors_cursor_kind_check CHECK ((cursor_kind = ANY (ARRAY['node_scan'::text, 'edge_scan'::text])))
);


--
-- Name: distill_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.distill_proposals (
    id bigint NOT NULL,
    work_item_id bigint NOT NULL,
    cluster_id bigint NOT NULL,
    proposal_kind text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    risk_lane text DEFAULT 'medium'::text NOT NULL,
    summary text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    defer_reason text,
    next_review_at timestamp with time zone,
    handoff_status text DEFAULT 'none'::text NOT NULL,
    staging_ref text,
    handed_off_at timestamp with time zone,
    last_handoff_error text,
    fusion_status text DEFAULT 'none'::text NOT NULL,
    fusion_model text,
    fusion_action text,
    fusion_summary text,
    fusion_confidence numeric,
    fusion_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    fusion_judged_at timestamp with time zone,
    fusion_next_review_at timestamp with time zone,
    fusion_attempt_count integer DEFAULT 0 NOT NULL,
    fusion_error text,
    CONSTRAINT distill_proposals_handoff_status_check CHECK ((handoff_status = ANY (ARRAY['none'::text, 'ready'::text, 'submitted'::text, 'blocked'::text]))),
    CONSTRAINT distill_proposals_risk_lane_check CHECK ((risk_lane = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text]))),
    CONSTRAINT distill_proposals_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text, 'deferred'::text, 'ignored'::text])))
);


--
-- Name: distill_proposals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.distill_proposals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: distill_proposals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.distill_proposals_id_seq OWNED BY public.distill_proposals.id;


--
-- Name: distill_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.distill_runs (
    id bigint NOT NULL,
    mode text DEFAULT 'once'::text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    worker_instance text,
    dry_run boolean DEFAULT false NOT NULL,
    node_scan_limit integer DEFAULT 40 NOT NULL,
    edge_scan_limit integer DEFAULT 80 NOT NULL,
    budget_work_items integer DEFAULT 120 NOT NULL,
    work_items_selected integer DEFAULT 0 NOT NULL,
    work_items_detected integer DEFAULT 0 NOT NULL,
    work_items_resolved integer DEFAULT 0 NOT NULL,
    actions_applied integer DEFAULT 0 NOT NULL,
    vague_edges_removed integer DEFAULT 0 NOT NULL,
    self_loop_edges_removed integer DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone
);


--
-- Name: distill_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.distill_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: distill_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.distill_runs_id_seq OWNED BY public.distill_runs.id;


--
-- Name: distill_work_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.distill_work_items (
    id bigint NOT NULL,
    scope_kind text NOT NULL,
    seed_ref text NOT NULL,
    pressure_type text NOT NULL,
    pressure_score numeric DEFAULT 0 NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_distilled_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT distill_work_items_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['node'::text, 'edge'::text])))
);


--
-- Name: distill_work_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.distill_work_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: distill_work_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.distill_work_items_id_seq OWNED BY public.distill_work_items.id;


--
-- Name: edge_composition_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.edge_composition_rules (
    id integer NOT NULL,
    edge_type_1 text NOT NULL,
    edge_type_2 text NOT NULL,
    produces_type text NOT NULL,
    min_confidence real DEFAULT 0.5,
    description text,
    enabled boolean DEFAULT true
);


--
-- Name: edge_composition_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.edge_composition_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: edge_composition_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.edge_composition_rules_id_seq OWNED BY public.edge_composition_rules.id;


--
-- Name: edge_tensions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.edge_tensions (
    id integer NOT NULL,
    from_addr text NOT NULL,
    to_addr text NOT NULL,
    tension real NOT NULL,
    tension_type text NOT NULL,
    synthesis text,
    synthesis_confidence real,
    discovered_by text NOT NULL,
    evidence jsonb DEFAULT '[]'::jsonb,
    resolved_at timestamp with time zone,
    resolution text,
    consistency_status text DEFAULT 'unchecked'::text,
    consistency_checked_at timestamp with time zone,
    visibility text DEFAULT 'public'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT edge_tensions_consistency_status_check CHECK ((consistency_status = ANY (ARRAY['unchecked'::text, 'consistent'::text, 'flagged'::text]))),
    CONSTRAINT edge_tensions_discovered_by_check CHECK ((discovered_by = ANY (ARRAY['scanner'::text, 'agent'::text, 'human'::text, 'dialectic'::text, 'inference'::text]))),
    CONSTRAINT edge_tensions_evidence_shape CHECK (((evidence IS NULL) OR (jsonb_typeof(evidence) = ANY (ARRAY['array'::text, 'object'::text])))),
    CONSTRAINT edge_tensions_no_self_loop CHECK ((from_addr <> to_addr)),
    CONSTRAINT edge_tensions_synthesis_confidence_check CHECK (((synthesis_confidence IS NULL) OR ((synthesis_confidence >= (0)::double precision) AND (synthesis_confidence <= (1)::double precision)))),
    CONSTRAINT edge_tensions_tension_check CHECK (((tension >= (0)::double precision) AND (tension <= (1)::double precision))),
    CONSTRAINT edge_tensions_tension_type_check CHECK ((tension_type = ANY (ARRAY['tradeoff'::text, 'paradox'::text, 'constraint'::text, 'complement'::text, 'contradiction'::text])))
);


--
-- Name: edge_tensions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.edge_tensions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: edge_tensions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.edge_tensions_id_seq OWNED BY public.edge_tensions.id;


--
-- Name: edge_usefulness_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.edge_usefulness_scores (
    edge_id bigint NOT NULL,
    score numeric(8,4) DEFAULT 0 NOT NULL,
    components jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_computed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT edge_usefulness_scores_components_object_chk CHECK ((jsonb_typeof(components) = 'object'::text)),
    CONSTRAINT edge_usefulness_scores_score_range_chk CHECK (((score >= (0)::numeric) AND (score <= (1)::numeric)))
);


--
-- Name: edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.edges (
    id bigint NOT NULL,
    from_addr text NOT NULL,
    to_addr text NOT NULL,
    edge_type text NOT NULL,
    layer smallint NOT NULL,
    label text,
    confidence real DEFAULT 0.5,
    weight real DEFAULT 1.0,
    bidirectional boolean DEFAULT false,
    hash text NOT NULL,
    provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    space_id text DEFAULT 'global'::text NOT NULL,
    from_space_id text DEFAULT 'global'::text NOT NULL,
    to_space_id text DEFAULT 'global'::text NOT NULL,
    source_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    valid_from timestamp with time zone DEFAULT now(),
    valid_until timestamp with time zone,
    token_weight numeric(10,4) DEFAULT 0,
    token_claimed boolean DEFAULT false,
    contributor_addr text,
    execution_count integer DEFAULT 0,
    success_count integer DEFAULT 0,
    last_executed timestamp with time zone,
    CONSTRAINT edges_confidence_check CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
    CONSTRAINT edges_edge_type_check CHECK ((edge_type = ANY (ARRAY['active_on'::text, 'alternative_to'::text, 'attack_surface_for'::text, 'causes'::text, 'child_of'::text, 'complements'::text, 'composes_with'::text, 'conflicts_with'::text, 'constrains'::text, 'contains'::text, 'contrasts'::text, 'depends_on'::text, 'enables'::text, 'executes'::text, 'extends'::text, 'feeds_into'::text, 'frames'::text, 'generates'::text, 'governed_by'::text, 'governs'::text, 'grounds'::text, 'guides'::text, 'implements'::text, 'informs'::text, 'integrates'::text, 'mirrors'::text, 'operationalizes'::text, 'parent_of'::text, 'part_of'::text, 'pattern_mirror'::text, 'precursor_to'::text, 'produces'::text, 'provides'::text, 'related'::text, 'related_to'::text, 'replaces'::text, 'requires'::text, 'routes_to'::text, 'self_references'::text, 'specializes'::text, 'specifies'::text, 'supports'::text, 'transitively_composes'::text, 'transitively_requires'::text, 'trend_affects'::text, 'unifies'::text, 'uses'::text, 'validates'::text]))),
    CONSTRAINT edges_layer_check CHECK ((layer >= 0)),
    CONSTRAINT edges_no_self_loop CHECK ((from_addr <> to_addr)),
    CONSTRAINT edges_nonblank_label CHECK ((btrim(label) <> ''::text)),
    CONSTRAINT edges_nonblank_type CHECK ((btrim(edge_type) <> ''::text)),
    CONSTRAINT edges_provenance_object CHECK ((jsonb_typeof(provenance) = 'object'::text)),
    CONSTRAINT edges_source_context_object CHECK (((source_context IS NULL) OR (jsonb_typeof(source_context) = 'object'::text))),
    CONSTRAINT edges_weight_check CHECK ((weight > (0)::double precision))
);


--
-- Name: edges_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.edges_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: edges_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.edges_id_seq OWNED BY public.edges.id;


--
-- Name: federation_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.federation_activity (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id text NOT NULL,
    account_id uuid,
    session_type text NOT NULL,
    session_id text NOT NULL,
    event_type text NOT NULL,
    outcome text,
    event_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    correlation_id text,
    CONSTRAINT federation_activity_event_type_check CHECK ((event_type = ANY (ARRAY['session_initialized'::text, 'read'::text, 'write_intent'::text, 'sync_push'::text, 'command_apply'::text, 'error'::text]))),
    CONSTRAINT federation_activity_session_type_check CHECK ((session_type = ANY (ARRAY['hosted-browser-session'::text, 'hosted-mcp-agent'::text, 'hosted-mcp-connector'::text, 'sync-node'::text])))
);


--
-- Name: federation_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.federation_nodes (
    node_id text NOT NULL,
    tenant_id text NOT NULL,
    node_label text NOT NULL,
    public_key text,
    capabilities jsonb DEFAULT '{"private_memory": true, "public_overlay_pull": true}'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    last_seen_at timestamp with time zone,
    refresh_token_hash text,
    access_token_hash text,
    access_token_expires_at timestamp with time zone,
    overlay_cursor text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: federation_overlay_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.federation_overlay_log (
    id bigint NOT NULL,
    tenant_id text NOT NULL,
    node_id text NOT NULL,
    overlay_id text NOT NULL,
    overlay_addr text,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    correlation_id text
);


--
-- Name: federation_overlay_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.federation_overlay_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: federation_overlay_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.federation_overlay_log_id_seq OWNED BY public.federation_overlay_log.id;


--
-- Name: file_index; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_index (
    id integer NOT NULL,
    file_path text NOT NULL,
    file_type text NOT NULL,
    line_start integer,
    line_end integer,
    node_addr text NOT NULL,
    excerpt text,
    scanned_at timestamp with time zone DEFAULT now(),
    CONSTRAINT file_index_file_type_check CHECK ((file_type = ANY (ARRAY['md'::text, 'code'::text, 'skill'::text, 'doc'::text])))
);


--
-- Name: file_coverage; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.file_coverage AS
 SELECT file_path,
    file_type,
    count(DISTINCT node_addr) AS node_count,
    min(scanned_at) AS first_scanned,
    max(scanned_at) AS last_scanned
   FROM public.file_index
  GROUP BY file_path, file_type
  ORDER BY (count(DISTINCT node_addr)) DESC;


--
-- Name: file_index_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.file_index_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: file_index_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.file_index_id_seq OWNED BY public.file_index.id;


--
-- Name: foundation_rung_f6_addr_remap; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.foundation_rung_f6_addr_remap (
    old_addr text NOT NULL,
    new_addr text NOT NULL,
    source_kind text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT foundation_rung_f6_addr_remap_source_kind_check CHECK ((source_kind = ANY (ARRAY['node'::text, 'staging_node'::text])))
);


--
-- Name: foundation_rung_f6_staging_cleanup_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.foundation_rung_f6_staging_cleanup_audit (
    table_name text NOT NULL,
    row_id integer NOT NULL,
    addr text,
    pyramid_id text,
    qc_status text,
    cleanup_reason text NOT NULL,
    row_snapshot jsonb NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: golden_query_cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.golden_query_cases (
    id bigint NOT NULL,
    slug text NOT NULL,
    tenant_id text NOT NULL,
    space_id text NOT NULL,
    agent_id text,
    query text NOT NULL,
    k integer DEFAULT 10 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_by text DEFAULT 'manual'::text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    notes text,
    metadata jsonb DEFAULT '{"curation_source": "manual_cli"}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT golden_query_cases_agent_id_check CHECK (((agent_id IS NULL) OR ((agent_id = btrim(agent_id)) AND ((length(agent_id) >= 1) AND (length(agent_id) <= 64)) AND (agent_id ~ '^[A-Za-z0-9_:-]+$'::text)))),
    CONSTRAINT golden_query_cases_check CHECK (((space_id = 'global'::text) OR (space_id = ('tenant:'::text || tenant_id)))),
    CONSTRAINT golden_query_cases_created_by_check CHECK ((created_by = btrim(created_by))),
    CONSTRAINT golden_query_cases_created_by_check1 CHECK (((length(created_by) >= 1) AND (length(created_by) <= 120))),
    CONSTRAINT golden_query_cases_k_check CHECK (((k >= 1) AND (k <= 50))),
    CONSTRAINT golden_query_cases_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT golden_query_cases_metadata_check1 CHECK ((metadata = '{"curation_source": "manual_cli"}'::jsonb)),
    CONSTRAINT golden_query_cases_metadata_check2 CHECK ((length((metadata)::text) <= 4096)),
    CONSTRAINT golden_query_cases_notes_check CHECK (((notes IS NULL) OR (notes = btrim(notes)))),
    CONSTRAINT golden_query_cases_notes_check1 CHECK (((notes IS NULL) OR (length(notes) <= 2000))),
    CONSTRAINT golden_query_cases_query_check CHECK ((query = btrim(query))),
    CONSTRAINT golden_query_cases_query_check1 CHECK ((query !~ '[[:cntrl:]]'::text)),
    CONSTRAINT golden_query_cases_query_check2 CHECK (((length(query) >= 3) AND (length(query) <= 1000))),
    CONSTRAINT golden_query_cases_revision_check CHECK ((revision >= 1)),
    CONSTRAINT golden_query_cases_slug_check CHECK ((slug ~ '^[a-z0-9][a-z0-9_-]{1,120}$'::text)),
    CONSTRAINT golden_query_cases_space_id_check CHECK ((space_id = btrim(space_id))),
    CONSTRAINT golden_query_cases_tenant_id_check CHECK ((tenant_id = btrim(tenant_id)))
);


--
-- Name: golden_query_cases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.golden_query_cases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: golden_query_cases_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.golden_query_cases_id_seq OWNED BY public.golden_query_cases.id;


--
-- Name: golden_query_expectations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.golden_query_expectations (
    id bigint NOT NULL,
    case_id bigint NOT NULL,
    expectation_type text NOT NULL,
    addr text NOT NULL,
    match_mode text DEFAULT 'supersession_descendant'::text NOT NULL,
    expectation_rank integer DEFAULT 0 NOT NULL,
    expectation_revision integer DEFAULT 1 NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT golden_query_expectations_addr_check CHECK ((addr = btrim(addr))),
    CONSTRAINT golden_query_expectations_addr_check1 CHECK (((addr = 'AO.0.0.0'::text) OR
CASE
    WHEN (addr ~ '^TMP\.[0-9]{4}\.[0-9]{1,3}$'::text) THEN ((((split_part(addr, '.'::text, 2))::integer >= 1970) AND ((split_part(addr, '.'::text, 2))::integer <= 9999)) AND (((split_part(addr, '.'::text, 3))::integer >= 1) AND ((split_part(addr, '.'::text, 3))::integer <= 366)))
    ELSE false
END OR
CASE
    WHEN (addr ~ '^[A-Z]{2,5}\.[0-9]{1,10}\.[0-9]{1,10}\.[0-9]{1,10}$'::text) THEN ((split_part(addr, '.'::text, 1) <> 'AO'::text) AND (split_part(addr, '.'::text, 2) !~ '^0[0-9]+$'::text) AND (split_part(addr, '.'::text, 3) !~ '^0[0-9]+$'::text) AND (split_part(addr, '.'::text, 4) !~ '^0[0-9]+$'::text) AND (((split_part(addr, '.'::text, 2))::numeric >= (0)::numeric) AND ((split_part(addr, '.'::text, 2))::numeric <= (2147483647)::numeric)) AND (((split_part(addr, '.'::text, 3))::numeric >= (0)::numeric) AND ((split_part(addr, '.'::text, 3))::numeric <= (2147483647)::numeric)) AND (((split_part(addr, '.'::text, 4))::numeric >= (0)::numeric) AND ((split_part(addr, '.'::text, 4))::numeric <= (2147483647)::numeric)))
    ELSE false
END)),
    CONSTRAINT golden_query_expectations_expectation_rank_check CHECK ((expectation_rank >= 0)),
    CONSTRAINT golden_query_expectations_expectation_revision_check CHECK ((expectation_revision >= 1)),
    CONSTRAINT golden_query_expectations_expectation_type_check CHECK ((expectation_type = ANY (ARRAY['expected'::text, 'forbidden'::text]))),
    CONSTRAINT golden_query_expectations_match_mode_check CHECK ((match_mode = ANY (ARRAY['exact'::text, 'supersession_descendant'::text])))
);


--
-- Name: golden_query_expectations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.golden_query_expectations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: golden_query_expectations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.golden_query_expectations_id_seq OWNED BY public.golden_query_expectations.id;


--
-- Name: golden_query_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.golden_query_runs (
    id bigint NOT NULL,
    supercron_run_id bigint NOT NULL,
    case_id bigint NOT NULL,
    expectation_revision integer NOT NULL,
    precision_at_k numeric(5,3),
    recall_at_k numeric(5,3),
    mrr numeric(5,3),
    forbidden_leaks integer DEFAULT 0 NOT NULL,
    status text NOT NULL,
    error_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT golden_query_runs_error_reason_check CHECK (((error_reason IS NULL) OR (length(error_reason) <= 500))),
    CONSTRAINT golden_query_runs_expectation_revision_check CHECK ((expectation_revision >= 1)),
    CONSTRAINT golden_query_runs_forbidden_leaks_check CHECK ((forbidden_leaks >= 0)),
    CONSTRAINT golden_query_runs_mrr_check CHECK (((mrr IS NULL) OR ((mrr >= (0)::numeric) AND (mrr <= (1)::numeric)))),
    CONSTRAINT golden_query_runs_precision_at_k_check CHECK (((precision_at_k IS NULL) OR ((precision_at_k >= (0)::numeric) AND (precision_at_k <= (1)::numeric)))),
    CONSTRAINT golden_query_runs_recall_at_k_check CHECK (((recall_at_k IS NULL) OR ((recall_at_k >= (0)::numeric) AND (recall_at_k <= (1)::numeric)))),
    CONSTRAINT golden_query_runs_status_check CHECK ((status = ANY (ARRAY['pass'::text, 'fail'::text, 'error'::text, 'skipped'::text])))
);


--
-- Name: golden_query_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.golden_query_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: golden_query_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.golden_query_runs_id_seq OWNED BY public.golden_query_runs.id;


--
-- Name: graph_mutations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.graph_mutations (
    id integer NOT NULL,
    mutation_type text NOT NULL,
    target_addr text,
    target_label text,
    old_value jsonb,
    new_value jsonb,
    source text DEFAULT 'system'::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    space_id text DEFAULT 'global'::text NOT NULL
);


--
-- Name: graph_mutations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.graph_mutations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: graph_mutations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.graph_mutations_id_seq OWNED BY public.graph_mutations.id;


--
-- Name: graph_spaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.graph_spaces (
    space_id text NOT NULL,
    tenant_id text,
    kind text NOT NULL,
    label text NOT NULL,
    description text,
    overlay_parent_space_id text,
    storage_backend text DEFAULT 'server'::text NOT NULL,
    network_scope text DEFAULT 'wan'::text NOT NULL,
    locator jsonb DEFAULT '{}'::jsonb NOT NULL,
    sync_mode text DEFAULT 'eager'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT graph_spaces_kind_check CHECK ((kind = ANY (ARRAY['global'::text, 'tenant'::text, 'device'::text, 'overlay'::text]))),
    CONSTRAINT graph_spaces_network_scope_check CHECK ((network_scope = ANY (ARRAY['device'::text, 'lan'::text, 'wan'::text]))),
    CONSTRAINT graph_spaces_storage_backend_check CHECK ((storage_backend = ANY (ARRAY['server'::text, 'device'::text, 'hybrid'::text, 'remote'::text]))),
    CONSTRAINT graph_spaces_sync_mode_check CHECK ((sync_mode = ANY (ARRAY['eager'::text, 'lazy'::text, 'manual'::text])))
);


--
-- Name: graph_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.graph_state (
    key text NOT NULL,
    value text,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: grounding_gap_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grounding_gap_claims (
    id bigint NOT NULL,
    gap_key text NOT NULL,
    claimant text NOT NULL,
    claimant_agent_id text,
    claimant_tenant_id text,
    claimant_wallet text,
    claim_type text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    source_addr text,
    publication_id bigint,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    reward_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    claim_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT grounding_gap_claims_claim_type_check CHECK ((claim_type = ANY (ARRAY['miner_claim'::text, 'fill_submission'::text, 'verification'::text, 'reward'::text]))),
    CONSTRAINT grounding_gap_claims_status_check CHECK ((status = ANY (ARRAY['open'::text, 'submitted'::text, 'reviewed'::text, 'accepted'::text, 'rejected'::text, 'rewarded'::text])))
);


--
-- Name: grounding_gap_claims_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.grounding_gap_claims_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: grounding_gap_claims_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.grounding_gap_claims_id_seq OWNED BY public.grounding_gap_claims.id;


--
-- Name: grounding_gap_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grounding_gap_events (
    id bigint NOT NULL,
    gap_key text NOT NULL,
    gap_type text NOT NULL,
    goal text NOT NULL,
    goal_hash text NOT NULL,
    agent_id text,
    actor_key text,
    access_scope text NOT NULL,
    space_id text,
    tenant_id text,
    target_pyramid_id text,
    target_branch_addr text,
    severity text NOT NULL,
    confidence_level text,
    event_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    scope_signature jsonb DEFAULT '{}'::jsonb NOT NULL,
    dedupe_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT grounding_gap_events_confidence_level_check CHECK ((confidence_level = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text]))),
    CONSTRAINT grounding_gap_events_gap_type_check CHECK ((gap_type = ANY (ARRAY['missing_world_grounding'::text, 'missing_functional_path'::text, 'missing_reviewed_skill'::text, 'low_corroboration'::text, 'bridge_gap'::text, 'low_confidence'::text]))),
    CONSTRAINT grounding_gap_events_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warn'::text, 'critical'::text])))
);


--
-- Name: grounding_gap_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.grounding_gap_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: grounding_gap_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.grounding_gap_events_id_seq OWNED BY public.grounding_gap_events.id;


--
-- Name: grounding_gap_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grounding_gap_profiles (
    gap_key text NOT NULL,
    gap_type text NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    target_pyramid_id text,
    target_branch_addr text,
    intent_mode text DEFAULT 'discover'::text NOT NULL,
    scope_kind text NOT NULL,
    canonical_focus text,
    canonical_focus_key text DEFAULT 'unfocused'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    seen_count bigint DEFAULT 1 NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    source_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    blockchain_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT grounding_gap_profiles_gap_type_check CHECK ((gap_type = ANY (ARRAY['missing_world_grounding'::text, 'missing_functional_path'::text, 'missing_reviewed_skill'::text, 'low_corroboration'::text, 'bridge_gap'::text, 'low_confidence'::text]))),
    CONSTRAINT grounding_gap_profiles_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['global'::text, 'tenant'::text, 'mixed'::text]))),
    CONSTRAINT grounding_gap_profiles_status_check CHECK ((status = ANY (ARRAY['open'::text, 'monitoring'::text, 'claimed'::text, 'filled'::text, 'verified'::text, 'archived'::text])))
);


--
-- Name: hosted_admin_tenant_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hosted_admin_tenant_overrides (
    tenant_id text NOT NULL,
    label text DEFAULT 'admin'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    capability_tier text DEFAULT 'vo_plus_admin'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hosted_admin_tenant_overrides_capability_tier_check CHECK ((capability_tier = ANY (ARRAY['vo_plus_admin'::text, 'vo_plus_beta'::text, 'vo_plus_internal'::text])))
);


--
-- Name: hosted_agent_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hosted_agent_credentials (
    credential_id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    tenant_id text NOT NULL,
    agent_id text NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    token_hash text NOT NULL,
    token_prefix text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT hosted_agent_credentials_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])))
);


--
-- Name: hosted_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hosted_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type text NOT NULL,
    actor_kind text NOT NULL,
    actor_label text DEFAULT ''::text NOT NULL,
    account_id uuid,
    tenant_id text,
    node_id text,
    link_id uuid,
    event_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    correlation_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hosted_audit_log_actor_kind_check CHECK ((actor_kind = ANY (ARRAY['operator_token'::text, 'admin_session'::text, 'tenant_session'::text, 'hosted_agent'::text, 'oauth_client'::text]))),
    CONSTRAINT hosted_audit_log_event_type_check CHECK ((event_type = ANY (ARRAY['link_approved'::text, 'link_canceled'::text, 'link_unlinked'::text, 'node_revoked'::text, 'node_key_rotated'::text, 'node_key_force_rotated'::text, 'decrypt_access'::text, 'account_suspended'::text, 'account_unsuspended'::text, 'agent_credential_issue'::text, 'agent_credential_revoke'::text, 'secret_redaction'::text, 'oauth_client_register'::text, 'oauth_authorize'::text, 'oauth_token_issue'::text, 'oauth_token_refresh'::text, 'oauth_token_revoke'::text, 'oauth_refresh_replay_detected'::text, 'oauth_client_dormant'::text, 'oauth_client_archived'::text, 'oauth_grant_expired'::text, 'memory_created'::text, 'memory_updated'::text, 'memory_retracted'::text, 'memory_forgotten'::text, 'memory_approved'::text, 'memory_conflict_detected'::text, 'memory_conflict_resolved'::text, 'project_created'::text, 'project_renamed'::text, 'project_archived'::text, 'project_unarchived'::text, 'project_moved'::text, 'project_described'::text, 'pyramid_created'::text, 'pyramid_renamed'::text, 'pyramid_deleted'::text, 'node_published'::text, 'node_unpublished'::text, 'admin_login'::text, 'admin_action'::text, 'recall_outcome_logged'::text, 'agent_created'::text, 'agent_updated'::text, 'agent_disabled'::text, 'tenant_settings_changed'::text, 'supercron_force_run'::text, 'vault_file_tombstoned'::text])))
);


--
-- Name: hosted_connect_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hosted_connect_grants (
    grant_id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid,
    tenant_id text NOT NULL,
    node_id text NOT NULL,
    node_public_key_hash text NOT NULL,
    node_label text DEFAULT ''::text NOT NULL,
    local_origin text NOT NULL,
    redirect_uri text NOT NULL,
    state_hash text NOT NULL,
    return_state text NOT NULL,
    nonce_hash text NOT NULL,
    pkce_challenge text NOT NULL,
    pkce_method text DEFAULT 'S256'::text NOT NULL,
    hosted_oauth_state_hash text,
    confirm_token_hash text,
    code_hash text,
    code_expires_at timestamp with time zone,
    failed_attempt_count integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    redeemed_at timestamp with time zone,
    client_user_agent text,
    client_ip text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hosted_connect_grants_pkce_method_check CHECK ((pkce_method = 'S256'::text)),
    CONSTRAINT hosted_connect_grants_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'redeemed'::text, 'expired'::text, 'canceled'::text])))
);


--
-- Name: hosted_drive_connect_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hosted_drive_connect_grants (
    grant_id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    tenant_id text NOT NULL,
    node_id text NOT NULL,
    state_hash text NOT NULL,
    nonce_hash text NOT NULL,
    ephemeral_public_key bytea NOT NULL,
    encrypted_token_blob bytea,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    code_expires_at timestamp with time zone,
    redeemed_at timestamp with time zone,
    google_identity_email text,
    client_user_agent text,
    client_ip text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hosted_drive_connect_grants_ephemeral_public_key_check CHECK ((octet_length(ephemeral_public_key) = 32)),
    CONSTRAINT hosted_drive_connect_grants_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready_for_redeem'::text, 'redeemed'::text, 'expired'::text, 'canceled'::text, 'failed'::text])))
);


--
-- Name: hosted_drive_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hosted_drive_files (
    tenant_id text NOT NULL,
    relative_path text NOT NULL,
    drive_file_id text NOT NULL,
    drive_web_url text NOT NULL,
    project_addr text,
    file_kind text NOT NULL,
    mime_type text NOT NULL,
    sha256 text NOT NULL,
    size_bytes bigint NOT NULL,
    status text DEFAULT 'uploaded'::text NOT NULL,
    local_modified_at timestamp with time zone,
    drive_modified_at timestamp with time zone,
    sync_source_node_id text NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hosted_drive_files_file_kind_check CHECK ((file_kind = ANY (ARRAY['vault_dossier'::text, 'raw_capture_file'::text, 'other_vault_file'::text]))),
    CONSTRAINT hosted_drive_files_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT hosted_drive_files_size_bytes_check CHECK (((size_bytes >= 0) AND (size_bytes <= '10737418240'::bigint))),
    CONSTRAINT hosted_drive_files_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'uploaded'::text, 'failed'::text, 'deleted_local'::text, 'deleted_drive'::text, 'obsolete'::text])))
);


--
-- Name: hosted_mirror_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hosted_mirror_items (
    tenant_id text NOT NULL,
    item_key text NOT NULL,
    item_type text NOT NULL,
    item_status text DEFAULT 'active'::text NOT NULL,
    encrypted_payload text NOT NULL,
    payload_iv text NOT NULL,
    payload_auth_tag text NOT NULL,
    item_addr text,
    project_addr text,
    governance_key text,
    source_kind text,
    crypto_version integer DEFAULT 1 NOT NULL,
    tenant_key_version integer DEFAULT 1,
    content_key_version integer,
    sync_source_node_id text NOT NULL,
    sync_batch_id text NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hosted_mirror_items_item_status_check CHECK ((item_status = ANY (ARRAY['active'::text, 'tombstoned'::text, 'archived'::text, 'deleted'::text]))),
    CONSTRAINT hosted_mirror_items_item_type_check CHECK ((item_type = ANY (ARRAY['memory'::text, 'edge'::text, 'project'::text, 'governance'::text, 'vault_dossier'::text, 'vault_drive_file'::text, 'journal_entry'::text])))
);


--
-- Name: hosted_mirror_journal_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hosted_mirror_journal_entries (
    tenant_id text NOT NULL,
    entry_key text NOT NULL,
    item_key text NOT NULL,
    item_status text DEFAULT 'active'::text NOT NULL,
    day_addr text NOT NULL,
    target_date date NOT NULL,
    target_timezone text NOT NULL,
    routine_id text NOT NULL,
    target_path text NOT NULL,
    project_addr text,
    schema text NOT NULL,
    sensitivity text NOT NULL,
    routine_class text NOT NULL,
    result_status text NOT NULL,
    entry_state text NOT NULL,
    captured_at timestamp with time zone NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    payload_preview jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    version_token text,
    tombstone_token text,
    is_local_authoritative boolean DEFAULT true NOT NULL,
    content_redacted boolean DEFAULT false NOT NULL,
    sync_source_node_id text NOT NULL,
    sync_batch_id text NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hosted_mirror_journal_entries_check CHECK ((item_key = ('journal_entry:'::text || entry_key))),
    CONSTRAINT hosted_mirror_journal_entries_check1 CHECK ((day_addr = ((('TMP.'::text || lpad(((EXTRACT(year FROM target_date))::integer)::text, 4, '0'::text)) || '.'::text) || lpad(((EXTRACT(doy FROM target_date))::integer)::text, 3, '0'::text)))),
    CONSTRAINT hosted_mirror_journal_entries_check2 CHECK (((item_status <> 'tombstoned'::text) OR (entry_state = ANY (ARRAY['retracted'::text, 'redacted'::text])))),
    CONSTRAINT hosted_mirror_journal_entries_check3 CHECK (((item_status = 'active'::text) OR ((cardinality(tags) = 0) AND (payload_preview = '{}'::jsonb) AND (source_refs = '[]'::jsonb)))),
    CONSTRAINT hosted_mirror_journal_entries_day_addr_check CHECK (((day_addr = btrim(day_addr)) AND (day_addr ~ '^TMP\.[0-9]{4}\.(00[1-9]|0[1-9][0-9]|[1-2][0-9]{2}|3[0-5][0-9]|36[0-6])$'::text))),
    CONSTRAINT hosted_mirror_journal_entries_entry_key_check CHECK ((entry_key ~ '^(entry_[0-9]{8}_[a-f0-9]{16}|routine_[a-f0-9]{16})$'::text)),
    CONSTRAINT hosted_mirror_journal_entries_entry_state_check CHECK ((entry_state = ANY (ARRAY['active'::text, 'retracted'::text, 'redacted'::text]))),
    CONSTRAINT hosted_mirror_journal_entries_item_status_check CHECK ((item_status = ANY (ARRAY['active'::text, 'tombstoned'::text, 'deleted'::text, 'archived'::text]))),
    CONSTRAINT hosted_mirror_journal_entries_payload_preview_check CHECK ((jsonb_typeof(payload_preview) = 'object'::text)),
    CONSTRAINT hosted_mirror_journal_entries_payload_preview_check1 CHECK ((octet_length(convert_to((payload_preview)::text, 'UTF8'::name)) <= 4096)),
    CONSTRAINT hosted_mirror_journal_entries_project_addr_check CHECK (((project_addr IS NULL) OR ((project_addr = btrim(project_addr)) AND (project_addr ~ '^PJ\.[0-9]+(\.[0-9]+)*$'::text)))),
    CONSTRAINT hosted_mirror_journal_entries_result_status_check CHECK ((result_status = ANY (ARRAY['ok'::text, 'partial'::text, 'skipped'::text, 'error'::text]))),
    CONSTRAINT hosted_mirror_journal_entries_routine_class_check CHECK ((routine_class = ANY (ARRAY['context_only'::text, 'actionable'::text]))),
    CONSTRAINT hosted_mirror_journal_entries_routine_id_check CHECK (((routine_id = btrim(routine_id)) AND (routine_id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'::text))),
    CONSTRAINT hosted_mirror_journal_entries_schema_check CHECK ((schema ~ '^[a-z][a-z0-9_]{0,63}_v[0-9]+$'::text)),
    CONSTRAINT hosted_mirror_journal_entries_sensitivity_check CHECK ((sensitivity = ANY (ARRAY['standard'::text, 'personal'::text, 'health'::text, 'financial'::text, 'calendar'::text, 'email'::text]))),
    CONSTRAINT hosted_mirror_journal_entries_source_refs_check CHECK ((jsonb_typeof(source_refs) = 'array'::text)),
    CONSTRAINT hosted_mirror_journal_entries_source_refs_check1 CHECK ((octet_length(convert_to((source_refs)::text, 'UTF8'::name)) <= 8192)),
    CONSTRAINT hosted_mirror_journal_entries_source_refs_check2 CHECK (public.day_journal_source_refs_are_safe(source_refs)),
    CONSTRAINT hosted_mirror_journal_entries_sync_batch_id_check CHECK (((length(sync_batch_id) >= 1) AND (length(sync_batch_id) <= 256))),
    CONSTRAINT hosted_mirror_journal_entries_sync_batch_id_check1 CHECK ((sync_batch_id = btrim(sync_batch_id))),
    CONSTRAINT hosted_mirror_journal_entries_sync_batch_id_check2 CHECK (((sync_batch_id !~ '[[:cntrl:]]'::text) AND (sync_batch_id !~ '[-]'::text))),
    CONSTRAINT hosted_mirror_journal_entries_sync_source_node_id_check CHECK (((length(sync_source_node_id) >= 1) AND (length(sync_source_node_id) <= 256))),
    CONSTRAINT hosted_mirror_journal_entries_sync_source_node_id_check1 CHECK ((sync_source_node_id = btrim(sync_source_node_id))),
    CONSTRAINT hosted_mirror_journal_entries_sync_source_node_id_check2 CHECK (((sync_source_node_id !~ '[[:cntrl:]]'::text) AND (sync_source_node_id !~ '[-]'::text))),
    CONSTRAINT hosted_mirror_journal_entries_tags_check CHECK ((array_position(tags, NULL::text) IS NULL)),
    CONSTRAINT hosted_mirror_journal_entries_tags_check1 CHECK (((array_to_string(tags, ''::text) ~ '^[a-z0-9_-]*$'::text) AND ((cardinality(tags) = 0) OR (array_to_string(tags, '.'::text) ~ '^[a-z0-9_-]{1,64}(\.[a-z0-9_-]{1,64})*$'::text)))),
    CONSTRAINT hosted_mirror_journal_entries_target_date_check CHECK (((target_date >= '1970-01-01'::date) AND (target_date <= '9999-12-31'::date))),
    CONSTRAINT hosted_mirror_journal_entries_target_path_check CHECK ((length(target_path) <= 256)),
    CONSTRAINT hosted_mirror_journal_entries_target_path_check1 CHECK ((target_path ~ '^journal\.[a-z][a-z0-9_]{0,63}(\.[a-z][a-z0-9_]{0,63}){1,7}$'::text)),
    CONSTRAINT hosted_mirror_journal_entries_target_path_check2 CHECK ((target_path !~ '(^|\.)((__proto__)|(prototype)|(constructor))(\.|$)'::text)),
    CONSTRAINT hosted_mirror_journal_entries_target_timezone_check CHECK (((target_timezone = btrim(target_timezone)) AND ((length(target_timezone) >= 1) AND (length(target_timezone) <= 128)) AND (target_timezone !~ '[[:cntrl:]]'::text) AND (target_timezone !~ '[-]'::text))),
    CONSTRAINT hosted_mirror_journal_entries_tenant_id_check CHECK (((tenant_id = btrim(tenant_id)) AND (tenant_id ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'::text)))
);


--
-- Name: hosted_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hosted_nodes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    tenant_id text NOT NULL,
    node_id text NOT NULL,
    node_label text DEFAULT ''::text NOT NULL,
    node_public_key text,
    status text DEFAULT 'pending'::text NOT NULL,
    sync_status text DEFAULT 'never'::text NOT NULL,
    last_sync_at timestamp with time zone,
    sync_cursor text,
    sync_token_hash text,
    sync_token_claimed boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    drive_mirror_primary_at timestamp with time zone,
    CONSTRAINT hosted_nodes_status_check CHECK ((status = ANY (ARRAY['active'::text, 'pending'::text, 'revoked'::text]))),
    CONSTRAINT hosted_nodes_sync_status_check CHECK ((sync_status = ANY (ARRAY['never'::text, 'syncing'::text, 'paused'::text, 'error'::text])))
);


--
-- Name: hosted_rate_limit_buckets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hosted_rate_limit_buckets (
    bucket_key text NOT NULL,
    count integer DEFAULT 0 NOT NULL,
    reset_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hosted_rate_limit_buckets_count_check CHECK ((count >= 0))
);


--
-- Name: hosted_sync_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hosted_sync_batches (
    batch_id text NOT NULL,
    account_id uuid NOT NULL,
    tenant_id text NOT NULL,
    node_id text NOT NULL,
    schema_version integer NOT NULL,
    cursor_from bigint NOT NULL,
    cursor_to bigint NOT NULL,
    item_count integer NOT NULL,
    applied_item_count integer,
    rejected_items_jsonb jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'applied'::text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hosted_sync_batches_status_check CHECK ((status = ANY (ARRAY['applied'::text, 'rejected'::text])))
);


--
-- Name: hosted_tenant_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hosted_tenant_identities (
    tenant_id text NOT NULL,
    tenant_slug text NOT NULL,
    tenant_display_name text NOT NULL,
    tenant_display_name_source text NOT NULL,
    created_by_account_id uuid,
    confirmed_at timestamp with time zone,
    locked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hosted_tenant_identities_display_source_check CHECK ((tenant_display_name_source = ANY (ARRAY['google_profile'::text, 'google_email'::text, 'manual'::text, 'admin_seed'::text]))),
    CONSTRAINT hosted_tenant_identities_slug_matches_id_check CHECK ((tenant_slug = tenant_id)),
    CONSTRAINT hosted_tenant_identities_tenant_slug_check CHECK ((tenant_id ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'::text))
);


--
-- Name: intake_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.intake_queue (
    id integer NOT NULL,
    atom_content text NOT NULL,
    atom_type text NOT NULL,
    score real NOT NULL,
    score_components jsonb DEFAULT '{}'::jsonb NOT NULL,
    temporality text NOT NULL,
    source_type text NOT NULL,
    source_id text NOT NULL,
    source_title text NOT NULL,
    ingest_batch_id text NOT NULL,
    embedding public.halfvec(3072),
    nearest_node_addr text,
    nearest_similarity real,
    is_contradiction boolean DEFAULT false,
    provenance_status text DEFAULT 'verified'::text,
    classifier_version integer DEFAULT 5 NOT NULL,
    review_status text DEFAULT 'pending'::text NOT NULL,
    lineage jsonb DEFAULT '{}'::jsonb NOT NULL,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    space_id text DEFAULT 'global'::text NOT NULL
);


--
-- Name: intake_queue_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.intake_queue_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: intake_queue_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.intake_queue_id_seq OWNED BY public.intake_queue.id;


--
-- Name: memory_conflicts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_conflicts (
    id bigint NOT NULL,
    tenant_id text NOT NULL,
    addr_a text NOT NULL,
    addr_b text NOT NULL,
    conflict_type text DEFAULT 'contradiction'::text NOT NULL,
    description text,
    status text DEFAULT 'detected'::text NOT NULL,
    resolved_by text,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone
);


--
-- Name: memory_conflicts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.memory_conflicts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: memory_conflicts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.memory_conflicts_id_seq OWNED BY public.memory_conflicts.id;


--
-- Name: memory_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_events (
    id bigint NOT NULL,
    addr text NOT NULL,
    tenant_id text NOT NULL,
    event_type text NOT NULL,
    event_data jsonb DEFAULT '{}'::jsonb,
    actor text,
    correlation_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: memory_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.memory_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: memory_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.memory_events_id_seq OWNED BY public.memory_events.id;


--
-- Name: memory_registry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_registry (
    addr text NOT NULL,
    tenant_id text NOT NULL,
    kind text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    accepted_by_user boolean DEFAULT false NOT NULL,
    source_kind text DEFAULT 'agent_inferred'::text NOT NULL,
    source_ref text,
    effective_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    supersedes_addr text,
    superseded_by_addr text,
    conflict_state text DEFAULT 'none'::text,
    last_validated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_registry_status_check CHECK ((status = ANY (ARRAY['active'::text, 'superseded'::text, 'retracted'::text, 'archived'::text, 'expired'::text])))
);


--
-- Name: mining_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mining_runs (
    id bigint NOT NULL,
    run_number integer NOT NULL,
    pyramid_id text,
    mode text NOT NULL,
    nodes_checked integer DEFAULT 0,
    edges_found integer DEFAULT 0,
    implied_nodes integer DEFAULT 0,
    cost_usd real DEFAULT 0,
    model_used text,
    consecutive_dry integer DEFAULT 0,
    started_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    source_files jsonb DEFAULT '[]'::jsonb,
    CONSTRAINT mining_runs_mode_check CHECK ((mode = ANY (ARRAY['layer0'::text, 'layer1'::text, 'layer2'::text, 'cross-pyramid'::text, 'dialectic'::text, 'diffusion'::text, 'mercury-blitz'::text, 'opus-scan'::text, 'swarm-fill'::text, 'verity-ingest'::text])))
);


--
-- Name: mining_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mining_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mining_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mining_runs_id_seq OWNED BY public.mining_runs.id;


--
-- Name: node_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.node_history (
    id integer NOT NULL,
    addr text NOT NULL,
    field text NOT NULL,
    old_value jsonb,
    new_value jsonb NOT NULL,
    changed_by text NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: node_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.node_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: node_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.node_history_id_seq OWNED BY public.node_history.id;


--
-- Name: node_publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.node_publications (
    id bigint NOT NULL,
    source_space_id text NOT NULL,
    source_addr text NOT NULL,
    target_space_id text DEFAULT 'global'::text NOT NULL,
    target_addr text,
    target_pyramid_id text NOT NULL,
    target_parent_addr text,
    publication_kind text DEFAULT 'mirror'::text NOT NULL,
    status text DEFAULT 'published'::text NOT NULL,
    public_label text NOT NULL,
    public_description text,
    public_node_type text,
    public_visibility text DEFAULT 'public'::text NOT NULL,
    derivation_note text,
    source_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    published_substance jsonb DEFAULT '{}'::jsonb NOT NULL,
    published_by text,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT node_publications_publication_kind_check CHECK ((publication_kind = ANY (ARRAY['mirror'::text, 'promotion'::text, 'derivation'::text]))),
    CONSTRAINT node_publications_status_check CHECK ((status = ANY (ARRAY['published'::text, 'updated'::text, 'archived'::text, 'superseded'::text])))
);


--
-- Name: node_publications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.node_publications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: node_publications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.node_publications_id_seq OWNED BY public.node_publications.id;


--
-- Name: nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nodes (
    addr text NOT NULL,
    pyramid_id text NOT NULL,
    layer smallint NOT NULL,
    depth smallint NOT NULL,
    "position" integer NOT NULL,
    label text NOT NULL,
    substance jsonb,
    confidence real DEFAULT 0.5,
    temperature real DEFAULT 0.0,
    embedding_hv public.halfvec(3072) NOT NULL,
    embedding_at timestamp with time zone DEFAULT now() NOT NULL,
    embedding_model text DEFAULT 'gemini-embedding-001'::text NOT NULL,
    embedding_task_type text DEFAULT 'RETRIEVAL_DOCUMENT'::text NOT NULL,
    hash text NOT NULL,
    provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    parent_addr text,
    visibility text DEFAULT 'private'::text NOT NULL,
    node_type text,
    pinned boolean DEFAULT false NOT NULL,
    space_id text DEFAULT 'global'::text NOT NULL,
    order_score real DEFAULT 0.0,
    hemisphere_affinity real DEFAULT 0.0,
    source_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    decay_rate real DEFAULT 0.01,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    last_mined timestamp with time zone,
    stimulus_heat numeric DEFAULT 0 NOT NULL,
    source_refs jsonb DEFAULT '[]'::jsonb,
    verified_at timestamp with time zone,
    verification_method text,
    resonance_structural numeric DEFAULT 0,
    resonance_components jsonb DEFAULT '{}'::jsonb,
    confidence_by_domain jsonb DEFAULT '{}'::jsonb,
    substance_variants jsonb DEFAULT '{}'::jsonb,
    dormant_at timestamp with time zone,
    llm_awareness_score real DEFAULT 0.0,
    tenant_pyramid_id uuid,
    search_vector tsvector,
    query_hits integer DEFAULT 0,
    last_queried timestamp with time zone,
    token_weight numeric(10,4) DEFAULT 0,
    token_claimed boolean DEFAULT false,
    contributor_addr text,
    resonance real DEFAULT 0.0,
    resonance_at timestamp with time zone,
    CONSTRAINT nodes_confidence_check CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
    CONSTRAINT nodes_decay_rate_check CHECK ((decay_rate >= (0)::double precision)),
    CONSTRAINT nodes_depth_check CHECK ((depth >= 0)),
    CONSTRAINT nodes_embedding_model_check CHECK (((embedding_model IS NULL) OR (embedding_model <> ''::text))),
    CONSTRAINT nodes_embedding_model_nonempty_check CHECK ((embedding_model <> ''::text)),
    CONSTRAINT nodes_embedding_task_type_check CHECK ((embedding_task_type = ANY (ARRAY['RETRIEVAL_DOCUMENT'::text, 'DERIVED_CENTROID'::text, 'DERIVED_NUDGE'::text, 'MANUAL_RECOVERY'::text, 'legacy_unknown'::text]))),
    CONSTRAINT nodes_layer_check CHECK ((layer >= 0)),
    CONSTRAINT nodes_maturity_stage_check CHECK (((NOT (substance ? 'maturity_stage'::text)) OR ((substance ->> 'maturity_stage'::text) IS NULL) OR ((substance ->> 'maturity_stage'::text) = ANY (ARRAY['discovery'::text, 'encoded'::text, 'enriched'::text, 'proven'::text, 'graduated'::text, 'consolidated'::text, 'archived'::text, 'permanent'::text, 'repair'::text])))),
    CONSTRAINT nodes_position_check CHECK (("position" >= 0)),
    CONSTRAINT nodes_temperature_check CHECK ((temperature >= (0)::double precision)),
    CONSTRAINT nodes_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'private'::text, 'dormant'::text, 'merged'::text, 'deleted'::text])))
);


--
-- Name: node_source_depth; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.node_source_depth AS
 SELECT n.addr,
    n.label,
    n.pyramid_id,
    COALESCE(jsonb_array_length(n.source_refs), 0) AS ref_count,
    count(fi.id) AS file_refs,
    array_agg(DISTINCT fi.file_type) FILTER (WHERE (fi.file_type IS NOT NULL)) AS ref_types
   FROM (public.nodes n
     LEFT JOIN public.file_index fi ON ((fi.node_addr = n.addr)))
  GROUP BY n.addr, n.label, n.pyramid_id, n.source_refs
  ORDER BY COALESCE(jsonb_array_length(n.source_refs), 0) DESC, (count(fi.id)) DESC;


--
-- Name: oauth_authorization_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_authorization_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    nonce_hash text NOT NULL,
    client_id text NOT NULL,
    account_id uuid NOT NULL,
    tenant_id text NOT NULL,
    redirect_uri text NOT NULL,
    audience text NOT NULL,
    scopes text[] NOT NULL,
    state text,
    code_challenge text NOT NULL,
    code_challenge_method text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT oauth_authz_req_pkce_method CHECK ((code_challenge_method = 'S256'::text)),
    CONSTRAINT oauth_authz_req_scopes_canonical CHECK (((scopes = ARRAY['vo.read'::text]) OR (scopes = ARRAY['vo.read'::text, 'vo.write.intent'::text])))
);


--
-- Name: oauth_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_clients (
    client_id text NOT NULL,
    client_secret_hash text,
    client_name text,
    redirect_uris text[] NOT NULL,
    grant_types text[] NOT NULL,
    scopes text[] NOT NULL,
    token_endpoint_auth_method text NOT NULL,
    registered_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    last_used_at timestamp with time zone,
    dormant_at timestamp with time zone,
    archived_at timestamp with time zone,
    CONSTRAINT oauth_clients_auth_method_public CHECK ((token_endpoint_auth_method = 'none'::text)),
    CONSTRAINT oauth_clients_client_name_shape CHECK (((client_name IS NULL) OR (((char_length(client_name) >= 1) AND (char_length(client_name) <= 120)) AND (client_name !~ '[[:cntrl:]]'::text)))),
    CONSTRAINT oauth_clients_grant_types_includes_authcode CHECK (('authorization_code'::text = ANY (grant_types))),
    CONSTRAINT oauth_clients_grant_types_subset_supported CHECK ((grant_types <@ ARRAY['authorization_code'::text, 'refresh_token'::text])),
    CONSTRAINT oauth_clients_redirect_uris_nonempty CHECK ((cardinality(redirect_uris) >= 1)),
    CONSTRAINT oauth_clients_scopes_canonical CHECK (((scopes = ARRAY['vo.read'::text]) OR (scopes = ARRAY['vo.read'::text, 'vo.write.intent'::text]))),
    CONSTRAINT oauth_clients_status_check CHECK ((status = ANY (ARRAY['active'::text, 'dormant'::text, 'archived'::text, 'revoked'::text])))
);


--
-- Name: oauth_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_grants (
    id uuid NOT NULL,
    client_id text NOT NULL,
    access_token_hash text,
    refresh_token_hash text,
    auth_code_hash text,
    account_id uuid NOT NULL,
    tenant_id text NOT NULL,
    agent_id text NOT NULL,
    hosted_agent_credential_id uuid NOT NULL,
    scopes text[] NOT NULL,
    audience text NOT NULL,
    code_challenge text,
    code_challenge_method text,
    redirect_uri text,
    state text,
    expires_at timestamp with time zone,
    refresh_expires_at timestamp with time zone,
    refresh_inactivity_at timestamp with time zone,
    status text NOT NULL,
    revoked_reason text,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    consumed_at timestamp with time zone,
    grant_family_id uuid NOT NULL,
    parent_grant_id uuid,
    revoked_at timestamp with time zone,
    CONSTRAINT oauth_grants_pkce_method CHECK (((code_challenge_method IS NULL) OR (code_challenge_method = 'S256'::text))),
    CONSTRAINT oauth_grants_scopes_canonical CHECK (((scopes = ARRAY['vo.read'::text]) OR (scopes = ARRAY['vo.read'::text, 'vo.write.intent'::text]))),
    CONSTRAINT oauth_grants_status_check CHECK ((status = ANY (ARRAY['active'::text, 'consumed'::text, 'revoked'::text, 'expired'::text])))
);


--
-- Name: proposal_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.proposal_embeddings (
    id bigint NOT NULL,
    proposal_id integer NOT NULL,
    embedding_hv public.halfvec(3072) NOT NULL,
    embedding_model text NOT NULL,
    embedding_task_type text DEFAULT 'RETRIEVAL_DOCUMENT'::text NOT NULL,
    embedded_text_hash text NOT NULL,
    source_payload_hash text NOT NULL,
    purpose text DEFAULT 'archetype_dedup'::text NOT NULL,
    embedded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proposal_embeddings_embedded_text_hash_check CHECK ((embedded_text_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT proposal_embeddings_embedding_model_check CHECK ((embedding_model <> ''::text)),
    CONSTRAINT proposal_embeddings_embedding_task_type_check CHECK ((embedding_task_type <> ''::text)),
    CONSTRAINT proposal_embeddings_purpose_check CHECK ((purpose <> ''::text)),
    CONSTRAINT proposal_embeddings_source_payload_hash_check CHECK ((source_payload_hash ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: proposal_embeddings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.proposal_embeddings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: proposal_embeddings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.proposal_embeddings_id_seq OWNED BY public.proposal_embeddings.id;


--
-- Name: proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.proposals (
    id integer NOT NULL,
    proposal_type text NOT NULL,
    from_addr text,
    to_addr text,
    target_addr text,
    payload jsonb NOT NULL,
    confidence real DEFAULT 0.5,
    discovered_by text NOT NULL,
    evidence jsonb DEFAULT '[]'::jsonb,
    status text DEFAULT 'pending'::text,
    reviewed_by text,
    reviewed_at timestamp with time zone,
    applied_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proposals_proposal_type_check CHECK ((proposal_type = ANY (ARRAY['tension'::text, 'inference'::text, 'archetype'::text, 'node_edit'::text, 'edge'::text]))),
    CONSTRAINT proposals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'applied'::text])))
);


--
-- Name: proposals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.proposals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: proposals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.proposals_id_seq OWNED BY public.proposals.id;


--
-- Name: public_contribution_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.public_contribution_events (
    id bigint NOT NULL,
    publication_id bigint,
    source_space_id text NOT NULL,
    source_addr text NOT NULL,
    target_addr text,
    event_type text NOT NULL,
    actor text,
    event_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT public_contribution_events_event_type_check CHECK ((event_type = ANY (ARRAY['publication_created'::text, 'publication_updated'::text, 'publication_reviewed'::text, 'publication_superseded'::text, 'publication_archived'::text])))
);


--
-- Name: public_contribution_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.public_contribution_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: public_contribution_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.public_contribution_events_id_seq OWNED BY public.public_contribution_events.id;


--
-- Name: query_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.query_embeddings (
    content_hash text NOT NULL,
    embedding public.halfvec(3072) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    hit_count integer DEFAULT 1 NOT NULL
);


--
-- Name: query_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.query_log (
    id integer NOT NULL,
    query text NOT NULL,
    results_returned integer DEFAULT 0,
    top_addr text,
    top_similarity real,
    agent_id text,
    created_at timestamp with time zone DEFAULT now(),
    returned_addrs jsonb
);


--
-- Name: query_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.query_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: query_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.query_log_id_seq OWNED BY public.query_log.id;


--
-- Name: recall_outcome_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recall_outcome_events (
    id bigint NOT NULL,
    recall_id uuid NOT NULL,
    tenant_id text NOT NULL,
    space_id text NOT NULL,
    agent_id text,
    query text,
    event_type text NOT NULL,
    memory_addrs text[] DEFAULT '{}'::text[] NOT NULL,
    top_addr text,
    outcome_score numeric(5,3) DEFAULT 0 NOT NULL,
    action_context text,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    source text DEFAULT 'recall_compiler'::text NOT NULL,
    correlation_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recall_outcome_events_event_type_check CHECK ((event_type = ANY (ARRAY['recalled'::text, 'used'::text, 'ignored'::text, 'supported_action'::text, 'confused'::text, 'contradicted'::text, 'wasted_context'::text, 'user_corrected'::text, 'missing_memory'::text]))),
    CONSTRAINT recall_outcome_events_evidence_check CHECK ((jsonb_typeof(evidence) = 'object'::text)),
    CONSTRAINT recall_outcome_events_evidence_check1 CHECK ((length((evidence)::text) <= 8192)),
    CONSTRAINT recall_outcome_events_outcome_score_check CHECK (((outcome_score >= ('-1'::integer)::numeric) AND (outcome_score <= (1)::numeric)))
);


--
-- Name: recall_outcome_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.recall_outcome_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: recall_outcome_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.recall_outcome_events_id_seq OWNED BY public.recall_outcome_events.id;


--
-- Name: registry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.registry (
    pyramid_id text NOT NULL,
    label text NOT NULL,
    description text,
    node_count integer DEFAULT 0,
    edge_count integer DEFAULT 0,
    saturated boolean DEFAULT false,
    hot_regions jsonb DEFAULT '[]'::jsonb,
    apex_hash text,
    owner_id uuid,
    access_level text DEFAULT 'private'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT registry_access_level_check CHECK ((access_level = ANY (ARRAY['private'::text, 'shared'::text, 'public'::text, 'dao'::text])))
);


--
-- Name: remote_commands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.remote_commands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    account_id uuid NOT NULL,
    category text NOT NULL,
    command_type text NOT NULL,
    target_node_id text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    claimed_at timestamp with time zone,
    claimed_by text,
    result jsonb,
    idempotency_key text,
    origin_session_type text DEFAULT 'hosted-browser-session'::text NOT NULL,
    origin_session_id text,
    origin_credential_id uuid,
    origin_actor_label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    CONSTRAINT remote_commands_category_check CHECK ((category = ANY (ARRAY['memory_lifecycle'::text, 'structure'::text, 'settings'::text, 'account_sync'::text, 'providers'::text, 'routines'::text]))),
    CONSTRAINT remote_commands_origin_session_type_check CHECK ((origin_session_type = ANY (ARRAY['hosted-browser-session'::text, 'hosted-mcp-agent'::text]))),
    CONSTRAINT remote_commands_origin_shape_check CHECK ((((origin_session_type = 'hosted-browser-session'::text) AND (origin_credential_id IS NULL)) OR ((origin_session_type = 'hosted-mcp-agent'::text) AND (origin_session_id IS NOT NULL) AND (origin_credential_id IS NOT NULL) AND (origin_actor_label IS NOT NULL) AND (btrim(origin_actor_label) <> ''::text)))),
    CONSTRAINT remote_commands_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'claimed'::text, 'applied'::text, 'rejected'::text, 'failed'::text, 'canceled'::text, 'expired'::text])))
);


--
-- Name: resonance_by_pyramid; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.resonance_by_pyramid AS
 SELECT pyramid_id,
    count(*) AS nodes,
    round((avg(resonance))::numeric, 3) AS avg_resonance,
    round((min(resonance))::numeric, 3) AS min_resonance,
    round((max(resonance))::numeric, 3) AS max_resonance,
    round(sum(token_weight), 2) AS total_token_weight
   FROM public.nodes
  GROUP BY pyramid_id
  ORDER BY (round((avg(resonance))::numeric, 3)) DESC;


--
-- Name: resonance_changelog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resonance_changelog (
    id integer NOT NULL,
    node_addr text NOT NULL,
    old_resonance numeric,
    new_resonance numeric,
    delta numeric,
    trigger_type text NOT NULL,
    stimulus_ids integer[],
    heat_weight_used numeric,
    computed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: resonance_changelog_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.resonance_changelog_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: resonance_changelog_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.resonance_changelog_id_seq OWNED BY public.resonance_changelog.id;


--
-- Name: resonance_leaders; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.resonance_leaders AS
 SELECT addr,
    pyramid_id,
    label,
    layer,
    resonance,
    confidence,
    query_hits,
    token_weight,
    rank() OVER (ORDER BY resonance DESC) AS rank
   FROM public.nodes
  ORDER BY resonance DESC;


--
-- Name: resonance_weights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resonance_weights (
    key text NOT NULL,
    weight real NOT NULL,
    description text
);


--
-- Name: review_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_proposals (
    id bigint NOT NULL,
    tenant_id text,
    review_kind text NOT NULL,
    candidate_source text NOT NULL,
    severity text NOT NULL,
    summary text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    idempotency_key text NOT NULL,
    next_review_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT review_proposals_candidate_source_check CHECK ((candidate_source = ANY (ARRAY['memory_conflict'::text, 'recall_conflict'::text, 'lifecycle_atomicity'::text, 'reviewable_memory'::text, 'recall_stale'::text, 'edge_tension'::text]))),
    CONSTRAINT review_proposals_review_kind_check CHECK ((review_kind = ANY (ARRAY['contradiction_review'::text, 'edge_quality_review'::text, 'stale_conflict_review'::text, 'source_promotion_review'::text]))),
    CONSTRAINT review_proposals_severity_check CHECK ((severity = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text]))),
    CONSTRAINT review_proposals_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text, 'dismissed'::text])))
);


--
-- Name: review_proposals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.review_proposals ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.review_proposals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: scanner_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scanner_rules (
    id integer NOT NULL,
    name text NOT NULL,
    description text,
    enabled boolean DEFAULT true,
    field_path text NOT NULL,
    comparison text NOT NULL,
    threshold real,
    produces_tension_type text NOT NULL,
    default_tension real DEFAULT 0.5,
    same_pyramid_only boolean DEFAULT false,
    node_types text[],
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT scanner_rules_comparison_check CHECK ((comparison = ANY (ARRAY['exact_match'::text, 'array_overlap'::text, 'semantic_distance'::text, 'confidence_gap'::text]))),
    CONSTRAINT scanner_rules_produces_tension_type_check CHECK ((produces_tension_type = ANY (ARRAY['tradeoff'::text, 'paradox'::text, 'constraint'::text, 'complement'::text, 'contradiction'::text])))
);


--
-- Name: scanner_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.scanner_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: scanner_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.scanner_rules_id_seq OWNED BY public.scanner_rules.id;


--
-- Name: scanner_run_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scanner_run_log (
    id integer NOT NULL,
    run_type text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    nodes_scanned integer DEFAULT 0,
    comparisons_made integer DEFAULT 0,
    tensions_created integer DEFAULT 0,
    tensions_updated integer DEFAULT 0,
    proposals_created integer DEFAULT 0,
    errors integer DEFAULT 0,
    error_details jsonb DEFAULT '[]'::jsonb,
    wall_clock_ms integer
);


--
-- Name: scanner_run_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.scanner_run_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: scanner_run_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.scanner_run_log_id_seq OWNED BY public.scanner_run_log.id;


--
-- Name: scanner_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scanner_state (
    node_addr text NOT NULL,
    last_scanned_offset integer DEFAULT 0,
    last_scanned_at timestamp with time zone,
    total_neighbors integer DEFAULT 0,
    tensions_found integer DEFAULT 0
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    filename text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    checksum text NOT NULL,
    duration_ms integer,
    phase text,
    manifest_version integer DEFAULT 1 NOT NULL,
    source text DEFAULT 'runner'::text NOT NULL,
    CONSTRAINT schema_migrations_source_check CHECK ((source = ANY (ARRAY['runner'::text, 'legacy-backfill'::text, 'manual'::text])))
);


--
-- Name: source_domain_authority; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_domain_authority (
    source text NOT NULL,
    domain text NOT NULL,
    authority numeric DEFAULT 0.5 NOT NULL
);


--
-- Name: source_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_history (
    id integer NOT NULL,
    source_hash text NOT NULL,
    source_type text NOT NULL,
    source_id text NOT NULL,
    source_title text,
    atom_count integer DEFAULT 0,
    in_count integer DEFAULT 0,
    on_count integer DEFAULT 0,
    queue_count integer DEFAULT 0,
    cost_usd real DEFAULT 0,
    ingest_batch_id text NOT NULL,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL,
    rolled_back boolean DEFAULT false,
    status text DEFAULT 'done'::text,
    normalized_url text,
    last_error text,
    updated_at timestamp with time zone DEFAULT now(),
    space_id text DEFAULT 'global'::text NOT NULL
);


--
-- Name: source_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.source_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: source_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.source_history_id_seq OWNED BY public.source_history.id;


--
-- Name: source_trust; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_trust (
    agent_id text NOT NULL,
    approved_count integer DEFAULT 0 NOT NULL,
    rejected_count integer DEFAULT 0 NOT NULL,
    revised_count integer DEFAULT 0 NOT NULL,
    trust_score real DEFAULT 0.5 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: space_pyramids; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.space_pyramids (
    space_id text NOT NULL,
    pyramid_id text NOT NULL,
    access_level text DEFAULT 'private'::text NOT NULL,
    node_count integer DEFAULT 0 NOT NULL,
    edge_count integer DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT space_pyramids_access_level_check CHECK ((access_level = ANY (ARRAY['private'::text, 'shared'::text, 'public'::text, 'dao'::text])))
);


--
-- Name: staging_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staging_edges (
    id integer NOT NULL,
    run_id text NOT NULL,
    from_addr text NOT NULL,
    to_addr text NOT NULL,
    edge_type text NOT NULL,
    layer integer DEFAULT 1 NOT NULL,
    label text NOT NULL,
    confidence double precision DEFAULT 0.65 NOT NULL,
    qc_status text DEFAULT 'pending'::text NOT NULL,
    qc_agent text,
    qc_notes text,
    qc_timestamp timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    space_id text DEFAULT 'global'::text NOT NULL,
    from_space_id text DEFAULT 'global'::text NOT NULL,
    to_space_id text DEFAULT 'global'::text NOT NULL,
    source_context jsonb DEFAULT '{}'::jsonb,
    claimed_at timestamp with time zone,
    claimed_by text,
    retry_after timestamp with time zone,
    revision_count integer DEFAULT 0 NOT NULL,
    last_error text,
    CONSTRAINT staging_edges_no_self_loop CHECK ((from_addr <> to_addr)),
    CONSTRAINT staging_edges_nonblank_label CHECK ((btrim(label) <> ''::text)),
    CONSTRAINT staging_edges_nonblank_type CHECK ((btrim(edge_type) <> ''::text)),
    CONSTRAINT staging_edges_source_context_object CHECK (((source_context IS NULL) OR (jsonb_typeof(source_context) = 'object'::text)))
);


--
-- Name: staging_edges_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staging_edges_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staging_edges_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staging_edges_id_seq OWNED BY public.staging_edges.id;


--
-- Name: staging_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staging_nodes (
    id integer NOT NULL,
    run_id text NOT NULL,
    addr text NOT NULL,
    pyramid_id text NOT NULL,
    layer integer DEFAULT 0 NOT NULL,
    depth integer NOT NULL,
    "position" integer DEFAULT 1 NOT NULL,
    label text NOT NULL,
    substance jsonb NOT NULL,
    confidence double precision DEFAULT 0.65 NOT NULL,
    parent_addr text,
    visibility text DEFAULT 'private'::text NOT NULL,
    qc_status text DEFAULT 'pending'::text NOT NULL,
    qc_agent text,
    qc_notes text,
    qc_timestamp timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    space_id text DEFAULT 'global'::text NOT NULL,
    source_context jsonb DEFAULT '{}'::jsonb,
    claimed_at timestamp with time zone,
    claimed_by text,
    retry_after timestamp with time zone,
    revision_count integer DEFAULT 0 NOT NULL,
    last_error text
);


--
-- Name: staging_nodes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staging_nodes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staging_nodes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staging_nodes_id_seq OWNED BY public.staging_nodes.id;


--
-- Name: staging_updates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staging_updates (
    id integer NOT NULL,
    run_id text NOT NULL,
    addr text NOT NULL,
    field text NOT NULL,
    old_value jsonb,
    new_value jsonb NOT NULL,
    reason text NOT NULL,
    qc_status text DEFAULT 'pending'::text NOT NULL,
    qc_agent text,
    qc_notes text,
    qc_timestamp timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    space_id text DEFAULT 'global'::text NOT NULL,
    claimed_at timestamp with time zone,
    claimed_by text,
    retry_after timestamp with time zone,
    revision_count integer DEFAULT 0 NOT NULL,
    last_error text
);


--
-- Name: staging_updates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staging_updates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staging_updates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staging_updates_id_seq OWNED BY public.staging_updates.id;


--
-- Name: stimuli; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stimuli (
    id integer NOT NULL,
    source text NOT NULL,
    source_id text,
    stimulus_type text NOT NULL,
    urgency numeric DEFAULT 0.5 NOT NULL,
    content text NOT NULL,
    url text,
    embedding public.halfvec(3072),
    decay_halflife_hours numeric DEFAULT 24 NOT NULL,
    peak_delay_hours numeric DEFAULT 0 NOT NULL,
    processed boolean DEFAULT false NOT NULL,
    processed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    correlation_id text,
    parent_stimulus_id integer,
    node_addr text,
    similarity real,
    energy real DEFAULT 1.0,
    is_orphan boolean DEFAULT false,
    orphan_status text,
    ingest_batch_id text,
    temporality text,
    proto_cluster_id uuid,
    space_id text DEFAULT 'global'::text NOT NULL,
    origin_key text,
    origin_kind text,
    origin_label text,
    CONSTRAINT stimuli_energy_bounds_check CHECK (((energy IS NULL) OR ((energy >= (0)::double precision) AND (energy <= (1)::double precision)))),
    CONSTRAINT stimuli_orphan_status_check CHECK (((orphan_status IS NULL) OR (orphan_status = ANY (ARRAY['throbbing'::text, 'promoted'::text, 'adopted'::text, 'dissolved'::text])))),
    CONSTRAINT stimuli_temporality_check CHECK (((temporality IS NULL) OR (temporality = ANY (ARRAY['DURABLE'::text, 'CURRENT'::text, 'EPHEMERAL'::text]))))
);


--
-- Name: stimuli_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stimuli_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stimuli_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stimuli_id_seq OWNED BY public.stimuli.id;


--
-- Name: stimulus_conflicts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stimulus_conflicts (
    id integer NOT NULL,
    node_addr text NOT NULL,
    stimulus_a integer NOT NULL,
    stimulus_b integer NOT NULL,
    conflict_type text NOT NULL,
    resolved boolean DEFAULT false NOT NULL,
    resolution text,
    flagged_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stimulus_conflicts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stimulus_conflicts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stimulus_conflicts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stimulus_conflicts_id_seq OWNED BY public.stimulus_conflicts.id;


--
-- Name: stimulus_contributions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stimulus_contributions (
    stimulus_id integer NOT NULL,
    node_addr text NOT NULL,
    channel text DEFAULT 'relevance'::text NOT NULL,
    contribution numeric DEFAULT 0 NOT NULL,
    base_contribution numeric DEFAULT 0 NOT NULL,
    relevance numeric NOT NULL,
    urgency numeric NOT NULL,
    priority_score numeric GENERATED ALWAYS AS ((relevance * urgency)) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    correlation_id text,
    decay_halflife_hours_override numeric,
    peak_delay_hours_override numeric
);


--
-- Name: stimulus_moons; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.stimulus_moons AS
 SELECT id,
    parent_stimulus_id,
    node_addr,
    similarity,
    energy,
    content,
    stimulus_type,
    is_orphan,
    orphan_status,
    decay_halflife_hours,
    created_at,
    public.stimulus_opacity(energy, (decay_halflife_hours)::real, created_at) AS current_opacity,
    embedding,
        CASE
            WHEN (is_orphan AND (orphan_status = 'throbbing'::text)) THEN 'throbbing'::text
            WHEN (public.stimulus_opacity(energy, (decay_halflife_hours)::real, created_at) < (0.01)::double precision) THEN 'expired'::text
            WHEN (public.stimulus_opacity(energy, (decay_halflife_hours)::real, created_at) > (0.7)::double precision) THEN 'bright'::text
            WHEN (public.stimulus_opacity(energy, (decay_halflife_hours)::real, created_at) > (0.3)::double precision) THEN 'fading'::text
            ELSE 'dim'::text
        END AS visual_state
   FROM public.stimuli s
  WHERE ((public.stimulus_opacity(energy, (decay_halflife_hours)::real, created_at) > (0.01)::double precision) OR (is_orphan AND (orphan_status = 'throbbing'::text)));


--
-- Name: subscription_entitlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_entitlements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    tier text DEFAULT 'free'::text NOT NULL,
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    valid_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscription_entitlements_tier_check CHECK ((tier = ANY (ARRAY['free'::text, 'plus'::text])))
);


--
-- Name: supercron_manual_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supercron_manual_runs (
    id bigint NOT NULL,
    tenant_id text NOT NULL,
    supercron_run_id bigint,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    requested_by text NOT NULL,
    budget_micro bigint NOT NULL,
    actual_spend_micro bigint,
    status text NOT NULL,
    rejection_reason text,
    tenant_space_id text NOT NULL,
    CONSTRAINT supercron_manual_runs_actual_spend_micro_check CHECK (((actual_spend_micro IS NULL) OR (actual_spend_micro >= 0))),
    CONSTRAINT supercron_manual_runs_budget_micro_check CHECK (((budget_micro >= 0) AND (budget_micro <= 10000000))),
    CONSTRAINT supercron_manual_runs_check CHECK (((actual_spend_micro IS NULL) OR (actual_spend_micro <= budget_micro))),
    CONSTRAINT supercron_manual_runs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text, 'rejected'::text]))),
    CONSTRAINT supercron_manual_runs_tenant_space_check CHECK ((tenant_space_id = ('tenant:'::text || tenant_id)))
);


--
-- Name: supercron_manual_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.supercron_manual_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: supercron_manual_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.supercron_manual_runs_id_seq OWNED BY public.supercron_manual_runs.id;


--
-- Name: supercron_node_gc_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supercron_node_gc_receipts (
    id bigint NOT NULL,
    batch_id uuid NOT NULL,
    tenant_id text NOT NULL,
    tenant_space_id text NOT NULL,
    addr text NOT NULL,
    marked_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'candidate'::text NOT NULL,
    predicate_version integer DEFAULT 1 NOT NULL,
    eligibility jsonb DEFAULT '{}'::jsonb NOT NULL,
    reviewed_by text,
    reviewed_at timestamp with time zone,
    rejection_reason text,
    expires_at timestamp with time zone,
    applied_at timestamp with time zone,
    applied_action text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT supercron_node_gc_receipts_addr_check CHECK (((addr = btrim(addr)) AND (addr <> ''::text))),
    CONSTRAINT supercron_node_gc_receipts_applied_action_check CHECK (((applied_action IS NULL) OR (applied_action = ANY (ARRAY['tombstone'::text, 'delete'::text])))),
    CONSTRAINT supercron_node_gc_receipts_check CHECK ((tenant_space_id = ('tenant:'::text || tenant_id))),
    CONSTRAINT supercron_node_gc_receipts_check1 CHECK (((status <> 'applied'::text) OR (applied_action IS NOT NULL))),
    CONSTRAINT supercron_node_gc_receipts_check2 CHECK (((status <> 'applied'::text) OR (applied_at IS NOT NULL))),
    CONSTRAINT supercron_node_gc_receipts_check3 CHECK (((status = 'applied'::text) OR (applied_action IS NULL))),
    CONSTRAINT supercron_node_gc_receipts_check4 CHECK (((status = 'applied'::text) OR (applied_at IS NULL))),
    CONSTRAINT supercron_node_gc_receipts_check5 CHECK (((status <> 'rejected'::text) OR ((expires_at IS NOT NULL) AND (rejection_reason IS NOT NULL)))),
    CONSTRAINT supercron_node_gc_receipts_check6 CHECK (((status = ANY (ARRAY['rejected'::text, 'expired'::text])) OR ((expires_at IS NULL) AND (rejection_reason IS NULL)))),
    CONSTRAINT supercron_node_gc_receipts_eligibility_check CHECK ((jsonb_typeof(eligibility) = 'object'::text)),
    CONSTRAINT supercron_node_gc_receipts_predicate_version_check CHECK ((predicate_version >= 1)),
    CONSTRAINT supercron_node_gc_receipts_reviewed_approval_check CHECK (((status <> ALL (ARRAY['approved'::text, 'applied'::text])) OR ((reviewed_at IS NOT NULL) AND (reviewed_by IS NOT NULL) AND (btrim(reviewed_by) <> ''::text)))),
    CONSTRAINT supercron_node_gc_receipts_reviewed_at_not_future_check CHECK (((reviewed_at IS NULL) OR (reviewed_at <= (now() + '1 day'::interval)))),
    CONSTRAINT supercron_node_gc_receipts_status_check CHECK ((status = ANY (ARRAY['candidate'::text, 'approved'::text, 'rejected'::text, 'applied'::text, 'expired'::text]))),
    CONSTRAINT supercron_node_gc_receipts_tenant_id_check CHECK ((tenant_id ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'::text))
);


--
-- Name: supercron_node_gc_receipts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.supercron_node_gc_receipts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: supercron_node_gc_receipts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.supercron_node_gc_receipts_id_seq OWNED BY public.supercron_node_gc_receipts.id;


--
-- Name: supercron_pass_telemetry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supercron_pass_telemetry (
    id bigint NOT NULL,
    supercron_run_id bigint NOT NULL,
    pass_name text NOT NULL,
    ms integer DEFAULT 0 NOT NULL,
    actions integer DEFAULT 0 NOT NULL,
    llm_tokens_in bigint,
    llm_tokens_out bigint,
    llm_cost_usd_micro bigint,
    proposals_created integer DEFAULT 0 NOT NULL,
    proposals_applied integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT supercron_pass_telemetry_actions_check CHECK ((actions >= 0)),
    CONSTRAINT supercron_pass_telemetry_llm_cost_usd_micro_check CHECK (((llm_cost_usd_micro IS NULL) OR (llm_cost_usd_micro >= 0))),
    CONSTRAINT supercron_pass_telemetry_llm_tokens_in_check CHECK (((llm_tokens_in IS NULL) OR (llm_tokens_in >= 0))),
    CONSTRAINT supercron_pass_telemetry_llm_tokens_out_check CHECK (((llm_tokens_out IS NULL) OR (llm_tokens_out >= 0))),
    CONSTRAINT supercron_pass_telemetry_ms_check CHECK ((ms >= 0)),
    CONSTRAINT supercron_pass_telemetry_pass_name_check CHECK (((length(btrim(pass_name)) >= 1) AND (length(btrim(pass_name)) <= 120))),
    CONSTRAINT supercron_pass_telemetry_pass_name_check1 CHECK ((pass_name = btrim(pass_name))),
    CONSTRAINT supercron_pass_telemetry_proposals_applied_check CHECK ((proposals_applied >= 0)),
    CONSTRAINT supercron_pass_telemetry_proposals_created_check CHECK ((proposals_created >= 0))
);


--
-- Name: supercron_pass_telemetry_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.supercron_pass_telemetry_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: supercron_pass_telemetry_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.supercron_pass_telemetry_id_seq OWNED BY public.supercron_pass_telemetry.id;


--
-- Name: supercron_routine_suppression; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supercron_routine_suppression (
    id bigint NOT NULL,
    tenant_id text,
    routine_name text NOT NULL,
    suppressed_until timestamp with time zone NOT NULL,
    reason text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: supercron_routine_suppression_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.supercron_routine_suppression_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: supercron_routine_suppression_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.supercron_routine_suppression_id_seq OWNED BY public.supercron_routine_suppression.id;


--
-- Name: supercron_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supercron_runs (
    id integer NOT NULL,
    run_id text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    pyramid_focus text,
    tier1_ms integer,
    tier2_ms integer,
    tier3_ms integer,
    tier4_ms integer,
    pass_results jsonb,
    total_actions integer DEFAULT 0,
    status text DEFAULT 'running'::text NOT NULL,
    quality_report jsonb DEFAULT '{"after": {}, "delta": {}, "before": {}, "degraded": false, "warnings": [], "pass_errors": [], "cooldown_events": [], "degraded_reason": null, "snapshot_skipped": false, "audit_events_written": 0, "snapshot_overhead_ms": 0}'::jsonb NOT NULL,
    degraded_reason text
);


--
-- Name: supercron_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.supercron_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: supercron_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.supercron_runs_id_seq OWNED BY public.supercron_runs.id;


--
-- Name: supercron_tenant_budget_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supercron_tenant_budget_state (
    tenant_id text NOT NULL,
    daily_cap_micro bigint DEFAULT 170000 NOT NULL,
    carryover_balance_micro bigint DEFAULT 0 NOT NULL,
    spend_today_micro bigint DEFAULT 0 NOT NULL,
    manual_spend_today_micro bigint DEFAULT 0 NOT NULL,
    last_rollover_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_space_id text NOT NULL,
    CONSTRAINT supercron_tenant_budget_state_carryover_balance_micro_check CHECK ((carryover_balance_micro >= 0)),
    CONSTRAINT supercron_tenant_budget_state_check CHECK ((carryover_balance_micro <= (daily_cap_micro * 7))),
    CONSTRAINT supercron_tenant_budget_state_daily_cap_micro_check CHECK (((daily_cap_micro >= 100000) AND (daily_cap_micro <= 2000000))),
    CONSTRAINT supercron_tenant_budget_state_manual_spend_today_micro_check CHECK (((manual_spend_today_micro >= 0) AND (manual_spend_today_micro <= 20000000))),
    CONSTRAINT supercron_tenant_budget_state_spend_today_micro_check CHECK ((spend_today_micro >= 0)),
    CONSTRAINT supercron_tenant_budget_state_tenant_space_check CHECK ((tenant_space_id = ('tenant:'::text || tenant_id)))
);


--
-- Name: supersession_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supersession_candidates (
    id integer NOT NULL,
    newer_stimulus_id integer NOT NULL,
    older_stimulus_id integer NOT NULL,
    similarity numeric NOT NULL,
    node_overlap_pct numeric NOT NULL,
    detection_method text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    resolved_by text,
    resolved_at timestamp with time zone,
    flagged_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: supersession_candidates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.supersession_candidates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: supersession_candidates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.supersession_candidates_id_seq OWNED BY public.supersession_candidates.id;


--
-- Name: sync_journal; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_journal (
    seq bigint NOT NULL,
    item_type text NOT NULL,
    op text NOT NULL,
    item_key text NOT NULL,
    addr text,
    from_addr text,
    to_addr text,
    edge_type text,
    governance_key text,
    space_id text,
    project_addr text,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    payload_json jsonb,
    CONSTRAINT sync_journal_item_type_check CHECK ((item_type = ANY (ARRAY['memory'::text, 'edge'::text, 'project'::text, 'governance'::text, 'vault_dossier'::text, 'vault_drive_file'::text, 'journal_entry'::text]))),
    CONSTRAINT sync_journal_item_type_op_pair_check CHECK ((((item_type = 'memory'::text) AND (op = ANY (ARRAY['upsert'::text, 'tombstone'::text]))) OR ((item_type = 'edge'::text) AND (op = ANY (ARRAY['upsert'::text, 'delete'::text]))) OR ((item_type = 'project'::text) AND (op = ANY (ARRAY['upsert'::text, 'archive'::text]))) OR ((item_type = 'governance'::text) AND (op = 'upsert'::text)) OR ((item_type = 'vault_dossier'::text) AND (op = ANY (ARRAY['upsert'::text, 'tombstone'::text]))) OR ((item_type = 'vault_drive_file'::text) AND (op = ANY (ARRAY['upsert'::text, 'trash'::text, 'move'::text]))) OR ((item_type = 'journal_entry'::text) AND (op = ANY (ARRAY['upsert'::text, 'tombstone'::text]))))),
    CONSTRAINT sync_journal_op_check CHECK ((op = ANY (ARRAY['upsert'::text, 'tombstone'::text, 'delete'::text, 'archive'::text, 'trash'::text, 'move'::text])))
);


--
-- Name: sync_journal_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sync_journal_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sync_journal_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sync_journal_seq_seq OWNED BY public.sync_journal.seq;


--
-- Name: temporal_intake; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.temporal_intake (
    id integer NOT NULL,
    target_day text NOT NULL,
    content text NOT NULL,
    projects text[] DEFAULT '{}'::text[],
    people text[] DEFAULT '{}'::text[],
    tags text[] DEFAULT '{}'::text[],
    energy real,
    status text DEFAULT 'pending'::text,
    resolved_addrs text[] DEFAULT '{}'::text[],
    space_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    processed_at timestamp with time zone
);


--
-- Name: temporal_intake_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.temporal_intake_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: temporal_intake_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.temporal_intake_id_seq OWNED BY public.temporal_intake.id;


--
-- Name: tenant_day_journal_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_day_journal_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    space_id text GENERATED ALWAYS AS (('tenant:'::text || tenant_id)) STORED,
    entry_key text NOT NULL,
    day_addr text NOT NULL,
    target_date date NOT NULL,
    target_timezone text NOT NULL,
    routine_id text NOT NULL,
    target_path text NOT NULL,
    project_addr text,
    schema text NOT NULL,
    sensitivity text DEFAULT 'personal'::text NOT NULL,
    routine_class text DEFAULT 'context_only'::text NOT NULL,
    result_status text NOT NULL,
    entry_state text DEFAULT 'active'::text NOT NULL,
    captured_at timestamp with time zone NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    payload_json jsonb,
    payload_preview jsonb DEFAULT '{}'::jsonb NOT NULL,
    payload_hash text NOT NULL,
    source_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    latest_run_id uuid,
    idempotency_namespace text,
    idempotency_key_sha256 text,
    request_hash text NOT NULL,
    created_by_command_id uuid,
    last_mutation_kind text DEFAULT 'create'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_day_journal_entries_check CHECK (((routine_id = 'manual.tenant_entry'::text) OR ((captured_at >= (((target_date)::timestamp without time zone AT TIME ZONE 'UTC'::text) - '14:00:00'::interval)) AND (captured_at < (((target_date)::timestamp without time zone AT TIME ZONE 'UTC'::text) + '36:00:00'::interval))))),
    CONSTRAINT tenant_day_journal_entries_check1 CHECK ((((entry_state = 'active'::text) AND (payload_json IS NOT NULL)) OR ((entry_state = ANY (ARRAY['retracted'::text, 'redacted'::text])) AND (payload_json IS NULL) AND (payload_preview = '{}'::jsonb)))),
    CONSTRAINT tenant_day_journal_entries_check2 CHECK ((day_addr = ((('TMP.'::text || lpad(((EXTRACT(year FROM target_date))::integer)::text, 4, '0'::text)) || '.'::text) || lpad(((EXTRACT(doy FROM target_date))::integer)::text, 3, '0'::text)))),
    CONSTRAINT tenant_day_journal_entries_check3 CHECK (((idempotency_key_sha256 IS NULL) OR (idempotency_namespace IS NOT NULL))),
    CONSTRAINT tenant_day_journal_entries_day_addr_check CHECK (((day_addr = btrim(day_addr)) AND (day_addr ~ '^TMP\.[0-9]{4}\.(00[1-9]|0[1-9][0-9]|[1-2][0-9]{2}|3[0-5][0-9]|36[0-6])$'::text))),
    CONSTRAINT tenant_day_journal_entries_day_addr_doy_check CHECK (((day_addr = btrim(day_addr)) AND (day_addr ~ '^TMP\.[0-9]{4}\.(00[1-9]|0[1-9][0-9]|[1-2][0-9]{2}|3[0-5][0-9]|36[0-6])$'::text))),
    CONSTRAINT tenant_day_journal_entries_day_addr_target_date_check CHECK ((day_addr = ((('TMP.'::text || lpad(((EXTRACT(year FROM target_date))::integer)::text, 4, '0'::text)) || '.'::text) || lpad(((EXTRACT(doy FROM target_date))::integer)::text, 3, '0'::text)))),
    CONSTRAINT tenant_day_journal_entries_entry_key_check CHECK ((entry_key ~ '^(entry_[0-9]{8}_[a-f0-9]{16}|routine_[a-f0-9]{16})$'::text)),
    CONSTRAINT tenant_day_journal_entries_entry_state_check CHECK ((entry_state = ANY (ARRAY['active'::text, 'retracted'::text, 'redacted'::text]))),
    CONSTRAINT tenant_day_journal_entries_idempotency_key_sha256_check CHECK (((idempotency_key_sha256 IS NULL) OR (idempotency_key_sha256 ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT tenant_day_journal_entries_idempotency_namespace_check CHECK (((idempotency_namespace IS NULL) OR ((idempotency_namespace = btrim(idempotency_namespace)) AND (idempotency_namespace ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'::text)))),
    CONSTRAINT tenant_day_journal_entries_idempotency_requires_namespace_check CHECK (((idempotency_key_sha256 IS NULL) OR (idempotency_namespace IS NOT NULL))),
    CONSTRAINT tenant_day_journal_entries_last_mutation_kind_check CHECK ((last_mutation_kind = ANY (ARRAY['create'::text, 'routine_run'::text, 'retract'::text, 'redact'::text]))),
    CONSTRAINT tenant_day_journal_entries_payload_hash_check CHECK ((payload_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT tenant_day_journal_entries_payload_json_check CHECK (((payload_json IS NULL) OR (jsonb_typeof(payload_json) = 'object'::text))),
    CONSTRAINT tenant_day_journal_entries_payload_json_check1 CHECK (((payload_json IS NULL) OR (pg_column_size(payload_json) <= 65536))),
    CONSTRAINT tenant_day_journal_entries_payload_json_object_check CHECK (((payload_json IS NULL) OR (jsonb_typeof(payload_json) = 'object'::text))),
    CONSTRAINT tenant_day_journal_entries_payload_json_size_check CHECK (((payload_json IS NULL) OR (pg_column_size(payload_json) <= 65536))),
    CONSTRAINT tenant_day_journal_entries_payload_preview_check CHECK ((jsonb_typeof(payload_preview) = 'object'::text)),
    CONSTRAINT tenant_day_journal_entries_payload_preview_check1 CHECK ((pg_column_size(payload_preview) <= 4096)),
    CONSTRAINT tenant_day_journal_entries_payload_preview_size_check CHECK ((pg_column_size(payload_preview) <= 4096)),
    CONSTRAINT tenant_day_journal_entries_project_addr_check CHECK (((project_addr IS NULL) OR ((project_addr = btrim(project_addr)) AND (project_addr ~ '^PJ\.[0-9]+(\.[0-9]+)*$'::text)))),
    CONSTRAINT tenant_day_journal_entries_request_hash_check CHECK (((request_hash IS NOT NULL) AND (request_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT tenant_day_journal_entries_result_status_check CHECK ((result_status = ANY (ARRAY['ok'::text, 'partial'::text]))),
    CONSTRAINT tenant_day_journal_entries_routine_class_check CHECK ((routine_class = ANY (ARRAY['context_only'::text, 'actionable'::text]))),
    CONSTRAINT tenant_day_journal_entries_routine_id_check CHECK (((routine_id = btrim(routine_id)) AND (routine_id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'::text))),
    CONSTRAINT tenant_day_journal_entries_schema_check CHECK ((schema ~ '^[a-z][a-z0-9_]{0,63}_v[0-9]+$'::text)),
    CONSTRAINT tenant_day_journal_entries_sensitivity_check CHECK ((sensitivity = ANY (ARRAY['standard'::text, 'personal'::text, 'health'::text, 'financial'::text, 'calendar'::text, 'email'::text]))),
    CONSTRAINT tenant_day_journal_entries_source_refs_check CHECK ((jsonb_typeof(source_refs) = 'array'::text)),
    CONSTRAINT tenant_day_journal_entries_source_refs_check1 CHECK ((pg_column_size(source_refs) <= 8192)),
    CONSTRAINT tenant_day_journal_entries_source_refs_check2 CHECK (public.day_journal_source_refs_are_safe(source_refs)),
    CONSTRAINT tenant_day_journal_entries_source_refs_size_check CHECK ((pg_column_size(source_refs) <= 8192)),
    CONSTRAINT tenant_day_journal_entries_tags_check CHECK ((array_position(tags, NULL::text) IS NULL)),
    CONSTRAINT tenant_day_journal_entries_tags_check1 CHECK (((array_to_string(tags, ''::text) ~ '^[a-z0-9_-]*$'::text) AND ((cardinality(tags) = 0) OR (array_to_string(tags, '.'::text) ~ '^[a-z0-9_-]{1,64}(\.[a-z0-9_-]{1,64})*$'::text)))),
    CONSTRAINT tenant_day_journal_entries_tags_slug_check CHECK (((array_position(tags, NULL::text) IS NULL) AND (array_to_string(tags, ''::text) ~ '^[a-z0-9_-]*$'::text) AND ((cardinality(tags) = 0) OR (array_to_string(tags, '.'::text) ~ '^[a-z0-9_-]{1,64}(\.[a-z0-9_-]{1,64})*$'::text)))),
    CONSTRAINT tenant_day_journal_entries_target_date_check CHECK (((target_date >= '1970-01-01'::date) AND (target_date <= '9999-12-31'::date))),
    CONSTRAINT tenant_day_journal_entries_target_date_range_check CHECK (((target_date >= '1970-01-01'::date) AND (target_date <= '9999-12-31'::date))),
    CONSTRAINT tenant_day_journal_entries_target_path_check CHECK ((length(target_path) <= 256)),
    CONSTRAINT tenant_day_journal_entries_target_path_check1 CHECK ((target_path ~ '^journal\.[a-z][a-z0-9_]{0,63}(\.[a-z][a-z0-9_]{0,63}){1,7}$'::text)),
    CONSTRAINT tenant_day_journal_entries_target_path_check2 CHECK ((target_path !~ '(^|\.)((__proto__)|(prototype)|(constructor))(\.|$)'::text)),
    CONSTRAINT tenant_day_journal_entries_target_timezone_check CHECK (((target_timezone = btrim(target_timezone)) AND ((length(target_timezone) >= 1) AND (length(target_timezone) <= 128)) AND (target_timezone !~ '[[:cntrl:]]'::text) AND (target_timezone !~ '[-]'::text))),
    CONSTRAINT tenant_day_journal_entries_tenant_id_check CHECK (((tenant_id = btrim(tenant_id)) AND (tenant_id ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'::text)))
);


--
-- Name: tenant_day_journal_routine_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_day_journal_routine_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    space_id text GENERATED ALWAYS AS (('tenant:'::text || tenant_id)) STORED,
    routine_id text NOT NULL,
    target_path text NOT NULL,
    target_date date NOT NULL,
    target_timezone text NOT NULL,
    day_addr_at_run text NOT NULL,
    trigger text DEFAULT 'manual'::text NOT NULL,
    run_key text NOT NULL,
    scheduled_fire_at timestamp with time zone,
    claimed_at timestamp with time zone,
    last_progress_at timestamp with time zone,
    scheduler_instance text,
    actor text,
    idempotency_namespace text,
    idempotency_key_sha256 text,
    request_hash text,
    command_id uuid,
    permission_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    dry_run boolean DEFAULT false NOT NULL,
    run_status text NOT NULL,
    result_status text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    result jsonb,
    error text,
    CONSTRAINT tenant_day_journal_routine_runs_actor_check CHECK (((actor IS NULL) OR ((actor = btrim(actor)) AND ((length(actor) >= 1) AND (length(actor) <= 256)) AND (actor !~ '[[:cntrl:]]'::text) AND (actor !~ '[-]'::text)))),
    CONSTRAINT tenant_day_journal_routine_runs_check CHECK (((claimed_at IS NULL) OR (started_at <= claimed_at))),
    CONSTRAINT tenant_day_journal_routine_runs_check1 CHECK (((finished_at IS NULL) OR (started_at <= finished_at))),
    CONSTRAINT tenant_day_journal_routine_runs_check10 CHECK ((day_addr_at_run = ((('TMP.'::text || lpad(((EXTRACT(year FROM target_date))::integer)::text, 4, '0'::text)) || '.'::text) || lpad(((EXTRACT(doy FROM target_date))::integer)::text, 3, '0'::text)))),
    CONSTRAINT tenant_day_journal_routine_runs_check11 CHECK (((idempotency_key_sha256 IS NULL) OR ((idempotency_namespace IS NOT NULL) AND (request_hash IS NOT NULL)))),
    CONSTRAINT tenant_day_journal_routine_runs_check12 CHECK ((dry_run OR (trigger <> 'schedule'::text) OR (request_hash IS NOT NULL))),
    CONSTRAINT tenant_day_journal_routine_runs_check13 CHECK (((trigger <> 'dry_run'::text) OR (dry_run = true))),
    CONSTRAINT tenant_day_journal_routine_runs_check14 CHECK (((run_status <> 'running'::text) OR (last_progress_at IS NOT NULL))),
    CONSTRAINT tenant_day_journal_routine_runs_check15 CHECK ((dry_run OR (trigger <> ALL (ARRAY['manual'::text, 'agent_command'::text, 'hosted_command'::text])) OR (idempotency_key_sha256 IS NOT NULL))),
    CONSTRAINT tenant_day_journal_routine_runs_check2 CHECK (((last_progress_at IS NULL) OR (started_at <= last_progress_at))),
    CONSTRAINT tenant_day_journal_routine_runs_check3 CHECK (((claimed_at IS NULL) OR (finished_at IS NULL) OR (claimed_at <= finished_at))),
    CONSTRAINT tenant_day_journal_routine_runs_check4 CHECK ((((run_status = ANY (ARRAY['pending'::text, 'running'::text])) AND (finished_at IS NULL)) OR ((run_status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'rejected'::text, 'canceled'::text])) AND (finished_at IS NOT NULL)))),
    CONSTRAINT tenant_day_journal_routine_runs_check5 CHECK (((run_status <> ALL (ARRAY['pending'::text, 'running'::text])) OR (result_status IS NULL))),
    CONSTRAINT tenant_day_journal_routine_runs_check6 CHECK (((run_status <> 'succeeded'::text) OR ((result_status IS NOT NULL) AND (result_status = ANY (ARRAY['ok'::text, 'partial'::text, 'skipped'::text, 'error'::text]))))),
    CONSTRAINT tenant_day_journal_routine_runs_check7 CHECK (((run_status <> 'failed'::text) OR ((result_status IS NOT NULL) AND (result_status = 'error'::text)) OR (error IS NOT NULL))),
    CONSTRAINT tenant_day_journal_routine_runs_check8 CHECK (((run_status <> ALL (ARRAY['rejected'::text, 'canceled'::text])) OR (result_status IS NULL))),
    CONSTRAINT tenant_day_journal_routine_runs_check9 CHECK ((((trigger = 'schedule'::text) AND (scheduled_fire_at IS NOT NULL)) OR (trigger <> 'schedule'::text))),
    CONSTRAINT tenant_day_journal_routine_runs_day_addr_at_run_check CHECK (((day_addr_at_run = btrim(day_addr_at_run)) AND (day_addr_at_run ~ '^TMP\.[0-9]{4}\.(00[1-9]|0[1-9][0-9]|[1-2][0-9]{2}|3[0-5][0-9]|36[0-6])$'::text))),
    CONSTRAINT tenant_day_journal_routine_runs_error_check CHECK (((error IS NULL) OR (length(error) <= 4000))),
    CONSTRAINT tenant_day_journal_routine_runs_idempotency_key_sha256_check CHECK (((idempotency_key_sha256 IS NULL) OR (idempotency_key_sha256 ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT tenant_day_journal_routine_runs_idempotency_namespace_check CHECK (((idempotency_namespace IS NULL) OR ((idempotency_namespace = btrim(idempotency_namespace)) AND (idempotency_namespace ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'::text)))),
    CONSTRAINT tenant_day_journal_routine_runs_permission_snapshot_check CHECK ((jsonb_typeof(permission_snapshot) = 'object'::text)),
    CONSTRAINT tenant_day_journal_routine_runs_request_hash_check CHECK (((request_hash IS NULL) OR (request_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT tenant_day_journal_routine_runs_result_check CHECK (((result IS NULL) OR (jsonb_typeof(result) = 'object'::text))),
    CONSTRAINT tenant_day_journal_routine_runs_result_status_check CHECK (((result_status IS NULL) OR (result_status = ANY (ARRAY['ok'::text, 'partial'::text, 'skipped'::text, 'error'::text])))),
    CONSTRAINT tenant_day_journal_routine_runs_routine_id_check CHECK (((routine_id = btrim(routine_id)) AND (routine_id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'::text))),
    CONSTRAINT tenant_day_journal_routine_runs_run_key_check CHECK (((run_key = btrim(run_key)) AND ((length(run_key) >= 1) AND (length(run_key) <= 256)) AND (run_key !~ '[[:cntrl:]]'::text) AND (run_key !~ '[-]'::text))),
    CONSTRAINT tenant_day_journal_routine_runs_run_status_check CHECK ((run_status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'rejected'::text, 'canceled'::text]))),
    CONSTRAINT tenant_day_journal_routine_runs_scheduler_instance_check CHECK (((scheduler_instance IS NULL) OR ((scheduler_instance = btrim(scheduler_instance)) AND ((length(scheduler_instance) >= 1) AND (length(scheduler_instance) <= 256)) AND (scheduler_instance !~ '[[:cntrl:]]'::text) AND (scheduler_instance !~ '[-]'::text)))),
    CONSTRAINT tenant_day_journal_routine_runs_target_date_check CHECK (((target_date >= '1970-01-01'::date) AND (target_date <= '9999-12-31'::date))),
    CONSTRAINT tenant_day_journal_routine_runs_target_path_check CHECK ((length(target_path) <= 256)),
    CONSTRAINT tenant_day_journal_routine_runs_target_path_check1 CHECK ((target_path ~ '^journal\.[a-z][a-z0-9_]{0,63}(\.[a-z][a-z0-9_]{0,63}){1,7}$'::text)),
    CONSTRAINT tenant_day_journal_routine_runs_target_path_check2 CHECK ((target_path !~ '(^|\.)((__proto__)|(prototype)|(constructor))(\.|$)'::text)),
    CONSTRAINT tenant_day_journal_routine_runs_target_timezone_check CHECK (((target_timezone = btrim(target_timezone)) AND ((length(target_timezone) >= 1) AND (length(target_timezone) <= 128)) AND (target_timezone !~ '[[:cntrl:]]'::text) AND (target_timezone !~ '[-]'::text))),
    CONSTRAINT tenant_day_journal_routine_runs_tenant_id_check CHECK (((tenant_id = btrim(tenant_id)) AND (tenant_id ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'::text))),
    CONSTRAINT tenant_day_journal_routine_runs_trigger_check CHECK ((trigger = ANY (ARRAY['manual'::text, 'schedule'::text, 'agent_command'::text, 'hosted_command'::text, 'dry_run'::text]))),
    CONSTRAINT tenant_day_journal_runs_claimed_after_started_check CHECK (((claimed_at IS NULL) OR (started_at <= claimed_at))),
    CONSTRAINT tenant_day_journal_runs_day_addr_at_run_doy_check CHECK (((day_addr_at_run = btrim(day_addr_at_run)) AND (day_addr_at_run ~ '^TMP\.[0-9]{4}\.(00[1-9]|0[1-9][0-9]|[1-2][0-9]{2}|3[0-5][0-9]|36[0-6])$'::text))),
    CONSTRAINT tenant_day_journal_runs_day_addr_target_date_check CHECK ((day_addr_at_run = ((('TMP.'::text || lpad(((EXTRACT(year FROM target_date))::integer)::text, 4, '0'::text)) || '.'::text) || lpad(((EXTRACT(doy FROM target_date))::integer)::text, 3, '0'::text)))),
    CONSTRAINT tenant_day_journal_runs_dry_run_trigger_check CHECK (((trigger <> 'dry_run'::text) OR (dry_run = true))),
    CONSTRAINT tenant_day_journal_runs_failed_result_or_error_check CHECK (((run_status <> 'failed'::text) OR ((result_status IS NOT NULL) AND (result_status = 'error'::text)) OR (error IS NOT NULL))),
    CONSTRAINT tenant_day_journal_runs_finished_after_claimed_check CHECK (((claimed_at IS NULL) OR (finished_at IS NULL) OR (claimed_at <= finished_at))),
    CONSTRAINT tenant_day_journal_runs_finished_after_started_check CHECK (((finished_at IS NULL) OR (started_at <= finished_at))),
    CONSTRAINT tenant_day_journal_runs_idempotency_namespace_check CHECK (((idempotency_namespace IS NULL) OR ((idempotency_namespace = btrim(idempotency_namespace)) AND (idempotency_namespace ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'::text)))),
    CONSTRAINT tenant_day_journal_runs_idempotency_requires_namespace_check CHECK (((idempotency_key_sha256 IS NULL) OR ((idempotency_namespace IS NOT NULL) AND (request_hash IS NOT NULL)))),
    CONSTRAINT tenant_day_journal_runs_progress_after_started_check CHECK (((last_progress_at IS NULL) OR (started_at <= last_progress_at))),
    CONSTRAINT tenant_day_journal_runs_result_object_check CHECK (((result IS NULL) OR (jsonb_typeof(result) = 'object'::text))),
    CONSTRAINT tenant_day_journal_runs_running_progress_check CHECK (((run_status <> 'running'::text) OR (last_progress_at IS NOT NULL))),
    CONSTRAINT tenant_day_journal_runs_schedule_request_hash_check CHECK ((dry_run OR (trigger <> 'schedule'::text) OR (request_hash IS NOT NULL))),
    CONSTRAINT tenant_day_journal_runs_succeeded_result_status_check CHECK (((run_status <> 'succeeded'::text) OR ((result_status IS NOT NULL) AND (result_status = ANY (ARRAY['ok'::text, 'partial'::text, 'skipped'::text, 'error'::text]))))),
    CONSTRAINT tenant_day_journal_runs_target_date_range_check CHECK (((target_date >= '1970-01-01'::date) AND (target_date <= '9999-12-31'::date)))
);


--
-- Name: tenant_day_journal_routines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_day_journal_routines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    space_id text GENERATED ALWAYS AS (('tenant:'::text || tenant_id)) STORED,
    routine_id text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    schedule text NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    permission_grants text[] DEFAULT '{}'::text[] NOT NULL,
    last_dry_run_at timestamp with time zone,
    last_dry_run_status text,
    last_scheduled_at timestamp with time zone,
    next_run_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_day_journal_routines_config_check CHECK ((jsonb_typeof(config) = 'object'::text)),
    CONSTRAINT tenant_day_journal_routines_last_dry_run_status_check CHECK (((last_dry_run_status IS NULL) OR (last_dry_run_status = ANY (ARRAY['ok'::text, 'partial'::text, 'skipped'::text, 'error'::text, 'failed'::text, 'rejected'::text, 'canceled'::text])))),
    CONSTRAINT tenant_day_journal_routines_permission_grants_allowed_check CHECK ((permission_grants <@ ARRAY['journal_write'::text, 'network'::text, 'local_files'::text, 'calendar'::text, 'email'::text, 'browser'::text, 'health'::text, 'finance'::text, 'llm'::text])),
    CONSTRAINT tenant_day_journal_routines_permission_grants_check CHECK ((array_position(permission_grants, NULL::text) IS NULL)),
    CONSTRAINT tenant_day_journal_routines_permission_grants_check1 CHECK ((permission_grants <@ ARRAY['journal_write'::text, 'network'::text, 'local_files'::text, 'calendar'::text, 'email'::text, 'browser'::text, 'health'::text, 'finance'::text, 'llm'::text])),
    CONSTRAINT tenant_day_journal_routines_routine_id_check CHECK (((routine_id = btrim(routine_id)) AND (routine_id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'::text))),
    CONSTRAINT tenant_day_journal_routines_schedule_check CHECK ((schedule ~ '^(daily|weekday|weekly:(mon|tue|wed|thu|fri|sat|sun))@([01][0-9]|2[0-3]):[0-5][0-9]$'::text)),
    CONSTRAINT tenant_day_journal_routines_tenant_id_check CHECK (((tenant_id = btrim(tenant_id)) AND (tenant_id ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'::text))),
    CONSTRAINT tenant_day_journal_routines_timezone_check CHECK (((timezone = btrim(timezone)) AND ((length(timezone) >= 1) AND (length(timezone) <= 128)) AND (timezone !~ '[[:cntrl:]]'::text) AND (timezone !~ '[-]'::text)))
);


--
-- Name: tenant_key_authority_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_key_authority_grants (
    tenant_id text NOT NULL,
    authority_kind text NOT NULL,
    grant_status text DEFAULT 'none'::text NOT NULL,
    encrypted_grant text,
    grant_iv text,
    grant_auth_tag text,
    issued_at timestamp with time zone,
    expires_at timestamp with time zone,
    refreshed_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_key_authority_grants_grant_status_check CHECK ((grant_status = ANY (ARRAY['none'::text, 'active'::text, 'expired'::text, 'revoked'::text, 'error'::text])))
);


--
-- Name: tenant_key_domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_key_domains (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    key_version integer DEFAULT 1 NOT NULL,
    wrapped_tdk text NOT NULL,
    tdk_iv text,
    tdk_auth_tag text,
    master_key_id text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_key_domains_status_check CHECK ((status = ANY (ARRAY['active'::text, 'rotated'::text, 'destroyed'::text])))
);


--
-- Name: tenant_pyramids; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_pyramids (
    pyramid_id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    label text NOT NULL,
    kind text DEFAULT 'user'::text NOT NULL,
    system_key text,
    sync_level text DEFAULT 'local_only'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    description text,
    CONSTRAINT tenant_pyramids_kind_check CHECK ((kind = ANY (ARRAY['system'::text, 'user'::text]))),
    CONSTRAINT tenant_pyramids_kind_key CHECK ((((kind = 'system'::text) AND (system_key IS NOT NULL) AND (system_key = ANY (ARRAY['memory'::text, 'skills'::text]))) OR ((kind = 'user'::text) AND (system_key IS NULL)))),
    CONSTRAINT tenant_pyramids_sync_level_check CHECK ((sync_level = ANY (ARRAY['local_only'::text, 'managed_mirror'::text])))
);


--
-- Name: tenant_rotation_locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_rotation_locks (
    tenant_id text NOT NULL,
    locked_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_by text DEFAULT 'rotation'::text NOT NULL,
    old_version integer,
    new_version integer
);


--
-- Name: tenant_security_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_security_config (
    tenant_id text NOT NULL,
    security_mode text DEFAULT 'service_managed'::text NOT NULL,
    key_authority_config jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_security_config_security_mode_check CHECK ((security_mode = ANY (ARRAY['service_managed'::text, 'customer_managed'::text, 'content_opaque'::text])))
);


--
-- Name: tenant_security_transitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_security_transitions (
    tenant_id text NOT NULL,
    from_mode text NOT NULL,
    to_mode text NOT NULL,
    status text DEFAULT 'in_progress'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    last_error text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_security_transitions_status_check CHECK ((status = ANY (ARRAY['in_progress'::text, 'completed'::text, 'failed'::text, 'awaiting_reexport'::text])))
);


--
-- Name: tenant_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_settings (
    tenant_id text NOT NULL,
    key text NOT NULL,
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_settings_key_check CHECK ((key = ANY (ARRAY['trends_enabled'::text, 'supercron_cadence_minutes'::text, 'supercron_active_hours'::text, 'supercron_intensity'::text, 'supercron_pyramid_focus'::text, 'supercron_quality_preset'::text, 'supercron_llm_budget_usd_micro_daily'::text, 'golden_query_enabled'::text, 'recall_outcomes_enabled'::text, 'confidence_promotion_enabled'::text, 'supercron_node_gc_candidate_enabled'::text, 'supercron_node_gc_dormant_days'::text, 'supercron_node_gc_per_cycle_cap'::text, 'supercron_node_gc_max_active_candidates'::text, 'supercron_node_gc_rejection_cooldown_days'::text, 'supercron_node_gc_apply_enabled'::text, 'supercron_node_gc_apply_action'::text, 'supercron_node_gc_apply_per_cycle_cap'::text, 'policy_profile'::text]))),
    CONSTRAINT tenant_settings_policy_profile_value_check CHECK (((key <> 'policy_profile'::text) OR (value = ANY (ARRAY['conservative'::text, 'balanced'::text, 'aggressive'::text])))),
    CONSTRAINT tenant_settings_supercron_cadence_minutes_value_check CHECK (
CASE
    WHEN ((key = 'supercron_cadence_minutes'::text) AND (value ~ '^[0-9]{1,4}$'::text)) THEN (((value)::integer >= 15) AND ((value)::integer <= 1440))
    WHEN (key = 'supercron_cadence_minutes'::text) THEN false
    ELSE true
END),
    CONSTRAINT tenant_settings_supercron_controls_value_check CHECK (
CASE
    WHEN (key = ANY (ARRAY['trends_enabled'::text, 'golden_query_enabled'::text, 'recall_outcomes_enabled'::text, 'confidence_promotion_enabled'::text, 'supercron_node_gc_candidate_enabled'::text, 'supercron_node_gc_apply_enabled'::text])) THEN (value = ANY (ARRAY['true'::text, 'false'::text]))
    WHEN (key = 'supercron_node_gc_apply_action'::text) THEN (value = ANY (ARRAY['tombstone'::text, 'delete'::text]))
    WHEN (key = 'supercron_intensity'::text) THEN (value = ANY (ARRAY['light'::text, 'balanced'::text, 'thorough'::text]))
    WHEN (key = 'supercron_quality_preset'::text) THEN (value = ANY (ARRAY['lenient'::text, 'balanced'::text, 'strict'::text]))
    WHEN (key = 'supercron_active_hours'::text) THEN
    CASE
        WHEN (jsonb_typeof((value)::jsonb) <> 'object'::text) THEN false
        WHEN (NOT (((value)::jsonb ? 'start'::text) AND ((value)::jsonb ? 'end'::text))) THEN false
        WHEN ((jsonb_typeof(((value)::jsonb -> 'start'::text)) <> 'number'::text) OR (jsonb_typeof(((value)::jsonb -> 'end'::text)) <> 'number'::text)) THEN false
        ELSE ((((((value)::jsonb ->> 'start'::text))::numeric >= (0)::numeric) AND ((((value)::jsonb ->> 'start'::text))::numeric <= (24)::numeric)) AND (((((value)::jsonb ->> 'end'::text))::numeric >= (0)::numeric) AND ((((value)::jsonb ->> 'end'::text))::numeric <= (24)::numeric)) AND (mod((((value)::jsonb ->> 'start'::text))::numeric, (1)::numeric) = (0)::numeric) AND (mod((((value)::jsonb ->> 'end'::text))::numeric, (1)::numeric) = (0)::numeric) AND ((((value)::jsonb ->> 'start'::text))::numeric <> (((value)::jsonb ->> 'end'::text))::numeric) AND (NOT (((((value)::jsonb ->> 'start'::text))::numeric = (24)::numeric) AND ((((value)::jsonb ->> 'end'::text))::numeric = (0)::numeric))))
    END
    WHEN (key = 'supercron_pyramid_focus'::text) THEN (jsonb_typeof((value)::jsonb) = 'array'::text)
    WHEN ((key = 'supercron_llm_budget_usd_micro_daily'::text) AND (value ~ '^[0-9]{1,10}$'::text)) THEN (((value)::numeric >= (100000)::numeric) AND ((value)::numeric <= (2000000)::numeric))
    WHEN (key = 'supercron_llm_budget_usd_micro_daily'::text) THEN false
    WHEN ((key = 'supercron_node_gc_dormant_days'::text) AND (value ~ '^[0-9]{1,3}$'::text)) THEN (((value)::integer >= 30) AND ((value)::integer <= 365))
    WHEN (key = 'supercron_node_gc_dormant_days'::text) THEN false
    WHEN ((key = 'supercron_node_gc_per_cycle_cap'::text) AND (value ~ '^[0-9]{1,3}$'::text)) THEN (((value)::integer >= 1) AND ((value)::integer <= 500))
    WHEN (key = 'supercron_node_gc_per_cycle_cap'::text) THEN false
    WHEN ((key = 'supercron_node_gc_max_active_candidates'::text) AND (value ~ '^[0-9]{1,4}$'::text)) THEN (((value)::integer >= 10) AND ((value)::integer <= 5000))
    WHEN (key = 'supercron_node_gc_max_active_candidates'::text) THEN false
    WHEN ((key = 'supercron_node_gc_rejection_cooldown_days'::text) AND (value ~ '^[0-9]{1,3}$'::text)) THEN (((value)::integer >= 7) AND ((value)::integer <= 365))
    WHEN (key = 'supercron_node_gc_rejection_cooldown_days'::text) THEN false
    WHEN ((key = 'supercron_node_gc_apply_per_cycle_cap'::text) AND (value ~ '^[0-9]{1,3}$'::text)) THEN (((value)::integer >= 1) AND ((value)::integer <= 50))
    WHEN (key = 'supercron_node_gc_apply_per_cycle_cap'::text) THEN false
    ELSE true
END),
    CONSTRAINT tenant_settings_tenant_id_check CHECK ((tenant_id ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'::text)),
    CONSTRAINT tenant_settings_trends_enabled_value_check CHECK (((key <> 'trends_enabled'::text) OR (value = ANY (ARRAY['true'::text, 'false'::text]))))
);


--
-- Name: tenant_sync_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_sync_preferences (
    tenant_id text NOT NULL,
    project_mode text DEFAULT 'all'::text NOT NULL,
    selected_project_addrs text[] DEFAULT ARRAY[]::text[] NOT NULL,
    graph_enabled boolean DEFAULT true NOT NULL,
    projects_enabled boolean DEFAULT true NOT NULL,
    vault_metadata_enabled boolean DEFAULT true NOT NULL,
    drive_mirror_enabled boolean DEFAULT true NOT NULL,
    source text DEFAULT 'vol_sync'::text NOT NULL,
    updated_by_account_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_sync_preferences_project_mode_check CHECK ((project_mode = ANY (ARRAY['all'::text, 'selected'::text]))),
    CONSTRAINT tenant_sync_preferences_selected_project_addrs_bounded_check CHECK (((array_length(selected_project_addrs, 1) IS NULL) OR (array_length(selected_project_addrs, 1) <= 500))),
    CONSTRAINT tenant_sync_preferences_selected_project_addrs_shape_check CHECK (((selected_project_addrs = ARRAY[]::text[]) OR (array_to_string(selected_project_addrs, ','::text) ~ '^PJ[.][0-9]+(?:[.][0-9]+)*(,PJ[.][0-9]+(?:[.][0-9]+)*)*$'::text))),
    CONSTRAINT tenant_sync_preferences_source_check CHECK ((source = ANY (ARRAY['vow_request'::text, 'vol_sync'::text]))),
    CONSTRAINT tenant_sync_preferences_tenant_id_check CHECK ((tenant_id ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'::text))
);


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    tenant_id text NOT NULL,
    label text NOT NULL,
    owner_agent_id text,
    status text DEFAULT 'active'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenants_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'archived'::text])))
);


--
-- Name: token_schedule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.token_schedule (
    id integer NOT NULL,
    contribution_type text NOT NULL,
    layer integer,
    base_weight numeric(10,4) NOT NULL,
    description text
);


--
-- Name: token_schedule_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.token_schedule_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: token_schedule_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.token_schedule_id_seq OWNED BY public.token_schedule.id;


--
-- Name: trend_addr_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trend_addr_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trend_archive; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trend_archive (
    id bigint NOT NULL,
    original_addr text NOT NULL,
    label text NOT NULL,
    substance text,
    domains text[] DEFAULT '{}'::text[] NOT NULL,
    centroid public.halfvec(3072),
    birth_time timestamp with time zone NOT NULL,
    death_time timestamp with time zone DEFAULT now() NOT NULL,
    peak_energy real,
    source_types text[] DEFAULT '{}'::text[] NOT NULL,
    source_diversity integer DEFAULT 0 NOT NULL,
    incarnation integer DEFAULT 1 NOT NULL,
    prior_addr text,
    engagement_count integer DEFAULT 0 NOT NULL,
    graduated boolean DEFAULT false NOT NULL,
    source_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    space_id text DEFAULT 'global'::text NOT NULL,
    origin_keys text[] DEFAULT '{}'::text[] NOT NULL,
    origin_diversity integer DEFAULT 0 NOT NULL
);


--
-- Name: trend_archive_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trend_archive_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trend_archive_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trend_archive_id_seq OWNED BY public.trend_archive.id;


--
-- Name: trend_centroids; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trend_centroids (
    ref_key text NOT NULL,
    ref_kind text NOT NULL,
    ref_addr text NOT NULL,
    label text,
    lifecycle text,
    centroid public.halfvec(3072) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    space_id text DEFAULT 'global'::text NOT NULL,
    CONSTRAINT trend_centroids_ref_kind_check CHECK ((ref_kind = ANY (ARRAY['active'::text, 'archive'::text])))
);


--
-- Name: trend_decision_audits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trend_decision_audits (
    id bigint NOT NULL,
    decision_kind text NOT NULL,
    ref_kind text NOT NULL,
    ref_id text NOT NULL,
    trend_addr text,
    status text DEFAULT 'pending'::text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    actionable_summary text,
    recommended_action text,
    action_items jsonb DEFAULT '[]'::jsonb NOT NULL,
    confidence real,
    model text,
    error text,
    claimed_at timestamp with time zone,
    claimed_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    policy_status text DEFAULT 'pending'::text NOT NULL,
    policy_note text,
    policy_applied_at timestamp with time zone,
    space_id text DEFAULT 'global'::text NOT NULL,
    CONSTRAINT trend_decision_audits_policy_status_check CHECK ((policy_status = ANY (ARRAY['pending'::text, 'processing'::text, 'applied'::text, 'noop'::text, 'ignored'::text, 'failed'::text]))),
    CONSTRAINT trend_decision_audits_ref_kind_check CHECK ((ref_kind = ANY (ARRAY['proto_cluster'::text, 'trend'::text]))),
    CONSTRAINT trend_decision_audits_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: trend_decision_audits_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trend_decision_audits_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trend_decision_audits_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trend_decision_audits_id_seq OWNED BY public.trend_decision_audits.id;


--
-- Name: trend_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trend_events (
    id bigint NOT NULL,
    event_type text NOT NULL,
    stimulus_id integer,
    proto_cluster_id uuid,
    trend_addr text,
    ingest_batch_id text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    space_id text DEFAULT 'global'::text NOT NULL
);


--
-- Name: trend_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trend_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trend_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trend_events_id_seq OWNED BY public.trend_events.id;


--
-- Name: trend_policy_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trend_policy_overrides (
    ref_kind text NOT NULL,
    ref_id text NOT NULL,
    action text NOT NULL,
    hold_until timestamp with time zone,
    source_audit_id bigint,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    space_id text DEFAULT 'global'::text NOT NULL,
    CONSTRAINT trend_policy_overrides_action_check CHECK ((action = 'hold_until'::text)),
    CONSTRAINT trend_policy_overrides_ref_kind_check CHECK ((ref_kind = ANY (ARRAY['proto_cluster'::text, 'trend'::text])))
);


--
-- Name: v_capability_directory; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_capability_directory AS
 SELECT caps.cap,
    jsonb_agg(DISTINCT jsonb_build_object('addr', n.addr, 'label', n.label, 'type', n.node_type, 'confidence', n.confidence, 'resonance', round((n.resonance)::numeric, 3), 'cost', ((n.substance -> 'readiness'::text) ->> 'cost'::text))) AS providers,
    count(DISTINCT n.addr) AS provider_count,
    ( SELECT jsonb_agg(DISTINCT d.value) AS jsonb_agg
           FROM jsonb_array_elements_text(( SELECT jsonb_agg(DISTINCT sub.dom) AS jsonb_agg
                   FROM ( SELECT jsonb_array_elements_text((nn.substance -> 'domains'::text)) AS dom
                           FROM public.nodes nn
                          WHERE (nn.addr = ANY (array_agg(n.addr)))) sub)) d(value)) AS domains
   FROM (( SELECT nodes.addr,
            jsonb_array_elements_text((nodes.substance -> 'provides'::text)) AS cap
           FROM public.nodes
          WHERE (((nodes.substance -> 'provides'::text) IS NOT NULL) AND (nodes.visibility = 'public'::text))) caps
     JOIN public.nodes n ON ((n.addr = caps.addr)))
  GROUP BY caps.cap
  ORDER BY caps.cap;


--
-- Name: v_grounding_gap_reward_basis; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_grounding_gap_reward_basis AS
 WITH event_rollup AS (
         SELECT grounding_gap_events.gap_key,
            (count(*))::integer AS event_count,
            (count(DISTINCT grounding_gap_events.goal_hash))::integer AS distinct_goal_count,
            (count(DISTINCT COALESCE(grounding_gap_events.agent_id, grounding_gap_events.actor_key)))::integer AS distinct_agent_count,
            (count(DISTINCT COALESCE(grounding_gap_events.tenant_id, grounding_gap_events.space_id, grounding_gap_events.access_scope)))::integer AS distinct_scope_count,
            (count(*) FILTER (WHERE (grounding_gap_events.severity = 'critical'::text)))::integer AS critical_count,
            (count(*) FILTER (WHERE (grounding_gap_events.severity = 'warn'::text)))::integer AS warn_count,
            (count(*) FILTER (WHERE (grounding_gap_events.gap_type = 'missing_world_grounding'::text)))::integer AS world_gap_count,
            (count(*) FILTER (WHERE (grounding_gap_events.gap_type = 'missing_functional_path'::text)))::integer AS function_gap_count,
            (count(*) FILTER (WHERE (grounding_gap_events.gap_type = 'missing_reviewed_skill'::text)))::integer AS skill_gap_count,
            (count(*) FILTER (WHERE (grounding_gap_events.gap_type = 'low_corroboration'::text)))::integer AS corroboration_gap_count,
            (count(*) FILTER (WHERE (grounding_gap_events.gap_type = 'bridge_gap'::text)))::integer AS bridge_gap_count,
            (count(*) FILTER (WHERE (grounding_gap_events.gap_type = 'low_confidence'::text)))::integer AS low_confidence_count,
            max(grounding_gap_events.created_at) AS last_event_at
           FROM public.grounding_gap_events
          GROUP BY grounding_gap_events.gap_key
        ), claim_rollup AS (
         SELECT grounding_gap_claims.gap_key,
            (count(*))::integer AS claim_count,
            (count(*) FILTER (WHERE (grounding_gap_claims.status = ANY (ARRAY['accepted'::text, 'rewarded'::text]))))::integer AS accepted_claim_count,
            (count(*) FILTER (WHERE (grounding_gap_claims.status = 'rewarded'::text)))::integer AS rewarded_claim_count,
            max(grounding_gap_claims.updated_at) AS last_claim_at
           FROM public.grounding_gap_claims
          GROUP BY grounding_gap_claims.gap_key
        ), scored AS (
         SELECT p.gap_key,
            p.gap_type,
            p.title,
            p.description,
            p.target_pyramid_id,
            p.target_branch_addr,
            p.intent_mode,
            p.scope_kind,
            p.canonical_focus,
            p.status,
            p.seen_count,
            p.first_seen_at,
            p.last_seen_at,
            p.source_context,
            p.blockchain_context,
            COALESCE(e.event_count, 0) AS event_count,
            COALESCE(e.distinct_goal_count, 0) AS distinct_goal_count,
            COALESCE(e.distinct_agent_count, 0) AS distinct_agent_count,
            COALESCE(e.distinct_scope_count, 0) AS distinct_scope_count,
            COALESCE(e.critical_count, 0) AS critical_count,
            COALESCE(e.warn_count, 0) AS warn_count,
            COALESCE(e.world_gap_count, 0) AS world_gap_count,
            COALESCE(e.function_gap_count, 0) AS function_gap_count,
            COALESCE(e.skill_gap_count, 0) AS skill_gap_count,
            COALESCE(e.corroboration_gap_count, 0) AS corroboration_gap_count,
            COALESCE(e.bridge_gap_count, 0) AS bridge_gap_count,
            COALESCE(e.low_confidence_count, 0) AS low_confidence_count,
            COALESCE(e.last_event_at, p.last_seen_at) AS last_event_at,
            COALESCE(c.claim_count, 0) AS claim_count,
            COALESCE(c.accepted_claim_count, 0) AS accepted_claim_count,
            COALESCE(c.rewarded_claim_count, 0) AS rewarded_claim_count,
            c.last_claim_at,
            round((GREATEST((0)::double precision, ((((((((2)::double precision + LEAST((4)::double precision, (ln(((1 + GREATEST(COALESCE(e.event_count, 0), 0)))::double precision) + ln(((1 + GREATEST(COALESCE(e.distinct_goal_count, 0), 0)))::double precision)))) + (LEAST((3)::numeric, (((COALESCE(e.distinct_agent_count, 0))::numeric * 0.7) + ((COALESCE(e.distinct_scope_count, 0))::numeric * 0.5))))::double precision) + (LEAST((3)::numeric, ((((COALESCE(e.function_gap_count, 0))::numeric * 0.95) + ((COALESCE(e.world_gap_count, 0))::numeric * 0.85)) + ((COALESCE(e.bridge_gap_count, 0))::numeric * 0.75))))::double precision) + (LEAST(2.5, (((COALESCE(e.corroboration_gap_count, 0))::numeric * 0.6) + ((COALESCE(e.low_confidence_count, 0))::numeric * 0.45))))::double precision) + (LEAST((2)::numeric, ((COALESCE(e.skill_gap_count, 0))::numeric * 0.5)))::double precision) + (LEAST((2)::numeric, (((COALESCE(e.critical_count, 0))::numeric * 0.75) + ((COALESCE(e.warn_count, 0))::numeric * 0.25))))::double precision) - (LEAST((2)::numeric, (((COALESCE(c.accepted_claim_count, 0))::numeric * 0.5) + ((COALESCE(c.rewarded_claim_count, 0))::numeric * 0.75))))::double precision)))::numeric, 3) AS provisional_token_weight
           FROM ((public.grounding_gap_profiles p
             LEFT JOIN event_rollup e ON ((e.gap_key = p.gap_key)))
             LEFT JOIN claim_rollup c ON ((c.gap_key = p.gap_key)))
        )
 SELECT gap_key,
    gap_type,
    title,
    description,
    target_pyramid_id,
    target_branch_addr,
    intent_mode,
    scope_kind,
    canonical_focus,
    status,
    seen_count,
    first_seen_at,
    last_seen_at,
    source_context,
    blockchain_context,
    event_count,
    distinct_goal_count,
    distinct_agent_count,
    distinct_scope_count,
    critical_count,
    warn_count,
    world_gap_count,
    function_gap_count,
    skill_gap_count,
    corroboration_gap_count,
    bridge_gap_count,
    low_confidence_count,
    last_event_at,
    claim_count,
    accepted_claim_count,
    rewarded_claim_count,
    last_claim_at,
    provisional_token_weight,
    jsonb_build_object('demand_pressure', round((LEAST((4)::double precision, (ln(((1 + GREATEST(COALESCE(event_count, 0), 0)))::double precision) + ln(((1 + GREATEST(COALESCE(distinct_goal_count, 0), 0)))::double precision))))::numeric, 3), 'usability_breadth', round(LEAST((3)::numeric, (((COALESCE(distinct_agent_count, 0))::numeric * 0.7) + ((COALESCE(distinct_scope_count, 0))::numeric * 0.5))), 3), 'function_pressure', round(LEAST((3)::numeric, ((((COALESCE(function_gap_count, 0))::numeric * 0.95) + ((COALESCE(world_gap_count, 0))::numeric * 0.85)) + ((COALESCE(bridge_gap_count, 0))::numeric * 0.75))), 3), 'reliability_pressure', round(LEAST(2.5, (((COALESCE(corroboration_gap_count, 0))::numeric * 0.6) + ((COALESCE(low_confidence_count, 0))::numeric * 0.45))), 3), 'skill_pressure', round(LEAST((2)::numeric, ((COALESCE(skill_gap_count, 0))::numeric * 0.5)), 3), 'severity_pressure', round(LEAST((2)::numeric, (((COALESCE(critical_count, 0))::numeric * 0.75) + ((COALESCE(warn_count, 0))::numeric * 0.25))), 3), 'resolution_relief', round(LEAST((2)::numeric, (((COALESCE(accepted_claim_count, 0))::numeric * 0.5) + ((COALESCE(rewarded_claim_count, 0))::numeric * 0.75))), 3)) AS score_components,
        CASE
            WHEN (COALESCE(rewarded_claim_count, 0) > 0) THEN 'rewarded'::text
            WHEN (COALESCE(accepted_claim_count, 0) > 0) THEN 'actively-filling'::text
            WHEN ((COALESCE(critical_count, 0) >= 3) OR (provisional_token_weight >= (12)::numeric)) THEN 'high-value-frontier'::text
            WHEN (provisional_token_weight >= (8)::numeric) THEN 'active-frontier'::text
            ELSE 'emerging-frontier'::text
        END AS territory_posture
   FROM scored;


--
-- Name: v_publication_reward_basis; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_publication_reward_basis AS
 WITH publication_targets AS (
         SELECT p.id AS publication_id,
            p.source_space_id,
            p.source_addr,
            p.target_space_id,
            p.target_addr,
            p.target_pyramid_id,
            p.publication_kind,
            p.status,
            p.published_by,
            p.published_at,
            p.updated_at,
            n.confidence,
            n.resonance,
            n.query_hits,
            COALESCE(jsonb_array_length(COALESCE(n.source_refs, '[]'::jsonb)), 0) AS source_ref_count,
            COALESCE(( SELECT count(*) AS count
                   FROM public.edges e
                  WHERE ((e.from_addr = n.addr) OR (e.to_addr = n.addr))), (0)::bigint) AS edge_count,
            COALESCE(( SELECT count(*) AS count
                   FROM public.edges e
                  WHERE (((e.from_addr = n.addr) OR (e.to_addr = n.addr)) AND (COALESCE((e.source_context ->> 'alignment_version'::text), ''::text) <> ''::text))), (0)::bigint) AS ontology_alignment_count,
            COALESCE(( SELECT count(*) AS count
                   FROM public.edge_tensions et
                  WHERE ((et.resolved_at IS NULL) AND ((et.from_addr = n.addr) OR (et.to_addr = n.addr)))), (0)::bigint) AS unresolved_tension_count,
            COALESCE(( SELECT count(*) AS count
                   FROM public.public_contribution_events ev
                  WHERE (ev.publication_id = p.id)), (0)::bigint) AS contribution_event_count
           FROM (public.node_publications p
             LEFT JOIN public.nodes n ON ((n.addr = p.target_addr)))
          WHERE (p.target_space_id = 'global'::text)
        ), scored AS (
         SELECT publication_targets.publication_id,
            publication_targets.source_space_id,
            publication_targets.source_addr,
            publication_targets.target_space_id,
            publication_targets.target_addr,
            publication_targets.target_pyramid_id,
            publication_targets.publication_kind,
            publication_targets.status,
            publication_targets.published_by,
            publication_targets.published_at,
            publication_targets.updated_at,
            publication_targets.confidence,
            publication_targets.resonance,
            publication_targets.query_hits,
            publication_targets.source_ref_count,
            publication_targets.edge_count,
            publication_targets.ontology_alignment_count,
            publication_targets.unresolved_tension_count,
            publication_targets.contribution_event_count,
            round((GREATEST((0)::double precision, ((((((((4)::double precision + LEAST((4)::double precision, (COALESCE(publication_targets.confidence, (0)::real) * (4)::double precision))) + LEAST((4)::double precision, (COALESCE(publication_targets.resonance, (0)::real) * (4)::double precision))) + LEAST((3)::double precision, ln(((1 + GREATEST(COALESCE(publication_targets.query_hits, 0), 0)))::double precision))) + (LEAST(3, COALESCE(publication_targets.source_ref_count, 0)))::double precision) + (LEAST((3)::numeric, ((COALESCE(publication_targets.ontology_alignment_count, (0)::bigint))::numeric * 0.5)))::double precision) + (LEAST((2)::numeric, ((COALESCE(publication_targets.edge_count, (0)::bigint))::numeric * 0.08)))::double precision) - (LEAST((3)::numeric, ((COALESCE(publication_targets.unresolved_tension_count, (0)::bigint))::numeric * 0.75)))::double precision)))::numeric, 3) AS provisional_reward_score
           FROM publication_targets
        )
 SELECT publication_id,
    source_space_id,
    source_addr,
    target_space_id,
    target_addr,
    target_pyramid_id,
    publication_kind,
    status,
    published_by,
    published_at,
    updated_at,
    confidence,
    resonance,
    query_hits,
    source_ref_count,
    edge_count,
    ontology_alignment_count,
    unresolved_tension_count,
    contribution_event_count,
    provisional_reward_score,
    jsonb_build_object('confidence', round((LEAST((4)::double precision, (COALESCE(confidence, (0)::real) * (4)::double precision)))::numeric, 3), 'resonance', round((LEAST((4)::double precision, (COALESCE(resonance, (0)::real) * (4)::double precision)))::numeric, 3), 'usage', round((LEAST((3)::double precision, ln(((1 + GREATEST(COALESCE(query_hits, 0), 0)))::double precision)))::numeric, 3), 'source_refs', LEAST(3, COALESCE(source_ref_count, 0)), 'ontology_alignment', round(LEAST((3)::numeric, ((COALESCE(ontology_alignment_count, (0)::bigint))::numeric * 0.5)), 3), 'graph_connectivity', round(LEAST((2)::numeric, ((COALESCE(edge_count, (0)::bigint))::numeric * 0.08)), 3), 'tension_penalty', round(LEAST((3)::numeric, ((COALESCE(unresolved_tension_count, (0)::bigint))::numeric * 0.75)), 3)) AS score_components,
        CASE
            WHEN (COALESCE(source_ref_count, 0) = 0) THEN 'low-evidence'::text
            WHEN (COALESCE(unresolved_tension_count, (0)::bigint) >= 2) THEN 'contested'::text
            WHEN (provisional_reward_score >= (12)::numeric) THEN 'high-signal'::text
            WHEN (provisional_reward_score >= (8)::numeric) THEN 'solid'::text
            ELSE 'emerging'::text
        END AS reward_posture
   FROM scored;


--
-- Name: vi_lock_heartbeat; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vi_lock_heartbeat (
    lock_id integer DEFAULT 42 NOT NULL,
    holder_pid integer NOT NULL,
    last_heartbeat timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vi_raw_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vi_raw_queue (
    id integer NOT NULL,
    ingest_batch_id text NOT NULL,
    source_id text NOT NULL,
    source_type text NOT NULL,
    content text NOT NULL,
    chunk_index integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vi_raw_queue_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vi_raw_queue_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vi_raw_queue_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vi_raw_queue_id_seq OWNED BY public.vi_raw_queue.id;


--
-- Name: vi_schedule_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vi_schedule_runs (
    id integer NOT NULL,
    schedule_id integer NOT NULL,
    adapter_name text NOT NULL,
    trigger_kind text DEFAULT 'scheduler'::text NOT NULL,
    status text NOT NULL,
    atoms_count integer,
    cost_usd real,
    error text,
    source_input text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    duration_ms integer
);


--
-- Name: vi_schedule_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vi_schedule_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vi_schedule_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vi_schedule_runs_id_seq OWNED BY public.vi_schedule_runs.id;


--
-- Name: vi_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vi_schedules (
    id integer NOT NULL,
    adapter_name text NOT NULL,
    schedule_cron text NOT NULL,
    source_input text,
    source_input_normalized text,
    adapter_config jsonb DEFAULT '{}'::jsonb,
    enabled boolean DEFAULT true NOT NULL,
    last_run_at timestamp with time zone,
    last_status text,
    last_error text,
    last_atoms_count integer,
    next_run_at timestamp with time zone,
    total_runs integer DEFAULT 0,
    total_atoms integer DEFAULT 0,
    total_cost_usd real DEFAULT 0,
    interval_seconds integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vi_schedules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vi_schedules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vi_schedules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vi_schedules_id_seq OWNED BY public.vi_schedules.id;


--
-- Name: wi_atom_hashes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wi_atom_hashes (
    id integer NOT NULL,
    content_hash text NOT NULL,
    embedding public.halfvec(3072),
    run_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: wi_atom_hashes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wi_atom_hashes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wi_atom_hashes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wi_atom_hashes_id_seq OWNED BY public.wi_atom_hashes.id;


--
-- Name: wi_atom_pool; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wi_atom_pool (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id text NOT NULL,
    source_url text NOT NULL,
    source_type text,
    content text NOT NULL,
    type text NOT NULL,
    subtype text,
    domains text[],
    importance integer,
    actionability integer,
    temporality text,
    enriched_content text,
    edge_suggestions jsonb,
    batch_relationships jsonb,
    heat_signature jsonb,
    enrichment_score double precision,
    status text DEFAULT 'pending'::text,
    priority double precision DEFAULT 0.5,
    retry_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    enriched_at timestamp with time zone,
    routed_at timestamp with time zone
);


--
-- Name: wi_convergence_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wi_convergence_events (
    id integer NOT NULL,
    centroid_embedding public.halfvec(3072),
    orphan_count integer DEFAULT 0 NOT NULL,
    total_energy double precision DEFAULT 0 NOT NULL,
    source_types text[] DEFAULT '{}'::text[],
    sample_content text[] DEFAULT '{}'::text[],
    proposed_label text,
    proposed_description text,
    status text DEFAULT 'detected'::text,
    promoted_node_addr text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: wi_convergence_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wi_convergence_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wi_convergence_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wi_convergence_events_id_seq OWNED BY public.wi_convergence_events.id;


--
-- Name: wi_proto_clusters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wi_proto_clusters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    centroid public.halfvec(3072),
    orphan_count integer DEFAULT 0 NOT NULL,
    source_types text[] DEFAULT '{}'::text[] NOT NULL,
    total_energy real DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_fed timestamp with time zone DEFAULT now() NOT NULL,
    space_id text DEFAULT 'global'::text NOT NULL,
    origin_keys text[] DEFAULT '{}'::text[] NOT NULL,
    origin_diversity integer DEFAULT 0 NOT NULL
);


--
-- Name: wi_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wi_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    url text NOT NULL,
    source_type text,
    priority integer DEFAULT 5,
    status text DEFAULT 'pending'::text,
    submitted_by text,
    submitted_at timestamp with time zone DEFAULT now(),
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    run_id text,
    error_message text,
    retry_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    space_id text DEFAULT 'global'::text NOT NULL
);


--
-- Name: wi_rejected_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wi_rejected_patterns (
    id integer NOT NULL,
    content_embedding public.halfvec(3072) NOT NULL,
    rejection_reason text,
    permanent boolean DEFAULT false,
    original_proposal_id integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: wi_rejected_patterns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wi_rejected_patterns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wi_rejected_patterns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wi_rejected_patterns_id_seq OWNED BY public.wi_rejected_patterns.id;


--
-- Name: wi_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wi_runs (
    id integer NOT NULL,
    run_id text NOT NULL,
    source_url text NOT NULL,
    source_type text NOT NULL,
    title text,
    atoms_extracted integer DEFAULT 0,
    atoms_new_node integer DEFAULT 0,
    atoms_heat integer DEFAULT 0,
    atoms_skill integer DEFAULT 0,
    atoms_drop integer DEFAULT 0,
    skills_detected integer DEFAULT 0,
    cost_usd numeric(10,6) DEFAULT 0,
    elapsed_ms integer,
    status text DEFAULT 'done'::text,
    error text,
    created_at timestamp with time zone DEFAULT now(),
    atoms_durable integer DEFAULT 0,
    atoms_current integer DEFAULT 0,
    atoms_ephemeral integer DEFAULT 0,
    space_id text DEFAULT 'global'::text NOT NULL
);


--
-- Name: wi_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wi_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wi_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wi_runs_id_seq OWNED BY public.wi_runs.id;


--
-- Name: wi_skill_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wi_skill_proposals (
    id integer NOT NULL,
    content text NOT NULL,
    source_url text,
    skill_type text,
    draft_md text,
    status text DEFAULT 'proposed'::text,
    quality_scores jsonb,
    reviewed_by text,
    reviewed_at timestamp with time zone,
    rejection_reason text,
    skill_path text,
    invocation_count integer DEFAULT 0,
    last_invoked_at timestamp with time zone,
    error_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    retired_at timestamp with time zone,
    retired_reason text
);


--
-- Name: wi_skill_proposals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wi_skill_proposals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wi_skill_proposals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wi_skill_proposals_id_seq OWNED BY public.wi_skill_proposals.id;


--
-- Name: wi_skill_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wi_skill_usage (
    id integer NOT NULL,
    skill_id integer,
    invoked_at timestamp with time zone DEFAULT now(),
    success boolean,
    agent_id text,
    error_message text
);


--
-- Name: wi_skill_usage_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wi_skill_usage_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wi_skill_usage_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wi_skill_usage_id_seq OWNED BY public.wi_skill_usage.id;


--
-- Name: wi_source_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wi_source_links (
    id integer NOT NULL,
    source_hash text NOT NULL,
    node_addr text NOT NULL,
    atom_count integer DEFAULT 1,
    created_at timestamp with time zone DEFAULT now(),
    space_id text DEFAULT 'global'::text NOT NULL
);


--
-- Name: wi_source_links_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wi_source_links_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wi_source_links_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wi_source_links_id_seq OWNED BY public.wi_source_links.id;


--
-- Name: worker_heartbeats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_heartbeats (
    worker_name text NOT NULL,
    instance_id text NOT NULL,
    role text NOT NULL,
    status text NOT NULL,
    pid integer NOT NULL,
    hostname text NOT NULL,
    mode text,
    supervisor_session text,
    heartbeat_interval_ms integer NOT NULL,
    stale_after_ms integer NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_heartbeat timestamp with time zone DEFAULT now() NOT NULL,
    stopped_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT worker_heartbeats_heartbeat_interval_ms_check CHECK ((heartbeat_interval_ms > 0)),
    CONSTRAINT worker_heartbeats_stale_after_ms_check CHECK ((stale_after_ms > 0)),
    CONSTRAINT worker_heartbeats_status_check CHECK ((status = ANY (ARRAY['starting'::text, 'running'::text, 'idle'::text, 'idle_off_hours'::text, 'stopping'::text, 'stopped'::text, 'error'::text])))
);


--
-- Name: worker_llm_spend; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_llm_spend (
    id bigint NOT NULL,
    worker_name text NOT NULL,
    tenant_id text,
    model_id text NOT NULL,
    tokens_in integer DEFAULT 0 NOT NULL,
    tokens_out integer DEFAULT 0 NOT NULL,
    cost_usd_micro bigint DEFAULT 0 NOT NULL,
    correlation_id text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT worker_llm_spend_cost_usd_micro_check CHECK ((cost_usd_micro >= 0)),
    CONSTRAINT worker_llm_spend_tokens_in_check CHECK ((tokens_in >= 0)),
    CONSTRAINT worker_llm_spend_tokens_out_check CHECK ((tokens_out >= 0))
);


--
-- Name: worker_llm_spend_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.worker_llm_spend_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: worker_llm_spend_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.worker_llm_spend_id_seq OWNED BY public.worker_llm_spend.id;


--
-- Name: absorbed_echoes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.absorbed_echoes ALTER COLUMN id SET DEFAULT nextval('public.absorbed_echoes_id_seq'::regclass);


--
-- Name: agent_path_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_path_events ALTER COLUMN id SET DEFAULT nextval('public.agent_path_events_id_seq'::regclass);


--
-- Name: agent_queries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_queries ALTER COLUMN id SET DEFAULT nextval('public.agent_queries_id_seq'::regclass);


--
-- Name: agent_watches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_watches ALTER COLUMN id SET DEFAULT nextval('public.agent_watches_id_seq'::regclass);


--
-- Name: atom_feedback id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.atom_feedback ALTER COLUMN id SET DEFAULT nextval('public.atom_feedback_id_seq'::regclass);


--
-- Name: change_stream id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.change_stream ALTER COLUMN id SET DEFAULT nextval('public.change_stream_id_seq'::regclass);


--
-- Name: collapse_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collapse_events ALTER COLUMN id SET DEFAULT nextval('public.collapse_events_id_seq'::regclass);


--
-- Name: confidence_deltas id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.confidence_deltas ALTER COLUMN id SET DEFAULT nextval('public.confidence_deltas_id_seq'::regclass);


--
-- Name: distill_clusters id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.distill_clusters ALTER COLUMN id SET DEFAULT nextval('public.distill_clusters_id_seq'::regclass);


--
-- Name: distill_proposals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.distill_proposals ALTER COLUMN id SET DEFAULT nextval('public.distill_proposals_id_seq'::regclass);


--
-- Name: distill_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.distill_runs ALTER COLUMN id SET DEFAULT nextval('public.distill_runs_id_seq'::regclass);


--
-- Name: distill_work_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.distill_work_items ALTER COLUMN id SET DEFAULT nextval('public.distill_work_items_id_seq'::regclass);


--
-- Name: edge_composition_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edge_composition_rules ALTER COLUMN id SET DEFAULT nextval('public.edge_composition_rules_id_seq'::regclass);


--
-- Name: edge_tensions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edge_tensions ALTER COLUMN id SET DEFAULT nextval('public.edge_tensions_id_seq'::regclass);


--
-- Name: edges id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edges ALTER COLUMN id SET DEFAULT nextval('public.edges_id_seq'::regclass);


--
-- Name: federation_overlay_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federation_overlay_log ALTER COLUMN id SET DEFAULT nextval('public.federation_overlay_log_id_seq'::regclass);


--
-- Name: file_index id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_index ALTER COLUMN id SET DEFAULT nextval('public.file_index_id_seq'::regclass);


--
-- Name: golden_query_cases id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.golden_query_cases ALTER COLUMN id SET DEFAULT nextval('public.golden_query_cases_id_seq'::regclass);


--
-- Name: golden_query_expectations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.golden_query_expectations ALTER COLUMN id SET DEFAULT nextval('public.golden_query_expectations_id_seq'::regclass);


--
-- Name: golden_query_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.golden_query_runs ALTER COLUMN id SET DEFAULT nextval('public.golden_query_runs_id_seq'::regclass);


--
-- Name: graph_mutations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_mutations ALTER COLUMN id SET DEFAULT nextval('public.graph_mutations_id_seq'::regclass);


--
-- Name: grounding_gap_claims id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grounding_gap_claims ALTER COLUMN id SET DEFAULT nextval('public.grounding_gap_claims_id_seq'::regclass);


--
-- Name: grounding_gap_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grounding_gap_events ALTER COLUMN id SET DEFAULT nextval('public.grounding_gap_events_id_seq'::regclass);


--
-- Name: intake_queue id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intake_queue ALTER COLUMN id SET DEFAULT nextval('public.intake_queue_id_seq'::regclass);


--
-- Name: memory_conflicts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_conflicts ALTER COLUMN id SET DEFAULT nextval('public.memory_conflicts_id_seq'::regclass);


--
-- Name: memory_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_events ALTER COLUMN id SET DEFAULT nextval('public.memory_events_id_seq'::regclass);


--
-- Name: mining_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mining_runs ALTER COLUMN id SET DEFAULT nextval('public.mining_runs_id_seq'::regclass);


--
-- Name: node_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_history ALTER COLUMN id SET DEFAULT nextval('public.node_history_id_seq'::regclass);


--
-- Name: node_publications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_publications ALTER COLUMN id SET DEFAULT nextval('public.node_publications_id_seq'::regclass);


--
-- Name: proposal_embeddings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposal_embeddings ALTER COLUMN id SET DEFAULT nextval('public.proposal_embeddings_id_seq'::regclass);


--
-- Name: proposals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposals ALTER COLUMN id SET DEFAULT nextval('public.proposals_id_seq'::regclass);


--
-- Name: public_contribution_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_contribution_events ALTER COLUMN id SET DEFAULT nextval('public.public_contribution_events_id_seq'::regclass);


--
-- Name: query_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.query_log ALTER COLUMN id SET DEFAULT nextval('public.query_log_id_seq'::regclass);


--
-- Name: recall_outcome_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_outcome_events ALTER COLUMN id SET DEFAULT nextval('public.recall_outcome_events_id_seq'::regclass);


--
-- Name: resonance_changelog id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resonance_changelog ALTER COLUMN id SET DEFAULT nextval('public.resonance_changelog_id_seq'::regclass);


--
-- Name: scanner_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scanner_rules ALTER COLUMN id SET DEFAULT nextval('public.scanner_rules_id_seq'::regclass);


--
-- Name: scanner_run_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scanner_run_log ALTER COLUMN id SET DEFAULT nextval('public.scanner_run_log_id_seq'::regclass);


--
-- Name: source_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_history ALTER COLUMN id SET DEFAULT nextval('public.source_history_id_seq'::regclass);


--
-- Name: staging_edges id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staging_edges ALTER COLUMN id SET DEFAULT nextval('public.staging_edges_id_seq'::regclass);


--
-- Name: staging_nodes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staging_nodes ALTER COLUMN id SET DEFAULT nextval('public.staging_nodes_id_seq'::regclass);


--
-- Name: staging_updates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staging_updates ALTER COLUMN id SET DEFAULT nextval('public.staging_updates_id_seq'::regclass);


--
-- Name: stimuli id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stimuli ALTER COLUMN id SET DEFAULT nextval('public.stimuli_id_seq'::regclass);


--
-- Name: stimulus_conflicts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stimulus_conflicts ALTER COLUMN id SET DEFAULT nextval('public.stimulus_conflicts_id_seq'::regclass);


--
-- Name: supercron_manual_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supercron_manual_runs ALTER COLUMN id SET DEFAULT nextval('public.supercron_manual_runs_id_seq'::regclass);


--
-- Name: supercron_node_gc_receipts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supercron_node_gc_receipts ALTER COLUMN id SET DEFAULT nextval('public.supercron_node_gc_receipts_id_seq'::regclass);


--
-- Name: supercron_pass_telemetry id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supercron_pass_telemetry ALTER COLUMN id SET DEFAULT nextval('public.supercron_pass_telemetry_id_seq'::regclass);


--
-- Name: supercron_routine_suppression id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supercron_routine_suppression ALTER COLUMN id SET DEFAULT nextval('public.supercron_routine_suppression_id_seq'::regclass);


--
-- Name: supercron_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supercron_runs ALTER COLUMN id SET DEFAULT nextval('public.supercron_runs_id_seq'::regclass);


--
-- Name: supersession_candidates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supersession_candidates ALTER COLUMN id SET DEFAULT nextval('public.supersession_candidates_id_seq'::regclass);


--
-- Name: sync_journal seq; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_journal ALTER COLUMN seq SET DEFAULT nextval('public.sync_journal_seq_seq'::regclass);


--
-- Name: temporal_intake id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporal_intake ALTER COLUMN id SET DEFAULT nextval('public.temporal_intake_id_seq'::regclass);


--
-- Name: token_schedule id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_schedule ALTER COLUMN id SET DEFAULT nextval('public.token_schedule_id_seq'::regclass);


--
-- Name: trend_archive id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_archive ALTER COLUMN id SET DEFAULT nextval('public.trend_archive_id_seq'::regclass);


--
-- Name: trend_decision_audits id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_decision_audits ALTER COLUMN id SET DEFAULT nextval('public.trend_decision_audits_id_seq'::regclass);


--
-- Name: trend_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_events ALTER COLUMN id SET DEFAULT nextval('public.trend_events_id_seq'::regclass);


--
-- Name: vi_raw_queue id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vi_raw_queue ALTER COLUMN id SET DEFAULT nextval('public.vi_raw_queue_id_seq'::regclass);


--
-- Name: vi_schedule_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vi_schedule_runs ALTER COLUMN id SET DEFAULT nextval('public.vi_schedule_runs_id_seq'::regclass);


--
-- Name: vi_schedules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vi_schedules ALTER COLUMN id SET DEFAULT nextval('public.vi_schedules_id_seq'::regclass);


--
-- Name: wi_atom_hashes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_atom_hashes ALTER COLUMN id SET DEFAULT nextval('public.wi_atom_hashes_id_seq'::regclass);


--
-- Name: wi_convergence_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_convergence_events ALTER COLUMN id SET DEFAULT nextval('public.wi_convergence_events_id_seq'::regclass);


--
-- Name: wi_rejected_patterns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_rejected_patterns ALTER COLUMN id SET DEFAULT nextval('public.wi_rejected_patterns_id_seq'::regclass);


--
-- Name: wi_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_runs ALTER COLUMN id SET DEFAULT nextval('public.wi_runs_id_seq'::regclass);


--
-- Name: wi_skill_proposals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_skill_proposals ALTER COLUMN id SET DEFAULT nextval('public.wi_skill_proposals_id_seq'::regclass);


--
-- Name: wi_skill_usage id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_skill_usage ALTER COLUMN id SET DEFAULT nextval('public.wi_skill_usage_id_seq'::regclass);


--
-- Name: wi_source_links id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_source_links ALTER COLUMN id SET DEFAULT nextval('public.wi_source_links_id_seq'::regclass);


--
-- Name: worker_llm_spend id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_llm_spend ALTER COLUMN id SET DEFAULT nextval('public.worker_llm_spend_id_seq'::regclass);


--
-- Name: absorbed_echoes absorbed_echoes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.absorbed_echoes
    ADD CONSTRAINT absorbed_echoes_pkey PRIMARY KEY (id);


--
-- Name: account_link_codes account_link_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_link_codes
    ADD CONSTRAINT account_link_codes_pkey PRIMARY KEY (id);


--
-- Name: account_sessions account_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_sessions
    ADD CONSTRAINT account_sessions_pkey PRIMARY KEY (session_id);


--
-- Name: account_tenant_links account_tenant_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_tenant_links
    ADD CONSTRAINT account_tenant_links_pkey PRIMARY KEY (id);


--
-- Name: account_ui_preferences account_ui_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_ui_preferences
    ADD CONSTRAINT account_ui_preferences_pkey PRIMARY KEY (account_id);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (account_id);


--
-- Name: agent_path_events agent_path_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_path_events
    ADD CONSTRAINT agent_path_events_pkey PRIMARY KEY (id);


--
-- Name: agent_profiles agent_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_profiles
    ADD CONSTRAINT agent_profiles_pkey PRIMARY KEY (tenant_id, agent_id);


--
-- Name: agent_queries agent_queries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_queries
    ADD CONSTRAINT agent_queries_pkey PRIMARY KEY (id);


--
-- Name: agent_watches agent_watches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_watches
    ADD CONSTRAINT agent_watches_pkey PRIMARY KEY (id);


--
-- Name: agent_watches agent_watches_tenant_agent_filter_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_watches
    ADD CONSTRAINT agent_watches_tenant_agent_filter_key UNIQUE (tenant_id, agent_id, filter);


--
-- Name: atom_feedback atom_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.atom_feedback
    ADD CONSTRAINT atom_feedback_pkey PRIMARY KEY (id);


--
-- Name: change_stream change_stream_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.change_stream
    ADD CONSTRAINT change_stream_pkey PRIMARY KEY (id);


--
-- Name: collapse_events collapse_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collapse_events
    ADD CONSTRAINT collapse_events_pkey PRIMARY KEY (id);


--
-- Name: confidence_deltas confidence_deltas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.confidence_deltas
    ADD CONSTRAINT confidence_deltas_pkey PRIMARY KEY (id);


--
-- Name: depth_multiplier depth_multiplier_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.depth_multiplier
    ADD CONSTRAINT depth_multiplier_pkey PRIMARY KEY (depth);


--
-- Name: distill_clusters distill_clusters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.distill_clusters
    ADD CONSTRAINT distill_clusters_pkey PRIMARY KEY (id);


--
-- Name: distill_cursors distill_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.distill_cursors
    ADD CONSTRAINT distill_cursors_pkey PRIMARY KEY (cursor_kind);


--
-- Name: distill_proposals distill_proposals_fusion_status_check_v2; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.distill_proposals
    ADD CONSTRAINT distill_proposals_fusion_status_check_v2 CHECK ((fusion_status = ANY (ARRAY['none'::text, 'pending'::text, 'judged'::text, 'deferred'::text, 'blocked'::text, 'abandoned'::text]))) NOT VALID;


--
-- Name: distill_proposals distill_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.distill_proposals
    ADD CONSTRAINT distill_proposals_pkey PRIMARY KEY (id);


--
-- Name: distill_proposals distill_proposals_proposal_kind_check_v2; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.distill_proposals
    ADD CONSTRAINT distill_proposals_proposal_kind_check_v2 CHECK ((proposal_kind = ANY (ARRAY['duplicate_review'::text, 'granularity_review'::text, 'orphan_review'::text, 'edge_quality_review'::text, 'confidence_promotion_review'::text]))) NOT VALID;


--
-- Name: distill_runs distill_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.distill_runs
    ADD CONSTRAINT distill_runs_pkey PRIMARY KEY (id);


--
-- Name: distill_work_items distill_work_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.distill_work_items
    ADD CONSTRAINT distill_work_items_pkey PRIMARY KEY (id);


--
-- Name: distill_work_items distill_work_items_pressure_score_nonneg; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.distill_work_items
    ADD CONSTRAINT distill_work_items_pressure_score_nonneg CHECK ((pressure_score >= (0)::numeric)) NOT VALID;


--
-- Name: distill_work_items distill_work_items_status_check_v2; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.distill_work_items
    ADD CONSTRAINT distill_work_items_status_check_v2 CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text, 'ignored'::text, 'invalid'::text]))) NOT VALID;


--
-- Name: edge_composition_rules edge_composition_rules_edge_type_1_edge_type_2_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edge_composition_rules
    ADD CONSTRAINT edge_composition_rules_edge_type_1_edge_type_2_key UNIQUE (edge_type_1, edge_type_2);


--
-- Name: edge_composition_rules edge_composition_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edge_composition_rules
    ADD CONSTRAINT edge_composition_rules_pkey PRIMARY KEY (id);


--
-- Name: edge_tensions edge_tensions_from_addr_to_addr_tension_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edge_tensions
    ADD CONSTRAINT edge_tensions_from_addr_to_addr_tension_type_key UNIQUE (from_addr, to_addr, tension_type);


--
-- Name: edge_tensions edge_tensions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edge_tensions
    ADD CONSTRAINT edge_tensions_pkey PRIMARY KEY (id);


--
-- Name: edge_usefulness_scores edge_usefulness_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edge_usefulness_scores
    ADD CONSTRAINT edge_usefulness_scores_pkey PRIMARY KEY (edge_id);


--
-- Name: edges edges_from_addr_to_addr_edge_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edges
    ADD CONSTRAINT edges_from_addr_to_addr_edge_type_key UNIQUE (from_addr, to_addr, edge_type);


--
-- Name: edges edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edges
    ADD CONSTRAINT edges_pkey PRIMARY KEY (id);


--
-- Name: federation_activity federation_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federation_activity
    ADD CONSTRAINT federation_activity_pkey PRIMARY KEY (id);


--
-- Name: federation_nodes federation_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federation_nodes
    ADD CONSTRAINT federation_nodes_pkey PRIMARY KEY (tenant_id, node_id);


--
-- Name: federation_overlay_log federation_overlay_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federation_overlay_log
    ADD CONSTRAINT federation_overlay_log_pkey PRIMARY KEY (id);


--
-- Name: file_index file_index_file_path_line_start_node_addr_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_index
    ADD CONSTRAINT file_index_file_path_line_start_node_addr_key UNIQUE (file_path, line_start, node_addr);


--
-- Name: file_index file_index_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_index
    ADD CONSTRAINT file_index_pkey PRIMARY KEY (id);


--
-- Name: foundation_rung_f6_addr_remap foundation_rung_f6_addr_remap_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.foundation_rung_f6_addr_remap
    ADD CONSTRAINT foundation_rung_f6_addr_remap_pkey PRIMARY KEY (old_addr);


--
-- Name: foundation_rung_f6_staging_cleanup_audit foundation_rung_f6_staging_cleanup_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.foundation_rung_f6_staging_cleanup_audit
    ADD CONSTRAINT foundation_rung_f6_staging_cleanup_audit_pkey PRIMARY KEY (table_name, row_id, cleanup_reason);


--
-- Name: golden_query_cases golden_query_cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.golden_query_cases
    ADD CONSTRAINT golden_query_cases_pkey PRIMARY KEY (id);


--
-- Name: golden_query_cases golden_query_cases_tenant_id_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.golden_query_cases
    ADD CONSTRAINT golden_query_cases_tenant_id_slug_key UNIQUE (tenant_id, slug);


--
-- Name: golden_query_expectations golden_query_expectations_case_id_addr_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.golden_query_expectations
    ADD CONSTRAINT golden_query_expectations_case_id_addr_key UNIQUE (case_id, addr);


--
-- Name: golden_query_expectations golden_query_expectations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.golden_query_expectations
    ADD CONSTRAINT golden_query_expectations_pkey PRIMARY KEY (id);


--
-- Name: golden_query_runs golden_query_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.golden_query_runs
    ADD CONSTRAINT golden_query_runs_pkey PRIMARY KEY (id);


--
-- Name: graph_mutations graph_mutations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_mutations
    ADD CONSTRAINT graph_mutations_pkey PRIMARY KEY (id);


--
-- Name: graph_spaces graph_spaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_spaces
    ADD CONSTRAINT graph_spaces_pkey PRIMARY KEY (space_id);


--
-- Name: graph_state graph_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_state
    ADD CONSTRAINT graph_state_pkey PRIMARY KEY (key);


--
-- Name: grounding_gap_claims grounding_gap_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grounding_gap_claims
    ADD CONSTRAINT grounding_gap_claims_pkey PRIMARY KEY (id);


--
-- Name: grounding_gap_events grounding_gap_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grounding_gap_events
    ADD CONSTRAINT grounding_gap_events_pkey PRIMARY KEY (id);


--
-- Name: grounding_gap_profiles grounding_gap_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grounding_gap_profiles
    ADD CONSTRAINT grounding_gap_profiles_pkey PRIMARY KEY (gap_key);


--
-- Name: hosted_admin_tenant_overrides hosted_admin_tenant_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_admin_tenant_overrides
    ADD CONSTRAINT hosted_admin_tenant_overrides_pkey PRIMARY KEY (tenant_id);


--
-- Name: hosted_agent_credentials hosted_agent_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_agent_credentials
    ADD CONSTRAINT hosted_agent_credentials_pkey PRIMARY KEY (credential_id);


--
-- Name: hosted_audit_log hosted_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_audit_log
    ADD CONSTRAINT hosted_audit_log_pkey PRIMARY KEY (id);


--
-- Name: hosted_connect_grants hosted_connect_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_connect_grants
    ADD CONSTRAINT hosted_connect_grants_pkey PRIMARY KEY (grant_id);


--
-- Name: hosted_drive_connect_grants hosted_drive_connect_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_drive_connect_grants
    ADD CONSTRAINT hosted_drive_connect_grants_pkey PRIMARY KEY (grant_id);


--
-- Name: hosted_drive_files hosted_drive_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_drive_files
    ADD CONSTRAINT hosted_drive_files_pkey PRIMARY KEY (tenant_id, relative_path);


--
-- Name: hosted_mirror_items hosted_mirror_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_mirror_items
    ADD CONSTRAINT hosted_mirror_items_pkey PRIMARY KEY (tenant_id, item_key);


--
-- Name: hosted_mirror_journal_entries hosted_mirror_journal_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_mirror_journal_entries
    ADD CONSTRAINT hosted_mirror_journal_entries_pkey PRIMARY KEY (tenant_id, entry_key);


--
-- Name: hosted_mirror_journal_entries hosted_mirror_journal_entries_source_refs_count_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.hosted_mirror_journal_entries
    ADD CONSTRAINT hosted_mirror_journal_entries_source_refs_count_check CHECK (
CASE
    WHEN (jsonb_typeof(source_refs) = 'array'::text) THEN (jsonb_array_length(source_refs) <= 32)
    ELSE false
END) NOT VALID;


--
-- Name: hosted_mirror_journal_entries hosted_mirror_journal_entries_sync_batch_no_c1_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.hosted_mirror_journal_entries
    ADD CONSTRAINT hosted_mirror_journal_entries_sync_batch_no_c1_check CHECK ((sync_batch_id !~ '[-]'::text)) NOT VALID;


--
-- Name: hosted_mirror_journal_entries hosted_mirror_journal_entries_sync_source_no_c1_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.hosted_mirror_journal_entries
    ADD CONSTRAINT hosted_mirror_journal_entries_sync_source_no_c1_check CHECK ((sync_source_node_id !~ '[-]'::text)) NOT VALID;


--
-- Name: hosted_mirror_journal_entries hosted_mirror_journal_entries_target_timezone_no_c1_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.hosted_mirror_journal_entries
    ADD CONSTRAINT hosted_mirror_journal_entries_target_timezone_no_c1_check CHECK ((target_timezone !~ '[-]'::text)) NOT VALID;


--
-- Name: hosted_nodes hosted_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_nodes
    ADD CONSTRAINT hosted_nodes_pkey PRIMARY KEY (id);


--
-- Name: hosted_rate_limit_buckets hosted_rate_limit_buckets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_rate_limit_buckets
    ADD CONSTRAINT hosted_rate_limit_buckets_pkey PRIMARY KEY (bucket_key);


--
-- Name: hosted_sync_batches hosted_sync_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_sync_batches
    ADD CONSTRAINT hosted_sync_batches_pkey PRIMARY KEY (tenant_id, batch_id);


--
-- Name: hosted_tenant_identities hosted_tenant_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_tenant_identities
    ADD CONSTRAINT hosted_tenant_identities_pkey PRIMARY KEY (tenant_id);


--
-- Name: hosted_tenant_identities hosted_tenant_identities_tenant_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_tenant_identities
    ADD CONSTRAINT hosted_tenant_identities_tenant_slug_key UNIQUE (tenant_slug);


--
-- Name: intake_queue intake_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intake_queue
    ADD CONSTRAINT intake_queue_pkey PRIMARY KEY (id);


--
-- Name: memory_conflicts memory_conflicts_addr_a_addr_b_conflict_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_conflicts
    ADD CONSTRAINT memory_conflicts_addr_a_addr_b_conflict_type_key UNIQUE (addr_a, addr_b, conflict_type);


--
-- Name: memory_conflicts memory_conflicts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_conflicts
    ADD CONSTRAINT memory_conflicts_pkey PRIMARY KEY (id);


--
-- Name: memory_events memory_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_events
    ADD CONSTRAINT memory_events_pkey PRIMARY KEY (id);


--
-- Name: memory_registry memory_registry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_registry
    ADD CONSTRAINT memory_registry_pkey PRIMARY KEY (addr);


--
-- Name: mining_runs mining_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mining_runs
    ADD CONSTRAINT mining_runs_pkey PRIMARY KEY (id);


--
-- Name: node_history node_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_history
    ADD CONSTRAINT node_history_pkey PRIMARY KEY (id);


--
-- Name: node_publications node_publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_publications
    ADD CONSTRAINT node_publications_pkey PRIMARY KEY (id);


--
-- Name: node_publications node_publications_source_space_id_source_addr_target_space__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_publications
    ADD CONSTRAINT node_publications_source_space_id_source_addr_target_space__key UNIQUE (source_space_id, source_addr, target_space_id, publication_kind);


--
-- Name: nodes nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodes
    ADD CONSTRAINT nodes_pkey PRIMARY KEY (addr);


--
-- Name: oauth_authorization_requests oauth_authorization_requests_nonce_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_authorization_requests
    ADD CONSTRAINT oauth_authorization_requests_nonce_hash_key UNIQUE (nonce_hash);


--
-- Name: oauth_authorization_requests oauth_authorization_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_authorization_requests
    ADD CONSTRAINT oauth_authorization_requests_pkey PRIMARY KEY (id);


--
-- Name: oauth_clients oauth_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (client_id);


--
-- Name: oauth_grants oauth_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_grants
    ADD CONSTRAINT oauth_grants_pkey PRIMARY KEY (id);


--
-- Name: proposal_embeddings proposal_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposal_embeddings
    ADD CONSTRAINT proposal_embeddings_pkey PRIMARY KEY (id);


--
-- Name: proposals proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposals
    ADD CONSTRAINT proposals_pkey PRIMARY KEY (id);


--
-- Name: public_contribution_events public_contribution_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_contribution_events
    ADD CONSTRAINT public_contribution_events_pkey PRIMARY KEY (id);


--
-- Name: query_embeddings query_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.query_embeddings
    ADD CONSTRAINT query_embeddings_pkey PRIMARY KEY (content_hash);


--
-- Name: query_log query_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.query_log
    ADD CONSTRAINT query_log_pkey PRIMARY KEY (id);


--
-- Name: recall_outcome_events recall_outcome_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_outcome_events
    ADD CONSTRAINT recall_outcome_events_pkey PRIMARY KEY (id);


--
-- Name: registry registry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registry
    ADD CONSTRAINT registry_pkey PRIMARY KEY (pyramid_id);


--
-- Name: remote_commands remote_commands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_commands
    ADD CONSTRAINT remote_commands_pkey PRIMARY KEY (id);


--
-- Name: resonance_changelog resonance_changelog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resonance_changelog
    ADD CONSTRAINT resonance_changelog_pkey PRIMARY KEY (id);


--
-- Name: resonance_weights resonance_weights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resonance_weights
    ADD CONSTRAINT resonance_weights_pkey PRIMARY KEY (key);


--
-- Name: review_proposals review_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_proposals
    ADD CONSTRAINT review_proposals_pkey PRIMARY KEY (id);


--
-- Name: scanner_rules scanner_rules_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scanner_rules
    ADD CONSTRAINT scanner_rules_name_key UNIQUE (name);


--
-- Name: scanner_rules scanner_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scanner_rules
    ADD CONSTRAINT scanner_rules_pkey PRIMARY KEY (id);


--
-- Name: scanner_run_log scanner_run_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scanner_run_log
    ADD CONSTRAINT scanner_run_log_pkey PRIMARY KEY (id);


--
-- Name: scanner_state scanner_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scanner_state
    ADD CONSTRAINT scanner_state_pkey PRIMARY KEY (node_addr);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (filename);


--
-- Name: source_domain_authority source_domain_authority_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_domain_authority
    ADD CONSTRAINT source_domain_authority_pkey PRIMARY KEY (source, domain);


--
-- Name: source_history source_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_history
    ADD CONSTRAINT source_history_pkey PRIMARY KEY (id);


--
-- Name: source_history source_history_source_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_history
    ADD CONSTRAINT source_history_source_hash_key UNIQUE (source_hash);


--
-- Name: source_trust source_trust_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_trust
    ADD CONSTRAINT source_trust_pkey PRIMARY KEY (agent_id);


--
-- Name: space_pyramids space_pyramids_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.space_pyramids
    ADD CONSTRAINT space_pyramids_pkey PRIMARY KEY (space_id, pyramid_id);


--
-- Name: staging_edges staging_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staging_edges
    ADD CONSTRAINT staging_edges_pkey PRIMARY KEY (id);


--
-- Name: staging_nodes staging_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staging_nodes
    ADD CONSTRAINT staging_nodes_pkey PRIMARY KEY (id);


--
-- Name: staging_updates staging_updates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staging_updates
    ADD CONSTRAINT staging_updates_pkey PRIMARY KEY (id);


--
-- Name: stimuli stimuli_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stimuli
    ADD CONSTRAINT stimuli_pkey PRIMARY KEY (id);


--
-- Name: stimuli stimuli_source_source_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stimuli
    ADD CONSTRAINT stimuli_source_source_id_key UNIQUE (source, source_id);


--
-- Name: stimulus_conflicts stimulus_conflicts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stimulus_conflicts
    ADD CONSTRAINT stimulus_conflicts_pkey PRIMARY KEY (id);


--
-- Name: stimulus_contributions stimulus_contributions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stimulus_contributions
    ADD CONSTRAINT stimulus_contributions_pkey PRIMARY KEY (stimulus_id, node_addr);


--
-- Name: subscription_entitlements subscription_entitlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_entitlements
    ADD CONSTRAINT subscription_entitlements_pkey PRIMARY KEY (id);


--
-- Name: supercron_manual_runs supercron_manual_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supercron_manual_runs
    ADD CONSTRAINT supercron_manual_runs_pkey PRIMARY KEY (id);


--
-- Name: supercron_node_gc_receipts supercron_node_gc_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supercron_node_gc_receipts
    ADD CONSTRAINT supercron_node_gc_receipts_pkey PRIMARY KEY (id);


--
-- Name: supercron_pass_telemetry supercron_pass_telemetry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supercron_pass_telemetry
    ADD CONSTRAINT supercron_pass_telemetry_pkey PRIMARY KEY (id);


--
-- Name: supercron_routine_suppression supercron_routine_suppression_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supercron_routine_suppression
    ADD CONSTRAINT supercron_routine_suppression_pkey PRIMARY KEY (id);


--
-- Name: supercron_runs supercron_runs_degraded_reason_consistent; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.supercron_runs
    ADD CONSTRAINT supercron_runs_degraded_reason_consistent CHECK ((((status = 'degraded'::text) AND (degraded_reason IS NOT NULL) AND (btrim(degraded_reason) <> ''::text)) OR ((status = 'completed'::text) AND (degraded_reason IS NULL)) OR (status <> ALL (ARRAY['completed'::text, 'degraded'::text])))) NOT VALID;


--
-- Name: supercron_runs supercron_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supercron_runs
    ADD CONSTRAINT supercron_runs_pkey PRIMARY KEY (id);


--
-- Name: supercron_runs supercron_runs_quality_report_shape; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.supercron_runs
    ADD CONSTRAINT supercron_runs_quality_report_shape CHECK (((quality_report ? 'before'::text) AND (quality_report ? 'after'::text) AND (quality_report ? 'delta'::text) AND COALESCE((jsonb_typeof((quality_report -> 'before'::text)) = 'object'::text), false) AND COALESCE((jsonb_typeof((quality_report -> 'after'::text)) = 'object'::text), false) AND COALESCE((jsonb_typeof((quality_report -> 'delta'::text)) = 'object'::text), false) AND COALESCE((jsonb_typeof((quality_report -> 'warnings'::text)) = 'array'::text), false) AND COALESCE((jsonb_typeof((quality_report -> 'pass_errors'::text)) = 'array'::text), false) AND COALESCE((jsonb_typeof((quality_report -> 'cooldown_events'::text)) = 'array'::text), false))) NOT VALID;


--
-- Name: supercron_tenant_budget_state supercron_tenant_budget_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supercron_tenant_budget_state
    ADD CONSTRAINT supercron_tenant_budget_state_pkey PRIMARY KEY (tenant_id);


--
-- Name: supersession_candidates supersession_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supersession_candidates
    ADD CONSTRAINT supersession_candidates_pkey PRIMARY KEY (id);


--
-- Name: sync_journal sync_journal_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_journal
    ADD CONSTRAINT sync_journal_pkey PRIMARY KEY (seq);


--
-- Name: temporal_intake temporal_intake_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporal_intake
    ADD CONSTRAINT temporal_intake_pkey PRIMARY KEY (id);


--
-- Name: tenant_day_journal_entries tenant_day_journal_entries_captured_at_target_window_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.tenant_day_journal_entries
    ADD CONSTRAINT tenant_day_journal_entries_captured_at_target_window_check CHECK (((routine_id = 'manual.tenant_entry'::text) OR ((captured_at >= (((target_date)::timestamp without time zone AT TIME ZONE 'UTC'::text) - '14:00:00'::interval)) AND (captured_at < (((target_date)::timestamp without time zone AT TIME ZONE 'UTC'::text) + '36:00:00'::interval))))) NOT VALID;


--
-- Name: tenant_day_journal_entries tenant_day_journal_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_day_journal_entries
    ADD CONSTRAINT tenant_day_journal_entries_pkey PRIMARY KEY (id);


--
-- Name: tenant_day_journal_entries tenant_day_journal_entries_source_refs_count_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.tenant_day_journal_entries
    ADD CONSTRAINT tenant_day_journal_entries_source_refs_count_check CHECK (
CASE
    WHEN (jsonb_typeof(source_refs) = 'array'::text) THEN (jsonb_array_length(source_refs) <= 32)
    ELSE false
END) NOT VALID;


--
-- Name: tenant_day_journal_entries tenant_day_journal_entries_source_refs_safe_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.tenant_day_journal_entries
    ADD CONSTRAINT tenant_day_journal_entries_source_refs_safe_check CHECK (public.day_journal_source_refs_are_safe(source_refs)) NOT VALID;


--
-- Name: tenant_day_journal_entries tenant_day_journal_entries_target_timezone_no_c1_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.tenant_day_journal_entries
    ADD CONSTRAINT tenant_day_journal_entries_target_timezone_no_c1_check CHECK ((target_timezone !~ '[-]'::text)) NOT VALID;


--
-- Name: tenant_day_journal_entries tenant_day_journal_entries_tenant_id_entry_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_day_journal_entries
    ADD CONSTRAINT tenant_day_journal_entries_tenant_id_entry_key_key UNIQUE (tenant_id, entry_key);


--
-- Name: tenant_day_journal_routine_runs tenant_day_journal_routine_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_day_journal_routine_runs
    ADD CONSTRAINT tenant_day_journal_routine_runs_pkey PRIMARY KEY (id);


--
-- Name: tenant_day_journal_routines tenant_day_journal_routines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_day_journal_routines
    ADD CONSTRAINT tenant_day_journal_routines_pkey PRIMARY KEY (id);


--
-- Name: tenant_day_journal_routines tenant_day_journal_routines_tenant_id_routine_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_day_journal_routines
    ADD CONSTRAINT tenant_day_journal_routines_tenant_id_routine_id_key UNIQUE (tenant_id, routine_id);


--
-- Name: tenant_day_journal_routines tenant_day_journal_routines_timezone_no_c1_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.tenant_day_journal_routines
    ADD CONSTRAINT tenant_day_journal_routines_timezone_no_c1_check CHECK ((timezone !~ '[-]'::text)) NOT VALID;


--
-- Name: tenant_day_journal_routine_runs tenant_day_journal_runs_actor_no_c1_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.tenant_day_journal_routine_runs
    ADD CONSTRAINT tenant_day_journal_runs_actor_no_c1_check CHECK (((actor IS NULL) OR (actor !~ '[-]'::text))) NOT VALID;


--
-- Name: tenant_day_journal_routine_runs tenant_day_journal_runs_run_key_no_c1_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.tenant_day_journal_routine_runs
    ADD CONSTRAINT tenant_day_journal_runs_run_key_no_c1_check CHECK ((run_key !~ '[-]'::text)) NOT VALID;


--
-- Name: tenant_day_journal_routine_runs tenant_day_journal_runs_run_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_day_journal_routine_runs
    ADD CONSTRAINT tenant_day_journal_runs_run_key_unique UNIQUE (tenant_id, routine_id, target_date, target_path, run_key, dry_run);


--
-- Name: tenant_day_journal_routine_runs tenant_day_journal_runs_scheduler_instance_no_c1_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.tenant_day_journal_routine_runs
    ADD CONSTRAINT tenant_day_journal_runs_scheduler_instance_no_c1_check CHECK (((scheduler_instance IS NULL) OR (scheduler_instance !~ '[-]'::text))) NOT VALID;


--
-- Name: tenant_day_journal_routine_runs tenant_day_journal_runs_target_timezone_no_c1_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.tenant_day_journal_routine_runs
    ADD CONSTRAINT tenant_day_journal_runs_target_timezone_no_c1_check CHECK ((target_timezone !~ '[-]'::text)) NOT VALID;


--
-- Name: tenant_key_authority_grants tenant_key_authority_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_key_authority_grants
    ADD CONSTRAINT tenant_key_authority_grants_pkey PRIMARY KEY (tenant_id);


--
-- Name: tenant_key_domains tenant_key_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_key_domains
    ADD CONSTRAINT tenant_key_domains_pkey PRIMARY KEY (id);


--
-- Name: tenant_pyramids tenant_pyramids_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_pyramids
    ADD CONSTRAINT tenant_pyramids_pkey PRIMARY KEY (pyramid_id);


--
-- Name: tenant_rotation_locks tenant_rotation_locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_rotation_locks
    ADD CONSTRAINT tenant_rotation_locks_pkey PRIMARY KEY (tenant_id);


--
-- Name: tenant_security_config tenant_security_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_security_config
    ADD CONSTRAINT tenant_security_config_pkey PRIMARY KEY (tenant_id);


--
-- Name: tenant_security_transitions tenant_security_transitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_security_transitions
    ADD CONSTRAINT tenant_security_transitions_pkey PRIMARY KEY (tenant_id);


--
-- Name: tenant_settings tenant_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_settings
    ADD CONSTRAINT tenant_settings_pkey PRIMARY KEY (tenant_id, key);


--
-- Name: tenant_sync_preferences tenant_sync_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_sync_preferences
    ADD CONSTRAINT tenant_sync_preferences_pkey PRIMARY KEY (tenant_id);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (tenant_id);


--
-- Name: token_schedule token_schedule_contribution_type_layer_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_schedule
    ADD CONSTRAINT token_schedule_contribution_type_layer_key UNIQUE (contribution_type, layer);


--
-- Name: token_schedule token_schedule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_schedule
    ADD CONSTRAINT token_schedule_pkey PRIMARY KEY (id);


--
-- Name: trend_archive trend_archive_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_archive
    ADD CONSTRAINT trend_archive_pkey PRIMARY KEY (id);


--
-- Name: trend_centroids trend_centroids_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_centroids
    ADD CONSTRAINT trend_centroids_pkey PRIMARY KEY (ref_key);


--
-- Name: trend_decision_audits trend_decision_audits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_decision_audits
    ADD CONSTRAINT trend_decision_audits_pkey PRIMARY KEY (id);


--
-- Name: trend_events trend_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_events
    ADD CONSTRAINT trend_events_pkey PRIMARY KEY (id);


--
-- Name: trend_policy_overrides trend_policy_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_policy_overrides
    ADD CONSTRAINT trend_policy_overrides_pkey PRIMARY KEY (ref_kind, ref_id, action);


--
-- Name: vi_lock_heartbeat vi_lock_heartbeat_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vi_lock_heartbeat
    ADD CONSTRAINT vi_lock_heartbeat_pkey PRIMARY KEY (lock_id);


--
-- Name: vi_raw_queue vi_raw_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vi_raw_queue
    ADD CONSTRAINT vi_raw_queue_pkey PRIMARY KEY (id);


--
-- Name: vi_schedule_runs vi_schedule_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vi_schedule_runs
    ADD CONSTRAINT vi_schedule_runs_pkey PRIMARY KEY (id);


--
-- Name: vi_schedules vi_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vi_schedules
    ADD CONSTRAINT vi_schedules_pkey PRIMARY KEY (id);


--
-- Name: wi_atom_hashes wi_atom_hashes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_atom_hashes
    ADD CONSTRAINT wi_atom_hashes_pkey PRIMARY KEY (id);


--
-- Name: wi_atom_pool wi_atom_pool_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_atom_pool
    ADD CONSTRAINT wi_atom_pool_pkey PRIMARY KEY (id);


--
-- Name: wi_convergence_events wi_convergence_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_convergence_events
    ADD CONSTRAINT wi_convergence_events_pkey PRIMARY KEY (id);


--
-- Name: wi_proto_clusters wi_proto_clusters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_proto_clusters
    ADD CONSTRAINT wi_proto_clusters_pkey PRIMARY KEY (id);


--
-- Name: wi_queue wi_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_queue
    ADD CONSTRAINT wi_queue_pkey PRIMARY KEY (id);


--
-- Name: wi_rejected_patterns wi_rejected_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_rejected_patterns
    ADD CONSTRAINT wi_rejected_patterns_pkey PRIMARY KEY (id);


--
-- Name: wi_runs wi_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_runs
    ADD CONSTRAINT wi_runs_pkey PRIMARY KEY (id);


--
-- Name: wi_runs wi_runs_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_runs
    ADD CONSTRAINT wi_runs_run_id_key UNIQUE (run_id);


--
-- Name: wi_skill_proposals wi_skill_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_skill_proposals
    ADD CONSTRAINT wi_skill_proposals_pkey PRIMARY KEY (id);


--
-- Name: wi_skill_usage wi_skill_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_skill_usage
    ADD CONSTRAINT wi_skill_usage_pkey PRIMARY KEY (id);


--
-- Name: wi_source_links wi_source_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_source_links
    ADD CONSTRAINT wi_source_links_pkey PRIMARY KEY (id);


--
-- Name: worker_heartbeats worker_heartbeats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_heartbeats
    ADD CONSTRAINT worker_heartbeats_pkey PRIMARY KEY (worker_name, instance_id);


--
-- Name: worker_llm_spend worker_llm_spend_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_llm_spend
    ADD CONSTRAINT worker_llm_spend_pkey PRIMARY KEY (id);


--
-- Name: idx_accounts_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_accounts_email ON public.accounts USING btree (email);


--
-- Name: idx_accounts_google_sub; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_accounts_google_sub ON public.accounts USING btree (google_sub);


--
-- Name: idx_ae_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ae_parent ON public.absorbed_echoes USING btree (parent_addr);


--
-- Name: idx_agent_last_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_last_seen ON public.agent_profiles USING btree (tenant_id, last_seen DESC);


--
-- Name: idx_agent_queries_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_queries_agent ON public.agent_queries USING btree (tenant_id, agent_id, created_at DESC);


--
-- Name: idx_agent_watches_agent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_watches_agent_id ON public.agent_watches USING btree (agent_id);


--
-- Name: idx_agent_watches_last_checked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_watches_last_checked ON public.agent_watches USING btree (last_checked);


--
-- Name: idx_atl_account_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_atl_account_active ON public.account_tenant_links USING btree (account_id) WHERE (status = 'active'::text);


--
-- Name: idx_atl_tenant_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_atl_tenant_active ON public.account_tenant_links USING btree (tenant_id) WHERE (status = 'active'::text);


--
-- Name: idx_atom_feedback_node; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_atom_feedback_node ON public.atom_feedback USING btree (node_addr) WHERE (node_addr IS NOT NULL);


--
-- Name: idx_atom_feedback_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_atom_feedback_source ON public.atom_feedback USING btree (source_type, created_at);


--
-- Name: idx_atom_pool_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_atom_pool_created ON public.wi_atom_pool USING btree (created_at);


--
-- Name: idx_atom_pool_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_atom_pool_priority ON public.wi_atom_pool USING btree (priority DESC);


--
-- Name: idx_atom_pool_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_atom_pool_status ON public.wi_atom_pool USING btree (status);


--
-- Name: idx_atom_pool_temporality_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_atom_pool_temporality_status ON public.wi_atom_pool USING btree (temporality, status);


--
-- Name: idx_change_stream_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_change_stream_space_id ON public.change_stream USING btree (space_id, created_at DESC);


--
-- Name: idx_changelog_node; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_changelog_node ON public.resonance_changelog USING btree (node_addr, computed_at DESC);


--
-- Name: idx_changes_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_changes_recent ON public.change_stream USING btree (created_at DESC);


--
-- Name: idx_collapse_events_addr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_collapse_events_addr ON public.collapse_events USING btree (node_addr);


--
-- Name: idx_collapse_events_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_collapse_events_agent ON public.collapse_events USING btree (agent_id);


--
-- Name: idx_deltas_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deltas_batch ON public.confidence_deltas USING btree (ingest_batch_id);


--
-- Name: idx_distill_clusters_next_review; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_distill_clusters_next_review ON public.distill_clusters USING btree (status, next_review_at);


--
-- Name: idx_distill_clusters_status_built; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_distill_clusters_status_built ON public.distill_clusters USING btree (status, last_built_at DESC);


--
-- Name: idx_distill_clusters_work_item; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_distill_clusters_work_item ON public.distill_clusters USING btree (work_item_id);


--
-- Name: idx_distill_proposals_fusion_next_review; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_distill_proposals_fusion_next_review ON public.distill_proposals USING btree (fusion_status, fusion_next_review_at);


--
-- Name: idx_distill_proposals_fusion_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_distill_proposals_fusion_status ON public.distill_proposals USING btree (fusion_status, updated_at DESC);


--
-- Name: idx_distill_proposals_handoff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_distill_proposals_handoff ON public.distill_proposals USING btree (handoff_status, updated_at DESC);


--
-- Name: idx_distill_proposals_next_review; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_distill_proposals_next_review ON public.distill_proposals USING btree (status, next_review_at);


--
-- Name: idx_distill_proposals_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_distill_proposals_status_created ON public.distill_proposals USING btree (status, created_at DESC);


--
-- Name: idx_distill_proposals_work_item_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_distill_proposals_work_item_kind ON public.distill_proposals USING btree (work_item_id, proposal_kind);


--
-- Name: idx_distill_runs_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_distill_runs_started_at ON public.distill_runs USING btree (started_at DESC);


--
-- Name: idx_distill_runs_status_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_distill_runs_status_started_at ON public.distill_runs USING btree (status, started_at DESC);


--
-- Name: idx_distill_work_items_seed_pressure; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_distill_work_items_seed_pressure ON public.distill_work_items USING btree (scope_kind, seed_ref, pressure_type);


--
-- Name: idx_distill_work_items_status_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_distill_work_items_status_seen ON public.distill_work_items USING btree (status, last_seen_at DESC);


--
-- Name: idx_edge_usefulness_scores_computed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edge_usefulness_scores_computed ON public.edge_usefulness_scores USING btree (last_computed_at DESC);


--
-- Name: idx_edge_usefulness_scores_score_computed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edge_usefulness_scores_score_computed ON public.edge_usefulness_scores USING btree (score DESC, last_computed_at DESC);


--
-- Name: idx_edges_execution; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edges_execution ON public.edges USING btree (execution_count DESC) WHERE (execution_count > 0);


--
-- Name: idx_edges_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edges_from ON public.edges USING btree (from_addr);


--
-- Name: idx_edges_from_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edges_from_space_id ON public.edges USING btree (from_space_id);


--
-- Name: idx_edges_layer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edges_layer ON public.edges USING btree (layer);


--
-- Name: idx_edges_source_context_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edges_source_context_gin ON public.edges USING gin (source_context jsonb_path_ops);


--
-- Name: idx_edges_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edges_space_id ON public.edges USING btree (space_id);


--
-- Name: idx_edges_temporal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edges_temporal ON public.edges USING btree (valid_from, valid_until) WHERE (valid_until IS NOT NULL);


--
-- Name: idx_edges_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edges_to ON public.edges USING btree (to_addr);


--
-- Name: idx_edges_to_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edges_to_space_id ON public.edges USING btree (to_space_id);


--
-- Name: idx_edges_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edges_type ON public.edges USING btree (edge_type);


--
-- Name: idx_embed_cache_ttl; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_embed_cache_ttl ON public.query_embeddings USING btree (last_used_at);


--
-- Name: idx_entitlements_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entitlements_account ON public.subscription_entitlements USING btree (account_id);


--
-- Name: idx_et_consistency; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_et_consistency ON public.edge_tensions USING btree (consistency_status) WHERE (consistency_status = 'unchecked'::text);


--
-- Name: idx_et_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_et_from ON public.edge_tensions USING btree (from_addr) WHERE (resolved_at IS NULL);


--
-- Name: idx_et_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_et_to ON public.edge_tensions USING btree (to_addr) WHERE (resolved_at IS NULL);


--
-- Name: idx_et_type_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_et_type_active ON public.edge_tensions USING btree (tension_type) WHERE (resolved_at IS NULL);


--
-- Name: idx_fa_correlation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fa_correlation ON public.federation_activity USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: idx_fa_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fa_session ON public.federation_activity USING btree (tenant_id, session_type, session_id, ts DESC);


--
-- Name: idx_fa_session_init_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_fa_session_init_unique ON public.federation_activity USING btree (tenant_id, session_type, session_id) WHERE (event_type = 'session_initialized'::text);


--
-- Name: idx_fa_tenant_correlation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fa_tenant_correlation ON public.federation_activity USING btree (tenant_id, correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: idx_fa_tenant_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fa_tenant_ts ON public.federation_activity USING btree (tenant_id, ts DESC);


--
-- Name: idx_fa_ts_retention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fa_ts_retention ON public.federation_activity USING btree (ts);


--
-- Name: idx_federation_nodes_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_federation_nodes_status ON public.federation_nodes USING btree (status);


--
-- Name: idx_federation_nodes_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_federation_nodes_tenant ON public.federation_nodes USING btree (tenant_id);


--
-- Name: idx_federation_overlay_log_node; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_federation_overlay_log_node ON public.federation_overlay_log USING btree (tenant_id, node_id);


--
-- Name: idx_file_index_node; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_file_index_node ON public.file_index USING btree (node_addr);


--
-- Name: idx_file_index_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_file_index_path ON public.file_index USING btree (file_path);


--
-- Name: idx_file_index_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_file_index_type ON public.file_index USING btree (file_type);


--
-- Name: idx_fol_correlation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fol_correlation ON public.federation_overlay_log USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: idx_fol_tenant_correlation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fol_tenant_correlation ON public.federation_overlay_log USING btree (tenant_id, correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: idx_fol_tenant_synced; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fol_tenant_synced ON public.federation_overlay_log USING btree (tenant_id, synced_at DESC);


--
-- Name: idx_golden_query_cases_tenant_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_golden_query_cases_tenant_active ON public.golden_query_cases USING btree (tenant_id, active, slug);


--
-- Name: idx_golden_query_expectations_addr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_golden_query_expectations_addr ON public.golden_query_expectations USING btree (addr);


--
-- Name: idx_golden_query_expectations_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_golden_query_expectations_case ON public.golden_query_expectations USING btree (case_id, expectation_type);


--
-- Name: idx_golden_query_runs_case_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_golden_query_runs_case_created ON public.golden_query_runs USING btree (case_id, created_at DESC, id DESC);


--
-- Name: idx_golden_query_runs_case_revision_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_golden_query_runs_case_revision_created ON public.golden_query_runs USING btree (case_id, expectation_revision, created_at DESC, id DESC);


--
-- Name: idx_golden_query_runs_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_golden_query_runs_status_created ON public.golden_query_runs USING btree (status, created_at DESC);


--
-- Name: idx_golden_query_runs_supercron; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_golden_query_runs_supercron ON public.golden_query_runs USING btree (supercron_run_id);


--
-- Name: idx_graph_mutations_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_graph_mutations_space_id ON public.graph_mutations USING btree (space_id, created_at DESC);


--
-- Name: idx_graph_spaces_global_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_graph_spaces_global_kind ON public.graph_spaces USING btree (kind) WHERE (kind = 'global'::text);


--
-- Name: idx_grounding_gap_claims_gap; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grounding_gap_claims_gap ON public.grounding_gap_claims USING btree (gap_key, created_at DESC);


--
-- Name: idx_grounding_gap_claims_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grounding_gap_claims_status ON public.grounding_gap_claims USING btree (status, updated_at DESC);


--
-- Name: idx_grounding_gap_events_gap; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grounding_gap_events_gap ON public.grounding_gap_events USING btree (gap_key, created_at DESC);


--
-- Name: idx_grounding_gap_events_goal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grounding_gap_events_goal ON public.grounding_gap_events USING btree (goal_hash, created_at DESC);


--
-- Name: idx_grounding_gap_events_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grounding_gap_events_scope ON public.grounding_gap_events USING btree (space_id, access_scope, created_at DESC);


--
-- Name: idx_grounding_gap_profiles_branch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grounding_gap_profiles_branch ON public.grounding_gap_profiles USING btree (target_branch_addr, gap_type);


--
-- Name: idx_grounding_gap_profiles_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grounding_gap_profiles_identity ON public.grounding_gap_profiles USING btree (scope_kind, gap_type, intent_mode, target_branch_addr, canonical_focus_key);


--
-- Name: idx_grounding_gap_profiles_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grounding_gap_profiles_status ON public.grounding_gap_profiles USING btree (status, last_seen_at DESC);


--
-- Name: idx_hac_account_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hac_account_tenant ON public.hosted_agent_credentials USING btree (account_id, tenant_id);


--
-- Name: idx_hac_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hac_agent ON public.hosted_agent_credentials USING btree (agent_id);


--
-- Name: idx_hac_token_hash_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_hac_token_hash_active ON public.hosted_agent_credentials USING btree (token_hash) WHERE (status = 'active'::text);


--
-- Name: idx_hal_correlation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hal_correlation ON public.hosted_audit_log USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: idx_hal_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hal_created ON public.hosted_audit_log USING btree (created_at DESC);


--
-- Name: idx_hal_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hal_tenant ON public.hosted_audit_log USING btree (tenant_id, created_at DESC);


--
-- Name: idx_hal_tenant_correlation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hal_tenant_correlation ON public.hosted_audit_log USING btree (tenant_id, correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: idx_hmi_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hmi_batch ON public.hosted_mirror_items USING btree (tenant_id, sync_batch_id);


--
-- Name: idx_hmi_governance_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hmi_governance_key ON public.hosted_mirror_items USING btree (tenant_id, governance_key) WHERE (item_type = 'governance'::text);


--
-- Name: idx_hmi_journal_entry_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hmi_journal_entry_status ON public.hosted_mirror_items USING btree (tenant_id, item_addr, item_status) WHERE (item_type = 'journal_entry'::text);


--
-- Name: idx_hmi_memory_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hmi_memory_project ON public.hosted_mirror_items USING btree (tenant_id, project_addr) WHERE ((item_type = 'memory'::text) AND (item_status = 'active'::text));


--
-- Name: idx_hmi_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hmi_type ON public.hosted_mirror_items USING btree (tenant_id, item_type);


--
-- Name: idx_hmje_active_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hmje_active_day ON public.hosted_mirror_journal_entries USING btree (tenant_id, day_addr, captured_at DESC, entry_key DESC) WHERE ((item_status = 'active'::text) AND (entry_state = 'active'::text));


--
-- Name: idx_hmje_active_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hmje_active_project ON public.hosted_mirror_journal_entries USING btree (tenant_id, project_addr, target_date DESC, entry_key DESC) WHERE ((item_status = 'active'::text) AND (entry_state = 'active'::text) AND (project_addr IS NOT NULL));


--
-- Name: idx_hmje_active_routine; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hmje_active_routine ON public.hosted_mirror_journal_entries USING btree (tenant_id, routine_id, target_date DESC, captured_at DESC) WHERE ((item_status = 'active'::text) AND (entry_state = 'active'::text));


--
-- Name: idx_hmje_active_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hmje_active_search ON public.hosted_mirror_journal_entries USING btree (tenant_id, target_date DESC, captured_at DESC, entry_key DESC) WHERE ((item_status = 'active'::text) AND (entry_state = 'active'::text));


--
-- Name: idx_hmje_active_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hmje_active_tags ON public.hosted_mirror_journal_entries USING gin (tags) WHERE ((item_status = 'active'::text) AND (entry_state = 'active'::text));


--
-- Name: idx_hosted_connect_grants_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hosted_connect_grants_account ON public.hosted_connect_grants USING btree (account_id, created_at DESC) WHERE (account_id IS NOT NULL);


--
-- Name: idx_hosted_connect_grants_code_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_hosted_connect_grants_code_pending ON public.hosted_connect_grants USING btree (code_hash) WHERE ((status = 'pending'::text) AND (code_hash IS NOT NULL));


--
-- Name: idx_hosted_connect_grants_oauth_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hosted_connect_grants_oauth_state ON public.hosted_connect_grants USING btree (hosted_oauth_state_hash) WHERE ((status = 'pending'::text) AND (hosted_oauth_state_hash IS NOT NULL));


--
-- Name: idx_hosted_connect_grants_pending_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hosted_connect_grants_pending_expiry ON public.hosted_connect_grants USING btree (expires_at) WHERE (status = 'pending'::text);


--
-- Name: idx_hosted_drive_grants_pending_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hosted_drive_grants_pending_expiry ON public.hosted_drive_connect_grants USING btree (expires_at) WHERE (status = ANY (ARRAY['pending'::text, 'ready_for_redeem'::text]));


--
-- Name: idx_hosted_drive_grants_pending_state; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_hosted_drive_grants_pending_state ON public.hosted_drive_connect_grants USING btree (state_hash) WHERE (status = 'pending'::text);


--
-- Name: idx_hosted_drive_metadata_tenant_file_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hosted_drive_metadata_tenant_file_id ON public.hosted_drive_files USING btree (tenant_id, drive_file_id);


--
-- Name: idx_hosted_drive_metadata_tenant_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hosted_drive_metadata_tenant_project ON public.hosted_drive_files USING btree (tenant_id, project_addr);


--
-- Name: idx_hosted_drive_metadata_tenant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hosted_drive_metadata_tenant_status ON public.hosted_drive_files USING btree (tenant_id, status);


--
-- Name: idx_hosted_nodes_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hosted_nodes_account ON public.hosted_nodes USING btree (account_id);


--
-- Name: idx_hosted_nodes_drive_primary_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_hosted_nodes_drive_primary_active ON public.hosted_nodes USING btree (tenant_id) WHERE ((status = 'active'::text) AND (drive_mirror_primary_at IS NOT NULL));


--
-- Name: idx_hosted_nodes_sync_token; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_hosted_nodes_sync_token ON public.hosted_nodes USING btree (sync_token_hash) WHERE ((sync_token_hash IS NOT NULL) AND (status = 'active'::text));


--
-- Name: idx_hosted_nodes_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_hosted_nodes_unique ON public.hosted_nodes USING btree (account_id, tenant_id, node_id) WHERE (status = 'active'::text);


--
-- Name: idx_hosted_rate_limit_buckets_reset_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hosted_rate_limit_buckets_reset_at ON public.hosted_rate_limit_buckets USING btree (reset_at);


--
-- Name: idx_hosted_tenant_identities_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hosted_tenant_identities_created_by ON public.hosted_tenant_identities USING btree (created_by_account_id);


--
-- Name: idx_hsb_node; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hsb_node ON public.hosted_sync_batches USING btree (tenant_id, node_id);


--
-- Name: idx_intake_queue_space_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_intake_queue_space_status ON public.intake_queue USING btree (space_id, review_status, created_at DESC);


--
-- Name: idx_link_codes_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_link_codes_hash ON public.account_link_codes USING btree (code_hash) WHERE (redeemed = false);


--
-- Name: idx_me_correlation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_me_correlation ON public.memory_events USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: idx_memory_conflicts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_conflicts_status ON public.memory_conflicts USING btree (status);


--
-- Name: idx_memory_conflicts_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_conflicts_tenant ON public.memory_conflicts USING btree (tenant_id);


--
-- Name: idx_memory_events_addr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_events_addr ON public.memory_events USING btree (addr);


--
-- Name: idx_memory_events_correlation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_events_correlation ON public.memory_events USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: idx_memory_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_events_created ON public.memory_events USING btree (created_at DESC);


--
-- Name: idx_memory_events_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_events_tenant ON public.memory_events USING btree (tenant_id);


--
-- Name: idx_memory_events_tenant_correlation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_events_tenant_correlation ON public.memory_events USING btree (tenant_id, correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: idx_memory_events_tenant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_events_tenant_created ON public.memory_events USING btree (tenant_id, created_at DESC);


--
-- Name: idx_memory_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_events_type ON public.memory_events USING btree (event_type);


--
-- Name: idx_memory_registry_effective; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_registry_effective ON public.memory_registry USING btree (effective_at DESC);


--
-- Name: idx_memory_registry_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_registry_kind ON public.memory_registry USING btree (kind);


--
-- Name: idx_memory_registry_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_registry_status ON public.memory_registry USING btree (status);


--
-- Name: idx_memory_registry_supersedes; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_registry_supersedes ON public.memory_registry USING btree (supersedes_addr) WHERE (supersedes_addr IS NOT NULL);


--
-- Name: idx_memory_registry_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_registry_tenant ON public.memory_registry USING btree (tenant_id);


--
-- Name: idx_mutations_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mutations_time ON public.graph_mutations USING btree (created_at DESC);


--
-- Name: idx_mutations_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mutations_type ON public.graph_mutations USING btree (mutation_type, created_at DESC);


--
-- Name: idx_node_history_addr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_node_history_addr ON public.node_history USING btree (addr, created_at DESC);


--
-- Name: idx_node_publications_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_node_publications_source ON public.node_publications USING btree (source_space_id, source_addr, published_at DESC);


--
-- Name: idx_node_publications_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_node_publications_status ON public.node_publications USING btree (status, published_at DESC);


--
-- Name: idx_node_publications_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_node_publications_target ON public.node_publications USING btree (target_space_id, target_addr, published_at DESC);


--
-- Name: idx_nodes_confidence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_confidence ON public.nodes USING btree (confidence DESC);


--
-- Name: idx_nodes_depth; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_depth ON public.nodes USING btree (pyramid_id, layer, depth);


--
-- Name: idx_nodes_embedding_hv_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_embedding_hv_hnsw ON public.nodes USING hnsw (embedding_hv public.halfvec_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: idx_nodes_embedding_hv_public; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_embedding_hv_public ON public.nodes USING hnsw (embedding_hv public.halfvec_cosine_ops) WITH (m='16', ef_construction='64') WHERE (visibility = 'public'::text);


--
-- Name: idx_nodes_layer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_layer ON public.nodes USING btree (pyramid_id, layer);


--
-- Name: idx_nodes_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_parent ON public.nodes USING btree (parent_addr);


--
-- Name: idx_nodes_pyramid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_pyramid ON public.nodes USING btree (pyramid_id);


--
-- Name: idx_nodes_query_hits; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_query_hits ON public.nodes USING btree (query_hits DESC);


--
-- Name: idx_nodes_resonance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_resonance ON public.nodes USING btree (resonance DESC);


--
-- Name: idx_nodes_resonance_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_resonance_at ON public.nodes USING btree (resonance_at DESC) WHERE (resonance_at IS NOT NULL);


--
-- Name: idx_nodes_search_vector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_search_vector ON public.nodes USING gin (search_vector);


--
-- Name: idx_nodes_source_context_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_source_context_gin ON public.nodes USING gin (source_context jsonb_path_ops);


--
-- Name: idx_nodes_source_refs; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_source_refs ON public.nodes USING gin (source_refs);


--
-- Name: idx_nodes_space_addr_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_nodes_space_addr_unique ON public.nodes USING btree (space_id, addr);


--
-- Name: idx_nodes_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_space_id ON public.nodes USING btree (space_id);


--
-- Name: idx_nodes_temperature; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_temperature ON public.nodes USING btree (temperature DESC);


--
-- Name: idx_nodes_tenant_pyramid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_tenant_pyramid ON public.nodes USING btree (tenant_pyramid_id) WHERE ((pyramid_id = 'PROJECTS'::text) AND (depth = 1) AND (tenant_pyramid_id IS NOT NULL));


--
-- Name: idx_nodes_trend_lifecycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_trend_lifecycle ON public.nodes USING btree ((((source_context -> 'trend'::text) ->> 'lifecycle'::text))) WHERE (node_type = 'trend'::text);


--
-- Name: idx_oauth_authz_req_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_authz_req_account ON public.oauth_authorization_requests USING btree (account_id, tenant_id, created_at DESC);


--
-- Name: idx_oauth_authz_req_client_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_authz_req_client_open ON public.oauth_authorization_requests USING btree (client_id, expires_at) WHERE (consumed_at IS NULL);


--
-- Name: idx_oauth_authz_req_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_authz_req_open ON public.oauth_authorization_requests USING btree (expires_at) WHERE (consumed_at IS NULL);


--
-- Name: idx_oauth_clients_retention_archive; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_clients_retention_archive ON public.oauth_clients USING btree (dormant_at) WHERE (status = 'dormant'::text);


--
-- Name: idx_oauth_clients_retention_dormant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_clients_retention_dormant ON public.oauth_clients USING btree (last_used_at) WHERE ((status = 'active'::text) AND (last_used_at IS NOT NULL));


--
-- Name: idx_oauth_clients_retention_never_used; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_clients_retention_never_used ON public.oauth_clients USING btree (registered_at) WHERE ((status = 'active'::text) AND (last_used_at IS NULL));


--
-- Name: idx_oauth_clients_status_registered; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_clients_status_registered ON public.oauth_clients USING btree (status, registered_at DESC);


--
-- Name: idx_oauth_grants_access_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_oauth_grants_access_hash ON public.oauth_grants USING btree (access_token_hash) WHERE (access_token_hash IS NOT NULL);


--
-- Name: idx_oauth_grants_account_tenant_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_grants_account_tenant_active ON public.oauth_grants USING btree (account_id, tenant_id, issued_at DESC) WHERE (status = 'active'::text);


--
-- Name: idx_oauth_grants_auth_code_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_oauth_grants_auth_code_hash ON public.oauth_grants USING btree (auth_code_hash) WHERE (auth_code_hash IS NOT NULL);


--
-- Name: idx_oauth_grants_client_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_grants_client_active ON public.oauth_grants USING btree (client_id) WHERE (status = 'active'::text);


--
-- Name: idx_oauth_grants_credential; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_grants_credential ON public.oauth_grants USING btree (hosted_agent_credential_id, status);


--
-- Name: idx_oauth_grants_family_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_grants_family_status ON public.oauth_grants USING btree (grant_family_id, status);


--
-- Name: idx_oauth_grants_refresh_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_oauth_grants_refresh_hash ON public.oauth_grants USING btree (refresh_token_hash) WHERE (refresh_token_hash IS NOT NULL);


--
-- Name: idx_path_events_addr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_path_events_addr ON public.agent_path_events USING btree (addr_selected) WHERE (addr_selected IS NOT NULL);


--
-- Name: idx_path_events_agent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_path_events_agent_id ON public.agent_path_events USING btree (agent_id, created_at DESC);


--
-- Name: idx_path_events_alpha_omega; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_path_events_alpha_omega ON public.agent_path_events USING btree (created_at DESC) WHERE (alpha_omega_present = true);


--
-- Name: idx_path_events_endpoint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_path_events_endpoint ON public.agent_path_events USING btree (endpoint);


--
-- Name: idx_path_events_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_path_events_run_id ON public.agent_path_events USING btree (run_id);


--
-- Name: idx_proposal_embeddings_archetype_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proposal_embeddings_archetype_hnsw ON public.proposal_embeddings USING hnsw (embedding_hv public.halfvec_cosine_ops) WITH (m='16', ef_construction='64') WHERE (purpose = 'archetype_dedup'::text);


--
-- Name: idx_proposal_embeddings_purpose; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proposal_embeddings_purpose ON public.proposal_embeddings USING btree (purpose);


--
-- Name: idx_proposal_embeddings_source_payload_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proposal_embeddings_source_payload_hash ON public.proposal_embeddings USING btree (source_payload_hash) WHERE (purpose = 'archetype_dedup'::text);


--
-- Name: idx_proposals_archetype_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proposals_archetype_pending ON public.proposals USING btree (created_at) WHERE ((proposal_type = 'archetype'::text) AND (status = 'pending'::text));


--
-- Name: idx_proposals_edge_usefulness_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proposals_edge_usefulness_dedup ON public.proposals USING btree (((payload ->> 'edge_id'::text)), status) WHERE ((proposal_type = 'edge'::text) AND ((payload ->> 'action'::text) = 'edge_usefulness_cleanup'::text));


--
-- Name: idx_proposals_edge_usefulness_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_proposals_edge_usefulness_unique ON public.proposals USING btree (((payload ->> 'edge_id'::text))) WHERE ((proposal_type = 'edge'::text) AND ((payload ->> 'action'::text) = 'edge_usefulness_cleanup'::text) AND (status = ANY (ARRAY['pending'::text, 'approved'::text])));


--
-- Name: idx_proposals_inference_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proposals_inference_pending ON public.proposals USING btree (created_at) WHERE ((proposal_type = 'inference'::text) AND (status = 'pending'::text));


--
-- Name: idx_proposals_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proposals_status ON public.proposals USING btree (status, created_at);


--
-- Name: idx_proposals_tension_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proposals_tension_pending ON public.proposals USING btree (created_at) WHERE ((proposal_type = 'tension'::text) AND (status = 'pending'::text));


--
-- Name: idx_proto_clusters_centroid_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proto_clusters_centroid_hnsw ON public.wi_proto_clusters USING hnsw (centroid public.halfvec_cosine_ops) WHERE (centroid IS NOT NULL);


--
-- Name: idx_public_contribution_events_publication; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_public_contribution_events_publication ON public.public_contribution_events USING btree (publication_id, created_at DESC);


--
-- Name: idx_public_contribution_events_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_public_contribution_events_source ON public.public_contribution_events USING btree (source_space_id, source_addr, created_at DESC);


--
-- Name: idx_public_contribution_events_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_public_contribution_events_target ON public.public_contribution_events USING btree (target_addr, created_at DESC);


--
-- Name: idx_query_log_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_query_log_created ON public.query_log USING btree (created_at DESC);


--
-- Name: idx_query_log_top_addr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_query_log_top_addr ON public.query_log USING btree (top_addr);


--
-- Name: idx_queue_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_queue_batch ON public.intake_queue USING btree (ingest_batch_id);


--
-- Name: idx_queue_review; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_queue_review ON public.intake_queue USING btree (review_status, is_contradiction DESC, score DESC) WHERE (review_status = 'pending'::text);


--
-- Name: idx_recall_outcome_events_one_recalled; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_recall_outcome_events_one_recalled ON public.recall_outcome_events USING btree (recall_id) WHERE (event_type = 'recalled'::text);


--
-- Name: idx_recall_outcome_events_recall; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recall_outcome_events_recall ON public.recall_outcome_events USING btree (recall_id, created_at DESC);


--
-- Name: idx_recall_outcome_events_tenant_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recall_outcome_events_tenant_time ON public.recall_outcome_events USING btree (tenant_id, created_at DESC);


--
-- Name: idx_recall_outcome_events_tenant_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recall_outcome_events_tenant_type ON public.recall_outcome_events USING btree (tenant_id, event_type, created_at DESC);


--
-- Name: idx_remote_commands_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_remote_commands_idempotency ON public.remote_commands USING btree (tenant_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: idx_remote_commands_tenant_account_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_remote_commands_tenant_account_status ON public.remote_commands USING btree (tenant_id, account_id, status);


--
-- Name: idx_remote_commands_tenant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_remote_commands_tenant_status ON public.remote_commands USING btree (tenant_id, status);


--
-- Name: idx_remote_commands_tenant_target_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_remote_commands_tenant_target_status ON public.remote_commands USING btree (tenant_id, target_node_id, status) WHERE (target_node_id IS NOT NULL);


--
-- Name: idx_review_proposals_idem; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_review_proposals_idem ON public.review_proposals USING btree (idempotency_key);


--
-- Name: idx_review_proposals_tenant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_proposals_tenant_status ON public.review_proposals USING btree (tenant_id, status, severity);


--
-- Name: idx_routine_suppression_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_routine_suppression_lookup ON public.supercron_routine_suppression USING btree (routine_name, suppressed_until DESC);


--
-- Name: idx_routine_suppression_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_routine_suppression_tenant ON public.supercron_routine_suppression USING btree (tenant_id);


--
-- Name: idx_sc_active_by_node; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sc_active_by_node ON public.stimulus_contributions USING btree (node_addr) WHERE (contribution > 0.001);


--
-- Name: idx_sc_node_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sc_node_created ON public.stimulus_contributions USING btree (node_addr, created_at DESC);


--
-- Name: idx_sc_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sc_priority ON public.stimulus_contributions USING btree (node_addr, priority_score);


--
-- Name: idx_schedules_next; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_next ON public.vi_schedules USING btree (next_run_at) WHERE (enabled = true);


--
-- Name: idx_schema_migrations_applied_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schema_migrations_applied_at ON public.schema_migrations USING btree (applied_at DESC);


--
-- Name: idx_sessions_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_account ON public.account_sessions USING btree (account_id);


--
-- Name: idx_sessions_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_token_hash ON public.account_sessions USING btree (token_hash) WHERE (revoked = false);


--
-- Name: idx_sh_normalized_url; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sh_normalized_url ON public.source_history USING btree (normalized_url);


--
-- Name: idx_sh_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sh_status ON public.source_history USING btree (status);


--
-- Name: idx_sj_seq_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sj_seq_type ON public.sync_journal USING btree (seq, item_type);


--
-- Name: idx_source_history_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_source_history_batch ON public.source_history USING btree (ingest_batch_id);


--
-- Name: idx_source_history_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_source_history_space_id ON public.source_history USING btree (space_id, ingested_at DESC);


--
-- Name: idx_source_history_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_source_history_type ON public.source_history USING btree (source_type);


--
-- Name: idx_staging_edges_active_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_staging_edges_active_unique ON public.staging_edges USING btree (from_addr, to_addr, edge_type) WHERE (qc_status = ANY (ARRAY['pending'::text, 'revised'::text, 'processing'::text]));


--
-- Name: idx_staging_edges_claimable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staging_edges_claimable ON public.staging_edges USING btree (qc_status, claimed_at, created_at);


--
-- Name: idx_staging_edges_space_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staging_edges_space_status ON public.staging_edges USING btree (space_id, qc_status, created_at DESC);


--
-- Name: idx_staging_edges_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staging_edges_status ON public.staging_edges USING btree (qc_status, run_id);


--
-- Name: idx_staging_nodes_claimable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staging_nodes_claimable ON public.staging_nodes USING btree (qc_status, claimed_at, created_at);


--
-- Name: idx_staging_nodes_space_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staging_nodes_space_status ON public.staging_nodes USING btree (space_id, qc_status, created_at DESC);


--
-- Name: idx_staging_nodes_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staging_nodes_status ON public.staging_nodes USING btree (qc_status, run_id);


--
-- Name: idx_staging_updates_claimable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staging_updates_claimable ON public.staging_updates USING btree (qc_status, claimed_at, created_at);


--
-- Name: idx_staging_updates_space_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staging_updates_space_status ON public.staging_updates USING btree (space_id, qc_status, created_at DESC);


--
-- Name: idx_staging_updates_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staging_updates_status ON public.staging_updates USING btree (qc_status, run_id);


--
-- Name: idx_stimuli_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stimuli_batch ON public.stimuli USING btree (ingest_batch_id) WHERE (ingest_batch_id IS NOT NULL);


--
-- Name: idx_stimuli_by_node; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stimuli_by_node ON public.stimuli USING btree (node_addr) WHERE (node_addr IS NOT NULL);


--
-- Name: idx_stimuli_correlation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stimuli_correlation ON public.stimuli USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: idx_stimuli_embedding_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stimuli_embedding_hnsw ON public.stimuli USING hnsw (embedding public.halfvec_cosine_ops) WHERE (embedding IS NOT NULL);


--
-- Name: idx_stimuli_origin_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stimuli_origin_created ON public.stimuli USING btree (origin_key, created_at DESC) WHERE (origin_key IS NOT NULL);


--
-- Name: idx_stimuli_orphans; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stimuli_orphans ON public.stimuli USING btree (created_at) WHERE ((is_orphan = true) AND (orphan_status = 'throbbing'::text));


--
-- Name: idx_stimuli_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stimuli_parent ON public.stimuli USING btree (parent_stimulus_id) WHERE (parent_stimulus_id IS NOT NULL);


--
-- Name: idx_stimuli_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stimuli_pending ON public.stimuli USING btree (created_at) WHERE (NOT processed);


--
-- Name: idx_stimuli_proto_cluster; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stimuli_proto_cluster ON public.stimuli USING btree (proto_cluster_id) WHERE ((is_orphan = true) AND (orphan_status = 'throbbing'::text));


--
-- Name: idx_stimuli_source_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stimuli_source_created ON public.stimuli USING btree (source, created_at DESC);


--
-- Name: idx_stimuli_source_processed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stimuli_source_processed ON public.stimuli USING btree (source, processed_at);


--
-- Name: idx_stimuli_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stimuli_space_id ON public.stimuli USING btree (space_id, created_at DESC);


--
-- Name: idx_stimulus_contributions_correlation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stimulus_contributions_correlation ON public.stimulus_contributions USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: idx_supercron_manual_runs_one_open_per_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_supercron_manual_runs_one_open_per_tenant ON public.supercron_manual_runs USING btree (tenant_id) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]));


--
-- Name: idx_supercron_manual_runs_tenant_requested; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supercron_manual_runs_tenant_requested ON public.supercron_manual_runs USING btree (tenant_id, requested_at DESC);


--
-- Name: idx_supercron_node_gc_receipts_active_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_supercron_node_gc_receipts_active_unique ON public.supercron_node_gc_receipts USING btree (tenant_id, addr) WHERE (status = ANY (ARRAY['candidate'::text, 'approved'::text]));


--
-- Name: idx_supercron_node_gc_receipts_apply_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supercron_node_gc_receipts_apply_queue ON public.supercron_node_gc_receipts USING btree (tenant_id, predicate_version, reviewed_at, marked_at, id) WHERE (status = 'approved'::text);


--
-- Name: idx_supercron_node_gc_receipts_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supercron_node_gc_receipts_batch ON public.supercron_node_gc_receipts USING btree (batch_id);


--
-- Name: idx_supercron_node_gc_receipts_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supercron_node_gc_receipts_expires ON public.supercron_node_gc_receipts USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: idx_supercron_node_gc_receipts_predicate_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supercron_node_gc_receipts_predicate_version ON public.supercron_node_gc_receipts USING btree (predicate_version, status);


--
-- Name: idx_supercron_node_gc_receipts_rejected_cooldown; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supercron_node_gc_receipts_rejected_cooldown ON public.supercron_node_gc_receipts USING btree (tenant_id, addr, expires_at) WHERE ((status = 'rejected'::text) AND (expires_at IS NOT NULL));


--
-- Name: idx_supercron_node_gc_receipts_tenant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supercron_node_gc_receipts_tenant_status ON public.supercron_node_gc_receipts USING btree (tenant_id, status, marked_at DESC);


--
-- Name: idx_supercron_pass_telemetry_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supercron_pass_telemetry_created ON public.supercron_pass_telemetry USING btree (created_at DESC);


--
-- Name: idx_supercron_pass_telemetry_pass_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supercron_pass_telemetry_pass_created ON public.supercron_pass_telemetry USING btree (pass_name, created_at DESC);


--
-- Name: idx_supercron_pass_telemetry_supercron; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supercron_pass_telemetry_supercron ON public.supercron_pass_telemetry USING btree (supercron_run_id);


--
-- Name: idx_supercron_runs_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supercron_runs_started ON public.supercron_runs USING btree (started_at DESC);


--
-- Name: idx_temporal_intake_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_temporal_intake_day ON public.temporal_intake USING btree (target_day, status);


--
-- Name: idx_temporal_intake_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_temporal_intake_space ON public.temporal_intake USING btree (space_id);


--
-- Name: idx_tenant_day_journal_entries_active_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_day_journal_entries_active_date ON public.tenant_day_journal_entries USING btree (tenant_id, target_date, captured_at DESC) WHERE (entry_state = 'active'::text);


--
-- Name: idx_tenant_day_journal_entries_active_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_day_journal_entries_active_day ON public.tenant_day_journal_entries USING btree (tenant_id, day_addr, captured_at DESC) WHERE (entry_state = 'active'::text);


--
-- Name: idx_tenant_day_journal_entries_active_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_day_journal_entries_active_project ON public.tenant_day_journal_entries USING btree (tenant_id, project_addr, captured_at DESC) WHERE ((entry_state = 'active'::text) AND (project_addr IS NOT NULL));


--
-- Name: idx_tenant_day_journal_entries_active_routine; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_day_journal_entries_active_routine ON public.tenant_day_journal_entries USING btree (tenant_id, routine_id, captured_at DESC) WHERE (entry_state = 'active'::text);


--
-- Name: idx_tenant_day_journal_entries_active_search_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_day_journal_entries_active_search_order ON public.tenant_day_journal_entries USING btree (tenant_id, target_date DESC, captured_at DESC, entry_key DESC) WHERE (entry_state = 'active'::text);


--
-- Name: idx_tenant_day_journal_entries_active_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_day_journal_entries_active_tags ON public.tenant_day_journal_entries USING gin (tags) WHERE (entry_state = 'active'::text);


--
-- Name: idx_tenant_day_journal_entries_active_target_path_prefix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_day_journal_entries_active_target_path_prefix ON public.tenant_day_journal_entries USING btree (tenant_id, target_path text_pattern_ops) WHERE (entry_state = 'active'::text);


--
-- Name: idx_tenant_day_journal_entries_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_tenant_day_journal_entries_idempotency ON public.tenant_day_journal_entries USING btree (tenant_id, idempotency_namespace, idempotency_key_sha256) WHERE (idempotency_key_sha256 IS NOT NULL);


--
-- Name: idx_tenant_day_journal_entries_routine_target; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_tenant_day_journal_entries_routine_target ON public.tenant_day_journal_entries USING btree (tenant_id, day_addr, routine_id, target_path) WHERE (entry_key ~~ 'routine_%'::text);


--
-- Name: idx_tenant_day_journal_entries_state_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_day_journal_entries_state_updated ON public.tenant_day_journal_entries USING btree (tenant_id, entry_state, updated_at DESC);


--
-- Name: idx_tenant_day_journal_routines_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_day_journal_routines_enabled ON public.tenant_day_journal_routines USING btree (tenant_id, enabled);


--
-- Name: idx_tenant_day_journal_runs_idempotency_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_tenant_day_journal_runs_idempotency_active ON public.tenant_day_journal_routine_runs USING btree (tenant_id, idempotency_namespace, idempotency_key_sha256) WHERE ((idempotency_key_sha256 IS NOT NULL) AND (dry_run = false) AND (run_status = ANY (ARRAY['pending'::text, 'running'::text])));


--
-- Name: idx_tenant_day_journal_runs_routine_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_day_journal_runs_routine_started ON public.tenant_day_journal_routine_runs USING btree (tenant_id, routine_id, started_at DESC);


--
-- Name: idx_tenant_day_journal_runs_scheduled_fire; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_tenant_day_journal_runs_scheduled_fire ON public.tenant_day_journal_routine_runs USING btree (tenant_id, routine_id, target_path, scheduled_fire_at) WHERE ((trigger = 'schedule'::text) AND (dry_run = false));


--
-- Name: idx_tenant_day_journal_runs_stalled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_day_journal_runs_stalled ON public.tenant_day_journal_routine_runs USING btree (last_progress_at) WHERE (run_status = 'running'::text);


--
-- Name: idx_tenant_day_journal_runs_target_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_day_journal_runs_target_date ON public.tenant_day_journal_routine_runs USING btree (tenant_id, target_date);


--
-- Name: idx_tenant_pyramids_label_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_tenant_pyramids_label_unique ON public.tenant_pyramids USING btree (tenant_id, lower(label));


--
-- Name: idx_tenant_pyramids_system_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_tenant_pyramids_system_key ON public.tenant_pyramids USING btree (tenant_id, system_key) WHERE (system_key IS NOT NULL);


--
-- Name: idx_tenant_pyramids_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_pyramids_tenant ON public.tenant_pyramids USING btree (tenant_id);


--
-- Name: idx_tenant_settings_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_settings_tenant_id ON public.tenant_settings USING btree (tenant_id);


--
-- Name: idx_tenant_sync_preferences_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_sync_preferences_updated_at ON public.tenant_sync_preferences USING btree (updated_at);


--
-- Name: idx_tkd_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tkd_tenant ON public.tenant_key_domains USING btree (tenant_id);


--
-- Name: idx_tkd_tenant_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_tkd_tenant_active ON public.tenant_key_domains USING btree (tenant_id) WHERE (status = 'active'::text);


--
-- Name: idx_tkd_tenant_version; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_tkd_tenant_version ON public.tenant_key_domains USING btree (tenant_id, key_version);


--
-- Name: idx_trend_archive_centroid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_archive_centroid ON public.trend_archive USING hnsw (centroid public.halfvec_cosine_ops);


--
-- Name: idx_trend_archive_death_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_archive_death_time ON public.trend_archive USING btree (death_time DESC);


--
-- Name: idx_trend_archive_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_archive_space_id ON public.trend_archive USING btree (space_id, death_time DESC);


--
-- Name: idx_trend_centroids_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_centroids_hnsw ON public.trend_centroids USING hnsw (centroid public.halfvec_cosine_ops);


--
-- Name: idx_trend_centroids_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_centroids_kind ON public.trend_centroids USING btree (ref_kind, updated_at DESC);


--
-- Name: idx_trend_centroids_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_centroids_space_id ON public.trend_centroids USING btree (space_id, updated_at DESC);


--
-- Name: idx_trend_decision_audits_kind_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_decision_audits_kind_created ON public.trend_decision_audits USING btree (decision_kind, created_at DESC);


--
-- Name: idx_trend_decision_audits_policy_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_decision_audits_policy_status ON public.trend_decision_audits USING btree (policy_status, created_at DESC);


--
-- Name: idx_trend_decision_audits_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_decision_audits_ref ON public.trend_decision_audits USING btree (ref_kind, ref_id, created_at DESC);


--
-- Name: idx_trend_decision_audits_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_decision_audits_space_id ON public.trend_decision_audits USING btree (space_id, created_at DESC);


--
-- Name: idx_trend_decision_audits_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_decision_audits_status_created ON public.trend_decision_audits USING btree (status, created_at DESC);


--
-- Name: idx_trend_decision_audits_trend; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_decision_audits_trend ON public.trend_decision_audits USING btree (trend_addr, created_at DESC) WHERE (trend_addr IS NOT NULL);


--
-- Name: idx_trend_events_addr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_events_addr ON public.trend_events USING btree (trend_addr, created_at DESC) WHERE (trend_addr IS NOT NULL);


--
-- Name: idx_trend_events_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_events_batch ON public.trend_events USING btree (ingest_batch_id, created_at DESC) WHERE (ingest_batch_id IS NOT NULL);


--
-- Name: idx_trend_events_cluster; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_events_cluster ON public.trend_events USING btree (proto_cluster_id, created_at DESC) WHERE (proto_cluster_id IS NOT NULL);


--
-- Name: idx_trend_events_space_event_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_events_space_event_type ON public.trend_events USING btree (space_id, event_type, created_at DESC);


--
-- Name: idx_trend_events_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_events_space_id ON public.trend_events USING btree (space_id, created_at DESC);


--
-- Name: idx_trend_events_stimulus; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_events_stimulus ON public.trend_events USING btree (stimulus_id, created_at DESC) WHERE (stimulus_id IS NOT NULL);


--
-- Name: idx_trend_events_type_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_events_type_created ON public.trend_events USING btree (event_type, created_at DESC);


--
-- Name: idx_trend_policy_overrides_hold; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_policy_overrides_hold ON public.trend_policy_overrides USING btree (action, hold_until DESC);


--
-- Name: idx_trend_policy_overrides_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_policy_overrides_space_id ON public.trend_policy_overrides USING btree (space_id, action, hold_until DESC);


--
-- Name: idx_vi_raw_queue_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vi_raw_queue_status ON public.vi_raw_queue USING btree (status) WHERE (status = 'pending'::text);


--
-- Name: idx_vi_schedule_runs_schedule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vi_schedule_runs_schedule ON public.vi_schedule_runs USING btree (schedule_id, started_at DESC);


--
-- Name: idx_vi_schedule_runs_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vi_schedule_runs_started_at ON public.vi_schedule_runs USING btree (started_at DESC);


--
-- Name: idx_vi_schedules_rss_source_norm_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_vi_schedules_rss_source_norm_unique ON public.vi_schedules USING btree (source_input_normalized) WHERE ((adapter_name = 'rss'::text) AND (source_input_normalized IS NOT NULL));


--
-- Name: idx_wi_proto_clusters_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wi_proto_clusters_space_id ON public.wi_proto_clusters USING btree (space_id, last_fed DESC);


--
-- Name: idx_wi_queue_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wi_queue_priority ON public.wi_queue USING btree (priority, submitted_at);


--
-- Name: idx_wi_queue_space_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wi_queue_space_status ON public.wi_queue USING btree (space_id, status, submitted_at DESC);


--
-- Name: idx_wi_queue_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wi_queue_status ON public.wi_queue USING btree (status);


--
-- Name: idx_wi_runs_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wi_runs_space_id ON public.wi_runs USING btree (space_id, created_at DESC);


--
-- Name: idx_wi_source_links_space_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wi_source_links_space_id ON public.wi_source_links USING btree (space_id, created_at DESC);


--
-- Name: idx_wiah_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wiah_created ON public.wi_atom_hashes USING btree (created_at);


--
-- Name: idx_wice_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wice_status ON public.wi_convergence_events USING btree (status);


--
-- Name: idx_wisl_node; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wisl_node ON public.wi_source_links USING btree (node_addr);


--
-- Name: idx_worker_heartbeats_status_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_worker_heartbeats_status_time ON public.worker_heartbeats USING btree (status, last_heartbeat DESC);


--
-- Name: idx_worker_heartbeats_worker_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_worker_heartbeats_worker_time ON public.worker_heartbeats USING btree (worker_name, last_heartbeat DESC);


--
-- Name: idx_worker_llm_spend_tenant_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_worker_llm_spend_tenant_time ON public.worker_llm_spend USING btree (tenant_id, occurred_at DESC);


--
-- Name: idx_worker_llm_spend_worker_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_worker_llm_spend_worker_time ON public.worker_llm_spend USING btree (worker_name, occurred_at DESC);


--
-- Name: uniq_grounding_gap_claims_active_claimant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_grounding_gap_claims_active_claimant ON public.grounding_gap_claims USING btree (gap_key, claimant, claim_type) WHERE (status = ANY (ARRAY['open'::text, 'submitted'::text, 'reviewed'::text]));


--
-- Name: uniq_grounding_gap_events_dedupe; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_grounding_gap_events_dedupe ON public.grounding_gap_events USING btree (dedupe_key) WHERE (dedupe_key IS NOT NULL);


--
-- Name: uq_proposal_embeddings_proposal_purpose; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_proposal_embeddings_proposal_purpose ON public.proposal_embeddings USING btree (proposal_id, purpose);


--
-- Name: edges edge_label_fill; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER edge_label_fill BEFORE INSERT OR UPDATE OF label, from_addr, to_addr, edge_type ON public.edges FOR EACH ROW EXECUTE FUNCTION public.fill_edge_label();


--
-- Name: hosted_tenant_identities prevent_locked_hosted_tenant_slug_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prevent_locked_hosted_tenant_slug_change BEFORE UPDATE ON public.hosted_tenant_identities FOR EACH ROW EXECUTE FUNCTION public.prevent_locked_hosted_tenant_slug_change();


--
-- Name: change_stream scope_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER scope_notify AFTER INSERT ON public.change_stream FOR EACH ROW EXECUTE FUNCTION public.notify_scope();


--
-- Name: supercron_node_gc_receipts snapshot_intended_action_on_approval; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER snapshot_intended_action_on_approval BEFORE INSERT OR UPDATE OF status ON public.supercron_node_gc_receipts FOR EACH ROW EXECUTE FUNCTION public.snapshot_intended_apply_action();


--
-- Name: staging_edges staging_edge_label_fill; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER staging_edge_label_fill BEFORE INSERT OR UPDATE OF label, from_addr, to_addr, edge_type ON public.staging_edges FOR EACH ROW EXECUTE FUNCTION public.fill_edge_label();


--
-- Name: account_ui_preferences touch_account_ui_preferences_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_account_ui_preferences_updated_at BEFORE UPDATE ON public.account_ui_preferences FOR EACH ROW EXECUTE FUNCTION public.touch_account_ui_preferences_updated_at();


--
-- Name: edges trg_edges_assign_spaces; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_edges_assign_spaces BEFORE INSERT OR UPDATE OF from_addr, to_addr, space_id, from_space_id, to_space_id ON public.edges FOR EACH ROW EXECUTE FUNCTION public.verity_assign_edge_spaces();


--
-- Name: golden_query_cases trg_golden_query_cases_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_golden_query_cases_updated_at BEFORE UPDATE ON public.golden_query_cases FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION public.touch_golden_query_updated_at();


--
-- Name: golden_query_expectations trg_golden_query_expectations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_golden_query_expectations_updated_at BEFORE UPDATE ON public.golden_query_expectations FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION public.touch_golden_query_updated_at();


--
-- Name: graph_mutations trg_graph_mutations_assign_space; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_graph_mutations_assign_space BEFORE INSERT OR UPDATE OF target_addr, space_id ON public.graph_mutations FOR EACH ROW EXECUTE FUNCTION public.verity_assign_graph_mutation_space();


--
-- Name: hosted_mirror_journal_entries trg_hosted_mirror_journal_entries_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_hosted_mirror_journal_entries_updated_at BEFORE UPDATE ON public.hosted_mirror_journal_entries FOR EACH ROW EXECUTE FUNCTION public.touch_tenant_day_journal_updated_at();


--
-- Name: nodes trg_log_node_mutation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_log_node_mutation AFTER INSERT OR UPDATE ON public.nodes FOR EACH ROW EXECUTE FUNCTION public.log_node_mutation();


--
-- Name: nodes trg_node_history; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_node_history AFTER UPDATE ON public.nodes FOR EACH ROW EXECUTE FUNCTION public.log_node_change();


--
-- Name: nodes trg_nodes_assign_space; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_nodes_assign_space BEFORE INSERT OR UPDATE OF pyramid_id, space_id ON public.nodes FOR EACH ROW EXECUTE FUNCTION public.verity_assign_node_space();


--
-- Name: edges trg_resonance_stale_edges; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_resonance_stale_edges AFTER INSERT OR DELETE OR UPDATE ON public.edges FOR EACH STATEMENT EXECUTE FUNCTION public.trigger_mark_resonance_stale();


--
-- Name: nodes trg_resonance_stale_nodes; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_resonance_stale_nodes AFTER INSERT OR DELETE OR UPDATE ON public.nodes FOR EACH STATEMENT EXECUTE FUNCTION public.trigger_mark_resonance_stale();


--
-- Name: staging_edges trg_staging_edges_assign_spaces; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_staging_edges_assign_spaces BEFORE INSERT OR UPDATE OF from_addr, to_addr, space_id, from_space_id, to_space_id ON public.staging_edges FOR EACH ROW EXECUTE FUNCTION public.verity_assign_edge_spaces();


--
-- Name: staging_edges trg_staging_edges_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_staging_edges_notify AFTER INSERT ON public.staging_edges FOR EACH ROW EXECUTE FUNCTION public.notify_staging_new();


--
-- Name: staging_nodes trg_staging_nodes_assign_space; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_staging_nodes_assign_space BEFORE INSERT OR UPDATE OF pyramid_id, addr, space_id ON public.staging_nodes FOR EACH ROW EXECUTE FUNCTION public.verity_assign_node_space();


--
-- Name: staging_nodes trg_staging_nodes_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_staging_nodes_notify AFTER INSERT ON public.staging_nodes FOR EACH ROW EXECUTE FUNCTION public.notify_staging_new();


--
-- Name: staging_updates trg_staging_updates_assign_space; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_staging_updates_assign_space BEFORE INSERT OR UPDATE OF addr, space_id ON public.staging_updates FOR EACH ROW EXECUTE FUNCTION public.verity_assign_update_space();


--
-- Name: staging_updates trg_staging_updates_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_staging_updates_notify AFTER INSERT ON public.staging_updates FOR EACH ROW EXECUTE FUNCTION public.notify_staging_new();


--
-- Name: stimuli trg_stimuli_assign_space; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_stimuli_assign_space BEFORE INSERT OR UPDATE OF node_addr, space_id ON public.stimuli FOR EACH ROW EXECUTE FUNCTION public.verity_assign_stimulus_space();


--
-- Name: tenant_day_journal_entries trg_tenant_day_journal_entries_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_tenant_day_journal_entries_updated_at BEFORE UPDATE ON public.tenant_day_journal_entries FOR EACH ROW EXECUTE FUNCTION public.touch_tenant_day_journal_updated_at();


--
-- Name: tenant_day_journal_routines trg_tenant_day_journal_routines_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_tenant_day_journal_routines_updated_at BEFORE UPDATE ON public.tenant_day_journal_routines FOR EACH ROW EXECUTE FUNCTION public.touch_tenant_day_journal_updated_at();


--
-- Name: nodes trg_update_search_vector; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_update_search_vector BEFORE INSERT OR UPDATE ON public.nodes FOR EACH ROW EXECUTE FUNCTION public.update_search_vector();


--
-- Name: account_link_codes account_link_codes_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_link_codes
    ADD CONSTRAINT account_link_codes_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: account_sessions account_sessions_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_sessions
    ADD CONSTRAINT account_sessions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: account_tenant_links account_tenant_links_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_tenant_links
    ADD CONSTRAINT account_tenant_links_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: account_tenant_links account_tenant_links_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_tenant_links
    ADD CONSTRAINT account_tenant_links_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.hosted_tenant_identities(tenant_id);


--
-- Name: account_ui_preferences account_ui_preferences_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_ui_preferences
    ADD CONSTRAINT account_ui_preferences_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: agent_queries agent_queries_agent_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_queries
    ADD CONSTRAINT agent_queries_agent_fkey FOREIGN KEY (tenant_id, agent_id) REFERENCES public.agent_profiles(tenant_id, agent_id) ON DELETE CASCADE;


--
-- Name: agent_watches agent_watches_agent_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_watches
    ADD CONSTRAINT agent_watches_agent_fkey FOREIGN KEY (tenant_id, agent_id) REFERENCES public.agent_profiles(tenant_id, agent_id) ON DELETE CASCADE;


--
-- Name: change_stream change_stream_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.change_stream
    ADD CONSTRAINT change_stream_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: collapse_events collapse_events_node_addr_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collapse_events
    ADD CONSTRAINT collapse_events_node_addr_fkey FOREIGN KEY (node_addr) REFERENCES public.nodes(addr);


--
-- Name: distill_clusters distill_clusters_work_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.distill_clusters
    ADD CONSTRAINT distill_clusters_work_item_id_fkey FOREIGN KEY (work_item_id) REFERENCES public.distill_work_items(id) ON DELETE CASCADE;


--
-- Name: distill_proposals distill_proposals_cluster_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.distill_proposals
    ADD CONSTRAINT distill_proposals_cluster_id_fkey FOREIGN KEY (cluster_id) REFERENCES public.distill_clusters(id) ON DELETE CASCADE;


--
-- Name: distill_proposals distill_proposals_work_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.distill_proposals
    ADD CONSTRAINT distill_proposals_work_item_id_fkey FOREIGN KEY (work_item_id) REFERENCES public.distill_work_items(id) ON DELETE CASCADE;


--
-- Name: edge_usefulness_scores edge_usefulness_scores_edge_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edge_usefulness_scores
    ADD CONSTRAINT edge_usefulness_scores_edge_id_fkey FOREIGN KEY (edge_id) REFERENCES public.edges(id) ON DELETE CASCADE;


--
-- Name: edges edges_from_addr_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edges
    ADD CONSTRAINT edges_from_addr_fkey FOREIGN KEY (from_addr) REFERENCES public.nodes(addr) ON DELETE CASCADE;


--
-- Name: edges edges_from_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edges
    ADD CONSTRAINT edges_from_space_id_fkey FOREIGN KEY (from_space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: edges edges_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edges
    ADD CONSTRAINT edges_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: edges edges_to_addr_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edges
    ADD CONSTRAINT edges_to_addr_fkey FOREIGN KEY (to_addr) REFERENCES public.nodes(addr) ON DELETE CASCADE;


--
-- Name: edges edges_to_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edges
    ADD CONSTRAINT edges_to_space_id_fkey FOREIGN KEY (to_space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: federation_nodes federation_nodes_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federation_nodes
    ADD CONSTRAINT federation_nodes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(tenant_id) ON DELETE CASCADE;


--
-- Name: federation_overlay_log federation_overlay_log_tenant_id_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federation_overlay_log
    ADD CONSTRAINT federation_overlay_log_tenant_id_node_id_fkey FOREIGN KEY (tenant_id, node_id) REFERENCES public.federation_nodes(tenant_id, node_id) ON DELETE CASCADE;


--
-- Name: file_index file_index_node_addr_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_index
    ADD CONSTRAINT file_index_node_addr_fkey FOREIGN KEY (node_addr) REFERENCES public.nodes(addr) ON DELETE CASCADE DEFERRABLE;


--
-- Name: golden_query_cases golden_query_cases_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.golden_query_cases
    ADD CONSTRAINT golden_query_cases_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id) ON DELETE RESTRICT;


--
-- Name: golden_query_cases golden_query_cases_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.golden_query_cases
    ADD CONSTRAINT golden_query_cases_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(tenant_id) ON DELETE RESTRICT;


--
-- Name: golden_query_expectations golden_query_expectations_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.golden_query_expectations
    ADD CONSTRAINT golden_query_expectations_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.golden_query_cases(id) ON DELETE CASCADE;


--
-- Name: golden_query_runs golden_query_runs_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.golden_query_runs
    ADD CONSTRAINT golden_query_runs_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.golden_query_cases(id) ON DELETE CASCADE;


--
-- Name: golden_query_runs golden_query_runs_supercron_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.golden_query_runs
    ADD CONSTRAINT golden_query_runs_supercron_run_id_fkey FOREIGN KEY (supercron_run_id) REFERENCES public.supercron_runs(id) ON DELETE CASCADE;


--
-- Name: graph_mutations graph_mutations_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_mutations
    ADD CONSTRAINT graph_mutations_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: graph_spaces graph_spaces_overlay_parent_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_spaces
    ADD CONSTRAINT graph_spaces_overlay_parent_space_id_fkey FOREIGN KEY (overlay_parent_space_id) REFERENCES public.graph_spaces(space_id) ON DELETE SET NULL;


--
-- Name: graph_spaces graph_spaces_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_spaces
    ADD CONSTRAINT graph_spaces_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(tenant_id) ON DELETE CASCADE;


--
-- Name: grounding_gap_claims grounding_gap_claims_gap_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grounding_gap_claims
    ADD CONSTRAINT grounding_gap_claims_gap_key_fkey FOREIGN KEY (gap_key) REFERENCES public.grounding_gap_profiles(gap_key) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: grounding_gap_claims grounding_gap_claims_publication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grounding_gap_claims
    ADD CONSTRAINT grounding_gap_claims_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.node_publications(id) ON DELETE SET NULL;


--
-- Name: grounding_gap_events grounding_gap_events_gap_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grounding_gap_events
    ADD CONSTRAINT grounding_gap_events_gap_key_fkey FOREIGN KEY (gap_key) REFERENCES public.grounding_gap_profiles(gap_key) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: hosted_admin_tenant_overrides hosted_admin_tenant_overrides_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_admin_tenant_overrides
    ADD CONSTRAINT hosted_admin_tenant_overrides_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.hosted_tenant_identities(tenant_id) ON DELETE CASCADE;


--
-- Name: hosted_agent_credentials hosted_agent_credentials_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_agent_credentials
    ADD CONSTRAINT hosted_agent_credentials_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: hosted_connect_grants hosted_connect_grants_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_connect_grants
    ADD CONSTRAINT hosted_connect_grants_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: hosted_drive_connect_grants hosted_drive_connect_grants_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_drive_connect_grants
    ADD CONSTRAINT hosted_drive_connect_grants_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: hosted_nodes hosted_nodes_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_nodes
    ADD CONSTRAINT hosted_nodes_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: hosted_tenant_identities hosted_tenant_identities_created_by_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosted_tenant_identities
    ADD CONSTRAINT hosted_tenant_identities_created_by_account_id_fkey FOREIGN KEY (created_by_account_id) REFERENCES public.accounts(account_id) ON DELETE SET NULL;


--
-- Name: intake_queue intake_queue_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intake_queue
    ADD CONSTRAINT intake_queue_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: memory_registry memory_registry_addr_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_registry
    ADD CONSTRAINT memory_registry_addr_fkey FOREIGN KEY (addr) REFERENCES public.nodes(addr) ON DELETE CASCADE;


--
-- Name: memory_registry memory_registry_superseded_by_addr_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_registry
    ADD CONSTRAINT memory_registry_superseded_by_addr_fkey FOREIGN KEY (superseded_by_addr) REFERENCES public.nodes(addr) ON DELETE SET NULL;


--
-- Name: memory_registry memory_registry_supersedes_addr_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_registry
    ADD CONSTRAINT memory_registry_supersedes_addr_fkey FOREIGN KEY (supersedes_addr) REFERENCES public.nodes(addr) ON DELETE SET NULL;


--
-- Name: mining_runs mining_runs_pyramid_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mining_runs
    ADD CONSTRAINT mining_runs_pyramid_id_fkey FOREIGN KEY (pyramid_id) REFERENCES public.registry(pyramid_id);


--
-- Name: node_publications node_publications_source_addr_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_publications
    ADD CONSTRAINT node_publications_source_addr_fkey FOREIGN KEY (source_addr) REFERENCES public.nodes(addr) ON DELETE CASCADE;


--
-- Name: node_publications node_publications_source_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_publications
    ADD CONSTRAINT node_publications_source_space_id_fkey FOREIGN KEY (source_space_id) REFERENCES public.graph_spaces(space_id) ON DELETE CASCADE;


--
-- Name: node_publications node_publications_target_addr_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_publications
    ADD CONSTRAINT node_publications_target_addr_fkey FOREIGN KEY (target_addr) REFERENCES public.nodes(addr) ON DELETE SET NULL;


--
-- Name: node_publications node_publications_target_pyramid_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_publications
    ADD CONSTRAINT node_publications_target_pyramid_id_fkey FOREIGN KEY (target_pyramid_id) REFERENCES public.registry(pyramid_id) ON DELETE RESTRICT;


--
-- Name: node_publications node_publications_target_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_publications
    ADD CONSTRAINT node_publications_target_space_id_fkey FOREIGN KEY (target_space_id) REFERENCES public.graph_spaces(space_id) ON DELETE CASCADE;


--
-- Name: nodes nodes_parent_addr_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodes
    ADD CONSTRAINT nodes_parent_addr_fkey FOREIGN KEY (parent_addr) REFERENCES public.nodes(addr) ON DELETE SET NULL;


--
-- Name: nodes nodes_pyramid_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodes
    ADD CONSTRAINT nodes_pyramid_id_fkey FOREIGN KEY (pyramid_id) REFERENCES public.registry(pyramid_id) ON DELETE CASCADE;


--
-- Name: nodes nodes_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodes
    ADD CONSTRAINT nodes_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: oauth_authorization_requests oauth_authorization_requests_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_authorization_requests
    ADD CONSTRAINT oauth_authorization_requests_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: oauth_authorization_requests oauth_authorization_requests_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_authorization_requests
    ADD CONSTRAINT oauth_authorization_requests_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.oauth_clients(client_id) ON DELETE CASCADE;


--
-- Name: oauth_grants oauth_grants_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_grants
    ADD CONSTRAINT oauth_grants_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: oauth_grants oauth_grants_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_grants
    ADD CONSTRAINT oauth_grants_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.oauth_clients(client_id) ON DELETE CASCADE;


--
-- Name: oauth_grants oauth_grants_hosted_agent_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_grants
    ADD CONSTRAINT oauth_grants_hosted_agent_credential_id_fkey FOREIGN KEY (hosted_agent_credential_id) REFERENCES public.hosted_agent_credentials(credential_id) ON DELETE CASCADE;


--
-- Name: oauth_grants oauth_grants_parent_grant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_grants
    ADD CONSTRAINT oauth_grants_parent_grant_id_fkey FOREIGN KEY (parent_grant_id) REFERENCES public.oauth_grants(id) ON DELETE SET NULL;


--
-- Name: proposal_embeddings proposal_embeddings_proposal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposal_embeddings
    ADD CONSTRAINT proposal_embeddings_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES public.proposals(id) ON DELETE CASCADE;


--
-- Name: public_contribution_events public_contribution_events_publication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_contribution_events
    ADD CONSTRAINT public_contribution_events_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES public.node_publications(id) ON DELETE CASCADE;


--
-- Name: source_history source_history_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_history
    ADD CONSTRAINT source_history_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: space_pyramids space_pyramids_pyramid_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.space_pyramids
    ADD CONSTRAINT space_pyramids_pyramid_id_fkey FOREIGN KEY (pyramid_id) REFERENCES public.registry(pyramid_id) ON DELETE CASCADE;


--
-- Name: space_pyramids space_pyramids_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.space_pyramids
    ADD CONSTRAINT space_pyramids_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id) ON DELETE CASCADE;


--
-- Name: staging_edges staging_edges_from_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staging_edges
    ADD CONSTRAINT staging_edges_from_space_id_fkey FOREIGN KEY (from_space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: staging_edges staging_edges_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staging_edges
    ADD CONSTRAINT staging_edges_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: staging_edges staging_edges_to_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staging_edges
    ADD CONSTRAINT staging_edges_to_space_id_fkey FOREIGN KEY (to_space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: staging_nodes staging_nodes_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staging_nodes
    ADD CONSTRAINT staging_nodes_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: staging_updates staging_updates_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staging_updates
    ADD CONSTRAINT staging_updates_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: stimuli stimuli_parent_stimulus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stimuli
    ADD CONSTRAINT stimuli_parent_stimulus_id_fkey FOREIGN KEY (parent_stimulus_id) REFERENCES public.stimuli(id) ON DELETE CASCADE;


--
-- Name: stimuli stimuli_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stimuli
    ADD CONSTRAINT stimuli_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: stimulus_conflicts stimulus_conflicts_stimulus_a_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stimulus_conflicts
    ADD CONSTRAINT stimulus_conflicts_stimulus_a_fkey FOREIGN KEY (stimulus_a) REFERENCES public.stimuli(id) ON DELETE CASCADE;


--
-- Name: stimulus_conflicts stimulus_conflicts_stimulus_b_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stimulus_conflicts
    ADD CONSTRAINT stimulus_conflicts_stimulus_b_fkey FOREIGN KEY (stimulus_b) REFERENCES public.stimuli(id) ON DELETE CASCADE;


--
-- Name: stimulus_contributions stimulus_contributions_stimulus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stimulus_contributions
    ADD CONSTRAINT stimulus_contributions_stimulus_id_fkey FOREIGN KEY (stimulus_id) REFERENCES public.stimuli(id) ON DELETE CASCADE;


--
-- Name: subscription_entitlements subscription_entitlements_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_entitlements
    ADD CONSTRAINT subscription_entitlements_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(account_id) ON DELETE CASCADE;


--
-- Name: supercron_manual_runs supercron_manual_runs_supercron_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supercron_manual_runs
    ADD CONSTRAINT supercron_manual_runs_supercron_run_id_fkey FOREIGN KEY (supercron_run_id) REFERENCES public.supercron_runs(id) ON DELETE SET NULL;


--
-- Name: supercron_manual_runs supercron_manual_runs_tenant_space_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supercron_manual_runs
    ADD CONSTRAINT supercron_manual_runs_tenant_space_fk FOREIGN KEY (tenant_space_id) REFERENCES public.graph_spaces(space_id) ON DELETE CASCADE;


--
-- Name: supercron_node_gc_receipts supercron_node_gc_receipts_tenant_space_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supercron_node_gc_receipts
    ADD CONSTRAINT supercron_node_gc_receipts_tenant_space_fk FOREIGN KEY (tenant_space_id) REFERENCES public.graph_spaces(space_id) ON DELETE CASCADE;


--
-- Name: supercron_pass_telemetry supercron_pass_telemetry_supercron_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supercron_pass_telemetry
    ADD CONSTRAINT supercron_pass_telemetry_supercron_run_id_fkey FOREIGN KEY (supercron_run_id) REFERENCES public.supercron_runs(id) ON DELETE CASCADE;


--
-- Name: supercron_tenant_budget_state supercron_tenant_budget_state_tenant_space_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supercron_tenant_budget_state
    ADD CONSTRAINT supercron_tenant_budget_state_tenant_space_fk FOREIGN KEY (tenant_space_id) REFERENCES public.graph_spaces(space_id) ON DELETE CASCADE;


--
-- Name: supersession_candidates supersession_candidates_newer_stimulus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supersession_candidates
    ADD CONSTRAINT supersession_candidates_newer_stimulus_id_fkey FOREIGN KEY (newer_stimulus_id) REFERENCES public.stimuli(id) ON DELETE CASCADE;


--
-- Name: supersession_candidates supersession_candidates_older_stimulus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supersession_candidates
    ADD CONSTRAINT supersession_candidates_older_stimulus_id_fkey FOREIGN KEY (older_stimulus_id) REFERENCES public.stimuli(id) ON DELETE CASCADE;


--
-- Name: tenant_day_journal_entries tenant_day_journal_entries_latest_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_day_journal_entries
    ADD CONSTRAINT tenant_day_journal_entries_latest_run_id_fkey FOREIGN KEY (latest_run_id) REFERENCES public.tenant_day_journal_routine_runs(id) ON DELETE SET NULL;


--
-- Name: tenant_sync_preferences tenant_sync_preferences_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_sync_preferences
    ADD CONSTRAINT tenant_sync_preferences_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.hosted_tenant_identities(tenant_id) ON DELETE CASCADE;


--
-- Name: tenant_sync_preferences tenant_sync_preferences_updated_by_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_sync_preferences
    ADD CONSTRAINT tenant_sync_preferences_updated_by_account_id_fkey FOREIGN KEY (updated_by_account_id) REFERENCES public.accounts(account_id) ON DELETE SET NULL;


--
-- Name: trend_archive trend_archive_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_archive
    ADD CONSTRAINT trend_archive_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: trend_centroids trend_centroids_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_centroids
    ADD CONSTRAINT trend_centroids_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: trend_decision_audits trend_decision_audits_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_decision_audits
    ADD CONSTRAINT trend_decision_audits_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: trend_events trend_events_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_events
    ADD CONSTRAINT trend_events_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: trend_policy_overrides trend_policy_overrides_source_audit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_policy_overrides
    ADD CONSTRAINT trend_policy_overrides_source_audit_id_fkey FOREIGN KEY (source_audit_id) REFERENCES public.trend_decision_audits(id) ON DELETE SET NULL;


--
-- Name: trend_policy_overrides trend_policy_overrides_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trend_policy_overrides
    ADD CONSTRAINT trend_policy_overrides_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: vi_schedule_runs vi_schedule_runs_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vi_schedule_runs
    ADD CONSTRAINT vi_schedule_runs_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES public.vi_schedules(id) ON DELETE CASCADE;


--
-- Name: wi_proto_clusters wi_proto_clusters_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_proto_clusters
    ADD CONSTRAINT wi_proto_clusters_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: wi_queue wi_queue_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_queue
    ADD CONSTRAINT wi_queue_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: wi_rejected_patterns wi_rejected_patterns_original_proposal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_rejected_patterns
    ADD CONSTRAINT wi_rejected_patterns_original_proposal_id_fkey FOREIGN KEY (original_proposal_id) REFERENCES public.wi_skill_proposals(id);


--
-- Name: wi_runs wi_runs_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_runs
    ADD CONSTRAINT wi_runs_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id);


--
-- Name: wi_skill_usage wi_skill_usage_skill_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_skill_usage
    ADD CONSTRAINT wi_skill_usage_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES public.wi_skill_proposals(id);


--
-- Name: wi_source_links wi_source_links_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wi_source_links
    ADD CONSTRAINT wi_source_links_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.graph_spaces(space_id);


--
-- PostgreSQL database dump complete
--

\unrestrict CMn4gKY5NZQJJfWckgMkbYz1O83tRAuBTazGP0CGLeO57zK6n7m7N2fDmWIHHfz

