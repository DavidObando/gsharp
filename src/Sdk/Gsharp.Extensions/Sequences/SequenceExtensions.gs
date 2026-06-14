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

/// Yields each contiguous sliding window of length `size` from
/// `source`.
///
/// The window slides one element at a time, so for a source of length
/// `n >= size` the result contains `n - size + 1` snapshots. Each
/// yielded window is an independent `IList[T]` copy (safe to retain
/// across `MoveNext` calls). If `source` is shorter than `size`, the
/// result is empty. Per ADR-0084 the iterator is not inlined; the
/// underlying enumerator is disposed on early termination
/// (issue #836).
///
/// ```gs
/// for w in Sequences.Of(1, 2, 3, 4).Windowed(2) {
///     print(string.Join(",", w))   // "1,2", "2,3", "3,4"
/// }
/// ```
///
/// See also [Chunked](cref:Gsharp.Extensions.Sequences.Chunked),
/// [Pairwise](cref:Gsharp.Extensions.Sequences.Pairwise).
///
/// @param size the window length; must be positive.
/// @returns an `IEnumerable[IList[T]]` of sliding windows.
/// @exception ArgumentOutOfRangeException `size <= 0`.
func (source IEnumerable[T]) Windowed[T](size int32) IEnumerable[IList[T]] {
    if size <= 0 {
        throw ArgumentOutOfRangeException("size", size, "size must be positive.")
    }

    return WindowedIterator[T](source, size)
}

/// Yields successive non-overlapping chunks of length `size` from
/// `source`.
///
/// Chunks are returned as fresh `IList[T]` snapshots in source order.
/// The final chunk may be shorter than `size` when the source length
/// is not an exact multiple. The transformer is intentionally not
/// inlined per ADR-0084.
///
/// ```gs
/// for c in Sequences.Of(1, 2, 3, 4, 5).Chunked(2) {
///     print(string.Join(",", c))   // "1,2", "3,4", "5"
/// }
/// ```
///
/// See also [Windowed](cref:Gsharp.Extensions.Sequences.Windowed),
/// [Interleave](cref:Gsharp.Extensions.Sequences.Interleave).
///
/// @param size the chunk length; must be positive.
/// @returns an `IEnumerable[IList[T]]` of non-overlapping chunks.
/// @exception ArgumentOutOfRangeException `size <= 0`.
func (source IEnumerable[T]) Chunked[T](size int32) IEnumerable[IList[T]] {
    if size <= 0 {
        throw ArgumentOutOfRangeException("size", size, "size must be positive.")
    }

    return ChunkedIterator[T](source, size)
}

/// Yields `(index, value)` pairs for each element of `source`, with a
/// zero-based `int32` index.
///
/// Lazily iterates the source exactly once; the iterator disposes the
/// underlying enumerator on early termination (issue #836). Carries
/// `AggressiveInlining` per ADR-0084.
///
/// ```gs
/// for (i, name) in names.Indexed() {
///     print($"{i}: {name}")
/// }
/// ```
///
/// See also [Pairwise](cref:Gsharp.Extensions.Sequences.Pairwise),
/// [Windowed](cref:Gsharp.Extensions.Sequences.Windowed).
///
/// @returns an `IEnumerable[(int32, T)]` of indexed pairs.
@MethodImpl(MethodImplOptions.AggressiveInlining)
func (source IEnumerable[T]) Indexed[T]() IEnumerable[(int32, T)] {
    return IndexedIterator[T](source)
}

/// Yields each consecutive pair of elements from `source` as a tuple.
///
/// For an input of length `n`, the result contains `max(0, n - 1)`
/// pairs: `(s[0], s[1]), (s[1], s[2]), …`. Useful for delta
/// computations (e.g. successive timestamps).
///
/// ```gs
/// let deltas = ticks.Pairwise().Select(p => p.Item2 - p.Item1)
/// ```
///
/// See also [Windowed](cref:Gsharp.Extensions.Sequences.Windowed),
/// [Indexed](cref:Gsharp.Extensions.Sequences.Indexed).
///
/// @returns an `IEnumerable[(T, T)]` of consecutive pairs.
func (source IEnumerable[T]) Pairwise[T]() IEnumerable[(T, T)] {
    return PairwiseIterator[T](source)
}

