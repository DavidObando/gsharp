// inventory: EventDeclaration — explicit add/remove accessors on a custom event (probe)

package Corpus.Grid07

import System
import System.Collections.Generic

delegate MessageHandler(message string);

open class Broadcaster {
    private let _handlers List[MessageHandler] = List[MessageHandler]()

    event Message MessageHandler {
        add {
            _handlers.Add(value)
        }
        remove {
            _handlers.Remove(value)
        }
    }

    func Send(text string) {
        for handler in _handlers {
            handler(text)
        }
    }
}

shared class EventDeclarationFixture {
    func Run() {
        let broadcaster = Broadcaster()
        let printer MessageHandler = (message string) -> {
            Console.WriteLine("EventDeclaration: got=" + message)
        }
        broadcaster.Message += printer
        broadcaster.Send("first")
        broadcaster.Message -= printer
        broadcaster.Send("silent")
        Console.WriteLine("EventDeclaration: done")
    }
}
