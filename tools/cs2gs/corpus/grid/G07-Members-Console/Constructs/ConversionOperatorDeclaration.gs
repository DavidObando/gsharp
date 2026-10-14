// inventory: ConversionOperatorDeclaration — implicit and explicit user-defined conversions

package Corpus.Grid07

import System

struct Meters {
    private let _count int32

    init(count int32) {
        _count = count
    }

    func operator implicit(count int32) Meters {
        return Meters(count)
    }

    func operator explicit(meters Meters) int32 {
        return meters._count
    }
}

shared class ConversionOperatorDeclarationFixture {
    func Run() {
        let distance Meters = 42
        let raw = int32(distance)
        Console.WriteLine("ConversionOperatorDeclaration: implicit-then-explicit=" + raw.ToString())
        let more = Meters(7)
        Console.WriteLine("ConversionOperatorDeclaration: roundtrip=" + (int32(more)).ToString())
    }
}
