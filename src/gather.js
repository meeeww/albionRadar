const { Window } = require('./window')
const {
    RESOURCE_TYPES,
    clampScale,
    wrapAngle,
    distance,
    projectPoint,
    harvestLift,
    liftAim,
    solveAffine,
    solveView,
    steerPoint,
    measuredZone,
    stepHitsMob,
    calibrationNode,
    pickTarget,
    nearbyNotes,
    label,
    clampToWindow,
    screenSample,
    LocalNavigator,
    StuckDetector,
    PlayerTracker,
    clearanceFor,
} = require('./gather-math')

const REACH = 4
const CLICK_MS = 250
const WALK_RECLICK_MS = 600
const HARVEST_HOLD_MS = 4000
const WALK_STEP = 12
const PROBE = [-1.05, -0.55, 0, 0.55, 1.05]
const HARVEST_RETRY_MS = 900
const HARVEST_STALL_MS = 6500
const SKIP_MS = 45000
const HARVEST_PULSE = 52
const HARVEST_END = 53
const CAST_HIT = 21
const LIFT_TRIES = 4

function createGather(snapshot, emit, terrain, harvests) {
    const settings = {
        enabled: false,
        types: { wood: true, rock: true, fiber: true, hide: true, ore: true },
        minTier: 1,
        maxTier: 8,
        scale: 14,
        angle: 0,
        automount: false,
        avoidMobs: true,
        survey: false,
        view: null,
    }
    const state = { status: 'off', targetId: null, detail: '', lines: [], motion: '' }
    const skipped = new Map()
    let phase = 'idle'
    let phaseSince = 0
    let lastClick = 0
    let harvestSize = null
    let busy = false
    const pendingSamples = []
    const tracker = new PlayerTracker()
    const stuck = new StuckDetector()
    const navigator = new LocalNavigator(terrain)
    let harvestSeenAt = 0
    let harvestEndedAt = 0
    let harvestClicks = 0
    let activeHarvestId = null
    let liftIndex = 0
    let noted = false
    let usingSaved = false
    let playerId = null
    let fleeStage = null
    let fleeUntil = 0
    let threatId = null
    let mounted = null
    let aimOrder = null
    let lastOrder = null
    let loadedMap = ''
    let sidestepped = false
    let sidestepFrom = null
    let survey = null
    let clickFrom = null

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
            maxTier: settings.maxTier,
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
            terrain: terrain ? terrain.summary(snapshot().player.map) : { zones: 0 },
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
        const maxTier = Number(next.maxTier)
        if (Number.isFinite(maxTier)) settings.maxTier = Math.max(settings.minTier, Math.min(8, Math.round(maxTier)))
        const scale = Number(next.scale)
        if (Number.isFinite(scale)) settings.scale = clampScale(scale)
        const angle = Number(next.angle)
        if (Number.isFinite(angle)) settings.angle = wrapAngle(Math.max(-180, Math.min(180, angle)))
        if (typeof next.automount === 'boolean') settings.automount = next.automount
        if (typeof next.avoidMobs === 'boolean') settings.avoidMobs = next.avoidMobs
        if (typeof next.survey === 'boolean') settings.survey = next.survey
        if (next.useManual) settings.view = null
        if (!settings.enabled) {
            phase = 'idle'
            harvestClicks = 0
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

    function game() {
        const win = Window.getByTitle('Albion Online Client')
        return { win, rect: win && win.getDimensions(), cursor: mouse() }
    }

    function focus(win) {
        if (!clickAt.lastFocus || Date.now() - clickAt.lastFocus > 2000) {
            if (win) win.focus()
            clickAt.lastFocus = Date.now()
        }
    }

    function clickAt(point, rect) {
        const { win, cursor } = game()
        if (!cursor) return false
        const spot = clampToWindow(point, rect)
        focus(win)
        cursor.moveMouse(spot.x, spot.y)
        cursor.mouseClick('left')
        lastClick = Date.now()
        return true
    }

    function tapKey(delay) {
        const { win, cursor } = game()
        if (!cursor) return false
        if (win) win.focus()
        cursor.keyTap('a')
        if (delay) lastClick = Date.now() + delay
        return true
    }

    function codeOf(kind, message) {
        const parameters = message?.parameters || {}
        return kind === 'request'
            ? Number(parameters[253] ?? message.operationCode)
            : Number(parameters[252] ?? message.code)
    }

    function observe(kind, message) {
        const parameters = message?.parameters || {}
        const code = codeOf(kind, message)
        const now = Date.now()
        if (kind === 'request' && code === HARVEST_PULSE) {
            harvestSeenAt = now
            if (parameters[1] != null) activeHarvestId = String(parameters[1])
        }
        if (kind === 'request' && code === HARVEST_END) harvestEndedAt = now
        if (kind === 'event' && code === 59) {
            harvestSeenAt = now
            if (parameters[3] != null) activeHarvestId = String(parameters[3])
        }
        if (kind === 'event' && code === 46 && parameters[0] != null) {
            const id = String(parameters[0])
            const size = Number(parameters[1])
            if (id === activeHarvestId) {
                if (Number.isFinite(size) && size > 0) harvestSeenAt = now
                else activeHarvestId = null
            }
        }
        if (kind === 'event' && (code === 60 || code === 61)) harvestEndedAt = now
        if (kind === 'request' && (code === 22 || code === 21) && parameters[0] != null) {
            playerId = String(parameters[0])
            const src = pair(parameters[1])
            const dest = pair(parameters[3])
            if (src && dest) noteMove(src, dest)
            learnClick(parameters)
        }
        if (kind === 'event' && (code === 211 || code === 212)) mounted = true
        if (kind === 'event' && code === 213) mounted = false
        if (kind === 'event' && code === 6 && playerId && String(parameters[0]) === playerId) {
            const delta = Number(parameters[2])
            if (Number.isFinite(delta) && delta < 0) noteDamage(parameters[6])
        }
        if (kind === 'event' && code === CAST_HIT) {
            if (!playerId) return
            const caster = parameters[0] == null ? null : String(parameters[0])
            if (caster === playerId) return
            noteDamage(parameters[0])
        }
    }

    function pair(value) {
        if (!Array.isArray(value) || value.length < 2) return null
        const x = Number(value[0])
        const y = Number(value[1])
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null
        return { x, y }
    }

    function noteMove(src, dest) {
        if (!survey || !survey.waiting || !survey.order || !survey.from) return
        survey.pos = src
        const moved = distance(survey.from, src)
        const wanted = distance(survey.from, survey.order)
        if (moved >= Math.max(2, wanted * 0.6) || distance(src, survey.order) < 3) survey.ready = 'open'
        else if (distance(src, dest) < 2 && Date.now() - survey.sent > 500 && moved < 2) survey.ready = 'blocked'
    }

    function learnClick(parameters) {
        const dest = pair(parameters[3])
        const src = pair(parameters[1])
        if (!aimOrder || !dest || !src || Date.now() - aimOrder.at > 1500) return
        if (distance(src, dest) < 3) {
            aimOrder = null
            return
        }
        pendingSamples.push({
            id: 'move',
            timestamp: Date.now(),
            player: src,
            world: dest,
            screen: aimOrder.screen,
        })
        if (pendingSamples.length > 20) pendingSamples.shift()
        aimOrder = null
        if (pendingSamples.length >= 3) applyFit()
    }

    function applyFit() {
        const fitted = solveAffine(pendingSamples)
        if (!fitted) return
        if (fitted.rmse > 12) {
            dropFit('Aim error is too high. Capture nodes again.')
            return
        }
        settings.view = fitted
        if (terrain) terrain.setView(snapshot().player.map, fitted)
    }

    function dropFit(detail) {
        settings.view = null
        pendingSamples.length = 0
        if (terrain) terrain.clearView(snapshot().player.map)
        publish('tuned', detail)
    }

    function syncMap(map) {
        if (!map || map === loadedMap) return
        loadedMap = map
        pendingSamples.length = 0
        survey = null
        const saved = terrain && terrain.getView(map)
        settings.view = saved || null
    }

    function rememberClick(worldPoint, rect) {
        const projected = projectPoint(snapshot().player, worldPoint, rect, settings)
        aimOrder = {
            at: Date.now(),
            screen: { x: projected.x - projected.cx, y: projected.cy - projected.y },
        }
        lastOrder = worldPoint
        const here = snapshot().player
        clickFrom = { x: here.x, y: here.y }
    }

    function standingStill(player) {
        return Boolean(clickFrom) && distance(player, clickFrom) < 1.5
    }

    function ensureMounted(want) {
        if (mounted === want) return false
        tapKey(want ? 700 : 0)
        if (mounted !== null) mounted = want
        return true
    }

    function noteDamage(attackerId) {
        if (fleeStage) return
        threatId = attackerId == null ? null : String(attackerId)
        aimOrder = null
        fleeStage = 'run'
        fleeUntil = Date.now() + 5000
        publish('fleeing', 'A mob landed a hit. Running for 5 seconds, then remounting to drop focus.')
    }

    function nearestMob(player, entities) {
        let threat = threatId && entities.find((entity) => String(entity.id) === threatId)
        if (threat) return threat
        let best = Infinity
        for (const entity of entities) {
            if (entity.kind !== 'mob' || entity.passive) continue
            const away = distance(player, entity)
            if (away < best) {
                best = away
                threat = entity
            }
        }
        return threat
    }

    function fleeStep(player, entities, rect, now) {
        if (fleeStage === 'run' && now < fleeUntil) {
            const threat = nearestMob(player, entities)
            const angle = threat ? Math.atan2(player.y - threat.y, player.x - threat.x) : 0
            if (now - lastClick >= 400) {
                clickAt(projectPoint(player, {
                    x: player.x + Math.cos(angle) * 22,
                    y: player.y + Math.sin(angle) * 22,
                }, rect, settings), rect)
            }
            publish('fleeing', `Running from the mob. Remount in ${Math.max(0, (fleeUntil - now) / 1000).toFixed(0)} s.`)
            return true
        }
        if (fleeStage === 'run') {
            if (mounted !== false) {
                tapKey()
                if (mounted !== null) mounted = false
            }
            fleeStage = 'remount'
            fleeUntil = now + 450
            publish('fleeing', 'Unmounting, then mounting again to drop focus.')
            return true
        }
        if (fleeStage === 'remount') {
            if (now < fleeUntil) return true
            if (mounted !== true) tapKey()
            mounted = true
            fleeStage = null
            threatId = null
            publish('walking', 'Mounted again. Continuing.')
            return true
        }
        return false
    }

    function needPlace() {
        const view = snapshot()
        const player = view.player
        if (!Number.isFinite(player.x)) return { error: 'Move once so the radar has your position.' }
        const { rect, cursor } = game()
        if (!rect) return { error: 'Albion window not found.' }
        if (!cursor) return { error: 'Mouse control is not installed.' }
        return { view, player, rect, cursor }
    }

    function aim() {
        const place = needPlace()
        if (place.error) return { ok: false, detail: place.error }
        const { view, player, rect, cursor } = place
        const target = pickTarget(player, view.entities, settings, skipped, Date.now())
        if (!target) return { ok: false, detail: 'No matching resource in range.' }
        const spot = clampToWindow(projectPoint(player, target, rect, settings), rect)
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
        const node = calibrationNode(player, view.entities, pendingSamples)
        if (!node) {
            return {
                ok: false,
                detail: pendingSamples.length
                    ? 'Need another resource off to the side, about 8 to 45 m away.'
                    : 'Need a resource about 8 to 45 m away. Walk until one is on the radar.',
            }
        }
        state.targetId = node.id
        const step = pendingSamples.length ? 'next node, off to the side' : 'first node'
        publish('marking', `${label(node)} is the ${step} (${distance(player, node).toFixed(0)} m). Press Capture, then move the cursor onto it.`)
        return { ok: true, detail: state.detail }
    }

    function calibrate() {
        settings.enabled = false
        phase = 'idle'
        const place = needPlace()
        if (place.error) return { ok: false, detail: place.error }
        const { view, player, rect, cursor } = place
        const node = view.entities.find((entity) => entity.id === state.targetId && entity.kind === 'resource')
        if (!node) return { ok: false, detail: 'Press Mark node first, then hover that node.' }
        const sample = screenSample(player, node, cursor.getMousePos(), rect)
        const span = Math.hypot(sample.world.x - sample.player.x, sample.world.y - sample.player.y)
        if (span < 6 || Math.hypot(sample.screen.x, sample.screen.y) < 12) {
            return { ok: false, detail: 'The cursor was still on your character when the timer ended. Press Capture, then move onto the highlighted node before it reaches zero.' }
        }
        pendingSamples.push(sample)
        if (pendingSamples.length > 20) pendingSamples.shift()
        const rough = solveView(pendingSamples)
        if (rough) {
            settings.scale = clampScale(rough.scale)
            settings.angle = rough.angle
        }
        if (pendingSamples.length < 3) {
            publish('calibrated', `Saved ${pendingSamples.length} of 3. Capture nodes in different directions so the fit can absorb a bad cursor.`)
            return { ok: true, detail: state.detail, scale: settings.scale, angle: settings.angle }
        }
        const fitted = solveAffine(pendingSamples)
        if (!fitted) {
            return { ok: false, detail: 'Those nodes point almost the same way. Mark one off to the side and capture again.' }
        }
        settings.view = fitted
        if (terrain) terrain.setView(player.map, fitted)
        if (fitted.rmse > 8 && pendingSamples.length < 8) {
            publish('calibrated', `Fit error ${fitted.rmse} px. Capture another node in a different direction.`)
            return { ok: true, detail: state.detail, scale: settings.scale, angle: settings.angle, rmse: fitted.rmse }
        }
        publish('calibrated', `View fit from ${fitted.samples} nodes, error ${fitted.rmse} px. Press Aim to check the cursor.`)
        return { ok: true, detail: state.detail, scale: settings.scale, angle: settings.angle, isometric: true, rmse: fitted.rmse }
    }

    function harvestStarted(since) {
        return harvestSeenAt >= since
    }

    function harvestFinished(since) {
        return harvestEndedAt >= since && (harvestSeenAt < since || harvestEndedAt >= harvestSeenAt)
    }

    function skipFor(id, ms, why) {
        skipped.set(id, { until: Date.now() + ms, why })
    }

    function blockedAt(player) {
        if (!terrain || !player) return null
        return (x, y) => terrain.blocked(player.map, x, y)
    }

    function choose(player, entities, now) {
        return pickTarget(player, entities, settings, skipped, now, blockedAt(player))
    }

    function noteLines(player, entities, chosen) {
        const zones = terrain ? terrain.summary(player.map).zones : 0
        state.lines = [
            `You ${player.x.toFixed(1)}, ${player.y.toFixed(1)}${player.map ? `  ${player.map}` : ''}`,
            state.motion,
            zones ? `${zones} dead zone${zones === 1 ? '' : 's'} on this map` : 'No dead zones. All ground is open.',
            ...nearbyNotes(player, entities, settings, skipped, Date.now(), chosen && chosen.id, blockedAt(player)),
        ].filter(Boolean)
    }

    function leaveNode(id, ms, why, detail, status = 'walking') {
        skipFor(id, ms, why)
        state.targetId = null
        phase = 'approach'
        const view = snapshot()
        noteLines(view.player, view.entities, null)
        publish(status, detail)
    }

    function surveyStep(player, rect, now) {
        if (survey.waiting) {
            const aged = now - survey.sent >= 1400
            if (!survey.ready && !aged) {
                publish('walking', `Measuring the dead zone, step ${survey.index} of ${survey.orders.length}.`)
                return
            }
            const pos = survey.pos || { x: player.x, y: player.y }
            const moved = distance(survey.from, pos)
            const wanted = distance(survey.from, survey.order)
            if (survey.ready !== 'open' && moved < Math.max(2, wanted * 0.6)) {
                survey.blocked.push({ x: pos.x, y: pos.y })
            }
            survey.waiting = false
            survey.ready = null
        }
        if (survey.index >= survey.orders.length) {
            const shape = measuredZone(survey.origin, survey.blocked)
            const nodeId = survey.nodeId
            survey = null
            if (shape && terrain) terrain.addZone(player.map, shape)
            leaveNode(nodeId, 8000, 'dead zone', shape
                ? 'Measured the dead zone where walking stopped. Going around it.'
                : 'Those steps were not a wall. Going around the node.')
            return
        }
        const order = survey.orders[survey.index]
        survey.index += 1
        survey.from = { x: player.x, y: player.y }
        survey.order = order
        survey.pos = null
        survey.ready = null
        survey.sent = now
        survey.waiting = true
        const from = tracker.predict(0.25) || player
        if (!clickAt(projectPoint(from, order, rect, settings), rect)) {
            survey.waiting = false
            return
        }
        rememberClick(order, rect)
        publish('walking', `Measuring the dead zone, step ${survey.index} of ${survey.orders.length}.`)
    }

    function mapName() {
        return snapshot().player.map || 'unknown'
    }

    function zone(method, ...args) {
        if (!terrain) return { ok: false }
        return terrain[method](mapName(), ...args)
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
        syncMap(player.map)
        tracker.update(player, now)
        if (survey) {
            const place = game()
            if (!place.rect || !place.cursor) {
                publish('waiting', place.rect ? 'Mouse control is not installed. Run npm install in albionRadar.' : 'Albion window not found.')
                return
            }
            if (fleeStep(player, view.entities, place.rect, now)) return
            surveyStep(player, place.rect, now)
            return
        }

        const nearest = choose(player, view.entities, now)
        if (!survey && phase !== 'harvest' && nearest && nearest.id !== state.targetId) {
            const current = view.entities.find((entity) => entity.id === state.targetId)
            const currentAway = current ? distance(player, current) : Infinity
            if (!(current && currentAway <= 8) && (!current || distance(player, nearest) < currentAway)) {
                state.targetId = nearest.id
                sidestepped = false
                sidestepFrom = null
                liftIndex = 0
                noted = false
                lastOrder = null
                clickFrom = null
            }
        }

        const target = view.entities.find((entity) => entity.id === state.targetId)
        const wanted = target && pickTarget(player, [target], settings, skipped, now, blockedAt(player))
        if (!wanted) {
            const nodeGone = phase === 'harvest'
            if (nodeGone && settings.automount) ensureMounted(true)
            const next = choose(player, view.entities, now)
            state.targetId = next ? next.id : null
            phase = 'approach'
            phaseSince = now
            harvestSize = null
            harvestClicks = 0
            activeHarvestId = null
            if (nodeGone) {
                const mounted = settings.automount ? ' Mounting.' : ''
                publish('searching', `Node is gone from the map.${mounted} Moving to the next one.`)
            }
            if (!next) {
                noteLines(player, view.entities, null)
                publish('searching', 'No matching resource in range.')
                return
            }
        }

        const node = view.entities.find((entity) => entity.id === state.targetId)
        if (!node && !fleeStage && !survey) return
        const away = node ? distance(player, node) : Infinity
        const { rect, cursor } = game()
        if (!rect) {
            publish('waiting', 'Albion window not found.')
            return
        }
        if (!cursor) {
            publish('waiting', 'Mouse control is not installed. Run npm install in albionRadar.')
            return
        }

        if (fleeStep(player, view.entities, rect, now)) return
        if (!node) return

        const channel = Boolean(node && activeHarvestId && String(node.id) === activeHarvestId)
        const atNode = away <= REACH || (phase === 'harvest' && away <= 8) || (channel && away <= 10)
        if (atNode) {
            if (phase !== 'harvest') {
                phase = 'harvest'
                phaseSince = now
                harvestSize = node.size
                harvestClicks = 0
                noted = false
                const known = harvests && harvests.find(player.map, node)
                if (known) {
                    settings.scale = clampScale(known.scale)
                    settings.angle = wrapAngle(known.angle)
                    liftIndex = known.lift || 0
                    usingSaved = true
                } else usingSaved = false
            }
            const chargeTaken = (node.size != null && harvestSize != null && node.size < harvestSize)
                || (harvestClicks > 0 && harvestFinished(phaseSince))
            if (chargeTaken) {
                harvestSize = node.size
                phaseSince = now + 1
                harvestClicks = 0
                publish('harvesting', `Charge taken from ${label(node)}. The node is still here, harvesting again.`)
            }
            const started = harvestStarted(phaseSince)
            if (started && !noted && harvestSeenAt >= lastClick && harvestSeenAt - lastClick < 3000) {
                noted = true
                if (harvests) {
                    const here = clickFrom || player
                    harvests.remember(player.map, node, {
                        scale: settings.scale,
                        angle: settings.angle,
                        lift: liftIndex,
                        px: here.x,
                        py: here.y,
                    })
                }
            }
            const stalled = started && now - harvestSeenAt > HARVEST_STALL_MS
            const missed = !started && now - lastClick >= HARVEST_RETRY_MS
            const recentNodeClick = lastOrder && distance(lastOrder, node) < 3 && now - lastClick < HARVEST_HOLD_MS
            if (!chargeTaken && standingStill(player) && recentNodeClick) {
                if (harvestClicks === 0) harvestClicks = 1
                publish('harvesting', `Standing still at ${label(node)}. Not clicking that spot again yet.`)
                return
            }
            if ((missed || stalled || harvestClicks === 0) && (harvestClicks === 0 || now - lastClick >= HARVEST_RETRY_MS)) {
                if (harvestClicks >= LIFT_TRIES) {
                    leaveNode(node.id, SKIP_MS, 'harvest did not start', `Skipped ${label(node)}. The cursor never landed on the resource.`, 'searching')
                    phase = 'idle'
                    return
                }
                if (harvestClicks > 0 && !started) liftIndex += 1
                harvestClicks += 1
                const ground = projectPoint(player, node, rect, settings)
                const aim = liftAim(ground, harvestLift(settings, liftIndex))
                if (!clickAt(aim, rect)) return
                rememberClick(node, rect)
                publish('harvesting', harvestClicks === 1 && usingSaved
                    ? `Harvesting ${label(node)} with the saved aim.`
                    : liftIndex === 0
                        ? `Harvesting ${label(node)}.`
                        : `Aiming higher on ${label(node)}.`)
                return
            }
            publish('harvesting', started
                ? `Harvesting ${label(node)}.`
                : `Waiting for the harvest on ${label(node)} to register.`)
            return
        }

        if (phase !== 'approach') {
            phase = 'approach'
            phaseSince = now
            harvestClicks = 0
            stuck.reset(player, now)
        }
        stuck.update(player, now)
        if (stuck.isStuck(now) && !channel && (away <= REACH || (lastOrder && distance(lastOrder, node) < 3) || (harvestSeenAt && now - harvestSeenAt < 8000))) {
            stuck.reset(player, now)
            leaveNode(node.id, 8000, 'not moving', `Standing on ${label(node)}. Going to the next one.`)
            return
        }
        if (stuck.isStuck(now) && !channel) {
            stuck.reset(player, now)
            const toward = Math.atan2(node.y - player.y, node.x - player.x)
            survey = {
                nodeId: node.id,
                origin: { x: player.x, y: player.y },
                orders: PROBE.map((offset) => ({
                    x: player.x + Math.cos(toward + offset) * 8,
                    y: player.y + Math.sin(toward + offset) * 8,
                })),
                index: 0,
                blocked: [],
                waiting: false,
            }
            publish('walking', 'Path stopped short. Measuring the dead zone before gathering again.')
            return
        }
        const close = away <= 8
        const arrived = lastOrder && distance(player, lastOrder) < 3.5
        if (lastOrder && !arrived && now - lastClick < WALK_RECLICK_MS) {
            if (!(settings.avoidMobs && stepHitsMob(player, lastOrder, view.entities))) {
                noteLines(player, view.entities, node)
                publish('walking', `Walking to ${label(node)}, ${away.toFixed(0)} m away.`)
                return
            }
            lastOrder = null
        }

        syncMap(player.map)
        const zones = terrain ? terrain.summary(player.map).zones : 0
        const circles = settings.avoidMobs
            ? view.entities.filter((entity) => entity.kind === 'mob' && !entity.passive && distance(player, entity) < 15).map((entity) => ({
                x: entity.x,
                y: entity.y,
                r: clearanceFor(entity),
            }))
            : []
        let step = null
        if (zones || circles.length) {
            if (terrain.blocked(player.map, node.x, node.y)) {
                leaveNode(node.id, 20000, 'inside a dead zone', `${label(node)} is inside a dead zone. Choosing another node.`)
                return
            }
            if (circles.some((circle) => Math.hypot(circle.x - node.x, circle.y - node.y) < circle.r)) {
                leaveNode(node.id, 8000, 'mob blocking the path', `Mob blocking ${label(node)} at ${away.toFixed(0)} m. Choosing another node.`)
                return
            }
            const routed = navigator.findPath(player.map, player, node, circles)
            if (!routed) {
                leaveNode(node.id, 15000, 'no path around the dead zone', `No path around the dead zone to ${label(node)}. The way up has to be the ramp edge.`)
                return
            }
            step = navigator.nextWaypoint(player, Math.min(away, close ? away : WALK_STEP))
            if (settings.avoidMobs && stepHitsMob(player, step, view.entities)) step = null
        }
        if (!step) step = steerPoint(player, node, view.entities, close ? away : WALK_STEP, settings.avoidMobs)
        if (settings.avoidMobs && stepHitsMob(player, step, view.entities)) step = null
        if (close && !zones && (!settings.avoidMobs || !stepHitsMob(player, node, view.entities))) {
            step = { x: node.x, y: node.y }
        }
        if (!step && close && !settings.avoidMobs) step = { x: node.x, y: node.y }
        if (!step) {
            leaveNode(node.id, 8000, 'mob blocking the path', `Mob blocking ${label(node)} at ${away.toFixed(0)} m. Choosing another node.`)
            return
        }
        const from = tracker.predict(0.25) || player
        if (!clickAt(projectPoint(from, step, rect, settings), rect)) return
        rememberClick(step, rect)
        const bend = Math.abs(Math.atan2(step.y - player.y, step.x - player.x) - Math.atan2(node.y - player.y, node.x - player.x))
        noteLines(player, view.entities, node)
        publish('walking', bend > 0.35
            ? `Stepping around a mob toward ${label(node)}, ${away.toFixed(0)} m away.`
            : `Walking to ${label(node)}, ${away.toFixed(0)} m away.`)
    }

    const timer = setInterval(tick, 40)
    if (typeof timer.unref === 'function') timer.unref()

    return {
        configure,
        aim,
        markNode,
        calibrate,
        observe,
        draftBegin: () => zone('begin'),
        draftPoint: (x, y) => zone('addPoint', x, y),
        draftUndo: () => zone('undo'),
        draftCancel: () => zone('cancel'),
        markRamp: (id, x, y) => terrain ? terrain.setRamp(mapName(), id, terrain.nearestEdge(mapName(), id, x, y)) : { ok: false },
        markSolid: (id) => zone('setRamp', id, null),
        removeZone: (id) => zone('remove', id),
        deleteZoneAt: (x, y) => {
            if (!terrain) return { ok: false }
            const id = terrain.zoneAt(mapName(), x, y)
            if (id == null) return terrain.view(mapName())
            return terrain.remove(mapName(), id)
        },
        clearZones: () => zone('clear'),
        zonesView: () => terrain ? terrain.view(mapName()) : { zones: [], draft: [], waitingRamp: null },
        publicState,
    }
}

module.exports = {
    createGather,
    projectPoint,
    pickTarget,
    solveView,
    solveAffine,
    steerPoint,
}
