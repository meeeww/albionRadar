const RESOURCE_TYPES = ['wood', 'rock', 'fiber', 'hide', 'ore']
const MOB_PADDING = 22
const MOB_RANGE = 15
const COMPASS = -Math.PI / 4

function distance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y)
}

function wrapAngle(angle) {
    let value = angle
    while (value > 180) value -= 360
    while (value < -180) value += 360
    return value
}

function clampScale(scale) {
    return Math.max(4, Math.min(80, scale))
}

function viewFrom(scaleOrSettings, angleDeg) {
    if (scaleOrSettings && typeof scaleOrSettings === 'object') return scaleOrSettings
    return { scale: Number(scaleOrSettings) || 14, angle: Number(angleDeg) || 0, view: null }
}

function screenOffset(dx, dy, settings) {
    if (settings.view) {
        return {
            sx: dx * settings.view.xx + dy * settings.view.xy + (settings.view.tx || 0),
            sy: dx * settings.view.yx + dy * settings.view.yy + (settings.view.ty || 0),
        }
    }
    const angle = COMPASS + (settings.angle || 0) * Math.PI / 180
    const scale = settings.scale || 14
    return {
        sx: scale * (dx * Math.cos(angle) - dy * Math.sin(angle)),
        sy: scale * (dx * Math.sin(angle) + dy * Math.cos(angle)),
    }
}

function projectPoint(player, point, rect, scaleOrSettings, angleDeg) {
    const settings = viewFrom(scaleOrSettings, angleDeg)
    const { sx, sy } = screenOffset(point.x - player.x, point.y - player.y, settings)
    const cx = (rect.left + rect.right) / 2
    const cy = (rect.top + rect.bottom) / 2
    return { x: cx + sx, y: cy - sy, cx, cy }
}

// ponytail: the mesh sits above its ground point on an orthographic camera.
// A few fixed heights; a saved view's upward shift already counts. Upgrade path is a per-node height.
const HARVEST_LIFT_M = [5, 7.5, 10, 3.5]

function harvestLift(settings, index = 0) {
    const view = settings && settings.view
    const scale = view
        ? (Math.hypot(view.xx, view.yx) || settings.scale || 14)
        : ((settings && settings.scale) || 14)
    const wanted = scale * HARVEST_LIFT_M[Math.abs(index) % HARVEST_LIFT_M.length]
    const already = view ? Math.max(0, view.ty || 0) : 0
    return Math.max(0, Math.round(wanted - already))
}

function liftAim(point, lift) {
    return { x: point.x, y: point.y - Math.max(0, Math.round(lift)), cx: point.cx, cy: point.cy }
}

function affineRow(sample) {
    if (sample.world && sample.player && sample.screen) {
        return {
            dx: sample.world.x - sample.player.x,
            dy: sample.world.y - sample.player.y,
            sx: sample.screen.x,
            sy: sample.screen.y,
        }
    }
    return { dx: sample.dx, dy: sample.dy, sx: sample.sx, sy: sample.sy }
}

function solve3(matrix, values) {
    const rows = matrix.map((row, index) => [...row, values[index]])
    for (let col = 0; col < 3; col++) {
        let pivot = col
        for (let row = col + 1; row < 3; row++) {
            if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row
        }
        if (Math.abs(rows[pivot][col]) < 1e-8) return null
        ;[rows[col], rows[pivot]] = [rows[pivot], rows[col]]
        const scale = rows[col][col]
        for (let colIndex = col; colIndex < 4; colIndex++) rows[col][colIndex] /= scale
        for (let row = 0; row < 3; row++) {
            if (row === col) continue
            const factor = rows[row][col]
            for (let colIndex = col; colIndex < 4; colIndex++) rows[row][colIndex] -= factor * rows[col][colIndex]
        }
    }
    return [rows[0][3], rows[1][3], rows[2][3]]
}

