// inventory: NameOfExpression

package Corpus.Grid02

import System

shared class NameOfExpressionFixture {
    func Run() {
        let counter = 3
        let localName = "counter"
        let typeName = "Console"
        let methodName = "Run"
        Console.WriteLine("NameOfExpression: local=$localName type=$typeName method=$methodName value=$counter")
    }
}
