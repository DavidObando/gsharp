// <copyright file="PlatformCoercion.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO

/// ADR-0186 §4: the runtime nil check inserted wherever a platform value
/// `T!` is coerced into a destination whose declared type is a non-null
/// reference type.
///
/// <b>One rule, one implementation.</b> §4's specification is a single
/// sentence, and the ADR is emphatic that the list of concrete sites beneath
/// it is <em>consequence, not an additional list</em>. Keeping the insertion
/// in one helper is how that stays true: a second copy is how ADR-0136's
/// carve-out predicates began, and failure mode 1 of the catalogue is
/// literally "the read path and the call path drifted".
///
/// The check reuses the existing `!!` lowering
/// (`dup; brtrue; pop; newobj NullReferenceException; throw`) rather than
/// inventing a node kind, which is deliberate: it inherits every lowering
/// stage, spiller and rewriter the operator already passes through, and the
/// exception type stays the one existing `catch` clauses in both G# and
/// interop code already expect. The whole improvement over an unattributed
/// NRE is the <em>message</em>.
internal shared class PlatformCoercion {
    /// Wraps [`expression`](paramref) in ADR-0186 §4's check when it is
    /// platform-typed, and returns it unchanged otherwise.
    /// @param expression The platform-typed value being coerced.
    /// @param location The coercion site, for the message.
    /// @param boundary A short phrase naming the boundary the value crossed — "an argument to
    /// a non-null parameter", "a member access receiver". It is what turns an
    /// NRE into an attributable one, which is §4's entire justification for
    /// preferring a call-site check over the CLR's own.
    /// @param suppressible Whether `--platform-nil-checks=off` may remove this check. True
    /// for every check the compiler INSERTS; false for the one the author
    /// WROTE (a user `!!` over a platform operand, which §6 calls the
    /// explicit spelling of the same coercion). The switch governs insertion,
    /// never an assertion already in the source.
    /// @returns The checked expression, or the original.
    internal func InsertCheck(
        expression BoundExpression,
        location TextLocation?,
        boundary string,
        suppressible bool = true
    ) BoundExpression {
        if expression.Type is not PlatformTypeSymbol platform {
            return expression
        }
        // `--platform-nil-checks=off` suppresses the CHECK. It must not
        // suppress the UNWRAP, and the two were coupled here at first: this
        // helper is also §5's mechanism — replacing a platform receiver with
        // one typed at the bare underlying is what makes member lookup run
        // against `T` by construction — so returning the still-wrapped
        // expression turned working indexer and `for … in` code into GS0116
        // "not indexable" compile errors under a switch whose entire purpose
        // is to remove a runtime check for measurement.
        //
        // A conversion node carries the unwrap with no IL of its own: the
        // emitter's second arm tests
        // `AreRuntimeEquivalentIgnoringReferenceNullability`, which strips a
        // platform wrapper by design (§1 — `T!` and `T` genuinely are one
        // runtime type), so this lowers to the operand and nothing else.
        if suppressible && !NullabilityOptions.PlatformNilChecksEnabled {
            return BoundConversionExpression(expression.Syntax, platform.UnderlyingType, expression)
        }
        let check BoundUnaryOperator? = BoundUnaryOperator.Bind(SyntaxKind.BangBangToken, platform)
        if check == nil {
            return expression
        }
        return BoundUnaryExpression(
            expression.Syntax,
            check,
            expression,
            isChecked: false,
            platformCheckMessage: BuildMessage(expression, platform, location, boundary)
        )
    }

    /// ADR-0186 §4 for a <b>delegate invocation target</b>: the delegate value
    /// that `f(args)`, `(expr)(args)` or `x.F(args)` invokes.
    ///
    /// Every binder path that invokes a delegate value routes through here,
    /// so the invocation shapes can't drift apart. Issue #4325 fixed the
    /// local and parenthesised-callee shapes; the member-value shapes
    /// (`x.F()` on a G#-declared, imported-instance or imported-static
    /// field or property) still invoked a nil `Func[string]!` with an
    /// unattributed NRE until they were routed here too. A null-conditional
    /// `f?(…)` never calls this: its guard already tests for nil, so no
    /// coercion to non-null occurs.
    /// @param target The delegate value being invoked.
    /// @param location The invocation site, for the message.
    /// @returns The checked target, or the original when it is not platform-typed.
    internal func CheckDelegateInvocationTarget(
        target BoundExpression,
        location TextLocation?
    ) BoundExpression -> InsertCheck(target, location, "a delegate invocation target")

    /// ADR-0186 §4's message shape: `"<expr> was nil
    /// (nullability-oblivious value from <origin>) at
    /// <file>:<line>"`.
    /// @param expression The checked expression.
    /// @param platform Its platform type.
    /// @param location The coercion site.
    /// @param boundary The boundary phrase.
    /// @returns The exception message.
    private func BuildMessage(
        expression BoundExpression,
        platform PlatformTypeSymbol,
        location TextLocation?,
        boundary string
    ) string {
        // Failure mode 3 of ADR-0186's catalogue was a safety check gated on
        // having receiver syntax available TO QUOTE IN A MESSAGE: a chained
        // call's intermediate receivers are bound with a null `Syntax`, so
        // `s.ToUpper().Trim()` skipped the check entirely while `s.ToUpper()`
        // did not. The lesson is not "find better syntax" but "a message
        // formatting detail must never decide whether a check runs" — so the
        // text degrades and the check is unconditional.
        let description = DescribeExpression(expression) ?? "a ${platform.Name} value"
        let origin = DescribeOrigin(platform)
        let at = DescribeLocation(location)
        return "$description was nil ($origin), coerced at $boundary$at."
    }

    /// Renders the source text of an expression, when it has any.
    /// @param expression The checked expression.
    /// @returns The quoted source text, or `null`.
    private func DescribeExpression(expression BoundExpression) string? {
        let syntax SyntaxNode? = expression.Syntax
        let text SourceText? = syntax?.Location.Text
        if syntax == nil || text == nil {
            return nil
        }
        var span = syntax.Location.Span
        if span.Length <= 0 || span.End > text.Length {
            return nil
        }
        let source = text.ToString(span).Trim()
        // A long or multi-line expression makes an unreadable exception
        // message; the file:line below already locates it exactly.
        if source.Length == 0 || source.Length > 80 || source.Contains('\n') {
            return nil
        }
        return "'" + source + "'"
    }

    /// Names what kind of value failed. This is the half of the message a
    /// reader actually needs: the value is not nil because the program is
    /// wrong, but because nobody ever stated whether it could be.
    ///
    /// ADR-0186 §4's sketch writes this as "from <origin>", meaning the
    /// oblivious <em>declaration</em>. That is deliberately not rendered as an
    /// assembly name here, because the only assembly reachable from a
    /// (cref:PlatformTypeSymbol) is the one declaring `T` itself —
    /// `System.Runtime` for a `string!` — which names the wrong
    /// thing and would actively mislead. The declaring member is not in reach
    /// at the coercion point; naming the type and the boundary is the honest
    /// subset, and the file:line that follows locates the rest.
    /// @param platform The platform type.
    /// @returns The origin phrase.
    private func DescribeOrigin(platform PlatformTypeSymbol) string -> "a nullability-oblivious ${platform.Name}"

    /// Renders the coercion site as `file:line`.
    /// @param location The coercion site.
    /// @returns The rendered suffix, or the empty string.
    private func DescribeLocation(location TextLocation?) string {
        var present TextLocation? = location
        if present == nil {
            return string.Empty
        }
        let text SourceText? = present.Text
        if text == nil {
            return string.Empty
        }
        if present.Span.Start > text.Length {
            return string.Empty
        }
        // Only the file NAME, never the full path: the message is baked into
        // the emitted assembly as a user string, and a build-machine absolute
        // path there would break deterministic/reproducible builds.
        let file = if present.FileName is {Length: > 0} fileName {
            Path.GetFileName(fileName)
        } else {
            "<unknown>"
        }
        return " in $file:${present.StartLine + 1}"
    }
}
