import { getIcon as getSetiIcon } from "seti-icons";

const setiTheme = {
  blue: "#519aba",
  grey: "#4d5a5e",
  "grey-light": "#6d8086",
  green: "#8dc149",
  orange: "#e37933",
  pink: "#f55385",
  purple: "#a074c4",
  red: "#cc3e44",
  white: "#d4d7d6",
  yellow: "#cbcb41",
  ignore: "#41535b",
} as const;

function basenameOfPath(pathValue: string): string {
  const lastSlashIndex = Math.max(pathValue.lastIndexOf("/"), pathValue.lastIndexOf("\\"));
  return lastSlashIndex === -1 ? pathValue : pathValue.slice(lastSlashIndex + 1);
}

export function getSetiFileIconUrl(pathValue: string): string {
  const icon = getSetiIcon(basenameOfPath(pathValue));
  const color = setiTheme[icon.color] ?? setiTheme.white;
  const svg = icon.svg.replace("<svg ", `<svg xmlns="http://www.w3.org/2000/svg" fill="${color}" `);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
