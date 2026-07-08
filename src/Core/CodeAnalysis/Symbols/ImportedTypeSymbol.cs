// <copyright file="ImportedTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Documentation;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents an imported .NET type as a <see cref="TypeSymbol"/>.
/// Instances are cached per CLR <see cref="Type"/> so that reference equality
/// and identity conversions work as expected.
/// </summary>
public sealed class ImportedTypeSymbol : TypeSymbol
{
    private static readonly ConcurrentDictionary<Type, ImportedTypeSymbol> Cache = new();
    private static readonly ConcurrentDictionary<(Type Type, string ConsumerAssembly), StructSymbol> AggregateCache = new();

    private ImportedTypeSymbol(Type type)
        : base(type.FullName ?? type.Name, type)
    {
        TypeArguments = ImmutableArray<TypeSymbol>.Empty;
    }

    private ImportedTypeSymbol(string name, Type erasedClosedType, Type openDefinition, ImmutableArray<TypeSymbol> typeArguments)
        : base(name, erasedClosedType)
    {
        OpenDefinition = openDefinition;
        TypeArguments = typeArguments;
    }

    /// <summary>
    /// Gets the underlying CLR type. For a type constructed over an in-scope
    /// generic type parameter (#313) this is the type-erased closed form
    /// (e.g. <c>List&lt;object&gt;</c> for <c>List[T]</c>) so member, index, and
    /// conversion resolution keep working.
    /// </summary>
    public Type Type => ClrType;

    /// <summary>
    /// Gets the open generic CLR definition this symbol was constructed from
    /// (e.g. <c>List&lt;&gt;</c>), or <c>null</c> when this is a plain imported
    /// type rather than a #313 type-parameter construction.
    /// </summary>
    public Type OpenDefinition { get; }

    /// <summary>
    /// Gets the symbolic type arguments this generic type was constructed with
    /// (#313). May contain <see cref="TypeParameterSymbol"/> entries for an
    /// in-scope type parameter (e.g. <c>[T]</c> in <c>List[T]</c>). Empty for a
    /// plain imported type whose arguments are fully described by its
    /// <see cref="TypeSymbol.ClrType"/>.
    /// </summary>
    public ImmutableArray<TypeSymbol> TypeArguments { get; }

    /// <summary>
    /// Gets a value indicating whether this symbol carries symbolic type
    /// arguments that include an in-scope generic type parameter (#313), in
    /// which case it is an open/partially-constructed generic whose emit form
    /// is type-erased to <c>System.Object</c>.
    /// </summary>
    public bool HasTypeParameterArgument =>
        !TypeArguments.IsDefaultOrEmpty && TypeArguments.Any(TypeSymbol.ContainsTypeParameter);

    /// <summary>
    /// Gets a value indicating whether this symbol's symbolic type arguments
    /// should be substituted back through its <see cref="OpenDefinition"/> when
    /// projecting member / element types (issue #939).
    /// This is broader than <see cref="HasTypeParameterArgument"/>: it also
    /// holds when an argument is a <em>same-compilation</em> user
    /// <c>class</c>/<c>data struct</c> (whose <see cref="TypeSymbol.ClrType"/>
    /// is <see langword="null"/> because its CLR type is still being built and
    /// the closed shape is erased to <c>object</c>), or a nested constructed
    /// generic with symbolic arguments (e.g. <c>List[List[MyGs]]</c>). The
    /// indexer path (<c>MapErasedIndexerElementType</c>) and the for-in
    /// enumerable path both rely on this so iterating <c>List[Item]</c>
    /// recovers the member-bearing user <c>Item</c> symbol rather than the
    /// type-erased <c>object</c>.
    /// </summary>
    public bool HasSubstitutableTypeArgument =>
        !TypeArguments.IsDefaultOrEmpty
        && (HasTypeParameterArgument
            || TypeArguments.Any(static a => a.ClrType == null
                || (a is ImportedTypeSymbol nested
                    && nested.OpenDefinition != null
                    && !nested.TypeArguments.IsDefaultOrEmpty)));

    /// <summary>
    /// Gets or creates the imported type symbol for the given CLR type.
    /// </summary>
    /// <param name="type">The CLR type.</param>
    /// <returns>The cached <see cref="ImportedTypeSymbol"/>.</returns>
    public static ImportedTypeSymbol Get(Type type)
    {
        if (type == null)
        {
            throw new ArgumentNullException(nameof(type));
        }

        return Cache.GetOrAdd(type, t => new ImportedTypeSymbol(t));
    }

