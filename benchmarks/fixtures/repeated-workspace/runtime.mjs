import configuration from "./runtime-config.json" with { type: "json" };

export const supportedProtocolVersion = 1;
export function accepts(version) {
  return version === configuration.protocolVersion && version === supportedProtocolVersion;
}
