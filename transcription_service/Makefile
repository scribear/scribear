.DEFAULT_GOAL := start

install_uv:
	@command -v uv >/dev/null 2>&1 || pip install uv

install_dev: install_uv
	uv sync --extra dev --extra faster-whisper --extra silero-vad

install_dev_cpu: install_uv
	uv sync --extra dev --extra faster-whisper --extra silero-vad-cpu

install: install_uv
	uv sync

# Run application in prod mode
start:
	uv run python src/index.py

# Run application in dev mode (hot reload + pretty print enabled)
dev:
	uv run watchfiles "python src/index.py --dev"

# Formatting without editing and run linter
format:
	uv run isort --check ./src ./tests
	uv run black --check ./src ./tests

# Format source code
format_fix:
	uv run isort ./src ./tests
	uv run black ./src ./tests

# Run linter
lint:
	uv run pylint -j 0 --recursive=y --fail-under=10 ./src
	uv run pylint -j 0 --recursive=y --fail-under=10 --disable=redefined-outer-name ./tests

# Run tests in dev mode (hot reload)
test_dev:
	uv run watchfiles "pytest tests/unit tests/integration"

# Run tests
test:
	uv run coverage run -m pytest tests/unit tests/integration && uv run coverage xml --include=src/* && uv run coverage report --include=src/*
