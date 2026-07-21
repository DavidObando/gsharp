// <copyright file="CSharpToGSharpTranslator.Invocations.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;
using Microsoft.CodeAnalysis.Text;

namespace Cs2Gs.Translator;

public sealed partial class CSharpToGSharpTranslator
{
    private sealed partial class DeclarationVisitor
    {
        private GExpression TranslateInvocation(InvocationExpressionSyntax invocation)
        {
            GExpression target;
            IReadOnlyList<GTypeReference> typeArguments = null;

            // Issue #2351: an extension-method call site (reduced instance
            // form, unreduced static form, or a bare sibling static call)
            // names no type, so it never flows through
            // CSharpTypeMapper.TrackShortenedNamespace (issue #2211's
            // type-import tracking). Track its declaring namespace here so an
            // import is still synthesized when the file relies on an
            // implicit/global `using` for it (e.g. `<ImplicitUsings>enable`
            // supplying `System.Linq`).
            if (this.context.GetSymbolInfo(invocation).Symbol is IMethodSymbol { IsExtensionMethod: true } invocationExtMethod)
            {
                this.typeMapper.TrackExtensionMethodNamespace(invocationExtMethod);
            }

            // Issue #1893: `grid.GetLength(k)` against a genuine multi-dim array
            // (Rank > 1) has no meaning on the flat backing array gsc actually
            // holds (a rank-1 `.GetLength(1)` throws
            // IndexOutOfRangeException at runtime — the original bug's crash).
            // For a tracked array with a compile-time-constant `k`, substitute
            // the corresponding hoisted/constant dimension size directly.
            if (invocation.Expression is MemberAccessExpressionSyntax { Name.Identifier.Text: "GetLength" } getLengthMember &&
                invocation.ArgumentList.Arguments.Count == 1 &&
                this.context.GetTypeInfo(getLengthMember.Expression).Type is IArrayTypeSymbol { Rank: > 1 })
            {
                ISymbol receiverSymbol = this.context.GetSymbolInfo(getLengthMember.Expression).Symbol;
                Optional<object> constantDimIndex =
                    this.context.SemanticModel.GetConstantValue(invocation.ArgumentList.Arguments[0].Expression);
                if (receiverSymbol != null &&
                    this.state.MultiDimArrays.TryGetValue(receiverSymbol, out MultiDimArrayInfo getLengthInfo) &&
                    constantDimIndex.HasValue &&
                    constantDimIndex.Value is int dimIndex &&
                    dimIndex >= 0 &&
                    dimIndex < getLengthInfo.DimensionSizes.Count)
                {
                    return getLengthInfo.DimensionSizes[dimIndex];
                }

                string getLengthGapMessage =
                    "Array.GetLength on a multi-dimensional array requires a tracked receiver (a local " +
                    "initialized directly from `new T[d0, d1, ...]` or a rectangular initializer) and a " +
                    "compile-time-constant dimension index; this call has no canonical G# mapping yet.";
                this.context.ReportUnsupported(invocation, getLengthGapMessage);
                return LiteralExpression.Int("0");
            }

            // C# delegate/event invocation `d.Invoke(args)` / `d?.Invoke(args)` maps
            // to G#'s direct function-call form `d(args)` / `d?(args)`: G# invokes a
            // function-typed value (delegate field or event) directly and has no
            // `.Invoke` member (`.Invoke` would be GS0159). Detected via the
            // delegate's synthesized `Invoke` method (MethodKind.DelegateInvoke).
            if (this.context.GetSymbolInfo(invocation).Symbol is IMethodSymbol
                    { MethodKind: MethodKind.DelegateInvoke }
                && TryGetDelegateInvokeReceiver(invocation.Expression, out GExpression invokeTarget))
            {
                var invokeArguments = this.TranslateCallArguments(invocation, invocation.ArgumentList.Arguments);
                return new InvocationExpression(invokeTarget, invokeArguments, null);
            }

            // A C# extension method whose receiver is an enum is emitted as a
            // plain static helper (a receiver clause is rejected on enums,
            // GS0103). Rewrite the call `x.M(args)` to the positional form
            // `Owner.M(x, args)` so it binds to that helper.
            if (invocation.Expression is MemberAccessExpressionSyntax extMember
                && this.context.GetSymbolInfo(invocation).Symbol is IMethodSymbol extMethod
                && TryGetEnumExtension(extMethod, out string extOwner, out string extName))
            {
                var extArgs = new List<GExpression>
                {
                    this.TranslateExpression(extMember.Expression),
                };
                extArgs.AddRange(this.TranslateArguments(invocation.ArgumentList.Arguments));
                IReadOnlyList<GTypeReference> extTypeArgs = extMember.Name is GenericNameSyntax extGeneric
                    ? this.MapTypeArguments(extGeneric)
                    : null;
                return new InvocationExpression(
                    new MemberAccessExpression(new IdentifierExpression(extOwner), extName),
                    extArgs,
                    extTypeArgs);
            }

            // A SOURCE-defined extension method called in STATIC (unreduced) form
            // `Owner.M<T>(recv, args)` — as opposed to the instance form
            // `recv.M<T>(args)` — must be rewritten to the G# receiver-clause call
            // `recv.M[T](args)`. cs2gs lifts every non-enum source extension method
            // of a `static class` to a top-level receiver-clause `func (recv R) M[…](…)`
            // (ADR-0115 §B.19), which gsc invokes ONLY through the receiver form; the
            // static-form call site (`JsonSerialization.FromJsonFile<T>(path)`) would
            // otherwise resolve to a non-existent static member (GS0158). The reduced
            // instance form already binds directly, so it is excluded via
            // `MethodKind.ReducedExtension`. Scoped to source-defined, non-enum
            // extensions to avoid rewriting BCL static-form calls (enum receivers
            // take the positional path above).
            if (invocation.Expression is MemberAccessExpressionSyntax staticExtMember
                && staticExtMember.Expression is TypeSyntax or IdentifierNameSyntax or MemberAccessExpressionSyntax
                && this.context.SemanticModel.GetOperation(invocation) is IInvocationOperation staticExtOperation
                && staticExtOperation.TargetMethod is IMethodSymbol
                    { IsExtensionMethod: true, MethodKind: not MethodKind.ReducedExtension } staticExt
                && staticExt.Parameters.Length >= 1
                && !(staticExt.ReducedFrom ?? staticExt).DeclaringSyntaxReferences.IsDefaultOrEmpty
                && (staticExt.Parameters[0].Type?.TypeKind ?? TypeKind.Unknown) != TypeKind.Enum
                && this.context.SemanticModel.GetSymbolInfo(staticExtMember.Expression).Symbol is INamedTypeSymbol
                && TryGetExplicitExtensionReceiverArgument(
                    staticExtOperation,
                    staticExt,
                    out IArgumentOperation staticExtReceiverArgument))
            {
                GExpression staticExtReceiver = this.TranslateStaticExtensionReceiver(staticExtReceiverArgument);
                var staticExtRest = this.TranslateStaticExtensionTrailingArguments(invocation);
                IReadOnlyList<GTypeReference> staticExtTypeArgs =
                    staticExtMember.Name is GenericNameSyntax staticExtGeneric
                        ? this.MapTypeArguments(staticExtGeneric)
                        : null;
                return new InvocationExpression(
                    new MemberAccessExpression(
                        staticExtReceiver,
                        SanitizeIdentifier((staticExt.ReducedFrom ?? staticExt).Name)),
                    staticExtRest,
                    staticExtTypeArgs);
            }

            // A SOURCE-defined extension method called through its BARE name
            // (`ApplicableState(book.Conversion)`) — the unqualified static form a
            // sibling member inside the declaring `static class` uses — must be
            // rewritten to the G# receiver-clause call `book.Conversion.ApplicableState()`
            // for the same reason as the `Owner.M(recv, args)` static form above:
            // cs2gs lifts every non-enum source extension method to a top-level
            // receiver-clause `func (recv R) M[…](…)` (ADR-0115 §B.19), which gsc
            // invokes ONLY through the receiver form. Without this the bare call
            // falls through to the sibling-static-call branch below and is qualified
            // as `EntityExtensions.ApplicableState(...)`, but the lifted extension
            // leaves no `EntityExtensions` type behind (GS0157). The reduced instance
            // form already binds directly (`MethodKind.ReducedExtension` excluded),
            // and enum receivers keep the positional `Owner.M(x)` helper form.
            if (invocation.Expression is SimpleNameSyntax bareExtName
                && bareExtName is IdentifierNameSyntax or GenericNameSyntax
                && this.context.SemanticModel.GetOperation(invocation) is IInvocationOperation bareExtOperation
                && bareExtOperation.TargetMethod is IMethodSymbol
                    { IsExtensionMethod: true, MethodKind: not MethodKind.ReducedExtension } bareExt
                && bareExt.Parameters.Length >= 1
                && !(bareExt.ReducedFrom ?? bareExt).DeclaringSyntaxReferences.IsDefaultOrEmpty
                && (bareExt.Parameters[0].Type?.TypeKind ?? TypeKind.Unknown) != TypeKind.Enum
                && TryGetExplicitExtensionReceiverArgument(
                    bareExtOperation,
                    bareExt,
                    out IArgumentOperation bareExtReceiverArgument))
            {
                GExpression bareExtReceiver = this.TranslateStaticExtensionReceiver(bareExtReceiverArgument);
                var bareExtRest = this.TranslateStaticExtensionTrailingArguments(invocation);
                IReadOnlyList<GTypeReference> bareExtTypeArgs =
                    bareExtName is GenericNameSyntax bareExtGeneric
                        ? this.MapTypeArguments(bareExtGeneric)
                        : null;
                return new InvocationExpression(
                    new MemberAccessExpression(
                        bareExtReceiver,
                        SanitizeIdentifier((bareExt.ReducedFrom ?? bareExt).Name)),
                    bareExtRest,
                    bareExtTypeArgs);
            }

            // A generic call `Foo<T>(...)` carries its type arguments on the name;
            // lift them onto the G# bracket-type-argument form `Foo[T](...)`.
            if (invocation.Expression is GenericNameSyntax generic)
            {
                target = new IdentifierExpression(SanitizeIdentifier(generic.Identifier.Text));
                typeArguments = this.MapTypeArguments(generic);
            }
            else if (invocation.Expression is MemberAccessExpressionSyntax member
                && member.Name is GenericNameSyntax memberGeneric)
            {
                target = new MemberAccessExpression(
                    this.TranslateExpression(member.Expression),
                    SanitizeIdentifier(memberGeneric.Identifier.Text));
                typeArguments = this.MapTypeArguments(memberGeneric);
            }
            else if (invocation.Expression is MemberBindingExpressionSyntax memberBinding
                && memberBinding.Name is GenericNameSyntax memberBindingGeneric)
            {
                // A generic call chained after a null-conditional `?.`
                // (`x?.GetChild<HdlrBox>()`) reaches here as a member-binding
                // whose name carries the type arguments. Preserve them on the
                // bracket-type-argument form so the chained call keeps `[T...]`.
                target = new MemberAccessExpression(
                    new ConditionalReceiverExpression(),
                    SanitizeIdentifier(memberBindingGeneric.Identifier.Text));
                typeArguments = this.MapTypeArguments(memberBindingGeneric);
            }
            else if (invocation.Expression is IdentifierNameSyntax bareName &&
                this.context.GetSymbolInfo(bareName).Symbol is IMethodSymbol { IsStatic: true, MethodKind: not MethodKind.LocalFunction } staticMethod &&
                staticMethod.ContainingType is { TypeKind: TypeKind.Class or TypeKind.Struct } owner &&
                !owner.IsImplicitlyDeclared &&
                !this.IsStaticUsingTarget(owner) &&
                !SymbolEqualityComparer.Default.Equals(owner.OriginalDefinition, this.entryType?.OriginalDefinition))
            {
                // A C# bare sibling static call (`Round(value, 2)`) carries an
                // implicit type qualifier. A G# `shared` method body has no
                // implicit type scope, so the call must be qualified through the
                // owning type (`Geometry.Round(value, 2)`); see ADR-0115 §B.18.
                // A bare call to a `using static` member is the exception
                // (ADR-0134): gsc brings it into scope through `import Owner`,
                // so it is left unqualified above.
                // Issue #1886: a `static` LOCAL function is NOT a sibling type
                // member — Roslyn still reports its enclosing TYPE as
                // `ContainingType`, but cs2gs already lowers it to a local `let`
                // binding (see TranslateLocalFunction), so its call must stay a
                // bare identifier call, never `Owner.Name(...)`. Excluded above
                // via `MethodKind: not MethodKind.LocalFunction`.
                target = new MemberAccessExpression(
                    this.StaticQualifierReceiver(owner, bareName.GetLocation()),
                    staticMethod.Name);
            }
            else
            {
                target = this.TranslateExpression(invocation.Expression);
            }

            var arguments = this.TranslateCallArguments(invocation, invocation.ArgumentList.Arguments);

            // Directly invoking a nullable delegate value needs the same receiver
            // forgiveness as `.Invoke(...)`: fields/properties retain #1594's
            // behavior, while issue #2506 adds promoted method/property/indexer
            // results such as `FindFactory()()`. Keep the decision receiver-only
            // so callable-return taint is asserted on the produced delegate value,
            // never on a method group.
            if (this.context.GetSymbolInfo(invocation).Symbol is IMethodSymbol
                    { MethodKind: MethodKind.DelegateInvoke }
                && (this.ReceiverNeedsNullForgiveness(
                        invocation.Expression,
                        isDereferenceReceiver: true)
                    || this.ReceiverIsNullableReferenceFieldOrProperty(invocation.Expression)))
            {
                target = new NonNullAssertionExpression(target);
            }

            return new InvocationExpression(target, arguments, typeArguments);
        }

