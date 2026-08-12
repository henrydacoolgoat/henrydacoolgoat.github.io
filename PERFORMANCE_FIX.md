# Performance fix

## What changed

1. Revamped AI remains on by default.
2. Phones, unknown-memory mobile browsers, low-memory devices, and low-thread devices enter Performance-first mode.
3. Performance-first mode never loads SmolLM2 360M or Qwen2.5 0.5B.
4. The bundled Comet Edge model is no longer decoded during startup; it loads only after an unmatched actionable request.
5. Automatic visual actions become instant on lite devices unless the user explicitly requests a visual walkthrough or selects Visual mode.
6. Comet memory is mirrored into Notes after a debounce and during browser idle time.
7. Notes only rerenders if the Notes window is currently open and not minimized.
8. Gemini remains optional cloud computing and keeps local AI in standby when configured.
