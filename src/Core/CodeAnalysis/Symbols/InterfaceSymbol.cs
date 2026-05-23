// <copyright file="InterfaceSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a user-defined interface type (Phase 3.B.4 / ADR-0018).
/// Interfaces are CLR reference types (TypeAttributes.Interface | Abstract)
/// containing method signatures only — no bodies, no default impls,
/// no static members.
/// </summary>
public sealed class InterfaceSymbol : TypeSymbol
{
    /// <summary>Initializes a new instance of the <see cref="InterfaceSymbol"/> class.</summary>
    /// <param name="name">The interface type name.</param>
    /// <param name="accessibility">The interface's CLR accessibility.</param>
    /// <param name="declaration">The declaring syntax node.</param>
    /// <param name="packageName">The package this interface lives in.</param>
    public InterfaceSymbol(
        string name,
        Accessibility accessibility,
        InterfaceDeclarationSyntax declaration,
        string packageName)
        : base(name)
    {
        Accessibility = accessibility;
        Declaration = declaration;
        PackageName = packageName;
        Methods = ImmutableArray<FunctionSymbol>.Empty;
    }

    /// <summary>Gets the interface accessibility.</summary>
    public Accessibility Accessibility { get; }

    /// <summary>Gets the declaring syntax node.</summary>
    public InterfaceDeclarationSyntax Declaration { get; }

    /// <summary>Gets the package this interface lives in.</summary>
    public string PackageName { get; }

    /// <summary>Gets a value indicating whether this interface was declared <c>sealed</c> (Phase 3.B.5). All implementors must live in the same package; binder-enforced.</summary>
    public bool IsSealed => Declaration?.IsSealed ?? false;

    /// <summary>Gets the abstract method signatures declared on this interface. Populated by the binder via <see cref="SetMethods"/>.</summary>
    public ImmutableArray<FunctionSymbol> Methods { get; private set; }

    /// <summary>Sets <see cref="Methods"/>. Intended to be called once by the binder.</summary>
    /// <param name="methods">The bound method signatures.</param>
    public void SetMethods(ImmutableArray<FunctionSymbol> methods)
    {
        Methods = methods;
    }

    /// <summary>Tries to look up an interface method by name.</summary>
    /// <param name="name">The method name.</param>
    /// <param name="method">The found method on success.</param>
    /// <returns>True if found.</returns>
    public bool TryGetMethod(string name, out FunctionSymbol method)
    {
        foreach (var m in Methods)
        {
            if (m.Name == name)
            {
                method = m;
                return true;
            }
        }

        method = null;
        return false;
    }
}
