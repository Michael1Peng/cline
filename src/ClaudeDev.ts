import { Anthropic } from "@anthropic-ai/sdk"
import defaultShell from "default-shell"
import * as diff from "diff"
import { execa } from "execa"
import fs from "fs/promises"
import { globby } from "globby"
import osName from "os-name"
import * as path from "path"
import { serializeError } from "serialize-error"
import { DEFAULT_MAX_REQUESTS_PER_TASK } from "./shared/Constants"
import { Tool, ToolName } from "./shared/Tool"
import { ClaudeAsk, ClaudeSay, ClaudeSayTool } from "./shared/ExtensionMessage"
import * as vscode from "vscode"
import pWaitFor from "p-wait-for"
import { ClaudeAskResponse } from "./shared/WebviewMessage"
import { ClaudeDevProvider } from "./providers/ClaudeDevProvider"
import { ClaudeRequestResult } from "./shared/ClaudeRequestResult"
import os from "os"
import { analyzeProject } from "./analyze-project"

const SYSTEM_PROMPT = `You are Claude Dev, a highly skilled software developer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.

====
 
CAPABILITIES

- You can read and analyze code in various programming languages, and can write clean, efficient, and well-documented code.
- You can debug complex issues and providing detailed explanations, offering architectural insights and design patterns.
- You have access to tools that let you analyze software projects, execute CLI commands on the user's computer, list files in a directory, read and write files, and ask follow-up questions. These tools help you effectively accomplish a wide range of tasks, such as writing code, making edits or improvements to existing files, understanding the current state of a project, performing system operations, and much more.
    - For example, when asked to make edits or improvements you might use the analyze_project and read_file tools to examine the contents of relevant files, analyze the code and suggest improvements or make necessary edits, then use the write_to_file tool to implement changes.
- You can use the analyze_project tool to get a comprehensive view of a software project's file structure and important syntactic nodes such as functions, classes, and methods. This can be particularly useful when you need to understand the broader context and relationships between different parts of the code, as well as the overall organization of files and directories.
- The execute_command tool lets you run commands on the user's computer and should be used whenever you feel it can help accomplish the user's task. When you need to execute a CLI command, you must provide a clear explanation of what the command does. Prefer to execute complex CLI commands over creating executable scripts, since they are more flexible and easier to run.

====

RULES

- Unless otherwise specified by the user, you MUST accomplish your task within the following directory: ${vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0) ?? path.join(os.homedir(), "Desktop")
	}
- Your current working directory is '${process.cwd()}', and you cannot \`cd\` into a different directory to complete a task. You are stuck operating from '${process.cwd()}', so be sure to pass in the appropriate 'path' parameter when using tools that require a path.
- If you do not know the contents of an existing file you need to edit, use the read_file tool to help you make informed changes. However if you have seen this file before, you should be able to remember its contents.
- When editing files, always provide the complete file content in your response, regardless of the extent of changes. The system handles diff generation automatically.
- Before using the execute_command tool, you must first think about the System Information context provided by the user to understand their environment and tailor your commands to ensure they are compatible with the user's system.
- When using the execute_command tool, avoid running servers or executing commands that don't terminate on their own (e.g. Flask web servers, continuous scripts). If a task requires such a process or server, explain in your task completion result why you can't execute it directly and provide clear instructions on how the user can run it themselves.
- Try not to use the analyze_project tool more than once since you can refer back to it along with any changes you made to get an adequate understanding of the project. But don't be hesitant to use it in the first place when you know you will be doing a coding task on an existing project. Prefer to use analyze_project over list_files, unless you think list_files is more appropriate for the job i.e. when viewing files on the Desktop.
- When creating a new project (such as an app, website, or any software project), unless the user specifies otherwise, organize all new files within a dedicated project directory. Use appropriate file paths when writing files, as the write_to_file tool will automatically create any necessary directories. Structure the project logically, adhering to best practices for the specific type of project being created. Unless otherwise specified, new projects should be easily run without additional setup, for example most projects can be built in HTML, CSS, and JavaScript - which you can open in a browser.
- You must try to use multiple tools in one request when possible. For example if you were to create a website, you would use the write_to_file tool to create the necessary files with their appropriate contents all at once. Or if you wanted to analyze a project, you could use the read_file tool multiple times to look at several key files. This will help you accomplish the user's task more efficiently.
- Be sure to consider the type of project (e.g. Python, JavaScript, web application) when determining the appropriate structure and files to include. Also consider what files may be most relevant to accomplishing the task, for example looking at a project's manifest file would help you understand the project's dependencies, which you could incorporate into any code you write.
- When making changes to code, always consider the context in which the code is being used. Ensure that your changes are compatible with the existing codebase and that they follow the project's coding standards and best practices.
- Do not ask for more information than necessary. Use the tools provided to accomplish the user's request efficiently and effectively. When you've completed your task, you must use the attempt_completion tool to present the result to the user. The user may provide feedback, which you can use to make improvements and try again.
- You are only allowed to ask the user questions using the ask_followup_question tool. Use this tool only when you need additional details to complete a task, and be sure to use a clear and concise question that will help you move forward with the task.
- Your goal is to try to accomplish the user's task, NOT engage in a back and forth conversation.
- NEVER end completion_attempt with a question or request to engage in further conversation! Formulate the end of your result in a way that is final and does not require further input from the user. 
- NEVER start your responses with affirmations like "Certaintly", "Okay", "Sure", "Great", etc. You should NOT be conversational in your responses, but rather direct and to the point.
- Feel free to use markdown as much as you'd like in your responses. When using code blocks, always include a language specifier.

====

OBJECTIVE

You accomplish a given task iteratively, breaking it down into clear steps and working through them methodically.

1. Analyze the user's task and set clear, achievable goals to accomplish it. Prioritize these goals in a logical order.
2. Work through these goals sequentially, utilizing available tools as necessary. Each goal should correspond to a distinct step in your problem-solving process.
3. Remember, you have extensive capabilities with access to a wide range of tools that can be used in powerful and clever ways as necessary to accomplish each goal. Before calling a tool, do some analysis within <thinking></thinking> tags. First, think about which of the provided tools is the relevant tool to answer the user's request. Second, go through each of the required parameters of the relevant tool and determine if the user has directly provided or given enough information to infer a value. When deciding if the parameter can be inferred, carefully consider all the context to see if it supports a specific value. If all of the required parameters are present or can be reasonably inferred, close the thinking tag and proceed with the tool call. BUT, if one of the values for a required parameter is missing, DO NOT invoke the function (not even with fillers for the missing params) and instead, ask the user to provide the missing parameters using the ask_followup_question tool. DO NOT ask for more information on optional parameters if it is not provided.
4. Once you've completed the user's task, you must use the attempt_completion tool to present the result of the task to the user. You may also provide a CLI command to showcase the result of your task; this can be particularly useful for web development tasks, where you can run e.g. \`open index.html\` to show the website you've built. Avoid commands that run indefinitely (like servers). Instead, if such a command is needed, include instructions for the user to run it in the 'result' parameter.
5. The user may provide feedback, which you can use to make improvements and try again. But DO NOT continue in pointless back and forth conversations, i.e. don't end your responses with questions or offers for further assistance.

====

SYSTEM INFORMATION

Operating System: ${osName()}
Default Shell: ${defaultShell}
`

