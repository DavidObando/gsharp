// <copyright file="ImportedAssemblySemantics.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Reads the small cross-assembly semantic markers gsc writes onto assemblies
/// via <see cref="AssemblyMetadataAttribute"/> rows, plus standard
/// <see cref="System.Runtime.CompilerServices.InternalsVisibleToAttribute"/>
/// declarations.
/// </summary>
internal static class ImportedAssemblySemantics
{
    public const string TypeSemanticsMetadataKey = "GSharp.TypeSemantics";

    private const string AssemblyMetadataAttributeFullName = "System.Reflection.AssemblyMetadataAttribute";
    private const string InternalsVisibleToAttributeFullName = "System.Runtime.CompilerServices.InternalsVisibleToAttribute";

    // Keyed on the reflection-only Assembly object so an assembly's markers are
    // parsed once. Issue #2269: this MUST be a ConditionalWeakTable rather than
    // a ConcurrentDictionary — a strong process-wide dictionary would pin every
    // Assembly (and the MetadataLoadContext reflection metadata behind it) for
    // the whole process. gsc creates one MetadataLoadContext per compilation, so
    // pinning leaks all of them across the parallel test host (and any long
    // running process), exhausting memory. TryGetTypeSemantics is now consulted
    // for imported *reference* types too (data-class support), which touches far
    // more assemblies, so the pinning became an out-of-memory regression. A weak
    // table lets each entry (and its Assembly key) be collected once the owning
    // load context is disposed and unreachable.
    private static readonly ConditionalWeakTable<Assembly, AssemblySemantics> Cache = new();

