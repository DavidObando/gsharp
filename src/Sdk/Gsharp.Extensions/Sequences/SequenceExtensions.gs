// ADR-0084 / issue #806. G#-authored port of the
// `Gsharp.Extensions.Sequences.SequenceExtensions` /
// `SequenceValueExtensions` extension surface. Mirrors the closed-out
// C# baseline that previously lived under
// `src/Sdk/Gsharp.Extensions/Sequences/SequenceExtensions.cs` and
// `SequenceValueExtensions.cs`.
//
// Layout decisions:
//   * Every helper is a top-level `func (receiver) Name[...]( … )` in
//     this package; the emitter places them on the synthesized
//     `<Program>` TypeDef of the `Gsharp.Extensions.Sequences`
//     namespace, stamps each with `ExtensionAttribute`, and stamps the
//     host typedef with `ExtensionAttribute` too — exactly what C#
//     extension-method discovery (ECMA-334 §13.6.9) demands.
//   * The C# baseline split `FirstOrNil` / `LastOrNil` / `SingleOrNil`
//     into two static classes (reference-typed vs value-typed) because
//     CS0111 forbids identical signatures with disjoint
//     `where T : class` / `where T : struct` constraints. G#'s binder
//     (ADR-0088 / issue #750) and emitter (issue #814) keep both
//     overloads on the same host typedef and pick the right one at the
//     call site — so the `*ValueExtensions` sibling class is no longer
//     needed and is removed.
//   * `Indexed` and every `*OrNil` carry
//     `@MethodImpl(MethodImplOptions.AggressiveInlining)` so the
//     `MethodInfo.GetMethodImplementationFlags()` bit matches the C#
//     baseline (`AggressiveInliningTests` enforces this). The
//     iterator-block transformers (Windowed / Chunked / Pairwise /
//     Interleave) are not inlined — their compiler-generated state
//     machines are not meaningfully inlineable.
//   * Receivers are typed `IEnumerable[T]?` so the C# baseline's
//     `((IEnumerable<T>)null!).Method()` throw-on-null contract
//     continues to surface as `ArgumentNullException`. The `!!`
//     postfix unwrap after the null check is idiomatic G# (see
//     `samples/AddressBook.gs`).
//   * `ToSlice` materializes via `List[T]` because the open-generic
//     `IEnumerable[T].ToArray()` extension binds to `Object[]` rather
//     than `T[]` in the current binder (filed as an Oats follow-up).

package Gsharp.Extensions.Sequences

import System
import System.Collections.Generic
import System.Runtime.CompilerServices

// ====================================================================
// Transformers
// ====================================================================

func (source IEnumerable[T]) Windowed[T](size int32) IEnumerable[IList[T]] {
    if size <= 0 {
        throw ArgumentOutOfRangeException("size", size, "size must be positive.")
    }

    return WindowedIterator[T](source, size)
}

func (source IEnumerable[T]) Chunked[T](size int32) IEnumerable[IList[T]] {
    if size <= 0 {
        throw ArgumentOutOfRangeException("size", size, "size must be positive.")
    }

    return ChunkedIterator[T](source, size)
}

@MethodImpl(MethodImplOptions.AggressiveInlining)
func (source IEnumerable[T]) Indexed[T]() IEnumerable[(int32, T)] {
    return IndexedIterator[T](source)
}

func (source IEnumerable[T]) Pairwise[T]() IEnumerable[(T, T)] {
    return PairwiseIterator[T](source)
}

func (source IEnumerable[T]) Interleave[T](other IEnumerable[T]) IEnumerable[T] {
    return InterleaveIterator[T](source, other)
}

// ====================================================================
// Safe terminals — reference- and value-typed overloads coexist
// ====================================================================

@MethodImpl(MethodImplOptions.AggressiveInlining)
func (source IEnumerable[T]) FirstOrNil[T class]() T? {
    for item in source {
        return item
    }

    return nil
}

@MethodImpl(MethodImplOptions.AggressiveInlining)
func (source IEnumerable[T]) FirstOrNil[T struct]() T? {
    for item in source {
        return item
    }

    return nil
}

@MethodImpl(MethodImplOptions.AggressiveInlining)
func (source IEnumerable[T]) LastOrNil[T class]() T? {
    var result T? = nil
    for item in source {
        result = item
    }

    return result
}

