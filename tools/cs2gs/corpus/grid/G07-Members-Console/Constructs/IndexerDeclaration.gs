// inventory: IndexerDeclaration — this[int] with get and set backed by an array

package Corpus.Grid07

import System

open class SlotRack {
    private let _slots[]int32

    init(size int32) {
        _slots = [size]int32
    }

    prop this[index int32]int32 {
        get {
            return _slots[index]
        }
        set {
            _slots[index] = value
        }
    }
}

shared class IndexerDeclarationFixture {
    func Run() {
        let rack = SlotRack(4)
        rack[0] = 11
        rack[3] = 44
        rack[0] = rack[0] + 1
        Console.WriteLine("IndexerDeclaration: slot0=" + rack[0].ToString())
        Console.WriteLine("IndexerDeclaration: slot3=" + rack[3].ToString())
        Console.WriteLine("IndexerDeclaration: slot1=" + rack[1].ToString())
    }
}
