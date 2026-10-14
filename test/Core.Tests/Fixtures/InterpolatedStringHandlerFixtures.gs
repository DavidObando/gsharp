// <copyright file="InterpolatedStringHandlerFixtures.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.Fixtures

import System
import System.Globalization
import System.Runtime.CompilerServices
import System.Text
import System.Threading
import System.Threading.Tasks

/// Issue #368 fixtures: user-defined `[InterpolatedStringHandler]` types and
/// consuming APIs that exercise `[InterpolatedStringHandlerArgument]`
/// forwarding (a named preceding argument, the receiver, and the `out bool`
/// short-circuit form). Defined in the test (fixture) assembly so a G# program
/// can `import GSharp.Core.Tests.Fixtures` and pass an interpolated string
/// to these handler parameters.
@InterpolatedStringHandler
struct PrefixedInterpolatedStringHandler {
    private let builder StringBuilder

    init(literalLength int32, formattedCount int32, prefix string) {
        this.builder = StringBuilder(prefix.Length + literalLength)
        this.builder.Append(prefix)
    }

    func AppendLiteral(s string) -> this.builder.Append(s)

    func AppendFormatted[T](value T) -> this.builder.Append(value?.ToString())

    func AppendFormatted[T](value T, alignment int32) {
        let text = value?.ToString() ?? string.Empty
        this.builder.Append(
            if alignment < 0 {
                text.PadRight(-alignment)
            } else {
                text.PadLeft(alignment)
            }
        )
    }

    func AppendFormatted[T](value T, format string) -> this.AppendFormatted(value, alignment: 0, format)

    func AppendFormatted[T](value T, alignment int32, format string) {
        let text = if value is IFormattable formattable {
            formattable.ToString(format, CultureInfo.InvariantCulture)
        } else {
            value?.ToString() ?? string.Empty
        }
        this.builder.Append(
            if alignment < 0 {
                text.PadRight(-alignment)
            } else {
                text.PadLeft(alignment)
            }
        )
    }

    override func ToString() string -> this.builder.ToString()
}

/// Issue #368 fixture: a handler whose constructor forwards the receiver
/// (the empty-string `[InterpolatedStringHandlerArgument("")]` form).
@InterpolatedStringHandler
struct ReceiverInterpolatedStringHandler {
    private let builder StringBuilder

    init(literalLength int32, formattedCount int32, log InterpolationLog) {
        this.builder = log.Buffer
    }

    func AppendLiteral(s string) -> this.builder.Append(s)

    func AppendFormatted[T](value T) -> this.builder.Append(value?.ToString())
}

/// Issue #368 fixture: a handler whose constructor declares an
/// `out bool shouldAppend` short-circuit parameter (set from a threshold)
/// and whose append methods are unconditional.
@InterpolatedStringHandler
struct GatedInterpolatedStringHandler {
    private let builder StringBuilder

    init(literalLength int32, formattedCount int32, enabled bool, out shouldAppend bool) {
        this.builder = StringBuilder(literalLength)
        shouldAppend = enabled
    }

    func AppendLiteral(s string) -> this.builder.Append(s)

    func AppendFormatted[T](value T) -> this.builder.Append(value?.ToString())

    override func ToString() string -> this.builder?.ToString() ?? "<gated>"
}

/// A mutable buffer used by (cref:ReceiverInterpolatedStringHandler) forwarding.
class InterpolationLog {
    init() {
        this.Buffer = StringBuilder()
    }

    prop Buffer StringBuilder {
        get;
    }

    func Append(@InterpolatedStringHandlerArgument("") handler ReceiverInterpolatedStringHandler) string -> this
        .Buffer
        .ToString()

    override func ToString() string -> this.Buffer.ToString()
}

