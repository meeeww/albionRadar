const { initListener } = require('./src/event-listener')
const { startRadar, ingest } = require('./src/radar')

startRadar()

const listener = initListener({
    readyMessage: 'Listening. Open http://127.0.0.1:4789 and move once in a zone. Your position becomes the center of the radar.',
})

listener.on('event', (message) => ingest('event', message))
listener.on('request', (message) => ingest('request', message))
listener.on('response', (message) => ingest('response', message))
