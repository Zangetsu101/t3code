import type { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { SourceControlMediaUploadError } from "./driver.ts";

export interface MarkdownAttachmentInput {
  readonly path: string;
  readonly alt?: string | undefined;
}

export interface ValidatedMediaAttachment {
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly kind: "image" | "video";
  readonly alt: string;
}

export interface UploadedMediaAttachment extends ValidatedMediaAttachment {
  readonly url: string;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

const MEDIA_CONTENT_TYPES: Readonly<
  Record<string, { readonly contentType: string; readonly kind: "image" | "video" }>
> = {
  ".png": { contentType: "image/png", kind: "image" },
  ".jpg": { contentType: "image/jpeg", kind: "image" },
  ".jpeg": { contentType: "image/jpeg", kind: "image" },
  ".gif": { contentType: "image/gif", kind: "image" },
  ".webp": { contentType: "image/webp", kind: "image" },
  ".svg": { contentType: "image/svg+xml", kind: "image" },
  ".mp4": { contentType: "video/mp4", kind: "video" },
  ".mov": { contentType: "video/quicktime", kind: "video" },
  ".webm": { contentType: "video/webm", kind: "video" },
};

const REMOTE_OR_FRAGMENT_DESTINATION = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

function defaultAltText(fileName: string, ext: string): string {
  const stem = ext.length > 0 ? fileName.slice(0, -ext.length) : fileName;
  return stem.replaceAll(".", " ") || fileName;
}

function escapeMarkdownAlt(alt: string): string {
  return alt.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

/**
 * Validates every local attachment before any network upload begins so invalid paths,
 * unsupported extensions, empty files, or oversized files fail fast without stranding assets.
 */
export const validateMediaAttachments = Effect.fn("markdownAttachments.validate")(
  function* (input: {
    readonly provider: SourceControlProviderKind;
    readonly cwd: string;
    readonly attachments: ReadonlyArray<MarkdownAttachmentInput>;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const seen = new Set<string>();
    const validated: Array<ValidatedMediaAttachment> = [];

    for (const attachment of input.attachments) {
      const resolvedPath = path.resolve(input.cwd, attachment.path);
      if (seen.has(resolvedPath)) continue;
      seen.add(resolvedPath);

      const fileName = path.basename(resolvedPath);
      const ext = path.extname(resolvedPath).toLowerCase();
      const media = MEDIA_CONTENT_TYPES[ext];
      if (media === undefined) {
        return yield* new SourceControlMediaUploadError({
          provider: input.provider,
          reason: "invalid",
          code: "unsupported-type",
          fileName,
        });
      }

      const info = yield* fileSystem.stat(resolvedPath).pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlMediaUploadError({
              provider: input.provider,
              reason: "invalid",
              code: "file-unreadable",
              fileName,
              cause,
            }),
        ),
      );

      if (info.type === "Directory") {
        return yield* new SourceControlMediaUploadError({
          provider: input.provider,
          reason: "invalid",
          code: "file-directory",
          fileName,
        });
      }
      if (info.type !== "File") {
        return yield* new SourceControlMediaUploadError({
          provider: input.provider,
          reason: "invalid",
          code: "file-not-regular",
          fileName,
        });
      }

      const sizeBytes = Number(info.size);
      if (sizeBytes <= 0) {
        return yield* new SourceControlMediaUploadError({
          provider: input.provider,
          reason: "invalid",
          code: "file-empty",
          fileName,
        });
      }

      const maxBytes = media.kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      if (sizeBytes > maxBytes) {
        return yield* new SourceControlMediaUploadError({
          provider: input.provider,
          reason: "invalid",
          code: "file-too-large",
          fileName,
        });
      }

      const alt =
        attachment.alt?.trim() ||
        (media.kind === "image" ? defaultAltText(fileName, ext) : fileName);
      validated.push({
        inputPath: attachment.path,
        resolvedPath,
        fileName,
        contentType: media.contentType,
        sizeBytes,
        kind: media.kind,
        alt,
      });
    }

    return validated;
  },
);

function decodeDestinationPath(raw: string): string {
  const trimmed = raw.trim();
  const unwrapped =
    trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
  try {
    return decodeURIComponent(unwrapped);
  } catch {
    return unwrapped;
  }
}

function matchAttachment(
  rawDestination: string,
  cwd: string,
  resolvePath: (from: string, to: string) => string,
  byResolvedPath: ReadonlyMap<string, UploadedMediaAttachment>,
): UploadedMediaAttachment | undefined {
  const candidate = decodeDestinationPath(rawDestination);
  if (candidate === "" || REMOTE_OR_FRAGMENT_DESTINATION.test(candidate)) {
    return undefined;
  }
  return byResolvedPath.get(resolvePath(cwd, candidate));
}

function findInlineCodeEnd(text: string, start: number): number {
  let ticks = 0;
  while (start + ticks < text.length && text[start + ticks] === "`") {
    ticks += 1;
  }
  const fence = "`".repeat(ticks);
  let i = start + ticks;
  while (i < text.length) {
    if (text.startsWith(fence, i)) {
      const after = i + ticks;
      if (text[after] !== "`") return after;
      while (i < text.length && text[i] === "`") i += 1;
      continue;
    }
    i += 1;
  }
  return start + ticks;
}

interface ParsedInlineTarget {
  readonly fullEnd: number;
  readonly destStart: number;
  readonly destEnd: number;
  readonly rawDestination: string;
}

/** Parses `(dest)` or `(dest "title")` starting at `(` and returns destination bounds. */
function parseInlineDestination(text: string, openParen: number): ParsedInlineTarget | null {
  if (text[openParen] !== "(") return null;
  let i = openParen + 1;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
  if (i >= text.length || text[i] === "\n") return null;

  const destStart = i;
  let destEnd = i;
  if (text[i] === "<") {
    i += 1;
    while (i < text.length && text[i] !== ">" && text[i] !== "\n") {
      if (text[i] === "\\" && i + 1 < text.length) i += 2;
      else i += 1;
    }
    if (text[i] !== ">") return null;
    i += 1;
    destEnd = i;
  } else {
    let depth = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\" && i + 1 < text.length) {
        i += 2;
        continue;
      }
      if (ch === "(") {
        depth += 1;
        i += 1;
        continue;
      }
      if (ch === ")") {
        if (depth === 0) break;
        depth -= 1;
        i += 1;
        continue;
      }
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") break;
      i += 1;
    }
    destEnd = i;
  }

  if (destEnd === destStart) return null;

  while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
  if (i < text.length && (text[i] === '"' || text[i] === "'" || text[i] === "(")) {
    const closeQuote = text[i] === "(" ? ")" : text[i];
    i += 1;
    while (i < text.length && text[i] !== closeQuote && text[i] !== "\n") {
      if (text[i] === "\\" && i + 1 < text.length) i += 2;
      else i += 1;
    }
    if (text[i] !== closeQuote) return null;
    i += 1;
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
  }

  if (text[i] !== ")") return null;
  return {
    fullEnd: i + 1,
    destStart,
    destEnd,
    rawDestination: text.slice(destStart, destEnd),
  };
}

