// <copyright file="InterfaceSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a user-defined interface type (Phase 3.B.4 / ADR-0018).
/// Interfaces are CLR reference types (TypeAttributes.Interface | Abstract)
/// containing method signatures only — no bodies, no default impls,
/// no static members.
/// </summary>
public sealed class InterfaceSymbol : TypeSymbol
{
    private static readonly ConcurrentDictionary<(InterfaceSymbol Def, TypeArgsKey Args), InterfaceSymbol> ConstructedCache = new();

    private ImmutableArray<FunctionSymbol> methods;
    private ImmutableArray<FunctionSymbol> staticMethods = ImmutableArray<FunctionSymbol>.Empty;
    private ImmutableArray<FunctionSymbol> privateMethods = ImmutableArray<FunctionSymbol>.Empty;
    private ImmutableArray<FunctionSymbol> staticPrivateMethods = ImmutableArray<FunctionSymbol>.Empty;

    // ADR-0087 R5 / issue #765: constructed instances of a generic interface
    // may be created (e.g. as a base type on a class declaration) BEFORE the
    // definition's member-binding pass has run. <see cref="EnsureMembersResolved"/>
    // detects the staleness on the accessor hot-paths and re-substitutes
    // lazily so call-site dispatch through a constructed interface
    // (e.g. <c>IBox[int32].Get()</c>) succeeds.
    private bool membersResolved;

    /// <summary>Initializes a new instance of the <see cref="InterfaceSymbol"/> class.</summary>
    /// <param name="name">The interface type name.</param>
    /// <param name="accessibility">The interface's CLR accessibility.</param>
    /// <param name="declaration">The declaring syntax node.</param>
    /// <param name="packageName">The package this interface lives in.</param>
    public InterfaceSymbol(
        string name,
        Accessibility accessibility,
        InterfaceDeclarationSyntax declaration,
        string packageName)
        : base(name)
    {
        Accessibility = accessibility;
        Declaration = declaration;
        PackageName = packageName;
        Methods = ImmutableArray<FunctionSymbol>.Empty;
        Definition = this;
    }

    private InterfaceSymbol(InterfaceSymbol definition, ImmutableArray<TypeSymbol> typeArguments, string constructedName)
        : base(constructedName)
    {
        Accessibility = definition.Accessibility;
        Declaration = definition.Declaration;
        PackageName = definition.PackageName;
        Methods = ImmutableArray<FunctionSymbol>.Empty;
        TypeParameters = ImmutableArray<TypeParameterSymbol>.Empty;
        TypeArguments = typeArguments;
        Definition = definition;
    }

    /// <summary>Gets the interface accessibility.</summary>
    public Accessibility Accessibility { get; }

    /// <summary>Gets the declaring syntax node.</summary>
    public InterfaceDeclarationSyntax Declaration { get; private set; }

    /// <summary>Gets the package this interface lives in.</summary>
    public string PackageName { get; }

    /// <summary>Gets a value indicating whether this interface was declared <c>sealed</c> (Phase 3.B.5). All implementors must live in the same package; binder-enforced.</summary>
    public bool IsSealed => Declaration?.IsSealed ?? false;

    /// <summary>Gets the abstract method signatures declared on this interface. Populated by the binder via <see cref="SetMethods"/>.</summary>
    public ImmutableArray<FunctionSymbol> Methods
    {
        get
        {
            EnsureMembersResolved();
            return methods;
        }

        private set => methods = value;
    }

    /// <summary>Gets the static-virtual method signatures declared on this interface (ADR-0089 / issue #755). Populated by the binder via <see cref="SetStaticMethods"/>.</summary>
    public ImmutableArray<FunctionSymbol> StaticMethods
    {
        get
        {
            EnsureMembersResolved();
            return staticMethods;
        }

        private set => staticMethods = value;
    }

