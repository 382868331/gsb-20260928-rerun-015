"""可注入的 ID 生成器，测试时可替换为确定性序列。"""

import itertools
import uuid


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class IdGen:
    """测试用确定性 ID 生成器。"""

    def __init__(self, prefix: str = "id"):
        self._counter = itertools.count(1)
        self.prefix = prefix

    def __call__(self, *_args) -> str:
        return f"{self.prefix}_{next(self._counter)}"
