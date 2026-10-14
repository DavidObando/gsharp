// inventory: NullLiteralExpression

package Corpus.Grid01

import System

shared class NullLiteralExpressionFixture {
    func Run() {
        var missing string? = nil
        let nothing object? = nil
        let isNull = missing == nil
        let shown = missing ?? "null"
        Console.WriteLine("NullLiteralExpression: isNull=$isNull shown=$shown")
        Console.WriteLine("NullLiteralExpression: objectIsNull=${nothing == nil}")
        missing = "assigned"
        Console.WriteLine("NullLiteralExpression: afterAssign=$missing")
    }
}
