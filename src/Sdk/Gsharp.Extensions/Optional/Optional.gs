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

/// Projects the value of a present reference-typed optional through `f`.
///
/// When the receiver is `nil`, the projection is skipped and `nil` is
/// returned; otherwise `f` is invoked on the present value and its
/// result is returned wrapped as a `U?` optional.
///
/// ```gs
/// let name U? = "Ada"
/// let length = name.Map(s => s.Length)   // length == 3
/// let absent U? = nil
/// let none = absent.Map(s => s.Length)   // none == nil
/// ```
///
/// See also [FlatMap](cref:Gsharp.Extensions.Optional.FlatMap),
/// [Filter](cref:Gsharp.Extensions.Optional.Filter),
/// [OrElse](cref:Gsharp.Extensions.Optional.OrElse).
///
/// @param f the projection applied to the present value; must not be `nil`.
/// @returns `f(self)` when the receiver carries a value, otherwise `nil`.
/// @exception ArgumentNullException `f` is `nil`.
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

/// Projects the value of a present value-typed optional through `f`.
///
/// When the receiver has no value, the projection is skipped and `nil`
/// is returned; otherwise `f` is invoked on the unwrapped value and its
/// result is returned wrapped as a `U?` optional.
///
/// ```gs
/// let age int32? = 42
/// let doubled = age.Map(n => n * 2)      // doubled == 84
/// let absent int32? = nil
/// let none = absent.Map(n => n * 2)      // none == nil
/// ```
///
/// See also [FlatMap](cref:Gsharp.Extensions.Optional.FlatMap),
/// [Filter](cref:Gsharp.Extensions.Optional.Filter),
/// [OrElse](cref:Gsharp.Extensions.Optional.OrElse).
///
/// @param f the projection applied to the present value; must not be `nil`.
/// @returns `f(self.Value)` when the receiver has a value, otherwise `nil`.
/// @exception ArgumentNullException `f` is `nil`.
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

/// Projects the value of a present reference-typed optional through an
/// optional-returning `f` and flattens the nested optional.
///
/// Equivalent to `Map` followed by an unwrap of the inner optional:
/// `f` itself returns `U?`, so the result is `nil` when either the
/// receiver is absent or `f` produces `nil`.
///
/// ```gs
/// func parse(s string) int32? {
///     var n int32 = 0
///     return int32.TryParse(s, out n) ? n : nil
/// }
///
/// let raw string? = "42"
/// let parsed = raw.FlatMap(parse)        // parsed == 42
/// let bad   string? = "hello"
/// let none  = bad.FlatMap(parse)         // none == nil
/// ```
///
/// See also [Map](cref:Gsharp.Extensions.Optional.Map),
/// [Filter](cref:Gsharp.Extensions.Optional.Filter).
///
/// @param f the optional-returning projection; must not be `nil`.
/// @returns `f(self)` when the receiver carries a value, otherwise `nil`.
/// @exception ArgumentNullException `f` is `nil`.
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

/// Projects the value of a present value-typed optional through an
/// optional-returning `f` and flattens the nested optional.
///
/// Equivalent to `Map` followed by an unwrap of the inner optional:
/// `f` itself returns `U?`, so the result is `nil` when either the
/// receiver is absent or `f` produces `nil`.
///
/// ```gs
/// func safeDivide(numerator int32, denominator int32) int32? {
///     return denominator == 0 ? nil : numerator / denominator
/// }
///
/// let x int32? = 10
/// let halved = x.FlatMap(n => safeDivide(n, 2))   // halved == 5
/// let zero   = x.FlatMap(n => safeDivide(n, 0))   // zero == nil
/// ```
///
/// See also [Map](cref:Gsharp.Extensions.Optional.Map),
/// [Filter](cref:Gsharp.Extensions.Optional.Filter).
///
/// @param f the optional-returning projection; must not be `nil`.
/// @returns `f(self.Value)` when the receiver has a value, otherwise `nil`.
/// @exception ArgumentNullException `f` is `nil`.
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

