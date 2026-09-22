const PhotonParser = require('../vendor/photon-packet-parser');
const { deviceForIp, startCapture } = require('./capture')
const { networkInterfaces } = require('os')
const readlineSync = require('readline-sync');

const FILTER = 'udp and (dst port 5056 or src port 5056)';

const initListener = (options = {}) => {
    const listener = new PhotonParser();
    const adapterIp = getAdapterIp(options)
    const device = deviceForIp(adapterIp)

    if (!device) {
        console.log(`No capture device found for ${adapterIp}. Install Npcap, then run this again.`)
        process.exit(1)
    }

    let sawPacket = false
    startCapture(device.name, FILTER, (payload) => {
        if (!sawPacket) {
            sawPacket = true
            console.log('Game traffic detected.')
        }
        try {
            listener.handle(payload)
        } catch {
            return
        }
    })

    setTimeout(() => {
        if (!sawPacket) {
            console.log('No game packets yet. Stay logged into Albion on this adapter.')
        }
    }, 3000)

    return listener
}

const getAdapterIp = (options = {}) => {
    const interfaces = networkInterfaces()

    console.log()
    console.log('Please select one of the adapter that you use to connect to the internet:')

    let i = 1;
    const selection = {}
    const selectionName = {}
    for (const [name, value] of Object.entries(interfaces)) {
        const detail = value.find(v => v.family === 'IPv4')
        if (!detail) continue;
        selection[i] = detail.address;
        selectionName[i] = name;
        console.log(`  ${i}. ${name}\t ip address: ${detail.address}`)
        i++;
    }

    console.log()
    let userSelect = readlineSync.question('input the number here: ');
    const selectedIp = selection[userSelect]
    const selectedName = selectionName[userSelect]

    if (!selectedIp) {
        console.log()
        console.log('invalid input, try again')
        return getAdapterIp(options)
    }

    console.log()
    console.log(`you have selected "${selectedName}"`)
    console.log(options.readyMessage || 'Listening. Open the radar and move once in a zone so your position becomes the center.')
    console.log()

    return selectedIp
}

module.exports = {
    initListener,
}