// Taking over pi's two summarization paths: /compact and branch summarization.
//
// Both ask the *agent's* model for a summary, which on a bridge model lands in
// this extension carrying a prompt pi never announced through
// `before_agent_start` — so the prompt-capture resolver has nothing to resolve
// it to. Each therefore runs as its own Claude Code subprocess: no shared
// session, no prompt capture, nothing persisted.

import { query, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { BranchSummaryResult, CompactionEntry } from "@earendil-works/pi-coding-agent";
import { childEnv } from "./cc-child.js";
import { loadConfig } from "./config.js";
import { debug, makeCliDebugOptions } from "./debug.js";
import { errorMessage, resultErrorText } from "./errors.js";
import { claudeCodeModelId } from "./models.js";
import { newAssistantMessageEventStream } from "./pi-ai-compat.js";
import { adaptContext, extractIsolatedSummaryPrompt, newAssistantOutput } from "./pi-context.js";
import { getLongContextSettings, getPiSessionId } from "./runtime-config.js";
import { logServedContextWindow } from "./usage.js";

export function isolatedStreamFn(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	context = adaptContext(context);
	const stream = newAssistantMessageEventStream();
	void runIsolatedSummary(model, context, options, stream);
	return stream;
}

async function runIsolatedSummary(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	let sdkQuery: ReturnType<typeof query> | undefined;
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		void sdkQuery?.interrupt().catch(() => {});
		try { sdkQuery?.close(); } catch {}
	};

	try {
		const promptText = extractIsolatedSummaryPrompt(context.messages);
		const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
		const compactProviderSettings = loadConfig(cwd).provider;
		const claudeExecutable = compactProviderSettings?.pathToClaudeCodeExecutable;
		const cliModel = claudeCodeModelId(model, getLongContextSettings());
		debug(`compact summary: spawn model=${cliModel} registeredModel=${model.id} promptLen=${promptText.length}`);

		sdkQuery = query({
			prompt: promptText,
			options: {
				cwd,
				env: childEnv(process.env, getPiSessionId()),
				settings: { autoMemoryEnabled: false },
				tools: [],
				strictMcpConfig: true,
				settingSources: [] as SettingSource[],
				skills: [],
				persistSession: false,
				systemPrompt: context.systemPrompt,
				model: cliModel,
				maxTurns: 1,
				...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
				...makeCliDebugOptions("compact-summary"),
			},
		});

		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		let assistantText = "";
		let finalText = "";
		let errorText: string | undefined;
		let firstEventLogged = false;

		for await (const message of sdkQuery) {
			if (!firstEventLogged) {
				debug(`compact summary: first event type=${message.type}`);
				firstEventLogged = true;
			}
			if (wasAborted) break;

			if (message.type === "assistant") {
				for (const block of (message as any).message?.content ?? []) {
					if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
				}
			} else if (message.type === "result") {
				logServedContextWindow("compact summary", message, model);
				errorText = resultErrorText(message);
				if (!errorText && message.subtype === "success") finalText = message.result || assistantText;
			}
		}

		if (wasAborted) {
			const output = newAssistantOutput(model, "", "aborted", "Operation aborted");
			debug("compact summary: aborted");
			stream.push({ type: "error", reason: "aborted", error: output });
			stream.end();
			return;
		}

		const text = finalText || assistantText;
		if (errorText || !text.trim()) {
			const msg = errorText ?? "Claude Code summary returned empty text";
			debug(`compact summary: error ${msg}`);
			stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
			stream.end();
			return;
		}

		debug(`compact summary: done textLen=${text.length}`);
		stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, text, "stop") });
		stream.end();
	} catch (err) {
		const msg = errorMessage(err);
		debug("runIsolatedSummary threw; pushing terminal error", err);
		stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
		stream.end();
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		try { sdkQuery?.close(); } catch {}
	}
}

export function reinjectPriorCompactionFileOps(branchEntries: Array<{ type: string; details?: unknown }>, preparation: { fileOps: { read: Set<string>; edited: Set<string> } }): void {
	const prior = [...branchEntries]
		.reverse()
		.find((entry): entry is CompactionEntry => entry.type === "compaction");
	const details = prior?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
	if (!Array.isArray(details?.readFiles) || !Array.isArray(details?.modifiedFiles)) return;
	for (const file of details.readFiles) preparation.fileOps.read.add(String(file));
	for (const file of details.modifiedFiles) preparation.fileOps.edited.add(String(file));
	debug(`compact takeover: re-injected prior file ops read=${details.readFiles.length} modified=${details.modifiedFiles.length}`);
}
/** What pi's branch summary means for the navigation it was asked for.
 *
 *  Cancelling on failure matches pi's own path, which rethrows a summary error out
 *  of the navigation rather than moving without one. Separated from the event
 *  handler so this decision is testable without a Claude Code subprocess — driving
 *  `generateBranchSummary` itself would only be testing pi. */
export function branchSummaryOutcome(result: BranchSummaryResult): { cancel: true } | { summary: { summary: string; details: unknown; usage?: BranchSummaryResult["usage"] } } {
	if (result.aborted) return { cancel: true };
	if (result.error) throw new Error(result.error);
	debug(`session_before_tree: takeover complete summaryLen=${result.summary?.length ?? 0}`);
	return {
		summary: {
			summary: result.summary ?? "",
			details: { readFiles: result.readFiles ?? [], modifiedFiles: result.modifiedFiles ?? [] },
			usage: result.usage,
		},
	};
}
