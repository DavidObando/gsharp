// <copyright file="Issue4563RefSafetyRulesContracts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.Fixtures

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Text
import GSharp.Tests
import Microsoft.CodeAnalysis.CSharp
import GSharp.Core.Tests
import System.Runtime.CompilerServices

/// Builds legacy and version-11 ref-safety contracts outside the ambient test assembly.
internal class Issue4563RefSafetyRulesContracts : IDisposable {
    private let legacy CSharpFixture?
    private let updated CSharpFixture?
    private let lookalike CSharpFixture?
    private let equivalentPath string

    init(beforeUpdated((string) -> void)? = nil) {
        var createdLegacy CSharpFixture? = nil
        var createdUpdated CSharpFixture? = nil
        var createdLookalike CSharpFixture? = nil
        try {
            createdLegacy = CSharpFixture(
                LegacySource,
                parseOptions: CSharpParseOptions(LanguageVersion.CSharp11).WithFeatures(
                    []KeyValuePair[string, string]{KeyValuePair[string, string]("noRefSafetyRulesAttribute", "true")}
                )
            )
            beforeUpdated?(createdLegacy.DirectoryPath)
            createdUpdated = CSharpFixture(UpdatedSource, parseOptions: CSharpParseOptions(LanguageVersion.CSharp11))
            equivalentPath = Path.Combine(createdUpdated.DirectoryPath, "EquivalentContracts.dll")
            BuildEquivalentContracts(equivalentPath)
            createdLookalike = CSharpFixture(
                LookalikeSource,
                parseOptions: CSharpParseOptions(LanguageVersion.CSharp11).WithFeatures(
                    []KeyValuePair[string, string]{KeyValuePair[string, string]("noRefSafetyRulesAttribute", "true")}
                )
            )
            RenameLookalikeRefSafetyRulesAttribute(createdLookalike.AssemblyPath)
            legacy = createdLegacy
            updated = createdUpdated
            lookalike = createdLookalike
        } catch {
            createdLookalike?.Dispose()
            createdUpdated?.Dispose()
            createdLegacy?.Dispose()
            rethrow
        }
    }

    /// Gets the legacy assembly path.
    prop LegacyPath string -> legacy!!.AssemblyPath

    /// Gets the updated-rules assembly path.
    prop UpdatedPath string -> updated!!.AssemblyPath

    /// Gets the same-named lookalike-marker assembly path.
    prop LookalikePath string -> lookalike!!.AssemblyPath

    /// Gets the assembly containing metadata-distinct but effectively equivalent contracts.
    prop EquivalentPath string -> equivalentPath

    /// Gets whether the legacy module carries the version-11 marker.
    prop LegacyHasVersion11Marker bool -> HasVersion11Marker(legacy)

    /// Gets whether the updated module carries the version-11 marker.
    prop UpdatedHasVersion11Marker bool -> HasVersion11Marker(updated)

    /// Loads the legacy contract assembly.
    func LoadLegacy() Assembly -> legacy!!.Load()

    /// Loads the updated contract assembly.
    func LoadUpdated() Assembly -> updated!!.Load()

    /// Loads the same-named lookalike-marker contract assembly.
    func LoadLookalike() Assembly -> lookalike!!.Load()

    /// Loads the metadata-distinct but effectively equivalent contracts.
    func LoadEquivalent() Assembly -> EmittedFixture.Load(File.ReadAllBytes(equivalentPath), updated!!.DirectoryPath)

    func Dispose() {
        lookalike!!.Dispose()
        legacy!!.Dispose()
        updated!!.Dispose()
    }

    shared {
        private func HasVersion11Marker(fixture CSharpFixture?) bool -> fixture!!
            .Load()
            .ManifestModule
            .GetCustomAttributesData()
            .Any(
            (attribute CustomAttributeData) -> attribute
                .AttributeType
                .FullName == "System.Runtime.CompilerServices.RefSafetyRulesAttribute" &&
                attribute
                .ConstructorArguments
                .Count == 1 &&
                attribute
                .ConstructorArguments[0]
                .Value is 11
        )

        private func RenameLookalikeRefSafetyRulesAttribute(path string) {
            let source = Encoding.UTF8.GetBytes("RefSafetxRulesAttribute")
            let target = Encoding.UTF8.GetBytes("RefSafetyRulesAttribute")
            let bytes = File.ReadAllBytes(path)
            let offset = bytes.AsSpan().IndexOf(source)
            if offset < 0 || bytes.AsSpan(offset + source.Length).IndexOf(source) >= 0 {
                throw InvalidOperationException("Expected exactly one lookalike attribute name in metadata.")
            }
            target.CopyTo(bytes, offset)
            File.WriteAllBytes(path, bytes)
        }

        private func BuildEquivalentContracts(path string) {
            let assembly = PersistedAssemblyBuilder(
                AssemblyName("Issue4563EquivalentContracts"),
                typeof(object).Assembly
            )
            let module = assembly.DefineDynamicModule("Issue4563EquivalentContracts")
            let markerType Type? = typeof(object).Assembly.GetType(
                "System.Runtime.CompilerServices.RefSafetyRulesAttribute",
                throwOnError: true
            )
            let markerConstructor = markerType!!.GetConstructor(
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
                binder: nil,
                []Type{typeof(int32)},
                modifiers: nil
            ) ??
                throw InvalidOperationException("Runtime RefSafetyRulesAttribute constructor was not found.")
            module.SetCustomAttribute(CustomAttributeBuilder(markerConstructor, []object{11}))
            DefineOutContract(module, "Issue4563.Equivalent.IPlainContract", isInterface: true, $scoped: false)
            DefineOutContract(module, "Issue4563.Equivalent.IScopedContract", isInterface: true, $scoped: true)
            DefineOutContract(module, "Issue4563.Equivalent.PlainSource", isInterface: false, $scoped: false)
            DefineOutContract(module, "Issue4563.Equivalent.ScopedSource", isInterface: false, $scoped: true)
            assembly.Save(path)
        }

        private func DefineOutContract(module ModuleBuilder, name string, isInterface bool, $scoped bool) {
            let type = module.DefineType(
                name,
                TypeAttributes.Public | TypeAttributes.Abstract | (
                    if isInterface {
                        TypeAttributes.Interface
                    } else {
                        TypeAttributes.Class
                    }
                )
            )
            let method = type.DefineMethod(
                "Pick",
                MethodAttributes.Public | MethodAttributes.Abstract | MethodAttributes.Virtual | MethodAttributes.HideBySig | MethodAttributes.NewSlot,
                typeof(int32).MakeByRefType(),
                []Type{typeof(int32).MakeByRefType()}
            )
            let parameter = method.DefineParameter(1, ParameterAttributes.Out, "value")
            if $scoped {
                let constructor = typeof(ScopedRefAttribute).GetConstructor(Type.EmptyTypes) ??
                    throw InvalidOperationException("Runtime ScopedRefAttribute constructor was not found.")
                parameter.SetCustomAttribute(CustomAttributeBuilder(constructor, Array.Empty[object]()))
            }
            type.CreateType()
        }

        private const LegacySource string = `using System.Diagnostics.CodeAnalysis;

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
}`

        private const UpdatedSource string = `using System.Diagnostics.CodeAnalysis;

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
`

        private const LookalikeSource string = `[module: System.Runtime.CompilerServices.RefSafetxRules(11)]

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
}`
    }
}
