from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from app.db.database import create_db_and_tables
from app.routers import projects, assets


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_db_and_tables()
    yield


app = FastAPI(
    title="KyChaPoGaS API",
    description="A MAD Video Creation Studio — backend API",
    version="0.1.0",
    lifespan=lifespan,
    redirect_slashes=False,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects.router, prefix="/api")
app.include_router(assets.router, prefix="/api")


@app.get("/api/health")
def health():
    return {"status": "ok", "app": "KyChaPoGaS"}
