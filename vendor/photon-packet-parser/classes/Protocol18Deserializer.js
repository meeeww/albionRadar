class ShortRead extends Error {}

class Reader {
    constructor(buffer) {
        this.buffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
        this.offset = 0
    }

    remaining() {
        return this.buffer.length - this.offset
    }

    need(n) {
        if (this.remaining() < n) throw new ShortRead()
    }

    readUInt8() {
        this.need(1)
        return this.buffer.readUInt8(this.offset++)
    }

    readInt16LE() {
        this.need(2)
        const value = this.buffer.readInt16LE(this.offset)
        this.offset += 2
        return value
    }

    readUInt16LE() {
        this.need(2)
        const value = this.buffer.readUInt16LE(this.offset)
        this.offset += 2
        return value
    }

    readUInt32BE() {
        this.need(4)
        const value = this.buffer.readUInt32BE(this.offset)
        this.offset += 4
        return value
    }

    readInt32BE() {
        this.need(4)
        const value = this.buffer.readInt32BE(this.offset)
        this.offset += 4
        return value
    }

    readFloatLE() {
        this.need(4)
        const value = this.buffer.readFloatLE(this.offset)
        this.offset += 4
        return value
    }

    readDoubleLE() {
        this.need(8)
        const value = this.buffer.readDoubleLE(this.offset)
        this.offset += 8
        return value
    }

    skip(n) {
        this.need(n)
        this.offset += n
    }

    readBytes(n) {
        this.need(n)
        const value = this.buffer.subarray(this.offset, this.offset + n)
        this.offset += n
        return value
    }

    readVarint32() {
        let value = 0
        for (let shift = 0; shift <= 28; shift += 7) {
            const byte = this.readUInt8()
            if ((byte & 0x80) === 0) {
                if (shift === 28 && byte > 0x0f) throw new ShortRead()
                return (value | (byte << shift)) >>> 0
            }
            value |= (byte & 0x7f) << shift
        }
        throw new ShortRead()
    }

    readVarint64() {
        let value = 0n
        for (let shift = 0n; shift <= 63n; shift += 7n) {
            const byte = BigInt(this.readUInt8())
            if ((byte & 0x80n) === 0n) {
                if (shift === 63n && byte > 1n) throw new ShortRead()
                return value | (byte << shift)
            }
            value |= (byte & 0x7fn) << shift
        }
        throw new ShortRead()
    }
}

const Type = {
    Unknown: 0,
    Boolean: 2,
    Byte: 3,
    Short: 4,
    Float: 5,
    Double: 6,
    String: 7,
    Null: 8,
    CompressedInt: 9,
    CompressedLong: 10,
    Int1: 11,
    Int1Negative: 12,
    Int2: 13,
    Int2Negative: 14,
    Long1: 15,
    Long1Negative: 16,
    Long2: 17,
    Long2Negative: 18,
    Custom: 19,
    Dictionary: 20,
    Hashtable: 21,
    ObjectArray: 23,
    BooleanFalse: 27,
    BooleanTrue: 28,
    ShortZero: 29,
    IntZero: 30,
    LongZero: 31,
    FloatZero: 32,
    DoubleZero: 33,
    ByteZero: 34,
    Array: 64,
    BooleanArray: 66,
    ByteArray: 67,
    ShortArray: 68,
    FloatArray: 69,
    DoubleArray: 70,
    StringArray: 71,
    CompressedIntArray: 73,
    CompressedLongArray: 74,
    CustomTypeArray: 83,
    DictionaryArray: 84,
    HashtableArray: 85,
    CustomTypeSlim: 128,
}

function numberFromBigInt(value) {
    if (typeof value !== 'bigint') return value
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(value)
    }
    return value
}

function zigzag32(value) {
    return (value >>> 1) ^ -(value & 1)
}

function zigzag64(value) {
    return numberFromBigInt((value >> 1n) ^ -(value & 1n))
}

