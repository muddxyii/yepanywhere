import type {
  ClaudeSessionEntry,
  CodexCompactedEntry,
  CodexCustomToolCallOutputPayload,
  CodexCustomToolCallPayload,
  CodexEventMsgEntry,
  CodexFunctionCallPayload,
  CodexMessagePayload,
  CodexReasoningPayload,
  CodexResponseItemEntry,
  CodexSessionEntry,
  CodexWebSearchCallPayload,
  GeminiAssistantMessage,
  GeminiSessionMessage,
  GeminiUserMessage,
  OpenCodeSessionEntry,
  OpenCodeStoredPart,
  UnifiedSession,
} from "@yep-anywhere/shared";
import {
  getGeminiUserMessageText,
  getMessageContent,
  isConversationEntry,
} from "@yep-anywhere/shared";
import type { ContentBlock, Message, Session } from "../supervisor/types.js";
import {
  buildDag,
  collectAllToolResultIds,
  findOrphanedToolUses,
  findSiblingToolBranches,
  findSiblingToolResults,
} from "./dag.js";
import type { LoadedSession } from "./types.js";

const CODEX_TOOL_NAME_ALIASES: Record<string, string> = {
  shell_command: "Bash",
  exec_command: "Bash",
  write_stdin: "WriteStdin",
  update_plan: "UpdatePlan",
  apply_patch: "Edit",
  web_search_call: "WebSearch",
  search_query: "WebSearch",
};

interface CodexReadShellInfo {
  filePath: string;
  startLine?: number;
  endLine?: number;
  stripLineNumbers: boolean;
}

interface CodexToolCallContext {
  toolName: string;
  input: unknown;
  readShellInfo?: CodexReadShellInfo;
}

interface NormalizedCodexToolInvocation {
  toolName: string;
  input: unknown;
  readShellInfo?: CodexReadShellInfo;
}

interface CodexToolUseConversion {
  callId: string;
  message: Message;
  context: CodexToolCallContext;
}

/**
 * Normalize a UnifiedSession into the generic Session format expected by the frontend.
 */
export function normalizeSession(loaded: LoadedSession): Session {
  const { summary, data } = loaded;

  switch (data.provider) {
    case "claude": {
      // Claude sessions are stored as raw messages in the session file.
      // We need to build the DAG to find the active branch.
      const rawMessages = data.session.messages;

      // Build DAG and get active branch (filters out dead branches)
      const { activeBranch } = buildDag(rawMessages);

      // Collect all tool_result IDs from the entire session (not just active branch)
      // This handles parallel tool calls where results may be on sibling branches
      const allToolResultIds = collectAllToolResultIds(rawMessages);

      // Find tool_uses on active branch that have no matching tool_result anywhere
      const orphanedToolUses = findOrphanedToolUses(
        activeBranch,
        allToolResultIds,
      );

      // Find tool_result messages on sibling branches that match tool_uses on active branch
      // These need to be included so the client can pair them with their tool_uses
      const siblingToolResults = findSiblingToolResults(
        activeBranch,
        rawMessages,
      );

      // Find complete sibling tool branches (tool_use + tool_result pairs on dead branches)
      // This handles the case where Claude spawns parallel tasks as chained messages
      const siblingToolBranches = findSiblingToolBranches(
        activeBranch,
        rawMessages,
      );

      // Build a map of parentUuid -> sibling tool_results for efficient insertion
      const siblingsByParent = new Map<string, Message[]>();
      for (const sibling of siblingToolResults) {
        const converted = convertClaudeMessage(
          sibling.raw,
          -1,
          new Set<string>(),
        );
        const existing = siblingsByParent.get(sibling.parentUuid);
        if (existing) {
          existing.push(converted);
        } else {
          siblingsByParent.set(sibling.parentUuid, [converted]);
        }
      }

      // Build a map of branchPoint -> sibling branch nodes for chained parallel tasks
      const siblingBranchesByParent = new Map<string, Message[]>();
      for (const branch of siblingToolBranches) {
        const converted = branch.nodes.map((node) =>
          convertClaudeMessage(node.raw, -1, new Set<string>()),
        );
        const existing = siblingBranchesByParent.get(branch.branchPoint);
        if (existing) {
          existing.push(...converted);
        } else {
          siblingBranchesByParent.set(branch.branchPoint, converted);
        }
      }

      // Convert active branch to Message objects, inserting sibling branches after their parent
      const messages: Message[] = [];
      for (let i = 0; i < activeBranch.length; i++) {
        const node = activeBranch[i];
        if (!node) continue;
        const msg = convertClaudeMessage(node.raw, i, orphanedToolUses);
        messages.push(msg);

        // Insert any sibling tool_results that have this node as their parent
        const siblings = siblingsByParent.get(node.uuid);
        if (siblings) {
          messages.push(...siblings);
        }

        // Insert any sibling tool branches that branch from this node
        const siblingBranchNodes = siblingBranchesByParent.get(node.uuid);
        if (siblingBranchNodes) {
          messages.push(...siblingBranchNodes);
        }
      }

      return {
        ...summary,
        messages,
      };
    }
    case "codex":
    case "codex-oss":
      return {
        ...summary,
        messages: convertCodexEntries(data.session.entries),
      };
    case "gemini":
      return {
        ...summary,
        messages: convertGeminiMessages(data.session.messages),
      };
    case "opencode":
      return {
        ...summary,
        messages: convertOpenCodeEntries(data.session.messages),
      };
  }
}

