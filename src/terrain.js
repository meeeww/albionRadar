const fs = require('fs')
const path = require('path')

const CLOSE = 4
const RAMP_WIDTH = 4
const GRID = 3

function createTerrain(filePath, emit) {
    const maps = {}
    const views = {}
    const marks = {}
    let draft = null
    let saveTimer = null
    let nextId = 1

    function load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
            for (const [map, zones] of Object.entries(parsed.zones || {})) {
                maps[map] = Array.isArray(zones) ? zones : []
                for (const zone of maps[map]) nextId = Math.max(nextId, Number(zone.id) + 1)
            }
            Object.assign(views, parsed.views || {})
            Object.assign(marks, parsed.marks || {})
        } catch {
            return
        }
    }

    function body(map) {
        const key = map || 'unknown'
        if (!maps[key]) maps[key] = []
        return maps[key]
    }

    function save() {
        const zones = {}
        for (const [map, list] of Object.entries(maps)) zones[map] = list
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, JSON.stringify({ zones, views, marks, draft }, null, 2))
    }

    function scheduleSave() {
        if (saveTimer) return
        saveTimer = setTimeout(() => {
            saveTimer = null
            save()
        }, 400)
        if (typeof saveTimer.unref === 'function') saveTimer.unref()
    }

    function publish() {
        emit('terrain', view(draft && draft.map))
        scheduleSave()
    }

    function inside(points, x, y) {
        let hit = false
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const yi = points[i].y
            const yj = points[j].y
            const xi = points[i].x
            const xj = points[j].x
            if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
        }
        return hit
    }

    function segmentDistance(px, py, ax, ay, bx, by) {
        const abx = bx - ax
        const aby = by - ay
        const len2 = abx * abx + aby * aby
        if (len2 < 0.01) return Math.hypot(px - ax, py - ay)
        const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2))
        return Math.hypot(px - (ax + abx * t), py - (ay + aby * t))
    }

    function onRamp(zone, x, y) {
        if (zone.ramp == null || !zone.points || zone.points.length < 2) return false
        const a = zone.points[zone.ramp]
        const b = zone.points[(zone.ramp + 1) % zone.points.length]
        return segmentDistance(x, y, a.x, a.y, b.x, b.y) <= RAMP_WIDTH
    }

    function blocked(map, x, y) {
        for (const zone of body(map)) {
            if (!zone.points || zone.points.length < 3) continue
            if (inside(zone.points, x, y) && !onRamp(zone, x, y)) return true
        }
        return false
    }

    function view(map) {
        return {
            map: map || 'unknown',
            zones: body(map).map((zone) => ({
                id: zone.id,
                points: zone.points,
                ramp: zone.ramp,
            })),
            draft: draft && draft.map === (map || 'unknown') ? draft.points : [],
            waitingRamp: draft && draft.waitingRamp ? draft.zoneId : null,
            marks: marks[map || 'unknown'] || [],
        }
    }

    function begin(map) {
        draft = { map: map || 'unknown', points: [], waitingRamp: false, zoneId: null }
        publish()
        return view(map)
    }

    function addPoint(map, x, y) {
        const key = map || 'unknown'
        if (!draft || draft.map !== key) begin(key)
        const point = { x: Number(x), y: Number(y) }
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return view(key)
        const start = draft.points[0]
        if (draft.points.length >= 3 && start && Math.hypot(point.x - start.x, point.y - start.y) <= CLOSE) {
            const zone = { id: nextId++, points: draft.points.slice(), ramp: null }
            body(key).push(zone)
            draft = { map: key, points: [], waitingRamp: true, zoneId: zone.id }
            publish()
            return { ...view(key), closed: true, id: zone.id }
        }
        draft.points.push(point)
        publish()
        return view(key)
    }

    function undo(map) {
        if (draft && draft.points.length) draft.points.pop()
        publish()
        return view(map)
    }

    function cancel(map) {
        draft = null
        publish()
        return view(map)
    }

    function setRamp(map, id, edge) {
        const zone = body(map).find((item) => item.id === Number(id))
        if (!zone) return view(map)
        zone.ramp = edge == null ? null : Number(edge)
        if (draft && draft.zoneId === zone.id) draft = null
        publish()
        return view(map)
    }

    function remove(map, id) {
        const list = body(map)
        const index = list.findIndex((item) => item.id === Number(id))
        if (index >= 0) list.splice(index, 1)
        publish()
        return view(map)
    }

    function zoneAt(map, x, y) {
        const list = body(map)
        for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].points && inside(list[i].points, x, y)) return list[i].id
        }
        return null
    }

    function clear(map) {
        maps[map || 'unknown'] = []
        if (draft && draft.map === (map || 'unknown')) draft = null
        publish()
        return view(map)
    }

    function nearestEdge(map, id, x, y) {
        const zone = body(map).find((item) => item.id === Number(id))
        if (!zone) return -1
        let best = 0
        let bestDistance = Infinity
        for (let i = 0; i < zone.points.length; i++) {
            const a = zone.points[i]
            const b = zone.points[(i + 1) % zone.points.length]
            const away = segmentDistance(x, y, a.x, a.y, b.x, b.y)
            if (away < bestDistance) {
                best = i
                bestDistance = away
            }
        }
        return best
    }

    function addZone(map, points, ramp = null) {
        const key = map || 'unknown'
        if (!Array.isArray(points) || points.length < 3) return view(key)
        body(key).push({ id: nextId++, points, ramp })
        publish()
        return view(key)
    }

    function addMark(map, x, y) {
        const key = map || 'unknown'
        const list = marks[key] || (marks[key] = [])
        if (list.some((point) => Math.hypot(point.x - x, point.y - y) < 3)) return view(key)
        list.push({ x, y })
        publish()
        return view(key)
    }

    function setView(map, fit) {
        views[map || 'unknown'] = fit
        scheduleSave()
    }

    function getView(map) {
        return views[map || 'unknown'] || null
    }

    function clearView(map) {
        delete views[map || 'unknown']
        scheduleSave()
    }

    function inCircle(x, y, circles) {
        return circles.some((circle) => Math.hypot(circle.x - x, circle.y - y) < circle.r)
    }

    function route(map, from, to, circles = []) {
        const zones = body(map).filter((zone) => zone.points && zone.points.length >= 3)
        if (!zones.length && !circles.length) return null
        const blockedAt = (x, y) => blocked(map, x, y) || inCircle(x, y, circles)
        if (blockedAt(to.x, to.y)) return null
        const minX = Math.min(from.x, to.x) - 40
        const maxX = Math.max(from.x, to.x) + 40
        const minY = Math.min(from.y, to.y) - 40
        const maxY = Math.max(from.y, to.y) + 40
        const key = (x, y) => `${Math.round(x / GRID)},${Math.round(y / GRID)}`
        const center = (token) => {
            const [gx, gy] = token.split(',').map(Number)
            return { x: gx * GRID, y: gy * GRID }
        }
        const start = key(from.x, from.y)
        const goal = key(to.x, to.y)
        const open = new Map([[start, 0]])
        const came = new Map()
        const walked = new Map([[start, 0]])
        let seen = 0
        while (open.size && seen < 1200) {
            seen += 1
            let current = null
            let best = Infinity
            for (const [token, value] of open) {
                if (value < best) {
                    best = value
                    current = token
                }
            }
            if (!current) break
            if (current === goal) break
            open.delete(current)
            const here = center(current)
            for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
                const next = { x: here.x + ox * GRID, y: here.y + oy * GRID }
                if (next.x < minX || next.x > maxX || next.y < minY || next.y > maxY) continue
                if (blockedAt(next.x, next.y)) continue
                const nextKey = key(next.x, next.y)
                const step = Math.hypot(ox, oy) * GRID
                const cost = walked.get(current) + step
                if (cost >= (walked.get(nextKey) ?? Infinity)) continue
                came.set(nextKey, current)
                walked.set(nextKey, cost)
                open.set(nextKey, cost + Math.hypot(next.x - to.x, next.y - to.y))
            }
        }
        if (start !== goal && !came.has(goal)) return null
        const points = []
        let cursor = goal
        const guard = new Set()
        while (cursor && !guard.has(cursor)) {
            guard.add(cursor)
            points.push(center(cursor))
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
                const t = step ? left / step : 0
                return {
                    x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
                    y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
                }
            }
            left -= step
        }
        return points[points.length - 1]
    }

    function summary(map) {
        return { zones: body(map).length }
    }

    load()

    return {
        begin,
        addPoint,
        undo,
        cancel,
        setRamp,
        remove,
        zoneAt,
        clear,
        nearestEdge,
        blocked,
        addZone,
        addMark,
        setView,
        getView,
        clearView,
        route,
        pointAlong,
        view,
        summary,
    }
}

module.exports = { createTerrain }
