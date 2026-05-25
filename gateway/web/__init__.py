"""Multi-user web chat platform support (``web_chat`` gateway adapter).

This package contains everything specific to the new ``gateway/platforms/
web_chat.py`` adapter — user accounts, API keys, browser sessions, quota,
per-user filesystem sandboxing, and an extracted AIAgent runner shared with
``gateway/platforms/api_server.py``.

Nothing here is imported by the rest of Hermes unless the ``web_chat``
platform is enabled in the gateway config.  Importing this package does
*not* pull in heavy deps — submodules guard their own optional imports
(notably ``argon2-cffi`` in :mod:`gateway.web.users`).
"""
