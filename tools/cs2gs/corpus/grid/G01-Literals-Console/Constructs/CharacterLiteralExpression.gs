// inventory: CharacterLiteralExpression

package Corpus.Grid01

import System

shared class CharacterLiteralExpressionFixture {
    func Run() {
        let letter = 'A'
        let newline = '\n'
        let tab = '\t'
        let backslash = '\\'
        let quote = '\''
        let unicode = 'B'
        let hexEscape = 'C'
        Console.WriteLine("CharacterLiteralExpression: letter=$letter unicode=$unicode hexEscape=$hexEscape")
        Console.WriteLine("CharacterLiteralExpression: newlineCode=${int32(newline)} tabCode=${int32(tab)}")
        Console.WriteLine("CharacterLiteralExpression: backslash=$backslash quote=$quote")
    }
}
