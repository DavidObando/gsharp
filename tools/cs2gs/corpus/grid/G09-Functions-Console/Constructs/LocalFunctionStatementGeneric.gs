// inventory: LocalFunctionStatement
// Issue #1886: generic local functions (`T Echo<T>(T v)`) now translate to G#'s
// `let Echo[T] = func (value T) T { ... }` generic function-literal syntax.

package Corpus.Grid09

import System

shared class LocalFunctionStatementGenericFixture {
    func Run() {
        let Echo[T] = func (v T) T {
            return v
        }
        Console.WriteLine("LocalFunctionStatementGeneric: Echo(7)=${Echo(7)}")
        Console.WriteLine("LocalFunctionStatementGeneric: Echo(\"hi\")=${Echo("hi")}")
        // Local function used as a Func<> value.
        let Square = func (x int32) int32 {
            return x * x
        }
        let f(int32) -> int32 = Square
        Console.WriteLine("LocalFunctionStatementGeneric: asFunc=${f(6)}")
        // Local function with a captured parameterized helper shape.
        let offset = 100
        let Shift = func (x int32) int32 {
            return x + offset
        }
        Console.WriteLine("LocalFunctionStatementGeneric: shift=${Shift(1)}")
    }
}