        private static bool TryGetExplicitExtensionReceiverArgument(
            IInvocationOperation invocation,
            IMethodSymbol method,
            out IArgumentOperation receiver)
        {
            IParameterSymbol receiverParameter = (method.ReducedFrom ?? method).Parameters[0];
            receiver = invocation.Arguments.FirstOrDefault(argument =>
                argument.ArgumentKind != ArgumentKind.DefaultValue
                && argument.Syntax is ArgumentSyntax
                && SymbolEqualityComparer.Default.Equals(
                    argument.Parameter?.OriginalDefinition,
                    receiverParameter.OriginalDefinition));
            return receiver != null;
        }

        private GExpression TranslateStaticExtensionReceiver(IArgumentOperation receiverArgument)
        {
            ExpressionSyntax expression = ((ArgumentSyntax)receiverArgument.Syntax).Expression;
            var translated = this.TranslateExpression(expression);
            translated = this.ForgiveNullableReferenceValue(
                expression,
                translated,
                receiverArgument.Parameter?.Type,
                receiverArgument.Parameter);
            IOperation value = receiverArgument.Value;

            while (value is IConversionOperation { IsImplicit: true } implicitConversion)
            {
                value = implicitConversion.Operand;
            }

            if (value is IConditionalAccessOperation
                or ICoalesceOperation
                or IConditionalOperation
                or IAwaitOperation
                or IConversionOperation { IsImplicit: false })
            {
                return translated is ParenthesizedExpression
                    ? translated
                    : new ParenthesizedExpression(translated);
            }

            return ParenthesizeIfBareNumericLiteral(translated);
        }

        private List<GExpression> TranslateStaticExtensionTrailingArguments(
            InvocationExpressionSyntax invocation)
        {
            List<GExpression> translated = this.TranslateCallArguments(
                invocation,
                invocation.ArgumentList.Arguments);
            if (translated.Count != 0)
            {
                translated.RemoveAt(0);
            }

            return translated;
        }

        // Resolves the receiver of a delegate/event `.Invoke(...)` call to the value
        // that G# invokes directly. `d.Invoke(...)` → `d`; the null-conditional
        // `d?.Invoke(...)` form reaches here as a member-binding whose receiver is the
        // conditional-receiver placeholder (so the enclosing `?.` renders `d?(...)`).
        // The null-conditional rewrite is only applied when the conditional-access
        // receiver is a simple identifier/member/`this` expression: G# parses
        // `complexExpr?(args)` (e.g. a call or index receiver ending in `)`/`]`) as
        // the ternary operator (`expr ? a : b`), so those keep the explicit `.Invoke`.
        private bool TryGetDelegateInvokeReceiver(
            ExpressionSyntax callee, out GExpression receiver)
        {
            switch (callee)
            {
                case MemberAccessExpressionSyntax member
                    when member.Name.Identifier.Text == "Invoke":
                    // A nullable delegate/event receiver spelled `field.Invoke(...)`
                    // needs the same `!!` the direct-call spelling `field(...)` gets
                    // below (#1598): route through the shared receiver-forgiveness
                    // helper rather than a bare translate, or the `.Invoke` spelling
                    // bypasses the assertion and emits an unforgiven `field(...)`
                    // (GS0131).
                    receiver = this.TranslateReceiverWithNullForgiveness(member.Expression);
                    return true;

                case MemberBindingExpressionSyntax binding
                    when binding.Name.Identifier.Text == "Invoke"
                        && IsSimpleConditionalInvokeReceiver(binding):
                    receiver = new ConditionalReceiverExpression();
                    return true;

                default:
                    receiver = null;
                    return false;
            }
        }

        // Reports whether the conditional-access receiver enclosing a `?.Invoke(...)`
        // member-binding is a form G# can null-conditionally invoke as `recv?(args)`
        // without colliding with the ternary operator — i.e. an identifier, a member
        // access, or `this` (its last token is an identifier), but NOT a call/index/
        // parenthesized receiver (whose trailing `)`/`]` makes `recv?(` parse as a
        // ternary condition).
        private static bool IsSimpleConditionalInvokeReceiver(
            MemberBindingExpressionSyntax binding)
        {
            if (binding.Parent is not InvocationExpressionSyntax invocation ||
                invocation.Parent is not ConditionalAccessExpressionSyntax conditional)
            {
                return false;
            }

            return conditional.Expression is IdentifierNameSyntax
                or MemberAccessExpressionSyntax
                or ThisExpressionSyntax;
        }

        /// <summary>
        /// Rewrites a null-conditional call to an enum extension method
        /// (<c>recv?.M(args)</c> where <c>M</c> is <c>this EnumType</c>) into the
        /// ternary <c>if recv != nil { Owner.M(recv!!, args) } else { nil }</c>.
        /// An enum extension is emitted as a plain static helper (a G# receiver
        /// clause is rejected on enums, GS0103), so the <c>?.</c> member-binding
        /// form cannot bind to it; gsc reports GS0159. The receiver is a pure
        /// expression in practice, so the duplicated evaluation is safe.
        /// </summary>
        private bool TryTranslateNullConditionalEnumExtension(
            ConditionalAccessExpressionSyntax conditionalAccess,
            out GExpression result)
        {
            result = null;

            if (conditionalAccess.WhenNotNull is not InvocationExpressionSyntax invocation ||
                invocation.Expression is not MemberBindingExpressionSyntax binding)
            {
                return false;
            }

            if (this.context.GetSymbolInfo(invocation).Symbol is not IMethodSymbol method ||
                !TryGetEnumExtension(method, out string owner, out string name))
            {
                return false;
            }

            GExpression receiver = this.TranslateExpression(conditionalAccess.Expression);

            var callArgs = new List<GExpression>
            {
                new NonNullAssertionExpression(receiver),
            };
            callArgs.AddRange(this.TranslateArguments(invocation.ArgumentList.Arguments));
            IReadOnlyList<GTypeReference> callTypeArgs = binding.Name is GenericNameSyntax generic
                ? this.MapTypeArguments(generic)
                : null;

            GExpression call = new InvocationExpression(
                new MemberAccessExpression(new IdentifierExpression(owner), name),
                callArgs,
                callTypeArgs);

            GExpression guard = new BinaryExpression(
                this.TranslateExpression(conditionalAccess.Expression),
                "!=",
                new IdentifierExpression("nil"));

            result = new ParenthesizedExpression(
                new IfExpression(guard, call, new IdentifierExpression("nil")));
            return true;
        }

        // Issue #914 (oblivious sink): a null-conditional delegate/event invoke
        // `recv?.Invoke(args)` whose receiver is a NON-simple expression (a call,
        // parenthesized, or `??` expression) has no direct G# spelling —
        // `recv?(args)` parses `recv` ending in `)`/`]` as a ternary condition
        // (GS0155), and gsc cannot resolve the `.Invoke` MEMBER on a function
        // whose type mentions a type parameter (`(T) -> R`, GS0159). The only
        // form gsc accepts is the direct null-conditional call on a *local*, so
        // spill the receiver into a single-evaluation `let` and invoke that:
        // `recv?.Invoke(a)` → `let __spillN = recv` + `__spillN?(a)`. Requires an
        // active spill seam (an arrow/statement body) to host the `let`; without
        // one, defer to the existing `.Invoke` path, which is already correct for
        // the non-type-parameter receiver shapes that reach here seam-less.
        private bool TryTranslateNullConditionalDelegateInvoke(
            ConditionalAccessExpressionSyntax conditionalAccess,
            out GExpression result)
        {
            result = null;

            if (this.state.PendingSpillPrologue == null
                || conditionalAccess.WhenNotNull is not InvocationExpressionSyntax invocation
                || invocation.Expression is not MemberBindingExpressionSyntax binding
                || binding.Name.Identifier.Text != "Invoke")
            {
                return false;
            }

            if (this.context.GetSymbolInfo(invocation).Symbol
                is not IMethodSymbol { MethodKind: MethodKind.DelegateInvoke })
            {
                return false;
            }

            // A simple identifier/member/`this` receiver already lowers to the
            // direct `recv?(args)` form via TryGetDelegateInvokeReceiver — leave
            // it untouched so the common case stays spill-free and byte-identical.
            if (conditionalAccess.Expression is IdentifierNameSyntax
                or MemberAccessExpressionSyntax
                or ThisExpressionSyntax)
            {
                return false;
            }

            GExpression receiver = this.SpillOperand(
                this.TranslateExpression(conditionalAccess.Expression));
            var invokeArguments = this.TranslateCallArguments(invocation, invocation.ArgumentList.Arguments);
            result = new ConditionalAccessExpression(
                receiver,
                new InvocationExpression(new ConditionalReceiverExpression(), invokeArguments, null));
            return true;
        }

        /// <summary>
        /// Issue #1879: resolves the real declaring static class for a C# 14
        /// extension-block member. Roslyn declares such a member on a synthetic
        /// marker type (<c>INamedTypeSymbol.IsExtension</c>, named
        /// <c>"extension(T)"</c>) nested inside the class that physically owns the
        /// emitted G# member; this returns that enclosing class.
        /// </summary>
        /// <param name="symbol">The bound call-site symbol (method or property).</param>
        /// <param name="owner">The real declaring class when matched.</param>
        /// <returns><see langword="true"/> when <paramref name="symbol"/> is a C# 14 extension-block member.</returns>
        private static bool TryGetExtensionBlockOwner(ISymbol symbol, out INamedTypeSymbol owner)
        {
            owner = symbol?.ContainingType is { IsExtension: true } marker ? marker.ContainingType : null;
            return owner != null;
        }

        /// <summary>
        /// Determines whether <paramref name="method"/> is a C# extension method
        /// whose receiver (<c>this</c>) parameter is an enum. Such an extension
        /// cannot carry a G# receiver clause (ADR-0079; gsc reports GS0103), so it
        /// is emitted as a plain static helper and its call sites are rewritten to
        /// the positional form <c>Owner.Method(receiver, …)</c>.
        /// </summary>
        /// <param name="method">The bound (possibly reduced) call symbol.</param>
        /// <param name="ownerName">The declaring static class name when matched.</param>
        /// <param name="methodName">The helper method name when matched.</param>
        /// <returns><see langword="true"/> when the call targets an enum extension.</returns>
        private static bool TryGetEnumExtension(IMethodSymbol method, out string ownerName, out string methodName)
        {
            ownerName = null;
            methodName = null;
            if (method == null || !method.IsExtensionMethod)
            {
                return false;
            }

            ITypeSymbol receiverType = method.ReceiverType
                ?? method.Parameters.FirstOrDefault()?.Type;
            if (receiverType?.TypeKind != TypeKind.Enum)
            {
                return false;
            }

            IMethodSymbol original = method.ReducedFrom ?? method;
            ownerName = original.ContainingType?.Name is { } containingName ? SanitizeIdentifier(containingName) : null;
            methodName = SanitizeIdentifier(original.Name);
            return ownerName != null;
        }

        /// <summary>
        /// Translates a single C# call argument, honoring <c>out</c>/<c>ref</c>
        /// argument forms (ADR-0115 §B; sample <c>TryParseOutVar.gs</c>): an
        /// <c>out</c>/<c>ref</c> argument naming a pre-declared variable maps to
        /// the address-of form <c>&amp;x</c>, an inline <c>out var x</c> maps to
        /// <c>out var x</c>, and an <c>out _</c> discard maps to <c>out _</c>.
        /// </summary>
        // Issue #1727: G# has no named-argument call syntax, so a C# argument list
        // that uses `name:` must be translated into pure declaration-order
        // positional form. `Foo(b: 2, a: 1)` was previously emitted in SYNTAX order
        // (`Foo(2, 1)`) — silently swapping the arguments — and a skipped optional
        // parameter (`Foo(c: 5)` skipping `a`/`b`) bound the value to the FIRST
        // parameter instead of `c`. The fast path (no named arguments) is
        // untouched: it is the overwhelming majority of call sites and must not
        // change behavior or cost.
        private List<GExpression> TranslateArguments(SeparatedSyntaxList<ArgumentSyntax> arguments)
        {
            if (!arguments.Any(a => a.NameColon != null))
            {
                return arguments.Select(a => this.TranslateArgument(a)).ToList();
            }

            return this.TranslateNamedArguments(arguments);
        }

