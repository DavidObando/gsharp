// <copyright file="CSharpToGSharpTranslator.Expressions.cs" company="GSharp">
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
        // Issue #1907: C#14's `field` contextual keyword inside a property
        // accessor is a distinct Roslyn node (FieldExpressionSyntax, NOT an
        // IdentifierNameSyntax) that binds to the compiler-synthesized backing
        // field of the enclosing property. TranslateProperty registers a real G#
        // field name for it before translating any accessor body, so by the time
        // this runs the lookup always succeeds for a property that legitimately
        // uses `field`.
        private GExpression TranslateFieldExpression(FieldExpressionSyntax fieldExpression)
        {
            if (this.context.GetSymbolInfo(fieldExpression).Symbol is IFieldSymbol { AssociatedSymbol: IPropertySymbol owner } &&
                this.state.SynthesizedPropertyBackingFieldNames.TryGetValue(owner, out string backingName))
            {
                return new IdentifierExpression(backingName);
            }

            this.context.ReportUnsupported(
                fieldExpression,
                "the C#14 `field` keyword could not be resolved to its property's synthesized backing field (ADR-0115 §B).");
            return new IdentifierExpression("nil");
        }

        private GExpression TranslateIdentifierName(IdentifierNameSyntax identifier)
        {
            if (this.context.GetSymbolInfo(identifier).Symbol is IMethodSymbol localFunction
                && localFunction.MethodKind == MethodKind.LocalFunction
                && this.state.LiftedStaticLocalFunctions.TryGetValue(localFunction.OriginalDefinition, out string liftedName)
                && localFunction.ContainingType is { } containingType)
            {
                // Issue #3471: the lifted helper lands in the containing
                // aggregate's `shared` block, so a same-type site names it bare.
                return this.IsBareSiblingStaticScope(containingType, liftedName, identifier)
                    ? new IdentifierExpression(liftedName)
                    : new MemberAccessExpression(
                        this.StaticQualifierReceiver(containingType, identifier.GetLocation()),
                        liftedName);
            }

            // Issue #3399: a member of a recursive/mutually recursive SCC of
            // capturing local functions is bound through a nullable function-typed
            // local (`var X ((…) -> …)? = nil; X = func …`), so a bare reference
            // from another SCC member's closure body must go through the local
            // itself — `X` would be GS0125 at its declared type, which has the
            // `nil` default. The postfix null assertion unwraps the nullable
            // (ADR-0069), mirroring gsc's own lowering (its `var` decl also
            // emits as `(p) → R? = nil`).
            if (this.context.GetSymbolInfo(identifier).Symbol is IMethodSymbol recursiveLocal
                && recursiveLocal.MethodKind == MethodKind.LocalFunction
                && this.state.RecursiveLocalFunctionGroups.TryGetValue(
                    recursiveLocal, out RecursiveLocalFunctionGroup recursiveGroup)
                && recursiveGroup.Members.Contains(recursiveLocal))
            {
                // `IsDirectWrite` is intentionally NOT consulted: a write to a
                // function-typed function local would be a C# compile error
                // ("Cannot assign to ... because it is a local function"), so a
                // rewrite here cannot change meaning.
                return new NonNullAssertionExpression(
                    new IdentifierExpression(recursiveGroup.NameOf(recursiveLocal)));
            }

            // A switch-expression property-pattern binding (`Circle { Radius: var r }`)
            // has no G# equivalent; references to the bound local are rewritten to a
            // member access on the arm's type-pattern designator (`circle.Radius`).
            if (this.state.PatternBindings.Count > 0 &&
                !IsDirectWrite(identifier) &&
                this.context.GetSymbolInfo(identifier).Symbol is { } boundSymbol &&
                this.state.PatternBindings.TryGetValue(boundSymbol, out GExpression replacement))
            {
                return replacement;
            }

            // A C# bare sibling static field/property reference (`FfAc3ChannelsTab`)
            // carries an implicit type qualifier. A G# top-level `func` (e.g. a
            // lifted extension method whose former `static class` keeps the field
            // in a `shared { }` block) or `shared` body has no implicit type scope,
            // so the reference must be qualified through the owning type
            // (`Ec3Extensions.FfAc3ChannelsTab`) — the field/property analog of the
            // bare static-call rule (ADR-0115 §B.18). Without this the binder reports
            // GS0125 (the name is not in scope at top level).
            if (this.context.GetSymbolInfo(identifier).Symbol is ISymbol staticMember &&
                staticMember.IsStatic &&
                (staticMember.Kind == SymbolKind.Field || staticMember.Kind == SymbolKind.Property) &&
                staticMember.ContainingType is INamedTypeSymbol owner &&
                (owner.TypeKind == TypeKind.Class || owner.TypeKind == TypeKind.Struct) &&
                !owner.IsImplicitlyDeclared &&
                (!this.IsStaticUsingTarget(owner)
                    || RequiresQualifiedImportedContextualValue(
                        staticMember,
                        identifier)) &&
                !SymbolEqualityComparer.Default.Equals(owner.OriginalDefinition, this.entryType?.OriginalDefinition) &&
                !this.IsBareSiblingStaticScope(
                    owner,
                    this.EmittedName(staticMember, identifier.Identifier.ValueText),
                    identifier))
            {
                return new MemberAccessExpression(
                    this.StaticQualifierReceiver(owner, identifier.GetLocation()),
                    this.EmittedName(staticMember, identifier.Identifier.ValueText));
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
            if (this.context.GetSymbolInfo(identifier).Symbol is IFieldSymbol { IsFixedSizeBuffer: true } fixedBufferField)
            {
                return new MemberAccessExpression(
                    new ThisExpression(),
                    this.EmittedName(fixedBufferField, identifier.Identifier.ValueText));
            }

            // A bare type used as an expression receiver (Path.Combine,
            // Task.FromResult, Console.WriteLine, ...) does not pass through
            // type-syntax translation. Map it here so SDK implicit/global
            // usings still contribute the namespace import required by G#.
            if (this.context.SemanticModel.GetAliasInfo(identifier) is IAliasSymbol alias)
            {
                return new IdentifierExpression(this.EmittedName(alias, alias.Name));
            }

            if (this.context.SemanticModel.GetAliasInfo(identifier) is null &&
                this.context.GetSymbolInfo(identifier).Symbol is INamedTypeSymbol type)
            {
                return new TypeExpression(this.typeMapper.Map(type, this.context, identifier.GetLocation()));
            }

            if (identifier.Identifier.ValueText == "_" &&
                this.context.GetSymbolInfo(identifier).Symbol is IParameterSymbol)
            {
                return new IdentifierExpression("__underscore");
            }

            if (identifier.Identifier.ValueText == "_"
                && this.context.GetSymbolInfo(identifier).Symbol is null)
            {
                return new IdentifierExpression("_");
            }

            return new IdentifierExpression(this.EmittedName(identifier, identifier.Identifier));
        }

        private static bool RequiresQualifiedImportedContextualValue(
            ISymbol member,
            IdentifierNameSyntax identifier)
        {
            if (!member.DeclaringSyntaxReferences.IsDefaultOrEmpty)
            {
                return false;
            }

            var context =
                GSharp.Core.CodeAnalysis.Syntax.IdentifierNameContext.General;
            if (identifier.Parent is ElementAccessExpressionSyntax elementAccess
                && elementAccess.Expression == identifier)
            {
                context |= GSharp.Core.CodeAnalysis.Syntax.IdentifierNameContext.Index;
            }

            if (identifier.Parent is InvocationExpressionSyntax invocation
                && invocation.Expression == identifier)
            {
                context |= GSharp.Core.CodeAnalysis.Syntax.IdentifierNameContext.Invocation;
            }

            return GSharp.Core.CodeAnalysis.Syntax.SyntaxFacts.IsReservedIdentifier(
                member.Name,
                context);
        }

        private static bool IsDirectWrite(IdentifierNameSyntax identifier) =>
            identifier.Parent switch
            {
                AssignmentExpressionSyntax assignment when assignment.Left == identifier => true,
                PrefixUnaryExpressionSyntax prefix
                    when prefix.Operand == identifier &&
                         (prefix.IsKind(SyntaxKind.PreIncrementExpression)
                          || prefix.IsKind(SyntaxKind.PreDecrementExpression)) => true,
                PostfixUnaryExpressionSyntax postfix
                    when postfix.Operand == identifier &&
                         (postfix.IsKind(SyntaxKind.PostIncrementExpression)
                          || postfix.IsKind(SyntaxKind.PostDecrementExpression)) => true,
                ArgumentSyntax argument
                    when argument.Expression == identifier &&
                         (argument.RefKindKeyword.IsKind(SyntaxKind.RefKeyword)
                          || argument.RefKindKeyword.IsKind(SyntaxKind.OutKeyword)) => true,
                _ => false,
            };

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
        private bool IsBareSiblingStaticScope(
            INamedTypeSymbol owner,
            string memberName,
            SyntaxNode site)
        {
            if (this.typeMapper.ClaimsDocumentScopeName(memberName, this.context))
            {
                return false;
            }

            for (SyntaxNode node = site; node != null; node = node.Parent)
            {
                if (node is MethodDeclarationSyntax method
                    && this.context.GetDeclaredSymbol(method) is IMethodSymbol
                        { IsExtensionMethod: true })
                {
                    return false;
                }

                if (node is TypeDeclarationSyntax typeDeclaration)
                {
                    return this.context.GetDeclaredSymbol(typeDeclaration) is INamedTypeSymbol siteType
                        && SymbolEqualityComparer.Default.Equals(
                            siteType.OriginalDefinition,
                            owner.OriginalDefinition);
                }
            }

            return false;
        }

        // Builds the receiver expression used to qualify a bare sibling static
        // member reference through its owning type. For a non-generic owner this is
        // a plain identifier (`Owner`); for a GENERIC owner it must carry the type
        // arguments (`Owner[T]`) so it does not collide with a sibling non-generic
        // type of the same simple name (e.g. `static class TreeDecomposition` beside
        // `class TreeDecomposition<T>`), which would otherwise bind the arity-0 type
        // and report GS0158 for members that live only on the generic type.
        private GExpression StaticQualifierReceiver(INamedTypeSymbol owner, Location location)
        {
            if (owner.IsGenericType)
            {
                return new TypeExpression(this.typeMapper.Map(owner, this.context, location));
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
            GTypeReference mapped = this.typeMapper.Map(owner, this.context, location);
            string qualifiedName = mapped is NamedTypeReference named ? named.Name : owner.Name;
            return new IdentifierExpression(qualifiedName);
        }

        private GExpression TranslateLiteral(LiteralExpressionSyntax literal)
        {
            switch (literal.Kind())
            {
                case SyntaxKind.NumericLiteralExpression:
                    // Preserve the original literal spelling (ADR-0115 §B.12): G#
                    // has no implicit numeric promotion, so a C# `2.0` must stay
                    // `2.0` (not collapse to `2`, which would be int32 and fail
                    // `int32 * float64`); hex such as `0xFF0000` is likewise kept
                    // verbatim. The bound type still classifies the literal kind.
                    object value = literal.Token.Value;
                    if (value is float or double or decimal)
                    {
                        return LiteralExpression.Float(literal.Token.Text);
                    }

                    // C# applies an implicit int->double/float promotion at a
                    // call site (e.g. `M(30)` where the parameter is `double`).
                    // G# has no such implicit promotion, so the emitter would push
                    // an int32 where a float64 is expected and produce invalid IL
                    // (ilverify StackUnexpected). Honor the bound `ConvertedType`
                    // and emit a float literal so the value matches its target
                    // type (ADR-0115 §B.12).
                    if (this.IsConvertedToFloatingPoint(literal))
                    {
                        return LiteralExpression.Float(this.ToFloatLiteralText(literal.Token.Value));
                    }

                    return LiteralExpression.Int(this.NormalizeIntegerLiteralText(literal));

                case SyntaxKind.StringLiteralExpression:
                    return LiteralExpression.String(literal.Token.ValueText);

                case SyntaxKind.Utf8StringLiteralExpression:
                    // A UTF-8 string literal `"x"u8` is a `ReadOnlySpan<byte>` of
                    // the UTF-8 encoding of the text. G# has no `u8` suffix, so emit
                    // the canonical byte slice literal `[]uint8{ … }` (ADR-0115 §B).
                    return new ArrayLiteralExpression(
                        new NamedTypeReference("uint8"),
                        System.Text.Encoding.UTF8.GetBytes(literal.Token.ValueText)
                            .Select(b => (GExpression)LiteralExpression.Int($"0x{b:X2}"))
                            .ToList());

                case SyntaxKind.CharacterLiteralExpression:
                    return LiteralExpression.Char(literal.Token.ValueText);

                case SyntaxKind.TrueLiteralExpression:
                    return LiteralExpression.Bool(true);

                case SyntaxKind.FalseLiteralExpression:
                    return LiteralExpression.Bool(false);

                case SyntaxKind.NullLiteralExpression:
                    return LiteralExpression.Null();

                case SyntaxKind.DefaultLiteralExpression:
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
                    return new DefaultValueExpression(this.ResolveDefaultLiteralType(literal));

                default:
                    this.context.ReportUnsupported(
                        literal,
                        $"literal '{literal.Kind()}' has no canonical G# form yet; emitted nil (ADR-0115 §B.12).");
                    return LiteralExpression.Null();
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
        private GTypeReference ResolveDefaultLiteralType(LiteralExpressionSyntax literal)
        {
            GTypeReference resolved = this.ResolveExpressionType(literal);
            TypeInfo info = this.context.GetTypeInfo(literal);
            return (info.ConvertedType ?? info.Type) is ITypeParameterSymbol
                && resolved is NamedTypeReference { IsNullable: true } named
                && this.TargetIsBareTypeParameter(literal)
                    ? new NamedTypeReference(named.Name, named.TypeArguments, named.ContainingType)
                    : resolved;
        }

        // Whether the slot `literal` flows into is DECLARED as an unannotated
        // type parameter, in any of the three positions where a declaration
        // settles it (issue #3676 for returns, #3907 for the other two).
        private bool TargetIsBareTypeParameter(LiteralExpressionSyntax literal)
        {
            return this.ReturnsBareTypeParameter(literal)
                || this.AssignedToBareTypeParameter(literal)
                || this.PassedToBareTypeParameter(literal);
        }

        // `value = default;` where `value` is declared `T` — most often an
        // `[MaybeNullWhen(false)] out T`, whose attribute makes Roslyn's flow
        // state maybe-null while the declared type stays a bare `T`.
        private bool AssignedToBareTypeParameter(LiteralExpressionSyntax literal)
        {
            if (literal.Parent is not AssignmentExpressionSyntax assignment
                || !assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                || assignment.Right != literal)
            {
                return false;
            }

            ISymbol target = this.context.GetSymbolInfo(assignment.Left).Symbol;
            ITypeSymbol declared = target switch
            {
                IParameterSymbol parameter => parameter.Type,
                ILocalSymbol local => local.Type,
                IFieldSymbol field => field.Type,
                IPropertySymbol property => property.Type,
                _ => null,
            };

            return IsBareTypeParameter(declared);
        }

        // `M(default)` where the parameter is declared `T`. The parameter type
        // is read off the RESOLVED (substituted) symbol, so an explicitly
        // nullable type argument — `Same<T?>(default)`, issue #2500 — presents
        // as annotated and keeps its `?`.
        private bool PassedToBareTypeParameter(LiteralExpressionSyntax literal)
        {
            if (literal.Parent is not ArgumentSyntax argument
                || argument.Parent is not BaseArgumentListSyntax argumentList
                || argument.NameColon != null)
            {
                return false;
            }

            if (this.context.GetSymbolInfo(argumentList.Parent).Symbol is not IMethodSymbol method)
            {
                return false;
            }

            int index = argumentList.Arguments.IndexOf(argument);
            if (index < 0 || index >= method.Parameters.Length)
            {
                // A `params` tail, or an argument list this overload does not
                // line up with positionally; not a slot a declaration settles.
                return false;
            }

            return IsBareTypeParameter(method.Parameters[index].Type);
        }

        private static bool IsBareTypeParameter(ITypeSymbol type)
        {
            return type is ITypeParameterSymbol
                && type.NullableAnnotation != NullableAnnotation.Annotated;
        }

        // Whether `literal` is the value of a `return` in a method or local
        // function whose DECLARED result is an unannotated type parameter. An
        // async method's result is the awaited one (`async Task<T>` declares
        // `T`), matching what `return default;` is target-typed to.
        private bool ReturnsBareTypeParameter(LiteralExpressionSyntax literal)
        {
            if (literal.Parent is not ReturnStatementSyntax returnStatement)
            {
                return false;
            }

            SyntaxNode owner = returnStatement.Ancestors()
                .FirstOrDefault(node =>
                    node is BaseMethodDeclarationSyntax
                        or LocalFunctionStatementSyntax
                        or AnonymousFunctionExpressionSyntax);

            if (owner is not (BaseMethodDeclarationSyntax or LocalFunctionStatementSyntax)
                || this.context.GetDeclaredSymbol(owner) is not IMethodSymbol method)
            {
                return false;
            }

            ITypeSymbol declared = method.ReturnType;
            if (method.IsAsync
                && declared is INamedTypeSymbol { IsGenericType: true, TypeArguments.Length: 1 } awaitable)
            {
                declared = awaitable.TypeArguments[0];
            }

            return declared is ITypeParameterSymbol
                && declared.NullableAnnotation != NullableAnnotation.Annotated;
        }

        // C# infers the type of a suffix-less integer literal from its value: a
        // hex constant such as `0xD800000000000000` is implicitly `ulong`. G#'s
        // lexer instead defaults to int32/int64 and rejects an out-of-range
        // literal (GS0004), so when the bound value requires a wider/unsigned
        // type we append the matching G# suffix (`L`, `UL`, `U`).
        private string NormalizeIntegerLiteralText(LiteralExpressionSyntax literal)
        {
            string text = literal.Token.Text;
            object value = literal.Token.Value;

            // Respect an explicit suffix already present in the source spelling.
            if (text.Length > 0 && (text[text.Length - 1] is 'u' or 'U' or 'l' or 'L'))
            {
                return text;
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
            if (literal.Parent is PrefixUnaryExpressionSyntax negation
                && negation.IsKind(SyntaxKind.UnaryMinusExpression))
            {
                return this.context.GetTypeInfo(negation).Type?.SpecialType switch
                {
                    SpecialType.System_Int64 => text + "L",
                    _ => text,
                };
            }

            switch (value)
            {
                case ulong:
                    return text + "UL";
                case long l when l > int.MaxValue || l < int.MinValue:
                    return text + "L";
                case uint u when u > int.MaxValue:
                    return text + "U";
                default:
                    return text;
            }
        }

        private bool IsConvertedToFloatingPoint(LiteralExpressionSyntax literal)
        {
            TypeInfo info = this.context.GetTypeInfo(literal);
            ITypeSymbol original = info.Type;
            ITypeSymbol converted = info.ConvertedType;
            if (converted is null || SymbolEqualityComparer.Default.Equals(original, converted))
            {
                return false;
            }

            bool originalIsIntegral = original != null
                && (original.SpecialType == SpecialType.System_SByte
                    || original.SpecialType == SpecialType.System_Byte
                    || original.SpecialType == SpecialType.System_Int16
                    || original.SpecialType == SpecialType.System_UInt16
                    || original.SpecialType == SpecialType.System_Int32
                    || original.SpecialType == SpecialType.System_UInt32
                    || original.SpecialType == SpecialType.System_Int64
                    || original.SpecialType == SpecialType.System_UInt64);
            bool convertedIsFloat = converted.SpecialType == SpecialType.System_Single
                || converted.SpecialType == SpecialType.System_Double;
            return originalIsIntegral && convertedIsFloat;
        }

        private string ToFloatLiteralText(object value)
        {
            // The token's *spelling* can be hex (`0xFF`), binary (`0b1010`),
            // digit-separated (`1_000`), or suffixed (`30L`); appending ".0" to
            // that raw text either produces an invalid G# float (`0xFF.0`,
            // `30L.0`) or silently misses cases that already contain a stray
            // 'e'/'E' hex digit (`0xAE`). Deriving the text from the token's
            // already-parsed *value* instead sidesteps spelling entirely: format
            // the numeric value as decimal and ensure it carries a fractional
            // part so the G# lexer classifies it as float64.
            double number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
            string text = number.ToString("R", CultureInfo.InvariantCulture);
            return text.IndexOfAny(new[] { '.', 'e', 'E' }) >= 0 ? text : text + ".0";
        }

        /// <summary>
        /// Translates a C# anonymous object creation (<c>new { A = 1, B = 2 }</c>)
        /// to a positional construction of a synthesized G# <c>data class</c>
        /// (<c>AnonymousType0(1, 2)</c>, issues #2282 and #2538). See
        /// <see cref="CSharpTypeMapper.GetOrCreateAnonymousDataClass"/> for why
        /// a synthesized, shape-deduplicated data class supersedes both the
        /// original positional-tuple lowering (issue #1934, which dropped
        /// member names) and the intermediate <c>object { }</c> anonymous-value
        /// literal (issue #2224, which cannot be spelled as an explicit TYPE —
        /// e.g. a lambda parameter's type inferred from another lambda's
        /// anonymous-typed return value, issue #2282's actual repro shape). A
        /// positional class construction — unlike a tuple literal — is legal
        /// inside an expression-tree lambda. It also remains a direct
        /// expression when used as a constructor-delegation argument; a class
        /// composite literal lowers to setup statements before the delegation
        /// and violates G#'s delegation-first rule (issue #2538).
        /// </summary>
        private GExpression TranslateAnonymousObjectCreation(AnonymousObjectCreationExpressionSyntax anonymous)
        {
            this.context.Report(new TranslationDiagnostic(
                nameof(SyntaxKind.AnonymousObjectCreationExpression),
                "anonymous object creation 'new { ... }' maps to positional construction of a synthesized G# 'data class' (issues #2282 and #2538); gsc reuses the same synthesized type for every structurally-identical anonymous-type shape, preserving named-member access at both the construction site and any type-position use.",
                anonymous.GetLocation(),
                TranslationSeverity.Info));

            (GTypeReference Type, IReadOnlyList<IPropertySymbol> Properties) shape =
                this.context.GetTypeInfo(anonymous).Type is INamedTypeSymbol anonymousType
                    ? this.typeMapper.GetOrCreateAnonymousDataClassShape(
                        anonymousType,
                        this.context,
                        anonymous.GetLocation())
                    : (new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType), Array.Empty<IPropertySymbol>());

            // Roslyn exposes anonymous properties in constructor order. Drive
            // construction from that same registered order rather than an
            // independent member enumeration so declaration and call arity/order
            // cannot diverge across files or projects.
            var arguments = shape.Properties.Count == anonymous.Initializers.Count
                ? shape.Properties
                    .Select((property, index) =>
                    {
                        ExpressionSyntax value = anonymous.Initializers[index].Expression;
                        GExpression translated = this.ForgiveNullableReferenceValue(
                            value,
                            this.TranslateExpression(value),
                            property.Type,
                            targetSymbol: null);
                        GTypeReference propertyType = this.typeMapper.Map(
                            property.Type,
                            this.context,
                            value.GetLocation());
                        return this.AssertFlowNarrowedNullableReference(
                            value,
                            translated,
                            propertyType);
                    })
                    .ToList()
                : anonymous.Initializers
                    .Select(initializer => this.TranslateExpression(initializer.Expression))
                    .ToList();

            return BuildConstruction(shape.Type, arguments);
        }

        private GExpression TranslateMemberAccess(MemberAccessExpressionSyntax member)
        {
            // ADR-0169 analyzer mode: idioms that need more than a member
            // rename (e.g. name.Identifier -> expr.GetLastToken()).
            if (this.InAnalyzerApiMode
                && this.TryTranslateAnalyzerMemberAccess(member, out GExpression analyzerIdiom))
            {
                return analyzerIdiom;
            }

            // Issue #4350 (review): `this.P = v` (or `Type.P = v`) in a
            // constructor targets the synthesized backing field of a lowered
            // static/virtual/override get-only auto-property, exactly like the
            // bare `P = v` form handled in EmittedName.
            if (this.context.GetSymbolInfo(member).Symbol is IPropertySymbol loweredProperty
                && IsWriteTarget(member.Name)
                && this.IsBackingFieldLoweredGetOnlyAutoProperty(loweredProperty))
            {
                string backingName = this.RegisterSynthesizedPropertyBackingField(loweredProperty, primaryCtorParamNames: null);
                return loweredProperty.IsStatic
                    ? new IdentifierExpression(backingName)
                    : new MemberAccessExpression(this.TranslateExpression(member.Expression), backingName);
            }

            // C# permits namespace-qualified type expressions without importing
            // their namespace, including relative qualification from the current
            // namespace. G# resolves expression receivers as values/types, not as
            // C# namespace paths. Collapse the whole bound type expression through
            // the type mapper so it emits the canonical type name and records the
            // namespace import needed by the generated file.
            if (this.context.GetSymbolInfo(member).Symbol is INamedTypeSymbol qualifiedType)
            {
                return new TypeExpression(
                    this.typeMapper.Map(qualifiedType, this.context, member.GetLocation()));
            }

            // Issue #2351: a bare (non-invoked) reference to an extension
            // method's method group (e.g. assigned to a delegate) never goes
            // through TranslateInvocation, so track its declaring namespace
            // here too — otherwise a file relying on an implicit/global
            // `using` for that namespace would translate with no import.
            if (this.context.GetSymbolInfo(member).Symbol is IMethodSymbol { IsExtensionMethod: true } memberExtMethod)
            {
                this.typeMapper.TrackExtensionMethodNamespace(memberExtMethod);
                bool isInvocationTarget =
                    member.Parent is InvocationExpressionSyntax invocation
                    && invocation.Expression == member;
                if (memberExtMethod.MethodKind == MethodKind.ReducedExtension
                    && !isInvocationTarget
                    && this.TryGetStaticExtensionHelperForMethodGroup(
                        memberExtMethod,
                        out string helperOwner,
                        out string helperName))
                {
                    if (member.Parent is ArgumentSyntax nameOfArgument &&
                        IsNameOfArgument(nameOfArgument))
                    {
                        return new MemberAccessExpression(
                            new IdentifierExpression(helperOwner),
                            helperName);
                    }

                    return this.TranslateStaticExtensionHelperMethodGroup(
                        member,
                        memberExtMethod,
                        helperOwner,
                        helperName);
                }
            }

            // Issue #1879: a C# 14 extension-block member is declared on a
            // synthetic marker type (`INamedTypeSymbol.IsExtension`); rewrite its
            // call sites to the real emitted G# shape before falling into the
            // generic member-access translation below.
            if (this.context.GetSymbolInfo(member).Symbol is { } extSymbol
                && TryGetExtensionBlockOwner(extSymbol, out INamedTypeSymbol extOwner))
            {
                if (extSymbol.IsStatic)
                {
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
                    return new MemberAccessExpression(
                        this.StaticQualifierReceiver(extOwner, member.GetLocation()),
                        this.EmittedName(extSymbol, member.Name.Identifier.ValueText));
                }

                if (extSymbol is IPropertySymbol)
                {
                    // `nameof(word.DoubledLength)` binds to the very same property
                    // symbol as an ordinary read, but `nameof` takes a name
                    // reference, not a value (G#'s NameOfExpression parses its
                    // argument as a plain expression and the binder rejects
                    // anything but a name/member-access/generic-name). Wrapping
                    // in a zero-arg call here would print `nameof(word.DoubledLength())`,
                    // which re-parses as a call and is rejected — leave the bare
                    // member access; its printed name is exactly the lowered
                    // func's name, so `nameof` still resolves correctly.
                    if (member.Parent is ArgumentSyntax nameOfArgument && IsNameOfArgument(nameOfArgument))
                    {
                        return new MemberAccessExpression(
                            this.TranslateExpression(member.Expression),
                            this.EmittedName(extSymbol, member.Name.Identifier.ValueText));
                    }

                    // An instance extension property has no receiver-clause form
                    // in G#'s `prop` grammar and is lowered to a get-only
                    // receiver-clause `func` of the same name (ADR-0115 §B.19);
                    // a bare property read becomes a zero-argument call.
                    GExpression extReceiver = this.TranslateReceiverWithNullForgiveness(member.Expression);
                    return new InvocationExpression(
                        new MemberAccessExpression(
                            extReceiver,
                            this.EmittedName(extSymbol, member.Name.Identifier.ValueText)),
                        new List<GExpression>(),
                        null);
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
            if (this.context.GetTypeInfo(member.Expression).Type is { } receiverType
                && receiverType.OriginalDefinition?.SpecialType == SpecialType.System_Nullable_T)
            {
                switch (member.Name.Identifier.Text)
                {
                    case "Value":
                        GExpression nullableValue = this.TranslateExpression(member.Expression);
                        return this.IsWithinExpressionTreeLambda(member.Expression)
                            ? new MemberAccessExpression(nullableValue, "Value")
                            : EnsureNonNullAssertion(nullableValue);
                    case "HasValue":
                        // Parenthesize the null test so it composes correctly
                        // under any surrounding operator. C# `!x.HasValue` would
                        // otherwise translate to `!x != nil`, which G# parses as
                        // `(!x) != nil` (GS0128); `!(x != nil)` is always correct.
                        return new ParenthesizedExpression(
                            new BinaryExpression(this.TranslateExpression(member.Expression), "!=", LiteralExpression.Null()));
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
            bool receiverIsAnonymousType =
                this.context.GetTypeInfo(member.Expression).Type is { IsAnonymousType: true };

            GExpression target;
            if (this.context.SemanticModel.GetAliasInfo(member.Expression) is null
                && this.context.GetSymbolInfo(member.Expression).Symbol is INamedTypeSymbol
                { IsGenericType: true } receiverNamedType)
            {
                // A qualified generic type is a MemberAccessExpressionSyntax;
                // translate its bound type so its type arguments are retained.
                target = new TypeExpression(
                    this.typeMapper.Map(receiverNamedType, this.context, member.Expression.GetLocation()));
            }
            else
            {
                target = this.MemberBindsToNullableThisExtension(member) || receiverIsAnonymousType
                    ? this.TranslateExpression(member.Expression)
                    : this.TranslateReceiverWithNullForgiveness(member.Expression);
            }

            string memberName = member.Name.Identifier.ValueText;
            ISymbol memberSymbol = this.context.GetSymbolInfo(member).Symbol;

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
            bool isArrow = member.IsKind(SyntaxKind.PointerMemberAccessExpression);

            // ADR-0172 (amending ADR-0115 §B.4): G# now has named tuple
            // elements, so an explicitly named C# element access (`item.Price`)
            // KEEPS its name in the output — the translated tuple type carries
            // the same names. The symbol still normalizes to the positional
            // field for downstream taint/typing; only the printed name differs.
            if (memberSymbol is IFieldSymbol field &&
                field.ContainingType is { IsTupleType: true })
            {
                IFieldSymbol positional = field.CorrespondingTupleField ?? field;
                if (SymbolEqualityComparer.Default.Equals(positional, field)
                    || IsInferredTupleElementName(field))
                {
                    // Default positional access (`item.Item2`) stays positional,
                    // and so does an INFERRED one (issue #3684 F15): ADR-0172
                    // deliberately does not adopt C# 7.1 name inference, so a
                    // name C# derived from an element EXPRESSION
                    // (`(statement, index)` typing as `(… statement, … index)`)
                    // exists nowhere in the translated G# — the literal prints
                    // unlabeled and the tuple type is the unnamed shape. Reading
                    // it back by that name is GS0158; the positional spelling is
                    // always valid.
                    memberName = positional.Name;
                    memberSymbol = positional;
                }
            }

            // Issue #2282 (was #2224): an anonymous-typed value (`new { A = 1,
            // B = 2 }`) now lowers to a composite literal constructing a
            // synthesized `data class` whose primary-constructor parameters
            // preserve real member names — no rewrite needed; `x.A` stays
            // `x.A` on the G# side, exactly like the C# anonymous-type property.
            if (this.InAnalyzerApiMode)
            {
                // ADR-0169 analyzer mode: rename Roslyn API members (enum
                // values and instance members) to their G# analyzer-API
                // spellings.
                memberName = this.MapAnalyzerMemberName(member, memberName);
            }

            string emittedMemberName = this.InAnalyzerApiMode
                ? this.nameAllocator.GetName(memberName)
                : this.EmittedName(memberSymbol, memberName);
            return new MemberAccessExpression(target, emittedMemberName, isArrow);
        }

        /// <summary>
        /// Translates a member- or element-access <paramref name="recv"/> receiver,
        /// wrapping it in G#'s postfix non-null assertion (<c>recv!!</c>) when the
        /// receiver is <em>declared</em> nullable (a <c>T?</c> reference type or
        /// nullable array) yet Roslyn's nullable <em>flow</em> analysis has proven
        /// it non-null at this site (e.g. after a guard such as
        /// <c>if (o.Child == null) return;</c>).
        /// </summary>
        /// <remarks>
        /// C# uses flow-sensitive null analysis, so a guarded nullable property or
        /// field chain reads as non-null afterwards. G# follows Kotlin-style
        /// smart-casts that narrow only <em>local</em> variables, never
        /// property/field-access chains, so emitting <c>Moov.TextTrack.Mdia</c>
        /// where <c>TextTrack</c> is <c>TrakBox?</c> is rejected with GS0158 (member
        /// access on a <c>T?</c> receiver) or GS0116 (indexing a <c>T?</c> receiver).
        /// Reusing Roslyn's own proof, the assertion <c>!!</c> re-establishes the
        /// non-null fact the guard already proved (#914). The assertion is harmless
        /// on an already-non-null receiver, but the predicate below stays precise to
        /// keep the output faithful.
        /// </remarks>
        /// <param name="recv">The immediate receiver expression (left of the
        /// <c>.</c> or <c>[</c>).</param>
        /// <returns>The translated receiver, wrapped in
        /// <see cref="NonNullAssertionExpression"/> when flow-proven non-null.</returns>
        private GExpression TranslateReceiverWithNullForgiveness(ExpressionSyntax recv)
        {
            GExpression translated = this.TranslateExpression(recv);

            // Issue #3700: a `?.` / `?[` CONDITIONAL RECEIVER is null-guarded by
            // the seam that produced it, so an assertion there is at best
            // redundant and at worst masks the guard — and it is not even
            // printable, since the receiver renders as the empty string and the
            // assertion would split the `?.` token (`[i]?!!.B`).
            if (translated is ConditionalReceiverExpression)
            {
                return translated;
            }

            // ADR-0186 step 6 (PR 0): a read of oblivious CLR metadata is `T!`
            // in G#, and gsc checks a `T!` receiver itself (§4).
            if (this.PlatformTypedImportNeedsNoBridge(recv))
            {
                return translated;
            }

            bool iteratorForeachReceiverRequiresAssertion =
                this.IteratorForeachReceiverRequiresAssertion(recv);
            bool importedGenericTupleElementRequiresAssertion =
                this.ImportedGenericTupleElementRequiresAssertion(recv);

            if (!iteratorForeachReceiverRequiresAssertion
                && !importedGenericTupleElementRequiresAssertion
                && this.GSharpExpressionIsStaticallyNonNull(recv, translated))
            {
                return ParenthesizeIfBareNumericLiteral(translated);
            }

            if (iteratorForeachReceiverRequiresAssertion
                || importedGenericTupleElementRequiresAssertion

                // Issue #4356: `T?` only on the G# analyzer API. Asked outside
                // the pattern-binding gate below: a `var` designation
                // (`x is var t`) binds `t` at the scrutinee's G# type unnarrowed,
                // and gsc erases a reference `!!` in an expression tree.
                || this.IsGSharpNullableAnalyzerExpression(recv)
                || (!this.IsActivePatternBinding(recv)
                && !this.ExpressionTreeForbidsReceiverAssertion(recv)
                && !this.IsGSharpFlowNarrowedFieldOrPropertyInSameCondition(recv)
                && (this.ReceiverNeedsNullForgiveness(recv, isDereferenceReceiver: true)
                    || this.ReceiverIsNullableReferenceFieldOrProperty(recv)
                    || this.NullableReferenceValueMayBeNull(recv))))
            {
                translated = EnsureNonNullAssertion(translated);
            }
            else if (!this.IsWithinExpressionTreeLambda(recv) && this.IsLocalBoundFromAsExpression(recv))
            {
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
                translated = EnsureNonNullAssertion(translated);
            }

            return ParenthesizeIfBareNumericLiteral(translated);
        }

        /// <summary>
        /// Whether a named tuple element's name was INFERRED by C# 7.1 from the
        /// element expression rather than written down. A declared name — in a
        /// tuple TYPE (<c>(int Line, int Column)</c>) or carried on a metadata
        /// signature — has a <see cref="TupleElementSyntax"/> declaring
        /// reference or none at all; an inferred one points back at the tuple
        /// literal's own <see cref="ArgumentSyntax"/>, the only spelling that
        /// does not survive translation (ADR-0172 does not infer names).
        /// </summary>
        /// <param name="element">The tuple element field symbol.</param>
        /// <returns><see langword="true"/> when the name exists only by inference.</returns>
        private static bool IsInferredTupleElementName(IFieldSymbol element)
        {
            ImmutableArray<SyntaxReference> references = element.DeclaringSyntaxReferences;
            if (references.IsDefaultOrEmpty)
            {
                return false;
            }

            foreach (SyntaxReference reference in references)
            {
                if (reference.GetSyntax() is TupleElementSyntax)
                {
                    return false;
                }
            }

            return true;
        }

        private bool ImportedGenericTupleElementRequiresAssertion(ExpressionSyntax receiver)
        {
            if (receiver is not MemberAccessExpressionSyntax memberAccess
                || this.context.GetSymbolInfo(receiver).Symbol is not IFieldSymbol tupleField
                || !tupleField.ContainingType.IsTupleType
                || this.context.GetSymbolInfo(memberAccess.Expression).Symbol is not ILocalSymbol local)
            {
                return false;
            }

            foreach (SyntaxReference reference in local.DeclaringSyntaxReferences)
            {
                if (reference.GetSyntax() is VariableDeclaratorSyntax declarator
                    && declarator.Initializer?.Value is InvocationExpressionSyntax invocation
                    && this.context.GetSymbolInfo(invocation).Symbol is IMethodSymbol method
                    && method.OriginalDefinition.ReturnType is ITypeParameterSymbol
                    && !SymbolEqualityComparer.Default.Equals(
                        method.ContainingAssembly,
                        this.context.Compilation.Assembly))
                {
                    return true;
                }
            }

            return false;
        }

        private bool IteratorForeachReceiverRequiresAssertion(ExpressionSyntax recv)
        {
            ExpressionSyntax unwrapped = recv;
            while (unwrapped is ParenthesizedExpressionSyntax parenthesized)
            {
                unwrapped = parenthesized.Expression;
            }

            if (unwrapped is not IdentifierNameSyntax
                || this.context.GetSymbolInfo(unwrapped).Symbol is not
                    (ILocalSymbol or IParameterSymbol)
                || this.GetDeclaredValueType(unwrapped) is not { } declaredType
                || !declaredType.IsReferenceType
                || declaredType.NullableAnnotation != NullableAnnotation.Annotated
                || !this.IsGSharpFlowNarrowedLocal(unwrapped))
            {
                return false;
            }

            ForEachStatementSyntax forEach = unwrapped.Ancestors()
                .OfType<ForEachStatementSyntax>()
                .FirstOrDefault(loop => loop.Expression.Span.Contains(unwrapped.Span));
            SyntaxNode body = this.state.CurrentBodyScope
                ?? unwrapped.Ancestors().FirstOrDefault(node =>
                    node is BaseMethodDeclarationSyntax
                        or AccessorDeclarationSyntax
                        or LocalFunctionStatementSyntax);

            // G# iterator lowering needs the local smart-cast made explicit at
            // the foreach source so the generated generic enumerator stays typed.
            return forEach != null
                && body?.DescendantNodes().OfType<YieldStatementSyntax>().Any() == true;
        }

        // ADR-0160: true when `recv` names a local whose declaration initializer is a
        // C# `as` expression, so the local's G# type is `T?`. See the dereference
        // assertion in <see cref="TranslateReceiverWithNullForgiveness"/>. A local
        // the C# code itself null-tests is already reported maybe-null by Roslyn and
        // handled by the ordinary forgiveness predicates; this covers the oblivious
        // shape those cannot see.
        private bool IsLocalBoundFromAsExpression(ExpressionSyntax recv)
        {
            if (recv is not IdentifierNameSyntax identifier
                || this.context.GetSymbolInfo(identifier).Symbol is not ILocalSymbol local)
            {
                return false;
            }

            if (local.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
                is not VariableDeclaratorSyntax { Initializer.Value: { } initializer })
            {
                return false;
            }

            while (initializer is ParenthesizedExpressionSyntax parenthesized)
            {
                initializer = parenthesized.Expression;
            }

            return initializer.IsKind(SyntaxKind.AsExpression);
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
        private static bool IsBareNumericLiteral(GExpression expr) =>
            expr is LiteralExpression { Kind: LiteralKind.Int or LiteralKind.Float }
            || (expr is UnaryExpression u && IsBareNumericLiteral(u.Operand));

        private static GExpression ParenthesizeIfBareNumericLiteral(GExpression expr) =>
            IsBareNumericLiteral(expr) ? new ParenthesizedExpression(expr) : expr;

        // Issue #3638: a synthetic member access (e.g. an appended `.ToString()`)
        // binds tighter than any binary/unary/if operator, so a non-atomic
        // receiver must be parenthesized or the access silently lands on the
        // receiver's last operand (`i + 1.ToString()` instead of
        // `(i + 1).ToString()`). Same predicate as CoerceConcatOperand's
        // receiver guard, plus prefix unaries (whose numeric-tail case
        // IsBareNumericLiteral already covered).
        private static GExpression ParenthesizeForSyntheticMemberAccess(GExpression expr) =>
            expr is BinaryExpression or IfExpression or UnaryExpression || IsBareNumericLiteral(expr)
                ? new ParenthesizedExpression(expr)
                : expr;

        /// <summary>
        /// True when a member-/element-access <paramref name="recv"/> receiver is a
        /// nullable-reference <em>field</em> or <em>property</em> (declared <c>T?</c>
        /// or promoted to nullable, issue #1072) and therefore always needs a G#
        /// <c>!!</c> assertion — independent of Roslyn flow state.
        /// </summary>
        /// <remarks>
        /// Unlike a local variable, G#'s Kotlin-style smart-casts never narrow a
        /// property/field-access chain, so <c>field.Member</c> / <c>field[i]</c> on a
        /// <c>T?</c> field is rejected (GS0158/GS0116) no matter what null-guard
        /// precedes it. The Oahu corpus compiles nullable-<em>disabled</em>, so
        /// Roslyn's flow analysis reports these receivers as oblivious (never
        /// flow-state <c>NotNull</c>) and the flow-driven
        /// <see cref="ReceiverNeedsNullForgiveness"/> pass leaves them bare.
        /// Asserting <c>field!!.Member</c> both compiles and preserves C#'s
        /// throw-on-null semantics for the same access (a null field would
        /// <c>NullReferenceException</c> in C# too). Locals/parameters keep the
        /// flow-proven path, since G# does smart-cast them; comparison operands and
        /// <c>?.</c> receivers are routed elsewhere and never reach this pass.
        /// </remarks>
        private bool ReceiverIsNullableReferenceFieldOrProperty(ExpressionSyntax recv)
        {
            if (recv is PostfixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression }
                or ThisExpressionSyntax
                or BaseExpressionSyntax
                or LiteralExpressionSyntax
                or ConditionalAccessExpressionSyntax)
            {
                return false;
            }

            ISymbol symbol = this.context.GetSymbolInfo(recv).Symbol;

            // Issue #4356: in ADR-0169 analyzer mode the read is retargeted
            // onto the G# analyzer API, whose counterpart of some Roslyn
            // members is declared `T?` although Roslyn's is non-null — often a
            // SyntaxToken STRUCT, which the reference-type test below would
            // reject outright. The C# type cannot say so, so ask the map.
            if (this.IsGSharpNullableAnalyzerExpression(recv))
            {
                return true;
            }

            // Issue #2113: in a nullable-OBLIVIOUS compilation the whole-program
            // taint analysis may promote a LOCAL or PARAMETER receiver to `T?`.
            // gsc smart-casts locals only after a flow-proven guard (inert under
            // oblivious metadata), so an unguarded `x.Member` / `x[i]` / `for … in
            // x` on such a receiver is rejected (GS0158/GS0116). Assert `x!!` to
            // both compile and preserve C#'s throw-on-null semantics for the same
            // access. Gated to oblivious so nullable-enabled projects (whose
            // locals gsc DOES smart-cast) keep their flow-driven path untouched.
            if (this.IsObliviousCompilation()
                && symbol is ILocalSymbol or IParameterSymbol
                && this.ShouldPromoteToNullableReference(symbol))
            {
                return true;
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
            if (this.IsImportedObliviousNullableMember(symbol)
                || this.LocalInitializedFromImportedObliviousNullable(symbol))
            {
                return true;
            }

            ITypeSymbol declared = symbol switch
            {
                IPropertySymbol property => property.Type,
                IFieldSymbol field => field.Type,
                _ => null,
            };

            if (declared is not { IsReferenceType: true })
            {
                return false;
            }

            return declared.NullableAnnotation == NullableAnnotation.Annotated
                || this.ShouldPromoteToNullableReference(symbol);
        }

        /// <summary>
        /// Issue #4356: whether <paramref name="symbol"/> is a Roslyn property or
        /// field that ADR-0169 analyzer mode retargets onto a G# analyzer-API
        /// member declared <c>T?</c>, although Roslyn declares it non-null
        /// (see <c>RoslynAnalyzerApiMap.IsGSharpNullableMember</c>). The C#
        /// symbol's own nullability cannot say so — for a <c>SyntaxToken</c>
        /// it is a struct — so the forgiveness predicates ask here.
        /// <para>
        /// For a LOCAL the answer is what cs2gs recorded when it emitted the
        /// local (<c>DocumentTranslationState.EmittedLocalGSharpNullability</c>),
        /// never a walk over Roslyn declarator syntax. A local with no record —
        /// a binding shape that is not hooked — is nullable when its Roslyn
        /// type could be <c>T?</c> on the G# side, so a miss is a redundant
        /// <c>!!</c> (legal; the polish pass strips GS0536), never a bare
        /// dereference of a <c>T?</c>. This is the one place every forgiveness
        /// and expression-tree predicate asks.
        /// </para>
        /// </summary>
        /// <param name="symbol">The bound C# symbol of the read.</param>
        /// <returns>True when the translated read is <c>T?</c> in G#.</returns>
        private bool IsGSharpNullableAnalyzerApiMember(ISymbol symbol)
        {
            if (!this.InAnalyzerApiMode)
            {
                return false;
            }

            if (symbol is IPropertySymbol or IFieldSymbol)
            {
                return Analyzers.RoslynAnalyzerApiMap.IsGSharpNullableMember(
                    RoslynTypeMetadataName(symbol.OriginalDefinition.ContainingType),
                    symbol.Name);
            }

            if (symbol is not ILocalSymbol local)
            {
                return false;
            }

            if (this.state.EmittedLocalGSharpNullability.TryGetValue(local, out bool recorded))
            {
                return recorded;
            }

            return Analyzers.RoslynAnalyzerApiMap.IsGSharpNullableCapableType(
                RoslynTypeMetadataName(local.Type as INamedTypeSymbol));
        }

        /// <summary>
        /// Issue #4356: records whether a local cs2gs just emitted is <c>T?</c> in
        /// G# because of the analyzer map, per
        /// <see cref="IsGSharpNullableAnalyzerApiMember"/>. With an emitted type
        /// clause it is not (the clause is the Roslyn type); without one, G#
        /// infers the local from the emitted initializer, which is <c>T?</c>
        /// exactly when the initializer's emitted type is (never after a <c>!!</c>).
        /// </summary>
        /// <param name="local">The local's symbol.</param>
        /// <param name="emittedType">The emitted type clause, if any.</param>
        /// <param name="initializerSyntax">The C# initializer, if any.</param>
        /// <param name="emittedInitializer">The emitted initializer, if any.</param>
        private void RecordEmittedLocalNullability(
            ILocalSymbol local,
            GTypeReference emittedType,
            ExpressionSyntax initializerSyntax,
            GExpression emittedInitializer)
        {
            if (!this.InAnalyzerApiMode || local == null)
            {
                return;
            }

            // A type clause comes from the Roslyn type (plus the ordinary
            // nullable promotions, which the ordinary predicates already see),
            // so no analyzer-map nullability hides behind it.
            this.state.EmittedLocalGSharpNullability[local] = emittedType == null
                && emittedInitializer is not NonNullAssertionExpression
                && this.IsGSharpNullableAnalyzerExpression(initializerSyntax);
        }

        /// <summary>
        /// Issue #4356: whether <paramref name="expression"/>'s EMITTED G# type is
        /// <c>T?</c> because of the ADR-0169 analyzer map, although its Roslyn
        /// type is non-null. This is the one classifier for that question: a
        /// mapped member read, a local (its recorded emitted nullability, see
        /// IsGSharpNullableAnalyzerApiMember), and the value-preserving shapes
        /// that carry one through —
        /// parentheses, a conditional (either arm), <c>??</c> (its fallback), a
        /// switch expression (any arm) and an assignment (its value). Every
        /// forgiveness, static-non-null and expression-tree check asks it, and
        /// a local's provenance is this same question asked of its initializer,
        /// so the direct read, an inferred local and a composed initializer
        /// cannot disagree. A null-forgiving <c>x!</c> is non-null.
        /// </summary>
        /// <param name="expression">The C# expression.</param>
        /// <returns>True when the emitted G# type is nullable per the analyzer map.</returns>
        private bool IsGSharpNullableAnalyzerExpression(ExpressionSyntax expression)
        {
            if (!this.InAnalyzerApiMode || expression == null)
            {
                return false;
            }

            switch (expression)
            {
                case ParenthesizedExpressionSyntax parenthesized:
                    return this.IsGSharpNullableAnalyzerExpression(parenthesized.Expression);

                case PostfixUnaryExpressionSyntax suppression
                    when suppression.IsKind(SyntaxKind.SuppressNullableWarningExpression):
                    return false;

                case ConditionalExpressionSyntax conditional:
                    return this.IsGSharpNullableAnalyzerExpression(conditional.WhenTrue)
                        || this.IsGSharpNullableAnalyzerExpression(conditional.WhenFalse);

                case BinaryExpressionSyntax coalesce when coalesce.IsKind(SyntaxKind.CoalesceExpression):
                    return this.IsGSharpNullableAnalyzerExpression(coalesce.Right);

                case SwitchExpressionSyntax switchExpression:
                    foreach (SwitchExpressionArmSyntax arm in switchExpression.Arms)
                    {
                        if (this.IsGSharpNullableAnalyzerExpression(arm.Expression))
                        {
                            return true;
                        }
                    }

                    return false;

                case AssignmentExpressionSyntax assignment when assignment.IsKind(SyntaxKind.SimpleAssignmentExpression):
                    return this.IsGSharpNullableAnalyzerExpression(assignment.Right);

                default:
                    return this.IsGSharpNullableAnalyzerApiMember(this.context.GetSymbolInfo(expression).Symbol);
            }
        }

        // Issue #2113: true for a nullable-oblivious compilation
        // (NullableContextOptions.Disable) — the only mode in which the
        // whole-program taint analysis runs and its declaration/receiver
        // adjustments apply. A nullable-enabled compilation is byte-identical to
        // pre-#2113 behavior.
        private bool IsObliviousCompilation() =>
            this.context.Compilation.Options.NullableContextOptions == NullableContextOptions.Disable;

        // True when <paramref name="symbol"/> is a method/property/field imported
        // from another project or metadata assembly and its concrete reference
        // return/type is oblivious. Same-compilation source symbols stay on the
        // whole-program taint path; imported source and metadata contracts are
        // already fixed. The value may be nil. For CLR metadata no project in
        // this run emits, gsc reads it as the platform type `T!` (ADR-0186
        // step 3), which needs no `!!`; see ReadsPlatformTypedImport.
        private bool IsImportedObliviousNullableMember(ISymbol symbol)
        {
            if (symbol is not (IMethodSymbol or IPropertySymbol or IFieldSymbol))
            {
                return false;
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
            ISymbol original = symbol.OriginalDefinition;
            ITypeSymbol type = original switch
            {
                IMethodSymbol m => m.ReturnType,
                IPropertySymbol p => p.Type,
                IFieldSymbol f => f.Type,
                _ => null,
            };

            return !SymbolEqualityComparer.Default.Equals(
                    original.ContainingAssembly,
                    this.context.Compilation.Assembly)
                && type is { IsReferenceType: true }
                and not ITypeParameterSymbol
                && type.NullableAnnotation == NullableAnnotation.None;
        }

        // Issue #2113 follow-up: true when <paramref name="symbol"/> is a `let`
        // local whose type is inferred from an initializer that reads an imported
        // oblivious member (e.g. `let coll = searcher.Get()`). gsc infers
        // such a local as `T?`, so a `coll.Member` / `for … in coll` use needs a
        // `!!` — but promoting the local's DECLARATION to `T?` cascades
        // nullable-conversion errors at its other (non-null) uses, so the
        // assertion is applied only here at the receiver/foreach-source use site.
        private bool LocalInitializedFromImportedObliviousNullable(ISymbol symbol)
        {
            if (symbol is not ILocalSymbol local)
            {
                return false;
            }

            foreach (SyntaxReference reference in local.DeclaringSyntaxReferences)
            {
                if (reference.GetSyntax() is VariableDeclaratorSyntax { Initializer.Value: { } initializer }
                    && this.IsImportedObliviousNullableMember(
                        this.context.GetSymbolInfo(initializer).Symbol))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// ADR-0186 step 6 (PR 0): whether <paramref name="expression"/> reads a
        /// value whose G# type is the platform type <c>T!</c> because it comes
        /// from oblivious CLR METADATA that no project in this migration run
        /// emits — a member for which <see cref="IsImportedObliviousNullableMember"/>
        /// holds and whose contract is frozen
        /// (<see cref="TargetContractIsFrozenInMetadata"/>), or an element read
        /// through such a member (ADR-0186 §3 rule 5: member access through a
        /// <c>C[T!]</c> yields <c>T!</c>).
        /// <para>
        /// Since ADR-0186 step 3 gsc reads such a position as <c>T!</c>, not
        /// <c>T?</c>, and inserts the nil check itself wherever the value is
        /// coerced to a non-null reference — receivers included (§4). A
        /// <c>!!</c> on it is therefore legal but only duplicates that check,
        /// and the polish pass never strips it (GS0536 does not fire on a
        /// <c>T!</c> operand). The forgiveness sites ask this to leave such a
        /// read bare. The question "may this value be nil" still answers yes:
        /// <see cref="NullableReferenceValueMayBeNull"/> and
        /// <see cref="IsImportedObliviousNullableMember"/> are unchanged, because
        /// their other callers (a <c>??=</c> result, a conditional index) must
        /// keep treating the value as nilable.
        /// </para>
        /// <para>
        /// A member declared in a project this run migrates is excluded: cs2gs
        /// decides that declaration's emitted type, which is <c>T</c> or a
        /// promoted <c>T?</c>, never <c>T!</c>. So is a local initialized from
        /// such a read: cs2gs can give the local a type clause, and a
        /// promoted one is <c>T?</c>.
        /// </para>
        /// </summary>
        /// <param name="expression">The C# expression.</param>
        /// <returns>True when the translated read has a platform type in G#.</returns>
        private bool ReadsPlatformTypedImport(ExpressionSyntax expression)
        {
            while (expression is ParenthesizedExpressionSyntax parenthesized)
            {
                expression = parenthesized.Expression;
            }

            if (expression == null)
            {
                return false;
            }

            // A container (an array, or a constructed type with a reference
            // argument) keeps its `!!`. gsc reads an oblivious container's
            // nested positions as `T!` too, and on such a value the top-level
            // `!!` also decides whether it converts to an enabled container:
            // `File.ReadAllLines(path)` is `[]!string!` and does not convert to
            // `[]string`, while `File.ReadAllLines(path)!!` does (the
            // netstandard2.0 Gsharp.NET.Sdk, #4449). Only a value whose type
            // has no nested reference position is left bare.
            if (HasNestedReferencePosition(this.context.GetTypeInfo(expression).Type))
            {
                return false;
            }

            if (expression is ElementAccessExpressionSyntax elementAccess
                && elementAccess.Expression is not ConditionalAccessExpressionSyntax
                && this.IsFrozenObliviousImportMember(this.context.GetSymbolInfo(elementAccess.Expression).Symbol)
                && this.context.GetTypeInfo(expression).Type is { IsReferenceType: true } elementType
                && elementType.NullableAnnotation == NullableAnnotation.None)
            {
                return true;
            }

            return this.IsFrozenObliviousImportMember(this.context.GetSymbolInfo(expression).Symbol);
        }

        // Whether a value of <paramref name="type"/> carries a reference
        // position below its top level: an array (its element), or a
        // constructed type with a reference or type-parameter argument,
        // including one nested inside a value-type argument (a tuple).
        private static bool HasNestedReferencePosition(ITypeSymbol type)
        {
            if (type is IArrayTypeSymbol)
            {
                return true;
            }

            if (type is not INamedTypeSymbol named)
            {
                return false;
            }

            for (INamedTypeSymbol current = named; current != null; current = current.ContainingType)
            {
                foreach (ITypeSymbol argument in current.TypeArguments)
                {
                    if (argument.IsReferenceType
                        || argument is ITypeParameterSymbol
                        || HasNestedReferencePosition(argument))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        private bool IsFrozenObliviousImportMember(ISymbol symbol) =>
            this.IsImportedObliviousNullableMember(symbol)
            && this.TargetContractIsFrozenInMetadata(symbol);

        /// <summary>
        /// ADR-0186 step 6 (PR 0): whether a forgiveness site may leave
        /// <paramref name="value"/> (a receiver or a value) without the
        /// <c>!!</c> it would otherwise emit: it reads a platform-typed import
        /// (<see cref="ReadsPlatformTypedImport"/>) and its top-level
        /// platform-ness cannot reach type inference.
        /// <para>
        /// Inference is the one place a bare <c>T!</c> and <c>T!!</c> differ at
        /// compile time. A <c>T!</c> argument infers <c>T!</c> for a method type
        /// parameter, a lambda result infers it for the lambda, an element
        /// infers it for an implicitly-typed array, and a receiver infers it
        /// for an extension declared <c>this T</c>. A container built from that
        /// (<c>List[string!]</c>) then cannot be stored where an enabled
        /// declaration says <c>List[string]</c> (§3 rule 3). Those positions keep
        /// today's <c>!!</c>, which pins the inferred type to <c>T</c>. An
        /// ordinary receiver never reaches inference: §5 types the member access
        /// as it would for <c>T</c>.
        /// </para>
        /// </summary>
        /// <param name="value">The C# receiver or value expression.</param>
        /// <returns>True when the expression needs no <c>!!</c> bridge.</returns>
        private bool PlatformTypedImportNeedsNoBridge(ExpressionSyntax value) =>
            this.ReadsPlatformTypedImport(value) && !this.ValueFeedsTypeInference(value);

        // The outermost expression whose value is `value` passed through
        // unchanged: parentheses, a conditional or switch arm, and `??`.
        private static SyntaxNode SkipValuePreservingParents(SyntaxNode value)
        {
            SyntaxNode node = value;
            while (node.Parent is ParenthesizedExpressionSyntax
                or ConditionalExpressionSyntax
                or SwitchExpressionArmSyntax
                or SwitchExpressionSyntax
                || (node.Parent is BinaryExpressionSyntax coalesce && coalesce.IsKind(SyntaxKind.CoalesceExpression)))
            {
                node = node.Parent;
            }

            return node;
        }

        private bool ValueFeedsTypeInference(ExpressionSyntax value)
        {
            SyntaxNode node = SkipValuePreservingParents(value);
            switch (node.Parent)
            {
                // An argument to a parameter whose type mentions a method type
                // parameter the call infers. Explicit type arguments
                // (`Keep<string?>(x)`) leave nothing to infer. An argument
                // nothing binds (a dynamic call) is treated as inferring.
                case ArgumentSyntax argument:
                    if (argument.Parent?.Parent is InvocationExpressionSyntax { Expression: { } callee }
                        && HasExplicitTypeArguments(callee))
                    {
                        return false;
                    }

                    IParameterSymbol parameter = (this.context.SemanticModel.GetOperation(argument) as IArgumentOperation)?.Parameter;
                    return parameter == null
                        || (parameter.ContainingSymbol is IMethodSymbol { IsGenericMethod: true }
                            && MentionsMethodTypeParameter(parameter.OriginalDefinition.Type));

                // A lambda result, when the lambda's own type is inferred and
                // so may be inferred from the result: the lambda is itself an
                // inference position (`xs.Select(x => ext.Name)`, or `var f =
                // () => ext.Name`). A lambda converted to a fixed delegate
                // type (`Func<string?> f = …`, or an oblivious `Reader` whose
                // Invoke returns `T!`) is not: its result converts to that
                // declared return, checked by gsc where it is non-null, and a
                // `!!` would throw on a nil the C# returns.
                case AnonymousFunctionExpressionSyntax lambda:
                    return this.LambdaTypeIsInferred(lambda);
                case ReturnStatementSyntax when node.Parent.FirstAncestorOrSelf<SyntaxNode>(
                        n => n is AnonymousFunctionExpressionSyntax or BaseMethodDeclarationSyntax
                            or LocalFunctionStatementSyntax or AccessorDeclarationSyntax) is AnonymousFunctionExpressionSyntax enclosingLambda:
                    return this.LambdaTypeIsInferred(enclosingLambda);

                // The receiver of a generic extension whose `this` parameter is
                // the method type parameter itself (`x.Also(...)` with
                // `Also<T>(this T self)`), which infers `T!` from it.
                case MemberAccessExpressionSyntax memberAccess when memberAccess.Expression == node:
                    return !HasExplicitTypeArguments(memberAccess)
                        && this.context.GetSymbolInfo(memberAccess).Symbol is IMethodSymbol { ReducedFrom: { } unreduced }
                        && unreduced.Parameters.Length > 0
                        && unreduced.Parameters[0].Type is ITypeParameterSymbol receiverParameter
                        && receiverParameter.TypeParameterKind == TypeParameterKind.Method;

                // The initializer of a local. A `var` local takes its type from
                // it, and so does an explicitly typed one whenever cs2gs drops
                // the redundant type clause (issue #1737, `let name = n.Name`).
                // Without the `!!` the local is `T!`, and every later use of
                // it (`Wrap(name)`) would infer from `T!` in turn. A local
                // whose emitted type is nullable keeps its type clause, so its
                // initializer converts to `T?` with no inference and no check.
                case EqualsValueClauseSyntax clause when LocalDeclarationOf(clause) != null:
                    return !this.LocalKeepsNullableTypeClause(clause);

                // An element whose array or collection type is inferred from it.
                case InitializerExpressionSyntax { Parent: ImplicitArrayCreationExpressionSyntax }:
                case CollectionElementSyntax:
                    return true;

                default:
                    return false;
            }
        }

        // ADR-0186 step 6 (PR 0): whether the local <paramref name="clause"/>
        // initializes is emitted with a nullable type (`T?`): declared `T?` in
        // C#, or promoted by cs2gs. Such a local keeps its type clause.
        private bool LocalKeepsNullableTypeClause(EqualsValueClauseSyntax clause)
        {
            if (clause.Parent is not VariableDeclaratorSyntax declarator
                || LocalDeclarationOf(clause) is not { } declaration
                || declaration.Type.IsVar
                || this.context.GetDeclaredSymbol(declarator) is not ILocalSymbol local)
            {
                return false;
            }

            return IsAnnotatedNullableReference(local.Type)
                || this.ShouldPromoteToNullableReference(local);
        }

        // The local declaration whose initializer is <paramref name="clause"/>,
        // or null when it initializes something else (a field, a property, a
        // parameter default). Written as plain type tests: cs2gs translates
        // itself, and a nested property pattern here would spill.
        private static VariableDeclarationSyntax LocalDeclarationOf(EqualsValueClauseSyntax clause)
        {
            if (clause.Parent is not VariableDeclaratorSyntax declarator
                || declarator.Parent is not VariableDeclarationSyntax declaration
                || declaration.Parent is not LocalDeclarationStatementSyntax)
            {
                return null;
            }

            return declaration;
        }

        // ADR-0186 step 6 (PR 0): whether a lambda's delegate type is inferred
        // rather than fixed by its target. A lambda initializing a `var` local
        // takes its natural type from its body; any other lambda is inferred
        // exactly when it sits in an inference position itself.
        private bool LambdaTypeIsInferred(AnonymousFunctionExpressionSyntax lambda)
        {
            // The same walk ValueFeedsTypeInference makes, so a lambda inside
            // a conditional (`Reader read = flag ? (() => n.Name) : …`) reaches
            // the local's declared type here and is not mistaken for an
            // inferred local.
            SyntaxNode node = SkipValuePreservingParents(lambda);

            if (node.Parent is EqualsValueClauseSyntax clause
                && LocalDeclarationOf(clause) is { } declaration)
            {
                return declaration.Type.IsVar;
            }

            return this.ValueFeedsTypeInference(lambda);
        }

        // True when <paramref name="member"/> binds to an extension method whose
        // (reduced) `this` parameter is nullable-annotated (`this T? x`) or was
        // promoted nullable by oblivious analysis. Such a method is designed to
        // accept a null receiver, so the translated call must keep that nullable
        // receiver rather than forgive it to non-null.
        private bool MemberBindsToNullableThisExtension(MemberAccessExpressionSyntax member)
        {
            if (this.context.GetSymbolInfo(member).Symbol is not IMethodSymbol method)
            {
                return false;
            }

            IMethodSymbol unreduced = method.ReducedFrom ?? method;
            if (!unreduced.IsExtensionMethod || unreduced.Parameters.Length == 0)
            {
                return false;
            }

            IParameterSymbol thisParameter = unreduced.Parameters[0];
            return thisParameter.Type.IsReferenceType
                ? thisParameter.NullableAnnotation == NullableAnnotation.Annotated
                    || this.ShouldPromoteToNullableReference(thisParameter)
                : thisParameter.Type.OriginalDefinition?.SpecialType == SpecialType.System_Nullable_T;
        }

        // Issue #1354: a value-position read (a `return` expression or a
        // conditional-expression arm) of a declared-`T?`/promoted-to-`T?` symbol
        // that Roslyn's flow analysis has narrowed to non-null may need a `!!`
        // assertion to satisfy a non-null target. G# smart-casts stable locals
        // under native guards, but property/field chains and other nullable
        // values still need the bridge.
        private GExpression TranslateValueWithNullForgiveness(ExpressionSyntax value)
        {
            GExpression translated = this.TranslateExpression(value);

            if (this.GSharpExpressionIsStaticallyNonNull(value, translated)
                || this.PlatformTypedImportNeedsNoBridge(value))
            {
                return translated;
            }

            (ITypeSymbol targetType, ISymbol targetSymbol) = this.FindContextualValueTarget(value);

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
            if (IsBranchArm(value)
                && (this.BranchResultAcceptsNil(value, out ExpressionSyntax branch)
                    || this.NullForgivingTargetAcceptsNil(targetType, targetSymbol)
                    || (targetSymbol is IParameterSymbol parameterTarget
                        && IsInferredGenericParameterTarget(parameterTarget, branch))))
            {
                return translated;
            }

            if (!this.IsPureForwardingPromotedTarget(targetSymbol)
                && !this.IsActivePatternBinding(value)
                && !this.LambdaResultFeedsNullableObservedInvocation(value)
                && this.ReceiverNeedsNullForgiveness(value))
            {
                return EnsureNonNullAssertion(translated);
            }

            return this.ForgiveNullableReferenceValue(value, translated, targetType, targetSymbol);
        }

        private bool IsActivePatternBinding(ExpressionSyntax expression)
        {
            while (expression is ParenthesizedExpressionSyntax parenthesized)
            {
                expression = parenthesized.Expression;
            }

            return this.context.GetSymbolInfo(expression).Symbol is { } symbol
                && (this.state.PatternBindings.ContainsKey(symbol)
                    || this.state.NativePatternVariables.Contains(symbol));
        }

        private GExpression ForgiveNullableReferenceValue(
            ExpressionSyntax value,
            GExpression translated,
            ITypeSymbol targetType,
            ISymbol targetSymbol,
            bool includePromotedValue = false)
        {
            // ADR-0186 step 6 (PR 0): a `T!` value flowing into a non-null
            // target is checked by gsc at that coercion (§4).
            if (this.GSharpExpressionIsStaticallyNonNull(value, translated)
                || this.PlatformTypedImportNeedsNoBridge(value))
            {
                return translated;
            }

            // Issue #4356: a value that is `T?` only on the G# analyzer API (a
            // mapped member, or a local recorded as such) flowing into a target
            // whose G# type is non-null. Roslyn cannot see the mismatch — for a
            // SyntaxToken it is a struct on both sides — so the checks below
            // would pass it through; assert it here. An inferred local takes the
            // value's own type, and a target that is itself `T?` in G# needs nothing.
            if (this.IsGSharpNullableAnalyzerExpression(value)
                && translated is not NonNullAssertionExpression
                && !IsInitializerOfInferredLocal(value, targetSymbol)
                && !this.IsGSharpNullableAnalyzerApiMember(targetSymbol)
                && this.AnalyzerBridgeTargetIsNonNull(targetType, targetSymbol, value))
            {
                return EnsureNonNullAssertion(translated);
            }

            if (value is ConditionalExpressionSyntax
                && translated is IfLetExpression or BlockExpression
                && this.context.GetTypeInfo(value).Nullability.FlowState == NullableFlowState.NotNull)
            {
                return translated;
            }

            ILocalSymbol valueLocal = this.context.GetSymbolInfo(value).Symbol as ILocalSymbol
                ?? GetReferencedLocal(this.context.SemanticModel.GetOperation(value));
            bool isFlowNarrowedLocal = valueLocal != null
                && (this.IsDominatedByNullCheckGuard(value, valueLocal)
                    || (!this.IsObliviousCompilation()
                        && this.context.GetTypeInfo(value).Nullability.FlowState == NullableFlowState.NotNull));
            if (translated is NonNullAssertionExpression
                || IsNullOrSuppressedNull(value)
                || value is PostfixUnaryExpressionSyntax
                    { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression }
                || targetSymbol is IFieldSymbol { IsConst: true } or ILocalSymbol { IsConst: true }
                || this.IsWithinExpressionTreeLambda(value)
                || IsInitializerOfInferredLocal(value, targetSymbol)
                || this.LambdaResultFeedsNullableObservedInvocation(value)
                || !this.TargetWillRemainNonNullableReference(targetType, targetSymbol))
            {
                return translated;
            }

            bool flowNarrowedAnnotatedValue =
                this.IsFlowNarrowedAnnotatedReference(value);
            bool flowRequiresAssertion = this.ReceiverNeedsNullForgiveness(value)
                || flowNarrowedAnnotatedValue;

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
            bool generatedPromotedValue = !isFlowNarrowedLocal
                && !this.IsObliviousCompilation()
                && this.IsGeneratedDeclarationPromotedValue(value);
            if (!flowRequiresAssertion
                && !this.NullableReferenceValueMayBeNull(value)
                    && !generatedPromotedValue
                    && !(includePromotedValue
                        && !isFlowNarrowedLocal
                        && this.IsObliviousCompilation()
                        && this.IsNullablePromotedValue(value)))
            {
                return translated;
            }

            GExpression operand = value is ConditionalExpressionSyntax
                or SwitchExpressionSyntax
                or ConditionalAccessExpressionSyntax
                    ? new ParenthesizedExpression(translated)
                    : translated;
            return EnsureNonNullAssertion(operand);
        }

        private bool IsInitializerOfInferredLocal(
            ExpressionSyntax value,
            ISymbol targetSymbol)
        {
            if (targetSymbol is not ILocalSymbol local
                || (!this.IsUsedAsNullable(local, this.GetNullabilityScope(local))
                    && !this.IsPassedToNullableParameter(local)))
            {
                return false;
            }

            return local.DeclaringSyntaxReferences.Any(reference =>
                reference.GetSyntax() is VariableDeclaratorSyntax declarator
                && declarator.Parent is VariableDeclarationSyntax { Type.IsVar: true }
                && declarator.Initializer?.Value is { } initializer
                && initializer.SyntaxTree == value.SyntaxTree
                && initializer.Span == value.Span);
        }

        private bool LambdaResultFeedsNullableObservedInvocation(ExpressionSyntax value)
        {
            if (this.FindResultLambda(value) is not { } lambda)
            {
                return false;
            }

            SyntaxNode node = lambda;
            while (node.Parent is ParenthesizedExpressionSyntax or CastExpressionSyntax)
            {
                node = node.Parent;
            }

            if (node.Parent is not ArgumentSyntax { Parent.Parent: InvocationExpressionSyntax invocation } argument)
            {
                return false;
            }

            SyntaxNode invocationValue = invocation;
            while (invocationValue.Parent is ParenthesizedExpressionSyntax or CastExpressionSyntax)
            {
                invocationValue = invocationValue.Parent;
            }

            if (invocationValue.Parent is ArgumentSyntax resultArgument
                && this.IsXunitNullAssertionArgument(resultArgument))
            {
                return true;
            }

            // Issue #4074: filtering the invocation's result says nothing about
            // an unrelated callback's fixed return contract (e.g. Func<string>).
            if (this.IsGenericSelectorResultArgument(argument, lambda)
                && (this.LambdaResultFeedsNullFilteringInvocation(invocation)
                    || (invocation.Expression is not GenericNameSyntax
                        and not MemberAccessExpressionSyntax { Name: GenericNameSyntax }
                        and not MemberBindingExpressionSyntax { Name: GenericNameSyntax }
                        && this.context.SemanticModel.GetNullableContext(value.SpanStart)
                            .HasFlag(NullableContext.AnnotationsEnabled)
                        && this.ReceiverValueIsObliviouslyReadAnnotatedResult(value))))
            {
                return true;
            }

            return this.ResolveValueSink(invocation) is ILocalSymbol result
                && (this.IsUsedAsNullable(result, this.GetNullabilityScope(result))
                    || this.IsPassedToNullableParameter(result));
        }

        private bool LambdaResultFeedsNullFilteringInvocation(
            InvocationExpressionSyntax selectorInvocation)
        {
            SyntaxNode node = selectorInvocation;
            while (node.Parent is ParenthesizedExpressionSyntax or CastExpressionSyntax)
            {
                node = node.Parent;
            }

            if (node.Parent is not MemberAccessExpressionSyntax { Expression: var receiver } member
                || receiver != node
                || member.Parent is not InvocationExpressionSyntax filteringInvocation
                || this.context.GetSymbolInfo(filteringInvocation).Symbol is not IMethodSymbol method)
            {
                return false;
            }

            IMethodSymbol originalMethod = method.ReducedFrom ?? method;
            INamedTypeSymbol containingType = originalMethod.ContainingType?.OriginalDefinition;
            if (!SymbolEqualityComparer.Default.Equals(
                    containingType,
                    this.context.Compilation.GetTypeByMetadataName("System.Linq.Enumerable"))
                && !SymbolEqualityComparer.Default.Equals(
                    containingType,
                    this.context.Compilation.GetTypeByMetadataName("System.Linq.Queryable")))
            {
                return false;
            }

            if (method.Name == "OfType")
            {
                return true;
            }

            if (method.Name is not ("Where" or "FirstOrDefault")
                || filteringInvocation.ArgumentList.Arguments.FirstOrDefault()?.Expression
                    is not AnonymousFunctionExpressionSyntax predicate)
            {
                return false;
            }

            ParameterSyntax parameter = predicate switch
            {
                SimpleLambdaExpressionSyntax simple => simple.Parameter,
                ParenthesizedLambdaExpressionSyntax { ParameterList.Parameters.Count: 1 } parenthesized =>
                    parenthesized.ParameterList.Parameters[0],
                _ => null,
            };
            ISymbol parameterSymbol = parameter == null
                ? null
                : this.context.SemanticModel.GetDeclaredSymbol(parameter);
            if (parameterSymbol == null)
            {
                return false;
            }

            return predicate.Body.DescendantNodesAndSelf()
                .OfType<ConditionalAccessExpressionSyntax>()
                .Any(access =>
                    this.BindsTo(access.Expression, parameterSymbol)
                    && (access.Parent is IsPatternExpressionSyntax
                        { Pattern: RecursivePatternSyntax }
                        || (access.Parent is BinaryExpressionSyntax comparison
                            && (comparison.IsKind(SyntaxKind.GreaterThanExpression)
                                || comparison.IsKind(SyntaxKind.GreaterThanOrEqualExpression)
                                || comparison.IsKind(SyntaxKind.LessThanExpression)
                                || comparison.IsKind(SyntaxKind.LessThanOrEqualExpression)))))
                || predicate.Body.DescendantNodesAndSelf()
                    .OfType<IsPatternExpressionSyntax>()
                    .Any(isPattern =>
                        this.BindsTo(isPattern.Expression, parameterSymbol)
                        && IsNullConstantPattern(isPattern.Pattern)
                        && isPattern.Pattern is UnaryPatternSyntax unary
                        && unary.IsKind(SyntaxKind.NotPattern))
                || predicate.Body.DescendantNodesAndSelf()
                    .OfType<BinaryExpressionSyntax>()
                    .Any(binary =>
                        binary.IsKind(SyntaxKind.NotEqualsExpression)
                        && ((binary.Left.IsKind(SyntaxKind.NullLiteralExpression)
                             && this.BindsTo(binary.Right, parameterSymbol))
                            || (binary.Right.IsKind(SyntaxKind.NullLiteralExpression)
                                && this.BindsTo(binary.Left, parameterSymbol))));
        }

        private bool IsPassedToNullableParameter(ILocalSymbol local)
        {
            SyntaxNode scope = this.GetNullabilityScope(local);
            return scope != null
                && scope.DescendantNodes(node =>
                    node is not (LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax))
                .OfType<ArgumentSyntax>()
                .Any(argument =>
                    this.BindsTo(argument.Expression, local)
                    && (this.IsXunitNullAssertionArgument(argument)
                        || (this.context.SemanticModel.GetOperation(argument)
                            is IArgumentOperation { Parameter.Type: { } parameterType }
                            && (parameterType.NullableAnnotation == NullableAnnotation.Annotated
                                || parameterType.OriginalDefinition?.SpecialType
                                    == SpecialType.System_Nullable_T))));
        }

        private GExpression AssertFlowNarrowedNullableReference(
            ExpressionSyntax value,
            GExpression translated,
            GTypeReference targetType)
        {
            ITypeSymbol declaredValueType = this.GetDeclaredValueType(value);
            if (!this.GSharpExpressionIsStaticallyNonNull(value, translated)
                && targetType is { IsNullable: false }
                && declaredValueType?.IsReferenceType == true
                && declaredValueType.NullableAnnotation == NullableAnnotation.Annotated
                && this.context.GetTypeInfo(value).Nullability.FlowState == NullableFlowState.NotNull)
            {
                return EnsureNonNullAssertion(translated);
            }

            return translated;
        }

        private static GExpression EnsureNonNullAssertion(GExpression expression) =>
            TranslatedExpressionIsStaticallyNonNull(expression)
                ? expression
                : new NonNullAssertionExpression(expression);

        private bool GSharpExpressionIsStaticallyNonNull(
            ExpressionSyntax expression,
            GExpression translated = null)
        {
            if (translated != null && TranslatedExpressionIsStaticallyNonNull(translated))
            {
                return true;
            }

            // Issue #4356: a Roslyn member that is non-null in C# — even a
            // SyntaxToken struct — but `T?` on the G# analyzer API it is
            // retargeted onto is never statically non-null in the output, nor
            // is a local whose emitted G# type is `T?` because of one. Asked
            // before the pattern-binding shortcuts: `x is var t` binds `t` at
            // the scrutinee's G# type, which a `var` pattern does not narrow.
            if (this.IsGSharpNullableAnalyzerExpression(expression))
            {
                return false;
            }

            if (this.PatternLocalUsesNullableStorage(expression))
            {
                return false;
            }

            if (this.IsActivePatternBinding(expression)
                || this.IsGSharpFlowNarrowedLocal(expression)
                || this.IsGuardCapturedFieldRead(expression))
            {
                return true;
            }

            ExpressionSyntax unwrapped = expression;
            while (unwrapped is ParenthesizedExpressionSyntax parenthesized)
            {
                unwrapped = parenthesized.Expression;
            }

            switch (unwrapped)
            {
                case LiteralExpressionSyntax literal:
                    return !literal.IsKind(SyntaxKind.NullLiteralExpression)
                        && !literal.IsKind(SyntaxKind.DefaultLiteralExpression);

                case ObjectCreationExpressionSyntax:
                case ImplicitObjectCreationExpressionSyntax:
                case ArrayCreationExpressionSyntax:
                case ImplicitArrayCreationExpressionSyntax:
                case AnonymousObjectCreationExpressionSyntax:
                case InterpolatedStringExpressionSyntax:
                case TypeOfExpressionSyntax:
                case ThrowExpressionSyntax:
                    return true;

                case PostfixUnaryExpressionSyntax suppression
                    when suppression.IsKind(SyntaxKind.SuppressNullableWarningExpression):
                    return !IsNullOrSuppressedNull(suppression.Operand);

                case BinaryExpressionSyntax concatenation
                    when concatenation.IsKind(SyntaxKind.AddExpression)
                        && this.context.GetTypeInfo(concatenation).Type?.SpecialType
                            == SpecialType.System_String:
                    return true;

                case CastExpressionSyntax cast
                    when cast.Type is not NullableTypeSyntax
                        && this.CastUsesCheckedReferenceConversion(cast):
                    // Issue #3843: EVERY checked reference cast now lowers to
                    // `cast[T](expr)`, whose static result is non-nullable `T`
                    // regardless of the operand's nullability — exactly as C#
                    // `(T)x` is statically `T`. (Both languages let a nil slip
                    // through that non-nullable static type; that is the
                    // shared, documented ADR-0167 behaviour, not a G#-only
                    // hole.)
                    return true;

                case ConditionalExpressionSyntax conditional:
                    GExpression conditionalValue = UnwrapTranslatedValue(translated);
                    if (conditionalValue is IfExpression ifExpression)
                    {
                        return this.GSharpExpressionIsStaticallyNonNull(
                                conditional.WhenTrue,
                                ifExpression.ThenExpression)
                            && this.GSharpExpressionIsStaticallyNonNull(
                                conditional.WhenFalse,
                                ifExpression.ElseExpression);
                    }

                    if (conditionalValue is IfLetExpression ifLet)
                    {
                        return this.GSharpExpressionIsStaticallyNonNull(
                                conditional.WhenTrue,
                                ifLet.ThenExpression)
                            && this.GSharpExpressionIsStaticallyNonNull(
                                conditional.WhenFalse,
                                ifLet.ElseExpression);
                    }

                    return this.GSharpExpressionIsStaticallyNonNull(conditional.WhenTrue)
                        && this.GSharpExpressionIsStaticallyNonNull(conditional.WhenFalse);

                case SwitchExpressionSyntax switchExpression:
                    if (UnwrapTranslatedValue(translated) is SwitchExpression translatedSwitch
                        && translatedSwitch.Arms.Count == switchExpression.Arms.Count)
                    {
                        return switchExpression.Arms
                            .Select((arm, index) => (arm, index))
                            .All(pair => this.GSharpExpressionIsStaticallyNonNull(
                                pair.arm.Expression,
                                translatedSwitch.Arms[pair.index].Body));
                    }

                    return switchExpression.Arms.All(arm =>
                        this.GSharpExpressionIsStaticallyNonNull(arm.Expression));

                case BinaryExpressionSyntax binary when binary.IsKind(SyntaxKind.CoalesceExpression):
                    return UnwrapTranslatedValue(translated) is BinaryExpression
                            { Operator: "??" } translatedBinary
                        ? this.GSharpExpressionIsStaticallyNonNull(
                            binary.Right,
                            translatedBinary.Right)
                        : this.GSharpExpressionIsStaticallyNonNull(binary.Right);

                case AssignmentExpressionSyntax assignment:
                    if (!this.AssignmentResultHasNonNullStaticType(assignment))
                    {
                        return false;
                    }

                    return UnwrapTranslatedValue(translated) is AssignmentExpression translatedAssignment
                        ? this.GSharpExpressionIsStaticallyNonNull(
                            assignment.Right,
                            translatedAssignment.Value)
                        : this.GSharpExpressionIsStaticallyNonNull(assignment.Right);

                case BinaryExpressionSyntax binary when binary.IsKind(SyntaxKind.AsExpression):
                case ConditionalAccessExpressionSyntax:
                    return false;

                case ElementAccessExpressionSyntax arrayElement
                    when this.context.GetSymbolInfo(arrayElement).Symbol is null
                        && this.context.GetTypeInfo(arrayElement.Expression).Type is IArrayTypeSymbol arrayType:
                    // Issue #3501: a C# array element read may be flow-proven
                    // non-null at this site (`items[i] != null && …items[i]…`),
                    // but G# never narrows an indexed read — only the DECLARED
                    // element nullability counts, so a `!` over a
                    // nullable-element read must keep its `!!`.
                    if (arrayType.ElementType is { IsValueType: true } valueElement)
                    {
                        return valueElement.OriginalDefinition?.SpecialType != SpecialType.System_Nullable_T;
                    }

                    return arrayType.ElementNullableAnnotation == NullableAnnotation.NotAnnotated;
            }

            ISymbol symbol = this.context.GetSymbolInfo(expression).Symbol;

            if (symbol is ILocalSymbol inferredLocal)
            {
                if (this.TryGetInferredLocalStaticNonNull(
                    inferredLocal,
                    out bool initializerIsNonNull))
                {
                    return initializerIsNonNull;
                }

                if (this.ForEachBindingInfersNonNullElement(inferredLocal))
                {
                    return true;
                }
            }

            ITypeSymbol type = symbol switch
            {
                IFieldSymbol field => field.Type,
                ILocalSymbol local => local.Type,
                IParameterSymbol parameter => parameter.Type,
                IPropertySymbol property => property.Type,
                IMethodSymbol method when method.MethodKind != MethodKind.Constructor => method.ReturnType,
                _ => this.context.GetTypeInfo(expression).Type,
            };

            if (type is { IsValueType: true })
            {
                return type.OriginalDefinition?.SpecialType != SpecialType.System_Nullable_T;
            }

            return type?.IsReferenceType == true
                && type.NullableAnnotation == NullableAnnotation.NotAnnotated
                && !this.IsImportedObliviousNullableMember(symbol)
                && !this.LocalInitializedFromImportedObliviousNullable(symbol)
                && (symbol == null || !this.ShouldPromoteToNullableReference(symbol));
        }

        private bool TryGetInferredLocalStaticNonNull(
            ILocalSymbol local,
            out bool isNonNull)
        {
            isNonNull = false;
            if (local.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
                    is not VariableDeclaratorSyntax
                    {
                        Initializer.Value: { } initializer,
                        Parent: VariableDeclarationSyntax declaration,
                    })
            {
                return false;
            }

            if (declaration.Type.IsVar)
            {
                if (this.ShouldPromoteToNullableReference(local)
                    || (IsAnnotatedNullableReference(local.Type)
                        && this.IsUsedAsNullable(local, this.GetNullabilityScope(local))))
                {
                    return false;
                }
            }
            else
            {
                ITypeSymbol naturalType = this.context.GetTypeInfo(initializer).Type;
                if (IsAnnotatedNullableReference(local.Type)
                    || naturalType == null
                    || !SymbolEqualityComparer.Default.Equals(local.Type, naturalType)
                    || this.ShouldPromoteToNullableReference(local))
                {
                    return false;
                }
            }

            isNonNull = this.GSharpExpressionIsStaticallyNonNull(initializer);
            return true;
        }

        private bool ForEachBindingInfersNonNullElement(ILocalSymbol local)
        {
            SyntaxNode body = this.state.CurrentBodyScope;

            // Iterator lowering preserves the source collection's nullable
            // element annotation, so yield seams handle their own proof here.
            if (body?.DescendantNodes().OfType<YieldStatementSyntax>().Any() == true)
            {
                return false;
            }

            foreach (SyntaxReference reference in local.DeclaringSyntaxReferences)
            {
                if (reference.GetSyntax() is not ForEachStatementSyntax forEach
                    || !SymbolEqualityComparer.Default.Equals(
                        this.context.GetDeclaredSymbol(forEach),
                        local))
                {
                    continue;
                }

                ITypeSymbol elementType = this.context.SemanticModel
                    .GetForEachStatementInfo(forEach)
                    .ElementType;
                return elementType is { IsValueType: true }
                    ? elementType.OriginalDefinition?.SpecialType
                        != SpecialType.System_Nullable_T
                    : elementType?.IsReferenceType == true
                        && elementType.NullableAnnotation == NullableAnnotation.NotAnnotated;
            }

            return false;
        }

        private bool PatternLocalUsesNullableStorage(ExpressionSyntax expression)
        {
            ISymbol symbol = this.context.GetSymbolInfo(expression).Symbol;
            if (symbol is not ILocalSymbol { Type.IsReferenceType: true } local)
            {
                return false;
            }

            if (this.state.HoistedNullableGuardLocals.Contains(local))
            {
                return true;
            }

            bool isPatternLocal = local.DeclaringSyntaxReferences.Any(reference =>
                reference.GetSyntax() is SingleVariableDesignationSyntax);
            SyntaxNode scope = this.state.CurrentBodyScope ?? expression.SyntaxTree.GetRoot();
            return isPatternLocal && this.IsSymbolReassigned(local, scope);
        }

        private static GExpression UnwrapTranslatedValue(GExpression expression)
        {
            while (expression is ParenthesizedExpression parenthesized)
            {
                expression = parenthesized.Inner;
            }

            return expression is BlockExpression block
                ? UnwrapTranslatedValue(block.Value)
                : expression;
        }

        // `cast[T](value)` has static type T while deliberately preserving a
        // CLR null value. Treat it as statically non-null so sink forgiveness
        // does not append `!!` and change that checked-cast runtime contract.
        private static bool TranslatedExpressionIsStaticallyNonNull(GExpression expression) =>
            expression switch
            {
                NonNullAssertionExpression => true,
                ConversionExpression conversion
                    when conversion.IsCheckedReferenceCast
                        && !conversion.TargetType.IsNullable => true,
                ParenthesizedExpression parenthesized =>
                    TranslatedExpressionIsStaticallyNonNull(parenthesized.Inner),
                BlockExpression block =>
                    TranslatedExpressionIsStaticallyNonNull(block.Value),
                IfExpression ifExpression =>
                    TranslatedExpressionIsStaticallyNonNull(ifExpression.ThenExpression)
                        && TranslatedExpressionIsStaticallyNonNull(ifExpression.ElseExpression),
                IfLetExpression ifLet =>
                    TranslatedExpressionIsStaticallyNonNull(ifLet.ThenExpression)
                        && TranslatedExpressionIsStaticallyNonNull(ifLet.ElseExpression),
                SwitchExpression switchExpression =>
                    switchExpression.Arms.Count > 0
                        && switchExpression.Arms.All(arm =>
                            TranslatedExpressionIsStaticallyNonNull(arm.Body)),
                BinaryExpression binary when binary.Operator == "??" =>
                    TranslatedExpressionIsStaticallyNonNull(binary.Right),
                _ => false,
            };

        private bool IsGSharpFlowNarrowedLocal(ExpressionSyntax expression)
        {
            while (expression is ParenthesizedExpressionSyntax parenthesized)
            {
                expression = parenthesized.Expression;
            }

            ISymbol symbol = this.context.GetSymbolInfo(expression).Symbol;
            if (expression is not IdentifierNameSyntax
                || symbol is not (ILocalSymbol or IParameterSymbol)
                || this.context.GetTypeInfo(expression).Nullability.FlowState != NullableFlowState.NotNull)
            {
                return false;
            }

            SyntaxNode scope = this.state.CurrentBodyScope
                ?? expression.Ancestors().FirstOrDefault(node =>
                    node is BaseMethodDeclarationSyntax
                        or AccessorDeclarationSyntax
                        or LocalFunctionStatementSyntax
                        or AnonymousFunctionExpressionSyntax);
            if (scope == null)
            {
                return false;
            }

            foreach (IsPatternExpressionSyntax isPattern in scope
                .DescendantNodes(node =>
                    node is not (LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax))
                .OfType<IsPatternExpressionSyntax>())
            {
                if (isPattern.SpanStart >= expression.SpanStart
                    || !this.BindsToGuardSymbol(isPattern.Expression, symbol)
                    || !IsNativelyExpressiblePattern(isPattern.Pattern, topLevel: true)
                    || !TryGetPatternNonNullPolarity(isPattern.Pattern, out bool whenTrue)
                    || !this.GSharpPatternPreservesNonNullNarrowing(isPattern, whenTrue)
                    || (PatternUsesNativeVariableSyntax(isPattern.Pattern)
                        && !this.ConditionUsesNativePatternVariables(GetConditionRoot(isPattern)))
                    || !ComputePatternFlowRegions(
                            isPattern,
                            whenTrue,
                            includeWhenClauseRegion: false)
                        .Any(region => region.Span.Contains(expression.Span))
                    || this.SymbolIsWrittenBetween(symbol, isPattern, expression, scope)
                    || this.HasLoopCarriedWrite(expression, symbol, scope, isPattern))
                {
                    continue;
                }

                return true;
            }

            foreach (BinaryExpressionSyntax nullCheck in scope
                .DescendantNodes(node =>
                    node is not (LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax))
                .OfType<BinaryExpressionSyntax>())
            {
                if (nullCheck.SpanStart >= expression.SpanStart
                    || !this.TryGetNullComparisonNonNullPolarity(
                        nullCheck,
                        symbol,
                        out bool whenTrue)
                    || !ComputeBooleanFlowRegions(
                            nullCheck,
                            whenTrue,
                            includeWhenClauseRegion: false)
                        .Any(region => region.Span.Contains(expression.Span))
                    || this.SymbolIsWrittenBetween(symbol, nullCheck, expression, scope)
                    || this.HasLoopCarriedWrite(expression, symbol, scope, nullCheck))
                {
                    continue;
                }

                return true;
            }

            return false;
        }

        /// <summary>
        /// Issue #4262 follow-up (cs2gs nullability investigation): gsc's own
        /// smart-cast narrowing DOES reach a field/property/member-access-chain
        /// receiver guarded by a null check combined via <c>&amp;&amp;</c>/<c>||</c>
        /// in the SAME boolean expression (<c>t.AccessToken != null &amp;&amp;
        /// t.AccessToken.M()</c>) — confirmed directly against the compiler,
        /// which is a strictly narrower claim than <see cref="IsGSharpFlowNarrowedLocal"/>
        /// makes for a bare local/parameter (that method's guard MAY also cross
        /// a statement boundary, because gsc's narrowing of a LOCAL does too).
        /// It does NOT reach one across a statement boundary (an <c>if</c>-body,
        /// an <c>else</c>, a ternary arm) for a field/property — that remains a
        /// genuine gsc limitation, and <see cref="IsNullGuardNarrowedFieldUse"/>
        /// exists BECAUSE of it: that rule detects exactly this class of guard
        /// and INSERTS `!!` (the opposite of this method), so the two are
        /// deliberately disjoint, not overlapping fallbacks.
        /// <para>
        /// Purely syntactic — not gated on Roslyn's flow state, unlike
        /// <see cref="IsGSharpFlowNarrowedLocal"/> — because it must also
        /// suppress the oblivious-analysis promoted-nullable / obliviously-
        /// annotated rules below (issues #2506, #3683), which fire on ANY
        /// dereference of such a property with no guard-awareness of their
        /// own; an oblivious file has no Roslyn flow state to gate on in the
        /// first place, exactly like <see cref="IsNullGuardNarrowedFieldUse"/>
        /// and <see cref="IsLazyInitGuardedFieldUse"/> are already syntactic
        /// for the same reason.
        /// </para>
        /// <para>
        /// PR #4277 review fix: gsc narrows a member path (see
        /// <c>AccessPath</c>/<c>SmartCastStability</c> in
        /// <c>src/Core/CodeAnalysis/Binding</c>) only when it is a STABLE
        /// path — the same root (a local/parameter or <c>this</c>) followed
        /// only by immutable links (a readonly field, or a get-only/init-only,
        /// non-virtual, non-override, non-static auto-property with no custom
        /// getter body) — and only when the guarded operand and the narrowed
        /// use denote the exact SAME path, not merely the same member symbol.
        /// Matching by symbol alone let <c>a.Foo != null &amp;&amp;
        /// b.Foo.Bar()</c> be (wrongly) treated as guarded because both
        /// accesses bind to the same property symbol, and let mutable
        /// fields/settable, computed, or overridable properties be (wrongly)
        /// treated as narrowable even though gsc excludes them — either case
        /// could drop a needed `!!` and miscompile with GS0158. The walk below
        /// now derives and compares the FULL stable access path via
        /// <see cref="IsSameStableAccessPath"/>.
        /// </para>
        /// </summary>
        private bool IsGSharpFlowNarrowedFieldOrPropertyInSameCondition(ExpressionSyntax expression)
        {
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
            for (SyntaxNode node = expression; node.Parent != null; node = node.Parent)
            {
                switch (node.Parent)
                {
                    case ParenthesizedExpressionSyntax:
                    case MemberAccessExpressionSyntax:
                    case InvocationExpressionSyntax:
                    case ElementAccessExpressionSyntax:
                    case PrefixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.LogicalNotExpression }:
                        continue;

                    case BinaryExpressionSyntax binary
                        when binary.IsKind(SyntaxKind.LogicalAndExpression) && binary.Right == node:
                    {
                        return this.TryGetNullCheckedOperand(binary.Left, nonNull: true, out ExpressionSyntax checkedOperand)
                            && this.IsSameStableAccessPath(expression, checkedOperand);
                    }

                    case BinaryExpressionSyntax binary
                        when binary.IsKind(SyntaxKind.LogicalOrExpression) && binary.Right == node:
                    {
                        return this.TryGetNullCheckedOperand(binary.Left, nonNull: false, out ExpressionSyntax checkedOperand)
                            && this.IsSameStableAccessPath(expression, checkedOperand);
                    }

                    default:
                        return false;
                }
            }

            return false;
        }

        // The syntactic counterpart of IsNullCheckOf/IsNonNullCheckOf, but
        // returning the checked EXPRESSION rather than testing it against a
        // known symbol — used by IsGSharpFlowNarrowedFieldOrPropertyInSameCondition,
        // which needs to compare the full receiver PATH (not just the leaf
        // symbol) of the guard's operand against a second expression.
        // `nonNull: true` matches `F != null` / `null != F` / `F is not null`;
        // `nonNull: false` matches `F == null` / `null == F` / `F is null`.
        private bool TryGetNullCheckedOperand(ExpressionSyntax condition, bool nonNull, out ExpressionSyntax operand)
        {
            condition = StripParentheses(condition);
            operand = null;

            switch (condition)
            {
                case BinaryExpressionSyntax binary
                    when binary.IsKind(nonNull ? SyntaxKind.NotEqualsExpression : SyntaxKind.EqualsExpression):
                    if (IsNullLiteral(binary.Right))
                    {
                        operand = binary.Left;
                        return true;
                    }

                    if (IsNullLiteral(binary.Left))
                    {
                        operand = binary.Right;
                        return true;
                    }

                    return false;

                case IsPatternExpressionSyntax isPattern
                    when IsNullConstantPattern(isPattern.Pattern)
                        && (isPattern.Pattern is UnaryPatternSyntax) == nonNull:
                    operand = isPattern.Expression;
                    return true;

                default:
                    return false;
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
        private bool IsSameStableAccessPath(ExpressionSyntax left, ExpressionSyntax right)
        {
            if (!this.TryDecomposeStableAccessPath(left, out bool leftIsThisRoot, out ISymbol leftRoot, out List<ISymbol> leftMembers, out List<ExpressionSyntax> leftReceiverCheckpoints)
                || leftMembers.Count == 0
                || !this.TryDecomposeStableAccessPath(right, out bool rightIsThisRoot, out ISymbol rightRoot, out List<ISymbol> rightMembers, out List<ExpressionSyntax> _))
            {
                return false;
            }

            if (leftIsThisRoot != rightIsThisRoot)
            {
                return false;
            }

            if (!leftIsThisRoot && !SymbolEqualityComparer.Default.Equals(leftRoot, rightRoot))
            {
                return false;
            }

            if (leftMembers.Count != rightMembers.Count)
            {
                return false;
            }

            for (int i = 0; i < leftMembers.Count; i++)
            {
                if (!SymbolEqualityComparer.Default.Equals(leftMembers[i], rightMembers[i]))
                {
                    return false;
                }
            }

            // Every receiver checkpoint along `left`'s chain (the root, and
            // every intermediate member access used as a receiver for the
            // next member) must NOT itself be emitted with a `!!` — see the
            // remark above. `this` checkpoints are never asserted and are
            // not added to this list by the decomposer.
            foreach (ExpressionSyntax checkpoint in leftReceiverCheckpoints)
            {
                if (this.ReceiverNeedsNullForgiveness(checkpoint, isDereferenceReceiver: true)
                    || this.ReceiverIsNullableReferenceFieldOrProperty(checkpoint)
                    || this.NullableReferenceValueMayBeNull(checkpoint))
                {
                    return false;
                }
            }

            return true;
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
        private bool TryDecomposeStableAccessPath(
            ExpressionSyntax expression,
            out bool isThisRoot,
            out ISymbol rootSymbol,
            out List<ISymbol> members,
            out List<ExpressionSyntax> receiverCheckpoints)
        {
            isThisRoot = false;
            rootSymbol = null;
            members = new List<ISymbol>();
            receiverCheckpoints = new List<ExpressionSyntax>();

            ExpressionSyntax current = StripParentheses(expression);
            while (true)
            {
                switch (current)
                {
                    case ThisExpressionSyntax:
                        isThisRoot = true;
                        return true;

                    case MemberAccessExpressionSyntax memberAccess
                        when memberAccess.IsKind(SyntaxKind.SimpleMemberAccessExpression):
                    {
                        ISymbol memberSymbol = this.context.GetSymbolInfo(memberAccess).Symbol;
                        if (!IsStableMemberSymbol(memberSymbol))
                        {
                            return false;
                        }

                        members.Insert(0, memberSymbol);
                        current = StripParentheses(memberAccess.Expression);
                        if (current is not ThisExpressionSyntax)
                        {
                            receiverCheckpoints.Add(current);
                        }

                        continue;
                    }

                    case IdentifierNameSyntax identifier:
                    {
                        ISymbol symbol = this.context.GetSymbolInfo(identifier).Symbol;
                        switch (symbol)
                        {
                            case ILocalSymbol or IParameterSymbol:
                                rootSymbol = symbol;
                                receiverCheckpoints.Add(identifier);
                                return true;

                            case IFieldSymbol or IPropertySymbol when IsStableMemberSymbol(symbol):
                                // A bare `Foo` reads an instance member through
                                // an implicit `this.` receiver.
                                members.Insert(0, symbol);
                                isThisRoot = true;
                                return true;

                            default:
                                return false;
                        }
                    }

                    default:
                        return false;
                }
            }
        }

        private static bool IsStableMemberSymbol(ISymbol symbol) =>
            symbol switch
            {
                IFieldSymbol field => field.IsReadOnly && !field.IsStatic,
                IPropertySymbol property => IsStableAutoProperty(property),
                _ => false,
            };

        // Mirrors src/Core/CodeAnalysis/Binding/SmartCastStability.IsStableProperty:
        // an auto-implemented (no custom getter/setter body, no expression
        // body) instance property, non-virtual/non-override/non-abstract, with
        // no setter or an init-only setter.
        private static bool IsStableAutoProperty(IPropertySymbol property)
        {
            if (property == null
                || property.IsStatic
                || property.IsVirtual
                || property.IsOverride
                || property.IsAbstract
                || property.GetMethod == null)
            {
                return false;
            }

            if (property.SetMethod != null && !property.SetMethod.IsInitOnly)
            {
                return false;
            }

            if (property.DeclaringSyntaxReferences.IsDefaultOrEmpty)
            {
                // No source declaration to inspect (e.g. imported from
                // metadata) — conservatively treat as unstable.
                return false;
            }

            foreach (SyntaxReference reference in property.DeclaringSyntaxReferences)
            {
                if (reference.GetSyntax() is not PropertyDeclarationSyntax propertyDeclaration
                    || propertyDeclaration.ExpressionBody != null
                    || propertyDeclaration.AccessorList == null)
                {
                    return false;
                }

                foreach (AccessorDeclarationSyntax accessor in propertyDeclaration.AccessorList.Accessors)
                {
                    if (accessor.Body != null || accessor.ExpressionBody != null)
                    {
                        return false;
                    }
                }
            }

            return true;
        }

        private bool AssignmentResultHasNonNullStaticType(
            AssignmentExpressionSyntax assignment)
        {
            if (this.PatternLocalUsesNullableStorage(assignment.Left))
            {
                return false;
            }

            ISymbol target = this.context.GetSymbolInfo(assignment.Left).Symbol;
            ITypeSymbol targetType = target switch
            {
                ILocalSymbol local => local.Type,
                IParameterSymbol parameter => parameter.Type,
                IFieldSymbol field => field.Type,
                IPropertySymbol property => property.Type,
                _ => this.context.GetTypeInfo(assignment.Left).Type,
            };
            if (targetType is { IsReferenceType: true })
            {
                return this.TargetWillRemainNonNullableReference(
                    targetType,
                    target);
            }

            return targetType != null
                && targetType.OriginalDefinition?.SpecialType
                    != SpecialType.System_Nullable_T;
        }

        private bool HasLoopCarriedWrite(
            ExpressionSyntax use,
            ISymbol symbol,
            SyntaxNode scope,
            SyntaxNode narrowingGuard)
        {
            for (SyntaxNode node = use.Parent; node != null && node != scope; node = node.Parent)
            {
                if (node is WhileStatementSyntax
                    or DoStatementSyntax
                    or ForStatementSyntax
                    or ForEachStatementSyntax
                    or ForEachVariableStatementSyntax)
                {
                    // A guard outside a loop is not re-evaluated after a write in
                    // the loop body, so it cannot prove later iterations non-null.
                    bool hasWrite = node.DescendantNodes().Any(candidate =>
                        !ReferenceEquals(candidate, use)
                        && this.SyntaxNodeWritesSymbol(candidate, symbol));
                    if (hasWrite && !node.Span.Contains(narrowingGuard.Span))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        private bool TryGetNullComparisonNonNullPolarity(
            BinaryExpressionSyntax comparison,
            ISymbol symbol,
            out bool whenTrue)
        {
            if (!comparison.IsKind(SyntaxKind.EqualsExpression)
                && !comparison.IsKind(SyntaxKind.NotEqualsExpression))
            {
                whenTrue = false;
                return false;
            }

            bool comparesSymbolToNull =
                (IsNullLiteral(comparison.Left)
                    && this.BindsToGuardSymbol(comparison.Right, symbol))
                || (IsNullLiteral(comparison.Right)
                    && this.BindsToGuardSymbol(comparison.Left, symbol));
            whenTrue = comparison.IsKind(SyntaxKind.NotEqualsExpression);
            return comparesSymbolToNull;
        }

        private bool SymbolIsWrittenBetween(
            ISymbol symbol,
            SyntaxNode start,
            SyntaxNode use,
            SyntaxNode scope)
        {
            return scope
                .DescendantNodes(node =>
                    node is not (LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax))
                .Any(node =>
                    node.SpanStart > start.Span.End
                    && node.Span.End <= use.SpanStart
                    && this.SyntaxNodeWritesSymbol(node, symbol));
        }

        private ITypeSymbol GetDeclaredValueType(ExpressionSyntax value) =>
            this.context.GetSymbolInfo(value).Symbol switch
            {
                IFieldSymbol field => field.Type,
                ILocalSymbol local => local.Type,
                IParameterSymbol parameter => parameter.Type,
                IPropertySymbol property => property.Type,
                _ => null,
            };

        private bool IsFlowNarrowedAnnotatedReference(ExpressionSyntax value)
        {
            TypeInfo typeInfo = this.context.GetTypeInfo(value);
            ITypeSymbol declaredType = this.GetDeclaredValueType(value);
            return typeInfo.Nullability.FlowState == NullableFlowState.NotNull
                && (typeInfo.Nullability.Annotation == NullableAnnotation.Annotated
                    || typeInfo.Type?.NullableAnnotation == NullableAnnotation.Annotated
                    || declaredType?.NullableAnnotation == NullableAnnotation.Annotated);
        }

        private bool NullableReferenceValueMayBeNull(ExpressionSyntax value)
        {
            if (this.GSharpExpressionIsStaticallyNonNull(value)
                || value is PostfixUnaryExpressionSyntax
                    { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression }
                || this.IsWithinExpressionTreeLambda(value)
                || this.IsCallableValueExpression(value))
            {
                return false;
            }

            TypeInfo typeInfo = this.context.GetTypeInfo(value);
            ITypeSymbol type = typeInfo.Type ?? typeInfo.ConvertedType;
            if (type is not { IsReferenceType: true })
            {
                return false;
            }

            // An oblivious producer's unannotated reference return is imported by
            // gsc as T? regardless of the consumer's nullable context. Roslyn
            // reports that metadata as Annotation.None, so its flow state cannot
            // drive the target-aware receiver/value bridges below.
            ISymbol valueSymbol = this.context.GetSymbolInfo(value).Symbol;
            if (this.IsImportedObliviousNullableMember(valueSymbol))
            {
                return true;
            }

            // Imported oblivious collection metadata applies to nested element
            // positions too. gsc now preserves that position for indexers and
            // foreach variables, so mirror the existing outer-member bridge at
            // the element dereference instead of losing the producer's
            // nullable-by-default contract.
            if (this.IsImportedObliviousCollectionElement(value, valueSymbol))
            {
                return true;
            }

            bool nullableByShape = value switch
            {
                ParenthesizedExpressionSyntax parenthesized =>
                    this.NullableReferenceValueMayBeNull(parenthesized.Expression),
                CastExpressionSyntax cast =>
                    this.NullableReferenceValueMayBeNull(cast.Expression),
                ConditionalExpressionSyntax conditional =>
                    this.NullableReferenceValueMayBeNull(conditional.WhenTrue)
                        || this.NullableReferenceValueMayBeNull(conditional.WhenFalse),
                SwitchExpressionSyntax switchExpression => switchExpression.Arms.Any(arm =>
                    this.NullableReferenceValueMayBeNull(arm.Expression)),
                BinaryExpressionSyntax coalesce
                    when coalesce.IsKind(SyntaxKind.CoalesceExpression) =>
                        this.NullableReferenceValueMayBeNull(coalesce.Right),
                AssignmentExpressionSyntax assignment =>
                    this.PatternLocalUsesNullableStorage(assignment.Left),
                _ => false,
            };

            return nullableByShape
                || type.NullableAnnotation == NullableAnnotation.Annotated
                || typeInfo.Nullability.Annotation == NullableAnnotation.Annotated;
        }

        private bool IsImportedObliviousCollectionElement(
            ExpressionSyntax value,
            ISymbol valueSymbol)
        {
            if (value is ElementAccessExpressionSyntax elementAccess
                && this.IsImportedObliviousNullableMember(
                    this.context.GetSymbolInfo(elementAccess.Expression).Symbol))
            {
                return true;
            }

            if (valueSymbol is not ILocalSymbol local)
            {
                return false;
            }

            foreach (SyntaxReference reference in local.DeclaringSyntaxReferences)
            {
                if (reference.GetSyntax() is ForEachStatementSyntax forEach
                    && this.IsImportedObliviousNullableMember(
                        this.context.GetSymbolInfo(forEach.Expression).Symbol))
                {
                    return true;
                }
            }

            return false;
        }

        // Whether `node` reaches its sink through a cast that calls a
        // user-defined conversion operator. Such a cast is an invocation
        // boundary: the value feeds the operator's (non-null) parameter, not
        // the sink that receives the converted result, so that sink is not the
        // value's target. ResolveValueSink walks casts, so this is asked first.
        private bool FlowsThroughUserDefinedConversion(SyntaxNode node)
        {
            while (node.Parent is ParenthesizedExpressionSyntax or CastExpressionSyntax)
            {
                if (node.Parent is CastExpressionSyntax cast
                    && this.context.SemanticModel.GetOperation(cast) is IConversionOperation { OperatorMethod: not null })
                {
                    return true;
                }

                node = node.Parent;
            }

            return false;
        }

        // Whether `local` is declared `var` (its G# type is inferred from its
        // initializer rather than spelled).
        private static bool IsImplicitlyTypedLocal(ILocalSymbol local) =>
            local.DeclaringSyntaxReferences.Any(reference =>
                reference.GetSyntax() is VariableDeclaratorSyntax
                {
                    Parent: VariableDeclarationSyntax { Type.IsVar: true },
                });

        // Whether `value` is (through parentheses) an arm of a conditional or a
        // switch expression, the walk FindContextualValueTarget climbs.
        private static bool IsBranchArm(ExpressionSyntax value)
        {
            SyntaxNode current = value;
            while (current.Parent is ParenthesizedExpressionSyntax)
            {
                current = current.Parent;
            }

            return current.Parent switch
            {
                ConditionalExpressionSyntax conditional =>
                    conditional.WhenTrue == current || conditional.WhenFalse == current,
                SwitchExpressionArmSyntax arm => arm.Expression == current,
                _ => false,
            };
        }

        // Whether the branching expression `value` is an arm of — climbed
        // through parentheses and nested arms to the outermost one, returned in
        // `branch` — is nil-valued or nil-observing as a whole, so no arm's `!!`
        // can serve any purpose:
        //   - some arm at any level is a `null`/`default` literal, so the whole
        //     is `T?` in G#, and anything it flows into must accept nil;
        //   - or the whole is the left operand of `??`, a `?.` receiver, an
        //     operand of `== null` / `!= null`, or tested with `is null`.
        private bool BranchResultAcceptsNil(ExpressionSyntax value, out ExpressionSyntax branch)
        {
            bool hasNilArm = false;
            SyntaxNode current = value;
            while (true)
            {
                if (current.Parent is ParenthesizedExpressionSyntax
                    or PostfixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression })
                {
                    // `!` has no runtime meaning: the arm still flows wherever
                    // the suppressed expression flows.
                    current = current.Parent;
                }
                else if (current.Parent is ConditionalExpressionSyntax conditional
                    && (conditional.WhenTrue == current || conditional.WhenFalse == current))
                {
                    hasNilArm |= IsNilArm(conditional.WhenTrue) || IsNilArm(conditional.WhenFalse);
                    current = conditional;
                }
                else if (current.Parent is SwitchExpressionArmSyntax { Parent: SwitchExpressionSyntax switchExpression } arm
                    && arm.Expression == current)
                {
                    hasNilArm |= switchExpression.Arms.Any(candidate => IsNilArm(candidate.Expression));
                    current = switchExpression;
                }
                else
                {
                    break;
                }
            }

            branch = (ExpressionSyntax)current;
            if (hasNilArm)
            {
                return true;
            }

            return current.Parent switch
            {
                BinaryExpressionSyntax coalesce when coalesce.IsKind(SyntaxKind.CoalesceExpression) =>
                    coalesce.Left == current,
                ConditionalAccessExpressionSyntax conditionalAccess => conditionalAccess.Expression == current,
                BinaryExpressionSyntax equality
                    when equality.IsKind(SyntaxKind.EqualsExpression) || equality.IsKind(SyntaxKind.NotEqualsExpression) =>
                        IsNullOrSuppressedNull(equality.Left == current ? equality.Right : equality.Left),
                IsPatternExpressionSyntax isPattern => isPattern.Expression == current && IsNullConstantPattern(isPattern.Pattern),
                _ => false,
            };

            bool IsNilArm(ExpressionSyntax arm)
            {
                while (arm is ParenthesizedExpressionSyntax parenthesized)
                {
                    arm = parenthesized.Expression;
                }

                // `default(T)` is nil for a reference type or Nullable<T>,
                // never for `default(int)`.
                return IsNullOrSuppressedNull(arm)
                    || arm.IsKind(SyntaxKind.DefaultLiteralExpression)
                    || (arm is DefaultExpressionSyntax
                        && this.context.GetTypeInfo(arm).Type is { } defaultType
                        && (defaultType.IsReferenceType
                            || defaultType.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T));
            }
        }

        private (ITypeSymbol Type, ISymbol Symbol) FindContextualValueTarget(ExpressionSyntax value)
        {
            // A C# `!` has no runtime meaning, so an arm under one still flows
            // into the suppressed expression's sink, and that sink is the
            // target when it accepts nil (`string chosen = (c ? a : b)!;` with
            // `chosen` widened to `T?`). Otherwise the `!` is where the value
            // is asserted, so the arm keeps the target it has below it and the
            // `!` itself becomes the one `!!`.
            (ITypeSymbol Type, ISymbol Symbol) climbed =
                this.FindContextualValueTarget(value, climbSuppression: true, out bool crossedSuppression);
            return !crossedSuppression || this.NullForgivingTargetAcceptsNil(climbed.Type, climbed.Symbol)
                ? climbed
                : this.FindContextualValueTarget(value, climbSuppression: false, out _);
        }

        private (ITypeSymbol Type, ISymbol Symbol) FindContextualValueTarget(
            ExpressionSyntax value,
            bool climbSuppression,
            out bool crossedSuppression)
        {
            crossedSuppression = false;

            // A conditional or switch-expression ARM has no target of its own:
            // it flows into whatever the whole `?:` / `switch` flows into, so the
            // walk climbs to the outermost branching expression. `isBranchArm`
            // records that it did.
            SyntaxNode current = value;
            bool isBranchArm = false;
            while (true)
            {
                if (current.Parent is ParenthesizedExpressionSyntax)
                {
                    current = current.Parent;
                }
                else if (climbSuppression
                    && current.Parent is PostfixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression })
                {
                    current = current.Parent;
                    crossedSuppression = true;
                }
                else if (current.Parent is ConditionalExpressionSyntax conditional
                    && (conditional.WhenTrue == current || conditional.WhenFalse == current))
                {
                    current = conditional;
                    isBranchArm = true;
                }
                else if (current.Parent is SwitchExpressionArmSyntax { Parent: SwitchExpressionSyntax switchExpression } arm
                    && arm.Expression == current)
                {
                    current = switchExpression;
                    isBranchArm = true;
                }
                else
                {
                    break;
                }
            }

            ISymbol target = current.Parent switch
            {
                ReturnStatementSyntax => this.context.SemanticModel.GetEnclosingSymbol(value.SpanStart),
                ArrowExpressionClauseSyntax arrow => this.context.GetDeclaredSymbol(arrow.Parent),
                AnonymousFunctionExpressionSyntax lambda when lambda.Body == current =>
                    this.GetLambdaTargetDelegateType(lambda)?.DelegateInvokeMethod,
                _ => null,
            };

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
            if (target == null
                && isBranchArm
                && !this.FlowsThroughUserDefinedConversion(current)
                && this.ResolveValueSink((ExpressionSyntax)current) is { } sink
                && !(sink is ILocalSymbol inferredLocal
                    && IsImplicitlyTypedLocal(inferredLocal)
                    && !this.ShouldPromoteToNullableReference(inferredLocal)
                    && !this.IsUsedAsNullable(inferredLocal, this.GetNullabilityScope(inferredLocal))))
            {
                ITypeSymbol sinkType = sink switch
                {
                    ILocalSymbol local => local.Type,
                    IFieldSymbol field => field.Type,
                    IPropertySymbol property => property.Type,
                    IParameterSymbol parameter => parameter.Type,
                    _ => null,
                };
                if (sinkType != null)
                {
                    return (sinkType, sink);
                }
            }

            // Issue #4356: an async LAMBDA's target is its delegate's Invoke, which
            // is never itself `async`; the effective result is the envelope's
            // `T`, exactly as for an async method.
            bool asyncLambdaBody = current.Parent is AnonymousFunctionExpressionSyntax asyncLambda
                && asyncLambda.AsyncKeyword.IsKind(SyntaxKind.AsyncKeyword);
            ITypeSymbol targetType = target switch
            {
                IMethodSymbol method => GetEffectiveReturnType(method.ReturnType, method.IsAsync || asyncLambdaBody),
                IPropertySymbol property => property.Type,
                _ => this.context.GetTypeInfo(value).ConvertedType,
            };
            return (targetType, target);
        }

        /// <summary>
        /// Issue #4356: whether a target (an EFFECTIVE type — the <c>T</c> of an
        /// async <c>Task&lt;T&gt;</c>, never the envelope) is certainly non-null in
        /// G#, so a <c>T?</c>-only-in-G# analyzer value flowing into it must be
        /// asserted. Anything that may accept nil answers false: an unknown
        /// target, a <c>Nullable&lt;T&gt;</c>, any annotated <c>T?</c> (reference or
        /// generic), and an unannotated type parameter, whose instantiation may
        /// itself be nullable. The assertion is only fail-safe where the target
        /// really is non-null; anywhere else it turns a legal nil into a throw.
        /// Every analyzer-value bridge (value, argument, cast, lambda result)
        /// asks this one predicate, and when unsure it answers false.
        /// </summary>
        /// <param name="targetType">The effective target type, if known.</param>
        /// <param name="targetSymbol">The target parameter/member, if any.</param>
        /// <param name="callSite">
        /// For a parameter target, the argument expression — used to tell an
        /// INFERRED generic target from an EXPLICIT one (see
        /// <see cref="IsInferredGenericParameterTarget"/>).
        /// </param>
        /// <returns>True when the target is certainly non-null in G#.</returns>
        private bool AnalyzerBridgeTargetIsNonNull(
            ITypeSymbol targetType,
            ISymbol targetSymbol = null,
            ExpressionSyntax callSite = null) =>
            targetType != null
            && targetType is not ITypeParameterSymbol
            && targetType.OriginalDefinition?.SpecialType != SpecialType.System_Nullable_T
            && targetType.NullableAnnotation != NullableAnnotation.Annotated
            && !(targetSymbol is IParameterSymbol parameter
                && IsInferredGenericParameterTarget(parameter, callSite))

            // A REFERENCE target's emitted type is what cs2gs emits for it, not
            // Roslyn's: a parameter/member promoted to `T?`
            // (ShouldPromoteToNullableReference, e.g. `SyntaxNode node` whose
            // body tests `node == null`) accepts nil. TargetWillRemainNonNullable
            // Reference answers exactly that. A value-type target (the struct
            // SyntaxToken) is emitted as-is.
            && (!targetType.IsReferenceType
                || this.TargetWillRemainNonNullableReference(targetType, targetSymbol));

        /// <summary>
        /// Issue #4356: whether an argument's target parameter is generic in a way
        /// G# will RE-INFER from the emitted argument — a parameter declared
        /// <c>T</c> or <c>params T[]</c> on a call whose type arguments are
        /// inferred. Then the emitted argument's own type decides <c>T</c>, so a
        /// <c>T?</c> value makes <c>T</c> nullable and must not be asserted.
        /// With EXPLICIT type arguments (<c>Identity&lt;SyntaxNode&gt;(x)</c>) the
        /// substituted parameter type is the real target, so this answers false
        /// and the ordinary nullability of that type decides. When the call site
        /// cannot be found, the target is treated as inferred (no assertion).
        /// </summary>
        /// <param name="parameter">The (constructed) target parameter.</param>
        /// <param name="callSite">The argument expression, if known.</param>
        /// <returns>True when the target is an inferred generic parameter.</returns>
        private static bool IsInferredGenericParameterTarget(IParameterSymbol parameter, ExpressionSyntax callSite)
        {
            ITypeSymbol declared = parameter.OriginalDefinition.Type;
            bool generic = declared is ITypeParameterSymbol
                || (parameter.IsParams && declared is IArrayTypeSymbol { ElementType: ITypeParameterSymbol });
            return generic && !CallHasExplicitTypeArguments(callSite);
        }

        // Issue #4356: whether the invocation an argument belongs to spells its
        // type arguments (`M<T>(…)`, `x.M<T>(…)`, `x?.M<T>(…)`).
        private static bool CallHasExplicitTypeArguments(ExpressionSyntax argumentExpression)
        {
            if (argumentExpression?.Parent is not ArgumentSyntax argument
                || argument.Parent?.Parent is not InvocationExpressionSyntax invocation)
            {
                return false;
            }

            ExpressionSyntax callee = invocation.Expression;
            if (callee is MemberAccessExpressionSyntax memberAccess)
            {
                callee = memberAccess.Name;
            }
            else if (callee is MemberBindingExpressionSyntax memberBinding)
            {
                callee = memberBinding.Name;
            }

            return callee is GenericNameSyntax;
        }

        private static ITypeSymbol GetEffectiveReturnType(ITypeSymbol returnType, bool isAsync) =>
            isAsync && returnType is INamedTypeSymbol taskLike && IsTaskLikeEnvelope(taskLike)
                ? taskLike.TypeArguments[0]
                : returnType;

        private (ITypeSymbol Type, ISymbol Symbol) FindNullForgivingTarget(
            PostfixUnaryExpressionSyntax value)
        {
            ISymbol sink = this.ResolveValueSink(value);
            return sink switch
            {
                ILocalSymbol local when ExplicitLocalTypeIsNullable(local) =>
                    (local.Type, local),
                IFieldSymbol field when field.Type.NullableAnnotation == NullableAnnotation.Annotated =>
                    (field.Type, field),
                IPropertySymbol property when property.Type.NullableAnnotation == NullableAnnotation.Annotated =>
                    (property.Type, property),
                _ => this.FindContextualValueTarget(value),
            };

            static bool ExplicitLocalTypeIsNullable(ILocalSymbol local) =>
                local.Type.NullableAnnotation == NullableAnnotation.Annotated
                && local.DeclaringSyntaxReferences.Any(reference =>
                    reference.GetSyntax() is VariableDeclaratorSyntax
                    {
                        Parent: VariableDeclarationSyntax { Type.IsVar: false },
                    });
        }

        private bool NullForgivingTargetAcceptsNil(ITypeSymbol targetType, ISymbol targetSymbol) =>
            targetType?.NullableAnnotation == NullableAnnotation.Annotated
            || targetType?.OriginalDefinition?.SpecialType == SpecialType.System_Nullable_T
            || (targetType is { IsReferenceType: true }
                && !this.TargetWillRemainNonNullableReference(targetType, targetSymbol));

        // Issue #2511: element-access arguments are call-like value sinks too.
        // Apply the established forgiveness predicate only when Roslyn bound the
        // argument to a non-null reference parameter that cs2gs will keep
        // non-null. Arrays and numeric/string/span indices therefore stay on
        // their existing paths, explicitly nullable indexer contracts remain
        // untouched, and nullable-enabled projects receive new assertions only
        // for values imported from nullable-oblivious assemblies.
        // A genuinely null oblivious key follows the existing `!!` bridge
        // policy and fails at runtime before the index operation.
        private GExpression TranslateIndexArgumentWithNullForgiveness(ArgumentSyntax argument)
        {
            GExpression translated = this.TranslateExpression(argument.Expression);

            // Issue #3564: a TUPLE-typed key whose G#-side elements are
            // promoted-nullable while the indexer's key tuple elements are not
            // (`store[key]` where `key` is `(ISymbol?, SyntaxNode)` against a
            // `Dictionary[(ISymbol, SyntaxNode), bool]` field) cannot be
            // bridged with a whole-value `!!` — G# has no implicit
            // `(T?, U) -> (T, U)`. Rebuild the key per element, asserting only
            // the promoted slots: `store[(key.Item1!!, key.Item2)]`. A
            // genuinely null element follows the established `!!` bridge
            // policy and fails at runtime before the index operation.
            if (this.TryRebuildPromotedTupleIndexKey(argument, translated, out GExpression rebuiltKey))
            {
                return rebuiltKey;
            }

            if (!this.IndexArgumentTargetsNonNullableReference(argument)
                || !this.IndexArgumentValueNeedsNullForgiveness(argument.Expression))
            {
                return translated;
            }

            GExpression assertionOperand = argument.Expression is ConditionalExpressionSyntax
                or SwitchExpressionSyntax
                or ConditionalAccessExpressionSyntax
                    ? new ParenthesizedExpression(translated)
                    : translated;
            return EnsureNonNullAssertion(assertionOperand);
        }

        private bool TryRebuildPromotedTupleIndexKey(
            ArgumentSyntax argument,
            GExpression translated,
            out GExpression rebuilt)
        {
            rebuilt = null;
            if (!this.IsObliviousCompilation())
            {
                return false;
            }

            if (this.context.SemanticModel.GetOperation(argument) is not IArgumentOperation
                {
                    Parameter.Type: INamedTypeSymbol { IsTupleType: true } keyTuple,
                })
            {
                return false;
            }

            ISymbol valueSymbol = this.context.GetSymbolInfo(argument.Expression).Symbol;
            if (valueSymbol is not (ILocalSymbol or IParameterSymbol or IFieldSymbol or IPropertySymbol)
                || this.context.GetTypeInfo(argument.Expression).Type
                    is not INamedTypeSymbol { IsTupleType: true } valueTuple
                || valueTuple.TupleElements.Length != keyTuple.TupleElements.Length)
            {
                return false;
            }

            var elements = new List<GExpression>(keyTuple.TupleElements.Length);
            bool anyAsserted = false;
            for (int i = 0; i < keyTuple.TupleElements.Length; i++)
            {
                GExpression element = new MemberAccessExpression(translated, $"Item{i + 1}", isArrow: false);
                IFieldSymbol keyElement = keyTuple.TupleElements[i];
                bool keyElementStaysNonNull = keyElement.Type is { IsReferenceType: true }
                    && keyElement.Type.NullableAnnotation != NullableAnnotation.Annotated;
                if (keyElementStaysNonNull
                    && this.TryGetIndexReceiverGenericTuple(
                        argument,
                        out ISymbol receiver,
                        out IReadOnlyList<int> tuplePath)
                    && ObliviousNullabilityAnalyzer.IsTupleElementTainted(
                        this.context.Compilation,
                        receiver,
                        tuplePath.Concat(new[] { i }).ToList(),
                        this.context.SiblingCompilations))
                {
                    keyElementStaysNonNull = false;
                }

                if (keyElementStaysNonNull
                    && ObliviousNullabilityAnalyzer.IsTupleElementTainted(
                        this.context.Compilation,
                        valueSymbol,
                        new List<int> { i },
                        this.context.SiblingCompilations))
                {
                    element = new NonNullAssertionExpression(element);
                    anyAsserted = true;
                }

                elements.Add(element);
            }

            if (!anyAsserted)
            {
                return false;
            }

            rebuilt = new TupleLiteralExpression(elements);
            return true;
        }

        private bool TryGetIndexReceiverGenericTuple(
            ArgumentSyntax argument,
            out ISymbol receiver,
            out IReadOnlyList<int> tuplePath)
        {
            receiver = null;
            tuplePath = null;
            if (argument.Parent?.Parent is not ElementAccessExpressionSyntax elementAccess
                || this.context.SemanticModel.GetOperation(argument) is not IArgumentOperation operation
                || operation.Parameter is not IParameterSymbol parameter)
            {
                return false;
            }

            ISymbol receiverSymbol = this.context.GetSymbolInfo(elementAccess.Expression).Symbol;
            if (receiverSymbol is not (IFieldSymbol or IPropertySymbol))
            {
                return false;
            }

            ITypeSymbol receiverType = receiverSymbol switch
            {
                IFieldSymbol field => field.Type,
                IPropertySymbol property => property.Type,
                _ => null,
            };
            if (receiverType is not INamedTypeSymbol namedReceiver
                || !ObliviousNullabilityAnalyzer.TryGetGenericReceiverTuplePath(
                    namedReceiver,
                    parameter,
                    out _,
                    out tuplePath))
            {
                return false;
            }

            receiver = receiverSymbol;
            return true;
        }

        private bool IndexArgumentValueNeedsNullForgiveness(ExpressionSyntax value)
        {
            // ADR-0186 step 6 (PR 0): a `T!` index argument is checked by gsc.
            if (IsNullOrSuppressedNull(value)
                || value is PostfixUnaryExpressionSyntax
                    { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression }
                || this.IsWithinExpressionTreeLambda(value)
                || this.PlatformTypedImportNeedsNoBridge(value))
            {
                return false;
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
            ISymbol valueSymbol = this.context.GetSymbolInfo(value).Symbol;
            if (valueSymbol is ILocalSymbol or IParameterSymbol
                && this.IsDominatedByNullCheckGuard(value, valueSymbol))
            {
                return false;
            }

            if (this.ReceiverNeedsNullForgiveness(value))
            {
                return true;
            }

            if (this.NullableReferenceValueMayBeNull(value))
            {
                return true;
            }

            switch (value)
            {
                case ParenthesizedExpressionSyntax parenthesized:
                    return this.IndexArgumentValueNeedsNullForgiveness(parenthesized.Expression);

                case ConditionalExpressionSyntax conditional:
                    return this.IndexArgumentValueNeedsNullForgiveness(conditional.WhenTrue)
                        || this.IndexArgumentValueNeedsNullForgiveness(conditional.WhenFalse);

                case SwitchExpressionSyntax switchExpression:
                    return switchExpression.Arms.Any(arm =>
                        this.IndexArgumentValueNeedsNullForgiveness(arm.Expression));

                case ConditionalAccessExpressionSyntax:
                    return true;
            }

            ISymbol symbol = valueSymbol;
            return this.IsObliviousCompilation()
                && symbol is IFieldSymbol or IPropertySymbol or ILocalSymbol or IParameterSymbol or IMethodSymbol
                && this.IsNullablePromotedValue(value)
                && !this.IsDominatedByNullCheckGuard(value, symbol);
        }

        private bool IndexArgumentTargetsNonNullableReference(ArgumentSyntax argument)
        {
            if (this.context.SemanticModel.GetOperation(argument) is not IArgumentOperation
                {
                    Parameter: { } parameter,
                })
            {
                return false;
            }

            return this.ParameterWillRemainNonNullableReference(parameter);
        }

        private bool ParameterWillRemainNonNullableReference(IParameterSymbol parameter)
        {
            return this.TargetWillRemainNonNullableReference(parameter.Type, parameter);
        }

        /// <summary>
        /// Determines whether <paramref name="recv"/> needs a G# <c>!!</c>
        /// assertion because it is either a declared-nullable reference narrowed
        /// non-null by flow or an ordinary dereference receiver whose declaration
        /// was promoted nullable by oblivious analysis (see
        /// <see cref="TranslateReceiverWithNullForgiveness"/>).
        /// </summary>
        private bool ReceiverNeedsNullForgiveness(
            ExpressionSyntax recv,
            bool isDereferenceReceiver = false)
        {
            if (this.GSharpExpressionIsStaticallyNonNull(recv)
                || this.IsActivePatternBinding(recv)
                || this.IsGSharpFlowNarrowedLocal(recv)
                || this.IsGSharpFlowNarrowedFieldOrPropertyInSameCondition(recv))
            {
                return false;
            }

            // `expr!` already lowers to a `NonNullAssertionExpression`; never
            // double-assert. `this`/`base`, a null literal, and a `?.` conditional
            // access receiver are handled by their own paths and are not
            // declared-nullable property/field chains.
            if (recv is PostfixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression }
                or ThisExpressionSyntax
                or BaseExpressionSyntax
                or LiteralExpressionSyntax
                or ConditionalAccessExpressionSyntax)
            {
                return false;
            }

            // Issue #2496: `!!` is a runtime-only G# operator and therefore is
            // never representable inside an expression tree (GS0473). Use the
            // lambda's semantic converted type rather than call/constructor
            // syntax so this covers overload-selected Expression<TDelegate>
            // parameters, generic expression sinks, fluent APIs, and nested
            // quoted lambdas uniformly. A user-authored C# suppression (`expr!`)
            // has already returned above and still translates to `!!`, preserving
            // the compiler's expression-tree restriction diagnostic.
            if (this.IsWithinExpressionTreeLambda(recv))
            {
                return false;
            }

            // Issue #2504/#2496: a method group or lambda is the callable value
            // itself, never the nullable value produced by invoking it. External
            // oblivious-return forgiveness belongs at the callable's result
            // contract, not as `MethodGroup!!` on the delegate conversion seam.
            if (this.IsCallableValueExpression(recv))
            {
                return false;
            }

            // Issue #2506: the oblivious analysis promotes a same-project
            // method/property/indexer declaration when its VALUE can be null.
            // An ordinary C# dereference of that value still means
            // throw-on-null, so the corresponding G# receiver needs one `!!`.
            // Keep this receiver-only: a method group is the callable value
            // rather than its return, and a promoted call forwarded as a return
            // or argument must remain `T?` instead of being blanket-forgiven.
            if (isDereferenceReceiver && this.ReceiverValueIsPromotedNullable(recv))
            {
                return NullForgivenessTelemetry.Record("2506-promoted-nullable-receiver");
            }

            // Issue #3683 (family F5): the sibling of the promoted-value rule
            // above for a declaration that was never promoted because it was
            // ANNOTATED `T?` all along, read from an OBLIVIOUS file. Same
            // receiver-only gate, same faithfulness argument.
            if (isDereferenceReceiver && this.ReceiverValueIsObliviouslyReadAnnotatedResult(recv))
            {
                return NullForgivenessTelemetry.Record("3683-obliviously-annotated-result");
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
            if (this.IsLazyInitGuardedFieldUse(recv))
            {
                return NullForgivenessTelemetry.Record("2164-lazy-init-guarded-field");
            }

            // Issue #2202: `if (F == null) {…} else { …F… }` / `F == null ? … : …F…`
            // (and the negated forms) narrow `F` to non-null on the guarded
            // branch — same syntactic-guard rationale as the lazy-init case
            // above, for a plain null-check guard instead of a lazy-init one.
            if (this.IsNullGuardNarrowedFieldUse(recv))
            {
                return NullForgivenessTelemetry.Record("2202-null-guard-narrowed-field");
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
            if (this.IsNullableTaintedArmOfReturnPreservingConditional(recv))
            {
                return NullForgivenessTelemetry.Record("2202-2412-tainted-arm-return-preserving-conditional");
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
            if (this.IsNullableTaintedArmOfElementAccessAssignment(recv))
            {
                return NullForgivenessTelemetry.Record("4211-tainted-arm-element-access-assignment");
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
            if (this.IsUnguardedForwardOfTaintedValueInReturnPreservingBody(recv))
            {
                return NullForgivenessTelemetry.Record("2432-unguarded-forward-return-preserving-body");
            }

            // Issue #2496: once callable values stop borrowing their synthesized
            // method symbol's return taint, a runtime delegate lambda still needs
            // the old, legitimate bridge at its RESULT seam. Keep that bridge
            // narrowly target-typed to a non-null delegate return contract. The
            // expression-tree guard above deliberately excludes quoted lambdas.
            if (this.IsUnguardedForwardOfTaintedValueAsRuntimeLambdaResult(recv))
            {
                return NullForgivenessTelemetry.Record("2496-unguarded-forward-lambda-result");
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
            if (this.IsUnguardedForwardOfTaintedValueAsArgument(recv))
            {
                return NullForgivenessTelemetry.Record("2434-unguarded-forward-argument");
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
            if (this.IsImportedObliviousNullableMember(this.context.GetSymbolInfo(recv).Symbol)
                && !this.PlatformTypedImportNeedsNoBridge(recv))
            {
                return NullForgivenessTelemetry.Record("2202-imported-oblivious-nullable-member");
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
            ISymbol foreignCandidate = this.context.GetSymbolInfo(recv).Symbol;
            if (this.IsObliviousCompilation()
                && foreignCandidate is IFieldSymbol or IPropertySymbol or IParameterSymbol or ILocalSymbol or IMethodSymbol
                && !SymbolEqualityComparer.Default.Equals(foreignCandidate.ContainingAssembly, this.context.Compilation.Assembly)
                && this.ShouldPromoteToNullableReference(foreignCandidate))
            {
                return NullForgivenessTelemetry.Record("2412-cross-project-oblivious-value-read");
            }

            // Flow analysis must have proven the receiver non-null at this site.
            if (this.context.GetTypeInfo(recv).Nullability.FlowState != NullableFlowState.NotNull)
            {
                return false;
            }

            ISymbol symbol = this.context.GetSymbolInfo(recv).Symbol;

            // Static member access (`Type.StaticMember`) and namespace-qualified
            // names carry a type/namespace receiver, not a value: never assert.
            if (symbol is ITypeSymbol or INamespaceSymbol or null)
            {
                return false;
            }

            // Inspect the receiver's *declared* type. The flow-collapsed
            // `Nullability.Annotation` reports NotAnnotated once flow proves
            // non-null, so it cannot distinguish a declared `T?` from a `T`; the
            // declaring symbol's type is the reliable source.
            ITypeSymbol declared = symbol switch
            {
                IPropertySymbol property => property.Type,
                IFieldSymbol field => field.Type,
                ILocalSymbol local => local.Type,
                IParameterSymbol parameter => parameter.Type,
                IMethodSymbol method => method.ReturnType,
                _ => null,
            };

            // Focus on the GS0158/GS0116 cases: nullable reference types and
            // nullable arrays. Nullable value types (`int?`) take the `.Value`/
            // `.HasValue` path and are left untouched.
            if (declared is not { IsReferenceType: true })
            {
                return false;
            }

            // A declared-nullable receiver (`T?`) flow-proven non-null needs `!!`.
            // A declared non-null receiver that this pass PROMOTED to `T?`
            // (issue #1072: null-checked param/field/local) is rendered nullable
            // too, so its flow-proven uses need the same assertion for consistency.
            if (declared.NullableAnnotation == NullableAnnotation.Annotated)
            {
                return NullForgivenessTelemetry.Record("flow-proven-declared-nullable");
            }

            if (this.ShouldPromoteToNullableReference(symbol))
            {
                return NullForgivenessTelemetry.Record("1072-flow-proven-promoted-nullable");
            }

            return false;
        }

        /// <summary>
        /// Issue #3683 (family F5): true when <paramref name="expression"/> is a
        /// CALL RESULT — an invocation or an indexer read — whose <em>declared</em>
        /// return is an annotated <c>T?</c> reference, evaluated inside a
        /// nullable-OBLIVIOUS compilation.
        /// </summary>
        /// <remarks>
        /// This is the call-result door onto the same cross-nullable-context read
        /// that issue #3683's cast-receiver half (family F6) closed. When an
        /// oblivious file (<c>test/Core.Tests</c> declares no <c>Nullable</c>
        /// setting) calls an ANNOTATED API (<c>src/Core</c>, or the annotated BCL:
        /// <c>Type? Type.GetElementType()</c>), Roslyn erases the annotation at the
        /// call site — <c>GetTypeInfo(...).Type.NullableAnnotation</c> reads
        /// <c>None</c> and the flow state is <c>None</c> too — so neither
        /// <see cref="NullableReferenceValueMayBeNull"/> nor the flow-gated tail of
        /// <see cref="ReceiverNeedsNullForgiveness"/> can see anything nullable.
        /// The declaring symbol's own return type still carries the annotation, and
        /// gsc maps it to <c>T?</c>, so the chained dereference was rejected
        /// (GS0158 on a member, GS0116 on an index). A nullable-ENABLED compilation
        /// needs none of this: there the annotation survives on the expression's
        /// type and the existing predicates already fire, so this stays gated to
        /// oblivious.
        /// <para>
        /// Asserting is faithful and stays receiver-only: C# raises a
        /// <see cref="System.NullReferenceException"/> at exactly this dereference,
        /// and <c>!!</c> raises at exactly the same point. A call result forwarded
        /// as a return value or an argument is NOT covered here — that value must
        /// keep its <c>T?</c> and reach the declaration-promotion path instead.
        /// </para>
        /// </remarks>
        private bool ReceiverValueIsObliviouslyReadAnnotatedResult(ExpressionSyntax expression)
        {
            if (!this.IsObliviousCompilation())
            {
                return false;
            }

            switch (expression)
            {
                case ParenthesizedExpressionSyntax parenthesized:
                    return this.ReceiverValueIsObliviouslyReadAnnotatedResult(parenthesized.Expression);

                case InvocationExpressionSyntax invocation:
                    // A `Task<T>`/`ValueTask<T>` envelope is itself non-null; its
                    // annotation belongs to the awaited T (see
                    // AwaitedReceiverValueIsPromotedNullable), never to the
                    // receiver being dereferenced here.
                    return this.context.GetSymbolInfo(invocation).Symbol is IMethodSymbol method
                        && !IsTaskLikeEnvelope(method.ReturnType)
                        && IsAnnotatedNullableReference(method.ReturnType);

                case ElementAccessExpressionSyntax elementAccess:
                    return this.context.GetSymbolInfo(elementAccess).Symbol is IPropertySymbol indexer
                        && IsAnnotatedNullableReference(indexer.Type);

                default:
                    return false;
            }
        }

        private bool ReceiverValueIsPromotedNullable(ExpressionSyntax expression)
        {
            if (!this.IsObliviousCompilation())
            {
                return false;
            }

            switch (expression)
            {
                case ParenthesizedExpressionSyntax parenthesized:
                    return this.ReceiverValueIsPromotedNullable(parenthesized.Expression);

                case CastExpressionSyntax cast:
                    // Issue #3501: align with CastUsesCheckedReferenceConversion
                    // (identity reference casts included) so a null-preserving
                    // `expr as T` lowering still surfaces its operand's
                    // promotion to the receiver-forgiveness pass.
                    return this.CastUsesCheckedReferenceConversion(cast)
                        && this.ReceiverValueIsPromotedNullable(cast.Expression);

                case AwaitExpressionSyntax awaited:
                    return this.AwaitedReceiverValueIsPromotedNullable(awaited.Expression);

                case ConditionalExpressionSyntax conditional:
                    return this.ReceiverValueIsPromotedNullable(conditional.WhenTrue)
                        || this.ReceiverValueIsPromotedNullable(conditional.WhenFalse);

                case SwitchExpressionSyntax switchExpression:
                    return switchExpression.Arms.Any(arm =>
                        this.ReceiverValueIsPromotedNullable(arm.Expression));

                // `a ?? b` is non-null whenever `b` is non-null; only the
                // fallback value can make the coalesced receiver nullable.
                case BinaryExpressionSyntax coalesce
                    when coalesce.IsKind(SyntaxKind.CoalesceExpression):
                    return this.ReceiverValueIsPromotedNullable(coalesce.Right);

                case InvocationExpressionSyntax invocation
                    when this.context.GetSymbolInfo(invocation).Symbol is IMethodSymbol method:
                    // Method-return taint on Task<T>/ValueTask<T> widens the
                    // awaited T, not the non-null task envelope itself.
                    return !IsTaskLikeEnvelope(method.ReturnType)
                        && this.ShouldPromoteToNullableReference(method);

                case ElementAccessExpressionSyntax elementAccess:
                    return this.context.GetSymbolInfo(elementAccess).Symbol is IPropertySymbol indexer
                        && this.ShouldPromoteToNullableReference(indexer);

                case IdentifierNameSyntax:
                case MemberAccessExpressionSyntax:
                    // Issue #3663: a DECONSTRUCTING `foreach` variable carries no
                    // taint of its own — it aliases a tuple leaf of the enumerated
                    // sequence, and G# infers its type from that leaf. A promoted
                    // leaf therefore makes the dereference `T? -> T` (GS0158).
                    if (ObliviousNullabilityAnalyzer.IsDeconstructedForEachElementTainted(
                        this.context.Compilation,
                        expression,
                        this.context.SemanticModel,
                        this.context.SiblingCompilations))
                    {
                        return true;
                    }

                    ISymbol symbol = this.context.GetSymbolInfo(expression).Symbol;
                    if (symbol is ILocalSymbol local
                        && !this.ShouldPromoteToNullableReference(local)
                        && local.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
                            is VariableDeclaratorSyntax { Initializer.Value: { } initializer })
                    {
                        return this.IsNullablePromotedValue(initializer);
                    }

                    return symbol is IFieldSymbol or IPropertySymbol or ILocalSymbol or IParameterSymbol
                        && this.ShouldPromoteToNullableReference(symbol);

                default:
                    return false;
            }
        }

        private bool AwaitedReceiverValueIsPromotedNullable(ExpressionSyntax expression)
        {
            switch (expression)
            {
                case ParenthesizedExpressionSyntax parenthesized:
                    return this.AwaitedReceiverValueIsPromotedNullable(parenthesized.Expression);

                case CastExpressionSyntax cast:
                    return this.AwaitedReceiverValueIsPromotedNullable(cast.Expression);

                case ConditionalExpressionSyntax conditional:
                    return this.AwaitedReceiverValueIsPromotedNullable(conditional.WhenTrue)
                        || this.AwaitedReceiverValueIsPromotedNullable(conditional.WhenFalse);

                case InvocationExpressionSyntax invocation
                    when this.context.GetSymbolInfo(invocation).Symbol is IMethodSymbol method:
                    return IsTaskLikeEnvelope(method.ReturnType)
                        && this.ShouldPromoteToNullableReference(method);

                default:
                    return false;
            }
        }

        private static bool IsTaskLikeEnvelope(ITypeSymbol type)
        {
            if (type is not INamedTypeSymbol named
                || !named.IsGenericType
                || named.TypeArguments.Length != 1
                || named.Name is not ("Task" or "ValueTask"))
            {
                return false;
            }

            return named.ContainingNamespace.ToDisplayString() == "System.Threading.Tasks";
        }

        // Issue #2164: true when <paramref name="recv"/> reads a nullable
        // (`T?`) field/property that is lazily initialized under a dominating
        // null guard, so it is provably non-null here and needs an explicit
        // `!!` (gsc never smart-casts fields/properties). The decision is purely
        // syntactic because the migrated corpus compiles nullable-oblivious.
        private bool IsLazyInitGuardedFieldUse(ExpressionSyntax recv)
        {
            if (!this.TryGetEmittedNullableFieldOrProperty(recv, out ISymbol symbol))
            {
                return false;
            }

            return this.IsDominatedByLazyInitGuard(recv, symbol);
        }

        // Issue #2202: shared prerequisite for the lazy-init-guard and
        // null-check-guard `!!` heuristics below — <paramref name="recv"/> must
        // be a bare/qualified read of a field or property that G# actually
        // emits as `T?` (declared nullable, or promoted to nullable by the
        // oblivious taint analysis). A read that is itself the LHS of an
        // assignment, the operand of a null comparison, or a `nameof` argument
        // is handled by other paths and is never a value read a guard narrows.
        private bool TryGetEmittedNullableFieldOrProperty(ExpressionSyntax recv, out ISymbol symbol)
        {
            symbol = this.context.GetSymbolInfo(recv).Symbol;
            if (symbol is not (IFieldSymbol or IPropertySymbol))
            {
                symbol = null;
                return false;
            }

            // The field/property must be emitted `T?` in G# — either declared
            // nullable or promoted to nullable by this translator (the taint
            // analysis / #1072 null-usage rules). Otherwise there is no `T? -> T`
            // to forgive and asserting `!!` on a non-null value is wrong.
            ITypeSymbol declared = symbol switch
            {
                IFieldSymbol field => field.Type,
                IPropertySymbol property => property.Type,
                _ => null,
            };

            if (declared is not { IsReferenceType: true })
            {
                symbol = null;
                return false;
            }

            bool emittedNullable = declared.NullableAnnotation == NullableAnnotation.Annotated
                || this.ShouldPromoteToNullableReference(symbol);
            if (!emittedNullable)
            {
                symbol = null;
                return false;
            }

            return true;
        }

        // Walks outward from the statement containing <paramref name="use"/> to
        // the enclosing accessor/method boundary, looking for a preceding
        // statement (in the same block or an enclosing one, e.g. a `lock` body)
        // that lazily initializes <paramref name="symbol"/> to a non-null value.
        // Because a lazy-init guard leaves `symbol` non-null on BOTH the taken
        // and skipped paths, every later use it dominates is non-null.
        private bool IsDominatedByLazyInitGuard(ExpressionSyntax use, ISymbol symbol)
        {
            StatementSyntax useStatement = use.FirstAncestorOrSelf<StatementSyntax>();
            if (useStatement == null)
            {
                return false;
            }

            for (SyntaxNode node = useStatement; node != null; node = node.Parent)
            {
                if (node.Parent is BlockSyntax block)
                {
                    foreach (StatementSyntax statement in block.Statements)
                    {
                        if (statement == node)
                        {
                            break;
                        }

                        if (this.IsLazyInitGuardStatement(statement, symbol))
                        {
                            return true;
                        }
                    }
                }

                // Stop at the enclosing accessor / method / local-function body:
                // dominance across a member boundary is not analyzed here.
                if (node is AccessorDeclarationSyntax
                    or BaseMethodDeclarationSyntax
                    or LocalFunctionStatementSyntax
                    or AnonymousFunctionExpressionSyntax
                    or ArrowExpressionClauseSyntax)
                {
                    break;
                }
            }

            return false;
        }

        // True when <paramref name="statement"/> is one of the lazy-init guard
        // shapes that leaves <paramref name="symbol"/> non-null afterwards:
        //   • `if (F == null) { F = expr; }` / `if (F is null) { F = expr; }`
        //   • `F ??= expr;`
        // (`expr` must not itself be a `null` literal). Lock-wrapped variants are
        // covered because the enclosing walk descends into the `lock` body block.
        private bool IsLazyInitGuardStatement(StatementSyntax statement, ISymbol symbol)
        {
            switch (statement)
            {
                case IfStatementSyntax ifStatement
                    when this.IsNullCheckOf(ifStatement.Condition, symbol):
                    return this.AssignsSymbolNonNull(ifStatement.Statement, symbol);

                case ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax coalesce }
                    when coalesce.IsKind(SyntaxKind.CoalesceAssignmentExpression)
                    && this.BindsTo(coalesce.Left, symbol)
                    && !IsNullOrSuppressedNull(coalesce.Right):
                    return true;

                default:
                    return false;
            }
        }

        // `F == null` / `null == F` / `F is null` (the null-path condition of a
        // lazy-init guard), where `F` binds to <paramref name="symbol"/>.
        private bool IsNullCheckOf(ExpressionSyntax condition, ISymbol symbol)
        {
            condition = StripParentheses(condition);

            switch (condition)
            {
                case BinaryExpressionSyntax binary
                    when binary.IsKind(SyntaxKind.EqualsExpression):
                    return (IsNullLiteral(binary.Right) && this.BindsToGuardSymbol(binary.Left, symbol))
                        || (IsNullLiteral(binary.Left) && this.BindsToGuardSymbol(binary.Right, symbol));

                case IsPatternExpressionSyntax isPattern
                    when this.BindsToGuardSymbol(isPattern.Expression, symbol):
                    return IsNullConstantPattern(isPattern.Pattern)
                        && isPattern.Pattern is not UnaryPatternSyntax;

                default:
                    return false;
            }
        }

        // `F != null` / `null != F` / `F is not null` — the negation of
        // <see cref="IsNullCheckOf"/>, where `F` binds to <paramref name="symbol"/>.
        private bool IsNonNullCheckOf(ExpressionSyntax condition, ISymbol symbol)
        {
            condition = StripParentheses(condition);

            switch (condition)
            {
                case BinaryExpressionSyntax binary
                    when binary.IsKind(SyntaxKind.NotEqualsExpression):
                    return (IsNullLiteral(binary.Right) && this.BindsToGuardSymbol(binary.Left, symbol))
                        || (IsNullLiteral(binary.Left) && this.BindsToGuardSymbol(binary.Right, symbol));

                case IsPatternExpressionSyntax isPattern
                    when this.BindsToGuardSymbol(isPattern.Expression, symbol):
                    return IsNullConstantPattern(isPattern.Pattern)
                        && isPattern.Pattern is UnaryPatternSyntax;

                default:
                    return false;
            }
        }

        private bool BindsToGuardSymbol(ExpressionSyntax expression, ISymbol symbol)
        {
            if (this.BindsTo(expression, symbol))
            {
                return true;
            }

            expression = StripParentheses(expression);
            if (symbol is not (ILocalSymbol or IParameterSymbol)
                || expression is not IdentifierNameSyntax identifier
                || identifier.Identifier.ValueText != symbol.Name)
            {
                return false;
            }

            ISymbol bound = this.context.GetSymbolInfo(identifier).Symbol;
            if (bound != null)
            {
                return HasSameSourceDeclaration(bound, symbol);
            }

            ISymbol visible = this.context.SemanticModel
                .LookupSymbols(identifier.SpanStart, name: symbol.Name)
                .FirstOrDefault();
            return visible == null || HasSameSourceDeclaration(visible, symbol);
        }

        private static bool HasSameSourceDeclaration(ISymbol left, ISymbol right) =>
            left.DeclaringSyntaxReferences.Any(leftDeclaration =>
                right.DeclaringSyntaxReferences.Any(rightDeclaration =>
                    leftDeclaration.SyntaxTree == rightDeclaration.SyntaxTree
                    && leftDeclaration.Span == rightDeclaration.Span));

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
        private bool IsNullGuardNarrowedFieldUse(ExpressionSyntax use)
        {
            if (!this.TryGetEmittedNullableFieldOrProperty(use, out ISymbol symbol))
            {
                return false;
            }

            return this.IsDominatedByNullCheckGuard(use, symbol);
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
        private bool IsDominatedByNullCheckGuard(ExpressionSyntax use, ISymbol symbol)
        {
            for (SyntaxNode node = use; node != null; node = node.Parent)
            {
                switch (node.Parent)
                {
                    // An `else` branch's statement is nested one level deeper
                    // than the `if` itself — its direct parent is the
                    // `ElseClauseSyntax`, not the `IfStatementSyntax`.
                    case ElseClauseSyntax elseClause
                        when elseClause.Parent is IfStatementSyntax ifStatement
                            && node == elseClause.Statement
                            && this.IsNullCheckOf(ifStatement.Condition, symbol):
                        return true;

                    case IfStatementSyntax ifStatement
                        when node == ifStatement.Statement
                            && this.IsNonNullCheckOf(ifStatement.Condition, symbol):
                        return true;

                    case ConditionalExpressionSyntax ternary
                        when node == ternary.WhenFalse
                            && this.IsNullCheckOf(ternary.Condition, symbol):
                        return true;

                    case ConditionalExpressionSyntax ternary
                        when node == ternary.WhenTrue
                            && this.IsNonNullCheckOf(ternary.Condition, symbol):
                        return true;
                }

                // Stop at the enclosing accessor / method / local-function /
                // lambda / arrow-body boundary: a guard cannot narrow a use
                // across a member boundary.
                if (node is AccessorDeclarationSyntax
                    or BaseMethodDeclarationSyntax
                    or LocalFunctionStatementSyntax
                    or AnonymousFunctionExpressionSyntax
                    or ArrowExpressionClauseSyntax)
                {
                    break;
                }
            }

            return false;
        }

        /// <summary>
        /// Issue #2202 / #2412 (round 3): true when <paramref name="use"/> reads
        /// a nullable-tainted field/property as an arm of a conditional/switch
        /// expression whose enclosing property/method return type was
        /// deliberately preserved non-null (the oblivious-analyzer's
        /// property-contract / forwarding-exclusion guardrail, issues #1354 /
        /// #2167).
        /// </summary>
        /// <remarks>
        /// Scoping constraints that prevent this from becoming a blanket forgiveness:
        /// <list type="bullet">
        ///   <item>Oblivious compilation only (nullable-enabled projects untouched).</item>
        ///   <item><paramref name="use"/> must be a field/property emitted <c>T?</c>.</item>
        ///   <item>The conditional must be the (possibly parenthesized / return-wrapped)
        ///     entire body of the enclosing property/method.</item>
        ///   <item>The enclosing property/method's return type must NOT be promoted to
        ///     nullable — only the deliberate "return kept non-null" pattern qualifies.</item>
        /// </list>
        /// This deliberately does NOT require a sibling arm to already be
        /// null-guard-narrowed (the original #2202 scoping): a conditional's
        /// governing condition need not correlate with either arm's nullness at
        /// all (e.g. `Profile.PreAmazon ? HttpClientAudible : HttpClientAmazon`
        /// — a plain flag check, not a null-check on either arm — the real
        /// Oahu.Core `AudibleApi.HttpClient` shape). Every tainted arm of a
        /// conditional whose enclosing member's return type the guardrail
        /// refused to widen needs the same bridging assertion the guardrail's
        /// own design already anticipates (per <see cref="IsUnguardedForwardOfTaintedValueInReturnPreservingBody"/>'s
        /// unconditional counterpart) — restricting to only the "one sibling
        /// already guarded" subset left every OTHER unguarded shape unfixed
        /// without narrowing the class of members this rule can affect (that
        /// scope is controlled entirely by <see cref="IsBodyOfReturnPreservingMember"/>
        /// below, not by sibling-guard status).
        /// </remarks>
        private bool IsNullableTaintedArmOfReturnPreservingConditional(ExpressionSyntax use)
        {
            if (!this.IsObliviousCompilation())
            {
                return false;
            }

            if (!this.TryGetEmittedNullableFieldOrProperty(use, out _))
            {
                return false;
            }

            // Walk upward (stripping parentheses) to find the enclosing
            // ConditionalExpressionSyntax or SwitchExpressionSyntax whose arm
            // this use belongs to, and confirm that the use IS an arm (not the
            // condition / governing expression).
            (ExpressionSyntax conditional, _) = this.FindEnclosingConditionalAndSiblings(use);
            if (conditional == null)
            {
                return false;
            }

            // The conditional must be the (possibly parenthesized / return-wrapped)
            // entire body of an enclosing property or method, and that member's
            // return type must NOT be promoted to nullable by the oblivious
            // analyzer (i.e., it was deliberately kept non-null).
            return this.IsBodyOfReturnPreservingMember(conditional);
        }

        /// <summary>
        /// Issue #4211: true when <paramref name="use"/> is a promoted-nullable
        /// value read as an ARM of a conditional/switch expression whose result
        /// is assigned into an element-access target that genuinely requires a
        /// non-null reference (<see cref="ElementAccessAssignmentRequiresNonNullReference"/>).
        /// </summary>
        /// <remarks>
        /// This is the arm-level completion of issue #2259's element-access sink
        /// rule. That rule asks <c>IsNullablePromotedValue</c> about the WHOLE
        /// right-hand side; for a ternary that question is answered by
        /// <c>IsNullableInitializer</c>, which recurses into the arms but only
        /// ever reads their DECLARED annotation — the taint fixpoint's promotion
        /// is invisible to it. So the exact corpus shape
        /// <c>slots[ordinal] = permutes ? this.SpillOperand(value, …) : value</c>
        /// (cs2gs's own <c>TranslateClaimedLocalFunctionArgumentsWithDefaults</c>,
        /// where <c>value</c> is a local the fixpoint promoted to
        /// <c>GExpression?</c>) emitted a bare <c>T?</c> arm into a <c>T</c>
        /// element slot and failed to compile with GS0155.
        /// <para>
        /// Scoping, mirroring
        /// <see cref="IsNullableTaintedArmOfReturnPreservingConditional"/>:
        /// oblivious compilations only; the use must really be an ARM (the walk
        /// requires at least one conditional/switch level, so a DIRECT RHS keeps
        /// flowing through #2259's whole-RHS rule and stays byte-identical); the
        /// sink must be an element access the taint fixpoint structurally cannot
        /// widen (unlike a local/field/property/parameter target, which it widens
        /// at the target's own declaration); and a local/parameter narrowed by a
        /// dominating null-check guard is skipped because gsc's own Kotlin-style
        /// smart-cast — including the conditional's own condition when it guards
        /// that arm — has already made the read non-null.
        /// </para>
        /// </remarks>
        private bool IsNullableTaintedArmOfElementAccessAssignment(ExpressionSyntax use)
        {
            if (!this.IsObliviousCompilation()
                || !TryGetElementAccessAssignmentThroughConditionalArms(
                    use,
                    out AssignmentExpressionSyntax assignment)
                || !this.ElementAccessAssignmentRequiresNonNullReference(assignment))
            {
                return false;
            }

            ISymbol symbol = this.context.GetSymbolInfo(use).Symbol;
            if (symbol is ILocalSymbol or IParameterSymbol
                && this.IsDominatedByNullCheckGuard(use, symbol))
            {
                return false;
            }

            return this.IsNullablePromotedValue(use);
        }

        // Walks outward from a conditional/switch ARM (through parentheses and
        // any number of NESTED conditional/switch levels) to the simple
        // assignment whose right-hand side that conditional ultimately is.
        // Requires at least one conditional/switch level to have been crossed:
        // a direct, unwrapped assignment RHS is issue #2259's whole-RHS rule's
        // business and is deliberately left alone here. A use sitting in a
        // conditional's CONDITION (rather than an arm) stops the walk, as does
        // any other intervening expression — this is not a general "does this
        // value eventually reach an element write" dataflow question.
        private static bool TryGetElementAccessAssignmentThroughConditionalArms(
            ExpressionSyntax use,
            out AssignmentExpressionSyntax assignment)
        {
            assignment = null;
            SyntaxNode current = use;
            bool crossedConditional = false;

            while (current != null)
            {
                switch (current.Parent)
                {
                    case ParenthesizedExpressionSyntax parenthesized:
                        current = parenthesized;
                        continue;

                    case ConditionalExpressionSyntax ternary
                        when current == ternary.WhenTrue || current == ternary.WhenFalse:
                        crossedConditional = true;
                        current = ternary;
                        continue;

                    case SwitchExpressionArmSyntax arm
                        when current == arm.Expression
                            && arm.Parent is SwitchExpressionSyntax switchExpression:
                        crossedConditional = true;
                        current = switchExpression;
                        continue;

                    case AssignmentExpressionSyntax candidate when current == candidate.Right:
                        if (!crossedConditional)
                        {
                            return false;
                        }

                        assignment = candidate;
                        return true;

                    default:
                        return false;
                }
            }

            return false;
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
        private bool IsUnguardedForwardOfTaintedValueInReturnPreservingBody(ExpressionSyntax use)
        {
            if (!this.IsObliviousCompilation())
            {
                return false;
            }

            ISymbol symbol = this.context.GetSymbolInfo(use).Symbol;
            if (symbol is not (IFieldSymbol or IPropertySymbol or ILocalSymbol or IParameterSymbol or IMethodSymbol))
            {
                return false;
            }

            // Reuses the exact same "is this emitted `T?`" test the rest of the
            // translator relies on (declared-annotated OR taint-promoted), so a
            // symbol whose nullability this pass would forgive here is always
            // consistent with what every other promotion/forgiveness call site
            // already treats as nullable.
            if (!this.IsNullablePromotedValue(use))
            {
                return false;
            }

            return this.IsBodyOfReturnPreservingMember(use);
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
        private bool IsUnguardedForwardOfTaintedValueAsArgument(ExpressionSyntax use)
        {
            if (!this.IsObliviousCompilation())
            {
                return false;
            }

            ISymbol symbol = this.context.GetSymbolInfo(use).Symbol;
            if (symbol is not (IFieldSymbol or IPropertySymbol or ILocalSymbol or IParameterSymbol or IMethodSymbol))
            {
                return false;
            }

            if (!this.IsNullablePromotedValue(use))
            {
                return false;
            }

            // Walk up through parentheses to the immediate syntactic parent:
            // this rule covers only a DIRECT (unwrapped) forward — a
            // ternary/switch arm or any other composed expression never
            // resolves to an ArgumentSyntax parent here and is intentionally
            // left to the return-preserving-body rule (or unhandled) instead.
            SyntaxNode node = use;
            while (node.Parent is ParenthesizedExpressionSyntax)
            {
                node = node.Parent;
            }

            if (node.Parent is not ArgumentSyntax argumentSyntax)
            {
                return false;
            }

            // A dominating guard means gsc's own smart-cast (locals) or the
            // sibling field/property rule (already checked earlier in
            // ReceiverNeedsNullForgiveness) already makes this use safe
            // without any help from this rule.
            if (this.IsDominatedByNullCheckGuard(use, symbol))
            {
                return false;
            }

            if (this.context.SemanticModel.GetOperation(argumentSyntax) is not IArgumentOperation argumentOperation
                || argumentOperation.Parameter is not { } parameter)
            {
                return false;
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
            return this.ParameterWillRemainNonNullableReference(parameter);
        }

        private bool IsUnguardedForwardOfTaintedValueAsRuntimeLambdaResult(ExpressionSyntax use)
        {
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
            if (IsNullOrSuppressedNull(use)
                || this.IsSyntacticallyNullableResultShape(use)
                || !this.IsObliviousCompilation()
                || this.IsWithinExpressionTreeLambda(use)
                || this.LambdaResultFeedsNullableObservedInvocation(use)
                || this.FindResultLambda(use) is not { } lambda
                || this.LambdaResultFlowsToNullableSink(lambda)
                || this.LambdaResultFeedsUnobservedTaskRun(use)
                || this.GetLambdaTargetDelegateType(lambda) is not { DelegateInvokeMethod: { } invoke }
                || GetEffectiveReturnType(
                    invoke.ReturnType,
                    lambda.AsyncKeyword.IsKind(SyntaxKind.AsyncKeyword)) is not { IsReferenceType: true } returnType
                || returnType.NullableAnnotation == NullableAnnotation.Annotated)
            {
                return false;
            }

            bool returnDeclaredInThisCompilation = invoke.DeclaringSyntaxReferences
                .Any(reference => this.context.Compilation.ContainsSyntaxTree(reference.SyntaxTree));
            if (returnDeclaredInThisCompilation
                && this.ShouldPromoteToNullableReference(invoke))
            {
                return false;
            }

            // ADR-0186 step 6 (PR 0): an oblivious-metadata result is `T!`,
            // which gsc checks at the lambda's non-null return itself, unless
            // the lambda's own type is inferred from it.
            return this.IsNullablePromotedValue(use)
                || (this.IsImportedObliviousNullableMember(this.context.GetSymbolInfo(use).Symbol)
                    && !this.PlatformTypedImportNeedsNoBridge(use));
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
        private bool LambdaResultFeedsUnobservedTaskRun(ExpressionSyntax use)
        {
            if (this.FindResultLambda(use) is not { } lambda)
            {
                return false;
            }

            SyntaxNode node = lambda;
            while (node.Parent is ParenthesizedExpressionSyntax or CastExpressionSyntax)
            {
                node = node.Parent;
            }

            return node.Parent is ArgumentSyntax argument
                && argument.Parent?.Parent is InvocationExpressionSyntax invocation
                && this.context.GetSymbolInfo(invocation).Symbol is IMethodSymbol method
                && IsTaskRunEntryPoint(method)
                && !this.TaskInvocationResultIsEverUnwrapped(invocation);
        }

        private static bool IsTaskRunEntryPoint(IMethodSymbol method)
        {
            IMethodSymbol original = method.OriginalDefinition;
            return original.Name is "Run" or "StartNew"
                && original.ContainingType is { Name: "Task" or "TaskFactory" } containingType
                && containingType.ContainingNamespace?.ToDisplayString() == "System.Threading.Tasks";
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
        private bool TaskInvocationResultIsEverUnwrapped(InvocationExpressionSyntax invocation)
        {
            SyntaxNode value = invocation;
            while (value.Parent is ParenthesizedExpressionSyntax or CastExpressionSyntax)
            {
                value = value.Parent;
            }

            if (value.Parent is AwaitExpressionSyntax
                || (value.Parent is MemberAccessExpressionSyntax fluentAccess
                    && fluentAccess.Expression == value
                    && IsTaskResultUnwrapMember(fluentAccess.Name.Identifier.Text)))
            {
                return true;
            }

            if (this.ResolveValueSink(invocation) is not ILocalSymbol local)
            {
                return true;
            }

            SyntaxNode scope = this.GetNullabilityScope(local);
            if (scope == null)
            {
                return true;
            }

            return scope.DescendantNodes()
                    .OfType<MemberAccessExpressionSyntax>()
                    .Any(member => this.BindsTo(member.Expression, local)
                        && IsTaskResultUnwrapMember(member.Name.Identifier.Text))
                || scope.DescendantNodes()
                    .OfType<AwaitExpressionSyntax>()
                    .Any(awaitExpression => this.BindsTo(awaitExpression.Expression, local));
        }

        private static bool IsTaskResultUnwrapMember(string name) => name is "Result" or "GetAwaiter";

        private bool LambdaResultFlowsToNullableSink(AnonymousFunctionExpressionSyntax lambda)
        {
            // Issue #4046: a generic selector has no fixed return contract of
            // its own. When its fluent call chain collapses back to the same
            // scalar type and that final sink is emitted nullable, preserve nil
            // for operators such as FirstOrDefault to inspect instead of
            // throwing at the selector boundary.
            SyntaxNode current = lambda;
            while (current.Parent is ParenthesizedExpressionSyntax)
            {
                current = current.Parent;
            }

            if (current.Parent is not ArgumentSyntax argument
                || argument.Expression != current
                || argument.Parent?.Parent is not InvocationExpressionSyntax invocation
                || !this.IsGenericSelectorResultArgument(argument, lambda))
            {
                return false;
            }

            current = invocation;
            while (true)
            {
                if (current.Parent is ParenthesizedExpressionSyntax parenthesized)
                {
                    current = parenthesized;
                    continue;
                }

                if (current.Parent is MemberAccessExpressionSyntax member
                    && member.Expression == current
                    && member.Parent is InvocationExpressionSyntax outerInvocation)
                {
                    current = outerInvocation;
                    continue;
                }

                break;
            }

            if (current is not ExpressionSyntax expression)
            {
                return false;
            }

            ISymbol sink = this.ResolveValueSink(expression);
            ITypeSymbol sinkType = sink switch
            {
                IMethodSymbol method => method.ReturnType,
                IPropertySymbol property => property.Type,
                IFieldSymbol field => field.Type,
                ILocalSymbol local => local.Type,
                IParameterSymbol parameter => parameter.Type,
                _ => null,
            };

            ITypeSymbol resultType =
                (this.context.GetSymbolInfo(lambda).Symbol as IMethodSymbol)?.ReturnType;
            if (sinkType is not { IsReferenceType: true })
            {
                return false;
            }

            if (SymbolEqualityComparer.Default.Equals(resultType, sinkType))
            {
                // The #4046 shape: the chain collapses back to the SAME scalar
                // type as the selector's own result (`.Select(...).FirstOrDefault()`).
                return !this.TargetWillRemainNonNullableReference(sinkType, sink);
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
            if (sinkType is not INamedTypeSymbol { IsGenericType: true, TypeArguments.Length: 1 } sinkCollection
                || sinkCollection.TypeArguments[0] is not { } sinkElement
                || sinkElement.NullableAnnotation != NullableAnnotation.Annotated
                || resultType == null)
            {
                return false;
            }

            // Element compatibility is an ASSIGNABILITY check, not identity: the
            // sink accepts the selector's result through an implicit reference
            // conversion (including IEnumerable<T> covariance), e.g.
            // `Consume(IEnumerable<object?> values)` called with
            // `types.Select(t => t.FullName)` -- `string` is not symbol-equal
            // to `object`, but every `string` IS an `object`. Exact identity
            // missed this: the selector result stayed `!!`-asserted and threw
            // on a null `FullName` even though the sink tolerates it.
            ITypeSymbol sinkElementType = sinkElement.WithNullableAnnotation(NullableAnnotation.None);
            Microsoft.CodeAnalysis.CSharp.Conversion elementConversion =
                this.context.Compilation.ClassifyConversion(resultType, sinkElementType);
            return elementConversion.IsImplicit
                && (elementConversion.IsReference || elementConversion.IsIdentity);
        }

        private bool IsGenericSelectorResultArgument(
            ArgumentSyntax argument,
            AnonymousFunctionExpressionSyntax lambda)
        {
            IParameterSymbol parameter =
                (this.context.SemanticModel.GetOperation(argument) as IArgumentOperation)?.Parameter;
            if (parameter == null
                && argument.Parent?.Parent is InvocationExpressionSyntax invocation
                && this.context.SemanticModel.GetOperation(invocation) is IInvocationOperation operation)
            {
                // Roslyn may attach the operation to the operand inside parentheses.
                parameter = operation.Arguments.FirstOrDefault(candidate =>
                    argument.Span.Contains(candidate.Syntax.Span))?.Parameter;
            }

            if (parameter == null
                && !this.TryGetExpandedParamsElementTarget(argument, out _, out parameter))
            {
                return false;
            }

            return parameter?.ContainingSymbol is IMethodSymbol method
                && ReturnsGenericSelectorResult(
                    method.OriginalDefinition,
                    parameter.Ordinal,
                    lambda.AsyncKeyword.IsKind(SyntaxKind.AsyncKeyword));
        }

        private static bool ReturnsGenericSelectorResult(
            IMethodSymbol genericMethod,
            int parameterOrdinal,
            bool isAsync)
        {
            if (!genericMethod.IsGenericMethod
                || parameterOrdinal < 0
                || parameterOrdinal >= genericMethod.Parameters.Length)
            {
                return false;
            }

            IParameterSymbol parameter = genericMethod.Parameters[parameterOrdinal];
            ITypeSymbol selectorType = parameter.Type switch
            {
                IArrayTypeSymbol array when parameter.IsParams => array.ElementType,
                INamedTypeSymbol named when parameter.IsParams && IsSupportedParamsCollectionType(named) =>
                    named.TypeArguments[0],
                _ => parameter.Type,
            };
            if (selectorType is not INamedTypeSymbol delegateType
                || delegateType.TypeKind != TypeKind.Delegate
                || (isAsync && !IsTaskLikeEnvelope(delegateType.DelegateInvokeMethod?.ReturnType))
                || GetEffectiveReturnType(delegateType.DelegateInvokeMethod?.ReturnType, isAsync)
                    is not ITypeParameterSymbol resultParameter
                || resultParameter.TypeParameterKind != TypeParameterKind.Method
                || !SymbolEqualityComparer.Default.Equals(
                    resultParameter.ContainingSymbol,
                    genericMethod))
            {
                return false;
            }

            ITypeSymbol resultType = genericMethod.ReturnType;
            if (resultType is INamedTypeSymbol namedResult)
            {
                INamedTypeSymbol enumerable =
                    namedResult.OriginalDefinition.SpecialType == SpecialType.System_Collections_Generic_IEnumerable_T
                        ? namedResult
                        : null;
                foreach (INamedTypeSymbol iface in namedResult.AllInterfaces)
                {
                    if (iface.OriginalDefinition.SpecialType != SpecialType.System_Collections_Generic_IEnumerable_T)
                    {
                        continue;
                    }

                    if (enumerable != null && !SymbolEqualityComparer.Default.Equals(enumerable, iface))
                    {
                        return false;
                    }

                    enumerable = iface;
                }

                if (enumerable != null)
                {
                    resultType = GetEnumerableElementType(enumerable);
                }
                else if (namedResult.SpecialType == SpecialType.System_Collections_IEnumerable
                    || namedResult.AllInterfaces.Any(iface =>
                        iface.SpecialType == SpecialType.System_Collections_IEnumerable))
                {
                    return false;
                }
            }

            return ContainsSelectorResult(resultType, resultParameter);
        }

        private static bool ContainsSelectorResult(ITypeSymbol type, ITypeParameterSymbol resultParameter) =>
            SymbolEqualityComparer.Default.Equals(type, resultParameter)
            || (type is IArrayTypeSymbol array
                && ContainsSelectorResult(array.ElementType, resultParameter))
            || (type is INamedTypeSymbol named
                && (named.TypeArguments.Any(argument =>
                        ContainsSelectorResult(argument, resultParameter))
                    || (named.ContainingType is { } containingType
                        && ContainsSelectorResult(containingType, resultParameter))));

        private AnonymousFunctionExpressionSyntax FindResultLambda(ExpressionSyntax use)
        {
            SyntaxNode node = use;
            while (node.Parent is ParenthesizedExpressionSyntax)
            {
                node = node.Parent;
            }

            if (node.Parent is AnonymousFunctionExpressionSyntax expressionLambda
                && expressionLambda.Body == node)
            {
                return expressionLambda;
            }

            if (node.Parent is not ReturnStatementSyntax returnStatement)
            {
                return null;
            }

            for (SyntaxNode ancestor = returnStatement.Parent; ancestor != null; ancestor = ancestor.Parent)
            {
                if (ancestor is AnonymousFunctionExpressionSyntax lambda)
                {
                    return lambda;
                }

                if (ancestor is LocalFunctionStatementSyntax or BaseMethodDeclarationSyntax)
                {
                    return null;
                }
            }

            return null;
        }

        /// <summary>
        /// Issue #4356: whether a <c>!!</c> on the member/element-access RECEIVER
        /// <paramref name="recv"/> would be unrepresentable because it sits
        /// inside an expression-tree lambda.
        /// </summary>
        /// <remarks>
        /// Issue #2496 suppressed every such receiver assertion, because gsc then
        /// rejected any <c>!!</c> in an expression tree (GS0473). gsc has since
        /// narrowed that (issue #3349): over a REFERENCE type the assertion is
        /// pure static annotation and <c>ExpressionTreeLowerer</c> erases it, and
        /// a receiver-position check over an ADR-0186 platform operand is elided
        /// by <c>ExpressionTreeRestrictionValidator.ValidateReceiver</c>. Only an
        /// assertion that strips a nullable VALUE type — a real
        /// <c>Nullable&lt;T&gt;.Value</c> conversion — is still rejected, and gsc
        /// treats an unconstrained type parameter the same way, since it may be
        /// instantiated with one. Suppressing the reference case too left
        /// <c>b.Conversion.AccountId</c> (a stated-<c>T?</c> navigation property
        /// in an EF <c>Where</c>) printed with no <c>!!</c>, binding only through
        /// gsc's old member-lookup carve-out.
        /// </remarks>
        /// <param name="recv">The receiver expression.</param>
        /// <returns>True when the receiver is inside an expression tree and not a reference type.</returns>
        private bool ExpressionTreeForbidsReceiverAssertion(ExpressionSyntax recv) =>
            this.IsWithinExpressionTreeLambda(recv)
            && this.context.GetTypeInfo(recv).Type is not { IsReferenceType: true }

            // The C# type is not what gsc sees in analyzer mode: a retargeted
            // Roslyn member such as `ParameterSyntax.Identifier` is a C# struct
            // but a G# nullable REFERENCE (`SyntaxToken?`), whose assertion gsc
            // erases in a tree like any other reference-type `!!`.
            && !this.IsGSharpNullableAnalyzerExpression(recv);

        private bool IsWithinExpressionTreeLambda(SyntaxNode node) =>
            node.AncestorsAndSelf()
                .OfType<AnonymousFunctionExpressionSyntax>()
                .Any(lambda => this.IsExpressionTreeLambda(lambda));

        private bool IsExpressionTreeLambda(AnonymousFunctionExpressionSyntax lambda) =>
            this.context.GetTypeInfo(lambda).ConvertedType is INamedTypeSymbol converted
                && converted.IsGenericType
                && converted.OriginalDefinition.MetadataName == "Expression`1"
                && converted.ContainingNamespace?.ToDisplayString() == "System.Linq.Expressions"
                && converted.TypeArguments.Length == 1
                && converted.TypeArguments[0].TypeKind == TypeKind.Delegate;

        private INamedTypeSymbol GetLambdaTargetDelegateType(AnonymousFunctionExpressionSyntax lambda)
        {
            if (this.context.GetTypeInfo(lambda).ConvertedType is not INamedTypeSymbol converted)
            {
                return null;
            }

            if (converted.TypeKind == TypeKind.Delegate)
            {
                return converted;
            }

            return this.IsExpressionTreeLambda(lambda)
                ? converted.TypeArguments[0] as INamedTypeSymbol
                : null;
        }

        // Walks outward from <paramref name="use"/> through parentheses to find
        // the nearest enclosing ConditionalExpressionSyntax or
        // SwitchExpressionSyntax whose arm the use belongs to. Returns the
        // conditional and the sibling arms (all arms EXCEPT the one containing
        // <paramref name="use"/>). Returns (null, null) if not found.
        private (ExpressionSyntax Conditional, ExpressionSyntax[] Siblings)
            FindEnclosingConditionalAndSiblings(ExpressionSyntax use)
        {
            for (SyntaxNode node = use; node != null; node = node.Parent)
            {
                switch (node.Parent)
                {
                    case ConditionalExpressionSyntax ternary:
                        if (node == ternary.WhenTrue || IsDescendantOfArmViaParens(use, ternary.WhenTrue))
                        {
                            return (ternary, new[] { ternary.WhenFalse });
                        }

                        if (node == ternary.WhenFalse || IsDescendantOfArmViaParens(use, ternary.WhenFalse))
                        {
                            return (ternary, new[] { ternary.WhenTrue });
                        }

                        // The use is in the condition, not an arm.
                        return (null, null);

                    case SwitchExpressionSyntax switchExpr:
                        var siblings = new List<ExpressionSyntax>();
                        bool found = false;
                        foreach (SwitchExpressionArmSyntax arm in switchExpr.Arms)
                        {
                            if (arm.Expression == node || IsDescendantOfArmViaParens(use, arm.Expression))
                            {
                                found = true;
                            }
                            else
                            {
                                siblings.Add(arm.Expression);
                            }
                        }

                        return found ? (switchExpr, siblings.ToArray()) : (null, null);
                }

                // Stop at member boundary.
                if (node is AccessorDeclarationSyntax
                    or BaseMethodDeclarationSyntax
                    or LocalFunctionStatementSyntax
                    or AnonymousFunctionExpressionSyntax
                    or ArrowExpressionClauseSyntax)
                {
                    break;
                }
            }

            return (null, null);
        }

        // True when <paramref name="descendant"/> is nested inside
        // <paramref name="arm"/> through parenthesized expressions only.
        private static bool IsDescendantOfArmViaParens(SyntaxNode descendant, ExpressionSyntax arm)
        {
            for (SyntaxNode node = descendant; node != null; node = node.Parent)
            {
                if (node == arm)
                {
                    return true;
                }

                if (node.Parent is not ParenthesizedExpressionSyntax && node != descendant)
                {
                    return false;
                }
            }

            return false;
        }

        // True when <paramref name="conditional"/> is the (possibly parenthesized
        // / return-wrapped) entire body of a property or method whose declared
        // return type was NOT promoted to nullable by the oblivious-nullability
        // analyzer — i.e., the analyzer deliberately preserved it non-null.
        private bool IsBodyOfReturnPreservingMember(ExpressionSyntax conditional)
        {
            // Walk up through parentheses and a single return statement to reach
            // the enclosing arrow-body / accessor / method boundary.
            SyntaxNode node = conditional;
            while (node.Parent is ParenthesizedExpressionSyntax)
            {
                node = node.Parent;
            }

            ISymbol enclosingMember = null;

            // Case 1: arrow-expression body `=> expr`
            if (node.Parent is ArrowExpressionClauseSyntax arrow)
            {
                enclosingMember = arrow.Parent switch
                {
                    PropertyDeclarationSyntax p => this.context.GetDeclaredSymbol(p),
                    IndexerDeclarationSyntax i => this.context.GetDeclaredSymbol(i),
                    MethodDeclarationSyntax m => this.context.GetDeclaredSymbol(m),
                    AccessorDeclarationSyntax acc
                        when acc.Parent?.Parent is BasePropertyDeclarationSyntax bp
                        => this.context.GetDeclaredSymbol(bp),
                    _ => null,
                };
            }
            else if (node.Parent is ReturnStatementSyntax ret)
            {
                // Case 2: `return expr;` inside a block-bodied getter/method —
                // walk up from the return statement to the enclosing member.
                enclosingMember = this.FindEnclosingPropertyOrMethodSymbol(ret);
            }

            if (enclosingMember == null)
            {
                return false;
            }

            // The member's return type must be reference-typed and NOT promoted
            // to nullable — confirming the analyzer deliberately kept it non-null.
            ITypeSymbol returnType = enclosingMember switch
            {
                IPropertySymbol p => p.Type,
                IMethodSymbol m => m.ReturnType,
                _ => null,
            };

            if (returnType is not { IsReferenceType: true })
            {
                return false;
            }

            if (returnType.NullableAnnotation == NullableAnnotation.Annotated)
            {
                return false;
            }

            // If the oblivious analyzer DID promote this member to nullable,
            // the return type is already `T?` and forgiving the arm is unnecessary
            // (and would be wrong — the caller expects nullable).
            return !this.ShouldPromoteToNullableReference(enclosingMember);
        }

        // Walks up from a return statement to find the enclosing property (via a
        // `get` accessor) or method symbol. Stops at nested scope boundaries
        // (lambdas, local functions). Returns null if not found.
        private ISymbol FindEnclosingPropertyOrMethodSymbol(ReturnStatementSyntax ret)
        {
            for (SyntaxNode walk = ret.Parent; walk != null; walk = walk.Parent)
            {
                switch (walk)
                {
                    case AccessorDeclarationSyntax acc
                        when acc.IsKind(SyntaxKind.GetAccessorDeclaration)
                            && acc.Parent?.Parent is BasePropertyDeclarationSyntax bp:
                        return this.context.GetDeclaredSymbol(bp);

                    case MethodDeclarationSyntax m:
                        return this.context.GetDeclaredSymbol(m);

                    case LocalFunctionStatementSyntax:
                    case AnonymousFunctionExpressionSyntax:
                        return null;
                }
            }

            return null;
        }

        // True when <paramref name="body"/> (a lazy-init guard's then-branch)
        // contains an assignment of a non-null value to <paramref name="symbol"/>.
        private bool AssignsSymbolNonNull(StatementSyntax body, ISymbol symbol)
        {
            if (body == null)
            {
                return false;
            }

            foreach (AssignmentExpressionSyntax assignment in
                body.DescendantNodesAndSelf().OfType<AssignmentExpressionSyntax>())
            {
                if (!assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                    && !assignment.IsKind(SyntaxKind.CoalesceAssignmentExpression))
                {
                    continue;
                }

                if (this.BindsTo(assignment.Left, symbol)
                    && !IsNullOrSuppressedNull(assignment.Right))
                {
                    return true;
                }
            }

            return false;
        }

        private static ExpressionSyntax StripParentheses(ExpressionSyntax expression)
        {
            while (expression is ParenthesizedExpressionSyntax paren)
            {
                expression = paren.Expression;
            }

            return expression;
        }
    }
}
