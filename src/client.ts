import { JWK } from "jose";
import { PrivateKeyInput } from "crypto";
import { Config } from './config';
import { Issuer, Client, TokenSet, custom } from 'openid-client';
import { Either, Right, Left } from 'purify-ts/Either';
import { EitherAsync } from 'purify-ts/EitherAsync';
import got, { BeforeRequestHook, AfterResponseHook, Got } from 'got';
import { Just, Maybe, Nothing } from "purify-ts/Maybe";

const logBefore: BeforeRequestHook = (options) => {
    console.log('--> %s %s', options.method.toUpperCase(), options.url.href);
    console.log('--> HEADERS %o', options.headers);
    if (options.body) {
        console.log('--> BODY %s', options.body);
    }
    if (options.form) {
        console.log('--> FORM %s', options.form);
    }
}
const logAfter: AfterResponseHook = (response) => {
    console.log('<-- %i FROM %s %s', response.statusCode, response.request.options.method.toUpperCase(), response.request.options.url.href);
    console.log('<-- HEADERS %o', response.headers);
    // if (response.body) {
    //     console.log('<-- BODY %o', response.body);
    // }
    return response;
}

custom.setHttpOptionsDefaults({
    hooks: {
        beforeRequest: [logBefore],
        afterResponse: [logAfter],
    },
});

// const WELL_KNOWN = '.well-known/openid-configuration';
type AllowedKeys = JWK.ECKey | JWK.RSAKey;
const getKey = (private_key: PrivateKeyInput): Either<string, AllowedKeys> => {
    const keyCheck = Either.encase(() => JWK.asKey(private_key)).mapLeft(e => e.message);
    return keyCheck.chain(key => {
        const keyTypeCheck: Either<string, AllowedKeys> = (() => {
            switch (key.kty) {
                case 'EC':
                    return (key.crv == 'P-384') ? Right({ ...key, alg: 'ES384' }) : Left(`Invalid Elliptic Curve encountered: ${key.crv}.`)
                case 'RSA':
                    // return (key.alg != 'RS384') ? Left(`Invalid RSA algorithm used: ${key.alg}.`) : Right(key);
                    return Right(key);
                default:
                    return Left(`Invalid key type (kty) encountered: ${key.kty}.`)
            }
        })();
        return keyTypeCheck.mapLeft(e => `${e} SMART Backend Services defines the allowed algorithms of ES384 and RS384.`);
    });
}

const getClient = ({ client_id, token_url, private_key }: Config): EitherAsync<unknown, Client> => {
    const keyCheck = getKey(private_key);
    return EitherAsync.liftEither(keyCheck)
        .chain(key => {
            const issuerCheck = EitherAsync.liftEither(Either.encase(() => {
                return new Issuer({
                    issuer: token_url,
                    token_endpoint: token_url,
                    token_endpoint_auth_methods_supported: ['private_key_jwt'],
                    token_endpoint_auth_signing_alg_values_supported: ['RS384', 'ES384']
                });
            }));
            return issuerCheck.map(issuer => {
                return new issuer.Client({
                    client_id,
                    token_endpoint_auth_method: 'private_key_jwt',
                    token_endpoint_auth_signing_alg: key.alg || 'RS384'
                }, {
                    keys: [key.toJWK(true)]
                });
            });
        });
}

type Granter = () => EitherAsync<unknown, TokenSet>;
const getGranter = (config: Config): Granter => {
    const clientCheck = getClient(config);
    return () => clientCheck.chain(client => {
        return EitherAsync(() => client.grant({ grant_type: 'client_credentials' }))
    });
}

type Kickoff = { type: 'kickoff' };
type StatusAndDelete = { type: 'statusAndDelete' };
type DecompressedStream = { type: 'decompressedStream' };
type CompressedStream = { type: 'compressedStream', acceptEncoding: string };
export type FileEntry = { requiresAccessToken: boolean } & (DecompressedStream | CompressedStream);
export type RequestorType = Kickoff | StatusAndDelete | FileEntry;
export type GetRequestor = (requestorType: RequestorType) => Got;
const getRequestor = (granter?: Granter): GetRequestor => (requestorType) => {
    type RequestorConfig = {
        throwHttpErrors: boolean,
        requiresAccessToken: boolean,
        isKickoff: boolean,
        isStream: boolean,
        acceptEncoding: Maybe<string>
    };

    const { acceptEncoding, isKickoff, isStream, requiresAccessToken, throwHttpErrors } =
        ((): RequestorConfig => {
            switch (requestorType.type) {
                case 'kickoff':
                    return {
                        acceptEncoding: Nothing,
                        isKickoff: true,
                        isStream: false,
                        requiresAccessToken: true,
                        throwHttpErrors: false
                    }
                case 'statusAndDelete':
                    return {
                        acceptEncoding: Nothing,
                        isKickoff: false,
                        isStream: false,
                        requiresAccessToken: true,
                        throwHttpErrors: false
                    }
                case 'compressedStream':
                    return {
                        acceptEncoding: Just(requestorType.acceptEncoding),
                        isKickoff: false,
                        isStream: true,
                        requiresAccessToken: requestorType.requiresAccessToken,
                        throwHttpErrors: true
                    }
                case 'decompressedStream':
                    return {
                        acceptEncoding: Nothing,
                        isKickoff: false,
                        isStream: true,
                        requiresAccessToken: requestorType.requiresAccessToken,
                        throwHttpErrors: true
                    };
            }
        })();

    const headers = isKickoff
        ? { 'Accept': 'application/fhir+json', 'Prefer': 'respond-async' }
        : { 'Accept': 'application/json' }

    const beforeRequest: BeforeRequestHook[] = [logBefore];
    if (requiresAccessToken) {
        if (granter) {
            beforeRequest.push(async (options) => {
                await granter().caseOf({
                    Left: e => { throw new Error(JSON.stringify(e, null, 2)) },
                    Right: token => { options.headers.Authorization = token.access_token }
                })
            })
        }
    }

    acceptEncoding.map<BeforeRequestHook>(encoding => {
        return options => { options.headers['Accept-Encoding'] = encoding }
    }).map(beforeRequest.push);

    return got.extend({
        hooks: {
            beforeRequest,
            afterResponse: [logAfter]
        },
        headers,
        throwHttpErrors,
        mutableDefaults: true,
        isStream,
        decompress: acceptEncoding.isNothing(),

    });
}

export function configureRequestors(config: Config) {
    // const granter = getGranter(config);
    return !!config.token_url
        ? getRequestor(getGranter(config))
        : getRequestor();
}


