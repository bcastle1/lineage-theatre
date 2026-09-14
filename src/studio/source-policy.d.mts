export function textFeedback(text: string, label?: string): string;
export function mediaFeedback(type: string): string;
export function readPdfText(document: {
  numPages: number;
  getPage(number: number): Promise<{
    getTextContent(): Promise<{
      items: ({ str?: string; hasEOL?: boolean } | { type: string })[];
    }>;
    cleanup(): unknown;
  }>;
}): Promise<{ text: string; extraction: string }>;
