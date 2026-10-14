// inventory: EmptyStatement

package Corpus.Grid03.Constructs

import System

shared class EmptyStatementFixture {
    func Run() {
        var counter = 0
        counter++
        Console.WriteLine("EmptyStatement: counter after stray semicolons = $counter")
        var spins int32
        for spins = 0; spins < 3; spins++ { }
        Console.WriteLine("EmptyStatement: loop with empty body spun to $spins")
    }
}
