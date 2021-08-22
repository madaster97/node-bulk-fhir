import { Codec, exactly, oneOf, string, intersect, GetType, maybe, unknown, number, array, boolean, date, optional } from 'purify-ts/Codec';
import { EitherAsync } from 'purify-ts/EitherAsync';
import { Readable } from 'stream';
import { Response, Headers } from 'got';
import { Config } from './config';
import { GetRequestor, configureRequestors, FileEntry as FileEntryRequestor } from './client';
import { Tuple } from 'purify-ts/Tuple';
import { Just, Maybe, Nothing } from 'purify-ts/Maybe';
import { Either, Left, Right } from 'purify-ts/Either';

////////////////
// All States //
////////////////

// Core status result
const CoreStatus = Codec.interface({
    // groupId: string,
    type: string
});
// Attempted exports have a status and outcome
const HttpStatus = Codec.interface({
    statusCode: number,
    statusMessage: maybe(string)
});
const TooMany = number;
// Codec.interface({
//     retryAfter: number
//     // retryAt: date
// });
type TooMany = GetType<typeof TooMany>;
const KickoffFailed = intersect(CoreStatus, Codec.interface({
    type: exactly('kickoff-failed'),
    outcome: unknown,
    responseStatus: HttpStatus
}));
const KickoffLimited = intersect(CoreStatus, Codec.interface({
    type: exactly('kickoff-limited'),
    outcome: maybe(unknown),
    tooMany: maybe(TooMany)
}));
// In progress, errored and complete requests have location
const LocationKnown = intersect(CoreStatus, Codec.interface({
    location: string
}));
const FileEntry = Codec.interface({
    type: string,
    url: string,
    count: optional(number)
});
export type FileEntry = GetType<typeof FileEntry>;
const CompleteResponse = Codec.interface({
    transactionTime: string,
    request: string,
    requiresAccessToken: boolean,
    output: array(FileEntry),
    error: array(FileEntry),
    extension: optional(unknown)
});
export type CompleteResponse = GetType<typeof CompleteResponse>;
const KickoffSucceeded = intersect(LocationKnown, Codec.interface({
    type: exactly('kickoff-succeeded'),
    outcome: maybe(unknown)
}));
const InProgress = intersect(LocationKnown, Codec.interface({
    type: exactly('in-progress'),
    'X-Progress': maybe(string),
    retryAfter: maybe(TooMany)
}));
const StatusLimited = intersect(LocationKnown, Codec.interface({
    type: exactly('status-limited'),
    outcome: maybe(unknown),
    retryAfter: maybe(TooMany)
}));
const Errored = intersect(LocationKnown, Codec.interface({
    type: exactly('error'),
    outcome: unknown,
    lastStatus: HttpStatus
}));
const Complete = intersect(LocationKnown, Codec.interface({
    type: exactly('complete'),
    response: CompleteResponse
}));
// Keep prior location for deletion retries and debugging
const Deleted = intersect(CoreStatus, Codec.interface({
    type: exactly('deleted'),
    priorLocation: string,
    outcome: optional(unknown)
}));
const DeletionFailed = intersect(LocationKnown, Codec.interface({
    type: exactly('deletion-failed'),
    outcome: unknown,
    lastStatus: HttpStatus
}));
export const GroupStatus = oneOf([KickoffFailed, KickoffSucceeded, KickoffLimited, InProgress, StatusLimited, Errored, Complete, Deleted, DeletionFailed]);

// Define all states
type KickoffFailed = GetType<typeof KickoffFailed>;
export type KickoffSucceeded = GetType<typeof KickoffSucceeded>;
type KickoffLimited = GetType<typeof KickoffLimited>;
export type InProgress = GetType<typeof InProgress>;
export type StatusLimited = GetType<typeof StatusLimited>;
export type Errored = GetType<typeof Errored>;
export type Complete = GetType<typeof Complete>;
type Deleted = GetType<typeof Deleted>;
type DeletionFailed = GetType<typeof DeletionFailed>;

///////////////////
// State Machine //
///////////////////

// Kickoff a new request
export type KickoffResult = KickoffSucceeded | KickoffFailed | KickoffLimited;
type BaseParams = {
    _since?: string,
    _outputFormat?: 'application/fhir+ndjson' | 'application/ndjson' | 'ndjson'
}
export type KickoffParams = BaseParams & {
    types?: string[],
}
type MappedParams = BaseParams & {
    _type?: string
}
type GroupKickoff = {
    type: 'group',
    groupId: string
}
type PatientsKickoff = {
    type: 'all-patients'
}
type SystemKickoff = {
    type: 'system'
}
export type KickoffType = GroupKickoff | PatientsKickoff | SystemKickoff;
type KickoffRequest = (kickoffType: KickoffType, params?: KickoffParams) => EitherAsync<unknown, KickoffResult>;

// Delete a request with a polling location
// export type Deleteable = KickoffSucceeded | InProgress | StatusLimited | Complete;
export type DeletionResult = Deleted | DeletionFailed;
type DeleteRequest = (obj: {location: string}) => EitherAsync<unknown, DeletionResult>;

