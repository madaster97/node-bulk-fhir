const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ndjson = require('./testPatients');
const { ndjsonStream } = require('../dist');

const app = express();

app.get('/', (req, res) => {
    res.send(`
<html>
  <body>
    <h1>Patients</h1>
    <ul id="patients"></ul>
    <h1>Debug</h1>
    <div id="debug"></div>
    <script>
      var ws = new WebSocket('ws:localhost:3000/ws');
      ws.onmessage = function (event) {
        var text = event.data;
        if (text.includes('New Patient: ')) {
            var patLi = document.createElement('li');
            patLi.innerText = text.split('New Patient: ')[1];
            document.getElementById('patients').appendChild(patLi);    
        } else {
            document.getElementById('debug').innerText = event.data;
        }
      };
    </script>
  </body>
</html>
`);
});

const server = app.listen(3000, () => console.log('listening on http://localhost:3000'));

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, _) => {
    ws.send('Connected');
});
wss.on('complete', (ws, _, data) => {
    ws.send(`Complete: ${JSON.stringify(data)}`);
});
wss.on('errored', (ws, _, error) => {
    ws.send(`Errored: ${error}`);
});
wss.on('patient', (ws, _, patient) => {
    const { name } = patient;
    const { given, family } = name[0];
    const nameText = `${family[0]}, ${given[0]}`
    ws.send(`New Patient: ${nameText}`);
});

const instance = require('./instance');
const kickoff = instance.kickoff({ type: 'all-patients' }, {});

server.on('upgrade', async (req, socket, head) => {
    let res = new http.ServerResponse(req);
    res.assignSocket(socket);
    res.on('finish', () => res.socket.destroy());
    app.handle(req, res, () => {
        try {
            wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit('connection', ws, req);
                const emitComplete = (out) => wss.emit('complete', ws, req, out);
                const emitError = (e) => wss.emit('errored', ws, req, e);
                const emitPatient = (p) => wss.emit('patient', ws, req, p);
                kickoff.then(
                    (res) => {
                        res.caseOf({
                            Left: emitError,
                            Right: async (rs) => {
                                console.log(rs);
                                emitComplete(rs);
                                // TODO: Find a reference implementation where I can actually request Patients
                                const asyncIter = ndjsonStream.applyToNdjsonStream(
                                    ndjson,
                                    (resource) => {
                                        return Promise.resolve(emitPatient(resource));
                                    },
                                    e => Promise.resolve(emitError(e)));
                                
                                (async () => {
                                    for await (result of asyncIter) {
                                        await result;
                                    }
                                })();
                                const tryDelete = await instance.deletion(rs.location);
                                tryDelete.caseOf({
                                    Left: emitError,
                                    Right: drs => {
                                        console.log(drs);
                                    }
                                });
                            }
                        })
                    },
                    emitError)
            });
        } catch (e) {
            console.log('ERROR', e);
        }
    });
});