// Wire type id is the mobs.json row plus 16. Cougars stay hostile.
// ponytail: this set goes stale if the game inserts mob rows. Refresh from ao-bin-dumps mobs.json.
const GATHERING = new Set([396, 397, 398, 400, 405, 424, 425, 426, 448, 449, 461, 462, 463, 464, 482, 483, 551, 552, 553, 554, 555, 556, 557, 558, 559, 560, 561, 562, 563, 570, 571, 572, 573, 574, 575, 576, 577, 578, 579, 580, 581, 582, 583, 584, 585, 586, 587, 588, 589, 590, 591, 592, 593, 594, 595, 596, 597, 598, 599, 615, 616, 617, 618, 619, 620, 621, 622, 623, 624, 625, 626, 627, 628, 629, 630, 631, 632, 633, 634, 635, 636, 637, 638, 639, 640, 641, 642, 643, 644, 645, 646, 647, 648, 649, 650, 651, 652, 653, 654, 655, 656, 657, 658, 659, 660, 661, 662, 663, 664, 665, 666, 667, 668, 669, 670, 671, 672, 673, 674, 675, 676, 677, 678, 679, 680, 681, 682, 683, 684, 685, 686, 687, 688, 689, 690, 691, 692, 693, 694, 695, 696, 697, 698, 699, 700, 701, 702, 703, 704, 705, 706, 707, 708, 709, 710, 711, 712, 713, 714, 715, 716, 717, 718, 719, 720, 721, 722, 723, 724, 725, 726, 727, 728, 729, 730, 731, 732, 733, 734, 735, 736, 737, 738, 739, 740, 741, 742, 743, 744, 745, 746])

function isGatheringMob(typeId) {
    const name = String(typeId || '')
    if (/COUGAR/.test(name)) return false
    if (/_CRITTER_|MARMOT|RABBIT|IMPALA|MOABIRD/.test(name)) return true
    return GATHERING.has(Number(typeId))
}

module.exports = { isGatheringMob }

if (require.main === module) {
    const assert = require('assert')
    assert.strictEqual(isGatheringMob(705), true)
    assert.strictEqual(isGatheringMob(461), true)
    assert.strictEqual(isGatheringMob(564), false)
    assert.strictEqual(isGatheringMob('T3_MOB_CRITTER_ROCK_MISTS_RED'), true)
    assert.strictEqual(isGatheringMob(1), false)
    console.log('critters ok')
}