/// Returns the present reference-typed value, or `defaultValue` if the
/// receiver is `nil`.
///
/// `defaultValue` is evaluated unconditionally at the call site. For a
/// lazily-computed fallback, prefer
/// [OrCompute](cref:Gsharp.Extensions.Optional.OrCompute); to surface
/// an exception instead, use
/// [OrThrow](cref:Gsharp.Extensions.Optional.OrThrow).
///
/// ```gs
/// let configured string? = lookup("theme")
/// let theme = configured.OrElse("light")
/// ```
///
/// See also [OrCompute](cref:Gsharp.Extensions.Optional.OrCompute),
/// [OrThrow](cref:Gsharp.Extensions.Optional.OrThrow).
///
/// @param defaultValue the value returned when the receiver is `nil`.
/// @returns the receiver's value when present, otherwise `defaultValue`.
@MethodImpl(MethodImplOptions.AggressiveInlining)
func (self T?) OrElse[T class](defaultValue T) T {
    return self ?? defaultValue
}

/// Returns the present value-typed value, or `defaultValue` if the
/// receiver has no value.
///
/// `defaultValue` is evaluated unconditionally at the call site. For a
/// lazily-computed fallback, prefer
/// [OrCompute](cref:Gsharp.Extensions.Optional.OrCompute); to surface
/// an exception instead, use
/// [OrThrow](cref:Gsharp.Extensions.Optional.OrThrow).
///
/// ```gs
/// let port int32? = parsePort(arg)
/// let bound = port.OrElse(8080)
/// ```
///
/// See also [OrCompute](cref:Gsharp.Extensions.Optional.OrCompute),
/// [OrThrow](cref:Gsharp.Extensions.Optional.OrThrow).
///
/// @param defaultValue the value returned when the receiver has no value.
/// @returns the receiver's value when present, otherwise `defaultValue`.
@MethodImpl(MethodImplOptions.AggressiveInlining)
func (self T?) OrElse[T struct](defaultValue T) T {
    if !self.HasValue {
        return defaultValue
    }

    return self.Value
}

// ---- OrCompute ---------------------------------------------------------

/// Returns the present reference-typed value, or the result of invoking
/// `defaultFactory` when the receiver is `nil`.
///
/// Unlike [OrElse](cref:Gsharp.Extensions.Optional.OrElse), the
/// fallback is computed lazily — `defaultFactory` is only invoked on
/// the absent path. Use this when constructing the default is
/// expensive or has observable side effects.
///
/// ```gs
/// let cached string? = lookupFromCache(key)
/// let value = cached.OrCompute(() => fetchFromDisk(key))
/// ```
///
/// See also [OrElse](cref:Gsharp.Extensions.Optional.OrElse),
/// [OrThrow](cref:Gsharp.Extensions.Optional.OrThrow).
///
/// @param defaultFactory invoked when the receiver is `nil`; must not be `nil`.
/// @returns the receiver's value when present, otherwise `defaultFactory()`.
/// @exception ArgumentNullException `defaultFactory` is `nil`.
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

/// Returns the present value-typed value, or the result of invoking
/// `defaultFactory` when the receiver has no value.
///
/// Unlike [OrElse](cref:Gsharp.Extensions.Optional.OrElse), the
/// fallback is computed lazily — `defaultFactory` is only invoked on
/// the absent path. Use this when constructing the default is
/// expensive or has observable side effects.
///
/// ```gs
/// let cachedAge int32? = lookupAge(id)
/// let age = cachedAge.OrCompute(() => computeAgeFromBirthdate(id))
/// ```
///
/// See also [OrElse](cref:Gsharp.Extensions.Optional.OrElse),
/// [OrThrow](cref:Gsharp.Extensions.Optional.OrThrow).
///
/// @param defaultFactory invoked when the receiver has no value; must not be `nil`.
/// @returns the receiver's value when present, otherwise `defaultFactory()`.
/// @exception ArgumentNullException `defaultFactory` is `nil`.
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

/// Unwraps a present reference-typed optional, or throws an
/// `InvalidOperationException` with `message` when the receiver is
/// `nil`.
///
/// Intentionally not inlined so the throw site remains in the caller's
/// stack trace (matches ADR-0084's documented inlining policy).
///
/// ```gs
/// let user User? = currentUser()
/// let u = user.OrThrow("no user is signed in")
/// ```
///
/// See also [OrElse](cref:Gsharp.Extensions.Optional.OrElse),
/// [OrCompute](cref:Gsharp.Extensions.Optional.OrCompute).
///
/// @param message the exception message used when the receiver is `nil`.
/// @returns the receiver's value when present.
/// @exception InvalidOperationException the receiver is `nil`.
func (self T?) OrThrow[T class](message string) T {
    if self == nil {
        throw InvalidOperationException(message)
    }

    return self!!
}

