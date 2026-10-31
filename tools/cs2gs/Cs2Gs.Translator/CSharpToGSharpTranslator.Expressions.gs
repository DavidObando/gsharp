// <copyright file="CSharpToGSharpTranslator.Expressions.cs" company="GSharp">
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
import Cs2Gs.Translator.Analyzers
import GSharp.Core.CodeAnalysis.Syntax
import System.Text

partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        // Issue #1907: C#14's `field` contextual keyword inside a property
        // accessor is a distinct Roslyn node (FieldExpressionSyntax, NOT an
        // IdentifierNameSyntax) that binds to the compiler-synthesized backing
        // field of the enclosing property. TranslateProperty registers a real G#
        // field name for it before translating any accessor body, so by the time
        // this runs the lookup always succeeds for a property that legitimately
        // uses `field`.
        private func TranslateFieldExpression(fieldExpression FieldExpressionSyntax) GExpression {
            if this
                .context
                .GetSymbolInfo(fieldExpression)
                .Symbol is IFieldSymbol{AssociatedSymbol: IPropertySymbol owner} &&
                this
                .state
                .SynthesizedPropertyBackingFieldNames
                .TryGetValue(owner, out var backingName) {
                return IdentifierExpression(backingName)
            }
            this.context.ReportUnsupported(
                fieldExpression,
                "the C#14 `field` keyword could not be resolved to its property's synthesized backing field (ADR-0115 §B)."
            )
            return IdentifierExpression("nil")
        }

        // Issue #4302: the single place a non-invocation reference to a lifted
        // local function (an identifier or a generic method group used as a
        // value) is rewritten to its lifted helper name. Every simple-name
        // path routes through here so no reference keeps the source name
        // after a collision suffix (`First_2`).
        private func TryTranslateLiftedLocalFunctionReference(name SimpleNameSyntax, out translated GExpression?) bool {
            if this
                .context
                .GetSymbolInfo(name)
                .Symbol is IMethodSymbol recursiveLiftedLocal &&
                recursiveLiftedLocal.MethodKind == MethodKind.LocalFunction &&
                this
                .state
                .LiftedRecursiveLocalFunctions
                .TryGetValue(recursiveLiftedLocal.OriginalDefinition, out var recursiveLift) {
                // Mirrors the invocation path: a static lift lands in the
                // emitted aggregate's `shared` block, so only a site outside
                // that aggregate's sibling-static scope qualifies it.
                let recursiveOwner INamedTypeSymbol? = this
                    .state
                    .CurrentEmittedAggregate ??
                    recursiveLiftedLocal.ContainingType
                translated = this.LiftedLocalFunctionReference(
                    recursiveOwner,
                    recursiveLift.Name,
                    recursiveLift.IsStatic,
                    name
                )
                return true
            }
            if this
                .context
                .GetSymbolInfo(name)
                .Symbol is IMethodSymbol localFunction &&
                localFunction.MethodKind == MethodKind.LocalFunction &&
                this
                .state
                .LiftedStaticLocalFunctions
                .TryGetValue(localFunction.OriginalDefinition, out var liftedName) &&
                localFunction.ContainingType is {} containingType {
                let emittedOwner = this.state.CurrentEmittedAggregate ?? containingType
                translated = this.LiftedLocalFunctionReference(emittedOwner, liftedName, isStatic: true, name)
                return true
            }
            translated = nil
            return false
        }

        // Issue #4302: every reference to a lifted helper sits inside the local
        // function's enclosing member, so a same-aggregate static reference
        // stays bare. A type qualifier there could itself be captured (by a
        // local named like the owner, or by a method type parameter shadowing
        // the owner's `T`). Bare is safe because the allocator rejects every
        // source name visible in that member, and synthesized locals and
        // aliases reserve helper names (SynthesizePatternDesignator,
        // LiftedLocalFunctionNameAllocator.ClaimAlias).
        private func LiftedLocalFunctionReference(
            owner INamedTypeSymbol?,
            name string?,
            isStatic bool,
            site Microsoft.CodeAnalysis.SyntaxNode
        ) GExpression {
            if !isStatic {
                return MemberAccessExpression(ThisExpression(), name)
            }
            return if owner == nil || this.IsBareSiblingStaticScope(owner, name, site) {
                cast[GExpression](IdentifierExpression(name))
            } else {
                cast[GExpression](MemberAccessExpression(this.StaticQualifierReceiver(owner, site.GetLocation()), name))
            }
        }

        private func TranslateIdentifierName(identifier IdentifierNameSyntax) GExpression? {
            if this.TryTranslateLiftedLocalFunctionReference(identifier, out var liftedReference) {
                return liftedReference
            }
            // Issue #3399: a member of a recursive/mutually recursive SCC of
            // capturing local functions is bound through a nullable function-typed
            // local (`var X ((…) -> …)? = nil; X = func …`), so a bare reference
            // from another SCC member's closure body must go through the local
            // itself — `X` would be GS0125 at its declared type, which has the
            // `nil` default. The postfix null assertion unwraps the nullable
            // (ADR-0069), mirroring gsc's own lowering (its `var` decl also
            // emits as `(p) → R? = nil`).
            if this
                .context
                .GetSymbolInfo(identifier)
                .Symbol is IMethodSymbol recursiveLocal &&
                recursiveLocal.MethodKind == MethodKind.LocalFunction &&
                this
                .state
                .RecursiveLocalFunctionGroups
                .TryGetValue(recursiveLocal, out var recursiveGroup) &&
                recursiveGroup
                .Members
                .Contains(recursiveLocal) {
                // `IsDirectWrite` is intentionally NOT consulted: a write to a
                // function-typed function local would be a C# compile error
                // ("Cannot assign to ... because it is a local function"), so a
                // rewrite here cannot change meaning.
                return NonNullAssertionExpression(IdentifierExpression(recursiveGroup.NameOf(recursiveLocal)))
            }
            // A switch-expression property-pattern binding (`Circle { Radius: var r }`)
            // has no G# equivalent; references to the bound local are rewritten to a
            // member access on the arm's type-pattern designator (`circle.Radius`).
            if this
                .state
                .PatternBindings
                .Count > 0 &&
                !IsDirectWrite(identifier) &&
                this
                .context
                .GetSymbolInfo(identifier)
                .Symbol is {} boundSymbol &&
                this
                .state
                .PatternBindings
                .TryGetValue(boundSymbol, out var replacement) {
                return replacement
            }
            // A C# bare sibling static field/property reference (`FfAc3ChannelsTab`)
            // carries an implicit type qualifier. A G# top-level `func` (e.g. a
            // lifted extension method whose former `static class` keeps the field
            // in a `shared { }` block) or `shared` body has no implicit type scope,
            // so the reference must be qualified through the owning type
            // (`Ec3Extensions.FfAc3ChannelsTab`) — the field/property analog of the
            // bare static-call rule (ADR-0115 §B.18). Without this the binder reports
            // GS0125 (the name is not in scope at top level).
            if this
                .context
                .GetSymbolInfo(identifier)
                .Symbol is ISymbol staticMember &&
                staticMember.IsStatic &&
                (staticMember.Kind == SymbolKind.Field || staticMember.Kind == SymbolKind.Property) &&
                staticMember.ContainingType is INamedTypeSymbol owner &&
                (owner.TypeKind == TypeKind.Class || owner.TypeKind == TypeKind.Struct) &&
                !owner.IsImplicitlyDeclared &&
                (
                !this.IsStaticUsingTarget(owner) || RequiresQualifiedImportedContextualValue(staticMember, identifier)
            ) &&
                !SymbolEqualityComparer
                .Default
                .Equals(owner.OriginalDefinition, this.entryType?.OriginalDefinition) && !this.IsBareSiblingStaticScope(
                owner,
                this.EmittedName(staticMember, identifier.Identifier.ValueText),
                identifier
            ) {
                return MemberAccessExpression(
                    this.StaticQualifierReceiver(owner, identifier.GetLocation()),
                    this.EmittedName(staticMember, identifier.Identifier.ValueText)
                )
            }
            // Issue #4371: a bare (implicit-`this`) reference to a fixed-size
            // buffer field (ADR-0122 §10) needs an explicit `this.` receiver.
            // gsc's fixed-buffer-to-pointer decay (`MakeFixedBufferPointer`)
            // only fires on the explicit-receiver member-access binding path;
            // a bare `Name` inside the declaring struct's own methods binds
            // through plain identifier lookup instead, which does not decay
            // the buffer and so cannot be indexed or passed as a pointer
            // (gsc reports "is not indexable"). C# itself allows the bare
            // form, so a faithful translation must supply the qualifier C#
            // leaves implicit.
            if this.context.GetSymbolInfo(identifier).Symbol is IFieldSymbol{IsFixedSizeBuffer: true} fixedBufferField {
                return MemberAccessExpression(
                    ThisExpression(),
                    this.EmittedName(fixedBufferField, identifier.Identifier.ValueText)
                )
            }
            // A bare type used as an expression receiver (Path.Combine,
            // Task.FromResult, Console.WriteLine, ...) does not pass through
            // type-syntax translation. Map it here so SDK implicit/global
            // usings still contribute the namespace import required by G#.
            if this.context.SemanticModel.GetAliasInfo(identifier) is IAliasSymbol alias {
                return IdentifierExpression(this.EmittedName(alias, alias.Name))
            }
            if this
                .context
                .SemanticModel
                .GetAliasInfo(identifier) == nil &&
                this
                .context
                .GetSymbolInfo(identifier)
                .Symbol is INamedTypeSymbol type {
                return TypeExpression(this.typeMapper.Map(type, this.context, identifier.GetLocation()))
            }
            if identifier
                .Identifier
                .ValueText == "_" &&
                this
                .context
                .GetSymbolInfo(identifier)
                .Symbol is IParameterSymbol {
                return IdentifierExpression("__underscore")
            }
            if identifier.Identifier.ValueText == "_" && this.context.GetSymbolInfo(identifier).Symbol == nil {
                return IdentifierExpression("_")
            }
            return IdentifierExpression(this.EmittedName(identifier, identifier.Identifier))
        }

        // Issue #3471: gsc resolves a bare reference to a sibling `shared`
        // member (func, var, let — reads, writes, and calls) from anywhere
        // lexically inside the declaring aggregate's emitted body: instance
        // methods, `shared` methods, generic owners, and structs alike. The
        // implicit-type-qualifier rule (ADR-0115 §B.18) therefore only applies
        // where the emitted body actually LEAVES the type scope. Bare emission
        // requires the reference site's nearest enclosing type declaration to
        // be the owner itself: a NESTED type does not see its outer type's
        // shared members bare (GS0130), and a derived type does not see
        // inherited ones, so both stay qualified. A classic extension method's
        // body may be lifted to a top-level receiver-clause `func` (file
        // scope), so any site inside one keeps the qualifier as well — even
        // owner-scoped (#3413) extension bodies, conservatively. The member's
        // emitted name must not be claimed by any file-scope import alias,
        // imported type, or source type name — those shadow class members in
        // gsc scope resolution, so a colliding member reference keeps the
        // qualifier (the readable-alias allocator reciprocally avoids sibling
        // static member names when synthesizing new aliases). Function-literal
        // bodies need no special casing: since gsc issue #3487 was fixed,
        // bare sibling statics resolve from lambdas in shared members exactly
        // as they do in instance members.
        private func IsBareSiblingStaticScope(
            owner INamedTypeSymbol?,
            memberName string?,
            site Microsoft.CodeAnalysis.SyntaxNode
        ) bool {
            if this.typeMapper.ClaimsDocumentScopeName(memberName, this.context) {
                return false
            }
            for var node Microsoft.CodeAnalysis.SyntaxNode? = site; node != nil; node = node!!.Parent {
                if node is MethodDeclarationSyntax method && this.context.GetDeclaredSymbol(method) is IMethodSymbol{
                    IsExtensionMethod: true
                } extensionMethod {
                    return this
                        .state
                        .CurrentEmittedAggregate is {} emittedAggregate &&
                        SymbolEqualityComparer
                        .Default
                        .Equals(emittedAggregate.OriginalDefinition, owner!!.OriginalDefinition) &&
                        !SymbolEqualityComparer
                        .Default
                        .Equals(extensionMethod.ContainingType.OriginalDefinition, owner!!.OriginalDefinition)
                }
                if node is TypeDeclarationSyntax typeDeclaration {
                    return this.context.GetDeclaredSymbol(typeDeclaration) is INamedTypeSymbol siteType &&
                        SymbolEqualityComparer
                        .Default
                        .Equals(siteType.OriginalDefinition, owner!!.OriginalDefinition)
                }
            }
            return false
        }

        // Builds the receiver expression used to qualify a bare sibling static
        // member reference through its owning type. For a non-generic owner this is
        // a plain identifier (`Owner`); for a GENERIC owner it must carry the type
        // arguments (`Owner[T]`) so it does not collide with a sibling non-generic
        // type of the same simple name (e.g. `static class TreeDecomposition` beside
        // `class TreeDecomposition<T>`), which would otherwise bind the arity-0 type
        // and report GS0158 for members that live only on the generic type.
        private func StaticQualifierReceiver(owner INamedTypeSymbol?, location Location) GExpression {
            if owner!!.IsGenericType {
                return TypeExpression(this.typeMapper.Map(owner, this.context, location))
            }
            // Issue #2009: route the non-generic case through the same
            // `CSharpTypeMapper.QualifiedTypeName` logic the generic branch above
            // already uses (via `Map`), rather than the owner's bare simple name.
            // A top-level owner still prints as its bare (sanitized) name, but a
            // NESTED owner — e.g. the containing class of a C# 14 `extension`
            // block declared inside another type, or nested arbitrarily deep — is
            // qualified through its containing-type chain (`Outer.Inner`) whenever
            // its simple name collides with another source type, matching the
            // qualification the generic path already gets. Without this, a bare
            // nested owner name can bind the wrong homonymous type (or fail to
            // resolve at all) at the call site.
            let mapped GTypeReference? = this.typeMapper.Map(owner, this.context, location)
            let qualifiedName = if mapped is NamedTypeReference named {
                named.Name
            } else {
                owner!!.Name
            }
            return IdentifierExpression(qualifiedName)
        }

        private func TranslateLiteral(
            literal Microsoft.CodeAnalysis.CSharp.Syntax.LiteralExpressionSyntax
        ) GExpression {
            switch literal.Kind() {
                case Microsoft.CodeAnalysis.CSharp.SyntaxKind.NumericLiteralExpression {
                    // Preserve the original literal spelling (ADR-0115 §B.12): G#
                    // has no implicit numeric promotion, so a C# `2.0` must stay
                    // `2.0` (not collapse to `2`, which would be int32 and fail
                    // `int32 * float64`); hex such as `0xFF0000` is likewise kept
                    // verbatim. The bound type still classifies the literal kind.
                    let value object? = literal.Token.Value
                    if value is float32 || value is float64 || value is decimal {
                        return LiteralExpression.Float(literal.Token.Text)
                    }
                    // C# applies an implicit int->double/float promotion at a
                    // call site (e.g. `M(30)` where the parameter is `double`).
                    // G# has no such implicit promotion, so the emitter would push
                    // an int32 where a float64 is expected and produce invalid IL
                    // (ilverify StackUnexpected). Honor the bound `ConvertedType`
                    // and emit a float literal so the value matches its target
                    // type (ADR-0115 §B.12).
                    if this.IsConvertedToFloatingPoint(literal) {
                        return LiteralExpression.Float(this.ToFloatLiteralText(literal.Token.Value))
                    }
                    return LiteralExpression.Int(this.NormalizeIntegerLiteralText(literal))
                }
                case Microsoft.CodeAnalysis.CSharp.SyntaxKind.StringLiteralExpression {
                    return LiteralExpression.String(literal.Token.ValueText)
                }
                case Microsoft.CodeAnalysis.CSharp.SyntaxKind.Utf8StringLiteralExpression {
                    // A UTF-8 string literal `"x"u8` is a `ReadOnlySpan<byte>` of
                    // the UTF-8 encoding of the text. G# has no `u8` suffix, so emit
                    // the canonical byte slice literal `[]uint8{ … }` (ADR-0115 §B).
                    return ArrayLiteralExpression(
                        NamedTypeReference("uint8"),
                        Encoding
                            .UTF8
                            .GetBytes(literal.Token.ValueText)
                            .Select((b uint8) -> cast[GExpression](LiteralExpression.Int("0x${b:X2}")))
                            .ToList()
                    )
                }
                case Microsoft.CodeAnalysis.CSharp.SyntaxKind.CharacterLiteralExpression {
                    return LiteralExpression.Char(literal.Token.ValueText)
                }
                case Microsoft.CodeAnalysis.CSharp.SyntaxKind.TrueLiteralExpression {
                    return LiteralExpression.Bool(true)
                }
                case Microsoft.CodeAnalysis.CSharp.SyntaxKind.FalseLiteralExpression {
                    return LiteralExpression.Bool(false)
                }
                case Microsoft.CodeAnalysis.CSharp.SyntaxKind.NullLiteralExpression {
                    return this.TranslateNullLiteral(literal)
                }
                case Microsoft.CodeAnalysis.CSharp.SyntaxKind.DefaultLiteralExpression {
                    // The target-typed `default` literal maps to G# `default(T)`
                    // for the converted (target) type when that type is known, so
                    // the value is self-typed. A bare typeless `default` relies on
                    // surrounding context for its type, but common positions supply
                    // none: an inferred `var retval = default` (the C# type was
                    // erased to the initializer's natural type, which for `default`
                    // is the target type, so the local-declaration path omits the
                    // clause and infers — yet bare `default` has nothing to infer
                    // from) surfaces GS0362. Emitting `default(T)` keeps it valid
                    // everywhere (ADR-0100). Falls back to bare `default` only when
                    // the type is genuinely unavailable.
                    return DefaultValueExpression(this.ResolveDefaultLiteralType(literal))
                }
                default {
                    this.context.ReportUnsupported(
                        literal,
                        "literal '${literal.Kind()}' has no canonical G# form yet; emitted nil (ADR-0115 §B.12)."
                    )
                    return LiteralExpression.Null()
                }
            }
        }

        // Issue #5508: a `null` literal whose slot is DECLARED as a non-nullable
        // reference and will STAY one in the emitted G#. C# let the author write
        // `null` there: the project was nullable-oblivious, the file is
        // `<auto-generated/>` (the compiler reports no nullable diagnostics in
        // it), or the member overrides a base declaration whose signature the
        // override cannot widen. gsc rejects `nil` at such a slot since #4316
        // (GS0155 for a return or assignment, GS0154 for an argument), and there
        // is no `!!` for "put null into a non-null slot".
        //
        // `default(T)` is the spelling gsc accepts there and it is the same
        // value: the zero reference, exactly what the C# stored. The decision
        // is `TargetWillRemainNonNullableReference`, the one question every
        // sink-lowering already asks, so a slot that a promotion widens (the
        // #5508 null-argument rule, the #3676 generated-code rule, #2113's
        // taint) keeps the plain `nil` the widened `T?` accepts.
        //
        // The evidence is the file's, not the slot's: an `<auto-generated/>`
        // file, where the C# compiler reported no nullable diagnostic at all
        // (#3676). A `null` or `null!` in hand-authored code stays `nil`, so gsc
        // keeps rejecting a genuinely non-null sink (the policy pinned by
        // `SuppressNullableWarning_OnNullLiteral_PreservesTargetChecking`).
        //
        // Scoped to the three positions where a DECLARATION settles the slot —
        // return, simple assignment, argument — the same ones the `default`
        // rewrite above uses.
        private func TranslateNullLiteral(
            literal Microsoft.CodeAnalysis.CSharp.Syntax.LiteralExpressionSyntax
        ) GExpression {
            let slot = this.DeclaredNullSlot(literal)
            if ObliviousNullabilityAnalyzer.HasAutoGeneratedHeader(literal.SyntaxTree) &&
                slot.Type is {IsReferenceType: true} declared &&
                declared.NullableAnnotation != Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated &&
                this
                .TargetWillRemainNonNullableReference(declared, slot.Symbol) {
                let mapped = this.typeMapper.Map(declared, this.context, literal.GetLocation())
                if mapped is {IsNullable: false} nonNullable {
                    return DefaultValueExpression(nonNullable)
                }
            }
            return LiteralExpression.Null()
        }

        // The declared type and symbol of what `owner` returns: a method or local
        // function (awaited result for an async one), or a property, indexer or
        // getter, whose slot is the property.
        private func ReturnSlotOf(owner Microsoft.CodeAnalysis.SyntaxNode?)(Type ITypeSymbol?, Symbol ISymbol?) {
            switch owner {
                case Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .PropertyDeclarationSyntax or
                    Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .IndexerDeclarationSyntax {
                    if this.context.GetDeclaredSymbol(owner) is IPropertySymbol property {
                        return (property.Type, property)
                    }
                    return (nil, nil)
                }
                case Microsoft.CodeAnalysis.CSharp.Syntax.AccessorDeclarationSyntax accessor {
                    if accessor.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.GetAccessorDeclaration) &&
                        this
                        .context
                        .GetDeclaredSymbol(accessor) is IMethodSymbol{
                        AssociatedSymbol: IPropertySymbol getterProperty
                    } {
                        return (getterProperty.Type, getterProperty)
                    }
                    return (nil, nil)
                }
                case Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .BaseMethodDeclarationSyntax or
                    Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .LocalFunctionStatementSyntax {
                    if this.context.GetDeclaredSymbol(owner) is not IMethodSymbol method {
                        return (nil, nil)
                    }
                    var declared = method.ReturnType
                    if method.IsAsync &&
                        declared is INamedTypeSymbol{IsGenericType: true, TypeArguments: {Length: 1}} awaitable {
                        declared = awaitable.TypeArguments[0]
                    }
                    return (declared, method)
                }
                default {
                    return (nil, nil)
                }
            }
        }

        // The declared type and symbol of the slot a `null` literal flows into,
        // looking through parentheses and a `!`: a `return`, the right side of a
        // simple assignment, or a positional argument. Anything else has no
        // declaration that settles it here.
        private func DeclaredNullSlot(literal Microsoft.CodeAnalysis.CSharp.Syntax.LiteralExpressionSyntax)(
            Type ITypeSymbol?,
            Symbol ISymbol?
        ) {
            var node Microsoft.CodeAnalysis.SyntaxNode = literal
            while node.Parent is {} parent &&
                (
                parent is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax || parent.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.SuppressNullableWarningExpression
                )
            ) {
                node = parent
            }
            switch node.Parent {
                case Microsoft.CodeAnalysis.CSharp.Syntax.ReturnStatementSyntax returnStatement {
                    let owner Microsoft.CodeAnalysis.SyntaxNode? = returnStatement.Ancestors().FirstOrDefault(
                        (n Microsoft.CodeAnalysis.SyntaxNode) -> n is Microsoft
                            .CodeAnalysis
                            .CSharp
                            .Syntax
                            .BaseMethodDeclarationSyntax ||
                            n is Microsoft
                            .CodeAnalysis
                            .CSharp
                            .Syntax
                            .AccessorDeclarationSyntax ||
                            n is Microsoft
                            .CodeAnalysis
                            .CSharp
                            .Syntax
                            .LocalFunctionStatementSyntax ||
                            n is Microsoft
                            .CodeAnalysis
                            .CSharp
                            .Syntax
                            .AnonymousFunctionExpressionSyntax
                    )
                    return this.ReturnSlotOf(owner)
                }
                case Microsoft.CodeAnalysis.CSharp.Syntax.ArrowExpressionClauseSyntax arrow {
                    return this.ReturnSlotOf(arrow.Parent)
                }
                case Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax assignment when assignment.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.SimpleAssignmentExpression
                ) &&
                    assignment.Right == node {
                    let target ISymbol? = this.context.GetSymbolInfo(assignment.Left).Symbol
                    return switch target {
                        case parameter is IParameterSymbol: (parameter.Type, target)
                        case local is ILocalSymbol: (local.Type, target)
                        case field is IFieldSymbol: (field.Type, target)
                        case property is IPropertySymbol: (property.Type, target)
                        default: (nil, nil)
                    }
                }
                case Microsoft.CodeAnalysis.CSharp.Syntax.ArgumentSyntax argument when argument.RefKindKeyword.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.None
                ) &&
                    argument.Parent is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .BaseArgumentListSyntax argumentList &&
                    this
                    .context
                    .GetSymbolInfo(argumentList.Parent)
                    .Symbol is IMethodSymbol callee {
                    // A named argument binds by name, a positional one by position.
                    var parameter IParameterSymbol? = nil
                    if argument.NameColon is {} nameColon {
                        let name = nameColon.Name.Identifier.ValueText
                        parameter = callee.Parameters.FirstOrDefault((p IParameterSymbol) -> p.Name == name)
                    } else {
                        let index = argumentList.Arguments.IndexOf(argument)
                        if index >= 0 && index < callee.Parameters.Length {
                            parameter = callee.Parameters[index]
                        }
                    }
                    if parameter == nil || parameter.IsParams {
                        return (nil, nil)
                    }
                    return (parameter.Type, parameter)
                }
                default {
                    return (nil, nil)
                }
            }
        }

        // Issue #3676: the target type a bare `default` is rendered against.
        //
        // `ResolveExpressionType` reads `ConvertedType`, whose nullable
        // annotation on a `default` literal is FLOW-derived, not declared:
        // Roslyn types `return default;` in an unconstrained `T`-returning
        // method as `T?` to model "maybe default", even though the return type
        // the author declared is a bare `T`. `CSharpTypeMapper` then honours
        // that `?` (an annotated type parameter is the one case where `?`
        // survives on a non-reference type), emitting `default(T?)` into a `T`
        // slot — which gsc rejects, since G#'s `T?` on an unconstrained
        // parameter is a genuinely different type, not a flow state
        // (GS0155 `T?` -> `T`).
        //
        // For such a target the honest emission is `default(T)`: it is exactly
        // what C# `default` means there (the zero value, `initobj T`), and it
        // still converts into a `T?` slot, so dropping a FLOW `?` can only
        // widen what binds.
        //
        // The rewrite is scoped to positions where a DECLARED type settles the
        // question and no flow state can reach it: the RETURN value, the
        // right-hand side of a simple ASSIGNMENT, and an ARGUMENT. Issue #3907
        // added the last two — `Gsharp.Runtime.Channels` is full of
        // `[MaybeNullWhen(false)] out T value` parameters whose bodies say
        // `value = default;`, which the return-only rewrite left as
        // `default(T?)` in a `T` slot.
        //
        // Argument position reads the SUBSTITUTED parameter type, which is what
        // keeps issue #2500 intact: `Same<T?>(default)` resolves to a parameter
        // of type `T?` (annotated) and keeps its `?`, while
        // `ReceiveResult[T](default, false)` resolves to one of type `T` and
        // drops it. Everywhere else an annotated type parameter on a
        // `default` may be a genuinely AUTHORED `T?` that issue #2500 exists to
        // preserve — `Same<T?>(default)` / `Task.FromResult<T?>(default)` write
        // the nullable type argument explicitly and must keep emitting
        // `default(T?)`.
        private func ResolveDefaultLiteralType(
            literal Microsoft.CodeAnalysis.CSharp.Syntax.LiteralExpressionSyntax
        ) GTypeReference? {
            let resolved GTypeReference? = this.ResolveExpressionType(literal)
            let info = this.context.GetTypeInfo(literal)
            return if (info.ConvertedType ?? info.Type) is ITypeParameterSymbol &&
                resolved is NamedTypeReference{IsNullable: true} named &&
                this
                .TargetIsBareTypeParameter(literal) {
                cast[GTypeReference](NamedTypeReference(named.Name, named.TypeArguments, named.ContainingType))
            } else {
                resolved
            }
        }

        // Whether the slot `literal` flows into is DECLARED as an unannotated
        // type parameter, in any of the three positions where a declaration
        // settles it (issue #3676 for returns, #3907 for the other two).
        private func TargetIsBareTypeParameter(
            literal Microsoft.CodeAnalysis.CSharp.Syntax.LiteralExpressionSyntax
        ) bool {
            return this.ReturnsBareTypeParameter(literal) || this.AssignedToBareTypeParameter(literal) ||
                this.PassedToBareTypeParameter(literal)
        }

        // `value = default;` where `value` is declared `T` — most often an
        // `[MaybeNullWhen(false)] out T`, whose attribute makes Roslyn's flow
        // state maybe-null while the declared type stays a bare `T`.
        private func AssignedToBareTypeParameter(
            literal Microsoft.CodeAnalysis.CSharp.Syntax.LiteralExpressionSyntax
        ) bool {
            if literal.Parent is not Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .AssignmentExpressionSyntax assignment ||
                !assignment.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.SimpleAssignmentExpression) ||
                assignment.Right != literal {
                return false
            }
            let target ISymbol? = this.context.GetSymbolInfo(assignment.Left).Symbol
            let declared ITypeSymbol? = switch target {
                case parameter is IParameterSymbol: parameter.Type
                case local is ILocalSymbol: local.Type
                case field is IFieldSymbol: field.Type
                case property is IPropertySymbol: property.Type
                default: default(ITypeSymbol?)
            }
            return IsBareTypeParameter(declared)
        }

        // `M(default)` where the parameter is declared `T`. The parameter type
        // is read off the RESOLVED (substituted) symbol, so an explicitly
        // nullable type argument — `Same<T?>(default)`, issue #2500 — presents
        // as annotated and keeps its `?`.
        private func PassedToBareTypeParameter(
            literal Microsoft.CodeAnalysis.CSharp.Syntax.LiteralExpressionSyntax
        ) bool {
            if literal.Parent is not ArgumentSyntax argument ||
                argument.Parent is not BaseArgumentListSyntax argumentList ||
                argument.NameColon != nil {
                return false
            }
            if this.context.GetSymbolInfo(argumentList.Parent).Symbol is not IMethodSymbol method {
                return false
            }
            let index = argumentList.Arguments.IndexOf(argument)
            if index < 0 || index >= method.Parameters.Length {
                // A `params` tail, or an argument list this overload does not
                // line up with positionally; not a slot a declaration settles.
                return false
            }
            return IsBareTypeParameter(method.Parameters[index].Type)
        }

        // Whether `literal` is the value of a `return` in a method or local
        // function whose DECLARED result is an unannotated type parameter. An
        // async method's result is the awaited one (`async Task<T>` declares
        // `T`), matching what `return default;` is target-typed to.
        private func ReturnsBareTypeParameter(
            literal Microsoft.CodeAnalysis.CSharp.Syntax.LiteralExpressionSyntax
        ) bool {
            if literal.Parent is not Microsoft.CodeAnalysis.CSharp.Syntax.ReturnStatementSyntax returnStatement {
                return false
            }
            let owner Microsoft.CodeAnalysis.SyntaxNode? = returnStatement.Ancestors().FirstOrDefault(
                (node Microsoft.CodeAnalysis.SyntaxNode) -> node is BaseMethodDeclarationSyntax ||
                    node is LocalFunctionStatementSyntax ||
                    node is AnonymousFunctionExpressionSyntax
            )
            if !((owner is BaseMethodDeclarationSyntax || owner is LocalFunctionStatementSyntax)) ||
                this
                .context
                .GetDeclaredSymbol(owner) is not IMethodSymbol method {
                return false
            }
            var declared = method.ReturnType
            if method.IsAsync &&
                declared is INamedTypeSymbol{IsGenericType: true, TypeArguments: {Length: 1}} awaitable {
                declared = awaitable.TypeArguments[0]
            }
            return declared is ITypeParameterSymbol &&
                declared.NullableAnnotation != Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated
        }

        // C# infers the type of a suffix-less integer literal from its value: a
        // hex constant such as `0xD800000000000000` is implicitly `ulong`. G#'s
        // lexer instead defaults to int32/int64 and rejects an out-of-range
        // literal (GS0004), so when the bound value requires a wider/unsigned
        // type we append the matching G# suffix (`L`, `UL`, `U`).
        private func NormalizeIntegerLiteralText(
            literal Microsoft.CodeAnalysis.CSharp.Syntax.LiteralExpressionSyntax
        ) string {
            let text = literal.Token.Text
            let value object? = literal.Token.Value
            // Respect an explicit suffix already present in the source spelling.
            if text.Length > 0 && ((text[text.Length - 1] is 'u' or 'U' or 'l' or 'L')) {
                return text
            }
            // Issue #3684 (family F14): the width suffix must come from the type
            // of the NEGATED expression, not the bare literal. C# §12.9.3 gives
            // `-2147483648` the type `int` (value int.MinValue) even though the
            // literal `2147483648` on its own is `uint`, and Roslyn records that
            // only on the enclosing unary node. Suffixing off the literal
            // produced `-2147483648U`, which G# rejects outright — it has no
            // unary `-` on uint32 (GS0128). Take the negated expression's own
            // bound type instead, and never emit an UNSIGNED suffix under a
            // minus: an unsigned operand is exactly what makes the operator
            // undefined.
            if literal.Parent is PrefixUnaryExpressionSyntax negation && negation.IsKind(
                Microsoft.CodeAnalysis.CSharp.SyntaxKind.UnaryMinusExpression
            ) {
                return switch this.context.GetTypeInfo(negation).Type?.SpecialType {
                    case SpecialType.System_Int64: text + "L"
                    default: text
                }
            }
            switch value {
                case _ is uint64 {
                    return text + "UL"
                }
                case l is int64 when l > int64(int32.MaxValue) || l < int64(int32.MinValue) {
                    return text + "L"
                }
                case u is uint32 when u > uint32(int32.MaxValue) {
                    return text + "U"
                }
                default {
                    return text
                }
            }
        }

        private func IsConvertedToFloatingPoint(
            literal Microsoft.CodeAnalysis.CSharp.Syntax.LiteralExpressionSyntax
        ) bool {
            let info = this.context.GetTypeInfo(literal)
            let original ITypeSymbol? = info.Type
            let converted ITypeSymbol? = info.ConvertedType
            if converted == nil || SymbolEqualityComparer.Default.Equals(original, converted) {
                return false
            }
            let originalIsIntegral = original != nil &&
                (
                original.SpecialType == SpecialType.System_SByte ||
                    original.SpecialType == SpecialType.System_Byte ||
                    original.SpecialType == SpecialType.System_Int16 ||
                    original.SpecialType == SpecialType.System_UInt16 ||
                    original.SpecialType == SpecialType.System_Int32 ||
                    original.SpecialType == SpecialType.System_UInt32 ||
                    original.SpecialType == SpecialType.System_Int64 ||
                    original.SpecialType == SpecialType.System_UInt64
            )
            let convertedIsFloat = converted.SpecialType == SpecialType.System_Single ||
                converted.SpecialType == SpecialType.System_Double
            return originalIsIntegral && convertedIsFloat
        }

        private func ToFloatLiteralText(value object?) string {
            // The token's *spelling* can be hex (`0xFF`), binary (`0b1010`),
            // digit-separated (`1_000`), or suffixed (`30L`); appending ".0" to
            // that raw text either produces an invalid G# float (`0xFF.0`,
            // `30L.0`) or silently misses cases that already contain a stray
            // 'e'/'E' hex digit (`0xAE`). Deriving the text from the token's
            // already-parsed *value* instead sidesteps spelling entirely: format
            // the numeric value as decimal and ensure it carries a fractional
            // part so the G# lexer classifies it as float64.
            let number = Convert.ToDouble(value, CultureInfo.InvariantCulture)
            let text = number.ToString("R", CultureInfo.InvariantCulture)
            return if text.IndexOfAny([]char{'.', 'e', 'E'}) >= 0 {
                text
            } else {
                text + ".0"
            }
        }

        /// Translates a C# anonymous object creation (`new { A = 1, B = 2 }`)
        /// to a positional construction of a synthesized G# `data class`
        /// (`AnonymousType0(1, 2)`, issues #2282 and #2538). See
        /// (cref:CSharpTypeMapper.GetOrCreateAnonymousDataClass) for why
        /// a synthesized, shape-deduplicated data class supersedes both the
        /// original positional-tuple lowering (issue #1934, which dropped
        /// member names) and the intermediate `object { }` anonymous-value
        /// literal (issue #2224, which cannot be spelled as an explicit TYPE —
        /// e.g. a lambda parameter's type inferred from another lambda's
        /// anonymous-typed return value, issue #2282's actual repro shape). A
        /// positional class construction — unlike a tuple literal — is legal
        /// inside an expression-tree lambda. It also remains a direct
        /// expression when used as a constructor-delegation argument; a class
        /// composite literal lowers to setup statements before the delegation
        /// and violates G#'s delegation-first rule (issue #2538).
        private func TranslateAnonymousObjectCreation(anonymous AnonymousObjectCreationExpressionSyntax) GExpression {
            this.context.Report(
                TranslationDiagnostic(
                    "AnonymousObjectCreationExpression",
                    "anonymous object creation 'new { ... }' maps to positional construction of a synthesized G# 'data class' (issues #2282 and #2538); gsc reuses the same synthesized type for every structurally-identical anonymous-type shape, preserving named-member access at both the construction site and any type-position use.",
                    anonymous.GetLocation(),
                    TranslationSeverity.Info
                )
            )
            let anonymousType INamedTypeSymbol? = this.context.GetTypeInfo(anonymous).Type as INamedTypeSymbol
            let anonymousProperties = anonymousType
                ?.GetMembers()
                .OfType[IPropertySymbol]()
                .ToList() ??
                List[IPropertySymbol]()
            var mappedPropertyTypes = anonymousProperties.Select(
                (property IPropertySymbol, index int32) -> this.typeMapper.Map(
                    if index < anonymous.Initializers.Count {
                        this.GetManagedReferenceArrayProjectedExpressionType(
                            anonymous.Initializers[index].Expression
                        ) ??
                            property.Type
                    } else {
                        property.Type
                    },
                    this.context,
                    anonymous.GetLocation()
                )!!
            )
                .ToList()
            var nullablePropertyFlags = mappedPropertyTypes.Select(
                (propertyType GTypeReference, index int32) -> propertyType.IsNullable ||
                    (
                    index < anonymous.Initializers.Count && this.AnonymousInitializerAcceptsNil(
                        anonymous.Initializers[index].Expression
                    )
                )
            )
                .ToList()
            mappedPropertyTypes = mappedPropertyTypes.Select(
                (propertyType GTypeReference, index int32) -> if nullablePropertyFlags[index] {
                    MakeNullable(propertyType)!!
                } else {
                    propertyType
                }
            )
                .ToList()
            let shape(
                Type GTypeReference,
                Properties IReadOnlyList[IPropertySymbol],
                PropertyTypes IReadOnlyList[GTypeReference]?
            ) = if anonymousType != nil {
                this.typeMapper.GetOrCreateAnonymousDataClassShape(
                    anonymousType,
                    this.context,
                    anonymous.GetLocation(),
                    mappedPropertyTypes
                )
            } else {
                (
                    NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType),
                    Array.Empty[IPropertySymbol](),
                    Array.Empty[GTypeReference]()
                )
            }
            mappedPropertyTypes = shape.PropertyTypes!!.ToList()
            nullablePropertyFlags = mappedPropertyTypes.Select((propertyType GTypeReference) -> propertyType.IsNullable)
                .ToList()
            // Roslyn exposes anonymous properties in constructor order. Drive
            // construction from that same registered order rather than an
            // independent member enumeration so declaration and call arity/order
            // cannot diverge across files or projects.
            let arguments = if shape.Properties.Count == anonymous.Initializers.Count {
                shape
                    .Properties
                    .Select(
                    (property IPropertySymbol, index int32) -> {
                        let value = anonymous.Initializers[index].Expression
                        let propertyType = mappedPropertyTypes[index]
                        let targetType = if nullablePropertyFlags[index] {
                            property.Type.WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.Annotated)
                        } else {
                            property.Type
                        }
                        let translated GExpression? = this.ForgiveNullableReferenceValue(
                            value,
                            this.TranslateExpression(value),
                            targetType,
                            targetSymbol: nil,
                            includePromotedValue: true
                        )
                        return this.AssertFlowNarrowedNullableReference(value, translated, propertyType)!!
                    }
                )
                    .ToList()
            } else {
                anonymous
                    .Initializers
                    .Select(
                    (initializer AnonymousObjectMemberDeclaratorSyntax) -> this.TranslateExpression(
                        initializer.Expression
                    )!!
                )
                    .ToList()
            }
            return BuildConstruction(shape.Type, arguments)
        }

        private func AnonymousInitializerAcceptsNil(value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?) bool {
            var value = value
            value = Unparenthesize(value)
            if value.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.DefaultLiteralExpression) ||
                value is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .DefaultExpressionSyntax {
                return this.DefaultExpressionAcceptsNil(value)
            }
            return IsNullOrSuppressedNull(value) || ObliviousNullabilityAnalyzer.IsSemanticallyNullableInitializer(
                value,
                this.context.SemanticModel
            ) ||
                value is ConditionalAccessExpressionSyntax ||
                value.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.AsExpression) ||
                (value is CastExpressionSyntax cast && this.AnonymousInitializerAcceptsNil(cast.Expression)) ||
                (
                value is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ConditionalExpressionSyntax conditional &&
                    (
                    this.AnonymousInitializerAcceptsNil(conditional.WhenTrue) || this.AnonymousInitializerAcceptsNil(
                        conditional.WhenFalse
                    )
                )
            ) ||
                (
                value is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .SwitchExpressionSyntax switchExpression &&
                    switchExpression
                    .Arms
                    .Any(
                    (
                        arm Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionArmSyntax
                    ) -> this.AnonymousInitializerAcceptsNil(arm.Expression)
                )
            )
        }

        private func DefaultExpressionAcceptsNil(value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?) bool {
            let type ITypeSymbol? = this
                .context
                .GetTypeInfo(value)
                .ConvertedType ??
                this
                .context
                .GetTypeInfo(value)
                .Type
            return type?.IsReferenceType == true ||
                type
                ?.OriginalDefinition
                .SpecialType == SpecialType.System_Nullable_T
        }

        private func TranslateMemberAccess(member MemberAccessExpressionSyntax) GExpression? {
            // ADR-0169 analyzer mode: idioms that need more than a member
            // rename (e.g. name.Identifier -> expr.GetLastToken()).
            if this.InAnalyzerApiMode && this.TryTranslateAnalyzerMemberAccess(member, out var analyzerIdiom) {
                return analyzerIdiom
            }
            // Issue #4350 (review): `this.P = v` (or `Type.P = v`) in a
            // constructor targets the synthesized backing field of a lowered
            // static/virtual/override get-only auto-property, exactly like the
            // bare `P = v` form handled in EmittedName.
            if this
                .context
                .GetSymbolInfo(member)
                .Symbol is IPropertySymbol loweredProperty &&
                IsWriteTarget(member.Name) &&
                this
                .IsBackingFieldLoweredGetOnlyAutoProperty(loweredProperty) {
                let backingName = this.RegisterSynthesizedPropertyBackingField(
                    loweredProperty,
                    primaryCtorParamNames: nil
                )
                return if loweredProperty.IsStatic {
                    cast[GExpression](IdentifierExpression(backingName))
                } else {
                    cast[GExpression](MemberAccessExpression(this.TranslateExpression(member.Expression), backingName))
                }
            }
            // C# permits namespace-qualified type expressions without importing
            // their namespace, including relative qualification from the current
            // namespace. G# resolves expression receivers as values/types, not as
            // C# namespace paths. Collapse the whole bound type expression through
            // the type mapper so it emits the canonical type name and records the
            // namespace import needed by the generated file.
            if this.context.GetSymbolInfo(member).Symbol is INamedTypeSymbol qualifiedType {
                return TypeExpression(this.typeMapper.Map(qualifiedType, this.context, member.GetLocation()))
            }
            // Issue #2351: a bare (non-invoked) reference to an extension
            // method's method group (e.g. assigned to a delegate) never goes
            // through TranslateInvocation, so track its declaring namespace
            // here too — otherwise a file relying on an implicit/global
            // `using` for that namespace would translate with no import.
            if this.context.GetSymbolInfo(member).Symbol is IMethodSymbol{IsExtensionMethod: true} memberExtMethod {
                this.typeMapper.TrackExtensionMethodNamespace(memberExtMethod)
                let isInvocationTarget = member.Parent is InvocationExpressionSyntax invocation &&
                    invocation.Expression == member
                if memberExtMethod.MethodKind == MethodKind.ReducedExtension &&
                    !isInvocationTarget &&
                    this
                    .TryGetStaticExtensionHelperForMethodGroup(
                    memberExtMethod,
                    out var helperOwner,
                    out var helperName
                ) {
                    if member.Parent is ArgumentSyntax nameOfArgument && IsNameOfArgument(nameOfArgument) {
                        return MemberAccessExpression(IdentifierExpression(helperOwner), helperName)
                    }
                    return this.TranslateStaticExtensionHelperMethodGroup(
                        member,
                        memberExtMethod,
                        helperOwner,
                        helperName
                    )
                }
            }
            // Issue #1879: a C# 14 extension-block member is declared on a
            // synthetic marker type (`INamedTypeSymbol.IsExtension`); rewrite its
            // call sites to the real emitted G# shape before falling into the
            // generic member-access translation below.
            if this
                .context
                .GetSymbolInfo(member)
                .Symbol is {} extSymbol &&
                TryGetExtensionBlockOwner(extSymbol, out var extOwner) {
                if extSymbol.IsStatic {
                    // A static extension member is accessed through the EXTENDED
                    // type's name (`string.Repeat(...)`, `string.Meaning`), but is
                    // emitted as a plain static member of the declaring class (no
                    // receiver-clause form exists for statics, ADR-0115 §B.19).
                    // Rewrite the qualifier to the real owner; the (predefined- or
                    // named-type) qualifier syntax on the C# side carries no value
                    // to translate. Issue #2009: use the same fully-qualified
                    // (nested-type-aware, generic-aware) owner receiver as a bare
                    // sibling static call/member (`StaticQualifierReceiver`),
                    // rather than the owner's bare simple name — a bare name is
                    // wrong when the extension block's containing class is nested
                    // inside another type or shares its simple name with another
                    // source type elsewhere in the compilation.
                    return MemberAccessExpression(
                        this.StaticQualifierReceiver(extOwner, member.GetLocation()),
                        this.EmittedName(extSymbol, member.Name.Identifier.ValueText)
                    )
                }
                if extSymbol is IPropertySymbol {
                    // `nameof(word.DoubledLength)` binds to the very same property
                    // symbol as an ordinary read, but `nameof` takes a name
                    // reference, not a value (G#'s NameOfExpression parses its
                    // argument as a plain expression and the binder rejects
                    // anything but a name/member-access/generic-name). Wrapping
                    // in a zero-arg call here would print `nameof(word.DoubledLength())`,
                    // which re-parses as a call and is rejected — leave the bare
                    // member access; its printed name is exactly the lowered
                    // func's name, so `nameof` still resolves correctly.
                    if member.Parent is ArgumentSyntax nameOfArgument && IsNameOfArgument(nameOfArgument) {
                        return MemberAccessExpression(
                            this.TranslateExpression(member.Expression),
                            this.EmittedName(extSymbol, member.Name.Identifier.ValueText)
                        )
                    }
                    // An instance extension property has no receiver-clause form
                    // in G#'s `prop` grammar and is lowered to a get-only
                    // receiver-clause `func` of the same name (ADR-0115 §B.19);
                    // a bare property read becomes a zero-argument call.
                    let extReceiver GExpression? = this.TranslateReceiverWithNullForgiveness(member.Expression)
                    return InvocationExpression(
                        MemberAccessExpression(
                            extReceiver,
                            this.EmittedName(extSymbol, member.Name.Identifier.ValueText)
                        ),
                        List[GExpression](),
                        nil
                    )
                }
                // An instance extension METHOD needs no rewrite: it is emitted as
                // a receiver-clause `func`, which is invoked with the same
                // `receiver.Method(args)` call syntax as the C# source (exactly
                // like a classic `this T x` extension method), so it falls
                // through to the generic member-access translation below.

            }
            // Member access on a bare-identifier element access (`values[i].M`)
            // previously hit a G# parser ambiguity (#942); that gap is now fixed,
            // so the construct translates through the normal member-access path.
            //
            // When the member binds to an extension method whose `this` parameter
            // is itself nullable (`this T? x`), the method is *meant* to be invoked
            // on a possibly-null receiver and handles null internally (e.g.
            // `Ac4DsiV1.SampleRate()` over `static int? SampleRate(this Ac4DsiV1?)`).
            // Forgiving the receiver to non-null (`Ac4DsiV1!!`) changes its static
            // type to the non-null `Ac4DsiV1`, which gsc's extension-method lookup
            // does not match against the `Ac4DsiV1?` `this` slot (GS0159). Keep the
            // declared-nullable receiver so the extension resolves.
            // A C# nullable *value* type (`T?` lowering to `System.Nullable<T>`)
            // exposes `.Value` and `.HasValue`. Runtime lambdas use G#'s idiomatic
            // `x!!` unwrap, but `!!` is forbidden in expression trees: retain
            // `.Value` there so lowering produces the CLR Nullable<T>.Value
            // property node. `HasValue` remains the plain `x != nil` null test.
            // Guard on the receiver's *declared* type being `System.Nullable<T>` so
            // a user type with a member literally named `Value`/`HasValue` is
            // unaffected. Nullable *reference* types (`string?`) have a non-
            // `Nullable<T>` receiver type and are likewise left alone.
            if this
                .context
                .GetTypeInfo(member.Expression)
                .Type is {} receiverType &&
                receiverType
                .OriginalDefinition
                ?.SpecialType == SpecialType
                .System_Nullable_T {
                switch member.Name.Identifier.Text {
                    case "Value" {
                        let nullableValue GExpression? = this.TranslateExpression(member.Expression)
                        return if this.IsWithinExpressionTreeLambda(member.Expression) {
                            cast[GExpression](MemberAccessExpression(nullableValue, "Value"))
                        } else {
                            EnsureNonNullAssertion(nullableValue)
                        }
                    }
                    case "HasValue" {
                        // Parenthesize the null test so it composes correctly
                        // under any surrounding operator. C# `!x.HasValue` would
                        // otherwise translate to `!x != nil`, which G# parses as
                        // `(!x) != nil` (GS0128); `!(x != nil)` is always correct.
                        return ParenthesizedExpression(
                            BinaryExpression(
                                this.TranslateExpression(member.Expression),
                                "!=",
                                LiteralExpression.Null()
                            )
                        )
                    }
                }
            }
            // Issue #2282 (was #2224, #1934): an anonymous-typed receiver (`new
            // { ... }`) is a C# reference type, so the flow-based passes below
            // would otherwise wrap it in a G# `!!` non-null assertion. The
            // receiver now lowers to a composite literal constructing a
            // synthesized `data class` — skip forgiveness for anonymous-type
            // receivers regardless: a `new { ... }` expression's own value can
            // never be null, so wrapping it would be meaningless (and,
            // historically, hit a gsc IL-emission gap for the earlier
            // value-type-based lowering this replaces).
            let receiverIsAnonymousType = this.context.GetTypeInfo(member.Expression).Type is {IsAnonymousType: true}
            var target GExpression?
            var __spill0 ISymbol?
            var receiverNamedType INamedTypeSymbol?
            if this.context.SemanticModel.GetAliasInfo(member.Expression) == nil && {
                __spill0 = this.context.GetSymbolInfo(member.Expression).Symbol
                __spill0 is INamedTypeSymbol && __spill0.IsGenericType == true && {
                    receiverNamedType = (__spill0 as INamedTypeSymbol)!!
                    true
                }
            } {
                if member.Parent is InvocationExpressionSyntax invocation &&
                    invocation.Expression == member &&
                    this
                    .TryGetManagedReferenceArrayProjectedMethod(invocation, out var projectedMethod) {
                    receiverNamedType = projectedMethod!!.ContainingType
                }
                // A qualified generic type is a MemberAccessExpressionSyntax;
                // translate its bound type so its type arguments are retained.
                target = TypeExpression(
                    this.typeMapper.Map(receiverNamedType!!, this.context, member.Expression.GetLocation())
                )
            } else {
                target = if this.MemberBindsToNullableThisExtension(member) || receiverIsAnonymousType {
                    this.TranslateExpression(member.Expression)
                } else {
                    this.TranslateReceiverWithNullForgiveness(member.Expression)
                }
            }
            var memberName string? = member.Name.Identifier.ValueText
            var memberSymbol ISymbol? = this.context.GetSymbolInfo(member).Symbol
            // Issue #1905: C# pointer member access (`p->X`) and plain member
            // access (`p.X`) both parse as MemberAccessExpressionSyntax,
            // distinguished only by member.Kind() (PointerMemberAccessExpression
            // for `->`). gsc rejects a bare `p.X` on a pointer receiver
            // (GS0158) — but gsc's own G# grammar already has a native `->`
            // operator (sugar for `(*p).X`, ADR-0122 §4 / issue #1034) that its
            // parser desugars at parse time. Printing the arrow directly reuses
            // that existing, already-correct G# feature: it handles field,
            // property, and method-call receivers, chains (`a->b->c`, each
            // `->` recursing through this method) and lvalue targets
            // identically to `.`. (The hand-written `(*p).X` form the arrow
            // desugars to also round-trips as a *read*, but gsc's parser fails
            // to re-parse that explicit parenthesized form as an *assignment
            // target* — a separate, narrower parser gap the native `->` sugar
            // avoids entirely.)
            let isArrow = member.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.PointerMemberAccessExpression)
            // ADR-0172 (amending ADR-0115 §B.4): G# now has named tuple
            // elements, so an explicitly named C# element access (`item.Price`)
            // KEEPS its name in the output — the translated tuple type carries
            // the same names. The symbol still normalizes to the positional
            // field for downstream taint/typing; only the printed name differs.
            if memberSymbol is IFieldSymbol field && field.ContainingType is {IsTupleType: true} {
                let positional = field.CorrespondingTupleField ?? field
                if SymbolEqualityComparer.Default.Equals(positional, field) || IsInferredTupleElementName(field) {
                    // Default positional access (`item.Item2`) stays positional,
                    // and so does an INFERRED one (issue #3684 F15): ADR-0172
                    // deliberately does not adopt C# 7.1 name inference, so a
                    // name C# derived from an element EXPRESSION
                    // (`(statement, index)` typing as `(… statement, … index)`)
                    // exists nowhere in the translated G# — the literal prints
                    // unlabeled and the tuple type is the unnamed shape. Reading
                    // it back by that name is GS0158; the positional spelling is
                    // always valid.
                    memberName = positional.Name
                    memberSymbol = positional
                }
            }
            // Issue #2282 (was #2224): an anonymous-typed value (`new { A = 1,
            // B = 2 }`) now lowers to a composite literal constructing a
            // synthesized `data class` whose primary-constructor parameters
            // preserve real member names — no rewrite needed; `x.A` stays
            // `x.A` on the G# side, exactly like the C# anonymous-type property.
            if this.InAnalyzerApiMode {
                // ADR-0169 analyzer mode: rename Roslyn API members (enum
                // values and instance members) to their G# analyzer-API
                // spellings.
                memberName = this.MapAnalyzerMemberName(member, memberName)
            }
            let emittedMemberName string? = if this.InAnalyzerApiMode {
                this.nameAllocator.GetName(memberName)
            } else {
                this.EmittedName(memberSymbol, memberName)
            }
            return MemberAccessExpression(target, emittedMemberName, isArrow)
        }

        // Issue #4287: a generic method whose RESULT is its own type parameter,
        // called with a C# `ref x!` / `out x!` / `in x!` argument whose declared
        // type is `T?`. C# infers the type argument from the suppressed
        // (non-null) view, so `Volatile.Read(ref cache!)` is non-null there. A
        // by-ref argument cannot carry a G# `!!`, so cs2gs emits `&cache` and gsc
        // infers the argument from the declared `Dictionary?`: the call result
        // is `T?` in G#. Dereferencing it now reports GS0159, so the receiver
        // needs the `!!` that re-states the C# author's own suppression.
        /// Translates a member- or element-access [`recv`](paramref) receiver,
        /// wrapping it in G#'s postfix non-null assertion (`recv!!`) when the
        /// receiver is <em>declared</em> nullable (a `T?` reference type or
        /// nullable array) yet Roslyn's nullable <em>flow</em> analysis has proven
        /// it non-null at this site (e.g. after a guard such as
        /// `if (o.Child == null) return;`).
        /// @remarks C# uses flow-sensitive null analysis, so a guarded nullable property or
        /// field chain reads as non-null afterwards. G# follows Kotlin-style
        /// smart-casts that narrow only <em>local</em> variables, never
        /// property/field-access chains, so emitting `Moov.TextTrack.Mdia`
        /// where `TextTrack` is `TrakBox?` is rejected with GS0158 (member
        /// access on a `T?` receiver) or GS0116 (indexing a `T?` receiver).
        /// Reusing Roslyn's own proof, the assertion `!!` re-establishes the
        /// non-null fact the guard already proved (#914). The assertion is harmless
        /// on an already-non-null receiver, but the predicate below stays precise to
        /// keep the output faithful.
        /// @param recv The immediate receiver expression (left of the
        /// `.` or `[`).
        /// @returns The translated receiver, wrapped in
        /// (cref:NonNullAssertionExpression) when flow-proven non-null.
        private func GenericResultInfersNilableThroughDroppedByRefSuppression(
            recv Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) bool {
            if Unparenthesize(recv) is not InvocationExpressionSyntax invocation ||
                this
                .context
                .GetSymbolInfo(invocation)
                .Symbol is not IMethodSymbol method ||
                !method.IsGenericMethod ||
                method
                .OriginalDefinition
                .ReturnType is not ITypeParameterSymbol returnParameter ||
                returnParameter.TypeParameterKind != TypeParameterKind.Method {
                return false
            }
            // Plain comparisons rather than property patterns over Roslyn enums:
            // cs2gs translates its own source (issue #4167).
            for argument in invocation.ArgumentList.Arguments {
                if argument
                    .RefKindKeyword
                    .RawKind == 0 ||
                    argument.Expression is not PostfixUnaryExpressionSyntax suppressed ||
                    !suppressed.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.SuppressNullableWarningExpression) {
                    continue
                }
                // Only the argument that SUPPLIES the returned type parameter
                // matters: in `Pick<T, U>(ref T value, U result)` a suppressed
                // `ref x!` fixes T, not the returned U (Copilot review). Map the
                // argument (named or positional) to its parameter on the
                // original definition and require that parameter's type to BE
                // the returned type parameter.
                let parameter IParameterSymbol? = DetermineParameter(argument, this.context)
                if parameter == nil ||
                    parameter.Ordinal >= method
                    .OriginalDefinition
                    .Parameters
                    .Length ||
                    !SymbolEqualityComparer
                    .Default
                    .Equals(method.OriginalDefinition.Parameters[parameter.Ordinal].Type, returnParameter) {
                    continue
                }
                let declared ITypeSymbol? = this.GetDeclaredValueType(suppressed.Operand)
                if declared != nil &&
                    declared.IsReferenceType &&
                    declared.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated {
                    return true
                }
            }
            return false
        }

        private func ManagedReferenceArrayWidenedExpressionMayBeNull(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            let effectiveType ITypeSymbol? = this.GetManagedReferenceArrayProjectedExpressionType(expression)
            return effectiveType != nil &&
                effectiveType.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated &&
                this.IsReferenceLikeOrManagedReference(effectiveType)
        }

        private func GetManagedReferenceArrayProjectedExpressionType(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) ITypeSymbol? {
            var expression = expression
            expression = Unparenthesize(expression)
            if expression is MemberAccessExpressionSyntax anonymousMember &&
                this
                .context
                .GetSymbolInfo(anonymousMember)
                .Symbol is IPropertySymbol anonymousProperty &&
                anonymousProperty
                .ContainingType
                .IsAnonymousType {
                return this.ApplyMappedArrayElementShape(
                    anonymousProperty.Type,
                    this.typeMapper.GetAnonymousPropertyType(
                        anonymousProperty,
                        this.context,
                        anonymousMember.GetLocation()
                    )
                )
            }
            if expression is IdentifierNameSyntax identifier &&
                this
                .context
                .GetSymbolInfo(identifier)
                .Symbol is {} identifierSymbol {
                if this.state.ProjectedQueryBindingType.TryGetValue(identifierSymbol, out var projectedQueryType) {
                    return projectedQueryType
                }
                if identifierSymbol is IParameterSymbol parameter &&
                    this
                    .state
                    .ProjectedCallableParameterType
                    .TryGetValue(parameter, out var projectedParameterType) {
                    return projectedParameterType
                }
                if identifierSymbol is ILocalSymbol local {
                    if this
                        .state
                        .ManagedReferenceArrayNullable
                        .ManagedReferenceArrayProjectedLocalType
                        .TryGetValue(local, out var projectedLocalType) {
                        return projectedLocalType
                    }
                    if local.Type is IArrayTypeSymbol &&
                        local
                        .DeclaringSyntaxReferences
                        .FirstOrDefault()
                        ?.GetSyntax() is VariableDeclaratorSyntax{Initializer: {Value: {} initializer}} {
                        projectedLocalType = this.GetManagedReferenceArrayProjectedExpressionType(initializer)
                        if projectedLocalType != nil {
                            this
                                .state
                                .ManagedReferenceArrayNullable
                                .ManagedReferenceArrayProjectedLocalType[local] = projectedLocalType
                        }
                        return projectedLocalType
                    }
                }
            }
            if this.context.GetTypeInfo(expression).Type is IArrayTypeSymbol array && this.GetMappedArrayElementType(
                expression
            ) is {} projectedArrayElement &&
                (
                this.ArrayExpressionHasNullableElement(expression) || !SymbolEqualityComparer.IncludeNullability.Equals(
                    array.ElementType,
                    projectedArrayElement
                )
            ) {
                return this
                    .context
                    .Compilation
                    .CreateArrayTypeSymbol(projectedArrayElement, array.Rank, projectedArrayElement.NullableAnnotation)
                    .WithNullableAnnotation(array.NullableAnnotation)
            }
            if expression is Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalExpressionSyntax conditional {
                return this.GetManagedReferenceArrayProjectedCompositeType(
                    conditional,
                    []Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax{conditional.WhenTrue, conditional.WhenFalse}
                )
            }
            if expression is Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionSyntax switchExpression {
                return this.GetManagedReferenceArrayProjectedCompositeType(
                    switchExpression,
                    switchExpression.Arms.Select(
                        (arm Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionArmSyntax) -> arm.Expression
                    )
                )
            }
            if expression is CollectionExpressionSyntax collection &&
                (
                this.context.GetTypeInfo(collection).ConvertedType ?? this.context.GetTypeInfo(collection).Type
            ) is INamedTypeSymbol collectionType {
                return this.GetManagedReferenceArrayProjectedCollectionType(collection, collectionType)
            }
            if expression is ElementAccessExpressionSyntax arrayElement &&
                (
                this.GetManagedReferenceArrayProjectedExpressionType(arrayElement.Expression) as IArrayTypeSymbol
            )?.ElementType is {} projectedElement &&
                this
                .context
                .GetTypeInfo(arrayElement)
                .Type is {} elementType &&
                !SymbolEqualityComparer
                .IncludeNullability
                .Equals(elementType, projectedElement) {
                return projectedElement
            }
            if expression is InvocationExpressionSyntax invocation {
                var invokedMethod IMethodSymbol? = this.context.GetSymbolInfo(invocation).Symbol as IMethodSymbol
                let sourceMethod IMethodSymbol? = invokedMethod?.ReducedFrom ?? invokedMethod?.OriginalDefinition
                let sourceExpression Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ExpressionSyntax? = if invokedMethod?.ReducedFrom != nil &&
                    invocation.Expression is MemberAccessExpressionSyntax memberAccess {
                    memberAccess.Expression
                } else {
                    (
                        if invokedMethod?.IsExtensionMethod == true && invocation.ArgumentList.Arguments.Count > 0 {
                            invocation.ArgumentList.Arguments[0].Expression
                        } else {
                            default(Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?)
                        }
                    )
                }
                if sourceMethod != nil &&
                    sourceMethod.IsGenericMethod == true &&
                    (
                    sourceMethod.ContainingType.ToDisplayString() is "System.Linq.Enumerable" or "System.Linq.Queryable"
                ) &&
                    sourceMethod.ReturnType is ITypeParameterSymbol returnTypeParameter &&
                    sourceMethod
                    .Parameters[0]
                    .Type is INamedTypeSymbol sourceParameter &&
                    sourceParameter
                    .TypeArguments
                    .Any(
                    (argument ITypeSymbol) -> SymbolEqualityComparer.Default.Equals(argument, returnTypeParameter)
                ) &&
                    invokedMethod?.ReturnType is {} invocationReturn &&
                    sourceExpression != nil &&
                    this
                    .context
                    .GetTypeInfo(sourceExpression)
                    .Type is IArrayTypeSymbol receiverArray &&
                    SymbolEqualityComparer
                    .Default
                    .Equals(invocationReturn, receiverArray.ElementType) &&
                    this.GetManagedReferenceArrayProjectedExpressionType(
                    sourceExpression
                ) is IArrayTypeSymbol projectedReceiver {
                    return projectedReceiver.ElementType
                }
                if invokedMethod != nil &&
                    invocation.Expression is MemberAccessExpressionSyntax calledMember &&
                    this.GetManagedReferenceArrayProjectedExpressionType(
                    calledMember.Expression
                ) is INamedTypeSymbol projectedOwner &&
                    this.GetProjectedMember(projectedOwner, invokedMethod) is IMethodSymbol projectedCalledMethod {
                    return SubstituteProjectedContainingTypeParameter(projectedOwner, projectedCalledMethod.ReturnType)
                }
                invokedMethod = invokedMethod?.ReducedFrom ?? invokedMethod?.OriginalDefinition
                if invokedMethod?.ReturnType is IArrayTypeSymbol{
                    ElementType: {IsReferenceType: true} returnElement
                } returnArray &&
                    invokedMethod!!
                    .DeclaringSyntaxReferences
                    .FirstOrDefault()
                    ?.GetSyntax() is MethodDeclarationSyntax declaration {
                    var mappedReturn GTypeReference?
                    {
                        using let _ = this.context.UseSemanticModelFor(declaration.SyntaxTree)
                        mappedReturn = this.MapReturnType(invokedMethod, declaration)
                    }
                    if mappedReturn is ArrayTypeReference && mappedReturn.ElementType.IsNullable == true {
                        return this
                            .context
                            .Compilation
                            .CreateArrayTypeSymbol(
                            returnElement,
                            returnArray.Rank,
                            Microsoft.CodeAnalysis.NullableAnnotation.Annotated
                        )
                            .WithNullableAnnotation(returnArray.NullableAnnotation)
                    }
                }
                if this.TryGetManagedReferenceArrayProjectedMethod(invocation, out var projectedMethod) {
                    return projectedMethod!!.ReturnType
                }
                return this.GetProjectedDelegateInvocationReturnType(invocation.Expression) ?? GetDelegateInvokeMethod(
                    this.GetManagedReferenceArrayProjectedExpressionType(invocation.Expression)
                )?.ReturnType
            }
            if expression is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .AwaitExpressionSyntax awaited &&
                this.GetManagedReferenceArrayProjectedExpressionType(awaited.Expression) is INamedTypeSymbol{
                IsGenericType: true,
                TypeArguments: {Length: 1}
            } projectedAwaitable &&
                (projectedAwaitable.Name is "Task" or "ValueTask") &&
                projectedAwaitable
                .ContainingNamespace
                ?.ToDisplayString() == "System.Threading.Tasks" {
                return GetEffectiveTypeArgument(projectedAwaitable, 0)
            }
            if expression is BaseObjectCreationExpressionSyntax creation &&
                this
                .TryGetManagedReferenceArrayProjectedMethod(creation, out var projectedConstructor) {
                return projectedConstructor!!.ContainingType
            }
            var receiver Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
            var memberSymbol ISymbol?
            switch expression {
                case member is MemberAccessExpressionSyntax {
                    receiver = member.Expression
                    memberSymbol = this.context.GetSymbolInfo(member).Symbol
                }
                case element is ElementAccessExpressionSyntax {
                    receiver = element.Expression
                    memberSymbol = this.context.GetSymbolInfo(element).Symbol
                }
                default {
                    return nil
                }
            }
            if this.GetManagedReferenceArrayProjectedExpressionType(receiver) is not INamedTypeSymbol receiverType ||
                memberSymbol == nil {
                return nil
            }
            let projectedMemberType ITypeSymbol? = switch this.GetProjectedMember(receiverType, memberSymbol) {
                case field is IFieldSymbol: field.Type
                case property is IPropertySymbol: property.Type
                case method is IMethodSymbol: method.ReturnType
                default: default(ITypeSymbol?)
            }
            return SubstituteProjectedContainingTypeParameter(receiverType, projectedMemberType)
        }

        private func SubstituteProjectedContainingTypeParameter(
            receiverType INamedTypeSymbol,
            memberType ITypeSymbol?
        ) ITypeSymbol? {
            if memberType is ITypeParameterSymbol parameter && parameter.TypeParameterKind == TypeParameterKind.Type {
                for var current INamedTypeSymbol? = receiverType; current != nil; current = current!!.ContainingType {
                    if SymbolEqualityComparer.Default.Equals(current.OriginalDefinition, parameter.ContainingSymbol) &&
                        parameter.Ordinal < current
                        .TypeArguments
                        .Length {
                        return current.TypeArguments[parameter.Ordinal]
                    }
                }
                return memberType
            }
            if memberType is IArrayTypeSymbol array {
                let element ITypeSymbol? = this.SubstituteProjectedContainingTypeParameter(
                    receiverType,
                    array.ElementType
                )
                return this
                    .context
                    .Compilation
                    .CreateArrayTypeSymbol(element!!, array.Rank, element!!.NullableAnnotation)
                    .WithNullableAnnotation(array.NullableAnnotation)
            }
            if memberType is INamedTypeSymbol{IsTupleType: true} tuple {
                let elements = tuple
                    .TupleElements
                    .Select(
                    (element IFieldSymbol) -> this.SubstituteProjectedContainingTypeParameter(
                        receiverType,
                        element.Type
                    )!!
                )
                    .ToImmutableArray()
                return this
                    .context
                    .Compilation
                    .CreateTupleTypeSymbol(
                    elements,
                    tuple
                        .TupleElements
                        .Select(
                        (element IFieldSymbol) -> if element.IsImplicitlyDeclared {
                            default(string?)
                        } else {
                            element.Name
                        }
                    )
                        .ToImmutableArray(),
                    default(ImmutableArray[Location?]),
                    elements.Select((element ITypeSymbol) -> element.NullableAnnotation).ToImmutableArray()
                )
            }
            if memberType is INamedTypeSymbol named && named.Arity > 0 {
                let arguments = named
                    .TypeArguments
                    .Select(
                    (argument ITypeSymbol) -> this.SubstituteProjectedContainingTypeParameter(receiverType, argument)!!
                )
                    .ToImmutableArray()
                return named
                    .ConstructedFrom
                    .Construct(
                    arguments,
                    arguments.Select((argument ITypeSymbol) -> argument.NullableAnnotation).ToImmutableArray()
                )
                    .WithNullableAnnotation(named.NullableAnnotation)
            }
            return memberType
        }

        private func GetManagedReferenceArrayProjectedCompositeType(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            arms IEnumerable[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax]
        ) ITypeSymbol? {
            if this
                .state
                .ManagedReferenceArrayNullable
                .ManagedReferenceArrayProjectedCompositeType
                .TryGetValue(expression, out var cached) {
                return cached
            }
            this.state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedCompositeType[expression] = nil
            let effectiveTypes = List[(Arm Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax, Type ITypeSymbol?)]()
            let projectedTypes = List[ITypeSymbol]()
            for arm in arms {
                let projected ITypeSymbol? = this.GetManagedReferenceArrayProjectedExpressionType(arm)
                let effective ITypeSymbol? = projected ??
                    this
                    .context
                    .GetTypeInfo(arm)
                    .Type ??
                    this
                    .context
                    .GetTypeInfo(arm)
                    .ConvertedType
                if effective != nil {
                    effectiveTypes.Add((arm, effective))
                }
                if projected != nil {
                    projectedTypes.Add(projected)
                }
            }
            var common ITypeSymbol? = projectedTypes.FirstOrDefault(
                (candidate ITypeSymbol) -> effectiveTypes.All(
                    (
                        item(Arm Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax, Type ITypeSymbol)
                    ) -> this.ProjectionTypeFitsCompositeDestination(item.Type, candidate)
                )
            )
            if common == nil && projectedTypes.Count > 0 {
                let originalCompositeType ITypeSymbol? = this
                    .context
                    .GetTypeInfo(expression)
                    .Type ??
                    this
                    .context
                    .GetTypeInfo(expression)
                    .ConvertedType
                if originalCompositeType != nil &&
                    (
                    originalCompositeType.NullableAnnotation == Microsoft
                        .CodeAnalysis
                        .NullableAnnotation
                        .Annotated ||
                        effectiveTypes
                        .Any(
                        (
                            item(Arm Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax, Type ITypeSymbol)
                        ) -> this.IsNullCompositeArm(item.Arm)
                    )
                ) {
                    common = projectedTypes.Select(
                        (candidate ITypeSymbol) -> candidate.WithNullableAnnotation(
                            Microsoft.CodeAnalysis.NullableAnnotation.Annotated
                        )
                    )
                        .FirstOrDefault(
                        (candidate ITypeSymbol) -> effectiveTypes.All(
                            (
                                item(Arm Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax, Type ITypeSymbol)
                            ) -> this.CompositeArmFitsProjectedDestination(item.Arm, item.Type, candidate)
                        )
                    )
                }
                if common == nil &&
                    (
                    originalCompositeType == nil || !effectiveTypes.All(
                        (
                            item(Arm Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax, Type ITypeSymbol)
                        ) -> this.ProjectionTypeFitsCompositeDestination(item.Type, originalCompositeType)
                    )
                ) {
                    if effectiveTypes.Any(
                        (
                            item(Arm Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax, Type ITypeSymbol)
                        ) -> this.IsRejectableManagedReferenceProjection(item.Arm, item.Type, originalCompositeType)
                    ) {
                        this.context.ReportUnsupported(
                            expression,
                            "conditional/switch result arms have incompatible managed-reference projections."
                        )
                    }
                }
            }
            this.state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedCompositeType[expression] = common
            return common
        }

        private func CompositeArmFitsProjectedDestination(
            arm Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            effectiveType ITypeSymbol,
            destinationType ITypeSymbol
        ) bool {
            if this.IsNullCompositeArm(arm) {
                return destinationType.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated &&
                    this.IsReferenceLikeOrManagedReference(destinationType)
            }
            return this.ProjectionTypeFitsCompositeDestination(effectiveType, destinationType)
        }

        private func IsNullCompositeArm(arm Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax) bool {
            let constant = this.context.SemanticModel.GetConstantValue(arm)
            return constant.HasValue && constant.Value == nil
        }

        private func ProjectionTypeFitsCompositeDestination(
            projectedType ITypeSymbol?,
            destinationType ITypeSymbol?
        ) bool {
            if projectedType!!.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated &&
                destinationType!!.NullableAnnotation != Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated &&
                this.IsReferenceLikeOrManagedReference(projectedType) {
                return false
            }
            return this
                .context
                .Compilation
                .ClassifyConversion(projectedType!!, destinationType!!)
                .IsImplicit &&
                this.NestedProjectionFitsDestination(projectedType, destinationType)
        }

        private func NestedProjectionFitsDestination(sourceType ITypeSymbol?, destinationType ITypeSymbol?) bool {
            if sourceType!!.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated &&
                destinationType!!.NullableAnnotation != Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated &&
                this.IsReferenceLikeOrManagedReference(sourceType) {
                return false
            }
            if sourceType is IArrayTypeSymbol sourceArray && destinationType is IArrayTypeSymbol destinationArray {
                return sourceArray.Rank == destinationArray.Rank &&
                    (
                    !CSharpToGSharpTranslator.TypeContainsRecognizedManagedReferenceConsumer(
                        sourceArray.ElementType,
                        this.context.Compilation
                    ) ||
                        SymbolEqualityComparer
                        .IncludeNullability
                        .Equals(sourceArray.ElementType, destinationArray.ElementType)
                ) &&
                    this.NestedProjectionFitsDestination(sourceArray.ElementType, destinationArray.ElementType)
            }
            if sourceType is IArrayTypeSymbol sourceInterfaceArray &&
                destinationType is INamedTypeSymbol{TypeArguments: {Length: 1}} destinationInterface {
                return (
                    !CSharpToGSharpTranslator.TypeContainsRecognizedManagedReferenceConsumer(
                        sourceInterfaceArray.ElementType,
                        this.context.Compilation
                    ) ||
                        SymbolEqualityComparer
                        .IncludeNullability
                        .Equals(sourceInterfaceArray.ElementType, destinationInterface.TypeArguments[0])
                ) &&
                    this.NestedProjectionFitsDestination(
                    sourceInterfaceArray.ElementType,
                    destinationInterface.TypeArguments[0]
                )
            }
            if sourceType is not INamedTypeSymbol sourceNamed ||
                destinationType is not INamedTypeSymbol destinationNamed {
                return true
            }
            let matchingSource INamedTypeSymbol? = ReceiverTypeHierarchy(sourceNamed).FirstOrDefault(
                (candidate INamedTypeSymbol) -> SymbolEqualityComparer.Default.Equals(
                    candidate.OriginalDefinition,
                    destinationNamed.OriginalDefinition
                )
            )
            if matchingSource == nil {
                return true
            }
            for var i = 0; i < destinationNamed.TypeParameters.Length && i < matchingSource.TypeArguments.Length; i++ {
                let sourceArgument = GetEffectiveTypeArgument(matchingSource, i)
                let destinationArgument = GetEffectiveTypeArgument(destinationNamed, i)
                let argumentFits = switch destinationNamed.TypeParameters[i].Variance {
                    case VarianceKind.Out: this.CovariantProjectionArgumentFitsDestination(
                        sourceArgument,
                        destinationArgument
                    )
                    case VarianceKind.In: this.NestedProjectionFitsDestination(destinationArgument, sourceArgument)
                    default: SymbolEqualityComparer.IncludeNullability.Equals(sourceArgument, destinationArgument)
                }
                if !argumentFits {
                    return false
                }
            }
            return destinationNamed.ContainingType == nil ||
                matchingSource.ContainingType == nil ||
                this.NestedProjectionFitsDestination(matchingSource.ContainingType, destinationNamed.ContainingType)
        }

        private func CovariantProjectionArgumentFitsDestination(
            sourceType ITypeSymbol,
            destinationType ITypeSymbol
        ) bool {
            return (
                !CSharpToGSharpTranslator.TypeContainsRecognizedManagedReferenceConsumer(
                    sourceType,
                    this.context.Compilation
                ) ||
                    SymbolEqualityComparer
                    .Default
                    .Equals(sourceType, destinationType)
            ) &&
                this.NestedProjectionFitsDestination(sourceType, destinationType)
        }

        private func GetProjectedDelegateInvocationReturnType(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) ITypeSymbol? {
            var expression = expression
            expression = Unparenthesize(expression)
            if this
                .context
                .GetSymbolInfo(expression)
                .Symbol is not ILocalSymbol local ||
                !IsImplicitlyTypedLocal(local) ||
                !(
                local
                    .DeclaringSyntaxReferences
                    .FirstOrDefault()
                    ?.GetSyntax() is VariableDeclaratorSyntax{
                    Initializer: {Value: AnonymousFunctionExpressionSyntax lambda}
                }
            ) {
                return nil
            }
            let invoke IMethodSymbol? = this.GetLambdaTargetDelegateType(lambda)?.DelegateInvokeMethod
            let targetResult ITypeSymbol? = if invoke == nil {
                default(ITypeSymbol?)
            } else {
                GetLambdaResultTargetType(lambda, invoke)
            }
            var projectedResult ITypeSymbol? = nil
            let results = GetLambdaResultExpressions(lambda).ToArray()
            for result in results {
                let candidate ITypeSymbol? = this.GetManagedReferenceArrayProjectedExpressionType(result)
                if candidate == nil {
                    continue
                }
                if targetResult == nil || !SymbolEqualityComparer.Default.Equals(targetResult, candidate) ||
                    (
                    projectedResult != nil && !SymbolEqualityComparer.IncludeNullability.Equals(
                        projectedResult,
                        candidate
                    )
                ) {
                    return nil
                }
                projectedResult = candidate
            }
            if projectedResult == nil {
                return nil
            }
            if results.Any(
                (
                    result Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
                ) -> !this.LambdaResultFitsProjectedDestination(result, projectedResult, lambda, invoke)
            ) {
                if results.Any(
                    (
                        result Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
                    ) -> this.IsRejectableManagedReferenceProjection(result, projectedResult, targetResult)
                ) {
                    this.context.ReportUnsupported(
                        lambda,
                        "lambda return arms have incompatible managed-reference projections."
                    )
                }
                return nil
            }
            return GetProjectedLambdaInvocationReturnType(lambda, invoke, projectedResult)
        }

        private func LambdaResultFitsProjectedDestination(
            result Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            projectedDestination ITypeSymbol?,
            lambda AnonymousFunctionExpressionSyntax,
            invoke IMethodSymbol?
        ) bool {
            if this.IsNullCompositeArm(result) {
                return projectedDestination!!.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated &&
                    this.IsReferenceLikeOrManagedReference(projectedDestination)
            }
            let effectiveResult ITypeSymbol? = this.GetManagedReferenceArrayProjectedExpressionType(result) ??
                this.GetProjectedLambdaParameterResultType(result, lambda, invoke) ??
                this
                .context
                .GetTypeInfo(result)
                .Type ??
                this
                .context
                .GetTypeInfo(result)
                .ConvertedType
            return effectiveResult != nil && this.ProjectionTypeFitsCompositeDestination(
                effectiveResult,
                projectedDestination
            )
        }

        private func GetProjectedLambdaParameterResultType(
            result Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            lambda AnonymousFunctionExpressionSyntax,
            invoke IMethodSymbol?
        ) ITypeSymbol? {
            if invoke == nil ||
                Unparenthesize(result) is not IdentifierNameSyntax identifier ||
                this
                .context
                .GetSymbolInfo(identifier)
                .Symbol is not IParameterSymbol returnedParameter {
                return nil
            }
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
            for var index = 0; index < parameters.Count && index < invoke.Parameters.Length; index++ {
                if SymbolEqualityComparer.Default.Equals(
                    this.context.GetDeclaredSymbol(parameters[index]),
                    returnedParameter
                ) &&
                    !SymbolEqualityComparer
                    .IncludeNullability
                    .Equals(returnedParameter.Type, invoke.Parameters[index].Type) &&
                    CSharpToGSharpTranslator
                    .TypeContainsRecognizedManagedReferenceConsumer(
                    invoke.Parameters[index].Type,
                    this.context.Compilation
                ) {
                    return invoke.Parameters[index].Type
                }
            }
            return nil
        }

        private func GetProjectedMember(receiverType INamedTypeSymbol?, memberSymbol ISymbol?) ISymbol? {
            for candidateType in ReceiverTypeHierarchy(receiverType) {
                let method IMethodSymbol? = memberSymbol as IMethodSymbol
                let candidates IEnumerable[ISymbol] = if method != nil && method.MethodKind == MethodKind.Constructor {
                    candidateType.InstanceConstructors
                } else {
                    candidateType.GetMembers(memberSymbol!!.Name)
                }
                for candidate in candidates {
                    if SymbolEqualityComparer.Default.Equals(
                        candidate.OriginalDefinition,
                        memberSymbol!!.OriginalDefinition
                    ) {
                        return candidate
                    }
                }
            }
            return nil
        }

        private func TranslateReceiverWithNullForgiveness(
            recv Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) GExpression? {
            var translated GExpression? = this.TranslateExpression(recv)
            // Issue #3700: a `?.` / `?[` CONDITIONAL RECEIVER is null-guarded by
            // the seam that produced it, so an assertion there is at best
            // redundant and at worst masks the guard — and it is not even
            // printable, since the receiver renders as the empty string and the
            // assertion would split the `?.` token (`[i]?!!.B`).
            if translated is ConditionalReceiverExpression {
                return translated
            }
            // ADR-0186 step 6 (PR 0): a read of oblivious CLR metadata is `T!`
            // in G#, and gsc checks a `T!` receiver itself (§4).
            //
            // Issue #4287: not when ADR-0169 analyzer mode RETARGETS the member
            // onto the G# analyzer API. The emitted read is then that API's
            // member, which is `T?` (`method.ContainingType`), not the imported
            // Roslyn position, and a call on it reports GS0159 without `!!`.
            if !this.IsGSharpNullableAnalyzerExpression(recv) && this.PlatformTypedImportNeedsNoBridge(recv) {
                return translated
            }
            let iteratorForeachReceiverRequiresAssertion = this.IteratorForeachReceiverRequiresAssertion(recv)
            let nullableForEachBindingRequiresAssertion = this.IsNullableForEachBindingUse(recv)
            let importedGenericTupleElementRequiresAssertion = this.ImportedGenericTupleElementRequiresAssertion(recv)
            let byRefSuppressionDroppedRequiresAssertion = this.GenericResultInfersNilableThroughDroppedByRefSuppression(
                recv
            )
            let managedArrayGenericResultRequiresAssertion = this.ManagedReferenceArrayWidenedExpressionMayBeNull(recv)
            let composedReceiverMayBeNull = this.ComposedReceiverMayBeNull(recv)
            if !iteratorForeachReceiverRequiresAssertion &&
                !nullableForEachBindingRequiresAssertion &&
                !importedGenericTupleElementRequiresAssertion &&
                !byRefSuppressionDroppedRequiresAssertion &&
                !managedArrayGenericResultRequiresAssertion &&
                this.GSharpExpressionIsStaticallyNonNull(recv, translated) {
                return ParenthesizeIfBareNumericLiteral(translated)
            }
            if iteratorForeachReceiverRequiresAssertion ||
                nullableForEachBindingRequiresAssertion ||
                importedGenericTupleElementRequiresAssertion ||
                byRefSuppressionDroppedRequiresAssertion ||
                managedArrayGenericResultRequiresAssertion ||
                this.IsGSharpNullableAnalyzerExpression(recv) ||
                (
                !this.IsActivePatternBinding(recv) && !this.ExpressionTreeForbidsReceiverAssertion(recv) &&
                    !this.IsGSharpFlowNarrowedFieldOrPropertyInSameCondition(recv) &&
                    (
                    composedReceiverMayBeNull || this.ReceiverNeedsNullForgiveness(recv, isDereferenceReceiver: true) ||
                        this.ReceiverIsNullableReferenceFieldOrProperty(recv) || this.NullableReferenceValueMayBeNull(
                        recv
                    )
                )
            ) {
                translated = EnsureNonNullAssertion(translated)
            } else if !this.IsWithinExpressionTreeLambda(recv) && this.IsLocalBoundFromAsExpression(recv) {
                // ADR-0160: a local bound from a C# `as` (`var p = o as object[];`)
                // has G# type `T?`, because `as` yields `T?` in both languages. In
                // OBLIVIOUS C# the value is then dereferenced with no null test
                // (`p[0]`), and Roslyn — which never considers such a local
                // maybe-null — reports nothing, so none of the predicates above
                // fire. gsc rejects the dereference (GS0116 / GS0158).
                //
                // Asserting here is faithful: C# would raise a
                // NullReferenceException at this same dereference, and `!!` raises
                // at exactly the same point. Asserting at the `as` instead would
                // move the throw earlier and break the guarded shape
                // (`var p = o as T; if (p != null) …`), which Roslyn DOES flag and
                // which the predicates above already handle correctly.
                translated = EnsureNonNullAssertion(translated)
            }
            return ParenthesizeIfBareNumericLiteral(translated)
        }

        // Issue #4555: a conditional, switch or `??` composition is nilable when
        // any value arm is. Composed only from the existing per-operand
        // readers; it computes no nullability of its own. Shared by the
        // dereference-receiver boundary and string-concat operand coercion.
        private func ComposedReceiverMayBeNull(receiver Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?) bool {
            var receiver = receiver
            receiver = Unparenthesize(receiver)
            let OperandMayBeNull = func (operand Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax) bool {
                return this.ComposedReceiverMayBeNull(operand) || this.ReceiverNeedsNullForgiveness(
                    operand,
                    isDereferenceReceiver: true
                ) ||
                    this.ReceiverIsNullableReferenceFieldOrProperty(operand) || this.NullableReferenceValueMayBeNull(
                    operand
                )
            }
            return switch receiver {
                case conditional is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ConditionalExpressionSyntax: OperandMayBeNull(conditional.WhenTrue) ||
                    OperandMayBeNull(conditional.WhenFalse)
                case switchExpression is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .SwitchExpressionSyntax: switchExpression
                    .Arms
                    .Any(
                    (arm Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionArmSyntax) -> OperandMayBeNull(
                        arm.Expression
                    )
                )
                case coalesce is Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax when coalesce.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.CoalesceExpression
                ): OperandMayBeNull(coalesce.Right)
                default: false
            }
        }

        private func ImportedGenericTupleElementRequiresAssertion(
            receiver Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) bool {
            if receiver is not MemberAccessExpressionSyntax memberAccess ||
                this
                .context
                .GetSymbolInfo(receiver)
                .Symbol is not IFieldSymbol tupleField ||
                !tupleField
                .ContainingType
                .IsTupleType ||
                this
                .context
                .GetSymbolInfo(memberAccess.Expression)
                .Symbol is not ILocalSymbol local {
                return false
            }
            for reference in local.DeclaringSyntaxReferences {
                if reference.GetSyntax() is VariableDeclaratorSyntax declarator &&
                    declarator
                    .Initializer
                    ?.Value is InvocationExpressionSyntax invocation &&
                    this
                    .context
                    .GetSymbolInfo(invocation)
                    .Symbol is IMethodSymbol method &&
                    method
                    .OriginalDefinition
                    .ReturnType is ITypeParameterSymbol &&
                    !SymbolEqualityComparer
                    .Default
                    .Equals(method.ContainingAssembly, this.context.Compilation.Assembly) {
                    return true
                }
            }
            return false
        }

        private func IteratorForeachReceiverRequiresAssertion(
            recv Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) bool {
            var unwrapped = recv
            while unwrapped is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax parenthesized {
                unwrapped = parenthesized.Expression
            }
            if !(unwrapped is IdentifierNameSyntax) ||
                this
                .context
                .GetSymbolInfo(unwrapped)
                .Symbol is not(ILocalSymbol or IParameterSymbol) ||
                this.GetDeclaredValueType(unwrapped) is not{} declaredType ||
                !declaredType.IsReferenceType ||
                declaredType.NullableAnnotation != Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated ||
                !this.IsGSharpFlowNarrowedLocal(unwrapped) {
                return false
            }
            let forEach ForEachStatementSyntax? = unwrapped
                .Ancestors()
                .OfType[ForEachStatementSyntax]()
                .FirstOrDefault((loop ForEachStatementSyntax) -> loop.Expression.Span.Contains(unwrapped.Span))
            let body Microsoft.CodeAnalysis.SyntaxNode? = this.state.CurrentBodyScope ?? unwrapped.Ancestors()
                .FirstOrDefault(
                (node Microsoft.CodeAnalysis.SyntaxNode) -> node is BaseMethodDeclarationSyntax ||
                    node is AccessorDeclarationSyntax ||
                    node is LocalFunctionStatementSyntax
            )
            // G# iterator lowering needs the local smart-cast made explicit at
            // the foreach source so the generated generic enumerator stays typed.
            return forEach != nil &&
                body
                ?.DescendantNodes()
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.YieldStatementSyntax]()
                .Any() == true
        }

        // ADR-0160: true when `recv` names a local whose declaration initializer is a
        // C# `as` expression, so the local's G# type is `T?`. See the dereference
        // assertion in <see cref="TranslateReceiverWithNullForgiveness"/>. A local
        // the C# code itself null-tests is already reported maybe-null by Roslyn and
        // handled by the ordinary forgiveness predicates; this covers the oblivious
        // shape those cannot see.
        private func IsLocalBoundFromAsExpression(recv Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax) bool {
            if recv is not IdentifierNameSyntax identifier ||
                this
                .context
                .GetSymbolInfo(identifier)
                .Symbol is not ILocalSymbol local {
                return false
            }
            if !(
                local
                    .DeclaringSyntaxReferences
                    .FirstOrDefault()
                    ?.GetSyntax() is VariableDeclaratorSyntax{Initializer: {Value: {} initializerMatch}}
            ) {
                return false
            }
            var initializer Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax = initializerMatch
            while initializer is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax parenthesized {
                initializer = parenthesized.Expression
            }
            return initializer.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.AsExpression)
        }

        /// True when a member-/element-access [`recv`](paramref) receiver is a
        /// nullable-reference <em>field</em> or <em>property</em> (declared `T?`
        /// or promoted to nullable, issue #1072) and therefore always needs a G#
        /// `!!` assertion — independent of Roslyn flow state.
        /// @remarks Unlike a local variable, G#'s Kotlin-style smart-casts never narrow a
        /// property/field-access chain, so `field.Member` / `field[i]` on a
        /// `T?` field is rejected (GS0158/GS0116) no matter what null-guard
        /// precedes it. The Oahu corpus compiles nullable-<em>disabled</em>, so
        /// Roslyn's flow analysis reports these receivers as oblivious (never
        /// flow-state `NotNull`) and the flow-driven
        /// (cref:ReceiverNeedsNullForgiveness) pass leaves them bare.
        /// Asserting `field!!.Member` both compiles and preserves C#'s
        /// throw-on-null semantics for the same access (a null field would
        /// `NullReferenceException` in C# too). Locals/parameters keep the
        /// flow-proven path, since G# does smart-cast them; comparison operands and
        /// `?.` receivers are routed elsewhere and never reach this pass.
        private func ReceiverIsNullableReferenceFieldOrProperty(
            recv Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) bool {
            if recv is PostfixUnaryExpressionSyntax &&
                recv.RawKind == int32(Microsoft.CodeAnalysis.CSharp.SyntaxKind.SuppressNullableWarningExpression) ||
                recv is ThisExpressionSyntax ||
                recv is BaseExpressionSyntax ||
                recv is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .LiteralExpressionSyntax ||
                recv is ConditionalAccessExpressionSyntax {
                return false
            }
            let symbol ISymbol? = this.context.GetSymbolInfo(recv).Symbol
            // Issue #4356: in ADR-0169 analyzer mode the read is retargeted
            // onto the G# analyzer API, whose counterpart of some Roslyn
            // members is declared `T?` although Roslyn's is non-null — often a
            // SyntaxToken STRUCT, which the reference-type test below would
            // reject outright. The C# type cannot say so, so ask the map.
            if this.IsGSharpNullableAnalyzerExpression(recv) {
                return true
            }
            // Issue #2113: in a nullable-OBLIVIOUS compilation the whole-program
            // taint analysis may promote a LOCAL or PARAMETER receiver to `T?`.
            // gsc smart-casts locals only after a flow-proven guard (inert under
            // oblivious metadata), so an unguarded `x.Member` / `x[i]` / `for … in
            // x` on such a receiver is rejected (GS0158/GS0116). Assert `x!!` to
            // both compile and preserve C#'s throw-on-null semantics for the same
            // access. Gated to oblivious so nullable-enabled projects (whose
            // locals gsc DOES smart-cast) keep their flow-driven path untouched.
            if this.IsObliviousCompilation() &&
                (symbol is ILocalSymbol || symbol is IParameterSymbol) &&
                this.ShouldPromoteToNullableReference(symbol) {
                return true
            }
            // A value produced by a member imported from a project or metadata
            // assembly compiled WITHOUT a nullable context is oblivious — Roslyn
            // reports its reference-type return/type as `NullableAnnotation.None`
            // — and gsc maps every such imported reference type to `T?`.
            // A method-call/property/field receiver like `searcher.Get()` (from an
            // unannotated package, e.g. System.Management) is therefore rejected on
            // `recv.Member` / `recv[i]` / `for … in recv` (GS0158/GS0116) even
            // though C# accepts it (it would `NullReferenceException` on null just
            // the same). Assert `recv!!` to compile and preserve that throw-on-null
            // behavior.
            if this.IsImportedObliviousNullableMember(symbol) || this.LocalInitializedFromImportedObliviousNullable(
                symbol
            ) {
                return true
            }
            let declared ITypeSymbol? = switch symbol {
                case property is IPropertySymbol: property.Type
                case field is IFieldSymbol: field.Type
                default: default(ITypeSymbol?)
            }
            if !(declared != nil && declared.IsReferenceType == true) {
                return false
            }
            return declared.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated ||
                this.ShouldPromoteToNullableReference(symbol)
        }

        /// Issue #4356: whether [`symbol`](paramref) is a Roslyn property or
        /// field that ADR-0169 analyzer mode retargets onto a G# analyzer-API
        /// member declared `T?`, although Roslyn declares it non-null
        /// (see `RoslynAnalyzerApiMap.IsGSharpNullableMember`). The C#
        /// symbol's own nullability cannot say so — for a `SyntaxToken`
        /// it is a struct — so the forgiveness predicates ask here.
        ///
        /// For a LOCAL the answer is what cs2gs recorded when it emitted the
        /// local (`DocumentTranslationState.EmittedLocalGSharpNullability`),
        /// never a walk over Roslyn declarator syntax. A local with no record —
        /// a binding shape that is not hooked — is nullable when its Roslyn
        /// type could be `T?` on the G# side, so a miss is a redundant
        /// `!!` (legal; the polish pass strips GS0536), never a bare
        /// dereference of a `T?`. This is the one place every forgiveness
        /// and expression-tree predicate asks.
        /// @param symbol The bound C# symbol of the read.
        /// @returns True when the translated read is `T?` in G#.
        private func IsGSharpNullableAnalyzerApiMember(symbol ISymbol?) bool {
            if !this.InAnalyzerApiMode {
                return false
            }
            if symbol is IPropertySymbol || symbol is IFieldSymbol {
                return RoslynAnalyzerApiMap.IsGSharpNullableMember(
                    RoslynTypeMetadataName(symbol!!.OriginalDefinition.ContainingType),
                    symbol!!.Name
                )
            }
            if symbol is not ILocalSymbol local {
                return false
            }
            if this.state.EmittedLocalGSharpNullability.TryGetValue(local, out var recorded) {
                return recorded
            }
            return RoslynAnalyzerApiMap.IsGSharpNullableCapableType(
                RoslynTypeMetadataName(local.Type as INamedTypeSymbol)
            )
        }

        /// Issue #4356: records whether a local cs2gs just emitted is `T?` in
        /// G# because of the analyzer map, per
        /// (cref:IsGSharpNullableAnalyzerApiMember). With an emitted type
        /// clause it is not (the clause is the Roslyn type); without one, G#
        /// infers the local from the emitted initializer, which is `T?`
        /// exactly when the initializer's emitted type is (never after a `!!`).
        /// @param local The local's symbol.
        /// @param emittedType The emitted type clause, if any.
        /// @param initializerSyntax The C# initializer, if any.
        /// @param emittedInitializer The emitted initializer, if any.
        private func RecordEmittedLocalNullability(
            local ILocalSymbol?,
            emittedType GTypeReference?,
            initializerSyntax Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            emittedInitializer GExpression?
        ) {
            if !this.InAnalyzerApiMode || local == nil {
                return
            }
            // A type clause comes from the Roslyn type (plus the ordinary
            // nullable promotions, which the ordinary predicates already see),
            // so no analyzer-map nullability hides behind it.
            this
                .state
                .EmittedLocalGSharpNullability[local] = emittedType == nil &&
                !(emittedInitializer is NonNullAssertionExpression) &&
                this.IsGSharpNullableAnalyzerExpression(initializerSyntax)
        }

        /// Issue #4356: whether [`expression`](paramref)'s EMITTED G# type is
        /// `T?` because of the ADR-0169 analyzer map, although its Roslyn
        /// type is non-null. This is the one classifier for that question: a
        /// mapped member read, a local (its recorded emitted nullability, see
        /// IsGSharpNullableAnalyzerApiMember), and the value-preserving shapes
        /// that carry one through —
        /// parentheses, a conditional (either arm), `??` (its fallback), a
        /// switch expression (any arm) and an assignment (its value). Every
        /// forgiveness, static-non-null and expression-tree check asks it, and
        /// a local's provenance is this same question asked of its initializer,
        /// so the direct read, an inferred local and a composed initializer
        /// cannot disagree. A null-forgiving `x!` is non-null.
        /// @param expression The C# expression.
        /// @returns True when the emitted G# type is nullable per the analyzer map.
        private func IsGSharpNullableAnalyzerExpression(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            if !this.InAnalyzerApiMode || expression == nil {
                return false
            }
            switch expression {
                case parenthesized is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax {
                    return this.IsGSharpNullableAnalyzerExpression(parenthesized.Expression)
                }
                case suppression is PostfixUnaryExpressionSyntax when suppression.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.SuppressNullableWarningExpression
                ) {
                    return false
                }
                case conditional is Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalExpressionSyntax {
                    return this.IsGSharpNullableAnalyzerExpression(conditional.WhenTrue) ||
                        this.IsGSharpNullableAnalyzerExpression(conditional.WhenFalse)
                }
                case coalesce is Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax when coalesce.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.CoalesceExpression
                ) {
                    return this.IsGSharpNullableAnalyzerExpression(coalesce.Right)
                }
                case switchExpression is Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionSyntax {
                    for arm in switchExpression.Arms {
                        if this.IsGSharpNullableAnalyzerExpression(arm.Expression) {
                            return true
                        }
                    }
                    return false
                }
                case assignment is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .AssignmentExpressionSyntax when assignment
                    .IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.SimpleAssignmentExpression) {
                    return this.IsGSharpNullableAnalyzerExpression(assignment.Right)
                }
                default {
                    return this.IsGSharpNullableAnalyzerApiMember(this.context.GetSymbolInfo(expression).Symbol)
                }
            }
        }

        // Issue #2113: true for a nullable-oblivious compilation
        // (NullableContextOptions.Disable) — the only mode in which the
        // whole-program taint analysis runs and its declaration/receiver
        // adjustments apply. A nullable-enabled compilation is byte-identical to
        // pre-#2113 behavior.
        private func IsObliviousCompilation() bool -> this
            .context
            .Compilation
            .Options
            .NullableContextOptions == NullableContextOptions.Disable

        // True when <paramref name="symbol"/> is a method/property/field imported
        // from another project or metadata assembly and its concrete reference
        // return/type is oblivious. Same-compilation source symbols stay on the
        // whole-program taint path; imported source and metadata contracts are
        // already fixed. The value may be nil. For CLR metadata no project in
        // this run emits, gsc reads it as the platform type `T!` (ADR-0186
        // step 3), which needs no `!!`; see ReadsPlatformTypedImport.
        private func IsImportedObliviousNullableMember(symbol ISymbol?) bool {
            if !((symbol is IMethodSymbol || symbol is IPropertySymbol || symbol is IFieldSymbol)) {
                return false
            }
            // Use the member's ORIGINAL (unsubstituted) return/type: gsc maps a
            // member to `T?` based on the nullable context of the assembly that
            // DECLARES it, not on a type argument the consumer supplies. An
            // annotated BCL member like `IReadOnlyList<T>.this[int]` returns the
            // type parameter `T` (excluded below), so `list[i]` stays non-null even
            // in oblivious consumer code — only a member whose own declared return
            // is a concrete oblivious reference type (e.g. System.Management's
            // `ManagementObjectSearcher.Get()` -> `ManagementObjectCollection`) is
            // treated as nullable.
            let original = symbol!!.OriginalDefinition
            let type ITypeSymbol? = switch original {
                case m is IMethodSymbol: m.ReturnType
                case p is IPropertySymbol: p.Type
                case f is IFieldSymbol: f.Type
                default: default(ITypeSymbol?)
            }
            return !SymbolEqualityComparer.Default.Equals(
                original.ContainingAssembly,
                this.context.Compilation.Assembly
            ) &&
                ObliviousNullabilityAnalyzer.IsObliviousConcreteReferencePosition(type)
        }

        // Issue #2113 follow-up: true when <paramref name="symbol"/> is a `let`
        // local whose type is inferred from an initializer that reads an imported
        // oblivious member (e.g. `let coll = searcher.Get()`). gsc infers
        // such a local as `T?`, so a `coll.Member` / `for … in coll` use needs a
        // `!!` — but promoting the local's DECLARATION to `T?` cascades
        // nullable-conversion errors at its other (non-null) uses, so the
        // assertion is applied only here at the receiver/foreach-source use site.
        private func LocalInitializedFromImportedObliviousNullable(symbol ISymbol?) bool {
            // Issue #5537: oblivious container storage states a non-null outer type.
            if symbol is not ILocalSymbol local || this.StoresObliviousContainerElements(local) {
                return false
            }
            for reference in local.DeclaringSyntaxReferences {
                if reference.GetSyntax() is VariableDeclaratorSyntax{Initializer: {Value: {} initializer}} &&
                    this.IsImportedObliviousNullableMember(this.context.GetSymbolInfo(initializer).Symbol) {
                    return true
                }
            }
            return false
        }

        /// ADR-0186 step 6 (PR 0): whether [`expression`](paramref) reads a
        /// value whose G# type is the platform type `T!` because it comes
        /// from oblivious CLR METADATA that no project in this migration run
        /// emits — a member for which (cref:IsImportedObliviousNullableMember)
        /// holds and whose contract is frozen
        /// ((cref:TargetContractIsFrozenInMetadata)), or an element read
        /// through such a member (ADR-0186 §3 rule 5: member access through a
        /// `C[T!]` yields `T!`).
        ///
        /// Since ADR-0186 step 3 gsc reads such a position as `T!`, not
        /// `T?`, and inserts the nil check itself wherever the value is
        /// coerced to a non-null reference — receivers included (§4). A
        /// `!!` on it is therefore legal but only duplicates that check,
        /// and the polish pass never strips it (GS0536 does not fire on a
        /// `T!` operand). The forgiveness sites ask this to leave such a
        /// read bare. The question "may this value be nil" still answers yes:
        /// (cref:NullableReferenceValueMayBeNull) and
        /// (cref:IsImportedObliviousNullableMember) are unchanged, because
        /// their other callers (a `??=` result, a conditional index) must
        /// keep treating the value as nilable.
        ///
        /// A member declared in a project this run migrates is excluded: cs2gs
        /// decides that declaration's emitted type, which is `T` or a
        /// promoted `T?`, never `T!`. So is a local initialized from
        /// such a read: cs2gs can give the local a type clause, and a
        /// promoted one is `T?`.
        /// @param expression The C# expression.
        /// @returns True when the translated read has a platform type in G#.
        private func ReadsPlatformTypedImport(expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?) bool {
            var expression = expression
            while expression is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax parenthesized {
                expression = parenthesized.Expression
            }
            if expression == nil {
                return false
            }
            // A container (an array, or a constructed type with a reference
            // argument) keeps its `!!`. gsc reads an oblivious container's
            // nested positions as `T!` too, and on such a value the top-level
            // `!!` also decides whether it converts to an enabled container:
            // `File.ReadAllLines(path)` is `[]!string!` and does not convert to
            // `[]string`, while `File.ReadAllLines(path)!!` does (the
            // netstandard2.0 Gsharp.NET.Sdk, #4449). Only a value whose type
            // has no nested reference position is left bare.
            let type ITypeSymbol? = this.context.GetTypeInfo(expression).Type
            if HasNestedReferencePosition(type) {
                return false
            }
            if expression is ElementAccessExpressionSyntax elementAccess &&
                !(elementAccess.Expression is ConditionalAccessExpressionSyntax) &&
                this.IsFrozenObliviousImportMember(this.context.GetSymbolInfo(elementAccess.Expression).Symbol) &&
                type is {IsReferenceType: true} elementType &&
                elementType.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .None {
                return true
            }
            return this.IsFrozenObliviousImportMember(this.context.GetSymbolInfo(expression).Symbol)
        }

        private func IsFrozenObliviousImportMember(symbol ISymbol?) bool -> this.IsImportedObliviousNullableMember(
            symbol
        ) &&
            this.TargetContractIsFrozenInMetadata(symbol)

        /// ADR-0186 step 6 (PR 0): whether a forgiveness site may leave
        /// [`value`](paramref) (a receiver or a value) without the
        /// `!!` it would otherwise emit: it reads a platform-typed import
        /// ((cref:ReadsPlatformTypedImport)) and its top-level
        /// platform-ness cannot reach type inference.
        ///
        /// Inference is the one place a bare `T!` and `T!!` differ at
        /// compile time. A `T!` argument infers `T!` for a method type
        /// parameter, a lambda result infers it for the lambda, an element
        /// infers it for an implicitly-typed array, and a receiver infers it
        /// for an extension declared `this T`. A container built from that
        /// (`List[string!]`) then cannot be stored where an enabled
        /// declaration says `List[string]` (§3 rule 3). Those positions keep
        /// today's `!!`, which pins the inferred type to `T`. An
        /// ordinary receiver never reaches inference: §5 types the member access
        /// as it would for `T`.
        /// @param value The C# receiver or value expression.
        /// @returns True when the expression needs no `!!` bridge.
        private func PlatformTypedImportNeedsNoBridge(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool -> this.ReadsPlatformTypedImport(value) && !this.ValueFeedsTypeInference(value)

        private func ValueFeedsTypeInference(value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?) bool {
            let node Microsoft.CodeAnalysis.SyntaxNode? = SkipValuePreservingParents(value)
            switch node!!.Parent {
                case argument is ArgumentSyntax {
                    // A tuple literal's element (`Accept((n.Name, 0))`) is an
                    // argument syntactically but binds no parameter: its
                    // platform-ness reaches inference exactly when the tuple
                    // itself does.
                    if argument.Parent is TupleExpressionSyntax tuple {
                        return ElementDeclaresDeconstructedLocal(tuple, argument) || this.ValueFeedsTypeInference(tuple)
                    }
                    if argument
                        .Parent
                        ?.Parent is InvocationExpressionSyntax{Expression: {} callee} &&
                        HasExplicitTypeArguments(callee) {
                        return false
                    }
                    let parameter IParameterSymbol? = (
                        this.context.SemanticModel.GetOperation(argument) as IArgumentOperation
                    )?.Parameter
                    return parameter == nil ||
                        (
                        (parameter.ContainingSymbol is IMethodSymbol and {IsGenericMethod: true}) &&
                            MentionsMethodTypeParameter(parameter.OriginalDefinition.Type)
                    )
                }
                case lambda is AnonymousFunctionExpressionSyntax {
                    return this.LambdaTypeIsInferred(lambda)
                }
                case _ is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ReturnStatementSyntax when node!!.Parent!!
                    .FirstAncestorOrSelf[Microsoft.CodeAnalysis.SyntaxNode](
                    (n Microsoft.CodeAnalysis.SyntaxNode) -> n is AnonymousFunctionExpressionSyntax ||
                        n is BaseMethodDeclarationSyntax ||
                        n is LocalFunctionStatementSyntax ||
                        n is AccessorDeclarationSyntax
                ) is AnonymousFunctionExpressionSyntax enclosingLambda {
                    return this.LambdaTypeIsInferred(enclosingLambda)
                }
                case memberAccess is MemberAccessExpressionSyntax when memberAccess.Expression == node {
                    return !HasExplicitTypeArguments(memberAccess) &&
                        this
                        .context
                        .GetSymbolInfo(memberAccess)
                        .Symbol is IMethodSymbol{ReducedFrom: {} unreduced} &&
                        unreduced
                        .Parameters
                        .Length > 0 &&
                        unreduced
                        .Parameters[0]
                        .Type is ITypeParameterSymbol receiverParameter &&
                        receiverParameter.TypeParameterKind == TypeParameterKind.Method
                }
                case clause is EqualsValueClauseSyntax when LocalDeclarationOf(clause) != nil {
                    return !this.LocalKeepsNullableTypeClause(clause)
                }
                case initializerExpressionSyntax is InitializerExpressionSyntax when initializerExpressionSyntax.Parent is ImplicitArrayCreationExpressionSyntax {
                    return true
                }
                case Microsoft.CodeAnalysis.CSharp.Syntax.CollectionElementSyntax {
                    return true
                }
                default {
                    return false
                }
            }
        }

        // ADR-0186 step 6 (PR 0): whether the local <paramref name="clause"/>
        // initializes is emitted with a nullable type (`T?`): declared `T?` in
        // C#, or promoted by cs2gs. Such a local keeps its type clause.
        private func LocalKeepsNullableTypeClause(clause EqualsValueClauseSyntax) bool {
            if clause.Parent is not VariableDeclaratorSyntax declarator ||
                LocalDeclarationOf(clause) is not{} declaration ||
                declaration
                .Type
                .IsVar ||
                this
                .context
                .GetDeclaredSymbol(declarator) is not ILocalSymbol local {
                return false
            }
            return IsAnnotatedNullableReference(local.Type) || this.ShouldPromoteToNullableReference(local)
        }

        // ADR-0186 step 6 (PR 0): whether a lambda's delegate type is inferred
        // rather than fixed by its target. A lambda initializing a `var` local
        // takes its natural type from its body; any other lambda is inferred
        // exactly when it sits in an inference position itself.
        private func LambdaTypeIsInferred(lambda AnonymousFunctionExpressionSyntax) bool {
            // The same walk ValueFeedsTypeInference makes, so a lambda inside
            // a conditional (`Reader read = flag ? (() => n.Name) : …`) reaches
            // the local's declared type here and is not mistaken for an
            // inferred local.
            let node Microsoft.CodeAnalysis.SyntaxNode? = SkipValuePreservingParents(lambda)
            if node!!.Parent is EqualsValueClauseSyntax clause && LocalDeclarationOf(clause) is {} declaration {
                return declaration.Type.IsVar
            }
            return this.ValueFeedsTypeInference(lambda)
        }

        // True when <paramref name="member"/> binds to an extension method whose
        // (reduced) `this` parameter is nullable-annotated (`this T? x`) or was
        // promoted nullable by oblivious analysis. Such a method is designed to
        // accept a null receiver, so the translated call must keep that nullable
        // receiver rather than forgive it to non-null.
        private func MemberBindsToNullableThisExtension(member MemberAccessExpressionSyntax) bool {
            if this.context.GetSymbolInfo(member).Symbol is not IMethodSymbol method {
                return false
            }
            let unreduced = method.ReducedFrom ?? method
            if !unreduced.IsExtensionMethod || unreduced.Parameters.Length == 0 {
                return false
            }
            let thisParameter = unreduced.Parameters[0]
            return if thisParameter.Type.IsReferenceType {
                thisParameter.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated ||
                    this.ShouldPromoteToNullableReference(thisParameter)
            } else {
                thisParameter.Type.OriginalDefinition?.SpecialType == SpecialType.System_Nullable_T
            }
        }

        // Issue #1354: a value-position read (a `return` expression or a
        // conditional-expression arm) of a declared-`T?`/promoted-to-`T?` symbol
        // that Roslyn's flow analysis has narrowed to non-null may need a `!!`
        // assertion to satisfy a non-null target. G# smart-casts stable locals
        // under native guards, but property/field chains and other nullable
        // values still need the bridge.
        private func TranslateValueWithNullForgiveness(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) GExpression? {
            let translated GExpression? = this.TranslateExpression(value)
            let (targetType, targetSymbol) = this.FindContextualValueTarget(value)
            if this.GetUserDefinedConversionInputOperator(value, targetType, out _) != nil {
                return this.ForgiveNullableReferenceValue(value, translated, targetType, targetSymbol)
            }
            if this.GSharpExpressionIsStaticallyNonNull(value, translated) || this.PlatformTypedImportNeedsNoBridge(
                value
            ) {
                return translated
            }
            // Issue #3848: the unconditional branch below predates any promotion
            // that could make a RETURN position nullable, so it asserts without
            // consulting the target at all. A pure-forwarding-promoted target
            // accepts the null by construction — that is the whole point of the
            // promotion — so asserting there would reintroduce the throw this
            // change removes, one frame down. Narrowly scoped to that one new
            // promotion; every other value position keeps its existing bytes.
            //
            // A conditional or switch-expression arm flows into the whole
            // expression. Asserting one arm cannot make the whole non-null when
            // the whole already accepts or observes nil, and it would turn the
            // nil C# happily passes on into a throw. That is the case when:
            //   - another arm is itself nil, so the whole is `T?` in G#
            //     whatever consumes it (BranchResultAcceptsNil);
            //   - the whole is the operand of a nil-observing construct: the
            //     left of `??`, a `?.` receiver, or a `== null` / `is null` test
            //     (also BranchResultAcceptsNil);
            //   - the whole's effective target (FindContextualValueTarget)
            //     accepts nil: a local, field, property or parameter cs2gs
            //     widened to `T?`, or a return of such a method;
            //   - that target is an INFERRED generic parameter, which G#
            //     re-infers from the emitted argument
            //     (IsInferredGenericParameterTarget).
            if IsBranchArm(value) &&
                (
                this.BranchResultAcceptsNil(value, out var branch) || this.NullForgivingTargetAcceptsNil(
                    targetType,
                    targetSymbol,
                    value
                ) ||
                    (
                    targetSymbol is IParameterSymbol parameterTarget &&
                        IsInferredGenericParameterTarget(parameterTarget, branch)
                )
            ) {
                return translated
            }
            if !this.IsPureForwardingPromotedTarget(targetSymbol) && !this.IsActivePatternBinding(value) &&
                !this.LambdaResultFeedsNullableObservedInvocation(value) && this.ReceiverNeedsNullForgiveness(value) {
                return this.ReportStoreBridge(value, translated, EnsureNonNullAssertion(translated), targetSymbol)
            }
            return this.ForgiveNullableReferenceValue(value, translated, targetType, targetSymbol)
        }

        private func IsActivePatternBinding(expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?) bool {
            var expression = expression
            while expression is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax parenthesized {
                expression = parenthesized.Expression
            }
            return this
                .context
                .GetSymbolInfo(expression)
                .Symbol is {} symbol &&
                (this.state.PatternBindings.ContainsKey(symbol) || this.state.NativePatternVariables.Contains(symbol))
        }

        private func ForgiveNullableReferenceValue(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            translated GExpression?,
            targetType ITypeSymbol?,
            targetSymbol ISymbol?,
            includePromotedValue bool = false,
            reportedTarget ISymbol? = nil,
            reportedSlotType ITypeSymbol? = nil,
            fixedSink bool = false
        ) GExpression? -> this
            .ReportStoreBridge(
            value,
            translated,
            this.ForgiveNullableReferenceValueCore(
                value,
                translated,
                targetType,
                targetSymbol,
                includePromotedValue,
                fixedSink: fixedSink
            ),
            targetSymbol ?? reportedTarget,
            reportedSlotType
        )

        private func ForgiveNullableReferenceValueCore(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            translated GExpression?,
            targetType ITypeSymbol?,
            targetSymbol ISymbol?,
            includePromotedValue bool,
            operatorInput bool = false,
            fixedSink bool = false
        ) GExpression? {
            var targetType = targetType
            var convertsValue = false
            let resultAcceptsNil = !operatorInput && this.BranchResultAcceptsNil(value, out _)
            let conversionOperator IMethodSymbol? = if operatorInput {
                default(IMethodSymbol?)
            } else {
                this.GetUserDefinedConversionInputOperator(value, targetType, out convertsValue)
            }
            if !operatorInput &&
                (conversionOperator != nil || this.FlowsThroughUserDefinedConversion(value)) &&
                this.GetFixedElementDestinationType(value, targetSymbol) is {} projectedTarget &&
                SymbolEqualityComparer
                .Default
                .Equals(projectedTarget, targetType) {
                targetType = projectedTarget
            }
            if conversionOperator != nil {
                let parameter = conversionOperator.Parameters[0]
                let operatorOperand GExpression? = this.ReportStoreBridge(
                    value,
                    translated,
                    this.ForgiveNullableReferenceValueCore(
                        value,
                        translated,
                        parameter.Type,
                        parameter,
                        includePromotedValue,
                        operatorInput: true
                    ),
                    parameter,
                    parameter.Type
                )
                if convertsValue && !resultAcceptsNil && this.TargetWillRemainNonNullableReference(
                    targetType,
                    targetSymbol
                ) {
                    var resultType GTypeReference? = this.MapDelegateLikeReturnType(
                        conversionOperator,
                        isAsync: false,
                        value!!.GetLocation()
                    )
                    if ObliviousNullabilityAnalyzer.IsDirectlyNullable(
                        ObliviousNullabilityAnalyzer.GetResultConversion(value, this.context.SemanticModel),
                        this.context.SemanticModel,
                        respectNullGuards: true
                    ) {
                        resultType = MakeNullable(resultType)
                    }
                    if resultType!!.IsNullable {
                        // Assert the converted result, never its null-accepting input.
                        let converted GExpression? = EnsureNonNullAssertion(
                            ConversionExpression(resultType, operatorOperand)
                        )
                        this.state.MaterializedConversionResults[converted!!] = conversionOperator
                        return converted
                    }
                }
                return operatorOperand
            }
            let valueSymbol ISymbol? = this.context.GetSymbolInfo(value).Symbol
            let valueLocal ILocalSymbol? = valueSymbol as ILocalSymbol ??
                GetReferencedLocal(this.context.SemanticModel.GetOperation(value!!))
            let isFlowNarrowedLocal = valueLocal != nil &&
                (
                this.IsDominatedByNullCheckGuard(value, valueLocal) ||
                    (
                    !this.IsObliviousCompilation() &&
                        this
                        .context
                        .GetTypeInfo(value)
                        .Nullability
                        .FlowState == Microsoft
                        .CodeAnalysis
                        .NullableFlowState
                        .NotNull
                )
            )
            let nullableObservedLambdaResult = this.LambdaResultFeedsNullableObservedInvocation(value)
            let importedStatedNullableValue = value is InvocationExpressionSyntax &&
                ObliviousNullabilityAnalyzer.IsImportedStatedNullablePosition(valueSymbol, this.context.Compilation)
            let emittedNullableInvocationResult = value is InvocationExpressionSyntax &&
                valueSymbol is IMethodSymbol &&
                (
                this.ShouldPromoteToNullableReference(valueSymbol) || ObliviousNullabilityAnalyzer.IsDirectlyNullable(
                    this.context.SemanticModel.GetOperation(value),
                    this.context.SemanticModel,
                    respectNullGuards: true
                )
            )
            let emittedNullablePromotedLocal = !isFlowNarrowedLocal &&
                valueSymbol is ILocalSymbol local &&
                (this.ShouldPromoteToNullableReference(local) || this.LocalInitializerMakesStorageNullable(local))
            let emittedNullablePromotedStorage = !isFlowNarrowedLocal &&
                (valueSymbol is IFieldSymbol || valueSymbol is IPropertySymbol || valueSymbol is IParameterSymbol) &&
                this.ShouldPromoteToNullableReference(valueSymbol)
            let strictUseMayBeNullable = emittedNullablePromotedLocal ||
                emittedNullablePromotedStorage ||
                emittedNullableInvocationResult ||
                (
                !isFlowNarrowedLocal &&
                    !nullableObservedLambdaResult &&
                    (importedStatedNullableValue || value is ConditionalAccessExpressionSyntax)
            )
            // ADR-0186 step 6 (PR 0): a `T!` value flowing into a non-null
            // target is checked by gsc at that coercion (§4).
            if (!includePromotedValue || !strictUseMayBeNullable) &&
                (
                this.GSharpExpressionIsStaticallyNonNull(value, translated) || this.PlatformTypedImportNeedsNoBridge(
                    value
                )
            ) {
                return translated
            }
            // Issue #4356: a value that is `T?` only on the G# analyzer API (a
            // mapped member, or a local recorded as such) flowing into a target
            // whose G# type is non-null. Roslyn cannot see the mismatch — for a
            // SyntaxToken it is a struct on both sides — so the checks below
            // would pass it through; assert it here. An inferred local takes the
            // value's own type, and a target that is itself `T?` in G# needs nothing.
            if this.IsGSharpNullableAnalyzerExpression(value) &&
                !(translated is NonNullAssertionExpression) &&
                !IsInitializerOfInferredLocal(value, targetSymbol) &&
                !this.IsGSharpNullableAnalyzerApiMember(targetSymbol) && this.AnalyzerBridgeTargetIsNonNull(
                targetType,
                targetSymbol,
                value
            ) {
                return EnsureNonNullAssertion(translated)
            }
            if value is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ConditionalExpressionSyntax &&
                (translated is IfLetExpression || translated is BlockExpression) &&
                this
                .context
                .GetTypeInfo(value)
                .Nullability
                .FlowState == Microsoft
                .CodeAnalysis
                .NullableFlowState
                .NotNull {
                return translated
            }
            if translated is NonNullAssertionExpression ||
                resultAcceptsNil ||
                IsNullOrSuppressedNull(value) ||
                value is PostfixUnaryExpressionSyntax &&
                value.RawKind == int32(Microsoft.CodeAnalysis.CSharp.SyntaxKind.SuppressNullableWarningExpression) ||
                targetSymbol is IFieldSymbol &&
                targetSymbol.IsConst == true ||
                targetSymbol is ILocalSymbol &&
                targetSymbol.IsConst == true ||
                this.IsWithinExpressionTreeLambda(value) ||
                IsInitializerOfInferredLocal(value, targetSymbol) ||
                this.LambdaResultFeedsNullableObservedInvocation(value) || !this.TargetWillRemainNonNullableReference(
                targetType,
                targetSymbol,
                value
            ) {
                return translated
            }
            let flowNarrowedAnnotatedValue = this.IsFlowNarrowedAnnotatedReference(value)
            // Issue #5254: control reached here, so the target stays non-null.
            let inferredSink = this.SinkInfersTypeFromValue(targetSymbol, value)
            let flowRequiresAssertion = this.ReceiverNeedsNullForgiveness(
                value,
                widenedSinkNeedsNonNull: true,
                widenedSinkInfersType: inferredSink
            ) ||
                flowNarrowedAnnotatedValue
            // Issue #3676: promotion and forgiveness must stay symmetric. In a
            // nullable-ENABLED compilation the ONLY declaration this translator
            // repaints `T?` is a generated-code one with direct null evidence,
            // so that is the only value that may claim a `!!` here — every other
            // declaration kept the annotation the C# compiler actually checked,
            // and Roslyn's own flow state already governs it. This is not gated
            // on `includePromotedValue` because the sinks that matter (an
            // object-initializer member such as `Location { Uri = … }`) reach
            // this method through `TranslateValueWithNullForgiveness`, which
            // does not opt into the oblivious promoted-value pass. The C#
            // accepted such a sink only by trusting the generated annotation, so
            // asserting restores exactly the contract it assumed.
            let generatedPromotedValue = !isFlowNarrowedLocal && !this.IsObliviousCompilation() &&
                this.IsGeneratedDeclarationPromotedValue(value)
            // A fixed reference-type parameter can still receive a known-nil result.
            let directlyNullableResult = !operatorInput &&
                targetSymbol != nil &&
                targetType is ITypeParameterSymbol &&
                targetType.IsReferenceType == true &&
                ObliviousNullabilityAnalyzer
                .IsDirectlyNullable(
                this.context.SemanticModel.GetOperation(value!!),
                this.context.SemanticModel,
                respectNullGuards: true
            )
            // Issue #5516: where C# runs no flow analysis a call result keeps its
            // declared `T?` only on the method. A local or a generic parameter
            // that G# infers from the value takes that `T?` itself, so only a
            // declared sink asks for it. `fixedSink` is the caller saying that
            // a write targets storage whose type an earlier initializer fixed
            // (a `var` local assigned again), where no symbol is passed.
            let declaredSink = (targetSymbol != nil || fixedSink) &&
                !inferredSink &&
                !(targetSymbol is ILocalSymbol typedByValue && IsImplicitlyTypedLocal(typedByValue))
            if !flowRequiresAssertion && !this.NullableReferenceValueMayBeNull(
                value,
                respectDeclaredAnnotations: targetSymbol != nil,
                respectDeclaredCallResults: declaredSink
            ) &&
                !directlyNullableResult &&
                !generatedPromotedValue &&
                !(includePromotedValue && this.IsObliviousCompilation() && strictUseMayBeNullable) {
                return translated
            }
            let operand GExpression? = if value is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ConditionalExpressionSyntax ||
                value is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .SwitchExpressionSyntax ||
                value is ConditionalAccessExpressionSyntax {
                cast[GExpression](ParenthesizedExpression(translated))
            } else {
                translated
            }
            return EnsureNonNullAssertion(operand)
        }

        private func IsInitializerOfInferredLocal(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            targetSymbol ISymbol?
        ) bool {
            if targetSymbol is not ILocalSymbol local ||
                (
                !this.IsUsedAsNullable(local, this.GetNullabilityScope(local)) && !this.IsPassedToNullableParameter(
                    local
                )
            ) {
                return false
            }
            return local.DeclaringSyntaxReferences.Any(
                (reference SyntaxReference) -> reference.GetSyntax() is VariableDeclaratorSyntax declarator &&
                    (
                    declarator.Parent is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .VariableDeclarationSyntax and
                        {Type: {IsVar: true}}
                ) &&
                    declarator
                    .Initializer
                    ?.Value is {} initializer &&
                    initializer.SyntaxTree == value!!.SyntaxTree &&
                    initializer.Span == value!!.Span
            )
        }

        private func LambdaResultFeedsNullableObservedInvocation(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            if this.FindResultLambda(value) is not{} lambda {
                return false
            }
            if this.LambdaResultFlowsToNullableSink(lambda) {
                return true
            }
            var node Microsoft.CodeAnalysis.SyntaxNode? = lambda
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
            if !(node!!.Parent is ArgumentSyntax{Parent: {Parent: InvocationExpressionSyntax invocation}} argument) {
                return false
            }
            var invocationValue Microsoft.CodeAnalysis.SyntaxNode? = invocation
            while (
                invocationValue!!.Parent is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ParenthesizedExpressionSyntax or
                    CastExpressionSyntax
            ) {
                invocationValue = invocationValue!!.Parent
            }
            if invocationValue!!.Parent is ArgumentSyntax resultArgument && this.IsXunitNullAssertionArgument(
                resultArgument
            ) {
                return true
            }
            // Issue #4074: filtering the invocation's result says nothing about
            // an unrelated callback's fixed return contract (e.g. Func<string>).
            if this.IsGenericSelectorResultArgument(argument, lambda) &&
                (
                this.LambdaResultFeedsNullFilteringInvocation(invocation) ||
                    (
                    (
                        invocation.Expression is not GenericNameSyntax and
                            not(MemberAccessExpressionSyntax and {Name: GenericNameSyntax}) and
                            not(MemberBindingExpressionSyntax and {Name: GenericNameSyntax})
                    ) &&
                        this
                        .context
                        .SemanticModel
                        .GetNullableContext(value!!.SpanStart)
                        .HasFlag(NullableContext.AnnotationsEnabled) &&
                        this.ReceiverValueIsObliviouslyReadAnnotatedResult(value)
                )
            ) {
                return true
            }
            return this.ResolveValueSink(invocation) is ILocalSymbol result &&
                (
                this.IsUsedAsNullable(result, this.GetNullabilityScope(result)) || this.IsPassedToNullableParameter(
                    result
                )
            )
        }

        private func LambdaResultFeedsNullFilteringInvocation(selectorInvocation InvocationExpressionSyntax) bool {
            var node Microsoft.CodeAnalysis.SyntaxNode? = selectorInvocation
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
            if !(node!!.Parent is MemberAccessExpressionSyntax{Expression: var receiver} member) ||
                receiver != node ||
                member.Parent is not InvocationExpressionSyntax filteringInvocation ||
                this
                .context
                .GetSymbolInfo(filteringInvocation)
                .Symbol is not IMethodSymbol method {
                return false
            }
            let originalMethod = method.ReducedFrom ?? method
            let containingType INamedTypeSymbol? = originalMethod.ContainingType?.OriginalDefinition
            if !SymbolEqualityComparer.Default.Equals(
                containingType,
                this.context.Compilation.GetTypeByMetadataName("System.Linq.Enumerable")
            ) &&
                !SymbolEqualityComparer
                .Default
                .Equals(containingType, this.context.Compilation.GetTypeByMetadataName("System.Linq.Queryable")) {
                return false
            }
            if method.Name == "OfType" {
                return true
            }
            // A terminal quantifier can observe nil through a type pattern just
            // as a filter can. Asserting the preceding selector loses that input.
            if method.Name is not("Where" or "FirstOrDefault" or "Any" or "All") ||
                filteringInvocation
                .ArgumentList
                .Arguments
                .FirstOrDefault()
                ?.Expression is not AnonymousFunctionExpressionSyntax predicate {
                return false
            }
            let parameter Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax? = switch predicate {
                case simple is SimpleLambdaExpressionSyntax: simple.Parameter
                case ParenthesizedLambdaExpressionSyntax{
                    ParameterList: {Parameters: {Count: 1}}
                } parenthesized: parenthesized
                    .ParameterList
                    .Parameters[0]
                default: default(Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax?)
            }
            let parameterSymbol ISymbol? = if parameter == nil {
                default(IParameterSymbol?)
            } else {
                this.context.SemanticModel.GetDeclaredSymbol(parameter)
            }
            if parameterSymbol == nil {
                return false
            }
            return predicate
                .Body
                .DescendantNodesAndSelf()
                .OfType[ConditionalAccessExpressionSyntax]()
                .Any(
                (access ConditionalAccessExpressionSyntax) -> this.BindsTo(access.Expression, parameterSymbol) &&
                    (
                    (access.Parent is IsPatternExpressionSyntax and {Pattern: RecursivePatternSyntax}) ||
                        (
                        access.Parent is Microsoft
                            .CodeAnalysis
                            .CSharp
                            .Syntax
                            .BinaryExpressionSyntax comparison &&
                            (
                            comparison.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.GreaterThanExpression) ||
                                comparison.IsKind(
                                Microsoft.CodeAnalysis.CSharp.SyntaxKind.GreaterThanOrEqualExpression
                            ) ||
                                comparison.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.LessThanExpression) ||
                                comparison.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.LessThanOrEqualExpression)
                        )
                    )
                )
            ) ||
                predicate
                .Body
                .DescendantNodesAndSelf()
                .OfType[IsPatternExpressionSyntax]()
                .Any(
                (isPattern IsPatternExpressionSyntax) -> this.BindsTo(isPattern.Expression, parameterSymbol) &&
                    TryGetPatternNonNullPolarity(isPattern.Pattern, out _)
            ) ||
                predicate
                .Body
                .DescendantNodesAndSelf()
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax]()
                .Any(
                (binary Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax) -> binary.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.NotEqualsExpression
                ) &&
                    (
                    (
                        binary.Left.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.NullLiteralExpression) &&
                            this.BindsTo(binary.Right, parameterSymbol)
                    ) ||
                        (
                        binary.Right.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.NullLiteralExpression) &&
                            this.BindsTo(binary.Left, parameterSymbol)
                    )
                )
            )
        }

        private func IsPassedToNullableParameter(local ILocalSymbol) bool {
            let scope_ Microsoft.CodeAnalysis.SyntaxNode? = this.GetNullabilityScope(local)
            return scope_ != nil &&
                scope_
                .DescendantNodes(
                (node Microsoft.CodeAnalysis.SyntaxNode) -> !(
                    (node is LocalFunctionStatementSyntax || node is AnonymousFunctionExpressionSyntax)
                )
            )
                .OfType[ArgumentSyntax]()
                .Any(
                (argument ArgumentSyntax) -> this.BindsTo(argument.Expression, local) &&
                    (
                    this.IsXunitNullAssertionArgument(argument) ||
                        (
                        this
                            .context
                            .SemanticModel
                            .GetOperation(argument) is IArgumentOperation{Parameter: {Type: {} parameterType}} &&
                            (
                            parameterType.NullableAnnotation == Microsoft
                                .CodeAnalysis
                                .NullableAnnotation
                                .Annotated ||
                                parameterType
                                .OriginalDefinition
                                ?.SpecialType == SpecialType.System_Nullable_T
                        )
                    )
                )
            )
        }

        private func AssertFlowNarrowedNullableReference(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            translated GExpression?,
            targetType GTypeReference?
        ) GExpression? {
            if targetType != nil && targetType.IsNullable == false && this.IsFlowNarrowedInCSharpOnly(
                value,
                translated
            ) {
                return EnsureNonNullAssertion(translated)
            }
            return translated
        }

        /// A read of a `T?` variable that C# flow analysis proves non-null but that gsc does not
        /// narrow (so the emitted read is still `T?`). Shared by every site that stores or passes
        /// the value at a non-null target.
        private func IsFlowNarrowedInCSharpOnly(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            translated GExpression?
        ) bool {
            let declaredValueType ITypeSymbol? = this.GetDeclaredValueType(value)
            return !this.GSharpExpressionIsStaticallyNonNull(value, translated) &&
                declaredValueType?.IsReferenceType == true &&
                declaredValueType!!.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated &&
                this
                .context
                .GetTypeInfo(value)
                .Nullability
                .FlowState == Microsoft
                .CodeAnalysis
                .NullableFlowState
                .NotNull
        }

        private func IsNullableForEachBindingUse(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            var expression = expression
            if this.state.NullableForEachBindings.Count == 0 {
                return false
            }
            expression = Unparenthesize(expression)
            if expression is not IdentifierNameSyntax identifier || this.IsGSharpFlowNarrowedLocal(expression) {
                return false
            }
            let symbol ISymbol? = this.context.GetSymbolInfo(identifier).Symbol
            return symbol != nil && this.state.NullableForEachBindings.Contains(symbol)
        }

        private func GSharpExpressionIsStaticallyNonNull(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            translated GExpression? = nil,
            checkNullableForEachBinding bool = true
        ) bool {
            if checkNullableForEachBinding && this.IsNullableForEachBindingUse(expression) {
                return false
            }
            // Issue #5537: G# types an element of oblivious container storage `T?`.
            if this.ReadsObliviousContainerStorageElement(expression) {
                return false
            }
            if translated != nil && TranslatedExpressionIsStaticallyNonNull(translated) {
                return true
            }
            // Issue #4356: a Roslyn member that is non-null in C# — even a
            // SyntaxToken struct — but `T?` on the G# analyzer API it is
            // retargeted onto is never statically non-null in the output, nor
            // is a local whose emitted G# type is `T?` because of one. Asked
            // before the pattern-binding shortcuts: `x is var t` binds `t` at
            // the scrutinee's G# type, which a `var` pattern does not narrow.
            if this.IsGSharpNullableAnalyzerExpression(expression) {
                return false
            }
            if this.PatternLocalUsesNullableStorage(expression) {
                return false
            }
            if this.IsActivePatternBinding(expression) || this.IsGSharpFlowNarrowedLocal(expression) ||
                this.IsGuardCapturedFieldRead(expression) {
                return true
            }
            var unwrapped Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax? = expression
            while unwrapped is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax parenthesized {
                unwrapped = parenthesized.Expression
            }
            switch unwrapped {
                case literal is Microsoft.CodeAnalysis.CSharp.Syntax.LiteralExpressionSyntax {
                    return !literal.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.NullLiteralExpression) &&
                        !literal.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.DefaultLiteralExpression)
                }
                case Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ObjectCreationExpressionSyntax,
                ImplicitObjectCreationExpressionSyntax,
                Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ArrayCreationExpressionSyntax,
                ImplicitArrayCreationExpressionSyntax,
                AnonymousObjectCreationExpressionSyntax,
                Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .InterpolatedStringExpressionSyntax,
                Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .TypeOfExpressionSyntax,
                Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ThrowExpressionSyntax {
                    return true
                }
                case suppression is PostfixUnaryExpressionSyntax when suppression.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.SuppressNullableWarningExpression
                ) {
                    return !IsNullOrSuppressedNull(suppression.Operand)
                }
                case concatenation is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .BinaryExpressionSyntax when concatenation.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.AddExpression
                ) &&
                    this
                    .context
                    .GetTypeInfo(concatenation)
                    .Type
                    ?.SpecialType == SpecialType.System_String {
                    return true
                }
                case cast is CastExpressionSyntax when !(cast.Type is NullableTypeSyntax) &&
                    this
                    .CastUsesCheckedReferenceConversion(cast) {
                    // Issue #3843: EVERY checked reference cast now lowers to
                    // `cast[T](expr)`, whose static result is non-nullable `T`
                    // regardless of the operand's nullability — exactly as C#
                    // `(T)x` is statically `T`. (Both languages let a nil slip
                    // through that non-nullable static type; that is the
                    // shared, documented ADR-0167 behaviour, not a G#-only
                    // hole.)
                    return true
                }
                case conditional is Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalExpressionSyntax {
                    let conditionalValue GExpression? = UnwrapTranslatedValue(translated)
                    if conditionalValue is IfExpression ifExpression {
                        return this.GSharpExpressionIsStaticallyNonNull(
                            conditional.WhenTrue,
                            ifExpression.ThenExpression
                        ) &&
                            this.GSharpExpressionIsStaticallyNonNull(conditional.WhenFalse, ifExpression.ElseExpression)
                    }
                    if conditionalValue is IfLetExpression ifLet {
                        return this.GSharpExpressionIsStaticallyNonNull(conditional.WhenTrue, ifLet.ThenExpression) &&
                            this.GSharpExpressionIsStaticallyNonNull(conditional.WhenFalse, ifLet.ElseExpression)
                    }
                    return this.GSharpExpressionIsStaticallyNonNull(conditional.WhenTrue) &&
                        this.GSharpExpressionIsStaticallyNonNull(conditional.WhenFalse)
                }
                case switchExpression is Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionSyntax {
                    if UnwrapTranslatedValue(translated) is SwitchExpression translatedSwitch &&
                        translatedSwitch
                        .Arms
                        .Count == switchExpression
                        .Arms
                        .Count {
                        return switchExpression
                            .Arms
                            .Select(
                            (arm Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionArmSyntax, index int32) -> (
                                arm,
                                index
                            )
                        )
                            .All(
                            (
                                pair(arm Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionArmSyntax, index int32)
                            ) -> this.GSharpExpressionIsStaticallyNonNull(
                                pair.Item1.Expression,
                                translatedSwitch.Arms[pair.Item2].Body
                            )
                        )
                    }
                    return switchExpression.Arms.All(
                        (
                            arm Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionArmSyntax
                        ) -> this.GSharpExpressionIsStaticallyNonNull(arm.Expression)
                    )
                }
                case binary is Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax when binary.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.CoalesceExpression
                ) {
                    return if UnwrapTranslatedValue(translated) is BinaryExpression{Operator: "??"} translatedBinary {
                        this.GSharpExpressionIsStaticallyNonNull(binary.Right, translatedBinary.Right)
                    } else {
                        this.GSharpExpressionIsStaticallyNonNull(binary.Right)
                    }
                }
                case assignment is Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax {
                    if !this.AssignmentResultHasNonNullStaticType(assignment) {
                        return false
                    }
                    return if UnwrapTranslatedValue(translated) is AssignmentExpression translatedAssignment {
                        this.GSharpExpressionIsStaticallyNonNull(assignment.Right, translatedAssignment.Value)
                    } else {
                        this.GSharpExpressionIsStaticallyNonNull(assignment.Right)
                    }
                }
                case binary is Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax when binary.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.AsExpression
                ) {
                    return false
                }
                case ConditionalAccessExpressionSyntax {
                    return false
                }
                case arrayElement is ElementAccessExpressionSyntax when this
                    .context
                    .GetSymbolInfo(arrayElement)
                    .Symbol == nil &&
                    this
                    .context
                    .GetTypeInfo(arrayElement.Expression)
                    .Type is IArrayTypeSymbol arrayType {
                    // Issue #3501: a C# array element read may be flow-proven
                    // non-null at this site (`items[i] != null && …items[i]…`),
                    // but G# never narrows an indexed read — only the DECLARED
                    // element nullability counts, so a `!` over a
                    // nullable-element read must keep its `!!`.
                    if arrayType.ElementType is {IsValueType: true} valueElement {
                        return valueElement.OriginalDefinition?.SpecialType != SpecialType.System_Nullable_T
                    }
                    return arrayType.ElementNullableAnnotation == Microsoft
                        .CodeAnalysis
                        .NullableAnnotation
                        .NotAnnotated &&
                        !this.IsNullableArrayElementAccess(arrayElement)
                }
            }
            let symbol ISymbol? = this.context.GetSymbolInfo(expression).Symbol
            if symbol is ILocalSymbol inferredLocal {
                if this.TryGetInferredLocalStaticNonNull(inferredLocal, out var initializerIsNonNull) {
                    return initializerIsNonNull
                }
                if this.ForEachBindingInfersNonNullElement(inferredLocal) {
                    return true
                }
            }
            let type ITypeSymbol? = switch symbol {
                case field is IFieldSymbol: field.Type
                case local is ILocalSymbol: local.Type
                case parameter is IParameterSymbol: parameter.Type
                case property is IPropertySymbol: property.Type
                case method is IMethodSymbol when method.MethodKind != MethodKind.Constructor: method.ReturnType
                default: this.context.GetTypeInfo(expression).Type
            }
            if type != nil && type.IsValueType == true {
                return type.OriginalDefinition?.SpecialType != SpecialType.System_Nullable_T
            }
            return type?.IsReferenceType == true &&
                type!!.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .NotAnnotated &&
                !this.IsImportedObliviousNullableMember(symbol) && !this.LocalInitializedFromImportedObliviousNullable(
                symbol
            ) &&
                (symbol == nil || !this.IsTranslatorWidenedDeclaration(symbol))
        }

        private func TryGetInferredLocalStaticNonNull(local ILocalSymbol, out isNonNull bool) bool {
            isNonNull = false
            if !(
                local
                    .DeclaringSyntaxReferences
                    .FirstOrDefault()
                    ?.GetSyntax() is VariableDeclaratorSyntax{
                    Initializer: {Value: {} initializer},
                    Parent: Microsoft.CodeAnalysis.CSharp.Syntax.VariableDeclarationSyntax declaration
                }
            ) {
                return false
            }
            if declaration.Type.IsVar {
                if this.ShouldPromoteToNullableReference(local) ||
                    (
                    IsAnnotatedNullableReference(local.Type) && this.IsUsedAsNullable(
                        local,
                        this.GetNullabilityScope(local)
                    )
                ) {
                    return false
                }
            } else {
                let naturalType ITypeSymbol? = this.context.GetTypeInfo(initializer).Type
                if IsAnnotatedNullableReference(local.Type) ||
                    naturalType == nil ||
                    !SymbolEqualityComparer
                    .Default
                    .Equals(local.Type, naturalType) || this.ShouldPromoteToNullableReference(local) {
                    return false
                }
            }
            isNonNull = this.GSharpExpressionIsStaticallyNonNull(initializer)
            return true
        }

        private func ForEachBindingInfersNonNullElement(local ILocalSymbol) bool {
            let body Microsoft.CodeAnalysis.SyntaxNode? = this.state.CurrentBodyScope
            // Iterator lowering preserves the source collection's nullable
            // element annotation, so yield seams handle their own proof here.
            if body
                ?.DescendantNodes()
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.YieldStatementSyntax]()
                .Any() == true {
                return false
            }
            for reference in local.DeclaringSyntaxReferences {
                if reference.GetSyntax() is not ForEachStatementSyntax forEach ||
                    !SymbolEqualityComparer
                    .Default
                    .Equals(this.context.GetDeclaredSymbol(forEach), local) {
                    continue
                }
                let elementType ITypeSymbol? = this.context.SemanticModel.GetForEachStatementInfo(forEach).ElementType
                return if elementType != nil && elementType.IsValueType == true {
                    elementType.OriginalDefinition?.SpecialType != SpecialType.System_Nullable_T
                } else {
                    elementType?.IsReferenceType == true &&
                        elementType!!.NullableAnnotation == Microsoft
                        .CodeAnalysis
                        .NullableAnnotation
                        .NotAnnotated
                }
            }
            return false
        }

        private func PatternLocalUsesNullableStorage(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            let symbol ISymbol? = this.context.GetSymbolInfo(expression).Symbol
            if symbol is not ILocalSymbol{Type: {IsReferenceType: true}} local {
                return false
            }
            if this.state.HoistedNullableGuardLocals.Contains(local) {
                return true
            }
            let isPatternLocal = local.DeclaringSyntaxReferences.Any(
                (reference SyntaxReference) -> reference.GetSyntax() is SingleVariableDesignationSyntax
            )
            let scope_ = this.state.CurrentBodyScope ?? expression!!.SyntaxTree.GetRoot()
            return isPatternLocal && this.IsSymbolReassigned(local, scope_)
        }

        private func IsGSharpFlowNarrowedLocal(expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?) bool {
            var expression = expression
            while expression is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax parenthesized {
                expression = parenthesized.Expression
            }
            let symbol ISymbol? = this.context.GetSymbolInfo(expression).Symbol
            if !(expression is IdentifierNameSyntax) ||
                !((symbol is ILocalSymbol || symbol is IParameterSymbol)) ||
                this
                .context
                .GetTypeInfo(expression)
                .Nullability
                .FlowState != Microsoft
                .CodeAnalysis
                .NullableFlowState
                .NotNull {
                return false
            }
            let scope_ Microsoft.CodeAnalysis.SyntaxNode? = this.state.CurrentBodyScope ?? expression.Ancestors()
                .FirstOrDefault(
                (node Microsoft.CodeAnalysis.SyntaxNode) -> node is BaseMethodDeclarationSyntax ||
                    node is AccessorDeclarationSyntax ||
                    node is LocalFunctionStatementSyntax ||
                    node is AnonymousFunctionExpressionSyntax
            )
            if scope_ == nil {
                return false
            }
            for isPattern in scope_.DescendantNodes(
                (node Microsoft.CodeAnalysis.SyntaxNode) -> !(
                    (node is LocalFunctionStatementSyntax || node is AnonymousFunctionExpressionSyntax)
                )
            )
                .OfType[IsPatternExpressionSyntax]() {
                if isPattern.SpanStart >= expression.SpanStart || !this.BindsToGuardSymbol(
                    isPattern.Expression,
                    symbol
                ) ||
                    !IsNativelyExpressiblePattern(isPattern.Pattern, topLevel: true) ||
                    !TryGetPatternNonNullPolarity(isPattern.Pattern, out var whenTrue) ||
                    !this.GSharpPatternPreservesNonNullNarrowing(isPattern, whenTrue) ||
                    (
                    PatternUsesNativeVariableSyntax(isPattern.Pattern) && !this.ConditionUsesNativePatternVariables(
                        GetConditionRoot(isPattern)
                    )
                ) ||
                    !ComputePatternFlowRegions(isPattern, whenTrue, includeWhenClauseRegion: false).Any(
                    (region Microsoft.CodeAnalysis.SyntaxNode) -> region.Span.Contains(expression!!.Span)
                ) ||
                    this.ClosureAssignedLocalLosesNarrowing(symbol, isPattern, expression, scope_) ||
                    this.SymbolIsWrittenBetween(symbol, isPattern, expression, scope_) || this.HasLoopCarriedWrite(
                    expression,
                    symbol,
                    scope_,
                    isPattern
                ) {
                    continue
                }
                return true
            }
            for nullCheck in scope_.DescendantNodes(
                (node Microsoft.CodeAnalysis.SyntaxNode) -> !(
                    (node is LocalFunctionStatementSyntax || node is AnonymousFunctionExpressionSyntax)
                )
            )
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax]() {
                if nullCheck.SpanStart >= expression.SpanStart || !this.TryGetNullComparisonNonNullPolarity(
                    nullCheck,
                    symbol,
                    out var whenTrue
                ) ||
                    !ComputeBooleanFlowRegions(nullCheck, whenTrue, includeWhenClauseRegion: false).Any(
                    (region Microsoft.CodeAnalysis.SyntaxNode) -> region.Span.Contains(expression!!.Span)
                ) ||
                    this.ClosureAssignedLocalLosesNarrowing(symbol, nullCheck, expression, scope_) ||
                    this.SymbolIsWrittenBetween(symbol, nullCheck, expression, scope_) || this.HasLoopCarriedWrite(
                    expression,
                    symbol,
                    scope_,
                    nullCheck
                ) {
                    continue
                }
                return true
            }
            return false
        }

        /// Issue #4262 follow-up (cs2gs nullability investigation): gsc's own
        /// smart-cast narrowing DOES reach a field/property/member-access-chain
        /// receiver guarded by a null check combined via `&&`/`||`
        /// in the SAME boolean expression (`t.AccessToken != null &&
        /// t.AccessToken.M()`) — confirmed directly against the compiler,
        /// which is a strictly narrower claim than (cref:IsGSharpFlowNarrowedLocal)
        /// makes for a bare local/parameter (that method's guard MAY also cross
        /// a statement boundary, because gsc's narrowing of a LOCAL does too).
        /// It does NOT reach one across a statement boundary (an `if`-body,
        /// an `else`, a ternary arm) for a field/property — that remains a
        /// genuine gsc limitation, and (cref:IsNullGuardNarrowedFieldUse)
        /// exists BECAUSE of it: that rule detects exactly this class of guard
        /// and INSERTS `!!` (the opposite of this method), so the two are
        /// deliberately disjoint, not overlapping fallbacks.
        ///
        /// Purely syntactic — not gated on Roslyn's flow state, unlike
        /// (cref:IsGSharpFlowNarrowedLocal) — because it must also
        /// suppress the oblivious-analysis promoted-nullable / obliviously-
        /// annotated rules below (issues #2506, #3683), which fire on ANY
        /// dereference of such a property with no guard-awareness of their
        /// own; an oblivious file has no Roslyn flow state to gate on in the
        /// first place, exactly like (cref:IsNullGuardNarrowedFieldUse)
        /// and (cref:IsLazyInitGuardedFieldUse) are already syntactic
        /// for the same reason.
        ///
        /// PR #4277 review fix: gsc narrows a member path (see
        /// `AccessPath`/`SmartCastStability` in
        /// `src/Core/CodeAnalysis/Binding`) only when it is a STABLE
        /// path — the same root (a local/parameter or `this`) followed
        /// only by immutable links (a readonly field, or a get-only/init-only,
        /// non-virtual, non-override, non-static auto-property with no custom
        /// getter body) — and only when the guarded operand and the narrowed
        /// use denote the exact SAME path, not merely the same member symbol.
        /// Matching by symbol alone let `a.Foo != null &&
        /// b.Foo.Bar()` be (wrongly) treated as guarded because both
        /// accesses bind to the same property symbol, and let mutable
        /// fields/settable, computed, or overridable properties be (wrongly)
        /// treated as narrowable even though gsc excludes them — either case
        /// could drop a needed `!!` and miscompile with GS0158. The walk below
        /// now derives and compares the FULL stable access path via
        /// (cref:IsSameStableAccessPath).
        private func IsGSharpFlowNarrowedFieldOrPropertyInSameCondition(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            // Climb from the receiver expression up through the SAME "use"
            // subtree (its own enclosing member-access/invocation/element-
            // access/parenthesized/logical-not wrapping) until reaching a
            // point that is exactly the RIGHT operand of an enclosing
            // `&&`/`||` — never past a statement-level construct, which a
            // field/property cannot be narrowed across.
            //
            // Deliberately syntax-only until a matching `&&`/`||` parent is
            // actually found: at the vast majority of receivers (locals,
            // parameters, unguarded chains) this loop hits a non-matching
            // parent and returns before ever touching the semantic model, so
            // this predicate costs nothing extra at sites it can't affect —
            // it never calls into `this.context`/`SemanticModel` for them.
            for var node Microsoft.CodeAnalysis.SyntaxNode? = expression; node!!.Parent != nil; node = node!!.Parent {
                switch node!!.Parent {
                    case Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax {
                        continue
                    }
                    case MemberAccessExpressionSyntax {
                        continue
                    }
                    case InvocationExpressionSyntax {
                        continue
                    }
                    case ElementAccessExpressionSyntax {
                        continue
                    }
                    case prefixUnaryExpressionSyntax is PrefixUnaryExpressionSyntax when prefixUnaryExpressionSyntax.RawKind == int32(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.LogicalNotExpression
                    ) {
                        continue
                    }
                    case binary is Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax when binary.IsKind(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.LogicalAndExpression
                    ) &&
                        binary.Right == node {
                        {
                            return this.TryGetNullCheckedOperand(binary.Left, nonNull: true, out var checkedOperand) &&
                                this.IsSameStableAccessPath(expression, checkedOperand)
                        }
                    }
                    case binary is Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax when binary.IsKind(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.LogicalOrExpression
                    ) &&
                        binary.Right == node {
                        {
                            return this.TryGetNullCheckedOperand(binary.Left, nonNull: false, out var checkedOperand) &&
                                this.IsSameStableAccessPath(expression, checkedOperand)
                        }
                    }
                    default {
                        return false
                    }
                }
            }
            return false
        }

        // The syntactic counterpart of IsNullCheckOf/IsNonNullCheckOf, but
        // returning the checked EXPRESSION rather than testing it against a
        // known symbol — used by IsGSharpFlowNarrowedFieldOrPropertyInSameCondition,
        // which needs to compare the full receiver PATH (not just the leaf
        // symbol) of the guard's operand against a second expression.
        // `nonNull: true` matches `F != null` / `null != F` / `F is not null`;
        // `nonNull: false` matches `F == null` / `null == F` / `F is null`.
        private func TryGetNullCheckedOperand(
            condition Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            nonNull bool,
            out operand Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            var condition = condition
            condition = StripParentheses(condition)
            operand = nil
            switch condition {
                case binary is Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax when binary.IsKind(
                    if nonNull {
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.NotEqualsExpression
                    } else {
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.EqualsExpression
                    }
                ) {
                    if IsNullLiteral(binary.Right) {
                        operand = binary.Left
                        return true
                    }
                    if IsNullLiteral(binary.Left) {
                        operand = binary.Right
                        return true
                    }
                    return false
                }
                case isPattern is IsPatternExpressionSyntax when IsNullConstantPattern(isPattern.Pattern) &&
                    (isPattern.Pattern is UnaryPatternSyntax) == nonNull {
                    operand = isPattern.Expression
                    return true
                }
                default {
                    return false
                }
            }
        }

        // PR #4277 review fix: true when `left` and `right` denote the exact
        // same STABLE access path — same root (a local/parameter, or `this`
        // whether explicit or implicit), followed by an identical sequence of
        // immutable member links (see IsStableMemberSymbol). Both operands
        // being compared always come from the SAME enclosing `&&`/`||`
        // condition (see the caller), so an implicit/explicit `this` root
        // trivially denotes the same instance on both sides without needing
        // its own symbol comparison — no nested lambda/local-function can
        // intervene between two operands of one binary expression.
        // Requires at least one member link on `left` — the CALLER's use
        // expression, i.e. the receiver actually being considered for
        // suppression — so a bare local/parameter (already covered, and
        // flow-gated, by IsGSharpFlowNarrowedLocal) never reaches this
        // syntax-only path, preserving this predicate's original field/
        // property-only scope.
        // <para>
        // Live-CI-confirmed fix (hot-core guard, src/Core/CodeAnalysis/Binding/
        // StatementBinder.Loops.cs's <c>IsLockableReferenceType</c>): a
        // syntactically-stable path is not enough — gsc's own
        // <c>SmartCastStability.TryGetStablePath</c> only recognises a bare
        // <c>BoundVariableExpression</c> as a path ROOT, and only ever
        // descends into a <c>BoundFieldAccessExpression</c>/
        // <c>BoundPropertyAccessExpression</c> RECEIVER (its own switch's
        // recursive call). If the root local/parameter, OR any intermediate
        // receiver along the chain, ITSELF also needs its own `!!` (a
        // separate, "promoted-nullable"/oblivious-receiver decision — e.g.
        // <c>type!!.ClrType</c>), the emitted node there is a
        // <c>BoundUnaryExpression</c>, not a bare variable/field/property
        // access, so gsc does not treat the chain as a stable path at all
        // past that point and never narrows the member hanging off it —
        // even though the member link itself (<c>ClrType</c>, a get/init-only
        // non-virtual auto-property) is perfectly stable in isolation. So
        // this predicate must also check that every receiver checkpoint in
        // the chain will NOT be emitted with its own `!!`.
        // </para>
        private func IsSameStableAccessPath(
            left Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            right Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            if !this.TryDecomposeStableAccessPath(
                left,
                out var leftIsThisRoot,
                out var leftRoot,
                out var leftMembers,
                out var leftReceiverCheckpoints
            ) ||
                leftMembers.Count == 0 ||
                !this.TryDecomposeStableAccessPath(
                right,
                out var rightIsThisRoot,
                out var rightRoot,
                out var rightMembers,
                out _
            ) {
                return false
            }
            if leftIsThisRoot != rightIsThisRoot {
                return false
            }
            if !leftIsThisRoot && !SymbolEqualityComparer.Default.Equals(leftRoot, rightRoot) {
                return false
            }
            if leftMembers.Count != rightMembers.Count {
                return false
            }
            for var i = 0; i < leftMembers.Count; i++ {
                if !SymbolEqualityComparer.Default.Equals(leftMembers[i], rightMembers[i]) {
                    return false
                }
            }
            // Every receiver checkpoint along `left`'s chain (the root, and
            // every intermediate member access used as a receiver for the
            // next member) must NOT itself be emitted with a `!!` — see the
            // remark above. `this` checkpoints are never asserted and are
            // not added to this list by the decomposer.
            for checkpoint in leftReceiverCheckpoints {
                if this.ReceiverNeedsNullForgiveness(checkpoint, isDereferenceReceiver: true) ||
                    this.ReceiverIsNullableReferenceFieldOrProperty(checkpoint) || this.NullableReferenceValueMayBeNull(
                    checkpoint
                ) {
                    return false
                }
            }
            return true
        }

        // PR #4277 review fix: decomposes `expression` into a stable access
        // path — mirroring gsc's own SmartCastStability.TryGetStablePath
        // (src/Core/CodeAnalysis/Binding/SmartCastStability.cs) — or returns
        // false when any link is not a member gsc itself would accept as a
        // stable narrowing link, or the root is not a local/parameter/`this`.
        // `members` is ordered outermost-last (root-to-leaf), matching
        // AccessPath.Members. `receiverCheckpoints` collects every receiver
        // sub-expression along the chain (the root local/parameter, and each
        // intermediate member-access used as the receiver for the next
        // member) EXCEPT a `this` root, explicit or implicit, which is never
        // itself null-forgiven — so the caller can check whether any of them
        // will be emitted with its own `!!`.
        private func TryDecomposeStableAccessPath(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            out isThisRoot bool,
            out rootSymbol ISymbol?,
            out members List[ISymbol],
            out receiverCheckpoints List[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax]
        ) bool {
            isThisRoot = false
            rootSymbol = nil
            members = List[ISymbol]()
            receiverCheckpoints = List[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax]()
            var current Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax? = StripParentheses(expression)
            while true {
                switch current {
                    case ThisExpressionSyntax {
                        isThisRoot = true
                        return true
                    }
                    case memberAccess is MemberAccessExpressionSyntax when memberAccess.IsKind(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.SimpleMemberAccessExpression
                    ) {
                        {
                            let memberSymbol ISymbol? = this.context.GetSymbolInfo(memberAccess).Symbol
                            if !IsStableMemberSymbol(memberSymbol) {
                                return false
                            }
                            members.Insert(0, memberSymbol!!)
                            current = StripParentheses(memberAccess.Expression)
                            if !(current is ThisExpressionSyntax) {
                                receiverCheckpoints.Add(current!!)
                            }
                            continue
                        }
                    }
                    case identifier is IdentifierNameSyntax {
                        {
                            let symbol ISymbol? = this.context.GetSymbolInfo(identifier).Symbol
                            switch symbol {
                                case _ is ILocalSymbol or _ is IParameterSymbol {
                                    rootSymbol = symbol
                                    receiverCheckpoints.Add(identifier)
                                    return true
                                }
                                case _ is IFieldSymbol or _ is IPropertySymbol when IsStableMemberSymbol(symbol) {
                                    // A bare `Foo` reads an instance member through
                                    // an implicit `this.` receiver.
                                    members.Insert(0, symbol!!)
                                    isThisRoot = true
                                    return true
                                }
                                default {
                                    return false
                                }
                            }
                        }
                    }
                    default {
                        return false
                    }
                }
            }
        }

        private func AssignmentResultHasNonNullStaticType(
            assignment Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax
        ) bool {
            if this.PatternLocalUsesNullableStorage(assignment.Left) {
                return false
            }
            let target ISymbol? = this.context.GetSymbolInfo(assignment.Left).Symbol
            let targetType ITypeSymbol? = switch target {
                case local is ILocalSymbol: local.Type
                case parameter is IParameterSymbol: parameter.Type
                case field is IFieldSymbol: field.Type
                case property is IPropertySymbol: property.Type
                default: this.context.GetTypeInfo(assignment.Left).Type
            }
            if targetType != nil && targetType.IsReferenceType == true {
                return this.TargetWillRemainNonNullableReference(targetType, target)
            }
            return targetType != nil && targetType.OriginalDefinition?.SpecialType != SpecialType.System_Nullable_T
        }

        private func HasLoopCarriedWrite(
            use Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            symbol ISymbol?,
            $scope Microsoft.CodeAnalysis.SyntaxNode,
            narrowingGuard Microsoft.CodeAnalysis.SyntaxNode
        ) bool {
            for var node Microsoft
                .CodeAnalysis
                .SyntaxNode? = use!!.Parent;
                node != nil &&
                node != $scope;
                node = node!!
                .Parent {
                if node is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .WhileStatementSyntax ||
                    node is DoStatementSyntax ||
                    node is ForStatementSyntax ||
                    node is ForEachStatementSyntax ||
                    node is ForEachVariableStatementSyntax {
                    // A guard outside a loop is not re-evaluated after a write in
                    // the loop body, so it cannot prove later iterations non-null.
                    let hasWrite = node.DescendantNodes().Any(
                        (candidate Microsoft.CodeAnalysis.SyntaxNode) -> !object.ReferenceEquals(candidate, use) &&
                            this.SyntaxNodeWritesSymbol(candidate, symbol)
                    )
                    if hasWrite && !node.Span.Contains(narrowingGuard.Span) {
                        return true
                    }
                }
            }
            return false
        }

        private func TryGetNullComparisonNonNullPolarity(
            comparison Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax,
            symbol ISymbol?,
            out whenTrue bool
        ) bool {
            if !comparison.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.EqualsExpression) && !comparison.IsKind(
                Microsoft.CodeAnalysis.CSharp.SyntaxKind.NotEqualsExpression
            ) {
                whenTrue = false
                return false
            }
            let comparesSymbolToNull = (
                IsNullLiteral(comparison.Left) && this.BindsToGuardSymbol(comparison.Right, symbol)
            ) ||
                (IsNullLiteral(comparison.Right) && this.BindsToGuardSymbol(comparison.Left, symbol))
            whenTrue = comparison.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.NotEqualsExpression)
            return comparesSymbolToNull
        }

        /// ADR-0208 R15 (#5237): gsc kills the narrowing of a local that a CLOSURE
        /// assigns at every node that runs source code, because that code may run a
        /// closure that escaped. C# flow analysis keeps the fact, so a read the C#
        /// compiler proves non-null can be nilable in the emitted G#. This is the one
        /// decision for it: the guard narrows the use in G# only when no such
        /// call lies between them (and no loop that holds the use but not the
        /// guard runs one), so callers fall back to the asserted read otherwise.
        /// Whether a `ref` or address-of operand names the variable anywhere in its path
        /// (`ref current`, `ref current[0]`, `&current.Field`): the compiler scans the names in
        /// the operand the same way (CollectAddressTakenNames).
        private func OperandNamesVariable(operand Microsoft.CodeAnalysis.SyntaxNode, symbol ISymbol?) bool {
            return operand
                .DescendantNodesAndSelf()
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.IdentifierNameSyntax]()
                .Any((name Microsoft.CodeAnalysis.CSharp.Syntax.IdentifierNameSyntax) -> this.BindsTo(name, symbol))
        }

        /// A local or parameter that a closure (lambda or local function) other than its declaring
        /// function writes, directly or through a `ref` local that names it.
        private func IsClosureAssignedVariable(symbol ISymbol?) bool {
            if symbol is not ILocalSymbol && symbol is not IParameterSymbol {
                return false
            }
            let declaration Microsoft
                .CodeAnalysis
                .SyntaxNode? = symbol!!
                .DeclaringSyntaxReferences
                .Select((reference SyntaxReference) -> reference.GetSyntax())
                .FirstOrDefault()
            if declaration == nil {
                return false
            }
            let declaringFunction = NearestFunctionBoundary(declaration)
            if declaringFunction == nil {
                return false
            }
            // A `ref` local names the storage of another variable, which a closure may assign.
            if symbol is ILocalSymbol{RefKind: not RefKind.None} {
                return true
            }
            for node in declaringFunction.DescendantNodes() {
                if this.SyntaxNodeWritesSymbol(node, symbol) && NearestFunctionBoundary(node) != declaringFunction {
                    return true
                }
                // A `ref` alias or an address-of keeps the variable's storage reachable after a call
                // (gsc's CollectAddressTakenNames), which ends its narrowing the same way.
                if node is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .RefExpressionSyntax refExpression &&
                    this.OperandNamesVariable(refExpression.Expression, symbol) {
                    return true
                }
                if node is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .PrefixUnaryExpressionSyntax addressOf &&
                    addressOf.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.AddressOfExpression) &&
                    this.OperandNamesVariable(addressOf.Operand, symbol) {
                    return true
                }
            }
            return false
        }

        /// A by-reference parameter or a `ref` local. gsc keeps the narrowing of such a variable across a plain call
        /// (amendment A3), but not across a node that may write storage no other root names.
        private func IsByReferenceVariable(symbol ISymbol?) bool {
            if symbol is IParameterSymbol parameter {
                return parameter.RefKind != RefKind.None
            }
            if symbol is ILocalSymbol local {
                return local.RefKind != RefKind.None
            }
            return false
        }

        private let staticInitializerOwners Dictionary[INamedTypeSymbol, bool] = Dictionary[INamedTypeSymbol, bool](
            SymbolEqualityComparer.Default
        )

        /// ADR-0208 R11 and R15 (#5520), the translator side of the compiler's `StaticMemberAccessRunsUserCode`
        /// (src/Core/CodeAnalysis/Binding/StatementBinder.Narrowing.gs): a static field, property or event access
        /// of a type of this compilation that declares a static constructor or a static field whose initializer is
        /// not a literal runs the type initializer at the first access. gsc counts that node as a call, so it
        /// removes member-path and by-reference facts there. The one decision for the translator: callers that
        /// keep a C# flow fact across a node ask it, and keep the `!!` when it says yes. The answer errs towards
        /// yes (a redundant `!!` is removed by the polish pass; a missing one is GS0158). A constant has no
        /// initializer to run.
        private func NodeRunsStaticTypeInitializer(node Microsoft.CodeAnalysis.SyntaxNode) bool {
            if node is not MemberAccessExpressionSyntax && node is not IdentifierNameSyntax {
                return false
            }
            let accessed ISymbol? = this.context.GetSymbolInfo(node).Symbol
            if accessed == nil || !accessed.IsStatic {
                return false
            }
            if accessed is IFieldSymbol{IsConst: true} {
                return false
            }
            if accessed is not IFieldSymbol && accessed is not IPropertySymbol && accessed is not IEventSymbol {
                return false
            }
            let owner = accessed.ContainingType
            if owner == nil {
                return false
            }
            let definition = owner.OriginalDefinition
            if !SymbolEqualityComparer.Default.Equals(
                definition.ContainingAssembly,
                this.context.Compilation.Assembly
            ) {
                return false
            }
            var declares = false
            if this.staticInitializerOwners.TryGetValue(definition, out declares) {
                return declares
            }
            declares = this.TypeDeclaresStaticInitializer(definition)
            this.staticInitializerOwners[definition] = declares
            return declares
        }

        private func TypeDeclaresStaticInitializer(type INamedTypeSymbol) bool {
            for reference in type.DeclaringSyntaxReferences {
                if reference.GetSyntax() is not Microsoft.CodeAnalysis.CSharp.Syntax.TypeDeclarationSyntax declaration {
                    continue
                }
                for member in declaration.Members {
                    if member is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ConstructorDeclarationSyntax constructor &&
                        this.HasModifier(
                        constructor.Modifiers,
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword
                    ) {
                        return true
                    }
                    if member is Microsoft.CodeAnalysis.CSharp.Syntax.FieldDeclarationSyntax field && this.HasModifier(
                        field.Modifiers,
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword
                    ) &&
                        !this
                        .HasModifier(field.Modifiers, Microsoft.CodeAnalysis.CSharp.SyntaxKind.ConstKeyword) {
                        for variable in field.Declaration.Variables {
                            if variable.Initializer is {} initializer && !this.IsLiteralStaticInitializer(
                                initializer.Value
                            ) {
                                return true
                            }
                        }
                    }
                    if member is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .PropertyDeclarationSyntax property &&
                        this.HasModifier(property.Modifiers, Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword) &&
                        property.Initializer is {} propertyInitializer &&
                        !this.IsLiteralStaticInitializer(propertyInitializer.Value) {
                        return true
                    }
                }
            }
            return false
        }

        private func HasModifier(modifiers SyntaxTokenList, kind Microsoft.CodeAnalysis.CSharp.SyntaxKind) bool {
            for modifier in modifiers {
                if modifier.IsKind(kind) {
                    return true
                }
            }
            return false
        }

        /// A literal that needs no conversion, with an optional sign: the emitted initializer is a literal token, so
        /// gsc does not count the static field as running code. The conversion is read on the whole initializer, so a
        /// signed literal that converts to the field type (`uint Max = +1`, emitted as `uint32(+1)`) counts as code, as
        /// does anything else.
        private func IsLiteralStaticInitializer(value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax) bool {
            var current = value
            if current is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .PrefixUnaryExpressionSyntax prefix &&
                (
                prefix.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.UnaryMinusExpression) || prefix.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.UnaryPlusExpression
                )
            ) {
                current = prefix.Operand
            }
            if current is not Microsoft.CodeAnalysis.CSharp.Syntax.LiteralExpressionSyntax literal || literal.IsKind(
                Microsoft.CodeAnalysis.CSharp.SyntaxKind.DefaultLiteralExpression
            ) {
                return false
            }
            let model = this.context.Compilation.GetSemanticModel(value.SyntaxTree)
            if literal.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.NullLiteralExpression) {
                return !model.GetConversion(value).IsUserDefined
            }
            let info = model.GetTypeInfo(value)
            return SymbolEqualityComparer.Default.Equals(info.Type, info.ConvertedType)
        }

        private func ClosureAssignedLocalLosesNarrowing(
            symbol ISymbol?,
            narrowingGuard Microsoft.CodeAnalysis.SyntaxNode,
            use Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            $scope Microsoft.CodeAnalysis.SyntaxNode
        ) bool {
            let closureAssigned = this.IsClosureAssignedVariable(symbol)
            if !closureAssigned && !this.IsByReferenceVariable(symbol) {
                return false
            }
            // ADR-0208 R11 and R15 (#5520): a closure-assigned variable loses its fact at every node that may run
            // source code. A by-reference variable that no closure assigns loses it at a static access of a type whose
            // initializer runs source code, which gsc treats as a call that can write the storage. (gsc also drops it
            // at a constructor call, which is not mirrored here: #5562.)
            let RunsSourceCode = func (node Microsoft.CodeAnalysis.SyntaxNode) bool {
                if closureAssigned && this.NodeMayRunEscapedClosure(node) {
                    return true
                }
                return this.NodeRunsStaticTypeInitializer(node)
            }
            let OutsideNestedFunctions = func (node Microsoft.CodeAnalysis.SyntaxNode) bool {
                return !(node is LocalFunctionStatementSyntax || node is AnonymousFunctionExpressionSyntax)
            }
            if $scope.DescendantNodes(OutsideNestedFunctions).Any(
                (node Microsoft.CodeAnalysis.SyntaxNode) -> node.SpanStart >= narrowingGuard
                    .Span
                    .End &&
                    node
                    .Span
                    .End <= use.SpanStart &&
                    RunsSourceCode(node)
            ) {
                return true
            }
            // A construction runs before the initializer that holds the read (`new T { { current } }`).
            for var enclosing Microsoft
                .CodeAnalysis
                .SyntaxNode? = use.Parent;
                enclosing != nil &&
                enclosing != $scope;
                enclosing = enclosing!!
                .Parent {
                if closureAssigned &&
                    enclosing is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .BaseObjectCreationExpressionSyntax creation &&
                    creation.Initializer != nil &&
                    creation.Initializer!!
                    .Span
                    .Contains(use.Span) && enclosing.SpanStart >= narrowingGuard.Span.End {
                    return true
                }
            }
            for var node Microsoft
                .CodeAnalysis
                .SyntaxNode? = use.Parent;
                node != nil &&
                node != $scope;
                node = node!!
                .Parent {
                if node is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .WhileStatementSyntax ||
                    node is DoStatementSyntax ||
                    node is ForStatementSyntax ||
                    node is ForEachStatementSyntax ||
                    node is ForEachVariableStatementSyntax {
                    if !node.Span.Contains(narrowingGuard.Span) && node.DescendantNodesAndSelf(OutsideNestedFunctions)
                        .Any(RunsSourceCode) {
                        return true
                    }
                }
            }
            return false
        }

        /// Whether a node may run source code in the emitted G#, which ends the narrowing of a
        /// closure-assigned local (ADR-0208 row R15; the compiler's `MayRunEscapedClosure` in
        /// src/Core/CodeAnalysis/Binding/StatementBinder.Narrowing.gs). The translator cannot
        /// predict that set from the C#: the emitted G# lowers properties, static initializers,
        /// disposal, locks, string concatenation, collection expressions and deconstruction to
        /// calls that the C# does not show, and every review round found another. So the
        /// predicate runs the other way round and is closed by construction: a node is call-free
        /// only when it is on the short list in [`IsKnownCallFreeNode`](paramref), and every
        /// other node counts as running source code. A wrong answer here can only add an `!!`
        /// for a closure-assigned local, which the redundant-assertion pass removes if gsc still
        /// narrows; a missed node leaves a bare read that gsc rejects. Locals that no closure
        /// assigns never reach this predicate.
        private func NodeMayRunEscapedClosure(node Microsoft.CodeAnalysis.SyntaxNode) bool {
            return !this.IsKnownCallFreeNode(node)
        }

        private func IsKnownCallFreeNode(node Microsoft.CodeAnalysis.SyntaxNode) bool {
            // A contextual user-defined conversion (`int n = token;`) runs source code at any expression.
            if node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ExpressionSyntax anyExpression &&
                this
                .context
                .SemanticModel
                .GetConversion(anyExpression)
                .IsUserDefined {
                return false
            }
            // The callee part of a call and its argument list run nothing themselves: the
            // invocation node does, once its arguments are evaluated.
            if node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ArgumentListSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ArgumentSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .TupleExpressionSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .DefaultExpressionSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .TypeOfExpressionSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .IsPatternExpressionSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ConstantPatternSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .UnaryPatternSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ConditionalExpressionSyntax {
                return true
            }
            if node is Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax memberAccess {
                let accessed ISymbol? = this.context.GetSymbolInfo(memberAccess).Symbol
                return accessed is IMethodSymbol or
                    INamespaceSymbol or
                    ITypeSymbol ||
                    accessed is IFieldSymbol{IsConst: true}
            }
            if node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .PostfixUnaryExpressionSyntax suppression &&
                suppression.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.SuppressNullableWarningExpression) {
                return true
            }
            if node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .BlockSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ExpressionStatementSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .IfStatementSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ElseClauseSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ReturnStatementSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .BreakStatementSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ContinueStatementSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .EmptyStatementSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .VariableDeclarationSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .VariableDeclaratorSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .EqualsValueClauseSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .PredefinedTypeSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ParenthesizedExpressionSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ThisExpressionSyntax {
                return true
            }
            if node is Microsoft.CodeAnalysis.CSharp.Syntax.LocalDeclarationStatementSyntax declaration {
                return declaration.UsingKeyword.RawKind == 0
            }
            if node is Microsoft.CodeAnalysis.CSharp.Syntax.LiteralExpressionSyntax {
                return true
            }
            if node is Microsoft.CodeAnalysis.CSharp.Syntax.IdentifierNameSyntax {
                let symbol ISymbol? = this.context.GetSymbolInfo(node).Symbol
                return symbol is ILocalSymbol or
                    IParameterSymbol or
                    ITypeSymbol or
                    INamespaceSymbol or
                    IMethodSymbol ||
                    symbol is IFieldSymbol{IsConst: true}
            }
            // Arithmetic, comparison and assignment of built-in numeric values (or a comparison of
            // any value with `null`) is a plain operation; anything else may be an operator call.
            if node is Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax binary {
                return (
                    IsNullLiteral(binary.Left) ||
                        IsNullLiteral(binary.Right) ||
                        (this.IsBuiltInPrimitive(binary.Left) && this.IsBuiltInPrimitive(binary.Right))
                ) &&
                    !this.IsLoweredToCall(binary)
            }
            if node is Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax assignment {
                return this.IsBuiltInPrimitive(assignment.Left) && this.IsBuiltInPrimitive(assignment.Right) &&
                    this
                    .context
                    .GetSymbolInfo(assignment.Left)
                    .Symbol is ILocalSymbol or
                    IParameterSymbol
            }
            if node is Microsoft.CodeAnalysis.CSharp.Syntax.PrefixUnaryExpressionSyntax prefix {
                return this.IsBuiltInPrimitive(prefix.Operand)
            }
            if node is Microsoft.CodeAnalysis.CSharp.Syntax.PostfixUnaryExpressionSyntax postfix {
                return this.IsBuiltInPrimitive(postfix.Operand)
            }
            return false
        }

        private func IsLoweredToCall(binary Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax) bool {
            return this
                .context
                .GetSymbolInfo(binary)
                .Symbol is IMethodSymbol{
                MethodKind: Microsoft
                    .CodeAnalysis
                    .MethodKind
                    .UserDefinedOperator or
                    Microsoft
                    .CodeAnalysis
                    .MethodKind
                    .Conversion
            }
        }

        /// A bool, char, integer or floating-point value, whose operators are plain instructions.
        /// A string, a decimal, an enum and every user type are not.
        private func IsBuiltInPrimitive(expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax) bool {
            let type ITypeSymbol? = this.context.GetTypeInfo(expression).Type
            if type == nil || type.TypeKind == TypeKind.Enum {
                return false
            }
            let kind = type.SpecialType
            return (kind >= SpecialType.System_Boolean && kind <= SpecialType.System_UInt64) ||
                kind == SpecialType.System_Single ||
                kind == SpecialType.System_Double
        }

        private func NearestFunctionBoundary(node Microsoft.CodeAnalysis.SyntaxNode) Microsoft
            .CodeAnalysis
            .SyntaxNode? {
            // A node of a top-level program has no function ancestor: the compilation unit is its
            // function (the synthesized entry point).
            return node.Ancestors().FirstOrDefault(
                (ancestor Microsoft.CodeAnalysis.SyntaxNode) -> ancestor is BaseMethodDeclarationSyntax ||
                    ancestor is AccessorDeclarationSyntax ||
                    ancestor is LocalFunctionStatementSyntax ||
                    ancestor is AnonymousFunctionExpressionSyntax
            ) ??
                node
                .SyntaxTree
                .GetRoot()
        }

        private func SymbolIsWrittenBetween(
            symbol ISymbol?,
            start Microsoft.CodeAnalysis.SyntaxNode,
            use Microsoft.CodeAnalysis.SyntaxNode?,
            $scope Microsoft.CodeAnalysis.SyntaxNode
        ) bool {
            return $scope.DescendantNodes(
                (node Microsoft.CodeAnalysis.SyntaxNode) -> !(
                    (node is LocalFunctionStatementSyntax || node is AnonymousFunctionExpressionSyntax)
                )
            )
                .Any(
                (node Microsoft.CodeAnalysis.SyntaxNode) -> node.SpanStart > start
                    .Span
                    .End &&
                    node
                    .Span
                    .End <= use!!.SpanStart &&
                    this.SyntaxNodeWritesSymbol(node, symbol)
            )
        }

        private func GetDeclaredValueType(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) ITypeSymbol? -> switch this
            .context
            .GetSymbolInfo(value)
            .Symbol {
            case field is IFieldSymbol: field.Type
            case local is ILocalSymbol: local.Type
            case parameter is IParameterSymbol: parameter.Type
            case property is IPropertySymbol: property.Type
            default: default(ITypeSymbol?)
        }

        private func IsFlowNarrowedAnnotatedReference(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            let typeInfo = this.context.GetTypeInfo(value)
            let declaredType ITypeSymbol? = this.GetDeclaredValueType(value)
            return typeInfo
                .Nullability
                .FlowState == Microsoft
                .CodeAnalysis
                .NullableFlowState
                .NotNull &&
                (
                typeInfo
                    .Nullability
                    .Annotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated ||
                    typeInfo
                    .Type
                    ?.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated ||
                    declaredType?.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated
            )
        }

        private func NullableReferenceValueMayBeNull(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            respectDeclaredAnnotations bool = false,
            respectDeclaredCallResults bool = false
        ) bool {
            let nullableForEachBinding = this.IsNullableForEachBindingUse(value)
            let managedArrayGenericResult = this.ManagedReferenceArrayWidenedExpressionMayBeNull(value)
            if (
                !nullableForEachBinding && !managedArrayGenericResult && this.GSharpExpressionIsStaticallyNonNull(
                    value,
                    checkNullableForEachBinding: false
                )
            ) ||
                value is PostfixUnaryExpressionSyntax &&
                value.RawKind == int32(Microsoft.CodeAnalysis.CSharp.SyntaxKind.SuppressNullableWarningExpression) ||
                this.IsWithinExpressionTreeLambda(value) || this.IsCallableValueExpression(value) {
                return false
            }
            // Issues #4500 and #4525: an element read or foreach binding from
            // an array cs2gs emits with nullable elements.
            if this.IsNullableArrayElementAccess(value) || nullableForEachBinding || managedArrayGenericResult {
                return true
            }
            let typeInfo = this.context.GetTypeInfo(value)
            let type ITypeSymbol? = typeInfo.Type ?? typeInfo.ConvertedType
            if !(type != nil && type.IsReferenceType == true) {
                return false
            }
            // An oblivious producer's unannotated reference return is imported by
            // gsc as T? regardless of the consumer's nullable context. Roslyn
            // reports that metadata as Annotation.None, so its flow state cannot
            // drive the target-aware receiver/value bridges below.
            let valueSymbol ISymbol? = this.context.GetSymbolInfo(value).Symbol
            if this.IsImportedObliviousNullableMember(valueSymbol) {
                return true
            }
            // Imported oblivious collection metadata applies to nested element
            // positions too. gsc now preserves that position for indexers and
            // foreach variables, so mirror the existing outer-member bridge at
            // the element dereference instead of losing the producer's
            // nullable-by-default contract.
            if this.IsImportedObliviousCollectionElement(value, valueSymbol) {
                return true
            }
            let nullableByShape = switch value {
                case parenthesized is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ParenthesizedExpressionSyntax: this.NullableReferenceValueMayBeNull(
                    parenthesized.Expression,
                    respectDeclaredAnnotations,
                    respectDeclaredCallResults
                )
                case cast is CastExpressionSyntax: this.NullableReferenceValueMayBeNull(
                    cast.Expression,
                    respectDeclaredAnnotations,
                    respectDeclaredCallResults
                )
                case conditional is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ConditionalExpressionSyntax: this.NullableReferenceValueMayBeNull(
                    conditional.WhenTrue,
                    respectDeclaredAnnotations,
                    respectDeclaredCallResults
                ) ||
                    this.NullableReferenceValueMayBeNull(
                    conditional.WhenFalse,
                    respectDeclaredAnnotations,
                    respectDeclaredCallResults
                )
                case switchExpression is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .SwitchExpressionSyntax: switchExpression
                    .Arms
                    .Any(
                    (
                        arm Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionArmSyntax
                    ) -> this.NullableReferenceValueMayBeNull(
                        arm.Expression,
                        respectDeclaredAnnotations,
                        respectDeclaredCallResults
                    )
                )
                case coalesce is Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax when coalesce.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.CoalesceExpression
                ): this.NullableReferenceValueMayBeNull(
                    coalesce.Right,
                    respectDeclaredAnnotations,
                    respectDeclaredCallResults
                )
                case assignment is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .AssignmentExpressionSyntax: this.PatternLocalUsesNullableStorage(assignment.Left)
                default: false
            }
            return nullableByShape ||
                type.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated ||
                typeInfo
                .Nullability
                .Annotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated ||
                (
                respectDeclaredAnnotations && this.GetDeclaredValueType(value)
                    ?.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated
            ) ||
                (respectDeclaredCallResults && this.DeclaredCallResultIsAnnotatedNullable(value))
        }

        /// Issues #5526 and #5527: whether [`awaited`](paramref) awaits a call whose `Task<T?>` or
        /// `ValueTask<T?>` declares a nullable result, read where C# runs no flow analysis.
        /// @remarks The `?` is on the task's type argument, which survives on the declared type where the
        /// expression's own annotation does not. `IsNullableInitializer` asks this too, so a `var` local
        /// initialized by such an await is `T?` for the rules that read it.
        private func DeclaredAwaitedResultIsAnnotatedNullable(
            awaited Microsoft.CodeAnalysis.CSharp.Syntax.AwaitExpressionSyntax
        ) bool {
            // `task.ConfigureAwait(false)` awaits the same task through its configured awaitable.
            var awaitedTask Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax = awaited.Expression
            if awaitedTask is InvocationExpressionSyntax{
                Expression: MemberAccessExpressionSyntax{Name: {Identifier: {ValueText: "ConfigureAwait"}}} configured
            } &&
                this
                .context
                .GetSymbolInfo(awaitedTask)
                .Symbol is IMethodSymbol{
                ContainingType: {ContainingNamespace: {} configuredNamespace} configuredOwner
            } &&
                configuredNamespace.ToDisplayString() == "System.Threading.Tasks" &&
                (configuredOwner.Name == "Task" || configuredOwner.Name == "ValueTask") {
                awaitedTask = configured.Expression
            }
            return this.IsAnnotationsContextWithoutFlowAnalysis(awaited) &&
                this
                .context
                .GetSymbolInfo(awaitedTask)
                .Symbol is IMethodSymbol{ReturnType: INamedTypeSymbol{TypeArguments: {Length: 1} typeArguments} task} &&
                (task.OriginalDefinition.Name == "Task" || task.OriginalDefinition.Name == "ValueTask") &&
                task
                .ContainingNamespace
                ?.ToDisplayString() == "System.Threading.Tasks" &&
                typeArguments[0].IsReferenceType &&
                typeArguments[0].NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated
        }

        /// Issue #5516: whether [`value`](paramref) is a call whose method declares a `T?` result,
        /// read where C# runs no flow analysis (see (cref:IsAnnotationsContextWithoutFlowAnalysis)).
        /// @remarks A field, property, local or parameter keeps its `T?` on the expression type there
        /// (see (cref:GetDeclaredValueType)); a call result does not, so its declaration is the only
        /// place C# states it. A flow state, when Roslyn has one, already answers this.
        private func DeclaredCallResultIsAnnotatedNullable(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            var call Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax? = value
            while call is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax parenthesized {
                call = parenthesized.Expression
            }
            // `IsNullableInitializer` is the translator's one reading of a declared `T?`: it also
            // follows `[return: NotNullIfNotNull]` to the argument, as `Path.GetFileName(path)` needs.
            // Issue #5526: `await call` yields the type argument of the task, whose `?` is part of
            // the declared type and survives where the call's own annotation does not.
            if call is Microsoft.CodeAnalysis.CSharp.Syntax.AwaitExpressionSyntax awaited {
                return !this.FlowsThroughUserDefinedConversion(value) && this.DeclaredAwaitedResultIsAnnotatedNullable(
                    awaited
                )
            }
            if !(call is InvocationExpressionSyntax) || !this.IsAnnotationsContextWithoutFlowAnalysis(call) ||
                // A user-defined conversion has its own input and result contracts, which
            // the conversion bridge in `ForgiveNullableReferenceValueCore` decides.
            this.FlowsThroughUserDefinedConversion(value) {
                return false
            }
            // G# narrows a guarded argument, and the call then returns it non-null.
            if ConditionalNotNullPostcondition.TryGetForwardedArgument(
                call,
                func (node Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax) ISymbol? {
                    return this.context.GetSymbolInfo(node).Symbol
                },
                out var forwarded
            ) &&
                this
                .context
                .GetSymbolInfo(forwarded)
                .Symbol is {} forwardedSymbol &&
                (forwardedSymbol is ILocalSymbol || forwardedSymbol is IParameterSymbol) &&
                this.IsDominatedByNullCheckGuard(forwarded, forwardedSymbol) {
                return false
            }
            return this.IsNullableInitializer(call)
        }

        private func IsImportedObliviousCollectionElement(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            valueSymbol ISymbol?
        ) bool {
            if this.ReadsObliviousContainerStorageElement(value) {
                return true
            }
            if value is ElementAccessExpressionSyntax elementAccess && this.IsImportedObliviousNullableMember(
                this.context.GetSymbolInfo(elementAccess.Expression).Symbol
            ) {
                return true
            }
            if valueSymbol is not ILocalSymbol local {
                return false
            }
            for reference in local.DeclaringSyntaxReferences {
                if reference.GetSyntax() is ForEachStatementSyntax forEach && this.IsImportedObliviousNullableMember(
                    this.context.GetSymbolInfo(forEach.Expression).Symbol
                ) {
                    return true
                }
            }
            return false
        }

        private func GetUserDefinedConversionInputOperator(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            resultType ITypeSymbol?,
            out convertsValue bool
        ) IMethodSymbol? {
            convertsValue = true
            for var conversion IConversionOperation? = ObliviousNullabilityAnalyzer.GetResultConversion(
                value,
                this.context.SemanticModel
            );
                conversion != nil &&
                conversion.IsImplicit == true;
                conversion = conversion!!.Operand as IConversionOperation {
                if conversion.OperatorMethod is {Parameters: {Length: 1}} method {
                    return method
                }
            }
            var current Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax? = value
            while (
                current!!.Parent is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ParenthesizedExpressionSyntax or
                    Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .CheckedExpressionSyntax
            ) {
                current = cast[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax](current!!.Parent)
            }
            if current!!.Parent is CastExpressionSyntax cast && cast.Expression == current {
                for var conversion IConversionOperation? = ObliviousNullabilityAnalyzer.GetResultConversion(
                    cast,
                    this.context.SemanticModel
                );
                    conversion != nil;
                    conversion = conversion!!.Operand as IConversionOperation {
                    if conversion.OperatorMethod is {Parameters: {Length: 1}} method {
                        convertsValue = false
                        return method
                    }
                }
            }
            return if ObliviousNullabilityAnalyzer.GetContextualOperator(
                value,
                this.context.SemanticModel,
                resultType
            ) is {Parameters: {Length: 1}} contextualOperator {
                contextualOperator
            } else {
                default(IMethodSymbol?)
            }
        }

        // Whether `node` reaches its sink through a conversion that calls a
        // user-defined conversion operator. The input obeys the operator's
        // parameter contract, not the contract of the converted-result sink.
        private func FlowsThroughUserDefinedConversion(node Microsoft.CodeAnalysis.SyntaxNode?) bool {
            var node = node
            while node is Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax expression {
                for var conversion IConversionOperation? = ObliviousNullabilityAnalyzer.GetResultConversion(
                    expression,
                    this.context.SemanticModel
                );
                    conversion != nil;
                    conversion = conversion!!.Operand as IConversionOperation {
                    if conversion.OperatorMethod != nil {
                        return true
                    }
                }
                if node.Parent is not(
                    Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ParenthesizedExpressionSyntax or
                        CastExpressionSyntax or
                        Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .CheckedExpressionSyntax
                ) {
                    break
                }
                node = node.Parent
            }
            return false
        }

        // Whether the branching expression `value` is an arm of — climbed
        // through parentheses and nested arms to the outermost one, returned in
        // `branch` — is nil-valued or nil-observing as a whole, so no arm's `!!`
        // can serve any purpose:
        //   - some arm at any level is a `null`/`default` literal, so the whole
        //     is `T?` in G#, and anything it flows into must accept nil;
        //   - or the whole is the left operand of `??`, a `?.` receiver, an
        //     operand of `== null` / `!= null`, or tested with `is null`.
        private func BranchResultAcceptsNil(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            out branch Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            let IsNilArm = func (arm Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax) bool {
                var arm = arm
                while arm is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ParenthesizedExpressionSyntax ||
                    arm is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .CheckedExpressionSyntax {
                    arm = switch arm {
                        case parenthesized is Microsoft
                            .CodeAnalysis
                            .CSharp
                            .Syntax
                            .ParenthesizedExpressionSyntax: parenthesized.Expression
                        case checkedExpression is Microsoft
                            .CodeAnalysis
                            .CSharp
                            .Syntax
                            .CheckedExpressionSyntax: checkedExpression.Expression
                        default: arm
                    }
                }
                // `default(T)` is nil for a reference type or Nullable<T>,
                // never for `default(int)`.
                return IsNullOrSuppressedNull(arm) || arm.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.DefaultLiteralExpression
                ) ||
                    (
                    arm is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .DefaultExpressionSyntax &&
                        this
                        .context
                        .GetTypeInfo(arm)
                        .Type is {} defaultType &&
                        (
                        defaultType.IsReferenceType ||
                            defaultType
                            .OriginalDefinition
                            .SpecialType == SpecialType.System_Nullable_T
                    )
                )
            }
            var hasNilArm = false
            var current Microsoft.CodeAnalysis.SyntaxNode? = value
            while true {
                if (
                    current!!.Parent is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ParenthesizedExpressionSyntax or
                        Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .CheckedExpressionSyntax or
                        PostfixUnaryExpressionSyntax and
                        {RawKind: int32(Microsoft.CodeAnalysis.CSharp.SyntaxKind.SuppressNullableWarningExpression)}
                ) {
                    // `!` has no runtime meaning: the arm still flows wherever
                    // the suppressed expression flows.
                    current = current!!.Parent
                } else if current!!.Parent is CastExpressionSyntax cast &&
                    this
                    .context
                    .SemanticModel
                    .GetOperation(cast) is IConversionOperation{OperatorMethod: nil} conversion &&
                    conversion
                    .Type
                    ?.IsReferenceType == true &&
                    conversion
                    .Operand
                    .Type
                    ?.IsReferenceType == true &&
                    (conversion.Conversion.IsReference || conversion.Conversion.IsIdentity) {
                    // A built-in reference cast preserves nil; operators and
                    // unboxing remain actual conversion-consumer boundaries.
                    current = cast
                } else if current!!.Parent is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ConditionalExpressionSyntax conditional &&
                    (conditional.WhenTrue == current || conditional.WhenFalse == current) {
                    hasNilArm |= IsNilArm(conditional.WhenTrue) || IsNilArm(conditional.WhenFalse)
                    current = conditional
                } else if current!!.Parent is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .SwitchExpressionArmSyntax{
                    Parent: Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionSyntax switchExpression
                } arm &&
                    arm.Expression == current {
                    hasNilArm |= switchExpression.Arms.Any(
                        (candidate Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionArmSyntax) -> IsNilArm(
                            candidate.Expression
                        )
                    )
                    current = switchExpression
                } else {
                    break
                }
            }
            branch = cast[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax](current)
            if hasNilArm {
                return true
            }
            return switch current!!.Parent {
                case coalesce is Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax when coalesce.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.CoalesceExpression
                ): coalesce.Left == current
                case conditionalAccess is ConditionalAccessExpressionSyntax: conditionalAccess.Expression == current
                case equality is Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax when equality.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.EqualsExpression
                ) ||
                    equality.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.NotEqualsExpression
                ): IsNullOrSuppressedNull(
                    if equality.Left == current {
                        equality.Right
                    } else {
                        equality.Left
                    }
                )
                case isPattern is IsPatternExpressionSyntax: isPattern.Expression == current &&
                    IsNullConstantPattern(isPattern.Pattern)
                case interpolation is InterpolationSyntax: interpolation.Expression == current
                case concatenation is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .BinaryExpressionSyntax when concatenation.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.AddExpression
                ) &&
                    this
                    .context
                    .GetTypeInfo(concatenation)
                    .Type
                    ?.SpecialType == SpecialType.System_String: true
                case appendAssignment is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .AssignmentExpressionSyntax when appendAssignment.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.AddAssignmentExpression
                ) &&
                    appendAssignment.Right == current &&
                    this
                    .context
                    .GetTypeInfo(appendAssignment)
                    .Type
                    ?.SpecialType == SpecialType.System_String: true
                case asExpression is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .BinaryExpressionSyntax when asExpression.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.AsExpression
                ): asExpression.Left == current
                case switchScrutinee is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .SwitchExpressionSyntax: switchScrutinee.GoverningExpression == current
                case switchStatement is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .SwitchStatementSyntax: switchStatement.Expression == current
                default: false
            }
        }

        private func FindContextualValueTarget(value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?)(
            Type ITypeSymbol?,
            Symbol ISymbol?
        ) {
            // A C# `!` has no runtime meaning, so an arm under one still flows
            // into the suppressed expression's sink, and that sink is the
            // target when it accepts nil (`string chosen = (c ? a : b)!;` with
            // `chosen` widened to `T?`). Otherwise the `!` is where the value
            // is asserted, so the arm keeps the target it has below it and the
            // `!` itself becomes the one `!!`.
            let climbed = this.FindContextualValueTarget(value, climbSuppression: true, out var crossedSuppression)
            return if !crossedSuppression || this.NullForgivingTargetAcceptsNil(climbed.Type, climbed.Symbol) {
                climbed
            } else {
                this.FindContextualValueTarget(value, climbSuppression: false, out _)
            }
        }

        private func FindContextualValueTarget(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            climbSuppression bool,
            out crossedSuppression bool
        )(Type ITypeSymbol?, Symbol ISymbol?) {
            crossedSuppression = false
            // An arm follows its containing branches until a conversion's
            // parameter or a declared sink supplies its immediate contract.
            var current Microsoft.CodeAnalysis.SyntaxNode? = value
            var isBranchArm = false
            while true {
                if isBranchArm &&
                    current is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ExpressionSyntax branch &&
                    this.GetUserDefinedConversionInputOperator(
                    branch,
                    this.context.GetTypeInfo(branch).ConvertedType,
                    out _
                ) is {Parameters: {Length: 1}} consumer {
                    let parameter = consumer.Parameters[0]
                    return (parameter.Type, parameter)
                }
                if (
                    current!!.Parent is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ParenthesizedExpressionSyntax or
                        Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .CheckedExpressionSyntax
                ) {
                    current = current!!.Parent
                } else if climbSuppression &&
                    (
                    current!!.Parent is PostfixUnaryExpressionSyntax and
                        {RawKind: int32(Microsoft.CodeAnalysis.CSharp.SyntaxKind.SuppressNullableWarningExpression)}
                ) {
                    current = current!!.Parent
                    crossedSuppression = true
                } else if current!!.Parent is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ConditionalExpressionSyntax conditional &&
                    (conditional.WhenTrue == current || conditional.WhenFalse == current) {
                    current = conditional
                    isBranchArm = true
                } else if current!!.Parent is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .SwitchExpressionArmSyntax{
                    Parent: Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionSyntax switchExpression
                } arm &&
                    arm.Expression == current {
                    current = switchExpression
                    isBranchArm = true
                } else {
                    break
                }
            }
            if current!!.Parent is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .YieldStatementSyntax &&
                this
                .context
                .SemanticModel
                .GetEnclosingSymbol(value!!.SpanStart) is IMethodSymbol iterator &&
                this.GetIteratorStoreSlot(value, iterator) is {} iteratorSlot {
                return (iteratorSlot, iterator)
            }
            let target ISymbol? = switch current!!.Parent {
                case _ is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ReturnStatementSyntax: this
                    .context
                    .SemanticModel
                    .GetEnclosingSymbol(value!!.SpanStart)
                case arrow is ArrowExpressionClauseSyntax: this.context.GetDeclaredSymbol(arrow.Parent)
                case lambda is AnonymousFunctionExpressionSyntax when lambda.Body == current: (
                    this.GetLambdaTargetDelegateType(lambda)?.DelegateInvokeMethod as ISymbol
                )
                default: default(ISymbol?)
            }
            if target == nil &&
                isBranchArm &&
                current!!.Parent is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .AssignmentExpressionSyntax assignment &&
                assignment.Right == current &&
                assignment.Left is ElementAccessExpressionSyntax elementAccess {
                let projectedElement ITypeSymbol? = this.GetMappedArrayElementType(elementAccess.Expression)
                if projectedElement != nil &&
                    projectedElement.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated {
                    return (projectedElement, nil)
                }
            }
            if target == nil &&
                (current!!.Parent is ArgumentSyntax and {Parent: TupleExpressionSyntax}) &&
                this.ResolveValueSink(value) is {} tupleSink && this.GetFixedElementDestinationType(
                value,
                tupleSink
            ) is {} tupleTargetType {
                return (tupleTargetType, tupleSink)
            }
            // An arm's effective target is the sink of the whole expression — a
            // local, field, property, assignment target or parameter — and
            // the type is the one that sink declares, which cs2gs may have
            // widened to `T?` (TargetWillRemainNonNullableReference reads it
            // off the symbol). The arm's own converted type is only the C#
            // conditional's type, which in oblivious code never says `?`.
            //
            // A `var` local is not a target: in nullable-enabled C# its type is
            // always annotated, but in G# it is inferred from the emitted value,
            // so leaving the arm bare would make the local `T?` and move the
            // failure to its next use. It is a target only when cs2gs itself
            // widens it (it then emits the `T?` clause).
            if target == nil && isBranchArm && !this.FlowsThroughUserDefinedConversion(current) &&
                this.ResolveValueSink(
                cast[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax](current)
            ) is {} sink &&
                !(
                sink is ILocalSymbol inferredLocal &&
                    IsImplicitlyTypedLocal(inferredLocal) &&
                    !this.ShouldPromoteToNullableReference(inferredLocal) && !this.IsUsedAsNullable(
                    inferredLocal,
                    this.GetNullabilityScope(inferredLocal)
                )
            ) {
                let sinkType ITypeSymbol? = switch sink {
                    case local is ILocalSymbol: local.Type
                    case field is IFieldSymbol: field.Type
                    case property is IPropertySymbol: property.Type
                    case parameter is IParameterSymbol: parameter.Type
                    default: default(ITypeSymbol?)
                }
                if sinkType != nil {
                    return (sinkType, sink)
                }
            }
            // Issue #4356: an async LAMBDA's target is its delegate's Invoke, which
            // is never itself `async`; the effective result is the envelope's
            // `T`, exactly as for an async method.
            let asyncLambdaBody = current!!.Parent is AnonymousFunctionExpressionSyntax asyncLambda &&
                asyncLambda
                .AsyncKeyword
                .IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.AsyncKeyword)
            let targetType ITypeSymbol? = switch target {
                case method is IMethodSymbol: GetEffectiveReturnType(
                    method.ReturnType,
                    method.IsAsync || asyncLambdaBody
                )
                case property is IPropertySymbol: property.Type
                default: this.context.GetTypeInfo(value).ConvertedType
            }
            return (targetType, target)
        }

        /// Issue #4356: whether a target (an EFFECTIVE type — the `T` of an
        /// async `Task<T>`, never the envelope) is certainly non-null in
        /// G#, so a `T?`-only-in-G# analyzer value flowing into it must be
        /// asserted. Anything that may accept nil answers false: an unknown
        /// target, a `Nullable<T>`, any annotated `T?` (reference or
        /// generic), and an unannotated type parameter, whose instantiation may
        /// itself be nullable. The assertion is only fail-safe where the target
        /// really is non-null; anywhere else it turns a legal nil into a throw.
        /// Every analyzer-value bridge (value, argument, cast, lambda result)
        /// asks this one predicate, and when unsure it answers false.
        /// @param targetType The effective target type, if known.
        /// @param targetSymbol The target parameter/member, if any.
        /// @param callSite For a parameter target, the argument expression — used to tell an
        /// INFERRED generic target from an EXPLICIT one (see
        /// (cref:IsInferredGenericParameterTarget)).
        /// @returns True when the target is certainly non-null in G#.
        private func AnalyzerBridgeTargetIsNonNull(
            targetType ITypeSymbol?,
            targetSymbol ISymbol? = nil,
            callSite Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax? = nil
        ) bool -> targetType != nil &&
            !(targetType is ITypeParameterSymbol) &&
            targetType
            .OriginalDefinition
            ?.SpecialType != SpecialType.System_Nullable_T &&
            targetType.NullableAnnotation != Microsoft
            .CodeAnalysis
            .NullableAnnotation
            .Annotated &&
            !(targetSymbol is IParameterSymbol parameter && IsInferredGenericParameterTarget(parameter, callSite)) &&
            (
            !targetType.IsReferenceType || this.TargetWillRemainNonNullableReference(targetType, targetSymbol, callSite)
        )

        private func FindNullForgivingTarget(value PostfixUnaryExpressionSyntax)(Type ITypeSymbol?, Symbol ISymbol?) {
            let ExplicitLocalTypeIsNullable = func (local ILocalSymbol) bool {
                return local
                    .Type
                    .NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated &&
                    local
                    .DeclaringSyntaxReferences
                    .Any(
                    (reference SyntaxReference) -> (
                        reference.GetSyntax() is VariableDeclaratorSyntax and
                            {
                            Parent: Microsoft
                                .CodeAnalysis
                                .CSharp
                                .Syntax
                                .VariableDeclarationSyntax and
                                {Type: {IsVar: false}}
                        }
                    )
                )
            }
            let sink ISymbol? = this.ResolveValueSink(value)
            return switch sink {
                case local is ILocalSymbol when ExplicitLocalTypeIsNullable(local): (local.Type, local)
                case widenedLocal is ILocalSymbol when !IsImplicitlyTypedLocal(widenedLocal) &&
                    widenedLocal
                    .Type
                    .IsReferenceType &&
                    !this.TargetWillRemainNonNullableReference(widenedLocal.Type, widenedLocal): (
                    widenedLocal.Type,
                    widenedLocal
                )
                case field is IFieldSymbol when field
                    .Type
                    .NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated: (field.Type, field)
                case property is IPropertySymbol when property
                    .Type
                    .NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated: (property.Type, property)
                default: this.FindContextualValueTarget(value)
            }
        }

        private func NullForgivingTargetAcceptsNil(
            targetType ITypeSymbol?,
            targetSymbol ISymbol?,
            writtenValue Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax? = nil
        ) bool -> targetType?.NullableAnnotation == Microsoft
            .CodeAnalysis
            .NullableAnnotation
            .Annotated ||
            targetType
            ?.OriginalDefinition
            ?.SpecialType == SpecialType.System_Nullable_T ||
            (
            targetType != nil && targetType.IsReferenceType == true && !this.TargetWillRemainNonNullableReference(
                targetType,
                targetSymbol,
                writtenValue
            )
        )

        // Issue #2511: element-access arguments are call-like value sinks too.
        // Apply the established forgiveness predicate only when Roslyn bound the
        // argument to a non-null reference parameter that cs2gs will keep
        // non-null. Arrays and numeric/string/span indices therefore stay on
        // their existing paths, explicitly nullable indexer contracts remain
        // untouched, and nullable-enabled projects receive new assertions only
        // for values imported from nullable-oblivious assemblies.
        // A genuinely null oblivious key follows the existing `!!` bridge
        // policy and fails at runtime before the index operation.
        private func TranslateIndexArgumentWithNullForgiveness(argument ArgumentSyntax) GExpression? {
            let translated GExpression? = this.TranslateExpression(argument.Expression)
            // Issue #3564: a TUPLE-typed key whose G#-side elements are
            // promoted-nullable while the indexer's key tuple elements are not
            // (`store[key]` where `key` is `(ISymbol?, SyntaxNode)` against a
            // `Dictionary[(ISymbol, SyntaxNode), bool]` field) cannot be
            // bridged with a whole-value `!!` — G# has no implicit
            // `(T?, U) -> (T, U)`. Rebuild the key per element, asserting only
            // the promoted slots: `store[(key.Item1!!, key.Item2)]`. A
            // genuinely null element follows the established `!!` bridge
            // policy and fails at runtime before the index operation.
            if this.TryRebuildPromotedTupleIndexKey(argument, translated, out var rebuiltKey) {
                return rebuiltKey
            }
            // A key whose arms are already asserted (issue #5516) is non-null as a whole.
            if !this.IndexArgumentTargetsNonNullableReference(argument) || !this.IndexArgumentValueNeedsNullForgiveness(
                argument.Expression
            ) ||
                this.GSharpExpressionIsStaticallyNonNull(argument.Expression, translated) {
                return translated
            }
            let assertionOperand GExpression? = if (
                argument.Expression is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ConditionalExpressionSyntax or
                    Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .SwitchExpressionSyntax or
                    ConditionalAccessExpressionSyntax
            ) {
                cast[GExpression](ParenthesizedExpression(translated))
            } else {
                translated
            }
            return this.ReportStoreBridge(
                argument.Expression,
                translated,
                EnsureNonNullAssertion(assertionOperand),
                (this.context.SemanticModel.GetOperation(argument) as IArgumentOperation)?.Parameter
            )
        }

        private func TryRebuildPromotedTupleIndexKey(
            argument ArgumentSyntax,
            translated GExpression?,
            out rebuilt GExpression?
        ) bool {
            rebuilt = nil
            if !this.IsObliviousCompilation() {
                return false
            }
            if !(
                this
                    .context
                    .SemanticModel
                    .GetOperation(argument) is IArgumentOperation{
                    Parameter: {Type: INamedTypeSymbol{IsTupleType: true} keyTuple}
                }
            ) {
                return false
            }
            let valueSymbol ISymbol? = this.context.GetSymbolInfo(argument.Expression).Symbol
            if !(
                (
                    valueSymbol is ILocalSymbol ||
                        valueSymbol is IParameterSymbol ||
                        valueSymbol is IFieldSymbol ||
                        valueSymbol is IPropertySymbol
                )
            ) ||
                this
                .context
                .GetTypeInfo(argument.Expression)
                .Type is not INamedTypeSymbol{IsTupleType: true} valueTuple ||
                valueTuple
                .TupleElements
                .Length != keyTuple
                .TupleElements
                .Length {
                return false
            }
            let elements = List[GExpression](keyTuple.TupleElements.Length)
            var anyAsserted = false
            for var i = 0; i < keyTuple.TupleElements.Length; i++ {
                var element GExpression? = MemberAccessExpression(translated, "Item${i + 1}", isArrow: false)
                let keyElement = keyTuple.TupleElements[i]
                var keyElementStaysNonNull = keyElement.Type is {IsReferenceType: true} &&
                    keyElement
                    .Type
                    .NullableAnnotation != Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated
                if keyElementStaysNonNull && this.TryGetIndexReceiverGenericTuple(
                    argument,
                    out var receiver,
                    out var tuplePath
                ) &&
                    ObliviousNullabilityAnalyzer
                    .IsTupleElementTainted(
                    this.context.Compilation,
                    receiver,
                    tuplePath!!.Concat([]int32{i}).ToList(),
                    this.context.SiblingCompilations
                ) {
                    keyElementStaysNonNull = false
                }
                if keyElementStaysNonNull && ObliviousNullabilityAnalyzer.IsTupleElementTainted(
                    this.context.Compilation,
                    valueSymbol,
                    List[int32]{i},
                    this.context.SiblingCompilations
                ) {
                    // The C# key supplies the location; the bound element
                    // supplies the slot of this synthesized assertion.
                    element = this.ReportStoreBridge(
                        argument.Expression,
                        element,
                        NonNullAssertionExpression(element),
                        targetSymbol: nil,
                        knownSlotType: keyElement.Type,
                        projection: ".Item${i + 1}"
                    )
                    anyAsserted = true
                }
                elements.Add(element!!)
            }
            if !anyAsserted {
                return false
            }
            rebuilt = TupleLiteralExpression(elements)
            return true
        }

        private func TryGetIndexReceiverGenericTuple(
            argument ArgumentSyntax,
            out receiver ISymbol?,
            out tuplePath IReadOnlyList[int32]?
        ) bool {
            receiver = nil
            tuplePath = nil
            if argument
                .Parent
                ?.Parent is not ElementAccessExpressionSyntax elementAccess ||
                this
                .context
                .SemanticModel
                .GetOperation(argument) is not IArgumentOperation operation ||
                operation.Parameter is not IParameterSymbol parameter {
                return false
            }
            let receiverSymbol ISymbol? = this.context.GetSymbolInfo(elementAccess.Expression).Symbol
            if !((receiverSymbol is IFieldSymbol || receiverSymbol is IPropertySymbol)) {
                return false
            }
            let receiverType ITypeSymbol? = switch receiverSymbol {
                case field is IFieldSymbol: field.Type
                case property is IPropertySymbol: property.Type
                default: default(ITypeSymbol?)
            }
            if receiverType is not INamedTypeSymbol namedReceiver ||
                !ObliviousNullabilityAnalyzer.TryGetGenericReceiverTuplePath(
                namedReceiver,
                parameter,
                out _,
                out tuplePath
            ) {
                return false
            }
            receiver = receiverSymbol
            return true
        }

        private func IndexArgumentValueNeedsNullForgiveness(
            value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) bool {
            // ADR-0186 step 6 (PR 0): a `T!` index argument is checked by gsc.
            if IsNullOrSuppressedNull(value) ||
                value is PostfixUnaryExpressionSyntax &&
                value.RawKind == int32(Microsoft.CodeAnalysis.CSharp.SyntaxKind.SuppressNullableWarningExpression) ||
                this.IsWithinExpressionTreeLambda(value) || this.PlatformTypedImportNeedsNoBridge(value) {
                return false
            }
            // Issue #3896: a dominating null-check guard removes the need for an
            // assertion only when gsc will actually smart-cast the guarded
            // storage — and gsc (by design, Kotlin-style) smart-casts LOCALS and
            // PARAMETERS, not fields/properties. Suppressing the assertion for a
            // guarded FIELD/PROPERTY key made this path contradict the ordinary
            // argument path, which asserts exactly that shape via
            // ReceiverNeedsNullForgiveness' #2202 rule: in the same method,
            // `if (n.Syntax != null && map.TryGetValue(n.Syntax, out i))` was
            // translated with `n.Syntax!!` while `map[n.Syntax] = i` under
            // `if (n.Syntax != null)` was left bare and failed to compile
            // (GS0155). Scope the suppression to the symbol kinds gsc narrows
            // and let the field/property case fall through to the shared rules.
            let valueSymbol ISymbol? = this.context.GetSymbolInfo(value).Symbol
            if (valueSymbol is ILocalSymbol || valueSymbol is IParameterSymbol) && this.IsDominatedByNullCheckGuard(
                value,
                valueSymbol
            ) {
                return false
            }
            // The caller proved that the indexer key stays non-null (issue #5254).
            if this.ReceiverNeedsNullForgiveness(value, widenedSinkNeedsNonNull: true) {
                return true
            }
            if this.NullableReferenceValueMayBeNull(value, respectDeclaredCallResults: true) {
                return true
            }
            switch value {
                case parenthesized is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax {
                    return this.IndexArgumentValueNeedsNullForgiveness(parenthesized.Expression)
                }
                case conditional is Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalExpressionSyntax {
                    return this.IndexArgumentValueNeedsNullForgiveness(conditional.WhenTrue) ||
                        this.IndexArgumentValueNeedsNullForgiveness(conditional.WhenFalse)
                }
                case switchExpression is Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionSyntax {
                    return switchExpression.Arms.Any(
                        (
                            arm Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionArmSyntax
                        ) -> this.IndexArgumentValueNeedsNullForgiveness(arm.Expression)
                    )
                }
                case ConditionalAccessExpressionSyntax {
                    return true
                }
            }
            let symbol ISymbol? = valueSymbol
            return this.IsObliviousCompilation() &&
                (
                symbol is IFieldSymbol ||
                    symbol is IPropertySymbol ||
                    symbol is ILocalSymbol ||
                    symbol is IParameterSymbol ||
                    symbol is IMethodSymbol
            ) &&
                this.IsNullablePromotedValue(value) && !this.IsDominatedByNullCheckGuard(value, symbol)
        }

        private func IndexArgumentTargetsNonNullableReference(argument ArgumentSyntax) bool {
            if !(this.context.SemanticModel.GetOperation(argument) is IArgumentOperation{Parameter: {} parameter}) {
                return false
            }
            return this.ParameterWillRemainNonNullableReference(parameter, argument.Expression)
        }

        private func ParameterWillRemainNonNullableReference(
            parameter IParameterSymbol,
            argumentValue Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax? = nil
        ) bool {
            return this.TargetWillRemainNonNullableReference(parameter.Type, parameter, argumentValue)
        }

        /// Issue #5516: whether [`node`](paramref) sits in a file with `#nullable enable annotations`
        /// and warnings off (the shape of a source-generated file), in a compilation that is not
        /// nullable-oblivious. Roslyn runs no flow analysis there: the flow state of every expression is
        /// `None`, so the declared annotations are the only nullability C# states. Every rule that reads a
        /// declaration instead of a flow state asks this one question.
        private func IsAnnotationsContextWithoutFlowAnalysis(node Microsoft.CodeAnalysis.SyntaxNode?) bool {
            if node == nil || this.IsObliviousCompilation() {
                return false
            }
            if this.context.GetTypeInfo(node).Nullability.FlowState != Microsoft.CodeAnalysis.NullableFlowState.None {
                return false
            }
            let nullableContext = this.context.SemanticModel.GetNullableContext(node.SpanStart)
            return nullableContext.HasFlag(NullableContext.AnnotationsEnabled) && !nullableContext.HasFlag(
                NullableContext.WarningsEnabled
            )
        }

        /// Issue #5527: whether [`symbol`](paramref) is a `var` local whose initializer is nullable by declaration.
        /// @remarks G# infers `T?` for it, so a read that feeds a sink which stays non-null needs the same `!!`
        /// that full flow analysis gives when C# knows the local is non-null there.
        private func IsInferredNullableLocal(symbol ISymbol?) bool {
            return symbol is ILocalSymbol local &&
                IsImplicitlyTypedLocal(local) &&
                local
                .DeclaringSyntaxReferences
                .FirstOrDefault()
                ?.GetSyntax() is VariableDeclaratorSyntax{Initializer: {Value: {} initializer}} &&
                this.IsNullableInitializer(initializer)
        }

        /// Determines whether [`recv`](paramref) needs a G# `!!`
        /// assertion because it is either a declared-nullable reference narrowed
        /// non-null by flow or an ordinary dereference receiver whose declaration
        /// was promoted nullable by oblivious analysis (see
        /// (cref:TranslateReceiverWithNullForgiveness)).
        private func ReceiverNeedsNullForgiveness(
            recv Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            isDereferenceReceiver bool = false,
            widenedSinkNeedsNonNull bool = false,
            widenedSinkInfersType bool = false
        ) bool {
            if this.GSharpExpressionIsStaticallyNonNull(recv) || this.IsActivePatternBinding(recv) ||
                this.IsGSharpFlowNarrowedLocal(recv) || this.IsGSharpFlowNarrowedFieldOrPropertyInSameCondition(recv) {
                return false
            }
            // `expr!` already lowers to a `NonNullAssertionExpression`; never
            // double-assert. `this`/`base`, a null literal, and a `?.` conditional
            // access receiver are handled by their own paths and are not
            // declared-nullable property/field chains.
            if recv is PostfixUnaryExpressionSyntax &&
                recv.RawKind == int32(Microsoft.CodeAnalysis.CSharp.SyntaxKind.SuppressNullableWarningExpression) ||
                recv is ThisExpressionSyntax ||
                recv is BaseExpressionSyntax ||
                recv is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .LiteralExpressionSyntax ||
                recv is ConditionalAccessExpressionSyntax {
                return false
            }
            // Issue #2496: `!!` is a runtime-only G# operator and therefore is
            // never representable inside an expression tree (GS0473). Use the
            // lambda's semantic converted type rather than call/constructor
            // syntax so this covers overload-selected Expression<TDelegate>
            // parameters, generic expression sinks, fluent APIs, and nested
            // quoted lambdas uniformly. A user-authored C# suppression (`expr!`)
            // has already returned above and still translates to `!!`, preserving
            // the compiler's expression-tree restriction diagnostic.
            if this.IsWithinExpressionTreeLambda(recv) {
                return false
            }
            // Issue #2504/#2496: a method group or lambda is the callable value
            // itself, never the nullable value produced by invoking it. External
            // oblivious-return forgiveness belongs at the callable's result
            // contract, not as `MethodGroup!!` on the delegate conversion seam.
            if this.IsCallableValueExpression(recv) {
                return false
            }
            // Issue #5537: an element of storage that keeps an imported oblivious
            // container is `T?` in G#. A C# dereference of it throws on nil. A value
            // position keeps the target-aware bridge, so a nullable target gets no `!!`.
            if isDereferenceReceiver && this.ReadsObliviousContainerStorageElement(recv) {
                return NullForgivenessTelemetry.Record("5537-oblivious-container-element")
            }
            if isDereferenceReceiver &&
                this
                .context
                .GetSymbolInfo(recv)
                .Symbol is IParameterSymbol callableParameter &&
                this
                .state
                .ProjectedCallableParameterType
                .TryGetValue(callableParameter, out var projectedCallableType) &&
                projectedCallableType.IsReferenceType &&
                projectedCallableType.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
                return NullForgivenessTelemetry.Record("4525-projected-callable-parameter")
            }
            // Issue #2506: the oblivious analysis promotes a same-project
            // method/property/indexer declaration when its VALUE can be null.
            // An ordinary C# dereference of that value still means
            // throw-on-null, so the corresponding G# receiver needs one `!!`.
            // Keep this receiver-only: a method group is the callable value
            // rather than its return, and a promoted call forwarded as a return
            // or argument must remain `T?` instead of being blanket-forgiven.
            if isDereferenceReceiver && this.ReceiverValueIsPromotedNullable(recv) {
                return NullForgivenessTelemetry.Record("2506-promoted-nullable-receiver")
            }
            // Issue #3683 (family F5): the sibling of the promoted-value rule
            // above for a declaration that was never promoted because it was
            // ANNOTATED `T?` all along, read from an OBLIVIOUS file. Same
            // receiver-only gate, same faithfulness argument.
            if isDereferenceReceiver && this.ReceiverValueIsObliviouslyReadAnnotatedResult(recv) {
                return NullForgivenessTelemetry.Record("3683-obliviously-annotated-result")
            }
            // Issue #2164: the classic lazy-singleton pattern initializes a
            // nullable static/instance field (or auto-property) under a null
            // guard (`if (F == null) { F = new(); } ... return F;` / `F ??= …;`),
            // so `F` is provably non-null at every use dominated by the guard.
            // gsc (by design, Kotlin-style) smart-casts only LOCALS, never
            // fields/properties, so the guarded read `T? -> T` is rejected
            // (GS0155). The migrated corpus is nullable-OBLIVIOUS, so Roslyn's
            // flow state is empty and the flow-based path below never fires;
            // detect the guard from SYNTAX and assert `F!!` instead.
            if this.IsLazyInitGuardedFieldUse(recv) {
                return NullForgivenessTelemetry.Record("2164-lazy-init-guarded-field")
            }
            // Issue #2202: `if (F == null) {…} else { …F… }` / `F == null ? … : …F…`
            // (and the negated forms) narrow `F` to non-null on the guarded
            // branch — same syntactic-guard rationale as the lazy-init case
            // above, for a plain null-check guard instead of a lazy-init one.
            if this.IsNullGuardNarrowedFieldUse(recv) {
                return NullForgivenessTelemetry.Record("2202-null-guard-narrowed-field")
            }
            // Issue #2202 / #2412 (round 3): a nullable-tainted field/property
            // read as ANY arm of a conditional/switch expression, when that
            // conditional is the (possibly parenthesized) body of a property/
            // method whose return type was deliberately kept non-null by the
            // oblivious analyzer's property-contract / forwarding-exclusion
            // guardrail (#1354 / #2167). The original C# accepted this
            // implicitly (oblivious, no enforcement); cs2gs keeps the declared
            // return non-null (matching the sibling project's own contract, so
            // downstream consumers of the property/method are unaffected), so
            // forgiving each tainted arm is the minimal assertion needed to
            // compile the member without regressing safety or widening its
            // contract. This subsumes the original, narrower #2202 shape where
            // one arm happens to ALSO be null-guard-narrowed by the condition
            // (e.g. `Book is null ? Component : Book`, the Oahu.Data
            // `Conversion.BookCommon` shape) — that arm is separately asserted
            // by <see cref="IsNullGuardNarrowedFieldUse"/>, and this rule
            // additionally covers the case where NEITHER arm is guarded by the
            // condition at all (e.g. `Profile.PreAmazon ? HttpClientAudible :
            // HttpClientAmazon`, the Oahu.Core `AudibleApi.HttpClient` shape,
            // where the condition is an unrelated flag, not a null-check on
            // either arm).
            if this.IsNullableTaintedArmOfReturnPreservingConditional(recv) {
                return NullForgivenessTelemetry.Record("2202-2412-tainted-arm-return-preserving-conditional")
            }
            // Issue #4211: the ELEMENT-ACCESS-SINK sibling of the rule just
            // above. #2259 already bridges `arr[i] = <promoted nullable>` with
            // `!!` — but only when the WHOLE right-hand side is recognizably
            // promoted. A conditional/switch RHS is not: `IsNullablePromotedValue`
            // routes a ternary through `IsNullableInitializer`, which recurses
            // into the arms but consults only their DECLARED annotations, never
            // the whole-program taint fixpoint — so `arr[i] = cond ? a : b` with
            // a taint-promoted arm was invisible to the sink rule and emitted a
            // bare `T?` arm into a `T` element slot (GS0155). Each arm is
            // translated through `TranslateValueWithNullForgiveness`, so
            // answering per-arm here bridges exactly the arms that need it and
            // leaves an already-non-null sibling arm byte-identical — the same
            // shape the return-preserving rule above uses, pointed at the one
            // other sink the taint fixpoint structurally cannot widen.
            if this.IsNullableTaintedArmOfElementAccessAssignment(recv) {
                return NullForgivenessTelemetry.Record("4211-tainted-arm-element-access-assignment")
            }
            // Issue #2432: an UNCONDITIONAL (no ternary/switch, no null-check
            // guard) forward of a same-project promoted-nullable field / property
            // / local / parameter / method as the ENTIRE (possibly parenthesized)
            // body of a property/method whose own return type was deliberately
            // kept non-null by the very same property-contract / forwarding-
            // exclusion guardrail (#1354 / #2167) that left the forwarded value
            // tainted in the first place. The canonical shape is an EXPLICIT
            // interface property implementation that forwards to a same-project
            // concrete property promoted through unrelated flow (the exact
            // Oahu.Core shape: `Authorization` is promoted to `Authorization?`
            // because its constructor can receive a null from
            // `Authorization.Create`, but the explicit `IAuthorization
            // IProfile.Authorization => Authorization;` forwarder's own type stays
            // the non-null interface contract `IAuthorization`, since
            // `CollectInterfacePropertyEdges` never taints an explicit-impl
            // forwarder from the property it merely reads, and
            // `SeedPropertyLikeReturnTaint` excludes property-forwarding from
            // transitivity for exactly this reason). Unlike
            // <see cref="IsNullableTaintedArmOfReturnPreservingConditional"/>,
            // no sibling ternary arm exists to require — the guardrail
            // relationship alone (this value being the WHOLE return-preserving
            // body) is sufficient evidence gsc will reject the bare `T? -> T`
            // conversion (GS0155): the original C# accepted the same forward
            // implicitly (oblivious, unchecked), so asserting `!!` here is the
            // minimal bridge, not a widening of the interface contract.
            if this.IsUnguardedForwardOfTaintedValueInReturnPreservingBody(recv) {
                return NullForgivenessTelemetry.Record("2432-unguarded-forward-return-preserving-body")
            }
            // Issue #2496: once callable values stop borrowing their synthesized
            // method symbol's return taint, a runtime delegate lambda still needs
            // the old, legitimate bridge at its RESULT seam. Keep that bridge
            // narrowly target-typed to a non-null delegate return contract. The
            // expression-tree guard above deliberately excludes quoted lambdas.
            if this.IsUnguardedForwardOfTaintedValueAsRuntimeLambdaResult(recv) {
                return NullForgivenessTelemetry.Record("2496-unguarded-forward-lambda-result")
            }
            // Issue #2434: the ARGUMENT-position counterpart of the rule just
            // above — an UNCONDITIONAL (no guard dominating this exact use)
            // forward of a same-project promoted-nullable value as a call-site
            // argument whose bound parameter is a genuine non-null reference
            // type cs2gs will not also promote. Covers ordinary calls, direct
            // delegate invocations, and conditional delegate invocations alike
            // (the exact Oahu.Core BookLibrary.gs:490 shape:
            // `callback?(tmp)` where `tmp` is `Conversion?` and the delegate
            // parameter is `IConversion`).
            if this.IsUnguardedForwardOfTaintedValueAsArgument(recv) {
                return NullForgivenessTelemetry.Record("2434-unguarded-forward-argument")
            }
            // Issue #2202: a call (or property/field read) whose result comes from
            // an imported member compiled without a nullable context is
            // oblivious — Roslyn reports its reference-type return/type as
            // `NullableAnnotation.None` — and gsc maps every such oblivious
            // external reference type to `T?` (see ClrNullability.cs). When such a
            // value appears as a return/expression-body result in an oblivious
            // compilation, gsc will require `T?` but the C# source assigned no
            // nullability (oblivious); assert `!!` to bridge the gap. This mirrors
            // the RECEIVER-position handling in ReceiverIsNullableReferenceFieldOrProperty
            // (issue #2113) but for VALUE positions (return statements, expression
            // bodies). The declaring contract, not the consumer's nullable mode,
            // determines how gsc imports the value.
            //
            // ADR-0186 step 6 (PR 0): that `T?` reading is ADR-0136's, which
            // step 3 replaced. gsc now reads oblivious CLR metadata as `T!` and
            // checks it at the coercion itself, so the rule is kept only for a
            // member this run also migrates (whose emitted type cs2gs decides)
            // and for a value whose platform-ness would reach type inference.
            if this.IsImportedObliviousNullableMember(this.context.GetSymbolInfo(recv).Symbol) &&
                !this
                .PlatformTypedImportNeedsNoBridge(recv) {
                return NullForgivenessTelemetry.Record("2202-imported-oblivious-nullable-member")
            }
            // Issue #2412: a VALUE-position read (`return foo.Name;`,
            // `sink.Accept(foo.Name)`) of a field/property/parameter/local/method
            // declared in a REFERENCED SIBLING project (a separate
            // `CSharpCompilation`, loaded by `CSharpProjectLoader.
            // LoadProjectWithReferencesAsync`) that the sibling's OWN whole-
            // program taint fixpoint proved null-tainted. Unlike a same-project
            // tainted value — whose consuming property/method/local is itself
            // promoted to `T?` by THIS compilation's own `Compute()` edge walk
            // (issue #2167), so the value flows `T? -> T?` and needs no `!!` —
            // a foreign symbol can never seed an edge in this compilation's own
            // fixpoint (the tainting evidence lives only in the sibling's
            // syntax), so the consuming declaration's OWN type is never promoted
            // and the mismatch must be bridged here, at the read, instead. Gated
            // to a symbol whose `ContainingAssembly` differs from this
            // compilation's own assembly so every intra-project case (handled by
            // the existing promotion path above) is completely untouched.
            let foreignCandidate ISymbol? = this.context.GetSymbolInfo(recv).Symbol
            if this.IsObliviousCompilation() &&
                (
                foreignCandidate is IFieldSymbol ||
                    foreignCandidate is IPropertySymbol ||
                    foreignCandidate is IParameterSymbol ||
                    foreignCandidate is ILocalSymbol ||
                    foreignCandidate is IMethodSymbol
            ) &&
                !SymbolEqualityComparer
                .Default
                .Equals(foreignCandidate!!.ContainingAssembly, this.context.Compilation.Assembly) &&
                this
                .ShouldPromoteToNullableReference(foreignCandidate) {
                return NullForgivenessTelemetry.Record("2412-cross-project-oblivious-value-read")
            }
            // Flow analysis must have proven the receiver non-null at this site.
            // Issue #4500: in a `<Nullable>annotations</Nullable>` context the
            // declarations are annotated but Roslyn runs no flow analysis, so a
            // `T?` receiver's flow state is None rather than NotNull, even after
            // an `Assert.NotNull(x)` or an earlier `x!` that C# relies on. G#
            // narrows neither, and the receiver keeps its `T?` type, so the
            // dereference is asserted exactly as a flow-proven one is: C#
            // throws on a null here too.
            let flowState = this.context.GetTypeInfo(recv).Nullability.FlowState
            let symbol ISymbol? = this.context.GetSymbolInfo(recv).Symbol
            // Issue #5254: in this context C# runs no flow analysis, so the
            // declaration is the only contract C# states. A declaration that C#
            // declares non-null and cs2gs widened only to bind a null write
            // (see (cref:IsTranslatorWidenedDeclaration)) is therefore read as
            // non-null at every read whose sink needs a non-null value, not only
            // at a dereference. The caller that knows the sink says so with
            // `widenedSinkNeedsNonNull`. A sink that accepts nil keeps the widened
            // value, and so does a type argument that G# infers from the value
            // (`widenedSinkInfersType`): without a flow state the value may be null.
            // With a flow state (the tail below) the inferred type argument is the
            // non-null one C# proved, so the argument is asserted there.
            let annotationsWithoutFlowAnalysis = (
                isDereferenceReceiver ||
                    (
                    widenedSinkNeedsNonNull &&
                        !widenedSinkInfersType &&
                        (
                        this.IsTranslatorWidenedDeclaration(symbol) ||
                            (this.IsInferredNullableLocal(symbol) && !this.FlowsThroughUserDefinedConversion(recv))
                    )
                )
            ) &&
                this.IsAnnotationsContextWithoutFlowAnalysis(recv)
            if flowState != Microsoft.CodeAnalysis.NullableFlowState.NotNull && !annotationsWithoutFlowAnalysis {
                return false
            }
            // Static member access (`Type.StaticMember`) and namespace-qualified
            // names carry a type/namespace receiver, not a value: never assert.
            if symbol is ITypeSymbol || symbol is INamespaceSymbol || symbol == nil {
                return false
            }
            // Inspect the receiver's *declared* type. The flow-collapsed
            // `Nullability.Annotation` reports NotAnnotated once flow proves
            // non-null, so it cannot distinguish a declared `T?` from a `T`; the
            // declaring symbol's type is the reliable source.
            let declared ITypeSymbol? = switch symbol {
                case property is IPropertySymbol: property.Type
                case field is IFieldSymbol: field.Type
                case local is ILocalSymbol: local.Type
                case parameter is IParameterSymbol: parameter.Type
                case method is IMethodSymbol: method.ReturnType
                default: default(ITypeSymbol?)
            }
            // Focus on the GS0158/GS0116 cases: nullable reference types and
            // nullable arrays. Nullable value types (`int?`) take the `.Value`/
            // `.HasValue` path and are left untouched.
            if !(declared != nil && declared.IsReferenceType == true) {
                return false
            }
            // A declared-nullable receiver (`T?`) flow-proven non-null needs `!!`.
            // A declared non-null receiver that this pass PROMOTED to `T?`
            // (issue #1072: null-checked param/field/local) is rendered nullable
            // too, so its flow-proven uses need the same assertion for consistency.
            if declared.NullableAnnotation == Microsoft.CodeAnalysis.NullableAnnotation.Annotated {
                return NullForgivenessTelemetry.Record("flow-proven-declared-nullable")
            }
            // Issue #4500: without flow analysis an implicitly typed local's
            // own annotation is None, but G# infers it from its initializer,
            // so it is `T?` exactly when that initializer is.
            if annotationsWithoutFlowAnalysis &&
                symbol is ILocalSymbol implicitLocal &&
                IsImplicitlyTypedLocal(implicitLocal) &&
                implicitLocal
                .DeclaringSyntaxReferences
                .FirstOrDefault()
                ?.GetSyntax() is VariableDeclaratorSyntax{Initializer: {Value: {} implicitInitializer}} &&
                this
                .IsNullableInitializer(implicitInitializer) {
                return NullForgivenessTelemetry.Record("4500-annotations-context-nullable-local")
            }
            if this.IsTranslatorWidenedDeclaration(symbol) {
                // Issue #5254: a value read of a widened declaration is forgiven
                // only where the caller has proved the sink needs a non-null value
                // (`widenedSinkNeedsNonNull`). A sink that accepts nil, or one that
                // G# infers from the value, keeps the `T?` that C# writes into it.
                return (isDereferenceReceiver || widenedSinkNeedsNonNull) && NullForgivenessTelemetry.Record(
                    "1072-flow-proven-promoted-nullable"
                )
            }
            return false
        }

        /// Issue #3683 (family F5): true when [`expression`](paramref) is a
        /// CALL RESULT — an invocation or an indexer read — whose <em>declared</em>
        /// return is an annotated `T?` reference, evaluated inside a
        /// nullable-OBLIVIOUS compilation.
        /// @remarks This is the call-result door onto the same cross-nullable-context read
        /// that issue #3683's cast-receiver half (family F6) closed. When an
        /// oblivious file (`test/Core.Tests` declares no `Nullable`
        /// setting) calls an ANNOTATED API (`src/Core`, or the annotated BCL:
        /// `Type? Type.GetElementType()`), Roslyn erases the annotation at the
        /// call site — `GetTypeInfo(...).Type.NullableAnnotation` reads
        /// `None` and the flow state is `None` too — so neither
        /// (cref:NullableReferenceValueMayBeNull) nor the flow-gated tail of
        /// (cref:ReceiverNeedsNullForgiveness) can see anything nullable.
        /// The declaring symbol's own return type still carries the annotation, and
        /// gsc maps it to `T?`, so the chained dereference was rejected
        /// (GS0158 on a member, GS0116 on an index). A nullable-ENABLED compilation
        /// needs none of this: there the annotation survives on the expression's
        /// type and the existing predicates already fire, so this stays gated to
        /// oblivious.
        ///
        /// Asserting is faithful and stays receiver-only: C# raises a
        /// (cref:System.NullReferenceException) at exactly this dereference,
        /// and `!!` raises at exactly the same point. A call result forwarded
        /// as a return value or an argument is NOT covered here — that value must
        /// keep its `T?` and reach the declaration-promotion path instead.
        private func ReceiverValueIsObliviouslyReadAnnotatedResult(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            if !this.IsObliviousCompilation() {
                return false
            }
            switch expression {
                case parenthesized is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax {
                    return this.ReceiverValueIsObliviouslyReadAnnotatedResult(parenthesized.Expression)
                }
                case invocation is InvocationExpressionSyntax {
                    // A `Task<T>`/`ValueTask<T>` envelope is itself non-null; its
                    // annotation belongs to the awaited T (see
                    // AwaitedReceiverValueIsPromotedNullable), never to the
                    // receiver being dereferenced here.
                    return this
                        .context
                        .GetSymbolInfo(invocation)
                        .Symbol is IMethodSymbol method &&
                        !IsTaskLikeEnvelope(method.ReturnType) &&
                        IsAnnotatedNullableReference(method.ReturnType)
                }
                case elementAccess is ElementAccessExpressionSyntax {
                    return this
                        .context
                        .GetSymbolInfo(elementAccess)
                        .Symbol is IPropertySymbol indexer &&
                        IsAnnotatedNullableReference(indexer.Type)
                }
                default {
                    return false
                }
            }
        }

        private func ReceiverValueIsPromotedNullable(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            if !this.IsObliviousCompilation() {
                return false
            }
            switch expression {
                case parenthesized is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax {
                    return this.ReceiverValueIsPromotedNullable(parenthesized.Expression)
                }
                case cast is CastExpressionSyntax {
                    // Issue #3501: align with CastUsesCheckedReferenceConversion
                    // (identity reference casts included) so a null-preserving
                    // `expr as T` lowering still surfaces its operand's
                    // promotion to the receiver-forgiveness pass.
                    return this.CastUsesCheckedReferenceConversion(cast) && this.ReceiverValueIsPromotedNullable(
                        cast.Expression
                    )
                }
                case awaited is Microsoft.CodeAnalysis.CSharp.Syntax.AwaitExpressionSyntax {
                    return this.AwaitedReceiverValueIsPromotedNullable(awaited.Expression)
                }
                case conditional is Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalExpressionSyntax {
                    return this.ReceiverValueIsPromotedNullable(conditional.WhenTrue) ||
                        this.ReceiverValueIsPromotedNullable(conditional.WhenFalse)
                }
                case switchExpression is Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionSyntax {
                    return switchExpression.Arms.Any(
                        (
                            arm Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionArmSyntax
                        ) -> this.ReceiverValueIsPromotedNullable(arm.Expression)
                    )
                }
                case coalesce is Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax when coalesce.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.CoalesceExpression
                ) {
                    return this.ReceiverValueIsPromotedNullable(coalesce.Right)
                }
                case invocation is InvocationExpressionSyntax when this
                    .context
                    .GetSymbolInfo(invocation)
                    .Symbol is IMethodSymbol method {
                    // Method-return taint on Task<T>/ValueTask<T> widens the
                    // awaited T, not the non-null task envelope itself.
                    return !IsTaskLikeEnvelope(method.ReturnType) && this.ShouldPromoteToNullableReference(method)
                }
                case elementAccess is ElementAccessExpressionSyntax {
                    return this
                        .context
                        .GetSymbolInfo(elementAccess)
                        .Symbol is IPropertySymbol indexer &&
                        this.ShouldPromoteToNullableReference(indexer)
                }
                case IdentifierNameSyntax, MemberAccessExpressionSyntax {
                    // Issue #3663: a DECONSTRUCTING `foreach` variable carries no
                    // taint of its own — it aliases a tuple leaf of the enumerated
                    // sequence, and G# infers its type from that leaf. A promoted
                    // leaf therefore makes the dereference `T? -> T` (GS0158).
                    if ObliviousNullabilityAnalyzer.IsDeconstructedForEachElementTainted(
                        this.context.Compilation,
                        expression,
                        this.context.SemanticModel,
                        this.context.SiblingCompilations
                    ) {
                        return true
                    }
                    let symbol ISymbol? = this.context.GetSymbolInfo(expression).Symbol
                    if symbol is ILocalSymbol local && !this.ShouldPromoteToNullableReference(local) &&
                        local
                        .DeclaringSyntaxReferences
                        .FirstOrDefault()
                        ?.GetSyntax() is VariableDeclaratorSyntax{Initializer: {Value: {} initializer}} {
                        return this.IsNullablePromotedValue(initializer)
                    }
                    return (
                        symbol is IFieldSymbol ||
                            symbol is IPropertySymbol ||
                            symbol is ILocalSymbol ||
                            symbol is IParameterSymbol
                    ) &&
                        this.ShouldPromoteToNullableReference(symbol)
                }
                default {
                    return false
                }
            }
        }

        private func AwaitedReceiverValueIsPromotedNullable(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) bool {
            switch expression {
                case parenthesized is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax {
                    return this.AwaitedReceiverValueIsPromotedNullable(parenthesized.Expression)
                }
                case cast is CastExpressionSyntax {
                    return this.AwaitedReceiverValueIsPromotedNullable(cast.Expression)
                }
                case conditional is Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalExpressionSyntax {
                    return this.AwaitedReceiverValueIsPromotedNullable(conditional.WhenTrue) ||
                        this.AwaitedReceiverValueIsPromotedNullable(conditional.WhenFalse)
                }
                case invocation is InvocationExpressionSyntax when this
                    .context
                    .GetSymbolInfo(invocation)
                    .Symbol is IMethodSymbol method {
                    return IsTaskLikeEnvelope(method.ReturnType) && this.ShouldPromoteToNullableReference(method)
                }
                default {
                    return false
                }
            }
        }

        // Issue #2164: true when <paramref name="recv"/> reads a nullable
        // (`T?`) field/property that is lazily initialized under a dominating
        // null guard, so it is provably non-null here and needs an explicit
        // `!!` (gsc never smart-casts fields/properties). The decision is purely
        // syntactic because the migrated corpus compiles nullable-oblivious.
        private func IsLazyInitGuardedFieldUse(recv Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?) bool {
            if !this.TryGetEmittedNullableFieldOrProperty(recv, out var symbol) {
                return false
            }
            return this.IsDominatedByLazyInitGuard(recv, symbol)
        }

        // Issue #2202: shared prerequisite for the lazy-init-guard and
        // null-check-guard `!!` heuristics below — <paramref name="recv"/> must
        // be a bare/qualified read of a field or property that G# actually
        // emits as `T?` (declared nullable, or promoted to nullable by the
        // oblivious taint analysis). A read that is itself the LHS of an
        // assignment, the operand of a null comparison, or a `nameof` argument
        // is handled by other paths and is never a value read a guard narrows.
        private func TryGetEmittedNullableFieldOrProperty(
            recv Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            out symbol ISymbol?
        ) bool {
            symbol = this.context.GetSymbolInfo(recv).Symbol
            if !((symbol is IFieldSymbol || symbol is IPropertySymbol)) {
                symbol = nil
                return false
            }
            // The field/property must be emitted `T?` in G# — either declared
            // nullable or promoted to nullable by this translator (the taint
            // analysis / #1072 null-usage rules). Otherwise there is no `T? -> T`
            // to forgive and asserting `!!` on a non-null value is wrong.
            let declared ITypeSymbol? = switch symbol {
                case field is IFieldSymbol: field.Type
                case property is IPropertySymbol: property.Type
                default: default(ITypeSymbol?)
            }
            if !(declared != nil && declared.IsReferenceType == true) {
                symbol = nil
                return false
            }
            let emittedNullable = declared.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated ||
                this.ShouldPromoteToNullableReference(symbol)
            if !emittedNullable {
                symbol = nil
                return false
            }
            return true
        }

        // Walks outward from the statement containing <paramref name="use"/> to
        // the enclosing accessor/method boundary, looking for a preceding
        // statement (in the same block or an enclosing one, e.g. a `lock` body)
        // that lazily initializes <paramref name="symbol"/> to a non-null value.
        // Because a lazy-init guard leaves `symbol` non-null on BOTH the taken
        // and skipped paths, every later use it dominates is non-null.
        private func IsDominatedByLazyInitGuard(
            use Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            symbol ISymbol?
        ) bool {
            let useStatement Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .StatementSyntax? = use!!.FirstAncestorOrSelf[Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax]()
            if useStatement == nil {
                return false
            }
            for var node Microsoft.CodeAnalysis.SyntaxNode? = useStatement; node != nil; node = node!!.Parent {
                if node.Parent is BlockSyntax block {
                    for statement in block.Statements {
                        if statement == node {
                            break
                        }
                        if this.IsLazyInitGuardStatement(statement, symbol) {
                            return true
                        }
                    }
                }
                // Stop at the enclosing accessor / method / local-function body:
                // dominance across a member boundary is not analyzed here.
                if node is AccessorDeclarationSyntax ||
                    node is BaseMethodDeclarationSyntax ||
                    node is LocalFunctionStatementSyntax ||
                    node is AnonymousFunctionExpressionSyntax ||
                    node is ArrowExpressionClauseSyntax {
                    break
                }
            }
            return false
        }

        // True when <paramref name="statement"/> is one of the lazy-init guard
        // shapes that leaves <paramref name="symbol"/> non-null afterwards:
        //   • `if (F == null) { F = expr; }` / `if (F is null) { F = expr; }`
        //   • `F ??= expr;`
        // (`expr` must not itself be a `null` literal). Lock-wrapped variants are
        // covered because the enclosing walk descends into the `lock` body block.
        private func IsLazyInitGuardStatement(
            statement Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax,
            symbol ISymbol?
        ) bool {
            switch statement {
                case ifStatement is Microsoft.CodeAnalysis.CSharp.Syntax.IfStatementSyntax when this.IsNullCheckOf(
                    ifStatement.Condition,
                    symbol
                ) {
                    return this.AssignsSymbolNonNull(ifStatement.Statement, symbol)
                }
                case Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ExpressionStatementSyntax{
                    Expression: Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax coalesce
                } when coalesce.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.CoalesceAssignmentExpression) &&
                    this.BindsTo(coalesce.Left, symbol) && !IsNullOrSuppressedNull(coalesce.Right) {
                    return true
                }
                default {
                    return false
                }
            }
        }

        // `F == null` / `null == F` / `F is null` (the null-path condition of a
        // lazy-init guard), where `F` binds to <paramref name="symbol"/>.
        private func IsNullCheckOf(
            condition Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            symbol ISymbol?
        ) bool {
            var condition = condition
            condition = StripParentheses(condition)
            switch condition {
                case binary is Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax when binary.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.EqualsExpression
                ) {
                    return (IsNullLiteral(binary.Right) && this.BindsToGuardSymbol(binary.Left, symbol)) ||
                        (IsNullLiteral(binary.Left) && this.BindsToGuardSymbol(binary.Right, symbol))
                }
                case isPattern is IsPatternExpressionSyntax when this.BindsToGuardSymbol(isPattern.Expression, symbol) {
                    return IsNullConstantPattern(isPattern.Pattern) && !(isPattern.Pattern is UnaryPatternSyntax)
                }
                default {
                    return false
                }
            }
        }

        // `F != null` / `null != F` / `F is not null` — the negation of
        // <see cref="IsNullCheckOf"/>, where `F` binds to <paramref name="symbol"/>.
        private func IsNonNullCheckOf(
            condition Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            symbol ISymbol?
        ) bool {
            var condition = condition
            condition = StripParentheses(condition)
            switch condition {
                case binary is Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax when binary.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.NotEqualsExpression
                ) {
                    return (IsNullLiteral(binary.Right) && this.BindsToGuardSymbol(binary.Left, symbol)) ||
                        (IsNullLiteral(binary.Left) && this.BindsToGuardSymbol(binary.Right, symbol))
                }
                case isPattern is IsPatternExpressionSyntax when this.BindsToGuardSymbol(isPattern.Expression, symbol) {
                    return IsNullConstantPattern(isPattern.Pattern) && isPattern.Pattern is UnaryPatternSyntax
                }
                default {
                    return false
                }
            }
        }

        private func BindsToGuardSymbol(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            symbol ISymbol?
        ) bool {
            var expression = expression
            if this.BindsTo(expression, symbol) {
                return true
            }
            expression = StripParentheses(expression)
            if !((symbol is ILocalSymbol || symbol is IParameterSymbol)) ||
                expression is not IdentifierNameSyntax identifier ||
                identifier
                .Identifier
                .ValueText != symbol!!.Name {
                return false
            }
            let bound ISymbol? = this.context.GetSymbolInfo(identifier).Symbol
            if bound != nil {
                return HasSameSourceDeclaration(bound, symbol)
            }
            let visible ISymbol? = this
                .context
                .SemanticModel
                .LookupSymbols(identifier.SpanStart, name: symbol!!.Name)
                .FirstOrDefault()
            return visible == nil || HasSameSourceDeclaration(visible, symbol)
        }

        // Issue #2202: true when <paramref name="use"/> reads a nullable
        // (`T?`) field/property from within the branch of an enclosing
        // `if (F == null) {…} else { …F… }` / `if (F != null) { …F… }` statement
        // or `F == null ? … : …F…` / `F != null ? …F… : …` conditional expression
        // whose condition directly null-checks that same field/property — so
        // `F` is provably non-null on that branch, and gsc (by design,
        // Kotlin-style) never smart-casts fields/properties across the guard.
        // The migrated corpus is nullable-oblivious, so Roslyn's own flow state
        // is empty and the flow-based check below never proves this; the guard
        // is instead detected from SYNTAX, mirroring
        // <see cref="IsLazyInitGuardedFieldUse"/>.
        private func IsNullGuardNarrowedFieldUse(use Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?) bool {
            if !this.TryGetEmittedNullableFieldOrProperty(use, out var symbol) {
                return false
            }
            return this.IsDominatedByNullCheckGuard(use, symbol)
        }

        // Issue #2202 / #2434: true when a null-check guard for <paramref
        // name="symbol"/> dominates <paramref name="use"/> — walking outward
        // from the use to find an enclosing `if (F == null) {…} else { …F… }` /
        // `if (F != null) { …F… }` statement, or `F == null ? … : …F…` /
        // `F != null ? …F… : …` conditional expression, whose condition
        // directly null-checks that same symbol. Originally scoped to the
        // field/property caller (<see cref="IsNullGuardNarrowedFieldUse"/>),
        // this walk is symbol-kind-agnostic and is reused as-is by the
        // argument-forwarding rule (#2434,
        // <see cref="IsUnguardedForwardOfTaintedValueAsArgument"/>), which
        // needs the identical textual-guard detection for a LOCAL/PARAMETER —
        // a guarded local is narrowed by gsc's own Kotlin-style smart-cast
        // exactly as a guarded field is narrowed here, syntactically, so a
        // single shared walk serves both callers.
        private func IsDominatedByNullCheckGuard(
            use Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            symbol ISymbol?
        ) bool {
            for var node Microsoft.CodeAnalysis.SyntaxNode? = use; node != nil; node = node!!.Parent {
                switch node.Parent {
                    case elseClause is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ElseClauseSyntax when elseClause.Parent is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .IfStatementSyntax ifStatement &&
                        node == elseClause.Statement &&
                        this.IsNullCheckOf(ifStatement.Condition, symbol) {
                        return true
                    }
                    case ifStatement is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .IfStatementSyntax when node == ifStatement.Statement &&
                        this.IsNonNullCheckOf(ifStatement.Condition, symbol) {
                        return true
                    }
                    case ternary is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ConditionalExpressionSyntax when node == ternary.WhenFalse &&
                        this.IsNullCheckOf(ternary.Condition, symbol) {
                        return true
                    }
                    case ternary is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ConditionalExpressionSyntax when node == ternary.WhenTrue &&
                        this.IsNonNullCheckOf(ternary.Condition, symbol) {
                        return true
                    }
                }
                // Stop at the enclosing accessor / method / local-function /
                // lambda / arrow-body boundary: a guard cannot narrow a use
                // across a member boundary.
                if node is AccessorDeclarationSyntax ||
                    node is BaseMethodDeclarationSyntax ||
                    node is LocalFunctionStatementSyntax ||
                    node is AnonymousFunctionExpressionSyntax ||
                    node is ArrowExpressionClauseSyntax {
                    break
                }
            }
            return false
        }

        /// Issue #2202 / #2412 (round 3): true when [`use`](paramref) reads
        /// a nullable-tainted field/property as an arm of a conditional/switch
        /// expression whose enclosing property/method return type was
        /// deliberately preserved non-null (the oblivious-analyzer's
        /// property-contract / forwarding-exclusion guardrail, issues #1354 /
        /// #2167).
        /// @remarks Scoping constraints that prevent this from becoming a blanket forgiveness:
        /// - Oblivious compilation only (nullable-enabled projects untouched).
        /// - [`use`](paramref) must be a field/property emitted `T?`.
        /// - The conditional must be the (possibly parenthesized / return-wrapped) entire body of the enclosing
        /// property/method.
        /// - The enclosing property/method's return type must NOT be promoted to nullable — only the deliberate
        /// "return kept non-null" pattern qualifies.
        /// This deliberately does NOT require a sibling arm to already be
        /// null-guard-narrowed (the original #2202 scoping): a conditional's
        /// governing condition need not correlate with either arm's nullness at
        /// all (e.g. `Profile.PreAmazon ? HttpClientAudible : HttpClientAmazon`
        /// — a plain flag check, not a null-check on either arm — the real
        /// Oahu.Core `AudibleApi.HttpClient` shape). Every tainted arm of a
        /// conditional whose enclosing member's return type the guardrail
        /// refused to widen needs the same bridging assertion the guardrail's
        /// own design already anticipates (per (cref:IsUnguardedForwardOfTaintedValueInReturnPreservingBody)'s
        /// unconditional counterpart) — restricting to only the "one sibling
        /// already guarded" subset left every OTHER unguarded shape unfixed
        /// without narrowing the class of members this rule can affect (that
        /// scope is controlled entirely by (cref:IsBodyOfReturnPreservingMember)
        /// below, not by sibling-guard status).
        private func IsNullableTaintedArmOfReturnPreservingConditional(
            use Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            if !this.IsObliviousCompilation() {
                return false
            }
            if !this.TryGetEmittedNullableFieldOrProperty(use, out _) {
                return false
            }
            // Walk upward (stripping parentheses) to find the enclosing
            // ConditionalExpressionSyntax or SwitchExpressionSyntax whose arm
            // this use belongs to, and confirm that the use IS an arm (not the
            // condition / governing expression).
            let (conditional, _) = this.FindEnclosingConditionalAndSiblings(use)
            if conditional == nil {
                return false
            }
            // The conditional must be the (possibly parenthesized / return-wrapped)
            // entire body of an enclosing property or method, and that member's
            // return type must NOT be promoted to nullable by the oblivious
            // analyzer (i.e., it was deliberately kept non-null).
            return this.IsBodyOfReturnPreservingMember(conditional)
        }

        /// Issue #4211: true when [`use`](paramref) is a promoted-nullable
        /// value read as an ARM of a conditional/switch expression whose result
        /// is assigned into an element-access target that genuinely requires a
        /// non-null reference ((cref:ElementAccessAssignmentRequiresNonNullReference)).
        /// @remarks This is the arm-level completion of issue #2259's element-access sink
        /// rule. That rule asks `IsNullablePromotedValue` about the WHOLE
        /// right-hand side; for a ternary that question is answered by
        /// `IsNullableInitializer`, which recurses into the arms but only
        /// ever reads their DECLARED annotation — the taint fixpoint's promotion
        /// is invisible to it. So the exact corpus shape
        /// `slots[ordinal] = permutes ? this.SpillOperand(value, …) : value`
        /// (cs2gs's own `TranslateClaimedLocalFunctionArgumentsWithDefaults`,
        /// where `value` is a local the fixpoint promoted to
        /// `GExpression?`) emitted a bare `T?` arm into a `T`
        /// element slot and failed to compile with GS0155.
        ///
        /// Scoping, mirroring
        /// (cref:IsNullableTaintedArmOfReturnPreservingConditional):
        /// oblivious compilations only; the use must really be an ARM (the walk
        /// requires at least one conditional/switch level, so a DIRECT RHS keeps
        /// flowing through #2259's whole-RHS rule and stays byte-identical); the
        /// sink must be an element access the taint fixpoint structurally cannot
        /// widen (unlike a local/field/property/parameter target, which it widens
        /// at the target's own declaration); and a local/parameter narrowed by a
        /// dominating null-check guard is skipped because gsc's own Kotlin-style
        /// smart-cast — including the conditional's own condition when it guards
        /// that arm — has already made the read non-null.
        private func IsNullableTaintedArmOfElementAccessAssignment(
            use Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            if !this.IsObliviousCompilation() ||
                !TryGetElementAccessAssignmentThroughConditionalArms(use, out var assignment) ||
                !this.ElementAccessAssignmentRequiresNonNullReference(assignment) {
                return false
            }
            let symbol ISymbol? = this.context.GetSymbolInfo(use).Symbol
            if (symbol is ILocalSymbol || symbol is IParameterSymbol) && this.IsDominatedByNullCheckGuard(use, symbol) {
                return false
            }
            return this.IsNullablePromotedValue(use)
        }

        // Issue #2432: true when <paramref name="use"/> is a same-project
        // field/property/local/parameter/method read that is ALREADY emitted
        // `T?` (declared nullable, or promoted by the whole-program oblivious
        // taint fixpoint — the same symbol-kind set `IsNullablePromotedValue`
        // inspects) AND is, itself, the ENTIRE (possibly parenthesized) body of
        // a property/method whose own declared type the analyzer deliberately
        // left non-null (<see cref="IsBodyOfReturnPreservingMember"/>, shared
        // unchanged with <see cref="IsNullableTaintedArmOfReturnPreservingConditional"/>).
        // This is the UNCONDITIONAL counterpart of that conditional-arm rule:
        // there is no ternary/switch here at all, so no arm can be evaluated —
        // the sole evidence is the guardrail relationship
        // itself (a promoted-nullable value flowing, unconditionally, into a
        // declaration the SAME analyzer refused to widen). That refusal is
        // deliberate for a contract member (explicit/implicit interface
        // implementation or override, which must keep the interface/base's own
        // declared nullability) and for an ordinary property that merely
        // forwards ANOTHER property (excluded from `SourceScope` transitivity to
        // preserve the #1354 golden forwarding behavior) — both leave the
        // bridging `!!` to this pass, exactly as their design comments call for.
        private func IsUnguardedForwardOfTaintedValueInReturnPreservingBody(
            use Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            if !this.IsObliviousCompilation() {
                return false
            }
            let symbol ISymbol? = this.context.GetSymbolInfo(use).Symbol
            if !(
                (
                    symbol is IFieldSymbol ||
                        symbol is IPropertySymbol ||
                        symbol is ILocalSymbol ||
                        symbol is IParameterSymbol ||
                        symbol is IMethodSymbol
                )
            ) {
                return false
            }
            // Reuses the exact same "is this emitted `T?`" test the rest of the
            // translator relies on (declared-annotated OR taint-promoted), so a
            // symbol whose nullability this pass would forgive here is always
            // consistent with what every other promotion/forgiveness call site
            // already treats as nullable.
            if !this.IsNullablePromotedValue(use) {
                return false
            }
            return this.IsBodyOfReturnPreservingMember(use)
        }

        // Issue #2434: true when <paramref name="use"/> is a same-project
        // field/property/local/parameter/method read that is ALREADY emitted
        // `T?` (declared nullable, or promoted by the whole-program oblivious
        // taint fixpoint — the same <see cref="IsNullablePromotedValue"/> test
        // as the #2432 return-forwarding rule) AND is passed, UNGUARDED (no
        // dominating null-check guard for the same symbol —
        // <see cref="IsDominatedByNullCheckGuard"/>), as the (possibly
        // parenthesized) ENTIRE expression of a call-site argument whose bound
        // parameter is a genuine non-null reference type that cs2gs itself will
        // NOT also promote to nullable (<see cref="ShouldPromoteToNullableReference"/>).
        //
        // The canonical shape is the Oahu.Core BookLibrary case: a same-project
        // concrete `Conversion` local promoted to `Conversion?` by unrelated
        // constructor-parameter taint, forwarded as the sole argument of a
        // CONDITIONAL delegate invocation (`callback?(tmp)`) whose delegate
        // parameter type is the concrete class's own interface `IConversion` —
        // a fixed, external (`System.Action<T>`-shaped) function-type
        // parameter that can NEVER itself be promoted to nullable the way an
        // ordinary same-project method parameter can (contrast a plain
        // `Run(IConversion c)` call, whose OWN parameter the taint fixpoint
        // promotes to `IConversion?` in lockstep with the argument,
        // sidestepping the gap entirely). The same gap reaches a DIRECT
        // (non-conditional) delegate invocation, a lambda-typed local, and any
        // ordinary same-project call whose parameter the fixpoint happens not
        // to promote — this rule is scoped to the ARGUMENT SHAPE, not to
        // delegates specifically, so a single rule (reusing gsc's existing
        // explicit-nullable-unwrap-then-implicit-reference-widen composition
        // in `Conversion.Classify`, which already accepts `tmp!!` here) covers
        // every call form uniformly, matching #2432's "search existing
        // conversion helpers, don't special-case" guidance. Unlike
        // <see cref="IsUnguardedForwardOfTaintedValueInReturnPreservingBody"/>,
        // a GUARDED local at this same call site needs no help at all: gsc's
        // own Kotlin-style smart-cast already narrows a syntactically-guarded
        // local read, so <see cref="IsDominatedByNullCheckGuard"/> must find NO
        // guard for this rule to apply, keeping the forgiveness reserved for
        // the truly unconditional forward the original (oblivious) C# accepted
        // implicitly.
        private func IsUnguardedForwardOfTaintedValueAsArgument(
            use Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            if !this.IsObliviousCompilation() {
                return false
            }
            let symbol ISymbol? = this.context.GetSymbolInfo(use).Symbol
            if !(
                (
                    symbol is IFieldSymbol ||
                        symbol is IPropertySymbol ||
                        symbol is ILocalSymbol ||
                        symbol is IParameterSymbol ||
                        symbol is IMethodSymbol
                )
            ) {
                return false
            }
            if !this.IsNullablePromotedValue(use) {
                return false
            }
            // Walk up through parentheses to the immediate syntactic parent:
            // this rule covers only a DIRECT (unwrapped) forward — a
            // ternary/switch arm or any other composed expression never
            // resolves to an ArgumentSyntax parent here and is intentionally
            // left to the return-preserving-body rule (or unhandled) instead.
            var node Microsoft.CodeAnalysis.SyntaxNode? = use
            while node!!.Parent is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax {
                node = node!!.Parent
            }
            if node!!.Parent is not ArgumentSyntax argumentSyntax {
                return false
            }
            // A dominating guard means gsc's own smart-cast (locals) or the
            // sibling field/property rule (already checked earlier in
            // ReceiverNeedsNullForgiveness) already makes this use safe
            // without any help from this rule.
            if this.IsDominatedByNullCheckGuard(use, symbol) {
                return false
            }
            if this
                .context
                .SemanticModel
                .GetOperation(argumentSyntax) is not IArgumentOperation argumentOperation ||
                argumentOperation.Parameter is not{} parameter {
                return false
            }
            // If cs2gs will ALSO promote the bound parameter to nullable (the
            // ordinary same-project method case above), the argument already
            // widens `T? -> T?` with no `!!` required — forcing one here would
            // be superfluous, not incorrect. This ONLY applies when the
            // parameter is itself declared by SOURCE inside THIS compilation:
            // cs2gs can only ever change the rendered signature of a symbol it
            // is translating from source — an EXTERNAL/BCL parameter (e.g. the
            // synthesized `Invoke` of `System.Action<T>`/`System.Func<T,...>`)
            // is never re-emitted, so its declared type can never actually be
            // promoted, no matter what `ShouldPromoteToNullableReference`
            // reports for it. That check alone is NOT a reliable signal here:
            // `Canonical()` maps a CONSTRUCTED generic Invoke parameter (e.g.
            // `Action<IConversion>.Invoke(IConversion)`) back to the single
            // SHARED unbound-generic definition `Action<T>.Invoke(T)` — the
            // very same canonical key the whole-program fixpoint uses to
            // record evidence for the delegate-parameter-promotion feature
            // (`PromoteDelegateParameterInvokedWithNull`) — so the CURRENT
            // invocation being translated (a tainted argument passed to THIS
            // delegate call) is itself sufficient evidence to mark that
            // canonical key tainted, self-referentially, for EVERY `Action<T>`/
            // `Func<T,...>` call site in the whole compilation. Requiring
            // source-declared-in-this-compilation excludes that external
            // symbol category entirely and leaves the same-project method
            // case (whose parameter genuinely has a declaring syntax node
            // here) unaffected.
            return this.ParameterWillRemainNonNullableReference(parameter)
        }

        private func IsUnguardedForwardOfTaintedValueAsRuntimeLambdaResult(
            use Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            // Issue #3644: only a SYNTACTICALLY nullable result shape (`a?.b`,
            // `a ?? nullableFallback`, `cond ? a : b` with a nullable arm) keeps
            // its nullable lambda result unasserted — those forms introduce
            // nullability the C# author wrote deliberately. A value whose
            // nullability comes solely from the DECLARED `T?` annotation of the
            // bound member (e.g. the annotated-BCL `Path.GetDirectoryName(...)`)
            // was compiled by oblivious C# under the target delegate's NON-NULL
            // return contract (`Func<string, string>`), so it must be bridged
            // with `!!` like every other tainted forward — otherwise gsc infers
            // the lambda result `T?` and the divergence cascades into every
            // downstream sink (`Select(...)` element flows, `foreach` variables,
            // non-null arguments: the migrated Cs2Gs.Pipeline
            // `PrepareTemporaryBuildProps` GS0154 walls).
            if IsNullOrSuppressedNull(use) || this.IsSyntacticallyNullableResultShape(use) ||
                !this.IsObliviousCompilation() || this.IsWithinExpressionTreeLambda(use) ||
                this.LambdaResultFeedsNullableObservedInvocation(use) || this.FindResultLambda(use) is not{} lambda ||
                this.LambdaResultFlowsToNullableSink(lambda) || this.LambdaResultFeedsUnobservedTaskRun(use) ||
                !(this.GetLambdaTargetDelegateType(lambda) is {DelegateInvokeMethod: {} invoke}) ||
                GetEffectiveReturnType(
                invoke.ReturnType,
                lambda.AsyncKeyword.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.AsyncKeyword)
            ) is not{IsReferenceType: true} returnType ||
                returnType.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
                return false
            }
            let returnDeclaredInThisCompilation = invoke.DeclaringSyntaxReferences.Any(
                (reference SyntaxReference) -> this.context.Compilation.ContainsSyntaxTree(reference.SyntaxTree)
            )
            if returnDeclaredInThisCompilation && this.ShouldPromoteToNullableReference(invoke) {
                return false
            }
            // ADR-0186 step 6 (PR 0): an oblivious-metadata result is `T!`,
            // which gsc checks at the lambda's non-null return itself, unless
            // the lambda's own type is inferred from it.
            return this.IsNullablePromotedValue(use) ||
                (
                this.IsImportedObliviousNullableMember(this.context.GetSymbolInfo(use).Symbol) &&
                    !this.PlatformTypedImportNeedsNoBridge(use)
            )
        }

        // Issue #4179: `Task.Run<TResult>(Func<TResult> function)` (and its
        // `Task.Factory.StartNew` sibling) infers TResult purely to carry the
        // delegate's completion value back to whoever later reads `.Result` /
        // awaits it. When nothing in scope ever does — the "run this on the
        // thread pool, synchronize only via Wait()" idiom the self-hosting
        // emit-test harnesses use to drive a freshly compiled assembly's entry
        // point through `MethodInfo.Invoke` — TResult's nullability was never
        // load-bearing for the original C#, which happily produced e.g.
        // `Task<object?>` with nobody the wiser: a void-returning `Invoke`
        // legitimately returns null every time. Forcing `!!` at the lambda's
        // own result seam here throws the instant the delegate returns null, a
        // risk the un-migrated program never took. This is narrower than (and
        // does not touch) #3644/#4046's LINQ-selector reasoning: a `Select`/
        // `Where` result IS observed by its downstream enumeration, so that
        // family keeps asserting — only the two BCL entry points whose entire
        // contract is "run this", not "project this", are exempted here.
        private func LambdaResultFeedsUnobservedTaskRun(
            use Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            if this.FindResultLambda(use) is not{} lambda {
                return false
            }
            var node Microsoft.CodeAnalysis.SyntaxNode? = lambda
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
            return node!!.Parent is ArgumentSyntax argument &&
                argument
                .Parent
                ?.Parent is InvocationExpressionSyntax invocation &&
                this
                .context
                .GetSymbolInfo(invocation)
                .Symbol is IMethodSymbol method &&
                IsTaskRunEntryPoint(method) &&
                !this.TaskInvocationResultIsEverUnwrapped(invocation)
        }

        // True when the `Task<TResult>`/`ValueTask<TResult>` produced by
        // <paramref name="invocation"/> is ever unwrapped — a direct fluent
        // `.Result`/`.GetAwaiter()` off the call, an `await` of it, or (once
        // bound to a local via <see cref="ResolveValueSink"/>) the same off
        // that local anywhere in its declaring block. A sink this translator
        // cannot trace (fire-and-forget as a bare statement, forwarded as an
        // argument, etc.) is treated conservatively as unwrapped, so the
        // exemption only ever fires for the narrow, syntactically provable
        // "declared, then only Wait()/observed for completion" shape.
        private func TaskInvocationResultIsEverUnwrapped(invocation InvocationExpressionSyntax) bool {
            var value Microsoft.CodeAnalysis.SyntaxNode? = invocation
            while (
                value!!.Parent is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ParenthesizedExpressionSyntax or
                    CastExpressionSyntax
            ) {
                value = value!!.Parent
            }
            if value!!.Parent is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .AwaitExpressionSyntax ||
                (
                value!!.Parent is MemberAccessExpressionSyntax fluentAccess &&
                    fluentAccess.Expression == value &&
                    IsTaskResultUnwrapMember(fluentAccess.Name.Identifier.Text)
            ) {
                return true
            }
            if this.ResolveValueSink(invocation) is not ILocalSymbol local {
                return true
            }
            let scope_ Microsoft.CodeAnalysis.SyntaxNode? = this.GetNullabilityScope(local)
            if scope_ == nil {
                return true
            }
            return scope_
                .DescendantNodes()
                .OfType[MemberAccessExpressionSyntax]()
                .Any(
                (member MemberAccessExpressionSyntax) -> this.BindsTo(member.Expression, local) &&
                    IsTaskResultUnwrapMember(member.Name.Identifier.Text)
            ) ||
                scope_
                .DescendantNodes()
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.AwaitExpressionSyntax]()
                .Any(
                (awaitExpression Microsoft.CodeAnalysis.CSharp.Syntax.AwaitExpressionSyntax) -> this.BindsTo(
                    awaitExpression.Expression,
                    local
                )
            )
        }

        private func LambdaResultFlowsToNullableSink(lambda AnonymousFunctionExpressionSyntax) bool {
            // Issue #4046: a generic selector has no fixed return contract of
            // its own. When its fluent call chain collapses back to the same
            // scalar type and that final sink is emitted nullable, preserve nil
            // for operators such as FirstOrDefault to inspect instead of
            // throwing at the selector boundary.
            var current Microsoft.CodeAnalysis.SyntaxNode? = lambda
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
            if current!!.Parent is not ArgumentSyntax argument ||
                argument.Expression != current ||
                argument
                .Parent
                ?.Parent is not InvocationExpressionSyntax invocation ||
                !this.IsGenericSelectorResultArgument(argument, lambda) {
                return false
            }
            current = invocation
            while true {
                if (
                    current!!.Parent is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ParenthesizedExpressionSyntax or
                        CastExpressionSyntax
                ) {
                    current = current!!.Parent
                    continue
                }
                if current!!.Parent is MemberAccessExpressionSyntax member &&
                    member.Expression == current &&
                    member.Parent is InvocationExpressionSyntax outerInvocation {
                    current = outerInvocation
                    continue
                }
                if current!!.Parent is ArgumentSyntax materializerArgument &&
                    materializerArgument.Expression == current &&
                    materializerArgument
                    .Parent
                    ?.Parent is InvocationExpressionSyntax staticMaterializer &&
                    this.IsEnumerableToArray(staticMaterializer) {
                    current = staticMaterializer
                    continue
                }
                break
            }
            if current is not Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax expression {
                return false
            }
            let sink ISymbol? = this.ResolveValueSink(expression)
            let sinkType ITypeSymbol? = switch sink {
                case method is IMethodSymbol: method.ReturnType
                case property is IPropertySymbol: property.Type
                case field is IFieldSymbol: field.Type
                case local is ILocalSymbol: local.Type
                case parameter is IParameterSymbol: parameter.Type
                default: default(ITypeSymbol?)
            }
            let resultType ITypeSymbol? = (this.context.GetSymbolInfo(lambda).Symbol as IMethodSymbol)?.ReturnType
            if !(sinkType != nil && sinkType.IsReferenceType == true) {
                return false
            }
            if SymbolEqualityComparer.Default.Equals(resultType, sinkType) {
                // The #4046 shape: the chain collapses back to the SAME scalar
                // type as the selector's own result (`.Select(...).FirstOrDefault()`).
                return !this.TargetWillRemainNonNullableReference(sinkType, sink)
            }
            if sink is IMethodSymbol sinkMethod &&
                sinkType is IArrayTypeSymbol &&
                this.ArrayReturnElementAcceptsNullableSelectorResult(sinkMethod) {
                return true
            }
            // Issue #4180: `current` never left the Select-shaped invocation itself
            // (e.g. `string.Join(sep, xs.Select(i => i.FullName))` — the selector's
            // result is passed WHOLE as a collection argument rather than chained
            // into a further scalar-returning call), so `sinkType` is the SINK
            // PARAMETER'S OWN type (`IEnumerable<TResult?>`), not `resultType`
            // itself; the equality check above can never match a collection type
            // against a scalar one. Unwrap one generic type argument and compare
            // ELEMENT-to-element instead — an already-nullable-ANNOTATED element
            // (e.g. `string.Join`'s BCL-declared `IEnumerable<string?>`) accepts a
            // nullable selector result with no bridge; asserting `!!` here throws
            // whenever the selector legitimately returns null (`Type.FullName` on a
            // reified open-generic interface row, #4180's reported crash), even
            // though the ORIGINAL C# `string.Join`/`.Select` pipeline tolerates
            // null elements silently.
            if sinkType is not INamedTypeSymbol{IsGenericType: true, TypeArguments: {Length: 1}} sinkCollection ||
                sinkCollection.TypeArguments[0] is not{} sinkElement ||
                sinkElement.NullableAnnotation != Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated ||
                resultType == nil {
                return false
            }
            // Element compatibility is an ASSIGNABILITY check, not identity: the
            // sink accepts the selector's result through an implicit reference
            // conversion (including IEnumerable<T> covariance), e.g.
            // `Consume(IEnumerable<object?> values)` called with
            // `types.Select(t => t.FullName)` -- `string` is not symbol-equal
            // to `object`, but every `string` IS an `object`. Exact identity
            // missed this: the selector result stayed `!!`-asserted and threw
            // on a null `FullName` even though the sink tolerates it.
            let sinkElementType = sinkElement.WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.None)
            let elementConversion = this.context.Compilation.ClassifyConversion(resultType, sinkElementType)
            return elementConversion.IsImplicit && (elementConversion.IsReference || elementConversion.IsIdentity)
        }

        private func ArrayReturnElementAcceptsNullableSelectorResult(method IMethodSymbol?) bool {
            if method?.ReturnType is not IArrayTypeSymbol returnArray ||
                returnArray.ElementType is not{IsReferenceType: true} element ||
                element.NullableAnnotation != Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .None ||
                ObliviousNullabilityAnalyzer.IsReturnSignatureFixedByAnotherDeclaration(method) {
                return false
            }
            for returned in this.GetSourceCallableReturnExpressions(method) {
                for lambda in returned!!.DescendantNodesAndSelf().OfType[AnonymousFunctionExpressionSyntax]() {
                    var current Microsoft.CodeAnalysis.SyntaxNode? = lambda
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
                    if current!!.Parent is not ArgumentSyntax argument ||
                        argument.Expression != current ||
                        !this.IsGenericSelectorResultArgument(argument, lambda) ||
                        !this.TryGetDirectArrayMaterializerElementType(
                        argument,
                        returned!!,
                        out var materializedElement
                    ) ||
                        !GetLambdaResultExpressions(lambda).Any(this.NullableSelectorResultMayBeNull) {
                        continue
                    }
                    let resultType ITypeSymbol? = (
                        this.context.GetSymbolInfo(lambda).Symbol as IMethodSymbol
                    )?.ReturnType ??
                        this
                        .GetLambdaTargetDelegateType(lambda)
                        ?.DelegateInvokeMethod
                        ?.ReturnType
                    let conversion = this
                        .context
                        .Compilation
                        .ClassifyConversion(
                        resultType!!,
                        element.WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.None)
                    )
                    let materializedConversion = this
                        .context
                        .Compilation
                        .ClassifyConversion(
                        resultType!!,
                        materializedElement!!.WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.None)
                    )
                    if materializedConversion.IsImplicit &&
                        (materializedConversion.IsReference || materializedConversion.IsIdentity) &&
                        conversion.IsImplicit &&
                        (conversion.IsReference || conversion.IsIdentity) {
                        return true
                    }
                }
            }
            return false
        }

        private func NullableSelectorResultMayBeNull(
            result Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) bool -> switch result {
            case parenthesized is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ParenthesizedExpressionSyntax: this.NullableSelectorResultMayBeNull(parenthesized.Expression)
            case cast is CastExpressionSyntax: this.NullableSelectorResultMayBeNull(cast.Expression)
            case conditional is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ConditionalExpressionSyntax: this.NullableSelectorResultMayBeNull(conditional.WhenTrue) ||
                this.NullableSelectorResultMayBeNull(conditional.WhenFalse)
            case switchExpression is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .SwitchExpressionSyntax: switchExpression
                .Arms
                .Any(
                (
                    arm Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionArmSyntax
                ) -> this.NullableSelectorResultMayBeNull(arm.Expression)
            )
            default: this.NullableReferenceValueMayBeNull(result, respectDeclaredAnnotations: true)
        }

        private func TryGetDirectArrayMaterializerElementType(
            selectorArgument ArgumentSyntax,
            returned Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            out elementType ITypeSymbol?
        ) bool {
            elementType = nil
            var current Microsoft.CodeAnalysis.SyntaxNode? = selectorArgument.Parent?.Parent
            while (
                current?.Parent is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ParenthesizedExpressionSyntax or
                    CastExpressionSyntax
            ) {
                current = current!!.Parent
            }
            let materializer InvocationExpressionSyntax? = switch current?.Parent {
                case member is MemberAccessExpressionSyntax when member.Expression == current &&
                    member.Parent is InvocationExpressionSyntax invocation: invocation
                case argument is ArgumentSyntax when argument.Expression == current &&
                    argument
                    .Parent
                    ?.Parent is InvocationExpressionSyntax invocation: invocation
                default: default(InvocationExpressionSyntax?)
            }
            if materializer == nil || !this.IsEnumerableToArray(materializer) {
                return false
            }
            elementType = if (
                this.context.GetSymbolInfo(materializer).Symbol as IMethodSymbol
            )?.ReturnType is IArrayTypeSymbol array {
                array.ElementType
            } else {
                default(ITypeSymbol?)
            }
            if elementType == nil {
                return false
            }
            current = materializer
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
            return current == returned
        }

        private func IsEnumerableToArray(invocation InvocationExpressionSyntax?) bool {
            if this.context.GetSymbolInfo(invocation).Symbol is not IMethodSymbol method || method.Name != "ToArray" {
                return false
            }
            let originalMethod = method.ReducedFrom ?? method
            return SymbolEqualityComparer.Default.Equals(
                originalMethod.ContainingType?.OriginalDefinition,
                this.context.Compilation.GetTypeByMetadataName("System.Linq.Enumerable")
            )
        }

        private func IsGenericSelectorResultArgument(
            argument ArgumentSyntax,
            lambda AnonymousFunctionExpressionSyntax
        ) bool {
            var parameter IParameterSymbol? = (
                this.context.SemanticModel.GetOperation(argument) as IArgumentOperation
            )?.Parameter
            if parameter == nil &&
                argument
                .Parent
                ?.Parent is InvocationExpressionSyntax invocation &&
                this
                .context
                .SemanticModel
                .GetOperation(invocation) is IInvocationOperation operation {
                // Roslyn may attach the operation to the operand inside parentheses.
                parameter = operation
                    .Arguments
                    .FirstOrDefault((candidate IArgumentOperation) -> argument.Span.Contains(candidate.Syntax.Span))
                    ?.Parameter
            }
            if parameter == nil && !this.TryGetExpandedParamsElementTarget(
                argument,
                this.GetArgumentParameter(argument),
                out _,
                out parameter
            ) {
                return false
            }
            return parameter?.ContainingSymbol is IMethodSymbol method &&
                ReturnsGenericSelectorResult(
                method.OriginalDefinition,
                parameter!!.Ordinal,
                lambda.AsyncKeyword.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.AsyncKeyword)
            )
        }

        private func FindResultLambda(
            use Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) AnonymousFunctionExpressionSyntax? {
            var node Microsoft.CodeAnalysis.SyntaxNode? = use
            while true {
                if (
                    node!!.Parent is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ParenthesizedExpressionSyntax or
                        CastExpressionSyntax
                ) {
                    node = node!!.Parent
                } else if node!!.Parent is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ConditionalExpressionSyntax conditional &&
                    (conditional.WhenTrue == node || conditional.WhenFalse == node) {
                    node = conditional
                } else if node!!.Parent is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .SwitchExpressionArmSyntax arm &&
                    arm.Expression == node &&
                    arm.Parent is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .SwitchExpressionSyntax switchExpression {
                    node = switchExpression
                } else {
                    break
                }
            }
            if node!!.Parent is AnonymousFunctionExpressionSyntax expressionLambda && expressionLambda.Body == node {
                return expressionLambda
            }
            if node!!.Parent is not Microsoft.CodeAnalysis.CSharp.Syntax.ReturnStatementSyntax returnStatement {
                return nil
            }
            for var ancestor Microsoft
                .CodeAnalysis
                .SyntaxNode? = returnStatement.Parent;
                ancestor != nil;
                ancestor = ancestor!!
                .Parent {
                if ancestor is AnonymousFunctionExpressionSyntax lambda {
                    return lambda
                }
                if ancestor is LocalFunctionStatementSyntax || ancestor is BaseMethodDeclarationSyntax {
                    return nil
                }
            }
            return nil
        }

        /// Issue #4356: whether a `!!` on the member/element-access RECEIVER
        /// [`recv`](paramref) would be unrepresentable because it sits
        /// inside an expression-tree lambda.
        /// @remarks Issue #2496 suppressed every such receiver assertion, because gsc then
        /// rejected any `!!` in an expression tree (GS0473). gsc has since
        /// narrowed that (issue #3349): over a REFERENCE type the assertion is
        /// pure static annotation and `ExpressionTreeLowerer` erases it, and
        /// a receiver-position check over an ADR-0186 platform operand is elided
        /// by `ExpressionTreeRestrictionValidator.ValidateReceiver`. Only an
        /// assertion that strips a nullable VALUE type — a real
        /// `Nullable<T>.Value` conversion — is still rejected, and gsc
        /// treats an unconstrained type parameter the same way, since it may be
        /// instantiated with one. Suppressing the reference case too left
        /// `b.Conversion.AccountId` (a stated-`T?` navigation property
        /// in an EF `Where`) printed with no `!!`, binding only through
        /// gsc's old member-lookup carve-out.
        /// @param recv The receiver expression.
        /// @returns True when the receiver is inside an expression tree and not a reference type.
        private func ExpressionTreeForbidsReceiverAssertion(
            recv Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) bool -> this.IsWithinExpressionTreeLambda(recv) &&
            this
            .context
            .GetTypeInfo(recv)
            .Type is not{IsReferenceType: true} &&
            !this.IsGSharpNullableAnalyzerExpression(recv)

        private func IsWithinExpressionTreeLambda(node Microsoft.CodeAnalysis.SyntaxNode?) bool -> node!!
            .AncestorsAndSelf()
            .OfType[AnonymousFunctionExpressionSyntax]()
            .Any((lambda AnonymousFunctionExpressionSyntax) -> this.IsExpressionTreeLambda(lambda))

        private func IsExpressionTreeLambda(lambda AnonymousFunctionExpressionSyntax) bool -> this
            .context
            .GetTypeInfo(lambda)
            .ConvertedType is INamedTypeSymbol converted &&
            converted.IsGenericType &&
            converted
            .OriginalDefinition
            .MetadataName == "Expression`1" &&
            converted
            .ContainingNamespace
            ?.ToDisplayString() == "System.Linq.Expressions" &&
            converted
            .TypeArguments
            .Length == 1 &&
            converted
            .TypeArguments[0]
            .TypeKind == TypeKind.Delegate

        private func GetLambdaTargetDelegateType(lambda AnonymousFunctionExpressionSyntax) INamedTypeSymbol? {
            if this.context.GetTypeInfo(lambda).ConvertedType is not INamedTypeSymbol converted {
                return nil
            }
            if converted.TypeKind == TypeKind.Delegate {
                return converted
            }
            return if this.IsExpressionTreeLambda(lambda) {
                converted.TypeArguments[0] as INamedTypeSymbol
            } else {
                default(INamedTypeSymbol?)
            }
        }

        // Walks outward from <paramref name="use"/> through parentheses to find
        // the nearest enclosing ConditionalExpressionSyntax or
        // SwitchExpressionSyntax whose arm the use belongs to. Returns the
        // conditional and the sibling arms (all arms EXCEPT the one containing
        // <paramref name="use"/>). Returns (null, null) if not found.
        private func FindEnclosingConditionalAndSiblings(use Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?)(
            Conditional Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
            Siblings[]?Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) {
            for var node Microsoft.CodeAnalysis.SyntaxNode? = use; node != nil; node = node!!.Parent {
                switch node.Parent {
                    case ternary is Microsoft.CodeAnalysis.CSharp.Syntax.ConditionalExpressionSyntax {
                        if node == ternary.WhenTrue || IsDescendantOfArmViaParens(use, ternary.WhenTrue) {
                            return (ternary, []Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax{ternary.WhenFalse})
                        }
                        if node == ternary.WhenFalse || IsDescendantOfArmViaParens(use, ternary.WhenFalse) {
                            return (ternary, []Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax{ternary.WhenTrue})
                        }
                        // The use is in the condition, not an arm.
                        return (nil, nil)
                    }
                    case switchExpr is Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionSyntax {
                        let siblings = List[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax]()
                        var found = false
                        for arm in switchExpr.Arms {
                            if arm.Expression == node || IsDescendantOfArmViaParens(use, arm.Expression) {
                                found = true
                            } else {
                                siblings.Add(arm.Expression)
                            }
                        }
                        return if found {
                            (switchExpr, siblings.ToArray())
                        } else {
                            (nil, nil)
                        }
                    }
                }
                // Stop at member boundary.
                if node is AccessorDeclarationSyntax ||
                    node is BaseMethodDeclarationSyntax ||
                    node is LocalFunctionStatementSyntax ||
                    node is AnonymousFunctionExpressionSyntax ||
                    node is ArrowExpressionClauseSyntax {
                    break
                }
            }
            return (nil, nil)
        }

        // True when <paramref name="conditional"/> is the (possibly parenthesized
        // / return-wrapped) entire body of a property or method whose declared
        // return type was NOT promoted to nullable by the oblivious-nullability
        // analyzer — i.e., the analyzer deliberately preserved it non-null.
        private func IsBodyOfReturnPreservingMember(
            conditional Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
        ) bool {
            // Walk up through parentheses and a single return statement to reach
            // the enclosing arrow-body / accessor / method boundary.
            var node Microsoft.CodeAnalysis.SyntaxNode? = conditional
            while node!!.Parent is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax {
                node = node!!.Parent
            }
            var enclosingMember ISymbol? = nil
            // Case 1: arrow-expression body `=> expr`
            if node!!.Parent is ArrowExpressionClauseSyntax arrow {
                enclosingMember = switch arrow.Parent {
                    case p is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .PropertyDeclarationSyntax: this
                        .context
                        .GetDeclaredSymbol(p)
                    case i is IndexerDeclarationSyntax: this.context.GetDeclaredSymbol(i)
                    case m is MethodDeclarationSyntax: this.context.GetDeclaredSymbol(m)
                    case acc is AccessorDeclarationSyntax when acc
                        .Parent
                        ?.Parent is BasePropertyDeclarationSyntax bp: this
                        .context
                        .GetDeclaredSymbol(bp)
                    default: default(ISymbol?)
                }
            } else if node!!.Parent is Microsoft.CodeAnalysis.CSharp.Syntax.ReturnStatementSyntax ret {
                // Case 2: `return expr;` inside a block-bodied getter/method —
                // walk up from the return statement to the enclosing member.
                enclosingMember = this.FindEnclosingPropertyOrMethodSymbol(ret)
            }
            if enclosingMember == nil {
                return false
            }
            // The member's return type must be reference-typed and NOT promoted
            // to nullable — confirming the analyzer deliberately kept it non-null.
            let returnType ITypeSymbol? = switch enclosingMember {
                case p is IPropertySymbol: p.Type
                case m is IMethodSymbol: m.ReturnType
                default: default(ITypeSymbol?)
            }
            if !(returnType != nil && returnType.IsReferenceType == true) {
                return false
            }
            if returnType.NullableAnnotation == Microsoft.CodeAnalysis.NullableAnnotation.Annotated {
                return false
            }
            // If the oblivious analyzer DID promote this member to nullable,
            // the return type is already `T?` and forgiving the arm is unnecessary
            // (and would be wrong — the caller expects nullable).
            return !this.ShouldPromoteToNullableReference(enclosingMember)
        }

        // Walks up from a return statement to find the enclosing property (via a
        // `get` accessor) or method symbol. Stops at nested scope boundaries
        // (lambdas, local functions). Returns null if not found.
        private func FindEnclosingPropertyOrMethodSymbol(
            ret Microsoft.CodeAnalysis.CSharp.Syntax.ReturnStatementSyntax
        ) ISymbol? {
            for var walk Microsoft.CodeAnalysis.SyntaxNode? = ret.Parent; walk != nil; walk = walk!!.Parent {
                switch walk {
                    case acc is AccessorDeclarationSyntax when acc.IsKind(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.GetAccessorDeclaration
                    ) &&
                        acc
                        .Parent
                        ?.Parent is BasePropertyDeclarationSyntax bp {
                        return this.context.GetDeclaredSymbol(bp)
                    }
                    case m is MethodDeclarationSyntax {
                        return this.context.GetDeclaredSymbol(m)
                    }
                    case LocalFunctionStatementSyntax, AnonymousFunctionExpressionSyntax {
                        return nil
                    }
                }
            }
            return nil
        }

        // True when <paramref name="body"/> (a lazy-init guard's then-branch)
        // contains an assignment of a non-null value to <paramref name="symbol"/>.
        private func AssignsSymbolNonNull(
            body Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax?,
            symbol ISymbol?
        ) bool {
            if body == nil {
                return false
            }
            for assignment in body.DescendantNodesAndSelf()
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax]() {
                if !assignment.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.SimpleAssignmentExpression) &&
                    !assignment.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.CoalesceAssignmentExpression) {
                    continue
                }
                if this.BindsTo(assignment.Left, symbol) && !IsNullOrSuppressedNull(assignment.Right) {
                    return true
                }
            }
            return false
        }

        shared {
            private func RequiresQualifiedImportedContextualValue(
                member ISymbol,
                identifier IdentifierNameSyntax
            ) bool {
                if !member.DeclaringSyntaxReferences.IsDefaultOrEmpty {
                    return false
                }
                var context = IdentifierNameContext.General
                if identifier.Parent is ElementAccessExpressionSyntax elementAccess &&
                    elementAccess.Expression == identifier {
                    context |= IdentifierNameContext.Index
                }
                if identifier.Parent is InvocationExpressionSyntax invocation && invocation.Expression == identifier {
                    context |= IdentifierNameContext.Invocation
                }
                return GSharp.Core.CodeAnalysis.Syntax.SyntaxFacts.IsReservedIdentifier(member.Name, context)
            }

            private func IsDirectWrite(identifier IdentifierNameSyntax) bool -> switch identifier.Parent {
                case assignment is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .AssignmentExpressionSyntax when assignment.Left == identifier: true
                case prefix is PrefixUnaryExpressionSyntax when prefix.Operand == identifier &&
                    (
                    prefix.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.PreIncrementExpression) || prefix.IsKind(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.PreDecrementExpression
                    )
                ): true
                case postfix is PostfixUnaryExpressionSyntax when postfix.Operand == identifier &&
                    (
                    postfix.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.PostIncrementExpression) || postfix.IsKind(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.PostDecrementExpression
                    )
                ): true
                case argument is ArgumentSyntax when argument.Expression == identifier &&
                    (
                    argument.RefKindKeyword.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.RefKeyword) ||
                        argument
                        .RefKindKeyword
                        .IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.OutKeyword)
                ): true
                default: false
            }

            private func IsBareTypeParameter(type ITypeSymbol?) bool {
                return type is ITypeParameterSymbol &&
                    type.NullableAnnotation != Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated
            }

            private func GetEffectiveTypeArgument(type INamedTypeSymbol, index int32) ITypeSymbol {
                let argument = type.TypeArguments[index]
                let annotation = if type.TypeArgumentNullableAnnotations[index] == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated ||
                    argument.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated {
                    Microsoft.CodeAnalysis.NullableAnnotation.Annotated
                } else {
                    type.TypeArgumentNullableAnnotations[index]
                }
                return argument.WithNullableAnnotation(annotation)
            }

            private func GetEffectiveTupleElementType(tuple INamedTypeSymbol, index int32) ITypeSymbol {
                let element = tuple.TupleElements[index]
                let annotation = if element.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated ||
                    element
                    .Type
                    .NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated {
                    Microsoft.CodeAnalysis.NullableAnnotation.Annotated
                } else {
                    element.NullableAnnotation
                }
                return element.Type.WithNullableAnnotation(annotation)
            }

            private func GetProjectedLambdaInvocationReturnType(
                lambda AnonymousFunctionExpressionSyntax,
                invoke IMethodSymbol?,
                projectedResult ITypeSymbol
            ) ITypeSymbol {
                if lambda.AsyncKeyword.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.AsyncKeyword) &&
                    invoke!!.ReturnType is INamedTypeSymbol{
                    Name: "Task",
                    IsGenericType: true,
                    TypeArguments: {Length: 1}
                } task &&
                    task
                    .ContainingNamespace
                    ?.ToDisplayString() == "System.Threading.Tasks" {
                    return task
                        .ConstructedFrom
                        .Construct(projectedResult)
                        .WithNullableAnnotation(task.NullableAnnotation)
                }
                return projectedResult
            }

            private func ReceiverTypeHierarchy(receiver INamedTypeSymbol?) sequence[INamedTypeSymbol] {
                for var current INamedTypeSymbol? = receiver; current != nil; current = current!!.BaseType {
                    yield current
                }
                for contract in receiver!!.AllInterfaces {
                    yield contract
                }
            }

            /// Whether a named tuple element's name was INFERRED by C# 7.1 from the
            /// element expression rather than written down. A declared name — in a
            /// tuple TYPE (`(int Line, int Column)`) or carried on a metadata
            /// signature — has a (cref:TupleElementSyntax) declaring
            /// reference or none at all; an inferred one points back at the tuple
            /// literal's own (cref:ArgumentSyntax), the only spelling that
            /// does not survive translation (ADR-0172 does not infer names).
            /// @param element The tuple element field symbol.
            /// @returns `true` when the name exists only by inference.
            private func IsInferredTupleElementName(element IFieldSymbol) bool {
                let references = element.DeclaringSyntaxReferences
                if references.IsDefaultOrEmpty {
                    return false
                }
                for reference in references {
                    if reference.GetSyntax() is TupleElementSyntax {
                        return false
                    }
                }
                return true
            }

            // ADR-0054: G#'s parser never chains postfix member/index/call access
            // directly onto a numeric-literal token (`42.ToString()`, `7.Squared()`)
            // because the lexer would otherwise have to guess whether `.` starts a
            // float's fractional part or a member access; the grammar resolves this by
            // simply disallowing the chain and requiring `(42).ToString()` instead. Any
            // receiver that renders as a bare int/float literal — decimal, hex, octal,
            // binary, or suffixed (`L`/`UL`/`F`/`D`/`M`) — therefore needs parentheses
            // wherever it is used as a member-access/call receiver; a non-literal
            // receiver (identifier, call, existing parenthesized expression, etc.) is
            // left untouched. A prefix unary on a numeric literal (`-5`, `+5`, `~5`)
            // still renders with a trailing numeric token, so it is treated the same
            // (e.g. `"x=" + -5` -> `(-5).ToString()`).
            private func IsBareNumericLiteral(expr GExpression?) bool -> expr is LiteralExpression &&
                (expr.Kind == LiteralKind.Int || expr.Kind == LiteralKind.Float) ||
                (expr is UnaryExpression u && IsBareNumericLiteral(u.Operand))

            private func ParenthesizeIfBareNumericLiteral(expr GExpression?) GExpression? -> if IsBareNumericLiteral(
                expr
            ) {
                cast[GExpression](ParenthesizedExpression(expr))
            } else {
                expr
            }

            // Issue #3638: a synthetic member access (e.g. an appended `.ToString()`)
            // binds tighter than any binary/unary/if operator, so a non-atomic
            // receiver must be parenthesized or the access silently lands on the
            // receiver's last operand (`i + 1.ToString()` instead of
            // `(i + 1).ToString()`). Same predicate as CoerceConcatOperand's
            // receiver guard, plus prefix unaries (whose numeric-tail case
            // IsBareNumericLiteral already covered).
            private func ParenthesizeForSyntheticMemberAccess(
                expr GExpression
            ) GExpression -> if expr is BinaryExpression ||
                expr is IfExpression ||
                expr is UnaryExpression ||
                IsBareNumericLiteral(expr) {
                cast[GExpression](ParenthesizedExpression(expr))
            } else {
                expr
            }

            // Whether a value of <paramref name="type"/> carries a reference
            // position below its top level: an array whose element is (or holds)
            // a reference, or a constructed type with a reference or
            // type-parameter argument, including one nested inside a value-type
            // argument (a tuple). An `int[]` has none: gsc reads it as
            // `[]int32!`, which converts to `[]int32` and `[]int32?` as a scalar
            // read does.
            private func HasNestedReferencePosition(type ITypeSymbol?) bool {
                // Roslyn leaves TypeInfo.Type null for an unbound expression. No
                // type means no known nested position; the member checks after
                // this call decide the read.
                if type == nil {
                    return false
                }
                if type is IArrayTypeSymbol array {
                    return IsOrHoldsReference(array.ElementType)
                }
                if type is not INamedTypeSymbol named {
                    return false
                }
                for var current INamedTypeSymbol? = named; current != nil; current = current!!.ContainingType {
                    for argument in current.TypeArguments {
                        if IsOrHoldsReference(argument) {
                            return true
                        }
                    }
                }
                return false
            }

            private func IsOrHoldsReference(type ITypeSymbol) bool -> type.IsReferenceType ||
                type is ITypeParameterSymbol ||
                HasNestedReferencePosition(type)

            // The outermost expression whose value is `value` passed through
            // unchanged: parentheses, a conditional or switch arm, and `??`.
            private func SkipValuePreservingParents(value Microsoft.CodeAnalysis.SyntaxNode?) Microsoft
                .CodeAnalysis
                .SyntaxNode? {
                var node Microsoft.CodeAnalysis.SyntaxNode? = value
                while (
                    node!!.Parent is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ParenthesizedExpressionSyntax or
                        Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ConditionalExpressionSyntax or
                        Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .SwitchExpressionArmSyntax or
                        Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .SwitchExpressionSyntax
                ) ||
                    (
                    node!!.Parent is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .BinaryExpressionSyntax coalesce &&
                        coalesce.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.CoalesceExpression)
                ) {
                    node = node!!.Parent
                }
                return node
            }

            // ADR-0186 step 6 (PR 0): whether <paramref name="element"/> of a tuple
            // literal deconstructed into a declaration lands in a new local
            // (`var (name, _) = (n.Name, 0)`, or `(var name, var n2) = ...`). Such
            // a local takes its type from the element, like a `var` initializer,
            // so a `T!` element would make it `T!`. An element assigned to an
            // existing variable has a fixed target and is not an inference
            // position. Written as plain type tests: cs2gs translates itself, and
            // a nested property pattern here would spill.
            private func ElementDeclaresDeconstructedLocal(tuple TupleExpressionSyntax, element ArgumentSyntax) bool {
                if tuple.Parent is not Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .AssignmentExpressionSyntax assignment ||
                    assignment.Right != tuple {
                    return false
                }
                if assignment.Left is DeclarationExpressionSyntax {
                    return true
                }
                if assignment.Left is not TupleExpressionSyntax targets ||
                    targets
                    .Arguments
                    .Count != tuple
                    .Arguments
                    .Count {
                    return false
                }
                let index = tuple.Arguments.IndexOf(element)
                return index >= 0 && targets.Arguments[index].Expression is DeclarationExpressionSyntax
            }

            // The local declaration whose initializer is <paramref name="clause"/>,
            // or null when it initializes something else (a field, a property, a
            // parameter default). A `for` or `using` statement's declaration is a
            // local declaration too: both are translated through
            // TranslateLocalDeclaration. Written as plain type tests: cs2gs
            // translates itself, and a nested property pattern here would spill.
            private func LocalDeclarationOf(clause EqualsValueClauseSyntax) Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .VariableDeclarationSyntax? {
                if clause.Parent is not VariableDeclaratorSyntax declarator ||
                    declarator.Parent is not Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .VariableDeclarationSyntax declaration ||
                    declaration.Parent is not(
                    LocalDeclarationStatementSyntax or
                        ForStatementSyntax or
                        Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .UsingStatementSyntax
                ) {
                    return nil
                }
                return declaration
            }

            private func EnsureNonNullAssertion(
                expression GExpression?
            ) GExpression? -> if TranslatedExpressionIsStaticallyNonNull(expression) {
                expression
            } else if expression is AwaitExpression {
                // `await x!!` asserts the task; the awaited value needs `(await x)!!` (issue #5526).
                cast[GExpression](NonNullAssertionExpression(ParenthesizedExpression(expression)))
            } else {
                cast[GExpression](NonNullAssertionExpression(expression))
            }

            private func UnwrapTranslatedValue(expression GExpression?) GExpression? {
                var expression = expression
                while expression is ParenthesizedExpression parenthesized {
                    expression = parenthesized.Inner
                }
                return if expression is BlockExpression block {
                    UnwrapTranslatedValue(block.Value)
                } else {
                    expression
                }
            }

            // `cast[T](value)` has static type T while deliberately preserving a
            // CLR null value. Treat it as statically non-null so sink forgiveness
            // does not append `!!` and change that checked-cast runtime contract.
            private func TranslatedExpressionIsStaticallyNonNull(expression GExpression?) bool -> switch expression {
                case _ is NonNullAssertionExpression: true
                case conversion is ConversionExpression when conversion.IsCheckedReferenceCast &&
                    !conversion
                    .TargetType
                    .IsNullable: true
                case parenthesized is ParenthesizedExpression: TranslatedExpressionIsStaticallyNonNull(
                    parenthesized.Inner
                )
                case block is BlockExpression: TranslatedExpressionIsStaticallyNonNull(block.Value)
                case ifExpression is IfExpression: TranslatedExpressionIsStaticallyNonNull(
                    ifExpression.ThenExpression
                ) &&
                    TranslatedExpressionIsStaticallyNonNull(ifExpression.ElseExpression)
                case ifLet is IfLetExpression: TranslatedExpressionIsStaticallyNonNull(ifLet.ThenExpression) &&
                    TranslatedExpressionIsStaticallyNonNull(ifLet.ElseExpression)
                case switchExpression is SwitchExpression: switchExpression.Arms.Count > 0 && switchExpression.Arms.All(
                    (arm SwitchArm) -> TranslatedExpressionIsStaticallyNonNull(arm.Body)
                )
                case binary is BinaryExpression when binary.Operator == "??": TranslatedExpressionIsStaticallyNonNull(
                    binary.Right
                )
                default: false
            }

            private func IsStableMemberSymbol(symbol ISymbol?) bool -> switch symbol {
                case field is IFieldSymbol: field.IsReadOnly && !field.IsStatic
                case property is IPropertySymbol: IsStableAutoProperty(property)
                default: false
            }

            // Mirrors src/Core/CodeAnalysis/Binding/SmartCastStability.IsStableProperty:
            // an auto-implemented (no custom getter/setter body, no expression
            // body) instance property, non-virtual/non-override/non-abstract, with
            // no setter or an init-only setter.
            private func IsStableAutoProperty(property IPropertySymbol?) bool {
                if property == nil ||
                    property.IsStatic ||
                    property.IsVirtual ||
                    property.IsOverride ||
                    property.IsAbstract ||
                    property.GetMethod == nil {
                    return false
                }
                if property.SetMethod != nil && !property.SetMethod!!.IsInitOnly {
                    return false
                }
                if property.DeclaringSyntaxReferences.IsDefaultOrEmpty {
                    // No source declaration to inspect (e.g. imported from
                    // metadata) — conservatively treat as unstable.
                    return false
                }
                for reference in property.DeclaringSyntaxReferences {
                    if reference.GetSyntax() is not Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .PropertyDeclarationSyntax propertyDeclaration ||
                        propertyDeclaration.ExpressionBody != nil ||
                        propertyDeclaration.AccessorList == nil {
                        return false
                    }
                    for accessor in propertyDeclaration.AccessorList!!.Accessors {
                        if accessor.Body != nil || accessor.ExpressionBody != nil {
                            return false
                        }
                    }
                }
                return true
            }

            // Whether `local` is declared `var` (its G# type is inferred from its
            // initializer rather than spelled).
            private func IsImplicitlyTypedLocal(local ILocalSymbol?) bool -> local!!.DeclaringSyntaxReferences.Any(
                (reference SyntaxReference) -> (
                    reference.GetSyntax() is VariableDeclaratorSyntax and
                        {
                        Parent: Microsoft.CodeAnalysis.CSharp.Syntax.VariableDeclarationSyntax and {Type: {IsVar: true}}
                    }
                )
            )

            // Whether `value` is (through parentheses) an arm of a conditional or a
            // switch expression, the walk FindContextualValueTarget climbs.
            private func IsBranchArm(value Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?) bool {
                var current Microsoft.CodeAnalysis.SyntaxNode? = value
                while current!!.Parent is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax {
                    current = current!!.Parent
                }
                return switch current!!.Parent {
                    case conditional is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ConditionalExpressionSyntax: conditional.WhenTrue == current ||
                        conditional.WhenFalse == current
                    case arm is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .SwitchExpressionArmSyntax: arm.Expression == current
                    default: false
                }
            }

            /// Issue #4356: whether an argument's target parameter is generic in a way
            /// G# will RE-INFER from the emitted argument — a parameter declared
            /// `T` or `params T[]` on a call whose type arguments are
            /// inferred. Then the emitted argument's own type decides `T`, so a
            /// `T?` value makes `T` nullable and must not be asserted.
            /// With EXPLICIT type arguments (`Identity<SyntaxNode>(x)`) the
            /// substituted parameter type is the real target, so this answers false
            /// and the ordinary nullability of that type decides. When the call site
            /// cannot be found, the target is treated as inferred (no assertion).
            /// @param parameter The (constructed) target parameter.
            /// @param callSite The argument expression, if known.
            /// @returns True when the target is an inferred generic parameter.
            private func IsInferredGenericParameterTarget(
                parameter IParameterSymbol,
                callSite Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
            ) bool {
                let declared = parameter.OriginalDefinition.Type
                // Only a METHOD type parameter is re-inferred from the argument. A
                // containing-type parameter is already fixed by the receiver
                // (`Box[C].Use(x)`), so its substituted type is the real target.
                let IsMethodTypeParameter = func (candidate ITypeSymbol?) bool {
                    return candidate is ITypeParameterSymbol methodParameter &&
                        methodParameter.TypeParameterKind == TypeParameterKind.Method
                }
                let generic = IsMethodTypeParameter(declared) ||
                    (
                    parameter.IsParams && (declared is IArrayTypeSymbol && IsMethodTypeParameter(declared.ElementType))
                )
                return generic && !CallHasExplicitTypeArguments(callSite)
            }

            // Issue #4356: whether the invocation an argument belongs to spells its
            // type arguments (`M<T>(…)`, `x.M<T>(…)`, `x?.M<T>(…)`).
            private func CallHasExplicitTypeArguments(
                argumentExpression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?
            ) bool {
                if argumentExpression?.Parent is not ArgumentSyntax argument ||
                    argument
                    .Parent
                    ?.Parent is not InvocationExpressionSyntax invocation {
                    return false
                }
                var callee = invocation.Expression
                if callee is MemberAccessExpressionSyntax memberAccess {
                    callee = memberAccess.Name
                } else if callee is MemberBindingExpressionSyntax memberBinding {
                    callee = memberBinding.Name
                }
                return callee is GenericNameSyntax
            }

            private func GetEffectiveReturnType(returnType ITypeSymbol?, isAsync bool) ITypeSymbol? -> if isAsync &&
                returnType is INamedTypeSymbol taskLike &&
                IsTaskLikeEnvelope(taskLike) {
                taskLike.TypeArguments[0]
            } else {
                returnType
            }

            private func IsTaskLikeEnvelope(type ITypeSymbol?) bool {
                if type is not INamedTypeSymbol named ||
                    !named.IsGenericType ||
                    named
                    .TypeArguments
                    .Length != 1 ||
                    named.Name is not("Task" or "ValueTask") {
                    return false
                }
                return named.ContainingNamespace.ToDisplayString() == "System.Threading.Tasks"
            }

            private func HasSameSourceDeclaration(left ISymbol?, right ISymbol?) bool -> left!!
                .DeclaringSyntaxReferences
                .Any(
                (leftDeclaration SyntaxReference) -> right!!.DeclaringSyntaxReferences.Any(
                    (rightDeclaration SyntaxReference) -> leftDeclaration.SyntaxTree == rightDeclaration.SyntaxTree &&
                        leftDeclaration.Span == rightDeclaration.Span
                )
            )

            // Walks outward from a conditional/switch ARM (through parentheses and
            // any number of NESTED conditional/switch levels) to the simple
            // assignment whose right-hand side that conditional ultimately is.
            // Requires at least one conditional/switch level to have been crossed:
            // a direct, unwrapped assignment RHS is issue #2259's whole-RHS rule's
            // business and is deliberately left alone here. A use sitting in a
            // conditional's CONDITION (rather than an arm) stops the walk, as does
            // any other intervening expression — this is not a general "does this
            // value eventually reach an element write" dataflow question.
            private func TryGetElementAccessAssignmentThroughConditionalArms(
                use Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?,
                out assignment Microsoft.CodeAnalysis.CSharp.Syntax.AssignmentExpressionSyntax?
            ) bool {
                assignment = nil
                var current Microsoft.CodeAnalysis.SyntaxNode? = use
                var crossedConditional = false
                while current != nil {
                    switch current.Parent {
                        case parenthesized is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax {
                            current = parenthesized
                            continue
                        }
                        case ternary is Microsoft
                            .CodeAnalysis
                            .CSharp
                            .Syntax
                            .ConditionalExpressionSyntax when current == ternary.WhenTrue ||
                            current == ternary.WhenFalse {
                            crossedConditional = true
                            current = ternary
                            continue
                        }
                        case arm is Microsoft
                            .CodeAnalysis
                            .CSharp
                            .Syntax
                            .SwitchExpressionArmSyntax when current == arm.Expression &&
                            arm.Parent is Microsoft
                            .CodeAnalysis
                            .CSharp
                            .Syntax
                            .SwitchExpressionSyntax switchExpression {
                            crossedConditional = true
                            current = switchExpression
                            continue
                        }
                        case candidate is Microsoft
                            .CodeAnalysis
                            .CSharp
                            .Syntax
                            .AssignmentExpressionSyntax when current == candidate.Right {
                            if !crossedConditional {
                                return false
                            }
                            assignment = candidate
                            return true
                        }
                        default {
                            return false
                        }
                    }
                }
                return false
            }

            private func IsTaskRunEntryPoint(method IMethodSymbol) bool {
                let original = method.OriginalDefinition
                return (original.Name is "Run" or "StartNew") &&
                    original.ContainingType is {Name: "Task" or "TaskFactory"} containingType &&
                    containingType
                    .ContainingNamespace
                    ?.ToDisplayString() == "System.Threading.Tasks"
            }

            private func IsTaskResultUnwrapMember(name string) bool -> name == "Result" || name == "GetAwaiter"

            private func ReturnsGenericSelectorResult(
                genericMethod IMethodSymbol,
                parameterOrdinal int32,
                isAsync bool
            ) bool {
                if !genericMethod.IsGenericMethod ||
                    parameterOrdinal < 0 ||
                    parameterOrdinal >= genericMethod
                    .Parameters
                    .Length {
                    return false
                }
                let parameter = genericMethod.Parameters[parameterOrdinal]
                let selectorType = switch parameter.Type {
                    case array is IArrayTypeSymbol when parameter.IsParams: array.ElementType
                    case named is INamedTypeSymbol when parameter.IsParams &&
                        IsSupportedParamsCollectionType(named): named.TypeArguments[0]
                    default: parameter.Type
                }
                if selectorType is not INamedTypeSymbol delegateType ||
                    delegateType.TypeKind != TypeKind.Delegate ||
                    (isAsync && !IsTaskLikeEnvelope(delegateType.DelegateInvokeMethod?.ReturnType)) ||
                    GetEffectiveReturnType(
                    delegateType.DelegateInvokeMethod?.ReturnType,
                    isAsync
                ) is not ITypeParameterSymbol resultParameter ||
                    resultParameter.TypeParameterKind != TypeParameterKind.Method ||
                    !SymbolEqualityComparer
                    .Default
                    .Equals(resultParameter.ContainingSymbol, genericMethod) {
                    return false
                }
                var resultType ITypeSymbol? = genericMethod.ReturnType
                if resultType is INamedTypeSymbol namedResult {
                    var enumerable INamedTypeSymbol? = if namedResult
                        .OriginalDefinition
                        .SpecialType == SpecialType.System_Collections_Generic_IEnumerable_T {
                        namedResult
                    } else {
                        default(INamedTypeSymbol?)
                    }
                    for iface in namedResult.AllInterfaces {
                        if iface
                            .OriginalDefinition
                            .SpecialType != SpecialType.System_Collections_Generic_IEnumerable_T {
                            continue
                        }
                        if enumerable != nil && !SymbolEqualityComparer.Default.Equals(enumerable, iface) {
                            return false
                        }
                        enumerable = iface
                    }
                    if enumerable != nil {
                        resultType = GetEnumerableElementType(enumerable)
                    } else if namedResult.SpecialType == SpecialType.System_Collections_IEnumerable ||
                        namedResult
                        .AllInterfaces
                        .Any(
                        (iface INamedTypeSymbol) -> iface.SpecialType == SpecialType.System_Collections_IEnumerable
                    ) {
                        return false
                    }
                }
                return ContainsSelectorResult(resultType, resultParameter)
            }

            private func ContainsSelectorResult(
                type ITypeSymbol?,
                resultParameter ITypeParameterSymbol
            ) bool -> SymbolEqualityComparer
                .Default
                .Equals(type, resultParameter) ||
                (type is IArrayTypeSymbol array && ContainsSelectorResult(array.ElementType, resultParameter)) ||
                (
                type is INamedTypeSymbol named &&
                    (
                    named.TypeArguments.Any(
                        (argument ITypeSymbol) -> ContainsSelectorResult(argument, resultParameter)
                    ) ||
                        (
                        named.ContainingType is {} containingType &&
                            ContainsSelectorResult(containingType, resultParameter)
                    )
                )
            )

            // True when <paramref name="descendant"/> is nested inside
            // <paramref name="arm"/> through parenthesized expressions only.
            private func IsDescendantOfArmViaParens(
                descendant Microsoft.CodeAnalysis.SyntaxNode?,
                arm Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
            ) bool {
                for var node Microsoft.CodeAnalysis.SyntaxNode? = descendant; node != nil; node = node!!.Parent {
                    if node == arm {
                        return true
                    }
                    if !(node.Parent is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax) &&
                        node != descendant {
                        return false
                    }
                }
                return false
            }

            private func StripParentheses(expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax?) Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ExpressionSyntax? {
                var expression = expression
                while expression is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax paren {
                    expression = paren.Expression
                }
                return expression
            }
        }
    }
}
