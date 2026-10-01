// <copyright file="TupleTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Linq;
using System.Text;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a tuple type <c>(T1, T2, ...)</c> (Phase 4.5).
/// </summary>
/// <remarks>
/// Backed by the CLR <c>System.ValueTuple&lt;...&gt;</c> family. Instances are
/// cached per element-type sequence so identical tuple types compare by
/// reference. Arity 8 and higher use the CLR's canonical
/// <c>ValueTuple&lt;T1,...,T7,TRest&gt;</c> nesting.
/// </remarks>
public sealed class TupleTypeSymbol : TypeSymbol
{
    /// <summary>The full-name prefix of the CLR family a tuple IS (ADR-0158).</summary>
    private const string ValueTupleDefinitionPrefix = "System.ValueTuple`";

    private static readonly ConcurrentDictionary<string, TupleTypeSymbol> Cache = new();

    private TupleTypeSymbol(ImmutableArray<TypeSymbol> elementTypes, ImmutableArray<string?> elementNames)

        // TypeSymbol's legacy CLR-type constructor accepts null for symbolic
        // same-compilation element types. Element names never affect the CLR
        // backing (ADR-0172: names are metadata over the positional shape).
        : base(BuildName(elementTypes, elementNames), BuildClrType(elementTypes))
    {
        ElementTypes = elementTypes;
        ElementNames = elementNames;
    }

    /// <summary>Gets the tuple element types in declaration order.</summary>
    public ImmutableArray<TypeSymbol> ElementTypes { get; }

    /// <summary>
    /// Gets the declared element names, parallel to
    /// <see cref="ElementTypes"/> with <see langword="null"/> at unnamed
    /// positions — or an empty array for a fully unnamed tuple (ADR-0172).
    /// Names are metadata: they never affect the CLR backing, conversions,
    /// or equality; same-shape tuples differing only in names are related by
    /// an identity conversion.
    /// </summary>
    public ImmutableArray<string?> ElementNames { get; }

    /// <summary>Gets a value indicating whether any element declares a name.</summary>
    public bool HasNames => !ElementNames.IsDefaultOrEmpty;

    /// <summary>Gets the arity of the tuple.</summary>
    public int Arity => ElementTypes.Length;

    /// <inheritdoc/>
    public override bool IsTupleType => true;

    /// <summary>
    /// Gets the positional tuple elements as field symbols — the Roslyn
    /// <c>INamedTypeSymbol.TupleElements</c> analogue (ADR-0169, issue #3794).
    ///
    /// <para>
    /// Without this override the base returned EMPTY, so a migrated analyzer
    /// that walks a tuple's elements (GSA0004's cache-key inspection is
    /// exactly that) saw a tuple with no components and silently concluded
    /// the key mentioned nothing — reporting nothing at all. Elements are
    /// named after their declared name where ADR-0172 gives one, and
    /// <c>Item1..ItemN</c> otherwise, which is what Roslyn does.
    /// </para>
    /// </summary>
    public override ImmutableArray<FieldSymbol> TupleElements
    {
        get
        {
            var builder = ImmutableArray.CreateBuilder<FieldSymbol>(ElementTypes.Length);
            for (var i = 0; i < ElementTypes.Length; i++)
            {
                string? declared = ElementNames.IsDefaultOrEmpty ? null : ElementNames[i];
                string elementName = string.IsNullOrEmpty(declared) ? $"Item{i + 1}" : declared;
                builder.Add(new FieldSymbol(
                    elementName,
                    ElementTypes[i],
                    Accessibility.Public,
                    isReadOnly: true));
            }

            return builder.MoveToImmutable();
        }
    }

    /// <summary>Returns the cached <see cref="TupleTypeSymbol"/> for the given element types.</summary>
    /// <param name="elementTypes">The element types in order.</param>
    /// <returns>The (cached) tuple type symbol.</returns>
    public static TupleTypeSymbol Get(ImmutableArray<TypeSymbol> elementTypes)
        => Get(elementTypes, elementNames: default);

