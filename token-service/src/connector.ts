export interface DocumentInfo {
	id: string;
	tenantId: string;
	createdAt: string | null;
	sequenceNumber: number;
	minimumSequenceNumber: number;
	storage: {
		usedBytes: number;
		budgetBytes: number;
		cleanupReserveBytes: number;
		remainingWriteBytes: number;
	};
	summary: {
		handle: string | null;
		sequenceNumber: number;
		initialSequenceNumber: number;
		refCount: number;
	};
	connections: { readers: number; writers: number; limit: number };
	inspectedAt: string;
}

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

export interface ConnectorClient {
	describe(): Promise<ConnectorResult<{ apiVersion: 1; tenantId: string }>>;
	listDocuments(options?: {
		prefix?: string;
		cursor?: string;
	}): Promise<ConnectorResult<DocumentPage>>;
	inspectDocument(documentId: string): Promise<ConnectorResult<DocumentInfo>>;
}
