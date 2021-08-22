import { CheckRequestStatus, KickoffSucceeded, Complete, Errored, CheckedStatus, InProgress, StatusLimited } from './stateMachine';
import { EitherAsync } from 'purify-ts/EitherAsync'
import { setTimeout } from 'timers';
import { Config } from './config';
import { Right, Left, Either } from 'purify-ts/Either';
import { Maybe } from 'purify-ts/Maybe';

const getWaitAsync = (seconds: number): EitherAsync<never, void> => {
    return EitherAsync(() =>
        new Promise((res) => {
            setTimeout(res, seconds * 1000)
        })
    );
}

export const getStatusChecker = (config: Config, checker: CheckRequestStatus) => (kickoff: KickoffSucceeded): EitherAsync<unknown, Either<Errored, Complete>> => {
    const { retryAfterDefault: md, xProgressToRetryAfter: mxtr } = config;
    const retryAfterDefault = Maybe.fromNullable(md);
    const xProgressToRetryAfter = Maybe.fromNullable(mxtr);
    const defaultWait = retryAfterDefault.orDefault(0);
    const initWait = getWaitAsync(defaultWait);
    const initial = initWait.chain(() => checker(kickoff));
    type WrappedRetry = { retryAfter: number, lastStatus: InProgress | StatusLimited }
    const endOrRetry = (status: CheckedStatus): Either<WrappedRetry, Errored | Complete> => {
        switch (status.type) {
            case 'complete':
                return Right(status);
            case 'error':
                return Right(status);
            case 'in-progress':
                return Left(status.retryAfter
                    .orDefaultLazy(() => {
                        return xProgressToRetryAfter.chain(f => {
                            return status['X-Progress'].map(f)
                        }).orDefault(defaultWait);
                    })).mapLeft(retryAfter => { return { retryAfter, lastStatus: status } })
            case 'status-limited':
                return Left(status.retryAfter.orDefault(defaultWait))
                    .mapLeft(retryAfter => { return { retryAfter, lastStatus: status } })
        }
    };
    const retry = ({ lastStatus, retryAfter }: WrappedRetry): EitherAsync<unknown, Either<WrappedRetry, Errored | Complete>> => {
        console.log('Re-checking after %d seconds based on prior status: %s', retryAfter, lastStatus);
        const wait = getWaitAsync(retryAfter);
        const attempt = wait.chain(() => {
            return checker(lastStatus);
        });
        const result = attempt.map(endOrRetry);
        const again = result.chain(rs => {
            return rs.caseOf({
                Left: retry,
                Right: (terminal) => EitherAsync.liftEither(Right(Right(terminal)))
            });
        });
        return again;
    }

    return initial.chain(status => {
        // const checkStatus = ({ lastStatus, retryAfter }: WrappedRetry): EitherAsync<unknown, Either<WrappedRetry, Errored | Complete>> => {
        //     console.log('Re-checking after %d seconds based on prior status: %s');
        //     const wait = EitherAsync<unknown, void>(() => getTimeOutPromise(retryAfter));
        //     const checkResult = wait.chain(() => {
        //         const recheck = endOrRetry(lastStatus);
        //         return recheck.caseOf({
        //             // Recursion
        //             Left: checkStatus,
        //             Right: (terminal) => EitherAsync.liftEither(Right(Right(terminal)))
        //         })
        //     });
        //     return checkResult;

        //     // console.log('Re-checking after %d seconds based on prior status: %s', retryAfter, lastStatus)
        //     // const wait = EitherAsync<unknown, void>(() => getTimeOutPromise(retryAfter));
        //     // const newCheck = wait.chain(() => {
        //     //     return checker(lastStatus);
        //     // });
        //     // const checkedStatus = newCheck.chain(checked => {
        //     //     return EitherAsync.liftEither(endOrRetry(checked));
        //     // });
        //     // const checkResult = checkedStatus.caseOf({
        //     //     Left: checkStatus,
        //     //     Right: (terminal) => EitherAsync.liftEither(Right(Right(terminal)))
        //     // });
        //     // // return checkedStatus.caseOf({
        //     // //     // Recursion
        //     // //     Left: checkStatus,
        //     // //     Right: (terminal) => EitherAsync.liftEither(Right(Right(terminal)))
        //     // // })
        // }

        switch (status.type) {
            case 'in-progress':
            case 'status-limited':
                return retry({ lastStatus: status, retryAfter: 0 }).map(either => {
                    return either.caseOf({
                        Left: () => { throw new Error('Status Check Recursion Failed') },
                        Right: (terminal) => {
                            return terminal.type == 'complete' ? Right(terminal) : Left(terminal);
                        }
                    })
                });
            case 'complete':
                return EitherAsync.liftEither<unknown, Either<Errored, Complete>>(Right(Right(status)));
            case 'error':
                return EitherAsync.liftEither<unknown, Either<Errored, Complete>>(Right(Left(status)));
        }
    });
}