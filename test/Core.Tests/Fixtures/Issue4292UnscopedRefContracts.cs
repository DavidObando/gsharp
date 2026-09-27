// <copyright file="Issue4292UnscopedRefContracts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
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

        public interface IBaseGenericDefaultProperty<T>
        {
            RefValue Slot { set { } }
        }

        public interface IDerivedGenericDefaultProperty<T> : IBaseGenericDefaultProperty<T>
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
    private readonly CSharpFixture lookalike = new("""
        namespace System.Runtime.CompilerServices;

        [System.AttributeUsage(System.AttributeTargets.Parameter)]
        public sealed class ScopfdRefAttribute : System.Attribute
        {
        }
        """);

    private readonly CSharpFixture contracts;

    public Issue4292ScopedRefIdentityContracts()
    {
        var reference = MetadataReference.CreateFromFile(
            lookalike.AssemblyPath,
            new MetadataReferenceProperties(aliases: ImmutableArray.Create("lookalike")));
        contracts = new CSharpFixture("""
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

        // C# rejects spelling ScopedRefAttribute directly (CS9065), so compile
        // a same-length lookalike and patch only its metadata name afterward.
        RenameScopedRefLookalike(lookalike.AssemblyPath);
        RenameScopedRefLookalike(contracts.AssemblyPath);
    }

    public string[] Paths => new[] { lookalike.AssemblyPath, contracts.AssemblyPath };

    public void Dispose()
    {
        contracts.Dispose();
        lookalike.Dispose();
    }

    private static void RenameScopedRefLookalike(string path)
    {
        var bytes = File.ReadAllBytes(path);
        var source = Encoding.ASCII.GetBytes("ScopfdRefAttribute");
        var target = Encoding.ASCII.GetBytes("ScopedRefAttribute");
        var replacements = 0;
        for (var i = 0; i <= bytes.Length - source.Length; i++)
        {
            if (bytes.AsSpan(i, source.Length).SequenceEqual(source))
            {
                target.CopyTo(bytes, i);
                replacements++;
            }
        }

        if (replacements == 0)
        {
            throw new InvalidOperationException("ScopedRef lookalike metadata name was not found.");
        }

        File.WriteAllBytes(path, bytes);
    }
}
