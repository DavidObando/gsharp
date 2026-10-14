// inventory: SuppressNullableWarningExpression

package Corpus.Grid02

import System

shared class SuppressNullableWarningExpressionFixture {
    func Run() {
        let maybe string? = "present"
        let definite = maybe!!
        let len = definite.Length
        Console.WriteLine("SuppressNullableWarningExpression: value=$definite len=$len")
    }
}