// --- Claude Conversion Logic ---

function convertClaudeMessage(
  raw: ClaudeSessionEntry,
  _index: number,
  orphanedToolUses: Set<string>,
): Message {
  // Normalize content blocks - pass through all fields
  let content: string | ContentBlock[] | undefined;
  const rawContent = getMessageContent(raw);
  if (typeof rawContent === "string") {
    content = rawContent;
  } else if (Array.isArray(rawContent)) {
    // Pass through all fields from each content block
    // Filter out string items (which can appear in user message content)
    content = rawContent
      .filter((block) => typeof block !== "string")
      .map((block) => ({ ...(block as object) })) as ContentBlock[];
  }

  // Build message by spreading all raw fields, then override with normalized values
  // Use type assertion since we're converting to a looser Message type
  const rawAny = raw as Record<string, unknown>;
  const message: Message = {
    ...rawAny,
    // Include normalized content if message had content
    ...(isConversationEntry(raw) && {
      message: {
        ...(raw.message as Record<string, unknown>),
        ...(content !== undefined && { content }),
      },
    }),
    // Ensure type is set
    type: raw.type,
  };

  // Identify orphaned tool_use IDs in this message's content
  if (Array.isArray(content)) {
    const orphanedIds = content
      .filter(
        (b): b is ContentBlock & { id: string } =>
          b.type === "tool_use" &&
          typeof b.id === "string" &&
          orphanedToolUses.has(b.id),
      )
      .map((b) => b.id);

    if (orphanedIds.length > 0) {
      message.orphanedToolUseIds = orphanedIds;
    }
  }

  return message;
}

// --- Codex Conversion Logic ---

function convertCodexEntries(entries: CodexSessionEntry[]): Message[] {
  const messages: Message[] = [];
  let messageIndex = 0;
  const hasResponseItemUser = hasCodexResponseItemUserMessages(entries);
  const toolCallContexts = new Map<string, CodexToolCallContext>();

  for (const entry of entries) {
    if (entry.type === "response_item") {
      const msg = convertCodexResponseItem(
        entry,
        messageIndex++,
        toolCallContexts,
      );
      if (msg) {
        messages.push(msg);
      }
    } else if (entry.type === "compacted") {
      const msg = convertCodexCompactedEntry(entry, messageIndex++);
      if (msg) {
        messages.push(msg);
      }
    } else if (entry.type === "event_msg") {
      const shouldIncludeUserMessage =
        entry.payload.type === "user_message" && !hasResponseItemUser;
      const shouldIncludeTurnAborted = entry.payload.type === "turn_aborted";
      const shouldIncludeContextCompacted =
        entry.payload.type === "context_compacted";
      // Skip agent_message and agent_reasoning events when response_item exists;
      // those are streaming artifacts that duplicate full response data.
      if (
        shouldIncludeUserMessage ||
        shouldIncludeTurnAborted ||
        shouldIncludeContextCompacted
      ) {
        const msg = convertCodexEventMsg(entry, messageIndex++);
        if (msg) {
          messages.push(msg);
        }
      }
    }
  }

  return messages;
}

function hasCodexResponseItemUserMessages(
  entries: CodexSessionEntry[],
): boolean {
  return entries.some(
    (entry) =>
      entry.type === "response_item" &&
      entry.payload.type === "message" &&
      entry.payload.role === "user",
  );
}

