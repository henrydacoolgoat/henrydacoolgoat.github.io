# Revamped AI

## Default behavior

Revamped AI is enabled by default. Open **Settings → Comet intelligence** to turn it off or choose an action-presentation mode.

- **Automatic:** Comet displays the lightweight cursor only for interface tasks where seeing the action is useful.
- **Instant:** Comet completes actions without cursor animation.
- **Visual:** Comet visually demonstrates eligible interface actions. Message sending remains hidden in every mode.

## Low-end devices

The toggle itself does not start or download a new large model. Asteroid OS detects limited memory/CPU conditions and activates Lite-safe rendering, reducing blur, animation duration, and cursor effects. Existing local model selection remains responsible for choosing Comet Edge, SmolLM2, or Qwen according to the current device settings.

## Web and cloud routing

Asteroid Browser remains the first source for live web knowledge. Gemini API is explicitly treated as optional cloud computing for requests that need it; it is not required for the new toggle or message controls.

## MessageX

Direct commands such as `message @henry saying the build is ready` send through the bundled MessageX session without opening its window or displaying the visual cursor. A compact banner at the top displays the recipient and exact sent text. Contact display names resolve through Asteroid Contacts; an exact `@username` can also be used.

## Notes memory

When Comet stores explicit personal memories, Revamped AI mirrors them into **Comet Memory Vault** in Asteroid Notes. The note remains user-owned, editable, deletable, locally cached, and included in the existing Notes sync workflow.

## Direct MessageX username routing

Revamped AI accepts any valid MessageX username directly, with or without the `@` prefix. Asteroid Contacts are optional aliases rather than a prerequisite for messaging.
