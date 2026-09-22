const http = require('http')
const fs = require('fs')
const path = require('path')
const { createWorld } = require('./world')

const PORT = Number(process.env.PACKET_PORT) || 4789
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'))

const clients = new Set()

function send(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of clients) {
        try {
            client.write(payload)
        } catch {
            clients.delete(client)
        }
    }
}

const world = createWorld(send)

function startRadar() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/radar')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
            res.end(PAGE)
            return
        }

        if (req.method === 'GET' && url.pathname === '/api/state') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' })
            res.end(JSON.stringify(world.snapshot()))
            return
        }

        if (req.method === 'GET' && url.pathname === '/stream') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
            })
            res.write('\n')
            clients.add(res)
            req.on('close', () => clients.delete(res))
            return
        }

        if (req.method === 'POST' && url.pathname === '/api/clear') {
            world.clear()
            res.writeHead(204)
            res.end()
            return
        }

        res.writeHead(404)
        res.end()
    })

    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            console.log(`Port ${PORT} is already in use. Close the other process, or set PACKET_PORT.`)
            process.exit(1)
        }
        throw error
    })

    server.listen(PORT, '127.0.0.1', () => {
        console.log(`Radar: http://127.0.0.1:${PORT}`)
    })

    setInterval(() => world.prune(3 * 60 * 1000), 15000)
    return server
}

module.exports = {
    startRadar,
    ingest: world.ingest,
}
