"""Type models for code-wrapper wire protocol events (v1).

Hand-written models based on the claude-event.v1.schema.json specification.
All events are Pydantic BaseModel instances, discriminated by the 'type' field.
Note: models are not auto-generated; ensure they stay in sync with the schema.
"""

from __future__ import annotations

from typing import Any, Literal, Union

from pydantic import BaseModel, Field


class BaseEvent(BaseModel):
    """Base event with protocol version, sequence, and timestamp."""

    v: int = Field(..., description="Wire protocol version (currently 1)")
    seq: int = Field(
        ..., description="Monotonic across all events in a run — safe for replay and deduplication"
    )
    timestamp: int = Field(..., description="Unix timestamp in milliseconds")
    type: str


class TextEvent(BaseEvent):
    """Text content from the assistant."""

    type: Literal["text"]
    text: str


class ThinkingEvent(BaseEvent):
    """Extended thinking content from the model."""

    type: Literal["thinking"]
    thinking: str


class ToolUseEvent(BaseEvent):
    """Tool use request from the model."""

    type: Literal["tool_use"]
    id: str = Field(..., description="Tool use ID")
    name: str = Field(..., description="Tool name")
    input: Any = Field(..., description="Full tool input as received from the CLI")


class ToolResultEvent(BaseEvent):
    """Tool execution result."""

    type: Literal["tool_result"]
    toolUseId: str = Field(..., description="References a tool_use id")
    isError: bool = Field(..., description="Whether the tool execution was an error")
    output: str = Field(
        ..., description="Full combined text output from the tool result content blocks"
    )


class ProgressEvent(BaseEvent):
    """Periodic progress heartbeat, emitted every 5 seconds."""

    type: Literal["progress"]
    elapsed: int = Field(..., description="Seconds elapsed since process start")


class Usage(BaseModel):
    """Token usage information."""

    inputTokens: int
    outputTokens: int
    cacheReadInputTokens: int | None = None
    cacheCreationInputTokens: int | None = None


class ReadyEvent(BaseEvent):
    """Agent ready event, fired at process start."""

    type: Literal["ready"]
    sessionId: str = Field(..., description="CLI-assigned session ID")
    model: str | None = Field(None, description="Model being used for this run")
    tools: list[str] | None = Field(None, description="Names of tools available to the agent")


class RetryEvent(BaseEvent):
    """API retry event."""

    type: Literal["retry"]
    attempt: int = Field(..., description="Attempt number (1-based)")
    delayMs: int | None = Field(None, description="Delay before this retry in milliseconds")
    error: str | None = Field(None, description="Error message that triggered the retry")


class DoneEvent(BaseEvent):
    """Conversation completion event."""

    type: Literal["done"]
    sessionId: str = Field(
        ..., description="CLI-assigned session ID — store and reuse on next turn"
    )
    usage: Usage | None = Field(None, description="Token usage information")
    resultText: str | None = Field(
        None, description="Claude's own final summary/answer text (Claude-only)"
    )
    isError: bool | None = Field(None, description="Whether the turn ended in an error state")
    durationMs: int | None = Field(None, description="Wall-clock duration of the turn in ms")
    totalCostUsd: float | None = Field(None, description="Total cost of the turn in USD")
    numTurns: int | None = Field(None, description="Number of turns in the conversation")
    stopReason: str | None = Field(None, description="Stop reason (Copilot-only, e.g. 'end_turn')")


class ErrorEvent(BaseEvent):
    """Error event for failures and exceptions."""

    type: Literal["error"]
    code: Literal[
        "idle_timeout",
        "max_timeout",
        "nonzero_exit",
        "rate_limit",
        "spawn_error",
        "internal_error",
        "stale_session",
        "parse_error",
        "cli_error",
        "aborted",
    ] = Field(..., description="Error code discriminator")
    detail: str = Field(..., description="Human-readable error detail")
    exitCode: int | None = Field(None, description="Process exit code if applicable")


class RawEvent(BaseEvent):
    """Catch-all for unknown event types — no events are ever silently dropped."""

    type: Literal["raw"]
    rawType: str = Field(..., description="The 'type' field from the raw CLI event")
    rawSubtype: str | None = Field(None, description="The 'subtype' field if present")
    data: Any = Field(..., description="The full raw parsed JSON object")


# Discriminated union of all event types
ClaudeEvent = Union[
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
]


def deserialize_event(data: dict[str, Any]) -> ClaudeEvent:
    """Deserialize a JSON object into a typed ClaudeEvent.

    Discriminates on the 'type' field. Unknown types become RawEvent.
    Raises ValueError if data is missing required fields for a known type.
    """
    event_type: str = data.get("type", "")

    type_map = {
        "text": TextEvent,
        "thinking": ThinkingEvent,
        "tool_use": ToolUseEvent,
        "tool_result": ToolResultEvent,
        "progress": ProgressEvent,
        "ready": ReadyEvent,
        "retry": RetryEvent,
        "done": DoneEvent,
        "error": ErrorEvent,
        "raw": RawEvent,
    }

    event_class = type_map.get(event_type)
    if event_class:
        return event_class(**data)  # type: ignore[no-any-return]

    # Unknown type → wrap as RawEvent
    return RawEvent(
        v=data.get("v", 1),
        seq=data.get("seq", 0),
        timestamp=data.get("timestamp", 0),
        type="raw",
        rawType=event_type or "unknown",
        rawSubtype=data.get("subtype"),
        data=data,
    )