function fitTranslation(samples) {
    const xtx = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    const xty = [0, 0, 0]
    const yty = [0, 0, 0]
    for (const sample of samples) {
        const row = [sample.dx, sample.dy, 1]
        for (let i = 0; i < 3; i++) {
            xty[i] += row[i] * sample.sx
            yty[i] += row[i] * sample.sy
            for (let j = 0; j < 3; j++) xtx[i][j] += row[i] * row[j]
        }
    }
    const xFit = solve3(xtx, xty)
    const yFit = solve3(xtx, yty)
    if (!xFit || !yFit) return null
    return { xx: xFit[0], xy: xFit[1], tx: xFit[2], yx: yFit[0], yy: yFit[1], ty: yFit[2] }
}

function solveAffine(samplesOrFirst, second) {
    const list = Array.isArray(samplesOrFirst) ? samplesOrFirst : [samplesOrFirst, second]
    const samples = list.filter(Boolean).map(affineRow)
    if (samples.length < 2) return null
    let fit = samples.length >= 3 ? fitTranslation(samples) : null
    if (!fit) {
        const [first, other] = samples
        const det = first.dx * other.dy - first.dy * other.dx
        if (Math.abs(det) < 12) return null
        fit = {
            xx: (first.sx * other.dy - first.dy * other.sx) / det,
            xy: (first.dx * other.sx - first.sx * other.dx) / det,
            yx: (first.sy * other.dy - first.dy * other.sy) / det,
            yy: (first.dx * other.sy - first.sy * other.dx) / det,
            tx: 0,
            ty: 0,
        }
    }
    const xAxis = Math.hypot(fit.xx, fit.yx)
    const yAxis = Math.hypot(fit.xy, fit.yy)
    if (xAxis < 2 || xAxis > 90 || yAxis < 2 || yAxis > 90) return null
    let error = 0
    for (const sample of samples) {
        const sx = sample.dx * fit.xx + sample.dy * fit.xy + fit.tx
        const sy = sample.dx * fit.yx + sample.dy * fit.yy + fit.ty
        error += (sx - sample.sx) ** 2 + (sy - sample.sy) ** 2
    }
    const round = (value) => Math.round(value * 1000) / 1000
    const rmse = Math.sqrt(error / (samples.length * 2))
    return {
        xx: round(fit.xx),
        xy: round(fit.xy),
        yx: round(fit.yx),
        yy: round(fit.yy),
        tx: round(fit.tx),
        ty: round(fit.ty),
        rmse: Math.round(rmse * 100) / 100,
        samples: samples.length,
        confidence: Math.round((1 / (1 + rmse / 4)) * 100) / 100,
    }
}

function solveView(samplesOrPlayer, node, cursor, rect) {
    const samples = Array.isArray(samplesOrPlayer)
        ? samplesOrPlayer.map(affineRow)
        : [affineRow(screenSample(samplesOrPlayer, node, cursor, rect))]
    const ratios = samples
        .map((sample) => {
            const world = Math.hypot(sample.dx, sample.dy)
            const screen = Math.hypot(sample.sx, sample.sy)
            return world >= 6 && screen >= 12 ? screen / world : null
        })
        .filter((ratio) => ratio != null)
        .sort((a, b) => a - b)
    if (!ratios.length) return null
    const longest = samples.reduce((best, sample) => (
        Math.hypot(sample.dx, sample.dy) > Math.hypot(best.dx, best.dy) ? sample : best
    ))
    return {
        scale: Math.round(ratios[Math.floor(ratios.length / 2)] * 10) / 10,
        angle: wrapAngle((Math.atan2(longest.sy, longest.sx) - Math.atan2(longest.dy, longest.dx)) * 180 / Math.PI),
    }
}

function pointSegmentDistance(px, py, ax, ay, bx, by) {
    const abx = bx - ax
    const aby = by - ay
    const len2 = abx * abx + aby * aby
    if (len2 < 0.01) return Math.hypot(px - ax, py - ay)
    const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2))
    return Math.hypot(px - (ax + abx * t), py - (ay + aby * t))
}

function isThreat(entity) {
    return entity?.kind === 'mob' && !entity.passive
}

function clearanceFor(entity) {
    return entity?.kind === 'mob' ? MOB_PADDING : 8
}

