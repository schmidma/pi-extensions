import type { MessageRenderer } from "@earendil-works/pi-coding-agent";

export function messageRenderOptions(expanded: boolean, outputPad = 0): Parameters<MessageRenderer>[1] {
  const options = {
    expanded,
    outputPad,
    keyText: (_key: string) => "",
    keyHint: (_key: string, description: string) => description,
  };
  return options;
}
