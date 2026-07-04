// inventory: ExpressionColon
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

            // Switch-expression subject uses a separately-declared non-nullable
            // value: G#'s property pattern (unlike the is-pattern lowering
            // above) requires a struct/class value, not a nullable reference.
            EcLine solidLine = new EcLine(new EcPoint(0, 1), new EcPoint(4, 5));
            string classification = solidLine switch
            {
                { Start.X: 0, End.Y: 5 } => "starts-on-axis-ends-at-5",
                { Start.X: > 0 } => "off-axis",
                _ => "other",
            };
            Console.WriteLine($"ExpressionColon: switch-arm classification = {classification}");
        }
    }
}
