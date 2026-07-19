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

    /// <summary>
    /// Issue #1812: signature for the
    /// <c>BindInterpolatedStringAsFormattable(syntax, targetType)</c> entry
    /// point, letting <see cref="ResolveClrBaseConstructor"/> re-lower a
    /// <c>: base($"...")</c> argument to <c>FormattableStringFactory.Create(...)</c>
    /// once overload resolution has selected an IFormattable/FormattableString
    /// parameter — mirroring what <c>RebindFormattableInterpolationArguments</c>
    /// does for every other CLR-call path in <c>ExpressionBinder</c>.
    /// </summary>
    /// <param name="syntax">The interpolated-string syntax.</param>
    /// <param name="targetType">The target type, or <see langword="null"/> for the FormattableString-factory form.</param>
    /// <returns>The bound (re-lowered) expression.</returns>
    internal delegate BoundExpression BindInterpolatedStringAsFormattableDelegate(InterpolatedStringExpressionSyntax syntax, TypeSymbol targetType);

    private readonly BinderContext binderCtx;
    private readonly ConversionClassifier conversions;
    private readonly BindExpressionDelegate bindExpression;
    private readonly Func<TypeClauseSyntax, TypeSymbol> bindTypeClause;
    private readonly BindReturnTypeClauseDelegate bindReturnTypeClause;
    private readonly BindTypeOfExpressionDelegate bindTypeOfExpression;
    private readonly BindArrayCreationExpressionDelegate bindArrayCreationExpression;
    private readonly BindInterpolatedStringAsFormattableDelegate bindInterpolatedStringAsFormattable;
    private readonly Func<SyntaxToken, Accessibility> resolveAccessibility;
    private readonly Func<string, TypeSymbol> lookupType;
    private readonly Func<TypeSymbol, Type> getEffectiveArgumentClrType;
    private readonly Func<TypeSymbol, bool> isAsyncIteratorReturnType;
    private readonly Func<TypeSymbol, bool> isAsyncSequenceReturnType;
    private readonly Func<string, bool> isPrimitiveTypeName;
    private readonly Func<RefKind, string> refKindToString;
    private readonly Func<FunctionSymbol> getCurrentFunction;
    private readonly Action<FunctionSymbol> setCurrentFunction;

    private readonly List<(StructDeclarationSyntax Syntax, StructSymbol Symbol)> pendingInterfaceImplementationChecks
        = new List<(StructDeclarationSyntax, StructSymbol)>();

    // Issue #987: classes whose abstract-member contract must be verified after
    // every type body is bound (a concrete class must override all inherited
    // abstract methods). Deferred because a base class' methods may not be bound
    // yet when a derived class declaration is processed.
    private readonly List<(StructDeclarationSyntax Syntax, StructSymbol Symbol)> pendingAbstractImplementationChecks
        = new List<(StructDeclarationSyntax, StructSymbol)>();

    // Issue #1085: base-constructor-initializer (`: base(...)`) argument binding
    // is deferred until every declared type's explicit constructors have been
    // populated. The argument expressions may construct OTHER user types (e.g.
    // `: base(H(1))`), and resolving such a constructor call requires the
    // referenced type's ExplicitConstructor(s) to already exist. Because type
    // bodies are bound one file at a time, a base-initializer in a file processed
    // before the constructed type's file would otherwise resolve against an
    // empty (not-yet-populated) constructor shell and wrongly report GS0144.
    // Method bodies already see fully-populated constructors because they are
    // bound in a later phase; deferring base-initializer argument binding to a
    // post-pass gives it the same guarantee, regardless of source-file order.
    private readonly List<Action> pendingBaseInitializerBindings = new List<Action>();

    // Issue #1194: field-initializer binding is deferred until after all
    // top-level functions are declared in Binder.BindGlobalScope, so a field
    // initializer can resolve an unqualified call to a free function or a
    // sibling static method/const. Each entry re-establishes the captured
    // scope and the enclosing type's static-member scope before binding.
    private readonly List<Action> pendingFieldInitializerBindings = new List<Action>();

    // Issue #1069: nested struct/class and interface type-name shells declared in
    // phase 1 (DeclareNestedTypeShells) so a sibling member signature can
    // forward-reference a nested type by name. The recorded shells are reused in
    // phase 2 (BindNestedTypeBodies) to bind the bodies without re-declaring the
    // type alias. Nested enums are fully bound during the shell phase (their
    // members reference no user types) and so are not tracked here.
    private readonly Dictionary<StructDeclarationSyntax, StructSymbol> nestedStructShells
        = new Dictionary<StructDeclarationSyntax, StructSymbol>();
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
        Func<FunctionSymbol> getCurrentFunction,
        Action<FunctionSymbol> setCurrentFunction,
        BindInterpolatedStringAsFormattableDelegate bindInterpolatedStringAsFormattable = null)
    {
        this.binderCtx = binderCtx ?? throw new ArgumentNullException(nameof(binderCtx));
        this.conversions = conversions ?? throw new ArgumentNullException(nameof(conversions));
        this.bindExpression = bindExpression ?? throw new ArgumentNullException(nameof(bindExpression));
        this.bindTypeClause = bindTypeClause ?? throw new ArgumentNullException(nameof(bindTypeClause));
        this.bindReturnTypeClause = bindReturnTypeClause ?? throw new ArgumentNullException(nameof(bindReturnTypeClause));
        this.bindTypeOfExpression = bindTypeOfExpression ?? throw new ArgumentNullException(nameof(bindTypeOfExpression));
        this.bindArrayCreationExpression = bindArrayCreationExpression ?? throw new ArgumentNullException(nameof(bindArrayCreationExpression));
        this.bindInterpolatedStringAsFormattable = bindInterpolatedStringAsFormattable;
        this.resolveAccessibility = resolveAccessibility ?? throw new ArgumentNullException(nameof(resolveAccessibility));
        this.lookupType = lookupType ?? throw new ArgumentNullException(nameof(lookupType));
        this.getEffectiveArgumentClrType = getEffectiveArgumentClrType ?? throw new ArgumentNullException(nameof(getEffectiveArgumentClrType));
        this.isAsyncIteratorReturnType = isAsyncIteratorReturnType ?? throw new ArgumentNullException(nameof(isAsyncIteratorReturnType));
        this.isAsyncSequenceReturnType = isAsyncSequenceReturnType ?? throw new ArgumentNullException(nameof(isAsyncSequenceReturnType));
        this.isPrimitiveTypeName = isPrimitiveTypeName ?? throw new ArgumentNullException(nameof(isPrimitiveTypeName));
        this.refKindToString = refKindToString ?? throw new ArgumentNullException(nameof(refKindToString));
        this.getCurrentFunction = getCurrentFunction ?? throw new ArgumentNullException(nameof(getCurrentFunction));
        this.setCurrentFunction = setCurrentFunction ?? throw new ArgumentNullException(nameof(setCurrentFunction));
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

    /// <summary>
    /// Binds a plain <c>type Name = Target</c> alias declaration.
    /// </summary>
    /// <param name="syntax">The alias declaration syntax.</param>
    /// <param name="package">
    /// Issue #2342 follow-up: the package that declares this alias, giving it
    /// a stable declaring-package identity for top-level duplicate detection
    /// (see <see cref="BoundScope.TryDeclareTypeAlias(string, TypeSymbol, string)"/>)
    /// independent of whatever package (if any) the aliased target itself
    /// belongs to.
    /// </param>
    internal void BindTypeAliasDeclaration(TypeAliasDeclarationSyntax syntax, PackageSymbol package)
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

        if (!scope.TryDeclareTypeAlias(name, aliasedType, package?.Name))
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
    internal DelegateTypeSymbol DeclareDelegateSymbol(DelegateDeclarationSyntax syntax, PackageSymbol package)
    {
        var name = syntax.Identifier.Text;

        // Reject shadowing of primitive type names — same rule as struct/enum.
        if (isPrimitiveTypeName(name))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
            return null;
        }

        var delegateSymbol = new DelegateTypeSymbol(
            name,
            package.Name,
            resolveAccessibility(syntax.AccessibilityModifier),
            ImmutableArray<ParameterSymbol>.Empty,
            TypeSymbol.Void,
            syntax);
        var typeParameters = CreateTypeParameterSymbols(syntax.TypeParameterList);
        if (!typeParameters.IsDefaultOrEmpty)
        {
            delegateSymbol.SetTypeParameters(typeParameters);
        }

        Binder.AttachDocumentation(delegateSymbol, syntax);
        if (!scope.TryDeclareTypeAlias(name, delegateSymbol))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
            return null;
        }

        return delegateSymbol;
    }

    internal void BindDelegateDeclarationBody(
        DelegateDeclarationSyntax syntax,
        DelegateTypeSymbol delegateSymbol)
    {
        var previousTypeParameters = binderCtx.CurrentTypeParameters;
        var typeParameters = delegateSymbol.TypeParameters;
        if (!typeParameters.IsDefaultOrEmpty)
        {
            binderCtx.CurrentTypeParameters = previousTypeParameters == null
                ? new Dictionary<string, TypeParameterSymbol>()
                : new Dictionary<string, TypeParameterSymbol>(previousTypeParameters);
            foreach (var tp in typeParameters)
            {
                binderCtx.CurrentTypeParameters[tp.Name] = tp;
            }
        }

        try
        {
            ResolveTypeParameterConstraints(syntax.TypeParameterList, typeParameters);
            BindDelegateDeclarationBodyCore(syntax, delegateSymbol);
        }
        finally
        {
            binderCtx.CurrentTypeParameters = previousTypeParameters;
        }
    }

    private void BindDelegateDeclarationBodyCore(
        DelegateDeclarationSyntax syntax,
        DelegateTypeSymbol delegateSymbol)
    {
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

            // Issue #1913: delegate parameters can carry `@Attr` annotations
            // same as any other parameter list.
            BindAndAttachParameterAttributes(parameterSyntax, delegateParam);
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

        delegateSymbol.SetSignature(parameters.ToImmutable(), returnType);
        delegateSymbol.SetAttributes(delegateAttributes);
    }

    internal EnumSymbol BindEnumDeclaration(EnumDeclarationSyntax syntax, PackageSymbol package, TypeSymbol containingType = null)
    {
        var name = syntax.Identifier.Text;

        if (isPrimitiveTypeName(name))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
            return null;
        }

        var accessibility = resolveAccessibility(syntax.AccessibilityModifier);
        var enumSymbol = new EnumSymbol(name, accessibility, package.Name, syntax);

        // Issue #1080: set the enclosing type BEFORE registering the name so the
        // scope can scope name-uniqueness to the enclosing type (a nested type
        // must not collide with a same-named package-level or differently-nested
        // type).
        if (containingType != null)
        {
            enumSymbol.SetContainingType(containingType);
        }

        Binder.AttachDocumentation(enumSymbol, syntax);
        enumSymbol.SetAttributes(BindAttributes(
            syntax.Annotations,
            AttributeTargetKind.Type,
            Binder.TypeDeclarationAllowedTargets,
            "an enum declaration",
            System.AttributeTargets.Enum));

        var seenMemberNames = new HashSet<string>();
        var declaredValues = new Dictionary<string, int>();
        var members = ImmutableArray.CreateBuilder<EnumMemberSymbol>();
        var nextValue = 0;
        foreach (var memberSyntax in syntax.Members)
        {
            var memberName = memberSyntax.Identifier.Text;
            if (!seenMemberNames.Add(memberName))
            {
                Diagnostics.ReportDuplicateEnumMember(memberSyntax.Identifier.Location, memberName, name);
                continue;
            }

            var memberValue = nextValue;
            if (memberSyntax.HasExplicitValue)
            {
                // Issue #1912: an explicit constant value (`Banana = 2`, `Unknown = -1`,
                // `ReadWrite = Read | Write`, or an alias `DefaultError = ServerError`)
                // overrides the auto-numbered default; later implicit members continue
                // counting up from it, matching C# §19.4.
                if (TryFoldEnumMemberValue(memberSyntax.Value, declaredValues, out var folded))
                {
                    memberValue = folded;
                }
                else
                {
                    Diagnostics.ReportEnumMemberValueNotConstant(memberSyntax.Value.Location, memberName, name);
                }
            }

            var memberSymbol = new EnumMemberSymbol(memberName, enumSymbol, memberValue);
            declaredValues[memberName] = memberValue;
            nextValue = memberValue + 1;
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

    /// <summary>
    /// Issue #1912: constant-folds an enum member's explicit value expression
    /// into an int32, without going through the general expression binder (an
    /// enum member value must be foldable at bind time, before the enum type
    /// itself is fully declared). Supports int literals, unary <c>+</c>/<c>-</c>/<c>^</c>
    /// (ones-complement), the binary operators <c>+ - | &amp; ^ &lt;&lt; &gt;&gt;</c>,
    /// parenthesized sub-expressions, and references to already-declared
    /// sibling members by bare name (the common C# alias idiom, e.g.
    /// <c>DefaultError = ServerError</c>).
    /// </summary>
    /// <param name="expression">The member's <c>= expr</c> value expression.</param>
    /// <param name="declaredValues">The already-bound sibling members, by name.</param>
    /// <param name="value">The folded int32 value, when folding succeeds.</param>
    /// <returns><see langword="true"/> if <paramref name="expression"/> folded to a constant int32.</returns>
    private static bool TryFoldEnumMemberValue(ExpressionSyntax expression, IReadOnlyDictionary<string, int> declaredValues, out int value)
    {
        switch (expression)
        {
            case ParenthesizedExpressionSyntax paren:
                return TryFoldEnumMemberValue(paren.Expression, declaredValues, out value);

            case LiteralExpressionSyntax literal:
                switch (literal.Value)
                {
                    case int i:
                        value = i;
                        return true;
                    case long l when l is >= int.MinValue and <= int.MaxValue:
                        value = (int)l;
                        return true;
                    default:
                        value = 0;
                        return false;
                }

            case NameExpressionSyntax name:
                return declaredValues.TryGetValue(name.IdentifierToken.Text, out value);

            case UnaryExpressionSyntax unary:
                // Issue #1912 follow-up: the lexer types a decimal literal one past
                // int.MaxValue (e.g. 2147483648) as uint per the integer-literal type
                // lattice, since it doesn't fit int. Negating that literal (int.MinValue,
                // 1 << 31, etc.) is a common real value (sign-bit flags), so special-case
                // a uint literal directly under unary minus and fold via long to avoid
                // overflow.
                if (unary.OperatorToken.Kind == SyntaxKind.MinusToken &&
                    unary.Operand is LiteralExpressionSyntax { Value: uint negatedLiteral } &&
                    negatedLiteral <= (uint)int.MaxValue + 1)
                {
                    value = unchecked((int)-(long)negatedLiteral);
                    return true;
                }

                if (!TryFoldEnumMemberValue(unary.Operand, declaredValues, out var operandValue))
                {
                    value = 0;
                    return false;
                }

                switch (unary.OperatorToken.Kind)
                {
                    case SyntaxKind.PlusToken:
                        value = operandValue;
                        return true;
                    case SyntaxKind.MinusToken:
                        value = -operandValue;
                        return true;
                    case SyntaxKind.HatToken:
                        value = ~operandValue;
                        return true;
                    default:
                        value = 0;
                        return false;
                }

            case BinaryExpressionSyntax binary:
                if (!TryFoldEnumMemberValue(binary.Left, declaredValues, out var leftValue) ||
                    !TryFoldEnumMemberValue(binary.Right, declaredValues, out var rightValue))
                {
                    value = 0;
                    return false;
                }

                switch (binary.OperatorToken.Kind)
                {
                    case SyntaxKind.PlusToken:
                        value = leftValue + rightValue;
                        return true;
                    case SyntaxKind.MinusToken:
                        value = leftValue - rightValue;
                        return true;
                    case SyntaxKind.PipeToken:
                        value = leftValue | rightValue;
                        return true;
                    case SyntaxKind.AmpersandToken:
                        value = leftValue & rightValue;
                        return true;
                    case SyntaxKind.HatToken:
                        value = leftValue ^ rightValue;
                        return true;
                    case SyntaxKind.AmpersandHatToken:
                        value = leftValue & ~rightValue;
                        return true;
                    case SyntaxKind.ShiftLeftToken:
                        value = leftValue << rightValue;
                        return true;
                    case SyntaxKind.ShiftRightToken:
                        value = leftValue >> rightValue;
                        return true;
                    case SyntaxKind.UnsignedShiftRightToken:
                        value = unchecked((int)((uint)leftValue >> rightValue));
                        return true;
                    default:
                        value = 0;
                        return false;
                }

            default:
                value = 0;
                return false;
        }
    }

    /// <summary>
    /// Issue #973: declares and fully binds a struct/class in a single pass
    /// (phase 1 + phase 2). Used for nested type declarations, which are bound
    /// recursively from within their container's body rather than through the
    /// top-level two-phase loop.
    /// </summary>
    internal StructSymbol BindStructDeclaration(StructDeclarationSyntax syntax, PackageSymbol package)
    {
        var structSymbol = DeclareStructShell(syntax, package);
        if (structSymbol == null)
        {
            return null;
        }

        BindStructDeclarationBody(syntax, package, structSymbol);
        return structSymbol;
    }

    /// <summary>
    /// Issue #973: detects transitive base-class inheritance cycles among the
    /// supplied class symbols and reports a diagnostic for each one. Before the
    /// two-phase declaration split (#973) a base clause could only resolve a
    /// type declared earlier in source, so a mutual cycle such as
    /// <c>class B : C</c> / <c>class C : B</c> was implicitly rejected because
    /// the forward reference failed to resolve. Now that all type-name shells
    /// are declared before any base clause is bound — which is exactly what
    /// makes legitimate forward references work — the cycle resolves cleanly
    /// and must be caught here, after every base class is installed via
    /// <see cref="StructSymbol.SetBaseClass"/>. Each <see cref="StructSymbol"/>
    /// has at most one user base class, so the base relation forms a functional
    /// graph; this walks every node's chain and, on finding a back-edge into the
    /// current path, reports the cycle and clears the offending base link so the
    /// later base-chain walks in <see cref="StructSymbol"/> and the emitter do
    /// not loop forever. Direct self-inheritance (<c>class A : A</c>) never
    /// reaches here because it is rejected — and its base left unset — in the
    /// base-clause loop.
    /// </summary>
    internal void DetectClassInheritanceCycles(IEnumerable<StructSymbol> classSymbols)
    {
        var acyclic = new HashSet<StructSymbol>();
        foreach (var start in classSymbols)
        {
            if (start.BaseClass == null || acyclic.Contains(start))
            {
                continue;
            }

            var path = new List<StructSymbol>();
            var onPath = new HashSet<StructSymbol>();
            var current = start;
            while (current != null)
            {
                if (onPath.Contains(current))
                {
                    var baseLocation = GetBaseClauseLocation(current);
                    Diagnostics.ReportClassInheritanceCycle(baseLocation, current.Name);

                    // Break the back-edge so subsequent base-chain walks (member
                    // lookup, the emitter, etc.) terminate. Binding already
                    // failed, so the program will not be emitted.
                    current.SetBaseClass(null);
                    break;
                }

                if (acyclic.Contains(current))
                {
                    break;
                }

                path.Add(current);
                onPath.Add(current);
                current = current.BaseClass;
            }

            foreach (var node in path)
            {
                acyclic.Add(node);
            }
        }
    }

    /// <summary>
    /// Issue #973: returns the text location of a class declaration's base-type
    /// clause (the first base/interface identifier), falling back to the type
    /// identifier when the base clause carries no usable location. Used to
    /// anchor inheritance-cycle diagnostics.
    /// </summary>
    private static TextLocation GetBaseClauseLocation(StructSymbol classSymbol)
    {
        var declaration = classSymbol.Declaration;
        if (declaration == null)
        {
            return default;
        }

        if (declaration.BaseTypeClauses.Count > 0)
        {
            var location = declaration.BaseTypeClauses[0].Identifier?.Location;
            if (location != null)
            {
                return location.Value;
            }
        }

        if (declaration.BaseTypeIdentifier != null)
        {
            return declaration.BaseTypeIdentifier.Location;
        }

        return declaration.Identifier.Location;
    }

    /// <summary>
    /// Issue #973 (phase 1): declares the struct/class type-name shell and
    /// registers it in scope BEFORE any member body is bound, so that field,
    /// parameter, and base-clause types may forward-reference a user type
    /// declared later in the same compilation (e.g. a <c>class</c> whose field
    /// type is a <c>struct</c> declared further down). The returned shell has
    /// empty <see cref="StructSymbol.Fields"/> and
    /// <see cref="StructSymbol.PrimaryConstructorParameters"/>; those — along
    /// with the base clause and all members — are bound and installed later by
    /// <see cref="BindStructDeclarationBody"/>.
    /// </summary>
    internal StructSymbol DeclareStructShell(StructDeclarationSyntax syntax, PackageSymbol package, TypeSymbol containingType = null)
    {
        var name = syntax.Identifier.Text;

        if (isPrimitiveTypeName(name))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
            return null;
        }

        var accessibility = resolveAccessibility(syntax.AccessibilityModifier);

        // Issue #2519: publish the aggregate shell with bare type parameters,
        // but defer constraint resolution to BindStructDeclarationBody. The
        // global declaration pass creates every same-compilation type shell
        // before any body is bound, so a constraint may name a class declared
        // in a later file without depending on compile-item order. Resolving in
        // the body phase still preserves CRTP constraints because this shell is
        // already registered before its own constraints are resolved.
        var typeParameters = CreateTypeParameterSymbols(syntax.TypeParameterList);
        return CreateAndRegisterStructShell(
            syntax,
            package,
            accessibility,
            name,
            typeParameters,
            containingType);
    }

    /// <summary>
    /// Issue #1056: constructs a struct/class type-name shell with the supplied
    /// type parameters and registers it in scope. Factored out of
    /// <see cref="DeclareStructShell"/> so the registration can run between
    /// type-parameter creation and constraint resolution (enabling a
    /// self-referential base-class constraint to resolve the declaring type).
    /// </summary>
    private StructSymbol CreateAndRegisterStructShell(
        StructDeclarationSyntax syntax,
        PackageSymbol package,
        Accessibility accessibility,
        string name,
        ImmutableArray<TypeParameterSymbol> typeParameters,
        TypeSymbol containingType = null)
    {
        // Issue #949 / #973: construct the struct symbol shell now and register
        // it in scope so that (a) the type may reference itself as a generic
        // type argument in its own base/interface clause, and (b) any other
        // user type may reference it by name regardless of declaration order.
        // Instance fields and primary-constructor parameters are bound and
        // installed later by BindStructDeclarationBody.
        var structSymbol = new StructSymbol(
            name,
            ImmutableArray<FieldSymbol>.Empty,
            accessibility,
            syntax,
            package.Name,
            syntax.IsData,
            syntax.IsInline,
            syntax.IsClass,
            ImmutableArray<ParameterSymbol>.Empty,
            isOpen: syntax.IsOpen && syntax.IsClass,
            baseClass: null);
        Binder.AttachDocumentation(structSymbol, syntax);

        if (!typeParameters.IsDefaultOrEmpty)
        {
            structSymbol.SetTypeParameters(typeParameters);
        }

        // Issue #1080: set the enclosing type BEFORE registering the name so the
        // scope can scope name-uniqueness to the enclosing type.
        if (containingType != null)
        {
            structSymbol.SetContainingType(containingType);
        }

        if (!scope.TryDeclareTypeAlias(name, structSymbol))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
        }

        return structSymbol;
    }
}
