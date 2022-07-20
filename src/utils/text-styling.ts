export function applyStyle(text: string, style: string) {
    return `\x1B[${style}m${text}\x1B[0m`;
}