        /// <summary>
        /// Translates an argument list at a call site that may need lowering
        /// gsc's structural call model cannot express on its own (issue #1901):
        /// <list type="bullet">
        /// <item>a C#13 "params collection" parameter (<c>params List&lt;T&gt;</c>,
        /// <c>params IEnumerable&lt;T&gt;</c>, …) — gsc's own variadic parameter is
        /// always an array/slice (<see cref="MapParameter"/>), so such a C#
        /// parameter is declared in G# as an ordinary parameter of the full
        /// collection type. An EXPANDED call (<c>Total(1, 2, 3)</c>, including the
        /// zero-argument <c>Total()</c> form) has no matching G# argument shape,
        /// so it is lowered here into an explicit collection construction
        /// (<c>Total(List[int32]{1, 2, 3})</c>) that becomes that single ordinary
        /// argument; the non-expanded, direct-collection form (<c>Total(someList)</c>)
        /// already binds a single ordinary argument as-is and needs no lowering.</item>
        /// <item>a C#12 lambda default parameter value omitted at an INDIRECT call
        /// (<c>f()</c> where <c>f</c> is a local/field holding a lambda declared
        /// <c>(int x = 10) =&gt; …</c>). gsc's lambda parameters DO carry a default
        /// (<c>LambdaBinder.BindAndAttachParameterDefaultValue</c>), but it lives
        /// only on the lambda's own <c>ParameterSymbol</c> — the structural
        /// <c>FunctionTypeSymbol</c> that types the variable holding it (and that
        /// every indirect call through that variable binds against,
        /// <c>OverloadResolver.TryBindFunctionTypeArguments</c>) carries only
        /// parameter TYPES, never defaults, so gsc always requires the full arity
        /// at an indirect call. Roslyn already resolves the omitted argument to
        /// its constant default (<c>ArgumentKind.DefaultValue</c>) regardless of
        /// how the callee is invoked, so the missing argument is materialized
        /// explicitly here instead of being dropped.</item>
        /// </list>
        /// </summary>
        /// <summary>
        /// The params-collection shapes gsc can build FROM a call-site
        /// <c>List[T]{...}</c> literal (BuildConstruction has no other collection
        /// constructor to reach for): the concrete <c>List&lt;T&gt;</c> class itself,
        /// plus the interfaces it already implements. Matched structurally (single
        /// type argument) rather than by shape, per issue #1901 follow-up — a
        /// <c>ReadOnlySpan&lt;T&gt;</c>/<c>Span&lt;T&gt;</c> (C#13's PREFERRED params-collection
        /// overload), a <c>HashSet&lt;T&gt;</c>, or any user <c>[CollectionBuilder]</c> type
        /// has no gsc construction form and must gap instead of silently mismatching
        /// the declared parameter type.
        /// </summary>
        private static bool IsSupportedParamsCollectionType(ITypeSymbol type)
        {
            if (type is not INamedTypeSymbol { TypeArguments: [ITypeSymbol] } named)
            {
                return false;
            }

            if (named.Name == "List" && named.ContainingNamespace?.ToDisplayString() == "System.Collections.Generic")
            {
                return true;
            }

            return named.OriginalDefinition.SpecialType is
                SpecialType.System_Collections_Generic_IEnumerable_T or
                SpecialType.System_Collections_Generic_ICollection_T or
                SpecialType.System_Collections_Generic_IList_T or
                SpecialType.System_Collections_Generic_IReadOnlyList_T or
                SpecialType.System_Collections_Generic_IReadOnlyCollection_T;
        }

        private List<GExpression> TranslateCallArguments(SyntaxNode callSyntax, SeparatedSyntaxList<ArgumentSyntax> arguments)
        {
            IMethodSymbol targetMethod = this.context.SemanticModel.GetOperation(callSyntax) switch
            {
                IInvocationOperation invocationOp => invocationOp.TargetMethod,
                IObjectCreationOperation creationOp => creationOp.Constructor,
                _ => null,
            };
            ImmutableArray<IArgumentOperation> operationArguments = this.context.SemanticModel.GetOperation(callSyntax) switch
            {
                IInvocationOperation invocationOp => invocationOp.Arguments,
                IObjectCreationOperation creationOp => creationOp.Arguments,
                _ => default,
            };

            if (operationArguments.IsDefaultOrEmpty)
            {
                return this.TranslateArguments(arguments);
            }

            if (targetMethod?.MethodKind == MethodKind.DelegateInvoke
                && operationArguments.Any(a => a.ArgumentKind == ArgumentKind.DefaultValue))
            {
                return this.TranslateDelegateInvokeArgumentsWithDefaults(callSyntax, arguments, operationArguments);
            }

            IArgumentOperation paramsCollectionArg =
                operationArguments.FirstOrDefault(a => a.ArgumentKind == ArgumentKind.ParamCollection);

            if (paramsCollectionArg == null)
            {
                return this.TranslateArguments(arguments);
            }

            if (arguments.Any(a => a.NameColon != null))
            {
                // A named argument feeding into (or skipping ahead of) a params
                // collection is rare enough, and interacts with enough of the
                // existing named-argument reordering machinery, that guessing a
                // lowering here risks silently mis-binding. Gap loudly instead
                // (falls through to the ordinary named-argument path, which at
                // least keeps every OTHER argument correct).
                this.context.ReportUnsupported(
                    callSyntax,
                    "a named argument alongside an expanded 'params' collection call has no canonical G# lowering yet.");
                return this.TranslateNamedArguments(arguments);
            }

            int paramsOrdinal = paramsCollectionArg.Parameter.Ordinal;

            if (!IsSupportedParamsCollectionType(paramsCollectionArg.Parameter.Type))
            {
                // gsc can only construct a List[T]{...} literal at the call site
                // (BuildConstruction below has no other collection constructor to
                // reach for). Anything else — params Span<T>/ReadOnlySpan<T> (the
                // PREFERRED C#13 overload), HashSet<T>, a [CollectionBuilder] type,
                // or a collection type with other than one type argument — has no
                // gsc construction form.
                //
                // Only gap when the callee itself is declared IN SOURCE: MapParameter
                // gaps that same declaration (issue #1901 follow-up), and a half-
                // translated callee with no working caller is what we're guarding
                // against here — so both sides need to stay consistent. A callee from
                // a REFERENCED assembly (e.g. BCL `Task.WhenAll(params ReadOnlySpan<Task>)`)
                // is never translated as a declaration in the first place, so there is
                // nothing to stay consistent with; fall back to the pre-#1901 ordinary
                // argument translation silently, exactly as it worked before this PR.
                if (targetMethod?.DeclaringSyntaxReferences.IsEmpty == false)
                {
                    this.context.ReportUnsupported(
                        callSyntax,
                        $"params collection of type '{paramsCollectionArg.Parameter.Type}' has no gsc construction form.");
                }

                return this.TranslateArguments(arguments);
            }

            var translatedArguments = arguments.Take(paramsOrdinal).Select(a => this.TranslateArgument(a)).ToList();

            ITypeSymbol paramsElementType = ((INamedTypeSymbol)paramsCollectionArg.Parameter.Type).TypeArguments[0];
            GTypeReference elementType = this.typeMapper.Map(paramsElementType, this.context, callSyntax.GetLocation());

            var collectionElements = arguments.Skip(paramsOrdinal)
                .Select(a => new CollectionInitializerElement(this.TranslateArgument(a)))
                .ToList();
            var listType = new NamedTypeReference("List", new List<GTypeReference> { elementType });
            GExpression construction = BuildConstruction(listType, new List<GExpression>());

            // A zero-element params-collection call (`Total()`) has no elements to
            // brace — gsc's collection-initializer form requires at least one
            // element (an empty `{ }` fails to bind, GS0157); the bare
            // construction call (`List[int32]()`) is the canonical empty form
            // (mirrors the C# `[]`-collection-expression lowering above).
            translatedArguments.Add(collectionElements.Count == 0
                ? construction
                : new CollectionInitializerExpression(construction, collectionElements));
            return translatedArguments;
        }

        /// <summary>
        /// Rebuilds a delegate-invoke call's full argument list — issue #1901 —
        /// walking Roslyn's already-resolved <paramref name="operationArguments"/>
        /// in parameter order: an <c>Explicit</c> slot consumes the next syntax
        /// argument (translated exactly as any ordinary argument would be, so
        /// numeric coercion/spill behavior is unchanged), and a <c>DefaultValue</c>
        /// slot materializes that parameter's constant default directly — the
        /// explicit value gsc's structural function-type call has no other way to
        /// supply. Named arguments are excluded up front: C# forbids a named
        /// argument through a delegate/lambda invocation entirely (no parameter
        /// names survive the natural delegate type), so <paramref name="arguments"/>
        /// is always in positional/Explicit order already.
        /// </summary>
        private List<GExpression> TranslateDelegateInvokeArgumentsWithDefaults(
            SyntaxNode callSyntax,
            SeparatedSyntaxList<ArgumentSyntax> arguments,
            ImmutableArray<IArgumentOperation> operationArguments)
        {
            var result = new List<GExpression>(operationArguments.Length);
            int nextSyntaxArgument = 0;
            foreach (IArgumentOperation argumentOperation in operationArguments)
            {
                if (argumentOperation.ArgumentKind == ArgumentKind.DefaultValue)
                {
                    Optional<object> constant = argumentOperation.Value.ConstantValue;
                    GExpression defaultValue = constant.HasValue
                        ? this.MapConstantValue(
                            constant.Value,
                            argumentOperation.Parameter.Type,
                            callSyntax,
                            $"parameter '{argumentOperation.Parameter.Name}''s default value")
                        : null;
                    if (defaultValue == null)
                    {
                        // `nil` is the CORRECT mapping for a legitimate null/default
                        // constant (constant.Value == null); anything else that
                        // failed to map (decimal, default(struct), or no constant
                        // at all) has no gsc literal form — `nil` there would
                        // silently substitute the wrong value AND type. Gap loudly.
                        bool legitimateNull = constant.HasValue && constant.Value == null;
                        if (!legitimateNull)
                        {
                            this.context.ReportUnsupported(
                                callSyntax,
                                $"lambda default value of type '{argumentOperation.Parameter.Type}' has no gsc constant form.");
                        }

                        defaultValue = new IdentifierExpression("nil");
                    }

                    result.Add(defaultValue);
                    continue;
                }

                result.Add(this.TranslateArgument(arguments[nextSyntaxArgument]));
                nextSyntaxArgument++;
            }

            return result;
        }

        // Reorders a named/mixed argument list into parameter DECLARATION order
        // (the only order a positional G# call can express), filling any optional
        // parameter skipped by the named arguments with its default value.
        //
        // C# evaluates call-site arguments in LEXICAL (source) order and binds by
        // name only afterward. Reordering into declaration order therefore changes
        // observable evaluation order when a moved argument may have a side effect
        // (a method call, object creation, assignment, increment, or await) — so
        // that case is reported unsupported instead of silently reordering side
        // effects (a source-order fallback is emitted so translation still
        // produces compiling, if diagnostically-flagged, output).
        // Resolves the method (or constructor) a mixed/named argument list is
        // being passed to, so an EXPANDED `params` element — which has no
        // per-argument IArgumentOperation of its own — can still be mapped to the
        // params parameter it feeds. Returns null when the enclosing call cannot
        // be resolved (the caller then falls back to source-order emission).
        private IMethodSymbol ResolveInvokedMethodForArguments(SeparatedSyntaxList<ArgumentSyntax> arguments)
        {
            SyntaxNode callSyntax = arguments.FirstOrDefault()?.Parent?.Parent;
            if (callSyntax == null)
            {
                return null;
            }

            if (this.context.SemanticModel.GetSymbolInfo(callSyntax).Symbol is IMethodSymbol symbolMethod)
            {
                return symbolMethod;
            }

            return this.context.SemanticModel.GetOperation(callSyntax) switch
            {
                IInvocationOperation invocation => invocation.TargetMethod,
                IObjectCreationOperation creation => creation.Constructor,
                _ => null,
            };
        }