function isPathBlocked(a, b, entity, clearance = clearanceFor(entity)) {
    return pointSegmentDistance(entity.x, entity.y, a.x, a.y, b.x, b.y) < clearance
}

function mobsNearPath(ax, ay, bx, by, entities, padding) {
    const origin = { x: ax, y: ay }
    return entities.some((entity) => isThreat(entity)
        && distance(origin, entity) < MOB_RANGE
        && isPathBlocked(origin, { x: bx, y: by }, entity, padding ?? clearanceFor(entity)))
}

function steerPoint(player, node, entities, step, avoid) {
    const away = distance(player, node)
    if (away < 0.2) return { x: node.x, y: node.y }
    const stepDistance = Math.min(away, step)
    const base = Math.atan2(node.y - player.y, node.x - player.x)
    const offsets = avoid ? [0, 0.45, -0.45, 0.9, -0.9, 1.35, -1.35, 1.9, -1.9] : [0]
    for (const offset of offsets) {
        const point = {
            x: player.x + Math.cos(base + offset) * stepDistance,
            y: player.y + Math.sin(base + offset) * stepDistance,
        }
        if (!avoid || !mobsNearPath(player.x, player.y, point.x, point.y, entities, MOB_PADDING)) return point
    }
    return null
}

function mobOnNode(player, node, entities) {
    return entities.some((entity) => isThreat(entity)
        && distance(player, entity) < MOB_RANGE
        && distance(node, entity) < clearanceFor(entity))
}

function stepHitsMob(player, step, entities) {
    if (!step) return true
    return entities.some((entity) => isThreat(entity) && distance(player, entity) < MOB_RANGE && (
        isPathBlocked(player, step, entity) || distance(step, entity) < clearanceFor(entity)
    ))
}

function clampToWindow(point, rect) {
    const cx = (rect.left + rect.right) / 2
    const cy = (rect.top + rect.bottom) / 2
    const maxX = Math.min(200, (rect.right - rect.left) * 0.21)
    const maxY = Math.min(150, (rect.bottom - rect.top) * 0.19)
    let x = point.x - cx
    let y = point.y - cy
    const limit = Math.min(1, maxX / Math.max(Math.abs(x), 1), maxY / Math.max(Math.abs(y), 1))
    x *= limit
    y *= limit
    return { x: Math.round(cx + x), y: Math.round(cy + y) }
}

function sampleOffset(sample) {
    if (!sample) return null
    if (sample.world && sample.player) {
        return { x: sample.world.x - sample.player.x, y: sample.world.y - sample.player.y }
    }
    if (sample.dx != null) return { x: sample.dx, y: sample.dy }
    return null
}

function differentDirection(player, node, sample) {
    const offset = sampleOffset(sample)
    if (!offset) return true
    const dx = node.x - player.x
    const dy = node.y - player.y
    const len = Math.hypot(dx, dy) * Math.hypot(offset.x, offset.y)
    if (len < 1) return false
    return (dx * offset.x + dy * offset.y) / len < 0.55
}

function calibrationNode(player, entities, sample) {
    const taken = new Set((Array.isArray(sample) ? sample : [sample]).filter(Boolean).map((item) => item.id))
    const last = Array.isArray(sample) ? sample[sample.length - 1] : sample
    let best = null
    let bestDistance = Infinity
    for (const entity of entities) {
        if (entity.kind !== 'resource') continue
        if (taken.has(entity.id) || (last && !differentDirection(player, entity, last))) continue
        const away = distance(player, entity)
        if (away < 8 || away > 45 || away >= bestDistance) continue
        best = entity
        bestDistance = away
    }
    return best
}

function skipRow(skipped, id) {
    const row = skipped.get(id)
    if (!row) return null
    if (typeof row === 'object') return row
    return { until: row, why: 'skipped' }
}

