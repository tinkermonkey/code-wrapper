"""Tests for code-wrapper event models."""

import pytest

from code_wrapper.models import (
    TextEvent,
    ThinkingEvent,
    ToolUseEvent,
    ToolResultEvent,
    ProgressEvent,
    ReadyEvent,
    RetryEvent,
    DoneEvent,
    ErrorEvent,
    RawEvent,
    Usage,
    deserialize_event,
)


class TestTextEvent:
    """Test TextEvent deserialization."""

    def test_text_event_creation(self):
        event = TextEvent(v=1, seq=1, timestamp=1000, type="text", text="Hello")
        assert event.type == "text"
        assert event.text == "Hello"
        assert event.seq == 1

    def test_text_event_deserialization(self):
        data = {"v": 1, "seq": 1, "timestamp": 1000, "type": "text", "text": "Hello"}
        event = deserialize_event(data)
        assert isinstance(event, TextEvent)
        assert event.text == "Hello"


class TestThinkingEvent:
    """Test ThinkingEvent deserialization."""

    def test_thinking_event_creation(self):
        event = ThinkingEvent(
            v=1, seq=1, timestamp=1000, type="thinking", thinking="Hmm..."
        )
        assert event.type == "thinking"
        assert event.thinking == "Hmm..."

    def test_thinking_event_deserialization(self):
        data = {
            "v": 1,
            "seq": 1,
            "timestamp": 1000,
            "type": "thinking",
            "thinking": "Hmm...",
        }
        event = deserialize_event(data)
        assert isinstance(event, ThinkingEvent)
        assert event.thinking == "Hmm..."


class TestToolUseEvent:
    """Test ToolUseEvent deserialization."""

    def test_tool_use_event_creation(self):
        event = ToolUseEvent(
            v=1,
            seq=1,
            timestamp=1000,
            type="tool_use",
            id="tu-1",
            name="Read",
            input={"path": "/test"},
        )
        assert event.type == "tool_use"
        assert event.id == "tu-1"
        assert event.name == "Read"
        assert event.input == {"path": "/test"}

    def test_tool_use_event_deserialization(self):
        data = {
            "v": 1,
            "seq": 1,
            "timestamp": 1000,
            "type": "tool_use",
            "id": "tu-1",
            "name": "Read",
            "input": {"path": "/test"},
        }
        event = deserialize_event(data)
        assert isinstance(event, ToolUseEvent)
        assert event.id == "tu-1"


class TestToolResultEvent:
    """Test ToolResultEvent deserialization."""

    def test_tool_result_event_creation(self):
        event = ToolResultEvent(
            v=1,
            seq=1,
            timestamp=1000,
            type="tool_result",
            toolUseId="tu-1",
            isError=False,
            output="Success",
        )
        assert event.type == "tool_result"
        assert event.toolUseId == "tu-1"
        assert event.isError is False

    def test_tool_result_event_deserialization(self):
        data = {
            "v": 1,
            "seq": 1,
            "timestamp": 1000,
            "type": "tool_result",
            "toolUseId": "tu-1",
            "isError": False,
            "output": "Success",
        }
        event = deserialize_event(data)
        assert isinstance(event, ToolResultEvent)
        assert event.toolUseId == "tu-1"


class TestProgressEvent:
    """Test ProgressEvent deserialization."""

    def test_progress_event_creation(self):
        event = ProgressEvent(v=1, seq=1, timestamp=1000, type="progress", elapsed=5)
        assert event.type == "progress"
        assert event.elapsed == 5

    def test_progress_event_deserialization(self):
        data = {"v": 1, "seq": 1, "timestamp": 1000, "type": "progress", "elapsed": 5}
        event = deserialize_event(data)
        assert isinstance(event, ProgressEvent)
        assert event.elapsed == 5


class TestReadyEvent:
    """Test ReadyEvent deserialization."""

    def test_ready_event_creation(self):
        event = ReadyEvent(
            v=1,
            seq=1,
            timestamp=1000,
            type="ready",
            sessionId="sess-123",
            model="claude-opus-4",
            tools=["Read", "Write"],
        )
        assert event.type == "ready"
        assert event.sessionId == "sess-123"
        assert event.model == "claude-opus-4"
        assert event.tools == ["Read", "Write"]

    def test_ready_event_deserialization(self):
        data = {
            "v": 1,
            "seq": 1,
            "timestamp": 1000,
            "type": "ready",
            "sessionId": "sess-123",
            "model": "claude-opus-4",
            "tools": ["Read", "Write"],
        }
        event = deserialize_event(data)
        assert isinstance(event, ReadyEvent)
        assert event.sessionId == "sess-123"