        private List<GExpression> TranslateNamedArguments(SeparatedSyntaxList<ArgumentSyntax> arguments)
        {
            var resolved = new List<(ArgumentSyntax Syntax, IParameterSymbol Parameter)>();
            IMethodSymbol invokedForArguments = this.ResolveInvokedMethodForArguments(arguments);
            foreach (ArgumentSyntax argument in arguments)
            {
                IParameterSymbol parameter = null;
                if (this.context.SemanticModel.GetOperation(argument) is IArgumentOperation operation &&
                    operation.Parameter != null)
                {
                    parameter = operation.Parameter;
                }
                else if (invokedForArguments != null)
                {
                    // An EXPANDED `params` element (e.g. the trailing positional
                    // arguments in `Merge(additionalCapacity: 8, a, b, c)`) has no
                    // per-argument IArgumentOperation: Roslyn folds every expanded
                    // element into a single array-creation argument bound to the
                    // params parameter, so `GetOperation` on the individual syntax
                    // returns null. Resolve it directly to that params parameter
                    // (they share its ordinal) instead of gapping — source order
                    // among same-ordinal params elements is already correct.
                    parameter = invokedForArguments.Parameters.FirstOrDefault(p => p.IsParams);
                }

                if (parameter == null)
                {
                    string message = "a named argument could not be resolved to a parameter via the semantic " +
                        "model; emitted in source order, which may mis-bind (issue #1727).";
                    this.context.ReportUnsupported(argument, message);
                    return arguments.Select(a => this.TranslateArgument(a)).ToList();
                }

                resolved.Add((argument, parameter));
            }

            for (int i = 0; i < resolved.Count; i++)
            {
                for (int j = i + 1; j < resolved.Count; j++)
                {
                    // resolved is in lexical (source) order by construction, so i < j
                    // is "before" lexically; declaration order disagrees whenever the
                    // ordinals decrease. Equal ordinals (multiple EXPANDED `params`
                    // elements) keep their source order, so they already agree.
                    bool declarationOrderAgrees = resolved[i].Parameter.Ordinal <= resolved[j].Parameter.Ordinal;
                    if (!declarationOrderAgrees &&
                        (IsPotentiallySideEffecting(resolved[i].Syntax.Expression) ||
                            IsPotentiallySideEffecting(resolved[j].Syntax.Expression)))
                    {
                        string message = "named arguments reorder potentially side-effecting expressions " +
                            "relative to C#'s lexical evaluation order; no side-effect-preserving G# lowering " +
                            "yet (issue #1727).";
                        this.context.ReportUnsupported(resolved[i].Syntax, message);
                        return arguments.Select(a => this.TranslateArgument(a)).ToList();
                    }
                }
            }

            // A `params` parameter used in EXPANDED form (e.g. `Foo(x: 0, 1, 2, 3)`
            // for `Foo(int x, params int[] rest)`) makes several arguments share
            // the SAME `Parameter.Ordinal` (the params parameter's), which a plain
            // `ToDictionary` throws on. Source order already agrees with
            // declaration order whenever ordinals are non-decreasing in source
            // order (the common/legal case, since C# forbids a positional
            // argument from following a named one that skipped ahead) — that
            // needs no reordering at all, so just pass it through. Anything else
            // sharing an ordinal cannot be faithfully expressed as a dense
            // ordinal->argument map; report unsupported instead of crashing.
            bool ordinalsNonDecreasing = true;
            for (int i = 1; i < resolved.Count; i++)
            {
                if (resolved[i].Parameter.Ordinal < resolved[i - 1].Parameter.Ordinal)
                {
                    ordinalsNonDecreasing = false;
                    break;
                }
            }

            bool hasDuplicateOrdinal = resolved.Select(r => r.Parameter.Ordinal).Distinct().Count() != resolved.Count;
            if (hasDuplicateOrdinal)
            {
                if (ordinalsNonDecreasing)
                {
                    return arguments.Select(a => this.TranslateArgument(a)).ToList();
                }

                string message = "named arguments combined with a params argument in expanded form cannot be " +
                    "faithfully reordered (issue #1727).";
                this.context.ReportUnsupported(resolved[0].Syntax, message);
                return arguments.Select(a => this.TranslateArgument(a)).ToList();
            }

            Dictionary<int, ArgumentSyntax> byOrdinal = resolved.ToDictionary(r => r.Parameter.Ordinal, r => r.Syntax);
            int maxOrdinal = resolved.Max(r => r.Parameter.Ordinal);
            IMethodSymbol invokedMethod = resolved[0].Parameter.ContainingSymbol as IMethodSymbol;

            // Issue #2260: `operation.Parameter` (and hence every ordinal in
            // `resolved`/`invokedMethod.Parameters`) is always resolved against the
            // UNREDUCED extension-method definition — e.g. `AddBoldColumn(this
            // Table table, string header, Align align = Align.Left, bool noWrap =
            // false)` — even when the call is written in reduced/dot form
            // (`table.AddBoldColumn("Length", noWrap: true)`), where the receiver
            // is bound implicitly and never appears in `arguments` at all. Without
            // this adjustment, ordinal 0 (the receiver parameter, which has no
            // default and is not itself skippable) is mistaken for a skipped
            // OPTIONAL parameter and the fill fails immediately — before ever
            // reaching the real skipped parameter (`align`) — silently dropping it
            // from the emitted call instead of filling it. Any gap between the
            // unreduced arity and the reduced arity the call was actually bound
            // through is exactly the receiver's parameter count, so those leading
            // ordinals must be skipped entirely rather than treated as fillable.
            int ordinalOffset = invokedMethod != null && invokedForArguments?.ReducedFrom != null
                ? Math.Max(0, invokedMethod.Parameters.Length - invokedForArguments.Parameters.Length)
                : 0;

            var result = new List<GExpression>();
            for (int ordinal = ordinalOffset; ordinal <= maxOrdinal; ordinal++)
            {
                if (byOrdinal.TryGetValue(ordinal, out ArgumentSyntax explicitArgument))
                {
                    result.Add(this.TranslateArgument(explicitArgument));
                    continue;
                }

                IParameterSymbol skippedParameter = invokedMethod != null && ordinal < invokedMethod.Parameters.Length
                    ? invokedMethod.Parameters[ordinal]
                    : null;
                GExpression fillerDefault = this.BuildSkippedNamedArgumentDefault(skippedParameter, arguments);
                if (fillerDefault == null)
                {
                    return arguments.Select(a => this.TranslateArgument(a)).ToList();
                }

                result.Add(fillerDefault);
            }

            return result;
        }

        // Computes the positional filler for an optional parameter that a named
        // argument list skipped, or `null` (after reporting Unsupported) when no
        // faithful G# value can be emitted: a caller-info parameter
        // ([CallerMemberName]/[CallerLineNumber]/[CallerFilePath]/
        // [CallerArgumentExpression]) needs the value the C# compiler substitutes
        // at THIS call site, which the parameter's own default does not carry, and
        // a non-literal default (a `const` field, an enum member, etc.) has no
        // simple literal form (mirrors the declaration-side limitation already
        // accepted in BuildOptionalParameterDefault).
        private GExpression BuildSkippedNamedArgumentDefault(IParameterSymbol skippedParameter, SeparatedSyntaxList<ArgumentSyntax> arguments)
        {
            if (skippedParameter == null)
            {
                string message = "a named argument list skips a parameter that could not be resolved via the " +
                    "semantic model (issue #1727).";
                this.context.ReportUnsupported(arguments.First(), message);
                return null;
            }

            bool hasCallerInfo = skippedParameter.GetAttributes().Any(a => a.AttributeClass?.Name is
                "CallerMemberNameAttribute" or "CallerLineNumberAttribute" or
                "CallerFilePathAttribute" or "CallerArgumentExpressionAttribute");
            if (hasCallerInfo)
            {
                string message = $"named argument list skips caller-info parameter '{skippedParameter.Name}'; " +
                    "its call-site-substituted value has no faithful G# positional form yet (issue #1727).";
                this.context.ReportUnsupported(arguments.First(), message);
                return null;
            }

            GTypeReference parameterType = this.typeMapper.Map(
                skippedParameter.Type,
                this.context,
                skippedParameter.Locations.FirstOrDefault());
            GExpression fillerDefault = this.BuildOptionalParameterDefault(skippedParameter, parameterType, arguments.First());
            if (fillerDefault == null)
            {
                string message = $"named argument list skips parameter '{skippedParameter.Name}' whose default " +
                    "value is not a simple literal; no faithful G# positional form yet (issue #1727).";
                this.context.ReportUnsupported(arguments.First(), message);
            }

            return fillerDefault;
        }

        // Conservative "no observable side effect" check used only to decide
        // whether reordering a named argument into declaration position is safe
        // (issue #1727). A bare literal or a plain identifier/member-access chain
        // that never invokes anything reads state without changing it; everything
        // else (calls, object creation, assignment, increment/decrement, await,
        // and — conservatively — any operator, since it may be an overloaded
        // operator with side effects) is treated as potentially side-effecting.
        private static bool IsPotentiallySideEffecting(ExpressionSyntax expression)
        {
            switch (expression)
            {
                case null:
                case LiteralExpressionSyntax:
                case IdentifierNameSyntax:
                case ThisExpressionSyntax:
                case PredefinedTypeSyntax:
                    return false;
                case ParenthesizedExpressionSyntax parenthesized:
                    return IsPotentiallySideEffecting(parenthesized.Expression);
                case MemberAccessExpressionSyntax memberAccess:
                    return IsPotentiallySideEffecting(memberAccess.Expression);
                case PrefixUnaryExpressionSyntax prefixUnary
                    when prefixUnary.IsKind(SyntaxKind.UnaryMinusExpression) || prefixUnary.IsKind(SyntaxKind.UnaryPlusExpression):
                    return IsPotentiallySideEffecting(prefixUnary.Operand);
                default:
                    return true;
            }
        }

        private GExpression TranslateArgument(ArgumentSyntax argument)
        {
            SyntaxKind refKind = argument.RefKindKeyword.Kind();
            if (refKind == SyntaxKind.OutKeyword)
            {
                if (argument.Expression is DeclarationExpressionSyntax declaration)
                {
                    return declaration.Designation switch
                    {
                        DiscardDesignationSyntax => new OutArgumentExpression("out", "_"),
                        SingleVariableDesignationSyntax single => this.TranslateOutVarDesignation(single),
                        _ => new UnaryExpression("&", this.TranslateExpression(argument.Expression)),
                    };
                }

                if (argument.Expression is IdentifierNameSyntax { Identifier.Text: "_" })
                {
                    return new OutArgumentExpression("out", "_");
                }

                // `out existingVar` (pre-declared): pass by address (legacy form).
                return new UnaryExpression("&", this.TranslateExpression(argument.Expression));
            }

            if (refKind == SyntaxKind.RefKeyword)
            {
                return new UnaryExpression("&", this.TranslateExpression(argument.Expression));
            }

            // A declared-nullable reference argument that C# flow analysis has
            // narrowed to non-null (e.g. a `string?` field read inside an
            // `if (field == null) … else …` guard) is passed by value, but G#
            // smart-casts narrow only LOCALS — the field/property keeps its `T?`
            // type, so a non-null `T` parameter rejects it (GS0156). The existing
            // receiver null-forgiveness pass already gates on flow-proven non-null
            // AND a declared-nullable reference symbol, so asserting `!!` here is
            // always runtime-safe and widens cleanly to a `T?` parameter too.
            // `nameof(x)` takes a name reference, not a value, so `nameof(x!!)`
            // is rejected (GS0190) — never assert inside a `nameof` argument.
            if (!IsNameOfArgument(argument) && this.ReceiverNeedsNullForgiveness(argument.Expression))
            {
                return new NonNullAssertionExpression(this.TranslateExpression(argument.Expression));
            }

            // A C# argument whose declared numeric type differs from the type C#
            // implicitly converted it to at the call site (e.g. a `ushort` constant
            // passed where generic inference selected `int`, or a signed literal
            // passed to an unsigned parameter) may need that conversion made
            // explicit: gsc applies the implicit lossless-widening lattice and the
            // constant-expression narrowing at fixed parameters, but NOT a
            // non-constant narrowing/cross-sign value, nor a widening-only argument
            // to a generic CLR parameter (whose inference would fail — GS0159).
            // CoerceNumericArgumentToConverted (issue #1281) emits the bare operand
            // when gsc accepts the conversion on its own and keeps the explicit
            // `T(x)` wrap only where gsc still needs it.
            GExpression translated = this.CoercePointerConversion(
                argument.Expression,
                this.CoerceNumericArgumentToConverted(
                    argument,
                    this.TranslateExpression(argument.Expression)));
            if (!IsNameOfArgument(argument)
                && this.context.SemanticModel.GetOperation(argument) is IArgumentOperation
                    { Parameter: { } parameter })
            {
                translated = this.ForgiveNullableReferenceValue(
                    argument.Expression,
                    translated,
                    parameter.Type,
                    parameter);
            }

            return translated;
        }

        // Coerce an argument expression to the numeric type C# implicitly converted
        // it to at the call site, when that converted type differs from the
        // expression's own numeric type AND gsc would not perform that conversion
        // implicitly. Issue #1281: gsc already widens (ADR-0044) and constant-narrows
        // (C# §10.2.11) at a concrete numeric parameter, so the explicit G# wrap is
        // emitted only for the residual cases gsc still rejects — a non-constant
        // narrowing/cross-sign value, or a widening argument bound to a generic
        // (type-parameter) parameter.
        private GExpression CoerceNumericArgumentToConverted(ArgumentSyntax argument, GExpression translated)
        {
            ExpressionSyntax expression = argument.Expression;

            // gsc performs this implicit numeric conversion at the call site
            // itself — the explicit conversion would be redundant.
            if (this.GSharpAcceptsImplicitNumericArgument(argument))
            {
                return translated;
            }

            // A numeric literal is already retyped to its C# converted type by the
            // literal-translation path (a float-promoted literal becomes a float
            // literal `30.0`, ADR-0115 §B.12), so re-wrapping it here would double
            // up the conversion. Constant signed→unsigned literal retyping is still
            // applied below for integer targets.
            if (expression is LiteralExpressionSyntax literal &&
                literal.IsKind(SyntaxKind.NumericLiteralExpression))
            {
                return this.CoerceConstantToUnsigned(expression, translated);
            }

            TypeInfo info = this.context.GetTypeInfo(expression);
            if (TryGetNumericKind(info.Type, out SpecialType sourceUnderlying) &&
                TryGetNumericKind(info.ConvertedType, out SpecialType convertedUnderlying) &&
                sourceUnderlying != convertedUnderlying)
            {
                return this.CoerceOperandTo(translated, info.ConvertedType);
            }

            return translated;
        }