/// Unwraps a present value-typed optional, or throws an
/// `InvalidOperationException` with `message` when the receiver has no
/// value.
///
/// Intentionally not inlined so the throw site remains in the caller's
/// stack trace (matches ADR-0084's documented inlining policy).
///
/// ```gs
/// let port int32? = parsePort(arg)
/// let bound = port.OrThrow("--port must be an integer")
/// ```
///
/// See also [OrElse](cref:Gsharp.Extensions.Optional.OrElse),
/// [OrCompute](cref:Gsharp.Extensions.Optional.OrCompute).
///
/// @param message the exception message used when the receiver has no value.
/// @returns the receiver's value when present.
/// @exception InvalidOperationException the receiver has no value.
func (self T?) OrThrow[T struct](message string) T {
    if !self.HasValue {
        throw InvalidOperationException(message)
    }

    return self.Value
}

// ---- IfPresent ---------------------------------------------------------

/// Invokes `action` with the present reference-typed value, or does
/// nothing when the receiver is `nil`.
///
/// Useful for side-effecting callbacks (logging, notifications) where
/// the absent path should be a silent no-op.
///
/// ```gs
/// let user User? = currentUser()
/// user.IfPresent(u => log.Info($"signed in as {u.Name}"))
/// ```
///
/// See also [Filter](cref:Gsharp.Extensions.Optional.Filter),
/// [Map](cref:Gsharp.Extensions.Optional.Map).
///
/// @param action the callback to invoke on the present value; must not be `nil`.
/// @exception ArgumentNullException `action` is `nil`.
@MethodImpl(MethodImplOptions.AggressiveInlining)
func (self T?) IfPresent[T class](action (T) -> void) {
    if action == nil {
        throw ArgumentNullException("action")
    }

    if self != nil {
        action(self!!)
    }
}

/// Invokes `action` with the present value-typed value, or does
/// nothing when the receiver has no value.
///
/// Useful for side-effecting callbacks (logging, notifications) where
/// the absent path should be a silent no-op.
///
/// ```gs
/// let port int32? = parsePort(arg)
/// port.IfPresent(p => log.Info($"listening on {p}"))
/// ```
///
/// See also [Filter](cref:Gsharp.Extensions.Optional.Filter),
/// [Map](cref:Gsharp.Extensions.Optional.Map).
///
/// @param action the callback to invoke on the present value; must not be `nil`.
/// @exception ArgumentNullException `action` is `nil`.
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

/// Returns the receiver unchanged when present and `predicate` accepts
/// the value, otherwise `nil`.
///
/// Combines a presence check with a value-level predicate: an absent
/// receiver is passed through, a present receiver is kept only when
/// `predicate` returns `true`.
///
/// ```gs
/// let name string? = readName()
/// let nonEmpty = name.Filter(s => s.Length > 0)
/// ```
///
/// See also [Map](cref:Gsharp.Extensions.Optional.Map),
/// [FlatMap](cref:Gsharp.Extensions.Optional.FlatMap).
///
/// @param predicate the test applied to the present value; must not be `nil`.
/// @returns the receiver when present and accepted by `predicate`, otherwise `nil`.
/// @exception ArgumentNullException `predicate` is `nil`.
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

/// Returns the receiver unchanged when present and `predicate` accepts
/// the value, otherwise `nil`.
///
/// Combines a presence check with a value-level predicate: an absent
/// receiver is passed through, a present receiver is kept only when
/// `predicate` returns `true`.
///
/// ```gs
/// let port int32? = parsePort(arg)
/// let valid = port.Filter(p => p > 0 && p < 65536)
/// ```
///
/// See also [Map](cref:Gsharp.Extensions.Optional.Map),
/// [FlatMap](cref:Gsharp.Extensions.Optional.FlatMap).
///
/// @param predicate the test applied to the present value; must not be `nil`.
/// @returns the receiver when present and accepted by `predicate`, otherwise `nil`.
/// @exception ArgumentNullException `predicate` is `nil`.
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
