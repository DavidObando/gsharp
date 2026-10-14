// inventory: PointerMemberAccessExpression — p->Field on a struct pointer (probe)
// Writes and reads struct fields through a pointer with `->`; also covers a
// method call through `->`, `->` as an assignment target, and a chained
// deref-then-arrow read through a pointer-to-pointer (issue #1905).

package Corpus.Grid12.Constructs

import System

internal struct PmaPoint {
    var X int32
    var Y int32

    func Sum() int32 {
        return X + Y
    }
}

shared class PointerMemberAccessExpressionFixture {
    func Run() {
        unsafe {
            var pt PmaPoint
            pt.X = 1
            pt.Y = 2
            var p = &pt
            p -> X = 10
            let x = p -> X
            let y = p -> Y
            let sum = p -> Sum()
            Console.WriteLine("PointerMemberAccessExpression: X=$x Y=$y Sum=$sum")
            let pp = &p
            let chained = (*pp) -> X
            Console.WriteLine("PointerMemberAccessExpression-Chained: X=$chained")
        }
    }
}
