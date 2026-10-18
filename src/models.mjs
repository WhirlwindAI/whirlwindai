// Model IDs providers have shut down (requests fail) or announced for
// shutdown. Static, so it can only be as current as this package: run with
// --deep to ask each provider directly which models your key can use.

export const RETIRED = [
  // OpenAI
  /^(text|code)-davinci-00[1-3]$/,
  /^text-(curie|babbage|ada)-001$/,
  /^gpt-3\.5-turbo-(0301|0613|16k-0613)$/,
  /^gpt-4-32k(-0314|-0613)?$/,
  /^gpt-4(-1106)?-vision-preview$/,
  /^gpt-4\.5-preview(-2025-02-27)?$/,
  /^o1-preview(-2024-09-12)?$/,
  // Anthropic
  /^claude-instant(-1(\.\d)?)?$/,
  /^claude-(1|2)(\.\d)?$/,
  /^claude-3-sonnet-20240229$/,
  /^claude-3-opus-(20240229|latest)$/,
  /^claude-3-5-sonnet-(20240620|20241022|latest)$/,
  // Google
  /^gemini-(pro|pro-vision)$/,
  /^gemini-1\.0-pro.*$/,
  /^gemini-1\.5-(pro|flash|flash-8b)(-\d{3}|-latest)?$/,
  /^(text|chat|code)-bison(-\d+k)?(@\d+)?$/,
];

export const DEPRECATED = [
  /^gpt-4-(0314|1106-preview|0125-preview|turbo-preview)$/,
  /^o1-mini(-2024-09-12)?$/,
  /^dall-e-[23]$/,
  /^claude-3-7-sonnet-(20250219|latest)$/,
  /^claude-3-5-haiku-(20241022|latest)$/,
  /^claude-3-haiku-20240307$/,
  /^gemini-2\.0-(flash|flash-lite|pro-exp)(-\d{3}|-exp|-preview.*|-\d{2}-\d{2})?$/,
];

// Anything shaped like a model ID, so --deep can check the ones that aren't
// on either list.
export const MODEL_SHAPE = /^(gpt-[0-9a-z.\-]+|o[1-9](-[a-z0-9\-]+)?|chatgpt-[a-z0-9.\-]+|dall-e-\d|gpt-image-[0-9a-z.\-]+|claude-[a-z0-9.\-]+|gemini-[a-z0-9.\-]+|imagen-[a-z0-9.\-]+|(text|chat|code)-(davinci|curie|babbage|ada|bison)[a-z0-9@.\-]*)$/;

export const providerOf = (id) =>
  /^claude-/.test(id) ? "anthropic" : /^(gemini|imagen|text-bison|chat-bison|code-bison)/.test(id) ? "google" : "openai";

export const status = (id) =>
  RETIRED.some((r) => r.test(id)) ? "retired" : DEPRECATED.some((r) => r.test(id)) ? "deprecated" : null;