function isStandaloneLine(text: string, start: number, end: number): boolean {
  let lineStart = start;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart -= 1;
  let lineEnd = end;
  while (lineEnd < text.length && text[lineEnd] !== "\n") lineEnd += 1;
  const before = text.slice(lineStart, start).trim();
  const after = text.slice(end, lineEnd).trim();
  return before === "" && after === "";
}

function rewriteHtmlMediaTag(
  text: string,
  start: number,
  cwd: string,
  resolvePath: (from: string, to: string) => string,
  byResolvedPath: ReadonlyMap<string, UploadedMediaAttachment>,
  referenced: Set<string>,
): { readonly replacement: string; readonly end: number } | null {
  const rest = text.slice(start);
  const tagMatch = /^<(?:img|video)(?=[\s/>])[^>]*>/i.exec(rest);
  if (tagMatch === null) return null;
  const tag = tagMatch[0];
  let changed = false;
  const rewritten = tag.replace(
    /(\bsrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i,
    (full, prefix: string, doubleQuoted?: string, singleQuoted?: string, unquoted?: string) => {
      const rawValue = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
      const matched = matchAttachment(rawValue, cwd, resolvePath, byResolvedPath);
      if (matched === undefined) return full;
      referenced.add(matched.resolvedPath);
      changed = true;
      if (doubleQuoted !== undefined) return `${prefix}"${matched.url}"`;
      if (singleQuoted !== undefined) return `${prefix}'${matched.url}'`;
      return `${prefix}${matched.url}`;
    },
  );
  if (!changed) return null;
  return { replacement: rewritten, end: start + tag.length };
}

function renderStandaloneAttachment(attachment: UploadedMediaAttachment): string {
  return attachment.kind === "video"
    ? attachment.url
    : `![${escapeMarkdownAlt(attachment.alt)}](${attachment.url})`;
}

/**
 * Rewrites local markdown references (images, links, and reference definitions) to their uploaded
 * asset URLs while leaving code fences and inline code spans untouched. Any attachment that was
 * never referenced in `markdown` is appended as a new paragraph at the end.
 */
export function attachUrlsToMarkdown(input: {
  readonly markdown: string;
  readonly attachments: ReadonlyArray<UploadedMediaAttachment>;
  readonly cwd: string;
  readonly resolvePath: (from: string, to: string) => string;
}): string {
  if (input.attachments.length === 0) return input.markdown;

  const byResolvedPath = new Map<string, UploadedMediaAttachment>(
    input.attachments.map((attachment) => [attachment.resolvedPath, attachment]),
  );
  const referenced = new Set<string>();
  const text = input.markdown;
  const out: Array<string> = [];

  let i = 0;
  let lineStart = true;
  let fenceChar: "`" | "~" | null = null;
  let fenceLength = 0;

  while (i < text.length) {
    if (lineStart) {
      let indent = i;
      while (indent < text.length && indent - i < 3 && text[indent] === " ") indent += 1;
      const ch = text[indent];
      if (ch === "`" || ch === "~") {
        let count = 0;
        while (indent + count < text.length && text[indent + count] === ch) count += 1;
        if (count >= 3) {
          const lineEndIdx = text.indexOf("\n", indent + count);
          const nextIdx = lineEndIdx === -1 ? text.length : lineEndIdx + 1;
          const restOfLine = text.slice(
            indent + count,
            lineEndIdx === -1 ? text.length : lineEndIdx,
          );
          if (fenceChar === null) {
            if (ch === "~" || !restOfLine.includes("`")) {
              fenceChar = ch;
              fenceLength = count;
            }
          } else if (fenceChar === ch && count >= fenceLength && restOfLine.trim() === "") {
            fenceChar = null;
            fenceLength = 0;
          }
          out.push(text.slice(i, nextIdx));
          i = nextIdx;
          lineStart = true;
          continue;
        }
      }

      if (fenceChar !== null) {
        const lineEndIdx = text.indexOf("\n", i);
        const nextIdx = lineEndIdx === -1 ? text.length : lineEndIdx + 1;
        out.push(text.slice(i, nextIdx));
        i = nextIdx;
        lineStart = true;
        continue;
      }

      // Reference-style link definition: `[label]: dest`
      const lineEndIdx = text.indexOf("\n", i);
      const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
      const line = text.slice(i, lineEnd);
      const refMatch = /^([ ]{0,3}\[[^\]]+\]:[ \t]+)(<[^>\n]+>|[^\s]+)(.*)$/.exec(line);
      if (refMatch !== null) {
        const prefix = refMatch[1]!;
        const rawDest = refMatch[2]!;
        const suffix = refMatch[3]!;
        const matched = matchAttachment(rawDest, input.cwd, input.resolvePath, byResolvedPath);
        if (matched !== undefined) {
          referenced.add(matched.resolvedPath);
          out.push(`${prefix}${matched.url}${suffix}`);
          if (lineEndIdx !== -1) out.push("\n");
          i = lineEndIdx === -1 ? text.length : lineEndIdx + 1;
          lineStart = true;
          continue;
        }
      }
    }

    if (fenceChar !== null) {
      const lineEndIdx = text.indexOf("\n", i);
      const nextIdx = lineEndIdx === -1 ? text.length : lineEndIdx + 1;
      out.push(text.slice(i, nextIdx));
      i = nextIdx;
      lineStart = true;
      continue;
    }

    const ch = text[i]!;
    if (ch === "\n") {
      out.push(ch);
      i += 1;
      lineStart = true;
      continue;
    }
    lineStart = false;

    if (ch === "\\" && i + 1 < text.length) {
      out.push(text.slice(i, i + 2));
      i += 2;
      continue;
    }

    if (ch === "`") {
      const end = findInlineCodeEnd(text, i);
      out.push(text.slice(i, end));
      i = end;
      continue;
    }

    if (ch === "<") {
      const htmlTag = rewriteHtmlMediaTag(
        text,
        i,
        input.cwd,
        input.resolvePath,
        byResolvedPath,
        referenced,
      );
      if (htmlTag !== null) {
        out.push(htmlTag.replacement);
        i = htmlTag.end;
        continue;
      }
    }

    const isImage = ch === "!" && text[i + 1] === "[";
    if (isImage || ch === "[") {
      const labelStart = isImage ? i + 2 : i + 1;
      let j = labelStart;
      let bracketDepth = 0;
      while (j < text.length) {
        const c = text[j];
        if (c === "\\" && j + 1 < text.length) {
          j += 2;
          continue;
        }
        if (c === "`") {
          j = findInlineCodeEnd(text, j);
          continue;
        }
        if (c === "[") bracketDepth += 1;
        else if (c === "]") {
          if (bracketDepth === 0) break;
          bracketDepth -= 1;
        } else if (c === "\n") {
          break;
        }
        j += 1;
      }

      if (j < text.length && text[j] === "]" && text[j + 1] === "(") {
        const target = parseInlineDestination(text, j + 1);
        if (target !== null) {
          const matched = matchAttachment(
            target.rawDestination,
            input.cwd,
            input.resolvePath,
            byResolvedPath,
          );
          if (matched !== undefined) {
            referenced.add(matched.resolvedPath);
            if (isImage && matched.kind === "video") {
              if (isStandaloneLine(text, i, target.fullEnd)) {
                out.push(matched.url);
              } else {
                const label = text.slice(labelStart, j).trim() || matched.alt;
                out.push(`[${label}](${matched.url})`);
              }
            } else {
              out.push(
                text.slice(i, target.destStart),
                matched.url,
                text.slice(target.destEnd, target.fullEnd),
              );
            }
            i = target.fullEnd;
            continue;
          }
        }
      }
    }

    out.push(ch);
    i += 1;
  }

  let result = out.join("");
  for (const attachment of input.attachments) {
    if (referenced.has(attachment.resolvedPath)) continue;
    const addition = renderStandaloneAttachment(attachment);
    const trimmed = result.replace(/[ \t\r\n]+$/, "");
    result = trimmed === "" ? addition : `${trimmed}\n\n${addition}`;
  }
  return result;
}