    /// <summary>
    /// Returns the cached <see cref="TupleTypeSymbol"/> for the given element
    /// types and names (ADR-0172). A default/empty or all-<see langword="null"/>
    /// name array yields the canonical unnamed tuple.
    /// </summary>
    /// <param name="elementTypes">The element types in order.</param>
    /// <param name="elementNames">The element names, parallel to <paramref name="elementTypes"/>, <see langword="null"/> where unnamed.</param>
    /// <returns>The (cached) tuple type symbol.</returns>
    public static TupleTypeSymbol Get(ImmutableArray<TypeSymbol> elementTypes, ImmutableArray<string?> elementNames)
    {
        if (elementTypes.IsDefaultOrEmpty || elementTypes.Length < 2)
        {
            throw new ArgumentException("Tuples must have at least two element types.", nameof(elementTypes));
        }

        if (!elementNames.IsDefaultOrEmpty && elementNames.Length != elementTypes.Length)
        {
            throw new ArgumentException("Element names must parallel element types.", nameof(elementNames));
        }

        if (!elementNames.IsDefaultOrEmpty && elementNames.All(n => n == null))
        {
            elementNames = ImmutableArray<string?>.Empty;
        }

        if (elementNames.IsDefault)
        {
            elementNames = ImmutableArray<string?>.Empty;
        }

        // Issue #1624: key on element-type *identity* (via FunctionTypeSymbol's
        // shared identity-key builder), not the display name. A name-based key
        // (e.g. "(Holder, string)") can alias two distinct same-named types
        // from different compilations; the previous fix (#649) validated
        // identity on lookup but then racily overwrote the cache entry on a
        // mismatch, so concurrent callers could still observe two distinct
        // instances for the same elements. GetOrAdd is atomic, so no overwrite
        // is needed once the key itself is identity-correct.
        var keyBuilder = new StringBuilder();
        for (var i = 0; i < elementTypes.Length; i++)
        {
            if (i > 0)
            {
                keyBuilder.Append(',');
            }

            FunctionTypeSymbol.AppendIdentityKey(keyBuilder, elementTypes[i]);
        }

        // ADR-0172: names participate in the cache key (a named and an
        // unnamed same-shape tuple are distinct interned symbols related by
        // an identity conversion), with an empty suffix for the canonical
        // unnamed tuple so pre-existing keys are unchanged.
        if (elementNames.Length > 0)
        {
            keyBuilder.Append('|');
            for (var i = 0; i < elementNames.Length; i++)
            {
                if (i > 0)
                {
                    keyBuilder.Append(',');
                }

                keyBuilder.Append(elementNames[i]);
            }
        }

        var key = keyBuilder.ToString();
        return Cache.GetOrAdd(key, _ => new TupleTypeSymbol(elementTypes, elementNames));
    }

    /// <summary>
    /// Returns the canonical fully unnamed tuple of this tuple's shape,
    /// recursively stripping names from nested tuple elements (ADR-0172).
    /// Two tuples denote the same type exactly when their
    /// <see cref="WithoutNames"/> results are reference-equal.
    /// </summary>
    /// <returns>The (cached) unnamed same-shape tuple symbol.</returns>
    public TupleTypeSymbol WithoutNames()
    {
        var stripped = ImmutableArray.CreateBuilder<TypeSymbol>(ElementTypes.Length);
        var changed = HasNames;
        foreach (var elementType in ElementTypes)
        {
            var strippedElement = StripNames(elementType);
            stripped.Add(strippedElement);
            changed |= !ReferenceEquals(strippedElement, elementType);
        }

        return changed ? Get(stripped.MoveToImmutable()) : this;
    }

    /// <summary>
    /// Finds the zero-based position of a declared element name (ordinal,
    /// case-sensitive), or returns <see langword="false"/>.
    /// </summary>
    /// <param name="name">The element name to find.</param>
    /// <param name="index">The zero-based element index when found.</param>
    /// <returns>Whether the name is declared on this tuple.</returns>
    public bool TryGetElementIndexByName(string name, out int index)
    {
        if (HasNames)
        {
            for (var i = 0; i < ElementNames.Length; i++)
            {
                if (string.Equals(ElementNames[i], name, StringComparison.Ordinal))
                {
                    index = i;
                    return true;
                }
            }
        }

        index = -1;
        return false;
    }

