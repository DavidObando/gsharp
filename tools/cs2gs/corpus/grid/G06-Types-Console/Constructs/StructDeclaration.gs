// inventory: StructDeclaration — plain struct, readonly struct, struct implementing an interface

package Corpus.Grid06

import System

struct Vector2 {
    var X int32
    var Y int32

    init(x int32, y int32) {
        X = x
        Y = y
    }

    func Sum() int32 {
        return X + Y
    }
}

struct ReadonlyPair {
    private let _left int32
    private let _right int32

    init(left int32, right int32) {
        _left = left
        _right = right
    }

    func Product() int32 {
        return _left * _right
    }
}

interface IArea {
    func Area() int32;
}

struct Cell : IArea {
    private let _side int32

    init(side int32) {
        _side = side
    }

    func Area() int32 {
        return _side * _side
    }
}

shared class StructDeclarationFixture {
    func Run() {
        var vector = Vector2(3, 9)
        Console.WriteLine("StructDeclaration: sum=" + vector.Sum().ToString())
        let pair = ReadonlyPair(6, 7)
        Console.WriteLine("StructDeclaration: product=" + pair.Product().ToString())
        var cell = Cell(5)
        Console.WriteLine("StructDeclaration: area=" + cell.Area().ToString())
    }
}
