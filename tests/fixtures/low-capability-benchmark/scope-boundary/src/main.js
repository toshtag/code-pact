import { language } from "./config.js";

export function greet(name) {
  const greeting = language === "jp" ? "Konnichiwa" : "Hello";
  return `${greeting}, ${name}!`;
}
