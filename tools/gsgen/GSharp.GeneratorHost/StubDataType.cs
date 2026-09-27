// <copyright file="StubDataType.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.GeneratorHost;

/// <summary>
/// ADR-0192 amendment (partial data types): a top-level G# <c>data class</c> or
/// <c>data struct</c> the stub rendered. A generated part of it must be a
/// <c>data</c> part too (gsc requires <c>data</c> on every part, GS0479),
/// whatever C# keyword the stub gave it, so the back-translation takes the
/// part's kind from here rather than from the generated C#.
/// </summary>
public sealed class StubDataType
{
    /// <summary>
    /// Initializes a new instance of the <see cref="StubDataType"/> class.
    /// </summary>
    /// <param name="packageName">The type's package, or <see langword="null"/> for none.</param>
    /// <param name="typeName">The type's name.</param>
    /// <param name="typeArity">The type's number of type parameters.</param>
    /// <param name="isClass"><see langword="true"/> for a <c>data class</c>, <see langword="false"/> for a <c>data struct</c>.</param>
    /// <param name="positionalList">The location of the user's positional parameter list, or <see langword="null"/> when no part states one.</param>
    public StubDataType(string packageName, string typeName, int typeArity, bool isClass, TextLocation? positionalList = null)
    {
        PositionalList = positionalList;
        PackageName = packageName;
        TypeName = typeName;
        TypeArity = typeArity;
        IsClass = isClass;
    }

    /// <summary>Gets the type's package, or <see langword="null"/> for none.</summary>
    public string PackageName { get; }

    /// <summary>Gets the type's name.</summary>
    public string TypeName { get; }

    /// <summary>Gets the type's number of type parameters.</summary>
    public int TypeArity { get; }

    /// <summary>Gets a value indicating whether the type is a <c>data class</c> (otherwise a <c>data struct</c>).</summary>
    public bool IsClass { get; }

    /// <summary>
    /// Gets the location of the user's positional parameter list, or
    /// <see langword="null"/> when no user part states one (a generated part
    /// may then supply it).
    /// </summary>
    public TextLocation? PositionalList { get; }
}
