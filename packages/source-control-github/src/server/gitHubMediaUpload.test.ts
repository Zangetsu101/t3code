import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubMediaUpload from "./gitHubMediaUpload.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";

describe("GitHubMediaUpload", () => {
  it.effect(
    "uploads binary bytes to uploads.github.com and falls back from app token to personal token on 404",
    () => {
      const requests: Array<{
        readonly url: string;
        readonly method: string;
        readonly authorization: string | undefined;
        readonly contentType: string | undefined;
        readonly accept: string | undefined;
      }> = [];

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const file = path.join(dir, "shot.png");
        yield* fs.writeFile(file, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

        const uploadMedia = yield* GitHubMediaUpload.make;
        const result = yield* uploadMedia({
          host: "github.com",
          repository: "acme/app",
          path: file,
          fileName: "shot.png",
          contentType: "image/png",
          sizeBytes: 4,
        });

        expect(result).toEqual({ url: "https://github.com/user-attachments/assets/abc-123" });
        expect(requests).toEqual([
          {
            url: "https://uploads.github.com/user-attachments/assets?name=shot.png&content_type=image%2Fpng&repository_id=42",
            method: "POST",
            authorization: "Bearer app-token",
            contentType: "application/octet-stream",
            accept: "application/vnd.github+json",
          },
          {
            url: "https://uploads.github.com/user-attachments/assets?name=shot.png&content_type=image%2Fpng&repository_id=42",
            method: "POST",
            authorization: "Bearer personal-token",
            contentType: "application/octet-stream",
            accept: "application/vnd.github+json",
          },
        ]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            GitHubRequestPolicy.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  GitHubQuota.layer,
                  SourceControlRateLimit.layer,
                  Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
                    enabled: true,
                    token: () => Effect.succeedSome("app-token"),
                    invalidate: () => Effect.void,
                  }),
                  Layer.mock(GitHubCredentials.GitHubCredentials)({
                    saved: () => Effect.succeedNone,
                    get: (host) =>
                      Effect.succeed({
                        host,
                        token: Redacted.make("personal-token"),
                        source: "gh" as const,
                        fingerprint: "gh-fp",
                      }),
                    fingerprint: (host, token) => Effect.succeed(`${host}:${token}`),
                    invalidate: () => Effect.void,
                  }),
                ),
              ),
            ),
            Layer.mock(GitHubRest.GitHubRest)({
              rest: () =>
                Effect.succeed({
                  status: 200,
                  headers: {},
                  body: JSON.stringify({ id: 42, permissions: { push: true } }),
                  truncated: false,
                  invalidUtf8: false,
                }),
            }),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.sync(() => {
                  requests.push({
                    url: request.url,
                    method: request.method,
                    authorization: request.headers.authorization,
                    contentType: request.headers["content-type"],
                    accept: request.headers.accept,
                  });
                  if (request.headers.authorization === "Bearer app-token") {
                    return HttpClientResponse.fromWeb(request, new Response("", { status: 404 }));
                  }
                  return HttpClientResponse.fromWeb(
                    request,
                    new Response(
                      JSON.stringify({ url: "https://github.com/user-attachments/assets/abc-123" }),
                      { status: 201, headers: { "content-type": "application/json" } },
                    ),
                  );
                }),
              ),
            ),
          ),
        ),
      );
    },
  );

  it.effect("rejects GitHub Enterprise Server hosts and maps upload 404 to forbidden", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const file = path.join(dir, "shot.png");
      yield* fs.writeFile(file, new Uint8Array([1, 2, 3]));

      const uploadMedia = yield* GitHubMediaUpload.make;

      const ghesError = yield* Effect.flip(
        uploadMedia({
          host: "git.corp.example",
          repository: "acme/app",
          path: file,
          fileName: "shot.png",
          contentType: "image/png",
          sizeBytes: 3,
        }),
      );
      expect(ghesError.reason).toBe("unsupported");

      const forbiddenError = yield* Effect.flip(
        uploadMedia({
          host: "github.com",
          repository: "acme/app",
          path: file,
          fileName: "shot.png",
          contentType: "image/png",
          sizeBytes: 3,
        }),
      );
      expect(forbiddenError.reason).toBe("forbidden");
      expect(forbiddenError.message).toContain("write access");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          GitHubRequestPolicy.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                GitHubQuota.layer,
                SourceControlRateLimit.layer,
                Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
                  enabled: false,
                  token: () => Effect.succeedNone,
                  invalidate: () => Effect.void,
                }),
                Layer.mock(GitHubCredentials.GitHubCredentials)({
                  saved: () => Effect.succeedNone,
                  get: (host) =>
                    Effect.succeed({
                      host,
                      token: Redacted.make("read-only-token"),
                      source: "gh" as const,
                      fingerprint: "gh-ro",
                    }),
                  fingerprint: (host, token) => Effect.succeed(`${host}:${token}`),
                  invalidate: () => Effect.void,
                }),
              ),
            ),
          ),
          Layer.mock(GitHubRest.GitHubRest)({
            rest: () =>
              Effect.succeed({
                status: 200,
                headers: {},
                body: JSON.stringify({ id: 42 }),
                truncated: false,
                invalidUtf8: false,
              }),
          }),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response("", { status: 404 })),
              ),
            ),
          ),
        ),
      ),
    ),
  );
});
