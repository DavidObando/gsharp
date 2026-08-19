// <copyright file="ImportedTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Documentation;
using GSharp.Core.CodeAnalysis.Emit;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents an imported .NET type as a <see cref="TypeSymbol"/>.
/// Instances are cached per CLR <see cref="Type"/> so that reference equality
/// and identity conversions work as expected.
/// </summary>
public sealed class ImportedTypeSymbol : TypeSymbol
{
    private static readonly ConditionalWeakTable<Assembly, ConcurrentDictionary<Type, ImportedTypeSymbol>> Cache = new();

    private ImportedTypeSymbol(Type type)
        : base(type.FullName ?? type.Name, type)
    {
        TypeArguments = ImmutableArray<TypeSymbol>.Empty;
    }

    private ImportedTypeSymbol(string name, Type erasedClosedType, Type? openDefinition, ImmutableArray<TypeSymbol> typeArguments)
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
    public Type Type => Invariant.Required(ClrType, "an imported type always has a CLR representation");

    /// <inheritdoc/>
    public override string? ContainingNamespace => Type.Namespace;

    /// <summary>
    /// Gets the open generic CLR definition this symbol was constructed from
    /// (e.g. <c>List&lt;&gt;</c>), or <c>null</c> when this is a plain imported
    /// type rather than a #313 type-parameter construction.
    /// </summary>
    public Type? OpenDefinition { get; }

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
        && TypeArguments.Any(static a =>
            a.ClrType == null
            || TypeSymbol.RequiresSymbolicProjection(a)
            || (a is ImportedTypeSymbol nested
                && nested.OpenDefinition != null
                && !nested.TypeArguments.IsDefaultOrEmpty));

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

        var assemblyCache = Cache.GetValue(
            type.Assembly,
            static _ => new ConcurrentDictionary<Type, ImportedTypeSymbol>(TypeIdentityComparer.Instance));
        return assemblyCache.GetOrAdd(type, static t => new ImportedTypeSymbol(t));
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
    public static ImportedTypeSymbol GetConstructed(Type erasedClosedType, Type? openDefinition, ImmutableArray<TypeSymbol> typeArguments)
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

    /// <summary>
    /// Issue #2381: recursively reconstructs the TRUE closed CLR type for
    /// this constructed generic, recomputing every type argument's CLR type
    /// from its CURRENT state rather than trusting the cached (possibly
    /// erased) <see cref="TypeSymbol.ClrType"/>.
    /// </summary>
    /// <remarks>
    /// <para>A constructed <see cref="ImportedTypeSymbol"/> closed over a
    /// same-compilation class/struct argument (e.g. <c>List[DiagnosticCheck]</c>)
    /// caches an object-erased shape (<c>List&lt;object&gt;</c>) because, at
    /// the time <see cref="GetConstructed"/> ran during binding, the
    /// argument's own CLR type (its emitted <c>TypeBuilder</c>) did not exist
    /// yet — see <see cref="HasSubstitutableTypeArgument"/>. That erased
    /// shape is safe for member/index/conversion resolution during binding,
    /// but is wrong for final metadata (method signatures, generic builder
    /// instantiation, field types) once the argument's real CLR type is
    /// available.</para>
    /// <para>This walks <see cref="OpenDefinition"/> + <see cref="TypeArguments"/>
    /// and rebuilds the closed type via <see cref="Type.MakeGenericType"/>
    /// using each argument's CURRENT CLR type, recursing into nested
    /// constructed generics (e.g. <c>List[List[UserClass]]</c>,
    /// <c>Dictionary[string, UserClass]</c>) so every level reflects its
    /// real closed shape. Value-typed nullable arguments are projected
    /// through <see cref="NullableLifting.GetEffectiveClrType"/> so they
    /// close over <c>Nullable&lt;T&gt;</c> rather than the bare value type.</para>
    /// <para>Falls back to the cached (possibly erased) <see cref="TypeSymbol.ClrType"/>
    /// when reification is not possible: an in-scope type parameter argument
    /// (<see cref="HasTypeParameterArgument"/>) has no concrete CLR type to
    /// close over; a nested argument's own CLR type is still unavailable; or
    /// <see cref="Type.MakeGenericType"/> legitimately rejects the
    /// reconstructed arguments (CLR generic constraints).</para>
    /// </remarks>
    /// <returns>The reconstructed closed CLR type, or the cached (possibly erased) <see cref="TypeSymbol.ClrType"/> when reification is not possible.</returns>
    public Type ReifyClosedClrType()
    {
        if (OpenDefinition == null || TypeArguments.IsDefaultOrEmpty || HasTypeParameterArgument)
        {
            return Invariant.Required(ClrType, "an imported type always has a CLR representation");
        }

        Type? contextObject = null;
        foreach (var parameter in OpenDefinition.GetGenericArguments())
        {
            if (string.Equals(parameter.BaseType?.FullName, "System.Object", StringComparison.Ordinal))
            {
                contextObject = parameter.BaseType;
                break;
            }
        }

        var args = new Type[TypeArguments.Length];
        for (var i = 0; i < args.Length; i++)
        {
            var arg = TypeArguments[i];
            var argClr = arg switch
            {
                ImportedTypeSymbol nestedImported => nestedImported.ReifyClosedClrType(),
                NullableTypeSymbol => NullableLifting.GetEffectiveClrType(arg),
                _ => arg?.ClrType,
            };

            if (argClr == null)
            {
                // Some argument still lacks a concrete CLR type (e.g. its own
                // TypeBuilder has not been created yet); degrade to the
                // cached erased shape rather than fail outright.
                return Invariant.Required(ClrType, "an imported type always has a CLR representation");
            }

            args[i] = Invariant.Required(
                ClrTypeUtilities.RemapHostCoreTypeToContext(argClr, contextObject),
                "a concrete generic argument remains available after CLR context remapping");
        }

        try
        {
            return OpenDefinition.MakeGenericType(args);
        }
        catch (ArgumentException)
        {
            // MakeGenericType can legitimately reject the reconstructed
            // arguments for CLR generic-constraint reasons; degrade to the
            // erased shape instead of throwing.
            return Invariant.Required(ClrType, "an imported type always has a CLR representation");
        }
    }

