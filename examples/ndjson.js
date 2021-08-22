const { ndjsonStream } = require('../dist')
const ndjson = require('./testPatients');

const asyncIter = ndjsonStream.applyToNdjsonStream(
    ndjson,
    (resource) => {
        const {name}=resource;
        const {given,family} = name[0];
        const nameText = `${family[0]}, ${given[0]}`
        return Promise.resolve(console.log(nameText));
    },
    e => Promise.resolve(console.error(e)));

(async () => {
    for await (result of asyncIter) {
        await result;
    }
})();