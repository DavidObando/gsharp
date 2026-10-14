// inventory: MemberBindingExpression

package Corpus.Grid02

import System

shared class MemberBindingExpressionFixture {
    func Run() {
        let word string? = "world"
        let nothing string? = nil
        let upper = word?.ToUpperInvariant() ?? "null"
        let absent = nothing?.ToUpperInvariant() ?? "null"
        Console.WriteLine("MemberBindingExpression: upper=$upper absent=$absent")
    }
}
