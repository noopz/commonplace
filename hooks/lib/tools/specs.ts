/**
 * The model-facing vault tools (plan §5). Names all contain `vault`;
 * descriptions lead with the words a ToolSearch query would use, because
 * every tool but vault_search and vault_note is deferred behind ToolSearch.
 * Every tool takes `vault?` (id, alias or path); output is always a string;
 * no numeric scores ever reach the model (B15).
 *
 * Sandbox-safe.
 */

const VAULT_ARG = {
  type: "string",
  description: "Vault id, alias or path. Omit for the active vault.",
} as const;

export const VAULT_SEARCH_SPEC = {
  name: "vault_search",
  description:
    "Search the user's vault / notes / knowledge base (Obsidian wiki) for pointers: titles, paths, " +
    "abstractions. Pointers only, never bodies — a lexical match is not relevance; read with vault_note, " +
    "follow links with vault_links. Use whenever the user's own notes may cover the topic.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for, in the user's own words and distinctive terms." },
      limit: { type: "number", description: "Maximum pointers (default 8, max 25)." },
      domain: { type: "string", description: "Restrict to one domain id (see vault_list domains)." },
      vault: VAULT_ARG,
    },
    required: ["query"],
  },
} as const;

export const VAULT_NOTE_SPEC = {
  name: "vault_note",
  description:
    "Read one note from the user's vault / knowledge base by path or title, with its outgoing and incoming " +
    "links. The reading step that turns a search hit into a relevance judgement.",
  inputSchema: {
    type: "object",
    properties: {
      note: { type: "string", description: "The note's path (preferred) or exact title / alias." },
      maxChars: { type: "number", description: "Truncate the body after this many characters (default 40000)." },
      vault: VAULT_ARG,
    },
    required: ["note"],
  },
} as const;

export const VAULT_LINKS_SPEC = {
  name: "vault_links",
  description:
    "Follow wikilinks: list a note's outgoing and incoming links (backlinks) in the user's vault graph, with " +
    "edge kind (body, concept, MOC, buildsOn, comparesWith, usesMethod, supersedes) and the sentence around each link.",
  inputSchema: {
    type: "object",
    properties: {
      note: { type: "string", description: "Path or title of the note whose links to list." },
      direction: { type: "string", enum: ["out", "in", "both"], description: "Default both." },
      kinds: {
        type: "array",
        items: { type: "string", enum: ["body", "concept", "moc", "buildsOn", "comparesWith", "usesMethod", "supersedes"] },
        description: "Only these edge kinds.",
      },
      limit: { type: "number", description: "Maximum links (default 20, max 100)." },
      vault: VAULT_ARG,
    },
    required: ["note"],
  },
} as const;

export const VAULT_PATH_SPEC = {
  name: "vault_path",
  description:
    "Find how two notes connect in the vault link graph: the shortest path between notes/concepts, " +
    "hub-penalised, each hop explained. For 'how does X relate to Y'.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Path or title of the first note." },
      to: { type: "string", description: "Path or title of the second note." },
      maxHops: { type: "number", description: "Default 4, max 6." },
      avoidHubs: { type: "boolean", description: "Penalise routes through hub notes (default true)." },
      vault: VAULT_ARG,
    },
    required: ["from", "to"],
  },
} as const;

export const VAULT_NEIGHBOURHOOD_SPEC = {
  name: "vault_neighbourhood",
  description:
    "Graph neighbourhood of notes in the user's vault: a ranked pool of related notes via personalized " +
    "PageRank over wikilinks, with the edge each was reached through. Reaches notes that share no words with the query.",
  inputSchema: {
    type: "object",
    properties: {
      seeds: { type: "array", items: { type: "string" }, description: "1-5 note paths or titles to start from." },
      k: { type: "number", description: "Pool size (default 12, max 30)." },
      vault: VAULT_ARG,
    },
    required: ["seeds"],
  },
} as const;

export const VAULT_LIST_SPEC = {
  name: "vault_list",
  description:
    "List the vault's domains, maps of content (MOCs), recently changed notes, stub concepts, or registered vaults " +
    "in the user's notes / knowledge base.",
  inputSchema: {
    type: "object",
    properties: {
      what: { type: "string", enum: ["domains", "mocs", "recent", "stubs", "vaults"] },
      limit: { type: "number", description: "Maximum rows (default 50)." },
      vault: VAULT_ARG,
    },
    required: ["what"],
  },
} as const;

export const VAULT_SKILL_SPEC = {
  name: "vault_skill",
  description:
    "Vault-defined skills: list the skills the user's vault / knowledge base ships, or load one by name to follow it.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name; omit to list." },
      vault: VAULT_ARG,
    },
  },
} as const;

export const TOOL_SPECS = [
  VAULT_SEARCH_SPEC,
  VAULT_NOTE_SPEC,
  VAULT_LINKS_SPEC,
  VAULT_PATH_SPEC,
  VAULT_NEIGHBOURHOOD_SPEC,
  VAULT_LIST_SPEC,
  VAULT_SKILL_SPEC,
] as const;

/** Tools listed in every prompt; the rest are found through ToolSearch. */
export const PINNED_TOOLS = new Set(["vault_search", "vault_note"]);
