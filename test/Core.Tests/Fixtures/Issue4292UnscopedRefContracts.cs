// <copyright file="Issue4292UnscopedRefContracts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

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

        public interface IBaseGenericMethod<T>
        {
            ref int Slot(ref int fallback, T value);
        }

        public interface IDerivedGenericMethod<T> : IBaseGenericMethod<T>
        {
        }

        public class Base
        {
            private static int value;

            public virtual ref int Slot(ref int fallback) => ref value;
        }
        """;
}
