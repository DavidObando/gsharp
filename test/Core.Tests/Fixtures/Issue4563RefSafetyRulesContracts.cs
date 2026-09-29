// <copyright file="Issue4563RefSafetyRulesContracts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Microsoft.CodeAnalysis.CSharp;

namespace GSharp.Core.Tests.Fixtures;

/// <summary>Builds legacy and version-11 ref-safety contracts outside the ambient test assembly.</summary>
internal sealed class Issue4563RefSafetyRulesContracts : IDisposable
{
    private readonly CSharpFixture legacy;
    private readonly CSharpFixture updated;

    public Issue4563RefSafetyRulesContracts(Action<string> beforeUpdated = null)
    {
        CSharpFixture createdLegacy = null;
        CSharpFixture createdUpdated = null;
        try
        {
            createdLegacy = new CSharpFixture(
                LegacySource,
                parseOptions: new CSharpParseOptions(LanguageVersion.CSharp11).WithFeatures(
                    new[] { new KeyValuePair<string, string>("noRefSafetyRulesAttribute", "true") }));
            beforeUpdated?.Invoke(createdLegacy.DirectoryPath);
            createdUpdated = new CSharpFixture(
                UpdatedSource,
                parseOptions: new CSharpParseOptions(LanguageVersion.CSharp11));
            legacy = createdLegacy;
            updated = createdUpdated;
        }
        catch
        {
            createdUpdated?.Dispose();
            createdLegacy?.Dispose();
            throw;
        }
    }

    /// <summary>Gets the legacy assembly path.</summary>
    public string LegacyPath => legacy.AssemblyPath;

    /// <summary>Gets the updated-rules assembly path.</summary>
    public string UpdatedPath => updated.AssemblyPath;

    /// <summary>Gets whether the legacy module carries the version-11 marker.</summary>
    public bool LegacyHasVersion11Marker => HasVersion11Marker(legacy);

    /// <summary>Gets whether the updated module carries the version-11 marker.</summary>
    public bool UpdatedHasVersion11Marker => HasVersion11Marker(updated);

    /// <summary>Loads the legacy contract assembly.</summary>
    public Assembly LoadLegacy() => legacy.Load();

    /// <summary>Loads the updated contract assembly.</summary>
    public Assembly LoadUpdated() => updated.Load();

    public void Dispose()
    {
        legacy.Dispose();
        updated.Dispose();
    }

    private static bool HasVersion11Marker(CSharpFixture fixture)
        => fixture.Load().ManifestModule.GetCustomAttributesData().Any(attribute =>
            attribute.AttributeType.FullName == "System.Runtime.CompilerServices.RefSafetyRulesAttribute"
            && attribute.ConstructorArguments.Count == 1
            && attribute.ConstructorArguments[0].Value is 11);

    private const string LegacySource = """
        using System.Diagnostics.CodeAnalysis;

        namespace Issue4563.Legacy;

        public abstract class Contract
        {
            public abstract ref int Pick(out int value);

            public abstract ref int PickUnscoped([UnscopedRef] out int value);

            public abstract ref int PickScoped(scoped ref int value);
        }

        public abstract class LegacySource
        {
            public abstract ref int Pick(out int value);
        }
        """;

    private const string UpdatedSource = """
        using System.Diagnostics.CodeAnalysis;

        namespace Issue4563.Updated;

        public abstract class Contract
        {
            public abstract ref int Pick(out int value);

            public abstract ref int PickUnscoped([UnscopedRef] out int value);

            public abstract ref int PickScoped(scoped ref int value);
        }

        public interface IStaticContract
        {
            static abstract ref int Pick(out int scratch);
        }

        public interface IUpdatedContract
        {
            ref int Pick(out int value);
        }

        public abstract class UpdatedSource
        {
            public abstract ref int Pick(out int value);
        }
        """;
}
