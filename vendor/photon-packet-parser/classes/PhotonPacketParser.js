const PhotonPacket = require('./PhotonPacket');
const EventEmitter = require('events');

class PhotonPacketParser extends EventEmitter {
	constructor() {
		super();
	}

	handle(buff) {
		const buffer = Buffer.isBuffer(buff) ? buff : Buffer.from(buff)
		let offset = 0

		while (offset + 12 <= buffer.length) {
			let consumed = 0
			try {
				const packet = new PhotonPacket(this, buffer.subarray(offset))
				consumed = packet.consumed || 0
			} catch {
				return
			}
			if (consumed < 12) return
			offset += consumed
		}
	}
}

module.exports = PhotonPacketParser;