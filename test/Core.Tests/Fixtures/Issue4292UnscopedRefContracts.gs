// <copyright file="Issue4292UnscopedRefContracts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.Fixtures

import GSharp.Core.Tests
import Microsoft.CodeAnalysis
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Text

/// Builds issue #4292's imported C# contracts outside the ambient test assembly.
internal class Issue4292UnscopedRefContracts : IDisposable {
    private let fixture CSharpFixture = CSharpFixture(Source)

    /// Gets the compiled contract assembly path.
    prop Path string -> fixture.AssemblyPath

    func Dispose() -> fixture.Dispose()

    shared {
        private const Source string = `using System.Diagnostics.CodeAnalysis;

namespace Issue4292.Contracts;

public ref struct RefValue
{
}

public interface IMethod
{
    ref int Slot(ref int fallback);
}

public interface IAnnotatedMethod
{
    [UnscopedRef]
    ref int Slot(ref int fallback);
}

public interface IValueMethod
{
    int Get();
}

public interface IValueProperty
{
    int Value { get; set; }
}

public interface IBaseValueProperty
{
    int Value { get; }
}

public interface IDerivedValueProperty : IBaseValueProperty
{
}

public interface IGenericMethod<T>
{
    ref int Slot(ref int fallback, T value);
}

public interface IRefProperty
{
    ref int Slot { get; }
}

public interface IGetterIndexer
{
    ref int this[RefValue view]
    {
        [UnscopedRef]
        get;
    }
}

public interface IUnannotatedIndexer
{
    ref int this[RefValue view] { get; }
}

public interface IGenericProperty<T>
{
    RefValue Slot { set; }
}

public interface IGenericValueProperty<T>
{
    T Value { get; }
}

public interface IGenericCollectionProperty<T>
{
    System.Collections.Generic.ICollection<T> Values { get; }
}

public interface IGenericOverloadedIndexer<T>
{
    RefValue this[T key] { set; }

    [UnscopedRef]
    RefValue this[int key] { set; }
}

public interface IRefKindIndexer
{
    RefValue this[int key] { set; }

    [UnscopedRef]
    RefValue this[in int key] { set; }
}

public interface IDefaultMethod
{
    ref int Slot(ref int fallback) => ref fallback;
}

public interface IDefaultProperty
{
    RefValue Slot { set { } }
}

public interface IGenericDefaultMethod<T>
{
    ref int Slot(ref int fallback, T value) => ref fallback;
}

public interface IGenericDefaultProperty<T>
{
    RefValue Slot { set { } }
}

public interface ISetterProperty
{
    RefValue Slot
    {
        [UnscopedRef]
        set;
    }
}

public interface IPropertyAnnotatedSetter
{
    [UnscopedRef]
    RefValue Slot { set; }
}

public interface IBaseSlot<T>
{
    void Put(T value);
}

public interface IChild<T> : IBaseSlot<T>
{
}

public interface IProjectedBase<T, U>
{
    void Put(T first, U second);

    RefValue this[T first, U second] { set; }
}

public interface IProjectedChild<T, U> : IProjectedBase<U, T>
{
}

public interface ILeft<T> : IBaseSlot<T>
{
}

public interface IRight<T> : IBaseSlot<T>
{
}

public interface IBaseMethod
{
    ref int Slot(ref int fallback);
}

public interface IDerivedMethod : IBaseMethod
{
}

public interface IBaseDefaultMethod
{
    ref int Slot(ref int fallback) => ref fallback;
}

public interface IDerivedDefaultMethod : IBaseDefaultMethod
{
}

public interface IBaseDefaultProperty
{
    RefValue Slot { set { } }
}

public interface IDerivedDefaultProperty : IBaseDefaultProperty
{
}

public interface IBaseGenericMethod<T>
{
    ref int Slot(ref int fallback, T value);
}

public interface IDerivedGenericMethod<T> : IBaseGenericMethod<T>
{
}

public interface IBaseInvariantMethod<T>
{
    [UnscopedRef]
    ref int Slot(ref int fallback);
}

public interface IDerivedInvariantMethod<T> : IBaseInvariantMethod<T>
{
}

public interface IBaseGenericDefaultProperty<T>
{
    RefValue Slot { set { } }
}

public interface IDerivedGenericDefaultProperty<T> : IBaseGenericDefaultProperty<T>
{
}

public interface IBaseInvariantProperty<T>
{
    [UnscopedRef]
    RefValue Slot { set; }
}

public interface IDerivedInvariantProperty<T> : IBaseInvariantProperty<T>
{
}

public class Base
{
    private static int value;

    public virtual ref int Slot(ref int fallback) => ref value;
}`
    }
}