const tools: Tool[] = [
	{
		name: "execute_command",
		description:
			"Execute a CLI command on the system. Use this when you need to perform system operations or run specific commands to accomplish any step in the user's task. You must tailor your command to the user's system and provide a clear explanation of what the command does. Do not run servers or commands that don't terminate on their own. Prefer to execute complex CLI commands over creating executable scripts, as they are more flexible and easier to run.",
		input_schema: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description:
						"The CLI command to execute. This should be valid for the current operating system. Ensure the command is properly formatted and does not contain any harmful instructions. Avoid commands that run indefinitely (like servers) that don't terminate on their own.",
				},
			},
			required: ["command"],
		},
	},
	{
		name: "analyze_project",
		description:
			"Analyze the project structure by listing file paths and parsing supported source code to extract their key elements. This tool provides insights into the codebase structure, focusing on important code constructs like functions, classes, and methods. This also helps to understand the contents and structure of a directory by examining file names and extensions. All this information can guide decision-making on which files to process or explore further.",
		input_schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"The path of the directory to analyze. The tool will recursively scan this directory, list all file paths, and parse supported source code files.",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "list_files",
		description:
			"List all files and directories at the top level of the specified directory. This should only be used for generic directories you don't necessarily need the nested structure of, like the Desktop. If you think you need the nested structure of a directory, use the analyze_project tool instead.",
		input_schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "The path of the directory to list contents for.",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "read_file",
		description:
			"Read the contents of a file at the specified path. Use this when you need to examine the contents of an existing file, for example to analyze code, review text files, or extract information from configuration files. Be aware that this tool may not be suitable for very large files or binary files, as it returns the raw content as a string.",
		input_schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "The path of the file to read.",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "write_to_file",
		description:
			"Write content to a file at the specified path. If the file exists, only the necessary changes will be applied. If the file doesn't exist, it will be created. Always provide the full intended content of the file. This tool will automatically create any directories needed to write the file.",
		input_schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "The path of the file to write to.",
				},
				content: {
					type: "string",
					description: "The full content to write to the file",
				},
			},
			required: ["path", "content"],
		},
	},
	{
		name: "ask_followup_question",
		description:
			"Ask the user a question to gather additional information needed to complete the task. This tool should be used when you encounter ambiguities, need clarification, or require more details to proceed effectively. It allows for interactive problem-solving by enabling direct communication with the user. Use this tool judiciously to maintain a balance between gathering necessary information and avoiding excessive back-and-forth.",
		input_schema: {
			type: "object",
			properties: {
				question: {
					type: "string",
					description:
						"The question to ask the user. This should be a clear, specific question that addresses the information you need.",
				},
			},
			required: ["question"],
		},
	},
	{
		name: "attempt_completion",
		description:
			"Once you've completed the task, use this tool to present the result to the user. They may respond with feedback if they are not satisfied with the result, which you can use to make improvements and try again.",
		input_schema: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description:
						"The CLI command to execute to show a live demo of the result to the user. For example, use 'open -a \"Google Chrome\" index.html' to display a created website. Avoid commands that run indefinitely (like servers) that don't terminate on their own. Instead, if such a command is needed, include instructions for the user to run it in the 'result' parameter.",
				},
				result: {
					type: "string",
					description:
						"The result of the task. Formulate this result in a way that is final and does not require further input from the user. Don't end your result with questions or offers for further assistance.",
				},
			},
			required: ["result"],
		},
	},
]