    /// <summary>
    /// Gets the <c>private</c> instance helper methods declared on this interface (ADR-0090 / issue #756).
    /// Private helpers are part of the interface's own implementation, not its
    /// public contract; the binder routes them here so the
    /// <see cref="Methods"/> set continues to drive implementer-contract
    /// verification (GS0187 / GS0320) unaffected. Populated by the binder via
    /// <see cref="SetPrivateMethods"/>.
    /// </summary>
    public ImmutableArray<FunctionSymbol> PrivateMethods
    {
        get
        {
            EnsureMembersResolved();
            return privateMethods;
        }

        private set => privateMethods = value;
    }

    /// <summary>
    /// Gets the <c>private static</c> helper methods declared on this interface (ADR-0090 / issue #756).
    /// (Combined private + ADR-0089 static-virtual surface.) Static-virtual
    /// dispatch through type-parameter constraints continues to use
    /// <see cref="StaticMethods"/>; private static helpers are never part of
    /// that dispatch table. Populated by the binder via
    /// <see cref="SetStaticPrivateMethods"/>.
    /// </summary>
    public ImmutableArray<FunctionSymbol> StaticPrivateMethods
    {
        get
        {
            EnsureMembersResolved();
            return staticPrivateMethods;
        }

        private set => staticPrivateMethods = value;
    }

    /// <summary>Gets a value indicating whether this interface declares at least one static-virtual member (ADR-0089).</summary>
    public bool HasStaticVirtualMembers => !StaticMethods.IsDefaultOrEmpty;

    /// <summary>Gets the property signatures declared on this interface (ADR-0051). Populated by the binder via <see cref="SetProperties"/>.</summary>
    public ImmutableArray<PropertySymbol> Properties { get; private set; } = ImmutableArray<PropertySymbol>.Empty;

    /// <summary>Gets the event signatures declared on this interface (ADR-0052). Populated by the binder via <see cref="SetEvents"/>.</summary>
    public ImmutableArray<EventSymbol> Events { get; private set; } = ImmutableArray<EventSymbol>.Empty;

    /// <summary>
    /// Gets the static fields declared inside the interface <c>shared { … }</c>
    /// block (ADR-0089 / issue #1030). CLR interfaces may own static fields;
    /// these are emitted as <c>Static</c> FieldDef rows on the interface
    /// TypeDef. Populated by the binder via <see cref="SetStaticFields"/>.
    /// </summary>
    public ImmutableArray<FieldSymbol> StaticFields { get; private set; } = ImmutableArray<FieldSymbol>.Empty;

    /// <summary>
    /// Gets the compile-time <c>const</c> fields declared inside the interface
    /// <c>shared { … }</c> block (issue #1030). Emitted as CLR <c>literal</c>
    /// fields with a <c>Constant</c> row; their reads are inlined. Held
    /// separately from <see cref="StaticFields"/> so no <c>.cctor</c> assignment
    /// is generated for them.
    /// </summary>
    public ImmutableArray<FieldSymbol> ConstFields { get; private set; } = ImmutableArray<FieldSymbol>.Empty;

    /// <summary>
    /// Gets the bound initializer expressions for interface static fields with
    /// non-default values (issue #1030). Keyed by field symbol; run in the
    /// interface's synthesized <c>.cctor</c> in <see cref="StaticFields"/>
    /// source order.
    /// </summary>
    public ImmutableDictionary<FieldSymbol, BoundExpression> StaticFieldInitializers { get; private set; } = ImmutableDictionary<FieldSymbol, BoundExpression>.Empty;

    /// <summary>
    /// Gets the directly-declared base interfaces (issue #1006), e.g. the
    /// <c>A</c> in <c>interface B : A</c>. Populated by the binder via
    /// <see cref="SetBaseInterfaces"/>. A base interface contributes its
    /// members to this interface's member-lookup surface and is emitted as an
    /// InterfaceImpl row on this interface's TypeDef.
    /// </summary>
    public ImmutableArray<InterfaceSymbol> BaseInterfaces { get; private set; } = ImmutableArray<InterfaceSymbol>.Empty;