function convertCodexResponseItem(
  entry: CodexResponseItemEntry,
  index: number,
  toolCallContexts: Map<string, CodexToolCallContext>,
): Message | null {
  const payload = entry.payload;
  const uuid = `codex-${index}-${entry.timestamp}`;

  switch (payload.type) {
    case "message":
      if (payload.role === "developer") {
        return null;
      }
      return convertCodexMessagePayload(payload, uuid, entry.timestamp);

    case "reasoning":
      return convertCodexReasoningPayload(payload, uuid, entry.timestamp);

    case "function_call": {
      const converted = convertCodexFunctionCallPayload(
        payload,
        uuid,
        entry.timestamp,
      );
      toolCallContexts.set(converted.callId, converted.context);
      return converted.message;
    }

    case "function_call_output":
      return convertCodexToolCallOutputPayload(
        payload.call_id,
        payload.output,
        uuid,
        entry.timestamp,
        toolCallContexts.get(payload.call_id),
      );

    case "custom_tool_call": {
      const converted = convertCodexCustomToolCallPayload(
        payload,
        uuid,
        entry.timestamp,
      );
      toolCallContexts.set(converted.callId, converted.context);
      return converted.message;
    }

    case "custom_tool_call_output": {
      const customCallId = payload.call_id ?? `${uuid}-custom-tool-result`;
      return convertCodexToolCallOutputPayload(
        customCallId,
        payload.output,
        uuid,
        entry.timestamp,
        toolCallContexts.get(customCallId),
      );
    }

    case "web_search_call":
      return convertCodexWebSearchCallPayload(payload, uuid, entry.timestamp);

    case "ghost_snapshot":
      return null;

    default:
      return null;
  }
}

function convertCodexMessagePayload(
  payload: CodexMessagePayload,
  uuid: string,
  timestamp: string,
): Message {
  const content: ContentBlock[] = [];

  const fullText = payload.content
    .map((block) =>
      "text" in block && typeof block.text === "string" ? block.text : "",
    )
    .join("");
  if (fullText.trim()) {
    content.push({
      type: "text",
      text: fullText,
    });
  }

  for (const block of payload.content) {
    if (block.type !== "input_image") continue;
    content.push(normalizeCodexInputImageBlock(block));
  }

  if (content.length === 0) {
    return {
      uuid,
      type: payload.role,
      message: {
        role: payload.role,
        content: [],
      },
      timestamp,
    };
  }

  return {
    uuid,
    type: payload.role,
    message: {
      role: payload.role,
      content,
    },
    timestamp,
  };
}

function convertCodexReasoningPayload(
  payload: CodexReasoningPayload,
  uuid: string,
  timestamp: string,
): Message {
  const summaryText = payload.summary
    ?.map((s) => s.text)
    .join("\n")
    .trim();

  const content: ContentBlock[] = [];

  if (summaryText) {
    content.push({
      type: "thinking",
      thinking: summaryText,
    });
  }

  if (payload.encrypted_content && !summaryText) {
    content.push({
      type: "thinking",
      thinking: "Reasoning [internal]",
    });
  }

  return {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
    timestamp,
  };
}

type CodexInputImageBlock = Extract<
  CodexMessagePayload["content"][number],
  { type: "input_image" }
>;

function normalizeCodexInputImageBlock(
  block: CodexInputImageBlock,
): ContentBlock {
  const normalized: ContentBlock = { type: "input_image" };

  const filePath =
    typeof block.file_path === "string" ? block.file_path.trim() : "";
  if (filePath) {
    normalized.file_path = filePath;
  }

  const mimeType = resolveCodexInputImageMimeType(block);
  if (mimeType) {
    normalized.mime_type = mimeType;
  }

  const imageUrl =
    typeof block.image_url === "string" ? block.image_url.trim() : "";
  if (imageUrl && !isDataUrl(imageUrl)) {
    normalized.image_url = imageUrl;
  }

  return normalized;
}

function resolveCodexInputImageMimeType(
  block: CodexInputImageBlock,
): string | undefined {
  const explicitMime =
    typeof block.mime_type === "string" ? block.mime_type.trim() : "";
  if (explicitMime) {
    return explicitMime;
  }

  if (typeof block.image_url !== "string") {
    return undefined;
  }

  const dataUrlMime = parseDataUrlMimeType(block.image_url);
  return dataUrlMime || undefined;
}

function isDataUrl(value: string): boolean {
  return value.startsWith("data:");
}

