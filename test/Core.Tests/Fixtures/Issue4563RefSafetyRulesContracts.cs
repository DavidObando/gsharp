// <copyright file="Issue4563RefSafetyRulesContracts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Text;
using GSharp.Tests;
using Microsoft.CodeAnalysis.CSharp;

namespace GSharp.Core.Tests.Fixtures;

/// <summary>Builds legacy and version-11 ref-safety contracts outside the ambient test assembly.</summary>
internal sealed class Issue4563RefSafetyRulesContracts : IDisposable
{
    private readonly CSharpFixture legacy;
    private readonly CSharpFixture updated;
    private readonly CSharpFixture lookalike;
    private readonly string equivalentPath;

    public Issue4563RefSafetyRulesContracts(Action<string> beforeUpdated = null)
    {
        CSharpFixture createdLegacy = null;
        CSharpFixture createdUpdated = null;
        CSharpFixture createdLookalike = null;
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
            equivalentPath = Path.Combine(createdUpdated.DirectoryPath, "EquivalentContracts.dll");
            BuildEquivalentContracts(equivalentPath);
            createdLookalike = new CSharpFixture(
                LookalikeSource,
                parseOptions: new CSharpParseOptions(LanguageVersion.CSharp11).WithFeatures(
                    new[] { new KeyValuePair<string, string>("noRefSafetyRulesAttribute", "true") }));
            RenameLookalikeRefSafetyRulesAttribute(createdLookalike.AssemblyPath);
            legacy = createdLegacy;
            updated = createdUpdated;
            lookalike = createdLookalike;
        }
        catch
        {
            createdLookalike?.Dispose();
            createdUpdated?.Dispose();
            createdLegacy?.Dispose();
            throw;
        }
    }

    /// <summary>Gets the legacy assembly path.</summary>
    public string LegacyPath => legacy.AssemblyPath;

    /// <summary>Gets the updated-rules assembly path.</summary>
    public string UpdatedPath => updated.AssemblyPath;

    /// <summary>Gets the same-named lookalike-marker assembly path.</summary>
    public string LookalikePath => lookalike.AssemblyPath;

    /// <summary>Gets the assembly containing metadata-distinct but effectively equivalent contracts.</summary>
    public string EquivalentPath => equivalentPath;

    /// <summary>Gets whether the legacy module carries the version-11 marker.</summary>
    public bool LegacyHasVersion11Marker => HasVersion11Marker(legacy);

    /// <summary>Gets whether the updated module carries the version-11 marker.</summary>
    public bool UpdatedHasVersion11Marker => HasVersion11Marker(updated);

    /// <summary>Loads the legacy contract assembly.</summary>
    public Assembly LoadLegacy() => legacy.Load();

    /// <summary>Loads the updated contract assembly.</summary>
    public Assembly LoadUpdated() => updated.Load();

    /// <summary>Loads the same-named lookalike-marker contract assembly.</summary>
    public Assembly LoadLookalike() => lookalike.Load();

    /// <summary>Loads the metadata-distinct but effectively equivalent contracts.</summary>
    public Assembly LoadEquivalent() => EmittedFixture.Load(File.ReadAllBytes(equivalentPath), updated.DirectoryPath);

    public void Dispose()
    {
        lookalike.Dispose();
        legacy.Dispose();
        updated.Dispose();
    }

    private static bool HasVersion11Marker(CSharpFixture fixture)
        => fixture.Load().ManifestModule.GetCustomAttributesData().Any(attribute =>
            attribute.AttributeType.FullName == "System.Runtime.CompilerServices.RefSafetyRulesAttribute"
            && attribute.ConstructorArguments.Count == 1
            && attribute.ConstructorArguments[0].Value is 11);

    private static void RenameLookalikeRefSafetyRulesAttribute(string path)
    {
        var source = Encoding.UTF8.GetBytes("RefSafetxRulesAttribute");
        var target = Encoding.UTF8.GetBytes("RefSafetyRulesAttribute");
        var bytes = File.ReadAllBytes(path);
        var offset = bytes.AsSpan().IndexOf(source);
        if (offset < 0 || bytes.AsSpan(offset + source.Length).IndexOf(source) >= 0)
        {
            throw new InvalidOperationException("Expected exactly one lookalike attribute name in metadata.");
        }

        target.CopyTo(bytes, offset);
        File.WriteAllBytes(path, bytes);
    }

    private static void BuildEquivalentContracts(string path)
    {
        var assembly = new PersistedAssemblyBuilder(
            new AssemblyName("Issue4563EquivalentContracts"),
            typeof(object).Assembly);
        var module = assembly.DefineDynamicModule("Issue4563EquivalentContracts");
        var markerType = typeof(object).Assembly.GetType(
            "System.Runtime.CompilerServices.RefSafetyRulesAttribute",
            throwOnError: true);
        var markerConstructor = markerType.GetConstructor(
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
            binder: null,
            new[] { typeof(int) },
            modifiers: null)
            ?? throw new InvalidOperationException("Runtime RefSafetyRulesAttribute constructor was not found.");
        module.SetCustomAttribute(new CustomAttributeBuilder(markerConstructor, new object[] { 11 }));

        DefineOutContract(module, "Issue4563.Equivalent.IPlainContract", isInterface: true, scoped: false);
        DefineOutContract(module, "Issue4563.Equivalent.IScopedContract", isInterface: true, scoped: true);
        DefineOutContract(module, "Issue4563.Equivalent.PlainSource", isInterface: false, scoped: false);
        DefineOutContract(module, "Issue4563.Equivalent.ScopedSource", isInterface: false, scoped: true);
        assembly.Save(path);
    }

    private static void DefineOutContract(
        ModuleBuilder module,
        string name,
        bool isInterface,
        bool scoped)
    {
        var type = module.DefineType(
            name,
            TypeAttributes.Public
                | TypeAttributes.Abstract
                | (isInterface ? TypeAttributes.Interface : TypeAttributes.Class));
        var method = type.DefineMethod(
            "Pick",
            MethodAttributes.Public
                | MethodAttributes.Abstract
                | MethodAttributes.Virtual
                | MethodAttributes.HideBySig
                | MethodAttributes.NewSlot,
            typeof(int).MakeByRefType(),
            new[] { typeof(int).MakeByRefType() });
        var parameter = method.DefineParameter(1, ParameterAttributes.Out, "value");
        if (scoped)
        {
            var constructor = typeof(System.Runtime.CompilerServices.ScopedRefAttribute)
                .GetConstructor(Type.EmptyTypes)
                ?? throw new InvalidOperationException("Runtime ScopedRefAttribute constructor was not found.");
            parameter.SetCustomAttribute(new CustomAttributeBuilder(constructor, Array.Empty<object>()));
        }

        type.CreateType();
    }

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

    private const string LookalikeSource = """
        [module: System.Runtime.CompilerServices.RefSafetxRules(11)]

        namespace System.Runtime.CompilerServices
        {
            [System.AttributeUsage(System.AttributeTargets.Module)]
            public sealed class RefSafetxRulesAttribute : System.Attribute
            {
                public RefSafetxRulesAttribute(int version) { }
            }
        }

        namespace Issue4563.Lookalike
        {
            public abstract class Contract
            {
                public abstract ref int Pick(out int value);
            }
        }
        """;
}
