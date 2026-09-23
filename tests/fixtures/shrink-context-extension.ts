// Test extension: compacts through the `context` hook the way ACP
// (billion-context-pi) does — pi's own history comes back shorter, and no
// session_compact is emitted.
//
// Off until the file named by SHRINK_CONTEXT_FLAG exists; from then on every
// request drops the first user/assistant exchange.
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("context", (event) => {
		const flag = process.env.SHRINK_CONTEXT_FLAG;
		if (!flag || !existsSync(flag)) return;
		return { messages: event.messages.slice(2) };
	});
}
