"""Sandboxed tool variants for the ``web_chat`` platform.

The tools registered here mirror their counterparts in ``tools/`` but
add a per-user filesystem confinement step before delegating to the
upstream implementation.  Importing this package as a side effect
registers all sandboxed tools with the global ``tools.registry`` —
``gateway/platforms/web_chat.py:connect`` imports this package once at
gateway start so the tools are visible to AIAgent.

Why this lives outside ``tools/``
---------------------------------
``tools/`` is upstream territory.  Per the project's
upstream-sync strategy (see plans/.../kazoo.md "Strategy 2"), we
don't edit files there — every multi-user concern stays under
``gateway/web/``.  These sandboxed tools call the existing
``read_file_tool`` / ``write_file_tool`` / ``patch_tool`` /
``search_tool`` public functions from ``tools/file_tools.py``;
upstream is free to refactor those internals.

The sandbox itself is enforced by
:func:`gateway.web.sandbox.confine_path`, which reads the active
user's workspace from the ``_USER_WORKSPACE`` contextvar set by
``enter_user_context`` in the chat handler.
"""

from gateway.web.tools import sandboxed_file_operations  # noqa: F401 — side effect

__all__ = ["sandboxed_file_operations"]
