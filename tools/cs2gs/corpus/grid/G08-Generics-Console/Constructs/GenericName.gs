// inventory: GenericName — constructed generic types + generic method called with explicit type arguments

package Corpus.Grid08

import System
import System.Collections.Generic

shared class Echoes {
    func TypeTag[T](value T) string {
        return "tagged:" + value.ToString()
    }

    func Pick[T](first T, second T, takeFirst bool) T {
        return if takeFirst {
            first
        } else {
            second
        }
    }
}

shared class GenericNameFixture {
    func Run() {
        let numbers = List[int32]()
        numbers.Add(4)
        numbers.Add(9)
        Console.WriteLine("GenericName: list-count=" + numbers.Count.ToString())
        Console.WriteLine("GenericName: explicit=" + Echoes.Pick[int32](7, 8, true).ToString())
        Console.WriteLine("GenericName: inferred=" + Echoes.TypeTag(11))
        Console.WriteLine("GenericName: explicit-string=" + Echoes.Pick[string]("a", "b", false))
    }
}
