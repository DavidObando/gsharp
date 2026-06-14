// ADR-0084 / issue #806. G#-authored port of the `Gsharp.Extensions.Optional`
// helper surface, dogfooding the bootstrap SDK landed by issue #792.
// Mirrors the closed-out C# baseline that previously lived under
// `src/Sdk/Gsharp.Extensions/Optional/OptionalExtensions.cs`.
//
// Layout:
//
//   * Reference-typed helpers (`[T class]` / `[U class]`) and
//     value-typed helpers (`[T struct]` / `[U struct]`) coexist on the
//     same name set — the constraint-aware overload filter from
//     ADR-0088 / issue #750 (binder) and ADR-0097 / issue #775 (G#
//     spelling) picks the right one at the call site. Issue #814
//     closed the matching emit/interpreter sides for the `*OrNil`
//     splits; the same machinery now powers every `Map` / `FlatMap` /
//     `OrElse` / `OrCompute` / `IfPresent` / `Filter` overload pair
//     here.
//
//   * Every hot helper carries
//     `@MethodImpl(MethodImplOptions.AggressiveInlining)` so the JIT
//     can inline across the Gsharp.Extensions assembly boundary. The
//     pseudo-custom attribute lands on the MethodDef's
//     `MethodImplAttributes` flags (per the new pseudo-custom handling
//     added for ADR-0084 §L5), not on a CustomAttribute row — so
//     `MethodInfo.GetMethodImplementationFlags()` reports the
//     `AggressiveInlining` bit exactly as the C# baseline did.
//
//   * `OrThrow` is intentionally NOT inlined so the throw site
//     remains in the caller's stack trace (matches ADR-0084's
//     documented inlining policy).
//
// Each helper validates its delegate argument with
// `ArgumentNullException` and returns `nil` on the absent path,
// preserving the public contract of the previous C# baseline; the
// existing test/Extensions.Tests/ suite covers every overload across
// the present, absent, and null-projection paths.

package Gsharp.Extensions.Optional

import System
import System.Runtime.CompilerServices

// ---- Map ---------------------------------------------------------------

@MethodImpl(MethodImplOptions.AggressiveInlining)
func (self T?) Map[T class, U class](f (T) -> U) U? {
    if f == nil {
        throw ArgumentNullException("f")
    }

    if self == nil {
        return nil
    }

    return f(self!!)
}

@MethodImpl(MethodImplOptions.AggressiveInlining)
func (self T?) Map[T struct, U struct](f (T) -> U) U? {
    if f == nil {
        throw ArgumentNullException("f")
    }

    if !self.HasValue {
        return nil
    }

    return f(self.Value)
}

// ---- FlatMap -----------------------------------------------------------

@MethodImpl(MethodImplOptions.AggressiveInlining)
func (self T?) FlatMap[T class, U class](f (T) -> U?) U? {
    if f == nil {
        throw ArgumentNullException("f")
    }

    if self == nil {
        return nil
    }

    return f(self!!)
}

@MethodImpl(MethodImplOptions.AggressiveInlining)
func (self T?) FlatMap[T struct, U struct](f (T) -> U?) U? {
    if f == nil {
        throw ArgumentNullException("f")
    }

    if !self.HasValue {
        return nil
    }

    return f(self.Value)
}

// ---- OrElse ------------------------------------------------------------

@MethodImpl(MethodImplOptions.AggressiveInlining)
func (self T?) OrElse[T class](defaultValue T) T {
    return self ?: defaultValue
}

@MethodImpl(MethodImplOptions.AggressiveInlining)
func (self T?) OrElse[T struct](defaultValue T) T {
    if !self.HasValue {
        return defaultValue
    }

    return self.Value
}

// ---- OrCompute ---------------------------------------------------------

@MethodImpl(MethodImplOptions.AggressiveInlining)
func (self T?) OrCompute[T class](defaultFactory () -> T) T {
    if defaultFactory == nil {
        throw ArgumentNullException("defaultFactory")
    }

    if self == nil {
        return defaultFactory()
    }

    return self!!
}

@MethodImpl(MethodImplOptions.AggressiveInlining)
func (self T?) OrCompute[T struct](defaultFactory () -> T) T {
    if defaultFactory == nil {
        throw ArgumentNullException("defaultFactory")
    }

    if !self.HasValue {
        return defaultFactory()
    }

    return self.Value
}

// ---- OrThrow (deliberately NOT inlined) --------------------------------

func (self T?) OrThrow[T class](message string) T {
    if self == nil {
        throw InvalidOperationException(message)
    }

    return self!!
}

func (self T?) OrThrow[T struct](message string) T {
    if !self.HasValue {
        throw InvalidOperationException(message)
    }

    return self.Value
}

// ---- IfPresent ---------------------------------------------------------

@MethodImpl(MethodImplOptions.AggressiveInlining)
func (self T?) IfPresent[T class](action (T) -> void) {
    if action == nil {
        throw ArgumentNullException("action")
    }

    if self != nil {
        action(self!!)
    }
}

@MethodImpl(MethodImplOptions.AggressiveInlining)
func (self T?) IfPresent[T struct](action (T) -> void) {
    if action == nil {
        throw ArgumentNullException("action")
    }

    if self.HasValue {
        action(self.Value)
    }
}

// ---- Filter ------------------------------------------------------------

@MethodImpl(MethodImplOptions.AggressiveInlining)
func (self T?) Filter[T class](predicate (T) -> bool) T? {
    if predicate == nil {
        throw ArgumentNullException("predicate")
    }

    if self == nil {
        return nil
    }

    if predicate(self!!) {
        return self
    }

    return nil
}

@MethodImpl(MethodImplOptions.AggressiveInlining)
func (self T?) Filter[T struct](predicate (T) -> bool) T? {
    if predicate == nil {
        throw ArgumentNullException("predicate")
    }

    if !self.HasValue {
        return nil
    }

    if predicate(self.Value) {
        return self
    }

    return nil
}
