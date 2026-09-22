const {
    Reader,
    ShortRead,
    deserializeEventData,
    deserializeOperationRequest,
    deserializeOperationResponse,
} = require('./Protocol18Deserializer')

const HEADER_LENGTH = 12
const FRAGMENT_HEADER_LENGTH = 20

class PhotonPacket {
    constructor(parent, buffer) {
        this.parent = parent
        try {
            this.parse(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer))
        } catch (error) {
            if (!(error instanceof ShortRead)) throw error
        }
    }

    parse(buffer) {
        const reader = new Reader(buffer)
        if (reader.remaining() < HEADER_LENGTH) return

        reader.skip(2)
        const flags = reader.readUInt8()
        const commandCount = reader.readUInt8()
        reader.skip(8)

        if (flags === 1) {
            this.consumed = buffer.length
            return
        }
        if (flags === 0xCC) reader.skip(4)
        if (commandCount > 128) return

        for (let i = 0; i < commandCount; i++) {
            if (reader.remaining() < HEADER_LENGTH) return

            const commandType = reader.readUInt8()
            reader.skip(3)
            const commandLength = reader.readUInt32BE()
            reader.skip(4)

            if (commandLength < HEADER_LENGTH) return
            const bodyLength = commandLength - HEADER_LENGTH
            if (reader.remaining() < bodyLength) return

            const body = reader.readBytes(bodyLength)
            this.handleCommand(commandType, body)
        }

        this.consumed = reader.offset
    }

    handleCommand(commandType, body) {
        if (commandType === 7) {
            if (body.length < 4) return
            this.handleReliable(body.subarray(4))
            return
        }

        if (commandType === 6) {
            this.handleReliable(body)
            return
        }

        if (commandType === 8) {
            this.handleFragment(body)
        }
    }

    handleReliable(body) {
        if (body.length < 2) return

        const messageType = body[1]
        if (messageType > 128) return

        const payload = new Reader(body.subarray(2))
        const raw = Buffer.from(body.subarray(0, Math.min(body.length, 384)))
        if (messageType === 2) {
            const message = deserializeOperationRequest(payload)
            message.raw = raw
            this.parent.emit('request', message)
            return
        }

        if (messageType === 3 || messageType === 7) {
            const message = deserializeOperationResponse(payload)
            message.raw = raw
            this.parent.emit('response', message)
            return
        }

        if (messageType === 4) {
            const message = deserializeEventData(payload)
            message.raw = raw
            this.parent.emit('event', message)
        }
    }

    handleFragment(body) {
        if (body.length < FRAGMENT_HEADER_LENGTH) return

        const reader = new Reader(body)
        const startSequence = reader.readInt32BE()
        reader.skip(8)
        const totalLength = reader.readInt32BE()
        const fragmentOffset = reader.readUInt32BE()
        const fragment = reader.readBytes(reader.remaining())

        if (totalLength <= 0 || totalLength > 10 * 1024 * 1024) return
        if (fragmentOffset + fragment.length > totalLength) return

        if (!this.parent.fragments) this.parent.fragments = new Map()

        let pending = this.parent.fragments.get(startSequence)
        if (!pending) {
            pending = {
                totalLength,
                written: 0,
                payload: Buffer.alloc(totalLength),
            }
            this.parent.fragments.set(startSequence, pending)
        }

        fragment.copy(pending.payload, fragmentOffset)
        pending.written += fragment.length

        if (pending.written >= pending.totalLength) {
            this.parent.fragments.delete(startSequence)
            this.handleReliable(pending.payload)
        }
    }
}

module.exports = PhotonPacket
