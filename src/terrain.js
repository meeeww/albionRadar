const fs = require('fs')
const path = require('path')

const CELL = 2

function createTerrain(filePath, emit) {
    const maps = {}
    let saveTimer = null
    let lastEmit = 0

    function load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
            if (parsed.cell && parsed.cell !== CELL) return
            for (const [map, body] of Object.entries(parsed.maps || {})) {
                maps[map] = {
                    blocked: new Set(body.blocked || []),
                    open: new Set(body.open || []),
                }
            }
        } catch {
            return
        }
    }

    function mapOf(map) {
        const key = map || 'unknown'
        if (!maps[key]) maps[key] = { blocked: new Set(), open: new Set() }
        return maps[key]
    }

    function keyAt(x, y) {
        return `${Math.round(x / CELL)},${Math.round(y / CELL)}`
    }

    function centerOf(key) {
        const [gx, gy] = key.split(',').map(Number)
        return { x: gx * CELL, y: gy * CELL, key }
    }

    function save() {
        const out = { cell: CELL, maps: {} }
        for (const [map, body] of Object.entries(maps)) {
            out.maps[map] = {
                blocked: [...body.blocked],
                open: [...body.open],
            }
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, JSON.stringify(out))
    }

    function scheduleSave() {
        if (saveTimer) return
        saveTimer = setTimeout(() => {
            saveTimer = null
            save()
        }, 800)
        if (typeof saveTimer.unref === 'function') saveTimer.unref()
    }

    function touch(map) {
        const now = Date.now()
        if (now - lastEmit < 400) return
        lastEmit = now
        emit('terrain', around(map, null, 0))
    }

    function mark(map, x, y, state) {
        const body = mapOf(map)
        const key = keyAt(x, y)
        body.blocked.delete(key)
        body.open.delete(key)
        if (state === 'blocked') body.blocked.add(key)
        if (state === 'open') body.open.add(key)
        scheduleSave()
        touch(map)
    }

    function markSegment(map, ax, ay, bx, by) {
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / CELL))
        for (let i = 0; i <= steps; i++) {
            const t = i / steps
            mark(map, ax + (bx - ax) * t, ay + (by - ay) * t, 'open')
        }
    }

    function stateAt(map, x, y) {
        const body = mapOf(map)
        const key = keyAt(x, y)
        if (body.blocked.has(key)) return 'blocked'
        if (body.open.has(key)) return 'open'
        return 'unknown'
    }

    function around(map, center, radius) {
        const body = mapOf(map)
        const blocked = [...body.blocked].map(centerOf)
        const open = [...body.open].map(centerOf)
        if (!center || !radius) return { map: map || 'unknown', cell: CELL, blocked, open }
        const reach = radius + CELL
        return {
            map: map || 'unknown',
            cell: CELL,
            blocked: blocked.filter((cell) => Math.hypot(cell.x - center.x, cell.y - center.y) <= reach),
            open: open.filter((cell) => Math.hypot(cell.x - center.x, cell.y - center.y) <= reach),
        }
    }

    function counts(map) {
        const body = mapOf(map)
        return { blocked: body.blocked.size, open: body.open.size }
    }

    function nearestUnknown(map, x, y, radius) {
        const body = mapOf(map)
        let best = null
        let bestDistance = Infinity
        const span = Math.ceil(radius / CELL)
        const gx = Math.round(x / CELL)
        const gy = Math.round(y / CELL)
        for (let ix = -span; ix <= span; ix++) {
            for (let iy = -span; iy <= span; iy++) {
                const key = `${gx + ix},${gy + iy}`
                if (body.blocked.has(key) || body.open.has(key)) continue
                const cell = centerOf(key)
                const away = Math.hypot(cell.x - x, cell.y - y)
                if (away < CELL || away > radius || away >= bestDistance) continue
                best = cell
                bestDistance = away
            }
        }
        return best
    }

    function route(map, from, to) {
        const body = mapOf(map)
        const start = keyAt(from.x, from.y)
        const goal = keyAt(to.x, to.y)
        if (start === goal) return [centerOf(goal)]
        const open = new Map([[start, Math.hypot(from.x - to.x, from.y - to.y)]])
        const came = new Map()
        const walked = new Map([[start, 0]])
        let seen = 0
        while (open.size && seen < 900) {
            seen += 1
            let current = null
            let best = Infinity
            for (const [key, value] of open) {
                if (value < best) {
                    best = value
                    current = key
                }
            }
            if (current === goal) break
            open.delete(current)
            const here = centerOf(current)
            for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
                const nextKey = `${Math.round(here.x / CELL) + ox},${Math.round(here.y / CELL) + oy}`
                if (body.blocked.has(nextKey)) continue
                const next = centerOf(nextKey)
                const step = Math.hypot(next.x - here.x, next.y - here.y)
                const extra = body.open.has(nextKey) ? 1 : 1.2
                const cost = walked.get(current) + step * extra
                if (cost >= (walked.get(nextKey) ?? Infinity)) continue
                came.set(nextKey, current)
                walked.set(nextKey, cost)
                open.set(nextKey, cost + Math.hypot(next.x - to.x, next.y - to.y))
            }
        }
        if (!came.has(goal) && start !== goal) return null
        const points = []
        let cursor = goal
        while (cursor) {
            points.push(centerOf(cursor))
            cursor = came.get(cursor)
        }
        points.reverse()
        return points
    }

    function pointAlong(points, distance) {
        if (!points || !points.length) return null
        let left = distance
        for (let i = 1; i < points.length; i++) {
            const step = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
            if (step >= left) {
                const t = left / step
                return {
                    x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
                    y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
                }
            }
            left -= step
        }
        return points[points.length - 1]
    }

    load()

    return {
        CELL,
        mark,
        markSegment,
        stateAt,
        around,
        counts,
        nearestUnknown,
        route,
        pointAlong,
        keyAt,
    }
}

module.exports = { createTerrain, CELL }
