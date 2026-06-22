// <copyright file="DeclarationBinder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access
#pragma warning disable SA1516 // Elements should be separated by blank line

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Extracted from <see cref="Binder"/> in PR-B-8. Owns every per-declaration-kind
/// binder: type aliases, named delegates, enums, structs (including the large
/// <c>BindStructDeclarationBody</c> driver and its interface-implementation
/// verification pass), interfaces, free / member / extension functions,
/// constructors (<c>init</c>) plus the <c>: base(...)</c> initializer
/// resolver, the two symbol-construction <c>BindVariableDeclaration</c>
/// overloads, generic-parameter binding (<c>BindTypeParameterList</c>), the
/// declaration-side attribute binder (<c>BindAttributes</c>/<c>BindAttribute</c>),
/// and the queue of pending struct→interface implementation checks. The
/// expression binder and most type-name resolution remain on
/// <see cref="Binder"/> and are invoked via the delegate callbacks supplied to
/// the constructor; the same is true for <c>BindBlockStatement</c>-driven
/// body binding (which happens later, in <c>BindProgram</c>, not here).
/// </summary>
internal sealed class DeclarationBinder
{
    /// <summary>Signature for the root <c>BindExpression(syntax)</c> entry point.</summary>
    /// <param name="syntax">The expression syntax to bind.</param>
    /// <returns>The bound expression.</returns>
    internal delegate BoundExpression BindExpressionDelegate(ExpressionSyntax syntax);

    /// <summary>Signature for the <c>BindTypeOfExpression(syntax)</c> entry point.</summary>
    /// <param name="syntax">The <c>typeof</c> expression syntax.</param>
    /// <returns>The bound type-of expression.</returns>
    internal delegate BoundExpression BindTypeOfExpressionDelegate(TypeOfExpressionSyntax syntax);

    /// <summary>Signature for the <c>BindArrayCreationExpression(syntax)</c> entry point.</summary>
    /// <param name="syntax">The array-creation syntax.</param>
    /// <returns>The bound array-creation expression.</returns>
    internal delegate BoundExpression BindArrayCreationExpressionDelegate(ArrayCreationExpressionSyntax syntax);

    /// <summary>Signature for the <c>BindReturnTypeClause(syntax, isAsync)</c> entry point.</summary>
    /// <param name="syntax">The return type clause syntax.</param>
    /// <param name="isAsync">Whether the enclosing function is async.</param>
    /// <returns>The bound type or <c>null</c>.</returns>
    internal delegate TypeSymbol BindReturnTypeClauseDelegate(TypeClauseSyntax syntax, bool isAsync);

    private readonly BinderContext binderCtx;
    private readonly ConversionClassifier conversions;
    private readonly BindExpressionDelegate bindExpression;
    private readonly Func<TypeClauseSyntax, TypeSymbol> bindTypeClause;
    private readonly BindReturnTypeClauseDelegate bindReturnTypeClause;
    private readonly BindTypeOfExpressionDelegate bindTypeOfExpression;
    private readonly BindArrayCreationExpressionDelegate bindArrayCreationExpression;
    private readonly Func<SyntaxToken, Accessibility> resolveAccessibility;
    private readonly Func<string, TypeSymbol> lookupType;
    private readonly Func<TypeSymbol, Type> getEffectiveArgumentClrType;
    private readonly Func<TypeSymbol, bool> isAsyncIteratorReturnType;
    private readonly Func<TypeSymbol, bool> isAsyncSequenceReturnType;
    private readonly Func<string, bool> isPrimitiveTypeName;
    private readonly Func<RefKind, string> refKindToString;
    private readonly Func<FunctionSymbol> getCurrentFunction;

    private readonly List<(StructDeclarationSyntax Syntax, StructSymbol Symbol)> pendingInterfaceImplementationChecks
        = new List<(StructDeclarationSyntax, StructSymbol)>();

    public DeclarationBinder(
        BinderContext binderCtx,
        ConversionClassifier conversions,
        BindExpressionDelegate bindExpression,
        Func<TypeClauseSyntax, TypeSymbol> bindTypeClause,
        BindReturnTypeClauseDelegate bindReturnTypeClause,
        BindTypeOfExpressionDelegate bindTypeOfExpression,
        BindArrayCreationExpressionDelegate bindArrayCreationExpression,
        Func<SyntaxToken, Accessibility> resolveAccessibility,
        Func<string, TypeSymbol> lookupType,
        Func<TypeSymbol, Type> getEffectiveArgumentClrType,
        Func<TypeSymbol, bool> isAsyncIteratorReturnType,
        Func<TypeSymbol, bool> isAsyncSequenceReturnType,
        Func<string, bool> isPrimitiveTypeName,
        Func<RefKind, string> refKindToString,
        Func<FunctionSymbol> getCurrentFunction)
    {
        this.binderCtx = binderCtx ?? throw new ArgumentNullException(nameof(binderCtx));
        this.conversions = conversions ?? throw new ArgumentNullException(nameof(conversions));
        this.bindExpression = bindExpression ?? throw new ArgumentNullException(nameof(bindExpression));
        this.bindTypeClause = bindTypeClause ?? throw new ArgumentNullException(nameof(bindTypeClause));
        this.bindReturnTypeClause = bindReturnTypeClause ?? throw new ArgumentNullException(nameof(bindReturnTypeClause));
        this.bindTypeOfExpression = bindTypeOfExpression ?? throw new ArgumentNullException(nameof(bindTypeOfExpression));
        this.bindArrayCreationExpression = bindArrayCreationExpression ?? throw new ArgumentNullException(nameof(bindArrayCreationExpression));
        this.resolveAccessibility = resolveAccessibility ?? throw new ArgumentNullException(nameof(resolveAccessibility));
        this.lookupType = lookupType ?? throw new ArgumentNullException(nameof(lookupType));
        this.getEffectiveArgumentClrType = getEffectiveArgumentClrType ?? throw new ArgumentNullException(nameof(getEffectiveArgumentClrType));
        this.isAsyncIteratorReturnType = isAsyncIteratorReturnType ?? throw new ArgumentNullException(nameof(isAsyncIteratorReturnType));
        this.isAsyncSequenceReturnType = isAsyncSequenceReturnType ?? throw new ArgumentNullException(nameof(isAsyncSequenceReturnType));
        this.isPrimitiveTypeName = isPrimitiveTypeName ?? throw new ArgumentNullException(nameof(isPrimitiveTypeName));
        this.refKindToString = refKindToString ?? throw new ArgumentNullException(nameof(refKindToString));
        this.getCurrentFunction = getCurrentFunction ?? throw new ArgumentNullException(nameof(getCurrentFunction));
    }

    private DiagnosticBag Diagnostics => binderCtx.Diagnostics;

#pragma warning disable SA1300 // Element should begin with an uppercase letter
    private BoundScope scope
#pragma warning restore SA1300
    {
        get => binderCtx.RootScope;
        set => binderCtx.RootScope = value;
    }

#pragma warning disable SA1300 // Element should begin with an uppercase letter
    private FunctionSymbol function => getCurrentFunction();
#pragma warning restore SA1300

    internal void BindTypeAliasDeclaration(TypeAliasDeclarationSyntax syntax)
    {
        var name = syntax.Identifier.Text;

        // Reject shadowing of primitive type names.
        if (isPrimitiveTypeName(name))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
            return;
        }

        var aliasedType = bindTypeClause(syntax.AliasedType);
        if (aliasedType == null)
        {
            return;
        }

        // Issue #141 / ADR-0047: type aliases accept annotations syntactically;
        // since the alias has no dedicated symbol of its own, the resolved
        // attribute list is reported for diagnostics and otherwise dropped
        // until v2 introduces a richer alias-symbol shape.
        BindAttributes(
            syntax.Annotations,
            AttributeTargetKind.Type,
            Binder.TypeDeclarationAllowedTargets,
            "a type alias declaration",
            System.AttributeTargets.Class);

