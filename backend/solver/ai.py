"""
AI 答题器 — 调用 OpenAI / Anthropic API 获取答案。
"""
import json
import re
import asyncio
from typing import Optional

from backend.utils.config import config
from backend.utils.logger import log
from backend.extractor.dom_parser import Question, QuestionType
from backend.solver.prompt import SYSTEM_PROMPT, build_question_prompt


class AISolver:
    """AI 答题器，支持多种 LLM provider。"""

    def __init__(self):
        self.provider = config.get("ai", {}).get("provider", "openai")
        self.model = config.get("ai", {}).get("model", "gpt-4o-mini")
        self.api_key = config.get("ai", {}).get("api_key", "")
        self.api_base = config.get("ai", {}).get("api_base", "")
        self.max_retries = config.get("ai", {}).get("max_retries", 3)
        self.temperature = config.get("ai", {}).get("temperature", 0.1)

    async def solve_one(self, question: Question) -> dict:
        """
        用 AI 回答一道题。

        Returns:
            {"answer": str, "reason": str, "success": bool, "error": str}
        """
        user_prompt = build_question_prompt(question)

        for attempt in range(self.max_retries):
            try:
                raw = await self._call_api(user_prompt)
                result = self._parse_answer(raw)
                result["success"] = True
                result["error"] = None
                log.info(
                    f"题 #{question.index} [{question.q_type}]: "
                    f"{result.get('answer', '?')} — {result.get('reason', '')[:30]}"
                )
                return result

            except json.JSONDecodeError as e:
                log.warning(f"JSON 解析失败 (第{attempt+1}次): {e}")
                if attempt < self.max_retries - 1:
                    await asyncio.sleep(1)
            except Exception as e:
                log.error(f"AI 调用失败 (第{attempt+1}次): {e}")
                if attempt < self.max_retries - 1:
                    await asyncio.sleep(2)

        return {
            "answer": "",
            "reason": "AI 调用失败",
            "success": False,
            "error": f"重试 {self.max_retries} 次后仍然失败",
        }

    async def solve_batch(self, questions: list[Question]) -> list[dict]:
        """批量答题 — 每道题独立调用（更可靠）。"""
        results = []
        for q in questions:
            result = await self.solve_one(q)
            result["index"] = q.index
            results.append(result)

            # 题间延迟（避免 API 限制）
            await asyncio.sleep(0.5)

        success_count = sum(1 for r in results if r.get("success"))
        log.info(f"批量答题完成: {success_count}/{len(questions)} 成功")
        return results

    async def _call_api(self, user_prompt: str) -> str:
        """调用 AI API，返回原始响应文本。"""
        if self.provider == "openai":
            return await self._call_openai(user_prompt)
        elif self.provider == "anthropic":
            return await self._call_anthropic(user_prompt)
        else:
            raise ValueError(f"不支持的 AI provider: {self.provider}")

    async def _call_openai(self, user_prompt: str) -> str:
        """调用 OpenAI 兼容 API。"""
        from openai import AsyncOpenAI

        client_kwargs = {"api_key": self.api_key}
        if self.api_base:
            client_kwargs["base_url"] = self.api_base

        client = AsyncOpenAI(**client_kwargs)

        response = await client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            temperature=self.temperature,
            max_tokens=500,
        )

        return response.choices[0].message.content or ""

    async def _call_anthropic(self, user_prompt: str) -> str:
        """调用 Anthropic Claude API。"""
        from anthropic import AsyncAnthropic

        client = AsyncAnthropic(api_key=self.api_key)

        response = await client.messages.create(
            model=self.model,
            max_tokens=500,
            system=SYSTEM_PROMPT,
            messages=[
                {"role": "user", "content": user_prompt},
            ],
            temperature=self.temperature,
        )

        return response.content[0].text or ""

    def _parse_answer(self, raw: str) -> dict:
        """解析 AI 返回的原始文本，提取 JSON 答案。"""
        # 清理可能的 markdown 包裹
        text = raw.strip()
        if text.startswith("```"):
            # 去掉 ```json 和 ```
            lines = text.split("\n")
            text = "\n".join(lines[1:-1]) if len(lines) >= 3 else text

        # 尝试在文本中查找 JSON 对象
        # 先尝试直接解析
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

        # 尝试用正则找 JSON 对象
        match = re.search(r'\{[^{}]*\}', text, re.DOTALL)
        if match:
            return json.loads(match.group())

        # 兜底：把整个文本当作答案
        return {"answer": text.strip(), "reason": ""}


# 全局单例
ai_solver = AISolver()
