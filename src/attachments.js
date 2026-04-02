import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const MAX_INLINE_TRANSCRIPT_CHARS = 4000;

export function extractTelegramPrompt(message) {
  return String(message.text || message.caption || "").trim();
}

export function extractTelegramAttachments(message) {
  const attachments = [];

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = [...message.photo]
      .sort((left, right) => (right.file_size || 0) - (left.file_size || 0))[0];

    attachments.push({
      kind: "image",
      fileId: String(photo.file_id || ""),
      fileUniqueId: String(photo.file_unique_id || ""),
      fileName: `telegram-photo-${message.message_id || Date.now()}.jpg`,
      mimeType: "image/jpeg",
      fileSize: photo.file_size ?? null,
      durationSeconds: null,
    });
  }

  if (message.document?.file_id) {
    const mimeType = String(message.document.mime_type || "");
    attachments.push({
      kind: mimeType.startsWith("image/") ? "image" : "document",
      fileId: String(message.document.file_id || ""),
      fileUniqueId: String(message.document.file_unique_id || ""),
      fileName: String(message.document.file_name || ""),
      mimeType,
      fileSize: message.document.file_size ?? null,
      durationSeconds: null,
    });
  }

  if (message.voice?.file_id) {
    attachments.push({
      kind: "voice",
      fileId: String(message.voice.file_id || ""),
      fileUniqueId: String(message.voice.file_unique_id || ""),
      fileName: `telegram-voice-${message.message_id || Date.now()}.ogg`,
      mimeType: String(message.voice.mime_type || "audio/ogg"),
      fileSize: message.voice.file_size ?? null,
      durationSeconds: message.voice.duration ?? null,
    });
  }

  return attachments.filter((attachment) => attachment.fileId);
}

export function buildTopicPrompt(message) {
  const prompt = extractTelegramPrompt(message);
  const attachments = extractTelegramAttachments(message);

  if (prompt) {
    return prompt;
  }

  if (attachments.length === 0) {
    return "";
  }

  if (attachments.length === 1 && attachments[0].kind === "voice") {
    return "Please continue from this Telegram voice note.";
  }

  return "Please inspect the Telegram attachments and continue.";
}

export async function prepareTelegramAttachments({
  job,
  telegram,
  runtime,
  logger = console,
}) {
  const attachments = Array.isArray(job.attachments) ? job.attachments : [];

  if (attachments.length === 0) {
    return {
      prompt: String(job.prompt || "").trim(),
      imagePaths: [],
      extraDirs: [],
      cleanup: async () => {},
    };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tether-attachments-"));
  const imagePaths = [];
  const summaryLines = [
    `Telegram attachments: ${attachments.length}`,
    `attachment_dir: ${tempDir}`,
  ];

  try {
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      const downloaded = await downloadAttachment(telegram, attachment, tempDir, index);

      if (attachment.kind === "image") {
        imagePaths.push(downloaded.path);
      }

      if (attachment.kind === "voice") {
        const transcript = await transcribeVoiceAttachment(downloaded.path, tempDir, runtime, logger);
        summaryLines.push(
          `- voice: ${downloaded.path}${attachment.durationSeconds ? ` (${attachment.durationSeconds}s)` : ""}`,
        );
        if (transcript.path) {
          summaryLines.push(`  transcript_file: ${transcript.path}`);
        }
        if (transcript.text) {
          summaryLines.push(`  transcript: ${transcript.text}`);
        } else if (transcript.error) {
          summaryLines.push(`  transcript_error: ${transcript.error}`);
        }
        continue;
      }

      summaryLines.push(
        `- ${attachment.kind}: ${downloaded.path}${attachment.mimeType ? ` (${attachment.mimeType})` : ""}`,
      );
    }

    const prompt = [
      "Telegram attachment context:",
      ...summaryLines,
      "",
      String(job.prompt || "").trim() || "Please inspect the Telegram attachments and continue.",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      prompt,
      imagePaths,
      extraDirs: [tempDir],
      cleanup: async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function downloadAttachment(telegram, attachment, tempDir, index) {
  const file = await telegram.getFile(attachment.fileId);

  if (!file?.file_path) {
    throw new Error(`Telegram file path missing for attachment ${attachment.fileId}.`);
  }

  const buffer = await telegram.downloadFile(file.file_path);
  const fileName = sanitizeFileName(
    attachment.fileName ||
      `${attachment.kind}-${index + 1}${path.extname(file.file_path) || guessExtension(attachment)}`,
  );
  const targetPath = path.join(tempDir, fileName);

  await fs.writeFile(targetPath, buffer);

  return {
    path: targetPath,
    filePath: file.file_path,
  };
}

async function transcribeVoiceAttachment(audioPath, tempDir, runtime, logger) {
  const transcriptPath = path.join(
    tempDir,
    `${path.basename(audioPath, path.extname(audioPath))}.txt`,
  );

  try {
    await runProcess(runtime.whisperBin || "whisper", [
      audioPath,
      "--output_dir",
      tempDir,
      "--output_format",
      "txt",
      "--verbose",
      "False",
      "--fp16",
      "False",
    ]);

    const transcriptText = await fs.readFile(transcriptPath, "utf8").catch(() => "");
    return {
      path: transcriptPath,
      text: truncateInlineText(transcriptText),
      error: "",
    };
  } catch (error) {
    logger.error?.(error);
    return {
      path: "",
      text: "",
      error: error.message || String(error),
    };
  }
}

function sanitizeFileName(fileName) {
  const cleaned = String(fileName || "")
    .trim()
    .replace(/[^\w.\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return cleaned || `attachment-${Date.now()}`;
}

function guessExtension(attachment) {
  if (attachment.kind === "image") {
    return ".jpg";
  }

  if (attachment.kind === "voice") {
    return ".ogg";
  }

  const mimeType = String(attachment.mimeType || "").toLowerCase();

  if (mimeType === "application/pdf") {
    return ".pdf";
  }

  if (mimeType.startsWith("text/")) {
    return ".txt";
  }

  return "";
}

function truncateInlineText(value) {
  const trimmed = String(value || "").trim();

  if (trimmed.length <= MAX_INLINE_TRANSCRIPT_CHARS) {
    return trimmed;
  }

  return `${trimmed.slice(0, MAX_INLINE_TRANSCRIPT_CHARS - 3)}...`;
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}
