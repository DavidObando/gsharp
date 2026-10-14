// inventory: RecordStructDeclaration — readonly record struct, value equality
// QUARANTINED sub-probe: with-expression (same stray-statement lowering bug as
// RecordDeclaration: GS0125 on the emitted bare `Width = 8` line).

package Corpus.Grid06

import System

data struct SizeRecord(Width int32, Height int32) : IEquatable[SizeRecord] { }

shared class RecordStructDeclarationFixture {
    func Run() {
        let small = SizeRecord(2, 3)
        let copy = SizeRecord(2, 3)
        let wide = SizeRecord(8, 3)
        Console.WriteLine("RecordStructDeclaration: w=" + small.Width.ToString() + " h=" + small.Height.ToString())
        Console.WriteLine("RecordStructDeclaration: wide-w=" + wide.Width.ToString())
        Console.WriteLine(
            "RecordStructDeclaration: equal=" +
                (
                if small == copy {
                    "true"
                } else {
                    "false"
                }
            )
        )
        Console.WriteLine(
            "RecordStructDeclaration: not-equal=" +
                (
                if small != wide {
                    "true"
                } else {
                    "false"
                }
            )
        )
    }
}
