const { Window } = require('./window')

const RESOURCE_TYPES = ['wood', 'rock', 'fiber', 'hide', 'ore']
const REACH = 4
const WALK_STEP = 28
const CLICK_MS = 250
const HARVEST_GIVE_UP_MS = 14000
const HARVEST_RETRY_MS = 900
const HARVEST_STALL_MS = 6500
const SKIP_MS = 45000
const STUCK_MOVE = 1.5
const PROBE = 2
const PROBE_MOVE = 0.8
const STUCK_MS = 2800
const SURROUND_RADIUS = 6
const SURROUND_STEPS = 8
const SURROUND_LAPS = 2
const MOB_PADDING = 9
const HARVEST_PULSE = 52
const HARVEST_END = 53

function viewFrom(scaleOrSettings, angleDeg) {
    if (scaleOrSettings && typeof scaleOrSettings === 'object') return scaleOrSettings
    return { scale: Number(scaleOrSettings) || 14, angle: Number(angleDeg) || 0, view: null }
}

function screenOffset(dx, dy, settings) {
    if (settings.view) {
        return {
            sx: dx * settings.view.xx + dy * settings.view.xy,
            sy: dx * settings.view.yx + dy * settings.view.yy,
        }
    }
    const angle = (settings.angle || 0) * Math.PI / 180
    const scale = settings.scale || 14
    return {
        sx: scale * (dx * Math.cos(angle) - dy * Math.sin(angle)),
        sy: scale * (dx * Math.sin(angle) + dy * Math.cos(angle)),
    }
}

function projectPoint(player, point, rect, scaleOrSettings, angleDeg) {
    const settings = viewFrom(scaleOrSettings, angleDeg)
    const dx = point.x - player.x
    const dy = point.y - player.y
    const { sx, sy } = screenOffset(dx, dy, settings)
    const cx = (rect.left + rect.right) / 2
    const cy = (rect.top + rect.bottom) / 2
    return {
        x: cx + sx,
        y: cy - sy,
        cx,
        cy,
    }
}

