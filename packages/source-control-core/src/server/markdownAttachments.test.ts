import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import {
  attachUrlsToMarkdown,
  validateMediaAttachments,
  type UploadedMediaAttachment,
} from "./markdownAttachments.ts";

const GITHUB = SourceControlProviderKind.make("github");

function uploaded(
  overrides: Partial<UploadedMediaAttachment> & {
    readonly resolvedPath: string;
    readonly url: string;
  },
): UploadedMediaAttachment {
  const fileName = overrides.resolvedPath.split("/").at(-1) ?? overrides.resolvedPath;
  return {
    inputPath: overrides.inputPath ?? fileName,
    fileName,
    contentType: overrides.kind === "video" ? "video/mp4" : "image/png",
    sizeBytes: 128,
    kind: "image",
    alt: fileName.replace(/\.[^.]+$/, ""),
    ...overrides,
  };
}

function makeFakeFs(
  entries: Readonly<Record<string, { readonly type: FileSystem.File.Type; readonly size: number }>>,
) {
  return FileSystem.layerNoop({
    stat: (target) => {
      const entry = entries[target];
      if (entry === undefined) {
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "FileSystem",
            method: "stat",
            pathOrDescriptor: target,
            description: "ENOENT",
          }),
        );
      }
      return Effect.succeed({
        type: entry.type,
        size: BigInt(entry.size) as FileSystem.File.Info["size"],
        mtime: Option.none(),
        atime: Option.none(),
        birthtime: Option.none(),
        dev: 0n,
        ino: Option.none(),
        mode: 0o644,
        nlink: Option.none(),
        uid: Option.none(),
        gid: Option.none(),
        rdev: Option.none(),
        blksize: Option.none(),
        blocks: Option.none(),
      } satisfies FileSystem.File.Info);
    },
  });
}

