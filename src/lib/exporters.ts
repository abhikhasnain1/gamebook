import type { GamebookSession } from "../types/session";

export async function pageImagesToPdf(images: string[]): Promise<string> {
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  for (const imageDataUrl of images) {
    const bytes = dataUrlToBytes(imageDataUrl);
    const image = await pdf.embedPng(bytes);
    const page = pdf.addPage([1600, 900]);
    page.drawImage(image, { x: 0, y: 0, width: 1600, height: 900 });
  }
  return bytesToDataUrl(await pdf.save(), "application/pdf");
}

export function sessionToText(session: GamebookSession): string {
  const lines = [session.title, "=".repeat(session.title.length), ""];
  session.pages.forEach((page, index) => {
    lines.push(`${index + 1}. ${page.title}`, "-".repeat(page.title.length + 3));
    lines.push(page.extractedText.trim() || "(No text notes)", "");
  });
  return lines.join("\n");
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
