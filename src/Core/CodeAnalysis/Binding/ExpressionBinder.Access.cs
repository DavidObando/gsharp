// <copyright file="ExpressionBinder.Access.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access
#pragma warning disable SA1516 // Elements should be separated by blank line

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Text;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class ExpressionBinder
{


    /// <summary>
    /// Issue #1069: a user-defined aggregate type (class/struct, enum, or
    /// interface) declared in the current compilation, as opposed to an imported
    /// CLR type or a predefined primitive alias.
    /// </summary>
    private static bool IsUserAggregateType(TypeSymbol type) =>
        type is StructSymbol or EnumSymbol or InterfaceSymbol;

    /// <summary>
    /// Issue #1069: whether <paramref name="name"/> resolves to a user-defined
    /// type whose enclosing type is <paramref name="container"/>.
    /// </summary>
    private bool IsNestedTypeOf(string name, TypeSymbol container) =>
        scope.TryLookupTypeAlias(name, out var candidate)
        && IsUserAggregateType(candidate)
        && ReferenceEquals(GetSymbolContainingType(candidate), container);
}
