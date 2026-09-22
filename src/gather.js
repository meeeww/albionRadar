const { Window } = require('./window')

const RESOURCE_TYPES = ['wood', 'rock', 'fiber', 'hide', 'ore']
const REACH = 4
const WALK_STEP = 7
const CLICK_MS = 600
const HARVEST_GIVE_UP_MS = 14000
const SKIP_MS = 45000
const STUCK_MOVE = 1.2
const STUCK_CLICKS = 3
const SURROUND_RADIUS = 5
const SURROUND_STEPS = 8
const SURROUND_LAPS = 2

function projectPoint(player, point, rect, scale, angleDeg) {
    const dx = point.x - player.x
    const dy = point.y - player.y
    const angle = angleDeg * Math.PI / 180
    const sx = dx * Math.cos(angle) - dy * Math.sin(angle)
    const sy = dx * Math.sin(angle) + dy * Math.cos(angle)
    const cx = (rect.left + rect.right) / 2
    const cy = (rect.top + rect.bottom) / 2
    return {
        x: cx + sx * scale,
        y: cy - sy * scale,
        cx,
        cy,
    }
}

function clampToWindow(point, rect) {
    const marginX = Math.min(80, (rect.right - rect.left) / 5)
    const marginY = Math.min(100, (rect.bottom - rect.top) / 5)
    return {
        x: Math.round(Math.min(rect.right - marginX, Math.max(rect.left + marginX, point.x))),
        y: Math.round(Math.min(rect.bottom - marginY, Math.max(rect.top + marginY, point.y))),
    }
}

function distance(player, entity) {
    return Math.hypot(entity.x - player.x, entity.y - player.y)
}

function surroundPoint(player, node, step, radius) {
    const toward = Math.atan2(node.y - player.y, node.x - player.x)
    const angle = toward + Math.PI / 2 + step * (Math.PI * 2 / SURROUND_STEPS)
    return {
        x: player.x + Math.cos(angle) * radius,
        y: player.y + Math.sin(angle) * radius,
    }
}

function solveView(player, node, cursor, rect) {
    const dx = node.x - player.x
    const dy = node.y - player.y
    const world = Math.hypot(dx, dy)
    if (world < 6) return null
    const cx = (rect.left + rect.right) / 2
    const cy = (rect.top + rect.bottom) / 2
    const sx = cursor.x - cx
    const sy = cy - cursor.y
    const screen = Math.hypot(sx, sy)
    if (screen < 12) return null
    let angle = (Math.atan2(sy, sx) - Math.atan2(dy, dx)) * 180 / Math.PI
    while (angle > 180) angle -= 360
    while (angle < -180) angle += 360
    return {
        scale: Math.round((screen / world) * 10) / 10,
        angle: Math.round(angle),
    }
}

function calibrationNode(player, entities) {
    let best = null
    let bestDistance = Infinity
    for (const entity of entities) {
        if (entity.kind !== 'resource') continue
        const away = distance(player, entity)
        if (away < 8 || away > 40) continue
        if (away < bestDistance) {
            best = entity
            bestDistance = away
        }
    }
    return best
}

function pickTarget(player, entities, settings, skipped, now) {
    let best = null
    let bestDistance = Infinity
    for (const entity of entities) {
        if (entity.kind !== 'resource') continue
        if (!settings.types[entity.name]) continue
        if ((entity.tier || 0) < settings.minTier) continue
        if ((skipped.get(entity.id) || 0) > now) continue
        const away = distance(player, entity)
        if (away < bestDistance) {
            best = entity
            bestDistance = away
        }
    }
    return best
}

