# TODO

## Finish reading through the entity graph

The memory is a graph: entities are nodes and each fact is an edge between two of them. It is stored
that way, but reading does not use it.

- **Graph traversal in `recall`.** `factsByTraversal` (breadth-first search with a recursive CTE) is
  implemented and tested, but `recall` only fuses text and vector. The third method still has to run
  and enter the RRF fusion.
- **Traversal seeds.** Knowing which entities the query names: `entitiesByText` exists and nothing
  calls it.
- **Returning entities.** `recall` returns none.

## Approximate nearest neighbor (ANN) index for the vectors

Vector search has no index: it computes the distance against every vector of the tenant (and of the
agent, with that model) and sorts. It grows linearly with the number of rows. It needs a pgvector
index (HNSW or IVFFlat) on `facts.fact_embedding`, `agent_notes.embedding` and
`document_index.embedding`, which returns the nearest ones without comparing them all.

## Optional

- **Complete the entities.** `summary` (what is known about the entity, condensed from its facts and
  rewritten when new facts come in), `attributes` (structured properties) and `name_embedding`
  (a vector of the name, to find entities by meaning). The columns exist and are never written.
- **Compaction by time span.** The `summaries` table summarizes a range of episodes, so old material
  takes less space without being lost. It is created and empty.
- **Removals from the document index.** `forgetDocuments` exists; the client has to call it when a
  document stops existing, otherwise it stays indexed.
