// Papers over pi-ai version differences, so the modules that build streams do
// not each have to know which pi-ai they are running against.

import * as piAi from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";

// Compat (#2): use factory if available (pi-ai ≥0.66), else fall back to constructor (gsd-pi etc.)
const _piAi = piAi as any;
export const newAssistantMessageEventStream: () => AssistantMessageEventStream =
	typeof _piAi.createAssistantMessageEventStream === "function"
		? _piAi.createAssistantMessageEventStream
		: () => new _piAi.AssistantMessageEventStream();
