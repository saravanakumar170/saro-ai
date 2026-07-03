import json
import os
from typing import Dict, List, Literal, Optional, Union

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

load_dotenv()

DEFAULT_AI_NAME = "Saro AI"

OPENROUTER_API_KEY_ENV = os.getenv("OPENROUTER_API_KEY", "").strip()
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "google/gemma-4-26b-a4b-it:free").strip()
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

# Free OpenRouter models get shared, sometimes-rate-limited capacity. If the
# primary model is temporarily unavailable, fall back to these in order
# rather than failing the chat outright.
OPENROUTER_FALLBACK_MODELS = [
    m
    for m in dict.fromkeys(
        [
            OPENROUTER_MODEL,
            "google/gemma-4-26b-a4b-it:free",
            "openai/gpt-oss-20b:free",
            "liquid/lfm-2.5-1.2b-instruct:free",
            "meta-llama/llama-3.3-70b-instruct:free",
        ]
    )
]
# Used automatically instead of the text fallbacks above whenever the user
# attaches an image (confirmed vision-capable + free).
OPENROUTER_VISION_MODEL = "google/gemma-4-26b-a4b-it:free"

OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "phi3:mini").strip()

OPENAI_URL = "https://api.openai.com/v1/chat/completions"
OPENAI_DEFAULT_MODEL = "gpt-4o-mini"
DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions"
DEEPSEEK_DEFAULT_MODEL = "deepseek-chat"
CLAUDE_DEFAULT_MODEL = "claude-opus-4-8"


def build_system_prompt(ai_name: Optional[str]) -> str:
    name = (ai_name or "").strip() or DEFAULT_AI_NAME
    return (
        f'You are {name}, a helpful, friendly, and concise assistant. '
        f'If the user greets you or addresses you by the name "{name}", respond naturally as {name}. '
        "Answer clearly, and say so instead of guessing when you're unsure. "
        "When markdown formatting helps (tables, code blocks, lists), use clean "
        "GitHub-flavored markdown — for tables always include a valid header separator row "
        "(e.g. |---|---|) with the same number of columns as the header, and never merge "
        "alignment dashes together with real cell text."
    )


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

app = FastAPI(title="Saro AI")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class ContentPart(BaseModel):
    type: str
    text: Optional[str] = None
    image_url: Optional[Dict[str, str]] = None


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: Union[str, List[ContentPart]]


class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    api_key: Optional[str] = None
    ai_name: Optional[str] = None
    provider: Optional[Literal["openai", "claude", "deepseek", "custom", "openrouter"]] = None
    base_url: Optional[str] = None
    model: Optional[str] = None


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/api/health")
async def health():
    ollama_ok = False
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(f"{OLLAMA_HOST}/api/tags")
            ollama_ok = resp.status_code == 200
    except Exception:
        ollama_ok = False

    return {
        "ollama_available": ollama_ok,
        "openrouter_configured": bool(OPENROUTER_API_KEY_ENV),
    }


def message_has_image(messages: List[ChatMessage]) -> bool:
    for m in messages:
        if isinstance(m.content, list):
            for part in m.content:
                if part.type == "image_url":
                    return True
    return False


def to_openai_messages(messages: List[ChatMessage], system_prompt: str) -> list:
    out = [{"role": "system", "content": system_prompt}]
    for m in messages:
        if isinstance(m.content, str):
            out.append({"role": m.role, "content": m.content})
        else:
            out.append(
                {
                    "role": m.role,
                    "content": [part.model_dump(exclude_none=True) for part in m.content],
                }
            )
    return out


def to_anthropic_messages(messages: List[ChatMessage]) -> list:
    out = []
    for m in messages:
        if isinstance(m.content, str):
            out.append({"role": m.role, "content": m.content})
            continue
        blocks = []
        for part in m.content:
            if part.type == "text":
                blocks.append({"type": "text", "text": part.text or ""})
            elif part.type == "image_url":
                url = (part.image_url or {}).get("url", "")
                if url.startswith("data:") and ";base64," in url:
                    media_type, b64data = url[len("data:") :].split(";base64,", 1)
                    blocks.append(
                        {
                            "type": "image",
                            "source": {"type": "base64", "media_type": media_type, "data": b64data},
                        }
                    )
        out.append({"role": m.role, "content": blocks})
    return out