    /// <inheritdoc/>
    public override DocumentationComment? GetDocumentation()
    {
        return AssemblyDocumentationProvider.Resolve(OpenDefinition ?? Type) ?? base.GetDocumentation();
    }

    internal static bool TryCreateSemanticAggregate(Type? type, ReferenceResolver? references, [NotNullWhen(true)] out StructSymbol? aggregate)
    {
        aggregate = null;
        if (type == null
            || type.IsPrimitive
            || type.IsEnum
            || type.IsGenericParameter
            || type.IsInterface)
        {
            return false;
        }

        // Issue #2291: an externally-referenced assembly that was compiled by
        // the C# compiler (not gsc) never carries the `GSharp.TypeSemantics`
        // marker, even when the type is a genuine C# `record`/`record struct`.
        // Fall back to recognizing the compiler-emitted record SHAPE (the
        // `PrintMembers`/copy-constructor/`<Clone>$`/`EqualityContract`
        // markers every C# record synthesizes) so such a type still resolves
        // to a data-class semantic aggregate and `with`/copy keep working.
        if (!ImportedAssemblySemantics.TryGetTypeSemantics(type, out var semantics)
            && !ImportedAssemblySemantics.TryDetectCSharpRecordSemantics(type, out semantics))
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

        // Issue #2278: a generic type's OPEN definition (e.g. `Box<>`,
        // `Pair<,>`) is always excluded, for both a `data class` and a `data
        // struct` — building an aggregate from it would be 0-arity (its
        // members typed by the raw, unsubstituted type parameter) and would
        // shadow every real closed instantiation at construction sites. A
        // CLOSED generic (`Box<int>`, `Pair<K,V>`) is fine: it is a distinct
        // CLR `Type` per instantiation whose `MetadataToken` still matches the
        // marker (tokens are shared between a generic type's open definition
        // and every closed construction), and reflecting over it (fields,
        // properties, methods) yields already-substituted member types — so
        // the aggregate built below is correctly and independently shaped per
        // closed generic type, with no shared/shadowed identity.
        if (type.IsGenericTypeDefinition)
        {
            return false;
        }

        if (!type.IsValueType && !semantics.IsData)
        {
            // A plain (non-data) reference class is never marked by the
            // emitter, so only genuine data classes reach here.
            return false;
        }

        var consumerAssemblyName = references?.CurrentAssemblyName ?? string.Empty;

        // Issue #2263 / #2269: cache the aggregate on the resolver instance so
        // its lifetime is tied to the metadata load context that owns `type`.
        // A process-wide static cache would strongly pin these CLR Types (and
        // their MLC/assemblies) for the whole process, leaking memory across
        // compilations (ResourceLeakRegressionTests) and churning under the
        // parallel test host. When no resolver is available (e.g. a synthetic
        // ImportedClassSymbol), build uncached — the aggregate is structurally
        // determined by `type`, so identity still holds within that scope.
        aggregate = references != null
            ? references.GetOrAddSemanticAggregate(
                type,
                consumerAssemblyName,
                static (t, consumer) =>
                {
                    return Invariant.Required<StructSymbol>(
                        BuildSemanticAggregate(t, consumer),
                        "a marked imported type has a semantic aggregate");
                })
            : BuildSemanticAggregate(type, consumerAssemblyName);
        return aggregate != null;
    }

