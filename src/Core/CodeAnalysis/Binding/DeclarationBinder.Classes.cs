// <copyright file="DeclarationBinder.Classes.cs" company="GSharp">
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
    }private void BindStructDeclarationBodyCore( StructDeclarationSyntax syntax, PackageSymbol package, StructSymbol structSymbol)
{ using var unsafeContext = binderCtx.PushUnsafeContext(syntax.IsUnsafe); var name = structSymbol.Name; var accessibility = structSymbol.Accessibility;
var seenFieldNames = new HashSet<string>(); var fields = ImmutableArray.CreateBuilder<FieldSymbol>(); ValidateProtectedMemberPlacement(syntax); var primaryCtorParameters = ImmutableArray<ParameterSymbol>.Empty;
if (syntax.HasPrimaryConstructor) { var ctorBuilder = ImmutableArray.CreateBuilder<ParameterSymbol>(); foreach (var paramSyntax in syntax.PrimaryConstructorParameters)
{ var paramName = paramSyntax.Identifier.Text; var paramType = bindTypeClause(paramSyntax.Type); if (paramType == null)
{ continue; } var isVariadic = paramSyntax.IsVariadic;
if (isVariadic && paramType != TypeSymbol.Error) { paramType = SliceTypeSymbol.Get(paramType); }
if (!seenFieldNames.Add(paramName)) { Diagnostics.ReportSymbolAlreadyDeclared(paramSyntax.Identifier.Location, paramName); continue;
} if (!syntax.IsRef && TypeSymbol.IsByRefLike(paramType)) { Diagnostics.ReportByRefLikeEscape(paramSyntax.Identifier.Location, paramType, $"be used as the type of field '{paramName}'");
continue; } if (paramType is ByRefTypeSymbol byRefParamType) {
Diagnostics.ReportPointerTypeCannotBeFieldType(paramSyntax.Identifier.Location, byRefParamType.Name); continue; } if (paramSyntax.HasRefKindModifier)
{ Diagnostics.ReportRefKindOnPrimaryCtorParameter(paramSyntax.RefKindModifier.Location, paramName); } var primaryCtorParam = new ParameterSymbol(paramName, paramType, isVariadic, declaringSyntax: paramSyntax.Identifier, isScoped: paramSyntax.IsScoped);
conversions.BindAndAttachParameterDefaultValue(paramSyntax, primaryCtorParam); ctorBuilder.Add(primaryCtorParam); fields.Add(new FieldSymbol(paramName, paramType, Accessibility.Public, isReadOnly: syntax.IsInline)); }
ValidateVariadicParameterShape(syntax.PrimaryConstructorParameters); primaryCtorParameters = ctorBuilder.ToImmutable(); } var pendingInstanceInitializers = new List<(FieldSymbol Field, ExpressionSyntax InitSyntax, TypeSymbol FieldType)>();
var constFieldsBuilder = ImmutableArray.CreateBuilder<FieldSymbol>(); var pendingConstInitializers = new List<(FieldSymbol Field, FieldDeclarationSyntax Syntax, TypeSymbol FieldType)>(); var pendingStaticFieldInitializers = new List<(FieldSymbol Field, ExpressionSyntax InitSyntax, TypeSymbol FieldType)>(); var pendingSharedConstInitializers = new List<(FieldSymbol Field, FieldDeclarationSyntax Syntax, TypeSymbol FieldType)>();
foreach (var fieldSyntax in syntax.Fields) { var fieldName = fieldSyntax.Identifier.Text; if (!seenFieldNames.Add(fieldName))
{ Diagnostics.ReportSymbolAlreadyDeclared(fieldSyntax.Identifier.Location, fieldName); continue; }
var fieldType = bindTypeClause(fieldSyntax.Type); if (fieldType == null) { continue;
} if (!syntax.IsRef && TypeSymbol.IsByRefLike(fieldType)) { Diagnostics.ReportByRefLikeEscape(fieldSyntax.Identifier.Location, fieldType, $"be used as the type of field '{fieldName}'");
continue; } if (fieldType is ByRefTypeSymbol byRefFieldType) {
Diagnostics.ReportPointerTypeCannotBeFieldType(fieldSyntax.Identifier.Location, byRefFieldType.Name); continue; } var fieldAccessibility = resolveAccessibility(fieldSyntax.AccessibilityModifier);
if (fieldSyntax.IsFixedBuffer) { if (!binderCtx.InUnsafeContext) {
Diagnostics.ReportFixedBufferRequiresUnsafeContext(fieldSyntax.FixedKeyword.Location); continue; } if (fieldType is not ArrayTypeSymbol fbArray)
{ Diagnostics.ReportFixedBufferInvalidShape(fieldSyntax.Identifier.Location, fieldName); continue; }
var fbElement = fbArray.ElementType; var fbLength = fbArray.Length; if (fbLength <= 0) {
Diagnostics.ReportFixedBufferInvalidLength(fieldSyntax.Identifier.Location, fieldName, fbLength); continue; } if (!TryGetFixedBufferElementSize(fbElement, out var fbElemSize))
{ Diagnostics.ReportFixedBufferElementTypeNotSupported(fieldSyntax.Identifier.Location, fbElement.Name); continue; }
var fbBacking = SynthesizeFixedBufferBackingStruct(structSymbol, fieldName, fbElement, fbLength, fbElemSize, package); var fbFieldSymbol = new FieldSymbol(fieldName, fbBacking, fieldAccessibility, isReadOnly: false); fbFieldSymbol.SetFixedBuffer(fbElement, fbLength); Binder.AttachDocumentation(fbFieldSymbol, fieldSyntax);
fields.Add(fbFieldSymbol); continue; } if (fieldSyntax.IsConst)
{ var constFieldSymbol = new FieldSymbol(fieldName, fieldType, fieldAccessibility, isReadOnly: true, isStatic: true, isConst: true); Binder.AttachDocumentation(constFieldSymbol, fieldSyntax); if (!fieldSyntax.Annotations.IsDefaultOrEmpty)
{ constFieldSymbol.SetAttributes(BindAttributes( fieldSyntax.Annotations, AttributeTargetKind.Field,
Binder.FieldDeclarationAllowedTargets, "a field declaration", System.AttributeTargets.Field)); }
if (fieldSyntax.Initializer == null) { Diagnostics.ReportConstFieldRequiresInitializer(fieldSyntax.Identifier.Location, fieldName); }
else { pendingConstInitializers.Add((constFieldSymbol, fieldSyntax, fieldType)); }
constFieldsBuilder.Add(constFieldSymbol); continue; } var fieldSymbol = new FieldSymbol(fieldName, fieldType, fieldAccessibility, isReadOnly: syntax.IsInline || fieldSyntax.IsReadOnly);
Binder.AttachDocumentation(fieldSymbol, fieldSyntax); if (!fieldSyntax.Annotations.IsDefaultOrEmpty) { fieldSymbol.SetAttributes(BindAttributes(
fieldSyntax.Annotations, AttributeTargetKind.Field, Binder.FieldDeclarationAllowedTargets, "a field declaration",
System.AttributeTargets.Field)); } if (fieldSyntax.Initializer != null) {
pendingInstanceInitializers.Add((fieldSymbol, fieldSyntax.Initializer, fieldType)); } fields.Add(fieldSymbol); }
if (syntax.IsData && fields.Count == 0) { Diagnostics.ReportEmptyDataStruct(syntax.Identifier.Location, name); }
if (syntax.IsInline) { if (syntax.IsData) {
Diagnostics.ReportInlineCannotBeCombinedWithData(syntax.InlineKeyword.Location); } if (syntax.IsOpen) {
Diagnostics.ReportInlineCannotBeCombinedWithOpen(syntax.OpenModifier.Location); } if (fields.Count != 1) {
Diagnostics.ReportInlineStructRequiresExactlyOneField(syntax.Identifier.Location, name, fields.Count); } } var hasAttributeSugar = HasAttributeSugarMarker(syntax.Annotations);
structSymbol.SetInstanceFieldsAndPrimaryConstructorParameters( fields.ToImmutable(), primaryCtorParameters); StructSymbol baseClassSymbol = null;
TypeSymbol importedBaseType = null; var implementedInterfaces = ImmutableArray.CreateBuilder<InterfaceSymbol>(); var implementedClrInterfaces = ImmutableArray.CreateBuilder<TypeSymbol>(); if (syntax.HasBaseType)
{ { var allBaseTypes = ImmutableArray.CreateBuilder<TypeClauseSyntax>(); if (syntax.BaseTypeClauses.Count > 0)
{ for (var bi = 0; bi < syntax.BaseTypeClauses.Count; bi++) { allBaseTypes.Add(syntax.BaseTypeClauses[bi]);
} } if (allBaseTypes.Count == 0 && syntax.BaseTypeIdentifier != null) {
allBaseTypes.Add(new TypeClauseSyntax(syntax.SyntaxTree, syntax.BaseTypeIdentifier)); if (!syntax.AdditionalBaseTypeIdentifiers.IsDefaultOrEmpty) { foreach (var token in syntax.AdditionalBaseTypeIdentifiers)
{ if (token != null) { allBaseTypes.Add(new TypeClauseSyntax(syntax.SyntaxTree, token));
} } } }
for (var i = 0; i < allBaseTypes.Count; i++) { var baseTypeSyntax = allBaseTypes[i]; var baseName = GetBaseClauseTypeDisplayName(baseTypeSyntax);
var baseLocation = baseTypeSyntax.Identifier?.Location ?? syntax.Identifier.Location; if (hasAttributeSugar && i == 0 && !baseTypeSyntax.HasTypeArguments && (baseName == "Attribute" || baseName == "System.Attribute"))
{ continue; } var resolved = bindTypeClause(baseTypeSyntax);
if (resolved == null || resolved == TypeSymbol.Error) { continue; }
if (!syntax.IsClass) { var resolvedIsInterface = resolved is InterfaceSymbol || (resolved.ClrType != null && resolved.ClrType.IsInterface);
if (!resolvedIsInterface) { Diagnostics.ReportStructCannotHaveBaseClass(baseLocation, name, baseName); continue;
} } if (resolved is InterfaceSymbol iface) {
if (iface.IsGenericDefinition) { Diagnostics.ReportWrongTypeArgumentCount(baseLocation, baseName, iface.TypeParameters.Length, 0); continue;
} implementedInterfaces.Add(iface); continue; }
if (resolved is StructSymbol baseStruct && baseStruct.IsClass) { if (baseStruct == structSymbol || baseStruct.Definition == structSymbol) {
Diagnostics.ReportClassInheritsFromItself(baseLocation, name); continue; } if (baseStruct.IsGenericDefinition)
{ Diagnostics.ReportWrongTypeArgumentCount(baseLocation, baseName, baseStruct.TypeParameters.Length, 0); continue; }
if (i != 0) { Diagnostics.ReportUnableToFindType(baseLocation, baseName); continue;
} if (hasAttributeSugar) { Diagnostics.ReportAttributeClassExplicitBase(baseLocation, baseName);
continue; } if (!baseStruct.IsOpen && !baseStruct.IsSealedHierarchy) {
Diagnostics.ReportBaseClassNotOpen(baseLocation, baseName); continue; } baseClassSymbol = baseStruct;
continue; } if (resolved.ClrType != null) {
var clrType = resolved.ClrType; if (clrType.IsGenericTypeDefinition) { Diagnostics.ReportWrongTypeArgumentCount(
baseLocation, baseName, clrType.GetGenericArguments().Length, 0);
continue; } if (clrType.IsInterface) {
implementedClrInterfaces.Add(resolved); continue; } if (clrType.IsClass && !clrType.IsSealed)
{ if (i != 0) { Diagnostics.ReportUnableToFindType(baseLocation, baseName);
continue; } if (hasAttributeSugar) {
Diagnostics.ReportAttributeClassExplicitBase(baseLocation, baseName); continue; } importedBaseType = resolved;
continue; } } Diagnostics.ReportUnableToFindType(baseLocation, baseName);
} } } structSymbol.SetBaseClass(baseClassSymbol);
structSymbol.SetAttributes(BindAttributes( syntax.Annotations, AttributeTargetKind.Type, Binder.TypeDeclarationAllowedTargets,
syntax.IsClass ? "a class declaration" : "a struct declaration", syntax.IsClass ? System.AttributeTargets.Class : System.AttributeTargets.Struct)); StructLayoutBinder.ResolveLayoutAndFieldOffsets(structSymbol, Diagnostics); if (hasAttributeSugar && syntax.IsClass)
{ structSymbol.SetIsAttributeClass(); } if (importedBaseType != null)
{ structSymbol.SetImportedBaseType(importedBaseType); } BindBaseConstructorInitializer(syntax, structSymbol, baseClassSymbol, importedBaseType, primaryCtorParameters);
if (constFieldsBuilder.Count > 0) { structSymbol.SetConstFields(constFieldsBuilder.ToImmutable()); }
var existingNames = new HashSet<string>(); foreach (var f in structSymbol.Fields) { existingNames.Add(f.Name);
} var pendingConversionOperators = new List<(FunctionDeclarationSyntax Syntax, ImmutableArray<ParameterSymbol> Parameters, TypeSymbol ReturnType, Accessibility Accessibility, ImmutableArray<BoundAttribute> Attributes)>(); if (!syntax.Methods.IsDefaultOrEmpty) {
var methodsBuilder = ImmutableArray.CreateBuilder<FunctionSymbol>(); foreach (var methodSyntax in syntax.Methods) { var methodName = methodSyntax.Identifier.Text;
if (structSymbol.IsInline && IsInlineSynthesizedMemberName(methodName)) { Diagnostics.ReportInlineStructSynthesizedMemberConflict(methodSyntax.Identifier.Location, structSymbol.Name, methodName); continue;
} if (structSymbol.IsData && IsDataStructSynthesizedMemberName(methodName)) { Diagnostics.ReportDataStructSynthesizedMemberConflict(methodSyntax.Identifier.Location, structSymbol.Name, methodName);
continue; } if (structSymbol.TryGetField(methodName, out _)) {
Diagnostics.ReportSymbolAlreadyDeclared(methodSyntax.Identifier.Location, methodName); continue; } var methodTypeParameters = BindTypeParameterList(methodSyntax.TypeParameterList);
var enclosingTypeParameters = binderCtx.CurrentTypeParameters; if (!methodTypeParameters.IsDefaultOrEmpty) { binderCtx.CurrentTypeParameters = enclosingTypeParameters == null
? new Dictionary<string, TypeParameterSymbol>() : new Dictionary<string, TypeParameterSymbol>(enclosingTypeParameters); foreach (var tp in methodTypeParameters) {
binderCtx.CurrentTypeParameters[tp.Name] = tp; } } try
{ using var sigUnsafeContext = binderCtx.PushUnsafeContext(methodSyntax.IsUnsafe); var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>(); var seenParameterNames = new HashSet<string>();
for (var pIndex = 0; pIndex < methodSyntax.Parameters.Count; pIndex++) { var parameterSyntax = methodSyntax.Parameters[pIndex]; var parameterName = parameterSyntax.Identifier.Text;
var parameterType = bindTypeClause(parameterSyntax.Type) ?? TypeSymbol.Error; var isVariadic = parameterSyntax.IsVariadic; if (isVariadic && parameterType != TypeSymbol.Error) {
parameterType = SliceTypeSymbol.Get(parameterType); } var parameterRefKind = conversions.BindAndValidateParameterRefKind( parameterSyntax,
parameterName, parameterType, isVariadic, asyncOrIteratorKind: methodSyntax.IsAsync ? "async" : null);
if (parameterName != "_" && !seenParameterNames.Add(parameterName)) { Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName); }
else { var classMethodParam = new ParameterSymbol(parameterName, parameterType, isVariadic, declaringSyntax: parameterSyntax.Identifier, isScoped: parameterSyntax.IsScoped, refKind: parameterRefKind); conversions.BindAndAttachParameterDefaultValue(parameterSyntax, classMethodParam);
parameters.Add(classMethodParam); } } ValidateVariadicParameterShape(methodSyntax.Parameters);
var returnType = bindReturnTypeClause(methodSyntax.Type, methodSyntax.IsAsync) ?? TypeSymbol.Void; var methodAccessibility = resolveAccessibility(methodSyntax.AccessibilityModifier); var methodParameters = parameters.ToImmutable(); var methodReturnRefKind = ValidateReturnRefKind(methodSyntax, returnType);
if (methodSyntax.IsConversionOperator) { var conversionAttributes = ImmutableArray<BoundAttribute>.Empty; if (!methodSyntax.Annotations.IsDefaultOrEmpty)
{ conversionAttributes = BindAttributes( methodSyntax.Annotations, AttributeTargetKind.Method,
Binder.FunctionDeclarationAllowedTargets, "a method declaration", System.AttributeTargets.Method); }
pendingConversionOperators.Add((methodSyntax, methodParameters, returnType, methodAccessibility, conversionAttributes)); continue; } var methodIsAsync = methodSyntax.IsAsync || isAsyncIteratorReturnType(returnType);
FunctionSymbol overriddenMethod = null; if (methodSyntax.IsOverride) { var baseOverloads = structSymbol.BaseClass?.GetMethodsIncludingInherited(methodName)
?? System.Collections.Immutable.ImmutableArray<FunctionSymbol>.Empty; var baseTypeArgSubst = BuildBaseTypeArgumentSubstitution(structSymbol); FunctionSymbol baseMethod = null; FunctionSymbol baseSignatureMatch = null;
foreach (var candidate in baseOverloads) { baseMethod ??= candidate; if (SignaturesMatch(candidate, methodParameters, returnType, methodReturnRefKind, baseTypeArgSubst, methodIsAsync))
{ baseSignatureMatch = candidate; break; }
} if (baseMethod == null) { Diagnostics.ReportNoBaseMethodToOverride(methodSyntax.Identifier.Location, methodName);
} else if (baseSignatureMatch != null) { if (!baseSignatureMatch.IsOpen)
{ Diagnostics.ReportOverrideOfSealedMethod(methodSyntax.Identifier.Location, methodName); } else
{ overriddenMethod = baseSignatureMatch; } }
else if (!baseMethod.IsOpen) { Diagnostics.ReportOverrideOfSealedMethod(methodSyntax.Identifier.Location, methodName); }
else { if (baseMethod.Type == returnType && baseMethod.ReturnRefKind != methodReturnRefKind) {
Diagnostics.ReportOverrideReturnRefKindMismatch( methodSyntax.Identifier.Location, methodName, baseMethod.ReturnRefKind == RefKind.Ref ? "by ref" : "by value",
methodReturnRefKind == RefKind.Ref ? "by ref" : "by value"); } else {
var refMismatchIdx = FindRefKindMismatchIndex(baseMethod, methodParameters, returnType); if (refMismatchIdx >= 0) { var baseCallable = GetCallableParameters(baseMethod);
Diagnostics.ReportOverrideRefKindMismatch( methodSyntax.Identifier.Location, methodName, methodParameters[refMismatchIdx].Name,
refKindToString(baseCallable[refMismatchIdx].RefKind), refKindToString(methodParameters[refMismatchIdx].RefKind)); } else
{ Diagnostics.ReportOverrideSignatureMismatch(methodSyntax.Identifier.Location, methodName); } }
} } else if (structSymbol.BaseClass != null) {
var baseOverloads = structSymbol.BaseClass.GetMethodsIncludingInherited(methodName); var baseTypeArgSubst = BuildBaseTypeArgumentSubstitution(structSymbol); foreach (var shadowed in baseOverloads) {
if (!shadowed.IsOpen) { continue; }
if (SignaturesMatch(shadowed, methodParameters, returnType, methodReturnRefKind, baseTypeArgSubst, methodIsAsync)) { Diagnostics.ReportMissingOverride(methodSyntax.Identifier.Location, shadowed.ReceiverType.Name, methodName); break;
} } } var methodSymbol = new FunctionSymbol(
methodName, methodParameters, returnType, methodSyntax,
package, methodAccessibility, receiverType: structSymbol, isOpen: methodSyntax.IsOpen,
isOverride: methodSyntax.IsOverride); methodSymbol.OverriddenMethod = overriddenMethod; methodSymbol.TypeParameters = methodTypeParameters; methodSymbol.ReturnRefKind = methodReturnRefKind;
methodSymbol.IsAsync = methodSyntax.IsAsync || isAsyncIteratorReturnType(returnType); methodSymbol.IsUnsafe = methodSyntax.IsUnsafe || syntax.IsUnsafe; if (methodSyntax.HasSemicolonBody) {
methodSymbol.IsAbstract = true; if (!methodSyntax.IsOpen || !structSymbol.IsOpen) { Diagnostics.ReportAbstractMethodRequiresOpenClass(
methodSyntax.Identifier.Location, methodName, structSymbol.Name); }
} Binder.AttachDocumentation(methodSymbol, methodSyntax); if (!methodSyntax.Annotations.IsDefaultOrEmpty) {
var methodAttributes = BindAttributes( methodSyntax.Annotations, AttributeTargetKind.Method, Binder.FunctionDeclarationAllowedTargets,
"a method declaration", System.AttributeTargets.Method); methodSymbol.SetAttributes(methodAttributes); ValidateInlineDataNilArguments(methodAttributes, methodSymbol.Parameters);
} var hasDuplicateSig = false; foreach (var existingMethod in methodsBuilder) {
if (BoundScope.FunctionSignaturesEqual(existingMethod, methodSymbol)) { if (MemberLookup.TryResolveCovariantInterfaceBridge( implementedClrInterfaces.ToImmutable(),
existingMethod, methodSymbol, out var bridgeMethod, out var bridgeSlot))
{ bridgeMethod.ExplicitInterfaceSlot = bridgeSlot; continue; }
Diagnostics.ReportDuplicateOverloadSignature( methodSyntax.Identifier.Location, methodName, Binder.FormatOverloadSignature(methodSymbol));
hasDuplicateSig = true; break; } }
if (!hasDuplicateSig) { methodsBuilder.Add(methodSymbol); }
} finally { binderCtx.CurrentTypeParameters = enclosingTypeParameters;
} } structSymbol.SetMethods(methodsBuilder.ToImmutable()); }
if (!syntax.Properties.IsDefaultOrEmpty) { var propertiesBuilder = ImmutableArray.CreateBuilder<PropertySymbol>(); foreach (var propSyntax in syntax.Properties)
{ var isIndexer = propSyntax.IsIndexer; var indexerParameters = ImmutableArray<ParameterSymbol>.Empty; if (isIndexer)
{ if (propSyntax.Parameters.Count == 0) { Diagnostics.ReportIndexerRequiresParameter(propSyntax.ThisKeyword.Location);
continue; } var indexerParamBuilder = ImmutableArray.CreateBuilder<ParameterSymbol>(); var seenIndexParamNames = new HashSet<string>();
foreach (var indexParamSyntax in propSyntax.Parameters) { var indexParamName = indexParamSyntax.Identifier.Text; var indexParamType = bindTypeClause(indexParamSyntax.Type) ?? TypeSymbol.Error;
if (!seenIndexParamNames.Add(indexParamName)) { Diagnostics.ReportParameterAlreadyDeclared(indexParamSyntax.Location, indexParamName); }
indexerParamBuilder.Add(new ParameterSymbol(indexParamName, indexParamType, declaringSyntax: indexParamSyntax.Identifier)); } indexerParameters = indexerParamBuilder.ToImmutable(); }
var propName = isIndexer ? "Item" : propSyntax.Identifier.Text; if (!existingNames.Add(propName)) { Diagnostics.ReportSymbolAlreadyDeclared(propSyntax.Identifier.Location, propName);
continue; } var propType = bindTypeClause(propSyntax.Type); if (propType == null)
{ continue; } var propAccessibility = resolveAccessibility(propSyntax.AccessibilityModifier);
bool hasGetter = true; bool hasSetter; bool isAutoProperty; bool isInitOnly = false;
string setterParamName = "value"; if (propSyntax.OpenBraceToken == null) { hasSetter = true;
isAutoProperty = true; } else {
var getAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsGetter); var setAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsSetter); var initAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsInit); if (setAccessor != null && initAccessor != null)
{ Diagnostics.ReportPropertyHasBothSetAndInit(initAccessor.AccessorKeyword.Location, propName); } var writeAccessor = setAccessor ?? initAccessor;
hasGetter = getAccessor != null || propSyntax.Accessors.IsDefaultOrEmpty; hasSetter = writeAccessor != null; isInitOnly = setAccessor == null && initAccessor != null; if (writeAccessor != null && writeAccessor.ParameterIdentifier != null)
{ setterParamName = writeAccessor.ParameterIdentifier.Text; } isAutoProperty = (getAccessor == null || getAccessor.Body == null)
&& (writeAccessor == null || writeAccessor.Body == null) && propSyntax.Accessors.All(a => a.Body == null); } if (isIndexer && isAutoProperty)
{ Diagnostics.ReportIndexerRequiresAccessorBody(propSyntax.ThisKeyword.Location); continue; }
if (isAutoProperty && syntax.IsData) { Diagnostics.ReportAutoPropertyInDataStruct(propSyntax.Identifier.Location, propName); }
bool isVirtual = propSyntax.OpenModifier != null; bool isOverride = propSyntax.OverrideModifier != null; if (isVirtual && !structSymbol.IsOpen) {
Diagnostics.ReportOpenMemberInNonOpenClass(propSyntax.OpenModifier.Location, propName); } PropertySymbol overriddenProperty = null; if (isOverride)
{ if (structSymbol.BaseClass == null || !TypeMemberModel.TryGetProperty(structSymbol.BaseClass, propName, out var baseProp)) { Diagnostics.ReportNoBaseMethodToOverride(propSyntax.Identifier.Location, propName);
} else if (!baseProp.IsVirtual && !baseProp.IsOverride) { Diagnostics.ReportOverrideOfSealedMethod(propSyntax.Identifier.Location, propName);
} else { overriddenProperty = baseProp;
} } var propertySymbol = new PropertySymbol( propName,
propType, propAccessibility, hasGetter, hasSetter,
isAutoProperty, isVirtual, isOverride, setterParamName,
declaration: propSyntax, isInitOnly: isInitOnly) { IsIndexer = isIndexer,
Parameters = indexerParameters, }; Binder.AttachDocumentation(propertySymbol, propSyntax); if (isAutoProperty && !syntax.IsData)
{ var backingField = new FieldSymbol( $"<{propName}>k__BackingField", propType,
Accessibility.Private, isReadOnly: !hasSetter); propertySymbol.BackingField = backingField; }
if (!isAutoProperty) { var getAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsGetter); var setAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsSetterOrInit);
if (hasGetter && getAccessor?.Body != null) { var getterSymbol = new FunctionSymbol( $"get_{propName}",
isIndexer ? indexerParameters : ImmutableArray<ParameterSymbol>.Empty, propType, declaration: null, package,
propAccessibility, receiverType: structSymbol, isOpen: isVirtual, isOverride: isOverride);
getterSymbol.IsSpecialName = isIndexer; propertySymbol.GetterSymbol = getterSymbol; propertySymbol.GetterBodySyntax = getAccessor.Body; }
if (hasSetter && setAccessor?.Body != null) { var setterParam = new ParameterSymbol(setterParamName, propType); var setterParameters = isIndexer
? indexerParameters.Add(setterParam) : ImmutableArray.Create(setterParam); var setterSymbol = new FunctionSymbol( $"set_{propName}",
setterParameters, TypeSymbol.Void, declaration: null, package,
propAccessibility, receiverType: structSymbol, isOpen: isVirtual, isOverride: isOverride);
setterSymbol.IsSpecialName = isIndexer; setterSymbol.IsInitOnlySetter = isInitOnly; propertySymbol.SetterSymbol = setterSymbol; propertySymbol.SetterBodySyntax = setAccessor.Body;
} } if (!propSyntax.Annotations.IsDefaultOrEmpty) {
propertySymbol.SetAttributes(BindAttributes( propSyntax.Annotations, AttributeTargetKind.Property, Binder.PropertyDeclarationAllowedTargets,
"a property declaration", System.AttributeTargets.Property)); } propertiesBuilder.Add(propertySymbol);
} structSymbol.SetProperties(propertiesBuilder.ToImmutable()); } if (!syntax.Events.IsDefaultOrEmpty)
{ var eventsBuilder = ImmutableArray.CreateBuilder<EventSymbol>(); foreach (var eventSyntax in syntax.Events) {
var eventName = eventSyntax.Identifier.Text; if (!existingNames.Add(eventName)) { Diagnostics.ReportSymbolAlreadyDeclared(eventSyntax.Identifier.Location, eventName);
continue; } var handlerType = bindTypeClause(eventSyntax.Type); if (handlerType == null)
{ continue; } var eventAccessibility = resolveAccessibility(eventSyntax.AccessibilityModifier);
bool isFieldLike = eventSyntax.OpenBraceToken == null; bool isVirtual = eventSyntax.OpenModifier != null; bool isOverride = eventSyntax.OverrideModifier != null; if (isVirtual && !structSymbol.IsOpen)
{ Diagnostics.ReportOpenMemberInNonOpenClass(eventSyntax.OpenModifier.Location, eventName); } var eventSymbol = new EventSymbol(
eventName, handlerType, eventAccessibility, isFieldLike,
isVirtual, isOverride, declaration: eventSyntax); Binder.AttachDocumentation(eventSymbol, eventSyntax);
if (isFieldLike) { var backingField = new FieldSymbol( eventName,
handlerType, Accessibility.Private, isReadOnly: false); eventSymbol.BackingField = backingField;
} else { var addAccessor = eventSyntax.Accessors.FirstOrDefault(a => a.IsAdd);
var removeAccessor = eventSyntax.Accessors.FirstOrDefault(a => a.IsRemove); var raiseAccessor = eventSyntax.Accessors.FirstOrDefault(a => a.IsRaise); if (addAccessor?.Body != null) {
eventSymbol.AddBodySyntax = addAccessor.Body; } if (removeAccessor?.Body != null) {
eventSymbol.RemoveBodySyntax = removeAccessor.Body; } if (raiseAccessor?.Body != null) {
eventSymbol.RaiseBodySyntax = raiseAccessor.Body; } } var handlerParam = new ParameterSymbol("value", handlerType);
eventSymbol.AddMethodSymbol = new FunctionSymbol( $"add_{eventName}", ImmutableArray.Create(handlerParam), TypeSymbol.Void,
declaration: null, package, eventAccessibility, receiverType: structSymbol,
isOpen: isVirtual, isOverride: isOverride) { IsSpecialName = true }; eventSymbol.RemoveMethodSymbol = new FunctionSymbol( $"remove_{eventName}",
ImmutableArray.Create(handlerParam), TypeSymbol.Void, declaration: null, package,
eventAccessibility, receiverType: structSymbol, isOpen: isVirtual, isOverride: isOverride) { IsSpecialName = true };
if (eventSyntax.Accessors.Any(a => a.IsRaise)) { var raiseParams = ImmutableArray<ParameterSymbol>.Empty; if (handlerType is FunctionTypeSymbol fnType)
{ var builder = ImmutableArray.CreateBuilder<ParameterSymbol>(fnType.ParameterTypes.Length); for (int pi = 0; pi < fnType.ParameterTypes.Length; pi++) {
builder.Add(new ParameterSymbol($"arg{pi}", fnType.ParameterTypes[pi])); } raiseParams = builder.ToImmutable(); }
eventSymbol.RaiseMethodSymbol = new FunctionSymbol( $"raise_{eventName}", raiseParams, TypeSymbol.Void,
declaration: null, package, eventAccessibility, receiverType: structSymbol,
isOpen: isVirtual, isOverride: isOverride) { IsSpecialName = true }; } if (!eventSyntax.Annotations.IsDefaultOrEmpty)
{ eventSymbol.SetAttributes(BindAttributes( eventSyntax.Annotations, AttributeTargetKind.Event,
Binder.EventDeclarationAllowedTargets, "an event declaration", System.AttributeTargets.Event)); }
eventsBuilder.Add(eventSymbol); } structSymbol.SetEvents(eventsBuilder.ToImmutable()); }
if (syntax.SharedBlock != null) { var staticFieldsBuilder = ImmutableArray.CreateBuilder<FieldSymbol>(); var sharedConstFieldsBuilder = ImmutableArray.CreateBuilder<FieldSymbol>();
foreach (var fieldSyntax in syntax.SharedBlock.Fields) { var fieldName = fieldSyntax.Identifier.Text; if (!existingNames.Add(fieldName))
{ Diagnostics.ReportSymbolAlreadyDeclared(fieldSyntax.Identifier.Location, fieldName); continue; }
var fieldType = bindTypeClause(fieldSyntax.Type); if (fieldType == null) { continue;
} if (TypeSymbol.IsByRefLike(fieldType)) { Diagnostics.ReportByRefLikeEscape(fieldSyntax.Identifier.Location, fieldType, $"be used as the type of field '{fieldName}'");
continue; } if (fieldType is ByRefTypeSymbol byRefStaticFieldType) {
Diagnostics.ReportPointerTypeCannotBeFieldType(fieldSyntax.Identifier.Location, byRefStaticFieldType.Name); continue; } var fieldAccessibility = resolveAccessibility(fieldSyntax.AccessibilityModifier);
if (fieldSyntax.IsConst) { var sharedConstField = new FieldSymbol(fieldName, fieldType, fieldAccessibility, isReadOnly: true, isStatic: true, isConst: true); Binder.AttachDocumentation(sharedConstField, fieldSyntax);
if (!fieldSyntax.Annotations.IsDefaultOrEmpty) { sharedConstField.SetAttributes(BindAttributes( fieldSyntax.Annotations,
AttributeTargetKind.Field, Binder.FieldDeclarationAllowedTargets, "a field declaration", System.AttributeTargets.Field));
} if (fieldSyntax.Initializer == null) { Diagnostics.ReportConstFieldRequiresInitializer(fieldSyntax.Identifier.Location, fieldName);
} else { pendingSharedConstInitializers.Add((sharedConstField, fieldSyntax, fieldType));
} sharedConstFieldsBuilder.Add(sharedConstField); continue; }
var fieldSymbol = new FieldSymbol(fieldName, fieldType, fieldAccessibility, isReadOnly: fieldSyntax.IsReadOnly, isStatic: true); if (!fieldSyntax.Annotations.IsDefaultOrEmpty) { fieldSymbol.SetAttributes(BindAttributes(
fieldSyntax.Annotations, AttributeTargetKind.Field, Binder.FieldDeclarationAllowedTargets, "a field declaration",
System.AttributeTargets.Field)); } Binder.AttachDocumentation(fieldSymbol, fieldSyntax); if (fieldSyntax.Initializer != null)
{ pendingStaticFieldInitializers.Add((fieldSymbol, fieldSyntax.Initializer, fieldType)); } staticFieldsBuilder.Add(fieldSymbol);
} structSymbol.SetStaticFields(staticFieldsBuilder.ToImmutable()); if (sharedConstFieldsBuilder.Count > 0) {
structSymbol.SetConstFields(structSymbol.ConstFields.AddRange(sharedConstFieldsBuilder.ToImmutable())); } var staticMethodsBuilder = ImmutableArray.CreateBuilder<FunctionSymbol>(); foreach (var methodSyntax in syntax.SharedBlock.Methods)
{ var methodName = methodSyntax.Identifier.Text; if (existingNames.Contains(methodName)) {
Diagnostics.ReportSymbolAlreadyDeclared(methodSyntax.Identifier.Location, methodName); continue; } if (structSymbol.IsData && IsDataStructSynthesizedMemberName(methodName))
{ Diagnostics.ReportDataStructSynthesizedMemberConflict(methodSyntax.Identifier.Location, structSymbol.Name, methodName); continue; }
if (structSymbol.IsInline && IsInlineSynthesizedMemberName(methodName)) { Diagnostics.ReportInlineStructSynthesizedMemberConflict(methodSyntax.Identifier.Location, structSymbol.Name, methodName); continue;
} var methodTypeParameters = BindTypeParameterList(methodSyntax.TypeParameterList); var enclosingTypeParameters = binderCtx.CurrentTypeParameters; if (!methodTypeParameters.IsDefaultOrEmpty)
{ binderCtx.CurrentTypeParameters = enclosingTypeParameters == null ? new Dictionary<string, TypeParameterSymbol>() : new Dictionary<string, TypeParameterSymbol>(enclosingTypeParameters);
foreach (var tp in methodTypeParameters) { binderCtx.CurrentTypeParameters[tp.Name] = tp; }
} try { using var sigUnsafeContext = binderCtx.PushUnsafeContext(methodSyntax.IsUnsafe);
var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>(); var seenParameterNames = new HashSet<string>(); foreach (var parameterSyntax in methodSyntax.Parameters) {
var parameterName = parameterSyntax.Identifier.Text; var parameterType = bindTypeClause(parameterSyntax.Type) ?? TypeSymbol.Error; var isVariadic = parameterSyntax.IsVariadic; if (isVariadic && parameterType != TypeSymbol.Error)
{ parameterType = SliceTypeSymbol.Get(parameterType); } var parameterRefKind = conversions.BindAndValidateParameterRefKind(
parameterSyntax, parameterName, parameterType, isVariadic,
asyncOrIteratorKind: methodSyntax.IsAsync ? "async" : null); if (parameterName != "_" && !seenParameterNames.Add(parameterName)) { Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
} else { var staticMethodParam = new ParameterSymbol(parameterName, parameterType, isVariadic, declaringSyntax: parameterSyntax.Identifier, isScoped: parameterSyntax.IsScoped, refKind: parameterRefKind);
conversions.BindAndAttachParameterDefaultValue(parameterSyntax, staticMethodParam); parameters.Add(staticMethodParam); } }
ValidateVariadicParameterShape(methodSyntax.Parameters); var returnType = bindReturnTypeClause(methodSyntax.Type, methodSyntax.IsAsync) ?? TypeSymbol.Void; var methodAccessibility = resolveAccessibility(methodSyntax.AccessibilityModifier); var methodReturnRefKind = ValidateReturnRefKind(methodSyntax, returnType);
var methodSymbol = new FunctionSymbol( methodName, parameters.ToImmutable(), returnType,
methodSyntax, package, methodAccessibility, receiverType: null);
methodSymbol.IsStatic = true; methodSymbol.StaticOwnerType = structSymbol; methodSymbol.TypeParameters = methodTypeParameters; methodSymbol.ReturnRefKind = methodReturnRefKind;
methodSymbol.IsAsync = methodSyntax.IsAsync || isAsyncIteratorReturnType(returnType); methodSymbol.IsUnsafe = methodSyntax.IsUnsafe || syntax.IsUnsafe; if (!methodSyntax.Annotations.IsDefaultOrEmpty) {
var methodAttributes = BindAttributes( methodSyntax.Annotations, AttributeTargetKind.Method, Binder.FunctionDeclarationAllowedTargets,
"a method declaration", System.AttributeTargets.Method); methodSymbol.SetAttributes(methodAttributes); ValidateInlineDataNilArguments(methodAttributes, methodSymbol.Parameters);
} Binder.AttachDocumentation(methodSymbol, methodSyntax); var isStaticPInvoke = PInvokeBinder.TryAttachPInvokeMetadata(methodSymbol, methodSyntax, Diagnostics); if (!isStaticPInvoke && methodSyntax.HasSemicolonBody)
{ Diagnostics.ReportSemicolonBodyRequiresDllImport(methodSyntax.Identifier.Location, methodSymbol.Name); } if (!isStaticPInvoke)
{ PInvokeBinder.ReportMarshalAsOnNonPInvokeFunction(methodSyntax, Diagnostics); } var hasDupSig = false;
foreach (var existingMethod in staticMethodsBuilder) { if (BoundScope.FunctionSignaturesEqual(existingMethod, methodSymbol)) {
Diagnostics.ReportDuplicateOverloadSignature( methodSyntax.Identifier.Location, methodName, Binder.FormatOverloadSignature(methodSymbol));
hasDupSig = true; break; } }
if (!hasDupSig) { staticMethodsBuilder.Add(methodSymbol); }
} finally { binderCtx.CurrentTypeParameters = enclosingTypeParameters;
} } structSymbol.SetStaticMethods(staticMethodsBuilder.ToImmutable()); var staticPropertiesBuilder = ImmutableArray.CreateBuilder<PropertySymbol>();
foreach (var propSyntax in syntax.SharedBlock.Properties) { if (propSyntax.IsIndexer) {
Diagnostics.ReportIndexerRequiresAccessorBody(propSyntax.ThisKeyword.Location); continue; } var propName = propSyntax.Identifier.Text;
if (!existingNames.Add(propName)) { Diagnostics.ReportSymbolAlreadyDeclared(propSyntax.Identifier.Location, propName); continue;
} var propType = bindTypeClause(propSyntax.Type); if (propType == null) {
continue; } var propAccessibility = resolveAccessibility(propSyntax.AccessibilityModifier); bool hasGetter = true;
bool hasSetter; bool isAutoProperty; string setterParamName = "value"; if (propSyntax.OpenBraceToken == null)
{ hasSetter = true; isAutoProperty = true; }
else { var getAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsGetter); var setAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsSetter);
var initAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsInit); if (initAccessor != null) { Diagnostics.ReportInitAccessorOnStaticProperty(initAccessor.AccessorKeyword.Location, propName);
} hasGetter = getAccessor != null || propSyntax.Accessors.IsDefaultOrEmpty; hasSetter = setAccessor != null || initAccessor != null; if (setAccessor != null && setAccessor.ParameterIdentifier != null)
{ setterParamName = setAccessor.ParameterIdentifier.Text; } isAutoProperty = (getAccessor == null || getAccessor.Body == null)
&& (setAccessor == null || setAccessor.Body == null) && propSyntax.Accessors.All(a => a.Body == null); } var propertySymbol = new PropertySymbol(
propName, propType, propAccessibility, hasGetter,
hasSetter, isAutoProperty, isVirtual: false, isOverride: false,
setterParamName, isStatic: true, declaration: propSyntax); if (isAutoProperty)
{ var backingField = new FieldSymbol( $"<{propName}>k__BackingField", propType,
Accessibility.Private, isReadOnly: !hasSetter, isStatic: true); propertySymbol.BackingField = backingField;
} if (!isAutoProperty) { var getAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsGetter);
var setAccessor = propSyntax.Accessors.FirstOrDefault(a => a.IsSetter); if (hasGetter && getAccessor?.Body != null) { var getterSymbol = new FunctionSymbol(
$"get_{propName}", ImmutableArray<ParameterSymbol>.Empty, propType, declaration: null,
package, propAccessibility, receiverType: null); getterSymbol.IsStatic = true;
getterSymbol.StaticOwnerType = structSymbol; propertySymbol.GetterSymbol = getterSymbol; propertySymbol.GetterBodySyntax = getAccessor.Body; }
if (hasSetter && setAccessor?.Body != null) { var setterParam = new ParameterSymbol(setterParamName, propType); var setterSymbol = new FunctionSymbol(
$"set_{propName}", ImmutableArray.Create(setterParam), TypeSymbol.Void, declaration: null,
package, propAccessibility, receiverType: null); setterSymbol.IsStatic = true;
setterSymbol.StaticOwnerType = structSymbol; propertySymbol.SetterSymbol = setterSymbol; propertySymbol.SetterBodySyntax = setAccessor.Body; }
} if (!propSyntax.Annotations.IsDefaultOrEmpty) { propertySymbol.SetAttributes(BindAttributes(
propSyntax.Annotations, AttributeTargetKind.Property, Binder.PropertyDeclarationAllowedTargets, "a property declaration",
System.AttributeTargets.Property)); } Binder.AttachDocumentation(propertySymbol, propSyntax); staticPropertiesBuilder.Add(propertySymbol);
} structSymbol.SetStaticProperties(staticPropertiesBuilder.ToImmutable()); var staticEventsBuilder = ImmutableArray.CreateBuilder<EventSymbol>(); foreach (var eventSyntax in syntax.SharedBlock.Events)
{ var eventName = eventSyntax.Identifier.Text; if (!existingNames.Add(eventName)) {
Diagnostics.ReportSymbolAlreadyDeclared(eventSyntax.Identifier.Location, eventName); continue; } var handlerType = bindTypeClause(eventSyntax.Type);
if (handlerType == null) { continue; }
var eventAccessibility = resolveAccessibility(eventSyntax.AccessibilityModifier); bool isFieldLike = eventSyntax.OpenBraceToken == null; var eventSymbol = new EventSymbol( eventName,
handlerType, eventAccessibility, isFieldLike, isVirtual: false,
isOverride: false, isStatic: true, declaration: eventSyntax); if (isFieldLike)
{ var backingField = new FieldSymbol( eventName, handlerType,
Accessibility.Private, isReadOnly: false, isStatic: true); eventSymbol.BackingField = backingField;
} else { var addAccessor = eventSyntax.Accessors.FirstOrDefault(a => a.IsAdd);
var removeAccessor = eventSyntax.Accessors.FirstOrDefault(a => a.IsRemove); var raiseAccessor = eventSyntax.Accessors.FirstOrDefault(a => a.IsRaise); if (addAccessor?.Body != null) {
eventSymbol.AddBodySyntax = addAccessor.Body; } if (removeAccessor?.Body != null) {
eventSymbol.RemoveBodySyntax = removeAccessor.Body; } if (raiseAccessor?.Body != null) {
eventSymbol.RaiseBodySyntax = raiseAccessor.Body; } } var handlerParam = new ParameterSymbol("value", handlerType);
eventSymbol.AddMethodSymbol = new FunctionSymbol( $"add_{eventName}", ImmutableArray.Create(handlerParam), TypeSymbol.Void,
declaration: null, package, eventAccessibility, receiverType: null) { IsSpecialName = true };
eventSymbol.AddMethodSymbol.IsStatic = true; eventSymbol.RemoveMethodSymbol = new FunctionSymbol( $"remove_{eventName}", ImmutableArray.Create(handlerParam),
TypeSymbol.Void, declaration: null, package, eventAccessibility,
receiverType: null) { IsSpecialName = true }; eventSymbol.RemoveMethodSymbol.IsStatic = true; if (eventSyntax.Accessors.Any(a => a.IsRaise)) {
var raiseParams = ImmutableArray<ParameterSymbol>.Empty; if (handlerType is FunctionTypeSymbol fnType) { var builder = ImmutableArray.CreateBuilder<ParameterSymbol>(fnType.ParameterTypes.Length);
for (int pi = 0; pi < fnType.ParameterTypes.Length; pi++) { builder.Add(new ParameterSymbol($"arg{pi}", fnType.ParameterTypes[pi])); }
raiseParams = builder.ToImmutable(); } eventSymbol.RaiseMethodSymbol = new FunctionSymbol( $"raise_{eventName}",
raiseParams, TypeSymbol.Void, declaration: null, package,
eventAccessibility, receiverType: null) { IsSpecialName = true }; eventSymbol.RaiseMethodSymbol.IsStatic = true; }
if (!eventSyntax.Annotations.IsDefaultOrEmpty) { eventSymbol.SetAttributes(BindAttributes( eventSyntax.Annotations,
AttributeTargetKind.Event, Binder.EventDeclarationAllowedTargets, "an event declaration", System.AttributeTargets.Event));
} Binder.AttachDocumentation(eventSymbol, eventSyntax); staticEventsBuilder.Add(eventSymbol); }
structSymbol.SetStaticEvents(staticEventsBuilder.ToImmutable()); } foreach (var conversionOperator in pendingConversionOperators) {
BindConversionOperatorDeclaration( conversionOperator.Syntax, conversionOperator.Parameters, conversionOperator.ReturnType,
conversionOperator.Accessibility, package, conversionOperator.Attributes); }
var fieldInitScope = scope; var fieldInitConstInitializers = pendingConstInitializers; var fieldInitSharedConstInitializers = pendingSharedConstInitializers; var fieldInitStaticInitializers = pendingStaticFieldInitializers;
var fieldInitInstanceInitializers = pendingInstanceInitializers; var fieldInitFields = fields.ToImmutable(); var fieldInitPrimaryCtorParameters = primaryCtorParameters; pendingFieldInitializerBindings.Add(() =>
{ var savedFieldInitScope = scope; var savedFieldInitTypeParameters = binderCtx.CurrentTypeParameters; scope = fieldInitScope;
if (!structSymbol.TypeParameters.IsDefaultOrEmpty) { binderCtx.CurrentTypeParameters = new Dictionary<string, TypeParameterSymbol>(); foreach (var tp in structSymbol.TypeParameters)
{ binderCtx.CurrentTypeParameters[tp.Name] = tp; } }
try { using (PushStaticMemberScope(structSymbol)) {
BindDeferredFieldInitializers( structSymbol, fieldInitConstInitializers, fieldInitSharedConstInitializers,
fieldInitStaticInitializers, fieldInitInstanceInitializers, fieldInitFields, fieldInitPrimaryCtorParameters);
} } finally {
scope = savedFieldInitScope; binderCtx.CurrentTypeParameters = savedFieldInitTypeParameters; } });
if (implementedInterfaces.Count > 0) { structSymbol.SetInterfaces(implementedInterfaces.ToImmutable()); foreach (var iface in implementedInterfaces)
{ if (iface.IsSealed && !string.Equals(iface.PackageName ?? string.Empty, structSymbol.PackageName ?? string.Empty, System.StringComparison.Ordinal)) { Diagnostics.ReportSealedInterfaceImplementorOutsidePackage(
syntax.Identifier.Location, structSymbol.Name, iface.Name, iface.PackageName ?? string.Empty);
} } pendingInterfaceImplementationChecks.Add((syntax, structSymbol)); }
if (implementedClrInterfaces.Count > 0) { structSymbol.SetImplementedClrInterfaces(implementedClrInterfaces.ToImmutable()); if (implementedInterfaces.Count == 0)
{ pendingInterfaceImplementationChecks.Add((syntax, structSymbol)); } }
BindConstructorDeclarations(syntax, structSymbol, package, baseClassSymbol, importedBaseType); BindDeinitDeclaration(syntax, structSymbol, package); BindNestedTypeBodies(syntax, package); if (syntax.IsClass)
{ pendingAbstractImplementationChecks.Add((syntax, structSymbol)); } }


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
}