    /// <summary>
    /// #313: creates a generic type constructed over one or more in-scope type
    /// parameters (e.g. <c>List[T]</c>). The instance is intentionally not
    /// cached because each construction carries distinct symbolic type
    /// arguments while sharing the same type-erased closed CLR shape.
    /// </summary>
    /// <param name="erasedClosedType">The type-erased closed CLR type (type parameters projected onto <c>object</c>).</param>
    /// <param name="openDefinition">The open generic CLR definition (e.g. <c>List&lt;&gt;</c>).</param>
    /// <param name="typeArguments">The symbolic type arguments, possibly containing <see cref="TypeParameterSymbol"/>.</param>
    /// <returns>A fresh constructed <see cref="ImportedTypeSymbol"/>.</returns>
    public static ImportedTypeSymbol GetConstructed(Type erasedClosedType, Type openDefinition, ImmutableArray<TypeSymbol> typeArguments)
    {
        if (erasedClosedType == null)
        {
            throw new ArgumentNullException(nameof(erasedClosedType));
        }

        var argNames = string.Join(", ", typeArguments.Select(a => a?.Name ?? "?"));
        var baseName = openDefinition?.FullName ?? openDefinition?.Name ?? erasedClosedType.FullName ?? erasedClosedType.Name;
        var name = $"{baseName}[{argNames}]";
        return new ImportedTypeSymbol(name, erasedClosedType, openDefinition, typeArguments);
    }

    /// <inheritdoc/>
    public override DocumentationComment GetDocumentation()
    {
        return AssemblyDocumentationProvider.Resolve(OpenDefinition ?? Type) ?? base.GetDocumentation();
    }

    internal static bool TryCreateSemanticAggregate(Type type, ReferenceResolver references, out StructSymbol aggregate)
    {
        aggregate = null;
        if (type == null
            || type.IsPrimitive
            || type.IsEnum
            || type.IsGenericParameter
            || type.IsInterface
            || !ImportedAssemblySemantics.TryGetTypeSemantics(type, out var semantics))
        {
            return false;
        }

        // Issue #2263: a marked *reference* type is an imported `data class`;
        // a marked *value* type is a `data struct` (or a primary-ctor struct).
        // Both build a semantic-aggregate StructSymbol so members, primary
        // constructors and `with`/copy resolve consistently in EVERY position.
        // Guard the payload against a value/reference mismatch so a stale
        // marker can never mis-shape the aggregate.
        if (type.IsValueType != semantics.IsValueType)
        {
            return false;
        }

        if (!type.IsValueType)
        {
            // A plain (non-data) reference class is never marked by the
            // emitter, so only genuine data classes reach here. Generic data
            // classes are out of scope: their open definition would otherwise
            // build a 0-arity aggregate that shadows the real generic type at
            // construction sites, so they keep importing as an ordinary CLR
            // class (a `with` on one still reports GS0161 rather than
            // mis-binding).
            if (!semantics.IsData || type.IsGenericType || type.IsGenericTypeDefinition)
            {
                return false;
            }
        }

        var cacheKey = (type, references?.CurrentAssemblyName ?? string.Empty);
        aggregate = AggregateCache.GetOrAdd(cacheKey, static key => BuildSemanticAggregate(key.Type, key.ConsumerAssembly));
        return aggregate != null;
    }

    /// <summary>
    /// Removes all entries from the static type cache. Called by
    /// <see cref="ReferenceResolver.Dispose"/> to release stale
    /// <see cref="Type"/> objects backed by a disposed metadata load context
    /// that would otherwise pin the context's memory indefinitely.
    /// </summary>
    internal static void ClearCache()
    {
        Cache.Clear();
        AggregateCache.Clear();
    }

