// inventory: ClassConstraint — where T : class
// Issue #1920 (fixed): a ctor that only does once-only parameter assignments
// is lowered to a G# primary ctor. Previously, instantiating a GENERIC
// primary-ctor class from inside another class's static/instance method ICEd
// gsc (GS9998 "Type 'RefKeeper' has no emitted primary ctor.") because the
// ctor MemberRef lookup was keyed off the constructed StructSymbol instead of
// its open definition. Kept as a trivial passthrough ctor (no transform) to
// exercise the primary-ctor emission path directly.

package Corpus.Grid08

import System

class RefKeeper[T class] {
    private let _kept T
    private let _tag int32

    init(kept T, seed int32) {
        _kept = kept
        _tag = seed
    }

    func Kept() T {
        return _kept
    }

    func Tag() int32 {
        return _tag
    }
}

shared class ClassConstraintFixture {
    func Run() {
        let keeper = RefKeeper[string]("pinned", 0)
        Console.WriteLine("ClassConstraint: kept=" + keeper.Kept())
        Console.WriteLine("ClassConstraint: tag=" + keeper.Tag().ToString())
    }
}
