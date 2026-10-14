// inventory: UsingDirective — type alias (using X = ...), incl. C#12
// alias-any-type tuple alias (issue #1914).

package Corpus.Grid06

import Count = System.Int32
import System

shared class TypeAliasDeclarationFixture {
    func AddOne(value int32) int32 {
        return value + 1
    }

    func MakePair(seed(Number int32, Word string))(Number int32, Word string) {
        return (seed.Number + 1, seed.Word + "!")
    }

    func Run() {
        let start = 41
        Console.WriteLine("TypeAliasDeclaration: count=" + AddOne(start).ToString())
        let pair(Number int32, Word string) = (1, "hi")
        let made = MakePair(pair)
        Console.WriteLine("TypeAliasDeclaration: pair=" + made.Number.ToString() + "," + made.Word)
    }
}
