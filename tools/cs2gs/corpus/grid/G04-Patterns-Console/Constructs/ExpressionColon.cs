// inventory: ExpressionColon
// NOTE: quarantined sub-case: an extended property pattern used in a
// switch-expression arm (`{ Start.X: 0, End.Y: 5 } => ...`) fails stage 1 with
// CS2GS-GAP "positional subpattern has no canonical G# form yet (ADR-0115 §B)".
// The is-pattern form below is kept.
using System;

namespace Corpus.Grid04.Constructs
{
    internal sealed record EcPoint(int X, int Y);

    internal sealed record EcLine(EcPoint Start, EcPoint End);

    public static class ExpressionColonFixture
    {
        public static void Run()
        {
            // Nullable-typed subject: the is-pattern lowering emits a `!= nil`
            // null check, which gsc only defines for nullable references.
            EcLine? line = new EcLine(new EcPoint(0, 1), new EcPoint(4, 5));

            bool startsOnYAxis = line is { Start.X: 0 };
            Console.WriteLine($"ExpressionColon: line starts on y-axis = {startsOnYAxis}");

            bool endsHigh = line is { End.Y: > 4 };
            Console.WriteLine($"ExpressionColon: line ends above 4 = {endsHigh}");
        }
    }
}