        if (!scope.TryDeclareTypeAlias(name, aliasedType))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
        }
    }

    /// <summary>
    /// ADR-0059 / issue #255: binds a <c>type Name = delegate func(...)</c>
    /// declaration into a <see cref="DelegateTypeSymbol"/> registered with the
    /// current scope. Unlike a plain type alias, a named delegate produces a
    /// real CLR TypeDef at emit time.
    /// </summary>
    internal void BindDelegateDeclaration(DelegateDeclarationSyntax syntax, PackageSymbol package)
    {
        var name = syntax.Identifier.Text;

        // Reject shadowing of primitive type names — same rule as struct/enum.
        if (isPrimitiveTypeName(name))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
            return;
        }

        // ADR-0059 v1 limitation: generic delegate declarations are accepted
        // syntactically but rejected by the binder (the emitter does not yet
        // thread GenericParam rows through delegate TypeDefs). Surface a clear
        // diagnostic so users know it's a deliberate not-yet-supported case.
        if (syntax.TypeParameterList != null)
        {
            Diagnostics.ReportGenericDelegateNotSupported(syntax.Identifier.Location, name);
            return;
        }

        var accessibility = resolveAccessibility(syntax.AccessibilityModifier);

        var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>();
        var seenParameterNames = new HashSet<string>();
        for (var pIndex = 0; pIndex < syntax.Parameters.Count; pIndex++)
        {
            var parameterSyntax = syntax.Parameters[pIndex];
            var parameterName = parameterSyntax.Identifier.Text;
            var parameterType = bindTypeClause(parameterSyntax.Type) ?? TypeSymbol.Error;
            if (!seenParameterNames.Add(parameterName))
            {
                Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
                continue;
            }

            // ADR-0101 follow-up / issue #812: variadic parameters are now
            // accepted on delegate declarations. The Invoke signature carries
            // a `[]T` slice, and the emitter stamps [ParamArrayAttribute] on
            // the trailing parameter so C# / F# / VB consumers see the
            // delegate as a normal `params T[]` delegate.
            var isVariadic = parameterSyntax.IsVariadic;
            if (isVariadic && parameterType != TypeSymbol.Error)
            {
                parameterType = SliceTypeSymbol.Get(parameterType);
            }

            var delegateParam = new ParameterSymbol(
                parameterName,
                parameterType,
                isVariadic,
                declaringSyntax: parameterSyntax.Identifier,
                refKind: conversions.BindAndValidateParameterRefKind(parameterSyntax, parameterName, parameterType, isVariadic, asyncOrIteratorKind: null));

            // ADR-0063 §5: delegate declarations can declare default-valued
            // parameters; the value is recorded on the parameter symbol for
            // call-site default substitution.
            conversions.BindAndAttachParameterDefaultValue(parameterSyntax, delegateParam);
            parameters.Add(delegateParam);
        }

        // ADR-0101 follow-up / issue #812: `...T` must be the last parameter
        // and at most one variadic parameter per delegate signature.
        ValidateVariadicParameterShape(syntax.Parameters);

        var returnType = syntax.ReturnType != null ? bindTypeClause(syntax.ReturnType) : TypeSymbol.Void;
        if (returnType == null)
        {
            returnType = TypeSymbol.Void;
        }

        // ADR-0047: annotations on a delegate declaration default to the Type
        // target. ADR-0095 / issue #761: the effective AttributeUsage target
        // is `Delegate` (not `Class`) so attributes whose AttributeUsage is
        // restricted to delegates — most importantly
        // `[UnmanagedFunctionPointer]` — bind without GS0276.
        var delegateAttributes = BindAttributes(
            syntax.Annotations,
            AttributeTargetKind.Type,
            Binder.TypeDeclarationAllowedTargets,
            "a delegate declaration",
            System.AttributeTargets.Delegate);

        var delegateSymbol = new DelegateTypeSymbol(
            name,
            package.Name,
            accessibility,
            parameters.ToImmutable(),
            returnType,
            syntax);
        delegateSymbol.SetAttributes(delegateAttributes);
        Binder.AttachDocumentation(delegateSymbol, syntax);

        if (!scope.TryDeclareTypeAlias(name, delegateSymbol))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
        }
    }

    internal EnumSymbol BindEnumDeclaration(EnumDeclarationSyntax syntax, PackageSymbol package)
    {
        var name = syntax.Identifier.Text;

        if (isPrimitiveTypeName(name))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
            return null;
        }

        var accessibility = resolveAccessibility(syntax.AccessibilityModifier);
        var enumSymbol = new EnumSymbol(name, accessibility, package.Name, syntax);
        Binder.AttachDocumentation(enumSymbol, syntax);
        enumSymbol.SetAttributes(BindAttributes(
            syntax.Annotations,
            AttributeTargetKind.Type,
            Binder.TypeDeclarationAllowedTargets,
            "an enum declaration",
            System.AttributeTargets.Enum));

        var seenMemberNames = new HashSet<string>();
        var members = ImmutableArray.CreateBuilder<EnumMemberSymbol>();
        foreach (var memberSyntax in syntax.Members)
        {
            var memberName = memberSyntax.Identifier.Text;
            if (!seenMemberNames.Add(memberName))
            {
                Diagnostics.ReportDuplicateEnumMember(memberSyntax.Identifier.Location, memberName, name);
                continue;
            }

            var memberSymbol = new EnumMemberSymbol(memberName, enumSymbol, members.Count);
            Binder.AttachDocumentation(memberSymbol, memberSyntax);

            // Issue #188 / ADR-0047 §3: bind any `@Foo` annotations attached
            // to the enum-member entry with default target `field` (enum
            // members are emitted as static literal fields on the enum type
            // per ECMA-335 §I.8.5.2), so #175 use-site diagnostics
            // (e.g. `@Obsolete`) fire on `Color.Red` references.
            if (!memberSyntax.Annotations.IsDefaultOrEmpty)
            {
                memberSymbol.SetAttributes(BindAttributes(
                    memberSyntax.Annotations,
                    AttributeTargetKind.Field,
                    Binder.VariableDeclarationAllowedTargets,
                    "an enum member declaration",
                    System.AttributeTargets.Field));
            }

            members.Add(memberSymbol);
        }

        if (members.Count == 0)
        {
            Diagnostics.ReportEmptyEnumDeclaration(syntax.Identifier.Location, name);
        }

        enumSymbol.SetMembers(members.ToImmutable());

        if (!scope.TryDeclareTypeAlias(name, enumSymbol))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
        }

        return enumSymbol;
    }

    internal StructSymbol BindStructDeclaration(StructDeclarationSyntax syntax, PackageSymbol package)
    {
        var name = syntax.Identifier.Text;

        if (isPrimitiveTypeName(name))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
            return null;
        }

        var accessibility = resolveAccessibility(syntax.AccessibilityModifier);

        // Phase 4.3 / ADR-0020: bind the optional type-parameter list FIRST so
        // field/parameter types in the body can reference T, U, etc.
        var previousTypeParameters = binderCtx.CurrentTypeParameters;
        ImmutableArray<TypeParameterSymbol> typeParameters = ImmutableArray<TypeParameterSymbol>.Empty;
        try
        {
            if (syntax.TypeParameterList != null)
            {
                binderCtx.CurrentTypeParameters = new Dictionary<string, TypeParameterSymbol>();
                typeParameters = BindTypeParameterList(syntax.TypeParameterList);
                foreach (var tp in typeParameters)
                {
                    binderCtx.CurrentTypeParameters[tp.Name] = tp;
                }
            }

            return BindStructDeclarationBody(syntax, package, accessibility, name, typeParameters);
        }
        finally
        {
            binderCtx.CurrentTypeParameters = previousTypeParameters;
        }
    }

    private StructSymbol BindStructDeclarationBody(
        StructDeclarationSyntax syntax,
        PackageSymbol package,
        Accessibility accessibility,
        string name,
        ImmutableArray<TypeParameterSymbol> typeParameters)
    {
        var seenFieldNames = new HashSet<string>();
        var fields = ImmutableArray.CreateBuilder<FieldSymbol>();

        // Phase 3.B.3 sub-step 2: Kotlin-style primary constructor parameters
        // declare fields of the same name + type, in source order, in addition
        // to becoming the ctor's parameters.
        var primaryCtorParameters = ImmutableArray<ParameterSymbol>.Empty;
        if (syntax.HasPrimaryConstructor)
        {
            var ctorBuilder = ImmutableArray.CreateBuilder<ParameterSymbol>();
            foreach (var paramSyntax in syntax.PrimaryConstructorParameters)
            {
                var paramName = paramSyntax.Identifier.Text;
                var paramType = bindTypeClause(paramSyntax.Type);
                if (paramType == null)
                {
                    continue;
                }

                // ADR-0101 follow-up / issue #819: variadic primary-constructor
                // parameters promote to a `[]T` auto-field of the same name.
                // Inside the body the parameter is `[]T`; at call sites the
                // trailing arguments are packed by
                // `OverloadResolver.BindConstructorCallExpression`. The
                // structural rules (at-most-one, last position) are validated
                // by `ValidateVariadicParameterShape` after this loop.
                var isVariadic = paramSyntax.IsVariadic;
                if (isVariadic && paramType != TypeSymbol.Error)
                {
                    paramType = SliceTypeSymbol.Get(paramType);
                }

                if (!seenFieldNames.Add(paramName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(paramSyntax.Identifier.Location, paramName);
                    continue;
                }

                // Issue #367: a by-ref-like (`ref struct`) value cannot live in a
                // field of a non-ref-struct, because the containing instance may
                // be heap-allocated. A primary-constructor parameter materializes
                // a field, so reject it here as well. A `ref struct` may itself
                // hold by-ref-like fields (it is stack-only too), so this is only
                // enforced when the containing type is not a ref struct.
                if (!syntax.IsRef && TypeSymbol.IsByRefLike(paramType))
                {
                    Diagnostics.ReportByRefLikeEscape(paramSyntax.Identifier.Location, paramType, $"be used as the type of field '{paramName}'");
                    continue;
                }

                // ADR-0039 §4 / ADR-0058: a managed pointer (*T) cannot be a field type —
                // CLR metadata does not permit ELEMENT_TYPE_BYREF in FieldDef signatures.
                if (paramType is ByRefTypeSymbol byRefParamType)
                {
                    Diagnostics.ReportPointerTypeCannotBeFieldType(paramSyntax.Identifier.Location, byRefParamType.Name);
                    continue;
                }

                // ADR-0060: a primary-constructor parameter materializes a field of the
                // same name; a `ref`/`out`/`in` modifier on that slot is meaningless (the
                // CLR cannot store a managed pointer in a field). Reject early so the
                // user sees one clear diagnostic instead of a downstream emit failure.
                if (paramSyntax.HasRefKindModifier)
                {
                    Diagnostics.ReportRefKindOnPrimaryCtorParameter(paramSyntax.RefKindModifier.Location, paramName);
                }

                var primaryCtorParam = new ParameterSymbol(paramName, paramType, isVariadic, declaringSyntax: paramSyntax.Identifier, isScoped: paramSyntax.IsScoped);
                conversions.BindAndAttachParameterDefaultValue(paramSyntax, primaryCtorParam);
                ctorBuilder.Add(primaryCtorParam);
                fields.Add(new FieldSymbol(paramName, paramType, Accessibility.Public, isReadOnly: syntax.IsInline));
            }

            // ADR-0101 follow-up / issue #819: at most one variadic primary-ctor
            // parameter (`GS0364`) and it must be the last (`GS0145`). Validation
            // runs over the raw syntax so multi-variadic / non-last variadic
            // signatures still get a diagnostic even when one of the parameters
            // failed type binding above.
            ValidateVariadicParameterShape(syntax.PrimaryConstructorParameters);

            primaryCtorParameters = ctorBuilder.ToImmutable();
        }

        // Issue #640: collect instance-field initializer expressions alongside
        // the field declarations so we can bind them later (after the struct
        // symbol exists) and emit them into every constructor body.
        var pendingInstanceInitializers = new List<(FieldSymbol Field, ExpressionSyntax InitSyntax, TypeSymbol FieldType)>();

        foreach (var fieldSyntax in syntax.Fields)
        {
            var fieldName = fieldSyntax.Identifier.Text;
            if (!seenFieldNames.Add(fieldName))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(fieldSyntax.Identifier.Location, fieldName);
                continue;
            }

            var fieldType = bindTypeClause(fieldSyntax.Type);
            if (fieldType == null)
            {
                continue;
            }

            // Issue #367: a by-ref-like (`ref struct`) value cannot be stored in
            // a field of a non-ref-struct (the containing instance may be boxed
            // or heap-allocated). A `ref struct` is itself stack-only, so it may
            // hold by-ref-like fields; only enforce this for non-ref-structs.
            if (!syntax.IsRef && TypeSymbol.IsByRefLike(fieldType))
            {
                Diagnostics.ReportByRefLikeEscape(fieldSyntax.Identifier.Location, fieldType, $"be used as the type of field '{fieldName}'");
                continue;
            }

            // ADR-0039 §4 / ADR-0058: a managed pointer (*T) cannot be a field type —
            // CLR metadata does not permit ELEMENT_TYPE_BYREF in FieldDef signatures.
            if (fieldType is ByRefTypeSymbol byRefFieldType)
            {
                Diagnostics.ReportPointerTypeCannotBeFieldType(fieldSyntax.Identifier.Location, byRefFieldType.Name);
                continue;
            }

            var fieldAccessibility = resolveAccessibility(fieldSyntax.AccessibilityModifier);
            var fieldSymbol = new FieldSymbol(fieldName, fieldType, fieldAccessibility, isReadOnly: syntax.IsInline || fieldSyntax.IsReadOnly);
            Binder.AttachDocumentation(fieldSymbol, fieldSyntax);

            // Issue #186 / ADR-0047 §3: bind any `@Foo` annotations attached
            // to the field declaration with default target `field` so #175
            // use-site diagnostics (e.g. `@Obsolete`) fire on field reads
            // and writes, and #170-style `CustomAttribute` rows are emitted
            // onto the FieldDef.
            if (!fieldSyntax.Annotations.IsDefaultOrEmpty)
            {
                fieldSymbol.SetAttributes(BindAttributes(
                    fieldSyntax.Annotations,
                    AttributeTargetKind.Field,
                    Binder.FieldDeclarationAllowedTargets,
                    "a field declaration",
                    System.AttributeTargets.Field));
            }

            // Issue #640: remember the initializer syntax for binding after
            // the struct symbol is created (we need the struct in scope for
            // type-correct binding, and the field symbol is needed for keying).
            if (fieldSyntax.Initializer != null)
            {
                pendingInstanceInitializers.Add((fieldSymbol, fieldSyntax.Initializer, fieldType));
            }

            fields.Add(fieldSymbol);
        }

        if (syntax.IsData && fields.Count == 0)
        {
            Diagnostics.ReportEmptyDataStruct(syntax.Identifier.Location, name);
        }

        if (syntax.IsInline)
        {
            if (syntax.IsData)
            {
                Diagnostics.ReportInlineCannotBeCombinedWithData(syntax.InlineKeyword.Location);
            }

            if (syntax.IsOpen)
            {
                Diagnostics.ReportInlineCannotBeCombinedWithOpen(syntax.OpenModifier.Location);
            }

            if (fields.Count != 1)
            {
                Diagnostics.ReportInlineStructRequiresExactlyOneField(syntax.Identifier.Location, name, fields.Count);
            }
        }

        // Phase 4 of #141 / ADR-0047 §5: detect the `@Attribute` declaration
        // sugar marker before resolving the base clause so we can tolerate
        // an explicit `: System.Attribute` (redundant restatement) and reject
        // any conflicting explicit base.
        var hasAttributeSugar = HasAttributeSugarMarker(syntax.Annotations);

        // Phase 3.B.3 sub-step 3 + 3.B.4: resolve the optional `: X, Y, Z` clause.
        // Each identifier is either the (single) base class or an interface
        // implemented by this class. A base class, if present, must be the
        // first identifier. Declaration order rules apply: base/interfaces
        // must be declared before this type.
        StructSymbol baseClassSymbol = null;
        TypeSymbol importedBaseType = null;
        var implementedInterfaces = ImmutableArray.CreateBuilder<InterfaceSymbol>();
        var implementedClrInterfaces = ImmutableArray.CreateBuilder<TypeSymbol>();
        if (syntax.HasBaseType)
        {
            if (!syntax.IsClass)
            {
                Diagnostics.ReportUnexpectedToken(syntax.BaseColonToken.Location, SyntaxKind.ColonToken, SyntaxKind.OpenBraceToken);
            }
            else
            {
                var allBaseTypes = ImmutableArray.CreateBuilder<TypeClauseSyntax>();
                if (syntax.BaseTypeClauses.Count > 0)
                {
                    for (var bi = 0; bi < syntax.BaseTypeClauses.Count; bi++)
                    {
                        allBaseTypes.Add(syntax.BaseTypeClauses[bi]);
                    }
                }

                // Back-compat for older syntax trees that only populated
                // identifier tokens in the base/interface clause.
                if (allBaseTypes.Count == 0 && syntax.BaseTypeIdentifier != null)
                {
                    allBaseTypes.Add(new TypeClauseSyntax(syntax.SyntaxTree, syntax.BaseTypeIdentifier));
                    if (!syntax.AdditionalBaseTypeIdentifiers.IsDefaultOrEmpty)
                    {
                        foreach (var token in syntax.AdditionalBaseTypeIdentifiers)
                        {
                            if (token != null)
                            {
                                allBaseTypes.Add(new TypeClauseSyntax(syntax.SyntaxTree, token));
                            }
                        }
                    }
                }

                for (var i = 0; i < allBaseTypes.Count; i++)
                {
                    var baseTypeSyntax = allBaseTypes[i];
                    var baseName = GetBaseClauseTypeDisplayName(baseTypeSyntax);
                    var baseLocation = baseTypeSyntax.Identifier?.Location ?? syntax.Identifier.Location;

                    // Phase 4 of #141: tolerate an explicit `: Attribute` on an
                    // @Attribute-marked class (redundant restatement). The
                    // System.Attribute base is supplied by the emitter.
                    if (hasAttributeSugar && i == 0
                        && !baseTypeSyntax.HasTypeArguments
                        && (baseName == "Attribute" || baseName == "System.Attribute"))
                    {
                        continue;
                    }

                    var resolved = bindTypeClause(baseTypeSyntax);
                    if (resolved == null || resolved == TypeSymbol.Error)
                    {
                        continue;
                    }

                    if (resolved is InterfaceSymbol iface)
                    {
                        if (iface.IsGenericDefinition)
                        {
                            Diagnostics.ReportWrongTypeArgumentCount(baseLocation, baseName, iface.TypeParameters.Length, 0);
                            continue;
                        }

                        implementedInterfaces.Add(iface);
                        continue;
                    }

                    if (resolved is StructSymbol baseStruct && baseStruct.IsClass)
                    {
                        if (baseStruct.IsGenericDefinition)
                        {
                            Diagnostics.ReportWrongTypeArgumentCount(baseLocation, baseName, baseStruct.TypeParameters.Length, 0);
                            continue;
                        }

                        if (i != 0)
                        {
                            Diagnostics.ReportUnableToFindType(baseLocation, baseName);
                            continue;
                        }

                        if (hasAttributeSugar)
                        {
                            // Phase 4 of #141 / ADR-0047 §5: @Attribute sugar
                            // forces System.Attribute as the base; conflict.
                            Diagnostics.ReportAttributeClassExplicitBase(baseLocation, baseName);
                            continue;
                        }

                        if (!baseStruct.IsOpen && !baseStruct.IsSealedHierarchy)
                        {
                            Diagnostics.ReportBaseClassNotOpen(baseLocation, baseName);
                            continue;
                        }

                        baseClassSymbol = baseStruct;
                        continue;
                    }

                    if (resolved.ClrType != null)
                    {
                        var clrType = resolved.ClrType;
                        if (clrType.IsGenericTypeDefinition)
                        {
                            Diagnostics.ReportWrongTypeArgumentCount(
                                baseLocation,
                                baseName,
                                clrType.GetGenericArguments().Length,
                                0);
                            continue;
                        }

                        if (clrType.IsInterface)
                        {
                            implementedClrInterfaces.Add(resolved);
                            continue;
                        }

                        if (clrType.IsClass && !clrType.IsSealed)
                        {
                            if (i != 0)
                            {
                                Diagnostics.ReportUnableToFindType(baseLocation, baseName);
                                continue;
                            }

                            if (hasAttributeSugar)
                            {
                                Diagnostics.ReportAttributeClassExplicitBase(baseLocation, baseName);
                                continue;
                            }

                            importedBaseType = resolved;
                            continue;
                        }
                    }

                    Diagnostics.ReportUnableToFindType(baseLocation, baseName);
                }
            }
        }

        var structSymbol = new StructSymbol(
            name,
            fields.ToImmutable(),
            accessibility,
            syntax,
            package.Name,
            syntax.IsData,
            syntax.IsInline,
            syntax.IsClass,
            primaryCtorParameters,
            isOpen: syntax.IsOpen && syntax.IsClass,
            baseClass: baseClassSymbol);
        Binder.AttachDocumentation(structSymbol, syntax);

        if (!typeParameters.IsDefaultOrEmpty)
        {
            structSymbol.SetTypeParameters(typeParameters);
        }

        structSymbol.SetAttributes(BindAttributes(
            syntax.Annotations,
            AttributeTargetKind.Type,
            Binder.TypeDeclarationAllowedTargets,
            syntax.IsClass ? "a class declaration" : "a struct declaration",
            syntax.IsClass ? System.AttributeTargets.Class : System.AttributeTargets.Struct));

        // ADR-0093 / issue #759: parse `@StructLayout(LayoutKind.…)` on
        // the type and `@FieldOffset(N)` on each field; write the resolved
        // values onto the struct/field symbols so the emitter can pick
        // the right CLR TypeAttributes flag and emit the matching
        // ClassLayout / FieldLayout rows.
        StructLayoutBinder.ResolveLayoutAndFieldOffsets(structSymbol, Diagnostics);

        if (hasAttributeSugar && syntax.IsClass)
        {
            // Phase 4 of #141 / ADR-0047 §5: tag the class so the emitter
            // overrides its CLR base type to System.Attribute.
            structSymbol.SetIsAttributeClass();
        }

        if (importedBaseType != null)
        {
            // Issue #296: record the imported CLR base class so the emitter
            // writes it as the TypeDef base type, chains the generated ctor to
            // the CLR base's parameterless ctor, and member lookup walks into
            // the CLR base for inherited members.
            structSymbol.SetImportedBaseType(importedBaseType);
        }

        // Issue #306: bind and resolve an explicit base-constructor initializer
        // (`: Base(args)`). The arguments are bound in a scope that exposes the
        // primary-constructor parameters so they can be forwarded to the base.
        BindBaseConstructorInitializer(syntax, structSymbol, baseClassSymbol, importedBaseType, primaryCtorParameters);

        // Issue #640: now that the struct symbol exists, bind the deferred
        // instance-field initializer expressions and install them on the symbol.
        if (pendingInstanceInitializers.Count > 0)
        {
            var instanceInitBuilder = ImmutableDictionary.CreateBuilder<FieldSymbol, BoundExpression>();
            foreach (var (fieldSym, initSyntax, fieldType) in pendingInstanceInitializers)
            {
                var boundInit = bindExpression(initSyntax);
                var convertedInit = conversions.BindConversion(initSyntax.Location, boundInit, fieldType);
                instanceInitBuilder[fieldSym] = convertedInit;
            }

            structSymbol.SetInstanceFieldInitializers(instanceInitBuilder.ToImmutable());
        }

        if (!scope.TryDeclareTypeAlias(name, structSymbol))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
        }

        // Collect existing member names for duplicate detection across fields,
        // methods, and properties.
        var existingNames = new HashSet<string>();
        foreach (var f in structSymbol.Fields)
        {
            existingNames.Add(f.Name);
        }

        // Phase 3.B.3 sub-step 2b: bind methods declared inside the class body.
        // Issue #938 / ADR-0079: in-body methods are the canonical declaration
        // site for owned `class` AND owned `struct`/`data struct` instance
        // methods. Each method becomes a FunctionSymbol with
        // ReceiverType = structSymbol; method bodies are bound later by
        // BindProgram by walking StructSymbol.Methods. For value-type receivers
        // the emitter synthesizes a by-ref `this`, identical to the
        // receiver-clause owned-struct method lowering.
        if (!syntax.Methods.IsDefaultOrEmpty)
        {
            var methodsBuilder = ImmutableArray.CreateBuilder<FunctionSymbol>();
            foreach (var methodSyntax in syntax.Methods)
            {
                var methodName = methodSyntax.Identifier.Text;

                // Issue #938 / ADR-0029: inline and data structs synthesize a
                // fixed set of members (Equals, GetHashCode, ToString,
                // op_Equality, op_Inequality, Deconstruct). User code may not
                // hand-write any of them via the in-body form either — this
                // mirrors the receiver-clause guard below so both spellings of
                // an owned-struct instance method reject the same collisions.
                if (structSymbol.IsInline && IsInlineSynthesizedMemberName(methodName))
                {
                    Diagnostics.ReportInlineStructSynthesizedMemberConflict(methodSyntax.Identifier.Location, structSymbol.Name, methodName);
                    continue;
                }

                if (structSymbol.IsData && IsDataStructSynthesizedMemberName(methodName))
                {
                    Diagnostics.ReportDataStructSynthesizedMemberConflict(methodSyntax.Identifier.Location, structSymbol.Name, methodName);
                    continue;
                }

                // ADR-0063: allow same-name overloads on a class body. The duplicate
                // check is replaced by a signature-identity check applied below, after
                // the parameter list has been bound. A name collision with an existing
                // field or non-method member is still rejected here.
                if (structSymbol.TryGetField(methodName, out _))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(methodSyntax.Identifier.Location, methodName);
                    continue;
                }

                // Issue #312 / ADR-0020: a method may declare its own generic
                // type-parameter list (`func M[T](...) T`). Bind it first and
                // seed it into the binding scope — merged with any enclosing
                // class type parameters — so the method's parameter types,
                // return type, and (later) body can reference `T`. The seeding
                // is unwound at the end of each iteration so one method's type
                // parameters never leak into the next or the surrounding type.
                var methodTypeParameters = BindTypeParameterList(methodSyntax.TypeParameterList);
                var enclosingTypeParameters = binderCtx.CurrentTypeParameters;
                if (!methodTypeParameters.IsDefaultOrEmpty)
                {
                    binderCtx.CurrentTypeParameters = enclosingTypeParameters == null
                        ? new Dictionary<string, TypeParameterSymbol>()
                        : new Dictionary<string, TypeParameterSymbol>(enclosingTypeParameters);
                    foreach (var tp in methodTypeParameters)
                    {
                        binderCtx.CurrentTypeParameters[tp.Name] = tp;
                    }
                }

                try
                {
                    var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>();
                    var seenParameterNames = new HashSet<string>();
                    for (var pIndex = 0; pIndex < methodSyntax.Parameters.Count; pIndex++)
                    {
                        var parameterSyntax = methodSyntax.Parameters[pIndex];
                        var parameterName = parameterSyntax.Identifier.Text;
                        var parameterType = bindTypeClause(parameterSyntax.Type) ?? TypeSymbol.Error;

                        // ADR-0101 follow-up / issue #812: variadic parameters
                        // are now accepted on class instance methods. The body
                        // sees the parameter as a `[]T` slice; the call site
                        // packs trailing arguments into a fresh slice (or
                        // passes through a single `[]T` argument unchanged) —
                        // see OverloadResolver.BindUserInstanceCall.
                        var isVariadic = parameterSyntax.IsVariadic;
                        if (isVariadic && parameterType != TypeSymbol.Error)
                        {
                            parameterType = SliceTypeSymbol.Get(parameterType);
                        }

                        var parameterRefKind = conversions.BindAndValidateParameterRefKind(
                            parameterSyntax,
                            parameterName,
                            parameterType,
                            isVariadic,
                            asyncOrIteratorKind: methodSyntax.IsAsync ? "async" : null);

                        if (!seenParameterNames.Add(parameterName))
                        {
                            Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
                        }
                        else
                        {
                            var classMethodParam = new ParameterSymbol(parameterName, parameterType, isVariadic, declaringSyntax: parameterSyntax.Identifier, isScoped: parameterSyntax.IsScoped, refKind: parameterRefKind);
                            conversions.BindAndAttachParameterDefaultValue(parameterSyntax, classMethodParam);
                            parameters.Add(classMethodParam);
                        }
                    }

                    ValidateVariadicParameterShape(methodSyntax.Parameters);

                    var returnType = bindReturnTypeClause(methodSyntax.Type, methodSyntax.IsAsync) ?? TypeSymbol.Void;
                    var methodAccessibility = resolveAccessibility(methodSyntax.AccessibilityModifier);
                    var methodParameters = parameters.ToImmutable();
                    var methodReturnRefKind = ValidateReturnRefKind(methodSyntax, returnType);

                    // Phase 3.B.3 sub-step 3: open/override validation against
                    // base class chain per ADR-0017.
                    FunctionSymbol overriddenMethod = null;
                    if (methodSyntax.IsOverride)
                    {
                        // ADR-0063 §8: when the base exposes a name-overload set, the
                        // override targets the entry whose signature matches exactly;
                        // an unrelated same-name overload no longer steals the slot.
                        var baseOverloads = structSymbol.BaseClass?.GetMethodsIncludingInherited(methodName)
                            ?? System.Collections.Immutable.ImmutableArray<FunctionSymbol>.Empty;
                        FunctionSymbol baseMethod = null;
                        FunctionSymbol baseSignatureMatch = null;
                        foreach (var candidate in baseOverloads)
                        {
                            baseMethod ??= candidate;
                            if (SignaturesMatch(candidate, methodParameters, returnType, methodReturnRefKind))
                            {
                                baseSignatureMatch = candidate;
                                break;
                            }
                        }

                        if (baseMethod == null)
                        {
                            Diagnostics.ReportNoBaseMethodToOverride(methodSyntax.Identifier.Location, methodName);
                        }
                        else if (baseSignatureMatch != null)
                        {
                            if (!baseSignatureMatch.IsOpen)
                            {
                                Diagnostics.ReportOverrideOfSealedMethod(methodSyntax.Identifier.Location, methodName);
                            }
                            else
                            {
                                overriddenMethod = baseSignatureMatch;
                            }
                        }
                        else if (!baseMethod.IsOpen)
                        {
                            Diagnostics.ReportOverrideOfSealedMethod(methodSyntax.Identifier.Location, methodName);
                        }
                        else
                        {
                            // No matching overload signature: surface the most specific
                            // diagnostic against the first (this-first) base overload to
                            // preserve the existing error message shape.
                            if (baseMethod.Type == returnType && baseMethod.ReturnRefKind != methodReturnRefKind)
                            {
                                Diagnostics.ReportOverrideReturnRefKindMismatch(
                                    methodSyntax.Identifier.Location,
                                    methodName,
                                    baseMethod.ReturnRefKind == RefKind.Ref ? "by ref" : "by value",
                                    methodReturnRefKind == RefKind.Ref ? "by ref" : "by value");
                            }
                            else
                            {
                                var refMismatchIdx = FindRefKindMismatchIndex(baseMethod, methodParameters, returnType);
                                if (refMismatchIdx >= 0)
                                {
                                    var baseCallable = GetCallableParameters(baseMethod);
                                    Diagnostics.ReportOverrideRefKindMismatch(
                                        methodSyntax.Identifier.Location,
                                        methodName,
                                        methodParameters[refMismatchIdx].Name,
                                        refKindToString(baseCallable[refMismatchIdx].RefKind),
                                        refKindToString(methodParameters[refMismatchIdx].RefKind));
                                }
                                else
                                {
                                    Diagnostics.ReportOverrideSignatureMismatch(methodSyntax.Identifier.Location, methodName);
                                }
                            }
                        }
                    }
                    else if (structSymbol.BaseClass != null)
                    {
                        // ADR-0063 §8: only diagnose missing-override against a base
                        // overload whose signature is the same as the new declaration.
                        // A new same-name overload that does not match any base entry
                        // is a brand-new overload, not an accidental shadow.
                        var baseOverloads = structSymbol.BaseClass.GetMethodsIncludingInherited(methodName);
                        foreach (var shadowed in baseOverloads)
                        {
                            if (!shadowed.IsOpen)
                            {
                                continue;
                            }

                            if (SignaturesMatch(shadowed, methodParameters, returnType, methodReturnRefKind))
                            {
                                Diagnostics.ReportMissingOverride(methodSyntax.Identifier.Location, shadowed.ReceiverType.Name, methodName);
                                break;
                            }
                        }
                    }

                    var methodSymbol = new FunctionSymbol(
                        methodName,
                        methodParameters,
                        returnType,
                        methodSyntax,
                        package,
                        methodAccessibility,
                        receiverType: structSymbol,
                        isOpen: methodSyntax.IsOpen,
                        isOverride: methodSyntax.IsOverride);
                    methodSymbol.OverriddenMethod = overriddenMethod;
                    methodSymbol.TypeParameters = methodTypeParameters;
                    methodSymbol.ReturnRefKind = methodReturnRefKind;
                    methodSymbol.IsAsync = methodSyntax.IsAsync || isAsyncIteratorReturnType(returnType);
                    Binder.AttachDocumentation(methodSymbol, methodSyntax);

                    if (!methodSyntax.Annotations.IsDefaultOrEmpty)
                    {
                        var methodAttributes = BindAttributes(
                            methodSyntax.Annotations,
                            AttributeTargetKind.Method,
                            Binder.FunctionDeclarationAllowedTargets,
                            "a method declaration",
                            System.AttributeTargets.Method);
                        methodSymbol.SetAttributes(methodAttributes);
                        ValidateInlineDataNilArguments(methodAttributes, methodSymbol.Parameters);
                    }

                    // ADR-0063 §11: detect duplicate-signature within the class.
                    var hasDuplicateSig = false;
                    foreach (var existingMethod in methodsBuilder)
                    {
                        if (BoundScope.FunctionSignaturesEqual(existingMethod, methodSymbol))
                        {
                            Diagnostics.ReportDuplicateOverloadSignature(
                                methodSyntax.Identifier.Location,
                                methodName,
                                Binder.FormatOverloadSignature(methodSymbol));
                            hasDuplicateSig = true;
                            break;
                        }
                    }

                    if (!hasDuplicateSig)
                    {
                        methodsBuilder.Add(methodSymbol);
                    }
                }
                finally
                {
                    binderCtx.CurrentTypeParameters = enclosingTypeParameters;
                }
            }

            structSymbol.SetMethods(methodsBuilder.ToImmutable());
        }

        // ADR-0051: bind property declarations.
        if (!syntax.Properties.IsDefaultOrEmpty)
        {
            var propertiesBuilder = ImmutableArray.CreateBuilder<PropertySymbol>();
            foreach (var propSyntax in syntax.Properties)
            {
                var propName = propSyntax.Identifier.Text;

                // Check for duplicate names (fields + methods + other properties)
                if (!existingNames.Add(propName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(propSyntax.Identifier.Location, propName);
                    continue;
                }

                var propType = bindTypeClause(propSyntax.Type);
                if (propType == null)
                {
                    continue;
                }

                var propAccessibility = resolveAccessibility(propSyntax.AccessibilityModifier);

                // Determine accessor presence
                bool hasGetter = true;
                bool hasSetter;
                bool isAutoProperty;
                string setterParamName = "value";

                if (propSyntax.OpenBraceToken == null)
                {
                    // Bare auto-property: prop Name Type
                    hasSetter = true;
                    isAutoProperty = true;
                }
                else
                {
                    // Has body — check accessors
                    var getAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsGetter);
                    var setAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsSetter);
                    hasGetter = getAccessor != null || propSyntax.Accessors.IsDefaultOrEmpty;
                    hasSetter = setAccessor != null;

                    if (setAccessor != null && setAccessor.ParameterIdentifier != null)
                    {
                        setterParamName = setAccessor.ParameterIdentifier.Text;
                    }

                    // Auto-property if accessors have no bodies
                    isAutoProperty = (getAccessor == null || getAccessor.Body == null)
                                  && (setAccessor == null || setAccessor.Body == null)
                                  && propSyntax.Accessors.All(a => a.Body == null);
                }

                // Validate: auto-property not allowed on data struct
                if (isAutoProperty && syntax.IsData)
                {
                    Diagnostics.ReportAutoPropertyInDataStruct(propSyntax.Identifier.Location, propName);
                }

                // Validate: open only on open class
                bool isVirtual = propSyntax.OpenModifier != null;
                bool isOverride = propSyntax.OverrideModifier != null;

                if (isVirtual && !structSymbol.IsOpen)
                {
                    Diagnostics.ReportOpenMemberInNonOpenClass(propSyntax.OpenModifier.Location, propName);
                }

                // Validate: override needs base property
                PropertySymbol overriddenProperty = null;
                if (isOverride)
                {
                    if (structSymbol.BaseClass == null || !TypeMemberModel.TryGetProperty(structSymbol.BaseClass, propName, out var baseProp))
                    {
                        Diagnostics.ReportNoBaseMethodToOverride(propSyntax.Identifier.Location, propName);
                    }
                    else if (!baseProp.IsVirtual && !baseProp.IsOverride)
                    {
                        Diagnostics.ReportOverrideOfSealedMethod(propSyntax.Identifier.Location, propName);
                    }
                    else
                    {
                        overriddenProperty = baseProp;
                    }
                }

                var propertySymbol = new PropertySymbol(
                    propName,
                    propType,
                    propAccessibility,
                    hasGetter,
                    hasSetter,
                    isAutoProperty,
                    isVirtual,
                    isOverride,
                    setterParamName,
                    declaration: propSyntax);
                Binder.AttachDocumentation(propertySymbol, propSyntax);

                // Create backing field for auto-properties
                if (isAutoProperty && !syntax.IsData)
                {
                    var backingField = new FieldSymbol(
                        $"<{propName}>k__BackingField",
                        propType,
                        Accessibility.Private,
                        isReadOnly: !hasSetter);
                    propertySymbol.BackingField = backingField;
                }

                // Create FunctionSymbols for computed property accessors (ADR-0051).
                if (!isAutoProperty)
                {
                    var getAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsGetter);
                    var setAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsSetter);

                    if (hasGetter && getAccessor?.Body != null)
                    {
                        var getterSymbol = new FunctionSymbol(
                            $"get_{propName}",
                            ImmutableArray<ParameterSymbol>.Empty,
                            propType,
                            declaration: null,
                            package,
                            propAccessibility,
                            receiverType: structSymbol,
                            isOpen: isVirtual,
                            isOverride: isOverride);
                        propertySymbol.GetterSymbol = getterSymbol;
                        propertySymbol.GetterBodySyntax = getAccessor.Body;
                    }

                    if (hasSetter && setAccessor?.Body != null)
                    {
                        var setterParam = new ParameterSymbol(setterParamName, propType);
                        var setterSymbol = new FunctionSymbol(
                            $"set_{propName}",
                            ImmutableArray.Create(setterParam),
                            TypeSymbol.Void,
                            declaration: null,
                            package,
                            propAccessibility,
                            receiverType: structSymbol,
                            isOpen: isVirtual,
                            isOverride: isOverride);
                        propertySymbol.SetterSymbol = setterSymbol;
                        propertySymbol.SetterBodySyntax = setAccessor.Body;
                    }
                }

                // Bind annotations
                if (!propSyntax.Annotations.IsDefaultOrEmpty)
                {
                    propertySymbol.SetAttributes(BindAttributes(
                        propSyntax.Annotations,
                        AttributeTargetKind.Property,
                        Binder.PropertyDeclarationAllowedTargets,
                        "a property declaration",
                        System.AttributeTargets.Property));
                }

                propertiesBuilder.Add(propertySymbol);
            }

            structSymbol.SetProperties(propertiesBuilder.ToImmutable());
        }

        // ADR-0052: bind event declarations.
        if (!syntax.Events.IsDefaultOrEmpty)
        {
            var eventsBuilder = ImmutableArray.CreateBuilder<EventSymbol>();
            foreach (var eventSyntax in syntax.Events)
            {
                var eventName = eventSyntax.Identifier.Text;

                // Check for duplicate names
                if (!existingNames.Add(eventName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(eventSyntax.Identifier.Location, eventName);
                    continue;
                }

                var handlerType = bindTypeClause(eventSyntax.Type);
                if (handlerType == null)
                {
                    continue;
                }

                var eventAccessibility = resolveAccessibility(eventSyntax.AccessibilityModifier);
                bool isFieldLike = eventSyntax.OpenBraceToken == null;
                bool isVirtual = eventSyntax.OpenModifier != null;
                bool isOverride = eventSyntax.OverrideModifier != null;

                // Validate: open only on open class
                if (isVirtual && !structSymbol.IsOpen)
                {
                    Diagnostics.ReportOpenMemberInNonOpenClass(eventSyntax.OpenModifier.Location, eventName);
                }

                var eventSymbol = new EventSymbol(
                    eventName,
                    handlerType,
                    eventAccessibility,
                    isFieldLike,
                    isVirtual,
                    isOverride,
                    declaration: eventSyntax);
                Binder.AttachDocumentation(eventSymbol, eventSyntax);

                // Create backing field for field-like events
                if (isFieldLike)
                {
                    var backingField = new FieldSymbol(
                        eventName,
                        handlerType,
                        Accessibility.Private,
                        isReadOnly: false);
                    eventSymbol.BackingField = backingField;
                }
                else
                {
                    // Explicit accessors — store body syntax
                    var addAccessor = eventSyntax.Accessors.FirstOrDefault(a => a.IsAdd);
                    var removeAccessor = eventSyntax.Accessors.FirstOrDefault(a => a.IsRemove);
                    var raiseAccessor = eventSyntax.Accessors.FirstOrDefault(a => a.IsRaise);

                    if (addAccessor?.Body != null)
                    {
                        eventSymbol.AddBodySyntax = addAccessor.Body;
                    }

                    if (removeAccessor?.Body != null)
                    {
                        eventSymbol.RemoveBodySyntax = removeAccessor.Body;
                    }

                    if (raiseAccessor?.Body != null)
                    {
                        eventSymbol.RaiseBodySyntax = raiseAccessor.Body;
                    }
                }

                // Create add/remove method symbols
                var handlerParam = new ParameterSymbol("value", handlerType);
                eventSymbol.AddMethodSymbol = new FunctionSymbol(
                    $"add_{eventName}",
                    ImmutableArray.Create(handlerParam),
                    TypeSymbol.Void,
                    declaration: null,
                    package,
                    eventAccessibility,
                    receiverType: structSymbol,
                    isOpen: isVirtual,
                    isOverride: isOverride) { IsSpecialName = true };
                eventSymbol.RemoveMethodSymbol = new FunctionSymbol(
                    $"remove_{eventName}",
                    ImmutableArray.Create(handlerParam),
                    TypeSymbol.Void,
                    declaration: null,
                    package,
                    eventAccessibility,
                    receiverType: structSymbol,
                    isOpen: isVirtual,
                    isOverride: isOverride) { IsSpecialName = true };

                // Issue #257: create raise method symbol if raise accessor is present.
                if (eventSyntax.Accessors.Any(a => a.IsRaise))
                {
                    var raiseParams = ImmutableArray<ParameterSymbol>.Empty;
                    if (handlerType is FunctionTypeSymbol fnType)
                    {
                        var builder = ImmutableArray.CreateBuilder<ParameterSymbol>(fnType.ParameterTypes.Length);
                        for (int pi = 0; pi < fnType.ParameterTypes.Length; pi++)
                        {
                            builder.Add(new ParameterSymbol($"arg{pi}", fnType.ParameterTypes[pi]));
                        }

                        raiseParams = builder.ToImmutable();
                    }

                    eventSymbol.RaiseMethodSymbol = new FunctionSymbol(
                        $"raise_{eventName}",
                        raiseParams,
                        TypeSymbol.Void,
                        declaration: null,
                        package,
                        eventAccessibility,
                        receiverType: structSymbol,
                        isOpen: isVirtual,
                        isOverride: isOverride) { IsSpecialName = true };
                }

                // Bind annotations
                if (!eventSyntax.Annotations.IsDefaultOrEmpty)
                {
                    eventSymbol.SetAttributes(BindAttributes(
                        eventSyntax.Annotations,
                        AttributeTargetKind.Event,
                        Binder.EventDeclarationAllowedTargets,
                        "an event declaration",
                        System.AttributeTargets.Event));
                }

                eventsBuilder.Add(eventSymbol);
            }

            structSymbol.SetEvents(eventsBuilder.ToImmutable());
        }

        // ADR-0053: bind members declared inside the optional `shared { … }` block
        // as static members on the struct/class symbol.
        if (syntax.SharedBlock != null)
        {
            // Static fields
            var staticFieldsBuilder = ImmutableArray.CreateBuilder<FieldSymbol>();
            var initializersBuilder = ImmutableDictionary.CreateBuilder<FieldSymbol, BoundExpression>();
            foreach (var fieldSyntax in syntax.SharedBlock.Fields)
            {
                var fieldName = fieldSyntax.Identifier.Text;
                if (!existingNames.Add(fieldName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(fieldSyntax.Identifier.Location, fieldName);
                    continue;
                }

                var fieldType = bindTypeClause(fieldSyntax.Type);
                if (fieldType == null)
                {
                    continue;
                }

                // Issue #367: a by-ref-like (`ref struct`) value cannot be stored
                // in a static field (statics are rooted on the heap).
                if (TypeSymbol.IsByRefLike(fieldType))
                {
                    Diagnostics.ReportByRefLikeEscape(fieldSyntax.Identifier.Location, fieldType, $"be used as the type of field '{fieldName}'");
                    continue;
                }

                // ADR-0039 §4 / ADR-0058: a managed pointer (*T) cannot be a field type.
                if (fieldType is ByRefTypeSymbol byRefStaticFieldType)
                {
                    Diagnostics.ReportPointerTypeCannotBeFieldType(fieldSyntax.Identifier.Location, byRefStaticFieldType.Name);
                    continue;
                }

                var fieldAccessibility = resolveAccessibility(fieldSyntax.AccessibilityModifier);
                var fieldSymbol = new FieldSymbol(fieldName, fieldType, fieldAccessibility, isReadOnly: fieldSyntax.IsReadOnly, isStatic: true);

                if (!fieldSyntax.Annotations.IsDefaultOrEmpty)
                {
                    fieldSymbol.SetAttributes(BindAttributes(
                        fieldSyntax.Annotations,
                        AttributeTargetKind.Field,
                        Binder.FieldDeclarationAllowedTargets,
                        "a field declaration",
                        System.AttributeTargets.Field));
                }

                Binder.AttachDocumentation(fieldSymbol, fieldSyntax);

                // Issue #262: bind the initializer expression if present.
                if (fieldSyntax.Initializer != null)
                {
                    var boundInit = bindExpression(fieldSyntax.Initializer);
                    var convertedInit = conversions.BindConversion(fieldSyntax.Initializer.Location, boundInit, fieldType);
                    initializersBuilder[fieldSymbol] = convertedInit;
                }

                staticFieldsBuilder.Add(fieldSymbol);
            }

            structSymbol.SetStaticFields(staticFieldsBuilder.ToImmutable());
            if (initializersBuilder.Count > 0)
            {
                structSymbol.SetStaticFieldInitializers(initializersBuilder.ToImmutable());
            }

            // Static methods
            var staticMethodsBuilder = ImmutableArray.CreateBuilder<FunctionSymbol>();
            foreach (var methodSyntax in syntax.SharedBlock.Methods)
            {
                var methodName = methodSyntax.Identifier.Text;

                // ADR-0063: allow same-name overloads in a shared block; only reject
                // collision with a non-method member of the same name (field/property/event).
                if (existingNames.Contains(methodName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(methodSyntax.Identifier.Location, methodName);
                    continue;
                }

                // Issue #410 / ADR-0029: forbid user-written synthesized members
                // on data structs even when declared as shared/static methods.
                if (structSymbol.IsData && IsDataStructSynthesizedMemberName(methodName))
                {
                    Diagnostics.ReportDataStructSynthesizedMemberConflict(methodSyntax.Identifier.Location, structSymbol.Name, methodName);
                    continue;
                }

                if (structSymbol.IsInline && IsInlineSynthesizedMemberName(methodName))
                {
                    Diagnostics.ReportInlineStructSynthesizedMemberConflict(methodSyntax.Identifier.Location, structSymbol.Name, methodName);
                    continue;
                }

                // Issue #312 / ADR-0020: support generic static methods too.
                var methodTypeParameters = BindTypeParameterList(methodSyntax.TypeParameterList);
                var enclosingTypeParameters = binderCtx.CurrentTypeParameters;
                if (!methodTypeParameters.IsDefaultOrEmpty)
                {
                    binderCtx.CurrentTypeParameters = enclosingTypeParameters == null
                        ? new Dictionary<string, TypeParameterSymbol>()
                        : new Dictionary<string, TypeParameterSymbol>(enclosingTypeParameters);
                    foreach (var tp in methodTypeParameters)
                    {
                        binderCtx.CurrentTypeParameters[tp.Name] = tp;
                    }
                }

                try
                {
                    var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>();
                    var seenParameterNames = new HashSet<string>();
                    foreach (var parameterSyntax in methodSyntax.Parameters)
                    {
                        var parameterName = parameterSyntax.Identifier.Text;
                        var parameterType = bindTypeClause(parameterSyntax.Type) ?? TypeSymbol.Error;

                        // ADR-0101 follow-up / issue #812: variadic parameters
                        // are now accepted on shared/static class methods. The
                        // body sees the parameter as `[]T`; the static-call
                        // path goes through the same overload resolver that
                        // handles top-level variadic functions.
                        var isVariadic = parameterSyntax.IsVariadic;
                        if (isVariadic && parameterType != TypeSymbol.Error)
                        {
                            parameterType = SliceTypeSymbol.Get(parameterType);
                        }

                        var parameterRefKind = conversions.BindAndValidateParameterRefKind(
                            parameterSyntax,
                            parameterName,
                            parameterType,
                            isVariadic,
                            asyncOrIteratorKind: methodSyntax.IsAsync ? "async" : null);

                        if (!seenParameterNames.Add(parameterName))
                        {
                            Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
                        }
                        else
                        {
                            var staticMethodParam = new ParameterSymbol(parameterName, parameterType, isVariadic, declaringSyntax: parameterSyntax.Identifier, isScoped: parameterSyntax.IsScoped, refKind: parameterRefKind);
                            conversions.BindAndAttachParameterDefaultValue(parameterSyntax, staticMethodParam);
                            parameters.Add(staticMethodParam);
                        }
                    }

                    ValidateVariadicParameterShape(methodSyntax.Parameters);

                    var returnType = bindReturnTypeClause(methodSyntax.Type, methodSyntax.IsAsync) ?? TypeSymbol.Void;
                    var methodAccessibility = resolveAccessibility(methodSyntax.AccessibilityModifier);
                    var methodReturnRefKind = ValidateReturnRefKind(methodSyntax, returnType);

                    var methodSymbol = new FunctionSymbol(
                        methodName,
                        parameters.ToImmutable(),
                        returnType,
                        methodSyntax,
                        package,
                        methodAccessibility,
                        receiverType: null);
                    methodSymbol.IsStatic = true;
                    methodSymbol.StaticOwnerType = structSymbol;
                    methodSymbol.TypeParameters = methodTypeParameters;
                    methodSymbol.ReturnRefKind = methodReturnRefKind;
                    methodSymbol.IsAsync = methodSyntax.IsAsync || isAsyncIteratorReturnType(returnType);

                    if (!methodSyntax.Annotations.IsDefaultOrEmpty)
                    {
                        var methodAttributes = BindAttributes(
                            methodSyntax.Annotations,
                            AttributeTargetKind.Method,
                            Binder.FunctionDeclarationAllowedTargets,
                            "a method declaration",
                            System.AttributeTargets.Method);
                        methodSymbol.SetAttributes(methodAttributes);
                        ValidateInlineDataNilArguments(methodAttributes, methodSymbol.Parameters);
                    }

                    Binder.AttachDocumentation(methodSymbol, methodSyntax);

                    // ADR-0063 §11: detect duplicate-signature within the static block.
                    var hasDupSig = false;
                    foreach (var existingMethod in staticMethodsBuilder)
                    {
                        if (BoundScope.FunctionSignaturesEqual(existingMethod, methodSymbol))
                        {
                            Diagnostics.ReportDuplicateOverloadSignature(
                                methodSyntax.Identifier.Location,
                                methodName,
                                Binder.FormatOverloadSignature(methodSymbol));
                            hasDupSig = true;
                            break;
                        }
                    }

                    if (!hasDupSig)
                    {
                        staticMethodsBuilder.Add(methodSymbol);
                    }
                }
                finally
                {
                    binderCtx.CurrentTypeParameters = enclosingTypeParameters;
                }
            }

            structSymbol.SetStaticMethods(staticMethodsBuilder.ToImmutable());

            // Static properties
            var staticPropertiesBuilder = ImmutableArray.CreateBuilder<PropertySymbol>();
            foreach (var propSyntax in syntax.SharedBlock.Properties)
            {
                var propName = propSyntax.Identifier.Text;
                if (!existingNames.Add(propName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(propSyntax.Identifier.Location, propName);
                    continue;
                }

                var propType = bindTypeClause(propSyntax.Type);
                if (propType == null)
                {
                    continue;
                }

                var propAccessibility = resolveAccessibility(propSyntax.AccessibilityModifier);
                bool hasGetter = true;
                bool hasSetter;
                bool isAutoProperty;
                string setterParamName = "value";

                if (propSyntax.OpenBraceToken == null)
                {
                    hasSetter = true;
                    isAutoProperty = true;
                }
                else
                {
                    var getAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsGetter);
                    var setAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsSetter);
                    hasGetter = getAccessor != null || propSyntax.Accessors.IsDefaultOrEmpty;
                    hasSetter = setAccessor != null;

                    if (setAccessor != null && setAccessor.ParameterIdentifier != null)
                    {
                        setterParamName = setAccessor.ParameterIdentifier.Text;
                    }

                    isAutoProperty = (getAccessor == null || getAccessor.Body == null)
                                  && (setAccessor == null || setAccessor.Body == null)
                                  && propSyntax.Accessors.All(a => a.Body == null);
                }

                var propertySymbol = new PropertySymbol(
                    propName,
                    propType,
                    propAccessibility,
                    hasGetter,
                    hasSetter,
                    isAutoProperty,
                    isVirtual: false,
                    isOverride: false,
                    setterParamName,
                    isStatic: true,
                    declaration: propSyntax);

                if (isAutoProperty)
                {
                    var backingField = new FieldSymbol(
                        $"<{propName}>k__BackingField",
                        propType,
                        Accessibility.Private,
                        isReadOnly: !hasSetter,
                        isStatic: true);
                    propertySymbol.BackingField = backingField;
                }

                // Issue #263: create FunctionSymbols for computed static property accessors.
                if (!isAutoProperty)
                {
                    var getAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsGetter);
                    var setAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsSetter);

                    if (hasGetter && getAccessor?.Body != null)
                    {
                        var getterSymbol = new FunctionSymbol(
                            $"get_{propName}",
                            ImmutableArray<ParameterSymbol>.Empty,
                            propType,
                            declaration: null,
                            package,
                            propAccessibility,
                            receiverType: null);
                        getterSymbol.IsStatic = true;
                        getterSymbol.StaticOwnerType = structSymbol;
                        propertySymbol.GetterSymbol = getterSymbol;
                        propertySymbol.GetterBodySyntax = getAccessor.Body;
                    }

                    if (hasSetter && setAccessor?.Body != null)
                    {
                        var setterParam = new ParameterSymbol(setterParamName, propType);
                        var setterSymbol = new FunctionSymbol(
                            $"set_{propName}",
                            ImmutableArray.Create(setterParam),
                            TypeSymbol.Void,
                            declaration: null,
                            package,
                            propAccessibility,
                            receiverType: null);
                        setterSymbol.IsStatic = true;
                        setterSymbol.StaticOwnerType = structSymbol;
                        propertySymbol.SetterSymbol = setterSymbol;
                        propertySymbol.SetterBodySyntax = setAccessor.Body;
                    }
                }

                if (!propSyntax.Annotations.IsDefaultOrEmpty)
                {
                    propertySymbol.SetAttributes(BindAttributes(
                        propSyntax.Annotations,
                        AttributeTargetKind.Property,
                        Binder.PropertyDeclarationAllowedTargets,
                        "a property declaration",
                        System.AttributeTargets.Property));
                }

                Binder.AttachDocumentation(propertySymbol, propSyntax);

                staticPropertiesBuilder.Add(propertySymbol);
            }

            structSymbol.SetStaticProperties(staticPropertiesBuilder.ToImmutable());

            // Static events
            var staticEventsBuilder = ImmutableArray.CreateBuilder<EventSymbol>();
            foreach (var eventSyntax in syntax.SharedBlock.Events)
            {
                var eventName = eventSyntax.Identifier.Text;
                if (!existingNames.Add(eventName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(eventSyntax.Identifier.Location, eventName);
                    continue;
                }

                var handlerType = bindTypeClause(eventSyntax.Type);
                if (handlerType == null)
                {
                    continue;
                }

                var eventAccessibility = resolveAccessibility(eventSyntax.AccessibilityModifier);
                bool isFieldLike = eventSyntax.OpenBraceToken == null;

                var eventSymbol = new EventSymbol(
                    eventName,
                    handlerType,
                    eventAccessibility,
                    isFieldLike,
                    isVirtual: false,
                    isOverride: false,
                    isStatic: true,
                    declaration: eventSyntax);

                if (isFieldLike)
                {
                    var backingField = new FieldSymbol(
                        eventName,
                        handlerType,
                        Accessibility.Private,
                        isReadOnly: false,
                        isStatic: true);
                    eventSymbol.BackingField = backingField;
                }
                else
                {
                    // Issue #257: store explicit accessor bodies for static events.
                    var addAccessor = eventSyntax.Accessors.FirstOrDefault(a => a.IsAdd);
                    var removeAccessor = eventSyntax.Accessors.FirstOrDefault(a => a.IsRemove);
                    var raiseAccessor = eventSyntax.Accessors.FirstOrDefault(a => a.IsRaise);

                    if (addAccessor?.Body != null)
                    {
                        eventSymbol.AddBodySyntax = addAccessor.Body;
                    }

                    if (removeAccessor?.Body != null)
                    {
                        eventSymbol.RemoveBodySyntax = removeAccessor.Body;
                    }

                    if (raiseAccessor?.Body != null)
                    {
                        eventSymbol.RaiseBodySyntax = raiseAccessor.Body;
                    }
                }

                var handlerParam = new ParameterSymbol("value", handlerType);
                eventSymbol.AddMethodSymbol = new FunctionSymbol(
                    $"add_{eventName}",
                    ImmutableArray.Create(handlerParam),
                    TypeSymbol.Void,
                    declaration: null,
                    package,
                    eventAccessibility,
                    receiverType: null) { IsSpecialName = true };
                eventSymbol.AddMethodSymbol.IsStatic = true;
                eventSymbol.RemoveMethodSymbol = new FunctionSymbol(
                    $"remove_{eventName}",
                    ImmutableArray.Create(handlerParam),
                    TypeSymbol.Void,
                    declaration: null,
                    package,
                    eventAccessibility,
                    receiverType: null) { IsSpecialName = true };
                eventSymbol.RemoveMethodSymbol.IsStatic = true;

                // Issue #257: create raise method symbol if raise accessor is present.
                if (eventSyntax.Accessors.Any(a => a.IsRaise))
                {
                    var raiseParams = ImmutableArray<ParameterSymbol>.Empty;
                    if (handlerType is FunctionTypeSymbol fnType)
                    {
                        var builder = ImmutableArray.CreateBuilder<ParameterSymbol>(fnType.ParameterTypes.Length);
                        for (int pi = 0; pi < fnType.ParameterTypes.Length; pi++)
                        {
                            builder.Add(new ParameterSymbol($"arg{pi}", fnType.ParameterTypes[pi]));
                        }

                        raiseParams = builder.ToImmutable();
                    }

                    eventSymbol.RaiseMethodSymbol = new FunctionSymbol(
                        $"raise_{eventName}",
                        raiseParams,
                        TypeSymbol.Void,
                        declaration: null,
                        package,
                        eventAccessibility,
                        receiverType: null) { IsSpecialName = true };
                    eventSymbol.RaiseMethodSymbol.IsStatic = true;
                }

                if (!eventSyntax.Annotations.IsDefaultOrEmpty)
                {
                    eventSymbol.SetAttributes(BindAttributes(
                        eventSyntax.Annotations,
                        AttributeTargetKind.Event,
                        Binder.EventDeclarationAllowedTargets,
                        "an event declaration",
                        System.AttributeTargets.Event));
                }

                Binder.AttachDocumentation(eventSymbol, eventSyntax);

                staticEventsBuilder.Add(eventSymbol);
            }

            structSymbol.SetStaticEvents(staticEventsBuilder.ToImmutable());
        }

        // Phase 3.B.4: validate interface implementation. Walks each
        // implemented interface and confirms the class (including inherited
        // methods) provides a same-name, same-signature method. The check
        // itself is deferred (see `VerifyInterfaceImplementations`) until
        // after interface method signatures have been bound, since
        // interface methods may forward-reference user struct/class types.
        if (implementedInterfaces.Count > 0)
        {
            structSymbol.SetInterfaces(implementedInterfaces.ToImmutable());
            foreach (var iface in implementedInterfaces)
            {
                // Phase 3.B.5: a `sealed` interface restricts implementors
                // to the same package as the interface itself.
                if (iface.IsSealed && !string.Equals(iface.PackageName ?? string.Empty, structSymbol.PackageName ?? string.Empty, System.StringComparison.Ordinal))
                {
                    Diagnostics.ReportSealedInterfaceImplementorOutsidePackage(
                        syntax.Identifier.Location,
                        structSymbol.Name,
                        iface.Name,
                        iface.PackageName ?? string.Empty);
                }
            }

            pendingInterfaceImplementationChecks.Add((syntax, structSymbol));
        }

        // Issue #525: record imported CLR interfaces from the base-type
        // clause and queue the same deferred verification used for G#
        // interfaces. The check is deferred because class methods may not
        // have been bound yet when this declaration is processed.
        if (implementedClrInterfaces.Count > 0)
        {
            structSymbol.SetImplementedClrInterfaces(implementedClrInterfaces.ToImmutable());
            if (implementedInterfaces.Count == 0)
            {
                pendingInterfaceImplementationChecks.Add((syntax, structSymbol));
            }
        }

        // Issue #306: bind standalone user-defined constructors (`init(...)`).
        BindConstructorDeclarations(syntax, structSymbol, package, baseClassSymbol, importedBaseType);

        // ADR-0068 / issue #698: bind the optional class destructor (`deinit { … }`).
        BindDeinitDeclaration(syntax, structSymbol, package);

        // Issue #910 / ADR-0110: bind nested type declarations (class / struct /
        // interface / enum) declared inside this aggregate's body, recording the
        // enclosing type so the emitter materialises real CLR nested types.
        BindNestedTypeDeclarations(syntax, structSymbol, package);

        return structSymbol;
    }

    /// <summary>
    /// Issue #910 / ADR-0110: binds the nested type declarations declared in a
    /// class or struct body. Each nested declaration is bound through the same
    /// driver used for top-level types and tagged with its enclosing type via
    /// <c>SetContainingType</c>. Nested-in-nested declarations are handled
    /// recursively because the per-kind binders bind their own nested types.
    /// <para>
    /// All four nested kinds (<c>class</c>/<c>struct</c>/<c>interface</c>/
    /// <c>enum</c>) inside either encloser (<c>class</c> or <c>struct</c>) are
    /// emitted as real CLR nested types. The emitter materialises every
    /// enclosing TypeDef row before its nested rows (ECMA-335 §II.22.32) via a
    /// unified pre-order emission pass (ADR-0110), so no kind/encloser
    /// combination needs to be deferred.
    /// </para>
    /// </summary>
    private void BindNestedTypeDeclarations(StructDeclarationSyntax containerSyntax, TypeSymbol containerSymbol, PackageSymbol package)
    {
        if (containerSyntax.NestedTypes.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var nested in containerSyntax.NestedTypes)
        {
            switch (nested)
            {
                case StructDeclarationSyntax nestedStruct:
                    var nestedStructSymbol = BindStructDeclaration(nestedStruct, package);
                    nestedStructSymbol?.SetContainingType(containerSymbol);
                    break;

                case EnumDeclarationSyntax nestedEnum:
                    var nestedEnumSymbol = BindEnumDeclaration(nestedEnum, package);
                    nestedEnumSymbol?.SetContainingType(containerSymbol);
                    break;

                case InterfaceDeclarationSyntax nestedInterface:
                    var nestedInterfaceSymbol = DeclareInterfaceSymbol(nestedInterface, package);
                    if (nestedInterfaceSymbol != null)
                    {
                        BindInterfaceMembers(nestedInterface, nestedInterfaceSymbol, package);
                        nestedInterfaceSymbol.SetContainingType(containerSymbol);
                    }

                    break;
            }
        }
    }

    internal void VerifyInterfaceImplementations()
    {
        foreach (var (syntax, structSymbol) in pendingInterfaceImplementationChecks)
        {
            // ADR-0085 / issue #726: collect every interface default-method
            // the implementer would inherit if it does not provide its own
            // method, keyed by signature (name + parameter shape). When two
            // unrelated interfaces both provide a default for the same
            // signature and the class does not declare an override, GS0318
            // fires. The mapping is "first-seen wins" for the diagnostic
            // message; conflicts are reported once per signature.
            var inheritedDefaultsBySignature = new Dictionary<string, (FunctionSymbol Method, InterfaceSymbol Iface)>(System.StringComparer.Ordinal);
            var conflictsReported = new HashSet<string>(System.StringComparer.Ordinal);

            foreach (var iface in structSymbol.Interfaces)
            {
                foreach (var imethod in iface.Methods)
                {
                    // ADR-0063 §8: implementing class may have multiple methods
                    // with the same name; pick the one whose signature matches
                    // this specific interface overload exactly.
                    var implCandidates = structSymbol.GetMethodsIncludingInherited(imethod.Name);
                    FunctionSymbol impl = null;
                    FunctionSymbol signatureMatch = null;
                    foreach (var candidate in implCandidates)
                    {
                        impl ??= candidate;
                        if (SignaturesMatch(imethod, GetCallableParameters(candidate), candidate.Type, candidate.ReturnRefKind))
                        {
                            signatureMatch = candidate;
                            break;
                        }
                    }

                    if (signatureMatch != null)
                    {
                        // The class itself provides an implementation that exactly
                        // matches the interface signature — no default needed and
                        // any earlier-seen conflicting default is preempted.
                        var sigKey = BuildInterfaceMethodSignatureKey(imethod);
                        inheritedDefaultsBySignature.Remove(sigKey);
                        conflictsReported.Add(sigKey);
                        continue;
                    }

                    if (impl == null)
                    {
                        // ADR-0085: when the interface itself provides a default,
                        // the implementer does not need to declare the method.
                        // Track which default would be inherited so we can
                        // diagnose diamond conflicts across multiple interfaces.
                        if (InterfaceSymbol.HasDefaultBody(imethod))
                        {
                            var sigKey = BuildInterfaceMethodSignatureKey(imethod);
                            if (inheritedDefaultsBySignature.TryGetValue(sigKey, out var prior))
                            {
                                if (!ReferenceEquals(prior.Method, imethod) && conflictsReported.Add(sigKey))
                                {
                                    Diagnostics.ReportConflictingInterfaceDefaults(
                                        syntax.Identifier.Location,
                                        structSymbol.Name,
                                        imethod.Name,
                                        prior.Iface.Name,
                                        iface.Name);
                                }
                            }
                            else
                            {
                                inheritedDefaultsBySignature[sigKey] = (imethod, iface);
                            }

                            continue;
                        }

                        // No impl, no default → original GS0187 channel for
                        // missing implementations. GS0320 narrows it to "the
                        // interface deliberately requires this method".
                        if (InterfaceHasAnyDefaultsExcept(iface, imethod))
                        {
                            Diagnostics.ReportInterfaceAbstractMethodHasNoDefault(
                                syntax.Identifier.Location,
                                structSymbol.Name,
                                iface.Name,
                                imethod.Name);
                        }
                        else
                        {
                            Diagnostics.ReportInterfaceMethodNotImplemented(
                                syntax.Identifier.Location,
                                structSymbol.Name,
                                iface.Name,
                                imethod.Name);
                        }
                    }
                    else if (signatureMatch == null)
                    {
                        // ADR-0060 §9: distinguish a pure ref-kind mismatch (GS0240) from
                        // an unrelated signature mismatch (the existing diagnostic).
                        // Issue #490: also surface a dedicated diagnostic when only the
                        // *return* ref-kind disagrees.
                        if (imethod.Type == impl.Type && imethod.ReturnRefKind != impl.ReturnRefKind)
                        {
                            Diagnostics.ReportOverrideReturnRefKindMismatch(
                                syntax.Identifier.Location,
                                imethod.Name,
                                imethod.ReturnRefKind == RefKind.Ref ? "by ref" : "by value",
                                impl.ReturnRefKind == RefKind.Ref ? "by ref" : "by value");
                        }
                        else
                        {
                            var refMismatchIdx = FindRefKindMismatchIndex(imethod, GetCallableParameters(impl), impl.Type);
                            if (refMismatchIdx >= 0)
                            {
                                var implCallable = GetCallableParameters(impl);
                                var ifaceCallable = GetCallableParameters(imethod);
                                Diagnostics.ReportOverrideRefKindMismatch(
                                    syntax.Identifier.Location,
                                    imethod.Name,
                                    ifaceCallable[refMismatchIdx].Name,
                                    refKindToString(ifaceCallable[refMismatchIdx].RefKind),
                                    refKindToString(implCallable[refMismatchIdx].RefKind));
                            }
                            else
                            {
                                Diagnostics.ReportInterfaceMethodNotImplemented(
                                    syntax.Identifier.Location,
                                    structSymbol.Name,
                                    iface.Name,
                                    imethod.Name);
                            }
                        }
                    }
                }

                // ADR-0051: verify property requirements.
                foreach (var iprop in iface.Properties)
                {
                    var found = false;
                    foreach (var implProp in structSymbol.Properties)
                    {
                        if (implProp.Name == iprop.Name)
                        {
                            if (iprop.HasGetter && !implProp.HasGetter)
                            {
                                Diagnostics.ReportInterfaceMethodNotImplemented(
                                    syntax.Identifier.Location,
                                    structSymbol.Name,
                                    iface.Name,
                                    iprop.Name + " (getter)");
                            }

                            if (iprop.HasSetter && !implProp.HasSetter)
                            {
                                Diagnostics.ReportInterfaceMethodNotImplemented(
                                    syntax.Identifier.Location,
                                    structSymbol.Name,
                                    iface.Name,
                                    iprop.Name + " (setter)");
                            }

                            found = true;
                            break;
                        }
                    }

                    if (!found)
                    {
                        Diagnostics.ReportInterfaceMethodNotImplemented(
                            syntax.Identifier.Location,
                            structSymbol.Name,
                            iface.Name,
                            iprop.Name);
                    }
                }
            }

            // Issue #525: verify CLR interfaces declared in the base-type clause.
            // Walks each public abstract member on the imported interface and
            // confirms the G# class provides a same-name, same-CLR-signature
            // method or property. Diagnostic uses the same GS0187 channel.
            VerifyClrInterfaceImplementations(syntax, structSymbol);

            // ADR-0089 / issue #755: verify static-virtual interface members.
            // For each declared interface, walk its StaticMethods. The
            // implementer must either (a) declare a matching static method
            // inside its `shared { ... }` block (ADR-0053) — recorded on
            // StructSymbol.StaticMethods — or (b) inherit a default body
            // from the interface itself (the interface method declaration
            // carries a body). If a same-named *instance* method exists but
            // no matching static method, GS0332 surfaces; otherwise GS0331.
            VerifyStaticVirtualInterfaceImplementations(syntax, structSymbol);

            // ADR-0090 / issue #756: verify that the implementer does not
            // attempt to override a `private` interface helper. Private
            // helpers are part of the interface's own implementation and
            // are not part of the public contract; an implementer that
            // happens to declare a same-signature method clashes with the
            // helper at the implementation level.
            VerifyPrivateInterfaceHelpersNotOverridden(syntax, structSymbol);
        }
    }

    /// <summary>
    /// ADR-0090 / issue #756: rejects implementers that attempt to declare a
    /// method whose signature matches one of the private helpers on an
    /// implemented interface. Private interface helpers are not part of the
    /// public contract — implementers cannot see them — but a same-shape
    /// declaration would create an ambiguous v-table slot if we did not
    /// surface a diagnostic.
    /// </summary>
    /// <param name="syntax">The implementer's declaring syntax (for location).</param>
    /// <param name="structSymbol">The class symbol whose interfaces are checked.</param>
    private void VerifyPrivateInterfaceHelpersNotOverridden(StructDeclarationSyntax syntax, StructSymbol structSymbol)
    {
        foreach (var iface in structSymbol.Interfaces)
        {
            if (!iface.PrivateMethods.IsDefaultOrEmpty)
            {
                foreach (var imethod in iface.PrivateMethods)
                {
                    foreach (var candidate in structSymbol.GetMethodsIncludingInherited(imethod.Name))
                    {
                        if (SignaturesMatch(imethod, GetCallableParameters(candidate), candidate.Type, candidate.ReturnRefKind))
                        {
                            Diagnostics.ReportImplementerOverridesPrivateInterfaceMember(
                                syntax.Identifier.Location,
                                structSymbol.Name,
                                iface.Name,
                                imethod.Name);
                            break;
                        }
                    }
                }
            }

            if (!iface.StaticPrivateMethods.IsDefaultOrEmpty)
            {
                foreach (var imethod in iface.StaticPrivateMethods)
                {
                    foreach (var candidate in structSymbol.GetStaticMethods(imethod.Name))
                    {
                        if (StaticVirtualSignaturesMatch(imethod, candidate))
                        {
                            Diagnostics.ReportImplementerOverridesPrivateInterfaceMember(
                                syntax.Identifier.Location,
                                structSymbol.Name,
                                iface.Name,
                                imethod.Name);
                            break;
                        }
                    }
                }
            }
        }
    }

    /// <summary>
    /// ADR-0089 / issue #755: enforces that every static-virtual interface
    /// member without a default body is matched by a same-signature static
    /// method on the implementer. A non-static implementer member with the
    /// same name produces GS0332; otherwise GS0331.
    /// </summary>
    private void VerifyStaticVirtualInterfaceImplementations(StructDeclarationSyntax syntax, StructSymbol structSymbol)
    {
        foreach (var iface in structSymbol.Interfaces)
        {
            if (iface.StaticMethods.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var imethod in iface.StaticMethods)
            {
                var sigMatch = false;
                var nameMatch = false;
                foreach (var candidate in structSymbol.GetStaticMethods(imethod.Name))
                {
                    nameMatch = true;
                    if (StaticVirtualSignaturesMatch(imethod, candidate))
                    {
                        sigMatch = true;
                        break;
                    }
                }

                if (sigMatch)
                {
                    continue;
                }

                if (!nameMatch)
                {
                    // Detect a non-static instance candidate with the same
                    // name → GS0332 — instance member cannot satisfy a
                    // static-virtual slot.
                    foreach (var instCandidate in structSymbol.GetMethodsIncludingInherited(imethod.Name))
                    {
                        if (!instCandidate.IsStatic)
                        {
                            Diagnostics.ReportNonStaticMemberForStaticVirtualSlot(
                                syntax.Identifier.Location,
                                structSymbol.Name,
                                iface.Name,
                                imethod.Name);
                            nameMatch = true;
                            break;
                        }
                    }
                }

                if (sigMatch || nameMatch)
                {
                    continue;
                }

                // No same-name candidate at all. If the interface itself
                // provides a default body, the implementer inherits it.
                if (InterfaceSymbol.HasDefaultBody(imethod))
                {
                    continue;
                }

                Diagnostics.ReportStaticVirtualInterfaceMethodNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol.Name,
                    iface.Name,
                    imethod.Name);
            }
        }
    }

    /// <summary>
    /// ADR-0089: shallow signature comparison for a static-virtual interface
    /// slot vs. a candidate implementer method. Static methods have no
    /// implicit <c>this</c>, so all parameters are direct and compared by
    /// type identity and ref-kind.
    /// </summary>
    private static bool StaticVirtualSignaturesMatch(FunctionSymbol iface, FunctionSymbol impl)
    {
        if (iface.Parameters.Length != impl.Parameters.Length)
        {
            return false;
        }

        if (!System.Collections.Generic.EqualityComparer<TypeSymbol>.Default.Equals(iface.Type, impl.Type))
        {
            return false;
        }

        if (iface.ReturnRefKind != impl.ReturnRefKind)
        {
            return false;
        }

        for (var i = 0; i < iface.Parameters.Length; i++)
        {
            if (!System.Collections.Generic.EqualityComparer<TypeSymbol>.Default.Equals(iface.Parameters[i].Type, impl.Parameters[i].Type))
            {
                return false;
            }

            if (iface.Parameters[i].RefKind != impl.Parameters[i].RefKind)
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// ADR-0085 / issue #726: builds a stable signature key for an interface
    /// method (used to detect diamond conflicts across multiple interfaces).
    /// The key is "Name(P0, P1, …)" using the parameter type names from the
    /// callable shape (which strips the implicit `this`).
    /// </summary>
    private string BuildInterfaceMethodSignatureKey(FunctionSymbol method)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append(method.Name);
        sb.Append('(');
        var parameters = GetCallableParameters(method);
        for (var i = 0; i < parameters.Length; i++)
        {
            if (i > 0)
            {
                sb.Append(',');
            }

            sb.Append(parameters[i].Type?.Name ?? "?");
        }

        sb.Append(')');
        return sb.ToString();
    }

    /// <summary>
    /// ADR-0085 helper: returns <c>true</c> when the supplied interface
    /// carries at least one default-bearing method other than
    /// <paramref name="excluded"/>. Used to decide whether GS0320 ("no
    /// default available") fires instead of GS0187 (general "not
    /// implemented"). When the interface is purely abstract, GS0187 stays
    /// the right channel because DIM isn't part of the conversation.
    /// </summary>
    private static bool InterfaceHasAnyDefaultsExcept(InterfaceSymbol iface, FunctionSymbol excluded)
    {
        foreach (var m in iface.Methods)
        {
            if (ReferenceEquals(m, excluded))
            {
                continue;
            }

            if (InterfaceSymbol.HasDefaultBody(m))
            {
                return true;
            }
        }

        return false;
    }

    private void VerifyClrInterfaceImplementations(StructDeclarationSyntax syntax, StructSymbol structSymbol)
    {
        if (structSymbol.ImplementedClrInterfaces.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var ifaceSym in structSymbol.ImplementedClrInterfaces)
        {
            var clrIface = ifaceSym.ClrType;
            if (clrIface == null)
            {
                continue;
            }

            // Methods excluding property/event accessors (those are validated
            // through their owning property / event below).
            foreach (var clrMethod in clrIface.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance))
            {
                if (clrMethod.IsSpecialName)
                {
                    continue;
                }

                // Skip Default Interface Methods (non-abstract virtual methods).
                // G# does not yet support DIMs (ADR-0018, Phase 6+); a class is
                // not required to implement them — the runtime dispatches to the
                // default body when no explicit override is present.
                if (!clrMethod.IsAbstract)
                {
                    continue;
                }

                if (MemberLookup.HasMatchingMethodForClrSignature(structSymbol, clrMethod))
                {
                    continue;
                }

                Diagnostics.ReportInterfaceMethodNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol.Name,
                    clrIface.FullName ?? clrIface.Name,
                    FormatClrMethodSignature(clrMethod));
            }

            // Properties.
            foreach (var clrProp in clrIface.GetProperties(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance))
            {
                var implProp = MemberLookup.FindMatchingProperty(structSymbol, clrProp);
                if (implProp == null)
                {
                    // #573/#606: check whether a public field satisfies the property contract.
                    var matchingField = MemberLookup.FindMatchingFieldForPropertyContract(structSymbol, clrProp);
                    if (matchingField != null)
                    {
                        // Synthesize a PropertySymbol backed by the field so the emit
                        // path handles it via the existing auto-property machinery.
                        bool contractHasSetter = clrProp.SetMethod != null;
                        var synthesized = new PropertySymbol(
                            name: clrProp.Name,
                            type: matchingField.Type,
                            accessibility: Accessibility.Public,
                            hasGetter: true,
                            hasSetter: contractHasSetter,
                            isAutoProperty: true,
                            isVirtual: true,
                            isOverride: false);
                        synthesized.BackingField = matchingField;
                        structSymbol.SetProperties(structSymbol.Properties.Add(synthesized));
                        continue;
                    }

                    Diagnostics.ReportInterfaceMethodNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol.Name,
                        clrIface.FullName ?? clrIface.Name,
                        clrProp.Name);
                    continue;
                }

                if (clrProp.GetMethod != null && !implProp.HasGetter)
                {
                    Diagnostics.ReportInterfaceMethodNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol.Name,
                        clrIface.FullName ?? clrIface.Name,
                        clrProp.Name + " (getter)");
                }

                if (clrProp.SetMethod != null && !implProp.HasSetter)
                {
                    Diagnostics.ReportInterfaceMethodNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol.Name,
                        clrIface.FullName ?? clrIface.Name,
                        clrProp.Name + " (setter)");
                }
            }
        }
    }

    private static string FormatClrMethodSignature(System.Reflection.MethodInfo method)
    {
        var ps = method.GetParameters();
        if (ps.Length == 0)
        {
            return method.Name;
        }

        var names = new string[ps.Length];
        for (var i = 0; i < ps.Length; i++)
        {
            names[i] = ps[i].ParameterType.Name;
        }

        return $"{method.Name}({string.Join(", ", names)})";
    }

    private static string GetBaseClauseTypeDisplayName(TypeClauseSyntax typeClause)
    {
        if (typeClause == null)
        {
            return string.Empty;
        }

        var dotted = typeClause.DottedName;
        if (!typeClause.HasTypeArguments)
        {
            return dotted;
        }

        var args = new string[typeClause.TypeArguments.Count];
        for (var i = 0; i < typeClause.TypeArguments.Count; i++)
        {
            args[i] = GetBaseClauseTypeDisplayName(typeClause.TypeArguments[i]);
        }

        return $"{dotted}[{string.Join(", ", args)}]";
    }

    internal InterfaceSymbol DeclareInterfaceSymbol(InterfaceDeclarationSyntax syntax, PackageSymbol package)
    {
        var name = syntax.Identifier.Text;
        var accessibility = resolveAccessibility(syntax.AccessibilityModifier);
        var interfaceSymbol = new InterfaceSymbol(name, accessibility, syntax, package.Name);
        Binder.AttachDocumentation(interfaceSymbol, syntax);
        interfaceSymbol.SetAttributes(BindAttributes(
            syntax.Annotations,
            AttributeTargetKind.Type,
            Binder.TypeDeclarationAllowedTargets,
            "an interface declaration",
            System.AttributeTargets.Interface));

        // Phase 4.3c / ADR-0020: bind type parameters at declaration time so
        // method-signature binding (which happens later) can resolve them.
        var typeParameters = BindTypeParameterList(syntax.TypeParameterList);
        if (!typeParameters.IsDefaultOrEmpty)
        {
            interfaceSymbol.SetTypeParameters(typeParameters);
        }

        if (!scope.TryDeclareTypeAlias(name, interfaceSymbol))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
            return null;
        }

        return interfaceSymbol;
    }

    private void BindInterfaceDeclaration(InterfaceDeclarationSyntax syntax, PackageSymbol package)
    {
        var declared = DeclareInterfaceSymbol(syntax, package);
        if (declared != null)
        {
            BindInterfaceMembers(syntax, declared, package);
        }
    }

    internal void BindInterfaceMembers(InterfaceDeclarationSyntax syntax, InterfaceSymbol interfaceSymbol, PackageSymbol package)
    {
        // Phase 4.3c: push the interface's type parameters so that method
        // signatures can reference them.
        var previousTypeParameters = binderCtx.CurrentTypeParameters;
        if (!interfaceSymbol.TypeParameters.IsDefaultOrEmpty)
        {
            binderCtx.CurrentTypeParameters = new Dictionary<string, TypeParameterSymbol>();
            foreach (var tp in interfaceSymbol.TypeParameters)
            {
                binderCtx.CurrentTypeParameters[tp.Name] = tp;
            }
        }

        try
        {
            BindInterfaceMembersCore(syntax, interfaceSymbol, package);
        }
        finally
        {
            binderCtx.CurrentTypeParameters = previousTypeParameters;
        }
    }

    private void BindInterfaceMembersCore(InterfaceDeclarationSyntax syntax, InterfaceSymbol interfaceSymbol, PackageSymbol package)
    {
        var methodsBuilder = ImmutableArray.CreateBuilder<FunctionSymbol>();
        var staticMethodsBuilder = ImmutableArray.CreateBuilder<FunctionSymbol>();
        var privateMethodsBuilder = ImmutableArray.CreateBuilder<FunctionSymbol>();
        var staticPrivateMethodsBuilder = ImmutableArray.CreateBuilder<FunctionSymbol>();
        var seenNames = new HashSet<string>();
        foreach (var methodSyntax in syntax.Methods)
        {
            var methodName = methodSyntax.Identifier.Text;

            // ADR-0089 / issue #755: detect a `static` modifier early — the
            // method is a static-virtual interface member. Static methods do
            // not receive a `this` parameter, are not added to the dispatch
            // table for instance calls, and live on a separate
            // <c>InterfaceSymbol.StaticMethods</c> bucket. Both abstract and
            // default-bodied forms are accepted; the binder uses the same
            // body-vs-no-body discriminator as ADR-0085 to distinguish them.
            var isStaticInterfaceMethod = methodSyntax.HasStaticModifier;

            // ADR-0090 / issue #756: detect a `private` accessibility modifier
            // on the interface method. Private helpers route into the
            // separate <see cref="InterfaceSymbol.PrivateMethods"/> bucket
            // (or <see cref="InterfaceSymbol.StaticPrivateMethods"/> when
            // also <c>static</c>) so the public <c>Methods</c> contract used
            // by implementer-verification is unaffected. The CLR shape is
            // <c>MethodAttributes.Private | HideBySig</c> (plus
            // <c>Static</c> when combined with ADR-0089). The helper is
            // non-virtual; implementers cannot see it (GS0336 fires when an
            // implementer declares a same-signature method on a type that
            // implements the owning interface).
            var isPrivateInterfaceMethod = methodSyntax.AccessibilityModifier != null
                && string.Equals(methodSyntax.AccessibilityModifier.Text, "private", System.StringComparison.Ordinal);

            // ADR-0063: overloads are allowed on interfaces; the post-bind signature
            // check below detects duplicate signatures. Name collision with a
            // property/event member of the same name is still rejected (handled later
            // via seenNames when properties/events are added).
            var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>();
            var seenParameterNames = new HashSet<string>();
            foreach (var parameterSyntax in methodSyntax.Parameters)
            {
                var parameterName = parameterSyntax.Identifier.Text;
                var parameterType = bindTypeClause(parameterSyntax.Type) ?? TypeSymbol.Error;

                // ADR-0101 follow-up / issue #812: variadic parameters are now
                // accepted on interface methods. For abstract members the
                // variadic flag travels through the dispatch table; for ADR-0085
                // default-bodied members the body sees the parameter as `[]T`,
                // and the emitter stamps [ParamArrayAttribute] on the MethodDef
                // (interface method emit shares the same path as class methods).
                var isVariadic = parameterSyntax.IsVariadic;
                if (isVariadic && parameterType != TypeSymbol.Error)
                {
                    parameterType = SliceTypeSymbol.Get(parameterType);
                }

                var parameterRefKind = conversions.BindAndValidateParameterRefKind(
                    parameterSyntax,
                    parameterName,
                    parameterType,
                    isVariadic,
                    asyncOrIteratorKind: methodSyntax.IsAsync ? "async" : null);

                if (!seenParameterNames.Add(parameterName))
                {
                    Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
                }
                else
                {
                    var ifaceMethodParam = new ParameterSymbol(parameterName, parameterType, isVariadic, declaringSyntax: parameterSyntax.Identifier, isScoped: parameterSyntax.IsScoped, refKind: parameterRefKind);
                    conversions.BindAndAttachParameterDefaultValue(parameterSyntax, ifaceMethodParam);
                    parameters.Add(ifaceMethodParam);
                }
            }

            ValidateVariadicParameterShape(methodSyntax.Parameters);

            var returnType = bindReturnTypeClause(methodSyntax.Type, methodSyntax.IsAsync) ?? TypeSymbol.Void;
            var methodReturnRefKind = ValidateReturnRefKind(methodSyntax, returnType);

            // ADR-0085 / issue #726: an interface method whose declaration
            // carries a body is a default-interface method. We set the
            // receiver type to the owning InterfaceSymbol so the body
            // binder gives the method a `this` parameter and the call
            // binder routes virtual dispatch through the interface. An
            // abstract interface method still gets the same receiver
            // (`this` typed as the interface) so call-binder paths that
            // resolve interface dispatch work uniformly — emit then drops
            // the body when the declaration has none.
            //
            // ADR-0089: static-virtual interface members are not instance
            // methods — they have no `this`. Construct a top-level-style
            // FunctionSymbol with `IsStatic = true` and `StaticOwnerType`
            // set to the owning InterfaceSymbol.
            //
            // ADR-0090: private helpers get the same shape — the receiver
            // type is the InterfaceSymbol (so sibling default bodies on the
            // same interface dispatch correctly), but Accessibility is set
            // to Private so the emit pipeline produces the
            // MethodAttributes.Private flag.
            var methodAccessibility = isPrivateInterfaceMethod ? Accessibility.Private : Accessibility.Public;
            var methodSymbol = new FunctionSymbol(
                methodName,
                parameters.ToImmutable(),
                returnType,
                methodSyntax,
                package,
                methodAccessibility,
                receiverType: isStaticInterfaceMethod ? null : (TypeSymbol)interfaceSymbol);
            methodSymbol.ReturnRefKind = methodReturnRefKind;
            methodSymbol.IsAsync = methodSyntax.IsAsync || isAsyncIteratorReturnType(returnType);
            if (isStaticInterfaceMethod)
            {
                methodSymbol.IsStatic = true;
                methodSymbol.StaticOwnerType = interfaceSymbol;
            }

            Binder.AttachDocumentation(methodSymbol, methodSyntax);

            // ADR-0085: reject `open` / `override` modifiers on interface
            // members — these are tracked as deferred follow-ups (GS0321).
            // The parser does not currently accept them on interface method
            // signatures, but the FunctionDeclarationSyntax can carry them
            // in principle via the constructor overload; defensively
            // diagnose here so a future parser relaxation surfaces with a
            // clear message. ADR-0089 reverses the rejection of `static` —
            // it is now accepted. ADR-0090 reverses the rejection of
            // `private` — it is now accepted (and routed into the private
            // helpers bucket).
            if (methodSyntax.OpenModifier != null)
            {
                Diagnostics.ReportInterfaceMethodModifierDeferred(methodSyntax.OpenModifier.Location, "open", methodName);
            }

            if (methodSyntax.OverrideModifier != null)
            {
                Diagnostics.ReportInterfaceMethodModifierDeferred(methodSyntax.OverrideModifier.Location, "override", methodName);
            }

            // ADR-0090 / issue #756: a `private` interface method must
            // carry a body. The helper is part of the interface's own
            // implementation — no implementer can supply it.
            if (isPrivateInterfaceMethod && methodSyntax.Body == null)
            {
                Diagnostics.ReportPrivateInterfaceMemberRequiresBody(methodSyntax.Identifier.Location, methodName);
            }

            // ADR-0063 §11: detect duplicate-signature overloads on the interface.
            ImmutableArray<FunctionSymbol>.Builder targetBuilder;
            if (isPrivateInterfaceMethod)
            {
                targetBuilder = isStaticInterfaceMethod ? staticPrivateMethodsBuilder : privateMethodsBuilder;
            }
            else
            {
                targetBuilder = isStaticInterfaceMethod ? staticMethodsBuilder : methodsBuilder;
            }

            var hasDupSig = false;
            foreach (var existingMethod in targetBuilder)
            {
                if (BoundScope.FunctionSignaturesEqual(existingMethod, methodSymbol))
                {
                    Diagnostics.ReportDuplicateOverloadSignature(
                        methodSyntax.Identifier.Location,
                        methodName,
                        Binder.FormatOverloadSignature(methodSymbol));
                    hasDupSig = true;
                    break;
                }
            }

            if (!hasDupSig)
            {
                seenNames.Add(methodName);
                targetBuilder.Add(methodSymbol);
            }
        }

        interfaceSymbol.SetMethods(methodsBuilder.ToImmutable());
        interfaceSymbol.SetStaticMethods(staticMethodsBuilder.ToImmutable());
        interfaceSymbol.SetPrivateMethods(privateMethodsBuilder.ToImmutable());
        interfaceSymbol.SetStaticPrivateMethods(staticPrivateMethodsBuilder.ToImmutable());

        // ADR-0051: bind interface property declarations.
        if (!syntax.Properties.IsDefaultOrEmpty)
        {
            var propertiesBuilder = ImmutableArray.CreateBuilder<PropertySymbol>();
            foreach (var propSyntax in syntax.Properties)
            {
                var propName = propSyntax.Identifier.Text;
                if (!seenNames.Add(propName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(propSyntax.Identifier.Location, propName);
                    continue;
                }

                var propType = bindTypeClause(propSyntax.Type);
                if (propType == null)
                {
                    continue;
                }

                bool hasGetter = true;
                bool hasSetter = false;

                if (propSyntax.OpenBraceToken != null)
                {
                    hasGetter = propSyntax.Accessors.Any(a => a.IsGetter);
                    hasSetter = propSyntax.Accessors.Any(a => a.IsSetter);
                    if (!hasGetter && !hasSetter)
                    {
                        hasGetter = true;
                        hasSetter = true;
                    }
                }
                else
                {
                    // Bare: prop Name Type in interface = get + set
                    hasSetter = true;
                }

                var propSymbol = new PropertySymbol(
                    propName,
                    propType,
                    Accessibility.Public,
                    hasGetter,
                    hasSetter,
                    isAutoProperty: false,
                    isVirtual: false,
                    isOverride: false,
                    declaration: propSyntax);

                Binder.AttachDocumentation(propSymbol, propSyntax);
                propertiesBuilder.Add(propSymbol);
            }

            interfaceSymbol.SetProperties(propertiesBuilder.ToImmutable());
        }

        // ADR-0052: bind interface event declarations.
        if (!syntax.Events.IsDefaultOrEmpty)
        {
            var eventsBuilder = ImmutableArray.CreateBuilder<EventSymbol>();
            foreach (var eventSyntax in syntax.Events)
            {
                var eventName = eventSyntax.Identifier.Text;
                if (!seenNames.Add(eventName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(eventSyntax.Identifier.Location, eventName);
                    continue;
                }

                var handlerType = bindTypeClause(eventSyntax.Type);
                if (handlerType == null)
                {
                    continue;
                }

                var eventSymbol = new EventSymbol(
                    eventName,
                    handlerType,
                    Accessibility.Public,
                    isFieldLike: false,
                    isVirtual: false,
                    isOverride: false,
                    declaration: eventSyntax);

                Binder.AttachDocumentation(eventSymbol, eventSyntax);
                eventsBuilder.Add(eventSymbol);
            }

            interfaceSymbol.SetEvents(eventsBuilder.ToImmutable());
        }

        // Phase 4.3c / ADR-0021: variance position checking. Walk each method's
        // parameter types (contravariant position) and return type (covariant
        // position). An `out T` may only appear in covariant position; an
        // `in T` may only appear in contravariant position. ADR-0089: walk
        // both instance and static-virtual method buckets — variance applies
        // to both because the type parameter still flows through the
        // signature when the interface is constructed. ADR-0090: walk private
        // helper buckets too — variance rules apply regardless of accessibility.
        if (!interfaceSymbol.TypeParameters.IsDefaultOrEmpty)
        {
            var instanceIdx = 0;
            var staticIdx = 0;
            var privateInstanceIdx = 0;
            var privateStaticIdx = 0;
            foreach (var methodSyntax in syntax.Methods)
            {
                var isPrivate = methodSyntax.AccessibilityModifier != null
                    && string.Equals(methodSyntax.AccessibilityModifier.Text, "private", System.StringComparison.Ordinal);
                FunctionSymbol m;
                if (methodSyntax.HasStaticModifier)
                {
                    if (isPrivate)
                    {
                        if (privateStaticIdx >= interfaceSymbol.StaticPrivateMethods.Length)
                        {
                            continue;
                        }

                        m = interfaceSymbol.StaticPrivateMethods[privateStaticIdx++];
                    }
                    else
                    {
                        if (staticIdx >= interfaceSymbol.StaticMethods.Length)
                        {
                            continue;
                        }

                        m = interfaceSymbol.StaticMethods[staticIdx++];
                    }
                }
                else
                {
                    if (isPrivate)
                    {
                        if (privateInstanceIdx >= interfaceSymbol.PrivateMethods.Length)
                        {
                            continue;
                        }

                        m = interfaceSymbol.PrivateMethods[privateInstanceIdx++];
                    }
                    else
                    {
                        if (instanceIdx >= interfaceSymbol.Methods.Length)
                        {
                            continue;
                        }

                        m = interfaceSymbol.Methods[instanceIdx++];
                    }
                }

                CheckVariancePosition(m.Type, isOutput: true, methodSyntax.Type?.Location ?? methodSyntax.Identifier.Location);
                for (var p = 0; p < m.Parameters.Length; p++)
                {
                    var paramSyntax = methodSyntax.Parameters[p];
                    CheckVariancePosition(m.Parameters[p].Type, isOutput: false, paramSyntax.Type?.Location ?? paramSyntax.Location);
                }
            }
        }
    }

    private void CheckVariancePosition(TypeSymbol type, bool isOutput, TextLocation location)
    {
        if (type is TypeParameterSymbol tp)
        {
            if (tp.Variance == TypeParameterVariance.Out && !isOutput)
            {
                Diagnostics.ReportTypeParameterVariancePositionViolation(location, tp.Name, "out", "input");
            }
            else if (tp.Variance == TypeParameterVariance.In && isOutput)
            {
                Diagnostics.ReportTypeParameterVariancePositionViolation(location, tp.Name, "in", "output");
            }

            return;
        }

        if (type is SliceTypeSymbol s)
        {
            CheckVariancePosition(s.ElementType, isOutput, location);
            return;
        }

        if (type is ArrayTypeSymbol a)
        {
            CheckVariancePosition(a.ElementType, isOutput, location);
            return;
        }

        if (type is NullableTypeSymbol n)
        {
            CheckVariancePosition(n.UnderlyingType, isOutput, location);
            return;
        }
    }

    internal void BindFunctionDeclaration(FunctionDeclarationSyntax syntax, PackageSymbol package)
    {
        var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>();

        var seenParameterNames = new HashSet<string>();

        // Phase 4.1 / ADR-0020: bind generic type parameters first so that
        // BindTypeClause can find them when binding parameter / return types.
        var typeParameters = BindTypeParameterList(syntax.TypeParameterList);
        var previousTypeParameters = binderCtx.CurrentTypeParameters;
        if (!typeParameters.IsDefaultOrEmpty)
        {
            binderCtx.CurrentTypeParameters = new Dictionary<string, TypeParameterSymbol>();
            foreach (var tp in typeParameters)
            {
                binderCtx.CurrentTypeParameters[tp.Name] = tp;
            }
        }

        try
        {
            // Phase 3.B.6 / ADR-0019 and Phase 6.4 / ADR-0024: receiver
            // clauses become parameters[0]. Same-package struct/class receivers
            // are methods; all other valid receivers remain extension functions.
            TypeSymbol receiverType = null;
            ParameterSymbol explicitReceiverParameter = null;
            StructSymbol methodReceiverStruct = null;
            if (syntax.IsExtension)
            {
                var recvName = syntax.Receiver.Identifier.Text;
                receiverType = bindTypeClause(syntax.Receiver.Type);
                if (receiverType == null)
                {
                    receiverType = TypeSymbol.Error;
                }

                explicitReceiverParameter = new ParameterSymbol(recvName, receiverType, declaringSyntax: syntax.Receiver);
                seenParameterNames.Add(recvName);
                parameters.Add(explicitReceiverParameter);

                if (receiverType is StructSymbol receiverStruct && string.Equals(receiverStruct.PackageName, package.Name, StringComparison.Ordinal))
                {
                    methodReceiverStruct = receiverStruct.Definition ?? receiverStruct;
                }
                else if (IsSamePackageNonAggregateReceiver(syntax.Receiver.Type, receiverType, package))
                {
                    Diagnostics.ReportMethodReceiverMustBeStructOrClass(syntax.Receiver.Type.Location, receiverType.Name);
                    return;
                }
            }

            // Tracks the bound ParameterSymbol corresponding to each parameter
            // syntax position (null for duplicates) so per-parameter annotations
            // can be attached to the right symbol below.
            var parameterSymbolBySyntax = new ParameterSymbol[syntax.Parameters.Count];
            for (var pIndex = 0; pIndex < syntax.Parameters.Count; pIndex++)
            {
                var parameterSyntax = syntax.Parameters[pIndex];
                var parameterName = parameterSyntax.Identifier.Text;
                var parameterType = bindTypeClause(parameterSyntax.Type) ?? TypeSymbol.Error;
                if (!seenParameterNames.Add(parameterName))
                {
                    Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
                }
                else
                {
                    // Phase 4.8: a `...T` parameter has type `[]T` for the body
                    // and must be the last parameter. Auto-packing of trailing
                    // arguments happens at the call site.
                    var isVariadic = parameterSyntax.IsVariadic;
                    if (isVariadic && parameterType != TypeSymbol.Error)
                    {
                        parameterType = SliceTypeSymbol.Get(parameterType);
                    }

                    var parameterRefKind = conversions.BindAndValidateParameterRefKind(
                        parameterSyntax,
                        parameterName,
                        parameterType,
                        isVariadic,
                        syntax.IsAsync ? "async" : null);

                    var parameter = new ParameterSymbol(parameterName, parameterType, isVariadic, declaringSyntax: parameterSyntax.Identifier, isScoped: parameterSyntax.IsScoped, refKind: parameterRefKind);
                    conversions.BindAndAttachParameterDefaultValue(parameterSyntax, parameter);
                    parameters.Add(parameter);
                    parameterSymbolBySyntax[pIndex] = parameter;
                }
            }

            // Phase 4.8: validate `...T` appears only on the last syntactic parameter.
            // ADR-0101 / issue #799: also flag the (rare) case where more than one
            // parameter is variadic — the second and later occurrences get GS0364
            // in addition to the "must-be-last" diagnostic on the earlier one(s).
            ValidateVariadicParameterShape(syntax.Parameters);

            // ADR-0041: bind the return type with async-aware alias resolution.
            var type = bindReturnTypeClause(syntax.Type, syntax.IsAsync) ?? TypeSymbol.Void;

            // Issue #490 (ADR-0060 follow-up): a `ref` return modifier on the declaration
            // is only valid when an explicit return-type clause is present, the function is
            // not async, and the return is not a sequence/async-sequence (the state-machine
            // rewriter cannot hoist a managed pointer into a field — same constraint as
            // ref-kind parameters per ADR-0058 §4).
            var returnRefKind = ValidateReturnRefKind(syntax, type);

            // ADR-0060 §10: post-bind check — if this is a sequence/async-sequence
            // function, ref-kind parameters are forbidden. (The async-only check
            // is handled earlier in the parameter loop.)
            var isSequenceReturn = type is SequenceTypeSymbol || type is AsyncSequenceTypeSymbol;
            if (isSequenceReturn)
            {
                for (var pIndex = 0; pIndex < syntax.Parameters.Count; pIndex++)
                {
                    var pSym = parameterSymbolBySyntax[pIndex];
                    if (pSym != null && pSym.RefKind != RefKind.None)
                    {
                        var label = syntax.IsAsync ? "async sequence" : "sequence";
                        Diagnostics.ReportRefKindOnAsyncOrIterator(syntax.Parameters[pIndex].Location, pSym.Name, label);
                    }
                }
            }

            var accessibility = resolveAccessibility(syntax.AccessibilityModifier);

            // Issue #141 / ADR-0047: resolve annotation lead-ins for this
            // declaration. We do this once per function regardless of whether
            // it is an extension, a method, or a free function — diagnostics
            // and the resulting bound-attribute list are identical.
            var functionAttributes = BindAttributes(
                syntax.Annotations,
                AttributeTargetKind.Method,
                Binder.FunctionDeclarationAllowedTargets,
                "a function declaration",
                System.AttributeTargets.Method);

            // Issue #176 / ADR-0047 §6: a function marked `@Conditional`
            // must return void. The CLR rule (matching C# CS0578) is that
            // conditional-method calls may be elided at the call site, which
            // is incompatible with a non-void result feeding the surrounding
            // expression. The attribute is still attached to the function
            // symbol so downstream tools see the user's intent and so the
            // call site still elides; the diagnostic is per-declaration.
            if (KnownAttributes.HasConditional(functionAttributes) && type != TypeSymbol.Void)
            {
                Diagnostics.ReportConditionalMethodMustReturnVoid(syntax.Identifier.Location, syntax.Identifier.Text);
            }

            // Per-parameter annotations: each ParameterSyntax owns its own
            // annotation list; the default target is `param`. Issue #170 /
            // ADR-0047 §3: the bound list is stored on the ParameterSymbol so
            // the emitter can emit a `CustomAttribute` row keyed to the
            // corresponding `Parameter` metadata handle.
            for (var pIndex = 0; pIndex < syntax.Parameters.Count; pIndex++)
            {
                var parameterSyntax = syntax.Parameters[pIndex];
                var paramAttrs = BindAttributes(
                    parameterSyntax.Annotations,
                    AttributeTargetKind.Param,
                    Binder.ParameterAllowedTargets,
                    "a parameter declaration",
                    System.AttributeTargets.Parameter);

                var parameterSymbol = parameterSymbolBySyntax[pIndex];
                if (parameterSymbol != null && !paramAttrs.IsDefaultOrEmpty)
                {
                    parameterSymbol.SetAttributes(paramAttrs);

                    // Issue #180 / ADR-0040: validate @EnumeratorCancellation.
                    // The attribute marks the cancellation-token parameter that
                    // the async-sequence rewriter threads through, so it is
                    // only meaningful when (a) the parameter's type is
                    // System.Threading.CancellationToken and (b) the enclosing
                    // function returns IAsyncEnumerable[T] (an `async sequence`).
                    // Diagnostics are reported per offending attribute; the
                    // attribute is still attached so downstream tooling can
                    // observe the user's intent.
                    var ecAttr = KnownAttributes.FindEnumeratorCancellation(paramAttrs);
                    if (ecAttr != null)
                    {
                        if (parameterSymbol.Type?.ClrType.IsSameAs(typeof(System.Threading.CancellationToken)) != true)
                        {
                            Diagnostics.ReportEnumeratorCancellationWrongType(
                                parameterSyntax.Location,
                                parameterSymbol.Name,
                                parameterSymbol.Type?.Name ?? "?");
                        }
                        else if (!isAsyncSequenceReturnType(type))
                        {
                            Diagnostics.ReportEnumeratorCancellationNotAsyncSequence(
                                parameterSyntax.Location,
                                parameterSymbol.Name);
                        }
                    }
                }
            }

            FunctionSymbol function;
            if (methodReceiverStruct != null)
            {
                var methodName = syntax.Identifier.Text;

                // ADR-0079 / issue #719: warn when a receiver-clause method
                // targets a same-package ("owned") struct or class. The
                // canonical form for owned-type instance methods is the
                // in-body declaration; the receiver-clause form is reserved
                // for non-owned types (imported CLR or referenced-package
                // types). Operators are exempt because they have no in-body
                // counterpart — the parser synthesises an `op_*`-prefixed
                // identifier for `func (a T) operator …`.
                if (!methodName.StartsWith("op_", StringComparison.Ordinal))
                {
                    Diagnostics.ReportReceiverClauseOnOwnedType(
                        syntax.Receiver.Type.Location,
                        methodReceiverStruct.Name,
                        methodName);
                }

                if (methodReceiverStruct.IsInline && IsInlineSynthesizedMemberName(methodName))
                {
                    Diagnostics.ReportInlineStructSynthesizedMemberConflict(syntax.Identifier.Location, methodReceiverStruct.Name, methodName);
                    return;
                }

                if (methodReceiverStruct.IsData && IsDataStructSynthesizedMemberName(methodName))
                {
                    Diagnostics.ReportDataStructSynthesizedMemberConflict(syntax.Identifier.Location, methodReceiverStruct.Name, methodName);
                    return;
                }

                if (methodReceiverStruct.TryGetField(methodName, out _))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, methodName);
                    return;
                }

                function = new FunctionSymbol(
                    methodName,
                    parameters.ToImmutable(),
                    type,
                    syntax,
                    package,
                    accessibility,
                    methodReceiverStruct,
                    explicitReceiverParameter);
                function.TypeParameters = typeParameters;
                function.IsAsync = syntax.IsAsync || isAsyncIteratorReturnType(type);
                function.ReturnRefKind = returnRefKind;
                Binder.AttachDocumentation(function, syntax);
                function.SetAttributes(functionAttributes);
                ValidateInlineDataNilArguments(functionAttributes, function.Parameters);

                // ADR-0063 §11: detect duplicate-signature against existing methods on the receiver.
                foreach (var existingMethod in methodReceiverStruct.Methods)
                {
                    if (BoundScope.FunctionSignaturesEqual(existingMethod, function))
                    {
                        Diagnostics.ReportDuplicateOverloadSignature(
                            syntax.Identifier.Location,
                            methodName,
                            Binder.FormatOverloadSignature(function));
                        return;
                    }
                }

                methodReceiverStruct.AddMethods(ImmutableArray.Create(function));

                // ADR-0096 / issue #762: a receiver-clause method is
                // never a P/Invoke (GS0326 would also fire for the
                // shape), so any `@MarshalAs` on a parameter is rejected
                // with GS0360 to make the misuse explicit.
                PInvokeBinder.ReportMarshalAsOnNonPInvokeFunction(syntax, Diagnostics);
                return;
            }

            function = new FunctionSymbol(syntax.Identifier.Text, parameters.ToImmutable(), type, syntax, package, accessibility);
            function.TypeParameters = typeParameters;
            function.IsAsync = syntax.IsAsync || isAsyncIteratorReturnType(type);
            function.ReturnRefKind = returnRefKind;
            Binder.AttachDocumentation(function, syntax);
            function.SetAttributes(functionAttributes);
            ValidateInlineDataNilArguments(functionAttributes, function.Parameters);

            // ADR-0086 / issue #727: when @DllImport is present and well-formed,
            // attach the resolved PInvokeMetadata so the emitter wires the
            // ImplMap row and the body-binder skips body binding. If the user
            // wrote `;` but no @DllImport, surface GS0325.
            var isPInvoke = PInvokeBinder.TryAttachPInvokeMetadata(function, syntax, Diagnostics);
            if (!isPInvoke && syntax.HasSemicolonBody)
            {
                Diagnostics.ReportSemicolonBodyRequiresDllImport(syntax.Identifier.Location, function.Name);
            }

            // ADR-0096 / issue #762: `@MarshalAs` on a non-P/Invoke
            // parameter has no CLR-defined meaning (it is a pseudo-custom
            // attribute encoded into a FieldMarshal table row, but the
            // managed-call ABI does not consult that row). Report GS0360
            // so the misuse is not silently elided.
            if (!isPInvoke)
            {
                PInvokeBinder.ReportMarshalAsOnNonPInvokeFunction(syntax, Diagnostics);
            }

            if (syntax.IsExtension)
            {
                function.IsExtension = true;
                function.ExtensionReceiverType = receiverType;
                if (function.Declaration.Identifier.Text != null && !scope.TryDeclareExtensionFunction(function))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, function.Name);
                }

                return;
            }

            if (function.Declaration.Identifier.Text != null && !scope.TryDeclareFunction(function))
            {
                // ADR-0063 §11: if the collision is with another callable of
                // the same name, it is a duplicate-signature error rather
                // than a generic redeclaration.
                var existingOverloads = scope.TryLookupFunctions(function.Name);
                var duplicateSig = false;
                foreach (var existing in existingOverloads)
                {
                    if (BoundScope.FunctionSignaturesEqual(existing, function))
                    {
                        duplicateSig = true;
                        break;
                    }
                }

                if (duplicateSig)
                {
                    Diagnostics.ReportDuplicateOverloadSignature(syntax.Identifier.Location, function.Name, Binder.FormatOverloadSignature(function));
                }
                else
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, function.Name);
                }
            }
        }
        finally
        {
            binderCtx.CurrentTypeParameters = previousTypeParameters;
        }
    }

    private static bool IsInlineSynthesizedMemberName(string methodName)
    {
        return methodName == "Equals" ||
            methodName == "GetHashCode" ||
            methodName == "ToString" ||
            methodName == "op_Equality" ||
            methodName == "op_Inequality" ||
            methodName == "Deconstruct";
    }

    /// <summary>
    /// Issue #410 / ADR-0029: data structs synthesize the same six member
    /// names as inline structs (<c>Equals</c>, <c>GetHashCode</c>,
    /// <c>ToString</c>, <c>op_Equality</c>, <c>op_Inequality</c>,
    /// <c>Deconstruct</c>). User code may not hand-write any of them.
    /// </summary>
    private static bool IsDataStructSynthesizedMemberName(string methodName)
    {
        return IsInlineSynthesizedMemberName(methodName);
    }

    private bool IsSamePackageNonAggregateReceiver(TypeClauseSyntax receiverSyntax, TypeSymbol receiverType, PackageSymbol package)
    {
        if (receiverType is InterfaceSymbol iface)
        {
            return string.Equals(iface.PackageName, package.Name, StringComparison.Ordinal);
        }

        if (receiverType is EnumSymbol enumSymbol)
        {
            return string.Equals(enumSymbol.PackageName, package.Name, StringComparison.Ordinal);
        }

        var receiverName = receiverSyntax?.Identifier?.Text;
        return receiverName != null
            && !isPrimitiveTypeName(receiverName)
            && scope.TryLookupTypeAlias(receiverName, out var aliased)
            && ReferenceEquals(aliased, receiverType)
            && receiverType is not StructSymbol;
    }

    private ImmutableArray<TypeParameterSymbol> BindTypeParameterList(TypeParameterListSyntax syntax)
    {
        if (syntax == null)
        {
            return ImmutableArray<TypeParameterSymbol>.Empty;
        }

        var count = syntax.Parameters.Count;
        var symbols = new TypeParameterSymbol[count];
        var seen = new HashSet<string>();

        // Pass 1: create the bare type-parameter symbols (name, ordinal, variance)
        // so that a constraint clause appearing later in the list — or a
        // self-referential constraint such as `[T IComparable[T]]` (issue #943)
        // / `[T IAdd[T]]` (ADR-0089) — can resolve every in-flight type
        // parameter while binding the constraint type below.
        for (var i = 0; i < count; i++)
        {
            var p = syntax.Parameters[i];
            var name = p.Identifier.Text;
            if (!seen.Add(name))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(p.Identifier.Location, name);
            }

            var variance = TypeParameterVariance.None;
            if (p.VarianceModifier != null)
            {
                variance = p.VarianceModifier.Text == "in" ? TypeParameterVariance.In : TypeParameterVariance.Out;
            }

            symbols[i] = new TypeParameterSymbol(name, i, TypeParameterConstraint.Any, variance);
        }

        // Publish the bare symbols into the binder's type-parameter scope so the
        // constraint type clauses bound in pass 2 can see them. Enclosing type
        // parameters (e.g. for a generic method declared inside a generic type)
        // remain visible because we copy the previous map.
        var previousTypeParameters = binderCtx.CurrentTypeParameters;
        var constraintScope = previousTypeParameters == null
            ? new Dictionary<string, TypeParameterSymbol>()
            : new Dictionary<string, TypeParameterSymbol>(previousTypeParameters);
        foreach (var s in symbols)
        {
            constraintScope[s.Name] = s;
        }

        binderCtx.CurrentTypeParameters = constraintScope;
        try
        {
            // Pass 2: resolve each constraint against the published scope.
            for (var i = 0; i < count; i++)
            {
                var p = syntax.Parameters[i];
                var symbol = symbols[i];
                var name = symbol.Name;

                if (p.Constraint != null)
                {
                    switch (p.Constraint.Text)
                    {
                        case "any":
                            symbol.Constraint = TypeParameterConstraint.Any;
                            break;
                        case "comparable":
                            symbol.Constraint = TypeParameterConstraint.Comparable;
                            break;
                        default:
                            ResolveInterfaceConstraint(p, symbol);
                            break;
                    }
                }

                // ADR-0097 / issue #775: consume the `class` / `struct` / `new()`
                // flag-style constraints. Disjoint combinations (`class struct`,
                // `struct new()`) are rejected as GS0361. The order is determined
                // by the syntax — combining class + new() is legal and produces
                // both CLR flag bits.
                var hasRefType = p.HasClassConstraint;
                var hasValueType = p.HasStructConstraint;
                var hasDefaultCtor = p.HasNewConstraint;

                if (hasRefType && hasValueType)
                {
                    Diagnostics.ReportTypeParameterConstraintConflict(p.StructConstraintKeyword.Location, name, "class", "struct");
                    hasValueType = false;
                }

                if (hasValueType && hasDefaultCtor)
                {
                    // `struct` already implies `new()` at the CLR level (ECMA-335 II.10.1.7);
                    // emitting both would be redundant and would force callers to
                    // remember an arbitrary order. Flag the explicit `new()`.
                    Diagnostics.ReportTypeParameterConstraintConflict(p.NewConstraintKeyword.Location, name, "struct", "new()");
                    hasDefaultCtor = false;
                }

                symbol.HasReferenceTypeConstraint = hasRefType;
                symbol.HasValueTypeConstraint = hasValueType;
                symbol.HasDefaultConstructorConstraint = hasDefaultCtor;
            }
        }
        finally
        {
            binderCtx.CurrentTypeParameters = previousTypeParameters;
        }

        return ImmutableArray.Create(symbols);
    }

    /// <summary>
    /// Resolves a non-keyword type-parameter constraint (anything other than
    /// <c>any</c> / <c>comparable</c>) as an interface bound and records it on
    /// <paramref name="symbol"/>.
    /// <para>
    /// Phase 4.2b / ADR-0020 accepts a G#-declared sealed interface. ADR-0089
    /// accepts a constructed generic G# interface carrying static-virtual
    /// members (e.g. <c>[T IAdd[T]]</c>). Issue #943 generalises this to any
    /// imported CLR interface — generic or not — so the canonical C#
    /// <c>where T : IComparable&lt;T&gt;</c> shape (<c>[T IComparable[T]]</c>)
    /// binds, dispatches instance members, and emits verifiable IL. The
    /// constraint type clause is bound through the regular type binder, so a
    /// self-referential type argument (the type parameter appearing in its own
    /// constraint) resolves against the in-flight scope published by
    /// <see cref="BindTypeParameterList"/>.
    /// </para>
    /// </summary>
    /// <param name="p">The type-parameter syntax carrying the constraint.</param>
    /// <param name="symbol">The bare type-parameter symbol to annotate.</param>
    private void ResolveInterfaceConstraint(TypeParameterSyntax p, TypeParameterSymbol symbol)
    {
        var constraintClause = new TypeClauseSyntax(
            p.SyntaxTree,
            openBracketToken: null,
            lengthToken: null,
            closeBracketToken: null,
            identifier: p.Constraint,
            typeArgumentOpenBracketToken: p.ConstraintTypeArgumentOpenBracketToken,
            typeArguments: p.ConstraintTypeArguments,
            typeArgumentCloseBracketToken: p.ConstraintTypeArgumentCloseBracketToken,
            questionToken: null);

        var resolved = bindTypeClause(constraintClause);
        if (resolved == null || ReferenceEquals(resolved, TypeSymbol.Error))
        {
            // bindTypeClause already reported the failure (e.g. undefined type).
            return;
        }

        if (resolved is InterfaceSymbol iface)
        {
            var definition = iface.Definition ?? iface;
            if (!definition.IsSealed && !definition.HasStaticVirtualMembers)
            {
                Diagnostics.ReportInterfaceConstraintNotSealed(p.Constraint.Location, definition.Name);
            }

            symbol.InterfaceConstraint = iface;
            return;
        }

        // Issue #943: an imported CLR interface (generic or not). Reference-set
        // interfaces are universally implementable, so no sealedness rule
        // applies; the GenericParamConstraint metadata row carries the bound.
        if (resolved.ClrType is { IsInterface: true })
        {
            symbol.ClrInterfaceConstraint = resolved;
            return;
        }

        // Resolved to something that is not an interface (a class, struct, …) —
        // not a legal constraint.
        Diagnostics.ReportInterfaceConstraintNotSealed(p.Constraint.Location, resolved.Name);
    }

    private static bool SignaturesMatch(FunctionSymbol baseMethod, ImmutableArray<ParameterSymbol> derivedParams, TypeSymbol derivedReturnType)
        => SignaturesMatch(baseMethod, derivedParams, derivedReturnType, RefKind.None);

    private static bool SignaturesMatch(FunctionSymbol baseMethod, ImmutableArray<ParameterSymbol> derivedParams, TypeSymbol derivedReturnType, RefKind derivedReturnRefKind)
    {
        if (baseMethod.Type != derivedReturnType)
        {
            return false;
        }

        // Issue #490: ref-returning methods must agree on the ref-return-ness with their
        // base or interface; otherwise the override is signature-incompatible.
        if (baseMethod.ReturnRefKind != derivedReturnRefKind)
        {
            return false;
        }

        var baseParams = GetCallableParameters(baseMethod);
        if (baseParams.Length != derivedParams.Length)
        {
            return false;
        }

        for (var i = 0; i < derivedParams.Length; i++)
        {
            if (baseParams[i].Type != derivedParams[i].Type)
            {
                return false;
            }

            // ADR-0060 §9: two functions that differ only in a parameter's ref-kind
            // are *different signatures*. Required for CLR-faithful override / interface-
            // implementation matching.
            if (baseParams[i].RefKind != derivedParams[i].RefKind)
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// ADR-0060 §9: when <see cref="SignaturesMatch(FunctionSymbol, ImmutableArray{ParameterSymbol}, TypeSymbol)"/> rejected an override / interface
    /// implementation, returns the index of the first parameter whose ref-kind disagrees
    /// (return type and pointee types all matching). Returns -1 when the disagreement is
    /// something other than a ref-kind mismatch (so the caller can fall back to the generic
    /// "signature mismatch" diagnostic).
    /// </summary>
    private static int FindRefKindMismatchIndex(FunctionSymbol baseMethod, ImmutableArray<ParameterSymbol> derivedParams, TypeSymbol derivedReturnType)
    {
        if (baseMethod.Type != derivedReturnType)
        {
            return -1;
        }

        var baseParams = GetCallableParameters(baseMethod);
        if (baseParams.Length != derivedParams.Length)
        {
            return -1;
        }

        for (var i = 0; i < derivedParams.Length; i++)
        {
            if (baseParams[i].Type != derivedParams[i].Type)
            {
                return -1;
            }
        }

        for (var i = 0; i < derivedParams.Length; i++)
        {
            if (baseParams[i].RefKind != derivedParams[i].RefKind)
            {
                return i;
            }
        }

        return -1;
    }

    private static ImmutableArray<ParameterSymbol> GetCallableParameters(FunctionSymbol method)
        => method.ExplicitReceiverParameter == null ? method.Parameters : method.Parameters.RemoveAt(0);

    /// <summary>
    /// Issue #490 (ADR-0060 follow-up): validates a function's optional <c>ref</c> return modifier
    /// against the declared return type and async/iterator constraints, reporting diagnostics
    /// for invalid combinations. Returns <see cref="RefKind.Ref"/> when the function should be
    /// modeled as ref-returning, <see cref="RefKind.None"/> otherwise.
    /// </summary>
    /// <summary>
    /// ADR-0101 / issue #799 + #812 — shared validation for variadic
    /// (<c>...T</c>) parameters on any declaration kind (top-level
    /// function, class instance method, class static method, interface
    /// method, constructor, delegate, lambda). Reports
    /// <c>GS0145</c> ("variadic parameter must be the last parameter")
    /// for every variadic parameter that is not the last syntactic
    /// parameter, and <c>GS0364</c> ("a signature may declare at most
    /// one variadic parameter") for any second-or-later occurrence.
    /// The caller is responsible for wrapping the parameter's element
    /// type in a <see cref="SliceTypeSymbol"/> and setting
    /// <see cref="ParameterSymbol.IsVariadic"/>.
    /// </summary>
    private void ValidateVariadicParameterShape(SeparatedSyntaxList<ParameterSyntax> parameters)
    {
        var firstVariadicSeen = false;
        for (var i = 0; i < parameters.Count; i++)
        {
            if (!parameters[i].IsVariadic)
            {
                continue;
            }

            if (firstVariadicSeen)
            {
                Diagnostics.ReportMultipleVariadicParameters(parameters[i].Location, parameters[i].Identifier.Text);
            }

            firstVariadicSeen = true;
            if (i < parameters.Count - 1)
            {
                Diagnostics.ReportVariadicParameterMustBeLast(parameters[i].Location, parameters[i].Identifier.Text);
            }
        }
    }

    private RefKind ValidateReturnRefKind(FunctionDeclarationSyntax syntax, TypeSymbol returnType)
    {
        if (!syntax.IsRefReturn)
        {
            return RefKind.None;
        }

        if (syntax.Type == null)
        {
            Diagnostics.ReportRefReturnRequiresReturnType(syntax.ReturnRefModifier.Location);
            return RefKind.None;
        }

        if (syntax.IsAsync)
        {
            Diagnostics.ReportRefReturnOnAsyncOrIterator(syntax.ReturnRefModifier.Location, "async");
            return RefKind.None;
        }

        if (returnType is SequenceTypeSymbol)
        {
            Diagnostics.ReportRefReturnOnAsyncOrIterator(syntax.ReturnRefModifier.Location, "sequence");
            return RefKind.None;
        }

        if (returnType is AsyncSequenceTypeSymbol)
        {
            Diagnostics.ReportRefReturnOnAsyncOrIterator(syntax.ReturnRefModifier.Location, "async sequence");
            return RefKind.None;
        }

        if (returnType is ByRefTypeSymbol)
        {
            Diagnostics.ReportRefReturnOfByRefType(syntax.ReturnRefModifier.Location);
            return RefKind.None;
        }

        return RefKind.Ref;
    }

    internal VariableSymbol BindVariableDeclaration(SyntaxToken identifier, bool isReadOnly, TypeSymbol type)
    {
        return BindVariableDeclaration(identifier, isReadOnly, type, Accessibility.Public);
    }

    internal VariableSymbol BindVariableDeclaration(SyntaxToken identifier, bool isReadOnly, TypeSymbol type, Accessibility accessibility)
    {
        var name = identifier.Text ?? "?";
        var declare = !identifier.IsMissing;

        // ADR-0066 D1: variables declared inside top-level statements live on
        // `BoundGlobalScope.Variables` as `GlobalVariableSymbol`s even though
        // the enclosing synthesized `<Main>$` is a non-null function (so that
        // `return` / `await` validation works). Treat the synthesized entry
        // point as a top-level context for variable-creation purposes only.
        var inTopLevelContext = function == null || function.IsTopLevelEntryPoint;
        var variable = inTopLevelContext
                            ? (VariableSymbol)new GlobalVariableSymbol(name, isReadOnly, type, accessibility, declaringSyntax: identifier)
                            : new LocalVariableSymbol(name, isReadOnly, type, declaringSyntax: identifier);

        if (declare && !scope.TryDeclareVariable(variable))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(identifier.Location, name);
        }

        return variable;
    }

    /// <summary>
    /// Issue #306: binds the explicit base-constructor argument list
    /// (<c>: Base(args)</c>) of a class declaration and resolves it against the
    /// base class's constructors. The arguments are bound in a scope that
    /// exposes the primary-constructor parameters so they can be forwarded to
    /// the base. On success the resolved <see cref="BaseConstructorInitializer"/>
    /// is recorded on <paramref name="structSymbol"/> for the emitter; failures
    /// surface a diagnostic.
    /// </summary>
    private void BindBaseConstructorInitializer(
        StructDeclarationSyntax syntax,
        StructSymbol structSymbol,
        StructSymbol baseClassSymbol,
        TypeSymbol importedBaseType,
        ImmutableArray<ParameterSymbol> primaryCtorParameters)
    {
        if (!syntax.HasBaseConstructorArguments)
        {
            return;
        }

        var location = syntax.BaseConstructorOpenParenthesisToken.Location;

        if (baseClassSymbol == null && importedBaseType == null)
        {
            Diagnostics.ReportBaseConstructorArgumentsWithoutBase(location);
            return;
        }

        // Bind the argument expressions with the primary-constructor parameters
        // in scope (they are the typical source of forwarded values).
        var savedScope = scope;
        scope = new BoundScope(savedScope);
        if (!primaryCtorParameters.IsDefaultOrEmpty)
        {
            foreach (var p in primaryCtorParameters)
            {
                scope.TryDeclareVariable(p);
            }
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(syntax.BaseConstructorArguments.Count);
        for (var i = 0; i < syntax.BaseConstructorArguments.Count; i++)
        {
            boundArguments.Add(bindExpression(syntax.BaseConstructorArguments[i]));
        }

        scope = savedScope;

        if (importedBaseType?.ClrType is System.Type clrBase)
        {
            var clrInit = ResolveClrBaseConstructor(i => syntax.BaseConstructorArguments[i].Location, clrBase, boundArguments, location);
            if (clrInit != null)
            {
                structSymbol.SetBaseConstructorInitializer(clrInit);
            }

            return;
        }

        var gsharpInit = ResolveGSharpBaseConstructor(i => syntax.BaseConstructorArguments[i].Location, structSymbol.Name, baseClassSymbol, boundArguments, location);
        if (gsharpInit != null)
        {
            structSymbol.SetBaseConstructorInitializer(gsharpInit);
        }
    }

    /// <summary>Resolves a base-constructor initializer against an imported CLR base type's constructors (issue #306). Returns <c>null</c> (after reporting a diagnostic) when no accessible constructor matches.</summary>
    private BaseConstructorInitializer ResolveClrBaseConstructor(
        System.Func<int, TextLocation> argLocation,
        System.Type clrBase,
        ImmutableArray<BoundExpression>.Builder boundArguments,
        TextLocation location)
    {
        var ctors = ClrTypeUtilities.SafeGetConstructors(clrBase, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
            .Where(c => c.IsPublic || c.IsFamily || c.IsFamilyOrAssembly)
            .ToArray();

        var argTypes = new System.Type[boundArguments.Count];
        var argsAllTyped = true;
        for (var i = 0; i < boundArguments.Count; i++)
        {
            // Issue #530: use GetEffectiveArgumentClrType (see instance method path).
            // Issue #533: allow null (nil literal) through.
            var t = getEffectiveArgumentClrType(boundArguments[i].Type);
            if (t == null && boundArguments[i].Type != TypeSymbol.Null)
            {
                argsAllTyped = false;
                break;
            }

            argTypes[i] = t;
        }

        ConstructorInfo bestCtor = null;
        var isExpanded = false;
        if (argsAllTyped)
        {
            var resolution = OverloadResolution.Resolve(ctors, argTypes);
            switch (resolution.Outcome)
            {
                case OverloadResolution.ResolutionOutcome.Resolved:
                    bestCtor = resolution.Best as ConstructorInfo;
                    isExpanded = resolution.IsExpanded;
                    break;
                case OverloadResolution.ResolutionOutcome.Ambiguous:
                    Diagnostics.ReportAmbiguousOverload(location, clrBase.Name, resolution.Ambiguous.Length, resolution.Ambiguous.Select(OverloadResolution.FormatMethodSignature));
                    return null;
                default:
                    break;
            }
        }

        if (bestCtor == null)
        {
            Diagnostics.ReportNoMatchingBaseConstructor(location, clrBase.Name, boundArguments.Count);
            return null;
        }

        // Issue #306 (item 2): honor `ref`/`out`/`in` base-constructor parameters.
        // For a by-ref parameter the bound argument must already be an address-of
        // expression (`&x`); the emitter forwards the address rather than a value.
        var ctorParams = bestCtor.GetParameters();

        // Issue #506 follow-up: when overload resolution selected the expanded
        // form of a `params T[]` base ctor (e.g. `init() : base(1, 2, 3, 4)`
        // flowing into a C# `Base(int x, params int[] tail)`), pack the trailing
        // positional arguments into a synthesised slice/array first. The fixed
        // leading parameters and the synthesised array slot then go through the
        // same per-parameter ref/conversion loop as the normal-form path.
        ImmutableArray<BoundExpression> orderedArgs;
        if (isExpanded)
        {
            var paramsIndex = ctorParams.Length - 1;
            var paramArrayType = ctorParams[paramsIndex].ParameterType;
            var elementClrType = paramArrayType.GetElementType();
            var elementTypeSymbol = elementClrType == null
                ? TypeSymbol.Object
                : TypeSymbol.FromClrType(elementClrType);
            var sliceType = SliceTypeSymbol.Get(elementTypeSymbol);

            var tailCount = boundArguments.Count - paramsIndex;
            var packed = ImmutableArray.CreateBuilder<BoundExpression>(tailCount);
            for (var j = 0; j < tailCount; j++)
            {
                var srcIndex = paramsIndex + j;
                var element = boundArguments[srcIndex];
                if (element.Type != null && element.Type != TypeSymbol.Error && element.Type != elementTypeSymbol)
                {
                    if (Conversion.Classify(element.Type, elementTypeSymbol).Exists)
                    {
                        element = conversions.BindConversion(argLocation(srcIndex), element, elementTypeSymbol, allowExplicit: true);
                    }
                    else if (conversions.TryApplyUserDefinedImplicitArgumentConversion(element, elementTypeSymbol, out var udc))
                    {
                        element = udc;
                    }
                }

                packed.Add(element);
            }

            var arrayExpr = new BoundArrayCreationExpression(syntax: null, sliceType, packed.MoveToImmutable());

            var expandedBuilder = ImmutableArray.CreateBuilder<BoundExpression>(ctorParams.Length);
            for (var i = 0; i < paramsIndex; i++)
            {
                expandedBuilder.Add(boundArguments[i]);
            }

            expandedBuilder.Add(arrayExpr);
            orderedArgs = expandedBuilder.MoveToImmutable();
        }
        else
        {
            orderedArgs = boundArguments.ToImmutable();
        }

        var refKindsBuilder = ImmutableArray.CreateBuilder<RefKind>(ctorParams.Length);
        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(ctorParams.Length);
        for (var i = 0; i < ctorParams.Length; i++)
        {
            var clrParamType = ctorParams[i].ParameterType;
            if (clrParamType.IsByRef)
            {
                var refKind = ctorParams[i].IsOut ? RefKind.Out
                    : ctorParams[i].IsIn ? RefKind.In
                    : RefKind.Ref;
                refKindsBuilder.Add(refKind);

                // A by-ref argument is forwarded as-is (it is already a managed
                // pointer, e.g. the result of `&x`); no value conversion applies.
                convertedArgs.Add(orderedArgs[i]);
                continue;
            }

            refKindsBuilder.Add(RefKind.None);
            var targetType = TypeSymbol.FromClrType(clrParamType);
            var argLoc = isExpanded && i == ctorParams.Length - 1
                ? location
                : argLocation(i);
            var orderedArg = orderedArgs[i];

            // Issue #506 follow-up: when the synthesised params array already
            // carries the exact CLR type of the parameter (SliceTypeSymbol(T)
            // → T[]), skip the rebinding so the emitter sees the original
            // array-creation expression without an extra conversion wrapper.
            if (orderedArg.Type?.ClrType != null && orderedArg.Type.ClrType == clrParamType)
            {
                convertedArgs.Add(orderedArg);
            }
            else
            {
                convertedArgs.Add(conversions.BindConversion(argLoc, orderedArg, targetType));
            }
        }

        return new BaseConstructorInitializer(convertedArgs.ToImmutable(), bestCtor, refKindsBuilder.ToImmutable());
    }

    /// <summary>Resolves a base-constructor initializer against a GSharp base class's primary constructor (issue #306). Returns <c>null</c> (after reporting a diagnostic) when no match.</summary>
    private BaseConstructorInitializer ResolveGSharpBaseConstructor(
        System.Func<int, TextLocation> argLocation,
        string derivedNameForDiag,
        StructSymbol baseClassSymbol,
        ImmutableArray<BoundExpression>.Builder boundArguments,
        TextLocation location)
    {
        if (baseClassSymbol == null)
        {
            Diagnostics.ReportNoMatchingBaseConstructor(location, derivedNameForDiag, boundArguments.Count);
            return null;
        }

        var baseParams = baseClassSymbol.PrimaryConstructorParameters;
        if (boundArguments.Count != baseParams.Length)
        {
            Diagnostics.ReportNoMatchingBaseConstructor(location, baseClassSymbol.Name, boundArguments.Count);
            return null;
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(boundArguments.Count);
        for (var i = 0; i < boundArguments.Count; i++)
        {
            var argument = boundArguments[i];
            var parameter = baseParams[i];
            if (argument.Type != parameter.Type
                && !Conversion.Classify(argument.Type, parameter.Type).IsImplicit)
            {
                if (argument.Type != TypeSymbol.Error)
                {
                    Diagnostics.ReportNoMatchingBaseConstructor(location, baseClassSymbol.Name, boundArguments.Count);
                }

                return null;
            }

            convertedArgs.Add(conversions.BindConversion(argLocation(i), argument, parameter.Type));
        }

        return new BaseConstructorInitializer(convertedArgs.ToImmutable(), baseClassSymbol);
    }

    /// <summary>
    /// Issue #306: binds the standalone user-defined constructors (<c>init(...)</c>)
    /// declared in a class body. Each constructor becomes a <see cref="ConstructorSymbol"/>
    /// whose body is bound in <see cref="Binder.BindProgram(BoundGlobalScope, ReferenceResolver)"/> as an instance-method body and
    /// emitted/interpreted as a <c>.ctor</c>.
    /// </summary>
    private void BindConstructorDeclarations(
        StructDeclarationSyntax syntax,
        StructSymbol structSymbol,
        PackageSymbol package,
        StructSymbol baseClassSymbol,
        TypeSymbol importedBaseType)
    {
        // ADR-0065 §5: a class with a primary-constructor parameter list and
        // no explicit `init(...)` body still needs ExplicitConstructors set up
        // for the convenience-init self-delegation lookup, but the emitter
        // already handles the primary-ctor-only case via its existing
        // ClassPrimaryCtorHandles path. We only need to materialize a
        // synthesized designated ConstructorSymbol when there are also
        // explicit init(...) bodies (so that primary becomes a peer in the
        // overload set), or when a class needs an init(...) overload for
        // diagnostics or chaining purposes. For pure primary-ctor classes we
        // leave the existing path unchanged.
        if (syntax.Constructors.IsDefaultOrEmpty)
        {
            return;
        }

        if (!structSymbol.IsClass)
        {
            return;
        }

        // ADR-0065 §5: when both a primary-constructor parameter list and
        // explicit `init(...)` bodies are declared, the primary constructor
        // becomes a synthesized designated initializer that participates in
        // the overload set alongside the explicit bodies. Duplicate signatures
        // are diagnosed below by the same overload-equality check that catches
        // collisions between two user-declared init overloads.
        ConstructorSymbol synthesizedPrimary = null;
        if (structSymbol.HasPrimaryConstructor)
        {
            synthesizedPrimary = SynthesizePrimaryConstructor(structSymbol, package);
        }

        // ADR-0063 §9: bind every declared init(...) constructor. Duplicate
        // signatures are diagnosed as GS0264 the same way as duplicate method
        // overloads, so each surviving ConstructorSymbol carries a unique
        // signature within the overload family.
        var ctorBuilder = ImmutableArray.CreateBuilder<ConstructorSymbol>();
        if (synthesizedPrimary != null)
        {
            ctorBuilder.Add(synthesizedPrimary);
        }

        foreach (var ctorSyntax in syntax.Constructors)
        {
            var ctor = BindSingleConstructorDeclaration(ctorSyntax, structSymbol, package, baseClassSymbol, importedBaseType);
            if (ctor == null)
            {
                continue;
            }

            // ADR-0065 §2: enforce constraints on convenience initializers.
            if (ctor.IsConvenience && ctor.BaseInitializer != null)
            {
                Diagnostics.ReportConvenienceInitMayNotCallBase(ctorSyntax.BaseKeyword.Location, structSymbol.Name);
            }

            var duplicate = false;
            foreach (var existing in ctorBuilder)
            {
                if (BoundScope.FunctionSignaturesEqual(existing.Function, ctor.Function))
                {
                    duplicate = true;
                    break;
                }
            }

            if (duplicate)
            {
                // ADR-0065 §5: distinguish duplication against the synthesized
                // primary ctor from duplication between two user inits so users
                // get an actionable message.
                if (synthesizedPrimary != null
                    && BoundScope.FunctionSignaturesEqual(synthesizedPrimary.Function, ctor.Function))
                {
                    Diagnostics.ReportInitDuplicatesPrimaryCtor(
                        ctorSyntax.InitKeyword.Location,
                        structSymbol.Name,
                        Binder.FormatOverloadSignature(ctor.Function));
                }
                else
                {
                    Diagnostics.ReportDuplicateOverloadSignature(
                        ctorSyntax.InitKeyword.Location,
                        "init",
                        Binder.FormatOverloadSignature(ctor.Function));
                }

                continue;
            }

            ctorBuilder.Add(ctor);
        }

        structSymbol.SetExplicitConstructors(ctorBuilder.ToImmutable());
    }

    /// <summary>
    /// ADR-0068 / issue #698: binds the optional <c>deinit { … }</c> destructor
    /// on a class body into a synthesized <see cref="FunctionSymbol"/> named
    /// <c>Finalize</c>. The body itself is bound later in
    /// <see cref="Binder.BindProgram(BoundGlobalScope, ReferenceResolver)"/>
    /// alongside method and constructor bodies. Non-class types are rejected
    /// here so the parser-level GS0289 is never the only signal in tools that
    /// skip parser diagnostics.
    /// </summary>
    private void BindDeinitDeclaration(StructDeclarationSyntax syntax, StructSymbol structSymbol, PackageSymbol package)
    {
        var deinitSyntax = syntax.Deinitializer;
        if (deinitSyntax == null)
        {
            return;
        }

        // Defence-in-depth: the parser already reports GS0289 when `deinit`
        // appears inside a non-class body, but if a downstream tool feeds us
        // such a tree directly we must still refuse to synthesise a Finalize
        // symbol for the value type.
        if (!structSymbol.IsClass)
        {
            return;
        }

        var ctorFunction = new FunctionSymbol(
            "Finalize",
            ImmutableArray<ParameterSymbol>.Empty,
            TypeSymbol.Void,
            declaration: null,
            package,
            Accessibility.Private,
            receiverType: structSymbol);

        var deinitSymbol = new DeinitSymbol(ctorFunction, deinitSyntax);
        structSymbol.SetDeinitializer(deinitSymbol);
    }

    /// <summary>
    /// ADR-0065 §5: synthesizes a designated <see cref="ConstructorSymbol"/>
    /// whose signature matches the class's primary-constructor parameter list.
    /// The emitter produces its body (field assignments per parameter) directly
    /// rather than reading from <c>BoundProgram.Functions</c>; we leave the
    /// function's body unbound here. The synthesized ctor is marked with
    /// <see cref="ConstructorSymbol.IsSynthesizedFromPrimaryConstructor"/> so
    /// emit and overload-resolution paths can detect it.
    /// </summary>
    private ConstructorSymbol SynthesizePrimaryConstructor(StructSymbol structSymbol, PackageSymbol package)
    {
        // Reuse the primary-ctor parameter symbols verbatim — they already
        // carry the right names, types, ref-kinds and any defaults. The
        // emitter looks up the matching same-named field for each parameter.
        var parameters = structSymbol.PrimaryConstructorParameters;
        var ctorFunction = new FunctionSymbol(
            ".ctor",
            parameters,
            TypeSymbol.Void,
            declaration: null,
            package,
            Accessibility.Public,
            receiverType: structSymbol)
        {
            IsSpecialName = true,
        };

        var ctorSymbol = new ConstructorSymbol(ctorFunction, declaration: null);
        ctorSymbol.MarkSynthesizedFromPrimaryConstructor();
        return ctorSymbol;
    }

    /// <summary>
    /// ADR-0063 §9: binds a single <c>init(...)</c> constructor declaration into a
    /// <see cref="ConstructorSymbol"/> with the optional <c>: base(args)</c> initializer
    /// resolved. The caller is responsible for collecting all constructors and
    /// rejecting same-signature duplicates.
    /// </summary>
    private ConstructorSymbol BindSingleConstructorDeclaration(
        ConstructorDeclarationSyntax ctorSyntax,
        StructSymbol structSymbol,
        PackageSymbol package,
        StructSymbol baseClassSymbol,
        TypeSymbol importedBaseType)
    {
        var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>();
        var seenParameterNames = new HashSet<string>();
        foreach (var parameterSyntax in ctorSyntax.Parameters)
        {
            var parameterName = parameterSyntax.Identifier.Text;
            var parameterType = bindTypeClause(parameterSyntax.Type) ?? TypeSymbol.Error;

            // ADR-0101 follow-up / issue #812: variadic parameters are now
            // accepted on explicit `init(...)` constructors. The body sees
            // the parameter as `[]T`; constructor calls (and
            // `: this(...)` / `: base(...)` chaining) go through the
            // constructor overload paths that pack trailing arguments.
            var isVariadic = parameterSyntax.IsVariadic;
            if (isVariadic && parameterType != TypeSymbol.Error)
            {
                parameterType = SliceTypeSymbol.Get(parameterType);
            }

            var parameterRefKind = conversions.BindAndValidateParameterRefKind(
                parameterSyntax,
                parameterName,
                parameterType,
                isVariadic,
                asyncOrIteratorKind: null);

            if (!seenParameterNames.Add(parameterName))
            {
                Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
            }
            else
            {
                var ctorParam = new ParameterSymbol(parameterName, parameterType, isVariadic, declaringSyntax: parameterSyntax.Identifier, isScoped: parameterSyntax.IsScoped, refKind: parameterRefKind);
                conversions.BindAndAttachParameterDefaultValue(parameterSyntax, ctorParam);
                parameters.Add(ctorParam);
            }
        }

        ValidateVariadicParameterShape(ctorSyntax.Parameters);

        var ctorAccessibility = resolveAccessibility(ctorSyntax.AccessibilityModifier);
        var ctorFunction = new FunctionSymbol(
            ".ctor",
            parameters.ToImmutable(),
            TypeSymbol.Void,
            declaration: null,
            package,
            ctorAccessibility,
            receiverType: structSymbol)
        {
            IsSpecialName = true,
        };

        var constructorSymbol = new ConstructorSymbol(ctorFunction, ctorSyntax);
        Binder.AttachDocumentation(ctorFunction, ctorSyntax);

        // ADR-0065 §2: propagate the contextual `convenience` modifier from
        // syntax onto the symbol so the binder/emitter can apply the §2
        // rules (delegation-first, no `: base()`, this(args) chaining).
        if (ctorSyntax.IsConvenience)
        {
            constructorSymbol.MarkConvenience();
        }

        // Resolve the optional `: base(args)` initializer, with the constructor
        // parameters in scope so they can be forwarded to the base.
        if (ctorSyntax.HasBaseInitializer)
        {
            var location = ctorSyntax.BaseKeyword.Location;

            var savedScope = scope;
            scope = new BoundScope(savedScope);
            foreach (var p in ctorFunction.Parameters)
            {
                scope.TryDeclareVariable(p);
            }

            var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(ctorSyntax.BaseArguments.Count);
            for (var i = 0; i < ctorSyntax.BaseArguments.Count; i++)
            {
                boundArguments.Add(bindExpression(ctorSyntax.BaseArguments[i]));
            }

            scope = savedScope;

            if (baseClassSymbol == null && importedBaseType == null)
            {
                Diagnostics.ReportBaseConstructorArgumentsWithoutBase(location);
            }
            else if (importedBaseType?.ClrType is System.Type clrBase)
            {
                var init = ResolveClrBaseConstructor(i => ctorSyntax.BaseArguments[i].Location, clrBase, boundArguments, location);
                if (init != null)
                {
                    constructorSymbol.SetBaseInitializer(init);
                }
            }
            else
            {
                var init = ResolveGSharpBaseConstructor(i => ctorSyntax.BaseArguments[i].Location, structSymbol.Name, baseClassSymbol, boundArguments, location);
                if (init != null)
                {
                    constructorSymbol.SetBaseInitializer(init);
                }
            }
        }

        return constructorSymbol;
    }

    /// <summary>
    /// Phase 4 of #141 / ADR-0047 §5: returns true if any annotation in the
    /// list is the bare <c>@Attribute</c> sugar marker (single-segment name
    /// <c>Attribute</c>, no use-site target qualifier).
    /// </summary>
    /// <param name="annotations">Annotations from the declaration's syntax node.</param>
    /// <returns>True if the marker is present.</returns>
    private static bool HasAttributeSugarMarker(ImmutableArray<AnnotationSyntax> annotations)
    {
        if (annotations.IsDefaultOrEmpty)
        {
            return false;
        }

        foreach (var annotation in annotations)
        {
            // ADR-0047 §5: the sugar marker is exactly `@Attribute` (no
            // use-site target qualifier; no arguments; single-segment name).
            if (annotation.Target != null)
            {
                continue;
            }

            if (annotation.NameSegments.Length != 1)
            {
                continue;
            }

            if (annotation.NameSegments[0].Text == "Attribute")
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// ADR-0058 / issue #376: returns true if a function declaration carries the
    /// <c>@UnscopedRef</c> annotation, which relaxes the implicit <c>scoped</c>
    /// on a ref struct instance method's <c>this</c> parameter.
    /// </summary>
    internal static bool HasUnscopedRefAnnotation(FunctionSymbol function)
    {
        var declaration = function.Declaration;
        if (declaration == null)
        {
            return false;
        }

        var annotations = declaration.Annotations;
        if (annotations.IsDefaultOrEmpty)
        {
            return false;
        }

        foreach (var annotation in annotations)
        {
            if (annotation.Target != null)
            {
                continue;
            }

            if (annotation.NameSegments.Length == 1 && annotation.NameSegments[0].Text == "UnscopedRef")
            {
                return true;
            }

            // Also accept the fully qualified name.
            if (annotation.NameSegments.Length >= 2)
            {
                var fullName = string.Concat(annotation.NameSegments.Select(s => s.Text));
                if (fullName == "UnscopedRef" || fullName == "UnscopedRefAttribute"
                    || fullName == "System.Diagnostics.CodeAnalysis.UnscopedRef"
                    || fullName == "System.Diagnostics.CodeAnalysis.UnscopedRefAttribute")
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Phase 4 of #141 / ADR-0047 §5: returns true if <paramref name="annotation"/>
    /// is the bare <c>@Attribute</c> sugar marker.
    /// </summary>
    /// <param name="annotation">The annotation node to test.</param>
    /// <returns>True for the marker.</returns>
    private static bool IsAttributeSugarMarker(AnnotationSyntax annotation)
    {
        if (annotation == null || annotation.Target != null)
        {
            return false;
        }

        if (annotation.NameSegments.Length != 1)
        {
            return false;
        }

        return annotation.NameSegments[0].Text == "Attribute";
    }

    /// <summary>
    /// Resolves a list of <see cref="AnnotationSyntax"/> nodes against the
    /// declaring scope and returns the bound attribute list per ADR-0047.
    /// </summary>
    /// <param name="annotations">Annotations from the declaration's syntax node.</param>
    /// <param name="defaultTarget">Default target inferred from the declaration position.</param>
    /// <param name="allowedTargets">Target kinds permitted at this declaration position.</param>
    /// <param name="positionDescription">Human-readable position for diagnostics.</param>
    /// <param name="defaultSystemTarget">CLR-side <see cref="System.AttributeTargets"/>
    /// value used when validating <c>[AttributeUsage(ValidOn)]</c> for the
    /// <c>Type</c> kind, which is ambiguous in source.</param>
    /// <returns>The resolved attribute list (skipping unresolved entries).</returns>
    internal ImmutableArray<BoundAttribute> BindAttributes(
        ImmutableArray<AnnotationSyntax> annotations,
        AttributeTargetKind defaultTarget,
        ImmutableHashSet<AttributeTargetKind> allowedTargets,
        string positionDescription,
        System.AttributeTargets defaultSystemTarget)
    {
        if (annotations.IsDefaultOrEmpty)
        {
            return ImmutableArray<BoundAttribute>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<BoundAttribute>(annotations.Length);

        // Track applications per (attribute-type identity, effective target)
        // so we can fire GS0210 when AllowMultiple = false. We key on the
        // resolved TypeSymbol (reference identity is sufficient — each
        // attribute class has a single Symbol instance).
        var applications = new Dictionary<(TypeSymbol Type, AttributeTargetKind Target), int>();

        foreach (var annotation in annotations)
        {
            // Phase 4 of #141 / ADR-0047 §5: the `@Attribute` marker on a
            // class declaration is sugar — it does NOT participate in the
            // emitted CustomAttribute table. The struct binder consumes it
            // separately via HasAttributeSugarMarker.
            if (defaultTarget == AttributeTargetKind.Type && IsAttributeSugarMarker(annotation))
            {
                continue;
            }

            var bound = BindAttribute(annotation, defaultTarget, allowedTargets, positionDescription, defaultSystemTarget);
            if (bound != null)
            {
                var key = (bound.AttributeType, bound.Target);
                if (applications.TryGetValue(key, out var count))
                {
                    KnownAttributes.GetAttributeUsage(bound.AttributeType, out _, out var allowMultiple);
                    if (!allowMultiple)
                    {
                        Diagnostics.ReportAttributeUsageDuplicate(
                            GetAnnotationNameLocation(annotation),
                            annotation.GetNameText());
                    }

                    applications[key] = count + 1;
                }
                else
                {
                    applications[key] = 1;
                }

                builder.Add(bound);
            }
        }

        return builder.ToImmutable();
    }

    private BoundAttribute BindAttribute(
        AnnotationSyntax annotation,
        AttributeTargetKind defaultTarget,
        ImmutableHashSet<AttributeTargetKind> allowedTargets,
        string positionDescription,
        System.AttributeTargets defaultSystemTarget)
    {
        // 1) Resolve target — parser already filtered to canonical kinds; if
        // the user wrote an unrecognised one a GS0197 was already reported,
        // but we still need to map a parsed-but-unknown string back to a
        // sentinel. The closed set keys off ADR-0047 §2.
        var targetKind = defaultTarget;
        if (annotation.Target != null)
        {
            if (TryParseTargetKind(annotation.Target.KindIdentifier.Text, out var parsedTarget))
            {
                targetKind = parsedTarget;
            }
            else
            {
                // Already reported by the parser; treat as default and continue.
            }

            if (!allowedTargets.Contains(targetKind))
            {
                Diagnostics.ReportAttributeTargetInvalidForPosition(
                    annotation.Target.KindIdentifier.Location,
                    annotation.Target.KindIdentifier.Text,
                    positionDescription);
            }
        }

        // 2) Resolve attribute type (C#-style: `Foo` then `FooAttribute`).
        var nameText = annotation.GetNameText();
        var attrType = ResolveAttributeType(nameText, annotation, out var nameIsExact);
        if (attrType == null)
        {
            return null;
        }

        // 3) Validate it derives from System.Attribute.
        if (!IsAttributeType(attrType))
        {
            var displayName = nameIsExact ? nameText : (nameText + "Attribute");
            Diagnostics.ReportNotAnAttributeType(GetAnnotationNameLocation(annotation), displayName);
            return null;
        }

        // 3a) Reject user-written instances of attributes ADR-0047 §6
        // reserves for compiler synthesis (Extension, AsyncStateMachine,
        // CompilerGenerated, Nullable, NullableContext). Recognition is
        // type-identity based on the resolved CLR type so renaming or
        // shadowing the source-level name cannot bypass the rule.
        if (KnownAttributes.IsReservedForCompiler(attrType.ClrType))
        {
            Diagnostics.ReportAttributeReservedForCompiler(GetAnnotationNameLocation(annotation), nameText);
            return null;
        }

        // 3a.1) ADR-0086 / issue #727: the blanket rejection of @DllImport
        // (formerly GS0211, ADR-0047 §6) is removed. Well-formed P/Invoke
        // declarations bind normally here; the function-declaration binder
        // (BindFunctionDeclaration) then drives the P/Invoke pipeline:
        // validates the function shape (no body, no instance/async/generic),
        // extracts the @DllImport metadata into PInvokeMetadata, and reports
        // GS0322–GS0329 on any malformed input. The emitter picks up
        // function.PInvokeMetadata to write the ImplMap row.

        // 3b) Issue #177 / ADR-0047 §6: enforce [AttributeUsage(ValidOn)].
        // For the `Type` target the actual CLR target depends on the kind
        // of type being declared (class/struct/enum/interface), which the
        // caller passes via defaultSystemTarget. For all other targets the
        // effective CLR target is derived directly from targetKind, since
        // any use-site qualifier (`@return:` etc.) already narrows it.
        var effectiveSystemTarget = MapToSystemAttributeTargets(targetKind, defaultSystemTarget);
        KnownAttributes.GetAttributeUsage(attrType, out var validOn, out _);
        if ((validOn & effectiveSystemTarget) == 0)
        {
            Diagnostics.ReportAttributeUsageInvalidTarget(
                GetAnnotationNameLocation(annotation),
                nameText,
                positionDescription,
                validOn);
            return null;
        }

        // 4) Bind arguments — positional + named — restricted to compile-time
        // constants. Named arguments come back from ParseArguments as
        // NamedArgumentExpressionSyntax wrappers.
        var positional = ImmutableArray.CreateBuilder<BoundAttributeArgument>();
        var named = ImmutableArray.CreateBuilder<BoundAttributeArgument>();
        if (annotation.Arguments != null)
        {
            foreach (var argSyntax in annotation.Arguments)
            {
                if (argSyntax is NamedArgumentExpressionSyntax namedArg)
                {
                    if (!TryBindAttributeArgument(namedArg.Expression, out var value, out var valueType))
                    {
                        Diagnostics.ReportAttributeArgumentNotConstant(namedArg.Expression.Location);
                        continue;
                    }

                    named.Add(new BoundAttributeArgument(namedArg.NameToken.Text, value, valueType));
                }
                else
                {
                    if (!TryBindAttributeArgument(argSyntax, out var value, out var valueType))
                    {
                        Diagnostics.ReportAttributeArgumentNotConstant(argSyntax.Location);
                        continue;
                    }

                    positional.Add(new BoundAttributeArgument(name: null, value, valueType));
                }
            }
        }

        return new BoundAttribute(annotation, attrType, targetKind, positional.ToImmutable(), named.ToImmutable());
    }

    private TypeSymbol ResolveAttributeType(string name, AnnotationSyntax annotation, out bool nameIsExact)
    {
        var nameLocation = GetAnnotationNameLocation(annotation);
        nameIsExact = true;

        // The dotted form (e.g. `System.Obsolete`) is not yet routed through
        // LookupType — fall back to a CLR walk by full name. v1 keeps
        // resolution focused on the single-identifier form; dotted names
        // remain a follow-up.
        var direct = lookupType(name);
        TypeSymbol suffixed = null;
        if (!string.IsNullOrEmpty(name) && !name.EndsWith("Attribute", StringComparison.Ordinal))
        {
            suffixed = lookupType(name + "Attribute");
        }

        if (direct != null && IsAttributeType(direct) && suffixed != null && IsAttributeType(suffixed))
        {
            Diagnostics.ReportAmbiguousAttributeName(nameLocation, name);
            return direct;
        }

        if (direct != null)
        {
            nameIsExact = true;
            return direct;
        }

        if (suffixed != null)
        {
            nameIsExact = false;
            return suffixed;
        }

        Diagnostics.ReportAttributeTypeNotFound(nameLocation, name);
        return null;
    }

    private static bool IsAttributeType(TypeSymbol typeSymbol)
    {
        if (typeSymbol is StructSymbol structSym && structSym.IsAttributeClass)
        {
            return true;
        }

        var clr = typeSymbol?.ClrType;
        if (clr == null)
        {
            return false;
        }

        var attributeFullName = typeof(System.Attribute).FullName;
        for (var t = clr; t != null; t = t.BaseType)
        {
            if (t.FullName == attributeFullName)
            {
                return true;
            }
        }

        return false;
    }

    private static TextLocation GetAnnotationNameLocation(AnnotationSyntax annotation)
    {
        if (!annotation.NameSegments.IsDefaultOrEmpty)
        {
            var first = annotation.NameSegments[0];
            var last = annotation.NameSegments[annotation.NameSegments.Length - 1];
            var span = TextSpan.FromBounds(first.Span.Start, last.Span.End);
            return new TextLocation(annotation.SyntaxTree.Text, span);
        }

        return annotation.Location;
    }

    private static bool IsEnumLikeType(TypeSymbol type)
    {
        if (type is EnumSymbol)
        {
            return true;
        }

        var clr = type?.ClrType;
        return clr != null && clr.IsEnum;
    }

    private static bool TryParseTargetKind(string text, out AttributeTargetKind kind)
    {
        switch (text)
        {
            case "field": kind = AttributeTargetKind.Field; return true;
            case "param": kind = AttributeTargetKind.Param; return true;
            case "return": kind = AttributeTargetKind.Return; return true;
            case "type": kind = AttributeTargetKind.Type; return true;
            case "method": kind = AttributeTargetKind.Method; return true;
            case "property": kind = AttributeTargetKind.Property; return true;
            case "event": kind = AttributeTargetKind.Event; return true;
            case "module": kind = AttributeTargetKind.Module; return true;
            case "assembly": kind = AttributeTargetKind.Assembly; return true;
            case "genericparam": kind = AttributeTargetKind.GenericParam; return true;
            default: kind = AttributeTargetKind.Method; return false;
        }
    }

    /// <summary>
    /// Issue #177: maps a GSharp <see cref="AttributeTargetKind"/> to the
    /// corresponding CLR <see cref="System.AttributeTargets"/> flag used by
    /// <see cref="System.AttributeUsageAttribute"/>. The <c>Type</c> kind
    /// is intentionally ambiguous in GSharp (class/struct/enum/interface
    /// share a single source-level position), so the caller supplies the
    /// concrete CLR target via <paramref name="typePositionFallback"/>.
    /// </summary>
    private static System.AttributeTargets MapToSystemAttributeTargets(AttributeTargetKind kind, System.AttributeTargets typePositionFallback)
    {
        switch (kind)
        {
            case AttributeTargetKind.Field: return System.AttributeTargets.Field;
            case AttributeTargetKind.Param: return System.AttributeTargets.Parameter;
            case AttributeTargetKind.Return: return System.AttributeTargets.ReturnValue;
            case AttributeTargetKind.Method: return System.AttributeTargets.Method;
            case AttributeTargetKind.Property: return System.AttributeTargets.Property;
            case AttributeTargetKind.Event: return System.AttributeTargets.Event;
            case AttributeTargetKind.Module: return System.AttributeTargets.Module;
            case AttributeTargetKind.Assembly: return System.AttributeTargets.Assembly;
            case AttributeTargetKind.GenericParam: return System.AttributeTargets.GenericParameter;
            case AttributeTargetKind.Type: return typePositionFallback;
            default: return System.AttributeTargets.All;
        }
    }

    /// <summary>
    /// Tries to bind an attribute argument expression as a compile-time
    /// constant value of one of the shapes permitted by ECMA-335 II.23.3 /
    /// ADR-0047 §3: literal (numeric, char, string, bool, nil), a
    /// <c>typeof(T)</c> expression (carried as the resolved CLR
    /// <see cref="Type"/>), or a single-dimensional array literal of any
    /// supported element shape. Returns <c>false</c> for any expression the
    /// emitter cannot serialise.
    /// </summary>
    /// <param name="syntax">The argument expression.</param>
    /// <param name="value">The extracted compile-time value when the method returns <c>true</c>.</param>
    /// <param name="type">The static type carried by the argument when the method returns <c>true</c>.</param>
    /// <returns><c>true</c> if the expression maps to a supported attribute constant; otherwise <c>false</c>.</returns>
    private bool TryBindAttributeArgument(ExpressionSyntax syntax, out object value, out TypeSymbol type)
    {
        value = null;
        type = null;

        switch (syntax)
        {
            case LiteralExpressionSyntax literal:
                if (bindExpression(literal) is BoundLiteralExpression bl)
                {
                    value = bl.Value;
                    type = bl.Type;
                    return true;
                }

                return false;

            case TypeOfExpressionSyntax typeOfSyntax:
                if (bindTypeOfExpression(typeOfSyntax) is BoundTypeOfExpression bt
                    && bt.OperandType?.ClrType is { } clr)
                {
                    value = clr;
                    type = bt.Type;
                    return true;
                }

                return false;

            case ArrayCreationExpressionSyntax arraySyntax:
                return TryBindAttributeArrayArgument(arraySyntax, out value, out type);
        }

        // Issue #177: accept BoundLiteralExpression whose static type is an
        // enum (e.g. `AttributeTargets.Method`) — required by [AttributeUsage]
        // and other enum-valued attribute arguments. The emitter serialises
        // the underlying primitive per ECMA-335 II.23.3. Other expressions
        // that incidentally fold to a constant (e.g. `nameof(...)`) remain
        // out of scope here; they go through GS0202.
        if (bindExpression(syntax) is BoundLiteralExpression lit
            && lit.Value != null
            && IsEnumLikeType(lit.Type))
        {
            value = lit.Value;
            type = lit.Type;
            return true;
        }

        return false;
    }

    private bool TryBindAttributeArrayArgument(
        ArrayCreationExpressionSyntax syntax,
        out object value,
        out TypeSymbol type)
    {
        value = null;
        type = null;

        if (bindArrayCreationExpression(syntax) is not BoundArrayCreationExpression bound)
        {
            return false;
        }

        // Attribute arrays must be a serialisable SZARRAY (1-D) shape per
        // ECMA-335 II.23.3. Both `[]T{...}` (slice) and `[N]T{...}` (array)
        // produce a CLR `T[]` for the element type clause.
        var clrArrayType = bound.Type?.ClrType;
        if (clrArrayType == null || !clrArrayType.IsArray || clrArrayType.GetArrayRank() != 1)
        {
            return false;
        }

        var elementClrType = clrArrayType.GetElementType();
        if (elementClrType == null)
        {
            return false;
        }

        var result = Array.CreateInstance(elementClrType, syntax.Elements.Count);
        for (int i = 0; i < syntax.Elements.Count; i++)
        {
            if (!TryBindAttributeArgument(syntax.Elements[i], out var elementValue, out _))
            {
                return false;
            }

            try
            {
                result.SetValue(CoerceAttributeElement(elementValue, elementClrType), i);
            }
            catch
            {
                return false;
            }
        }

        value = result;
        type = bound.Type;
        return true;
    }

    /// <summary>
    /// Issue #660: for test-data attributes like xUnit's <c>@InlineData</c>,
    /// cross-validates nil (null) positional arguments against the owning
    /// method's parameter types. If a nil is supplied for a non-nullable
    /// parameter, reports GS0274.
    /// </summary>
    internal void ValidateInlineDataNilArguments(
        ImmutableArray<BoundAttribute> attributes,
        ImmutableArray<ParameterSymbol> parameters)
    {
        foreach (var attr in attributes)
        {
            if (attr == null)
            {
                continue;
            }

            // Match the InlineDataAttribute by CLR type name (handles any xunit version).
            var clrType = attr.AttributeType?.ClrType;
            if (clrType == null || !clrType.FullName.EndsWith("InlineDataAttribute", StringComparison.Ordinal))
            {
                continue;
            }

            var positional = attr.PositionalArguments;
            var annotation = attr.Syntax;
            if (annotation == null || positional.IsDefaultOrEmpty || parameters.IsDefaultOrEmpty)
            {
                continue;
            }

            // InlineData's positional arguments are expanded into the params
            // object[] — each positional arg[i] corresponds to method parameter[i].
            var argExpressions = annotation.Arguments;
            for (int i = 0; i < positional.Length && i < parameters.Length; i++)
            {
                if (positional[i].Value == null && positional[i].Type == TypeSymbol.Null)
                {
                    var paramType = parameters[i].Type;
                    if (paramType != null && !(paramType is NullableTypeSymbol))
                    {
                        // Get the source location of the nil literal in the argument list.
                        var argLocation = i < argExpressions.Count
                            ? argExpressions[i].Location
                            : annotation.Location;
                        Diagnostics.ReportNilNotAssignableToNonNullableParameter(
                            argLocation,
                            parameters[i].Name,
                            paramType.Name);
                    }
                }
            }
        }
    }

    private static object CoerceAttributeElement(object value, Type elementType)
    {
        if (value == null || elementType.IsInstanceOfType(value))
        {
            return value;
        }

        if (elementType.IsEnum)
        {
            var underlying = Enum.GetUnderlyingType(elementType);
            return Convert.ChangeType(value, underlying, System.Globalization.CultureInfo.InvariantCulture);
        }

        // Numeric / char widening between primitives (e.g. int → long).
        return Convert.ChangeType(value, elementType, System.Globalization.CultureInfo.InvariantCulture);
    }
}