export class ClaudeDev {
	private client: Anthropic
	private maxRequestsPerTask: number
	private requestCount = 0
	private askResponse?: ClaudeAskResponse
	private askResponseText?: string
	private providerRef: WeakRef<ClaudeDevProvider>
	abort: boolean = false

	constructor(provider: ClaudeDevProvider, task: string, apiKey: string, maxRequestsPerTask?: number) {
		console.log(`[ClaudeDev:constructor] Called with task: "${task}", API key: ${apiKey ? 'provided' : 'missing'}, Max requests: ${maxRequestsPerTask ?? DEFAULT_MAX_REQUESTS_PER_TASK}`);
		console.log(`[ClaudeDev:constructor] Provider ref: ${provider ? 'valid' : 'invalid'}`);
		this.providerRef = new WeakRef(provider)
		this.client = new Anthropic({ apiKey })
		this.maxRequestsPerTask = maxRequestsPerTask ?? DEFAULT_MAX_REQUESTS_PER_TASK

		this.startTask(task)
	}

	updateApiKey(apiKey: string) {
		this.client = new Anthropic({ apiKey })
	}

	updateMaxRequestsPerTask(maxRequestsPerTask: number | undefined) {
		this.maxRequestsPerTask = maxRequestsPerTask ?? DEFAULT_MAX_REQUESTS_PER_TASK
	}

	async handleWebviewAskResponse(askResponse: ClaudeAskResponse, text?: string) {
		console.log(`[ClaudeDev] handleWebviewAskResponse called. Response: ${askResponse}, Text: ${text ? 'Yes' : 'No'}`);
		this.askResponse = askResponse
		this.askResponseText = text
	}

	async ask(type: ClaudeAsk, question: string): Promise<{ response: ClaudeAskResponse; text?: string }> {
		console.log(`[ClaudeDev] ask called. Type: ${type}, Question: "${question}"`);
		// If this ClaudeDev instance was aborted by the provider, then the only thing keeping us alive is a promise still running in the background, in which case we don't want to send its result to the webview as it is attached to a new instance of ClaudeDev now. So we can safely ignore the result of any active promises, and this class will be deallocated. (Although we set claudeDev = undefined in provider, that simply removes the reference to this instance, but the instance is still alive until this promise resolves or rejects.)
		if (this.abort) {
			console.warn('[ClaudeDev] ask: Instance aborted, throwing error.');
			throw new Error("ClaudeDev instance aborted")
		}
		this.askResponse = undefined
		this.askResponseText = undefined
		await this.providerRef.deref()?.addClaudeMessage({ ts: Date.now(), type: "ask", ask: type, text: question })
		await this.providerRef.deref()?.postStateToWebview()
		console.log('[debug] [ClaudeDev] ask: Waiting for user response...');
		await pWaitFor(() => this.askResponse !== undefined, { interval: 100 })
const result = { response: this.askResponse!, text: this.askResponseText }
		console.log('[debug] [ClaudeDev] ask: Received user response:', JSON.stringify(result));
		this.askResponse = undefined
		this.askResponseText = undefined
		return result
	}

	async say(type: ClaudeSay, text?: string): Promise<undefined> {
		console.log(`[ClaudeDev] say called. Type: ${type}, Text provided: ${!!text}`);
		if (this.abort) {
			console.warn('[ClaudeDev] say: Instance aborted, throwing error.');
			throw new Error("ClaudeDev instance aborted")
		}
		await this.providerRef.deref()?.addClaudeMessage({ ts: Date.now(), type: "say", say: type, text: text })
		await this.providerRef.deref()?.postStateToWebview()
	}