/// Interleaves `source` and `other`, yielding elements alternately
/// until one side is exhausted, then drains the remaining side.
///
/// Both enumerators are advanced lazily; `using let` (per ADR-0084
/// inlining policy / issue #836) ensures both are disposed when the
/// iterator's state machine tears down.
///
/// ```gs
/// let merged = Sequences.Of(1, 3, 5).Interleave(Sequences.Of(2, 4))
/// // merged: 1, 2, 3, 4, 5
/// ```
///
/// See also [Chunked](cref:Gsharp.Extensions.Sequences.Chunked),
/// [Pairwise](cref:Gsharp.Extensions.Sequences.Pairwise).
///
/// @param other the secondary sequence whose elements interleave with `source`.
/// @returns an `IEnumerable[T]` that alternates between `source` and `other`, then drains the longer side.
func (source IEnumerable[T]) Interleave[T](other IEnumerable[T]) IEnumerable[T] {
    return InterleaveIterator[T](source, other)
}

// ====================================================================
// Safe terminals — reference- and value-typed overloads coexist
// ====================================================================

/// Returns the first element of `source` as a present optional, or
/// `nil` when the sequence is empty (reference-typed overload).
///
/// The overload is selected automatically by the binder when `T` is a
/// reference type. Carries `AggressiveInlining` per ADR-0084.
///
/// ```gs
/// let firstName = names.FirstOrNil()
/// let upper = firstName.Map(s => s.ToUpper())
/// ```
///
/// See also [LastOrNil](cref:Gsharp.Extensions.Sequences.LastOrNil),
/// [SingleOrNil](cref:Gsharp.Extensions.Sequences.SingleOrNil),
/// [Map](cref:Gsharp.Extensions.Optional.Map).
///
/// @returns the first element wrapped as `T?`, or `nil` when empty.
@MethodImpl(MethodImplOptions.AggressiveInlining)
func (source IEnumerable[T]) FirstOrNil[T class]() T? {
    for item in source {
        return item
    }

    return nil
}

/// Returns the first element of `source` as a present optional, or
/// `nil` when the sequence is empty (value-typed overload).
///
/// The overload is selected automatically by the binder when `T` is a
/// value type. Carries `AggressiveInlining` per ADR-0084.
///
/// ```gs
/// let firstAge = ages.FirstOrNil()
/// let adult = firstAge.Filter(n => n >= 18)
/// ```
///
/// See also [LastOrNil](cref:Gsharp.Extensions.Sequences.LastOrNil),
/// [SingleOrNil](cref:Gsharp.Extensions.Sequences.SingleOrNil),
/// [Filter](cref:Gsharp.Extensions.Optional.Filter).
///
/// @returns the first element wrapped as `T?`, or `nil` when empty.
@MethodImpl(MethodImplOptions.AggressiveInlining)
func (source IEnumerable[T]) FirstOrNil[T struct]() T? {
    for item in source {
        return item
    }

    return nil
}

/// Returns the last element of `source` as a present optional, or
/// `nil` when the sequence is empty (reference-typed overload).
///
/// Drains the entire sequence; for large inputs prefer
/// `source.Reverse().FirstOrNil()` only when reversal is cheap
/// (e.g. an `IList[T]`). Carries `AggressiveInlining` per ADR-0084.
///
/// ```gs
/// let lastError = errors.LastOrNil()
/// lastError.IfPresent(e => log.Warn(e.Message))
/// ```
///
/// See also [FirstOrNil](cref:Gsharp.Extensions.Sequences.FirstOrNil),
/// [SingleOrNil](cref:Gsharp.Extensions.Sequences.SingleOrNil).
///
/// @returns the last element wrapped as `T?`, or `nil` when empty.
@MethodImpl(MethodImplOptions.AggressiveInlining)
func (source IEnumerable[T]) LastOrNil[T class]() T? {
    var result T? = nil
    for item in source {
        result = item
    }

    return result
}

/// Returns the last element of `source` as a present optional, or
/// `nil` when the sequence is empty (value-typed overload).
///
/// Drains the entire sequence. Carries `AggressiveInlining` per
/// ADR-0084.
///
/// ```gs
/// let lastScore = scores.LastOrNil()
/// lastScore.IfPresent(s => print($"final: {s}"))
/// ```
///
/// See also [FirstOrNil](cref:Gsharp.Extensions.Sequences.FirstOrNil),
/// [SingleOrNil](cref:Gsharp.Extensions.Sequences.SingleOrNil).
///
/// @returns the last element wrapped as `T?`, or `nil` when empty.
@MethodImpl(MethodImplOptions.AggressiveInlining)
func (source IEnumerable[T]) LastOrNil[T struct]() T? {
    var result T? = nil
    for item in source {
        result = item
    }

    return result
}

/// Returns the sole element of `source` as a present optional, or
/// `nil` when the sequence is empty *or* contains more than one
/// element (reference-typed overload).
///
/// Stops iterating after the second `MoveNext` so it is `O(1)` when
/// the input is too long. Carries `AggressiveInlining` per ADR-0084.
///
/// ```gs
/// let theAdmin = users.Where(u => u.IsAdmin).SingleOrNil()
/// theAdmin.IfPresent(u => grant(u))
/// ```
///
/// See also [FirstOrNil](cref:Gsharp.Extensions.Sequences.FirstOrNil),
/// [LastOrNil](cref:Gsharp.Extensions.Sequences.LastOrNil).
///
/// @returns the sole element wrapped as `T?`, or `nil` for empty or multi-element sequences.
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

