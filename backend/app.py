"""
FastAPI 应用 — AI 答题 API。
"""
import asyncio
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional

from contextlib import asynccontextmanager

from backend.utils.config import config
from backend.utils.logger import setup_logger, log
from backend.solver.ai import AISolver
from backend.extractor.ocr import image_to_text, base64_screenshot_to_text
from backend.extractor.dom_parser import Question
import httpx

@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动时预加载 OCR 引擎（避免首次请求阻塞）。"""
    from backend.extractor.ocr import _get_ocr
    log.info("预加载 OCR 引擎...")
    try:
        await asyncio.to_thread(_get_ocr)
        log.info("OCR 引擎就绪")
    except Exception as e:
        log.warning(f"OCR 引擎预加载失败（图片题可能不可用）: {e}")
    yield

app = FastAPI(title="学习通 AI 后端", version="1.0", lifespan=lifespan)

# CORS — 允许扩展访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["chrome-extension://*", "moz-extension://*"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

# ─── Request Models ───

class QuestionItem(BaseModel):
    index: int
    type: str  # single | multi | judge | fill | short
    stem: str
    options: list[str] = []
    stem_images: list[str] = []

class AIConfig(BaseModel):
    api_key: str = ""
    model: str = "deepseek-chat"
    api_base: str = "https://api.deepseek.com"
    provider: str = "openai"

class SolveRequest(BaseModel):
    questions: list[QuestionItem]
    config: Optional[AIConfig] = None

class SolveResult(BaseModel):
    index: int
    answer: str = ""
    reason: str = ""

class SolveResponse(BaseModel):
    ok: bool
    results: list[SolveResult] = []
    error: Optional[str] = None

# ─── API ───

@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "1.0"}

@app.post("/api/solve", response_model=SolveResponse)
async def solve(req: SolveRequest):
    """接收题目列表，返回 AI 答案。"""
    log.info(f"收到 {len(req.questions)} 道题目")

    # 合并配置：config.yaml 默认值 + 请求覆盖
    cfg = config.get("ai", {})
    provider = cfg.get("provider", "openai")
    model = cfg.get("model", "deepseek-chat")
    api_key = cfg.get("api_key", "")
    api_base = cfg.get("api_base", "")

    if req.config:
        if req.config.provider:
            provider = req.config.provider
        if req.config.model:
            model = req.config.model
        if req.config.api_key:
            api_key = req.config.api_key
        if req.config.api_base:
            api_base = req.config.api_base

    # 为本次请求创建新的 AI solver 实例（避免并发请求互相干扰）
    solver = AISolver()
    solver.provider = provider
    solver.model = model
    solver.api_key = api_key
    solver.api_base = api_base

    results = []
    for q in req.questions:
        try:
            # 图片 OCR 预处理
            stem = q.stem
            for img in q.stem_images:
                if isinstance(img, str):
                    if img.startswith("data:"):
                        ocr_text = await base64_screenshot_to_text(img)
                        if ocr_text:
                            stem += "\n[图片文字]: " + ocr_text
                    elif img.startswith("http"):
                        try:
                            async with httpx.AsyncClient() as client:
                                resp = await client.get(img, timeout=10)
                                ocr_text = await image_to_text(resp.content)
                                if ocr_text:
                                    stem += "\n[图片文字]: " + ocr_text
                        except Exception as e:
                            log.warning(f"图片下载失败: {e}")

            # 构造内部 Question 对象并调用 AI
            question = Question(
                index=q.index,
                q_type=q.type,
                stem=stem,
                options=q.options,
                stem_images=q.stem_images,
            )
            result = await solver.solve_one(question)

            results.append(SolveResult(
                index=q.index,
                answer=result.get("answer", ""),
                reason=result.get("reason", ""),
            ))

        except Exception as e:
            log.error(f"题 #{q.index} 处理失败: {e}")
            results.append(SolveResult(
                index=q.index,
                answer="",
                reason=str(e),
            ))

    success_count = sum(1 for r in results if r.answer)
    return SolveResponse(
        ok=success_count > 0,
        results=results,
        error=None if success_count > 0 else "所有题目处理失败",
    )