function parseDataUrlMimeType(dataUrl: string): string | null {
  const match = /^data:([^;,]+)[;,]/i.exec(dataUrl);
  return match?.[1] ?? null;
}

function convertCodexFunctionCallPayload(
  payload: CodexFunctionCallPayload,
  uuid: string,
  timestamp: string,
): CodexToolUseConversion {
  const rawToolName = payload.name;
  const canonicalToolName = canonicalizeCodexToolName(rawToolName);
  const parsedInput = parseCodexToolArguments(payload.arguments);
  const normalizedInvocation = normalizeCodexToolInvocation(
    canonicalToolName,
    parsedInput,
  );

  const content: ContentBlock[] = [
    {
      type: "tool_use",
      id: payload.call_id,
      name: normalizedInvocation.toolName,
      input: normalizedInvocation.input,
    },
  ];

  const message: Message = {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
    codexToolName: rawToolName,
    timestamp,
  };

  return {
    callId: payload.call_id,
    message,
    context: {
      toolName: normalizedInvocation.toolName,
      input: normalizedInvocation.input,
      readShellInfo: normalizedInvocation.readShellInfo,
    },
  };
}

function convertCodexCustomToolCallPayload(
  payload: CodexCustomToolCallPayload,
  uuid: string,
  timestamp: string,
): CodexToolUseConversion {
  const callId = payload.call_id ?? payload.id ?? `${uuid}-custom-tool`;
  const rawToolName = payload.name ?? "custom_tool_call";
  const canonicalToolName = canonicalizeCodexToolName(rawToolName);
  const rawInput =
    payload.input !== undefined
      ? payload.input
      : parseCodexToolArguments(payload.arguments);
  const normalizedInvocation = normalizeCodexToolInvocation(
    canonicalToolName,
    rawInput,
  );

  const content: ContentBlock[] = [
    {
      type: "tool_use",
      id: callId,
      name: normalizedInvocation.toolName,
      input: normalizedInvocation.input,
    },
  ];

  const message: Message = {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
    codexToolName: rawToolName,
    timestamp,
  };

  return {
    callId,
    message,
    context: {
      toolName: normalizedInvocation.toolName,
      input: normalizedInvocation.input,
      readShellInfo: normalizedInvocation.readShellInfo,
    },
  };
}

function convertCodexWebSearchCallPayload(
  payload: CodexWebSearchCallPayload,
  uuid: string,
  timestamp: string,
): Message {
  const callId = payload.call_id ?? payload.id ?? `${uuid}-web-search`;
  const rawToolName = payload.name ?? payload.type;
  const toolName = canonicalizeCodexToolName(rawToolName);

  const parsedArguments = parseCodexToolArguments(payload.arguments);
  let input: Record<string, unknown>;

  if (isRecord(payload.input)) {
    input = { ...payload.input };
  } else if (isRecord(parsedArguments)) {
    input = { ...parsedArguments };
  } else {
    input = {};
  }

  if (typeof payload.query === "string" && typeof input.query !== "string") {
    input.query = payload.query;
  }

  if (payload.action !== undefined && input.action === undefined) {
    input.action = payload.action;
  }

  const content: ContentBlock[] = [
    {
      type: "tool_use",
      id: callId,
      name: toolName,
      input,
    },
  ];

  return {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
    codexToolName: rawToolName,
    timestamp,
  };
}

function convertCodexToolCallOutputPayload(
  callId: string,
  output: unknown,
  uuid: string,
  timestamp: string,
  context?: CodexToolCallContext,
): Message {
  const normalized = normalizeCodexToolOutput(output);
  let content = normalized.content;
  let structured = normalized.structured;
  let isError = normalized.isError;
  const exitCode = normalized.exitCode ?? extractExitCodeFromText(content);

  if (context?.toolName === "Grep") {
    const grepContent = extractCodexShellOutputContent(content);
    const grepResult = normalizeRipgrepOutput(grepContent);
    const isNoMatchesResult = exitCode === 1 && grepResult.numFiles === 0;

    if (!isError || isNoMatchesResult) {
      isError = false;
      structured = grepResult;
      content = grepContent;
    }
  } else if (context?.toolName === "Read" && context.readShellInfo) {
    if (!isError) {
      const readContent = extractCodexShellOutputContent(content);
      const readResult = normalizeReadOutput(
        readContent,
        context.readShellInfo,
      );
      structured = readResult;
      content = readContent;
    }
  }

  const toolResult: ContentBlock = {
    type: "tool_result",
    tool_use_id: callId,
    content,
    ...(isError && { is_error: true }),
  };

  return {
    uuid,
    type: "user",
    message: {
      role: "user",
      content: [toolResult],
    },
    ...(structured !== undefined && {
      toolUseResult: structured,
    }),
    timestamp,
  };
}

