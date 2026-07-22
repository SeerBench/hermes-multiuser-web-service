# MVP Plan — Workspace file read fix

## Goal

Users can attach or upload files in their workspace and Hermes can read them during chat via `web_file_read`.

## Deliverables

1. **Tool exposure:** Default `web_chat` agent receives `web_file_read`, `web_file_search`, and other fork sandbox tools from `hermes-web-chat`.
2. **Document formats:** Local TXT/Markdown/PDF/DOCX/XLSX/PPTX readable after sandbox confinement.
3. **Tests:** Gateway runner toolset regression + sandboxed file tool coverage + tenant isolation preserved.

## Acceptance

- `scripts/run_tests.sh tests/gateway/test_web_chat_runner.py tests/gateway/test_web_sandboxed_file_tools.py tests/gateway/test_web_uploads.py` green.
- Manual: attach `uploads/foo.txt` or platform file path → agent calls `web_file_read` → answer uses file content.

## Not in this slice

MinIO paths, Knowledge Center RAG merge, multi-turn attachment persistence.
