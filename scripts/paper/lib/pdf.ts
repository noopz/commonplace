/**
 * PDF text extraction using pdfjs-dist (Mozilla pdf.js).
 * Lower-level than pdf-parse wrapper, better handling of column layouts.
 * Known limitations: scanned PDFs and heavy math notation may produce garbled text.
 */

import { readFileSync } from "fs";

// Dynamic import for pdfjs-dist (ESM compatibility)
let pdfjsLib: typeof import("pdfjs-dist") | null = null;

async function getPdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import("pdfjs-dist");
  }
  return pdfjsLib;
}

export interface PdfInfo {
  totalPages: number;
  metadata: Record<string, string>;
}

export interface PageText {
  pageNumber: number;
  text: string;
}

export async function getPdfInfo(pdfPath: string): Promise<PdfInfo> {
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;

  const metadata = await doc.getMetadata();
  const info: Record<string, string> = {};
  if (metadata.info) {
    const m = metadata.info as Record<string, unknown>;
    if (m.Title) info.title = String(m.Title);
    if (m.Author) info.author = String(m.Author);
    if (m.Subject) info.subject = String(m.Subject);
    if (m.Creator) info.creator = String(m.Creator);
  }

  const result = { totalPages: doc.numPages, metadata: info };
  await doc.destroy();
  return result;
}

export async function extractPages(
  pdfPath: string,
  startPage: number,
  endPage: number
): Promise<PageText[]> {
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;

  const pages: PageText[] = [];
  const actualEnd = Math.min(endPage, doc.numPages);

  for (let i = startPage; i <= actualEnd; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();

    // Sort items by position (top-to-bottom, left-to-right) for better column handling
    const items = textContent.items
      .filter((item): item is { str: string; transform: number[] } => "str" in item)
      .sort((a, b) => {
        const yDiff = b.transform[5] - a.transform[5]; // Y descending (PDF coords)
        if (Math.abs(yDiff) > 5) return yDiff;
        return a.transform[4] - b.transform[4]; // X ascending
      });

    let text = "";
    let lastY = -1;
    for (const item of items) {
      const y = Math.round(item.transform[5]);
      if (lastY !== -1 && Math.abs(y - lastY) > 5) {
        text += "\n";
      } else if (lastY !== -1 && text.length > 0 && !text.endsWith(" ")) {
        text += " ";
      }
      text += item.str;
      lastY = y;
    }

    pages.push({ pageNumber: i, text: text.trim() });
  }

  await doc.destroy();
  return pages;
}

export async function extractAllText(pdfPath: string): Promise<string> {
  const info = await getPdfInfo(pdfPath);
  const pages = await extractPages(pdfPath, 1, info.totalPages);
  return pages
    .map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`)
    .join("\n\n");
}

/**
 * Estimate token count for text (rough: ~1 token per 4 chars).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
