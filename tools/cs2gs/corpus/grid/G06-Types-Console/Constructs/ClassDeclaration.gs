// inventory: ClassDeclaration — plain / sealed / abstract+override / static / nested

package Corpus.Grid06

import System

open class PlainCounter {
    private var _count int32

    func Bump() {
        _count = _count + 1
    }

    func Count() int32 {
        return _count
    }
}

class SealedBadge {
    private let _label string

    init(label string) {
        _label = label
    }

    func Label() string {
        return _label
    }
}

abstract class ShapeBase {
    open func Area() int32;

    func DoubledArea() int32 {
        return Area() * 2
    }
}

class SquareShape : ShapeBase {
    private let _side int32

    init(side int32) {
        _side = side
    }

    override func Area() int32 {
        return _side * _side
    }
}

shared class StaticMath {
    const Base int32 = 10

    func Triple(value int32) int32 {
        return value * 3
    }
}

open class OuterHolder {
    open class InnerPart {
        func Piece() int32 {
            return 5
        }
    }

    func FromInner() int32 {
        let inner = InnerPart()
        return inner.Piece() + 1
    }
}

shared class ClassDeclarationFixture {
    func Run() {
        let counter = PlainCounter()
        counter.Bump()
        counter.Bump()
        Console.WriteLine("ClassDeclaration: plain count=" + counter.Count().ToString())
        let badge = SealedBadge("gold")
        Console.WriteLine("ClassDeclaration: sealed label=" + badge.Label())
        let shape ShapeBase = SquareShape(4)
        Console.WriteLine(
            "ClassDeclaration: abstract area=" + shape.Area().ToString() + " doubled=" + shape.DoubledArea().ToString()
        )
        Console.WriteLine("ClassDeclaration: static triple=" + StaticMath.Triple(StaticMath.Base).ToString())
        let outer = OuterHolder()
        Console.WriteLine("ClassDeclaration: nested=" + outer.FromInner().ToString())
    }
}
