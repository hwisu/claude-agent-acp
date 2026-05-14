// Modified in the @hwisu/claude-agent-acp fork (Apache-2.0). See NOTICE.
// Original: agentclientprotocol/claude-agent-acp (© 2025 Zed Industries).
import {
  ContentBlock,
  PlanEntry,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import {
  AgentInput,
  BashInput,
  FileEditInput,
  FileReadInput,
  FileWriteInput,
  GlobInput,
  GrepInput,
  TaskCreateInput,
  TaskGetInput,
  TaskUpdateInput,
  TodoWriteInput,
  WebFetchInput,
  WebSearchInput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import {
  ContentBlockParam,
  ImageBlockParam,
  TextBlockParam,
  ToolResultBlockParam,
  WebSearchResultBlock,
  WebSearchToolResultBlockParam,
  WebSearchToolResultError,
} from "@anthropic-ai/sdk/resources";
import {
  BetaBashCodeExecutionResultBlock,
  BetaBashCodeExecutionToolResultBlockParam,
  BetaBashCodeExecutionToolResultError,
  BetaCodeExecutionResultBlock,
  BetaCodeExecutionToolResultBlockParam,
  BetaCodeExecutionToolResultError,
  BetaImageBlockParam,
  BetaRequestMCPToolResultBlockParam,
  BetaTextEditorCodeExecutionCreateResultBlock,
  BetaTextEditorCodeExecutionStrReplaceResultBlock,
  BetaTextEditorCodeExecutionToolResultBlockParam,
  BetaTextEditorCodeExecutionToolResultError,
  BetaTextEditorCodeExecutionViewResultBlock,
  BetaToolReferenceBlock,
  BetaToolResultBlockParam,
  BetaToolSearchToolResultBlockParam,
  BetaToolSearchToolResultError,
  BetaToolSearchToolSearchResultBlock,
  BetaWebFetchBlock,
  BetaWebFetchToolResultBlockParam,
  BetaWebFetchToolResultErrorBlock,
  BetaWebSearchToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta.mjs";
import path from "node:path";
import { Logger } from "./acp-agent.js";

/** The fields these helpers actually consume on a tool_use content block.
 *  We `Pick` them off the Anthropic SDK's `ToolUseBlockParam` so any future
 *  change to `id` / `name` / `input` typings flows through automatically —
 *  the source of truth lives in the SDK. The discriminator `type` is not
 *  read by these helpers, so it isn't part of the contract. */
export type SdkToolUseBlock = Pick<
  Extract<ContentBlockParam, { type: "tool_use" }>,
  "id" | "input" | "name"
>;

/**
 * SDK MCP server + tool names used when routing shell execution through the
 * ACP `terminal/*` methods (instead of the SDK's built-in `Bash` tool).
 *
 * Wire format: the model sees the tool as `mcp__acp_terminal__bash`.
 */
export const ACP_TERMINAL_MCP_SERVER_NAME = "acp_terminal";
export const ACP_TERMINAL_TOOL_NAME = "mcp__acp_terminal__bash";

/**
 * Magic prefix the ACP-routed bash MCP tool appends to its content so that
 * `toolUpdateFromToolResult` can extract structured exit info (numeric exit
 * code, signal name, timeout flag). The trailer is stripped before display.
 *
 * Format: `<<<acp-terminal-meta exit_code=N signal=S timed_out=B>>>`
 *   - exit_code: integer or "null"
 *   - signal: signal name or "null"
 *   - timed_out: "true" or "false"
 */
export const ACP_TERMINAL_META_TAG = "<<<acp-terminal-meta";
const ACP_TERMINAL_META_RE =
  /<<<acp-terminal-meta exit_code=(-?\d+|null) signal=(\S+) timed_out=(true|false)>>>/;

type AcpTerminalExitInfo = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
};

export function parseAcpTerminalMeta(text: string): {
  cleaned: string;
  info: AcpTerminalExitInfo | null;
} {
  const m = text.match(ACP_TERMINAL_META_RE);
  if (!m) return { cleaned: text, info: null };
  const exitCode = m[1] === "null" ? null : parseInt(m[1], 10);
  const signal = m[2] === "null" ? null : m[2];
  const timedOut = m[3] === "true";
  const cleaned = text.replace(ACP_TERMINAL_META_RE, "").replace(/\n+$/, "");
  return { cleaned, info: { exitCode, signal, timedOut } };
}

/**
 * Inverse of `parseAcpTerminalMeta`: build the canonical
 * `<<<acp-terminal-meta exit_code=N signal=S timed_out=B>>>` trailer.
 * Exported so the MCP-side bash handler in `acp-agent.ts` and the
 * parser here share a single source of truth for the wire format.
 */
export function formatAcpTerminalMeta(
  exitCode: number | null,
  signal: string | null,
  timedOut: boolean,
): string {
  return `${ACP_TERMINAL_META_TAG} exit_code=${exitCode ?? "null"} signal=${signal ?? "null"} timed_out=${timedOut}>>>`;
}

/**
 * Union of all possible content types that can appear in tool results from the Anthropic SDK.
 * These are transformed to valid ACP ContentBlock types by toValidAcpContent().
 */
type ToolResultContent =
  | TextBlockParam
  | ImageBlockParam
  | BetaImageBlockParam
  | BetaToolReferenceBlock
  | BetaToolSearchToolSearchResultBlock
  | BetaToolSearchToolResultError
  | WebSearchResultBlock
  | WebSearchToolResultError
  | BetaWebFetchBlock
  | BetaWebFetchToolResultErrorBlock
  | BetaCodeExecutionResultBlock
  | BetaCodeExecutionToolResultError
  | BetaBashCodeExecutionResultBlock
  | BetaBashCodeExecutionToolResultError
  | BetaTextEditorCodeExecutionViewResultBlock
  | BetaTextEditorCodeExecutionCreateResultBlock
  | BetaTextEditorCodeExecutionStrReplaceResultBlock
  | BetaTextEditorCodeExecutionToolResultError;

interface ToolInfo {
  title: string;
  kind: ToolKind;
  content: ToolCallContent[];
  locations?: ToolCallLocation[];
}

interface ToolUpdate {
  title?: string;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  _meta?: {
    terminal_info?: {
      terminal_id: string;
    };
    terminal_output?: {
      terminal_id: string;
      data: string;
    };
    terminal_exit?: {
      terminal_id: string;
      exit_code: number;
      signal: string | null;
    };
  };
}

/**
 * Convert an absolute file path to a project-relative path for display.
 * Returns the original path if it's outside the project directory or if no cwd is provided.
 */
export function toDisplayPath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;
  const resolvedCwd = path.resolve(cwd);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile.startsWith(resolvedCwd + path.sep) || resolvedFile === resolvedCwd) {
    return path.relative(resolvedCwd, resolvedFile);
  }
  return filePath;
}

