import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";

export async function runGeminiCliJsonAnalysis(input) {
  const cliPath = String(input.cliPath || "").trim();
  if (!cliPath) throw new Error("Gemini CLI path is not configured.");
  if (looksLikeFilePath(cliPath) && !existsSync(cliPath)) {
    throw new Error(`Gemini CLI executable not found: ${cliPath}`);
  }
  assertAllowedGeminiCliModel(input.model, {
    allowUnsafeModel: input.allowUnsafeModel,
    safeModels: input.safeModels,
  });

  const startedAt = Date.now();
  const workspaceDir = resolve(input.workspaceRoot, safePathSegment(input.runId || `analysis-${startedAt}`));
  mkdirSync(workspaceDir, { recursive: true });

  const copiedFiles = [];
  for (const [index, filePath] of (input.filePaths || []).filter(Boolean).entries()) {
    if (!existsSync(filePath)) continue;
    const fileName = `${String(index + 1).padStart(2, "0")}-${safePathSegment(basename(filePath))}`;
    const targetPath = join(workspaceDir, fileName);
    copyFileSync(filePath, targetPath);
    copiedFiles.push(targetPath);
  }

  const prompt = [
    String(input.prompt || "").trim(),
    copiedFiles.length
      ? [
          "",
          "Local files available in this workspace. Use view_file for every image file before answering:",
          ...copiedFiles.map((filePath) => `- ${filePath}`),
        ].join("\n")
      : "",
    "",
    "Return exactly one compact JSON object. Do not include markdown.",
  ]
    .filter(Boolean)
    .join("\n");

  const promptPath = join(workspaceDir, "prompt.txt");
  const logPath = join(workspaceDir, "agy.log");
  writeFileSync(promptPath, prompt, "utf8");

  const args = [
    "--model",
    input.model,
    "--dangerously-skip-permissions",
    "--log-file",
    logPath,
    "--print-timeout",
    `${Math.ceil((input.timeoutMs || 120_000) / 1000)}s`,
    "--print",
    prompt,
  ].filter((value) => value !== undefined && value !== null && value !== "");

  const execution = await runProcess(cliPath, args, {
    cwd: workspaceDir,
    timeoutMs: input.timeoutMs || 120_000,
  });
  const transcriptPath = findTranscriptPath(logPath, execution.stdout, execution.stderr);
  const transcript = transcriptPath ? readTranscript(transcriptPath) : [];
  const conversationDbPath = findConversationDbPath(logPath, execution.stdout, execution.stderr);
  const dbExtraction = conversationDbPath ? extractResultFromConversationDb(conversationDbPath) : null;
  const rawText = finalPlannerResponse(transcript) || execution.stdout.trim() || dbExtraction?.rawText || "";
  const result = parseJsonObject(rawText);
  const modelResolution = readModelResolution(logPath, execution.stdout, execution.stderr);
  const usage = {
    calls: 1,
    success: execution.exitCode === 0 && Boolean(result),
    image_files: copiedFiles.length,
    view_file_calls: Math.max(
      countTranscriptTool(transcript, "VIEW_FILE"),
      dbExtraction?.viewFileCalls || 0,
    ),
    stream_calls: Math.max(
      countTranscriptText(transcript, "streamGenerateContent"),
      dbExtraction?.streamCalls || 0,
    ),
    elapsed_ms: Date.now() - startedAt,
    exit_code: execution.exitCode,
    requested_model: input.model,
    resolved_model: modelResolution.resolvedModel || null,
    model_resolution_failed: modelResolution.failed,
  };

  if (execution.exitCode !== 0) {
    throw new Error(`Gemini CLI exited ${execution.exitCode}: ${tail(execution.stderr || execution.stdout, 1200)}`);
  }
  if (modelResolution.failed) {
    const error = new Error(
      `Gemini CLI did not recognize model "${input.model}" and resolved to "${modelResolution.resolvedModel || "unknown"}". Choose an exact Antigravity model label before running analysis.`,
    );
    error.geminiCliUsage = usage;
    throw error;
  }
  if (!result) {
    const error = new Error(`Gemini CLI returned invalid JSON: ${tail(rawText || execution.stdout || execution.stderr, 1200)}`);
    error.geminiCliUsage = usage;
    error.geminiCliRawText = rawText;
    throw error;
  }

  return {
    ok: true,
    provider: "gemini-cli",
    model: input.model,
    result,
    raw_text: rawText,
    usage,
    workspace_dir: workspaceDir,
    prompt_path: promptPath,
    log_path: logPath,
    transcript_path: transcriptPath,
    conversation_db_path: conversationDbPath,
    copied_files: copiedFiles,
    stdout: tail(execution.stdout, 4000),
    stderr: tail(execution.stderr, 4000),
  };
}

