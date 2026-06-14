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
import System.Runtime.CompilerServices

class Sequences {
    shared {
        // ---- Empty: zero-allocation empty sequence -----------------------
        // Delegates to `Array.Empty[T]()` so each call returns the cached
        // singleton — never a per-call allocation.
        @MethodImpl(MethodImplOptions.AggressiveInlining)
        func Empty[T]() IEnumerable[T] {
            return Array.Empty[T]()
        }

        // ---- Of: inline literal sequence ---------------------------------
        // ADR-0101 / ADR-0102 variadic: callers pass either N positional
        // arguments, a pre-built `[]T`, or no arguments at all (empty
        // pack). The compiler emits the packed array directly so callers
        // get array-shaped access (indexing, `.Length`) on the result;
        // the array is itself an `IEnumerable[T]` (CLR covariance), so
        // every `Sequences.Of(...).LinqOp()` call site continues to bind.
        @MethodImpl(MethodImplOptions.AggressiveInlining)
        func Of[T](values ...T) []T {
            return values
        }

        // ---- Range: half-open [start, start + count) ----------------------
        // Argument validation runs eagerly (outside the iterator block) so
        // a negative count surfaces ArgumentOutOfRangeException at call
        // time, not first-MoveNext time — matches the C# baseline and the
        // BCL `Enumerable.Range` contract.
        func Range(start int32, count int32) IEnumerable[int32] {
            if count < 0 {
                throw ArgumentOutOfRangeException("count", count, "count must be non-negative.")
            }

            return Sequences.RangeIterator(start, count)
        }

        // ---- RangeStep: strided, ascending OR descending ------------------
        func RangeStep(start int32, end int32, step int32) IEnumerable[int32] {
            if step == 0 {
                throw ArgumentException("step must be non-zero.", "step")
            }

            return Sequences.RangeStepIterator(start, end, step)
        }

        // ---- Iterate: infinite seed, next(seed), next(next(seed)), … -----
        // Open-generic iterator over `T`. Combine with `.Take(n)` from
        // System.Linq to bound the iteration at the call site.
        func Iterate[T](seed T, next (T) -> T) IEnumerable[T] {
            if next == nil {
                throw ArgumentNullException("next")
            }

            return Sequences.IterateIterator[T](seed, next)
        }

        // ---- Repeat: infinite value, value, value, … ---------------------
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