export function toolInfoFromToolUse(
  toolUse: SdkToolUseBlock,
  supportsTerminalOutput: boolean = false,
  cwd?: string,
): ToolInfo {
  const name = toolUse.name;

  switch (name) {
    case "Agent":
    case "Task": {
      const input = toolUse.input as AgentInput | BashInput | undefined;
      return {
        title: input?.description ? input.description : "Task",
        kind: "think",
        content:
          input && "prompt" in input
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.prompt },
                },
              ]
            : [],
      };
    }

    case "Bash":
    case ACP_TERMINAL_TOOL_NAME: {
      const input = toolUse.input as BashInput | undefined;
      // When routing through ACP terminals, the client creates its own
      // terminal and renders it directly — embedding a stub terminalId
      // referencing the SDK tool_use_id would confuse it.
      const isAcpTerminal = name === ACP_TERMINAL_TOOL_NAME;
      return {
        title: input?.command ? input.command : "Terminal",
        kind: "execute",
        content:
          !isAcpTerminal && supportsTerminalOutput
            ? [{ type: "terminal" as const, terminalId: toolUse.id }]
            : input && input.description
              ? [
                  {
                    type: "content",
                    content: { type: "text", text: input.description },
                  },
                ]
              : [],
      };
    }

    case "Read": {
      const input = toolUse.input as FileReadInput | undefined;
      let limit = "";
      if (input?.limit && input.limit > 0) {
        limit = " (" + (input.offset ?? 1) + " - " + ((input.offset ?? 1) + input.limit - 1) + ")";
      } else if (input?.offset) {
        limit = " (from line " + input.offset + ")";
      }
      const displayPath = input?.file_path ? toDisplayPath(input.file_path, cwd) : "File";
      return {
        title: "Read " + displayPath + limit,
        kind: "read",
        locations: input?.file_path
          ? [
              {
                path: input.file_path,
                line: input.offset ?? 1,
              },
            ]
          : [],
        content: [],
      };
    }

    case "Write": {
      const input = toolUse.input as FileWriteInput | undefined;
      let content: ToolCallContent[] = [];
      if (input && input.file_path) {
        content = [
          {
            type: "diff",
            path: input.file_path,
            oldText: null,
            newText: input.content,
          },
        ];
      } else if (input && input.content) {
        content = [
          {
            type: "content",
            content: { type: "text", text: input.content },
          },
        ];
      }
      const displayPath = input?.file_path ? toDisplayPath(input.file_path, cwd) : undefined;
      return {
        title: displayPath ? `Write ${displayPath}` : "Write",
        kind: "edit",
        content,
        locations: input?.file_path ? [{ path: input.file_path }] : [],
      };
    }

    case "Edit": {
      const input = toolUse.input as FileEditInput | undefined;
      let content: ToolCallContent[] = [];
      if (input && input.file_path && (input.old_string || input.new_string)) {
        content = [
          {
            type: "diff",
            path: input.file_path,
            oldText: input.old_string || null,
            newText: input.new_string ?? "",
          },
        ];
      }
      const displayPath = input?.file_path ? toDisplayPath(input.file_path, cwd) : undefined;
      return {
        title: displayPath ? `Edit ${displayPath}` : "Edit",
        kind: "edit",
        content,
        locations: input?.file_path ? [{ path: input.file_path }] : [],
      };
    }

    case "Glob": {
      const input = toolUse.input as GlobInput | undefined;
      let label = "Find";
      if (input?.path) {
        label += ` \`${input.path}\``;
      }
      if (input?.pattern) {
        label += ` \`${input.pattern}\``;
      }
      return {
        title: label,
        kind: "search",
        content: [],
        locations: input?.path ? [{ path: input.path }] : [],
      };
    }

    case "Grep": {
      const input = toolUse.input as GrepInput | undefined;
      let label = "grep";

      if (input?.["-i"]) {
        label += " -i";
      }
      if (input?.["-n"]) {
        label += " -n";
      }
      if (input?.["-o"]) {
        label += " -o";
      }

      if (input?.["-A"] !== undefined) {
        label += ` -A ${input["-A"]}`;
      }
      if (input?.["-B"] !== undefined) {
        label += ` -B ${input["-B"]}`;
      }
      if (input?.["-C"] !== undefined) {
        label += ` -C ${input["-C"]}`;
      }

      if (input?.output_mode) {
        switch (input.output_mode) {
          case "files_with_matches":
            label += " -l";
            break;
          case "count":
            label += " -c";
            break;
          case "content":
          default:
            break;
        }
      }

      if (input?.head_limit !== undefined) {
        label += ` | head -${input.head_limit}`;
      }

      if (input?.glob) {
        label += ` --include="${input.glob}"`;
      }

      if (input?.type) {
        label += ` --type=${input.type}`;
      }

      if (input?.multiline) {
        label += " -P";
      }

      if (input?.pattern) {
        label += ` "${input.pattern}"`;
      }

      if (input?.path) {
        label += ` ${input.path}`;
      }

      return {
        title: label,
        kind: "search",
        content: [],
      };
    }

    case "WebFetch": {
      const input = toolUse.input as WebFetchInput;
      return {
        title: input?.url ? `Fetch ${input.url}` : "Fetch",
        kind: "fetch",
        content:
          input && input.prompt
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.prompt },
                },
              ]
            : [],
      };
    }

    case "WebSearch": {
      const input = toolUse.input as WebSearchInput | undefined;
      let label = input?.query ? `"${input.query}"` : "Web search";

      if (input?.allowed_domains && input.allowed_domains.length > 0) {
        label += ` (allowed: ${input.allowed_domains.join(", ")})`;
      }

      if (input?.blocked_domains && input.blocked_domains.length > 0) {
        label += ` (blocked: ${input.blocked_domains.join(", ")})`;
      }

      return {
        title: label,
        kind: "fetch",
        content: [],
      };
    }

    case "TodoWrite": {
      const input = toolUse.input as TodoWriteInput | undefined;
      return {
        title: Array.isArray(input?.todos)
          ? `Update TODOs: ${input.todos.map((todo: any) => todo.content).join(", ")}`
          : "Update TODOs",
        kind: "think",
        content: [],
      };
    }

    case "TaskCreate": {
      const input = toolUse.input as TaskCreateInput | undefined;
      return {
        title: input?.subject ? `Create task: ${input.subject}` : "Create task",
        kind: "think",
        content: input?.description
          ? [
              {
                type: "content" as const,
                content: { type: "text" as const, text: input.description },
              },
            ]
          : [],
      };
    }

    case "TaskGet": {
      const input = toolUse.input as TaskGetInput | undefined;
      return {
        title: input?.taskId ? `Get task ${input.taskId}` : "Get task",
        kind: "think",
        content: [],
      };
    }

    case "TaskUpdate": {
      const input = toolUse.input as TaskUpdateInput | undefined;
      const details = [
        input?.subject ? `subject: ${input.subject}` : null,
        input?.status ? `status: ${input.status}` : null,
      ].filter(Boolean);
      return {
        title: input?.taskId ? `Update task ${input.taskId}` : "Update task",
        kind: "think",
        content: details.length
          ? [
              {
                type: "content" as const,
                content: { type: "text" as const, text: details.join("\n") },
              },
            ]
          : [],
      };
    }

    case "TaskList": {
      return {
        title: "List tasks",
        kind: "think",
        content: [],
      };
    }

    case "ExitPlanMode": {
      const planInput = toolUse.input as { plan?: string } | undefined;
      return {
        title: "Ready to code?",
        kind: "switch_mode",
        content: planInput?.plan
          ? [{ type: "content" as const, content: { type: "text" as const, text: planInput.plan } }]
          : [],
      };
    }

    case "Other": {
      const input = toolUse.input;
      let output;
      try {
        output = JSON.stringify(input, null, 2);
      } catch {
        output = typeof input === "string" ? input : "{}";
      }
      return {
        title: name || "Unknown Tool",
        kind: "other",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `\`\`\`json\n${output}\`\`\``,
            },
          },
        ],
      };
    }

    default:
      return {
        title: name || "Unknown Tool",
        kind: "other",
        content: [],
      };
  }
}