function assertAllowedGeminiCliModel(model, options = {}) {
  if (options.allowUnsafeModel) return;

  const requested = normalizeModelLabel(model);
  const safeModels = (options.safeModels && options.safeModels.length ? options.safeModels : ["gemini-2.5-flash-lite"])
    .map(normalizeModelLabel)
    .filter(Boolean);

  if (safeModels.includes(requested)) return;

  throw new Error(
    [
      `Gemini CLI model "${model || "unknown"}" is not in the AwardPing safe model list.`,
      `Allowed by default: ${safeModels.join(", ") || "none"}.`,
      "Use AWARDPING_SAFE_GEMINI_CLI_MODELS to add exact low-cost labels, or AWARDPING_ALLOW_UNSAFE_GEMINI_CLI_MODEL=true for a deliberate manual override.",
    ].join(" "),
  );
}

function normalizeModelLabel(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function runProcess(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      rejectRun(new Error(`Gemini CLI timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveRun({ exitCode: exitCode || 0, stdout, stderr });
    });
  });
}

function findTranscriptPath(logPath, stdout, stderr) {
  for (const value of [logPath, stdout, stderr].filter(Boolean)) {
    const text = existsSync(value) ? readFileSync(value, "utf8") : String(value);
    const direct = text.match(/[A-Z]:\\[^\r\n"]+?transcript\.jsonl/i)?.[0];
    if (direct && existsSync(direct)) return direct;
    const conversation = text.match(/brain[\\/]+([0-9a-f-]{36})/i)?.[1];
    if (conversation) {
      const candidate = resolve(
        process.env.USERPROFILE || "",
        ".gemini",
        "antigravity-cli",
        "brain",
        conversation,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function readModelResolution(logPath, stdout, stderr) {
  const text = [logPath, stdout, stderr]
    .filter(Boolean)
    .map((value) => (existsSync(value) ? readFileSync(value, "utf8") : String(value)))
    .join("\n");
  const labels = [...text.matchAll(/Propagating selected model override to backend: label="([^"]+)"/g)]
    .map((match) => match[1])
    .filter(Boolean);
  return {
    failed: /Failed to resolve model flag/i.test(text),
    resolvedModel: labels.at(-1) || null,
  };
}

function findConversationDbPath(logPath, stdout, stderr) {
  const home = process.env.USERPROFILE || "";
  for (const value of [logPath, stdout, stderr].filter(Boolean)) {
    const text = existsSync(value) ? readFileSync(value, "utf8") : String(value);
    const conversationId =
      text.match(/conversation=([0-9a-f-]{36})/i)?.[1] ||
      text.match(/Created conversation\s+([0-9a-f-]{36})/i)?.[1] ||
      text.match(/brain[\\/]+([0-9a-f-]{36})/i)?.[1];
    if (!conversationId) continue;
    const candidate = resolve(home, ".gemini", "antigravity-cli", "conversations", `${conversationId}.db`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function extractResultFromConversationDb(path) {
  let text = "";
  try {
    text = readFileSync(path).toString("utf8");
  } catch {
    return null;
  }

  const candidates = [
    ...parseJsonObjects(text),
    ...parseLikelyJsonFragments(text),
  ].filter(isLikelyModelResult);
  const selected = candidates.at(-1);
  if (!selected) {
    return {
      rawText: "",
      viewFileCalls: countViewFileActions(text),
      streamCalls: countTextOccurrences(text, "streamGenerateContent"),
    };
  }

  return {
    rawText: selected.rawText,
    viewFileCalls: countViewFileActions(text),
    streamCalls: countTextOccurrences(text, "streamGenerateContent"),
  };
}

function parseJsonObjects(text) {
  const results = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const rawText = text.slice(start, index + 1);
          if (rawText.length <= 250_000) {
            const parsed = parseJsonCandidate(rawText);
            if (parsed) {
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                results.push({ rawText: sanitizeJsonCandidate(rawText), parsed });
              }
            }
          }
          start = index;
          break;
        }
      }
    }
  }
  return results;
}

function parseLikelyJsonFragments(text) {
  const results = [];
  const startPattern = /\{\s*"(?:status|summary|deadline|is_true_change|reviews|page_purpose)"/g;
  let match = null;
  while ((match = startPattern.exec(text))) {
    const start = match.index;
    const maxEnd = Math.min(text.length, start + 250_000);
    for (let end = start; end < maxEnd; end += 1) {
      if (text[end] !== "}") continue;
      const rawText = text.slice(start, end + 1);
      const parsed = parseJsonCandidate(rawText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        results.push({ rawText: sanitizeJsonCandidate(rawText), parsed });
        break;
      }
    }
  }
  return results;
}

function isLikelyModelResult(candidate) {
  const value = candidate.parsed;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.$schema || value.properties || value.toolSummary || value.toolAction) return false;
  if (value.AbsolutePath || value.DirectoryPath || value.SearchPath || value.TargetFile) return false;
  return (
    Object.prototype.hasOwnProperty.call(value, "is_true_change") ||
    Object.prototype.hasOwnProperty.call(value, "reviews") ||
    Object.prototype.hasOwnProperty.call(value, "deadline") ||
    Object.prototype.hasOwnProperty.call(value, "requirements") ||
    Object.prototype.hasOwnProperty.call(value, "eligibility") ||
    Object.prototype.hasOwnProperty.call(value, "award_amounts") ||
    (Object.prototype.hasOwnProperty.call(value, "summary") &&
      Object.prototype.hasOwnProperty.call(value, "confidence")) ||
    Object.prototype.hasOwnProperty.call(value, "page_purpose")
  );
}

function readTranscript(path) {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function finalPlannerResponse(transcript) {
  return transcript
    .filter((entry) => entry?.source === "MODEL" && entry?.type === "PLANNER_RESPONSE" && entry?.content)
    .map((entry) => String(entry.content).trim())
    .filter(Boolean)
    .at(-1) || "";
}

function countTranscriptTool(transcript, name) {
  const needle = String(name || "").toUpperCase();
  return transcript.filter((entry) => String(entry?.type || "").toUpperCase() === needle).length;
}

function countTranscriptText(transcript, value) {
  const needle = String(value || "");
  if (!needle) return 0;
  return transcript.filter((entry) => JSON.stringify(entry).includes(needle)).length;
}

function countTextOccurrences(text, value) {
  const needle = String(value || "");
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

function countViewFileActions(text) {
  return (
    countTextOccurrences(text, "\"toolSummary\":\"Viewing image\"") ||
    countTextOccurrences(text, "\"toolAction\":\"Viewing") ||
    0
  );
}

function parseJsonObject(text) {
  const clean = sanitizeJsonCandidate(String(text || ""))
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  if (!clean) return null;
  const parsed = parseJsonCandidate(clean);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;

  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  const matched = parseJsonCandidate(match[0]);
  return matched && typeof matched === "object" && !Array.isArray(matched) ? matched : null;
}

function parseJsonCandidate(value) {
  for (const candidate of [String(value || ""), sanitizeJsonCandidate(value)]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep scanning; protobuf blobs can inject non-JSON bytes into otherwise valid text.
    }
  }
  return null;
}

function sanitizeJsonCandidate(value) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/g, "")
    .replace(/,\s*([}\]])/g, "$1");
}

function safePathSegment(value) {
  return String(value || "analysis")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "analysis";
}

function tail(value, maxLength) {
  const text = String(value || "");
  return text.length <= maxLength ? text : text.slice(text.length - maxLength);
}

function looksLikeFilePath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\") || value.includes("/");
}
