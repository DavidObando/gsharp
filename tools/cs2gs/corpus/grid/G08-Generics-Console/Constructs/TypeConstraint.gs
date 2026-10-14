// inventory: TypeConstraint — where T : BaseClass and where T : IInterface

package Corpus.Grid08

import System

open class Creature {
    open func Sound() string {
        return "..."
    }
}

open class Frog : Creature {
    open override func Sound() string {
        return "ribbit"
    }
}

interface INamed {
    func Name() string;
}

open class NamedFrog : Frog, INamed {
    func Name() string {
        return "kermit"
    }
}

shared class ConstraintCalls {
    func Hear[T Creature](creature T) string {
        return creature.Sound()
    }

    func Call[T INamed](named T) string {
        var named = named
        return named.Name()
    }
}

shared class TypeConstraintFixture {
    func Run() {
        Console.WriteLine("TypeConstraint: base=" + ConstraintCalls.Hear(Frog()))
        Console.WriteLine("TypeConstraint: interface=" + ConstraintCalls.Call(NamedFrog()))
    }
}
