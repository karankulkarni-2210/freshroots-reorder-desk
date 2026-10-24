// Writes the demo dataset as the three CSV files IT would export from SAP.
// Run: node make-sample-data.js   (output: sample-data/)
const fs = require('node:fs');
const path = require('node:path');
const E = require('./engine.js');

const out = path.join(__dirname, 'sample-data');
fs.mkdirSync(out, { recursive: true });
const files = E.demoCsv(E.demoData());
for (const [name, body] of Object.entries(files)) {
  fs.writeFileSync(path.join(out, name), body);
  console.log(name, (body.length / 1e6).toFixed(1) + ' MB', body.split('\n').length - 2 + ' rows');
}
