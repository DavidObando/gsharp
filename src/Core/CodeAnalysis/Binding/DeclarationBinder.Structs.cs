// <copyright file="DeclarationBinder.Structs.cs" company="GSharp">
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

internal sealed partial class DeclarationBinder
{
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
            // Issue #1537: a nested type's members may reference the ENCLOSING
            // type's type parameters (e.g. a field of type `U` inside
            // `Middle[T]` nested in `Outer[U]`). Seed the member-binding scope
            // with every enclosing type parameter (outermost-first, so an inner
            // level shadows an outer one on a name clash) BEFORE the type's own
            // parameters, mirroring CLR nested-generic scoping (ECMA-335
            // §II.10.3.1). The emitter reifies such a nested type over the
            // combined [enclosing, own] parameter list and remaps each reference
            // to the correct VAR ordinal, so these references encode verifiably.
            var enclosingTypeParameters = CollectEnclosingTypeParameters(structSymbol.ContainingType);
            if (!structSymbol.TypeParameters.IsDefaultOrEmpty || enclosingTypeParameters.Count > 0)
            {
                binderCtx.CurrentTypeParameters = new Dictionary<string, TypeParameterSymbol>();
                foreach (var tp in enclosingTypeParameters)
                {
                    binderCtx.CurrentTypeParameters[tp.Name] = tp;
                }

                if (!structSymbol.TypeParameters.IsDefaultOrEmpty)
                {
                    foreach (var tp in structSymbol.TypeParameters)
                    {
                        binderCtx.CurrentTypeParameters[tp.Name] = tp;
                    }
                }
            }

