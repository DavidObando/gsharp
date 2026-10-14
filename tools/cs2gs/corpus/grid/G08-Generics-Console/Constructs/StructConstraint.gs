// inventory: StructConstraint — where T : struct
// Issue #1920 (fixed): previously the `_tag = seed + 2` transform was needed to
// dodge the generic-primary-ctor gsc ICE (GS9998, see ClassConstraint.cs). Kept
// as a trivial passthrough ctor now that the fix lands, exercising the same
// primary-ctor path for a `struct` constraint.

package Corpus.Grid08

import System

class ValueCell[T struct] {
    private let _value T
    private let _tag int32

    init(value T, seed int32) {
        _value = value
        _tag = seed
    }

    func Value() T {
        return _value
    }

    func Tag() int32 {
        return _tag
    }
}

shared class StructConstraintFixture {
    func Run() {
        let cell = ValueCell[int32](64, 0)
        Console.WriteLine("StructConstraint: int=" + cell.Value().ToString())
        Console.WriteLine("StructConstraint: tag=" + cell.Tag().ToString())
    }
}
