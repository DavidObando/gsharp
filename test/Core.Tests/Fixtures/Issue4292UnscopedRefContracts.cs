// <copyright file="Issue4292UnscopedRefContracts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics.CodeAnalysis;

namespace GSharp.Core.Tests.Fixtures;

/// <summary>A byref-like fixture type used in imported contract signatures.</summary>
public ref struct Issue4292RefValue
{
}

/// <summary>An imported interface without an unscoped receiver contract.</summary>
public interface Issue4292ImportedInterface
{
    /// <summary>Returns a managed reference.</summary>
    ref int Slot(ref int fallback);
}

/// <summary>An imported interface with an unscoped receiver contract.</summary>
public interface Issue4292ImportedAnnotatedInterface
{
    /// <summary>Returns a managed reference.</summary>
    [UnscopedRef]
    ref int Slot(ref int fallback);
}

/// <summary>An imported generic interface used through symbolic type substitution.</summary>
/// <typeparam name="T">The symbolic argument.</typeparam>
public interface Issue4292ImportedGenericInterface<T>
{
    /// <summary>Returns a managed reference.</summary>
    ref int Slot(ref int fallback, T value);
}

/// <summary>An imported ref-returning property whose contract is irrelevant without another parameter.</summary>
public interface Issue4292ImportedRefProperty
{
    /// <summary>Gets a managed reference.</summary>
    ref int Slot { get; }
}

/// <summary>An imported indexer whose getter carries the contract.</summary>
public interface Issue4292ImportedGetterIndexer
{
    /// <summary>Gets a managed reference.</summary>
    ref int this[Issue4292RefValue view]
    {
        [UnscopedRef]
        get;
    }
}

/// <summary>An imported indexer without the contract.</summary>
public interface Issue4292ImportedUnannotatedIndexer
{
    /// <summary>Gets a managed reference.</summary>
    ref int this[Issue4292RefValue view] { get; }
}

/// <summary>An imported setter-only property whose setter carries the contract.</summary>
public interface Issue4292ImportedSetterProperty
{
    /// <summary>Sets a byref-like value.</summary>
    Issue4292RefValue Slot
    {
        [UnscopedRef]
        set;
    }
}

/// <summary>An imported setter-only property whose property row carries the contract.</summary>
public interface Issue4292ImportedPropertyAnnotatedSetter
{
    /// <summary>Sets a byref-like value.</summary>
    [UnscopedRef]
    Issue4292RefValue Slot { set; }
}

/// <summary>An imported base used to verify placement-diagnostic suppression.</summary>
public class Issue4292ImportedBase
{
    private static int value;

    /// <summary>Returns a managed reference.</summary>
    public virtual ref int Slot(ref int fallback) => ref value;
}
