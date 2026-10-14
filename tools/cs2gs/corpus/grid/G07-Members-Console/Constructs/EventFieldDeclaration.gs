// inventory: EventFieldDeclaration — field-like event, += subscribe, -= unsubscribe, raise (probe)

package Corpus.Grid07

import System

delegate TickHandler(count int32);

open class TickSource {
    event Ticked TickHandler

    func Tick(count int32) {
        if Ticked != nil {
            Ticked(count)
        }
    }
}

shared class EventFieldDeclarationFixture {
    func Run() {
        let source = TickSource()
        let listener TickHandler = (count int32) -> {
            Console.WriteLine("EventFieldDeclaration: tick=" + count.ToString())
        }
        source.Ticked += listener
        source.Tick(3)
        source.Ticked -= listener
        source.Tick(9)
        Console.WriteLine("EventFieldDeclaration: done")
    }
}
