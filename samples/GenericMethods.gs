// file: GenericMethods.gs
// Issue #312: generic methods declared as members of a user-defined type.
// A `func` with its own `[T]` type-parameter list inside a `class`/`shared`
// body binds correctly, makes `T` usable in parameter types, return types,
// and locals, and is callable with both inferred and explicit type arguments.

package GSharp.Example.GenericMethods

import System

// Instance generic methods on a non-generic class. `Wrap` uses `T` in its
// parameter, return type, and a local; `Pair` declares two type parameters.
type Box class {
    func Wrap[T](item T) T {
        var local T = item
        return local
    }

    func Pair[T, U](a T, b U) T {
        return a
    }
}

// A generic method declared on a generic class: `Echo` uses the class's `T`
// while `GetOr` introduces its own method-level type parameter `U`.
type Container[T] class {
    Value T

    func Echo(x T) T {
        return x
    }

    func GetOr[U](other U) U {
        return other
    }
}

// A generic static method declared inside a `shared` block.
type Util class {
    shared {
        func Identity[T](x T) T {
            return x
        }
    }
}

var b = Box{}
Console.WriteLine(b.Wrap(42))
Console.WriteLine(b.Wrap("text"))
Console.WriteLine(b.Pair(7, "ignored"))
Console.WriteLine(b.Wrap[int32](100))

var c = Container[int32]{Value: 10}
Console.WriteLine(c.Echo(5))
Console.WriteLine(c.GetOr("hello"))

Console.WriteLine(Util.Identity(99))
Console.WriteLine(Util.Identity("z"))
