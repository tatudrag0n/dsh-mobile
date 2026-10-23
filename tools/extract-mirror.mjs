import { readFileSync } from "node:fs";
const l = readFileSync("C:/root/dsh-mobile/client.js", "utf8").split("\n");
for (let i = 700; i < 850; i++) console.log((i + 1) + "|" + l[i]);
