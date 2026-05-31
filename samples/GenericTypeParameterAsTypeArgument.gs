// file: GenericTypeParameterAsTypeArgument.gs
// Issue #313: an in-scope generic type parameter may be used as a type
// argument to another generic type (e.g. `List[T]`) anywhere a type is
// expected — parameter, return, local, and nested positions. Previously the
// binder rejected `List[T]` with `GS0149: Type 'T' is not generic`.
//
// Generics follow the type-erased model (ADR-0004): `List[T]` is erased to
// `List<object>` at emit, with the symbolic `[T]` preserved on the symbol so
// inference and substitution recover the concrete type at call sites.

package GSharp.Example.GenericTypeParameterAsTypeArgument

import System
import System.Collections.Generic

// Type parameter in a parameter position, returned via element access.
func First[T](items List[T]) T {
    return items[0]
}

// Type parameter in both parameter and return positions (pass-through).
func Echo[T](items List[T]) List[T] {
    return items
}

// Nested: type parameter inside a nested generic type argument.
func FirstValue[T](rows List[Dictionary[string, T]]) T {
    var head = rows[0]
    return head["key"]
}

var numbers = List[int32]()
numbers.Add(10)
numbers.Add(20)
numbers.Add(30)

Console.WriteLine(First[int32](numbers))

var echoed = Echo[int32](numbers)
Console.WriteLine(echoed[1])

var rows = List[Dictionary[string, int32]]()
var row = Dictionary[string, int32]()
row.Add("key", 42)
rows.Add(row)
Console.WriteLine(FirstValue[int32](rows))
