#!/usr/bin/env node
// dsh-patch executable launcher. The real implementation lives in the
// compiled CLI module; this thin wrapper keeps the shebang portable.
import { main } from '../build/src/cli.js'

const code = await main(process.argv.slice(2))
process.exitCode = code
