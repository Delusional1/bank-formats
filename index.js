'use strict';
/*
 * bank-formats — public entry point.
 *
 * The engine is a single dependency-free UMD file so the exact same code runs in
 * Node and in a browser <script> tag. This module just re-exports it with named
 * exports as well, so both of these work:
 *
 *   const { convert } = require('bank-formats');
 *   const bank = require('bank-formats');  bank.convert(...)
 */

var Engine = require('./src/engine.js');

module.exports = Engine;

// Named exports for destructuring, without losing the default object above.
module.exports.default = Engine;
