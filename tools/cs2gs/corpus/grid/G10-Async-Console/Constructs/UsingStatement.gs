// inventory: UsingStatement — await using over an IAsyncDisposable
// Both `await using` forms: the block statement and the local-declaration
// form. DisposeAsync returns an already-completed ValueTask and prints, so the
// open/inside/dispose ordering is the deterministic oracle.

package Corpus.Grid10.Constructs

import System
import System.Threading.Tasks

class AsyncResource : IAsyncDisposable {
    private let _name string

    init(name string) {
        _name = name
        Console.WriteLine("UsingStatement: opened $_name")
    }

    func DisposeAsync() ValueTask {
        Console.WriteLine("UsingStatement: disposed $_name")
        return ValueTask.CompletedTask
    }
}

shared class UsingStatementFixture {
    async func RunAsync() {
        {
            await using let outer = AsyncResource("outer")
            Console.WriteLine("UsingStatement: inside block form")
        }
        await using let declared = AsyncResource("declared")
        Console.WriteLine("UsingStatement: after declaration form")
    }
}