    internal static TypeSymbol NormalizeSemanticAggregate(TypeSymbol type, Type? clrType, ReferenceResolver? references)
    {
        var nullable = type is NullableTypeSymbol;
        var unwrapped = nullable ? ((NullableTypeSymbol)type).UnderlyingType : type;
        var annotated = unwrapped as NullabilityAnnotatedTypeSymbol;
        var baseType = annotated?.BaseType ?? unwrapped;
        if (baseType is not ImportedTypeSymbol
            || !TryCreateSemanticAggregate(clrType, references, out var aggregate))
        {
            return type;
        }

        TypeSymbol normalized = annotated == null
            ? aggregate
            : new NullabilityAnnotatedTypeSymbol(aggregate, annotated.NullableFlags);
        return nullable ? NullableTypeSymbol.Get(normalized) : normalized;
    }

    /// <summary>
    /// Legacy dispose hook. The cache is weakly keyed by assembly and each
    /// per-assembly dictionary uses metadata identity for CLR types, so disposed
    /// metadata contexts are collectable without process-wide clearing.
    /// </summary>
    internal static void ClearCache()
    {
    }

    internal static bool IsInitOnlySetter(MethodInfo setter)
    {
        try
        {
            var requiredModifiers = setter.ReturnParameter.GetRequiredCustomModifiers();
            foreach (var modifier in requiredModifiers)
            {
                if (string.Equals(
                        modifier.FullName,
                        "System.Runtime.CompilerServices.IsExternalInit",
                        StringComparison.Ordinal))
                {
                    return true;
                }
            }

            return false;
        }
        catch
        {
            return false;
        }
    }

