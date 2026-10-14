// <copyright file="EmitDiagnosticException.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import System
import System.Diagnostics.CodeAnalysis
import System.Runtime.CompilerServices
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis
import System.Globalization

/// A typed exception that the emit pipeline wraps around internal failures so
/// that the (cref:Compilation.Compilation.Emit(System.IO.Stream, System.IO.Stream))
/// catch boundary can anchor the resulting `GS9998` diagnostic at the
/// offending source construct rather than a hard-coded `(1,1,1,1)`.
internal class EmitDiagnosticException : Exception {
    /// Initializes a new instance of the (cref:EmitDiagnosticException) class.
    /// @param message A human-readable message describing the emit failure.
    /// @param anchor The syntax node nearest to the failure, or `null`.
    /// @param innerException The original exception, if wrapping one.
    init(message string, anchor SyntaxNode?, innerException Exception? = nil) : base(message, innerException) {
        Anchor = anchor
    }

    /// Initializes a new instance of the (cref:EmitDiagnosticException)
    /// class that reports a specific diagnostic rather than the GS9998
    /// internal-error catch-all.
    /// @param diagnosticId The diagnostic id to report.
    /// @param message The diagnostic's message, used verbatim.
    /// @param anchor The syntax node nearest to the failure, or `null`.
    private init(diagnosticId string, message string, anchor SyntaxNode?) : base(message) {
        Anchor = anchor
        DiagnosticId = diagnosticId
    }

    /// Gets the diagnostic id this failure should be reported as, or
    /// `null` to fall back to GS9998.
    ///
    /// Issue #3755: an emit-time well-known member the <em>target framework</em>
    /// does not declare is a condition of the user's reference closure, not a
    /// compiler bug, so it must not be dressed up as an internal error. The
    /// emit pipeline has no `DiagnosticBag` in scope (see
    /// `MethodBodyEmitter.Expressions.cs`), so the existing exception
    /// channel carries the id instead of a new sink being threaded through it.
    prop DiagnosticId string? {
        get;
    }

    /// Gets the best-known source location for the failure. May be `null`
    /// when no syntax context was available at the throw site.
    prop Anchor SyntaxNode? {
        get;
    }

    shared {
        /// Throws a failure that surfaces as `GS0546`: the referenced target
        /// framework does not declare a member the lowering emits a call to.
        /// @param anchor The syntax node nearest to the failure, or `null`.
        /// @param missingMember The member the target does not provide.
        @DoesNotReturn
        func ThrowTargetFrameworkMemberUnavailable(anchor SyntaxNode?, missingMember string) {
            let descriptor = DiagnosticDescriptors.TargetFrameworkMemberUnavailable
            throw EmitDiagnosticException(
                descriptor.Id,
                string.Format(CultureInfo.InvariantCulture, descriptor.MessageFormat, missingMember),
                anchor
            )
        }

        /// Throws a failure that surfaces as `GS0583`: an attribute whose
        /// arguments match no constructor of the attribute type.
        /// @remarks Issue #4097: the emitter used to treat "no candidate matched" as
        /// "nothing to emit" and dropped the whole CustomAttribute row with no
        /// diagnostic at all, so the author asked for metadata and got silence.
        /// Constructor SELECTION is the emitter's own applicability rule
        /// (`ArgAssignable` over the resolved constructor set, including
        /// params-array expansion) and the emit pipeline has no
        /// `DiagnosticBag` in scope, so the failure travels this channel the
        /// way GS0546 does.
        /// @param anchor The annotation, or `null`.
        /// @param attributeName The attribute type's name.
        /// @param argumentList The supplied argument types, comma-separated.
        @DoesNotReturn
        func ThrowAttributeConstructorNotFound(anchor SyntaxNode?, attributeName string, argumentList string) {
            let descriptor = DiagnosticDescriptors.AttributeConstructorNotFound
            throw EmitDiagnosticException(
                descriptor.Id,
                string.Format(CultureInfo.InvariantCulture, descriptor.MessageFormat, attributeName, argumentList),
                anchor
            )
        }

        /// Throws a failure that surfaces as `GS0584`: a user-defined
        /// attribute one of whose constructor parameters is not a valid attribute
        /// parameter type.
        /// @remarks Issue #4097's sibling cause. The row used to be dropped in
        /// silence; this is the last line that stops it vanishing.
        ///
        /// Its population was MEASURED rather than assumed, over a probe
        /// comparing gsc against csc on the same shapes: every shape that reaches
        /// here is one C# rejects as CS0181 — a same-compilation class, interface,
        /// delegate, or a structural type. There is no legal-but-unencodable
        /// residue, so this does NOT claim an encoder limit. The one shape that
        /// looked like one, a same-compilation enum parameter, is encoded through
        /// its underlying primitive instead (issue #4135); the Oahu corpus carries
        /// it, and reporting it here took four of that corpus's apps red.
        ///
        /// Emit is the wrong PLACE for this check — it belongs on the
        /// attribute's declaration, once, the way csc reports CS0181 — but G# has
        /// no such bind-time rule today, so these programs reach emit unchecked.
        /// Filed as issue #4143; when it lands this becomes unreachable and can
        /// retire.
        /// @param anchor The annotation, or `null`.
        /// @param parameterName The offending constructor parameter.
        /// @param attributeName The attribute type's name.
        /// @param parameterTypeName The parameter's declared type.
        @DoesNotReturn
        func ThrowAttributeConstructorParameterTypeNotSupported(
            anchor SyntaxNode?,
            parameterName string,
            attributeName string,
            parameterTypeName string
        ) {
            let descriptor = DiagnosticDescriptors.AttributeConstructorParameterTypeNotSupported
            throw EmitDiagnosticException(
                descriptor.Id,
                string.Format(
                    CultureInfo.InvariantCulture,
                    descriptor.MessageFormat,
                    parameterName,
                    attributeName,
                    parameterTypeName
                ),
                anchor
            )
        }

        /// Throws a specific user-facing emit diagnostic.
        /// @param anchor The source construct nearest the failure.
        /// @param descriptor The diagnostic to report.
        /// @param arguments Message-format arguments.
        @DoesNotReturn
        func ThrowDiagnostic(anchor SyntaxNode?, descriptor DiagnosticDescriptor, arguments ...object?) {
            throw EmitDiagnosticException(
                descriptor.Id,
                string.Format(CultureInfo.InvariantCulture, descriptor.MessageFormat, arguments),
                anchor
            )
        }

        /// Throws an (cref:EmitDiagnosticException) anchored at the given
        /// syntax node. Use this helper at call sites that previously threw
        /// (cref:InvalidOperationException) or (cref:NotSupportedException).
        /// @param anchor The syntax node nearest to the failure, or
        /// `null` for a synthesized node with no source counterpart.
        /// @param message A human-readable message describing the failure.
        @DoesNotReturn
        func Throw(anchor SyntaxNode?, message string) {
            throw EmitDiagnosticException(message, anchor)
        }

        /// Wraps an existing exception in an (cref:EmitDiagnosticException)
        /// preserving the inner exception and anchoring at the given syntax node.
        /// @param anchor The syntax node nearest to the failure, or
        /// `null` for a synthesized node with no source counterpart.
        /// @param innerException The original exception to wrap.
        @DoesNotReturn
        func Wrap(anchor SyntaxNode?, innerException Exception) {
            throw EmitDiagnosticException(
                "${innerException.GetType().Name}: ${innerException.Message}",
                anchor,
                innerException
            )
        }
    }
}
