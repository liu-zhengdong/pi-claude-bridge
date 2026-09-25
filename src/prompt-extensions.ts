// What other extensions added to the system prompt pi assembled.
//
// The bridge forwards the portable parts of pi's assembly from its structured
// options (see prompt-capture.ts). An extension that returns
// `systemPrompt: event.systemPrompt + "\n\n" + text` from before_agent_start
// leaves no trace in those options, only in the rendered string — Pi Notes
// appends the user's default-open notes that way, billion-context-pi its tool
// guide. Pi carries such a return as `forceSystemPrompt`. A child extension can
// also prepend role instructions before the custom prompt that embeds its parent.
// Pi renders its own sections first, `<cwd>` last among them, then any custom
// sections new to its map, joining all of them with a blank line. The custom
// prompt and `<cwd>` delimit the extension text on either side.

export type AssemblyOptions = {
	customPrompt?: string;
	cwd?: string;
	sections?: Record<string, string>;
};

export type ExtensionAdditions = {
	/** Extension text before a fully located custom prompt. */
	before?: string;
	/** Custom sections as pi renders them, then the text appended after pi's assembly. */
	text?: string;
	/** Why part of the prompt could not be accounted for. That part is not forwarded. */
	problem?: string;
};

function renderSection(name: string, content: string): string {
	return `<${name}>\n${content}\n</${name}>`;
}

export function extensionAdditions(prompt: string, options: AssemblyOptions | undefined): ExtensionAdditions {
	if (!options) return {};

	// A custom section named `cwd` replaces pi's content in place.
	const cwd = options.sections?.cwd || options.cwd?.replace(/\\/g, "/");
	if (!cwd) return { problem: "pi's assembly has no cwd section to locate its end by" };
	const cwdSection = renderSection("cwd", cwd);

	// A subagent's custom prompt embeds its parent's whole prompt, `<cwd>` and all.
	// Locate that whole custom prompt even if an extension put text ahead of it;
	// start the cwd search after it, not at the parent's embedded cwd.
	const customPrompt = options.customPrompt || undefined;
	const customAt = customPrompt === undefined ? -1 : prompt.indexOf(customPrompt);
	const before = customAt > 0 ? prompt.slice(0, customAt).trim() : undefined;
	const afterCustom = customPrompt !== undefined && customAt >= 0 ? customAt + customPrompt.length : 0;
	const at = prompt.indexOf(cwdSection, afterCustom);
	if (at === -1) return { problem: "pi's cwd section is missing from the prompt, so an extension rewrote it" };

	// Custom sections new to pi's map follow `<cwd>` in insertion order. One named like
	// a section pi already rendered replaced it in place, above `<cwd>`: pi's to forward
	// or strip, like the rest of its assembly.
	let end = at + cwdSection.length;
	const sections: string[] = [];
	for (const [name, content] of Object.entries(options.sections ?? {})) {
		if (!content || name === "cwd") continue;
		const section = renderSection(name, content);
		if (!prompt.startsWith(`\n\n${section}`, end)) continue;
		sections.push(section);
		end += 2 + section.length;
	}

	const text = [...sections, prompt.slice(end).trim()].filter(Boolean).join("\n\n");
	return {
		...(before ? { before } : {}),
		...(text ? { text } : {}),
		...(customPrompt !== undefined && customAt === -1
			? { problem: "an extension put text ahead of pi's assembly" }
			: {}),
	};
}
