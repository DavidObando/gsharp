// L3-Library, part 1: generics with constraints, a generic method with
// inference, an indexer, and nullable reference types.
//
// Exercises (ADR-0115 section B):
//   B.7  generics + constraints: `where T : ...` -> bracketed G# constraints
//   B.10 visibility
//   B.11 indexer, properties
//   nullable reference types (Nullable=enable)

package Corpus.L3

import System
import System.Collections
import System.Collections.Generic

// Generic class with a constraint: where T : notnull.
class Repository[T] : IEnumerable[T] {
    private let _items List[T] = List[T]()
    prop Count int32 -> _items.Count

    // Indexer -> G# indexer member.
    prop this[index int32]T -> _items[index]

    func Add(item T) -> _items.Add(item)

    func Contains(item T) bool -> _items.Contains(item)

    func GetEnumerator() IEnumerator[T] -> _items.GetEnumerator()

    private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()
}

// Constraint: where T : IComparable<T>.
shared class Algorithms {
    func Max[T IComparable[T]](values IReadOnlyList[T]) T {
        if values.Count == 0 {
            throw ArgumentException("values must be non-empty", "values")
        }
        var best = values[0]
        for var i = 1; i < values.Count; i++ {
            if values[i].CompareTo(best) > 0 {
                best = values[i]
            }
        }
        return best
    }

    // Generic method whose T is inferred at the call site.
    func Ends[T](values IReadOnlyList[T])(First T, Last T) {
        if values.Count == 0 {
            throw ArgumentException("values must be non-empty", "values")
        }
        return (values[0], values[values.Count - 1])
    }

    // Constraint: where T : class - nullable reference flow.
    func OrDefault[T class](value T?, fallback T) T {
        return value ?? fallback
    }
}