function readString(reader) {
    const length = reader.readVarint32()
    if (length === 0) return ''
    if (length > reader.remaining()) throw new ShortRead()
    return reader.readBytes(length).toString('utf8')
}

function deserialize(reader, typeCode) {
    if (typeCode >= Type.CustomTypeSlim) {
        return readCustom(reader, typeCode - Type.CustomTypeSlim)
    }

    switch (typeCode) {
        case Type.Boolean:
            return reader.readUInt8() !== 0
        case Type.BooleanFalse:
            return false
        case Type.BooleanTrue:
            return true
        case Type.Byte:
            return reader.readUInt8()
        case Type.ByteZero:
            return 0
        case Type.Short:
            return reader.readInt16LE()
        case Type.ShortZero:
            return 0
        case Type.Float:
            return reader.readFloatLE()
        case Type.FloatZero:
            return 0
        case Type.Double:
            return reader.readDoubleLE()
        case Type.DoubleZero:
            return 0
        case Type.String:
            return readString(reader)
        case Type.Null:
        case Type.Unknown:
            return null
        case Type.CompressedInt:
            return zigzag32(reader.readVarint32())
        case Type.CompressedLong:
            return zigzag64(reader.readVarint64())
        case Type.Int1:
            return reader.readUInt8()
        case Type.Int1Negative:
            return -reader.readUInt8()
        case Type.Int2:
            return reader.readUInt16LE()
        case Type.Int2Negative:
            return -reader.readUInt16LE()
        case Type.Long1:
            return reader.readUInt8()
        case Type.Long1Negative:
            return -reader.readUInt8()
        case Type.Long2:
            return reader.readUInt16LE()
        case Type.Long2Negative:
            return -reader.readUInt16LE()
        case Type.IntZero:
            return 0
        case Type.LongZero:
            return 0
        case Type.Dictionary:
            return readDictionary(reader)
        case Type.Hashtable:
            return readHashtable(reader)
        case Type.ObjectArray:
        case Type.Array:
            return readObjectArray(reader)
        case Type.ByteArray:
            return readByteArray(reader)
        case Type.ShortArray:
            return readTypedArray(reader, 2, (input) => input.readInt16LE())
        case Type.FloatArray:
            return readTypedArray(reader, 4, (input) => input.readFloatLE())
        case Type.DoubleArray:
            return readTypedArray(reader, 8, (input) => input.readDoubleLE())
        case Type.StringArray:
            return readCounted(reader, () => readString(reader))
        case Type.CompressedIntArray:
            return readCounted(reader, () => zigzag32(reader.readVarint32()))
        case Type.CompressedLongArray:
            return readCounted(reader, () => zigzag64(reader.readVarint64()))
        case Type.BooleanArray:
            return readBooleanArray(reader)
        case Type.Custom:
            return readCustom(reader, null)
        case Type.CustomTypeArray:
            return readCustomArray(reader)
        case Type.DictionaryArray:
            return readDictionaryArray(reader)
        case Type.HashtableArray:
            return readCounted(reader, () => readHashtable(reader))
        default:
            throw new ShortRead()
    }
}

function readParameterTable(reader) {
    if (reader.remaining() < 1) return {}
    const size = reader.readUInt8()
    const table = {}

    for (let i = 0; i < size; i++) {
        if (reader.remaining() < 2) break
        const key = reader.readUInt8()
        const typeCode = reader.readUInt8()
        table[key] = deserialize(reader, typeCode)
    }

    return table
}

function readDictionary(reader) {
    const keyType = reader.readUInt8()
    const valueType = reader.readUInt8()
    return readDictionaryEntries(reader, keyType, valueType)
}

