// inventory: ThisConstructorInitializer — constructor chaining : this(...)

package Corpus.Grid07

import System

open class Portion {
    private let _grams int32
    private let _unit string

    convenience init() {
        init(100)
    }

    convenience init(grams int32) {
        init(grams, "g")
    }

    init(grams int32, unit string) {
        _grams = grams
        _unit = unit
    }

    func Describe() string {
        return _grams.ToString() + _unit
    }
}

shared class ThisConstructorInitializerFixture {
    func Run() {
        Console.WriteLine("ThisConstructorInitializer: default=" + Portion().Describe())
        Console.WriteLine("ThisConstructorInitializer: single=" + Portion(250).Describe())
        Console.WriteLine("ThisConstructorInitializer: full=" + Portion(2, "kg").Describe())
    }
}
