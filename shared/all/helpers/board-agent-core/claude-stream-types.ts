export interface ClaudeTypes {
  type: RoleEnum;
  subtype?: string;
  cwd?: string;
  session_id: string;
  tools?: string[];
  mcp_servers?: MCPServer[];
  model?: Model;
  permissionMode?: string;
  slash_commands?: string[];
  apiKeySource?: string;
  claude_code_version?: string;
  output_style?: string;
  agents?: string[];
  skills?: string[];
  plugins?: Plugin[];
  uuid: string;
  fast_mode_state?: string;
  message?: Message;
  parent_tool_use_id?: ToolUseID | null;
  timestamp?: Date;
  tool_use_result?: ToolUseResultClass | string;
  rate_limit_info?: RateLimitInfo;
  task_id?: ID;
  tool_use_id?: ToolUseID;
  description?: string;
  task_type?: string;
  prompt?: string;
  usage?: ToolUseResultUsage;
  last_tool_name?: string;
  status?: string;
  output_file?: string;
  summary?: string;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  result?: string;
  stop_reason?: string;
  total_cost_usd?: number;
  modelUsage?: ModelUsage;
  permission_denials?: unknown[];
}

export interface MCPServer {
  name: string;
  status: string;
}

export interface Message {
  model?: Model;
  id?: string;
  type?: PurpleType;
  role: RoleEnum;
  content: MessageContent[];
  stop_reason?: null;
  stop_sequence?: null;
  usage?: MessageUsage;
  context_management?: null;
}

export interface MessageContent {
  type: ContentType;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Input;
  caller?: Caller;
  tool_use_id?: string;
  content?: ContentContentClass[] | string;
  text?: string;
  is_error?: boolean;
}

export interface Caller {
  type: CallerType;
}

export enum CallerType {
  Direct = 'direct'
}

export interface ContentContentClass {
  type: ContentType;
  text: string;
}

export enum ContentType {
  Text = 'text',
  Thinking = 'thinking',
  ToolResult = 'tool_result',
  ToolUse = 'tool_use'
}

export interface Input {
  pattern?: string;
  '-i'?: boolean;
  glob?: string;
  subagent_type?: string;
  description?: string;
  prompt?: string;
  command?: string;
  path?: string;
  output_mode?: string;
  file_path?: string;
  limit?: number;
  offset?: number;
  replace_all?: boolean;
  old_string?: string;
  new_string?: string;
}

export enum Model {
  ClaudeHaiku4520251001 = 'claude-haiku-4-5-20251001',
  ClaudeOpus46 = 'claude-opus-4-6'
}

export enum RoleEnum {
  Assistant = 'assistant',
  RateLimitEvent = 'rate_limit_event',
  Result = 'result',
  System = 'system',
  User = 'user'
}

export enum PurpleType {
  Message = 'message'
}

export interface MessageUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: CacheCreation;
  output_tokens: number;
  service_tier: ServiceTier;
  inference_geo: InferenceGeo;
}

export interface CacheCreation {
  ephemeral_5m_input_tokens: number;
  ephemeral_1h_input_tokens: number;
}

export enum InferenceGeo {
  NotAvailable = 'not_available'
}

export enum ServiceTier {
  Standard = 'standard'
}

export interface ModelUsage {
  'claude-opus-4-6': Claude;
  'claude-haiku-4-5-20251001': Claude;
}

export interface Claude {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}

export enum ToolUseID {
  Toolu016FCbEs6CZ7Im37FupHA1VW = 'toolu_016FCbEs6cZ7im37fupHA1VW'
}

export interface Plugin {
  name: string;
  path: string;
}

export interface RateLimitInfo {
  status: string;
  resetsAt: number;
  rateLimitType: string;
  overageStatus: string;
  overageDisabledReason: string;
  isUsingOverage: boolean;
}

export enum ID {
  Aed4Bf9C332331598 = 'aed4bf9c332331598'
}

export interface ToolUseResultClass {
  mode?: string;
  filenames?: string[];
  numFiles?: number;
  durationMs?: number;
  truncated?: boolean;
  status?: string;
  prompt?: string;
  agentId?: ID;
  content?: ContentContentClass[];
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  usage?: ToolUseResultUsage;
  type?: ContentType;
  file?: FileResult;
  filePath?: string;
  oldString?: string;
  newString?: string;
  originalFile?: string;
  structuredPatch?: StructuredPatch[];
  userModified?: boolean;
  replaceAll?: boolean;
}

export interface FileResult {
  filePath: string;
  content: string;
  numLines: number;
  startLine: number;
  totalLines: number;
}

export interface StructuredPatch {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface ToolUseResultUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  server_tool_use?: ServerToolUse;
  service_tier?: ServiceTier;
  cache_creation?: CacheCreation;
  inference_geo?: string;
  iterations?: unknown[];
  speed?: ServiceTier;
  total_tokens?: number;
  tool_uses?: number;
  duration_ms?: number;
}

export interface ServerToolUse {
  web_search_requests: number;
  web_fetch_requests: number;
}