    /// <summary>
    /// Gets the directly-declared base interfaces imported from metadata
    /// (issue #1006), e.g. <c>System.IDisposable</c> in
    /// <c>interface B : System.IDisposable</c>. These are CLR interface types
    /// surfaced through their <see cref="TypeSymbol.ClrType"/>.
    /// </summary>
    public ImmutableArray<TypeSymbol> BaseClrInterfaces { get; private set; } = ImmutableArray<TypeSymbol>.Empty;

    /// <summary>
    /// Gets the enclosing user-defined type when this interface is a nested
    /// type declaration (ADR-0110 / issue #910), or <c>null</c> when top-level.
    /// </summary>
    public TypeSymbol ContainingType { get; private set; }

    /// <summary>Gets the type parameters when this is a generic definition (Phase 4.3c / ADR-0020).</summary>
    public ImmutableArray<TypeParameterSymbol> TypeParameters { get; private set; } = ImmutableArray<TypeParameterSymbol>.Empty;

    /// <summary>Gets the type arguments when this is a constructed instance (Phase 4.3c / ADR-0020).</summary>
    public ImmutableArray<TypeSymbol> TypeArguments { get; private set; } = ImmutableArray<TypeSymbol>.Empty;

    /// <summary>Gets a value indicating whether this is a generic definition (has type parameters and no type arguments).</summary>
    public bool IsGenericDefinition => !TypeParameters.IsDefaultOrEmpty && TypeArguments.IsDefaultOrEmpty;

    /// <summary>Gets the original generic definition when this is a constructed instance; otherwise <c>this</c>.</summary>
    public InterfaceSymbol Definition { get; }

    /// <summary>Sets <see cref="ContainingType"/> (ADR-0110 / issue #910).</summary>
    /// <param name="containingType">The enclosing user-defined type.</param>
    public void SetContainingType(TypeSymbol containingType)
    {
        ContainingType = containingType;
    }

    /// <summary>Sets <see cref="Methods"/>. Intended to be called once by the binder.</summary>
    /// <param name="methods">The bound method signatures.</param>
    public void SetMethods(ImmutableArray<FunctionSymbol> methods)
    {
        Methods = methods;
    }

    /// <summary>Sets <see cref="BaseInterfaces"/> (issue #1006). Intended to be called once by the binder.</summary>
    /// <param name="baseInterfaces">The directly-declared user base interfaces.</param>
    public void SetBaseInterfaces(ImmutableArray<InterfaceSymbol> baseInterfaces)
    {
        BaseInterfaces = baseInterfaces;
    }

    /// <summary>Sets <see cref="BaseClrInterfaces"/> (issue #1006). Intended to be called once by the binder.</summary>
    /// <param name="baseClrInterfaces">The directly-declared imported CLR base interfaces.</param>
    public void SetBaseClrInterfaces(ImmutableArray<TypeSymbol> baseClrInterfaces)
    {
        BaseClrInterfaces = baseClrInterfaces;
    }

    /// <summary>
    /// Issue #1006: enumerates this interface together with the transitive
    /// closure of its user base interfaces (<see cref="BaseInterfaces"/>),
    /// each appearing once. <c>this</c> is yielded first, then bases in
    /// declaration order, depth-first. Used by member lookup and by the
    /// implementer-contract verification so an <c>interface B : A</c> surfaces
    /// <c>A</c>'s members.
    /// </summary>
    /// <returns>The self-and-bases set, deduplicated by reference.</returns>
    public IEnumerable<InterfaceSymbol> SelfAndAllBaseInterfaces()
    {
        var seen = new HashSet<InterfaceSymbol>();
        var ordered = new List<InterfaceSymbol>();
        var visiting = new Stack<InterfaceSymbol>();
        visiting.Push(this);
        while (visiting.Count > 0)
        {
            var current = visiting.Pop();
            if (!seen.Add(current))
            {
                continue;
            }

            ordered.Add(current);
            if (!current.BaseInterfaces.IsDefaultOrEmpty)
            {
                // Push in reverse so declaration order is preserved on pop.
                for (var i = current.BaseInterfaces.Length - 1; i >= 0; i--)
                {
                    visiting.Push(current.BaseInterfaces[i]);
                }
            }
        }

        return ordered;
    }