    /// <summary>
    /// Issue #3987: recognizes a tuple-shaped type by SHAPE rather than by
    /// spelling — G#'s own <see cref="TupleTypeSymbol"/>, or the
    /// <c>System.ValueTuple&lt;…&gt;</c> it IS (ADR-0158 identity) arriving from
    /// metadata as an <see cref="ImportedTypeSymbol"/> — and yields its
    /// elements FLATTENED through the canonical
    /// <c>ValueTuple&lt;T1..T7, TRest&gt;</c> nesting.
    /// </summary>
    /// <remarks>
    /// The direct analogue of <see cref="ChannelTypeSymbol.TryGetChannelShape"/>
    /// and <see cref="MapTypeSymbol.TryGetMapShape"/>. Flattening is not
    /// optional: an 8-or-more-element tuple is a NESTED
    /// <c>ValueTuple&lt;…, TRest&gt;</c> on the imported side and a flat element
    /// list on G#'s side, so comparing arity without unwinding the chain would
    /// exclude exactly the long tuples.
    /// </remarks>
    /// <param name="type">The candidate type.</param>
    /// <param name="elementTypes">The recovered, flattened element types.</param>
    /// <returns>True when <paramref name="type"/> is tuple-shaped.</returns>
    public static bool TryGetTupleShape(
        TypeSymbol? type,
        out ImmutableArray<TypeSymbol> elementTypes)
    {
        elementTypes = default;
        if (type is NullabilityAnnotatedTypeSymbol annotated)
        {
            return TryGetTupleShape(annotated.BaseType, out elementTypes);
        }

        if (type is not (TupleTypeSymbol or ImportedTypeSymbol))
        {
            return false;
        }

        var builder = ImmutableArray.CreateBuilder<TypeSymbol>();
        if (!TryFlattenTupleShape(type, builder) || builder.Count < 2)
        {
            return false;
        }

        elementTypes = builder.ToImmutable();
        return true;
    }

    /// <summary>
    /// Removes all entries from the static type cache. Called by
    /// <see cref="ReferenceResolver.Dispose"/> to release stale
    /// <see cref="Type"/> objects backed by a disposed metadata load context
    /// that would otherwise pin the context's memory indefinitely.
    /// </summary>
    internal static void ClearCache() => Cache.Clear();

    internal static Type GetOpenClrType(int arity)
        => arity switch
        {
            1 => typeof(ValueTuple<>),
            2 => typeof(ValueTuple<,>),
            3 => typeof(ValueTuple<,,>),
            4 => typeof(ValueTuple<,,,>),
            5 => typeof(ValueTuple<,,,,>),
            6 => typeof(ValueTuple<,,,,,>),
            7 => typeof(ValueTuple<,,,,,,>),
            8 => typeof(ValueTuple<,,,,,,,>),
            _ => throw new ArgumentOutOfRangeException(nameof(arity)),
        };

    /// <summary>
    /// Issue #4591: the open <c>ValueTuple`N</c> definition in the load
    /// context <paramref name="contextObject"/> belongs to. The host
    /// <c>typeof(ValueTuple&lt;,&gt;)</c> is right only for the host context;
    /// for a <c>MetadataLoadContext</c> the definition is looked up from that
    /// context's own core assembly, which is where its <c>System.Object</c>
    /// lives.
    /// </summary>
    /// <param name="arity">The CLR tuple-node arity (1–8).</param>
    /// <param name="contextObject">The <c>System.Object</c> of the target load context.</param>
    /// <returns>The open definition, or <see langword="null"/> when the context does not define it.</returns>
    internal static Type? GetOpenClrType(int arity, Type contextObject)
    {
        var hostDefinition = GetOpenClrType(arity);
        if (ReferenceEquals(contextObject.Assembly, typeof(object).Assembly))
        {
            return hostDefinition;
        }

        return contextObject.Assembly.GetType(
            ValueTupleDefinitionPrefix + arity.ToString(System.Globalization.CultureInfo.InvariantCulture),
            throwOnError: false);
    }