    private static StructSymbol? BuildSemanticAggregate(Type type, string consumerAssemblyName)
    {
        if (!ImportedAssemblySemantics.TryGetTypeSemantics(type, out var semantics)
            && !ImportedAssemblySemantics.TryDetectCSharpRecordSemantics(type, out semantics))
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
                isOverride: (getter ?? setter) is { } accessor && ClrTypeUtilities.SafeIsOverride(accessor),
                isStatic: (getter ?? setter)?.IsStatic == true,
                isInitOnly: setter != null && IsInitOnlySetter(setter),
                metadataIsAbstract: (getter ?? setter)?.IsAbstract == true));
        }

        var primaryConstructorParameters = BuildPrimaryConstructorParameters(
            fieldBuilder.ToImmutable(),
            propertyBuilder.ToImmutable(),
            fieldByToken,
            semantics);
        ApplyPrimaryConstructorDefaults(type, primaryConstructorParameters);

        var aggregate = new StructSymbol(
            name: BuildAggregateDisplayName(type),
            fields: fieldBuilder.ToImmutable(),
            accessibility: MapTypeAccessibility(type),
            declaration: null,
            packageName: type.Namespace ?? string.Empty,
            isData: semantics.IsData,
            isInline: false,
            isClass: !semantics.IsValueType,
            primaryConstructorParameters: primaryConstructorParameters,
            isOpen: false,
            baseClass: null,
            clrType: type);

        aggregate.SetProperties(propertyBuilder.ToImmutable());
        aggregate.SetMethods(BuildMethods(type, aggregate, includeInternal));
        aggregate.SetStaticMethods(BuildStaticMethods(type, aggregate, includeInternal));

        // Issue #3329: a value struct's ADR-0159 magic-collection field zero
        // value is normally recorded on the DECLARING compilation's own
        // StructSymbol.InstanceFieldInitializers (DeclarationBinder.Structs.cs)
        // — unavailable here, since this aggregate is built purely from
        // reflection over an ALREADY-EMITTED type in another assembly (or,
        // for the REPL, an earlier submission). Reconstruct it from the
        // GSharp.MagicCollectionFields marker so a struct literal `S{}` for
        // this imported type still zero-initializes such a field to its
        // sound empty instance rather than a raw (often null) CLR default.
        // A class needs no reconstruction: its literal always calls the
        // REAL parameterless constructor, which already runs these
        // initializers in-type.
        if (semantics.IsValueType
            && ImportedAssemblySemantics.TryGetMagicCollectionFields(type, out var magicFieldKinds))
        {
            var fieldsByName = aggregate.Fields.ToDictionary(f => f.Name, StringComparer.Ordinal);
            var instanceInitBuilder = ImmutableDictionary.CreateBuilder<FieldSymbol, BoundExpression>();
            foreach (var (fieldName, kind) in magicFieldKinds)
            {
                if (!fieldsByName.TryGetValue(fieldName, out var fieldSymbol))
                {
                    continue;
                }

                var reflectedField = type.GetField(fieldName, bindingFlags);
                var zeroValue = reflectedField != null
                    ? MagicCollectionZeroValue.TrySynthesizeEmptyInstanceFromMarker(reflectedField, kind)
                    : null;
                if (zeroValue != null)
                {
                    instanceInitBuilder[fieldSymbol] = zeroValue;
                }
            }

            if (instanceInitBuilder.Count > 0)
            {
                aggregate.SetInstanceFieldInitializers(instanceInitBuilder.ToImmutable());
            }
        }

        return aggregate;
    }

    /// <summary>
    /// Issue #2278: renders the aggregate's display name. For a plain
    /// (non-generic) imported data type this is just the CLR type's own
    /// name (matching pre-#2278 behavior). For a CLOSED generic data
    /// type this rebuilds a G#-flavored constructed-generic name (e.g.
    /// <c>Box[int32]</c>, <c>Pair[int32, string]</c>) from the reflected
    /// arguments rather than surfacing the raw backtick-arity CLR name
    /// (<c>Box`1</c>) in diagnostics and hover text.
    /// </summary>
    /// <param name="type">The reflected CLR type the aggregate is built from.</param>
    /// <returns>A display-friendly name for the aggregate.</returns>
    private static string BuildAggregateDisplayName(Type type)
    {
        if (!type.IsGenericType || type.IsGenericTypeDefinition)
        {
            return type.Name;
        }

        var baseName = StripGenericArity(type.Name);
        var args = type.GetGenericArguments().Select(BuildAggregateDisplayName);
        return $"{baseName}[{string.Join(", ", args)}]";
    }

    private static string StripGenericArity(string name)
    {
        var tick = name.IndexOf('`', StringComparison.Ordinal);
        return tick >= 0 ? name.Substring(0, tick) : name;
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
            ParameterSymbol? parameter = null;

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
                parameter = new ParameterSymbol(name, tokenField.Type);
            }
            else if (fieldMap.TryGetValue(name, out var field))
            {
                parameter = new ParameterSymbol(name, field.Type);
            }
            else if (propertyMap.TryGetValue(name, out var property))
            {
                parameter = new ParameterSymbol(name, property.Type);
            }

            if (parameter == null)
            {
                continue;
            }

            builder.Add(parameter);
        }

        return builder.ToImmutable();
    }

    private static void ApplyPrimaryConstructorDefaults(Type type, ImmutableArray<ParameterSymbol> parameters)
    {
        var parameterNames = ImmutableArray.CreateBuilder<string>(parameters.Length);
        foreach (var parameter in parameters)
        {
            parameterNames.Add(parameter.Name);
        }

        var clrParameters = FindPrimaryConstructorParameters(
            type,
            parameterNames.MoveToImmutable());
        for (var i = 0; i < parameters.Length && i < clrParameters.Length; i++)
        {
            if (TryGetOptionalDefault(clrParameters[i], out var defaultValue))
            {
                parameters[i].SetExplicitDefaultValue(defaultValue);
            }
        }
    }

    private static ParameterInfo[] FindPrimaryConstructorParameters(Type type, ImmutableArray<string> names)
    {
        foreach (var constructor in ClrTypeUtilities.SafeGetConstructors(type, BindingFlags.Public | BindingFlags.Instance))
        {
            var parameters = constructor.GetParameters();
            if (parameters.Length != names.Length)
            {
                continue;
            }

            var namesMatch = true;
            for (var i = 0; i < parameters.Length; i++)
            {
                if (!string.Equals(parameters[i].Name, names[i], StringComparison.Ordinal))
                {
                    namesMatch = false;
                    break;
                }
            }

            if (namesMatch)
            {
                return parameters;
            }
        }

        return Array.Empty<ParameterInfo>();
    }

    private static bool TryGetOptionalDefault(ParameterInfo parameter, out object? value)
    {
        value = null;
        try
        {
            if (!parameter.IsOptional && !parameter.HasDefaultValue)
            {
                return false;
            }

            value = parameter.RawDefaultValue;
            return value != DBNull.Value && value != Missing.Value;
        }
        catch
        {
            return false;
        }
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
        var reflectedParameters = method.GetParameters();
        var parameterBuilder = ImmutableArray.CreateBuilder<ParameterSymbol>(reflectedParameters.Length);
        foreach (var parameter in reflectedParameters)
        {
            parameterBuilder.Add(new ParameterSymbol(
                parameter.Name ?? "arg",
                ClrNullability.GetParameterTypeSymbol(parameter),
                refKind: GetRefKind(parameter)));
        }

        var parameters = parameterBuilder.MoveToImmutable();
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

    private static bool IsInParameter(ParameterInfo parameter)
    {
        try
        {
            foreach (var modifier in parameter.GetRequiredCustomModifiers())
            {
                if (string.Equals(
                    modifier.FullName,
                    "System.Runtime.InteropServices.InAttribute",
                    StringComparison.Ordinal))
                {
                    return true;
                }
            }

            return parameter.IsIn;
        }
        catch
        {
            return parameter.IsIn;
        }
    }
}
