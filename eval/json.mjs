import { format } from "prettier";

/** Keep generated, reviewable artifacts stable with the repository formatter. */
export function formatEvalJson(value) {
  return format(JSON.stringify(value), {
    parser: "json",
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    endOfLine: "lf",
    trailingComma: "all",
  });
}
