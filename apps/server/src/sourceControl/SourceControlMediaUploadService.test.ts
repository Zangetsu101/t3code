import * as NodeServices from "@effect/platform-node/NodeServices";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { fakeSourceControlDriverInstance } from "@t3tools/source-control-testing/fakeSourceControlDriver";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as SourceControlBuiltInDrivers from "./builtInDrivers.ts";
import * as SourceControlMediaUploadService from "./SourceControlMediaUploadService.ts";
import { sourceControlDefinitions } from "./sourceControlDefinitions.ts";

const GITHUB = SourceControlProviderKind.make("github");
const GITLAB = SourceControlProviderKind.make("gitlab");

describe("SourceControlMediaUploadService", () => {
  it.effect(
    "uploads validated attachments through the provider driver and rewrites markdown",
    () => {
      const uploads: Array<{
        readonly host: string;
        readonly repository: string;
        readonly fileName: string;
        readonly contentType: string;
      }> = [];

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const before = path.join(dir, "before.png");
        const after = path.join(dir, "after.png");
        yield* fs.writeFile(before, new Uint8Array([1, 2, 3]));
        yield* fs.writeFile(after, new Uint8Array([4, 5, 6]));

        const service = yield* SourceControlMediaUploadService.SourceControlMediaUploadService;
        const result = yield* service.attachToMarkdown({
          provider: GITHUB,
          host: "github.com",
          repository: "acme/app",
          cwd: dir,
          markdown: "Before: ![old](./before.png)",
          attachments: [{ path: "./before.png" }, { path: after, alt: "After" }],
        });

        expect(uploads).toEqual([
          {
            host: "github.com",
            repository: "acme/app",
            fileName: "before.png",
            contentType: "image/png",
          },
          {
            host: "github.com",
            repository: "acme/app",
            fileName: "after.png",
            contentType: "image/png",
          },
        ]);
        expect(result.markdown).toBe(
          "Before: ![old](https://github.com/user-attachments/assets/before.png)\n\n![After](https://github.com/user-attachments/assets/after.png)",
        );
        expect(result.uploaded).toEqual([
          { path: "./before.png", url: "https://github.com/user-attachments/assets/before.png" },
          { path: after, url: "https://github.com/user-attachments/assets/after.png" },
        ]);
      }).pipe(
        Effect.provide(
          SourceControlMediaUploadService.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                NodeServices.layer,
                Layer.succeed(SourceControlBuiltInDrivers.SourceControlDrivers, [
                  {
                    driver: { kind: GITHUB, definition: sourceControlDefinitions.get(GITHUB) },
                    instance: fakeSourceControlDriverInstance("github", {
                      uploadMedia: (request) =>
                        Effect.sync(() => {
                          uploads.push({
                            host: request.host,
                            repository: request.repository,
                            fileName: request.fileName,
                            contentType: request.contentType,
                          });
                          return {
                            url: `https://github.com/user-attachments/assets/${request.fileName}`,
                          };
                        }),
                    }),
                  },
                ]),
              ),
            ),
          ),
        ),
      );
    },
  );

  it.effect("returns unsupported when the provider driver does not implement uploadMedia", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlMediaUploadService.SourceControlMediaUploadService;
      const error = yield* Effect.flip(
        service.attachToMarkdown({
          provider: GITLAB,
          host: "gitlab.com",
          repository: "acme/app",
          cwd: "/workspace",
          markdown: "Body",
          attachments: [{ path: "shot.png" }],
        }),
      );
      expect(error.reason).toBe("unsupported");
      expect(error.message).toContain("gitlab");
    }).pipe(
      Effect.provide(
        SourceControlMediaUploadService.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              NodeServices.layer,
              Layer.succeed(SourceControlBuiltInDrivers.SourceControlDrivers, [
                {
                  driver: { kind: GITLAB, definition: sourceControlDefinitions.get(GITLAB) },
                  instance: fakeSourceControlDriverInstance("gitlab"),
                },
              ]),
            ),
          ),
        ),
      ),
    ),
  );
});
