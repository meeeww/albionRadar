const { initListener } = require('./src/event-listener')
const { startRadar, ingest, observe } = require('./src/radar')

startRadar()

const listener = initListener({
    readyMessage: 'Listening. Open http://<this-pc>:' + (Number(process.env.PACKET_PORT) || 4789) + ' from any device on the network, then move once in a zone.',
})

listener.on('event', (message) => {
    ingest('event', message)
    observe('event', message)
})
listener.on('request', (message) => {
    ingest('request', message)
    observe('request', message)
})
listener.on('response', (message) => ingest('response', message))
