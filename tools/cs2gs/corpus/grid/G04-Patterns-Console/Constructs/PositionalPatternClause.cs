// inventory: PositionalPatternClause
// Issue #1887: a `switch` EXPRESSION arm's bare positional pattern over a raw
// TUPLE (`(0, 0) => ...`) lowers to a G# property pattern (`case { Item1: 0,
// Item2: 0 }`); gsc's property-pattern matcher now accepts a ValueTuple
// subject (previously GS0172). Both the record and raw-tuple switch-expression
// forms — plus the `is`-expression boolean form — are exercised below.
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

            (int, int)[] tuplePoints = { (0, 0), (0, 4), (3, 0), (3, 4) };
            foreach ((int, int) tp in tuplePoints)
            {
                string tupleQuadrant = tp switch
                {
                    (0, 0) => "origin",
                    (0, _) => "y-axis",
                    (_, 0) => "x-axis",
                    ( > 0, > 0) => "ne",
                    _ => "other",
                };
                Console.WriteLine($"PositionalPatternClause: ({tp.Item1}, {tp.Item2}) tuple-> {tupleQuadrant}");
            }
        }
    }
}