        // Issue #1281: reports whether gsc applies, on its own, the implicit numeric
        // conversion C# performed on this argument — so the explicit G# conversion
        // wrap is redundant. True only when the source and C#-converted types are
        // differing numeric primitives, the argument binds to a CONCRETE numeric
        // parameter (a generic/type-parameter target still needs the wrap because
        // CLR-method inference does not unify widening-only numeric args), and the
        // conversion is either a gsc lossless widening (ADR-0044) or a constant
        // integer LITERAL whose value C# already proved fits the target type
        // (matching gsc's literal-only call-site constant folding, ADR-0129).
        private bool GSharpAcceptsImplicitNumericArgument(ArgumentSyntax argument)
        {
            ExpressionSyntax expression = argument.Expression;
            TypeInfo info = this.context.GetTypeInfo(expression);
            if (!TryGetNumericKind(info.Type, out SpecialType source) ||
                !TryGetNumericKind(info.ConvertedType, out SpecialType converted) ||
                source == converted)
            {
                return false;
            }

            if (!this.TargetsConcreteNumericParameter(argument))
            {
                return false;
            }

            if (IsGSharpImplicitNumericWidening(source, converted))
            {
                return true;
            }

            // A non-widening (narrowing / cross-sign) conversion is implicit in gsc
            // only for a constant integer literal (or unary +/- over one); C# already
            // proved the value is in range by compiling the implicit conversion.
            return IsFoldableIntegerLiteral(expression);
        }

        // Reports whether the argument binds to a parameter whose ORIGINAL-definition
        // type is a concrete numeric primitive. For a generic method the constructed
        // parameter type is the inferred concrete type, but the original is the type
        // parameter `T` — which is excluded so a widening argument to a generic CLR
        // method keeps its explicit conversion (issue #1281).
        private bool TargetsConcreteNumericParameter(ArgumentSyntax argument)
        {
            if (this.context.SemanticModel.GetOperation(argument) is not IArgumentOperation argumentOperation)
            {
                return false;
            }

            IParameterSymbol parameter = argumentOperation.Parameter;
            if (parameter == null)
            {
                return false;
            }

            return TryGetNumericKind(parameter.OriginalDefinition.Type, out _);
        }

        // Mirrors gsc's TryGetConstantIntegerValue (ExpressionBinder.Operators.cs):
        // a foldable constant integer expression is an integer numeric literal, or a
        // unary +/- applied (recursively) to one. Floating/decimal literals and any
        // other constant form (e.g. a `const` field or `ushort.MaxValue`) are NOT
        // folded by gsc and therefore keep their explicit call-site conversion.
        private static bool IsFoldableIntegerLiteral(ExpressionSyntax expression)
        {
            switch (expression)
            {
                case LiteralExpressionSyntax literal when literal.IsKind(SyntaxKind.NumericLiteralExpression):
                    return literal.Token.Value is sbyte or byte or short or ushort or int or uint or long or ulong;
                case PrefixUnaryExpressionSyntax unary
                    when unary.IsKind(SyntaxKind.UnaryMinusExpression) || unary.IsKind(SyntaxKind.UnaryPlusExpression):
                    return IsFoldableIntegerLiteral(unary.Operand);
                default:
                    return false;
            }
        }

        // gsc's ADR-0044 implicit numeric widening lattice (mirrors
        // Conversion.NumericWideningTargets), keyed on the C# SpecialType of the
        // source → set of widening targets. `char` widens like an unsigned 16-bit
        // integer; `decimal` is a widening target of every integral source.
        private static bool IsGSharpImplicitNumericWidening(SpecialType source, SpecialType target)
        {
            return NumericWideningTargets.TryGetValue(source, out HashSet<SpecialType> targets) &&
                targets.Contains(target);
        }

        // `nameof(x)` takes a name reference, not a value, so its argument must
        // never be wrapped in a `!!` non-null assertion (GS0190).
        private static bool IsNameOfArgument(ArgumentSyntax argument)
        {
            return argument.Parent?.Parent is InvocationExpressionSyntax
            {
                Expression: IdentifierNameSyntax { Identifier.Text: "nameof" },
            };
        }

        private GExpression TranslateObjectCreation(ObjectCreationExpressionSyntax creation)
        {
            ITypeSymbol typeSymbol = this.context.GetTypeInfo(creation).Type;
            GTypeReference type = typeSymbol != null
                ? this.typeMapper.Map(typeSymbol, this.context, creation.GetLocation())
                : new NamedTypeReference(creation.Type.ToString());

            var arguments = creation.ArgumentList == null
                ? new List<GExpression>()
                : this.TranslateCallArguments(creation, creation.ArgumentList.Arguments);

            // A C# delegate creation `new SomeDelegate(target)` wraps a method
            // group, lambda, or another delegate in a named delegate type. G# has
            // no delegate wrapper type: a delegate value IS a function value
            // (ADR-0115 function types). The wrapping constructor is therefore
            // redundant — unwrap it to the sole target expression. Constructing the
            // mapped delegate type directly would fail because a delegate maps to an
            // `ArrowTypeReference` (a structural function type), not a callable named
            // type, and would otherwise leak the AST node's CLR type name.
            if (typeSymbol is INamedTypeSymbol { TypeKind: TypeKind.Delegate } &&
                arguments.Count == 1)
            {
                return arguments[0];
            }

            return this.BuildObjectCreationCore(creation, typeSymbol, type, arguments, creation.Initializer);
        }

        /// <summary>
        /// Shared core for <see cref="TranslateObjectCreation"/> and
        /// <see cref="TranslateImplicitObjectCreation"/> (issue #1728): both entry
        /// points map the same C# constructor-call-plus-initializer shapes to the
        /// same G# forms, and had already drifted apart before this method
        /// existed (a struct-zip guard present on only one path; a verbatim
        /// re-inline of <see cref="BuildConstruction"/>). Routing both through
        /// one method makes that drift structurally impossible.
        /// </summary>
        private GExpression BuildObjectCreationCore(
            BaseObjectCreationExpressionSyntax creationNode,
            ITypeSymbol typeSymbol,
            GTypeReference type,
            IReadOnlyList<GExpression> arguments,
            InitializerExpressionSyntax initializer)
        {
            bool hasCtorArgs = arguments.Count > 0;

            // A C# collection initializer maps to the canonical G# collection
            // initializer `Target{ ... }` (ADR-0117, issue #479). This covers
            // `new List<int>{1, 2, 3}` (bare elements), `new Dictionary<K,V>{ {k, v} }`
            // (complex element initializers → `k: v` pairs), and
            // `new Dictionary<K,V>{ ["k"] = v }` (indexer entries). The construction
            // target carries any constructor arguments, matching
            // `new(StringComparer.OrdinalIgnoreCase){ ... }`.
            if (initializer != null &&
                this.TryTranslateCollectionInitializer(initializer, type, arguments, out GExpression collectionInitializer))
            {
                return collectionInitializer;
            }

            var valueType = typeSymbol as INamedTypeSymbol;
            bool isSourceValueStruct =
                valueType is { TypeKind: TypeKind.Struct, SpecialType: SpecialType.None } &&
                !valueType.IsTupleType &&
                !valueType.DeclaringSyntaxReferences.IsEmpty;

            string structUnsupportedReason = null;
            if (isSourceValueStruct &&
                (initializer == null || initializer.IsKind(SyntaxKind.ObjectInitializerExpression)))
            {
                bool builtStructFields = this.TryBuildSourceStructConstructorFields(
                    creationNode,
                    valueType,
                    arguments,
                    out List<FieldInitializer> constructorFields,
                    out bool usesCallablePrimaryConstructor,
                    out structUnsupportedReason);
                if (builtStructFields && !usesCallablePrimaryConstructor)
                {
                    if (initializer != null)
                    {
                        List<FieldInitializer> initializerFields = this.TranslateObjectInitializerFields(initializer);
                        var initializedNames = new HashSet<string>(
                            constructorFields.Select(field => field.Name),
                            StringComparer.Ordinal);
                        FieldInitializer duplicate = initializerFields.FirstOrDefault(field => initializedNames.Contains(field.Name));
                        if (duplicate != null)
                        {
                            string message =
                                $"object initializer overwrites constructor-initialized struct member '{duplicate.Name}'. " +
                                "Collapsing both writes into one G# struct-literal field could drop constructor evaluation " +
                                "or side effects (issue #2435).";
                            this.context.ReportUnsupported(
                                initializer,
                                message);
                        }
                        else
                        {
                            constructorFields.AddRange(initializerFields);
                        }
                    }

                    return new CompositeLiteralExpression(type, constructorFields);
                }
                else if (!builtStructFields && structUnsupportedReason != null)
                {
                    this.context.ReportUnsupported(creationNode, structUnsupportedReason);
                }
            }

            if (initializer != null && initializer.IsKind(SyntaxKind.ObjectInitializerExpression))
            {
                // An object initializer `new T { Field = value, ... }` with NO
                // constructor argument list maps to the canonical G# struct
                // literal `T{Field: value, ...}` (spec §Struct literals; ADR-0115
                // §B.11).
                if (!hasCtorArgs)
                {
                    return this.BuildObjectInitializerLiteral(initializer, type);
                }

                // Issue #1728: `new T(a, b) { Field = value, ... }` combines
                // constructor arguments WITH an object initializer. Neither the
                // colon struct literal above nor a bare construction call has a
                // slot for both a positional constructor call and member
                // assignments — falling through to a bare `BuildConstruction`
                // here (the original bug) silently drops every assignment. gsc's
                // construction-with-initializer-suffix form (issue #522,
                // `Target(args) { Field = value, ... }`) is built for exactly
                // this: it lowers to a synthetic local, the assignments, then a
                // trailing value, so it composes at any expression position —
                // no hoisted-temp workaround is needed.
                return this.BuildConstructionWithInitializerSuffix(initializer, type, arguments);
            }

            // A source-defined value aggregate (`struct` / `data struct`) has no
            // callable constructor surface in G#: it is constructed with a struct
            // literal `T{Field: value, ...}` (spec §Struct literals). Map the
            // positional C# `new T(a, b)` to that literal by zipping the arguments
            // with the members the actual invoked constructor assigns them to
            // (issue #1739 — NOT the type's members in bare declaration order,
            // which silently swaps/misassigns values whenever a struct's member
            // declaration order differs from its constructor's parameter order).
            // Imported/BCL structs (e.g. `Guid`, `DateTime`,
            // `Span<T>` — all `SpecialType.None`) DO expose real constructors that
            // G# can call directly (`Guid(bytes, true)`), so they must fall through
            // to a constructor call rather than be zipped into a bogus literal over
            // the type's *properties*. An initializer here (reachable only when it
            // wasn't a plain object initializer, e.g. an unsupported collection
            // initializer shape) has no field to zip into either, so it must NOT
            // be silently absorbed into a bogus zip — skip straight to
            // `BuildConstruction` and let the initializer's own diagnostic stand.
            return BuildConstruction(type, arguments);
        }

        private bool TryBuildSourceStructConstructorFields(
            BaseObjectCreationExpressionSyntax creationNode,
            INamedTypeSymbol valueType,
            IReadOnlyList<GExpression> arguments,
            out List<FieldInitializer> fieldInitializers,
            out bool usesCallablePrimaryConstructor,
            out string unsupportedReason)
        {
            fieldInitializers = null;
            usesCallablePrimaryConstructor = false;
            var ctorSymbol = this.context.GetSymbolInfo(creationNode).Symbol as IMethodSymbol;
            if (ctorSymbol == null)
            {
                unsupportedReason = "the invoked source struct constructor could not be resolved; " +
                    "a G# struct literal cannot be built safely (issue #2435).";
                return false;
            }

            if (ctorSymbol.DeclaringSyntaxReferences.IsEmpty && arguments.Count == 0)
            {
                fieldInitializers = new List<FieldInitializer>();
                unsupportedReason = null;
                return true;
            }

            if (ctorSymbol.DeclaringSyntaxReferences.Length == 1 &&
                ctorSymbol.DeclaringSyntaxReferences[0].GetSyntax() is TypeDeclarationSyntax { ParameterList: not null })
            {
                usesCallablePrimaryConstructor = true;
                unsupportedReason = null;
                return true;
            }

            if (!this.TryAnalyzeStructConstructor(
                ctorSymbol,
                valueType,
                out StructConstructorPlan plan,
                out unsupportedReason))
            {
                return false;
            }

            return this.TryInstantiateStructConstructorPlan(
                plan,
                arguments,
                out fieldInitializers,
                out unsupportedReason);
        }

        /// <summary>
        /// Builds the canonical G# construction expression for a C# <c>new</c>:
        /// a call on the type name carrying any bracket type arguments
        /// (<c>List[int32](...)</c>, ADR-0115 §B.7).
        /// </summary>
        private static GExpression BuildConstruction(GTypeReference type, IReadOnlyList<GExpression> arguments)
        {
            if (type is NamedTypeReference named)
            {
                IReadOnlyList<GTypeReference> typeArguments = named.TypeArguments.Count > 0
                    ? named.TypeArguments
                    : null;
                return new InvocationExpression(
                    new IdentifierExpression(ConstructionCalleeName(named.Name)),
                    arguments,
                    typeArguments);
            }

            return new InvocationExpression(new IdentifierExpression(type.ToString()), arguments);
        }