export function toolUpdateFromToolResult(
  toolResult:
    | ToolResultBlockParam
    | BetaToolResultBlockParam
    | BetaWebSearchToolResultBlockParam
    | BetaWebFetchToolResultBlockParam
    | WebSearchToolResultBlockParam
    | BetaCodeExecutionToolResultBlockParam
    | BetaBashCodeExecutionToolResultBlockParam
    | BetaTextEditorCodeExecutionToolResultBlockParam
    | BetaRequestMCPToolResultBlockParam
    | BetaToolSearchToolResultBlockParam,
  toolUse: SdkToolUseBlock | undefined,
  supportsTerminalOutput: boolean = false,
): ToolUpdate {
  if (
    "is_error" in toolResult &&
    toolResult.is_error &&
    toolResult.content &&
    toolResult.content.length > 0
  ) {
    // Only return errors
    return toAcpContentUpdate(toolResult.content, true);
  }

  switch (toolUse?.name) {
    case "Read":
      if (Array.isArray(toolResult.content) && toolResult.content.length > 0) {
        return {
          content: toolResult.content.map((content: any) => ({
            type: "content",
            content:
              content.type === "text"
                ? {
                    type: "text",
                    text: markdownEscape(content.text),
                  }
                : toAcpContentBlock(content, false),
          })),
        };
      } else if (typeof toolResult.content === "string" && toolResult.content.length > 0) {
        return {
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: markdownEscape(toolResult.content),
              },
            },
          ],
        };
      }
      return {};

    case "Bash":
    case ACP_TERMINAL_TOOL_NAME: {
      const result = toolResult.content;
      const terminalId = "tool_use_id" in toolResult ? String(toolResult.tool_use_id) : "";
      const isError = "is_error" in toolResult && toolResult.is_error;
      const isAcpTerminal = toolUse?.name === ACP_TERMINAL_TOOL_NAME;

      // Extract output and exit code from either format:
      // 1. BetaBashCodeExecutionResultBlock: { type: "bash_code_execution_result", stdout, stderr, return_code }
      // 2. Plain string content from a regular tool_result
      // 3. Array content (e.g. [{ type: "text", text: "..." }])
      let output = "";
      let exitCode = isError ? 1 : 0;
      let signal: string | null = null;

      if (
        result &&
        typeof result === "object" &&
        "type" in result &&
        result.type === "bash_code_execution_result"
      ) {
        const bashResult = result as BetaBashCodeExecutionResultBlock;
        output = [bashResult.stdout, bashResult.stderr].filter(Boolean).join("\n");
        exitCode = bashResult.return_code;
      } else if (typeof result === "string") {
        output = result;
      } else if (
        Array.isArray(result) &&
        result.length > 0 &&
        "text" in result[0] &&
        typeof result[0].text === "string"
      ) {
        output = result.map((c: any) => c.text).join("\n");
      }

      // ACP-routed bash encodes numeric exit info in a structured trailer
      // (see ACP_TERMINAL_META_TAG). Parse it back, strip the trailer from
      // the displayed output, and use the parsed values.
      if (isAcpTerminal) {
        const { cleaned, info } = parseAcpTerminalMeta(output);
        output = cleaned;
        if (info) {
          exitCode = info.exitCode ?? (info.timedOut ? 124 : isError ? 1 : 0);
          signal = info.signal;
        }
      }

      if (supportsTerminalOutput) {
        // For ACP-routed bash the live output stream is already owned by the
        // client's own terminal (created via `terminal/create`). Emitting a
        // `terminal_output` data blob keyed to a different (SDK tool_use_id)
        // terminal_id would just duplicate. We still emit a structured
        // `terminal_exit` so clients that surface numeric exit info on the
        // tool call card don't have to regex the text.
        const meta: NonNullable<ToolUpdate["_meta"]> = {
          terminal_exit: {
            terminal_id: terminalId,
            exit_code: exitCode,
            signal,
          },
        };
        if (!isAcpTerminal) {
          meta.terminal_info = { terminal_id: terminalId };
          meta.terminal_output = { terminal_id: terminalId, data: output };
        }
        return {
          content: isAcpTerminal
            ? output.trim()
              ? [
                  {
                    type: "content",
                    content: {
                      type: "text",
                      text: `\`\`\`console\n${output.trimEnd()}\n\`\`\``,
                    },
                  },
                ]
              : []
            : [{ type: "terminal" as const, terminalId }],
          _meta: meta,
        };
      }
      // Fallback: format output as a code block without terminal _meta
      if (output.trim()) {
        return {
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: `\`\`\`console\n${output.trimEnd()}\n\`\`\``,
              },
            },
          ],
        };
      }
      return {};
    }

    case "Edit": // Edit is handled in hooks
    case "Write": {
      return {};
    }

    case "ExitPlanMode": {
      return { title: "Exited Plan Mode" };
    }

    default: {
      return toAcpContentUpdate(
        toolResult.content,
        "is_error" in toolResult ? toolResult.is_error : false,
      );
    }
  }
}