function parseCodexToolArguments(argumentsText?: string): unknown {
  if (!argumentsText) {
    return {};
  }
  try {
    return JSON.parse(argumentsText);
  } catch {
    return { raw: argumentsText };
  }
}

function canonicalizeCodexToolName(name: string): string {
  return (
    CODEX_TOOL_NAME_ALIASES[name] ??
    CODEX_TOOL_NAME_ALIASES[name.toLowerCase()] ??
    name
  );
}

function normalizeCodexToolInvocation(
  toolName: string,
  input: unknown,
): NormalizedCodexToolInvocation {
  if (toolName !== "Bash") {
    return { toolName, input };
  }

  let normalizedInput: unknown = input;
  if (typeof input === "string" && input.trim()) {
    normalizedInput = { command: input };
  } else if (isRecord(input)) {
    const normalized = { ...input };
    if (
      typeof normalized.command !== "string" &&
      typeof normalized.cmd === "string"
    ) {
      normalized.command = normalized.cmd;
    }
    normalizedInput = normalized;
  }

  const command = extractBashCommand(normalizedInput);
  if (!command) {
    return { toolName: "Bash", input: normalizedInput };
  }

  const readShellInfo = parseReadShellCommand(command);
  if (readShellInfo) {
    return {
      toolName: "Read",
      input: createReadToolInput(readShellInfo),
      readShellInfo,
    };
  }

  const grepInput = parseRipgrepCommand(command);
  if (grepInput) {
    return {
      toolName: "Grep",
      input: grepInput,
    };
  }

  return { toolName: "Bash", input: normalizedInput };
}

function extractBashCommand(input: unknown): string {
  if (!isRecord(input)) return "";
  if (typeof input.command === "string" && input.command.trim()) {
    return input.command.trim();
  }
  if (typeof input.cmd === "string" && input.cmd.trim()) {
    return input.cmd.trim();
  }
  return "";
}

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (!char) continue;

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function parseLineRangeToken(
  token: string,
): { startLine: number; endLine: number } | null {
  const match = token.match(/^(\d+)(?:,(\d+))?p$/);
  if (!match?.[1]) return null;

  const startLine = Number.parseInt(match[1], 10);
  const endLine = match[2] ? Number.parseInt(match[2], 10) : startLine;
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    return null;
  }

  return {
    startLine,
    endLine: Math.max(startLine, endLine),
  };
}

function parseReadShellCommand(command: string): CodexReadShellInfo | null {
  const tokens = tokenizeShellCommand(command);
  if (tokens.length === 0) return null;

  if (tokens[0] === "cat" && tokens.length === 2) {
    const filePath = tokens[1];
    if (!filePath || filePath.startsWith("-")) {
      return null;
    }
    return {
      filePath,
      stripLineNumbers: false,
    };
  }

  if (tokens[0] === "sed" && tokens[1] === "-n" && tokens.length === 4) {
    const range = parseLineRangeToken(tokens[2] ?? "");
    const filePath = tokens[3];
    if (!range || !filePath || filePath.startsWith("-")) {
      return null;
    }
    return {
      filePath,
      startLine: range.startLine,
      endLine: range.endLine,
      stripLineNumbers: false,
    };
  }

  const isNlSedCommand =
    tokens[0] === "nl" &&
    tokens[1] === "-ba" &&
    tokens[3] === "|" &&
    tokens[4] === "sed" &&
    tokens[5] === "-n" &&
    tokens.length === 7;
  if (isNlSedCommand) {
    const filePath = tokens[2];
    const range = parseLineRangeToken(tokens[6] ?? "");
    if (!filePath || !range) return null;
    return {
      filePath,
      startLine: range.startLine,
      endLine: range.endLine,
      stripLineNumbers: true,
    };
  }

  return null;
}

function createReadToolInput(
  readInfo: CodexReadShellInfo,
): Record<string, unknown> {
  const input: Record<string, unknown> = { file_path: readInfo.filePath };

  if (readInfo.startLine !== undefined) {
    input.offset = readInfo.startLine;
  }
  if (
    readInfo.startLine !== undefined &&
    readInfo.endLine !== undefined &&
    readInfo.endLine >= readInfo.startLine
  ) {
    input.limit = readInfo.endLine - readInfo.startLine + 1;
  }

  return input;
}

