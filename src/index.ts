import { Config } from './config';
// import GetCache from './stateCache';
import { GetStateMachine, KickoffParams, FileEntry, CompleteResponse, KickoffSucceeded, KickoffType, DeletionResult } from './stateMachine';
import { FileEntry as FileEntryRequestor } from './client';
import { getStatusChecker } from './statusChecks';
import { EitherAsync } from 'purify-ts/EitherAsync';
// import { MaybeAsync } from 'purify-ts/MaybeAsync';
import { Either, Left, Right } from 'purify-ts/Either';
import { Just, Maybe, Nothing } from 'purify-ts/Maybe';

export * as ndjsonStream from './ndjson';

export const getInstance = (config: Config) => {
    // Get State Machine
    // const decompressedFileEntry = getRequestor({type: 'decompressedStream', requiresAccessToken: true})
    // const compressedFileEntry = getRequestor({type: 'compressedStream', acceptEncoding: 'gzip, deflate, br', requiresAccessToken: true})   

    // const { cacheGroup, getGroup } = GetCache();
    const { deleteRequest, fileEntryRequest, kickoffRequest, statusRequest } = GetStateMachine(config);
    const statusChecker = getStatusChecker(config,statusRequest);

    const kickoff = (kickoffType: KickoffType, optParams?: KickoffParams): EitherAsync<unknown, {location: string, response: CompleteResponse}> => {
        /**
         * Steps to take:
         * 0. Check group's state
         * 1. Attempt Kickoff
         *  - If successful, go to 2
         *  - Otherwise return an error
         * 2. Make status request
         *  - If successful, go to 3
         *  - If limited, set a timeOut and go back to 2
         *  - Otherwise return an error
         * 3. Return document
         * 
         * -1. Every time we respond to the caller, cache the group's state
         */
        // const ensureUnknown: EitherAsync<string, { unknownGroupId: string }> = getGroup(maybeGroupId)
        //     .chain(status => {
        //         const either =
        //             status.type == 'unknown'
        //                 ? Right({ unknownGroupId: maybeGroupId })
        //                 : Left(`Group already exist with status ${status.type}. Try recovery or deletion on this group instead.`)
        //         return EitherAsync.liftEither(either);
        //     });

        // const attemptKickoff = ensureUnknown.chain(({ unknownGroupId: groupId }) => {
        //     return kickoffRequest(groupId, optParams);
        // });
        
        const attemptKickoff = kickoffRequest(kickoffType, optParams);
        console.log('Attempted kickoff')

        const checkKickoffStatus: EitherAsync<unknown, KickoffSucceeded> = attemptKickoff.chain(status => {
            const getDiagnostics = (outcome: Maybe<unknown>) => outcome.map(obj => `. Status: ${JSON.stringify(obj)}`).orDefault('');
            const either: Either<unknown, KickoffSucceeded> = (() => {
                switch (status.type) {
                    case 'kickoff-succeeded':
                        return Right(status);
                    case 'kickoff-limited':
                        return Left(`Kickoff rate limited by server. Try again later${getDiagnostics(status.outcome)}`);
                    case 'kickoff-failed':
                        return Left(`Kickoff failed with status: ${status.responseStatus.statusCode + '/' + status.responseStatus.statusMessage.orDefault('')}`);
                }
            })();
            return EitherAsync.liftEither(either);
        });

        return checkKickoffStatus.chain(statusChecker).chain(complete => {
            // const status = complete.extract();
            // const cacheAttempt = cacheGroup(complete.groupId, complete);
            // return cacheAttempt.toEitherAsync<CompleteResponse>(complete.response).swap();
            return EitherAsync.liftEither(complete.map(({response,location}) => { return {response,location}}));
        });
    };

    const deletion = (location: string): EitherAsync<unknown,DeletionResult> => {
        return deleteRequest({location});
    };
    //     const statusCheck = getGroup(groupId);
    //     const typeCheck = statusCheck.chain((status): EitherAsync<unknown, Deleteable> => {
    //         const deleteableCheck = ((): Either<string, Deleteable> => {
    //             switch (status.type) {
    //                 case 'complete':
    //                 case 'in-progress':
    //                 case 'kickoff-succeeded':
    //                 case 'status-limited':
    //                     return Right(status);
    //                 default:
    //                     return Left('Group is in invalid status: ' + status.type)
    //             }
    //         })();
    //         return EitherAsync.liftEither(deleteableCheck);
    //     });
    //     const attemptDeleteAndCache = typeCheck.chain(deleteRequest)
    //         .chain((status): EitherAsync<string, DeletionResult> => {
    //             const cacheAttempt = cacheGroup(status.groupId, status);
    //             return cacheAttempt.toEitherAsync<DeletionResult>(status).swap();
    //         });
    //     return attemptDeleteAndCache.chain(status => {
    //         const either: Either<string, {}> = status.type == 'deleted'
    //             ? Right({})
    //             : Left('Deletion failed');
    //         return EitherAsync.liftEither(either);
    //     }).swap().toMaybeAsync();
    // }

    const getFileEntryRequestor = (config: FileEntryRequestor) => (url: string) => {
        return fileEntryRequest(url, config);
    }

    return {
        kickoff,
        getFileEntryRequestor,
        deletion
        // recovery
    }
};