#!/usr/bin/env node
// The installed command. It is committed so npm finds it when it checks
// `bin` at publish, which happens before prepublishOnly builds dist/cli.js;
// pointing `bin` at dist/cli.js got the command stripped from 0.23.0.
require('../dist/cli.js');