	private async startTask(task: string): Promise<void> {
		console.log(`[ClaudeDev] startTask called. Task: "${task}"`);
		  console.log('[debug] [ClaudeDev:startTask] Initializing task state');
		// conversationHistory (for API) and claudeMessages (for webview) need to be in sync
		// if the extension process were killed, then on restart the claudeMessages might not be empty, so we need to set it to [] when we create a new ClaudeDev client (otherwise webview would show stale messages from previous session)
		const provider = this.providerRef.deref();
		  console.log(`[ClaudeDev:startTask] Provider available: ${provider ? 'yes' : 'no'}`);
		await provider?.setClaudeMessages(undefined)
		await this.providerRef.deref()?.postStateToWebview()

		// This first message kicks off a task, it is not included in every subsequent message.
		let userPrompt = `Task: \"${task}\"`

		// TODO: create tools that let Claude interact with VSCode (e.g. open a file, list open files, etc.)
		//const openFiles = vscode.window.visibleTextEditors?.map((editor) => editor.document.uri.fsPath).join("\n")

		await this.say("text", task)

		  console.log('[debug] [ClaudeDev:startTask] Starting main request loop');
		let totalInputTokens = 0
		let totalOutputTokens = 0
		  console.log(`[ClaudeDev:startTask] Initial token counters - Input: ${totalInputTokens}, Output: ${totalOutputTokens}`);

		while (this.requestCount < this.maxRequestsPerTask) {
			   console.log(`[ClaudeDev:startTask] Making request ${this.requestCount + 1}/${this.maxRequestsPerTask}`);
			const { didEndLoop, inputTokens, outputTokens } = await this.recursivelyMakeClaudeRequests([
				{ type: "text", text: userPrompt },
			])
			totalInputTokens += inputTokens
			totalOutputTokens += outputTokens

			//  The way this agentic loop works is that claude will be given a task that he then calls tools to complete. unless there's an attempt_completion call, we keep responding back to him with his tool's responses until he either attempt_completion or does not use anymore tools. If he does not use anymore tools, we ask him to consider if he's completed the task and then call attempt_completion, otherwise proceed with completing the task.
			// There is a MAX_REQUESTS_PER_TASK limit to prevent infinite requests, but Claude is prompted to finish the task as efficiently as he can.

			//const totalCost = this.calculateApiCost(totalInputTokens, totalOutputTokens)
			if (didEndLoop) {
				//this.say("task_completed", `Task completed. Total API usage cost: ${totalCost}`)
				break
			} else {
				// this.say(
				// 	"tool",
				// 	"Claude responded with only text blocks but has not called attempt_completion yet. Forcing him to continue with task..."
				// )
				userPrompt =
					"Ask yourself if you have completed the user's task. If you have, use the attempt_completion tool, otherwise proceed to the next step. (This is an automated message, so do not respond to it conversationally. Just proceed with the task.)"
			}
		}
	}

	async executeTool(toolName: ToolName, toolInput: any): Promise<string> {
		console.log(`[ClaudeDev] executeTool called. Tool: ${toolName}, Input:`, toolInput);
		switch (toolName) {
			case "write_to_file":
				return this.writeToFile(toolInput.path, toolInput.content)
			case "read_file":
				return this.readFile(toolInput.path)
			case "analyze_project":
				return this.analyzeProject(toolInput.path)
			case "list_files":
				return this.listFiles(toolInput.path)
			case "execute_command":
				return this.executeCommand(toolInput.command)
			case "ask_followup_question":
				return this.askFollowupQuestion(toolInput.question)
			case "attempt_completion":
				return this.attemptCompletion(toolInput.result, toolInput.command)
			default:
				return `Unknown tool: ${toolName}`
		}
	}

	// Calculates cost of a Claude 3.5 Sonnet API request
	calculateApiCost(inputTokens: number, outputTokens: number): number {
		const INPUT_COST_PER_MILLION = 3.0 // $3 per million input tokens
		const OUTPUT_COST_PER_MILLION = 15.0 // $15 per million output tokens
		const inputCost = (inputTokens / 1_000_000) * INPUT_COST_PER_MILLION
		const outputCost = (outputTokens / 1_000_000) * OUTPUT_COST_PER_MILLION
		const totalCost = inputCost + outputCost
		return totalCost
	}

	async writeToFile(filePath: string, newContent: string): Promise<string> {
		console.log(`[ClaudeDev] writeToFile called. Path: ${filePath}, Content length: ${newContent.length}`);
		try {
			const fileExists = await fs
				.access(filePath)
				.then(() => true)
				.catch(() => false)
			if (fileExists) {
				const originalContent = await fs.readFile(filePath, "utf-8")
				// condensed patch to return to claude
				const diffResult = diff.createPatch(filePath, originalContent, newContent)
				// full diff representation for webview
				const diffRepresentation = diff
					.diffLines(originalContent, newContent)
					.map((part) => {
						const prefix = part.added ? "+" : part.removed ? "-" : " "
						return (part.value || "")
							.split("\n")
							.map((line) => (line ? prefix + line : ""))
							.join("\n")
					})
					.join("")

				const { response, text } = await this.ask(
				"tool",
					JSON.stringify({
						tool: "editedExistingFile",
						path: filePath,
						diff: diffRepresentation,
					} as ClaudeSayTool)
				)
				console.log(`[ClaudeDev] writeToFile: User confirmation response: ${response}`);
				if (response !== "yesButtonTapped") {
					if (response === "textResponse" && text) {
						await this.say("user_feedback", text)
						return `The user denied this operation and provided the following feedback:\n\"${text}\"`
					}
					return "The user denied this operation."
				}

				await fs.writeFile(filePath, newContent)
				console.log('[debug] [ClaudeDev] writeToFile: Edit applied successfully.');
				return `Changes applied to ${filePath}:\n${diffResult}`
			} else {
				const { response, text } = await this.ask(
					"tool",
					JSON.stringify({ tool: "newFileCreated", path: filePath, content: newContent } as ClaudeSayTool)
				)
				if (response !== "yesButtonTapped") {
					if (response === "textResponse" && text) {
						await this.say("user_feedback", text)
						return `The user denied this operation and provided the following feedback:\n\"${text}\"`
					}
					return "The user denied this operation."
				}
				await fs.mkdir(path.dirname(filePath), { recursive: true })
				await fs.writeFile(filePath, newContent)
				console.log('[debug] [ClaudeDev] writeToFile: New file created successfully.');
				return `New file created and content written to ${filePath}`
			}
		} catch (error) {
			console.error('[ClaudeDev] writeToFile Error:', error);
			const errorString = `Error writing file: ${JSON.stringify(serializeError(error))}`
			this.say("error", `Error writing file:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`)
			return errorString
		}
	}

