// <copyright file="DeclarationBinder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
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

internal sealed partial class DeclarationBinder
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
    private readonly Dictionary<InterfaceDeclarationSyntax, InterfaceSymbol> nestedInterfaceShells
        = new Dictionary<InterfaceDeclarationSyntax, InterfaceSymbol>();

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
    private FunctionSymbol function => getCurrentFunction();

    /// <summary>
    /// Issue #950: rejects a top-level declaration marked <c>protected</c>.
    /// A top-level type or function has no enclosing type to be inherited, so
    /// <c>protected</c> is meaningless there (GS0380).
    /// </summary>
    internal void ValidateTopLevelProtected(SyntaxToken modifier) => ReportProtectedToken(modifier);

    private static SyntaxToken GetMemberAccessibilityModifier(MemberSyntax member) => member switch
    {
        StructDeclarationSyntax s => s.AccessibilityModifier,
        EnumDeclarationSyntax e => e.AccessibilityModifier,
        InterfaceDeclarationSyntax i => i.AccessibilityModifier,
        DelegateDeclarationSyntax d => d.AccessibilityModifier,
        _ => null,
    };

    private ImmutableArray<TypeParameterSymbol> BindTypeParameterList(TypeParameterListSyntax syntax)
        => BindTypeParameterList(syntax, onBareSymbolsPublished: null);

    private static bool SignaturesMatch(FunctionSymbol baseMethod, ImmutableArray<ParameterSymbol> derivedParams, TypeSymbol derivedReturnType)
        => SignaturesMatch(baseMethod, derivedParams, derivedReturnType, RefKind.None);

    private static bool SignaturesMatch(FunctionSymbol baseMethod, ImmutableArray<ParameterSymbol> derivedParams, TypeSymbol derivedReturnType, RefKind derivedReturnRefKind)
        => SignaturesMatch(baseMethod, derivedParams, derivedReturnType, derivedReturnRefKind, typeParamMap: null, derivedIsAsync: false);

    private static bool SignaturesMatch(
        FunctionSymbol baseMethod,
        ImmutableArray<ParameterSymbol> derivedParams,
        TypeSymbol derivedReturnType,
        RefKind derivedReturnRefKind,
        IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> typeParamMap)
        => SignaturesMatch(baseMethod, derivedParams, derivedReturnType, derivedReturnRefKind, typeParamMap, derivedIsAsync: false);

    private static ImmutableArray<ParameterSymbol> GetCallableParameters(FunctionSymbol method)
        => method.ExplicitReceiverParameter == null ? method.Parameters : method.Parameters.RemoveAt(0);

    private static bool TypeArgumentsEquivalent(ImmutableArray<TypeSymbol> a, ImmutableArray<TypeSymbol> b)
        => TypeArgumentsEquivalent(a, b, typeParamMap: null);
}
