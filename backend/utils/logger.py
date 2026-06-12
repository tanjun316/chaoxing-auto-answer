"""
日志模块 — 同时输出到控制台和文件。
"""
import logging
import sys
from pathlib import Path


def setup_logger(
    name: str = "chaoxing",
    level: str = None,
    log_file: str = "data/app.log",
) -> logging.Logger:
    """创建并配置 logger。"""
    if level is None:
        from backend.utils.config import config
        level = config.get("logging", {}).get("level", "INFO")
    logger = logging.getLogger(name)
    logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    logger.handlers.clear()

    # 控制台 handler
    console = logging.StreamHandler(sys.stdout)
    console.setLevel(logging.DEBUG)
    console.setFormatter(
        logging.Formatter("%(asctime)s | %(levelname)-7s | %(message)s",
                          datefmt="%H:%M:%S")
    )
    logger.addHandler(console)

    # 文件 handler
    log_path = Path(log_file)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(
        logging.Formatter("%(asctime)s | %(levelname)-7s | %(name)s | %(message)s")
    )
    logger.addHandler(file_handler)

    return logger


# 默认 logger 实例
log = setup_logger()