	async readFile(filePath: string): Promise<string> {
		console.log(`[ClaudeDev] readFile called. Path: ${filePath}`);
		try {
			const content = await fs.readFile(filePath, "utf-8")
			   console.log('[debug] [ClaudeDev] readFile: Asking user confirmation.');
			const { response, text } = await this.ask(
				"tool",
				JSON.stringify({ tool: "readFile", path: filePath, content } as ClaudeSayTool)
			)
			console.log(`[ClaudeDev] readFile: User confirmation response: ${response}`);
			if (response !== "yesButtonTapped") {
				if (response === "textResponse" && text) {
					await this.say("user_feedback", text)
					return `The user denied this operation and provided the following feedback:\n\"${text}\"`
				}
				return "The user denied this operation."
			}
			console.log('[debug] [ClaudeDev] readFile: Read successful.');
			return content
		} catch (error) {
			console.error('[ClaudeDev] readFile Error:', error);
			const errorString = `Error reading file: ${JSON.stringify(serializeError(error))}`
			this.say("error", `Error reading file:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`)
			return errorString
		}
	}

	async analyzeProject(dirPath: string): Promise<string> {
		console.log(`[ClaudeDev] analyzeProject called. Path: ${dirPath}`);
		try {
			const analysis = await analyzeProject(dirPath)
			   console.log('[debug] [ClaudeDev] analyzeProject: Asking user confirmation.');
			const { response, text } = await this.ask(
				"tool",
				JSON.stringify({ tool: "analyzeProject", path: dirPath, content: analysis } as ClaudeSayTool)
			)
			console.log(`[ClaudeDev] analyzeProject: User confirmation response: ${response}`);
			if (response !== "yesButtonTapped") {
				if (response === "textResponse" && text) {
					await this.say("user_feedback", text)
					return `The user denied this operation and provided the following feedback:\n\"${text}\"`
				}
				return "The user denied this operation."
			}
			console.log('[debug] [ClaudeDev] analyzeProject: Analysis successful.');
			return analysis
		} catch (error) {
			console.error('[ClaudeDev] analyzeProject Error:', error);
			const errorString = `Error analyzing project: ${JSON.stringify(serializeError(error))}`
			this.say(
				"error",
				`Error analyzing project:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`
			)
			return errorString
		}
	}

	async listFiles(dirPath: string): Promise<string> {
		console.log(`[ClaudeDev] listFiles called. Path: ${dirPath}`);
		const absolutePath = path.resolve(dirPath)
		const root = process.platform === "win32" ? path.parse(absolutePath).root : "/"
		const isRoot = absolutePath === root
		if (isRoot) {
			   console.log('[debug] [ClaudeDev] listFiles: Asking user confirmation for root path.');
			const { response, text } = await this.ask(
				"tool",
				JSON.stringify({ tool: "listFiles", path: dirPath, content: root } as ClaudeSayTool)
			)
			if (response !== "yesButtonTapped") {
				if (response === "textResponse" && text) {
					await this.say("user_feedback", text)
					return `The user denied this operation and provided the following feedback:\n\"${text}\"`
				}
				return "The user denied this operation."
			}
			return root
		}

		try {
			const options = {
				cwd: dirPath,
				dot: true, // Allow patterns to match files/directories that start with '.', even if the pattern does not start with '.'
				absolute: false,
				markDirectories: true, // Append a / on any directories matched
				onlyFiles: false,
			}
			// * globs all files in one dir, ** globs files in nested directories
			const entries = await globby("*", options)
			const result = entries.join("\n")
			   console.log('[debug] [ClaudeDev] listFiles: Asking user confirmation for non-root path.');
			const { response, text } = await this.ask(
				"tool",
				JSON.stringify({ tool: "listFiles", path: dirPath, content: result } as ClaudeSayTool)
			)
			console.log(`[ClaudeDev] listFiles: User confirmation response: ${response}`);
			if (response !== "yesButtonTapped") {
				if (response === "textResponse" && text) {
					await this.say("user_feedback", text)
					return `The user denied this operation and provided the following feedback:\n\"${text}\"`
				}
				return "The user denied this operation."
			}
			console.log('[debug] [ClaudeDev] listFiles: List successful.');
			return result
		} catch (error) {
			console.error('[ClaudeDev] listFiles Error:', error);
			const errorString = `Error listing files and directories: ${JSON.stringify(serializeError(error))}`
			this.say(
				"error",
				`Error listing files and directories:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)
				}`
			)
			return errorString
		}
	}

