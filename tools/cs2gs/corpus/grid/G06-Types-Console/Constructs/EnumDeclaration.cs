// inventory: EnumDeclaration — enum with implicit member values
// QUARANTINED sub-probes (SILENT DIVERGENCE, caught only by stdout parity):
//   * explicit member values (`Banana = 2`) are dropped by the translator — members
//     are re-numbered sequentially (expected 'banana=2', got 'banana=1');
//   * `[Flags]` and a member combining members (`ReadWrite = Read | Write`) are
//     likewise erased to plain ordinals.
// See also Quarantined/EnumMemberDeclaration.cs.txt.
using System;

namespace Corpus.Grid06
{
    public enum Fruit
    {
        Apple,
        Banana,
        Cherry,
    }

    public enum Direction
    {
        North,
        East,
        South,
        West,
    }

    public static class EnumDeclarationFixture
    {
        public static void Run()
        {
            Fruit picked = Fruit.Banana;
            Console.WriteLine("EnumDeclaration: banana=" + ((int)picked).ToString());
            Console.WriteLine("EnumDeclaration: cherry=" + ((int)Fruit.Cherry).ToString());
            Console.WriteLine("EnumDeclaration: west=" + ((int)Direction.West).ToString());
            Console.WriteLine("EnumDeclaration: picked-is-banana=" + (picked == Fruit.Banana ? "true" : "false"));
            Console.WriteLine("EnumDeclaration: banana-not-cherry=" + (picked != Fruit.Cherry ? "true" : "false"));
        }
    }
}
