"""Local processing worker for the PDF audiobook pipeline.

The Node orchestrator talks to this package through a JSON-lines RPC server
(`python -m audiobook_worker.server`). Each process handles one request at a time;
the orchestrator runs a small, bounded pool of processes to control memory use.
"""

VERSION = "0.1.0"
EXTRACTOR_VERSION = "extract-v1"
