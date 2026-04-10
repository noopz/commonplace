#!/usr/bin/env tsx
/**
 * Fetch metadata from external sources (arXiv, Semantic Scholar, GitHub).
 * Usage: npx tsx scripts/paper/enrich-metadata.ts --arxiv-id <id> [--title <title>] [--no-github]
 */

import { parseArgs } from "util";
import type { EnrichmentResult } from "./lib/types.js";

const { values } = parseArgs({
  options: {
    "arxiv-id": { type: "string" },
    title: { type: "string" },
    "no-github": { type: "boolean", default: false },
    "no-semantic-scholar": { type: "boolean", default: false },
    format: { type: "string", default: "json" },
  },
});

const result: EnrichmentResult = {
  sourcesChecked: [],
  metadata: {},
};

// arXiv
if (values["arxiv-id"]) {
  result.sourcesChecked.push("arxiv");
  try {
    const res = await fetch(
      `http://export.arxiv.org/api/query?id_list=${values["arxiv-id"]}`
    );
    const xml = await res.text();

    // Simple XML parsing for arXiv API — scope to <entry> element
    const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
    const entryXml = entryMatch ? entryMatch[1] : xml;

    const getTag = (tag: string, source: string = entryXml) => {
      const m = source.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].trim() : "";
    };
    const getAllTags = (tag: string, source: string = entryXml) => {
      const matches: string[] = [];
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
      let m;
      while ((m = re.exec(source)) !== null) matches.push(m[1].trim());
      return matches;
    };

    const title = getTag("title");
    const abstract = getTag("summary");
    const published = getTag("published");
    const updated = getTag("updated");
    const authors = getAllTags("name");
    const categories = getAllTags("category")
      .map((c) => {
        const m = c.match(/term="([^"]+)"/);
        return m ? m[1] : c;
      })
      .filter(Boolean);

    if (title) {
      result.metadata.arxiv = {
        title,
        authors,
        abstract,
        published,
        updated,
        categories,
      };
    }
  } catch (err) {
    console.error("arXiv fetch failed:", err);
  }
}

// Semantic Scholar
const searchTitle = values.title || result.metadata.arxiv?.title;
if (searchTitle && !values["no-semantic-scholar"]) {
  result.sourcesChecked.push("semantic_scholar");
  try {
    const searchRes = await fetch(
      `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(searchTitle)}&limit=1`
    );
    const searchData = (await searchRes.json()) as { data?: { paperId: string }[] };

    if (searchData.data?.[0]?.paperId) {
      const paperId = searchData.data[0].paperId;
      const detailRes = await fetch(
        `https://api.semanticscholar.org/graph/v1/paper/${paperId}?fields=title,authors,year,citationCount,influentialCitationCount,abstract,venue`
      );
      const detail = (await detailRes.json()) as Record<string, unknown>;

      result.metadata.semanticScholar = {
        title: String(detail.title || ""),
        authors: Array.isArray(detail.authors)
          ? (detail.authors as { name: string }[]).map((a) => a.name)
          : [],
        year: Number(detail.year) || 0,
        citationCount: Number(detail.citationCount) || 0,
        influentialCitationCount: Number(detail.influentialCitationCount) || 0,
        abstract: String(detail.abstract || ""),
        venue: String(detail.venue || ""),
      };
    }
  } catch (err) {
    console.error("Semantic Scholar fetch failed:", err);
  }
}

// GitHub
if (!values["no-github"] && (values["arxiv-id"] || searchTitle)) {
  result.sourcesChecked.push("github");
  try {
    const query = values["arxiv-id"] || searchTitle;
    const ghRes = await fetch(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(query!)}&sort=stars&per_page=5`,
      { headers: { "User-Agent": "commonplace-paper-analyzer/1.0" } }
    );
    const ghData = (await ghRes.json()) as {
      items?: { name: string; html_url: string; stargazers_count: number; language: string; description: string }[];
    };

    if (ghData.items?.length) {
      result.metadata.github = ghData.items.map((r) => ({
        name: r.name,
        url: r.html_url,
        stars: r.stargazers_count,
        language: r.language || "",
        description: r.description || "",
      }));
    }
  } catch (err) {
    console.error("GitHub fetch failed:", err);
  }
}

console.log(JSON.stringify(result));
