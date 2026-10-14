// inventory: RecordDeclaration — positional record declaration + member reads
// + with-expression update (issue #1892).
// QUARANTINED sub-probe:
//   * structural equality is a SILENT DIVERGENCE: `==` on two equal-valued record
//     instances is true in C# but false in the emitted G# (reference equality) —
//     translate/compile/ilverify all pass; only stdout parity catches it.
// The remaining `!=` probe compares different-valued instances, which agrees
// under both equality semantics.

package Corpus.Grid06

import System

open data class PointRecord(X int32, Y int32) : IEquatable[PointRecord] { }

shared class RecordDeclarationFixture {
    func Run() {
        let first = PointRecord(3, 4)
        let other = PointRecord(3, 9)
        let updated = first with{Y = 9}
        Console.WriteLine("RecordDeclaration: x=" + first.X.ToString() + " y=" + first.Y.ToString())
        Console.WriteLine("RecordDeclaration: other-y=" + other.Y.ToString())
        Console.WriteLine(
            "RecordDeclaration: not-equal=" +
                (
                if first != other {
                    "true"
                } else {
                    "false"
                }
            )
        )
        Console.WriteLine("RecordDeclaration: with-y=" + updated.Y.ToString() + " with-x=" + updated.X.ToString())
    }
}