            // Issue #2519: aggregate shells carry bare type parameters so every
            // same-compilation constraint target can be published first.
            // Resolve constraints now, with the declaring shell and all sibling
            // source type shells visible, before binding signatures and members.
            ResolveTypeParameterConstraints(syntax.TypeParameterList, structSymbol.TypeParameters);
            BindStructDeclarationBodyCore(syntax, package, structSymbol);
        }
        finally
        {
            binderCtx.CurrentTypeParameters = previousTypeParameters;
        }
    }

    /// <summary>
    /// Issue #1537: collects the type parameters of <paramref name="enclosingType"/>
    /// and all of ITS enclosing types, outermost-first, so a nested type's
    /// members and its own type-parameter constraints can reference them.
    /// Returns an empty list for a top-level type (<paramref name="enclosingType"/>
    /// is <see langword="null"/>) or when every encloser is non-generic.
    /// </summary>
    /// <param name="enclosingType">The immediately enclosing type, or <see langword="null"/>.</param>
    /// <returns>The enclosing type parameters, outermost-first.</returns>
    private static List<TypeParameterSymbol> CollectEnclosingTypeParameters(TypeSymbol enclosingType)
    {
        List<ImmutableArray<TypeParameterSymbol>> levels = null;
        for (var c = enclosingType as StructSymbol; c != null; c = c.ContainingType as StructSymbol)
        {
            if (!c.TypeParameters.IsDefaultOrEmpty)
            {
                levels ??= new List<ImmutableArray<TypeParameterSymbol>>();

                // Prepend so the outermost enclosing type's parameters come first.
                levels.Insert(0, c.TypeParameters);
            }
        }

        var result = new List<TypeParameterSymbol>();
        if (levels != null)
        {
            foreach (var level in levels)
            {
                result.AddRange(level);
            }
        }

        return result;
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

    private readonly record struct StructFieldBindingResult(
        ImmutableArray<FieldSymbol>.Builder Fields,
        ImmutableArray<ParameterSymbol> PrimaryConstructorParameters,
        ImmutableArray<FieldSymbol>.Builder ConstFields,
        List<(FieldSymbol Field, ExpressionSyntax InitSyntax, TypeSymbol FieldType)> PendingInstanceInitializers,
        List<(FieldSymbol Field, FieldDeclarationSyntax Syntax, TypeSymbol FieldType)> PendingConstInitializers,
        List<(FieldSymbol Field, ExpressionSyntax InitSyntax, TypeSymbol FieldType)> PendingStaticFieldInitializers,
        List<(FieldSymbol Field, FieldDeclarationSyntax Syntax, TypeSymbol FieldType)> PendingSharedConstInitializers);

    private readonly record struct StructBaseBindingResult(
        StructSymbol BaseClass,
        TypeSymbol ImportedBaseType,
        ImmutableArray<InterfaceSymbol>.Builder ImplementedInterfaces,
        ImmutableArray<TypeSymbol>.Builder ImplementedClrInterfaces);

    private readonly record struct StructMemberBindingContext(
        HashSet<string> ExistingNames,
        HashSet<string> MethodNames,
        HashSet<string> ExplicitInterfaceClauseNames,
        List<(FunctionDeclarationSyntax Syntax, ImmutableArray<ParameterSymbol> Parameters, TypeSymbol ReturnType, Accessibility Accessibility, ImmutableArray<BoundAttribute> Attributes)> PendingConversionOperators);

    private void BindStructDeclarationBodyCore(
        StructDeclarationSyntax syntax,
        PackageSymbol package,
        StructSymbol structSymbol)
    {
        // ADR-0122 / issue #1014: an `unsafe class` / `unsafe struct` binds all
        // of its members (field types, method signatures, …) within an unsafe
        // context, so they may use unmanaged raw pointers (`*T`).
        using var unsafeContext = binderCtx.PushUnsafeContext(syntax.IsUnsafe);

        // Issue #950: `protected` is only meaningful on members of an
        // inheritable `open class`. Reject it on members of a non-open class,
        // a struct (value types are not inheritable), or a sealed type before
        // binding the members so the user sees one clean GS0380 diagnostic.
        ValidateProtectedMemberPlacement(syntax);

        var fieldBinding = BindStructFieldsAndPrimaryConstructor(syntax, package, structSymbol);
        var baseBinding = BindStructBaseAndInterfaces(syntax, structSymbol, fieldBinding);
        var memberBinding = CreateStructMemberBindingContext(structSymbol);

        BindStructInstanceMethods(syntax, package, structSymbol, baseBinding, memberBinding);
        BindStructProperties(syntax, package, structSymbol, memberBinding);
        BindStructEvents(syntax, package, structSymbol, baseBinding, memberBinding);
        BindStructSharedBlock(syntax, package, structSymbol, fieldBinding, memberBinding);
        RegisterStructConversionOperators(package, memberBinding.PendingConversionOperators);
        RegisterStructDeferredInitializers(package, structSymbol, fieldBinding);
        RegisterStructInterfaceChecks(syntax, structSymbol, baseBinding);
        BindStructFinalMembers(syntax, package, structSymbol, baseBinding);
    }

    private StructFieldBindingResult BindStructFieldsAndPrimaryConstructor(
        StructDeclarationSyntax syntax,
        PackageSymbol package,
        StructSymbol structSymbol)
    {
        var name = structSymbol.Name;
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

                // Issue #1913: primary-constructor parameters can carry
                // `@Attr` annotations same as any other parameter list.
                BindAndAttachParameterAttributes(paramSyntax, primaryCtorParam);
                ctorBuilder.Add(primaryCtorParam);

                // Data-type positional members are CLR properties (matching
                // C# records); their backing fields are synthesized below.
                if (!syntax.IsData)
                {
                    fields.Add(new FieldSymbol(paramName, paramType, Accessibility.Public, isReadOnly: syntax.IsInline));
                }
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

        // Issue #2363: a `data class`/`data struct` with zero fields is now a
        // supported (if degenerate) declaration — needed for the G# mapping
        // of an empty positional C# record (`record Name()`), and equally for
        // a record whose only body members are contract properties (virtual/
        // override/interface-implementing) that cannot be lifted into fields.
        // Such a type still gets the full synthesized member set (equality,
        // hash, ToString, copy), just with a trivial (always-equal, same
        // fixed hash) leaf-type body (ADR-0029) and no `Deconstruct` (there is
        // nothing to deconstruct). GS0104 is retained for source/API
        // stability but is no longer emitted by this check.
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

        return new StructFieldBindingResult(
            fields,
            primaryCtorParameters,
            constFieldsBuilder,
            pendingInstanceInitializers,
            pendingConstInitializers,
            pendingStaticFieldInitializers,
            pendingSharedConstInitializers);
    }

    private StructBaseBindingResult BindStructBaseAndInterfaces(
        StructDeclarationSyntax syntax,
        StructSymbol structSymbol,
        StructFieldBindingResult fieldBinding)
    {
        var name = structSymbol.Name;
        var fields = fieldBinding.Fields;
        var primaryCtorParameters = fieldBinding.PrimaryConstructorParameters;
        var constFieldsBuilder = fieldBinding.ConstFields;

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
        // first identifier. All same-compilation type shells are already
        // declared, and the global binder orders class bodies base-first.
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

        return new StructBaseBindingResult(
            baseClassSymbol,
            importedBaseType,
            implementedInterfaces,
            implementedClrInterfaces);
    }

    private StructMemberBindingContext CreateStructMemberBindingContext(StructSymbol structSymbol)
    {
        // Collect existing member names for duplicate detection across fields,
        // methods, and properties.
        var existingNames = new HashSet<string>();
        foreach (var f in structSymbol.Fields)
        {
            existingNames.Add(f.Name);
        }

        // ADR-0149: a property/event carrying an explicit-interface qualifier
        // clause (`prop (IFoo) P T`) is exempt from the ordinary "name already
        // declared" collision below — multiple explicit implementations of
        // DIFFERENT interfaces legitimately share the same plain member name
        // (that's the entire point of the clause). Tracks which plain names
        // were added ONLY via an explicit-clause member, so a later NON-clause
        // member (or a clause targeting the SAME interface — see GS0495 in
        // VerifyExplicitInterfaceClauseResolution) still collides normally.
        var explicitInterfaceClauseNames = new HashSet<string>();

        // Issue #1640: methods overload by signature, so a same-named method
        // is not itself a duplicate — but a non-method member (property,
        // event, or field) sharing a method's name IS a collision (CS0102).
        // Method names are tracked separately from existingNames so the
        // method-vs-method checks below (including instance-vs-shared/static
        // overload, issue #1147) stay unaffected, while property/event/field
        // checks can still see method names.
        var methodNames = new HashSet<string>();

        // Phase 3.B.3 sub-step 2b: bind methods declared inside the class body.
        // Issue #938 / ADR-0079: in-body methods are the canonical declaration
        // site for owned `class` AND owned `struct`/`data struct` instance
        // methods. Each method becomes a FunctionSymbol with
        // ReceiverType = structSymbol; method bodies are bound later by
        // BindProgram by walking StructSymbol.Methods. For value-type receivers
        // the emitter synthesizes a by-ref `this`, identical to the
        // receiver-clause owned-struct method lowering.
        // Issue #1283: in-body user-defined conversion operators
        // (`func operator implicit/explicit (x T) U` declared directly inside a
        // struct/class body) are modelled exactly like the free-function form —
        // a static `op_Implicit` / `op_Explicit` special-name method on the
        // owning type. They are collected here and registered AFTER the
        // shared-block static methods are installed (which replaces the static
        // method table), so an in-body operator coexists with a `shared` block.
        var pendingConversionOperators = new List<(FunctionDeclarationSyntax Syntax, ImmutableArray<ParameterSymbol> Parameters, TypeSymbol ReturnType, Accessibility Accessibility, ImmutableArray<BoundAttribute> Attributes)>();

        return new StructMemberBindingContext(
            existingNames,
            methodNames,
            explicitInterfaceClauseNames,
            pendingConversionOperators);
    }

    private void BindStructInstanceMethods(
        StructDeclarationSyntax syntax,
        PackageSymbol package,
        StructSymbol structSymbol,
        StructBaseBindingResult baseBinding,
        StructMemberBindingContext memberBinding)
    {
        var implementedClrInterfaces = baseBinding.ImplementedClrInterfaces;
        var methodNames = memberBinding.MethodNames;
        var pendingConversionOperators = memberBinding.PendingConversionOperators;

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

                // Issue #2361: a data class/struct's ToString is the one
                // synthesized-name exception — its exact shape is validated a
                // few lines below (once the parameter list/return type are
                // bound), where it either falls through as an ordinary
                // in-body method (suppressing the synthesized ToString) or is
                // rejected with the more specific GS0487. The other five
                // synthesized names stay unconditionally reserved here.
                if (structSymbol.IsData && IsDataStructSynthesizedMemberName(methodName) && !IsUserOverridableDataMemberName(methodName))
                {
                    Diagnostics.ReportDataStructSynthesizedMemberConflict(methodSyntax.Identifier.Location, structSymbol.Name, structSymbol.IsClass, methodName);
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

                        // Issue #1262: `_` is the discard identifier — repeated `_` parameters are
                        // permitted on named functions/methods. Each `_` occupies a positional slot
                        // but is not added to the body scope, so non-`_` duplicates still error.
                        if (parameterName != "_" && !seenParameterNames.Add(parameterName))
                        {
                            Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
                        }
                        else
                        {
                            var classMethodParam = new ParameterSymbol(parameterName, parameterType, isVariadic, declaringSyntax: parameterSyntax.Identifier, isScoped: parameterSyntax.IsScoped, refKind: parameterRefKind);
                            conversions.BindAndAttachParameterDefaultValue(parameterSyntax, classMethodParam);
                            BindAndAttachParameterAttributes(parameterSyntax, classMethodParam);
                            parameters.Add(classMethodParam);
                        }
                    }

                    ValidateVariadicParameterShape(methodSyntax.Parameters);

                    var returnType = bindReturnTypeClause(methodSyntax.Type, methodSyntax.IsAsync) ?? TypeSymbol.Void;
                    var methodAccessibility = resolveAccessibility(methodSyntax.AccessibilityModifier);

                    // ADR-0146 (Kotlin visibility narrowing follow-up): infer/narrow the
                    // return type when the (omitted-type) body is `-> object { ... }`.
                    returnType = InferAnonymousClassLiteralReturnType(methodSyntax, returnType, methodAccessibility);

                    returnType = NormalizeAsyncDeclaredReturnType(returnType, methodSyntax.IsAsync, out var returnTypeIsValueTask);
                    var methodParameters = parameters.ToImmutable();
                    var methodReturnRefKind = ValidateReturnRefKind(methodSyntax, returnType);

                    // Issue #1283: a conversion operator declared in the body is
                    // not an instance method — defer it to the static
                    // `op_Implicit` / `op_Explicit` registration below, reusing
                    // the same machinery as the free-function form so the
                    // conversion is recognised and applied at every target-typed
                    // position.
                    if (methodSyntax.IsConversionOperator)
                    {
                        var conversionAttributes = ImmutableArray<BoundAttribute>.Empty;
                        if (!methodSyntax.Annotations.IsDefaultOrEmpty)
                        {
                            conversionAttributes = BindAttributes(
                                methodSyntax.Annotations,
                                AttributeTargetKind.Method,
                                Binder.FunctionDeclarationAllowedTargets,
                                "a method declaration",
                                System.AttributeTargets.Method);
                        }

                        pendingConversionOperators.Add((methodSyntax, methodParameters, returnType, methodAccessibility, conversionAttributes));
                        continue;
                    }

                    // Issue #1071: the effective async flag (mirrors
                    // FunctionSymbol.IsAsync below) so override / shadow matching
                    // compares the async-normalized effective return type.
                    var methodIsAsync = methodSyntax.IsAsync || isAsyncIteratorReturnType(returnType);

                    // Issue #2361: now that the parameter list/return type are
                    // bound, validate a data class/struct's ToString shape.
                    // Compatible: fall through as an ordinary in-body method
                    // (its FunctionSymbol lands in structSymbol.Methods below,
                    // which both the emitter's method-row planner and
                    // DataStructSynthesizer.EmitDataStructSynthesizedMembers
                    // check to suppress the synthesized ToString row/body).
                    // Incompatible: reject with GS0487 instead of silently
                    // colliding with (or shadowing) the synthesized member.
                    if (structSymbol.IsData && methodName == "ToString"
                        && !IsCompatibleDataToStringOverride(methodSyntax.Parameters.Count, returnType, methodReturnRefKind, methodIsAsync, methodSyntax.IsUnsafe, methodTypeParameters, methodAccessibility))
                    {
                        Diagnostics.ReportIncompatibleDataToStringOverride(methodSyntax.Identifier.Location, structSymbol.Name, structSymbol.IsClass);
                        continue;
                    }

                    // Phase 3.B.3 sub-step 3: open/override validation against
                    // base class chain per ADR-0017.
                    FunctionSymbol overriddenMethod = null;
                    MethodInfo externalOverriddenMethod = null;
                    TypeSymbol externalOverrideContainingType = null;
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
                            var candidateTypeArgSubst = WithMethodTypeParameterSubstitution(baseTypeArgSubst, candidate, methodTypeParameters);
                            if (SignaturesMatch(candidate, methodParameters, returnType, methodReturnRefKind, candidateTypeArgSubst, methodIsAsync))
                            {
                                baseSignatureMatch = candidate;
                                break;
                            }
                        }

                        if (baseMethod == null)
                        {
                            var externalMatch = ExternalClrOverrideResolver.FindMethod(
                                structSymbol,
                                methodName,
                                methodParameters,
                                returnType,
                                methodReturnRefKind,
                                methodTypeParameters,
                                methodAccessibility);
                            if (externalMatch.Member != null)
                            {
                                externalOverriddenMethod = externalMatch.Member;
                                externalOverrideContainingType = externalMatch.ContainingType;
                            }
                            else if (externalMatch.IsSealed)
                            {
                                Diagnostics.ReportOverrideOfSealedMethod(methodSyntax.Identifier.Location, methodName);
                            }
                            else if (externalMatch.SawName)
                            {
                                Diagnostics.ReportOverrideSignatureMismatch(methodSyntax.Identifier.Location, methodName);
                            }
                            else
                            {
                                Diagnostics.ReportNoBaseMethodToOverride(methodSyntax.Identifier.Location, methodName);
                            }
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

                            var shadowedTypeArgSubst = WithMethodTypeParameterSubstitution(baseTypeArgSubst, shadowed, methodTypeParameters);
                            if (SignaturesMatch(shadowed, methodParameters, returnType, methodReturnRefKind, shadowedTypeArgSubst, methodIsAsync))
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
                    methodSymbol.ExternalOverriddenMethod = externalOverriddenMethod;
                    methodSymbol.ExternalOverrideContainingType = externalOverrideContainingType;
                    methodSymbol.TypeParameters = methodTypeParameters;
                    methodSymbol.ReturnRefKind = methodReturnRefKind;
                    methodSymbol.IsAsync = methodSyntax.IsAsync || isAsyncIteratorReturnType(returnType);
                    methodSymbol.AsyncReturnsValueTask = returnTypeIsValueTask;
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

                    // ADR-0149: a method declared with an explicit-interface
                    // qualifier clause (`func (IFoo) M(...)`) explicitly
                    // implements one interface member's own distinct body.
                    // Resolution against the actual interface member is
                    // deferred to VerifyInterfaceImplementations — interfaces
                    // declared later in the same compilation unit have not had
                    // their own members bound yet when this class's members
                    // are bound, so `implementedInterfaces[i].Methods` may
                    // still be empty here.
                    var hasDuplicateSig = false;
                    foreach (var existingMethod in methodsBuilder)
                    {
                        if (BoundScope.FunctionSignaturesEqual(existingMethod, methodSymbol))
                        {
                            // ADR-0149: two methods that share a name and
                            // parameter shape may legitimately coexist when
                            // at least one carries an explicit-interface
                            // qualifier clause — each clause-bearing method
                            // occupies its own distinct (interface, name)
                            // slot (verified/deduplicated later by
                            // VerifyExplicitInterfaceClauseResolution's GS0495
                            // check), so this is not an ordinary overload
                            // collision.
                            if (methodSymbol.HasExplicitInterfaceClause || existingMethod.HasExplicitInterfaceClause)
                            {
                                continue;
                            }

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

            // Issue #1640: register instance method names so later
            // property/event/field checks reject a name collision with a
            // method, per the "fields + methods + other properties" contract
            // the duplicate-check comments have always claimed.
            foreach (var m in methodsBuilder)
            {
                methodNames.Add(m.Name);
            }
        }
    }

    private void BindStructProperties(
        StructDeclarationSyntax syntax,
        PackageSymbol package,
        StructSymbol structSymbol,
        StructMemberBindingContext memberBinding)
    {
        var existingNames = memberBinding.ExistingNames;
        var methodNames = memberBinding.MethodNames;
        var explicitInterfaceClauseNames = memberBinding.ExplicitInterfaceClauseNames;

        // ADR-0051: bind property declarations. Positional data members are
        // synthesized as public get/init auto-properties so peer-language
        // consumers see the same ABI as C# records.
        if (!syntax.Properties.IsDefaultOrEmpty || (structSymbol.IsData && structSymbol.HasPrimaryConstructor))
        {
            var propertiesBuilder = ImmutableArray.CreateBuilder<PropertySymbol>();
            if (structSymbol.IsData && structSymbol.HasPrimaryConstructor)
            {
                foreach (var parameter in structSymbol.PrimaryConstructorParameters)
                {
                    var property = new PropertySymbol(
                        parameter.Name,
                        parameter.Type,
                        Accessibility.Public,
                        hasGetter: true,
                        hasSetter: true,
                        isAutoProperty: true,
                        isVirtual: false,
                        isOverride: false,
                        isInitOnly: true);
                    property.BackingField = new FieldSymbol(
                        $"<{parameter.Name}>k__BackingField",
                        parameter.Type,
                        structSymbol.IsClass ? Accessibility.Private : Accessibility.Internal,
                        isReadOnly: false);
                    propertiesBuilder.Add(property);
                    existingNames.Add(parameter.Name);
                }
            }

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

                        var indexerParam = new ParameterSymbol(indexParamName, indexParamType, declaringSyntax: indexParamSyntax.Identifier);

                        // Issue #1913: indexer parameters can carry `@Attr`
                        // annotations same as any other parameter list.
                        BindAndAttachParameterAttributes(indexParamSyntax, indexerParam);
                        indexerParamBuilder.Add(indexerParam);
                    }

                    indexerParameters = indexerParamBuilder.ToImmutable();
                }

                var propName = isIndexer ? "Item" : propSyntax.Identifier.Text;

                // Check for duplicate names (fields + methods + other properties).
                // ADR-0149: exempt when either the new property, or ANY
                // already-declared same-name property, carries an
                // explicit-interface qualifier clause — a plain (implicitly-
                // dispatched) property and a purely-explicit-slot property
                // legitimately share the same source name (that's the exact
                // Oahu `Authorization`/`IProfile.Authorization` shape this
                // clause exists for), and so do two explicit clauses
                // targeting DIFFERENT interfaces. Two explicit clauses that
                // resolve to the SAME interface member are still caught, just
                // later — see GS0495 in VerifyExplicitInterfaceClauseResolution,
                // which has the resolved target identity needed to detect
                // that specific case. Indexers are always named "Item" (issue
                // #944 / #2362 follow-up): this also lets a type declare more
                // than one explicit-interface indexer implementation, closing
                // a gap the old mangled-name convention only partially covered.
                var propAlreadyDeclared = existingNames.Contains(propName);
                var propExemptCollision = propSyntax.HasExplicitInterfaceClause || explicitInterfaceClauseNames.Contains(propName);
                if (methodNames.Contains(propName) || (propAlreadyDeclared && !propExemptCollision))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(propSyntax.Identifier.Location, propName);
                    continue;
                }

                existingNames.Add(propName);
                if (propSyntax.HasExplicitInterfaceClause)
                {
                    explicitInterfaceClauseNames.Add(propName);
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
                var getterAccessibility = propAccessibility;
                var setterAccessibility = propAccessibility;

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
                    if (getAccessor?.AccessibilityModifier != null)
                    {
                        getterAccessibility = resolveAccessibility(getAccessor.AccessibilityModifier);
                    }

                    if (writeAccessor?.AccessibilityModifier != null)
                    {
                        setterAccessibility = resolveAccessibility(writeAccessor.AccessibilityModifier);
                    }

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

                // Validate: open only on open class
                bool isVirtual = propSyntax.OpenModifier != null;
                bool isOverride = propSyntax.OverrideModifier != null;

                if (isVirtual && !structSymbol.IsOpen)
                {
                    Diagnostics.ReportOpenMemberInNonOpenClass(propSyntax.OpenModifier.Location, propName);
                }

                // Validate: override needs base property
                PropertyInfo externalOverriddenProperty = null;
                TypeSymbol externalPropertyContainingType = null;
                if (isOverride)
                {
                    if (structSymbol.BaseClass != null && TypeMemberModel.TryGetProperty(structSymbol.BaseClass, propName, out var baseProp))
                    {
                        if (!baseProp.IsVirtual && !baseProp.IsOverride)
                        {
                            Diagnostics.ReportOverrideOfSealedMethod(propSyntax.Identifier.Location, propName);
                        }
                    }
                    else
                    {
                        var externalMatch = ExternalClrOverrideResolver.FindProperty(
                            structSymbol,
                            propName,
                            indexerParameters,
                            propType,
                            hasGetter,
                            hasSetter,
                            propAccessibility);
                        if (externalMatch.Member != null)
                        {
                            externalOverriddenProperty = externalMatch.Member;
                            externalPropertyContainingType = externalMatch.ContainingType;
                        }
                        else if (externalMatch.IsSealed)
                        {
                            Diagnostics.ReportOverrideOfSealedMethod(propSyntax.Identifier.Location, propName);
                        }
                        else if (externalMatch.SawName)
                        {
                            Diagnostics.ReportOverrideSignatureMismatch(propSyntax.Identifier.Location, propName);
                        }
                        else
                        {
                            Diagnostics.ReportNoBaseMethodToOverride(propSyntax.Identifier.Location, propName);
                        }
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
                    isInitOnly: isInitOnly,
                    getterAccessibility: getterAccessibility,
                    setterAccessibility: setterAccessibility)
                {
                    IsIndexer = isIndexer,
                    Parameters = indexerParameters,
                };
                Binder.AttachDocumentation(propertySymbol, propSyntax);
                if (externalOverriddenProperty != null)
                {
                    propertySymbol.ExternalOverriddenGetter = externalOverriddenProperty.GetGetMethod(nonPublic: true);
                    propertySymbol.ExternalOverriddenSetter = externalOverriddenProperty.GetSetMethod(nonPublic: true);
                    propertySymbol.ExternalOverrideContainingType = externalPropertyContainingType;
                }

                // Create backing field for auto-properties
                if (isAutoProperty)
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
                            getterAccessibility,
                            receiverType: structSymbol,
                            isOpen: isVirtual,
                            isOverride: isOverride);

                        // ADR-0118: indexer accessors are emitted as SpecialName
                        // CLR default-member accessors (get_Item).
                        getterSymbol.IsSpecialName = isIndexer;
                        getterSymbol.ExternalOverriddenMethod = propertySymbol.ExternalOverriddenGetter;
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
                            setterAccessibility,
                            receiverType: structSymbol,
                            isOpen: isVirtual,
                            isOverride: isOverride);
                        setterSymbol.IsSpecialName = isIndexer;
                        setterSymbol.IsInitOnlySetter = isInitOnly;
                        setterSymbol.ExternalOverriddenMethod = propertySymbol.ExternalOverriddenSetter;
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
    }

    private void BindStructEvents(
        StructDeclarationSyntax syntax,
        PackageSymbol package,
        StructSymbol structSymbol,
        StructBaseBindingResult baseBinding,
        StructMemberBindingContext memberBinding)
    {
        var existingNames = memberBinding.ExistingNames;
        var methodNames = memberBinding.MethodNames;
        var explicitInterfaceClauseNames = memberBinding.ExplicitInterfaceClauseNames;

        // ADR-0052: bind event declarations.
        if (!syntax.Events.IsDefaultOrEmpty)
        {
            var eventsBuilder = ImmutableArray.CreateBuilder<EventSymbol>();
            foreach (var eventSyntax in syntax.Events)
            {
                var eventName = eventSyntax.Identifier.Text;

                // Check for duplicate names.
                // ADR-0149: mirrors the property collision exemption above —
                // an explicit-clause event legitimately shares its plain
                // name with an ordinary event, a differently-targeted
                // explicit event, or (per CS0102-style field/property/event
                // namespace sharing) any other member kind that has ALSO
                // been marked exempt via an explicit clause of its own. Two
                // explicit clauses resolving to the SAME interface member
                // are still caught later, by GS0495 in
                // VerifyExplicitInterfaceClauseResolution.
                var eventAlreadyDeclared = existingNames.Contains(eventName);
                var eventExemptCollision = eventSyntax.HasExplicitInterfaceClause || explicitInterfaceClauseNames.Contains(eventName);
                if (methodNames.Contains(eventName) || (eventAlreadyDeclared && !eventExemptCollision))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(eventSyntax.Identifier.Location, eventName);
                    continue;
                }

                existingNames.Add(eventName);
                if (eventSyntax.HasExplicitInterfaceClause)
                {
                    explicitInterfaceClauseNames.Add(eventName);
                }

                var handlerType = bindTypeClause(eventSyntax.Type);
                if (handlerType == null)
                {
                    continue;
                }

                handlerType = CanonicalizeInterfaceEventHandlerType(
                    baseBinding,
                    eventName,
                    handlerType);

                var eventAccessibility = resolveAccessibility(eventSyntax.AccessibilityModifier);
                bool isFieldLike = eventSyntax.OpenBraceToken == null;
                bool isVirtual = eventSyntax.OpenModifier != null;
                bool isOverride = eventSyntax.OverrideModifier != null;

                // Validate: open only on open class
                if (isVirtual && !structSymbol.IsOpen)
                {
                    Diagnostics.ReportOpenMemberInNonOpenClass(eventSyntax.OpenModifier.Location, eventName);
                }

                EventInfo externalOverriddenEvent = null;
                TypeSymbol externalEventContainingType = null;
                if (isOverride)
                {
                    if (structSymbol.BaseClass != null && TypeMemberModel.TryGetEvent(structSymbol.BaseClass, eventName, out var baseEvent))
                    {
                        if (!baseEvent.IsVirtual && !baseEvent.IsOverride)
                        {
                            Diagnostics.ReportOverrideOfSealedMethod(eventSyntax.Identifier.Location, eventName);
                        }
                        else if (baseEvent.Type != handlerType)
                        {
                            Diagnostics.ReportOverrideSignatureMismatch(eventSyntax.Identifier.Location, eventName);
                        }
                    }
                    else
                    {
                        var externalMatch = ExternalClrOverrideResolver.FindEvent(
                            structSymbol,
                            eventName,
                            handlerType,
                            eventAccessibility);
                        if (externalMatch.Member != null)
                        {
                            externalOverriddenEvent = externalMatch.Member;
                            externalEventContainingType = externalMatch.ContainingType;
                        }
                        else if (externalMatch.IsSealed)
                        {
                            Diagnostics.ReportOverrideOfSealedMethod(eventSyntax.Identifier.Location, eventName);
                        }
                        else if (externalMatch.SawName)
                        {
                            Diagnostics.ReportOverrideSignatureMismatch(eventSyntax.Identifier.Location, eventName);
                        }
                        else
                        {
                            Diagnostics.ReportNoBaseMethodToOverride(eventSyntax.Identifier.Location, eventName);
                        }
                    }
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
                if (externalOverriddenEvent != null)
                {
                    eventSymbol.ExternalOverriddenAddMethod = externalOverriddenEvent.GetAddMethod(nonPublic: true);
                    eventSymbol.ExternalOverriddenRemoveMethod = externalOverriddenEvent.GetRemoveMethod(nonPublic: true);
                    eventSymbol.ExternalOverriddenRaiseMethod = externalOverriddenEvent.GetRaiseMethod(nonPublic: true);
                    eventSymbol.ExternalOverrideContainingType = externalEventContainingType;
                }

                // Create backing field for field-like events
                if (isFieldLike)
                {
                    var backingField = new FieldSymbol(
                        eventName,
                        handlerType,
                        Accessibility.Private,
                        isReadOnly: false,
                        isEventBackingField: true);
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
                    isOverride: isOverride)
                {
                    IsSpecialName = true,
                    ExternalOverriddenMethod = eventSymbol.ExternalOverriddenAddMethod,
                };
                eventSymbol.RemoveMethodSymbol = new FunctionSymbol(
                    $"remove_{eventName}",
                    ImmutableArray.Create(handlerParam),
                    TypeSymbol.Void,
                    declaration: null,
                    package,
                    eventAccessibility,
                    receiverType: structSymbol,
                    isOpen: isVirtual,
                    isOverride: isOverride)
                {
                    IsSpecialName = true,
                    ExternalOverriddenMethod = eventSymbol.ExternalOverriddenRemoveMethod,
                };

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
                        isOverride: isOverride)
                    {
                        IsSpecialName = true,
                        ExternalOverriddenMethod = eventSymbol.ExternalOverriddenRaiseMethod,
                    };
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
    }

    private static TypeSymbol CanonicalizeInterfaceEventHandlerType(
        StructBaseBindingResult baseBinding,
        string eventName,
        TypeSymbol handlerType)
    {
        if (handlerType is not FunctionTypeSymbol)
        {
            return handlerType;
        }

        TypeSymbol selected = null;
        var ambiguous = false;

        void Consider(TypeSymbol expected)
        {
            if (!MemberLookup.TryCanonicalizeStructuralFunctionType(
                handlerType,
                expected,
                out var canonical))
            {
                return;
            }

            if (selected == null)
            {
                selected = canonical;
            }
            else if (!NamedDelegateIdentitiesMatch(selected, canonical))
            {
                ambiguous = true;
            }
        }

        foreach (var iface in baseBinding.ImplementedInterfaces)
        {
            foreach (var interfaceEvent in (iface.Definition ?? iface).Events)
            {
                if (interfaceEvent.Name == eventName)
                {
                    Consider(interfaceEvent.Type);
                }
            }
        }

        foreach (var ifaceSymbol in baseBinding.ImplementedClrInterfaces)
        {
            var declaredInterface = ifaceSymbol?.ClrType;
            if (declaredInterface?.IsInterface != true)
            {
                continue;
            }

            var interfaces = new List<Type> { declaredInterface };
            interfaces.AddRange(declaredInterface.GetInterfaces());
            foreach (var clrInterface in interfaces)
            {
                var containingType = ReferenceEquals(clrInterface, declaredInterface)
                    ? ifaceSymbol
                    : TypeSymbol.FromClrType(clrInterface);
                foreach (var interfaceEvent in clrInterface.GetEvents(
                    BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
                {
                    if (interfaceEvent.Name == eventName)
                    {
                        Consider(MemberLookup.GetClrEventHandlerTypeSymbol(
                            containingType,
                            interfaceEvent));
                    }
                }
            }
        }

        return ambiguous ? handlerType : selected ?? handlerType;
    }

    private static bool NamedDelegateIdentitiesMatch(TypeSymbol left, TypeSymbol right)
    {
        if (ReferenceEquals(left, right))
        {
            return true;
        }

        if (left is DelegateTypeSymbol && right is DelegateTypeSymbol)
        {
            return TypeSignaturesEquivalent(left, right);
        }

        return left?.ClrType != null
            && right?.ClrType != null
            && ClrTypeUtilities.AreSame(left.ClrType, right.ClrType);
    }

    private void BindStructSharedBlock(
        StructDeclarationSyntax syntax,
        PackageSymbol package,
        StructSymbol structSymbol,
        StructFieldBindingResult fieldBinding,
        StructMemberBindingContext memberBinding)
    {
        BindStructSharedFields(syntax, structSymbol, fieldBinding, memberBinding);
        BindStructSharedMethods(syntax, package, structSymbol, memberBinding);
        BindStructSharedProperties(syntax, package, structSymbol, memberBinding);
        BindStructSharedEvents(syntax, package, structSymbol, memberBinding);
    }

    private void BindStructSharedFields(
        StructDeclarationSyntax syntax,
        StructSymbol structSymbol,
        StructFieldBindingResult fieldBinding,
        StructMemberBindingContext memberBinding)
    {
        var existingNames = memberBinding.ExistingNames;
        var methodNames = memberBinding.MethodNames;
        var pendingStaticFieldInitializers = fieldBinding.PendingStaticFieldInitializers;
        var pendingSharedConstInitializers = fieldBinding.PendingSharedConstInitializers;

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
                if (methodNames.Contains(fieldName) || !existingNames.Add(fieldName))
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
        }
    }

    private void BindStructSharedMethods(
        StructDeclarationSyntax syntax,
        PackageSymbol package,
        StructSymbol structSymbol,
        StructMemberBindingContext memberBinding)
    {
        var existingNames = memberBinding.ExistingNames;
        var methodNames = memberBinding.MethodNames;

        if (syntax.SharedBlock != null)
        {
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
                    Diagnostics.ReportDataStructSynthesizedMemberConflict(methodSyntax.Identifier.Location, structSymbol.Name, structSymbol.IsClass, methodName);
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

                        // Issue #1262: `_` is the discard identifier — repeated `_` parameters are
                        // permitted on named functions/methods. Each `_` occupies a positional slot
                        // but is not added to the body scope, so non-`_` duplicates still error.
                        if (parameterName != "_" && !seenParameterNames.Add(parameterName))
                        {
                            Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
                        }
                        else
                        {
                            var staticMethodParam = new ParameterSymbol(parameterName, parameterType, isVariadic, declaringSyntax: parameterSyntax.Identifier, isScoped: parameterSyntax.IsScoped, refKind: parameterRefKind);
                            conversions.BindAndAttachParameterDefaultValue(parameterSyntax, staticMethodParam);
                            BindAndAttachParameterAttributes(parameterSyntax, staticMethodParam);
                            parameters.Add(staticMethodParam);
                        }
                    }

                    ValidateVariadicParameterShape(methodSyntax.Parameters);

                    var returnType = bindReturnTypeClause(methodSyntax.Type, methodSyntax.IsAsync) ?? TypeSymbol.Void;
                    var methodAccessibility = resolveAccessibility(methodSyntax.AccessibilityModifier);

                    // ADR-0146 (Kotlin visibility narrowing follow-up): infer/narrow the
                    // return type when the (omitted-type) body is `-> object { ... }`.
                    returnType = InferAnonymousClassLiteralReturnType(methodSyntax, returnType, methodAccessibility);

                    returnType = NormalizeAsyncDeclaredReturnType(returnType, methodSyntax.IsAsync, out var returnTypeIsValueTask);
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
                    methodSymbol.AsyncReturnsValueTask = returnTypeIsValueTask;
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

                    // ADR-0086 / issue #1203: a `shared`-block method may be a
                    // static P/Invoke (`@DllImport ... func F(...) R;`). Resolve
                    // and attach the PInvokeMetadata so the body-binder skips the
                    // (absent) body and the emitter writes the ImplMap row. A
                    // bodyless `shared` method that is NOT a P/Invoke is reported
                    // with GS0325, mirroring the top-level free-function path.
                    var isStaticPInvoke = PInvokeBinder.TryAttachPInvokeMetadata(methodSymbol, methodSyntax, Diagnostics);
                    if (!isStaticPInvoke && methodSyntax.HasSemicolonBody)
                    {
                        Diagnostics.ReportSemicolonBodyRequiresDllImport(methodSyntax.Identifier.Location, methodSymbol.Name);
                    }

                    if (!isStaticPInvoke)
                    {
                        PInvokeBinder.ReportMarshalAsOnNonPInvokeFunction(methodSyntax, Diagnostics);
                    }

                    // ADR-0063 §11: detect duplicate-signature within the static block.
                    var hasDupSig = false;
                    foreach (var existingMethod in staticMethodsBuilder)
                    {
                        if (BoundScope.FunctionSignaturesEqual(existingMethod, methodSymbol))
                        {
                            // ADR-0149 follow-up (issue #2370): mirrors the
                            // instance-method exemption above — two static
                            // methods that share a name and parameter shape
                            // may legitimately coexist when at least one
                            // carries an explicit-interface qualifier clause
                            // (`func (IFoo) M(...)` inside a `shared { }`
                            // block); each occupies its own distinct
                            // (interface, name) static-virtual slot, verified/
                            // deduplicated later by
                            // VerifyExplicitInterfaceClauseResolution's GS0495
                            // check, so this is not an ordinary overload
                            // collision.
                            if (methodSymbol.HasExplicitInterfaceClause || existingMethod.HasExplicitInterfaceClause)
                            {
                                continue;
                            }

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

            // Issue #1640: register shared/static method names too, so a
            // shared property/event/field colliding with a shared method name
            // is still caught (methods vs methods remain overload-compatible;
            // see the ADR-0063 signature check above).
            foreach (var m in staticMethodsBuilder)
            {
                methodNames.Add(m.Name);
            }
        }
    }

    private void BindStructSharedProperties(
        StructDeclarationSyntax syntax,
        PackageSymbol package,
        StructSymbol structSymbol,
        StructMemberBindingContext memberBinding)
    {
        var existingNames = memberBinding.ExistingNames;
        var methodNames = memberBinding.MethodNames;
        var explicitInterfaceClauseNames = memberBinding.ExplicitInterfaceClauseNames;

        if (syntax.SharedBlock != null)
        {
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

                // ADR-0149 follow-up (issue #2370): mirrors the instance-
                // property exemption above (`propExemptCollision`) — a static
                // property carrying an explicit-interface qualifier clause
                // may share its source name with another already-declared
                // static/shared member when at least one side is clause-
                // qualified (two same-named static-virtual interface slots
                // disambiguated by different target interfaces, or a plain
                // static member coexisting with a same-named explicit-clause
                // one). A duplicate SLOT claim (same clause target) is still
                // caught later by GS0495 in
                // VerifyExplicitInterfaceClauseResolution.
                var staticPropAlreadyDeclared = existingNames.Contains(propName);
                var staticPropExemptCollision = propSyntax.HasExplicitInterfaceClause || explicitInterfaceClauseNames.Contains(propName);
                if (methodNames.Contains(propName) || (staticPropAlreadyDeclared && !staticPropExemptCollision))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(propSyntax.Identifier.Location, propName);
                    continue;
                }

                existingNames.Add(propName);
                if (propSyntax.HasExplicitInterfaceClause)
                {
                    explicitInterfaceClauseNames.Add(propName);
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
                var getterAccessibility = propAccessibility;
                var setterAccessibility = propAccessibility;

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
                    var writeAccessor = setAccessor ?? initAccessor;
                    if (getAccessor?.AccessibilityModifier != null)
                    {
                        getterAccessibility = resolveAccessibility(getAccessor.AccessibilityModifier);
                    }

                    if (writeAccessor?.AccessibilityModifier != null)
                    {
                        setterAccessibility = resolveAccessibility(writeAccessor.AccessibilityModifier);
                    }

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
                    declaration: propSyntax,
                    getterAccessibility: getterAccessibility,
                    setterAccessibility: setterAccessibility);

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
                            getterAccessibility,
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
                            setterAccessibility,
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
        }
    }

    private void BindStructSharedEvents(
        StructDeclarationSyntax syntax,
        PackageSymbol package,
        StructSymbol structSymbol,
        StructMemberBindingContext memberBinding)
    {
        var existingNames = memberBinding.ExistingNames;
        var methodNames = memberBinding.MethodNames;

        if (syntax.SharedBlock != null)
        {
            // Static events
            var staticEventsBuilder = ImmutableArray.CreateBuilder<EventSymbol>();
            foreach (var eventSyntax in syntax.SharedBlock.Events)
            {
                var eventName = eventSyntax.Identifier.Text;
                if (methodNames.Contains(eventName) || !existingNames.Add(eventName))
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
                        isStatic: true,
                        isEventBackingField: true);
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
                eventSymbol.AddMethodSymbol.StaticOwnerType = structSymbol;
                eventSymbol.RemoveMethodSymbol = new FunctionSymbol(
                    $"remove_{eventName}",
                    ImmutableArray.Create(handlerParam),
                    TypeSymbol.Void,
                    declaration: null,
                    package,
                    eventAccessibility,
                    receiverType: null) { IsSpecialName = true };
                eventSymbol.RemoveMethodSymbol.IsStatic = true;
                eventSymbol.RemoveMethodSymbol.StaticOwnerType = structSymbol;

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
                    eventSymbol.RaiseMethodSymbol.StaticOwnerType = structSymbol;
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
    }

    private void RegisterStructConversionOperators(
        PackageSymbol package,
        List<(FunctionDeclarationSyntax Syntax, ImmutableArray<ParameterSymbol> Parameters, TypeSymbol ReturnType, Accessibility Accessibility, ImmutableArray<BoundAttribute> Attributes)> pendingConversionOperators)
    {
        // Issue #1283: register in-body conversion operators as static
        // `op_Implicit` / `op_Explicit` methods now that the static-method table
        // (which a `shared` block REPLACES via SetStaticMethods above) is final.
        // BindConversionOperatorDeclaration appends via AddStaticMethods, so the
        // operator coexists with any `shared`-block statics.
        foreach (var conversionOperator in pendingConversionOperators)
        {
            BindConversionOperatorDeclaration(
                conversionOperator.Syntax,
                conversionOperator.Parameters,
                conversionOperator.ReturnType,
                conversionOperator.Accessibility,
                package,
                conversionOperator.Attributes);
        }
    }

    private void RegisterStructDeferredInitializers(
        PackageSymbol package,
        StructSymbol structSymbol,
        StructFieldBindingResult fieldBinding)
    {
        var pendingConstInitializers = fieldBinding.PendingConstInitializers;
        var pendingSharedConstInitializers = fieldBinding.PendingSharedConstInitializers;
        var pendingStaticFieldInitializers = fieldBinding.PendingStaticFieldInitializers;
        var pendingInstanceInitializers = fieldBinding.PendingInstanceInitializers;
        var fields = fieldBinding.Fields;
        var primaryCtorParameters = fieldBinding.PrimaryConstructorParameters;

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
        // Issue #1194: defer field-initializer binding until after all
        // top-level functions are declared, so a field initializer can resolve
        // an unqualified call to a free function (declared later in
        // Binder.BindGlobalScope) and a sibling static method/const — matching
        // the visibility a constructor body already enjoys. The captured
        // `scope` is the live global scope object into which functions are
        // declared, so by the time this action runs they are present. The
        // enclosing type's static members (fields, consts, static properties,
        // static methods) are exposed by PushStaticMemberScope. Instance
        // members remain out of scope (a field initializer has no `this`), so
        // genuine instance-member references are still rejected below (GS0377).
        var fieldInitScope = scope;
        var fieldInitConstInitializers = pendingConstInitializers;
        var fieldInitSharedConstInitializers = pendingSharedConstInitializers;
        var fieldInitStaticInitializers = pendingStaticFieldInitializers;
        var fieldInitInstanceInitializers = pendingInstanceInitializers;
        var fieldInitFields = fields.ToImmutable();
        var fieldInitPrimaryCtorParameters = primaryCtorParameters;
        var fieldInitPackageName = package?.Name;
        pendingFieldInitializerBindings.Add(() =>
        {
            var savedFieldInitScope = scope;
            var savedFieldInitTypeParameters = binderCtx.CurrentTypeParameters;
            var savedFieldInitFunction = getCurrentFunction();
            scope = fieldInitScope;

            // Issue #2342: a deferred field initializer is bound long after the
            // outer per-declaration package-scoped RunWithPackage wrap
            // (Binder.BindGlobalScope) has already unwound, so re-establish
            // this type's OWN owning package as the ambient lookup preference
            // for the duration of this closure — otherwise an unqualified type
            // reference in the initializer could resolve against an unrelated
            // package's same-simple-name homonym.
            var savedFieldInitPackage = scope.SetCurrentDeclaringPackage(fieldInitPackageName);
            var savedFieldInitTree = scope.SetCurrentReferencingSyntaxTree(structSymbol.Declaration.SyntaxTree);

            // Issue #2111: a static field/property initializer is bound outside
            // any function body, so no "current function" is established. The
            // accessibility gate (AccessibilityChecker) derives the enclosing
            // type from the current function, so without one a `private`/
            // `protected` member of the ENCLOSING type accessed through a
            // type-qualified receiver (`Type.Member`) or a constructor call
            // (`Type()`) is wrongly rejected with GS0472 — even though the
            // initializer belongs to that very type. Establish the enclosing
            // type as the accessibility context for the duration of initializer
            // binding by installing a synthetic static function owned by
            // `structSymbol`, mirroring how a `shared` function body (which
            // already works) carries its `StaticOwnerType`.
            setCurrentFunction(CreateFieldInitializerAccessibilityContext(structSymbol));
            if (!structSymbol.TypeParameters.IsDefaultOrEmpty)
            {
                binderCtx.CurrentTypeParameters = new Dictionary<string, TypeParameterSymbol>();
                foreach (var tp in structSymbol.TypeParameters)
                {
                    binderCtx.CurrentTypeParameters[tp.Name] = tp;
                }
            }

            try
            {
                using (PushStaticMemberScope(structSymbol))
                {
                    BindDeferredFieldInitializers(
                        structSymbol,
                        fieldInitConstInitializers,
                        fieldInitSharedConstInitializers,
                        fieldInitStaticInitializers,
                        fieldInitInstanceInitializers,
                        fieldInitFields,
                        fieldInitPrimaryCtorParameters);
                }
            }
            finally
            {
                scope.SetCurrentDeclaringPackage(savedFieldInitPackage);
                scope.SetCurrentReferencingSyntaxTree(savedFieldInitTree);
                scope = savedFieldInitScope;
                binderCtx.CurrentTypeParameters = savedFieldInitTypeParameters;
                setCurrentFunction(savedFieldInitFunction);
            }
        });
    }

    private void RegisterStructInterfaceChecks(
        StructDeclarationSyntax syntax,
        StructSymbol structSymbol,
        StructBaseBindingResult baseBinding)
    {
        var implementedInterfaces = baseBinding.ImplementedInterfaces;
        var implementedClrInterfaces = baseBinding.ImplementedClrInterfaces;

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

        // ADR-0149: a type that declares an explicit-interface qualifier
        // clause (`func (X) M(...)` / `prop (X) P T` / `event (X) E T` /
        // a STATIC method or property inside a `shared { }` block, per the
        // #2370 "final completion pass" generalization) but implements NO
        // interface at all (neither G# nor CLR) would otherwise never reach
        // ResolveExplicitInterfaceClauses/VerifyExplicitInterfaceClauseResolution
        // (both driven off pendingInterfaceImplementationChecks) — silently
        // compiling the clause away as a no-op instead of reporting GS0492/
        // GS0493. Queue it too, purely so its clause(s) still get resolved
        // and diagnosed; with zero implemented interfaces, a non-interface
        // clause type is still caught by GS0492, and any interface type
        // (valid or not) is correctly rejected by GS0493 ("does not
        // implement interface X") since structSymbol.Interfaces is empty.
        // (Originally only checked Methods/Properties; Events and the STATIC
        // Methods/Properties collections had the identical gap — an explicit
        // clause on an event or static member of an interface-less type
        // silently compiled with no diagnostic at all — fixed here.)
        if (implementedInterfaces.Count == 0
            && implementedClrInterfaces.Count == 0
            && (HasAnyExplicitInterfaceClause(structSymbol.Methods)
                || HasAnyExplicitInterfaceClause(structSymbol.Properties)
                || HasAnyExplicitInterfaceClause(structSymbol.Events)
                || HasAnyExplicitInterfaceClause(structSymbol.StaticMethods)
                || HasAnyExplicitInterfaceClause(structSymbol.StaticProperties)))
        {
            pendingInterfaceImplementationChecks.Add((syntax, structSymbol));
        }
    }

    private void BindStructFinalMembers(
        StructDeclarationSyntax syntax,
        PackageSymbol package,
        StructSymbol structSymbol,
        StructBaseBindingResult baseBinding)
    {
        var baseClassSymbol = baseBinding.BaseClass;
        var importedBaseType = baseBinding.ImportedBaseType;

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
    /// Issue #2111: builds the synthetic static function used as the
    /// accessibility context while binding a type's deferred static/instance
    /// field and property initializers. The function carries no body and is
    /// never emitted; its sole purpose is to expose <paramref name="owner"/> as
    /// the enclosing type (via <see cref="FunctionSymbol.StaticOwnerType"/>) so
    /// that <see cref="AccessibilityChecker"/> treats a `private`/`protected`
    /// member of the enclosing type reached through a type-qualified receiver
    /// (`Type.Member`) or a constructor call (`Type()`) as accessible — matching
    /// how a `shared` function body already behaves.
    /// </summary>
    /// <param name="owner">The type whose initializers are being bound.</param>
    /// <returns>A synthetic static function owned by <paramref name="owner"/>.</returns>
    private static FunctionSymbol CreateFieldInitializerAccessibilityContext(StructSymbol owner)
    {
        var context = new FunctionSymbol(
            "<field-initializer>",
            ImmutableArray<ParameterSymbol>.Empty,
            TypeSymbol.Void)
        {
            IsStatic = true,
            StaticOwnerType = owner,
        };
        return context;
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

    private (FieldSymbol Field, BoundExpression Bound, TextLocation Location) BindConstFieldInitializer(FieldSymbol constField, FieldDeclarationSyntax fieldSyntaxNode, TypeSymbol fieldType)
    {
        var boundInit = bindExpression(fieldSyntaxNode.Initializer);
        var convertedInit = conversions.BindConversion(fieldSyntaxNode.Initializer.Location, boundInit, fieldType);
        var bound = boundInit is BoundErrorExpression || convertedInit is BoundErrorExpression
            ? (BoundExpression)new BoundErrorExpression(fieldSyntaxNode.Initializer)
            : convertedInit;
        return (constField, bound, fieldSyntaxNode.Initializer.Location);
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

        // Issue #1194: expose the enclosing type's static methods by bare name so
        // a field/const/base initializer can call a sibling `static` method
        // unqualified (matching C#). Declared as functions in the innermost
        // scope, they shadow any same-named free function — the C# member-lookup
        // order — and resolve through the normal free-function call path, which
        // emits a static call on the owning method.
        if (!structSymbol.StaticMethods.IsDefaultOrEmpty)
        {
            foreach (var method in structSymbol.StaticMethods)
            {
                staticScope.TryDeclareFunction(method);
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

    /// <summary>
    /// Issue #1194: binds the deferred field-initializer expressions for every
    /// type, run from <c>Binder.BindGlobalScope</c> after all top-level
    /// functions have been declared so a field initializer can resolve an
    /// unqualified free-function or sibling static-member call.
    /// </summary>
    internal void BindPendingFieldInitializers()
    {
        foreach (var bind in pendingFieldInitializerBindings)
        {
            bind();
        }

        pendingFieldInitializerBindings.Clear();
    }

    /// <summary>
    /// Issue #1194: binds a single type's deferred field/const/static
    /// initializers within the active static-member scope. Const initializers
    /// are folded with a fixpoint so sibling const references resolve regardless
    /// of declaration order (#1193); instance initializers reject instance
    /// member references (no <c>this</c> is available, GS0377).
    /// </summary>
    private void BindDeferredFieldInitializers(
        StructSymbol structSymbol,
        List<(FieldSymbol Field, FieldDeclarationSyntax Syntax, TypeSymbol FieldType)> constInitializers,
        List<(FieldSymbol Field, FieldDeclarationSyntax Syntax, TypeSymbol FieldType)> sharedConstInitializers,
        List<(FieldSymbol Field, ExpressionSyntax InitSyntax, TypeSymbol FieldType)> staticFieldInitializers,
        List<(FieldSymbol Field, ExpressionSyntax InitSyntax, TypeSymbol FieldType)> instanceInitializers,
        ImmutableArray<FieldSymbol> fields,
        ImmutableArray<ParameterSymbol> primaryCtorParameters)
    {
        // Fold const initializers with a fixpoint so a const that references a
        // sibling const folds regardless of declaration order (#1193). Each
        // initializer is bound exactly once (binding a const reference does not
        // require its value), then folding is retried until no further progress.
        // Class const initializers are seeded first so a `shared` const
        // referencing a class const can read its value.
        var pendingConstFolds = new List<(FieldSymbol Field, BoundExpression Bound, TextLocation Location)>();
        foreach (var (constField, fieldSyntaxNode, fieldType) in constInitializers)
        {
            pendingConstFolds.Add(BindConstFieldInitializer(constField, fieldSyntaxNode, fieldType));
        }

        foreach (var (constField, fieldSyntaxNode, fieldType) in sharedConstInitializers)
        {
            pendingConstFolds.Add(BindConstFieldInitializer(constField, fieldSyntaxNode, fieldType));
        }

        var progress = true;
        while (progress && pendingConstFolds.Count > 0)
        {
            progress = false;
            var stillPending = new List<(FieldSymbol Field, BoundExpression Bound, TextLocation Location)>();
            foreach (var item in pendingConstFolds)
            {
                if (TryFoldConstantFieldValue(item.Bound, item.Field.Type, out var constantValue))
                {
                    item.Field.SetConstantValue(constantValue);
                    progress = true;
                }
                else
                {
                    stillPending.Add(item);
                }
            }

            pendingConstFolds = stillPending;
        }

        // Report diagnostics for any const that still cannot fold (a genuinely
        // non-constant initializer or an unresolved cycle).
        foreach (var (constField, bound, location) in pendingConstFolds)
        {
            if (bound is not BoundErrorExpression)
            {
                Diagnostics.ReportConstFieldInitializerNotConstant(location, constField.Name);
            }
        }

        // Bind `shared` static field initializers.
        if (staticFieldInitializers.Count > 0)
        {
            var staticInitBuilder = ImmutableDictionary.CreateBuilder<FieldSymbol, BoundExpression>();
            foreach (var (fieldSym, initSyntax, fieldType) in staticFieldInitializers)
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
        if (instanceInitializers.Count > 0)
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
            foreach (var (fieldSym, initSyntax, fieldType) in instanceInitializers)
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
}