    /// <summary>
    /// Builds the closed <c>ValueTuple&lt;...&gt;</c> CLR type over
    /// <paramref name="elementTypes"/>.
    /// </summary>
    /// <remarks>
    /// Issue #4591: the G# primitives are host <c>typeof(...)</c> types, but
    /// every other imported type comes from the compiler's
    /// <c>MetadataLoadContext</c>. Closing the HOST <c>ValueTuple</c> over such
    /// an element does not throw: <c>RuntimeType.MakeGenericType</c> silently
    /// returns a <c>TypeBuilderInstantiation</c> that throws
    /// <see cref="NotSupportedException"/> from <c>GetInterfaces</c> and every
    /// member lookup, which surfaced as GS9998 on an array-to-
    /// <c>IEnumerable</c> conversion and as a silently lost generic overload
    /// candidate. When every such element provably belongs to one
    /// <c>MetadataLoadContext</c>, the tuple is therefore closed in that
    /// context, with host primitives remapped into it. Every other shape —
    /// all-host elements, or an element whose context cannot be proven (for
    /// instance a function type's <c>Func&lt;…&gt;</c>, which is itself already
    /// a host instantiation) — keeps the previous host construction exactly,
    /// so no shape that bound before changes.
    /// </remarks>
    /// <param name="elementTypes">The element CLR types, in order.</param>
    /// <returns>The closed CLR type.</returns>
    internal static Type? BuildClrType(Type[] elementTypes)
        => BuildClrType(elementTypes, new bool[elementTypes.Length]);

    /// <summary>
    /// Issue #4591: <see cref="BuildClrType(Type[])"/> with nullable value-type
    /// elements passed as their UNDERLYING type plus a flag. A pre-built
    /// <c>Nullable&lt;T&gt;</c> over a <c>MetadataLoadContext</c> struct would
    /// itself be a host <c>TypeBuilderInstantiation</c> (the #4035 trap), so
    /// the wrapper is built only once the context is known, from that
    /// context's own <c>Nullable&lt;&gt;</c>.
    /// </summary>
    /// <param name="elementTypes">The element CLR types, nullable value types unwrapped.</param>
    /// <param name="liftToNullable">Per element, whether to wrap it in <c>Nullable&lt;&gt;</c>.</param>
    /// <returns>The closed CLR type.</returns>
    private static Type? BuildClrType(Type[] elementTypes, bool[] liftToNullable)
    {
        var hostObject = typeof(object);
        var contextObject = ResolveLoadContextObject(elementTypes);
        if (!ReferenceEquals(contextObject, hostObject)
            && TryBuildClrTypeInContext(elementTypes, liftToNullable, contextObject) is { } inContext)
        {
            return inContext;
        }

        // The previous construction, unchanged: host `Nullable<>` and host
        // `ValueTuple<…>` (what `GetEffectiveClrType` and the old builder did).
        var arguments = new Type[elementTypes.Length];
        for (var i = 0; i < elementTypes.Length; i++)
        {
            arguments[i] = liftToNullable[i]
                ? typeof(Nullable<>).MakeGenericType(elementTypes[i])
                : elementTypes[i];
        }

        return BuildClrType(arguments, 0, arguments.Length, hostObject);
    }

    /// <summary>
    /// Issue #4591: closes the tuple in the <c>MetadataLoadContext</c>
    /// <paramref name="contextObject"/> belongs to, remapping host primitives
    /// into it and building each nullable value type's <c>Nullable&lt;&gt;</c>
    /// from that context.
    /// </summary>
    /// <param name="elementTypes">The element CLR types, nullable value types unwrapped.</param>
    /// <param name="liftToNullable">Per element, whether to wrap it in <c>Nullable&lt;&gt;</c>.</param>
    /// <param name="contextObject">The context's <c>System.Object</c>.</param>
    /// <returns>The closed CLR type, or <see langword="null"/> when the context cannot build it.</returns>
    private static Type? TryBuildClrTypeInContext(Type[] elementTypes, bool[] liftToNullable, Type contextObject)
    {
        try
        {
            var arguments = new Type[elementTypes.Length];
            for (var i = 0; i < elementTypes.Length; i++)
            {
                var argument = ClrTypeUtilities.RemapHostCoreTypeToContext(elementTypes[i], contextObject);
                if (liftToNullable[i])
                {
                    var nullableOpen = contextObject.Assembly.GetType("System.Nullable`1", throwOnError: false);
                    if (nullableOpen == null)
                    {
                        return null;
                    }

                    argument = nullableOpen.MakeGenericType(argument);
                }

                arguments[i] = argument;
            }

            return BuildClrType(arguments, 0, arguments.Length, contextObject);
        }
        catch (ArgumentException)
        {
            // An element the remap could not move into the context (a host
            // type outside the core assembly) is rejected by the context's
            // MakeGenericType; the caller falls back to the host build.
            return null;
        }
    }

