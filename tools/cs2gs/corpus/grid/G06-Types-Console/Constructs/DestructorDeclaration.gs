// inventory: DestructorDeclaration — finalizer declared (probe); parity output printed from Run, never from the finalizer

package Corpus.Grid06

import System

open class EphemeralResource {
    private let _id int32

    init(id int32) {
        _id = id
    }

    func Id() int32 {
        return _id
    }

    deinit {
        // Deliberately empty: finalizer timing is nondeterministic, so it
        // must not write to stdout. The declaration itself is the probe.

    }
}

shared class DestructorDeclarationFixture {
    func Run() {
        let resource = EphemeralResource(7)
        Console.WriteLine("DestructorDeclaration: declared, id=" + resource.Id().ToString())
    }
}