    private static StructSymbol BuildSemanticAggregate(Type type, string consumerAssemblyName)
    {
        if (!ImportedAssemblySemantics.TryGetTypeSemantics(type, out var semantics))
        {
            return null;
        }

        var includeInternal = ImportedAssemblySemantics.GrantsInternalAccessTo(type.Assembly, consumerAssemblyName);
        var bindingFlags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

        var fieldBuilder = ImmutableArray.CreateBuilder<FieldSymbol>();
        var fieldByToken = new System.Collections.Generic.Dictionary<int, FieldSymbol>();
        foreach (var field in ClrTypeUtilities.SafeGetFields(type, bindingFlags))
        {
            if (field.IsStatic || !IsVisible(field, includeInternal) || field.IsSpecialName || field.Name.StartsWith("<", StringComparison.Ordinal))
            {
                continue;
            }

            var fieldSymbol = new FieldSymbol(
                field.Name,
                TypeSymbol.FromClrType(field.FieldType),
                MapAccessibility(field),
                isReadOnly: field.IsInitOnly);
            fieldBuilder.Add(fieldSymbol);
            fieldByToken[field.MetadataToken] = fieldSymbol;
        }

        var propertyBuilder = ImmutableArray.CreateBuilder<PropertySymbol>();
        foreach (var property in ClrTypeUtilities.SafeGetProperties(type, bindingFlags))
        {
            if (property.GetIndexParameters().Length != 0)
            {
                continue;
            }

            var getter = property.GetMethod;
            var setter = property.SetMethod;
            if ((getter == null || !IsVisible(getter, includeInternal))
                && (setter == null || !IsVisible(setter, includeInternal)))
            {
                continue;
            }

            propertyBuilder.Add(new PropertySymbol(
                property.Name,
                ClrNullability.GetPropertyTypeSymbol(property),
                GetPropertyAccessibility(property),
                hasGetter: getter != null && IsVisible(getter, includeInternal),
                hasSetter: setter != null && IsVisible(setter, includeInternal),
                isAutoProperty: false,
                isVirtual: (getter ?? setter)?.IsVirtual == true,
                isOverride: (getter ?? setter)?.GetBaseDefinition() != (getter ?? setter),
                isStatic: (getter ?? setter)?.IsStatic == true,
                isInitOnly: setter != null && IsInitOnlySetter(setter)));
        }

        var aggregate = new StructSymbol(
            name: type.Name,
            fields: fieldBuilder.ToImmutable(),
            accessibility: MapTypeAccessibility(type),
            declaration: null,
            packageName: type.Namespace,
            isData: semantics.IsData,
            isInline: false,
            isClass: !semantics.IsValueType,
            primaryConstructorParameters: BuildPrimaryConstructorParameters(fieldBuilder.ToImmutable(), propertyBuilder.ToImmutable(), fieldByToken, semantics),
            isOpen: false,
            baseClass: null,
            clrType: type);

        aggregate.SetProperties(propertyBuilder.ToImmutable());
        aggregate.SetMethods(BuildMethods(type, aggregate, includeInternal));
        aggregate.SetStaticMethods(BuildStaticMethods(type, aggregate, includeInternal));
        return aggregate;
    }

    private static ImmutableArray<ParameterSymbol> BuildPrimaryConstructorParameters(
        ImmutableArray<FieldSymbol> fields,
        ImmutableArray<PropertySymbol> properties,
        System.Collections.Generic.Dictionary<int, FieldSymbol> fieldByToken,
        ImportedTypeSemantics semantics)
    {
        if (semantics.PrimaryConstructorParameterNames.IsDefaultOrEmpty)
        {
            return ImmutableArray<ParameterSymbol>.Empty;
        }

        var fieldMap = fields.ToDictionary(f => f.Name, StringComparer.Ordinal);
        var propertyMap = properties.ToDictionary(p => p.Name, StringComparer.Ordinal);
        var tokens = semantics.PrimaryConstructorParameterFieldTokens;
        var builder = ImmutableArray.CreateBuilder<ParameterSymbol>(semantics.PrimaryConstructorParameterNames.Length);
        for (var i = 0; i < semantics.PrimaryConstructorParameterNames.Length; i++)
        {
            var name = semantics.PrimaryConstructorParameterNames[i];

            // Prefer the exact backing field recorded by metadata token
            // (issue #1953 follow-up) — this is immune to the parameter name
            // ever diverging from the field name (renames, lowering,
            // mangling). Only fall back to a name-based lookup when no token
            // was recorded (older payload shape) or the token failed to
            // resolve (e.g. a property-backed parameter).
            if (!tokens.IsDefaultOrEmpty
                && i < tokens.Length
                && tokens[i] != 0
                && fieldByToken != null
                && fieldByToken.TryGetValue(tokens[i], out var tokenField))
            {
                builder.Add(new ParameterSymbol(name, tokenField.Type));
                continue;
            }

            if (fieldMap.TryGetValue(name, out var field))
            {
                builder.Add(new ParameterSymbol(name, field.Type));
                continue;
            }

            if (propertyMap.TryGetValue(name, out var property))
            {
                builder.Add(new ParameterSymbol(name, property.Type));
            }
        }

        return builder.ToImmutable();
    }

