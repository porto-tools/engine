// Minimal ambient type declaration for papaparse@5.
// @types/papaparse is not in package.json; this covers exactly the API surface
// used by csv-json.ts. A fuller type can be added later if more methods are needed.
declare module "papaparse" {
  interface ParseResult<T> {
    data: T[];
    errors: Array<{ message: string; row?: number }>;
    meta: { fields?: string[] };
  }

  interface ParseConfig {
    header?: boolean;
    dynamicTyping?: boolean;
    skipEmptyLines?: boolean | "greedy";
  }

  interface UnparseConfig {
    header?: boolean;
  }

  function parse<T = Record<string, string>>(input: string, config?: ParseConfig): ParseResult<T>;
  function unparse(data: Record<string, unknown>[], config?: UnparseConfig): string;

  export { parse, unparse };
  export { parse as default };
}