function parseRipgrepCommand(command: string): Record<string, unknown> | null {
  const tokens = tokenizeShellCommand(command);
  if (tokens[0] !== "rg" || tokens.length < 2) {
    return null;
  }

  // Skip shell pipelines/chaining for safety; only classify direct search calls.
  if (
    tokens.some((token) => token === "|" || token === "&&" || token === ";")
  ) {
    return null;
  }

  const flagsWithValue = new Set([
    "-g",
    "--glob",
    "-e",
    "--regexp",
    "-f",
    "--file",
    "-m",
    "--max-count",
    "-A",
    "--after-context",
    "-B",
    "--before-context",
    "-C",
    "--context",
    "-t",
    "--type",
    "-T",
    "--type-not",
  ]);

  let pattern = "";
  const searchPaths: string[] = [];

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    if (token === "--") {
      const rest = tokens.slice(i + 1).filter(Boolean);
      if (!pattern && rest[0]) {
        pattern = rest[0];
      }
      if (pattern) {
        searchPaths.push(...rest.slice(1));
      }
      break;
    }

    if (token === "-e" || token === "--regexp") {
      const next = tokens[i + 1];
      if (next && !pattern) {
        pattern = next;
      }
      i += 1;
      continue;
    }

    if (flagsWithValue.has(token)) {
      i += 1;
      continue;
    }

    if (token.startsWith("--glob=") || token.startsWith("--regexp=")) {
      if (token.startsWith("--regexp=") && !pattern) {
        pattern = token.slice("--regexp=".length);
      }
      continue;
    }

    if (token.startsWith("-")) {
      continue;
    }

    if (!pattern) {
      pattern = token;
    } else {
      searchPaths.push(token);
    }
  }

  if (!pattern) {
    return null;
  }

  const input: Record<string, unknown> = {
    pattern,
    output_mode: "content",
  };
  if (searchPaths.length > 0) {
    input.path = searchPaths.join(" ");
  }
  return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseNumericExitCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return undefined;
}

