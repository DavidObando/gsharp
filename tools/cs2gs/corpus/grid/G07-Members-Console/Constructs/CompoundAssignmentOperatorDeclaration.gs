// inventory: OperatorDeclaration — C#14 user-defined instance compound assignment
// operator +=. gsc issue #2834 gave this a canonical G# spelling as an ordinary
// in-body member (`public func operator +=(amount int32) { ... }`), which emits
// the same instance, void-returning, specialname `op_AdditionAssignment` method
// Roslyn produces, so the construct round-trips end to end (translate, compile,
// ilverify, stdout parity) instead of being a tracked CS2GS-GAP.

package Corpus.Grid07

import System

open class TallyBag {
    private var _total int32

    init(start int32) {
        _total = start
    }

    func operator += (amount int32) {
        _total = _total + amount
    }

    func Total() int32 {
        return _total
    }
}

shared class CompoundAssignmentOperatorDeclarationFixture {
    func Run() {
        var bag = TallyBag(10)
        bag += 5
        bag += 7
        Console.WriteLine("CompoundAssignmentOperatorDeclaration: total=" + bag.Total().ToString())
    }
}