    private static TypeSymbol StripNames(TypeSymbol type) => type switch
    {
        TupleTypeSymbol tuple => tuple.WithoutNames(),
        NullableTypeSymbol { UnderlyingType: TupleTypeSymbol nested } => NullableTypeSymbol.Get(nested.WithoutNames()),
        _ => type,
    };

    private static string BuildName(ImmutableArray<TypeSymbol> elementTypes, ImmutableArray<string?> elementNames)
    {
        var sb = new StringBuilder("(");
        for (var i = 0; i < elementTypes.Length; i++)
        {
            if (i > 0)
            {
                sb.Append(", ");
            }

            if (!elementNames.IsDefaultOrEmpty && elementNames[i] != null)
            {
                sb.Append(elementNames[i]);
                sb.Append(' ');
            }

            sb.Append(elementTypes[i].Name);
        }

        sb.Append(')');
        return sb.ToString();
    }

    private static Type? BuildClrType(ImmutableArray<TypeSymbol> elementTypes)
    {
        // Issues #2119/#2702: a symbolic constructed generic has a non-null but
        // object-erased ClrType. Keep the tuple symbolic so signature encoding
        // preserves the real nested generic arguments.
        if (elementTypes.Any(t => t.ClrType == null || TypeSymbol.RequiresSymbolicProjection(t)))
        {
            return null;
        }

        // Issue #4591: a nullable value type is handed down as its underlying
        // type plus a flag, never as `GetEffectiveClrType`'s host-built
        // `Nullable<T>`; see BuildClrType(Type[], bool[]).
        var clrTypes = new Type[elementTypes.Length];
        var liftToNullable = new bool[elementTypes.Length];
        for (var i = 0; i < elementTypes.Length; i++)
        {
            if (elementTypes[i] is NullableTypeSymbol { UnderlyingType.ClrType: { IsValueType: true } underlying })
            {
                clrTypes[i] = underlying;
                liftToNullable[i] = true;
            }
            else
            {
                clrTypes[i] = Invariant.Required(
                    NullableTypeSymbol.GetEffectiveClrType(elementTypes[i]),
                    "a CLR-backed tuple element has a CLR type");
            }
        }

        return BuildClrType(clrTypes, liftToNullable);
    }

    private static Type? BuildClrType(Type[] elementTypes, int start, int count, Type contextObject)
    {
        if (count <= 7)
        {
            return GetOpenClrType(count, contextObject)?.MakeGenericType(elementTypes[start..(start + count)]);
        }

        var open = GetOpenClrType(8, contextObject);
        var rest = BuildClrType(elementTypes, start + 7, count - 7, contextObject);
        if (open == null || rest == null)
        {
            return null;
        }

        var arguments = new Type[8];
        Array.Copy(elementTypes, start, arguments, 0, 7);
        arguments[7] = rest;
        return open.MakeGenericType(arguments);
    }