/// Static consuming APIs for the issue #368 handler fixtures.
shared class InterpolationHarness {
    /// Issue #418 (P1-9): observes side effects of interpolated-string hole
    /// expressions. Tests increment this counter inside a hole and then verify
    /// it stays at zero when the handler gate (shouldAppend = false) skips
    /// the appends — proving holes are evaluated lazily, after the ctor.
    var HoleEvaluations int32

    func BumpAndReturn(value int32) int32 {
        Interlocked.Increment(&HoleEvaluations)
        return value
    }

    func BumpAndReturnAsync(value int32) Task[int32] {
        Interlocked.Increment(&HoleEvaluations)
        return Task.FromResult(value)
    }

    func ResetHoleEvaluations() -> HoleEvaluations = 0

    func Format(
        prefix string,
        @InterpolatedStringHandlerArgument("prefix") handler PrefixedInterpolatedStringHandler
    ) string {
        var handler = handler
        return handler.ToString()
    }

    func Gated(
        enabled bool,
        @InterpolatedStringHandlerArgument("enabled") handler GatedInterpolatedStringHandler
    ) string {
        var handler = handler
        return handler.ToString()
    }

    func Typed(
        prefix string,
        @InterpolatedStringHandlerArgument("prefix") handler TypedAppendInterpolatedStringHandler
    ) string {
        var handler = handler
        return handler.ToString()
    }
}

/// Issue #377 sub-item 1 fixture: a method that accepts the handler by `ref`.
/// Mirrors the BCL pattern used by APIs like
/// `StringBuilder.Append(ref AppendInterpolatedStringHandler)` where the
/// handler is a `ref struct` and must be passed by-ref.
shared class ByRefHandlerHarness {
    func AppendRef(
        prefix string,
        @InterpolatedStringHandlerArgument("prefix") ref handler PrefixedInterpolatedStringHandler
    ) string -> handler.ToString()

    func AppendIn(
        prefix string,
        @InterpolatedStringHandlerArgument("prefix") in handler PrefixedInterpolatedStringHandler
    ) string -> handler.ToString()
}

/// Issue #377 sub-item 2 fixture: a counter exposed to handler-forwarded
/// arguments so a hosting test can observe how many times the source
/// expression was evaluated. C# §11.18.1 mandates exactly-once evaluation;
/// G# pre-#377 re-evaluated forwarded args inside the handler constructor.
shared class ForwardCounter {
    var InvocationCount int32

    func IncrementAndReturn(value string) string {
        Interlocked.Increment(&InvocationCount)
        return value
    }

    func Reset() -> InvocationCount = 0
}

/// Issue #377 sub-item 4 fixture: two static overloads — one taking
/// (cref:object), one taking (cref:System.FormattableString).
/// Tests pass an interpolated string and verify the
/// `FormattableString` overload wins (matching C# §11.18.1's "more
/// specific target" rule).
shared class FormattableOverloadHarness {
    var LastChosen string = string.Empty

    func ChooseObject(value object) string {
        LastChosen = "object:" + (value?.ToString() ?? "<null>")
        return LastChosen
    }

    func ChooseObject(value FormattableString) string {
        LastChosen = "formattable:" + value.Format
        return LastChosen
    }

    func Reset() -> LastChosen = string.Empty
}

/// Issue #377 sub-item 5 fixture: a single overload taking
/// (cref:System.FormattableString). Tests pass an interpolated string
/// through a named argument (e.g. `M(f: $"…")`) and verify target
/// typing flows through the named-argument reorder.
shared class FormattableNamedArgHarness {
    var LastFormat string = string.Empty

    func AcceptNamed(f FormattableString) string {
        LastFormat = f.Format
        return f.ToString()
    }

    func Reset() -> LastFormat = string.Empty
}

/// Issue #418 (P1-10) fixture: a handler whose `AppendFormatted` overloads
/// are deliberately type-discriminated so the lowerer's overload resolution can
/// be observed. Each overload tags its appended text so a test can assert which
/// one was picked for a given hole's static type.
@InterpolatedStringHandler
struct TypedAppendInterpolatedStringHandler {
    private let builder StringBuilder

    init(literalLength int32, formattedCount int32, prefix string) {
        this.builder = StringBuilder(prefix.Length + literalLength)
        this.builder.Append(prefix)
    }

    func AppendLiteral(s string) -> this.builder.Append(s)

    func AppendFormatted(value int32) -> this.builder.Append("[int:").Append(value).Append(']')

    func AppendFormatted(value string) -> this.builder.Append("[str:").Append(value).Append(']')

    func AppendFormatted[T](value T) -> this.builder.Append("[T:").Append(value?.ToString()).Append(']')

