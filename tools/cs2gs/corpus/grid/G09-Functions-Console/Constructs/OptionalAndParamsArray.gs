// inventory: Parameter

package Corpus.Grid09

import System

shared class OptionalAndParamsArrayFixture {
    func Run() {
        Console.WriteLine("OptionalAndParamsArray: defaults=${Greet("Ada")}")
        Console.WriteLine("OptionalAndParamsArray: oneOverride=${Greet("Bea", "Yo")}")
        Console.WriteLine("OptionalAndParamsArray: namedSkip=${Greet("Cid", times: 2)}")
        Console.WriteLine("OptionalAndParamsArray: sumNone=${Sum()}")
        Console.WriteLine("OptionalAndParamsArray: sumThree=${Sum(1, 2, 3)}")
        Console.WriteLine("OptionalAndParamsArray: sumArray=${Sum([]int32{4, 5})}")
    }

    private func Greet(name string, greeting string = "Hello", times int32 = 1) string {
        return "$greeting $name x$times"
    }

    private func Sum(values ...int32) int32 {
        var total = 0
        for v in values {
            total += v
        }
        return total
    }
}
