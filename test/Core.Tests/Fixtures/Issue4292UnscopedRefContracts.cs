// <copyright file="Issue4292UnscopedRefContracts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text;
using Microsoft.CodeAnalysis;

namespace GSharp.Core.Tests.Fixtures;

/// <summary>Builds issue #4292's imported C# contracts outside the ambient test assembly.</summary>
internal sealed class Issue4292UnscopedRefContracts : IDisposable
{
    private readonly CSharpFixture fixture = new(Source);

    /// <summary>Gets the compiled contract assembly path.</summary>
    public string Path => fixture.AssemblyPath;

    public void Dispose() => fixture.Dispose();

    private const string Source = """
        using System.Diagnostics.CodeAnalysis;

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
        }
        """;
}

/// <summary>Builds real and cross-assembly lookalike scoped-ref metadata.</summary>
internal sealed class Issue4292ScopedRefIdentityContracts : IDisposable
{
    private readonly CSharpFixture lookalike;
    private readonly CSharpFixture contracts;

    public Issue4292ScopedRefIdentityContracts(Action<string, string> beforeRewrite = null)
    {
        CSharpFixture createdLookalike = null;
        CSharpFixture createdContracts = null;
        try
        {
            createdLookalike = new CSharpFixture("""
                namespace System.Runtime.CompilerServices;

                [System.AttributeUsage(System.AttributeTargets.Parameter)]
                public sealed class ScopfdRefAttribute : System.Attribute
                {
                }
                """);
            var reference = MetadataReference.CreateFromFile(
                createdLookalike.AssemblyPath,
                new MetadataReferenceProperties(aliases: ImmutableArray.Create("lookalike")));
            createdContracts = new CSharpFixture("""
                extern alias lookalike;

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
                }
                """, new[] { reference });

            beforeRewrite?.Invoke(createdLookalike.DirectoryPath, createdContracts.DirectoryPath);

            // C# rejects spelling ScopedRefAttribute directly (CS9065), so compile
            // a same-length lookalike and patch only its metadata name afterward.
            RenameScopedRefLookalike(createdLookalike.AssemblyPath);
            RenameScopedRefLookalike(createdContracts.AssemblyPath);

            lookalike = createdLookalike;
            contracts = createdContracts;
        }
        catch
        {
            createdContracts?.Dispose();
            createdLookalike?.Dispose();
            throw;
        }
    }

    public string[] Paths => new[] { lookalike.AssemblyPath, contracts.AssemblyPath };

    public void Dispose()
    {
        contracts.Dispose();
        lookalike.Dispose();
    }

    private static void RenameScopedRefLookalike(string path)
    {
        const string sourceName = "ScopfdRefAttribute";
        const string targetName = "ScopedRefAttribute";
        AssertMetadataTypeNameCount(path, sourceName, expected: 1);
        var targetCountBefore = CountMetadataTypeNames(path, targetName);

        // The metadata assertion identifies the string as a type name; requiring
        // one raw occurrence makes that metadata entry the only possible target.
        var bytes = File.ReadAllBytes(path);
        var source = Encoding.ASCII.GetBytes(sourceName);
        var target = Encoding.ASCII.GetBytes(targetName);
        var replacementOffset = -1;
        for (var i = 0; i <= bytes.Length - source.Length; i++)
        {
            if (bytes.AsSpan(i, source.Length).SequenceEqual(source))
            {
                if (replacementOffset >= 0)
                {
                    throw new InvalidOperationException("ScopedRef lookalike metadata name occurs more than once.");
                }

                replacementOffset = i;
            }
        }

        if (replacementOffset < 0)
        {
            throw new InvalidOperationException("ScopedRef lookalike metadata name was not found.");
        }

        target.CopyTo(bytes, replacementOffset);
        File.WriteAllBytes(path, bytes);
        AssertMetadataTypeNameCount(path, sourceName, expected: 0);
        AssertMetadataTypeNameCount(path, targetName, expected: targetCountBefore + 1);
    }

    private static void AssertMetadataTypeNameCount(string path, string name, int expected)
    {
        var count = CountMetadataTypeNames(path, name);
        if (count != expected)
        {
            throw new InvalidOperationException(
                $"Expected {expected} metadata types named '{name}', found {count}.");
        }
    }

    private static int CountMetadataTypeNames(string path, string name)
    {
        using var stream = File.OpenRead(path);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        return reader.TypeDefinitions.Count(handle =>
                reader.GetString(reader.GetTypeDefinition(handle).Name) == name)
            + reader.TypeReferences.Count(handle =>
                reader.GetString(reader.GetTypeReference(handle).Name) == name);
    }
}
