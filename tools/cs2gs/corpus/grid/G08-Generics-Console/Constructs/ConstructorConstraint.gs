// inventory: ConstructorConstraint — where T : new() with new T() construction (probe; past gap #988)

package Corpus.Grid08

import System

open class BlankSlate {
    private var _marks int32

    func Mark() {
        _marks = _marks + 1
    }

    func Marks() int32 {
        return _marks
    }
}

shared class FreshMaker {
    func Make[T init()]() T {
        return T()
    }
}

shared class ConstructorConstraintFixture {
    func Run() {
        let slate = FreshMaker.Make[BlankSlate]()
        slate.Mark()
        slate.Mark()
        slate.Mark()
        Console.WriteLine("ConstructorConstraint: marks=" + slate.Marks().ToString())
    }
}
