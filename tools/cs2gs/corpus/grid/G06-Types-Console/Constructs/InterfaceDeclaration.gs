// inventory: InterfaceDeclaration — interface methods + properties, default interface method (probe)

package Corpus.Grid06

import System

interface IMeasurable {
    prop Length int32 {
        get;
    }

    func Describe() string;
}

open class Rope : IMeasurable {
    private let _length int32

    init(length int32) {
        _length = length
    }

    prop Length int32 {
        get {
            return _length
        }
    }

    func Describe() string {
        return "rope of " + _length.ToString()
    }
}

interface IWithDefault {
    func Seed() int32;

    func DoubledSeed() int32 {
        return Seed() * 2
    }
}

open class SeedSource : IWithDefault {
    func Seed() int32 {
        return 21
    }
}

shared class InterfaceDeclarationFixture {
    func Run() {
        let rope IMeasurable = Rope(12)
        Console.WriteLine("InterfaceDeclaration: length=" + rope.Length.ToString())
        Console.WriteLine("InterfaceDeclaration: describe=" + rope.Describe())
        let seeded IWithDefault = SeedSource()
        Console.WriteLine("InterfaceDeclaration: default-method=" + seeded.DoubledSeed().ToString())
    }
}