function extractExitCodeFromRecord(
  record: Record<string, unknown>,
): number | undefined {
  const direct = parseNumericExitCode(record.exit_code ?? record.exitCode);
  if (direct !== undefined) {
    return direct;
  }

  const metadata = record.metadata;
  if (isRecord(metadata)) {
    const nested = parseNumericExitCode(
      metadata.exit_code ?? metadata.exitCode,
    );
    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

function hasFailedStatus(record: Record<string, unknown>): boolean {
  const status = record.status;
  if (typeof status !== "string") {
    return false;
  }
  const normalized = status.toLowerCase();
  return normalized === "failed" || normalized === "error";
}

function extractExitCodeFromText(output: string): number | undefined {
  const match = output.match(
    /(?:^|\n)\s*(?:Exit code:|Process exited with code)\s*(-?\d+)\b/i,
  );
  if (!match?.[1]) {
    return undefined;
  }
  return Number.parseInt(match[1], 10);
}

function normalizeCodexToolOutput(output: unknown): {
  content: string;
  structured?: unknown;
  isError: boolean;
  exitCode?: number;
} {
  if (typeof output === "string") {
    let structured: unknown;
    let isError = false;
    let content = output;
    let exitCode: number | undefined;

    try {
      structured = JSON.parse(output);
      if (typeof structured === "string") {
        content = structured;
        exitCode = extractExitCodeFromText(structured);
        if (exitCode !== undefined) {
          isError = exitCode !== 0;
        }
      } else if (isRecord(structured)) {
        exitCode = extractExitCodeFromRecord(structured);
        isError =
          structured.is_error === true ||
          (exitCode !== undefined && exitCode !== 0) ||
          hasFailedStatus(structured);
      }
    } catch {
      structured = undefined;
      exitCode = extractExitCodeFromText(output);
      if (exitCode !== undefined) {
        isError = exitCode !== 0;
      } else {
        // For plain text without exit metadata, only treat explicit error lines as failures.
        isError = /(?:^|\n)\s*(error|fatal|failed):/i.test(output);
      }
    }

    return { content, structured, isError, exitCode };
  }

  if (output === null || output === undefined) {
    return { content: "", isError: false };
  }

  if (typeof output === "number" || typeof output === "boolean") {
    return {
      content: String(output),
      structured: output,
      isError: false,
    };
  }

  if (Array.isArray(output) || isRecord(output)) {
    const exitCode = isRecord(output)
      ? extractExitCodeFromRecord(output)
      : undefined;
    const isError =
      isRecord(output) &&
      (output.is_error === true ||
        (exitCode ?? 0) !== 0 ||
        hasFailedStatus(output));
    return {
      content: JSON.stringify(output, null, 2),
      structured: output,
      isError,
      exitCode,
    };
  }

  return { content: String(output), isError: false };
}

function extractCodexShellOutputContent(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const inlineMarker = "Output:\n";
  if (normalized.startsWith(inlineMarker)) {
    return normalized.slice(inlineMarker.length);
  }

  const marker = "\nOutput:\n";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) {
    return normalized;
  }

  const rawOutput = normalized.slice(markerIndex + marker.length);
  return rawOutput.startsWith("\n") ? rawOutput.slice(1) : rawOutput;
}

function normalizeRipgrepOutput(output: string): {
  mode: "files_with_matches" | "content";
  filenames: string[];
  numFiles: number;
  content?: string;
  numLines?: number;
} {
  const normalized = output.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (!normalized.trim()) {
    return {
      mode: "files_with_matches",
      filenames: [],
      numFiles: 0,
    };
  }

  const lines = normalized.split("\n");
  const hasLineBasedMatches = lines.some(
    (line) => /^.+:\d+(?::|-)/.test(line) || /^\d+(?::|-)/.test(line),
  );

  if (hasLineBasedMatches) {
    const filenames = Array.from(
      new Set(
        lines
          .map(extractFilenameFromRipgrepLine)
          .filter((file): file is string => !!file),
      ),
    );

    const numFiles = filenames.length > 0 ? filenames.length : 1;
    return {
      mode: "content",
      filenames,
      numFiles,
      content: normalized,
      numLines: lines.length,
    };
  }

  const filenames = Array.from(
    new Set(lines.map((line) => line.trim()).filter((line) => line.length > 0)),
  );
  return {
    mode: "files_with_matches",
    filenames,
    numFiles: filenames.length,
  };
}

function extractFilenameFromRipgrepLine(line: string): string | null {
  const match = line.match(/^(.+?):\d+(?::|-)/);
  if (match?.[1]) {
    return match[1];
  }
  return null;
}

function normalizeReadOutput(
  output: string,
  readInfo: CodexReadShellInfo,
): {
  type: "text";
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
  };
} {
  const normalized = output.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let startLine = readInfo.startLine ?? 1;

  const contentLines = readInfo.stripLineNumbers
    ? lines.map((line, index) => {
        const match = line.match(/^\s*(\d+)\s+(.*)$/);
        if (match?.[1]) {
          if (index === 0) {
            startLine = Number.parseInt(match[1], 10);
          }
          return match[2] ?? "";
        }
        return line;
      })
    : lines;

  const content = contentLines.join("\n");
  const numLines = countContentLines(content);
  const computedEndLine =
    numLines > 0 ? startLine + numLines - 1 : (readInfo.endLine ?? startLine);
  const totalLines = Math.max(
    readInfo.endLine ?? computedEndLine,
    computedEndLine,
  );

  return {
    type: "text",
    file: {
      filePath: readInfo.filePath,
      content,
      numLines,
      startLine,
      totalLines,
    },
  };
}

function countContentLines(content: string): number {
  if (!content) {
    return 0;
  }

  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length;
}

function convertCodexCompactedEntry(
  entry: CodexCompactedEntry,
  index: number,
): Message {
  const uuid = `codex-compacted-${index}-${entry.timestamp}`;
  return {
    uuid,
    type: "system",
    subtype: "compact_boundary",
    content: entry.payload.message || "Context compacted",
    timestamp: entry.timestamp,
  };
}

function convertCodexEventMsg(
  entry: CodexEventMsgEntry,
  index: number,
): Message | null {
  const payload = entry.payload;
  const uuid = `codex-event-${index}-${entry.timestamp}`;

  switch (payload.type) {
    case "user_message":
      return {
        uuid,
        type: "user",
        message: {
          role: "user",
          content: payload.message,
        },
        timestamp: entry.timestamp,
      };

    case "agent_message":
      return {
        uuid,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: payload.message }],
        },
        timestamp: entry.timestamp,
      };

    case "agent_reasoning":
      return {
        uuid,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: payload.text }],
        },
        timestamp: entry.timestamp,
      };

    case "turn_aborted":
      return {
        uuid,
        type: "system",
        subtype: "turn_aborted",
        content: payload.reason ?? payload.message ?? "Turn aborted",
        timestamp: entry.timestamp,
      };

    case "context_compacted":
      return {
        uuid,
        type: "system",
        subtype: "compact_boundary",
        content: "Context compacted",
        timestamp: entry.timestamp,
      };

    case "item_completed":
      return null;

    default:
      return null;
  }
}