        // Issue #2429 (oblivious sink, shared bridge): an object/struct-literal
        // member value, a collection-initializer element/Add-argument, or an
        // indexer-initializer value is a sink just like an argument, return, or
        // plain-assignment RHS (issues #2202/#2425/#2427). Two DISTINCT shapes
        // trip the same `T? -> T` GS0156 once gsc's strict nullability sees the
        // value's true `T?` type:
        //  - a same/sibling-SOURCE symbol the whole-program taint fixpoint proved
        //    nullable (`IsNullablePromotedValue`, issue #1072/#2259's shape,
        //    e.g. `Alias = account.Alias` where `Account.Alias` was tainted
        //    elsewhere), and
        //  - a value READ from a GENUINELY EXTERNAL oblivious (metadata, no
        //    nullable context, no source ANYWHERE we can analyze) member the
        //    fixpoint can't see at all (`IsImportedObliviousNullableMember`,
        //    issue #2113 follow-up, e.g. `Asin: author.Asin` where `author` is
        //    an external oblivious type).
        // Both are forgiven identically here: the TARGET position (member/
        // Add-parameter/indexer-value) is what decides whether forgiveness is
        // needed. Issue #2521 requires that decision to use the EFFECTIVE
        // emitted contract: a same-compilation declaration may genuinely widen
        // to `T?`, but consumer-side taint cannot retroactively widen a project-
        // reference or CLR-metadata member that was already emitted as `T`.
        // An already-nullable target and a nullable-enabled compilation remain
        // byte-identical.
        //
        // Deliberately NOT narrowed to exclude PREBUILT SIBLING projects (an
        // earlier version of this bridge tried exactly that, gating
        // `IsImportedObliviousNullableMember` on the value symbol's assembly
        // not matching one of `this.context.SiblingCompilations`): empirically,
        // against the real Oahu.Core corpus, that guard silently un-fixed the
        // exact two diagnostics this issue targets
        // (`BookLibrary.AccountAliasContext.Alias = account.Alias`,
        // `Series.Asin`) because `Account.Alias`/`Series.Asin` are plain
        // auto-properties in a sibling project (`Oahu.Data`) with NO taint
        // evidence anywhere (`IsNullablePromotedValue` is `false`) — their
        // ONLY nullability signal is the same blind
        // "oblivious external reference-returning member is `T?`" rule. This
        // mirrors the identical, already-documented precedent on the
        // RECEIVER-position rule (`ReceiverNeedsNullForgiveness`'s own
        // `IsImportedObliviousNullableMember` check): a prior attempt to
        // exclude sibling-project members from THAT blind rule was proven,
        // against the same real corpus, to regress 47 -> 90 compile errors.
        // Accepting the same harmless over-forgiveness here (a sibling member
        // provably non-null by construction, e.g. an expression-bodied
        // property returning a literal, gets a superfluous but
        // still-compiling `!!`) is consistent with that established,
        // corpus-validated policy.
        private GExpression ForgiveInitializerElementValue(
            ExpressionSyntax valueExpression,
            GExpression translatedValue,
            ITypeSymbol targetType,
            ISymbol targetSymbolForPromotionCheck)
        {
            if (translatedValue is NonNullAssertionExpression
                || !this.TargetWillRemainNonNullableReference(
                    targetType,
                    targetSymbolForPromotionCheck))
            {
                return translatedValue;
            }

            bool needsForgiveness =
                (this.IsObliviousCompilation() && this.IsNullablePromotedValue(valueExpression))
                || this.IsImportedObliviousNullableMember(this.context.GetSymbolInfo(valueExpression).Symbol);

            return needsForgiveness ? new NonNullAssertionExpression(translatedValue) : translatedValue;
        }

        // Object-initializer member assignment (`Field = value` inside `T{ ... }`
        // / `T(args){ ... }`): routes the field/property target's type/promotion
        // state and the assignment's RHS value expression through the shared
        // <see cref="ForgiveInitializerElementValue"/> bridge above.
        private GExpression ForgiveObjectInitializerValue(
            AssignmentExpressionSyntax assignment,
            GExpression translatedValue)
        {
            ISymbol target = this.context.GetSymbolInfo(assignment.Left).Symbol;
            if (target is not (IFieldSymbol or IPropertySymbol))
            {
                return translatedValue;
            }

            ITypeSymbol targetType = target switch
            {
                IFieldSymbol field => field.Type,
                IPropertySymbol property => property.Type,
                _ => null,
            };

            return this.ForgiveInitializerElementValue(assignment.Right, translatedValue, targetType, target);
        }

        /// <summary>
        /// Maps a constructed type's G# name to a callable construction callee.
        /// A G# primitive type keyword (<c>object</c>, <c>string</c>, <c>decimal</c>,
        /// …) is a language keyword, not a function, so constructing one
        /// (<c>new object()</c>, <c>new string(' ', n)</c>, target-typed <c>new()</c>)
        /// must spell the qualified CLR type name instead (e.g. <c>System.Object</c>,
        /// <c>System.String</c>) — otherwise gsc reports GS0130 ("Function 'string'
        /// doesn't exist"). Non-keyword type names are returned unchanged.
        /// </summary>
        private static string ConstructionCalleeName(string typeName) => typeName switch
        {
            "object" => "System.Object",
            "string" => "System.String",
            "bool" => "System.Boolean",
            "char" => "System.Char",
            "decimal" => "System.Decimal",
            "int8" => "System.SByte",
            "uint8" => "System.Byte",
            "int16" => "System.Int16",
            "uint16" => "System.UInt16",
            "int32" => "System.Int32",
            "uint32" => "System.UInt32",
            "int64" => "System.Int64",
            "uint64" => "System.UInt64",
            "float32" => "System.Single",
            "float64" => "System.Double",
            _ => typeName,
        };

        /// <summary>
        /// Builds the canonical G# struct literal <c>T{Field: value, ...}</c> from a
        /// C# object initializer (<c>{ Field = value, ... }</c>), used by both the
        /// explicit (<c>new T { ... }</c>) and target-typed (<c>new() { ... }</c>)
        /// construction paths (spec §Struct literals; ADR-0115 §B.11).
        /// </summary>
        private GExpression BuildObjectInitializerLiteral(InitializerExpressionSyntax initializer, GTypeReference type)
        {
            return new CompositeLiteralExpression(type, this.TranslateObjectInitializerFields(initializer));
        }

        private List<FieldInitializer> TranslateObjectInitializerFields(InitializerExpressionSyntax initializer)
        {
            var fieldInitializers = new List<FieldInitializer>();
            foreach (ExpressionSyntax element in initializer.Expressions)
            {
                if (element is AssignmentExpressionSyntax assignment &&
                    assignment.Left is IdentifierNameSyntax name)
                {
                    // Issue #1567: a nested collection/object initializer as the
                    // assignment RHS (`Prop = { a, b }` / `Prop = { ["k"] = v }`)
                    // is the C# collection-initializer-in-object-initializer
                    // pattern — it POPULATES a (typically get-only) collection
                    // property via `Add(...)` rather than ASSIGNING it. Emit the
                    // target-less member collection-initializer form
                    // `Prop: { … }` that gsc lowers to `receiver.Prop.Add(x)`,
                    // preserving the element shapes (bare / keyed / indexed). A
                    // plain array/object initializer would wrongly render as an
                    // assignment and hit GS0127 for a get-only property.
                    if (assignment.Right is InitializerExpressionSyntax nestedInit &&
                        (nestedInit.IsKind(SyntaxKind.CollectionInitializerExpression) ||
                         nestedInit.IsKind(SyntaxKind.ObjectInitializerExpression)))
                    {
                        List<CollectionInitializerElement> memberElements =
                            this.TranslateCollectionInitializerElements(nestedInit);
                        if (memberElements != null)
                        {
                            fieldInitializers.Add(new FieldInitializer(
                                SanitizeIdentifier(name.Identifier.Text),
                                new CollectionInitializerExpression(target: null, memberElements)));
                            continue;
                        }
                    }

                    GExpression value = this.TranslateExpression(assignment.Right);
                    fieldInitializers.Add(new FieldInitializer(
                        SanitizeIdentifier(name.Identifier.Text),
                        this.ForgiveObjectInitializerValue(assignment, value)));
                }
                else
                {
                    this.context.ReportUnsupported(
                        element,
                        "object-initializer element is not a simple `Field = value` assignment; no canonical G# struct-literal form yet (ADR-0115 §B.11).");
                }
            }

            return fieldInitializers;
        }

        /// <summary>
        /// Builds the canonical G# construction-with-initializer-suffix
        /// <c>Target(args) { Name = value, ... }</c> (gsc issue #522) for a C#
        /// object initializer combined with constructor arguments (issue #1728):
        /// <c>new T(a, b) { Field = value, ... }</c>. A nested
        /// <c>Prop = { a, b }</c> COLLECTION-initializer member lowers to the
        /// same target-less member collection-initializer form used by
        /// <see cref="BuildObjectInitializerLiteral"/> (issue #1567) — gsc's
        /// suffix parser now carries the same carve-out (issue #1858), so a
        /// collection member composes with constructor arguments in one
        /// construct instead of being dropped. A nested <c>Prop = { X = 1 }</c>
        /// OBJECT-initializer member has no such carve-out and is reported as
        /// unsupported instead of being silently mistranslated.
        /// </summary>
        private GExpression BuildConstructionWithInitializerSuffix(
            InitializerExpressionSyntax initializer,
            GTypeReference type,
            IReadOnlyList<GExpression> arguments)
        {
            GExpression construction = BuildConstruction(type, arguments);
            var memberInitializers = new List<FieldInitializer>();
            foreach (ExpressionSyntax element in initializer.Expressions)
            {
                if (element is AssignmentExpressionSyntax assignment &&
                    assignment.Left is IdentifierNameSyntax name)
                {
                    if (assignment.Right is InitializerExpressionSyntax nestedInit &&
                        nestedInit.IsKind(SyntaxKind.CollectionInitializerExpression))
                    {
                        List<CollectionInitializerElement> memberElements =
                            this.TranslateCollectionInitializerElements(nestedInit);
                        if (memberElements != null)
                        {
                            memberInitializers.Add(new FieldInitializer(
                                SanitizeIdentifier(name.Identifier.Text),
                                new CollectionInitializerExpression(target: null, memberElements)));
                            continue;
                        }
                    }
                    else if (assignment.Right is InitializerExpressionSyntax nestedObjectInit &&
                        nestedObjectInit.IsKind(SyntaxKind.ObjectInitializerExpression))
                    {
                        this.context.ReportUnsupported(
                            assignment,
                            "nested collection/object initializer as a member value has no canonical G# form when the outer object creation also has constructor arguments; gsc's construction-with-initializer-suffix form (issue #522) has no target-less collection-initializer carve-out (issue #1728).");
                        continue;
                    }

                    memberInitializers.Add(new FieldInitializer(
                        SanitizeIdentifier(name.Identifier.Text),
                        this.ForgiveObjectInitializerValue(
                            assignment,
                            this.TranslateExpression(assignment.Right))));
                }
                else
                {
                    this.context.ReportUnsupported(
                        element,
                        "object-initializer element is not a simple `Field = value` assignment; no canonical G# construction-with-initializer-suffix form yet (issue #1728).");
                }
            }

            return new ObjectCreationInitializerExpression(construction, memberInitializers);
        }

        /// <summary>
        /// Attempts to translate a C# collection initializer into a canonical G#
        /// collection initializer (ADR-0117). Returns <see langword="false"/> when
        /// the initializer is not a collection initializer (e.g. a plain object
        /// initializer), leaving the caller's other mappings to apply.
        /// </summary>
        private bool TryTranslateCollectionInitializer(
            InitializerExpressionSyntax initializer,
            GTypeReference type,
            IReadOnlyList<GExpression> arguments,
            out GExpression result)
        {
            result = null;

            bool isCollectionInitializer = initializer.IsKind(SyntaxKind.CollectionInitializerExpression);
            bool isIndexedObjectInitializer = initializer.IsKind(SyntaxKind.ObjectInitializerExpression) &&
                initializer.Expressions.Count > 0 &&
                initializer.Expressions.All(e =>
                    e is AssignmentExpressionSyntax { Left: ImplicitElementAccessSyntax });

            if (!isCollectionInitializer && !isIndexedObjectInitializer)
            {
                return false;
            }

            List<CollectionInitializerElement> elements = this.TranslateCollectionInitializerElements(initializer);
            if (elements == null)
            {
                return false;
            }

            GExpression construction = BuildConstruction(type, arguments);
            result = new CollectionInitializerExpression(construction, elements);
            return true;
        }

