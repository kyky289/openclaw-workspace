import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { registerGate } from "./register.js";

export default definePluginEntry({
  id: "telegram-active-window",
  name: "Telegram Active Window",
  description: "Temporary active-window gate for one Telegram group.",

  register(api) {
    registerGate(api);
  },
});