def to_ollama_messages(messages: List[ChatMessage], system_prompt: str) -> list:
    out = [{"role": "system", "content": system_prompt}]
    for m in messages:
        if isinstance(m.content, str):
            out.append({"role": m.role, "content": m.content})
            continue
        text_parts, images = [], []
        for part in m.content:
            if part.type == "text" and part.text:
                text_parts.append(part.text)
            elif part.type == "image_url":
                url = (part.image_url or {}).get("url", "")
                if ";base64," in url:
                    images.append(url.split(";base64,", 1)[1])
        entry = {"role": m.role, "content": " ".join(text_parts)}
        if images:
            entry["images"] = images
        out.append(entry)
    return out


async def is_ollama_available(client: httpx.AsyncClient) -> bool:
    try:
        resp = await client.get(f"{OLLAMA_HOST}/api/tags", timeout=1.5)
        return resp.status_code == 200
    except Exception:
        return False


async def _stream_local_raw(client: httpx.AsyncClient, messages: List[ChatMessage], system_prompt: str):
    """Try the local Ollama model. Yields ("chunk", text) for output, or
    ("retry", reason) if it couldn't produce anything (so the caller can fall
    back to a cloud model). Never yields "retry" after any "chunk"."""
    payload = {
        "model": OLLAMA_MODEL,
        "messages": to_ollama_messages(messages, system_prompt),
        "stream": True,
    }
    try:
        async with client.stream(
            "POST", f"{OLLAMA_HOST}/api/chat", json=payload, timeout=None
        ) as resp:
            if resp.status_code != 200:
                yield ("retry", f"local model error ({resp.status_code})")
                return
            async for line in resp.aiter_lines():
                if not line.strip():
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                chunk = data.get("message", {}).get("content", "")
                if chunk:
                    yield ("chunk", chunk)
                if data.get("done"):
                    break
    except Exception as exc:
        yield ("retry", f"local model unreachable ({exc})")


