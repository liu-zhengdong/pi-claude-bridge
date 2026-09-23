// 当前用户轮次里的 user 消息，哪些是用户自己发的。
//
// pi 交给 provider 的消息里有三种都是 role "user"：用户输入（提示和运行中插话）；
// 扩展用 pi.sendMessage 发的自定义消息，convertToLlm 把 custom 转成 user；
// context 钩子在单次请求里塞进列表的消息，比如 billion-context-pi 的压缩提醒。
// 只有第一种以 role "user" 触发 message_end；自定义消息以 role "custom" 触发，
// 钩子插入的消息根本不触发。timestamp 经过转换、也经过改写内容的钩子（ACP 会追加
// <acp> 标签）都保留，所以用它认消息。
//
// 用户发的照旧当用户消息；其余的包成标明来源的 system-reminder，
// 免得 Claude Code 把它们说成「用户在你工作时发来的新消息」。

import type { Context, ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { messageContentToText } from "./convert.js";
import { turnStart } from "./pi-context.js";

type Message = Context["messages"][number];

export type MessageOrigin = { from: "user" } | { from: "extension"; name?: string };

/** 会以 role "user" 交给模型、且出自用户操作的 pi 消息：输入的文字，以及 `!命令` 的输出。 */
const USER_ROLES = new Set(["user", "bashExecution"]);

export function createOriginTracker(limit = 4096) {
	const origins = new Map<number, MessageOrigin>();
	return {
		/** 来自 message_end，以及 session_start 时分支末尾已有的消息。 */
		observe(message: { role: string; timestamp?: number; customType?: string }): void {
			if (typeof message.timestamp !== "number") return;
			if (USER_ROLES.has(message.role)) origins.set(message.timestamp, { from: "user" });
			else if (message.role === "custom") origins.set(message.timestamp, { from: "extension", name: message.customType });
			else return;
			// Map 按插入顺序迭代，超出上限时丢最早的。
			for (const key of origins.keys()) {
				if (origins.size <= limit) break;
				origins.delete(key);
			}
		},
		/** 没见过的消息不是 pi 经手的用户输入：钩子插入的，或 pi 从会话重建的摘要。 */
		origin(message: { timestamp?: number }): MessageOrigin {
			return (typeof message.timestamp === "number" ? origins.get(message.timestamp) : undefined) ?? { from: "extension" };
		},
	};
}

export type OriginTracker = ReturnType<typeof createOriginTracker>;

/** 全进程共用：进程内的子 Agent 共享这个模块，timestamp 跨会话也不会撞。 */
export const messageOrigins = createOriginTracker();

/** 分支末尾那段 user 类消息，是恢复会话后可能还没回应的输入；它们不会再触发 message_end。 */
export function observeBranchTail(tracker: OriginTracker, messages: readonly { role: string; timestamp?: number; customType?: string }[]): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		const { role } = messages[i];
		if (!USER_ROLES.has(role) && role !== "custom") break;
		tracker.observe(messages[i]);
	}
}

export function extensionNote(text: string, name?: string): string {
	const source = name ? `Added by pi (extension message "${name}")` : "Added by pi or one of its extensions";
	return `<system-reminder>\n${source}, not typed by the user:\n${text}\n</system-reminder>`;
}

function textOf(message: Message): string {
	return typeof message.content === "string" ? message.content : messageContentToText(message.content as (TextContent | ImageContent)[]);
}

/** 当前用户轮次按来源拆开：用户发的留作插话，其余的变成附注文本。 */
export function splitUserTurn(messages: Context["messages"], tracker: OriginTracker): { fromUser: Context["messages"]; notes: string[] } {
	const fromUser: Context["messages"] = [];
	const notes: string[] = [];
	for (const message of messages.slice(turnStart(messages))) {
		const origin = tracker.origin(message);
		if (origin.from === "user") fromUser.push(message);
		else notes.push(extensionNote(textOf(message), origin.name));
	}
	return { fromUser, notes };
}

/** 同一批消息，但当前用户轮次里不是用户发的那些换成带标注的文本，图片照留。 */
export function labelUserTurn(messages: Context["messages"], tracker: OriginTracker): Context["messages"] {
	const start = turnStart(messages);
	return messages.map((message, i) => {
		if (i < start) return message;
		const origin = tracker.origin(message);
		if (origin.from === "user") return message;
		// turnStart ends the turn at the last non-user message, so these are all user messages.
		const { content } = message as UserMessage;
		const images = Array.isArray(content) ? content.filter((block): block is ImageContent => block.type === "image") : [];
		return { ...message, content: [{ type: "text", text: extensionNote(textOf(message), origin.name) }, ...images] } as Message;
	});
}
