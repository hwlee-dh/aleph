"""FastAPI 앱.

배포 형태는 '각자 자기 컴퓨터에서 실행'이다. 그래서 인증이 없고, 서버는
127.0.0.1에만 열며(run 스크립트), CORS도 열지 않는다 — 프론트는 빌드된
정적 파일로 이 서버가 같이 서빙하므로 같은 출처다.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .api.workspace_routes import router as workspace_router
from .api.routes import router
from .context import AppContext
from .settings import AppPaths


def create_app(paths: AppPaths | None = None) -> FastAPI:
    ctx = AppContext(paths)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        await ctx.runs.shutdown()

    app = FastAPI(title="ALEPH", lifespan=lifespan)
    app.state.ctx = ctx
    app.include_router(router)
    app.include_router(workspace_router)

    @app.exception_handler(HTTPException)
    async def http_error(request, exc: HTTPException):
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code)

    @app.exception_handler(ValueError)
    async def value_error(request, exc: ValueError):
        return JSONResponse({"error": str(exc)}, status_code=400)

    dist = ctx.paths.frontend_dist
    if (dist / "index.html").exists():
        if (dist / "assets").exists():
            app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str):
            if path.startswith("api/"):
                raise HTTPException(404, "없는 API 경로입니다.")
            target = (dist / path).resolve()
            if path and target.is_file() and dist.resolve() in target.parents:
                return FileResponse(target)
            return FileResponse(dist / "index.html")

    return app

