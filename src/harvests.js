const fs = require('fs')
const path = require('path')

const SAME_SPOT = 5
const MAX_SPOTS = 400

function createHarvests(filePath) {
    let spots = []

    function load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
            spots = Array.isArray(parsed.spots) ? parsed.spots : []
        } catch {
            spots = []
        }
    }

    function save() {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, JSON.stringify({ spots }, null, 2))
    }

    function same(spot, node, map) {
        return spot.map === (map || 'unknown')
            && spot.name === node.name
            && spot.tier === (node.tier || 0)
            && Math.hypot(spot.x - node.x, spot.y - node.y) <= SAME_SPOT
    }

    function find(map, node) {
        if (!node) return null
        return spots.find((spot) => same(spot, node, map)) || null
    }

    function remember(map, node, aim) {
        if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) return null
        const spot = {
            map: map || 'unknown',
            x: Math.round(node.x * 10) / 10,
            y: Math.round(node.y * 10) / 10,
            name: node.name,
            tier: node.tier || 0,
            enchant: node.enchant || 0,
            size: node.size,
            scale: aim.scale,
            angle: aim.angle,
            lift: aim.lift || 0,
            at: Date.now(),
        }
        const index = spots.findIndex((saved) => same(saved, node, map))
        if (index >= 0) spots[index] = spot
        else spots.push(spot)
        if (spots.length > MAX_SPOTS) spots = spots.slice(-MAX_SPOTS)
        save()
        return spot
    }

    load()
    return { find, remember }
}

module.exports = { createHarvests }

if (require.main === module) {
    const assert = require('assert')
    const os = require('os')
    const file = path.join(os.tmpdir(), 'albion-harvests-check.json')
    const book = createHarvests(file)
    book.remember('map', { x: 10, y: 10, name: 'rock', tier: 2, size: 6 }, { scale: 14, angle: 2, lift: 1 })
    const hit = book.find('map', { x: 12, y: 11, name: 'rock', tier: 2 })
    assert.strictEqual(hit.scale, 14)
    assert.strictEqual(hit.lift, 1)
    assert.strictEqual(book.find('map', { x: 40, y: 40, name: 'rock', tier: 2 }), null)
    assert.strictEqual(book.find('map', { x: 11, y: 10, name: 'ore', tier: 2 }), null)
    book.remember('map', { x: 11, y: 10, name: 'rock', tier: 2, size: 3 }, { scale: 17, angle: -4, lift: 2 })
    assert.strictEqual(book.find('map', { x: 10, y: 10, name: 'rock', tier: 2 }).scale, 17)
    fs.unlinkSync(file)
    console.log('harvests ok')
}
