import { SourceControlProviderKind } from "@t3tools/contracts";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import {
  SourceControlMediaUploadError,
  type SourceControlMediaUploadRequest,
} from "@t3tools/source-control-core/server/driver";
import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/http";

import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";

const KIND = SourceControlProviderKind.make("github");
const UPLOAD_TIMEOUT = Duration.minutes(2);
const MAX_UPLOAD_RESPONSE_BYTES = 256 * 1024;
const REPOSITORY_CACHE_MAX_ENTRIES = 256;

const RepositoryMetadataJson = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.Finite,
  }),
);
const decodeRepositoryMetadata = Schema.decodeUnknownOption(RepositoryMetadataJson);

const UploadResponseJson = Schema.fromJsonString(
  Schema.Struct({
    url: Schema.String,
  }),
);
const decodeUploadResponse = Schema.decodeUnknownOption(UploadResponseJson);

function isUploadSupportedHost(host: string): boolean {
  return host === "github.com" || host.endsWith(".ghe.com");
}

function parseRepository(
  repository: string,
): { readonly owner: string; readonly name: string } | null {
  const parts = repository.trim().split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!owner || !name || owner === "." || owner === ".." || name === "." || name === "..") {
    return null;
  }
  return { owner, name };
}

function mapUploadApiError(
  fileName: string,
  error: GitHubRequestPolicy.GitHubApiError,
): SourceControlMediaUploadError {
  switch (error._tag) {
    case "GitHubCliMissingError":
    case "GitHubNotSignedInError":
    case "GitHubHostDisabledError":
    case "GitHubApiAuthenticationError":
    case "GitHubAppSessionError":
      return new SourceControlMediaUploadError({
        provider: KIND,
        reason: "unauthenticated",
        fileName,
        cause: error,
      });
    case "GitHubApiRateLimitError":
    case "SourceControlRateLimitPausedError":
      return new SourceControlMediaUploadError({
        provider: KIND,
        reason: "rate-limited",
        fileName,
        cause: error,
      });
    case "GitHubApiNotFoundError":
      return new SourceControlMediaUploadError({
        provider: KIND,
        reason: "forbidden",
        fileName,
        cause: error,
      });
    case "GitHubApiResponseError":
      return new SourceControlMediaUploadError({
        provider: KIND,
        reason: error.status === 422 ? "invalid" : "failed",
        fileName,
        status: error.status,
        cause: error,
      });
    case "GitHubApiRequestError":
    default:
      return new SourceControlMediaUploadError({
        provider: KIND,
        reason: "failed",
        fileName,
        cause: error,
      });
  }
}