async def _stream_openai_compatible(
    client: httpx.AsyncClient,
    url: str,
    model: str,
    messages: List[ChatMessage],
    key: str,
    system_prompt: str,
    extra_headers: Optional[dict] = None,
):
    """Works against any OpenAI-compatible /chat/completions endpoint
    (OpenAI, DeepSeek, OpenRouter, or a user's custom endpoint). Yields
    ("chunk", text) / ("retry", reason) / ("fatal", message)."""
    payload = {
        "model": model,
        "messages": to_openai_messages(messages, system_prompt),
        "stream": True,
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if extra_headers:
        headers.update(extra_headers)

    async with client.stream("POST", url, json=payload, headers=headers) as resp:
        if resp.status_code == 401:
            yield ("fatal", "That API key was rejected. Double-check it in Settings.")
            return
        if resp.status_code in (404, 429) or resp.status_code >= 500:
            yield ("retry", f"{model} unavailable ({resp.status_code})")
            return
        if resp.status_code != 200:
            body = await resp.aread()
            yield (
                "fatal",
                f"API error ({resp.status_code}): {body.decode(errors='ignore')[:300]}",
            )
            return

        async for line in resp.aiter_lines():
            line = line.strip()
            if not line or not line.startswith("data:"):
                continue
            data_str = line[len("data:") :].strip()
            if data_str == "[DONE]":
                break
            try:
                data = json.loads(data_str)
            except json.JSONDecodeError:
                continue
            if data.get("error"):
                yield ("fatal", f"API error: {data['error'].get('message', data['error'])}")
                return
            choices = data.get("choices") or []
            if not choices:
                continue
            chunk = choices[0].get("delta", {}).get("content", "")
            if chunk:
                yield ("chunk", chunk)


async def _stream_openrouter_raw(
    client: httpx.AsyncClient, messages: List[ChatMessage], key: str, system_prompt: str, use_vision_model: bool
):
    """Try each fallback model in order. Yields ("chunk", text) or
    ("fatal", message)."""
    headers = {"HTTP-Referer": "http://localhost", "X-Title": "Saro AI"}
    models = [OPENROUTER_VISION_MODEL] if use_vision_model else OPENROUTER_FALLBACK_MODELS

    last_reason = "no models tried"
    for model in models:
        got_any_chunk = False
        async for kind, value in _stream_openai_compatible(
            client, OPENROUTER_URL, model, messages, key, system_prompt, headers
        ):
            if kind == "chunk":
                got_any_chunk = True
                yield ("chunk", value)
            elif kind == "retry":
                last_reason = value
                break
            elif kind == "fatal":
                yield ("fatal", value)
                return
        if got_any_chunk:
            return
    yield ("fatal", f"All cloud models are currently unavailable ({last_reason}). Please try again shortly.")


async def _stream_claude(messages: List[ChatMessage], model: Optional[str], key: str, system_prompt: str):
    import anthropic

    client = anthropic.AsyncAnthropic(api_key=key)
    try:
        async with client.messages.stream(
            model=model or CLAUDE_DEFAULT_MODEL,
            max_tokens=4096,
            system=system_prompt,
            messages=to_anthropic_messages(messages),
        ) as stream:
            async for text in stream.text_stream:
                yield ("chunk", text)
    except anthropic.AuthenticationError:
        yield ("fatal", "That Claude API key was rejected. Double-check it in Settings.")
    except anthropic.RateLimitError:
        yield ("fatal", "Rate limited by the Claude API. Please wait a moment and try again.")
    except anthropic.APIError as exc:
        yield ("fatal", f"Claude API error: {exc.message}")
    except Exception as exc:
        yield ("fatal", f"Unexpected error talking to Claude: {exc}")


async def stream_provider_direct(req: ChatRequest, system_prompt: str):
    """The user explicitly picked a provider and supplied their own key in
    Settings — use exactly that, no local/auto fallback."""
    key = (req.api_key or "").strip()
    if not key:
        yield "[Saro AI] Please add your API key in Settings to use this provider."
        return

    if req.provider == "claude":
        async for kind, value in _stream_claude(req.messages, req.model, key, system_prompt):
            if kind == "chunk":
                yield value
            else:
                yield f"[Saro AI] {value}"
                return
        return

    if req.provider == "openai":
        url, model = OPENAI_URL, (req.model or OPENAI_DEFAULT_MODEL)
        extra_headers = None
    elif req.provider == "deepseek":
        url, model = DEEPSEEK_URL, (req.model or DEEPSEEK_DEFAULT_MODEL)
        extra_headers = None
    elif req.provider == "openrouter":
        url, model = OPENROUTER_URL, (req.model or OPENROUTER_MODEL)
        extra_headers = {"HTTP-Referer": "http://localhost", "X-Title": "Saro AI"}
    elif req.provider == "custom":
        if not req.base_url:
            yield "[Saro AI] Add your provider's endpoint URL in Settings."
            return
        if not req.model:
            yield "[Saro AI] Add a model name for your custom provider in Settings."
            return
        url, model = req.base_url, req.model
        extra_headers = None
    else:
        yield "[Saro AI] Unknown provider selected."
        return

    async with httpx.AsyncClient(timeout=None) as client:
        async for kind, value in _stream_openai_compatible(
            client, url, model, req.messages, key, system_prompt, extra_headers
        ):
            if kind == "chunk":
                yield value
            else:
                yield f"[Saro AI] {value}"
                return


async def stream_chat_auto(messages: List[ChatMessage], api_key: Optional[str], system_prompt: str):
    """The default path: try the local model first (if Ollama is running),
    and transparently fall back to the built-in cloud API otherwise. The
    user never sees which backend answered."""
    key = (api_key or "").strip() or OPENROUTER_API_KEY_ENV
    has_image = message_has_image(messages)

    try:
        async with httpx.AsyncClient(timeout=None) as client:
            # Small local models are almost never vision-capable, so skip
            # straight to the cloud when the user attached an image.
            if not has_image and await is_ollama_available(client):
                got_any_chunk = False
                async for kind, value in _stream_local_raw(client, messages, system_prompt):
                    if kind == "chunk":
                        got_any_chunk = True
                        yield value
                    elif kind == "retry":
                        break
                if got_any_chunk:
                    return

            if not key:
                yield (
                    "[Saro AI] I'm not able to respond right now — no local model is running "
                    "and no cloud API key is configured. Please try again later."
                )
                return

            async for kind, value in _stream_openrouter_raw(client, messages, key, system_prompt, has_image):
                if kind == "chunk":
                    yield value
                elif kind == "fatal":
                    yield f"[Saro AI] {value}"
                    return
    except Exception as exc:
        yield f"[Saro AI] Unexpected error: {exc}"


@app.post("/api/chat")
async def chat(req: ChatRequest, request: Request):
    system_prompt = build_system_prompt(req.ai_name)
    if req.provider:
        generator = stream_provider_direct(req, system_prompt)
    else:
        generator = stream_chat_auto(req.messages, req.api_key, system_prompt)
    return StreamingResponse(generator, media_type="text/plain; charset=utf-8")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
