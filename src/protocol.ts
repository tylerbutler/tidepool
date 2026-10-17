import * as gleam from "../protocol/build/dev/javascript/tidepool_protocol/adapter.mjs";
import { HttpError, integer, record, text } from "./common.js";

export interface Operation {
	[key: string]: unknown;
	sequenceNumber: number;
	minimumSequenceNumber: number;
	clientId: string | null;
	clientSequenceNumber: number;
	referenceSequenceNumber: number;
	type: string;
	contents: unknown;
}

export function result(encoded: string): unknown {
	const value = record(JSON.parse(encoded));
	if (typeof value.error === "string") throw new HttpError(400, value.error);
	if (!("ok" in value)) throw new Error("Invalid Gleam adapter result");
	return value.ok;
}

export function operation(value: unknown): Operation {
	const op = record(value);
	integer(op.sequenceNumber);
	integer(op.minimumSequenceNumber);
	text(op.type);
	if (
		(op.clientId !== null && typeof op.clientId !== "string") ||
		!Number.isSafeInteger(op.clientSequenceNumber) ||
		!Number.isSafeInteger(op.referenceSequenceNumber)
	)
		throw new Error("Invalid sequenced operation");
	return op as Operation;
}

export const protocol = {
	frame(input: string): { event: string; args: unknown[] } {
		const value = record(result(gleam.frame(input)));
		return {
			event: text(value.event),
			args: Array.isArray(value.args) ? value.args : [],
		};
	},
	admit(input: unknown, scopes: string[]) {
		const value = record(
			result(gleam.admit(JSON.stringify(input), JSON.stringify(scopes))),
		);
		return {
			tenant: text(value.tenantId),
			document: text(value.documentId),
			token: text(value.token),
			mode: value.mode === "write" ? ("write" as const) : ("read" as const),
		};
	},
	assign(
		checkpoint: unknown,
		client: string,
		mode: string,
		input: unknown,
		size: number,
	) {
		return operation(
			result(
				gleam.assign(
					JSON.stringify(checkpoint),
					client,
					mode,
					JSON.stringify(input),
					size,
					Date.now(),
				),
			),
		);
	},
	system(checkpoint: unknown, kind: string, data: unknown) {
		return operation(
			result(
				gleam.system(
					JSON.stringify(checkpoint),
					kind,
					JSON.stringify(data),
					Date.now(),
				),
			),
		);
	},
	ack(handle: string, proposal: number, minimum: number) {
		return operation(
			JSON.parse(gleam.summary_response(handle, proposal, minimum, Date.now())),
		);
	},
	signals(input: unknown, sender: string, clients: string[]) {
		const batch = result(
			gleam.signal_batch(
				JSON.stringify(input),
				sender,
				JSON.stringify(clients),
			),
		);
		if (!Array.isArray(batch)) throw new Error("Invalid signal adapter result");
		return batch.map((item: unknown) => {
			const value = record(item);
			if (
				!Array.isArray(value.recipients) ||
				!value.recipients.every((id: unknown) => typeof id === "string")
			) {
				throw new Error("Invalid signal recipients");
			}
			return {
				recipients: value.recipients as string[],
				message: value.message,
			};
		});
	},
	open: gleam.open,
};
