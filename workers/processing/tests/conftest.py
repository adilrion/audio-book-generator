import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from audiobook_worker.sample import make_sample  # noqa: E402


@pytest.fixture(scope="session")
def sample_pdf(tmp_path_factory):
    d = tmp_path_factory.mktemp("pdf")
    return make_sample(str(d / "sample.pdf"), chapters=2, paras_per_chapter=5)