// --- Gemini Conversion Logic ---

function convertGeminiMessages(
  sessionMessages: GeminiSessionMessage[],
): Message[] {
  const messages: Message[] = [];
  for (const msg of sessionMessages) {
    if (msg.type === "user") {
      const userMsg = msg as GeminiUserMessage;
      messages.push({
        uuid: userMsg.id,
        type: "user",
        message: {
          role: "user",
          content: getGeminiUserMessageText(userMsg.content),
        },
        timestamp: userMsg.timestamp,
      });
    } else if (msg.type === "gemini") {
      const assistantMsg = msg as GeminiAssistantMessage;
      const content: ContentBlock[] = [];

      if (assistantMsg.thoughts) {
        for (const thought of assistantMsg.thoughts) {
          content.push({
            type: "thinking",
            thinking: `${thought.subject}: ${thought.description}`,
          });
        }
      }

      if (assistantMsg.content) {
        content.push({
          type: "text",
          text: assistantMsg.content,
        });
      }

      if (assistantMsg.toolCalls) {
        for (const toolCall of assistantMsg.toolCalls) {
          content.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.args,
          });
        }
      }

      messages.push({
        uuid: assistantMsg.id,
        type: "assistant",
        message: {
          role: "assistant",
          content,
        },
        timestamp: assistantMsg.timestamp,
      });

      if (assistantMsg.toolCalls) {
        for (const toolCall of assistantMsg.toolCalls) {
          if (toolCall.result && toolCall.result.length > 0) {
            for (const result of toolCall.result) {
              messages.push({
                uuid: `${assistantMsg.id}-result-${result.functionResponse.id}`,
                type: "tool_result",
                toolUseResult: {
                  tool_use_id: result.functionResponse.id,
                  content: result.functionResponse.response.output,
                },
                timestamp: toolCall.timestamp ?? assistantMsg.timestamp,
              });
            }
          }
        }
      }
    }
  }
  return messages;
}

// --- OpenCode Conversion Logic ---

function convertOpenCodeEntries(entries: OpenCodeSessionEntry[]): Message[] {
  const messages: Message[] = [];

  for (const entry of entries) {
    const { message, parts } = entry;
    const uuid = message.id;
    const timestamp = message.time?.created
      ? new Date(message.time.created).toISOString()
      : undefined;

    const content = convertOpenCodeParts(parts);

    messages.push({
      uuid,
      type: message.role,
      message: {
        role: message.role,
        content,
        model: message.modelID,
        usage: message.tokens
          ? {
              input_tokens: message.tokens.input,
              output_tokens: message.tokens.output,
              cache_read_input_tokens: message.tokens.cache?.read,
            }
          : undefined,
      },
      timestamp,
      // Include OpenCode-specific fields
      ...(message.parentID && { parentId: message.parentID }),
      ...(message.mode && { mode: message.mode }),
      ...(message.agent && { agent: message.agent }),
      ...(message.finish && { finish: message.finish }),
    });
  }

  return messages;
}

function convertOpenCodeParts(parts: OpenCodeStoredPart[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (part.text) {
          blocks.push({
            type: "text",
            text: part.text,
          });
        }
        break;

      case "tool":
        if (part.tool && part.callID) {
          // Tool use block
          blocks.push({
            type: "tool_use",
            id: part.callID,
            name: part.tool,
            input: part.state?.input ?? {},
          });

          // If tool has completed, add tool result block
          if (part.state?.status === "completed") {
            const resultContent = part.state.error
              ? part.state.error
              : typeof part.state.output === "string"
                ? part.state.output
                : JSON.stringify(part.state.output ?? "");

            blocks.push({
              type: "tool_result",
              tool_use_id: part.callID,
              content: resultContent,
              is_error: !!part.state.error,
            });
          }
        }
        break;

      // Skip step-start and step-finish (metadata, not content)
      case "step-start":
      case "step-finish":
        break;

      default:
        // Unknown part type - skip
        break;
    }
  }

  return blocks;
}
