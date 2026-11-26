import { redact } from "./redact.js";
export function emitLog(logger, level, message) {
    try {
        logger?.[level]?.(redact(message).replaceAll("\r", "\\r").replaceAll("\n", "\\n"));
    }
    catch {
        // Diagnostics must never change the operation they describe.
    }
}