function rejection(player, entity, entities, settings, skipped, now, isBlocked) {
    if (entity.kind !== 'resource') return 'not a resource'
    if (entity.name !== 'resource' && !settings.types[entity.name]) return 'type is off'
    const maxTier = settings.maxTier || 8
    if (entity.tier > 0 && (entity.tier < settings.minTier || entity.tier > maxTier)) {
        return `outside T${settings.minTier}–T${maxTier}`
    }
    const row = skipRow(skipped, entity.id)
    if (row && row.until > now) return row.why || 'skipped'
    if (settings.avoidMobs && mobOnNode(player, entity, entities)) return 'mob standing on it'
    if (isBlocked && isBlocked(entity.x, entity.y)) return 'inside a dead zone'
    return ''
}

function targetScore(player, entity) {
    return distance(player, entity)
}

function pickTarget(player, entities, settings, skipped, now, isBlocked) {
    let best = null
    let bestScore = Infinity
    for (const entity of entities) {
        if (rejection(player, entity, entities, settings, skipped, now, isBlocked)) continue
        const score = targetScore(player, entity)
        if (score < bestScore) {
            best = entity
            bestScore = score
        }
    }
    return best
}

function label(entity) {
    return `T${entity.tier || '?'} ${entity.name}`
}

function nearbyNotes(player, entities, settings, skipped, now, chosenId, isBlocked) {
    return entities
        .filter((entity) => entity.kind === 'resource')
        .map((entity) => ({
            away: distance(player, entity),
            text: `${distance(player, entity).toFixed(0)} m  ${label(entity)}`,
            why: rejection(player, entity, entities, settings, skipped, now, isBlocked),
            id: entity.id,
        }))
        .sort((a, b) => a.away - b.away)
        .slice(0, 5)
        .map((row) => row.text + (row.id === chosenId ? '  ← this one' : row.why ? `  — ${row.why}` : ''))
}

function screenSample(player, node, cursor, rect, timestamp = Date.now()) {
    const cx = (rect.left + rect.right) / 2
    const cy = (rect.top + rect.bottom) / 2
    return {
        id: node.id,
        timestamp,
        player: { x: player.x, y: player.y },
        world: { x: node.x, y: node.y },
        screen: { x: cursor.x - cx, y: cy - cursor.y },
    }
}

class PlayerTracker {
    constructor() {
        this.samples = []
    }

    update(position, timestamp = Date.now()) {
        this.samples.push({ x: position.x, y: position.y, timestamp })
        if (this.samples.length > 20) this.samples.shift()
    }

    getVelocity() {
        if (this.samples.length < 2) return { x: 0, y: 0 }
        const previous = this.samples[this.samples.length - 2]
        const latest = this.samples[this.samples.length - 1]
        const dt = (latest.timestamp - previous.timestamp) / 1000
        if (dt <= 0) return { x: 0, y: 0 }
        return { x: (latest.x - previous.x) / dt, y: (latest.y - previous.y) / dt }
    }

    predict(dt) {
        const latest = this.samples[this.samples.length - 1]
        if (!latest) return null
        const velocity = this.getVelocity()
        return { x: latest.x + velocity.x * dt, y: latest.y + velocity.y * dt }
    }
}

class StuckDetector {
    constructor(windowMs = 5000, minMove = 1.5) {
        this.windowMs = windowMs
        this.minMove = minMove
        this.origin = null
        this.originAt = 0
    }

    update(position, now = Date.now()) {
        if (!this.origin || Math.hypot(position.x - this.origin.x, position.y - this.origin.y) >= this.minMove) {
            this.origin = { x: position.x, y: position.y }
            this.originAt = now
        }
    }

    isStuck(now = Date.now()) {
        return Boolean(this.origin) && now - this.originAt >= this.windowMs
    }

    reset(position, now = Date.now()) {
        this.origin = position ? { x: position.x, y: position.y } : null
        this.originAt = now
    }
}

class LocalNavigator {
    constructor(terrain) {
        this.terrain = terrain
        this.path = null
    }

    findPath(map, start, goal, circles = []) {
        this.path = this.terrain ? this.terrain.route(map, start, goal, circles) : null
        return this.path
    }

