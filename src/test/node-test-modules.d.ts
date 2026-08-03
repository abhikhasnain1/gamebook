interface TestNodeBuffer {
  toString(encoding?: string): string;
}

declare module "node:fs" {
  export function readFileSync(path: string | URL): TestNodeBuffer;
}

declare module "node:zlib" {
  export function gunzipSync(data: TestNodeBuffer): TestNodeBuffer;
}