    /// <summary>Sets <see cref="StaticMethods"/>. Intended to be called once by the binder (ADR-0089 / issue #755).</summary>
    /// <param name="methods">The bound static-virtual method signatures.</param>
    public void SetStaticMethods(ImmutableArray<FunctionSymbol> methods)
    {
        StaticMethods = methods;
    }

    /// <summary>Sets <see cref="PrivateMethods"/>. Intended to be called once by the binder (ADR-0090 / issue #756).</summary>
    /// <param name="methods">The bound private instance helper signatures.</param>
    public void SetPrivateMethods(ImmutableArray<FunctionSymbol> methods)
    {
        PrivateMethods = methods;
    }

    /// <summary>Sets <see cref="StaticPrivateMethods"/>. Intended to be called once by the binder (ADR-0090 / issue #756).</summary>
    /// <param name="methods">The bound private static helper signatures.</param>
    public void SetStaticPrivateMethods(ImmutableArray<FunctionSymbol> methods)
    {
        StaticPrivateMethods = methods;
    }

    /// <summary>
    /// ADR-0090 / issue #756: returns every <c>private</c> instance helper whose name equals <paramref name="name"/>.
    /// Used by call-site visibility checks: callers inside the same interface
    /// declaration see this overload set; external callers do not.
    /// </summary>
    /// <param name="name">The helper name.</param>
    /// <returns>The overload set; empty when none.</returns>
    public ImmutableArray<FunctionSymbol> GetPrivateMethods(string name)
    {
        EnsureMembersResolved();
        if (PrivateMethods.IsDefaultOrEmpty)
        {
            return ImmutableArray<FunctionSymbol>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<FunctionSymbol>();
        foreach (var m in PrivateMethods)
        {
            if (m.Name == name)
            {
                builder.Add(m);
            }
        }

        return builder.ToImmutable();
    }

    /// <summary>
    /// ADR-0090 / issue #756: returns every <c>private static</c> helper whose name equals <paramref name="name"/>.
    /// </summary>
    /// <param name="name">The helper name.</param>
    /// <returns>The overload set; empty when none.</returns>
    public ImmutableArray<FunctionSymbol> GetStaticPrivateMethods(string name)
    {
        EnsureMembersResolved();
        if (StaticPrivateMethods.IsDefaultOrEmpty)
        {
            return ImmutableArray<FunctionSymbol>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<FunctionSymbol>();
        foreach (var m in StaticPrivateMethods)
        {
            if (m.Name == name)
            {
                builder.Add(m);
            }
        }

        return builder.ToImmutable();
    }

    /// <summary>Tries to look up a static-virtual interface method by name (ADR-0089 / issue #755).</summary>
    /// <param name="name">The method name.</param>
    /// <param name="method">The found method on success.</param>
    /// <returns>True if found.</returns>
    public bool TryGetStaticMethod(string name, out FunctionSymbol method)
    {
        EnsureMembersResolved();
        if (!StaticMethods.IsDefaultOrEmpty)
        {
            foreach (var m in StaticMethods)
            {
                if (m.Name == name)
                {
                    method = m;
                    return true;
                }
            }
        }

        method = null;
        return false;
    }

    /// <summary>Returns every static-virtual interface method whose name equals <paramref name="name"/> (ADR-0089).</summary>
    /// <param name="name">The method name.</param>
    /// <returns>The overload set; empty when none.</returns>
    public ImmutableArray<FunctionSymbol> GetStaticMethods(string name)
    {
        EnsureMembersResolved();
        if (StaticMethods.IsDefaultOrEmpty)
        {
            return ImmutableArray<FunctionSymbol>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<FunctionSymbol>();
        foreach (var m in StaticMethods)
        {
            if (m.Name == name)
            {
                builder.Add(m);
            }
        }

        return builder.ToImmutable();
    }

    /// <summary>Sets <see cref="Properties"/>. Intended to be called once by the binder (ADR-0051).</summary>
    /// <param name="properties">The bound property signatures.</param>
    public void SetProperties(ImmutableArray<PropertySymbol> properties)
    {
        Properties = properties;
    }

    /// <summary>Sets <see cref="Events"/>. Intended to be called once by the binder (ADR-0052).</summary>
    /// <param name="events">The bound event signatures.</param>
    public void SetEvents(ImmutableArray<EventSymbol> events)
    {
        Events = events;
    }

    /// <summary>Sets <see cref="StaticFields"/> after binding interface shared-block field declarations (issue #1030).</summary>
    /// <param name="fields">The bound static fields in declared order.</param>
    public void SetStaticFields(ImmutableArray<FieldSymbol> fields)
    {
        StaticFields = fields;
    }

    /// <summary>Sets <see cref="ConstFields"/> after binding interface <c>const</c> field declarations (issue #1030).</summary>
    /// <param name="fields">The bound const fields in declared order.</param>
    public void SetConstFields(ImmutableArray<FieldSymbol> fields)
    {
        ConstFields = fields;
    }

    /// <summary>Sets <see cref="StaticFieldInitializers"/> after binding interface shared-block field initializers (issue #1030).</summary>
    /// <param name="initializers">The bound initializer expressions keyed by field.</param>
    public void SetStaticFieldInitializers(ImmutableDictionary<FieldSymbol, BoundExpression> initializers)
    {
        StaticFieldInitializers = initializers;
    }

    /// <summary>
    /// Looks up an interface static field (storage or const) by name (issue
    /// #1030). Returns <c>null</c> when no such field exists.
    /// </summary>
    /// <param name="name">The field name.</param>
    /// <returns>The matching <see cref="FieldSymbol"/>, or <c>null</c>.</returns>
    public FieldSymbol GetStaticField(string name)
    {
        if (!StaticFields.IsDefaultOrEmpty)
        {
            foreach (var f in StaticFields)
            {
                if (f.Name == name)
                {
                    return f;
                }
            }
        }

        if (!ConstFields.IsDefaultOrEmpty)
        {
            foreach (var f in ConstFields)
            {
                if (f.Name == name)
                {
                    return f;
                }
            }
        }

        return null;
    }

    /// <summary>Sets <see cref="TypeParameters"/> on a generic definition (Phase 4.3c). Intended to be called once by the binder.</summary>
    /// <param name="typeParameters">The bound type parameters in declared order.</param>
    public void SetTypeParameters(ImmutableArray<TypeParameterSymbol> typeParameters)
    {
        TypeParameters = typeParameters;
    }

    /// <summary>Tries to look up an interface method by name.</summary>
    /// <param name="name">The method name.</param>
    /// <param name="method">The found method on success.</param>
    /// <returns>True if found.</returns>
    public bool TryGetMethod(string name, out FunctionSymbol method)
    {
        EnsureMembersResolved();
        foreach (var m in Methods)
        {
            if (m.Name == name)
            {
                method = m;
                return true;
            }
        }

        method = null;
        return false;
    }

    /// <summary>
    /// ADR-0063: returns every interface method whose name equals <paramref name="name"/> (the overload set).
    /// </summary>
    /// <param name="name">The method name.</param>
    /// <returns>The overload set; empty if none.</returns>
    public ImmutableArray<FunctionSymbol> GetMethods(string name)
    {
        EnsureMembersResolved();
        if (Methods.IsDefaultOrEmpty)
        {
            return ImmutableArray<FunctionSymbol>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<FunctionSymbol>();
        foreach (var m in Methods)
        {
            if (m.Name == name)
            {
                builder.Add(m);
            }
        }

        return builder.ToImmutable();
    }

    /// <summary>
    /// Constructs a closed instance of a generic interface definition with the supplied type arguments
    /// (Phase 4.3c / ADR-0020). Method signatures are substituted; identity is cached so two calls with
    /// the same definition + arguments return the same <see cref="InterfaceSymbol"/> reference.
    /// </summary>
    /// <param name="definition">The generic definition to instantiate.</param>
    /// <param name="typeArguments">The type arguments. Length must match <see cref="TypeParameters"/>.</param>
    /// <returns>A constructed <see cref="InterfaceSymbol"/> whose <see cref="Definition"/> is the original.</returns>
    public static InterfaceSymbol Construct(InterfaceSymbol definition, ImmutableArray<TypeSymbol> typeArguments)
    {
        if (definition == null || !definition.IsGenericDefinition)
        {
            return definition;
        }

        var key = BuildArgsKey(typeArguments);
        return ConstructedCache.GetOrAdd((definition, key), _ => CreateConstructed(definition, typeArguments));
    }

    /// <summary>
    /// ADR-0085 / issue #726: returns true when <paramref name="method"/> is
    /// a default-interface method on this interface — i.e. its declaring
    /// <see cref="FunctionSymbol.Declaration"/> carries a non-null
    /// <c>Body</c>. Abstract interface methods return false.
    /// </summary>
    /// <param name="method">The interface method to inspect.</param>
    /// <returns>True when the method has a default body.</returns>
    public static bool HasDefaultBody(FunctionSymbol method)
    {
        return method != null && method.Declaration?.Body != null;
    }

    /// <summary>
    /// ADR-0105 Phase 2 — re-points this (reused) interface symbol at the
    /// declaration node of a freshly-parsed syntax tree whose declaration is
    /// byte-identical to the previous one (a body-only edit). Only the backing
    /// syntax — and therefore source spans — changes; the symbol's identity and
    /// its method symbols are preserved so cross-compilation reuse stays sound.
    /// The interface's default/private/static-virtual method bodies are
    /// re-pointed separately via their <see cref="FunctionSymbol.RepointDeclaration(FunctionDeclarationSyntax)"/>.
    /// Intended to be called only by <see cref="Binding.IncrementalGlobalScopeReuse"/>.
    /// </summary>
    /// <param name="declaration">The corresponding declaration in the re-parsed tree.</param>
    internal void RepointDeclaration(InterfaceDeclarationSyntax declaration)
    {
        Declaration = declaration;
    }

    /// <summary>
    /// Ensures the lazy member tables (<see cref="Methods"/>, <see cref="StaticMethods"/>,
    /// <see cref="PrivateMethods"/>, <see cref="StaticPrivateMethods"/>) of a constructed
    /// generic interface instance have been substituted/populated. Idempotent. Exposed as
    /// <c>internal</c> (ADR-0112 A9) so <see cref="TypeMemberModel"/> can guarantee the same
    /// resolution the per-accessor getters perform before enumerating member tables directly.
    /// </summary>
    internal void EnsureMembersResolved()
    {
        if (membersResolved)
        {
            return;
        }

        TryResolveMembers();
    }

    private static TypeArgsKey BuildArgsKey(ImmutableArray<TypeSymbol> typeArguments) => new(typeArguments);

    private static InterfaceSymbol CreateConstructed(InterfaceSymbol definition, ImmutableArray<TypeSymbol> typeArguments)
    {
        var argParts = new string[typeArguments.Length];
        for (var i = 0; i < typeArguments.Length; i++)
        {
            argParts[i] = typeArguments[i].Name;
        }

        var constructedName = $"{definition.Name}[{string.Join(", ", argParts)}]";
        var instance = new InterfaceSymbol(definition, typeArguments, constructedName);

        // ADR-0087 R5 / issue #765: defer the actual member substitution
        // (Methods / StaticMethods / PrivateMethods / StaticPrivateMethods)
        // to first access through <see cref="EnsureMembersResolved"/>.
        // Eager substitution at construction time produced stale-empty lists
        // when the constructed instance is built before the definition's
        // member-binding pass has populated them (e.g. when a class
        // declaration's base-type clause references `IBox[int32]` before
        // `BindInterfaceMembers` runs on `IBox`). Lazy resolution keeps the
        // construction cheap and self-heals once the definition is complete.
        instance.TryResolveMembers();
        return instance;
    }

    private static FunctionSymbol SubstituteMethod(
        FunctionSymbol m,
        Dictionary<TypeParameterSymbol, TypeSymbol> subst,
        InterfaceSymbol instance,
        bool isStatic,
        bool isPrivate)
    {
        var substParams = ImmutableArray.CreateBuilder<ParameterSymbol>(m.Parameters.Length);
        foreach (var p in m.Parameters)
        {
            var newParam = new ParameterSymbol(p.Name, SubstituteType(p.Type, subst), isVariadic: p.IsVariadic, isScoped: p.IsScoped, refKind: p.RefKind);
            if (p.HasExplicitDefaultValue)
            {
                newParam.SetExplicitDefaultValue(p.ExplicitDefaultValue);
            }

            substParams.Add(newParam);
        }

        var substReturn = SubstituteType(m.Type, subst);
        var substMethod = new FunctionSymbol(
            m.Name,
            substParams.MoveToImmutable(),
            substReturn,
            m.Declaration,
            m.Package,
            m.Accessibility,
            receiverType: isPrivate ? instance : null);
        if (isStatic)
        {
            substMethod.IsStatic = true;
            substMethod.StaticOwnerType = instance;
        }

        return substMethod;
    }

    private void TryResolveMembers()
    {
        // Only constructed instances need substitution. Definitions return
        // their own pre-populated member lists.
        if (Definition == null || ReferenceEquals(Definition, this))
        {
            membersResolved = true;
            return;
        }

        var defMethods = Definition.Methods;
        var defStatic = Definition.StaticMethods;
        var defPriv = Definition.PrivateMethods;
        var defStaticPriv = Definition.StaticPrivateMethods;

        // Members aren't populated yet on the definition; try again later.
        var defHasAnything = (!defMethods.IsDefaultOrEmpty)
            || (!defStatic.IsDefaultOrEmpty)
            || (!defPriv.IsDefaultOrEmpty)
            || (!defStaticPriv.IsDefaultOrEmpty);
        if (!defHasAnything)
        {
            return;
        }

        var subst = new Dictionary<TypeParameterSymbol, TypeSymbol>(Definition.TypeParameters.Length);
        for (var i = 0; i < Definition.TypeParameters.Length; i++)
        {
            subst[Definition.TypeParameters[i]] = TypeArguments[i];
        }

        if (!defMethods.IsDefaultOrEmpty)
        {
            var builder = ImmutableArray.CreateBuilder<FunctionSymbol>(defMethods.Length);
            foreach (var m in defMethods)
            {
                builder.Add(SubstituteMethod(m, subst, this, isStatic: false, isPrivate: false));
            }

            Methods = builder.MoveToImmutable();
        }

        if (!defStatic.IsDefaultOrEmpty)
        {
            var builder = ImmutableArray.CreateBuilder<FunctionSymbol>(defStatic.Length);
            foreach (var m in defStatic)
            {
                builder.Add(SubstituteMethod(m, subst, this, isStatic: true, isPrivate: false));
            }

            StaticMethods = builder.MoveToImmutable();
        }

        if (!defPriv.IsDefaultOrEmpty)
        {
            var builder = ImmutableArray.CreateBuilder<FunctionSymbol>(defPriv.Length);
            foreach (var m in defPriv)
            {
                builder.Add(SubstituteMethod(m, subst, this, isStatic: false, isPrivate: true));
            }

            PrivateMethods = builder.MoveToImmutable();
        }

        if (!defStaticPriv.IsDefaultOrEmpty)
        {
            var builder = ImmutableArray.CreateBuilder<FunctionSymbol>(defStaticPriv.Length);
            foreach (var m in defStaticPriv)
            {
                builder.Add(SubstituteMethod(m, subst, this, isStatic: true, isPrivate: true));
            }

            StaticPrivateMethods = builder.MoveToImmutable();
        }

        membersResolved = true;
    }

    private static TypeSymbol SubstituteType(TypeSymbol type, Dictionary<TypeParameterSymbol, TypeSymbol> subst)
    {
        if (type is TypeParameterSymbol tp && subst.TryGetValue(tp, out var concrete))
        {
            return concrete;
        }

        // Issue #974: a constructed generic interface used as a member type
        // (e.g. a base interface `ISeq[T]` exposing `IComparable[T]`) carries
        // the definition's type parameters in its arguments. Recurse so they
        // are substituted with this constructed instance's type arguments.
        if (type is InterfaceSymbol iface && !iface.TypeArguments.IsDefaultOrEmpty)
        {
            var substitutedArgs = ImmutableArray.CreateBuilder<TypeSymbol>(iface.TypeArguments.Length);
            var changed = false;
            for (var i = 0; i < iface.TypeArguments.Length; i++)
            {
                var substituted = SubstituteType(iface.TypeArguments[i], subst);
                substitutedArgs.Add(substituted);
                changed |= !ReferenceEquals(substituted, iface.TypeArguments[i]);
            }

            return changed
                ? Construct(iface.Definition, substitutedArgs.MoveToImmutable())
                : iface;
        }

        // Issue #974: a member type that is a constructed imported generic over
        // the interface's type parameter (e.g. `func Iter() IEnumerator[T]`)
        // must have its symbolic type arguments rewritten so the constructed
        // interface exposes `IEnumerator[T_class]` rather than the definition's
        // `IEnumerator[T_iface]`. Mirrors StructSymbol's construction-time
        // substitution.
        if (type is ImportedTypeSymbol imported
            && imported.OpenDefinition != null
            && !imported.TypeArguments.IsDefaultOrEmpty)
        {
            var substitutedArgs = ImmutableArray.CreateBuilder<TypeSymbol>(imported.TypeArguments.Length);
            var changed = false;
            for (var i = 0; i < imported.TypeArguments.Length; i++)
            {
                var substituted = SubstituteType(imported.TypeArguments[i], subst);
                substitutedArgs.Add(substituted);
                changed |= !ReferenceEquals(substituted, imported.TypeArguments[i]);
            }

            if (!changed)
            {
                return imported;
            }

            var resolvedClrArgs = new System.Type[substitutedArgs.Count];
            for (var i = 0; i < substitutedArgs.Count; i++)
            {
                resolvedClrArgs[i] = substitutedArgs[i].ClrType ?? typeof(object);
            }

            try
            {
                var closed = imported.OpenDefinition.MakeGenericType(resolvedClrArgs);
                return ImportedTypeSymbol.GetConstructed(closed, imported.OpenDefinition, substitutedArgs.MoveToImmutable());
            }
            catch (System.ArgumentException)
            {
                return imported;
            }
        }

        if (type is SliceTypeSymbol s)
        {
            var sub = SubstituteType(s.ElementType, subst);
            return sub == s.ElementType ? s : SliceTypeSymbol.Get(sub);
        }

        if (type is ArrayTypeSymbol a)
        {
            var sub = SubstituteType(a.ElementType, subst);
            return sub == a.ElementType ? a : ArrayTypeSymbol.Get(sub, a.Length);
        }

        if (type is NullableTypeSymbol n)
        {
            var sub = SubstituteType(n.UnderlyingType, subst);
            return sub == n.UnderlyingType ? n : NullableTypeSymbol.Get(sub);
        }

        return type;
    }
}