export const make = Effect.gen(function* () {
  const rest = yield* GitHubRest.GitHubRest;
  const policy = yield* GitHubRequestPolicy.GitHubRequestPolicy;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;

  // Numeric repository IDs are immutable, so caching avoids a repeated GET when uploading a batch.
  const repositoryIds = new Map<string, number>();

  const resolveRepositoryId = Effect.fn("GitHubMediaUpload.resolveRepositoryId")(function* (
    host: string,
    repository: string,
    fileName: string,
  ) {
    const parsed = parseRepository(repository);
    if (parsed === null) {
      return yield* new SourceControlMediaUploadError({
        provider: KIND,
        reason: "invalid",
        code: "invalid-repository",
        fileName,
      });
    }

    const cacheKey = `${host}\u0000${parsed.owner.toLowerCase()}/${parsed.name.toLowerCase()}`;
    const cached = repositoryIds.get(cacheKey);
    if (cached !== undefined) return cached;

    const response = yield* rest
      .rest({
        host,
        operation: "getRepositoryForMediaUpload",
        path: `repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`,
        allowReserve: true,
      })
      .pipe(Effect.mapError((error) => mapUploadApiError(fileName, error)));

    const metadata = decodeRepositoryMetadata(response.body);
    if (Option.isNone(metadata) || metadata.value.id <= 0) {
      return yield* new SourceControlMediaUploadError({
        provider: KIND,
        reason: "failed",
        code: "missing-repository-id",
        fileName,
      });
    }

    if (repositoryIds.size >= REPOSITORY_CACHE_MAX_ENTRIES) {
      const oldest = repositoryIds.keys().next().value;
      if (oldest !== undefined) repositoryIds.delete(oldest);
    }
    repositoryIds.set(cacheKey, metadata.value.id);
    return metadata.value.id;
  });

  return Effect.fn("GitHubMediaUpload.uploadMedia")(function* (
    request: SourceControlMediaUploadRequest,
  ) {
    const host = normalizeHost(request.host);
    if (!isUploadSupportedHost(host)) {
      return yield* new SourceControlMediaUploadError({
        provider: KIND,
        reason: "unsupported",
        code: "host-unsupported",
        fileName: request.fileName,
      });
    }

    const repositoryId = yield* resolveRepositoryId(host, request.repository, request.fileName);

    const uploadUrl = new URL(`https://uploads.${host}/user-attachments/assets`);
    uploadUrl.searchParams.set("name", request.fileName);
    uploadUrl.searchParams.set("content_type", request.contentType);
    uploadUrl.searchParams.set("repository_id", String(repositoryId));

    const uploadedUrl = yield* policy
      .request(
        {
          host,
          operation: "uploadUserAttachment",
          resource: "core",
          allowReserve: true,
          timeout: UPLOAD_TIMEOUT,
        },
        (headers) =>
          Effect.gen(function* () {
            const body = HttpBody.stream(
              fileSystem.stream(request.path),
              "application/octet-stream",
              request.sizeBytes,
            );
            const httpRequest = HttpClientRequest.post(uploadUrl.toString()).pipe(
              HttpClientRequest.setHeaders(headers),
              HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
              HttpClientRequest.setBody(body),
            );
            const response = yield* httpClient
              .execute(httpRequest)
              .pipe(Effect.provideService(HttpClient.TracerDisabledWhen, () => true));
            const collected = yield* collectUint8StreamText({
              stream: response.stream,
              maxBytes: MAX_UPLOAD_RESPONSE_BYTES,
            }).pipe(
              Effect.catchIf(
                (error) => error.reason._tag === "EmptyBodyError",
                () => Effect.succeed({ text: "", truncated: false, invalidUtf8: false }),
              ),
            );
            const meta = { status: response.status, headers: response.headers };
            if (
              GitHubRequestPolicy.isRateLimited({
                status: response.status,
                headers: response.headers,
                body: collected.text,
              })
            ) {
              return { _tag: "RateLimited" as const, ...meta };
            }
            if (response.status === 401) {
              return { _tag: "Unauthorized" as const, ...meta };
            }
            if (response.status === 404) {
              return { _tag: "NotFound" as const, ...meta };
            }
            if (response.status >= 200 && response.status < 300) {
              const decoded = decodeUploadResponse(collected.text);
              if (Option.isSome(decoded) && decoded.value.url.trim() !== "") {
                return { _tag: "Ok" as const, value: decoded.value.url.trim(), ...meta };
              }
              return { _tag: "Ok" as const, value: "", ...meta };
            }
            return { _tag: "Failed" as const, ...meta };
          }).pipe(
            Effect.mapError(
              (cause) =>
                new GitHubRequestPolicy.GitHubApiRequestError({
                  host,
                  operation: "uploadUserAttachment",
                  cause,
                }),
            ),
          ),
      )
      .pipe(Effect.mapError((error) => mapUploadApiError(request.fileName, error)));

    if (uploadedUrl === "") {
      return yield* new SourceControlMediaUploadError({
        provider: KIND,
        reason: "failed",
        code: "missing-asset-url",
        fileName: request.fileName,
      });
    }

    return { url: uploadedUrl };
  });
});