function toAcpContentUpdate(
  content: any,
  isError: boolean = false,
): { content?: ToolCallContent[] } {
  if (Array.isArray(content) && content.length > 0) {
    return {
      content: content.map((c: any) => ({
        type: "content" as const,
        content: toAcpContentBlock(c, isError),
      })),
    };
  } else if (typeof content === "object" && content !== null) {
    return {
      content: [
        {
          type: "content" as const,
          content: toAcpContentBlock(content, isError),
        },
      ],
    };
  } else if (typeof content === "string" && content.length > 0) {
    return {
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: isError ? `\`\`\`\n${content}\n\`\`\`` : content,
          },
        },
      ],
    };
  }
  return {};
}

function toAcpContentBlock(
  content: ToolResultContent | Record<string, unknown>,
  isError: boolean,
): ContentBlock {
  const wrapText = (text: string): ContentBlock => ({
    type: "text" as const,
    text: isError ? `\`\`\`\n${text}\n\`\`\`` : text,
  });

  const typed = content as ToolResultContent;

  switch (typed.type) {
    case "text":
      return {
        type: "text" as const,
        text: isError ? `\`\`\`\n${typed.text}\n\`\`\`` : typed.text,
      };
    case "image":
      if (typed.source.type === "base64") {
        return {
          type: "image" as const,
          data: typed.source.data,
          mimeType: typed.source.media_type,
        };
      }
      // URL and file-based images can't be converted to ACP format (requires data)
      return wrapText(
        typed.source.type === "url" ? `[image: ${typed.source.url}]` : "[image: file reference]",
      );

    case "tool_reference":
      return wrapText(`Tool: ${typed.tool_name}`);
    case "tool_search_tool_search_result":
      return wrapText(
        `Tools found: ${typed.tool_references.map((r) => r.tool_name).join(", ") || "none"}`,
      );
    case "tool_search_tool_result_error":
      return wrapText(
        `Error: ${typed.error_code}${typed.error_message ? ` - ${typed.error_message}` : ""}`,
      );
    case "web_search_result":
      return wrapText(`${typed.title} (${typed.url})`);
    case "web_search_tool_result_error":
      return wrapText(`Error: ${typed.error_code}`);
    case "web_fetch_result":
      return wrapText(`Fetched: ${typed.url}`);
    case "web_fetch_tool_result_error":
      return wrapText(`Error: ${typed.error_code}`);
    case "code_execution_result":
      return wrapText(`Output: ${typed.stdout || typed.stderr || ""}`);
    case "bash_code_execution_result":
      return wrapText(`Output: ${typed.stdout || typed.stderr || ""}`);
    case "code_execution_tool_result_error":
    case "bash_code_execution_tool_result_error":
      return wrapText(`Error: ${typed.error_code}`);
    case "text_editor_code_execution_view_result":
      return wrapText(typed.content);
    case "text_editor_code_execution_create_result":
      return wrapText(typed.is_file_update ? "File updated" : "File created");
    case "text_editor_code_execution_str_replace_result":
      return wrapText(typed.lines?.join("\n") || "");
    case "text_editor_code_execution_tool_result_error":
      return wrapText(
        `Error: ${typed.error_code}${typed.error_message ? ` - ${typed.error_message}` : ""}`,
      );

    default:
      return wrapText(JSON.stringify(content));
  }
}

