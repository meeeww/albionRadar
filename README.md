## Albion radar

A local map radar for Albion Online. It reads the game's Photon traffic and draws what the server already sends in the clear, with your character at the center.

### What it shows

- Your position, from the move request and from joining a map
- Harvestable resources
- Mobs and mist portals
- Treasure chests
- Random dungeon entrances

Other players' live positions are encrypted on the wire, so they are not drawn.

### Run

Install [Npcap](https://npcap.com/), then:

```
npm start
```

Pick the network adapter Albion uses. The radar opens at http://127.0.0.1:4789. Walk into a zone and move once so your position locks to the center. Changing maps clears the previous zone.

### Thanks

Packet capture follows the approach in [FashionFlora/Albion-Online-Radar-QRadar](https://github.com/FashionFlora/Albion-Online-Radar-QRadar), using [photon-packet-parser](https://github.com/0xN0x/photon-packet-parser) and [koffi](https://koffi.dev/).
