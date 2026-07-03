// inventory: RecordStructDeclaration — readonly record struct, value equality
// QUARANTINED sub-probe: with-expression (same stray-statement lowering bug as
// RecordDeclaration: GS0125 on the emitted bare `Width = 8` line).
using System;

namespace Corpus.Grid06
{
    public readonly record struct SizeRecord(int Width, int Height);

    public static class RecordStructDeclarationFixture
    {
        public static void Run()
        {
            SizeRecord small = new SizeRecord(2, 3);
            SizeRecord copy = new SizeRecord(2, 3);
            SizeRecord wide = new SizeRecord(8, 3);

            Console.WriteLine("RecordStructDeclaration: w=" + small.Width.ToString() + " h=" + small.Height.ToString());
            Console.WriteLine("RecordStructDeclaration: wide-w=" + wide.Width.ToString());
            Console.WriteLine("RecordStructDeclaration: equal=" + (small == copy ? "true" : "false"));
            Console.WriteLine("RecordStructDeclaration: not-equal=" + (small != wide ? "true" : "false"));
        }
    }
}
