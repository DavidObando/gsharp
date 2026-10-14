// inventory: LocalFunctionStatement
// Plain, captured, static, and generic local functions are all exercised below
// (issue #1886: static local functions now call through their `let` binding
// directly instead of a nonexistent class-member access, and generic local
// functions translate to G#'s `let Name[T, ...] = func (...) ... { ... }`).

package Corpus.Grid03.Constructs

import System

shared class LocalFunctionStatementFixture {
    func Run() {
        let Add = func (a int32, b int32) int32 {
            return a + b
        }
        Console.WriteLine("LocalFunctionStatement: Add(3, 4) = ${Add(3, 4)}")
        let seed = 5
        let AddSeed = func (x int32) int32 {
            return x + seed
        }
        Console.WriteLine("LocalFunctionStatement: AddSeed(7) with captured seed = ${AddSeed(7)}")
        let Square = func (x int32) int32 {
            return x * x
        }
        Console.WriteLine("LocalFunctionStatement: Square(6) = ${Square(6)}")
        let First[T] = func (a T, b T) T {
            return a
        }
        Console.WriteLine("LocalFunctionStatement: First(1, 2) = ${First(1, 2)}")
        Console.WriteLine("LocalFunctionStatement: First(\"x\", \"y\") = ${First("x", "y")}")
    }
}