function createGather(snapshot, emit) {
    const settings = {
        enabled: false,
        types: { wood: true, rock: true, fiber: true, hide: true, ore: true },
        minTier: 1,
        scale: 14,
        angle: 0,
        automount: false,
    }
    const state = {
        status: 'off',
        targetId: null,
        detail: '',
    }
    const skipped = new Map()
    let phase = 'idle'
    let phaseSince = 0
    let lastClick = 0
    let harvestSize = null
    let busy = false
    let anchor = null
    let stuckClicks = 0
    let surroundStep = 0
    let surroundLaps = 0
    let surroundStartDistance = 0

    function publish(status, detail) {
        if (state.status === status && state.detail === detail) return
        state.status = status
        state.detail = detail
        emit('gather', publicState())
    }

    function publicState() {
        return {
            enabled: settings.enabled,
            types: { ...settings.types },
            minTier: settings.minTier,
            scale: settings.scale,
            angle: settings.angle,
            automount: settings.automount,
            status: state.status,
            targetId: state.targetId,
            detail: state.detail,
        }
    }

    function configure(next) {
        if (!next || typeof next !== 'object') return publicState()
        if (typeof next.enabled === 'boolean') settings.enabled = next.enabled
        if (next.types && typeof next.types === 'object') {
            for (const name of RESOURCE_TYPES) {
                if (typeof next.types[name] === 'boolean') settings.types[name] = next.types[name]
            }
        }
        const tier = Number(next.minTier)
        if (Number.isFinite(tier)) settings.minTier = Math.max(1, Math.min(8, Math.round(tier)))
        const scale = Number(next.scale)
        if (Number.isFinite(scale)) settings.scale = Math.max(4, Math.min(80, scale))
        const angle = Number(next.angle)
        if (Number.isFinite(angle)) settings.angle = Math.max(-180, Math.min(180, angle))
        if (typeof next.automount === 'boolean') settings.automount = next.automount
        if (!settings.enabled) {
            phase = 'idle'
            resetRoute()
            publish('off', '')
        }
        emit('gather', publicState())
        return publicState()
    }

    function mouse() {
        try {
            return require('robotjs')
        } catch {
            return null
        }
    }

    function clickAt(point, rect) {
        const cursor = mouse()
        if (!cursor) return false
        const spot = clampToWindow(point, rect)
        const win = Window.getByTitle('Albion Online Client')
        if (win) win.focus()
        cursor.moveMouse(spot.x, spot.y)
        cursor.mouseClick('left')
        lastClick = Date.now()
        return true
    }

    function aim() {
        const view = snapshot()
        const player = view.player
        if (!Number.isFinite(player.x)) return { ok: false, detail: 'Move once so the radar has your position.' }
        const win = Window.getByTitle('Albion Online Client')
        const rect = win && win.getDimensions()
        if (!rect) return { ok: false, detail: 'Albion window not found.' }
        const cursor = mouse()
        if (!cursor) return { ok: false, detail: 'Mouse control is not installed.' }
        const target = pickTarget(player, view.entities, settings, skipped, Date.now())
        if (!target) return { ok: false, detail: 'No matching resource in range.' }
        const point = projectPoint(player, target, rect, settings.scale, settings.angle)
        const spot = clampToWindow(point, rect)
        cursor.moveMouse(spot.x, spot.y)
        state.targetId = target.id
        publish('aiming', `Cursor on ${label(target)}. Adjust scale and angle until it sits on the node.`)
        return { ok: true, detail: state.detail }
    }

    function markNode() {
        settings.enabled = false
        phase = 'idle'
        const view = snapshot()
        const player = view.player
        if (!Number.isFinite(player.x)) return { ok: false, detail: 'Move once so the radar has your position.' }
        const node = calibrationNode(player, view.entities)
        if (!node) return { ok: false, detail: 'Need a resource about 8 to 40 m away. Walk until one is on the radar.' }
        state.targetId = node.id
        const away = distance(player, node)
        publish('marking', `${label(node)} is highlighted (${away.toFixed(0)} m). Press Capture, then move the cursor onto that node.`)
        return { ok: true, detail: state.detail }
    }

    function calibrate() {
        settings.enabled = false
        phase = 'idle'
        const view = snapshot()
        const player = view.player
        if (!Number.isFinite(player.x)) return { ok: false, detail: 'Move once so the radar has your position.' }
        const node = view.entities.find((entity) => entity.id === state.targetId && entity.kind === 'resource')
        if (!node) return { ok: false, detail: 'Press Mark node first, then hover that node.' }
        const win = Window.getByTitle('Albion Online Client')
        const rect = win && win.getDimensions()
        if (!rect) return { ok: false, detail: 'Albion window not found.' }
        const cursor = mouse()
        if (!cursor) return { ok: false, detail: 'Mouse control is not installed.' }
        const solved = solveView(player, node, cursor.getMousePos(), rect)
        if (!solved) return { ok: false, detail: 'The cursor was still on your character when the timer ended. Press Capture, then move onto the highlighted node before it reaches zero.' }
        settings.scale = Math.max(4, Math.min(80, solved.scale))
        settings.angle = solved.angle
        publish('calibrated', `Scale ${settings.scale}, angle ${settings.angle}. Press Aim to check the cursor lands on the node.`)
        return { ok: true, detail: state.detail, scale: settings.scale, angle: settings.angle }
    }

    function pressMount() {
        const cursor = mouse()
        if (!cursor) return
        const win = Window.getByTitle('Albion Online Client')
        if (win) win.focus()
        cursor.keyTap('a')
        lastClick = Date.now() + 700
    }

    function label(entity) {
        return `T${entity.tier || '?'} ${entity.name}`
    }

    function resetRoute() {
        anchor = null
        stuckClicks = 0
        surroundStep = 0
        surroundLaps = 0
        surroundStartDistance = 0
    }

    function beginSurround(player, node, now) {
        phase = 'surround'
        phaseSince = now
        surroundStep = 0
        surroundLaps = 0
        surroundStartDistance = distance(player, node)
        anchor = { x: player.x, y: player.y }
        stuckClicks = 0
    }

    function stuckSinceLastClick(player) {
        if (!anchor) {
            anchor = { x: player.x, y: player.y }
            return false
        }
        const moved = Math.hypot(player.x - anchor.x, player.y - anchor.y)
        anchor = { x: player.x, y: player.y }
        if (moved >= STUCK_MOVE) {
            stuckClicks = 0
            return false
        }
        stuckClicks += 1
        return stuckClicks >= STUCK_CLICKS
    }

    function tick() {
        if (busy || !settings.enabled) return
        busy = true
        try {
            step()
        } finally {
            busy = false
        }
    }

    function step() {
        const now = Date.now()
        const view = snapshot()
        const player = view.player
        if (!Number.isFinite(player.x) || !Number.isFinite(player.y)) {
            publish('waiting', 'Waiting for your position.')
            return
        }

        const target = view.entities.find((entity) => entity.id === state.targetId)
        const stillWanted = target
            && target.kind === 'resource'
            && settings.types[target.name]
            && (target.tier || 0) >= settings.minTier
            && (skipped.get(target.id) || 0) <= now

        if (!stillWanted) {
            if (phase === 'harvest' && settings.automount) pressMount()
            const next = pickTarget(player, view.entities, settings, skipped, now)
            state.targetId = next ? next.id : null
            phase = 'approach'
            phaseSince = now
            harvestSize = null
            resetRoute()
            if (!next) {
                publish('searching', 'No matching resource in range.')
                return
            }
        }

        const node = view.entities.find((entity) => entity.id === state.targetId)
        if (!node) return
        const away = distance(player, node)
        const win = Window.getByTitle('Albion Online Client')
        const rect = win && win.getDimensions()
        if (!rect) {
            publish('waiting', 'Albion window not found.')
            return
        }
        if (!mouse()) {
            publish('waiting', 'Mouse control is not installed. Run npm install in albionRadar.')
            return
        }

        if (away <= REACH) {
            if (phase !== 'harvest') {
                phase = 'harvest'
                phaseSince = now
                harvestSize = node.size
                const point = projectPoint(player, node, rect, settings.scale, settings.angle)
                const nearCenter = Math.hypot(point.x - point.cx, point.y - point.cy) < 220
                if (!nearCenter) {
                    publish('waiting', 'Close to the node, but the click point is off-center. Use Aim and fix scale or angle.')
                    return
                }
                if (!clickAt(point, rect)) return
                publish('harvesting', `Harvesting ${label(node)}.`)
                return
            }
            const depleted = node.size != null && harvestSize != null && node.size < harvestSize
            if (depleted) {
                skipped.set(node.id, now + 5000)
                if (settings.automount) pressMount()
                state.targetId = null
                phase = 'idle'
                const mounted = settings.automount ? ' Mounting.' : ''
                publish('searching', `Finished ${label(node)}.${mounted}`)
                return
            }
            if (now - phaseSince > HARVEST_GIVE_UP_MS) {
                skipped.set(node.id, now + SKIP_MS)
                state.targetId = null
                phase = 'idle'
                publish('searching', `Skipped ${label(node)} after it did not harvest.`)
            }
            return
        }

        if (phase !== 'approach' && phase !== 'surround') {
            phase = 'approach'
            phaseSince = now
            resetRoute()
        }
        if (now - lastClick < CLICK_MS) {
            publish(
                phase === 'surround' ? 'surrounding' : 'walking',
                phase === 'surround'
                    ? `Moving around ${label(node)} to get unstuck.`
                    : `Walking to ${label(node)}, ${away.toFixed(0)} m away.`,
            )
            return
        }

        if (phase === 'approach' && stuckSinceLastClick(player)) {
            beginSurround(player, node, now)
        }

        if (phase === 'surround') {
            if (surroundStep >= SURROUND_STEPS) {
                surroundStep = 0
                surroundLaps += 1
                const closer = distance(player, node) + 2 < surroundStartDistance
                if (closer) {
                    phase = 'approach'
                    phaseSince = now
                    stuckClicks = 0
                    anchor = { x: player.x, y: player.y }
                    publish('walking', `Clear of the block. Walking to ${label(node)}.`)
                } else if (surroundLaps >= SURROUND_LAPS) {
                    skipped.set(node.id, now + SKIP_MS)
                    state.targetId = null
                    phase = 'idle'
                    resetRoute()
                    publish('searching', `Could not reach ${label(node)} after moving around it.`)
                    return
                } else {
                    surroundStartDistance = distance(player, node)
                    publish('surrounding', `Still blocked. Circling ${label(node)} again.`)
                }
            }
            if (phase === 'surround') {
                const point = projectPoint(
                    player,
                    surroundPoint(player, node, surroundStep, SURROUND_RADIUS),
                    rect,
                    settings.scale,
                    settings.angle,
                )
                surroundStep += 1
                if (!clickAt(point, rect)) return
                publish('surrounding', `Moving around ${label(node)} to get unstuck.`)
                return
            }
        }

        const stepDistance = Math.min(away, WALK_STEP)
        const point = projectPoint(player, {
            x: player.x + ((node.x - player.x) / away) * stepDistance,
            y: player.y + ((node.y - player.y) / away) * stepDistance,
        }, rect, settings.scale, settings.angle)
        if (!clickAt(point, rect)) return
        publish('walking', `Walking to ${label(node)}, ${away.toFixed(0)} m away.`)
    }

    const timer = setInterval(tick, 200)
    if (typeof timer.unref === 'function') timer.unref()

    return { configure, aim, markNode, calibrate, publicState }
}

module.exports = {
    createGather,
    projectPoint,
    pickTarget,
    surroundPoint,
    solveView,
}
