import { WorkerEntrypoint } from "cloudflare:workers";
import { bytes, errorResponse, HttpError, record } from "./common.js";
import { directoryPrefix } from "./directory.js";
import type { DocumentDO } from "./document.js";

interface ConnectorEnv {
	TENANT_ID: string;
	CONTENT: R2Bucket;
	DOCUMENTS: DurableObjectNamespace<DocumentDO>;
}

export type DocumentInfo = NonNullable<
	Awaited<ReturnType<DocumentDO["inspect"]>>
>;

export type ConnectorResult<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			error: { status: number; message: string; retryAfter?: string };
	  };

export interface DocumentPage {
	documents: { id: string; indexedAt: string }[];
	cursor: string | null;
}

export class TidepoolConnector extends WorkerEntrypoint<ConnectorEnv> {
	describe() {
		return this.#result(async () => ({
			apiVersion: 1 as const,
			tenantId: this.env.TENANT_ID,
		}));
	}

	listDocuments(options: { prefix?: string; cursor?: string } = {}) {
		return this.#result<DocumentPage>(async () => {
			const input = record(options);
			const prefix = input.prefix === undefined ? "" : input.prefix;
			const cursor = input.cursor === undefined ? "" : input.cursor;
			if (
				Object.keys(input).some((key) => !["prefix", "cursor"].includes(key)) ||
				typeof prefix !== "string" ||
				bytes(prefix) > 256 ||
				typeof cursor !== "string" ||
				bytes(cursor) > 2048
			)
				throw new HttpError(
					400,
					"Provide a prefix of at most 256 UTF-8 bytes and a cursor of at most 2048 bytes",
				);
			const root = await directoryPrefix(this.env.TENANT_ID);
			const page = await this.env.CONTENT.list({
				prefix: `${root}${encodeURIComponent(prefix)}`,
				limit: 50,
				...(cursor ? { cursor } : {}),
			});
			return {
				documents: page.objects.map((object) => ({
					id: decodeURIComponent(object.key.slice(root.length)),
					indexedAt: object.uploaded.toISOString(),
				})),
				cursor: page.truncated ? page.cursor : null,
			};
		});
	}

	inspectDocument(documentId: string) {
		return this.#result<DocumentInfo>(async () => {
			if (
				typeof documentId !== "string" ||
				!documentId ||
				bytes(documentId) > 256
			)
				throw new HttpError(
					400,
					"Document IDs must contain 1 to 256 UTF-8 bytes",
				);
			const info = await this.env.DOCUMENTS.get(
				this.env.DOCUMENTS.idFromName(
					JSON.stringify([this.env.TENANT_ID, documentId]),
				),
			).inspect(this.env.TENANT_ID, documentId);
			if (!info)
				throw new HttpError(
					404,
					`No document exists with ID "${documentId}". Check the ID and try again.`,
				);
			return info;
		});
	}

	async #result<T>(read: () => Promise<T>): Promise<ConnectorResult<T>> {
		try {
			if (!this.env.TENANT_ID)
				throw new HttpError(503, "TENANT_ID must be configured");
			return { ok: true, value: await read() };
		} catch (error) {
			const response = errorResponse(error);
			const { message } = await response.json<{ message: string }>();
			const retryAfter = response.headers.get("Retry-After");
			return {
				ok: false,
				error: {
					status: response.status,
					message,
					...(retryAfter ? { retryAfter } : {}),
				},
			};
		}
	}
}

export type ConnectorClient = Pick<
	TidepoolConnector,
	"describe" | "listDocuments" | "inspectDocument"
>;
