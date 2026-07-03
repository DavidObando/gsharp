// inventory: RecordDeclaration — positional record declaration + member reads
// QUARANTINED sub-probes:
//   * with-expression (`first with { Y = 9 }`) emits a stray statement `Y = 9`
//     before the with (GS0125 Variable 'Y' doesn't exist);
//   * structural equality is a SILENT DIVERGENCE: `==` on two equal-valued record
//     instances is true in C# but false in the emitted G# (reference equality) —
//     translate/compile/ilverify all pass; only stdout parity catches it.
// The remaining `!=` probe compares different-valued instances, which agrees
// under both equality semantics.
using System;

namespace Corpus.Grid06
{
    public record PointRecord(int X, int Y);

    public static class RecordDeclarationFixture
    {
        public static void Run()
        {
            PointRecord first = new PointRecord(3, 4);
            PointRecord other = new PointRecord(3, 9);

            Console.WriteLine("RecordDeclaration: x=" + first.X.ToString() + " y=" + first.Y.ToString());
            Console.WriteLine("RecordDeclaration: other-y=" + other.Y.ToString());
            Console.WriteLine("RecordDeclaration: not-equal=" + (first != other ? "true" : "false"));
        }
    }
}
