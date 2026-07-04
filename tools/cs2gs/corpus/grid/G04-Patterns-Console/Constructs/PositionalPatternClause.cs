// inventory: PositionalPatternClause
// Issue #1887: a `switch` EXPRESSION arm's bare positional pattern over a raw
// TUPLE (`(0, 0) => ...`) lowers to a G# property pattern (`case { Item1: 0,
// Item2: 0 }`); gsc's property-pattern matcher now accepts a ValueTuple
// subject (previously GS0172). Both the record and raw-tuple switch-expression
// forms — plus the `is`-expression boolean form — are exercised below.
//
// Issue #1943 (follow-up): a TYPED recursive positional arm (`Point(0, 0) =>
// ...`) lowers to a G# `TypePattern` node, which has no room for an extra
// equality/relational test — previously only a `var` positional subpattern
// was accepted there, and anything else emitted a loud CS2GS-GAP. Constant,
// relational, and nested positional subpatterns in that position now
// generalize the untyped-arm lowering above by synthesizing a `when` guard
// (`case point is Point when point.X == 0 && point.Y == 0:`).
//
// A companion null-guard fix (also #1943) makes a nullable value-type tuple
// subject (`(int, int)? is (0, 0)`) keep its `!= nil` guard — verified at the
// translator-unit level in Issue1943TypedPositionalSubpatternTests.cs. It is
// NOT exercised in this end-to-end corpus fixture: writing a nullable
// value-type tuple (`(int, int)?`) at all trips an unrelated, pre-existing
// gsc IL-emission bug (implicit `T -> Nullable<T>` wrapping is dropped for
// ValueTuple value types at the boundary of ANY conversion — reproduced with
// a plain `var p (int, int)? = (0, 0)`, no pattern matching involved) that
// fails ilverify with StackUnexpected. That gap is out of scope for #1943
// and is tracked separately as issue #2051.
using System;

namespace Corpus.Grid04.Constructs
{
    internal sealed record PpPoint(int X, int Y);

    internal sealed record PpLine(PpPoint Start, PpPoint End);

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

            // Issue #1943: a TYPED recursive arm's positional subpattern —
            // constant, relational, and nested — previously accepted only
            // `var` (anything else was a loud gap).
            object[] typedSubjects = { new PpPoint(0, 0), new PpPoint(3, 0), new PpPoint(3, 4) };
            foreach (object subject in typedSubjects)
            {
                string typedQuadrant = subject switch
                {
                    PpPoint(0, 0) => "typed-origin",
                    PpPoint( > 0, 0) => "typed-x-axis",
                    PpPoint( > 0, > 0) => "typed-ne",
                    _ => "typed-other",
                };
                if (subject is PpPoint typedPoint)
                {
                    Console.WriteLine($"PositionalPatternClause: typed ({typedPoint.X}, {typedPoint.Y}) -> {typedQuadrant}");
                }
            }

            PpLine originLine = new PpLine(new PpPoint(0, 0), new PpPoint(3, 4));
            PpLine otherLine = new PpLine(new PpPoint(1, 1), new PpPoint(3, 4));
            foreach (PpLine line in new[] { originLine, otherLine })
            {
                string lineDescription = line switch
                {
                    PpLine(PpPoint(0, 0), _) => "starts-at-origin",
                    _ => "other-start",
                };
                Console.WriteLine($"PositionalPatternClause: line ({line.Start.X}, {line.Start.Y})->({line.End.X}, {line.End.Y}) -> {lineDescription}");
            }
        }
    }
}