// Get the status of a kickoff-succeeded or in-progress request
export type CheckableStatus = KickoffSucceeded | InProgress | StatusLimited;
export type CheckedStatus = InProgress | StatusLimited | Errored | Complete;
export type CheckRequestStatus = (input: CheckableStatus) => EitherAsync<unknown, CheckedStatus>;

// Terminal States to recover/re-attempt from:
/**
 * KickoffFailed -> Need to just retry kickoff
 * KickoffLimited -> Same, but need to respect Retry-After
 * Errored -> Can't delete an errored sesssion, keep content-location for debugging
 * Deleted -> You're done!
 * DeletionFailed -> No way to recover, keeps content-location for debugging
 */
export type TerminalStates = KickoffFailed | KickoffLimited | Errored | Deleted | DeletionFailed;
// type Recover = (input: TerminalStates, params?: KickoffParams) => EitherAsync<unknown, KickoffResult>;

// Requesting from a file entry
type FileEntryRequest = (
    url: string,
    config: FileEntryRequestor) =>
    EitherAsync<unknown, Readable>;

///////////////
// Utilities //
///////////////
export type Limited = StatusLimited | KickoffLimited;
type LimitCheck = <T extends Limited>(input: T) => Tuple<boolean, T>
// const CheckIfLimited: LimitCheck = (input) => Tuple(input.tooMany.map(({ retryAt }) => retryAt > new Date()).orDefault(false), input);
const ParseJson = (response: Response<string>): Either<string,unknown> => {
    return Maybe.fromNullable(response.body).toEither(new Error('Empty body')).chain(text => Either.encase(() => JSON.parse(text))).mapLeft(e => e.message);
}
const CheckSingleHeader = (headers: Headers, key: string) => {
    return Maybe.fromNullable(headers[key])
        .toEither(`${key} missing`)
        .chain(key => Array.isArray(key) ? Left(`Multiple ${key} headers provided`) : Right(key))
}
const ParseRetryAfter = (retryAfterString: string): Maybe<TooMany> => {
    return Maybe.fromNullable(parseInt(retryAfterString))
        // .map(retryAfter => {
        //     // const now = new Date()
        //     return {
        //         retryAfter,
        //         // retryAt: new Date(now.getTime() + retryAfter * 1000)
        //     }
        // })
}
const NEED_JSON = (e: string) => 'Response body is missing or is not JSON. Additional error: ' + e;
const FAILED_NEEDS_JSON = (code: number,e: string) => `Response body [for status ${code}] is missing or is not JSON. Additional error: ${e}`;
const GetLastStatus = (response: Response) => {
    return {
        statusCode: response.statusCode,
        statusMessage: Maybe.fromNullable(response.statusMessage)
    }
}

////////////////////////
// Operations w/logic //
////////////////////////
type WrappedRequestor<T> = (getRequestor: GetRequestor) => T;

const KickoffRequest = (iss: string): WrappedRequestor<KickoffRequest> => (g) => (kickoffType, optParams) => {
    const requestor = g({ type: 'kickoff' });
    const searchParams = Maybe.fromNullable(optParams)
        .map((params): MappedParams => {
            return {
                _outputFormat: params._outputFormat,
                _since: params._since,
                _type: Maybe.fromNullable(params.types).map(types => types.join(',')).extract()
            }
        }).orDefault({});
    const path = (() => {
        switch (kickoffType.type) {
            case 'all-patients':
                return '/Patient'
            case 'system':
                return ''
            case 'group':
                return `/Group/${kickoffType.groupId}`
        }
    })();
    const url = iss + path + '/$export';
    const responseCheck =
        EitherAsync(() => {
            console.log('requesting')
            return requestor.get(url, { searchParams });
        });
    return responseCheck.chain(
        (response): EitherAsync<unknown, KickoffResult> => {
            const getOutcome = ((): Either<unknown, KickoffResult> => {
                console.log('Response: ' + response.statusCode)
                const eitherJson = ParseJson(response);
                const { headers } = response;
                switch (response.statusCode) {
                    case 202:
                        const success: Either<unknown, KickoffSucceeded> =
                            CheckSingleHeader(response.headers, 'content-location')
                                .map((location): KickoffSucceeded => {
                                    return {
                                        // groupId,
                                        location,
                                        outcome: eitherJson.toMaybe(),
                                        type: 'kickoff-succeeded'
                                    }
                                });
                        return success;
                    case 429:
                        const limited: KickoffLimited = {
                            // groupId,
                            type: 'kickoff-limited',
                            outcome: eitherJson.toMaybe(),
                            tooMany: CheckSingleHeader(headers, 'Retry-After').toMaybe().chain(ParseRetryAfter)
                        }
                        return Right(limited);
                    default:
                        const failure: Either<unknown, KickoffFailed> =
                            eitherJson.mapLeft((e) => FAILED_NEEDS_JSON(response.statusCode,e))
                                .map(outcome => {
                                    return {
                                        // groupId,
                                        outcome,
                                        responseStatus: GetLastStatus(response),
                                        type: 'kickoff-failed'
                                    }
                                });
                        return failure;
                }
            })
            return EitherAsync.liftEither(getOutcome());
        });
}

