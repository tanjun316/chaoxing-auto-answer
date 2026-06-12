"""
OCR 模块 — 使用 PaddleOCR 识别图片中的文字（用于图片题）。
"""
import base64
import io
from typing import Optional

from PIL import Image
from backend.utils.config import config
from backend.utils.logger import log

# PaddleOCR 是可选依赖，延迟导入
_paddle_ocr = None


def _get_ocr():
    """延迟初始化 PaddleOCR（首次使用时加载，较慢）。"""
    global _paddle_ocr
    if _paddle_ocr is None:
        try:
            from paddleocr import PaddleOCR
            lang = config.get("ocr", {}).get("language", "ch")
            _paddle_ocr = PaddleOCR(lang=lang, use_angle_cls=True)
            log.info("PaddleOCR 初始化完成")
        except ImportError:
            log.error("PaddleOCR 未安装，请运行: pip install paddleocr paddlepaddle")
            raise
        except Exception as e:
            log.error(f"PaddleOCR 初始化失败: {e}")
            raise
    return _paddle_ocr


async def image_to_text(image_data: bytes) -> str:
    """
    将图片 bytes 识别为文字。

    Args:
        image_data: 图片二进制数据（PNG/JPEG）

    Returns:
        识别出的文本
    """
    ocr = _get_ocr()
    try:
        # 将 bytes 转成 PIL Image 再转 numpy array
        image = Image.open(io.BytesIO(image_data))
        import numpy as np
        img_array = np.array(image)

        import asyncio
        result = await asyncio.to_thread(ocr.ocr, img_array, cls=True)

        if not result or not result[0]:
            return ""

        # 拼接所有识别出的文本行
        lines = []
        for line_info in result[0]:
            text = line_info[1][0]  # 文本内容
            confidence = line_info[1][1]  # 置信度
            threshold = config.get("ocr", {}).get("confidence_threshold", 0.7)
            if confidence >= threshold:
                lines.append(text)

        return "\n".join(lines)

    except Exception as e:
        log.error(f"OCR 识别失败: {e}")
        return ""

async def base64_screenshot_to_text(b64_data: str) -> str:
    """
    将 base64 截图转换为文字。

    Args:
        b64_data: data:image/png;base64,... 格式的图片数据

    Returns:
        识别出的文本
    """
    try:
        # 去掉 data URL 前缀
        if b64_data.startswith("data:"):
            b64_data = b64_data.split(",", 1)[1]

        image_data = base64.b64decode(b64_data)
        return await image_to_text(image_data)
    except Exception as e:
        log.error(f"Base64 OCR 失败: {e}")
        return ""
