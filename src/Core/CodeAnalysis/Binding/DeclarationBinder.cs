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

        // Phase 4.3 / ADR-0020: bind the optional type-parameter list FIRST so
        // field/parameter types in the body can reference T, U, etc.
        // Issue #1056: construct and register the struct/class shell BETWEEN
        // creating the bare type parameters and resolving their constraints, so a
        // self-referential base-class constraint (CRTP `class Box[T Box[T]]` /
        // `class Box[T Box]`) can resolve the type's own name and arity.
        var previousTypeParameters = binderCtx.CurrentTypeParameters;
        StructSymbol structSymbol = null;
        ImmutableArray<TypeParameterSymbol> typeParameters = ImmutableArray<TypeParameterSymbol>.Empty;
        try
        {
            if (syntax.TypeParameterList != null)
            {
                binderCtx.CurrentTypeParameters = new Dictionary<string, TypeParameterSymbol>();
                typeParameters = BindTypeParameterList(
                    syntax.TypeParameterList,
                    bareSymbols =>
                    {
                        structSymbol = CreateAndRegisterStructShell(syntax, package, accessibility, name, bareSymbols, containingType);
                    });
            }
        }
        finally
        {
            binderCtx.CurrentTypeParameters = previousTypeParameters;
        }

        // Non-generic types (or the defensive fallback when the callback did not
        // run) construct and register the shell here.
        structSymbol ??= CreateAndRegisterStructShell(syntax, package, accessibility, name, typeParameters, containingType);

        return structSymbol;
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

    /// <summary>
    /// Issue #973 (phase 2): binds the body of a previously declared struct/class
    /// shell — its instance fields, primary-constructor parameters, base clause,
    /// and all members — and installs them on <paramref name="structSymbol"/>.
    /// Re-establishes the type-parameter scope captured at declaration time so
    /// member types can reference the type's own type parameters.
    /// </summary>
    internal void BindStructDeclarationBody(StructDeclarationSyntax syntax, PackageSymbol package, StructSymbol structSymbol)
    {
        var previousTypeParameters = binderCtx.CurrentTypeParameters;
        try
        {
            if (!structSymbol.TypeParameters.IsDefaultOrEmpty)
            {
                binderCtx.CurrentTypeParameters = new Dictionary<string, TypeParameterSymbol>();
                foreach (var tp in structSymbol.TypeParameters)
                {
                    binderCtx.CurrentTypeParameters[tp.Name] = tp;
                }
            }

            BindStructDeclarationBodyCore(syntax, package, structSymbol);
        }
        finally
        {
            binderCtx.CurrentTypeParameters = previousTypeParameters;
        }
    }

    /// <summary>
    /// Issue #950: reports GS0380 for any member declared <c>protected</c> when
    /// the enclosing type is not an inheritable <c>open class</c>. Structs
    /// (value types) and non-open/sealed classes cannot be derived from, so a
    /// <c>protected</c> member there has no meaning.
    /// </summary>
    private void ValidateProtectedMemberPlacement(StructDeclarationSyntax syntax)
    {
        if (syntax.IsClass && syntax.IsOpen)
        {
            return;
        }

        foreach (var field in syntax.Fields)
        {
            ReportProtectedToken(field.AccessibilityModifier);
        }

        foreach (var method in syntax.Methods)
        {
            ReportProtectedToken(method.AccessibilityModifier);
        }

        foreach (var prop in syntax.Properties)
        {
            ReportProtectedToken(prop.AccessibilityModifier);
        }

        foreach (var evt in syntax.Events)
        {
            ReportProtectedToken(evt.AccessibilityModifier);
        }

        if (!syntax.Constructors.IsDefaultOrEmpty)
        {
            foreach (var ctor in syntax.Constructors)
            {
                ReportProtectedToken(ctor.AccessibilityModifier);
            }
        }

        if (syntax.SharedBlock != null)
        {
            foreach (var field in syntax.SharedBlock.Fields)
            {
                ReportProtectedToken(field.AccessibilityModifier);
            }

            foreach (var method in syntax.SharedBlock.Methods)
            {
                ReportProtectedToken(method.AccessibilityModifier);
            }

            foreach (var prop in syntax.SharedBlock.Properties)
            {
                ReportProtectedToken(prop.AccessibilityModifier);
            }

            foreach (var evt in syntax.SharedBlock.Events)
            {
                ReportProtectedToken(evt.AccessibilityModifier);
            }
        }
    }

    /// <summary>
    /// Issue #950: reports GS0380 when <paramref name="modifier"/> is the
    /// <c>protected</c> keyword. Used by callers that have already determined
    /// the surrounding context does not permit <c>protected</c>.
    /// </summary>
    private void ReportProtectedToken(SyntaxToken modifier)
    {
        if (modifier != null && modifier.Kind == SyntaxKind.ProtectedKeyword)
        {
            Diagnostics.ReportProtectedRequiresOpenType(modifier.Location);
        }
    }

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

    private void BindStructDeclarationBodyCore(
        StructDeclarationSyntax syntax,
        PackageSymbol package,
        StructSymbol structSymbol)
    {
        // ADR-0122 / issue #1014: an `unsafe class` / `unsafe struct` binds all
        // of its members (field types, method signatures, …) within an unsafe
        // context, so they may use unmanaged raw pointers (`*T`).
        using var unsafeContext = binderCtx.PushUnsafeContext(syntax.IsUnsafe);

        var name = structSymbol.Name;
        var accessibility = structSymbol.Accessibility;
        var seenFieldNames = new HashSet<string>();
        var fields = ImmutableArray.CreateBuilder<FieldSymbol>();

        // Issue #950: `protected` is only meaningful on members of an
        // inheritable `open class`. Reject it on members of a non-open class,
        // a struct (value types are not inheritable), or a sealed type before
        // binding the members so the user sees one clean GS0380 diagnostic.
        ValidateProtectedMemberPlacement(syntax);

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

        // Issue #948: const fields declared in the type body are implicitly
        // static literal fields. They are diverted out of the instance field
        // list and bound (folded to a constant) after the struct symbol exists.
        var constFieldsBuilder = ImmutableArray.CreateBuilder<FieldSymbol>();
        var pendingConstInitializers = new List<(FieldSymbol Field, FieldDeclarationSyntax Syntax, TypeSymbol FieldType)>();

        // Issue #1070: `shared`-block static field initializers and `shared`/const
        // initializers are also deferred so that ALL of them are bound in a single
        // pass once every static member symbol (static field, const, static
        // property) of the enclosing type exists. Binding them in a scope that
        // exposes those static members makes a field initializer able to reference
        // a sibling `const` or `shared` field regardless of declaration order,
        // matching the static-member visibility a method/constructor body already has.
        var pendingStaticFieldInitializers = new List<(FieldSymbol Field, ExpressionSyntax InitSyntax, TypeSymbol FieldType)>();
        var pendingSharedConstInitializers = new List<(FieldSymbol Field, FieldDeclarationSyntax Syntax, TypeSymbol FieldType)>();

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

            // ADR-0122 §10 / issue #1035: a fixed-size buffer field
            // `fixed name [N]T` lays out N inline elements and decays to a
            // `*T` to the first element. It is only legal inside an unsafe
            // context, its element type must be a blittable primitive, and N
            // must be a positive constant (captured by the `[N]T` array type).
            if (fieldSyntax.IsFixedBuffer)
            {
                if (!binderCtx.InUnsafeContext)
                {
                    Diagnostics.ReportFixedBufferRequiresUnsafeContext(fieldSyntax.FixedKeyword.Location);
                    continue;
                }

                if (fieldType is not ArrayTypeSymbol fbArray)
                {
                    Diagnostics.ReportFixedBufferInvalidShape(fieldSyntax.Identifier.Location, fieldName);
                    continue;
                }

                var fbElement = fbArray.ElementType;
                var fbLength = fbArray.Length;
                if (fbLength <= 0)
                {
                    Diagnostics.ReportFixedBufferInvalidLength(fieldSyntax.Identifier.Location, fieldName, fbLength);
                    continue;
                }

                if (!TryGetFixedBufferElementSize(fbElement, out var fbElemSize))
                {
                    Diagnostics.ReportFixedBufferElementTypeNotSupported(fieldSyntax.Identifier.Location, fbElement.Name);
                    continue;
                }

                var fbBacking = SynthesizeFixedBufferBackingStruct(structSymbol, fieldName, fbElement, fbLength, fbElemSize, package);
                var fbFieldSymbol = new FieldSymbol(fieldName, fbBacking, fieldAccessibility, isReadOnly: false);
                fbFieldSymbol.SetFixedBuffer(fbElement, fbLength);
                Binder.AttachDocumentation(fbFieldSymbol, fieldSyntax);
                fields.Add(fbFieldSymbol);
                continue;
            }

            // Issue #948: a `const` field is a compile-time constant — it is
            // implicitly static and read-only and emitted as a literal field.
            if (fieldSyntax.IsConst)
            {
                var constFieldSymbol = new FieldSymbol(fieldName, fieldType, fieldAccessibility, isReadOnly: true, isStatic: true, isConst: true);
                Binder.AttachDocumentation(constFieldSymbol, fieldSyntax);

                if (!fieldSyntax.Annotations.IsDefaultOrEmpty)
                {
                    constFieldSymbol.SetAttributes(BindAttributes(
                        fieldSyntax.Annotations,
                        AttributeTargetKind.Field,
                        Binder.FieldDeclarationAllowedTargets,
                        "a field declaration",
                        System.AttributeTargets.Field));
                }

                if (fieldSyntax.Initializer == null)
                {
                    Diagnostics.ReportConstFieldRequiresInitializer(fieldSyntax.Identifier.Location, fieldName);
                }
                else
                {
                    pendingConstInitializers.Add((constFieldSymbol, fieldSyntax, fieldType));
                }

                constFieldsBuilder.Add(constFieldSymbol);
                continue;
            }

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

        // Issue #949 / #973: the struct symbol shell was constructed and
        // registered in scope by DeclareStructShell (phase 1) so it could be
        // referenced as a self type argument in its own base/interface clause
        // and forward-referenced by other user types. Now that the instance
        // fields and primary-constructor parameters have been bound, install
        // them on the shell. The resolved base class — if any — is installed
        // afterwards via SetBaseClass. Genuine self-inheritance (`class A : A`)
        // is rejected explicitly in the base-clause loop below.
        structSymbol.SetInstanceFieldsAndPrimaryConstructorParameters(
            fields.ToImmutable(),
            primaryCtorParameters);

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
            // Issue #976: the `: …` clause is bound for both classes and
            // structs. A class may name a single base class plus interfaces; a
            // struct (CLR value type) may name interfaces only — a base class
            // or base struct is rejected below with GS0382.
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

                    // Issue #976: a struct (value type) may only list
                    // interfaces. Reject any resolved type that is not an
                    // interface (a user/CLR class or another struct) with a
                    // dedicated diagnostic instead of silently dropping it.
                    if (!syntax.IsClass)
                    {
                        var resolvedIsInterface = resolved is InterfaceSymbol
                            || (resolved.ClrType != null && resolved.ClrType.IsInterface);
                        if (!resolvedIsInterface)
                        {
                            Diagnostics.ReportStructCannotHaveBaseClass(baseLocation, name, baseName);
                            continue;
                        }
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
                        // Issue #949: reject genuine self-inheritance
                        // (`class A : A`, or the generic `class A[T] : A[T]`)
                        // where the type names itself as its OWN base class.
                        // This is distinct from — and must not be confused
                        // with — naming the enclosing type as a generic type
                        // ARGUMENT of a base/interface (`class A : Base[A]`,
                        // `class A : IEquatable[A]`), which is legal and is
                        // handled by the branches above / below.
                        if (baseStruct == structSymbol || baseStruct.Definition == structSymbol)
                        {
                            Diagnostics.ReportClassInheritsFromItself(baseLocation, name);
                            continue;
                        }

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

        // Issue #949: install the resolved base class now that the base-type
        // clause has been bound (the symbol itself was created earlier so it
        // could be referenced as a self type argument in that clause).
        structSymbol.SetBaseClass(baseClassSymbol);

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

        // Issue #640 / issue #1070: the deferred instance-field initializer
        // expressions, const-field foldings, and `shared`-block initializers are
        // all bound later in a single consolidated pass (see "Issue #1070:
        // consolidated field-initializer binding" below), once every static
        // member symbol of the enclosing type has been created. That ordering is
        // what lets an initializer reference a sibling `const`/`shared` field
        // regardless of declaration order. Here we only install the const-field
        // SYMBOLS so downstream member signatures can reference them by name.
        if (constFieldsBuilder.Count > 0)
        {
            structSymbol.SetConstFields(constFieldsBuilder.ToImmutable());
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
                    // ADR-0122 / issue #1036: an `unsafe func` method binds its
                    // SIGNATURE (parameter + return types) in an unsafe context
                    // too — not just its body — so a single unsafe method in an
                    // otherwise-safe type may take/return unmanaged raw pointers
                    // (`*T` → CLR ELEMENT_TYPE_PTR). When the method is not
                    // `unsafe` (and the enclosing type is safe) this is a no-op.
                    using var sigUnsafeContext = binderCtx.PushUnsafeContext(methodSyntax.IsUnsafe);

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

                    // Issue #1071: the effective async flag (mirrors
                    // FunctionSymbol.IsAsync below) so override / shadow matching
                    // compares the async-normalized effective return type.
                    var methodIsAsync = methodSyntax.IsAsync || isAsyncIteratorReturnType(returnType);

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
                        var baseTypeArgSubst = BuildBaseTypeArgumentSubstitution(structSymbol);
                        FunctionSymbol baseMethod = null;
                        FunctionSymbol baseSignatureMatch = null;
                        foreach (var candidate in baseOverloads)
                        {
                            baseMethod ??= candidate;
                            if (SignaturesMatch(candidate, methodParameters, returnType, methodReturnRefKind, baseTypeArgSubst, methodIsAsync))
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
                        var baseTypeArgSubst = BuildBaseTypeArgumentSubstitution(structSymbol);
                        foreach (var shadowed in baseOverloads)
                        {
                            if (!shadowed.IsOpen)
                            {
                                continue;
                            }

                            if (SignaturesMatch(shadowed, methodParameters, returnType, methodReturnRefKind, baseTypeArgSubst, methodIsAsync))
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
                    methodSymbol.IsUnsafe = methodSyntax.IsUnsafe || syntax.IsUnsafe;

                    // Issue #987: a no-body `open func F() R;` inside a class is
                    // the canonical G# spelling of a C# abstract method. Mark the
                    // method abstract so the body binder skips it (there is no
                    // body to bind) and the emitter writes an abstract virtual
                    // slot rather than crashing on a null body. The bodyless form
                    // is only valid as an `open` member of an `open` class — any
                    // other shape (a non-`open` bodyless method, or one inside a
                    // non-`open` class) is reported with GS0388.
                    if (methodSyntax.HasSemicolonBody)
                    {
                        methodSymbol.IsAbstract = true;
                        if (!methodSyntax.IsOpen || !structSymbol.IsOpen)
                        {
                            Diagnostics.ReportAbstractMethodRequiresOpenClass(
                                methodSyntax.Identifier.Location,
                                methodName,
                                structSymbol.Name);
                        }
                    }

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
                            // Issue #985: permit two same-name/same-parameter
                            // methods that differ only by return type when they
                            // satisfy two DIFFERENT CLR interface slots (a
                            // covariant-return interface bridge, e.g. the
                            // generic `GetEnumerator() IEnumerator[T]` plus the
                            // non-generic `GetEnumerator() IEnumerator` for
                            // `IEnumerable[T]`). The bridge method is bound to
                            // its inherited slot via an explicit MethodImpl row
                            // at emit time.
                            if (MemberLookup.TryResolveCovariantInterfaceBridge(
                                    implementedClrInterfaces.ToImmutable(),
                                    existingMethod,
                                    methodSymbol,
                                    out var bridgeMethod,
                                    out var bridgeSlot))
                            {
                                bridgeMethod.ExplicitInterfaceSlot = bridgeSlot;
                                continue;
                            }

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
                // ADR-0118 / issue #944: an indexer member (`prop this[…] T`)
                // is modelled as a property whose CLR name is `Item` carrying
                // an index-parameter list.
                var isIndexer = propSyntax.IsIndexer;
                var indexerParameters = ImmutableArray<ParameterSymbol>.Empty;
                if (isIndexer)
                {
                    if (propSyntax.Parameters.Count == 0)
                    {
                        Diagnostics.ReportIndexerRequiresParameter(propSyntax.ThisKeyword.Location);
                        continue;
                    }

                    var indexerParamBuilder = ImmutableArray.CreateBuilder<ParameterSymbol>();
                    var seenIndexParamNames = new HashSet<string>();
                    foreach (var indexParamSyntax in propSyntax.Parameters)
                    {
                        var indexParamName = indexParamSyntax.Identifier.Text;
                        var indexParamType = bindTypeClause(indexParamSyntax.Type) ?? TypeSymbol.Error;
                        if (!seenIndexParamNames.Add(indexParamName))
                        {
                            Diagnostics.ReportParameterAlreadyDeclared(indexParamSyntax.Location, indexParamName);
                        }

                        indexerParamBuilder.Add(new ParameterSymbol(indexParamName, indexParamType, declaringSyntax: indexParamSyntax.Identifier));
                    }

                    indexerParameters = indexerParamBuilder.ToImmutable();
                }

                var propName = isIndexer ? "Item" : propSyntax.Identifier.Text;

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
                bool isInitOnly = false;
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
                    var initAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsInit);

                    // Issue #946: a property may declare a `set` or an `init`
                    // accessor, but not both (mirrors C#).
                    if (setAccessor != null && initAccessor != null)
                    {
                        Diagnostics.ReportPropertyHasBothSetAndInit(initAccessor.AccessorKeyword.Location, propName);
                    }

                    var writeAccessor = setAccessor ?? initAccessor;
                    hasGetter = getAccessor != null || propSyntax.Accessors.IsDefaultOrEmpty;
                    hasSetter = writeAccessor != null;
                    isInitOnly = setAccessor == null && initAccessor != null;

                    if (writeAccessor != null && writeAccessor.ParameterIdentifier != null)
                    {
                        setterParamName = writeAccessor.ParameterIdentifier.Text;
                    }

                    // Auto-property if accessors have no bodies
                    isAutoProperty = (getAccessor == null || getAccessor.Body == null)
                                  && (writeAccessor == null || writeAccessor.Body == null)
                                  && propSyntax.Accessors.All(a => a.Body == null);
                }

                // ADR-0118 / issue #944: there is no auto-indexer form — an
                // indexer must declare a get and/or set accessor with a body.
                if (isIndexer && isAutoProperty)
                {
                    Diagnostics.ReportIndexerRequiresAccessorBody(propSyntax.ThisKeyword.Location);
                    continue;
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
                    declaration: propSyntax,
                    isInitOnly: isInitOnly)
                {
                    IsIndexer = isIndexer,
                    Parameters = indexerParameters,
                };
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

                    // Issue #946: the write accessor is either `set` or `init`.
                    var setAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsSetterOrInit);

                    if (hasGetter && getAccessor?.Body != null)
                    {
                        var getterSymbol = new FunctionSymbol(
                            $"get_{propName}",
                            isIndexer ? indexerParameters : ImmutableArray<ParameterSymbol>.Empty,
                            propType,
                            declaration: null,
                            package,
                            propAccessibility,
                            receiverType: structSymbol,
                            isOpen: isVirtual,
                            isOverride: isOverride);

                        // ADR-0118: indexer accessors are emitted as SpecialName
                        // CLR default-member accessors (get_Item).
                        getterSymbol.IsSpecialName = isIndexer;
                        propertySymbol.GetterSymbol = getterSymbol;
                        propertySymbol.GetterBodySyntax = getAccessor.Body;
                    }

                    if (hasSetter && setAccessor?.Body != null)
                    {
                        var setterParam = new ParameterSymbol(setterParamName, propType);
                        var setterParameters = isIndexer
                            ? indexerParameters.Add(setterParam)
                            : ImmutableArray.Create(setterParam);
                        var setterSymbol = new FunctionSymbol(
                            $"set_{propName}",
                            setterParameters,
                            TypeSymbol.Void,
                            declaration: null,
                            package,
                            propAccessibility,
                            receiverType: structSymbol,
                            isOpen: isVirtual,
                            isOverride: isOverride);
                        setterSymbol.IsSpecialName = isIndexer;
                        setterSymbol.IsInitOnlySetter = isInitOnly;
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
            var sharedConstFieldsBuilder = ImmutableArray.CreateBuilder<FieldSymbol>();
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

                // Issue #948: a `const` declared inside a `shared` block is also
                // a compile-time constant literal field (const is implicitly
                // static, so `shared` is redundant but accepted).
                if (fieldSyntax.IsConst)
                {
                    var sharedConstField = new FieldSymbol(fieldName, fieldType, fieldAccessibility, isReadOnly: true, isStatic: true, isConst: true);
                    Binder.AttachDocumentation(sharedConstField, fieldSyntax);

                    if (!fieldSyntax.Annotations.IsDefaultOrEmpty)
                    {
                        sharedConstField.SetAttributes(BindAttributes(
                            fieldSyntax.Annotations,
                            AttributeTargetKind.Field,
                            Binder.FieldDeclarationAllowedTargets,
                            "a field declaration",
                            System.AttributeTargets.Field));
                    }

                    if (fieldSyntax.Initializer == null)
                    {
                        Diagnostics.ReportConstFieldRequiresInitializer(fieldSyntax.Identifier.Location, fieldName);
                    }
                    else
                    {
                        // Issue #1070: defer folding to the consolidated pass so a
                        // shared const can reference a sibling static/const member
                        // regardless of declaration order.
                        pendingSharedConstInitializers.Add((sharedConstField, fieldSyntax, fieldType));
                    }

                    sharedConstFieldsBuilder.Add(sharedConstField);
                    continue;
                }

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

                // Issue #262 / issue #1070: defer initializer binding to the
                // consolidated pass so it can see all sibling static/const members.
                if (fieldSyntax.Initializer != null)
                {
                    pendingStaticFieldInitializers.Add((fieldSymbol, fieldSyntax.Initializer, fieldType));
                }

                staticFieldsBuilder.Add(fieldSymbol);
            }

            structSymbol.SetStaticFields(staticFieldsBuilder.ToImmutable());

            // Issue #948: merge any const fields declared inside the shared block
            // with the body-level const fields already installed on the symbol.
            if (sharedConstFieldsBuilder.Count > 0)
            {
                structSymbol.SetConstFields(structSymbol.ConstFields.AddRange(sharedConstFieldsBuilder.ToImmutable()));
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
                    // ADR-0122 / issue #1036: bind an `unsafe func` static/shared
                    // method's signature (params + return) in an unsafe context
                    // too, so it may use unmanaged raw pointers even when the
                    // enclosing type is safe. No-op for a non-`unsafe` method.
                    using var sigUnsafeContext = binderCtx.PushUnsafeContext(methodSyntax.IsUnsafe);

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
                    methodSymbol.IsUnsafe = methodSyntax.IsUnsafe || syntax.IsUnsafe;

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
                // ADR-0118 / issue #944: a `shared` (static) indexer has no CLR
                // representation — report a clean diagnostic rather than crashing.
                if (propSyntax.IsIndexer)
                {
                    Diagnostics.ReportIndexerRequiresAccessorBody(propSyntax.ThisKeyword.Location);
                    continue;
                }

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
                    var initAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsInit);

                    // Issue #946: `init` is instance-only; reject it on a static
                    // property declared inside a `shared` block (ADR-0053).
                    if (initAccessor != null)
                    {
                        Diagnostics.ReportInitAccessorOnStaticProperty(initAccessor.AccessorKeyword.Location, propName);
                    }

                    hasGetter = getAccessor != null || propSyntax.Accessors.IsDefaultOrEmpty;
                    hasSetter = setAccessor != null || initAccessor != null;

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

        // Issue #1070: consolidated field-initializer binding. Every static member
        // symbol of the enclosing type (class const fields, `shared` static fields,
        // `shared` const fields, and static properties) now exists on the struct
        // symbol, so bind ALL deferred initializers in a single scope that exposes
        // those static members by bare name — exactly the visibility a
        // method/constructor body already enjoys (see Binder.BindProgram). This
        // makes a `const`/`shared` field referenced from a field initializer resolve
        // regardless of declaration order, and clears the GS0125 / cascading GS0159
        // diagnostics that previously fired because the static member was not in
        // scope. Instance members remain out of scope (a field initializer has no
        // `this`), so genuine instance-member references are still rejected below.
        using (PushStaticMemberScope(structSymbol))
        {
            // Fold class const initializers first so a `shared` const that
            // references a class const can read its already-folded value.
            foreach (var (constField, fieldSyntaxNode, fieldType) in pendingConstInitializers)
            {
                BindAndFoldConstFieldInitializer(constField, fieldSyntaxNode, fieldType);
            }

            foreach (var (constField, fieldSyntaxNode, fieldType) in pendingSharedConstInitializers)
            {
                BindAndFoldConstFieldInitializer(constField, fieldSyntaxNode, fieldType);
            }

            // Bind `shared` static field initializers.
            if (pendingStaticFieldInitializers.Count > 0)
            {
                var staticInitBuilder = ImmutableDictionary.CreateBuilder<FieldSymbol, BoundExpression>();
                foreach (var (fieldSym, initSyntax, fieldType) in pendingStaticFieldInitializers)
                {
                    var boundInit = bindExpression(initSyntax);
                    var convertedInit = conversions.BindConversion(initSyntax.Location, boundInit, fieldType);
                    staticInitBuilder[fieldSym] = convertedInit;
                }

                structSymbol.SetStaticFieldInitializers(staticInitBuilder.ToImmutable());
            }

            // Bind instance field initializers. These run before the constructor
            // body, so they cannot reference `this`, other instance members, or
            // constructor parameters (matching C#); a genuine instance-member
            // reference is reported precisely rather than as a bare GS0125.
            if (pendingInstanceInitializers.Count > 0)
            {
                var instanceMemberNames = new HashSet<string>(System.StringComparer.Ordinal) { "this" };
                foreach (var f in fields)
                {
                    instanceMemberNames.Add(f.Name);
                }

                foreach (var p in primaryCtorParameters)
                {
                    instanceMemberNames.Add(p.Name);
                }

                var instanceInitBuilder = ImmutableDictionary.CreateBuilder<FieldSymbol, BoundExpression>();
                foreach (var (fieldSym, initSyntax, fieldType) in pendingInstanceInitializers)
                {
                    if (TryFindInstanceMemberReference(initSyntax, instanceMemberNames, out var offendingName, out var offendingLocation))
                    {
                        Diagnostics.ReportFieldInitializerCannotReferenceInstanceMember(offendingLocation, offendingName);
                        continue;
                    }

                    var boundInit = bindExpression(initSyntax);
                    var convertedInit = conversions.BindConversion(initSyntax.Location, boundInit, fieldType);
                    instanceInitBuilder[fieldSym] = convertedInit;
                }

                structSymbol.SetInstanceFieldInitializers(instanceInitBuilder.ToImmutable());
            }
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

        // Issue #910 / ADR-0110 / issue #1069: bind the BODIES of the nested type
        // declarations declared inside this aggregate's body. Their type-name
        // shells were declared earlier (DeclareNestedTypeShells) so sibling
        // member signatures could forward-reference them; here we fill in their
        // members. The emitter materialises real CLR nested types.
        BindNestedTypeBodies(syntax, package);

        // Issue #987: queue the abstract-member contract check for classes. A
        // concrete (non-`open`) class with a base must override every inherited
        // abstract method; deferred so base-class methods are bound first.
        if (syntax.IsClass)
        {
            pendingAbstractImplementationChecks.Add((syntax, structSymbol));
        }
    }

    /// <summary>
    /// Issue #1070: binds and folds a deferred <c>const</c>-field initializer to a
    /// compile-time constant, reporting GS-not-constant if the expression is not a
    /// constant. Shared by the class-body and <c>shared</c>-block const paths.
    /// </summary>
    /// <summary>
    /// ADR-0122 §10 / issue #1035: returns the unmanaged byte size of a fixed-size
    /// buffer element type. Only the C#-compatible blittable primitives are
    /// permitted (bool, the integer types, char, and the floating-point types).
    /// </summary>
    /// <param name="elementType">The buffer element type.</param>
    /// <param name="size">The element size in bytes when supported.</param>
    /// <returns><see langword="true"/> when the element type is a supported fixed-buffer element.</returns>
    private static bool TryGetFixedBufferElementSize(TypeSymbol elementType, out int size)
    {
        size = 0;
        if (elementType == TypeSymbol.Bool || elementType == TypeSymbol.Int8 || elementType == TypeSymbol.UInt8)
        {
            size = 1;
        }
        else if (elementType == TypeSymbol.Int16 || elementType == TypeSymbol.UInt16 || elementType == TypeSymbol.Char)
        {
            size = 2;
        }
        else if (elementType == TypeSymbol.Int32 || elementType == TypeSymbol.UInt32 || elementType == TypeSymbol.Float32)
        {
            size = 4;
        }
        else if (elementType == TypeSymbol.Int64 || elementType == TypeSymbol.UInt64 || elementType == TypeSymbol.Float64)
        {
            size = 8;
        }

        return size != 0;
    }

    /// <summary>
    /// ADR-0122 §10 / issue #1035: synthesizes the compiler-generated nested
    /// backing struct for a fixed-size buffer field. The struct carries a
    /// single element field <c>FixedElementField</c> of type <c>T</c> and an
    /// explicit sequential <c>ClassLayout</c> size of <c>N * sizeof(T)</c>,
    /// mirroring how C# / Roslyn lowers a <c>fixed T name[N]</c> buffer. The
    /// struct is registered in the root scope so it flows through the normal
    /// nested-type emission pipeline.
    /// </summary>
    /// <param name="containingType">The struct that declares the fixed buffer.</param>
    /// <param name="fieldName">The fixed-buffer field name.</param>
    /// <param name="elementType">The buffer element type <c>T</c>.</param>
    /// <param name="length">The element count <c>N</c>.</param>
    /// <param name="elementSize">The element size in bytes.</param>
    /// <param name="package">The owning package.</param>
    /// <returns>The synthesized backing <see cref="StructSymbol"/>.</returns>
    private StructSymbol SynthesizeFixedBufferBackingStruct(
        StructSymbol containingType,
        string fieldName,
        TypeSymbol elementType,
        int length,
        int elementSize,
        PackageSymbol package)
    {
        var bufferName = $"<{fieldName}>e__FixedBuffer";
        var elementField = new FieldSymbol("FixedElementField", elementType, Accessibility.Public, isReadOnly: false);
        var backing = new StructSymbol(
            bufferName,
            ImmutableArray.Create(elementField),
            Accessibility.Public,
            declaration: null,
            packageName: package?.Name ?? string.Empty,
            isData: false,
            isInline: false,
            isClass: false,
            primaryConstructorParameters: ImmutableArray<ParameterSymbol>.Empty);
        backing.SetContainingType(containingType);
        backing.MarkFixedBufferBacking(elementType);
        backing.SetLayoutMetadata(new StructLayoutMetadata(
            System.Runtime.InteropServices.LayoutKind.Sequential,
            pack: null,
            size: length * elementSize));

        // Register the backing struct so GetDeclaredStructs() surfaces it to the
        // emitter, where it is emitted as a nested TypeDef of the containing type.
        scope.TryDeclareTypeAlias(bufferName, backing);
        return backing;
    }

    private void BindAndFoldConstFieldInitializer(FieldSymbol constField, FieldDeclarationSyntax fieldSyntaxNode, TypeSymbol fieldType)
    {
        var boundInit = bindExpression(fieldSyntaxNode.Initializer);
        var convertedInit = conversions.BindConversion(fieldSyntaxNode.Initializer.Location, boundInit, fieldType);
        if (TryFoldConstantFieldValue(convertedInit, fieldType, out var constantValue))
        {
            constField.SetConstantValue(constantValue);
        }
        else if (boundInit is not BoundErrorExpression && convertedInit is not BoundErrorExpression)
        {
            Diagnostics.ReportConstFieldInitializerNotConstant(fieldSyntaxNode.Initializer.Location, constField.Name);
        }
    }

    /// <summary>
    /// Issue #1070: pushes a child scope that exposes the enclosing type's static
    /// members — static fields, const fields, and static properties — as bare
    /// names, then makes it the active binding scope. This mirrors the
    /// static-member visibility that method/constructor bodies already have (see
    /// <c>Binder.BindProgram</c>), so a field initializer (instance
    /// <c>let</c>/<c>var</c>, <c>shared</c> field, or <c>const</c>) can reference a
    /// sibling <c>const</c> or <c>shared</c> field regardless of declaration order.
    /// The returned token restores the previous scope when disposed.
    /// </summary>
    private StaticMemberScope PushStaticMemberScope(StructSymbol structSymbol)
    {
        var previous = binderCtx.RootScope;
        var staticScope = new BoundScope(previous);

        if (!structSymbol.StaticFields.IsDefaultOrEmpty)
        {
            foreach (var fld in structSymbol.StaticFields)
            {
                staticScope.TryDeclareVariable(new ImplicitStaticFieldVariableSymbol(structSymbol, fld));
            }
        }

        if (!structSymbol.ConstFields.IsDefaultOrEmpty)
        {
            foreach (var fld in structSymbol.ConstFields)
            {
                staticScope.TryDeclareVariable(new ImplicitStaticFieldVariableSymbol(structSymbol, fld));
            }
        }

        if (!structSymbol.StaticProperties.IsDefaultOrEmpty)
        {
            foreach (var prop in structSymbol.StaticProperties)
            {
                staticScope.TryDeclareVariable(new ImplicitStaticPropertyVariableSymbol(structSymbol, prop));
            }
        }

        binderCtx.RootScope = staticScope;
        return new StaticMemberScope(binderCtx, previous);
    }

    /// <summary>
    /// Issue #1070: restores the binder's root scope to the value captured before
    /// <see cref="PushStaticMemberScope"/> installed the static-member scope.
    /// </summary>
    private readonly struct StaticMemberScope : System.IDisposable
    {
        private readonly BinderContext binderCtx;
        private readonly BoundScope previous;

        public StaticMemberScope(BinderContext binderCtx, BoundScope previous)
        {
            this.binderCtx = binderCtx;
            this.previous = previous;
        }

        public void Dispose() => binderCtx.RootScope = previous;
    }

    /// <summary>
    /// Issue #910 / ADR-0110 / issue #1069: binds the BODIES of the nested type
    /// declarations declared in a class or struct body, reusing the type-name
    /// shells declared earlier by <see cref="DeclareNestedTypeShells"/> (phase 1).
    /// Splitting shell declaration from body binding lets a sibling member
    /// signature (a field/property/parameter/return type, a generic argument, an
    /// array element type, …) forward-reference any nested type by simple name,
    /// for every nested kind (<c>class</c>/<c>struct</c>/<c>data struct</c>/
    /// <c>interface</c>/<c>enum</c>). Nested enums are fully bound in the shell
    /// phase (their members reference no user types) and need no body pass here.
    /// Nested-in-nested declarations are handled recursively because the
    /// per-kind body binders bind their own nested types.
    /// <para>
    /// All nested kinds inside either encloser (<c>class</c> or <c>struct</c>)
    /// are emitted as real CLR nested types. The emitter materialises every
    /// enclosing TypeDef row before its nested rows (ECMA-335 §II.22.32) via a
    /// unified pre-order emission pass (ADR-0110), so no kind/encloser
    /// combination needs to be deferred.
    /// </para>
    /// </summary>
    private void BindNestedTypeBodies(StructDeclarationSyntax containerSyntax, PackageSymbol package)
    {
        if (containerSyntax.NestedTypes.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var nested in containerSyntax.NestedTypes)
        {
            // Issue #950: a `protected` nested type is only meaningful when the
            // container is an inheritable `open class`. Otherwise nothing can
            // derive from the container to reach the nested type.
            if (!(containerSyntax.IsClass && containerSyntax.IsOpen))
            {
                ReportProtectedToken(GetMemberAccessibilityModifier(nested));
            }

            switch (nested)
            {
                case StructDeclarationSyntax nestedStruct:
                    // The shell (and its own nested shells, recursively) was
                    // declared in phase 1; bind its body now. Binding the body
                    // recurses into BindNestedTypeBodies for nested-in-nested.
                    if (nestedStructShells.TryGetValue(nestedStruct, out var nestedStructSymbol))
                    {
                        BindStructDeclarationBody(nestedStruct, package, nestedStructSymbol);
                    }

                    break;

                case EnumDeclarationSyntax:
                    // Nested enums are fully bound in the shell phase.
                    break;

                case InterfaceDeclarationSyntax nestedInterface:
                    if (nestedInterfaceShells.TryGetValue(nestedInterface, out var nestedInterfaceSymbol))
                    {
                        BindInterfaceMembers(nestedInterface, nestedInterfaceSymbol, package);
                    }

                    break;
            }
        }
    }

    /// <summary>
    /// Issue #1069 (phase 1): declares the type-name shells of the nested types
    /// declared in <paramref name="containerSyntax"/> and records the enclosing
    /// type on each via <c>SetContainingType</c>, BEFORE any member body of the
    /// enclosing type is bound. This makes every nested type resolvable by simple
    /// name from within the enclosing type (and as a CLR nested type by qualified
    /// name from outside) regardless of declaration order, mirroring the
    /// two-phase scheme used for top-level types (#973).
    /// <list type="bullet">
    /// <item><c>struct</c>/<c>class</c>/<c>data struct</c>: a shell is declared
    /// (fields/base bound later) and its own nested shells are declared
    /// recursively.</item>
    /// <item><c>enum</c>: fully bound now — enum members reference no user types,
    /// so there is nothing to defer.</item>
    /// <item><c>interface</c>: a shell is declared; its method signatures are
    /// bound later by <see cref="BindNestedTypeBodies"/>.</item>
    /// </list>
    /// </summary>
    internal void DeclareNestedTypeShells(StructDeclarationSyntax containerSyntax, TypeSymbol containerSymbol, PackageSymbol package)
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
                    var nestedStructSymbol = DeclareStructShell(nestedStruct, package, containerSymbol);
                    if (nestedStructSymbol != null)
                    {
                        nestedStructShells[nestedStruct] = nestedStructSymbol;
                        DeclareNestedTypeShells(nestedStruct, nestedStructSymbol, package);
                    }

                    break;

                case EnumDeclarationSyntax nestedEnum:
                    BindEnumDeclaration(nestedEnum, package, containerSymbol);
                    break;

                case InterfaceDeclarationSyntax nestedInterface:
                    var nestedInterfaceSymbol = DeclareInterfaceSymbol(nestedInterface, package, containerSymbol);
                    if (nestedInterfaceSymbol != null)
                    {
                        nestedInterfaceShells[nestedInterface] = nestedInterfaceSymbol;
                    }

                    break;
            }
        }
    }

    /// <summary>
    /// Issue #987: verifies that every concrete (non-<c>open</c>) class
    /// overrides all abstract methods it inherits. Run after all type bodies are
    /// bound so the base-class method sets are complete. An <c>open</c> class may
    /// leave inherited abstract members unimplemented (it stays abstract itself).
    /// </summary>
    // Issue #1085: run all deferred base-constructor-initializer bindings. Must
    // be called after every declared type body has been bound (so all explicit
    // constructors exist) and before lowering/emit consume the resolved
    // initializers.
    internal void BindPendingBaseInitializers()
    {
        foreach (var bind in pendingBaseInitializerBindings)
        {
            bind();
        }

        pendingBaseInitializerBindings.Clear();
    }

    internal void VerifyAbstractMethodImplementations()
    {
        foreach (var (syntax, structSymbol) in pendingAbstractImplementationChecks)
        {
            // An `open` class is permitted to remain abstract — it need not
            // override inherited abstract members.
            if (structSymbol.IsOpen)
            {
                continue;
            }

            foreach (var abstractMethod in structSymbol.GetUnimplementedAbstractMethods())
            {
                // Skip abstract methods declared directly on this class — those
                // are reported via GS0388 (abstract member in a non-open class).
                // GS0387 is reserved for abstract members *inherited* from a base
                // class and left unimplemented by a concrete subclass.
                if (ReferenceEquals(abstractMethod.ReceiverType, structSymbol))
                {
                    continue;
                }

                Diagnostics.ReportAbstractMemberNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol.Name,
                    abstractMethod.ReceiverType?.Name ?? structSymbol.Name,
                    abstractMethod.Name);
            }
        }
    }

    /// <summary>
    /// Issue #1006: once interface base clauses have been bound, expand each
    /// implementer's interface set to include the transitive closure of base
    /// interfaces. A <c>class C : B</c> where <c>interface B : A</c> must
    /// implement (and metadata-declare) both <c>B</c> and <c>A</c>, matching
    /// C#. Base CLR interfaces of user interfaces are folded into the
    /// implementer's CLR interface set so dispatch through them works too.
    /// </summary>
    internal void ExpandStructInterfaceClosures()
    {
        foreach (var (_, structSymbol) in pendingInterfaceImplementationChecks)
        {
            if (structSymbol.Interfaces.IsDefaultOrEmpty)
            {
                continue;
            }

            var ordered = new List<InterfaceSymbol>();
            var seen = new HashSet<InterfaceSymbol>();
            var clrSeen = new HashSet<System.Type>();
            var extraClr = ImmutableArray.CreateBuilder<TypeSymbol>();
            if (!structSymbol.ImplementedClrInterfaces.IsDefaultOrEmpty)
            {
                foreach (var existing in structSymbol.ImplementedClrInterfaces)
                {
                    if (existing.ClrType != null)
                    {
                        clrSeen.Add(existing.ClrType);
                    }
                }
            }

            foreach (var direct in structSymbol.Interfaces)
            {
                foreach (var iface in direct.SelfAndAllBaseInterfaces())
                {
                    if (seen.Add(iface))
                    {
                        ordered.Add(iface);
                    }

                    if (!iface.BaseClrInterfaces.IsDefaultOrEmpty)
                    {
                        foreach (var clr in iface.BaseClrInterfaces)
                        {
                            if (clr.ClrType != null && clrSeen.Add(clr.ClrType))
                            {
                                extraClr.Add(clr);
                            }
                        }
                    }
                }
            }

            if (ordered.Count != structSymbol.Interfaces.Length)
            {
                structSymbol.SetInterfaces(ordered.ToImmutableArray());
            }

            if (extraClr.Count > 0)
            {
                var merged = ImmutableArray.CreateBuilder<TypeSymbol>();
                if (!structSymbol.ImplementedClrInterfaces.IsDefaultOrEmpty)
                {
                    merged.AddRange(structSymbol.ImplementedClrInterfaces);
                }

                merged.AddRange(extraClr);
                structSymbol.SetImplementedClrInterfaces(merged.ToImmutable());
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
                        var methodTypeParamMap = TryBuildMethodTypeParameterMap(imethod, candidate);
                        if (methodTypeParamMap == null)
                        {
                            // Generic-arity mismatch: not a viable implementor
                            // of this interface method overload (issue #1007).
                            continue;
                        }

                        if (SignaturesMatch(imethod, GetCallableParameters(candidate), candidate.Type, candidate.ReturnRefKind, methodTypeParamMap, candidate.IsAsync))
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
                    // ADR-0089 / issue #1019: static-virtual interface
                    // properties are verified separately (against the
                    // implementer's static properties); skip them here so the
                    // instance-property contract check doesn't misfire.
                    if (iprop.IsStatic)
                    {
                        continue;
                    }

                    // Issue #1066: an interface property may be satisfied by a
                    // property implemented (or inherited) ANYWHERE in the base
                    // chain, not only one declared directly on this class.
                    // TypeMemberModel.TryGetProperty walks BaseClass this-first,
                    // mirroring C# semantics where a base class's accessible
                    // instance member satisfies an interface listed on a
                    // derived class.
                    var found = TypeMemberModel.TryGetProperty(structSymbol, iprop.Name, out var implProp);
                    if (found)
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

            // Issue #985: a CLR interface in the base clause may inherit other
            // interfaces whose abstract members are NOT enumerated by the
            // direct-interface walk above (e.g. `IEnumerable[T]` inherits the
            // non-generic `IEnumerable.GetEnumerator()`). The resulting type
            // must satisfy those inherited slots too — otherwise the runtime
            // rejects it with a TypeLoadException. Verify them here so a missing
            // bridge (the canonical "only the generic GetEnumerator present"
            // case) surfaces as GS0187 instead of emitting an unloadable type.
            VerifyInheritedClrInterfaceSlots(syntax, structSymbol);

            // ADR-0089 / issue #755: verify static-virtual interface members.
            // For each declared interface, walk its StaticMethods. The
            // implementer must either (a) declare a matching static method
            // inside its `shared { ... }` block (ADR-0053) — recorded on
            // StructSymbol.StaticMethods — or (b) inherit a default body
            // from the interface itself (the interface method declaration
            // carries a body). If a same-named *instance* method exists but
            // no matching static method, GS0332 surfaces; otherwise GS0331.
            VerifyStaticVirtualInterfaceImplementations(syntax, structSymbol);

            // ADR-0089 / issue #1019: verify static-virtual interface
            // *properties*. The implementer must declare a matching static
            // property (same name and type, with at least the required
            // accessors) inside its `shared { ... }` block; otherwise GS0397.
            VerifyStaticVirtualInterfacePropertyImplementations(syntax, structSymbol);

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
                        if (SignaturesMatch(imethod, GetCallableParameters(candidate), candidate.Type, candidate.ReturnRefKind, typeParamMap: null, candidate.IsAsync))
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
    /// ADR-0089 / issue #1019: enforces that every static-virtual interface
    /// property (declared inside the interface <c>shared { … }</c> block) is
    /// matched by a same-name, same-type static property on the implementer
    /// providing at least the required accessors. Missing slots produce GS0397.
    /// </summary>
    private void VerifyStaticVirtualInterfacePropertyImplementations(StructDeclarationSyntax syntax, StructSymbol structSymbol)
    {
        foreach (var iface in structSymbol.Interfaces)
        {
            if (iface.Properties.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var iprop in iface.Properties)
            {
                if (!iprop.IsStatic)
                {
                    continue;
                }

                // Issue #1030: a default-bodied static-virtual interface
                // property accessor (non-abstract) supplies its own body, so
                // an implementer is NOT required to provide it. Only abstract
                // accessors must be satisfied. Compute per-accessor whether an
                // abstract slot remains for the implementer to fill.
                var getterIsAbstract = iprop.HasGetter && (iprop.GetterSymbol == null || iprop.GetterSymbol.IsAbstract);
                var setterIsAbstract = iprop.HasSetter && (iprop.SetterSymbol == null || iprop.SetterSymbol.IsAbstract);

                if (!getterIsAbstract && !setterIsAbstract)
                {
                    // Fully default-bodied property: nothing the implementer
                    // must provide.
                    continue;
                }

                PropertySymbol match = null;
                foreach (var candidate in structSymbol.StaticProperties)
                {
                    if (candidate.Name == iprop.Name
                        && System.Collections.Generic.EqualityComparer<TypeSymbol>.Default.Equals(candidate.Type, iprop.Type))
                    {
                        match = candidate;
                        break;
                    }
                }

                if (match == null)
                {
                    Diagnostics.ReportStaticVirtualInterfacePropertyNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol.Name,
                        iface.Name,
                        iprop.Name,
                        "missing static property");
                    continue;
                }

                if (getterIsAbstract && !match.HasGetter)
                {
                    Diagnostics.ReportStaticVirtualInterfacePropertyNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol.Name,
                        iface.Name,
                        iprop.Name,
                        "getter");
                }

                if (setterIsAbstract && !match.HasSetter)
                {
                    Diagnostics.ReportStaticVirtualInterfacePropertyNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol.Name,
                        iface.Name,
                        iprop.Name,
                        "setter");
                }
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

            // Issue #949: a CLR generic interface closed over a user-defined G#
            // type (e.g. the self-referential `class Shape : IEquatable[Shape]`)
            // is represented with a type-erased ClrType (`IEquatable<object>`)
            // but carries the real symbolic arguments. Verify against the OPEN
            // definition's members with those arguments substituted in, so the
            // contract demands `Equals(Shape)` rather than `Equals(object)`.
            if (MemberLookup.TryGetSymbolicClrGenericInterface(ifaceSym, out var openDefinition, out var symbolicArgs))
            {
                VerifySymbolicClrGenericInterface(syntax, structSymbol, clrIface, openDefinition, symbolicArgs);
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

    /// <summary>
    /// Issue #985: verifies that the type satisfies every abstract method slot
    /// contributed by interfaces that its declared CLR interfaces transitively
    /// inherit. The direct-interface walks
    /// (<see cref="VerifyClrInterfaceImplementations"/> /
    /// <see cref="VerifySymbolicClrGenericInterface"/>) only enumerate the
    /// declared interface's OWN members, so an inherited slot such as the
    /// non-generic <c>IEnumerable.GetEnumerator()</c> reached through
    /// <c>IEnumerable[T]</c> would otherwise go unverified and the emitter would
    /// produce a type the runtime cannot load. A satisfying method may be the
    /// covariant-return bridge accepted by
    /// <see cref="MemberLookup.TryResolveCovariantInterfaceBridge"/>.
    /// </summary>
    private void VerifyInheritedClrInterfaceSlots(StructDeclarationSyntax syntax, StructSymbol structSymbol)
    {
        if (structSymbol.ImplementedClrInterfaces.IsDefaultOrEmpty)
        {
            return;
        }

        var reported = new HashSet<string>(System.StringComparer.Ordinal);
        foreach (var ifaceSym in structSymbol.ImplementedClrInterfaces)
        {
            foreach (var slot in MemberLookup.EnumerateClrInterfaceSlots(ifaceSym))
            {
                if (!slot.IsInherited)
                {
                    // The declared interface's own members are checked by the
                    // direct-interface walks; only inherited slots are new here.
                    continue;
                }

                var declaringType = slot.Method.DeclaringType;
                var slotKey = (declaringType?.FullName ?? declaringType?.Name ?? string.Empty)
                    + "::" + MemberLookup.FormatClrSlotSignature(slot.Method);
                if (reported.Contains(slotKey))
                {
                    continue;
                }

                if (StructSatisfiesClrSlot(structSymbol, slot))
                {
                    continue;
                }

                reported.Add(slotKey);
                Diagnostics.ReportInterfaceMethodNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol.Name,
                    declaringType?.FullName ?? declaringType?.Name ?? "interface",
                    MemberLookup.FormatClrSlotSignature(slot.Method));
            }
        }
    }

    private static bool StructSatisfiesClrSlot(StructSymbol structSymbol, in MemberLookup.ClrInterfaceSlot slot)
    {
        // Note: do NOT route through GetMethodsIncludingInherited here — it
        // dedups same-name overloads by parameter signature (ignoring return
        // type), which would hide the non-generic covariant bridge method that
        // shares the generic method's name and (empty) parameter list. Walk the
        // class and its base chain directly so both overloads are visible.
        for (var c = structSymbol; c != null; c = c.BaseClass)
        {
            if (c.Methods.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var candidate in c.Methods)
            {
                if (candidate.Name == slot.Method.Name
                    && MemberLookup.MethodSatisfiesClrSlot(candidate, slot))
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #949: verifies a class against a CLR generic interface that is
    /// closed over at least one user-defined G# type argument (e.g.
    /// <c>IEquatable[Shape]</c>, including the self-referential
    /// <c>class Shape : IEquatable[Shape]</c>). The interface's <c>ClrType</c>
    /// is type-erased (<c>IEquatable&lt;object&gt;</c>), so the contract is
    /// checked against the OPEN definition's members with the symbolic
    /// arguments substituted in — the class must provide <c>Equals(Shape)</c>,
    /// not <c>Equals(object)</c>.
    /// </summary>
    private void VerifySymbolicClrGenericInterface(
        StructDeclarationSyntax syntax,
        StructSymbol structSymbol,
        System.Type clrIface,
        System.Type openDefinition,
        ImmutableArray<TypeSymbol> symbolicArgs)
    {
        foreach (var openMethod in openDefinition.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance))
        {
            if (openMethod.IsSpecialName || !openMethod.IsAbstract)
            {
                continue;
            }

            if (MemberLookup.HasMatchingMethodForSymbolicClrInterface(structSymbol, openMethod, symbolicArgs))
            {
                continue;
            }

            Diagnostics.ReportInterfaceMethodNotImplemented(
                syntax.Identifier.Location,
                structSymbol.Name,
                clrIface.FullName ?? clrIface.Name,
                FormatClrMethodSignature(openMethod));
        }

        foreach (var openProp in openDefinition.GetProperties(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance))
        {
            var implProp = MemberLookup.FindMatchingPropertyForSymbolicClrInterface(structSymbol, openProp, symbolicArgs);
            if (implProp == null)
            {
                Diagnostics.ReportInterfaceMethodNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol.Name,
                    clrIface.FullName ?? clrIface.Name,
                    openProp.Name);
                continue;
            }

            if (openProp.GetMethod != null && !implProp.HasGetter)
            {
                Diagnostics.ReportInterfaceMethodNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol.Name,
                    clrIface.FullName ?? clrIface.Name,
                    openProp.Name + " (getter)");
            }

            if (openProp.SetMethod != null && !implProp.HasSetter)
            {
                Diagnostics.ReportInterfaceMethodNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol.Name,
                    clrIface.FullName ?? clrIface.Name,
                    openProp.Name + " (setter)");
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

    /// <summary>
    /// Issue #948: scans an instance field initializer expression for a
    /// reference to <c>this</c>, another instance member, or a constructor
    /// parameter. Such references are illegal because instance field
    /// initializers run before the constructor body (matching C#).
    /// </summary>
    /// <param name="node">The initializer expression syntax to scan.</param>
    /// <param name="forbiddenNames">Instance member and constructor parameter names.</param>
    /// <param name="offendingName">The first offending name found.</param>
    /// <param name="offendingLocation">The location of the first offending reference.</param>
    /// <returns>True when an illegal reference was found.</returns>
    private static bool TryFindInstanceMemberReference(
        SyntaxNode node,
        HashSet<string> forbiddenNames,
        out string offendingName,
        out TextLocation offendingLocation)
    {
        if (node is NameExpressionSyntax nameExpr &&
            forbiddenNames.Contains(nameExpr.IdentifierToken.Text))
        {
            offendingName = nameExpr.IdentifierToken.Text;
            offendingLocation = nameExpr.IdentifierToken.Location;
            return true;
        }

        foreach (var child in node.GetChildren())
        {
            if (TryFindInstanceMemberReference(child, forbiddenNames, out offendingName, out offendingLocation))
            {
                return true;
            }
        }

        offendingName = null;
        offendingLocation = default;
        return false;
    }

    /// <summary>
    /// Issue #948: attempts to fold a bound const-field initializer to a
    /// compile-time constant value coerced to the field's CLR primitive type.
    /// Handles literal expressions (optionally wrapped in numeric/identity
    /// conversions) and unary negation of a numeric literal. Returns
    /// <c>false</c> for non-constant expressions so the caller can report a
    /// diagnostic.
    /// </summary>
    /// <param name="bound">The bound (already type-converted) initializer expression.</param>
    /// <param name="fieldType">The declared const field type.</param>
    /// <param name="value">The folded constant value on success.</param>
    /// <returns>True when a compile-time constant was produced.</returns>
    private static bool TryFoldConstantFieldValue(BoundExpression bound, TypeSymbol fieldType, out object value)
    {
        value = null;
        if (!TryEvaluateConstant(bound, out var raw))
        {
            return false;
        }

        if (raw == null)
        {
            // A null literal is only valid for reference-typed const fields
            // (e.g. `const s string = nil`); the Constant row stores a null.
            value = null;
            return !fieldType.ClrType?.IsValueType ?? true;
        }

        var targetClr = fieldType.ClrType;
        if (targetClr == null)
        {
            return false;
        }

        if (targetClr.IsEnum)
        {
            targetClr = System.Enum.GetUnderlyingType(targetClr);
        }

        try
        {
            value = targetClr == raw.GetType()
                ? raw
                : System.Convert.ChangeType(raw, targetClr, System.Globalization.CultureInfo.InvariantCulture);
            return true;
        }
        catch (System.Exception ex) when (ex is System.InvalidCastException or System.FormatException or System.OverflowException or System.ArgumentException)
        {
            return false;
        }
    }

    /// <summary>
    /// Issue #948: evaluates a bound expression to a compile-time constant
    /// (a literal, a conversion over a constant, or a unary +/- over a numeric
    /// constant). Returns <c>false</c> for any non-constant shape.
    /// </summary>
    /// <param name="bound">The bound expression.</param>
    /// <param name="value">The constant value on success.</param>
    /// <returns>True when the expression is a compile-time constant.</returns>
    private static bool TryEvaluateConstant(BoundExpression bound, out object value)
    {
        switch (bound)
        {
            case BoundLiteralExpression lit:
                value = lit.Value;
                return true;

            case BoundConversionExpression conv:
                return TryEvaluateConstant(conv.Expression, out value);

            case BoundUnaryExpression unary
                when unary.Op.Kind is BoundUnaryOperatorKind.Negation or BoundUnaryOperatorKind.Identity
                && TryEvaluateConstant(unary.Operand, out var operand)
                && operand != null:
                value = NegateIfNeeded(operand, unary.Op.Kind == BoundUnaryOperatorKind.Negation);
                return value != null;

            case BoundBinaryExpression binary
                when TryEvaluateConstant(binary.Left, out var left)
                && TryEvaluateConstant(binary.Right, out var right)
                && left != null
                && right != null:
                value = FoldBinary(binary.Op.Kind, left, right);
                return value != null;

            default:
                value = null;
                return false;
        }
    }

    /// <summary>
    /// Issue #948: folds a binary operation over two constant operands. Supports
    /// the constant-expression forms allowed in C# const initializers that the
    /// const-field feature commonly needs: numeric arithmetic and string
    /// concatenation. Returns <c>null</c> for unsupported shapes.
    /// </summary>
    private static object FoldBinary(BoundBinaryOperatorKind kind, object left, object right)
    {
        if (left is string || right is string)
        {
            return kind == BoundBinaryOperatorKind.Sum ? string.Concat(left, right) : null;
        }

        if (left is decimal || right is decimal)
        {
            if (!TryToDecimal(left, out var ld) || !TryToDecimal(right, out var rd))
            {
                return null;
            }

            return kind switch
            {
                BoundBinaryOperatorKind.Sum => ld + rd,
                BoundBinaryOperatorKind.Difference => ld - rd,
                BoundBinaryOperatorKind.Product => ld * rd,
                BoundBinaryOperatorKind.Quotient when rd != 0 => ld / rd,
                _ => (object)null,
            };
        }

        if (left is double || left is float || right is double || right is float)
        {
            var ld = System.Convert.ToDouble(left, System.Globalization.CultureInfo.InvariantCulture);
            var rd = System.Convert.ToDouble(right, System.Globalization.CultureInfo.InvariantCulture);
            return kind switch
            {
                BoundBinaryOperatorKind.Sum => ld + rd,
                BoundBinaryOperatorKind.Difference => ld - rd,
                BoundBinaryOperatorKind.Product => ld * rd,
                BoundBinaryOperatorKind.Quotient when rd != 0 => ld / rd,
                _ => (object)null,
            };
        }

        if (!TryToInt64(left, out var li) || !TryToInt64(right, out var ri))
        {
            return null;
        }

        return kind switch
        {
            BoundBinaryOperatorKind.Sum => li + ri,
            BoundBinaryOperatorKind.Difference => li - ri,
            BoundBinaryOperatorKind.Product => li * ri,
            BoundBinaryOperatorKind.Quotient when ri != 0 => li / ri,
            BoundBinaryOperatorKind.Remainder when ri != 0 => li % ri,
            BoundBinaryOperatorKind.ShiftLeft => li << (int)ri,
            BoundBinaryOperatorKind.ShiftRight => li >> (int)ri,
            BoundBinaryOperatorKind.BitwiseAnd => li & ri,
            BoundBinaryOperatorKind.BitwiseOr => li | ri,
            BoundBinaryOperatorKind.BitwiseXor => li ^ ri,
            _ => (object)null,
        };
    }

    private static bool TryToInt64(object value, out long result)
    {
        switch (value)
        {
            case int or long or short or sbyte or byte or ushort or uint:
                result = System.Convert.ToInt64(value, System.Globalization.CultureInfo.InvariantCulture);
                return true;
            case char c:
                result = c;
                return true;
            default:
                result = 0;
                return false;
        }
    }

    private static bool TryToDecimal(object value, out decimal result)
    {
        try
        {
            result = System.Convert.ToDecimal(value, System.Globalization.CultureInfo.InvariantCulture);
            return true;
        }
        catch (System.Exception ex) when (ex is System.InvalidCastException or System.FormatException or System.OverflowException)
        {
            result = 0;
            return false;
        }
    }

    private static object NegateIfNeeded(object operand, bool negate)
    {
        if (!negate)
        {
            return operand;
        }

        return operand switch
        {
            int i => -i,
            long l => -l,
            short s => -s,
            sbyte sb => -sb,
            float f => -f,
            double d => -d,
            decimal m => -m,
            _ => null,
        };
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

    internal InterfaceSymbol DeclareInterfaceSymbol(InterfaceDeclarationSyntax syntax, PackageSymbol package, TypeSymbol containingType = null)
    {
        var name = syntax.Identifier.Text;
        var accessibility = resolveAccessibility(syntax.AccessibilityModifier);
        var interfaceSymbol = new InterfaceSymbol(name, accessibility, syntax, package.Name);
        Binder.AttachDocumentation(interfaceSymbol, syntax);

        // Issue #1080: set the enclosing type BEFORE registering the name so the
        // scope can scope name-uniqueness to the enclosing type.
        if (containingType != null)
        {
            interfaceSymbol.SetContainingType(containingType);
        }

        interfaceSymbol.SetAttributes(BindAttributes(
            syntax.Annotations,
            AttributeTargetKind.Type,
            Binder.TypeDeclarationAllowedTargets,
            "an interface declaration",
            System.AttributeTargets.Interface));

        // Phase 4.3c / ADR-0020: bind type parameters at declaration time so
        // method-signature binding (which happens later) can resolve them.
        //
        // Issue #1061: register the interface's name shell BETWEEN creating the
        // bare type parameters and resolving their constraints (mirroring the
        // class/struct path from #1056). This puts the declaring interface's own
        // name and arity in scope while its type-parameter constraints are bound,
        // so a self-referential / CRTP constraint such as
        // `interface IData[T IData]` or `interface IData[TData IAppleData[TData]]`
        // resolves the interface being declared instead of failing with GS0113.
        var registered = false;
        var registrationFailed = false;
        var typeParameters = BindTypeParameterList(
            syntax.TypeParameterList,
            bareSymbols =>
            {
                if (!bareSymbols.IsDefaultOrEmpty)
                {
                    interfaceSymbol.SetTypeParameters(bareSymbols);
                }

                if (!scope.TryDeclareTypeAlias(name, interfaceSymbol))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
                    registrationFailed = true;
                    return;
                }

                registered = true;
            });

        if (registrationFailed)
        {
            return null;
        }

        // Bind the fully-resolved type parameters (with constraints) onto the
        // interface symbol; the callback only attached the bare symbols.
        if (!typeParameters.IsDefaultOrEmpty)
        {
            interfaceSymbol.SetTypeParameters(typeParameters);
        }

        // Non-generic interfaces (or the defensive fallback when the callback did
        // not run) register the name shell here.
        if (!registered && !scope.TryDeclareTypeAlias(name, interfaceSymbol))
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

    /// <summary>
    /// Issue #1006: binds the base-interface clause of an interface declaration
    /// (<c>interface B : A</c>). Each entry must resolve to an interface — a
    /// user <see cref="InterfaceSymbol"/> or an imported CLR interface — or a
    /// GS0391 diagnostic fires. Resolved bases are recorded on the
    /// <see cref="InterfaceSymbol"/> so member lookup and emit can surface and
    /// re-emit them.
    /// </summary>
    private void BindInterfaceBaseInterfaces(InterfaceDeclarationSyntax syntax, InterfaceSymbol interfaceSymbol)
    {
        if (!syntax.HasBaseInterfaces || syntax.BaseTypeClauses.Count == 0)
        {
            return;
        }

        var name = syntax.Identifier.Text;
        var baseInterfaces = ImmutableArray.CreateBuilder<InterfaceSymbol>();
        var baseClrInterfaces = ImmutableArray.CreateBuilder<TypeSymbol>();
        for (var i = 0; i < syntax.BaseTypeClauses.Count; i++)
        {
            var baseTypeSyntax = syntax.BaseTypeClauses[i];
            var baseName = GetBaseClauseTypeDisplayName(baseTypeSyntax);
            var baseLocation = baseTypeSyntax.Identifier?.Location ?? syntax.Identifier.Location;

            var resolved = bindTypeClause(baseTypeSyntax);
            if (resolved == null || resolved == TypeSymbol.Error)
            {
                continue;
            }

            if (resolved is InterfaceSymbol iface)
            {
                // Issue #1006: reject direct self-inheritance (`interface A : A`).
                if (iface == interfaceSymbol || iface.Definition == interfaceSymbol)
                {
                    Diagnostics.ReportInterfaceCannotHaveClassBase(baseLocation, name, baseName);
                    continue;
                }

                if (iface.IsGenericDefinition)
                {
                    Diagnostics.ReportWrongTypeArgumentCount(baseLocation, baseName, iface.TypeParameters.Length, 0);
                    continue;
                }

                baseInterfaces.Add(iface);
                continue;
            }

            // An imported CLR interface (e.g. `: System.IDisposable`) is a valid
            // base interface too.
            if (resolved.ClrType != null && resolved.ClrType.IsInterface)
            {
                baseClrInterfaces.Add(resolved);
                continue;
            }

            // Anything else (a user class/struct or a CLR class) is illegal —
            // only interfaces may appear in an interface's base list.
            Diagnostics.ReportInterfaceCannotHaveClassBase(baseLocation, name, baseName);
        }

        if (baseInterfaces.Count > 0)
        {
            interfaceSymbol.SetBaseInterfaces(baseInterfaces.ToImmutable());
        }

        if (baseClrInterfaces.Count > 0)
        {
            interfaceSymbol.SetBaseClrInterfaces(baseClrInterfaces.ToImmutable());
        }
    }

    private void BindInterfaceMembersCore(InterfaceDeclarationSyntax syntax, InterfaceSymbol interfaceSymbol, PackageSymbol package)
    {
        BindInterfaceBaseInterfaces(syntax, interfaceSymbol);

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

            // Issue #1007 / ADR-0020: an interface method may declare its own
            // generic type-parameter list (`func M[T](...) T`). Bind it first
            // and seed it into the binding scope — merged with any enclosing
            // interface type parameters — so the method's parameter types and
            // return type (and, for default-bodied methods, the body) can
            // reference `T`. The seeding is unwound at the end of each
            // iteration so one method's type parameters never leak into the
            // next or the surrounding interface, mirroring the class-method
            // path.
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
            // ADR-0122 / issue #1036: an `unsafe func` interface method binds its
            // signature (params + return) in an unsafe context too, mirroring the
            // class/struct member path. No-op for a non-`unsafe` method.
            using var sigUnsafeContext = binderCtx.PushUnsafeContext(methodSyntax.IsUnsafe);

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
            methodSymbol.IsUnsafe = methodSyntax.IsUnsafe;
            methodSymbol.TypeParameters = methodTypeParameters;
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
            finally
            {
                binderCtx.CurrentTypeParameters = enclosingTypeParameters;
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
                // ADR-0118 / issue #944: interface indexer members are out of
                // scope for now — report a clean diagnostic rather than binding
                // an ill-formed property named `this`.
                if (propSyntax.IsIndexer)
                {
                    Diagnostics.ReportIndexerRequiresAccessorBody(propSyntax.ThisKeyword.Location);
                    continue;
                }

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
                bool isInitOnly = false;

                if (propSyntax.OpenBraceToken != null)
                {
                    hasGetter = propSyntax.Accessors.Any(a => a.IsGetter);
                    var hasSet = propSyntax.Accessors.Any(a => a.IsSetter);
                    var hasInit = propSyntax.Accessors.Any(a => a.IsInit);

                    // Issue #946: a property may declare a `set` or an `init`
                    // accessor, but not both.
                    if (hasSet && hasInit)
                    {
                        var initAccessor = propSyntax.Accessors.First(a => a.IsInit);
                        Diagnostics.ReportPropertyHasBothSetAndInit(initAccessor.AccessorKeyword.Location, propName);
                    }

                    hasSetter = hasSet || hasInit;
                    isInitOnly = !hasSet && hasInit;
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

                var isStaticInterfaceProperty = propSyntax.HasStaticModifier;

                var propSymbol = new PropertySymbol(
                    propName,
                    propType,
                    Accessibility.Public,
                    hasGetter,
                    hasSetter,
                    isAutoProperty: false,
                    isVirtual: false,
                    isOverride: false,
                    isStatic: isStaticInterfaceProperty,
                    declaration: propSyntax,
                    isInitOnly: isInitOnly);

                // ADR-0089 / issue #1019: a static-virtual interface property is
                // modelled as get/set accessor *methods* that are static-virtual
                // slots (IsStatic + StaticOwnerType = the interface), reusing the
                // static-virtual method machinery for emit, MethodImpl pairing,
                // and `T.Prop` constrained dispatch. A bodied accessor is a
                // *default* static slot; a body-less accessor is an *abstract*
                // slot the implementer must provide.
                if (isStaticInterfaceProperty)
                {
                    var getAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsGetter);
                    var setAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsSetterOrInit);

                    if (hasGetter)
                    {
                        var getterSymbol = new FunctionSymbol(
                            $"get_{propName}",
                            ImmutableArray<ParameterSymbol>.Empty,
                            propType,
                            declaration: null,
                            package,
                            Accessibility.Public,
                            receiverType: null);
                        getterSymbol.IsStatic = true;
                        getterSymbol.StaticOwnerType = interfaceSymbol;
                        getterSymbol.IsSpecialName = true;
                        if (getAccessor?.Body != null)
                        {
                            // Issue #1030: a default-bodied static-virtual
                            // interface property accessor is a *default* slot
                            // (Static | Virtual, non-abstract) emitting a real
                            // method body. The body is bound in the Binder's
                            // interface accessor-body pass and registered in
                            // functionBodies keyed by this getter symbol.
                            getterSymbol.IsAbstract = false;
                            propSymbol.GetterBodySyntax = getAccessor.Body;
                        }
                        else
                        {
                            getterSymbol.IsAbstract = true;
                        }

                        propSymbol.GetterSymbol = getterSymbol;
                    }

                    if (hasSetter)
                    {
                        var setterParam = new ParameterSymbol("value", propType);
                        var setterSymbol = new FunctionSymbol(
                            $"set_{propName}",
                            ImmutableArray.Create(setterParam),
                            TypeSymbol.Void,
                            declaration: null,
                            package,
                            Accessibility.Public,
                            receiverType: null);
                        setterSymbol.IsStatic = true;
                        setterSymbol.StaticOwnerType = interfaceSymbol;
                        setterSymbol.IsSpecialName = true;
                        setterSymbol.IsInitOnlySetter = isInitOnly;
                        if (setAccessor?.Body != null)
                        {
                            // Issue #1030: default-bodied static-virtual
                            // interface property setter — a non-abstract
                            // default slot with a real method body.
                            setterSymbol.IsAbstract = false;
                            propSymbol.SetterBodySyntax = setAccessor.Body;
                        }
                        else
                        {
                            setterSymbol.IsAbstract = true;
                        }

                        propSymbol.SetterSymbol = setterSymbol;
                    }
                }

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

        // ADR-0089 / issue #1030: bind interface static *state* — `var` / `let`
        // / `const` fields declared inside the interface `shared { … }` block.
        // CLR interfaces may own static fields; these become `Static` FieldDef
        // rows on the interface TypeDef (const → `literal` + `Constant` row).
        if (!syntax.StaticFields.IsDefaultOrEmpty)
        {
            // ADR-0089 / issue #1030: interface static state is supported on
            // both non-generic and generic interfaces. For a generic interface
            // the FieldDef rows live on the interface TypeDef and access sites
            // reference them through a TypeSpec for the closed construction, so
            // each construction (`IBox[int32]` vs `IBox[string]`) owns
            // independent storage — matching CLR static-field semantics.
            {
                var staticFieldsBuilder = ImmutableArray.CreateBuilder<FieldSymbol>();
                var constFieldsBuilder = ImmutableArray.CreateBuilder<FieldSymbol>();
                var initializersBuilder = ImmutableDictionary.CreateBuilder<FieldSymbol, BoundExpression>();
                foreach (var fieldSyntax in syntax.StaticFields)
                {
                    var fieldName = fieldSyntax.Identifier.Text;
                    if (!seenNames.Add(fieldName))
                    {
                        Diagnostics.ReportSymbolAlreadyDeclared(fieldSyntax.Identifier.Location, fieldName);
                        continue;
                    }

                    var fieldType = bindTypeClause(fieldSyntax.Type);
                    if (fieldType == null)
                    {
                        continue;
                    }

                    if (TypeSymbol.IsByRefLike(fieldType))
                    {
                        Diagnostics.ReportByRefLikeEscape(fieldSyntax.Identifier.Location, fieldType, $"be used as the type of field '{fieldName}'");
                        continue;
                    }

                    if (fieldType is ByRefTypeSymbol byRefFieldType)
                    {
                        Diagnostics.ReportPointerTypeCannotBeFieldType(fieldSyntax.Identifier.Location, byRefFieldType.Name);
                        continue;
                    }

                    var fieldAccessibility = resolveAccessibility(fieldSyntax.AccessibilityModifier);

                    // const → compile-time literal field (reads inlined).
                    if (fieldSyntax.IsConst)
                    {
                        var constField = new FieldSymbol(fieldName, fieldType, fieldAccessibility, isReadOnly: true, isStatic: true, isConst: true);
                        Binder.AttachDocumentation(constField, fieldSyntax);

                        if (fieldSyntax.Initializer == null)
                        {
                            Diagnostics.ReportConstFieldRequiresInitializer(fieldSyntax.Identifier.Location, fieldName);
                        }
                        else
                        {
                            var boundConst = bindExpression(fieldSyntax.Initializer);
                            var convertedConst = conversions.BindConversion(fieldSyntax.Initializer.Location, boundConst, fieldType);
                            if (TryFoldConstantFieldValue(convertedConst, fieldType, out var constValue))
                            {
                                constField.SetConstantValue(constValue);
                            }
                            else if (boundConst is not BoundErrorExpression && convertedConst is not BoundErrorExpression)
                            {
                                Diagnostics.ReportConstFieldInitializerNotConstant(fieldSyntax.Initializer.Location, fieldName);
                            }
                        }

                        constFieldsBuilder.Add(constField);
                        continue;
                    }

                    var fieldSymbol = new FieldSymbol(fieldName, fieldType, fieldAccessibility, isReadOnly: fieldSyntax.IsReadOnly, isStatic: true);
                    Binder.AttachDocumentation(fieldSymbol, fieldSyntax);

                    if (fieldSyntax.Initializer != null)
                    {
                        var boundInit = bindExpression(fieldSyntax.Initializer);
                        var convertedInit = conversions.BindConversion(fieldSyntax.Initializer.Location, boundInit, fieldType);
                        initializersBuilder[fieldSymbol] = convertedInit;
                    }

                    staticFieldsBuilder.Add(fieldSymbol);
                }

                interfaceSymbol.SetStaticFields(staticFieldsBuilder.ToImmutable());
                if (constFieldsBuilder.Count > 0)
                {
                    interfaceSymbol.SetConstFields(constFieldsBuilder.ToImmutable());
                }

                if (initializersBuilder.Count > 0)
                {
                    interfaceSymbol.SetStaticFieldInitializers(initializersBuilder.ToImmutable());
                }
            }
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
        // ADR-0122 / issue #1014: an `unsafe func` is bound entirely within an
        // unsafe context so its parameter / return types may be unmanaged raw
        // pointers (`*T` → CLR ELEMENT_TYPE_PTR).
        using var unsafeContext = binderCtx.PushUnsafeContext(syntax.IsUnsafe);

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

            // Issue #1017: a user-defined conversion operator
            // `func operator implicit (x T) U { … }` (or `explicit`) is modelled
            // as a static `op_Implicit` / `op_Explicit` special-name method on
            // the owning user type. It takes exactly one parameter (the source
            // operand) and its return type is the conversion target; at least
            // one of source/target must be a same-package user type.
            if (syntax.IsConversionOperator)
            {
                BindConversionOperatorDeclaration(syntax, parameters.ToImmutable(), type, accessibility, package, functionAttributes);
                return;
            }

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
                function.IsUnsafe = syntax.IsUnsafe;
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
            function.IsUnsafe = syntax.IsUnsafe;
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
    /// Issue #1017: binds a user-defined conversion operator declaration
    /// (<c>func operator implicit (x T) U { … }</c> or the <c>explicit</c>
    /// variant) into a static <c>op_Implicit</c> / <c>op_Explicit</c>
    /// special-name method attached to the owning user type. Enforces the C#
    /// conversion-operator constraints: exactly one parameter; source and
    /// target differ; at least one of them is a same-package user type; and no
    /// duplicate conversion exists for the same source/target pair.
    /// </summary>
    /// <param name="syntax">The conversion-operator declaration syntax.</param>
    /// <param name="parameters">The already-bound parameter list.</param>
    /// <param name="returnType">The already-bound return (target) type.</param>
    /// <param name="accessibility">The declaration's resolved accessibility.</param>
    /// <param name="package">The owning package.</param>
    /// <param name="functionAttributes">Bound annotation attributes for the declaration.</param>
    private void BindConversionOperatorDeclaration(
        FunctionDeclarationSyntax syntax,
        ImmutableArray<ParameterSymbol> parameters,
        TypeSymbol returnType,
        Accessibility accessibility,
        PackageSymbol package,
        ImmutableArray<BoundAttribute> functionAttributes)
    {
        var isExplicit = syntax.ConversionIsExplicit;
        var opName = isExplicit ? "op_Explicit" : "op_Implicit";

        // A conversion operator has exactly one parameter — the source operand.
        if (parameters.Length != 1)
        {
            Diagnostics.ReportConversionOperatorRequiresSingleParameter(syntax.Identifier.Location, isExplicit);
            return;
        }

        var sourceType = parameters[0].Type;
        var targetType = returnType;

        if (sourceType == TypeSymbol.Error || targetType == TypeSymbol.Error)
        {
            return;
        }

        // The source operand may not be passed by ref/out/in.
        if (parameters[0].RefKind != RefKind.None)
        {
            Diagnostics.ReportConversionOperatorRequiresSingleParameter(syntax.Identifier.Location, isExplicit);
            return;
        }

        // A conversion from a type to itself is never user-definable.
        if (Conversion.Classify(sourceType, targetType).IsIdentity)
        {
            Diagnostics.ReportConversionOperatorMustInvolveEnclosingType(syntax.Identifier.Location);
            return;
        }

        // At least one of source/target must be a same-package user type that
        // owns (emits) the operator.
        var owner = TryGetSamePackageOwner(sourceType, package) ?? TryGetSamePackageOwner(targetType, package);
        if (owner == null)
        {
            Diagnostics.ReportConversionOperatorMustInvolveEnclosingType(syntax.Identifier.Location);
            return;
        }

        var function = new FunctionSymbol(
            opName,
            parameters,
            returnType,
            syntax,
            package,
            accessibility,
            receiverType: null);
        function.IsStatic = true;
        function.StaticOwnerType = owner;
        function.IsSpecialName = true;
        Binder.AttachDocumentation(function, syntax);
        if (!functionAttributes.IsDefaultOrEmpty)
        {
            function.SetAttributes(functionAttributes);
        }

        // Reject a duplicate conversion (same source/target pair), whether the
        // existing one is implicit or explicit — matching C# CS0557.
        foreach (var existing in owner.StaticMethods)
        {
            if (existing.Name != "op_Implicit" && existing.Name != "op_Explicit")
            {
                continue;
            }

            if (existing.Parameters.Length != 1)
            {
                continue;
            }

            if (Conversion.Classify(existing.Parameters[0].Type, sourceType).IsIdentity
                && Conversion.Classify(existing.Type, targetType).IsIdentity)
            {
                Diagnostics.ReportDuplicateConversionOperator(syntax.Identifier.Location, sourceType, targetType);
                return;
            }
        }

        owner.AddStaticMethods(ImmutableArray.Create(function));
    }

    /// <summary>
    /// Issue #1017: returns the same-package <see cref="StructSymbol"/> (struct
    /// or class) definition for <paramref name="type"/> when it is declared in
    /// <paramref name="package"/>, or <see langword="null"/> otherwise.
    /// </summary>
    /// <param name="type">The candidate owner type.</param>
    /// <param name="package">The owning package.</param>
    /// <returns>The owning struct definition, or <see langword="null"/>.</returns>
    private static StructSymbol TryGetSamePackageOwner(TypeSymbol type, PackageSymbol package)
    {
        if (type is StructSymbol structSymbol
            && package != null
            && string.Equals(structSymbol.PackageName, package.Name, StringComparison.Ordinal))
        {
            return structSymbol.Definition ?? structSymbol;
        }

        return null;
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
        => BindTypeParameterList(syntax, onBareSymbolsPublished: null);

    /// <summary>
    /// Binds a type-parameter list. The optional
    /// <paramref name="onBareSymbolsPublished"/> callback runs after the bare
    /// type-parameter symbols are created and published into the constraint
    /// scope but BEFORE any constraint clause is resolved. Issue #1056 uses this
    /// to register the declaring type's name shell (with its type parameters
    /// already attached) so a self-referential base-class constraint such as the
    /// CRTP-style <c>class Box[T Box[T]]</c> / <c>class Box[T Box]</c> resolves
    /// the type's own name while its constraints are being bound.
    /// </summary>
    /// <param name="syntax">The type-parameter list syntax.</param>
    /// <param name="onBareSymbolsPublished">Optional callback invoked with the bare type-parameter symbols between pass 1 (symbol creation) and pass 2 (constraint resolution).</param>
    /// <returns>The bound type-parameter symbols.</returns>
    private ImmutableArray<TypeParameterSymbol> BindTypeParameterList(
        TypeParameterListSyntax syntax,
        Action<ImmutableArray<TypeParameterSymbol>> onBareSymbolsPublished)
    {
        if (syntax == null)
        {
            onBareSymbolsPublished?.Invoke(ImmutableArray<TypeParameterSymbol>.Empty);
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

        // Issue #1056: let the caller register the declaring type's name shell
        // (with these bare type parameters attached) before constraints resolve,
        // so a self-referential base-class constraint resolves the type's own
        // name and arity.
        onBareSymbolsPublished?.Invoke(ImmutableArray.Create(symbols));

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

                // ADR-0097 / issue #775 (constraint keyword renamed to `init()`
                // by issue #997): consume the `class` / `struct` / `init()`
                // flag-style constraints. Disjoint combinations (`class struct`,
                // `struct init()`) are rejected as GS0361. The order is determined
                // by the syntax — combining class + init() is legal and produces
                // both CLR flag bits.
                var hasRefType = p.HasClassConstraint;
                var hasValueType = p.HasStructConstraint;
                var hasDefaultCtor = p.HasInitConstraint;

                if (hasRefType && hasValueType)
                {
                    Diagnostics.ReportTypeParameterConstraintConflict(p.StructConstraintKeyword.Location, name, "class", "struct");
                    hasValueType = false;
                }

                if (hasValueType && hasDefaultCtor)
                {
                    // `struct` already implies `init()` at the CLR level (ECMA-335 II.10.1.7);
                    // emitting both would be redundant and would force callers to
                    // remember an arbitrary order. Flag the explicit `init()`.
                    Diagnostics.ReportTypeParameterConstraintConflict(p.InitConstraintKeyword.Location, name, "struct", "init()");
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
    /// Phase 4.2b / ADR-0020 originally accepted only a G#-declared sealed
    /// interface. ADR-0089 added constructed generic G# interfaces carrying
    /// static-virtual members (e.g. <c>[T IAdd[T]]</c>). Issue #943 generalised
    /// this to any imported CLR interface — generic or not. Issue #1052 removes
    /// the last restriction: ANY user-declared interface (sealed or not, generic
    /// or not, including the self-referential <c>[T IFace[T]]</c> shape) is a
    /// legal constraint, so the canonical C# <c>where T : IComparable&lt;T&gt;</c>
    /// shape binds, dispatches instance members, and emits verifiable IL. The
    /// constraint type clause is bound through the regular type binder, so a
    /// self-referential type argument (the type parameter appearing in its own
    /// constraint) resolves against the in-flight scope published by
    /// <see cref="BindTypeParameterList(TypeParameterListSyntax)"/>.
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
            // Issue #1052: ANY user-declared interface — sealed or not, generic
            // or not, including the self-referential `[T IFace[T]]` shape — is a
            // legal constraint, matching imported CLR interfaces and C#'s
            // `where T : IFoo`. The former `sealed`-only gate (Phase 4.2b /
            // ADR-0020) was a stale restriction; instance members still bind on
            // `T` via the constraint and a GenericParamConstraint metadata row is
            // emitted pointing at the interface TypeDef so the IL verifies.
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

        // Issue #1056: a base-class (non-interface) constraint, mirroring C#'s
        // `where T : BaseClass`. The single legacy constraint slot structurally
        // enforces C#'s at-most-one-class rule. Accept a user-declared class
        // (a `StructSymbol` with `IsClass`, open or sealed, generic or not —
        // including the self-referential `[T Box]` / `[T Box[T]]` shapes) and an
        // imported reference-type class. Instance members declared on the base
        // class bind on values of `T` and a GenericParamConstraint metadata row
        // is emitted pointing at the class so the IL verifies. A value type
        // (struct/enum) is still rejected (C# forbids `where T : SomeStruct`).
        if (resolved is StructSymbol { IsClass: true })
        {
            symbol.ClassConstraint = resolved;
            return;
        }

        if (resolved.ClrType is { IsClass: true, IsValueType: false })
        {
            symbol.ClassConstraint = resolved;
            return;
        }

        // Resolved to something that is not a legal constraint (a struct, enum,
        // or other value type).
        Diagnostics.ReportConstraintNotInterface(p.Constraint.Location, resolved.Name);
    }

    /// <summary>
    /// Issue #1055: builds the substitution mapping each base class's generic
    /// type parameters onto the concrete type arguments supplied where that base
    /// is inherited as a constructed generic. Walking the <see cref="StructSymbol.BaseClass"/>
    /// chain closest-first lets a deeper base's type arguments (which are expressed
    /// in terms of a shallower base's type parameters) resolve transitively, so a
    /// multi-level chain such as <c>Leaf : Mid[int32] : Base[T]</c> maps
    /// <c>Base.T -&gt; int32</c>. The resulting map is consumed by
    /// <see cref="SignaturesMatch(FunctionSymbol, ImmutableArray{ParameterSymbol}, TypeSymbol, RefKind, IReadOnlyDictionary{TypeParameterSymbol, TypeSymbol})"/>
    /// so an override whose concrete signature mentions the substituted types is
    /// matched against the base member's un-substituted (open) signature. Returns
    /// <c>null</c> when no constructed base contributes a substitution.
    /// </summary>
    private static IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> BuildBaseTypeArgumentSubstitution(StructSymbol derived)
    {
        Dictionary<TypeParameterSymbol, TypeSymbol> subst = null;
        for (var b = derived?.BaseClass; b != null; b = b.BaseClass)
        {
            if (b.Definition == null || b.TypeArguments.IsDefaultOrEmpty)
            {
                continue;
            }

            var defParams = b.Definition.TypeParameters;
            if (defParams.IsDefaultOrEmpty)
            {
                continue;
            }

            var count = System.Math.Min(defParams.Length, b.TypeArguments.Length);
            for (var i = 0; i < count; i++)
            {
                var arg = b.TypeArguments[i];

                // A deeper base's type argument may itself be a type parameter of
                // a shallower (already-processed) base; resolve it transitively so
                // the map always lands on the concrete type in the derived context.
                if (arg is TypeParameterSymbol tpArg && subst != null && subst.TryGetValue(tpArg, out var resolved))
                {
                    arg = resolved;
                }

                subst ??= new Dictionary<TypeParameterSymbol, TypeSymbol>();
                subst[defParams[i]] = arg;
            }
        }

        return subst;
    }

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

    /// <summary>
    /// Issue #1007: signature matching for interface satisfaction / override
    /// resolution, with optional support for generic methods. When the base
    /// (interface) method and the derived (implementing) method are both
    /// generic with the same arity, <paramref name="typeParamMap"/> maps the
    /// base method's type-parameter symbols onto the derived method's so that
    /// the plain type-parameter references in the parameter / return types
    /// compare equal positionally (the interface's <c>T</c> carries a distinct
    /// <see cref="TypeParameterSymbol"/> instance from the class's <c>T</c>).
    /// </summary>
    private static bool SignaturesMatch(
        FunctionSymbol baseMethod,
        ImmutableArray<ParameterSymbol> derivedParams,
        TypeSymbol derivedReturnType,
        RefKind derivedReturnRefKind,
        IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> typeParamMap,
        bool derivedIsAsync)
    {
        if (!ReturnTypesMatch(baseMethod, derivedReturnType, derivedIsAsync, typeParamMap))
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
            if (!TypeSignaturesEquivalent(baseParams[i].Type, derivedParams[i].Type, typeParamMap))
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
    /// Issue #1071: compares the base / interface method's declared return type
    /// against the derived (overriding / implementing) method's <em>effective</em>
    /// return type, normalizing for <c>async</c>. An <c>async func</c> with no
    /// annotation has effective return type <c>Task</c>; <c>async func ... T</c>
    /// has effective return type <c>Task[T]</c>. When exactly one of the two
    /// methods is async, the non-async side's declared <c>Task</c> / <c>Task[T]</c>
    /// is unwrapped to its awaited result and compared against the async side's
    /// declared (awaited) return type; otherwise the declared types are compared
    /// directly. Genuine return-type mismatches (e.g. an async <c>Task</c> method
    /// against a base declaring <c>Task[int32]</c>) are still rejected.
    /// </summary>
    private static bool ReturnTypesMatch(
        FunctionSymbol baseMethod,
        TypeSymbol derivedReturnType,
        bool derivedIsAsync,
        IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> typeParamMap)
    {
        var baseIsAsync = baseMethod.IsAsync;
        if (baseIsAsync == derivedIsAsync)
        {
            return TypeSignaturesEquivalent(baseMethod.Type, derivedReturnType, typeParamMap);
        }

        if (derivedIsAsync)
        {
            // Derived is async (declared = awaited result); the base must declare
            // the matching Task / Task[T] wrapper.
            return AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(baseMethod.Type, out var baseAwaited)
                && TypeSignaturesEquivalent(baseAwaited, derivedReturnType, typeParamMap);
        }

        // Base is async (declared = awaited result); the derived (non-async)
        // method must declare the matching Task / Task[T] wrapper.
        return AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(derivedReturnType, out var derivedAwaited)
            && TypeSignaturesEquivalent(baseMethod.Type, derivedAwaited, typeParamMap);
    }

    /// <summary>
    /// Issue #1007: builds the positional map from a generic interface
    /// method's type-parameter symbols onto a candidate implementing method's
    /// type-parameter symbols. Returns <c>null</c> when the candidate is not a
    /// viable generic match (mismatched arity) so the caller treats it as no
    /// match; returns an empty map when neither method is generic.
    /// </summary>
    private static IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> TryBuildMethodTypeParameterMap(
        FunctionSymbol baseMethod,
        FunctionSymbol candidate)
    {
        var baseTps = baseMethod.TypeParameters;
        var candTps = candidate.TypeParameters;
        var baseArity = baseTps.IsDefaultOrEmpty ? 0 : baseTps.Length;
        var candArity = candTps.IsDefaultOrEmpty ? 0 : candTps.Length;
        if (baseArity != candArity)
        {
            return null;
        }

        if (baseArity == 0)
        {
            return System.Collections.Immutable.ImmutableDictionary<TypeParameterSymbol, TypeSymbol>.Empty;
        }

        var map = new Dictionary<TypeParameterSymbol, TypeSymbol>();
        for (var i = 0; i < baseArity; i++)
        {
            map[baseTps[i]] = candTps[i];
        }

        return map;
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
        if (!TypeSignaturesEquivalent(baseMethod.Type, derivedReturnType))
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
            if (!TypeSignaturesEquivalent(baseParams[i].Type, derivedParams[i].Type))
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
    /// Issue #974: structural equivalence used by override / interface-
    /// implementation signature matching. Constructed generic types are not
    /// interned (<see cref="ImportedTypeSymbol.GetConstructed"/> and
    /// <see cref="InterfaceSymbol.Construct"/> can yield fresh instances), so a
    /// raw reference comparison wrongly rejects, for example, the class method
    /// <c>func Iter() IEnumerator[T]</c> against the interface requirement
    /// <c>ISeq[T].Iter() IEnumerator[T]</c> once the interface's type
    /// parameters have been substituted with the implementing type's
    /// arguments. Reference identity is honoured first (covering plain type
    /// parameters, primitives and cached imported types); constructed generics
    /// are then compared by definition and ordered type arguments, recursing
    /// through slice / array / nullable wrappers. The comparison stays strict —
    /// distinct type arguments (e.g. <c>IEnumerator[int32]</c> vs
    /// <c>IEnumerator[T]</c>) are not equated — so genuinely mismatched
    /// signatures are still rejected with GS0187.
    /// </summary>
    internal static bool TypeSignaturesEquivalent(TypeSymbol a, TypeSymbol b)
        => TypeSignaturesEquivalent(a, b, typeParamMap: null);

    private static bool TypeSignaturesEquivalent(
        TypeSymbol a,
        TypeSymbol b,
        IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> typeParamMap)
    {
        // Issue #1007: substitute a generic interface method's type parameter
        // with the implementing method's positionally-corresponding type
        // parameter before comparing, so `T_iface` and `T_class` match.
        if (typeParamMap != null && a is TypeParameterSymbol tpa && typeParamMap.TryGetValue(tpa, out var mappedA))
        {
            a = mappedA;
        }

        if (ReferenceEquals(a, b))
        {
            return true;
        }

        if (a == null || b == null)
        {
            return false;
        }

        if (a is StructSymbol sa && b is StructSymbol sb)
        {
            return ReferenceEquals(sa.Definition, sb.Definition)
                && TypeArgumentsEquivalent(sa.TypeArguments, sb.TypeArguments, typeParamMap);
        }

        if (a is InterfaceSymbol ia && b is InterfaceSymbol ib)
        {
            return ReferenceEquals(ia.Definition, ib.Definition)
                && TypeArgumentsEquivalent(ia.TypeArguments, ib.TypeArguments, typeParamMap);
        }

        if (a is ImportedTypeSymbol pa && b is ImportedTypeSymbol pb)
        {
            // Constructed imported generics carrying symbolic arguments (e.g.
            // `IEnumerator[T]`) are compared by open definition and ordered
            // arguments so an unbound type parameter compares by identity
            // rather than by its erased `object` CLR projection.
            if (pa.OpenDefinition != null
                && pb.OpenDefinition != null
                && pa.OpenDefinition == pb.OpenDefinition
                && TypeArgumentsEquivalent(pa.TypeArguments, pb.TypeArguments, typeParamMap))
            {
                return true;
            }

            // Otherwise (one or both sides expressed as a plain closed CLR
            // type, e.g. a fully concrete `IEnumerator[int32]`) fall back to a
            // closed-type comparison. This is only sound when neither side
            // carries an unbound type parameter, whose CLR shape is erased to
            // `object` and would otherwise equate distinct constructions.
            if (!TypeSymbol.ContainsTypeParameter(pa) && !TypeSymbol.ContainsTypeParameter(pb))
            {
                return pa.ClrType != null
                    && pb.ClrType != null
                    && ClrTypeUtilities.AreSame(pa.ClrType, pb.ClrType);
            }

            return false;
        }

        if (a is SliceTypeSymbol sla && b is SliceTypeSymbol slb)
        {
            return TypeSignaturesEquivalent(sla.ElementType, slb.ElementType, typeParamMap);
        }

        if (a is ArrayTypeSymbol ara && b is ArrayTypeSymbol arb)
        {
            return ara.Length == arb.Length
                && TypeSignaturesEquivalent(ara.ElementType, arb.ElementType, typeParamMap);
        }

        if (a is NullableTypeSymbol na && b is NullableTypeSymbol nb)
        {
            return TypeSignaturesEquivalent(na.UnderlyingType, nb.UnderlyingType, typeParamMap);
        }

        // Leaf fallback for non-generic types that are not reference-interned
        // (e.g. a primitive supplied as a concrete type argument such as the
        // `int32` in `ISeq[int32]`). Type parameters keep an absent ClrType so
        // distinct parameters are never wrongly equated here.
        return a.ClrType != null && b.ClrType != null && a.ClrType == b.ClrType;
    }

    private static bool TypeArgumentsEquivalent(ImmutableArray<TypeSymbol> a, ImmutableArray<TypeSymbol> b)
        => TypeArgumentsEquivalent(a, b, typeParamMap: null);

    private static bool TypeArgumentsEquivalent(
        ImmutableArray<TypeSymbol> a,
        ImmutableArray<TypeSymbol> b,
        IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> typeParamMap)
    {
        if (a.IsDefaultOrEmpty && b.IsDefaultOrEmpty)
        {
            return true;
        }

        if (a.IsDefaultOrEmpty || b.IsDefaultOrEmpty || a.Length != b.Length)
        {
            return false;
        }

        for (var i = 0; i < a.Length; i++)
        {
            if (!TypeSignaturesEquivalent(a[i], b[i], typeParamMap))
            {
                return false;
            }
        }

        return true;
    }

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

        // Issue #1085: defer the actual argument binding and base-constructor
        // resolution until all declared types' explicit constructors exist.
        var capturedScope = scope;
        pendingBaseInitializerBindings.Add(() =>
        {
            var outerScope = scope;
            scope = capturedScope;
            try
            {
                BindBaseConstructorInitializerCore(syntax, structSymbol, baseClassSymbol, importedBaseType, primaryCtorParameters);
            }
            finally
            {
                scope = outerScope;
            }
        });
    }

    private void BindBaseConstructorInitializerCore(
        StructDeclarationSyntax syntax,
        StructSymbol structSymbol,
        StructSymbol baseClassSymbol,
        TypeSymbol importedBaseType,
        ImmutableArray<ParameterSymbol> primaryCtorParameters)
    {
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

    /// <summary>Resolves a base-constructor initializer against a GSharp base class's constructors (issue #306). Returns <c>null</c> (after reporting a diagnostic) when no match.</summary>
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

        // Issue #1060: when the base class declares explicit `init(...)`
        // constructors, the `: base(args)` initializer must resolve against the
        // full overload set — every explicit init plus (when present) the
        // synthesized primary-constructor designated init — selecting the best
        // overload by argument types, mirroring C# where a derived constructor
        // may chain to any accessible base constructor. The primary-only fast
        // path below covers classes that declare no explicit init bodies.
        // Issue #1087: a constructed generic base (e.g. `Base[int32]`) does not
        // carry its own explicit-constructor table — consult the open
        // definition's via EffectiveExplicitConstructors.
        if (!baseClassSymbol.EffectiveExplicitConstructors.IsDefaultOrEmpty)
        {
            return ResolveGSharpExplicitBaseConstructor(argLocation, baseClassSymbol, boundArguments, location);
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
    /// Issue #1060: resolves a <c>: base(args)</c> initializer against the explicit
    /// <c>init(...)</c> constructors declared on a GSharp base class (which already
    /// includes the synthesized primary-constructor designated init when present),
    /// selecting the best overload by argument types. Returns <c>null</c> (after
    /// reporting a diagnostic) when no accessible base constructor matches.
    /// </summary>
    private BaseConstructorInitializer ResolveGSharpExplicitBaseConstructor(
        System.Func<int, TextLocation> argLocation,
        StructSymbol baseClassSymbol,
        ImmutableArray<BoundExpression>.Builder boundArguments,
        TextLocation location)
    {
        ConstructorSymbol best = null;
        ImmutableArray<TypeSymbol> bestParamTypes = default;
        var bestExactMatches = -1;
        var ambiguous = false;
        var anyArgIsError = false;

        foreach (var arg in boundArguments)
        {
            if (arg.Type == TypeSymbol.Error)
            {
                anyArgIsError = true;
            }
        }

        // Issue #1087: iterate the effective explicit-constructor set (the open
        // definition's, for a constructed generic base) and compare against each
        // candidate's type-argument-substituted parameter signature so that a
        // generic base ctor such as `init(a T)` matches `: base(value)` on a
        // constructed `Base[int32]`.
        foreach (var candidate in baseClassSymbol.EffectiveExplicitConstructors)
        {
            var paramTypes = baseClassSymbol.GetConstructorParameterTypesForConstruction(candidate);
            if (paramTypes.Length != boundArguments.Count)
            {
                continue;
            }

            var applicable = true;
            var exactMatches = 0;
            for (var i = 0; i < paramTypes.Length; i++)
            {
                var argType = boundArguments[i].Type;
                var paramType = paramTypes[i];
                if (argType == paramType)
                {
                    exactMatches++;
                    continue;
                }

                // Error-typed arguments don't disqualify a candidate: a prior
                // diagnostic already explains the bad argument.
                if (argType == TypeSymbol.Error)
                {
                    continue;
                }

                if (!Conversion.Classify(argType, paramType).IsImplicit)
                {
                    applicable = false;
                    break;
                }
            }

            if (!applicable)
            {
                continue;
            }

            if (exactMatches > bestExactMatches)
            {
                best = candidate;
                bestParamTypes = paramTypes;
                bestExactMatches = exactMatches;
                ambiguous = false;
            }
            else if (exactMatches == bestExactMatches)
            {
                ambiguous = true;
            }
        }

        if (best == null || ambiguous)
        {
            // Suppress the GS0214 cascade when an argument already failed to
            // bind (an error type was produced upstream).
            if (!anyArgIsError)
            {
                Diagnostics.ReportNoMatchingBaseConstructor(location, baseClassSymbol.Name, boundArguments.Count);
            }

            return null;
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(boundArguments.Count);
        for (var i = 0; i < boundArguments.Count; i++)
        {
            convertedArgs.Add(conversions.BindConversion(argLocation(i), boundArguments[i], bestParamTypes[i]));
        }

        return new BaseConstructorInitializer(convertedArgs.ToImmutable(), baseClassSymbol, best);
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
            // Issue #1085: base-initializer resolution is deferred, so detect the
            // `: base(...)` presence from syntax rather than the (not-yet-set)
            // resolved BaseInitializer symbol.
            if (ctor.IsConvenience && ctorSyntax.HasBaseInitializer)
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
        //
        // Issue #1085: the argument expressions may construct other user types
        // whose explicit constructors are not yet populated when this type body
        // is bound (the constructed type may live in a source file processed
        // later). Defer the argument binding and base-constructor resolution to
        // a post-pass that runs after every declared type's constructors exist.
        if (ctorSyntax.HasBaseInitializer)
        {
            var capturedScope = scope;
            pendingBaseInitializerBindings.Add(() =>
            {
                var outerScope = scope;
                scope = capturedScope;
                try
                {
                    BindConstructorBaseInitializerCore(ctorSyntax, constructorSymbol, ctorFunction, structSymbol, baseClassSymbol, importedBaseType);
                }
                finally
                {
                    scope = outerScope;
                }
            });
        }

        return constructorSymbol;
    }

    private void BindConstructorBaseInitializerCore(
        ConstructorDeclarationSyntax ctorSyntax,
        ConstructorSymbol constructorSymbol,
        FunctionSymbol ctorFunction,
        StructSymbol structSymbol,
        StructSymbol baseClassSymbol,
        TypeSymbol importedBaseType)
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