export type ClaudePlanEntry = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
};

export function planEntries(input: { todos: ClaudePlanEntry[] } | undefined): PlanEntry[] {
  return (input?.todos ?? []).map((todo) => ({
    content: todo.content,
    status: todo.status,
    priority: "medium",
  }));
}

export function markdownEscape(text: string): string {
  let escape = "```";
  for (const [m] of text.matchAll(/^```+/gm)) {
    while (m.length >= escape.length) {
      escape += "`";
    }
  }
  return escape + "\n" + text + (text.endsWith("\n") ? "" : "\n") + escape;
}

interface DiffToolResponseHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface DiffToolResponse {
  filePath?: string;
  structuredPatch?: DiffToolResponseHunk[];
}

/**
 * Builds diff ToolUpdate content from the structured toolResponse provided by
 * the PostToolUse hook for diff-producing tools (Edit, Write). Unlike parsing
 * the plain unified diff string, this uses the pre-parsed structuredPatch
 * which supports multiple replacement sites (replaceAll) and always includes
 * context lines for better readability.
 */
export function toolUpdateFromDiffToolResponse(toolResponse: unknown): {
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
} {
  if (!toolResponse || typeof toolResponse !== "object") return {};
  const response = toolResponse as DiffToolResponse;
  if (!response.filePath || !Array.isArray(response.structuredPatch)) return {};

  const content: ToolCallContent[] = [];
  const locations: ToolCallLocation[] = [];

  for (const { lines, newStart } of response.structuredPatch) {
    const oldText: string[] = [];
    const newText: string[] = [];
    for (const line of lines) {
      if (line.startsWith("-")) {
        oldText.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newText.push(line.slice(1));
      } else {
        oldText.push(line.slice(1));
        newText.push(line.slice(1));
      }
    }
    if (oldText.length > 0 || newText.length > 0) {
      locations.push({ path: response.filePath, line: newStart });
      content.push({
        type: "diff",
        path: response.filePath,
        oldText: oldText.join("\n") || null,
        newText: newText.join("\n"),
      });
    }
  }

  const result: { content?: ToolCallContent[]; locations?: ToolCallLocation[] } = {};
  if (content.length > 0) result.content = content;
  if (locations.length > 0) result.locations = locations;
  return result;
}

