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
// is the audit's F3 case: receiver-method dispatch over the inner user-defined
// generic now resolves through reified MemberRefs after ADR-0087 R5 landed
// (issue #765). The sample exercises both the original built-in shape and the
// R5 shape so the golden output covers the full matrix.
let strings = List[string]()
strings.Add("a")
strings.Add("b")
Console.WriteLine(strings.Count)

let boxes = List[Box[int32]]()
boxes.Add(Box[int32]{Value: 1})
boxes.Add(Box[int32]{Value: 2})
Console.WriteLine(boxes.Count)
