const { isGatheringMob } = require('./critters')
const MOVE_JUMP_LIMIT = 60

const Event = {
    Leave: 1,
    Move: 3,
    NewSimpleHarvestableObject: 38,
    NewSimpleHarvestableObjectList: 39,
    NewHarvestableObject: 40,
    HarvestableChangeState: 46,
    HealthUpdate: 6,
    NewTreasureChest: 117,
    NewMob: 123,
    NewRandomDungeonExit: 325,
}

const Request = {
    MoveLegacy: 21,
    Move: 22,
}

const Response = {
    JoinFinished: 2,
    ChangeClusterLegacy: 35,
    ChangeCluster: 41,
}

function entityId(value) {
    if (value === undefined || value === null || value === '') return null
    if (typeof value === 'bigint') return value.toString()
    return String(value)
}

function asList(value) {
    if (Array.isArray(value)) return value
    if (value && Array.isArray(value.data)) return value.data
    return []
}

function positionPair(value) {
    if (!Array.isArray(value) || value.length < 2 || value.length > 3) return null
    const x = Number(value[0])
    const y = Number(value[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    if (Math.abs(x) > 100000 || Math.abs(y) > 100000) return null
    return [x, y]
}

function resourceName(type) {
    const code = Number(type)
    if (code >= 0 && code <= 5) return 'wood'
    if (code >= 6 && code <= 10) return 'rock'
    if (code >= 11 && code <= 15) return 'fiber'
    if (code >= 16 && code <= 22) return 'hide'
    if (code >= 23 && code <= 27) return 'ore'
    return 'resource'
}

function tierOf(value) {
    const tier = Number(value)
    if (!Number.isFinite(tier) || tier <= 0) return 0
    return tier
}

function movePosition(blob) {
    let bytes = null
    if (Buffer.isBuffer(blob)) bytes = blob
    else if (Array.isArray(blob)) bytes = Buffer.from(blob)
    else if (blob && Array.isArray(blob.data)) bytes = Buffer.from(blob.data)
    if (!bytes || bytes.length < 17 || bytes[0] !== 3) return null
    const x = bytes.readFloatLE(9)
    const y = bytes.readFloatLE(13)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    if (Math.abs(x) > 100000 || Math.abs(y) > 100000) return null
    return [x, y]
}

function opCode(message) {
    const parameters = message?.parameters || {}
    if (parameters[253] !== undefined && parameters[253] !== null) return Number(parameters[253])
    return Number(message?.operationCode)
}

function eventCode(message) {
    const parameters = message?.parameters || {}
    if (parameters[252] !== undefined && parameters[252] !== null) return Number(parameters[252])
    return Number(message?.code)
}

function createWorld(emit) {
    const entities = new Map()
    const player = {
        x: null,
        y: null,
        destX: null,
        destY: null,
        map: '',
    }

    function snapshot() {
        return {
            player: { ...player },
            entities: [...entities.values()],
        }
    }

    function clearEntities() {
        if (entities.size === 0) return
        entities.clear()
        emit('reset', { player: { ...player } })
    }

    function setMap(name) {
        if (typeof name !== 'string' || name.length === 0 || name === player.map) return
        player.map = name
        entities.clear()
        emit('reset', { player: { ...player } })
    }

    function setPlayer(x, y, dest) {
        const moved = player.x !== x || player.y !== y
            || (dest && (player.destX !== dest[0] || player.destY !== dest[1]))
        player.x = x
        player.y = y
        if (dest) {
            player.destX = dest[0]
            player.destY = dest[1]
        }
        if (!moved) return
        emit('player', { ...player })
        cull()
    }

    function cull() {
        if (!Number.isFinite(player.x) || !Number.isFinite(player.y)) return
        for (const [id, entity] of entities) {
            const dx = entity.x - player.x
            const dy = entity.y - player.y
            if (dx * dx + dy * dy > VIEW_LIMIT * VIEW_LIMIT) remove(id)
        }
    }

    function upsert(entity) {
        const previous = entities.get(entity.id)
        const next = {
            id: entity.id,
            kind: entity.kind,
            x: entity.x,
            y: entity.y,
            name: entity.name || previous?.name || '',
            tier: entity.tier ?? previous?.tier ?? 0,
            enchant: entity.enchant ?? previous?.enchant ?? 0,
            size: entity.size ?? previous?.size ?? null,
            seen: Date.now(),
        }
        entities.set(next.id, next)
        emit('upsert', next)
    }

    function remove(id) {
        const key = entityId(id)
        if (!key || !entities.has(key)) return
        entities.delete(key)
        emit('remove', { id: key })
    }

    function addResource(id, type, tier, x, y, size, enchant) {
        const key = entityId(id)
        if (!key || !Number.isFinite(x) || !Number.isFinite(y)) return
        const count = Number(size)
        if (Number.isFinite(count) && count <= 0) {
            remove(key)
            return
        }
        upsert({
            id: key,
            kind: 'resource',
            x,
            y,
            name: resourceName(type),
            tier: tierOf(tier),
            enchant: Number(enchant) || 0,
            size: Number.isFinite(count) ? count : null,
        })
    }

    function addBatch(parameters) {
        const ids = asList(parameters[0])
        const types = asList(parameters[1])
        const tiers = asList(parameters[2])
        const positions = asList(parameters[3])
        const sizes = asList(parameters[4])
        for (let i = 0; i < ids.length; i++) {
            const x = Number(positions[i * 2])
            const y = Number(positions[i * 2 + 1])
            addResource(ids[i], types[i], tiers[i], x, y, sizes[i], 0)
        }
    }

    function onEvent(message) {
        const parameters = message?.parameters || {}
        const code = eventCode(message)

        if (code === Event.Leave) {
            remove(parameters[0])
            return
        }

        if (code === Event.Move) {
            const id = entityId(parameters[0])
            const spot = movePosition(parameters[1])
            const current = id && entities.get(id)
            if (!current || !spot) return
            const dx = spot[0] - current.x
            const dy = spot[1] - current.y
            if (dx * dx + dy * dy > MOVE_JUMP_LIMIT * MOVE_JUMP_LIMIT) return
            upsert({ ...current, x: spot[0], y: spot[1] })
            return
        }

        if (code === Event.NewSimpleHarvestableObject || code === Event.NewSimpleHarvestableObjectList) {
            addBatch(parameters)
            return
        }

        if (code === Event.NewHarvestableObject) {
            const spot = positionPair(parameters[8])
            if (!spot) return
            addResource(
                parameters[0],
                parameters[5],
                parameters[7],
                spot[0],
                spot[1],
                parameters[10],
                parameters[11],
            )
            return
        }

        if (code === Event.HarvestableChangeState) {
            const id = entityId(parameters[0])
            const current = id && entities.get(id)
            if (!current || current.kind !== 'resource') return
            if (parameters[1] === undefined || parameters[1] === null || Number(parameters[1]) <= 0) {
                remove(id)
                return
            }
            const enchant = parameters[2]
            upsert({
                ...current,
                size: Number(parameters[1]),
                enchant: enchant === undefined ? current.enchant : Number(enchant) || 0,
            })
            return
        }

        if (code === Event.HealthUpdate) {
            const id = entityId(parameters[0])
            const current = id && entities.get(id)
            if (!current || (current.kind !== 'mob' && current.kind !== 'mist')) return
            const hp = parameters[3]
            if (hp === undefined || hp === null || Number(hp) <= 0) remove(id)
            return
        }

        if (code === Event.NewMob) {
            const id = entityId(parameters[0])
            const spot = positionPair(parameters[7])
            if (!id || !spot) return
            const portal = typeof parameters[33] === 'string' ? parameters[33] : ''
            const mist = portal.toUpperCase().startsWith('MISTS_')
            const typeId = parameters[1]
            upsert({
                id,
                kind: mist ? 'mist' : 'mob',
                x: spot[0],
                y: spot[1],
                name: mist ? portal : (typeof typeId === 'string' ? typeId : ''),
                tier: 0,
                enchant: Number(parameters[34]) || 0,
                size: null,
                passive: !mist && isGatheringMob(typeId),
            })
            return
        }

        if (code === Event.NewTreasureChest) {
            const id = entityId(parameters[0])
            const spot = positionPair(parameters[1])
            if (!id || !spot) return
            const name = typeof parameters[3] === 'string' ? parameters[3] : 'chest'
            upsert({
                id,
                kind: 'chest',
                x: spot[0],
                y: spot[1],
                name,
                tier: 0,
                enchant: Number(parameters[4]) || 0,
                size: null,
            })
            return
        }

        if (code === Event.NewRandomDungeonExit) {
            const id = entityId(parameters[0])
            const spot = positionPair(parameters[1])
            if (!id || !spot) return
            const name = typeof parameters[3] === 'string' ? parameters[3] : 'dungeon'
            upsert({
                id,
                kind: 'dungeon',
                x: spot[0],
                y: spot[1],
                name,
                tier: 0,
                enchant: Number(parameters[9]) || 0,
                size: null,
            })
        }
    }

    function onRequest(message) {
        const code = opCode(message)
        if (code !== Request.Move && code !== Request.MoveLegacy) return
        const parameters = message?.parameters || {}
        const spot = positionPair(parameters[1])
        const dest = positionPair(parameters[3])
        if (!spot) return
        setPlayer(spot[0], spot[1], dest)
    }

    function onResponse(message) {
        const code = opCode(message)
        const parameters = message?.parameters || {}

        if (code === Response.JoinFinished) {
            if (typeof parameters[8] === 'string') setMap(parameters[8])
            const spot = positionPair(parameters[9])
            if (spot) setPlayer(spot[0], spot[1], null)
            return
        }

        if (code === Response.ChangeCluster || code === Response.ChangeClusterLegacy) {
            if (typeof parameters[0] === 'string') setMap(parameters[0])
            else clearEntities()
        }
    }

    function ingest(kind, message) {
        if (kind === 'event') onEvent(message)
        else if (kind === 'request') onRequest(message)
        else if (kind === 'response') onResponse(message)
    }

    function prune(maxAgeMs) {
        const cutoff = Date.now() - maxAgeMs
        for (const [id, entity] of entities) {
            if (entity.seen < cutoff) remove(id)
        }
    }

    function clear() {
        entities.clear()
        emit('reset', { player: { ...player } })
    }

    return { ingest, snapshot, prune, clear }
}

module.exports = {
    createWorld,
}
