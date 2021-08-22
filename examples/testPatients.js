const { createReadStream } = require('fs');
const { join } = require('path');

const file = join(__dirname, 'patients.ndjson');
module.exports = createReadStream(file, { encoding: 'utf-8' });
