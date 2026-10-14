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

package Corpus.Grid04.Constructs

import System

internal data class PpPoint(X int32, Y int32) : IEquatable[PpPoint] { }

internal data class PpLine(Start PpPoint, End PpPoint) : IEquatable[PpLine] { }

shared class PositionalPatternClauseFixture {
    func Run() {
        let origin = (0, 0)
        let onYAxis = (0, 4)
        Console.WriteLine("PositionalPatternClause: origin is (0, 0) = ${origin.Item1 == 0 && origin.Item2 == 0}")
        Console.WriteLine("PositionalPatternClause: onYAxis is (0, 0) = ${onYAxis.Item1 == 0 && onYAxis.Item2 == 0}")
        let recordOrigin PpPoint? = PpPoint(0, 0)
        let recordPoint PpPoint? = PpPoint(3, 4)
        Console.WriteLine(
            "PositionalPatternClause: recordOrigin is (0, 0) = ${recordOrigin != nil && recordOrigin.X == 0 && recordOrigin.Y == 0}"
        )
        Console.WriteLine(
            "PositionalPatternClause: recordOrigin is PpPoint(0, 0) = ${recordOrigin is PpPoint && recordOrigin.X == 0 && recordOrigin.Y == 0}"
        )
        Console.WriteLine(
            "PositionalPatternClause: recordPoint is (0, 0) = ${recordPoint != nil && recordPoint.X == 0 && recordPoint.Y == 0}"
        )
        let triple = (0, 0, 5)
        let tripleMatch = triple.Item1 == 0 && triple.Item2 == 0 && triple.Item3 == 5
        Console.WriteLine("PositionalPatternClause: $triple is (0, 0, 5) = $tripleMatch")
        let points[]PpPoint = []PpPoint{PpPoint(0, 0), PpPoint(0, 4), PpPoint(3, 4)}
        for p in points {
            let quadrant = switch p {
                case {X: 0, Y: 0}: "origin"
                case {X: 0}: "y-axis"
                case {Y: 0}: "x-axis"
                case {X: > 0, Y: > 0}: "ne"
                default: "other"
            }
            Console.WriteLine("PositionalPatternClause: (${p.X}, ${p.Y}) -> $quadrant")
        }
        let tuplePoints[](int32, int32) = [](int32, int32){(0, 0), (0, 4), (3, 0), (3, 4)}
        for tp in tuplePoints {
            let tupleQuadrant = switch tp {
                case {Item1: 0, Item2: 0}: "origin"
                case {Item1: 0}: "y-axis"
                case {Item2: 0}: "x-axis"
                case {Item1: > 0, Item2: > 0}: "ne"
                default: "other"
            }
            Console.WriteLine("PositionalPatternClause: (${tp.Item1}, ${tp.Item2}) tuple-> $tupleQuadrant")
        }
        // Issue #1943: a TYPED recursive arm's positional subpattern —
        // constant, relational, and nested — previously accepted only
        // `var` (anything else was a loud gap).
        let typedSubjects[]object = []object{PpPoint(0, 0), PpPoint(3, 0), PpPoint(3, 4)}
        for subject in typedSubjects {
            let typedQuadrant = switch subject {
                case ppPoint is PpPoint when ppPoint.X == 0 && ppPoint.Y == 0: "typed-origin"
                case ppPoint is PpPoint when ppPoint.X > 0 && ppPoint.Y == 0: "typed-x-axis"
                case ppPoint is PpPoint when ppPoint.X > 0 && ppPoint.Y > 0: "typed-ne"
                default: "typed-other"
            }
            if subject is PpPoint typedPoint {
                Console.WriteLine("PositionalPatternClause: typed (${typedPoint.X}, ${typedPoint.Y}) -> $typedQuadrant")
            }
        }
        let originLine = PpLine(PpPoint(0, 0), PpPoint(3, 4))
        let otherLine = PpLine(PpPoint(1, 1), PpPoint(3, 4))
        for line in[]PpLine{originLine, otherLine} {
            let lineDescription = switch line {
                case ppLine is PpLine when ppLine.Start is PpPoint &&
                    ppLine
                    .Start
                    .X == 0 &&
                    ppLine
                    .Start
                    .Y == 0: "starts-at-origin"
                default: "other-start"
            }
            Console.WriteLine(
                "PositionalPatternClause: line (${line.Start.X}, ${line.Start.Y})->(${line.End.X}, ${line.End.Y}) -> $lineDescription"
            )
        }
    }
}