function solveAffine(first, second) {
    const det = first.dx * second.dy - first.dy * second.dx
    if (Math.abs(det) < 12) return null
    const xx = (first.sx * second.dy - first.dy * second.sx) / det
    const xy = (first.dx * second.sx - first.sx * second.dx) / det
    const yx = (first.sy * second.dy - first.dy * second.sy) / det
    const yy = (first.dx * second.sy - first.sy * second.dx) / det
    const xAxis = Math.hypot(xx, yx)
    const yAxis = Math.hypot(xy, yy)
    if (xAxis < 2 || xAxis > 90 || yAxis < 2 || yAxis > 90) return null
    return {
        xx: Math.round(xx * 1000) / 1000,
        xy: Math.round(xy * 1000) / 1000,
        yx: Math.round(yx * 1000) / 1000,
        yy: Math.round(yy * 1000) / 1000,
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

function mobsNearPath(ax, ay, bx, by, entities, padding) {
    return entities.some((entity) => entity.kind === 'mob'
        && pointSegmentDistance(entity.x, entity.y, ax, ay, bx, by) < padding)
}

function steerPoint(player, node, entities, step, avoid) {
    const away = Math.hypot(node.x - player.x, node.y - player.y)
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

function differentDirection(player, node, sample) {
    if (!sample) return true
    const dx = node.x - player.x
    const dy = node.y - player.y
    const len = Math.hypot(dx, dy) * Math.hypot(sample.dx, sample.dy)
    if (len < 1) return false
    return (dx * sample.dx + dy * sample.dy) / len < 0.55
}

function calibrationNode(player, entities, sample) {
    let best = null
    let bestDistance = Infinity
    for (const entity of entities) {
        if (entity.kind !== 'resource') continue
        if (sample && entity.id === sample.id) continue
        if (sample && !differentDirection(player, entity, sample)) continue
        const away = distance(player, entity)
        if (away < 8 || away > 45) continue
        if (away < bestDistance) {
            best = entity
            bestDistance = away
        }
    }
    return best
}

function mobOnNode(node, entities) {
    return entities.some((entity) => entity.kind === 'mob' && distance(node, entity) < 6)
}

function skipRow(skipped, id) {
    const row = skipped.get(id)
    if (!row) return null
    if (typeof row === 'object') return row
    return { until: row, why: 'skipped' }
}

function rejection(entity, entities, settings, skipped, now) {
    if (entity.kind !== 'resource') return 'not a resource'
    if (entity.name !== 'resource' && !settings.types[entity.name]) return 'type is off'
    if (entity.tier > 0 && entity.tier < settings.minTier) return `below tier ${settings.minTier}`
    const row = skipRow(skipped, entity.id)
    if (row && row.until > now) return row.why || 'skipped'
    if (settings.avoidMobs && mobOnNode(entity, entities)) return 'mob standing on it'
    return ''
}

function pickTarget(player, entities, settings, skipped, now) {
    let best = null
    let bestDistance = Infinity
    for (const entity of entities) {
        if (rejection(entity, entities, settings, skipped, now)) continue
        const away = distance(player, entity)
        if (away < bestDistance) {
            best = entity
            bestDistance = away
        }
    }
    return best
}

function nearbyNotes(player, entities, settings, skipped, now, chosenId) {
    return entities
        .filter((entity) => entity.kind === 'resource')
        .map((entity) => ({
            away: distance(player, entity),
            text: `${distance(player, entity).toFixed(0)} m  T${entity.tier || '?'} ${entity.name}`,
            why: rejection(entity, entities, settings, skipped, now),
            id: entity.id,
        }))
        .sort((a, b) => a.away - b.away)
        .slice(0, 5)
        .map((row) => row.text + (row.id === chosenId ? '  ← this one' : row.why ? `  — ${row.why}` : ''))
}

function createGather(snapshot, emit, terrain) {
    const settings = {
        enabled: false,
        types: { wood: true, rock: true, fiber: true, hide: true, ore: true },
        minTier: 1,
        scale: 14,
        angle: 0,
        automount: false,
        avoidMobs: true,
        survey: false,
        view: null,
    }
    const state = {
        status: 'off',
        targetId: null,
        detail: '',
        lines: [],
        motion: '',
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
    let anchorAt = 0
    let pendingSample = null
    let harvestSeenAt = 0
    let harvestEndedAt = 0
    let harvestClicks = 0
    let profile = null
    let surveyProbe = null
    let edge = null

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
            avoidMobs: settings.avoidMobs,
            survey: settings.survey,
            isometric: Boolean(settings.view),
            status: state.status,
            targetId: state.targetId,
            detail: state.detail,
            lines: state.lines,
            motion: state.motion,
            terrain: terrain ? terrain.counts(snapshot().player.map) : { blocked: 0, open: 0 },
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
        if (typeof next.avoidMobs === 'boolean') settings.avoidMobs = next.avoidMobs
        if (typeof next.survey === 'boolean') settings.survey = next.survey
        if (next.useManual) settings.view = null
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
        if (!clickAt.lastFocus || Date.now() - clickAt.lastFocus > 2000) {
            const win = Window.getByTitle('Albion Online Client')
            if (win) win.focus()
            clickAt.lastFocus = Date.now()
        }
        cursor.moveMouse(spot.x, spot.y)
        cursor.mouseClick('left')
        lastClick = Date.now()
        return true
    }

    function observe(kind, message) {
        const parameters = message?.parameters || {}
        const code = kind === 'request'
            ? Number(parameters[253] ?? message.operationCode)
            : Number(parameters[252] ?? message.code)
        const now = Date.now()
        if (kind === 'request' && code === HARVEST_PULSE) harvestSeenAt = now
        if (kind === 'request' && code === HARVEST_END) harvestEndedAt = now
        if (kind === 'event' && code === 59) harvestSeenAt = now
        if (kind === 'event' && (code === 60 || code === 61)) harvestEndedAt = now
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
        const point = projectPoint(player, target, rect, settings)
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
        const node = calibrationNode(player, view.entities, pendingSample)
        if (!node) {
            const why = pendingSample
                ? 'Need a second resource off to the side, about 8 to 45 m away.'
                : 'Need a resource about 8 to 45 m away. Walk until one is on the radar.'
            return { ok: false, detail: why }
        }
        state.targetId = node.id
        const away = distance(player, node)
        const step = pendingSample ? 'second node, off to the side' : 'first node'
        publish('marking', `${label(node)} is the ${step} (${away.toFixed(0)} m). Press Capture, then move the cursor onto it.`)
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
        const cursorPos = cursor.getMousePos()
        const dx = node.x - player.x
        const dy = node.y - player.y
        const world = Math.hypot(dx, dy)
        const cx = (rect.left + rect.right) / 2
        const cy = (rect.top + rect.bottom) / 2
        const sx = cursorPos.x - cx
        const sy = cy - cursorPos.y
        if (world < 6 || Math.hypot(sx, sy) < 12) {
            return { ok: false, detail: 'The cursor was still on your character when the timer ended. Press Capture, then move onto the highlighted node before it reaches zero.' }
        }
        const sample = { id: node.id, dx, dy, sx, sy }
        if (!pendingSample) {
            pendingSample = sample
            const rough = solveView(player, node, cursorPos, rect)
            if (rough) {
                settings.scale = Math.max(4, Math.min(80, rough.scale))
                settings.angle = rough.angle
            }
            publish('calibrated', 'First node saved. Mark a second node in a different direction, then capture it. One angle cannot fit the isometric view.')
            return { ok: true, detail: state.detail, scale: settings.scale, angle: settings.angle }
        }
        const fitted = solveAffine(pendingSample, sample)
        pendingSample = null
        if (!fitted) {
            return { ok: false, detail: 'Those two nodes point almost the same way. Mark one off to the side and capture again.' }
        }
        settings.view = fitted
        publish('calibrated', 'Isometric view set from the two nodes. Press Aim to check the cursor.')
        return { ok: true, detail: state.detail, scale: settings.scale, angle: settings.angle, isometric: true }
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
        anchorAt = 0
        stuckClicks = 0
        surroundStep = 0
        surroundLaps = 0
        surroundStartDistance = 0
        harvestClicks = 0
    }

    function harvestStarted(since) {
        return harvestSeenAt >= since
    }

    function harvestFinished(since) {
        return harvestEndedAt >= since && (harvestSeenAt < since || harvestEndedAt >= harvestSeenAt)
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

    function stuckTooLong(player, now) {
        if (!anchor) {
            anchor = { x: player.x, y: player.y }
            anchorAt = now
            return false
        }
        const moved = Math.hypot(player.x - anchor.x, player.y - anchor.y)
        if (moved >= STUCK_MOVE) {
            if (terrain) terrain.markSegment(player.map, anchor.x, anchor.y, player.x, player.y)
            state.motion = `Last move ${moved.toFixed(1)} m`
            anchor = { x: player.x, y: player.y }
            anchorAt = now
            return false
        }
        return now - anchorAt >= STUCK_MS
    }

    function stepToward(player, angle, distance) {
        return {
            x: player.x + Math.cos(angle) * distance,
            y: player.y + Math.sin(angle) * distance,
        }
    }

    function beginEdge(player, heading, face) {
        phase = 'profile'
        const left = heading + Math.PI / 2
        edge = {
            heading,
            face,
            attempt: 'left',
            steps: 0,
            origin: { x: player.x, y: player.y },
            from: { x: player.x, y: player.y },
            dest: stepToward(player, left, PROBE),
            at: 0,
        }
        anchor = { x: player.x, y: player.y }
        anchorAt = Date.now()
    }

    function edgeStep(player, rect, now, labelText) {
        if (edge.at && now - edge.at < 600) {
            noteLines(player, snapshot().entities, null)
            publish('profiling', `Trying around the obstacle (${edge.attempt}). ${labelText}`)
            return
        }
        if (edge.at) {
            const moved = Math.hypot(player.x - edge.from.x, player.y - edge.from.y)
            if (moved >= PROBE_MOVE) {
                if (terrain) terrain.markSegment(player.map, edge.from.x, edge.from.y, player.x, player.y)
                state.motion = `Moved ${moved.toFixed(1)} m around it.`
                if (edge.attempt === 'left') edge.heading += Math.PI / 2
                if (edge.attempt === 'right') edge.heading -= Math.PI / 2
                edge.attempt = 'along'
            } else if (edge.attempt === 'left') {
                edge.attempt = 'right'
                state.motion = 'Left side did not move. Trying the right.'
            } else if (edge.attempt === 'right') {
                if (terrain) terrain.mark(player.map, edge.face.x, edge.face.y, 'blocked')
                edge.attempt = 'along'
                edge.heading += Math.PI / 2
                state.motion = 'Both sides failed. Marked that 2 m cell blocked.'
            } else {
                if (terrain) terrain.mark(player.map, edge.dest.x, edge.dest.y, 'blocked')
                edge.heading += Math.PI / 6
                state.motion = 'Edge step did not move. Following the outline.'
            }
            edge.steps += 1
        }
        const back = Math.hypot(player.x - edge.origin.x, player.y - edge.origin.y)
        if (edge.steps > 18 || (edge.steps > 8 && back < PROBE)) {
            edge = null
            phase = 'approach'
            anchor = { x: player.x, y: player.y }
            anchorAt = now
            noteLines(player, snapshot().entities, null)
            publish('walking', `Finished tracing the obstacle. ${state.motion}`)
            return
        }
        const angle = edge.attempt === 'left'
            ? edge.heading + Math.PI / 2
            : edge.attempt === 'right'
                ? edge.heading - Math.PI / 2
                : edge.heading
        edge.dest = stepToward(player, angle, PROBE)
        edge.from = { x: player.x, y: player.y }
        edge.at = now
        const point = projectPoint(player, edge.dest, rect, settings)
        if (!clickAt(point, rect)) return
        noteLines(player, snapshot().entities, null)
        publish('profiling', `2 m ${edge.attempt} step along the obstacle. ${state.motion}`)
    }

    function surveyStep(player, rect, now) {
        if (edge) {
            edgeStep(player, rect, now, 'Mapping.')
            return
        }
        if (surveyProbe && now - surveyProbe.at < 600) {
            noteLines(player, snapshot().entities, null)
            publish('survey', `Checking a 2 m step. Waiting for the move packet.`)
            return
        }
        if (surveyProbe) {
            const moved = Math.hypot(player.x - surveyProbe.x, player.y - surveyProbe.y)
            if (moved >= PROBE_MOVE) {
                terrain.markSegment(player.map, surveyProbe.x, surveyProbe.y, player.x, player.y)
                state.motion = `Moved ${moved.toFixed(1)} m. That 2 m cell is open.`
                surveyProbe = null
            } else {
                state.motion = 'Forward step did not move. Trying around it before marking anything.'
                const face = { x: surveyProbe.destX, y: surveyProbe.destY }
                beginEdge(player, surveyProbe.heading, face)
                surveyProbe = null
                noteLines(player, snapshot().entities, null)
                publish('profiling', state.motion)
                return
            }
        }
        const goal = terrain.nearestUnknown(player.map, player.x, player.y, 24)
            || terrain.nearestUnknown(player.map, player.x, player.y, 50)
        noteLines(player, snapshot().entities, null)
        if (!goal) {
            publish('survey', 'Ground around you is mapped. Walk to a new area, or stop mapping.')
            return
        }
        const away = Math.hypot(goal.x - player.x, goal.y - player.y)
        const heading = Math.atan2(goal.y - player.y, goal.x - player.x)
        const dest = stepToward(player, heading, Math.min(PROBE, away))
        surveyProbe = { x: player.x, y: player.y, destX: dest.x, destY: dest.y, heading, at: now }
        const point = projectPoint(player, dest, rect, settings)
        if (!clickAt(point, rect)) return
        publish('survey', `2 m probe toward unmapped ground, ${away.toFixed(0)} m away. ${state.motion}`)
    }

    function skipFor(id, ms, why) {
        skipped.set(id, { until: Date.now() + ms, why })
    }

    function noteLines(player, entities, chosen) {
        const counts = terrain ? terrain.counts(player.map) : { blocked: 0, open: 0 }
        state.lines = [
            `You ${player.x.toFixed(1)}, ${player.y.toFixed(1)}${player.map ? `  ${player.map}` : ''}`,
            state.motion,
            `Mapped ground: ${counts.open} open, ${counts.blocked} blocked`,
            ...nearbyNotes(player, entities, settings, skipped, Date.now(), chosen && chosen.id),
        ].filter(Boolean)
    }

    function reprofile(x, y) {
        const map = snapshot().player.map
        if (terrain) terrain.mark(map, x, y, 'unknown')
        settings.survey = true
        settings.enabled = true
        surveyProbe = null
        publish('survey', `Re-profiling ground near ${Number(x).toFixed(0)}, ${Number(y).toFixed(0)}.`)
        return publicState()
    }

    function allowGround(x, y) {
        const map = snapshot().player.map
        if (terrain) terrain.mark(map, x, y, 'open')
        publish('survey', `Marked ${Number(x).toFixed(0)}, ${Number(y).toFixed(0)} as open ground.`)
        return publicState()
    }

    function tick() {
        if (busy || (!settings.enabled && !settings.survey)) return
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

        const nearest = pickTarget(player, view.entities, settings, skipped, now)
        if (phase !== 'harvest' && nearest && nearest.id !== state.targetId) {
            const current = view.entities.find((entity) => entity.id === state.targetId)
            const currentAway = current ? distance(player, current) : Infinity
            if (!current || distance(player, nearest) + 2 < currentAway) {
                state.targetId = nearest.id
                if (phase === 'profile') phase = 'approach'
            }
        }

        const target = view.entities.find((entity) => entity.id === state.targetId)
        const stillWanted = target && !rejection(target, view.entities, settings, skipped, now)

        if (!stillWanted) {
            if (phase === 'harvest' && settings.automount) pressMount()
            const next = pickTarget(player, view.entities, settings, skipped, now)
            state.targetId = next ? next.id : null
            phase = 'approach'
            phaseSince = now
            harvestSize = null
            resetRoute()
            if (!next && !(settings.survey && terrain)) {
                noteLines(player, view.entities, null)
                publish('searching', 'No matching resource in range.')
                return
            }
        }

        const node = view.entities.find((entity) => entity.id === state.targetId)
        if (!node && !(settings.survey && terrain)) return
        const away = node ? distance(player, node) : Infinity
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

        if (settings.survey && terrain) {
            surveyStep(player, rect, now)
            return
        }

        if (away <= REACH) {
            if (phase !== 'harvest') {
                phase = 'harvest'
                phaseSince = now
                harvestSize = node.size
                harvestClicks = 0
            }
            const depleted = node.size != null && harvestSize != null && node.size < harvestSize
            if (depleted || harvestFinished(phaseSince)) {
                skipFor(node.id, 5000, 'just harvested')
                if (settings.automount) pressMount()
                state.targetId = null
                phase = 'idle'
                const mounted = settings.automount ? ' Mounting.' : ''
                publish('searching', `Finished ${label(node)}.${mounted}`)
                return
            }
            const started = harvestStarted(phaseSince)
            const stalled = started && now - harvestSeenAt > HARVEST_STALL_MS
            const missed = !started && now - lastClick >= HARVEST_RETRY_MS
            if ((missed || stalled || harvestClicks === 0) && (harvestClicks === 0 || now - lastClick >= HARVEST_RETRY_MS)) {
                if (harvestClicks > 6 || (harvestClicks > 0 && now - phaseSince > HARVEST_GIVE_UP_MS)) {
                    skipFor(node.id, SKIP_MS, 'harvest did not start')
                    state.targetId = null
                    phase = 'idle'
                    noteLines(player, view.entities, null)
                    publish('searching', `Skipped ${label(node)}. The harvest never registered.`)
                    return
                }
                const point = projectPoint(player, node, rect, settings)
                const nearCenter = Math.hypot(point.x - point.cx, point.y - point.cy) < 280
                if (!nearCenter) {
                    publish('waiting', 'Close to the node, but the click point is off-center. Capture two nodes in different directions.')
                    return
                }
                harvestClicks += 1
                if (!clickAt(point, rect)) return
                publish('harvesting', harvestClicks === 1
                    ? `Harvesting ${label(node)}.`
                    : `Click did not start the harvest on ${label(node)}. Trying again.`)
                return
            }
            publish('harvesting', started
                ? `Harvesting ${label(node)}.`
                : `Waiting for the harvest on ${label(node)} to register.`)
            return
        }

        if (phase !== 'approach' && phase !== 'profile') {
            phase = 'approach'
            phaseSince = now
            resetRoute()
        }
        if (phase === 'profile' && edge) {
            edgeStep(player, rect, now, label(node))
            return
        }
        if (now - lastClick < CLICK_MS) {
            noteLines(player, view.entities, node)
            publish('walking', `Walking to ${label(node)}, ${away.toFixed(0)} m away.`)
            return
        }

        if (stuckTooLong(player, now)) {
            const heading = Math.atan2(node.y - player.y, node.x - player.x)
            beginEdge(player, heading, stepToward(player, heading, PROBE))
            noteLines(player, view.entities, node)
            publish('profiling', `Not moving forward. Checking left and right before marking ${label(node)}'s path blocked.`)
            return
        }

        const routed = terrain && terrain.route(player.map, player, node)
        let step = routed && routed.length > 1 ? terrain.pointAlong(routed, Math.min(away, 18)) : null
        if (!step) step = steerPoint(player, node, view.entities, WALK_STEP, settings.avoidMobs)
        if (!step) {
            skipFor(node.id, 8000, 'mob blocking the path')
            state.targetId = null
            phase = 'approach'
            noteLines(player, view.entities, null)
            publish('walking', `Mob blocking ${label(node)} at ${away.toFixed(0)} m. Choosing another node.`)
            return
        }
        const point = projectPoint(player, step, rect, settings)
        if (!clickAt(point, rect)) return
        const bend = Math.abs(Math.atan2(step.y - player.y, step.x - player.x) - Math.atan2(node.y - player.y, node.x - player.x))
        noteLines(player, view.entities, node)
        publish('walking', bend > 0.35
            ? `Stepping around a mob toward ${label(node)}, ${away.toFixed(0)} m away.`
            : `Walking to ${label(node)}, ${away.toFixed(0)} m away.`)
    }

    const timer = setInterval(tick, 120)
    if (typeof timer.unref === 'function') timer.unref()

    return { configure, aim, markNode, calibrate, observe, reprofile, allowGround, publicState }
}

module.exports = {
    createGather,
    projectPoint,
    pickTarget,
    surroundPoint,
    solveView,
    solveAffine,
    steerPoint,
}
