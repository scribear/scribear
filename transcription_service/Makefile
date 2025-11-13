.DEFAULT_GOAL := start

install_dev:
	pip install -e .[dev,faster-whisper]

install:
	pip install .

# Run application in prod mode
start:
	python src/index.py

# Run application in dev mode (hot reload + pretty print enabled)
dev:
	watchfiles "python src/index.py --dev"

# Format source code
format:
	isort ./src ./tests
	black ./src ./tests

# Run linter
lint:
	pylint -j 0 --recursive=y ./src
	pylint -j 0 --recursive=y ./tests --disable=redefined-outer-name

# Check source code formatting without editing and run linter
check:
	isort --check ./src ./tests
	black --check ./src ./tests
	pylint -j 0 --recursive=y --fail-under=10 ./src
	pylint -j 0 --recursive=y --fail-under=10  --disable=redefined-outer-name ./tests

# Run tests in dev mode (hot reload)
test_dev:
	watchfiles "pytest tests/unit tests/integration"

# Run tests
test:
	coverage run -m pytest tests/unit tests/integration && coverage xml --include=src/* && coverage report --include=src/*
