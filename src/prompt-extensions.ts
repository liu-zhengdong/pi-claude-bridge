// What other extensions added to the system prompt pi assembled.
//
// The bridge forwards the portable parts of pi's assembly from its structured
// options (see prompt-capture.ts). An extension that returns
// `systemPrompt: event.systemPrompt + "\n\n" + text` from before_agent_start
// leaves no trace in those options, only in the rendered string — Pi Notes
// appends the user's default-open notes that way, billion-context-pi its tool
// guide. Pi renders its own sections first, `<cwd>` last among them, then any
// custom sections new to its map, joining all of them with a blank line. So
// whatever follows is the extensions'.

export type AssemblyOptions = {
	customPrompt?: string;
	forceSystemPrompt?: string;
	cwd?: string;
	sections?: Record<string, string>;
};

export type ExtensionAdditions = {
	/** Custom sections as pi renders them, then the text appended after pi's assembly. */
	text?: string;
	/** Why part of the prompt could not be accounted for. That part is not forwarded. */
	problem?: string;
};

function renderSection(name: string, content: string): string {
	return `<${name}>\n${content}\n</${name}>`;
}

export function extensionAdditions(prompt: string, options: AssemblyOptions | undefined): ExtensionAdditions {
	// A forced prompt is opaque: pi renders no sections, so there is nothing to anchor on.
	if (!options || options.forceSystemPrompt !== undefined) return {};

	// A custom section named `cwd` replaces pi's content in place.
	const cwd = options.sections?.cwd || options.cwd?.replace(/\\/g, "/");
	if (!cwd) return { problem: "pi's assembly has no cwd section to locate its end by" };
	const cwdSection = renderSection("cwd", cwd);

	// A subagent's custom prompt embeds its parent's whole prompt, `<cwd>` and all, so
	// the search starts after it.
	const customPrompt = options.customPrompt || undefined;
	const startsWithCustom = customPrompt !== undefined && prompt.startsWith(customPrompt);
	const at = prompt.indexOf(cwdSection, startsWithCustom ? customPrompt.length : 0);
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
		...(text ? { text } : {}),
		...(customPrompt !== undefined && !startsWithCustom
			? { problem: "an extension put text ahead of pi's assembly" }
			: {}),
	};
}
