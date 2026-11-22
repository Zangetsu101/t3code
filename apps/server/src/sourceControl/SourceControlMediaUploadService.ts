import type { SourceControlProviderKind } from "@t3tools/contracts";
import { SourceControlMediaUploadError } from "@t3tools/source-control-core/server/driver";
import {
  attachUrlsToMarkdown,
  validateMediaAttachments,
  type MarkdownAttachmentInput,
  type UploadedMediaAttachment,
  type ValidatedMediaAttachment,
} from "@t3tools/source-control-core/server/markdownAttachments";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as SourceControlBuiltInDrivers from "./builtInDrivers.ts";

export interface AttachMarkdownMediaInput {
  readonly provider: SourceControlProviderKind;
  readonly host: string;
  readonly repository: string;
  readonly cwd: string;
  readonly markdown: string;
  readonly attachments: ReadonlyArray<MarkdownAttachmentInput>;
}

export interface AttachMarkdownMediaResult {
  readonly markdown: string;
  readonly uploaded: ReadonlyArray<{ readonly path: string; readonly url: string }>;
}

export class SourceControlMediaUploadService extends Context.Service<
  SourceControlMediaUploadService,
  {
    readonly validate: (input: {
      readonly provider: SourceControlProviderKind;
      readonly cwd: string;
      readonly attachments: ReadonlyArray<MarkdownAttachmentInput>;
    }) => Effect.Effect<ReadonlyArray<ValidatedMediaAttachment>, SourceControlMediaUploadError>;
    readonly attachToMarkdown: (
      input: AttachMarkdownMediaInput,
    ) => Effect.Effect<AttachMarkdownMediaResult, SourceControlMediaUploadError>;
  }
>()("t3/sourceControl/SourceControlMediaUploadService") {}

const make = Effect.gen(function* () {
  const drivers = yield* SourceControlBuiltInDrivers.SourceControlDrivers;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const uploadFor = (provider: SourceControlProviderKind) => {
    const uploadMedia = drivers.find(({ driver }) => driver.kind === provider)?.instance
      .uploadMedia;
    return uploadMedia === undefined
      ? Effect.fail(
          new SourceControlMediaUploadError({
            provider,
            reason: "unsupported",
            code: "provider-unsupported",
          }),
        )
      : Effect.succeed(uploadMedia);
  };

  const validate: SourceControlMediaUploadService["Service"]["validate"] = Effect.fn(
    "SourceControlMediaUploadService.validate",
  )(function* (input) {
    yield* uploadFor(input.provider);
    return yield* validateMediaAttachments(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  });

  const attachToMarkdown: SourceControlMediaUploadService["Service"]["attachToMarkdown"] =
    Effect.fn("SourceControlMediaUploadService.attachToMarkdown")(function* (input) {
      if (input.attachments.length === 0) {
        return { markdown: input.markdown, uploaded: [] };
      }
      const uploadMedia = yield* uploadFor(input.provider);
      const validated = yield* validateMediaAttachments({
        provider: input.provider,
        cwd: input.cwd,
        attachments: input.attachments,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const uploaded: Array<UploadedMediaAttachment> = [];
      for (const attachment of validated) {
        const { url } = yield* uploadMedia({
          host: input.host,
          repository: input.repository,
          path: attachment.resolvedPath,
          fileName: attachment.fileName,
          contentType: attachment.contentType,
          sizeBytes: attachment.sizeBytes,
        });
        uploaded.push({ ...attachment, url });
      }

      const markdown = attachUrlsToMarkdown({
        markdown: input.markdown,
        attachments: uploaded,
        cwd: input.cwd,
        resolvePath: path.resolve,
      });

      return {
        markdown,
        uploaded: uploaded.map((item) => ({ path: item.inputPath, url: item.url })),
      };
    });

  return SourceControlMediaUploadService.of({ validate, attachToMarkdown });
});

export const layer = Layer.effect(SourceControlMediaUploadService, make);
