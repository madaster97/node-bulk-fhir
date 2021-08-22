import { ReadStream } from 'fs';
import { string, Codec, record, unknown, GetType } from 'purify-ts/Codec';
import { Either } from 'purify-ts/Either';
import * as split2 from 'split2';

async function* splitToLines(chunkIterable: ReadStream): AsyncIterable<string> {
    const lineIterable = chunkIterable.pipe(split2());
    for await (const line of lineIterable) {
        yield line;
    }
}

async function* getJsonIterable(ndjsonStream: ReadStream): AsyncIterable<Either<string, unknown>> {
    const lineIterable = splitToLines(ndjsonStream);
    for await (const line of lineIterable) {
        yield Either.encase(() => JSON.parse(line)).mapLeft(e => e.message);
    }
}

const Record = record(string, unknown);
type Record = GetType<typeof Record>;
const Resource = Codec.interface({
    id: string,
    resourceType: string
});
type Resource = GetType<typeof Resource>;

type ResourceData = {
    id: string,
    resourceType: string,
    [key: string]: unknown
}

async function* getResourceIterable(ndjsonStream: ReadStream): AsyncIterable<Either<string, ResourceData>> {
    const jsonResultIterable = getJsonIterable(ndjsonStream);
    for await (const jsonCheck of jsonResultIterable) {
        yield jsonCheck.chain(json => {
            return Record.decode(json)
                .chain(record => {
                    const resource = Resource.decode(record);
                    return resource.map(({id,resourceType}) => {
                        return {
                            ...record,
                            id,
                            resourceType
                        }
                    });
                });
        });
    }
}

export async function* applyToNdjsonStream<T>
    (ndjsonStream: ReadStream, cb: (data: ResourceData) => PromiseLike<T>, error: (e: string) => PromiseLike<T>): AsyncIterable<T> {
    const resourceIterable = getResourceIterable(ndjsonStream);
    for await (const line of resourceIterable) {
        yield await line.caseOf({
            Left: error,
            Right: cb
        });
    }
}