/// Builds real and cross-assembly lookalike scoped-ref metadata.
internal class Issue4292ScopedRefIdentityContracts : IDisposable {
    private let lookalike CSharpFixture?
    private let contracts CSharpFixture?

    init(beforeRewrite((string, string) -> void)? = nil) {
        var createdLookalike CSharpFixture? = nil
        var createdContracts CSharpFixture? = nil
        try {
            createdLookalike = CSharpFixture(`namespace System.Runtime.CompilerServices;

[System.AttributeUsage(System.AttributeTargets.Parameter)]
public sealed class ScopfdRefAttribute : System.Attribute
{
}`)
            let reference = MetadataReference.CreateFromFile(
                createdLookalike.AssemblyPath,
                MetadataReferenceProperties(aliases: ImmutableArray.Create("lookalike"))
            )
            createdContracts = CSharpFixture(`extern alias lookalike;

namespace Issue4292.ScopedIdentity;

public ref struct RefValue
{
}

public interface ILookalikeScoped
{
    void Store(
        [lookalike::System.Runtime.CompilerServices.ScopfdRef]
        ref RefValue view);
}

public interface IRuntimeScoped
{
    void Store(scoped ref RefValue view);
}`, []PortableExecutableReference{reference})
            beforeRewrite?(createdLookalike.DirectoryPath, createdContracts.DirectoryPath)
            // C# rejects spelling ScopedRefAttribute directly (CS9065), so compile
            // a same-length lookalike and patch only its metadata name afterward.
            RenameScopedRefLookalike(createdLookalike.AssemblyPath)
            RenameScopedRefLookalike(createdContracts.AssemblyPath)
            lookalike = createdLookalike
            contracts = createdContracts
        } catch {
            createdContracts?.Dispose()
            createdLookalike?.Dispose()
            rethrow
        }
    }

    prop Paths[]string -> []string{lookalike!!.AssemblyPath, contracts!!.AssemblyPath}

    func Dispose() {
        contracts!!.Dispose()
        lookalike!!.Dispose()
    }

    shared {
        private func RenameScopedRefLookalike(path string) {
            const sourceName = "ScopfdRefAttribute"
            const targetName = "ScopedRefAttribute"
            AssertMetadataTypeNameCount(path, sourceName, expected: 1)
            let targetCountBefore = CountMetadataTypeNames(path, targetName)
            // The metadata assertion identifies the string as a type name; requiring
            // one raw occurrence makes that metadata entry the only possible target.
            let bytes = File.ReadAllBytes(path)
            let source = Encoding.ASCII.GetBytes(sourceName)
            let target = Encoding.ASCII.GetBytes(targetName)
            var replacementOffset = -1
            for var i = 0; i <= bytes.Length - source.Length; i++ {
                if bytes.AsSpan(i, source.Length).SequenceEqual(source) {
                    if replacementOffset >= 0 {
                        throw InvalidOperationException("ScopedRef lookalike metadata name occurs more than once.")
                    }
                    replacementOffset = i
                }
            }
            if replacementOffset < 0 {
                throw InvalidOperationException("ScopedRef lookalike metadata name was not found.")
            }
            target.CopyTo(bytes, replacementOffset)
            File.WriteAllBytes(path, bytes)
            AssertMetadataTypeNameCount(path, sourceName, expected: 0)
            AssertMetadataTypeNameCount(path, targetName, expected: targetCountBefore + 1)
        }

        private func AssertMetadataTypeNameCount(path string, name string, expected int32) {
            let count = CountMetadataTypeNames(path, name)
            if count != expected {
                throw InvalidOperationException("Expected $expected metadata types named '$name', found $count.")
            }
        }

        private func CountMetadataTypeNames(path string, name string) int32 {
            using let stream = File.OpenRead(path)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            return reader.TypeDefinitions.Count(
                (handle TypeDefinitionHandle) -> reader.GetString(reader.GetTypeDefinition(handle).Name) == name
            ) +
                reader
                .TypeReferences
                .Count((handle TypeReferenceHandle) -> reader.GetString(reader.GetTypeReference(handle).Name) == name)
        }
    }
}
