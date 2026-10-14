// inventory: IdentifierName

package Corpus.Grid09

import System
import System.Linq

shared class MethodGroupConversionFixture {
    private class Tally {
        private var _total int32

        func Bump(by int32) int32 {
            _total += by
            return _total
        }
    }

    func Run() {
        // Method group to Func<>.
        let f(int32) -> int32 = Twice
        Console.WriteLine("MethodGroupConversion: func=${f(21)}")
        // Method group to Action<>.
        let a(string) -> void = Emit
        a("action")
        // Method group passed straight to LINQ.
        let doubled = []int32{1, 2, 3}.Select(Twice)
        Console.WriteLine("MethodGroupConversion: linq=${string.Join(",", doubled)}")
        // Instance method group.
        let counter = Tally()
        let g(int32) -> int32 = counter.Bump
        Console.WriteLine("MethodGroupConversion: instance=${g(5)},${g(5)}")
    }

    private func Twice(x int32) int32 {
        return x * 2
    }

    private func Emit(s string) {
        Console.WriteLine("MethodGroupConversion: emit $s")
    }
}
