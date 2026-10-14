// inventory: DeclarationPattern

package Corpus.Grid04.Constructs

import System

shared class DeclarationPatternFixture {
    func Run() {
        let payload object = "gsharp"
        if payload is string text {
            Console.WriteLine("DeclarationPattern: string binder saw length ${text.Length}")
        }
        let number object = 12
        if number is int32 n && n > 10 {
            Console.WriteLine("DeclarationPattern: int binder saw $n (> 10)")
        }
        if payload is int32 wrong {
            Console.WriteLine("DeclarationPattern: unexpected int $wrong")
        } else {
            Console.WriteLine("DeclarationPattern: string payload is not an int")
        }
    }
}
