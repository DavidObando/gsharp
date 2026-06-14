// ADR-0084 / issue #806. G#-authored port of the
// `Gsharp.Extensions.Sequences.Sequences` builder surface. Mirrors the
// closed-out C# baseline that previously lived under
// `src/Sdk/Gsharp.Extensions/Sequences/Sequences.cs`.
//
// Layout decisions:
//   * `Sequences` is a regular named class with a `shared { … }` block.
//     The G# emitter lowers each shared member to a static method on
//     the enclosing TypeDef, so `Gsharp.Extensions.Sequences.Sequences`
//     is the same CLR type users (and the existing C# Extensions test
//     suite) reach via `using Gsharp.Extensions.Sequences;
//     Sequences.Range(...)`.
//   * `Empty` and `Of` are aggressive-inlined per ADR-0084. The
//     iterator-block helpers (Range / RangeStep / Iterate / Repeat) are
//     intentionally NOT inlined — the JIT cannot meaningfully inline
//     compiler-generated state-machine entry points anyway.
//   * `Of` is variadic via `values ...T` (ADR-0101) and follows the
//     ADR-0102 dispatch shape (pack at the call site, accept a single
//     pre-built `[]T` pass-through, accept zero args for the empty
//     pack).
//   * `Iterate` / `Repeat` are open-generic iterators (`for v in … {
//     yield v }`), backed by the state-machine reification landed by
//     issue #810. Range / RangeStep are fully closed `int32` iterators.

package Gsharp.Extensions.Sequences

import System
import System.Collections.Generic
import System.Linq
import System.Runtime.CompilerServices