/* A global variable to store callbacks that should be executed when receiving hooks from Claude Code */
const toolUseCallbacks: {
  [toolUseId: string]: {
    onPostToolUseHook?: (
      toolUseID: string,
      toolInput: unknown,
      toolResponse: unknown,
    ) => Promise<void>;
  };
} = {};

/* Setup callbacks that will be called when receiving hooks from Claude Code */
export const registerHookCallback = (
  toolUseID: string,
  {
    onPostToolUseHook,
  }: {
    onPostToolUseHook?: (
      toolUseID: string,
      toolInput: unknown,
      toolResponse: unknown,
    ) => Promise<void>;
  },
) => {
  toolUseCallbacks[toolUseID] = {
    onPostToolUseHook,
  };
};

/* A callback for Claude Code that is called when receiving a PostToolUse hook */
export const createPostToolUseHook =
  (
    logger: Logger = console,
    options?: {
      onEnterPlanMode?: () => Promise<void>;
    },
  ): HookCallback =>
  async (input: any, toolUseID: string | undefined): Promise<{ continue: boolean }> => {
    if (input.hook_event_name === "PostToolUse") {
      // Handle EnterPlanMode tool - notify client of mode change after successful execution
      if (input.tool_name === "EnterPlanMode" && options?.onEnterPlanMode) {
        await options.onEnterPlanMode();
      }

      if (toolUseID) {
        const onPostToolUseHook = toolUseCallbacks[toolUseID]?.onPostToolUseHook;
        if (onPostToolUseHook) {
          await onPostToolUseHook(toolUseID, input.tool_input, input.tool_response);
          delete toolUseCallbacks[toolUseID]; // Cleanup after execution
        } else {
          logger.error(`No onPostToolUseHook found for tool use ID: ${toolUseID}`);
          delete toolUseCallbacks[toolUseID];
        }
      }
    }
    return { continue: true };
  };
