import { createCliRenderer } from "@opentui/core";
import { buildApp } from "./ui";

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  backgroundColor: "#202923",
  useMouse: true,
  consoleMode: "disabled",
});
buildApp(renderer, process.argv[2] ?? process.cwd());
