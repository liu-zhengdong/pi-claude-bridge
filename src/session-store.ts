// 共享会话状态的所有者。
//
// bridge 在 Claude Code 那边维护一份会话文件，让它镜像 pi 的历史。这份镜像的
// 当前状态（会话 id、已同步到第几条消息、是否需要重建）以前散在 index.ts 里，
// 十几处直接赋值，改一处要先找遍全文。状态收在这里，对外只留下面这几个命名操作。
//
// 另一份状态是「工具结果最后一次交付时的消息数」。它与会话记录分开存，因为查询
// 结束时会整体替换会话对象（`sharedSession = { sessionId, cursor, cwd }`），挂在
// 上面会被一起丢掉。

export interface SessionState {
	sessionId: string;
	cursor: number;
	cwd: string;
	/** Identity of each pi message already reflected in the Claude Code session.
	 *  The cursor alone cannot detect a same-length replacement or reorder. */
	history?: readonly string[];
	// Force the next syncSharedSession call down the REBUILD path. Set when
	// pi has mutated its messages array out from under us (compact, tree
	// navigation) or after an abort left the JSONL in an indeterminate state.
	// REBUILD wipes and rewrites the file to match pi's current history.
	needsRebuild?: boolean;
	// Set ONLY after an abort. The killed CC subprocess may still be flushing
	// a late "[Request interrupted by user]" record to the session JSONL.
	// Reusing the same sessionId/path would race that orphan write into our
	// fresh file and break CC's parent-uuid chain on the next resume. When
	// this flag is set, REBUILD takes a fresh UUID and skips deleteSession
	// so the orphan writes land on a dead inode. Compact/tree do NOT set
	// this — there's no concurrent CC writer during those events, so
	// in-place rebuild (preserve UUID, deleteSession + createSession) is safe.
	forceRotate?: boolean;
}

let sharedSession: SessionState | null = null;

// Message count at which tool results were last handed to a live top-level query.
//
// Pi's auto-retry re-issues the *same* context after a provider error, so a tool
// result we already delivered comes back with an identical message count. That is
// a turn to resume, not a fresh orphan to end — see orphanedToolResultAction.
let deliveredToolResultCursor = 0;

export function getSharedSession(): SessionState | null {
	return sharedSession;
}

export function setSharedSession(state: SessionState | null): void {
	sharedSession = state;
}

export function clearSharedSession(): void {
	sharedSession = null;
}

/** Take a freshly created or resumed Claude Code session as the shared one. */
export function adoptSession(sessionId: string, cursor: number, cwd: string, history: readonly string[]): void {
	sharedSession = { sessionId, cursor, cwd, history };
}

/** Move the cursor on the existing record, in place. */
export function setCursor(cursor: number, history: readonly string[]): void {
	if (sharedSession) {
		sharedSession.cursor = cursor;
		sharedSession.history = history;
	}
}

/** Replace the record with an advanced cursor and cwd — the REUSE path, where
 *  the session is kept but the conversation has moved on. */
export function advanceCursor(cursor: number, cwd: string, history: readonly string[]): void {
	if (sharedSession) sharedSession = { ...sharedSession, cursor, cwd, history };
}

/** Send the next sync down the REBUILD path. `forceRotate` additionally takes a
 *  fresh UUID, which is only correct after an abort — see SessionState. */
export function markNeedsRebuild(options?: { forceRotate?: boolean }): void {
	if (!sharedSession) return;
	sharedSession = {
		...sharedSession,
		needsRebuild: true,
		...(options?.forceRotate ? { forceRotate: true } : {}),
	};
}

/** Record that this context's tool results reached a live top-level query. */
export function recordToolResultDelivery(messageCount: number): void {
	deliveredToolResultCursor = messageCount;
}

export function getDeliveredToolResultCursor(): number {
	return deliveredToolResultCursor;
}

/**
 * What to do with a context whose last message is a tool result that no live
 * query owns. Two different situations arrive in exactly the same shape:
 *
 *  - "end-turn": pi aborted a tool call and delivered the result anyway. The turn
 *    is over, so emit an empty end_turn and wait for the next real user message.
 *  - "resume": pi is retrying a turn whose query we killed (auto-retry after a
 *    provider error, e.g. a stalled stream). The result was already delivered
 *    once and the model still owes a response, so rebuild and continue.
 *
 * Message count tells them apart. A retry carries the exact context we last
 * delivered results for; a fresh orphan has grown since then by at least the
 * assistant tool call and its result. A zero cursor means we have delivered
 * nothing yet, so it can never be a retry.
 *
 * Kept pure (the cursor is a parameter, not a read) so every combination can be
 * tested without touching module state — see tests/unit-orphaned-tool-result.mjs.
 */
export function orphanedToolResultAction(messageCount: number, deliveredCursor: number): "end-turn" | "resume" {
	return deliveredCursor > 0 && deliveredCursor === messageCount ? "resume" : "end-turn";
}
