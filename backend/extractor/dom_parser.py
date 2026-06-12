"""
DOM 解析器 — 题目数据结构定义。
（无 Playwright 依赖，仅数据结构）
"""
from dataclasses import dataclass, field


@dataclass
class Question:
    """一道题目的结构化表示。"""
    index: int                    # 题号
    q_type: str                   # 题型: single | multi | judge | fill | short
    stem: str                     # 题干文本
    options: list[str] = field(default_factory=list)  # 选项列表
    stem_images: list[str] = field(default_factory=list)  # 题干中的图片(base64)
    option_images: list[str] = field(default_factory=list)  # 选项中的图片(base64)


class QuestionType:
    """题型常量。"""
    SINGLE = "single"       # 单选题
    MULTI = "multi"         # 多选题
    JUDGE = "judge"         # 判断题
    FILL = "fill"           # 填空题
    SHORT = "short"         # 简答题
