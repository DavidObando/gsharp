// <copyright file="CSharpToGSharpTranslator.Invocations.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Microsoft.CodeAnalysis.Operations
import Microsoft.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis.Syntax
import System.Text.RegularExpressions
import System.Threading

partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        private func TranslateInvocation(invocation InvocationExpressionSyntax) GExpression? {
            if this.RequiresFunctionArgumentSpillSeam(invocation) {
                for argument in invocation.ArgumentList.Arguments {
                    if argument.Expression is DeclarationExpressionSyntax{
                        Designation: SingleVariableDesignationSyntax designation
                    } &&
                        this
                        .context
                        .GetDeclaredSymbol(designation) is ILocalSymbol local {
                        (this.state.FunctionArgumentOutDeclarations ?? this.state.PendingSpillPrologue)?.Add(
                            LocalDeclarationStatement(
                                BindingKind.Var,
                                this.EmittedName(local, local.Name),
                                this.typeMapper.Map(local.Type, this.context, argument.GetLocation())
                            )
                        )
                    }
                }
                // Keep reordered operands at the call's evaluation point, not
                // ahead of a sibling expression, loop condition or null guard.
                let translated = this.TranslateWithLocalAssignmentSeam(
                    invocation,
                    () -> this.TranslateInvocationCore(invocation, snapshotDelegateTarget: true)!!
                )
                if translated is BlockExpression block &&
                    this.entryType != nil &&
                    SymbolEqualityComparer
                    .Default
                    .Equals(
                    this.context.SemanticModel.GetEnclosingSymbol(invocation.SpanStart),
                    this.context.Compilation.GetEntryPoint(default(CancellationToken))
                ) &&
                    block
                    .Statements
                    .OfType[LocalDeclarationStatement]()
                    .Any((s LocalDeclarationStatement) -> s.IsRefAlias) {
                    // G# top-level locals are static fields, even in a block
                    // expression. A managed reference needs a stack frame.
                    let statements = block.Statements.ToList()
                    let returnsVoid = this.context.GetTypeInfo(invocation).Type?.SpecialType == SpecialType.System_Void
                    statements.Add(
                        if returnsVoid {
                            cast[GStatement](ExpressionStatement(block.Value))
                        } else {
                            cast[GStatement](ReturnStatement(block.Value))
                        }
                    )
                    return InvocationExpression(
                        ParenthesizedExpression(
                            LambdaExpression(Array.Empty[Parameter](), blockBody: BlockStatement(statements))
                        ),
                        Array.Empty[GExpression]()
                    )
                }
                return translated
            }
            return this.TranslateInvocationCore(invocation)
        }

        private func TranslateInvocationCore(
            invocation InvocationExpressionSyntax,
            snapshotDelegateTarget bool = false
        ) GExpression? {
            if (invocation.Expression is IdentifierNameSyntax and {Identifier: {ValueText: "nameof"}}) &&
                this
                .context
                .SemanticModel
                .GetConstantValue(invocation) is {HasValue: true, Value: string name} {
                return LiteralExpression.String(name)
            }
            this.TryGetManagedReferenceArrayProjectedMethod(invocation, out _)
            var target GExpression?
            var typeArguments IReadOnlyList[GTypeReference]? = nil
            // Issue #2351: an extension-method call site (reduced instance
            // form, unreduced static form, or a bare sibling static call)
            // names no type, so it never flows through
            // CSharpTypeMapper.TrackShortenedNamespace (issue #2211's
            // type-import tracking). Track its declaring namespace here so an
            // import is still synthesized when the file relies on an
            // implicit/global `using` for it (e.g. `<ImplicitUsings>enable`
            // supplying `System.Linq`).
            if this
                .context
                .GetSymbolInfo(invocation)
                .Symbol is IMethodSymbol{IsExtensionMethod: true} invocationExtMethod {
                this.typeMapper.TrackExtensionMethodNamespace(invocationExtMethod)
            }
            // ADR-0169 analyzer mode: Roslyn methods whose G# counterpart is
            // not a same-shaped method (e.g. GetLocation() -> .Location).
            if this.InAnalyzerApiMode && this.TryTranslateAnalyzerInvocation(invocation, out var analyzerIdiom) {
                return analyzerIdiom
            }
            // ADR-0169 analyzer mode: the C# switch-section/label walk has no
            // direct G# counterpart (#3536).
            if this.InAnalyzerApiMode && this.TryTranslateAnalyzerSwitchLabelWalk(
                invocation,
                out var analyzerSwitchWalk
            ) {
                return analyzerSwitchWalk
            }
            if this
                .context
                .GetSymbolInfo(invocation)
                .Symbol is IMethodSymbol recursiveLocal &&
                recursiveLocal.MethodKind == MethodKind.LocalFunction &&
                this
                .state
                .LiftedRecursiveLocalFunctions
                .TryGetValue(recursiveLocal.OriginalDefinition, out var recursiveLift) {
                let recursiveArguments = this.TranslateCallArguments(invocation, invocation.ArgumentList.Arguments)
                    .ToList()
                for var i = recursiveArguments.Count; i < recursiveLocal.Parameters.Length; i++ {
                    let parameter = recursiveLocal.Parameters[i]
                    let parameterType GTypeReference? = this.typeMapper.Map(
                        parameter.Type,
                        this.context,
                        parameter.Locations.FirstOrDefault()
                    )
                    recursiveArguments.Add(
                        (
                            this.BuildOptionalParameterDefault(parameter, parameterType, invocation) ??
                                LiteralExpression.Null()
                        )
                    )
                }
                for capture in recursiveLift.Captures {
                    let captureArgument GExpression = IdentifierExpression(
                        this.EmittedName(capture.Symbol, capture.Symbol.Name)
                    )
                    recursiveArguments.Add(
                        if capture.IsByRef {
                            cast[GExpression](UnaryExpression("&", captureArgument))
                        } else {
                            captureArgument
                        }
                    )
                }
                let recursiveOwner INamedTypeSymbol? = this
                    .state
                    .CurrentEmittedAggregate ??
                    recursiveLocal.ContainingType
                let recursiveTarget = this.LiftedLocalFunctionReference(
                    recursiveOwner,
                    recursiveLift.Name,
                    recursiveLift.IsStatic,
                    invocation
                )
                let recursiveTypeArguments IReadOnlyList[
                    GTypeReference
                ]? = if invocation.Expression is GenericNameSyntax recursiveGeneric {
                    this.MapTypeArguments(recursiveGeneric)
                } else {
                    default(IReadOnlyList[GTypeReference]?)
                }
                return InvocationExpression(recursiveTarget, recursiveArguments, recursiveTypeArguments)
            }
            if this
                .context
                .GetSymbolInfo(invocation)
                .Symbol is IMethodSymbol enumTryParse &&
                enumTryParse
                .ContainingType
                .SpecialType == SpecialType.System_Enum &&
                enumTryParse.Name == "TryParse" &&
                enumTryParse.IsGenericMethod &&
                invocation.Expression is MemberAccessExpressionSyntax enumMember {
                target = MemberAccessExpression(this.TranslateExpression(enumMember.Expression), "TryParse")
                typeArguments = enumTryParse
                    .TypeArguments
                    .Select((type ITypeSymbol) -> this.typeMapper.Map(type, this.context, invocation.GetLocation())!!)
                    .ToList()
                return InvocationExpression(
                    target,
                    this.TranslateCallArguments(invocation, invocation.ArgumentList.Arguments),
                    typeArguments
                )
            }
            // C# delegate/event invocation `d.Invoke(args)` / `d?.Invoke(args)` maps
            // to G#'s direct function-call form `d(args)` / `d?(args)`: G# invokes a
            // function-typed value (delegate field or event) directly and has no
            // `.Invoke` member (`.Invoke` would be GS0159). Detected via the
            // delegate's synthesized `Invoke` method (MethodKind.DelegateInvoke).
            if this
                .context
                .GetSymbolInfo(invocation)
                .Symbol is IMethodSymbol delegateInvoke &&
                delegateInvoke.MethodKind == MethodKind.DelegateInvoke &&
                TryGetDelegateInvokeReceiver(invocation.Expression, out var invokeTarget) {
                if snapshotDelegateTarget && !(invocation.Expression is MemberBindingExpressionSyntax) {
                    invokeTarget = this.SnapshotReorderedDelegateTarget(invokeTarget, invocation)
                }
                let invokeArguments = this.TranslateCallArguments(invocation, invocation.ArgumentList.Arguments)
                return InvocationExpression(invokeTarget, invokeArguments, nil)
            }
            // Extensions emitted as static helpers — by-ref receivers, exact owned
            // signature collisions, or issue #3413 private-nested owners — use
            // positional static-helper calls.
            if invocation.Expression is MemberAccessExpressionSyntax extMember &&
                this
                .context
                .GetSymbolInfo(invocation)
                .Symbol is IMethodSymbol extMethod &&
                extMethod.MethodKind == MethodKind.ReducedExtension &&
                this
                .TryGetStaticExtensionHelper(extMethod, out var extOwner, out var extName) {
                let extArgs = List[GExpression]{
                    PassStaticExtensionHelperReceiver(
                        this.TranslateReceiverWithNullForgiveness(extMember.Expression),
                        extMethod
                    )!!
                }
                extArgs.AddRange(this.TranslateArguments(invocation.ArgumentList.Arguments))
                let extTypeArgs IReadOnlyList[GTypeReference]? = if extMember.Name is GenericNameSyntax extGeneric {
                    this.MapTypeArguments(extGeneric)
                } else {
                    default(IReadOnlyList[GTypeReference]?)
                }
                return InvocationExpression(
                    MemberAccessExpression(IdentifierExpression(extOwner), extName),
                    extArgs,
                    extTypeArgs
                )
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
            if invocation.Expression is MemberAccessExpressionSyntax staticExtMember &&
                (staticExtMember.Expression is TypeSyntax or IdentifierNameSyntax or MemberAccessExpressionSyntax) &&
                this
                .context
                .SemanticModel
                .GetOperation(invocation) is IInvocationOperation staticExtOperation &&
                staticExtOperation.TargetMethod is IMethodSymbol staticExt &&
                staticExt.IsExtensionMethod &&
                staticExt.MethodKind != MethodKind.ReducedExtension &&
                staticExt
                .Parameters
                .Length >= 1 &&
                !(staticExt.ReducedFrom ?? staticExt)
                .DeclaringSyntaxReferences
                .IsDefaultOrEmpty &&
                !this.IsStaticExtensionHelper(staticExt) &&
                this
                .context
                .SemanticModel
                .GetSymbolInfo(staticExtMember.Expression)
                .Symbol is INamedTypeSymbol &&
                TryGetExplicitExtensionReceiverArgument(
                staticExtOperation,
                staticExt,
                out var staticExtReceiverArgument
            ) {
                let staticExtReceiver GExpression? = this.TranslateStaticExtensionReceiver(staticExtReceiverArgument)
                let staticExtRest = this.TranslateStaticExtensionTrailingArguments(
                    invocation,
                    cast[ArgumentSyntax](staticExtReceiverArgument!!.Syntax)
                )
                let staticExtTypeArgs IReadOnlyList[
                    GTypeReference
                ]? = if staticExtMember.Name is GenericNameSyntax staticExtGeneric {
                    this.MapTypeArguments(staticExtGeneric)
                } else {
                    default(IReadOnlyList[GTypeReference]?)
                }
                return InvocationExpression(
                    MemberAccessExpression(
                        staticExtReceiver,
                        this.EmittedName(staticExt.ReducedFrom ?? staticExt, (staticExt.ReducedFrom ?? staticExt).Name)
                    ),
                    staticExtRest,
                    staticExtTypeArgs
                )
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
            if invocation.Expression is SimpleNameSyntax bareExtName &&
                (bareExtName is IdentifierNameSyntax || bareExtName is GenericNameSyntax) &&
                this
                .context
                .SemanticModel
                .GetOperation(invocation) is IInvocationOperation bareExtOperation &&
                bareExtOperation.TargetMethod is IMethodSymbol bareExt &&
                bareExt.IsExtensionMethod &&
                bareExt.MethodKind != MethodKind.ReducedExtension &&
                bareExt
                .Parameters
                .Length >= 1 &&
                !(bareExt.ReducedFrom ?? bareExt)
                .DeclaringSyntaxReferences
                .IsDefaultOrEmpty &&
                !this.IsStaticExtensionHelper(bareExt) &&
                TryGetExplicitExtensionReceiverArgument(bareExtOperation, bareExt, out var bareExtReceiverArgument) {
                let bareExtReceiver GExpression? = this.TranslateStaticExtensionReceiver(bareExtReceiverArgument)
                let bareExtRest = this.TranslateStaticExtensionTrailingArguments(
                    invocation,
                    cast[ArgumentSyntax](bareExtReceiverArgument!!.Syntax)
                )
                let bareExtTypeArgs IReadOnlyList[
                    GTypeReference
                ]? = if bareExtName is GenericNameSyntax bareExtGeneric {
                    this.MapTypeArguments(bareExtGeneric)
                } else {
                    default(IReadOnlyList[GTypeReference]?)
                }
                return InvocationExpression(
                    MemberAccessExpression(
                        bareExtReceiver,
                        this.EmittedName(bareExt.ReducedFrom ?? bareExt, (bareExt.ReducedFrom ?? bareExt).Name)
                    ),
                    bareExtRest,
                    bareExtTypeArgs
                )
            }
            // A generic call `Foo<T>(...)` carries its type arguments on the name;
            // lift them onto the G# bracket-type-argument form `Foo[T](...)`.
            if this
                .context
                .GetSymbolInfo(invocation)
                .Symbol is IMethodSymbol localFunction &&
                localFunction.MethodKind == MethodKind.LocalFunction &&
                this
                .state
                .LiftedStaticLocalFunctions
                .TryGetValue(localFunction.OriginalDefinition, out var liftedName) &&
                localFunction.ContainingType is {} containingType {
                let emittedOwner = this.state.CurrentEmittedAggregate ?? containingType
                target = this.LiftedLocalFunctionReference(emittedOwner, liftedName, isStatic: true, invocation)
                if invocation.Expression is GenericNameSyntax liftedGeneric {
                    typeArguments = this.MapTypeArguments(liftedGeneric)
                }
            } else if this
                .context
                .GetSymbolInfo(invocation)
                .Symbol is IMethodSymbol groupMember &&
                groupMember.MethodKind == MethodKind.LocalFunction &&
                this
                .state
                .RecursiveLocalFunctionGroups
                .TryGetValue(groupMember, out var recursiveGroup) &&
                recursiveGroup
                .Members
                .Contains(groupMember, SymbolEqualityComparer.Default) {
                // Issue #3399: a call to a recursive SCC partner from inside a
                // closure body — the partner is a nullable function-typed local,
                // so pass it through a postfix null assertion (`X!!`, ADR-0069)
                // that unwraps the declared local's `nil` default.
                target = NonNullAssertionExpression(IdentifierExpression(recursiveGroup.NameOf(groupMember)))
            } else if invocation.Expression is GenericNameSyntax generic {
                let genericSymbol ISymbol? = this.context.GetSymbolInfo(invocation).Symbol
                // A `using static` generic call whose name a file-scope type
                // claims (`List[string](x)` beside `import
                // System.Collections.Generic`) would bind as that type in gsc,
                // so it keeps its owner qualifier, as the non-generic branch
                // below does. That includes a `using static` INTERFACE owner:
                // C# imports its concrete static methods, and G# spells them
                // as `shared` interface members.
                if genericSymbol is IMethodSymbol genericMethod &&
                    genericMethod.IsStatic &&
                    genericMethod.ContainingType is INamedTypeSymbol genericOwner &&
                    (
                    genericOwner.TypeKind == TypeKind.Class ||
                        genericOwner.TypeKind == TypeKind.Struct ||
                        (genericOwner.TypeKind == TypeKind.Interface && this.IsStaticUsingTarget(genericOwner))
                ) &&
                    (
                    RequiresQualifiedImportedContextualCall(genericMethod, includeGenericPrefix: true) ||
                        (
                        this.IsStaticUsingTarget(genericOwner) && this.typeMapper.ClaimsDocumentScopeName(
                            this.EmittedName(genericMethod, generic.Identifier.ValueText),
                            this.context
                        )
                    )
                ) {
                    target = MemberAccessExpression(
                        this.StaticQualifierReceiver(genericOwner, generic.GetLocation()),
                        this.EmittedName(genericMethod, generic.Identifier.ValueText)
                    )
                } else {
                    target = IdentifierExpression(this.EmittedName(genericSymbol, generic.Identifier.ValueText))
                }
                typeArguments = this.MapTypeArguments(generic)
            } else if invocation.Expression is MemberAccessExpressionSyntax member &&
                member.Name is GenericNameSyntax memberGeneric {
                // Issue #4287: a generic method call dereferences its receiver
                // exactly as a non-generic one does, so it takes the same
                // receiver forgiveness the ordinary member-access path applies
                // (TranslateMemberAccess), with the same exemption for an
                // extension whose `this` parameter is itself nilable. It used to
                // translate bare, which gsc accepted only because it did not
                // check calls on a `T?` receiver: `expression.FirstAncestorOrSelf[T]()`
                // on a promoted `ExpressionSyntax?` parameter.
                target = MemberAccessExpression(
                    if this.MemberBindsToNullableThisExtension(member) {
                        this.TranslateExpression(member.Expression)
                    } else {
                        this.TranslateReceiverWithNullForgiveness(member.Expression)
                    },
                    this.EmittedName(this.context.GetSymbolInfo(invocation).Symbol, memberGeneric.Identifier.ValueText)
                )
                typeArguments = this.MapTypeArguments(memberGeneric)
            } else if invocation.Expression is MemberBindingExpressionSyntax memberBinding &&
                memberBinding.Name is GenericNameSyntax memberBindingGeneric {
                // A generic call chained after a null-conditional `?.`
                // (`x?.GetChild<HdlrBox>()`) reaches here as a member-binding
                // whose name carries the type arguments. Preserve them on the
                // bracket-type-argument form so the chained call keeps `[T...]`.
                target = MemberAccessExpression(
                    ConditionalReceiverExpression(),
                    this.EmittedName(
                        this.context.GetSymbolInfo(invocation).Symbol,
                        memberBindingGeneric.Identifier.ValueText
                    )
                )
                typeArguments = this.MapTypeArguments(memberBindingGeneric)
            } else if invocation.Expression is IdentifierNameSyntax bareName &&
                this
                .context
                .GetSymbolInfo(bareName)
                .Symbol is IMethodSymbol staticMethod &&
                staticMethod.IsStatic &&
                staticMethod.MethodKind != MethodKind.LocalFunction &&
                staticMethod.ContainingType is INamedTypeSymbol owner &&
                (
                owner.TypeKind == TypeKind.Class ||
                    owner.TypeKind == TypeKind.Struct ||
                    (owner.TypeKind == TypeKind.Interface && this.IsStaticUsingTarget(owner))
            ) &&
                !owner.IsImplicitlyDeclared &&
                (
                !this.IsStaticUsingTarget(owner) ||
                    RequiresQualifiedImportedContextualCall(staticMethod) ||
                    this
                    .typeMapper
                    .ClaimsDocumentScopeName(this.EmittedName(staticMethod, staticMethod.Name), this.context)
            ) &&
                !SymbolEqualityComparer
                .Default
                .Equals(owner.OriginalDefinition, this.entryType?.OriginalDefinition) && !this.IsBareSiblingStaticScope(
                owner,
                this.EmittedName(staticMethod, staticMethod.Name),
                bareName
            ) {
                // A C# bare sibling static call (`Round(value, 2)`) carries an
                // implicit type qualifier only where the emitted body leaves the
                // owner's type scope (issue #3471) — e.g. a lifted extension
                // `func` at file scope — and must then be qualified through the
                // owning type (`Geometry.Round(value, 2)`); see ADR-0115 §B.18.
                // A bare call to a `using static` member is the exception
                // (ADR-0134): gsc brings it into scope through `import Owner`,
                // so it is left unqualified above — UNLESS its name is also
                // claimed at file scope by an imported or source type (or an
                // alias). gsc resolves that name to the type first, so a bare
                // `Project(src)` beside `import Microsoft.CodeAnalysis` binds as
                // a conversion to `Microsoft.CodeAnalysis.Project` (GS0155),
                // where C# chose the `using static` method. Such a call keeps
                // its owner qualifier (`StubTestSupport.Project(src)`), exactly
                // as a colliding sibling static does (issue #3471).
                // Issue #1886: a `static` LOCAL function is NOT a sibling type
                // member — Roslyn still reports its enclosing TYPE as
                // `ContainingType`, but cs2gs already lowers it to a local `let`
                // binding (see TranslateLocalFunction), so its call must stay a
                // bare identifier call, never `Owner.Name(...)`. Excluded above
                // via `MethodKind: not MethodKind.LocalFunction`.
                target = MemberAccessExpression(
                    this.StaticQualifierReceiver(owner, bareName.GetLocation()),
                    this.EmittedName(staticMethod, staticMethod.Name)
                )
            } else {
                target = this.TranslateExpression(invocation.Expression)
            }
            // Directly invoking a nullable delegate value needs the same receiver
            // forgiveness as `.Invoke(...)`: fields/properties retain #1594's
            // behavior, while issue #2506 adds promoted method/property/indexer
            // results such as `FindFactory()()`. Keep the decision receiver-only
            // so callable-return taint is asserted on the produced delegate value,
            // never on a method group.
            if this
                .context
                .GetSymbolInfo(invocation)
                .Symbol is IMethodSymbol invokedMethod &&
                invokedMethod.MethodKind == MethodKind.DelegateInvoke &&
                !this.PlatformTypedImportNeedsNoBridge(invocation.Expression) &&
                (
                this.ReceiverNeedsNullForgiveness(invocation.Expression, isDereferenceReceiver: true) ||
                    this.ReceiverIsNullableReferenceFieldOrProperty(invocation.Expression) ||
                    this.ImportedGenericTupleElementRequiresAssertion(invocation.Expression)
            ) &&
                !this.IsWithinExpressionTreeLambda(invocation.Expression) {
                target = NonNullAssertionExpression(target)
            }
            if snapshotDelegateTarget &&
                this
                .context
                .GetSymbolInfo(invocation)
                .Symbol is IMethodSymbol snapshotMethod &&
                snapshotMethod.MethodKind == MethodKind.DelegateInvoke {
                target = this.SnapshotReorderedDelegateTarget(target, invocation)
            }
            let arguments = this.TranslateCallArguments(invocation, invocation.ArgumentList.Arguments)
            // Issue #3501 (GS0155): C# inferred a generic overload whose type
            // arguments include a same-compilation user type (e.g.
            // `builder.AddRange(fields)` selecting `AddRange<TDerived>` with
            // `TDerived = FieldSymbol`). gsc's erased inference collapses the
            // user type to `object`, letting an invariant same-name sibling win
            // and fail conversion — spell the type arguments explicitly so the
            // C#-chosen overload binds.
            if (typeArguments == nil || typeArguments.Count == 0) &&
                this
                .context
                .GetSymbolInfo(invocation)
                .Symbol is IMethodSymbol inferredGeneric &&
                inferredGeneric.IsGenericMethod &&
                (
                inferredGeneric.MethodKind == MethodKind.Ordinary ||
                    inferredGeneric.MethodKind == MethodKind.ReducedExtension
            ) &&
                !inferredGeneric
                .TypeArguments
                .IsDefaultOrEmpty &&
                inferredGeneric
                .TypeArguments
                .All((t ITypeSymbol) -> t.TypeKind != TypeKind.Error) && inferredGeneric.TypeArguments.Any(
                (t ITypeSymbol) -> !t
                    .DeclaringSyntaxReferences
                    .IsDefaultOrEmpty &&
                    (t.TypeKind == TypeKind.Class || t.TypeKind == TypeKind.Struct || t.TypeKind == TypeKind.Interface)
            ) &&
                HasErasureCollidingNonGenericSibling(inferredGeneric) {
                typeArguments = inferredGeneric
                    .TypeArguments
                    .Select((t ITypeSymbol) -> this.typeMapper.Map(t, this.context, invocation.GetLocation())!!)
                    .ToList()
            }
            return InvocationExpression(target, arguments, typeArguments)
        }

        private func TranslateStaticExtensionReceiver(receiverArgument IArgumentOperation?) GExpression? {
            let expression = (cast[ArgumentSyntax](receiverArgument!!.Syntax)).Expression
            var translated GExpression? = this.TranslateExpression(expression)
            translated = this.ForgiveNullableReferenceValue(
                expression,
                translated,
                receiverArgument!!.Parameter?.Type,
                receiverArgument!!.Parameter,
                includePromotedValue: true
            )
            var value IOperation? = receiverArgument!!.Value
            while value is IConversionOperation{IsImplicit: true} implicitConversion {
                value = implicitConversion.Operand
            }
            if value is IConditionalAccessOperation ||
                value is ICoalesceOperation ||
                value is IConditionalOperation ||
                value is IAwaitOperation ||
                value is IConversionOperation &&
                value.IsImplicit == false {
                return if translated is ParenthesizedExpression {
                    translated
                } else {
                    cast[GExpression](ParenthesizedExpression(translated))
                }
            }
            return ParenthesizeIfBareNumericLiteral(translated)
        }

        private func TranslateStaticExtensionTrailingArguments(
            invocation InvocationExpressionSyntax,
            receiverArgument ArgumentSyntax
        ) List[GExpression] {
            let translated = this.TranslateCallArguments(invocation, invocation.ArgumentList.Arguments)
            let receiverIndex = invocation.ArgumentList.Arguments.IndexOf(receiverArgument)
            if receiverIndex >= 0 && receiverIndex < translated.Count {
                translated.RemoveAt(receiverIndex)
            }
            return translated
        }

        // Resolves the receiver of a delegate/event `.Invoke(...)` call to the value
        // that G# invokes directly. `d.Invoke(...)` → `d`; the null-conditional
        // `d?.Invoke(...)` form reaches here as a member-binding whose receiver is the
        // conditional-receiver placeholder (so the enclosing `?.` renders `d?(...)`).
        private func TryGetDelegateInvokeReceiver(
            callee Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            out receiver GExpression?
        ) bool {
            switch callee {
                case member is MemberAccessExpressionSyntax when member.Name.Identifier.ValueText == "Invoke" {
                    // A nullable delegate/event receiver spelled `field.Invoke(...)`
                    // needs the same `!!` the direct-call spelling `field(...)` gets
                    // below (#1598): route through the shared receiver-forgiveness
                    // helper rather than a bare translate, or the `.Invoke` spelling
                    // bypasses the assertion and emits an unforgiven `field(...)`
                    // (GS0131).
                    receiver = this.TranslateReceiverWithNullForgiveness(member.Expression)
                    return true
                }
                case binding is MemberBindingExpressionSyntax when binding.Name.Identifier.ValueText == "Invoke" {
                    receiver = this.state.ConditionalReceiverReplacement ?? ConditionalReceiverExpression()
                    return true
                }
                default {
                    receiver = nil
                    return false
                }
            }
        }

        /// Rewrites a null-conditional call to a static-helper extension method
        /// into the
        /// ternary
        /// `if recv != nil { Owner.M(recv!!, args) } else { default(R?) }`.
        /// The `?.` member-binding form cannot bind to a static helper.
        private func TryTranslateNullConditionalStaticExtensionHelper(
            conditionalAccess ConditionalAccessExpressionSyntax,
            out result GExpression?
        ) bool {
            result = nil
            if !this.TryMatchNullConditionalStaticExtensionHelper(
                conditionalAccess,
                out var invocation,
                out var method,
                out var owner,
                out var name,
                out var helperName,
                out var chainedReceiver
            ) {
                return false
            }
            if DependsOnEnclosingConditionalReceiver(conditionalAccess.Expression) {
                this.ReportUnsupportedNestedConditionalStaticHelperChain(conditionalAccess)
                result = this.PreserveNullConditionalStaticExtensionInvocation(
                    conditionalAccess,
                    invocation,
                    helperName
                )
                return true
            }
            if method!!.ReturnsVoid {
                return false
            }
            if chainedReceiver != nil && !IsSupportedConditionalStaticHelperReceiver(chainedReceiver) {
                this.ReportUnsupportedConditionalStaticHelperChain(conditionalAccess)
                result = this.PreserveNullConditionalStaticExtensionInvocation(
                    conditionalAccess,
                    invocation,
                    helperName
                )
                return true
            }
            if this.context.GetTypeInfo(conditionalAccess).Type is not{} conditionalType {
                return false
            }
            this.BuildNullConditionalStaticExtensionHelper(
                conditionalAccess,
                invocation,
                owner,
                name,
                helperName,
                chainedReceiver,
                out var guard_,
                out var call,
                hostLocalAssignmentSeam: true
            )
            var nullableType GTypeReference? = this.typeMapper.Map(
                conditionalType,
                this.context,
                conditionalAccess.GetLocation()
            )
            if !nullableType!!.IsNullable {
                nullableType = MakeNullable(nullableType)
            }
            result = ParenthesizedExpression(IfExpression(guard_, call, DefaultValueExpression(nullableType)))
            return true
        }

        private func TryTranslateNullConditionalStaticExtensionHelperStatement(
            conditionalAccess ConditionalAccessExpressionSyntax,
            out result GStatement?
        ) bool {
            result = nil
            if !this.TryMatchNullConditionalStaticExtensionHelper(
                conditionalAccess,
                out var invocation,
                out var method,
                out var owner,
                out var name,
                out var helperName,
                out var chainedReceiver
            ) ||
                !method!!.ReturnsVoid {
                return false
            }
            if DependsOnEnclosingConditionalReceiver(conditionalAccess.Expression) {
                this.ReportUnsupportedNestedConditionalStaticHelperChain(conditionalAccess)
                result = ExpressionStatement(
                    this.PreserveNullConditionalStaticExtensionInvocation(conditionalAccess, invocation, helperName)
                )
                return true
            }
            if chainedReceiver != nil && !IsSupportedConditionalStaticHelperReceiver(chainedReceiver) {
                this.ReportUnsupportedConditionalStaticHelperChain(conditionalAccess)
                result = ExpressionStatement(
                    this.PreserveNullConditionalStaticExtensionInvocation(conditionalAccess, invocation, helperName)
                )
                return true
            }
            let localStatements = List[GStatement]()
            let replacements = List[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax]()
            let embedded = this.HoistAssignmentsInOrder(
                conditionalAccess.WhenNotNull,
                includeSelf: true,
                localStatements,
                replacements
            )
            var guard_ GExpression
            var call GExpression
            try {
                this.BuildNullConditionalStaticExtensionHelper(
                    conditionalAccess,
                    invocation,
                    owner,
                    name,
                    helperName,
                    chainedReceiver,
                    out guard_,
                    out call,
                    hostLocalAssignmentSeam: false
                )
            } finally {
                this.ReleaseHoistedAssignments(embedded, replacements)
            }
            localStatements.Add(ExpressionStatement(call))
            result = IfStatement(guard_, BlockStatement(localStatements))
            return true
        }

        private func TryMatchNullConditionalStaticExtensionHelper(
            conditionalAccess ConditionalAccessExpressionSyntax,
            out invocation InvocationExpressionSyntax?,
            out method IMethodSymbol?,
            out owner string?,
            out name string?,
            out helperName SimpleNameSyntax?,
            out chainedReceiver Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            invocation = conditionalAccess.WhenNotNull as InvocationExpressionSyntax
            method = if invocation == nil {
                default(IMethodSymbol?)
            } else {
                this.context.GetSymbolInfo(invocation).Symbol as IMethodSymbol
            }
            owner = nil
            name = nil
            helperName = nil
            chainedReceiver = nil
            // A by-reference parameter keeps no narrowing across a call (ADR-0208 R12).
            let matched = invocation
            if matched == nil || method == nil || !this.TryGetStaticExtensionHelper(method, out owner, out name) {
                return false
            }
            switch matched.Expression {
                case binding is MemberBindingExpressionSyntax {
                    helperName = binding.Name
                    return true
                }
                case member is MemberAccessExpressionSyntax {
                    helperName = member.Name
                    chainedReceiver = member.Expression
                    return true
                }
                default {
                    return false
                }
            }
        }

        private func BuildNullConditionalStaticExtensionHelper(
            conditionalAccess ConditionalAccessExpressionSyntax,
            invocation InvocationExpressionSyntax?,
            owner string?,
            name string?,
            helperName SimpleNameSyntax?,
            chainedReceiver Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            out $guard GExpression,
            out call GExpression,
            hostLocalAssignmentSeam bool
        ) {
            let receiver GExpression? = this.CaptureReceiverOnce(
                this.TranslateExpression(conditionalAccess.Expression),
                conditionalAccess.Expression,
                "a conditional-access helper call here has no enclosing evaluation seam to capture its receiver once."
            )
            var helperReceiver GExpression? = NonNullAssertionExpression(receiver)
            if chainedReceiver != nil {
                helperReceiver = this.TranslateWithConditionalReceiver(chainedReceiver, helperReceiver)
            }
            let callTypeArgs IReadOnlyList[GTypeReference]? = if helperName is GenericNameSyntax generic {
                this.MapTypeArguments(generic)
            } else {
                default(IReadOnlyList[GTypeReference]?)
            }
            let TranslateCall = func () GExpression {
                let callArgs = List[GExpression]{helperReceiver!!}
                callArgs.AddRange(this.TranslateArguments(invocation!!.ArgumentList.Arguments))
                return InvocationExpression(
                    MemberAccessExpression(IdentifierExpression(owner), name),
                    callArgs,
                    callTypeArgs
                )
            }
            call = if hostLocalAssignmentSeam && this.RequiresLocalAssignmentSeam(conditionalAccess.WhenNotNull) {
                this.TranslateWithLocalAssignmentSeam(conditionalAccess.WhenNotNull, TranslateCall)
            } else {
                TranslateCall()
            }
            $guard = BinaryExpression(receiver, "!=", LiteralExpression.Null())
        }

        private func TranslateWithConditionalReceiver(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            conditionalReceiver GExpression?
        ) GExpression? {
            let previous GExpression? = this.state.ConditionalReceiverReplacement
            this.state.ConditionalReceiverReplacement = conditionalReceiver
            try {
                return this.TranslateExpression(expression)
            } finally {
                this.state.ConditionalReceiverReplacement = previous
            }
        }

        private func PreserveNullConditionalStaticExtensionInvocation(
            conditionalAccess ConditionalAccessExpressionSyntax,
            invocation InvocationExpressionSyntax?,
            helperName SimpleNameSyntax?
        ) GExpression {
            let typeArguments IReadOnlyList[GTypeReference]? = if helperName is GenericNameSyntax generic {
                this.MapTypeArguments(generic)
            } else {
                default(IReadOnlyList[GTypeReference]?)
            }
            return ConditionalAccessExpression(
                this.TranslateExpression(conditionalAccess.Expression),
                InvocationExpression(
                    this.TranslateExpression(invocation!!.Expression),
                    this.TranslateCallArguments(invocation, invocation!!.ArgumentList.Arguments),
                    typeArguments
                )
            )
        }

        private func ReportUnsupportedConditionalStaticHelperChain(
            conditionalAccess ConditionalAccessExpressionSyntax
        ) {
            const message = "a null-conditional static-helper extension call with a non-member receiver chain " +
                "cannot be lowered without losing the conditional receiver; the safe extension form " +
                "is retained instead (issue #2821)."
            this.context.ReportUnsupported(conditionalAccess, message)
        }

        private func ReportUnsupportedNestedConditionalStaticHelperChain(
            conditionalAccess ConditionalAccessExpressionSyntax
        ) {
            const message = "a static-helper extension call nested under another null-conditional receiver " +
                "cannot be lowered without spilling a bare conditional receiver; the safe extension " +
                "form is retained instead (issue #2821)."
            this.context.ReportUnsupported(conditionalAccess, message)
        }

        /// Determines whether [`method`](paramref) is emitted as a plain
        /// static helper rather than a receiver-clause method.
        /// @param method The bound (possibly reduced) call symbol.
        /// @param ownerName The declaring static class name when matched.
        /// @param methodName The helper method name when matched.
        /// @returns `true` when the call targets a static helper.
        private func TryGetStaticExtensionHelper(
            method IMethodSymbol?,
            out ownerName string?,
            out methodName string?
        ) bool {
            ownerName = nil
            methodName = nil
            if method == nil || !method.IsExtensionMethod {
                return false
            }
            if this.HasReceiverCompanion(method) || !this.IsStaticExtensionHelper(method) {
                return false
            }
            let original IMethodSymbol? = method.ReducedFrom ?? method
            ownerName = if original!!.ContainingType is {} containingType {
                this.EmittedName(containingType, containingType.Name)
            } else {
                default(string?)
            }
            methodName = this.EmittedName(original, original!!.Name)
            return ownerName != nil
        }

        private func TryGetStaticExtensionHelperForMethodGroup(
            method IMethodSymbol?,
            out ownerName string?,
            out methodName string?
        ) bool {
            if this.TryGetStaticExtensionHelper(method, out ownerName, out methodName) {
                return true
            }
            let original IMethodSymbol? = method?.ReducedFrom ?? method
            if !this.HasReceiverCompanion(original) || !this.IsStaticExtensionHelper(original) ||
                original?.ReturnType is not INamedTypeSymbol taskLike ||
                taskLike.Name is not("Task" or "ValueTask") ||
                taskLike
                .ContainingNamespace
                ?.ToDisplayString() != "System.Threading.Tasks" {
                ownerName = nil
                methodName = nil
                return false
            }
            ownerName = if original!!.ContainingType is {} containingType {
                this.EmittedName(containingType, containingType.Name)
            } else {
                default(string?)
            }
            methodName = this.EmittedName(original, original!!.Name)
            return ownerName != nil
        }

        private func TranslateStaticExtensionHelperMethodGroup(
            member MemberAccessExpressionSyntax,
            method IMethodSymbol,
            ownerName string?,
            methodName string?
        ) GExpression {
            let receiver GExpression? = this.CaptureMethodGroupReceiver(
                this.TranslateReceiverWithNullForgiveness(member.Expression),
                member.Expression
            )
            let invoke IMethodSymbol? = GetDelegateInvokeMethod(this.context.GetTypeInfo(member).ConvertedType)
            let sourceParameters = invoke?.Parameters ?? method.Parameters
            let parameters = List[Parameter](sourceParameters.Length)
            let arguments = List[GExpression](sourceParameters.Length + 1){PassStaticExtensionHelperReceiver(
                    receiver,
                    method
                )!!
            }
            let wrapperParameterNames = HashSet[string](StringComparer.Ordinal)
            ReserveMethodGroupReceiverName(receiver, wrapperParameterNames)
            let helperNameParameters = if invoke != nil {
                MethodGroupWrapperNameParameters(method, invoke)
            } else {
                method.Parameters
            }
            for var i = 0; i < sourceParameters.Length; i++ {
                let mapped = this.MapParameter(sourceParameters[i], member, promoteNullability: false)
                let name string? = MethodGroupWrapperParameterName(
                    this.nameAllocator,
                    helperNameParameters,
                    i,
                    wrapperParameterNames
                )
                parameters.Add(Parameter(name, mapped.Type, mapped.IsVariadic, mapped.RefKind))
                var argument GExpression = IdentifierExpression(name)
                if sourceParameters[i].RefKind == RefKind.Ref || sourceParameters[i].RefKind == RefKind.Out {
                    argument = UnaryExpression("&", argument)
                }
                arguments.Add(argument)
            }
            let original = method.ReducedFrom ?? method
            let typeArguments IReadOnlyList[GTypeReference]? = if original.IsGenericMethod {
                method
                    .TypeArguments
                    .Select((type ITypeSymbol) -> this.typeMapper.Map(type, this.context, member.GetLocation())!!)
                    .ToList()
            } else {
                default(List[GTypeReference]?)
            }
            let call = InvocationExpression(
                MemberAccessExpression(IdentifierExpression(ownerName), methodName),
                arguments,
                typeArguments
            )
            return LambdaExpression(parameters, expressionBody: call)
        }

        private func CaptureMethodGroupReceiver(
            receiver GExpression?,
            receiverSyntax Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) GExpression? -> this
            .CaptureReceiverOnce(
            receiver,
            receiverSyntax,
            "a static-helper extension method group here has no enclosing evaluation seam to capture its receiver once."
        )

        private func CaptureReceiverOnce(
            receiver GExpression?,
            receiverSyntax Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            unsupportedMessage string
        ) GExpression? {
            // Issue #3357/#3360: a trivial, stable receiver needs no temp. A
            // mutable/reassigned local still spills because C# captures the
            // receiver value when the method group is formed, while the
            // synthesized G# lambda would otherwise re-read it when invoked.
            if IsTrivialOperand(receiver!!) && this.IsStableMethodGroupReceiver(receiverSyntax) {
                return receiver
            }
            if this.state.PendingSpillPrologue != nil {
                let temp = this.NewSpillName()
                this.state.PendingSpillPrologue!!.Add(
                    LocalDeclarationStatement(BindingKind.Let, temp, initializer: receiver)
                )
                return IdentifierExpression(temp)
            }
            this.context.ReportUnsupported(receiverSyntax, unsupportedMessage)
            return receiver
        }

        private func IsStableMethodGroupReceiver(
            receiverSyntax Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) bool {
            if receiverSyntax is Microsoft.CodeAnalysis.CSharp.Syntax.LiteralExpressionSyntax {
                return true
            }
            let receiverType ITypeSymbol? = this.context.GetTypeInfo(receiverSyntax).Type
            if receiverSyntax is ThisExpressionSyntax {
                return receiverType?.IsReferenceType == true
            }
            let symbol ISymbol? = this.context.GetSymbolInfo(receiverSyntax).Symbol
            if symbol is ILocalSymbol && symbol.IsConst == true {
                return true
            }
            if !(symbol is ILocalSymbol) && !(symbol is IParameterSymbol) {
                return false
            }
            if (symbol is ILocalSymbol local && local.RefKind != RefKind.None) ||
                (symbol is IParameterSymbol parameter && parameter.RefKind != RefKind.None) {
                return false
            }
            let stableValueShape = receiverType?.IsReferenceType == true ||
                receiverType?.TypeKind == TypeKind.Enum ||
                receiverType?.SpecialType != SpecialType.None ||
                receiverType is INamedTypeSymbol &&
                receiverType.IsReadOnly == true
            return stableValueShape && !this.IsSymbolReassigned(symbol, this.state.CurrentBodyScope)
        }

        /// Translates a single C# call argument, honoring `out`/`ref`
        /// argument forms (ADR-0115 §B; sample `TryParseOutVar.gs`): an
        /// `out`/`ref` argument naming a pre-declared variable maps to
        /// the address-of form `&x`, an inline `out var x` maps to
        /// `out var x`, and an `out _` discard maps to `out _`.
        private func TranslateArguments(arguments Microsoft.CodeAnalysis.SeparatedSyntaxList[ArgumentSyntax]) List[
            GExpression
        ] -> arguments
            .Select((a ArgumentSyntax) -> this.TranslateArgument(a)!!).ToList()

        private func TranslateArgumentsWithCallerInfo(
            callSyntax Microsoft.CodeAnalysis.SyntaxNode?,
            arguments Microsoft.CodeAnalysis.SeparatedSyntaxList[ArgumentSyntax],
            operationArguments ImmutableArray[IArgumentOperation]
        ) List[GExpression] {
            let translated = this.TranslateArguments(arguments)
            if operationArguments.IsDefaultOrEmpty {
                return translated
            }
            for argument in operationArguments {
                if argument.ArgumentKind == ArgumentKind.DefaultValue && argument.Parameter!!.GetAttributes().Any(
                    (attribute AttributeData) -> attribute
                        .AttributeClass
                        ?.ContainingNamespace
                        ?.ToDisplayString() == "System.Runtime.CompilerServices" &&
                        (
                        attribute.AttributeClass!!.Name is "CallerArgumentExpressionAttribute" or
                            "CallerMemberNameAttribute" or
                            "CallerFilePathAttribute" or
                            "CallerLineNumberAttribute"
                    )
                ) {
                    translated.Add(
                        NamedArgumentExpression(
                            this.EmittedName(argument.Parameter, argument.Parameter!!.Name),
                            this.TranslateOperationDefaultArgument(
                                callSyntax,
                                argument,
                                "caller information",
                                coerceToParameterType: false
                            )
                        )
                    )
                }
            }
            return translated
        }

        private func TranslateCallArguments(
            callSyntax Microsoft.CodeAnalysis.SyntaxNode?,
            arguments Microsoft.CodeAnalysis.SeparatedSyntaxList[ArgumentSyntax]
        ) List[GExpression] {
            let targetMethod IMethodSymbol? = switch this.context.SemanticModel.GetOperation(callSyntax!!) {
                case invocationOp is IInvocationOperation: invocationOp.TargetMethod
                case creationOp is IObjectCreationOperation: creationOp.Constructor
                default: default(IMethodSymbol?)
            }
            let operationArguments = switch this.context.SemanticModel.GetOperation(callSyntax!!) {
                case invocationOp is IInvocationOperation: invocationOp.Arguments
                case creationOp is IObjectCreationOperation: creationOp.Arguments
                default: default(ImmutableArray[IArgumentOperation])
            }
            if operationArguments.IsDefaultOrEmpty {
                return this.TranslateArgumentsWithCallerInfo(callSyntax, arguments, operationArguments)
            }
            if this.RequiresFunctionArgumentReassembly(targetMethod, operationArguments) {
                return this.TranslateFunctionTypeArguments(callSyntax, operationArguments)
            }
            let paramsCollectionArg IArgumentOperation? = operationArguments.FirstOrDefault(
                (a IArgumentOperation) -> a.ArgumentKind == ArgumentKind.ParamCollection
            )
            if paramsCollectionArg == nil {
                return this.TranslateArgumentsWithCallerInfo(callSyntax, arguments, operationArguments)
            }
            if arguments.Any((a ArgumentSyntax) -> a.NameColon != nil) {
                // A named argument feeding into (or skipping ahead of) a params
                // collection is rare enough, and interacts with enough of the
                // existing named-argument reordering machinery, that guessing a
                // lowering here risks silently mis-binding. Gap loudly instead
                // (falls through to the ordinary named-argument path, which at
                // least keeps every OTHER argument correct).
                this.context.ReportUnsupported(
                    callSyntax,
                    "a named argument alongside an expanded 'params' collection call has no canonical G# lowering yet."
                )
                return this.TranslateArgumentsWithCallerInfo(callSyntax, arguments, operationArguments)
            }
            // ADR-0173 / issue #3627: a SOURCE-DECLARED callee's params
            // collection now translates as a gsc variadic carrier
            // (`...X[T]`), so the expanded call site stays in its natural
            // form — gsc packs the trailing arguments into the carrier
            // exactly as C# does. Referenced (BCL) callees keep the
            // pre-existing lowerings below: gsc does not yet expand imported
            // [ParamCollection] members.
            let sourceDeclaredCallee = targetMethod?.DeclaringSyntaxReferences.IsEmpty == false
            if sourceDeclaredCallee && IsSupportedParamsCollectionType(paramsCollectionArg.Parameter!!.Type) {
                return this.TranslateArgumentsWithCallerInfo(callSyntax, arguments, operationArguments)
            }
            // Referenced span-params callees (e.g. BCL
            // `Task.WhenAll(params ReadOnlySpan<Task>)`) keep the pre-#1901
            // fallback: emit the natural expanded call and let gsc bind the
            // array/IEnumerable sibling overload via [ParamArray] expansion.
            let spanObjectCreation = callSyntax is BaseObjectCreationExpressionSyntax &&
                IsSpanParamsCollectionType(paramsCollectionArg.Parameter!!.Type)
            if !sourceDeclaredCallee &&
                !spanObjectCreation &&
                IsSpanParamsCollectionType(paramsCollectionArg.Parameter!!.Type) {
                return this.TranslateArgumentsWithCallerInfo(callSyntax, arguments, operationArguments)
            }
            if !IsSupportedParamsCollectionType(paramsCollectionArg.Parameter!!.Type) && !spanObjectCreation {
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
                if targetMethod
                    ?.DeclaringSyntaxReferences
                    .IsEmpty == false ||
                    callSyntax is BaseObjectCreationExpressionSyntax {
                    this.context.ReportUnsupported(
                        callSyntax,
                        "params collection of type '${paramsCollectionArg.Parameter!!.Type}' has no gsc construction form."
                    )
                }
                return this.TranslateArgumentsWithCallerInfo(callSyntax, arguments, operationArguments)
            }
            let translatedArguments = this.TranslateArgumentsBeforeParamsCollection(
                callSyntax,
                arguments,
                operationArguments,
                paramsCollectionArg,
                out var consumedSyntaxArguments
            )
            let callLocation = callSyntax!!.GetLocation()
            let paramsCollectionType GTypeReference? = this.typeMapper.Map(
                paramsCollectionArg.Parameter!!.Type,
                this.context,
                callLocation
            )
            let paramsElementType = (cast[INamedTypeSymbol](paramsCollectionArg.Parameter!!.Type)).TypeArguments[0]
            let elementType GTypeReference? = this.typeMapper.Map(paramsElementType, this.context, callLocation)
            let paramsValues = arguments
                .Skip(consumedSyntaxArguments)
                .Select((a ArgumentSyntax) -> this.TranslateArgument(a)!!)
                .ToList()
            if spanObjectCreation {
                translatedArguments.Add(
                    this.CoerceMaterializedArgument(
                        ArrayLiteralExpression(elementType, paramsValues),
                        paramsCollectionArg.Parameter!!.Type,
                        callLocation
                    )!!
                )
                return translatedArguments
            }
            let collectionElements = paramsValues.Select((value GExpression) -> CollectionInitializerElement(value))
                .ToList()
            let exactListParameter = paramsCollectionArg.Parameter!!.Type is INamedTypeSymbol{
                Name: "List"
            } listParameter &&
                listParameter
                .ContainingNamespace
                ?.ToDisplayString() == "System.Collections.Generic"
            let listType GTypeReference? = if exactListParameter {
                paramsCollectionType
            } else {
                this.typeMapper.Map(
                    this
                        .context
                        .Compilation
                        .GetTypeByMetadataName("System.Collections.Generic.List`1")
                        ?.Construct(paramsElementType),
                    this.context,
                    callLocation
                )
            }
            let construction = BuildConstruction(listType, List[GExpression]())
            // A zero-element params-collection call (`Total()`) has no elements to
            // brace — gsc's collection-initializer form requires at least one
            // element (an empty `{ }` fails to bind, GS0157); the bare
            // construction call (`List[int32]()`) is the canonical empty form
            // (mirrors the C# `[]`-collection-expression lowering above).
            let collectionArgument = if collectionElements.Count == 0 {
                construction
            } else {
                cast[GExpression](CollectionInitializerExpression(construction, collectionElements))
            }
            translatedArguments.Add(
                if exactListParameter {
                    collectionArgument
                } else {
                    this.CoerceMaterializedArgument(
                        collectionArgument,
                        paramsCollectionArg.Parameter!!.Type,
                        callLocation
                    )
                }
            )
            return translatedArguments
        }

        private func TranslateArgumentsBeforeParamsCollection(
            callSyntax Microsoft.CodeAnalysis.SyntaxNode?,
            arguments Microsoft.CodeAnalysis.SeparatedSyntaxList[ArgumentSyntax],
            operationArguments ImmutableArray[IArgumentOperation],
            paramsCollectionArgument IArgumentOperation,
            out consumedSyntaxArguments int32
        ) List[GExpression] {
            let result = List[GExpression](paramsCollectionArgument.Parameter!!.Ordinal)
            consumedSyntaxArguments = 0
            for operationArgument in operationArguments {
                if operationArgument.ArgumentKind == ArgumentKind.ParamCollection {
                    break
                }
                if operationArgument.ArgumentKind == ArgumentKind.DefaultValue {
                    result.Add(
                        this.TranslateOperationDefaultArgument(
                            callSyntax,
                            operationArgument,
                            "parameter",
                            coerceToParameterType: true
                        )!!
                    )
                    continue
                }
                result.Add(this.TranslateArgument(arguments[consumedSyntaxArguments])!!)
                consumedSyntaxArguments++
            }
            return result
        }

        private func RequiresFunctionArgumentReassembly(
            targetMethod IMethodSymbol?,
            operationArguments ImmutableArray[IArgumentOperation]
        ) bool {
            if operationArguments.IsDefaultOrEmpty || !operationArguments.Any(
                (a IArgumentOperation) -> a.ArgumentKind == ArgumentKind.DefaultValue ||
                    (a.Syntax is ArgumentSyntax and {NameColon: not nil})
            ) ||
                !operationArguments
                .All(
                (a IArgumentOperation) -> a.Parameter != nil &&
                    (
                    a.ArgumentKind == ArgumentKind.DefaultValue ||
                        IsEmptyParamsArgument(a) ||
                        (a.ArgumentKind == ArgumentKind.Explicit && a.Syntax is ArgumentSyntax)
                )
            ) {
                return false
            }
            return targetMethod?.MethodKind == MethodKind.DelegateInvoke ||
                (
                targetMethod?.MethodKind == MethodKind.LocalFunction &&
                    this
                    .state
                    .RecursiveLocalFunctionGroups
                    .TryGetValue(targetMethod!!, out var claimedGroup) &&
                    claimedGroup
                    .Members
                    .Contains(targetMethod!!, SymbolEqualityComparer.Default)
            )
        }

        private func ContainsFunctionArgumentSpillSeam(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) bool -> expression
            .DescendantNodesAndSelf(
            descendIntoChildren: (node Microsoft.CodeAnalysis.SyntaxNode) -> !(
                node is AnonymousFunctionExpressionSyntax
            )
        )
            .OfType[InvocationExpressionSyntax]()
            .Any(this.RequiresFunctionArgumentSpillSeam)

        private func RequiresFunctionArgumentSpillSeam(invocation InvocationExpressionSyntax) bool -> invocation
            .ArgumentList
            .Arguments
            .Any((a ArgumentSyntax) -> a.NameColon != nil) &&
            this
            .context
            .SemanticModel
            .GetOperation(invocation) is IInvocationOperation operation &&
            this.RequiresFunctionArgumentReassembly(operation.TargetMethod, operation.Arguments) &&
            PermutesExplicitArguments(operation.Arguments)

        private func SnapshotReorderedDelegateTarget(
            target GExpression?,
            invocation InvocationExpressionSyntax
        ) GExpression? {
            var target = target
            if this
                .context
                .SemanticModel
                .GetOperation(invocation) is IInvocationOperation operation &&
                operation
                .Arguments
                .All((a IArgumentOperation) -> a.Value.ConstantValue.HasValue || IsEmptyParamsArgument(a)) {
                return target
            }
            // Reading a null delegate succeeds; invoking it throws only AFTER
            // its arguments run. Do not execute G#'s runtime `!!` in the spill.
            var assertTarget = false
            while target is ParenthesizedExpression || target is NonNullAssertionExpression {
                if target is ParenthesizedExpression parenthesized {
                    target = parenthesized.Inner
                } else if target is NonNullAssertionExpression assertion {
                    assertTarget = true
                    target = assertion.Operand
                }
            }
            let snapshot GExpression? = this.SpillOperand(target!!, forceNonTrivial: true)
            return if assertTarget {
                cast[GExpression](NonNullAssertionExpression(snapshot))
            } else {
                snapshot
            }
        }

        /// Normalizes delegate and claimed-local-function calls to positional
        /// arguments, including omitted defaults and full-arity named calls.
        /// Roslyn arguments arrive in evaluation order: snapshot permuted
        /// operands in that order, then place each in its parameter's slot.
        private func TranslateFunctionTypeArguments(
            callSyntax Microsoft.CodeAnalysis.SyntaxNode?,
            operationArguments ImmutableArray[IArgumentOperation]
        ) List[GExpression] {
            let permutesExplicitArguments = PermutesExplicitArguments(operationArguments)
            let slots = [operationArguments.Count((a IArgumentOperation) -> !IsEmptyParamsArgument(a))]GExpression?
            for argumentOperation in operationArguments {
                let ordinal = argumentOperation.Parameter!!.Ordinal
                if IsEmptyParamsArgument(argumentOperation) {
                    continue
                }
                if argumentOperation.ArgumentKind == ArgumentKind.DefaultValue {
                    // MapConstantValue already uses the parameter's type.
                    // Keep nullable defaults as `nil`, not a cast envelope.
                    slots[ordinal] = this.TranslateOperationDefaultArgument(
                        callSyntax,
                        argumentOperation,
                        "function parameter",
                        coerceToParameterType: false
                    )
                    continue
                }
                let argumentSyntax = cast[ArgumentSyntax](argumentOperation.Syntax)
                let value GExpression? = this.TranslateArgumentValue(argumentSyntax)
                slots[ordinal] = if permutesExplicitArguments {
                    this.SnapshotPermutedArgument(value, argumentOperation)
                } else {
                    value
                }
            }
            return slots.ToList()
        }

        private func SnapshotPermutedArgument(value GExpression?, argument IArgumentOperation) GExpression? {
            if argument.Parameter!!.RefKind == RefKind.None {
                return this.SnapshotPermutedArgumentOperand(value, argument)
            }
            // Capture an address, never a copy of its pointee. This also runs
            // an array index/getter and its exceptions in source order.
            if value is UnaryExpression{Operator: "&"} address {
                let needsValueTemporary = argument.Parameter!!.RefKind == RefKind.In &&
                    argument.Syntax is ArgumentSyntax syntax &&
                    syntax
                    .RefKindKeyword
                    .IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.None) &&
                    (
                    argument.Value is not ILocalReferenceOperation and
                        not IParameterReferenceOperation and
                        not IFieldReferenceOperation and
                        not IArrayElementReferenceOperation
                )
                let temp = this.NewSpillName()
                this.state.PendingSpillPrologue!!.Add(
                    LocalDeclarationStatement(
                        BindingKind.Var,
                        temp,
                        this.typeMapper.Map(argument.Parameter!!.Type, this.context, argument.Syntax.GetLocation()),
                        address.Operand,
                        isRefAlias: !needsValueTemporary
                    )
                )
                return UnaryExpression("&", IdentifierExpression(temp))
            }
            if value is OutArgumentExpression outArgument {
                return if outArgument.Keyword == "out var" {
                    cast[GExpression](OutArgumentExpression("out", outArgument.Name))
                } else {
                    value
                }
            }
            return this.SnapshotPermutedArgumentOperand(value, argument)
        }

        // Reorder-safety differs from duplication-safety: even a bare local
        // must be read before a later argument can mutate it (#4211).
        private func SnapshotPermutedArgumentOperand(value GExpression?, argument IArgumentOperation) GExpression? {
            if argument.Value.ConstantValue.HasValue && (value is LiteralExpression || value is TypeExpression) {
                return value
            }
            // An implicit conversion (including a user-defined operator) is
            // part of argument evaluation, not something to postpone until the
            // reordered call. A callable/default also needs its target type.
            if (argument.Value is IConversionOperation or IDelegateCreationOperation) ||
                value is DefaultValueExpression {
                let temp = this.NewSpillName()
                this.state.PendingSpillPrologue!!.Add(
                    LocalDeclarationStatement(
                        BindingKind.Let,
                        temp,
                        this.typeMapper.Map(argument.Parameter!!.Type, this.context, argument.Syntax.GetLocation()),
                        value
                    )
                )
                return IdentifierExpression(temp)
            }
            return this.SpillOperand(value!!, forceNonTrivial: true)
        }

        private func TranslateOperationDefaultArgument(
            callSyntax Microsoft.CodeAnalysis.SyntaxNode?,
            argumentOperation IArgumentOperation,
            parameterKind string,
            coerceToParameterType bool
        ) GExpression? {
            let constant = argumentOperation.Value.ConstantValue
            var defaultValue GExpression? = if constant.HasValue {
                this.MapConstantValue(
                    constant.Value,
                    argumentOperation.Parameter!!.Type,
                    callSyntax,
                    "parameter '${argumentOperation.Parameter!!.Name}''s default value"
                )
            } else {
                default(GExpression?)
            }
            if defaultValue == nil {
                let legitimateNull = constant.HasValue && constant.Value == nil
                if !legitimateNull {
                    this.context.ReportUnsupported(
                        callSyntax,
                        "$parameterKind default value of type '${argumentOperation.Parameter!!.Type}' has no gsc constant form."
                    )
                }
                defaultValue = IdentifierExpression("nil")
            }
            return if coerceToParameterType {
                this.CoerceMaterializedArgument(
                    defaultValue,
                    argumentOperation.Parameter!!.Type,
                    callSyntax!!.GetLocation()
                )
            } else {
                defaultValue
            }
        }

        private func TranslateArgument(argument ArgumentSyntax) GExpression? {
            let value GExpression? = this.TranslateArgumentValue(argument)
            return if argument.NameColon == nil {
                value
            } else {
                cast[GExpression](
                    NamedArgumentExpression(
                        this.EmittedName(
                            this.context.GetSymbolInfo(argument.NameColon!!.Name).Symbol,
                            argument.NameColon!!.Name.Identifier.ValueText
                        ),
                        value
                    )
                )
            }
        }

        /// Issue #4422: whether [`argument`](paramref) is a by-reference
        /// argument whose C# `!` (`ref base.runstack!`) silenced a
        /// nullability warning that the translation loses. G# has no spelling
        /// for `!` on a variable (`&x!!` is an rvalue), so
        /// (cref:WithoutNonNullAssertion) drops it, and gsc then reports
        /// GS0612 where csc was told not to warn. The storage type is compared
        /// with the parameter's, including nullability; only a difference
        /// needs the suppression, and an operand whose type cannot be read is
        /// assumed to.
        /// @param argument The C# argument.
        /// @returns `true` when the statement must suppress GS0612.
        private func DropsByRefNullabilitySuppression(argument ArgumentSyntax) bool {
            var expression = argument.Expression
            while expression is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax parenthesized {
                expression = parenthesized.Expression
            }
            if expression is not PostfixUnaryExpressionSyntax suppression || !suppression.IsKind(
                Microsoft.CodeAnalysis.CSharp.SyntaxKind.SuppressNullableWarningExpression
            ) {
                return false
            }
            var operand = suppression.Operand
            while operand is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax inner {
                operand = inner.Expression
            }
            // gsc reports GS0612 only at a G# callee; an imported (metadata)
            // method's by-ref parameters keep their CLR matching rules, so a
            // suppression there would be dead, and its block could hide a
            // variable the statement declares.
            let boundParameter IParameterSymbol? = this.GetArgumentParameter(argument)
            if boundParameter?.ContainingSymbol is {} callee && callee.DeclaringSyntaxReferences.IsDefaultOrEmpty {
                return false
            }
            let parameterType ITypeSymbol? = boundParameter?.Type
            let storageType ITypeSymbol? = switch this.context.GetSymbolInfo(operand).Symbol {
                case field is IFieldSymbol: field.Type
                case local is ILocalSymbol: local.Type
                case parameter is IParameterSymbol: parameter.Type
                case property is IPropertySymbol: property.Type
                default: (this.context.SemanticModel.GetOperation(operand) as IArrayElementReferenceOperation)?.Type
            }
            return parameterType == nil || storageType == nil || !SymbolEqualityComparer.IncludeNullability.Equals(
                storageType,
                parameterType
            )
        }

        /// The parameter a call argument binds to, read from the called
        /// method's symbol (the argument's own operation is not always
        /// available for a `ref x!` operand).
        /// @param argument The C# argument.
        /// @returns The parameter, or `null`.
        private func GetArgumentParameter(argument ArgumentSyntax) IParameterSymbol? {
            let operationParameter IParameterSymbol? = (
                this.context.SemanticModel.GetOperation(argument) as IArgumentOperation
            )?.Parameter
            if argument.Parent is not BaseArgumentListSyntax list ||
                list.Parent == nil ||
                this
                .context
                .GetSymbolInfo(list.Parent)
                .Symbol is not IMethodSymbol method {
                return operationParameter
            }
            let parameter IParameterSymbol? = this.GetArgumentParameter(argument, method, operationParameter)
            if parameter != nil &&
                argument
                .Parent
                ?.Parent is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ExpressionSyntax call &&
                this.TryGetManagedReferenceArrayProjectedMethod(call, out var projected) &&
                parameter.Ordinal < projected!!
                .Parameters
                .Length &&
                projected!!
                .Parameters[parameter.Ordinal]
                .RefKind == parameter.RefKind {
                return projected!!.Parameters[parameter.Ordinal]
            }
            return parameter
        }

        private func GetArgumentParameter(argument ArgumentSyntax, method IMethodSymbol?) IParameterSymbol? {
            let operationParameter IParameterSymbol? = (
                this.context.SemanticModel.GetOperation(argument) as IArgumentOperation
            )?.Parameter
            return this.GetArgumentParameter(argument, method, operationParameter)
        }

        private func GetArgumentParameter(
            argument ArgumentSyntax,
            method IMethodSymbol?,
            operationParameter IParameterSymbol?
        ) IParameterSymbol? {
            if operationParameter != nil && method!!.MethodKind == MethodKind.ReducedExtension {
                let reducedParameter IParameterSymbol? = method!!.Parameters.FirstOrDefault(
                    (parameter IParameterSymbol) -> parameter.Name == operationParameter.Name &&
                        parameter.RefKind == operationParameter.RefKind
                )
                if reducedParameter != nil {
                    return reducedParameter
                }
            }
            if operationParameter != nil &&
                operationParameter.Ordinal >= 0 &&
                operationParameter.Ordinal < method!!
                .Parameters
                .Length &&
                method!!
                .Parameters[operationParameter.Ordinal]
                .RefKind == operationParameter.RefKind {
                return method!!.Parameters[operationParameter.Ordinal]
            }
            if argument.NameColon is {} nameColon {
                return method!!.Parameters.FirstOrDefault(
                    (parameter IParameterSymbol) -> parameter.Name == nameColon.Name.Identifier.ValueText
                )
            }
            if argument.Parent is not BaseArgumentListSyntax list {
                return nil
            }
            let index = list.Arguments.IndexOf(argument)
            if index >= 0 && index < method!!.Parameters.Length {
                return method!!.Parameters[index]
            }
            return if index >= method!!.Parameters.Length && method!!.Parameters.LastOrDefault() is {
                IsParams: true
            } paramsParameter {
                paramsParameter
            } else {
                default(IParameterSymbol?)
            }
        }

        private func TranslateArgumentValue(argument ArgumentSyntax) GExpression? {
            let refKind = argument.RefKindKeyword.Kind()
            if refKind != Microsoft.CodeAnalysis.CSharp.SyntaxKind.None && this.DropsByRefNullabilitySuppression(
                argument
            ) {
                // Issue #4422: carry the dropped `!` across as a statement-scoped
                // suppression of the warning it silenced.
                this.state.PendingStatementSuppressions?.Add("GS0612")
            }
            if refKind == Microsoft.CodeAnalysis.CSharp.SyntaxKind.OutKeyword {
                if argument.Expression is DeclarationExpressionSyntax declaration {
                    return switch declaration.Designation {
                        case _ is DiscardDesignationSyntax: cast[GExpression](OutArgumentExpression("out", "_"))
                        case single is SingleVariableDesignationSyntax: this.TranslateOutVarDesignation(single)
                        default: AddressOf(this.TranslateExpression(argument.Expression))
                    }
                }
                if (argument.Expression is IdentifierNameSyntax and {Identifier: {ValueText: "_"}}) {
                    return OutArgumentExpression("out", "_")
                }
                let translatedExisting GExpression? = WithoutNonNullAssertion(
                    this.TranslateExpression(argument.Expression)
                )
                if translatedExisting is IdentifierExpression identifier {
                    return OutArgumentExpression("out", identifier.Name)
                }
                // Non-identifier lvalues keep the universal address form.
                return AddressOf(translatedExisting)
            }
            if refKind == Microsoft.CodeAnalysis.CSharp.SyntaxKind.RefKeyword {
                return AddressOf(this.TranslateExpression(argument.Expression))
            }
            // ADR-0060: an explicit C# `in x` argument keeps its keyword, and
            // an implicit one naming a variable that targets a source-declared
            // `in` parameter gains it. Non-identifier explicit lvalues use the
            // universal `&expr` back-compat form the binder accepts at any
            // ref-kind parameter. Issue #4400: any other implicit argument
            // stays a plain value — gsc now binds it like C#, taking an
            // lvalue's address or spilling an rvalue to a readonly temp, so
            // `Scale(x + 1)` must not become the non-lvalue `&(x + 1)`.
            // Imported CLR targets keep the plain value too.
            if refKind == Microsoft.CodeAnalysis.CSharp.SyntaxKind.InKeyword || this.TargetsSourceDeclaredInParameter(
                argument
            ) {
                let translatedValue GExpression? = this.TranslateExpression(argument.Expression)
                let translatedIn GExpression? = WithoutNonNullAssertion(translatedValue)
                if translatedIn is IdentifierExpression inIdentifier &&
                    (
                    refKind == Microsoft
                        .CodeAnalysis
                        .CSharp
                        .SyntaxKind
                        .InKeyword ||
                        this.PassesInArgumentWithoutConversion(argument)
                ) {
                    return OutArgumentExpression("in", inIdentifier.Name)
                }
                // An implicit non-variable argument stays a plain value (its
                // `!!` is a valid value assertion); only an explicit `in`
                // needs the address form.
                return if refKind == Microsoft.CodeAnalysis.CSharp.SyntaxKind.InKeyword {
                    AddressOf(translatedIn)
                } else {
                    translatedValue
                }
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
            let isXunitNullAssertion = this.IsXunitNullAssertionArgument(argument)
            let argumentOperation IArgumentOperation? = this
                .context
                .SemanticModel
                .GetOperation(argument) as IArgumentOperation
            let argumentParameter IParameterSymbol? = this.GetArgumentParameter(argument)
            var paramsElementType ITypeSymbol? = nil
            var paramsParameter IParameterSymbol? = nil
            let expandedParamsArgument = argumentOperation == nil && this.TryGetExpandedParamsElementTarget(
                argument,
                argumentParameter,
                out paramsElementType,
                out paramsParameter
            )
            let targetType ITypeSymbol? = if expandedParamsArgument {
                paramsElementType
            } else {
                argumentParameter?.Type
            }
            let targetParameter IParameterSymbol? = if expandedParamsArgument {
                paramsParameter
            } else {
                argumentParameter
            }
            let argumentLocal ILocalSymbol? = this
                .context
                .GetSymbolInfo(argument.Expression)
                .Symbol as ILocalSymbol ??
                GetReferencedLocal(argumentOperation?.Value)
            let isFlowNarrowedLocal = argumentLocal != nil && this.IsDominatedByNullCheckGuard(
                argument.Expression,
                argumentLocal
            )
            let targetIsPromotedMigratedSibling = targetParameter is {} siblingParameter &&
                !SymbolEqualityComparer
                .Default
                .Equals(siblingParameter.ContainingAssembly, this.context.Compilation.Assembly) &&
                siblingParameter
                .ContainingAssembly
                ?.Name is {} targetAssemblyName &&
                targetAssemblyName != this
                .context
                .Compilation
                .AssemblyName &&
                (this.context.RepositoryCompilations ?? this.context.SiblingCompilations)?.Any(
                (compilation CSharpCompilation) -> compilation.AssemblyName == targetAssemblyName
            ) == true &&
                this.ShouldPromoteToNullableReference(siblingParameter)
            // Issue #4356: a `T?`-only-in-G# analyzer value passed where the
            // EMITTED parameter type is certainly non-null (a struct SyntaxToken,
            // or a reference parameter cs2gs does not promote to `T?`). Roslyn
            // sees the same non-null type on both sides, so the reference-type
            // test cannot tell; ForgiveNullableReferenceValue bridges it. An
            // expanded `params` argument has no IArgumentOperation of its own:
            // decide from the params ELEMENT target, and assert nothing when that
            // cannot be resolved — a missing `!!` fails to bind loudly, a wrong
            // one turns a legal nil into a throw.
            let analyzerNullableArgument = this.IsGSharpNullableAnalyzerExpression(argument.Expression)
            var targetRequiresNonNull bool
            if targetParameter != nil && targetType != nil {
                targetRequiresNonNull = (
                    this.TargetWillRemainNonNullableReference(targetType, targetParameter, argument.Expression) &&
                        !targetIsPromotedMigratedSibling &&
                        !this.IsObliviousImportedInferredTypeParameterTarget(targetParameter, argument.Expression)
                ) ||
                    (
                    analyzerNullableArgument && !targetIsPromotedMigratedSibling && this.AnalyzerBridgeTargetIsNonNull(
                        targetType,
                        targetParameter,
                        argument.Expression
                    )
                )
            } else {
                targetRequiresNonNull = !analyzerNullableArgument
            }
            if !IsNameOfArgument(argument) &&
                !isXunitNullAssertion &&
                targetRequiresNonNull &&
                !isFlowNarrowedLocal &&
                this.GetUserDefinedConversionInputOperator(argument.Expression, targetType, out _) == nil &&
                this
                .ReceiverNeedsNullForgiveness(
                argument.Expression,
                widenedSinkNeedsNonNull: true,
                widenedSinkInfersType: this.SinkInfersTypeFromValue(targetParameter, argument.Expression)
            ) {
                let unbridged GExpression? = this.TranslateExpression(argument.Expression)
                return this.ReportStoreBridge(
                    argument.Expression,
                    unbridged,
                    EnsureNonNullAssertion(unbridged),
                    targetParameter
                )
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
            let exactCallable GExpression? = this.TranslateExactCallableArgument(argument)
            var translated GExpression? = this.CoerceCovariantArrayConversion(
                argument.Expression,
                this.CoercePointerConversion(
                    argument.Expression,
                    this.CoerceNumericArgumentToConverted(
                        argument,
                        exactCallable ?? this.TranslateExpression(argument.Expression)
                    )
                )
            )
            if !IsNameOfArgument(argument) &&
                !isXunitNullAssertion &&
                targetRequiresNonNull &&
                targetParameter is {} parameter &&
                targetType != nil {
                // A warning-level C# null passed through a substituted generic
                // slot needs the target's static type without a runtime check.
                translated = if IsNullOrSuppressedNull(argument.Expression) &&
                    targetType.IsReferenceType &&
                    (
                    parameter
                        .ContainingAssembly
                        ?.Name == "Gsharp.Runtime.Values" ||
                        ContainsTypeParameter(parameter.OriginalDefinition.Type)
                ) {
                    cast[GExpression](
                        DefaultValueExpression(
                            this.typeMapper.Map(
                                targetType.WithNullableAnnotation(
                                    Microsoft.CodeAnalysis.NullableAnnotation.NotAnnotated
                                ),
                                this.context,
                                argument.Expression.GetLocation()
                            )
                        )
                    )
                } else {
                    this.ForgiveNullableReferenceValue(
                        argument.Expression,
                        translated,
                        targetType,
                        parameter,
                        includePromotedValue: true
                    )
                }
            }
            return translated
        }

        // Issue #3644: resolves the element contract an argument binds to when
        // it sits in the EXPANDED tail of a `params T[]` /
        // `params ReadOnlySpan<T>` parameter. The single-argument DIRECT collection form
        // (`Path.Combine(paths)`) binds the parameter itself and is excluded.
        private func TryGetExpandedParamsElementTarget(
            argument ArgumentSyntax,
            parameter IParameterSymbol?,
            out elementType ITypeSymbol?,
            out paramsParameter IParameterSymbol?
        ) bool {
            elementType = nil
            paramsParameter = nil
            if argument.NameColon != nil ||
                argument.Parent is not BaseArgumentListSyntax argumentList ||
                parameter?.IsParams != true {
                return false
            }
            let candidateElementType ITypeSymbol? = GetParamsElementType(parameter)
            if candidateElementType == nil || argumentList.Arguments.IndexOf(argument) < parameter!!.Ordinal {
                return false
            }
            if (
                this
                    .context
                    .SemanticModel
                    .GetOperation(argument) is IArgumentOperation and
                    {ArgumentKind: ArgumentKind.Explicit}
            ) {
                return false
            }
            let sourceType = this.context.GetTypeInfo(argument.Expression)
            if SymbolEqualityComparer.Default.Equals(sourceType.Type, parameter!!.Type) ||
                SymbolEqualityComparer
                .Default
                .Equals(sourceType.ConvertedType, parameter!!.Type) {
                return false
            }
            elementType = candidateElementType
            paramsParameter = parameter
            return true
        }

        private func TryGetCollectionInitializerArgumentTarget(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            index int32,
            projectedMethod IMethodSymbol?,
            boundMethod IMethodSymbol?,
            out targetType ITypeSymbol?,
            out targetParameter IParameterSymbol?
        ) bool {
            targetType = nil
            targetParameter = if index < projectedMethod!!.Parameters.Length {
                projectedMethod!!.Parameters[index]
            } else {
                projectedMethod!!.Parameters.LastOrDefault()
            }
            if targetParameter == nil || (index >= projectedMethod!!.Parameters.Length && !targetParameter.IsParams) {
                return false
            }
            targetType = targetParameter.Type
            let boundParameter IParameterSymbol? = if index < boundMethod!!.Parameters.Length {
                boundMethod!!.Parameters[index]
            } else {
                boundMethod!!.Parameters.LastOrDefault()
            }
            let paramsElementType ITypeSymbol? = GetParamsElementType(targetParameter)
            let valueType = this.context.GetTypeInfo(value)
            let sourceType ITypeSymbol? = valueType.Type ?? valueType.ConvertedType
            let directCollectionForm = sourceType != nil &&
                boundParameter != nil &&
                this
                .context
                .Compilation
                .ClassifyConversion(sourceType, boundParameter.Type)
                .IsImplicit
            if paramsElementType != nil && (index >= boundMethod!!.Parameters.Length || !directCollectionForm) {
                targetType = paramsElementType
            }
            return true
        }

        // ADR-0060: whether this argument binds (implicitly, in C#) to an `in`
        // parameter of a SOURCE-declared method — one that migrates to a G#
        // func, where a variable argument keeps the explicit `in` spelling.
        // Metadata-imported targets are excluded: like any plain argument
        // (issue #4400), gsc passes them by implicit readonly reference.
        private func TargetsSourceDeclaredInParameter(argument ArgumentSyntax) bool -> this
            .context
            .SemanticModel
            .GetOperation(argument) is IArgumentOperation{Parameter: {} parameter} &&
            parameter.RefKind == RefKind.In &&
            !parameter
            .ContainingSymbol
            .DeclaringSyntaxReferences
            .IsDefaultOrEmpty

        // Issue #4400: C# passes an implicit `in` argument by reference only
        // when it is variable storage that already has the parameter's type
        // (nullability included: `string` at `in string?` is not an exact
        // pointee for an explicit G# `in`).
        // A converted argument (`int` local at an `in long` parameter) is
        // converted and spilled, and a property or constant is an rvalue, so
        // each must stay a plain value: an explicit G# `in` demands an lvalue
        // of the parameter type (GS0154 / GS9001).
        private func PassesInArgumentWithoutConversion(argument ArgumentSyntax) bool -> this
            .context
            .SemanticModel
            .GetOperation(argument) is IArgumentOperation{Parameter: {} parameter, Value: {} value} &&
            (
            value is ILocalReferenceOperation &&
                value
                .Local
                .IsConst == false ||
                value is IParameterReferenceOperation ||
                value is IFieldReferenceOperation &&
                value
                .Field
                .IsConst == false
        ) &&
            SymbolEqualityComparer
            .IncludeNullability
            .Equals(value.Type, parameter.Type)

        // Issue #3414: Roslyn has already fixed the converted delegate signature
        // at a direct argument. Preserve it when the callable's natural signature
        // differs, instead of leaving gsc to materialize the wrong delegate ABI.
        private func TranslateExactCallableArgument(argument ArgumentSyntax) GExpression? {
            let expression Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ExpressionSyntax? = StripParentheses(argument.Expression)
            this.TryGetEffectiveArgumentDelegateInvoke(argument, out var effectiveInvoke)
            if expression is AnonymousFunctionExpressionSyntax lambda &&
                (effectiveInvoke != nil || this.TryGetConvertedDelegateInvoke(lambda, out effectiveInvoke)) {
                return this.typeMapper.WithMetadataImportCollisionQualification(
                    () -> if this.LambdaNeedsExactTarget(lambda, effectiveInvoke) {
                        this.TranslateLambda(lambda, effectiveInvoke)
                    } else {
                        this.TranslateLambda(lambda)
                    }
                )
            }
            if this.TryGetMethodGroupArgument(
                argument,
                out var method,
                out var methodGroupInvoke,
                out var isImplicitGroupConversion
            ) &&
                (
                if effectiveInvoke == nil {
                    (effectiveInvoke = methodGroupInvoke)
                } else {
                    effectiveInvoke
                }
            ) != nil {
                method = this.ProjectMethodGroupThroughInvoke(
                    argument,
                    method,
                    effectiveInvoke,
                    out var projectedMethodGroup
                )
                if method == nil ||
                    (
                    !projectedMethodGroup &&
                        !MethodGroupNeedsExactTarget(method, effectiveInvoke, isImplicitGroupConversion)
                ) {
                    return nil
                }
                return this.typeMapper.WithMetadataImportCollisionQualification(
                    () -> this.TranslateExactMethodGroupArgument(expression, method, effectiveInvoke)
                )
            }
            return nil
        }

        private func TryGetEffectiveArgumentDelegateInvoke(argument ArgumentSyntax, out invoke IMethodSymbol?) bool {
            invoke = nil
            let parameter IParameterSymbol? = this.GetArgumentParameter(argument)
            var targetType ITypeSymbol? = parameter?.Type
            if parameter != nil && this.TryGetExpandedParamsElementTarget(
                argument,
                parameter,
                out var paramsElementType,
                out _
            ) {
                targetType = paramsElementType
            }
            invoke = GetDelegateInvokeMethod(targetType)
            return invoke != nil
        }

        private func ProjectMethodGroupThroughInvoke(
            argument ArgumentSyntax,
            method IMethodSymbol?,
            invoke IMethodSymbol?,
            out changed bool
        ) IMethodSymbol? {
            changed = false
            if method!!.Parameters.Length != invoke!!.Parameters.Length {
                return method
            }
            var projectedMethod IMethodSymbol? = method
            if method!!.ContainingType is {} containingType {
                let containingTypes = NamedTypeAndContainingTypes(containingType).ToImmutableArray()
                let containingArguments = containingTypes.SelectMany(
                    func (type INamedTypeSymbol) IEnumerable[ITypeSymbol] {
                        return type.TypeArguments
                    }
                )
                    .ToImmutableArray()
                let containingParameters = containingTypes.SelectMany(
                    func (type INamedTypeSymbol) IEnumerable[ITypeParameterSymbol] {
                        return type.OriginalDefinition.TypeParameters
                    }
                )
                    .ToImmutableArray()
                let replacements = Dictionary[ITypeParameterSymbol, ITypeSymbol](SymbolEqualityComparer.Default)
                for var typeIndex = 0; typeIndex < containingParameters.Length; typeIndex++ {
                    let typeParameter = containingParameters[typeIndex]
                    var observedProjection ITypeSymbol? = nil
                    for var parameterIndex = 0; parameterIndex < method!!.Parameters.Length; parameterIndex++ {
                        let hasProjectedArgument = TryGetProjectedTypeArgument(
                            method!!.OriginalDefinition.Parameters[parameterIndex].Type,
                            invoke!!.Parameters[parameterIndex].Type,
                            typeParameter,
                            this.context.Compilation,
                            out var projectedArgument,
                            out var conflictingProjection
                        )
                        if conflictingProjection {
                            this.context.ReportUnsupported(
                                argument,
                                "projected delegate adaptation found conflicting types for type parameter '${typeParameter.Name}'."
                            )
                            return nil
                        }
                        if !hasProjectedArgument {
                            continue
                        }
                        if observedProjection != nil && !SymbolEqualityComparer.IncludeNullability.Equals(
                            observedProjection,
                            projectedArgument
                        ) {
                            this.context.ReportUnsupported(
                                argument,
                                "projected delegate adaptation found conflicting types for type parameter '${typeParameter.Name}'."
                            )
                            return nil
                        }
                        observedProjection = projectedArgument
                    }
                    let hasProjectedReturn = TryGetProjectedTypeArgument(
                        method!!.OriginalDefinition.ReturnType,
                        invoke!!.ReturnType,
                        typeParameter,
                        this.context.Compilation,
                        out var projectedReturn,
                        out var conflictingReturn
                    )
                    if conflictingReturn ||
                        (
                        hasProjectedReturn &&
                            observedProjection != nil &&
                            !SymbolEqualityComparer
                            .IncludeNullability
                            .Equals(observedProjection, projectedReturn)
                    ) {
                        this.context.ReportUnsupported(
                            argument,
                            "projected delegate adaptation found conflicting types for type parameter '${typeParameter.Name}'."
                        )
                        return nil
                    }
                    if hasProjectedReturn {
                        observedProjection = projectedReturn
                    }
                    if observedProjection == nil || SymbolEqualityComparer.IncludeNullability.Equals(
                        containingArguments[typeIndex],
                        observedProjection
                    ) {
                        continue
                    }
                    if observedProjection.NullableAnnotation == Microsoft
                        .CodeAnalysis
                        .NullableAnnotation
                        .Annotated &&
                        NullableTypeArgumentViolatesTranslatedConstraints(typeParameter) {
                        this.context.ReportUnsupported(
                            argument,
                            "projected delegate adaptation requires nullable type parameter '${typeParameter.Name}', but its translated constraints do not admit nullable type arguments."
                        )
                        return nil
                    }
                    replacements.Add(typeParameter, observedProjection)
                    changed = true
                }
                if changed {
                    let projectedContainingType = ProjectNamedType(containingType, replacements)
                    projectedMethod = this.GetProjectedMember(projectedContainingType, method) as IMethodSymbol
                    if projectedMethod == nil {
                        this.context.ReportUnsupported(
                            argument,
                            "could not project method group '${method!!.Name}' through translated containing type '$projectedContainingType'."
                        )
                        return nil
                    }
                }
            }
            if !method!!.IsGenericMethod {
                return projectedMethod
            }
            let typeArguments = method!!.TypeArguments.ToArray()
            for var typeIndex = 0; typeIndex < method!!.TypeParameters.Length; typeIndex++ {
                let typeParameter = projectedMethod!!.ConstructedFrom.TypeParameters[typeIndex]
                var observedProjection ITypeSymbol? = nil
                for var parameterIndex = 0; parameterIndex < method!!.Parameters.Length; parameterIndex++ {
                    let hasProjectedArgument = TryGetProjectedTypeArgument(
                        projectedMethod!!.ConstructedFrom.Parameters[parameterIndex].Type,
                        invoke!!.Parameters[parameterIndex].Type,
                        typeParameter,
                        this.context.Compilation,
                        out var projectedArgument,
                        out var conflictingProjection
                    )
                    if conflictingProjection {
                        this.context.ReportUnsupported(
                            argument,
                            "projected delegate adaptation found conflicting types for type parameter '${typeParameter.Name}'."
                        )
                        return nil
                    }
                    if !hasProjectedArgument {
                        continue
                    }
                    if observedProjection != nil && !SymbolEqualityComparer.IncludeNullability.Equals(
                        observedProjection,
                        projectedArgument
                    ) {
                        this.context.ReportUnsupported(
                            argument,
                            "projected delegate adaptation found conflicting types for type parameter '${typeParameter.Name}'."
                        )
                        return nil
                    }
                    observedProjection = projectedArgument
                }
                let hasProjectedReturn = TryGetProjectedTypeArgument(
                    projectedMethod!!.ConstructedFrom.ReturnType,
                    invoke!!.ReturnType,
                    typeParameter,
                    this.context.Compilation,
                    out var projectedReturn,
                    out var conflictingReturn
                )
                if conflictingReturn ||
                    (
                    hasProjectedReturn &&
                        observedProjection != nil &&
                        !SymbolEqualityComparer
                        .IncludeNullability
                        .Equals(observedProjection, projectedReturn)
                ) {
                    this.context.ReportUnsupported(
                        argument,
                        "projected delegate adaptation found conflicting types for type parameter '${typeParameter.Name}'."
                    )
                    return nil
                }
                if hasProjectedReturn {
                    observedProjection = projectedReturn
                }
                if observedProjection == nil || SymbolEqualityComparer.IncludeNullability.Equals(
                    typeArguments[typeIndex],
                    observedProjection
                ) {
                    continue
                }
                if observedProjection.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated &&
                    NullableTypeArgumentViolatesTranslatedConstraints(typeParameter) {
                    this.context.ReportUnsupported(
                        argument,
                        "projected delegate adaptation requires nullable type parameter '${typeParameter.Name}', but its translated constraints do not admit nullable type arguments."
                    )
                    return nil
                }
                typeArguments[typeIndex] = observedProjection
                changed = true
            }
            return if changed {
                projectedMethod!!.ConstructedFrom.Construct(typeArguments)
            } else {
                method
            }
        }

        private func TryGetMethodGroupArgument(
            argument ArgumentSyntax,
            out method IMethodSymbol?,
            out invoke IMethodSymbol?,
            out isImplicitConversion bool
        ) bool {
            method = nil
            invoke = nil
            isImplicitConversion = false
            if this
                .context
                .SemanticModel
                .GetOperation(argument) is not IArgumentOperation argumentOperation ||
                argumentOperation.Value is not IDelegateCreationOperation delegateCreation ||
                delegateCreation.Target is not IMethodReferenceOperation methodReference ||
                delegateCreation.Type is not INamedTypeSymbol delegateType {
                return false
            }
            // Issue #3505 (fixed): gsc now binds reference-variant method
            // groups AT native function-type slots too (the resolved group is
            // built at the target type, so emit is a plain target-typed
            // ldftn+newobj), and rejects the unsound value-type variance C#
            // never allowed either. Variance-direct emission is therefore
            // safe for imported and source-defined callees alike; the A5
            // imported-callee carve-out is retired.
            isImplicitConversion = delegateCreation.IsImplicit
            method = methodReference.Method
            invoke = delegateType.DelegateInvokeMethod
            return method != nil && invoke != nil
        }

        private func TryGetConvertedDelegateInvoke(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            out invoke IMethodSymbol?
        ) bool {
            invoke = GetDelegateInvokeMethod(this.context.GetTypeInfo(expression).ConvertedType)
            return invoke != nil
        }

        private func LambdaResultNeedsExactTarget(
            lambda AnonymousFunctionExpressionSyntax,
            invoke IMethodSymbol?
        ) bool {
            if invoke!!.ReturnsVoid {
                return false
            }
            let targetResult ITypeSymbol? = GetLambdaResultTargetType(lambda, invoke)
            if targetResult == nil {
                return false
            }
            return GetLambdaResultExpressions(lambda).Any(
                (result Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax) -> {
                    let resultType ITypeSymbol? = this.context.GetTypeInfo(result).Type
                    return resultType != nil && !SymbolEqualityComparer.IncludeNullability.Equals(
                        resultType,
                        targetResult
                    )
                }
            )
        }

        private func LambdaNeedsExactTarget(lambda AnonymousFunctionExpressionSyntax, invoke IMethodSymbol?) bool {
            let parameters IReadOnlyList[Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax] = switch lambda {
                case simple is SimpleLambdaExpressionSyntax: cast[
                    IReadOnlyList[Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax]
                ]([]Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax{simple.Parameter})
                case parenthesized is ParenthesizedLambdaExpressionSyntax: parenthesized.ParameterList.Parameters
                case anonymous is AnonymousMethodExpressionSyntax when anonymous.ParameterList != nil: anonymous.ParameterList!!.Parameters
                default: cast[IReadOnlyList[Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax]](
                    Array.Empty[Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax]()
                )
            }
            if parameters.Count != invoke!!.Parameters.Length {
                return true
            }
            for var index = 0; index < parameters.Count; index++ {
                if this.context.GetDeclaredSymbol(parameters[index]) is not IParameterSymbol parameter ||
                    parameter.RefKind != invoke!!
                    .Parameters[index]
                    .RefKind ||
                    !SymbolEqualityComparer
                    .IncludeNullability
                    .Equals(parameter.Type, invoke!!.Parameters[index].Type) {
                    return true
                }
            }
            if !this.IsExpressionTreeLambda(lambda) {
                return this.LambdaResultNeedsExactTarget(lambda, invoke)
            }
            return GetLambdaResultExpressions(lambda).Any(
                (result Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax) -> {
                    let projected ITypeSymbol? = this.GetManagedReferenceArrayProjectedExpressionType(result)
                    let original ITypeSymbol? = this.context.GetTypeInfo(result).Type
                    return projected != nil && !SymbolEqualityComparer.IncludeNullability.Equals(projected, original)
                }
            )
        }

        private func TranslateExactMethodGroupArgument(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            method IMethodSymbol?,
            invoke IMethodSymbol?
        ) GExpression {
            let wrapperParameterNames = HashSet[string](StringComparer.Ordinal)
            let parameters = List[Parameter](invoke!!.Parameters.Length)
            let arguments = List[GExpression](invoke!!.Parameters.Length + 1)
            var target GExpression? = nil
            let original IMethodSymbol? = method!!.ReducedFrom ?? method
            if original!!.IsExtensionMethod {
                this.typeMapper.TrackExtensionMethodNamespace(original)
            }
            if expression is MemberAccessExpressionSyntax extensionMember &&
                original!!.IsExtensionMethod &&
                !(this.context.GetSymbolInfo(extensionMember.Expression).Symbol is INamedTypeSymbol) &&
                (
                method!!.MethodKind == MethodKind.ReducedExtension ||
                    original!!
                    .Parameters
                    .Length == invoke!!
                    .Parameters
                    .Length +
                    1
            ) {
                // Target the emitted G# shape: migrated source extensions use
                // receiver syntax unless only a static helper survives.
                let sourceDefined = !original!!.DeclaringSyntaxReferences.IsDefaultOrEmpty || this.KnownCompilations()
                    .Any(
                    (compilation CSharpCompilation) -> SameAssembly(compilation.Assembly, original!!.ContainingAssembly)
                )
                let topLevelGSharpExtension = original!!.ContainingType?.Name == "<Program>"
                let useStaticHelper = this.TryGetStaticExtensionHelper(
                    original,
                    out var helperOwner,
                    out var helperName
                ) ||
                    (!sourceDefined && !topLevelGSharpExtension)
                var receiver GExpression?
                if useStaticHelper {
                    receiver = this.ForgiveNullableReferenceValue(
                        extensionMember.Expression,
                        this.TranslateExpression(extensionMember.Expression),
                        original!!.Parameters[0].Type,
                        original!!.Parameters[0],
                        includePromotedValue: true
                    )
                    receiver = this.CaptureMethodGroupReceiver(receiver, extensionMember.Expression)
                    arguments.Add(PassStaticExtensionHelperReceiver(receiver, original)!!)
                    target = MemberAccessExpression(
                        if helperOwner != nil {
                            cast[GExpression](IdentifierExpression(helperOwner))
                        } else {
                            this.StaticQualifierReceiver(original!!.ContainingType, expression.GetLocation())
                        },
                        helperName ?? this.EmittedName(original, original!!.Name)
                    )
                } else {
                    let translatedReceiver GExpression? = if this.MemberBindsToNullableThisExtension(extensionMember) {
                        this.TranslateExpression(extensionMember.Expression)
                    } else {
                        this.TranslateReceiverWithNullForgiveness(extensionMember.Expression)
                    }
                    receiver = this.CaptureMethodGroupReceiver(translatedReceiver, extensionMember.Expression)
                    target = MemberAccessExpression(receiver, this.EmittedName(original, original!!.Name))
                }
            }
            target ??= this.TranslateMethodGroupInvocationTarget(expression, method)
            ReserveMethodGroupReceiverName(target, wrapperParameterNames)
            // At this point `arguments` holds only a captured receiver (the
            // static-extension-helper shape); reserve its root identifier too.
            for receiverArgument in arguments {
                ReserveMethodGroupReceiverName(receiverArgument, wrapperParameterNames)
            }
            let wrapperNameParameters = MethodGroupWrapperNameParameters(method, invoke)
            for var index = 0; index < invoke!!.Parameters.Length; index++ {
                let invokeParameter = invoke!!.Parameters[index]
                let mapped = this.MapParameter(invokeParameter, expression, promoteNullability: false)
                let name string? = MethodGroupWrapperParameterName(
                    this.nameAllocator,
                    wrapperNameParameters,
                    index,
                    wrapperParameterNames
                )
                parameters.Add(Parameter(name, mapped.Type, mapped.IsVariadic, mapped.RefKind))
                var forwarded GExpression = IdentifierExpression(name)
                if invokeParameter.RefKind == RefKind.Ref || invokeParameter.RefKind == RefKind.Out {
                    forwarded = UnaryExpression("&", forwarded)
                }
                arguments.Add(forwarded)
            }
            let typeArguments IReadOnlyList[GTypeReference]? = if method!!.IsGenericMethod {
                method!!
                    .TypeArguments
                    .Select((type ITypeSymbol) -> this.typeMapper.Map(type, this.context, expression!!.GetLocation())!!)
                    .ToList()
            } else {
                default(List[GTypeReference]?)
            }
            let call = InvocationExpression(target, arguments, typeArguments)
            let returnType GTypeReference? = this.MapDelegateLikeReturnType(
                invoke,
                isAsync: false,
                expression!!.GetLocation()
            )
            // Issue #3468: the surrounding output uses arrow lambdas, so a
            // wrapper whose result type needs no pinning renders as the
            // concise arrow form `(path string) -> Target(path)`. Only two
            // shapes still need a body that fixes the delegate's result type:
            // a non-void delegate whose result differs from the method's
            // return (the explicit-return-type function literal widens the
            // returned value), and a void delegate wrapping a value-returning
            // method (the block statement discards the value). By-ref
            // parameters also keep the literal form.
            let hasByRefParameter = invoke!!.Parameters.Any(
                (parameter IParameterSymbol) -> parameter.RefKind == RefKind.Ref || parameter.RefKind == RefKind.Out
            )
            let resultMatches = if invoke!!.ReturnsVoid {
                method!!.ReturnsVoid
            } else {
                !method!!.ReturnsVoid && SymbolEqualityComparer.Default.Equals(method!!.ReturnType, invoke!!.ReturnType)
            }
            if !hasByRefParameter && resultMatches {
                return LambdaExpression(parameters, expressionBody: call)
            }
            let statements = if returnType == nil {
                []GStatement{ExpressionStatement(call)}
            } else {
                []GStatement{ReturnStatement(call)}
            }
            return LambdaExpression(
                parameters,
                blockBody: BlockStatement(statements),
                returnType: returnType,
                isFunctionLiteral: true
            )
        }

        private func TranslateMethodGroupInvocationTarget(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            method IMethodSymbol?
        ) GExpression? {
            if expression is SimpleNameSyntax simpleName && this.TryTranslateLiftedLocalFunctionReference(
                simpleName,
                out var liftedReference
            ) {
                return liftedReference
            }
            if method!!.IsStatic &&
                method!!.MethodKind != MethodKind.LocalFunction &&
                method!!.ContainingType is {IsImplicitlyDeclared: false} owner &&
                !SymbolEqualityComparer
                .Default
                .Equals(owner.OriginalDefinition, this.entryType?.OriginalDefinition) {
                return MemberAccessExpression(
                    this.StaticQualifierReceiver(owner, expression!!.GetLocation()),
                    this.EmittedName(method, method!!.Name)
                )
            }
            if expression is MemberAccessExpressionSyntax member &&
                !method!!.IsStatic &&
                !this
                .TryGetStaticExtensionHelper(method, out _, out _) {
                let receiver GExpression? = this.CaptureMethodGroupReceiver(
                    this.TranslateReceiverWithNullForgiveness(member.Expression),
                    member.Expression
                )
                return MemberAccessExpression(receiver, this.EmittedName(method, member.Name.Identifier.ValueText))
            }
            return this.TranslateExpression(expression)
        }

        private func IsXunitNullAssertionArgument(argument ArgumentSyntax) bool {
            if argument.Parent?.Parent is not InvocationExpressionSyntax invocation {
                return false
            }
            // Issue #4116: `Assert.Equal<T>(T, T)`/`Assert.NotEqual<T>(T, T)`
            // carry no non-null constraint on `T` in xunit's own signature —
            // comparing a value against a legitimately-null expected/actual
            // result (e.g. a reflected `ParameterInfo.DefaultValue` for a
            // nilable-defaulted parameter) is exactly what they exist to do.
            // Before this, only `Assert.Null`/`Assert.NotNull` were exempted
            // here, so gsc's oblivious-forwarding bridge treated `Equal`'s
            // arguments as flowing into a non-null sink and forced a G# `!!`
            // runtime assertion on a value that is null by design — throwing
            // an NRE instead of comparing the legitimate `nil`.
            // The namespace check must pin the EXACT top-level `Xunit`
            // namespace (`global::Xunit`), not merely a namespace whose last
            // segment happens to be named "Xunit" (e.g. `Company.Xunit`,
            // some other vendor's assertion library). Matching by leaf
            // `.Name` alone would exempt an unrelated imported
            // `Company.Xunit.Assert.Equal`'s non-null parameter from the
            // forced-bridge, silently leaving a nullable G# value passed to
            // whatever real non-null sink that method has. Mirrors the same
            // "outer namespace is global" check CSharpTypeMapper already
            // applies for an exact `System` match.
            return (
                this
                    .context
                    .GetSymbolInfo(invocation)
                    .Symbol is IMethodSymbol and
                    {
                    Name: "Null" or "NotNull" or "Equal" or "NotEqual",
                    ContainingType: {Name: "Assert"},
                    ContainingNamespace: {Name: "Xunit", ContainingNamespace: {IsGlobalNamespace: true}}
                }
            )
        }

        // Coerce an argument expression to the numeric type C# implicitly converted
        // it to at the call site, when that converted type differs from the
        // expression's own numeric type AND gsc would not perform that conversion
        // implicitly. Issue #1281: gsc already widens (ADR-0044) and constant-narrows
        // (C# §10.2.11) at a concrete numeric parameter, so the explicit G# wrap is
        // emitted only for the residual cases gsc still rejects — a non-constant
        // narrowing/cross-sign value, or a widening argument bound to a generic
        // (type-parameter) parameter.
        private func CoerceNumericArgumentToConverted(argument ArgumentSyntax, translated GExpression?) GExpression? {
            let expression = argument.Expression
            // gsc performs this implicit numeric conversion at the call site
            // itself — the explicit conversion would be redundant.
            if this.GSharpAcceptsImplicitNumericArgument(argument) {
                return translated
            }
            // A numeric literal is already retyped to its C# converted type by the
            // literal-translation path (a float-promoted literal becomes a float
            // literal `30.0`, ADR-0115 §B.12), so re-wrapping it here would double
            // up the conversion. Constant signed→unsigned literal retyping is still
            // applied below for integer targets.
            if expression is Microsoft.CodeAnalysis.CSharp.Syntax.LiteralExpressionSyntax literal && literal.IsKind(
                Microsoft.CodeAnalysis.CSharp.SyntaxKind.NumericLiteralExpression
            ) {
                let literalInfo = this.context.GetTypeInfo(expression)
                if TryGetNumericKind(literalInfo.Type, out var literalSource) &&
                    TryGetNumericKind(literalInfo.ConvertedType, out var literalTarget) &&
                    literalSource != literalTarget &&
                    !this
                    .TargetsConcreteNumericParameter(argument) {
                    return this.CoerceOperandTo(translated, literalInfo.ConvertedType, expression.GetLocation())
                }
                return this.CoerceConstantToUnsigned(expression, translated)
            }
            let info = this.context.GetTypeInfo(expression)
            if TryGetNumericKind(info.Type, out var sourceUnderlying) &&
                TryGetNumericKind(info.ConvertedType, out var convertedUnderlying) &&
                sourceUnderlying != convertedUnderlying {
                return this.CoerceOperandTo(translated, info.ConvertedType, expression.GetLocation())
            }
            return translated
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
        private func GSharpAcceptsImplicitNumericArgument(argument ArgumentSyntax) bool {
            let expression = argument.Expression
            let info = this.context.GetTypeInfo(expression)
            if !TryGetNumericKind(info.Type, out var source) ||
                !TryGetNumericKind(info.ConvertedType, out var converted) ||
                source == converted {
                return false
            }
            if !this.TargetsConcreteNumericParameter(argument) {
                return false
            }
            if IsGSharpImplicitNumericWidening(source, converted) {
                return true
            }
            // A non-widening (narrowing / cross-sign) conversion is implicit in gsc
            // only for a constant integer literal (or unary +/- over one); C# already
            // proved the value is in range by compiling the implicit conversion.
            return IsFoldableIntegerLiteral(expression)
        }

        // Reports whether the argument binds to a parameter whose ORIGINAL-definition
        // type is a concrete numeric primitive. For a generic method the constructed
        // parameter type is the inferred concrete type, but the original is the type
        // parameter `T` — which is excluded so a widening argument to a generic CLR
        // method keeps its explicit conversion (issue #1281).
        private func TargetsConcreteNumericParameter(argument ArgumentSyntax) bool {
            if this.context.SemanticModel.GetOperation(argument) is not IArgumentOperation argumentOperation {
                return false
            }
            let parameter IParameterSymbol? = argumentOperation.Parameter
            if parameter == nil {
                return false
            }
            return TryGetNumericKind(parameter.OriginalDefinition.Type, out _)
        }

        private func TranslateObjectCreation(
            creation Microsoft.CodeAnalysis.CSharp.Syntax.ObjectCreationExpressionSyntax
        ) GExpression? {
            var typeSymbol ITypeSymbol? = this.context.GetTypeInfo(creation).Type
            if this.TryGetManagedReferenceArrayProjectedMethod(creation, out var projectedConstructor) {
                typeSymbol = projectedConstructor!!.ContainingType
            }
            var type GTypeReference? = if typeSymbol != nil {
                this.typeMapper.Map(typeSymbol, this.context, creation.GetLocation())
            } else {
                cast[GTypeReference](NamedTypeReference(creation.Type.ToString()))
            }
            type = this.PromoteCreationTupleArguments(type, typeSymbol, creation)
            type = this.PromoteObliviousContainerCreation(type, typeSymbol, creation)
            let arguments = this.TranslateCallArguments(
                creation,
                creation.ArgumentList?.Arguments ?? default(Microsoft.CodeAnalysis.SeparatedSyntaxList[ArgumentSyntax])
            )
            // A C# delegate creation `new SomeDelegate(target)` wraps a method
            // group, lambda, or another delegate in a named delegate type. G# has
            // no delegate wrapper type: a delegate value IS a function value
            // (ADR-0115 function types). The wrapping constructor is therefore
            // redundant — unwrap it to the sole target expression. Constructing the
            // mapped delegate type directly would fail because a delegate maps to an
            // `ArrowTypeReference` (a structural function type), not a callable named
            // type, and would otherwise leak the AST node's CLR type name.
            if typeSymbol is INamedTypeSymbol namedType &&
                namedType.TypeKind == TypeKind.Delegate &&
                arguments.Count == 1 {
                return UnwrapNamedArgument(arguments[0])
            }
            return this.BuildObjectCreationCore(creation, typeSymbol, type, arguments, creation.Initializer)
        }

        /// Shared core for (cref:TranslateObjectCreation) and
        /// (cref:TranslateImplicitObjectCreation) (issue #1728): both entry
        /// points map the same C# constructor-call-plus-initializer shapes to the
        /// same G# forms, and had already drifted apart before this method
        /// existed (a struct-zip guard present on only one path; a verbatim
        /// re-inline of (cref:BuildConstruction)). Routing both through
        /// one method makes that drift structurally impossible.
        private func BuildObjectCreationCore(
            creationNode BaseObjectCreationExpressionSyntax,
            typeSymbol ITypeSymbol?,
            type GTypeReference?,
            arguments IReadOnlyList[GExpression],
            initializer InitializerExpressionSyntax?
        ) GExpression? {
            var type = type
            if typeSymbol is INamedTypeSymbol systemObject && systemObject.SpecialType == SpecialType.System_Object {
                type = NamedTypeReference(
                    this.typeMapper.GetOrCreateImportedTypeAlias(systemObject, this.context, creationNode.GetLocation())
                )
            }
            let hasCtorArgs = arguments.Count > 0
            // A C# collection initializer maps to the canonical G# collection
            // initializer `Target{ ... }` (ADR-0117, issue #479). This covers
            // `new List<int>{1, 2, 3}` (bare elements), `new Dictionary<K,V>{ {k, v} }`
            // (complex element initializers → `k: v` pairs), and
            // `new Dictionary<K,V>{ ["k"] = v }` (indexer entries). The construction
            // target carries any constructor arguments, matching
            // `new(StringComparer.OrdinalIgnoreCase){ ... }`.
            if initializer != nil && this.TryTranslateCollectionInitializer(
                initializer,
                typeSymbol as INamedTypeSymbol,
                type,
                arguments,
                out var collectionInitializer
            ) {
                return collectionInitializer
            }
            let valueType INamedTypeSymbol? = typeSymbol as INamedTypeSymbol
            let isSourceValueStruct = valueType != nil &&
                valueType.TypeKind == TypeKind.Struct &&
                valueType.SpecialType == SpecialType.None &&
                !valueType.IsTupleType &&
                !valueType
                .DeclaringSyntaxReferences
                .IsEmpty
            var structUnsupportedReason string? = nil
            if isSourceValueStruct &&
                (
                initializer == nil || initializer.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.ObjectInitializerExpression
                )
            ) {
                let builtStructFields = this.TryBuildSourceStructConstructorFields(
                    creationNode,
                    valueType,
                    arguments,
                    out var constructorFields,
                    out var usesCallablePrimaryConstructor,
                    out structUnsupportedReason
                )
                if builtStructFields && !usesCallablePrimaryConstructor {
                    if initializer != nil {
                        let initializerFields = this.TranslateObjectInitializerFields(initializer, valueType)
                        let initializedNames = HashSet[string](
                            constructorFields!!.Select((field FieldInitializer) -> field.Name),
                            StringComparer.Ordinal
                        )
                        let duplicate FieldInitializer? = initializerFields.FirstOrDefault(
                            (field FieldInitializer) -> initializedNames.Contains(field.Name)
                        )
                        if duplicate != nil {
                            let message = "object initializer overwrites constructor-initialized struct member '${duplicate.Name}'. " +
                                "Collapsing both writes into one G# struct-literal field could drop constructor evaluation " +
                                "or side effects (issue #2435)."
                            this.context.ReportUnsupported(initializer, message)
                        } else {
                            constructorFields!!.AddRange(initializerFields)
                        }
                    }
                    return CompositeLiteralExpression(type, constructorFields)
                } else if !builtStructFields && structUnsupportedReason != nil {
                    this.context.ReportUnsupported(creationNode, structUnsupportedReason)
                }
            }
            if initializer != nil && initializer.IsKind(
                Microsoft.CodeAnalysis.CSharp.SyntaxKind.ObjectInitializerExpression
            ) {
                if typeSymbol?.SpecialType == SpecialType.System_Object && initializer.Expressions.Count == 0 {
                    return BuildConstruction(type, arguments)
                }
                // An object initializer `new T { Field = value, ... }` with NO
                // constructor argument list maps to the canonical G# struct
                // literal `T{Field: value, ...}` (spec §Struct literals; ADR-0115
                // §B.11).
                if !hasCtorArgs &&
                    (
                    typeSymbol is ITypeParameterSymbol ||
                        (
                        typeSymbol is INamedTypeSymbol &&
                            typeSymbol.SpecialType != SpecialType.System_Object &&
                            this.InvokesParameterlessConstructor(creationNode)
                    )
                ) {
                    return this.BuildObjectInitializerLiteral(initializer, typeSymbol as INamedTypeSymbol, type)
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
                    typeSymbol as INamedTypeSymbol,
                    type,
                    this.MaterializeOmittedConstructorArguments(creationNode, arguments)
                )
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
            return BuildConstruction(type, arguments)
        }

        private func InvokesParameterlessConstructor(creationNode BaseObjectCreationExpressionSyntax) bool {
            return (this.context.GetSymbolInfo(creationNode).Symbol is IMethodSymbol and {Parameters: {Length: 0}})
        }

        private func MaterializeOmittedConstructorArguments(
            creationNode BaseObjectCreationExpressionSyntax,
            arguments IReadOnlyList[GExpression]
        ) IReadOnlyList[GExpression] {
            if arguments.Count != 0 ||
                this
                .context
                .GetSymbolInfo(creationNode)
                .Symbol is not IMethodSymbol constructor ||
                constructor
                .Parameters
                .Length == 0 {
                return arguments
            }
            let materialized = List[GExpression](constructor.Parameters.Length)
            for parameter in constructor.Parameters {
                if parameter.IsParams && parameter.Type is IArrayTypeSymbol paramsArray {
                    materialized.Add(
                        ArrayLiteralExpression(
                            this.typeMapper.Map(paramsArray.ElementType, this.context, creationNode.GetLocation())
                        )
                    )
                    continue
                }
                let parameterType GTypeReference? = this.typeMapper.Map(
                    parameter.Type,
                    this.context,
                    creationNode.GetLocation()
                )
                let defaultValue GExpression? = this.BuildOptionalParameterDefault(
                    parameter,
                    parameterType,
                    creationNode
                )
                if defaultValue == nil {
                    return arguments
                }
                materialized.Add(
                    this.CoerceMaterializedArgument(defaultValue, parameter.Type, creationNode.GetLocation())!!
                )
            }
            return materialized
        }

        private func CoerceMaterializedArgument(
            value GExpression?,
            parameterType ITypeSymbol,
            location Location
        ) GExpression? {
            if !parameterType.IsReferenceType {
                return this.CoerceOperandTo(value, parameterType, location)
            }
            let mappedType GTypeReference? = this.typeMapper.Map(
                parameterType.WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.NotAnnotated),
                this.context,
                location
            )
            if value is LiteralExpression &&
                value.Kind == LiteralKind.Null ||
                value is IdentifierExpression &&
                value.Name == "nil" {
                return DefaultValueExpression(mappedType)
            }
            if parameterType.SpecialType == SpecialType.System_String &&
                value is LiteralExpression &&
                value.Kind == LiteralKind.String {
                return value
            }
            return ConversionExpression(mappedType, value, isCheckedReferenceCast: true)
        }

        private func TryBuildSourceStructConstructorFields(
            creationNode BaseObjectCreationExpressionSyntax,
            valueType INamedTypeSymbol?,
            arguments IReadOnlyList[GExpression],
            out fieldInitializers List[FieldInitializer]?,
            out usesCallablePrimaryConstructor bool,
            out unsupportedReason string?
        ) bool {
            fieldInitializers = nil
            usesCallablePrimaryConstructor = false
            let ctorSymbol IMethodSymbol? = this.context.GetSymbolInfo(creationNode).Symbol as IMethodSymbol
            if ctorSymbol == nil {
                unsupportedReason = "the invoked source struct constructor could not be resolved; " +
                    "a G# struct literal cannot be built safely (issue #2435)."
                return false
            }
            if ctorSymbol.DeclaringSyntaxReferences.IsEmpty && arguments.Count == 0 {
                fieldInitializers = List[FieldInitializer]()
                unsupportedReason = nil
                return true
            }
            if ctorSymbol
                .DeclaringSyntaxReferences
                .Length == 1 &&
                (
                ctorSymbol.DeclaringSyntaxReferences[0].GetSyntax() is TypeDeclarationSyntax and
                    {ParameterList: not nil}
            ) {
                usesCallablePrimaryConstructor = true
                unsupportedReason = nil
                return true
            }
            // Issue #2766: plain structs now preserve source constructors as
            // callable G# init members. Keep the call itself instead of replaying
            // assignments into a literal; record structs retain their separate
            // data-struct lowering path (#2744).
            if !valueType!!.IsRecord &&
                ctorSymbol
                .DeclaringSyntaxReferences
                .Length == 1 &&
                ctorSymbol
                .DeclaringSyntaxReferences[0]
                .GetSyntax() is Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax {
                usesCallablePrimaryConstructor = true
                unsupportedReason = nil
                return true
            }
            if !this.TryAnalyzeStructConstructor(ctorSymbol, valueType, out var plan, out unsupportedReason) {
                return false
            }
            let loweredArguments = this.NormalizeLoweredConstructorArguments(creationNode, ctorSymbol, arguments)
            return this.TryInstantiateStructConstructorPlan(
                plan,
                loweredArguments,
                out fieldInitializers,
                out unsupportedReason
            )
        }

        private func NormalizeLoweredConstructorArguments(
            creationNode BaseObjectCreationExpressionSyntax,
            constructor IMethodSymbol,
            arguments IReadOnlyList[GExpression]
        ) IReadOnlyList[(ParameterOrdinal int32, Value GExpression?)] {
            let syntaxArguments = switch creationNode {
                case explicitCreation is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ObjectCreationExpressionSyntax: explicitCreation
                    .ArgumentList
                    ?.Arguments ??
                    default(Microsoft.CodeAnalysis.SeparatedSyntaxList[ArgumentSyntax])
                case implicitCreation is ImplicitObjectCreationExpressionSyntax: implicitCreation
                    .ArgumentList
                    ?.Arguments ??
                    default(Microsoft.CodeAnalysis.SeparatedSyntaxList[ArgumentSyntax])
                default: default(Microsoft.CodeAnalysis.SeparatedSyntaxList[ArgumentSyntax])
            }
            if syntaxArguments.Count != arguments.Count || constructor.Parameters.Length < arguments.Count {
                return BuildPositionalLoweredArguments(arguments)
            }
            let lowered = List[(ParameterOrdinal int32, Value GExpression?)](constructor.Parameters.Length)
            let suppliedOrdinals = HashSet[int32]()
            for var sourceIndex = 0; sourceIndex < syntaxArguments.Count; sourceIndex++ {
                if !(
                    this
                        .context
                        .SemanticModel
                        .GetOperation(syntaxArguments[sourceIndex]) is IArgumentOperation{Parameter: {} parameter}
                ) {
                    return BuildPositionalLoweredArguments(arguments)
                }
                lowered.Add((parameter.Ordinal, UnwrapNamedArgument(arguments[sourceIndex])))
                suppliedOrdinals.Add(parameter.Ordinal)
            }
            for var ordinal = 0; ordinal < constructor.Parameters.Length; ordinal++ {
                if suppliedOrdinals.Contains(ordinal) {
                    continue
                }
                let parameter = constructor.Parameters[ordinal]
                let parameterType GTypeReference? = this.typeMapper.Map(
                    parameter.Type,
                    this.context,
                    creationNode.GetLocation()
                )
                let defaultValue GExpression? = this.BuildOptionalParameterDefault(
                    parameter,
                    parameterType,
                    creationNode
                )
                if defaultValue == nil {
                    return BuildPositionalLoweredArguments(arguments)
                }
                lowered.Add((ordinal, defaultValue))
            }
            return lowered
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
        private func ForgiveInitializerElementValue(
            valueExpression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            translatedValue GExpression?,
            targetType ITypeSymbol?,
            targetSymbolForPromotionCheck ISymbol?
        ) GExpression? {
            // ADR-0186 step 6 (PR 0): a `T!` element or member value is checked
            // by gsc at the non-null target.
            if translatedValue is NonNullAssertionExpression ||
                IsNullOrSuppressedNull(valueExpression) ||
                this.PlatformTypedImportNeedsNoBridge(valueExpression) || !this.TargetWillRemainNonNullableReference(
                targetType,
                targetSymbolForPromotionCheck,
                valueExpression
            ) ||
                // A member whose arms are already asserted (issue #5516) is non-null as a whole.
            this.GSharpExpressionIsStaticallyNonNull(valueExpression, translatedValue) {
                return translatedValue
            }
            // Issue #3676: in a nullable-ENABLED compilation the promoted value
            // to bridge is a generated-code declaration this translator
            // repainted `T?` on direct null evidence — the LSP
            // `Location { Uri = DocumentUri.FromFileSystemPath(path) }` shape,
            // where the callee's `return null` branch is real but the target
            // property has no null evidence of its own and stays non-null. The
            // C# accepted the initializer only by trusting the generated
            // annotation, so asserting restores the contract it assumed.
            return if (
                this.NullableReferenceValueMayBeNull(valueExpression, respectDeclaredCallResults: true) ||
                    (
                    if this.IsObliviousCompilation() {
                        this.IsNullablePromotedValue(valueExpression)
                    } else {
                        this.IsGeneratedDeclarationPromotedValue(valueExpression)
                    }
                )
            ) {
                this.ReportStoreBridge(
                    valueExpression,
                    translatedValue,
                    EnsureNonNullAssertion(translatedValue),
                    targetSymbolForPromotionCheck,
                    targetType
                )
            } else if this.IsClosureAssignedVariable(this.context.GetSymbolInfo(valueExpression).Symbol) &&
                this.IsFlowNarrowedInCSharpOnly(valueExpression, translatedValue) {
                EnsureNonNullAssertion(translatedValue)
            } else {
                translatedValue
            }
        }

        // Object-initializer member assignment (`Field = value` inside `T{ ... }`
        // / `T(args){ ... }`): routes the field/property target's type/promotion
        // state and the assignment's RHS value expression through the shared
        // <see cref="ForgiveInitializerElementValue"/> bridge above.
        private func ForgiveObjectInitializerValue(
            assignment Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax,
            translatedValue GExpression?,
            constructedType INamedTypeSymbol?
        ) GExpression? {
            let target ISymbol? = this.GetProjectedInitializerMember(assignment, constructedType)
            if !((target is IFieldSymbol || target is IPropertySymbol)) {
                return translatedValue
            }
            let targetType ITypeSymbol? = switch target {
                case field is IFieldSymbol: field.Type
                case property is IPropertySymbol: property.Type
                default: default(ITypeSymbol?)
            }
            return this.ForgiveInitializerElementValue(assignment.Right, translatedValue, targetType, target)
        }

        private func GetProjectedInitializerMember(
            assignment Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax,
            constructedType INamedTypeSymbol?
        ) ISymbol? {
            let target ISymbol? = this.context.GetSymbolInfo(assignment.Left).Symbol
            return if constructedType == nil || target == nil {
                target
            } else {
                this.GetProjectedMember(constructedType, target) ?? target
            }
        }

        private func GetProjectedInitializerMemberType(
            assignment Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax,
            constructedType INamedTypeSymbol?
        ) ITypeSymbol? {
            return switch this.GetProjectedInitializerMember(assignment, constructedType) {
                case field is IFieldSymbol: field.Type
                case property is IPropertySymbol: property.Type
                default: default(ITypeSymbol?)
            }
        }

        /// Builds the canonical G# struct literal `T{Field: value, ...}` from a
        /// C# object initializer (`{ Field = value, ... }`), used by both the
        /// explicit (`new T { ... }`) and target-typed (`new() { ... }`)
        /// construction paths (spec §Struct literals; ADR-0115 §B.11).
        private func BuildObjectInitializerLiteral(
            initializer InitializerExpressionSyntax,
            constructedType INamedTypeSymbol?,
            type GTypeReference?
        ) GExpression {
            return CompositeLiteralExpression(type, this.TranslateObjectInitializerFields(initializer, constructedType))
        }

        private func TranslateObjectInitializerFields(
            initializer InitializerExpressionSyntax,
            constructedType INamedTypeSymbol?
        ) List[FieldInitializer] {
            let fieldInitializers = List[FieldInitializer]()
            for element in initializer.Expressions {
                if element is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .AssignmentExpressionSyntax assignment &&
                    assignment.Left is IdentifierNameSyntax name {
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
                    if assignment.Right is InitializerExpressionSyntax nestedInit &&
                        (
                        nestedInit.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.CollectionInitializerExpression) ||
                            nestedInit.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.ObjectInitializerExpression)
                    ) {
                        let memberElements List[CollectionInitializerElement]? = this
                            .TranslateCollectionInitializerElements(
                            nestedInit,
                            this.GetProjectedInitializerMemberType(assignment, constructedType)
                        )
                        if memberElements != nil {
                            fieldInitializers.Add(
                                FieldInitializer(
                                    this.EmittedName(name, name.Identifier),
                                    CollectionInitializerExpression(target: nil, memberElements)
                                )
                            )
                            continue
                        }
                    }
                    // Issue #3860: an object-initializer member is an ASSIGNMENT
                    // position, so C# performs the same implicit array-covariance
                    // conversion here it performs for a plain assignment
                    // (`Compile = new[] { new TaskItem(...) }` into an
                    // `ITaskItem[]` property — the test/Sdk.Tests wall). G#
                    // slices are invariant (#2516/#3685), so the upcast has to be
                    // spelled; without it gsc reports GS0156.
                    let value GExpression? = this.CoerceCovariantArrayConversion(
                        assignment.Right,
                        this.TranslateExpression(assignment.Right)
                    )
                    fieldInitializers.Add(
                        FieldInitializer(
                            this.EmittedName(name, name.Identifier),
                            this.ForgiveObjectInitializerValue(assignment, value, constructedType)
                        )
                    )
                } else {
                    this.context.ReportUnsupported(
                        element,
                        "object-initializer element is not a simple `Field = value` assignment; no canonical G# struct-literal form yet (ADR-0115 §B.11)."
                    )
                }
            }
            return fieldInitializers
        }

        /// Builds the canonical G# construction-with-initializer-suffix
        /// `Target(args) { Name = value, ... }` (gsc issue #522) for a C#
        /// object initializer combined with constructor arguments (issue #1728):
        /// `new T(a, b) { Field = value, ... }`. A nested
        /// `Prop = { a, b }` COLLECTION-initializer member lowers to the
        /// same target-less member collection-initializer form used by
        /// (cref:BuildObjectInitializerLiteral) (issue #1567) — gsc's
        /// suffix parser now carries the same carve-out (issue #1858), so a
        /// collection member composes with constructor arguments in one
        /// construct instead of being dropped. A nested `Prop = { X = 1 }`
        /// OBJECT-initializer member has no such carve-out and is reported as
        /// unsupported instead of being silently mistranslated.
        private func BuildConstructionWithInitializerSuffix(
            initializer InitializerExpressionSyntax,
            constructedType INamedTypeSymbol?,
            type GTypeReference?,
            arguments IReadOnlyList[GExpression]
        ) GExpression {
            let construction = BuildConstruction(type, arguments)
            let memberInitializers = List[FieldInitializer]()
            for element in initializer.Expressions {
                if element is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .AssignmentExpressionSyntax assignment &&
                    assignment.Left is IdentifierNameSyntax name {
                    if assignment.Right is InitializerExpressionSyntax nestedInit && nestedInit.IsKind(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.CollectionInitializerExpression
                    ) {
                        let memberElements List[CollectionInitializerElement]? = this
                            .TranslateCollectionInitializerElements(
                            nestedInit,
                            this.GetProjectedInitializerMemberType(assignment, constructedType)
                        )
                        if memberElements != nil {
                            memberInitializers.Add(
                                FieldInitializer(
                                    this.EmittedName(name, name.Identifier),
                                    CollectionInitializerExpression(target: nil, memberElements)
                                )
                            )
                            continue
                        }
                    } else if assignment.Right is InitializerExpressionSyntax nestedObjectInit &&
                        nestedObjectInit
                        .IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.ObjectInitializerExpression) {
                        let memberElements List[CollectionInitializerElement]? = this
                            .TranslateCollectionInitializerElements(
                            nestedObjectInit,
                            this.GetProjectedInitializerMemberType(assignment, constructedType)
                        )
                        if memberElements != nil {
                            memberInitializers.Add(
                                FieldInitializer(
                                    this.EmittedName(name, name.Identifier),
                                    CollectionInitializerExpression(target: nil, memberElements)
                                )
                            )
                            continue
                        }
                    }
                    // Issue #3860: same array-covariance assignment position as in
                    // TranslateObjectInitializerFields, for the construction-with-
                    // initializer-suffix form `T(args) { Field = value }`.
                    memberInitializers.Add(
                        FieldInitializer(
                            this.EmittedName(name, name.Identifier),
                            this.ForgiveObjectInitializerValue(
                                assignment,
                                this.CoerceCovariantArrayConversion(
                                    assignment.Right,
                                    this.TranslateExpression(assignment.Right)
                                ),
                                constructedType
                            )
                        )
                    )
                } else {
                    this.context.ReportUnsupported(
                        element,
                        "object-initializer element is not a simple `Field = value` assignment; no canonical G# construction-with-initializer-suffix form yet (issue #1728)."
                    )
                }
            }
            return ObjectCreationInitializerExpression(construction, memberInitializers)
        }

        /// Attempts to translate a C# collection initializer into a canonical G#
        /// collection initializer (ADR-0117). Returns `false` when
        /// the initializer is not a collection initializer (e.g. a plain object
        /// initializer), leaving the caller's other mappings to apply.
        private func TryTranslateCollectionInitializer(
            initializer InitializerExpressionSyntax?,
            constructedType INamedTypeSymbol?,
            type GTypeReference?,
            arguments IReadOnlyList[GExpression],
            out result GExpression?
        ) bool {
            result = nil
            let isCollectionInitializer = initializer.IsKind(
                Microsoft.CodeAnalysis.CSharp.SyntaxKind.CollectionInitializerExpression
            )
            let isIndexedObjectInitializer = initializer.IsKind(
                Microsoft.CodeAnalysis.CSharp.SyntaxKind.ObjectInitializerExpression
            ) &&
                initializer!!
                .Expressions
                .Count > 0 &&
                initializer!!
                .Expressions
                .All(
                (e Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax) -> e is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .AssignmentExpressionSyntax &&
                    e.Left is ImplicitElementAccessSyntax
            )
            if !isCollectionInitializer && !isIndexedObjectInitializer {
                return false
            }
            let unsupportedNullParamsCarrier Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ExpressionSyntax? = if isCollectionInitializer {
                initializer!!.Expressions.FirstOrDefault(this.IsUnsupportedDirectNullParamsCarrierElement)
            } else {
                default(Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?)
            }
            if unsupportedNullParamsCarrier != nil {
                this.context.ReportUnsupported(
                    unsupportedNullParamsCarrier,
                    "a direct null/default params carrier has no exact G# form: a G# variadic call always materializes the carrier."
                )
                result = BuildConstruction(type, arguments)
                return true
            }
            // Issue #3501 / ADR-0117: a G# collection-initializer element holds
            // exactly one or two values, so an N-ary `{ a, b, c }` element
            // (xunit's TheoryData rows are the canonical case — sugar for
            // `Add(a, b, c)`) has no element form. The whole initializer lowers
            // to a block expression that constructs the collection and issues
            // the same `Add` calls the C# compiler synthesizes:
            // `{ let values = T(...) \n values.Add(a, b, c) ... \n values }`.
            if isCollectionInitializer && initializer!!.Expressions.Any(
                (e Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax) -> e.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.ComplexElementInitializerExpression
                ) &&
                    (e is InitializerExpressionSyntax && e.Expressions.Count != 2)
            ) {
                result = this.TranslateAddCallCollectionInitializer(initializer, constructedType, type, arguments)
                return result != nil
            }
            let elements List[CollectionInitializerElement]? = this.TranslateCollectionInitializerElements(
                initializer,
                constructedType
            )
            if elements == nil {
                return false
            }
            let construction = BuildConstruction(type, arguments)
            result = CollectionInitializerExpression(construction, elements)
            return true
        }

        private func IsUnsupportedDirectNullParamsCarrierElement(
            element Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) bool {
            let values IReadOnlyList[
                Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
            ] = if element is InitializerExpressionSyntax complex &&
                element.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.ComplexElementInitializerExpression) {
                complex.Expressions
            } else {
                cast[IReadOnlyList[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax]](
                    []Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax{element}
                )
            }
            let addMethod IMethodSymbol? = this
                .context
                .SemanticModel
                .GetCollectionInitializerSymbolInfo(element)
                .Symbol as IMethodSymbol
            if addMethod == nil || values.Count != addMethod.Parameters.Length {
                return false
            }
            let parameter = addMethod.Parameters[^1]
            return parameter.IsParams &&
                (
                parameter.Type is IArrayTypeSymbol ||
                    (parameter.Type is INamedTypeSymbol collection && IsSupportedParamsCollectionType(collection))
            ) &&
                (
                IsNullOrDefaultLiteral(values[^1]) ||
                    this
                    .context
                    .SemanticModel
                    .GetConstantValue(values[^1]) is {HasValue: true, Value: nil}
            )
        }

        // Lowers a collection initializer containing an N-ary (N != 2) complex
        // element into a block expression of explicit `Add` calls — the exact
        // calls C# lowers the initializer to. The local keeps a readable name,
        // suffixed only on a (syntactic) collision with the element expressions.
        private func TranslateAddCallCollectionInitializer(
            initializer InitializerExpressionSyntax?,
            constructedType INamedTypeSymbol?,
            type GTypeReference?,
            arguments IReadOnlyList[GExpression]
        ) GExpression {
            var localName = "values"
            let initializerText = initializer!!.ToString()
            for var suffix = 2; Regex.IsMatch(initializerText, "\\b$localName\\b"); suffix++ {
                localName = "values" + suffix.ToString(CultureInfo.InvariantCulture)
            }
            let statements = List[GStatement]{
                LocalDeclarationStatement(BindingKind.Let, localName, initializer: BuildConstruction(type, arguments))
            }
            for element in initializer!!.Expressions {
                let boundAddMethod IMethodSymbol? = this
                    .context
                    .SemanticModel
                    .GetCollectionInitializerSymbolInfo(element)
                    .Symbol as IMethodSymbol
                var addMethod IMethodSymbol? = boundAddMethod
                addMethod = if constructedType == nil || addMethod == nil {
                    addMethod
                } else {
                    this.GetProjectedMember(constructedType, addMethod) as IMethodSymbol ?? addMethod
                }
                let valueSyntaxes IReadOnlyList[
                    Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
                ] = if element is InitializerExpressionSyntax complex &&
                    element.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.ComplexElementInitializerExpression) {
                    complex.Expressions
                } else {
                    cast[IReadOnlyList[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax]](
                        []Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax{element}
                    )
                }
                let addArguments = List[GExpression]()
                for var i = 0; i < valueSyntaxes.Count; i++ {
                    var value GExpression? = this.TranslateExpression(valueSyntaxes[i])
                    if addMethod != nil && this.TryGetCollectionInitializerArgumentTarget(
                        valueSyntaxes[i],
                        i,
                        addMethod,
                        boundAddMethod,
                        out var targetType,
                        out var targetParameter
                    ) {
                        value = this.ForgiveInitializerElementValue(
                            valueSyntaxes[i],
                            value,
                            targetType,
                            targetParameter
                        )
                    }
                    addArguments.Add(value!!)
                }
                statements.Add(
                    ExpressionStatement(
                        InvocationExpression(
                            MemberAccessExpression(IdentifierExpression(localName), "Add"),
                            addArguments
                        )
                    )
                )
            }
            return BlockExpression(statements, IdentifierExpression(localName))
        }

        /// Translates the elements of a C# collection initializer into canonical
        /// G# (cref:CollectionInitializerElement)s (bare, keyed, or
        /// indexed). Returns `null` when an element has no
        /// canonical G# form (an unsupported diagnostic is reported). Shared by
        /// the standalone collection initializer (ADR-0117) and the member
        /// collection initializer used to populate a get-only collection property
        /// at construction (issue #1567, `Prop = { … }`).
        private func TranslateCollectionInitializerElements(
            initializer InitializerExpressionSyntax?,
            constructedType ITypeSymbol? = nil
        ) List[CollectionInitializerElement]? {
            let elements = List[CollectionInitializerElement]()
            for element in initializer!!.Expressions {
                if this.IsUnsupportedDirectNullParamsCarrierElement(element) {
                    this.context.ReportUnsupported(
                        element,
                        "a direct null/default params carrier has no exact G# form: a G# variadic call always materializes the carrier."
                    )
                    return nil
                }
                if element is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .AssignmentExpressionSyntax{Left: IdentifierNameSyntax memberName} memberAssignment {
                    if memberAssignment.Right is InitializerExpressionSyntax nestedInitializer &&
                        (
                        nestedInitializer.IsKind(
                            Microsoft.CodeAnalysis.CSharp.SyntaxKind.CollectionInitializerExpression
                        ) ||
                            nestedInitializer.IsKind(
                            Microsoft.CodeAnalysis.CSharp.SyntaxKind.ObjectInitializerExpression
                        )
                    ) {
                        let nestedElements List[CollectionInitializerElement]? = this
                            .TranslateCollectionInitializerElements(
                            nestedInitializer,
                            this.GetProjectedInitializerMemberType(
                                memberAssignment,
                                constructedType as INamedTypeSymbol
                            )
                        )
                        if nestedElements == nil {
                            return nil
                        }
                        elements.Add(
                            CollectionInitializerElement(
                                this.EmittedName(memberName, memberName.Identifier),
                                CollectionInitializerExpression(target: nil, nestedElements)
                            )
                        )
                        continue
                    }
                    let memberValue GExpression? = this.TranslateExpression(memberAssignment.Right)
                    elements.Add(
                        CollectionInitializerElement(
                            this.EmittedName(memberName, memberName.Identifier),
                            this.ForgiveObjectInitializerValue(
                                memberAssignment,
                                memberValue,
                                constructedType as INamedTypeSymbol
                            )
                        )
                    )
                } else if element is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .AssignmentExpressionSyntax{Left: ImplicitElementAccessSyntax indexAccess} indexedAssignment {
                    // `["k"] = v` → indexed element.
                    if indexAccess.ArgumentList.Arguments.Count != 1 {
                        this.context.ReportUnsupported(
                            element,
                            "multi-argument indexer initializer has no canonical G# collection-initializer form (ADR-0117)."
                        )
                        return nil
                    }
                    // The constructed property symbol carries the indexer's
                    // nullable substitution (`TValue` -> `object?`); type info
                    // for the implicit access can lose that annotation.
                    let indexerSymbol ISymbol? = this.context.GetSymbolInfo(indexAccess).Symbol
                    let indexerValueType ITypeSymbol? = (constructedType as IArrayTypeSymbol)?.ElementType ??
                        (indexerSymbol as IPropertySymbol)?.Type ??
                        this
                        .context
                        .GetTypeInfo(indexAccess)
                        .Type
                    let indexedValue GExpression? = this.ForgiveInitializerElementValue(
                        indexedAssignment.Right,
                        this.TranslateExpression(indexedAssignment.Right),
                        indexerValueType,
                        indexerSymbol
                    )
                    elements.Add(
                        CollectionInitializerElement(
                            this.TranslateIndexArgumentWithNullForgiveness(indexAccess.ArgumentList.Arguments[0]),
                            indexedValue,
                            indexed: true
                        )
                    )
                } else if element is InitializerExpressionSyntax complex && element.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.ComplexElementInitializerExpression
                ) {
                    // `{k, v}` → keyed element `k: v` (dictionary Add(k, v)).
                    if complex.Expressions.Count != 2 {
                        this.context.ReportUnsupported(
                            element,
                            "collection initializer element with other than two values has no canonical G# form (ADR-0117)."
                        )
                        return nil
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
                    let boundAddMethod IMethodSymbol? = this
                        .context
                        .SemanticModel
                        .GetCollectionInitializerSymbolInfo(complex)
                        .Symbol as IMethodSymbol
                    var addMethod IMethodSymbol? = boundAddMethod
                    addMethod = if constructedType is not INamedTypeSymbol namedType || addMethod == nil {
                        addMethod
                    } else {
                        this.GetProjectedMember(namedType, addMethod) as IMethodSymbol ?? addMethod
                    }
                    var keyValue GExpression? = this.TranslateExpression(complex.Expressions[0])
                    var pairValue GExpression? = this.TranslateExpression(complex.Expressions[1])
                    if addMethod != nil && this.TryGetCollectionInitializerArgumentTarget(
                        complex.Expressions[0],
                        0,
                        addMethod,
                        boundAddMethod,
                        out var keyTargetType,
                        out var keyTargetParameter
                    ) &&
                        this
                        .TryGetCollectionInitializerArgumentTarget(
                        complex.Expressions[1],
                        1,
                        addMethod,
                        boundAddMethod,
                        out var valueTargetType,
                        out var valueTargetParameter
                    ) {
                        keyValue = this.ForgiveInitializerElementValue(
                            complex.Expressions[0],
                            keyValue,
                            keyTargetType,
                            keyTargetParameter
                        )
                        pairValue = this.ForgiveInitializerElementValue(
                            complex.Expressions[1],
                            pairValue,
                            valueTargetType,
                            valueTargetParameter
                        )
                    }
                    elements.Add(CollectionInitializerElement(keyValue, pairValue, indexed: false))
                } else {
                    // Bare element `e` → `Add(e)`. Same `Add`-overload resolution
                    // as the keyed shape above, keyed to the single value
                    // parameter.
                    let boundAddMethod IMethodSymbol? = this
                        .context
                        .SemanticModel
                        .GetCollectionInitializerSymbolInfo(element)
                        .Symbol as IMethodSymbol
                    var addMethod IMethodSymbol? = boundAddMethod
                    addMethod = if constructedType is not INamedTypeSymbol namedType || addMethod == nil {
                        addMethod
                    } else {
                        this.GetProjectedMember(namedType, addMethod) as IMethodSymbol ?? addMethod
                    }
                    var bareValue GExpression? = this.TranslateExpression(element)
                    if addMethod != nil && this.TryGetCollectionInitializerArgumentTarget(
                        element,
                        0,
                        addMethod,
                        boundAddMethod,
                        out var targetType,
                        out var targetParameter
                    ) {
                        bareValue = this.ForgiveInitializerElementValue(element, bareValue, targetType, targetParameter)
                    }
                    elements.Add(CollectionInitializerElement(bareValue))
                }
            }
            return elements
        }

        private func TryAnalyzeStructConstructor(
            ctorSymbol IMethodSymbol?,
            valueType INamedTypeSymbol?,
            out plan StructConstructorPlan?,
            out unsupportedReason string?
        ) bool {
            return this.TryAnalyzeStructConstructor(
                ctorSymbol,
                valueType,
                HashSet[IMethodSymbol](SymbolEqualityComparer.Default),
                out plan,
                out unsupportedReason
            )
        }

        private func TryAnalyzeStructConstructor(
            ctorSymbol IMethodSymbol?,
            valueType INamedTypeSymbol?,
            activeConstructors HashSet[IMethodSymbol],
            out plan StructConstructorPlan?,
            out unsupportedReason string?
        ) bool {
            plan = nil
            if ctorSymbol == nil || valueType == nil || ctorSymbol.MethodKind != MethodKind.Constructor {
                unsupportedReason = "the invoked struct constructor could not be resolved via the semantic model; " +
                    "a G# struct literal cannot be built safely (issue #1739; issue #2435)."
                return false
            }
            if !activeConstructors.Add(ctorSymbol.OriginalDefinition) {
                unsupportedReason = "struct constructor delegation is recursive; a G# struct literal cannot express it (issue #2435)."
                return false
            }
            try {
                if ctorSymbol
                    .DeclaringSyntaxReferences
                    .Length != 1 ||
                    ctorSymbol
                    .DeclaringSyntaxReferences[0]
                    .GetSyntax() is not Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ConstructorDeclarationSyntax ctorSyntax ||
                    ctorSyntax.Body == nil ||
                    ctorSyntax.ExpressionBody != nil {
                    unsupportedReason = "struct constructor is not a single block-bodied source constructor; " +
                        "a G# struct literal cannot express its logic (issue #1739; issue #2435)."
                    return false
                }
                if !this.TryGetStructConstructorSemanticModel(ctorSyntax, out var ctorModel) {
                    unsupportedReason = "struct constructor syntax belongs to no reachable compilation; " +
                        "its body cannot be analyzed for a G# struct literal (issue #1739; issue #2435)."
                    return false
                }
                let initializations = List[StructMemberInitialization]()
                let memberNames = HashSet[string](StringComparer.Ordinal)
                let parameterUseCounts = [ctorSymbol.Parameters.Length]int32
                if ctorSyntax.Initializer != nil {
                    if !ctorSyntax.Initializer!!.ThisOrBaseKeyword.IsKind(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.ThisKeyword
                    ) {
                        unsupportedReason = "struct constructor has a base-constructor initializer; " +
                            "a G# struct literal cannot express it (issue #2435)."
                        return false
                    }
                    let delegatedCtor IMethodSymbol? = ctorModel.GetSymbolInfo(ctorSyntax.Initializer!!)
                        .Symbol as IMethodSymbol
                    if !this.TryAnalyzeStructConstructor(
                        delegatedCtor,
                        valueType,
                        activeConstructors,
                        out var delegatedPlan,
                        out unsupportedReason
                    ) {
                        return false
                    }
                    let initializerArguments = ctorSyntax.Initializer!!.ArgumentList.Arguments
                    if initializerArguments.Any(
                        (a ArgumentSyntax) -> a.NameColon != nil || !a.RefKindKeyword.IsKind(
                            Microsoft.CodeAnalysis.CSharp.SyntaxKind.None
                        )
                    ) ||
                        initializerArguments.Count != delegatedCtor!!
                        .Parameters
                        .Length {
                        unsupportedReason = "struct constructor delegation uses named, ref/out/in, optional, or otherwise " +
                            "non-positional arguments; no canonical G# struct-literal lowering exists yet (issue #2435)."
                        return false
                    }
                    for delegatedInitialization in delegatedPlan!!.Initializations {
                        var remapped = delegatedInitialization
                        if delegatedInitialization.ParameterOrdinal is int32 delegatedOrdinal {
                            let argumentExpression = initializerArguments[delegatedOrdinal].Expression
                            if !this.TryClassifyStructInitializerValue(
                                argumentExpression,
                                ctorModel,
                                ctorSymbol,
                                out var parameterOrdinal,
                                out var fixedExpression,
                                out unsupportedReason
                            ) {
                                return false
                            }
                            remapped = if parameterOrdinal is int32 remappedOrdinal {
                                StructMemberInitialization(delegatedInitialization.MemberName, remappedOrdinal)
                            } else {
                                StructMemberInitialization(delegatedInitialization.MemberName, fixedExpression)
                            }
                        }
                        if !memberNames.Add(remapped.MemberName!!) {
                            unsupportedReason = "struct constructor initializes member '${remapped.MemberName}' more than once across " +
                                "constructor delegation; collapsing those writes into one struct-literal field could drop evaluation " +
                                "or side effects (issue #2435)."
                            return false
                        }
                        if remapped.ParameterOrdinal is int32 ordinal {
                            parameterUseCounts[ordinal]++
                        }
                        initializations.Add(remapped)
                    }
                }
                for statement in ctorSyntax.Body!!.Statements {
                    if statement is not Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ExpressionStatementSyntax exprStatement ||
                        exprStatement.Expression is not Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .AssignmentExpressionSyntax assignment ||
                        !assignment
                        .OperatorToken
                        .IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.EqualsToken) {
                        unsupportedReason = "struct constructor has a statement other than a plain member assignment; " +
                            "a G# struct literal cannot express its logic (issue #1739; issue #2435)."
                        return false
                    }
                    let leftSymbol ISymbol? = ctorModel.GetSymbolInfo(assignment.Left).Symbol
                    let memberName string? = switch leftSymbol {
                        case f is IFieldSymbol when !f.IsStatic && SymbolEqualityComparer.Default.Equals(
                            f.ContainingType,
                            valueType.OriginalDefinition
                        ): f.Name
                        case p is IPropertySymbol when !p.IsStatic && SymbolEqualityComparer.Default.Equals(
                            p.ContainingType,
                            valueType.OriginalDefinition
                        ): p.Name
                        default: default(string?)
                    }
                    if memberName == nil || !memberNames.Add(memberName) {
                        unsupportedReason = "struct constructor assignment does not target a unique instance field/property " +
                            "of the declaring struct; a G# struct literal cannot preserve it (issue #2435)."
                        return false
                    }
                    if !this.TryClassifyStructInitializerValue(
                        assignment.Right,
                        ctorModel,
                        ctorSymbol,
                        out var parameterOrdinal,
                        out var fixedExpression,
                        out unsupportedReason
                    ) {
                        return false
                    }
                    if parameterOrdinal is int32 ordinal {
                        parameterUseCounts[ordinal]++
                        initializations.Add(StructMemberInitialization(memberName, ordinal))
                    } else {
                        initializations.Add(StructMemberInitialization(memberName, fixedExpression))
                    }
                }
                if parameterUseCounts.Any((count int32) -> count != 1) {
                    unsupportedReason = "struct constructor does not consume every argument exactly once in a direct member " +
                        "assignment/delegation. Repeating an argument expression could duplicate side effects, while omitting it " +
                        "could drop evaluation; no canonical G# struct-literal lowering exists (issue #1739; issue #2435)."
                    return false
                }
                let declaredInstanceConstructorCount = ctorSymbol
                    .ContainingType
                    .InstanceConstructors
                    .Count((constructor IMethodSymbol) -> !constructor.DeclaringSyntaxReferences.IsEmpty)
                let fixedInitializersAreDeclaredOnType = declaredInstanceConstructorCount == 1 &&
                    ctorSyntax.Initializer == nil
                plan = StructConstructorPlan(ctorSymbol, initializations, fixedInitializersAreDeclaredOnType)
                unsupportedReason = nil
                return true
            } finally {
                activeConstructors.Remove(ctorSymbol.OriginalDefinition)
            }
        }

        private func TryGetStructConstructorSemanticModel(
            ctorSyntax Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax,
            out ctorModel SemanticModel?
        ) bool {
            if this.context.Compilation.ContainsSyntaxTree(ctorSyntax.SyntaxTree) {
                ctorModel = this.context.Compilation.GetSemanticModel(ctorSyntax.SyntaxTree)
                return true
            }
            let owningCompilation Compilation? = this
                .context
                .Compilation
                .References
                .OfType[CompilationReference]()
                .Select((reference CompilationReference) -> cast[Compilation](reference.Compilation))
                .FirstOrDefault((candidate Compilation) -> candidate.ContainsSyntaxTree(ctorSyntax.SyntaxTree))
            if owningCompilation != nil {
                ctorModel = owningCompilation.GetSemanticModel(ctorSyntax.SyntaxTree)
                return true
            }
            ctorModel = nil
            return false
        }

        private func TryClassifyStructInitializerValue(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            ctorModel SemanticModel?,
            ctorSymbol IMethodSymbol?,
            out parameterOrdinal int32?,
            out fixedExpression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            out unsupportedReason string?
        ) bool {
            let directSymbol ISymbol? = ctorModel.GetSymbolInfo(expression).Symbol
            if directSymbol is IParameterSymbol parameter && SymbolEqualityComparer.Default.Equals(
                parameter.ContainingSymbol.OriginalDefinition,
                ctorSymbol!!.OriginalDefinition
            ) {
                parameterOrdinal = parameter.Ordinal
                fixedExpression = nil
                unsupportedReason = nil
                return true
            }
            for descendant in expression.DescendantNodesAndSelf() {
                if descendant is ThisExpressionSyntax || descendant is BaseExpressionSyntax {
                    parameterOrdinal = nil
                    fixedExpression = nil
                    unsupportedReason = "struct constructor initializer expression reads the current instance; " +
                        "a G# struct literal has no constructor-body receiver (issue #2435)."
                    return false
                }
                if descendant is not SimpleNameSyntax simpleName {
                    continue
                }
                let symbol ISymbol? = ctorModel.GetSymbolInfo(simpleName).Symbol
                let isInstanceMember = switch symbol {
                    case field is IFieldSymbol: !field.IsStatic
                    case property is IPropertySymbol: !property.IsStatic
                    case method is IMethodSymbol: !method.IsStatic
                    case event is IEventSymbol: !event.IsStatic
                    default: false
                }
                if symbol is IParameterSymbol || symbol is ILocalSymbol || isInstanceMember {
                    parameterOrdinal = nil
                    fixedExpression = nil
                    unsupportedReason = "struct constructor initializer expression transforms a constructor parameter, local, " +
                        "or instance member instead of assigning a parameter directly. Re-evaluating it in a G# struct literal " +
                        "cannot be proven equivalent (issue #1739; issue #2435)."
                    return false
                }
            }
            parameterOrdinal = nil
            fixedExpression = expression
            unsupportedReason = nil
            return true
        }

        private func TryInstantiateStructConstructorPlan(
            plan StructConstructorPlan?,
            arguments IReadOnlyList[(ParameterOrdinal int32, Value GExpression?)],
            out fieldInitializers List[FieldInitializer]?,
            out unsupportedReason string?
        ) bool {
            fieldInitializers = List[FieldInitializer]()
            if arguments.Count != plan!!.Constructor!!.Parameters.Length {
                unsupportedReason = "translated constructor argument count does not match the resolved struct constructor; " +
                    "a G# struct literal cannot be built safely (issue #2435)."
                return false
            }
            let byParameterOrdinal = plan!!
                .Initializations
                .Where((initialization StructMemberInitialization) -> initialization.ParameterOrdinal != nil)
                .ToDictionary((initialization StructMemberInitialization) -> initialization.ParameterOrdinal!!)
            for (parameterOrdinal, argumentValue) in arguments {
                if !byParameterOrdinal.TryGetValue(parameterOrdinal, out var initialization) {
                    unsupportedReason = "struct constructor argument could not be matched to its initialized member; " +
                        "a G# struct literal cannot be built safely (issue #2435)."
                    fieldInitializers = nil
                    return false
                }
                fieldInitializers!!.Add(
                    FieldInitializer(
                        this.EmittedName(
                            plan!!.Constructor!!
                                .ContainingType
                                .GetMembers(initialization.MemberName!!)
                                .FirstOrDefault(),
                            initialization.MemberName
                        ),
                        argumentValue
                    )
                )
            }
            for initialization in plan!!.Initializations {
                if initialization.ParameterOrdinal != nil || plan!!.FixedInitializersAreDeclaredOnType {
                    continue
                }
                let fixedExpression Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ExpressionSyntax? = initialization.FixedExpression
                if !this.context.Compilation.ContainsSyntaxTree(fixedExpression!!.SyntaxTree) {
                    unsupportedReason = "a source struct constructor in another compilation contains a fixed initializer " +
                        "expression; that expression cannot yet be rebound safely at this call site (issue #2435)."
                    fieldInitializers = nil
                    return false
                }
                using let modelScope = this.context.UseSemanticModelFor(fixedExpression!!.SyntaxTree)
                let value GExpression? = this.TranslateExpression(fixedExpression)
                fieldInitializers!!.Add(
                    FieldInitializer(
                        this.EmittedName(
                            plan!!.Constructor!!
                                .ContainingType
                                .GetMembers(initialization.MemberName!!)
                                .FirstOrDefault(),
                            initialization.MemberName
                        ),
                        value
                    )
                )
            }
            unsupportedReason = nil
            return true
        }

        private func TranslateCast(cast CastExpressionSyntax) GExpression {
            // C# explicit casts map to G# explicit conversions (ADR-0115 §B.17
            // and ADR-0167). Numeric/value conversions retain `T(expr)`.
            // Reference casts use constructor-independent `cast[T](expr)` so a
            // target class's applicable one-argument constructor cannot change
            // cast semantics.
            let targetSymbol ITypeSymbol? = this.context.GetTypeInfo(cast.Type).Type
            let sourceSymbol ITypeSymbol? = this.context.GetTypeInfo(cast.Expression).Type
            var targetType GTypeReference? = if targetSymbol != nil {
                this.typeMapper.Map(targetSymbol, this.context, cast.Type.GetLocation())
            } else {
                cast[GTypeReference](NamedTypeReference(cast.Type.ToString()))
            }
            if targetSymbol is INamedTypeSymbol delegateTarget && delegateTarget.TypeKind == TypeKind.Delegate {
                targetType = this.typeMapper.MapNominalDelegate(delegateTarget, this.context, cast.Type.GetLocation())
            }
            if StripParentheses(cast.Expression).IsKind(
                Microsoft.CodeAnalysis.CSharp.SyntaxKind.NullLiteralExpression
            ) &&
                (targetSymbol != nil && targetSymbol.IsReferenceType == true || targetType!!.IsNullable) {
                // Typed null keeps overload selection without an unparseable
                // conversion such as `[]char(nil)` or `Guid?(nil)`.
                let defaultType GTypeReference? = if cast.Type is NullableTypeSyntax && !targetType!!.IsNullable {
                    MakeNullable(targetType)
                } else {
                    targetType
                }
                return DefaultValueExpression(defaultType)
            }
            var operand GExpression? = this.TranslateExpression(cast.Expression)
            let conversion = if sourceSymbol == nil || targetSymbol == nil {
                default(Conversion)
            } else {
                this.context.Compilation.ClassifyConversion(sourceSymbol, targetSymbol)
            }
            if !(cast.Type is NullableTypeSyntax) && this.CastUsesCheckedReferenceConversion(cast) &&
                this.IsFlowNarrowedAnnotatedReference(cast.Expression) {
                operand = EnsureNonNullAssertion(operand)
            }
            // Issue #4356: an operand that is `T?` only on the G# analyzer API
            // (`(SyntaxToken)parameter.Identifier`, `(object)operation.Syntax`).
            // Roslyn sees an identity/reference conversion from a non-null value;
            // G# sees `T?` converted to a non-null type, so assert the operand —
            // the same bridge every other value position takes.
            if !(cast.Type is NullableTypeSyntax) && this.AnalyzerBridgeTargetIsNonNull(targetSymbol) &&
                this.IsGSharpNullableAnalyzerExpression(cast.Expression) {
                operand = EnsureNonNullAssertion(operand)
            }
            if conversion.IsBoxing {
                let boxingTargetType GTypeReference? = if cast.Type is NullableTypeSyntax && !targetType!!.IsNullable {
                    MakeNullable(targetType)
                } else {
                    targetType
                }
                let useUnambiguousCast = targetSymbol?.SpecialType != SpecialType.System_Object
                return ConversionExpression(boxingTargetType, operand, useUnambiguousCast)
            }
            // Preserve explicit class/interface-to-object casts when they
            // supply a surrounding expression's common type, such as
            // `(object?)text ?? DBNull.Value`. Dropping the upcast leaves
            // incompatible operands in G# even though the C# expression is
            // object-typed. G# accepts the canonical `object(expr)` /
            // `object?(expr)` conversion form for these upcasts.
            if targetSymbol?.SpecialType == SpecialType.System_Object &&
                sourceSymbol != nil &&
                sourceSymbol.IsReferenceType == true {
                let objectTargetType GTypeReference? = if cast.Type is NullableTypeSyntax && !targetType!!.IsNullable {
                    MakeNullable(targetType)
                } else {
                    targetType
                }
                return ConversionExpression(objectTargetType, operand)
            }
            // Issue #3843: a C# reference cast over a NULLABLE operand stays
            // `cast[T](expr)`. It used to lower to the null-preserving safe
            // cast `expr as T` (issue #3501/#3567), on the premise that
            // `cast[T]` required a non-null operand — a premise that was only
            // ever true for the UPCAST direction, and is no longer true at all
            // (ADR-0167; `Conversion.HasCheckedReferenceConversion` now admits
            // the nullable-source widening too). `as` was the wrong rendering
            // twice over: its `T?` result made a `Select(cast).Where(x => x !=
            // nil).OrderBy(...)` chain emit a nullable element type into a
            // non-nullable continuation, and — the silent half — it turned a
            // wrong-type cast from a throw into a nil. `cast[T]` matches C#
            // `(T)x` exactly: nil in → nil out, wrong type → InvalidCastException,
            // static result non-nullable.
            let conversionTargetType GTypeReference? = if cast.Type is NullableTypeSyntax && !targetType!!.IsNullable {
                MakeNullable(targetType)
            } else {
                targetType
            }
            // Issue #3907: a TUPLE target has no `T(expr)` spelling. That form
            // renders as `(TaskArm, SelectWaiter)(state)`, which G# reads as a
            // call on a parenthesized expression rather than a conversion —
            // `((TaskArm, SelectWaiter))state!` in ArmDescriptor.cs came out as
            // eight "variable doesn't exist" errors. `cast[(A, B)](expr)` is the
            // only form that binds, and it is what the unambiguous flag emits.
            // Issue #4350: native slice types are not identifier/generic call
            // heads, so `slice[T]?(value)` does not parse as a conversion call.
            // The intrinsic form accepts any type clause and preserves the
            // explicit nullable value conversion.
            let unambiguous = this.CastUsesCheckedReferenceConversion(cast) ||
                targetSymbol is INamedTypeSymbol &&
                targetSymbol.IsTupleType == true ||
                conversionTargetType is NativeSliceTypeReference ||
                conversionTargetType is ManagedReferenceTypeReference
            return ConversionExpression(conversionTargetType, operand, unambiguous)
        }

        private func CastUsesCheckedReferenceConversion(cast CastExpressionSyntax) bool {
            let target ITypeSymbol? = this.context.GetTypeInfo(cast.Type).Type
            let source ITypeSymbol? = this.context.GetTypeInfo(cast.Expression).Type
            let conversion = if source == nil || target == nil {
                default(Conversion)
            } else {
                this.context.Compilation.ClassifyConversion(source, target)
            }
            return conversion.IsReference ||
                (
                conversion.IsIdentity &&
                    (source != nil && source.IsReferenceType == true) &&
                    (target != nil && target.IsReferenceType == true)
            ) ||
                (conversion.IsExplicit && source is ITypeParameterSymbol && target?.TypeKind == TypeKind.Interface) ||
                (source?.TypeKind == TypeKind.Dynamic && (target != nil && target.IsReferenceType == true))
        }

        private func TranslateWith(with Microsoft.CodeAnalysis.CSharp.Syntax.WithExpressionSyntax) GExpression {
            // C# `expr with { Field = value, ... }` maps to the canonical G#
            // copy/update form `expr with { Field = value, ... }` for data
            // structs / data classes (spec §Struct literals; ADR-0115 §B.4). The
            // update fields keep `=` (distinct from the `:` of a struct literal).
            let updates = List[FieldInitializer]()
            for element in with.Initializer.Expressions {
                if element is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .AssignmentExpressionSyntax assignment &&
                    assignment.Left is IdentifierNameSyntax name {
                    updates.Add(
                        FieldInitializer(
                            this.EmittedName(name, name.Identifier),
                            this.TranslateExpression(assignment.Right)
                        )
                    )
                } else {
                    this.context.ReportUnsupported(
                        element,
                        "with-expression element is not a simple `Field = value` assignment; no canonical G# copy/update form yet (ADR-0115 §B.4)."
                    )
                }
            }
            return WithExpression(this.TranslateExpression(with.Expression), updates)
        }

        private func MapTypeArguments(generic GenericNameSyntax) IReadOnlyList[GTypeReference] {
            // Issue #2500: an individual NullableTypeSyntax can bind as its
            // underlying type parameter and lose the explicit annotation.
            // Prefer the constructed method/type symbol, whose TypeArguments
            // retain nullability recursively for every semantic type shape.
            var boundTypeArguments = this.GetBoundTypeArguments(generic)
            if GetContainingInvocation(generic) is {} invocation && this.TryGetManagedReferenceArrayProjectedMethod(
                invocation,
                out var projectedMethod
            ) {
                boundTypeArguments = projectedMethod!!.TypeArguments
            }
            let result = List[GTypeReference]()
            for var i = 0; i < generic.TypeArgumentList.Arguments.Count; i++ {
                let argument = generic.TypeArgumentList.Arguments[i]
                let symbol ITypeSymbol? = if i < boundTypeArguments.Length {
                    boundTypeArguments[i]
                } else {
                    this.context.GetTypeInfo(argument).Type
                }
                // Issue #4113: an explicit type argument (`Assert.IsType<EventHandler>(x)`)
                // is, like a variable's declared type, an EXPLICITLY WRITTEN source
                // type — MapExplicitType's named-CLR-delegate-identity rule
                // (issue #2835/#3841) applies here for the same reason: the general
                // Map() pipeline's structural-arrow canonicalization silently
                // rewrote `IsType<EventHandler>` into `IsType<Action<object,
                // EventArgs>>`, a different runtime type, defeating exactly the
                // identity check the call was making.
                result.Add(
                    if symbol != nil {
                        this.typeMapper.MapExplicitType(symbol, this.context, argument.GetLocation())
                    } else {
                        cast[GTypeReference](NamedTypeReference(argument.ToString()))
                    }
                )
            }
            return result
        }

        // Issue #4525: project the callable through the nullable managed-reference
        // type arguments G# requires for array storage. This covers method and
        // containing-type parameters for invocations and constructions.
        private func TryGetManagedReferenceArrayProjectedMethod(
            call Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            out projected IMethodSymbol?
        ) bool {
            if this
                .state
                .ManagedReferenceArrayNullable
                .ManagedReferenceArrayProjectedMethodByCall
                .TryGetValue(call, out projected) {
                return projected != nil
            }
            projected = nil
            if this.context.GetSymbolInfo(call).Symbol is not IMethodSymbol method {
                this.state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedMethodByCall.Add(call, nil)
                return false
            }
            if !CSharpToGSharpTranslator.MethodMayRequireManagedReferenceArrayProjection(
                method,
                this.context.Compilation
            ) {
                this.state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedMethodByCall.Add(call, nil)
                return false
            }
            // Cache an in-progress sentinel before inspecting arguments and
            // local initializer/member flows, which can refer back to this call.
            this.state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedMethodByCall.Add(call, nil)
            this.state.ManagedReferenceArrayProjectedCallsInProgress.Add(call)
            let Complete = func (result bool) bool {
                this.state.ManagedReferenceArrayProjectedCallsInProgress.Remove(call)
                if !result {
                    this.DiscardDependentManagedReferenceArrayProjections(call)
                }
                return result
            }
            var projectedReceiver INamedTypeSymbol? = nil
            var typeReceiverCanProject = false
            if call is InvocationExpressionSyntax{Expression: MemberAccessExpressionSyntax receiverMember} {
                if this.GetManagedReferenceArrayProjectedExpressionType(
                    receiverMember.Expression
                ) is INamedTypeSymbol receiverType &&
                    ReceiverTypeHierarchy(receiverType).FirstOrDefault(
                    (candidate INamedTypeSymbol) -> SymbolEqualityComparer.Default.Equals(
                        candidate.OriginalDefinition,
                        method.ContainingType?.OriginalDefinition
                    )
                ) is {} matchingReceiverType {
                    projectedReceiver = matchingReceiverType
                } else if this
                    .context
                    .GetSymbolInfo(receiverMember.Expression)
                    .Symbol is INamedTypeSymbol receiverNamedType &&
                    ReceiverTypeHierarchy(receiverNamedType).Any(
                    (candidate INamedTypeSymbol) -> SymbolEqualityComparer.Default.Equals(
                        candidate.OriginalDefinition,
                        method.ContainingType?.OriginalDefinition
                    )
                ) {
                    typeReceiverCanProject = true
                }
            }
            let canProjectContainingTypeFromArguments = projectedReceiver != nil ||
                typeReceiverCanProject ||
                (
                call is BaseObjectCreationExpressionSyntax objectCreation &&
                    this.ObjectCreationCanProjectContainingType(objectCreation)
            )
            let projectedMethodArguments = NullableTypeSymbolSlots(method.TypeArguments.Length)
            let observedMethodArguments = NullableTypeSymbolSlots(method.TypeArguments.Length)
            let observedMethodArgumentsRequireExactMatch = [method.TypeArguments.Length]bool
            let containingTypes = if method.ContainingType == nil {
                ImmutableArray[INamedTypeSymbol].Empty
            } else {
                NamedTypeAndContainingTypes(method.ContainingType).ToImmutableArray()
            }
            let containingTypeArguments = containingTypes.SelectMany(
                func (type INamedTypeSymbol) IEnumerable[ITypeSymbol] {
                    return type.TypeArguments
                }
            )
                .ToImmutableArray()
            let containingTypeParameters = containingTypes.SelectMany(
                func (type INamedTypeSymbol) IEnumerable[ITypeParameterSymbol] {
                    return type.OriginalDefinition.TypeParameters
                }
            )
                .ToImmutableArray()
            let projectedContainingArguments = NullableTypeSymbolSlots(containingTypeArguments.Length)
            let observedContainingArguments = NullableTypeSymbolSlots(containingTypeArguments.Length)
            let observedContainingArgumentsRequireExactMatch = [containingTypeArguments.Length]bool
            var blockedParameter ITypeParameterSymbol? = nil
            var conflictingParameter ITypeParameterSymbol? = nil
            var conflictInvolvesManagedReference = false
            var fixedStorageNeedsNullableArgument = false
            let RecordWidenedTypeParameters = func (
                typeArguments ImmutableArray[ITypeSymbol],
                typeParameters ImmutableArray[ITypeParameterSymbol],
                projectedArguments NullableTypeSymbolSlots,
                observedArguments NullableTypeSymbolSlots,
                observedArgumentsRequireExactMatch[]bool,
                parameterType ITypeSymbol?,
                argumentType ITypeSymbol?,
                apply bool,
                nullableArrayArgument bool = false,
                requiresExactMatch bool = false,
                observedValueWins bool = false
            ) bool {
                var needsProjection = false
                for var i = 0; i < projectedArguments.Length; i++ {
                    let hasProjectedArgument = TryGetProjectedTypeArgument(
                        parameterType,
                        argumentType,
                        typeParameters[i],
                        this.context.Compilation,
                        out var projectedArgument,
                        out var argumentProjectionConflict
                    )
                    if argumentProjectionConflict {
                        conflictingParameter ??= typeParameters[i]
                        conflictInvolvesManagedReference |= CSharpToGSharpTranslator.TypeContainsRecognizedManagedReferenceConsumer(
                            typeArguments[i],
                            this.context.Compilation
                        ) ||
                            CSharpToGSharpTranslator.TypeContainsRecognizedManagedReferenceConsumer(
                            argumentType,
                            this.context.Compilation
                        )
                        continue
                    }
                    if !CSharpToGSharpTranslator.TypeContainsRecognizedManagedReferenceConsumer(
                        typeArguments[i],
                        this.context.Compilation
                    ) ||
                        (
                        !hasProjectedArgument &&
                            (!nullableArrayArgument || !TypeContainsTypeParameter(parameterType, typeParameters[i]))
                    ) {
                        continue
                    }
                    if !hasProjectedArgument {
                        projectedArgument = typeArguments[i]
                    }
                    var effectiveProjectedArgument ITypeSymbol? = projectedArgument
                    if !(effectiveProjectedArgument is IArrayTypeSymbol) &&
                        nullableArrayArgument &&
                        (
                        !hasProjectedArgument || SymbolEqualityComparer.IncludeNullability.Equals(
                            typeArguments[i],
                            effectiveProjectedArgument
                        )
                    ) {
                        effectiveProjectedArgument = effectiveProjectedArgument!!.WithNullableAnnotation(
                            Microsoft.CodeAnalysis.NullableAnnotation.Annotated
                        )
                    }
                    if apply && observedArguments.HasValue(i) && !SymbolEqualityComparer.IncludeNullability.Equals(
                        observedArguments.GetValue(i),
                        effectiveProjectedArgument
                    ) &&
                        (
                        requiresExactMatch ||
                            observedArgumentsRequireExactMatch[i] ||
                            !ProjectionTypeFitsDestination(effectiveProjectedArgument, observedArguments.GetValue(i))
                    ) {
                        if observedValueWins {
                            continue
                        }
                        conflictingParameter ??= typeParameters[i]
                        conflictInvolvesManagedReference |= CSharpToGSharpTranslator.TypeContainsRecognizedManagedReferenceConsumer(
                            typeArguments[i],
                            this.context.Compilation
                        ) ||
                            CSharpToGSharpTranslator.TypeContainsRecognizedManagedReferenceConsumer(
                            argumentType,
                            this.context.Compilation
                        )
                        continue
                    }
                    if apply {
                        if !observedArguments.HasValue(i) {
                            observedArguments.SetValue(i, effectiveProjectedArgument!!)
                        }
                        observedArgumentsRequireExactMatch[i] |= requiresExactMatch
                    }
                    if SymbolEqualityComparer.IncludeNullability.Equals(typeArguments[i], effectiveProjectedArgument) {
                        continue
                    }
                    needsProjection = true
                    if !apply {
                        continue
                    }
                    if effectiveProjectedArgument!!.NullableAnnotation == Microsoft
                        .CodeAnalysis
                        .NullableAnnotation
                        .Annotated &&
                        NullableTypeArgumentViolatesTranslatedConstraints(typeParameters[i]) {
                        blockedParameter ??= typeParameters[i]
                        continue
                    }
                    projectedArguments.SetValue(i, effectiveProjectedArgument!!)
                }
                return needsProjection
            }
            let RecordWidenedArguments = func (
                argument Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
                parameterType ITypeSymbol?
            ) {
                var argument = argument
                argument = Unparenthesize(argument)
                if argument is TupleExpressionSyntax tuple &&
                    parameterType is INamedTypeSymbol{IsTupleType: true} parameterTuple &&
                    tuple
                    .Arguments
                    .Count == parameterTuple
                    .TupleElements
                    .Length {
                    for var i = 0; i < tuple.Arguments.Count; i++ {
                        RecordWidenedArguments(tuple.Arguments[i].Expression, parameterTuple.TupleElements[i].Type)
                    }
                    return
                }
                if argument is Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalExpressionSyntax conditional {
                    RecordWidenedArguments(conditional.WhenTrue, parameterType)
                    RecordWidenedArguments(conditional.WhenFalse, parameterType)
                    return
                }
                if argument is Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionSyntax switchExpression {
                    for arm in switchExpression.Arms {
                        RecordWidenedArguments(arm.Expression, parameterType)
                    }
                    return
                }
                if argument is AnonymousFunctionExpressionSyntax lambda {
                    if GetDelegateInvokeMethod(parameterType) is {ReturnsVoid: false} invoke &&
                        GetLambdaResultTargetType(lambda, invoke) is {} lambdaResultType {
                        for result in GetLambdaResultExpressions(lambda) {
                            RecordWidenedArguments(result, lambdaResultType)
                        }
                    }
                    return
                }
                var requiresExactMatch = false
                if argument!!.Parent is ArgumentSyntax argumentSyntax && this.TryGetMethodGroupArgument(
                    argumentSyntax,
                    out var methodGroup,
                    out _,
                    out _
                ) {
                    requiresExactMatch = !methodGroup!!.IsGenericMethod &&
                        methodGroup!!
                        .ContainingType
                        ?.IsGenericType != true
                }
                let argumentType ITypeSymbol? = this.GetManagedReferenceArrayProjectedArgumentType(argument)
                let nullableArrayArgument = this.ArrayExpressionHasNullableElement(argument) ||
                    this.IsNullableArrayElementAccess(argument)
                RecordWidenedTypeParameters(
                    method.TypeArguments,
                    method.TypeParameters,
                    projectedMethodArguments,
                    observedMethodArguments,
                    observedMethodArgumentsRequireExactMatch,
                    parameterType,
                    argumentType,
                    apply: true,
                    nullableArrayArgument,
                    requiresExactMatch
                )
                if method.ContainingType != nil {
                    let needsContainingProjection = RecordWidenedTypeParameters(
                        containingTypeArguments,
                        containingTypeParameters,
                        projectedContainingArguments,
                        observedContainingArguments,
                        observedContainingArgumentsRequireExactMatch,
                        parameterType,
                        argumentType,
                        canProjectContainingTypeFromArguments,
                        nullableArrayArgument,
                        requiresExactMatch
                    )
                    fixedStorageNeedsNullableArgument |= needsContainingProjection &&
                        !canProjectContainingTypeFromArguments
                }
            }
            let RecordContainingTypeArguments = func (
                consumer IMethodSymbol,
                consumerArguments ImmutableArray[IArgumentOperation]
            ) {
                if consumer.ContainingType == nil {
                    return
                }
                for argument in consumerArguments {
                    if argument.Syntax is ArgumentSyntax argumentSyntax &&
                        argument
                        .Parameter
                        ?.OriginalDefinition
                        .Type is {} parameterType {
                        RecordContainingTypeArgument(consumer.ContainingType, parameterType, argumentSyntax.Expression)
                    }
                }
            }
            let RecordContainingTypeArgument = func (
                consumerContainingType INamedTypeSymbol?,
                consumerType ITypeSymbol,
                argument Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
            ) {
                if method.ContainingType == nil || !SymbolEqualityComparer.Default.Equals(
                    method.ContainingType.OriginalDefinition,
                    consumerContainingType!!.OriginalDefinition
                ) {
                    return
                }
                RecordWidenedTypeParameters(
                    containingTypeArguments,
                    NamedTypeAndContainingTypes(consumerContainingType).SelectMany(
                        func (type INamedTypeSymbol) IEnumerable[ITypeParameterSymbol] {
                            return type.OriginalDefinition.TypeParameters
                        }
                    )
                        .ToImmutableArray(),
                    projectedContainingArguments,
                    observedContainingArguments,
                    observedContainingArgumentsRequireExactMatch,
                    consumerType,
                    this.GetManagedReferenceArrayProjectedArgumentType(argument),
                    apply: true,
                    this.ArrayExpressionHasNullableElement(argument),
                    requiresExactMatch: false
                )
            }
            let RecordInitializerConsumers = func (initializer InitializerExpressionSyntax, consumerType ITypeSymbol) {
                if consumerType is IArrayTypeSymbol arrayType {
                    for assignment in initializer
                        .Expressions
                        .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax]() {
                        RecordWidenedArguments(assignment.Right, arrayType.ElementType)
                    }
                    return
                }
                if consumerType is not INamedTypeSymbol namedConsumerType {
                    return
                }
                for element in initializer.Expressions {
                    if initializer.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.CollectionInitializerExpression) {
                        let boundAddMethod IMethodSymbol? = this
                            .context
                            .SemanticModel
                            .GetCollectionInitializerSymbolInfo(element)
                            .Symbol as IMethodSymbol
                        let addMethod IMethodSymbol? = if boundAddMethod == nil {
                            default(IMethodSymbol?)
                        } else {
                            this.GetProjectedMember(namedConsumerType, boundAddMethod) as IMethodSymbol ??
                                boundAddMethod
                        }
                        let values IReadOnlyList[
                            Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
                        ] = if element is InitializerExpressionSyntax complex &&
                            element.IsKind(
                            Microsoft.CodeAnalysis.CSharp.SyntaxKind.ComplexElementInitializerExpression
                        ) {
                            complex.Expressions
                        } else {
                            cast[IReadOnlyList[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax]](
                                []Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax{element}
                            )
                        }
                        for var i = 0; addMethod != nil && i < values.Count; i++ {
                            if !this.TryGetCollectionInitializerArgumentTarget(
                                values[i],
                                i,
                                addMethod,
                                boundAddMethod,
                                out var parameterType,
                                out _
                            ) {
                                break
                            }
                            RecordWidenedArguments(values[i], parameterType)
                        }
                        continue
                    }
                    if element is not Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax assignment {
                        continue
                    }
                    var member ISymbol? = this.context.GetSymbolInfo(assignment.Left).Symbol
                    member = if member == nil {
                        default(ISymbol?)
                    } else {
                        this.GetProjectedMember(namedConsumerType, member) ?? member
                    }
                    let memberType ITypeSymbol? = switch member {
                        case field is IFieldSymbol: field.Type
                        case property is IPropertySymbol: property.Type
                        default: default(ITypeSymbol?)
                    }
                    if memberType == nil {
                        continue
                    }
                    if assignment.Right is InitializerExpressionSyntax nested {
                        RecordInitializerConsumers(nested, memberType)
                    } else {
                        RecordWidenedArguments(assignment.Right, memberType)
                    }
                }
            }
            let arguments = switch this.context.SemanticModel.GetOperation(call) {
                case invocation is IInvocationOperation: invocation.Arguments
                case creation is IObjectCreationOperation: creation.Arguments
                default: default(ImmutableArray[IArgumentOperation])
            }
            let syntaxArguments = switch call {
                case invocation is InvocationExpressionSyntax: invocation.ArgumentList.Arguments
                case creation is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ObjectCreationExpressionSyntax: creation
                    .ArgumentList
                    ?.Arguments ??
                    default(Microsoft.CodeAnalysis.SeparatedSyntaxList[ArgumentSyntax])
                case creation is ImplicitObjectCreationExpressionSyntax: creation.ArgumentList.Arguments
                default: default(Microsoft.CodeAnalysis.SeparatedSyntaxList[ArgumentSyntax])
            }
            for argument in syntaxArguments {
                let parameter IParameterSymbol? = this.GetArgumentParameter(argument, method)
                if parameter == nil {
                    continue
                }
                var parameterType = parameter.OriginalDefinition.Type
                if this.TryGetExpandedParamsElementTarget(argument, parameter, out _, out _) {
                    parameterType = switch parameter.OriginalDefinition.Type {
                        case paramsArray is IArrayTypeSymbol: paramsArray.ElementType
                        case INamedTypeSymbol{
                            TypeArguments: {Length: 1}
                        } paramsCollection: paramsCollection.TypeArguments[0]
                        default: parameterType
                    }
                }
                RecordWidenedArguments(argument.Expression, parameterType)
            }
            if method.IsGenericMethod && CSharpToGSharpTranslator.TypeContainsRecognizedManagedReferenceArray(
                method.ReturnType,
                this.context.Compilation
            ) {
                RecordWidenedTypeParameters(
                    method.TypeArguments,
                    method.TypeParameters,
                    projectedMethodArguments,
                    observedMethodArguments,
                    observedMethodArgumentsRequireExactMatch,
                    method.OriginalDefinition.ReturnType,
                    method.ReturnType,
                    apply: true,
                    nullableArrayArgument: true,
                    observedValueWins: true
                )
            }
            if method.ContainingType != nil && CSharpToGSharpTranslator.TypeContainsRecognizedManagedReferenceArray(
                method.ReturnType,
                this.context.Compilation
            ) {
                let needsContainingProjection = RecordWidenedTypeParameters(
                    containingTypeArguments,
                    containingTypeParameters,
                    projectedContainingArguments,
                    observedContainingArguments,
                    observedContainingArgumentsRequireExactMatch,
                    method.OriginalDefinition.ReturnType,
                    method.ReturnType,
                    canProjectContainingTypeFromArguments,
                    nullableArrayArgument: true
                )
                fixedStorageNeedsNullableArgument |= needsContainingProjection && !canProjectContainingTypeFromArguments
            }
            if call is BaseObjectCreationExpressionSyntax creationSyntax &&
                canProjectContainingTypeFromArguments &&
                containingTypeArguments
                .Any(
                (argument ITypeSymbol) -> CSharpToGSharpTranslator.TypeContainsRecognizedManagedReferenceConsumer(
                    argument,
                    this.context.Compilation
                )
            ) == true &&
                this.TryGetInferredLocalInitializedBy(creationSyntax, out var local) &&
                this
                .state
                .CurrentBodyScope is {} body {
                for consumer in this.GetProjectionConsumers(body, local) {
                    if consumer.SpanStart <= creationSyntax.SpanStart {
                        continue
                    }
                    if consumer is InvocationExpressionSyntax laterCall &&
                        this
                        .context
                        .SemanticModel
                        .GetOperation(laterCall) is IInvocationOperation laterInvocation {
                        RecordContainingTypeArguments(laterInvocation.TargetMethod, laterInvocation.Arguments)
                        continue
                    }
                    if consumer is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .AssignmentExpressionSyntax assignment &&
                        assignment
                        .IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.SimpleAssignmentExpression) {
                        var member ISymbol? = this.context.GetSymbolInfo(assignment.Left).Symbol
                        if member == nil {
                            let operation IOperation? = this.context.SemanticModel.GetOperation(assignment.Left)
                            if operation is IFieldReferenceOperation field {
                                member = field.Field
                            } else if operation is IPropertyReferenceOperation property {
                                member = property.Property
                            }
                        }
                        if member is IFieldSymbol fieldMember {
                            RecordContainingTypeArgument(
                                fieldMember.ContainingType,
                                fieldMember.OriginalDefinition.Type,
                                assignment.Right
                            )
                        } else if member is IPropertySymbol propertyMember {
                            RecordContainingTypeArgument(
                                propertyMember.ContainingType,
                                propertyMember.OriginalDefinition.Type,
                                assignment.Right
                            )
                        }
                    }
                }
            }
            if call is BaseObjectCreationExpressionSyntax creationWithInitializer &&
                canProjectContainingTypeFromArguments &&
                creationWithInitializer.Initializer is {} initializer {
                RecordInitializerConsumers(initializer, method.ContainingType.OriginalDefinition)
            }
            if call is InvocationExpressionSyntax invocationCall &&
                method.MethodKind == MethodKind.ReducedExtension &&
                invocationCall.Expression is MemberAccessExpressionSyntax reducedMember &&
                method
                .ReducedFrom
                ?.OriginalDefinition is {} reducedDefinition &&
                reducedDefinition
                .Parameters
                .FirstOrDefault()
                ?.Type is {} receiverParameterType {
                RecordWidenedTypeParameters(
                    method.TypeArguments,
                    reducedDefinition.TypeParameters,
                    projectedMethodArguments,
                    observedMethodArguments,
                    observedMethodArgumentsRequireExactMatch,
                    receiverParameterType,
                    this.GetManagedReferenceArrayProjectedArgumentType(reducedMember.Expression),
                    apply: true,
                    this.ArrayExpressionHasNullableElement(reducedMember.Expression),
                    requiresExactMatch: false
                )
            }
            if conflictingParameter != nil && !conflictInvolvesManagedReference {
                return Complete(false)
            }
            if conflictingParameter != nil {
                this.context.ReportUnsupported(
                    call,
                    "managed-reference array widening found conflicting argument types for type parameter '${conflictingParameter.Name}'; no exact G# translation exists."
                )
                return Complete(false)
            }
            if blockedParameter != nil {
                let message = "managed-reference array widening requires nullable type parameter '${blockedParameter.Name}', " +
                    "but its translated constraints do not admit nullable type arguments; no exact G# translation exists."
                this.context.ReportUnsupported(call, message)
                return Complete(false)
            }
            var projectedContainingType INamedTypeSymbol? = projectedReceiver
            if projectedContainingArguments.HasAnyValue {
                let replacements = Dictionary[ITypeParameterSymbol, ITypeSymbol](SymbolEqualityComparer.Default)
                for var i = 0; i < projectedContainingArguments.Length; i++ {
                    if projectedContainingArguments.HasValue(i) {
                        replacements.Add(containingTypeParameters[i], projectedContainingArguments.GetValue(i))
                    }
                }
                projectedContainingType = ProjectNamedType(
                    projectedContainingType ?? method.ContainingType,
                    replacements
                )
            }
            var projectedMethod IMethodSymbol? = method
            if projectedContainingType != nil {
                projectedMethod = this.GetProjectedMember(projectedContainingType, method) as IMethodSymbol
                if projectedMethod == nil {
                    this.context.ReportUnsupported(
                        call,
                        "could not project member '${method.Name}' through translated containing type '$projectedContainingType'."
                    )
                    return Complete(false)
                }
            }
            if method.IsGenericMethod && (projectedContainingType != nil || projectedMethodArguments.HasAnyValue) {
                let typeArguments = method.TypeArguments.ToArray()
                for var i = 0; i < typeArguments.Length; i++ {
                    if projectedMethodArguments.HasValue(i) {
                        typeArguments[i] = projectedMethodArguments.GetValue(i)
                    }
                }
                projectedMethod = projectedMethod!!.ConstructedFrom.Construct(typeArguments)
            }
            if !this.ProjectedCallableResultsMatch(call, projectedMethod, out var incompatibleCallableParameter) {
                let message = "managed-reference array widening changes callback return storage for parameter " +
                    "'${incompatibleCallableParameter!!.Name}', but its delegate return type is fixed; no exact G# translation exists."
                this.context.ReportUnsupported(call, message)
                return Complete(false)
            }
            if !this.ProjectedByRefArgumentsMatch(call, projectedMethod, out var incompatibleByRefParameter) {
                let message = "managed-reference array widening changes by-reference storage for parameter " +
                    "'${incompatibleByRefParameter!!.Name}', but the caller cannot adopt " +
                    "the projected nullable type; no exact G# translation exists."
                this.context.ReportUnsupported(call, message)
                return Complete(false)
            }
            let originalResultType ITypeSymbol? = if call is BaseObjectCreationExpressionSyntax {
                (method.ContainingType as ITypeSymbol)
            } else {
                method.ReturnType
            }
            let projectedResultType ITypeSymbol? = if call is BaseObjectCreationExpressionSyntax {
                (projectedMethod!!.ContainingType as ITypeSymbol)
            } else {
                projectedMethod!!.ReturnType
            }
            if !SymbolEqualityComparer.IncludeNullability.Equals(originalResultType, projectedResultType) &&
                !this
                .ProjectedResultMatchesDestination(call, projectedResultType, out var destinationType) {
                let message = "managed-reference array widening cannot change fixed destination storage " +
                    "'$destinationType'; no exact G# translation exists."
                this.context.ReportUnsupported(call, message)
                return Complete(false)
            }
            if fixedStorageNeedsNullableArgument {
                let storageKind = if call is BaseObjectCreationExpressionSyntax {
                    "destination"
                } else {
                    "receiver"
                }
                let message = "managed-reference array widening cannot change fixed $storageKind storage " +
                    "'${method.ContainingType}'; a nil argument has no exact G# translation."
                this.context.ReportUnsupported(call, message)
                return Complete(false)
            }
            if projectedContainingType != nil || projectedMethodArguments.HasAnyValue {
                projected = projectedMethod
            }
            this.state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedMethodByCall[call] = projected
            return Complete(projected != nil)
        }

        private func ProjectedCallableResultsMatch(
            call Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            projectedMethod IMethodSymbol?,
            out incompatibleParameter IParameterSymbol?
        ) bool {
            incompatibleParameter = nil
            let arguments = switch call {
                case invocation is InvocationExpressionSyntax: invocation.ArgumentList.Arguments
                case creation is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ObjectCreationExpressionSyntax: creation
                    .ArgumentList
                    ?.Arguments ??
                    default(Microsoft.CodeAnalysis.SeparatedSyntaxList[ArgumentSyntax])
                case creation is ImplicitObjectCreationExpressionSyntax: creation.ArgumentList.Arguments
                default: default(Microsoft.CodeAnalysis.SeparatedSyntaxList[ArgumentSyntax])
            }
            for argument in arguments {
                if StripParentheses(argument.Expression) is not AnonymousFunctionExpressionSyntax lambda {
                    continue
                }
                let parameter IParameterSymbol? = this.GetArgumentParameter(argument, projectedMethod)
                if parameter == nil {
                    continue
                }
                var targetType ITypeSymbol? = parameter.Type
                if this.TryGetExpandedParamsElementTarget(argument, parameter, out var paramsElementType, out _) {
                    targetType = paramsElementType
                }
                let invoke IMethodSymbol? = GetDelegateInvokeMethod(targetType)
                if invoke == nil {
                    continue
                }
                let targetResult ITypeSymbol? = GetLambdaResultTargetType(lambda, invoke)
                if targetResult == nil {
                    continue
                }
                for result in GetLambdaResultExpressions(lambda) {
                    if !this.LambdaResultFitsProjectedDestination(result, targetResult, lambda, invoke) {
                        incompatibleParameter = parameter
                        return false
                    }
                }
            }
            return true
        }

        private func ProjectedByRefArgumentsMatch(
            call Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            projectedMethod IMethodSymbol?,
            out incompatibleParameter IParameterSymbol?
        ) bool {
            incompatibleParameter = nil
            let boundMethod IMethodSymbol? = (
                this.context.SemanticModel.GetOperation(call) as IInvocationOperation
            )?.TargetMethod ??
                this
                .context
                .GetSymbolInfo(call)
                .Symbol as IMethodSymbol
            let originalExtension IMethodSymbol? = boundMethod?.ReducedFrom ?? boundMethod
            let receiverParameter IParameterSymbol? = originalExtension?.Parameters.FirstOrDefault()
            if call is InvocationExpressionSyntax{Expression: MemberAccessExpressionSyntax reducedMember} &&
                originalExtension?.IsExtensionMethod == true &&
                !(this.context.GetSymbolInfo(reducedMember.Expression).Symbol is INamedTypeSymbol) &&
                receiverParameter != nil &&
                receiverParameter.RefKind != RefKind.None &&
                CSharpToGSharpTranslator
                .TypeContainsRecognizedManagedReferenceConsumer(
                if projectedMethod!!.MethodKind == MethodKind.ReducedExtension {
                    projectedMethod!!.ReceiverType ?? receiverParameter.Type
                } else {
                    projectedMethod!!.Parameters[0].Type
                },
                this.context.Compilation
            ) &&
                this
                .SourceByRefParameterRequiresValidation(receiverParameter) {
                let projectedReceiverType = if projectedMethod!!.MethodKind == MethodKind.ReducedExtension {
                    projectedMethod!!.ReceiverType ?? receiverParameter.Type
                } else {
                    projectedMethod!!.Parameters[0].Type
                }
                if !this.ProjectedByRefStorageMatches(reducedMember.Expression, projectedReceiverType) {
                    incompatibleParameter = receiverParameter
                    return false
                }
            }
            let arguments = switch call {
                case invocation is InvocationExpressionSyntax: invocation.ArgumentList.Arguments
                case creation is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ObjectCreationExpressionSyntax: creation
                    .ArgumentList
                    ?.Arguments ??
                    default(Microsoft.CodeAnalysis.SeparatedSyntaxList[ArgumentSyntax])
                case creation is ImplicitObjectCreationExpressionSyntax: creation.ArgumentList.Arguments
                default: default(Microsoft.CodeAnalysis.SeparatedSyntaxList[ArgumentSyntax])
            }
            for argument in arguments {
                let originalParameter IParameterSymbol? = this.GetArgumentParameter(argument, projectedMethod)
                if originalParameter == nil ||
                    originalParameter.RefKind == RefKind.None ||
                    originalParameter.Ordinal >= projectedMethod!!
                    .Parameters
                    .Length {
                    continue
                }
                let projectedParameter = projectedMethod!!.Parameters[originalParameter.Ordinal]
                if !CSharpToGSharpTranslator.TypeContainsRecognizedManagedReferenceConsumer(
                    projectedParameter.Type,
                    this.context.Compilation
                ) ||
                    !this.SourceByRefParameterRequiresValidation(originalParameter) {
                    continue
                }
                if this.ProjectedByRefStorageMatches(argument.Expression, projectedParameter.Type) {
                    continue
                }
                incompatibleParameter = projectedParameter
                return false
            }
            return true
        }

        private func SourceByRefParameterRequiresValidation(parameter IParameterSymbol?) bool {
            return CSharpToGSharpTranslator.TypeContainsRecognizedManagedReferenceConsumer(
                parameter!!.Type,
                this.context.Compilation
            ) &&
                (
                parameter!!.ContainingSymbol is not IMethodSymbol containingMethod ||
                    !containingMethod
                    .DeclaringSyntaxReferences
                    .IsDefaultOrEmpty ||
                    (this.context.RepositoryCompilations ?? this.context.SiblingCompilations)?.Any(
                    (compilation CSharpCompilation) -> compilation.AssemblyName == containingMethod
                        .ContainingAssembly
                        ?.Name
                ) == true
            )
        }

        private func ProjectedByRefStorageMatches(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            projectedParameterType ITypeSymbol
        ) bool {
            var expression = expression
            expression = Unparenthesize(expression)
            if expression is DeclarationExpressionSyntax declaration && declaration.Type.IsVar {
                return true
            }
            if this
                .context
                .GetSymbolInfo(expression)
                .Symbol is ILocalSymbol local &&
                IsImplicitlyTypedLocal(local) &&
                local
                .DeclaringSyntaxReferences
                .FirstOrDefault()
                ?.GetSyntax() is VariableDeclaratorSyntax{Initializer: {Value: {} initializer}} {
                expression = initializer
            }
            let storageType ITypeSymbol? = this.GetManagedReferenceArrayProjectedArgumentType(expression)
            return SymbolEqualityComparer.IncludeNullability.Equals(storageType, projectedParameterType)
        }

        private func ObjectCreationCanProjectContainingType(creation BaseObjectCreationExpressionSyntax) bool {
            if this.IsArgumentOfProjectedCallInProgress(creation) || this.IsValueAssignedToProjectableReceiver(
                creation
            ) {
                return true
            }
            return !HasFixedElementContext(creation)
        }

        private func IsValueAssignedToProjectableReceiver(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) bool {
            var current Microsoft.CodeAnalysis.SyntaxNode? = value
            while current!!.Parent is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax {
                current = current!!.Parent
            }
            if current!!.Parent is not Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .AssignmentExpressionSyntax assignment ||
                assignment.Right != current {
                return false
            }
            let receiver Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax? = switch assignment.Left {
                case member is MemberAccessExpressionSyntax: member.Expression
                case element is ElementAccessExpressionSyntax: element.Expression
                default: default(Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?)
            }
            if receiver == nil ||
                this
                .context
                .GetSymbolInfo(receiver)
                .Symbol is not ILocalSymbol local ||
                !(
                local
                    .DeclaringSyntaxReferences
                    .FirstOrDefault()
                    ?.GetSyntax() is VariableDeclaratorSyntax{Initializer: {Value: {} rawInitializer}}
            ) {
                return false
            }
            let initializer Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax? = Unparenthesize(rawInitializer)
            let projectionInProgress = this.state.ManagedReferenceArrayProjectedCallsInProgress.Contains(initializer!!)
            if (
                !projectionInProgress &&
                    (
                    initializer is not BaseObjectCreationExpressionSyntax creation ||
                        !this.ObjectCreationCanProjectContainingType(creation)
                )
            ) ||
                this
                .context
                .GetSymbolInfo(initializer)
                .Symbol is not IMethodSymbol initializerMethod {
                return false
            }
            var targetMember ISymbol? = this.context.GetSymbolInfo(assignment.Left).Symbol
            if targetMember == nil {
                let operation IOperation? = this.context.SemanticModel.GetOperation(assignment.Left)
                if operation is IFieldReferenceOperation field {
                    targetMember = field.Field
                } else if operation is IPropertyReferenceOperation property {
                    targetMember = property.Property
                }
            }
            if targetMember?.ContainingType == nil || !SymbolEqualityComparer.Default.Equals(
                targetMember!!.ContainingType.OriginalDefinition,
                initializerMethod.ContainingType?.OriginalDefinition
            ) {
                return false
            }
            if projectionInProgress {
                this.RecordManagedReferenceArrayProjectionParent(value, initializer)
            }
            return true
        }

        private func TryGetInferredLocalInitializedBy(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            out local ILocalSymbol?
        ) bool {
            var current Microsoft.CodeAnalysis.SyntaxNode? = value
            while current!!.Parent is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax {
                current = current!!.Parent
            }
            local = if current!!.Parent is EqualsValueClauseSyntax{Parent: VariableDeclaratorSyntax declarator} {
                this.context.GetDeclaredSymbol(declarator) as ILocalSymbol
            } else {
                default(ILocalSymbol?)
            }
            return local != nil && IsImplicitlyTypedLocal(local)
        }

        private func ProjectedResultMatchesDestination(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            projectedType ITypeSymbol?,
            out destinationType ITypeSymbol?
        ) bool {
            destinationType = nil
            if this.IsValueAssignedToProjectableReceiver(value) {
                return true
            }
            if this.TryGetFixedExpressionLambdaReturnType(value, out destinationType) {
                destinationType = this.GetEmittedArrayDestinationType(value, sink: nil, destinationType, projectedType)
                return this.ProjectionTypeFitsResultDestination(projectedType, destinationType)
            }
            if IsConditionalOrSwitchArm(value) {
                return true
            }
            var directParent Microsoft.CodeAnalysis.SyntaxNode? = value
            while directParent!!.Parent is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax {
                directParent = directParent!!.Parent
            }
            if directParent!!.Parent is ArgumentSyntax{Parent: BaseArgumentListSyntax} argument {
                if this.IsArgumentOfProjectedCallInProgress(value) {
                    return true
                }
                let parameter IParameterSymbol? = this.GetArgumentParameter(argument)
                destinationType = parameter?.Type
                destinationType = this.GetEmittedArrayDestinationType(value, parameter, destinationType, projectedType)
                return this.ProjectionTypeFitsResultDestination(projectedType, destinationType)
            }
            let sink ISymbol? = this.ResolveValueSink(value)
            destinationType = this.GetFixedElementDestinationType(value, sink)
            if destinationType != nil {
                return this.ProjectionTypeFitsResultDestination(projectedType, destinationType)
            }
            if sink is ILocalSymbol local && IsImplicitlyTypedLocal(local) && !HasFixedElementContext(value) {
                if !this.ValueDirectlyDefinesLocalStorage(value, local) {
                    return true
                }
                if IsConditionalOrSwitchArm(value) {
                    return true
                }
                return this.InferredLocalAssignmentsMatch(local, value, projectedType)
            }
            if sink == nil {
                return true
            }
            destinationType = this.context.GetTypeInfo(value).ConvertedType ?? switch sink {
                case field is IFieldSymbol: field.Type
                case destinationLocal is ILocalSymbol: destinationLocal.Type
                case parameter is IParameterSymbol: parameter.Type
                case property is IPropertySymbol: property.Type
                case method is IMethodSymbol: method.ReturnType
                default: default(ITypeSymbol?)
            }
            destinationType = this.GetEmittedArrayDestinationType(value, sink, destinationType, projectedType)
            return this.ProjectionTypeFitsResultDestination(projectedType, destinationType)
        }

        private func GetEmittedArrayDestinationType(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            sink ISymbol?,
            destinationType ITypeSymbol?,
            projectedType ITypeSymbol?
        ) ITypeSymbol? {
            if sink is ILocalSymbol initializerLocal && this.IsLocalDeclarationInitializer(value, initializerLocal) {
                return this.GetProjectedArrayLocalDestinationType(
                    value,
                    initializerLocal,
                    destinationType,
                    projectedType
                )
            }
            if destinationType != nil && projectedType != nil && SymbolEqualityComparer.Default.Equals(
                destinationType,
                projectedType
            ) &&
                !SymbolEqualityComparer
                .IncludeNullability
                .Equals(destinationType, projectedType) {
                let canonicalLocation = value.GetLocation()
                let mappedDestination = GSharpPrinter.RenderTypeReference(
                    this.typeMapper.Map(destinationType, this.context, canonicalLocation)
                )
                let mappedProjected = GSharpPrinter.RenderTypeReference(
                    this.typeMapper.Map(projectedType, this.context, canonicalLocation)
                )
                if string.Equals(mappedDestination, mappedProjected, StringComparison.Ordinal) {
                    let canonicalEffectiveType = projectedType.WithNullableAnnotation(
                        destinationType.NullableAnnotation
                    )
                    if sink is ILocalSymbol canonicalLocal {
                        this
                            .state
                            .ManagedReferenceArrayNullable
                            .ManagedReferenceArrayProjectedLocalType[canonicalLocal] = canonicalEffectiveType
                    }
                    return canonicalEffectiveType
                }
            }
            if destinationType is not IArrayTypeSymbol destinationArray ||
                projectedType is not IArrayTypeSymbol projectedArray ||
                destinationArray.Rank != projectedArray.Rank ||
                !SymbolEqualityComparer
                .Default
                .Equals(destinationArray, projectedArray) {
                return destinationType
            }
            let location = value.GetLocation()
            let mappedDestinationElement GTypeReference? = (
                this.typeMapper.Map(destinationArray, this.context, location) as ArrayTypeReference
            )?.ElementType
            let mappedProjectedElement GTypeReference? = (
                this.typeMapper.Map(projectedArray, this.context, location) as ArrayTypeReference
            )?.ElementType
            // Roslyn cannot express intrinsic managed-reference array widening,
            // so compare fresh canonical element types at this use site.
            if mappedDestinationElement == nil || mappedProjectedElement == nil || !string.Equals(
                GSharpPrinter.RenderTypeReference(mappedDestinationElement),
                GSharpPrinter.RenderTypeReference(mappedProjectedElement),
                StringComparison.Ordinal
            ) {
                return destinationType
            }
            let effectiveType = projectedArray.WithNullableAnnotation(destinationArray.NullableAnnotation)
            if sink is ILocalSymbol local {
                this.state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType[local] = effectiveType
            }
            return effectiveType
        }

        private func IsLocalDeclarationInitializer(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            local ILocalSymbol
        ) bool {
            var initializer Microsoft.CodeAnalysis.SyntaxNode? = value
            while initializer!!.Parent is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax {
                initializer = initializer!!.Parent
            }
            return initializer!!.Parent is EqualsValueClauseSyntax{Parent: VariableDeclaratorSyntax declarator} &&
                SymbolEqualityComparer
                .Default
                .Equals(this.context.GetDeclaredSymbol(declarator), local)
        }

        private func GetProjectedArrayLocalDestinationType(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            local ILocalSymbol,
            destinationType ITypeSymbol?,
            projectedType ITypeSymbol?
        ) ITypeSymbol? {
            var initializer Microsoft.CodeAnalysis.SyntaxNode? = value
            while initializer!!.Parent is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax {
                initializer = initializer!!.Parent
            }
            if destinationType is not IArrayTypeSymbol destinationArray ||
                projectedType is not IArrayTypeSymbol projectedArray ||
                destinationArray.Rank != projectedArray.Rank ||
                IsImplicitlyTypedLocal(local) ||
                !(initializer!!.Parent is EqualsValueClauseSyntax{Parent: VariableDeclaratorSyntax declarator}) ||
                !SymbolEqualityComparer
                .Default
                .Equals(this.context.GetDeclaredSymbol(declarator), local) ||
                this
                .context
                .GetTypeInfo(value)
                .Type is not IArrayTypeSymbol naturalArray ||
                !SymbolEqualityComparer
                .Default
                .Equals(destinationArray, naturalArray) {
                return destinationType
            }
            // The declaration omits an equal explicit type and lets G# infer
            // the projected initializer shape; validate its later consumers.
            let effectiveType = projectedArray.WithNullableAnnotation(destinationArray.NullableAnnotation)
            return if this.InferredLocalAssignmentsMatch(local, value, effectiveType) {
                effectiveType
            } else {
                destinationType
            }
        }

        /// Issue #4525: the single gate for every "no exact G# translation
        /// exists" rejection caused by a managed-reference projection. A
        /// projection is only rejectable when it really involves a recognized
        /// managed-reference consumer, actually changed the value's type, and
        /// the fixed destination cannot adopt it. Ordinary nullable-element
        /// arrays fall back to the null-forgiveness path instead.
        /// @param value The value the projection was computed for.
        /// @param projected The projected type.
        /// @param destination The fixed destination type, or null when there is none to adopt the projection.
        /// @returns Whether reporting an Unsupported diagnostic is warranted.
        private func IsRejectableManagedReferenceProjection(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            projected ITypeSymbol?,
            destination ITypeSymbol?
        ) bool {
            if projected == nil || !CSharpToGSharpTranslator.TypeContainsRecognizedManagedReferenceConsumer(
                projected,
                this.context.Compilation
            ) {
                return false
            }
            let natural ITypeSymbol? = this
                .context
                .GetTypeInfo(value)
                .Type ??
                this
                .context
                .GetTypeInfo(value)
                .ConvertedType
            if natural != nil && SymbolEqualityComparer.IncludeNullability.Equals(natural, projected) {
                return false
            }
            return destination == nil || !this.ProjectionTypeFitsResultDestination(projected, destination)
        }

        private func ProjectionTypeFitsResultDestination(
            projectedType ITypeSymbol?,
            destinationType ITypeSymbol?
        ) bool -> ProjectionTypeFitsDestination(projectedType, destinationType) ||
            this.ProjectionTypeFitsCompositeDestination(projectedType, destinationType)

        private func TryGetFixedExpressionLambdaReturnType(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            out returnType ITypeSymbol?
        ) bool {
            returnType = nil
            var current Microsoft.CodeAnalysis.SyntaxNode? = value
            while (
                current!!.Parent is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ParenthesizedExpressionSyntax or
                    CastExpressionSyntax
            ) {
                current = current!!.Parent
            }
            if current!!.Parent is not AnonymousFunctionExpressionSyntax lambda || lambda.Body != current {
                return false
            }
            let sink ISymbol? = this.ResolveValueSink(lambda)
            if sink is ILocalSymbol local && IsImplicitlyTypedLocal(local) && this.ValueDirectlyDefinesLocalStorage(
                lambda,
                local
            ) {
                return false
            }
            if sink is IParameterSymbol parameter &&
                parameter.ContainingSymbol is IMethodSymbol containingMethod &&
                containingMethod.IsGenericMethod &&
                lambda.Parent is ArgumentSyntax argument &&
                argument
                .Parent
                ?.Parent is InvocationExpressionSyntax invocation &&
                !(invocation.Expression is GenericNameSyntax) &&
                invocation.Expression is not(MemberAccessExpressionSyntax and {Name: GenericNameSyntax}) &&
                containingMethod
                .TypeParameters
                .Any(
                (typeParameter ITypeParameterSymbol) -> TypeContainsTypeParameter(
                    parameter.OriginalDefinition.Type,
                    typeParameter
                )
            ) {
                return false
            }
            returnType = GetDelegateInvokeMethod(this.context.GetTypeInfo(lambda).ConvertedType)?.ReturnType
            return returnType != nil
        }

        private func DiscardDependentManagedReferenceArrayProjections(
            failedCall Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) {
            let pending = Queue[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax]()
            pending.Enqueue(failedCall)
            while pending.Count > 0 {
                let parent = pending.Dequeue()
                if !this.state.ManagedReferenceArrayProjectionChildrenByCall.Remove(parent, out var children) {
                    continue
                }
                for child in children {
                    if !this
                        .state
                        .ManagedReferenceArrayProjectionParentByCall
                        .TryGetValue(child, out var recordedParent) ||
                        !object.ReferenceEquals(recordedParent, parent) {
                        continue
                    }
                    this.state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedMethodByCall[child] = nil
                    this.state.ManagedReferenceArrayProjectionParentByCall.Remove(child)
                    pending.Enqueue(child)
                }
            }
            this.RemoveManagedReferenceArrayProjectionParent(failedCall)
        }

        private func RecordManagedReferenceArrayProjectionParent(
            child Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            parent Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) {
            if this
                .state
                .ManagedReferenceArrayProjectionParentByCall
                .TryGetValue(child, out var oldParent) &&
                !object.ReferenceEquals(oldParent, parent) {
                this.RemoveManagedReferenceArrayProjectionParent(child)
            }
            this.state.ManagedReferenceArrayProjectionParentByCall[child] = parent!!
            if !this.state.ManagedReferenceArrayProjectionChildrenByCall.TryGetValue(parent!!, out var children) {
                children = HashSet[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax](
                    ReferenceEqualityComparer.Instance
                )
                this.state.ManagedReferenceArrayProjectionChildrenByCall.Add(parent!!, children)
            }
            children.Add(child)
        }

        private func RemoveManagedReferenceArrayProjectionParent(
            child Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) {
            if !this
                .state
                .ManagedReferenceArrayProjectionParentByCall
                .Remove(child, out var parent) ||
                !this
                .state
                .ManagedReferenceArrayProjectionChildrenByCall
                .TryGetValue(parent, out var children) {
                return
            }
            children.Remove(child)
            if children.Count == 0 {
                this.state.ManagedReferenceArrayProjectionChildrenByCall.Remove(parent)
            }
        }

        private func IsArgumentOfProjectedCallInProgress(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) bool {
            var directParent Microsoft.CodeAnalysis.SyntaxNode? = value
            while directParent!!.Parent is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax {
                directParent = directParent!!.Parent
            }
            if !(directParent!!.Parent is ArgumentSyntax{Parent: BaseArgumentListSyntax argumentList} argument) ||
                argumentList.Parent is not Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ExpressionSyntax outerCall ||
                !this
                .state
                .ManagedReferenceArrayProjectedCallsInProgress
                .Contains(outerCall) ||
                this
                .context
                .GetSymbolInfo(outerCall)
                .Symbol is not IMethodSymbol outerMethod ||
                this.GetArgumentParameter(argument, outerMethod) is not IParameterSymbol parameter {
                return false
            }
            let parameterType = parameter.OriginalDefinition.Type
            for var index = 0;
                index < outerMethod
                .TypeParameters
                .Length &&
                index < outerMethod
                .TypeArguments
                .Length;
                index++ {
                if TypeContainsTypeParameter(parameterType, outerMethod.TypeParameters[index]) &&
                    CSharpToGSharpTranslator
                    .TypeContainsRecognizedManagedReferenceConsumer(
                    outerMethod.TypeArguments[index],
                    this.context.Compilation
                ) {
                    this.RecordManagedReferenceArrayProjectionParent(value, outerCall)
                    return true
                }
            }
            let containingType INamedTypeSymbol? = outerMethod.ContainingType
            if containingType == nil {
                return false
            }
            for current in NamedTypeAndContainingTypes(containingType) {
                for var index = 0;
                    index < current
                    .OriginalDefinition
                    .TypeParameters
                    .Length &&
                    index < current
                    .TypeArguments
                    .Length;
                    index++ {
                    if TypeContainsTypeParameter(parameterType, current.OriginalDefinition.TypeParameters[index]) &&
                        CSharpToGSharpTranslator
                        .TypeContainsRecognizedManagedReferenceConsumer(
                        current.TypeArguments[index],
                        this.context.Compilation
                    ) {
                        this.RecordManagedReferenceArrayProjectionParent(value, outerCall)
                        return true
                    }
                }
            }
            return false
        }

        private func GetProjectionConsumers(body Microsoft.CodeAnalysis.SyntaxNode, symbol ISymbol?) IReadOnlyList[
            Microsoft.CodeAnalysis.SyntaxNode
        ] {
            if !this.state.ProjectionConsumersByBody.TryGetValue(body, out var index) {
                let AddConsumer = func (consumerSymbol ISymbol?, consumer Microsoft.CodeAnalysis.SyntaxNode) {
                    if consumerSymbol == nil {
                        return
                    }
                    if !index.TryGetValue(consumerSymbol, out var consumers) {
                        consumers = List[Microsoft.CodeAnalysis.SyntaxNode]()
                        index.Add(consumerSymbol, consumers)
                    }
                    consumers.Add(consumer)
                }
                index = Dictionary[ISymbol, List[Microsoft.CodeAnalysis.SyntaxNode]](SymbolEqualityComparer.Default)
                for candidate in body.DescendantNodes() {
                    if candidate is IdentifierNameSyntax identifier {
                        AddConsumer(this.context.GetSymbolInfo(identifier).Symbol, identifier)
                    }
                    let receiverExpression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax? = switch candidate {
                        case InvocationExpressionSyntax{
                            Expression: MemberAccessExpressionSyntax member
                        }: member.Expression
                        case Microsoft
                            .CodeAnalysis
                            .CSharp
                            .Syntax
                            .AssignmentExpressionSyntax{Left: MemberAccessExpressionSyntax member}: member.Expression
                        case Microsoft
                            .CodeAnalysis
                            .CSharp
                            .Syntax
                            .AssignmentExpressionSyntax{Left: ElementAccessExpressionSyntax element}: element.Expression
                        default: default(Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?)
                    }
                    if receiverExpression == nil {
                        continue
                    }
                    AddConsumer(this.context.GetSymbolInfo(Unparenthesize(receiverExpression)).Symbol, candidate)
                }
                this.state.ProjectionConsumersByBody.Add(body, index)
            }
            return if index.TryGetValue(symbol!!, out var consumers) {
                cast[IReadOnlyList[Microsoft.CodeAnalysis.SyntaxNode]](consumers)
            } else {
                cast[IReadOnlyList[Microsoft.CodeAnalysis.SyntaxNode]](Array.Empty[Microsoft.CodeAnalysis.SyntaxNode]())
            }
        }

        private func GetFixedElementDestinationType(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            sink ISymbol?
        ) ITypeSymbol? {
            let tupleIndices = List[int32]()
            let node Microsoft.CodeAnalysis.SyntaxNode? = OutermostTransparentNode(value, tupleIndices)
            var sinkType ITypeSymbol? = ObliviousNullabilityAnalyzer.SymbolValueType(sink)
            sinkType ??= if node is TupleExpressionSyntax containingTuple {
                this.context.GetTypeInfo(containingTuple).ConvertedType
            } else {
                default(ITypeSymbol?)
            }
            let path = List[int32]()
            if node!!.Parent is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .YieldStatementSyntax &&
                sinkType is INamedTypeSymbol{TypeArguments: {Length: 1}} envelope {
                sinkType = envelope.TypeArguments[0]
                path.Add(0)
            }
            for var i = tupleIndices.Count - 1; i >= 0; i-- {
                if sinkType is not INamedTypeSymbol{IsTupleType: true} tupleType ||
                    tupleIndices[i] < 0 ||
                    tupleIndices[i] >= tupleType
                    .TupleElements
                    .Length {
                    return nil
                }
                let tupleElement = tupleType.TupleElements[tupleIndices[i]]
                sinkType = tupleElement.Type
                path.Add(tupleIndices[i])
            }
            if tupleIndices.Count != 0 {
                return if ObliviousNullabilityAnalyzer.IsTupleElementTainted(
                    this.context.Compilation,
                    sink,
                    path,
                    this.context.SiblingCompilations
                ) {
                    sinkType!!.WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.Annotated)
                } else {
                    sinkType
                }
            }
            if node!!.Parent is InitializerExpressionSyntax{
                Parent: Microsoft.CodeAnalysis.CSharp.Syntax.ArrayCreationExpressionSyntax arrayCreation
            } &&
                this
                .context
                .GetTypeInfo(arrayCreation)
                .Type is IArrayTypeSymbol arrayType {
                return arrayType.ElementType
            }
            return nil
        }

        private func InferredLocalAssignmentsMatch(
            local ILocalSymbol,
            projectedValue Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            projectedType ITypeSymbol?
        ) bool {
            if this
                .state
                .ManagedReferenceArrayNullable
                .ManagedReferenceArrayProjectedLocalType
                .TryGetValue(local, out var cached) {
                return SymbolEqualityComparer.IncludeNullability.Equals(cached, projectedType)
            }
            if !this.state.ManagedReferenceArrayProjectedLocalTypeInProgress.Add(local) {
                return true
            }
            let normalizedProjectedValue Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ExpressionSyntax? = Unparenthesize(projectedValue)
            let ValueMatches = func (candidate Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?) bool {
                var candidate = candidate
                candidate = Unparenthesize(candidate)
                if candidate == normalizedProjectedValue {
                    return true
                }
                if candidate is Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalExpressionSyntax conditional {
                    return ValueMatches(conditional.WhenTrue) && ValueMatches(conditional.WhenFalse)
                }
                if candidate is Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionSyntax switchExpression {
                    return switchExpression.Arms.All(
                        (arm Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionArmSyntax) -> ValueMatches(
                            arm.Expression
                        )
                    )
                }
                let candidateType ITypeSymbol? = this.GetManagedReferenceArrayProjectedArgumentType(candidate)
                return SymbolEqualityComparer.IncludeNullability.Equals(candidateType, projectedType)
            }
            var matches = true
            var initializer Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax? = nil
            this.state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType[local] = projectedType
            try {
                if !(
                    local
                        .DeclaringSyntaxReferences
                        .FirstOrDefault()
                        ?.GetSyntax() is VariableDeclaratorSyntax{Initializer: {Value: {} declaredInitializer}}
                ) ||
                    !ValueMatches(declaredInitializer) {
                    matches = false
                } else {
                    initializer = declaredInitializer
                }
                if matches && initializer != nil && this.state.CurrentBodyScope is {} scope_ {
                    for use in this.GetProjectionConsumers(scope_, local).OfType[IdentifierNameSyntax]() {
                        if use.SpanStart <= initializer.Span.End || !this.BindsTo(use, local) {
                            continue
                        }
                        let write Microsoft.CodeAnalysis.SyntaxNode? = use.AncestorsAndSelf().FirstOrDefault(
                            (node Microsoft.CodeAnalysis.SyntaxNode) -> this.SyntaxNodeWritesSymbol(node, local)
                        )
                        if write != nil {
                            if write is not Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax assignment {
                                continue
                            }
                            if !assignment.IsKind(
                                Microsoft.CodeAnalysis.CSharp.SyntaxKind.SimpleAssignmentExpression
                            ) ||
                                !this.BindsTo(assignment.Left, local) || !ValueMatches(assignment.Right) {
                                matches = false
                                break
                            }
                            continue
                        }
                        if use.Parent is ArgumentSyntax{
                            Parent: {Parent: Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax projectedCall}
                        } &&
                            this
                            .context
                            .GetSymbolInfo(projectedCall)
                            .Symbol is IMethodSymbol projectedCallMethod &&
                            (
                            projectedCallMethod.IsGenericMethod ||
                                projectedCallMethod
                                .ContainingType
                                ?.IsGenericType == true
                        ) &&
                            CSharpToGSharpTranslator
                            .MethodMayRequireManagedReferenceArrayProjection(
                            projectedCallMethod,
                            this.context.Compilation
                        ) {
                            this.RecordManagedReferenceArrayProjectionParent(projectedCall, projectedValue)
                            continue
                        }
                        if !this.ProjectedResultMatchesDestination(use, projectedType, out _) {
                            matches = false
                            break
                        }
                        if use.Parent is ArgumentSyntax{
                            Parent: {Parent: Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax consumer}
                        } &&
                            this
                            .state
                            .ManagedReferenceArrayNullable
                            .ManagedReferenceArrayProjectedMethodByCall
                            .TryGetValue(consumer, out var projectedConsumer) &&
                            projectedConsumer != nil {
                            this.RecordManagedReferenceArrayProjectionParent(consumer, projectedValue)
                        }
                    }
                }
            } finally {
                this.state.ManagedReferenceArrayProjectedLocalTypeInProgress.Remove(local)
            }
            this.state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType[local] = if matches {
                projectedType
            } else {
                default(ITypeSymbol?)
            }
            return matches
        }

        private func ValueDirectlyDefinesLocalStorage(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            local ILocalSymbol
        ) bool {
            var node Microsoft.CodeAnalysis.SyntaxNode? = value
            while (
                node!!.Parent is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ParenthesizedExpressionSyntax or
                    CastExpressionSyntax or
                    Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ConditionalExpressionSyntax or
                    Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .SwitchExpressionArmSyntax
            ) {
                node = node!!.Parent
            }
            return switch node!!.Parent {
                case EqualsValueClauseSyntax{Parent: VariableDeclaratorSyntax declarator}: SymbolEqualityComparer
                    .Default
                    .Equals(this.context.GetDeclaredSymbol(declarator), local)
                case assignment is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .AssignmentExpressionSyntax when assignment.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.SimpleAssignmentExpression
                ): this.BindsTo(assignment.Left, local)
                default: false
            }
        }

        private func GetManagedReferenceArrayProjectedArgumentType(
            argument Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) ITypeSymbol? {
            let projected ITypeSymbol? = this.GetManagedReferenceArrayProjectedExpressionType(argument)
            if projected != nil {
                return projected
            }
            let type ITypeSymbol? = this
                .context
                .GetTypeInfo(argument)
                .Type ??
                this
                .context
                .GetTypeInfo(argument)
                .ConvertedType
            return if type != nil &&
                (
                this.IsNullableForEachBindingUse(argument) || this.ManagedReferenceArrayWidenedExpressionMayBeNull(
                    argument
                )
            ) {
                type.WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.Annotated)
            } else {
                type
            }
        }

        private func GetBoundTypeArguments(generic GenericNameSyntax) ImmutableArray[ITypeSymbol] {
            var symbol ISymbol? = this.context.GetSymbolInfo(generic).Symbol
            if symbol == nil && generic.Parent is InvocationExpressionSyntax invocation {
                symbol = this.context.GetSymbolInfo(invocation).Symbol
            }
            let typeArguments = switch symbol {
                case method is IMethodSymbol: method.TypeArguments
                case type is INamedTypeSymbol: type.TypeArguments
                default: ImmutableArray[ITypeSymbol].Empty
            }
            return if typeArguments.Length == generic.TypeArgumentList.Arguments.Count {
                typeArguments
            } else {
                ImmutableArray[ITypeSymbol].Empty
            }
        }

        private func TranslateInterpolatedString(
            interpolated Microsoft.CodeAnalysis.CSharp.Syntax.InterpolatedStringExpressionSyntax
        ) GExpression {
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
            var dollarCount = 0
            while dollarCount < interpolated
                .StringStartToken
                .Text
                .Length &&
                interpolated
                .StringStartToken
                .Text[dollarCount] == '$' {
                dollarCount++
            }
            let isClassicSingleDollar = dollarCount <= 1
            let parts = List[InterpolationPart]()
            for content in interpolated.Contents {
                switch content {
                    case text is InterpolatedStringTextSyntax {
                        // Issue #1882: Roslyn's ValueText does NOT unescape `{{`/`}}`
                        // (those are interpolation-hole delimiters, not string escapes).
                        // G# has no bare `{expr}` hole syntax (only `${expr}`/`$ident`,
                        // see Lexer.cs), so `{`/`}` are always plain literal chars in G#
                        // and need no escaping at all. Unescape here or the doubled
                        // braces get copied verbatim into the G# output.
                        let literalText = if isClassicSingleDollar {
                            text.TextToken.ValueText.Replace("{{", "{").Replace("}}", "}")
                        } else {
                            text.TextToken.ValueText
                        }
                        parts.Add(InterpolationPart.Literal(literalText))
                    }
                    case hole is InterpolationSyntax {
                        let alignment string? = hole.AlignmentClause?.Value.ToString()
                        let format string? = hole.FormatClause?.FormatStringToken.ValueText
                        parts.Add(InterpolationPart.Hole(this.TranslateExpression(hole.Expression), alignment, format))
                    }
                }
            }
            return InterpolatedStringExpression(parts)
        }

        shared {
            // Issue #3501 (GS0155): true when the containing type declares a
            // NON-generic same-name sibling of equal arity whose corresponding
            // parameter shares a generic original definition with the chosen
            // method's — the exact shape where gsc's erased inference lets the
            // invariant sibling win (AddRange(ImmutableArray<T>) vs
            // AddRange<TDerived>(ImmutableArray<TDerived>)). Anything looser
            // sprays explicit type arguments over ordinary LINQ shapes.
            private func HasErasureCollidingNonGenericSibling(chosen IMethodSymbol) bool {
                let definition = chosen.OriginalDefinition
                for member in chosen.ContainingType?.GetMembers(chosen.Name) ?? ImmutableArray[ISymbol].Empty {
                    if member is not IMethodSymbol sibling ||
                        sibling.IsGenericMethod ||
                        SymbolEqualityComparer
                        .Default
                        .Equals(sibling, definition) || sibling.Parameters.Length != definition.Parameters.Length {
                        continue
                    }
                    for var i = 0; i < sibling.Parameters.Length; i++ {
                        if sibling
                            .Parameters[i]
                            .Type is INamedTypeSymbol{IsGenericType: true} siblingParam &&
                            definition
                            .Parameters[i]
                            .Type is INamedTypeSymbol{IsGenericType: true} chosenParam &&
                            SymbolEqualityComparer
                            .Default
                            .Equals(siblingParam.OriginalDefinition, chosenParam.OriginalDefinition) {
                            return true
                        }
                    }
                }
                return false
            }

            private func RequiresQualifiedImportedContextualCall(
                method IMethodSymbol,
                includeGenericPrefix bool = false
            ) bool {
                if !method.DeclaringSyntaxReferences.IsDefaultOrEmpty {
                    return false
                }
                var context = IdentifierNameContext.Invocation
                if includeGenericPrefix {
                    context |= IdentifierNameContext.Index
                }
                return GSharp.Core.CodeAnalysis.Syntax.SyntaxFacts.IsReservedIdentifier(method.Name, context)
            }

            private func TryGetExplicitExtensionReceiverArgument(
                invocation IInvocationOperation,
                method IMethodSymbol,
                out receiver IArgumentOperation?
            ) bool {
                let receiverParameter = (method.ReducedFrom ?? method).Parameters[0]
                receiver = invocation.Arguments.FirstOrDefault(
                    (argument IArgumentOperation) -> argument.ArgumentKind != ArgumentKind.DefaultValue &&
                        argument.Syntax is ArgumentSyntax &&
                        SymbolEqualityComparer
                        .Default
                        .Equals(argument.Parameter?.OriginalDefinition, receiverParameter.OriginalDefinition)
                )
                return receiver != nil
            }

            private func IsSupportedConditionalStaticHelperReceiver(
                expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
            ) bool -> expression is MemberBindingExpressionSyntax ||
                (
                expression is MemberAccessExpressionSyntax member &&
                    IsSupportedConditionalStaticHelperReceiver(member.Expression)
            )

            private func DependsOnEnclosingConditionalReceiver(
                expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
            ) bool -> expression
                .DescendantNodesAndSelf(
                descendIntoChildren: (node Microsoft.CodeAnalysis.SyntaxNode) -> !(
                    node is ConditionalAccessExpressionSyntax
                )
            )
                .Any(
                (node Microsoft.CodeAnalysis.SyntaxNode) -> node is MemberBindingExpressionSyntax ||
                    node is ElementBindingExpressionSyntax
            )

            /// Issue #1879: resolves the real declaring static class for a C# 14
            /// extension-block member. Roslyn declares such a member on a synthetic
            /// marker type (`INamedTypeSymbol.IsExtension`, named
            /// `"extension(T)"`) nested inside the class that physically owns the
            /// emitted G# member; this returns that enclosing class.
            /// @param symbol The bound call-site symbol (method or property).
            /// @param owner The real declaring class when matched.
            /// @returns `true` when [`symbol`](paramref) is a C# 14 extension-block member.
            private func TryGetExtensionBlockOwner(symbol ISymbol?, out owner INamedTypeSymbol?) bool {
                owner = if symbol?.ContainingType is {IsExtension: true} marker {
                    marker.ContainingType
                } else {
                    default(INamedTypeSymbol?)
                }
                return owner != nil
            }

            private func PassStaticExtensionHelperReceiver(receiver GExpression?, method IMethodSymbol?) GExpression? {
                let original IMethodSymbol? = method!!.ReducedFrom ?? method
                return if original!!
                    .Parameters[0]
                    .RefKind == RefKind.Ref ||
                    original!!
                    .Parameters[0]
                    .RefKind == RefKind.Out {
                    AddressOf(receiver)
                } else {
                    receiver
                }
            }

            /// Translates an argument list at a call site that may need lowering
            /// gsc's structural call model cannot express on its own (issue #1901):
            /// - a C#13 "params collection" parameter (`params List<T>`, `params IEnumerable<T>`, …) — gsc's own
            /// variadic parameter is always an array/slice ((cref:MapParameter)), so such a C# parameter is
            /// declared in G# as an ordinary parameter of the full collection type. An EXPANDED call
            /// (`Total(1, 2, 3)`, including the zero-argument `Total()` form) has no matching G# argument shape, so
            /// it is lowered here into an explicit collection construction (`Total(List[int32]{1, 2, 3})`) that
            /// becomes that single ordinary argument; the non-expanded, direct-collection form (`Total(someList)`)
            /// already binds a single ordinary argument as-is and needs no lowering.
            /// - a C#12 lambda default parameter value omitted at an INDIRECT call (`f()` where `f` is a
            /// local/field holding a lambda declared `(int x = 10) => …`). gsc's lambda parameters DO carry a
            /// default (`LambdaBinder.BindAndAttachParameterDefaultValue`), but it lives only on the lambda's own
            /// `ParameterSymbol` — the structural `FunctionTypeSymbol` that types the variable holding it (and that
            /// every indirect call through that variable binds against,
            /// `OverloadResolver.TryBindFunctionTypeArguments`) carries only parameter TYPES, never defaults, so
            /// gsc always requires the full arity at an indirect call. Roslyn already resolves the omitted argument
            /// to its constant default (`ArgumentKind.DefaultValue`) regardless of how the callee is invoked, so
            /// the missing argument is materialized explicitly here instead of being dropped.
            /// The params-collection shapes gsc can build FROM a call-site
            /// `List[T]{...}` literal (BuildConstruction has no other collection
            /// constructor to reach for): the concrete `List<T>` class itself,
            /// plus the interfaces it already implements. Matched structurally (single
            /// type argument) rather than by shape, per issue #1901 follow-up — a
            /// `HashSet<T>` or any user `[CollectionBuilder]` type has no
            /// gsc construction form and must gap instead of silently mismatching the
            /// declared parameter type. Object creation additionally lowers
            /// `Span<T>`/`ReadOnlySpan<T>` through an array argument,
            /// reusing gsc's existing array-to-span implicit conversion.
            private func IsSupportedParamsCollectionType(type ITypeSymbol) bool {
                if type is not INamedTypeSymbol{TypeArguments: [ITypeSymbol]} named {
                    return false
                }
                if named.Name == "List" &&
                    named
                    .ContainingNamespace
                    ?.ToDisplayString() == "System.Collections.Generic" {
                    return true
                }
                // ADR-0173 / issue #3627: gsc's generalized variadic carriers
                // cover the span types too (`...ReadOnlySpan[T]` ≡ C#13's
                // preferred `params ReadOnlySpan<T>` form).
                if IsSpanParamsCollectionType(named) {
                    return true
                }
                let specialType = named.OriginalDefinition.SpecialType
                return specialType == SpecialType.System_Collections_Generic_IEnumerable_T ||
                    specialType == SpecialType.System_Collections_Generic_ICollection_T ||
                    specialType == SpecialType.System_Collections_Generic_IList_T ||
                    specialType == SpecialType.System_Collections_Generic_IReadOnlyList_T ||
                    specialType == SpecialType.System_Collections_Generic_IReadOnlyCollection_T
            }

            private func IsSpanParamsCollectionType(type ITypeSymbol?) bool -> type is INamedTypeSymbol{
                TypeArguments: [ITypeSymbol]
            } named &&
                named
                .ContainingNamespace
                ?.ToDisplayString() == "System" && (named.Name is "Span" or "ReadOnlySpan")

            private func IsEmptyParamsArgument(
                argument IArgumentOperation
            ) bool -> argument.ArgumentKind == ArgumentKind.ParamArray &&
                (argument.Value is IArrayCreationOperation and {Initializer: {ElementValues: {IsEmpty: true}}})

            // True when reassembling `operationArguments` by parameter ordinal
            // would emit two EXPLICIT operands in an order other than the one they
            // were written in — i.e. the explicit arguments'
            // ordinals are not ascending along the (evaluation-ordered) array.
            // Omitted `DefaultValue` slots never count: Roslyn resolves them to a
            // constant, which has no side effect to reorder.
            private func PermutesExplicitArguments(operationArguments ImmutableArray[IArgumentOperation]) bool {
                var previousOrdinal = -1
                for argumentOperation in operationArguments {
                    if argumentOperation.ArgumentKind == ArgumentKind.DefaultValue ||
                        IsEmptyParamsArgument(argumentOperation) {
                        continue
                    }
                    if argumentOperation.Parameter!!.Ordinal < previousOrdinal {
                        return true
                    }
                    previousOrdinal = argumentOperation.Parameter!!.Ordinal
                }
                return false
            }

            /// The G# address of [`operand`](paramref) (`&x`), the form
            /// every by-reference position takes: `ref`/`out`/`in`
            /// arguments, `&` in unsafe code, and ref aliases.
            /// @param operand The translated variable.
            /// @returns The address-of expression.
            private func AddressOf(operand GExpression?) GExpression -> UnaryExpression(
                "&",
                WithoutNonNullAssertion(operand)
            )

            /// Drops a non-null assertion from a by-reference operand. `x!!` is
            /// a value, not a variable, so `&x!!` is rejected (GS9001);
            /// and the C# `!` it usually comes from (`ref x!`) only
            /// silences a warning, never changing the variable referenced.
            /// @param operand The translated by-reference operand.
            /// @returns The operand without an outermost `!!`.
            private func WithoutNonNullAssertion(operand GExpression?) GExpression? {
                if operand is NonNullAssertionExpression assertion {
                    return WithoutNonNullAssertion(assertion.Operand)
                }
                if operand is ParenthesizedExpression parenthesized {
                    let inner GExpression? = WithoutNonNullAssertion(parenthesized.Inner)
                    return if object.ReferenceEquals(inner, parenthesized.Inner) {
                        operand
                    } else {
                        cast[GExpression](ParenthesizedExpression(inner))
                    }
                }
                return operand
            }

            private func ContainsTypeParameter(type ITypeSymbol?) bool -> switch type {
                case _ is ITypeParameterSymbol: true
                case array is IArrayTypeSymbol: ContainsTypeParameter(array.ElementType)
                case named is INamedTypeSymbol: named.TypeArguments.Any(ContainsTypeParameter) ||
                    (named.ContainingType != nil && ContainsTypeParameter(named.ContainingType))
                case pointer is IPointerTypeSymbol: ContainsTypeParameter(pointer.PointedAtType)
                default: false
            }

            private func GetParamsElementType(
                parameter IParameterSymbol?
            ) ITypeSymbol? -> if parameter?.IsParams == true {
                (
                    switch parameter!!.Type {
                        case arrayType is IArrayTypeSymbol: arrayType.ElementType
                        case INamedTypeSymbol{
                            TypeArguments: [ITypeSymbol element]
                        } collection when IsSupportedParamsCollectionType(collection): element
                        default: default(ITypeSymbol?)
                    }
                )
            } else {
                default(ITypeSymbol?)
            }

            private func GetLambdaResultTargetType(
                lambda AnonymousFunctionExpressionSyntax,
                invoke IMethodSymbol?
            ) ITypeSymbol? {
                var targetResult = invoke!!.ReturnType
                if lambda.AsyncKeyword.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.AsyncKeyword) &&
                    targetResult is INamedTypeSymbol task &&
                    task.Name == "Task" &&
                    task
                    .ContainingNamespace
                    ?.ToDisplayString() == "System.Threading.Tasks" {
                    if !task.IsGenericType {
                        return nil
                    }
                    targetResult = task.TypeArguments[0]
                }
                return targetResult
            }

            private func GetLambdaResultExpressions(lambda AnonymousFunctionExpressionSyntax) IEnumerable[
                Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
            ] -> switch lambda
                .Body {
                case expression is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ExpressionSyntax: cast[IEnumerable[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax]](
                    []Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax{expression}
                )
                case block is BlockSyntax: block
                    .DescendantNodes(
                    (node Microsoft.CodeAnalysis.SyntaxNode) -> !(node is AnonymousFunctionExpressionSyntax) &&
                        !(node is LocalFunctionStatementSyntax)
                )
                    .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.ReturnStatementSyntax]()
                    .Where(
                    (
                        statement Microsoft.CodeAnalysis.CSharp.Syntax.ReturnStatementSyntax
                    ) -> statement.Expression != nil
                )
                    .Select(
                    (statement Microsoft.CodeAnalysis.CSharp.Syntax.ReturnStatementSyntax) -> statement.Expression!!
                )
                default: Enumerable.Empty[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax]()
            }

            private func MethodGroupNeedsExactTarget(
                method IMethodSymbol?,
                invoke IMethodSymbol?,
                isImplicitConversion bool = true
            ) bool {
                if method!!
                    .Parameters
                    .Length != invoke!!
                    .Parameters
                    .Length ||
                    method!!.ReturnsVoid != invoke!!.ReturnsVoid {
                    return true
                }
                // Issue #3501 A5: gsc now accepts VARIANT method groups at
                // IMPLICIT conversion sites — a contravariant reference
                // parameter or covariant reference return converts directly,
                // under inference and against fixed delegate slots alike — so a
                // pure reference-variance mismatch no longer forces a wrapper
                // lambda there. An EXPLICIT C# delegate creation
                // (`(Func<...>)Group`, `new Func<...>(Group)`) still renders as
                // a G# construction, whose operand cannot be a variant group,
                // so those keep the wrapper. Ref-kind differences and
                // non-reference (identity-only) type changes always do.
                if !isImplicitConversion {
                    for var index = 0; index < method!!.Parameters.Length; index++ {
                        let methodParameter = method!!.Parameters[index]
                        let invokeParameter = invoke!!.Parameters[index]
                        if methodParameter.RefKind != invokeParameter.RefKind || !SymbolEqualityComparer.Default.Equals(
                            methodParameter.Type,
                            invokeParameter.Type
                        ) {
                            return true
                        }
                    }
                    return !method!!.ReturnsVoid && !SymbolEqualityComparer.Default.Equals(
                        method!!.ReturnType,
                        invoke!!.ReturnType
                    )
                }
                for var index = 0; index < method!!.Parameters.Length; index++ {
                    let methodParameter = method!!.Parameters[index]
                    let invokeParameter = invoke!!.Parameters[index]
                    if methodParameter.RefKind != invokeParameter.RefKind {
                        return true
                    }
                    if !SymbolEqualityComparer.Default.Equals(methodParameter.Type, invokeParameter.Type) &&
                        !IsReferenceVariantCompatible(target: methodParameter.Type, source: invokeParameter.Type) {
                        return true
                    }
                }
                return !method!!.ReturnsVoid && !SymbolEqualityComparer.Default.Equals(
                    method!!.ReturnType,
                    invoke!!.ReturnType
                ) &&
                    !IsReferenceVariantCompatible(target: invoke!!.ReturnType, source: method!!.ReturnType)
            }

            // Issue #3501 A5: whether `source` converts to `target` by implicit
            // reference conversion — the variance C# permits between a method
            // group's signature and the target delegate's, mirrored by gsc since
            // its variant method-group support landed.
            private func IsReferenceVariantCompatible(target ITypeSymbol?, source ITypeSymbol?) bool {
                if target == nil || source == nil || target.IsValueType || source.IsValueType {
                    return false
                }
                for var current ITypeSymbol? = source;
                    current != nil;
                    current = (current as INamedTypeSymbol)?.BaseType {
                    if SymbolEqualityComparer.Default.Equals(current, target) {
                        return true
                    }
                }
                return source.AllInterfaces.Any(
                    (candidate INamedTypeSymbol) -> SymbolEqualityComparer.Default.Equals(candidate, target)
                )
            }

            // Issue #3468: a synthesized method-group wrapper parameter takes its
            // name from the TARGET method's corresponding parameter (`path`,
            // `value`) so the wrapper reads like the surrounding arrow lambdas;
            // the established underscore suffix resolves reserved spellings and
            // collisions; `__arg{i}` remains only the fallback when no usable
            // source name exists. For extension-method groups the delegate's
            // parameters align to the ORIGINAL method's parameters AFTER the
            // receiver, so callers pass the receiver-stripped list, and the
            // captured receiver identifier is pre-seeded into
            // <paramref name="usedNames"/> so a derived name can never shadow it.
            private func MethodGroupWrapperNameParameters(method IMethodSymbol?, invoke IMethodSymbol?) ImmutableArray[
                IParameterSymbol
            ] {
                let original IMethodSymbol? = method!!.ReducedFrom ?? method
                if method!!.MethodKind == MethodKind.ReducedExtension {
                    return method!!.Parameters
                }
                return if original!!.IsExtensionMethod &&
                    original!!
                    .Parameters
                    .Length == invoke!!
                    .Parameters
                    .Length +
                    1 {
                    original!!.Parameters.RemoveAt(0)
                } else {
                    method!!.Parameters
                }
            }

            private func ReserveMethodGroupReceiverName(receiver GExpression?, usedNames HashSet[string]) {
                var current GExpression? = receiver
                while true {
                    switch current {
                        case conversion is ConversionExpression {
                            current = conversion.Operand
                        }
                        case assertion is NonNullAssertionExpression {
                            current = assertion.Operand
                        }
                        case parenthesized is ParenthesizedExpression {
                            current = parenthesized.Inner
                        }
                        case memberAccess is MemberAccessExpression {
                            current = memberAccess.Target
                        }
                        case conditionalAccess is ConditionalAccessExpression {
                            current = conditionalAccess.Target
                        }
                        case identifier is IdentifierExpression {
                            usedNames.Add(identifier.Name)
                            return
                        }
                        default {
                            return
                        }
                    }
                }
            }

            private func MethodGroupWrapperParameterName(
                nameAllocator EmittedNameAllocator,
                targetParameters ImmutableArray[IParameterSymbol],
                index int32,
                usedNames HashSet[string]
            ) string? {
                var candidate string? = if index < targetParameters.Length {
                    targetParameters[index].Name
                } else {
                    default(string?)
                }
                let occupied = HashSet[string](usedNames, StringComparer.Ordinal)
                for var parameterIndex = 0; parameterIndex < targetParameters.Length; parameterIndex++ {
                    if parameterIndex != index {
                        occupied.Add(targetParameters[parameterIndex].Name)
                    }
                }
                if string.IsNullOrEmpty(candidate) || candidate == "_" {
                    // Missing metadata has no source spelling to suffix, and `_`
                    // is a discard that cannot name the forwarded argument.
                    candidate = "__arg$index"
                } else {
                    candidate = nameAllocator.GetName(candidate, IdentifierNameContext.Parameter, occupied)
                }
                while occupied.Contains(candidate!!) || !usedNames.Add(candidate!!) {
                    candidate += "_"
                }
                return candidate
            }

            // Mirrors gsc's TryGetConstantIntegerValue (ExpressionBinder.Operators.cs):
            // a foldable constant integer expression is an integer numeric literal, or a
            // unary +/- applied (recursively) to one. Floating/decimal literals and any
            // other constant form (e.g. a `const` field or `ushort.MaxValue`) are NOT
            // folded by gsc and therefore keep their explicit call-site conversion.
            private func IsFoldableIntegerLiteral(
                expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
            ) bool {
                switch expression {
                    case literal is Microsoft.CodeAnalysis.CSharp.Syntax.LiteralExpressionSyntax when literal.IsKind(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.NumericLiteralExpression
                    ) {
                        return (
                            literal
                                .Token
                                .Value is int8 or
                                uint8 or
                                int16 or
                                uint16 or
                                int32 or
                                uint32 or
                                int64 or
                                uint64
                        )
                    }
                    case unary is PrefixUnaryExpressionSyntax when unary.IsKind(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.UnaryMinusExpression
                    ) ||
                        unary
                        .IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.UnaryPlusExpression) {
                        return IsFoldableIntegerLiteral(unary.Operand)
                    }
                    default {
                        return false
                    }
                }
            }

            // gsc's ADR-0044 implicit numeric widening lattice (mirrors
            // Conversion.NumericWideningTargets), keyed on the C# SpecialType of the
            // source → set of widening targets. `char` widens like an unsigned 16-bit
            // integer; `decimal` is a widening target of every integral source.
            private func IsGSharpImplicitNumericWidening(source SpecialType, target SpecialType) bool {
                return NumericWideningTargets.TryGetValue(source, out var targets) && targets.Contains(target)
            }

            // `nameof(x)` takes a name reference, not a value, so its argument must
            // never be wrapped in a `!!` non-null assertion (GS0190).
            private func IsNameOfArgument(argument ArgumentSyntax) bool {
                return (
                    argument
                        .Parent
                        ?.Parent is InvocationExpressionSyntax and
                        {Expression: IdentifierNameSyntax and {Identifier: {ValueText: "nameof"}}}
                )
            }

            private func GetReferencedLocal(operation IOperation?) ILocalSymbol? {
                var operation = operation
                while operation is IConversionOperation conversion {
                    operation = conversion.Operand
                }
                return (operation as ILocalReferenceOperation)?.Local
            }

            private func BuildPositionalLoweredArguments(arguments IReadOnlyList[GExpression]) IReadOnlyList[
                (ParameterOrdinal int32, Value GExpression)
            ] {
                let lowered = List[(ParameterOrdinal int32, Value GExpression)](arguments.Count)
                for var index = 0; index < arguments.Count; index++ {
                    lowered.Add((index, UnwrapNamedArgument(arguments[index])))
                }
                return lowered
            }

            private func UnwrapNamedArgument(argument GExpression) GExpression -> (
                if argument is NamedArgumentExpression named {
                    named.Value
                } else {
                    argument
                }
            )

            /// Builds the canonical G# construction expression for a C# `new`:
            /// a call on the type name carrying any bracket type arguments
            /// (`List[int32](...)`, ADR-0115 §B.7).
            private func BuildConstruction(type GTypeReference?, arguments IReadOnlyList[GExpression]) GExpression {
                if type is NamedTypeReference named {
                    let typeArguments IReadOnlyList[GTypeReference]? = if named.TypeArguments.Count > 0 {
                        named.TypeArguments
                    } else {
                        default(IReadOnlyList[GTypeReference]?)
                    }
                    return InvocationExpression(
                        IdentifierExpression(ConstructionCalleeName(named.Name)),
                        arguments,
                        typeArguments
                    )
                }
                return InvocationExpression(IdentifierExpression(type!!.ToString()), arguments)
            }

            /// Maps a constructed type's G# name to a callable construction callee.
            /// A G# primitive type keyword (`object`, `string`, `decimal`,
            /// …) is a language keyword, not a function, so constructing one
            /// (`new object()`, `new string(' ', n)`, target-typed `new()`)
            /// must spell a callable CLR type name instead — otherwise gsc reports
            /// GS0130 ("Function 'string' doesn't exist"). Most aliases use a
            /// qualified name; `object`/`string` use imported
            /// `Object`/`String` because namespace-qualified constructor
            /// expressions are not bindable.
            /// Non-keyword type names are returned unchanged.
            private func ConstructionCalleeName(typeName string) string -> switch typeName {
                case "object": "Object"
                case "string": "String"
                case "bool": "System.Boolean"
                case "char": "System.Char"
                case "decimal": "System.Decimal"
                case "int8": "System.SByte"
                case "uint8": "System.Byte"
                case "int16": "System.Int16"
                case "uint16": "System.UInt16"
                case "int32": "System.Int32"
                case "uint32": "System.UInt32"
                case "int64": "System.Int64"
                case "uint64": "System.UInt64"
                case "float32": "System.Single"
                case "float64": "System.Double"
                default: typeName
            }

            private func IsConditionalOrSwitchArm(value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax) bool {
                var node Microsoft.CodeAnalysis.SyntaxNode? = value
                while (
                    node!!.Parent is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ParenthesizedExpressionSyntax or
                        CastExpressionSyntax
                ) {
                    node = node!!.Parent
                }
                return (
                    node!!.Parent is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ConditionalExpressionSyntax conditional &&
                        (conditional.WhenTrue == node || conditional.WhenFalse == node)
                ) ||
                    (
                    node!!.Parent is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .SwitchExpressionArmSyntax arm &&
                        arm.Expression == node
                )
            }

            private func ProjectionTypeFitsDestination(
                projectedType ITypeSymbol?,
                destinationType ITypeSymbol?
            ) bool -> destinationType == nil ||
                SymbolEqualityComparer
                .IncludeNullability
                .Equals(destinationType.WithNullableAnnotation(projectedType!!.NullableAnnotation), projectedType)

            private func HasFixedElementContext(value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax) bool {
                var node Microsoft.CodeAnalysis.SyntaxNode? = value
                while node!!.Parent != nil {
                    switch node!!.Parent {
                        case Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax {
                            node = node!!.Parent
                            continue
                        }
                        case CastExpressionSyntax {
                            node = node!!.Parent
                            continue
                        }
                        case argumentSyntax is ArgumentSyntax when argumentSyntax.Parent is TupleExpressionSyntax {
                            node = node!!.Parent
                            continue
                        }
                        case TupleExpressionSyntax {
                            node = node!!.Parent
                            continue
                        }
                        case initializer is InitializerExpressionSyntax {
                            if (
                                initializer.Parent is Microsoft
                                    .CodeAnalysis
                                    .CSharp
                                    .Syntax
                                    .ArrayCreationExpressionSyntax or
                                    Microsoft
                                    .CodeAnalysis
                                    .CSharp
                                    .Syntax
                                    .ObjectCreationExpressionSyntax or
                                    ImplicitObjectCreationExpressionSyntax
                            ) {
                                return true
                            }
                            node = initializer
                            continue
                        }
                        case ExpressionElementSyntax {
                            return true
                        }
                        default {
                            return false
                        }
                    }
                }
                return false
            }

            private func NullableTypeArgumentViolatesTranslatedConstraints(
                parameter ITypeParameterSymbol
            ) bool -> parameter.HasReferenceTypeConstraint ||
                parameter.HasValueTypeConstraint ||
                parameter.HasUnmanagedTypeConstraint ||
                parameter.HasConstructorConstraint ||
                !parameter
                .ConstraintTypes
                .IsEmpty

            private func TryGetProjectedTypeArgument(
                parameterType ITypeSymbol?,
                argumentType ITypeSymbol?,
                target ITypeParameterSymbol,
                compilation Compilation,
                out projectedArgument ITypeSymbol?,
                out conflictingProjection bool
            ) bool {
                let candidates = List[ITypeSymbol]()
                CollectProjectedTypeArguments(parameterType, argumentType, target, compilation, candidates)
                let firstCandidate ITypeSymbol? = candidates.FirstOrDefault()
                projectedArgument = firstCandidate
                conflictingProjection = candidates.Skip(1).Any(
                    (candidate ITypeSymbol) -> !SymbolEqualityComparer.IncludeNullability.Equals(
                        firstCandidate,
                        candidate
                    )
                )
                return projectedArgument != nil
            }

            private func CollectProjectedTypeArguments(
                parameterType ITypeSymbol?,
                argumentType ITypeSymbol?,
                target ITypeParameterSymbol,
                compilation Compilation,
                projectedArguments List[ITypeSymbol]
            ) {
                if parameterType is ITypeParameterSymbol parameter {
                    if SymbolEqualityComparer.Default.Equals(parameter.OriginalDefinition, target.OriginalDefinition) &&
                        CSharpToGSharpTranslator
                        .TypeContainsRecognizedManagedReferenceConsumer(argumentType, compilation) {
                        projectedArguments.Add(argumentType!!)
                    }
                    return
                }
                if parameterType is IArrayTypeSymbol parameterArray && argumentType is IArrayTypeSymbol argumentArray {
                    CollectProjectedTypeArguments(
                        parameterArray.ElementType,
                        argumentArray.ElementType,
                        target,
                        compilation,
                        projectedArguments
                    )
                    return
                }
                if parameterType is IPointerTypeSymbol parameterPointer &&
                    argumentType is IPointerTypeSymbol argumentPointer {
                    CollectProjectedTypeArguments(
                        parameterPointer.PointedAtType,
                        argumentPointer.PointedAtType,
                        target,
                        compilation,
                        projectedArguments
                    )
                    return
                }
                if parameterType is not INamedTypeSymbol parameterNamed ||
                    argumentType is not INamedTypeSymbol argumentNamed {
                    return
                }
                let matchingArgument INamedTypeSymbol? = ReceiverTypeHierarchy(argumentNamed).FirstOrDefault(
                    (candidate INamedTypeSymbol) -> SymbolEqualityComparer.Default.Equals(
                        candidate.OriginalDefinition,
                        parameterNamed.OriginalDefinition
                    )
                )
                if matchingArgument == nil {
                    return
                }
                for var i = 0;
                    i < parameterNamed
                    .TypeArguments
                    .Length &&
                    i < matchingArgument
                    .TypeArguments
                    .Length;
                    i++ {
                    CollectProjectedTypeArguments(
                        parameterNamed.TypeArguments[i],
                        matchingArgument.TypeArguments[i],
                        target,
                        compilation,
                        projectedArguments
                    )
                }
                if parameterNamed.ContainingType != nil && matchingArgument.ContainingType != nil {
                    CollectProjectedTypeArguments(
                        parameterNamed.ContainingType,
                        matchingArgument.ContainingType,
                        target,
                        compilation,
                        projectedArguments
                    )
                }
            }

            private func TypeContainsTypeParameter(type ITypeSymbol?, target ITypeParameterSymbol) bool {
                return (
                    type is ITypeParameterSymbol parameter && SymbolEqualityComparer.Default.Equals(
                        parameter.OriginalDefinition,
                        target.OriginalDefinition
                    )
                ) ||
                    (type is IArrayTypeSymbol array && TypeContainsTypeParameter(array.ElementType, target)) ||
                    (type is IPointerTypeSymbol pointer && TypeContainsTypeParameter(pointer.PointedAtType, target)) ||
                    (
                    type is INamedTypeSymbol named &&
                        (
                        named.TypeArguments.Any(
                            (argument ITypeSymbol) -> TypeContainsTypeParameter(argument, target)
                        ) ||
                            (named.ContainingType is {} containing && TypeContainsTypeParameter(containing, target))
                    )
                )
            }

            private func NamedTypeAndContainingTypes(type INamedTypeSymbol?) sequence[INamedTypeSymbol] {
                for var current INamedTypeSymbol? = type; current != nil; current = current!!.ContainingType {
                    yield current
                }
            }

            private func ProjectNamedType(
                type INamedTypeSymbol?,
                replacements IReadOnlyDictionary[ITypeParameterSymbol, ITypeSymbol]
            ) INamedTypeSymbol {
                var definition INamedTypeSymbol
                if type!!.ContainingType is {} containingType {
                    let projectedContainingType = ProjectNamedType(containingType, replacements)
                    definition = projectedContainingType.GetTypeMembers(type!!.Name, type!!.Arity).First(
                        (candidate INamedTypeSymbol) -> SymbolEqualityComparer.Default.Equals(
                            candidate.OriginalDefinition,
                            type!!.OriginalDefinition
                        )
                    )
                } else {
                    definition = type!!.ConstructedFrom
                }
                if type!!.TypeArguments.IsEmpty {
                    return definition
                }
                let arguments = type!!.TypeArguments.ToArray()
                for var i = 0; i < arguments.Length; i++ {
                    if replacements.TryGetValue(type!!.OriginalDefinition.TypeParameters[i], out var replacement) {
                        arguments[i] = replacement
                    }
                }
                return definition.Construct(arguments)
            }

            private func GetContainingInvocation(generic GenericNameSyntax) InvocationExpressionSyntax? {
                var expression Microsoft.CodeAnalysis.SyntaxNode? = generic
                while (expression!!.Parent is MemberAccessExpressionSyntax member && member.Name == expression) ||
                    (expression!!.Parent is MemberBindingExpressionSyntax binding && binding.Name == expression) {
                    expression = expression!!.Parent
                }
                return if expression!!.Parent is InvocationExpressionSyntax invocation &&
                    invocation.Expression == expression {
                    invocation
                } else {
                    default(InvocationExpressionSyntax?)
                }
            }
        }
    }

    shared {
        internal func MethodMayRequireManagedReferenceArrayProjection(
            method IMethodSymbol?,
            compilation Compilation
        ) bool {
            return method != nil &&
                (
                TypeContainsRecognizedManagedReferenceConsumer(method.ContainingType, compilation) ||
                    TypeContainsRecognizedManagedReferenceConsumer(method.ReceiverType, compilation) ||
                    TypeContainsRecognizedManagedReferenceConsumer(method.ReturnType, compilation) ||
                    method
                    .Parameters
                    .Any(
                    (parameter IParameterSymbol) -> TypeContainsRecognizedManagedReferenceConsumer(
                        parameter.Type,
                        compilation
                    )
                )
            )
        }

        private func TypeContainsRecognizedManagedReferenceConsumer(type ITypeSymbol?, compilation Compilation) bool {
            return type != nil &&
                (
                CSharpTypeMapper.IsRecognizedManagedReferenceConsumerType(type, compilation) ||
                    (
                    type is IArrayTypeSymbol array &&
                        TypeContainsRecognizedManagedReferenceConsumer(array.ElementType, compilation)
                ) ||
                    (
                    type is IPointerTypeSymbol pointer &&
                        TypeContainsRecognizedManagedReferenceConsumer(pointer.PointedAtType, compilation)
                ) ||
                    (
                    type is INamedTypeSymbol named &&
                        (
                        named.TypeArguments.Any(
                            (argument ITypeSymbol) -> TypeContainsRecognizedManagedReferenceConsumer(
                                argument,
                                compilation
                            )
                        ) ||
                            (
                            named.ContainingType is {} containing &&
                                TypeContainsRecognizedManagedReferenceConsumer(containing, compilation)
                        )
                    )
                )
            )
        }

        private func TypeContainsRecognizedManagedReferenceArray(type ITypeSymbol, compilation Compilation) bool {
            return if type is IArrayTypeSymbol array {
                TypeContainsRecognizedManagedReferenceConsumer(array.ElementType, compilation)
            } else {
                (
                    if type is IPointerTypeSymbol pointer {
                        TypeContainsRecognizedManagedReferenceArray(pointer.PointedAtType, compilation)
                    } else {
                        type is INamedTypeSymbol named &&
                            (
                            named.TypeArguments.Any(
                                (argument ITypeSymbol) -> TypeContainsRecognizedManagedReferenceArray(
                                    argument,
                                    compilation
                                )
                            ) ||
                                (
                                named.ContainingType is {} containing &&
                                    TypeContainsRecognizedManagedReferenceArray(containing, compilation)
                            )
                        )
                    }
                )
            }
        }
    }
}
