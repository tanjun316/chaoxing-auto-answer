"""
Prompt 模板 — 构造发给 AI 的结构化答题提示。
"""
from backend.extractor.dom_parser import Question, QuestionType

SYSTEM_PROMPT = """你是一个正在完成大学课程在线测验的学生。你需要认真回答每道题目。

## 规则
1. 仔细阅读题目和选项，选择最合理的答案
2. 对于单选题，只返回一个选项字母
3. 对于多选题，返回所有正确选项的字母（用逗号分隔，如 "A,C,D"）
4. 对于判断题，返回 "正确" 或 "错误"
5. 对于填空题，返回要填入的文本
6. 对于简答题，简要回答要点即可

## 输出格式（严格 JSON）
你只能回复一个 JSON 对象，格式如下：
{
  "answer": "你的答案",
  "reason": "简要理由（可选）"
}

不要输出任何其他内容。不要用 markdown 代码块包裹 JSON。直接输出 JSON。"""


def build_question_prompt(question: Question) -> str:
    """根据题型构造单个题目的 prompt。"""
    parts = [f"## 题目"]

    # 题型提示
    type_names = {
        QuestionType.SINGLE: "单选题",
        QuestionType.MULTI: "多选题",
        QuestionType.JUDGE: "判断题",
        QuestionType.FILL: "填空题",
        QuestionType.SHORT: "简答题",
    }
    q_type_name = type_names.get(question.q_type, "未知题型")
    parts.append(f"**题型**: {q_type_name}")

    # 题干
    parts.append(f"**题目内容**: {question.stem}")

    # 选项
    if question.options:
        labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        parts.append("**选项**:")
        for i, opt in enumerate(question.options):
            label = labels[i] if i < len(labels) else str(i)
            parts.append(f"  {label}. {opt}")

    # 图片提示（如果有）
    if question.stem_images:
        parts.append("**注意**: 本题包含图片，请根据题目文字和常识判断。")

    # 答案格式提示
    if question.q_type == QuestionType.SINGLE:
        parts.append("\n请选择一个最合适的选项（如: A）。")
    elif question.q_type == QuestionType.MULTI:
        parts.append("\n请选择所有正确的选项（如: A,C,D）。")
    elif question.q_type == QuestionType.JUDGE:
        parts.append("\n请判断对错（回答: 正确 或 错误）。")
    elif question.q_type == QuestionType.FILL:
        parts.append("\n请填入合适的内容。")
    elif question.q_type == QuestionType.SHORT:
        parts.append("\n请简要回答。")

    return "\n".join(parts)


def build_batch_prompt(questions: list[Question], course_name: str = "") -> str:
    """构造批量题目的 prompt（一次请求答多道题）。"""
    parts = []
    if course_name:
        parts.append(f"# 课程: {course_name}\n")

    parts.append("请回答以下所有题目。对每道题返回 JSON 数组：\n")
    parts.append('[{"index": 题号, "answer": "答案", "reason": "理由"}, ...]\n')

    for q in questions:
        parts.append(build_question_prompt(q))
        parts.append("\n---\n")

    return "\n".join(parts)
