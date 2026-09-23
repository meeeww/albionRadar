const koffi = require('koffi')
const fs = require('fs')

const PCAP_ERRBUF_SIZE = 256
const DLT_EN10MB = 1
const SNAPLEN = 65535
const READ_TIMEOUT_MS = 1

const wpcap = loadWpcap()

const pcap_addr = koffi.struct('pcap_addr', {
    next: 'pcap_addr *',
    addr: 'void *',
    netmask: 'void *',
    broadaddr: 'void *',
    dstaddr: 'void *',
})

const pcap_if = koffi.struct('pcap_if', {
    next: 'pcap_if *',
    name: 'char *',
    description: 'char *',
    addresses: 'pcap_addr *',
    flags: 'uint32_t',
})

const sockaddr_in = koffi.struct('sockaddr_in', {
    sin_family: 'int16_t',
    sin_port: 'uint16_t',
    sin_addr: koffi.array('uint8_t', 4),
    sin_zero: koffi.array('uint8_t', 8),
})

const pcap_pkthdr = koffi.struct('pcap_pkthdr', {
    ts: koffi.struct('timeval', {
        tv_sec: 'long',
        tv_usec: 'long',
    }),
    caplen: 'uint32_t',
    len: 'uint32_t',
})

const bpf_program = koffi.struct('bpf_program', {
    bf_len: 'uint32_t',
    bf_insns: 'void *',
})

const pcap_findalldevs = wpcap.func('int pcap_findalldevs(_Out_ pcap_if **alldevs, uint8_t *errbuf)')
const pcap_freealldevs = wpcap.func('void pcap_freealldevs(pcap_if *alldevs)')
const pcap_open_live = wpcap.func('void *pcap_open_live(const char *device, int snaplen, int promisc, int to_ms, uint8_t *errbuf)')
const pcap_close = wpcap.func('void pcap_close(void *p)')
const pcap_datalink = wpcap.func('int pcap_datalink(void *p)')
const pcap_compile = wpcap.func('int pcap_compile(void *p, _Out_ bpf_program *fp, const char *str, int optimize, uint32_t netmask)')
const pcap_setfilter = wpcap.func('int pcap_setfilter(void *p, bpf_program *fp)')
const pcap_freecode = wpcap.func('void pcap_freecode(bpf_program *fp)')
const pcap_next = wpcap.func('uint8_t *pcap_next(void *p, _Out_ pcap_pkthdr *h)')
const pcap_geterr = wpcap.func('str pcap_geterr(void *p)')

function loadWpcap() {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows'
    const candidates = [
        `${systemRoot}\\System32\\Npcap\\wpcap.dll`,
        `${systemRoot}\\System32\\wpcap.dll`,
    ]
    const dllPath = candidates.find((candidate) => fs.existsSync(candidate))
    if (!dllPath) {
        throw new Error('Npcap was not found. Install it from https://npcap.com/ and run this again.')
    }
    return koffi.load(dllPath)
}

function cString(buffer) {
    const end = buffer.indexOf(0)
    return buffer.toString('utf8', 0, end === -1 ? buffer.length : end)
}

function ipv4FromSockaddr(pointer) {
    if (!pointer) return null
    const sock = koffi.decode(pointer, sockaddr_in)
    if (sock.sin_family !== 2) return null
    return sock.sin_addr.join('.')
}

function listDevices() {
    const errbuf = Buffer.alloc(PCAP_ERRBUF_SIZE)
    const devices = [null]
    const result = pcap_findalldevs(devices, errbuf)
    if (result !== 0 || !devices[0]) {
        throw new Error(cString(errbuf) || 'pcap_findalldevs failed')
    }

    const listed = []
    let current = devices[0]
    while (current) {
        const info = koffi.decode(current, pcap_if)
        const addresses = []
        let address = info.addresses
        while (address) {
            const entry = koffi.decode(address, pcap_addr)
            const ip = ipv4FromSockaddr(entry.addr)
            if (ip) addresses.push(ip)
            address = entry.next
        }
        listed.push({
            name: info.name,
            description: info.description || info.name,
            addresses,
        })
        current = info.next
    }

    pcap_freealldevs(devices[0])
    return listed
}

function deviceForIp(ip) {
    return listDevices().find((device) => device.addresses.includes(ip)) || null
}

function udpPayloadFromFrame(linkType, frame) {
    if (linkType !== DLT_EN10MB || frame.length < 14) return null

    let offset = 14
    let etherType = frame.readUInt16BE(12)
    if (etherType === 0x8100) {
        if (frame.length < 18) return null
        etherType = frame.readUInt16BE(16)
        offset = 18
    }
    if (etherType !== 0x0800) return null
    if (frame.length < offset + 20) return null

    const version = frame[offset] >> 4
    if (version !== 4) return null
    const headerLength = (frame[offset] & 0x0f) * 4
    if (frame[offset + 9] !== 17) return null

    const udpOffset = offset + headerLength
    if (frame.length < udpOffset + 8) return null
    const udpLength = frame.readUInt16BE(udpOffset + 4)
    const payloadStart = udpOffset + 8
    const payloadEnd = udpOffset + udpLength
    if (payloadEnd < payloadStart || payloadEnd > frame.length) return null
    return frame.subarray(payloadStart, payloadEnd)
}

function startCapture(deviceName, filter, onPayload) {
    const errbuf = Buffer.alloc(PCAP_ERRBUF_SIZE)
    const handle = pcap_open_live(deviceName, SNAPLEN, 0, READ_TIMEOUT_MS, errbuf)
    if (!handle) {
        throw new Error(cString(errbuf) || 'pcap_open_live failed')
    }

    const program = {}
    if (pcap_compile(handle, program, filter, 1, 0xffffffff) !== 0) {
        const message = pcap_geterr(handle)
        pcap_close(handle)
        throw new Error(message || 'pcap_compile failed')
    }
    if (pcap_setfilter(handle, program) !== 0) {
        const message = pcap_geterr(handle)
        pcap_freecode(program)
        pcap_close(handle)
        throw new Error(message || 'pcap_setfilter failed')
    }
    pcap_freecode(program)

    const linkType = pcap_datalink(handle)
    const poll = () => {
        try {
            for (let i = 0; i < 64; i++) {
                const header = {}
                const data = pcap_next(handle, header)
                if (!data || !header.caplen) break

                const frame = Buffer.from(koffi.decode(data, koffi.array('uint8_t', header.caplen)))
                const payload = udpPayloadFromFrame(linkType, frame)
                if (payload && payload.length) onPayload(Buffer.from(payload))
            }
        } catch (error) {
            console.error(error)
        }
        setImmediate(poll)
    }
    setImmediate(poll)
}

module.exports = {
    deviceForIp,
    startCapture,
}