        /// <summary>
        /// Translates the elements of a C# collection initializer into canonical
        /// G# <see cref="CollectionInitializerElement"/>s (bare, keyed, or
        /// indexed). Returns <see langword="null"/> when an element has no
        /// canonical G# form (an unsupported diagnostic is reported). Shared by
        /// the standalone collection initializer (ADR-0117) and the member
        /// collection initializer used to populate a get-only collection property
        /// at construction (issue #1567, <c>Prop = { … }</c>).
        /// </summary>
        private List<CollectionInitializerElement> TranslateCollectionInitializerElements(
            InitializerExpressionSyntax initializer)
        {
            var elements = new List<CollectionInitializerElement>();
            foreach (ExpressionSyntax element in initializer.Expressions)
            {
                if (element is AssignmentExpressionSyntax { Left: ImplicitElementAccessSyntax indexAccess } indexedAssignment)
                {
                    // `["k"] = v` → indexed element.
                    if (indexAccess.ArgumentList.Arguments.Count != 1)
                    {
                        this.context.ReportUnsupported(
                            element,
                            "multi-argument indexer initializer has no canonical G# collection-initializer form (ADR-0117).");
                        return null;
                    }

                    // Issue #2429: the indexer's VALUE type/promotion state is
                    // resolved exactly like a plain `arr[i] = value` element-access
                    // assignment (`ForgiveElementAccessAssignmentRhs`, issue
                    // #2259) — `GetTypeInfo` on the (implicit) indexer access
                    // itself gives the indexer's converted value type, and the
                    // indexer PROPERTY symbol (not the value) is what the taint
                    // fixpoint may have promoted.
                    ITypeSymbol indexerValueType = this.context.GetTypeInfo(indexAccess).Type;
                    ISymbol indexerSymbol = this.context.GetSymbolInfo(indexAccess).Symbol;
                    GExpression indexedValue = this.ForgiveInitializerElementValue(
                        indexedAssignment.Right,
                        this.TranslateExpression(indexedAssignment.Right),
                        indexerValueType,
                        indexerSymbol);

                    elements.Add(new CollectionInitializerElement(
                        this.TranslateIndexArgumentWithNullForgiveness(
                            indexAccess.ArgumentList.Arguments[0]),
                        indexedValue,
                        indexed: true));
                }
                else if (element is InitializerExpressionSyntax { } complex &&
                    element.IsKind(SyntaxKind.ComplexElementInitializerExpression))
                {
                    // `{k, v}` → keyed element `k: v` (dictionary Add(k, v)).
                    if (complex.Expressions.Count != 2)
                    {
                        this.context.ReportUnsupported(
                            element,
                            "collection initializer element with other than two values has no canonical G# form (ADR-0117).");
                        return null;
                    }

                    // Issue #2429: resolve the actual `Add(key, value)` overload
                    // gsc bound for this element (Roslyn's dedicated collection-
                    // initializer symbol API — a plain `GetSymbolInfo` on the
                    // element has nothing to bind to, it is not itself a call
                    // syntax) so each argument's target parameter type decides
                    // whether that argument needs forgiveness. Issue #2521 also
                    // passes the parameter symbol so a same-compilation
                    // promotion is honored while an imported parameter's
                    // already-emitted contract cannot be widened by consumer
                    // taint.
                    IMethodSymbol addMethod =
                        this.context.SemanticModel.GetCollectionInitializerSymbolInfo(complex).Symbol as IMethodSymbol;
                    GExpression keyValue = this.TranslateExpression(complex.Expressions[0]);
                    GExpression pairValue = this.TranslateExpression(complex.Expressions[1]);
                    if (addMethod is { Parameters.Length: 2 })
                    {
                        keyValue = this.ForgiveInitializerElementValue(
                            complex.Expressions[0], keyValue, addMethod.Parameters[0].Type, addMethod.Parameters[0]);
                        pairValue = this.ForgiveInitializerElementValue(
                            complex.Expressions[1], pairValue, addMethod.Parameters[1].Type, addMethod.Parameters[1]);
                    }

                    elements.Add(new CollectionInitializerElement(keyValue, pairValue, indexed: false));
                }
                else
                {
                    // Bare element `e` → `Add(e)`. Same `Add`-overload resolution
                    // as the keyed shape above, keyed to the single value
                    // parameter.
                    IMethodSymbol addMethod =
                        this.context.SemanticModel.GetCollectionInitializerSymbolInfo(element).Symbol as IMethodSymbol;
                    GExpression bareValue = this.TranslateExpression(element);
                    if (addMethod is { Parameters.Length: 1 })
                    {
                        bareValue = this.ForgiveInitializerElementValue(
                            element, bareValue, addMethod.Parameters[0].Type, addMethod.Parameters[0]);
                    }

                    elements.Add(new CollectionInitializerElement(bareValue));
                }
            }

            return elements;
        }

        private bool TryAnalyzeStructConstructor(
            IMethodSymbol ctorSymbol,
            INamedTypeSymbol valueType,
            out StructConstructorPlan plan,
            out string unsupportedReason)
        {
            return this.TryAnalyzeStructConstructor(
                ctorSymbol,
                valueType,
                new HashSet<IMethodSymbol>(SymbolEqualityComparer.Default),
                out plan,
                out unsupportedReason);
        }

        private bool TryAnalyzeStructConstructor(
            IMethodSymbol ctorSymbol,
            INamedTypeSymbol valueType,
            HashSet<IMethodSymbol> activeConstructors,
            out StructConstructorPlan plan,
            out string unsupportedReason)
        {
            plan = null;
            if (ctorSymbol == null ||
                valueType == null ||
                ctorSymbol.MethodKind != MethodKind.Constructor)
            {
                unsupportedReason = "the invoked struct constructor could not be resolved via the semantic model; " +
                    "a G# struct literal cannot be built safely (issue #1739; issue #2435).";
                return false;
            }

            if (!activeConstructors.Add(ctorSymbol.OriginalDefinition))
            {
                unsupportedReason = "struct constructor delegation is recursive; a G# struct literal cannot express it (issue #2435).";
                return false;
            }

            try
            {
                if (ctorSymbol.DeclaringSyntaxReferences.Length != 1 ||
                    ctorSymbol.DeclaringSyntaxReferences[0].GetSyntax() is not ConstructorDeclarationSyntax ctorSyntax ||
                    ctorSyntax.Body == null ||
                    ctorSyntax.ExpressionBody != null)
                {
                    unsupportedReason = "struct constructor is not a single block-bodied source constructor; " +
                        "a G# struct literal cannot express its logic (issue #1739; issue #2435).";
                    return false;
                }

                if (!this.TryGetStructConstructorSemanticModel(ctorSyntax, out SemanticModel ctorModel))
                {
                    unsupportedReason = "struct constructor syntax belongs to no reachable compilation; " +
                        "its body cannot be analyzed for a G# struct literal (issue #1739; issue #2435).";
                    return false;
                }

                var initializations = new List<StructMemberInitialization>();
                var memberNames = new HashSet<string>(StringComparer.Ordinal);
                var parameterUseCounts = new int[ctorSymbol.Parameters.Length];

                if (ctorSyntax.Initializer != null)
                {
                    if (!ctorSyntax.Initializer.ThisOrBaseKeyword.IsKind(SyntaxKind.ThisKeyword))
                    {
                        unsupportedReason = "struct constructor has a base-constructor initializer; " +
                            "a G# struct literal cannot express it (issue #2435).";
                        return false;
                    }

                    var delegatedCtor = ctorModel.GetSymbolInfo(ctorSyntax.Initializer).Symbol as IMethodSymbol;
                    if (!this.TryAnalyzeStructConstructor(
                        delegatedCtor,
                        valueType,
                        activeConstructors,
                        out StructConstructorPlan delegatedPlan,
                        out unsupportedReason))
                    {
                        return false;
                    }

                    SeparatedSyntaxList<ArgumentSyntax> initializerArguments = ctorSyntax.Initializer.ArgumentList.Arguments;
                    if (initializerArguments.Any(a => a.NameColon != null || !a.RefKindKeyword.IsKind(SyntaxKind.None)) ||
                        initializerArguments.Count != delegatedCtor.Parameters.Length)
                    {
                        unsupportedReason = "struct constructor delegation uses named, ref/out/in, optional, or otherwise " +
                            "non-positional arguments; no canonical G# struct-literal lowering exists yet (issue #2435).";
                        return false;
                    }

                    foreach (StructMemberInitialization delegatedInitialization in delegatedPlan.Initializations)
                    {
                        StructMemberInitialization remapped = delegatedInitialization;
                        if (delegatedInitialization.ParameterOrdinal is int delegatedOrdinal)
                        {
                            ExpressionSyntax argumentExpression = initializerArguments[delegatedOrdinal].Expression;
                            if (!this.TryClassifyStructInitializerValue(
                                argumentExpression,
                                ctorModel,
                                ctorSymbol,
                                out int? parameterOrdinal,
                                out ExpressionSyntax fixedExpression,
                                out unsupportedReason))
                            {
                                return false;
                            }

                            remapped = parameterOrdinal is int remappedOrdinal
                                ? new StructMemberInitialization(delegatedInitialization.MemberName, remappedOrdinal)
                                : new StructMemberInitialization(delegatedInitialization.MemberName, fixedExpression);
                        }

                        if (!memberNames.Add(remapped.MemberName))
                        {
                            unsupportedReason = $"struct constructor initializes member '{remapped.MemberName}' more than once across " +
                                "constructor delegation; collapsing those writes into one struct-literal field could drop evaluation " +
                                "or side effects (issue #2435).";
                            return false;
                        }

                        if (remapped.ParameterOrdinal is int ordinal)
                        {
                            parameterUseCounts[ordinal]++;
                        }

                        initializations.Add(remapped);
                    }
                }

                foreach (StatementSyntax statement in ctorSyntax.Body.Statements)
                {
                    if (statement is not ExpressionStatementSyntax exprStatement ||
                        exprStatement.Expression is not AssignmentExpressionSyntax assignment ||
                        !assignment.OperatorToken.IsKind(SyntaxKind.EqualsToken))
                    {
                        unsupportedReason = "struct constructor has a statement other than a plain member assignment; " +
                            "a G# struct literal cannot express its logic (issue #1739; issue #2435).";
                        return false;
                    }

                    ISymbol leftSymbol = ctorModel.GetSymbolInfo(assignment.Left).Symbol;
                    string memberName = leftSymbol switch
                    {
                        IFieldSymbol f when !f.IsStatic &&
                            SymbolEqualityComparer.Default.Equals(f.ContainingType, valueType.OriginalDefinition) => f.Name,
                        IPropertySymbol p when !p.IsStatic &&
                            SymbolEqualityComparer.Default.Equals(p.ContainingType, valueType.OriginalDefinition) => p.Name,
                        _ => null,
                    };

                    if (memberName == null || !memberNames.Add(memberName))
                    {
                        unsupportedReason = "struct constructor assignment does not target a unique instance field/property " +
                            "of the declaring struct; a G# struct literal cannot preserve it (issue #2435).";
                        return false;
                    }

                    if (!this.TryClassifyStructInitializerValue(
                        assignment.Right,
                        ctorModel,
                        ctorSymbol,
                        out int? parameterOrdinal,
                        out ExpressionSyntax fixedExpression,
                        out unsupportedReason))
                    {
                        return false;
                    }

                    if (parameterOrdinal is int ordinal)
                    {
                        parameterUseCounts[ordinal]++;
                        initializations.Add(new StructMemberInitialization(memberName, ordinal));
                    }
                    else
                    {
                        initializations.Add(new StructMemberInitialization(memberName, fixedExpression));
                    }
                }

                if (parameterUseCounts.Any(count => count != 1))
                {
                    unsupportedReason = "struct constructor does not consume every argument exactly once in a direct member " +
                        "assignment/delegation. Repeating an argument expression could duplicate side effects, while omitting it " +
                        "could drop evaluation; no canonical G# struct-literal lowering exists (issue #1739; issue #2435).";
                    return false;
                }

                int declaredInstanceConstructorCount = ctorSymbol.ContainingType.InstanceConstructors.Count(
                    constructor => !constructor.DeclaringSyntaxReferences.IsEmpty);
                bool fixedInitializersAreDeclaredOnType =
                    declaredInstanceConstructorCount == 1 &&
                    ctorSyntax.Initializer == null;
                plan = new StructConstructorPlan(
                    ctorSymbol,
                    initializations,
                    fixedInitializersAreDeclaredOnType);
                unsupportedReason = null;
                return true;
            }
            finally
            {
                activeConstructors.Remove(ctorSymbol.OriginalDefinition);
            }
        }

        private bool TryGetStructConstructorSemanticModel(
            ConstructorDeclarationSyntax ctorSyntax,
            out SemanticModel ctorModel)
        {
            if (this.context.Compilation.ContainsSyntaxTree(ctorSyntax.SyntaxTree))
            {
                ctorModel = this.context.Compilation.GetSemanticModel(ctorSyntax.SyntaxTree);
                return true;
            }

            Compilation owningCompilation = this.context.Compilation.References
                .OfType<CompilationReference>()
                .Select(reference => (Compilation)reference.Compilation)
                .FirstOrDefault(candidate => candidate.ContainsSyntaxTree(ctorSyntax.SyntaxTree));
            if (owningCompilation != null)
            {
                ctorModel = owningCompilation.GetSemanticModel(ctorSyntax.SyntaxTree);
                return true;
            }

            ctorModel = null;
            return false;
        }

