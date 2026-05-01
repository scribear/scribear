.DEFAULT_GOAL := start
PYTHON ?= python3

install_dev:
	$(PYTHON) -m pip install -e '.[dev,faster-whisper,silero-vad,pyannote-diarization]'

install:
	$(PYTHON) -m pip install .

# Run application in prod mode
start:
	$(PYTHON) src/index.py

# Run application in dev mode (hot reload + pretty print enabled)
dev:
	$(PYTHON) -m watchfiles "$(PYTHON) src/index.py --dev"

# Formatting without editing and run linter
format:
	isort --check ./src ./tests
	black --check ./src ./tests

# Format source code
format_fix:
	isort ./src ./tests
	black ./src ./tests

# Run linter
lint:
	pylint -j 0 --recursive=y --fail-under=10 ./src
	pylint -j 0 --recursive=y --fail-under=10 --disable=redefined-outer-name ./tests

# Run tests in dev mode (hot reload)
test_dev:
	watchfiles "pytest tests/unit tests/integration"

# Run tests
test:
	coverage run -m pytest tests/unit tests/integration && coverage xml --include=src/* && coverage report --include=src/*
