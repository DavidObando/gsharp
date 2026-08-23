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
            if (invocation.Expression is IdentifierNameSyntax { Identifier.ValueText: "nameof" }
                && this.context.SemanticModel.GetConstantValue(invocation) is { HasValue: true, Value: string name })
            {
                return LiteralExpression.String(name);
            }

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

            // ADR-0169 analyzer mode: Roslyn methods whose G# counterpart is
            // not a same-shaped method (e.g. GetLocation() -> .Location).
            if (this.InAnalyzerApiMode
                && this.TryTranslateAnalyzerInvocation(invocation, out GExpression analyzerIdiom))
            {
                return analyzerIdiom;
            }

            if (this.context.GetSymbolInfo(invocation).Symbol is IMethodSymbol
                    { MethodKind: MethodKind.LocalFunction } recursiveLocal
                && this.state.LiftedRecursiveLocalFunctions.TryGetValue(
                    recursiveLocal,
                    out LiftedRecursiveLocalFunction recursiveLift))
            {
                var recursiveArguments = this.TranslateCallArguments(
                    invocation,
                    invocation.ArgumentList.Arguments).ToList();
                for (var i = recursiveArguments.Count; i < recursiveLocal.Parameters.Length; i++)
                {
                    IParameterSymbol parameter = recursiveLocal.Parameters[i];
                    GTypeReference parameterType = this.typeMapper.Map(
                        parameter.Type,
                        this.context,
                        parameter.Locations.FirstOrDefault());
                    recursiveArguments.Add(
                        this.BuildOptionalParameterDefault(
                            parameter,
                            parameterType,
                            invocation)
                        ?? LiteralExpression.Null());
                }

                foreach (LiftedLocalFunctionCapture capture in recursiveLift.Captures)
                {
                    GExpression captureArgument =
                        new IdentifierExpression(
                            this.EmittedName(capture.Symbol, capture.Symbol.Name));
                    recursiveArguments.Add(capture.IsByRef
                        ? new UnaryExpression("&", captureArgument)
                        : captureArgument);
                }

                GExpression recursiveTarget = recursiveLift.IsStatic
                    && recursiveLocal.ContainingType is { } recursiveContainingType
                    && !this.IsBareSiblingStaticScope(
                        recursiveContainingType, recursiveLift.Name, invocation)
                        ? new MemberAccessExpression(
                            this.StaticQualifierReceiver(recursiveContainingType, invocation.GetLocation()),
                            recursiveLift.Name)
                        : new IdentifierExpression(recursiveLift.Name);
                IReadOnlyList<GTypeReference> recursiveTypeArguments =
                    invocation.Expression is GenericNameSyntax recursiveGeneric
                        ? this.MapTypeArguments(recursiveGeneric)
                        : null;
                return new InvocationExpression(
                    recursiveTarget,
                    recursiveArguments,
                    recursiveTypeArguments);
            }

            if (this.context.GetSymbolInfo(invocation).Symbol is IMethodSymbol enumTryParse
                && enumTryParse.ContainingType.SpecialType == SpecialType.System_Enum
                && enumTryParse.Name == "TryParse"
                && enumTryParse.IsGenericMethod
                && invocation.Expression is MemberAccessExpressionSyntax enumMember)
            {
                target = new MemberAccessExpression(
                    this.TranslateExpression(enumMember.Expression),
                    "TryParse");
                typeArguments = enumTryParse.TypeArguments
                    .Select(type => this.typeMapper.Map(
                        type,
                        this.context,
                        invocation.GetLocation()))
                    .ToList();
                return new InvocationExpression(
                    target,
                    this.TranslateCallArguments(
                        invocation,
                        invocation.ArgumentList.Arguments),
                    typeArguments);
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

            // Extensions emitted as static helpers — by-ref receivers, exact owned
            // signature collisions, or issue #3413 private-nested owners — use
            // positional static-helper calls.
            if (invocation.Expression is MemberAccessExpressionSyntax extMember
                && this.context.GetSymbolInfo(invocation).Symbol is IMethodSymbol extMethod
                && extMethod.MethodKind == MethodKind.ReducedExtension
                && this.TryGetStaticExtensionHelper(extMethod, out string extOwner, out string extName))
            {
                var extArgs = new List<GExpression>
                {
                    PassStaticExtensionHelperReceiver(
                        this.TranslateReceiverWithNullForgiveness(extMember.Expression),
                        extMethod),
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
            // `recv.M[T](args)`. cs2gs lifts source extension methods
            // of a `static class` to a top-level receiver-clause `func (recv R) M[…](…)`
            // (ADR-0115 §B.19), which gsc invokes ONLY through the receiver form; the
            // static-form call site (`JsonSerialization.FromJsonFile<T>(path)`) would
            // otherwise resolve to a non-existent static member (GS0158). The reduced
            // instance form already binds directly, so it is excluded via
            // `MethodKind.ReducedExtension`. Scoped to source-defined extensions
            // to avoid rewriting BCL static-form calls.
            if (invocation.Expression is MemberAccessExpressionSyntax staticExtMember
                && staticExtMember.Expression is TypeSyntax or IdentifierNameSyntax or MemberAccessExpressionSyntax
                && this.context.SemanticModel.GetOperation(invocation) is IInvocationOperation staticExtOperation
                && staticExtOperation.TargetMethod is IMethodSymbol
                    { IsExtensionMethod: true, MethodKind: not MethodKind.ReducedExtension } staticExt
                && staticExt.Parameters.Length >= 1
                && !(staticExt.ReducedFrom ?? staticExt).DeclaringSyntaxReferences.IsDefaultOrEmpty
                && !this.IsStaticExtensionHelper(staticExt)
                && this.context.SemanticModel.GetSymbolInfo(staticExtMember.Expression).Symbol is INamedTypeSymbol
                && TryGetExplicitExtensionReceiverArgument(
                    staticExtOperation,
                    staticExt,
                    out IArgumentOperation staticExtReceiverArgument))
            {
                GExpression staticExtReceiver = this.TranslateStaticExtensionReceiver(staticExtReceiverArgument);
                var staticExtRest = this.TranslateStaticExtensionTrailingArguments(
                    invocation,
                    (ArgumentSyntax)staticExtReceiverArgument.Syntax);
                IReadOnlyList<GTypeReference> staticExtTypeArgs =
                    staticExtMember.Name is GenericNameSyntax staticExtGeneric
                        ? this.MapTypeArguments(staticExtGeneric)
                        : null;
                return new InvocationExpression(
                    new MemberAccessExpression(
                        staticExtReceiver,
                        this.EmittedName(
                            staticExt.ReducedFrom ?? staticExt,
                            (staticExt.ReducedFrom ?? staticExt).Name)),
                    staticExtRest,
                    staticExtTypeArgs);
            }

            // A SOURCE-defined extension method called through its BARE name
            // (`ApplicableState(book.Conversion)`) — the unqualified static form a
            // sibling member inside the declaring `static class` uses — must be
            // rewritten to the G# receiver-clause call `book.Conversion.ApplicableState()`
            // for the same reason as the `Owner.M(recv, args)` static form above:
            // cs2gs lifts every source extension method to a top-level
            // receiver-clause `func (recv R) M[…](…)` (ADR-0115 §B.19), which gsc
            // invokes ONLY through the receiver form. Without this the bare call
            // falls through to the sibling-static-call branch below and is qualified
            // as `EntityExtensions.ApplicableState(...)`, but the lifted extension
            // leaves no `EntityExtensions` type behind (GS0157). The reduced instance
            // form already binds directly (`MethodKind.ReducedExtension` excluded).
            if (invocation.Expression is SimpleNameSyntax bareExtName
                && bareExtName is IdentifierNameSyntax or GenericNameSyntax
                && this.context.SemanticModel.GetOperation(invocation) is IInvocationOperation bareExtOperation
                && bareExtOperation.TargetMethod is IMethodSymbol
                    { IsExtensionMethod: true, MethodKind: not MethodKind.ReducedExtension } bareExt
                && bareExt.Parameters.Length >= 1
                && !(bareExt.ReducedFrom ?? bareExt).DeclaringSyntaxReferences.IsDefaultOrEmpty
                && !this.IsStaticExtensionHelper(bareExt)
                && TryGetExplicitExtensionReceiverArgument(
                    bareExtOperation,
                    bareExt,
                    out IArgumentOperation bareExtReceiverArgument))
            {
                GExpression bareExtReceiver = this.TranslateStaticExtensionReceiver(bareExtReceiverArgument);
                var bareExtRest = this.TranslateStaticExtensionTrailingArguments(
                    invocation,
                    (ArgumentSyntax)bareExtReceiverArgument.Syntax);
                IReadOnlyList<GTypeReference> bareExtTypeArgs =
                    bareExtName is GenericNameSyntax bareExtGeneric
                        ? this.MapTypeArguments(bareExtGeneric)
                        : null;
                return new InvocationExpression(
                    new MemberAccessExpression(
                        bareExtReceiver,
                        this.EmittedName(
                            bareExt.ReducedFrom ?? bareExt,
                            (bareExt.ReducedFrom ?? bareExt).Name)),
                    bareExtRest,
                    bareExtTypeArgs);
            }

            // A generic call `Foo<T>(...)` carries its type arguments on the name;
            // lift them onto the G# bracket-type-argument form `Foo[T](...)`.
            if (this.context.GetSymbolInfo(invocation).Symbol is IMethodSymbol
                    { MethodKind: MethodKind.LocalFunction } localFunction
                && this.state.LiftedStaticLocalFunctions.TryGetValue(localFunction, out string liftedName)
                && localFunction.ContainingType is { } containingType)
            {
                // Issue #3471: same-type call sites name the lifted `shared`
                // helper bare; only cross-type sites qualify through the owner.
                target = this.IsBareSiblingStaticScope(containingType, liftedName, invocation)
                    ? new IdentifierExpression(liftedName)
                    : new MemberAccessExpression(
                        this.StaticQualifierReceiver(containingType, invocation.GetLocation()),
                        liftedName);
                if (invocation.Expression is GenericNameSyntax liftedGeneric)
                {
                    typeArguments = this.MapTypeArguments(liftedGeneric);
                }
            }
            else if (this.context.GetSymbolInfo(invocation).Symbol is IMethodSymbol
                    { MethodKind: MethodKind.LocalFunction } groupMember
                && this.state.RecursiveLocalFunctionGroups.TryGetValue(
                    groupMember, out RecursiveLocalFunctionGroup recursiveGroup)
                && recursiveGroup.Members.Contains(groupMember, SymbolEqualityComparer.Default))
            {
                // Issue #3399: a call to a recursive SCC partner from inside a
                // closure body — the partner is a nullable function-typed local,
                // so pass it through a postfix null assertion (`X!!`, ADR-0069)
                // that unwraps the declared local's `nil` default.
                target = new NonNullAssertionExpression(
                    new IdentifierExpression(recursiveGroup.NameOf(groupMember)));
            }
            else if (invocation.Expression is GenericNameSyntax generic)
            {
                ISymbol genericSymbol = this.context.GetSymbolInfo(invocation).Symbol;
                if (genericSymbol is IMethodSymbol
                    { IsStatic: true, ContainingType: { TypeKind: TypeKind.Class or TypeKind.Struct } genericOwner } genericMethod
                    && RequiresQualifiedImportedContextualCall(
                        genericMethod,
                        includeGenericPrefix: true))
                {
                    target = new MemberAccessExpression(
                        this.StaticQualifierReceiver(
                            genericOwner,
                            generic.GetLocation()),
                        this.EmittedName(
                            genericMethod,
                            generic.Identifier.ValueText));
                }
                else
                {
                    target = new IdentifierExpression(this.EmittedName(
                        genericSymbol,
                        generic.Identifier.ValueText));
                }

                typeArguments = this.MapTypeArguments(generic);
            }
            else if (invocation.Expression is MemberAccessExpressionSyntax member
                && member.Name is GenericNameSyntax memberGeneric)
            {
                target = new MemberAccessExpression(
                    this.TranslateExpression(member.Expression),
                    this.EmittedName(
                        this.context.GetSymbolInfo(invocation).Symbol,
                        memberGeneric.Identifier.ValueText));
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
                    this.EmittedName(
                        this.context.GetSymbolInfo(invocation).Symbol,
                        memberBindingGeneric.Identifier.ValueText));
                typeArguments = this.MapTypeArguments(memberBindingGeneric);
            }
            else if (invocation.Expression is IdentifierNameSyntax bareName &&
                this.context.GetSymbolInfo(bareName).Symbol is IMethodSymbol { IsStatic: true, MethodKind: not MethodKind.LocalFunction } staticMethod &&
                staticMethod.ContainingType is { TypeKind: TypeKind.Class or TypeKind.Struct } owner &&
                !owner.IsImplicitlyDeclared &&
                (!this.IsStaticUsingTarget(owner)
                    || RequiresQualifiedImportedContextualCall(staticMethod)) &&
                !SymbolEqualityComparer.Default.Equals(owner.OriginalDefinition, this.entryType?.OriginalDefinition) &&
                !(this.IsBareSiblingStaticScope(
                        owner,
                        this.EmittedName(staticMethod, staticMethod.Name),
                        bareName)

                    // Issue #3490: gsc double-binds arguments of a BARE
                    // sibling call when the argument subtree carries an inline
                    // `out var` declaration (GS9002 + GS0102 for the same
                    // declaration), while the qualified spelling compiles —
                    // so such calls keep the qualifier.
                    && !invocation.ArgumentList.Arguments.Any(argument =>
                        argument.DescendantNodesAndSelf()
                            .OfType<DeclarationExpressionSyntax>()
                            .Any())))
            {
                // A C# bare sibling static call (`Round(value, 2)`) carries an
                // implicit type qualifier only where the emitted body leaves the
                // owner's type scope (issue #3471) — e.g. a lifted extension
                // `func` at file scope — and must then be qualified through the
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
                    this.EmittedName(staticMethod, staticMethod.Name));
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
                    || this.ReceiverIsNullableReferenceFieldOrProperty(invocation.Expression))
                && !this.IsWithinExpressionTreeLambda(invocation.Expression))
            {
                target = new NonNullAssertionExpression(target);
            }

            return new InvocationExpression(target, arguments, typeArguments);
        }

        private static bool RequiresQualifiedImportedContextualCall(
            IMethodSymbol method,
            bool includeGenericPrefix = false)
        {
            if (!method.DeclaringSyntaxReferences.IsDefaultOrEmpty)
            {
                return false;
            }

            var context =
                GSharp.Core.CodeAnalysis.Syntax.IdentifierNameContext.Invocation;
            if (includeGenericPrefix)
            {
                context |= GSharp.Core.CodeAnalysis.Syntax.IdentifierNameContext.Index;
            }

            return GSharp.Core.CodeAnalysis.Syntax.SyntaxFacts.IsReservedIdentifier(
                method.Name,
                context);
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
                receiverArgument.Parameter,
                includePromotedValue: true);
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
            InvocationExpressionSyntax invocation,
            ArgumentSyntax receiverArgument)
        {
            List<GExpression> translated = this.TranslateCallArguments(
                invocation,
                invocation.ArgumentList.Arguments);
            int receiverIndex = invocation.ArgumentList.Arguments.IndexOf(receiverArgument);
            if (receiverIndex >= 0 && receiverIndex < translated.Count)
            {
                translated.RemoveAt(receiverIndex);
            }

            return translated;
        }

        // Resolves the receiver of a delegate/event `.Invoke(...)` call to the value
        // that G# invokes directly. `d.Invoke(...)` → `d`; the null-conditional
        // `d?.Invoke(...)` form reaches here as a member-binding whose receiver is the
        // conditional-receiver placeholder (so the enclosing `?.` renders `d?(...)`).
        private bool TryGetDelegateInvokeReceiver(
            ExpressionSyntax callee, out GExpression receiver)
        {
            switch (callee)
            {
                case MemberAccessExpressionSyntax member
                    when member.Name.Identifier.ValueText == "Invoke":
                    // A nullable delegate/event receiver spelled `field.Invoke(...)`
                    // needs the same `!!` the direct-call spelling `field(...)` gets
                    // below (#1598): route through the shared receiver-forgiveness
                    // helper rather than a bare translate, or the `.Invoke` spelling
                    // bypasses the assertion and emits an unforgiven `field(...)`
                    // (GS0131).
                    receiver = this.TranslateReceiverWithNullForgiveness(member.Expression);
                    return true;
                case MemberBindingExpressionSyntax binding
                    when binding.Name.Identifier.ValueText == "Invoke":
                    receiver = new ConditionalReceiverExpression();
                    return true;

                default:
                    receiver = null;
                    return false;
            }
        }

        /// <summary>
        /// Rewrites a null-conditional call to a static-helper extension method
        /// into the
        /// ternary
        /// <c>if recv != nil { Owner.M(recv!!, args) } else { default(R?) }</c>.
        /// The <c>?.</c> member-binding form cannot bind to a static helper.
        /// </summary>
        private bool TryTranslateNullConditionalStaticExtensionHelper(
            ConditionalAccessExpressionSyntax conditionalAccess,
            out GExpression result)
        {
            result = null;

            if (!this.TryMatchNullConditionalStaticExtensionHelper(
                    conditionalAccess,
                    out InvocationExpressionSyntax invocation,
                    out IMethodSymbol method,
                    out string owner,
                    out string name,
                    out SimpleNameSyntax helperName,
                    out ExpressionSyntax chainedReceiver))
            {
                return false;
            }

            if (DependsOnEnclosingConditionalReceiver(conditionalAccess.Expression))
            {
                this.ReportUnsupportedNestedConditionalStaticHelperChain(conditionalAccess);
                result = this.PreserveNullConditionalStaticExtensionInvocation(
                    conditionalAccess,
                    invocation,
                    helperName);
                return true;
            }

            if (method.ReturnsVoid)
            {
                return false;
            }

            if (chainedReceiver != null &&
                !IsSupportedConditionalStaticHelperReceiver(chainedReceiver))
            {
                this.ReportUnsupportedConditionalStaticHelperChain(conditionalAccess);
                result = this.PreserveNullConditionalStaticExtensionInvocation(
                    conditionalAccess,
                    invocation,
                    helperName);
                return true;
            }

            if (this.context.GetTypeInfo(conditionalAccess).Type is not { } conditionalType)
            {
                return false;
            }

            this.BuildNullConditionalStaticExtensionHelper(
                conditionalAccess,
                invocation,
                owner,
                name,
                helperName,
                chainedReceiver,
                out GExpression guard,
                out GExpression call,
                hostLocalAssignmentSeam: true);

            GTypeReference nullableType = this.typeMapper.Map(
                conditionalType,
                this.context,
                conditionalAccess.GetLocation());
            if (!nullableType.IsNullable)
            {
                nullableType = MakeNullable(nullableType);
            }

            result = new ParenthesizedExpression(
                new IfExpression(guard, call, new DefaultValueExpression(nullableType)));
            return true;
        }

        private bool TryTranslateNullConditionalStaticExtensionHelperStatement(
            ConditionalAccessExpressionSyntax conditionalAccess,
            out GStatement result)
        {
            result = null;
            if (!this.TryMatchNullConditionalStaticExtensionHelper(
                    conditionalAccess,
                    out InvocationExpressionSyntax invocation,
                    out IMethodSymbol method,
                    out string owner,
                    out string name,
                    out SimpleNameSyntax helperName,
                    out ExpressionSyntax chainedReceiver) ||
                !method.ReturnsVoid)
            {
                return false;
            }

            if (DependsOnEnclosingConditionalReceiver(conditionalAccess.Expression))
            {
                this.ReportUnsupportedNestedConditionalStaticHelperChain(conditionalAccess);
                result = new ExpressionStatement(
                    this.PreserveNullConditionalStaticExtensionInvocation(
                        conditionalAccess,
                        invocation,
                        helperName));
                return true;
            }

            if (chainedReceiver != null &&
                !IsSupportedConditionalStaticHelperReceiver(chainedReceiver))
            {
                this.ReportUnsupportedConditionalStaticHelperChain(conditionalAccess);
                result = new ExpressionStatement(
                    this.PreserveNullConditionalStaticExtensionInvocation(
                        conditionalAccess,
                        invocation,
                        helperName));
                return true;
            }

            var localStatements = new List<GStatement>();
            var replacements = new List<ExpressionSyntax>();
            List<AssignmentExpressionSyntax> embedded =
                this.HoistAssignmentsInOrder(
                    conditionalAccess.WhenNotNull,
                    includeSelf: true,
                    localStatements,
                    replacements);
            GExpression guard;
            GExpression call;
            try
            {
                this.BuildNullConditionalStaticExtensionHelper(
                    conditionalAccess,
                    invocation,
                    owner,
                    name,
                    helperName,
                    chainedReceiver,
                    out guard,
                    out call,
                    hostLocalAssignmentSeam: false);
            }
            finally
            {
                this.ReleaseHoistedAssignments(embedded, replacements);
            }

            localStatements.Add(new ExpressionStatement(call));
            result = new IfStatement(
                guard,
                new BlockStatement(localStatements));
            return true;
        }

        private bool TryMatchNullConditionalStaticExtensionHelper(
            ConditionalAccessExpressionSyntax conditionalAccess,
            out InvocationExpressionSyntax invocation,
            out IMethodSymbol method,
            out string owner,
            out string name,
            out SimpleNameSyntax helperName,
            out ExpressionSyntax chainedReceiver)
        {
            invocation = conditionalAccess.WhenNotNull as InvocationExpressionSyntax;
            method = invocation == null
                ? null
                : this.context.GetSymbolInfo(invocation).Symbol as IMethodSymbol;
            owner = null;
            name = null;
            helperName = null;
            chainedReceiver = null;
            if (invocation == null ||
                method == null ||
                !this.TryGetStaticExtensionHelper(method, out owner, out name))
            {
                return false;
            }

            switch (invocation.Expression)
            {
                case MemberBindingExpressionSyntax binding:
                    helperName = binding.Name;
                    return true;

                case MemberAccessExpressionSyntax member:
                    helperName = member.Name;
                    chainedReceiver = member.Expression;
                    return true;

                default:
                    return false;
            }
        }

        private void BuildNullConditionalStaticExtensionHelper(
            ConditionalAccessExpressionSyntax conditionalAccess,
            InvocationExpressionSyntax invocation,
            string owner,
            string name,
            SimpleNameSyntax helperName,
            ExpressionSyntax chainedReceiver,
            out GExpression guard,
            out GExpression call,
            bool hostLocalAssignmentSeam)
        {
            GExpression receiver = this.CaptureReceiverOnce(
                this.TranslateExpression(conditionalAccess.Expression),
                conditionalAccess.Expression,
                "a conditional-access helper call here has no enclosing evaluation seam to capture its receiver once.");
            GExpression helperReceiver = new NonNullAssertionExpression(receiver);
            if (chainedReceiver != null)
            {
                helperReceiver = this.TranslateConditionalStaticHelperReceiver(
                    chainedReceiver,
                    helperReceiver);
            }

            IReadOnlyList<GTypeReference> callTypeArgs = helperName is GenericNameSyntax generic
                ? this.MapTypeArguments(generic)
                : null;

            GExpression TranslateCall()
            {
                var callArgs = new List<GExpression> { helperReceiver };
                callArgs.AddRange(this.TranslateArguments(invocation.ArgumentList.Arguments));
                return new InvocationExpression(
                    new MemberAccessExpression(new IdentifierExpression(owner), name),
                    callArgs,
                    callTypeArgs);
            }

            call = hostLocalAssignmentSeam
                && this.RequiresLocalAssignmentSeam(conditionalAccess.WhenNotNull)
                ? this.TranslateWithLocalAssignmentSeam(
                    conditionalAccess.WhenNotNull,
                    TranslateCall)
                : TranslateCall();
            guard = new BinaryExpression(receiver, "!=", LiteralExpression.Null());
        }

        private static bool IsSupportedConditionalStaticHelperReceiver(ExpressionSyntax expression) =>
            expression is MemberBindingExpressionSyntax ||
            (expression is MemberAccessExpressionSyntax member &&
             IsSupportedConditionalStaticHelperReceiver(member.Expression));

        private GExpression TranslateConditionalStaticHelperReceiver(
            ExpressionSyntax expression,
            GExpression conditionalReceiver)
        {
            GExpression previous = this.state.ConditionalReceiverReplacement;
            this.state.ConditionalReceiverReplacement = conditionalReceiver;
            try
            {
                return this.TranslateExpression(expression);
            }
            finally
            {
                this.state.ConditionalReceiverReplacement = previous;
            }
        }

        private static bool DependsOnEnclosingConditionalReceiver(ExpressionSyntax expression) =>
            expression.DescendantNodesAndSelf(
                    descendIntoChildren: node => node is not ConditionalAccessExpressionSyntax)
                .Any(node => node is MemberBindingExpressionSyntax or ElementBindingExpressionSyntax);

        private GExpression PreserveNullConditionalStaticExtensionInvocation(
            ConditionalAccessExpressionSyntax conditionalAccess,
            InvocationExpressionSyntax invocation,
            SimpleNameSyntax helperName)
        {
            IReadOnlyList<GTypeReference> typeArguments = helperName is GenericNameSyntax generic
                ? this.MapTypeArguments(generic)
                : null;
            return new ConditionalAccessExpression(
                this.TranslateExpression(conditionalAccess.Expression),
                new InvocationExpression(
                    this.TranslateExpression(invocation.Expression),
                    this.TranslateCallArguments(invocation, invocation.ArgumentList.Arguments),
                    typeArguments));
        }

        private void ReportUnsupportedConditionalStaticHelperChain(
            ConditionalAccessExpressionSyntax conditionalAccess)
        {
            const string message =
                "a null-conditional static-helper extension call with a non-member receiver chain " +
                "cannot be lowered without losing the conditional receiver; the safe extension form " +
                "is retained instead (issue #2821).";
            this.context.ReportUnsupported(conditionalAccess, message);
        }

        private void ReportUnsupportedNestedConditionalStaticHelperChain(
            ConditionalAccessExpressionSyntax conditionalAccess)
        {
            const string message =
                "a static-helper extension call nested under another null-conditional receiver " +
                "cannot be lowered without spilling a bare conditional receiver; the safe extension " +
                "form is retained instead (issue #2821).";
            this.context.ReportUnsupported(conditionalAccess, message);
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
        /// Determines whether <paramref name="method"/> is emitted as a plain
        /// static helper rather than a receiver-clause method.
        /// </summary>
        /// <param name="method">The bound (possibly reduced) call symbol.</param>
        /// <param name="ownerName">The declaring static class name when matched.</param>
        /// <param name="methodName">The helper method name when matched.</param>
        /// <returns><see langword="true"/> when the call targets a static helper.</returns>
        private bool TryGetStaticExtensionHelper(IMethodSymbol method, out string ownerName, out string methodName)
        {
            ownerName = null;
            methodName = null;
            if (method == null || !method.IsExtensionMethod)
            {
                return false;
            }

            if (this.HasReceiverCompanion(method) ||
                !this.IsStaticExtensionHelper(method))
            {
                return false;
            }

            IMethodSymbol original = method.ReducedFrom ?? method;
            ownerName = original.ContainingType is { } containingType
                ? this.EmittedName(containingType, containingType.Name)
                : null;
            methodName = this.EmittedName(original, original.Name);
            return ownerName != null;
        }

        private bool TryGetStaticExtensionHelperForMethodGroup(
            IMethodSymbol method,
            out string ownerName,
            out string methodName)
        {
            if (this.TryGetStaticExtensionHelper(
                method,
                out ownerName,
                out methodName))
            {
                return true;
            }

            IMethodSymbol original = method?.ReducedFrom ?? method;
            if (!this.HasReceiverCompanion(original)
                || !this.IsStaticExtensionHelper(original)
                || original?.ReturnType is not INamedTypeSymbol taskLike
                || taskLike.Name is not ("Task" or "ValueTask")
                || taskLike.ContainingNamespace?.ToDisplayString()
                    != "System.Threading.Tasks")
            {
                ownerName = null;
                methodName = null;
                return false;
            }

            ownerName = original.ContainingType is { } containingType
                ? this.EmittedName(containingType, containingType.Name)
                : null;
            methodName = this.EmittedName(original, original.Name);
            return ownerName != null;
        }

        private GExpression TranslateStaticExtensionHelperMethodGroup(
            MemberAccessExpressionSyntax member,
            IMethodSymbol method,
            string ownerName,
            string methodName)
        {
            GExpression receiver = this.CaptureMethodGroupReceiver(
                this.TranslateReceiverWithNullForgiveness(member.Expression),
                member.Expression);

            IMethodSymbol invoke = (this.context.GetTypeInfo(member).ConvertedType as INamedTypeSymbol)
                ?.DelegateInvokeMethod;
            ImmutableArray<IParameterSymbol> sourceParameters =
                invoke?.Parameters ?? method.Parameters;
            var parameters = new List<Parameter>(sourceParameters.Length);
            var arguments = new List<GExpression>(sourceParameters.Length + 1)
            {
                PassStaticExtensionHelperReceiver(receiver, method),
            };

            for (int i = 0; i < sourceParameters.Length; i++)
            {
                Parameter mapped = this.MapParameter(
                    sourceParameters[i],
                    member,
                    promoteNullability: false);
                string name = $"__arg{i}";
                parameters.Add(new Parameter(
                    name,
                    mapped.Type,
                    mapped.IsVariadic,
                    mapped.RefKind));
                GExpression argument = new IdentifierExpression(name);
                if (sourceParameters[i].RefKind is RefKind.Ref or RefKind.Out)
                {
                    argument = new UnaryExpression("&", argument);
                }

                arguments.Add(argument);
            }

            IMethodSymbol original = method.ReducedFrom ?? method;
            IReadOnlyList<GTypeReference> typeArguments = original.IsGenericMethod
                ? method.TypeArguments
                    .Select(type => this.typeMapper.Map(type, this.context, member.GetLocation()))
                    .ToList()
                : null;
            var call = new InvocationExpression(
                new MemberAccessExpression(new IdentifierExpression(ownerName), methodName),
                arguments,
                typeArguments);
            return new LambdaExpression(parameters, expressionBody: call);
        }

        private static GExpression PassStaticExtensionHelperReceiver(
            GExpression receiver,
            IMethodSymbol method)
        {
            IMethodSymbol original = method.ReducedFrom ?? method;
            return original.Parameters[0].RefKind is RefKind.Ref or RefKind.Out
                ? new UnaryExpression("&", receiver)
                : receiver;
        }

        private GExpression CaptureMethodGroupReceiver(
            GExpression receiver,
            ExpressionSyntax receiverSyntax) =>
            this.CaptureReceiverOnce(
                receiver,
                receiverSyntax,
                "a static-helper extension method group here has no enclosing evaluation seam to capture its receiver once.");

        private GExpression CaptureReceiverOnce(
            GExpression receiver,
            ExpressionSyntax receiverSyntax,
            string unsupportedMessage)
        {
            // Issue #3357/#3360: a trivial, stable receiver needs no temp. A
            // mutable/reassigned local still spills because C# captures the
            // receiver value when the method group is formed, while the
            // synthesized G# lambda would otherwise re-read it when invoked.
            if (IsTrivialOperand(receiver) &&
                this.IsStableMethodGroupReceiver(receiverSyntax))
            {
                return receiver;
            }

            if (this.state.PendingSpillPrologue != null)
            {
                string temp = $"__spill{this.state.SpillCounter++}";
                this.state.PendingSpillPrologue.Add(
                    new LocalDeclarationStatement(BindingKind.Let, temp, initializer: receiver));
                return new IdentifierExpression(temp);
            }

            this.context.ReportUnsupported(
                receiverSyntax,
                unsupportedMessage);
            return receiver;
        }

        private bool IsStableMethodGroupReceiver(ExpressionSyntax receiverSyntax)
        {
            if (receiverSyntax is LiteralExpressionSyntax)
            {
                return true;
            }

            ITypeSymbol receiverType = this.context.GetTypeInfo(receiverSyntax).Type;
            if (receiverSyntax is ThisExpressionSyntax)
            {
                return receiverType?.IsReferenceType == true;
            }

            ISymbol symbol = this.context.GetSymbolInfo(receiverSyntax).Symbol;
            if (symbol is ILocalSymbol { IsConst: true })
            {
                return true;
            }

            if (symbol is not ILocalSymbol and not IParameterSymbol)
            {
                return false;
            }

            if (symbol is ILocalSymbol { RefKind: not RefKind.None }
                or IParameterSymbol { RefKind: not RefKind.None })
            {
                return false;
            }

            bool stableValueShape = receiverType?.IsReferenceType == true ||
                receiverType?.TypeKind == TypeKind.Enum ||
                receiverType?.SpecialType != SpecialType.None ||
                receiverType is INamedTypeSymbol { IsReadOnly: true };
            return stableValueShape &&
                !this.IsSymbolReassigned(symbol, this.state.CurrentBodyScope);
        }

        /// <summary>
        /// Translates a single C# call argument, honoring <c>out</c>/<c>ref</c>
        /// argument forms (ADR-0115 §B; sample <c>TryParseOutVar.gs</c>): an
        /// <c>out</c>/<c>ref</c> argument naming a pre-declared variable maps to
        /// the address-of form <c>&amp;x</c>, an inline <c>out var x</c> maps to
        /// <c>out var x</c>, and an <c>out _</c> discard maps to <c>out _</c>.
        /// </summary>
        private List<GExpression> TranslateArguments(SeparatedSyntaxList<ArgumentSyntax> arguments) =>
            arguments.Select(a => this.TranslateArgument(a)).ToList();

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
        /// <c>HashSet&lt;T&gt;</c> or any user <c>[CollectionBuilder]</c> type has no
        /// gsc construction form and must gap instead of silently mismatching the
        /// declared parameter type. Object creation additionally lowers
        /// <c>Span&lt;T&gt;</c>/<c>ReadOnlySpan&lt;T&gt;</c> through an array argument,
        /// reusing gsc's existing array-to-span implicit conversion.
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

        private static bool IsSpanParamsCollectionType(ITypeSymbol type) =>
            type is INamedTypeSymbol { TypeArguments: [ITypeSymbol] } named
            && named.ContainingNamespace?.ToDisplayString() == "System"
            && named.Name is "Span" or "ReadOnlySpan";

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
                return this.TranslateArguments(arguments);
            }

            bool spanObjectCreation = callSyntax is BaseObjectCreationExpressionSyntax
                && IsSpanParamsCollectionType(paramsCollectionArg.Parameter.Type);
            if (!IsSupportedParamsCollectionType(paramsCollectionArg.Parameter.Type)
                && !spanObjectCreation)
            {
                // gsc can only construct a List[T]{...} literal at the call site
                // (BuildConstruction below has no other collection constructor to
                // reach for). Anything else — HashSet<T>, a
                // [CollectionBuilder] type, or a collection type with other than
                // one type argument — has no gsc construction form. Object
                // creation's Span<T>/ReadOnlySpan<T> case was handled above.
                //
                // Only gap when the callee itself is declared IN SOURCE: MapParameter
                // gaps that same declaration (issue #1901 follow-up), and a half-
                // translated callee with no working caller is what we're guarding
                // against here — so both sides need to stay consistent. A callee from
                // a REFERENCED method (e.g. BCL
                // `Task.WhenAll(params ReadOnlySpan<Task>)`) is never translated
                // as a declaration, so ordinary calls retain the pre-#1901
                // fallback. Object creation must still gap: dropping its implicit
                // params-collection argument invents a nonexistent zero-arg
                // constructor.
                if (targetMethod?.DeclaringSyntaxReferences.IsEmpty == false
                    || callSyntax is BaseObjectCreationExpressionSyntax)
                {
                    this.context.ReportUnsupported(
                        callSyntax,
                        $"params collection of type '{paramsCollectionArg.Parameter.Type}' has no gsc construction form.");
                }

                return this.TranslateArguments(arguments);
            }

            var translatedArguments = this.TranslateArgumentsBeforeParamsCollection(
                callSyntax,
                arguments,
                operationArguments,
                paramsCollectionArg,
                out int consumedSyntaxArguments);

            Location callLocation = callSyntax.GetLocation();
            GTypeReference paramsCollectionType = this.typeMapper.Map(
                paramsCollectionArg.Parameter.Type,
                this.context,
                callLocation);
            ITypeSymbol paramsElementType = ((INamedTypeSymbol)paramsCollectionArg.Parameter.Type).TypeArguments[0];
            GTypeReference elementType = this.typeMapper.Map(paramsElementType, this.context, callLocation);

            var paramsValues = arguments.Skip(consumedSyntaxArguments)
                .Select(a => this.TranslateArgument(a))
                .ToList();
            if (spanObjectCreation)
            {
                translatedArguments.Add(this.CoerceMaterializedArgument(
                    new ArrayLiteralExpression(elementType, paramsValues),
                    paramsCollectionArg.Parameter.Type,
                    callLocation));
                return translatedArguments;
            }

            var collectionElements = paramsValues
                .Select(value => new CollectionInitializerElement(value))
                .ToList();
            bool exactListParameter = paramsCollectionArg.Parameter.Type
                is INamedTypeSymbol { Name: "List" } listParameter
                && listParameter.ContainingNamespace?.ToDisplayString()
                    == "System.Collections.Generic";
            GTypeReference listType = exactListParameter
                ? paramsCollectionType
                : this.typeMapper.Map(
                    this.context.Compilation
                        .GetTypeByMetadataName("System.Collections.Generic.List`1")
                        ?.Construct(paramsElementType),
                    this.context,
                    callLocation);
            GExpression construction = BuildConstruction(listType, new List<GExpression>());

            // A zero-element params-collection call (`Total()`) has no elements to
            // brace — gsc's collection-initializer form requires at least one
            // element (an empty `{ }` fails to bind, GS0157); the bare
            // construction call (`List[int32]()`) is the canonical empty form
            // (mirrors the C# `[]`-collection-expression lowering above).
            GExpression collectionArgument = collectionElements.Count == 0
                ? construction
                : new CollectionInitializerExpression(construction, collectionElements);
            translatedArguments.Add(exactListParameter
                ? collectionArgument
                : this.CoerceMaterializedArgument(
                    collectionArgument,
                    paramsCollectionArg.Parameter.Type,
                    callLocation));
            return translatedArguments;
        }

        private List<GExpression> TranslateArgumentsBeforeParamsCollection(
            SyntaxNode callSyntax,
            SeparatedSyntaxList<ArgumentSyntax> arguments,
            ImmutableArray<IArgumentOperation> operationArguments,
            IArgumentOperation paramsCollectionArgument,
            out int consumedSyntaxArguments)
        {
            var result = new List<GExpression>(paramsCollectionArgument.Parameter.Ordinal);
            consumedSyntaxArguments = 0;
            foreach (IArgumentOperation operationArgument in operationArguments)
            {
                if (operationArgument.ArgumentKind == ArgumentKind.ParamCollection)
                {
                    break;
                }

                if (operationArgument.ArgumentKind == ArgumentKind.DefaultValue)
                {
                    result.Add(this.TranslateOperationDefaultArgument(
                        callSyntax,
                        operationArgument,
                        "parameter",
                        coerceToParameterType: true));
                    continue;
                }

                result.Add(this.TranslateArgument(arguments[consumedSyntaxArguments]));
                consumedSyntaxArguments++;
            }

            return result;
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
                    result.Add(this.TranslateOperationDefaultArgument(
                        callSyntax,
                        argumentOperation,
                        "lambda parameter",
                        coerceToParameterType: false));
                    continue;
                }

                result.Add(this.TranslateArgument(arguments[nextSyntaxArgument]));
                nextSyntaxArgument++;
            }

            return result;
        }

        private GExpression TranslateOperationDefaultArgument(
            SyntaxNode callSyntax,
            IArgumentOperation argumentOperation,
            string parameterKind,
            bool coerceToParameterType)
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
                bool legitimateNull = constant.HasValue && constant.Value == null;
                if (!legitimateNull)
                {
                    this.context.ReportUnsupported(
                        callSyntax,
                        $"{parameterKind} default value of type '{argumentOperation.Parameter.Type}' has no gsc constant form.");
                }

                defaultValue = new IdentifierExpression("nil");
            }

            return coerceToParameterType
                ? this.CoerceMaterializedArgument(
                    defaultValue,
                    argumentOperation.Parameter.Type,
                    callSyntax.GetLocation())
                : defaultValue;
        }

        private GExpression TranslateArgument(ArgumentSyntax argument)
        {
            GExpression value = this.TranslateArgumentValue(argument);
            return argument.NameColon == null
                ? value
                : new NamedArgumentExpression(
                    this.EmittedName(
                        this.context.GetSymbolInfo(argument.NameColon.Name).Symbol,
                        argument.NameColon.Name.Identifier.ValueText),
                    value);
        }

        private GExpression TranslateArgumentValue(ArgumentSyntax argument)
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

                if (argument.Expression is IdentifierNameSyntax { Identifier.ValueText: "_" })
                {
                    return new OutArgumentExpression("out", "_");
                }

                GExpression translatedExisting = this.TranslateExpression(argument.Expression);
                if (translatedExisting is IdentifierExpression identifier)
                {
                    return new OutArgumentExpression("out", identifier.Name);
                }

                // Non-identifier lvalues keep the universal address form.
                return new UnaryExpression("&", translatedExisting);
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
            bool isXunitNullAssertion = this.IsXunitNullAssertionArgument(argument);
            IArgumentOperation argumentOperation = this.context.SemanticModel.GetOperation(argument) as IArgumentOperation;
            ILocalSymbol argumentLocal = this.context.GetSymbolInfo(argument.Expression).Symbol as ILocalSymbol
                ?? GetReferencedLocal(argumentOperation?.Value);
            bool isFlowNarrowedLocal = argumentLocal != null
                && this.IsDominatedByNullCheckGuard(argument.Expression, argumentLocal);
            bool targetIsPromotedMigratedSibling = argumentOperation?.Parameter is { } siblingParameter
                && !SymbolEqualityComparer.Default.Equals(
                    siblingParameter.ContainingAssembly,
                    this.context.Compilation.Assembly)
                && siblingParameter.ContainingAssembly?.Name is { } targetAssemblyName
                && targetAssemblyName != this.context.Compilation.AssemblyName
                && (this.context.RepositoryCompilations ?? this.context.SiblingCompilations)?.Any(
                    compilation => compilation.AssemblyName == targetAssemblyName) == true
                && this.ShouldPromoteToNullableReference(siblingParameter);
            bool targetRequiresNonNull = argumentOperation?.Parameter is not { } targetParameter
                || (this.TargetWillRemainNonNullableReference(targetParameter.Type, targetParameter)
                    && !targetIsPromotedMigratedSibling);
            if (!IsNameOfArgument(argument)
                && !isXunitNullAssertion
                && targetRequiresNonNull
                && !isFlowNarrowedLocal
                && this.ReceiverNeedsNullForgiveness(argument.Expression))
            {
                return EnsureNonNullAssertion(this.TranslateExpression(argument.Expression));
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
            GExpression exactCallable = this.TranslateExactCallableArgument(argument);
            GExpression translated = this.CoercePointerConversion(
                argument.Expression,
                this.CoerceNumericArgumentToConverted(
                    argument,
                    exactCallable ?? this.TranslateExpression(argument.Expression)));
            if (!IsNameOfArgument(argument)
                && !isXunitNullAssertion
                && targetRequiresNonNull
                && argumentOperation is { Parameter: { } parameter })
            {
                translated = this.ForgiveNullableReferenceValue(
                    argument.Expression,
                    translated,
                    parameter.Type,
                    parameter,
                    includePromotedValue: true);
            }

            return translated;
        }

        // Issue #3414: Roslyn has already fixed the converted delegate signature
        // at a direct argument. Preserve it when the callable's natural signature
        // differs, instead of leaving gsc to materialize the wrong delegate ABI.
        private GExpression TranslateExactCallableArgument(ArgumentSyntax argument)
        {
            ExpressionSyntax expression = argument.Expression;
            if (expression is AnonymousFunctionExpressionSyntax lambda
                && this.TryGetConvertedDelegateInvoke(lambda, out IMethodSymbol lambdaInvoke))
            {
                return this.typeMapper.WithMetadataImportCollisionQualification(
                    () => this.LambdaResultNeedsExactTarget(lambda, lambdaInvoke)
                        ? this.TranslateLambda(lambda, lambdaInvoke)
                        : this.TranslateLambda(lambda));
            }

            if (this.TryGetMethodGroupArgument(
                    argument,
                    out IMethodSymbol method,
                    out IMethodSymbol methodGroupInvoke)
                && MethodGroupNeedsExactTarget(method, methodGroupInvoke))
            {
                return this.typeMapper.WithMetadataImportCollisionQualification(
                    () => this.TranslateExactMethodGroupArgument(
                        expression,
                        method,
                        methodGroupInvoke));
            }

            return null;
        }

        private bool TryGetMethodGroupArgument(
            ArgumentSyntax argument,
            out IMethodSymbol method,
            out IMethodSymbol invoke)
        {
            method = null;
            invoke = null;
            if (this.context.SemanticModel.GetOperation(argument) is not IArgumentOperation argumentOperation
                || argumentOperation.Value is not IDelegateCreationOperation delegateCreation
                || delegateCreation.Target is not IMethodReferenceOperation methodReference
                || delegateCreation.Type is not INamedTypeSymbol delegateType)
            {
                return false;
            }

            method = methodReference.Method;
            invoke = delegateType.DelegateInvokeMethod;
            return method != null && invoke != null;
        }

        private bool TryGetConvertedDelegateInvoke(
            ExpressionSyntax expression,
            out IMethodSymbol invoke)
        {
            invoke = (this.context.GetTypeInfo(expression).ConvertedType as INamedTypeSymbol)
                ?.DelegateInvokeMethod;
            return invoke != null;
        }

        private bool LambdaResultNeedsExactTarget(
            AnonymousFunctionExpressionSyntax lambda,
            IMethodSymbol invoke)
        {
            if (invoke.ReturnsVoid)
            {
                return false;
            }

            ITypeSymbol targetResult = invoke.ReturnType;
            if (lambda.AsyncKeyword.IsKind(SyntaxKind.AsyncKeyword)
                && targetResult is INamedTypeSymbol task
                && task.Name == "Task"
                && task.ContainingNamespace?.ToDisplayString() == "System.Threading.Tasks")
            {
                if (!task.IsGenericType)
                {
                    return false;
                }

                targetResult = task.TypeArguments[0];
            }

            IEnumerable<ExpressionSyntax> results = lambda.Body switch
            {
                ExpressionSyntax expression => new[] { expression },
                BlockSyntax block => block
                    .DescendantNodes(static node =>
                        node is not AnonymousFunctionExpressionSyntax
                            and not LocalFunctionStatementSyntax)
                    .OfType<ReturnStatementSyntax>()
                    .Where(statement => statement.Expression != null)
                    .Select(statement => statement.Expression),
                _ => Enumerable.Empty<ExpressionSyntax>(),
            };

            return results.Any(result =>
            {
                ITypeSymbol resultType = this.context.GetTypeInfo(result).Type;
                return resultType != null
                    && !SymbolEqualityComparer.IncludeNullability.Equals(
                        resultType,
                        targetResult);
            });
        }

        private static bool MethodGroupNeedsExactTarget(
            IMethodSymbol method,
            IMethodSymbol invoke)
        {
            if (method.Parameters.Length != invoke.Parameters.Length
                || method.ReturnsVoid != invoke.ReturnsVoid)
            {
                return true;
            }

            for (int index = 0; index < method.Parameters.Length; index++)
            {
                IParameterSymbol methodParameter = method.Parameters[index];
                IParameterSymbol invokeParameter = invoke.Parameters[index];
                if (methodParameter.RefKind != invokeParameter.RefKind
                    || !SymbolEqualityComparer.Default.Equals(
                        methodParameter.Type,
                        invokeParameter.Type))
                {
                    return true;
                }
            }

            return !method.ReturnsVoid
                && !SymbolEqualityComparer.Default.Equals(
                    method.ReturnType,
                    invoke.ReturnType);
        }

        private GExpression TranslateExactMethodGroupArgument(
            ExpressionSyntax expression,
            IMethodSymbol method,
            IMethodSymbol invoke)
        {
            var parameters = new List<Parameter>(invoke.Parameters.Length);
            var arguments = new List<GExpression>(invoke.Parameters.Length + 1);
            GExpression target = null;
            IMethodSymbol original = method.ReducedFrom ?? method;
            if (original.IsExtensionMethod)
            {
                this.typeMapper.TrackExtensionMethodNamespace(original);
            }

            if (expression is MemberAccessExpressionSyntax extensionMember
                && original.IsExtensionMethod
                && this.context.GetSymbolInfo(extensionMember.Expression).Symbol
                    is not INamedTypeSymbol
                && (method.MethodKind == MethodKind.ReducedExtension
                    || original.Parameters.Length == invoke.Parameters.Length + 1))
            {
                // Target the emitted G# shape: migrated source extensions use
                // receiver syntax unless only a static helper survives.
                bool sourceDefined = !original.DeclaringSyntaxReferences.IsDefaultOrEmpty
                    || this.KnownCompilations().Any(compilation =>
                        SameAssembly(
                            compilation.Assembly,
                            original.ContainingAssembly));
                bool useStaticHelper = this.TryGetStaticExtensionHelper(
                    original,
                    out string helperOwner,
                    out string helperName)
                    || !sourceDefined;
                GExpression receiver;
                if (useStaticHelper)
                {
                    receiver = this.ForgiveNullableReferenceValue(
                        extensionMember.Expression,
                        this.TranslateExpression(extensionMember.Expression),
                        original.Parameters[0].Type,
                        original.Parameters[0],
                        includePromotedValue: true);
                    receiver = this.CaptureMethodGroupReceiver(
                        receiver,
                        extensionMember.Expression);
                    arguments.Add(PassStaticExtensionHelperReceiver(receiver, original));
                    target = new MemberAccessExpression(
                        helperOwner != null
                            ? new IdentifierExpression(helperOwner)
                            : this.StaticQualifierReceiver(
                                original.ContainingType,
                                expression.GetLocation()),
                        helperName ?? this.EmittedName(original, original.Name));
                }
                else
                {
                    GExpression translatedReceiver =
                        this.MemberBindsToNullableThisExtension(extensionMember)
                            ? this.TranslateExpression(extensionMember.Expression)
                            : this.TranslateReceiverWithNullForgiveness(
                                extensionMember.Expression);
                    receiver = this.CaptureMethodGroupReceiver(
                        translatedReceiver,
                        extensionMember.Expression);
                    target = new MemberAccessExpression(
                        receiver,
                        this.EmittedName(original, original.Name));
                }
            }

            for (int index = 0; index < invoke.Parameters.Length; index++)
            {
                IParameterSymbol invokeParameter = invoke.Parameters[index];
                Parameter mapped = this.MapParameter(
                    invokeParameter,
                    expression,
                    promoteNullability: false);
                string name = $"__arg{index}";
                parameters.Add(new Parameter(
                    name,
                    mapped.Type,
                    mapped.IsVariadic,
                    mapped.RefKind));

                GExpression forwarded = new IdentifierExpression(name);
                if (invokeParameter.RefKind is RefKind.Ref or RefKind.Out)
                {
                    forwarded = new UnaryExpression("&", forwarded);
                }

                arguments.Add(forwarded);
            }

            target ??= this.TranslateMethodGroupInvocationTarget(
                expression,
                method);
            IReadOnlyList<GTypeReference> typeArguments = method.IsGenericMethod
                ? method.TypeArguments
                    .Select(type => this.typeMapper.Map(
                        type,
                        this.context,
                        expression.GetLocation()))
                    .ToList()
                : null;
            var call = new InvocationExpression(target, arguments, typeArguments);
            GTypeReference returnType = this.MapDelegateLikeReturnType(
                invoke,
                isAsync: false,
                expression.GetLocation());
            var statements = returnType == null
                ? new GStatement[] { new ExpressionStatement(call) }
                : new GStatement[] { new ReturnStatement(call) };
            return new LambdaExpression(
                parameters,
                blockBody: new BlockStatement(statements),
                returnType: returnType,
                isFunctionLiteral: true);
        }

        private GExpression TranslateMethodGroupInvocationTarget(
            ExpressionSyntax expression,
            IMethodSymbol method)
        {
            if (method.IsStatic
                && method.MethodKind != MethodKind.LocalFunction
                && method.ContainingType is { IsImplicitlyDeclared: false } owner
                && !SymbolEqualityComparer.Default.Equals(
                    owner.OriginalDefinition,
                    this.entryType?.OriginalDefinition))
            {
                return new MemberAccessExpression(
                    this.StaticQualifierReceiver(owner, expression.GetLocation()),
                    this.EmittedName(method, method.Name));
            }

            if (expression is MemberAccessExpressionSyntax member
                && !method.IsStatic
                && !this.TryGetStaticExtensionHelper(method, out _, out _))
            {
                GExpression receiver = this.CaptureMethodGroupReceiver(
                    this.TranslateReceiverWithNullForgiveness(member.Expression),
                    member.Expression);
                return new MemberAccessExpression(
                    receiver,
                    this.EmittedName(method, member.Name.Identifier.ValueText));
            }

            return this.TranslateExpression(expression);
        }

        private bool IsXunitNullAssertionArgument(ArgumentSyntax argument)
        {
            if (argument.Parent?.Parent is not InvocationExpressionSyntax invocation)
            {
                return false;
            }

            return this.context.GetSymbolInfo(invocation).Symbol is IMethodSymbol
            {
                Name: "Null" or "NotNull",
                ContainingType.Name: "Assert",
                ContainingNamespace.Name: "Xunit",
            };
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
                TypeInfo literalInfo = this.context.GetTypeInfo(expression);
                if (TryGetNumericKind(literalInfo.Type, out SpecialType literalSource)
                    && TryGetNumericKind(literalInfo.ConvertedType, out SpecialType literalTarget)
                    && literalSource != literalTarget
                    && !this.TargetsConcreteNumericParameter(argument))
                {
                    return this.CoerceOperandTo(
                        translated,
                        literalInfo.ConvertedType,
                        expression.GetLocation());
                }

                return this.CoerceConstantToUnsigned(expression, translated);
            }

            TypeInfo info = this.context.GetTypeInfo(expression);
            if (TryGetNumericKind(info.Type, out SpecialType sourceUnderlying) &&
                TryGetNumericKind(info.ConvertedType, out SpecialType convertedUnderlying) &&
                sourceUnderlying != convertedUnderlying)
            {
                return this.CoerceOperandTo(
                    translated,
                    info.ConvertedType,
                    expression.GetLocation());
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
                Expression: IdentifierNameSyntax { Identifier.ValueText: "nameof" },
            };
        }

        private GExpression TranslateObjectCreation(ObjectCreationExpressionSyntax creation)
        {
            ITypeSymbol typeSymbol = this.context.GetTypeInfo(creation).Type;
            GTypeReference type = typeSymbol != null
                ? this.typeMapper.Map(typeSymbol, this.context, creation.GetLocation())
                : new NamedTypeReference(creation.Type.ToString());

            var arguments = this.TranslateCallArguments(
                creation,
                creation.ArgumentList?.Arguments ?? default);

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
                return UnwrapNamedArgument(arguments[0]);
            }

            return this.BuildObjectCreationCore(creation, typeSymbol, type, arguments, creation.Initializer);
        }

        private static ILocalSymbol GetReferencedLocal(IOperation operation)
        {
            while (operation is IConversionOperation conversion)
            {
                operation = conversion.Operand;
            }

            return (operation as ILocalReferenceOperation)?.Local;
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
            if (typeSymbol is INamedTypeSymbol { SpecialType: SpecialType.System_Object } systemObject)
            {
                type = new NamedTypeReference(
                    this.typeMapper.GetOrCreateImportedTypeAlias(
                        systemObject,
                        this.context,
                        creationNode.GetLocation()));
            }

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
                if (typeSymbol?.SpecialType == SpecialType.System_Object
                    && initializer.Expressions.Count == 0)
                {
                    return BuildConstruction(type, arguments);
                }

                // An object initializer `new T { Field = value, ... }` with NO
                // constructor argument list maps to the canonical G# struct
                // literal `T{Field: value, ...}` (spec §Struct literals; ADR-0115
                // §B.11).
                if (!hasCtorArgs
                    && (typeSymbol is ITypeParameterSymbol
                        || (typeSymbol is INamedTypeSymbol
                            && typeSymbol.SpecialType != SpecialType.System_Object
                            && this.InvokesParameterlessConstructor(creationNode))))
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
                return this.BuildConstructionWithInitializerSuffix(
                    initializer,
                    type,
                    this.MaterializeOmittedConstructorArguments(creationNode, arguments));
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

        private bool InvokesParameterlessConstructor(
            BaseObjectCreationExpressionSyntax creationNode)
        {
            return this.context.GetSymbolInfo(creationNode).Symbol
                is IMethodSymbol { Parameters.Length: 0 };
        }

        private IReadOnlyList<GExpression> MaterializeOmittedConstructorArguments(
            BaseObjectCreationExpressionSyntax creationNode,
            IReadOnlyList<GExpression> arguments)
        {
            if (arguments.Count != 0
                || this.context.GetSymbolInfo(creationNode).Symbol is not IMethodSymbol constructor
                || constructor.Parameters.Length == 0)
            {
                return arguments;
            }

            var materialized = new List<GExpression>(constructor.Parameters.Length);
            foreach (IParameterSymbol parameter in constructor.Parameters)
            {
                if (parameter.IsParams && parameter.Type is IArrayTypeSymbol paramsArray)
                {
                    materialized.Add(new ArrayLiteralExpression(
                        this.typeMapper.Map(
                            paramsArray.ElementType,
                            this.context,
                            creationNode.GetLocation())));
                    continue;
                }

                GTypeReference parameterType = this.typeMapper.Map(
                    parameter.Type,
                    this.context,
                    creationNode.GetLocation());
                GExpression defaultValue = this.BuildOptionalParameterDefault(
                    parameter,
                    parameterType,
                    creationNode);
                if (defaultValue == null)
                {
                    return arguments;
                }

                materialized.Add(this.CoerceMaterializedArgument(
                    defaultValue,
                    parameter.Type,
                    creationNode.GetLocation()));
            }

            return materialized;
        }

        private GExpression CoerceMaterializedArgument(
            GExpression value,
            ITypeSymbol parameterType,
            Location location)
        {
            if (!parameterType.IsReferenceType)
            {
                return this.CoerceOperandTo(value, parameterType, location);
            }

            GTypeReference mappedType = this.typeMapper.Map(
                parameterType,
                this.context,
                location);
            if (value is LiteralExpression { Kind: LiteralKind.Null }
                || value is IdentifierExpression { Name: "nil" })
            {
                return new DefaultValueExpression(mappedType);
            }

            if (parameterType.SpecialType == SpecialType.System_String
                && value is LiteralExpression { Kind: LiteralKind.String })
            {
                return value;
            }

            return new ConversionExpression(
                mappedType,
                value,
                isCheckedReferenceCast: true);
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

            // Issue #2766: plain structs now preserve source constructors as
            // callable G# init members. Keep the call itself instead of replaying
            // assignments into a literal; record structs retain their separate
            // data-struct lowering path (#2744).
            if (!valueType.IsRecord &&
                ctorSymbol.DeclaringSyntaxReferences.Length == 1 &&
                ctorSymbol.DeclaringSyntaxReferences[0].GetSyntax() is ConstructorDeclarationSyntax)
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

            IReadOnlyList<(int ParameterOrdinal, GExpression Value)> loweredArguments =
                this.NormalizeLoweredConstructorArguments(
                    creationNode,
                    ctorSymbol,
                    arguments);
            return this.TryInstantiateStructConstructorPlan(
                plan,
                loweredArguments,
                out fieldInitializers,
                out unsupportedReason);
        }

        private IReadOnlyList<(int ParameterOrdinal, GExpression Value)> NormalizeLoweredConstructorArguments(
            BaseObjectCreationExpressionSyntax creationNode,
            IMethodSymbol constructor,
            IReadOnlyList<GExpression> arguments)
        {
            SeparatedSyntaxList<ArgumentSyntax> syntaxArguments = creationNode switch
            {
                ObjectCreationExpressionSyntax explicitCreation =>
                    explicitCreation.ArgumentList?.Arguments ?? default,
                ImplicitObjectCreationExpressionSyntax implicitCreation =>
                    implicitCreation.ArgumentList?.Arguments ?? default,
                _ => default,
            };
            if (syntaxArguments.Count != arguments.Count ||
                constructor.Parameters.Length < arguments.Count)
            {
                return BuildPositionalLoweredArguments(arguments);
            }

            var lowered = new List<(int ParameterOrdinal, GExpression Value)>(
                constructor.Parameters.Length);
            var suppliedOrdinals = new HashSet<int>();
            for (var sourceIndex = 0; sourceIndex < syntaxArguments.Count; sourceIndex++)
            {
                if (this.context.SemanticModel.GetOperation(syntaxArguments[sourceIndex])
                    is not IArgumentOperation { Parameter: { } parameter })
                {
                    return BuildPositionalLoweredArguments(arguments);
                }

                lowered.Add((
                    parameter.Ordinal,
                    UnwrapNamedArgument(arguments[sourceIndex])));
                suppliedOrdinals.Add(parameter.Ordinal);
            }

            for (var ordinal = 0; ordinal < constructor.Parameters.Length; ordinal++)
            {
                if (suppliedOrdinals.Contains(ordinal))
                {
                    continue;
                }

                IParameterSymbol parameter = constructor.Parameters[ordinal];
                GTypeReference parameterType = this.typeMapper.Map(
                    parameter.Type,
                    this.context,
                    creationNode.GetLocation());
                GExpression defaultValue = this.BuildOptionalParameterDefault(
                    parameter,
                    parameterType,
                    creationNode);
                if (defaultValue == null)
                {
                    return BuildPositionalLoweredArguments(arguments);
                }

                lowered.Add((ordinal, defaultValue));
            }

            return lowered;
        }

        private static IReadOnlyList<(int ParameterOrdinal, GExpression Value)>
            BuildPositionalLoweredArguments(IReadOnlyList<GExpression> arguments)
        {
            var lowered = new List<(int ParameterOrdinal, GExpression Value)>(
                arguments.Count);
            for (var index = 0; index < arguments.Count; index++)
            {
                lowered.Add((index, UnwrapNamedArgument(arguments[index])));
            }

            return lowered;
        }

        private static GExpression UnwrapNamedArgument(GExpression argument) =>
            argument is NamedArgumentExpression named ? named.Value : argument;

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
                || IsNullOrSuppressedNull(valueExpression)
                || !this.TargetWillRemainNonNullableReference(
                    targetType,
                    targetSymbolForPromotionCheck))
            {
                return translatedValue;
            }

            return (this.NullableReferenceValueMayBeNull(valueExpression)
                    || (this.IsObliviousCompilation()
                        && this.IsNullablePromotedValue(valueExpression)))
                ? EnsureNonNullAssertion(translatedValue)
                : translatedValue;
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
        /// must spell a callable CLR type name instead — otherwise gsc reports
        /// GS0130 ("Function 'string' doesn't exist"). Most aliases use a
        /// qualified name; <c>object</c>/<c>string</c> use imported
        /// <c>Object</c>/<c>String</c> because namespace-qualified constructor
        /// expressions are not bindable.
        /// Non-keyword type names are returned unchanged.
        /// </summary>
        private static string ConstructionCalleeName(string typeName) => typeName switch
        {
            "object" => "Object",
            "string" => "String",
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
                                this.EmittedName(name, name.Identifier),
                                new CollectionInitializerExpression(target: null, memberElements)));
                            continue;
                        }
                    }

                    GExpression value = this.TranslateExpression(assignment.Right);
                    fieldInitializers.Add(new FieldInitializer(
                        this.EmittedName(name, name.Identifier),
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
                                this.EmittedName(name, name.Identifier),
                                new CollectionInitializerExpression(target: null, memberElements)));
                            continue;
                        }
                    }
                    else if (assignment.Right is InitializerExpressionSyntax nestedObjectInit &&
                        nestedObjectInit.IsKind(SyntaxKind.ObjectInitializerExpression))
                    {
                        List<CollectionInitializerElement> memberElements =
                            this.TranslateCollectionInitializerElements(nestedObjectInit);
                        if (memberElements != null)
                        {
                            memberInitializers.Add(new FieldInitializer(
                                this.EmittedName(name, name.Identifier),
                                new CollectionInitializerExpression(target: null, memberElements)));
                            continue;
                        }
                    }

                    memberInitializers.Add(new FieldInitializer(
                        this.EmittedName(name, name.Identifier),
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
                if (element is AssignmentExpressionSyntax { Left: IdentifierNameSyntax memberName } memberAssignment)
                {
                    elements.Add(new CollectionInitializerElement(
                        this.EmittedName(memberName, memberName.Identifier),
                        this.TranslateExpression(memberAssignment.Right)));
                }
                else if (element is AssignmentExpressionSyntax { Left: ImplicitElementAccessSyntax indexAccess } indexedAssignment)
                {
                    // `["k"] = v` → indexed element.
                    if (indexAccess.ArgumentList.Arguments.Count != 1)
                    {
                        this.context.ReportUnsupported(
                            element,
                            "multi-argument indexer initializer has no canonical G# collection-initializer form (ADR-0117).");
                        return null;
                    }

                    // The constructed property symbol carries the indexer's
                    // nullable substitution (`TValue` -> `object?`); type info
                    // for the implicit access can lose that annotation.
                    ISymbol indexerSymbol = this.context.GetSymbolInfo(indexAccess).Symbol;
                    ITypeSymbol indexerValueType =
                        (indexerSymbol as IPropertySymbol)?.Type
                        ?? this.context.GetTypeInfo(indexAccess).Type;
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
            IReadOnlyList<(int ParameterOrdinal, GExpression Value)> arguments,
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

            var byParameterOrdinal = plan.Initializations
                .Where(initialization => initialization.ParameterOrdinal != null)
                .ToDictionary(
                    initialization => initialization.ParameterOrdinal.Value);
            foreach ((int parameterOrdinal, GExpression argumentValue) in arguments)
            {
                if (!byParameterOrdinal.TryGetValue(
                        parameterOrdinal,
                        out StructMemberInitialization initialization))
                {
                    unsupportedReason =
                        "struct constructor argument could not be matched to its initialized member; " +
                        "a G# struct literal cannot be built safely (issue #2435).";
                    fieldInitializers = null;
                    return false;
                }

                fieldInitializers.Add(new FieldInitializer(
                    this.EmittedName(
                        plan.Constructor.ContainingType.GetMembers(initialization.MemberName).FirstOrDefault(),
                        initialization.MemberName),
                    argumentValue));
            }

            foreach (StructMemberInitialization initialization in plan.Initializations)
            {
                if (initialization.ParameterOrdinal != null ||
                    plan.FixedInitializersAreDeclaredOnType)
                {
                    continue;
                }

                ExpressionSyntax fixedExpression = initialization.FixedExpression;
                if (!this.context.Compilation.ContainsSyntaxTree(fixedExpression.SyntaxTree))
                {
                    unsupportedReason = "a source struct constructor in another compilation contains a fixed initializer " +
                        "expression; that expression cannot yet be rebound safely at this call site (issue #2435).";
                    fieldInitializers = null;
                    return false;
                }

                using IDisposable modelScope = this.context.UseSemanticModelFor(fixedExpression.SyntaxTree);
                GExpression value = this.TranslateExpression(fixedExpression);
                fieldInitializers.Add(new FieldInitializer(
                    this.EmittedName(
                        plan.Constructor.ContainingType.GetMembers(initialization.MemberName).FirstOrDefault(),
                        initialization.MemberName),
                    value));
            }

            unsupportedReason = null;
            return true;
        }

        private GExpression TranslateCast(CastExpressionSyntax cast)
        {
            // C# explicit casts map to G# explicit conversions (ADR-0115 §B.17
            // and ADR-0167). Numeric/value conversions retain `T(expr)`.
            // Reference casts use constructor-independent `cast[T](expr)` so a
            // target class's applicable one-argument constructor cannot change
            // cast semantics.
            ITypeSymbol targetSymbol = this.context.GetTypeInfo(cast.Type).Type;

            ITypeSymbol sourceSymbol = this.context.GetTypeInfo(cast.Expression).Type;

            GTypeReference targetType = targetSymbol != null
                ? this.typeMapper.Map(targetSymbol, this.context, cast.Type.GetLocation())
                : new NamedTypeReference(cast.Type.ToString());
            if (targetSymbol is INamedTypeSymbol { TypeKind: TypeKind.Delegate } delegateTarget)
            {
                targetType = this.typeMapper.MapNominalDelegate(
                    delegateTarget,
                    this.context,
                    cast.Type.GetLocation());
            }

            if (cast.Expression.IsKind(SyntaxKind.NullLiteralExpression)
                && (targetSymbol is { IsReferenceType: true } || targetType.IsNullable))
            {
                // Typed null keeps overload selection without an unparseable
                // conversion such as `[]char(nil)` or `Guid?(nil)`.
                GTypeReference defaultType = cast.Type is NullableTypeSyntax && !targetType.IsNullable
                    ? MakeNullable(targetType)
                    : targetType;
                return new DefaultValueExpression(defaultType);
            }

            GExpression operand = this.TranslateExpression(cast.Expression);

            Microsoft.CodeAnalysis.CSharp.Conversion conversion =
                sourceSymbol == null || targetSymbol == null
                    ? default
                    : this.context.Compilation.ClassifyConversion(sourceSymbol, targetSymbol);
            if (cast.Type is not NullableTypeSyntax
                && this.CastUsesCheckedReferenceConversion(cast)
                && this.IsFlowNarrowedAnnotatedReference(cast.Expression))
            {
                operand = EnsureNonNullAssertion(operand);
            }

            if (conversion.IsBoxing)
            {
                GTypeReference boxingTargetType = cast.Type is NullableTypeSyntax
                    && !targetType.IsNullable
                        ? MakeNullable(targetType)
                        : targetType;
                bool useUnambiguousCast =
                    targetSymbol is not { SpecialType: SpecialType.System_Object };
                return new ConversionExpression(
                    boxingTargetType,
                    operand,
                    useUnambiguousCast);
            }

            // Preserve explicit class/interface-to-object casts when they
            // supply a surrounding expression's common type, such as
            // `(object?)text ?? DBNull.Value`. Dropping the upcast leaves
            // incompatible operands in G# even though the C# expression is
            // object-typed. G# accepts the canonical `object(expr)` /
            // `object?(expr)` conversion form for these upcasts.
            if (targetSymbol is { SpecialType: SpecialType.System_Object }
                && sourceSymbol is { IsReferenceType: true })
            {
                GTypeReference objectTargetType = cast.Type is NullableTypeSyntax
                    && !targetType.IsNullable
                        ? MakeNullable(targetType)
                        : targetType;
                return new ConversionExpression(objectTargetType, operand);
            }

            GTypeReference conversionTargetType = cast.Type is NullableTypeSyntax
                && !targetType.IsNullable
                    ? MakeNullable(targetType)
                    : targetType;
            return new ConversionExpression(
                conversionTargetType,
                operand,
                this.CastUsesCheckedReferenceConversion(cast));
        }

        private bool CastUsesCheckedReferenceConversion(CastExpressionSyntax cast)
        {
            ITypeSymbol target = this.context.GetTypeInfo(cast.Type).Type;
            ITypeSymbol source = this.context.GetTypeInfo(cast.Expression).Type;
            Microsoft.CodeAnalysis.CSharp.Conversion conversion =
                source == null || target == null
                    ? default
                    : this.context.Compilation.ClassifyConversion(source, target);
            return conversion.IsReference
                || (conversion.IsIdentity
                    && source is { IsReferenceType: true }
                    && target is { IsReferenceType: true })
                || (conversion.IsExplicit
                    && source is ITypeParameterSymbol
                    && target is { TypeKind: TypeKind.Interface })
                || (source is { TypeKind: TypeKind.Dynamic }
                    && target is { IsReferenceType: true });
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
                        this.EmittedName(name, name.Identifier),
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
