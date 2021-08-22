const instance = require('./instance');
(async () => {
    const responseCheck = await instance.kickoff({ type: 'system' }, {});
    responseCheck.caseOf({
        Left: console.error,
        Right: async (rs) => {
            console.log(rs.response.output);
            const tryDelete = await instance.deletion(rs.location);
            tryDelete.caseOf({
                Left: console.error,
                Right: drs => {
                    console.log(drs);
                }
            })
        }
    });
})();