        private bool TryClassifyStructInitializerValue(
            ExpressionSyntax expression,
            SemanticModel ctorModel,
            IMethodSymbol ctorSymbol,
            out int? parameterOrdinal,
            out ExpressionSyntax fixedExpression,
            out string unsupportedReason)
        {
            ISymbol directSymbol = ctorModel.GetSymbolInfo(expression).Symbol;
            if (directSymbol is IParameterSymbol parameter &&
                SymbolEqualityComparer.Default.Equals(
                    parameter.ContainingSymbol.OriginalDefinition,
                    ctorSymbol.OriginalDefinition))
            {
                parameterOrdinal = parameter.Ordinal;
                fixedExpression = null;
                unsupportedReason = null;
                return true;
            }

            foreach (SyntaxNode descendant in expression.DescendantNodesAndSelf())
            {
                if (descendant is ThisExpressionSyntax or BaseExpressionSyntax)
                {
                    parameterOrdinal = null;
                    fixedExpression = null;
                    unsupportedReason = "struct constructor initializer expression reads the current instance; " +
                        "a G# struct literal has no constructor-body receiver (issue #2435).";
                    return false;
                }

                if (descendant is not SimpleNameSyntax simpleName)
                {
                    continue;
                }

                ISymbol symbol = ctorModel.GetSymbolInfo(simpleName).Symbol;
                bool isInstanceMember = symbol switch
                {
                    IFieldSymbol field => !field.IsStatic,
                    IPropertySymbol property => !property.IsStatic,
                    IMethodSymbol method => !method.IsStatic,
                    IEventSymbol @event => !@event.IsStatic,
                    _ => false,
                };

                if (symbol is IParameterSymbol or ILocalSymbol || isInstanceMember)
                {
                    parameterOrdinal = null;
                    fixedExpression = null;
                    unsupportedReason = "struct constructor initializer expression transforms a constructor parameter, local, " +
                        "or instance member instead of assigning a parameter directly. Re-evaluating it in a G# struct literal " +
                        "cannot be proven equivalent (issue #1739; issue #2435).";
                    return false;
                }
            }

            parameterOrdinal = null;
            fixedExpression = expression;
            unsupportedReason = null;
            return true;
        }

        private bool TryInstantiateStructConstructorPlan(
            StructConstructorPlan plan,
            IReadOnlyList<GExpression> arguments,
            out List<FieldInitializer> fieldInitializers,
            out string unsupportedReason)
        {
            fieldInitializers = new List<FieldInitializer>();
            if (arguments.Count != plan.Constructor.Parameters.Length)
            {
                unsupportedReason = "translated constructor argument count does not match the resolved struct constructor; " +
                    "a G# struct literal cannot be built safely (issue #2435).";
                return false;
            }

            foreach (StructMemberInitialization initialization in plan.Initializations)
            {
                if (initialization.ParameterOrdinal == null &&
                    plan.FixedInitializersAreDeclaredOnType)
                {
                    continue;
                }

                GExpression value;
                if (initialization.ParameterOrdinal is int ordinal)
                {
                    value = arguments[ordinal];
                }
                else
                {
                    ExpressionSyntax fixedExpression = initialization.FixedExpression;
                    if (!this.context.Compilation.ContainsSyntaxTree(fixedExpression.SyntaxTree))
                    {
                        unsupportedReason = "a source struct constructor in another compilation contains a fixed initializer " +
                            "expression; that expression cannot yet be rebound safely at this call site (issue #2435).";
                        fieldInitializers = null;
                        return false;
                    }

                    using IDisposable modelScope = this.context.UseSemanticModelFor(fixedExpression.SyntaxTree);
                    value = this.TranslateExpression(fixedExpression);
                }

                fieldInitializers.Add(new FieldInitializer(
                    SanitizeIdentifier(initialization.MemberName),
                    value));
            }

            unsupportedReason = null;
            return true;
        }

        private GExpression TranslateCast(CastExpressionSyntax cast)
        {
            // C# explicit cast `(T)expr` maps to the canonical G# width-bearing
            // conversion-call form `T(expr)` (spec §Types and values; ADR-0115
            // §B.12). For floating→integral conversions the CLR truncates toward
            // zero, matching the C# `(int)` truncation semantics, so e.g.
            // `(int)Math.Floor(d + 0.5)` is behavior-faithful.
            ITypeSymbol targetSymbol = this.context.GetTypeInfo(cast.Type).Type;

            // Issue #1923: `(object)x` / `(object?)x` over a REFERENCE-typed
            // `x` (a class, not a value type) is a pure upcast on the CLR — no
            // boxing IL is produced, unlike the value-type case the `T(expr)`
            // form exists for. Translating it as a real conversion-call would
            // need a `T?(expr)`-shaped cast for a nullable source/target,
            // which has no canonical G# parse form; more importantly it is
            // unnecessary, since the underlying pattern/member tests below a
            // reference upcast behave identically whether performed through
            // the boxed `object` reference or directly on the original
            // reference (e.g. a subsequent `is RpPerson` downcast test). Drop
            // the cast and translate the operand alone, letting the
            // surrounding context (a spill's inferred type, a switch/`is`
            // subject) drive typing, mirroring gsc's own no-op upcast lowering
            // for class → object (see `Conversion.Classify`, issue #1229).
            ITypeSymbol sourceSymbol = this.context.GetTypeInfo(cast.Expression).Type;
            if (targetSymbol is { SpecialType: SpecialType.System_Object }
                && sourceSymbol is { IsReferenceType: true })
            {
                return this.TranslateExpression(cast.Expression);
            }

            GTypeReference targetType = targetSymbol != null
                ? this.typeMapper.Map(targetSymbol, this.context, cast.Type.GetLocation())
                : new NamedTypeReference(cast.Type.ToString());

            GExpression operand = this.TranslateExpression(cast.Expression);

            // Issue #914 (oblivious sink): an oblivious promoted-`T?` operand cast
            // to a NON-NULL reference target (e.g. `(IEnumerable)o` where `o` is a
            // promoted `object?`) is rejected by gsc — its `IEnumerable(o)`
            // conversion requires a non-null operand (GS0155). C# performs the
            // reference cast on the (possibly null) value and throws only on the
            // subsequent non-null use (e.g. `foreach`), so asserting the operand
            // `!!` here both compiles and preserves the throw-on-null semantics —
            // the same mechanism the receiver / foreach-iterable null-forgiveness
            // pass uses. Gated to oblivious; a `(object)`/`(object?)` reference
            // upcast is already dropped above, and an already-`!` operand is not
            // re-asserted.
            if (this.IsObliviousCompilation()
                && targetSymbol is { IsReferenceType: true }
                && targetSymbol.NullableAnnotation != NullableAnnotation.Annotated
                && cast.Expression is not PostfixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression }
                && this.IsNullablePromotedValue(cast.Expression))
            {
                operand = new NonNullAssertionExpression(operand);
            }

            // Issue #914: a CLR REFERENCE conversion `(T)expr` (a downcast such as
            // `(IEnumerable)o`, or a cross-cast between reference types) has no
            // conversion-call form in G# — gsc's `T(expr)` is the value/numeric/
            // string-conversion form and rejects a reference cast (GS0155/GS0130
            // "IEnumerable(o)" / "List[int32](o)"). The reference downcast form is
            // `expr as T`, which yields `T?`; the surrounding null-forgiveness pass
            // (receiver / foreach-iterable / return / argument) re-asserts `!!`
            // wherever the context needs the non-null `T`, preserving the C# hard
            // cast's throw-on-misuse. Boxing/unboxing and user-defined conversions
            // are NOT reference conversions and keep the conversion-call form.
            if (targetSymbol is { IsReferenceType: true }
                && sourceSymbol != null
                && this.context.Compilation.ClassifyConversion(sourceSymbol, targetSymbol).IsReference)
            {
                return new BinaryExpression(operand, "as", new TypeExpression(targetType));
            }

            return new ConversionExpression(targetType, operand);
        }

        private GExpression TranslateWith(WithExpressionSyntax with)
        {
            // C# `expr with { Field = value, ... }` maps to the canonical G#
            // copy/update form `expr with { Field = value, ... }` for data
            // structs / data classes (spec §Struct literals; ADR-0115 §B.4). The
            // update fields keep `=` (distinct from the `:` of a struct literal).
            var updates = new List<FieldInitializer>();
            foreach (ExpressionSyntax element in with.Initializer.Expressions)
            {
                if (element is AssignmentExpressionSyntax assignment &&
                    assignment.Left is IdentifierNameSyntax name)
                {
                    updates.Add(new FieldInitializer(
                        SanitizeIdentifier(name.Identifier.Text),
                        this.TranslateExpression(assignment.Right)));
                }
                else
                {
                    this.context.ReportUnsupported(
                        element,
                        "with-expression element is not a simple `Field = value` assignment; no canonical G# copy/update form yet (ADR-0115 §B.4).");
                }
            }

            return new WithExpression(this.TranslateExpression(with.Expression), updates);
        }

        private IReadOnlyList<GTypeReference> MapTypeArguments(GenericNameSyntax generic)
        {
            // Issue #2500: an individual NullableTypeSyntax can bind as its
            // underlying type parameter and lose the explicit annotation.
            // Prefer the constructed method/type symbol, whose TypeArguments
            // retain nullability recursively for every semantic type shape.
            ImmutableArray<ITypeSymbol> boundTypeArguments = this.GetBoundTypeArguments(generic);
            var result = new List<GTypeReference>();
            for (int i = 0; i < generic.TypeArgumentList.Arguments.Count; i++)
            {
                TypeSyntax argument = generic.TypeArgumentList.Arguments[i];
                ITypeSymbol symbol = i < boundTypeArguments.Length
                    ? boundTypeArguments[i]
                    : this.context.GetTypeInfo(argument).Type;
                result.Add(symbol != null
                    ? this.typeMapper.Map(symbol, this.context, argument.GetLocation())
                    : new NamedTypeReference(argument.ToString()));
            }

            return result;
        }

        private ImmutableArray<ITypeSymbol> GetBoundTypeArguments(GenericNameSyntax generic)
        {
            ISymbol symbol = this.context.GetSymbolInfo(generic).Symbol;
            if (symbol == null && generic.Parent is InvocationExpressionSyntax invocation)
            {
                symbol = this.context.GetSymbolInfo(invocation).Symbol;
            }

            ImmutableArray<ITypeSymbol> typeArguments = symbol switch
            {
                IMethodSymbol method => method.TypeArguments,
                INamedTypeSymbol type => type.TypeArguments,
                _ => ImmutableArray<ITypeSymbol>.Empty,
            };

            return typeArguments.Length == generic.TypeArgumentList.Arguments.Count
                ? typeArguments
                : ImmutableArray<ITypeSymbol>.Empty;
        }

        private GExpression TranslateInterpolatedString(InterpolatedStringExpressionSyntax interpolated)
        {
            // Issue #2015: the number of leading `$` characters on the string-start
            // token (StringStartToken.Text, e.g. "$\"", "$$\"\"\"", "$$$\"\"\"")
            // determines the interpolation-hole delimiter width N for THIS string.
            // For classic/N==1 interpolated strings (including 1-dollar raw
            // strings), a brace run of exactly 2 in the text token is Roslyn's
            // "escaped single literal brace" (see #1882) and must collapse to 1.
            // For raw interpolated strings with N>=2 dollars, brace-doubling is
            // NOT an escape at all: per the C# spec, any brace run SHORTER than N
            // is embedded verbatim, and any run of length >= N is already split by
            // the parser into (literal remainder) + (an actual hole, handled by
            // the InterpolationSyntax case below) — so InterpolatedStringTextSyntax
            // content for N>=2 never needs unescaping and must be copied as-is.
            int dollarCount = 0;
            while (dollarCount < interpolated.StringStartToken.Text.Length
                && interpolated.StringStartToken.Text[dollarCount] == '$')
            {
                dollarCount++;
            }

            bool isClassicSingleDollar = dollarCount <= 1;

            var parts = new List<InterpolationPart>();
            foreach (InterpolatedStringContentSyntax content in interpolated.Contents)
            {
                switch (content)
                {
                    case InterpolatedStringTextSyntax text:
                        // Issue #1882: Roslyn's ValueText does NOT unescape `{{`/`}}`
                        // (those are interpolation-hole delimiters, not string escapes).
                        // G# has no bare `{expr}` hole syntax (only `${expr}`/`$ident`,
                        // see Lexer.cs), so `{`/`}` are always plain literal chars in G#
                        // and need no escaping at all. Unescape here or the doubled
                        // braces get copied verbatim into the G# output.
                        string literalText = isClassicSingleDollar
                            ? text.TextToken.ValueText.Replace("{{", "{").Replace("}}", "}")
                            : text.TextToken.ValueText;
                        parts.Add(InterpolationPart.Literal(literalText));
                        break;

                    case InterpolationSyntax hole:
                        string alignment = hole.AlignmentClause?.Value.ToString();
                        string format = hole.FormatClause?.FormatStringToken.ValueText;
                        parts.Add(InterpolationPart.Hole(
                            this.TranslateExpression(hole.Expression),
                            alignment,
                            format));
                        break;
                }
            }

            return new InterpolatedStringExpression(parts);
        }
    }
}
