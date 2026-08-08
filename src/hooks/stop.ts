#!/usr/bin/env node

import process from "node:process";
import { setTimeout } from "node:timers";

process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
setTimeout(() => process.exit(0), 500).unref();