/// Returns the sole element of `source` as a present optional, or
/// `nil` when the sequence is empty *or* contains more than one
/// element (value-typed overload).
///
/// Stops iterating after the second `MoveNext` so it is `O(1)` when
/// the input is too long. Carries `AggressiveInlining` per ADR-0084.
///
/// ```gs
/// let onlyId = ids.SingleOrNil()
/// let resolved = onlyId.OrThrow("expected exactly one id")
/// ```
///
/// See also [FirstOrNil](cref:Gsharp.Extensions.Sequences.FirstOrNil),
/// [LastOrNil](cref:Gsharp.Extensions.Sequences.LastOrNil).
///
/// @returns the sole element wrapped as `T?`, or `nil` for empty or multi-element sequences.
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

/// Materializes `source` into a freshly-allocated `[]T` slice.
///
/// Iterates the source exactly once into a `List[T]` buffer before
/// copying out via `ToArray()` — used in lieu of the open-generic
/// `IEnumerable[T].ToArray()` while the binder still erases the
/// substitution to `Object[]`.
///
/// ```gs
/// let frozen = Sequences.Range(0, 4).ToSlice()   // []int32 {0, 1, 2, 3}
/// ```
///
/// See also [ToMap](cref:Gsharp.Extensions.Sequences.ToMap).
///
/// @returns a new `[]T` containing every element of `source` in iteration order.
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

/// Materializes a sequence of `(key, value)` tuples into a
/// `Dictionary[TKey, TValue]`.
///
/// Duplicate keys throw `ArgumentException` (matching `Dictionary.Add`
/// semantics); pre-deduplicate the source if duplicates are expected.
///
/// ```gs
/// let lookup = Sequences.Of(("a", 1), ("b", 2)).ToMap()
/// // lookup["a"] == 1
/// ```
///
/// See also [ToSlice](cref:Gsharp.Extensions.Sequences.ToSlice).
///
/// @returns a new `Dictionary[TKey, TValue]` containing one entry per source pair.
/// @exception ArgumentException the source contains duplicate keys.
func (source IEnumerable[(TKey, TValue)]) ToMap[TKey, TValue]() Dictionary[TKey, TValue] {
    var result = Dictionary[TKey, TValue]()
    for entry in source {
        result.Add(entry.Item1, entry.Item2)
    }

    return result
}

/// Materializes `source` into a `Dictionary[TKey, TValue]` by
/// projecting each element through `keyFn` and `valueFn`.
///
/// Duplicate keys throw `ArgumentException` (matching `Dictionary.Add`
/// semantics).
///
/// ```gs
/// let byId = users.ToMap(u => u.Id, u => u)        // identity-valued lookup
/// let nameById = users.ToMap(u => u.Id, u => u.Name)
/// ```
///
/// See also [ToSlice](cref:Gsharp.Extensions.Sequences.ToSlice).
///
/// @param keyFn extracts the dictionary key from each element; must not be `nil`.
/// @param valueFn extracts the dictionary value from each element; must not be `nil`.
/// @returns a new `Dictionary[TKey, TValue]` built from the projected pairs.
/// @exception ArgumentNullException `keyFn` or `valueFn` is `nil`.
/// @exception ArgumentException `keyFn` produces the same key for two distinct elements.
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
    // Issue #836: with try/finally + yield supported, eagerly grab the
    // source enumerator and guarantee its disposal even when the
    // consumer breaks early. Matches the C# baseline shape.
    let enumerator = source.GetEnumerator()
    try {
        var buffer = Queue[T](size)
        while enumerator.MoveNext() {
            buffer.Enqueue(enumerator.Current)
            if buffer.Count == size {
                yield List[T](buffer)
                buffer.Dequeue()
            }
        }
    } finally {
        enumerator.Dispose()
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
    // Issue #836: explicit enumerator + try/finally guarantees
    // disposal on early termination, matching the C# baseline.
    let enumerator = source.GetEnumerator()
    try {
        var i = 0
        while enumerator.MoveNext() {
            yield (i, enumerator.Current)
            i++
        }
    } finally {
        enumerator.Dispose()
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
    // The `using let` form binds each enumerator's lifetime to the
    // iterator block — the iterator lowering disposes them when the
    // state machine's Dispose path runs. Issue #836 also unlocked an
    // explicit `try { … } finally { … }` shape for this scenario, but
    // `using let` keeps the intent declarative.
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