	async executeCommand(command: string, returnEmptyStringOnSuccess: boolean = false): Promise<string> {
		console.log(`[ClaudeDev] executeCommand called. Command: "${command}"`);
		console.log('[debug] [ClaudeDev] executeCommand: Asking user confirmation.');
		const { response, text } = await this.ask("command", command)
		console.log(`[ClaudeDev] executeCommand: User confirmation response: ${response}`);
		if (response !== "yesButtonTapped") {
			if (response === "textResponse" && text) {
				await this.say("user_feedback", text)
				return `The user denied this operation and provided the following feedback:\n\"${text}\"`
			}
			return "The user denied this operation."
		}
		try {
			let result = ""
			// execa by default tries to convery bash into javascript
			// by using shell: true we use sh on unix or cmd.exe on windows
			// also worth noting that execa`input` runs commands and the execa() creates a new instance
			for await (const line of execa({ shell: true })`${command}`) {
				console.log(`[ClaudeDev] executeCommand Output Line: ${line}`);
				this.say("command_output", line) // stream output to user in realtime
				result += `${line}\n`
			}
			// for attemptCompletion, we don't want to return the command output
			if (returnEmptyStringOnSuccess) {
				return ""
			}
			console.log('[debug] [ClaudeDev] executeCommand: Execution successful.');
			return `Command executed successfully. Output:\n${result}`
		} catch (e) {
			const error = e as any
			let errorMessage = error.message || JSON.stringify(serializeError(error), null, 2)
			console.error('[ClaudeDev] executeCommand Error:', error);
			const errorString = `Error executing command:\n${errorMessage}`
			this.say("error", `Error executing command:\n${errorMessage}`) // TODO: in webview show code block for command errors
			return errorString
		}
	}

	async askFollowupQuestion(question: string): Promise<string> {
		console.log(`[ClaudeDev] askFollowupQuestion called. Question: "${question}"`);
		const { text } = await this.ask("followup", question)
		console.log(`[ClaudeDev] askFollowupQuestion: Received response: "${text}"`);
		await this.say("user_feedback", text ?? "")
		return `User's response:\n\"${text}\"`
	}

	async attemptCompletion(result: string, command?: string): Promise<string> {
		console.log(`[ClaudeDev] attemptCompletion called. Result: "${result}", Command: "${command}"`);
		let resultToSend = result
		if (command) {
			await this.say("completion_result", resultToSend)
			console.log('[debug] [ClaudeDev] attemptCompletion: Executing associated command...');
			// TODO: currently we don't handle if this command fails, it could be useful to let claude know and retry
			const commandResult = await this.executeCommand(command, true)
			// if we received non-empty string, the command was rejected or failed
			if (commandResult) {
				return commandResult
			}
			resultToSend = ""
		}
		const { response, text } = await this.ask("completion_result", resultToSend) // this prompts webview to show 'new task' button, and enable text input (which would be the 'text' here)
		console.log(`[ClaudeDev] attemptCompletion: User confirmation response: ${response}, Feedback: ${text ? 'Yes' : 'No'}`);
		if (response === "yesButtonTapped") {
			return ""
		}
		await this.say("user_feedback", text ?? "")
		return `The user is not pleased with the results. Use the feedback they provided to successfully complete the task, and then attempt completion again.\nUser's feedback:\n\"${text}\"`
	}

	async attemptApiRequest(): Promise<Anthropic.Messages.Message> {
		console.log('[debug] [ClaudeDev:attemptApiRequest] Starting API request');
		console.log(`[ClaudeDev:attemptApiRequest] Model: claude-3-5-sonnet-20240620, Max tokens: 8192`);
		console.log(`[ClaudeDev:attemptApiRequest] System prompt length: ${SYSTEM_PROMPT.length}`);
		try {
			const response = await this.client.messages.create(
				{
					model: "claude-3-5-sonnet-20240620", // https://docs.anthropic.com/en/docs/about-claude/models
					// beta max tokens
					max_tokens: 8192,
					system: SYSTEM_PROMPT,
					messages: (await this.providerRef.deref()?.getApiConversationHistory()) || [],
					tools: tools,
					tool_choice: { type: "auto" }
				},
				{
					// https://github.com/anthropics/anthropic-sdk-typescript?tab=readme-ov-file#default-headers
					headers: { "anthropic-beta": "max-tokens-3-5-sonnet-2024-07-15" }
				}
			)
			console.log('[debug] [ClaudeDev:attemptApiRequest] Request configuration complete')
			console.log(`[ClaudeDev:attemptApiRequest] Response received - Content blocks: ${response.content.length}`);
			console.log('[debug] [ClaudeDev] attemptApiRequest: API request successful.');
			return response
		} catch (error) {
			console.error('[ClaudeDev] attemptApiRequest Error:', error);
			console.log('[debug] [ClaudeDev] attemptApiRequest: Asking user to retry.');
			const { response } = await this.ask(
				"api_req_failed",
				error.message ?? JSON.stringify(serializeError(error), null, 2)
			)
			if (response !== "yesButtonTapped") {
				// this will never happen since if noButtonTapped, we will clear current task, aborting this instance
				throw new Error("API request failed")
			}
			await this.say("api_req_retried")
			console.log('[debug] [ClaudeDev] attemptApiRequest: Retrying API request.');
			return this.attemptApiRequest()
		}
	}

