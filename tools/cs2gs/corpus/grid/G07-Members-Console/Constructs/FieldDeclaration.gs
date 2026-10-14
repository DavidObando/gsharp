// inventory: FieldDeclaration — const, readonly, static, and instance fields

package Corpus.Grid07

import System

open class FieldHolder {
    private let _fixedSeed int32
    private var _mutable int32

    init(seed int32) {
        _fixedSeed = seed
        _mutable = 1
    }

    func Grow() {
        _mutable = _mutable + _fixedSeed
    }

    func Mutable() int32 {
        return _mutable
    }

    shared {
        const MaxSlots int32 = 64
        var SharedCount int32 = 5
    }
}

shared class FieldDeclarationFixture {
    func Run() {
        Console.WriteLine("FieldDeclaration: const=" + FieldHolder.MaxSlots.ToString())
        Console.WriteLine("FieldDeclaration: static=" + FieldHolder.SharedCount.ToString())
        FieldHolder.SharedCount = FieldHolder.SharedCount + 2
        Console.WriteLine("FieldDeclaration: static-bumped=" + FieldHolder.SharedCount.ToString())
        let holder = FieldHolder(10)
        holder.Grow()
        holder.Grow()
        Console.WriteLine("FieldDeclaration: mutable=" + holder.Mutable().ToString())
    }
}