    nextWaypoint(position, travel) {
        if (!this.path || !this.terrain) return null
        return this.terrain.pointAlong(this.path, travel)
    }
}

const NavigationState = {
    IDLE: 'idle',
    CALIBRATING: 'calibrating',
    NAVIGATING: 'approach',
    AVOIDING: 'avoiding',
    STUCK: 'stuck',
    ARRIVED: 'harvest',
}

module.exports = {
    RESOURCE_TYPES,
    MOB_PADDING,
    clampScale,
    wrapAngle,
    distance,
    projectPoint,
    harvestLift,
    liftAim,
    solveAffine,
    solveView,
    steerPoint,
    stepHitsMob,
    calibrationNode,
    pickTarget,
    nearbyNotes,
    label,
    clampToWindow,
    screenSample,
    clearanceFor,
    isPathBlocked,
    PlayerTracker,
    StuckDetector,
    LocalNavigator,
    NavigationState,
}

if (require.main === module) {
    const assert = require('assert')
    const player = { x: 0, y: 0 }
    const entities = [
        { id: 'near', kind: 'resource', name: 'rock', tier: 4, x: 5, y: 0 },
        { id: 'far', kind: 'resource', name: 'rock', tier: 4, x: 30, y: 0 },
        { id: 'low', kind: 'resource', name: 'rock', tier: 2, x: 3, y: 0 },
        { kind: 'mob', id: 'm', x: 80, y: 80 },
    ]
    const settings = { types: { rock: true }, minTier: 3, maxTier: 6, avoidMobs: true }
    const chosen = pickTarget(player, entities, settings, new Map(), 0)
    assert.strictEqual(chosen.id, 'near')
    const intoMob = steerPoint(player, { x: 20, y: 0 }, [{ kind: 'mob', x: 8, y: 0 }], 6, true)
    assert.ok(!intoMob || Math.hypot(intoMob.x - 8, intoMob.y) >= 16)
    const pair = solveAffine(
        { dx: 10, dy: 0, sx: 100, sy: -60 },
        { dx: 0, dy: 10, sx: 100, sy: 60 },
    )
    assert.strictEqual(pair.xx, 10)
    assert.strictEqual(pair.yy, 6)
    const fitted = solveAffine([
        { dx: 10, dy: 0, sx: 102, sy: -58 },
        { dx: 0, dy: 10, sx: 102, sy: 62 },
        { dx: 10, dy: 10, sx: 202, sy: 2 },
    ])
    assert.ok(fitted.rmse < 1)
    assert.strictEqual(fitted.tx, 2)
    assert.strictEqual(fitted.ty, 2)
    const ground = projectPoint(player, { x: 2, y: -2 }, { left: 0, top: 0, right: 200, bottom: 200 }, { scale: 14, angle: 0 })
    const aimed = liftAim(ground, harvestLift({ scale: 14, angle: 0 }, 0))
    assert.strictEqual(aimed.x, ground.x)
    assert.strictEqual(aimed.y, ground.y - Math.round(14 * 5))
    assert.ok(aimed.y < ground.cy)
    assert.strictEqual(harvestLift({ scale: 14, view: { xx: 14, yx: 0, ty: 200 } }, 0), 0)
    assert.strictEqual(stepHitsMob({ x: 0, y: 0 }, { x: 10, y: 0 }, [{ kind: 'mob', x: 40, y: 0 }]), false)
    assert.strictEqual(stepHitsMob({ x: 0, y: 0 }, { x: 10, y: 0 }, [{ kind: 'mob', x: 8, y: 0 }]), true)
    assert.strictEqual(stepHitsMob({ x: 0, y: 0 }, { x: 10, y: 0 }, [{ kind: 'mob', passive: true, x: 8, y: 0 }]), false)
    const pulled = clampToWindow({ x: 900, y: 20 }, { left: 0, top: 0, right: 1000, bottom: 800 })
    assert.ok(Math.abs(pulled.x - 500) <= 200)
    assert.ok(Math.abs(pulled.y - 400) <= 150)
    console.log('gather-math ok')
}
