import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractTelegramAttachments, prepareTelegramAttachments } from "../src/attachments.js";

test("When extracting Telegram attachments, then image, document, and voice metadata are normalized", () => {
  const attachments = extractTelegramAttachments({
    message_id: 9,
    photo: [
      {
        file_id: "photo-small",
        file_unique_id: "photo-u-small",
        file_size: 10,
      },
      {
        file_id: "photo-large",
        file_unique_id: "photo-u-large",
        file_size: 20,
      },
    ],
    document: {
      file_id: "doc-1",
      file_unique_id: "doc-u-1",
      file_name: "spec.pdf",
      mime_type: "application/pdf",
      file_size: 30,
    },
    voice: {
      file_id: "voice-1",
      file_unique_id: "voice-u-1",
      mime_type: "audio/ogg",
      file_size: 40,
      duration: 12,
    },
  });

  assert.deepEqual(
    attachments.map((attachment) => attachment.kind),
    ["image", "document", "voice"],
  );
  assert.equal(attachments[0].fileId, "photo-large");
  assert.equal(attachments[1].fileName, "spec.pdf");
  assert.equal(attachments[2].durationSeconds, 12);
});

test("When preparing a voice attachment, then it is transcribed and added to the prompt context", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tether-voice-"));
  const whisperScript = path.join(tempDir, "fake-whisper.sh");

  await fs.writeFile(
    whisperScript,
    [
      "#!/bin/sh",
      'audio=\"$1\"',
      "shift",
      'outdir=\"\"',
      "while [ $# -gt 0 ]; do",
      '  if [ \"$1\" = \"--output_dir\" ]; then',
      '    outdir=\"$2\"',
      "    shift 2",
      "    continue",
      "  fi",
      "  shift",
      "done",
      'base=$(basename \"$audio\")',
      'name=\"${base%.*}\"',
      'printf \"voice transcript from %s\" \"$base\" > \"$outdir/$name.txt\"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const telegram = {
    async getFile(fileId) {
      assert.equal(fileId, "voice-1");
      return {
        file_path: "voice/note.ogg",
      };
    },
    async downloadFile(filePath) {
      assert.equal(filePath, "voice/note.ogg");
      return Buffer.from("fake-audio", "utf8");
    },
  };

  const prepared = await prepareTelegramAttachments({
    job: {
      prompt: "Summarize the note",
      attachments: [
        {
          kind: "voice",
          fileId: "voice-1",
          fileUniqueId: "voice-u-1",
          fileName: "note.ogg",
          mimeType: "audio/ogg",
          durationSeconds: 7,
        },
      ],
    },
    telegram,
    runtime: {
      whisperBin: whisperScript,
    },
    logger: {
      error() {},
    },
  });

  assert.match(prepared.prompt, /voice transcript from note\.ogg/);
  assert.equal(prepared.extraDirs.length, 1);
  assert.equal(prepared.imagePaths.length, 0);

  await prepared.cleanup();
  await fs.rm(tempDir, { recursive: true, force: true });
});
