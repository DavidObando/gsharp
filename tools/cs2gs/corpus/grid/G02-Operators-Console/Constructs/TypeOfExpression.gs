// inventory: TypeOfExpression

package Corpus.Grid02

import System

shared class TypeOfExpressionFixture {
    func Run() {
        let intName = typeof(int32).Name
        let stringName = typeof(string).Name
        let doubleFull = typeof(float64).FullName ?? "?"
        Console.WriteLine("TypeOfExpression: int=$intName string=$stringName double=$doubleFull")
    }
}