    /// <summary>
    /// Issue #4591: the <c>System.Object</c> of the one
    /// <c>MetadataLoadContext</c> every non-host element of
    /// <paramref name="elementTypes"/> provably belongs to. Host
    /// <c>RuntimeType</c> elements fit any context (they are remapped). The
    /// answer is the host <c>typeof(object)</c>, meaning "keep the previous
    /// host construction", whenever that cannot be proven: no element needs a
    /// context, an element's context cannot be determined, an element is
    /// already a host instantiation over a context type (it answers the host
    /// context without being a <c>RuntimeType</c>), or two elements disagree.
    /// </summary>
    /// <param name="elementTypes">The element CLR types.</param>
    /// <returns>The proven context's <c>System.Object</c>, otherwise the host <c>typeof(object)</c>.</returns>
    private static Type ResolveLoadContextObject(Type[] elementTypes)
    {
        var hostObject = typeof(object);
        Type? contextObject = null;
        foreach (var element in elementTypes)
        {
            if (element.IsRuntimeProvidedType())
            {
                continue;
            }

            var elementObject = FindLoadContextObject(element);
            if (elementObject == null
                || ReferenceEquals(elementObject.Assembly, hostObject.Assembly)
                || (contextObject != null && !ReferenceEquals(elementObject, contextObject)))
            {
                return hostObject;
            }

            contextObject = elementObject;
        }

        return contextObject ?? hostObject;
    }

    /// <summary>
    /// Issue #4591: the <c>System.Object</c> of <paramref name="type"/>'s load
    /// context. Every context builds an array over its own types with its own
    /// <c>System.Array</c> as the base type, whose base is that context's
    /// <c>System.Object</c>; unlike walking <paramref name="type"/>'s own base
    /// chain this also answers for an interface.
    /// </summary>
    /// <param name="type">A CLR type.</param>
    /// <returns>The context's <c>System.Object</c>, or <see langword="null"/> when it cannot be determined.</returns>
    private static Type? FindLoadContextObject(Type type)
    {
        try
        {
            var root = type.MakeArrayType().BaseType?.BaseType;
            return root is { FullName: "System.Object" } ? root : null;
        }
        catch (Exception ex) when (ex is NotSupportedException || ClrTypeUtilities.IsMetadataLoadFailure(ex))
        {
            return null;
        }
    }

    /// <summary>
    /// Issue #3987: appends <paramref name="type"/>'s tuple elements to
    /// <paramref name="elements"/>, walking the canonical
    /// <c>ValueTuple&lt;T1..T7, TRest&gt;</c> chain.
    /// </summary>
    /// <param name="type">The candidate tuple-shaped type.</param>
    /// <param name="elements">The accumulating element list.</param>
    /// <returns>Whether the type was tuple-shaped throughout.</returns>
    private static bool TryFlattenTupleShape(
        TypeSymbol? type,
        ImmutableArray<TypeSymbol>.Builder elements)
    {
        if (type is NullabilityAnnotatedTypeSymbol annotated)
        {
            return TryFlattenTupleShape(annotated.BaseType, elements);
        }

        if (type is TupleTypeSymbol tuple)
        {
            elements.AddRange(tuple.ElementTypes);
            return true;
        }

        if (type is not ImportedTypeSymbol imported)
        {
            return false;
        }

        var open = imported.OpenDefinition;
        if (open == null && imported.ClrType is { IsGenericType: true } closed)
        {
            open = closed.GetGenericTypeDefinition();
        }

        if (open?.FullName?.StartsWith(ValueTupleDefinitionPrefix, StringComparison.Ordinal) != true)
        {
            return false;
        }

        var arguments = imported.TypeArguments;
        if (arguments.IsDefaultOrEmpty)
        {
            if (imported.ClrType is not { IsGenericType: true } closedShape)
            {
                return false;
            }

            var builder = ImmutableArray.CreateBuilder<TypeSymbol>();
            foreach (var argument in closedShape.GetGenericArguments())
            {
                var symbol = FromClrTypeWithoutNullability(argument, NullabilityFreeReason.TypeStructure);
                if (symbol == null)
                {
                    return false;
                }

                builder.Add(symbol);
            }

            arguments = builder.ToImmutable();
        }

        if (arguments.Length is < 1 or > 8)
        {
            return false;
        }

        if (arguments.Length <= 7)
        {
            elements.AddRange(arguments);
            return true;
        }

        for (var i = 0; i < 7; i++)
        {
            elements.Add(arguments[i]);
        }

        return TryFlattenTupleShape(arguments[7], elements);
    }
}
