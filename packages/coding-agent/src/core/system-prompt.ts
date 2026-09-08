/**
 * 系统提示词构建与项目上下文加载。
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** 自定义系统提示词（替换默认内容）。 */
	customPrompt?: string;
	/** 提示词中包含的工具，默认值：[read, bash, edit, write] */
	selectedTools?: string[];
	/** 以工具名称为键的可选单行工具摘要。 */
	toolSnippets?: Record<string, string>;
	/** 追加到默认系统提示词准则中的其他准则项。 */
	promptGuidelines?: string[];
	/** 追加到系统提示词的文本。 */
	appendSystemPrompt?: string;
	/** 工作目录。 */
	cwd: string;
	/** 预加载的上下文文件。 */
	contextFiles?: Array<{ path: string; content: string }>;
	/** 预加载的 skill。 */
	skills?: Skill[];
}

/**
 * 根据当前活动的运行时资源构建系统提示词。
 *
 * 自定义提示词仅替换内置基础文本；追加的提示词文本、项目上下文文件、
 * 可读取的 skill 和当前工作目录仍会随后加入。没有自定义提示词时，
 * 工具摘要决定可见工具列表，活动工具则提供各自的提示词准则。
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const skillFileReadTool = (["read", "bash"] as const).find((tool) => tools.includes(tool));

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// 追加项目上下文文件
		if (contextFiles.length > 0) {
			prompt += "\n\n<project_context>\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
			}
			prompt += "</project_context>\n";
		}

		// 存在能够读取 skill 文件的工具时追加 skill。
		if (skillFileReadTool && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills, skillFileReadTool);
		}

		prompt += `\nCurrent working directory: ${promptCwd}\n`;

		return prompt;
	}

	// 获取文档和示例的绝对路径
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// 根据选中的工具构建工具列表。
	// 仅当调用方提供单行摘要时，工具才会出现在 Available tools 中。
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// 根据实际可用的工具构建准则
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasPowerShell = tools.includes("powershell");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");

	// 文件探索准则
	if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
		if (hasBash && hasPowerShell) {
			addGuideline("Use bash or PowerShell for file operations like listing, searching, and finding files");
		} else if (hasPowerShell) {
			addGuideline("Use PowerShell for file operations like listing, searching, and finding files");
		} else {
			addGuideline("Use bash for file operations like ls, rg, find");
		}
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// 始终包含以下准则
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// 追加项目上下文文件
	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	// 存在能够读取 skill 文件的工具时追加 skill。
	if (skillFileReadTool && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills, skillFileReadTool);
	}

	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