	async recursivelyMakeClaudeRequests(
		userContent: Array<
			| Anthropic.TextBlockParam
			| Anthropic.ImageBlockParam
			| Anthropic.ToolUseBlockParam
			| Anthropic.ToolResultBlockParam
		>
	): Promise<ClaudeRequestResult> {
		console.log('[debug] [ClaudeDev] recursivelyMakeClaudeRequests called. Request Count:', this.requestCount, 'User Content Type:', userContent[0]?.type);
		if (this.abort) {
			console.warn('[ClaudeDev] recursivelyMakeClaudeRequests: Instance aborted, throwing error.');
			throw new Error("ClaudeDev instance aborted")
		}

		console.log('[debug] [ClaudeDev] recursivelyMakeClaudeRequests: Added user message to API history.');
		await this.providerRef.deref()?.addMessageToApiConversationHistory({ role: "user", content: userContent })
		if (this.requestCount >= this.maxRequestsPerTask) {
			console.warn('[ClaudeDev] recursivelyMakeClaudeRequests: Request limit reached. Asking user.');
			const { response } = await this.ask(
				"request_limit_reached",
				`Claude Dev has reached the maximum number of requests for this task. Would you like to reset the count and allow him to proceed?`
			)

			if (response === "yesButtonTapped") {
				this.requestCount = 0
				console.log('[debug] [ClaudeDev] recursivelyMakeClaudeRequests: User approved proceeding past request limit.');
			} else {
				await this.providerRef.deref()?.addMessageToApiConversationHistory({
					role: "assistant",
					content: [
						{
							type: "text",
							text: "Failure: I have reached the request limit for this task. Do you have a new task for me?",
						},
					],
				})
				console.log('[debug] [ClaudeDev] recursivelyMakeClaudeRequests: User denied proceeding past request limit. Ending loop.');
				return { didEndLoop: true, inputTokens: 0, outputTokens: 0 }
			}
		}

		// what the user sees in the webview
		console.log('[debug] [ClaudeDev] recursivelyMakeClaudeRequests: Sending api_req_started to webview.');
		await this.say(
			"api_req_started",
			JSON.stringify({
				request: {
					model: "claude-3-5-sonnet-20240620",
					max_tokens: 8192,
					system: "(see SYSTEM_PROMPT in https://github.com/saoudrizwan/claude-dev/blob/main/src/ClaudeDev.ts)",
					messages: [{ conversation_history: "..." }, { role: "user", content: userContent }],
					tools: "(see tools in https://github.com/saoudrizwan/claude-dev/blob/main/src/ClaudeDev.ts)",
					tool_choice: { type: "auto" },
				},
			})
		)
		try {
			console.log('[debug] [ClaudeDev] recursivelyMakeClaudeRequests: API request attempt finished.');
			const response = await this.attemptApiRequest()
			this.requestCount++

			let assistantResponses: Anthropic.Messages.ContentBlock[] = []
			let inputTokens = response.usage.input_tokens
			let outputTokens = response.usage.output_tokens
			console.log(`[ClaudeDev] recursivelyMakeClaudeRequests: API Usage - Input: ${inputTokens}, Output: ${outputTokens}`);
			console.log('[debug] [ClaudeDev] recursivelyMakeClaudeRequests: Sending api_req_finished to webview.');
			await this.say(
				"api_req_finished",
				JSON.stringify({
					tokensIn: inputTokens,
					tokensOut: outputTokens,
					cost: this.calculateApiCost(inputTokens, outputTokens),
				})
			)

			// A response always returns text content blocks (it's just that before we were iterating over the completion_attempt response before we could append text response, resulting in bug)
			for (const contentBlock of response.content) {
				if (contentBlock.type === "text") {
					console.log('[debug] [ClaudeDev] recursivelyMakeClaudeRequests: Processing text content block.');
					assistantResponses.push(contentBlock)
					await this.say("text", contentBlock.text)
				}
			}

			let toolResults: Anthropic.ToolResultBlockParam[] = []
			let attemptCompletionBlock: Anthropic.Messages.ToolUseBlock | undefined
			for (const contentBlock of response.content) {
				if (contentBlock.type === "tool_use") {
					console.log(`[ClaudeDev] recursivelyMakeClaudeRequests: Processing tool_use content block. Tool: ${contentBlock.name}, ID: ${contentBlock.id}`);
					assistantResponses.push(contentBlock)
					const toolName = contentBlock.name as ToolName
					const toolInput = contentBlock.input
					const toolUseId = contentBlock.id
					if (toolName === "attempt_completion") {
						attemptCompletionBlock = contentBlock
					} else {
						console.log(`[ClaudeDev] recursivelyMakeClaudeRequests: Executing tool: ${toolName}`);
						const result = await this.executeTool(toolName, toolInput)
						// this.say(
						// 	"tool",
						// 	`\nTool Used: ${toolName}\nTool Input: ${JSON.stringify(toolInput)}\nTool Result: ${result}`
						// )
						console.log(`[ClaudeDev] recursivelyMakeClaudeRequests: Tool result collected for ${toolName}.`);
						toolResults.push({ type: "tool_result", tool_use_id: toolUseId, content: result })
					}
				}
			}

			if (assistantResponses.length > 0) {
				console.log('[debug] [ClaudeDev] recursivelyMakeClaudeRequests: Added assistant message to API history.');
				await this.providerRef
					.deref()
					?.addMessageToApiConversationHistory({ role: "assistant", content: assistantResponses })
			} else {
				// this should never happen! it there's no assistant_responses, that means we got no text or tool_use content blocks from API which we should assume is an error
				console.error('[ClaudeDev] recursivelyMakeClaudeRequests: No assistant messages found in API response!');
				this.say("error", "Unexpected Error: No assistant messages were found in the API response")
				await this.providerRef.deref()?.addMessageToApiConversationHistory({
					role: "assistant",
					content: [{ type: "text", text: "Failure: I did not have a response to provide." }],
				})
			}

			let didEndLoop = false

			// attempt_completion is always done last, since there might have been other tools that needed to be called first before the job is finished
			// it's important to note that claude will order the tools logically in most cases, so we don't have to think about which tools make sense calling before others
			if (attemptCompletionBlock) {
				console.log('[debug] [ClaudeDev] recursivelyMakeClaudeRequests: Executing attempt_completion tool.');
				let result = await this.executeTool(
					attemptCompletionBlock.name as ToolName,
					attemptCompletionBlock.input
				)
				// this.say(
				// 	"tool",
				// 	`\nattempt_completion Tool Used: ${attemptCompletionBlock.name}\nTool Input: ${JSON.stringify(
				// 		attemptCompletionBlock.input
				// 	)}\nTool Result: ${result}`
				// )
				console.log('[debug] [ClaudeDev] recursivelyMakeClaudeRequests: attempt_completion successful, ending loop.');
				if (result === "") {
					didEndLoop = true
					result = "The user is satisfied with the result."
				}
				console.log('[debug] [ClaudeDev] recursivelyMakeClaudeRequests: attempt_completion indicated user feedback.');
				toolResults.push({ type: "tool_result", tool_use_id: attemptCompletionBlock.id, content: result })
			}

			console.log(`[ClaudeDev] recursivelyMakeClaudeRequests: ${toolResults.length} tool results collected.`);
			if (toolResults.length > 0) {
				if (didEndLoop) {
					console.log('[debug] [ClaudeDev] recursivelyMakeClaudeRequests: Loop ended. Adding final tool results to history.');
					await this.providerRef
						.deref()
						?.addMessageToApiConversationHistory({ role: "user", content: toolResults })
					await this.providerRef.deref()?.addMessageToApiConversationHistory({
						role: "assistant",
						content: [
							{
								type: "text",
								text: "I am pleased you are satisfied with the result. Do you have a new task for me?",
							},
						],
					})
				} else {
					console.log('[debug] [ClaudeDev] recursivelyMakeClaudeRequests: Making recursive call with tool results.');
					const {
						didEndLoop: recDidEndLoop,
						inputTokens: recInputTokens,
						outputTokens: recOutputTokens,
					} = await this.recursivelyMakeClaudeRequests(toolResults)
					didEndLoop = recDidEndLoop
					inputTokens += recInputTokens
					outputTokens += recOutputTokens
				}
			}

			console.log('[debug] [ClaudeDev] recursivelyMakeClaudeRequests: Returning - didEndLoop:', didEndLoop, 'inputTokens:', inputTokens, 'outputTokens:', outputTokens);
			return { didEndLoop, inputTokens, outputTokens }
		} catch (error) {
			console.error('[ClaudeDev] recursivelyMakeClaudeRequests: Caught unexpected error:', error);
			// this should never happen since the only thing that can throw an error is the attemptApiRequest, which is wrapped in a try catch that sends an ask where if noButtonTapped, will clear current task and destroy this instance. However to avoid unhandled promise rejection, we will end this loop which will end execution of this instance (see startTask)
			return { didEndLoop: true, inputTokens: 0, outputTokens: 0 }
		}
	}
}
