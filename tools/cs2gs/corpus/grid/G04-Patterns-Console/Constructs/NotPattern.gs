// inventory: NotPattern

package Corpus.Grid04.Constructs

import System

shared class NotPatternFixture {
    func Run() {
        let value object? = "abc"
        let notNull = value != nil
        Console.WriteLine("NotPattern: \"abc\" is not null = $notNull")
        let notInt = !(value is int32)
        Console.WriteLine("NotPattern: \"abc\" is not int = $notInt")
        let nothing object? = nil
        let nothingNotNull = nothing != nil
        Console.WriteLine("NotPattern: null is not null = $nothingNotNull")
        let seven = 7
        let notThirteen = seven != 13
        Console.WriteLine("NotPattern: 7 is not 13 = $notThirteen")
    }
}
