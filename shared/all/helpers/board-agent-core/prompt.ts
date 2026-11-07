// Join a prompts.json entry and substitute {{placeholders}}. The replacement
// goes through a function so '$' sequences in user-provided values are
// inserted literally (string replacements treat $&, $$ etc. specially).
export function buildPrompt(
  lines: string[],
  vars: Record<string, string> = {}
): string {
  let text = lines.join('\n');
  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{{${key}}}`, () => value);
  }
  return text;
}