describe("validateMediaAttachments", () => {
  it.effect("validates supported images and videos and deduplicates resolved paths", () => {
    const dir = "/tmp/attachments";
    const png = `${dir}/before.fix.png`;
    const mp4 = `${dir}/demo.mp4`;
    return Effect.gen(function* () {
      const result = yield* validateMediaAttachments({
        provider: GITHUB,
        cwd: dir,
        attachments: [
          { path: "./before.fix.png" },
          { path: png, alt: "ignored duplicate" },
          { path: "demo.mp4" },
        ],
      });

      expect(result).toEqual([
        {
          inputPath: "./before.fix.png",
          resolvedPath: png,
          fileName: "before.fix.png",
          contentType: "image/png",
          sizeBytes: 3,
          kind: "image",
          alt: "before fix",
        },
        {
          inputPath: "demo.mp4",
          resolvedPath: mp4,
          fileName: "demo.mp4",
          contentType: "video/mp4",
          sizeBytes: 4,
          kind: "video",
          alt: "demo.mp4",
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Path.layer,
          makeFakeFs({
            [png]: { type: "File", size: 3 },
            [mp4]: { type: "File", size: 4 },
          }),
        ),
      ),
    );
  });

  it.effect("rejects unsupported extensions, empty files, directories, and missing files", () => {
    const dir = "/tmp/attachments";
    const empty = `${dir}/empty.png`;
    const subdir = `${dir}/nested.png`;
    return Effect.gen(function* () {
      const badExt = yield* Effect.flip(
        validateMediaAttachments({
          provider: GITHUB,
          cwd: dir,
          attachments: [{ path: "notes.txt" }],
        }),
      );
      expect(badExt.reason).toBe("invalid");
      expect(badExt.message).toContain("not a supported file type");

      const emptyErr = yield* Effect.flip(
        validateMediaAttachments({ provider: GITHUB, cwd: dir, attachments: [{ path: empty }] }),
      );
      expect(emptyErr.message).toContain("is empty");

      const dirErr = yield* Effect.flip(
        validateMediaAttachments({ provider: GITHUB, cwd: dir, attachments: [{ path: subdir }] }),
      );
      expect(dirErr.message).toContain("is a directory");

      const missingErr = yield* Effect.flip(
        validateMediaAttachments({
          provider: GITHUB,
          cwd: dir,
          attachments: [{ path: "missing.png" }],
        }),
      );
      expect(missingErr.message).toContain("could not be read");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Path.layer,
          makeFakeFs({
            [empty]: { type: "File", size: 0 },
            [subdir]: { type: "Directory", size: 0 },
          }),
        ),
      ),
    );
  });
});

describe("attachUrlsToMarkdown", () => {
  it.effect(
    "rewrites inline images, videos, and reference links while skipping code and appending unreferenced files",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const cwd = "/repo";
        const attachments = [
          uploaded({
            resolvedPath: "/repo/before.png",
            url: "https://github.com/user-attachments/assets/1",
          }),
          uploaded({
            resolvedPath: "/repo/after.png",
            url: "https://github.com/user-attachments/assets/2",
            alt: "After [fix]",
          }),
          uploaded({
            resolvedPath: "/repo/demo.mp4",
            url: "https://github.com/user-attachments/assets/3",
            kind: "video",
          }),
          uploaded({
            resolvedPath: "/repo/inline.mp4",
            url: "https://github.com/user-attachments/assets/4",
            kind: "video",
          }),
          uploaded({
            resolvedPath: "/repo/extra.mp4",
            url: "https://github.com/user-attachments/assets/5",
            kind: "video",
          }),
        ];

        const markdown = [
          "See ![Before](./before.png) and inline ![clip](./inline.mp4).",
          "",
          "![Demo](./demo.mp4)",
          "",
          "Code stays untouched: `![Before](./before.png)`",
          "```md",
          "![Before](./before.png)",
          "```",
        ].join("\n");

        const rewritten = attachUrlsToMarkdown({
          markdown,
          attachments,
          cwd,
          resolvePath: path.resolve,
        });

        expect(rewritten).toBe(
          [
            "See ![Before](https://github.com/user-attachments/assets/1) and inline [clip](https://github.com/user-attachments/assets/4).",
            "",
            "https://github.com/user-attachments/assets/3",
            "",
            "Code stays untouched: `![Before](./before.png)`",
            "```md",
            "![Before](./before.png)",
            "```",
            "",
            "![After \\[fix\\]](https://github.com/user-attachments/assets/2)",
            "",
            "https://github.com/user-attachments/assets/5",
          ].join("\n"),
        );
      }).pipe(Effect.provide(Path.layer)),
  );

  it.effect("rewrites reference-style definitions and appends into an empty body", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const cwd = "/repo";
      const shot = uploaded({
        resolvedPath: "/repo/shot.png",
        url: "https://github.com/user-attachments/assets/ref",
        alt: "Shot",
      });

      expect(
        attachUrlsToMarkdown({
          markdown: "Look at ![img][s]\n\n[s]: ./shot.png",
          attachments: [shot],
          cwd,
          resolvePath: path.resolve,
        }),
      ).toBe("Look at ![img][s]\n\n[s]: https://github.com/user-attachments/assets/ref");

      expect(
        attachUrlsToMarkdown({
          markdown: "",
          attachments: [shot],
          cwd,
          resolvePath: path.resolve,
        }),
      ).toBe("![Shot](https://github.com/user-attachments/assets/ref)");

      const video = uploaded({
        resolvedPath: "/repo/demo.mp4",
        url: "https://github.com/user-attachments/assets/vid",
        kind: "video",
      });
      expect(
        attachUrlsToMarkdown({
          markdown:
            '<img src="./shot.png" width="400" />\n<video src=\'./demo.mp4\' controls></video>\n`<img src="./shot.png" />`',
          attachments: [shot, video],
          cwd,
          resolvePath: path.resolve,
        }),
      ).toBe(
        '<img src="https://github.com/user-attachments/assets/ref" width="400" />\n<video src=\'https://github.com/user-attachments/assets/vid\' controls></video>\n`<img src="./shot.png" />`',
      );
    }).pipe(Effect.provide(Path.layer)),
  );
});
