.DEFAULT_GOAL := start

install_dev:
	pip install -e .[dev,faster-whisper,silero-vad] --extra-index-url https://download.pytorch.org/whl/cpu

install_dev_gpu:
	pip install -e .[dev,faster-whisper,silero-vad]

install:
	pip install . --extra-index-url https://download.pytorch.org/whl/cpu

install_gpu:
	pip install .

# Run application in prod mode
start:
	python src/index.py

# Run application in dev mode (hot reload + pretty print enabled)
dev:
	watchfiles "python src/index.py --dev"

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
