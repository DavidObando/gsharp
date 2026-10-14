// inventory: ExpressionColon

package Corpus.Grid04.Constructs

import System

internal data class EcPoint(X int32, Y int32) : IEquatable[EcPoint] { }

internal data class EcLine(Start EcPoint, End EcPoint) : IEquatable[EcLine] { }

shared class ExpressionColonFixture {
    func Run() {
        // Nullable-typed subject: the is-pattern lowering emits a `!= nil`
        // null check, which gsc only defines for nullable references.
        let line EcLine? = EcLine(EcPoint(0, 1), EcPoint(4, 5))
        let startsOnYAxis = line != nil && line.Start.X == 0
        Console.WriteLine("ExpressionColon: line starts on y-axis = $startsOnYAxis")
        let endsHigh = line != nil && line.End.Y > 4
        Console.WriteLine("ExpressionColon: line ends above 4 = $endsHigh")
        // Switch-expression subject uses a separately-declared non-nullable
        // value: G#'s property pattern (unlike the is-pattern lowering
        // above) requires a struct/class value, not a nullable reference.
        let solidLine = EcLine(EcPoint(0, 1), EcPoint(4, 5))
        let classification = switch solidLine {
            case {Start: {X: 0}, End: {Y: 5}}: "starts-on-axis-ends-at-5"
            case {Start: {X: > 0}}: "off-axis"
            default: "other"
        }
        Console.WriteLine("ExpressionColon: switch-arm classification = $classification")
    }
}
