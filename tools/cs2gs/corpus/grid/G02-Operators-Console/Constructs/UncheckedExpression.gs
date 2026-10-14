// inventory: UncheckedExpression

package Corpus.Grid02

import System

shared class UncheckedExpressionFixture {
    func Run() {
        let max = int32.MaxValue
        let one = 1
        let wrapped = unchecked(max + one)
        Console.WriteLine("UncheckedExpression: wrapped=$wrapped")
        let maxU = uint32.MaxValue
        let oneU uint32 = uint32(1)
        let wrappedU = unchecked(maxU + oneU)
        Console.WriteLine("UncheckedExpression: wrappedU=$wrappedU")
        let narrowed = unchecked(uint8(300))
        Console.WriteLine("UncheckedExpression: narrowed=$narrowed")
    }
}