// const RecoverRequest = (iss: string): WrappedRequestor<Recover> => (g) => ({ groupId }, optParams) => {
//     return KickoffRequest(iss)(g)(groupId, optParams);
// }

const DeleteRequest: WrappedRequestor<DeleteRequest> = (g) => ({ location }) => {
    const requestor = g({ type: 'statusAndDelete' });
    const responseCheck =
        EitherAsync(() => {
            return requestor.delete(location);
        });
    return responseCheck.chain(
        (response): EitherAsync<unknown, DeletionResult> => {
            const getOutcome = ((): Either<unknown, DeletionResult> => {
                const eitherJson = ParseJson(response);
                const { headers } = response;
                switch (response.statusCode) {
                    case 202:
                        const deleted: Deleted = {
                            // groupId,
                            type: 'deleted',
                            outcome: eitherJson.toMaybe().extract(),
                            priorLocation: location
                        }
                        return Right(deleted);
                    default:
                        const deletionFailed: Either<unknown, DeletionFailed> =
                            eitherJson.mapLeft(e => FAILED_NEEDS_JSON(response.statusCode,e)).map(outcome => {
                                return {
                                    // groupId,
                                    type: 'deletion-failed',
                                    location,
                                    lastStatus: GetLastStatus(response),
                                    outcome
                                }
                            })
                        return deletionFailed;
                }
            })
            return EitherAsync.liftEither(getOutcome());
        });
}

const StatusRequest: WrappedRequestor<CheckRequestStatus> = (g) => (status) => {
    // const maybeLastLimited: Maybe<StatusLimited> = status.type == 'status-limited' ? Just(status) : Nothing;
    // const maybeTimePassed: Maybe<Tuple<boolean, StatusLimited>> =
    //     maybeLastLimited.map(CheckIfLimited);
    const resolve = () => {
        const requestor = g({ type: 'statusAndDelete' });
        const responseCheck =
            EitherAsync(() => {
                return requestor.get(location);
            });
        const { location } = status;
        return responseCheck.chain(
            (response): EitherAsync<unknown, CheckedStatus> => {
                const getOutcome = ((): Either<unknown, CheckedStatus> => {
                    const eitherJson = ParseJson(response);
                    const { headers, statusCode: code } = response;
                    switch (code) {
                        case 202:
                            const inProgress: InProgress = {
                                // groupId,
                                type: 'in-progress',
                                retryAfter: CheckSingleHeader(headers, 'Retry-After').toMaybe().chain(ParseRetryAfter),
                                'X-Progress': CheckSingleHeader(headers, 'X-Progress').toMaybe(),
                                location
                            }
                            return Right(inProgress);
                        case 429:
                            const limited: StatusLimited = {
                                // groupId,
                                type: 'status-limited',
                                location,
                                outcome: eitherJson.toMaybe(),
                                retryAfter: CheckSingleHeader(headers, 'Retry-After').toMaybe().chain(ParseRetryAfter)
                            }
                            return Right(limited);
                        case 200:
                            const completeCheck: Either<unknown, Complete> =
                                eitherJson.mapLeft(NEED_JSON)
                                    .chain(CompleteResponse.decode)
                                    .map(response => {
                                        return {
                                            // groupId,
                                            location,
                                            response,
                                            type: 'complete'
                                        }
                                    });
                            return completeCheck;
                        default:
                            const errored: Either<unknown, Errored> =
                                eitherJson.mapLeft(e => FAILED_NEEDS_JSON(code, e)).map(outcome => {
                                    return {
                                        // groupId,
                                        type: 'error',
                                        location,
                                        lastStatus: GetLastStatus(response),
                                        outcome
                                    }
                                });
                            return errored;
                    }
                })
                return EitherAsync.liftEither(getOutcome());
            });
    }
    // return maybeTimePassed.caseOf({
    //     Just: result => !result.fst() ? resolve() : EitherAsync.liftEither(Right(result.snd())),
    //     Nothing: resolve
    // });
    return resolve();
}

const FileEntryRequest: WrappedRequestor<FileEntryRequest> = (g) => (url, config) => {
    const requestor = g(config);
    return EitherAsync(() => requestor.get(url));
}

export const GetStateMachine = (config: Config) => {
    const getRequestor = configureRequestors(config);
    const kickoffRequest = KickoffRequest(config.fhir_url)(getRequestor);
    // const recoverRequest = RecoverRequest(config.fhir_url)(getRequestor);
    const statusRequest = StatusRequest(getRequestor);
    const deleteRequest = DeleteRequest(getRequestor);
    const fileEntryRequest = FileEntryRequest(getRequestor);
    return {
        kickoffRequest,
        statusRequest,
        deleteRequest,
        // recoverRequest,
        fileEntryRequest
    }
}