/// Entry-point helpers for building `IEnumerable[T]` sequences from
/// scratch — empty, inline-literal, ranged, iterated, or repeated.
///
/// Pair these with the extension helpers in
/// [SequenceExtensions](cref:Gsharp.Extensions.Sequences) such as
/// [Indexed](cref:Gsharp.Extensions.Sequences.Indexed),
/// [Pairwise](cref:Gsharp.Extensions.Sequences.Pairwise),
/// [Windowed](cref:Gsharp.Extensions.Sequences.Windowed) and
/// [FirstOrNil](cref:Gsharp.Extensions.Sequences.FirstOrNil) to build
/// expressive pipelines.
///
/// ```gs
/// import Gsharp.Extensions.Sequences
///
/// let evens = Sequences.Range(0, 5).Select(n => n * 2)   // 0, 2, 4, 6, 8
/// let bools = Sequences.Of(true, false, true)            // [true, false, true]
/// ```
class Sequences {
    shared {
        // ---- Empty: zero-allocation empty sequence -----------------------
        // Issue #833 (lifted): now that open-T generic-method calls
        // preserve the symbolic return type, delegate to the BCL's own
        // cached singleton instead of `Array.Empty[T]()`. Both surface
        // the same shared instance under `IEnumerable[T]`; this matches
        // the inlined shape ADR-0084 §L5 originally specified.
        /// Returns the shared empty sequence for element type `T`.
        ///
        /// Forwards to `Enumerable.Empty[T]()` so every call returns the
        /// same cached singleton; no allocation happens at the call site.
        ///
        /// ```gs
        /// let none IEnumerable[string] = Sequences.Empty[string]()
        /// ```
        ///
        /// See also [Of](cref:Gsharp.Extensions.Sequences.Sequences.Of).
        ///
        /// @returns the shared empty `IEnumerable[T]` for `T`.
        @MethodImpl(MethodImplOptions.AggressiveInlining)
        func Empty[T]() IEnumerable[T] {
            return Enumerable.Empty[T]()
        }

        // ---- Of: inline literal sequence ---------------------------------
        // ADR-0101 / ADR-0102 variadic: callers pass either N positional
        // arguments, a pre-built `[]T`, or no arguments at all (empty
        // pack). The compiler emits the packed array directly so callers
        // get array-shaped access (indexing, `.Length`) on the result;
        // the array is itself an `IEnumerable[T]` (CLR covariance), so
        // every `Sequences.Of(...).LinqOp()` call site continues to bind.
        /// Builds an inline literal sequence from the supplied values.
        ///
        /// Variadic per ADR-0101 / ADR-0102: pass N positional arguments,
        /// a pre-built `[]T`, or zero arguments for an empty pack. The
        /// returned array is itself an `IEnumerable[T]` via CLR
        /// covariance, so it composes with any LINQ operator.
        ///
        /// ```gs
        /// let small = Sequences.Of(1, 2, 3)              // [1, 2, 3]
        /// let empty = Sequences.Of[int32]()              // []
        /// let prebuilt = Sequences.Of([] int32 {4, 5})   // pass-through
        /// ```
        ///
        /// See also [Empty](cref:Gsharp.Extensions.Sequences.Sequences.Empty),
        /// [Range](cref:Gsharp.Extensions.Sequences.Sequences.Range),
        /// [Repeat](cref:Gsharp.Extensions.Sequences.Sequences.Repeat).
        ///
        /// @param values the elements to materialize as the sequence.
        /// @returns an array view of `values`, typed as `[]T`.
        @MethodImpl(MethodImplOptions.AggressiveInlining)
        func Of[T](values ...T) []T {
            return values
        }

        // ---- Range: half-open [start, start + count) ----------------------
        // Argument validation runs eagerly (outside the iterator block) so
        // a negative count surfaces ArgumentOutOfRangeException at call
        // time, not first-MoveNext time — matches the C# baseline and the
        // BCL `Enumerable.Range` contract.
        /// Produces the half-open `int32` range `[start, start + count)`.
        ///
        /// Validation runs eagerly: a negative `count` throws at call
        /// time, not at first `MoveNext`, matching the BCL
        /// `Enumerable.Range` contract.
        ///
        /// ```gs
        /// for i in Sequences.Range(0, 5) {
        ///     print(i)                  // 0, 1, 2, 3, 4
        /// }
        /// ```
        ///
        /// See also [RangeStep](cref:Gsharp.Extensions.Sequences.Sequences.RangeStep),
        /// [Iterate](cref:Gsharp.Extensions.Sequences.Sequences.Iterate).
        ///
        /// @param start the first value in the range (inclusive).
        /// @param count the number of values to produce; must be non-negative.
        /// @returns an `IEnumerable[int32]` yielding `start, start+1, …, start+count-1`.
        /// @exception ArgumentOutOfRangeException `count` is negative.
        func Range(start int32, count int32) IEnumerable[int32] {
            if count < 0 {
                throw ArgumentOutOfRangeException("count", count, "count must be non-negative.")
            }

            return Sequences.RangeIterator(start, count)
        }

        // ---- RangeStep: strided, ascending OR descending ------------------
        /// Produces a strided `int32` range from `start` toward `end`,
        /// advancing by `step` each iteration.
        ///
        /// The range is half-open with respect to `end`: ascending when
        /// `step > 0` (yielding while `i < end`), descending when
        /// `step < 0` (yielding while `i > end`). A zero `step` is
        /// rejected eagerly.
        ///
        /// ```gs
        /// for i in Sequences.RangeStep(0, 10, 2) {
        ///     print(i)                  // 0, 2, 4, 6, 8
        /// }
        /// for i in Sequences.RangeStep(10, 0, -3) {
        ///     print(i)                  // 10, 7, 4, 1
        /// }
        /// ```
        ///
        /// See also [Range](cref:Gsharp.Extensions.Sequences.Sequences.Range).
        ///
        /// @param start the first value in the range (inclusive).
        /// @param end the exclusive bound (upper when `step > 0`, lower when `step < 0`).
        /// @param step the stride between successive values; must be non-zero.
        /// @returns an `IEnumerable[int32]` yielding the strided range.
        /// @exception ArgumentException `step` is zero.
        func RangeStep(start int32, end int32, step int32) IEnumerable[int32] {
            if step == 0 {
                throw ArgumentException("step must be non-zero.", "step")
            }

            return Sequences.RangeStepIterator(start, end, step)
        }

        // ---- Iterate: infinite seed, next(seed), next(next(seed)), … -----
        // Open-generic iterator over `T`. Combine with `.Take(n)` from
        // System.Linq to bound the iteration at the call site.
        /// Produces the infinite sequence `seed, next(seed), next(next(seed)), …`.
        ///
        /// The iterator is open-ended; bound it with `.Take(n)` or
        /// `.TakeWhile(...)` from `System.Linq` at the call site.
        ///
        /// ```gs
        /// let powers = Sequences.Iterate(1, n => n * 2).Take(5)   // 1, 2, 4, 8, 16
        /// ```
        ///
        /// See also [Repeat](cref:Gsharp.Extensions.Sequences.Sequences.Repeat),
        /// [Range](cref:Gsharp.Extensions.Sequences.Sequences.Range).
        ///
        /// @param seed the first value yielded.
        /// @param next the successor function applied to the previous value; must not be `nil`.
        /// @returns an infinite `IEnumerable[T]` of repeated `next` applications.
        /// @exception ArgumentNullException `next` is `nil`.
        func Iterate[T](seed T, next (T) -> T) IEnumerable[T] {
            if next == nil {
                throw ArgumentNullException("next")
            }

            return Sequences.IterateIterator[T](seed, next)
        }

        // ---- Repeat: infinite value, value, value, … ---------------------
        /// Produces the infinite sequence `value, value, value, …`.
        ///
        /// Bound the iterator with `.Take(n)` or `.TakeWhile(...)` from
        /// `System.Linq` at the call site.
        ///
        /// ```gs
        /// let five = Sequences.Repeat("hi").Take(3)   // "hi", "hi", "hi"
        /// ```
        ///
        /// See also [Iterate](cref:Gsharp.Extensions.Sequences.Sequences.Iterate),
        /// [Empty](cref:Gsharp.Extensions.Sequences.Sequences.Empty).
        ///
        /// @param value the value yielded on every iteration.
        /// @returns an infinite `IEnumerable[T]` of repeated `value`.
        func Repeat[T](value T) IEnumerable[T] {
            return Sequences.RepeatIterator[T](value)
        }

        // ---- Private iterator bodies (state-machine entry points) --------

        func RangeIterator(start int32, count int32) IEnumerable[int32] {
            for var i = 0; i < count; i++ {
                yield start + i
            }
        }

        func RangeStepIterator(start int32, end int32, step int32) IEnumerable[int32] {
            if step > 0 {
                for var i = start; i < end; i = i + step {
                    yield i
                }
            } else {
                for var i = start; i > end; i = i + step {
                    yield i
                }
            }
        }

        func IterateIterator[T](seed T, next (T) -> T) IEnumerable[T] {
            var current = seed
            while true {
                yield current
                current = next(current)
            }
        }

        func RepeatIterator[T](value T) IEnumerable[T] {
            while true {
                yield value
            }
        }
    }
}