    private static ImmutableArray<FunctionSymbol> BuildMethods(Type type, StructSymbol aggregate, bool includeInternal)
    {
        var methods = ClrTypeUtilities.SafeGetMethods(type, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        var builder = ImmutableArray.CreateBuilder<FunctionSymbol>();
        foreach (var method in methods)
        {
            if (method.IsSpecialName || !IsVisible(method, includeInternal))
            {
                continue;
            }

            builder.Add(BuildMethodSymbol(method, aggregate, isStatic: false));
        }

        return builder.ToImmutable();
    }

    private static ImmutableArray<FunctionSymbol> BuildStaticMethods(Type type, StructSymbol aggregate, bool includeInternal)
    {
        var methods = ClrTypeUtilities.SafeGetMethods(type, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        var builder = ImmutableArray.CreateBuilder<FunctionSymbol>();
        foreach (var method in methods)
        {
            if (method.IsSpecialName || !IsVisible(method, includeInternal))
            {
                continue;
            }

            var symbol = BuildMethodSymbol(method, aggregate, isStatic: true);
            symbol.IsStatic = true;
            symbol.StaticOwnerType = aggregate;
            builder.Add(symbol);
        }

        return builder.ToImmutable();
    }

    private static FunctionSymbol BuildMethodSymbol(MethodInfo method, StructSymbol aggregate, bool isStatic)
    {
        var parameters = method.GetParameters()
            .Select(parameter => new ParameterSymbol(
                parameter.Name ?? "arg",
                ClrNullability.GetParameterTypeSymbol(parameter),
                refKind: GetRefKind(parameter)))
            .ToImmutableArray();
        return new FunctionSymbol(
            method.Name,
            parameters,
            ClrNullability.GetReturnTypeSymbol(method),
            declaration: null,
            package: null,
            accessibility: MapAccessibility(method),
            receiverType: isStatic ? null : aggregate);
    }

    private static RefKind GetRefKind(ParameterInfo parameter)
    {
        if (!parameter.ParameterType.IsByRef)
        {
            return RefKind.None;
        }

        if (parameter.IsOut)
        {
            return RefKind.Out;
        }

        return IsInParameter(parameter) ? RefKind.In : RefKind.Ref;
    }

    private static bool IsVisible(FieldInfo field, bool includeInternal)
        => field.IsPublic || (includeInternal && field.IsAssembly);

    private static bool IsVisible(MethodBase method, bool includeInternal)
        => method.IsPublic || (includeInternal && method.IsAssembly);

    private static Accessibility MapTypeAccessibility(Type type)
    {
        if (type.IsNested)
        {
            if (type.IsNestedPublic)
            {
                return Accessibility.Public;
            }

            if (type.IsNestedAssembly)
            {
                return Accessibility.Internal;
            }

            if (type.IsNestedFamily)
            {
                return Accessibility.Protected;
            }

            return Accessibility.Private;
        }

        return type.IsPublic ? Accessibility.Public : Accessibility.Internal;
    }

    private static Accessibility MapAccessibility(FieldInfo field)
        => field.IsPublic ? Accessibility.Public
            : field.IsAssembly ? Accessibility.Internal
            : field.IsFamily ? Accessibility.Protected
            : Accessibility.Private;

    private static Accessibility MapAccessibility(MethodBase method)
        => method.IsPublic ? Accessibility.Public
            : method.IsAssembly ? Accessibility.Internal
            : method.IsFamily ? Accessibility.Protected
            : Accessibility.Private;

    private static Accessibility GetPropertyAccessibility(PropertyInfo property)
    {
        var accessor = property.GetMethod ?? property.SetMethod;
        return accessor == null ? Accessibility.Private : MapAccessibility(accessor);
    }

    private static bool IsInitOnlySetter(MethodInfo setter)
    {
        try
        {
            var requiredModifiers = setter.ReturnParameter.GetRequiredCustomModifiers();
            return requiredModifiers.Any(m => string.Equals(m.FullName, "System.Runtime.CompilerServices.IsExternalInit", StringComparison.Ordinal));
        }
        catch
        {
            return false;
        }
    }

    private static bool IsInParameter(ParameterInfo parameter)
    {
        try
        {
            return parameter.GetRequiredCustomModifiers()
                .Any(m => string.Equals(m.FullName, "System.Runtime.InteropServices.InAttribute", StringComparison.Ordinal))
                || parameter.IsIn;
        }
        catch
        {
            return parameter.IsIn;
        }
    }
}
