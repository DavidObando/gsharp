// inventory: PositionalPatternClause
// NOTE: quarantined sub-case: a `switch` EXPRESSION arm's bare positional
// pattern (`(0, 0) => ...`) lowers to a G# property pattern (`case { Item1: 0,
// Item2: 0 }`), and gsc's property-pattern matcher only accepts a struct or
// class value there — not a tuple (GS0172: "Property pattern requires a
// struct or class value, not '(int32, int32)'"). Same gsc-side limitation as
// the RecursivePattern.cs fixture's already-quarantined nullable-subject
// case; kept below is the switch-expression positional-pattern arm form over
// a record (a class value, so gsc's matcher accepts it) instead of a tuple.
// The `is`-expression positional-pattern form (a boolean lowering, not a gsc
// property pattern) is unaffected and IS exercised below over a bare tuple.
using System;

namespace Corpus.Grid04.Constructs
{
    internal sealed record PpPoint(int X, int Y);

    public static class PositionalPatternClauseFixture
    {
        public static void Run()
        {
            (int, int) origin = (0, 0);
            (int, int) onYAxis = (0, 4);

            Console.WriteLine($"PositionalPatternClause: origin is (0, 0) = {origin is (0, 0)}");
            Console.WriteLine($"PositionalPatternClause: onYAxis is (0, 0) = {onYAxis is (0, 0)}");

            PpPoint? recordOrigin = new PpPoint(0, 0);
            PpPoint? recordPoint = new PpPoint(3, 4);

            Console.WriteLine($"PositionalPatternClause: recordOrigin is (0, 0) = {recordOrigin is (0, 0)}");
            Console.WriteLine($"PositionalPatternClause: recordOrigin is PpPoint(0, 0) = {recordOrigin is PpPoint(0, 0)}");
            Console.WriteLine($"PositionalPatternClause: recordPoint is (0, 0) = {recordPoint is (0, 0)}");

            (int, int, int) triple = (0, 0, 5);
            bool tripleMatch = triple is (0, 0, 5);
            Console.WriteLine($"PositionalPatternClause: {triple} is (0, 0, 5) = {tripleMatch}");

            PpPoint[] points = { new PpPoint(0, 0), new PpPoint(0, 4), new PpPoint(3, 4) };
            foreach (PpPoint p in points)
            {
                string quadrant = p switch
                {
                    (0, 0) => "origin",
                    (0, _) => "y-axis",
                    (_, 0) => "x-axis",
                    ( > 0, > 0) => "ne",
                    _ => "other",
                };
                Console.WriteLine($"PositionalPatternClause: ({p.X}, {p.Y}) -> {quadrant}");
            }
        }
    }
}
