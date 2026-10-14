// inventory: EnumDeclaration — enum with implicit member values
// QUARANTINED sub-probes (SILENT DIVERGENCE, caught only by stdout parity):
//   * explicit member values (`Banana = 2`) are dropped by the translator — members
//     are re-numbered sequentially (expected 'banana=2', got 'banana=1');
//   * `[Flags]` and a member combining members (`ReadWrite = Read | Write`) are
//     likewise erased to plain ordinals.
// See also Quarantined/EnumMemberDeclaration.cs.txt.

package Corpus.Grid06

import System

enum Fruit {
    Apple,
    Banana,
    Cherry
}

enum Direction {
    North,
    East,
    South,
    West
}

shared class EnumDeclarationFixture {
    func Run() {
        let picked = Fruit.Banana
        Console.WriteLine("EnumDeclaration: banana=" + (int32(picked)).ToString())
        Console.WriteLine("EnumDeclaration: cherry=" + (int32(Fruit.Cherry)).ToString())
        Console.WriteLine("EnumDeclaration: west=" + (int32(Direction.West)).ToString())
        Console.WriteLine(
            "EnumDeclaration: picked-is-banana=" +
                (
                if picked == Fruit.Banana {
                    "true"
                } else {
                    "false"
                }
            )
        )
        Console.WriteLine(
            "EnumDeclaration: banana-not-cherry=" +
                (
                if picked != Fruit.Cherry {
                    "true"
                } else {
                    "false"
                }
            )
        )
    }
}
