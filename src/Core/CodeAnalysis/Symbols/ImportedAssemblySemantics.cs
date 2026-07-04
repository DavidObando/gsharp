// <copyright file="ImportedAssemblySemantics.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;

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

    private static readonly ConcurrentDictionary<Assembly, AssemblySemantics> Cache = new();

    public static bool TryGetTypeSemantics(Type type, out ImportedTypeSemantics semantics)
    {
        semantics = null;
        if (type == null)
        {
            return false;
        }

        try
        {
            return Cache.GetOrAdd(type.Assembly, ReadAssemblySemantics).TypesByMetadataToken.TryGetValue(type.MetadataToken, out semantics);
        }
        catch
        {
            return false;
        }
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

            if (!string.IsNullOrEmpty(ownerName)
                && string.Equals(normalizedConsumer, ownerName + ".Tests", StringComparison.Ordinal))
            {
                return true;
            }

            return Cache.GetOrAdd(assembly, ReadAssemblySemantics).FriendAssemblies.Contains(normalizedConsumer);
        }
        catch
        {
            return false;
        }
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
        var primaryParameterNames = parts[3].Length == 0
            ? ImmutableArray<string>.Empty
            : parts[3]
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .ToImmutableArray();

        semantics = new ImportedTypeSemantics(
            MetadataToken: metadataToken,
            IsValueType: string.Equals(kind, "struct", StringComparison.Ordinal),
            IsData: isData,
            PrimaryConstructorParameterNames: primaryParameterNames);
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
    ImmutableArray<string> PrimaryConstructorParameterNames);
