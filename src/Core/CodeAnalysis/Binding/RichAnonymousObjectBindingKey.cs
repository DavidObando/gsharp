// <copyright file="RichAnonymousObjectBindingKey.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

internal readonly record struct RichAnonymousObjectBindingKey(
    StructSymbol Type,
    FunctionSymbol? Function);
