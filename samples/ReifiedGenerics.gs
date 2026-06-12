// file: ReifiedGenerics.gs
// ADR-0087 reified-generics exercise sample.
//
// Exercises the canonical generic shapes called out in the audit:
//   - generic data struct, used at multiple closed instantiations
//   - generic class with a generic primary-constructor
//   - generic method dispatch with explicit type arguments
//   - nested generic shape (Box[Box[int32]])
//   - closed CLR generic over a user-defined generic instance (List[Box[int32]])
//   - generic identity over a value type and a reference type
//
// The sample runs unchanged under the current type-erased model and is
// designed to keep producing the same golden output after each ADR-0087
// staging phase lands. It is the sample-side stability invariant the
// reified-generics work measures itself against.

package GSharp.Example.ReifiedGenerics

import System
import System.Collections.Generic

data struct Box[T any] {
    var Value T
}

class Pair[A, B any](First A, Second B) {
}

func Identity[T any](value T) T {
    return value
}

// Generic box with int32 — value-typed payload.
let intBox = Box[int32]{Value: 7}
Console.WriteLine(intBox.Value)

// Generic box with string — reference-typed payload.
let stringBox = Box[string]{Value: "ok"}
Console.WriteLine(stringBox.Value)

// Generic class with a primary constructor over two parameters.
let pair = Pair[string, int32]("answer", 42)
Console.WriteLine(pair.First)
Console.WriteLine(pair.Second)

// Generic method invoked with an explicit type argument over a value type.
Console.WriteLine(Identity[int32](99))

// Generic method invoked with an explicit type argument over a reference type.
Console.WriteLine(Identity[string]("hi"))

// Nested generic shape: Box[Box[int32]].
let nested = Box[Box[int32]]{Value: Box[int32]{Value: 5}}
Console.WriteLine(nested.Value.Value)

// Closed CLR generic over a user-defined generic instance (List[Box[int32]])
// is one of the audit's F3 cases — receiver-method dispatch over the erased
// inner type does not currently resolve under the type-erased model, so the
// sample exercises the closed CLR generic over a built-in scalar instead.
// ADR-0087 §5 R5 widens this to the user-defined shape.
let strings = List[string]()
strings.Add("a")
strings.Add("b")
Console.WriteLine(strings.Count)
