import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
	ConnectionState,
	LoaderHeader,
} from "@fluidframework/container-definitions/internal";
import { Loader } from "@fluidframework/container-loader/internal";
import type { ISummarizer } from "@fluidframework/container-runtime/internal";
import {
	DriverHeader,
	type ISnapshotTree,
} from "@fluidframework/driver-definitions/internal";
import {
	createDOProviderContainerRuntimeFactory,
	isInternalFluidContainer,
} from "@fluidframework/fluid-static/internal";
import type { IQuorum } from "@fluidframework/protocol-definitions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConnectorClient } from "../src/connector.js";
import { createAdapter, createClient, schema } from "./client.js";
import * as helpers from "./runtime.js";

function assertProposalQuorum(
	quorum: object,
): asserts quorum is Pick<IQuorum, "propose" | "get"> {
	if (
		!("propose" in quorum) ||
		typeof quorum.propose !== "function" ||
		!("get" in quorum) ||
		typeof quorum.get !== "function"
	)
		throw new Error("Expected the runtime quorum proposal API");
}

describe.each([true, false])("Tidepool (R2: %s)", (r2) => {
	let environment: Awaited<ReturnType<typeof helpers.startRuntime>>;
	let persistencePath: string | undefined;
	beforeAll(async () => {
		persistencePath = resolve(await mkdtemp(".tidepool-acceptance-"));
		environment = await helpers.startRuntime(persistencePath, true, r2);
	});
	afterAll(async () => {
		try {
			await environment?.runtime.dispose();
		} finally {
			if (persistencePath !== undefined) {
				await rm(persistencePath, { recursive: true, force: true });
			}
		}
	});

	function client(user: string) {
		return createClient(environment.base, user);
	}

	it("reloads an accepted updated SharedMap summary and delta tail across a runtime restart", async () => {
		const first = await client("first").createContainer();
		let id: string;
		let summaryHandle: string;
		let summarySequence: number;
		try {
			id = await first.container.attach();
			const second = await client("second").getContainer(id);
			try {
				first.container.initialObjects.map.set("shared", "from-first");
				await expect
					.poll(() => second.container.initialObjects.map.get("shared"))
					.toBe("from-first");
				second.container.initialObjects.map.set("reply", "from-second");
				await expect
					.poll(() => first.container.initialObjects.map.get("reply"))
					.toBe("from-second");
				if (!isInternalFluidContainer(first.container)) {
					throw new Error("Expected an internal Fluid container");
				}
				const quorum = first.container.container.getQuorum();
				assertProposalQuorum(quorum);
				await quorum.propose("tidepool-setting", { enabled: true });
				const editedSequence =
					first.container.container.deltaManager.lastSequenceNumber;
				expect(editedSequence).toBeGreaterThan(0);

				const adapter = createAdapter(environment.base);
				const factory = createDOProviderContainerRuntimeFactory({
					schema,
					compatibilityMode: "2",
					runtimeOptionOverrides: {
						summaryOptions: {
							summaryConfigOverrides: {
								state: "disableHeuristics",
								initialSummarizerDelayMs: 0,
								maxAckWaitTime: 10_000,
								maxOpsSinceLastSummary: 7000,
							},
						},
					},
				});
				const loader = new Loader({
					...adapter,
					codeLoader: {
						load: async () => ({
							module: { fluidExport: factory },
							details: { package: "no-dynamic-package", config: {} },
						}),
					},
				});
				const summarizerContainer = await loader.resolve({
					url: helpers.createResolvedUrl(id, environment.base).url,
					headers: {
						[LoaderHeader.clientDetails]: {
							capabilities: { interactive: false },
							type: "summarizer",
						},
						[DriverHeader.summarizingClient]: true,
						[LoaderHeader.reconnect]: false,
						[LoaderHeader.sequenceNumber]: editedSequence,
					},
				});
				let summarizer: ISummarizer | undefined;
				try {
					const entryPoint: Partial<ISummarizer> =
						await summarizerContainer.getEntryPoint();
					summarizer = entryPoint.ISummarizer;
					if (summarizer === undefined) {
						throw new Error("Fluid did not provide an ISummarizer entry point");
					}
					await expect
						.poll(() => summarizerContainer.deltaManager.lastSequenceNumber)
						.toBeGreaterThanOrEqual(editedSequence);
					const results = summarizer.summarizeOnDemand({
						reason: "Tidepool updated SharedMap acceptance",
						fullTree: true,
					});
					const submitted = await results.summarySubmitted;
					expect(submitted.success, JSON.stringify(submitted)).toBe(true);
					const accepted = await results.receivedSummaryAckOrNack;
					expect(accepted.success, JSON.stringify(accepted)).toBe(true);
					if (!accepted.success) {
						throw new Error("Updated summary was not accepted");
					}
					expect(accepted.data.summaryAckOp.type).toBe("summaryAck");
					summaryHandle = accepted.data.summaryAckOp.contents.handle;
					const broadcast = await results.summaryOpBroadcasted;
					if (!broadcast.success) {
						throw new Error("Summary operation was not broadcast");
					}
					summarySequence = broadcast.data.summarizeOp.referenceSequenceNumber;
					expect(summarySequence).toBeGreaterThanOrEqual(editedSequence);
				} finally {
					summarizer?.close();
					summarizerContainer.dispose();
				}

				const service = await helpers.service(environment.base, id);
				try {
					const storage = await service.connectToStorage();
					const versions = await storage.getVersions(id, 1);
					expect(versions[0]?.id).toBe(summaryHandle);
					const snapshot = await storage.getSnapshotTree(versions[0]);
					if (snapshot === null) {
						throw new Error("Published summary has no snapshot");
					}
					const attributesHash = snapshot.trees[".protocol"]?.blobs.attributes;
					if (!attributesHash)
						throw new Error("Published summary has no protocol attributes");
					const attributes = JSON.parse(
						new TextDecoder().decode(await storage.readBlob(attributesHash)),
					);
					expect(attributes.sequenceNumber).toBe(summarySequence);
					expect(attributes.sequenceNumber).toBeGreaterThan(0);

					async function mapHeaders(tree: ISnapshotTree): Promise<unknown[]> {
						const children = await Promise.all(
							Object.values(tree.trees).map(mapHeaders),
						);
						const header = tree.blobs.header;
						return [
							...children.flat(),
							...(header === undefined
								? []
								: [
										JSON.parse(
											new TextDecoder().decode(await storage.readBlob(header)),
										),
									]),
						];
					}
					expect(await mapHeaders(snapshot)).toContainEqual(
						expect.objectContaining({
							content: expect.objectContaining({
								shared: { type: "Plain", value: "from-first" },
								reply: { type: "Plain", value: "from-second" },
							}),
						}),
					);
				} finally {
					service.dispose();
				}

				second.container.disconnect();
				await expect
					.poll(() => second.container.connectionState)
					.toBe(ConnectionState.Disconnected);
				second.container.connect();
				await expect
					.poll(() => second.container.connectionState)
					.toBe(ConnectionState.Connected);
				second.container.initialObjects.map.set("tail", "after-summary");
				await expect
					.poll(() => first.container.initialObjects.map.get("tail"))
					.toBe("after-summary");
				const tailSequence =
					first.container.container.deltaManager.lastSequenceNumber;
				expect(tailSequence).toBeGreaterThan(summarySequence);
				const tail = (await helpers.deltas(environment.base, id)).filter(
					(op) => Number(op.sequenceNumber) > summarySequence,
				);
				expect(tail.length).toBeGreaterThan(0);
				expect(
					tail.some(
						(op) => op.sequenceNumber === tailSequence && op.type === "op",
					),
				).toBe(true);

				const third = await client("third").getContainer(id);
				try {
					await expect
						.poll(() => third.container.initialObjects.map.get("tail"))
						.toBe("after-summary");
					expect(third.container.initialObjects.map.get("shared")).toBe(
						"from-first",
					);
					expect(third.container.initialObjects.map.get("reply")).toBe(
						"from-second",
					);
					if (!isInternalFluidContainer(third.container)) {
						throw new Error("Expected an internal Fluid container");
					}
					const reloadedQuorum = third.container.container.getQuorum();
					assertProposalQuorum(reloadedQuorum);
					expect(reloadedQuorum.get("tidepool-setting")).toEqual({
						enabled: true,
					});
					expect(
						third.container.container.deltaManager.initialSequenceNumber,
					).toBe(summarySequence);
				} finally {
					third.container.dispose();
				}
			} finally {
				second.container.dispose();
			}
		} finally {
			first.container.dispose();
		}

		await environment.runtime.dispose();
		environment = await helpers.startRuntime(persistencePath, true, r2);
		const { TIDEPOOL } = await environment.runtime.getBindings<{
			TIDEPOOL: ConnectorClient;
		}>();
		expect(await TIDEPOOL.listDocuments({ prefix: id })).toMatchObject({
			ok: true,
			value: { documents: [{ id }], cursor: null },
		});
		const restartedService = await helpers.service(environment.base, id);
		try {
			const storage = await restartedService.connectToStorage();
			const versions = await storage.getVersions(id, 1);
			expect(versions[0]?.id).toBe(summaryHandle);
		} finally {
			restartedService.dispose();
		}

		const restarted = await client("restarted").getContainer(id);
		try {
			await expect
				.poll(() => restarted.container.initialObjects.map.get("tail"))
				.toBe("after-summary");
			expect(restarted.container.initialObjects.map.get("shared")).toBe(
				"from-first",
			);
			expect(restarted.container.initialObjects.map.get("reply")).toBe(
				"from-second",
			);
			if (!isInternalFluidContainer(restarted.container)) {
				throw new Error("Expected an internal Fluid container");
			}
			const restartedQuorum = restarted.container.container.getQuorum();
			assertProposalQuorum(restartedQuorum);
			expect(restartedQuorum.get("tidepool-setting")).toEqual({
				enabled: true,
			});
			expect(
				restarted.container.container.deltaManager.initialSequenceNumber,
			).toBe(summarySequence);
			expect(
				restarted.container.container.deltaManager.lastSequenceNumber,
			).toBeGreaterThan(summarySequence);
		} finally {
			restarted.container.dispose();
		}
	}, 45_000);
});