class TestRetryEvent:
    """Test RetryEvent deserialization."""

    def test_retry_event_creation(self):
        event = RetryEvent(
            v=1,
            seq=1,
            timestamp=1000,
            type="retry",
            attempt=1,
            delayMs=500,
            error="Connection reset",
        )
        assert event.type == "retry"
        assert event.attempt == 1
        assert event.delayMs == 500

    def test_retry_event_deserialization(self):
        data = {
            "v": 1,
            "seq": 1,
            "timestamp": 1000,
            "type": "retry",
            "attempt": 1,
            "delayMs": 500,
            "error": "Connection reset",
        }
        event = deserialize_event(data)
        assert isinstance(event, RetryEvent)
        assert event.attempt == 1


class TestDoneEvent:
    """Test DoneEvent deserialization."""

    def test_done_event_creation(self):
        usage = Usage(inputTokens=100, outputTokens=50)
        event = DoneEvent(
            v=1,
            seq=1,
            timestamp=1000,
            type="done",
            sessionId="sess-123",
            usage=usage,
        )
        assert event.type == "done"
        assert event.sessionId == "sess-123"
        assert event.usage.inputTokens == 100

    def test_done_event_deserialization(self):
        data = {
            "v": 1,
            "seq": 1,
            "timestamp": 1000,
            "type": "done",
            "sessionId": "sess-123",
            "usage": {"inputTokens": 100, "outputTokens": 50},
        }
        event = deserialize_event(data)
        assert isinstance(event, DoneEvent)
        assert event.sessionId == "sess-123"

    def test_done_event_with_cache_tokens(self):
        data = {
            "v": 1,
            "seq": 1,
            "timestamp": 1000,
            "type": "done",
            "sessionId": "sess-123",
            "usage": {
                "inputTokens": 100,
                "outputTokens": 50,
                "cacheReadInputTokens": 10,
                "cacheCreationInputTokens": 5,
            },
        }
        event = deserialize_event(data)
        assert isinstance(event, DoneEvent)
        assert event.usage.cacheReadInputTokens == 10
        assert event.usage.cacheCreationInputTokens == 5


class TestErrorEvent:
    """Test ErrorEvent deserialization."""

    def test_error_event_creation(self):
        event = ErrorEvent(
            v=1,
            seq=1,
            timestamp=1000,
            type="error",
            code="spawn_error",
            detail="Binary not found",
        )
        assert event.type == "error"
        assert event.code == "spawn_error"

    def test_error_event_deserialization(self):
        data = {
            "v": 1,
            "seq": 1,
            "timestamp": 1000,
            "type": "error",
            "code": "spawn_error",
            "detail": "Binary not found",
        }
        event = deserialize_event(data)
        assert isinstance(event, ErrorEvent)
        assert event.code == "spawn_error"

    def test_error_event_with_exit_code(self):
        data = {
            "v": 1,
            "seq": 1,
            "timestamp": 1000,
            "type": "error",
            "code": "nonzero_exit",
            "detail": "Process exited with code 1",
            "exitCode": 1,
        }
        event = deserialize_event(data)
        assert isinstance(event, ErrorEvent)
        assert event.exitCode == 1


class TestRawEvent:
    """Test RawEvent as fallback for unknown types."""

    def test_raw_event_creation(self):
        event = RawEvent(
            v=1,
            seq=1,
            timestamp=1000,
            type="raw",
            rawType="unknown",
            data={"x": 1},
        )
        assert event.type == "raw"
        assert event.rawType == "unknown"

    def test_unknown_type_becomes_raw(self):
        data = {
            "v": 1,
            "seq": 1,
            "timestamp": 1000,
            "type": "future_type_unknown",
            "someField": "value",
        }
        event = deserialize_event(data)
        assert isinstance(event, RawEvent)
        assert event.rawType == "future_type_unknown"
        assert event.data["someField"] == "value"

    def test_raw_event_preserves_full_data(self):
        original_data = {
            "v": 1,
            "seq": 1,
            "timestamp": 1000,
            "type": "custom",
            "nested": {"field": "value"},
            "list": [1, 2, 3],
        }
        event = deserialize_event(original_data)
        assert isinstance(event, RawEvent)
        # Full data should be preserved
        assert event.data["nested"]["field"] == "value"
        assert event.data["list"] == [1, 2, 3]


class TestUsage:
    """Test Usage deserialization."""

    def test_usage_minimal(self):
        usage = Usage(inputTokens=100, outputTokens=50)
        assert usage.inputTokens == 100
        assert usage.outputTokens == 50
        assert usage.cacheReadInputTokens is None

    def test_usage_with_cache(self):
        usage = Usage(
            inputTokens=100,
            outputTokens=50,
            cacheReadInputTokens=10,
            cacheCreationInputTokens=5,
        )
        assert usage.cacheReadInputTokens == 10
        assert usage.cacheCreationInputTokens == 5