    override func ToString() string -> this.builder.ToString()
}

/// Issue #1638 fixture: a CLR constructor whose sole parameter is
/// (cref:System.Action). Exercises the ctor call-construction pipeline's
/// delegate-argument rebind step (previously skipped only on the ctor path),
/// which must void-ize a value-returning arrow-lambda literal argument the
/// same way the instance/static/inherited call paths already do (issue #889).
open class Issue1638ActionCtorFixture {
    var Invoked bool

    init(callback() -> void) {
        callback()
        this.Invoked = true
    }
}

/// Issue #1638 fixture: a CLR base class exposing an instance method whose
/// parameter is (cref:System.FormattableString). A G# subclass that
/// does not override the method dispatches through the INHERITED CLR
/// instance-call path, which (before the fix) skipped
/// `RebindFormattableInterpolationArguments` entirely, so an
/// interpolated-string argument was never re-lowered to
/// `FormattableStringFactory.Create(...)` and could not bind against
/// this parameter.
open class Issue1638FormattableBaseFixture {
    func Render(fs FormattableString) string -> fs.ToString(CultureInfo.InvariantCulture)
}

/// Issue #1812 fixture: a static method whose sole parameter is
/// (cref:System.FormattableString). Exercises the STATIC CLR-call
/// dispatch path (`ImportedClassSymbol.TryLookupFunction` /
/// `BindAccessorCall`'s `classSymbol != null` branch in
/// `ExpressionBinder.Calls.cs`) with an interpolated-string argument,
/// mirroring (cref:Issue1638FormattableBaseFixture)'s
/// inherited-instance coverage but for a static call.
shared class Issue1812StaticFormattableFixture {
    func Render(fs FormattableString) string -> fs.ToString(CultureInfo.InvariantCulture)
}

/// Issue #1812 fixture: an `[Extension]` method whose sole non-receiver
/// parameter is (cref:System.FormattableString). Exercises the
/// EXTENSION-method CLR-call dispatch path
/// (`ExpressionBinder.TryBindImportedExtensionCall`) with an
/// interpolated-string argument.
shared class Issue1812ExtensionFormattableFixture { }

@ExtensionOwner(typeof(Issue1812ExtensionFormattableFixture))
func (receiver string) Render(fs FormattableString) string -> receiver + fs.ToString(CultureInfo.InvariantCulture)

/// Issue #1812 fixture: a CLR base class whose sole constructor parameter is
/// (cref:System.FormattableString). Exercises the
/// `: base(...)` BASE-CONSTRUCTOR CLR-call dispatch path
/// (`DeclarationBinder.ResolveClrBaseConstructor`) with an
/// interpolated-string argument — a companion gap found while auditing every
/// CLR-call `Resolve` site, not one of the five call shapes #1638
/// originally named.
open class Issue1812BaseCtorFormattableFixture {
    prop Rendered string {
        get;
    }

    init(fs FormattableString) {
        this.Rendered = fs.ToString(CultureInfo.InvariantCulture)
    }
}

/// Issue #1852 fixture: a CLR interface whose sole method takes a
/// (cref:System.FormattableString) parameter, used as a generic
/// type-parameter constraint (`T IIssue1852Renderer`) so a call on the
/// constrained receiver dispatches through
/// `ExpressionBinder.TryBindConstrainedClrInterfaceCall` — the sixth
/// CLR-call construction shape (found during the #1812 follow-up audit,
/// tracked as #1852) that must re-lower an interpolated-string argument to
/// the handler-shaped parameter just like the other five.
interface IIssue1852Renderer {
    func Render(fs FormattableString) string;

    func RenderTwo(tag string, fs FormattableString) string;
}

/// Issue #1852 fixture: a CLR struct implementing (cref:IIssue1852Renderer),
/// used as the type argument satisfying `T IIssue1852Renderer`.
struct Issue1852RendererFixture : IIssue1852Renderer {
    func Render(fs FormattableString) string -> fs.ToString(CultureInfo.InvariantCulture)

    func RenderTwo(tag string, fs FormattableString) string -> tag + ":" + fs.ToString(CultureInfo.InvariantCulture)
}