function readDictionaryEntries(reader, keyType, valueType) {
    const size = reader.readVarint32()
    const table = {}
    if (size > reader.remaining()) return table

    for (let i = 0; i < size && reader.remaining() > 0; i++) {
        const key = keyType === Type.Unknown
            ? deserialize(reader, reader.readUInt8())
            : deserialize(reader, keyType)
        const value = valueType === Type.Unknown
            ? deserialize(reader, reader.readUInt8())
            : deserialize(reader, valueType)
        if (key !== null && key !== undefined) table[key] = value
    }

    return table
}

function readHashtable(reader) {
    const size = reader.readVarint32()
    const table = {}
    if (size > reader.remaining()) return table

    for (let i = 0; i < size && reader.remaining() > 0; i++) {
        const key = deserialize(reader, reader.readUInt8())
        const value = deserialize(reader, reader.readUInt8())
        if (key !== null && key !== undefined) table[key] = value
    }

    return table
}

function readObjectArray(reader) {
    const size = reader.readVarint32()
    if (size > reader.remaining()) return []
    const values = []
    for (let i = 0; i < size && reader.remaining() > 0; i++) {
        values.push(deserialize(reader, reader.readUInt8()))
    }
    return values
}

function readByteArray(reader) {
    const length = reader.readVarint32()
    if (length > reader.remaining()) throw new ShortRead()
    return Array.from(reader.readBytes(length))
}

function readTypedArray(reader, width, read) {
    const length = reader.readVarint32()
    if (length * width > reader.remaining()) throw new ShortRead()
    const values = []
    for (let i = 0; i < length; i++) values.push(read(reader))
    return values
}

function readCounted(reader, read) {
    const length = reader.readVarint32()
    if (length > reader.remaining()) return []
    const values = []
    for (let i = 0; i < length && reader.remaining() > 0; i++) values.push(read())
    return values
}

function readBooleanArray(reader) {
    const length = reader.readVarint32()
    const values = []
    let index = 0
    while (index < length) {
        const byte = reader.readUInt8()
        for (let bit = 0; bit < 8 && index < length; bit++) {
            values.push((byte & (1 << bit)) !== 0)
            index++
        }
    }
    return values
}

function readCustom(reader, slimCode) {
    const typeCode = slimCode === null ? reader.readUInt8() : slimCode
    const length = reader.readVarint32()
    if (length > reader.remaining()) throw new ShortRead()
    reader.skip(length)
    return { customTypeCode: typeCode }
}

function readCustomArray(reader) {
    const length = reader.readVarint32()
    const typeCode = reader.readUInt8()
    const values = []
    for (let i = 0; i < length && reader.remaining() > 0; i++) {
        const size = reader.readVarint32()
        if (size > reader.remaining()) throw new ShortRead()
        reader.skip(size)
        values.push({ customTypeCode: typeCode })
    }
    return values
}

function readDictionaryArray(reader) {
    const keyType = reader.readUInt8()
    const valueType = reader.readUInt8()
    const length = reader.readVarint32()
    const values = []
    for (let i = 0; i < length && reader.remaining() > 0; i++) {
        values.push(readDictionaryEntries(reader, keyType, valueType))
    }
    return values
}

function deserializeOperationRequest(reader) {
    return {
        operationCode: reader.readUInt8(),
        parameters: readParameterTable(reader),
    }
}

function deserializeEventData(reader) {
    return {
        code: reader.readUInt8(),
        parameters: readParameterTable(reader),
    }
}

function deserializeOperationResponse(reader) {
    const operationCode = reader.readUInt8()
    const returnCode = reader.readInt16LE()
    let debugMessage = ''
    if (reader.remaining() > 0) {
        const debugType = reader.readUInt8()
        const debugValue = deserialize(reader, debugType)
        if (typeof debugValue === 'string') debugMessage = debugValue
    }
    return {
        operationCode,
        returnCode,
        debugMessage,
        parameters: readParameterTable(reader),
    }
}

module.exports = {
    Reader,
    ShortRead,
    deserializeOperationRequest,
    deserializeOperationResponse,
    deserializeEventData,
}
