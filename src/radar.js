const http = require('http')
const fs = require('fs')
const path = require('path')
const { createWorld } = require('./world')
const { createGather } = require('./gather')
const { createTerrain } = require('./terrain')

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
const terrain = createTerrain(path.join(__dirname, '..', 'data', 'terrain.json'), send)
const gather = createGather(() => world.snapshot(), send, terrain)

function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
            try {
                const text = Buffer.concat(chunks).toString()
                resolve(text ? JSON.parse(text) : {})
            } catch (error) {
                reject(error)
            }
        })
        req.on('error', reject)
    })
}

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
            const snap = world.snapshot()
            res.end(JSON.stringify({
                ...snap,
                gather: gather.publicState(),
                terrain: terrain.view(snap.player.map),
            }))
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

        if (req.method === 'POST' && url.pathname === '/api/gather') {
            readJson(req).then((body) => {
                const next = gather.configure(body)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify(next))
            }).catch(() => {
                res.writeHead(400)
                res.end()
            })
            return
        }

        if (req.method === 'POST' && url.pathname === '/api/gather/aim') {
            const result = gather.aim()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
            return
        }

        if (req.method === 'POST' && url.pathname === '/api/gather/mark') {
            const result = gather.markNode()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
            return
        }

        if (req.method === 'POST' && url.pathname === '/api/gather/calibrate') {
            const result = gather.calibrate()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
            return
        }

        if (req.method === 'POST' && url.pathname.startsWith('/api/terrain/')) {
            readJson(req).then((body) => {
                const action = url.pathname.slice('/api/terrain/'.length)
                let result = gather.zonesView()
                if (action === 'begin') result = gather.draftBegin()
                else if (action === 'point') result = gather.draftPoint(body.x, body.y)
                else if (action === 'undo') result = gather.draftUndo()
                else if (action === 'cancel') result = gather.draftCancel()
                else if (action === 'ramp') result = gather.markRamp(body.id, body.x, body.y)
                else if (action === 'solid') result = gather.markSolid(body.id)
                else if (action === 'remove') result = gather.removeZone(body.id)
                else {
                    res.writeHead(404)
                    res.end()
                    return
                }
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify(result))
            }).catch(() => {
                res.writeHead(400)
                res.end()
            })
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

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Radar: http://0.0.0.0:${PORT}`)
    })

    setInterval(() => world.prune(3 * 60 * 1000), 15000)
    return server
}

function observe(kind, message) {
    gather.observe(kind, message)
}

module.exports = {
    startRadar,
    ingest: world.ingest,
    observe,
}