@MethodImpl(MethodImplOptions.AggressiveInlining)
func (source IEnumerable[T]) LastOrNil[T struct]() T? {
    var result T? = nil
    for item in source {
        result = item
    }

    return result
}

@MethodImpl(MethodImplOptions.AggressiveInlining)
func (source IEnumerable[T]) SingleOrNil[T class]() T? {
    using let enumerator = source.GetEnumerator()
    if !enumerator.MoveNext() {
        return nil
    }

    let first = enumerator.Current
    if enumerator.MoveNext() {
        return nil
    }

    return first
}

@MethodImpl(MethodImplOptions.AggressiveInlining)
func (source IEnumerable[T]) SingleOrNil[T struct]() T? {
    using let enumerator = source.GetEnumerator()
    if !enumerator.MoveNext() {
        return nil
    }

    let first = enumerator.Current
    if enumerator.MoveNext() {
        return nil
    }

    return first
}

// ====================================================================
// Collectors
// ====================================================================

func (source IEnumerable[T]) ToSlice[T]() []T {
    // Materialize via List[T] because the open-generic
    // `IEnumerable[T].ToArray()` extension currently binds to
    // `Object[]` in the G# binder. List[T].ToArray() does the right
    // thing because the substitution is closed by the time we call it.
    var list = List[T]()
    for item in source {
        list.Add(item)
    }

    return list.ToArray()
}

func (source IEnumerable[(TKey, TValue)]) ToMap[TKey, TValue]() Dictionary[TKey, TValue] {
    var result = Dictionary[TKey, TValue]()
    for entry in source {
        result.Add(entry.Item1, entry.Item2)
    }

    return result
}

func (source IEnumerable[T]) ToMap[T, TKey, TValue](keyFn (T) -> TKey, valueFn (T) -> TValue) Dictionary[TKey, TValue] {
    if keyFn == nil {
        throw ArgumentNullException("keyFn")
    }

    if valueFn == nil {
        throw ArgumentNullException("valueFn")
    }

    var result = Dictionary[TKey, TValue]()
    for item in source {
        result.Add(keyFn(item), valueFn(item))
    }

    return result
}

// ====================================================================
// Private iterator bodies
// ====================================================================

func WindowedIterator[T](source IEnumerable[T], size int32) IEnumerable[IList[T]] {
    var buffer = List[T](size)
    for item in source {
        buffer.Add(item)
        if buffer.Count == size {
            let snap = List[T](buffer)
            yield snap
            buffer.RemoveAt(0)
        }
    }
}

func ChunkedIterator[T](source IEnumerable[T], size int32) IEnumerable[IList[T]] {
    var buffer = List[T](size)
    for item in source {
        buffer.Add(item)
        if buffer.Count == size {
            let snap = List[T](buffer)
            yield snap
            buffer.Clear()
        }
    }

    if buffer.Count > 0 {
        yield List[T](buffer)
    }
}

func IndexedIterator[T](source IEnumerable[T]) IEnumerable[(int32, T)] {
    var i = 0
    for item in source {
        yield (i, item)
        i++
    }
}

func PairwiseIterator[T](source IEnumerable[T]) IEnumerable[(T, T)] {
    var hasPrevious = false
    var previous T = default(T)
    for item in source {
        if hasPrevious {
            yield (previous, item)
        }

        previous = item
        hasPrevious = true
    }
}

func InterleaveIterator[T](source IEnumerable[T], other IEnumerable[T]) IEnumerable[T] {
    // Iterator blocks can't host a `try-finally` wrap around `yield`,
    // so we use `using let` to bind each enumerator — the iterator
    // lowering disposes them in the resulting state machine's
    // FaultBlock.
    using let left = source.GetEnumerator()
    using let right = other.GetEnumerator()

    var leftAlive = left.MoveNext()
    var rightAlive = right.MoveNext()

    while leftAlive && rightAlive {
        yield left.Current
        yield right.Current
        leftAlive = left.MoveNext()
        rightAlive = right.MoveNext()
    }

    while leftAlive {
        yield left.Current
        leftAlive = left.MoveNext()
    }

    while rightAlive {
        yield right.Current
        rightAlive = right.MoveNext()
    }
}
