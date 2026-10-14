// inventory: ThrowStatement

package Corpus.Grid03.Constructs

import System

shared class ThrowStatementFixture {
    func Run() {
        try {
            throw ArgumentException("bad argument")
        } catch (ex ArgumentException) {
            Console.WriteLine("ThrowStatement: caught ${ex.Message}")
        }
        try {
            Validate(-1)
        } catch (ex InvalidOperationException) {
            Console.WriteLine("ThrowStatement: caught from helper: ${ex.Message}")
        }
        Validate(5)
        Console.WriteLine("ThrowStatement: Validate(5) did not throw")
    }

    private func Validate(value int32) {
        if value < 0 {
            throw InvalidOperationException("value must be non-negative")
        }
    }
}
