"""FastAPI application entrypoint."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from platform_api.routers import (
    admin,
    auth,
    billing,
    files,
    health,
    knowledge,
    memory,
    models,
    shares,
    skills,
    usage,
    workspaces,
)

app = FastAPI(title="Hermes Platform API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, prefix="/api/v1")
app.include_router(auth.router, prefix="/api/v1")
app.include_router(billing.router, prefix="/api/v1")
app.include_router(usage.router, prefix="/api/v1")
app.include_router(workspaces.router, prefix="/api/v1")
app.include_router(files.router, prefix="/api/v1")
app.include_router(knowledge.router, prefix="/api/v1")
app.include_router(models.router, prefix="/api/v1")
app.include_router(memory.router, prefix="/api/v1")
app.include_router(skills.router, prefix="/api/v1")
app.include_router(shares.router, prefix="/api/v1")
app.include_router(admin.router, prefix="/api/v1")


def main() -> None:
    import uvicorn

    uvicorn.run(
        "platform_api.main:app",
        host="0.0.0.0",
        port=int(__import__("os").environ.get("PLATFORM_API_PORT", "8700")),
        reload=False,
    )


if __name__ == "__main__":
    main()
