// inventory: ConstructorDeclaration — overloaded constructors

package Corpus.Grid07

import System

open class Ticket {
    private let _owner string
    private let _seat int32

    init() {
        _owner = "unassigned"
        _seat = 0
    }

    init(owner string, seat int32) {
        _owner = owner
        _seat = seat
    }

    func Describe() string {
        return _owner + "@" + _seat.ToString()
    }
}

shared class ConstructorDeclarationFixture {
    func Run() {
        let blank = Ticket()
        let assigned = Ticket("kim", 12)
        Console.WriteLine("ConstructorDeclaration: blank=" + blank.Describe())
        Console.WriteLine("ConstructorDeclaration: assigned=" + assigned.Describe())
    }
}