    public static bool TryGetTypeSemantics(Type type, out ImportedTypeSemantics semantics)
    {
        semantics = null;
        if (type == null)
        {
            return false;
        }

        try
        {
            return Cache.GetValue(type.Assembly, ReadAssemblySemantics).TypesByMetadataToken.TryGetValue(type.MetadataToken, out semantics);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Issue #2291: recognizes a genuine C# compiler-emitted <c>record</c> /
    /// <c>record struct</c> shape when the assembly it lives in was compiled
    /// by the C# compiler (not gsc) and therefore never wrote a
    /// <see cref="TypeSemanticsMetadataKey"/> marker for it. Every C# record
    /// synthesizes a <c>PrintMembers</c> method and a copy constructor
    /// (<c>.ctor(SameType)</c>); a <c>record class</c> additionally
    /// synthesizes a public parameterless <c>&lt;Clone&gt;$</c> method and a
    /// protected/internal <c>EqualityContract</c> property (a <c>record
    /// struct</c> has neither — value-type copying makes them unnecessary).
    /// Requiring the FULL marker set for the type's value/reference kind
    /// keeps this from ever misclassifying a hand-written class/struct that
    /// merely happens to declare one of these members incidentally.
    /// </summary>
    /// <param name="type">The externally-referenced CLR type to inspect.</param>
    /// <param name="semantics">The synthesized semantics on success.</param>
    /// <returns><see langword="true"/> when <paramref name="type"/> has the full record shape.</returns>
    public static bool TryDetectCSharpRecordSemantics(Type type, out ImportedTypeSemantics semantics)
    {
        semantics = null;
        if (type == null || type.IsPrimitive || type.IsEnum || type.IsInterface || type.IsGenericTypeDefinition)
        {
            return false;
        }

        const BindingFlags InstanceAny = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

        // Look up methods/constructors WITHOUT passing an explicit parameter
        // `Type[]` to `GetMethod`/`GetConstructor` overloads — under a
        // `MetadataLoadContext`-backed resolver, `typeof(StringBuilder)` (or
        // any host-runtime `Type`) is NOT "a type provided by the
        // MetadataLoadContext" that loaded `type`, and the reflection binder
        // throws `ArgumentException` rather than simply reporting no match.
        // Enumerating and matching by simple name/FullName instead works
        // uniformly for both the live-reflection and MLC-backed resolvers.
        var hasPrintMembers = ClrTypeUtilities.SafeGetMethods(type, InstanceAny).Any(m =>
            string.Equals(m.Name, "PrintMembers", StringComparison.Ordinal)
            && m.ReturnType.FullName == "System.Boolean"
            && m.GetParameters() is [{ ParameterType.FullName: "System.Text.StringBuilder" }]);

        var hasReferenceAssemblyShape = !hasPrintMembers && HasCSharpRecordReferenceShape(type);
        if (!hasPrintMembers && !hasReferenceAssemblyShape)
        {
            return false;
        }

        // Issue #2291 follow-up: a `record class` needs an explicit copy
        // constructor (`.ctor(SameType)`) plus `<Clone>$`/`EqualityContract`
        // because `with` on a reference type must allocate a brand-new
        // instance. A `record struct` has NEITHER — value-type assignment
        // already copies the whole instance, so the C# compiler never
        // synthesizes a copy constructor, `<Clone>$`, or `EqualityContract`
        // for it (verified by inspecting the compiler-emitted metadata
        // shape of `public record struct Point(int X, int Y)`). Requiring
        // those reference-type-only markers on a record STRUCT would always
        // fail detection, so `PrintMembers` alone — a marker unique to
        // compiler-synthesized records — is the correct, sufficient
        // signature for the value-type case.
        if (!type.IsValueType && !hasReferenceAssemblyShape)
        {
            var hasCopyConstructor = ClrTypeUtilities.SafeGetConstructors(type, InstanceAny).Any(c =>
                c.GetParameters() is [{ } onlyParameter] && ClrTypeUtilities.AreSame(onlyParameter.ParameterType, type));
            var hasClone = ClrTypeUtilities.SafeGetMethods(type, BindingFlags.Public | BindingFlags.Instance).Any(m =>
                string.Equals(m.Name, "<Clone>$", StringComparison.Ordinal)
                && m.GetParameters().Length == 0
                && type.IsAssignableFrom(m.ReturnType));
            var hasEqualityContract = type.GetProperty("EqualityContract", BindingFlags.NonPublic | BindingFlags.Instance) is { } equalityContractProperty
                && equalityContractProperty.PropertyType.FullName == "System.Type";
            if (!hasCopyConstructor || !hasClone || !hasEqualityContract)
            {
                return false;
            }
        }

        var (parameterNames, parameterFieldTokens) = BuildRecordPrimaryConstructorShape(type);
        semantics = new ImportedTypeSemantics(
            MetadataToken: type.MetadataToken,
            IsValueType: type.IsValueType,
            IsData: true,
            PrimaryConstructorParameterNames: parameterNames,
            PrimaryConstructorParameterFieldTokens: parameterFieldTokens);
        return true;
    }

    public static bool GrantsInternalAccessTo(Assembly assembly, string consumerAssemblyName)
    {
        if (assembly == null || string.IsNullOrWhiteSpace(consumerAssemblyName))
        {
            return false;
        }

        var normalizedConsumer = NormalizeAssemblyName(consumerAssemblyName);
        if (string.IsNullOrEmpty(normalizedConsumer))
        {
            return false;
        }

        try
        {
            var ownerName = NormalizeAssemblyName(assembly.GetName().Name);
            if (string.Equals(ownerName, normalizedConsumer, StringComparison.Ordinal))
            {
                return true;
            }

            // No unilateral ".Tests"-suffix auto-friend heuristic here — the
            // producer must explicitly opt in via a real
            // InternalsVisibleToAttribute row (either hand-written
            // `[assembly: InternalsVisibleTo(...)]` from a .NET-language
            // producer, or gsc's `@assembly:InternalsVisibleTo("...")`
            // annotation — see
            // Emit.AssemblyAttributeEmitter.EmitFriendAssemblyAttributes). A
            // consumer name is only trusted if the owner actually declared it.
            return Cache.GetValue(assembly, ReadAssemblySemantics).FriendAssemblies.Contains(normalizedConsumer);
        }
        catch
        {
            return false;
        }
    }

    // Reference assemblies omit the private/protected markers of a sealed
    // record. Its compiler-generated public equality surface remains intact.
    private static bool HasCSharpRecordReferenceShape(Type type)
    {
        const BindingFlags PublicInstance = BindingFlags.Public | BindingFlags.Instance;
        const BindingFlags PublicStatic = BindingFlags.Public | BindingFlags.Static;

        if (!type.IsSealed)
        {
            return false;
        }

        bool IsCompilerGenerated(MemberInfo member) => member.GetCustomAttributesData().Any(attribute =>
            attribute.AttributeType.FullName == "System.Runtime.CompilerServices.CompilerGeneratedAttribute");

        var implementsSelfEquatable = type.GetInterfaces().Any(iface =>
            iface.IsGenericType
            && iface.GetGenericTypeDefinition().FullName == "System.IEquatable`1"
            && iface.GetGenericArguments() is [{ } argument]
            && argument.FullName == type.FullName);
        if (!implementsSelfEquatable)
        {
            return false;
        }

        var methods = ClrTypeUtilities.SafeGetMethods(type, PublicInstance | PublicStatic);
        var hasTypedEquals = methods.Any(method =>
            method.Name == "Equals"
            && !method.IsStatic
            && method.ReturnType.FullName == "System.Boolean"
            && method.GetParameters() is [{ } parameter]
            && parameter.ParameterType.FullName == type.FullName
            && IsCompilerGenerated(method));
        var hasEquality = methods.Any(method =>
            method.Name == "op_Equality"
            && method.IsStatic
            && method.ReturnType.FullName == "System.Boolean"
            && method.GetParameters() is [{ } left, { } right]
            && left.ParameterType.FullName == type.FullName
            && right.ParameterType.FullName == type.FullName
            && IsCompilerGenerated(method));
        var hasInequality = methods.Any(method =>
            method.Name == "op_Inequality"
            && method.IsStatic
            && method.ReturnType.FullName == "System.Boolean"
            && method.GetParameters() is [{ } left, { } right]
            && left.ParameterType.FullName == type.FullName
            && right.ParameterType.FullName == type.FullName
            && IsCompilerGenerated(method));
        var hasToString = methods.Any(method =>
            method.Name == "ToString"
            && !method.IsStatic
            && method.ReturnType.FullName == "System.String"
            && method.GetParameters().Length == 0
            && IsCompilerGenerated(method));
        var hasGetHashCode = methods.Any(method =>
            method.Name == "GetHashCode"
            && !method.IsStatic
            && method.ReturnType.FullName == "System.Int32"
            && method.GetParameters().Length == 0
            && IsCompilerGenerated(method));
        return hasTypedEquals && hasEquality && hasInequality && hasToString && hasGetHashCode;
    }

    // Issue #2291: the record's POSITIONAL primary constructor is the public
    // instance constructor (other than the synthesized copy constructor,
    // `.ctor(SameType)`) whose parameters name-match, 1:1 and in order, a
    // public auto-property of the record (the shape every C#
    // `record`/`record struct` positional declaration produces). A record
    // with no positional parameters (e.g. `record struct Empty;`) has no such
    // constructor — <c>with</c> then has nothing to set, which still compiles
    // (an empty `{ }`  member list).
    private static (ImmutableArray<string> Names, ImmutableArray<int> FieldTokens) BuildRecordPrimaryConstructorShape(Type type)
    {
        var autoProperties = type
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.GetMethod != null && p.SetMethod != null && p.GetIndexParameters().Length == 0)
            .ToDictionary(p => p.Name, StringComparer.Ordinal);

        if (autoProperties.Count == 0)
        {
            return (ImmutableArray<string>.Empty, ImmutableArray<int>.Empty);
        }

        ConstructorInfo bestMatch = null;
        var bestParameters = Array.Empty<ParameterInfo>();
        foreach (var ctor in type.GetConstructors(BindingFlags.Public | BindingFlags.Instance))
        {
            var parameters = ctor.GetParameters();

            // Skip the synthesized copy constructor — it never denotes the
            // positional shape.
            if (parameters.Length == 1 && ClrTypeUtilities.AreSame(parameters[0].ParameterType, type))
            {
                continue;
            }

            if (parameters.Length == 0 || parameters.Length <= bestParameters.Length)
            {
                continue;
            }

            if (parameters.All(p => autoProperties.ContainsKey(p.Name ?? string.Empty)))
            {
                bestMatch = ctor;
                bestParameters = parameters;
            }
        }

        if (bestMatch == null)
        {
            return (ImmutableArray<string>.Empty, ImmutableArray<int>.Empty);
        }

        var namesBuilder = ImmutableArray.CreateBuilder<string>(bestParameters.Length);
        var tokensBuilder = ImmutableArray.CreateBuilder<int>(bestParameters.Length);
        foreach (var parameter in bestParameters)
        {
            var name = parameter.Name;
            namesBuilder.Add(name);

            var backingField = type.GetField($"<{name}>k__BackingField", BindingFlags.NonPublic | BindingFlags.Instance);
            tokensBuilder.Add(backingField?.MetadataToken ?? 0);
        }

        return (namesBuilder.ToImmutable(), tokensBuilder.ToImmutable());
    }

    private static AssemblySemantics ReadAssemblySemantics(Assembly assembly)
    {
        var typesByToken = new Dictionary<int, ImportedTypeSemantics>();
        var friends = new HashSet<string>(StringComparer.Ordinal);

        IList<CustomAttributeData> attributes;
        try
        {
            attributes = assembly.GetCustomAttributesData();
        }
        catch
        {
            return new AssemblySemantics(
                typesByToken.ToImmutableDictionary(),
                friends.ToImmutableHashSet(StringComparer.Ordinal));
        }

        foreach (var attribute in attributes)
        {
            var attributeName = attribute.AttributeType?.FullName;
            if (string.Equals(attributeName, AssemblyMetadataAttributeFullName, StringComparison.Ordinal))
            {
                if (attribute.ConstructorArguments.Count < 2)
                {
                    continue;
                }

                var key = attribute.ConstructorArguments[0].Value as string;
                if (!string.Equals(key, TypeSemanticsMetadataKey, StringComparison.Ordinal))
                {
                    continue;
                }

                var value = attribute.ConstructorArguments[1].Value as string;
                if (TryParseTypeSemantics(value, out var semantics))
                {
                    typesByToken[semantics.MetadataToken] = semantics;
                }

                continue;
            }

            if (!string.Equals(attributeName, InternalsVisibleToAttributeFullName, StringComparison.Ordinal)
                || attribute.ConstructorArguments.Count == 0)
            {
                continue;
            }

            if (attribute.ConstructorArguments[0].Value is string friendName)
            {
                var normalized = NormalizeAssemblyName(friendName);
                if (!string.IsNullOrEmpty(normalized))
                {
                    friends.Add(normalized);
                }
            }
        }

        return new AssemblySemantics(
            typesByToken.ToImmutableDictionary(),
            friends.ToImmutableHashSet(StringComparer.Ordinal));
    }

    private static bool TryParseTypeSemantics(string value, out ImportedTypeSemantics semantics)
    {
        semantics = null;
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        var parts = value.Split('|');
        if (parts.Length < 4 || !int.TryParse(parts[0], out var metadataToken))
        {
            return false;
        }

        var kind = parts[1];
        var isData = string.Equals(parts[2], "1", StringComparison.Ordinal);

        // Issue #1953 follow-up: each entry is "name:backingFieldToken" (token
        // is "0" when the emitter found no backing field, e.g. a property-
        // backed parameter). Tolerate the old name-only format too (no ':')
        // so a stale-but-compatible payload never turns into an outright
        // parse failure — it just carries no token.
        var primaryParameterNames = ImmutableArray<string>.Empty;
        var primaryParameterFieldTokens = ImmutableArray<int>.Empty;
        if (parts[3].Length != 0)
        {
            var entries = parts[3].Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            var namesBuilder = ImmutableArray.CreateBuilder<string>(entries.Length);
            var tokensBuilder = ImmutableArray.CreateBuilder<int>(entries.Length);
            foreach (var entry in entries)
            {
                var colon = entry.IndexOf(':');
                if (colon < 0)
                {
                    namesBuilder.Add(entry);
                    tokensBuilder.Add(0);
                    continue;
                }

                namesBuilder.Add(entry.Substring(0, colon));
                tokensBuilder.Add(int.TryParse(entry.Substring(colon + 1), out var token) ? token : 0);
            }

            primaryParameterNames = namesBuilder.ToImmutable();
            primaryParameterFieldTokens = tokensBuilder.ToImmutable();
        }

        semantics = new ImportedTypeSemantics(
            MetadataToken: metadataToken,
            IsValueType: string.Equals(kind, "struct", StringComparison.Ordinal),
            IsData: isData,
            PrimaryConstructorParameterNames: primaryParameterNames,
            PrimaryConstructorParameterFieldTokens: primaryParameterFieldTokens);
        return true;
    }

    private static string NormalizeAssemblyName(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var trimmed = value.Trim();
        var comma = trimmed.IndexOf(',');
        if (comma >= 0)
        {
            trimmed = trimmed.Substring(0, comma);
        }

        return trimmed.Trim();
    }

    private sealed record AssemblySemantics(
        ImmutableDictionary<int, ImportedTypeSemantics> TypesByMetadataToken,
        ImmutableHashSet<string> FriendAssemblies);
}

internal sealed record ImportedTypeSemantics(
    int MetadataToken,
    bool IsValueType,
    bool IsData,
    ImmutableArray<string> PrimaryConstructorParameterNames,
    ImmutableArray<int> PrimaryConstructorParameterFieldTokens = default);
